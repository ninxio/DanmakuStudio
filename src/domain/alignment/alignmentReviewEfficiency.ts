import type { AlignmentReviewVoteRole, EditorProject } from "../project/types";
import { sha256Hex } from "../shared/sha256";
import {
  createAlignmentShadowRiskAssociationManifest,
  resolveAlignmentShadowRiskOverlay
} from "./alignmentShadowRiskOverlay";

const RECEIPT_DOMAIN = "danmaku-studio/alignment-review-efficiency/v1";
const RECORD_KEY_DOMAIN = "danmaku-studio/alignment-review-efficiency-record/v1";
const VOTE_KEY_DOMAIN = "danmaku-studio/alignment-review-efficiency-vote/v1";

export type AlignmentReviewRiskEvidenceState = "matching" | "stale" | "absent";

export interface AlignmentReviewEfficiencyRow {
  voteKey: string;
  recordKey: string;
  recordEvidenceDigest: string;
  role: AlignmentReviewVoteRole;
  reviewedAt: string;
  durationMs: number | null;
  durationBasis: "first-form-interaction-to-submit-v1" | null;
  shadowRiskSourceRunId: string | null;
  shadowRisk: number | null;
  shadowRiskEvidenceState: AlignmentReviewRiskEvidenceState;
}

export interface AlignmentReviewEfficiencyRiskBand {
  band: "high" | "medium" | "low";
  minimumRisk: number;
  maximumRisk: number;
  measuredVoteCount: number;
  medianDurationMs: number | null;
  p90DurationMs: number | null;
}

export interface AlignmentReviewEfficiencyReceipt {
  schemaVersion: "alignment-review-efficiency-v1";
  associationManifestId: string;
  projectIdDigest: string;
  generatedAt: string;
  permission: "review-efficiency-measurement-only";
  releaseEligible: false;
  rows: AlignmentReviewEfficiencyRow[];
  summary: {
    submittedVoteCount: number;
    measuredVoteCount: number;
    unmeasuredVoteCount: number;
    medianDurationMs: number | null;
    p90DurationMs: number | null;
    measuredWithShadowRiskCount: number;
    staleCapturedRiskCount: number;
    currentOverlayEntryCount: number;
    currentOverlayAppliedCount: number;
    currentOverlayStaleCount: number;
    currentOverlayStaleRatio: number | null;
    riskBands: AlignmentReviewEfficiencyRiskBand[];
    note: string;
  };
  receiptId: string;
}

/**
 * Export path-free workflow telemetry. It deliberately omits decisions, reviewer digests, media
 * identifiers and correctness labels, so measuring review cost cannot become a hidden label path.
 */
