//! Durable lifecycle journal for local-sensitive alignment run manifests.

use super::{
    AlignmentEvidenceSampleDto, AudioAlignmentBatchJobSnapshot, AudioAlignmentBatchPairSnapshot,
    AudioAlignmentBatchPairingMode, AudioAlignmentJobStatus, AudioStreamProbe,
    AudioTimeMapBoundaryStatus, AudioTimeMapSpanKind, MediaContentIdentity,
    PlannedAudioAlignmentBatch, ALIGNMENT_V2_ENGINE_VERSION, ALIGNMENT_V2_FEATURE_VERSION,
};
use crate::diagnostic_log::validate_run_id;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

pub(crate) const ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION: &str = "summary";
pub(crate) const MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILES: usize = 16;
const ALIGNMENT_SENSITIVE_MANIFEST_DIRECTORY: &str = "alignment-run-manifests";
const ALIGNMENT_SENSITIVE_MANIFEST_ENVELOPE_VERSION: u8 = 1;
const MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ALIGNMENT_SENSITIVE_MANIFEST_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
const ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_SCHEMA_VERSION: u8 = 1;
const MAX_ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_BYTES: u64 = 64 * 1024;
static ALIGNMENT_SENSITIVE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentSensitiveManifestEnvelope<'a, T> {
    schema_version: u8,
    artifact_type: &'static str,
    privacy_class: &'static str,
    payload_digest: String,
    payload: &'a T,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlignmentSensitiveReviewTaskSummary {
    pub query_key: String,
    pub source_timestamp_ms: u64,
    pub source_preview_start_ms: u64,
    pub source_preview_end_ms: u64,
    pub target_review_start_ms: u64,
    pub target_review_end_ms: u64,
    pub candidate_timestamps_ms: Vec<u64>,
    pub category: String,
    pub risk_score_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlignmentSensitiveReviewPairSummary {
    pub pair_ordinal: usize,
    pub source_media_id_digest: String,
    pub target_media_id_digest: String,
    pub risky_task_count: usize,
    pub tasks: Vec<AlignmentSensitiveReviewTaskSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlignmentSensitiveManifestSummary {
    pub run_id: String,
    pub manifest_payload_digest: String,
    #[serde(default)]
    pub manifest_canonical_payload_digest: Option<String>,
    pub lifecycle_stage: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub app_version: String,
    pub engine_version: String,
    pub feature_version: String,
    pub status: String,
    pub source_media_count: usize,
    pub target_media_count: usize,
    pub pair_count: usize,
    pub processed_pair_count: usize,
    pub completed_pair_count: usize,
    pub failed_pair_count: usize,
    pub cancelled_pair_count: usize,
    pub prepared_media_count: usize,
    pub identified_media_count: usize,
    pub audio_candidate_count: usize,
    pub landmark_artifact_count: usize,
    pub landmark_cache_hit_count: usize,
    pub evidence_span_count: usize,
    pub uncertain_span_count: usize,
    pub visual_evidence_pair_count: usize,
    pub visual_evidence_requested: bool,
    pub evidence_group_key: Option<String>,
    pub intake_state: String,
    pub ready_for_training_intake: bool,
    #[serde(default)]
    pub review_candidate_pairs: Vec<AlignmentSensitiveReviewPairSummary>,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentSensitiveManifestSummaryEnvelope<'a> {
    schema_version: u8,
    artifact_type: &'static str,
    privacy_class: &'static str,
    summary_digest: String,
    summary: &'a AlignmentSensitiveManifestSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedAlignmentSensitiveManifestSummaryEnvelope {
    schema_version: u8,
    artifact_type: String,
    privacy_class: String,
    summary_digest: String,
    summary: AlignmentSensitiveManifestSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentSensitiveManifestEnvelopeHeader {
    schema_version: u8,
    artifact_type: String,
    privacy_class: String,
    payload_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedAlignmentSensitiveManifestEnvelope {
    schema_version: u8,
    artifact_type: String,
    privacy_class: String,
    payload_digest: String,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AlignmentSensitiveManifestDigests {
    pub payload_digest: String,
    pub canonical_payload_digest: String,
}

const AUDIO_ALIGNMENT_SENSITIVE_MANIFEST_SCHEMA_VERSION: u8 = 1;
pub(super) const ALIGNMENT_SENSITIVE_REVIEW_SELECTOR_VERSION: &str =
    "alignment-sensitive-review-selector-v1";
const ALIGNMENT_SENSITIVE_REVIEW_MAX_TASKS_PER_PAIR: usize = 20;
const ALIGNMENT_SENSITIVE_REVIEW_MAX_TASKS_PER_RUN: usize = 64;
const ALIGNMENT_SENSITIVE_REVIEW_MIN_SOURCE_SPACING_MS: u64 = 4_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioAlignmentSensitivePlanMedia {
    media_ordinal: usize,
    media_id: String,
    role: &'static str,
    path: String,
    requested_audio_stream_index: Option<u32>,
    requested_video_stream_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioAlignmentSensitivePlanPair {
    pair_ordinal: usize,
    source_media_ordinal: usize,
    target_media_ordinal: usize,
    source_media_id: String,
    target_media_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioAlignmentSensitivePlanParameters {
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    requested_spectral_backend: String,
    planned_spectral_backend_id: String,
    spectral_backend_detail: String,
    spectral_backend_fallback_reason: Option<String>,
    sample_rate: Option<u32>,
    window_ms: Option<u64>,
    match_threshold: Option<f64>,
    min_gap_ms: Option<u64>,
    max_cells: Option<usize>,
    enable_visual_evidence: Option<bool>,
    visual_sample_interval_ms: Option<u64>,
    localization_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioAlignmentSensitivePlan {
    pairing_mode: AudioAlignmentBatchPairingMode,
    media: Vec<AudioAlignmentSensitivePlanMedia>,
    pairs: Vec<AudioAlignmentSensitivePlanPair>,
    parameters_digest: String,
    parameters: AudioAlignmentSensitivePlanParameters,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AudioAlignmentSensitivePreparedAudioCandidate {
    pub(super) presentation_origin_ms: i64,
    pub(super) media_duration_ms: Option<u64>,
    pub(super) explicit_stream_selection: bool,
    pub(super) stream: AudioStreamProbe,
    pub(super) first_decoded_pts_ms: Option<i64>,
    pub(super) pts_discontinuity_count: Option<u64>,
    pub(super) max_pts_gap_ms: Option<u64>,
    pub(super) skip_samples: Option<u64>,
    pub(super) discard_padding: Option<u64>,
    pub(super) decoded_frame_count: Option<u64>,
    pub(super) normalized_pcm_origin_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AudioAlignmentSensitiveLandmarkArtifact {
    pub(super) audio_stream_index: u32,
    pub(super) cache_key: String,
    pub(super) cache_hit: bool,
    pub(super) cache_origin: &'static str,
    pub(super) cache_persistence_error: Option<String>,
    pub(super) landmark_count: usize,
    pub(super) coarse_fingerprint_count: usize,
    pub(super) spectral_backend_id: String,
    pub(super) requested_backend: String,
    pub(super) backend_detail: String,
    pub(super) fallback_reason: Option<String>,
    pub(super) presentation_start_ms: i64,
    pub(super) presentation_end_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AudioAlignmentSensitivePreparedMedia {
    pub(super) media_ordinal: usize,
    pub(super) media_id: String,
    pub(super) role: &'static str,
    pub(super) requested_path: String,
    pub(super) canonical_path: Option<String>,
    pub(super) requested_audio_stream_index: Option<u32>,
    pub(super) requested_video_stream_index: Option<u32>,
    pub(super) preparation_state: &'static str,
    pub(super) physical_group_ordinal: Option<usize>,
    pub(super) content_identity: Option<MediaContentIdentity>,
    pub(super) audio_candidates: Vec<AudioAlignmentSensitivePreparedAudioCandidate>,
    pub(super) landmark_artifacts: Vec<AudioAlignmentSensitiveLandmarkArtifact>,
    pub(super) extraction_notes: Vec<String>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioAlignmentSensitiveRunManifest {
    schema_version: u8,
    artifact_type: &'static str,
    privacy_class: &'static str,
    run_id: String,
    lifecycle_stage: &'static str,
    created_at_ms: u64,
    updated_at_ms: u64,
    app_version: &'static str,
    engine_version: &'static str,
    feature_version: &'static str,
    plan: AudioAlignmentSensitivePlan,
    prepared_media: Vec<AudioAlignmentSensitivePreparedMedia>,
    snapshot: AudioAlignmentBatchJobSnapshot,
}

#[derive(Debug, Clone)]
struct AlignmentSensitiveReviewCandidate {
    source_timestamp_ms: u64,
    source_preview_start_ms: u64,
    source_preview_end_ms: u64,
    target_review_start_ms: u64,
    target_review_end_ms: u64,
    candidate_timestamps_ms: Vec<u64>,
    category: &'static str,
    risk_score_micros: u64,
}

fn create_audio_alignment_sensitive_plan(
    plan: &PlannedAudioAlignmentBatch,
) -> Result<AudioAlignmentSensitivePlan, String> {
    let request = &plan
        .pairs
        .first()
        .ok_or_else(|| "本机敏感执行清单无法绑定空批次。".to_string())?
        .request;
    let parameters = AudioAlignmentSensitivePlanParameters {
        ffmpeg_path: request.ffmpeg_path.clone(),
        ffprobe_path: request.ffprobe_path.clone(),
        requested_spectral_backend: plan.spectral_backend_request.requested_backend.clone(),
        planned_spectral_backend_id: plan.spectral_backend_request.planned_backend_id.clone(),
        spectral_backend_detail: plan.spectral_backend_request.backend_detail.clone(),
        spectral_backend_fallback_reason: plan.spectral_backend_request.fallback_reason.clone(),
        sample_rate: request.sample_rate,
        window_ms: request.window_ms,
        match_threshold: request.match_threshold,
        min_gap_ms: request.min_gap_ms,
        max_cells: request.max_cells,
        enable_visual_evidence: request.enable_visual_evidence,
        visual_sample_interval_ms: request.visual_sample_interval_ms,
        localization_mode: request.localization_mode,
    };
    let parameters_bytes = serde_json::to_vec(&parameters)
        .map_err(|error| format!("本机敏感执行清单参数无法序列化：{error}"))?;
    let parameters_digest = format!("sha256:{:x}", Sha256::digest(&parameters_bytes));
    Ok(AudioAlignmentSensitivePlan {
        pairing_mode: plan.pairing_mode.clone(),
        media: plan
            .media
            .iter()
            .enumerate()
            .map(|(index, media)| AudioAlignmentSensitivePlanMedia {
                media_ordinal: index + 1,
                media_id: media.media_id.clone(),
                role: media.role,
                path: media.path.clone(),
                requested_audio_stream_index: media.requested_audio_stream_index,
                requested_video_stream_index: media.requested_video_stream_index,
            })
            .collect(),
        pairs: plan
            .pairs
            .iter()
            .map(|pair| AudioAlignmentSensitivePlanPair {
                pair_ordinal: pair.pair_ordinal,
                source_media_ordinal: pair.source_media_index + 1,
                target_media_ordinal: pair.target_media_index + 1,
                source_media_id: pair.source_media_id.clone(),
                target_media_id: pair.target_media_id.clone(),
            })
            .collect(),
        parameters_digest,
        parameters,
    })
}

pub(super) fn alignment_sensitive_media_id_digest(media_id: &str) -> String {
    let value = format!("danmaku-studio/alignment-sensitive-media-id/v1\n{media_id}");
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

fn alignment_sensitive_unit_micros(value: f64) -> u64 {
    if !value.is_finite() {
        return 0;
    }
    (value.clamp(0.0, 1.0) * 1_000_000.0).round() as u64
}

fn alignment_sensitive_review_category(sample: &AlignmentEvidenceSampleDto) -> &'static str {
    let combined = format!(
        "{} {} {}",
        sample.state, sample.dominant_state, sample.reason_code
    )
    .to_ascii_lowercase();
    if combined.contains("conflict") || sample.difference_risk >= 0.75 {
        "evidence-conflict"
    } else if combined.contains("sourceonly")
        || combined.contains("targetonly")
        || combined.contains("noevidence")
        || combined.contains("no-evidence")
    {
        "missing-or-extra"
    } else if sample.difference_risk >= 0.4 || sample.offset_uncertainty_ms.unwrap_or(0) >= 2_000 {
        "weak-or-uncertain"
    } else if sample.strength >= 0.7 && sample.difference_risk <= 0.2 {
        "matched-control"
    } else {
        "mixed-evidence"
    }
}

fn alignment_sensitive_review_risk_micros(sample: &AlignmentEvidenceSampleDto) -> u64 {
    let uncertainty = sample
        .offset_uncertainty_ms
        .map(|value| (value as f64 / 10_000.0).clamp(0.0, 1.0))
        .unwrap_or(0.0);
    let visual_disagreement = match (sample.visual_match_ms, sample.counterpart_ms) {
        (Some(visual), Some(audio)) => ((visual.abs_diff(audio) as f64) / 10_000.0).clamp(0.0, 1.0),
        _ => 0.0,
    };
    alignment_sensitive_unit_micros(
        sample.difference_risk * 0.5
            + sample.informativeness * 0.2
            + uncertainty * 0.2
            + visual_disagreement * 0.1,
    )
}

fn alignment_sensitive_candidate_timestamps(
    primary: u64,
    visual: Option<u64>,
    uncertainty_ms: Option<u64>,
    target_duration_ms: u64,
    include_decoys: bool,
) -> Vec<u64> {
    let max_timestamp = target_duration_ms.saturating_sub(1);
    let mut values = vec![primary.min(max_timestamp)];
    if let Some(visual) = visual {
        values.push(visual.min(max_timestamp));
    }
    if include_decoys {
        let delta = uncertainty_ms.unwrap_or(2_000).clamp(1_000, 5_000);
        values.push(primary.saturating_sub(delta).min(max_timestamp));
        values.push(primary.saturating_add(delta).min(max_timestamp));
    }
    values.sort_unstable();
    values.dedup();
    values.truncate(4);
    values
}

fn alignment_sensitive_review_candidate(
    source_timestamp_ms: u64,
    source_duration_ms: u64,
    candidate_timestamps_ms: Vec<u64>,
    target_duration_ms: u64,
    category: &'static str,
    risk_score_micros: u64,
) -> Option<AlignmentSensitiveReviewCandidate> {
    if source_duration_ms == 0 || target_duration_ms == 0 || candidate_timestamps_ms.is_empty() {
        return None;
    }
    let source_timestamp_ms = source_timestamp_ms.min(source_duration_ms.saturating_sub(1));
    let mut candidate_timestamps_ms = candidate_timestamps_ms
        .into_iter()
        .map(|value| value.min(target_duration_ms.saturating_sub(1)))
        .collect::<Vec<_>>();
    candidate_timestamps_ms.sort_unstable();
    candidate_timestamps_ms.dedup();
    let minimum = *candidate_timestamps_ms.first()?;
    let maximum = *candidate_timestamps_ms.last()?;
    let target_review_start_ms = minimum.saturating_sub(15_000);
    let target_review_end_ms = maximum
        .saturating_add(15_001)
        .min(target_duration_ms)
        .max(target_review_start_ms.saturating_add(1));
    Some(AlignmentSensitiveReviewCandidate {
        source_timestamp_ms,
        source_preview_start_ms: source_timestamp_ms.saturating_sub(5_000),
        source_preview_end_ms: source_timestamp_ms
            .saturating_add(5_000)
            .min(source_duration_ms),
        target_review_start_ms,
        target_review_end_ms,
        candidate_timestamps_ms,
        category,
        risk_score_micros,
    })
}

fn alignment_sensitive_prepared_media_duration(
    manifest: &AudioAlignmentSensitiveRunManifest,
    media_id: &str,
    preferred_stream_index: Option<u32>,
    fallback_end_ms: u64,
) -> u64 {
    manifest
        .prepared_media
        .iter()
        .find(|media| media.media_id == media_id)
        .and_then(|media| {
            preferred_stream_index
                .and_then(|stream_index| {
                    media
                        .audio_candidates
                        .iter()
                        .find(|candidate| candidate.stream.stream_index == stream_index)
                        .and_then(|candidate| candidate.media_duration_ms)
                })
                .or_else(|| {
                    media
                        .audio_candidates
                        .iter()
                        .filter_map(|candidate| candidate.media_duration_ms)
                        .max()
                })
        })
        .unwrap_or(fallback_end_ms)
        .max(fallback_end_ms)
}

fn alignment_sensitive_pair_review_candidates(
    manifest: &AudioAlignmentSensitiveRunManifest,
    pair: &AudioAlignmentBatchPairSnapshot,
) -> Vec<AlignmentSensitiveReviewCandidate> {
    let Some(proposal) = pair.proposal.as_ref() else {
        return Vec::new();
    };
    let Some(time_map) = proposal.time_map.as_ref() else {
        return Vec::new();
    };
    let source_duration_ms = alignment_sensitive_prepared_media_duration(
        manifest,
        &pair.source_media_id,
        time_map.source_stream.as_ref().map(|stream| stream.index),
        time_map.source_end_ms,
    );
    let target_duration_ms = alignment_sensitive_prepared_media_duration(
        manifest,
        &pair.target_media_id,
        time_map.target_stream.as_ref().map(|stream| stream.index),
        time_map.target_end_ms,
    );
    let mut candidates = Vec::new();
    if let Some(profile) = &proposal.evidence_profile {
        for sample in profile
            .samples
            .iter()
            .filter(|sample| sample.axis == "source")
        {
            let Some(counterpart_ms) = sample.counterpart_ms else {
                continue;
            };
            let category = alignment_sensitive_review_category(sample);
            let timestamps = alignment_sensitive_candidate_timestamps(
                counterpart_ms,
                sample.visual_match_ms,
                sample.offset_uncertainty_ms,
                target_duration_ms,
                category != "matched-control",
            );
            if let Some(candidate) = alignment_sensitive_review_candidate(
                sample
                    .start_ms
                    .saturating_add(sample.end_ms.saturating_sub(sample.start_ms) / 2),
                source_duration_ms,
                timestamps,
                target_duration_ms,
                category,
                alignment_sensitive_review_risk_micros(sample),
            ) {
                candidates.push(candidate);
            }
        }
    }
    for span in &time_map.spans {
        let uncertain = span.kind != AudioTimeMapSpanKind::Matched
            || span.quality.level != "high"
            || span.boundaries.start.status != AudioTimeMapBoundaryStatus::Refined
            || span.boundaries.end.status != AudioTimeMapBoundaryStatus::Refined;
        let source_length = span.source_end_ms.saturating_sub(span.source_start_ms);
        let target_length = span.target_end_ms.saturating_sub(span.target_start_ms);
        let source_timestamp_ms = span.source_start_ms.saturating_add(source_length / 2);
        let projected_target_ms = if source_length > 0 && target_length > 0 {
            let numerator = u128::from(source_timestamp_ms.saturating_sub(span.source_start_ms))
                * u128::from(target_length);
            span.target_start_ms.saturating_add(
                u64::try_from(numerator / u128::from(source_length)).unwrap_or(target_length),
            )
        } else {
            span.target_start_ms.saturating_add(target_length / 2)
        };
        let mut timestamps = vec![projected_target_ms];
        for alternative in &span.alternatives {
            let length = alternative
                .target_end_ms
                .saturating_sub(alternative.target_start_ms);
            timestamps.push(alternative.target_start_ms.saturating_add(length / 2));
        }
        if target_length > 0 {
            timestamps.push(span.target_start_ms);
            timestamps.push(span.target_end_ms.saturating_sub(1));
        }
        timestamps.sort_unstable();
        timestamps.dedup();
        timestamps.truncate(4);
        let category = if uncertain {
            "time-map-uncertain"
        } else {
            "matched-control"
        };
        let risk = if uncertain { 850_000 } else { 100_000 };
        if let Some(candidate) = alignment_sensitive_review_candidate(
            source_timestamp_ms,
            source_duration_ms,
            timestamps,
            target_duration_ms,
            category,
            risk,
        ) {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| {
        right
            .risk_score_micros
            .cmp(&left.risk_score_micros)
            .then_with(|| left.category.cmp(right.category))
            .then_with(|| left.source_timestamp_ms.cmp(&right.source_timestamp_ms))
    });
    let mut selected = Vec::new();
    let mut control_count = 0usize;
    for candidate in candidates {
        let is_control = candidate.category == "matched-control";
        if is_control && control_count >= 4 {
            continue;
        }
        if selected
            .iter()
            .any(|selected: &AlignmentSensitiveReviewCandidate| {
                selected
                    .source_timestamp_ms
                    .abs_diff(candidate.source_timestamp_ms)
                    < ALIGNMENT_SENSITIVE_REVIEW_MIN_SOURCE_SPACING_MS
            })
        {
            continue;
        }
        if is_control {
            control_count += 1;
        }
        selected.push(candidate);
        if selected.len() >= ALIGNMENT_SENSITIVE_REVIEW_MAX_TASKS_PER_PAIR {
            break;
        }
    }
    selected
}

fn alignment_sensitive_review_candidate_pairs(
    manifest: &AudioAlignmentSensitiveRunManifest,
    manifest_canonical_payload_digest: &str,
) -> Vec<AlignmentSensitiveReviewPairSummary> {
    let mut selected_by_pair = manifest
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Completed)
        .filter_map(|pair| {
            let candidates = alignment_sensitive_pair_review_candidates(manifest, pair);
            (!candidates.is_empty()).then_some((pair, candidates))
        })
        .collect::<Vec<_>>();
    selected_by_pair.sort_by_key(|(pair, _)| pair.pair_ordinal);
    let mut retained = vec![Vec::new(); selected_by_pair.len()];
    let mut retained_count = 0usize;
    let mut round = 0usize;
    while retained_count < ALIGNMENT_SENSITIVE_REVIEW_MAX_TASKS_PER_RUN {
        let mut added = false;
        for (index, (_, candidates)) in selected_by_pair.iter().enumerate() {
            if let Some(candidate) = candidates.get(round) {
                retained[index].push(candidate.clone());
                retained_count += 1;
                added = true;
                if retained_count >= ALIGNMENT_SENSITIVE_REVIEW_MAX_TASKS_PER_RUN {
                    break;
                }
            }
        }
        if !added {
            break;
        }
        round += 1;
    }
    selected_by_pair
        .into_iter()
        .zip(retained)
        .filter_map(|((pair, _), candidates)| {
            if candidates.is_empty() {
                return None;
            }
            let mut tasks = candidates
                .into_iter()
                .map(|candidate| {
                    let query_seed = format!(
                        "{ALIGNMENT_SENSITIVE_REVIEW_SELECTOR_VERSION}\n{manifest_canonical_payload_digest}\n{}\n{}\n{:?}\n{}",
                        pair.pair_ordinal,
                        candidate.source_timestamp_ms,
                        candidate.candidate_timestamps_ms,
                        candidate.category,
                    );
                    AlignmentSensitiveReviewTaskSummary {
                        query_key: format!("sha256:{:x}", Sha256::digest(query_seed.as_bytes())),
                        source_timestamp_ms: candidate.source_timestamp_ms,
                        source_preview_start_ms: candidate.source_preview_start_ms,
                        source_preview_end_ms: candidate.source_preview_end_ms,
                        target_review_start_ms: candidate.target_review_start_ms,
                        target_review_end_ms: candidate.target_review_end_ms,
                        candidate_timestamps_ms: candidate.candidate_timestamps_ms,
                        category: candidate.category.to_string(),
                        risk_score_micros: candidate.risk_score_micros,
                    }
                })
                .collect::<Vec<_>>();
            tasks.sort_by(|left, right| left.query_key.cmp(&right.query_key));
            let risky_task_count = tasks
                .iter()
                .filter(|task| task.category != "matched-control")
                .count();
            Some(AlignmentSensitiveReviewPairSummary {
                pair_ordinal: pair.pair_ordinal,
                source_media_id_digest: alignment_sensitive_media_id_digest(&pair.source_media_id),
                target_media_id_digest: alignment_sensitive_media_id_digest(&pair.target_media_id),
                risky_task_count,
                tasks,
            })
        })
        .collect()
}

fn audio_alignment_job_status_key(status: AudioAlignmentJobStatus) -> &'static str {
    match status {
        AudioAlignmentJobStatus::Queued => "queued",
        AudioAlignmentJobStatus::Running => "running",
        AudioAlignmentJobStatus::Completed => "completed",
        AudioAlignmentJobStatus::Failed => "failed",
        AudioAlignmentJobStatus::Cancelled => "cancelled",
    }
}

fn audio_alignment_sensitive_evidence_group_key(
    manifest: &AudioAlignmentSensitiveRunManifest,
) -> Result<Option<String>, String> {
    if manifest.prepared_media.len() != manifest.plan.media.len()
        || manifest
            .prepared_media
            .iter()
            .any(|media| media.content_identity.is_none())
    {
        return Ok(None);
    }
    let mut identities = manifest
        .prepared_media
        .iter()
        .map(|media| {
            (
                media.media_ordinal,
                media.role,
                media.requested_audio_stream_index,
                media.requested_video_stream_index,
                media
                    .content_identity
                    .as_ref()
                    .expect("checked complete prepared media identities"),
            )
        })
        .collect::<Vec<_>>();
    identities.sort_by_key(|(media_ordinal, _, _, _, _)| *media_ordinal);
    let bytes = serde_json::to_vec(&identities)
        .map_err(|error| format!("无法计算本机训练证据运行组摘要：{error}"))?;
    Ok(Some(format!("sha256:{:x}", Sha256::digest(bytes))))
}

fn audio_alignment_sensitive_manifest_summary(
    manifest: &AudioAlignmentSensitiveRunManifest,
    manifest_payload_digest: String,
    manifest_canonical_payload_digest: String,
) -> Result<AlignmentSensitiveManifestSummary, String> {
    let completed_pair_count = manifest
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Completed)
        .count();
    let failed_pair_count = manifest
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Failed)
        .count();
    let cancelled_pair_count = manifest
        .snapshot
        .pairs
        .iter()
        .filter(|pair| pair.status == AudioAlignmentJobStatus::Cancelled)
        .count();
    let evidence_span_count = manifest
        .snapshot
        .pairs
        .iter()
        .filter_map(|pair| pair.proposal.as_ref()?.time_map.as_ref())
        .map(|time_map| time_map.spans.len())
        .sum::<usize>();
    let uncertain_span_count = manifest
        .snapshot
        .pairs
        .iter()
        .filter_map(|pair| pair.proposal.as_ref()?.time_map.as_ref())
        .flat_map(|time_map| time_map.spans.iter())
        .filter(|span| {
            span.kind != AudioTimeMapSpanKind::Matched
                || span.quality.level != "high"
                || matches!(
                    span.boundaries.start.status,
                    AudioTimeMapBoundaryStatus::Ambiguous | AudioTimeMapBoundaryStatus::Unsupported
                )
                || matches!(
                    span.boundaries.end.status,
                    AudioTimeMapBoundaryStatus::Ambiguous | AudioTimeMapBoundaryStatus::Unsupported
                )
        })
        .count();
    let visual_evidence_pair_count = manifest
        .snapshot
        .pairs
        .iter()
        .filter_map(|pair| pair.proposal.as_ref()?.time_map.as_ref())
        .filter(|time_map| time_map.evidence.visual_anchor_count > 0)
        .count();
    let source_media_count = manifest
        .plan
        .media
        .iter()
        .filter(|media| media.role == "sourceReference")
        .count();
    let target_media_count = manifest
        .plan
        .media
        .iter()
        .filter(|media| media.role == "targetOriginal")
        .count();
    let prepared_media_count = manifest.prepared_media.len();
    let identified_media_count = manifest
        .prepared_media
        .iter()
        .filter(|media| media.content_identity.is_some())
        .count();
    let audio_candidate_count = manifest
        .prepared_media
        .iter()
        .map(|media| media.audio_candidates.len())
        .sum::<usize>();
    let landmark_artifact_count = manifest
        .prepared_media
        .iter()
        .map(|media| media.landmark_artifacts.len())
        .sum::<usize>();
    let landmark_cache_hit_count = manifest
        .prepared_media
        .iter()
        .flat_map(|media| media.landmark_artifacts.iter())
        .filter(|artifact| artifact.cache_hit)
        .count();
    let evidence_group_key = audio_alignment_sensitive_evidence_group_key(manifest)?;
    let terminal = manifest.lifecycle_stage == "terminal";
    let identities_complete = identified_media_count == manifest.plan.media.len();
    let ready_for_training_intake =
        terminal && completed_pair_count > 0 && identities_complete && evidence_group_key.is_some();
    let intake_state = if !terminal {
        "collecting"
    } else if !ready_for_training_intake {
        "unusable"
    } else if failed_pair_count > 0 || cancelled_pair_count > 0 {
        "partial"
    } else {
        "ready"
    };
    let mut notes = Vec::new();
    if !terminal {
        notes.push("运行仍在采集，本机索引会继续更新。".to_string());
    }
    if terminal && !identities_complete {
        notes.push("有媒体未完成内容身份固定，不能可靠绑定训练样本。".to_string());
    }
    if terminal && completed_pair_count == 0 {
        notes.push("没有成功完成的素材关系，当前运行不能进入训练整理。".to_string());
    }
    if failed_pair_count > 0 || cancelled_pair_count > 0 {
        notes.push(format!(
            "存在 {failed_pair_count} 个失败关系和 {cancelled_pair_count} 个取消关系；成功部分可单独整理。"
        ));
    }
    if ready_for_training_intake {
        notes.push(format!(
            "已保留 {completed_pair_count} 个完成关系和 {uncertain_span_count} 个疑点段，可进入真实证据整理。"
        ));
    }
    Ok(AlignmentSensitiveManifestSummary {
        run_id: manifest.run_id.clone(),
        manifest_payload_digest,
        manifest_canonical_payload_digest: Some(manifest_canonical_payload_digest.clone()),
        lifecycle_stage: manifest.lifecycle_stage.to_string(),
        created_at_ms: manifest.created_at_ms,
        updated_at_ms: manifest.updated_at_ms,
        app_version: manifest.app_version.to_string(),
        engine_version: manifest.engine_version.to_string(),
        feature_version: manifest.feature_version.to_string(),
        status: audio_alignment_job_status_key(manifest.snapshot.status).to_string(),
        source_media_count,
        target_media_count,
        pair_count: manifest.snapshot.total_pair_count,
        processed_pair_count: manifest.snapshot.processed_pair_count,
        completed_pair_count,
        failed_pair_count,
        cancelled_pair_count,
        prepared_media_count,
        identified_media_count,
        audio_candidate_count,
        landmark_artifact_count,
        landmark_cache_hit_count,
        evidence_span_count,
        uncertain_span_count,
        visual_evidence_pair_count,
        visual_evidence_requested: manifest
            .plan
            .parameters
            .enable_visual_evidence
            .unwrap_or(false),
        evidence_group_key,
        intake_state: intake_state.to_string(),
        ready_for_training_intake,
        review_candidate_pairs: if ready_for_training_intake {
            alignment_sensitive_review_candidate_pairs(manifest, &manifest_canonical_payload_digest)
        } else {
            Vec::new()
        },
        notes,
    })
}

pub(crate) fn alignment_sensitive_manifest_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(ALIGNMENT_SENSITIVE_MANIFEST_DIRECTORY))
        .map_err(|_| "无法定位本机敏感对齐执行清单目录。".to_string())
}

#[cfg(test)]
pub(crate) fn write_alignment_sensitive_manifest<T: Serialize>(
    root: &Path,
    run_id: &str,
    payload: &T,
) -> Result<String, String> {
    write_alignment_sensitive_manifest_with_digests(root, run_id, payload)
        .map(|digests| digests.payload_digest)
}

pub(crate) fn write_alignment_sensitive_manifest_with_digests<T: Serialize>(
    root: &Path,
    run_id: &str,
    payload: &T,
) -> Result<AlignmentSensitiveManifestDigests, String> {
    validate_run_id(run_id)?;
    let initial_payload_value = serde_json::to_value(payload)
        .map_err(|error| format!("无法序列化本机敏感对齐执行清单：{error}"))?;
    let initial_payload_bytes = serde_json::to_vec(&initial_payload_value)
        .map_err(|error| format!("无法编码本机敏感对齐执行清单内容：{error}"))?;
    let payload_value: serde_json::Value = serde_json::from_slice(&initial_payload_bytes)
        .map_err(|error| format!("无法规范化本机敏感对齐执行清单内容：{error}"))?;
    let payload_bytes = serde_json::to_vec(&payload_value)
        .map_err(|error| format!("无法编码规范化后的本机敏感对齐执行清单内容：{error}"))?;
    let payload_digest = format!("sha256:{:x}", Sha256::digest(&payload_bytes));
    let canonical_payload_digest = canonical_json_digest(&payload_value)?;
    let envelope = AlignmentSensitiveManifestEnvelope {
        schema_version: ALIGNMENT_SENSITIVE_MANIFEST_ENVELOPE_VERSION,
        artifact_type: "alignment-sensitive-run-manifest-envelope-v1",
        privacy_class: "local-sensitive-full-media-v1",
        payload_digest: payload_digest.clone(),
        payload: &payload_value,
    };
    let bytes = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| format!("无法编码本机敏感对齐执行清单：{error}"))?;
    let byte_count =
        u64::try_from(bytes.len()).map_err(|_| "本机敏感对齐执行清单大小无法表示。".to_string())?;
    if byte_count > MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILE_BYTES {
        return Err(format!(
            "本机敏感对齐执行清单超过单次 {} MiB 上限。",
            MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILE_BYTES / 1024 / 1024
        ));
    }
    fs::create_dir_all(root)
        .map_err(|error| format!("无法创建本机敏感对齐执行清单目录：{error}"))?;
    let destination = root.join(format!("{run_id}.json"));
    rotate_alignment_sensitive_manifests_before_write(root, &destination, byte_count)?;
    write_atomic_replace(&destination, &bytes)?;
    Ok(AlignmentSensitiveManifestDigests {
        payload_digest,
        canonical_payload_digest,
    })
}

#[cfg(test)]
pub(crate) fn alignment_sensitive_manifest_canonical_payload_digest<T: Serialize>(
    payload: &T,
) -> Result<String, String> {
    let value = serde_json::to_value(payload)
        .map_err(|error| format!("无法规范化本机敏感对齐执行清单：{error}"))?;
    canonical_json_digest(&value)
}

pub(crate) fn write_alignment_sensitive_manifest_summary(
    root: &Path,
    summary: &AlignmentSensitiveManifestSummary,
) -> Result<String, String> {
    validate_alignment_sensitive_manifest_summary(summary)?;
    fs::create_dir_all(root)
        .map_err(|error| format!("无法创建本机敏感对齐执行清单目录：{error}"))?;
    let summary_bytes = serde_json::to_vec(summary)
        .map_err(|error| format!("无法序列化本机训练证据索引：{error}"))?;
    let summary_digest = format!("sha256:{:x}", Sha256::digest(&summary_bytes));
    let envelope = AlignmentSensitiveManifestSummaryEnvelope {
        schema_version: ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_SCHEMA_VERSION,
        artifact_type: "alignment-sensitive-run-summary-envelope-v1",
        privacy_class: "local-sensitive-derived-index-v1",
        summary_digest: summary_digest.clone(),
        summary,
    };
    let bytes = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| format!("无法编码本机训练证据索引：{error}"))?;
    let byte_count =
        u64::try_from(bytes.len()).map_err(|_| "本机训练证据索引大小无法表示。".to_string())?;
    if byte_count > MAX_ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_BYTES {
        return Err("本机训练证据索引超过单次 64 KiB 上限。".to_string());
    }
    let destination = root.join(format!(
        "{}.{}",
        summary.run_id, ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION
    ));
    write_atomic_replace(&destination, &bytes)?;
    Ok(summary_digest)
}

pub(crate) fn read_alignment_sensitive_manifest_summaries(
    root: &Path,
) -> Result<Vec<AlignmentSensitiveManifestSummary>, String> {
    recover_abandoned_sensitive_manifests(root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| format!("无法读取本机训练证据目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取本机训练证据目录项：{error}"))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| format!("无法读取本机训练证据文件类型：{error}"))?
            .is_file()
            || path.extension().and_then(|value| value.to_str())
                != Some(ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION)
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("无法读取本机训练证据索引元数据：{error}"))?;
        if metadata.len() > MAX_ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_BYTES {
            return Err("本机训练证据索引超过读取上限。".to_string());
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("无法读取本机训练证据索引：{error}"))?;
        let envelope: OwnedAlignmentSensitiveManifestSummaryEnvelope =
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("本机训练证据索引格式无效：{error}"))?;
        validate_alignment_sensitive_manifest_summary_envelope(&envelope, &path)?;
        summaries.push(envelope.summary);
    }
    summaries.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| right.run_id.cmp(&left.run_id))
    });
    Ok(summaries)
}

