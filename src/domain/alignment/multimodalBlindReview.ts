import { sha256Hex } from "../shared/sha256";

export const MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA =
  "alignment-multimodal-blind-review-pack-v1";
export const ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA =
  "alignment-blind-review-pack-v2";
export const MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA =
  "alignment-multimodal-blind-review-vote-v1";
export const MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION =
  "local-sensitive-blind-multimodal-review-only";
export const MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION =
  "local-blind-review-vote-only";
export const MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS = 1_000;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DECISIONS = new Set<MultimodalBlindReviewDecision>([
  "unreviewed",
  "matched",
  "no-match",
  "unsure"
]);
const PRECISIONS = new Set<MultimodalBlindReviewPrecision>([
  "rough",
  "playbackChecked",
  "frameAccurate"
]);

export type MultimodalBlindReviewDecision =
  | "unreviewed"
  | "matched"
  | "no-match"
  | "unsure";

export type MultimodalBlindReviewPrecision =
  | "rough"
  | "playbackChecked"
  | "frameAccurate";

export interface MultimodalBlindReviewMedia {
  path: string;
  contentDigest: string;
  durationMs: number;
  videoStreamIndex: number;
}

export interface MultimodalBlindReviewCandidateSlot {
  slotId: string;
  timestampMs: number;
}

export interface MultimodalBlindReviewTask {
  taskId: string;
  queryKey: string;
  sourceTimestampMs: number;
  sourcePreviewStartMs: number;
  sourcePreviewEndMs: number;
  targetReviewStartMs: number;
  targetReviewEndMs: number;
  candidateSlots: MultimodalBlindReviewCandidateSlot[];
}

interface MultimodalBlindReviewPackBase {
  mediaFamilyId: string;
  source: MultimodalBlindReviewMedia;
  target: MultimodalBlindReviewMedia;
  tasks: MultimodalBlindReviewTask[];
  containsMediaPaths: true;
  predictionsBlinded: true;
  permission: typeof MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION;
  releaseEligible: false;
  packId: string;
}

export interface MultimodalFrozenBlindReviewPack extends MultimodalBlindReviewPackBase {
  schemaVersion: typeof MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA;
  inputs: {
    consensusResultId: string;
    visualResultId: string;
    publicPlanId: string;
  };
}

export interface RealAlignmentBlindReviewPack extends MultimodalBlindReviewPackBase {
  schemaVersion: typeof ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA;
  provenance: {
    kind: "realAlignmentRun";
    runIdDigest: string;
    manifestPayloadDigest: string;
    manifestCanonicalPayloadDigest: string;
    selectorVersion: "alignment-sensitive-review-selector-v1";
    selectorReceiptId: string;
    pairOrdinal: number;
    familyAuthority: "user-declared-label";
  };
}

export type MultimodalBlindReviewPack =
  | MultimodalFrozenBlindReviewPack
  | RealAlignmentBlindReviewPack;

export interface MultimodalBlindReviewAnswer {
  taskId: string;
  decision: MultimodalBlindReviewDecision;
  targetTimestampMs: number | null;
  boundaryToleranceMs: number | null;
  precision: MultimodalBlindReviewPrecision | null;
}

export interface MultimodalBlindReviewVote extends MultimodalBlindReviewAnswer {
  queryKey: string;
}

export interface MultimodalBlindReviewVoteSet {
  schemaVersion: typeof MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA;
  packId: string;
  reviewerIdDigest: string;
  votes: MultimodalBlindReviewVote[];
  permission: typeof MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION;
  releaseEligible: false;
  voteSetId: string;
}

export function parseMultimodalBlindReviewPackJson(json: string): MultimodalBlindReviewPack {
  return parseMultimodalBlindReviewPack(JSON.parse(json) as unknown);
}

