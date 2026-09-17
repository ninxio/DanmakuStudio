import type { SpectralBackendPreference } from "./spectralBackendPreference";
import { sha256Hex } from "../shared/sha256";

export const ALIGNMENT_EXPERIMENT_QUEUE_SCHEMA_VERSION = 1 as const;
export const ALIGNMENT_EXPERIMENT_PAIR_RECEIPT_SCHEMA_VERSION = 1 as const;
export const MAX_ALIGNMENT_EXPERIMENT_PAIRS = 256;
const MAX_RECEIPTS_PER_PAIR = 16;
const QUEUE_DIGEST_DOMAIN = "danmaku-studio/alignment-experiment-queue-config/v1";
const RECEIPT_DIGEST_DOMAIN = "danmaku-studio/alignment-experiment-pair-receipt/v1";

export type AlignmentExperimentQueueState =
  | "ready"
  | "running"
  | "interrupted"
  | "completed"
  | "completedWithIssues";

export type AlignmentExperimentPairState =
  | "pending"
  | "running"
  | "confirmable"
  | "reviewCandidate"
  | "notFound"
  | "failed"
  | "cancelled";

export type AlignmentExperimentPairOutcome = Exclude<
  AlignmentExperimentPairState,
  "pending" | "running"
>;

export interface AlignmentExperimentPairPlan {
  sourceMediaId: string;
  targetMediaId: string;
}

export interface AlignmentExperimentVersionReuseGroup {
  groupId: string;
  side: "source" | "target";
  mediaIds: string[];
}

export interface AlignmentExperimentQueueConfig {
  sourceMediaIds: string[];
  targetMediaIds: string[];
  pairs: AlignmentExperimentPairPlan[];
  versionReuseGroups: AlignmentExperimentVersionReuseGroup[];
  audioStreamSelections: Record<string, number | null>;
  spectralBackend: SpectralBackendPreference;
  windowMs: number;
  minGapMs: number;
  matchThreshold: number;
  enableVisualEvidence: boolean;
}

export interface AlignmentExperimentPairReceiptCore {
  jobId: string;
  pairIndex: number;
  outcome: AlignmentExperimentPairOutcome;
  message: string;
  completedAtMs: number;
  executionIdentityDigest: `sha256:${string}` | null;
  fineFrontierReceiptDigest: `sha256:${string}` | null;
  fineExecutionEvidenceDigest: `sha256:${string}` | null;
  proposalTimeMapDigest: `sha256:${string}` | null;
}

export interface AlignmentExperimentPairReceipt extends AlignmentExperimentPairReceiptCore {
  schemaVersion: typeof ALIGNMENT_EXPERIMENT_PAIR_RECEIPT_SCHEMA_VERSION;
  receiptDigest: `sha256:${string}`;
}

export interface AlignmentExperimentQueuePair extends AlignmentExperimentPairPlan {
  pairId: string;
  state: AlignmentExperimentPairState;
  attemptCount: number;
  interruptionCount: number;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  receipts: AlignmentExperimentPairReceipt[];
}

export interface AlignmentExperimentQueue {
  schemaVersion: typeof ALIGNMENT_EXPERIMENT_QUEUE_SCHEMA_VERSION;
  queueId: string;
  projectId: string;
  state: AlignmentExperimentQueueState;
  config: AlignmentExperimentQueueConfig;
  configDigest: `sha256:${string}`;
  activeJobId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastError: string | null;
  pairs: AlignmentExperimentQueuePair[];
}

export interface CreateAlignmentExperimentQueueInput {
  queueId: string;
  projectId: string;
  config: AlignmentExperimentQueueConfig;
  nowMs: number;
}

export interface FinishAlignmentExperimentPairInput extends AlignmentExperimentPairReceiptCore {
  sourceMediaId: string;
  targetMediaId: string;
}

export function createAlignmentExperimentQueue(
  input: CreateAlignmentExperimentQueueInput
): AlignmentExperimentQueue {
  const queueId = requireIdentifier(input.queueId, "实验队列 ID");
  const projectId = requireIdentifier(input.projectId, "项目 ID");
  const nowMs = requireTimestamp(input.nowMs, "实验队列创建时间");
  const config = normalizeConfig(input.config);
  return {
    schemaVersion: ALIGNMENT_EXPERIMENT_QUEUE_SCHEMA_VERSION,
    queueId,
    projectId,
    state: "ready",
    config,
    configDigest: createAlignmentExperimentQueueConfigDigest(config),
    activeJobId: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lastError: null,
    pairs: config.pairs.map((pair) => ({
      ...pair,
      pairId: createAlignmentExperimentPairId(pair),
      state: "pending",
      attemptCount: 0,
      interruptionCount: 0,
      lastStartedAtMs: null,
      lastFinishedAtMs: null,
      receipts: []
    }))
  };
}