pub(crate) fn read_verified_alignment_sensitive_manifest_payload(
    root: &Path,
    run_id: &str,
) -> Result<(AlignmentSensitiveManifestSummary, serde_json::Value), String> {
    validate_run_id(run_id)?;
    recover_abandoned_sensitive_manifests(root)?;
    let summary_path = root.join(format!(
        "{run_id}.{ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION}"
    ));
    let summary_bytes =
        fs::read(&summary_path).map_err(|_| "找不到这次运行的本机训练证据索引。".to_string())?;
    if u64::try_from(summary_bytes.len()).unwrap_or(u64::MAX)
        > MAX_ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_BYTES
    {
        return Err("本机训练证据索引超过读取上限。".to_string());
    }
    let summary_envelope: OwnedAlignmentSensitiveManifestSummaryEnvelope =
        serde_json::from_slice(&summary_bytes)
            .map_err(|error| format!("本机训练证据索引格式无效：{error}"))?;
    validate_alignment_sensitive_manifest_summary_envelope(&summary_envelope, &summary_path)?;
    if summary_envelope
        .summary
        .manifest_canonical_payload_digest
        .is_none()
    {
        return Err("这份旧运行缺少完整内容防篡改绑定；请用当前版本重新完成一次匹配。".to_string());
    }
    let manifest_path = root.join(format!("{run_id}.json"));
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|_| "本机训练证据索引对应的完整运行清单不存在。".to_string())?;
    let manifest: OwnedAlignmentSensitiveManifestEnvelope = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("本机敏感对齐执行清单信封无效：{error}"))?;
    validate_alignment_sensitive_manifest_envelope(&manifest, &summary_envelope.summary)?;
    Ok((summary_envelope.summary, manifest.payload))
}

