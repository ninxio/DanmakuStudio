import type { SyncAnchor } from "../danmaku/types";
import type { AlignmentInput, AlignmentProposal, AlignmentProvider, CutCandidate } from "./types";
import { isAlignmentTimeMapProposal } from "./timeMapProposal";

export class ManualAlignmentProvider implements AlignmentProvider {
  private proposal: AlignmentProposal;

  constructor(proposal: AlignmentProposal) {
    this.proposal = proposal;
  }

  analyze(input: AlignmentInput): Promise<AlignmentProposal> {
    void input;
    return Promise.resolve(this.proposal);
  }
}

export function serializeAlignmentProposal(proposal: AlignmentProposal): string {
  return `${JSON.stringify(proposal, null, 2)}\n`;
}

export function parseAlignmentProposal(json: string): AlignmentProposal {
  const parsed = JSON.parse(json) as unknown;
  if (!isAlignmentProposal(parsed)) {
    throw new Error("对齐提案 JSON 格式不正确。");
  }
  return parsed;
}

export function isAlignmentProposal(value: unknown): value is AlignmentProposal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.anchors) &&
    record.anchors.every(isSyncAnchor) &&
    Array.isArray(record.cutCandidates) &&
    record.cutCandidates.every(isCutCandidate) &&
    (record.evidenceProfile === undefined ||
      isAlignmentEvidenceProfile(record.evidenceProfile)) &&
    isUnitNumber(record.confidence) &&
    Array.isArray(record.diagnostics) &&
    record.diagnostics.every((diagnostic) => typeof diagnostic === "string") &&
    (record.evidence === undefined || isAlignmentEvidence(record.evidence)) &&
    (record.matchRange === undefined || isAlignmentMatchRange(record.matchRange)) &&
    (record.timeMap === undefined || isAlignmentTimeMapProposal(record.timeMap))
  );
}

function isAlignmentEvidenceProfile(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.version === "alignment-evidence-profile-v1" ||
      record.version === "alignment-evidence-profile-v2") &&
    isNonNegativeInteger(record.windowMs) &&
    record.windowMs > 0 &&
    Array.isArray(record.samples) &&
    record.samples.length <= 10_000 &&
    record.samples.every(isAlignmentEvidenceSample)
  );
}

function isAlignmentEvidenceSample(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const legacyFieldsAreValid =
    (record.axis === "source" || record.axis === "target") &&
    isNonNegativeInteger(record.startMs) &&
    isNonNegativeInteger(record.endMs) &&
    record.endMs > record.startMs &&
    (record.counterpartMs === null || isNonNegativeInteger(record.counterpartMs)) &&
    isUnitNumber(record.strength) &&
    isNonNegativeInteger(record.anchorCount) &&
    isNonNegativeInteger(record.heldOutAnchorCount) &&
    record.heldOutAnchorCount <= record.anchorCount &&
    (record.medianAbsResidualMs === null ||
      isNonNegativeInteger(record.medianAbsResidualMs)) &&
    (record.offsetMs === null || Number.isSafeInteger(record.offsetMs)) &&
    (record.state === "supported" ||
      record.state === "weak" ||
      record.state === "conflicting" ||
      record.state === "noEvidence" ||
      record.state === "sourceOnly" ||
      record.state === "targetOnly");
  if (!legacyFieldsAreValid) return false;
  const hasDenseFields =
    record.matchProbability !== undefined ||
    record.differenceRisk !== undefined ||
    record.informativeness !== undefined ||
    record.offsetUncertaintyMs !== undefined ||
    record.dominantState !== undefined ||
    record.reasonCode !== undefined ||
    record.visualSupport !== undefined ||
    record.visualMatchMs !== undefined ||
    record.visualOffsetMs !== undefined ||
    record.visualConfidence !== undefined ||
    record.visualMargin !== undefined ||
    record.visualRecoveryState !== undefined;
  if (!hasDenseFields) return true;
  return (
    isUnitNumber(record.matchProbability) &&
    isUnitNumber(record.differenceRisk) &&
    isUnitNumber(record.informativeness) &&
    (record.offsetUncertaintyMs === null ||
      isNonNegativeInteger(record.offsetUncertaintyMs)) &&
    (record.dominantState === "matched" ||
      record.dominantState === "sourceOnly" ||
      record.dominantState === "targetOnly" ||
      record.dominantState === "replacement" ||
      record.dominantState === "uncertain") &&
    typeof record.reasonCode === "string" &&
    record.reasonCode.length > 0 &&
    (record.visualSupport === undefined || isUnitNumber(record.visualSupport)) &&
    (record.visualMatchMs === undefined || isNonNegativeInteger(record.visualMatchMs)) &&
    (record.visualOffsetMs === undefined || Number.isSafeInteger(record.visualOffsetMs)) &&
    (record.visualConfidence === undefined || isUnitNumber(record.visualConfidence)) &&
    (record.visualMargin === undefined || isUnitNumber(record.visualMargin)) &&
    (record.visualRecoveryState === undefined ||
      record.visualRecoveryState === "recovered" ||
      record.visualRecoveryState === "ambiguous" ||
      record.visualRecoveryState === "notFound")
  );
}

