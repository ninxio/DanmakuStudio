import {
  isCompleteTimeMapSpanEvidence,
  reconcileTimeMapQualityClaim,
  validateTimeMap,
  type TimeMapSpan
} from "./timeMap";
import type {
  AlignmentTimeMapEvidence,
  AlignmentTimeMapProposal,
  AlignmentTimeMapQuality,
  AlignmentTimeMapStreamIdentity
} from "./types";
import {
  cloneMediaContentIdentity,
  isMediaContentIdentity
} from "../project/mediaIdentity";

export function isAlignmentTimeMapProposal(
  value: unknown,
  requireCompleteSpanEvidence = true
): value is AlignmentTimeMapProposal {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !isNonNegativeInteger(value.sourceStartMs) ||
    !isNonNegativeInteger(value.sourceEndMs) ||
    value.sourceEndMs <= value.sourceStartMs ||
    !isNonNegativeInteger(value.targetStartMs) ||
    !isNonNegativeInteger(value.targetEndMs) ||
    value.targetEndMs <= value.targetStartMs ||
    !Array.isArray(value.spans) ||
    value.spans.length === 0 ||
    !isAlignmentTimeMapQuality(value.quality, requireCompleteSpanEvidence) ||
    !isAlignmentTimeMapEvidence(value.evidence, requireCompleteSpanEvidence) ||
    !isStreamIdentityOrNull(value.sourceStream) ||
    !isStreamIdentityOrNull(value.targetStream) ||
    !isMediaContentIdentityOrNullOrMissing(value.sourceIdentity) ||
    !isMediaContentIdentityOrNullOrMissing(value.targetIdentity) ||
    !isNonEmptyString(value.engineVersion) ||
    !isNonEmptyString(value.featureVersion) ||
    !isNonEmptyString(value.parametersHash)
  ) {
    return false;
  }
  const spans = value.spans as TimeMapSpan[];
  const quality = value.quality;
  const evidence = value.evidence;
  const first = spans[0];
  const last = spans.at(-1);
  return (
    validateTimeMap(spans).valid &&
    (!requireCompleteSpanEvidence || spans.every(isCompleteTimeMapSpanEvidence)) &&
    (!requireCompleteSpanEvidence ||
      quality.uniqueContentCoverage === evidence.uniqueContentCoverage) &&
    first?.sourceStartMs === value.sourceStartMs &&
    first.targetStartMs === value.targetStartMs &&
    last?.sourceEndMs === value.sourceEndMs &&
    last.targetEndMs === value.targetEndMs
  );
}

/**
 * 对引擎或外部文件提供的质量声明执行中央重算。结果只会保留或降低声明等级，
 * 不会把 review/blocked 自动升级为 verified。
 */
