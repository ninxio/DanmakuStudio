import type {
  AlignmentReviewDecision,
  AlignmentReviewRecord,
  AlignmentReviewVote,
  AlignmentReviewVoteRole,
  EditorProject,
  MediaContentIdentity
} from "../project/types";
import { sha256Hex } from "../shared/sha256";
import {
  createAlignmentReviewRecordEvidenceDigestForProject
} from "./alignmentShadowRiskOverlay";

export interface SubmitAlignmentReviewVoteInput {
  reviewRecordId: string;
  reviewerId: string;
  reviewSessionId: string;
  role: AlignmentReviewVoteRole;
  decision: AlignmentReviewDecision;
  boundaryToleranceMs?: number | null;
  reviewStartedAt?: string | null;
  reviewedAt: string;
}

export interface SubmitAlignmentReviewVoteResult {
  ok: boolean;
  project: EditorProject;
  message: string;
}

export interface AlignmentAdjudicationStatus {
  state: "awaiting-independent" | "conflict" | "gold";
  independentVoteCount: number;
  distinctIndependentReviewerCount: number;
  decision: AlignmentReviewDecision | null;
  boundaryToleranceMs: number | null;
  resolution: "independentAgreement" | "adjudicator" | null;
  activeVotes: AlignmentReviewVote[];
}

export type AlignmentDatasetSplit = "development" | "calibration" | "frozen-test";

export interface AlignmentMediaFamilyAssignment {
  mediaGroupId: string;
  split: AlignmentDatasetSplit;
}

/**
 * 保存一张独立复核票。原始 reviewer 标识不会进入项目；同一 reviewer 对同一记录和角色
 * 的再次提交只会形成修订链，不能增加“独立复核者”数量。
 */
export function submitAlignmentReviewVote(
  project: EditorProject,
  input: SubmitAlignmentReviewVoteInput
): SubmitAlignmentReviewVoteResult {
  const record = project.alignmentReviewRecords.find(
    (item) => item.id === input.reviewRecordId && item.recordState === "active"
  );
  if (!record) {
    return { ok: false, project, message: "这条人工记录已失效或不存在，不能继续裁决。" };
  }
  const reviewerId = input.reviewerId.trim();
  if (reviewerId.length < 3 || reviewerId.length > 80) {
    return { ok: false, project, message: "复核者代号需为 3–80 个字符。" };
  }
  if (!input.reviewSessionId.trim()) {
    return { ok: false, project, message: "独立复核会话无效，请重新打开工作台。" };
  }
  const tolerance = normalizeBoundaryTolerance(input.boundaryToleranceMs);
  if (input.boundaryToleranceMs !== undefined && input.boundaryToleranceMs !== null && tolerance === null) {
    return { ok: false, project, message: "边界容差必须是非负整数毫秒。" };
  }
  const reviewerIdDigest = `sha256:${sha256Hex(`alignment-reviewer-v1:${reviewerId}`)}`;
  const reviewTelemetry = normalizeReviewTelemetry(input.reviewStartedAt, input.reviewedAt);
  const recordEvidenceDigest = createAlignmentReviewRecordEvidenceDigestForProject(
    project,
    record
  );
  const shadowEntry = project.alignmentShadowRiskOverlay?.entries.find(
    (entry) =>
      entry.recordId === record.id && entry.recordEvidenceDigest === recordEvidenceDigest
  );
  const activeVotes = project.alignmentReviewVotes.filter(
    (vote) => vote.reviewRecordId === record.id && vote.voteState === "active"
  );
  if (input.role === "adjudicator") {
    const independentReviewers = new Set(
      activeVotes
        .filter((vote) => vote.role === "independent")
        .map((vote) => vote.reviewerIdDigest)
    );
    const independentDecisions = new Set(
      activeVotes
        .filter((vote) => vote.role === "independent" && vote.decision !== "unresolved")
        .map((vote) => vote.decision)
    );
    if (independentReviewers.size < 2 || independentDecisions.size < 2) {
      return {
        ok: false,
        project,
        message: "只有两名独立复核者结论冲突后，才需要第三人仲裁。"
      };
    }
    if (independentReviewers.has(reviewerIdDigest)) {
      return {
        ok: false,
        project,
        message: "仲裁者必须与前两名独立复核者不同。"
      };
    }
  }

  const prior = [...activeVotes]
    .reverse()
    .find(
      (vote) => vote.reviewerIdDigest === reviewerIdDigest && vote.role === input.role
    );
  const id = `alignment-vote:${sha256Hex(
    JSON.stringify([
      record.id,
      reviewerIdDigest,
      input.reviewSessionId,
      input.role,
      input.decision,
      tolerance,
      reviewTelemetry,
      project.alignmentShadowRiskOverlay?.sourceRunId ?? null,
      shadowEntry?.recordEvidenceDigest ?? null,
      shadowEntry?.risk ?? null,
      input.reviewedAt
    ])
  )}`;
  const vote: AlignmentReviewVote = {
    voteVersion: 1,
    id,
    reviewRecordId: record.id,
    reviewerIdDigest,
    reviewSessionId: input.reviewSessionId,
    role: input.role,
    decision: input.decision,
    boundaryToleranceMs: tolerance,
    supersedesVoteId: prior?.id ?? null,
    voteState: "active",
    reviewedAt: input.reviewedAt,
    reviewStartedAt: reviewTelemetry?.startedAt ?? null,
    reviewDurationMs: reviewTelemetry?.durationMs ?? null,
    reviewDurationBasis: reviewTelemetry ? "first-form-interaction-to-submit-v1" : null,
    shadowRiskSourceRunId: shadowEntry
      ? project.alignmentShadowRiskOverlay?.sourceRunId ?? null
      : null,
    shadowRiskEvidenceDigest: shadowEntry?.recordEvidenceDigest ?? null,
    shadowRiskAtReview: shadowEntry?.risk ?? null
  };
  const votes = project.alignmentReviewVotes.map((item) =>
    prior && item.id === prior.id ? { ...item, voteState: "superseded" as const } : item
  );
  return {
    ok: true,
    project: { ...project, alignmentReviewVotes: [...votes, vote] },
    message:
      input.role === "adjudicator"
        ? "仲裁已保存；该样本现在可以按 Gold 规则评估。"
        : "独立复核已保存；同一复核者重复提交不会被计作第二票。"
  };
}

