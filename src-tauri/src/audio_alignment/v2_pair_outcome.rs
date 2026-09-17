//! Post-fine quality and evidence adjudication for one V2 pair.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::alignment_v2::{AffineAnchorEvidence, AffineHypothesis, AFFINE_HOLDOUT_TIME_BLOCK_MS};

#[cfg(test)]
use super::create_v2_span;
use super::{
    v2_pair_engine::{
        format_v2_span_kind, is_v2_edit_span, v2_affine_match_config, V2ChunkAlignment,
        V2FineEvidenceObservation,
    },
    v2_pair_fine_execution::V2BoundarySummary,
    AlignmentEvidenceProfileDto, AlignmentEvidenceSampleDto, AudioTimeMapBoundaryStatus,
    AudioTimeMapQualityDto, AudioTimeMapSignalStatus, AudioTimeMapSpanDto, AudioTimeMapSpanKind,
    AudioTimeMapSpanQualityDto, AudioTimeMapSpanSignalsDto, AudioTimeMapSpanSupportStatus,
    ALIGNMENT_V2_FINE_HOP_MS, ALIGNMENT_V2_HELD_OUT_CREDIBILITY_RADIUS_MS,
    ALIGNMENT_V2_HELD_OUT_EVIDENCE_TIME_QUANTUM_MS, ALIGNMENT_V2_HELD_OUT_MIN_UNIQUE_MODE_SUPPORT,
    ALIGNMENT_V2_HELD_OUT_OFFSET_MODE_QUANTUM_MS, ALIGNMENT_V2_LOCAL_HELD_OUT_MIN_ANCHORS,
    ALIGNMENT_V2_LOCAL_HELD_OUT_P95_MAX_MS, ALIGNMENT_V2_LOCAL_HELD_OUT_WINDOW_MS,
    ALIGNMENT_V2_LONG_MEDIA_HELD_OUT_DURATION_MS, ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS,
    ALIGNMENT_V2_MIN_CREDIBLE_HELD_OUT_REGIONS, ALIGNMENT_V2_MIN_LONG_CREDIBLE_HELD_OUT_ANCHORS,
    ALIGNMENT_V2_MIN_SHORT_CREDIBLE_HELD_OUT_ANCHORS,
    ALIGNMENT_V2_SHORT_MEDIA_UNVALIDATED_GAP_DURATION_DIVISOR,
    ALIGNMENT_V2_SHORT_MEDIA_UNVALIDATED_GAP_DURATION_MS, ALIGNMENT_V2_UNVALIDATED_GAP_CEILING_MS,
    ALIGNMENT_V2_UNVALIDATED_GAP_DURATION_DIVISOR, ALIGNMENT_V2_UNVALIDATED_GAP_FLOOR_MS,
};

#[derive(Debug)]
pub(super) struct V2PairOutcomeInput<'a> {
    pub(super) alignment: V2ChunkAlignment,
    pub(super) boundary: V2BoundarySummary,
    pub(super) hypothesis: &'a AffineHypothesis,
    pub(super) use_island_local_residuals: bool,
    pub(super) top1_top2_margin: f64,
    pub(super) minimum_alternative_margin: f64,
}

#[derive(Debug)]
pub(super) struct V2PairOutcomeAssessment {
    pub(super) alignment: V2ChunkAlignment,
    pub(super) boundary: V2BoundarySummary,
    pub(super) source_start_ms: u64,
    pub(super) source_end_ms: u64,
    pub(super) target_start_ms: u64,
    pub(super) target_end_ms: u64,
    pub(super) coverage: f64,
    pub(super) blocked: bool,
    pub(super) catastrophic: bool,
    pub(super) ambiguous_span_count: usize,
    pub(super) compatibility_p95: i64,
    pub(super) time_map_quality: AudioTimeMapQualityDto,
    pub(super) evidence_profile: Option<AlignmentEvidenceProfileDto>,
    pub(super) diagnostics: Vec<String>,
}

pub(super) struct V2BlockedAffineOutcomeInput<'a> {
    pub(super) spans: Vec<AudioTimeMapSpanDto>,
    pub(super) hypothesis: &'a AffineHypothesis,
    pub(super) use_island_local_residuals: bool,
    pub(super) margin: f64,
    pub(super) reason: &'a str,
}

pub(super) struct V2BlockedAffineOutcomeAssessment {
    pub(super) spans: Vec<AudioTimeMapSpanDto>,
    pub(super) coverage: f64,
    pub(super) time_map_quality: AudioTimeMapQualityDto,
    pub(super) diagnostic: String,
}

