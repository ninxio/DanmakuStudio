import { invoke, isTauri } from "@tauri-apps/api/core";

export type MediaInventoryCachePolicy = "reuseFresh" | "refresh";
export type MediaInventoryJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";
export type MediaInventoryItemStatus = "queued" | "probing" | "ready" | "failed" | "cancelled";
export type MediaInventoryRecommendationState = "recommended" | "needsChoice" | "unavailable";
export type MediaInventoryProbeCompleteness = "complete" | "partial" | "fallbackRequired";
export type MediaInventoryCacheState = "fresh" | "stale" | "miss";
export type MediaInventoryRecommendationReasonCode =
  | "onlyNonSpecialTrack"
  | "preferredLanguage"
  | "originalDisposition"
  | "defaultDispositionHint"
  | "technicalTieBreak"
  | "commentaryDisposition"
  | "commentaryTitleHint"
  | "descriptionsDisposition"
  | "visualImpairedDisposition"
  | "hearingImpairedDisposition"
  | "auxiliaryDisposition"
  | "metadataIncomplete"
  | "equivalentCandidate"
  | "allTracksSpecialPurpose"
  | "noAudioTrack";
export type MediaInventoryItemErrorCode =
  | "invalidPath"
  | "fileNotFound"
  | "fileUnreadable"
  | "unsupportedSource"
  | "ffprobeUnavailable"
  | "probeTimeout"
  | "probeOutputLimit"
  | "probeFailed"
  | "invalidProbeOutput"
  | "metadataIncomplete"
  | "mediaChanged"
  | "processCleanupFault";
export type MediaInventoryTerminalErrorCode = "processCleanupFault" | "internalInvariant";
export type MediaInventoryCommandErrorCode =
  | "invalidRequest"
  | "inventoryBusy"
  | "jobNotFound"
  | "jobCapacityReached"
  | "processCleanupFault"
  | "internalInvariant";

export class MediaInventoryCommandError extends Error {
  readonly code: MediaInventoryCommandErrorCode;
  readonly retryable: boolean;