export function assessAlignmentAdjudication(
  project: Pick<EditorProject, "alignmentReviewVotes">,
  reviewRecordId: string
): AlignmentAdjudicationStatus {
  const activeVotes = project.alignmentReviewVotes.filter(
    (vote) => vote.reviewRecordId === reviewRecordId && vote.voteState === "active"
  );
  const independent = uniqueLatestVotesByReviewer(
    activeVotes.filter((vote) => vote.role === "independent")
  );
  const conclusive = independent.filter((vote) => vote.decision !== "unresolved");
  const decisions = new Set(conclusive.map((vote) => vote.decision));
  if (independent.length >= 2 && conclusive.length === independent.length && decisions.size === 1) {
    return {
      state: "gold",
      independentVoteCount: independent.length,
      distinctIndependentReviewerCount: independent.length,
      decision: conclusive[0]?.decision ?? null,
      boundaryToleranceMs: maximumTolerance(conclusive),
      resolution: "independentAgreement",
      activeVotes
    };
  }
  if (independent.length >= 2 && decisions.size >= 2) {
    const independentReviewers = new Set(independent.map((vote) => vote.reviewerIdDigest));
    const adjudicator = [...activeVotes]
      .reverse()
      .find(
        (vote) =>
          vote.role === "adjudicator" &&
          vote.decision !== "unresolved" &&
          !independentReviewers.has(vote.reviewerIdDigest)
      );
    if (adjudicator) {
      return {
        state: "gold",
        independentVoteCount: independent.length,
        distinctIndependentReviewerCount: independent.length,
        decision: adjudicator.decision,
        boundaryToleranceMs: adjudicator.boundaryToleranceMs,
        resolution: "adjudicator",
        activeVotes
      };
    }
    return {
      state: "conflict",
      independentVoteCount: independent.length,
      distinctIndependentReviewerCount: independent.length,
      decision: null,
      boundaryToleranceMs: null,
      resolution: null,
      activeVotes
    };
  }
  return {
    state: "awaiting-independent",
    independentVoteCount: independent.length,
    distinctIndependentReviewerCount: independent.length,
    decision: null,
    boundaryToleranceMs: null,
    resolution: null,
    activeVotes
  };
}

