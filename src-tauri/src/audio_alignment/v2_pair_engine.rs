//! Single-pair V2 execution policy.
//!
//! CP8a owns the complete coarse candidate universe built from already verified audio inputs and
//! immutable coarse artifact handles. CP8b additionally owns the selected-candidate fine path
//! solver: bidirectional edit-aware DP, recursive recovery, span normalization, reciprocal
//! demotion, and initial boundary state. The sibling `v2_pair_fine_execution` owns selected-axis
//! media decode and correlation boundary refinement; cross-pair assignment, quality/evidence,
//! visual fallback, and proposal construction stay in the parent.

use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};

use super::{
    long_fine_alignment::{plan_bounded_fine_axis, BoundedFineAxisPlan},
    AlignmentAudioInput, AudioAlternativeTrackScoreDto, AudioTimeMapBoundaryAxis,
    AudioTimeMapBoundaryEvidenceDto, AudioTimeMapBoundaryStatus, AudioTimeMapSignalStatus,
    AudioTimeMapSpanBoundariesDto, AudioTimeMapSpanDto, AudioTimeMapSpanKind,
    AudioTimeMapSpanQualityDto, AudioTimeMapSpanSignalsDto, AudioTimeMapSpanSupportStatus,
    CachedV2Landmarks, V2PcmDecodeBudget, ALIGNMENT_V2_AFFINE_MATCH_WORKSPACE_BYTES,
    ALIGNMENT_V2_AMBIGUOUS_RESCUE_LONG_MIN_ANCHORS, ALIGNMENT_V2_AMBIGUOUS_RESCUE_LONG_MIN_SPAN_MS,
    ALIGNMENT_V2_AMBIGUOUS_RESCUE_MAX_ENDPOINT_DRIFT_MS,
    ALIGNMENT_V2_AMBIGUOUS_RESCUE_MAX_LEFT_BRIDGE_MS, ALIGNMENT_V2_AMBIGUOUS_RESCUE_MIN_ANCHORS,
    ALIGNMENT_V2_AMBIGUOUS_RESCUE_MIN_SPAN_MS, ALIGNMENT_V2_AMBIGUOUS_RESCUE_TIME_BUCKET_MS,
    ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_ISLAND_MS,
    ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_NET_RESIDUAL_MS,
    ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_SINGLE_MS, ALIGNMENT_V2_BALANCED_MICRO_EDIT_MIN_COUNT,
    ALIGNMENT_V2_COARSE_CANDIDATE_RESERVED_BYTES, ALIGNMENT_V2_COARSE_GUIDED_DP_BAND_RADIUS_MS,
    ALIGNMENT_V2_COARSE_MAX_DURATION_MS, ALIGNMENT_V2_DP_BAND_RADIUS_MS, ALIGNMENT_V2_DP_CHUNK_MS,
    ALIGNMENT_V2_DP_PARENT_BYTES_PER_CELL, ALIGNMENT_V2_DP_PATH_BYTES_PER_STEP,
    ALIGNMENT_V2_DP_ROLLING_COST_ROW_COUNT, ALIGNMENT_V2_DP_WORKSPACE_SLACK_BYTES,
    ALIGNMENT_V2_FINE_FEATURE_VALUE_COUNT, ALIGNMENT_V2_FINE_FRONTIER_BASELINE_RESERVE_BYTES,
    ALIGNMENT_V2_FINE_HOP_MS, ALIGNMENT_V2_FINE_WINDOW_DECODE_TOLERANCE_MS,
    ALIGNMENT_V2_FINE_WINDOW_GUARD_MS, ALIGNMENT_V2_GLOBAL_REPEATED_CONTENT_PENALTY,
    ALIGNMENT_V2_GLOBAL_SHORTLIST_MAX_CANDIDATES, ALIGNMENT_V2_LOCAL_ANCHOR_BRACKET_RADIUS_MS,
    ALIGNMENT_V2_LOCAL_ANCHOR_OFFSET_TOLERANCE_MS, ALIGNMENT_V2_MAX_DP_CELLS,
    ALIGNMENT_V2_MAX_DURATION_MS, ALIGNMENT_V2_MAX_STDERR_BYTES, ALIGNMENT_V2_MIN_TRACK_MARGIN,
    ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS, ALIGNMENT_V2_OFFSET_STEP_MAX_DURATION_RESIDUAL_MS,
    ALIGNMENT_V2_OFFSET_STEP_MAX_OBSERVATION_GAP_MS,
    ALIGNMENT_V2_OFFSET_STEP_MAX_WITHIN_RUN_DRIFT_MS, ALIGNMENT_V2_OFFSET_STEP_MIN_EDIT_MS,
    ALIGNMENT_V2_OFFSET_STEP_MIN_INFORMATIVENESS, ALIGNMENT_V2_OFFSET_STEP_MIN_SIDE_SUPPORT_MS,
    ALIGNMENT_V2_PENDING_RECOVERY_ABSOLUTE_FLOOR_MS,
    ALIGNMENT_V2_PENDING_RECOVERY_CURSOR_TOLERANCE_MS, ALIGNMENT_V2_PENDING_RECOVERY_MIN_MATCH_MS,
    ALIGNMENT_V2_PIECEWISE_ANCHOR_MAX_NET_RESIDUAL_MS,
    ALIGNMENT_V2_PIECEWISE_ANCHOR_MIN_DENSITY_DENOMINATOR,
    ALIGNMENT_V2_PIECEWISE_ANCHOR_MIN_DENSITY_NUMERATOR,
    ALIGNMENT_V2_PIECEWISE_ANCHOR_MIN_SIDE_SUPPORT_MS, ALIGNMENT_V2_RECOVERY_CONTEXT_COST,
    ALIGNMENT_V2_RECURSIVE_LOOKAHEAD_MS, ALIGNMENT_V2_SAMPLE_RATE,
    ALIGNMENT_V2_TEMPORAL_GROUP_MAX_RECENT_PROBES, ALIGNMENT_V2_TEMPORAL_WINDOW_MIN_OVERLAP,
    ALIGNMENT_V2_TEMPORAL_WINDOW_SCALE_TOLERANCE, ALIGNMENT_V2_TEMPO_CADENCE_SCALE_TOLERANCE,
    ALIGNMENT_V2_TEMPO_EDGE_DIRECTION_EPSILON, ALIGNMENT_V2_TEMPO_EDGE_SUPPORT_MIN_MS,
    ALIGNMENT_V2_TEMPO_INTERNAL_SIDE_MIN_MS, ALIGNMENT_V2_TEMPO_SKIP_MAX_MS,
    ALIGNMENT_V2_TEMPO_SLOPE_TOLERANCE, AUDIO_ALIGNMENT_CANCELLED, MAX_V2_ACTIVE_ARTIFACT_BYTES,
    SUPERVISED_READ_BOUNDED_INITIAL_CAPACITY_BYTES,
};
use crate::{
    alignment_v2::{
        align_features_edit_aware_with_cancel, derive_affine_fine_decode_windows,
        lock_fine_spectral_backend_request, match_landmarks_affine_coarse_universe_with_cancel,
        materialize_affine_hypothesis_with_cancel, AffineAnchorEvidence, AffineFineDecodeWindows,
        AffineFineWindowRequest, AffineHypothesis, AffineMatchConfig, CoarseAffineHypothesis,
        EditAlignmentConfig, EditAlignmentMode, EditPathKind, EditPathStep, EditTimeSpan,
        FineFeatureFrame, PresentationRangeMs, SpectralLandmark,
    },
    coarse_fingerprint::{
        match_landmark_timelines_approximately, match_spectral_fingerprints_approximately,
        ApproximateCoarseHypothesis, ApproximateFingerprintConfig,
    },
    cuda_fft_backend::{CudaFftMemoryBudget, CUDA_FFT_BACKEND_ID, CUDA_FFT_DEFAULT_BATCH_FRAMES},
};

#[derive(Debug, Clone)]
pub(super) struct V2TrackPairCandidate {
    pub(super) source_input: AlignmentAudioInput,
    pub(super) target_input: AlignmentAudioInput,
    pub(super) coarse_hypothesis: Option<CoarseAffineHypothesis>,
    pub(super) hypothesis: AffineHypothesis,
    pub(super) offset_island_count: usize,
    pub(super) score: f64,
    pub(super) temporal_coverage: f64,
    pub(super) intrinsic_margin: f64,
    pub(super) repeated_content_only: bool,
    pub(super) observation_count: usize,
    pub(super) source_landmark_count: usize,
    pub(super) target_landmark_count: usize,
    pub(super) source_spectral_backend_id: String,
    pub(super) target_spectral_backend_id: String,
    pub(super) toolchain_cache_identity: String,
    pub(super) global_source_interval: PresentationRangeMs,
    pub(super) global_target_interval: PresentationRangeMs,
    pub(super) fine_working_set_bytes: usize,
}

#[derive(Debug, Clone)]
pub(super) struct V2PairCoarseCandidates {
    pub(super) candidates: Vec<V2TrackPairCandidate>,
    pub(super) temporal_window_groups: Vec<V2TemporalWindowGroup>,
    pub(super) alternatives: Vec<AudioAlternativeTrackScoreDto>,
    pub(super) diagnostics: Vec<String>,
}

pub(super) struct V2SelectedFinePathInput<'a> {
    pub(super) source_frames: &'a [FineFeatureFrame],
    pub(super) target_frames: &'a [FineFeatureFrame],
    pub(super) selected_candidate_hypothesis: &'a AffineHypothesis,
    pub(super) max_dp_cells: usize,
    pub(super) active_artifact_bytes: usize,
    pub(super) cancel_flag: Option<&'a AtomicBool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct V2SelectedFineDecodePlan {
    pub(super) windows: AffineFineDecodeWindows,
    pub(super) adaptive_guard_ms: i64,
    pub(super) source_axis: BoundedFineAxisPlan,
    pub(super) target_axis: BoundedFineAxisPlan,
}

#[derive(Debug)]
pub(super) struct V2ChunkAlignment {
    pub(super) spans: Vec<AudioTimeMapSpanDto>,
    pub(super) matched_step_count: usize,
    pub(super) ambiguous_step_count: usize,
    pub(super) path_checkpoints: Vec<String>,
    pub(super) fine_evidence: Vec<V2FineEvidenceObservation>,
}

#[derive(Debug, Clone)]
pub(super) struct V2FineEvidenceObservation {
    pub(super) source_start_ms: u64,
    pub(super) source_end_ms: u64,
    pub(super) target_start_ms: u64,
    pub(super) target_end_ms: u64,
    pub(super) kind: AudioTimeMapSpanKind,
    pub(super) local_cost: i64,
    pub(super) informativeness: f64,
}

#[derive(Debug, Clone)]
pub(super) struct V2TemporalWindowGroup {
    // Indices deliberately point into the frozen pair candidate universe. A candidate owns
    // training/held-out anchor evidence, so cloning every member here could duplicate hundreds
    // of MiB outside the active-artifact ledger. Indices also guarantee that a future fine
    // frontier cannot accidentally consume a stale pre-margin candidate clone.
    pub(super) member_indices: Vec<usize>,
}

#[derive(Debug)]
struct V2TemporalWindowGroupBuilder {
    member_indices: Vec<usize>,
    min_scale: f64,
    max_scale: f64,
    source_intersection: PresentationRangeMs,
    target_intersection: PresentationRangeMs,
    max_source_length_ms: i64,
    max_target_length_ms: i64,
}

pub(super) struct V2PairCoarseInput<'a> {
    pub(super) source_inputs: &'a [AlignmentAudioInput],
    pub(super) target_inputs: &'a [AlignmentAudioInput],
    pub(super) source_artifacts: &'a HashMap<u32, CachedV2Landmarks>,
    pub(super) target_artifacts: &'a HashMap<u32, CachedV2Landmarks>,
    pub(super) toolchain_cache_identity: &'a str,
    pub(super) has_explicit_selection: bool,
    pub(super) coarse_resident_baseline_bytes: usize,
    pub(super) cancel_flag: Option<&'a AtomicBool>,
}

#[derive(Debug)]
struct V2ApproximateFingerprintCandidates {
    candidates: Vec<V2TrackPairCandidate>,
    diagnostic: String,
}

