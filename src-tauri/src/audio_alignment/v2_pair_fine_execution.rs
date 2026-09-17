//! Selected-pair fine execution.
//!
//! This module owns the selected fine decode and local boundary-refinement lifecycle. The parent
//! keeps batch/job progress and the later quality/evidence/proposal policy.

use std::sync::{atomic::AtomicBool, Arc};

#[cfg(test)]
use super::TEST_V2_PCM_DECODE_INVOCATIONS;
use super::{
    alignment_audio_content_identity_cache_fragment, audio_alignment_toolchain_cache_identity,
    check_v2_duration_limit, create_v2_audio_cache_key_for_backend, format_media_tool_nonzero_exit,
    parse_v2_pcm_output, pcm_decode, redact_sensitive_media_text, run_supervised_ffmpeg_output,
    v2_landmark_artifact_kind, v2_presentation_bounds_for_samples, v2_short_pcm_decode_budget,
    verify_media_content_identity_after_tool_output_or_pinned,
    verify_media_content_identity_before_tool_input_or_pinned, verify_v2_spectral_backend_policy,
    AlignmentAudioInput, AudioAlignmentOptions, AudioTimeMapBoundaryEvidenceDto,
    AudioTimeMapBoundaryStatus, AudioTimeMapSpanDto, AudioTimeMapSpanKind, CachedV2Landmarks,
    PinnedMediaIdentityGuard, ALIGNMENT_V2_FINE_HOP_MS,
    ALIGNMENT_V2_FINE_WINDOW_DECODE_TOLERANCE_MS, ALIGNMENT_V2_SAMPLE_RATE,
};
use super::{
    long_fine_alignment::BoundedFineAxisPlan,
    v2_audio_artifact_store::{v2_audio_artifact_store, V2AudioArtifactHandle as V2MediaArtifact},
    v2_fine_pcm_artifact_store::{
        v2_fine_pcm_artifact_store, V2FinePcmArtifactHandle, V2FinePcmArtifactKey,
        V2FinePcmArtifactLookup, V2FinePcmTimelineIdentity,
    },
    v2_pair_engine::{
        check_cancelled, format_v2_span_kind, is_v2_edit_span, should_stream_v2_coarse_only,
        solve_selected_fine_path, v2_fine_window_pcm_decode_budget,
        v2_presentation_range_duration_ms, validate_v2_time_map_spans, V2ChunkAlignment,
        V2SelectedFineDecodePlan, V2SelectedFinePathInput,
    },
};
use crate::alignment_v2::{
    extract_fine_features_with_backend_request, lock_fine_spectral_backend_request,
    refine_boundary_by_correlation_with_cancel,
    refine_boundary_by_one_sided_correlation_with_cancel, AffineFineDecodeWindows,
    AffineHypothesis, BoundaryContextSide, BoundaryRefinementConfig, FineFeatureConfig,
    FineFeatureFrame, PresentationRangeMs, SpectralBackendExecution,
};

#[derive(Debug)]
pub(super) struct DecodedV2Audio {
    pub(super) pcm: Arc<Vec<i16>>,
    pub(super) fine_features: Arc<Vec<FineFeatureFrame>>,
    pub(super) fine_spectral_backend: SpectralBackendExecution,
    pub(super) presentation_offset_ms: i64,
    pub(super) decoded_sample_count: u64,
    pub(super) pcm_covers_full_window: bool,
    pub(super) persistent_pcm_cache_hit: bool,
    pub(super) cache_persistence_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct V2FineExecutionRuntimeCapture {
    pub(super) source_fine_backend: SpectralBackendExecution,
    pub(super) target_fine_backend: SpectralBackendExecution,
    pub(super) source_presentation_offset_ms: i64,
    pub(super) target_presentation_offset_ms: i64,
    pub(super) source_decoded_sample_count: u64,
    pub(super) target_decoded_sample_count: u64,
    pub(super) decode_plan: Option<V2SelectedFineDecodePlan>,
}

impl V2FineExecutionRuntimeCapture {
    pub(super) fn from_decoded_pair(
        source: &DecodedV2Audio,
        target: &DecodedV2Audio,
        decode_plan: Option<V2SelectedFineDecodePlan>,
    ) -> Self {
        Self {
            source_fine_backend: source.fine_spectral_backend.clone(),
            target_fine_backend: target.fine_spectral_backend.clone(),
            source_presentation_offset_ms: source.presentation_offset_ms,
            target_presentation_offset_ms: target.presentation_offset_ms,
            source_decoded_sample_count: source.decoded_sample_count,
            target_decoded_sample_count: target.decoded_sample_count,
            decode_plan,
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct V2BoundarySummary {
    pub(super) attempted_count: usize,
    pub(super) refined_count: usize,
    pub(super) ambiguous_count: usize,
    pub(super) max_uncertainty_ms: Option<u64>,
    pub(super) evidence_notes: Vec<String>,
}

#[derive(Debug)]
pub(super) struct V2RefinedFineExecution {
    pub(super) alignment: V2ChunkAlignment,
    pub(super) boundary_summary: V2BoundarySummary,
}

pub(super) struct V2FineAxisDecodeRequest<'a> {
    pub(super) media_path: &'a str,
    pub(super) label: &'a str,
    pub(super) options: &'a AudioAlignmentOptions,
    pub(super) audio_input: &'a AlignmentAudioInput,
    pub(super) landmark_artifact: &'a CachedV2Landmarks,
    pub(super) axis_plan: Option<&'a BoundedFineAxisPlan>,
    pub(super) cancel_flag: Option<&'a AtomicBool>,
}

pub(super) struct V2SelectedFineSolveRequest<'a> {
    pub(super) source_audio: &'a DecodedV2Audio,
    pub(super) target_audio: &'a DecodedV2Audio,
    pub(super) content_intervals: AffineFineDecodeWindows,
    pub(super) selected_candidate_hypothesis: &'a AffineHypothesis,
    pub(super) max_dp_cells: usize,
    pub(super) active_artifact_bytes: usize,
    pub(super) cancel_flag: Option<&'a AtomicBool>,
}

pub(super) struct PreparedV2SelectedFinePath<'a> {
    source_frames: &'a [FineFeatureFrame],
    target_frames: &'a [FineFeatureFrame],
    selected_candidate_hypothesis: &'a AffineHypothesis,
    max_dp_cells: usize,
    active_artifact_bytes: usize,
    cancel_flag: Option<&'a AtomicBool>,
}

impl PreparedV2SelectedFinePath<'_> {
    pub(super) fn solve(self) -> Result<V2ChunkAlignment, String> {
        solve_selected_fine_path(V2SelectedFinePathInput {
            source_frames: self.source_frames,
            target_frames: self.target_frames,
            selected_candidate_hypothesis: self.selected_candidate_hypothesis,
            max_dp_cells: self.max_dp_cells,
            active_artifact_bytes: self.active_artifact_bytes,
            cancel_flag: self.cancel_flag,
        })
    }
}