  constructor(message: string, code: MediaInventoryCommandErrorCode, retryable: boolean) {
    super(message);
    this.name = "MediaInventoryCommandError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isMediaInventoryCommandError(
  error: unknown
): error is MediaInventoryCommandError {
  return error instanceof MediaInventoryCommandError;
}

export interface MediaInventoryRequestItem {
  itemId: string;
  path: string;
}

export interface MediaInventoryRequest {
  schemaVersion: 1;
  items: MediaInventoryRequestItem[];
  ffprobePath?: string | null;
  ffmpegPath?: string | null;
  preferredLanguages?: string[];
  cachePolicy?: MediaInventoryCachePolicy;
}

export interface MediaInventoryJobCounts {
  total: number;
  queued: number;
  probing: number;
  ready: number;
  failed: number;
  cancelled: number;
}

export interface MediaInventoryAudioDispositions {
  default: boolean;
  original: boolean;
  dub: boolean;
  commentary: boolean;
  descriptions: boolean;
  visualImpaired: boolean;
  hearingImpaired: boolean;
  cleanEffects: boolean;
  karaoke: boolean;
}

export interface MediaInventoryAudioTrack {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  durationMs: number | null;
  dispositions: MediaInventoryAudioDispositions;
  recommendationRank: number;
  reasonCodes: MediaInventoryRecommendationReasonCode[];
}

export interface MediaInventoryRecommendation {
  state: MediaInventoryRecommendationState;
  streamIndex: number | null;
  reasonCodes: MediaInventoryRecommendationReasonCode[];
}

export interface MediaInventoryItemResult {
  inventoryRevision: string;
  durationMs: number | null;
  audioTracks: MediaInventoryAudioTrack[];
  recommendation: MediaInventoryRecommendation;
  probeCompleteness: MediaInventoryProbeCompleteness;
  cacheState: MediaInventoryCacheState;
}

export interface MediaInventoryItemError {
  code: MediaInventoryItemErrorCode;
  message: string;
}

export interface MediaInventoryTerminalError {
  code: MediaInventoryTerminalErrorCode;
  message: string;
}

export interface MediaInventoryItemSnapshot {
  ordinal: number;
  itemId: string;
  status: MediaInventoryItemStatus;
  result: MediaInventoryItemResult | null;
  error: MediaInventoryItemError | null;
}

export interface MediaInventoryJobSnapshot {
  schemaVersion: 1;
  jobId: string;
  status: MediaInventoryJobStatus;
  sequence: number;
  cancelRequested: boolean;
  counts: MediaInventoryJobCounts;
  items: MediaInventoryItemSnapshot[];
  terminalError: MediaInventoryTerminalError | null;
}

export type StartMediaInventoryInvoker = (request: MediaInventoryRequest) => Promise<unknown>;
export type MediaInventoryJobInvoker = (jobId: string) => Promise<unknown>;

const JOB_STATUSES = new Set<MediaInventoryJobStatus>([
  "queued",
  "running",
  "completed",
  "cancelled",
  "failed"
]);
const ITEM_STATUSES = new Set<MediaInventoryItemStatus>([
  "queued",
  "probing",
  "ready",
  "failed",
  "cancelled"
]);
const RECOMMENDATION_STATES = new Set<MediaInventoryRecommendationState>([
  "recommended",
  "needsChoice",
  "unavailable"
]);
const REASON_CODES = new Set<MediaInventoryRecommendationReasonCode>([
  "onlyNonSpecialTrack",
  "preferredLanguage",
  "originalDisposition",
  "defaultDispositionHint",
  "technicalTieBreak",
  "commentaryDisposition",
  "commentaryTitleHint",
  "descriptionsDisposition",
  "visualImpairedDisposition",
  "hearingImpairedDisposition",
  "auxiliaryDisposition",
  "metadataIncomplete",
  "equivalentCandidate",
  "allTracksSpecialPurpose",
  "noAudioTrack"
]);
const ITEM_ERROR_CODES = new Set<MediaInventoryItemErrorCode>([
  "invalidPath",
  "fileNotFound",
  "fileUnreadable",
  "unsupportedSource",
  "ffprobeUnavailable",
  "probeTimeout",
  "probeOutputLimit",
  "probeFailed",
  "invalidProbeOutput",
  "metadataIncomplete",
  "mediaChanged",
  "processCleanupFault"
]);
const TERMINAL_ERROR_CODES = new Set<MediaInventoryTerminalErrorCode>([
  "processCleanupFault",
  "internalInvariant"
]);
const COMMAND_ERROR_CODES = new Set<MediaInventoryCommandErrorCode>([
  "invalidRequest",
  "inventoryBusy",
  "jobNotFound",
  "jobCapacityReached",
  "processCleanupFault",
  "internalInvariant"
]);
const PROBE_COMPLETENESS = new Set<MediaInventoryProbeCompleteness>([
  "complete",
  "partial",
  "fallbackRequired"
]);
const CACHE_STATES = new Set<MediaInventoryCacheState>(["fresh", "stale", "miss"]);

export async function startTauriMediaInventoryJob(
  request: MediaInventoryRequest,
  invoker: StartMediaInventoryInvoker = defaultStartMediaInventoryInvoker
): Promise<MediaInventoryJobSnapshot> {
  assertDesktop(invoker === defaultStartMediaInventoryInvoker);
  const response = await invokeWithContext("媒体清单启动失败", () => invoker(request));
  return parseMediaInventoryJobSnapshot(response);
}

export async function getTauriMediaInventoryJob(
  jobId: string,
  invoker: MediaInventoryJobInvoker = defaultGetMediaInventoryInvoker
): Promise<MediaInventoryJobSnapshot> {
  assertDesktop(invoker === defaultGetMediaInventoryInvoker);
  const response = await invokeWithContext("媒体清单读取失败", () => invoker(jobId));
  return parseMediaInventoryJobSnapshot(response);
}

export async function cancelTauriMediaInventoryJob(
  jobId: string,
  invoker: MediaInventoryJobInvoker = defaultCancelMediaInventoryInvoker
): Promise<MediaInventoryJobSnapshot> {
  assertDesktop(invoker === defaultCancelMediaInventoryInvoker);
  const response = await invokeWithContext("媒体清单取消失败", () => invoker(jobId));
  return parseMediaInventoryJobSnapshot(response);
}

export function parseMediaInventoryJobSnapshot(value: unknown): MediaInventoryJobSnapshot {
  try {
    validateJobSnapshot(value);
    return value;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`媒体清单响应无效：${detail}`);
  }
}

