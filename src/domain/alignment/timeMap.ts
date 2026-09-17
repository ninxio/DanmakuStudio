import type { Milliseconds } from "../shared/time";
import { statusLabel, type WorkspaceStatusId } from "../shared/statusVocabulary";

/**
 * 时间映射使用两条半开时间轴。非零区间均为 [start, end)，零长度区间表示轴上的点。
 * 所有值必须是非负安全整数毫秒。
 */
export type TimeMapSpanKind = "matched" | "sourceOnly" | "targetOnly" | "ambiguous";

export type TimeMapSpanSignalStatus = "used" | "blocked" | "conflict";
export type TimeMapSpanSupportStatus =
  | "supported"
  | "unsupported"
  | "notApplicable"
  | "legacyUnverified";
export type TimeMapBoundaryStatus =
  | "refined"
  | "ambiguous"
  | "unsupported"
  | "notApplicable"
  | "legacyUnverified";
export type TimeMapBoundaryAxis = "source" | "target" | "both";
export type TimeMapBoundaryContextSide = "before" | "after";

export interface TimeMapSpanSignalAssessment {
  audio: TimeMapSpanSignalStatus;
  visual: TimeMapSpanSignalStatus;
  danmaku: TimeMapSpanSignalStatus;
}

/**
 * 一段时间图自己的质量证据。逐段指标不能由整图指标复制或推导；没有真实逐段测量时
 * 必须使用 missing / null，并保守进入 legacy-unverified、review 或 blocked。
 */
export interface TimeMapSpanQuality {
  level: TimeMapQualityLevel;
  metricSource: TimeMapMetricSource;
  probability: number | null;
  coverage: number | null;
  uniqueContentCoverage: number | null;
  alternativeMargin: number | null;
  anchorCount: number;
  heldOutAnchorCount: number;
  p50ResidualMs: Milliseconds | null;
  p95ResidualMs: Milliseconds | null;
  p99ResidualMs: Milliseconds | null;
  maxResidualMs: Milliseconds | null;
  boundaryUncertaintyMs: Milliseconds | null;
  leftSupport: TimeMapSpanSupportStatus;
  rightSupport: TimeMapSpanSupportStatus;
  signals: TimeMapSpanSignalAssessment;
  reasons: string[];
}

export interface TimeMapBoundaryEvidence {
  status: TimeMapBoundaryStatus;
  axis: TimeMapBoundaryAxis | null;
  contextSide: TimeMapBoundaryContextSide | null;
  coarseMs: Milliseconds | null;
  refinedMs: Milliseconds | null;
  uncertaintyStartMs: Milliseconds | null;
  uncertaintyEndMs: Milliseconds | null;
  supportDurationMs: Milliseconds | null;
  correlation: number | null;
  alternativeMargin: number | null;
  reason: string;
}

export interface TimeMapSpanBoundaries {
  start: TimeMapBoundaryEvidence;
  end: TimeMapBoundaryEvidence;
}

export interface TimeMapSpanAlternative {
  kind: TimeMapSpanKind;
  score: number | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  reason: string;
}

export interface TimeMapSpan {
  kind: TimeMapSpanKind;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  /** 算法内部片段可以省略；进入 MediaTimeMap / 项目 v12 前必须完整。 */
  id?: string;
  reason?: string;
  quality?: TimeMapSpanQuality;
  boundaries?: TimeMapSpanBoundaries;
  alternatives?: TimeMapSpanAlternative[];
}

export interface CompleteTimeMapSpan extends TimeMapSpan {
  id: string;
  reason: string;
  quality: TimeMapSpanQuality;
  boundaries: TimeMapSpanBoundaries;
  alternatives: TimeMapSpanAlternative[];
}

export interface LegacyTimeMapSpanEvidenceOptions {
  id: string;
  blocked: boolean;
  reason?: string;
}

const LEGACY_SPAN_EVIDENCE_REASON =
  "旧项目没有保存可独立复核的逐段残差、留出锚点、边界支持和备选路径；必须重新分析或人工复核。";

/** 项目 v11 -> v12 专用：只补齐“缺失证据”的显式记录，绝不伪造测量值或提升等级。 */
export function normalizeLegacyUnverifiedTimeMapSpanEvidence(
  span: TimeMapSpan,
  options: LegacyTimeMapSpanEvidenceOptions
): CompleteTimeMapSpan {
  if (options.id.trim().length === 0) {
    throw new RangeError("旧时间图片段的稳定 ID 不能为空。");
  }
  const reason = options.reason?.trim() || LEGACY_SPAN_EVIDENCE_REASON;
  const boundary = (): TimeMapBoundaryEvidence => ({
    status: "legacyUnverified",
    axis: null,
    contextSide: null,
    coarseMs: null,
    refinedMs: null,
    uncertaintyStartMs: null,
    uncertaintyEndMs: null,
    supportDurationMs: null,
    correlation: null,
    alternativeMargin: null,
    reason
  });
  return {
    ...span,
    id: options.id,
    reason: "legacyUnverified",
    quality: {
      level: options.blocked ? "blocked" : "legacy-unverified",
      metricSource: "missing",
      probability: null,
      coverage: null,
      uniqueContentCoverage: null,
      alternativeMargin: null,
      anchorCount: 0,
      heldOutAnchorCount: 0,
      p50ResidualMs: null,
      p95ResidualMs: null,
      p99ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      leftSupport: "legacyUnverified",
      rightSupport: "legacyUnverified",
      signals: { audio: "blocked", visual: "blocked", danmaku: "blocked" },
      reasons: [reason]
    },
    boundaries: { start: boundary(), end: boundary() },
    alternatives: []
  };
}

/**
 * 人工改写片段分类后，旧算法为原分类生成的逐段证据已经不再适用。保留稳定 ID 和坐标，
 * 但清空算法指标、边界测量和备选路径，并显式要求重新复核。
 */