export function createAlignmentExperimentQueueConfigDigest(
  config: AlignmentExperimentQueueConfig
): `sha256:${string}` {
  return digest(QUEUE_DIGEST_DOMAIN, normalizeConfig(config));
}

export function createAlignmentExperimentPairId(pair: AlignmentExperimentPairPlan): string {
  const sourceMediaId = requireIdentifier(pair.sourceMediaId, "参考媒体 ID");
  const targetMediaId = requireIdentifier(pair.targetMediaId, "原片媒体 ID");
  return `pair-${sha256Hex(`${sourceMediaId}\u0000${targetMediaId}`).slice(0, 32)}`;
}

export function beginAlignmentExperimentAttempt(
  queue: AlignmentExperimentQueue,
  input: { jobId: string; pairs: AlignmentExperimentPairPlan[]; nowMs: number }
): AlignmentExperimentQueue {
  const checked = parseAlignmentExperimentQueue(queue);
  const jobId = requireIdentifier(input.jobId, "原生任务 ID");
  const nowMs = requireTimestamp(input.nowMs, "尝试开始时间");
  const selected = new Set(input.pairs.map(createAlignmentExperimentPairId));
  if (selected.size === 0) throw new Error("实验队列至少需要开始一个 case。");
  let changed = 0;
  const pairs = checked.pairs.map((pair) => {
    if (!selected.has(pair.pairId)) return pair;
    if (pair.state === "running") throw new Error(`case ${pair.pairId} 已在运行。`);
    changed += 1;
    return {
      ...pair,
      state: "running" as const,
      attemptCount: pair.attemptCount + 1,
      lastStartedAtMs: nowMs
    };
  });
  if (changed !== selected.size) throw new Error("实验队列尝试引用了不存在的 case。");
  return {
    ...checked,
    state: "running",
    activeJobId: jobId,
    updatedAtMs: nowMs,
    lastError: null,
    pairs
  };
}

export function finishAlignmentExperimentAttempt(
  queue: AlignmentExperimentQueue,
  input: {
    jobId: string;
    results: FinishAlignmentExperimentPairInput[];
    nowMs: number;
    error?: string | null;
  }
): AlignmentExperimentQueue {
  const checked = parseAlignmentExperimentQueue(queue);
  const jobId = requireIdentifier(input.jobId, "原生任务 ID");
  const nowMs = requireTimestamp(input.nowMs, "尝试完成时间");
  if (checked.activeJobId !== jobId) throw new Error("实验队列回执不属于当前原生任务。");
  const results = new Map<string, AlignmentExperimentPairReceipt>();
  for (const result of input.results) {
    if (result.jobId !== jobId) throw new Error("case 回执的原生任务 ID 不一致。");
    const pairId = createAlignmentExperimentPairId(result);
    if (results.has(pairId)) throw new Error(`实验队列包含重复 case 回执：${pairId}`);
    results.set(pairId, createAlignmentExperimentPairReceipt(result));
  }
  const pairs = checked.pairs.map((pair) => {
    if (pair.state !== "running") return pair;
    const receipt = results.get(pair.pairId);
    if (!receipt) throw new Error(`运行中的 case 缺少终态回执：${pair.pairId}`);
    return {
      ...pair,
      state: receipt.outcome,
      lastFinishedAtMs: receipt.completedAtMs,
      receipts: appendReceipt(pair.receipts, receipt)
    };
  });
  if (results.size !== checked.pairs.filter((pair) => pair.state === "running").length) {
    throw new Error("终态回执包含未运行的 case。");
  }
  return finalizeQueue({
    ...checked,
    activeJobId: null,
    updatedAtMs: nowMs,
    lastError: normalizeOptionalMessage(input.error ?? null),
    pairs
  });
}

