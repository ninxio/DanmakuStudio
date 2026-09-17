//! Local frame-to-frame pHash alignment. Sparse retrieval never projects through a gap.
//! Resampled presentation times carry an explicit sampling uncertainty; they are not original frame PTS.
use super::*;
use std::collections::{HashMap, HashSet, VecDeque};

const ENGINE: &str = "visual-aap-v1";
const FEATURES: &str = "phash-dct32-low8-no-dc-gray-v1";
const STEP: u64 = 250;
const MAX_FRAMES: usize = 86_400;
const MAX_BUCKET: usize = 4096;
const MAX_CANDIDATES: usize = 4096;
const MAX_DISTANCE: u32 = 10;
const MIN_RUN: usize = 8;

#[derive(Debug, Clone)]
struct Frame {
    time: u64,
    hash: u64,
    informative: bool,
}
#[derive(Debug, Clone, Copy)]
struct Anchor {
    source: u64,
    target: u64,
}
type FrameCache = VecDeque<(String, Arc<Vec<Frame>>)>;
static CACHE: OnceLock<Mutex<FrameCache>> = OnceLock::new();

pub(super) fn clear_cache() -> Result<(), String> {
    if let Some(cache) = CACHE.get() {
        cache.lock().map_err(|_| "AAP 缓存锁失效。")?.clear();
    }
    Ok(())
}

pub(super) fn align<F: FnMut(f64, &str) -> Result<(), String>>(
    request: &AudioAlignmentRequest,
    options: &AudioAlignmentOptions,
    update: &mut F,
    cancel: Option<&AtomicBool>,
) -> Result<AudioAlignmentProposal, String> {
    update(0.08, "AAP：校验参考和原片的视频流，无需音轨。")?;
    let source = probe_alignment_visual_input(
        &request.source_path,
        "参考视频",
        request.source_video_stream_index,
        options,
        cancel,
    )?;
    let target = probe_alignment_visual_input(
        &request.complete_path,
        "目标原片",
        request.complete_video_stream_index,
        options,
        cancel,
    )?;
    update(0.12, "AAP：提取原片画面指纹。")?;
    let target_frames = extract(&request.complete_path, &target, options, cancel)?;
    update(0.39, "AAP：提取参考视频画面指纹。")?;
    let source_frames = extract(&request.source_path, &source, options, cancel)?;
    update(0.78, "AAP：检索相似画面，排除重复位置。")?;
    let (anchors, ambiguous) = match_frames(&source_frames, &target_frames, cancel)?;
    update(0.88, "AAP：构建分段时间映射，保留无证据区间。")?;
    let runs = split_runs(&anchors);
    let source_bounds = bounds(&source, &source_frames);
    let target_bounds = bounds(&target, &target_frames);
    let spans = build_spans(&runs, source_bounds, target_bounds);
    let matched_duration: u64 = spans
        .iter()
        .filter(|s| s.kind == AudioTimeMapSpanKind::Matched)
        .map(|s| s.source_end_ms - s.source_start_ms)
        .sum();
    let coverage = matched_duration as f64 / (source_bounds.1 - source_bounds.0).max(1) as f64;
    let retained: Vec<Anchor> = runs.iter().flatten().copied().collect();
    let reasons = vec![
        "AAP 根据连续画面生成分段候选；未匹配、重复镜头和边界区域需要确认。".into(),
        "250 ms 采样网格；边界不确定度至少 500 ms。未做概率校准，不自动签发成品验证。".into(),
    ];
    let diagnostics = vec![format!(
        "AAP：参考 {} 帧，原片 {} 帧，保留 {} 个视觉锚点、{} 个共同内容段，{} 帧存在竞争位置。",
        source_frames.len(),
        target_frames.len(),
        retained.len(),
        runs.len(),
        ambiguous
    )];
    let quality_level = if runs.is_empty() { "blocked" } else { "review" };
    let source_stream = v2_video_stream_identity(&source.stream);
    let target_stream = v2_video_stream_identity(&target.stream);
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms: source_bounds.0,
        source_end_ms: source_bounds.1,
        target_start_ms: target_bounds.0,
        target_end_ms: target_bounds.1,
        spans,
        quality: AudioTimeMapQualityDto {
            level: quality_level,
            metric_source: "measured",
            probability: None,
            coverage: Some(coverage),
            unique_content_coverage: Some(coverage),
            p50_residual_ms: None,
            p95_residual_ms: None,
            p99_residual_ms: None,
            max_residual_ms: None,
            boundary_uncertainty_ms: Some(STEP * 2),
            alternative_margin: None,
            anchor_count: retained.len(),
            anchor_region_count: runs.len().min(3),
            held_out_anchor_count: 0,
            reasons: reasons.clone(),
        },
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["visual"],
            audio_anchor_count: 0,
            visual_anchor_count: retained.len(),
            held_out_anchor_count: 0,
            top1_top2_margin: None,
            unique_content_coverage: Some(coverage),
            repeated_content_only: retained.is_empty() && ambiguous > 0,
            selected_track_reason: "显式 AAP 视频流；不依赖音频或云端模型。".into(),
            alternative_track_scores: vec![],
            notes: diagnostics.clone(),
        },
        source_stream: Some(source_stream.clone()),
        target_stream: Some(target_stream.clone()),
        source_visual_stream: Some(source_stream),
        target_visual_stream: Some(target_stream),
        source_identity: source.content_identity,
        target_identity: target.content_identity,
        engine_version: ENGINE,
        feature_version: FEATURES,
        parameters_hash: "aap-v1-step250-distance10-margin2-run8-scale080-125".into(),
    };
    let proposal = AudioAlignmentProposal {
        anchors: retained
            .iter()
            .step_by(retained.len().div_ceil(200).max(1))
            .enumerate()
            .map(|(i, a)| SyncAnchorDto {
                id: format!("aap-anchor-{i}"),
                source_ms: a.source,
                target_ms: a.target,
                confidence: 0.7,
                origin: "automatic",
            })
            .collect(),
        cut_candidates: vec![],
        evidence_profile: None,
        confidence: coverage * 0.7,
        diagnostics,
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: ENGINE.into(),
            complete_fingerprint_count: target_frames.len(),
            source_fingerprint_count: source_frames.len(),
            fingerprint_match_count: anchors.len(),
            monotonic_match_count: retained.len(),
            strong_anchor_count: 0,
            weak_anchor_count: retained.len(),
            offset_cluster_count: runs.len(),
            refined_candidate_count: 0,
            low_confidence_region_count: time_map
                .spans
                .iter()
                .filter(|s| s.kind != AudioTimeMapSpanKind::Matched)
                .count(),
            quality: if runs.is_empty() { "blocked" } else { "medium" }.into(),
            time_mapping_segment_count: Some(runs.len()),
            confirmed_change_count: Some(0),
            signals: Some(vec![AlignmentEvidenceSignalSummary {
                kind: "visual",
                status: if runs.is_empty() { "blocked" } else { "used" },
                label: "AAP pHash 分段画面匹配",
                observations: retained.len(),
                weight: 1.0,
                note: "本地视觉候选；不宣称自动验证或毫秒级切点。".into(),
            }]),
        }),
        match_range: Some(AlignmentMatchRange {
            source_start_ms: source_bounds.0,
            source_end_ms: source_bounds.1,
            target_start_ms: target_bounds.0,
            target_end_ms: target_bounds.1,
            coverage,
        }),
        time_map: Some(time_map),
    };
    update(0.99, "AAP：分段候选已生成，可进入逐段检查和弹幕导出。")?;
    Ok(proposal)
}