export function invalidateTimeMapSpanEvidenceForManualReview(
  span: CompleteTimeMapSpan,
  blocked: boolean,
  explanation: string
): CompleteTimeMapSpan {
  const reason = explanation.trim() || "人工改写了片段分类，原算法逐段证据已失效。";
  const boundary = (): TimeMapBoundaryEvidence => ({
    status: "unsupported",
    axis: null,
    contextSide: null,
    coarseMs: null,
    refinedMs: null,
    uncertaintyStartMs: null,
    uncertaintyEndMs: null,
    supportDurationMs: null,
    correlation: null,
    alternativeMargin: null,
    reason
  });
  return {
    ...span,
    reason: "manualReview",
    quality: {
      level: blocked ? "blocked" : "review",
      metricSource: "missing",
      probability: null,
      coverage: null,
      uniqueContentCoverage: null,
      alternativeMargin: null,
      anchorCount: 0,
      heldOutAnchorCount: 0,
      p50ResidualMs: null,
      p95ResidualMs: null,
      p99ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      leftSupport: "unsupported",
      rightSupport: "unsupported",
      signals: { audio: "blocked", visual: "blocked", danmaku: "blocked" },
      reasons: [reason]
    },
    boundaries: { start: boundary(), end: boundary() },
    alternatives: []
  };
}

export function isCompleteTimeMapSpanEvidence(value: unknown): value is CompleteTimeMapSpan {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.reason) &&
    isTimeMapSpanQuality(value.quality) &&
    isTimeMapSpanBoundaries(value.boundaries) &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every(isTimeMapSpanAlternative)
  );
}

export type TimeMapValidationIssueCode =
  | "invalidMilliseconds"
  | "invalidRange"
  | "invalidKindShape"
  | "emptyAmbiguousSpan"
  | "outOfOrder"
  | "sourceOverlap"
  | "targetOverlap"
  | "sourceDiscontinuity"
  | "targetDiscontinuity";

export interface TimeMapValidationIssue {
  code: TimeMapValidationIssueCode;
  spanIndex: number;
  previousSpanIndex?: number;
  message: string;
}

export type TimeMapValidationResult =
  | { valid: true; issues: readonly [] }
  | { valid: false; issues: readonly TimeMapValidationIssue[] };

export class TimeMapValidationError extends Error {
  readonly issues: readonly TimeMapValidationIssue[];

  constructor(issues: readonly TimeMapValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("；"));
    this.name = "TimeMapValidationError";
    this.issues = issues;
  }
}

export function validateTimeMap(spans: readonly TimeMapSpan[]): TimeMapValidationResult {
  const issues: TimeMapValidationIssue[] = [];

  spans.forEach((span, spanIndex) => {
    const times = [span.sourceStartMs, span.sourceEndMs, span.targetStartMs, span.targetEndMs];
    if (!times.every(isNonNegativeIntegerMilliseconds)) {
      issues.push({
        code: "invalidMilliseconds",
        spanIndex,
        message: `时间映射第 ${spanIndex + 1} 段包含无效毫秒值。`
      });
      return;
    }

    if (span.sourceEndMs < span.sourceStartMs || span.targetEndMs < span.targetStartMs) {
      issues.push({
        code: "invalidRange",
        spanIndex,
        message: `时间映射第 ${spanIndex + 1} 段的结束时间早于开始时间。`
      });
      return;
    }

    const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
    const targetDurationMs = span.targetEndMs - span.targetStartMs;
    if (!hasValidKindShape(span.kind, sourceDurationMs, targetDurationMs)) {
      issues.push({
        code:
          span.kind === "ambiguous" && sourceDurationMs === 0 && targetDurationMs === 0
            ? "emptyAmbiguousSpan"
            : "invalidKindShape",
        spanIndex,
        message: createInvalidKindShapeMessage(span.kind, spanIndex)
      });
    }
  });

  for (let spanIndex = 1; spanIndex < spans.length; spanIndex += 1) {
    const previous = spans[spanIndex - 1];
    const current = spans[spanIndex];
    if (!hasValidCoordinates(previous) || !hasValidCoordinates(current)) {
      continue;
    }

    if (
      current.sourceStartMs < previous.sourceStartMs ||
      current.targetStartMs < previous.targetStartMs
    ) {
      issues.push({
        code: "outOfOrder",
        spanIndex,
        previousSpanIndex: spanIndex - 1,
        message: `时间映射第 ${spanIndex + 1} 段没有按两条时间轴单调排序。`
      });
    }

    compareBoundary(previous.sourceEndMs, current.sourceStartMs, "source", spanIndex, issues);
    compareBoundary(previous.targetEndMs, current.targetStartMs, "target", spanIndex, issues);
  }

  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}

export function assertValidTimeMap(spans: readonly TimeMapSpan[]): void {
  const result = validateTimeMap(spans);
  if (!result.valid) {
    throw new TimeMapValidationError(result.issues);
  }
}

export type TimeMapUnmappedReason =
  "emptyMap" | "beforeMap" | "afterMap" | "sourceOnly" | "targetOnlyBoundary";

export interface MappedSourceTime {
  status: "mapped";
  sourceTimeMs: Milliseconds;
  targetTimeMs: Milliseconds;
  spanIndex: number;
}

export interface UnmappedSourceTime {
  status: "unmapped";
  sourceTimeMs: Milliseconds;
  reason: TimeMapUnmappedReason;
  spanIndex?: number;
}

export interface AmbiguousSourceTime {
  status: "ambiguous";
  sourceTimeMs: Milliseconds;
  reason: "ambiguousSpan";
  spanIndex: number;
}

export type SourceTimeMapResult = MappedSourceTime | UnmappedSourceTime | AmbiguousSourceTime;

export interface CompiledTimeMap {
  readonly spans: readonly TimeMapSpan[];
  mapSourceTime(sourceTimeMs: Milliseconds): SourceTimeMapResult;
}

/**
 * 把来源时间投影到目标时间。matched 段执行整数毫秒的分段仿射插值；
 * sourceOnly 与 ambiguous 段不会被静默投影。
 */
export function mapSourceTime(
  spans: readonly TimeMapSpan[],
  sourceTimeMs: Milliseconds
): SourceTimeMapResult {
  return compileTimeMap(spans).mapSourceTime(sourceTimeMs);
}

/**
 * 一次校验并编译可复用的来源时间查找器。批量弹幕投影应复用本对象，避免每条弹幕
 * 重复校验整张图；正长度来源 span 使用二分定位，零长度事件保留边界语义。
 */
