import type {
  AlignmentReviewDecision,
  AlignmentReviewPrecision,
  EditorProject,
  MediaTimeMap
} from "../project/types";
import { appendAlignmentReviewRecord } from "./alignmentReviewRecords";
import {
  invalidateTimeMapSpanEvidenceForManualReview,
  isCompleteTimeMapSpanEvidence,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  validateTimeMap,
  type TimeMapSpan,
  type TimeMapSpanKind
} from "./timeMap";

export type TimeMapSpanReviewDecision = AlignmentReviewDecision;

export const TIME_MAP_SPAN_REVIEW_LABELS: Record<TimeMapSpanReviewDecision, string> = {
  "source-extra": "参考多出",
  "target-extra": "原片多出",
  replacement: "版本替换",
  unresolved: "无法判断"
};

export interface TimeMapSpanReviewAvailability {
  allowed: boolean;
  desiredKind: TimeMapSpanKind;
  reason: string;
}

export interface RecordedTimeMapSpanReview {
  spanIndex: number;
  decision: TimeMapSpanReviewDecision;
  reviewedAt: string;
}

export interface ManualTimeMapSpanPatch {
  kind: TimeMapSpanKind;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
}

export interface ManualTimeMapSplitPoint {
  sourceMs: number;
  targetMs: number;
}

export interface ResolveOriginalOnlyGapInput {
  /** 参考时间轴在原片独有内容期间保持不动的接缝点。 */
  sourceAtMs: number;
  targetStartMs: number;
  targetEndMs: number;
}

export interface ResolveReferenceOnlyGapInput {
  sourceStartMs: number;
  sourceEndMs: number;
  /** 原片时间轴在参考独有内容期间保持不动的接缝点。 */
  targetAtMs: number;
}

const REVIEW_NOTE_PREFIX = "manual-span-review:v1:";
const PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v2:";
const LEGACY_PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v1:";
const MANUAL_TAKEOVER_NOTE_PREFIX = "manual-takeover:v1:";
const MANUAL_STRUCTURE_EDIT_NOTE_PREFIX = "manual-span-structure-edit:v1:";
const MANUAL_REVIEW_STATE_REASON_PREFIX = "逐段人工复核状态：";

export class TimeMapSpanReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeMapSpanReviewError";
  }
}

export function suggestTimeMapSpanReviewDecision(
  span: TimeMapSpan
): TimeMapSpanReviewDecision | null {
  if (span.kind === "matched") return null;
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  if (sourceDurationMs > 0 && targetDurationMs === 0) return "source-extra";
  if (sourceDurationMs === 0 && targetDurationMs > 0) return "target-extra";
  if (sourceDurationMs > 0 && targetDurationMs > 0) return "replacement";
  return "unresolved";
}

export function applySystemSuggestedTimeMapReviews(
  timeMap: MediaTimeMap,
  reviewedAt: string
): MediaTimeMap {
  return timeMap.spans.reduce((current, span, spanIndex) => {
    const suggestion = suggestTimeMapSpanReviewDecision(span);
    return suggestion && suggestion !== "unresolved"
      ? applyTimeMapSpanReviewDecision(current, spanIndex, suggestion, reviewedAt)
      : current;
  }, timeMap);
}

export function applyCandidateTimeMapManualTakeover(
  timeMap: MediaTimeMap,
  reviewedAt: string
): MediaTimeMap {
  if (timeMap.state !== "candidate") {
    throw new TimeMapSpanReviewError("只能接管尚未确认的候选时间图。");
  }
  if (!isIsoTimestamp(reviewedAt)) {
    throw new TimeMapSpanReviewError("人工接管时间必须是有效的 ISO 时间戳。");
  }
  if (!timeMap.sourceIdentity || !timeMap.targetIdentity) {
    throw new TimeMapSpanReviewError("人工接管前必须保留参考与原片的内容身份快照。");
  }
  const validation = validateTimeMap(timeMap.spans);
  if (!validation.valid || timeMap.spans.length === 0) {
    throw new TimeMapSpanReviewError(
      `候选时间图结构无效，不能人工接管：${validation.issues[0]?.message ?? "没有可用分段"}`
    );
  }
  const unresolved = timeMap.spans.flatMap((span, spanIndex) => {
    const suggestion = suggestTimeMapSpanReviewDecision(span);
    if (!suggestion) return [];
    const recorded = readTimeMapSpanReviewDecision(timeMap, spanIndex)?.decision;
    return recorded === suggestion
      ? []
      : [`第 ${spanIndex + 1} 段尚未采用系统建议“${TIME_MAP_SPAN_REVIEW_LABELS[suggestion]}”`];
  });
  if (unresolved.length > 0) {
    throw new TimeMapSpanReviewError(`人工接管前仍有未定区间：${unresolved.slice(0, 3).join("；")}。`);
  }
  const spans = timeMap.spans.map((span, spanIndex) => {
    const complete = isCompleteTimeMapSpanEvidence(span)
      ? { ...span }
      : normalizeLegacyUnverifiedTimeMapSpanEvidence(span, {
          id: span.id ?? `${timeMap.id}:span:${String(spanIndex + 1).padStart(4, "0")}`,
          blocked: true
        });
    return {
      ...complete,
      quality: {
        ...complete.quality,
        level: "review" as const,
        reasons: [
          `第 ${spanIndex + 1} 段由用户采用系统建议并明确接管；算法阻断仍保留在整图诊断中，导出需安装级签名。`
        ]
      }
    };
  });
  return {
    ...timeMap,
    revision: timeMap.revision + 1,
    spans,
    quality: {
      ...timeMap.quality,
      level: "review",
      reasons: uniqueStrings([
        ...timeMap.quality.reasons,
        "用户已采用系统最高可能性建议并接管该候选；允许保存关系，但正式导出仍需明确签发人工方案。"
      ])
    },
    evidence: {
      ...timeMap.evidence,
      types: appendUnique(timeMap.evidence.types, "manual"),
      notes: [
        ...timeMap.evidence.notes.filter(
          (note) => !note.startsWith(MANUAL_TAKEOVER_NOTE_PREFIX)
        ),
        `${MANUAL_TAKEOVER_NOTE_PREFIX}${reviewedAt}`
      ]
    },
    verification: null,
    updatedAt: reviewedAt
  };
}