fn bounds(input: &AlignmentVisualInput, frames: &[Frame]) -> (u64, u64) {
    let start = input.stream.timeline_offset_ms.max(0) as u64;
    let sampled_end = frames.last().map(|f| f.time + STEP).unwrap_or(start + 1);
    let declared_end = input
        .stream
        .duration_ms
        .map(|d| start.saturating_add(d))
        .or(input.media_duration_ms)
        .unwrap_or(sampled_end);
    (start, declared_end.min(sampled_end).max(start + 1))
}

fn extract(
    path: &str,
    input: &AlignmentVisualInput,
    options: &AudioAlignmentOptions,
    cancel: Option<&AtomicBool>,
) -> Result<Arc<Vec<Frame>>, String> {
    let identity = require_full_file_media_content_identity(input.content_identity.as_ref())?;
    let key = serde_json::to_string(&(
        FEATURES,
        STEP,
        identity,
        &input.stream,
        input.presentation_origin_ms,
        audio_alignment_toolchain_cache_identity(options)?,
    ))
    .map_err(|e| e.to_string())?;
    let cache = CACHE.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Some(frames) = cache
        .lock()
        .map_err(|_| "AAP 缓存锁失效。")?
        .iter()
        .find(|(k, _)| k == &key)
        .map(|(_, v)| v.clone())
    {
        check_cancelled(cancel)?;
        return Ok(frames);
    }
    let origin = input.stream.timeline_offset_ms.max(0) as u64;
    let filter = format!(
        "fps=fps=4:start_time={:.6},scale=32:32:flags=area,format=gray",
        origin as f64 / 1000.0
    );
    let stream = format!("0:{}", input.stream.stream_index);
    let output = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        [
            "-nostdin",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-copyts",
            "-start_at_zero",
            "-i",
            path,
            "-map",
            &stream,
            "-vf",
            &filter,
            "-an",
            "-sn",
            "-dn",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ],
        "FFmpeg AAP 画面采样",
        (MAX_FRAMES + 1) * 1024,
        cancel,
    )?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            "FFmpeg AAP 画面采样",
            output.status.code(),
            &output.stderr,
        ));
    }
    verify_media_content_identity_after_tool_output(
        path,
        input.content_identity.as_ref(),
        cancel,
        "AAP 抽帧",
    )?;
    if output.stdout.len() % 1024 != 0 || output.stdout.len() / 1024 > MAX_FRAMES {
        return Err("AAP 抽帧输出损坏或超过 6 小时限制。".into());
    }
    let mut frames = Vec::with_capacity(output.stdout.len() / 1024);
    for (i, pixels) in output.stdout.chunks_exact(1024).enumerate() {
        if i % 64 == 0 {
            check_cancelled(cancel)?;
        }
        let (hash, informative) = phash(pixels);
        frames.push(Frame {
            time: origin + i as u64 * STEP,
            hash,
            informative,
        });
    }
    if frames.is_empty() {
        return Err("视频没有可解码画面。".into());
    }
    let frames = Arc::new(frames);
    let mut guard = cache.lock().map_err(|_| "AAP 缓存锁失效。")?;
    while guard.len() >= 4 {
        guard.pop_front();
    }
    guard.push_back((key, frames.clone()));
    Ok(frames)
}