export function compileTimeMap(spans: readonly TimeMapSpan[]): CompiledTimeMap {
  assertValidTimeMap(spans);
  const stableSpans = spans.map((span) => ({ ...span }));
  const positiveSourceSpanIndices = stableSpans.flatMap((span, spanIndex) =>
    span.sourceEndMs > span.sourceStartMs ? [spanIndex] : []
  );
  const ambiguousPointIndices = new Map<number, number>();
  const targetOnlyPointIndices = new Map<number, number>();
  stableSpans.forEach((span, spanIndex) => {
    if (
      span.kind === "ambiguous" &&
      span.sourceStartMs === span.sourceEndMs &&
      !ambiguousPointIndices.has(span.sourceStartMs)
    ) {
      ambiguousPointIndices.set(span.sourceStartMs, spanIndex);
    }
    if (span.kind === "targetOnly" && !targetOnlyPointIndices.has(span.sourceStartMs)) {
      targetOnlyPointIndices.set(span.sourceStartMs, spanIndex);
    }
  });

  return {
    spans: stableSpans,
    mapSourceTime(sourceTimeMs: Milliseconds): SourceTimeMapResult {
      assertNonNegativeIntegerMilliseconds(sourceTimeMs, "待投影来源时间");
      return mapSourceTimeWithCompiledSpans(
        stableSpans,
        positiveSourceSpanIndices,
        ambiguousPointIndices,
        targetOnlyPointIndices,
        sourceTimeMs
      );
    }
  };
}

function mapSourceTimeWithCompiledSpans(
  spans: readonly TimeMapSpan[],
  positiveSourceSpanIndices: readonly number[],
  ambiguousPointIndices: ReadonlyMap<number, number>,
  targetOnlyPointIndices: ReadonlyMap<number, number>,
  sourceTimeMs: Milliseconds
): SourceTimeMapResult {

  if (spans.length === 0) {
    return { status: "unmapped", sourceTimeMs, reason: "emptyMap" };
  }

  // 零来源长度 ambiguous 表示“这个精确边界仍不确定”。它必须优先于从同一点开始的
  // 右侧 matched 半开区间，否则该显式歧义点会被二分查找静默吞掉。
  const ambiguousPointIndex = ambiguousPointIndices.get(sourceTimeMs);
  if (ambiguousPointIndex !== undefined) {
    return {
      status: "ambiguous",
      sourceTimeMs,
      reason: "ambiguousSpan",
      spanIndex: ambiguousPointIndex
    };
  }

  const containingSpanIndex = findContainingSourceSpanIndex(
    spans,
    positiveSourceSpanIndices,
    sourceTimeMs
  );
  if (containingSpanIndex !== null) {
    const span = spans[containingSpanIndex];
    if (span.kind === "matched") {
      return {
        status: "mapped",
        sourceTimeMs,
        targetTimeMs: interpolateMatchedSpan(span, sourceTimeMs),
        spanIndex: containingSpanIndex
      };
    }
    if (span.kind === "ambiguous") {
      return {
        status: "ambiguous",
        sourceTimeMs,
        reason: "ambiguousSpan",
        spanIndex: containingSpanIndex
      };
    }
    return {
      status: "unmapped",
      sourceTimeMs,
      reason: "sourceOnly",
      spanIndex: containingSpanIndex
    };
  }

  const targetOnlyIndex = targetOnlyPointIndices.get(sourceTimeMs);
  if (targetOnlyIndex !== undefined) {
    return {
      status: "unmapped",
      sourceTimeMs,
      reason: "targetOnlyBoundary",
      spanIndex: targetOnlyIndex
    };
  }

  const firstSourceMs = spans[0].sourceStartMs;
  return {
    status: "unmapped",
    sourceTimeMs,
    reason: sourceTimeMs < firstSourceMs ? "beforeMap" : "afterMap"
  };
}

function findContainingSourceSpanIndex(
  spans: readonly TimeMapSpan[],
  positiveSourceSpanIndices: readonly number[],
  sourceTimeMs: Milliseconds
): number | null {
  let low = 0;
  let high = positiveSourceSpanIndices.length - 1;
  let candidatePosition = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[positiveSourceSpanIndices[middle]];
    if (span.sourceStartMs <= sourceTimeMs) {
      candidatePosition = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidatePosition < 0) {
    return null;
  }
  const spanIndex = positiveSourceSpanIndices[candidatePosition];
  return sourceTimeMs < spans[spanIndex].sourceEndMs ? spanIndex : null;
}

export interface LegacyTimingRuleInput {
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
}

export interface LegacyTimeMapInput {
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  timingRules: readonly LegacyTimingRuleInput[];
}

export type LegacyTimeMapMigrationIssueCode =
  "invalidInput" | "invalidRule" | "negativeGap" | "zeroGapIgnored" | "timeOverflow";

export interface LegacyTimeMapMigrationIssue {
  code: LegacyTimeMapMigrationIssueCode;
  severity: "warning" | "error";
  message: string;
  ruleIndex?: number;
}

export interface LegacyTimeMapMigrationResult {
  status: "migrated" | "blocked";
  spans: readonly TimeMapSpan[];
  issues: readonly LegacyTimeMapMigrationIssue[];
}

/**
 * 把旧的“段首 + 累加 gap”模型确定性迁移为 spans。
 * 正 gap 是目标轴独有内容；负 gap 无法仅凭旧规则确定来源独有区间，因此阻断并把受影响余段标为 ambiguous。
 */