export function readTimeMapManualTakeover(timeMap: MediaTimeMap): string | null {
  for (let index = timeMap.evidence.notes.length - 1; index >= 0; index -= 1) {
    const note = timeMap.evidence.notes[index] ?? "";
    if (!note.startsWith(MANUAL_TAKEOVER_NOTE_PREFIX)) continue;
    const reviewedAt = note.slice(MANUAL_TAKEOVER_NOTE_PREFIX.length);
    return isIsoTimestamp(reviewedAt) ? reviewedAt : null;
  }
  return null;
}

/**
 * 用户明确接管的方案是一个真实的产品决策，不应再被自动质量门槛重复否决。
 * 这里仍保留不可绕过的数据完整性要求：正式关系、媒体身份、合法连续分段、
 * 完整逐段证据，以及所有差异段的明确分类。
 */
export function isTimeMapManualTakeoverExportApproved(timeMap: MediaTimeMap): boolean {
  if (
    timeMap.state !== "confirmed" ||
    !readTimeMapManualTakeover(timeMap) ||
    !timeMap.evidence.types.includes("manual") ||
    !timeMap.sourceIdentity ||
    !timeMap.targetIdentity
  ) {
    return false;
  }
  const validation = validateTimeMap(timeMap.spans);
  if (!validation.valid || timeMap.spans.length === 0) {
    return false;
  }
  return timeMap.spans.every((span, spanIndex) => {
    if (
      !isCompleteTimeMapSpanEvidence(span) ||
      span.quality.level === "blocked" ||
      span.quality.level === "legacy-unverified"
    ) {
      return false;
    }
    if (span.kind === "matched") {
      return true;
    }
    const decision = readTimeMapSpanReviewDecision(timeMap, spanIndex)?.decision;
    if (span.kind === "sourceOnly") return decision === "source-extra";
    if (span.kind === "targetOnly") return decision === "target-extra";
    return decision === "replacement";
  });
}

/**
 * 根据双方区间形状判断一个人工分类是否可写回。分类不会暗改边界；形状不兼容时
 * 必须先做边界编辑，因此这里 fail-closed。
 */
export function describeTimeMapSpanReviewAvailability(
  span: TimeMapSpan,
  decision: TimeMapSpanReviewDecision
): TimeMapSpanReviewAvailability {
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  const desiredKind = decisionToSpanKind(decision);
  if (decision === "source-extra") {
    return sourceDurationMs > 0 && targetDurationMs === 0
      ? { allowed: true, desiredKind, reason: "双方边界形状支持“参考多出”。" }
      : {
          allowed: false,
          desiredKind,
          reason: "要判定为“参考多出”，原片侧必须先收敛为同一个边界点。"
        };
  }
  if (decision === "target-extra") {
    return sourceDurationMs === 0 && targetDurationMs > 0
      ? { allowed: true, desiredKind, reason: "双方边界形状支持“原片多出”。" }
      : {
          allowed: false,
          desiredKind,
          reason: "要判定为“原片多出”，参考侧必须先收敛为同一个边界点。"
        };
  }
  if (decision === "replacement") {
    return sourceDurationMs > 0 && targetDurationMs > 0
      ? { allowed: true, desiredKind, reason: "双方都有内容，可记录为版本替换。" }
      : {
          allowed: false,
          desiredKind,
          reason: "版本替换要求参考和原片两侧都有正长度内容；请先编辑边界。"
        };
  }
  return sourceDurationMs > 0 || targetDurationMs > 0
    ? { allowed: true, desiredKind, reason: "保留为无法判断，继续阻断导出。" }
    : {
        allowed: false,
        desiredKind,
        reason: "空边界点不能记录为差异区间。"
      };
}

/**
 * 在候选时间图内持久记录人工分类。记录复用 evidence.notes，避免新增一个与
 * schema 并行的临时状态；项目保存和重开后仍可恢复。任何人工改动都会清除旧验证、
 * 增加 revision 且不提升质量等级。
 */