pub(super) fn evaluate_v2_pair_outcome(input: V2PairOutcomeInput<'_>) -> V2PairOutcomeAssessment {
    let V2PairOutcomeInput {
        mut alignment,
        boundary,
        hypothesis,
        use_island_local_residuals,
        top1_top2_margin,
        minimum_alternative_margin,
    } = input;
    let mut diagnostics = Vec::new();
    let final_anchor_summary = finalize_v2_span_evidence(
        &mut alignment.spans,
        hypothesis,
        use_island_local_residuals,
        top1_top2_margin,
    );
    let source_start_ms = alignment
        .spans
        .first()
        .map(|span| span.source_start_ms)
        .unwrap_or(0);
    let source_end_ms = alignment
        .spans
        .last()
        .map(|span| span.source_end_ms)
        .unwrap_or(source_start_ms);
    let target_start_ms = alignment
        .spans
        .first()
        .map(|span| span.target_start_ms)
        .unwrap_or(0);
    let target_end_ms = alignment
        .spans
        .last()
        .map(|span| span.target_end_ms)
        .unwrap_or(target_start_ms);
    let target_duration_ms = target_end_ms.saturating_sub(target_start_ms).max(1);
    let matched_target_ms = alignment
        .spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Matched)
        .map(|span| span.target_end_ms.saturating_sub(span.target_start_ms))
        .sum::<u64>();
    let target_matched_ratio =
        (matched_target_ms as f64 / target_duration_ms as f64).clamp(0.0, 1.0);
    // A legitimate targetOnly insertion must not lower source mapping coverage. This is the
    // authoritative coverage consumed by proposal confidence and the fine frontier.
    let coverage = v2_matched_source_coverage(&alignment.spans);
    let ambiguous_span_count = alignment
        .spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Ambiguous)
        .count();
    let (
        graph_p50_residual_ms,
        graph_p95_residual_ms,
        graph_p99_residual_ms,
        graph_max_residual_ms,
    ) = v2_residual_statistics(&final_anchor_summary.held_out_residuals);
    let local_validation = v2_final_map_local_validation(
        &alignment.spans,
        &final_anchor_summary.held_out_timed_residuals,
    );
    let local_residual_blocked = local_validation
        .worst_local_p95_residual_ms
        .is_some_and(|value| value > ALIGNMENT_V2_LOCAL_HELD_OUT_P95_MAX_MS);
    let unvalidated_gap_blocked = local_validation.unvalidated_gap_blocked;
    let held_out_validation_coverage = if final_anchor_summary.held_out_credible_count == 0 {
        None
    } else {
        Some(
            final_anchor_summary.held_out_within_tolerance_count as f64
                / final_anchor_summary.held_out_credible_count as f64,
        )
    };
    let credible_held_out_source_times =
        v2_credible_held_out_anchors(hypothesis, use_island_local_residuals)
            .iter()
            .filter_map(|anchor| u64::try_from(anchor.source_time_ms).ok())
            .collect::<Vec<_>>();
    let credible_held_out_region_count = v2_source_time_region_count(
        &credible_held_out_source_times,
        source_start_ms,
        source_end_ms,
    );
    let required_credible_held_out_anchor_count = if source_end_ms.saturating_sub(source_start_ms)
        >= ALIGNMENT_V2_LONG_MEDIA_HELD_OUT_DURATION_MS
    {
        ALIGNMENT_V2_MIN_LONG_CREDIBLE_HELD_OUT_ANCHORS
    } else {
        ALIGNMENT_V2_MIN_SHORT_CREDIBLE_HELD_OUT_ANCHORS
    };
    let credible_held_out_support_sufficient = final_anchor_summary.held_out_credible_count
        >= required_credible_held_out_anchor_count
        && credible_held_out_region_count >= ALIGNMENT_V2_MIN_CREDIBLE_HELD_OUT_REGIONS;
    let ambiguous_held_out_candidate_count = final_anchor_summary
        .held_out_candidate_count
        .saturating_sub(final_anchor_summary.held_out_credible_count);
    let catastrophic = coverage < 0.50
        || !credible_held_out_support_sufficient
        || ambiguous_held_out_candidate_count > 0
        || final_anchor_summary.held_out_unmapped_count > 0
        || final_anchor_summary.training_unmapped_count > 0
        || graph_p95_residual_ms.is_none_or(|value| value > 400)
        || graph_p99_residual_ms.is_none_or(|value| value > 500)
        || graph_max_residual_ms.is_none_or(|value| value > 1_000)
        || held_out_validation_coverage.is_some_and(|value| value < 0.50)
        || local_residual_blocked
        || unvalidated_gap_blocked;
    let blocked_span_count = alignment
        .spans
        .iter()
        .filter(|span| span.quality.level == "blocked")
        .count();
    let blocked = catastrophic
        || blocked_span_count > 0
        || ambiguous_span_count > 0
        || alignment.matched_step_count == 0
        || top1_top2_margin < minimum_alternative_margin
        || boundary.ambiguous_count > 0;
    let quality_level = if blocked { "blocked" } else { "review" };
    let mut quality_reasons = Vec::new();
    if catastrophic {
        quality_reasons.push(format!(
            "灾难性门控：final-map source coverage {:.3}、验证 P95 {:?} ms、P99 {:?} ms、max {:?} ms、留出成功率 {:?}、未映射训练/留出 anchor={}/{}。",
            coverage,
            graph_p95_residual_ms,
            graph_p99_residual_ms,
            graph_max_residual_ms,
            held_out_validation_coverage,
            final_anchor_summary.training_unmapped_count,
            final_anchor_summary.held_out_unmapped_count
        ));
    }
    if final_anchor_summary.held_out_credible_count == 0 {
        quality_reasons.push(
            format!(
                "独立留出集有 {} 个全局内点或局部共识候选，但没有候选通过全局一致性或独立时间点模式共识；拒绝把远距离碰撞当作时间金标准，也拒绝把未形成模式共识的重复内容碰撞计为测量。",
                final_anchor_summary.held_out_candidate_count
            ),
        );
    } else if let Some(validation_coverage) = held_out_validation_coverage {
        quality_reasons.push(format!(
            "独立留出最终图通过率 {:.1}%（{} / {} 个可信 anchor）；全局内点或局部共识候选 {} 个，可信 anchor 覆盖 {}/{} 个时间区域；留出未参与 seed、候选排名或重拟合。",
            validation_coverage * 100.0,
            final_anchor_summary.held_out_within_tolerance_count,
            final_anchor_summary.held_out_credible_count,
            final_anchor_summary.held_out_candidate_count,
            credible_held_out_region_count,
            ALIGNMENT_V2_MIN_CREDIBLE_HELD_OUT_REGIONS
        ));
    }
    if ambiguous_held_out_candidate_count > 0 {
        quality_reasons.push(format!(
            "独立留出证据仍有 {ambiguous_held_out_candidate_count} 个歧义候选：它们既不贴合全局模型，也没有至少 {ALIGNMENT_V2_HELD_OUT_MIN_UNIQUE_MODE_SUPPORT} 个独立 source/target 时间点支持同一偏移模式；保留位置诊断并阻断自动确认。"
        ));
    }
    if !credible_held_out_support_sufficient {
        quality_reasons.push(format!(
            "独立留出支持不足：需要至少 {} 个可信 anchor 且覆盖 {} 个时间区域，实际为 {} 个、{} 个区域。",
            required_credible_held_out_anchor_count,
            ALIGNMENT_V2_MIN_CREDIBLE_HELD_OUT_REGIONS,
            final_anchor_summary.held_out_credible_count,
            credible_held_out_region_count
        ));
    }
    if local_residual_blocked {
        quality_reasons.push(format!(
            "局部留出残差门控失败：重叠 {} ms 时间窗的最坏 P95 为 {:?} ms，高于 {} ms。",
            ALIGNMENT_V2_LOCAL_HELD_OUT_WINDOW_MS,
            local_validation.worst_local_p95_residual_ms,
            ALIGNMENT_V2_LOCAL_HELD_OUT_P95_MAX_MS
        ));
    }
    if unvalidated_gap_blocked {
        quality_reasons.push(format!(
            "留出锚点时间覆盖门控失败：最大无验证锚跨度 {} ms，高于当前 TimeMap 允许的 {} ms。",
            local_validation.max_unvalidated_gap_ms, local_validation.allowed_unvalidated_gap_ms
        ));
    }
    if blocked_span_count > 0 {
        quality_reasons.push(format!(
            "最终分段 TimeMap 有 {blocked_span_count} 个 span 未通过逐段留出残差、边界或支持门控。"
        ));
    }
    if ambiguous_span_count > 0 {
        quality_reasons.push(format!(
            "细对齐包含 {ambiguous_span_count} 个 ambiguous span，不能自动投影。"
        ));
    }
    if alignment.matched_step_count == 0 {
        quality_reasons.push("细对齐没有 matched step。".to_string());
    }
    if top1_top2_margin < minimum_alternative_margin {
        quality_reasons.push(format!(
            "Top1/Top2 margin {:.3} 低于 {:.3}，音轨或重复内容假设仍有歧义。",
            top1_top2_margin, minimum_alternative_margin
        ));
    }
    if boundary.ambiguous_count > 0 {
        quality_reasons.push(format!(
            "{} 个局部边界没有唯一、稳定的相关峰，边界精度仍有歧义。",
            boundary.ambiguous_count
        ));
    }
    if !blocked {
        quality_reasons
            .push("真实媒体冻结集和概率校准尚未完成；该结果最高只能进入人工复核。".to_string());
    }
    diagnostics.push(format!(
        "Alignment V2 输出 {} 个 span（matched steps {}，ambiguous steps {}），final-map 来源覆盖率 {:.1}%，目标 matched 比例 {:.1}%。",
        alignment.spans.len(),
        alignment.matched_step_count,
        alignment.ambiguous_step_count,
        coverage * 100.0,
        target_matched_ratio * 100.0
    ));
    diagnostics.push(format!(
        "Final TimeMap：coarse scale {:.8}，offset {:+} ms，训练 anchor {} 个（最终图可投影 {}，未映射 {}），留出全局内点/局部共识候选 {} 个、可信 anchor {} 个、歧义候选 {} 个（最终图阈值内 {}，未映射 {}，时间区域 {}），可信留出重投影 P50/P95/P99/max={:?}/{:?}/{:?}/{:?} ms。",
        hypothesis.scale,
        hypothesis.offset_ms,
        hypothesis.training_anchors.len(),
        final_anchor_summary.training_residuals.len(),
        final_anchor_summary.training_unmapped_count,
        final_anchor_summary.held_out_candidate_count,
        final_anchor_summary.held_out_credible_count,
        ambiguous_held_out_candidate_count,
        final_anchor_summary.held_out_within_tolerance_count,
        final_anchor_summary.held_out_unmapped_count,
        credible_held_out_region_count,
        graph_p50_residual_ms,
        graph_p95_residual_ms,
        graph_p99_residual_ms,
        graph_max_residual_ms
    ));
    diagnostics.extend(v2_final_map_problem_training_anchor_diagnostics(
        &alignment.spans,
        hypothesis,
    ));
    diagnostics.extend(v2_final_map_held_out_anchor_diagnostics(
        &alignment.spans,
        hypothesis,
        use_island_local_residuals,
    ));
    diagnostics.extend(v2_final_map_ambiguous_span_diagnostics(
        &alignment.spans,
        hypothesis,
        use_island_local_residuals,
    ));
    diagnostics.push(format!(
        "Final TimeMap 局部门控：{} ms 重叠时间窗最坏 P95={:?} ms；最大无验证锚跨度 {}/{} ms（实际/允许）。",
        ALIGNMENT_V2_LOCAL_HELD_OUT_WINDOW_MS,
        local_validation.worst_local_p95_residual_ms,
        local_validation.max_unvalidated_gap_ms,
        local_validation.allowed_unvalidated_gap_ms
    ));
    diagnostics.extend(quality_reasons.clone());
    let compatibility_p95 = graph_p95_residual_ms
        .and_then(|value| i64::try_from(value).ok())
        .unwrap_or(i64::MAX);
    let evidence_profile =
        create_v2_evidence_profile(&alignment.spans, hypothesis, &alignment.fine_evidence);

    let anchor_region_count = v2_anchor_region_count(hypothesis, source_start_ms, source_end_ms);
    let time_map_quality = AudioTimeMapQualityDto {
        level: quality_level,
        metric_source: if final_anchor_summary.held_out_credible_count == 0 {
            "missing"
        } else {
            "measured"
        },
        probability: None,
        coverage: Some(coverage),
        unique_content_coverage: Some(hypothesis.unique_source_coverage.clamp(0.0, 1.0)),
        p50_residual_ms: graph_p50_residual_ms,
        p95_residual_ms: graph_p95_residual_ms,
        p99_residual_ms: graph_p99_residual_ms,
        max_residual_ms: graph_max_residual_ms,
        boundary_uncertainty_ms: boundary.max_uncertainty_ms,
        alternative_margin: Some(top1_top2_margin),
        anchor_count: hypothesis
            .inlier_count
            .saturating_add(hypothesis.held_out_anchors.len()),
        anchor_region_count,
        held_out_anchor_count: hypothesis.held_out_anchors.len(),
        reasons: quality_reasons,
    };
    V2PairOutcomeAssessment {
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
        diagnostics,
    }
}

pub(super) fn evaluate_v2_blocked_affine_outcome(
    input: V2BlockedAffineOutcomeInput<'_>,
) -> V2BlockedAffineOutcomeAssessment {
    let V2BlockedAffineOutcomeInput {
        mut spans,
        hypothesis,
        use_island_local_residuals,
        margin,
        reason,
    } = input;
    let final_anchor_summary =
        finalize_v2_span_evidence(&mut spans, hypothesis, use_island_local_residuals, margin);
    let (p50_residual_ms, p95_residual_ms, p99_residual_ms, max_residual_ms) =
        v2_residual_statistics(&final_anchor_summary.held_out_residuals);
    let coverage = v2_matched_source_coverage(&spans);
    let held_out_validation_coverage = if final_anchor_summary.held_out_credible_count == 0 {
        None
    } else {
        Some(
            final_anchor_summary.held_out_within_tolerance_count as f64
                / final_anchor_summary.held_out_credible_count as f64,
        )
    };
    let source_start_ms = spans.first().map(|span| span.source_start_ms).unwrap_or(0);
    let source_end_ms = spans
        .last()
        .map(|span| span.source_end_ms)
        .unwrap_or(source_start_ms);
    let anchor_region_count = v2_anchor_region_count(hypothesis, source_start_ms, source_end_ms);
    let mut blocked_reasons = vec![reason.to_string()];
    if final_anchor_summary.held_out_credible_count == 0 {
        blocked_reasons.push(format!(
            "{} 个独立留出全局内点或局部共识候选均未进入有界 edit-recovery 范围，不能作为时间金标准。",
            final_anchor_summary.held_out_candidate_count
        ));
    } else if let Some(validation_coverage) = held_out_validation_coverage {
        blocked_reasons.push(format!(
            "可信独立留出最终图通过率 {:.1}%（{} / {} 个）。",
            validation_coverage * 100.0,
            final_anchor_summary.held_out_within_tolerance_count,
            final_anchor_summary.held_out_credible_count
        ));
    }
    blocked_reasons.push(format!(
        "最终阻断 TimeMap 未映射训练/留出 anchor={}/{}；残差与覆盖率不会回退 coarse affine 结果。",
        final_anchor_summary.training_unmapped_count, final_anchor_summary.held_out_unmapped_count
    ));
    let diagnostic = format!(
        "Final blocked TimeMap：source coverage {:.1}%，训练 anchor {} 个（最终图可投影 {}，未映射 {}），留出全局内点/局部共识候选 {} 个、可信 anchor {} 个（最终图阈值内 {}，未映射 {}），可信留出重投影 P50/P95/P99/max={:?}/{:?}/{:?}/{:?} ms；未使用 coarse residual fallback。",
        coverage * 100.0,
        hypothesis.training_anchors.len(),
        final_anchor_summary.training_residuals.len(),
        final_anchor_summary.training_unmapped_count,
        final_anchor_summary.held_out_candidate_count,
        final_anchor_summary.held_out_credible_count,
        final_anchor_summary.held_out_within_tolerance_count,
        final_anchor_summary.held_out_unmapped_count,
        p50_residual_ms,
        p95_residual_ms,
        p99_residual_ms,
        max_residual_ms
    );
    V2BlockedAffineOutcomeAssessment {
        spans,
        coverage,
        time_map_quality: AudioTimeMapQualityDto {
            level: "blocked",
            metric_source: if final_anchor_summary.held_out_credible_count == 0 {
                "missing"
            } else {
                "measured"
            },
            probability: None,
            coverage: Some(coverage),
            unique_content_coverage: Some(coverage),
            p50_residual_ms,
            p95_residual_ms,
            p99_residual_ms,
            max_residual_ms,
            boundary_uncertainty_ms: None,
            alternative_margin: Some(margin),
            anchor_count: hypothesis
                .inlier_count
                .saturating_add(hypothesis.held_out_anchors.len()),
            anchor_region_count,
            held_out_anchor_count: hypothesis.held_out_anchors.len(),
            reasons: blocked_reasons,
        },
        diagnostic,
    }
}