export function migrateLegacyTimeMap(input: LegacyTimeMapInput): LegacyTimeMapMigrationResult {
  const inputIssue = validateLegacyInput(input);
  if (inputIssue) {
    return { status: "blocked", spans: [], issues: [inputIssue] };
  }

  const indexedRules = input.timingRules
    .map((rule, ruleIndex) => ({ ...rule, ruleIndex }))
    .sort(
      (left, right) => left.sourceAtMs - right.sourceAtMs || left.ruleIndex - right.ruleIndex
    );
  const ruleIssues: LegacyTimeMapMigrationIssue[] = [];
  for (const rule of indexedRules) {
    if (
      !isNonNegativeIntegerMilliseconds(rule.sourceAtMs) ||
      !Number.isSafeInteger(rule.gapMs) ||
      rule.sourceAtMs < input.sourceStartMs ||
      rule.sourceAtMs > input.sourceEndMs
    ) {
      ruleIssues.push({
        code: "invalidRule",
        severity: "error",
        ruleIndex: rule.ruleIndex,
        message: `旧时间规则第 ${rule.ruleIndex + 1} 条不在来源段范围内或不是整数毫秒。`
      });
    }
  }
  if (ruleIssues.some((issue) => issue.severity === "error")) {
    return { status: "blocked", spans: [], issues: ruleIssues };
  }

  const spans: TimeMapSpan[] = [];
  const issues: LegacyTimeMapMigrationIssue[] = [];
  let currentSourceMs = input.sourceStartMs;
  let currentTargetMs = input.targetStartMs;
  let cursor = 0;

  while (cursor < indexedRules.length) {
    const sourceAtMs = indexedRules[cursor].sourceAtMs;
    const rulesAtBoundary: typeof indexedRules = [];
    while (cursor < indexedRules.length && indexedRules[cursor].sourceAtMs === sourceAtMs) {
      rulesAtBoundary.push(indexedRules[cursor]);
      cursor += 1;
    }

    const negativeRule = rulesAtBoundary.find((rule) => rule.gapMs < 0);
    if (negativeRule) {
      const matchedEndTargetMs = safeAdd(currentTargetMs, sourceAtMs - currentSourceMs);
      if (matchedEndTargetMs === null) {
        return blockedForOverflow(spans, issues);
      }
      appendMatchedSpan(
        spans,
        currentSourceMs,
        sourceAtMs,
        currentTargetMs,
        matchedEndTargetMs
      );
      currentTargetMs = matchedEndTargetMs;
      currentSourceMs = sourceAtMs;
      if (currentSourceMs < input.sourceEndMs) {
        spans.push({
          kind: "ambiguous",
          sourceStartMs: currentSourceMs,
          sourceEndMs: input.sourceEndMs,
          targetStartMs: currentTargetMs,
          targetEndMs: currentTargetMs
        });
      }
      issues.push({
        code: "negativeGap",
        severity: "error",
        ruleIndex: negativeRule.ruleIndex,
        message: `旧时间规则第 ${negativeRule.ruleIndex + 1} 条包含负 gap；旧数据没有删减区间双轴边界，已阻断受影响余段。`
      });
      assertValidTimeMap(spans);
      return { status: "blocked", spans, issues };
    }

    const matchedEndTargetMs = safeAdd(currentTargetMs, sourceAtMs - currentSourceMs);
    if (matchedEndTargetMs === null) {
      return blockedForOverflow(spans, issues);
    }
    appendMatchedSpan(spans, currentSourceMs, sourceAtMs, currentTargetMs, matchedEndTargetMs);
    currentSourceMs = sourceAtMs;
    currentTargetMs = matchedEndTargetMs;

    let positiveGapMs = 0;
    for (const rule of rulesAtBoundary) {
      if (rule.gapMs === 0) {
        issues.push({
          code: "zeroGapIgnored",
          severity: "warning",
          ruleIndex: rule.ruleIndex,
          message: `旧时间规则第 ${rule.ruleIndex + 1} 条 gap 为 0，迁移时已忽略。`
        });
        continue;
      }
      const nextGapMs = safeAdd(positiveGapMs, rule.gapMs);
      if (nextGapMs === null) {
        return blockedForOverflow(spans, issues);
      }
      positiveGapMs = nextGapMs;
    }

    if (positiveGapMs > 0) {
      const targetEndMs = safeAdd(currentTargetMs, positiveGapMs);
      if (targetEndMs === null) {
        return blockedForOverflow(spans, issues);
      }
      spans.push({
        kind: "targetOnly",
        sourceStartMs: currentSourceMs,
        sourceEndMs: currentSourceMs,
        targetStartMs: currentTargetMs,
        targetEndMs
      });
      currentTargetMs = targetEndMs;
    }
  }

  const targetEndMs = safeAdd(currentTargetMs, input.sourceEndMs - currentSourceMs);
  if (targetEndMs === null) {
    return blockedForOverflow(spans, issues);
  }
  appendMatchedSpan(spans, currentSourceMs, input.sourceEndMs, currentTargetMs, targetEndMs);
  assertValidTimeMap(spans);
  return { status: "migrated", spans, issues };
}

export type TimeMapEvidenceType = "audio" | "visual" | "manual" | "danmaku" | "legacy";
export type TimeMapMetricSource = "measured" | "estimated" | "missing";
export type TimeMapQualityLevel = "verified" | "review" | "blocked" | "legacy-unverified";

export interface TimeMapQualityInput {
  probability: number | null;
  coverage: number | null;
  uniqueContentCoverage?: number | null;
  p50ResidualMs: Milliseconds | null;
  p95ResidualMs: Milliseconds | null;
  /** v12 必填；旧调用方省略时按缺失处理，绝不能进入 verified。 */
  p99ResidualMs?: Milliseconds | null;
  maxResidualMs: Milliseconds | null;
  boundaryUncertaintyMs: Milliseconds | null;
  alternativeMargin: number | null;
  anchorCount: number;
  anchorRegionCount?: number;
  heldOutAnchorCount: number;
  metricSource: TimeMapMetricSource;
  evidenceTypes: readonly TimeMapEvidenceType[];
  audioAnchorCount: number;
  visualAnchorCount: number;
  evidenceHeldOutAnchorCount: number;
  sourceStreamType: "audio" | "video" | null;
  targetStreamType: "audio" | "video" | null;
}

export interface TimeMapQualityAssessment {
  level: TimeMapQualityLevel;
  reasons: readonly string[];
  hasCompleteMetrics: boolean;
}

export interface TimeMapQualityReconciliation {
  level: TimeMapQualityLevel;
  reasons: readonly string[];
  assessment: TimeMapQualityAssessment;
}

/**
 * 对时间映射应用保守质量门槛。verified 必须具备至少 99.5% 的金标准校准概率、
 * 完整实测指标，且由人工复核或音频与视觉两类独立证据共同支撑；估算值和缺失指标
 * 只能进入 review 或 blocked。音频/视觉声明必须有正锚点，并记录对应的双端流身份。
 * legacy-unverified 由持久化/迁移上层显式标记，本函数不会把新评估结果归为旧数据。
 */