export function applyTimeMapSpanReviewDecision(
  timeMap: MediaTimeMap,
  spanIndex: number,
  decision: TimeMapSpanReviewDecision,
  reviewedAt: string
): MediaTimeMap {
  if (timeMap.state !== "candidate") {
    throw new TimeMapSpanReviewError("只能修改尚未确认的候选时间图；请先撤销已确认关系。");
  }
  if (!Number.isSafeInteger(spanIndex) || spanIndex < 0 || spanIndex >= timeMap.spans.length) {
    throw new TimeMapSpanReviewError("要分类的时间图片段不存在。");
  }
  if (!isIsoTimestamp(reviewedAt)) {
    throw new TimeMapSpanReviewError("人工分类时间必须是有效的 ISO 时间戳。");
  }
  const span = timeMap.spans[spanIndex];
  const availability = describeTimeMapSpanReviewAvailability(span, decision);
  if (!availability.allowed) {
    throw new TimeMapSpanReviewError(`${availability.reason} 当前分类未写入。`);
  }
  const spans = timeMap.spans.map((current, index) => {
    const complete = isCompleteTimeMapSpanEvidence(current)
      ? { ...current }
      : normalizeLegacyUnverifiedTimeMapSpanEvidence(current, {
          id: current.id ?? `${timeMap.id}:span:${String(index + 1).padStart(4, "0")}`,
          blocked: timeMap.quality.level === "blocked"
        });
    if (index !== spanIndex) {
      return complete;
    }
    return invalidateTimeMapSpanEvidenceForManualReview(
      { ...complete, kind: availability.desiredKind },
      decision === "unresolved",
      `第 ${spanIndex + 1} 段由人工分类为“${TIME_MAP_SPAN_REVIEW_LABELS[decision]}”，原算法为旧分类生成的逐段证据已失效。`
    );
  });
  const validation = validateTimeMap(spans);
  if (!validation.valid) {
    throw new TimeMapSpanReviewError(
      `分类后的时间图结构无效，未写入：${validation.issues[0]?.message ?? "未知结构错误"}`
    );
  }
  const reviewNote = serializeTimeMapSpanReview({ spanIndex, decision, reviewedAt });
  const retainedNotes = timeMap.evidence.notes.filter(
    (note) =>
      !note.startsWith(`${REVIEW_NOTE_PREFIX}${spanIndex}:`) &&
      !note.startsWith(`${PLAYBACK_REVIEW_PREFIX}${spanIndex}:`) &&
      !note.startsWith(`${LEGACY_PLAYBACK_REVIEW_PREFIX}${spanIndex}:`)
  );
  const evidence = {
    ...timeMap.evidence,
    types: appendUnique(timeMap.evidence.types, "manual"),
    notes: [...retainedNotes, reviewNote]
  };
  const reviewedMap: MediaTimeMap = {
    ...timeMap,
    revision: timeMap.revision + 1,
    spans,
    quality: {
      ...timeMap.quality,
      level: "blocked",
      reasons: uniqueStrings([
        ...timeMap.quality.reasons,
        `第 ${spanIndex + 1} 段已人工分类为“${TIME_MAP_SPAN_REVIEW_LABELS[decision]}”；分类会使该段旧播放证据失效，必须重新完成 A/B 复核。`
      ])
    },
    evidence,
    verification: null,
    updatedAt: reviewedAt
  };
  return reconcileCandidateTimeMapManualReview(readinessWithoutPlayback(reviewedMap));
}

export function reviewCandidateTimeMapSpan(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  decision: TimeMapSpanReviewDecision,
  reviewedAt: string,
  precision: AlignmentReviewPrecision = "rough"
): EditorProject {
  const timeMap = project.mediaTimeMaps.find((item) => item.id === timeMapId);
  if (!timeMap) {
    throw new TimeMapSpanReviewError("候选时间图不存在，无法保存人工分类。");
  }
  const candidate = project.mediaMatchCandidates.find(
    (item) =>
      item.timeMapId === timeMapId && (item.state === "pending" || item.state === "blocked")
  );
  if (!candidate) {
    throw new TimeMapSpanReviewError("该时间图不再属于待复核候选，无法保存人工分类。");
  }
  const reviewedMap = applyTimeMapSpanReviewDecision(timeMap, spanIndex, decision, reviewedAt);
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === candidate.sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  const reviewedProposalTimeMap = candidate.proposal.timeMap
    ? {
        ...candidate.proposal.timeMap,
        spans: structuredClone(reviewedMap.spans),
        quality: structuredClone(reviewedMap.quality),
        evidence: {
          ...candidate.proposal.timeMap.evidence,
          types: [...reviewedMap.evidence.types],
          audioAnchorCount: reviewedMap.evidence.audioAnchorCount,
          visualAnchorCount: reviewedMap.evidence.visualAnchorCount,
          heldOutAnchorCount: reviewedMap.evidence.heldOutAnchorCount,
          notes: [...reviewedMap.evidence.notes]
        }
      }
    : undefined;
  const reviewedCandidate = {
    ...candidate,
    state: hasBoundAsset && reviewedMap.quality.level !== "blocked" ? "pending" : "blocked",
    proposal: reviewedProposalTimeMap
      ? { ...candidate.proposal, timeMap: reviewedProposalTimeMap }
      : candidate.proposal,
    updatedAt: reviewedAt
  } satisfies typeof candidate;
  const reviewedProject: EditorProject = {
    ...project,
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id ? reviewedCandidate : item
    ),
    mediaTimeMaps: project.mediaTimeMaps.map((item) =>
      item.id === timeMapId ? reviewedMap : item
    )
  };
  return appendAlignmentReviewRecord(project, reviewedProject, {
    timeMapId,
    spanIndex,
    decision,
    precision,
    action: "classifySpan",
    reviewedAt
  });
}

/**
 * 人工同时改写一段的双轴边界和语义。相邻段共享的边界会一起移动，避免留下重叠或空洞。
 * 结构改变后所有旧的逐段分类、播放证据、接管记录和安装级验证都失效。
 */