pub(super) struct V2BoundaryRefinementRequest<'a> {
    pub(super) alignment: V2ChunkAlignment,
    pub(super) source_audio: &'a DecodedV2Audio,
    pub(super) target_audio: &'a DecodedV2Audio,
    pub(super) source_path: &'a str,
    pub(super) target_path: &'a str,
    pub(super) options: &'a AudioAlignmentOptions,
    pub(super) source_input: &'a AlignmentAudioInput,
    pub(super) target_input: &'a AlignmentAudioInput,
    pub(super) source_artifact: &'a CachedV2Landmarks,
    pub(super) target_artifact: &'a CachedV2Landmarks,
    pub(super) cancel_flag: Option<&'a AtomicBool>,
}

#[derive(Debug)]
struct DecodedV2PcmWindow {
    artifact: V2FinePcmArtifactHandle,
    cache_hit: bool,
    cache_persistence_error: Option<String>,
}

pub(super) fn decode_v2_audio(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    landmark_artifact: &CachedV2Landmarks,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedV2Audio, String> {
    check_v2_duration_limit(input, label)?;
    check_cancelled(cancel_flag)?;
    verify_v2_spectral_backend_policy(
        &landmark_artifact.spectral_backend,
        &options.spectral_backend_request,
    )?;
    let expected_cache_key = create_v2_audio_cache_key_for_backend(
        media_path,
        options,
        input,
        v2_landmark_artifact_kind(input),
        &landmark_artifact.spectral_backend.backend_id,
    )?;
    if landmark_artifact.cache_key != expected_cache_key {
        return Err(format!(
            "blocked:media-identity-changed：{label}粗定位制品与当前内容身份、音轨、PTS 或算法参数不一致。"
        ));
    }
    // Cache hits never replace the run-level final identity gate. Recheck before the
    // retained PCM is consumed so stale bytes cannot drive expensive DP work.
    verify_media_content_identity_after_tool_output_or_pinned(
        landmark_artifact.identity_guard.as_deref(),
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 PCM/细特征复用",
    )?;
    if let Some(fine_features) = landmark_artifact.fine_features.clone() {
        if fine_features.is_empty() {
            return Err(format!("{label}没有可用的 50 ms 细粒度音频特征。"));
        }
        let pcm = landmark_artifact.pcm.clone().ok_or_else(|| {
            "blocked:artifact-missing：细特征制品缺少对应的完整 PCM。".to_string()
        })?;
        // Short-media preparation computes coarse landmarks and fine features in one physical
        // extraction. The fine execution receipt still uses the same canonical lock identity as
        // separately materialized fine windows, so evidence is independent of this cache shape.
        let fine_backend_request =
            lock_fine_spectral_backend_request(&landmark_artifact.spectral_backend)?;
        return Ok(DecodedV2Audio {
            decoded_sample_count: u64::try_from(pcm.len())
                .map_err(|_| "short fine decoded sample count 无法表示。".to_string())?,
            pcm,
            fine_features,
            fine_spectral_backend: SpectralBackendExecution {
                backend_id: fine_backend_request.planned_backend_id,
                requested_backend: fine_backend_request.requested_backend,
                backend_detail: fine_backend_request.backend_detail,
                fallback_reason: fine_backend_request.fallback_reason,
            },
            presentation_offset_ms: landmark_artifact.presentation_bounds.start_ms,
            pcm_covers_full_window: true,
            persistent_pcm_cache_hit: false,
            cache_persistence_error: None,
        });
    }

    let pcm = match landmark_artifact.pcm.clone() {
        Some(pcm) => pcm,
        None => Arc::new(decode_v2_pcm(
            media_path,
            label,
            options,
            input,
            cancel_flag,
            landmark_artifact.identity_guard.as_deref(),
        )?),
    };
    let fine_backend_request =
        lock_fine_spectral_backend_request(&landmark_artifact.spectral_backend)?;
    let fine_extraction = extract_fine_features_with_backend_request(
        &pcm,
        &FineFeatureConfig {
            sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
            presentation_offset_ms: landmark_artifact.presentation_bounds.start_ms,
            window_ms: 50,
            hop_ms: ALIGNMENT_V2_FINE_HOP_MS,
        },
        cancel_flag,
        &fine_backend_request,
    )?;
    ensure_v2_fine_spectral_backend_continuity(
        &landmark_artifact.spectral_backend,
        &fine_extraction.spectral_backend,
    )?;
    let fine_features = Arc::new(fine_extraction.fine_features);
    if fine_features.is_empty() {
        return Err(format!("{label}没有可用的 50 ms 细粒度音频特征。"));
    }
    // As with landmark extraction, do not let cancellation race a cache publication.
    check_cancelled(cancel_flag)?;
    let artifact = V2MediaArtifact {
        pcm: Some(pcm.clone()),
        landmarks: landmark_artifact.landmarks.clone(),
        coarse_fingerprint: landmark_artifact.coarse_fingerprint.clone(),
        fine_features: Some(fine_features.clone()),
        // The cache key and persisted coarse artifact are bound to the coarse backend. Fine may
        // use the locked compatible CPU backend after streaming CPU coarse, so retaining the
        // fine backend here would make the next coarse lookup self-inconsistent.
        spectral_backend: landmark_artifact.spectral_backend.clone(),
        presentation_bounds: landmark_artifact.presentation_bounds,
    };
    // Enriching an existing landmark/PCM entry with fine features is an in-place cache
    // upgrade, not another benchmark write. If the entry was evicted meanwhile, its
    // reintroduction is correctly observable as a new write.
    v2_audio_artifact_store().enrich_memory(expected_cache_key, artifact, cancel_flag)?;
    Ok(DecodedV2Audio {
        decoded_sample_count: u64::try_from(pcm.len())
            .map_err(|_| "short fine decoded sample count 无法表示。".to_string())?,
        pcm,
        fine_features,
        fine_spectral_backend: fine_extraction.spectral_backend,
        presentation_offset_ms: landmark_artifact.presentation_bounds.start_ms,
        pcm_covers_full_window: true,
        persistent_pcm_cache_hit: false,
        cache_persistence_error: None,
    })
}

fn ensure_v2_fine_spectral_backend_continuity(
    coarse_backend: &SpectralBackendExecution,
    fine_backend: &SpectralBackendExecution,
) -> Result<(), String> {
    let locked = lock_fine_spectral_backend_request(coarse_backend)?;
    if fine_backend.backend_id != locked.planned_backend_id {
        return Err(format!(
            "blocked:spectral-backend-continuity：coarse 后端 {} 锁定 fine 后端 {}，实际却由 {} 完成。",
            coarse_backend.backend_id, locked.planned_backend_id, fine_backend.backend_id
        ));
    }
    Ok(())
}

fn create_v2_fine_pcm_cache_key(
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    media_bounds: PresentationRangeMs,
    window: PresentationRangeMs,
) -> Result<V2FinePcmArtifactKey, String> {
    let toolchain = audio_alignment_toolchain_cache_identity(options)?;
    let content_identity = alignment_audio_content_identity_cache_fragment(input)?;
    let stream_identity = serde_json::to_string(&input.stream)
        .map_err(|error| format!("无法序列化 fine PCM 音轨身份：{error}"))?;
    let timeline = input.decode_timeline.as_ref();
    let pcm_decode_identity = pcm_decode::cache_identity(timeline)?;
    Ok(V2FinePcmArtifactKey::current(
        &pcm_decode_identity,
        window,
        media_bounds,
        &stream_identity,
        V2FinePcmTimelineIdentity {
            presentation_origin_ms: input.presentation_origin_ms,
            first_decoded_pts_ms: timeline.and_then(|item| item.first_decoded_pts_ms),
            pts_discontinuity_count: timeline
                .map(|item| item.pts_discontinuity_count)
                .unwrap_or(0),
            max_pts_gap_ms: timeline.and_then(|item| item.max_pts_gap_ms),
            skip_samples: timeline.map(|item| item.skip_samples).unwrap_or(0),
            discard_padding: timeline.map(|item| item.discard_padding).unwrap_or(0),
            normalized_pcm_origin_ms: timeline
                .map(|item| item.normalized_pcm_origin_ms)
                .unwrap_or(0),
        },
        &content_identity,
        &toolchain,
    ))
}

pub(super) fn decode_v2_audio_for_selected_window(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    landmark_artifact: &CachedV2Landmarks,
    requested_window: Option<PresentationRangeMs>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedV2Audio, String> {
    if !should_stream_v2_coarse_only(input) {
        return decode_v2_audio(
            media_path,
            label,
            options,
            input,
            landmark_artifact,
            cancel_flag,
        );
    }
    let window = requested_window.ok_or_else(|| {
        format!(
            "blocked:window-evidence-insufficient：{label}只有流式粗定位制品，但没有经过 affine 证明的精解码窗口。"
        )
    })?;
    if window.start_ms < landmark_artifact.presentation_bounds.start_ms
        || window.end_ms > landmark_artifact.presentation_bounds.end_ms
    {
        return Err(format!(
            "blocked:window-evidence-insufficient：{label}精解码窗口超出已完整消费的流式 presentation 边界。"
        ));
    }
    let expected_cache_key = create_v2_audio_cache_key_for_backend(
        media_path,
        options,
        input,
        v2_landmark_artifact_kind(input),
        &landmark_artifact.spectral_backend.backend_id,
    )?;
    if landmark_artifact.cache_key != expected_cache_key {
        return Err(format!(
            "blocked:media-identity-changed：{label}粗定位制品与当前内容身份、音轨、PTS 或算法参数不一致。"
        ));
    }
    let decoded_pcm = decode_v2_pcm_window(
        media_path,
        label,
        options,
        input,
        landmark_artifact.presentation_bounds,
        window,
        cancel_flag,
        landmark_artifact.identity_guard.as_deref(),
    )?;
    let pcm = decoded_pcm.artifact.into_shared_pcm();
    let fine_backend_request =
        lock_fine_spectral_backend_request(&landmark_artifact.spectral_backend)?;
    let fine_extraction = extract_fine_features_with_backend_request(
        &pcm,
        &FineFeatureConfig {
            sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
            // FFmpeg rebases the input-side seek to zero. Reattach every fine frame to the
            // absolute presentation axis here; downstream DP and TimeMap never see seek time.
            presentation_offset_ms: window.start_ms,
            window_ms: 50,
            hop_ms: ALIGNMENT_V2_FINE_HOP_MS,
        },
        cancel_flag,
        &fine_backend_request,
    )?;
    ensure_v2_fine_spectral_backend_continuity(
        &landmark_artifact.spectral_backend,
        &fine_extraction.spectral_backend,
    )?;
    let fine_features = Arc::new(fine_extraction.fine_features);
    if fine_features.is_empty() {
        return Err(format!(
            "{label}精解码窗口没有可用的 50 ms 细粒度音频特征。"
        ));
    }
    Ok(DecodedV2Audio {
        decoded_sample_count: u64::try_from(pcm.len())
            .map_err(|_| "fine decoded sample count 无法表示。".to_string())?,
        pcm,
        fine_features,
        fine_spectral_backend: fine_extraction.spectral_backend,
        presentation_offset_ms: window.start_ms,
        pcm_covers_full_window: true,
        persistent_pcm_cache_hit: decoded_pcm.cache_hit,
        cache_persistence_error: decoded_pcm.cache_persistence_error,
    })
}

#[allow(clippy::too_many_arguments)]
fn decode_v2_audio_for_selected_axis_plan(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    landmark_artifact: &CachedV2Landmarks,
    axis_plan: Option<&BoundedFineAxisPlan>,
    cancel_flag: Option<&AtomicBool>,
) -> Result<DecodedV2Audio, String> {
    let requested_window = axis_plan.map(|plan| plan.full_window);
    let Some(axis_plan) = axis_plan.filter(|plan| should_tile_v2_selected_axis(input, plan)) else {
        return decode_v2_audio_for_selected_window(
            media_path,
            label,
            options,
            input,
            landmark_artifact,
            requested_window,
            cancel_flag,
        );
    };

    let mut fine_features = Vec::<FineFeatureFrame>::new();
    let mut fine_backend = None::<SpectralBackendExecution>;
    let mut all_tiles_cache_hit = true;
    let mut cache_errors = Vec::<String>::new();
    for (tile_index, tile) in axis_plan.tiles.iter().enumerate() {
        check_cancelled(cancel_flag)?;
        let decoded = decode_v2_audio_for_selected_window(
            media_path,
            label,
            options,
            input,
            landmark_artifact,
            Some(*tile),
            cancel_flag,
        )?;
        if let Some(existing) = &fine_backend {
            if existing.backend_id != decoded.fine_spectral_backend.backend_id
                || existing.requested_backend != decoded.fine_spectral_backend.requested_backend
            {
                return Err(format!(
                    "blocked:spectral-backend-continuity：{label} long fine tile #{} 的声谱后端发生漂移。",
                    tile_index + 1
                ));
            }
        } else {
            fine_backend = Some(decoded.fine_spectral_backend.clone());
        }
        all_tiles_cache_hit &= decoded.persistent_pcm_cache_hit;
        if let Some(error) = decoded.cache_persistence_error {
            cache_errors.push(format!("tile #{}：{error}", tile_index + 1));
        }
        fine_features.extend(decoded.fine_features.iter().cloned());
        // `decoded` is dropped here. Its reversible PCM and FFmpeg output therefore never
        // accumulate across tiles; only the compact irreversible feature frames survive.
    }

    fine_features.sort_by_key(|frame| frame.time_ms);
    fine_features.dedup_by_key(|frame| frame.time_ms);
    fine_features.retain(|frame| {
        frame.time_ms >= axis_plan.full_window.start_ms
            && frame.time_ms < axis_plan.full_window.end_ms
    });
    if fine_features.is_empty() {
        return Err(format!(
            "{label} long fine tile 合并后没有可用的 50 ms 细粒度特征。"
        ));
    }
    let duration_ms = v2_presentation_range_duration_ms(axis_plan.full_window)?;
    let decoded_sample_count = u64::try_from(
        (u128::from(duration_ms) * u128::from(ALIGNMENT_V2_SAMPLE_RATE)).div_ceil(1_000),
    )
    .map_err(|_| "blocked:resource-limit：long fine 样本总数无法表示。".to_string())?;

    Ok(DecodedV2Audio {
        pcm: Arc::new(Vec::new()),
        fine_features: Arc::new(fine_features),
        fine_spectral_backend: fine_backend
            .ok_or_else(|| "long fine tile 没有形成声谱后端证据。".to_string())?,
        presentation_offset_ms: axis_plan.full_window.start_ms,
        decoded_sample_count,
        pcm_covers_full_window: false,
        persistent_pcm_cache_hit: all_tiles_cache_hit,
        cache_persistence_error: (!cache_errors.is_empty()).then(|| cache_errors.join("；")),
    })
}

pub(super) fn decode_selected_fine_axis(
    request: V2FineAxisDecodeRequest<'_>,
) -> Result<DecodedV2Audio, String> {
    decode_v2_audio_for_selected_axis_plan(
        request.media_path,
        request.label,
        request.options,
        request.audio_input,
        request.landmark_artifact,
        request.axis_plan,
        request.cancel_flag,
    )
}

pub(super) fn should_tile_v2_selected_axis(
    input: &AlignmentAudioInput,
    axis_plan: &BoundedFineAxisPlan,
) -> bool {
    should_stream_v2_coarse_only(input) && axis_plan.tiles.len() > 1
}

// A fine-window decode is a trust boundary: media bounds, the selected window and the pinned
// identity guard must remain explicit instead of being hidden in a loosely reusable context.
#[allow(clippy::too_many_arguments)]
fn decode_v2_pcm_window(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    media_bounds: PresentationRangeMs,
    window: PresentationRangeMs,
    cancel_flag: Option<&AtomicBool>,
    identity_guard: Option<&PinnedMediaIdentityGuard>,
) -> Result<DecodedV2PcmWindow, String> {
    check_cancelled(cancel_flag)?;
    let duration_ms = v2_presentation_range_duration_ms(window)?;
    let decode_budget = v2_fine_window_pcm_decode_budget(window)?;
    let seek_ms = window
        .start_ms
        .checked_sub(media_bounds.start_ms)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| {
            format!("blocked:window-evidence-insufficient：{label}精解码 seek 早于媒体 PCM 起点。")
        })?;
    verify_media_content_identity_before_tool_input_or_pinned(
        identity_guard,
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 affine 窗口精解码",
    )?;
    let cache_key = create_v2_fine_pcm_cache_key(options, input, media_bounds, window)?;
    if let V2FinePcmArtifactLookup::Hit(hit) =
        v2_fine_pcm_artifact_store().lookup(&cache_key, window)
    {
        verify_media_content_identity_after_tool_output_or_pinned(
            identity_guard,
            media_path,
            input.content_identity.as_ref(),
            cancel_flag,
            "V2 fine PCM 磁盘缓存复用",
        )?;
        return Ok(DecodedV2PcmWindow {
            artifact: hit.confirm(),
            cache_hit: true,
            cache_persistence_error: None,
        });
    }
    let output_result = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        pcm_decode::window_audio_args(
            media_path,
            input.stream.stream_index,
            ALIGNMENT_V2_SAMPLE_RATE,
            input.decode_timeline.as_ref(),
            seek_ms,
            duration_ms,
        )?,
        "FFmpeg V2 affine 窗口精解码",
        decode_budget.stdout_hard_limit_bytes,
        cancel_flag,
    );
    // As in streaming coarse, identity/cleanup failure invalidates every decoded byte and takes
    // precedence over an ordinary codec failure.
    verify_media_content_identity_after_tool_output_or_pinned(
        identity_guard,
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 affine 窗口精解码",
    )?;
    let output = output_result?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            &format!("FFmpeg 提取 {label} V2 affine 窗口 PCM"),
            output.status.code(),
            &output.stderr,
        ));
    }
    let mut pcm = parse_v2_pcm_output(
        &output.stdout,
        label,
        decode_budget.stdout_hard_limit_bytes,
        cancel_flag,
    )?;
    let actual_duration_ms =
        v2_presentation_range_duration_ms(v2_presentation_bounds_for_samples(
            window.start_ms,
            u64::try_from(pcm.len())
                .map_err(|_| "blocked:resource-limit：精解码 PCM 样本数无法表示。".to_string())?,
        )?)?;
    if actual_duration_ms.saturating_add(ALIGNMENT_V2_FINE_WINDOW_DECODE_TOLERANCE_MS) < duration_ms
    {
        return Err(format!(
            "blocked:decode-window-short：{label}请求 {duration_ms} ms 精解码窗口，但受监督 FFmpeg 只返回 {actual_duration_ms} ms；不会用缺失尾部生成时间图。"
        ));
    }
    let maximum_samples = usize::try_from(
        (u128::from(duration_ms) * u128::from(ALIGNMENT_V2_SAMPLE_RATE)).div_ceil(1_000),
    )
    .map_err(|_| "blocked:resource-limit：精解码样本上限无法表示。".to_string())?;
    pcm.truncate(maximum_samples);
    check_cancelled(cancel_flag)?;
    let publication = v2_fine_pcm_artifact_store().publish(cache_key, window, pcm);
    Ok(DecodedV2PcmWindow {
        artifact: publication.artifact,
        cache_hit: false,
        cache_persistence_error: publication.persistence_error,
    })
}