fn finalize_v2_span_evidence(
    spans: &mut [AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
    alternative_margin: f64,
) -> V2FinalMapAnchorSummary {
    let final_summary =
        v2_recompute_final_map_anchor_summary(spans, hypothesis, use_island_local_residuals);
    let (credible_held_out_anchors, ambiguous_held_out_anchors) =
        v2_partition_held_out_anchors(hypothesis, use_island_local_residuals);
    for (index, span) in spans.iter_mut().enumerate() {
        span.id = format!(
            "span-{}-{}-{}-{}-{}-{}",
            index + 1,
            format_v2_span_kind(span.kind),
            span.source_start_ms,
            span.source_end_ms,
            span.target_start_ms,
            span.target_end_ms
        );
        let training = v2_anchors_in_source_span(&hypothesis.training_anchors, span);
        let held_out = v2_anchors_in_source_span(&credible_held_out_anchors, span);
        let ambiguous_held_out = v2_anchors_in_source_span(&ambiguous_held_out_anchors, span);
        let training_residuals = training
            .iter()
            .filter_map(|item| v2_final_map_anchor_residual(std::slice::from_ref(&*span), item))
            .collect::<Vec<_>>();
        let residuals = held_out
            .iter()
            .filter_map(|item| v2_final_map_anchor_residual(std::slice::from_ref(&*span), item))
            .collect::<Vec<_>>();
        let held_out_unmapped_count = held_out.len().saturating_sub(residuals.len());
        let training_unmapped_count = training.len().saturating_sub(training_residuals.len());
        let (p50_residual_ms, p95_residual_ms, p99_residual_ms, max_residual_ms) =
            v2_residual_statistics(&residuals);
        let validation_coverage = if held_out.is_empty() {
            None
        } else {
            Some(
                residuals
                    .iter()
                    .filter(|residual| {
                        **residual <= v2_affine_match_config().residual_tolerance_ms as u64
                    })
                    .count() as f64
                    / held_out.len() as f64,
            )
        };
        let temporal_coverage = v2_anchor_temporal_coverage(&training, span);
        let left_support = v2_span_side_support(span, &training, true);
        let right_support = v2_span_side_support(span, &training, false);
        let boundary_uncertainty_ms = [&span.boundaries.start, &span.boundaries.end]
            .into_iter()
            .filter_map(|boundary| {
                Some(
                    boundary
                        .uncertainty_end_ms?
                        .saturating_sub(boundary.uncertainty_start_ms?),
                )
            })
            .max();
        let boundary_conflict = [span.boundaries.start.status, span.boundaries.end.status]
            .into_iter()
            .any(|status| status == AudioTimeMapBoundaryStatus::Ambiguous);
        let boundary_blocked = is_v2_edit_span(span.kind)
            && [&span.boundaries.start, &span.boundaries.end]
                .into_iter()
                .any(|boundary| {
                    boundary.status != AudioTimeMapBoundaryStatus::Refined
                        || boundary.support_duration_ms == 0
                });
        let no_independent_validation =
            span.kind == AudioTimeMapSpanKind::Matched && held_out.is_empty();
        let no_training_support = span.kind == AudioTimeMapSpanKind::Matched && training.is_empty();
        let anchors_in_unmapped_span = span.kind != AudioTimeMapSpanKind::Matched
            && (!training.is_empty() || !held_out.is_empty() || !ambiguous_held_out.is_empty());
        let ambiguous_held_out_evidence = !ambiguous_held_out.is_empty();
        let final_residual_blocked = span.kind == AudioTimeMapSpanKind::Matched
            && (held_out_unmapped_count > 0
                || training_unmapped_count > 0
                || validation_coverage.is_some_and(|value| value < 0.50)
                || p95_residual_ms.is_some_and(|value| value > 400)
                || p99_residual_ms.is_some_and(|value| value > 500)
                || max_residual_ms.is_some_and(|value| value > 1_000));
        let blocked = span.kind == AudioTimeMapSpanKind::Ambiguous
            || boundary_conflict
            || boundary_blocked
            || no_training_support
            || no_independent_validation
            || ambiguous_held_out_evidence
            || anchors_in_unmapped_span
            || final_residual_blocked;
        let mut reasons = vec![span.reason.clone()];
        if no_independent_validation {
            reasons
                .push("该 span 没有不参与 seed、模型选择和重拟合的独立留出 anchor。".to_string());
        } else if let Some(coverage) = validation_coverage {
            reasons.push(format!(
                "该 span 的独立留出 anchor 阈值内覆盖率为 {:.1}%（{} 个）。",
                coverage * 100.0,
                held_out.len()
            ));
        }
        if held_out_unmapped_count > 0 || training_unmapped_count > 0 {
            reasons.push(format!(
                "最终分段 TimeMap 无法投影该 span 的 {} 个留出 anchor 和 {} 个训练 anchor；这些观测已计为失败而非被丢弃。",
                held_out_unmapped_count, training_unmapped_count
            ));
        }
        if anchors_in_unmapped_span {
            reasons.push(format!(
                "最终分段 TimeMap 将含 {} 个真实 anchor 的范围分类为不可投影内容，必须阻断复核。",
                training
                    .len()
                    .saturating_add(held_out.len())
                    .saturating_add(ambiguous_held_out.len())
            ));
        }
        if ambiguous_held_out_evidence {
            reasons.push(format!(
                "该 span 含 {} 个未获得独立偏移模式共识的歧义留出候选；保留位置证据并阻断自动确认。",
                ambiguous_held_out.len()
            ));
        }
        if final_residual_blocked {
            reasons.push(format!(
                "最终分段 TimeMap 重投影残差未通过门控：P95/P99/max={:?}/{:?}/{:?} ms。",
                p95_residual_ms, p99_residual_ms, max_residual_ms
            ));
        }
        if no_training_support {
            reasons.push("该 matched span 范围内没有真实训练 anchor 支持。".to_string());
        }
        if boundary_blocked {
            reasons.push("版本差异 span 至少一侧缺少可靠的单侧共同音频边界证据。".to_string());
        }
        if boundary_conflict {
            reasons.push("局部边界存在竞争相关峰，不能唯一定位。".to_string());
        }
        let final_graph_coverage = if span.kind == AudioTimeMapSpanKind::Matched {
            validation_coverage.or(temporal_coverage)
        } else {
            Some(0.0)
        };
        let final_graph_unique_content_coverage = if span.kind == AudioTimeMapSpanKind::Matched {
            temporal_coverage
        } else {
            Some(0.0)
        };
        span.quality = AudioTimeMapSpanQualityDto {
            level: if blocked { "blocked" } else { "review" },
            metric_source: if held_out.is_empty() {
                "missing"
            } else {
                "measured"
            },
            probability: None,
            coverage: final_graph_coverage,
            unique_content_coverage: final_graph_unique_content_coverage,
            alternative_margin: Some(alternative_margin),
            anchor_count: training.len().saturating_add(held_out.len()),
            held_out_anchor_count: held_out.len(),
            p50_residual_ms,
            p95_residual_ms,
            p99_residual_ms,
            max_residual_ms,
            boundary_uncertainty_ms,
            left_support,
            right_support,
            signals: AudioTimeMapSpanSignalsDto {
                audio: if boundary_conflict || span.kind == AudioTimeMapSpanKind::Ambiguous {
                    AudioTimeMapSignalStatus::Conflict
                } else if blocked {
                    AudioTimeMapSignalStatus::Blocked
                } else {
                    AudioTimeMapSignalStatus::Used
                },
                visual: AudioTimeMapSignalStatus::Blocked,
                danmaku: AudioTimeMapSignalStatus::Blocked,
            },
            reasons,
        };
    }
    final_summary
}

#[derive(Debug, Clone, Copy)]
struct V2TimedAnchorResidual {
    source_time_ms: u64,
    residual_ms: u64,
}

#[derive(Debug, Clone, Copy)]
struct V2FinalMapLocalValidation {
    worst_local_p95_residual_ms: Option<u64>,
    max_unvalidated_gap_ms: u64,
    allowed_unvalidated_gap_ms: u64,
    unvalidated_gap_blocked: bool,
}

#[derive(Debug, Default)]
struct V2FinalMapAnchorSummary {
    training_residuals: Vec<u64>,
    held_out_residuals: Vec<u64>,
    held_out_timed_residuals: Vec<V2TimedAnchorResidual>,
    training_unmapped_count: usize,
    held_out_unmapped_count: usize,
    held_out_within_tolerance_count: usize,
    held_out_candidate_count: usize,
    held_out_credible_count: usize,
}

#[derive(Debug)]
struct V2ResidualRankIndex {
    tree: Vec<usize>,
}

impl V2ResidualRankIndex {
    fn new(coordinate_count: usize) -> Self {
        Self {
            tree: vec![0; coordinate_count.saturating_add(1)],
        }
    }

    fn insert(&mut self, coordinate: usize) {
        self.update(coordinate, true);
    }

    fn remove(&mut self, coordinate: usize) {
        self.update(coordinate, false);
    }

    fn update(&mut self, coordinate: usize, insert: bool) {
        let mut index = coordinate.saturating_add(1);
        while index < self.tree.len() {
            if insert {
                self.tree[index] = self.tree[index].saturating_add(1);
            } else {
                debug_assert!(self.tree[index] > 0);
                self.tree[index] = self.tree[index].saturating_sub(1);
            }
            index = index.saturating_add(index & (!index + 1));
        }
    }

    fn coordinate_at_rank(&self, mut rank: usize) -> Option<usize> {
        let coordinate_count = self.tree.len().checked_sub(1)?;
        if coordinate_count == 0 || rank == 0 {
            return None;
        }
        let mut bit = 1_usize;
        while bit <= coordinate_count / 2 {
            bit *= 2;
        }
        let mut index = 0_usize;
        while bit > 0 {
            let next = index.saturating_add(bit);
            if next <= coordinate_count && self.tree[next] < rank {
                rank -= self.tree[next];
                index = next;
            }
            bit /= 2;
        }
        (index < coordinate_count).then_some(index)
    }
}

fn v2_recompute_final_map_anchor_summary(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> V2FinalMapAnchorSummary {
    let training_residuals = hypothesis
        .training_anchors
        .iter()
        .filter_map(|anchor| v2_final_map_anchor_residual(spans, anchor))
        .collect::<Vec<_>>();
    let credible_held_out_anchors =
        v2_credible_held_out_anchors(hypothesis, use_island_local_residuals);
    let held_out_timed_residuals = credible_held_out_anchors
        .iter()
        .filter_map(|anchor| {
            Some(V2TimedAnchorResidual {
                source_time_ms: u64::try_from(anchor.source_time_ms).ok()?,
                residual_ms: v2_final_map_anchor_residual(spans, anchor)?,
            })
        })
        .collect::<Vec<_>>();
    let held_out_residuals = held_out_timed_residuals
        .iter()
        .map(|anchor| anchor.residual_ms)
        .collect::<Vec<_>>();
    let held_out_within_tolerance_count = held_out_residuals
        .iter()
        .filter(|residual| **residual <= v2_affine_match_config().residual_tolerance_ms as u64)
        .count();
    V2FinalMapAnchorSummary {
        training_unmapped_count: hypothesis
            .training_anchors
            .len()
            .saturating_sub(training_residuals.len()),
        held_out_unmapped_count: credible_held_out_anchors
            .len()
            .saturating_sub(held_out_residuals.len()),
        training_residuals,
        held_out_residuals,
        held_out_timed_residuals,
        held_out_within_tolerance_count,
        held_out_candidate_count: hypothesis.held_out_anchors.len(),
        held_out_credible_count: credible_held_out_anchors.len(),
    }
}

fn v2_allowed_unvalidated_gap_ms(source_duration_ms: u64, held_out_time_block_count: usize) -> u64 {
    let duration_divisor =
        if source_duration_ms <= ALIGNMENT_V2_SHORT_MEDIA_UNVALIDATED_GAP_DURATION_MS {
            ALIGNMENT_V2_SHORT_MEDIA_UNVALIDATED_GAP_DURATION_DIVISOR
        } else {
            ALIGNMENT_V2_UNVALIDATED_GAP_DURATION_DIVISOR
        };
    let bounded_gap_ms = source_duration_ms.div_ceil(duration_divisor).clamp(
        ALIGNMENT_V2_UNVALIDATED_GAP_FLOOR_MS,
        ALIGNMENT_V2_UNVALIDATED_GAP_CEILING_MS,
    );
    let sampling_capacity = u64::try_from(held_out_time_block_count)
        .unwrap_or(u64::MAX)
        .max(1);
    let capacity_floor_ms = source_duration_ms.div_ceil(sampling_capacity);
    bounded_gap_ms
        .max(capacity_floor_ms)
        .min(source_duration_ms)
}

fn v2_distinct_holdout_time_block_count(held_out: &[V2TimedAnchorResidual]) -> usize {
    let block_width_ms = u64::try_from(AFFINE_HOLDOUT_TIME_BLOCK_MS)
        .expect("affine holdout time blocks must use a positive millisecond width");
    let mut previous_block = None::<u64>;
    let mut block_count = 0_usize;
    for anchor in held_out {
        let block = anchor.source_time_ms.div_euclid(block_width_ms);
        if previous_block != Some(block) {
            block_count = block_count.saturating_add(1);
            previous_block = Some(block);
        }
    }
    block_count
}

fn v2_max_unvalidated_gap_ms(
    held_out: &[V2TimedAnchorResidual],
    source_start_ms: u64,
    source_end_ms: u64,
) -> u64 {
    let mut previous_time_ms = source_start_ms;
    let mut max_unvalidated_gap_ms = 0;
    for source_time_ms in held_out.iter().map(|anchor| anchor.source_time_ms) {
        if source_time_ms == previous_time_ms {
            continue;
        }
        max_unvalidated_gap_ms =
            max_unvalidated_gap_ms.max(source_time_ms.saturating_sub(previous_time_ms));
        previous_time_ms = source_time_ms;
    }
    max_unvalidated_gap_ms.max(source_end_ms.saturating_sub(previous_time_ms))
}

fn v2_active_window_local_p95(
    anchors: &[V2TimedAnchorResidual],
    active_indices: &BTreeSet<usize>,
    residual_values: &[u64],
    residual_rank_index: &V2ResidualRankIndex,
) -> Option<u64> {
    if active_indices.len() >= ALIGNMENT_V2_LOCAL_HELD_OUT_MIN_ANCHORS {
        let zero_based_index = active_indices
            .len()
            .saturating_sub(1)
            .saturating_mul(95)
            .div_ceil(100);
        let coordinate = residual_rank_index.coordinate_at_rank(zero_based_index + 1)?;
        return residual_values.get(coordinate).copied();
    }
    let active_index = active_indices.first().copied()?;
    let active_anchor = anchors.get(active_index)?;
    let mut nearest = None::<(u64, u64)>;
    for neighbor_index in [
        active_index.checked_sub(1),
        active_index
            .checked_add(1)
            .filter(|index| *index < anchors.len()),
    ]
    .into_iter()
    .flatten()
    {
        let neighbor = anchors.get(neighbor_index)?;
        let candidate = (
            active_anchor
                .source_time_ms
                .abs_diff(neighbor.source_time_ms),
            neighbor.residual_ms,
        );
        if nearest.is_none_or(|best| {
            candidate.0 < best.0 || (candidate.0 == best.0 && candidate.1 > best.1)
        }) {
            nearest = Some(candidate);
        }
    }
    Some(
        nearest
            .map(|(_, residual_ms)| active_anchor.residual_ms.max(residual_ms))
            .unwrap_or(active_anchor.residual_ms),
    )
}

fn v2_worst_sliding_local_p95(held_out: &[V2TimedAnchorResidual]) -> Option<u64> {
    if held_out.is_empty() {
        return None;
    }
    let mut anchors = held_out.to_vec();
    anchors.sort_unstable_by_key(|anchor| (anchor.source_time_ms, anchor.residual_ms));
    let mut residual_values = anchors
        .iter()
        .map(|anchor| anchor.residual_ms)
        .collect::<Vec<_>>();
    residual_values.sort_unstable();
    residual_values.dedup();
    let residual_coordinates = anchors
        .iter()
        .map(|anchor| {
            residual_values
                .binary_search(&anchor.residual_ms)
                .expect("a compressed residual must retain every anchor value")
        })
        .collect::<Vec<_>>();

    // For a closed window [start, start + width], an anchor enters the active set at
    // source_time-width and leaves immediately after source_time. Sweeping both event boundaries
    // enumerates every distinct membership set of a truly sliding window without quadratic scans.
    let mut events = Vec::<(i128, u8, usize)>::with_capacity(anchors.len().saturating_mul(2));
    for (index, anchor) in anchors.iter().enumerate() {
        let source_time_ms = i128::from(anchor.source_time_ms);
        events.push((
            source_time_ms - i128::from(ALIGNMENT_V2_LOCAL_HELD_OUT_WINDOW_MS),
            0,
            index,
        ));
        events.push((source_time_ms, 1, index));
    }
    events.sort_unstable();

    let mut active_indices = BTreeSet::<usize>::new();
    let mut residual_rank_index = V2ResidualRankIndex::new(residual_values.len());
    let mut worst_local_p95_residual_ms = None::<u64>;
    let mut cursor = 0_usize;
    while cursor < events.len() {
        let position = events[cursor].0;
        let mut group_end = cursor + 1;
        while group_end < events.len() && events[group_end].0 == position {
            group_end += 1;
        }
        for &(_, event_kind, anchor_index) in &events[cursor..group_end] {
            if event_kind == 0 && active_indices.insert(anchor_index) {
                residual_rank_index.insert(residual_coordinates[anchor_index]);
            }
        }
        if let Some(candidate) = v2_active_window_local_p95(
            &anchors,
            &active_indices,
            &residual_values,
            &residual_rank_index,
        ) {
            worst_local_p95_residual_ms =
                Some(worst_local_p95_residual_ms.map_or(candidate, |worst| worst.max(candidate)));
        }
        for &(_, event_kind, anchor_index) in &events[cursor..group_end] {
            if event_kind == 1 && active_indices.remove(&anchor_index) {
                residual_rank_index.remove(residual_coordinates[anchor_index]);
            }
        }
        if let Some(candidate) = v2_active_window_local_p95(
            &anchors,
            &active_indices,
            &residual_values,
            &residual_rank_index,
        ) {
            worst_local_p95_residual_ms =
                Some(worst_local_p95_residual_ms.map_or(candidate, |worst| worst.max(candidate)));
        }
        cursor = group_end;
    }
    worst_local_p95_residual_ms
}

fn v2_final_map_local_validation(
    spans: &[AudioTimeMapSpanDto],
    held_out: &[V2TimedAnchorResidual],
) -> V2FinalMapLocalValidation {
    let mut ordered_held_out = held_out.to_vec();
    ordered_held_out.sort_unstable_by_key(|anchor| (anchor.source_time_ms, anchor.residual_ms));
    let mut worst_local_p95_residual_ms = None::<u64>;
    let mut diagnostic_gap = None::<(u64, u64)>;
    let mut unvalidated_gap_blocked = false;

    for span in spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Matched)
    {
        let held_out_start =
            ordered_held_out.partition_point(|anchor| anchor.source_time_ms < span.source_start_ms);
        let held_out_end =
            ordered_held_out.partition_point(|anchor| anchor.source_time_ms < span.source_end_ms);
        let span_held_out = &ordered_held_out[held_out_start..held_out_end];
        let source_duration_ms = span.source_end_ms.saturating_sub(span.source_start_ms);
        let held_out_time_block_count = v2_distinct_holdout_time_block_count(span_held_out);
        let allowed_gap_ms =
            v2_allowed_unvalidated_gap_ms(source_duration_ms, held_out_time_block_count);
        let max_gap_ms =
            v2_max_unvalidated_gap_ms(span_held_out, span.source_start_ms, span.source_end_ms);
        let span_gap_blocked = max_gap_ms > allowed_gap_ms;
        if span_gap_blocked {
            if !unvalidated_gap_blocked
                || diagnostic_gap.is_none_or(|(reported_gap_ms, reported_allowed_ms)| {
                    max_gap_ms > reported_gap_ms
                        || (max_gap_ms == reported_gap_ms && allowed_gap_ms < reported_allowed_ms)
                })
            {
                diagnostic_gap = Some((max_gap_ms, allowed_gap_ms));
            }
            unvalidated_gap_blocked = true;
        } else if !unvalidated_gap_blocked
            && diagnostic_gap.is_none_or(|(reported_gap_ms, _)| max_gap_ms > reported_gap_ms)
        {
            diagnostic_gap = Some((max_gap_ms, allowed_gap_ms));
        }

        if let Some(candidate) = v2_worst_sliding_local_p95(span_held_out) {
            worst_local_p95_residual_ms =
                Some(worst_local_p95_residual_ms.map_or(candidate, |worst| worst.max(candidate)));
        }
    }

    let (max_unvalidated_gap_ms, allowed_unvalidated_gap_ms) = diagnostic_gap.unwrap_or((0, 0));

    V2FinalMapLocalValidation {
        worst_local_p95_residual_ms,
        max_unvalidated_gap_ms,
        allowed_unvalidated_gap_ms,
        unvalidated_gap_blocked,
    }
}

fn v2_final_map_anchor_residual(
    spans: &[AudioTimeMapSpanDto],
    anchor: &AffineAnchorEvidence,
) -> Option<u64> {
    let source_ms = u64::try_from(anchor.source_time_ms).ok()?;
    let expected_target_ms = u64::try_from(anchor.target_time_ms).ok()?;
    let matched = spans.iter().find(|span| {
        span.kind == AudioTimeMapSpanKind::Matched
            && source_ms >= span.source_start_ms
            && source_ms < span.source_end_ms
    })?;
    let source_duration_ms = matched.source_end_ms.checked_sub(matched.source_start_ms)?;
    let target_duration_ms = matched.target_end_ms.checked_sub(matched.target_start_ms)?;
    if source_duration_ms == 0 || target_duration_ms == 0 {
        return None;
    }
    let source_delta_ms = source_ms.checked_sub(matched.source_start_ms)?;
    let scaled_delta = u128::from(source_delta_ms)
        .checked_mul(u128::from(target_duration_ms))?
        .checked_add(u128::from(source_duration_ms / 2))?
        / u128::from(source_duration_ms);
    let mapped_target_ms = u128::from(matched.target_start_ms).checked_add(scaled_delta)?;
    let mapped_target_ms = u64::try_from(mapped_target_ms).ok()?;
    // Keep validation bit-for-bit aligned with export_files::map_signed_source_time: spans are
    // half-open, so rounded interpolation may never escape to target_end_ms.
    let mapped_target_ms = mapped_target_ms.min(matched.target_end_ms.checked_sub(1)?);
    Some(mapped_target_ms.abs_diff(expected_target_ms))
}

fn v2_credible_held_out_anchors(
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> Vec<AffineAnchorEvidence> {
    v2_partition_held_out_anchors(hypothesis, use_island_local_residuals).0
}

fn v2_partition_held_out_anchors(
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> (Vec<AffineAnchorEvidence>, Vec<AffineAnchorEvidence>) {
    #[derive(Default)]
    struct OffsetModeSupport {
        source_times: HashSet<i64>,
        target_times: HashSet<i64>,
    }

    let residual_tolerance_ms = v2_affine_match_config()
        .residual_tolerance_ms
        .unsigned_abs();
    let signed_residual = |anchor: &AffineAnchorEvidence| {
        if use_island_local_residuals {
            // Piecewise approximate evidence is explicitly marked by its candidate. Each item
            // stores a residual against its own content island; the hypothesis scalar offset is
            // only the first island's bootstrap.
            Some(anchor.residual_ms)
        } else {
            // Ordinary affine evidence must always be rechecked from immutable coordinates.
            // Do not trust a stale or forged residual field to turn a far collision into gold.
            let predicted_target_ms =
                hypothesis.scale * anchor.source_time_ms as f64 + hypothesis.offset_ms as f64;
            predicted_target_ms
                .is_finite()
                .then(|| (anchor.target_time_ms as f64 - predicted_target_ms).round() as i64)
        }
    };
    let mut mode_support = HashMap::<i64, OffsetModeSupport>::new();
    for anchor in &hypothesis.held_out_anchors {
        let Some(residual_ms) = signed_residual(anchor) else {
            continue;
        };
        if residual_ms.unsigned_abs() > ALIGNMENT_V2_HELD_OUT_CREDIBILITY_RADIUS_MS {
            continue;
        }
        let support = mode_support
            .entry(residual_ms.div_euclid(ALIGNMENT_V2_HELD_OUT_OFFSET_MODE_QUANTUM_MS))
            .or_default();
        support.source_times.insert(
            anchor
                .source_time_ms
                .div_euclid(ALIGNMENT_V2_HELD_OUT_EVIDENCE_TIME_QUANTUM_MS),
        );
        support.target_times.insert(
            anchor
                .target_time_ms
                .div_euclid(ALIGNMENT_V2_HELD_OUT_EVIDENCE_TIME_QUANTUM_MS),
        );
    }

    let mut credible = Vec::new();
    let mut ambiguous = Vec::new();
    for anchor in &hypothesis.held_out_anchors {
        let Some(residual_ms) = signed_residual(anchor) else {
            ambiguous.push(anchor.clone());
            continue;
        };
        let globally_consistent = residual_ms.unsigned_abs() <= residual_tolerance_ms;
        let mode_supported = if globally_consistent
            || residual_ms.unsigned_abs() > ALIGNMENT_V2_HELD_OUT_CREDIBILITY_RADIUS_MS
        {
            globally_consistent
        } else {
            let offset_bucket =
                residual_ms.div_euclid(ALIGNMENT_V2_HELD_OUT_OFFSET_MODE_QUANTUM_MS);
            let mut source_times = HashSet::<i64>::new();
            let mut target_times = HashSet::<i64>::new();
            for adjacent_bucket in (offset_bucket - 1)..=(offset_bucket + 1) {
                if let Some(support) = mode_support.get(&adjacent_bucket) {
                    source_times.extend(&support.source_times);
                    target_times.extend(&support.target_times);
                }
            }
            source_times.len() >= ALIGNMENT_V2_HELD_OUT_MIN_UNIQUE_MODE_SUPPORT
                && target_times.len() >= ALIGNMENT_V2_HELD_OUT_MIN_UNIQUE_MODE_SUPPORT
        };
        if globally_consistent || mode_supported {
            credible.push(anchor.clone());
        } else {
            ambiguous.push(anchor.clone());
        }
    }
    (credible, ambiguous)
}

fn v2_final_map_held_out_anchor_diagnostics(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> Vec<String> {
    let (credible, ambiguous) =
        v2_partition_held_out_anchors(hypothesis, use_island_local_residuals);
    let mut anchors = credible
        .into_iter()
        .map(|anchor| (anchor, true))
        .chain(ambiguous.into_iter().map(|anchor| (anchor, false)))
        .collect::<Vec<_>>();
    anchors.sort_by(|(left, _), (right, _)| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.target_time_ms.cmp(&right.target_time_ms))
    });
    let omitted_count = anchors
        .len()
        .saturating_sub(ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS);
    let residual_tolerance_ms = v2_affine_match_config()
        .residual_tolerance_ms
        .unsigned_abs();
    let mut diagnostics = anchors
        .into_iter()
        .take(ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS)
        .enumerate()
        .map(|(index, (anchor, credible))| {
            let hypothesis_residual_ms = anchor.residual_ms;
            let matched_span = u64::try_from(anchor.source_time_ms).ok().and_then(|source_ms| {
                spans.iter().find(|span| {
                    span.kind == AudioTimeMapSpanKind::Matched
                        && source_ms >= span.source_start_ms
                        && source_ms < span.source_end_ms
                })
            });
            let final_residual_ms = v2_final_map_anchor_residual(spans, &anchor);
            let final_result = match final_residual_ms {
                Some(residual_ms) if residual_ms <= residual_tolerance_ms => {
                    format!("{} ms（通过）", residual_ms)
                }
                Some(residual_ms) => format!("{} ms（超阈值）", residual_ms),
                None => "未映射（阻断）".to_string(),
            };
            let evidence_label = if credible {
                "可信留出 anchor"
            } else {
                "歧义留出候选"
            };
            format!(
                "Final TimeMap {} #{}：source={} ms，target={} ms，hypothesisResidual={:+} ms，finalResidual={}，span={}。",
                evidence_label,
                index + 1,
                anchor.source_time_ms,
                anchor.target_time_ms,
                hypothesis_residual_ms,
                final_result,
                matched_span.map_or("none", |span| span.id.as_str())
            )
        })
        .collect::<Vec<_>>();
    if omitted_count > 0 {
        diagnostics.push(format!(
            "Final TimeMap 留出 anchor 追踪已限长；另有 {omitted_count} 个候选未逐条展开。"
        ));
    }
    diagnostics
}

fn v2_final_map_problem_training_anchor_diagnostics(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
) -> Vec<String> {
    let residual_tolerance_ms = v2_affine_match_config()
        .residual_tolerance_ms
        .unsigned_abs();
    let mut anchors = hypothesis
        .training_anchors
        .iter()
        .filter_map(|anchor| {
            let final_residual_ms = v2_final_map_anchor_residual(spans, anchor);
            if final_residual_ms.is_some_and(|residual_ms| residual_ms <= residual_tolerance_ms) {
                None
            } else {
                Some((anchor, final_residual_ms))
            }
        })
        .collect::<Vec<_>>();
    anchors.sort_by(|(left, _), (right, _)| {
        left.source_time_ms
            .cmp(&right.source_time_ms)
            .then_with(|| left.target_time_ms.cmp(&right.target_time_ms))
    });
    let omitted_count = anchors
        .len()
        .saturating_sub(ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS);
    let mut diagnostics = anchors
        .into_iter()
        .take(ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS)
        .enumerate()
        .map(|(index, (anchor, final_residual_ms))| {
            let hypothesis_residual_ms = anchor.residual_ms;
            let final_result = final_residual_ms.map_or_else(
                || "未映射（阻断）".to_string(),
                |residual_ms| format!("{residual_ms} ms（超阈值）"),
            );
            format!(
                "Final TimeMap 问题训练 anchor #{}：source={} ms，target={} ms，hypothesisResidual={:+} ms，finalResidual={}。",
                index + 1,
                anchor.source_time_ms,
                anchor.target_time_ms,
                hypothesis_residual_ms,
                final_result
            )
        })
        .collect::<Vec<_>>();
    if omitted_count > 0 {
        diagnostics.push(format!(
            "Final TimeMap 问题训练 anchor 追踪已限长；另有 {omitted_count} 个问题 anchor 未逐条展开。"
        ));
    }
    diagnostics
}

fn v2_final_map_ambiguous_span_diagnostics(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> Vec<String> {
    let credible_held_out_anchors =
        v2_credible_held_out_anchors(hypothesis, use_island_local_residuals);
    let ambiguous_spans = spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Ambiguous)
        .collect::<Vec<_>>();
    let omitted_count = ambiguous_spans
        .len()
        .saturating_sub(ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS);
    let mut diagnostics = ambiguous_spans
        .into_iter()
        .take(ALIGNMENT_V2_MAX_HELD_OUT_TRACE_ITEMS)
        .enumerate()
        .map(|(index, span)| {
            let training_count = hypothesis
                .training_anchors
                .iter()
                .filter(|anchor| v2_anchor_inside_span(anchor, span))
                .count();
            let held_out_count = credible_held_out_anchors
                .iter()
                .filter(|anchor| v2_anchor_inside_span(anchor, span))
                .count();
            format!(
                "Final TimeMap ambiguous span #{}：source=[{}, {}) ms，target=[{}, {}) ms，内部训练 anchor={}，内部可信留出 anchor={}。",
                index + 1,
                span.source_start_ms,
                span.source_end_ms,
                span.target_start_ms,
                span.target_end_ms,
                training_count,
                held_out_count
            )
        })
        .collect::<Vec<_>>();
    if omitted_count > 0 {
        diagnostics.push(format!(
            "Final TimeMap ambiguous span 追踪已限长；另有 {omitted_count} 个区间未逐条展开。"
        ));
    }
    diagnostics
}

fn v2_anchor_inside_span(anchor: &AffineAnchorEvidence, span: &AudioTimeMapSpanDto) -> bool {
    let (Ok(source_ms), Ok(target_ms)) = (
        u64::try_from(anchor.source_time_ms),
        u64::try_from(anchor.target_time_ms),
    ) else {
        return false;
    };
    source_ms >= span.source_start_ms
        && source_ms < span.source_end_ms
        && target_ms >= span.target_start_ms
        && target_ms < span.target_end_ms
}

fn v2_anchors_in_source_span<'a>(
    anchors: &'a [AffineAnchorEvidence],
    span: &AudioTimeMapSpanDto,
) -> Vec<&'a AffineAnchorEvidence> {
    if span.source_end_ms <= span.source_start_ms {
        return Vec::new();
    }
    anchors
        .iter()
        .filter(|anchor| {
            let Ok(source_ms) = u64::try_from(anchor.source_time_ms) else {
                return false;
            };
            source_ms >= span.source_start_ms && source_ms < span.source_end_ms
        })
        .collect()
}