export function assessTimeMapQuality(input: TimeMapQualityInput): TimeMapQualityAssessment {
  const reasons: string[] = [];
  const metricProblems = validateQualityMetrics(input);
  if (metricProblems.length > 0) {
    return { level: "blocked", reasons: metricProblems, hasCompleteMetrics: false };
  }

  const evidence = new Set(input.evidenceTypes);
  const hasPrimaryEvidence =
    evidence.has("audio") || evidence.has("visual") || evidence.has("manual");
  if (!hasPrimaryEvidence) {
    return {
      level: "blocked",
      reasons: ["缺少音频、视觉或人工复核证据，不能建立可用时间映射。"],
      hasCompleteMetrics: hasCompleteQualityMetrics(input)
    };
  }

  const hasCompleteMetrics = hasCompleteQualityMetrics(input);
  const evidenceIntegrityReasons = collectEvidenceIntegrityReasons(input);
  const blockingMetricReasons = collectBlockingMetricReasons(input);
  if (blockingMetricReasons.length > 0) {
    return {
      level: "blocked",
      reasons: blockingMetricReasons,
      hasCompleteMetrics
    };
  }

  if (!hasCompleteMetrics) {
    return {
      level: "review",
      reasons: ["质量指标不完整，必须进入人工复核。"],
      hasCompleteMetrics
    };
  }

  const coverage = input.coverage;
  const p95ResidualMs = input.p95ResidualMs;
  const p99ResidualMs = input.p99ResidualMs ?? null;
  const uniqueContentCoverage = input.uniqueContentCoverage ?? null;
  const anchorRegionCount = input.anchorRegionCount ?? 0;
  const boundaryUncertaintyMs = input.boundaryUncertaintyMs;
  const alternativeMargin = input.alternativeMargin;
  const probability = input.probability;

  const hasIndependentVerificationEvidence =
    evidence.has("manual") || (evidence.has("audio") && evidence.has("visual"));
  const meetsVerifiedMetrics =
    probability >= 0.995 &&
    coverage >= 0.9 &&
    p95ResidualMs <= 100 &&
    p99ResidualMs <= 500 &&
    boundaryUncertaintyMs <= 250 &&
    alternativeMargin >= 0.25 &&
    input.anchorCount >= 30 &&
    anchorRegionCount >= 3 &&
    uniqueContentCoverage !== null &&
    uniqueContentCoverage >= 0.8;
  if (
    input.metricSource === "measured" &&
    hasIndependentVerificationEvidence &&
    evidenceIntegrityReasons.length === 0 &&
    meetsVerifiedMetrics
  ) {
    return {
      level: "verified",
      reasons: ["完整实测指标和独立证据均达到已验证门槛。"],
      hasCompleteMetrics
    };
  }

  const meetsReviewMetrics =
    coverage >= 0.7 &&
    p95ResidualMs <= 400 &&
    boundaryUncertaintyMs <= 1_000 &&
    alternativeMargin >= 0.1;
  if (meetsReviewMetrics) {
    if (input.metricSource !== "measured") {
      reasons.push("指标不是实测值，只能进入复核状态。");
    }
    if (!hasIndependentVerificationEvidence) {
      reasons.push("只有单一主要证据类型，只能进入复核状态。");
    }
    if (probability < 0.995) {
      reasons.push("金标准校准概率低于 99.5%，只能进入复核状态。");
    }
    reasons.push(...evidenceIntegrityReasons);
    return {
      level: "review",
      reasons: reasons.length > 0 ? reasons : ["指标可用于复核，但尚未达到已验证门槛。"],
      hasCompleteMetrics
    };
  }

  return {
    level: "review",
    reasons: ["映射尚未达到已验证门槛，必须人工复核。"],
    hasCompleteMetrics
  };
}

/**
 * 将外部自报等级限制在中央评估允许的上限内。调用方可以保守声明 review/blocked，
 * 但中央评估绝不会据此自动升级；自报 verified 不满足门槛时会被确定性降级。
 */
export function reconcileTimeMapQualityClaim(
  declaredLevel: TimeMapQualityLevel,
  declaredReasons: readonly string[],
  input: TimeMapQualityInput
): TimeMapQualityReconciliation {
  const assessment = assessTimeMapQuality(input);
  if (declaredLevel === "legacy-unverified") {
    return {
      level: "legacy-unverified",
      reasons: uniqueNonEmptyStrings(declaredReasons),
      assessment
    };
  }
  let level: TimeMapQualityLevel;
  if (declaredLevel === "blocked") {
    level = "blocked";
  } else if (declaredLevel === "review") {
    level = assessment.level === "blocked" ? "blocked" : "review";
  } else {
    level = assessment.level;
  }

  const reasons = [...declaredReasons];
  if (level !== declaredLevel) {
    reasons.push(
      `外部声明的质量等级“${formatTimeMapQualityLevel(declaredLevel)}”超过中央质量门槛，已降级为“${formatTimeMapQualityLevel(level)}”。`
    );
  } else if (
    (declaredLevel === "review" || declaredLevel === "blocked") &&
    assessment.level === "verified"
  ) {
    reasons.push("保留外部的保守质量声明；中央评估不会自动升级为已验证。");
  }
  if (assessment.level !== "verified" || declaredLevel === "verified") {
    reasons.push(...assessment.reasons);
  }
  return { level, reasons: uniqueNonEmptyStrings(reasons), assessment };
}

function hasValidKindShape(
  kind: TimeMapSpanKind,
  sourceDurationMs: Milliseconds,
  targetDurationMs: Milliseconds
): boolean {
  if (kind === "matched") {
    return sourceDurationMs > 0 && targetDurationMs > 0;
  }
  if (kind === "sourceOnly") {
    return sourceDurationMs > 0 && targetDurationMs === 0;
  }
  if (kind === "targetOnly") {
    return sourceDurationMs === 0 && targetDurationMs > 0;
  }
  return sourceDurationMs > 0 || targetDurationMs > 0;
}