pub(super) fn decode_v2_pcm(
    media_path: &str,
    label: &str,
    options: &AudioAlignmentOptions,
    input: &AlignmentAudioInput,
    cancel_flag: Option<&AtomicBool>,
    identity_guard: Option<&PinnedMediaIdentityGuard>,
) -> Result<Vec<i16>, String> {
    check_cancelled(cancel_flag)?;
    let decode_budget = v2_short_pcm_decode_budget(input)?;
    #[cfg(test)]
    TEST_V2_PCM_DECODE_INVOCATIONS.with(|count| count.set(count.get().saturating_add(1)));
    let output = run_supervised_ffmpeg_output(
        &options.ffmpeg_path,
        pcm_decode::complete_audio_args(
            media_path,
            input.stream.stream_index,
            ALIGNMENT_V2_SAMPLE_RATE,
            input.decode_timeline.as_ref(),
        )?,
        "FFmpeg V2 音频解码",
        decode_budget.stdout_hard_limit_bytes,
        cancel_flag,
    )?;
    if !output.status.success() {
        return Err(format_media_tool_nonzero_exit(
            &format!("FFmpeg 提取 {label} V2 PCM"),
            output.status.code(),
            &output.stderr,
        ));
    }
    verify_media_content_identity_after_tool_output_or_pinned(
        identity_guard,
        media_path,
        input.content_identity.as_ref(),
        cancel_flag,
        "V2 音频解码",
    )?;
    parse_v2_pcm_output(
        &output.stdout,
        label,
        decode_budget.stdout_hard_limit_bytes,
        cancel_flag,
    )
}