fn validate_alignment_sensitive_manifest_summary_envelope(
    envelope: &OwnedAlignmentSensitiveManifestSummaryEnvelope,
    path: &Path,
) -> Result<(), String> {
    if envelope.schema_version != ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_SCHEMA_VERSION
        || envelope.artifact_type != "alignment-sensitive-run-summary-envelope-v1"
        || envelope.privacy_class != "local-sensitive-derived-index-v1"
    {
        return Err("本机训练证据索引版本或隐私分类无效。".to_string());
    }
    validate_alignment_sensitive_manifest_summary(&envelope.summary)?;
    let expected_file_name = format!(
        "{}.{}",
        envelope.summary.run_id, ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION
    );
    if path.file_name().and_then(|value| value.to_str()) != Some(expected_file_name.as_str()) {
        return Err("本机训练证据索引文件名与运行编号不一致。".to_string());
    }
    let summary_bytes = serde_json::to_vec(&envelope.summary)
        .map_err(|error| format!("无法复核本机训练证据索引：{error}"))?;
    let actual_summary_digest = format!("sha256:{:x}", Sha256::digest(&summary_bytes));
    if envelope.summary_digest != actual_summary_digest {
        return Err("本机训练证据索引摘要校验失败。".to_string());
    }
    let manifest_path = path.with_extension("json");
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|_| "本机训练证据索引对应的完整运行清单不存在。".to_string())?;
    if u64::try_from(manifest_bytes.len()).unwrap_or(u64::MAX)
        > MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILE_BYTES
    {
        return Err("本机敏感对齐执行清单超过读取上限。".to_string());
    }
    let manifest_header: AlignmentSensitiveManifestEnvelopeHeader =
        serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("本机敏感对齐执行清单信封无效：{error}"))?;
    if manifest_header.schema_version != ALIGNMENT_SENSITIVE_MANIFEST_ENVELOPE_VERSION
        || manifest_header.artifact_type != "alignment-sensitive-run-manifest-envelope-v1"
        || manifest_header.privacy_class != "local-sensitive-full-media-v1"
        || manifest_header.payload_digest != envelope.summary.manifest_payload_digest
    {
        return Err("本机训练证据索引与完整运行清单不匹配。".to_string());
    }
    if envelope.summary.manifest_canonical_payload_digest.is_some() {
        let manifest: OwnedAlignmentSensitiveManifestEnvelope =
            serde_json::from_slice(&manifest_bytes)
                .map_err(|error| format!("本机敏感对齐执行清单信封无效：{error}"))?;
        validate_alignment_sensitive_manifest_envelope(&manifest, &envelope.summary)?;
    }
    Ok(())
}