fn create_v2_approximate_fingerprint_candidates(
    source_input: &AlignmentAudioInput,
    target_input: &AlignmentAudioInput,
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
    toolchain_cache_identity: &str,
    affine_config: &AffineMatchConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<V2ApproximateFingerprintCandidates, String> {
    let mut fallback_diagnostic = None::<String>;
    let result = if !source_artifact.coarse_fingerprint.is_empty()
        && !target_artifact.coarse_fingerprint.is_empty()
    {
        let spectral = match_spectral_fingerprints_approximately(
            &source_artifact.coarse_fingerprint,
            &target_artifact.coarse_fingerprint,
            (
                source_artifact.presentation_bounds.start_ms,
                source_artifact.presentation_bounds.end_ms,
            ),
            (
                target_artifact.presentation_bounds.start_ms,
                target_artifact.presentation_bounds.end_ms,
            ),
            &ApproximateFingerprintConfig::default(),
            cancel_flag,
        )
        .map_err(|error| format!("近似声谱时间指纹失败：{error}"))?;
        if spectral.hypotheses.is_empty() {
            let landmark = match_landmark_timelines_approximately(
                &source_artifact.landmarks,
                &target_artifact.landmarks,
                (
                    source_artifact.presentation_bounds.start_ms,
                    source_artifact.presentation_bounds.end_ms,
                ),
                (
                    target_artifact.presentation_bounds.start_ms,
                    target_artifact.presentation_bounds.end_ms,
                ),
                &ApproximateFingerprintConfig::default(),
                cancel_flag,
            )
            .map_err(|error| format!("近似 landmark 时间轨迹失败：{error}"))?;
            fallback_diagnostic = Some(format!(
                "主声谱未成候选后执行 landmark 强度/活动轨迹兜底：queryBlocks={}、scoreAccepted={}、uniqueTraining={}、trainingOffsetsMs={:?}",
                landmark.query_block_count,
                landmark.score_accepted_block_count,
                landmark.unique_training_block_count,
                landmark.unique_training_offsets_ms
            ));
            if landmark.hypotheses.is_empty() {
                spectral
            } else {
                landmark
            }
        } else {
            spectral
        }
    } else {
        // Compatibility guard for in-memory test fixtures. Release v18 persistent artifacts
        // always contain full coarse spectral frames.
        match_landmark_timelines_approximately(
            &source_artifact.landmarks,
            &target_artifact.landmarks,
            (
                source_artifact.presentation_bounds.start_ms,
                source_artifact.presentation_bounds.end_ms,
            ),
            (
                target_artifact.presentation_bounds.start_ms,
                target_artifact.presentation_bounds.end_ms,
            ),
            &ApproximateFingerprintConfig::default(),
            cancel_flag,
        )
        .map_err(|error| format!("近似 landmark 时间轨迹失败：{error}"))?
    };
    let mut diagnostic = format!(
        "近似粗定位窗口统计：queryBlocks={}、scoreAccepted={}、uniqueTraining={}、best/medianScore={:?}/{:?}、best/medianMargin={:?}/{:?}、trainingOffsetsMs={:?}、blockMatches=[{}]。",
        result.query_block_count,
        result.score_accepted_block_count,
        result.unique_training_block_count,
        result.best_block_score,
        result.median_block_score,
        result.best_block_margin,
        result.median_block_margin,
        result.unique_training_offsets_ms,
        result
            .block_matches
            .iter()
            .map(|block| format!(
                "source={}→target={},offset={:+},score={:.3},margin={:.3},heldOut={}",
                block.source_time_ms,
                block.target_time_ms,
                block.offset_ms,
                block.score,
                block.alternative_margin,
                block.held_out
            ))
            .collect::<Vec<_>>()
            .join("；")
    );
    if let Some(fallback_diagnostic) = fallback_diagnostic {
        diagnostic.push(' ');
        diagnostic.push_str(&fallback_diagnostic);
    }
    let hypotheses = result.hypotheses;
    if !hypotheses.is_empty() {
        diagnostic.push_str(&format!(
            " 候选结构=[{}]。",
            hypotheses
                .iter()
                .map(|hypothesis| format!(
                    "offset={:+},islands={},training={},heldOut={},coverage={:.3}",
                    hypothesis.offset_ms,
                    hypothesis.offset_island_count,
                    hypothesis.training_anchors.len(),
                    hypothesis.held_out_anchors.len(),
                    hypothesis.target_coverage
                ))
                .collect::<Vec<_>>()
                .join("；")
        ));
    }
    let alternative_margin = hypotheses
        .first()
        .zip(hypotheses.get(1))
        .map(|(best, second)| ((best.score - second.score) / best.score.max(0.001)).clamp(0.0, 1.0))
        .unwrap_or(1.0);
    let repeated_content_only =
        hypotheses
            .first()
            .zip(hypotheses.get(1))
            .is_some_and(|(best, second)| {
                alternative_margin < ALIGNMENT_V2_MIN_TRACK_MARGIN
                    && best.offset_ms.abs_diff(second.offset_ms) >= 10_000
            });
    let candidates = hypotheses
        .into_iter()
        .map(|approximate| {
            let hypothesis =
                v2_affine_hypothesis_from_approximate_fingerprint(&approximate, affine_config);
            let temporal_coverage = approximate.target_coverage;
            let ordinary_score = score_v2_track_pair(
                &hypothesis,
                temporal_coverage,
                affine_config,
                source_input,
                target_input,
            );
            let score = (ordinary_score * 0.70 + approximate.score * 0.30).clamp(0.0, 1.0);
            let candidate = V2TrackPairCandidate {
                source_input: source_input.clone(),
                target_input: target_input.clone(),
                // The approximate fingerprint already owns complete training and held-out
                // evidence. It must not be rematerialized through exact-hash observations.
                coarse_hypothesis: None,
                hypothesis,
                offset_island_count: approximate.offset_island_count,
                score,
                temporal_coverage,
                intrinsic_margin: alternative_margin,
                repeated_content_only,
                observation_count: approximate
                    .training_anchors
                    .len()
                    .saturating_add(approximate.held_out_anchors.len()),
                source_landmark_count: source_artifact.landmarks.len(),
                target_landmark_count: target_artifact.landmarks.len(),
                source_spectral_backend_id: source_artifact.spectral_backend.backend_id.clone(),
                target_spectral_backend_id: target_artifact.spectral_backend.backend_id.clone(),
                toolchain_cache_identity: toolchain_cache_identity.to_string(),
                global_source_interval: source_artifact.presentation_bounds,
                global_target_interval: target_artifact.presentation_bounds,
                fine_working_set_bytes: 0,
            };
            bind_v2_candidate_global_intervals(candidate, source_artifact, target_artifact)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(V2ApproximateFingerprintCandidates {
        candidates,
        diagnostic,
    })
}

fn append_v2_approximate_fingerprint_candidates(
    source_input: &AlignmentAudioInput,
    target_input: &AlignmentAudioInput,
    approximate_result: V2ApproximateFingerprintCandidates,
    candidates: &mut Vec<V2TrackPairCandidate>,
    alternatives: &mut Vec<AudioAlternativeTrackScoreDto>,
    diagnostics: &mut Vec<String>,
) -> Result<usize, String> {
    diagnostics.push(format!(
        "音轨 #{} → #{}：{}",
        source_input.stream.stream_index,
        target_input.stream.stream_index,
        approximate_result.diagnostic
    ));
    let approximate_candidates = approximate_result.candidates;
    if approximate_candidates.is_empty() {
        diagnostics.push(format!(
            "音轨 #{} → #{} 的近似声谱时间指纹没有形成满足分布、唯一性与内点门槛的候选。",
            source_input.stream.stream_index, target_input.stream.stream_index
        ));
        return Ok(0);
    }
    let projected_candidate_count = candidates
        .len()
        .checked_add(approximate_candidates.len())
        .ok_or_else(|| {
            "blocked:resource-limit：完整 coarse supplement candidate 数量溢出。".to_string()
        })?;
    if projected_candidate_count > ALIGNMENT_V2_GLOBAL_SHORTLIST_MAX_CANDIDATES {
        return Err(format!(
            "blocked:resource-limit：完整 coarse candidate universe 需要 {} 个 candidate，超过硬上限 {}。",
            projected_candidate_count, ALIGNMENT_V2_GLOBAL_SHORTLIST_MAX_CANDIDATES
        ));
    }
    diagnostics.push(format!(
        "音轨 #{} → #{} 的近似声谱时间指纹补充 {} 个候选：{}。",
        source_input.stream.stream_index,
        target_input.stream.stream_index,
        approximate_candidates.len(),
        approximate_candidates
            .iter()
            .map(|candidate| format!(
                "offset={:+},anchors={}/{},coverage={:.3},p95={}ms,score={:.3}",
                candidate.hypothesis.offset_ms,
                candidate.hypothesis.training_anchors.len(),
                candidate.hypothesis.held_out_anchors.len(),
                candidate.temporal_coverage,
                candidate.hypothesis.p95_residual_ms,
                candidate.score
            ))
            .collect::<Vec<_>>()
            .join("；")
    ));
    alternatives.extend(approximate_candidates.iter().map(|candidate| {
        v2_alternative_hypothesis_score(
            &candidate.source_input,
            &candidate.target_input,
            &candidate.hypothesis,
            candidate.score,
        )
    }));
    let appended_count = approximate_candidates.len();
    candidates.extend(approximate_candidates);
    Ok(appended_count)
}

fn v2_affine_hypothesis_from_approximate_fingerprint(
    approximate: &ApproximateCoarseHypothesis,
    affine_config: &AffineMatchConfig,
) -> AffineHypothesis {
    let training_anchors = approximate
        .training_anchors
        .iter()
        .map(|anchor| AffineAnchorEvidence {
            source_time_ms: anchor.source_time_ms,
            target_time_ms: anchor.target_time_ms,
            residual_ms: anchor.residual_ms,
        })
        .collect::<Vec<_>>();
    let held_out_anchors = approximate
        .held_out_anchors
        .iter()
        .map(|anchor| AffineAnchorEvidence {
            source_time_ms: anchor.source_time_ms,
            target_time_ms: anchor.target_time_ms,
            residual_ms: anchor.residual_ms,
        })
        .collect::<Vec<_>>();
    let held_out_within_tolerance_count = approximate
        .held_out_anchors
        .iter()
        .filter(|anchor| {
            anchor.residual_ms.unsigned_abs() <= affine_config.residual_tolerance_ms as u64
        })
        .count();
    AffineHypothesis {
        scale: approximate.scale,
        offset_ms: approximate.offset_ms,
        inlier_count: training_anchors.len(),
        unique_source_count: training_anchors.len(),
        unique_source_coverage: approximate.target_coverage,
        unique_target_count: training_anchors.len(),
        unique_target_coverage: approximate.target_coverage,
        source_start_ms: approximate.source_start_ms,
        source_end_ms: approximate.source_end_ms,
        p50_residual_ms: approximate.p50_residual_ms,
        p95_residual_ms: approximate.p95_residual_ms,
        max_residual_ms: approximate.max_residual_ms,
        training_anchors,
        held_out_anchors,
        held_out_within_tolerance_count,
    }
}

pub(super) fn assess_coarse_pair(
    input: V2PairCoarseInput<'_>,
) -> Result<V2PairCoarseCandidates, String> {
    let V2PairCoarseInput {
        source_inputs,
        target_inputs,
        source_artifacts: source_landmarks,
        target_artifacts: target_landmarks,
        toolchain_cache_identity,
        has_explicit_selection,
        coarse_resident_baseline_bytes,
        cancel_flag,
    } = input;
    let affine_config = v2_affine_match_config();
    let mut candidates = Vec::<V2TrackPairCandidate>::new();
    let mut alternatives = Vec::new();
    let mut diagnostics = Vec::new();
    for source_input in source_inputs {
        for target_input in target_inputs {
            check_cancelled(cancel_flag)?;
            if !has_explicit_selection
                && !is_reasonable_audio_stream_pair(source_input, target_input)
            {
                continue;
            }
            let Some(source_artifact) = source_landmarks.get(&source_input.stream.stream_index)
            else {
                continue;
            };
            let Some(target_artifact) = target_landmarks.get(&target_input.stream.stream_index)
            else {
                continue;
            };
            let current_candidate_bytes = v2_coarse_candidate_reserved_bytes(candidates.len())?;
            let current_active_bytes = ensure_v2_active_artifact_budget(
                coarse_resident_baseline_bytes,
                current_candidate_bytes,
            )?;
            ensure_v2_active_artifact_budget(
                current_active_bytes,
                ALIGNMENT_V2_AFFINE_MATCH_WORKSPACE_BYTES,
            )?;
            let result = match match_landmarks_affine_coarse_universe_with_cancel(
                &source_artifact.landmarks,
                &target_artifact.landmarks,
                &affine_config,
                cancel_flag,
            ) {
                Ok(result) => result,
                Err(error) => {
                    diagnostics.push(format!(
                        "音轨 #{} → #{} landmark 拟合失败：{error}",
                        source_input.stream.stream_index, target_input.stream.stream_index
                    ));
                    continue;
                }
            };
            if result.hypotheses.is_empty() {
                diagnostics.push(format!(
                    "音轨 #{} → #{} 的 exact-landmark 仿射拟合没有候选：sourceLandmarks={}、targetLandmarks={}、exactObservations={}、modelSeeds={}；转入近似声谱时间指纹。",
                    source_input.stream.stream_index,
                    target_input.stream.stream_index,
                    result.source_landmark_count,
                    result.target_landmark_count,
                    result.observation_count,
                    result.seed_count
                ));
                let approximate_result = match create_v2_approximate_fingerprint_candidates(
                    source_input,
                    target_input,
                    source_artifact,
                    target_artifact,
                    toolchain_cache_identity,
                    &affine_config,
                    cancel_flag,
                ) {
                    Ok(result) => result,
                    Err(error) => {
                        diagnostics.push(format!(
                            "音轨 #{} → #{} 的近似声谱时间指纹无法执行：{error}",
                            source_input.stream.stream_index, target_input.stream.stream_index
                        ));
                        continue;
                    }
                };
                append_v2_approximate_fingerprint_candidates(
                    source_input,
                    target_input,
                    approximate_result,
                    &mut candidates,
                    &mut alternatives,
                    &mut diagnostics,
                )?;
                continue;
            }
            let projected_candidate_count = candidates
                .len()
                .checked_add(result.hypotheses.len())
                .ok_or_else(|| {
                "blocked:resource-limit：完整 coarse affine candidate 数量溢出。".to_string()
            })?;
            if projected_candidate_count > ALIGNMENT_V2_GLOBAL_SHORTLIST_MAX_CANDIDATES {
                return Err(format!(
                    "blocked:resource-limit：完整 coarse affine universe 需要 {} 个 candidate，超过硬上限 {}；为保留 omitted-candidate 正确性，本次不会静默截断。",
                    projected_candidate_count, ALIGNMENT_V2_GLOBAL_SHORTLIST_MAX_CANDIDATES
                ));
            }
            ensure_v2_active_artifact_budget(
                coarse_resident_baseline_bytes,
                v2_coarse_candidate_reserved_bytes(projected_candidate_count)?,
            )?;
            diagnostics.push(format!(
                "音轨 #{} → #{} 完整 coarse affine universe：{} 个 seed、{} 个去重 candidate；预览：{}。",
                source_input.stream.stream_index,
                target_input.stream.stream_index,
                result.seed_count,
                result.hypotheses.len(),
                result
                    .hypotheses
                    .iter()
                    .take(10)
                    .map(|item| format!(
                        "scale={:.6},offset={:+},inliers={},range={}-{}",
                        item.scale,
                        item.offset_ms,
                        item.inlier_count,
                        item.source_start_ms,
                        item.source_end_ms
                    ))
                    .collect::<Vec<_>>()
                    .join("；")
            ));
            let anchor_free_hypotheses = result
                .hypotheses
                .iter()
                .map(CoarseAffineHypothesis::to_anchor_free_affine_hypothesis)
                .collect::<Vec<_>>();
            let repeated_content_only = v2_affine_has_competing_repeated_location(
                &anchor_free_hypotheses,
                result.top1_top2_margin,
            );
            for (coarse_hypothesis, hypothesis) in
                result.hypotheses.iter().zip(&anchor_free_hypotheses)
            {
                let temporal_coverage = affine_temporal_coverage(
                    hypothesis,
                    &target_artifact.landmarks,
                    v2_normalized_pcm_origin_ms(target_input),
                );
                let score = score_v2_track_pair(
                    hypothesis,
                    temporal_coverage,
                    &affine_config,
                    source_input,
                    target_input,
                );
                alternatives.push(v2_alternative_hypothesis_score(
                    source_input,
                    target_input,
                    hypothesis,
                    score,
                ));
                let mut candidate = V2TrackPairCandidate {
                    source_input: source_input.clone(),
                    target_input: target_input.clone(),
                    coarse_hypothesis: Some(coarse_hypothesis.clone()),
                    hypothesis: hypothesis.clone(),
                    offset_island_count: 1,
                    score,
                    temporal_coverage,
                    intrinsic_margin: result.top1_top2_margin,
                    repeated_content_only,
                    observation_count: result.observation_count,
                    source_landmark_count: result.source_landmark_count,
                    target_landmark_count: result.target_landmark_count,
                    source_spectral_backend_id: source_artifact.spectral_backend.backend_id.clone(),
                    target_spectral_backend_id: target_artifact.spectral_backend.backend_id.clone(),
                    toolchain_cache_identity: toolchain_cache_identity.to_string(),
                    global_source_interval: source_artifact.presentation_bounds,
                    global_target_interval: target_artifact.presentation_bounds,
                    fine_working_set_bytes: 0,
                };
                candidate = match bind_v2_candidate_global_intervals(
                    candidate,
                    source_artifact,
                    target_artifact,
                ) {
                    Ok(candidate) => candidate,
                    Err(error) => {
                        diagnostics.push(format!(
                            "音轨 #{} → #{} 的 affine candidate scale={:.6},offset={:+} 无法形成有界 fine window，已在项目级 shortlist 前排除：{error}",
                            source_input.stream.stream_index,
                            target_input.stream.stream_index,
                            hypothesis.scale,
                            hypothesis.offset_ms
                        ));
                        continue;
                    }
                };
                candidates.push(candidate);
            }
            match create_v2_approximate_fingerprint_candidates(
                source_input,
                target_input,
                source_artifact,
                target_artifact,
                toolchain_cache_identity,
                &affine_config,
                cancel_flag,
            ) {
                Ok(approximate_result) => {
                    let appended_count = append_v2_approximate_fingerprint_candidates(
                        source_input,
                        target_input,
                        approximate_result,
                        &mut candidates,
                        &mut alternatives,
                        &mut diagnostics,
                    )?;
                    diagnostics.push(format!(
                        "音轨 #{} → #{} 同时保留 exact-landmark 与 {} 个近似声谱候选进入统一 temporal-window grouping；两种证据不再互斥。",
                        source_input.stream.stream_index,
                        target_input.stream.stream_index,
                        appended_count
                    ));
                }
                Err(error) => diagnostics.push(format!(
                    "音轨 #{} → #{} 的近似声谱补充无法执行，已保留完整 exact-landmark universe：{error}",
                    source_input.stream.stream_index, target_input.stream.stream_index
                )),
            }
        }
    }
    candidates.sort_by(compare_v2_track_pair_candidates);
    alternatives.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.inlier_count.cmp(&left.inlier_count))
            .then_with(|| left.source_stream_index.cmp(&right.source_stream_index))
            .then_with(|| left.target_stream_index.cmp(&right.target_stream_index))
            .then_with(|| left.offset_ms.cmp(&right.offset_ms))
    });
    alternatives.truncate(10);
    if let Some(best) = candidates.first().cloned() {
        let margin = candidates
            .get(1)
            .map(|second| ((best.score - second.score) / best.score.max(0.001)).clamp(0.0, 1.0))
            .unwrap_or(1.0);
        if let Some(best) = candidates.first_mut() {
            best.intrinsic_margin = margin.min(best.intrinsic_margin);
        }
    }
    // Group only after every candidate field that contributes to the admissible global weight is
    // frozen. The groups keep indices rather than deep candidate clones, so representative order
    // and later fine-frontier identities always refer to this exact executable universe.
    let (temporal_window_groups, temporal_window_group_probe_count) =
        group_v2_pair_coarse_temporal_windows_with_probe_count(&candidates);
    diagnostics.push(format!(
        "pair coarse temporal-window grouping：完整保留 {} 个跨音轨 affine raw candidate，以 bounded intersection-core 归入 {} 个稳定时间候选组，共执行 {} 次 O(1) group probe；raw candidate 仍逐个计入完整证据集，temporal group 作为 pair-level relation alternative 进入 evidence v3 完整 fine frontier，不是展示用 Top-K。",
        candidates.len(),
        temporal_window_groups.len(),
        temporal_window_group_probe_count
    ));
    Ok(V2PairCoarseCandidates {
        candidates,
        temporal_window_groups,
        alternatives,
        diagnostics,
    })
}

pub(super) fn bind_v2_candidate_global_intervals(
    mut candidate: V2TrackPairCandidate,
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
) -> Result<V2TrackPairCandidate, String> {
    // The guarded plan proves this candidate can enter bounded fine. Conflict geometry uses a
    // separate zero-guard content interval: adjacent episodes may share decoder context while
    // their actual candidate content intervals only touch.
    let fine_plan = plan_v2_selected_fine_decode(&candidate, source_artifact, target_artifact)?;
    let mut fine_working_set_bytes = 0_usize;
    if let Some(plan) = fine_plan {
        let cuda_transient_bytes =
            v2_selected_fine_cuda_transient_upper_bound(source_artifact, target_artifact)?;
        fine_working_set_bytes = v2_selected_fine_phase_peak_upper_bound(
            ALIGNMENT_V2_FINE_FRONTIER_BASELINE_RESERVE_BYTES,
            &plan,
            &candidate.source_input,
            &candidate.target_input,
            cuda_transient_bytes,
        )?;
    }
    let content_intervals = derive_v2_selected_candidate_content_intervals(
        &candidate,
        source_artifact,
        target_artifact,
    )?;
    let maximum_fine_duration_ms = [
        v2_presentation_range_duration_ms(content_intervals.source)?,
        v2_presentation_range_duration_ms(content_intervals.target)?,
    ]
    .into_iter()
    .max()
    .unwrap_or(0);
    let maximum_fine_frames = usize::try_from(
        u128::from(maximum_fine_duration_ms).div_ceil(u128::from(ALIGNMENT_V2_FINE_HOP_MS)),
    )
    .map_err(|_| "blocked:resource-limit：candidate DP 帧数上界无法表示。".to_string())?;
    let dp_workspace_bytes = v2_dp_workspace_upper_bound(
        ALIGNMENT_V2_MAX_DP_CELLS,
        maximum_fine_frames,
        maximum_fine_frames,
    )?;
    fine_working_set_bytes = fine_working_set_bytes
        .checked_add(dp_workspace_bytes)
        .ok_or_else(|| "blocked:resource-limit：candidate DP workspace 上界溢出。".to_string())?;
    ensure_v2_active_artifact_budget(0, fine_working_set_bytes)?;
    candidate.global_source_interval = content_intervals.source;
    candidate.global_target_interval = content_intervals.target;
    candidate.fine_working_set_bytes = fine_working_set_bytes;
    Ok(candidate)
}

pub(super) fn materialize_v2_candidate_hypothesis(
    mut candidate: V2TrackPairCandidate,
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
    affine_config: &AffineMatchConfig,
    active_artifact_bytes: usize,
    cancel_flag: Option<&AtomicBool>,
) -> Result<V2TrackPairCandidate, String> {
    let Some(coarse_hypothesis) = candidate.coarse_hypothesis.as_ref() else {
        // Synthetic tests and legacy in-memory callers may already own full evidence.
        return Ok(candidate);
    };
    ensure_v2_active_artifact_budget(
        active_artifact_bytes,
        ALIGNMENT_V2_AFFINE_MATCH_WORKSPACE_BYTES,
    )?;
    candidate.hypothesis = materialize_affine_hypothesis_with_cancel(
        &source_artifact.landmarks,
        &target_artifact.landmarks,
        affine_config,
        coarse_hypothesis,
        cancel_flag,
    )
    .map_err(|error| {
        format!(
            "blocked:coarse-evidence-materialization：所选 affine candidate 无法重建完整 anchor 证据：{error}"
        )
    })?;
    Ok(candidate)
}

pub(super) fn v2_affine_match_config() -> AffineMatchConfig {
    AffineMatchConfig {
        residual_tolerance_ms: 140,
        min_inliers: 6,
        top_k: 5,
        ..AffineMatchConfig::default()
    }
}

fn compare_v2_track_pair_candidates(
    left: &V2TrackPairCandidate,
    right: &V2TrackPairCandidate,
) -> std::cmp::Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| {
            right
                .hypothesis
                .inlier_count
                .cmp(&left.hypothesis.inlier_count)
        })
        .then_with(|| {
            left.source_input
                .stream
                .stream_index
                .cmp(&right.source_input.stream.stream_index)
        })
        .then_with(|| {
            left.target_input
                .stream
                .stream_index
                .cmp(&right.target_input.stream.stream_index)
        })
        .then_with(|| {
            left.hypothesis
                .source_start_ms
                .cmp(&right.hypothesis.source_start_ms)
        })
        .then_with(|| left.hypothesis.offset_ms.cmp(&right.hypothesis.offset_ms))
        .then_with(|| {
            left.global_source_interval
                .start_ms
                .cmp(&right.global_source_interval.start_ms)
        })
        .then_with(|| {
            left.global_source_interval
                .end_ms
                .cmp(&right.global_source_interval.end_ms)
        })
        .then_with(|| {
            left.global_target_interval
                .start_ms
                .cmp(&right.global_target_interval.start_ms)
        })
        .then_with(|| {
            left.global_target_interval
                .end_ms
                .cmp(&right.global_target_interval.end_ms)
        })
        .then_with(|| {
            left.hypothesis
                .source_end_ms
                .cmp(&right.hypothesis.source_end_ms)
        })
        .then_with(|| left.hypothesis.scale.total_cmp(&right.hypothesis.scale))
        .then_with(|| left.temporal_coverage.total_cmp(&right.temporal_coverage))
        .then_with(|| left.intrinsic_margin.total_cmp(&right.intrinsic_margin))
        .then_with(|| left.repeated_content_only.cmp(&right.repeated_content_only))
        .then_with(|| left.observation_count.cmp(&right.observation_count))
        .then_with(|| left.source_landmark_count.cmp(&right.source_landmark_count))
        .then_with(|| left.target_landmark_count.cmp(&right.target_landmark_count))
        .then_with(|| {
            left.source_spectral_backend_id
                .cmp(&right.source_spectral_backend_id)
        })
        .then_with(|| {
            left.target_spectral_backend_id
                .cmp(&right.target_spectral_backend_id)
        })
        .then_with(|| {
            left.toolchain_cache_identity
                .cmp(&right.toolchain_cache_identity)
        })
        .then_with(|| {
            left.fine_working_set_bytes
                .cmp(&right.fine_working_set_bytes)
        })
}

#[cfg(test)]
pub(super) fn group_v2_pair_coarse_temporal_windows(
    candidates: &[V2TrackPairCandidate],
) -> Vec<V2TemporalWindowGroup> {
    group_v2_pair_coarse_temporal_windows_with_probe_count(candidates).0
}

pub(super) fn group_v2_pair_coarse_temporal_windows_with_probe_count(
    candidates: &[V2TrackPairCandidate],
) -> (Vec<V2TemporalWindowGroup>, usize) {
    let mut ordered = (0..candidates.len()).collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        compare_v2_temporal_window_geometry(&candidates[*left], &candidates[*right])
            .then_with(|| left.cmp(right))
    });
    let mut builders = Vec::<V2TemporalWindowGroupBuilder>::new();
    let mut probe_count = 0_usize;
    for candidate_index in ordered {
        let candidate = &candidates[candidate_index];
        // Geometry sorting makes plausible co-located windows adjacent. Probe only a bounded
        // recent frontier, then use an O(1) intersection-core certificate that is stronger than
        // pairwise complete-link: every accepted member shares at least 80% of the group's
        // longest interval on both axes and the whole scale range fits the tolerance. Missing a
        // far-away compatible group can only over-split scheduling groups; it never drops or
        // merges executable candidates, while eliminating the previous Θ(n²) diagnostic path.
        let first_builder = builders
            .len()
            .saturating_sub(ALIGNMENT_V2_TEMPORAL_GROUP_MAX_RECENT_PROBES);
        let mut accepted_builder = None;
        for builder_index in (first_builder..builders.len()).rev() {
            probe_count = probe_count.saturating_add(1);
            if builders[builder_index].can_accept(candidate) {
                accepted_builder = Some(builder_index);
                break;
            }
        }
        if let Some(builder_index) = accepted_builder {
            builders[builder_index].accept(candidate_index, candidate);
        } else {
            builders.push(V2TemporalWindowGroupBuilder::new(
                candidate_index,
                candidate,
            ));
        }
    }
    let mut groups = builders
        .into_iter()
        .map(|mut builder| {
            builder.member_indices.sort_by(|left, right| {
                compare_v2_temporal_window_members(&candidates[*left], &candidates[*right])
                    .then_with(|| left.cmp(right))
            });
            V2TemporalWindowGroup {
                member_indices: builder.member_indices,
            }
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        compare_v2_temporal_window_members(
            &candidates[left.member_indices[0]],
            &candidates[right.member_indices[0]],
        )
        .then_with(|| left.member_indices[0].cmp(&right.member_indices[0]))
    });
    (groups, probe_count)
}

impl V2TemporalWindowGroupBuilder {
    fn new(candidate_index: usize, candidate: &V2TrackPairCandidate) -> Self {
        Self {
            member_indices: vec![candidate_index],
            min_scale: candidate.hypothesis.scale,
            max_scale: candidate.hypothesis.scale,
            source_intersection: candidate.global_source_interval,
            target_intersection: candidate.global_target_interval,
            max_source_length_ms: v2_presentation_range_length(candidate.global_source_interval),
            max_target_length_ms: v2_presentation_range_length(candidate.global_target_interval),
        }
    }

    fn can_accept(&self, candidate: &V2TrackPairCandidate) -> bool {
        let min_scale = self.min_scale.min(candidate.hypothesis.scale);
        let max_scale = self.max_scale.max(candidate.hypothesis.scale);
        if max_scale - min_scale > ALIGNMENT_V2_TEMPORAL_WINDOW_SCALE_TOLERANCE + f64::EPSILON * 4.0
        {
            return false;
        }
        let source_intersection = v2_intersect_presentation_ranges(
            self.source_intersection,
            candidate.global_source_interval,
        );
        let target_intersection = v2_intersect_presentation_ranges(
            self.target_intersection,
            candidate.global_target_interval,
        );
        let max_source_length_ms = self.max_source_length_ms.max(v2_presentation_range_length(
            candidate.global_source_interval,
        ));
        let max_target_length_ms = self.max_target_length_ms.max(v2_presentation_range_length(
            candidate.global_target_interval,
        ));
        v2_group_intersection_has_required_overlap(source_intersection, max_source_length_ms)
            && v2_group_intersection_has_required_overlap(target_intersection, max_target_length_ms)
    }

    fn accept(&mut self, candidate_index: usize, candidate: &V2TrackPairCandidate) {
        self.member_indices.push(candidate_index);
        self.min_scale = self.min_scale.min(candidate.hypothesis.scale);
        self.max_scale = self.max_scale.max(candidate.hypothesis.scale);
        self.source_intersection = v2_intersect_presentation_ranges(
            self.source_intersection,
            candidate.global_source_interval,
        );
        self.target_intersection = v2_intersect_presentation_ranges(
            self.target_intersection,
            candidate.global_target_interval,
        );
        self.max_source_length_ms = self.max_source_length_ms.max(v2_presentation_range_length(
            candidate.global_source_interval,
        ));
        self.max_target_length_ms = self.max_target_length_ms.max(v2_presentation_range_length(
            candidate.global_target_interval,
        ));
    }
}