export function editCandidateTimeMapSpan(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  patch: ManualTimeMapSpanPatch,
  editedAt: string
): EditorProject {
  const { timeMap, candidate } = requireEditableCandidateTimeMap(project, timeMapId);
  assertSpanIndex(timeMap, spanIndex, "要调整的时间图片段不存在。");
  assertIsoTimestamp(editedAt, "人工调整时间必须是有效的 ISO 时间戳。");
  assertManualSpanPatch(patch);

  const completeSpans = normalizeCandidateSpans(timeMap);
  const touchedIndexes = new Set<number>([spanIndex]);
  const spans = completeSpans.map((span) => ({ ...span }));
  const current = spans[spanIndex];
  spans[spanIndex] = {
    ...current,
    ...patch
  };
  if (spanIndex > 0) {
    touchedIndexes.add(spanIndex - 1);
    spans[spanIndex - 1] = {
      ...spans[spanIndex - 1],
      sourceEndMs: patch.sourceStartMs,
      targetEndMs: patch.targetStartMs
    };
  }
  if (spanIndex + 1 < spans.length) {
    touchedIndexes.add(spanIndex + 1);
    spans[spanIndex + 1] = {
      ...spans[spanIndex + 1],
      sourceStartMs: patch.sourceEndMs,
      targetStartMs: patch.targetEndMs
    };
  }
  const invalidatedSpans = spans.map((span, index) =>
    touchedIndexes.has(index)
      ? invalidateTimeMapSpanEvidenceForManualReview(
          span,
          false,
          `第 ${index + 1} 段边界受人工调整影响，原算法证据与旧播放复核已失效。`
        )
      : span
  );
  assertValidManualStructure(invalidatedSpans, "边界调整");
  const editedMap = createManuallyStructuredCandidateMap(
    timeMap,
    invalidatedSpans,
    editedAt,
    `用户调整了第 ${spanIndex + 1} 段的双轴边界与类型。`
  );
  return replaceEditableCandidateTimeMap(project, candidate.id, editedMap);
}

/**
 * 在用户指定的双轴位置拆分一段。零长度轴必须保留在原边界点；正长度轴必须严格位于
 * 区间内部。拆分不会自动声称新边界准确，必须重新 A/B 复核或明确接管。
 */
export function splitCandidateTimeMapSpan(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  point: ManualTimeMapSplitPoint,
  editedAt: string
): EditorProject {
  const { timeMap, candidate } = requireEditableCandidateTimeMap(project, timeMapId);
  assertSpanIndex(timeMap, spanIndex, "要拆分的时间图片段不存在。");
  assertIsoTimestamp(editedAt, "人工拆分时间必须是有效的 ISO 时间戳。");
  assertMilliseconds(point.sourceMs, "参考拆分位置");
  assertMilliseconds(point.targetMs, "原片拆分位置");

  const spans = normalizeCandidateSpans(timeMap);
  const span = spans[spanIndex];
  assertSplitCoordinate(
    point.sourceMs,
    span.sourceStartMs,
    span.sourceEndMs,
    "参考拆分位置"
  );
  assertSplitCoordinate(
    point.targetMs,
    span.targetStartMs,
    span.targetEndMs,
    "原片拆分位置"
  );
  const idStem = `${span.id}:manual-split:${timeMap.revision + 1}`;
  const left = invalidateTimeMapSpanEvidenceForManualReview(
    {
      ...span,
      id: `${idStem}:left`,
      sourceEndMs: point.sourceMs,
      targetEndMs: point.targetMs
    },
    false,
    `第 ${spanIndex + 1} 段由用户拆分，新左段需要重新复核。`
  );
  const right = invalidateTimeMapSpanEvidenceForManualReview(
    {
      ...span,
      id: `${idStem}:right`,
      sourceStartMs: point.sourceMs,
      targetStartMs: point.targetMs
    },
    false,
    `第 ${spanIndex + 1} 段由用户拆分，新右段需要重新复核。`
  );
  const nextSpans = [...spans.slice(0, spanIndex), left, right, ...spans.slice(spanIndex + 1)];
  assertValidManualStructure(nextSpans, "拆分");
  const editedMap = createManuallyStructuredCandidateMap(
    timeMap,
    nextSpans,
    editedAt,
    `用户在参考 ${point.sourceMs} ms / 原片 ${point.targetMs} ms 拆分了第 ${spanIndex + 1} 段。`
  );
  return replaceEditableCandidateTimeMap(project, candidate.id, editedMap);
}

/**
 * 把一个双边 ambiguous 段原子改写成“共同内容 + 原片独有 + 共同内容”。
 *
 * 与通用双轴拆分不同，该动作允许参考侧在 gap 处保持零长度；这是审核删减和
 * 原片插入内容的真实结构。调用者只需给出原片独有范围和参考接缝，不需要先制造
 * 1 ms 伪区间。周围仍有双边内容时，由用户这次明确判断为共同内容。
 */
export function resolveOriginalOnlyGap(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  input: ResolveOriginalOnlyGapInput,
  editedAt: string,
  precision: AlignmentReviewPrecision = "rough"
): EditorProject {
  return resolveOneSidedGap(
    project,
    timeMapId,
    spanIndex,
    {
      kind: "targetOnly",
      sourceStartMs: input.sourceAtMs,
      sourceEndMs: input.sourceAtMs,
      targetStartMs: input.targetStartMs,
      targetEndMs: input.targetEndMs
    },
    editedAt,
    precision
  );
}