export function interruptAlignmentExperimentQueue(
  queue: AlignmentExperimentQueue,
  reason: string,
  nowMs: number
): AlignmentExperimentQueue {
  const checked = parseAlignmentExperimentQueue(queue);
  const updatedAtMs = requireTimestamp(nowMs, "中断时间");
  return {
    ...checked,
    state: "interrupted",
    activeJobId: null,
    updatedAtMs,
    lastError: normalizeMessage(reason, "实验队列中断原因"),
    pairs: checked.pairs.map((pair) =>
      pair.state === "running"
        ? {
            ...pair,
            state: "pending",
            interruptionCount: pair.interruptionCount + 1
          }
        : pair
    )
  };
}

export function recoverAlignmentExperimentQueue(
  queue: AlignmentExperimentQueue,
  nowMs: number
): AlignmentExperimentQueue {
  const checked = parseAlignmentExperimentQueue(queue);
  if (checked.state !== "running" && !checked.pairs.some((pair) => pair.state === "running")) {
    return checked;
  }
  return interruptAlignmentExperimentQueue(
    checked,
    "应用在原生任务进入终态前关闭；该 case 已回到待重试，不能视为完成。",
    nowMs
  );
}

export function retryAlignmentExperimentPairs(
  queue: AlignmentExperimentQueue,
  pairIds: readonly string[],
  nowMs: number
): AlignmentExperimentQueue {
  const checked = parseAlignmentExperimentQueue(queue);
  const selected = new Set(pairIds);
  if (selected.size === 0) return checked;
  let changed = 0;
  const pairs = checked.pairs.map((pair) => {
    if (!selected.has(pair.pairId)) return pair;
    if (pair.state === "running") throw new Error("运行中的 case 不能重置为待重试。");
    changed += 1;
    return { ...pair, state: "pending" as const };
  });
  if (changed !== selected.size) throw new Error("待重试列表引用了不存在的 case。");
  return {
    ...checked,
    state: "ready",
    activeJobId: null,
    updatedAtMs: requireTimestamp(nowMs, "重试时间"),
    lastError: null,
    pairs
  };
}

export function createAlignmentExperimentPairReceipt(
  core: AlignmentExperimentPairReceiptCore
): AlignmentExperimentPairReceipt {
  const normalized = normalizeReceiptCore(core);
  return {
    schemaVersion: ALIGNMENT_EXPERIMENT_PAIR_RECEIPT_SCHEMA_VERSION,
    ...normalized,
    receiptDigest: digest(RECEIPT_DIGEST_DOMAIN, normalized)
  };
}

export function serializeAlignmentExperimentQueue(queue: AlignmentExperimentQueue): string {
  return `${canonicalJson(parseAlignmentExperimentQueue(queue))}\n`;
}

export function parseAlignmentExperimentQueueJson(json: string): AlignmentExperimentQueue {
  if (new TextEncoder().encode(json).byteLength > 4 * 1024 * 1024) {
    throw new Error("实验队列文件超过 4 MiB 安全上限。");
  }
  return parseAlignmentExperimentQueue(JSON.parse(json));
}

export function parseAlignmentExperimentQueue(value: unknown): AlignmentExperimentQueue {
  const record = requireRecord(value, "实验队列");
  requireExactKeys(record, [
    "schemaVersion",
    "queueId",
    "projectId",
    "state",
    "config",
    "configDigest",
    "activeJobId",
    "createdAtMs",
    "updatedAtMs",
    "lastError",
    "pairs"
  ], "实验队列");
  if (record.schemaVersion !== ALIGNMENT_EXPERIMENT_QUEUE_SCHEMA_VERSION) {
    throw new Error("实验队列 schemaVersion 不受支持。");
  }
  const config = normalizeConfig(record.config as AlignmentExperimentQueueConfig);
  const configDigest = requireDigest(record.configDigest, "实验队列 configDigest");
  if (configDigest !== createAlignmentExperimentQueueConfigDigest(config)) {
    throw new Error("实验队列配置摘要不匹配。");
  }
  const state = requireQueueState(record.state);
  const pairsRaw = requireArray(record.pairs, "实验队列 cases");
  if (pairsRaw.length !== config.pairs.length) throw new Error("实验队列 case 数量与配置不一致。");
  const pairs = pairsRaw.map(parseQueuePair);
  const expectedPairIds = config.pairs.map(createAlignmentExperimentPairId);
  if (pairs.some((pair, index) => pair.pairId !== expectedPairIds[index])) {
    throw new Error("实验队列 case 顺序或身份与配置不一致。");
  }
  const activeJobId = record.activeJobId === null ? null : requireIdentifier(record.activeJobId, "activeJobId");
  if ((state === "running") !== Boolean(activeJobId)) {
    throw new Error("实验队列运行状态与 activeJobId 不一致。");
  }
  if (state === "running" && !pairs.some((pair) => pair.state === "running")) {
    throw new Error("运行中的实验队列没有运行中的 case。");
  }
  return {
    schemaVersion: ALIGNMENT_EXPERIMENT_QUEUE_SCHEMA_VERSION,
    queueId: requireIdentifier(record.queueId, "实验队列 ID"),
    projectId: requireIdentifier(record.projectId, "项目 ID"),
    state,
    config,
    configDigest,
    activeJobId,
    createdAtMs: requireTimestamp(record.createdAtMs, "实验队列创建时间"),
    updatedAtMs: requireTimestamp(record.updatedAtMs, "实验队列更新时间"),
    lastError: record.lastError === null ? null : normalizeMessage(record.lastError, "实验队列错误"),
    pairs
  };
}

