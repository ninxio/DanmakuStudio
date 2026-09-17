//! Pure assembly of stable Alignment V2 pair proposal DTOs.

use super::{
    v2_pair_engine::{create_v2_span, V2ChunkAlignment, V2TrackPairCandidate},
    v2_pair_fine_execution::V2BoundarySummary,
    v2_pair_outcome::{
        evaluate_v2_blocked_affine_outcome, evaluate_v2_pair_outcome,
        V2BlockedAffineOutcomeAssessment, V2BlockedAffineOutcomeInput, V2PairOutcomeAssessment,
        V2PairOutcomeInput,
    },
    AlignmentAudioInput, AlignmentEvidenceSignalSummary, AlignmentEvidenceSummary,
    AlignmentMatchRange, AudioAlignmentProposal, AudioAlignmentTimeMapDto,
    AudioAlternativeTrackScoreDto, AudioTimeMapEvidenceDto, AudioTimeMapSpanDto,
    AudioTimeMapSpanKind, AudioTimeMapStreamIdentityDto, CutCandidateDto, SyncAnchorDto,
    ALIGNMENT_V2_DP_BAND_RADIUS_MS, ALIGNMENT_V2_DP_CHUNK_MS, ALIGNMENT_V2_ENGINE_VERSION,
    ALIGNMENT_V2_FEATURE_VERSION, ALIGNMENT_V2_FINE_HOP_MS, ALIGNMENT_V2_LANDMARK_HOP_MS,
    ALIGNMENT_V2_SAMPLE_RATE,
};
use crate::media_probe::AudioStreamProbe;

pub(super) struct V2AlignedProposalInput {
    pub(super) alignment: V2ChunkAlignment,
    pub(super) boundary: V2BoundarySummary,
    pub(super) pair: V2TrackPairCandidate,
    pub(super) top1_top2_margin: f64,
    pub(super) minimum_alternative_margin: f64,
    pub(super) selected_track_reason: String,
    pub(super) alternatives: Vec<AudioAlternativeTrackScoreDto>,
    pub(super) diagnostics: Vec<String>,
}

pub(super) fn build_v2_aligned_proposal(input: V2AlignedProposalInput) -> AudioAlignmentProposal {
    let V2AlignedProposalInput {
        mut alignment,
        boundary,
        pair,
        top1_top2_margin,
        minimum_alternative_margin,
        selected_track_reason,
        alternatives,
        mut diagnostics,
    } = input;
    clamp_quantized_media_tails(&mut alignment, &pair, &mut diagnostics);
    let outcome = evaluate_v2_pair_outcome(V2PairOutcomeInput {
        alignment,
        boundary,
        hypothesis: &pair.hypothesis,
        use_island_local_residuals: pair.offset_island_count > 1,
        top1_top2_margin,
        minimum_alternative_margin,
    });
    let V2PairOutcomeAssessment {
        alignment,
        boundary,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        coverage,
        blocked,
        catastrophic,
        ambiguous_span_count,
        compatibility_p95,
        time_map_quality,
        evidence_profile,
        diagnostics: outcome_diagnostics,
    } = outcome;
    diagnostics.extend(outcome_diagnostics);
    let anchors = create_v2_compatibility_anchors(&alignment.spans, compatibility_p95, blocked);
    let cut_candidates = create_v2_compatibility_cut_candidates(&alignment.spans, blocked);
    let parameters_hash = create_v2_parameters_hash(&pair);
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        spans: alignment.spans.clone(),
        quality: time_map_quality,
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["audio"],
            audio_anchor_count: pair
                .hypothesis
                .inlier_count
                .saturating_add(pair.hypothesis.held_out_anchors.len()),
            visual_anchor_count: 0,
            held_out_anchor_count: pair.hypothesis.held_out_anchors.len(),
            top1_top2_margin: Some(top1_top2_margin),
            unique_content_coverage: Some(pair.hypothesis.unique_source_coverage.clamp(0.0, 1.0)),
            repeated_content_only: pair.repeated_content_only,
            selected_track_reason,
            alternative_track_scores: alternatives,
            notes: diagnostics.clone(),
        },
        source_stream: Some(v2_stream_identity(&pair.source_input.stream)),
        target_stream: Some(v2_stream_identity(&pair.target_input.stream)),
        source_visual_stream: None,
        target_visual_stream: None,
        source_identity: pair.source_input.content_identity.clone(),
        target_identity: pair.target_input.content_identity.clone(),
        engine_version: ALIGNMENT_V2_ENGINE_VERSION,
        feature_version: ALIGNMENT_V2_FEATURE_VERSION,
        parameters_hash,
    };
    let strong_anchor_count = anchors
        .iter()
        .filter(|anchor| anchor.confidence >= 0.7)
        .count();
    AudioAlignmentProposal {
        anchors,
        cut_candidates,
        evidence_profile,
        confidence: if blocked { 0.0 } else { coverage },
        diagnostics,
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: "alignment-v2-edit-map".to_string(),
            complete_fingerprint_count: pair.target_landmark_count,
            source_fingerprint_count: pair.source_landmark_count,
            fingerprint_match_count: pair.observation_count,
            monotonic_match_count: pair.hypothesis.inlier_count,
            strong_anchor_count,
            weak_anchor_count: pair
                .hypothesis
                .inlier_count
                .saturating_sub(strong_anchor_count),
            offset_cluster_count: 1,
            refined_candidate_count: boundary.refined_count,
            low_confidence_region_count: ambiguous_span_count
                + boundary.ambiguous_count
                + usize::from(catastrophic),
            quality: if blocked { "blocked" } else { "medium" }.to_string(),
            time_mapping_segment_count: Some(alignment.spans.len()),
            confirmed_change_count: Some(
                alignment
                    .spans
                    .iter()
                    .filter(|span| {
                        matches!(
                            span.kind,
                            AudioTimeMapSpanKind::SourceOnly | AudioTimeMapSpanKind::TargetOnly
                        )
                    })
                    .count(),
            ),
            signals: Some(vec![AlignmentEvidenceSignalSummary {
                kind: "audio",
                status: "used",
                label: "Alignment V2 landmark + edit-aware DP",
                observations: pair.hypothesis.inlier_count,
                weight: 1.0,
                note: "单一音频证据，必须人工复核。".to_string(),
            }]),
        }),
        match_range: Some(AlignmentMatchRange {
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
            coverage,
        }),
        time_map: Some(time_map),
    }
}