fn v2_anchor_temporal_coverage(
    anchors: &[&AffineAnchorEvidence],
    span: &AudioTimeMapSpanDto,
) -> Option<f64> {
    let duration = span.source_end_ms.saturating_sub(span.source_start_ms);
    if anchors.is_empty() || duration == 0 {
        return None;
    }
    let minimum = anchors.iter().map(|item| item.source_time_ms).min()?;
    let maximum = anchors.iter().map(|item| item.source_time_ms).max()?;
    Some(((maximum - minimum).max(0) as f64 / duration as f64).clamp(0.0, 1.0))
}

fn v2_span_side_support(
    span: &AudioTimeMapSpanDto,
    training: &[&AffineAnchorEvidence],
    left: bool,
) -> AudioTimeMapSpanSupportStatus {
    if is_v2_edit_span(span.kind) {
        let boundary = if left {
            &span.boundaries.start
        } else {
            &span.boundaries.end
        };
        return match boundary.status {
            AudioTimeMapBoundaryStatus::Refined if boundary.support_duration_ms > 0 => {
                AudioTimeMapSpanSupportStatus::Supported
            }
            AudioTimeMapBoundaryStatus::Refined => AudioTimeMapSpanSupportStatus::Unsupported,
            AudioTimeMapBoundaryStatus::NotApplicable => {
                AudioTimeMapSpanSupportStatus::NotApplicable
            }
            AudioTimeMapBoundaryStatus::Ambiguous | AudioTimeMapBoundaryStatus::Unsupported => {
                AudioTimeMapSpanSupportStatus::Unsupported
            }
        };
    }
    if span.kind == AudioTimeMapSpanKind::Ambiguous {
        return AudioTimeMapSpanSupportStatus::Unsupported;
    }
    let midpoint = span.source_start_ms.saturating_add(
        span.source_end_ms
            .saturating_sub(span.source_start_ms)
            .div_ceil(2),
    );
    let supported = training.iter().any(|anchor| {
        u64::try_from(anchor.source_time_ms)
            .ok()
            .is_some_and(|source_ms| {
                if left {
                    source_ms <= midpoint
                } else {
                    source_ms >= midpoint
                }
            })
    });
    if supported {
        AudioTimeMapSpanSupportStatus::Supported
    } else {
        AudioTimeMapSpanSupportStatus::Unsupported
    }
}