#[cfg(test)]
pub(super) fn reset_test_v2_pcm_decode_invocations() {
    TEST_V2_PCM_DECODE_INVOCATIONS.with(|count| count.set(0));
}

#[cfg(test)]
pub(super) fn test_v2_pcm_decode_invocations() -> u64 {
    TEST_V2_PCM_DECODE_INVOCATIONS.with(std::cell::Cell::get)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn refine_v2_span_boundaries(
    spans: &mut [AudioTimeMapSpanDto],
    source_pcm: &[i16],
    target_pcm: &[i16],
    source_presentation_offset_ms: i64,
    target_presentation_offset_ms: i64,
    cancel_flag: Option<&AtomicBool>,
) -> V2BoundarySummary {
    let mut summary = V2BoundarySummary::default();
    let mut edit_side_refined = vec![[false; 2]; spans.len()];
    let mut non_edit_ambiguity_count = 0usize;
    for boundary_index in 1..spans.len() {
        if check_cancelled(cancel_flag).is_err() {
            return summary;
        }
        let left = &spans[boundary_index - 1];
        let right = &spans[boundary_index];
        if left.kind == AudioTimeMapSpanKind::Ambiguous
            || right.kind == AudioTimeMapSpanKind::Ambiguous
        {
            non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            continue;
        }
        let left_is_edit = is_v2_edit_span(left.kind);
        let right_is_edit = is_v2_edit_span(right.kind);
        if left_is_edit && right_is_edit {
            summary.evidence_notes.push(format!(
                "删减边界 #{} 两侧都是单轴内容，缺少共同音频上下文，不能精修。",
                boundary_index
            ));
            continue;
        }
        let Ok(source_boundary_ms) = i64::try_from(left.source_end_ms) else {
            non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            continue;
        };
        let Ok(target_boundary_ms) = i64::try_from(left.target_end_ms) else {
            non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            continue;
        };
        summary.attempted_count += 1;
        let edit_context = if right_is_edit {
            Some((
                boundary_index,
                0usize,
                right.kind,
                BoundaryContextSide::Before,
            ))
        } else if left_is_edit {
            Some((
                boundary_index - 1,
                1usize,
                left.kind,
                BoundaryContextSide::After,
            ))
        } else {
            None
        };
        let result = match edit_context {
            Some((_, _, AudioTimeMapSpanKind::SourceOnly, context_side)) => {
                // Swap the axes: target content is the fixed reference and the source boundary
                // is searched. This is the symmetric operation that the old implementation
                // lacked for sourceOnly edits.
                refine_v2_boundary_multiscale(
                    target_pcm,
                    source_pcm,
                    target_boundary_ms,
                    source_boundary_ms,
                    Some(context_side),
                    target_presentation_offset_ms,
                    source_presentation_offset_ms,
                    cancel_flag,
                )
            }
            Some((_, _, AudioTimeMapSpanKind::TargetOnly, context_side)) => {
                refine_v2_boundary_multiscale(
                    source_pcm,
                    target_pcm,
                    source_boundary_ms,
                    target_boundary_ms,
                    Some(context_side),
                    source_presentation_offset_ms,
                    target_presentation_offset_ms,
                    cancel_flag,
                )
            }
            Some(_) => unreachable!("edit_context only contains single-axis spans"),
            None => refine_v2_boundary_multiscale(
                source_pcm,
                target_pcm,
                source_boundary_ms,
                target_boundary_ms,
                None,
                source_presentation_offset_ms,
                target_presentation_offset_ms,
                cancel_flag,
            ),
        };
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if let Some((edit_index, _, edit_kind, context_side)) = edit_context {
                    let side_index = usize::from(context_side == BoundaryContextSide::After);
                    let support_duration_ms =
                        v2_adjacent_common_support_ms(spans, edit_index, side_index);
                    let boundary = v2_span_boundary_mut(&mut spans[edit_index], side_index);
                    boundary.status = AudioTimeMapBoundaryStatus::Unsupported;
                    boundary.context_side = Some(v2_context_side_value(context_side));
                    boundary.support_duration_ms = support_duration_ms;
                    boundary.reason = format!(
                        "单侧共同音频相关无法形成有效窗口：{}",
                        redact_sensitive_media_text(&error)
                    );
                    summary.evidence_notes.push(format!(
                        "{} span #{} 的{}边界精修失败：{}",
                        format_v2_span_kind(edit_kind),
                        edit_index + 1,
                        format_v2_context_side(context_side),
                        redact_sensitive_media_text(&error)
                    ));
                } else {
                    non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
                }
                continue;
            }
        };
        summary.max_uncertainty_ms = Some(
            summary
                .max_uncertainty_ms
                .unwrap_or(0)
                .max(result.uncertainty_ms.max(0) as u64),
        );
        if result.ambiguous {
            if let Some((edit_index, _, edit_kind, context_side)) = edit_context {
                let side_index = usize::from(context_side == BoundaryContextSide::After);
                let support_duration_ms =
                    v2_adjacent_common_support_ms(spans, edit_index, side_index);
                let boundary = v2_span_boundary_mut(&mut spans[edit_index], side_index);
                populate_v2_boundary_measurement(
                    boundary,
                    AudioTimeMapBoundaryStatus::Ambiguous,
                    context_side,
                    &result,
                    support_duration_ms,
                    "局部相关峰不唯一、相关不足或不确定区间过宽，粗边界仍未确认。",
                );
                summary.evidence_notes.push(format!(
                    "{} span #{} 的{}边界存在多个相关峰：corr {:.3}，margin {:.3}，候选范围 [{}，{}] ms。",
                    format_v2_span_kind(edit_kind),
                    edit_index + 1,
                    format_v2_context_side(context_side),
                    result.best_correlation,
                    result.alternative_margin,
                    result.uncertainty_start_ms,
                    result.uncertainty_end_ms
                ));
            } else {
                non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            }
            continue;
        }
        let Ok(refined_axis_ms) = u64::try_from(result.refined_target_boundary_ms) else {
            if edit_context.is_none() {
                non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            }
            continue;
        };
        let refine_source_axis =
            edit_context.is_some_and(|(_, _, kind, _)| kind == AudioTimeMapSpanKind::SourceOnly);
        let (old_left_end, old_right_start) = if refine_source_axis {
            let old = (
                spans[boundary_index - 1].source_end_ms,
                spans[boundary_index].source_start_ms,
            );
            spans[boundary_index - 1].source_end_ms = refined_axis_ms;
            spans[boundary_index].source_start_ms = refined_axis_ms;
            old
        } else {
            let old = (
                spans[boundary_index - 1].target_end_ms,
                spans[boundary_index].target_start_ms,
            );
            spans[boundary_index - 1].target_end_ms = refined_axis_ms;
            spans[boundary_index].target_start_ms = refined_axis_ms;
            old
        };
        if validate_v2_time_map_spans(spans).is_ok() {
            summary.refined_count += 1;
            if let Some((edit_index, edit_side, edit_kind, context_side)) = edit_context {
                edit_side_refined[edit_index][edit_side] = true;
                let support_duration_ms =
                    v2_adjacent_common_support_ms(spans, edit_index, edit_side);
                let boundary = v2_span_boundary_mut(&mut spans[edit_index], edit_side);
                populate_v2_boundary_measurement(
                    boundary,
                    AudioTimeMapBoundaryStatus::Refined,
                    context_side,
                    &result,
                    support_duration_ms,
                    "局部单侧共同音频相关峰唯一且稳定，已更新该版本差异边界。",
                );
                summary.evidence_notes.push(format!(
                    "{} span #{} 的{}边界已用{}单侧共同音频精修：{} -> {} ms，不确定范围 [{}，{}] ms（corr {:.3}，margin {:.3}）。",
                    format_v2_span_kind(edit_kind),
                    edit_index + 1,
                    if edit_side == 0 { "起始" } else { "结束" },
                    format_v2_context_side(context_side),
                    result.coarse_target_boundary_ms,
                    result.refined_target_boundary_ms,
                    result.uncertainty_start_ms,
                    result.uncertainty_end_ms,
                    result.best_correlation,
                    result.alternative_margin
                ));
            }
        } else {
            if refine_source_axis {
                spans[boundary_index - 1].source_end_ms = old_left_end;
                spans[boundary_index].source_start_ms = old_right_start;
            } else {
                spans[boundary_index - 1].target_end_ms = old_left_end;
                spans[boundary_index].target_start_ms = old_right_start;
            }
            if edit_context.is_none() {
                non_edit_ambiguity_count = non_edit_ambiguity_count.saturating_add(1);
            }
        }
    }
    for (span_index, span) in spans.iter().enumerate() {
        if !is_v2_edit_span(span.kind) {
            continue;
        }
        for (side_index, refined) in edit_side_refined[span_index].iter().enumerate() {
            if !refined {
                summary.ambiguous_count = summary.ambiguous_count.saturating_add(1);
                summary.evidence_notes.push(format!(
                    "{} span #{} 缺少可靠的{}侧共同音频边界证据；不会把粗 DP 边界冒充精确时间。",
                    format_v2_span_kind(span.kind),
                    span_index + 1,
                    if side_index == 0 {
                        "删减前"
                    } else {
                        "删减后"
                    }
                ));
            }
        }
    }
    summary.ambiguous_count = summary
        .ambiguous_count
        .saturating_add(non_edit_ambiguity_count);
    if summary.max_uncertainty_ms.is_none() && !spans.iter().any(|span| is_v2_edit_span(span.kind))
    {
        summary.max_uncertainty_ms = Some(0);
    }
    summary
}

