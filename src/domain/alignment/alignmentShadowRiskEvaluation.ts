import type { EditorProject } from "../project/types";
import { sha256Hex } from "../shared/sha256";
import { assessAlignmentAdjudication } from "./alignmentAdjudication";
import { buildAlignmentTrainingDatasetExport } from "./alignmentReviewRecords";
import {
  createAlignmentShadowRiskAssociationManifest,
  parseAlignmentShadowRiskOverlayForProject,
  resolveAlignmentShadowRiskOverlay
} from "./alignmentShadowRiskOverlay";

const RECEIPT_DIGEST_DOMAIN = "danmaku-studio/alignment-shadow-risk-evaluation/v1";
const RECORD_KEY_DOMAIN = "danmaku-studio/alignment-shadow-risk-evaluation-record/v1";
const BUCKET_FRACTIONS = [0.1, 0.2, 0.5, 1] as const;

export type AlignmentShadowRiskEvaluationState =
  | "gold-correct"
  | "gold-error"
  | "frozen-withheld"
  | "conflict"
  | "weak-reviewed"
  | "pending";

export interface AlignmentShadowRiskEvaluationRow {
  recordKey: string;
  recordEvidenceDigest: string;
  rank: number;
  risk: number;
  split: "development" | "calibration" | "frozen-test";
  state: AlignmentShadowRiskEvaluationState;
  proposalCorrect: boolean | null;
  distinctIndependentReviewerCount: number;
  activeVoteCount: number;
}

export interface AlignmentShadowRiskEvaluationBucket {
  fraction: 0.1 | 0.2 | 0.5 | 1;
  reviewedRecordCount: number;
  evaluatedGoldCount: number;
  capturedGoldErrorCount: number;
  goldErrorCaptureRate: number | null;
  goldErrorYield: number | null;
  liftAgainstGoldBaseline: number | null;
}

export interface AlignmentShadowRiskEvaluationReceipt {
  schemaVersion: "alignment-shadow-risk-evaluation-v1";
  associationManifestId: string;
  overlayId: string;
  sourceRunId: string;
  featureRecipeVersion: "rule-audio-local-support-risk-v1";
  generatedAt: string;
  permission: "shadow-evaluation-only";
  releaseEligible: false;
  rows: AlignmentShadowRiskEvaluationRow[];
  summary: {
    rankedRecordCount: number;
    developmentCalibrationRecordCount: number;
    evaluatedGoldCount: number;
    goldErrorCount: number;
    goldCorrectCount: number;
    goldEvaluationCoverage: number;
    withheldFrozenGoldCount: number;
    conflictCount: number;
    weakReviewedCount: number;
    pendingCount: number;
    goldBaselineErrorRate: number | null;
    accuracyClaimReady: boolean;
    buckets: AlignmentShadowRiskEvaluationBucket[];
    note: string;
  };
  receiptId: string;
}

/**
 * Build a path-free effectiveness receipt for a persisted shadow-risk overlay. Weak human votes
 * remain exploratory; only independently adjudicated non-frozen Gold contributes to correctness.
 * The function never reveals a frozen-test outcome and never grants model or TimeMap authority.
 */
