import {
  MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS,
  MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION,
  MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA,
  normalizeMultimodalBlindReviewAnswer,
  parseMultimodalBlindReviewPack,
  sha256Json,
  type MultimodalBlindReviewPack,
  type MultimodalBlindReviewVote,
  type MultimodalBlindReviewVoteSet
} from "./multimodalBlindReview";

export const MULTIMODAL_BLIND_ADJUDICATION_SCHEMA =
  "alignment-multimodal-blind-adjudication-v1";
export const MULTIMODAL_BLIND_LABEL_MERGE_SCHEMA =
  "alignment-multimodal-blind-label-merge-v1";
export const MULTIMODAL_BLIND_ADJUDICATION_PERMISSION =
  "local-frozen-gold-preparation-only";
export const MULTIMODAL_BLIND_LABEL_MERGE_PERMISSION =
  "frozen-gold-label-commitment-preparation-only";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TASK_STATUSES = new Set<MultimodalBlindAdjudicationTaskStatus>([
  "gold",
  "conflict",
  "pending",
  "weakOnly"
]);

export type MultimodalBlindAdjudicationTaskStatus =
  | "gold"
  | "conflict"
  | "pending"
  | "weakOnly";

export interface MultimodalBlindGoldLabel {
  queryKey: string;
  mediaFamilyId: string;
  expectedTargetTimestampMs: number;
  boundaryToleranceMs: number;
  precision: "adjudicatedGold";
  independentReviewerCount: number;
  adjudicationReceiptId: string;
}

export interface MultimodalBlindAdjudicationTaskState {
  taskId: string;
  queryKey: string;
  status: MultimodalBlindAdjudicationTaskStatus;
  preciseVoteCount: number;
  weakVoteCount: number;
  reason: string;
}

export interface MultimodalBlindAdjudicationSummary {
  tasks: number;
  gold: number;
  conflicts: number;
  pending: number;
  weakOnly: number;
}

export interface MultimodalBlindAdjudication {
  schemaVersion: typeof MULTIMODAL_BLIND_ADJUDICATION_SCHEMA;
  packId: string;
  mediaFamilyId: string;
  voteSetIds: string[];
  labels: MultimodalBlindGoldLabel[];
  taskStates: MultimodalBlindAdjudicationTaskState[];
  summary: MultimodalBlindAdjudicationSummary;
  containsMediaPaths: false;
  permission: typeof MULTIMODAL_BLIND_ADJUDICATION_PERMISSION;
  releaseEligible: false;
  adjudicationId: string;
}

export interface MultimodalBlindPrivateLabels {
  labels: MultimodalBlindGoldLabel[];
}

export interface MultimodalBlindLabelMergeReceipt {
  schemaVersion: typeof MULTIMODAL_BLIND_LABEL_MERGE_SCHEMA;
  adjudicationIds: string[];
  familyCount: number;
  queryCount: number;
  labelsCommitment: string;
  permission: typeof MULTIMODAL_BLIND_LABEL_MERGE_PERMISSION;
  releaseEligible: false;
  mergeId: string;
}

export function parseMultimodalBlindReviewVoteSetJson(
  json: string,
  pack: MultimodalBlindReviewPack
): MultimodalBlindReviewVoteSet {
  return parseMultimodalBlindReviewVoteSet(JSON.parse(json) as unknown, pack);
}