fn phash(pixels: &[u8]) -> (u64, bool) {
    static COS: OnceLock<[[f64; 32]; 8]> = OnceLock::new();
    let cos = COS.get_or_init(|| {
        std::array::from_fn(|u| {
            std::array::from_fn(|x| {
                ((2 * x + 1) as f64 * u as f64 * std::f64::consts::PI / 64.0).cos()
            })
        })
    });
    let mean = pixels.iter().map(|&p| p as f64).sum::<f64>() / 1024.0;
    let variance = pixels
        .iter()
        .map(|&p| (p as f64 - mean).powi(2))
        .sum::<f64>()
        / 1024.0;
    if variance < 36.0 {
        return (0, false);
    }
    let mut row = [[0.0; 8]; 32];
    for y in 0..32 {
        for u in 0..8 {
            for x in 0..32 {
                row[y][u] += pixels[y * 32 + x] as f64 * cos[u][x];
            }
        }
    }
    let mut coefficients = [0.0; 64];
    for v in 0..8 {
        for u in 0..8 {
            for y in 0..32 {
                coefficients[v * 8 + u] += row[y][u] * cos[v][y];
            }
        }
    }
    let mut low = coefficients[1..].to_vec();
    low.sort_by(f64::total_cmp);
    let median = low[31];
    let hash = coefficients
        .iter()
        .enumerate()
        .skip(1)
        .fold(0, |hash, (i, &c)| hash | (u64::from(c > median) << i));
    (hash, true)
}