function normalizeConfig(value: AlignmentExperimentQueueConfig): AlignmentExperimentQueueConfig {
  const record = requireRecord(value, "实验队列配置");
  requireExactKeys(record, [
    "sourceMediaIds",
    "targetMediaIds",
    "pairs",
    "versionReuseGroups",
    "audioStreamSelections",
    "spectralBackend",
    "windowMs",
    "minGapMs",
    "matchThreshold",
    "enableVisualEvidence"
  ], "实验队列配置");
  const sourceMediaIds = normalizeIdentifierArray(record.sourceMediaIds, "参考媒体 IDs");
  const targetMediaIds = normalizeIdentifierArray(record.targetMediaIds, "原片媒体 IDs");
  if (sourceMediaIds.length === 0 || targetMediaIds.length === 0) {
    throw new Error("实验队列的两侧媒体都不能为空。");
  }
  const sourceSet = new Set(sourceMediaIds);
  const targetSet = new Set(targetMediaIds);
  if (sourceMediaIds.some((id) => targetSet.has(id))) throw new Error("媒体 ID 不能同时位于队列两侧。");
  const pairValues = requireArray(record.pairs, "实验队列 pairs");
  if (pairValues.length === 0 || pairValues.length > MAX_ALIGNMENT_EXPERIMENT_PAIRS) throw new Error(`实验队列必须包含 1–${MAX_ALIGNMENT_EXPERIMENT_PAIRS} 个 pair。`);
  const pairKeys = new Set<string>();
  const pairs = pairValues.map((value, index) => {
    const pair = requireRecord(value, `pair ${index + 1}`);
    requireExactKeys(pair, ["sourceMediaId", "targetMediaId"], `pair ${index + 1}`);
    const normalized = {
      sourceMediaId: requireIdentifier(pair.sourceMediaId, "参考媒体 ID"),
      targetMediaId: requireIdentifier(pair.targetMediaId, "原片媒体 ID")
    };
    if (!sourceSet.has(normalized.sourceMediaId) || !targetSet.has(normalized.targetMediaId)) {
      throw new Error(`pair ${index + 1} 引用了队列 inventory 之外的媒体。`);
    }
    const key = createAlignmentExperimentPairId(normalized);
    if (pairKeys.has(key)) throw new Error("实验队列不能包含重复 pair。");
    pairKeys.add(key);
    return normalized;
  });
  const streamRecord = requireRecord(record.audioStreamSelections, "音轨选择");
  const inventory = new Set([...sourceMediaIds, ...targetMediaIds]);
  const audioStreamSelections: Record<string, number | null> = {};
  for (const key of Object.keys(streamRecord).sort()) {
    if (!inventory.has(key)) throw new Error("音轨选择引用了 inventory 之外的媒体。");
    const streamIndex = streamRecord[key];
    if (streamIndex !== null && (!Number.isSafeInteger(streamIndex) || Number(streamIndex) < 0)) {
      throw new Error("音轨索引必须是非负安全整数或 null。");
    }
    audioStreamSelections[key] = streamIndex === null ? null : Number(streamIndex);
  }
  return {
    sourceMediaIds,
    targetMediaIds,
    pairs,
    versionReuseGroups: normalizeVersionGroups(record.versionReuseGroups, sourceSet, targetSet),
    audioStreamSelections,
    spectralBackend: requireSpectralBackend(record.spectralBackend),
    windowMs: requirePositiveInteger(record.windowMs, "windowMs"),
    minGapMs: requireNonNegativeInteger(record.minGapMs, "minGapMs"),
    matchThreshold: requirePositiveNumber(record.matchThreshold, "matchThreshold"),
    enableVisualEvidence: requireBoolean(record.enableVisualEvidence, "enableVisualEvidence")
  };
}