fn validate_alignment_sensitive_manifest_envelope(
    manifest: &OwnedAlignmentSensitiveManifestEnvelope,
    summary: &AlignmentSensitiveManifestSummary,
) -> Result<(), String> {
    if manifest.schema_version != ALIGNMENT_SENSITIVE_MANIFEST_ENVELOPE_VERSION
        || manifest.artifact_type != "alignment-sensitive-run-manifest-envelope-v1"
        || manifest.privacy_class != "local-sensitive-full-media-v1"
        || manifest.payload_digest != summary.manifest_payload_digest
    {
        return Err("本机训练证据索引与完整运行清单不匹配。".to_string());
    }
    let expected = summary
        .manifest_canonical_payload_digest
        .as_deref()
        .ok_or_else(|| "本机训练证据缺少完整内容防篡改摘要。".to_string())?;
    let actual = canonical_json_digest(&manifest.payload)?;
    if actual != expected {
        return Err(format!(
            "本机敏感对齐执行清单完整内容摘要校验失败：索引期望 {expected}，磁盘内容为 {actual}。"
        ));
    }
    Ok(())
}

fn validate_alignment_sensitive_manifest_summary(
    summary: &AlignmentSensitiveManifestSummary,
) -> Result<(), String> {
    validate_run_id(&summary.run_id)?;
    validate_sha256_digest(&summary.manifest_payload_digest, "运行清单摘要")?;
    if let Some(digest) = &summary.manifest_canonical_payload_digest {
        validate_sha256_digest(digest, "运行清单完整内容摘要")?;
    }
    if let Some(group_key) = &summary.evidence_group_key {
        validate_sha256_digest(group_key, "证据运行组摘要")?;
    }
    if summary.lifecycle_stage != "queued"
        && summary.lifecycle_stage != "prepared"
        && summary.lifecycle_stage != "terminal"
    {
        return Err("本机训练证据生命周期无效。".to_string());
    }
    if !matches!(
        summary.status.as_str(),
        "queued" | "running" | "completed" | "failed" | "cancelled"
    ) {
        return Err("本机训练证据运行状态无效。".to_string());
    }
    if !matches!(
        summary.intake_state.as_str(),
        "collecting" | "ready" | "partial" | "unusable"
    ) {
        return Err("本机训练证据整理状态无效。".to_string());
    }
    if summary.source_media_count == 0
        || summary.target_media_count == 0
        || summary.pair_count == 0
        || summary.processed_pair_count > summary.pair_count
        || summary
            .completed_pair_count
            .saturating_add(summary.failed_pair_count)
            .saturating_add(summary.cancelled_pair_count)
            > summary.pair_count
        || summary.identified_media_count > summary.prepared_media_count
        || summary.landmark_cache_hit_count > summary.landmark_artifact_count
        || summary.uncertain_span_count > summary.evidence_span_count
        || summary.visual_evidence_pair_count > summary.pair_count
    {
        return Err("本机训练证据索引计数关系无效。".to_string());
    }
    if summary.ready_for_training_intake
        != matches!(summary.intake_state.as_str(), "ready" | "partial")
    {
        return Err("本机训练证据可整理标记与状态不一致。".to_string());
    }
    if summary.ready_for_training_intake
        && (summary.lifecycle_stage != "terminal"
            || summary.completed_pair_count == 0
            || summary.identified_media_count
                != summary
                    .source_media_count
                    .saturating_add(summary.target_media_count)
            || summary.evidence_group_key.is_none())
    {
        return Err("本机训练证据尚未满足可整理条件。".to_string());
    }
    if summary.review_candidate_pairs.len() > summary.completed_pair_count
        || summary
            .review_candidate_pairs
            .iter()
            .map(|pair| pair.tasks.len())
            .sum::<usize>()
            > 64
    {
        return Err("本机训练证据复核候选数量无效。".to_string());
    }
    let mut pair_ordinals = HashSet::new();
    let mut query_keys = HashSet::new();
    for pair in &summary.review_candidate_pairs {
        if pair.pair_ordinal == 0
            || pair.pair_ordinal > summary.pair_count
            || !pair_ordinals.insert(pair.pair_ordinal)
            || pair.tasks.is_empty()
            || pair.tasks.len() > 20
            || pair.risky_task_count > pair.tasks.len()
        {
            return Err("本机训练证据复核关系摘要无效。".to_string());
        }
        validate_sha256_digest(&pair.source_media_id_digest, "复核参考媒体摘要")?;
        validate_sha256_digest(&pair.target_media_id_digest, "复核原片媒体摘要")?;
        for task in &pair.tasks {
            validate_sha256_digest(&task.query_key, "复核查询摘要")?;
            if !query_keys.insert(task.query_key.as_str())
                || task.source_preview_start_ms > task.source_timestamp_ms
                || task.source_timestamp_ms > task.source_preview_end_ms
                || task.target_review_start_ms >= task.target_review_end_ms
                || !(1..=4).contains(&task.candidate_timestamps_ms.len())
                || task.risk_score_micros > 1_000_000
                || task.category.is_empty()
                || task.category.len() > 64
            {
                return Err("本机训练证据复核任务摘要无效。".to_string());
            }
            let mut timestamps = task.candidate_timestamps_ms.clone();
            timestamps.sort_unstable();
            timestamps.dedup();
            if timestamps.len() != task.candidate_timestamps_ms.len()
                || timestamps.iter().any(|timestamp| {
                    *timestamp < task.target_review_start_ms
                        || *timestamp > task.target_review_end_ms
                })
            {
                return Err("本机训练证据复核候选位置无效。".to_string());
            }
        }
    }
    Ok(())
}