fn v2_span_boundary_mut(
    span: &mut AudioTimeMapSpanDto,
    side_index: usize,
) -> &mut AudioTimeMapBoundaryEvidenceDto {
    if side_index == 0 {
        &mut span.boundaries.start
    } else {
        &mut span.boundaries.end
    }
}

fn populate_v2_boundary_measurement(
    boundary: &mut AudioTimeMapBoundaryEvidenceDto,
    status: AudioTimeMapBoundaryStatus,
    context_side: BoundaryContextSide,
    result: &crate::alignment_v2::BoundaryRefinementResult,
    support_duration_ms: u64,
    reason: &str,
) {
    boundary.status = status;
    boundary.context_side = Some(v2_context_side_value(context_side));
    boundary.coarse_ms = u64::try_from(result.coarse_target_boundary_ms).ok();
    boundary.refined_ms = u64::try_from(result.refined_target_boundary_ms).ok();
    boundary.uncertainty_start_ms = u64::try_from(result.uncertainty_start_ms).ok();
    boundary.uncertainty_end_ms = u64::try_from(result.uncertainty_end_ms).ok();
    boundary.support_duration_ms = support_duration_ms;
    boundary.correlation = Some(result.best_correlation);
    boundary.alternative_margin = Some(result.alternative_margin);
    boundary.reason = reason.to_string();
}