fn v2_residual_statistics(
    residuals: &[u64],
) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    if residuals.is_empty() {
        return (None, None, None, None);
    }
    let mut sorted = residuals.to_vec();
    sorted.sort_unstable();
    let at = |quantile: f64| {
        let index = ((sorted.len().saturating_sub(1)) as f64 * quantile).ceil() as usize;
        sorted[index.min(sorted.len() - 1)]
    };
    (
        Some(at(0.50)),
        Some(at(0.95)),
        Some(at(0.99)),
        sorted.last().copied(),
    )
}

fn v2_anchor_region_count(
    hypothesis: &AffineHypothesis,
    source_start_ms: u64,
    source_end_ms: u64,
) -> usize {
    let source_times = hypothesis
        .training_anchors
        .iter()
        .chain(&hypothesis.held_out_anchors)
        .filter_map(|item| u64::try_from(item.source_time_ms).ok())
        .collect::<Vec<_>>();
    v2_source_time_region_count(&source_times, source_start_ms, source_end_ms)
}

pub(super) fn v2_source_time_region_count(
    source_times: &[u64],
    source_start_ms: u64,
    source_end_ms: u64,
) -> usize {
    let duration = source_end_ms.saturating_sub(source_start_ms);
    if duration == 0 {
        return 0;
    }
    let mut occupied = [false; 3];
    for source_ms in source_times
        .iter()
        .copied()
        .filter(|value| *value >= source_start_ms && *value <= source_end_ms)
    {
        let relative = source_ms.saturating_sub(source_start_ms);
        let region = ((relative as u128 * 3) / duration as u128).min(2) as usize;
        occupied[region] = true;
    }
    occupied.into_iter().filter(|value| *value).count()
}