fn compare_v2_temporal_window_geometry(
    left: &V2TrackPairCandidate,
    right: &V2TrackPairCandidate,
) -> std::cmp::Ordering {
    left.global_source_interval
        .start_ms
        .cmp(&right.global_source_interval.start_ms)
        .then_with(|| {
            left.global_target_interval
                .start_ms
                .cmp(&right.global_target_interval.start_ms)
        })
        .then_with(|| {
            left.global_source_interval
                .end_ms
                .cmp(&right.global_source_interval.end_ms)
        })
        .then_with(|| {
            left.global_target_interval
                .end_ms
                .cmp(&right.global_target_interval.end_ms)
        })
        .then_with(|| left.hypothesis.scale.total_cmp(&right.hypothesis.scale))
        .then_with(|| compare_v2_track_pair_candidates(left, right))
}

fn v2_presentation_range_length(range: PresentationRangeMs) -> i64 {
    range.end_ms.saturating_sub(range.start_ms).max(0)
}

fn v2_intersect_presentation_ranges(
    left: PresentationRangeMs,
    right: PresentationRangeMs,
) -> PresentationRangeMs {
    PresentationRangeMs {
        start_ms: left.start_ms.max(right.start_ms),
        end_ms: left.end_ms.min(right.end_ms),
    }
}

fn v2_group_intersection_has_required_overlap(
    intersection: PresentationRangeMs,
    longest_member_ms: i64,
) -> bool {
    let intersection_ms = v2_presentation_range_length(intersection);
    intersection_ms as f64 / longest_member_ms.max(1) as f64
        >= ALIGNMENT_V2_TEMPORAL_WINDOW_MIN_OVERLAP
}

fn compare_v2_temporal_window_members(
    left: &V2TrackPairCandidate,
    right: &V2TrackPairCandidate,
) -> std::cmp::Ordering {
    v2_global_candidate_weight(right)
        .total_cmp(&v2_global_candidate_weight(left))
        .then_with(|| compare_v2_track_pair_candidates(left, right))
}

#[cfg(test)]
pub(super) fn v2_pair_coarse_candidates_same_temporal_window(
    left: &V2TrackPairCandidate,
    right: &V2TrackPairCandidate,
) -> bool {
    v2_temporal_windows_same_location(
        left.hypothesis.scale,
        left.global_source_interval,
        left.global_target_interval,
        right.hypothesis.scale,
        right.global_source_interval,
        right.global_target_interval,
    )
}

#[cfg(test)]
pub(super) fn v2_temporal_windows_same_location(
    left_scale: f64,
    left_source: PresentationRangeMs,
    left_target: PresentationRangeMs,
    right_scale: f64,
    right_source: PresentationRangeMs,
    right_target: PresentationRangeMs,
) -> bool {
    if (left_scale - right_scale).abs()
        > ALIGNMENT_V2_TEMPORAL_WINDOW_SCALE_TOLERANCE + f64::EPSILON * 4.0
    {
        return false;
    }
    let left_source = (left_source.start_ms, left_source.end_ms);
    let right_source = (right_source.start_ms, right_source.end_ms);
    let source_overlap = v2_interval_overlap_ms(left_source, right_source);
    let longer_source = (left_source.1 - left_source.0)
        .max(right_source.1 - right_source.0)
        .max(1);
    let left_target = (left_target.start_ms, left_target.end_ms);
    let right_target = (right_target.start_ms, right_target.end_ms);
    let target_overlap = v2_interval_overlap_ms(left_target, right_target);
    let longer_target = (left_target.1 - left_target.0)
        .max(right_target.1 - right_target.0)
        .max(1);
    source_overlap as f64 / longer_source as f64 >= ALIGNMENT_V2_TEMPORAL_WINDOW_MIN_OVERLAP
        && target_overlap as f64 / longer_target as f64 >= ALIGNMENT_V2_TEMPORAL_WINDOW_MIN_OVERLAP
}

#[cfg(test)]
pub(super) fn v2_hypothesis_source_interval(hypothesis: &AffineHypothesis) -> (i64, i64) {
    (
        hypothesis.source_start_ms.min(hypothesis.source_end_ms),
        hypothesis.source_start_ms.max(hypothesis.source_end_ms),
    )
}

pub(super) fn v2_interval_overlap_ms(left: (i64, i64), right: (i64, i64)) -> i64 {
    left.1
        .min(right.1)
        .saturating_sub(left.0.max(right.0))
        .max(0)
}

pub(super) fn v2_global_candidate_weight(candidate: &V2TrackPairCandidate) -> f64 {
    let uniqueness_factor =
        0.35 + candidate.hypothesis.unique_source_coverage.clamp(0.0, 1.0) * 0.65;
    let alternative_bonus = candidate.intrinsic_margin.clamp(0.0, 1.0) * 0.20;
    let repeated_penalty = if candidate.repeated_content_only {
        ALIGNMENT_V2_GLOBAL_REPEATED_CONTENT_PENALTY
    } else {
        0.0
    };
    candidate.score.clamp(0.0, 1.0) * uniqueness_factor + alternative_bonus - repeated_penalty
}

pub(super) fn is_reasonable_audio_stream_pair(
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
) -> bool {
    !source.stream.is_commentary && !target.stream.is_commentary
}

pub(super) fn normalized_stream_language(language: Option<&str>) -> Option<String> {
    let normalized = language?
        .trim()
        .to_ascii_lowercase()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_string();
    if normalized.is_empty() || matches!(normalized.as_str(), "und" | "unknown" | "mul") {
        None
    } else {
        Some(
            match normalized.as_str() {
                "ja" | "jpn" => "ja",
                "zh" | "zho" | "chi" => "zh",
                "en" | "eng" => "en",
                "de" | "deu" | "ger" => "de",
                "fr" | "fra" | "fre" => "fr",
                "es" | "spa" => "es",
                "it" | "ita" => "it",
                "ko" | "kor" => "ko",
                "ru" | "rus" => "ru",
                "pt" | "por" => "pt",
                "ar" | "ara" => "ar",
                other => other,
            }
            .to_string(),
        )
    }
}

pub(super) fn v2_normalized_pcm_origin_ms(input: &AlignmentAudioInput) -> i64 {
    input
        .decode_timeline
        .as_ref()
        .map(|item| item.normalized_pcm_origin_ms)
        .unwrap_or(0)
}

pub(super) fn format_v2_decode_timeline_diagnostic(
    label: &str,
    input: &AlignmentAudioInput,
) -> String {
    let Some(timeline) = input.decode_timeline.as_ref() else {
        return format!("{label}缺少逐帧 PTS/skip-sample 证据。");
    };
    format!(
        "{label}音轨 #{}：first decoded PTS {:?} ms，PTS discontinuity {} 次，max gap {:?} ms，skip/discard samples={}/{}, normalized PCM origin {} ms。",
        input.stream.stream_index,
        timeline.first_decoded_pts_ms,
        timeline.pts_discontinuity_count,
        timeline.max_pts_gap_ms,
        timeline.skip_samples,
        timeline.discard_padding,
        timeline.normalized_pcm_origin_ms
    )
}

pub(super) fn v2_language_pair_prior(
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
) -> f64 {
    match (
        normalized_stream_language(source.stream.language.as_deref()),
        normalized_stream_language(target.stream.language.as_deref()),
    ) {
        (Some(source), Some(target)) if source == target => 0.04,
        (Some(_), Some(_)) => -0.04,
        _ => 0.0,
    }
}

pub(super) fn v2_default_stream_pair_prior(
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
) -> f64 {
    if source.explicit_stream_selection || target.explicit_stream_selection {
        return 0.0;
    }
    match (source.stream.is_default, target.stream.is_default) {
        (true, true) => 0.015,
        (false, true) => 0.010,
        (true, false) => -0.005,
        (false, false) => 0.0,
    }
}

pub(super) fn format_v2_audio_stream_choice(input: &AlignmentAudioInput) -> String {
    let language = normalized_stream_language(input.stream.language.as_deref())
        .unwrap_or_else(|| "未标记语言".to_string());
    let default = if input.stream.is_default {
        "，默认轨"
    } else {
        ""
    };
    format!("#{}（{}{}）", input.stream.stream_index, language, default)
}

// These arguments deliberately keep media identity, cancellation and memory-accounting

pub(super) fn v2_pcm_bytes_for_duration_ms(duration_ms: u64) -> Option<usize> {
    let samples = (duration_ms as u128)
        .checked_mul(ALIGNMENT_V2_SAMPLE_RATE as u128)?
        .checked_add(999)?
        / 1_000;
    let bytes = samples.checked_mul(std::mem::size_of::<i16>() as u128)?;
    usize::try_from(bytes).ok()
}

pub(super) fn v2_fine_window_pcm_decode_budget(
    range: PresentationRangeMs,
) -> Result<V2PcmDecodeBudget, String> {
    let duration_ms = v2_presentation_range_duration_ms(range)?;
    if duration_ms > ALIGNMENT_V2_COARSE_MAX_DURATION_MS {
        return Err(format!(
            "blocked:resource-limit：精解码窗口超过 {} 小时媒体安全上限。",
            ALIGNMENT_V2_COARSE_MAX_DURATION_MS / (60 * 60 * 1_000)
        ));
    }
    let duration_budget_ms = duration_ms
        .checked_add(ALIGNMENT_V2_FINE_WINDOW_DECODE_TOLERANCE_MS)
        .ok_or_else(|| "blocked:resource-limit：精解码 stdout 时长预算溢出。".to_string())?;
    let stdout_hard_limit_bytes = v2_pcm_bytes_for_duration_ms(duration_budget_ms)
        .ok_or_else(|| "blocked:resource-limit：精解码 stdout 字节预算无法表示。".to_string())?;
    Ok(V2PcmDecodeBudget {
        duration_budget_ms,
        stdout_hard_limit_bytes,
    })
}

pub(super) fn supervised_read_bounded_vec_capacity_upper_bound(
    hard_limit: usize,
) -> Result<usize, String> {
    hard_limit
        .checked_mul(2)
        .map(|doubled| doubled.max(SUPERVISED_READ_BOUNDED_INITIAL_CAPACITY_BYTES))
        .ok_or_else(|| "blocked:resource-limit：受监督 reader Vec capacity 上界溢出。".to_string())
}

pub(super) fn supervised_read_bounded_stderr_capacity_upper_bound() -> Result<usize, String> {
    supervised_read_bounded_vec_capacity_upper_bound(ALIGNMENT_V2_MAX_STDERR_BYTES)
}

pub(super) fn v2_presentation_range_duration_ms(range: PresentationRangeMs) -> Result<u64, String> {
    let duration = range
        .end_ms
        .checked_sub(range.start_ms)
        .ok_or_else(|| "blocked:resource-limit：精解码窗口时长溢出。".to_string())?;
    u64::try_from(duration)
        .map_err(|_| "blocked:resource-limit：精解码窗口必须是正毫秒区间。".to_string())
        .and_then(|duration| {
            if duration == 0 {
                Err("blocked:resource-limit：精解码窗口不能为空。".to_string())
            } else {
                Ok(duration)
            }
        })
}

pub(super) fn v2_resource_checked_sum(parts: &[usize], label: &str) -> Result<usize, String> {
    parts.iter().try_fold(0_usize, |total, part| {
        total
            .checked_add(*part)
            .ok_or_else(|| format!("blocked:resource-limit：{label}内存上界溢出。"))
    })
}

pub(super) fn v2_resource_checked_product(parts: &[usize], label: &str) -> Result<usize, String> {
    parts.iter().try_fold(1_usize, |total, part| {
        total
            .checked_mul(*part)
            .ok_or_else(|| format!("blocked:resource-limit：{label}内存上界溢出。"))
    })
}

pub(super) fn v2_fine_feature_bytes(frame_count: usize) -> Result<usize, String> {
    let bytes_per_frame = std::mem::size_of::<FineFeatureFrame>()
        .checked_add(
            ALIGNMENT_V2_FINE_FEATURE_VALUE_COUNT
                .checked_mul(std::mem::size_of::<f32>())
                .ok_or_else(|| {
                    "blocked:resource-limit：fine feature value 上界溢出。".to_string()
                })?,
        )
        .ok_or_else(|| "blocked:resource-limit：fine feature frame 上界溢出。".to_string())?;
    v2_resource_checked_product(&[frame_count, bytes_per_frame], "fine feature")
}

pub(super) fn v2_cuda_fft_batch_transient_upper_bound_bytes() -> Result<usize, String> {
    let device =
        CudaFftMemoryBudget::for_batch(CUDA_FFT_DEFAULT_BATCH_FRAMES).map_err(|error| {
            format!(
                "blocked:resource-limit：CUDA FFT 批次显存上界无法建立：{:?}: {}",
                error.code, error.message
            )
        })?;
    // `transform_batch_inner` first downloads `Vec<cufft_sys::float2>` and then collects a
    // `Vec<CudaComplex32>`. The allocator may optimize that conversion in place, but admission
    // cannot depend on an implementation detail, so both pageable host output Vecs are charged.
    let double_host_output_bytes = device
        .output_bytes
        .checked_mul(2)
        .ok_or_else(|| "blocked:resource-limit：CUDA FFT 双主机输出上界溢出。".to_string())?;
    let host_batch_bytes = v2_resource_checked_sum(
        &[
            device.input_bytes,
            double_host_output_bytes,
            v2_resource_checked_product(
                &[CUDA_FFT_DEFAULT_BATCH_FRAMES, std::mem::size_of::<f64>()],
                "CUDA FFT RMS",
            )?,
        ],
        "CUDA FFT 主机批次",
    )?;
    v2_resource_checked_sum(
        &[device.worst_case_total_device_bytes, host_batch_bytes],
        "CUDA FFT 主机与显存合计",
    )
}

pub(super) fn v2_fine_window_artifact_upper_bound(
    range: PresentationRangeMs,
) -> Result<usize, String> {
    let duration_ms = v2_presentation_range_duration_ms(range)?;
    let decode_budget = v2_fine_window_pcm_decode_budget(range)?;
    let frame_count =
        usize::try_from(u128::from(duration_ms).div_ceil(u128::from(ALIGNMENT_V2_FINE_HOP_MS)))
            .map_err(|_| "blocked:resource-limit：精解码窗口细特征帧数无法表示。".to_string())?;
    let fine_bytes = v2_fine_feature_bytes(frame_count)
        .map_err(|_| "blocked:resource-limit：精解码窗口细特征上界溢出。".to_string())?;
    let decode_phase_bytes = v2_resource_checked_sum(
        &[
            supervised_read_bounded_vec_capacity_upper_bound(
                decode_budget.stdout_hard_limit_bytes,
            )?,
            decode_budget.stdout_hard_limit_bytes,
            supervised_read_bounded_stderr_capacity_upper_bound()?,
        ],
        "精解码 read_bounded 与 parsed PCM 阶段",
    )?;
    let analysis_phase_bytes = v2_resource_checked_sum(
        &[decode_budget.stdout_hard_limit_bytes, fine_bytes],
        "精解码 PCM 与 fine feature 阶段",
    )?;
    Ok(decode_phase_bytes.max(analysis_phase_bytes))
}

pub(super) fn v2_fine_window_resident_upper_bound(
    range: PresentationRangeMs,
) -> Result<usize, String> {
    let duration_ms = v2_presentation_range_duration_ms(range)?;
    let decode_budget = v2_fine_window_pcm_decode_budget(range)?;
    let frame_count =
        usize::try_from(u128::from(duration_ms).div_ceil(u128::from(ALIGNMENT_V2_FINE_HOP_MS)))
            .map_err(|_| {
                "blocked:resource-limit：精解码窗口常驻细特征帧数无法表示。".to_string()
            })?;
    let fine_bytes = v2_fine_feature_bytes(frame_count)
        .map_err(|_| "blocked:resource-limit：精解码窗口常驻细特征上界溢出。".to_string())?;
    v2_resource_checked_sum(
        &[decode_budget.stdout_hard_limit_bytes, fine_bytes],
        "精解码 PCM 与 fine feature 常驻制品",
    )
}

pub(super) fn v2_fine_feature_resident_upper_bound(
    range: PresentationRangeMs,
) -> Result<usize, String> {
    let duration_ms = v2_presentation_range_duration_ms(range)?;
    let frame_count =
        usize::try_from(u128::from(duration_ms).div_ceil(u128::from(ALIGNMENT_V2_FINE_HOP_MS)))
            .map_err(|_| {
                "blocked:resource-limit：精解码窗口常驻细特征帧数无法表示。".to_string()
            })?;
    v2_fine_feature_bytes(frame_count)
        .map_err(|_| "blocked:resource-limit：精解码窗口常驻细特征上界溢出。".to_string())
}

pub(super) fn v2_selected_fine_phase_peak_upper_bound(
    baseline_bytes: usize,
    plan: &V2SelectedFineDecodePlan,
    source_input: &AlignmentAudioInput,
    target_input: &AlignmentAudioInput,
    cuda_transient_bytes: usize,
) -> Result<usize, String> {
    let mut retained = baseline_bytes;
    let mut peak = baseline_bytes;
    for (input, axis_plan) in [
        (source_input, &plan.source_axis),
        (target_input, &plan.target_axis),
    ] {
        if !should_stream_v2_coarse_only(input) {
            continue;
        }
        let extraction_peak = axis_plan
            .tiles
            .iter()
            .map(|tile| v2_fine_window_artifact_upper_bound(*tile))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap_or(0);
        // Only irreversible fine features accumulate across tiles. Reversible PCM and FFmpeg
        // stdout are released after each tile and are decoded again in small local windows only
        // when a candidate edit boundary needs correlation refinement.
        let resident = v2_fine_feature_resident_upper_bound(axis_plan.full_window)?;
        let extraction_with_backend =
            extraction_peak.max(
                v2_fine_window_resident_upper_bound(*axis_plan.tiles.first().ok_or_else(
                    || "blocked:resource-limit：long fine tile 计划为空。".to_string(),
                )?)?
                .checked_add(cuda_transient_bytes)
                .ok_or_else(|| "blocked:resource-limit：fine CUDA 阶段峰值溢出。".to_string())?,
            );
        peak = peak.max(
            retained
                .checked_add(extraction_with_backend)
                .ok_or_else(|| "blocked:resource-limit：fine 顺序解码阶段峰值溢出。".to_string())?,
        );
        retained = retained
            .checked_add(resident)
            .ok_or_else(|| "blocked:resource-limit：fine feature 常驻累计上界溢出。".to_string())?;
        peak = peak.max(retained);
    }
    Ok(peak)
}

pub(super) fn v2_cuda_fine_transient_upper_bound_bytes() -> Result<usize, String> {
    // Source and target fine extraction are sequential, so one complete CUDA batch is the
    // whole-run transient peak rather than one batch per axis.
    v2_cuda_fft_batch_transient_upper_bound_bytes()
}

pub(super) fn v2_selected_fine_cuda_transient_upper_bound(
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
) -> Result<usize, String> {
    for artifact in [source_artifact, target_artifact] {
        if artifact.fine_features.is_some() {
            continue;
        }
        let request = lock_fine_spectral_backend_request(&artifact.spectral_backend)?;
        if request.planned_backend_id == CUDA_FFT_BACKEND_ID {
            return v2_cuda_fine_transient_upper_bound_bytes();
        }
    }
    Ok(0)
}

pub(super) fn should_stream_v2_coarse_only(input: &AlignmentAudioInput) -> bool {
    input
        .media_duration_ms
        .is_none_or(|duration| duration > ALIGNMENT_V2_MAX_DURATION_MS)
}

pub(super) fn ensure_v2_active_artifact_budget(
    retained_bytes: usize,
    additional_bytes: usize,
) -> Result<usize, String> {
    let next = retained_bytes
        .checked_add(additional_bytes)
        .ok_or_else(|| "blocked:resource-limit：候选音轨制品驻留字节溢出。".to_string())?;
    if next > MAX_V2_ACTIVE_ARTIFACT_BYTES {
        return Err(format!(
            "blocked:resource-limit：候选音轨制品的单次驻留预算为 {} MiB（既有 {} MiB + 新增 {} MiB），超过 {} MiB 硬门；请显式选择需要比较的音轨。",
            next.div_ceil(1024 * 1024),
            retained_bytes.div_ceil(1024 * 1024),
            additional_bytes.div_ceil(1024 * 1024),
            MAX_V2_ACTIVE_ARTIFACT_BYTES / (1024 * 1024),
        ));
    }
    Ok(next)
}

pub(super) fn v2_coarse_candidate_reserved_bytes(candidate_count: usize) -> Result<usize, String> {
    candidate_count
        .checked_mul(ALIGNMENT_V2_COARSE_CANDIDATE_RESERVED_BYTES)
        .ok_or_else(|| {
            "blocked:resource-limit：coarse affine candidate 驻留字节上界溢出。".to_string()
        })
}

pub(super) fn v2_materialized_anchor_resident_bytes(
    hypothesis: &AffineHypothesis,
) -> Result<usize, String> {
    hypothesis
        .training_anchors
        .capacity()
        .checked_add(hypothesis.held_out_anchors.capacity())
        .and_then(|anchor_count| {
            anchor_count.checked_mul(std::mem::size_of::<AffineAnchorEvidence>())
        })
        .ok_or_else(|| {
            "blocked:resource-limit：materialized affine anchor 驻留字节溢出。".to_string()
        })
}