fn v2_adjacent_common_support_ms(
    spans: &[AudioTimeMapSpanDto],
    edit_index: usize,
    side_index: usize,
) -> u64 {
    let adjacent = if side_index == 0 {
        edit_index.checked_sub(1).and_then(|index| spans.get(index))
    } else {
        spans.get(edit_index.saturating_add(1))
    };
    let Some(adjacent) = adjacent.filter(|span| span.kind == AudioTimeMapSpanKind::Matched) else {
        return 0;
    };
    adjacent
        .source_end_ms
        .saturating_sub(adjacent.source_start_ms)
        .min(
            adjacent
                .target_end_ms
                .saturating_sub(adjacent.target_start_ms),
        )
        .min(10_000)
}

fn v2_context_side_value(side: BoundaryContextSide) -> &'static str {
    match side {
        BoundaryContextSide::Before => "before",
        BoundaryContextSide::After => "after",
    }
}

#[allow(clippy::too_many_arguments)]
fn refine_v2_boundary_multiscale(
    fixed_pcm: &[i16],
    searched_pcm: &[i16],
    fixed_boundary_ms: i64,
    coarse_searched_boundary_ms: i64,
    context_side: Option<BoundaryContextSide>,
    fixed_presentation_offset_ms: i64,
    searched_presentation_offset_ms: i64,
    cancel_flag: Option<&AtomicBool>,
) -> Result<crate::alignment_v2::BoundaryRefinementResult, String> {
    let mut center_ms = coarse_searched_boundary_ms;
    let mut last_success = None;
    let mut last_error = None;
    for (
        search_radius_ms,
        search_step_ms,
        window_ms,
        min_correlation,
        min_margin,
        max_uncertainty_ms,
    ) in [
        (30_000, 50, 600, 0.20, 0.000_5, 5_000),
        (5_000, 10, 450, 0.35, 0.002, 800),
        (500, 1, 300, 0.50, 0.005, 150),
    ] {
        check_cancelled(cancel_flag)?;
        let config = BoundaryRefinementConfig {
            sample_rate: ALIGNMENT_V2_SAMPLE_RATE,
            source_presentation_offset_ms: fixed_presentation_offset_ms,
            target_presentation_offset_ms: searched_presentation_offset_ms,
            search_radius_ms,
            search_step_ms,
            window_ms,
            score_tolerance: if search_step_ms == 1 { 0.01 } else { 0.02 },
            min_correlation,
            min_alternative_margin: min_margin,
            max_uncertainty_ms,
        };
        let result = if let Some(context_side) = context_side {
            refine_boundary_by_one_sided_correlation_with_cancel(
                fixed_pcm,
                searched_pcm,
                fixed_boundary_ms,
                center_ms,
                context_side,
                &config,
                cancel_flag,
            )
        } else {
            refine_boundary_by_correlation_with_cancel(
                fixed_pcm,
                searched_pcm,
                fixed_boundary_ms,
                center_ms,
                &config,
                cancel_flag,
            )
        };
        match result {
            Ok(result) => {
                center_ms = result.refined_target_boundary_ms;
                last_success = Some(result);
            }
            Err(error) => last_error = Some(error),
        }
    }
    let mut result = last_success
        .ok_or_else(|| last_error.unwrap_or_else(|| "多尺度边界搜索没有产生候选。".to_string()))?;
    result.coarse_target_boundary_ms = coarse_searched_boundary_ms;
    result.shift_ms = result
        .refined_target_boundary_ms
        .saturating_sub(coarse_searched_boundary_ms);
    Ok(result)
}

