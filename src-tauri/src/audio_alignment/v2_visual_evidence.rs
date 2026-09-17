//! Pure publication and fail-closed adjudication of Alignment V2 visual evidence.

use super::{
    v2_pair_engine::{create_v2_span, format_v2_span_kind},
    v2_pair_outcome::v2_source_time_region_count,
    v2_pair_proposal::{build_v2_blocked_proposal, V2BlockedProposalInput},
    AlignmentEvidenceSignalSummary, AlignmentEvidenceSummary, AlignmentMatchRange,
    AudioAlignmentProposal, AudioAlignmentTimeMapDto, AudioTimeMapEvidenceDto,
    AudioTimeMapQualityDto, AudioTimeMapSignalStatus, AudioTimeMapSpanKind,
    AudioTimeMapSpanQualityDto, AudioTimeMapSpanSignalsDto, AudioTimeMapSpanSupportStatus,
    AudioTimeMapStreamIdentityDto, SyncAnchorDto, ALIGNMENT_V2_ENGINE_VERSION,
};
use crate::media_probe::MediaContentIdentity;

pub(super) struct V2VisualUnavailableFallbackInput {
    pub(super) audio_reason: String,
    pub(super) visual_reason: String,
    pub(super) diagnostics: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct V2VisualAffineMatch {
    pub(super) source_time_ms: u64,
    pub(super) target_time_ms: u64,
}

pub(super) struct V2VisualAffineFallbackInput {
    pub(super) audio_reason: String,
    pub(super) diagnostics: Vec<String>,
    pub(super) passes_evidence_gate: bool,
    pub(super) repeated_content_only: bool,
    pub(super) source_start_ms: u64,
    pub(super) source_end_ms: u64,
    pub(super) target_start_ms: u64,
    pub(super) target_end_ms: u64,
    pub(super) coverage: f64,
    pub(super) temporal_span_coverage: f64,
    pub(super) top1_top2_margin: f64,
    pub(super) p50_residual_ms: u64,
    pub(super) p95_residual_ms: u64,
    pub(super) max_residual_ms: u64,
    pub(super) interval_ms: u64,
    pub(super) matches: Vec<V2VisualAffineMatch>,
    pub(super) hypothesis_count: usize,
    pub(super) informative_source_count: usize,
    pub(super) informative_target_count: usize,
    pub(super) candidate_count: usize,
    pub(super) source_stream: AudioTimeMapStreamIdentityDto,
    pub(super) target_stream: AudioTimeMapStreamIdentityDto,
    pub(super) source_identity: Option<MediaContentIdentity>,
    pub(super) target_identity: Option<MediaContentIdentity>,
    pub(super) feature_version: &'static str,
    pub(super) parameters_hash: String,
    pub(super) selected_track_reason: String,
    pub(super) quality_reasons: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct V2VisualValidationObservation {
    pub(super) observations: usize,
    pub(super) supported_observations: usize,
    pub(super) mean_distance: f64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct V2VisualRiskWindowSummary {
    pub(super) attempted: usize,
    pub(super) supported: usize,
    pub(super) conflicting: usize,
    pub(super) recovered: usize,
    pub(super) ambiguous: usize,
}

pub(super) enum V2VisualValidationAssessment {
    Unavailable {
        note: String,
    },
    Observed {
        observation: V2VisualValidationObservation,
        local_visual: Option<V2VisualRiskWindowSummary>,
        conflict: bool,
    },
}

pub(super) struct V2VisualValidationInput {
    pub(super) proposal: AudioAlignmentProposal,
    pub(super) source_visual_stream: Option<AudioTimeMapStreamIdentityDto>,
    pub(super) target_visual_stream: Option<AudioTimeMapStreamIdentityDto>,
    pub(super) assessment: V2VisualValidationAssessment,
}

pub(super) fn build_v2_visual_unavailable_fallback(
    input: V2VisualUnavailableFallbackInput,
) -> AudioAlignmentProposal {
    let V2VisualUnavailableFallbackInput {
        audio_reason,
        visual_reason,
        mut diagnostics,
    } = input;
    diagnostics.push(visual_reason.clone());
    let mut proposal = build_v2_blocked_proposal(V2BlockedProposalInput {
        reason: audio_reason,
        selected_stream_indices: None,
        margin: None,
        alternatives: Vec::new(),
        diagnostics,
    });
    if let Some(evidence) = &mut proposal.evidence {
        evidence.algorithm = "alignment-v2-visual-fallback".to_string();
    }
    set_visual_evidence_signal(
        &mut proposal,
        AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "blocked",
            label: "V2 独立视觉仿射回退",
            observations: 0,
            weight: 0.0,
            note: visual_reason,
        },
    );
    proposal
}

pub(super) fn build_v2_visual_affine_fallback(
    input: V2VisualAffineFallbackInput,
) -> AudioAlignmentProposal {
    let V2VisualAffineFallbackInput {
        audio_reason,
        diagnostics,
        passes_evidence_gate,
        repeated_content_only,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        coverage,
        temporal_span_coverage,
        top1_top2_margin,
        p50_residual_ms,
        p95_residual_ms,
        max_residual_ms,
        interval_ms,
        matches,
        hypothesis_count,
        informative_source_count,
        informative_target_count,
        candidate_count,
        source_stream,
        target_stream,
        source_identity,
        target_identity,
        feature_version,
        parameters_hash,
        selected_track_reason,
        quality_reasons,
    } = input;
    let quality_level = if passes_evidence_gate {
        "review"
    } else {
        "blocked"
    };
    let span_kind = if passes_evidence_gate {
        AudioTimeMapSpanKind::Matched
    } else {
        AudioTimeMapSpanKind::Ambiguous
    };
    let anchors = if passes_evidence_gate {
        let stride = matches.len().div_ceil(120).max(1);
        matches
            .iter()
            .step_by(stride)
            .enumerate()
            .map(|(index, item)| SyncAnchorDto {
                id: format!("alignment-v2-visual-anchor-{}", index + 1),
                source_ms: item.source_time_ms,
                target_ms: item.target_time_ms,
                confidence: (0.45 + coverage * 0.25).min(0.70),
                origin: "automatic",
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut visual_span = create_v2_span(
        span_kind,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
    );
    visual_span.id = format!(
        "span-1-{}-{}-{}-{}-{}",
        format_v2_span_kind(span_kind),
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms
    );
    visual_span.reason = if passes_evidence_gate {
        "独立视觉仿射仅支持粗粒度共同内容定位，不提供精确版本差异边界。".to_string()
    } else {
        "独立视觉候选未通过覆盖、竞争位置或时间域门控，该范围保持 ambiguous。".to_string()
    };
    visual_span.quality = AudioTimeMapSpanQualityDto {
        level: "blocked",
        metric_source: "measured",
        probability: None,
        coverage: Some(coverage.min(temporal_span_coverage)),
        unique_content_coverage: Some(coverage.min(temporal_span_coverage)),
        alternative_margin: Some(top1_top2_margin),
        anchor_count: matches.len(),
        held_out_anchor_count: 0,
        p50_residual_ms: Some(p50_residual_ms),
        p95_residual_ms: Some(p95_residual_ms),
        p99_residual_ms: None,
        max_residual_ms: Some(max_residual_ms),
        boundary_uncertainty_ms: Some(interval_ms.saturating_mul(2)),
        left_support: AudioTimeMapSpanSupportStatus::Unsupported,
        right_support: AudioTimeMapSpanSupportStatus::Unsupported,
        signals: AudioTimeMapSpanSignalsDto {
            audio: AudioTimeMapSignalStatus::Blocked,
            visual: if passes_evidence_gate {
                AudioTimeMapSignalStatus::Used
            } else {
                AudioTimeMapSignalStatus::Conflict
            },
            danmaku: AudioTimeMapSignalStatus::Blocked,
        },
        reasons: quality_reasons.clone(),
    };
    let visual_source_times = matches
        .iter()
        .map(|item| item.source_time_ms)
        .collect::<Vec<_>>();
    let anchor_region_count =
        v2_source_time_region_count(&visual_source_times, source_start_ms, source_end_ms);
    let clamped_coverage = coverage.min(temporal_span_coverage).clamp(0.0, 1.0);
    let time_map = AudioAlignmentTimeMapDto {
        source_start_ms,
        source_end_ms,
        target_start_ms,
        target_end_ms,
        spans: vec![visual_span],
        quality: AudioTimeMapQualityDto {
            level: quality_level,
            metric_source: "measured",
            probability: None,
            coverage: Some(coverage.min(temporal_span_coverage)),
            unique_content_coverage: Some(clamped_coverage),
            p50_residual_ms: Some(p50_residual_ms),
            p95_residual_ms: Some(p95_residual_ms),
            p99_residual_ms: None,
            max_residual_ms: Some(max_residual_ms),
            boundary_uncertainty_ms: Some(interval_ms.saturating_mul(2)),
            alternative_margin: Some(top1_top2_margin),
            anchor_count: matches.len(),
            anchor_region_count,
            held_out_anchor_count: 0,
            reasons: quality_reasons,
        },
        evidence: AudioTimeMapEvidenceDto {
            types: vec!["visual"],
            audio_anchor_count: 0,
            visual_anchor_count: matches.len(),
            held_out_anchor_count: 0,
            top1_top2_margin: Some(top1_top2_margin),
            unique_content_coverage: Some(clamped_coverage),
            repeated_content_only,
            selected_track_reason,
            alternative_track_scores: Vec::new(),
            notes: diagnostics.clone(),
        },
        source_stream: Some(source_stream.clone()),
        target_stream: Some(target_stream.clone()),
        source_visual_stream: Some(source_stream),
        target_visual_stream: Some(target_stream),
        source_identity,
        target_identity,
        engine_version: ALIGNMENT_V2_ENGINE_VERSION,
        feature_version,
        parameters_hash,
    };
    let visual_signal = AlignmentEvidenceSignalSummary {
        kind: "visual",
        status: if passes_evidence_gate {
            "used"
        } else {
            "blocked"
        },
        label: "V2 独立视觉仿射回退",
        observations: matches.len(),
        weight: if passes_evidence_gate { 1.0 } else { 0.0 },
        note: if passes_evidence_gate {
            "视觉仅提供粗粒度仿射定位；稀疏采样不用于断言精确删减边界。".to_string()
        } else {
            "视觉候选因覆盖、重复位置 margin 或时间域门控不足而阻断。".to_string()
        },
    };
    let mut proposal = AudioAlignmentProposal {
        anchors,
        cut_candidates: Vec::new(),
        evidence_profile: None,
        confidence: if passes_evidence_gate {
            (coverage * 0.7).min(0.7)
        } else {
            0.0
        },
        diagnostics: diagnostics.clone(),
        evidence: Some(AlignmentEvidenceSummary {
            algorithm: "alignment-v2-visual-affine-fallback".to_string(),
            complete_fingerprint_count: informative_target_count,
            source_fingerprint_count: informative_source_count,
            fingerprint_match_count: candidate_count,
            monotonic_match_count: matches.len(),
            strong_anchor_count: if passes_evidence_gate {
                matches.len()
            } else {
                0
            },
            weak_anchor_count: if passes_evidence_gate {
                0
            } else {
                matches.len()
            },
            offset_cluster_count: hypothesis_count,
            refined_candidate_count: 0,
            low_confidence_region_count: usize::from(!passes_evidence_gate),
            quality: if passes_evidence_gate {
                "medium"
            } else {
                "blocked"
            }
            .to_string(),
            time_mapping_segment_count: Some(1),
            confirmed_change_count: Some(0),
            signals: Some(vec![AlignmentEvidenceSignalSummary {
                kind: "audio",
                status: "blocked",
                label: "Alignment V2 landmark + edit-aware DP",
                observations: 0,
                weight: 0.0,
                note: audio_reason,
            }]),
        }),
        match_range: Some(AlignmentMatchRange {
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
            coverage: coverage.min(temporal_span_coverage),
        }),
        time_map: Some(time_map),
    };
    set_visual_evidence_signal(&mut proposal, visual_signal);
    proposal
}

pub(super) fn apply_v2_visual_validation(input: V2VisualValidationInput) -> AudioAlignmentProposal {
    let V2VisualValidationInput {
        mut proposal,
        source_visual_stream,
        target_visual_stream,
        assessment,
    } = input;
    if let Some(time_map) = &mut proposal.time_map {
        if let Some(source_visual_stream) = source_visual_stream {
            time_map.source_visual_stream = Some(source_visual_stream);
        }
        if let Some(target_visual_stream) = target_visual_stream {
            time_map.target_visual_stream = Some(target_visual_stream);
        }
    }
    match assessment {
        V2VisualValidationAssessment::Unavailable { note } => {
            proposal.diagnostics.push(note.clone());
            set_visual_evidence_signal(
                &mut proposal,
                AlignmentEvidenceSignalSummary {
                    kind: "visual",
                    status: "blocked",
                    label: "V2 独立视觉校验",
                    observations: 0,
                    weight: 0.0,
                    note,
                },
            );
        }
        V2VisualValidationAssessment::Observed {
            observation,
            local_visual,
            conflict,
        } => {
            let support_ratio =
                observation.supported_observations as f64 / observation.observations.max(1) as f64;
            let note = format!(
                "独立视觉校验：{} / {} 帧支持音频 timeMap，支持率 {:.1}%，平均距离 {:.3}；风险窗口局部复核 {:?}。",
                observation.supported_observations,
                observation.observations,
                support_ratio * 100.0,
                observation.mean_distance,
                local_visual
            );
            proposal.diagnostics.push(note.clone());
            if let Some(time_map) = &mut proposal.time_map {
                if !time_map.evidence.types.contains(&"visual") {
                    time_map.evidence.types.push("visual");
                }
                time_map.evidence.visual_anchor_count = observation.supported_observations;
                time_map.evidence.notes.push(note.clone());
            }
            set_visual_evidence_signal(
                &mut proposal,
                AlignmentEvidenceSignalSummary {
                    kind: "visual",
                    status: if conflict { "conflict" } else { "used" },
                    label: "V2 独立视觉校验",
                    observations: observation.observations,
                    weight: if conflict { 0.0 } else { 0.25 },
                    note: if conflict {
                        format!("{note} 与音频映射明显冲突，已触发 blocked 否决。")
                    } else {
                        format!("{note} 视觉证据只校验，不提高质量等级。")
                    },
                },
            );
            if conflict {
                block_proposal_for_v2_visual_conflict(&mut proposal);
            }
        }
    }
    proposal
}

fn block_proposal_for_v2_visual_conflict(proposal: &mut AudioAlignmentProposal) {
    if let Some(time_map) = &mut proposal.time_map {
        time_map.quality.level = "blocked";
        time_map
            .quality
            .reasons
            .push("独立视觉采样与音频 timeMap 明显冲突；该映射已降级为 blocked。".to_string());
        time_map
            .evidence
            .notes
            .push("视觉只执行冲突否决，不会把音频结果升级为 verified。".to_string());
    }
    proposal.confidence = 0.0;
    proposal.anchors.clear();
    proposal.cut_candidates.clear();
    if let Some(evidence) = &mut proposal.evidence {
        evidence.quality = "blocked".to_string();
        evidence.low_confidence_region_count =
            evidence.low_confidence_region_count.saturating_add(1);
    }
    proposal
        .diagnostics
        .push("安全门控：音画冲突已清空兼容锚点与删减候选。".to_string());
}

pub(super) fn set_visual_evidence_signal(
    proposal: &mut AudioAlignmentProposal,
    signal: AlignmentEvidenceSignalSummary,
) {
    if let Some(evidence) = &mut proposal.evidence {
        let mut signals = evidence.signals.take().unwrap_or_default();
        signals.retain(|item| item.kind != "visual");
        let insert_index = signals
            .iter()
            .position(|item| item.kind == "danmaku")
            .unwrap_or(signals.len());
        signals.insert(insert_index, signal);
        evidence.signals = Some(signals);
    }
}

#[cfg(test)]
mod tests {
    use crate::media_probe::MediaContentIdentity;
    use serde_json::json;

    use super::super::{
        AlignmentEvidenceSignalSummary, AudioTimeMapStreamIdentityDto, CutCandidateDto,
    };
    use super::{
        apply_v2_visual_validation, build_v2_visual_affine_fallback,
        build_v2_visual_unavailable_fallback, set_visual_evidence_signal,
        V2VisualAffineFallbackInput, V2VisualAffineMatch, V2VisualRiskWindowSummary,
        V2VisualUnavailableFallbackInput, V2VisualValidationAssessment, V2VisualValidationInput,
        V2VisualValidationObservation,
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

    fn test_video_stream(index: u32) -> AudioTimeMapStreamIdentityDto {
        AudioTimeMapStreamIdentityDto {
            stream_type: "video",
            index,
            codec: Some("h264".to_string()),
            start_ms: Some(0),
            timeline_offset_ms: Some(0),
            time_base: Some("1/1000".to_string()),
            sample_rate: None,
            channels: None,
            frame_rate: Some(24.0),
            language: Some("jpn".to_string()),
            title: Some(format!("Video {index}")),
        }
    }

    fn affine_input(passes_evidence_gate: bool) -> V2VisualAffineFallbackInput {
        V2VisualAffineFallbackInput {
            audio_reason: "没有共同音频。".to_string(),
            diagnostics: vec!["视觉 Top-K：固定测试假设。".to_string()],
            passes_evidence_gate,
            repeated_content_only: false,
            source_start_ms: 0,
            source_end_ms: 30_000,
            target_start_ms: 5_000,
            target_end_ms: 35_000,
            coverage: 0.8,
            temporal_span_coverage: 0.75,
            top1_top2_margin: 0.4,
            p50_residual_ms: 20,
            p95_residual_ms: 80,
            max_residual_ms: 120,
            interval_ms: 5_000,
            matches: vec![
                V2VisualAffineMatch {
                    source_time_ms: 0,
                    target_time_ms: 5_000,
                },
                V2VisualAffineMatch {
                    source_time_ms: 15_000,
                    target_time_ms: 20_000,
                },
                V2VisualAffineMatch {
                    source_time_ms: 30_000,
                    target_time_ms: 35_000,
                },
            ],
            hypothesis_count: 1,
            informative_source_count: 30,
            informative_target_count: 32,
            candidate_count: 24,
            source_stream: test_video_stream(3),
            target_stream: test_video_stream(5),
            source_identity: Some(test_identity('a')),
            target_identity: Some(test_identity('b')),
            feature_version: "test-v2-visual-feature-v1",
            parameters_hash: "fnv1a64:0123456789abcdef".to_string(),
            selected_track_reason:
                "音频不可用后，独立视觉选择参考视频流 #3 → 目标视频流 #5；Top1/Top2 margin 0.400。"
                    .to_string(),
            quality_reasons: vec![
                "视觉回退是稀疏仿射定位，只能确认粗粒度时间关系，不能宣称精确删减边界。"
                    .to_string(),
                "真实媒体冻结集和概率校准尚未完成；视觉结果最高只能进入人工复核。".to_string(),
            ],
        }
    }

    #[test]
    fn unavailable_fallback_has_exact_fail_closed_json_without_media_paths() {
        let proposal = build_v2_visual_unavailable_fallback(V2VisualUnavailableFallbackInput {
            audio_reason: "没有共同音频。".to_string(),
            visual_reason: "视觉证据不可用。".to_string(),
            diagnostics: vec!["前置诊断。".to_string()],
        });

        assert_eq!(
            serde_json::to_value(proposal).expect("serialize visual unavailable fallback"),
            json!({
                "anchors": [],
                "cutCandidates": [],
                "confidence": 0.0,
                "diagnostics": [
                    "前置诊断。",
                    "视觉证据不可用。",
                    "没有共同音频。",
                    "没有可形成主结论的音轨组合。"
                ],
                "evidence": {
                    "algorithm": "alignment-v2-visual-fallback",
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
                    "signals": [
                        {
                            "kind": "audio",
                            "status": "blocked",
                            "label": "Alignment V2 landmark + edit-aware DP",
                            "observations": 0,
                            "weight": 0.0,
                            "note": "没有共同音频。"
                        },
                        {
                            "kind": "visual",
                            "status": "blocked",
                            "label": "V2 独立视觉仿射回退",
                            "observations": 0,
                            "weight": 0.0,
                            "note": "视觉证据不可用。"
                        }
                    ]
                }
            })
        );
    }

    #[test]
    fn affine_fallback_publishes_review_only_map_with_stable_visual_anchors() {
        let proposal = build_v2_visual_affine_fallback(affine_input(true));
        let value = serde_json::to_value(proposal).expect("serialize affine visual fallback");

        assert!(
            (value["confidence"].as_f64().expect("numeric confidence") - 0.56).abs()
                < f64::EPSILON * 4.0
        );
        assert_eq!(
            value["anchors"],
            json!([
                {"id": "alignment-v2-visual-anchor-1", "sourceMs": 0, "targetMs": 5_000, "confidence": 0.65, "origin": "automatic"},
                {"id": "alignment-v2-visual-anchor-2", "sourceMs": 15_000, "targetMs": 20_000, "confidence": 0.65, "origin": "automatic"},
                {"id": "alignment-v2-visual-anchor-3", "sourceMs": 30_000, "targetMs": 35_000, "confidence": 0.65, "origin": "automatic"}
            ])
        );
        assert_eq!(value["cutCandidates"], json!([]));
        assert_eq!(value["timeMap"]["quality"]["level"], json!("review"));
        assert_ne!(value["timeMap"]["quality"]["level"], json!("verified"));
        assert_eq!(value["timeMap"]["spans"][0]["kind"], json!("matched"));
        assert_eq!(
            value["timeMap"]["spans"][0]["quality"]["level"],
            json!("blocked")
        );
        assert_eq!(value["timeMap"]["evidence"]["types"], json!(["visual"]));
        assert_eq!(value["timeMap"]["evidence"]["visualAnchorCount"], json!(3));
        assert_eq!(value["timeMap"]["sourceVisualStream"]["index"], json!(3));
        assert_eq!(value["timeMap"]["targetVisualStream"]["index"], json!(5));
        assert_eq!(
            value["timeMap"]["parametersHash"],
            json!("fnv1a64:0123456789abcdef")
        );
        assert_eq!(
            value["evidence"]["algorithm"],
            json!("alignment-v2-visual-affine-fallback")
        );
        assert_eq!(value["evidence"]["quality"], json!("medium"));
        assert_eq!(value["evidence"]["signals"][0]["kind"], json!("audio"));
        assert_eq!(value["evidence"]["signals"][1]["kind"], json!("visual"));
    }

    #[test]
    fn affine_fallback_keeps_repeated_or_weak_location_blocked_and_ambiguous() {
        let mut input = affine_input(false);
        input.repeated_content_only = true;
        input.top1_top2_margin = 0.05;
        input.quality_reasons.push(
            "重复片头或重复画面仍有竞争位置：Top1/Top2 margin 0.050 低于 0.120。".to_string(),
        );

        let proposal = build_v2_visual_affine_fallback(input);
        let value = serde_json::to_value(proposal).expect("serialize blocked affine fallback");

        assert_eq!(value["confidence"], json!(0.0));
        assert_eq!(value["anchors"], json!([]));
        assert_eq!(value["timeMap"]["quality"]["level"], json!("blocked"));
        assert_eq!(value["timeMap"]["spans"][0]["kind"], json!("ambiguous"));
        assert_eq!(
            value["timeMap"]["spans"][0]["quality"]["signals"]["visual"],
            json!("conflict")
        );
        assert_eq!(
            value["timeMap"]["evidence"]["repeatedContentOnly"],
            json!(true)
        );
        assert_eq!(value["evidence"]["quality"], json!("blocked"));
        assert_eq!(value["evidence"]["signals"][1]["status"], json!("blocked"));
    }

    #[test]
    fn affine_fallback_caps_visual_anchors_at_one_hundred_twenty_in_stable_order() {
        let mut input = affine_input(true);
        input.matches = (0..240_u64)
            .map(|index| V2VisualAffineMatch {
                source_time_ms: index * 1_000,
                target_time_ms: 5_000 + index * 1_000,
            })
            .collect();
        input.source_end_ms = 240_000;
        input.target_end_ms = 245_000;

        let proposal = build_v2_visual_affine_fallback(input);

        assert_eq!(proposal.anchors.len(), 120);
        assert_eq!(proposal.anchors[0].id, "alignment-v2-visual-anchor-1");
        assert_eq!(proposal.anchors[0].source_ms, 0);
        assert_eq!(proposal.anchors[119].id, "alignment-v2-visual-anchor-120");
        assert_eq!(proposal.anchors[119].source_ms, 238_000);
    }

    #[test]
    fn unavailable_validation_preserves_audio_result_and_replaces_visual_before_danmaku() {
        let mut proposal = build_v2_visual_affine_fallback(affine_input(true));
        let evidence = proposal.evidence.as_mut().expect("proposal evidence");
        evidence
            .signals
            .as_mut()
            .expect("proposal signals")
            .push(AlignmentEvidenceSignalSummary {
                kind: "danmaku",
                status: "notConfigured",
                label: "弹幕文本线索",
                observations: 0,
                weight: 0.0,
                note: "未配置。".to_string(),
            });
        let original_confidence = proposal.confidence;
        let original_anchors = serde_json::to_value(&proposal.anchors).expect("serialize anchors");
        let original_cuts = serde_json::to_value(&proposal.cut_candidates).expect("serialize cuts");
        let original_quality = proposal.time_map.as_ref().expect("time map").quality.level;

        let proposal = apply_v2_visual_validation(V2VisualValidationInput {
            proposal,
            source_visual_stream: Some(test_video_stream(7)),
            target_visual_stream: Some(test_video_stream(9)),
            assessment: V2VisualValidationAssessment::Unavailable {
                note: "视觉有效帧不足，未改变音频质量等级。".to_string(),
            },
        });
        let value = serde_json::to_value(&proposal).expect("serialize unavailable validation");

        assert_eq!(proposal.confidence, original_confidence);
        assert_eq!(
            serde_json::to_value(&proposal.anchors).unwrap(),
            original_anchors
        );
        assert_eq!(
            serde_json::to_value(&proposal.cut_candidates).unwrap(),
            original_cuts
        );
        assert_eq!(
            proposal.time_map.as_ref().expect("time map").quality.level,
            original_quality
        );
        assert_eq!(value["timeMap"]["sourceVisualStream"]["index"], json!(7));
        assert_eq!(value["timeMap"]["targetVisualStream"]["index"], json!(9));
        assert_eq!(
            value["evidence"]["signals"]
                .as_array()
                .expect("signals")
                .iter()
                .map(|signal| signal["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["audio", "visual", "danmaku"]
        );
        assert_eq!(value["evidence"]["signals"][1]["status"], json!("blocked"));
        assert_eq!(
            value["diagnostics"].as_array().unwrap().last().unwrap(),
            &json!("视觉有效帧不足，未改变音频质量等级。")
        );
    }

    #[test]
    fn supported_validation_adds_visual_evidence_without_upgrading_audio_quality() {
        let mut proposal = build_v2_visual_affine_fallback(affine_input(true));
        let time_map = proposal.time_map.as_mut().expect("time map");
        time_map.evidence.types = vec!["audio"];
        time_map.evidence.visual_anchor_count = 0;
        time_map.source_visual_stream = None;
        time_map.target_visual_stream = None;
        let evidence = proposal.evidence.as_mut().expect("proposal evidence");
        evidence.algorithm = "alignment-v2-edit-map".to_string();
        evidence.signals = Some(vec![
            AlignmentEvidenceSignalSummary {
                kind: "audio",
                status: "used",
                label: "Alignment V2 landmark + edit-aware DP",
                observations: 12,
                weight: 1.0,
                note: "音频证据。".to_string(),
            },
            AlignmentEvidenceSignalSummary {
                kind: "danmaku",
                status: "notConfigured",
                label: "弹幕文本线索",
                observations: 0,
                weight: 0.0,
                note: "未配置。".to_string(),
            },
        ]);
        let original_confidence = proposal.confidence;
        let original_anchors = serde_json::to_value(&proposal.anchors).expect("serialize anchors");
        let original_cuts = serde_json::to_value(&proposal.cut_candidates).expect("serialize cuts");

        let proposal = apply_v2_visual_validation(V2VisualValidationInput {
            proposal,
            source_visual_stream: Some(test_video_stream(7)),
            target_visual_stream: Some(test_video_stream(9)),
            assessment: V2VisualValidationAssessment::Observed {
                observation: V2VisualValidationObservation {
                    observations: 10,
                    supported_observations: 8,
                    mean_distance: 0.1,
                },
                local_visual: Some(V2VisualRiskWindowSummary {
                    attempted: 4,
                    supported: 3,
                    conflicting: 1,
                    recovered: 2,
                    ambiguous: 0,
                }),
                conflict: false,
            },
        });
        let value = serde_json::to_value(&proposal).expect("serialize supported validation");

        assert_eq!(proposal.confidence, original_confidence);
        assert_eq!(
            serde_json::to_value(&proposal.anchors).unwrap(),
            original_anchors
        );
        assert_eq!(
            serde_json::to_value(&proposal.cut_candidates).unwrap(),
            original_cuts
        );
        assert_eq!(value["timeMap"]["quality"]["level"], json!("review"));
        assert_ne!(value["timeMap"]["quality"]["level"], json!("verified"));
        assert_eq!(
            value["timeMap"]["evidence"]["types"],
            json!(["audio", "visual"])
        );
        assert_eq!(value["timeMap"]["evidence"]["visualAnchorCount"], json!(8));
        assert_eq!(
            value["evidence"]["signals"]
                .as_array()
                .expect("signals")
                .iter()
                .map(|signal| signal["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["audio", "visual", "danmaku"]
        );
        assert_eq!(value["evidence"]["signals"][1]["status"], json!("used"));
        assert_eq!(value["evidence"]["signals"][1]["observations"], json!(10));
        assert_eq!(value["evidence"]["signals"][1]["weight"], json!(0.25));
        assert!(value["evidence"]["signals"][1]["note"]
            .as_str()
            .unwrap()
            .ends_with("视觉证据只校验，不提高质量等级。"));
        assert!(value["diagnostics"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .contains("风险窗口局部复核 Some(V2VisualRiskWindowSummary { attempted: 4, supported: 3, conflicting: 1, recovered: 2, ambiguous: 0 })"));
    }

    #[test]
    fn conflicting_validation_blocks_and_clears_compatibility_outputs() {
        let mut proposal = build_v2_visual_affine_fallback(affine_input(true));
        proposal.cut_candidates.push(CutCandidateDto {
            id: "compatibility-cut".to_string(),
            name: "兼容删减候选".to_string(),
            source_at_ms: 15_000,
            source_range_start_ms: 15_000,
            source_range_end_ms: 15_000,
            target_gap_ms: 1_000,
            confidence: 0.65,
            note: "仅供兼容。".to_string(),
        });
        let previous_low_confidence_regions = proposal
            .evidence
            .as_ref()
            .expect("proposal evidence")
            .low_confidence_region_count;

        let proposal = apply_v2_visual_validation(V2VisualValidationInput {
            proposal,
            source_visual_stream: Some(test_video_stream(7)),
            target_visual_stream: Some(test_video_stream(9)),
            assessment: V2VisualValidationAssessment::Observed {
                observation: V2VisualValidationObservation {
                    observations: 10,
                    supported_observations: 1,
                    mean_distance: 0.7,
                },
                local_visual: None,
                conflict: true,
            },
        });
        let value = serde_json::to_value(&proposal).expect("serialize conflicting validation");

        assert_eq!(proposal.confidence, 0.0);
        assert!(proposal.anchors.is_empty());
        assert!(proposal.cut_candidates.is_empty());
        assert_eq!(value["timeMap"]["quality"]["level"], json!("blocked"));
        assert!(value["timeMap"]["quality"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(
                |reason| reason == "独立视觉采样与音频 timeMap 明显冲突；该映射已降级为 blocked。"
            ));
        assert_eq!(value["evidence"]["quality"], json!("blocked"));
        assert_eq!(
            value["evidence"]["lowConfidenceRegionCount"],
            json!(previous_low_confidence_regions + 1)
        );
        assert_eq!(value["evidence"]["signals"][1]["status"], json!("conflict"));
        assert_eq!(value["evidence"]["signals"][1]["weight"], json!(0.0));
        assert!(value["evidence"]["signals"][1]["note"]
            .as_str()
            .unwrap()
            .ends_with("与音频映射明显冲突，已触发 blocked 否决。"));
        assert_eq!(
            value["diagnostics"].as_array().unwrap().last().unwrap(),
            &json!("安全门控：音画冲突已清空兼容锚点与删减候选。")
        );
    }

    #[test]
    fn repeated_visual_signal_publication_keeps_one_entry_before_danmaku() {
        let mut proposal = build_v2_visual_unavailable_fallback(V2VisualUnavailableFallbackInput {
            audio_reason: "没有共同音频。".to_string(),
            visual_reason: "视觉不可用。".to_string(),
            diagnostics: Vec::new(),
        });
        let signals = proposal
            .evidence
            .as_mut()
            .expect("proposal evidence")
            .signals
            .as_mut()
            .expect("proposal signals");
        signals.push(AlignmentEvidenceSignalSummary {
            kind: "visual",
            status: "used",
            label: "旧视觉条目",
            observations: 99,
            weight: 1.0,
            note: "应被替换。".to_string(),
        });
        signals.push(AlignmentEvidenceSignalSummary {
            kind: "danmaku",
            status: "notConfigured",
            label: "弹幕文本线索",
            observations: 0,
            weight: 0.0,
            note: "未配置。".to_string(),
        });

        for (status, observations) in [("used", 4), ("conflict", 6)] {
            set_visual_evidence_signal(
                &mut proposal,
                AlignmentEvidenceSignalSummary {
                    kind: "visual",
                    status,
                    label: "V2 独立视觉校验",
                    observations,
                    weight: 0.25,
                    note: "固定发布。".to_string(),
                },
            );
        }

        let signals = proposal
            .evidence
            .expect("proposal evidence")
            .signals
            .expect("proposal signals");
        assert_eq!(
            signals.iter().map(|signal| signal.kind).collect::<Vec<_>>(),
            vec!["audio", "visual", "danmaku"]
        );
        assert_eq!(
            signals
                .iter()
                .filter(|signal| signal.kind == "visual")
                .count(),
            1
        );
        assert_eq!(signals[1].status, "conflict");
        assert_eq!(signals[1].observations, 6);
    }
}