// Feature-frame centers can extend the last endpoint by a fraction of one hop.
// Constrain only that bounded quantization error, before quality/profile evaluation.
// Larger overruns and spans that would collapse remain invalid rather than being hidden.
fn clamp_quantized_media_tails(
    alignment: &mut V2ChunkAlignment,
    pair: &V2TrackPairCandidate,
    diagnostics: &mut Vec<String>,
) {
    let limit = |duration: Option<u64>, source: bool| {
        duration
            .filter(|duration| {
                let end = alignment
                    .spans
                    .last()
                    .map(|span| {
                        if source {
                            span.source_end_ms
                        } else {
                            span.target_end_ms
                        }
                    })
                    .unwrap_or(0);
                *duration > 0
                    && end > *duration
                    && end - *duration <= ALIGNMENT_V2_FINE_HOP_MS as u64
                    && alignment.spans.iter().all(|span| {
                        let (start, end) = if source {
                            (span.source_start_ms, span.source_end_ms)
                        } else {
                            (span.target_start_ms, span.target_end_ms)
                        };
                        start == end || start.min(*duration) < end.min(*duration)
                    })
            })
            .unwrap_or(u64::MAX)
    };
    let source_limit = limit(pair.source_input.media_duration_ms, true);
    let target_limit = limit(pair.target_input.media_duration_ms, false);
    if source_limit == u64::MAX && target_limit == u64::MAX {
        return;
    }
    let note = "细匹配末尾不足一个采样步长的越界已裁至媒体总时长，并按最终边界重新评估证据。";
    diagnostics.push(note.to_string());
    for span in &mut alignment.spans {
        if span.source_end_ms > source_limit || span.target_end_ms > target_limit {
            let start_changed =
                span.source_start_ms > source_limit || span.target_start_ms > target_limit;
            span.source_start_ms = span.source_start_ms.min(source_limit);
            span.source_end_ms = span.source_end_ms.min(source_limit);
            span.target_start_ms = span.target_start_ms.min(target_limit);
            span.target_end_ms = span.target_end_ms.min(target_limit);
            // A physical media endpoint is not an uncertain edit. Keep existing unknown
            // states and let final held-out validation score the corrected geometry.
            // Only a refined boundary moved by clipping loses its original certificate.
            for (boundary, changed) in [
                (&mut span.boundaries.start, start_changed),
                (&mut span.boundaries.end, true),
            ] {
                if changed && boundary.status == super::AudioTimeMapBoundaryStatus::Refined {
                    boundary.status = super::AudioTimeMapBoundaryStatus::Ambiguous;
                    boundary.refined_ms = None;
                    boundary.reason = note.to_string();
                }
            }
        }
    }
    for observation in &mut alignment.fine_evidence {
        observation.source_start_ms = observation.source_start_ms.min(source_limit);
        observation.source_end_ms = observation.source_end_ms.min(source_limit);
        observation.target_start_ms = observation.target_start_ms.min(target_limit);
        observation.target_end_ms = observation.target_end_ms.min(target_limit);
    }
}

fn create_v2_compatibility_anchors(
    spans: &[AudioTimeMapSpanDto],
    p95_residual_ms: i64,
    blocked: bool,
) -> Vec<SyncAnchorDto> {
    if blocked {
        return Vec::new();
    }
    let confidence = (1.0 - p95_residual_ms.max(0) as f64 / 500.0).clamp(0.25, 0.85);
    let mut points = Vec::new();
    for span in spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Matched)
    {
        points.push((span.source_start_ms, span.target_start_ms));
        points.push((span.source_end_ms, span.target_end_ms));
    }
    points.sort_unstable();
    points.dedup();
    points
        .into_iter()
        .take(200)
        .enumerate()
        .map(|(index, (source_ms, target_ms))| SyncAnchorDto {
            id: format!("alignment-v2-anchor-{}", index + 1),
            source_ms,
            target_ms,
            confidence,
            origin: "automatic",
        })
        .collect()
}