fn match_frames(
    source: &[Frame],
    target: &[Frame],
    cancel: Option<&AtomicBool>,
) -> Result<(Vec<Anchor>, usize), String> {
    // Four 16-bit bands with radius-two probes retrieve every hash within Hamming distance 10.
    // Saturated buckets or candidate caps abstain instead of silently choosing a partial search.
    let mut index: HashMap<(u8, u16), Vec<usize>> = HashMap::new();
    for (i, frame) in target.iter().enumerate().filter(|(_, f)| f.informative) {
        if i % 256 == 0 {
            check_cancelled(cancel)?;
        }
        for band in 0..4u8 {
            let bucket = index
                .entry((band, (frame.hash >> (band * 16)) as u16))
                .or_default();
            if bucket.len() <= MAX_BUCKET {
                bucket.push(i);
            }
        }
    }
    let mut observations = Vec::new();
    let mut ambiguous = 0;
    for (ordinal, frame) in source.iter().enumerate() {
        if ordinal % 64 == 0 {
            check_cancelled(cancel)?;
        }
        if !frame.informative {
            continue;
        }
        let mut seen = HashSet::new();
        let mut saturated = false;
        'bands: for band in 0..4u8 {
            let byte = (frame.hash >> (band * 16)) as u16;
            for mask in std::iter::once(0u16)
                .chain((0..16).map(|bit| 1u16 << bit))
                .chain((0..16).flat_map(|a| ((a + 1)..16).map(move |b| (1u16 << a) | (1u16 << b))))
            {
                if let Some(bucket) = index.get(&(band, byte ^ mask)) {
                    if bucket.len() > MAX_BUCKET {
                        saturated = true;
                        break 'bands;
                    }
                    for &i in bucket {
                        seen.insert(i);
                    }
                    if seen.len() > MAX_CANDIDATES {
                        saturated = true;
                        break 'bands;
                    }
                }
            }
        }
        if saturated {
            ambiguous += 1;
            continue;
        }
        let mut candidates: Vec<(u32, usize)> = seen
            .into_iter()
            .filter_map(|i| {
                let distance = (frame.hash ^ target[i].hash).count_ones();
                (distance <= MAX_DISTANCE).then_some((distance, i))
            })
            .collect();
        candidates.sort_unstable();
        let Some(&(distance, best)) = candidates.first() else {
            continue;
        };
        if candidates.iter().any(|&(d, i)| {
            d <= distance + 2 && target[i].time.abs_diff(target[best].time) > 4 * STEP
        }) {
            ambiguous += 1;
            continue;
        }
        observations.push(Anchor {
            source: frame.time,
            target: target[best].time,
        });
    }
    // Longest increasing sequence enforces chronological consistency in O(n log n).
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![None; observations.len()];
    for (i, point) in observations.iter().enumerate() {
        let at = tails.partition_point(|&j| observations[j].target < point.target);
        if at > 0 {
            previous[i] = Some(tails[at - 1]);
        }
        if at == tails.len() {
            tails.push(i);
        } else {
            tails[at] = i;
        }
    }
    let mut path = Vec::new();
    let mut cursor = tails.last().copied();
    while let Some(i) = cursor {
        path.push(observations[i]);
        cursor = previous[i];
    }
    path.reverse();
    Ok((path, ambiguous))
}

fn split_runs(anchors: &[Anchor]) -> Vec<Vec<Anchor>> {
    let mut runs = Vec::new();
    let mut current: Vec<Anchor> = Vec::new();
    for &anchor in anchors {
        let split = current.last().is_some_and(|last| {
            let ds = anchor.source - last.source;
            let dt = anchor.target - last.target;
            ds > STEP * 3
                || dt > STEP * 4
                || ds == 0
                || dt == 0
                || (current.len() >= MIN_RUN && {
                    let first = current[0];
                    let scale =
                        (last.target - first.target) as f64 / (last.source - first.source) as f64;
                    (anchor.target as f64
                        - (first.target as f64 + (anchor.source - first.source) as f64 * scale))
                        .abs()
                        > STEP as f64 * 1.5
                })
        });
        if split {
            keep_run(&mut runs, &mut current);
        }
        current.push(anchor);
    }
    keep_run(&mut runs, &mut current);
    runs
}

fn keep_run(runs: &mut Vec<Vec<Anchor>>, current: &mut Vec<Anchor>) {
    if current.len() >= MIN_RUN {
        let first = current[0];
        let last = current[current.len() - 1];
        let scale =
            (last.target - first.target) as f64 / (last.source - first.source).max(1) as f64;
        let residual = current
            .iter()
            .map(|p| {
                (p.target as f64 - first.target as f64 - (p.source - first.source) as f64 * scale)
                    .abs()
            })
            .fold(0.0, f64::max);
        if (0.8..=1.25).contains(&scale) && residual <= STEP as f64 * 1.5 {
            runs.push(std::mem::take(current));
        }
    }
    current.clear();
}