export function parseMultimodalBlindReviewVoteSet(
  value: unknown,
  packValue: MultimodalBlindReviewPack
): MultimodalBlindReviewVoteSet {
  const pack = parseMultimodalBlindReviewPack(packValue);
  const record = requireRecord(value, "匿名复核票");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "packId",
      "reviewerIdDigest",
      "votes",
      "permission",
      "releaseEligible",
      "voteSetId"
    ],
    "匿名复核票"
  );
  const voteSetId = requireSha256(record.voteSetId, "复核票 ID");
  if (voteSetId !== sha256Json(withoutKey(record, "voteSetId"))) {
    throw new Error("匿名复核票身份不一致，文件可能被修改或损坏。");
  }
  if (
    record.schemaVersion !== MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA ||
    record.packId !== pack.packId ||
    record.permission !== MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION ||
    record.releaseEligible !== false
  ) {
    throw new Error("匿名复核票不属于当前任务包，或权限版本无效。");
  }
  const reviewerIdDigest = requireSha256(record.reviewerIdDigest, "复核者摘要");
  if (!Array.isArray(record.votes) || record.votes.length !== pack.tasks.length) {
    throw new Error("匿名复核票必须完整覆盖当前任务包的全部任务。");
  }
  const votes = record.votes.map((value, index) =>
    parseVote(value, pack.tasks[index], `第 ${index + 1} 条匿名复核票`)
  );
  return {
    schemaVersion: MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA,
    packId: pack.packId,
    reviewerIdDigest,
    votes,
    permission: MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION,
    releaseEligible: false,
    voteSetId
  };
}

export function buildMultimodalBlindAdjudication(
  packValue: MultimodalBlindReviewPack,
  voteSetValues: readonly MultimodalBlindReviewVoteSet[]
): MultimodalBlindAdjudication {
  const pack = parseMultimodalBlindReviewPack(packValue);
  if (voteSetValues.length < 2) {
    throw new Error("至少导入两名真实独立复核者的匿名票后才能裁决。");
  }
  const voteSets = voteSetValues.map((value) =>
    parseMultimodalBlindReviewVoteSet(value, pack)
  );
  const reviewerDigests = voteSets.map((value) => value.reviewerIdDigest);
  if (new Set(reviewerDigests).size !== reviewerDigests.length) {
    throw new Error("存在重复复核者；同一人更换或重复导出票据不能增加独立票数。");
  }
  voteSets.sort((left, right) => compareAscii(left.reviewerIdDigest, right.reviewerIdDigest));
  const voteSetIds = voteSets.map((value) => value.voteSetId).sort();
  const labels: MultimodalBlindGoldLabel[] = [];
  const taskStates: MultimodalBlindAdjudicationTaskState[] = [];

  pack.tasks.forEach((task, taskIndex) => {
    const rows = voteSets.map((value) => value.votes[taskIndex]);
    const precise = rows.filter((row) => row.precision === "frameAccurate");
    const weak = rows.filter(
      (row) => row.precision === "rough" || row.precision === "playbackChecked"
    );
    let status: MultimodalBlindAdjudicationTaskStatus = "pending";
    let reason = "needs-two-frame-accurate-votes";
    if (precise.length >= 2) {
      if (precise.some((row) => row.decision !== "matched")) {
        status = "conflict";
        reason = "precise-votes-do-not-all-confirm-a-match";
      } else {
        const timestamps = precise.map((row) => row.targetTimestampMs as number);
        if (Math.max(...timestamps) - Math.min(...timestamps) > MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS) {
          status = "conflict";
          reason = "precise-votes-exceed-one-second";
        } else {
          const ordered = [...timestamps].sort((left, right) => left - right);
          const expected = Math.floor(
            (ordered[Math.floor((ordered.length - 1) / 2)] +
              ordered[Math.floor(ordered.length / 2)]) /
              2
          );
          const tolerance = Math.max(
            ...precise.map((row) => row.boundaryToleranceMs as number),
            ...timestamps.map((timestamp) => Math.abs(timestamp - expected))
          );
          if (tolerance > MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS) {
            status = "conflict";
            reason = "combined-boundary-tolerance-exceeds-one-second";
          } else {
            status = "gold";
            reason = "independent-frame-accurate-agreement";
            const receiptBody = {
              packId: pack.packId,
              taskId: task.taskId,
              queryKey: task.queryKey,
              voteSetIds,
              expectedTargetTimestampMs: expected,
              boundaryToleranceMs: tolerance
            };
            labels.push({
              queryKey: task.queryKey,
              mediaFamilyId: pack.mediaFamilyId,
              expectedTargetTimestampMs: expected,
              boundaryToleranceMs: tolerance,
              precision: "adjudicatedGold",
              independentReviewerCount: precise.length,
              adjudicationReceiptId: sha256Json(receiptBody)
            });
          }
        }
      }
    } else if (weak.length > 0 && precise.length === 0) {
      status = "weakOnly";
      reason = "rough-or-playback-votes-are-never-gold";
    }
    taskStates.push({
      taskId: task.taskId,
      queryKey: task.queryKey,
      status,
      preciseVoteCount: precise.length,
      weakVoteCount: weak.length,
      reason
    });
  });

  const summary = summarizeTaskStates(taskStates);
  const body = {
    schemaVersion: MULTIMODAL_BLIND_ADJUDICATION_SCHEMA as typeof MULTIMODAL_BLIND_ADJUDICATION_SCHEMA,
    packId: pack.packId,
    mediaFamilyId: pack.mediaFamilyId,
    voteSetIds,
    labels,
    taskStates,
    summary,
    containsMediaPaths: false as const,
    permission: MULTIMODAL_BLIND_ADJUDICATION_PERMISSION as typeof MULTIMODAL_BLIND_ADJUDICATION_PERMISSION,
    releaseEligible: false as const
  };
  return parseMultimodalBlindAdjudication({ ...body, adjudicationId: sha256Json(body) });
}