/** “原片独有”的镜像动作：把参考中独有的一段保存为 sourceOnly。 */
export function resolveReferenceOnlyGap(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  input: ResolveReferenceOnlyGapInput,
  editedAt: string,
  precision: AlignmentReviewPrecision = "rough"
): EditorProject {
  return resolveOneSidedGap(
    project,
    timeMapId,
    spanIndex,
    {
      kind: "sourceOnly",
      sourceStartMs: input.sourceStartMs,
      sourceEndMs: input.sourceEndMs,
      targetStartMs: input.targetAtMs,
      targetEndMs: input.targetAtMs
    },
    editedAt,
    precision
  );
}

/**
 * 合并当前段与下一段。只有相同类型才允许合并，避免把“共同内容+删减”静默抹平成
 * 一条仿射线。合并后仍需重新复核。
 */
export function mergeCandidateTimeMapSpanWithNext(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  editedAt: string
): EditorProject {
  const { timeMap, candidate } = requireEditableCandidateTimeMap(project, timeMapId);
  assertSpanIndex(timeMap, spanIndex, "要合并的时间图片段不存在。");
  assertIsoTimestamp(editedAt, "人工合并时间必须是有效的 ISO 时间戳。");
  const spans = normalizeCandidateSpans(timeMap);
  const left = spans[spanIndex];
  const right = spans[spanIndex + 1];
  if (!right) {
    throw new TimeMapSpanReviewError("最后一段后面没有可合并的分段。");
  }
  if (left.kind !== right.kind) {
    throw new TimeMapSpanReviewError(
      "只有相同类型的相邻段可以直接合并；请先在边界编辑中统一类型。"
    );
  }
  const merged = invalidateTimeMapSpanEvidenceForManualReview(
    {
      ...left,
      id: `${left.id}:manual-merge:${timeMap.revision + 1}`,
      sourceEndMs: right.sourceEndMs,
      targetEndMs: right.targetEndMs
    },
    false,
    `第 ${spanIndex + 1}、${spanIndex + 2} 段由用户合并，合并段需要重新复核。`
  );
  const nextSpans = [
    ...spans.slice(0, spanIndex),
    merged,
    ...spans.slice(spanIndex + 2)
  ];
  assertValidManualStructure(nextSpans, "合并");
  const editedMap = createManuallyStructuredCandidateMap(
    timeMap,
    nextSpans,
    editedAt,
    `用户合并了第 ${spanIndex + 1}、${spanIndex + 2} 段。`
  );
  return replaceEditableCandidateTimeMap(project, candidate.id, editedMap);
}

export function readTimeMapSpanReviewDecision(
  timeMap: MediaTimeMap,
  spanIndex: number
): RecordedTimeMapSpanReview | null {
  return readReviewDecisionFromNotes(timeMap.evidence.notes, spanIndex);
}

export interface CandidateTimeMapManualReviewReadiness {
  timeMap: MediaTimeMap;
  playbackReviewedSpanIndexes: ReadonlySet<number>;
}

/**
 * 只有每一段都完成了与当前边界绑定的 A/B 播放，且所有差异段都有明确人工分类时，
 * blocked 候选才可降为 review。这里不修改算法指标，也不签发 verified。
 */
export function reconcileCandidateTimeMapManualReview(
  input: CandidateTimeMapManualReviewReadiness
): MediaTimeMap {
  const { timeMap, playbackReviewedSpanIndexes } = input;
  const validation = validateTimeMap(timeMap.spans);
  const issues: string[] = [];
  if (!validation.valid) {
    issues.push(validation.issues[0]?.message ?? "时间图结构无效。");
  }
  if (!timeMap.sourceIdentity || !timeMap.targetIdentity) {
    issues.push("源文件或目标文件缺少内容身份快照。");
  }
  timeMap.spans.forEach((span, spanIndex) => {
    if (!isCompleteTimeMapSpanEvidence(span)) {
      issues.push(`第 ${spanIndex + 1} 段缺少完整逐段证据。`);
      return;
    }
    if (
      span.quality.level === "blocked" ||
      span.quality.level === "legacy-unverified"
    ) {
      issues.push(`第 ${spanIndex + 1} 段仍为 ${span.quality.level}。`);
    }
    if (!playbackReviewedSpanIndexes.has(spanIndex)) {
      issues.push(`第 ${spanIndex + 1} 段尚未完成 A/B 播放复核。`);
    }
    const decision = readReviewDecisionFromNotes(timeMap.evidence.notes, spanIndex)?.decision;
    if (span.kind === "sourceOnly" && decision !== "source-extra") {
      issues.push(`第 ${spanIndex + 1} 段尚未确认为“参考多出”。`);
    } else if (span.kind === "targetOnly" && decision !== "target-extra") {
      issues.push(`第 ${spanIndex + 1} 段尚未确认为“原片多出”。`);
    } else if (span.kind === "ambiguous" && decision !== "replacement") {
      issues.push(`第 ${spanIndex + 1} 段仍未确认为“版本替换”。`);
    }
  });

  const retainedReasons = timeMap.quality.reasons.filter(
    (reason) => !reason.startsWith(MANUAL_REVIEW_STATE_REASON_PREFIX)
  );
  const stateReason =
    issues.length === 0
      ? `${MANUAL_REVIEW_STATE_REASON_PREFIX}全部 ${timeMap.spans.length} 段均已完成 A/B 播放与必要分类，可进入确认；算法质量指标保持原值。`
      : `${MANUAL_REVIEW_STATE_REASON_PREFIX}尚有 ${issues.length} 项未完成：${issues
          .slice(0, 3)
          .join("；")}${issues.length > 3 ? "；其余请逐段检查。" : ""}`;
  return {
    ...timeMap,
    quality: {
      ...timeMap.quality,
      level: issues.length === 0 ? "review" : "blocked",
      reasons: uniqueStrings([...retainedReasons, stateReason])
    }
  };
}