fn v2_matched_source_coverage(spans: &[AudioTimeMapSpanDto]) -> f64 {
    let Some(first) = spans.first() else {
        return 0.0;
    };
    let source_end_ms = spans
        .last()
        .map(|span| span.source_end_ms)
        .unwrap_or(first.source_start_ms);
    let source_duration_ms = source_end_ms.saturating_sub(first.source_start_ms);
    if source_duration_ms == 0 {
        return 0.0;
    }
    let matched_source_ms = spans
        .iter()
        .filter(|span| span.kind == AudioTimeMapSpanKind::Matched)
        .map(|span| span.source_end_ms.saturating_sub(span.source_start_ms))
        .sum::<u64>();
    (matched_source_ms as f64 / source_duration_ms as f64).clamp(0.0, 1.0)
}

const ALIGNMENT_EVIDENCE_PROFILE_VERSION: &str = "alignment-evidence-profile-v2";
const ALIGNMENT_EVIDENCE_PROFILE_TARGET_SAMPLES_PER_AXIS: u64 = 1_200;
const ALIGNMENT_EVIDENCE_PROFILE_MIN_WINDOW_MS: u64 = 1_000;
const ALIGNMENT_EVIDENCE_PROFILE_AMBIGUOUS_COST: f64 = 720.0;

fn create_v2_evidence_profile(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    fine_evidence: &[V2FineEvidenceObservation],
) -> Option<AlignmentEvidenceProfileDto> {
    let first = spans.first()?;
    let last = spans.last()?;
    let source_start_ms = first.source_start_ms;
    let source_end_ms = last.source_end_ms;
    let target_start_ms = first.target_start_ms;
    let target_end_ms = last.target_end_ms;
    let max_duration_ms = source_end_ms
        .saturating_sub(source_start_ms)
        .max(target_end_ms.saturating_sub(target_start_ms));
    if max_duration_ms == 0 {
        return None;
    }
    let requested_window_ms = max_duration_ms
        .div_ceil(ALIGNMENT_EVIDENCE_PROFILE_TARGET_SAMPLES_PER_AXIS)
        .max(ALIGNMENT_EVIDENCE_PROFILE_MIN_WINDOW_MS);
    let window_ms = requested_window_ms
        .div_ceil(ALIGNMENT_EVIDENCE_PROFILE_MIN_WINDOW_MS)
        .saturating_mul(ALIGNMENT_EVIDENCE_PROFILE_MIN_WINDOW_MS);
    let anchors = hypothesis
        .training_anchors
        .iter()
        .map(|anchor| (anchor, false))
        .chain(
            hypothesis
                .held_out_anchors
                .iter()
                .map(|anchor| (anchor, true)),
        )
        .collect::<Vec<_>>();
    let mut samples = create_v2_axis_evidence_samples(
        "source",
        source_start_ms,
        source_end_ms,
        window_ms,
        spans,
        &anchors,
        fine_evidence,
    );
    samples.extend(create_v2_axis_evidence_samples(
        "target",
        target_start_ms,
        target_end_ms,
        window_ms,
        spans,
        &anchors,
        fine_evidence,
    ));
    Some(AlignmentEvidenceProfileDto {
        version: ALIGNMENT_EVIDENCE_PROFILE_VERSION,
        window_ms,
        samples,
    })
}