fn build_spans(
    runs: &[Vec<Anchor>],
    source: (u64, u64),
    target: (u64, u64),
) -> Vec<AudioTimeMapSpanDto> {
    let mut spans = Vec::new();
    let mut cursor = (source.0, target.0);
    for run in runs {
        let first = run[0];
        let last = run[run.len() - 1];
        if last.source >= source.1 || last.target >= target.1 {
            continue;
        }
        add_gap(&mut spans, cursor, (first.source, first.target));
        let mut span = v2_pair_engine::create_v2_span(
            AudioTimeMapSpanKind::Matched,
            first.source,
            last.source,
            first.target,
            last.target,
        );
        span.reason = "连续唯一画面指纹支持本段映射；未跨越长无证据区。".into();
        span.quality.level = "review";
        span.quality.anchor_count = run.len();
        span.quality.coverage = Some(1.0);
        span.quality.unique_content_coverage = Some(1.0);
        span.quality.boundary_uncertainty_ms = Some(STEP * 2);
        span.quality.signals.visual = AudioTimeMapSignalStatus::Used;
        let scale = (last.target - first.target) as f64 / (last.source - first.source) as f64;
        let residual = run
            .iter()
            .map(|a| {
                (a.target as f64 - first.target as f64 - (a.source - first.source) as f64 * scale)
                    .abs()
                    .ceil() as u64
            })
            .max()
            .unwrap_or(0);
        span.quality.max_residual_ms = Some(residual);
        span.quality.reasons = vec![
            span.reason.clone(),
            "画面采样仍有边界误差，需要逐段检查。".into(),
        ];
        span.boundaries.start.reason = "边界位于首个视觉观测，未断言精确切点。".into();
        span.boundaries.end.reason = "边界位于最后视觉观测，未向未观察内容外推。".into();
        spans.push(span);
        cursor = (last.source, last.target);
    }
    add_gap(&mut spans, cursor, (source.1, target.1));
    for (i, span) in spans.iter_mut().enumerate() {
        span.id = format!("aap-span-{i}");
    }
    spans
}

fn add_gap(spans: &mut Vec<AudioTimeMapSpanDto>, from: (u64, u64), to: (u64, u64)) {
    if from == to {
        return;
    }
    let kind = if from.0 == to.0 {
        AudioTimeMapSpanKind::TargetOnly
    } else if from.1 == to.1 {
        AudioTimeMapSpanKind::SourceOnly
    } else {
        AudioTimeMapSpanKind::Ambiguous
    };
    let mut span = v2_pair_engine::create_v2_span(kind, from.0, to.0, from.1, to.1);
    span.reason = "此区间缺少唯一连续视觉证据，弹幕不会按最近匹配帧自动投射。".into();
    span.quality.reasons = vec![span.reason.clone()];
    spans.push(span);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frames(count: usize) -> Vec<Frame> {
        let mut state = 0x123456789abcdefu64;
        (0..count)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                Frame {
                    time: i as u64 * STEP,
                    hash: state,
                    informative: true,
                }
            })
            .collect()
    }
    #[test]
    fn actual_dct_hash_is_brightness_invariant_and_rejects_black() {
        let pixels: Vec<u8> = (0..1024)
            .map(|i| ((i * 79 + i / 32 * 53) % 128 + 32) as u8)
            .collect();
        let shifted: Vec<u8> = pixels.iter().map(|v| v + 20).collect();
        assert_eq!(phash(&pixels), phash(&shifted));
        assert!(!phash(&[0; 1024]).1);
    }
    #[test]
    fn insertion_produces_separate_runs_and_never_bridges_filler() {
        let target = frames(100);
        let mut source = target.clone();
        let filler = (0..20).map(|_| Frame {
            time: 0,
            hash: 0,
            informative: false,
        });
        source.splice(40..40, filler);
        for (i, f) in source.iter_mut().enumerate() {
            f.time = i as u64 * STEP;
        }
        let (path, _) = match_frames(&source, &target, None).unwrap();
        let runs = split_runs(&path);
        assert_eq!(runs.len(), 2);
        let spans = build_spans(&runs, (0, 30000), (0, 25000));
        assert!(spans
            .iter()
            .any(|s| s.kind == AudioTimeMapSpanKind::Ambiguous
                && s.source_start_ms <= 10000
                && s.source_end_ms >= 15000));
        assert!(
            !spans.iter().any(|s| s.kind == AudioTimeMapSpanKind::Matched
                && s.source_start_ms < 10000
                && s.source_end_ms > 15000)
        );
    }
    #[test]
    fn repeated_sequence_abstains_instead_of_choosing_the_first_occurrence() {
        let source = frames(40);
        let mut target = source.clone();
        target.extend(source.iter().cloned().map(|mut f| {
            f.time += 10000;
            f
        }));
        let (path, ambiguous) = match_frames(&source, &target, None).unwrap();
        assert!(path.is_empty());
        assert_eq!(ambiguous, 40);
    }
    #[test]
    fn supports_local_speed_change_and_honors_cancellation() {
        let source = frames(100);
        let mut target = source.clone();
        for f in &mut target {
            f.time = f.time * 11 / 10 + 1000;
        }
        let (path, _) = match_frames(&source, &target, None).unwrap();
        assert_eq!(split_runs(&path).len(), 1);
        assert!(match_frames(&source, &target, Some(&AtomicBool::new(true))).is_err());
    }
}