export function buildAlignmentShadowRiskEvaluationReceipt(
  project: EditorProject,
  generatedAt = new Date().toISOString()
): AlignmentShadowRiskEvaluationReceipt {
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("复核效果收据时间无效。");
  }
  const overlay = project.alignmentShadowRiskOverlay
    ? parseAlignmentShadowRiskOverlayForProject(project.alignmentShadowRiskOverlay, project)
    : null;
  const resolved = resolveAlignmentShadowRiskOverlay(project);
  if (!overlay || !resolved || resolved.appliedCount === 0) {
    throw new Error("当前没有仍与项目证据匹配的音频风险，无法评估复核收益。");
  }
  const association = createAlignmentShadowRiskAssociationManifest(project);
  const associationByRecordId = new Map(
    association.records.map((record) => [record.recordId, record.recordEvidenceDigest])
  );
  const dataset = buildAlignmentTrainingDatasetExport(project, generatedAt);
  const activeRecords = project.alignmentReviewRecords.filter(
    (record) => record.recordState === "active"
  );
  const sampleByRecordId = new Map(
    activeRecords.map((record, index) => [record.id, dataset.samples[index]])
  );
  const rows = [...resolved.risks]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([recordId, risk], index): AlignmentShadowRiskEvaluationRow => {
      const evidenceDigest = associationByRecordId.get(recordId);
      const sample = sampleByRecordId.get(recordId);
      if (!evidenceDigest || !sample) {
        throw new Error("风险条目无法绑定当前训练证据，已拒绝生成效果收据。");
      }
      const adjudication = assessAlignmentAdjudication(project, recordId);
      const activeVoteCount = adjudication.activeVotes.filter(
        (vote) => vote.voteState === "active"
      ).length;
      const isGold = adjudication.state === "gold" && sample.proposalCorrect !== null;
      const frozenWithheld = isGold && sample.split === "frozen-test";
      const proposalCorrect = isGold && !frozenWithheld ? sample.proposalCorrect : null;
      const state: AlignmentShadowRiskEvaluationState = frozenWithheld
        ? "frozen-withheld"
        : proposalCorrect === true
          ? "gold-correct"
          : proposalCorrect === false
            ? "gold-error"
            : adjudication.state === "conflict"
              ? "conflict"
              : activeVoteCount > 0
                ? "weak-reviewed"
                : "pending";
      return {
        recordKey: digest(RECORD_KEY_DOMAIN, evidenceDigest),
        recordEvidenceDigest: evidenceDigest,
        rank: index + 1,
        risk,
        split: sample.split,
        state,
        proposalCorrect,
        distinctIndependentReviewerCount: adjudication.distinctIndependentReviewerCount,
        activeVoteCount
      };
    });
  const summary = buildSummary(rows);
  const body = {
    schemaVersion: "alignment-shadow-risk-evaluation-v1" as const,
    associationManifestId: association.manifestId,
    overlayId: overlay.overlayId,
    sourceRunId: overlay.sourceRunId,
    featureRecipeVersion: "rule-audio-local-support-risk-v1" as const,
    generatedAt,
    permission: "shadow-evaluation-only" as const,
    releaseEligible: false as const,
    rows,
    summary
  };
  return { ...body, receiptId: digest(RECEIPT_DIGEST_DOMAIN, body) };
}

export function serializeAlignmentShadowRiskEvaluationReceipt(
  receipt: AlignmentShadowRiskEvaluationReceipt
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function buildSummary(rows: AlignmentShadowRiskEvaluationRow[]) {
  const developmentCalibration = rows.filter((row) => row.split !== "frozen-test");
  const evaluated = rows.filter(
    (row) => row.state === "gold-correct" || row.state === "gold-error"
  );
  const errors = evaluated.filter((row) => row.state === "gold-error");
  const correct = evaluated.filter((row) => row.state === "gold-correct");
  const coverage = ratio(evaluated.length, developmentCalibration.length) ?? 0;
  const baselineErrorRate = ratio(errors.length, evaluated.length);
  const buckets = BUCKET_FRACTIONS.map((fraction) => {
    const reviewedRecordCount = Math.max(1, Math.ceil(rows.length * fraction));
    const bucketRows = rows.slice(0, reviewedRecordCount);
    const bucketGold = bucketRows.filter(
      (row) => row.state === "gold-correct" || row.state === "gold-error"
    );
    const bucketErrors = bucketGold.filter((row) => row.state === "gold-error");
    const errorYield = ratio(bucketErrors.length, bucketGold.length);
    return {
      fraction,
      reviewedRecordCount,
      evaluatedGoldCount: bucketGold.length,
      capturedGoldErrorCount: bucketErrors.length,
      goldErrorCaptureRate: ratio(bucketErrors.length, errors.length),
      goldErrorYield: errorYield,
      liftAgainstGoldBaseline:
        errorYield !== null && baselineErrorRate !== null && baselineErrorRate > 0
          ? round(errorYield / baselineErrorRate)
          : null
    };
  });
  return {
    rankedRecordCount: rows.length,
    developmentCalibrationRecordCount: developmentCalibration.length,
    evaluatedGoldCount: evaluated.length,
    goldErrorCount: errors.length,
    goldCorrectCount: correct.length,
    goldEvaluationCoverage: coverage,
    withheldFrozenGoldCount: rows.filter((row) => row.state === "frozen-withheld").length,
    conflictCount: rows.filter((row) => row.state === "conflict").length,
    weakReviewedCount: rows.filter((row) => row.state === "weak-reviewed").length,
    pendingCount: rows.filter((row) => row.state === "pending").length,
    goldBaselineErrorRate: baselineErrorRate,
    accuracyClaimReady:
      evaluated.length >= 20 &&
      coverage >= 0.8 &&
      errors.length >= 3 &&
      correct.length >= 3,
    buckets,
    note:
      "只有非 frozen 的独立裁决 Gold 参与正确率和错误捕获统计；弱复核、冲突和 frozen 结果不参与。accuracyClaimReady=false 时不得据此宣称模型准确率。"
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function digest(domain: string, value: unknown): string {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数字。");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}