fn create_v2_axis_evidence_samples(
    axis: &'static str,
    axis_start_ms: u64,
    axis_end_ms: u64,
    window_ms: u64,
    spans: &[AudioTimeMapSpanDto],
    anchors: &[(&AffineAnchorEvidence, bool)],
    fine_evidence: &[V2FineEvidenceObservation],
) -> Vec<AlignmentEvidenceSampleDto> {
    let sample_count = axis_end_ms
        .saturating_sub(axis_start_ms)
        .div_ceil(window_ms) as usize;
    let mut anchors_by_sample = vec![Vec::<(&AffineAnchorEvidence, bool)>::new(); sample_count];
    for (anchor, held_out) in anchors {
        let axis_time_ms = if axis == "source" {
            u64::try_from(anchor.source_time_ms).ok()
        } else {
            u64::try_from(anchor.target_time_ms).ok()
        };
        let Some(axis_time_ms) =
            axis_time_ms.filter(|value| *value >= axis_start_ms && *value < axis_end_ms)
        else {
            continue;
        };
        let index = axis_time_ms.saturating_sub(axis_start_ms) / window_ms;
        if let Some(bucket) = usize::try_from(index)
            .ok()
            .and_then(|index| anchors_by_sample.get_mut(index))
        {
            bucket.push((*anchor, *held_out));
        }
    }
    let mut fine_by_sample = vec![Vec::<&V2FineEvidenceObservation>::new(); sample_count];
    for observation in fine_evidence {
        let (start_ms, end_ms) = v2_fine_observation_axis_range(observation, axis);
        if end_ms <= start_ms {
            continue;
        }
        let midpoint_ms = start_ms.saturating_add(end_ms.saturating_sub(start_ms) / 2);
        if midpoint_ms < axis_start_ms || midpoint_ms >= axis_end_ms {
            continue;
        }
        let index = midpoint_ms.saturating_sub(axis_start_ms) / window_ms;
        if let Some(bucket) = usize::try_from(index)
            .ok()
            .and_then(|index| fine_by_sample.get_mut(index))
        {
            bucket.push(observation);
        }
    }
    (0..sample_count)
        .map(|index| {
            let start_ms = axis_start_ms.saturating_add(index as u64 * window_ms);
            let end_ms = start_ms.saturating_add(window_ms).min(axis_end_ms);
            let midpoint_ms = start_ms.saturating_add(end_ms.saturating_sub(start_ms) / 2);
            let span = spans.iter().find(|span| {
                let (span_start_ms, span_end_ms) = if axis == "source" {
                    (span.source_start_ms, span.source_end_ms)
                } else {
                    (span.target_start_ms, span.target_end_ms)
                };
                span_end_ms > span_start_ms
                    && midpoint_ms >= span_start_ms
                    && midpoint_ms < span_end_ms
            });
            create_v2_evidence_sample(
                axis,
                start_ms,
                end_ms,
                span,
                &anchors_by_sample[index],
                &fine_by_sample[index],
            )
        })
        .collect()
}

fn v2_fine_observation_axis_range(
    observation: &V2FineEvidenceObservation,
    axis: &str,
) -> (u64, u64) {
    if axis == "source" {
        (observation.source_start_ms, observation.source_end_ms)
    } else {
        (observation.target_start_ms, observation.target_end_ms)
    }
}

fn create_v2_evidence_sample(
    axis: &'static str,
    start_ms: u64,
    end_ms: u64,
    span: Option<&AudioTimeMapSpanDto>,
    anchors: &[(&AffineAnchorEvidence, bool)],
    fine_evidence: &[&V2FineEvidenceObservation],
) -> AlignmentEvidenceSampleDto {
    let explicit_state = span.and_then(|span| match span.kind {
        AudioTimeMapSpanKind::SourceOnly if axis == "source" => Some("sourceOnly"),
        AudioTimeMapSpanKind::TargetOnly if axis == "target" => Some("targetOnly"),
        _ => None,
    });
    let anchor_count = anchors.len();
    let held_out_anchor_count = anchors.iter().filter(|(_, held_out)| *held_out).count();
    let median_abs_residual_ms = median_u64(
        anchors
            .iter()
            .map(|(anchor, _)| anchor.residual_ms.unsigned_abs())
            .collect(),
    );
    let anchor_offset_values = anchors
        .iter()
        .map(|(anchor, _)| anchor.target_time_ms.saturating_sub(anchor.source_time_ms))
        .collect::<Vec<_>>();
    let fine_offset_values = fine_evidence
        .iter()
        .filter(|observation| {
            matches!(
                observation.kind,
                AudioTimeMapSpanKind::Matched | AudioTimeMapSpanKind::Ambiguous
            ) && observation.source_end_ms > observation.source_start_ms
                && observation.target_end_ms > observation.target_start_ms
        })
        .map(|observation| {
            let source_mid = observation.source_start_ms
                + observation
                    .source_end_ms
                    .saturating_sub(observation.source_start_ms)
                    / 2;
            let target_mid = observation.target_start_ms
                + observation
                    .target_end_ms
                    .saturating_sub(observation.target_start_ms)
                    / 2;
            i64::try_from(target_mid)
                .unwrap_or(i64::MAX)
                .saturating_sub(i64::try_from(source_mid).unwrap_or(i64::MAX))
        })
        .collect::<Vec<_>>();
    let offset_ms = median_i64(if fine_offset_values.is_empty() {
        anchor_offset_values.clone()
    } else {
        fine_offset_values.clone()
    });
    let anchor_counterpart_ms = median_i64(
        anchors
            .iter()
            .map(|(anchor, _)| {
                if axis == "source" {
                    anchor.target_time_ms
                } else {
                    anchor.source_time_ms
                }
            })
            .collect(),
    )
    .and_then(|value| u64::try_from(value).ok());
    let fine_counterpart_ms = median_u64(
        fine_evidence
            .iter()
            .filter_map(|observation| {
                let (axis_start, axis_end, other_start, other_end) = if axis == "source" {
                    (
                        observation.source_start_ms,
                        observation.source_end_ms,
                        observation.target_start_ms,
                        observation.target_end_ms,
                    )
                } else {
                    (
                        observation.target_start_ms,
                        observation.target_end_ms,
                        observation.source_start_ms,
                        observation.source_end_ms,
                    )
                };
                (axis_end > axis_start && other_end > other_start)
                    .then_some(other_start + other_end.saturating_sub(other_start) / 2)
            })
            .collect(),
    );
    let counterpart_ms = fine_counterpart_ms.or(anchor_counterpart_ms);
    let offset_spread_ms = anchor_offset_values
        .iter()
        .min()
        .zip(anchor_offset_values.iter().max())
        .map(|(minimum, maximum)| maximum.saturating_sub(*minimum).unsigned_abs())
        .unwrap_or(0);
    let matched_count = fine_evidence
        .iter()
        .filter(|observation| observation.kind == AudioTimeMapSpanKind::Matched)
        .count();
    let ambiguous_count = fine_evidence
        .iter()
        .filter(|observation| observation.kind == AudioTimeMapSpanKind::Ambiguous)
        .count();
    let one_sided_count = fine_evidence
        .iter()
        .filter(|observation| {
            matches!(
                observation.kind,
                AudioTimeMapSpanKind::SourceOnly | AudioTimeMapSpanKind::TargetOnly
            )
        })
        .count();
    let observation_count = fine_evidence.len();
    let expected_observations = end_ms
        .saturating_sub(start_ms)
        .div_ceil(ALIGNMENT_V2_FINE_HOP_MS as u64)
        .max(1) as usize;
    let observation_coverage =
        (observation_count as f64 / expected_observations as f64).clamp(0.0, 1.0);
    let mean_information = if observation_count == 0 {
        0.0
    } else {
        fine_evidence
            .iter()
            .map(|observation| observation.informativeness)
            .sum::<f64>()
            / observation_count as f64
    };
    let informativeness = (observation_coverage * (0.25 + mean_information * 0.75)).clamp(0.0, 1.0);
    let diagonal_costs = fine_evidence
        .iter()
        .filter(|observation| {
            matches!(
                observation.kind,
                AudioTimeMapSpanKind::Matched | AudioTimeMapSpanKind::Ambiguous
            )
        })
        .map(|observation| observation.local_cost.max(0) as f64)
        .collect::<Vec<_>>();
    let median_diagonal_cost =
        median_f64(diagonal_costs).unwrap_or(ALIGNMENT_EVIDENCE_PROFILE_AMBIGUOUS_COST);
    let local_match_quality =
        (1.0 - median_diagonal_cost / ALIGNMENT_EVIDENCE_PROFILE_AMBIGUOUS_COST).clamp(0.0, 1.0);
    let fine_match_probability = if observation_count == 0 {
        0.0
    } else {
        (matched_count as f64 / observation_count as f64) * local_match_quality
    };
    let anchor_support = if anchor_count == 0 {
        0.0
    } else {
        let residual_factor = median_abs_residual_ms
            .map(|value| 1.0 - (value as f64 / 2_000.0).clamp(0.0, 1.0))
            .unwrap_or(0.25);
        let density_factor = (anchor_count as f64 / 4.0).clamp(0.25, 1.0);
        (residual_factor * 0.75 + density_factor * 0.25).clamp(0.0, 1.0)
    };
    let match_probability = if explicit_state.is_some() {
        0.0
    } else if observation_count == 0 {
        anchor_support
    } else {
        (fine_match_probability * 0.85 + anchor_support * 0.15).clamp(0.0, 1.0)
    };
    let one_sided_ratio = one_sided_count as f64 / observation_count.max(1) as f64;
    let ambiguous_ratio = ambiguous_count as f64 / observation_count.max(1) as f64;
    let mut difference_risk = ((one_sided_ratio + ambiguous_ratio * 0.45)
        * (0.35 + informativeness * 0.65))
        .clamp(0.0, 1.0);
    if explicit_state.is_some() {
        difference_risk = difference_risk.max(0.9);
    }
    let dominant_state = if let Some(state) = explicit_state {
        state
    } else if observation_count == 0 || informativeness < 0.08 {
        "uncertain"
    } else if one_sided_ratio >= 0.55 {
        if axis == "source" {
            "sourceOnly"
        } else {
            "targetOnly"
        }
    } else if ambiguous_ratio >= 0.35 || (match_probability < 0.35 && difference_risk >= 0.35) {
        "replacement"
    } else if match_probability >= 0.55 {
        "matched"
    } else {
        "uncertain"
    };
    let state = match dominant_state {
        "matched" if match_probability >= 0.72 => "supported",
        "matched" => "weak",
        "sourceOnly" => "sourceOnly",
        "targetOnly" => "targetOnly",
        "replacement" => "conflicting",
        _ if anchor_count == 0 && observation_count == 0 => "noEvidence",
        _ => "weak",
    };
    let strength = match_probability;
    let offset_uncertainty_ms = v2_offset_uncertainty_ms(&fine_offset_values)
        .or_else(|| (offset_spread_ms > 0).then_some(offset_spread_ms));
    let reason_code = if explicit_state.is_some() {
        "timeMapSingleAxis"
    } else if observation_count == 0 {
        "anchorOnly"
    } else if informativeness < 0.08 {
        "lowInformation"
    } else if dominant_state == "replacement" {
        "conflictingDensePath"
    } else if dominant_state == "matched" {
        "densePathAgreement"
    } else {
        "densePathUncertain"
    };
    AlignmentEvidenceSampleDto {
        axis,
        start_ms,
        end_ms,
        counterpart_ms,
        strength,
        anchor_count,
        held_out_anchor_count,
        median_abs_residual_ms,
        offset_ms,
        state,
        match_probability,
        difference_risk,
        informativeness,
        offset_uncertainty_ms,
        dominant_state,
        reason_code,
        visual_support: None,
        visual_match_ms: None,
        visual_offset_ms: None,
        visual_confidence: None,
        visual_margin: None,
        visual_recovery_state: None,
    }
}