function readinessWithoutPlayback(
  timeMap: MediaTimeMap
): CandidateTimeMapManualReviewReadiness {
  return { timeMap, playbackReviewedSpanIndexes: new Set<number>() };
}

function readReviewDecisionFromNotes(
  notes: readonly string[],
  spanIndex: number
): RecordedTimeMapSpanReview | null {
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const parsed = parseTimeMapSpanReview(notes[index] ?? "");
    if (parsed?.spanIndex === spanIndex) {
      return parsed;
    }
  }
  return null;
}

function requireEditableCandidateTimeMap(
  project: EditorProject,
  timeMapId: string
): {
  timeMap: MediaTimeMap;
  candidate: EditorProject["mediaMatchCandidates"][number];
} {
  const timeMap = project.mediaTimeMaps.find((item) => item.id === timeMapId);
  if (!timeMap || timeMap.state !== "candidate") {
    throw new TimeMapSpanReviewError("只能编辑尚未确认的候选时间图。");
  }
  const candidate = project.mediaMatchCandidates.find(
    (item) =>
      item.timeMapId === timeMapId && (item.state === "pending" || item.state === "blocked")
  );
  if (!candidate) {
    throw new TimeMapSpanReviewError("该时间图不再属于待复核候选，无法编辑结构。");
  }
  return { timeMap, candidate };
}

function replaceEditableCandidateTimeMap(
  project: EditorProject,
  candidateId: string,
  editedMap: MediaTimeMap
): EditorProject {
  const candidate = project.mediaMatchCandidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new TimeMapSpanReviewError("待更新的匹配候选不存在。");
  }
  const proposalTimeMap = candidate.proposal.timeMap
    ? {
        ...candidate.proposal.timeMap,
        sourceStartMs: editedMap.sourceStartMs,
        sourceEndMs: editedMap.sourceEndMs,
        targetStartMs: editedMap.targetStartMs,
        targetEndMs: editedMap.targetEndMs,
        spans: structuredClone(editedMap.spans),
        quality: structuredClone(editedMap.quality),
        evidence: {
          ...candidate.proposal.timeMap.evidence,
          types: [...editedMap.evidence.types],
          audioAnchorCount: editedMap.evidence.audioAnchorCount,
          visualAnchorCount: editedMap.evidence.visualAnchorCount,
          heldOutAnchorCount: editedMap.evidence.heldOutAnchorCount,
          notes: [...editedMap.evidence.notes]
        }
      }
    : undefined;
  const matchRange = candidate.proposal.matchRange
    ? {
        ...candidate.proposal.matchRange,
        sourceStartMs: editedMap.sourceStartMs,
        sourceEndMs: editedMap.sourceEndMs,
        targetStartMs: editedMap.targetStartMs,
        targetEndMs: editedMap.targetEndMs
      }
    : undefined;
  const updatedCandidate = {
    ...candidate,
    sourceStartMs: editedMap.sourceStartMs,
    sourceEndMs: editedMap.sourceEndMs,
    targetStartMs: editedMap.targetStartMs,
    targetEndMs: editedMap.targetEndMs,
    state: "blocked" as const,
    proposal: {
      ...candidate.proposal,
      matchRange,
      timeMap: proposalTimeMap
    },
    updatedAt: editedMap.updatedAt
  };
  return {
    ...project,
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidateId ? updatedCandidate : item
    ),
    mediaTimeMaps: project.mediaTimeMaps.map((item) =>
      item.id === editedMap.id ? editedMap : item
    )
  };
}

function createManuallyStructuredCandidateMap(
  timeMap: MediaTimeMap,
  spans: MediaTimeMap["spans"],
  editedAt: string,
  reason: string
): MediaTimeMap {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (!first || !last) {
    throw new TimeMapSpanReviewError("时间图至少需要保留一个分段。");
  }
  const notes = timeMap.evidence.notes.filter(
    (note) =>
      !note.startsWith(REVIEW_NOTE_PREFIX) &&
      !note.startsWith(PLAYBACK_REVIEW_PREFIX) &&
      !note.startsWith(LEGACY_PLAYBACK_REVIEW_PREFIX) &&
      !note.startsWith(MANUAL_TAKEOVER_NOTE_PREFIX)
  );
  const nextMap: MediaTimeMap = {
    ...timeMap,
    revision: timeMap.revision + 1,
    sourceStartMs: first.sourceStartMs,
    sourceEndMs: last.sourceEndMs,
    targetStartMs: first.targetStartMs,
    targetEndMs: last.targetEndMs,
    spans,
    quality: {
      ...timeMap.quality,
      level: "blocked",
      reasons: uniqueStrings([
        ...timeMap.quality.reasons.filter(
          (item) => !item.startsWith(MANUAL_REVIEW_STATE_REASON_PREFIX)
        ),
        reason,
        "人工修改已撤销旧验证和旧播放证据；可继续逐段复核，或明确采用当前最高可能方案后签发。"
      ])
    },
    evidence: {
      ...timeMap.evidence,
      types: appendUnique(timeMap.evidence.types, "manual"),
      notes: [
        ...notes,
        `${MANUAL_STRUCTURE_EDIT_NOTE_PREFIX}${editedAt}:${reason}`
      ]
    },
    verification: null,
    updatedAt: editedAt
  };
  return reconcileCandidateTimeMapManualReview(readinessWithoutPlayback(nextMap));
}