function defaultStartMediaInventoryInvoker(request: MediaInventoryRequest): Promise<unknown> {
  return invoke("start_media_inventory_job", { request });
}

function defaultGetMediaInventoryInvoker(jobId: string): Promise<unknown> {
  return invoke("get_media_inventory_job", { jobId });
}

function defaultCancelMediaInventoryInvoker(jobId: string): Promise<unknown> {
  return invoke("cancel_media_inventory_job", { jobId });
}

function assertDesktop(usingDefaultInvoker: boolean): void {
  if (usingDefaultInvoker && !isTauri()) {
    throw new Error("媒体清单需要在 Tauri 桌面端运行。");
  }
}

async function invokeWithContext(label: string, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error: unknown) {
    const commandFailure = readStructuredCommandFailure(error);
    if (commandFailure) {
      throw new MediaInventoryCommandError(
        `${label}：${commandFailure.message}（${commandFailure.code}）`,
        commandFailure.code,
        commandFailure.retryable
      );
    }
    throw new Error(`${label}：${formatInventoryFailure(error)}`);
  }
}

function readStructuredCommandFailure(error: unknown): {
  code: MediaInventoryCommandErrorCode;
  message: string;
  retryable: boolean;
} | null {
  if (
    !isRecord(error) ||
    typeof error.code !== "string" ||
    !COMMAND_ERROR_CODES.has(error.code as MediaInventoryCommandErrorCode) ||
    !isNonEmptyString(error.message) ||
    typeof error.retryable !== "boolean"
  ) {
    return null;
  }
  return {
    code: error.code as MediaInventoryCommandErrorCode,
    message: error.message,
    retryable: error.retryable
  };
}

function formatInventoryFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    COMMAND_ERROR_CODES.has(error.code as MediaInventoryCommandErrorCode) &&
    isNonEmptyString(error.message)
  ) {
    return `${error.message}（${error.code}）`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? "未知错误";
  } catch {
    return "未知错误";
  }
}

function validateJobSnapshot(value: unknown): asserts value is MediaInventoryJobSnapshot {
  assertExactKeys(value, [
    "schemaVersion",
    "jobId",
    "status",
    "sequence",
    "cancelRequested",
    "counts",
    "items",
    "terminalError"
  ]);
  if (
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.jobId) ||
    !JOB_STATUSES.has(value.status as MediaInventoryJobStatus) ||
    !isNonNegativeSafeInteger(value.sequence) ||
    typeof value.cancelRequested !== "boolean" ||
    !Array.isArray(value.items)
  ) {
    throw new Error("job 根字段无效。");
  }
  const status = value.status as MediaInventoryJobStatus;
  validateCounts(value.counts, value.items);
  const itemIds = new Set<string>();
  value.items.forEach((item, ordinal) => {
    validateItem(item, ordinal);
    if (itemIds.has(item.itemId)) throw new Error("itemId 重复。");
    itemIds.add(item.itemId);
  });
  if (value.terminalError === null) {
    if (status === "failed") throw new Error("failed job 缺少 terminalError。");
  } else {
    validateTerminalError(value.terminalError);
    if (status !== "failed") throw new Error("非 failed job 不得带 terminalError。");
  }
  if (
    (status === "completed" || status === "cancelled" || status === "failed") &&
    value.items.some(
      (item) => isRecord(item) && (item.status === "queued" || item.status === "probing")
    )
  ) {
    throw new Error("终态 job 仍有未终态 item。");
  }
}

