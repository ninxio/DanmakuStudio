import type { AlignmentReviewRecord, EditorProject } from "../project/types";
import { assessAlignmentAdjudication } from "./alignmentAdjudication";

export type AlignmentActiveReviewLevel = "critical" | "high" | "normal" | "gold";

export interface AlignmentActiveReviewPriority {
  recordId: string;
  score: number;
  level: AlignmentActiveReviewLevel;
  reasons: string[];
  revisionCount: number;
  selfConflict: boolean;
  maximumBoundaryRevisionMs: number;
}

/**
 * Deterministic active-review ordering for noisy human labels. It never upgrades a label and never
 * reveals the content of a prior decision. A shadow model may add ranking evidence, but the queue
 * remains useful without a trained model.
 */
export function rankAlignmentRecordsForActiveReview(
  project: Pick<EditorProject, "alignmentReviewRecords" | "alignmentReviewVotes">,
  shadowRiskByRecordId: ReadonlyMap<string, number> | null = null
): AlignmentActiveReviewPriority[] {
  const byId = new Map(project.alignmentReviewRecords.map((record) => [record.id, record]));
  return project.alignmentReviewRecords
    .filter((record) => record.recordState === "active")
    .map((record) => scoreRecord(project, record, byId, shadowRiskByRecordId))
    .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId));
}

function scoreRecord(
  project: Pick<EditorProject, "alignmentReviewRecords" | "alignmentReviewVotes">,
  record: AlignmentReviewRecord,
  byId: ReadonlyMap<string, AlignmentReviewRecord>,
  shadowRiskByRecordId: ReadonlyMap<string, number> | null
): AlignmentActiveReviewPriority {
  const history = collectHistory(record, byId);
  const prior = history.slice(1);
  const selfConflict = prior.some((item) => item.decision !== record.decision);
  const maximumBoundaryRevisionMs = prior.reduce(
    (maximum, item) => Math.max(maximum, boundaryDistance(record, item)),
    0
  );
  const tolerance = Math.max(
    record.boundaryToleranceMs ?? 0,
    ...prior.map((item) => item.boundaryToleranceMs ?? 0)
  );
  const adjudication = assessAlignmentAdjudication(project, record.id);
  if (adjudication.state === "gold") {
    return {
      recordId: record.id,
      score: 0,
      level: "gold",
      reasons: ["已形成独立 Gold"],
      revisionCount: prior.length,
      selfConflict,
      maximumBoundaryRevisionMs
    };
  }

  let score = 0;
  const reasons: string[] = [];
  if (adjudication.state === "conflict") {
    score += 100;
    reasons.push("不同复核者意见冲突");
  }
  if (selfConflict) {
    score += 55;
    reasons.push("这段的人工判断曾发生改变");
  }
  if (maximumBoundaryRevisionMs > Math.max(1_000, tolerance)) {
    score += 35;
    reasons.push("人工边界曾有明显漂移");
  }
  if (record.decision === "unresolved") {
    score += 28;
    reasons.push("仍未得到可用结论");
  }
  if (record.precision === "rough") {
    score += 22;
    reasons.push("只做过粗略判断");
  } else if (record.precision === "playbackChecked") {
    score += 10;
    reasons.push("只做过播放核对");
  }
  if (prior.length > 0) {
    score += Math.min(12, prior.length * 4);
    reasons.push(`已经修改过 ${prior.length} 次`);
  }

  const features = record.features;
  const differenceRisk = clamp01(features.differenceRiskP90);
  if (differenceRisk !== null) {
    score += differenceRisk * 30;
    if (differenceRisk >= 0.65) reasons.push("底层差异风险较高");
  }
  const ambiguousRatio = clamp01(features.ambiguousRatio);
  if (ambiguousRatio !== null) {
    score += ambiguousRatio * 20;
    if (ambiguousRatio >= 0.5) reasons.push("局部证据较不稳定");
  }
  const visualAmbiguousRatio = clamp01(features.visualAmbiguousRatio);
  if (visualAmbiguousRatio !== null) {
    score += visualAmbiguousRatio * 12;
    if (visualAmbiguousRatio >= 0.5) reasons.push("画面证据也未能消除歧义");
  }
  const margin = clamp01(features.alternativeMargin);
  if (margin !== null) {
    score += (1 - margin) * 12;
    if (margin <= 0.2) reasons.push("第一候选与备选差距很小");
  }
  const shadowRisk = clamp01(shadowRiskByRecordId?.get(record.id) ?? null);
  if (shadowRisk !== null) {
    score += shadowRisk * 30;
    if (shadowRisk >= 0.65) reasons.push("影子风险信号较高");
  }

  const roundedScore = Math.round(score * 10) / 10;
  return {
    recordId: record.id,
    score: roundedScore,
    level: roundedScore >= 90 ? "critical" : roundedScore >= 50 ? "high" : "normal",
    reasons: uniqueReasons(reasons),
    revisionCount: prior.length,
    selfConflict,
    maximumBoundaryRevisionMs
  };
}

function collectHistory(
  active: AlignmentReviewRecord,
  byId: ReadonlyMap<string, AlignmentReviewRecord>
): AlignmentReviewRecord[] {
  const result = [active];
  const visited = new Set([active.id]);
  let nextId = active.supersedesRecordId;
  while (nextId && !visited.has(nextId) && result.length < 100) {
    const next = byId.get(nextId);
    if (!next) break;
    result.push(next);
    visited.add(next.id);
    nextId = next.supersedesRecordId;
  }
  return result;
}

function boundaryDistance(left: AlignmentReviewRecord, right: AlignmentReviewRecord): number {
  return Math.max(
    Math.abs(left.sourceStartMs - right.sourceStartMs),
    Math.abs(left.sourceEndMs - right.sourceEndMs),
    Math.abs(left.targetStartMs - right.targetStartMs),
    Math.abs(left.targetEndMs - right.targetEndMs)
  );
}

function clamp01(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, 5);
}