function resolveOneSidedGap(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  gap: ManualTimeMapSpanPatch,
  editedAt: string,
  precision: AlignmentReviewPrecision
): EditorProject {
  const { timeMap, candidate } = requireEditableCandidateTimeMap(project, timeMapId);
  assertSpanIndex(timeMap, spanIndex, "要处理的时间图片段不存在。");
  assertIsoTimestamp(editedAt, "人工标记差异的时间必须是有效的 ISO 时间戳。");
  assertManualSpanPatch(gap);
  if (gap.kind !== "sourceOnly" && gap.kind !== "targetOnly") {
    throw new TimeMapSpanReviewError("单侧差异只能标记为参考独有或原片独有。");
  }

  const spans = normalizeCandidateSpans(timeMap);
  const span = spans[spanIndex];
  if (span.kind !== "ambiguous") {
    throw new TimeMapSpanReviewError("只有尚未判断的双边区间可以直接拆成单侧差异。");
  }
  assertGapInsideSpan(span, gap);

  const idStem = `${span.id}:manual-gap:${timeMap.revision + 1}`;
  const replacement: MediaTimeMap["spans"] = [];
  if (
    gap.sourceStartMs > span.sourceStartMs ||
    gap.targetStartMs > span.targetStartMs
  ) {
    assertMatchedRemainderShape(
      span.sourceStartMs,
      gap.sourceStartMs,
      span.targetStartMs,
      gap.targetStartMs,
      "差异前"
    );
    replacement.push(
      invalidateTimeMapSpanEvidenceForManualReview(
        {
          ...span,
          id: `${idStem}:before`,
          kind: "matched",
          sourceEndMs: gap.sourceStartMs,
          targetEndMs: gap.targetStartMs
        },
        false,
        `第 ${spanIndex + 1} 段差异前的内容由用户确认为共同内容，需要重新 A/B 复核。`
      )
    );
  }

  const gapIndex = spanIndex + replacement.length;
  replacement.push(
    invalidateTimeMapSpanEvidenceForManualReview(
      {
        ...span,
        ...gap,
        id: `${idStem}:gap`
      },
      false,
      gap.kind === "targetOnly"
        ? "用户标记了原片中参考素材没有的内容；边界需要重新 A/B 复核。"
        : "用户标记了参考素材中原片没有的内容；边界需要重新 A/B 复核。"
    )
  );

  if (gap.sourceEndMs < span.sourceEndMs || gap.targetEndMs < span.targetEndMs) {
    assertMatchedRemainderShape(
      gap.sourceEndMs,
      span.sourceEndMs,
      gap.targetEndMs,
      span.targetEndMs,
      "差异后"
    );
    replacement.push(
      invalidateTimeMapSpanEvidenceForManualReview(
        {
          ...span,
          id: `${idStem}:after`,
          kind: "matched",
          sourceStartMs: gap.sourceEndMs,
          targetStartMs: gap.targetEndMs
        },
        false,
        `第 ${spanIndex + 1} 段差异后的内容由用户确认为共同内容，需要重新 A/B 复核。`
      )
    );
  }

  const nextSpans = [
    ...spans.slice(0, spanIndex),
    ...replacement,
    ...spans.slice(spanIndex + 1)
  ];
  assertValidManualStructure(nextSpans, "标记单侧差异");
  const reason =
    gap.kind === "targetOnly"
      ? `用户将原片 ${gap.targetStartMs}-${gap.targetEndMs} ms 标记为原片独有。`
      : `用户将参考 ${gap.sourceStartMs}-${gap.sourceEndMs} ms 标记为参考独有。`;
  const structuredMap = createManuallyStructuredCandidateMap(
    timeMap,
    nextSpans,
    editedAt,
    reason
  );
  const reviewedMap = reconcileCandidateTimeMapManualReview(
    readinessWithoutPlayback({
      ...structuredMap,
      evidence: {
        ...structuredMap.evidence,
        notes: [
          ...structuredMap.evidence.notes,
          serializeTimeMapSpanReview({
            spanIndex: gapIndex,
            decision: gap.kind === "targetOnly" ? "target-extra" : "source-extra",
            reviewedAt: editedAt
          })
        ]
      }
    })
  );
  const reviewedProject = replaceEditableCandidateTimeMap(project, candidate.id, reviewedMap);
  return appendAlignmentReviewRecord(project, reviewedProject, {
    timeMapId,
    spanIndex,
    decision: gap.kind === "targetOnly" ? "target-extra" : "source-extra",
    precision,
    action: "resolveOneSidedGap",
    reviewedAt: editedAt,
    labeledRange: {
      sourceStartMs: gap.sourceStartMs,
      sourceEndMs: gap.sourceEndMs,
      targetStartMs: gap.targetStartMs,
      targetEndMs: gap.targetEndMs
    }
  });
}