function createInvalidKindShapeMessage(kind: TimeMapSpanKind, spanIndex: number): string {
  if (kind === "matched") {
    return `时间映射第 ${spanIndex + 1} 段为 matched，但没有同时覆盖正长度的来源与目标区间。`;
  }
  if (kind === "sourceOnly") {
    return `时间映射第 ${spanIndex + 1} 段为 sourceOnly，但目标轴不是点或来源轴没有正长度。`;
  }
  if (kind === "targetOnly") {
    return `时间映射第 ${spanIndex + 1} 段为 targetOnly，但来源轴不是点或目标轴没有正长度。`;
  }
  return `时间映射第 ${spanIndex + 1} 段为空 ambiguous 点，不能表示不确定区间。`;
}

function compareBoundary(
  previousEndMs: Milliseconds,
  currentStartMs: Milliseconds,
  axis: "source" | "target",
  spanIndex: number,
  issues: TimeMapValidationIssue[]
): void {
  if (currentStartMs === previousEndMs) {
    return;
  }
  const isSource = axis === "source";
  const overlaps = currentStartMs < previousEndMs;
  issues.push({
    code: overlaps
      ? isSource
        ? "sourceOverlap"
        : "targetOverlap"
      : isSource
        ? "sourceDiscontinuity"
        : "targetDiscontinuity",
    spanIndex,
    previousSpanIndex: spanIndex - 1,
    message: `时间映射第 ${spanIndex}、${spanIndex + 1} 段在${isSource ? "来源" : "目标"}轴上${overlaps ? "重叠" : "存在未显式表示的空档"}。`
  });
}

function hasValidCoordinates(span: TimeMapSpan): boolean {
  return (
    isNonNegativeIntegerMilliseconds(span.sourceStartMs) &&
    isNonNegativeIntegerMilliseconds(span.sourceEndMs) &&
    isNonNegativeIntegerMilliseconds(span.targetStartMs) &&
    isNonNegativeIntegerMilliseconds(span.targetEndMs) &&
    span.sourceEndMs >= span.sourceStartMs &&
    span.targetEndMs >= span.targetStartMs
  );
}

function isNonNegativeIntegerMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTimeMapSpanQuality(value: unknown): value is TimeMapSpanQuality {
  if (!isRecord(value)) {
    return false;
  }
  const residuals = [
    value.p50ResidualMs,
    value.p95ResidualMs,
    value.p99ResidualMs,
    value.maxResidualMs
  ];
  return (
    isTimeMapQualityLevel(value.level) &&
    (value.metricSource === "measured" ||
      value.metricSource === "estimated" ||
      value.metricSource === "missing") &&
    isUnitNumberOrNull(value.probability) &&
    isUnitNumberOrNull(value.coverage) &&
    isUnitNumberOrNull(value.uniqueContentCoverage) &&
    isUnitNumberOrNull(value.alternativeMargin) &&
    isNonNegativeIntegerValue(value.anchorCount) &&
    isNonNegativeIntegerValue(value.heldOutAnchorCount) &&
    value.heldOutAnchorCount <= value.anchorCount &&
    residuals.every(isNonNegativeIntegerOrNullValue) &&
    isNonNegativeIntegerOrNullValue(value.boundaryUncertaintyMs) &&
    isTimeMapSpanSupportStatus(value.leftSupport) &&
    isTimeMapSpanSupportStatus(value.rightSupport) &&
    isTimeMapSpanSignals(value.signals) &&
    isNonEmptyStringArray(value.reasons) &&
    (value.p50ResidualMs === undefined ||
      value.p50ResidualMs === null ||
      value.p95ResidualMs === undefined ||
      value.p95ResidualMs === null ||
      value.p50ResidualMs <= value.p95ResidualMs) &&
    (value.p95ResidualMs === undefined ||
      value.p95ResidualMs === null ||
      value.p99ResidualMs === undefined ||
      value.p99ResidualMs === null ||
      value.p95ResidualMs <= value.p99ResidualMs) &&
    (value.p99ResidualMs === undefined ||
      value.p99ResidualMs === null ||
      value.maxResidualMs === undefined ||
      value.maxResidualMs === null ||
      value.p99ResidualMs <= value.maxResidualMs) &&
    (value.p95ResidualMs === undefined ||
      value.p95ResidualMs === null ||
      value.maxResidualMs === undefined ||
      value.maxResidualMs === null ||
      value.p95ResidualMs <= value.maxResidualMs)
  );
}

function isTimeMapSpanBoundaries(value: unknown): value is TimeMapSpanBoundaries {
  return isRecord(value) && isTimeMapBoundaryEvidence(value.start) && isTimeMapBoundaryEvidence(value.end);
}

function isTimeMapBoundaryEvidence(value: unknown): value is TimeMapBoundaryEvidence {
  if (!isRecord(value)) {
    return false;
  }
  const hasUncertaintyPair =
    (value.uncertaintyStartMs === null && value.uncertaintyEndMs === null) ||
    (isNonNegativeIntegerValue(value.uncertaintyStartMs) &&
      isNonNegativeIntegerValue(value.uncertaintyEndMs) &&
      value.uncertaintyEndMs >= value.uncertaintyStartMs);
  const refinedFieldsPresent =
    value.status !== "refined" ||
    (value.axis !== null &&
      isNonNegativeIntegerValue(value.coarseMs) &&
      isNonNegativeIntegerValue(value.refinedMs) &&
      isNonNegativeIntegerValue(value.uncertaintyStartMs) &&
      isNonNegativeIntegerValue(value.uncertaintyEndMs) &&
      isNonNegativeIntegerValue(value.supportDurationMs));
  return (
    isTimeMapBoundaryStatus(value.status) &&
    (value.axis === null ||
      value.axis === "source" ||
      value.axis === "target" ||
      value.axis === "both") &&
    (value.contextSide === null || value.contextSide === "before" || value.contextSide === "after") &&
    isNonNegativeIntegerOrNullValue(value.coarseMs) &&
    isNonNegativeIntegerOrNullValue(value.refinedMs) &&
    hasUncertaintyPair &&
    isNonNegativeIntegerOrNullValue(value.supportDurationMs) &&
    isCorrelationOrNull(value.correlation) &&
    isUnitNumberOrNull(value.alternativeMargin) &&
    isNonEmptyString(value.reason) &&
    refinedFieldsPresent
  );
}