function normalizeVersionGroups(
  value: unknown,
  sourceSet: ReadonlySet<string>,
  targetSet: ReadonlySet<string>
): AlignmentExperimentVersionReuseGroup[] {
  const groups = requireArray(value, "多版本组");
  const ids = new Set<string>();
  const memberships = new Set<string>();
  return groups.map((value, index) => {
    const record = requireRecord(value, `多版本组 ${index + 1}`);
    requireExactKeys(record, ["groupId", "side", "mediaIds"], `多版本组 ${index + 1}`);
    const groupId = requireIdentifier(record.groupId, "多版本组 ID");
    if (ids.has(groupId)) throw new Error("多版本组 ID 不能重复。");
    ids.add(groupId);
    const side = record.side === "source" || record.side === "target" ? record.side : null;
    if (!side) throw new Error("多版本组 side 无效。");
    const mediaIds = normalizeIdentifierArray(record.mediaIds, "多版本组媒体");
    if (mediaIds.length < 2) throw new Error("多版本组至少需要两个媒体。");
    const allowed = side === "source" ? sourceSet : targetSet;
    for (const mediaId of mediaIds) {
      if (!allowed.has(mediaId)) throw new Error("多版本组引用了错误侧媒体。");
      const membership = `${side}\u0000${mediaId}`;
      if (memberships.has(membership)) throw new Error("媒体不能属于同侧多个多版本组。");
      memberships.add(membership);
    }
    return { groupId, side, mediaIds };
  });
}

function parseQueuePair(value: unknown, index: number): AlignmentExperimentQueuePair {
  const record = requireRecord(value, `实验 case ${index + 1}`);
  requireExactKeys(record, [
    "sourceMediaId",
    "targetMediaId",
    "pairId",
    "state",
    "attemptCount",
    "interruptionCount",
    "lastStartedAtMs",
    "lastFinishedAtMs",
    "receipts"
  ], `实验 case ${index + 1}`);
  const sourceMediaId = requireIdentifier(record.sourceMediaId, "参考媒体 ID");
  const targetMediaId = requireIdentifier(record.targetMediaId, "原片媒体 ID");
  const pairId = requireIdentifier(record.pairId, "case ID");
  if (pairId !== createAlignmentExperimentPairId({ sourceMediaId, targetMediaId })) {
    throw new Error("实验 case ID 与媒体组合不一致。");
  }
  const receipts = requireArray(record.receipts, "case 回执").map(parseReceipt);
  if (receipts.length > MAX_RECEIPTS_PER_PAIR) throw new Error("单个 case 的回执历史超过上限。");
  return {
    sourceMediaId,
    targetMediaId,
    pairId,
    state: requirePairState(record.state),
    attemptCount: requireNonNegativeInteger(record.attemptCount, "attemptCount"),
    interruptionCount: requireNonNegativeInteger(record.interruptionCount, "interruptionCount"),
    lastStartedAtMs: requireNullableTimestamp(record.lastStartedAtMs, "lastStartedAtMs"),
    lastFinishedAtMs: requireNullableTimestamp(record.lastFinishedAtMs, "lastFinishedAtMs"),
    receipts
  };
}

function parseReceipt(value: unknown): AlignmentExperimentPairReceipt {
  const record = requireRecord(value, "case 回执");
  requireExactKeys(record, [
    "schemaVersion",
    "jobId",
    "pairIndex",
    "outcome",
    "message",
    "completedAtMs",
    "executionIdentityDigest",
    "fineFrontierReceiptDigest",
    "fineExecutionEvidenceDigest",
    "proposalTimeMapDigest",
    "receiptDigest"
  ], "case 回执");
  if (record.schemaVersion !== ALIGNMENT_EXPERIMENT_PAIR_RECEIPT_SCHEMA_VERSION) {
    throw new Error("case 回执 schemaVersion 不受支持。");
  }
  const core = normalizeReceiptCore(record as unknown as AlignmentExperimentPairReceiptCore);
  const receiptDigest = requireDigest(record.receiptDigest, "case receiptDigest");
  if (receiptDigest !== digest(RECEIPT_DIGEST_DOMAIN, core)) throw new Error("case 回执摘要不匹配。");
  return { schemaVersion: ALIGNMENT_EXPERIMENT_PAIR_RECEIPT_SCHEMA_VERSION, ...core, receiptDigest };
}