fn format_v2_context_side(side: BoundaryContextSide) -> &'static str {
    match side {
        BoundaryContextSide::Before => "删减前",
        BoundaryContextSide::After => "删减后",
    }
}

#[allow(clippy::too_many_arguments)]
fn refine_v2_span_boundaries_for_decoded_audio(
    spans: &mut [AudioTimeMapSpanDto],
    source_audio: &DecodedV2Audio,
    target_audio: &DecodedV2Audio,
    source_path: &str,
    target_path: &str,
    options: &AudioAlignmentOptions,
    source_input: &AlignmentAudioInput,
    target_input: &AlignmentAudioInput,
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
    cancel_flag: Option<&AtomicBool>,
) -> Result<V2BoundarySummary, String> {
    if source_audio.pcm_covers_full_window && target_audio.pcm_covers_full_window {
        return Ok(refine_v2_span_boundaries(
            spans,
            &source_audio.pcm,
            &target_audio.pcm,
            source_audio.presentation_offset_ms,
            target_audio.presentation_offset_ms,
            cancel_flag,
        ));
    }

    let mut aggregate = V2BoundarySummary::default();
    for boundary_index in 1..spans.len() {
        check_cancelled(cancel_flag)?;
        let source_boundary_ms = i64::try_from(spans[boundary_index - 1].source_end_ms)
            .map_err(|_| "long fine source 边界无法表示。".to_string())?;
        let target_boundary_ms = i64::try_from(spans[boundary_index - 1].target_end_ms)
            .map_err(|_| "long fine target 边界无法表示。".to_string())?;
        let source_window = v2_local_boundary_decode_window(
            source_artifact.presentation_bounds,
            source_boundary_ms,
        )?;
        let target_window = v2_local_boundary_decode_window(
            target_artifact.presentation_bounds,
            target_boundary_ms,
        )?;

        let source_local = if source_audio.pcm_covers_full_window {
            None
        } else {
            Some(decode_v2_pcm_window(
                source_path,
                "B 站参考边界",
                options,
                source_input,
                source_artifact.presentation_bounds,
                source_window,
                cancel_flag,
                source_artifact.identity_guard.as_deref(),
            )?)
        };
        let target_local = if target_audio.pcm_covers_full_window {
            None
        } else {
            Some(decode_v2_pcm_window(
                target_path,
                "目标原片边界",
                options,
                target_input,
                target_artifact.presentation_bounds,
                target_window,
                cancel_flag,
                target_artifact.identity_guard.as_deref(),
            )?)
        };
        let source_pcm = source_local
            .as_ref()
            .map(|decoded| decoded.artifact.samples())
            .unwrap_or(source_audio.pcm.as_slice());
        let target_pcm = target_local
            .as_ref()
            .map(|decoded| decoded.artifact.samples())
            .unwrap_or(target_audio.pcm.as_slice());
        let source_offset_ms = source_local
            .as_ref()
            .map(|_| source_window.start_ms)
            .unwrap_or(source_audio.presentation_offset_ms);
        let target_offset_ms = target_local
            .as_ref()
            .map(|_| target_window.start_ms)
            .unwrap_or(target_audio.presentation_offset_ms);

        let local = refine_v2_span_boundaries(
            &mut spans[boundary_index - 1..=boundary_index],
            source_pcm,
            target_pcm,
            source_offset_ms,
            target_offset_ms,
            cancel_flag,
        );
        aggregate.attempted_count = aggregate
            .attempted_count
            .saturating_add(local.attempted_count);
        aggregate.refined_count = aggregate.refined_count.saturating_add(local.refined_count);
        aggregate.ambiguous_count = aggregate
            .ambiguous_count
            .saturating_add(local.ambiguous_count);
        aggregate.max_uncertainty_ms =
            match (aggregate.max_uncertainty_ms, local.max_uncertainty_ms) {
                (Some(left), Some(right)) => Some(left.max(right)),
                (left, right) => left.or(right),
            };
        aggregate.evidence_notes.extend(
            local
                .evidence_notes
                .into_iter()
                .map(|note| format!("long fine 边界 #{boundary_index}：{note}")),
        );
    }
    Ok(aggregate)
}