function validateCounts(value: unknown, items: unknown[]): void {
  assertExactKeys(value, ["total", "queued", "probing", "ready", "failed", "cancelled"]);
  const fields = ["total", "queued", "probing", "ready", "failed", "cancelled"] as const;
  if (fields.some((field) => !isNonNegativeSafeInteger(value[field]))) {
    throw new Error("counts 必须是非负安全整数。");
  }
  const expected = { queued: 0, probing: 0, ready: 0, failed: 0, cancelled: 0 };
  for (const item of items) {
    if (isRecord(item) && ITEM_STATUSES.has(item.status as MediaInventoryItemStatus)) {
      expected[item.status as keyof typeof expected] += 1;
    }
  }
  if (
    value.total !== items.length ||
    value.queued !== expected.queued ||
    value.probing !== expected.probing ||
    value.ready !== expected.ready ||
    value.failed !== expected.failed ||
    value.cancelled !== expected.cancelled
  ) {
    throw new Error("counts 与 item 状态不一致。");
  }
}

function validateItem(value: unknown, ordinal: number): asserts value is MediaInventoryItemSnapshot {
  assertExactKeys(value, ["ordinal", "itemId", "status", "result", "error"]);
  if (
    value.ordinal !== ordinal ||
    !isNonEmptyString(value.itemId) ||
    !ITEM_STATUSES.has(value.status as MediaInventoryItemStatus)
  ) {
    throw new Error(`items[${ordinal}] 基本字段无效。`);
  }
  const status = value.status as MediaInventoryItemStatus;
  if (status === "ready") {
    validateItemResult(value.result);
    if (value.error !== null) throw new Error(`items[${ordinal}] ready/error 互斥失败。`);
  } else if (status === "failed") {
    if (value.result !== null) throw new Error(`items[${ordinal}] failed/result 互斥失败。`);
    validateItemError(value.error);
  } else if (value.result !== null || value.error !== null) {
    throw new Error(`items[${ordinal}] 非结果状态不得带 result/error。`);
  }
}

function validateItemResult(value: unknown): asserts value is MediaInventoryItemResult {
  assertExactKeys(value, [
    "inventoryRevision",
    "durationMs",
    "audioTracks",
    "recommendation",
    "probeCompleteness",
    "cacheState"
  ]);
  if (
    typeof value.inventoryRevision !== "string" ||
    !/^inventory-v1:[a-f0-9]{16}$/.test(value.inventoryRevision) ||
    !isNullableNonNegativeSafeInteger(value.durationMs) ||
    !Array.isArray(value.audioTracks) ||
    !PROBE_COMPLETENESS.has(value.probeCompleteness as MediaInventoryProbeCompleteness) ||
    !CACHE_STATES.has(value.cacheState as MediaInventoryCacheState)
  ) {
    throw new Error("item result 根字段无效。");
  }
  const audioTracks = value.audioTracks;
  const recommendation = value.recommendation;
  const indices = new Set<number>();
  const ranks = new Set<number>();
  let previousStreamIndex = -1;
  audioTracks.forEach((track, index) => {
    validateAudioTrack(track, index);
    if (track.index <= previousStreamIndex) {
      throw new Error("audioTracks 必须按 stream index 严格升序。");
    }
    previousStreamIndex = track.index;
    if (indices.has(track.index) || ranks.has(track.recommendationRank)) {
      throw new Error("音轨 index/rank 必须唯一。");
    }
    indices.add(track.index);
    ranks.add(track.recommendationRank);
  });
  if ([...ranks].some((rank) => rank < 1 || rank > audioTracks.length)) {
    throw new Error("音轨 recommendationRank 不连续。");
  }
  validateRecommendation(recommendation, indices);
  if (value.probeCompleteness === "partial") {
    if (recommendation.state === "recommended") {
      throw new Error("partial metadata 不得形成自动推荐。");
    }
    if (!recommendation.reasonCodes.includes("metadataIncomplete")) {
      throw new Error("partial metadata 必须说明 metadataIncomplete。");
    }
  }
  if (
    (recommendation.state === "unavailable") !==
    (audioTracks.length === 0)
  ) {
    throw new Error("unavailable 必须与空音轨清单一致。");
  }
}