export function reconcileAlignmentTimeMapProposalQuality(
  proposal: AlignmentTimeMapProposal
): AlignmentTimeMapProposal {
  const reconciliation = reconcileTimeMapQualityClaim(
    proposal.quality.level,
    proposal.quality.reasons,
    {
      probability: proposal.quality.probability,
      metricSource: proposal.quality.metricSource,
      coverage: proposal.quality.coverage,
      uniqueContentCoverage: proposal.quality.uniqueContentCoverage,
      p50ResidualMs: proposal.quality.p50ResidualMs,
      p95ResidualMs: proposal.quality.p95ResidualMs,
      p99ResidualMs: proposal.quality.p99ResidualMs,
      maxResidualMs: proposal.quality.maxResidualMs,
      boundaryUncertaintyMs: proposal.quality.boundaryUncertaintyMs,
      alternativeMargin: proposal.quality.alternativeMargin,
      anchorCount: proposal.quality.anchorCount,
      anchorRegionCount: proposal.quality.anchorRegionCount,
      heldOutAnchorCount: proposal.quality.heldOutAnchorCount,
      evidenceTypes: proposal.evidence.types,
      audioAnchorCount: proposal.evidence.audioAnchorCount,
      visualAnchorCount: proposal.evidence.visualAnchorCount,
      evidenceHeldOutAnchorCount: proposal.evidence.heldOutAnchorCount,
      sourceStreamType: proposal.sourceStream?.type ?? null,
      targetStreamType: proposal.targetStream?.type ?? null
    }
  );
  const missingIdentity = proposal.sourceIdentity == null || proposal.targetIdentity == null;
  const hasIncompleteSpan = proposal.spans.some(
    (span) => !isCompleteTimeMapSpanEvidence(span)
  );
  const completeSpans = proposal.spans.filter(isCompleteTimeMapSpanEvidence);
  const hasBlockedSpan = completeSpans.some((span) => span.quality.level === "blocked");
  const hasLegacySpan = completeSpans.some(
    (span) => span.quality.level === "legacy-unverified"
  );
  const hasReviewSpan = completeSpans.some((span) => span.quality.level === "review");
  let level = reconciliation.level === "verified" && missingIdentity
    ? "blocked"
    : reconciliation.level;
  const reasons = [...reconciliation.reasons];
  if (level === "blocked" && reconciliation.level === "verified" && missingIdentity) {
    reasons.push("对齐提案缺少源文件或目标文件的内容身份快照，不能作为已验证映射使用。");
  }
  if (hasIncompleteSpan || hasBlockedSpan) {
    level = "blocked";
    reasons.push(
      hasIncompleteSpan
        ? "至少一个片段缺少完整逐段证据，已阻断对齐提案。"
        : "至少一个片段的逐段质量为 blocked，已阻断对齐提案。"
    );
  } else if (hasLegacySpan && level !== "blocked") {
    level = "legacy-unverified";
    reasons.push("至少一个片段只有旧版未验证证据，对齐提案必须重新分析或复核。");
  } else if (hasReviewSpan && level === "verified") {
    level = "review";
    reasons.push("至少一个片段仍需复核，图级自动指标不能绕过逐段质量门禁。");
  }
  return {
    ...proposal,
    sourceIdentity: cloneMediaContentIdentity(proposal.sourceIdentity),
    targetIdentity: cloneMediaContentIdentity(proposal.targetIdentity),
    quality: {
      ...proposal.quality,
      level,
      reasons
    }
  };
}

function isMediaContentIdentityOrNullOrMissing(value: unknown): boolean {
  return value === undefined || value === null || isMediaContentIdentity(value);
}

function isAlignmentTimeMapQuality(
  value: unknown,
  requireV12Fields: boolean
): value is AlignmentTimeMapQuality {
  if (
    !isRecord(value) ||
    (value.level !== "verified" &&
      value.level !== "review" &&
      value.level !== "blocked" &&
      value.level !== "legacy-unverified") ||
    !isUnitNumberOrNull(value.probability) ||
    (value.metricSource !== "measured" &&
      value.metricSource !== "estimated" &&
      value.metricSource !== "missing") ||
    !isUnitNumberOrNull(value.coverage) ||
    (value.uniqueContentCoverage !== undefined &&
      !isUnitNumberOrNull(value.uniqueContentCoverage)) ||
    !isNonNegativeIntegerOrNull(value.p50ResidualMs) ||
    !isNonNegativeIntegerOrNull(value.p95ResidualMs) ||
    (value.p99ResidualMs !== undefined &&
      !isNonNegativeIntegerOrNull(value.p99ResidualMs)) ||
    !isNonNegativeIntegerOrNull(value.maxResidualMs) ||
    !isNonNegativeIntegerOrNull(value.boundaryUncertaintyMs) ||
    !isUnitNumberOrNull(value.alternativeMargin) ||
    !isNonNegativeInteger(value.anchorCount) ||
    (value.anchorRegionCount !== undefined && !isAnchorRegionCount(value.anchorRegionCount)) ||
    !isNonNegativeInteger(value.heldOutAnchorCount) ||
    value.heldOutAnchorCount > value.anchorCount ||
    !isNonEmptyStringArray(value.reasons)
  ) {
    return false;
  }
  return (
    (!requireV12Fields ||
      ("uniqueContentCoverage" in value &&
        "p99ResidualMs" in value &&
        "anchorRegionCount" in value)) &&
    (value.p50ResidualMs === null ||
      value.p95ResidualMs === null ||
      value.p50ResidualMs <= value.p95ResidualMs) &&
    (value.p95ResidualMs === null ||
      value.p99ResidualMs === undefined ||
      value.p99ResidualMs === null ||
      value.p95ResidualMs <= value.p99ResidualMs) &&
    (value.p99ResidualMs === undefined ||
      value.p99ResidualMs === null ||
      value.maxResidualMs === null ||
      value.p99ResidualMs <= value.maxResidualMs)
  );
}