export function parseMultimodalBlindReviewPack(value: unknown): MultimodalBlindReviewPack {
  const record = requireRecord(value, "盲复核任务包");
  const isV1 = record.schemaVersion === MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA;
  const isV2 = record.schemaVersion === ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA;
  if (!isV1 && !isV2) throw new Error("盲复核任务包版本无效。");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "mediaFamilyId",
      isV1 ? "inputs" : "provenance",
      "source",
      "target",
      "tasks",
      "containsMediaPaths",
      "predictionsBlinded",
      "permission",
      "releaseEligible",
      "packId"
    ],
    "盲复核任务包"
  );
  const body = withoutKey(record, "packId");
  const packId = requireSha256(record.packId, "任务包 ID");
  if (packId !== sha256Json(body)) {
    throw new Error("盲复核任务包身份不一致，文件可能被修改或损坏。");
  }
  if (
    record.containsMediaPaths !== true ||
    record.predictionsBlinded !== true ||
    record.permission !== MULTIMODAL_BLIND_REVIEW_PACK_PERMISSION ||
    record.releaseEligible !== false
  ) {
    throw new Error("盲复核任务包权限或版本无效。");
  }
  const inputs = isV1 ? parseFrozenInputs(record.inputs) : null;
  const provenance = isV2 ? parseRealAlignmentProvenance(record.provenance) : null;
  const source = parseMedia(record.source, "参考 A");
  const target = parseMedia(record.target, "原片 B");
  const tasksValue = record.tasks;
  if (!Array.isArray(tasksValue) || tasksValue.length === 0) {
    throw new Error("盲复核任务包没有任务。");
  }
  const taskIds = new Set<string>();
  const queryKeys: string[] = [];
  const tasks = tasksValue.map((taskValue, index) => {
    const task = requireRecord(taskValue, `第 ${index + 1} 个盲复核任务`);
    requireExactKeys(task, [
      "taskId",
      "queryKey",
      "sourceTimestampMs",
      "sourcePreviewStartMs",
      "sourcePreviewEndMs",
      "targetReviewStartMs",
      "targetReviewEndMs",
      "candidateSlots"
    ], `第 ${index + 1} 个盲复核任务`);
    const taskId = requireSha256(task.taskId, "任务 ID");
    if (taskId !== sha256Json(withoutKey(task, "taskId")) || taskIds.has(taskId)) {
      throw new Error("盲复核任务身份不一致或重复。");
    }
    taskIds.add(taskId);
    const queryKey = requireSha256(task.queryKey, "查询 ID");
    queryKeys.push(queryKey);
    const sourceTimestampMs = requireNonnegativeInteger(task.sourceTimestampMs, "参考定位");
    const sourcePreviewStartMs = requireNonnegativeInteger(task.sourcePreviewStartMs, "参考预览开始");
    const sourcePreviewEndMs = requireNonnegativeInteger(task.sourcePreviewEndMs, "参考预览结束");
    const targetReviewStartMs = requireNonnegativeInteger(task.targetReviewStartMs, "原片复核开始");
    const targetReviewEndMs = requireNonnegativeInteger(task.targetReviewEndMs, "原片复核结束");
    if (
      sourcePreviewStartMs > sourceTimestampMs ||
      sourceTimestampMs > sourcePreviewEndMs ||
      sourcePreviewEndMs > source.durationMs ||
      targetReviewStartMs >= targetReviewEndMs ||
      targetReviewEndMs > target.durationMs
    ) {
      throw new Error("盲复核任务的播放范围无效。");
    }
    if (!Array.isArray(task.candidateSlots) || task.candidateSlots.length < 1 || task.candidateSlots.length > 4) {
      throw new Error("盲复核候选必须为 1 至 4 个。");
    }
    const timestamps = new Set<number>();
    const candidateSlots = task.candidateSlots.map((slotValue, slotIndex) => {
      const slot = requireRecord(slotValue, "盲复核候选");
      requireExactKeys(slot, ["slotId", "timestampMs"], "盲复核候选");
      const slotId = String.fromCharCode("A".charCodeAt(0) + slotIndex);
      const timestampMs = requireNonnegativeInteger(slot.timestampMs, "候选位置");
      if (
        slot.slotId !== slotId ||
        timestamps.has(timestampMs) ||
        timestampMs < targetReviewStartMs ||
        timestampMs > targetReviewEndMs
      ) {
        throw new Error("盲复核候选顺序、位置或唯一性无效。");
      }
      timestamps.add(timestampMs);
      return { slotId, timestampMs };
    });
    return {
      taskId,
      queryKey,
      sourceTimestampMs,
      sourcePreviewStartMs,
      sourcePreviewEndMs,
      targetReviewStartMs,
      targetReviewEndMs,
      candidateSlots
    };
  });
  if (
    queryKeys.some((query, index) => query !== [...queryKeys].sort()[index]) ||
    new Set(queryKeys).size !== queryKeys.length
  ) {
    throw new Error("盲复核查询必须按身份稳定排序且不能重复。");
  }
  const common = {
    mediaFamilyId: requireSha256(record.mediaFamilyId, "媒体家族 ID"),
    source,
    target,
    tasks,
    containsMediaPaths: true as const,
    predictionsBlinded: true as const,
    permission: "local-sensitive-blind-multimodal-review-only" as const,
    releaseEligible: false as const,
    packId
  };
  return isV1
    ? {
        ...common,
        schemaVersion: MULTIMODAL_BLIND_REVIEW_PACK_SCHEMA,
        inputs: inputs!
      }
    : {
        ...common,
        schemaVersion: ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA,
        provenance: provenance!
      };
}