function normalizeReceiptCore(core: AlignmentExperimentPairReceiptCore): AlignmentExperimentPairReceiptCore {
  const record = requireRecord(core, "case 回执核心");
  return {
    jobId: requireIdentifier(record.jobId, "回执 jobId"),
    pairIndex: requireNonNegativeInteger(record.pairIndex, "pairIndex"),
    outcome: requirePairOutcome(record.outcome),
    message: normalizeMessage(record.message, "case 回执消息"),
    completedAtMs: requireTimestamp(record.completedAtMs, "case 完成时间"),
    executionIdentityDigest: requireNullableDigest(record.executionIdentityDigest, "executionIdentityDigest"),
    fineFrontierReceiptDigest: requireNullableDigest(record.fineFrontierReceiptDigest, "fineFrontierReceiptDigest"),
    fineExecutionEvidenceDigest: requireNullableDigest(record.fineExecutionEvidenceDigest, "fineExecutionEvidenceDigest"),
    proposalTimeMapDigest: requireNullableDigest(record.proposalTimeMapDigest, "proposalTimeMapDigest")
  };
}

function appendReceipt(
  current: AlignmentExperimentPairReceipt[],
  receipt: AlignmentExperimentPairReceipt
): AlignmentExperimentPairReceipt[] {
  const duplicate = current.find((item) => item.jobId === receipt.jobId);
  if (duplicate) {
    if (duplicate.receiptDigest !== receipt.receiptDigest) throw new Error("同一 jobId 出现冲突 case 回执。");
    return current;
  }
  return [...current, receipt].slice(-MAX_RECEIPTS_PER_PAIR);
}

function finalizeQueue(queue: AlignmentExperimentQueue): AlignmentExperimentQueue {
  const hasOpen = queue.pairs.some((pair) => pair.state === "pending" || pair.state === "running");
  const hasIssues = queue.pairs.some((pair) => pair.state === "failed" || pair.state === "cancelled");
  return {
    ...queue,
    state: hasOpen ? "interrupted" : hasIssues ? "completedWithIssues" : "completed"
  };
}

function requireQueueState(value: unknown): AlignmentExperimentQueueState {
  if (value === "ready" || value === "running" || value === "interrupted" || value === "completed" || value === "completedWithIssues") return value;
  throw new Error("实验队列状态无效。");
}

function requirePairState(value: unknown): AlignmentExperimentPairState {
  if (value === "pending" || value === "running" || value === "confirmable" || value === "reviewCandidate" || value === "notFound" || value === "failed" || value === "cancelled") return value;
  throw new Error("实验 case 状态无效。");
}

function requirePairOutcome(value: unknown): AlignmentExperimentPairOutcome {
  const state = requirePairState(value);
  if (state === "pending" || state === "running") throw new Error("case 回执必须是终态。");
  return state;
}

function requireSpectralBackend(value: unknown): SpectralBackendPreference {
  if (value === "auto" || value === "cpu" || value === "cuda") return value;
  throw new Error("实验队列声谱后端无效。");
}

function normalizeIdentifierArray(value: unknown, label: string): string[] {
  const array = requireArray(value, label).map((item) => requireIdentifier(item, label));
  if (new Set(array).size !== array.length) throw new Error(`${label} 不能包含重复项。`);
  return array;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > 512 ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new Error(`${label} 必须是 1–512 UTF-8 bytes 的无控制字符文本。`);
  }
  return value.trim();
}

function normalizeMessage(value: unknown, label: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4096) {
    throw new Error(`${label} 必须是不超过 4096 UTF-8 bytes 的文本。`);
  }
  return value.trim();
}

function normalizeOptionalMessage(value: string | null): string | null {
  return value === null ? null : normalizeMessage(value, "实验队列错误");
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} 必须是非负整数毫秒。`);
  return Number(value);
}

function requireNullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : requireTimestamp(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} 必须是非负安全整数。`);
  return Number(value);
}

function requirePositiveInteger(value: unknown, label: string): number {
  const result = requireNonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} 必须大于 0。`);
  return result;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须是有限正数。`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值。`);
  return value;
}

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} 必须是 SHA-256 摘要。`);
  return value as `sha256:${string}`;
}

function requireNullableDigest(value: unknown, label: string): `sha256:${string}` | null {
  return value === null ? null : requireDigest(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  return value;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不完整或包含未知字段。`);
  }
}

function digest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数字。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON 不接受 undefined、函数或 symbol。");
}