function assertGapInsideSpan(span: TimeMapSpan, gap: ManualTimeMapSpanPatch): void {
  if (
    gap.sourceStartMs < span.sourceStartMs ||
    gap.sourceEndMs > span.sourceEndMs ||
    gap.targetStartMs < span.targetStartMs ||
    gap.targetEndMs > span.targetEndMs
  ) {
    throw new TimeMapSpanReviewError("所选单侧差异必须完整位于当前无法判断区间内。");
  }
  const sourceDurationMs = gap.sourceEndMs - gap.sourceStartMs;
  const targetDurationMs = gap.targetEndMs - gap.targetStartMs;
  if (
    (gap.kind === "targetOnly" && (sourceDurationMs !== 0 || targetDurationMs <= 0)) ||
    (gap.kind === "sourceOnly" && (sourceDurationMs <= 0 || targetDurationMs !== 0))
  ) {
    throw new TimeMapSpanReviewError("单侧差异的另一条时间轴必须保持在同一个接缝点。");
  }
}

function assertMatchedRemainderShape(
  sourceStartMs: number,
  sourceEndMs: number,
  targetStartMs: number,
  targetEndMs: number,
  label: string
): void {
  const sourceDurationMs = sourceEndMs - sourceStartMs;
  const targetDurationMs = targetEndMs - targetStartMs;
  if (sourceDurationMs <= 0 || targetDurationMs <= 0) {
    throw new TimeMapSpanReviewError(
      `${label}若仍有内容，参考和原片两侧都必须保留正长度；请重新调整差异边界。`
    );
  }
}

function normalizeCandidateSpans(timeMap: MediaTimeMap) {
  return timeMap.spans.map((span, spanIndex) =>
    isCompleteTimeMapSpanEvidence(span)
      ? { ...span }
      : normalizeLegacyUnverifiedTimeMapSpanEvidence(span, {
          id: span.id ?? `${timeMap.id}:span:${String(spanIndex + 1).padStart(4, "0")}`,
          blocked: true
        })
  );
}

function assertManualSpanPatch(patch: ManualTimeMapSpanPatch): void {
  assertMilliseconds(patch.sourceStartMs, "参考开始");
  assertMilliseconds(patch.sourceEndMs, "参考结束");
  assertMilliseconds(patch.targetStartMs, "原片开始");
  assertMilliseconds(patch.targetEndMs, "原片结束");
  if (patch.sourceEndMs < patch.sourceStartMs || patch.targetEndMs < patch.targetStartMs) {
    throw new TimeMapSpanReviewError("片段结束时间不能早于开始时间。");
  }
}

function assertSpanIndex(timeMap: MediaTimeMap, spanIndex: number, message: string): void {
  if (!Number.isSafeInteger(spanIndex) || spanIndex < 0 || spanIndex >= timeMap.spans.length) {
    throw new TimeMapSpanReviewError(message);
  }
}

function assertMilliseconds(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TimeMapSpanReviewError(`${label}必须是非负整数毫秒。`);
  }
}

function assertIsoTimestamp(value: string, message: string): void {
  if (!isIsoTimestamp(value)) {
    throw new TimeMapSpanReviewError(message);
  }
}

function assertSplitCoordinate(
  point: number,
  startMs: number,
  endMs: number,
  label: string
): void {
  if (startMs === endMs) {
    if (point !== startMs) {
      throw new TimeMapSpanReviewError(`${label}所在轴是边界点，必须保持 ${startMs} ms。`);
    }
    return;
  }
  if (point <= startMs || point >= endMs) {
    throw new TimeMapSpanReviewError(`${label}必须严格位于当前分段内部。`);
  }
}

function assertValidManualStructure(
  spans: readonly TimeMapSpan[],
  action: string
): void {
  const validation = validateTimeMap(spans);
  if (!validation.valid) {
    throw new TimeMapSpanReviewError(
      `${action}后的时间图结构无效，未写入：${validation.issues[0]?.message ?? "未知结构错误"}`
    );
  }
}

function decisionToSpanKind(decision: TimeMapSpanReviewDecision): TimeMapSpanKind {
  if (decision === "source-extra") return "sourceOnly";
  if (decision === "target-extra") return "targetOnly";
  return "ambiguous";
}

function serializeTimeMapSpanReview(review: RecordedTimeMapSpanReview): string {
  return `${REVIEW_NOTE_PREFIX}${review.spanIndex}:${review.decision}:${review.reviewedAt}`;
}

function parseTimeMapSpanReview(note: string): RecordedTimeMapSpanReview | null {
  if (!note.startsWith(REVIEW_NOTE_PREFIX)) {
    return null;
  }
  const fields = note.slice(REVIEW_NOTE_PREFIX.length).split(":");
  if (fields.length < 4) {
    return null;
  }
  const spanIndex = Number(fields[0]);
  const decision = fields[1];
  const reviewedAt = fields.slice(2).join(":");
  if (
    !Number.isSafeInteger(spanIndex) ||
    spanIndex < 0 ||
    !isTimeMapSpanReviewDecision(decision) ||
    !isIsoTimestamp(reviewedAt)
  ) {
    return null;
  }
  return { spanIndex, decision, reviewedAt };
}

function isTimeMapSpanReviewDecision(value: string): value is TimeMapSpanReviewDecision {
  return (
    value === "source-extra" ||
    value === "target-extra" ||
    value === "replacement" ||
    value === "unresolved"
  );
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function appendUnique<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