fn create_v2_compatibility_cut_candidates(
    spans: &[AudioTimeMapSpanDto],
    blocked: bool,
) -> Vec<CutCandidateDto> {
    if blocked {
        return Vec::new();
    }
    spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::TargetOnly)
        .enumerate()
        .map(|(index, span)| CutCandidateDto {
            id: format!("alignment-v2-gap-{}", index + 1),
            name: format!("V2 目标独有段 {}", index + 1),
            source_at_ms: span.source_start_ms,
            source_range_start_ms: span.source_start_ms,
            source_range_end_ms: span.source_end_ms,
            target_gap_ms: span.target_end_ms.saturating_sub(span.target_start_ms),
            confidence: 0.65,
            note: "由 V2 targetOnly span 兼容派生；正式结论以 timeMap 为准。".to_string(),
        })
        .collect()
}

fn v2_stream_identity(stream: &AudioStreamProbe) -> AudioTimeMapStreamIdentityDto {
    AudioTimeMapStreamIdentityDto {
        stream_type: "audio",
        index: stream.stream_index,
        codec: stream.codec_name.clone(),
        start_ms: Some(stream.start_time_ms),
        timeline_offset_ms: Some(stream.timeline_offset_ms),
        time_base: stream.time_base.clone(),
        sample_rate: stream.sample_rate,
        channels: stream.channels,
        frame_rate: None,
        language: stream.language.clone(),
        title: stream.title.clone(),
    }
}

fn create_v2_parameters_hash(pair: &V2TrackPairCandidate) -> String {
    create_v2_optional_parameters_hash(
        Some(&pair.source_input),
        Some(&pair.target_input),
        Some(&pair.source_spectral_backend_id),
        Some(&pair.target_spectral_backend_id),
        Some(&pair.toolchain_cache_identity),
    )
}

fn create_v2_optional_parameters_hash(
    source: Option<&AlignmentAudioInput>,
    target: Option<&AlignmentAudioInput>,
    source_spectral_backend_id: Option<&str>,
    target_spectral_backend_id: Option<&str>,
    toolchain_cache_identity: Option<&str>,
) -> String {
    let parameters = format!(
        "engine={ALIGNMENT_V2_ENGINE_VERSION}|feature={ALIGNMENT_V2_FEATURE_VERSION}|coarsePartialPolicy=independent-blocks-v2|sampleRate={ALIGNMENT_V2_SAMPLE_RATE}|landmarkHop={ALIGNMENT_V2_LANDMARK_HOP_MS}|fineHop={ALIGNMENT_V2_FINE_HOP_MS}|chunk={ALIGNMENT_V2_DP_CHUNK_MS}|band={ALIGNMENT_V2_DP_BAND_RADIUS_MS}|sourceSpectralBackend={source_spectral_backend_id:?}|targetSpectralBackend={target_spectral_backend_id:?}|toolchain={toolchain_cache_identity:?}|source={:?}|target={:?}",
        source.map(|input| (
            input.stream.stream_index,
            input.presentation_origin_ms,
            input.stream.timeline_offset_ms,
            input.stream.time_base.as_deref(),
            input.decode_timeline.as_ref().map(|timeline| (
                timeline.first_decoded_pts_ms,
                timeline.pts_discontinuity_count,
                timeline.max_pts_gap_ms,
                timeline.skip_samples,
                timeline.discard_padding,
                timeline.normalized_pcm_origin_ms,
            )),
        )),
        target.map(|input| (
            input.stream.stream_index,
            input.presentation_origin_ms,
            input.stream.timeline_offset_ms,
            input.stream.time_base.as_deref(),
            input.decode_timeline.as_ref().map(|timeline| (
                timeline.first_decoded_pts_ms,
                timeline.pts_discontinuity_count,
                timeline.max_pts_gap_ms,
                timeline.skip_samples,
                timeline.discard_padding,
                timeline.normalized_pcm_origin_ms,
            )),
        )),
    );
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in parameters.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

pub(super) struct V2BlockedProposalInput {
    pub(super) reason: String,
    pub(super) selected_stream_indices: Option<(u32, u32)>,
    pub(super) margin: Option<f64>,
    pub(super) alternatives: Vec<AudioAlternativeTrackScoreDto>,
    pub(super) diagnostics: Vec<String>,
}

pub(super) fn build_v2_blocked_proposal(input: V2BlockedProposalInput) -> AudioAlignmentProposal {
    let V2BlockedProposalInput {
        reason,
        selected_stream_indices,
        margin,
        alternatives,
        mut diagnostics,
    } = input;
    diagnostics.push(reason.clone());
    let selected_track_reason = selected_stream_indices.map_or_else(
        || "没有可形成主结论的音轨组合。".to_string(),
        |(source_stream_index, target_stream_index)| {
            format!(
                "候选 B 站参考音轨 #{source_stream_index}、目标原片音轨 #{target_stream_index} 未通过质量门控。"
            )
        },
    );
    diagnostics.push(selected_track_reason);
    if let Some(margin) = margin {
        diagnostics.push(format!("阻断时 Top1/Top2 margin 为 {margin:.3}。"));
    }
    if !alternatives.is_empty() {
        diagnostics.push(format!(
            "已保留 {} 个候选音轨组合分数；因没有合法定位范围，不生成 timeMap。",
            alternatives.len()
        ));
    }
    AudioAlignmentProposal {
        anchors: Vec::new(),
        cut_candidates: Vec::new(),
        evidence_profile: None,
        confidence: 0.0,
        diagnostics: diagnostics.clone(),
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: "alignment-v2-edit-map".to_string(),
            complete_fingerprint_count: 0,
            source_fingerprint_count: 0,
            fingerprint_match_count: 0,
            monotonic_match_count: 0,
            strong_anchor_count: 0,
            weak_anchor_count: 0,
            offset_cluster_count: 0,
            refined_candidate_count: 0,
            low_confidence_region_count: 1,
            quality: "blocked".to_string(),
            time_mapping_segment_count: Some(0),
            confirmed_change_count: Some(0),
            signals: Some(vec![AlignmentEvidenceSignalSummary {
                kind: "audio",
                status: "blocked",
                label: "Alignment V2 landmark + edit-aware DP",
                observations: 0,
                weight: 0.0,
                note: reason,
            }]),
        }),
        match_range: None,
        time_map: None,
    }
}