function parseFrozenInputs(value: unknown): MultimodalFrozenBlindReviewPack["inputs"] {
  const inputs = requireRecord(value, "盲复核输入身份");
  requireExactKeys(
    inputs,
    ["consensusResultId", "visualResultId", "publicPlanId"],
    "盲复核输入身份"
  );
  return {
    consensusResultId: requireSha256(inputs.consensusResultId, "共识结果 ID"),
    visualResultId: requireSha256(inputs.visualResultId, "视觉结果 ID"),
    publicPlanId: requireSha256(inputs.publicPlanId, "公开计划 ID")
  };
}

function parseRealAlignmentProvenance(
  value: unknown
): RealAlignmentBlindReviewPack["provenance"] {
  const provenance = requireRecord(value, "真实运行复核来源");
  requireExactKeys(
    provenance,
    [
      "kind",
      "runIdDigest",
      "manifestPayloadDigest",
      "manifestCanonicalPayloadDigest",
      "selectorVersion",
      "selectorReceiptId",
      "pairOrdinal",
      "familyAuthority"
    ],
    "真实运行复核来源"
  );
  if (
    provenance.kind !== "realAlignmentRun" ||
    provenance.selectorVersion !== "alignment-sensitive-review-selector-v1" ||
    provenance.familyAuthority !== "user-declared-label"
  ) {
    throw new Error("真实运行复核来源权限或版本无效。");
  }
  const pairOrdinal = requireNonnegativeInteger(provenance.pairOrdinal, "关系序号");
  if (pairOrdinal < 1) throw new Error("真实运行复核关系序号无效。");
  return {
    kind: "realAlignmentRun",
    runIdDigest: requireSha256(provenance.runIdDigest, "运行摘要"),
    manifestPayloadDigest: requireSha256(provenance.manifestPayloadDigest, "运行信封摘要"),
    manifestCanonicalPayloadDigest: requireSha256(
      provenance.manifestCanonicalPayloadDigest,
      "运行完整内容摘要"
    ),
    selectorVersion: "alignment-sensitive-review-selector-v1",
    selectorReceiptId: requireSha256(provenance.selectorReceiptId, "选窗收据"),
    pairOrdinal,
    familyAuthority: "user-declared-label"
  };
}

export function createUnreviewedBlindAnswer(taskId: string): MultimodalBlindReviewAnswer {
  return {
    taskId,
    decision: "unreviewed",
    targetTimestampMs: null,
    boundaryToleranceMs: null,
    precision: null
  };
}