export function parseMultimodalBlindAdjudicationJson(
  json: string
): MultimodalBlindAdjudication {
  return parseMultimodalBlindAdjudication(JSON.parse(json) as unknown);
}

export function parseMultimodalBlindAdjudication(
  value: unknown
): MultimodalBlindAdjudication {
  const record = requireRecord(value, "盲复核裁决");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "packId",
      "mediaFamilyId",
      "voteSetIds",
      "labels",
      "taskStates",
      "summary",
      "containsMediaPaths",
      "permission",
      "releaseEligible",
      "adjudicationId"
    ],
    "盲复核裁决"
  );
  const adjudicationId = requireSha256(record.adjudicationId, "裁决 ID");
  if (adjudicationId !== sha256Json(withoutKey(record, "adjudicationId"))) {
    throw new Error("盲复核裁决身份不一致，文件可能被修改或损坏。");
  }
  if (
    record.schemaVersion !== MULTIMODAL_BLIND_ADJUDICATION_SCHEMA ||
    record.containsMediaPaths !== false ||
    record.permission !== MULTIMODAL_BLIND_ADJUDICATION_PERMISSION ||
    record.releaseEligible !== false
  ) {
    throw new Error("盲复核裁决权限或版本无效。");
  }
  const packId = requireSha256(record.packId, "任务包 ID");
  const mediaFamilyId = requireSha256(record.mediaFamilyId, "媒体家族 ID");
  const voteSetIds = parseSortedUniqueDigests(record.voteSetIds, "匿名复核票 ID", 2);
  if (!Array.isArray(record.labels) || !Array.isArray(record.taskStates) || record.taskStates.length === 0) {
    throw new Error("盲复核裁决缺少标签或任务状态。");
  }
  const labels = record.labels.map((label, index) =>
    parseGoldLabel(label, mediaFamilyId, voteSetIds.length, `第 ${index + 1} 个 Gold 标签`)
  );
  assertStableUnique(labels.map((label) => label.queryKey), "Gold 标签查询");
  const receiptIds = labels.map((label) => label.adjudicationReceiptId);
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("Gold 标签包含重复裁决收据。");
  }
  const taskStates = record.taskStates.map((state, index) =>
    parseTaskState(state, voteSetIds.length, `第 ${index + 1} 个任务状态`)
  );
  assertStableUnique(taskStates.map((state) => state.queryKey), "任务状态查询");
  if (new Set(taskStates.map((state) => state.taskId)).size !== taskStates.length) {
    throw new Error("盲复核裁决包含重复任务 ID。");
  }
  const goldQueries = new Set(
    taskStates.filter((state) => state.status === "gold").map((state) => state.queryKey)
  );
  if (
    goldQueries.size !== labels.length ||
    labels.some((label) => !goldQueries.has(label.queryKey))
  ) {
    throw new Error("盲复核 Gold 标签与任务状态不一致。");
  }
  const summary = parseSummary(record.summary);
  if (JSON.stringify(summary) !== JSON.stringify(summarizeTaskStates(taskStates))) {
    throw new Error("盲复核裁决汇总与逐任务状态不一致。");
  }
  return {
    schemaVersion: MULTIMODAL_BLIND_ADJUDICATION_SCHEMA,
    packId,
    mediaFamilyId,
    voteSetIds,
    labels,
    taskStates,
    summary,
    containsMediaPaths: false,
    permission: MULTIMODAL_BLIND_ADJUDICATION_PERMISSION,
    releaseEligible: false,
    adjudicationId
  };
}