function isTimeMapSpanAlternative(value: unknown): value is TimeMapSpanAlternative {
  if (!isRecord(value) || !isTimeMapSpanKind(value.kind)) {
    return false;
  }
  const sourceStartMs = value.sourceStartMs;
  const sourceEndMs = value.sourceEndMs;
  const targetStartMs = value.targetStartMs;
  const targetEndMs = value.targetEndMs;
  return (
    isUnitNumberOrNull(value.score) &&
    isNonNegativeIntegerValue(sourceStartMs) &&
    isNonNegativeIntegerValue(sourceEndMs) &&
    isNonNegativeIntegerValue(targetStartMs) &&
    isNonNegativeIntegerValue(targetEndMs) &&
    sourceEndMs >= sourceStartMs &&
    targetEndMs >= targetStartMs &&
    hasValidKindShape(value.kind, sourceEndMs - sourceStartMs, targetEndMs - targetStartMs) &&
    isNonEmptyString(value.reason)
  );
}

function isTimeMapQualityLevel(value: unknown): value is TimeMapQualityLevel {
  return (
    value === "verified" ||
    value === "review" ||
    value === "blocked" ||
    value === "legacy-unverified"
  );
}

function isTimeMapSpanSupportStatus(value: unknown): value is TimeMapSpanSupportStatus {
  return (
    value === "supported" ||
    value === "unsupported" ||
    value === "notApplicable" ||
    value === "legacyUnverified"
  );
}

function isTimeMapBoundaryStatus(value: unknown): value is TimeMapBoundaryStatus {
  return (
    value === "refined" ||
    value === "ambiguous" ||
    value === "unsupported" ||
    value === "notApplicable" ||
    value === "legacyUnverified"
  );
}

function isTimeMapSpanSignals(value: unknown): value is TimeMapSpanSignalAssessment {
  return (
    isRecord(value) &&
    isTimeMapSpanSignalStatus(value.audio) &&
    isTimeMapSpanSignalStatus(value.visual) &&
    isTimeMapSpanSignalStatus(value.danmaku)
  );
}

function isTimeMapSpanSignalStatus(value: unknown): value is TimeMapSpanSignalStatus {
  return value === "used" || value === "blocked" || value === "conflict";
}