pub(super) struct V2BlockedAffineProposalInput {
    pub(super) reason: String,
    pub(super) pair: V2TrackPairCandidate,
    pub(super) margin: f64,
    pub(super) alternatives: Vec<AudioAlternativeTrackScoreDto>,
    pub(super) diagnostics: Vec<String>,
}

pub(super) fn build_v2_blocked_affine_proposal(
    input: V2BlockedAffineProposalInput,
) -> AudioAlignmentProposal {
    let V2BlockedAffineProposalInput {
        reason,
        pair,
        margin,
        alternatives,
        diagnostics,
    } = input;
    let mut proposal = build_v2_blocked_proposal(V2BlockedProposalInput {
        reason: reason.clone(),
        selected_stream_indices: Some((
            pair.source_input.stream.stream_index,
            pair.target_input.stream.stream_index,
        )),
        margin: Some(margin),
        alternatives: alternatives.clone(),
        diagnostics,
    });
    let (source_start_ms, source_end_ms, target_start_ms, target_end_ms) =
        create_blocked_affine_bounds(&pair);
    let selected_track_reason = format!(
        "已定位 B 站参考音轨 #{} 与目标原片音轨 #{}，但结果被质量门控阻断。",
        pair.source_input.stream.stream_index, pair.target_input.stream.stream_index
    );
    let spans = vec![create_v2_span(
        AudioTimeMapSpanKind::Ambiguous,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
    )];
    let V2BlockedAffineOutcomeAssessment {
        spans,
        coverage,
        time_map_quality,
        diagnostic,
    } = evaluate_v2_blocked_affine_outcome(V2BlockedAffineOutcomeInput {
        spans,
        hypothesis: &pair.hypothesis,
        use_island_local_residuals: pair.offset_island_count > 1,
        margin,
        reason: &reason,
    });
    proposal.diagnostics.push(diagnostic);
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        spans,
        quality: time_map_quality,
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["audio"],
            audio_anchor_count: pair
                .hypothesis
                .inlier_count
                .saturating_add(pair.hypothesis.held_out_anchors.len()),
            visual_anchor_count: 0,
            held_out_anchor_count: pair.hypothesis.held_out_anchors.len(),
            top1_top2_margin: Some(margin),
            unique_content_coverage: Some(coverage),
            repeated_content_only: pair.repeated_content_only,
            selected_track_reason,
            alternative_track_scores: alternatives,
            notes: proposal.diagnostics.clone(),
        },
        source_stream: Some(v2_stream_identity(&pair.source_input.stream)),
        target_stream: Some(v2_stream_identity(&pair.target_input.stream)),
        source_visual_stream: None,
        target_visual_stream: None,
        source_identity: pair.source_input.content_identity.clone(),
        target_identity: pair.target_input.content_identity.clone(),
        engine_version: ALIGNMENT_V2_ENGINE_VERSION,
        feature_version: ALIGNMENT_V2_FEATURE_VERSION,
        parameters_hash: create_v2_parameters_hash(&pair),
    };
    proposal.match_range = Some(AlignmentMatchRange {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        coverage,
    });
    proposal.time_map = Some(time_map);
    proposal
}

fn create_blocked_affine_bounds(pair: &V2TrackPairCandidate) -> (u64, u64, u64, u64) {
    let mut target_start = pair.target_input.stream.timeline_offset_ms.max(0);
    let mut target_end = pair
        .target_input
        .media_duration_ms
        .and_then(|duration| i64::try_from(duration).ok())
        .map(|duration| target_start.saturating_add(duration))
        .unwrap_or_else(|| {
            (pair.hypothesis.scale * pair.hypothesis.source_end_ms as f64
                + pair.hypothesis.offset_ms as f64)
                .round() as i64
        });
    if target_end <= target_start {
        target_start = (pair.hypothesis.scale * pair.hypothesis.source_start_ms as f64
            + pair.hypothesis.offset_ms as f64)
            .round()
            .max(0.0) as i64;
        target_end = (pair.hypothesis.scale * pair.hypothesis.source_end_ms as f64
            + pair.hypothesis.offset_ms as f64)
            .round()
            .max((target_start + ALIGNMENT_V2_FINE_HOP_MS as i64) as f64)
            as i64;
    }
    let source_start = ((target_start - pair.hypothesis.offset_ms) as f64 / pair.hypothesis.scale)
        .floor()
        .max(0.0) as u64;
    let source_end = ((target_end - pair.hypothesis.offset_ms) as f64 / pair.hypothesis.scale)
        .ceil()
        .max(source_start as f64 + ALIGNMENT_V2_FINE_HOP_MS as f64) as u64;
    (
        source_start,
        source_end,
        target_start.max(0) as u64,
        target_end.max(target_start + 1) as u64,
    )
}