pub(super) fn plan_v2_selected_fine_decode(
    pair: &V2TrackPairCandidate,
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
) -> Result<Option<V2SelectedFineDecodePlan>, String> {
    let source_requires_window = should_stream_v2_coarse_only(&pair.source_input);
    let target_requires_window = should_stream_v2_coarse_only(&pair.target_input);
    if !source_requires_window && !target_requires_window {
        return Ok(None);
    }

    let target_query = v2_selected_candidate_target_query(
        pair,
        source_artifact.presentation_bounds,
        target_artifact.presentation_bounds,
    )?;

    // Grow useful context first, then let the phase-aware 1 GiB ledger decide whether the complete
    // windows fit. The helper also unions the complete coarse source support, so internal
    // source-only edits wider than the guard cannot be clipped. If even the mandatory DP/boundary
    // context does not fit the media safety boundary, fail closed instead of truncating the map.
    let mut guard_ms = 5 * 60_000_i64;
    let mut selected = None;
    while guard_ms >= ALIGNMENT_V2_FINE_WINDOW_GUARD_MS {
        let windows = derive_affine_fine_decode_windows(
            &pair.hypothesis,
            &AffineFineWindowRequest {
                source_bounds: source_artifact.presentation_bounds,
                target_bounds: target_artifact.presentation_bounds,
                target_query,
                source_guard_ms: guard_ms,
                target_guard_ms: guard_ms,
            },
        )?;
        let source_window_duration = v2_presentation_range_duration_ms(windows.source)?;
        let target_window_duration = v2_presentation_range_duration_ms(windows.target)?;
        if source_window_duration <= ALIGNMENT_V2_COARSE_MAX_DURATION_MS
            && target_window_duration <= ALIGNMENT_V2_COARSE_MAX_DURATION_MS
        {
            selected = Some(V2SelectedFineDecodePlan {
                windows,
                adaptive_guard_ms: guard_ms,
                source_axis: plan_bounded_fine_axis(windows.source)?,
                target_axis: plan_bounded_fine_axis(windows.target)?,
            });
            break;
        }
        guard_ms = guard_ms.saturating_sub(1_000);
    }
    selected.ok_or_else(|| {
        "blocked:resource-limit：完整候选逆投影、全部 coarse inlier support 与 edit-aware DP 必需上下文超过媒体安全边界；未截断成功。"
            .to_string()
    })
    .map(Some)
}

pub(super) fn derive_v2_selected_candidate_content_intervals(
    pair: &V2TrackPairCandidate,
    source_artifact: &CachedV2Landmarks,
    target_artifact: &CachedV2Landmarks,
) -> Result<AffineFineDecodeWindows, String> {
    let target_query = v2_selected_candidate_target_query(
        pair,
        source_artifact.presentation_bounds,
        target_artifact.presentation_bounds,
    )?;
    derive_affine_fine_decode_windows(
        &pair.hypothesis,
        &AffineFineWindowRequest {
            source_bounds: source_artifact.presentation_bounds,
            target_bounds: target_artifact.presentation_bounds,
            target_query,
            source_guard_ms: 0,
            target_guard_ms: 0,
        },
    )
}

pub(super) fn v2_selected_candidate_target_query(
    pair: &V2TrackPairCandidate,
    source_bounds: PresentationRangeMs,
    target_bounds: PresentationRangeMs,
) -> Result<PresentationRangeMs, String> {
    let source_duration_ms = v2_presentation_range_duration_ms(source_bounds)?;
    let target_duration_ms = v2_presentation_range_duration_ms(target_bounds)?;

    let affine_query = if target_duration_ms <= source_duration_ms {
        // A complete shorter target (the usual one long reference -> one episode case) defines
        // the requested content. The source-side inverse projection and guard still preserve
        // reference-only edits around it.
        target_bounds
    } else if source_duration_ms <= ALIGNMENT_V2_COARSE_MAX_DURATION_MS {
        // For many short uploaded fragments against one long original, decoding the complete
        // target would turn an 11-minute comparison into a multi-hour resident artifact. Project
        // the complete shorter source instead. The guarded fine window still includes surrounding
        // target-only material and the DP keeps an unrelated source outro ambiguous.
        project_v2_source_range_to_target(source_bounds, &pair.hypothesis)?
    } else {
        return Err(
            "blocked:window-evidence-insufficient：粗定位两侧都超过媒体安全边界，无法用完整一侧定义精对齐查询；系统不会把局部 inlier support 冒充完整时间图。"
                .to_string(),
        );
    };

    // A piecewise coarse candidate deliberately keeps the first island's affine offset as its
    // bootstrap. Later islands can have a different offset after inserted/removed material, so
    // the single affine projection alone may clip them. Union all training-anchor target support
    // into the query; fine DP will use the island-local coordinates to cross each edit.
    let anchor_start_ms = (pair.offset_island_count > 1)
        .then(|| {
            pair.hypothesis
                .training_anchors
                .iter()
                .map(|anchor| anchor.target_time_ms)
                .min()
        })
        .flatten();
    let anchor_end_ms = (pair.offset_island_count > 1)
        .then(|| {
            pair.hypothesis
                .training_anchors
                .iter()
                .map(|anchor| anchor.target_time_ms)
                .max()
        })
        .flatten();
    let start_ms = anchor_start_ms
        .map(|value| affine_query.start_ms.min(value))
        .unwrap_or(affine_query.start_ms)
        .max(target_bounds.start_ms);
    let end_ms = anchor_end_ms
        .map(|value| affine_query.end_ms.max(value))
        .unwrap_or(affine_query.end_ms)
        .min(target_bounds.end_ms);
    if end_ms <= start_ms {
        return Err("粗定位候选与真实 training anchor 没有形成非空目标查询区间。".to_string());
    }
    Ok(PresentationRangeMs { start_ms, end_ms })
}

pub(super) fn project_v2_source_range_to_target(
    source: PresentationRangeMs,
    hypothesis: &AffineHypothesis,
) -> Result<PresentationRangeMs, String> {
    if !hypothesis.scale.is_finite() || hypothesis.scale <= 0.0 {
        return Err("粗定位 affine scale 必须是有限正数。".to_string());
    }
    let projected_start = hypothesis.scale * source.start_ms as f64 + hypothesis.offset_ms as f64;
    let projected_end = hypothesis.scale * source.end_ms as f64 + hypothesis.offset_ms as f64;
    if !projected_start.is_finite() || !projected_end.is_finite() {
        return Err("粗定位 affine 正向投影产生了非有限时间。".to_string());
    }
    let start_ms = v2_checked_f64_milliseconds(projected_start.min(projected_end), f64::floor)?;
    let end_ms = v2_checked_f64_milliseconds(projected_start.max(projected_end), f64::ceil)?;
    if end_ms <= start_ms {
        return Err("粗定位 affine 正向投影没有形成非空目标区间。".to_string());
    }
    Ok(PresentationRangeMs { start_ms, end_ms })
}

pub(super) fn v2_checked_f64_milliseconds(
    value: f64,
    round: fn(f64) -> f64,
) -> Result<i64, String> {
    let rounded = round(value);
    if !rounded.is_finite() || rounded < i64::MIN as f64 || rounded > i64::MAX as f64 {
        return Err("粗定位 affine 投影毫秒值超出 i64 范围。".to_string());
    }
    Ok(rounded as i64)
}

fn affine_temporal_coverage(
    hypothesis: &AffineHypothesis,
    target_landmarks: &[SpectralLandmark],
    target_offset_ms: i64,
) -> f64 {
    let target_start = target_landmarks
        .first()
        .map(|item| item.time_ms)
        .unwrap_or(target_offset_ms);
    let target_end = target_landmarks
        .last()
        .map(|item| item.time_ms)
        .unwrap_or(target_start);
    let projected_start =
        hypothesis.scale * hypothesis.source_start_ms as f64 + hypothesis.offset_ms as f64;
    let projected_end =
        hypothesis.scale * hypothesis.source_end_ms as f64 + hypothesis.offset_ms as f64;
    let overlap_start = projected_start.min(projected_end).max(target_start as f64);
    let overlap_end = projected_start.max(projected_end).min(target_end as f64);
    ((overlap_end - overlap_start).max(0.0) / (target_end - target_start).max(1) as f64)
        .clamp(0.0, 1.0)
}

pub(super) fn score_v2_track_pair(
    hypothesis: &AffineHypothesis,
    temporal_coverage: f64,
    config: &AffineMatchConfig,
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
) -> f64 {
    let support = (hypothesis.inlier_count as f64 / 24.0).clamp(0.0, 1.0);
    let residual = (1.0 - hypothesis.p95_residual_ms as f64 / config.residual_tolerance_ms as f64)
        .clamp(0.0, 1.0);
    (temporal_coverage * 0.55
        + support * 0.25
        + hypothesis.unique_target_coverage.clamp(0.0, 1.0) * 0.10
        + residual * 0.10
        + v2_language_pair_prior(source, target)
        + v2_default_stream_pair_prior(source, target))
    .clamp(0.0, 1.0)
}

pub(super) fn v2_affine_has_competing_repeated_location(
    hypotheses: &[AffineHypothesis],
    margin: f64,
) -> bool {
    let (Some(best), Some(alternative)) = (hypotheses.first(), hypotheses.get(1)) else {
        return false;
    };
    if margin >= ALIGNMENT_V2_MIN_TRACK_MARGIN
        || alternative.inlier_count * 4 < best.inlier_count * 3
    {
        return false;
    }
    let midpoint = (best.source_start_ms.saturating_add(best.source_end_ms)) as f64 / 2.0;
    let best_location = best.scale * midpoint + best.offset_ms as f64;
    let alternative_location = alternative.scale * midpoint + alternative.offset_ms as f64;
    (best_location - alternative_location).abs() >= 10_000.0
}

#[cfg(test)]
pub(super) fn v2_alternative_track_score(
    candidate: &V2TrackPairCandidate,
) -> AudioAlternativeTrackScoreDto {
    AudioAlternativeTrackScoreDto {
        source_stream_index: candidate.source_input.stream.stream_index,
        target_stream_index: candidate.target_input.stream.stream_index,
        score: candidate.score,
        scale: candidate.hypothesis.scale,
        offset_ms: candidate.hypothesis.offset_ms,
        inlier_count: candidate.hypothesis.inlier_count,
    }
}

pub(super) fn v2_alternative_hypothesis_score(
    source: &AlignmentAudioInput,
    target: &AlignmentAudioInput,
    hypothesis: &AffineHypothesis,
    score: f64,
) -> AudioAlternativeTrackScoreDto {
    AudioAlternativeTrackScoreDto {
        source_stream_index: source.stream.stream_index,
        target_stream_index: target.stream.stream_index,
        score,
        scale: hypothesis.scale,
        offset_ms: hypothesis.offset_ms,
        inlier_count: hypothesis.inlier_count,
    }
}

pub(super) fn v2_dp_workspace_upper_bound(
    cell_count: usize,
    source_frame_count: usize,
    target_frame_count: usize,
) -> Result<usize, String> {
    let parents = cell_count
        .checked_mul(ALIGNMENT_V2_DP_PARENT_BYTES_PER_CELL)
        .ok_or_else(|| "blocked:resource-limit：V2 DP parent plane 上界溢出。".to_string())?;
    let rolling_width = target_frame_count
        .checked_add(1)
        .ok_or_else(|| "blocked:resource-limit：V2 DP rolling row 宽度溢出。".to_string())?;
    let rolling_costs = rolling_width
        .checked_mul(ALIGNMENT_V2_DP_ROLLING_COST_ROW_COUNT)
        .and_then(|value| value.checked_mul(std::mem::size_of::<i64>()))
        .ok_or_else(|| "blocked:resource-limit：V2 DP rolling cost rows 上界溢出。".to_string())?;
    let norm_frame_count = source_frame_count
        .checked_add(target_frame_count)
        .ok_or_else(|| "blocked:resource-limit：V2 DP feature norm 帧数溢出。".to_string())?;
    let norms = norm_frame_count
        .checked_mul(std::mem::size_of::<f64>())
        .ok_or_else(|| "blocked:resource-limit：V2 DP feature norm 上界溢出。".to_string())?;
    let path_steps = source_frame_count
        .checked_add(target_frame_count)
        .and_then(|value| value.checked_add(2))
        .ok_or_else(|| "blocked:resource-limit：V2 DP path step 上界溢出。".to_string())?;
    let path = path_steps
        .checked_mul(ALIGNMENT_V2_DP_PATH_BYTES_PER_STEP)
        .ok_or_else(|| "blocked:resource-limit：V2 DP path workspace 上界溢出。".to_string())?;
    parents
        .checked_add(rolling_costs)
        .and_then(|value| value.checked_add(norms))
        .and_then(|value| value.checked_add(path))
        .and_then(|value| value.checked_add(ALIGNMENT_V2_DP_WORKSPACE_SLACK_BYTES))
        .ok_or_else(|| "blocked:resource-limit：V2 DP 总 workspace 上界溢出。".to_string())
}

pub(super) fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(AUDIO_ALIGNMENT_CANCELLED.to_string());
    }
    Ok(())
}

pub(super) fn create_v2_span(
    kind: AudioTimeMapSpanKind,
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
) -> AudioTimeMapSpanDto {
    let reason = match kind {
        AudioTimeMapSpanKind::Matched => {
            "edit-aware DP 将该范围识别为双轴共同内容；仍需逐段锚点证据复核。"
        }
        AudioTimeMapSpanKind::SourceOnly => {
            "edit-aware DP 将该范围识别为仅参考视频存在；两侧边界必须分别验证。"
        }
        AudioTimeMapSpanKind::TargetOnly => {
            "edit-aware DP 将该范围识别为仅目标原片存在；两侧边界必须分别验证。"
        }
        AudioTimeMapSpanKind::Ambiguous => {
            "现有证据不能唯一决定该范围的时间映射，禁止把它当作已确认共同内容。"
        }
    }
    .to_string();
    let boundaries = create_initial_v2_span_boundaries(
        kind,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
    );
    AudioTimeMapSpanDto {
        id: String::new(),
        kind,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        reason: reason.clone(),
        quality: AudioTimeMapSpanQualityDto {
            level: "blocked",
            metric_source: "measured",
            probability: None,
            coverage: None,
            unique_content_coverage: None,
            alternative_margin: None,
            anchor_count: 0,
            held_out_anchor_count: 0,
            p50_residual_ms: None,
            p95_residual_ms: None,
            p99_residual_ms: None,
            max_residual_ms: None,
            boundary_uncertainty_ms: None,
            left_support: AudioTimeMapSpanSupportStatus::Unsupported,
            right_support: AudioTimeMapSpanSupportStatus::Unsupported,
            signals: AudioTimeMapSpanSignalsDto {
                audio: AudioTimeMapSignalStatus::Blocked,
                visual: AudioTimeMapSignalStatus::Blocked,
                danmaku: AudioTimeMapSignalStatus::Blocked,
            },
            reasons: vec![reason],
        },
        boundaries,
        alternatives: Vec::new(),
    }
}

pub(super) fn is_v2_edit_span(kind: AudioTimeMapSpanKind) -> bool {
    matches!(
        kind,
        AudioTimeMapSpanKind::SourceOnly | AudioTimeMapSpanKind::TargetOnly
    )
}

pub(super) fn format_v2_span_kind(kind: AudioTimeMapSpanKind) -> &'static str {
    match kind {
        AudioTimeMapSpanKind::Matched => "matched",
        AudioTimeMapSpanKind::SourceOnly => "sourceOnly",
        AudioTimeMapSpanKind::TargetOnly => "targetOnly",
        AudioTimeMapSpanKind::Ambiguous => "ambiguous",
    }
}

pub(super) fn persistent_error_category(error: &str) -> String {
    let trimmed = error.trim();
    if trimmed == AUDIO_ALIGNMENT_CANCELLED {
        return "cancelled".to_string();
    }
    let category = trimmed
        .split(['：', ':'])
        .next()
        .unwrap_or("unknown")
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect::<String>();
    if category.is_empty() {
        "internal".to_string()
    } else {
        category
    }
}

fn create_initial_v2_span_boundaries(
    kind: AudioTimeMapSpanKind,
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
) -> AudioTimeMapSpanBoundariesDto {
    let (status, axis, start_ms, end_ms, reason) = match kind {
        AudioTimeMapSpanKind::SourceOnly => (
            AudioTimeMapBoundaryStatus::Unsupported,
            AudioTimeMapBoundaryAxis::Source,
            Some(source_start_ms),
            Some(source_end_ms),
            "尚未获得单侧共同音频支持，粗 DP 边界不能视为精确时间。",
        ),
        AudioTimeMapSpanKind::TargetOnly => (
            AudioTimeMapBoundaryStatus::Unsupported,
            AudioTimeMapBoundaryAxis::Target,
            Some(target_start_ms),
            Some(target_end_ms),
            "尚未获得单侧共同音频支持，粗 DP 边界不能视为精确时间。",
        ),
        AudioTimeMapSpanKind::Ambiguous => (
            AudioTimeMapBoundaryStatus::Ambiguous,
            AudioTimeMapBoundaryAxis::Both,
            None,
            None,
            "该 span 本身存在歧义，不能声明精确边界。",
        ),
        AudioTimeMapSpanKind::Matched => (
            AudioTimeMapBoundaryStatus::NotApplicable,
            AudioTimeMapBoundaryAxis::Both,
            None,
            None,
            "共同内容 span 不把 DP 分块接缝声明为版本差异边界。",
        ),
    };
    let create = |context_side, coarse_ms| AudioTimeMapBoundaryEvidenceDto {
        status,
        axis,
        context_side,
        coarse_ms,
        refined_ms: None,
        uncertainty_start_ms: None,
        uncertainty_end_ms: None,
        support_duration_ms: 0,
        correlation: None,
        alternative_margin: None,
        reason: reason.to_string(),
    };
    let is_edit = is_v2_edit_span(kind);
    AudioTimeMapSpanBoundariesDto {
        start: create(is_edit.then_some("before"), start_ms),
        end: create(is_edit.then_some("after"), end_ms),
    }
}

pub(super) fn solve_selected_fine_path(
    input: V2SelectedFinePathInput<'_>,
) -> Result<V2ChunkAlignment, String> {
    let V2SelectedFinePathInput {
        source_frames,
        target_frames,
        selected_candidate_hypothesis: coarse,
        max_dp_cells,
        active_artifact_bytes,
        cancel_flag,
    } = input;
    let allowed_cells = max_dp_cells.min(ALIGNMENT_V2_MAX_DP_CELLS);
    let mut forward = align_v2_feature_chunks_one_way(
        source_frames,
        target_frames,
        coarse,
        allowed_cells,
        active_artifact_bytes,
        cancel_flag,
    )?;
    if forward
        .spans
        .iter()
        .all(|span| span.kind == AudioTimeMapSpanKind::Matched)
    {
        forward.path_checkpoints.push(
            "fine bidirectional consistency：正向路径全部为共同内容，无差异区间需要二次反向求解。"
                .to_string(),
        );
        return Ok(forward);
    }

    let reverse_coarse = inverse_affine_hypothesis(coarse)?;
    let reverse = match align_v2_feature_chunks_one_way(
        target_frames,
        source_frames,
        &reverse_coarse,
        allowed_cells,
        active_artifact_bytes,
        cancel_flag,
    ) {
        Ok(reverse) => reverse,
        Err(error) => {
            check_cancelled(cancel_flag)?;
            forward.path_checkpoints.push(format!(
                "fine bidirectional consistency：反向独立求解失败，保留正向保守结论；category={}。",
                persistent_error_category(&error)
            ));
            return Ok(forward);
        }
    };
    let reverse_spans = reverse
        .spans
        .iter()
        .map(swap_v2_time_map_span_axes)
        .collect::<Vec<_>>();
    let reverse_is_conclusive = v2_reverse_path_is_conclusive(&reverse_spans);
    let mut demoted_count = 0usize;
    for span in &mut forward.spans {
        if !reverse_is_conclusive
            || !is_v2_edit_span(span.kind)
            || reverse_spans
                .iter()
                .any(|reverse_span| v2_edit_spans_reciprocally_agree(span, reverse_span))
        {
            continue;
        }
        *span = create_v2_span(
            AudioTimeMapSpanKind::Ambiguous,
            span.source_start_ms,
            span.source_end_ms,
            span.target_start_ms,
            span.target_end_ms,
        );
        demoted_count = demoted_count.saturating_add(1);
    }
    if reverse_is_conclusive {
        forward
            .fine_evidence
            .extend(reverse.fine_evidence.iter().map(swap_v2_fine_evidence_axes));
    }
    let recovered_notes =
        recover_v2_dense_offset_steps(&mut forward.spans, &forward.fine_evidence, coarse.scale);
    for span in &mut forward.spans {
        span.boundaries = create_initial_v2_span_boundaries(
            span.kind,
            span.source_start_ms,
            span.source_end_ms,
            span.target_start_ms,
            span.target_end_ms,
        );
    }
    validate_v2_time_map_spans(&forward.spans)?;
    let reverse_edit_count = reverse_spans
        .iter()
        .filter(|span| is_v2_edit_span(span.kind))
        .count();
    forward.path_checkpoints.push(format!(
        "fine bidirectional consistency：对非纯共同路径完成反向独立 DP；反向路径可判定={reverse_is_conclusive}，提出 {reverse_edit_count} 个单轴差异，撤销 {demoted_count} 个只有单向支持的差异结论；只有可判定反向路径的连续证据才并入概率图。"
    ));
    forward.path_checkpoints.extend(recovered_notes);
    Ok(forward)
}