export function buildMultimodalBlindLabelMerge(
  values: readonly MultimodalBlindAdjudication[]
): { privateLabels: MultimodalBlindPrivateLabels; receipt: MultimodalBlindLabelMergeReceipt } {
  const adjudications = values.map(parseMultimodalBlindAdjudication);
  if (adjudications.length < 3) {
    throw new Error("冻结准备至少需要三个互不泄漏的媒体家族。");
  }
  const families = new Set<string>();
  const queries = new Set<string>();
  const receiptIds = new Set<string>();
  const labels: MultimodalBlindGoldLabel[] = [];
  for (const adjudication of adjudications) {
    if (families.has(adjudication.mediaFamilyId)) {
      throw new Error("冻结准备重复使用了同一个媒体家族。");
    }
    families.add(adjudication.mediaFamilyId);
    if (adjudication.summary.tasks < 20) {
      throw new Error("每个媒体家族至少需要 20 个盲复核任务。");
    }
    if (
      adjudication.summary.gold !== adjudication.summary.tasks ||
      adjudication.labels.length !== adjudication.summary.tasks
    ) {
      throw new Error("冻结准备不能包含待处理、弱标签或冲突任务。");
    }
    for (const label of adjudication.labels) {
      if (queries.has(label.queryKey) || receiptIds.has(label.adjudicationReceiptId)) {
        throw new Error("冻结准备包含跨家族重复查询或裁决收据。");
      }
      queries.add(label.queryKey);
      receiptIds.add(label.adjudicationReceiptId);
      labels.push(label);
    }
  }
  if (queries.size < 60) {
    throw new Error("冻结准备至少需要 60 个完整 Gold 查询。");
  }
  labels.sort((left, right) => compareAscii(left.queryKey, right.queryKey));
  const privateLabels = { labels };
  const body = {
    schemaVersion: MULTIMODAL_BLIND_LABEL_MERGE_SCHEMA as typeof MULTIMODAL_BLIND_LABEL_MERGE_SCHEMA,
    adjudicationIds: adjudications.map((value) => value.adjudicationId).sort(),
    familyCount: families.size,
    queryCount: queries.size,
    labelsCommitment: sha256Json(labels),
    permission: MULTIMODAL_BLIND_LABEL_MERGE_PERMISSION as typeof MULTIMODAL_BLIND_LABEL_MERGE_PERMISSION,
    releaseEligible: false as const
  };
  const receipt = parseMultimodalBlindLabelMergeReceipt({ ...body, mergeId: sha256Json(body) });
  return { privateLabels, receipt };
}

export function parseMultimodalBlindLabelMergeReceiptJson(
  json: string
): MultimodalBlindLabelMergeReceipt {
  return parseMultimodalBlindLabelMergeReceipt(JSON.parse(json) as unknown);
}