#[cfg(test)]
mod tests {
    use crate::{
        alignment_v2::{AffineAnchorEvidence, AffineHypothesis, PresentationRangeMs},
        media_probe::{AudioDecodeTimelineProbe, AudioStreamProbe, MediaContentIdentity},
    };
    use serde_json::json;

    use super::{
        super::{
            v2_pair_engine::{create_v2_span, V2ChunkAlignment, V2TrackPairCandidate},
            v2_pair_fine_execution::V2BoundarySummary,
            AlignmentAudioInput, AudioAlignmentProposal, AudioTimeMapBoundaryStatus,
            AudioTimeMapSpanDto, AudioTimeMapSpanKind, ALIGNMENT_V2_FEATURE_VERSION,
            ALIGNMENT_V2_MIN_TRACK_MARGIN,
        },
        build_v2_aligned_proposal, build_v2_blocked_affine_proposal, build_v2_blocked_proposal,
        V2AlignedProposalInput, V2BlockedAffineProposalInput, V2BlockedProposalInput,
    };

    fn test_identity(digest_character: char) -> MediaContentIdentity {
        let digest = digest_character.to_string().repeat(64);
        MediaContentIdentity {
            algorithm: "sha256-full-file-v2",
            size_bytes: 1_024,
            modified_unix_ms: 1,
            first_sample_digest: digest.clone(),
            middle_sample_digest: digest.clone(),
            last_sample_digest: digest,
        }
    }

    fn test_audio_input(
        stream_index: u32,
        timeline_offset_ms: i64,
        digest_character: char,
    ) -> AlignmentAudioInput {
        AlignmentAudioInput {
            presentation_origin_ms: -80,
            media_duration_ms: Some(120_000),
            content_identity: Some(test_identity(digest_character)),
            decode_timeline: Some(AudioDecodeTimelineProbe {
                first_decoded_pts_ms: Some(-80 + timeline_offset_ms),
                decoded_frame_count: 1,
                ..AudioDecodeTimelineProbe::default()
            }),
            audio_stream_count: 2,
            explicit_stream_selection: false,
            stream: AudioStreamProbe {
                stream_index,
                codec_name: Some("aac".to_string()),
                start_time_ms: -80 + timeline_offset_ms,
                timeline_offset_ms,
                duration_ms: Some(120_000),
                time_base: Some("1/48000".to_string()),
                sample_rate: Some(48_000),
                channels: Some(2),
                channel_layout: Some("stereo".to_string()),
                language: Some("jpn".to_string()),
                title: Some(format!("Track {stream_index}")),
                is_default: stream_index == 1,
                is_commentary: false,
            },
        }
    }

    fn final_map_hypothesis(scale: f64, source_end_ms: i64) -> AffineHypothesis {
        let create_anchor = |source_time_ms: i64| AffineAnchorEvidence {
            source_time_ms,
            target_time_ms: (scale * source_time_ms as f64).round() as i64,
            residual_ms: 0,
        };
        let at_fraction = |numerator: i64| source_end_ms * numerator / 50;
        let training_anchors = [1, 10, 20, 30, 40, 49]
            .into_iter()
            .map(at_fraction)
            .map(create_anchor)
            .collect::<Vec<_>>();
        let held_out_anchors = [5, 15, 25, 35, 45]
            .into_iter()
            .map(at_fraction)
            .map(create_anchor)
            .collect::<Vec<_>>();
        AffineHypothesis {
            scale,
            offset_ms: 0,
            inlier_count: training_anchors.len(),
            unique_source_count: training_anchors.len(),
            unique_source_coverage: 0.96,
            unique_target_count: training_anchors.len(),
            unique_target_coverage: 0.96,
            source_start_ms: 0,
            source_end_ms,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors,
            held_out_within_tolerance_count: held_out_anchors.len(),
            held_out_anchors,
        }
    }

    fn test_pair_candidate() -> V2TrackPairCandidate {
        V2TrackPairCandidate {
            source_input: test_audio_input(1, 80, 'a'),
            target_input: test_audio_input(2, 120, 'b'),
            coarse_hypothesis: None,
            hypothesis: final_map_hypothesis(1.02, 50_000),
            offset_island_count: 1,
            score: 0.8,
            temporal_coverage: 0.75,
            intrinsic_margin: 0.5,
            repeated_content_only: false,
            observation_count: 64,
            source_landmark_count: 80,
            target_landmark_count: 72,
            source_spectral_backend_id: "test-cpu-spectral-v1".to_string(),
            target_spectral_backend_id: "test-cpu-spectral-v1".to_string(),
            toolchain_cache_identity: "toolchain=test-fixture-v1".to_string(),
            global_source_interval: PresentationRangeMs {
                start_ms: 0,
                end_ms: 120_000,
            },
            global_target_interval: PresentationRangeMs {
                start_ms: 0,
                end_ms: 120_000,
            },
            fine_working_set_bytes: 0,
        }
    }