fn align_v2_feature_chunks_one_way(
    source_frames: &[FineFeatureFrame],
    target_frames: &[FineFeatureFrame],
    coarse: &AffineHypothesis,
    allowed_cells: usize,
    active_artifact_bytes: usize,
    cancel_flag: Option<&AtomicBool>,
) -> Result<V2ChunkAlignment, String> {
    if source_frames.is_empty() || target_frames.is_empty() || coarse.scale <= 0.0 {
        return Err("Alignment V2 分块输入为空或 affine scale 无效。".to_string());
    }
    let target_hop_ms = estimate_v2_hop_ms(target_frames);
    let chunk_frame_count = (ALIGNMENT_V2_DP_CHUNK_MS / target_hop_ms).max(1) as usize;
    let inverse = inverse_affine_hypothesis(coarse)?;
    let mut spans = Vec::<AudioTimeMapSpanDto>::new();
    let mut piecewise_anchor_runs = Vec::<V2TrustedFineAnchorStep>::new();
    let mut path_checkpoints = Vec::<String>::new();
    let mut fine_evidence = Vec::<V2FineEvidenceObservation>::new();
    let mut matched_step_count = 0usize;
    let mut ambiguous_step_count = 0usize;
    let mut target_start_index = 0usize;
    let mut previous_source_end_ms: Option<i64> = None;
    let mut pending_uncertain_target_start_ms: Option<i64> = None;
    let mut pending_has_scattered_common_content = false;
    while target_start_index < target_frames.len() {
        check_cancelled(cancel_flag)?;
        let target_end_index = (target_start_index + chunk_frame_count).min(target_frames.len());
        let target_chunk = &target_frames[target_start_index..target_end_index];
        let target_start_ms = target_chunk
            .first()
            .ok_or_else(|| "V2 目标分块为空。".to_string())?
            .time_ms;
        let target_end_ms = target_chunk
            .last()
            .ok_or_else(|| "V2 目标分块为空。".to_string())?
            .time_ms
            .saturating_add(target_hop_ms);
        let anchor_guided_inverse = v2_bracketing_anchor_inverse_for_target_chunk(
            coarse,
            &inverse,
            target_start_ms,
            target_end_ms,
        );
        let recursive_chunk = previous_source_end_ms.is_some() && anchor_guided_inverse.is_none();
        let corridor_kind = if anchor_guided_inverse.is_some() {
            "bracketed-anchor"
        } else if recursive_chunk {
            "recursive-recovery"
        } else {
            "coarse-affine"
        };
        let chunk_ordinal = target_start_index / chunk_frame_count + 1;
        let (source_lower_ms, source_upper_ms, chunk_inverse) =
            if let Some(anchor_inverse) = anchor_guided_inverse {
                let predicted_source_start = anchor_inverse.scale * target_start_ms as f64
                    + anchor_inverse.offset_ms as f64
                    - ALIGNMENT_V2_DP_BAND_RADIUS_MS as f64;
                let predicted_source_end = anchor_inverse.scale * target_end_ms as f64
                    + anchor_inverse.offset_ms as f64
                    + ALIGNMENT_V2_DP_BAND_RADIUS_MS as f64;
                (
                    previous_source_end_ms
                        .unwrap_or(i64::MIN)
                        .max(predicted_source_start.floor() as i64),
                    predicted_source_end.ceil() as i64,
                    anchor_inverse,
                )
            } else if let Some(previous_source_end_ms) = previous_source_end_ms {
                // Re-anchor each chunk at the last confirmed source position. A target-only edit
                // therefore advances the target axis without accumulating the global affine
                // error; the following chunk starts from the same source cursor and can recover
                // after edits substantially wider than the local ±30 s DP band.
                let expected_source_advance_ms = ((target_end_ms - target_start_ms) as f64
                    * inverse.scale)
                    .ceil()
                    .max(1.0) as i64;
                let mut recursive = inverse.clone();
                recursive.offset_ms = (previous_source_end_ms as f64
                    - recursive.scale * target_start_ms as f64)
                    .round() as i64;
                (
                    previous_source_end_ms,
                    previous_source_end_ms
                        .saturating_add(expected_source_advance_ms)
                        .saturating_add(ALIGNMENT_V2_RECURSIVE_LOOKAHEAD_MS),
                    recursive,
                )
            } else {
                let predicted_source_start = inverse.scale * target_start_ms as f64
                    + inverse.offset_ms as f64
                    - ALIGNMENT_V2_DP_BAND_RADIUS_MS as f64;
                let predicted_source_end = inverse.scale * target_end_ms as f64
                    + inverse.offset_ms as f64
                    + ALIGNMENT_V2_DP_BAND_RADIUS_MS as f64;
                (
                    predicted_source_start.floor() as i64,
                    predicted_source_end.ceil() as i64,
                    inverse.clone(),
                )
            };
        let source_start_index =
            source_frames.partition_point(|frame| frame.time_ms < source_lower_ms);
        let source_end_index =
            source_frames.partition_point(|frame| frame.time_ms <= source_upper_ms);
        if source_end_index <= source_start_index {
            // A valid monotonic path may legitimately exhaust one axis before the other (for
            // example a target-only trailer). Preserve the unmatched target interval as pending
            // uncertainty. If a later chunk re-enters the bounded source corridor it can still
            // recover; otherwise the terminal block below emits one explicit ambiguous tail.
            pending_uncertain_target_start_ms.get_or_insert(target_start_ms);
            target_start_index = target_end_index;
            continue;
        }
        let source_window = &source_frames[source_start_index..source_end_index];
        // DP operates in the target chunk's shared content-time coordinate. The searched source
        // keeps its original presentation timestamp in each frame, so traceback emits a real
        // non-unit TimeMap slope instead of flattening every matched step to 50/50 ms.
        let common_time_source_window =
            project_v2_search_features_to_common_time(source_window, &chunk_inverse)?;
        let required_cells = (target_chunk.len() + 1)
            .checked_mul(common_time_source_window.len() + 1)
            .ok_or_else(|| "V2 分块 DP 单元数溢出。".to_string())?;
        if required_cells > allowed_cells {
            return Err(format!(
                "blocked:resource-limit：V2 分块需要 {required_cells} 个 DP 单元，硬上限为 {allowed_cells}。"
            ));
        }
        let dp_workspace_bytes =
            v2_dp_workspace_upper_bound(required_cells, target_chunk.len(), source_window.len())?;
        ensure_v2_active_artifact_budget(active_artifact_bytes, dp_workspace_bytes).map_err(
            |error| {
                format!("blocked:resource-limit：V2 分块 DP workspace 未纳入活动内存预算：{error}")
            },
        )?;
        // 反向调用：完整消费目标原片块，并在较宽的参考窗内 semi-global 定位。
        // 返回后交换两条轴，恢复 B 站参考 -> 目标原片的正式 TimeMap 方向。
        let mut common_grid = chunk_inverse.clone();
        common_grid.scale = 1.0;
        common_grid.offset_ms = 0;
        let result = align_features_edit_aware_with_cancel(
            target_chunk,
            &common_time_source_window,
            &common_grid,
            &EditAlignmentConfig {
                mode: EditAlignmentMode::SemiGlobal,
                // The recursive window intentionally includes up to two minutes of bounded
                // source lookahead. The DP band must include the same range or a decoded 45 s
                // source-only insert would remain unreachable and the later target would be
                // mislabeled targetOnly despite the evidence already being resident.
                band_radius_ms: if recursive_chunk {
                    ALIGNMENT_V2_RECURSIVE_LOOKAHEAD_MS
                } else {
                    ALIGNMENT_V2_COARSE_GUIDED_DP_BAND_RADIUS_MS
                },
                max_dp_cells: allowed_cells,
                gap_open_cost: 320,
                // Real AAC/transcode pairs can have a mean single-frame cosine cost around
                // 60-80 even when their 30 s energy envelopes correlate above 0.95. A 55-point
                // extension made it cheaper to discard minutes of genuine shared dialogue than
                // to align it. Keep gaps cheaper than unrelated spectra, but above measured
                // same-content codec drift; context/recovery gates still prevent a cheap
                // accidental frame from certifying an edit.
                gap_extend_cost: 100,
                // Raw frame cost still controls M/ambiguous presentation so 50–100 ms true edits
                // and regular tempo lattice skips are not blurred by temporal context. The
                // stricter context threshold below is used only to advance the chunk cursor.
                ambiguous_match_cost: 720,
            },
            cancel_flag,
        )?;
        fine_evidence.extend(collect_v2_fine_evidence_observations(
            &result.path,
            target_chunk,
            source_window,
        )?);
        let mut chunk_spans = result
            .spans
            .iter()
            .map(swap_v2_edit_span_axes)
            .collect::<Result<Vec<_>, _>>()?;
        let chunk_piecewise_anchor_runs = collect_v2_trusted_fine_anchor_steps(&result.path);
        let piecewise_anchor_noise_island_count =
            absorb_v2_piecewise_anchor_supported_lattice_noise_with_steps(
                &mut chunk_spans,
                &chunk_piecewise_anchor_runs,
                coarse.scale,
            );
        append_v2_trusted_fine_anchor_steps(
            &mut piecewise_anchor_runs,
            chunk_piecewise_anchor_runs,
        );
        absorb_v2_short_tempo_skips(&mut chunk_spans, coarse.scale);
        let target_chunk_duration_ms = u64::try_from(target_end_ms - target_start_ms)
            .map_err(|_| "V2 target chunk 时长无法表示为非负毫秒。".to_string())?;
        let required_recovery_match_ms = ALIGNMENT_V2_PENDING_RECOVERY_MIN_MATCH_MS.min(
            (target_chunk_duration_ms / 5).max(ALIGNMENT_V2_PENDING_RECOVERY_ABSOLUTE_FLOOR_MS),
        );
        let recovery_source_start_ms = v2_reliable_recovery_source_start_ms(
            &result.path,
            required_recovery_match_ms,
            ALIGNMENT_V2_RECOVERY_CONTEXT_COST,
        );
        let mut diagonal_context_costs = result
            .path
            .iter()
            .filter(|step| matches!(step.kind, EditPathKind::Matched | EditPathKind::Ambiguous))
            .map(|step| step.local_cost)
            .collect::<Vec<_>>();
        diagonal_context_costs.sort_unstable();
        let context_cost_p50 = v2_sorted_cost_percentile(&diagonal_context_costs, 50);
        let context_cost_p95 = v2_sorted_cost_percentile(&diagonal_context_costs, 95);
        let path_source_start_ms = chunk_spans.first().map(|span| span.source_start_ms);
        let path_source_end_ms = chunk_spans.last().map(|span| span.source_end_ms);
        path_checkpoints.push(format!(
            "fine path checkpoint #{chunk_ordinal}：corridor={corridor_kind}，target=[{target_start_ms},{target_end_ms}) ms，sourceSearch=[{source_lower_ms},{source_upper_ms}] ms，pathSource={path_source_start_ms:?}..{path_source_end_ms:?} ms，recoverySource={recovery_source_start_ms:?} ms，contextCost P50/P95={context_cost_p50:?}/{context_cost_p95:?}，M/A={}/{}。",
            result.matched_step_count, result.ambiguous_step_count
        ));
        if piecewise_anchor_noise_island_count > 0 {
            path_checkpoints.push(format!(
                "fine piecewise anchor model #{chunk_ordinal}：以两侧稳定低成本锚点、90% 区间证据密度和净仿射守恒合并 {piecewise_anchor_noise_island_count} 个 lattice-noise 岛；单侧编辑、低密度替换与 ambiguous 保持不变。"
            ));
        }
        if recovery_source_start_ms.is_none() {
            // A full semi-global DP with no reliable match cannot safely choose its otherwise
            // arbitrary free-prefix endpoint as the next source cursor. Before the first reliable
            // chunk there is no source cursor to hold, so keep using the global affine corridor.
            // After a reliable chunk, keep the last confirmed cursor and use the recursive
            // lookahead. In both cases preserve the unresolved interval for a later dual-axis
            // ambiguous span instead of discarding the entire otherwise valid path.
            pending_uncertain_target_start_ms.get_or_insert(target_start_ms);
            pending_has_scattered_common_content |=
                result.matched_step_count > 0 || result.ambiguous_step_count > 0;
            target_start_index = target_end_index;
            continue;
        }
        if let Some(pending_start_ms) = pending_uncertain_target_start_ms.take() {
            let recovered_source_start_ms =
                recovery_source_start_ms.expect("recovery certificate checked above");
            let next = chunk_spans
                .first()
                .ok_or_else(|| "V2 恢复块没有可连接的首段。".to_string())?;
            let source_cursor_ms = previous_source_end_ms.unwrap_or_else(|| {
                source_frames
                    .first()
                    .map(|frame| frame.presentation_time_ms)
                    .unwrap_or(next.source_start_ms as i64)
            });
            let source_cursor_ms_u64 = checked_v2_milliseconds(source_cursor_ms)?;
            let cursor_is_stable = previous_source_end_ms.is_some()
                && recovered_source_start_ms.abs_diff(source_cursor_ms_u64)
                    <= ALIGNMENT_V2_PENDING_RECOVERY_CURSOR_TOLERANCE_MS;
            let kind = if cursor_is_stable && !pending_has_scattered_common_content {
                AudioTimeMapSpanKind::TargetOnly
            } else {
                AudioTimeMapSpanKind::Ambiguous
            };
            append_or_merge_v2_span(
                &mut spans,
                create_v2_span(
                    kind,
                    source_cursor_ms_u64,
                    next.source_start_ms,
                    checked_v2_milliseconds(pending_start_ms)?,
                    next.target_start_ms,
                ),
            );
            pending_has_scattered_common_content = false;
        }
        append_v2_chunk_spans(&mut spans, chunk_spans)?;
        absorb_v2_short_tempo_skips(&mut spans, coarse.scale);
        previous_source_end_ms = spans.last().map(|span| span.source_end_ms as i64);
        matched_step_count += result.matched_step_count;
        ambiguous_step_count += result.ambiguous_step_count;
        target_start_index = target_end_index;
    }
    if let Some(pending_start_ms) = pending_uncertain_target_start_ms {
        let source_hop_ms = estimate_v2_hop_ms(source_frames);
        let source_start_ms = previous_source_end_ms.unwrap_or_else(|| {
            source_frames
                .first()
                .map(|frame| frame.presentation_time_ms)
                .unwrap_or(0)
        });
        let source_end_ms = source_frames
            .last()
            .and_then(|frame| frame.presentation_time_ms.checked_add(source_hop_ms))
            .ok_or_else(|| "V2 尾部参考轴边界溢出。".to_string())?;
        let target_end_ms = target_frames
            .last()
            .and_then(|frame| frame.presentation_time_ms.checked_add(target_hop_ms))
            .ok_or_else(|| "V2 尾部目标轴边界溢出。".to_string())?;
        append_or_merge_v2_span(
            &mut spans,
            create_v2_span(
                AudioTimeMapSpanKind::Ambiguous,
                checked_v2_milliseconds(source_start_ms)?,
                checked_v2_milliseconds(source_end_ms)?,
                checked_v2_milliseconds(pending_start_ms)?,
                checked_v2_milliseconds(target_end_ms)?,
            ),
        );
    }
    let source_hop_ms = estimate_v2_hop_ms(source_frames);
    let source_axis_end_ms = source_frames
        .last()
        .and_then(|frame| frame.presentation_time_ms.checked_add(source_hop_ms))
        .ok_or_else(|| "V2 参考轴尾部边界溢出。".to_string())?;
    let target_axis_end_ms = target_frames
        .last()
        .and_then(|frame| frame.presentation_time_ms.checked_add(target_hop_ms))
        .ok_or_else(|| "V2 目标轴尾部边界溢出。".to_string())?;
    let source_axis_start_ms = checked_v2_milliseconds(
        source_frames
            .first()
            .ok_or_else(|| "V2 参考轴为空。".to_string())?
            .presentation_time_ms,
    )?;
    let target_axis_start_ms = checked_v2_milliseconds(
        target_frames
            .first()
            .ok_or_else(|| "V2 目标轴为空。".to_string())?
            .presentation_time_ms,
    )?;
    let represented_source_end_ms = spans
        .last()
        .map(|span| span.source_end_ms)
        .unwrap_or(source_axis_start_ms);
    let represented_target_end_ms = spans
        .last()
        .map(|span| span.target_end_ms)
        .unwrap_or(target_axis_start_ms);
    let source_axis_end_ms = checked_v2_milliseconds(source_axis_end_ms)?;
    let target_axis_end_ms = checked_v2_milliseconds(target_axis_end_ms)?;
    if represented_source_end_ms < source_axis_end_ms
        || represented_target_end_ms < target_axis_end_ms
    {
        // The chunk loop is driven by the target axis. A longer reference can therefore leave
        // an unmatched outro/song after the complete target has been consumed. Keep the
        // unconsumed suffix explicitly ambiguous: without common content on its right side it
        // cannot yet be certified sourceOnly, but silently dropping it would break axis
        // coverage and hide exactly the material that a reviewer must see.
        append_or_merge_v2_span(
            &mut spans,
            create_v2_span(
                AudioTimeMapSpanKind::Ambiguous,
                represented_source_end_ms,
                source_axis_end_ms,
                represented_target_end_ms,
                target_axis_end_ms,
            ),
        );
        path_checkpoints.push(format!(
            "fine axis exhaustion：保留未消费尾段为 ambiguous，source=[{represented_source_end_ms},{source_axis_end_ms}) ms，target=[{represented_target_end_ms},{target_axis_end_ms}) ms；缺少右侧共同内容前不把尾部强判为单侧差异。"
        ));
    }
    if spans.is_empty() {
        return Err("V2 分块 DP 没有输出 span。".to_string());
    }
    let global_piecewise_anchor_noise_island_count =
        absorb_v2_piecewise_anchor_supported_lattice_noise_with_steps(
            &mut spans,
            &piecewise_anchor_runs,
            coarse.scale,
        );
    if global_piecewise_anchor_noise_island_count > 0 {
        path_checkpoints.push(format!(
            "fine global piecewise anchor model：跨 45 秒 chunk 汇总连续低成本锚点后，合并 {global_piecewise_anchor_noise_island_count} 个净仿射守恒的 lattice-noise 岛；门槛与逐 chunk 模型相同。"
        ));
    }
    let balanced_micro_edit_island_count =
        absorb_v2_balanced_micro_edit_islands(&mut spans, coarse.scale);
    if balanced_micro_edit_island_count > 0 {
        path_checkpoints.push(format!(
            "fine path normalization：已合并 {balanced_micro_edit_island_count} 个方向交替、首尾净时长守恒的微编辑抖动岛；单次或不平衡真实编辑保持不变。"
        ));
    }
    path_checkpoints.extend(recover_v2_training_anchor_islands(&mut spans, coarse));
    path_checkpoints.extend(recover_v2_dense_offset_steps(
        &mut spans,
        &fine_evidence,
        coarse.scale,
    ));
    for span in &mut spans {
        span.boundaries = create_initial_v2_span_boundaries(
            span.kind,
            span.source_start_ms,
            span.source_end_ms,
            span.target_start_ms,
            span.target_end_ms,
        );
    }
    validate_v2_time_map_spans(&spans)?;
    Ok(V2ChunkAlignment {
        spans,
        matched_step_count,
        ambiguous_step_count,
        path_checkpoints,
        fine_evidence,
    })
}

fn swap_v2_time_map_span_axes(span: &AudioTimeMapSpanDto) -> AudioTimeMapSpanDto {
    let kind = match span.kind {
        AudioTimeMapSpanKind::Matched => AudioTimeMapSpanKind::Matched,
        AudioTimeMapSpanKind::SourceOnly => AudioTimeMapSpanKind::TargetOnly,
        AudioTimeMapSpanKind::TargetOnly => AudioTimeMapSpanKind::SourceOnly,
        AudioTimeMapSpanKind::Ambiguous => AudioTimeMapSpanKind::Ambiguous,
    };
    create_v2_span(
        kind,
        span.target_start_ms,
        span.target_end_ms,
        span.source_start_ms,
        span.source_end_ms,
    )
}

fn swap_v2_fine_evidence_axes(
    observation: &V2FineEvidenceObservation,
) -> V2FineEvidenceObservation {
    let kind = match observation.kind {
        AudioTimeMapSpanKind::Matched => AudioTimeMapSpanKind::Matched,
        AudioTimeMapSpanKind::SourceOnly => AudioTimeMapSpanKind::TargetOnly,
        AudioTimeMapSpanKind::TargetOnly => AudioTimeMapSpanKind::SourceOnly,
        AudioTimeMapSpanKind::Ambiguous => AudioTimeMapSpanKind::Ambiguous,
    };
    V2FineEvidenceObservation {
        source_start_ms: observation.target_start_ms,
        source_end_ms: observation.target_end_ms,
        target_start_ms: observation.source_start_ms,
        target_end_ms: observation.source_end_ms,
        kind,
        local_cost: observation.local_cost,
        informativeness: observation.informativeness,
    }
}

fn v2_edit_spans_reciprocally_agree(
    forward: &AudioTimeMapSpanDto,
    reverse: &AudioTimeMapSpanDto,
) -> bool {
    if !is_v2_edit_span(forward.kind) {
        return false;
    }
    match forward.kind {
        AudioTimeMapSpanKind::SourceOnly => {
            let reverse_shape_supports_direction = reverse.kind == AudioTimeMapSpanKind::SourceOnly
                || (reverse.kind == AudioTimeMapSpanKind::Ambiguous
                    && reverse.source_end_ms > reverse.source_start_ms
                    && reverse.target_end_ms == reverse.target_start_ms);
            if !reverse_shape_supports_direction {
                return false;
            }
            v2_u64_interval_overlap_ms(
                forward.source_start_ms,
                forward.source_end_ms,
                reverse.source_start_ms,
                reverse.source_end_ms,
            )
            .saturating_mul(2)
                >= forward
                    .source_end_ms
                    .saturating_sub(forward.source_start_ms)
        }
        AudioTimeMapSpanKind::TargetOnly => {
            let reverse_shape_supports_direction = reverse.kind == AudioTimeMapSpanKind::TargetOnly
                || (reverse.kind == AudioTimeMapSpanKind::Ambiguous
                    && reverse.source_end_ms == reverse.source_start_ms
                    && reverse.target_end_ms > reverse.target_start_ms);
            if !reverse_shape_supports_direction {
                return false;
            }
            v2_u64_interval_overlap_ms(
                forward.target_start_ms,
                forward.target_end_ms,
                reverse.target_start_ms,
                reverse.target_end_ms,
            )
            .saturating_mul(2)
                >= forward
                    .target_end_ms
                    .saturating_sub(forward.target_start_ms)
        }
        AudioTimeMapSpanKind::Matched | AudioTimeMapSpanKind::Ambiguous => false,
    }
}

fn v2_reverse_path_is_conclusive(spans: &[AudioTimeMapSpanDto]) -> bool {
    let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
        return false;
    };
    let total_ms = last
        .source_end_ms
        .saturating_sub(first.source_start_ms)
        .max(last.target_end_ms.saturating_sub(first.target_start_ms));
    if total_ms == 0 {
        return false;
    }
    let ambiguous_ms = spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Ambiguous)
        .map(|span| {
            span.source_end_ms
                .saturating_sub(span.source_start_ms)
                .max(span.target_end_ms.saturating_sub(span.target_start_ms))
        })
        .sum::<u64>();
    ambiguous_ms.saturating_mul(4) <= total_ms
}