export function parseMultimodalBlindLabelMergeReceipt(
  value: unknown
): MultimodalBlindLabelMergeReceipt {
  const record = requireRecord(value, "冻结标签合并收据");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "adjudicationIds",
      "familyCount",
      "queryCount",
      "labelsCommitment",
      "permission",
      "releaseEligible",
      "mergeId"
    ],
    "冻结标签合并收据"
  );
  const mergeId = requireSha256(record.mergeId, "合并收据 ID");
  if (mergeId !== sha256Json(withoutKey(record, "mergeId"))) {
    throw new Error("冻结标签合并收据身份不一致，文件可能被修改或损坏。");
  }
  if (
    record.schemaVersion !== MULTIMODAL_BLIND_LABEL_MERGE_SCHEMA ||
    record.permission !== MULTIMODAL_BLIND_LABEL_MERGE_PERMISSION ||
    record.releaseEligible !== false
  ) {
    throw new Error("冻结标签合并收据权限或版本无效。");
  }
  const adjudicationIds = parseSortedUniqueDigests(record.adjudicationIds, "裁决 ID", 3);
  const familyCount = requireNonnegativeInteger(record.familyCount, "媒体家族数");
  const queryCount = requireNonnegativeInteger(record.queryCount, "Gold 查询数");
  if (familyCount !== adjudicationIds.length || familyCount < 3 || queryCount < 60) {
    throw new Error("冻结标签合并收据数量不足或不一致。");
  }
  return {
    schemaVersion: MULTIMODAL_BLIND_LABEL_MERGE_SCHEMA,
    adjudicationIds,
    familyCount,
    queryCount,
    labelsCommitment: requireSha256(record.labelsCommitment, "标签承诺"),
    permission: MULTIMODAL_BLIND_LABEL_MERGE_PERMISSION,
    releaseEligible: false,
    mergeId
  };
}

export function serializeMultimodalBlindAdjudication(
  value: MultimodalBlindAdjudication
): string {
  return `${JSON.stringify(parseMultimodalBlindAdjudication(value), null, 2)}\n`;
}

export function serializeMultimodalBlindPrivateLabels(
  value: MultimodalBlindPrivateLabels
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeMultimodalBlindLabelMergeReceipt(
  value: MultimodalBlindLabelMergeReceipt
): string {
  return `${JSON.stringify(parseMultimodalBlindLabelMergeReceipt(value), null, 2)}\n`;
}

function parseVote(
  value: unknown,
  task: MultimodalBlindReviewPack["tasks"][number],
  label: string
): MultimodalBlindReviewVote {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      "taskId",
      "queryKey",
      "decision",
      "targetTimestampMs",
      "boundaryToleranceMs",
      "precision"
    ],
    label
  );
  if (record.taskId !== task.taskId || record.queryKey !== task.queryKey) {
    throw new Error(`${label}没有绑定当前任务。`);
  }
  const normalized = normalizeMultimodalBlindReviewAnswer(
    {
      taskId: task.taskId,
      decision: record.decision as MultimodalBlindReviewVote["decision"],
      targetTimestampMs: record.targetTimestampMs as number | null,
      boundaryToleranceMs: record.boundaryToleranceMs as number | null,
      precision: record.precision as MultimodalBlindReviewVote["precision"]
    },
    task
  );
  return { ...normalized, queryKey: task.queryKey };
}