function isAlignmentTimeMapEvidence(
  value: unknown,
  requireV12Fields: boolean
): value is AlignmentTimeMapEvidence {
  if (
    !isRecord(value) ||
    !Array.isArray(value.types) ||
    value.types.length === 0 ||
    !value.types.every(
      (type) =>
        type === "audio" ||
        type === "visual" ||
        type === "manual" ||
        type === "danmaku" ||
        type === "legacy"
    ) ||
    new Set(value.types).size !== value.types.length ||
    !isNonNegativeInteger(value.audioAnchorCount) ||
    !isNonNegativeInteger(value.visualAnchorCount) ||
    !isNonNegativeInteger(value.heldOutAnchorCount) ||
    !isUnitNumberOrNull(value.top1Top2Margin) ||
    (value.uniqueContentCoverage !== undefined &&
      !isUnitNumberOrNull(value.uniqueContentCoverage)) ||
    (value.repeatedContentOnly !== undefined &&
      typeof value.repeatedContentOnly !== "boolean") ||
    (value.selectedTrackReason !== undefined && typeof value.selectedTrackReason !== "string") ||
    (value.alternativeTrackScores !== undefined &&
      (!Array.isArray(value.alternativeTrackScores) ||
        !value.alternativeTrackScores.every((alternative) =>
          isTrackAlternative(alternative, requireV12Fields)
        ))) ||
    !isStringArray(value.notes)
  ) {
    return false;
  }
  return (
    !requireV12Fields ||
    ("uniqueContentCoverage" in value &&
      "repeatedContentOnly" in value &&
      "selectedTrackReason" in value &&
      "alternativeTrackScores" in value)
  );
}

function isTrackAlternative(value: unknown, requireV12Fields: boolean): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sourceStreamIndex) &&
    isNonNegativeInteger(value.targetStreamIndex) &&
    isUnitNumber(value.score) &&
    (value.scale === undefined || isPositiveFiniteNumber(value.scale)) &&
    (value.offsetMs === undefined || isSafeInteger(value.offsetMs)) &&
    (value.inlierCount === undefined || isNonNegativeInteger(value.inlierCount)) &&
    (!requireV12Fields ||
      ("scale" in value && "offsetMs" in value && "inlierCount" in value))
  );
}

function isStreamIdentityOrNull(
  value: unknown
): value is AlignmentTimeMapStreamIdentity | null {
  if (value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    (value.type !== "audio" && value.type !== "video") ||
    !isNonNegativeInteger(value.index) ||
    !isStringOrNull(value.codec) ||
    !isIntegerOrNull(value.startMs) ||
    !isIntegerOrNull(value.timelineOffsetMs) ||
    !isStringOrNull(value.timeBase) ||
    !isPositiveIntegerOrNull(value.sampleRate) ||
    !isPositiveIntegerOrNull(value.channels) ||
    !isPositiveNumberOrNull(value.frameRate) ||
    !isStringOrNull(value.language) ||
    !isStringOrNull(value.title)
  ) {
    return false;
  }
  return value.type === "audio"
    ? value.frameRate === null
    : value.sampleRate === null && value.channels === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAnchorRegionCount(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 3;
}

function isNonNegativeIntegerOrNull(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || (isNonNegativeInteger(value) && value > 0);
}

function isPositiveNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isUnitNumberOrNull(value: unknown): value is number | null {
  return value === null || isUnitNumber(value);
}
