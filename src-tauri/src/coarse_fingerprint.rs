use crate::alignment_v2::{
    CoarseSpectralFingerprintFrame, SpectralLandmark, COARSE_SPECTRAL_FINGERPRINT_BANDS,
};
use std::sync::atomic::{AtomicBool, Ordering};

const SPECTRAL_BIN_COUNT: f64 = 48.0;
const MAX_FINGERPRINT_FRAMES: usize = 200_000;
const CANCEL_CHECK_INTERVAL: usize = 2_048;

#[cfg(test)]
pub fn quantize_landmarks_for_approximate_matching(
    landmarks: &[SpectralLandmark],
    frequency_bin_width: u8,
    delta_bin_width: u8,
) -> Result<Vec<SpectralLandmark>, String> {
    if frequency_bin_width == 0
        || frequency_bin_width > 16
        || delta_bin_width == 0
        || delta_bin_width > 32
    {
        return Err("近似 landmark 量化宽度无效。".to_string());
    }
    landmarks
        .iter()
        .map(|landmark| {
            let anchor_bin = ((landmark.hash >> 16) & 0xff) as u8;
            let target_bin = ((landmark.hash >> 8) & 0xff) as u8;
            let delta_bin = (landmark.hash & 0xff) as u8;
            if anchor_bin >= 48 || target_bin >= 48 {
                return Err("近似 landmark 输入包含越界声谱 bin。".to_string());
            }
            Ok(SpectralLandmark {
                hash: (u64::from(anchor_bin / frequency_bin_width) << 16)
                    | (u64::from(target_bin / frequency_bin_width) << 8)
                    | u64::from(delta_bin / delta_bin_width),
                time_ms: landmark.time_ms,
                strength_milli: landmark.strength_milli,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct ApproximateFingerprintConfig {
    pub frame_ms: i64,
    pub block_ms: i64,
    pub block_stride_ms: i64,
    pub max_query_blocks: usize,
    pub min_block_score: f64,
    pub min_block_margin: f64,
    pub inlier_tolerance_ms: i64,
    pub min_training_anchors: usize,
    pub max_hypotheses: usize,
}

impl Default for ApproximateFingerprintConfig {
    fn default() -> Self {
        Self {
            frame_ms: 500,
            block_ms: 20_000,
            // Keep 20 s windows disjoint, with enough independent training and holdout
            // opportunities inside short common runs. Long queries retain the 32-block cap.
            block_stride_ms: 30_000,
            max_query_blocks: 32,
            min_block_score: 0.48,
            // Adjacent source windows form a local score plateau even for a correct episode.
            // Per-window margin only removes exact ties; global offset consensus below is the
            // authoritative uniqueness test.
            min_block_margin: 0.001,
            inlier_tolerance_ms: 120_000,
            min_training_anchors: 5,
            max_hypotheses: 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApproximateAnchor {
    pub source_time_ms: i64,
    pub target_time_ms: i64,
    pub residual_ms: i64,
    pub score: f64,
    pub alternative_margin: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApproximateCoarseHypothesis {
    pub scale: f64,
    pub offset_ms: i64,
    /// Number of stable, monotonic offset islands represented by this hypothesis.
    ///
    /// A value greater than one means the reference contains real common-content runs
    /// separated by source-only/target-only material. `offset_ms` remains the first island's
    /// bootstrap offset; every anchor keeps its own island-local residual for fine alignment.
    pub offset_island_count: usize,
    pub training_anchors: Vec<ApproximateAnchor>,
    pub held_out_anchors: Vec<ApproximateAnchor>,
    pub source_start_ms: i64,
    pub source_end_ms: i64,
    pub target_coverage: f64,
    pub p50_residual_ms: i64,
    pub p95_residual_ms: i64,
    pub max_residual_ms: i64,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApproximateFingerprintMatchResult {
    pub hypotheses: Vec<ApproximateCoarseHypothesis>,
    pub query_block_count: usize,
    pub score_accepted_block_count: usize,
    pub unique_training_block_count: usize,
    pub best_block_score: Option<f64>,
    pub median_block_score: Option<f64>,
    pub best_block_margin: Option<f64>,
    pub median_block_margin: Option<f64>,
    pub unique_training_offsets_ms: Vec<i64>,
    pub block_matches: Vec<ApproximateBlockMatch>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApproximateBlockMatch {
    pub source_time_ms: i64,
    pub target_time_ms: i64,
    pub offset_ms: i64,
    pub score: f64,
    pub alternative_margin: f64,
    pub held_out: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct FingerprintFrame {
    anchor_centroid: f32,
    target_centroid: f32,
    log_activity: f32,
    log_strength: f32,
    active: bool,
}

#[derive(Debug, Clone, Copy)]
struct FingerprintAccumulator {
    anchor_weighted_sum: f64,
    target_weighted_sum: f64,
    weight_sum: f64,
    strength_sum: f64,
    count: u32,
}

impl Default for FingerprintAccumulator {
    fn default() -> Self {
        Self {
            anchor_weighted_sum: 0.0,
            target_weighted_sum: 0.0,
            weight_sum: 0.0,
            strength_sum: 0.0,
            count: 0,
        }
    }
}

#[derive(Debug)]
struct LandmarkTimelineFingerprint {
    start_ms: i64,
    frame_ms: i64,
    frames: Vec<FingerprintFrame>,
}

#[derive(Debug, Clone, Copy)]
struct LocatedBlock {
    source_time_ms: i64,
    target_time_ms: i64,
    score: f64,
    margin: f64,
    held_out: bool,
}

#[derive(Debug, Clone)]
struct ApproximateOffsetIsland {
    anchors: Vec<LocatedBlock>,
    offset_ms: i64,
    source_start_ms: i64,
    source_end_ms: i64,
    target_start_ms: i64,
    target_end_ms: i64,
}

pub fn match_landmark_timelines_approximately(
    source: &[SpectralLandmark],
    target: &[SpectralLandmark],
    source_bounds: (i64, i64),
    target_bounds: (i64, i64),
    config: &ApproximateFingerprintConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<ApproximateFingerprintMatchResult, String> {
    validate_config(config)?;
    check_cancelled(cancel_flag)?;
    let source_fingerprint =
        create_timeline_fingerprint(source, source_bounds, config.frame_ms, cancel_flag)?;
    let target_fingerprint =
        create_timeline_fingerprint(target, target_bounds, config.frame_ms, cancel_flag)?;
    let block_frames = usize::try_from(config.block_ms / config.frame_ms)
        .map_err(|_| "近似粗定位 block frame 数无法表示。".to_string())?;
    if source_fingerprint.frames.len() < block_frames
        || target_fingerprint.frames.len() < block_frames
    {
        return Ok(empty_match_result());
    }
    if source_fingerprint.frames.len() >= target_fingerprint.frames.len() {
        let located = locate_distributed_target_blocks(
            &source_fingerprint,
            &target_fingerprint,
            block_frames,
            config,
            cancel_flag,
        )?;
        summarize_spectral_matches(&located, target_bounds, config)
    } else {
        let located = locate_distributed_target_blocks(
            &target_fingerprint,
            &source_fingerprint,
            block_frames,
            config,
            cancel_flag,
        )?;
        let reversed = summarize_spectral_matches(&located, source_bounds, config)?;
        Ok(swap_approximate_match_result_axes(reversed))
    }
}

pub fn match_spectral_fingerprints_approximately(
    source: &[CoarseSpectralFingerprintFrame],
    target: &[CoarseSpectralFingerprintFrame],
    source_bounds: (i64, i64),
    target_bounds: (i64, i64),
    config: &ApproximateFingerprintConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<ApproximateFingerprintMatchResult, String> {
    validate_config(config)?;
    check_cancelled(cancel_flag)?;
    if config.frame_ms != 500 {
        return Err("粗声谱指纹当前要求 500 ms frame。".to_string());
    }
    let block_frames = usize::try_from(config.block_ms / config.frame_ms)
        .map_err(|_| "粗声谱指纹 block frame 数无法表示。".to_string())?;
    if source.len() < block_frames || target.len() < block_frames {
        return Ok(empty_match_result());
    }
    if source.len() < target.len() {
        let reversed = match_spectral_fingerprints_one_way(
            target,
            source,
            source_bounds,
            block_frames,
            config,
            cancel_flag,
        )?;
        return Ok(swap_approximate_match_result_axes(reversed));
    }
    match_spectral_fingerprints_one_way(
        source,
        target,
        target_bounds,
        block_frames,
        config,
        cancel_flag,
    )
}

fn match_spectral_fingerprints_one_way(
    source: &[CoarseSpectralFingerprintFrame],
    target: &[CoarseSpectralFingerprintFrame],
    target_bounds: (i64, i64),
    block_frames: usize,
    config: &ApproximateFingerprintConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<ApproximateFingerprintMatchResult, String> {
    let located =
        locate_distributed_spectral_blocks(source, target, block_frames, config, cancel_flag)?;
    let mut result = summarize_spectral_matches(&located, target_bounds, config)?;
    for hypothesis in &mut result.hypotheses {
        let mut held_out = create_dense_local_held_out_anchors(
            source,
            target,
            block_frames,
            hypothesis,
            config,
            cancel_flag,
        )?;
        held_out.extend(hypothesis.held_out_anchors.iter().cloned());
        held_out.sort_by(|left, right| {
            left.target_time_ms
                .cmp(&right.target_time_ms)
                .then_with(|| left.source_time_ms.cmp(&right.source_time_ms))
        });
        held_out.dedup_by(|left, right| {
            left.target_time_ms.abs_diff(right.target_time_ms) < config.block_ms as u64
        });
        hypothesis.held_out_anchors = held_out;
    }
    Ok(result)
}

fn swap_approximate_match_result_axes(
    mut result: ApproximateFingerprintMatchResult,
) -> ApproximateFingerprintMatchResult {
    for hypothesis in &mut result.hypotheses {
        hypothesis.offset_ms = hypothesis.offset_ms.saturating_neg();
        for anchor in hypothesis
            .training_anchors
            .iter_mut()
            .chain(hypothesis.held_out_anchors.iter_mut())
        {
            std::mem::swap(&mut anchor.source_time_ms, &mut anchor.target_time_ms);
            anchor.residual_ms = anchor.residual_ms.saturating_neg();
        }
        hypothesis
            .training_anchors
            .sort_by_key(|anchor| anchor.source_time_ms);
        hypothesis
            .held_out_anchors
            .sort_by_key(|anchor| anchor.source_time_ms);
        hypothesis.source_start_ms = hypothesis
            .training_anchors
            .first()
            .map(|anchor| anchor.source_time_ms)
            .unwrap_or(0);
        hypothesis.source_end_ms = hypothesis
            .training_anchors
            .last()
            .map(|anchor| anchor.source_time_ms)
            .unwrap_or(hypothesis.source_start_ms);
    }
    result.unique_training_offsets_ms = result
        .unique_training_offsets_ms
        .into_iter()
        .map(i64::saturating_neg)
        .collect();
    for block in &mut result.block_matches {
        std::mem::swap(&mut block.source_time_ms, &mut block.target_time_ms);
        block.offset_ms = block.offset_ms.saturating_neg();
    }
    result
}

fn empty_match_result() -> ApproximateFingerprintMatchResult {
    ApproximateFingerprintMatchResult {
        hypotheses: Vec::new(),
        query_block_count: 0,
        score_accepted_block_count: 0,
        unique_training_block_count: 0,
        best_block_score: None,
        median_block_score: None,
        best_block_margin: None,
        median_block_margin: None,
        unique_training_offsets_ms: Vec::new(),
        block_matches: Vec::new(),
    }
}

fn summarize_spectral_matches(
    located: &[LocatedBlock],
    target_bounds: (i64, i64),
    config: &ApproximateFingerprintConfig,
) -> Result<ApproximateFingerprintMatchResult, String> {
    let accepted = located
        .iter()
        .filter(|anchor| anchor.score >= config.min_block_score)
        .count();
    let training = located
        .iter()
        .filter(|anchor| {
            !anchor.held_out
                && anchor.score >= config.min_block_score
                && anchor.margin >= config.min_block_margin
        })
        .collect::<Vec<_>>();
    let mut scores = located
        .iter()
        .map(|anchor| anchor.score)
        .collect::<Vec<_>>();
    scores.sort_by(f64::total_cmp);
    let mut margins = located
        .iter()
        .map(|anchor| anchor.margin)
        .collect::<Vec<_>>();
    margins.sort_by(f64::total_cmp);
    Ok(ApproximateFingerprintMatchResult {
        hypotheses: build_hypotheses(located, target_bounds, config)?,
        query_block_count: located.len(),
        score_accepted_block_count: accepted,
        unique_training_block_count: training.len(),
        best_block_score: scores.last().copied(),
        median_block_score: scores.get(scores.len() / 2).copied(),
        best_block_margin: margins.last().copied(),
        median_block_margin: margins.get(margins.len() / 2).copied(),
        unique_training_offsets_ms: training
            .into_iter()
            .map(|anchor| anchor.target_time_ms.saturating_sub(anchor.source_time_ms))
            .collect(),
        block_matches: located
            .iter()
            .map(|anchor| ApproximateBlockMatch {
                source_time_ms: anchor.source_time_ms,
                target_time_ms: anchor.target_time_ms,
                offset_ms: anchor.target_time_ms.saturating_sub(anchor.source_time_ms),
                score: anchor.score,
                alternative_margin: anchor.margin,
                held_out: anchor.held_out,
            })
            .collect(),
    })
}

fn locate_distributed_spectral_blocks(
    source: &[CoarseSpectralFingerprintFrame],
    target: &[CoarseSpectralFingerprintFrame],
    block_frames: usize,
    config: &ApproximateFingerprintConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<LocatedBlock>, String> {
    let stride_frames = usize::try_from(config.block_stride_ms / config.frame_ms)
        .map_err(|_| "粗声谱指纹 block stride 无法表示。".to_string())?;
    let target_starts = distributed_block_starts(
        target.len(),
        block_frames,
        stride_frames,
        config.max_query_blocks,
    );
    let source_last_start = source.len() - block_frames;
    let exclusion_radius = block_frames.saturating_mul(2);
    let mut located = Vec::with_capacity(target_starts.len());
    for (ordinal, target_start) in target_starts.into_iter().enumerate() {
        check_cancelled(cancel_flag)?;
        let target_block = &target[target_start..target_start + block_frames];
        let mut best = None::<(usize, f64)>;
        let mut second = None::<(usize, f64)>;
        for source_start in 0..=source_last_start {
            if source_start % CANCEL_CHECK_INTERVAL == 0 {
                check_cancelled(cancel_flag)?;
            }
            let score = spectral_fingerprint_block_score(
                &source[source_start..source_start + block_frames],
                target_block,
            );
            update_best_two(
                &mut best,
                &mut second,
                source_start,
                score,
                exclusion_radius,
            );
        }
        let Some((source_start, best_score)) = best else {
            continue;
        };
        let center = block_frames / 2;
        located.push(LocatedBlock {
            source_time_ms: source[source_start + center].time_ms,
            target_time_ms: target[target_start + center].time_ms,
            score: best_score,
            margin: (best_score - second.map(|(_, score)| score).unwrap_or(0.0)).max(0.0),
            held_out: ordinal % 5 == 2,
        });
    }
    Ok(located)
}

fn create_dense_local_held_out_anchors(
    source: &[CoarseSpectralFingerprintFrame],
    target: &[CoarseSpectralFingerprintFrame],
    block_frames: usize,
    hypothesis: &ApproximateCoarseHypothesis,
    config: &ApproximateFingerprintConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<ApproximateAnchor>, String> {
    let held_out_stride_frames = usize::try_from(60_000 / config.frame_ms)
        .map_err(|_| "粗声谱指纹 held-out stride 无法表示。".to_string())?
        .max(1);
    let local_radius_frames = usize::try_from(config.inlier_tolerance_ms / config.frame_ms)
        .map_err(|_| "粗声谱指纹 held-out radius 无法表示。".to_string())?;
    let training_target_times = hypothesis
        .training_anchors
        .iter()
        .map(|anchor| anchor.target_time_ms)
        .collect::<Vec<_>>();
    let mut held_out = Vec::new();
    for target_start in
        (held_out_stride_frames..=target.len() - block_frames).step_by(held_out_stride_frames)
    {
        check_cancelled(cancel_flag)?;
        let center = target_start + block_frames / 2;
        let target_time_ms = target[center].time_ms;
        if training_target_times.iter().any(|training_time_ms| {
            training_time_ms.abs_diff(target_time_ms) < config.block_ms as u64
        }) {
            continue;
        }
        let predicted_source_time_ms = if hypothesis.offset_island_count > 1 {
            let Some(predicted) =
                piecewise_predicted_source_time_ms(hypothesis, target_time_ms, config)
            else {
                continue;
            };
            predicted
        } else {
            target_time_ms.saturating_sub(hypothesis.offset_ms)
        };
        let insertion = source.partition_point(|frame| frame.time_ms < predicted_source_time_ms);
        let predicted_center = insertion.min(source.len().saturating_sub(1));
        let predicted_start = predicted_center.saturating_sub(block_frames / 2);
        let search_start = predicted_start.saturating_sub(local_radius_frames);
        let search_end = predicted_start
            .saturating_add(local_radius_frames)
            .min(source.len() - block_frames);
        let target_block = &target[target_start..target_start + block_frames];
        let mut best = None::<(usize, f64)>;
        let mut second = None::<(usize, f64)>;
        for source_start in search_start..=search_end {
            let score = spectral_fingerprint_block_score(
                &source[source_start..source_start + block_frames],
                target_block,
            );
            update_best_two(
                &mut best,
                &mut second,
                source_start,
                score,
                block_frames.saturating_mul(2),
            );
        }
        let Some((source_start, score)) = best else {
            continue;
        };
        let margin = (score - second.map(|(_, score)| score).unwrap_or(0.0)).max(0.0);
        if score < config.min_block_score || margin < config.min_block_margin {
            continue;
        }
        let source_time_ms = source[source_start + block_frames / 2].time_ms;
        held_out.push(ApproximateAnchor {
            source_time_ms,
            target_time_ms,
            // `predicted_source_time_ms` already comes from the local offset island. Persist the
            // residual against that prediction instead of the first island's bootstrap offset;
            // downstream held-out validation must not reinterpret later genuine islands as
            // unrelated global-offset collisions.
            residual_ms: predicted_source_time_ms.saturating_sub(source_time_ms),
            score,
            alternative_margin: margin,
        });
    }
    Ok(held_out)
}

fn piecewise_predicted_source_time_ms(
    hypothesis: &ApproximateCoarseHypothesis,
    target_time_ms: i64,
    config: &ApproximateFingerprintConfig,
) -> Option<i64> {
    let local_offset = |anchor: &ApproximateAnchor| {
        anchor
            .target_time_ms
            .saturating_sub(anchor.source_time_ms)
            .saturating_sub(anchor.residual_ms)
    };
    let before = hypothesis
        .training_anchors
        .iter()
        .filter(|anchor| anchor.target_time_ms <= target_time_ms)
        .max_by_key(|anchor| anchor.target_time_ms);
    let after = hypothesis
        .training_anchors
        .iter()
        .filter(|anchor| anchor.target_time_ms >= target_time_ms)
        .min_by_key(|anchor| anchor.target_time_ms);
    let offset_ms = match (before, after) {
        (Some(before), Some(after)) => {
            let before_offset = local_offset(before);
            let after_offset = local_offset(after);
            let tolerance_ms = config
                .inlier_tolerance_ms
                .min(30_000)
                .max(config.frame_ms.saturating_mul(4));
            if before_offset.abs_diff(after_offset) > tolerance_ms as u64 {
                return None;
            }
            ((before_offset as i128 + after_offset as i128) / 2) as i64
        }
        (Some(anchor), None) | (None, Some(anchor))
            if anchor.target_time_ms.abs_diff(target_time_ms)
                <= config.block_stride_ms.saturating_mul(2) as u64 =>
        {
            local_offset(anchor)
        }
        _ => return None,
    };
    Some(target_time_ms.saturating_sub(offset_ms))
}

fn distributed_block_starts(
    frame_count: usize,
    block_frames: usize,
    stride_frames: usize,
    max_query_blocks: usize,
) -> Vec<usize> {
    let mut starts = (0..=frame_count - block_frames)
        .step_by(stride_frames.max(1))
        .collect::<Vec<_>>();
    if starts
        .last()
        .is_none_or(|start| start.saturating_add(block_frames) < frame_count)
    {
        starts.push(frame_count - block_frames);
    }
    if starts.len() > max_query_blocks {
        let denominator = max_query_blocks.saturating_sub(1).max(1);
        starts = (0..max_query_blocks)
            .map(|index| index.saturating_mul(starts.len().saturating_sub(1)) / denominator)
            .map(|index| starts[index])
            .collect();
        starts.dedup();
    }
    starts
}

fn update_best_two(
    best: &mut Option<(usize, f64)>,
    second: &mut Option<(usize, f64)>,
    start: usize,
    score: f64,
    exclusion_radius: usize,
) {
    match *best {
        None => *best = Some((start, score)),
        Some((best_start, best_score)) if score > best_score => {
            if best_start.abs_diff(start) > exclusion_radius {
                *second = *best;
            }
            *best = Some((start, score));
        }
        Some((best_start, _)) if best_start.abs_diff(start) > exclusion_radius => {
            if second.is_none_or(|(_, second_score)| score > second_score) {
                *second = Some((start, score));
            }
        }
        Some(_) => {}
    }
}

fn spectral_fingerprint_block_score(
    source: &[CoarseSpectralFingerprintFrame],
    target: &[CoarseSpectralFingerprintFrame],
) -> f64 {
    let mut score_sum = 0.0;
    let mut compared = 0_usize;
    let mut previous = None::<(
        [u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
        [u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    )>;
    for (source_frame, target_frame) in source.iter().zip(target) {
        if source_frame.active_ratio_milli < 100 || target_frame.active_ratio_milli < 100 {
            previous = None;
            continue;
        }
        let absolute = cosine_u8(&source_frame.values, &target_frame.values);
        let delta = previous.map_or(absolute, |(previous_source, previous_target)| {
            cosine_delta(
                &previous_source,
                &source_frame.values,
                &previous_target,
                &target_frame.values,
            )
        });
        let activity = (1.0
            - source_frame
                .active_ratio_milli
                .abs_diff(target_frame.active_ratio_milli) as f64
                / 1_000.0)
            .clamp(0.0, 1.0);
        score_sum += absolute * 0.60 + delta * 0.30 + activity * 0.10;
        compared = compared.saturating_add(1);
        previous = Some((source_frame.values, target_frame.values));
    }
    let spectral_score = (compared >= source.len().div_ceil(2)).then(|| {
        (score_sum / compared.max(1) as f64)
            * (compared as f64 / source.len().max(1) as f64).clamp(0.0, 1.0)
    });
    let envelope_score = positive_log_rms_correlation(source, target, false)
        .zip(positive_log_rms_correlation(source, target, true))
        .map(|(absolute, delta)| absolute * 0.60 + delta * 0.40)
        .or_else(|| positive_log_rms_correlation(source, target, false))
        .or_else(|| positive_log_rms_correlation(source, target, true));
    match (spectral_score, envelope_score) {
        (Some(spectral_score), Some(envelope_score)) => {
            // Transcoding can substantially reshape the normalized 12-band spectrum while
            // preserving the program's loudness rhythm. Let the gain-invariant envelope lead
            // coarse localization; exact content acceptance still belongs to multi-block
            // consensus, held-out anchors and fine edit-aware DP.
            spectral_score * 0.30 + envelope_score * 0.70
        }
        (Some(spectral_score), None) => spectral_score,
        // Quiet dialogue and sparse openings may not retain enough active spectral frames after
        // transcoding. The persisted RMS envelope is independent evidence and must not be
        // short-circuited by the spectral activity gate.
        (None, Some(envelope_score)) => envelope_score,
        (None, None) => 0.0,
    }
}

fn positive_log_rms_correlation(
    source: &[CoarseSpectralFingerprintFrame],
    target: &[CoarseSpectralFingerprintFrame],
    delta: bool,
) -> Option<f64> {
    let start = usize::from(delta);
    if source.len() <= start || target.len() <= start {
        return None;
    }
    let mut count = 0.0_f64;
    let mut source_sum = 0.0_f64;
    let mut target_sum = 0.0_f64;
    let mut source_square_sum = 0.0_f64;
    let mut target_square_sum = 0.0_f64;
    let mut cross_sum = 0.0_f64;
    let mut any_energy = false;
    for index in start..source.len().min(target.len()) {
        let source_value = if delta {
            f64::from(source[index].log_rms_milli) - f64::from(source[index - 1].log_rms_milli)
        } else {
            f64::from(source[index].log_rms_milli)
        };
        let target_value = if delta {
            f64::from(target[index].log_rms_milli) - f64::from(target[index - 1].log_rms_milli)
        } else {
            f64::from(target[index].log_rms_milli)
        };
        any_energy |= source[index].log_rms_milli > 0 || target[index].log_rms_milli > 0;
        count += 1.0;
        source_sum += source_value;
        target_sum += target_value;
        source_square_sum += source_value * source_value;
        target_square_sum += target_value * target_value;
        cross_sum += source_value * target_value;
    }
    if !any_energy || count < 8.0 {
        return None;
    }
    let source_variance = source_square_sum - source_sum * source_sum / count;
    let target_variance = target_square_sum - target_sum * target_sum / count;
    if source_variance <= f64::EPSILON || target_variance <= f64::EPSILON {
        return None;
    }
    let covariance = cross_sum - source_sum * target_sum / count;
    Some((covariance / (source_variance.sqrt() * target_variance.sqrt())).clamp(0.0, 1.0))
}

fn cosine_u8(
    left: &[u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    right: &[u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
) -> f64 {
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for (left, right) in left.iter().zip(right) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        0.0
    } else {
        (dot / (left_norm.sqrt() * right_norm.sqrt())).clamp(0.0, 1.0)
    }
}

fn cosine_delta(
    left_previous: &[u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    left_current: &[u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    right_previous: &[u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
    right_current: &[u8; COARSE_SPECTRAL_FINGERPRINT_BANDS],
) -> f64 {
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for index in 0..COARSE_SPECTRAL_FINGERPRINT_BANDS {
        let left = f64::from(left_current[index]) - f64::from(left_previous[index]);
        let right = f64::from(right_current[index]) - f64::from(right_previous[index]);
        dot += left * right;
        left_norm += left * left;
        right_norm += right * right;
    }
    if left_norm <= f64::EPSILON || right_norm <= f64::EPSILON {
        0.0
    } else {
        (((dot / (left_norm.sqrt() * right_norm.sqrt())) + 1.0) * 0.5).clamp(0.0, 1.0)
    }
}

fn validate_config(config: &ApproximateFingerprintConfig) -> Result<(), String> {
    if config.frame_ms <= 0
        || config.block_ms < config.frame_ms * 8
        || config.block_ms % config.frame_ms != 0
        || config.block_stride_ms < config.block_ms
        || config.block_stride_ms % config.frame_ms != 0
        || config.max_query_blocks == 0
        || config.max_query_blocks > 128
        || !config.min_block_score.is_finite()
        || !(0.0..=1.0).contains(&config.min_block_score)
        || !config.min_block_margin.is_finite()
        || !(0.0..=1.0).contains(&config.min_block_margin)
        || config.inlier_tolerance_ms < config.frame_ms
        || config.min_training_anchors < 3
        || config.max_hypotheses == 0
        || config.max_hypotheses > 16
    {
        return Err("近似粗定位配置无效。".to_string());
    }
    Ok(())
}

fn create_timeline_fingerprint(
    landmarks: &[SpectralLandmark],
    bounds: (i64, i64),
    frame_ms: i64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<LandmarkTimelineFingerprint, String> {
    if bounds.1 <= bounds.0 {
        return Err("近似粗定位展示时间范围无效。".to_string());
    }
    let duration_ms = bounds.1.saturating_sub(bounds.0);
    let frame_count_i64 = duration_ms
        .checked_add(frame_ms - 1)
        .ok_or_else(|| "近似粗定位 frame 数溢出。".to_string())?
        / frame_ms;
    let frame_count = usize::try_from(frame_count_i64)
        .map_err(|_| "近似粗定位 frame 数无法表示。".to_string())?;
    if frame_count == 0 || frame_count > MAX_FINGERPRINT_FRAMES {
        return Err(format!(
            "blocked:resource-limit：近似粗定位需要 {frame_count} 个 frame，超过硬上限 {MAX_FINGERPRINT_FRAMES}。"
        ));
    }
    let mut accumulators = vec![FingerprintAccumulator::default(); frame_count];
    for (index, landmark) in landmarks.iter().enumerate() {
        if index % CANCEL_CHECK_INTERVAL == 0 {
            check_cancelled(cancel_flag)?;
        }
        if landmark.time_ms < bounds.0 || landmark.time_ms >= bounds.1 {
            continue;
        }
        let frame_index = usize::try_from((landmark.time_ms - bounds.0) / frame_ms)
            .map_err(|_| "近似粗定位 landmark frame 无法表示。".to_string())?;
        let Some(frame) = accumulators.get_mut(frame_index) else {
            continue;
        };
        let anchor_bin = ((landmark.hash >> 16) & 0xff) as u8;
        let target_bin = ((landmark.hash >> 8) & 0xff) as u8;
        if anchor_bin >= 48 || target_bin >= 48 {
            continue;
        }
        let strength = f64::from(landmark.strength_milli.max(1));
        let weight = strength.ln_1p();
        frame.anchor_weighted_sum += f64::from(anchor_bin) * weight;
        frame.target_weighted_sum += f64::from(target_bin) * weight;
        frame.weight_sum += weight;
        frame.strength_sum += strength;
        frame.count = frame.count.saturating_add(1);
    }
    let frames = accumulators
        .into_iter()
        .map(|frame| {
            if frame.count == 0 || frame.weight_sum <= f64::EPSILON {
                FingerprintFrame::default()
            } else {
                FingerprintFrame {
                    anchor_centroid: (frame.anchor_weighted_sum / frame.weight_sum) as f32,
                    target_centroid: (frame.target_weighted_sum / frame.weight_sum) as f32,
                    log_activity: f64::from(frame.count).ln_1p() as f32,
                    log_strength: frame.strength_sum.ln_1p() as f32,
                    active: true,
                }
            }
        })
        .collect();
    Ok(LandmarkTimelineFingerprint {
        start_ms: bounds.0,
        frame_ms,
        frames,
    })
}

fn locate_distributed_target_blocks(
    source: &LandmarkTimelineFingerprint,
    target: &LandmarkTimelineFingerprint,
    block_frames: usize,
    config: &ApproximateFingerprintConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<Vec<LocatedBlock>, String> {
    let stride_frames = usize::try_from(config.block_stride_ms / config.frame_ms)
        .map_err(|_| "近似粗定位 block stride 无法表示。".to_string())?;
    let mut target_starts = (0..=target.frames.len() - block_frames)
        .step_by(stride_frames.max(1))
        .collect::<Vec<_>>();
    if target_starts
        .last()
        .is_none_or(|start| start.saturating_add(block_frames) < target.frames.len())
    {
        target_starts.push(target.frames.len() - block_frames);
    }
    if target_starts.len() > config.max_query_blocks {
        let denominator = config.max_query_blocks.saturating_sub(1).max(1);
        target_starts = (0..config.max_query_blocks)
            .map(|index| index.saturating_mul(target_starts.len().saturating_sub(1)) / denominator)
            .map(|index| target_starts[index])
            .collect();
        target_starts.dedup();
    }

    let source_last_start = source.frames.len() - block_frames;
    let exclusion_radius = block_frames.saturating_mul(2);
    let mut located = Vec::with_capacity(target_starts.len());
    for (ordinal, target_start) in target_starts.into_iter().enumerate() {
        check_cancelled(cancel_flag)?;
        let target_block = &target.frames[target_start..target_start + block_frames];
        let mut best = None::<(usize, f64)>;
        let mut second = None::<(usize, f64)>;
        for source_start in 0..=source_last_start {
            if source_start % CANCEL_CHECK_INTERVAL == 0 {
                check_cancelled(cancel_flag)?;
            }
            let score = fingerprint_block_score(
                &source.frames[source_start..source_start + block_frames],
                target_block,
            );
            match best {
                None => best = Some((source_start, score)),
                Some((best_start, best_score)) if score > best_score => {
                    if best_start.abs_diff(source_start) > exclusion_radius {
                        second = best;
                    }
                    best = Some((source_start, score));
                }
                Some((best_start, _)) if best_start.abs_diff(source_start) > exclusion_radius => {
                    if second.is_none_or(|(_, second_score)| score > second_score) {
                        second = Some((source_start, score));
                    }
                }
                Some(_) => {}
            }
        }
        let Some((source_start, best_score)) = best else {
            continue;
        };
        let second_score = second.map(|(_, score)| score).unwrap_or(0.0);
        let margin = (best_score - second_score).max(0.0);
        let center_frame = block_frames / 2;
        located.push(LocatedBlock {
            source_time_ms: source.start_ms.saturating_add(
                i64::try_from(source_start.saturating_add(center_frame))
                    .unwrap_or(i64::MAX)
                    .saturating_mul(source.frame_ms),
            ),
            target_time_ms: target.start_ms.saturating_add(
                i64::try_from(target_start.saturating_add(center_frame))
                    .unwrap_or(i64::MAX)
                    .saturating_mul(target.frame_ms),
            ),
            score: best_score,
            margin,
            held_out: ordinal % 5 == 2,
        });
    }
    Ok(located)
}

fn fingerprint_block_score(source: &[FingerprintFrame], target: &[FingerprintFrame]) -> f64 {
    let mut score_sum = 0.0;
    let mut compared = 0_usize;
    let mut previous = None::<(FingerprintFrame, FingerprintFrame)>;
    for (source_frame, target_frame) in source.iter().zip(target) {
        if !source_frame.active || !target_frame.active {
            previous = None;
            continue;
        }
        let anchor_similarity = centroid_similarity(
            f64::from(source_frame.anchor_centroid),
            f64::from(target_frame.anchor_centroid),
        );
        let target_similarity = centroid_similarity(
            f64::from(source_frame.target_centroid),
            f64::from(target_frame.target_centroid),
        );
        let absolute_similarity = (anchor_similarity + target_similarity) * 0.5;
        let activity_similarity =
            (-f64::from((source_frame.log_activity - target_frame.log_activity).abs())).exp();
        let strength_similarity =
            (-f64::from((source_frame.log_strength - target_frame.log_strength).abs()) / 4.0).exp();
        let delta_similarity =
            previous.map_or(absolute_similarity, |(previous_source, previous_target)| {
                let source_anchor_delta =
                    f64::from(source_frame.anchor_centroid - previous_source.anchor_centroid);
                let target_anchor_delta =
                    f64::from(target_frame.anchor_centroid - previous_target.anchor_centroid);
                let source_target_delta =
                    f64::from(source_frame.target_centroid - previous_source.target_centroid);
                let target_target_delta =
                    f64::from(target_frame.target_centroid - previous_target.target_centroid);
                let anchor_delta_similarity = (1.0
                    - (source_anchor_delta - target_anchor_delta).abs() / SPECTRAL_BIN_COUNT)
                    .clamp(0.0, 1.0);
                let target_delta_similarity = (1.0
                    - (source_target_delta - target_target_delta).abs() / SPECTRAL_BIN_COUNT)
                    .clamp(0.0, 1.0);
                (anchor_delta_similarity + target_delta_similarity) * 0.5
            });
        score_sum += absolute_similarity * 0.45
            + delta_similarity * 0.35
            + activity_similarity * 0.10
            + strength_similarity * 0.10;
        compared = compared.saturating_add(1);
        previous = Some((*source_frame, *target_frame));
    }
    let required = source.len().div_ceil(3);
    if compared < required {
        0.0
    } else {
        (score_sum / compared as f64)
            * (compared as f64 / source.len().max(1) as f64).clamp(0.0, 1.0)
    }
}

fn centroid_similarity(left: f64, right: f64) -> f64 {
    (1.0 - (left - right).abs() / SPECTRAL_BIN_COUNT).clamp(0.0, 1.0)
}

fn build_hypotheses(
    located: &[LocatedBlock],
    target_bounds: (i64, i64),
    config: &ApproximateFingerprintConfig,
) -> Result<Vec<ApproximateCoarseHypothesis>, String> {
    let training = located
        .iter()
        .filter(|anchor| {
            !anchor.held_out
                && anchor.score >= config.min_block_score
                && anchor.margin >= config.min_block_margin
        })
        .copied()
        .collect::<Vec<_>>();
    if training.len() < config.min_training_anchors {
        return Ok(Vec::new());
    }
    let mut seed_offsets = training
        .iter()
        .map(|anchor| anchor.target_time_ms.saturating_sub(anchor.source_time_ms))
        .collect::<Vec<_>>();
    seed_offsets.sort_unstable();
    seed_offsets.dedup();

    let mut hypotheses = Vec::new();
    for seed_offset in seed_offsets {
        let mut inliers = training
            .iter()
            .filter(|anchor| {
                anchor
                    .target_time_ms
                    .saturating_sub(anchor.source_time_ms)
                    .abs_diff(seed_offset)
                    <= config.inlier_tolerance_ms as u64
            })
            .copied()
            .collect::<Vec<_>>();
        if inliers.len() < config.min_training_anchors {
            continue;
        }
        let mut offsets = inliers
            .iter()
            .map(|anchor| anchor.target_time_ms.saturating_sub(anchor.source_time_ms))
            .collect::<Vec<_>>();
        offsets.sort_unstable();
        let offset_ms = offsets[offsets.len() / 2];
        inliers.retain(|anchor| {
            anchor
                .target_time_ms
                .saturating_sub(anchor.source_time_ms)
                .abs_diff(offset_ms)
                <= config.inlier_tolerance_ms as u64
        });
        if inliers.len() < config.min_training_anchors {
            continue;
        }
        inliers.sort_by_key(|anchor| anchor.source_time_ms);
        let source_start_ms = inliers
            .first()
            .map(|anchor| anchor.source_time_ms)
            .unwrap_or(0);
        let source_end_ms = inliers
            .last()
            .map(|anchor| anchor.source_time_ms)
            .unwrap_or(source_start_ms);
        let target_min = inliers
            .iter()
            .map(|anchor| anchor.target_time_ms)
            .min()
            .unwrap_or(target_bounds.0);
        let target_max = inliers
            .iter()
            .map(|anchor| anchor.target_time_ms)
            .max()
            .unwrap_or(target_min);
        let target_duration = target_bounds.1.saturating_sub(target_bounds.0).max(1);
        let target_coverage = target_max.saturating_sub(target_min) as f64 / target_duration as f64;
        // A long unrelated tail changes whole-query coverage without changing local
        // correspondence. Admit a smaller region only with strong, independent support;
        // this is a candidate for fine alignment, never automatic verification.
        let partial_tolerance = config.frame_ms.max(500) * 2;
        let coherent_partial = inliers.len() >= 6
            && target_max.saturating_sub(target_min) >= 120_000
            && inliers.iter().all(|anchor| {
                anchor.score >= config.min_block_score.max(0.65)
                    && anchor.margin >= config.min_block_margin.max(0.05)
                    && anchor
                        .target_time_ms
                        .saturating_sub(anchor.source_time_ms)
                        .abs_diff(offset_ms)
                        <= partial_tolerance as u64
            });
        // Holdouts remain solely for downstream verification, not hypothesis admission:
        // using them here would make the final reported holdout accuracy selection-biased.
        if target_coverage < 0.35 && !coherent_partial {
            continue;
        }
        let training_anchors = inliers
            .iter()
            .map(|anchor| approximate_anchor(*anchor, offset_ms))
            .collect::<Vec<_>>();
        let held_out_anchors = located
            .iter()
            .filter(|anchor| anchor.held_out && anchor.score >= config.min_block_score)
            .map(|anchor| approximate_anchor(*anchor, offset_ms))
            .collect::<Vec<_>>();
        let mut residuals = training_anchors
            .iter()
            .map(|anchor| anchor.residual_ms.unsigned_abs())
            .collect::<Vec<_>>();
        residuals.sort_unstable();
        let p50_residual_ms = percentile(&residuals, 50);
        let p95_residual_ms = percentile(&residuals, 95);
        let max_residual_ms = residuals.last().copied().unwrap_or(0);
        let average_block_score =
            inliers.iter().map(|anchor| anchor.score).sum::<f64>() / inliers.len() as f64;
        let support_score = (inliers.len() as f64 / 16.0).clamp(0.0, 1.0);
        let score = average_block_score * 0.50
            + target_coverage.clamp(0.0, 1.0) * 0.30
            + support_score * 0.20;
        hypotheses.push(ApproximateCoarseHypothesis {
            scale: 1.0,
            offset_ms,
            offset_island_count: 1,
            training_anchors,
            held_out_anchors,
            source_start_ms,
            source_end_ms,
            target_coverage: target_coverage.clamp(0.0, 1.0),
            p50_residual_ms: i64::try_from(p50_residual_ms).unwrap_or(i64::MAX),
            p95_residual_ms: i64::try_from(p95_residual_ms).unwrap_or(i64::MAX),
            max_residual_ms: i64::try_from(max_residual_ms).unwrap_or(i64::MAX),
            score: score.clamp(0.0, 1.0),
        });
    }
    if let Some(piecewise) = build_piecewise_hypothesis(&training, located, target_bounds, config)?
    {
        hypotheses.push(piecewise);
    }
    hypotheses.sort_by(|left, right| {
        right
            .training_anchors
            .len()
            .cmp(&left.training_anchors.len())
            .then_with(|| right.offset_island_count.cmp(&left.offset_island_count))
            .then_with(|| right.target_coverage.total_cmp(&left.target_coverage))
            .then_with(|| right.score.total_cmp(&left.score))
            .then_with(|| left.p95_residual_ms.cmp(&right.p95_residual_ms))
            .then_with(|| left.offset_ms.cmp(&right.offset_ms))
    });
    let mut deduplicated = Vec::<ApproximateCoarseHypothesis>::new();
    for hypothesis in hypotheses {
        if deduplicated.iter().any(|existing| {
            existing.offset_island_count == hypothesis.offset_island_count
                && existing.offset_ms.abs_diff(hypothesis.offset_ms)
                    <= config.inlier_tolerance_ms as u64
        }) {
            continue;
        }
        deduplicated.push(hypothesis);
        if deduplicated.len() >= config.max_hypotheses {
            break;
        }
    }
    Ok(deduplicated)
}

fn build_piecewise_hypothesis(
    training: &[LocatedBlock],
    located: &[LocatedBlock],
    target_bounds: (i64, i64),
    config: &ApproximateFingerprintConfig,
) -> Result<Option<ApproximateCoarseHypothesis>, String> {
    // This is deliberately stricter than the ordinary single-offset path. A lone weak cluster
    // must never become a match merely because a long upload provides many opportunities for a
    // collision. Piecewise recovery requires several independently stable islands whose source
    // and target coordinates are both monotonic.
    let minimum_piecewise_score = config.min_block_score.max(0.70);
    let island_offset_tolerance_ms = config
        .inlier_tolerance_ms
        .min(30_000)
        .max(config.frame_ms.saturating_mul(4));
    let mut eligible = training
        .iter()
        .filter(|anchor| anchor.score >= minimum_piecewise_score)
        .copied()
        .collect::<Vec<_>>();
    if eligible.len() < config.min_training_anchors.max(6) {
        return Ok(None);
    }
    eligible.sort_by_key(|anchor| anchor.target_time_ms.saturating_sub(anchor.source_time_ms));

    let mut islands = Vec::<ApproximateOffsetIsland>::new();
    let mut cursor = 0_usize;
    while cursor < eligible.len() {
        let start = cursor;
        let seed_offset = eligible[cursor]
            .target_time_ms
            .saturating_sub(eligible[cursor].source_time_ms);
        cursor += 1;
        while cursor < eligible.len()
            && eligible[cursor]
                .target_time_ms
                .saturating_sub(eligible[cursor].source_time_ms)
                .abs_diff(seed_offset)
                <= island_offset_tolerance_ms as u64
        {
            cursor += 1;
        }
        let mut anchors = eligible[start..cursor].to_vec();
        if anchors.len() < 2 {
            continue;
        }
        let mut offsets = anchors
            .iter()
            .map(|anchor| anchor.target_time_ms.saturating_sub(anchor.source_time_ms))
            .collect::<Vec<_>>();
        offsets.sort_unstable();
        let offset_ms = offsets[offsets.len() / 2];
        anchors.retain(|anchor| {
            anchor
                .target_time_ms
                .saturating_sub(anchor.source_time_ms)
                .abs_diff(offset_ms)
                <= island_offset_tolerance_ms as u64
        });
        anchors.sort_by_key(|anchor| anchor.target_time_ms);
        anchors.dedup_by_key(|anchor| anchor.target_time_ms);
        if anchors.len() < 2
            || anchors
                .windows(2)
                .any(|pair| pair[1].source_time_ms <= pair[0].source_time_ms)
        {
            continue;
        }
        let source_start_ms = anchors
            .first()
            .map(|anchor| anchor.source_time_ms)
            .unwrap_or(0);
        let source_end_ms = anchors
            .last()
            .map(|anchor| anchor.source_time_ms)
            .unwrap_or(source_start_ms);
        let target_start_ms = anchors
            .first()
            .map(|anchor| anchor.target_time_ms)
            .unwrap_or(0);
        let target_end_ms = anchors
            .last()
            .map(|anchor| anchor.target_time_ms)
            .unwrap_or(target_start_ms);
        if source_end_ms.saturating_sub(source_start_ms) < config.block_stride_ms
            || target_end_ms.saturating_sub(target_start_ms) < config.block_stride_ms
        {
            continue;
        }
        islands.push(ApproximateOffsetIsland {
            anchors,
            offset_ms,
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
        });
    }
    if islands.len() < 2 {
        return Ok(None);
    }
    islands.sort_by_key(|island| (island.target_start_ms, island.source_start_ms));

    // Longest monotonic island chain. The primary objective is independent anchor support;
    // score and temporal span only break ties. This allows arbitrary inserted material while
    // rejecting paths that would run either media axis backwards.
    let mut best_anchor_count = vec![0_usize; islands.len()];
    let mut best_score_sum = vec![0.0_f64; islands.len()];
    let mut previous = vec![None::<usize>; islands.len()];
    for index in 0..islands.len() {
        best_anchor_count[index] = islands[index].anchors.len();
        best_score_sum[index] = islands[index]
            .anchors
            .iter()
            .map(|anchor| anchor.score)
            .sum();
        for candidate_previous in 0..index {
            if islands[candidate_previous].target_end_ms >= islands[index].target_start_ms
                || islands[candidate_previous].source_end_ms >= islands[index].source_start_ms
            {
                continue;
            }
            let anchor_count =
                best_anchor_count[candidate_previous].saturating_add(islands[index].anchors.len());
            let score_sum = best_score_sum[candidate_previous]
                + islands[index]
                    .anchors
                    .iter()
                    .map(|anchor| anchor.score)
                    .sum::<f64>();
            if anchor_count > best_anchor_count[index]
                || (anchor_count == best_anchor_count[index] && score_sum > best_score_sum[index])
            {
                best_anchor_count[index] = anchor_count;
                best_score_sum[index] = score_sum;
                previous[index] = Some(candidate_previous);
            }
        }
    }
    let Some(mut end_index) = (0..islands.len()).max_by(|left, right| {
        best_anchor_count[*left]
            .cmp(&best_anchor_count[*right])
            .then_with(|| best_score_sum[*left].total_cmp(&best_score_sum[*right]))
    }) else {
        return Ok(None);
    };
    if best_anchor_count[end_index] < config.min_training_anchors.max(6) {
        return Ok(None);
    }
    let mut chain_indices = Vec::new();
    loop {
        chain_indices.push(end_index);
        let Some(next) = previous[end_index] else {
            break;
        };
        end_index = next;
    }
    chain_indices.reverse();
    if chain_indices.len() < 2 {
        return Ok(None);
    }
    let chain = chain_indices
        .iter()
        .map(|index| &islands[*index])
        .collect::<Vec<_>>();
    let source_start_ms = chain
        .first()
        .map(|island| island.source_start_ms)
        .unwrap_or(0);
    let source_end_ms = chain
        .last()
        .map(|island| island.source_end_ms)
        .unwrap_or(source_start_ms);
    let target_start_ms = chain
        .first()
        .map(|island| island.target_start_ms)
        .unwrap_or(target_bounds.0);
    let target_end_ms = chain
        .last()
        .map(|island| island.target_end_ms)
        .unwrap_or(target_start_ms);
    let target_duration = target_bounds.1.saturating_sub(target_bounds.0).max(1);
    let target_coverage =
        target_end_ms.saturating_sub(target_start_ms) as f64 / target_duration as f64;
    // A multi-part upload may intentionally cover only one chapter of a feature-length target.
    // Its safety comes from at least six high-score anchors across multiple monotonic islands,
    // not from pretending to cover 35% of the complete film. Keep this aligned with the V2
    // relation eligibility floor while leaving the ordinary single-affine 35% gate unchanged.
    if target_coverage < 0.20 {
        return Ok(None);
    }

    let mut training_anchors = Vec::new();
    for island in &chain {
        training_anchors.extend(
            island
                .anchors
                .iter()
                .map(|anchor| approximate_anchor(*anchor, island.offset_ms)),
        );
    }
    training_anchors.sort_by_key(|anchor| anchor.target_time_ms);
    let held_out_anchors = located
        .iter()
        .filter(|anchor| anchor.held_out && anchor.score >= minimum_piecewise_score)
        .filter_map(|anchor| {
            chain
                .iter()
                .filter(|island| {
                    anchor.target_time_ms
                        >= island
                            .target_start_ms
                            .saturating_sub(config.block_stride_ms)
                        && anchor.target_time_ms
                            <= island.target_end_ms.saturating_add(config.block_stride_ms)
                        && anchor.source_time_ms
                            >= island
                                .source_start_ms
                                .saturating_sub(config.block_stride_ms)
                        && anchor.source_time_ms
                            <= island.source_end_ms.saturating_add(config.block_stride_ms)
                })
                .min_by_key(|island| {
                    anchor
                        .target_time_ms
                        .saturating_sub(anchor.source_time_ms)
                        .abs_diff(island.offset_ms)
                })
                .filter(|island| {
                    anchor
                        .target_time_ms
                        .saturating_sub(anchor.source_time_ms)
                        .abs_diff(island.offset_ms)
                        <= island_offset_tolerance_ms as u64
                })
                .map(|island| approximate_anchor(*anchor, island.offset_ms))
        })
        .collect::<Vec<_>>();
    let mut residuals = training_anchors
        .iter()
        .map(|anchor| anchor.residual_ms.unsigned_abs())
        .collect::<Vec<_>>();
    residuals.sort_unstable();
    let average_block_score = training_anchors
        .iter()
        .map(|anchor| anchor.score)
        .sum::<f64>()
        / training_anchors.len().max(1) as f64;
    let support_score = (training_anchors.len() as f64 / 16.0).clamp(0.0, 1.0);
    let score =
        average_block_score * 0.50 + target_coverage.clamp(0.0, 1.0) * 0.30 + support_score * 0.20;
    Ok(Some(ApproximateCoarseHypothesis {
        scale: 1.0,
        // Fine alignment starts at the first real content island. Later chunks are guided by
        // their own bracketing anchors and may cross arbitrary source-only/target-only gaps.
        offset_ms: chain.first().map(|island| island.offset_ms).unwrap_or(0),
        offset_island_count: chain.len(),
        training_anchors,
        held_out_anchors,
        source_start_ms,
        source_end_ms,
        target_coverage: target_coverage.clamp(0.0, 1.0),
        p50_residual_ms: i64::try_from(percentile(&residuals, 50)).unwrap_or(i64::MAX),
        p95_residual_ms: i64::try_from(percentile(&residuals, 95)).unwrap_or(i64::MAX),
        max_residual_ms: i64::try_from(residuals.last().copied().unwrap_or(0)).unwrap_or(i64::MAX),
        score: score.clamp(0.0, 1.0),
    }))
}

fn approximate_anchor(anchor: LocatedBlock, offset_ms: i64) -> ApproximateAnchor {
    let predicted_target_ms = anchor.source_time_ms.saturating_add(offset_ms);
    ApproximateAnchor {
        source_time_ms: anchor.source_time_ms,
        target_time_ms: anchor.target_time_ms,
        residual_ms: anchor.target_time_ms.saturating_sub(predicted_target_ms),
        score: anchor.score,
        alternative_margin: anchor.margin,
    }
}

fn percentile(sorted: &[u64], percentile: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let index = sorted
        .len()
        .saturating_sub(1)
        .saturating_mul(percentile)
        .div_ceil(100);
    sorted[index.min(sorted.len() - 1)]
}

fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        Err("audio alignment cancelled".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn landmark_for_frame(frame: usize, time_ms: i64, codec_shift: u8) -> SpectralLandmark {
        let mut mixed = frame as u64 + 0x9e37_79b9;
        mixed ^= mixed >> 16;
        mixed = mixed.wrapping_mul(0x21f0_aaad);
        mixed ^= mixed >> 15;
        mixed = mixed.wrapping_mul(0x735a_2d97);
        mixed ^= mixed >> 15;
        let anchor_bin = (mixed % 44) as u8 + codec_shift;
        let target_bin = ((mixed >> 12) % 44) as u8 + codec_shift;
        SpectralLandmark {
            hash: (u64::from(anchor_bin) << 16)
                | (u64::from(target_bin) << 8)
                | u64::from(codec_shift.saturating_add(1)),
            time_ms,
            strength_milli: 1_000 + ((frame * 97) % 4_000) as u32,
        }
    }

    #[test]
    fn approximate_fingerprint_recovers_transcoded_subsequence_without_exact_hashes() {
        let frame_ms = 500_i64;
        let source_frames = 1_200_usize;
        let target_start_frame = 240_usize;
        let target_frames = 360_usize;
        let source = (0..source_frames)
            .map(|frame| landmark_for_frame(frame, frame as i64 * frame_ms, 0))
            .collect::<Vec<_>>();
        let target = (0..target_frames)
            .map(|target_frame| {
                landmark_for_frame(
                    target_start_frame + target_frame,
                    target_frame as i64 * frame_ms,
                    1,
                )
            })
            .collect::<Vec<_>>();
        assert!(source.iter().all(|source_item| target
            .iter()
            .all(|target_item| source_item.hash != target_item.hash)));
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.40,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 2_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };
        let result = match_landmark_timelines_approximately(
            &source,
            &target,
            (0, source_frames as i64 * frame_ms),
            (0, target_frames as i64 * frame_ms),
            &config,
            None,
        )
        .unwrap();
        let hypotheses = result.hypotheses;
        assert!(!hypotheses.is_empty());
        assert!(
            hypotheses[0]
                .offset_ms
                .abs_diff(-(target_start_frame as i64 * frame_ms))
                <= frame_ms as u64
        );
        assert!(hypotheses[0].training_anchors.len() >= 4);
        assert!(!hypotheses[0].held_out_anchors.is_empty());
        assert!(hypotheses[0].target_coverage >= 0.70);
    }

    #[test]
    fn approximate_fingerprint_recovers_short_source_inside_long_target() {
        let frame_ms = 500_i64;
        let target_frames = 1_200_usize;
        let target_start_frame = 240_usize;
        let source_frames = 360_usize;
        let target = (0..target_frames)
            .map(|frame| landmark_for_frame(frame, frame as i64 * frame_ms, 0))
            .collect::<Vec<_>>();
        let source = (0..source_frames)
            .map(|source_frame| {
                landmark_for_frame(
                    target_start_frame + source_frame,
                    source_frame as i64 * frame_ms,
                    1,
                )
            })
            .collect::<Vec<_>>();
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.40,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 2_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };

        let result = match_landmark_timelines_approximately(
            &source,
            &target,
            (0, source_frames as i64 * frame_ms),
            (0, target_frames as i64 * frame_ms),
            &config,
            None,
        )
        .unwrap();

        assert!(!result.hypotheses.is_empty());
        assert!(
            result.hypotheses[0]
                .offset_ms
                .abs_diff(target_start_frame as i64 * frame_ms)
                <= frame_ms as u64
        );
        assert!(result.hypotheses[0].target_coverage >= 0.70);
    }

    #[test]
    fn approximate_fingerprint_rejects_unrelated_timeline() {
        let frame_ms = 500_i64;
        let source = (0..600_usize)
            .map(|frame| landmark_for_frame(frame, frame as i64 * frame_ms, 0))
            .collect::<Vec<_>>();
        let target = (0..240_usize)
            .map(|frame| SpectralLandmark {
                hash: (47_u64 << 16) | (47_u64 << 8) | 255,
                time_ms: frame as i64 * frame_ms,
                strength_milli: 500,
            })
            .collect::<Vec<_>>();
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.75,
            min_block_margin: 0.02,
            inlier_tolerance_ms: 2_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };
        let result = match_landmark_timelines_approximately(
            &source,
            &target,
            (0, 300_000),
            (0, 120_000),
            &config,
            None,
        )
        .unwrap();
        assert!(result.hypotheses.is_empty());
    }

    #[test]
    fn approximate_landmark_quantization_preserves_time_and_merges_nearby_bins() {
        let landmarks = vec![
            SpectralLandmark {
                hash: (10_u64 << 16) | (21_u64 << 8) | 7,
                time_ms: 1_500,
                strength_milli: 900,
            },
            SpectralLandmark {
                hash: (11_u64 << 16) | (20_u64 << 8) | 6,
                time_ms: 2_000,
                strength_milli: 800,
            },
        ];
        let quantized = quantize_landmarks_for_approximate_matching(&landmarks, 2, 2).unwrap();
        assert_eq!(quantized[0].hash, quantized[1].hash);
        assert_eq!(quantized[0].time_ms, 1_500);
        assert_eq!(quantized[1].strength_milli, 800);
    }

    fn spectral_frame(
        content_frame: usize,
        presentation_frame: usize,
        perturbation: u8,
    ) -> CoarseSpectralFingerprintFrame {
        let mut values = [0_u8; COARSE_SPECTRAL_FINGERPRINT_BANDS];
        let mut mixed = content_frame as u64 + 0x517c_c1b7;
        for (index, value) in values.iter_mut().enumerate() {
            mixed ^= mixed >> 12;
            mixed = mixed.wrapping_mul(0x9e37_79b9);
            *value = (((mixed >> (index % 8)) % 80) as u8)
                .saturating_add(10)
                .saturating_add(perturbation);
        }
        CoarseSpectralFingerprintFrame {
            time_ms: presentation_frame as i64 * 500,
            values,
            active_ratio_milli: 1_000,
            log_rms_milli: 6_000
                + (mixed % 3_000) as u16
                + u16::from(perturbation).saturating_mul(20),
        }
    }

    #[test]
    fn coarse_spectral_fingerprint_recovers_codec_perturbed_subsequence() {
        let source = (0..1_200)
            .map(|frame| spectral_frame(frame, frame, 0))
            .collect::<Vec<_>>();
        let target_start = 300_usize;
        let target = (0..360)
            .map(|frame| spectral_frame(target_start + frame, frame, 2))
            .collect::<Vec<_>>();
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.70,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 1_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };
        let result = match_spectral_fingerprints_approximately(
            &source,
            &target,
            (0, 600_000),
            (0, 180_000),
            &config,
            None,
        )
        .unwrap();
        assert!(!result.hypotheses.is_empty());
        assert!(
            result.hypotheses[0]
                .offset_ms
                .abs_diff(-(target_start as i64 * 500))
                <= 500
        );
        assert!(result.hypotheses[0].target_coverage >= 0.70);
        assert!(!result.hypotheses[0].held_out_anchors.is_empty());
    }

    #[test]
    fn coarse_spectral_fingerprint_recovers_short_source_inside_long_target() {
        let target = (0..1_200)
            .map(|frame| spectral_frame(frame, frame, 0))
            .collect::<Vec<_>>();
        let target_start = 300_usize;
        let source = (0..360)
            .map(|frame| spectral_frame(target_start + frame, frame, 2))
            .collect::<Vec<_>>();
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.70,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 1_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };

        let result = match_spectral_fingerprints_approximately(
            &source,
            &target,
            (0, 180_000),
            (0, 600_000),
            &config,
            None,
        )
        .unwrap();

        assert!(!result.hypotheses.is_empty());
        assert!(
            result.hypotheses[0]
                .offset_ms
                .abs_diff(target_start as i64 * 500)
                <= 500
        );
        assert!(result.hypotheses[0].target_coverage >= 0.70);
        assert!(result.hypotheses[0]
            .training_anchors
            .iter()
            .all(|anchor| anchor.source_time_ms < 180_000
                && anchor.target_time_ms >= target_start as i64 * 500));
        assert!(!result.hypotheses[0].held_out_anchors.is_empty());
    }

    #[test]
    fn default_query_retains_partial_episode_before_unrelated_tail_with_fine_support() {
        // 200 s of common content followed by 400 s of unrelated upload material.
        // Sampling once per minute supplied only three training blocks; a real
        // partial match must reach the fine solver without lowering its six-anchor gate.
        let target = (0..1800)
            .map(|frame| spectral_frame(frame, frame, 0))
            .collect::<Vec<_>>();
        let source = (0..1200)
            .map(|frame| {
                spectral_frame(
                    if frame < 400 {
                        1200 + frame
                    } else {
                        10000 + frame
                    },
                    frame,
                    2,
                )
            })
            .collect::<Vec<_>>();
        let result = match_spectral_fingerprints_approximately(
            &source,
            &target,
            (0, 600000),
            (0, 900000),
            &ApproximateFingerprintConfig::default(),
            None,
        )
        .unwrap();
        let matching = result
            .hypotheses
            .iter()
            .find(|h| h.offset_ms.abs_diff(600000) <= 500)
            .expect("partial common content must remain a candidate");
        assert!(
            matching.training_anchors.len() >= 6,
            "fine admission needs actual independent training blocks"
        );
        assert!(matching
            .training_anchors
            .iter()
            .all(|a| a.source_time_ms < 200000));
        assert!(matching
            .held_out_anchors
            .iter()
            .any(|a| a.residual_ms.abs() <= 500));
        assert!(result.query_block_count <= 32);
    }

    #[test]
    fn coarse_spectral_fingerprint_builds_monotonic_piecewise_islands_across_insertions() {
        let target = (0..720)
            .map(|frame| spectral_frame(frame, frame, 0))
            .collect::<Vec<_>>();
        let mut source = Vec::new();
        for frame in 0..240 {
            source.push(spectral_frame(frame, source.len(), 2));
        }
        for frame in 0..80 {
            source.push(spectral_frame(10_000 + frame, source.len(), 17));
        }
        for frame in 240..480 {
            source.push(spectral_frame(frame, source.len(), 2));
        }
        for frame in 0..100 {
            source.push(spectral_frame(20_000 + frame, source.len(), 23));
        }
        for frame in 480..720 {
            source.push(spectral_frame(frame, source.len(), 2));
        }
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            max_query_blocks: 64,
            min_block_score: 0.70,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 2_000,
            min_training_anchors: 5,
            max_hypotheses: 5,
            ..ApproximateFingerprintConfig::default()
        };

        let result = match_spectral_fingerprints_approximately(
            &source,
            &target,
            (0, source.len() as i64 * 500),
            (0, target.len() as i64 * 500),
            &config,
            None,
        )
        .unwrap();

        let piecewise = result
            .hypotheses
            .iter()
            .find(|hypothesis| hypothesis.offset_island_count >= 3)
            .expect("three ordered common-content islands");
        assert!(piecewise.training_anchors.len() >= 12);
        assert!(piecewise
            .training_anchors
            .windows(2)
            .all(|pair| pair[0].source_time_ms < pair[1].source_time_ms
                && pair[0].target_time_ms < pair[1].target_time_ms));
        let mut local_offsets = piecewise
            .training_anchors
            .iter()
            .map(|anchor| anchor.target_time_ms - anchor.source_time_ms - anchor.residual_ms)
            .collect::<Vec<_>>();
        local_offsets.sort_unstable();
        local_offsets.dedup();
        assert_eq!(local_offsets.len(), 3);
        let mut held_out_offsets = piecewise
            .held_out_anchors
            .iter()
            .map(|anchor| anchor.target_time_ms - anchor.source_time_ms - anchor.residual_ms)
            .collect::<Vec<_>>();
        held_out_offsets.sort_unstable();
        held_out_offsets.dedup();
        assert!(
            held_out_offsets.len() >= 3,
            "dense holdout must validate several independent islands: {held_out_offsets:?}"
        );
        assert!(
            piecewise.held_out_anchors.iter().all(|anchor| {
                anchor.residual_ms.unsigned_abs() <= config.inlier_tolerance_ms.unsigned_abs()
            }),
            "piecewise held-out residuals must remain island-local: {:?}",
            piecewise
                .held_out_anchors
                .iter()
                .map(|anchor| anchor.residual_ms)
                .collect::<Vec<_>>()
        );
        assert!(piecewise.target_coverage >= 0.80);
    }

    #[test]
    fn coarse_energy_envelope_disambiguates_codec_flattened_spectra() {
        let energy_frame = |content_frame: usize, presentation_frame: usize| {
            let mut mixed = content_frame as u64 + 0x6a09_e667_f3bc_c909;
            mixed ^= mixed >> 30;
            mixed = mixed.wrapping_mul(0xbf58_476d_1ce4_e5b9);
            mixed ^= mixed >> 27;
            mixed = mixed.wrapping_mul(0x94d0_49bb_1331_11eb);
            mixed ^= mixed >> 31;
            CoarseSpectralFingerprintFrame {
                time_ms: presentation_frame as i64 * 500,
                values: [32; COARSE_SPECTRAL_FINGERPRINT_BANDS],
                active_ratio_milli: 1_000,
                log_rms_milli: 5_000 + (mixed % 5_000) as u16,
            }
        };
        let target = (0..1_200)
            .map(|frame| energy_frame(frame, frame))
            .collect::<Vec<_>>();
        let target_start = 300_usize;
        let source = (0..360)
            .map(|frame| energy_frame(target_start + frame, frame))
            .collect::<Vec<_>>();
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.40,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 1_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };

        let result = match_spectral_fingerprints_approximately(
            &source,
            &target,
            (0, 180_000),
            (0, 600_000),
            &config,
            None,
        )
        .unwrap();

        assert!(
            !result.hypotheses.is_empty(),
            "energy-only result={result:#?}"
        );
        assert!(
            result.hypotheses[0]
                .offset_ms
                .abs_diff(target_start as i64 * 500)
                <= 500
        );
        assert!(result.hypotheses[0].training_anchors.len() >= 4);
    }

    #[test]
    fn coarse_energy_envelope_rejects_unrelated_flattened_spectra() {
        let energy_frame = |content_frame: usize, presentation_frame: usize, seed: u64| {
            let mut mixed = content_frame as u64 + seed;
            mixed ^= mixed >> 30;
            mixed = mixed.wrapping_mul(0xbf58_476d_1ce4_e5b9);
            mixed ^= mixed >> 27;
            mixed = mixed.wrapping_mul(0x94d0_49bb_1331_11eb);
            mixed ^= mixed >> 31;
            CoarseSpectralFingerprintFrame {
                time_ms: presentation_frame as i64 * 500,
                values: [32; COARSE_SPECTRAL_FINGERPRINT_BANDS],
                active_ratio_milli: 1_000,
                log_rms_milli: 5_000 + (mixed % 5_000) as u16,
            }
        };
        let target = (0..1_200)
            .map(|frame| energy_frame(frame, frame, 0x6a09_e667_f3bc_c909))
            .collect::<Vec<_>>();
        let source = (0..360)
            .map(|frame| energy_frame(frame, frame, 0xbb67_ae85_84ca_a73b))
            .collect::<Vec<_>>();
        let config = ApproximateFingerprintConfig {
            block_ms: 10_000,
            block_stride_ms: 20_000,
            min_block_score: 0.40,
            min_block_margin: 0.005,
            inlier_tolerance_ms: 1_000,
            min_training_anchors: 4,
            ..ApproximateFingerprintConfig::default()
        };

        let result = match_spectral_fingerprints_approximately(
            &source,
            &target,
            (0, 180_000),
            (0, 600_000),
            &config,
            None,
        )
        .unwrap();

        assert!(
            result.hypotheses.is_empty(),
            "unrelated energy must not form a stable offset: {result:#?}"
        );
    }
}