function isAlignmentMatchRange(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(record.sourceStartMs) &&
    isNonNegativeInteger(record.sourceEndMs) &&
    record.sourceEndMs > record.sourceStartMs &&
    isNonNegativeInteger(record.targetStartMs) &&
    isNonNegativeInteger(record.targetEndMs) &&
    record.targetEndMs > record.targetStartMs &&
    typeof record.coverage === "number" &&
    Number.isFinite(record.coverage) &&
    record.coverage >= 0 &&
    record.coverage <= 1
  );
}

function isAlignmentEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.algorithm === "visual-aap-v1" ||
      record.algorithm === "alignment-v2-edit-map" ||
      record.algorithm === "time-map-audio" ||
      record.algorithm === "sparse-fingerprint" ||
      record.algorithm === "offset-path" ||
      record.algorithm === "sparse-fingerprint-fallback" ||
      record.algorithm === "dense-dp") &&
    isNonNegativeInteger(record.completeFingerprintCount) &&
    isNonNegativeInteger(record.sourceFingerprintCount) &&
    isNonNegativeInteger(record.fingerprintMatchCount) &&
    isNonNegativeInteger(record.monotonicMatchCount) &&
    isNonNegativeInteger(record.strongAnchorCount) &&
    isNonNegativeInteger(record.weakAnchorCount) &&
    isNonNegativeInteger(record.offsetClusterCount) &&
    isNonNegativeInteger(record.refinedCandidateCount) &&
    isNonNegativeInteger(record.lowConfidenceRegionCount) &&
    (record.timeMappingSegmentCount === undefined || isNonNegativeInteger(record.timeMappingSegmentCount)) &&
    (record.confirmedChangeCount === undefined || isNonNegativeInteger(record.confirmedChangeCount)) &&
    (record.signals === undefined || (Array.isArray(record.signals) && record.signals.every(isEvidenceSignal))) &&
    (record.quality === "high" || record.quality === "medium" || record.quality === "low" || record.quality === "blocked")
  );
}

function isEvidenceSignal(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "audio" || record.kind === "visual" || record.kind === "danmaku") &&
    (record.status === "used" || record.status === "notConfigured" || record.status === "blocked") &&
    typeof record.label === "string" &&
    isNonNegativeInteger(record.observations) &&
    typeof record.weight === "number" &&
    Number.isFinite(record.weight) &&
    record.weight >= 0 &&
    record.weight <= 1 &&
    typeof record.note === "string"
  );
}

function isSyncAnchor(value: unknown): value is SyncAnchor {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    isNonNegativeInteger(record.sourceMs) &&
    isNonNegativeInteger(record.targetMs) &&
    (record.origin === "manual" || record.origin === "automatic") &&
    (record.confidence === undefined || isUnitNumber(record.confidence))
  );
}

function isCutCandidate(value: unknown): value is CutCandidate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    isNonNegativeInteger(record.sourceAtMs) &&
    (record.sourceRangeStartMs === undefined ||
      isNonNegativeInteger(record.sourceRangeStartMs)) &&
    (record.sourceRangeEndMs === undefined ||
      isNonNegativeInteger(record.sourceRangeEndMs)) &&
    isSafeInteger(record.targetGapMs) &&
    isUnitNumber(record.confidence) &&
    typeof record.note === "string"
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}