    fn build_aligned_test_proposal(
        pair: V2TrackPairCandidate,
        spans: Vec<AudioTimeMapSpanDto>,
    ) -> AudioAlignmentProposal {
        build_v2_aligned_proposal(V2AlignedProposalInput {
            alignment: V2ChunkAlignment {
                spans,
                matched_step_count: 1_000,
                ambiguous_step_count: 0,
                path_checkpoints: Vec::new(),
                fine_evidence: Vec::new(),
            },
            boundary: V2BoundarySummary::default(),
            pair,
            top1_top2_margin: 1.0,
            minimum_alternative_margin: ALIGNMENT_V2_MIN_TRACK_MARGIN,
            selected_track_reason: "固定音轨选择。".to_string(),
            alternatives: Vec::new(),
            diagnostics: Vec::new(),
        })
    }

    fn proposal_parameters_hash(pair: V2TrackPairCandidate) -> String {
        build_aligned_test_proposal(
            pair,
            vec![create_v2_span(
                AudioTimeMapSpanKind::Matched,
                0,
                50_000,
                0,
                51_000,
            )],
        )
        .time_map
        .expect("aligned time map")
        .parameters_hash
    }

    #[test]
    fn aligned_builder_assembles_stable_time_map_and_compatibility_projection() {
        let proposal = build_v2_aligned_proposal(V2AlignedProposalInput {
            alignment: V2ChunkAlignment {
                spans: vec![create_v2_span(
                    AudioTimeMapSpanKind::Matched,
                    0,
                    50_000,
                    0,
                    51_000,
                )],
                matched_step_count: 1_000,
                ambiguous_step_count: 0,
                path_checkpoints: Vec::new(),
                fine_evidence: Vec::new(),
            },
            boundary: V2BoundarySummary::default(),
            pair: test_pair_candidate(),
            top1_top2_margin: 1.0,
            minimum_alternative_margin: ALIGNMENT_V2_MIN_TRACK_MARGIN,
            selected_track_reason: "固定音轨选择。".to_string(),
            alternatives: Vec::new(),
            diagnostics: vec!["前置诊断。".to_string()],
        });
        let value = serde_json::to_value(proposal).expect("serialize aligned proposal");

        assert_eq!(
            value
                .as_object()
                .expect("proposal object")
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "anchors",
                "confidence",
                "cutCandidates",
                "diagnostics",
                "evidence",
                "evidenceProfile",
                "matchRange",
                "timeMap",
            ]
        );
        assert_eq!(
            value["anchors"],
            json!([
                {"id": "alignment-v2-anchor-1", "sourceMs": 0, "targetMs": 0, "confidence": 0.85, "origin": "automatic"},
                {"id": "alignment-v2-anchor-2", "sourceMs": 50_000, "targetMs": 51_000, "confidence": 0.85, "origin": "automatic"}
            ])
        );
        assert_eq!(value["cutCandidates"], json!([]));
        assert_eq!(value["confidence"], json!(1.0));
        assert_eq!(
            value["matchRange"],
            json!({
                "sourceStartMs": 0,
                "sourceEndMs": 50_000,
                "targetStartMs": 0,
                "targetEndMs": 51_000,
                "coverage": 1.0
            })
        );
        assert_eq!(value["timeMap"]["quality"]["level"], json!("review"));
        assert_eq!(value["timeMap"]["sourceStream"]["index"], json!(1));
        assert_eq!(value["timeMap"]["targetStream"]["index"], json!(2));
        assert_eq!(
            value["timeMap"]["featureVersion"],
            json!(ALIGNMENT_V2_FEATURE_VERSION)
        );
        assert_eq!(
            value["timeMap"]["evidence"]["selectedTrackReason"],
            json!("固定音轨选择。")
        );
    }

    #[test]
    fn aligned_builder_projects_matched_source_only_and_target_only_without_fake_anchors() {
        let mut spans = vec![
            create_v2_span(AudioTimeMapSpanKind::Matched, 0, 35_000, 0, 35_000),
            create_v2_span(
                AudioTimeMapSpanKind::SourceOnly,
                35_000,
                65_000,
                35_000,
                35_000,
            ),
            create_v2_span(
                AudioTimeMapSpanKind::TargetOnly,
                65_000,
                65_000,
                35_000,
                45_000,
            ),
            create_v2_span(
                AudioTimeMapSpanKind::Matched,
                65_000,
                100_000,
                45_000,
                80_000,
            ),
        ];
        for span in spans
            .iter_mut()
            .filter(|span| span.kind != AudioTimeMapSpanKind::Matched)
        {
            for boundary in [&mut span.boundaries.start, &mut span.boundaries.end] {
                boundary.status = AudioTimeMapBoundaryStatus::Refined;
                boundary.support_duration_ms = 5_000;
                boundary.refined_ms = boundary.coarse_ms;
                boundary.reason = "测试中的相邻共同内容边界证据。".to_string();
            }
        }
        let anchor = |source_time_ms, target_time_ms| AffineAnchorEvidence {
            source_time_ms,
            target_time_ms,
            residual_ms: 0,
        };
        let mut pair = test_pair_candidate();
        pair.hypothesis = final_map_hypothesis(1.0, 100_000);
        pair.hypothesis.training_anchors = vec![
            anchor(1_000, 1_000),
            anchor(18_000, 18_000),
            anchor(33_000, 33_000),
            anchor(67_000, 47_000),
            anchor(82_000, 62_000),
            anchor(98_000, 78_000),
        ];
        pair.hypothesis.held_out_anchors = vec![
            anchor(5_000, 5_000),
            anchor(10_000, 10_000),
            anchor(15_000, 15_000),
            anchor(20_000, 20_000),
            anchor(25_000, 25_000),
            anchor(30_000, 30_000),
            anchor(34_000, 34_000),
            anchor(66_000, 46_000),
            anchor(70_000, 50_000),
            anchor(75_000, 55_000),
            anchor(80_000, 60_000),
            anchor(85_000, 65_000),
            anchor(90_000, 70_000),
            anchor(95_000, 75_000),
            anchor(99_000, 79_000),
        ];
        pair.hypothesis.inlier_count = pair.hypothesis.training_anchors.len();
        pair.hypothesis.unique_source_count = pair.hypothesis.training_anchors.len();
        pair.hypothesis.unique_target_count = pair.hypothesis.training_anchors.len();
        pair.hypothesis.held_out_within_tolerance_count = pair.hypothesis.held_out_anchors.len();

        let proposal = build_aligned_test_proposal(pair, spans);
        let time_map = proposal.time_map.expect("reviewable edited time map");

        assert_eq!(time_map.quality.level, "review");
        assert_eq!(
            time_map
                .spans
                .iter()
                .map(|span| span.kind)
                .collect::<Vec<_>>(),
            vec![
                AudioTimeMapSpanKind::Matched,
                AudioTimeMapSpanKind::SourceOnly,
                AudioTimeMapSpanKind::TargetOnly,
                AudioTimeMapSpanKind::Matched,
            ]
        );
        assert_eq!(
            proposal
                .anchors
                .iter()
                .map(|anchor| (anchor.id.as_str(), anchor.source_ms, anchor.target_ms))
                .collect::<Vec<_>>(),
            vec![
                ("alignment-v2-anchor-1", 0, 0),
                ("alignment-v2-anchor-2", 35_000, 35_000),
                ("alignment-v2-anchor-3", 65_000, 45_000),
                ("alignment-v2-anchor-4", 100_000, 80_000),
            ]
        );
        assert_eq!(
            serde_json::to_value(&proposal.cut_candidates).expect("serialize cuts"),
            json!([{
                "id": "alignment-v2-gap-1",
                "name": "V2 目标独有段 1",
                "sourceAtMs": 65_000,
                "sourceRangeStartMs": 65_000,
                "sourceRangeEndMs": 65_000,
                "targetGapMs": 10_000,
                "confidence": 0.65,
                "note": "由 V2 targetOnly span 兼容派生；正式结论以 timeMap 为准。"
            }])
        );
    }

    #[test]
    fn aligned_builder_caps_compatibility_anchors_at_two_hundred_in_stable_order() {
        let spans = (0..201_u64)
            .map(|index| {
                let start_ms = index * 1_000;
                create_v2_span(
                    AudioTimeMapSpanKind::Matched,
                    start_ms,
                    start_ms + 1_000,
                    start_ms,
                    start_ms + 1_000,
                )
            })
            .collect::<Vec<_>>();
        let training_anchors = (0..201_i64)
            .flat_map(|index| {
                let start_ms = index * 1_000;
                [100, 900].map(move |offset_ms| AffineAnchorEvidence {
                    source_time_ms: start_ms + offset_ms,
                    target_time_ms: start_ms + offset_ms,
                    residual_ms: 0,
                })
            })
            .collect::<Vec<_>>();
        let held_out_anchors = (0..201_i64)
            .map(|index| AffineAnchorEvidence {
                source_time_ms: index * 1_000 + 500,
                target_time_ms: index * 1_000 + 500,
                residual_ms: 0,
            })
            .collect::<Vec<_>>();
        let mut pair = test_pair_candidate();
        pair.hypothesis = AffineHypothesis {
            scale: 1.0,
            offset_ms: 0,
            inlier_count: training_anchors.len(),
            unique_source_count: training_anchors.len(),
            unique_source_coverage: 0.99,
            unique_target_count: training_anchors.len(),
            unique_target_coverage: 0.99,
            source_start_ms: 0,
            source_end_ms: 201_000,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors,
            held_out_within_tolerance_count: held_out_anchors.len(),
            held_out_anchors,
        };

        let proposal = build_aligned_test_proposal(pair, spans);

        assert_eq!(
            proposal
                .time_map
                .as_ref()
                .expect("reviewable time map")
                .quality
                .level,
            "review"
        );
        assert_eq!(proposal.anchors.len(), 200);
        assert_eq!(proposal.anchors[0].id, "alignment-v2-anchor-1");
        assert_eq!(proposal.anchors[0].source_ms, 0);
        assert_eq!(proposal.anchors[199].id, "alignment-v2-anchor-200");
        assert_eq!(proposal.anchors[199].source_ms, 199_000);
    }

    #[test]
    fn quantized_tail_is_bounded_before_project_range_validation() {
        let mut pair = test_pair_candidate();
        pair.target_input.media_duration_ms = Some(51_008);
        let mut spans = vec![
            create_v2_span(AudioTimeMapSpanKind::Matched, 0, 49_000, 0, 50_000),
            create_v2_span(
                AudioTimeMapSpanKind::TargetOnly,
                49_000,
                49_000,
                50_000,
                51_025,
            ),
            create_v2_span(
                AudioTimeMapSpanKind::Ambiguous,
                49_000,
                50_000,
                51_025,
                51_025,
            ),
        ];
        spans[1].boundaries.end.status = AudioTimeMapBoundaryStatus::Refined;
        spans[1].boundaries.end.refined_ms = Some(51_025);
        let proposal = build_aligned_test_proposal(pair.clone(), spans.clone());
        let map = proposal.time_map.unwrap();
        assert_eq!(map.target_end_ms, 51_008);
        assert_eq!(proposal.match_range.unwrap().target_end_ms, 51_008);
        assert_eq!(map.spans[1].target_end_ms, map.spans[2].target_start_ms);
        assert_eq!(map.spans[2].source_end_ms, 50_000);
        assert_eq!(map.quality.level, "blocked");
        assert_eq!(
            map.spans[1].boundaries.end.status,
            AudioTimeMapBoundaryStatus::Ambiguous
        );
        pair.target_input.media_duration_ms = Some(50_000);
        let larger_overrun = build_aligned_test_proposal(pair, spans);
        assert_eq!(larger_overrun.time_map.unwrap().target_end_ms, 51_025);
    }

    #[test]
    fn parameters_hash_binds_stream_backend_toolchain_and_decode_timeline_inputs() {
        let baseline = test_pair_candidate();
        let baseline_hash = proposal_parameters_hash(baseline.clone());
        // Includes the independent-blocks-v2 partial-candidate policy revision.
        assert_eq!(baseline_hash, "fnv1a64:30837d256730d170");

        let mut stream_changed = baseline.clone();
        stream_changed.source_input.stream.stream_index += 10;
        assert_ne!(proposal_parameters_hash(stream_changed), baseline_hash);

        let mut backend_changed = baseline.clone();
        backend_changed.source_spectral_backend_id = "test-other-backend-v1".to_string();
        assert_ne!(proposal_parameters_hash(backend_changed), baseline_hash);

        let mut toolchain_changed = baseline.clone();
        toolchain_changed.toolchain_cache_identity = "toolchain=test-fixture-v2".to_string();
        assert_ne!(proposal_parameters_hash(toolchain_changed), baseline_hash);

        let mut timeline_changed = baseline;
        timeline_changed
            .source_input
            .decode_timeline
            .as_mut()
            .expect("source timeline")
            .normalized_pcm_origin_ms += 1;
        assert_ne!(proposal_parameters_hash(timeline_changed), baseline_hash);
    }

    #[test]
    fn blocked_affine_builder_keeps_review_map_but_never_compatibility_outputs() {
        let proposal = build_v2_blocked_affine_proposal(V2BlockedAffineProposalInput {
            reason: "细粒度路径不可用。".to_string(),
            pair: test_pair_candidate(),
            margin: 0.2,
            alternatives: Vec::new(),
            diagnostics: vec!["前置仿射诊断。".to_string()],
        });
        let value = serde_json::to_value(proposal).expect("serialize affine blocked proposal");

        assert_eq!(
            value
                .as_object()
                .expect("proposal object")
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![
                "anchors",
                "confidence",
                "cutCandidates",
                "diagnostics",
                "evidence",
                "matchRange",
                "timeMap",
            ]
        );
        assert_eq!(value["anchors"], json!([]));
        assert_eq!(value["cutCandidates"], json!([]));
        assert_eq!(value["confidence"], json!(0.0));
        assert_eq!(value["timeMap"]["spans"].as_array().unwrap().len(), 1);
        assert_eq!(value["timeMap"]["spans"][0]["kind"], json!("ambiguous"));
        assert_eq!(value["timeMap"]["quality"]["level"], json!("blocked"));
        assert_eq!(value["timeMap"]["sourceStream"]["index"], json!(1));
        assert_eq!(value["timeMap"]["targetStream"]["index"], json!(2));
        assert_eq!(value["timeMap"]["evidence"]["types"], json!(["audio"]));
        assert_eq!(value["evidence"]["quality"], json!("blocked"));
    }

    #[test]
    fn blocked_without_map_has_exact_fail_closed_json() {
        let proposal = build_v2_blocked_proposal(V2BlockedProposalInput {
            reason: "没有共同音频。".to_string(),
            selected_stream_indices: None,
            margin: None,
            alternatives: Vec::new(),
            diagnostics: vec!["前置诊断。".to_string()],
        });

        assert_eq!(
            serde_json::to_value(proposal).expect("serialize blocked proposal"),
            json!({
                "anchors": [],
                "cutCandidates": [],
                "confidence": 0.0,
                "diagnostics": [
                    "前置诊断。",
                    "没有共同音频。",
                    "没有可形成主结论的音轨组合。"
                ],
                "evidence": {
                    "algorithm": "alignment-v2-edit-map",
                    "completeFingerprintCount": 0,
                    "sourceFingerprintCount": 0,
                    "fingerprintMatchCount": 0,
                    "monotonicMatchCount": 0,
                    "strongAnchorCount": 0,
                    "weakAnchorCount": 0,
                    "offsetClusterCount": 0,
                    "refinedCandidateCount": 0,
                    "lowConfidenceRegionCount": 1,
                    "quality": "blocked",
                    "timeMappingSegmentCount": 0,
                    "confirmedChangeCount": 0,
                    "signals": [{
                        "kind": "audio",
                        "status": "blocked",
                        "label": "Alignment V2 landmark + edit-aware DP",
                        "observations": 0,
                        "weight": 0.0,
                        "note": "没有共同音频。"
                    }]
                }
            })
        );
    }
}