function parseGoldLabel(
  value: unknown,
  mediaFamilyId: string,
  voteSetCount: number,
  label: string
): MultimodalBlindGoldLabel {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    [
      "queryKey",
      "mediaFamilyId",
      "expectedTargetTimestampMs",
      "boundaryToleranceMs",
      "precision",
      "independentReviewerCount",
      "adjudicationReceiptId"
    ],
    label
  );
  const boundaryToleranceMs = requireNonnegativeInteger(
    record.boundaryToleranceMs,
    `${label}边界容差`
  );
  const independentReviewerCount = requireNonnegativeInteger(
    record.independentReviewerCount,
    `${label}独立复核者数`
  );
  if (
    record.mediaFamilyId !== mediaFamilyId ||
    record.precision !== "adjudicatedGold" ||
    boundaryToleranceMs > MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS ||
    independentReviewerCount < 2 ||
    independentReviewerCount > voteSetCount
  ) {
    throw new Error(`${label}不满足独立 Gold 约束。`);
  }
  return {
    queryKey: requireSha256(record.queryKey, `${label}查询`),
    mediaFamilyId,
    expectedTargetTimestampMs: requireNonnegativeInteger(
      record.expectedTargetTimestampMs,
      `${label}目标位置`
    ),
    boundaryToleranceMs,
    precision: "adjudicatedGold",
    independentReviewerCount,
    adjudicationReceiptId: requireSha256(record.adjudicationReceiptId, `${label}裁决收据`)
  };
}

function parseTaskState(
  value: unknown,
  voteSetCount: number,
  label: string
): MultimodalBlindAdjudicationTaskState {
  const record = requireRecord(value, label);
  requireExactKeys(
    record,
    ["taskId", "queryKey", "status", "preciseVoteCount", "weakVoteCount", "reason"],
    label
  );
  const status = record.status as MultimodalBlindAdjudicationTaskStatus;
  const preciseVoteCount = requireNonnegativeInteger(record.preciseVoteCount, `${label}精确票数`);
  const weakVoteCount = requireNonnegativeInteger(record.weakVoteCount, `${label}弱票数`);
  if (
    !TASK_STATUSES.has(status) ||
    preciseVoteCount + weakVoteCount > voteSetCount ||
    typeof record.reason !== "string" ||
    record.reason.length === 0
  ) {
    throw new Error(`${label}状态、计数或原因无效。`);
  }
  return {
    taskId: requireSha256(record.taskId, `${label}任务 ID`),
    queryKey: requireSha256(record.queryKey, `${label}查询 ID`),
    status,
    preciseVoteCount,
    weakVoteCount,
    reason: record.reason
  };
}

function parseSummary(value: unknown): MultimodalBlindAdjudicationSummary {
  const record = requireRecord(value, "盲复核裁决汇总");
  requireExactKeys(record, ["tasks", "gold", "conflicts", "pending", "weakOnly"], "盲复核裁决汇总");
  return {
    tasks: requireNonnegativeInteger(record.tasks, "任务数"),
    gold: requireNonnegativeInteger(record.gold, "Gold 数"),
    conflicts: requireNonnegativeInteger(record.conflicts, "冲突数"),
    pending: requireNonnegativeInteger(record.pending, "待处理数"),
    weakOnly: requireNonnegativeInteger(record.weakOnly, "弱标签数")
  };
}

function summarizeTaskStates(
  states: readonly MultimodalBlindAdjudicationTaskState[]
): MultimodalBlindAdjudicationSummary {
  return {
    tasks: states.length,
    gold: states.filter((state) => state.status === "gold").length,
    conflicts: states.filter((state) => state.status === "conflict").length,
    pending: states.filter((state) => state.status === "pending").length,
    weakOnly: states.filter((state) => state.status === "weakOnly").length
  };
}

function parseSortedUniqueDigests(value: unknown, label: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${label}数量不足。`);
  }
  const digests = value.map((item, index) => requireSha256(item, `${label} ${index + 1}`));
  if (
    new Set(digests).size !== digests.length ||
    digests.some((digest, index) => digest !== [...digests].sort()[index])
  ) {
    throw new Error(`${label}必须唯一并按稳定顺序保存。`);
  }
  return digests;
}

function assertStableUnique(values: string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== [...values].sort()[index])
  ) {
    throw new Error(`${label}必须唯一并按稳定顺序保存。`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label}字段与严格合同不一致。`);
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label}必须是 SHA-256 摘要。`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负整数。`);
  }
  return value;
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