export function buildAlignmentReviewEfficiencyReceipt(
  project: EditorProject,
  generatedAt = new Date().toISOString()
): AlignmentReviewEfficiencyReceipt {
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("复核效率收据时间无效。");
  }
  const association = createAlignmentShadowRiskAssociationManifest(project);
  const evidenceByRecordId = new Map(
    association.records.map((record) => [record.recordId, record.recordEvidenceDigest])
  );
  const rows = project.alignmentReviewVotes
    .filter((vote) => evidenceByRecordId.has(vote.reviewRecordId))
    .map((vote): AlignmentReviewEfficiencyRow => {
      const evidenceDigest = evidenceByRecordId.get(vote.reviewRecordId);
      if (!evidenceDigest) throw new Error("复核票无法绑定当前记录证据。");
      const hasRisk =
        typeof vote.shadowRiskAtReview === "number" &&
        typeof vote.shadowRiskSourceRunId === "string" &&
        typeof vote.shadowRiskEvidenceDigest === "string";
      const evidenceState: AlignmentReviewRiskEvidenceState = !hasRisk
        ? "absent"
        : vote.shadowRiskEvidenceDigest === evidenceDigest
          ? "matching"
          : "stale";
      const durationMs = normalizeDuration(vote.reviewDurationMs);
      return {
        voteKey: digest(VOTE_KEY_DOMAIN, vote.id),
        recordKey: digest(RECORD_KEY_DOMAIN, evidenceDigest),
        recordEvidenceDigest: evidenceDigest,
        role: vote.role,
        reviewedAt: vote.reviewedAt,
        durationMs,
        durationBasis:
          durationMs !== null &&
          vote.reviewDurationBasis === "first-form-interaction-to-submit-v1"
            ? vote.reviewDurationBasis
            : null,
        shadowRiskSourceRunId: hasRisk ? vote.shadowRiskSourceRunId ?? null : null,
        shadowRisk: hasRisk ? vote.shadowRiskAtReview ?? null : null,
        shadowRiskEvidenceState: evidenceState
      };
    })
    .sort(
      (left, right) =>
        left.reviewedAt.localeCompare(right.reviewedAt) || left.voteKey.localeCompare(right.voteKey)
    );
  if (rows.length === 0) {
    throw new Error("当前没有可测量的独立复核提交。完成至少一次复核后再导出。");
  }
  const resolvedOverlay = resolveAlignmentShadowRiskOverlay(project);
  const overlayEntryCount = project.alignmentShadowRiskOverlay?.entries.length ?? 0;
  const durations = measuredDurations(rows);
  const summary = {
    submittedVoteCount: rows.length,
    measuredVoteCount: durations.length,
    unmeasuredVoteCount: rows.length - durations.length,
    medianDurationMs: quantile(durations, 0.5),
    p90DurationMs: quantile(durations, 0.9),
    measuredWithShadowRiskCount: rows.filter(
      (row) => row.durationMs !== null && row.shadowRiskEvidenceState === "matching"
    ).length,
    staleCapturedRiskCount: rows.filter(
      (row) => row.shadowRiskEvidenceState === "stale"
    ).length,
    currentOverlayEntryCount: overlayEntryCount,
    currentOverlayAppliedCount: resolvedOverlay?.appliedCount ?? 0,
    currentOverlayStaleCount: resolvedOverlay?.staleCount ?? 0,
    currentOverlayStaleRatio:
      overlayEntryCount > 0
        ? round((resolvedOverlay?.staleCount ?? 0) / overlayEntryCount)
        : null,
    riskBands: buildRiskBands(rows),
    note:
      "耗时从首次操作本行表单到提交，属于低成本近似值而非逐帧人工工时；收据不含决定、正确性或复核者身份，不能生成 Gold 或宣称模型准确率。"
  };
  const body = {
    schemaVersion: "alignment-review-efficiency-v1" as const,
    associationManifestId: association.manifestId,
    projectIdDigest: association.projectIdDigest,
    generatedAt,
    permission: "review-efficiency-measurement-only" as const,
    releaseEligible: false as const,
    rows,
    summary
  };
  return { ...body, receiptId: digest(RECEIPT_DOMAIN, body) };
}

export function serializeAlignmentReviewEfficiencyReceipt(
  receipt: AlignmentReviewEfficiencyReceipt
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function buildRiskBands(rows: AlignmentReviewEfficiencyRow[]): AlignmentReviewEfficiencyRiskBand[] {
  const definitions = [
    { band: "high" as const, minimumRisk: 0.75, maximumRisk: 1 },
    { band: "medium" as const, minimumRisk: 0.5, maximumRisk: 0.75 },
    { band: "low" as const, minimumRisk: 0, maximumRisk: 0.5 }
  ];
  return definitions.map((definition) => {
    const durations = rows
      .filter(
        (row) =>
          row.shadowRiskEvidenceState === "matching" &&
          row.shadowRisk !== null &&
          row.shadowRisk >= definition.minimumRisk &&
          (definition.band === "high"
            ? row.shadowRisk <= definition.maximumRisk
            : row.shadowRisk < definition.maximumRisk)
      )
      .flatMap((row) => (row.durationMs === null ? [] : [row.durationMs]));
    return {
      ...definition,
      measuredVoteCount: durations.length,
      medianDurationMs: quantile(durations, 0.5),
      p90DurationMs: quantile(durations, 0.9)
    };
  });
}

function measuredDurations(rows: AlignmentReviewEfficiencyRow[]): number[] {
  return rows.flatMap((row) => (row.durationMs === null ? [] : [row.durationMs]));
}

function normalizeDuration(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 24 * 60 * 60 * 1_000
    ? value
    : null;
}

function quantile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? null;
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
