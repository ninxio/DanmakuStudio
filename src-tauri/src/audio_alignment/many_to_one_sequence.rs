//! Fail-closed structure assessment for explicitly ordered many-to-one relations.
//!
//! The parent alignment pipeline adapts already-computed fine proposals into this module's
//! path-free, integer-millisecond inputs. This module owns content-island selection, filler
//! classification, monotonic path selection and joint review evidence. It deliberately does not
//! mutate a TimeMap or grant automatic verification.

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum JointSequenceSpanKind {
    Matched,
    SourceOnly,
    TargetOnly,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JointSequenceSpanInput {
    pub(crate) span_ordinal: u32,
    pub(crate) kind: JointSequenceSpanKind,
    pub(crate) source_start_ms: u64,
    pub(crate) source_end_ms: u64,
    pub(crate) target_start_ms: u64,
    pub(crate) target_end_ms: u64,
    pub(crate) anchor_count: usize,
    pub(crate) held_out_anchor_count: usize,
    pub(crate) p95_residual_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JointSequenceCandidateInput {
    pub(crate) candidate_ordinal: u32,
    pub(crate) source_start_ms: u64,
    pub(crate) source_end_ms: u64,
    pub(crate) spans: Vec<JointSequenceSpanInput>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JointSequencePartInput {
    pub(crate) part_ordinal: u32,
    pub(crate) candidates: Vec<JointSequenceCandidateInput>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JointSequenceInput {
    pub(crate) cohort_ordinal: u32,
    pub(crate) parts: Vec<JointSequencePartInput>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JointSequenceAssessmentStatus {
    Reviewable,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JointSequenceBlockCode {
    InvalidInput,
    MissingCoreContent,
    NonMonotonicOrder,
    AmbiguousSequence,
    InsufficientJointEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JointSequenceBlockReason {
    pub(crate) code: JointSequenceBlockCode,
    pub(crate) part_ordinal: Option<u32>,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JointSequenceFillerKind {
    SourceOnly,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JointSequenceCoreIsland {
    pub(crate) span_ordinal: u32,
    pub(crate) source_start_ms: u64,
    pub(crate) source_end_ms: u64,
    pub(crate) target_start_ms: u64,
    pub(crate) target_end_ms: u64,
    pub(crate) anchor_count: usize,
    pub(crate) held_out_anchor_count: usize,
    pub(crate) p95_residual_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JointSequenceFillerSegment {
    pub(crate) span_ordinal: u32,
    pub(crate) kind: JointSequenceFillerKind,
    pub(crate) source_start_ms: u64,
    pub(crate) source_end_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct JointSequencePartAssessment {
    pub(crate) part_ordinal: u32,
    pub(crate) selected_candidate_ordinal: Option<u32>,
    pub(crate) core_islands: Vec<JointSequenceCoreIsland>,
    pub(crate) filler_segments: Vec<JointSequenceFillerSegment>,
    pub(crate) source_duration_ms: u64,
    pub(crate) core_duration_ms: u64,
    pub(crate) filler_duration_ms: u64,
    pub(crate) filler_ratio: f64,
    pub(crate) target_start_ms: Option<u64>,
    pub(crate) target_end_ms: Option<u64>,
    pub(crate) anchor_count: usize,
    pub(crate) held_out_anchor_count: usize,
    pub(crate) worst_core_p95_residual_ms: Option<u64>,
    pub(crate) order_conflict_with_previous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JointSequenceEvidence {
    pub(crate) part_count: usize,
    pub(crate) total_core_duration_ms: u64,
    pub(crate) unique_target_coverage_ms: u64,
    pub(crate) anchor_count: usize,
    pub(crate) held_out_anchor_count: usize,
    pub(crate) worst_core_p95_residual_ms: Option<u64>,
    pub(crate) path_margin_micros: Option<u32>,
    pub(crate) short_tail_jointly_supported: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct JointSequenceAssessment {
    pub(crate) status: JointSequenceAssessmentStatus,
    pub(crate) cohort_ordinal: u32,
    pub(crate) parts: Vec<JointSequencePartAssessment>,
    pub(crate) evidence: JointSequenceEvidence,
    pub(crate) block_reasons: Vec<JointSequenceBlockReason>,
}

const MIN_PART_COUNT: usize = 2;
const MAX_PART_COUNT: usize = 128;
const MAX_CANDIDATES_PER_PART: usize = 64;
const MAX_SPANS_PER_CANDIDATE: usize = 512;
const MAX_CORE_ISLANDS_PER_CANDIDATE: usize = 8;
const MAX_PREPARED_VARIANTS_PER_PART: usize = 256;
const MIN_CORE_ISLAND_DURATION_MS: u64 = 10_000;
const MIN_CORE_ISLAND_ANCHOR_COUNT: usize = 3;
const MIN_CORE_ISLAND_HELD_OUT_COUNT: usize = 1;
const MAX_CORE_P95_RESIDUAL_MS: u64 = 400;
const MAX_ADJACENT_CORE_OVERLAP_MS: u64 = 30_000;
const MIN_SEQUENCE_PATH_MARGIN_MICROS: u32 = 80_000;
const SHORT_TAIL_MAX_DURATION_MS: u64 = 60_000;
const SHORT_TAIL_MIN_ANCHOR_COUNT: usize = 2;
const SHORT_TAIL_MAX_GAP_MS: u64 = 10_000;
const SHORT_TAIL_MIN_PRIOR_PART_COUNT: usize = 2;
const SHORT_TAIL_MIN_JOINT_ANCHOR_COUNT: usize = 10;
const SHORT_TAIL_MIN_JOINT_HELD_OUT_COUNT: usize = 3;

#[derive(Debug, Clone)]
struct PreparedCandidate {
    candidate_ordinal: u32,
    source_start_ms: u64,
    source_end_ms: u64,
    core_islands: Vec<JointSequenceCoreIsland>,
    filler_segments: Vec<JointSequenceFillerSegment>,
    core_duration_ms: u64,
    filler_duration_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
    anchor_count: usize,
    held_out_anchor_count: usize,
    worst_core_p95_residual_ms: Option<u64>,
    score: u128,
    needs_short_tail_support: bool,
}

#[derive(Debug, Clone)]
struct PathState {
    score: u128,
    candidate_indices: Vec<usize>,
}

pub(crate) fn assess_joint_sequence(input: JointSequenceInput) -> JointSequenceAssessment {
    let cohort_ordinal = input.cohort_ordinal;
    let part_count = input.parts.len();
    if let Some(message) = validate_input_shape(&input) {
        return blocked_assessment(
            cohort_ordinal,
            input.parts.iter().map(empty_part_assessment).collect(),
            vec![JointSequenceBlockReason {
                code: JointSequenceBlockCode::InvalidInput,
                part_ordinal: None,
                message,
            }],
            None,
        );
    }

    let mut prepared_by_part = Vec::<Vec<PreparedCandidate>>::with_capacity(part_count);
    let mut rejection_by_part = Vec::<Vec<String>>::with_capacity(part_count);
    let mut preparation_limit_reasons = Vec::<JointSequenceBlockReason>::new();
    for part in &input.parts {
        let mut prepared = Vec::new();
        let mut rejections = Vec::new();
        for candidate in &part.candidates {
            match prepare_candidate(candidate) {
                Ok(candidates) if !candidates.is_empty() => {
                    if prepared.len().saturating_add(candidates.len())
                        > MAX_PREPARED_VARIANTS_PER_PART
                    {
                        preparation_limit_reasons.push(JointSequenceBlockReason {
                            code: JointSequenceBlockCode::InvalidInput,
                            part_ordinal: Some(part.part_ordinal),
                            message: format!(
                                "P{} 的有界内容岛解释超过 {} 个；拒绝无界联合搜索。",
                                part.part_ordinal, MAX_PREPARED_VARIANTS_PER_PART
                            ),
                        });
                        prepared.clear();
                        break;
                    }
                    prepared.extend(candidates);
                }
                Ok(_) => rejections.push(format!(
                    "候选 {} 没有同时满足时长、anchor、独立留出和核心残差下限的内容岛。",
                    candidate.candidate_ordinal
                )),
                Err(error) => rejections.push(format!(
                    "候选 {} 的内容岛结构无效：{error}",
                    candidate.candidate_ordinal
                )),
            }
        }
        prepared.sort_by_key(|candidate| candidate.candidate_ordinal);
        prepared_by_part.push(prepared);
        rejection_by_part.push(rejections);
    }

    if !preparation_limit_reasons.is_empty() {
        let parts = diagnostic_individual_assessments(&input.parts, &prepared_by_part);
        return blocked_assessment(cohort_ordinal, parts, preparation_limit_reasons, None);
    }

    let mut missing_reasons = Vec::new();
    for (part_index, prepared) in prepared_by_part.iter().enumerate() {
        if prepared.is_empty() {
            let part = &input.parts[part_index];
            let detail = rejection_by_part[part_index]
                .first()
                .cloned()
                .unwrap_or_else(|| "没有候选内容岛。".to_string());
            missing_reasons.push(JointSequenceBlockReason {
                code: JointSequenceBlockCode::MissingCoreContent,
                part_ordinal: Some(part.part_ordinal),
                message: format!(
                    "P{} 没有可进入联合序列的可信核心内容：{detail}",
                    part.part_ordinal
                ),
            });
        }
    }
    if !missing_reasons.is_empty() {
        let parts = diagnostic_individual_assessments(&input.parts, &prepared_by_part);
        return blocked_assessment(cohort_ordinal, parts, missing_reasons, None);
    }

    let Some((best_path, runner_up)) = select_best_paths(&prepared_by_part) else {
        let mut parts = diagnostic_individual_assessments(&input.parts, &prepared_by_part);
        mark_order_conflicts(&mut parts);
        return blocked_assessment(
            cohort_ordinal,
            parts,
            vec![JointSequenceBlockReason {
                code: JointSequenceBlockCode::NonMonotonicOrder,
                part_ordinal: first_order_conflict_part(&input.parts, &prepared_by_part),
                message: "各 P 的局部最佳内容岛无法组成目标轴单调、非交叉的完整序列。".to_string(),
            }],
            None,
        );
    };

    let path_margin_micros = runner_up
        .as_ref()
        .map(|runner_up| normalized_path_margin_micros(best_path.score, runner_up.score));
    let mut parts = path_part_assessments(&input.parts, &prepared_by_part, &best_path);
    mark_order_conflicts(&mut parts);
    let mut reasons = Vec::new();
    if path_margin_micros.is_some_and(|margin| margin < MIN_SEQUENCE_PATH_MARGIN_MICROS) {
        reasons.push(JointSequenceBlockReason {
            code: JointSequenceBlockCode::AmbiguousSequence,
            part_ordinal: None,
            message: format!(
                "联合序列存在分数接近的第二条完整路径；路径 margin {} ppm 低于 {} ppm。",
                path_margin_micros.unwrap_or(0),
                MIN_SEQUENCE_PATH_MARGIN_MICROS
            ),
        });
    }

    let short_support_indices = selected_short_support_indices(&prepared_by_part, &best_path);
    let tail_index = parts.len().saturating_sub(1);
    let invalid_short_indices = short_support_indices
        .iter()
        .copied()
        .filter(|part_index| *part_index != tail_index)
        .collect::<Vec<_>>();
    for part_index in &invalid_short_indices {
        reasons.push(JointSequenceBlockReason {
            code: JointSequenceBlockCode::InsufficientJointEvidence,
            part_ordinal: input.parts.get(*part_index).map(|part| part.part_ordinal),
            message: format!(
                "P{} 使用了只允许末段采用的长度感知联合证据例外。",
                input.parts[*part_index].part_ordinal
            ),
        });
    }
    let short_tail_selected = short_support_indices.contains(&tail_index);
    let short_tail_jointly_supported = invalid_short_indices.is_empty()
        && short_tail_selected
        && short_tail_is_jointly_supported(&parts, &prepared_by_part, &best_path);
    if short_tail_selected && !short_tail_jointly_supported {
        reasons.push(JointSequenceBlockReason {
            code: JointSequenceBlockCode::InsufficientJointEvidence,
            part_ordinal: input.parts.last().map(|part| part.part_ordinal),
            message: "短末段没有独立留出，且与前序的邻接关系或联合 anchor/holdout 下限不足。"
                .to_string(),
        });
    }

    let evidence = summarize_evidence(&parts, path_margin_micros, short_tail_jointly_supported);
    JointSequenceAssessment {
        status: if reasons.is_empty() {
            JointSequenceAssessmentStatus::Reviewable
        } else {
            JointSequenceAssessmentStatus::Blocked
        },
        cohort_ordinal,
        parts,
        evidence,
        block_reasons: reasons,
    }
}

fn validate_input_shape(input: &JointSequenceInput) -> Option<String> {
    if input.cohort_ordinal == 0 {
        return Some("cohort ordinal 必须为非零值。".to_string());
    }
    if !(MIN_PART_COUNT..=MAX_PART_COUNT).contains(&input.parts.len()) {
        return Some(format!(
            "联合序列必须包含 {MIN_PART_COUNT}–{MAX_PART_COUNT} 个有序 P。"
        ));
    }
    let mut previous_part_ordinal = 0_u32;
    for part in &input.parts {
        if part.part_ordinal == 0 || part.part_ordinal <= previous_part_ordinal {
            return Some("part ordinal 必须严格递增且为非零值。".to_string());
        }
        previous_part_ordinal = part.part_ordinal;
        if part.candidates.len() > MAX_CANDIDATES_PER_PART {
            return Some(format!(
                "P{} 的候选数不能超过 {}。",
                part.part_ordinal, MAX_CANDIDATES_PER_PART
            ));
        }
        let mut candidate_ordinals = part
            .candidates
            .iter()
            .map(|candidate| candidate.candidate_ordinal)
            .collect::<Vec<_>>();
        candidate_ordinals.sort_unstable();
        if candidate_ordinals.first() == Some(&0)
            || candidate_ordinals.windows(2).any(|pair| pair[0] == pair[1])
        {
            return Some(format!(
                "P{} 的 candidate ordinal 无效或重复。",
                part.part_ordinal
            ));
        }
        for candidate in &part.candidates {
            if candidate.source_end_ms <= candidate.source_start_ms
                || candidate.spans.is_empty()
                || candidate.spans.len() > MAX_SPANS_PER_CANDIDATE
            {
                return Some(format!(
                    "P{} 候选 {} 的 source 范围或 span 数无效。",
                    part.part_ordinal, candidate.candidate_ordinal
                ));
            }
            let mut span_ordinals = candidate
                .spans
                .iter()
                .map(|span| span.span_ordinal)
                .collect::<Vec<_>>();
            span_ordinals.sort_unstable();
            if span_ordinals.first() == Some(&0)
                || span_ordinals.windows(2).any(|pair| pair[0] == pair[1])
            {
                return Some(format!(
                    "P{} 候选 {} 的 span ordinal 无效或重复。",
                    part.part_ordinal, candidate.candidate_ordinal
                ));
            }
            if candidate.spans.iter().any(|span| {
                span.source_end_ms < span.source_start_ms
                    || span.target_end_ms < span.target_start_ms
                    || span.source_start_ms < candidate.source_start_ms
                    || span.source_end_ms > candidate.source_end_ms
                    || (span.kind == JointSequenceSpanKind::Matched
                        && (span.source_end_ms == span.source_start_ms
                            || span.target_end_ms == span.target_start_ms))
            }) {
                return Some(format!(
                    "P{} 候选 {} 含越界或反向 span。",
                    part.part_ordinal, candidate.candidate_ordinal
                ));
            }
        }
    }
    None
}

fn prepare_candidate(
    candidate: &JointSequenceCandidateInput,
) -> Result<Vec<PreparedCandidate>, String> {
    let mut normal_core = candidate
        .spans
        .iter()
        .filter(|span| normal_core_island(span))
        .map(core_island_from_span)
        .collect::<Vec<_>>();
    let mut needs_short_tail_support = false;
    if normal_core.is_empty() {
        let short_core = candidate
            .spans
            .iter()
            .filter(|span| short_tail_core_island(span))
            .map(core_island_from_span)
            .collect::<Vec<_>>();
        if short_core.len() == 1 {
            normal_core = short_core;
            needs_short_tail_support = true;
        }
    }
    if normal_core.is_empty() {
        return Ok(Vec::new());
    }
    normal_core.sort_by_key(|island| {
        (
            island.source_start_ms,
            island.source_end_ms,
            island.target_start_ms,
            island.target_end_ms,
            island.span_ordinal,
        )
    });
    if normal_core
        .windows(2)
        .any(|pair| pair[1].source_start_ms < pair[0].source_end_ms)
    {
        return Err("同一候选的核心岛在 source 轴上交叉。".to_string());
    }

    if normal_core.len() > MAX_CORE_ISLANDS_PER_CANDIDATE {
        return Err(format!(
            "独立支持的核心岛超过 {} 个有界选择上限。",
            MAX_CORE_ISLANDS_PER_CANDIDATE
        ));
    }
    let island_selections = if needs_short_tail_support {
        vec![vec![0_usize]]
    } else {
        bounded_core_island_selections(normal_core.len())
    };
    island_selections
        .into_iter()
        .filter_map(|selection| {
            let selected = selection
                .into_iter()
                .map(|index| normal_core[index].clone())
                .collect::<Vec<_>>();
            selected
                .windows(2)
                .all(|pair| {
                    target_intervals_are_ordered(
                        pair[0].target_start_ms,
                        pair[0].target_end_ms,
                        pair[1].target_start_ms,
                        pair[1].target_end_ms,
                    )
                })
                .then(|| build_prepared_candidate(candidate, selected, needs_short_tail_support))
        })
        .collect()
}

fn bounded_core_island_selections(island_count: usize) -> Vec<Vec<usize>> {
    let mut selections = (1_usize..(1_usize << island_count))
        .map(|mask| {
            (0..island_count)
                .filter(|index| mask & (1_usize << index) != 0)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    selections.sort();
    selections
}

fn build_prepared_candidate(
    candidate: &JointSequenceCandidateInput,
    selected_core: Vec<JointSequenceCoreIsland>,
    needs_short_tail_support: bool,
) -> Result<PreparedCandidate, String> {
    let core_span_ordinals = selected_core
        .iter()
        .map(|island| island.span_ordinal)
        .collect::<Vec<_>>();

    let mut filler_segments = candidate
        .spans
        .iter()
        .filter(|span| {
            span.source_end_ms > span.source_start_ms
                && !core_span_ordinals.contains(&span.span_ordinal)
        })
        .map(|span| JointSequenceFillerSegment {
            span_ordinal: span.span_ordinal,
            kind: if span.kind == JointSequenceSpanKind::SourceOnly {
                JointSequenceFillerKind::SourceOnly
            } else {
                JointSequenceFillerKind::Ambiguous
            },
            source_start_ms: span.source_start_ms,
            source_end_ms: span.source_end_ms,
        })
        .collect::<Vec<_>>();
    filler_segments.sort_by_key(|segment| {
        (
            segment.source_start_ms,
            segment.source_end_ms,
            segment.span_ordinal,
        )
    });

    let core_duration_ms = selected_core.iter().fold(0_u64, |sum, island| {
        sum.saturating_add(island.source_end_ms.saturating_sub(island.source_start_ms))
    });
    let source_duration_ms = candidate
        .source_end_ms
        .saturating_sub(candidate.source_start_ms);
    let filler_duration_ms = source_duration_ms.saturating_sub(core_duration_ms);
    let target_start_ms = selected_core
        .iter()
        .map(|island| island.target_start_ms)
        .min()
        .ok_or_else(|| "核心岛缺少 target 起点。".to_string())?;
    let target_end_ms = selected_core
        .iter()
        .map(|island| island.target_end_ms)
        .max()
        .ok_or_else(|| "核心岛缺少 target 终点。".to_string())?;
    let anchor_count = selected_core.iter().fold(0_usize, |sum, island| {
        sum.saturating_add(island.anchor_count)
    });
    let held_out_anchor_count = selected_core.iter().fold(0_usize, |sum, island| {
        sum.saturating_add(island.held_out_anchor_count)
    });
    let worst_core_p95_residual_ms = selected_core
        .iter()
        .filter_map(|island| island.p95_residual_ms)
        .max();
    let residual_bonus = worst_core_p95_residual_ms
        .map(|residual| MAX_CORE_P95_RESIDUAL_MS.saturating_sub(residual))
        .unwrap_or(0);
    let score = u128::from(core_duration_ms)
        .saturating_add((anchor_count as u128).saturating_mul(30_000))
        .saturating_add((held_out_anchor_count as u128).saturating_mul(60_000))
        .saturating_add(u128::from(residual_bonus).saturating_mul(100));
    Ok(PreparedCandidate {
        candidate_ordinal: candidate.candidate_ordinal,
        source_start_ms: candidate.source_start_ms,
        source_end_ms: candidate.source_end_ms,
        core_islands: selected_core,
        filler_segments,
        core_duration_ms,
        filler_duration_ms,
        target_start_ms,
        target_end_ms,
        anchor_count,
        held_out_anchor_count,
        worst_core_p95_residual_ms,
        score,
        needs_short_tail_support,
    })
}

fn normal_core_island(span: &&JointSequenceSpanInput) -> bool {
    span.kind == JointSequenceSpanKind::Matched
        && span.source_end_ms.saturating_sub(span.source_start_ms) >= MIN_CORE_ISLAND_DURATION_MS
        && span.target_end_ms.saturating_sub(span.target_start_ms) >= MIN_CORE_ISLAND_DURATION_MS
        && span.anchor_count >= MIN_CORE_ISLAND_ANCHOR_COUNT
        && span.held_out_anchor_count >= MIN_CORE_ISLAND_HELD_OUT_COUNT
        && span
            .p95_residual_ms
            .is_some_and(|residual| residual <= MAX_CORE_P95_RESIDUAL_MS)
}

fn short_tail_core_island(span: &&JointSequenceSpanInput) -> bool {
    let duration_ms = span.source_end_ms.saturating_sub(span.source_start_ms);
    span.kind == JointSequenceSpanKind::Matched
        && (MIN_CORE_ISLAND_DURATION_MS..=SHORT_TAIL_MAX_DURATION_MS).contains(&duration_ms)
        && span.target_end_ms.saturating_sub(span.target_start_ms) >= MIN_CORE_ISLAND_DURATION_MS
        && span.anchor_count >= SHORT_TAIL_MIN_ANCHOR_COUNT
        && span.held_out_anchor_count == 0
        && span.p95_residual_ms.is_none()
}

fn core_island_from_span(span: &JointSequenceSpanInput) -> JointSequenceCoreIsland {
    JointSequenceCoreIsland {
        span_ordinal: span.span_ordinal,
        source_start_ms: span.source_start_ms,
        source_end_ms: span.source_end_ms,
        target_start_ms: span.target_start_ms,
        target_end_ms: span.target_end_ms,
        anchor_count: span.anchor_count,
        held_out_anchor_count: span.held_out_anchor_count,
        p95_residual_ms: span.p95_residual_ms,
    }
}

fn target_intervals_are_ordered(
    previous_start_ms: u64,
    previous_end_ms: u64,
    next_start_ms: u64,
    next_end_ms: u64,
) -> bool {
    next_start_ms >= previous_start_ms
        && next_end_ms >= previous_end_ms
        && previous_end_ms.saturating_sub(next_start_ms) <= MAX_ADJACENT_CORE_OVERLAP_MS
}

fn candidates_are_compatible(previous: &PreparedCandidate, next: &PreparedCandidate) -> bool {
    target_intervals_are_ordered(
        previous.target_start_ms,
        previous.target_end_ms,
        next.target_start_ms,
        next.target_end_ms,
    )
}

fn select_best_paths(
    prepared_by_part: &[Vec<PreparedCandidate>],
) -> Option<(PathState, Option<PathState>)> {
    let first = prepared_by_part.first()?;
    let mut previous_states = first
        .iter()
        .enumerate()
        .map(|(candidate_index, candidate)| {
            vec![PathState {
                score: candidate.score,
                candidate_indices: vec![candidate_index],
            }]
        })
        .collect::<Vec<_>>();
    for part_index in 1..prepared_by_part.len() {
        let previous_candidates = &prepared_by_part[part_index - 1];
        let current_candidates = &prepared_by_part[part_index];
        let mut current_states = vec![Vec::<PathState>::new(); current_candidates.len()];
        for (current_index, current) in current_candidates.iter().enumerate() {
            let mut alternatives = Vec::<PathState>::new();
            for (previous_index, previous) in previous_candidates.iter().enumerate() {
                if !candidates_are_compatible(previous, current) {
                    continue;
                }
                for path in &previous_states[previous_index] {
                    let mut candidate_indices = path.candidate_indices.clone();
                    candidate_indices.push(current_index);
                    alternatives.push(PathState {
                        score: path.score.saturating_add(current.score),
                        candidate_indices,
                    });
                }
            }
            sort_and_keep_two_paths(&mut alternatives);
            current_states[current_index] = alternatives;
        }
        previous_states = current_states;
    }
    let mut completed = previous_states.into_iter().flatten().collect::<Vec<_>>();
    sort_and_keep_two_paths(&mut completed);
    let best = completed.first()?.clone();
    let runner_up = completed.get(1).cloned();
    Some((best, runner_up))
}

fn sort_and_keep_two_paths(paths: &mut Vec<PathState>) {
    paths.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.candidate_indices.cmp(&right.candidate_indices))
    });
    paths.dedup_by(|left, right| left.candidate_indices == right.candidate_indices);
    paths.truncate(2);
}

fn normalized_path_margin_micros(best: u128, runner_up: u128) -> u32 {
    if best == 0 {
        return 0;
    }
    let margin = best.saturating_sub(runner_up).saturating_mul(1_000_000) / best;
    u32::try_from(margin).unwrap_or(u32::MAX)
}

fn candidate_part_assessment(
    part_ordinal: u32,
    candidate: &PreparedCandidate,
) -> JointSequencePartAssessment {
    let source_duration_ms = candidate
        .source_end_ms
        .saturating_sub(candidate.source_start_ms);
    JointSequencePartAssessment {
        part_ordinal,
        selected_candidate_ordinal: Some(candidate.candidate_ordinal),
        core_islands: candidate.core_islands.clone(),
        filler_segments: candidate.filler_segments.clone(),
        source_duration_ms,
        core_duration_ms: candidate.core_duration_ms,
        filler_duration_ms: candidate.filler_duration_ms,
        filler_ratio: if source_duration_ms == 0 {
            1.0
        } else {
            candidate.filler_duration_ms as f64 / source_duration_ms as f64
        },
        target_start_ms: Some(candidate.target_start_ms),
        target_end_ms: Some(candidate.target_end_ms),
        anchor_count: candidate.anchor_count,
        held_out_anchor_count: candidate.held_out_anchor_count,
        worst_core_p95_residual_ms: candidate.worst_core_p95_residual_ms,
        order_conflict_with_previous: false,
    }
}

fn empty_part_assessment(part: &JointSequencePartInput) -> JointSequencePartAssessment {
    let candidate = part.candidates.iter().max_by_key(|candidate| {
        candidate
            .source_end_ms
            .saturating_sub(candidate.source_start_ms)
    });
    let source_duration_ms = candidate
        .map(|candidate| {
            candidate
                .source_end_ms
                .saturating_sub(candidate.source_start_ms)
        })
        .unwrap_or(0);
    let filler_segments = candidate
        .map(|candidate| {
            candidate
                .spans
                .iter()
                .filter(|span| span.source_end_ms > span.source_start_ms)
                .map(|span| JointSequenceFillerSegment {
                    span_ordinal: span.span_ordinal,
                    kind: if span.kind == JointSequenceSpanKind::SourceOnly {
                        JointSequenceFillerKind::SourceOnly
                    } else {
                        JointSequenceFillerKind::Ambiguous
                    },
                    source_start_ms: span.source_start_ms,
                    source_end_ms: span.source_end_ms,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    JointSequencePartAssessment {
        part_ordinal: part.part_ordinal,
        selected_candidate_ordinal: None,
        core_islands: Vec::new(),
        filler_segments,
        source_duration_ms,
        core_duration_ms: 0,
        filler_duration_ms: source_duration_ms,
        filler_ratio: 1.0,
        target_start_ms: None,
        target_end_ms: None,
        anchor_count: 0,
        held_out_anchor_count: 0,
        worst_core_p95_residual_ms: None,
        order_conflict_with_previous: false,
    }
}

fn diagnostic_individual_assessments(
    parts: &[JointSequencePartInput],
    prepared_by_part: &[Vec<PreparedCandidate>],
) -> Vec<JointSequencePartAssessment> {
    parts
        .iter()
        .enumerate()
        .map(|(part_index, part)| {
            prepared_by_part[part_index]
                .iter()
                .max_by(|left, right| {
                    left.score
                        .cmp(&right.score)
                        .then_with(|| right.candidate_ordinal.cmp(&left.candidate_ordinal))
                })
                .map(|candidate| candidate_part_assessment(part.part_ordinal, candidate))
                .unwrap_or_else(|| empty_part_assessment(part))
        })
        .collect()
}

fn path_part_assessments(
    parts: &[JointSequencePartInput],
    prepared_by_part: &[Vec<PreparedCandidate>],
    path: &PathState,
) -> Vec<JointSequencePartAssessment> {
    parts
        .iter()
        .enumerate()
        .map(|(part_index, part)| {
            candidate_part_assessment(
                part.part_ordinal,
                &prepared_by_part[part_index][path.candidate_indices[part_index]],
            )
        })
        .collect()
}

fn mark_order_conflicts(parts: &mut [JointSequencePartAssessment]) {
    for index in 1..parts.len() {
        let ordered = match (
            parts[index - 1].target_start_ms,
            parts[index - 1].target_end_ms,
            parts[index].target_start_ms,
            parts[index].target_end_ms,
        ) {
            (
                Some(previous_start_ms),
                Some(previous_end_ms),
                Some(next_start_ms),
                Some(next_end_ms),
            ) => target_intervals_are_ordered(
                previous_start_ms,
                previous_end_ms,
                next_start_ms,
                next_end_ms,
            ),
            _ => false,
        };
        parts[index].order_conflict_with_previous = !ordered;
    }
}

fn first_order_conflict_part(
    parts: &[JointSequencePartInput],
    prepared_by_part: &[Vec<PreparedCandidate>],
) -> Option<u32> {
    let mut diagnostic = diagnostic_individual_assessments(parts, prepared_by_part);
    mark_order_conflicts(&mut diagnostic);
    diagnostic
        .iter()
        .find(|part| part.order_conflict_with_previous)
        .map(|part| part.part_ordinal)
}

fn selected_short_support_indices(
    prepared_by_part: &[Vec<PreparedCandidate>],
    path: &PathState,
) -> Vec<usize> {
    path.candidate_indices
        .iter()
        .enumerate()
        .filter_map(|(part_index, candidate_index)| {
            prepared_by_part[part_index][*candidate_index]
                .needs_short_tail_support
                .then_some(part_index)
        })
        .collect()
}

fn short_tail_is_jointly_supported(
    parts: &[JointSequencePartAssessment],
    prepared_by_part: &[Vec<PreparedCandidate>],
    path: &PathState,
) -> bool {
    let Some(tail) = parts.last() else {
        return false;
    };
    if tail.held_out_anchor_count > 0 {
        return false;
    }
    let tail_index = parts.len().saturating_sub(1);
    let independently_supported_prior_count = path
        .candidate_indices
        .iter()
        .take(tail_index)
        .enumerate()
        .filter(|(part_index, candidate_index)| {
            !prepared_by_part[*part_index][**candidate_index].needs_short_tail_support
        })
        .count();
    if independently_supported_prior_count < SHORT_TAIL_MIN_PRIOR_PART_COUNT
        || tail.core_duration_ms > SHORT_TAIL_MAX_DURATION_MS
        || tail.anchor_count < SHORT_TAIL_MIN_ANCHOR_COUNT
    {
        return false;
    }
    let Some(previous) = parts.get(parts.len().saturating_sub(2)) else {
        return false;
    };
    let adjacency_ok = match (previous.target_end_ms, tail.target_start_ms) {
        (Some(previous_end_ms), Some(tail_start_ms)) if tail_start_ms >= previous_end_ms => {
            tail_start_ms.saturating_sub(previous_end_ms) <= SHORT_TAIL_MAX_GAP_MS
        }
        (Some(previous_end_ms), Some(tail_start_ms)) => {
            previous_end_ms.saturating_sub(tail_start_ms) <= MAX_ADJACENT_CORE_OVERLAP_MS
        }
        _ => false,
    };
    let joint_anchor_count = parts
        .iter()
        .fold(0_usize, |sum, part| sum.saturating_add(part.anchor_count));
    let joint_held_out_count = parts.iter().fold(0_usize, |sum, part| {
        sum.saturating_add(part.held_out_anchor_count)
    });
    adjacency_ok
        && joint_anchor_count >= SHORT_TAIL_MIN_JOINT_ANCHOR_COUNT
        && joint_held_out_count >= SHORT_TAIL_MIN_JOINT_HELD_OUT_COUNT
}

fn summarize_evidence(
    parts: &[JointSequencePartAssessment],
    path_margin_micros: Option<u32>,
    short_tail_jointly_supported: bool,
) -> JointSequenceEvidence {
    let mut target_intervals = parts
        .iter()
        .flat_map(|part| {
            part.core_islands
                .iter()
                .map(|island| (island.target_start_ms, island.target_end_ms))
        })
        .filter(|(start_ms, end_ms)| end_ms > start_ms)
        .collect::<Vec<_>>();
    target_intervals.sort_unstable();
    let mut unique_target_coverage_ms = 0_u64;
    let mut active = None::<(u64, u64)>;
    for interval in target_intervals {
        match active {
            None => active = Some(interval),
            Some((active_start_ms, active_end_ms)) if interval.0 <= active_end_ms => {
                active = Some((active_start_ms, active_end_ms.max(interval.1)));
            }
            Some((active_start_ms, active_end_ms)) => {
                unique_target_coverage_ms = unique_target_coverage_ms
                    .saturating_add(active_end_ms.saturating_sub(active_start_ms));
                active = Some(interval);
            }
        }
    }
    if let Some((start_ms, end_ms)) = active {
        unique_target_coverage_ms =
            unique_target_coverage_ms.saturating_add(end_ms.saturating_sub(start_ms));
    }
    JointSequenceEvidence {
        part_count: parts.len(),
        total_core_duration_ms: parts
            .iter()
            .fold(0_u64, |sum, part| sum.saturating_add(part.core_duration_ms)),
        unique_target_coverage_ms,
        anchor_count: parts
            .iter()
            .fold(0_usize, |sum, part| sum.saturating_add(part.anchor_count)),
        held_out_anchor_count: parts.iter().fold(0_usize, |sum, part| {
            sum.saturating_add(part.held_out_anchor_count)
        }),
        worst_core_p95_residual_ms: parts
            .iter()
            .filter_map(|part| part.worst_core_p95_residual_ms)
            .max(),
        path_margin_micros,
        short_tail_jointly_supported,
    }
}

fn blocked_assessment(
    cohort_ordinal: u32,
    parts: Vec<JointSequencePartAssessment>,
    block_reasons: Vec<JointSequenceBlockReason>,
    path_margin_micros: Option<u32>,
) -> JointSequenceAssessment {
    let evidence = summarize_evidence(&parts, path_margin_micros, false);
    JointSequenceAssessment {
        status: JointSequenceAssessmentStatus::Blocked,
        cohort_ordinal,
        parts,
        evidence,
        block_reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assess_joint_sequence, JointSequenceAssessmentStatus, JointSequenceBlockCode,
        JointSequenceCandidateInput, JointSequenceFillerKind, JointSequenceInput,
        JointSequencePartInput, JointSequenceSpanInput, JointSequenceSpanKind,
    };

    fn span(
        span_ordinal: u32,
        kind: JointSequenceSpanKind,
        source: (u64, u64),
        target: (u64, u64),
        anchor_count: usize,
        held_out_anchor_count: usize,
        p95_residual_ms: Option<u64>,
    ) -> JointSequenceSpanInput {
        JointSequenceSpanInput {
            span_ordinal,
            kind,
            source_start_ms: source.0,
            source_end_ms: source.1,
            target_start_ms: target.0,
            target_end_ms: target.1,
            anchor_count,
            held_out_anchor_count,
            p95_residual_ms,
        }
    }

    fn candidate(
        candidate_ordinal: u32,
        source_end_ms: u64,
        spans: Vec<JointSequenceSpanInput>,
    ) -> JointSequenceCandidateInput {
        JointSequenceCandidateInput {
            candidate_ordinal,
            source_start_ms: 0,
            source_end_ms,
            spans,
        }
    }

    fn core_candidate(
        candidate_ordinal: u32,
        source_end_ms: u64,
        source: (u64, u64),
        target: (u64, u64),
    ) -> JointSequenceCandidateInput {
        candidate(
            candidate_ordinal,
            source_end_ms,
            vec![span(
                1,
                JointSequenceSpanKind::Matched,
                source,
                target,
                6,
                2,
                Some(120),
            )],
        )
    }

    fn part(
        part_ordinal: u32,
        candidates: Vec<JointSequenceCandidateInput>,
    ) -> JointSequencePartInput {
        JointSequencePartInput {
            part_ordinal,
            candidates,
        }
    }

    fn assess(parts: Vec<JointSequencePartInput>) -> super::JointSequenceAssessment {
        assess_joint_sequence(JointSequenceInput {
            cohort_ordinal: 7,
            parts,
        })
    }

    #[test]
    fn front_and_back_filler_do_not_dilute_core_evidence() {
        let first = candidate(
            1,
            100_000,
            vec![
                span(
                    1,
                    JointSequenceSpanKind::SourceOnly,
                    (0, 20_000),
                    (100_000, 100_000),
                    0,
                    0,
                    None,
                ),
                span(
                    2,
                    JointSequenceSpanKind::Matched,
                    (20_000, 80_000),
                    (100_000, 160_000),
                    6,
                    2,
                    Some(100),
                ),
                span(
                    3,
                    JointSequenceSpanKind::Ambiguous,
                    (80_000, 100_000),
                    (160_000, 160_000),
                    0,
                    0,
                    None,
                ),
            ],
        );
        let assessment = assess(vec![
            part(1, vec![first]),
            part(
                2,
                vec![core_candidate(1, 80_000, (0, 80_000), (165_000, 245_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert_eq!(assessment.parts[0].core_duration_ms, 60_000);
        assert_eq!(assessment.parts[0].filler_duration_ms, 40_000);
        assert!((assessment.parts[0].filler_ratio - 0.4).abs() < f64::EPSILON);
        assert_eq!(
            assessment.parts[0]
                .filler_segments
                .iter()
                .map(|segment| segment.kind)
                .collect::<Vec<_>>(),
            vec![
                JointSequenceFillerKind::SourceOnly,
                JointSequenceFillerKind::Ambiguous
            ]
        );
    }

    #[test]
    fn one_part_can_keep_multiple_independently_supported_core_islands() {
        let first = candidate(
            1,
            150_000,
            vec![
                span(
                    1,
                    JointSequenceSpanKind::Matched,
                    (0, 50_000),
                    (100_000, 150_000),
                    4,
                    1,
                    Some(80),
                ),
                span(
                    2,
                    JointSequenceSpanKind::SourceOnly,
                    (50_000, 90_000),
                    (150_000, 150_000),
                    0,
                    0,
                    None,
                ),
                span(
                    3,
                    JointSequenceSpanKind::Matched,
                    (90_000, 150_000),
                    (180_000, 240_000),
                    4,
                    1,
                    Some(110),
                ),
            ],
        );
        let assessment = assess(vec![
            part(1, vec![first]),
            part(
                2,
                vec![core_candidate(1, 90_000, (0, 90_000), (250_000, 340_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert_eq!(assessment.parts[0].core_islands.len(), 2);
        assert_eq!(assessment.parts[0].core_duration_ms, 110_000);
    }

    #[test]
    fn non_contiguous_core_island_subset_can_form_the_unique_best_sequence() {
        let four_islands_with_decoys = candidate(
            1,
            80_000,
            vec![
                span(
                    1,
                    JointSequenceSpanKind::Matched,
                    (0, 20_000),
                    (110_000, 130_000),
                    3,
                    1,
                    Some(100),
                ),
                span(
                    2,
                    JointSequenceSpanKind::Matched,
                    (20_000, 40_000),
                    (500_000, 520_000),
                    3,
                    1,
                    Some(100),
                ),
                span(
                    3,
                    JointSequenceSpanKind::Matched,
                    (40_000, 60_000),
                    (135_000, 155_000),
                    3,
                    1,
                    Some(100),
                ),
                span(
                    4,
                    JointSequenceSpanKind::Matched,
                    (60_000, 80_000),
                    (600_000, 620_000),
                    3,
                    1,
                    Some(100),
                ),
            ],
        );
        let assessment = assess(vec![
            part(
                1,
                vec![core_candidate(1, 100_000, (0, 100_000), (0, 100_000))],
            ),
            part(2, vec![four_islands_with_decoys]),
            part(
                3,
                vec![core_candidate(1, 100_000, (0, 100_000), (160_000, 260_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert_eq!(
            assessment.parts[1]
                .core_islands
                .iter()
                .map(|island| island.span_ordinal)
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
    }

    #[test]
    fn repeated_intro_candidate_loses_to_globally_ordered_main_content() {
        let assessment = assess(vec![
            part(
                1,
                vec![core_candidate(1, 100_000, (0, 100_000), (100_000, 200_000))],
            ),
            part(
                2,
                vec![
                    core_candidate(1, 120_000, (0, 120_000), (105_000, 225_000)),
                    core_candidate(2, 100_000, (0, 100_000), (205_000, 305_000)),
                ],
            ),
            part(
                3,
                vec![core_candidate(1, 100_000, (0, 100_000), (310_000, 410_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert_eq!(assessment.parts[1].selected_candidate_ordinal, Some(2));
    }

    #[test]
    fn repeated_intro_island_is_left_ambiguous_when_main_island_fits_the_sequence() {
        let repeated_intro_and_main = candidate(
            1,
            150_000,
            vec![
                span(
                    1,
                    JointSequenceSpanKind::Matched,
                    (0, 40_000),
                    (110_000, 150_000),
                    4,
                    1,
                    Some(80),
                ),
                span(
                    2,
                    JointSequenceSpanKind::SourceOnly,
                    (40_000, 50_000),
                    (150_000, 150_000),
                    0,
                    0,
                    None,
                ),
                span(
                    3,
                    JointSequenceSpanKind::Matched,
                    (50_000, 150_000),
                    (205_000, 305_000),
                    7,
                    2,
                    Some(120),
                ),
            ],
        );
        let assessment = assess(vec![
            part(
                1,
                vec![core_candidate(1, 100_000, (0, 100_000), (100_000, 200_000))],
            ),
            part(2, vec![repeated_intro_and_main]),
            part(
                3,
                vec![core_candidate(1, 100_000, (0, 100_000), (310_000, 410_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert_eq!(
            assessment.parts[1]
                .core_islands
                .iter()
                .map(|island| island.span_ordinal)
                .collect::<Vec<_>>(),
            vec![3]
        );
        assert!(assessment.parts[1]
            .filler_segments
            .iter()
            .any(|segment| segment.span_ordinal == 1
                && segment.kind == JointSequenceFillerKind::Ambiguous));
    }

    #[test]
    fn small_adjacent_overlap_is_ordered_but_backward_crossing_is_blocked() {
        let adjacent = assess(vec![
            part(
                1,
                vec![core_candidate(1, 80_000, (0, 80_000), (100_000, 180_000))],
            ),
            part(
                2,
                vec![core_candidate(1, 90_000, (0, 90_000), (175_000, 265_000))],
            ),
        ]);
        assert_eq!(adjacent.status, JointSequenceAssessmentStatus::Reviewable);

        let crossing = assess(vec![
            part(
                1,
                vec![core_candidate(1, 80_000, (0, 80_000), (200_000, 280_000))],
            ),
            part(
                2,
                vec![core_candidate(1, 90_000, (0, 90_000), (90_000, 180_000))],
            ),
        ]);
        assert_eq!(crossing.status, JointSequenceAssessmentStatus::Blocked);
        assert!(crossing
            .block_reasons
            .iter()
            .any(|reason| reason.code == JointSequenceBlockCode::NonMonotonicOrder));
    }

    #[test]
    fn overlapping_target_intervals_count_their_full_union_coverage() {
        let assessment = assess(vec![
            part(
                1,
                vec![core_candidate(1, 100_000, (0, 100_000), (0, 100_000))],
            ),
            part(
                2,
                vec![core_candidate(1, 100_000, (0, 100_000), (50_000, 150_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Blocked);
        assert_eq!(assessment.evidence.unique_target_coverage_ms, 150_000);
    }

    #[test]
    fn no_common_content_stays_fail_closed() {
        let no_content = candidate(
            1,
            120_000,
            vec![span(
                1,
                JointSequenceSpanKind::SourceOnly,
                (0, 120_000),
                (100_000, 100_000),
                0,
                0,
                None,
            )],
        );
        let assessment = assess(vec![
            part(1, vec![no_content]),
            part(
                2,
                vec![core_candidate(1, 80_000, (0, 80_000), (200_000, 280_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Blocked);
        assert!(assessment.block_reasons.iter().any(|reason| {
            reason.code == JointSequenceBlockCode::MissingCoreContent
                && reason.part_ordinal == Some(1)
        }));
    }

    #[test]
    fn short_final_part_can_use_bounded_joint_support() {
        let short_tail = candidate(
            1,
            20_000,
            vec![span(
                1,
                JointSequenceSpanKind::Matched,
                (0, 20_000),
                (300_000, 320_000),
                2,
                0,
                None,
            )],
        );
        let assessment = assess(vec![
            part(
                1,
                vec![core_candidate(1, 140_000, (0, 140_000), (0, 140_000))],
            ),
            part(
                2,
                vec![core_candidate(1, 150_000, (0, 150_000), (145_000, 295_000))],
            ),
            part(3, vec![short_tail]),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert!(assessment.evidence.short_tail_jointly_supported);
        assert_eq!(assessment.parts[2].held_out_anchor_count, 0);
    }

    #[test]
    fn short_middle_part_cannot_borrow_the_tail_exception() {
        let independently_supported = candidate(
            1,
            100_000,
            vec![span(
                1,
                JointSequenceSpanKind::Matched,
                (0, 100_000),
                (0, 100_000),
                10,
                3,
                Some(100),
            )],
        );
        let short_middle = candidate(
            1,
            20_000,
            vec![span(
                1,
                JointSequenceSpanKind::Matched,
                (0, 20_000),
                (105_000, 125_000),
                2,
                0,
                None,
            )],
        );
        let short_tail = candidate(
            1,
            20_000,
            vec![span(
                1,
                JointSequenceSpanKind::Matched,
                (0, 20_000),
                (130_000, 150_000),
                2,
                0,
                None,
            )],
        );

        let assessment = assess(vec![
            part(1, vec![independently_supported]),
            part(2, vec![short_middle]),
            part(3, vec![short_tail]),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Blocked);
        assert!(assessment.block_reasons.iter().any(|reason| {
            reason.code == JointSequenceBlockCode::InsufficientJointEvidence
                && reason.part_ordinal == Some(2)
        }));
        assert!(!assessment.evidence.short_tail_jointly_supported);
    }

    #[test]
    fn bad_detached_island_residual_does_not_pollute_selected_core() {
        let mixed = candidate(
            1,
            120_000,
            vec![
                span(
                    1,
                    JointSequenceSpanKind::Matched,
                    (0, 8_000),
                    (10_000, 18_000),
                    1,
                    1,
                    Some(12_987),
                ),
                span(
                    2,
                    JointSequenceSpanKind::Ambiguous,
                    (8_000, 20_000),
                    (18_000, 20_000),
                    0,
                    0,
                    None,
                ),
                span(
                    3,
                    JointSequenceSpanKind::Matched,
                    (20_000, 120_000),
                    (100_000, 200_000),
                    7,
                    2,
                    Some(120),
                ),
            ],
        );
        let assessment = assess(vec![
            part(1, vec![mixed]),
            part(
                2,
                vec![core_candidate(1, 100_000, (0, 100_000), (205_000, 305_000))],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Reviewable);
        assert_eq!(assessment.parts[0].core_islands.len(), 1);
        assert_eq!(assessment.parts[0].core_islands[0].span_ordinal, 3);
        assert_eq!(assessment.parts[0].worst_core_p95_residual_ms, Some(120));
        assert!(assessment.parts[0]
            .filler_segments
            .iter()
            .any(|segment| segment.span_ordinal == 1
                && segment.kind == JointSequenceFillerKind::Ambiguous));
    }

    #[test]
    fn equal_monotonic_paths_remain_ambiguous() {
        let assessment = assess(vec![
            part(
                1,
                vec![
                    core_candidate(1, 80_000, (0, 80_000), (0, 80_000)),
                    core_candidate(2, 80_000, (0, 80_000), (20_000, 100_000)),
                ],
            ),
            part(
                2,
                vec![
                    core_candidate(1, 80_000, (0, 80_000), (120_000, 200_000)),
                    core_candidate(2, 80_000, (0, 80_000), (140_000, 220_000)),
                ],
            ),
        ]);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Blocked);
        assert!(assessment
            .block_reasons
            .iter()
            .any(|reason| reason.code == JointSequenceBlockCode::AmbiguousSequence));
    }

    #[test]
    fn deidentified_fourteen_part_fixture_fails_only_at_bad_core_residual() {
        let input: JointSequenceInput = serde_json::from_str(include_str!(
            "../../../fixtures/alignment/many-to-one-filled-parts-structure-v1.json"
        ))
        .expect("fixture must match the joint sequence input contract");
        let assessment = assess_joint_sequence(input);

        assert_eq!(assessment.status, JointSequenceAssessmentStatus::Blocked);
        assert_eq!(assessment.parts.len(), 14);
        assert_eq!(assessment.evidence.unique_target_coverage_ms, 6_257_120);
        assert!(assessment.parts[12].core_islands.is_empty());
        assert_eq!(assessment.parts[13].core_islands.len(), 1);
        assert!(assessment.block_reasons.iter().any(|reason| {
            reason.code == JointSequenceBlockCode::MissingCoreContent
                && reason.part_ordinal == Some(13)
        }));
        assert!(!assessment
            .block_reasons
            .iter()
            .any(|reason| reason.part_ordinal == Some(14)));
    }
}