function isTimeMapSpanKind(value: unknown): value is TimeMapSpanKind {
  return (
    value === "matched" ||
    value === "sourceOnly" ||
    value === "targetOnly" ||
    value === "ambiguous"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isNonNegativeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && isNonNegativeIntegerMilliseconds(value);
}

function isNonNegativeIntegerOrNullValue(value: unknown): value is number | null {
  return value === null || isNonNegativeIntegerValue(value);
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isUnitNumberOrNull(value: unknown): value is number | null {
  return value === null || isUnitNumber(value);
}

function isCorrelationOrNull(value: unknown): value is number | null {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1);
}

function assertNonNegativeIntegerMilliseconds(value: number, label: string): void {
  if (!isNonNegativeIntegerMilliseconds(value)) {
    throw new RangeError(`${label}必须是非负安全整数毫秒。`);
  }
}

function interpolateMatchedSpan(span: TimeMapSpan, sourceTimeMs: Milliseconds): Milliseconds {
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  const sourceDeltaMs = sourceTimeMs - span.sourceStartMs;
  const numerator = BigInt(sourceDeltaMs) * BigInt(targetDurationMs);
  const denominator = BigInt(sourceDurationMs);
  const roundedTargetDeltaMs = Number((numerator * 2n + denominator) / (denominator * 2n));
  // 输入与输出都是半开区间；最近整数插值在强压缩时可能恰好舍入到排他的 targetEnd。
  const targetTimeMs = Math.min(
    span.targetEndMs - 1,
    span.targetStartMs + roundedTargetDeltaMs
  );
  if (!isNonNegativeIntegerMilliseconds(targetTimeMs)) {
    throw new RangeError("分段仿射插值结果超出安全整数毫秒范围。");
  }
  return targetTimeMs;
}

function validateLegacyInput(input: LegacyTimeMapInput): LegacyTimeMapMigrationIssue | null {
  if (
    !isNonNegativeIntegerMilliseconds(input.sourceStartMs) ||
    !isNonNegativeIntegerMilliseconds(input.sourceEndMs) ||
    !isNonNegativeIntegerMilliseconds(input.targetStartMs) ||
    input.sourceEndMs <= input.sourceStartMs ||
    !Array.isArray(input.timingRules)
  ) {
    return {
      code: "invalidInput",
      severity: "error",
      message: "旧时间映射的段边界无效，无法迁移。"
    };
  }
  return null;
}

function appendMatchedSpan(
  spans: TimeMapSpan[],
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds,
  targetStartMs: Milliseconds,
  targetEndMs: Milliseconds
): void {
  if (sourceEndMs === sourceStartMs) {
    return;
  }
  spans.push({ kind: "matched", sourceStartMs, sourceEndMs, targetStartMs, targetEndMs });
}

function safeAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function blockedForOverflow(
  spans: readonly TimeMapSpan[],
  issues: readonly LegacyTimeMapMigrationIssue[]
): LegacyTimeMapMigrationResult {
  return {
    status: "blocked",
    spans,
    issues: [
      ...issues,
      {
        code: "timeOverflow",
        severity: "error",
        message: "迁移后的目标时间超出非负安全整数毫秒范围。"
      }
    ]
  };
}

function validateQualityMetrics(input: TimeMapQualityInput): string[] {
  const problems: string[] = [];
  if (
    input.probability !== null &&
    (!Number.isFinite(input.probability) || input.probability < 0 || input.probability > 1)
  ) {
    problems.push("校准概率必须位于 0 到 1。");
  }
  if (
    input.coverage !== null &&
    (!Number.isFinite(input.coverage) || input.coverage < 0 || input.coverage > 1)
  ) {
    problems.push("coverage 必须位于 0 到 1。");
  }
  if (
    input.uniqueContentCoverage !== undefined &&
    input.uniqueContentCoverage !== null &&
    (!Number.isFinite(input.uniqueContentCoverage) ||
      input.uniqueContentCoverage < 0 ||
      input.uniqueContentCoverage > 1)
  ) {
    problems.push("独特内容覆盖率必须位于 0 到 1。");
  }
  if (input.p50ResidualMs !== null && !isNonNegativeIntegerMilliseconds(input.p50ResidualMs)) {
    problems.push("P50 残差必须是非负安全整数毫秒。");
  }
  if (input.p95ResidualMs !== null && !isNonNegativeIntegerMilliseconds(input.p95ResidualMs)) {
    problems.push("P95 残差必须是非负安全整数毫秒。");
  }
  if (
    input.p99ResidualMs !== undefined &&
    input.p99ResidualMs !== null &&
    !isNonNegativeIntegerMilliseconds(input.p99ResidualMs)
  ) {
    problems.push("P99 残差必须是非负安全整数毫秒。");
  }
  if (input.maxResidualMs !== null && !isNonNegativeIntegerMilliseconds(input.maxResidualMs)) {
    problems.push("最大残差必须是非负安全整数毫秒。");
  }
  if (
    input.boundaryUncertaintyMs !== null &&
    !isNonNegativeIntegerMilliseconds(input.boundaryUncertaintyMs)
  ) {
    problems.push("边界不确定区间必须是非负安全整数毫秒。");
  }
  if (
    input.alternativeMargin !== null &&
    (!Number.isFinite(input.alternativeMargin) ||
      input.alternativeMargin < 0 ||
      input.alternativeMargin > 1)
  ) {
    problems.push("备选路径差距必须位于 0 到 1。");
  }
  if (!Number.isSafeInteger(input.anchorCount) || input.anchorCount < 0) {
    problems.push("锚点数必须是非负安全整数。");
  }
  if (
    input.anchorRegionCount !== undefined &&
    (!Number.isSafeInteger(input.anchorRegionCount) ||
      input.anchorRegionCount < 0 ||
      input.anchorRegionCount > 3)
  ) {
    problems.push("锚点时间区域数必须是 0 到 3 的安全整数。");
  }
  if (
    !Number.isSafeInteger(input.heldOutAnchorCount) ||
    input.heldOutAnchorCount < 0 ||
    input.heldOutAnchorCount > input.anchorCount
  ) {
    problems.push("留出锚点数必须是非负安全整数，且不能超过总锚点数。");
  }
  if (
    !Number.isSafeInteger(input.evidenceHeldOutAnchorCount) ||
    input.evidenceHeldOutAnchorCount < 0
  ) {
    problems.push("证据留出锚点数必须是非负安全整数。");
  }
  if (
    input.p50ResidualMs !== null &&
    input.p95ResidualMs !== null &&
    input.p50ResidualMs > input.p95ResidualMs
  ) {
    problems.push("P50 残差不能大于 P95 残差。");
  }
  if (
    input.p95ResidualMs !== null &&
    input.p99ResidualMs !== undefined &&
    input.p99ResidualMs !== null &&
    input.p95ResidualMs > input.p99ResidualMs
  ) {
    problems.push("P95 残差不能大于 P99 残差。");
  }
  if (
    input.p99ResidualMs !== undefined &&
    input.p99ResidualMs !== null &&
    input.maxResidualMs !== null &&
    input.p99ResidualMs > input.maxResidualMs
  ) {
    problems.push("P99 残差不能大于最大残差。");
  }
  return problems;
}

function collectBlockingMetricReasons(input: TimeMapQualityInput): string[] {
  const reasons: string[] = [];
  if (input.coverage !== null && input.coverage < 0.2) {
    reasons.push("匹配覆盖率低于 20%。");
  }
  if (input.p95ResidualMs !== null && input.p95ResidualMs > 2_000) {
    reasons.push("P95 映射残差超过 2000 毫秒。");
  }
  if (input.boundaryUncertaintyMs !== null && input.boundaryUncertaintyMs > 5_000) {
    reasons.push("删减边界不确定区间超过 5000 毫秒。");
  }
  if (input.alternativeMargin !== null && input.alternativeMargin < 0.02) {
    reasons.push("最佳路径与备选路径的差距不足 0.02。");
  }
  return reasons;
}

function hasCompleteQualityMetrics(input: TimeMapQualityInput): input is TimeMapQualityInput & {
  probability: number;
  coverage: number;
  p50ResidualMs: Milliseconds;
  p95ResidualMs: Milliseconds;
  p99ResidualMs: Milliseconds;
  maxResidualMs: Milliseconds;
  boundaryUncertaintyMs: Milliseconds;
  alternativeMargin: number;
} {
  return (
    input.probability !== null &&
    input.coverage !== null &&
    input.p50ResidualMs !== null &&
    input.p95ResidualMs !== null &&
    input.p99ResidualMs !== undefined &&
    input.p99ResidualMs !== null &&
    input.maxResidualMs !== null &&
    input.boundaryUncertaintyMs !== null &&
    input.alternativeMargin !== null &&
    input.anchorCount > 0 &&
    input.heldOutAnchorCount > 0 &&
    input.evidenceHeldOutAnchorCount === input.heldOutAnchorCount
  );
}

function collectEvidenceIntegrityReasons(input: TimeMapQualityInput): string[] {
  const evidence = new Set(input.evidenceTypes);
  const reasons: string[] = [];
  if (evidence.has("audio") && input.audioAnchorCount <= 0) {
    reasons.push("音频证据没有正数量锚点，不能用于已验证结论。");
  }
  if (evidence.has("visual") && input.visualAnchorCount <= 0) {
    reasons.push("视觉证据没有正数量锚点，不能用于已验证结论。");
  }
  if (evidence.has("audio") || evidence.has("visual")) {
    const streamType = input.sourceStreamType;
    const streamEvidenceType = streamType === "video" ? "visual" : streamType;
    if (
      streamType === null ||
      input.targetStreamType === null ||
      streamType !== input.targetStreamType ||
      streamEvidenceType === null ||
      !evidence.has(streamEvidenceType)
    ) {
      reasons.push("音频/视觉证据缺少双端一致且与证据类型对应的流身份。");
    }
  }
  return reasons;
}

export function timeMapQualityStatusId(level: TimeMapQualityLevel): WorkspaceStatusId {
  if (level === "verified") return "confirmed";
  if (level === "blocked") return "blocked";
  return "reviewRequired";
}

export function formatTimeMapQualityLevel(level: TimeMapQualityLevel): string {
  const label = statusLabel(timeMapQualityStatusId(level));
  return level === "legacy-unverified" ? `${label}（旧版未验证）` : label;
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