function validateAudioTrack(value: unknown, index: number): asserts value is MediaInventoryAudioTrack {
  assertExactKeys(value, [
    "index",
    "codec",
    "language",
    "title",
    "sampleRate",
    "channels",
    "channelLayout",
    "durationMs",
    "dispositions",
    "recommendationRank",
    "reasonCodes"
  ]);
  if (
    !isNonNegativeSafeInteger(value.index) ||
    !isNullableString(value.codec) ||
    !isNullableString(value.language) ||
    !isNullableString(value.title) ||
    !isNullableNonNegativeSafeInteger(value.sampleRate) ||
    !isNullableNonNegativeSafeInteger(value.channels) ||
    !isNullableString(value.channelLayout) ||
    !isNullableNonNegativeSafeInteger(value.durationMs) ||
    !isNonNegativeSafeInteger(value.recommendationRank) ||
    !isReasonCodeArray(value.reasonCodes)
  ) {
    throw new Error(`audioTracks[${index}] 字段无效。`);
  }
  validateDispositions(value.dispositions);
}

function validateDispositions(value: unknown): asserts value is MediaInventoryAudioDispositions {
  assertExactKeys(value, [
    "default",
    "original",
    "dub",
    "commentary",
    "descriptions",
    "visualImpaired",
    "hearingImpaired",
    "cleanEffects",
    "karaoke"
  ]);
  if (Object.values(value).some((flag) => typeof flag !== "boolean")) {
    throw new Error("音轨 dispositions 必须全部为 boolean。");
  }
}

function validateRecommendation(
  value: unknown,
  streamIndices: Set<number>
): asserts value is MediaInventoryRecommendation {
  assertExactKeys(value, ["state", "streamIndex", "reasonCodes"]);
  if (
    !RECOMMENDATION_STATES.has(value.state as MediaInventoryRecommendationState) ||
    !isReasonCodeArray(value.reasonCodes)
  ) {
    throw new Error("recommendation 字段无效。");
  }
  if (value.state === "recommended") {
    if (!isNonNegativeSafeInteger(value.streamIndex) || !streamIndices.has(value.streamIndex)) {
      throw new Error("recommended streamIndex 不存在。");
    }
    if (
      !value.reasonCodes.some(
        (reason) =>
          reason === "onlyNonSpecialTrack" ||
          reason === "preferredLanguage" ||
          reason === "originalDisposition"
      )
    ) {
      throw new Error("recommended 缺少强证据 reason code。");
    }
  } else if (value.streamIndex !== null) {
    throw new Error("非 recommended 状态不得带 streamIndex。");
  }
}

function validateItemError(value: unknown): asserts value is MediaInventoryItemError {
  assertExactKeys(value, ["code", "message"]);
  if (
    !ITEM_ERROR_CODES.has(value.code as MediaInventoryItemErrorCode) ||
    !isNonEmptyString(value.message)
  ) {
    throw new Error("item error 无效。");
  }
}

function validateTerminalError(value: unknown): asserts value is MediaInventoryTerminalError {
  assertExactKeys(value, ["code", "message"]);
  if (
    !TERMINAL_ERROR_CODES.has(value.code as MediaInventoryTerminalErrorCode) ||
    !isNonEmptyString(value.message)
  ) {
    throw new Error("terminal error 无效。");
  }
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("预期对象。 ");
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`字段不匹配：${actual.join(",")}。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeSafeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeSafeInteger(value);
}

function isReasonCodeArray(value: unknown): value is MediaInventoryRecommendationReasonCode[] {
  return (
    Array.isArray(value) &&
    value.every(
      (reason) =>
        typeof reason === "string" &&
        REASON_CODES.has(reason as MediaInventoryRecommendationReasonCode)
    )
  );
}