export function normalizeMultimodalBlindReviewAnswer(
  answer: MultimodalBlindReviewAnswer,
  task: MultimodalBlindReviewTask
): MultimodalBlindReviewAnswer {
  if (answer.taskId !== task.taskId || !DECISIONS.has(answer.decision)) {
    throw new Error("盲复核答案没有绑定当前任务。");
  }
  if (answer.decision === "unreviewed") {
    if (
      answer.targetTimestampMs !== null ||
      answer.boundaryToleranceMs !== null ||
      answer.precision !== null
    ) {
      throw new Error("暂不处理的任务不能包含判断结果。");
    }
    return { ...answer };
  }
  if (answer.precision === null || !PRECISIONS.has(answer.precision)) {
    throw new Error("已复核任务必须说明核对精度。");
  }
  if (answer.decision !== "matched") {
    if (answer.targetTimestampMs !== null || answer.boundaryToleranceMs !== null) {
      throw new Error("没有对应画面或仍不确定时不能填写原片位置。");
    }
    return { ...answer };
  }
  const targetTimestampMs = requireNonnegativeInteger(answer.targetTimestampMs, "原片对应位置");
  const boundaryToleranceMs = requireNonnegativeInteger(answer.boundaryToleranceMs, "边界容差");
  if (targetTimestampMs < task.targetReviewStartMs || targetTimestampMs > task.targetReviewEndMs) {
    throw new Error("原片对应位置超出盲复核窗口。");
  }
  if (
    answer.precision === "frameAccurate" &&
    boundaryToleranceMs > MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS
  ) {
    throw new Error("逐帧定位的容差不能超过 1 秒。");
  }
  return { ...answer, targetTimestampMs, boundaryToleranceMs };
}

export function buildMultimodalBlindReviewVoteSet(
  packValue: MultimodalBlindReviewPack,
  reviewerId: string,
  answers: MultimodalBlindReviewAnswer[]
): MultimodalBlindReviewVoteSet {
  const pack = parseMultimodalBlindReviewPack(packValue);
  const answerByTask = new Map<string, MultimodalBlindReviewAnswer>();
  for (const answer of answers) {
    if (answerByTask.has(answer.taskId) || !pack.tasks.some((task) => task.taskId === answer.taskId)) {
      throw new Error("盲复核答案包含未知或重复任务。");
    }
    answerByTask.set(answer.taskId, answer);
  }
  const votes = pack.tasks.map((task) => {
    const answer = normalizeMultimodalBlindReviewAnswer(
      answerByTask.get(task.taskId) ?? createUnreviewedBlindAnswer(task.taskId),
      task
    );
    return { ...answer, queryKey: task.queryKey };
  });
  const body = {
    schemaVersion: MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA as typeof MULTIMODAL_BLIND_REVIEW_VOTE_SCHEMA,
    packId: pack.packId,
    reviewerIdDigest: createMultimodalBlindReviewerDigest(reviewerId),
    votes,
    permission: MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION as typeof MULTIMODAL_BLIND_REVIEW_VOTE_PERMISSION,
    releaseEligible: false as const
  };
  return { ...body, voteSetId: sha256Json(body) };
}

export function createMultimodalBlindReviewerDigest(reviewerId: string): string {
  const normalized = reviewerId.trim();
  if (normalized.length < 3 || normalized.length > 80) {
    throw new Error("复核者代号需要 3 至 80 个字符。");
  }
  return `sha256:${sha256Hex(`danmaku-studio/multimodal-blind-reviewer/v1\n${normalized}`)}`;
}

export function serializeMultimodalBlindReviewVoteSet(
  voteSet: MultimodalBlindReviewVoteSet
): string {
  return `${JSON.stringify(voteSet, null, 2)}\n`;
}

export function sha256Json(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function parseMedia(value: unknown, label: string): MultimodalBlindReviewMedia {
  const record = requireRecord(value, `${label}媒体`);
  requireExactKeys(record, ["path", "contentDigest", "durationMs", "videoStreamIndex"], `${label}媒体`);
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${label}媒体路径无效。`);
  }
  return {
    path: record.path,
    contentDigest: requireSha256(record.contentDigest, `${label}媒体摘要`),
    durationMs: requireNonnegativeInteger(record.durationMs, `${label}时长`),
    videoStreamIndex: requireNonnegativeInteger(record.videoStreamIndex, `${label}视频流`)
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error("盲复核合同只能包含有限整数。");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("盲复核合同包含不支持的值。");
}

function withoutKey(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
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
    throw new Error(`${label}必须是小写 SHA-256。`);
  }
  return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负整数毫秒。`);
  }
  return value;
}
