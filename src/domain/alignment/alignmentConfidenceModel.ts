import type { AlignmentReviewFeatureSnapshot, AlignmentReviewRecord } from "../project/types";

export const ALIGNMENT_CONFIDENCE_FEATURE_NAMES = [
  "sourceCoverage",
  "uniqueContentCoverage",
  "anchorCount",
  "heldOutAnchorCount",
  "anchorRegionCount",
  "p95ResidualMs",
  "p99ResidualMs",
  "maxResidualMs",
  "boundaryUncertaintyMs",
  "alternativeMargin",
  "ambiguousRatio",
  "bidirectionalAgreement",
  "differenceRiskP50",
  "differenceRiskP90",
  "differenceRiskP99",
  "informativenessP50",
  "visualRecoveredRatio",
  "visualAmbiguousRatio",
  "visualMarginP50"
] as const satisfies ReadonlyArray<keyof AlignmentReviewFeatureSnapshot>;

export interface AlignmentConfidenceLinearModel {
  schemaVersion: "alignment-confidence-linear-model-v1";
  featureNames: Array<(typeof ALIGNMENT_CONFIDENCE_FEATURE_NAMES)[number]>;
  imputerMedian: number[];
  scalerMean: number[];
  scalerScale: number[];
  coefficients: number[];
  intercept: number;
  safeAutoAcceptThreshold: number | null;
  permission: "risk-ranking-only-until-frozen-gold-approved";
}

export interface AlignmentConfidenceShadowScore {
  recordId: string;
  proposalCorrectProbability: number;
  risk: number;
  mode: "shadow-risk-ranking";
  canAutoAccept: false;
}

export function parseAlignmentConfidenceLinearModel(value: unknown): AlignmentConfidenceLinearModel {
  if (!isRecord(value)) throw new Error("置信度模型不是有效对象。");
  const expectedLength = ALIGNMENT_CONFIDENCE_FEATURE_NAMES.length;
  if (
    value.schemaVersion !== "alignment-confidence-linear-model-v1" ||
    value.permission !== "risk-ranking-only-until-frozen-gold-approved" ||
    !isExactFeatureNames(value.featureNames) ||
    !isFiniteNumberArray(value.imputerMedian, expectedLength) ||
    !isFiniteNumberArray(value.scalerMean, expectedLength) ||
    !isFiniteNumberArray(value.scalerScale, expectedLength) ||
    value.scalerScale.some((item) => item <= 0) ||
    !isFiniteNumberArray(value.coefficients, expectedLength) ||
    !isFiniteNumber(value.intercept) ||
    !isProbabilityOrNull(value.safeAutoAcceptThreshold)
  ) {
    throw new Error("置信度模型字段、特征顺序或数值无效。");
  }
  return {
    schemaVersion: value.schemaVersion,
    featureNames: [...value.featureNames],
    imputerMedian: [...value.imputerMedian],
    scalerMean: [...value.scalerMean],
    scalerScale: [...value.scalerScale],
    coefficients: [...value.coefficients],
    intercept: value.intercept,
    safeAutoAcceptThreshold: value.safeAutoAcceptThreshold,
    permission: value.permission
  };
}

export function scoreAlignmentReviewRecord(
  record: AlignmentReviewRecord,
  model: AlignmentConfidenceLinearModel
): AlignmentConfidenceShadowScore {
  let logit = model.intercept;
  for (let index = 0; index < ALIGNMENT_CONFIDENCE_FEATURE_NAMES.length; index += 1) {
    const name = ALIGNMENT_CONFIDENCE_FEATURE_NAMES[index];
    const raw = record.features[name];
    const value = raw === null ? model.imputerMedian[index] : raw;
    const normalized = (value - model.scalerMean[index]) / model.scalerScale[index];
    logit += normalized * model.coefficients[index];
  }
  const probability = stableSigmoid(logit);
  return {
    recordId: record.id,
    proposalCorrectProbability: probability,
    risk: 1 - probability,
    mode: "shadow-risk-ranking",
    canAutoAccept: false
  };
}

export function rankAlignmentRecordsByShadowRisk(
  records: AlignmentReviewRecord[],
  model: AlignmentConfidenceLinearModel
): AlignmentConfidenceShadowScore[] {
  return records
    .map((record) => scoreAlignmentReviewRecord(record, model))
    .sort((left, right) => right.risk - left.risk || left.recordId.localeCompare(right.recordId));
}

function stableSigmoid(value: number): number {
  if (value >= 0) {
    const decay = Math.exp(-value);
    return 1 / (1 + decay);
  }
  const growth = Math.exp(value);
  return growth / (1 + growth);
}

function isFiniteNumberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
}

function isExactFeatureNames(
  value: unknown
): value is AlignmentConfidenceLinearModel["featureNames"] {
  return (
    Array.isArray(value) &&
    value.length === ALIGNMENT_CONFIDENCE_FEATURE_NAMES.length &&
    value.every((name, index) => name === ALIGNMENT_CONFIDENCE_FEATURE_NAMES[index])
  );
}

function isProbabilityOrNull(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= 0 && value <= 1);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