fn median_f64(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[values.len() / 2])
}

fn v2_offset_uncertainty_ms(values: &[i64]) -> Option<u64> {
    if values.len() < 2 {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let lower = sorted[(sorted.len().saturating_sub(1) * 10) / 100];
    let upper = sorted[(sorted.len().saturating_sub(1) * 90).div_ceil(100)];
    Some(upper.saturating_sub(lower).unsigned_abs())
}

fn median_u64(mut values: Vec<u64>) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

fn median_i64(mut values: Vec<i64>) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

#[cfg(test)]
pub(super) fn test_finalize_v2_span_evidence(
    spans: &mut [AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
    alternative_margin: f64,
) {
    let _ = finalize_v2_span_evidence(
        spans,
        hypothesis,
        use_island_local_residuals,
        alternative_margin,
    );
}

#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(super) struct TestV2TimedAnchorResidual {
    pub(super) source_time_ms: u64,
    pub(super) residual_ms: u64,
}

#[cfg(test)]
pub(super) fn test_v2_worst_sliding_local_p95(
    held_out: &[TestV2TimedAnchorResidual],
) -> Option<u64> {
    let held_out = held_out
        .iter()
        .map(|anchor| V2TimedAnchorResidual {
            source_time_ms: anchor.source_time_ms,
            residual_ms: anchor.residual_ms,
        })
        .collect::<Vec<_>>();
    v2_worst_sliding_local_p95(&held_out)
}

#[cfg(test)]
pub(super) fn test_v2_final_map_anchor_residual(
    spans: &[AudioTimeMapSpanDto],
    anchor: &AffineAnchorEvidence,
) -> Option<u64> {
    v2_final_map_anchor_residual(spans, anchor)
}

#[cfg(test)]
pub(super) fn test_v2_partition_held_out_anchors(
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> (Vec<AffineAnchorEvidence>, Vec<AffineAnchorEvidence>) {
    v2_partition_held_out_anchors(hypothesis, use_island_local_residuals)
}

#[cfg(test)]
pub(super) fn test_v2_final_map_held_out_anchor_diagnostics(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> Vec<String> {
    v2_final_map_held_out_anchor_diagnostics(spans, hypothesis, use_island_local_residuals)
}

#[cfg(test)]
pub(super) fn test_v2_final_map_problem_training_anchor_diagnostics(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
) -> Vec<String> {
    v2_final_map_problem_training_anchor_diagnostics(spans, hypothesis)
}

#[cfg(test)]
pub(super) fn test_v2_final_map_ambiguous_span_diagnostics(
    spans: &[AudioTimeMapSpanDto],
    hypothesis: &AffineHypothesis,
    use_island_local_residuals: bool,
) -> Vec<String> {
    v2_final_map_ambiguous_span_diagnostics(spans, hypothesis, use_island_local_residuals)
}

#[cfg(test)]
pub(super) fn test_v2_matched_source_coverage(spans: &[AudioTimeMapSpanDto]) -> f64 {
    v2_matched_source_coverage(spans)
}

#[cfg(test)]
pub(super) fn test_v2_residual_statistics(
    residuals: &[u64],
) -> (Option<u64>, Option<u64>, Option<u64>, Option<u64>) {
    v2_residual_statistics(residuals)
}

#[cfg(test)]
#[test]
fn v2_evidence_profile_keeps_local_support_and_offset_steps_for_review() {
    let spans = vec![
        create_v2_span(AudioTimeMapSpanKind::Matched, 0, 20_000, 0, 20_000),
        create_v2_span(
            AudioTimeMapSpanKind::Ambiguous,
            20_000,
            30_000,
            20_000,
            40_000,
        ),
        create_v2_span(
            AudioTimeMapSpanKind::Matched,
            30_000,
            40_000,
            40_000,
            50_000,
        ),
    ];
    let hypothesis = AffineHypothesis {
        scale: 1.0,
        offset_ms: 0,
        inlier_count: 4,
        unique_source_count: 4,
        unique_source_coverage: 0.8,
        unique_target_count: 4,
        unique_target_coverage: 0.8,
        source_start_ms: 0,
        source_end_ms: 40_000,
        p50_residual_ms: 20,
        p95_residual_ms: 40,
        max_residual_ms: 50,
        training_anchors: vec![
            AffineAnchorEvidence {
                source_time_ms: 5_000,
                target_time_ms: 5_000,
                residual_ms: 10,
            },
            AffineAnchorEvidence {
                source_time_ms: 15_000,
                target_time_ms: 15_000,
                residual_ms: 20,
            },
            AffineAnchorEvidence {
                source_time_ms: 35_000,
                target_time_ms: 45_000,
                residual_ms: 30,
            },
        ],
        held_out_anchors: vec![AffineAnchorEvidence {
            source_time_ms: 38_000,
            target_time_ms: 48_000,
            residual_ms: 40,
        }],
        held_out_within_tolerance_count: 1,
    };

    let profile = create_v2_evidence_profile(&spans, &hypothesis, &[]).expect("profile");
    assert_eq!(profile.version, ALIGNMENT_EVIDENCE_PROFILE_VERSION);
    assert_eq!(profile.window_ms, 1_000);
    let target_gap = profile
        .samples
        .iter()
        .find(|sample| sample.axis == "target" && sample.start_ms == 25_000)
        .expect("target gap sample");
    assert_eq!(target_gap.state, "noEvidence");
    assert_eq!(target_gap.anchor_count, 0);
    let after = profile
        .samples
        .iter()
        .find(|sample| sample.axis == "source" && sample.start_ms == 35_000)
        .expect("post-gap source sample");
    assert_eq!(after.offset_ms, Some(10_000));
    assert!(after.strength > 0.5);
}

#[cfg(test)]
mod tests {
    use super::{evaluate_v2_pair_outcome, V2PairOutcomeInput};
    use crate::alignment_v2::{AffineAnchorEvidence, AffineHypothesis};

    use super::super::{
        create_v2_span, v2_pair_engine::V2ChunkAlignment,
        v2_pair_fine_execution::V2BoundarySummary, AudioTimeMapSpanKind,
    };

    fn supported_hypothesis() -> AffineHypothesis {
        let anchor = |source_time_ms: i64| AffineAnchorEvidence {
            source_time_ms,
            target_time_ms: source_time_ms,
            residual_ms: 0,
        };
        AffineHypothesis {
            scale: 1.0,
            offset_ms: 0,
            inlier_count: 3,
            unique_source_count: 3,
            unique_source_coverage: 1.0,
            unique_target_count: 3,
            unique_target_coverage: 1.0,
            source_start_ms: 0,
            source_end_ms: 30_000,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors: vec![anchor(5_000), anchor(15_000), anchor(25_000)],
            held_out_anchors: vec![anchor(1_000), anchor(11_000), anchor(21_000)],
            held_out_within_tolerance_count: 3,
        }
    }

    fn matched_alignment() -> V2ChunkAlignment {
        V2ChunkAlignment {
            spans: vec![create_v2_span(
                AudioTimeMapSpanKind::Matched,
                0,
                30_000,
                0,
                30_000,
            )],
            matched_step_count: 600,
            ambiguous_step_count: 0,
            path_checkpoints: Vec::new(),
            fine_evidence: Vec::new(),
        }
    }

    #[test]
    fn post_fine_outcome_fail_closes_without_independent_holdout() {
        let hypothesis = AffineHypothesis {
            scale: 1.0,
            offset_ms: 0,
            inlier_count: 3,
            unique_source_count: 3,
            unique_source_coverage: 1.0,
            unique_target_count: 3,
            unique_target_coverage: 1.0,
            source_start_ms: 0,
            source_end_ms: 30_000,
            p50_residual_ms: 0,
            p95_residual_ms: 0,
            max_residual_ms: 0,
            training_anchors: Vec::new(),
            held_out_anchors: Vec::new(),
            held_out_within_tolerance_count: 0,
        };
        let outcome = evaluate_v2_pair_outcome(V2PairOutcomeInput {
            alignment: matched_alignment(),
            boundary: V2BoundarySummary::default(),
            hypothesis: &hypothesis,
            use_island_local_residuals: false,
            top1_top2_margin: 1.0,
            minimum_alternative_margin: 0.1,
        });

        assert_eq!(outcome.time_map_quality.level, "blocked");
        assert!(outcome.blocked);
        assert_eq!(outcome.alignment.spans[0].quality.level, "blocked");
        assert!(outcome
            .time_map_quality
            .reasons
            .iter()
            .any(|reason| reason.contains("独立留出支持不足")));
    }

    #[test]
    fn post_fine_outcome_preserves_supported_review_contract() {
        let hypothesis = supported_hypothesis();

        let outcome = evaluate_v2_pair_outcome(V2PairOutcomeInput {
            alignment: matched_alignment(),
            boundary: V2BoundarySummary::default(),
            hypothesis: &hypothesis,
            use_island_local_residuals: false,
            top1_top2_margin: 1.0,
            minimum_alternative_margin: 0.1,
        });

        assert!(!outcome.blocked);
        assert!(!outcome.catastrophic);
        assert_eq!(outcome.time_map_quality.level, "review");
        assert_eq!(outcome.time_map_quality.coverage, Some(1.0));
        assert_eq!(outcome.time_map_quality.p95_residual_ms, Some(0));
        assert_eq!(outcome.alignment.spans[0].quality.level, "review");
        assert!(outcome.evidence_profile.is_some());
    }

    #[test]
    fn post_fine_outcome_keeps_boundary_ambiguity_fail_closed() {
        let hypothesis = supported_hypothesis();
        let boundary = V2BoundarySummary {
            ambiguous_count: 1,
            ..V2BoundarySummary::default()
        };

        let outcome = evaluate_v2_pair_outcome(V2PairOutcomeInput {
            alignment: matched_alignment(),
            boundary,
            hypothesis: &hypothesis,
            use_island_local_residuals: false,
            top1_top2_margin: 1.0,
            minimum_alternative_margin: 0.1,
        });

        assert!(outcome.blocked);
        assert_eq!(outcome.time_map_quality.level, "blocked");
        assert!(outcome
            .time_map_quality
            .reasons
            .iter()
            .any(|reason| reason.contains("局部边界没有唯一、稳定的相关峰")));
    }
}