pub(super) fn refine_selected_fine_boundaries(
    request: V2BoundaryRefinementRequest<'_>,
) -> Result<V2RefinedFineExecution, String> {
    let mut alignment = request.alignment;
    let boundary_summary = refine_v2_span_boundaries_for_decoded_audio(
        &mut alignment.spans,
        request.source_audio,
        request.target_audio,
        request.source_path,
        request.target_path,
        request.options,
        request.source_input,
        request.target_input,
        request.source_artifact,
        request.target_artifact,
        request.cancel_flag,
    )?;
    Ok(V2RefinedFineExecution {
        alignment,
        boundary_summary,
    })
}

fn v2_local_boundary_decode_window(
    media_bounds: PresentationRangeMs,
    boundary_ms: i64,
) -> Result<PresentationRangeMs, String> {
    const LOCAL_BOUNDARY_RADIUS_MS: i64 = 31_000;
    let start_ms = boundary_ms
        .saturating_sub(LOCAL_BOUNDARY_RADIUS_MS)
        .max(media_bounds.start_ms);
    let end_ms = boundary_ms
        .saturating_add(LOCAL_BOUNDARY_RADIUS_MS)
        .min(media_bounds.end_ms);
    if end_ms <= start_ms {
        return Err("long fine 局部边界窗口为空。".to_string());
    }
    Ok(PresentationRangeMs { start_ms, end_ms })
}

fn fine_features_in_presentation_range<'a>(
    frames: &'a [FineFeatureFrame],
    range: PresentationRangeMs,
    label: &str,
) -> Result<&'a [FineFeatureFrame], String> {
    if range.end_ms <= range.start_ms {
        return Err(format!("{label} fine 内容区间为空。"));
    }
    let start = frames.partition_point(|frame| frame.time_ms < range.start_ms);
    let end = frames.partition_point(|frame| frame.time_ms < range.end_ms);
    if end <= start {
        return Err(format!(
            "{label} fine 解码保护区中没有覆盖零 guard 内容区间的特征。"
        ));
    }
    Ok(&frames[start..end])
}

pub(super) fn prepare_decoded_selected_fine_path(
    request: V2SelectedFineSolveRequest<'_>,
) -> Result<PreparedV2SelectedFinePath<'_>, String> {
    let source_frames = fine_features_in_presentation_range(
        &request.source_audio.fine_features,
        request.content_intervals.source,
        "B 站参考",
    )?;
    let target_frames = fine_features_in_presentation_range(
        &request.target_audio.fine_features,
        request.content_intervals.target,
        "目标原片",
    )?;
    Ok(PreparedV2SelectedFinePath {
        source_frames,
        target_frames,
        selected_candidate_hypothesis: request.selected_candidate_hypothesis,
        max_dp_cells: request.max_dp_cells,
        active_artifact_bytes: request.active_artifact_bytes,
        cancel_flag: request.cancel_flag,
    })
}

#[cfg(test)]
mod tests {
    use super::fine_features_in_presentation_range;
    use crate::alignment_v2::{FineFeatureFrame, PresentationRangeMs};

    fn frame(time_ms: i64) -> FineFeatureFrame {
        FineFeatureFrame {
            time_ms,
            presentation_time_ms: time_ms,
            values: vec![1.0],
        }
    }

    #[test]
    fn selected_path_excludes_decode_guard_frames() {
        let frames = (0..61).map(|index| frame(index * 50)).collect::<Vec<_>>();

        let selected = fine_features_in_presentation_range(
            &frames,
            PresentationRangeMs {
                start_ms: 500,
                end_ms: 2_500,
            },
            "测试轴",
        )
        .unwrap();

        assert_eq!(selected.first().unwrap().presentation_time_ms, 500);
        assert_eq!(selected.last().unwrap().presentation_time_ms, 2_450);
        assert_eq!(selected.len(), 40);
        assert!(selected.iter().all(|item| item.presentation_time_ms >= 500));
        assert!(selected
            .iter()
            .all(|item| item.presentation_time_ms < 2_500));
    }
}