fn v2_u64_interval_overlap_ms(
    first_start_ms: u64,
    first_end_ms: u64,
    second_start_ms: u64,
    second_end_ms: u64,
) -> u64 {
    first_end_ms
        .min(second_end_ms)
        .saturating_sub(first_start_ms.max(second_start_ms))
}

fn collect_v2_fine_evidence_observations(
    reverse_axis_path: &[crate::alignment_v2::EditPathStep],
    original_frames: &[FineFeatureFrame],
    reference_frames: &[FineFeatureFrame],
) -> Result<Vec<V2FineEvidenceObservation>, String> {
    reverse_axis_path
        .iter()
        .map(|step| {
            let kind = match step.kind {
                EditPathKind::Matched => AudioTimeMapSpanKind::Matched,
                EditPathKind::SourceOnly => AudioTimeMapSpanKind::TargetOnly,
                EditPathKind::TargetOnly => AudioTimeMapSpanKind::SourceOnly,
                EditPathKind::Ambiguous => AudioTimeMapSpanKind::Ambiguous,
            };
            let reference_information = v2_fine_frame_informativeness(
                reference_frames,
                step.target_start_ms,
                step.target_end_ms,
            );
            let original_information = v2_fine_frame_informativeness(
                original_frames,
                step.source_start_ms,
                step.source_end_ms,
            );
            let informativeness = match (reference_information, original_information) {
                (Some(reference), Some(original)) => (reference + original) / 2.0,
                (Some(value), None) | (None, Some(value)) => value,
                (None, None) => 0.0,
            }
            .clamp(0.0, 1.0);
            Ok(V2FineEvidenceObservation {
                source_start_ms: checked_v2_milliseconds(step.target_start_ms)?,
                source_end_ms: checked_v2_milliseconds(step.target_end_ms)?,
                target_start_ms: checked_v2_milliseconds(step.source_start_ms)?,
                target_end_ms: checked_v2_milliseconds(step.source_end_ms)?,
                kind,
                local_cost: step.local_cost,
                informativeness,
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
struct V2StableOffsetRun {
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
    offset_min_ms: i64,
    offset_max_ms: i64,
    offset_sum_ms: i128,
    observation_count: usize,
}

impl V2StableOffsetRun {
    fn from_observation(observation: &V2FineEvidenceObservation, offset_ms: i64) -> Self {
        Self {
            source_start_ms: observation.source_start_ms,
            source_end_ms: observation.source_end_ms,
            target_start_ms: observation.target_start_ms,
            target_end_ms: observation.target_end_ms,
            offset_min_ms: offset_ms,
            offset_max_ms: offset_ms,
            offset_sum_ms: i128::from(offset_ms),
            observation_count: 1,
        }
    }

    fn mean_offset_ms(&self) -> i64 {
        (self.offset_sum_ms / self.observation_count as i128) as i64
    }

    fn has_required_support(&self) -> bool {
        self.source_end_ms.saturating_sub(self.source_start_ms)
            >= ALIGNMENT_V2_OFFSET_STEP_MIN_SIDE_SUPPORT_MS
            && self.target_end_ms.saturating_sub(self.target_start_ms)
                >= ALIGNMENT_V2_OFFSET_STEP_MIN_SIDE_SUPPORT_MS
    }

    fn can_extend(&self, observation: &V2FineEvidenceObservation, offset_ms: i64) -> bool {
        observation.source_start_ms
            <= self
                .source_end_ms
                .saturating_add(ALIGNMENT_V2_OFFSET_STEP_MAX_OBSERVATION_GAP_MS)
            && observation.target_start_ms
                <= self
                    .target_end_ms
                    .saturating_add(ALIGNMENT_V2_OFFSET_STEP_MAX_OBSERVATION_GAP_MS)
            && self
                .offset_min_ms
                .min(offset_ms)
                .abs_diff(self.offset_max_ms.max(offset_ms))
                <= ALIGNMENT_V2_OFFSET_STEP_MAX_WITHIN_RUN_DRIFT_MS
    }

    fn extend(&mut self, observation: &V2FineEvidenceObservation, offset_ms: i64) {
        self.source_end_ms = self.source_end_ms.max(observation.source_end_ms);
        self.target_end_ms = self.target_end_ms.max(observation.target_end_ms);
        self.offset_min_ms = self.offset_min_ms.min(offset_ms);
        self.offset_max_ms = self.offset_max_ms.max(offset_ms);
        self.offset_sum_ms += i128::from(offset_ms);
        self.observation_count = self.observation_count.saturating_add(1);
    }
}

#[derive(Debug, Clone)]
struct V2DenseOffsetStepCandidate {
    left: V2StableOffsetRun,
    right: V2StableOffsetRun,
    kind: AudioTimeMapSpanKind,
    edit_duration_ms: u64,
    duration_residual_ms: u64,
}

pub(super) fn recover_v2_dense_offset_steps(
    spans: &mut Vec<AudioTimeMapSpanDto>,
    fine_evidence: &[V2FineEvidenceObservation],
    expected_scale: f64,
) -> Vec<String> {
    if fine_evidence.is_empty() || !expected_scale.is_finite() || expected_scale <= 0.0 {
        return Vec::new();
    }
    let mut diagnostics = Vec::new();
    let mut span_index = 0usize;
    while span_index < spans.len() {
        if spans[span_index].kind != AudioTimeMapSpanKind::Ambiguous {
            span_index += 1;
            continue;
        }
        let ambiguous = spans[span_index].clone();
        let runs = v2_stable_offset_runs_in_span(&ambiguous, fine_evidence, expected_scale);
        let Some(candidate) = v2_best_dense_offset_step(&runs, expected_scale) else {
            span_index += 1;
            continue;
        };
        let replacement = v2_dense_offset_step_replacement(&ambiguous, &candidate);
        if replacement.is_empty() || validate_v2_time_map_spans(&replacement).is_err() {
            span_index += 1;
            continue;
        }
        let kind_label = format_v2_span_kind(candidate.kind);
        diagnostics.push(format!(
            "fine dense offset-step recovery：两侧分别有 {} ms / {} ms 连续低成本共同内容，偏移从 {:+} ms 跳至 {:+} ms；恢复为 {kind_label} 约 {} ms（时长守恒残差 {} ms），原 ambiguous 的无证据边缘仍保持 ambiguous。",
            candidate
                .left
                .source_end_ms
                .saturating_sub(candidate.left.source_start_ms),
            candidate
                .right
                .source_end_ms
                .saturating_sub(candidate.right.source_start_ms),
            candidate.left.mean_offset_ms(),
            candidate.right.mean_offset_ms(),
            candidate.edit_duration_ms,
            candidate.duration_residual_ms
        ));
        let replacement_len = replacement.len();
        spans.splice(span_index..=span_index, replacement);
        span_index = span_index.saturating_add(replacement_len);
    }
    diagnostics
}

fn v2_stable_offset_runs_in_span(
    span: &AudioTimeMapSpanDto,
    fine_evidence: &[V2FineEvidenceObservation],
    expected_scale: f64,
) -> Vec<V2StableOffsetRun> {
    let mut observations = fine_evidence
        .iter()
        .filter(|observation| {
            observation.kind == AudioTimeMapSpanKind::Matched
                && observation.local_cost <= ALIGNMENT_V2_RECOVERY_CONTEXT_COST
                && observation.informativeness >= ALIGNMENT_V2_OFFSET_STEP_MIN_INFORMATIVENESS
                && observation.source_start_ms >= span.source_start_ms
                && observation.source_end_ms <= span.source_end_ms
                && observation.target_start_ms >= span.target_start_ms
                && observation.target_end_ms <= span.target_end_ms
        })
        .collect::<Vec<_>>();
    observations.sort_unstable_by_key(|observation| {
        (
            observation.source_start_ms,
            observation.target_start_ms,
            observation.source_end_ms,
            observation.target_end_ms,
        )
    });
    observations.dedup_by_key(|observation| {
        (
            observation.source_start_ms,
            observation.target_start_ms,
            observation.source_end_ms,
            observation.target_end_ms,
        )
    });
    let mut runs = Vec::<V2StableOffsetRun>::new();
    for observation in observations {
        let offset_ms = v2_observation_offset_ms(observation, expected_scale);
        if let Some(run) = runs
            .last_mut()
            .filter(|run| run.can_extend(observation, offset_ms))
        {
            run.extend(observation, offset_ms);
        } else {
            runs.push(V2StableOffsetRun::from_observation(observation, offset_ms));
        }
    }
    runs.into_iter()
        .filter(V2StableOffsetRun::has_required_support)
        .collect()
}

fn v2_observation_offset_ms(observation: &V2FineEvidenceObservation, expected_scale: f64) -> i64 {
    let source_midpoint_ms =
        (observation.source_start_ms as f64 + observation.source_end_ms as f64) / 2.0;
    let target_midpoint_ms =
        (observation.target_start_ms as f64 + observation.target_end_ms as f64) / 2.0;
    (target_midpoint_ms - expected_scale * source_midpoint_ms).round() as i64
}

fn v2_best_dense_offset_step(
    runs: &[V2StableOffsetRun],
    expected_scale: f64,
) -> Option<V2DenseOffsetStepCandidate> {
    runs.windows(2)
        .filter_map(|pair| {
            let left = &pair[0];
            let right = &pair[1];
            let source_gap_ms = right.source_start_ms.saturating_sub(left.source_end_ms);
            let target_gap_ms = right.target_start_ms.saturating_sub(left.target_end_ms);
            let expected_target_gap_ms = expected_scale * source_gap_ms as f64;
            let signed_edit_ms = target_gap_ms as f64 - expected_target_gap_ms;
            if signed_edit_ms.abs() < ALIGNMENT_V2_OFFSET_STEP_MIN_EDIT_MS as f64 {
                return None;
            }
            let offset_jump_ms = right.mean_offset_ms() - left.mean_offset_ms();
            let duration_residual_ms =
                (offset_jump_ms as f64 - signed_edit_ms).abs().round() as u64;
            if duration_residual_ms > ALIGNMENT_V2_OFFSET_STEP_MAX_DURATION_RESIDUAL_MS {
                return None;
            }
            let kind = if signed_edit_ms > 0.0 {
                AudioTimeMapSpanKind::TargetOnly
            } else {
                AudioTimeMapSpanKind::SourceOnly
            };
            Some(V2DenseOffsetStepCandidate {
                left: left.clone(),
                right: right.clone(),
                kind,
                edit_duration_ms: signed_edit_ms.abs().round() as u64,
                duration_residual_ms,
            })
        })
        .max_by_key(|candidate| {
            (
                candidate.edit_duration_ms,
                candidate.left.observation_count + candidate.right.observation_count,
            )
        })
}

fn v2_dense_offset_step_replacement(
    ambiguous: &AudioTimeMapSpanDto,
    candidate: &V2DenseOffsetStepCandidate,
) -> Vec<AudioTimeMapSpanDto> {
    let mut replacement = Vec::with_capacity(5);
    let push = |output: &mut Vec<AudioTimeMapSpanDto>,
                kind,
                source_start_ms,
                source_end_ms,
                target_start_ms,
                target_end_ms| {
        if source_start_ms == source_end_ms && target_start_ms == target_end_ms {
            return;
        }
        append_or_merge_v2_span(
            output,
            create_v2_span(
                kind,
                source_start_ms,
                source_end_ms,
                target_start_ms,
                target_end_ms,
            ),
        );
    };
    push(
        &mut replacement,
        if candidate
            .left
            .source_start_ms
            .abs_diff(ambiguous.source_start_ms)
            <= ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS
            && candidate
                .left
                .target_start_ms
                .abs_diff(ambiguous.target_start_ms)
                <= ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS
        {
            AudioTimeMapSpanKind::Matched
        } else {
            AudioTimeMapSpanKind::Ambiguous
        },
        ambiguous.source_start_ms,
        candidate.left.source_end_ms,
        ambiguous.target_start_ms,
        candidate.left.target_end_ms,
    );
    match candidate.kind {
        AudioTimeMapSpanKind::TargetOnly => {
            let source_seam_ms = candidate.left.source_end_ms;
            push(
                &mut replacement,
                AudioTimeMapSpanKind::TargetOnly,
                source_seam_ms,
                source_seam_ms,
                candidate.left.target_end_ms,
                candidate.right.target_start_ms,
            );
            push(
                &mut replacement,
                if candidate
                    .right
                    .source_end_ms
                    .abs_diff(ambiguous.source_end_ms)
                    <= ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS
                    && candidate
                        .right
                        .target_end_ms
                        .abs_diff(ambiguous.target_end_ms)
                        <= ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS
                {
                    AudioTimeMapSpanKind::Matched
                } else {
                    AudioTimeMapSpanKind::Ambiguous
                },
                source_seam_ms,
                ambiguous.source_end_ms,
                candidate.right.target_start_ms,
                ambiguous.target_end_ms,
            );
        }
        AudioTimeMapSpanKind::SourceOnly => {
            let target_seam_ms = candidate.left.target_end_ms;
            push(
                &mut replacement,
                AudioTimeMapSpanKind::SourceOnly,
                candidate.left.source_end_ms,
                candidate.right.source_start_ms,
                target_seam_ms,
                target_seam_ms,
            );
            push(
                &mut replacement,
                if candidate
                    .right
                    .source_end_ms
                    .abs_diff(ambiguous.source_end_ms)
                    <= ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS
                    && candidate
                        .right
                        .target_end_ms
                        .abs_diff(ambiguous.target_end_ms)
                        <= ALIGNMENT_V2_OFFSET_STEP_EDGE_DRIFT_MS
                {
                    AudioTimeMapSpanKind::Matched
                } else {
                    AudioTimeMapSpanKind::Ambiguous
                },
                candidate.right.source_start_ms,
                ambiguous.source_end_ms,
                target_seam_ms,
                ambiguous.target_end_ms,
            );
        }
        AudioTimeMapSpanKind::Matched | AudioTimeMapSpanKind::Ambiguous => return Vec::new(),
    }
    replacement
}

fn v2_fine_frame_informativeness(
    frames: &[FineFeatureFrame],
    start_ms: i64,
    end_ms: i64,
) -> Option<f64> {
    if end_ms <= start_ms {
        return None;
    }
    let index = frames.partition_point(|frame| frame.presentation_time_ms < start_ms);
    let frame = frames
        .get(index)
        .or_else(|| index.checked_sub(1).and_then(|i| frames.get(i)))?;
    frame
        .values
        .first()
        .map(|value| f64::from(*value).clamp(0.0, 1.0))
}

fn v2_sorted_cost_percentile(sorted: &[i64], percentile: usize) -> Option<i64> {
    if sorted.is_empty() || percentile > 100 {
        return None;
    }
    let index = sorted
        .len()
        .saturating_sub(1)
        .saturating_mul(percentile)
        .div_ceil(100);
    sorted.get(index).copied()
}

pub(super) fn v2_reliable_recovery_source_start_ms(
    reverse_axis_path: &[crate::alignment_v2::EditPathStep],
    required_match_ms: u64,
    maximum_context_cost: i64,
) -> Option<u64> {
    if required_match_ms == 0 || maximum_context_cost <= 0 {
        return None;
    }
    let required_match_ms = i64::try_from(required_match_ms).ok()?;
    let mut run_start_source_ms = None::<i64>;
    let mut run_start_target_ms = None::<i64>;
    let mut previous_source_end_ms = None::<i64>;
    let mut previous_target_end_ms = None::<i64>;
    for step in reverse_axis_path {
        let trusted = step.kind == EditPathKind::Matched
            && step.local_cost < maximum_context_cost
            && step.source_end_ms > step.source_start_ms
            && step.target_end_ms > step.target_start_ms;
        let contiguous = previous_source_end_ms == Some(step.source_start_ms)
            && previous_target_end_ms == Some(step.target_start_ms);
        if !trusted {
            run_start_source_ms = None;

            run_start_target_ms = None;
            previous_source_end_ms = None;
            previous_target_end_ms = None;
            continue;
        }
        if !contiguous {
            run_start_source_ms = Some(step.source_start_ms);
            run_start_target_ms = Some(step.target_start_ms);
        }
        previous_source_end_ms = Some(step.source_end_ms);
        previous_target_end_ms = Some(step.target_end_ms);
        if step.source_end_ms.saturating_sub(run_start_source_ms?) >= required_match_ms
            && step.target_end_ms.saturating_sub(run_start_target_ms?) >= required_match_ms
        {
            // align_v2_feature_chunks invokes DP with axes reversed: target presentation is the
            // first path axis and reference/source presentation is the second.
            return u64::try_from(run_start_target_ms?).ok();
        }
    }
    None
}

fn estimate_v2_hop_ms(frames: &[FineFeatureFrame]) -> i64 {
    let mut differences = frames
        .windows(2)
        .map(|window| window[1].time_ms - window[0].time_ms)
        .filter(|difference| *difference > 0)
        .collect::<Vec<_>>();
    differences.sort_unstable();
    differences
        .get(differences.len().saturating_sub(1) / 2)
        .copied()
        .unwrap_or(ALIGNMENT_V2_FINE_HOP_MS as i64)
}

pub(super) fn v2_bracketing_anchor_inverse_for_target_chunk(
    coarse: &AffineHypothesis,
    inverse: &AffineHypothesis,
    target_start_ms: i64,
    target_end_ms: i64,
) -> Option<AffineHypothesis> {
    if target_end_ms <= target_start_ms || !inverse.scale.is_finite() || inverse.scale <= 0.0 {
        return None;
    }
    let residual_tolerance_ms = v2_affine_match_config()
        .residual_tolerance_ms
        .unsigned_abs();
    // Held-out anchors are validation evidence only. Letting them close either side of this
    // bracket would leak validation coordinates into the fine DP corridor and make the final
    // re-projection metrics self-fulfilling.
    let anchors = coarse
        .training_anchors
        .iter()
        .filter(|anchor| anchor.residual_ms.unsigned_abs() <= residual_tolerance_ms);
    let before = anchors
        .clone()
        .filter(|anchor| anchor.target_time_ms <= target_start_ms)
        .max_by_key(|anchor| anchor.target_time_ms)?;
    let after = anchors
        .filter(|anchor| anchor.target_time_ms >= target_end_ms)
        .min_by_key(|anchor| anchor.target_time_ms)?;
    if target_start_ms.saturating_sub(before.target_time_ms)
        > ALIGNMENT_V2_LOCAL_ANCHOR_BRACKET_RADIUS_MS
        || after.target_time_ms.saturating_sub(target_end_ms)
            > ALIGNMENT_V2_LOCAL_ANCHOR_BRACKET_RADIUS_MS
    {
        return None;
    }
    let before_offset = (before.source_time_ms as f64
        - inverse.scale * before.target_time_ms as f64)
        .round() as i64;
    let after_offset =
        (after.source_time_ms as f64 - inverse.scale * after.target_time_ms as f64).round() as i64;
    if before_offset.abs_diff(after_offset) > ALIGNMENT_V2_LOCAL_ANCHOR_OFFSET_TOLERANCE_MS as u64 {
        return None;
    }
    let mut guided = inverse.clone();
    guided.offset_ms = ((before_offset as i128 + after_offset as i128) / 2) as i64;
    Some(guided)
}

pub(super) fn inverse_affine_hypothesis(
    coarse: &AffineHypothesis,
) -> Result<AffineHypothesis, String> {
    if !coarse.scale.is_finite() || coarse.scale <= 0.0 {
        return Err("无法反转无效 affine scale。".to_string());
    }
    Ok(AffineHypothesis {
        scale: 1.0 / coarse.scale,
        offset_ms: (-coarse.offset_ms as f64 / coarse.scale).round() as i64,
        inlier_count: coarse.inlier_count,
        unique_source_count: coarse.unique_target_count,
        unique_source_coverage: coarse.unique_target_coverage,
        unique_target_count: coarse.unique_source_count,
        unique_target_coverage: coarse.unique_source_coverage,
        source_start_ms: (coarse.scale * coarse.source_start_ms as f64 + coarse.offset_ms as f64)
            .round() as i64,
        source_end_ms: (coarse.scale * coarse.source_end_ms as f64 + coarse.offset_ms as f64)
            .round() as i64,
        p50_residual_ms: coarse.p50_residual_ms,
        p95_residual_ms: coarse.p95_residual_ms,
        max_residual_ms: coarse.max_residual_ms,
        training_anchors: Vec::new(),
        held_out_anchors: Vec::new(),
        held_out_within_tolerance_count: 0,
    })
}

fn project_v2_search_features_to_common_time(
    frames: &[FineFeatureFrame],
    searched_from_common: &AffineHypothesis,
) -> Result<Vec<FineFeatureFrame>, String> {
    if !searched_from_common.scale.is_finite() || searched_from_common.scale <= 0.0 {
        return Err("无法把搜索侧 fine features 投影到无效 affine 网格。".to_string());
    }
    let mut projected = Vec::with_capacity(frames.len());
    let mut previous_common_time = None;
    for frame in frames {
        let common_time = ((frame.presentation_time_ms as f64
            - searched_from_common.offset_ms as f64)
            / searched_from_common.scale)
            .round();
        if !common_time.is_finite()
            || common_time < i64::MIN as f64
            || common_time > i64::MAX as f64
        {
            return Err("搜索侧 fine feature 的共同 content-time 无法表示。".to_string());
        }
        let common_time = common_time as i64;
        if previous_common_time.is_some_and(|previous| common_time <= previous) {
            return Err("搜索侧 fine feature 投影后的共同 content-time 不是严格递增。".to_string());
        }
        projected.push(FineFeatureFrame {
            time_ms: common_time,
            presentation_time_ms: frame.presentation_time_ms,
            values: frame.values.clone(),
        });
        previous_common_time = Some(common_time);
    }
    Ok(projected)
}

fn swap_v2_edit_span_axes(span: &EditTimeSpan) -> Result<AudioTimeMapSpanDto, String> {
    let kind = match span.kind {
        EditPathKind::Matched => AudioTimeMapSpanKind::Matched,
        EditPathKind::SourceOnly => AudioTimeMapSpanKind::TargetOnly,
        EditPathKind::TargetOnly => AudioTimeMapSpanKind::SourceOnly,
        EditPathKind::Ambiguous => AudioTimeMapSpanKind::Ambiguous,
    };
    Ok(create_v2_span(
        kind,
        checked_v2_milliseconds(span.target_start_ms)?,
        checked_v2_milliseconds(span.target_end_ms)?,
        checked_v2_milliseconds(span.source_start_ms)?,
        checked_v2_milliseconds(span.source_end_ms)?,
    ))
}

fn checked_v2_milliseconds(value: i64) -> Result<u64, String> {
    u64::try_from(value)
        .map_err(|_| format!("V2 生成了负的 presentation timeline 坐标 {value} ms，已安全阻断。"))
}

fn append_v2_chunk_spans(
    output: &mut Vec<AudioTimeMapSpanDto>,
    mut chunk: Vec<AudioTimeMapSpanDto>,
) -> Result<(), String> {
    if chunk.is_empty() {
        return Err("V2 细对齐块没有 span。".to_string());
    }
    if let Some(previous) = output.last() {
        let next = &chunk[0];
        if next.target_start_ms != previous.target_end_ms {
            return Err(format!(
                "V2 分块目标轴不连续：{} -> {}。",
                previous.target_end_ms, next.target_start_ms
            ));
        }
        if next.source_start_ms < previous.source_end_ms {
            return Err(format!(
                "V2 分块参考轴回退：{} -> {}，可能存在重复内容歧义。",
                previous.source_end_ms, next.source_start_ms
            ));
        }
        if next.source_start_ms > previous.source_end_ms {
            output.push(create_v2_span(
                AudioTimeMapSpanKind::SourceOnly,
                previous.source_end_ms,
                next.source_start_ms,
                previous.target_end_ms,
                previous.target_end_ms,
            ));
        }
    }
    for span in chunk.drain(..) {
        append_or_merge_v2_span(output, span);
    }
    Ok(())
}

fn append_or_merge_v2_span(output: &mut Vec<AudioTimeMapSpanDto>, span: AudioTimeMapSpanDto) {
    if let Some(previous) = output.last_mut() {
        if previous.kind == span.kind
            && previous.source_end_ms == span.source_start_ms
            && previous.target_end_ms == span.target_start_ms
        {
            previous.source_end_ms = span.source_end_ms;
            previous.target_end_ms = span.target_end_ms;
            return;
        }
    }
    output.push(span);
}

#[cfg(test)]
pub(super) fn absorb_v2_piecewise_anchor_supported_lattice_noise(
    spans: &mut Vec<AudioTimeMapSpanDto>,
    reverse_axis_path: &[EditPathStep],
    expected_scale: f64,
) -> usize {
    let trusted_steps = collect_v2_trusted_fine_anchor_steps(reverse_axis_path);
    absorb_v2_piecewise_anchor_supported_lattice_noise_with_steps(
        spans,
        &trusted_steps,
        expected_scale,
    )
}

fn absorb_v2_piecewise_anchor_supported_lattice_noise_with_steps(
    spans: &mut Vec<AudioTimeMapSpanDto>,
    trusted_steps: &[V2TrustedFineAnchorStep],
    expected_scale: f64,
) -> usize {
    if spans.len() < 3 || !expected_scale.is_finite() || expected_scale <= 0.0 {
        return 0;
    }
    if trusted_steps.is_empty() {
        return 0;
    }

    let mut absorbed_count = 0usize;
    let mut left_index = 0usize;
    while left_index + 2 < spans.len() {
        if !v2_span_has_stable_piecewise_anchor_support(&spans[left_index], trusted_steps) {
            left_index += 1;
            continue;
        }
        let mut right_index = None;
        for candidate_end in (left_index + 2)..spans.len() {
            if !v2_span_has_stable_piecewise_anchor_support(&spans[candidate_end], trusted_steps) {
                continue;
            }
            let candidate = &spans[left_index..=candidate_end];
            if candidate
                .iter()
                .any(|span| span.kind == AudioTimeMapSpanKind::Ambiguous)
            {
                break;
            }
            if candidate.iter().any(|span| is_v2_edit_span(span.kind))
                && v2_piecewise_anchor_interval_is_dense(candidate, trusted_steps, expected_scale)
            {
                right_index = Some(candidate_end);
                break;
            }
        }
        let Some(right_index) = right_index else {
            left_index += 1;
            continue;
        };

        let merged = create_v2_span(
            AudioTimeMapSpanKind::Matched,
            spans[left_index].source_start_ms,
            spans[right_index].source_end_ms,
            spans[left_index].target_start_ms,
            spans[right_index].target_end_ms,
        );
        spans.splice(left_index..=right_index, [merged]);
        absorbed_count = absorbed_count.saturating_add(1);
        left_index = left_index.saturating_sub(1);
    }
    absorbed_count
}

pub(super) fn collect_v2_trusted_fine_anchor_steps(
    reverse_axis_path: &[EditPathStep],
) -> Vec<V2TrustedFineAnchorStep> {
    let mut trusted_steps = Vec::<V2TrustedFineAnchorStep>::new();
    for step in reverse_axis_path
        .iter()
        .filter_map(v2_trusted_fine_anchor_step)
    {
        if let Some(previous) = trusted_steps.last_mut() {
            if previous.source_end_ms == step.source_start_ms
                && previous.target_end_ms == step.target_start_ms
            {
                previous.source_end_ms = step.source_end_ms;
                previous.target_end_ms = step.target_end_ms;
                continue;
            }
        }
        trusted_steps.push(step);
    }
    trusted_steps
}

fn append_v2_trusted_fine_anchor_steps(
    output: &mut Vec<V2TrustedFineAnchorStep>,
    steps: Vec<V2TrustedFineAnchorStep>,
) {
    for step in steps {
        if let Some(previous) = output.last_mut() {
            if previous.source_end_ms == step.source_start_ms
                && previous.target_end_ms == step.target_start_ms
            {
                previous.source_end_ms = step.source_end_ms;
                previous.target_end_ms = step.target_end_ms;
                continue;
            }
        }
        output.push(step);
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct V2TrustedFineAnchorStep {
    pub(super) source_start_ms: u64,
    pub(super) source_end_ms: u64,
    pub(super) target_start_ms: u64,
    pub(super) target_end_ms: u64,
}

fn v2_trusted_fine_anchor_step(step: &EditPathStep) -> Option<V2TrustedFineAnchorStep> {
    if step.kind != EditPathKind::Matched || step.local_cost > ALIGNMENT_V2_RECOVERY_CONTEXT_COST {
        return None;
    }
    // Fine DP is called with the original episode as source and the reference search window as
    // target. Swap axes back to the public reference -> original TimeMap direction.
    let anchor = V2TrustedFineAnchorStep {
        source_start_ms: u64::try_from(step.target_start_ms).ok()?,
        source_end_ms: u64::try_from(step.target_end_ms).ok()?,
        target_start_ms: u64::try_from(step.source_start_ms).ok()?,
        target_end_ms: u64::try_from(step.source_end_ms).ok()?,
    };
    (anchor.source_end_ms > anchor.source_start_ms && anchor.target_end_ms > anchor.target_start_ms)
        .then_some(anchor)
}

fn v2_span_has_stable_piecewise_anchor_support(
    span: &AudioTimeMapSpanDto,
    trusted_steps: &[V2TrustedFineAnchorStep],
) -> bool {
    span.kind == AudioTimeMapSpanKind::Matched
        && v2_piecewise_anchor_support_ms(span, trusted_steps)
            >= ALIGNMENT_V2_PIECEWISE_ANCHOR_MIN_SIDE_SUPPORT_MS
}

fn v2_piecewise_anchor_interval_is_dense(
    spans: &[AudioTimeMapSpanDto],
    trusted_steps: &[V2TrustedFineAnchorStep],
    expected_scale: f64,
) -> bool {
    let (Some(first), Some(last)) = (spans.first(), spans.last()) else {
        return false;
    };
    let interval = create_v2_span(
        AudioTimeMapSpanKind::Matched,
        first.source_start_ms,
        last.source_end_ms,
        first.target_start_ms,
        last.target_end_ms,
    );
    let (source_duration_ms, target_duration_ms) = v2_span_axis_durations_ms(&interval);
    let comparable_duration_ms = source_duration_ms.min(target_duration_ms);
    if comparable_duration_ms == 0
        || (target_duration_ms as f64 - expected_scale * source_duration_ms as f64).abs()
            > ALIGNMENT_V2_PIECEWISE_ANCHOR_MAX_NET_RESIDUAL_MS
    {
        return false;
    }
    let trusted_support_ms = v2_piecewise_anchor_support_ms(&interval, trusted_steps);
    trusted_support_ms.saturating_mul(ALIGNMENT_V2_PIECEWISE_ANCHOR_MIN_DENSITY_DENOMINATOR)
        >= comparable_duration_ms
            .saturating_mul(ALIGNMENT_V2_PIECEWISE_ANCHOR_MIN_DENSITY_NUMERATOR)
}

fn v2_piecewise_anchor_support_ms(
    span: &AudioTimeMapSpanDto,
    trusted_steps: &[V2TrustedFineAnchorStep],
) -> u64 {
    trusted_steps
        .iter()
        .filter(|step| {
            step.source_start_ms >= span.source_start_ms
                && step.source_end_ms <= span.source_end_ms
                && step.target_start_ms >= span.target_start_ms
                && step.target_end_ms <= span.target_end_ms
        })
        .map(|step| {
            step.source_end_ms
                .saturating_sub(step.source_start_ms)
                .min(step.target_end_ms.saturating_sub(step.target_start_ms))
        })
        .sum()
}

pub(super) fn absorb_v2_balanced_micro_edit_islands(
    spans: &mut Vec<AudioTimeMapSpanDto>,
    expected_scale: f64,
) -> usize {
    if !expected_scale.is_finite() || expected_scale <= 0.0 {
        return 0;
    }
    let mut absorbed_count = 0usize;
    let mut start = 0usize;
    while start < spans.len() {
        if !is_v2_edit_span(spans[start].kind) {
            start += 1;
            continue;
        }
        let mut cursor = start;
        let mut expect_edit = true;
        let mut edit_count = 0usize;
        let mut previous_edit_kind = None;
        let mut has_source_only = false;
        let mut has_target_only = false;
        let mut best_end = None;
        while cursor < spans.len() {
            let span = &spans[cursor];
            if expect_edit {
                if !is_v2_edit_span(span.kind)
                    || previous_edit_kind == Some(span.kind)
                    || v2_span_axis_durations_ms(span)
                        .0
                        .max(v2_span_axis_durations_ms(span).1)
                        > ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_SINGLE_MS
                {
                    break;
                }
                previous_edit_kind = Some(span.kind);
                has_source_only |= span.kind == AudioTimeMapSpanKind::SourceOnly;
                has_target_only |= span.kind == AudioTimeMapSpanKind::TargetOnly;
                edit_count = edit_count.saturating_add(1);
                if edit_count >= ALIGNMENT_V2_BALANCED_MICRO_EDIT_MIN_COUNT
                    && has_source_only
                    && has_target_only
                    && v2_balanced_micro_edit_island_fits(&spans[start..=cursor], expected_scale)
                {
                    best_end = Some(cursor);
                }
            } else if span.kind != AudioTimeMapSpanKind::Matched {
                break;
            }
            let source_duration_ms = span
                .source_end_ms
                .saturating_sub(spans[start].source_start_ms);
            let target_duration_ms = span
                .target_end_ms
                .saturating_sub(spans[start].target_start_ms);
            if source_duration_ms.max(target_duration_ms)
                > ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_ISLAND_MS
            {
                break;
            }
            expect_edit = !expect_edit;
            cursor += 1;
        }
        let Some(end) = best_end else {
            start += 1;
            continue;
        };
        let replace_start = start
            .checked_sub(1)
            .filter(|index| spans[*index].kind == AudioTimeMapSpanKind::Matched)
            .unwrap_or(start);
        let replace_end = end
            .checked_add(1)
            .filter(|index| {
                *index < spans.len() && spans[*index].kind == AudioTimeMapSpanKind::Matched
            })
            .unwrap_or(end);
        let merged = create_v2_span(
            AudioTimeMapSpanKind::Matched,
            spans[replace_start].source_start_ms,
            spans[replace_end].source_end_ms,
            spans[replace_start].target_start_ms,
            spans[replace_end].target_end_ms,
        );
        spans.splice(replace_start..=replace_end, [merged]);
        absorbed_count = absorbed_count.saturating_add(1);
        start = replace_start.saturating_sub(1);
    }
    absorbed_count
}

fn v2_balanced_micro_edit_island_fits(island: &[AudioTimeMapSpanDto], expected_scale: f64) -> bool {
    let (Some(first), Some(last)) = (island.first(), island.last()) else {
        return false;
    };
    let source_duration_ms = last.source_end_ms.saturating_sub(first.source_start_ms);
    let target_duration_ms = last.target_end_ms.saturating_sub(first.target_start_ms);
    source_duration_ms > 0
        && target_duration_ms > 0
        && source_duration_ms.max(target_duration_ms)
            <= ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_ISLAND_MS
        && (target_duration_ms as f64 - expected_scale * source_duration_ms as f64).abs()
            <= ALIGNMENT_V2_BALANCED_MICRO_EDIT_MAX_NET_RESIDUAL_MS
}

pub(super) fn recover_v2_training_anchor_islands(
    spans: &mut Vec<AudioTimeMapSpanDto>,
    hypothesis: &AffineHypothesis,
) -> Vec<String> {
    if !hypothesis.scale.is_finite() || hypothesis.scale <= 0.0 {
        return Vec::new();
    }
    let residual_tolerance_ms = v2_affine_match_config()
        .residual_tolerance_ms
        .unsigned_abs();
    let mut diagnostics = Vec::new();
    let mut span_index = 0_usize;
    while span_index < spans.len() {
        if spans[span_index].kind != AudioTimeMapSpanKind::Ambiguous {
            span_index += 1;
            continue;
        }
        let ambiguous = spans[span_index].clone();
        let mut anchors = hypothesis
            .training_anchors
            .iter()
            .filter(|anchor| {
                anchor.residual_ms.unsigned_abs() <= residual_tolerance_ms
                    && u64::try_from(anchor.source_time_ms).is_ok_and(|source_time_ms| {
                        source_time_ms >= ambiguous.source_start_ms
                            && source_time_ms < ambiguous.source_end_ms
                    })
                    && u64::try_from(anchor.target_time_ms).is_ok_and(|target_time_ms| {
                        target_time_ms >= ambiguous.target_start_ms
                            && target_time_ms < ambiguous.target_end_ms
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        anchors.sort_unstable_by_key(|anchor| (anchor.source_time_ms, anchor.target_time_ms));
        anchors.dedup_by_key(|anchor| (anchor.source_time_ms, anchor.target_time_ms));
        let Some((first, last, support_count)) =
            widest_v2_training_anchor_rescue_chain(&anchors, hypothesis.scale)
        else {
            span_index += 1;
            continue;
        };
        let Ok(source_start_ms) = u64::try_from(first.source_time_ms) else {
            span_index += 1;
            continue;
        };
        let Ok(target_start_ms) = u64::try_from(first.target_time_ms) else {
            span_index += 1;
            continue;
        };
        let source_end_ms = u64::try_from(last.source_time_ms)
            .unwrap_or(ambiguous.source_end_ms)
            .saturating_add(ALIGNMENT_V2_FINE_HOP_MS as u64)
            .min(ambiguous.source_end_ms);
        let target_padding_ms = (hypothesis.scale * ALIGNMENT_V2_FINE_HOP_MS as f64)
            .round()
            .max(1.0) as u64;
        let target_end_ms = u64::try_from(last.target_time_ms)
            .unwrap_or(ambiguous.target_end_ms)
            .saturating_add(target_padding_ms)
            .min(ambiguous.target_end_ms);
        if source_end_ms <= source_start_ms
            || target_end_ms <= target_start_ms
            || !v2_anchor_chain_fits_segment(
                &anchors,
                source_start_ms,
                source_end_ms,
                target_start_ms,
                target_end_ms,
                residual_tolerance_ms,
            )
        {
            span_index += 1;
            continue;
        }
        let bridge_from_left = v2_training_anchor_rescue_can_bridge_from_left(
            spans,
            span_index,
            &ambiguous,
            source_start_ms,
            target_start_ms,
            hypothesis.scale,
        );
        let mut replacement = Vec::with_capacity(3);
        if source_start_ms > ambiguous.source_start_ms
            || target_start_ms > ambiguous.target_start_ms
        {
            replacement.push(create_v2_span(
                if bridge_from_left {
                    AudioTimeMapSpanKind::Matched
                } else {
                    AudioTimeMapSpanKind::Ambiguous
                },
                ambiguous.source_start_ms,
                source_start_ms,
                ambiguous.target_start_ms,
                target_start_ms,
            ));
        }
        replacement.push(create_v2_span(
            AudioTimeMapSpanKind::Matched,
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
        ));
        if source_end_ms < ambiguous.source_end_ms || target_end_ms < ambiguous.target_end_ms {
            replacement.push(create_v2_span(
                AudioTimeMapSpanKind::Ambiguous,
                source_end_ms,
                ambiguous.source_end_ms,
                target_end_ms,
                ambiguous.target_end_ms,
            ));
        }
        let bridge_note = if bridge_from_left {
            "；并以已匹配左边界和首个训练锚点恢复短桥"
        } else {
            ""
        };
        diagnostics.push(format!(
            "fine path anchor rescue：仅用 {support_count} 个训练锚点在原 ambiguous 内恢复 matched 岛 source=[{source_start_ms},{source_end_ms}) ms、target=[{target_start_ms},{target_end_ms}) ms{bridge_note}；留出锚点未参与地图生成。"
        ));

        let replacement_len = replacement.len();
        spans.splice(span_index..=span_index, replacement);
        span_index = span_index.saturating_add(replacement_len);
    }
    diagnostics
}

fn widest_v2_training_anchor_rescue_chain(
    anchors: &[AffineAnchorEvidence],
    expected_scale: f64,
) -> Option<(&AffineAnchorEvidence, &AffineAnchorEvidence, usize)> {
    let mut best = None::<(usize, usize, usize, u64)>;
    for start in 0..anchors.len() {
        let mut source_buckets = HashSet::<u64>::new();
        let mut target_buckets = HashSet::<u64>::new();
        for end in start..anchors.len() {
            let source_time_ms = u64::try_from(anchors[end].source_time_ms).ok()?;
            let target_time_ms = u64::try_from(anchors[end].target_time_ms).ok()?;
            if end > start
                && (anchors[end].source_time_ms <= anchors[end - 1].source_time_ms
                    || anchors[end].target_time_ms <= anchors[end - 1].target_time_ms)
            {
                break;
            }
            source_buckets.insert(source_time_ms / ALIGNMENT_V2_AMBIGUOUS_RESCUE_TIME_BUCKET_MS);
            target_buckets.insert(target_time_ms / ALIGNMENT_V2_AMBIGUOUS_RESCUE_TIME_BUCKET_MS);
            let source_span_ms =
                source_time_ms.abs_diff(u64::try_from(anchors[start].source_time_ms).ok()?);
            let support_count = source_buckets.len().min(target_buckets.len());
            let short_chain_supported = support_count >= ALIGNMENT_V2_AMBIGUOUS_RESCUE_MIN_ANCHORS
                && source_span_ms >= ALIGNMENT_V2_AMBIGUOUS_RESCUE_MIN_SPAN_MS;
            let long_chain_supported = support_count
                >= ALIGNMENT_V2_AMBIGUOUS_RESCUE_LONG_MIN_ANCHORS
                && source_span_ms >= ALIGNMENT_V2_AMBIGUOUS_RESCUE_LONG_MIN_SPAN_MS;
            if !short_chain_supported && !long_chain_supported {
                continue;
            }
            let target_span_ms =
                target_time_ms.abs_diff(u64::try_from(anchors[start].target_time_ms).ok()?);
            let expected_target_span_ms = expected_scale * source_span_ms as f64;
            if (target_span_ms as f64 - expected_target_span_ms).abs()
                > ALIGNMENT_V2_AMBIGUOUS_RESCUE_MAX_ENDPOINT_DRIFT_MS as f64
            {
                continue;
            }
            let candidate = (start, end, support_count, source_span_ms);
            if best.is_none_or(|current| {
                candidate.3 > current.3
                    || (candidate.3 == current.3 && candidate.2 > current.2)
                    || (candidate.3 == current.3
                        && candidate.2 == current.2
                        && candidate.0 < current.0)
            }) {
                best = Some(candidate);
            }
        }
    }
    let (start, end, support_count, _) = best?;
    Some((&anchors[start], &anchors[end], support_count))
}

fn v2_training_anchor_rescue_can_bridge_from_left(
    spans: &[AudioTimeMapSpanDto],
    span_index: usize,
    ambiguous: &AudioTimeMapSpanDto,
    source_anchor_ms: u64,
    target_anchor_ms: u64,
    expected_scale: f64,
) -> bool {
    let Some(previous) = span_index.checked_sub(1).and_then(|index| spans.get(index)) else {
        return false;
    };
    if previous.kind != AudioTimeMapSpanKind::Matched
        || previous.source_end_ms != ambiguous.source_start_ms
        || previous.target_end_ms != ambiguous.target_start_ms
        || source_anchor_ms <= ambiguous.source_start_ms
        || target_anchor_ms <= ambiguous.target_start_ms
    {
        return false;
    }
    let source_gap_ms = source_anchor_ms.saturating_sub(ambiguous.source_start_ms);
    let target_gap_ms = target_anchor_ms.saturating_sub(ambiguous.target_start_ms);
    source_gap_ms <= ALIGNMENT_V2_AMBIGUOUS_RESCUE_MAX_LEFT_BRIDGE_MS
        && target_gap_ms <= ALIGNMENT_V2_AMBIGUOUS_RESCUE_MAX_LEFT_BRIDGE_MS
        && (target_gap_ms as f64 - expected_scale * source_gap_ms as f64).abs()
            <= ALIGNMENT_V2_AMBIGUOUS_RESCUE_MAX_ENDPOINT_DRIFT_MS as f64
}

fn v2_anchor_chain_fits_segment(
    anchors: &[AffineAnchorEvidence],
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
    residual_tolerance_ms: u64,
) -> bool {
    let source_duration_ms = source_end_ms.saturating_sub(source_start_ms);
    let target_duration_ms = target_end_ms.saturating_sub(target_start_ms);
    if source_duration_ms == 0 || target_duration_ms == 0 {
        return false;
    }
    anchors.iter().all(|anchor| {
        let (Ok(source_time_ms), Ok(target_time_ms)) = (
            u64::try_from(anchor.source_time_ms),
            u64::try_from(anchor.target_time_ms),
        ) else {
            return false;
        };
        if source_time_ms < source_start_ms
            || source_time_ms >= source_end_ms
            || target_time_ms < target_start_ms
            || target_time_ms >= target_end_ms
        {
            return true;
        }
        let source_delta_ms = source_time_ms.saturating_sub(source_start_ms);
        let mapped_target_ms = u128::from(target_start_ms).saturating_add(
            u128::from(source_delta_ms)
                .saturating_mul(u128::from(target_duration_ms))
                .saturating_add(u128::from(source_duration_ms / 2))
                / u128::from(source_duration_ms),
        );
        u64::try_from(mapped_target_ms).is_ok_and(|mapped_target_ms| {
            mapped_target_ms.abs_diff(target_time_ms) <= residual_tolerance_ms
        })
    })
}

pub(super) fn absorb_v2_short_tempo_skips(
    spans: &mut Vec<AudioTimeMapSpanDto>,
    expected_scale: f64,
) {
    if !expected_scale.is_finite() || expected_scale <= 0.0 {
        return;
    }

    // A run of repeated, same-direction lattice gaps can establish tempo evidence before any
    // individual matched run has accumulated a visible non-unit slope. A single short edit can
    // never satisfy this certificate.
    absorb_v2_repeated_tempo_skip_runs(spans, expected_scale);

    // Internal gaps are the strongest evidence: both sides must independently describe the same
    // local tempo, and consuming the lattice skip must improve the fit to the coarse tempo model.
    // Process these first so a long, evidence-backed run can later support edge extrapolation.
    let mut index = 1usize;
    while index + 1 < spans.len() {
        let left = &spans[index - 1];
        let skip = &spans[index];
        let right = &spans[index + 1];
        let absorb = is_v2_supported_internal_tempo_skip(left, skip, right, expected_scale);
        if !absorb {
            index += 1;
            continue;
        }
        let merged = create_v2_span(
            AudioTimeMapSpanKind::Matched,
            left.source_start_ms,
            right.source_end_ms,
            left.target_start_ms,
            right.target_end_ms,
        );
        spans.splice(index - 1..=index + 1, [merged]);
        index = index.saturating_sub(1).max(1);
    }

    while spans.len() >= 2 {
        let skip = &spans[0];
        let matched = &spans[1];
        let absorb = is_v2_supported_edge_tempo_skip(skip, matched, expected_scale)
            && skip.source_end_ms == matched.source_start_ms
            && skip.target_end_ms == matched.target_start_ms;
        if !absorb {
            break;
        }
        let merged = create_v2_span(
            AudioTimeMapSpanKind::Matched,
            skip.source_start_ms,
            matched.source_end_ms,
            skip.target_start_ms,
            matched.target_end_ms,
        );
        spans.splice(0..=1, [merged]);
    }
    while spans.len() >= 2 {
        let last_index = spans.len() - 1;
        let matched = &spans[last_index - 1];
        let skip = &spans[last_index];
        let absorb = is_v2_supported_edge_tempo_skip(skip, matched, expected_scale)
            && matched.source_end_ms == skip.source_start_ms
            && matched.target_end_ms == skip.target_start_ms;
        if !absorb {
            break;
        }
        let merged = create_v2_span(
            AudioTimeMapSpanKind::Matched,
            matched.source_start_ms,
            skip.source_end_ms,
            matched.target_start_ms,
            skip.target_end_ms,
        );
        spans.splice(last_index - 1..=last_index, [merged]);
    }
}

fn absorb_v2_repeated_tempo_skip_runs(spans: &mut Vec<AudioTimeMapSpanDto>, expected_scale: f64) {
    let mut start = 0usize;
    while start + 4 < spans.len() {
        if spans[start].kind != AudioTimeMapSpanKind::Matched {
            start += 1;
            continue;
        }
        let mut end = start;
        let mut best_supported_end = None;
        while end + 2 < spans.len() {
            let left = &spans[end];
            let skip = &spans[end + 1];
            let right = &spans[end + 2];
            let extends_run = left.kind == AudioTimeMapSpanKind::Matched
                && right.kind == AudioTimeMapSpanKind::Matched
                && is_v2_short_tempo_skip(skip)
                && v2_tempo_skip_direction_matches_scale(skip, expected_scale)
                && left.source_end_ms == skip.source_start_ms
                && left.target_end_ms == skip.target_start_ms
                && skip.source_end_ms == right.source_start_ms
                && skip.target_end_ms == right.target_start_ms;
            if !extends_run {
                break;
            }
            end += 2;
            if is_v2_supported_repeated_tempo_run(&spans[start..=end], expected_scale) {
                best_supported_end = Some(end);
            }
        }
        let Some(end) = best_supported_end else {
            start += 1;
            continue;
        };
        let merged = create_v2_span(
            AudioTimeMapSpanKind::Matched,
            spans[start].source_start_ms,
            spans[end].source_end_ms,
            spans[start].target_start_ms,
            spans[end].target_end_ms,
        );
        spans.splice(start..=end, [merged]);
        start = start.saturating_sub(1);
    }
}

fn is_v2_supported_repeated_tempo_run(run: &[AudioTimeMapSpanDto], expected_scale: f64) -> bool {
    if run.len() < 5 || run.len().is_multiple_of(2) {
        return false;
    }
    let matched = run.iter().step_by(2).collect::<Vec<_>>();
    let skips = run.iter().skip(1).step_by(2).collect::<Vec<_>>();
    if skips.len() < 3
        || skips
            .iter()
            .any(|skip| !v2_tempo_skip_direction_matches_scale(skip, expected_scale))
        || run.windows(2).any(|items| {
            items[0].source_end_ms != items[1].source_start_ms
                || items[0].target_end_ms != items[1].target_start_ms
        })
    {
        return false;
    }
    let matched_scales = matched
        .iter()
        .map(|span| {
            let (source_ms, target_ms) = v2_span_axis_durations_ms(span);
            if source_ms.min(target_ms) < ALIGNMENT_V2_TEMPO_INTERNAL_SIDE_MIN_MS {
                return None;
            }
            v2_matched_span_scale(span)
        })
        .collect::<Option<Vec<_>>>();
    let Some(matched_scales) = matched_scales else {
        return false;
    };
    let minimum_scale = matched_scales.iter().copied().fold(f64::INFINITY, f64::min);
    let maximum_scale = matched_scales
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let average_scale = matched_scales.iter().sum::<f64>() / matched_scales.len() as f64;
    if maximum_scale - minimum_scale > ALIGNMENT_V2_TEMPO_SLOPE_TOLERANCE
        || (average_scale - expected_scale).abs() > ALIGNMENT_V2_TEMPO_SLOPE_TOLERANCE
        || run.chunks_exact(2).any(|items| {
            let (left_source_ms, left_target_ms) = v2_span_axis_durations_ms(&items[0]);
            let (skip_source_ms, skip_target_ms) = v2_span_axis_durations_ms(&items[1]);
            let combined_source_ms = left_source_ms.saturating_add(skip_source_ms);

            let combined_target_ms = left_target_ms.saturating_add(skip_target_ms);
            combined_source_ms == 0
                || (combined_target_ms as f64 / combined_source_ms as f64 - expected_scale).abs()
                    > ALIGNMENT_V2_TEMPO_CADENCE_SCALE_TOLERANCE
        })
    {
        return false;
    }
    let (base_source_ms, base_target_ms) = matched.iter().fold((0u64, 0u64), |total, span| {
        let duration = v2_span_axis_durations_ms(span);
        (
            total.0.saturating_add(duration.0),
            total.1.saturating_add(duration.1),
        )
    });
    let (skip_source_ms, skip_target_ms) = skips.iter().fold((0u64, 0u64), |total, span| {
        let duration = v2_span_axis_durations_ms(span);
        (
            total.0.saturating_add(duration.0),
            total.1.saturating_add(duration.1),
        )
    });
    v2_tempo_durations_improve_expected_fit(
        base_source_ms,
        base_target_ms,
        skip_source_ms,
        skip_target_ms,
        expected_scale,
    )
}

fn is_v2_supported_internal_tempo_skip(
    left: &AudioTimeMapSpanDto,
    skip: &AudioTimeMapSpanDto,
    right: &AudioTimeMapSpanDto,
    expected_scale: f64,
) -> bool {
    if left.kind != AudioTimeMapSpanKind::Matched
        || right.kind != AudioTimeMapSpanKind::Matched
        || !is_v2_short_tempo_skip(skip)
        || !v2_tempo_skip_direction_matches_scale(skip, expected_scale)
        || left.source_end_ms != skip.source_start_ms
        || left.target_end_ms != skip.target_start_ms
        || skip.source_end_ms != right.source_start_ms
        || skip.target_end_ms != right.target_start_ms
    {
        return false;
    }
    let (left_source_ms, left_target_ms) = v2_span_axis_durations_ms(left);
    let (right_source_ms, right_target_ms) = v2_span_axis_durations_ms(right);
    if left_source_ms.min(left_target_ms) < ALIGNMENT_V2_TEMPO_INTERNAL_SIDE_MIN_MS
        || right_source_ms.min(right_target_ms) < ALIGNMENT_V2_TEMPO_INTERNAL_SIDE_MIN_MS
    {
        return false;
    }
    let Some(left_scale) = v2_matched_span_scale(left) else {
        return false;
    };
    let Some(right_scale) = v2_matched_span_scale(right) else {
        return false;
    };
    if (left_scale - right_scale).abs() > ALIGNMENT_V2_TEMPO_SLOPE_TOLERANCE
        || ((left_scale + right_scale) / 2.0 - expected_scale).abs()
            > ALIGNMENT_V2_TEMPO_SLOPE_TOLERANCE
        || !v2_matched_scale_supports_skip_direction(left_scale, skip.kind)
        || !v2_matched_scale_supports_skip_direction(right_scale, skip.kind)
    {
        return false;
    }
    v2_tempo_skip_improves_expected_fit(
        left_source_ms.saturating_add(right_source_ms),
        left_target_ms.saturating_add(right_target_ms),
        skip,
        expected_scale,
    )
}

fn is_v2_supported_edge_tempo_skip(
    skip: &AudioTimeMapSpanDto,
    matched: &AudioTimeMapSpanDto,
    expected_scale: f64,
) -> bool {
    if matched.kind != AudioTimeMapSpanKind::Matched
        || !is_v2_short_tempo_skip(skip)
        || !v2_tempo_skip_direction_matches_scale(skip, expected_scale)
    {
        return false;
    }
    let (source_ms, target_ms) = v2_span_axis_durations_ms(matched);
    if source_ms.min(target_ms) < ALIGNMENT_V2_TEMPO_EDGE_SUPPORT_MIN_MS {
        return false;
    }
    let Some(matched_scale) = v2_matched_span_scale(matched) else {
        return false;
    };
    v2_matched_scale_supports_skip_direction(matched_scale, skip.kind)
        && (matched_scale - expected_scale).abs() <= ALIGNMENT_V2_TEMPO_SLOPE_TOLERANCE
        && v2_tempo_skip_improves_expected_fit(source_ms, target_ms, skip, expected_scale)
}

fn v2_span_axis_durations_ms(span: &AudioTimeMapSpanDto) -> (u64, u64) {
    (
        span.source_end_ms.saturating_sub(span.source_start_ms),
        span.target_end_ms.saturating_sub(span.target_start_ms),
    )
}

fn v2_matched_span_scale(span: &AudioTimeMapSpanDto) -> Option<f64> {
    let (source_ms, target_ms) = v2_span_axis_durations_ms(span);
    (span.kind == AudioTimeMapSpanKind::Matched && source_ms > 0 && target_ms > 0)
        .then_some(target_ms as f64 / source_ms as f64)
}

fn v2_tempo_skip_direction_matches_scale(skip: &AudioTimeMapSpanDto, expected_scale: f64) -> bool {
    match skip.kind {
        AudioTimeMapSpanKind::TargetOnly => expected_scale > 1.0,
        AudioTimeMapSpanKind::SourceOnly => expected_scale < 1.0,
        AudioTimeMapSpanKind::Matched | AudioTimeMapSpanKind::Ambiguous => false,
    }
}

fn v2_matched_scale_supports_skip_direction(
    matched_scale: f64,
    skip_kind: AudioTimeMapSpanKind,
) -> bool {
    match skip_kind {
        AudioTimeMapSpanKind::TargetOnly => {
            matched_scale > 1.0 + ALIGNMENT_V2_TEMPO_EDGE_DIRECTION_EPSILON
        }
        AudioTimeMapSpanKind::SourceOnly => {
            matched_scale < 1.0 - ALIGNMENT_V2_TEMPO_EDGE_DIRECTION_EPSILON
        }
        AudioTimeMapSpanKind::Matched | AudioTimeMapSpanKind::Ambiguous => false,
    }
}

fn v2_tempo_skip_improves_expected_fit(
    base_source_ms: u64,
    base_target_ms: u64,
    skip: &AudioTimeMapSpanDto,
    expected_scale: f64,
) -> bool {
    let (skip_source_ms, skip_target_ms) = v2_span_axis_durations_ms(skip);
    v2_tempo_durations_improve_expected_fit(
        base_source_ms,
        base_target_ms,
        skip_source_ms,
        skip_target_ms,
        expected_scale,
    )
}

fn v2_tempo_durations_improve_expected_fit(
    base_source_ms: u64,
    base_target_ms: u64,
    skip_source_ms: u64,
    skip_target_ms: u64,
    expected_scale: f64,
) -> bool {
    let base_residual_ms = (base_target_ms as f64 - expected_scale * base_source_ms as f64).abs();
    let merged_residual_ms = ((base_target_ms.saturating_add(skip_target_ms)) as f64
        - expected_scale * (base_source_ms.saturating_add(skip_source_ms)) as f64)
        .abs();
    merged_residual_ms + 0.5 < base_residual_ms
        && merged_residual_ms <= ALIGNMENT_V2_TEMPO_SKIP_MAX_MS as f64
}

fn is_v2_short_tempo_skip(span: &AudioTimeMapSpanDto) -> bool {
    let duration_ms = span
        .source_end_ms
        .saturating_sub(span.source_start_ms)
        .max(span.target_end_ms.saturating_sub(span.target_start_ms));
    matches!(
        span.kind,
        AudioTimeMapSpanKind::SourceOnly | AudioTimeMapSpanKind::TargetOnly
    ) && duration_ms > 0
        && duration_ms <= ALIGNMENT_V2_TEMPO_SKIP_MAX_MS
}

pub(super) fn validate_v2_time_map_spans(spans: &[AudioTimeMapSpanDto]) -> Result<(), String> {
    for (index, span) in spans.iter().enumerate() {
        let source_duration = span.source_end_ms.checked_sub(span.source_start_ms);
        let target_duration = span.target_end_ms.checked_sub(span.target_start_ms);
        let valid_shape = match (span.kind, source_duration, target_duration) {
            (AudioTimeMapSpanKind::Matched, Some(source), Some(target)) => source > 0 && target > 0,
            (AudioTimeMapSpanKind::SourceOnly, Some(source), Some(target)) => {
                source > 0 && target == 0
            }
            (AudioTimeMapSpanKind::TargetOnly, Some(source), Some(target)) => {
                source == 0 && target > 0
            }
            (AudioTimeMapSpanKind::Ambiguous, Some(source), Some(target)) => {
                source > 0 || target > 0
            }
            _ => false,
        };
        if !valid_shape {
            return Err(format!("V2 TimeMap 第 {} 段形状无效。", index + 1));
        }
        if let Some(previous) = index.checked_sub(1).and_then(|item| spans.get(item)) {
            if previous.source_end_ms != span.source_start_ms
                || previous.target_end_ms != span.target_start_ms
            {
                return Err(format!("V2 TimeMap 第 {} 段与前一段不连续。", index + 1));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::atomic::AtomicBool};

    use super::{
        assess_coarse_pair, group_v2_pair_coarse_temporal_windows_with_probe_count,
        solve_selected_fine_path, AffineHypothesis, AlignmentAudioInput, PresentationRangeMs,
        V2PairCoarseInput, V2SelectedFinePathInput, V2TrackPairCandidate,
        ALIGNMENT_V2_TEMPORAL_GROUP_MAX_RECENT_PROBES, AUDIO_ALIGNMENT_CANCELLED,
    };
    use crate::media_probe::AudioStreamProbe;

    fn audio_input(stream_index: u32) -> AlignmentAudioInput {
        AlignmentAudioInput {
            presentation_origin_ms: 0,
            media_duration_ms: Some(120_000),
            content_identity: None,
            decode_timeline: None,
            audio_stream_count: 1,
            explicit_stream_selection: true,
            stream: AudioStreamProbe {
                stream_index,
                codec_name: Some("aac".to_string()),
                start_time_ms: 0,
                timeline_offset_ms: 0,
                duration_ms: Some(120_000),
                time_base: Some("1/48000".to_string()),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: Some("stereo".to_string()),
                language: Some("jpn".to_string()),
                title: None,
                is_default: true,
                is_commentary: false,
            },
        }
    }

    fn temporal_candidate(
        stream_index: u32,
        source: PresentationRangeMs,
        target: PresentationRangeMs,
    ) -> V2TrackPairCandidate {
        V2TrackPairCandidate {
            source_input: audio_input(stream_index),
            target_input: audio_input(stream_index + 100),
            coarse_hypothesis: None,
            hypothesis: AffineHypothesis {
                scale: 1.0,
                offset_ms: target.start_ms.saturating_sub(source.start_ms),
                inlier_count: 8,
                unique_source_count: 8,
                unique_source_coverage: 0.9,
                unique_target_count: 8,
                unique_target_coverage: 0.9,
                source_start_ms: source.start_ms,
                source_end_ms: source.end_ms,
                p50_residual_ms: 20,
                p95_residual_ms: 40,
                max_residual_ms: 60,
                training_anchors: Vec::new(),
                held_out_anchors: Vec::new(),
                held_out_within_tolerance_count: 0,
            },
            offset_island_count: 1,
            score: 0.8,
            temporal_coverage: 0.9,
            intrinsic_margin: 0.5,
            repeated_content_only: false,
            observation_count: 16,
            source_landmark_count: 16,
            target_landmark_count: 16,
            source_spectral_backend_id: "test-cpu".to_string(),
            target_spectral_backend_id: "test-cpu".to_string(),
            toolchain_cache_identity: "toolchain=test".to_string(),
            global_source_interval: source,
            global_target_interval: target,
            fine_working_set_bytes: 0,
        }
    }

    #[test]
    fn coarse_interface_observes_cancellation_before_artifact_access() {
        let source = [audio_input(1)];
        let target = [audio_input(2)];
        let source_artifacts = HashMap::new();
        let target_artifacts = HashMap::new();
        let cancel = AtomicBool::new(true);

        let error = assess_coarse_pair(V2PairCoarseInput {
            source_inputs: &source,
            target_inputs: &target,
            source_artifacts: &source_artifacts,
            target_artifacts: &target_artifacts,
            toolchain_cache_identity: "toolchain=test",
            has_explicit_selection: true,
            coarse_resident_baseline_bytes: 0,
            cancel_flag: Some(&cancel),
        })
        .unwrap_err();

        assert_eq!(error, AUDIO_ALIGNMENT_CANCELLED);
    }

    #[test]
    fn selected_fine_path_interface_rejects_an_empty_axis() {
        let candidate = temporal_candidate(
            1,
            PresentationRangeMs {
                start_ms: 0,
                end_ms: 100_000,
            },
            PresentationRangeMs {
                start_ms: 10_000,
                end_ms: 110_000,
            },
        );

        let error = solve_selected_fine_path(V2SelectedFinePathInput {
            source_frames: &[],
            target_frames: &[],
            selected_candidate_hypothesis: &candidate.hypothesis,
            max_dp_cells: 1,
            active_artifact_bytes: 0,
            cancel_flag: None,
        })
        .unwrap_err();

        assert_eq!(error, "Alignment V2 分块输入为空或 affine scale 无效。");
    }

    #[test]
    fn temporal_grouping_is_stable_and_preserves_every_candidate() {
        let candidates = vec![
            temporal_candidate(
                1,
                PresentationRangeMs {
                    start_ms: 0,
                    end_ms: 100_000,
                },
                PresentationRangeMs {
                    start_ms: 10_000,
                    end_ms: 110_000,
                },
            ),
            temporal_candidate(
                2,
                PresentationRangeMs {
                    start_ms: 5_000,
                    end_ms: 100_000,
                },
                PresentationRangeMs {
                    start_ms: 15_000,
                    end_ms: 110_000,
                },
            ),
            temporal_candidate(
                3,
                PresentationRangeMs {
                    start_ms: 300_000,
                    end_ms: 400_000,
                },
                PresentationRangeMs {
                    start_ms: 500_000,
                    end_ms: 600_000,
                },
            ),
        ];

        let (groups, probe_count) =
            group_v2_pair_coarse_temporal_windows_with_probe_count(&candidates);
        let mut members = groups
            .iter()
            .flat_map(|group| group.member_indices.iter().copied())
            .collect::<Vec<_>>();
        members.sort_unstable();

        assert_eq!(groups.len(), 2);
        assert_eq!(members, vec![0, 1, 2]);
        assert!(probe_count <= candidates.len() * ALIGNMENT_V2_TEMPORAL_GROUP_MAX_RECENT_PROBES);
    }
}