fn canonical_json_digest(value: &serde_json::Value) -> Result<String, String> {
    fn write(value: &serde_json::Value, output: &mut String) -> Result<(), String> {
        match value {
            serde_json::Value::Null => output.push_str("null"),
            serde_json::Value::Bool(value) => {
                output.push_str(if *value { "true" } else { "false" })
            }
            serde_json::Value::Number(value) => output.push_str(&value.to_string()),
            serde_json::Value::String(value) => output.push_str(
                &serde_json::to_string(value)
                    .map_err(|error| format!("无法规范化 JSON 字符串：{error}"))?,
            ),
            serde_json::Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(value, output)?;
                }
                output.push(']');
            }
            serde_json::Value::Object(values) => {
                output.push('{');
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(
                        &serde_json::to_string(key)
                            .map_err(|error| format!("无法规范化 JSON 字段名：{error}"))?,
                    );
                    output.push(':');
                    write(&values[key], output)?;
                }
                output.push('}');
            }
        }
        Ok(())
    }
    let mut canonical = String::new();
    write(value, &mut canonical)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

fn validate_sha256_digest(value: &str, label: &str) -> Result<(), String> {
    if value.len() != "sha256:".len() + 64
        || !value.starts_with("sha256:")
        || !value["sha256:".len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{label}无效。"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ActiveManifestKey {
    root: PathBuf,
    run_id: String,
}

static ACTIVE_MANIFESTS: OnceLock<Mutex<HashSet<ActiveManifestKey>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct SensitiveManifestWriteReport {
    pub(super) manifest_became_unavailable: bool,
    pub(super) summary_unavailable: bool,
}

pub(super) struct CreatedSensitiveManifestJournal {
    pub(super) journal: SensitiveManifestJournal,
    pub(super) report: SensitiveManifestWriteReport,
}

pub(super) struct SensitiveManifestJournal {
    root: PathBuf,
    manifest: AudioAlignmentSensitiveRunManifest,
    pending_retry: bool,
    active_key: ActiveManifestKey,
}

impl SensitiveManifestJournal {
    pub(super) fn create(
        root: PathBuf,
        run_id: &str,
        created_at_ms: u64,
        plan: &PlannedAudioAlignmentBatch,
        snapshot: &AudioAlignmentBatchJobSnapshot,
    ) -> Result<CreatedSensitiveManifestJournal, String> {
        let manifest = AudioAlignmentSensitiveRunManifest {
            schema_version: AUDIO_ALIGNMENT_SENSITIVE_MANIFEST_SCHEMA_VERSION,
            artifact_type: "alignment-sensitive-run-manifest-v1",
            privacy_class: "local-sensitive-full-media-v1",
            run_id: run_id.to_string(),
            lifecycle_stage: "queued",
            created_at_ms,
            updated_at_ms: snapshot.updated_at_ms,
            app_version: env!("CARGO_PKG_VERSION"),
            engine_version: ALIGNMENT_V2_ENGINE_VERSION,
            feature_version: ALIGNMENT_V2_FEATURE_VERSION,
            plan: create_audio_alignment_sensitive_plan(plan)?,
            prepared_media: Vec::new(),
            snapshot: snapshot.clone(),
        };
        let active_key = register_active_manifest(&root, &manifest.run_id)?;
        let mut journal = Self {
            root,
            manifest,
            pending_retry: false,
            active_key,
        };
        let report = journal.persist_current();
        if report.manifest_became_unavailable {
            return Err("本机敏感执行清单初始写入失败。".to_string());
        }
        Ok(CreatedSensitiveManifestJournal { journal, report })
    }

    pub(super) fn record_prepared(
        &mut self,
        prepared_media: Vec<AudioAlignmentSensitivePreparedMedia>,
        snapshot: &AudioAlignmentBatchJobSnapshot,
    ) -> SensitiveManifestWriteReport {
        if self.manifest.lifecycle_stage == "terminal" {
            return SensitiveManifestWriteReport::default();
        }
        self.manifest.prepared_media = prepared_media;
        self.manifest.lifecycle_stage = "prepared";
        self.refresh_snapshot(snapshot);
        self.persist_current()
    }

    pub(super) fn finish_terminal(
        &mut self,
        snapshot: &AudioAlignmentBatchJobSnapshot,
    ) -> SensitiveManifestWriteReport {
        self.manifest.lifecycle_stage = "terminal";
        self.refresh_snapshot(snapshot);
        self.persist_current()
    }

    pub(super) fn retry_pending(&mut self) -> Option<SensitiveManifestWriteReport> {
        self.pending_retry.then(|| self.persist_current())
    }

    fn refresh_snapshot(&mut self, snapshot: &AudioAlignmentBatchJobSnapshot) {
        self.manifest.updated_at_ms = snapshot.updated_at_ms;
        self.manifest.snapshot = snapshot.clone();
    }

    fn persist_current(&mut self) -> SensitiveManifestWriteReport {
        let was_pending_retry = self.pending_retry;
        self.pending_retry = true;
        let digests = match write_alignment_sensitive_manifest_with_digests(
            &self.root,
            &self.manifest.run_id,
            &self.manifest,
        ) {
            Ok(digests) => digests,
            Err(_) => {
                if self.manifest.lifecycle_stage == "terminal" {
                    let _ = discard_alignment_sensitive_manifest_files(
                        &self.root,
                        &self.manifest.run_id,
                    );
                }
                return SensitiveManifestWriteReport {
                    manifest_became_unavailable: !was_pending_retry,
                    summary_unavailable: false,
                };
            }
        };
        let summary = match audio_alignment_sensitive_manifest_summary(
            &self.manifest,
            digests.payload_digest,
            digests.canonical_payload_digest,
        ) {
            Ok(summary) => summary,
            Err(_) => {
                if self.manifest.lifecycle_stage == "terminal" {
                    let _ = discard_alignment_sensitive_manifest_summary(
                        &self.root,
                        &self.manifest.run_id,
                    );
                }
                return SensitiveManifestWriteReport {
                    manifest_became_unavailable: !was_pending_retry,
                    summary_unavailable: false,
                };
            }
        };
        if write_alignment_sensitive_manifest_summary(&self.root, &summary).is_err() {
            let _ = discard_alignment_sensitive_manifest_summary(&self.root, &self.manifest.run_id);
            return SensitiveManifestWriteReport {
                manifest_became_unavailable: false,
                summary_unavailable: !was_pending_retry,
            };
        }
        self.pending_retry = false;
        SensitiveManifestWriteReport::default()
    }
}

impl Drop for SensitiveManifestJournal {
    fn drop(&mut self) {
        if let Ok(mut active) = active_manifests().lock() {
            active.remove(&self.active_key);
        }
    }
}

fn active_manifests() -> &'static Mutex<HashSet<ActiveManifestKey>> {
    ACTIVE_MANIFESTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn register_active_manifest(root: &Path, run_id: &str) -> Result<ActiveManifestKey, String> {
    let key = ActiveManifestKey {
        root: root.to_path_buf(),
        run_id: run_id.to_string(),
    };
    let mut active = active_manifests()
        .lock()
        .map_err(|_| "本机敏感执行清单恢复状态锁已损坏。".to_string())?;
    active.insert(key.clone());
    if let Err(error) = recover_abandoned_locked(root, &active) {
        active.remove(&key);
        return Err(error);
    }
    Ok(key)
}

pub(crate) fn recover_abandoned_sensitive_manifests(root: &Path) -> Result<(), String> {
    let active = active_manifests()
        .lock()
        .map_err(|_| "本机敏感执行清单恢复状态锁已损坏。".to_string())?;
    recover_abandoned_locked(root, &active)
}

fn recover_abandoned_locked(
    root: &Path,
    active: &HashSet<ActiveManifestKey>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let entries =
        fs::read_dir(root).map_err(|_| "无法恢复本机敏感对齐执行清单目录。".to_string())?;
    for entry in entries {
        let entry = entry.map_err(|_| "无法恢复本机敏感对齐执行清单目录项。".to_string())?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|_| "无法恢复本机敏感对齐执行清单文件类型。".to_string())?;
        if !file_type.is_file() {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) == Some("tmp")
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with('.'))
        {
            fs::remove_file(&path).map_err(|_| "无法清理本机敏感执行清单临时文件。".to_string())?;
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(run_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if active.contains(&ActiveManifestKey {
            root: root.to_path_buf(),
            run_id: run_id.to_string(),
        }) {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let envelope: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(envelope) => envelope,
            Err(_) => continue,
        };
        let lifecycle_stage = envelope
            .get("payload")
            .and_then(|payload| payload.get("lifecycleStage"))
            .and_then(serde_json::Value::as_str);
        if lifecycle_stage.is_some_and(|stage| stage != "terminal") {
            discard_alignment_sensitive_manifest_files(root, run_id)?;
            continue;
        }
        if lifecycle_stage == Some("terminal") {
            let manifest_digest = envelope
                .get("payloadDigest")
                .and_then(serde_json::Value::as_str);
            let summary_path = root.join(format!(
                "{run_id}.{ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION}"
            ));
            if let Ok(summary_bytes) = fs::read(&summary_path) {
                if let Ok(summary) = serde_json::from_slice::<serde_json::Value>(&summary_bytes) {
                    let summary_stage = summary
                        .get("summary")
                        .and_then(|value| value.get("lifecycleStage"))
                        .and_then(serde_json::Value::as_str);
                    let summary_manifest_digest = summary
                        .get("summary")
                        .and_then(|value| value.get("manifestPayloadDigest"))
                        .and_then(serde_json::Value::as_str);
                    if summary_stage != Some("terminal")
                        || manifest_digest.is_some() && summary_manifest_digest != manifest_digest
                    {
                        discard_alignment_sensitive_manifest_summary(root, run_id)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn discard_alignment_sensitive_manifest_files(root: &Path, run_id: &str) -> Result<(), String> {
    validate_run_id(run_id)?;
    for path in [
        root.join(format!("{run_id}.json")),
        root.join(format!(
            "{run_id}.{ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION}"
        )),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => fs::remove_file(&path)
                .map_err(|_| "无法清理未完成的本机敏感对齐执行清单。".to_string())?,
            Ok(_) | Err(_) => {}
        }
    }
    Ok(())
}

fn discard_alignment_sensitive_manifest_summary(root: &Path, run_id: &str) -> Result<(), String> {
    validate_run_id(run_id)?;
    let path = root.join(format!(
        "{run_id}.{ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION}"
    ));
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(&path).map_err(|_| "无法清理未完成的本机训练证据索引。".to_string())
        }
        Ok(_) | Err(_) => Ok(()),
    }
}

fn rotate_alignment_sensitive_manifests_before_write(
    root: &Path,
    destination: &Path,
    new_bytes: u64,
) -> Result<(), String> {
    let mut files = fs::read_dir(root)
        .map_err(|error| format!("无法读取本机敏感对齐执行清单目录：{error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !entry.file_type().ok()?.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            (path != destination).then_some((
                path,
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.1
            .cmp(&right.1)
            .then_with(|| left.0.file_name().cmp(&right.0.file_name()))
    });
    let mut total_bytes = files
        .iter()
        .fold(0_u64, |total, (_, _, bytes)| total.saturating_add(*bytes));
    while files.len().saturating_add(1) > MAX_ALIGNMENT_SENSITIVE_MANIFEST_FILES
        || total_bytes.saturating_add(new_bytes) > MAX_ALIGNMENT_SENSITIVE_MANIFEST_TOTAL_BYTES
    {
        if files.is_empty() {
            return Err("当前本机敏感执行清单无法在容量上限内保存。".to_string());
        }
        let (path, _, bytes) = files.remove(0);
        fs::remove_file(&path)
            .map_err(|error| format!("无法轮转旧的本机敏感对齐执行清单：{error}"))?;
        let summary_path = path.with_extension(ALIGNMENT_SENSITIVE_MANIFEST_SUMMARY_EXTENSION);
        if summary_path.exists() {
            fs::remove_file(&summary_path)
                .map_err(|error| format!("无法轮转旧的本机训练证据索引：{error}"))?;
        }
        total_bytes = total_bytes.saturating_sub(bytes);
    }
    Ok(())
}

fn write_atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "本机敏感对齐执行清单路径缺少父目录。".to_string())?;
    let sequence = ALIGNMENT_SENSITIVE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("manifest"),
        std::process::id(),
        sequence
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("无法创建本机敏感执行清单临时文件：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法同步本机敏感执行清单临时文件：{error}"))?;
        atomic_replace_file(&temp_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // SAFETY: Both buffers are NUL-terminated UTF-16 paths and remain alive for the call.
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "无法原子替换本机敏感执行清单：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("无法原子替换本机敏感执行清单：{error}"))
}