/**
 * 以媒体连接分量分组：只要两个样本共享长参考、原片或同内容身份，就只能进入同一
 * split。split 由稳定摘要确定，不允许导出时手工挑选。
 */
export function buildAlignmentMediaFamilyAssignments(
  project: EditorProject,
  records: AlignmentReviewRecord[]
): Map<string, AlignmentMediaFamilyAssignment> {
  const parent = new Map<string, string>();
  const recordEndpoints = new Map<string, [string, string]>();
  const find = (value: string): string => {
    const current = parent.get(value);
    if (!current) {
      parent.set(value, value);
      return value;
    }
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second, first);
  };

  for (const record of records) {
    const timeMap = project.mediaTimeMaps.find((item) => item.id === record.timeMapId);
    const source = mediaEndpointToken(project.id, record.sourceMediaId, timeMap?.sourceIdentity ?? null);
    const target = mediaEndpointToken(project.id, record.targetMediaId, timeMap?.targetIdentity ?? null);
    recordEndpoints.set(record.id, [source, target]);
    union(source, target);
  }

  const membersByRoot = new Map<string, Set<string>>();
  for (const endpoints of recordEndpoints.values()) {
    const root = find(endpoints[0]);
    const members = membersByRoot.get(root) ?? new Set<string>();
    members.add(endpoints[0]);
    members.add(endpoints[1]);
    membersByRoot.set(root, members);
  }
  const familyByRoot = new Map<string, AlignmentMediaFamilyAssignment>();
  for (const [root, members] of membersByRoot) {
    const mediaGroupId = `media-family:${sha256Hex(JSON.stringify([...members].sort()))}`;
    familyByRoot.set(root, { mediaGroupId, split: assignStableSplit(mediaGroupId) });
  }
  const result = new Map<string, AlignmentMediaFamilyAssignment>();
  for (const [recordId, endpoints] of recordEndpoints) {
    const assignment = familyByRoot.get(find(endpoints[0]));
    if (assignment) result.set(recordId, assignment);
  }
  return result;
}

function uniqueLatestVotesByReviewer(votes: AlignmentReviewVote[]): AlignmentReviewVote[] {
  const latest = new Map<string, AlignmentReviewVote>();
  for (const vote of votes) latest.set(vote.reviewerIdDigest, vote);
  return [...latest.values()];
}

function maximumTolerance(votes: AlignmentReviewVote[]): number | null {
  const values = votes
    .map((vote) => vote.boundaryToleranceMs)
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

function mediaEndpointToken(
  projectId: string,
  mediaId: string,
  identity: MediaContentIdentity | null
): string {
  const payload = identity
    ? [
        identity.algorithm,
        identity.sizeBytes,
        identity.firstSampleDigest,
        identity.middleSampleDigest,
        identity.lastSampleDigest
      ]
    : ["project-media", projectId, mediaId];
  return `media:${sha256Hex(JSON.stringify(payload))}`;
}

function assignStableSplit(mediaGroupId: string): AlignmentDatasetSplit {
  const bucket = Number.parseInt(sha256Hex(`alignment-split-v1:${mediaGroupId}`).slice(0, 8), 16) % 100;
  if (bucket < 70) return "development";
  if (bucket < 85) return "calibration";
  return "frozen-test";
}

function normalizeBoundaryTolerance(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeReviewTelemetry(
  startedAt: string | null | undefined,
  reviewedAt: string
): { startedAt: string; durationMs: number } | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(reviewedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const durationMs = end - start;
  if (!Number.isSafeInteger(durationMs) || durationMs > 24 * 60 * 60 * 1_000) return null;
  return { startedAt, durationMs };
}
