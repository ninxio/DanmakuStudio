import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AlignmentProposal } from "../../domain/alignment/types";
import { sha256Hex } from "../../domain/shared/sha256";
import {
  normalizeTauriSpectralBackendPreference,
  type AudioAlignmentJobStatus,
  type AudioAlignmentStageKey,
  type NormalizedTauriAudioAlignmentRequest,
  type TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";
import type { RealMediaBenchmarkRunManifest } from "./realMediaBenchmarkRunner";
import { discloseKnownAlignmentFailure } from "./safeAlignmentFailureDisclosure";

export const ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION = 2 as const;
export const ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS = 10;
export const ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS = 1_000;
export const ALIGNMENT_BENCHMARK_MAX_RUN_MANIFEST_BYTES = 16 * 1024 * 1024;
const ALIGNMENT_BENCHMARK_MAX_CASES = 1_000;

export interface AlignmentBenchmarkSessionRequest {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  memorySampleIntervalMs: number;
  runManifestCanonicalJson: string;
  runManifestDigest: `sha256:${string}`;
  workloadDigest: `sha256:${string}`;
}

export interface AlignmentBenchmarkToolFingerprint {
  version: string;
  binaryDigest: `sha256:${string}`;
}

export interface AlignmentBenchmarkWorkloadStorageBinding {
  bindingOrdinal: number;
  caseOrdinal: number;
  side: "source" | "target";
  volumeOrdinal: number;
}

export interface AlignmentBenchmarkWorkloadStorageVolume {
  volumeOrdinal: number;
  bindingCount: number;
  driveType: "fixed";
  seekPenalty: "incurs" | "none";
  measurementStatus: "complete";
}

export interface AlignmentBenchmarkWorkloadStorageReceipt {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  runManifestDigest: `sha256:${string}`;
  workloadDigest: `sha256:${string}`;
  bindingCount: number;
  uniqueMediaCount: number;
  volumeCount: number;
  mediaSetDigest: `sha256:${string}`;
  bindings: AlignmentBenchmarkWorkloadStorageBinding[];
  volumes: AlignmentBenchmarkWorkloadStorageVolume[];
  receiptDigest: `sha256:${string}`;
}

export interface AlignmentBenchmarkEnvironmentReceipt {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  collectorVersion: string;
  measurementStatus: "complete" | "incomplete";
  issues: string[];
  operatingSystem: string;
  operatingSystemVersion: string;
  architecture: string;
  cpuModel: string;
  physicalCoreCount: number;
  logicalCoreCount: number;
  totalMemoryBytes: number;
  storageScope: "workload-media-volumes";
  storageKind: string;
  workloadStorage: AlignmentBenchmarkWorkloadStorageReceipt;
  powerProfile: string;
  ffmpeg: AlignmentBenchmarkToolFingerprint;
  ffprobe: AlignmentBenchmarkToolFingerprint;
}

export type AlignmentBenchmarkSessionStatus = "active" | "cleanup-blocked" | "released";

export interface AlignmentBenchmarkTerminalCleanupReceipt {
  schemaVersion: 1;
  sessionId: string;
  runManifestDigest: `sha256:${string}`;
  workloadDigest: `sha256:${string}`;
  workloadStorageReceiptDigest: `sha256:${string}`;
  terminalTickNs: string;
  finalCacheGeneration: number;
  jobCount: number;
  completedJobCount: number;
  failedJobCount: number;
  cancelledJobCount: number;
  jobInventoryDigest: `sha256:${string}`;
  allJobsTerminal: true;
  processTreeEmpty: true;
  residualProcessCount: 0;
  supervisionCleanupStatus: "clean";
  toolchainReverified: true;
  workloadReverified: true;
  featureCachesEmpty: true;
  receiptDigest: `sha256:${string}`;
}

export interface AlignmentBenchmarkJobMemoryReceipt {
  schemaVersion: 1;
  sessionId: string;
  runManifestDigest: `sha256:${string}`;
  workloadDigest: `sha256:${string}`;
  workloadStorageReceiptDigest: `sha256:${string}`;
  sampler: "windows-job-object-working-set-v1";
  memoryScope: "application-process-tree";
  jobCount: number;
  totalSampleCount: number;
  totalFailedSampleCount: 0;
  maximumSampleGapMicros: string;
  peakJobHierarchyRssBytes: number;
  jobMemoryInventoryDigest: `sha256:${string}`;
  allJobsCoverageComplete: true;
  allSamplesJobBound: true;
  allTerminalProcessTreesEmpty: true;
  receiptDigest: `sha256:${string}`;
}

export interface AlignmentBenchmarkSessionSnapshot {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  sessionId: string;
  status: AlignmentBenchmarkSessionStatus;
  sessionOriginTickNs: "0";
  cacheGeneration: number;
  memoryScope: "application-process-tree";
  memorySampleIntervalMs: number;
  environment: AlignmentBenchmarkEnvironmentReceipt;
  activeJobId: string | null;
  cleanupIssue: string | null;
  jobMemoryReceipt: AlignmentBenchmarkJobMemoryReceipt | null;
  terminalCleanupReceipt: AlignmentBenchmarkTerminalCleanupReceipt | null;
}

export interface AlignmentBenchmarkCacheCounts {
  audioFeatureEntries: number;
  landmarkEntries: number;
  visualFeatureEntries: number;
}

export interface AlignmentBenchmarkCacheResetReceipt {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  sessionId: string;
  resetTickNs: string;
  previousGeneration: number;
  cacheGeneration: number;
  before: AlignmentBenchmarkCacheCounts;
  after: AlignmentBenchmarkCacheCounts;
  allCachesEmpty: boolean;
}

export interface AlignmentBenchmarkCacheCounter {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

export interface AlignmentBenchmarkCacheTelemetry {
  generation: number;
  before: AlignmentBenchmarkCacheCounts;
  after: AlignmentBenchmarkCacheCounts;
  audioFeatures: AlignmentBenchmarkCacheCounter;
  landmarks: AlignmentBenchmarkCacheCounter;
  visualFeatures: AlignmentBenchmarkCacheCounter;
}

export interface AlignmentBenchmarkStageTiming {
  stageKey: AudioAlignmentStageKey;
  occurrence: number;
  startTickNs: string;
  endTickNs: string;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
}

export interface AlignmentBenchmarkMemoryTelemetry {
  scope: "application-process-tree";
  sampler:
    "windows-toolhelp-working-set-v1" | "windows-job-object-working-set-v1" | "unsupported";
  sampleIntervalMs: number;
  sampleCount: number;
  failedSampleCount: number;
  maximumSampleGapMs: number;
  peakProcessTreeRssBytes: number | null;
  coverageComplete: boolean;
  processTreeEmptyAtTerminal: boolean;
  residualProcessCount: number;
}

export interface AlignmentBenchmarkCancellationTelemetry {
  requestTickNs: string;
  terminalTickNs: string;
  latencyMs: number;
  commandAccepted: boolean;
}

export interface AlignmentBenchmarkJobTelemetry {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  clock: "rust-std-instant-session-relative-v1";
  startTickNs: string;
  endTickNs: string | null;
  elapsedMs: number;
  stages: AlignmentBenchmarkStageTiming[];
  cache: AlignmentBenchmarkCacheTelemetry;
  memory: AlignmentBenchmarkMemoryTelemetry;
  cancellation: AlignmentBenchmarkCancellationTelemetry | null;
}

export interface AlignmentBenchmarkJobSnapshot {
  schemaVersion: typeof ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION;
  sessionId: string;
  jobId: string;
  status: AudioAlignmentJobStatus;
  stageKey: AudioAlignmentStageKey;
  stageLabel: string;
  proposal: AlignmentProposal | null;
  errorCode: string | null;
  telemetry: AlignmentBenchmarkJobTelemetry;
}

export interface AlignmentBenchmarkInvoker {
  begin: (
    request: AlignmentBenchmarkSessionRequest
  ) => Promise<AlignmentBenchmarkSessionSnapshot>;
  getActive: () => Promise<AlignmentBenchmarkSessionSnapshot | null>;
  resetCaches: (sessionId: string) => Promise<AlignmentBenchmarkCacheResetReceipt>;
  startJob: (
    sessionId: string,
    request: NormalizedTauriAudioAlignmentRequest
  ) => Promise<AlignmentBenchmarkJobSnapshot>;
  getJob: (sessionId: string, jobId: string) => Promise<AlignmentBenchmarkJobSnapshot>;
  cancelJob: (sessionId: string, jobId: string) => Promise<AlignmentBenchmarkJobSnapshot>;
  finish: (sessionId: string) => Promise<AlignmentBenchmarkSessionSnapshot>;
}

export function createAlignmentBenchmarkRunManifestCanonicalJson(
  runManifest: RealMediaBenchmarkRunManifest
): string {
  assertRunManifestShape(runManifest);
  if (
    runManifest.cases.length === 0 ||
    runManifest.cases.length > ALIGNMENT_BENCHMARK_MAX_CASES
  ) {
    throw new Error(
      `原生性能 blind run manifest 必须包含 1–${ALIGNMENT_BENCHMARK_MAX_CASES} 个真实 case。`
    );
  }
  const canonical = canonicalJson(runManifest);
  requireBoundedUtf8(
    canonical,
    "blind run manifest",
    ALIGNMENT_BENCHMARK_MAX_RUN_MANIFEST_BYTES
  );
  return canonical;
}

export async function beginAlignmentBenchmarkSession(
  request: AlignmentBenchmarkSessionRequest,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkSessionSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalized = normalizeSessionRequest(request);
  let response: unknown;
  try {
    response = await invoker.begin(normalized);
  } catch {
    throw new Error("无法取得原生性能独占会话；详细系统信息未进入可分享错误。");
  }
  try {
    return assertSessionSnapshot(response);
  } catch {
    const released = await bestEffortReleaseSessionAfterInvalidBeginResponse(invoker, response);
    throw new Error(
      released
        ? "无法取得原生性能独占会话；详细系统信息未进入可分享错误。"
        : "无法取得原生性能独占会话，且原生会话回收状态不确定；请重启应用后再运行。详细系统信息未进入可分享错误。"
    );
  }
}

export async function getActiveAlignmentBenchmarkSession(
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkSessionSnapshot | null> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  try {
    const snapshot = await invoker.getActive();
    return snapshot === null ? null : assertSessionSnapshot(snapshot);
  } catch {
    throw new Error("无法读取原生性能会话；详细系统信息未进入可分享错误。");
  }
}

export async function resetAlignmentBenchmarkCaches(
  sessionId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkCacheResetReceipt> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  try {
    const receipt = assertCacheResetReceipt(await invoker.resetCaches(normalizedSessionId));
    assertMatchingId(receipt.sessionId, normalizedSessionId);
    return receipt;
  } catch {
    throw new Error("原生性能缓存重置失败；缓存键和本地路径未进入错误。");
  }
}

export async function startAlignmentBenchmarkJob(
  sessionId: string,
  request: TauriAudioAlignmentRequest,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkJobSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  const normalizedRequest = normalizeAlignmentRequest(request);
  let response: unknown;
  try {
    response = await invoker.startJob(normalizedSessionId, normalizedRequest);
  } catch (error: unknown) {
    const disclosure = discloseKnownAlignmentFailure(error);
    if (disclosure) {
      throw new Error(disclosure.code);
    }
    throw new Error("原生性能任务启动失败；媒体路径和工具输出未进入错误。");
  }
  try {
    const snapshot = assertJobSnapshot(response);
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    return snapshot;
  } catch {
    const recovered = await bestEffortCancelJobAfterInvalidStartResponse(
      invoker,
      normalizedSessionId,
      response
    );
    throw new Error(
      recovered
        ? "原生性能任务启动失败；媒体路径和工具输出未进入错误。"
        : "原生性能任务启动失败，且活动作业回收状态不确定；请重启应用后再运行。媒体路径和工具输出未进入错误。"
    );
  }
}

export async function getAlignmentBenchmarkJob(
  sessionId: string,
  jobId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkJobSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  const normalizedJobId = normalizeOpaqueId(jobId, "性能任务 ID");
  try {
    const snapshot = assertJobSnapshot(
      await invoker.getJob(normalizedSessionId, normalizedJobId)
    );
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    assertMatchingId(snapshot.jobId, normalizedJobId);
    return snapshot;
  } catch {
    throw new Error("原生性能任务状态读取失败；详细系统信息未进入可分享错误。");
  }
}

export async function cancelAlignmentBenchmarkJob(
  sessionId: string,
  jobId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkJobSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  const normalizedJobId = normalizeOpaqueId(jobId, "性能任务 ID");
  try {
    const snapshot = assertJobSnapshot(
      await invoker.cancelJob(normalizedSessionId, normalizedJobId)
    );
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    assertMatchingId(snapshot.jobId, normalizedJobId);
    return snapshot;
  } catch {
    throw new Error("原生性能任务取消失败；详细系统信息未进入可分享错误。");
  }
}

export async function finishAlignmentBenchmarkSession(
  sessionId: string,
  invoker: AlignmentBenchmarkInvoker = defaultAlignmentBenchmarkInvoker
): Promise<AlignmentBenchmarkSessionSnapshot> {
  ensureDesktopBenchmark(invoker === defaultAlignmentBenchmarkInvoker);
  const normalizedSessionId = normalizeOpaqueId(sessionId, "性能会话 ID");
  try {
    const snapshot = assertSessionSnapshot(await invoker.finish(normalizedSessionId));
    assertMatchingId(snapshot.sessionId, normalizedSessionId);
    if (snapshot.status !== "released" && snapshot.status !== "cleanup-blocked") {
      throw new Error("invalid terminal session status");
    }
    return snapshot;
  } catch {
    throw new Error("原生性能会话清理未得到可信终态；请重启应用后再运行。");
  }
}

export function isAlignmentBenchmarkJobFinished(status: AudioAlignmentJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const INVALID_RESPONSE_RECOVERY_POLL_INTERVAL_MS = 50;
const INVALID_RESPONSE_RECOVERY_MAX_POLLS = 600;

async function bestEffortReleaseSessionAfterInvalidBeginResponse(
  invoker: AlignmentBenchmarkInvoker,
  invalidResponse: unknown
): Promise<boolean> {
  const responseSessionId = readRecoveryOpaqueId(invalidResponse, "sessionId");
  if (responseSessionId === null) return false;

  let active: unknown;
  try {
    active = await invoker.getActive();
  } catch {
    return false;
  }
  if (readRecoveryOpaqueId(active, "sessionId") !== responseSessionId) return false;

  try {
    const terminal = await invoker.finish(responseSessionId);
    if (readRecoveryReleasedSession(terminal, responseSessionId)) return true;
  } catch {
    // The command may have released the lease before its transport failed. Re-check below.
  }

  try {
    const remaining = await invoker.getActive();
    return remaining === null;
  } catch {
    return false;
  }
}

async function bestEffortCancelJobAfterInvalidStartResponse(
  invoker: AlignmentBenchmarkInvoker,
  expectedSessionId: string,
  invalidResponse: unknown
): Promise<boolean> {
  const responseSessionId = readRecoveryOpaqueId(invalidResponse, "sessionId");
  const responseJobId = readRecoveryOpaqueId(invalidResponse, "jobId");
  if (responseSessionId !== expectedSessionId || responseJobId === null) return false;

  let active: unknown;
  try {
    active = await invoker.getActive();
  } catch {
    return false;
  }
  const sessionId = readRecoveryOpaqueId(active, "sessionId");
  const jobId = readRecoveryOpaqueId(active, "activeJobId");
  if (sessionId !== expectedSessionId || jobId === null || jobId !== responseJobId) {
    return false;
  }

  try {
    const cancelled = await invoker.cancelJob(sessionId, jobId);
    if (readRecoveryJobState(cancelled, sessionId, jobId) === "terminal") return true;
  } catch {
    // Cancellation may have been accepted before the transport failed; poll the lease state.
  }

  for (let poll = 0; poll < INVALID_RESPONSE_RECOVERY_MAX_POLLS; poll += 1) {
    let snapshot: unknown;
    try {
      snapshot = await invoker.getJob(sessionId, jobId);
    } catch {
      return false;
    }
    const state = readRecoveryJobState(snapshot, sessionId, jobId);
    if (state === "terminal") return true;
    if (state === "invalid") return false;
    if (poll + 1 < INVALID_RESPONSE_RECOVERY_MAX_POLLS) {
      await waitForInvalidResponseRecovery(INVALID_RESPONSE_RECOVERY_POLL_INTERVAL_MS);
    }
  }
  return false;
}

function readRecoveryOpaqueId(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(candidate)) {
    return null;
  }
  return candidate;
}

function readRecoveryReleasedSession(value: unknown, expectedSessionId: string): boolean {
  return (
    readRecoveryOpaqueId(value, "sessionId") === expectedSessionId &&
    readRecoveryString(value, "status") === "released"
  );
}

function readRecoveryJobState(
  value: unknown,
  expectedSessionId: string,
  expectedJobId: string
): "pending" | "terminal" | "invalid" {
  if (
    readRecoveryOpaqueId(value, "sessionId") !== expectedSessionId ||
    readRecoveryOpaqueId(value, "jobId") !== expectedJobId
  ) {
    return "invalid";
  }
  const status = readRecoveryString(value, "status");
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return "terminal";
  }
  return status === "queued" || status === "running" ? "pending" : "invalid";
}

function readRecoveryString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function waitForInvalidResponseRecovery(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

const defaultAlignmentBenchmarkInvoker: AlignmentBenchmarkInvoker = {
  begin: (request) =>
    invoke<AlignmentBenchmarkSessionSnapshot>("begin_alignment_benchmark_session", { request }),
  getActive: () =>
    invoke<AlignmentBenchmarkSessionSnapshot | null>("get_active_alignment_benchmark_session"),
  resetCaches: (sessionId) =>
    invoke<AlignmentBenchmarkCacheResetReceipt>("reset_alignment_benchmark_caches", {
      sessionId
    }),
  startJob: (sessionId, request) =>
    invoke<AlignmentBenchmarkJobSnapshot>("start_alignment_benchmark_job", {
      sessionId,
      request
    }),
  getJob: (sessionId, jobId) =>
    invoke<AlignmentBenchmarkJobSnapshot>("get_alignment_benchmark_job", {
      sessionId,
      jobId
    }),
  cancelJob: (sessionId, jobId) =>
    invoke<AlignmentBenchmarkJobSnapshot>("cancel_alignment_benchmark_job", {
      sessionId,
      jobId
    }),
  finish: (sessionId) =>
    invoke<AlignmentBenchmarkSessionSnapshot>("finish_alignment_benchmark_session", {
      sessionId
    })
};

function normalizeSessionRequest(
  request: AlignmentBenchmarkSessionRequest
): AlignmentBenchmarkSessionRequest {
  requireExactKeys(
    request as unknown as Record<string, unknown>,
    [
      "schemaVersion",
      "ffmpegPath",
      "ffprobePath",
      "memorySampleIntervalMs",
      "runManifestCanonicalJson",
      "runManifestDigest",
      "workloadDigest"
    ],
    "benchmark session request"
  );
  requireSchemaVersion(request.schemaVersion, "benchmark session request.schemaVersion");
  if (
    !Number.isSafeInteger(request.memorySampleIntervalMs) ||
    request.memorySampleIntervalMs < ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS ||
    request.memorySampleIntervalMs > ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS
  ) {
    throw new Error(
      `内存采样间隔必须是 ${ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS}–${ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS}ms 的安全整数。`
    );
  }
  requireBoundedUtf8(
    request.runManifestCanonicalJson,
    "blind run manifest",
    ALIGNMENT_BENCHMARK_MAX_RUN_MANIFEST_BYTES
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.runManifestCanonicalJson) as unknown;
  } catch {
    throw new Error("blind run manifest 必须是 canonical JSON。");
  }
  assertRunManifestShape(parsed);
  const runManifest = parsed;
  if (
    runManifest.cases.length === 0 ||
    runManifest.cases.length > ALIGNMENT_BENCHMARK_MAX_CASES
  ) {
    throw new Error(
      `blind run manifest 必须包含 1–${ALIGNMENT_BENCHMARK_MAX_CASES} 个真实 case。`
    );
  }
  const canonical = canonicalJson(parsed);
  if (canonical !== request.runManifestCanonicalJson) {
    throw new Error("blind run manifest JSON 不是递归 key 排序的 canonical JSON。");
  }
  const runManifestDigest = requireSha256Digest(
    request.runManifestDigest,
    "benchmark session request.runManifestDigest"
  );
  const workloadDigest = requireSha256Digest(
    request.workloadDigest,
    "benchmark session request.workloadDigest"
  );
  const expectedDigest = `sha256:${sha256Hex(canonical)}` as const;
  if (
    runManifestDigest !== expectedDigest ||
    workloadDigest !== expectedDigest ||
    runManifestDigest !== workloadDigest
  ) {
    throw new Error("blind run manifest/workload digest 与 canonical JSON 不一致。");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    ffmpegPath: normalizeOptionalPath(request.ffmpegPath),
    ffprobePath: normalizeOptionalPath(request.ffprobePath),
    memorySampleIntervalMs: request.memorySampleIntervalMs,
    runManifestCanonicalJson: canonical,
    runManifestDigest,
    workloadDigest
  };
}

function normalizeAlignmentRequest(
  request: TauriAudioAlignmentRequest
): NormalizedTauriAudioAlignmentRequest {
  return {
    ...request,
    ffprobePath: request.ffprobePath ?? null,
    completeAudioStreamIndex: normalizeStreamIndex(
      request.completeAudioStreamIndex,
      "原片音轨索引"
    ),
    sourceAudioStreamIndex: normalizeStreamIndex(
      request.sourceAudioStreamIndex,
      "参考音轨索引"
    ),
    completeVideoStreamIndex: normalizeStreamIndex(
      request.completeVideoStreamIndex,
      "原片视频流索引"
    ),
    sourceVideoStreamIndex: normalizeStreamIndex(
      request.sourceVideoStreamIndex,
      "参考视频流索引"
    ),
    spectralBackend: normalizeTauriSpectralBackendPreference(request.spectralBackend)
  };
}

function normalizeStreamIndex(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负安全整数或 null。`);
  }
  return value;
}

function normalizeOptionalPath(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOpaqueId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(trimmed)) {
    throw new Error(`${label}格式无效。`);
  }
  return trimmed;
}

function ensureDesktopBenchmark(usesDefaultInvoker: boolean): void {
  if (usesDefaultInvoker && !isTauri()) {
    throw new Error("原生性能证据只能在 Tauri 桌面端采集。");
  }
}

const SESSION_STATUSES = ["active", "cleanup-blocked", "released"] as const;
const JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;
const STAGE_KEYS = [
  "queued",
  "validating",
  "extracting-complete",
  "extracting-source",
  "extracting-visual",
  "fingerprinting",
  "matching",
  "fitting",
  "refining",
  "reporting",
  "completed",
  "failed",
  "cancelled"
] as const;
const ERROR_CODES = [
  "memory-sampler-start-failed",
  "toolchain-integrity-failed",
  "cache-telemetry-incomplete",
  "alignment-failed",
  "cleanup-blocked"
] as const;
const MEMORY_SAMPLERS = [
  "windows-toolhelp-working-set-v1",
  "windows-job-object-working-set-v1",
  "unsupported"
] as const;
const STORAGE_SCOPES = ["workload-media-volumes"] as const;
const MAX_ENVIRONMENT_ISSUES = 128;
const MAX_STAGE_TIMINGS = 512;
const MAX_TEXT_LENGTH = 4_096;
const MAX_SHORT_TEXT_LENGTH = 512;
const MAX_CACHE_ENTRY_COUNT = 1_000_000;
const MAX_WORKLOAD_BINDINGS = ALIGNMENT_BENCHMARK_MAX_CASES * 2;
const MAX_U128 = 340_282_366_920_938_463_463_374_607_431_768_211_455n;

function assertSessionSnapshot(value: unknown): AlignmentBenchmarkSessionSnapshot {
  const snapshot = requireRecord(value, "session snapshot");
  requireExactKeys(
    snapshot,
    [
      "schemaVersion",
      "sessionId",
      "status",
      "sessionOriginTickNs",
      "cacheGeneration",
      "memoryScope",
      "memorySampleIntervalMs",
      "environment",
      "activeJobId",
      "cleanupIssue",
      "jobMemoryReceipt",
      "terminalCleanupReceipt"
    ],
    "session snapshot"
  );
  requireSchemaVersion(snapshot.schemaVersion, "session snapshot.schemaVersion");
  const sessionId = requireOpaqueResponseId(snapshot.sessionId, "session snapshot.sessionId");
  const status = requireEnum(snapshot.status, SESSION_STATUSES, "session snapshot.status");
  if (snapshot.sessionOriginTickNs !== "0") {
    throw new Error("invalid session snapshot.sessionOriginTickNs");
  }
  const cacheGeneration = requireNonNegativeSafeInteger(
    snapshot.cacheGeneration,
    "session snapshot.cacheGeneration"
  );
  if (snapshot.memoryScope !== "application-process-tree") {
    throw new Error("invalid session snapshot.memoryScope");
  }
  const memorySampleIntervalMs = requireSampleInterval(
    snapshot.memorySampleIntervalMs,
    "session snapshot.memorySampleIntervalMs"
  );
  const environment = assertEnvironmentReceipt(snapshot.environment);
  const activeJobId =
    snapshot.activeJobId === null
      ? null
      : requireOpaqueResponseId(snapshot.activeJobId, "session snapshot.activeJobId");
  const cleanupIssue =
    snapshot.cleanupIssue === null
      ? null
      : requireBoundedString(
          snapshot.cleanupIssue,
          "session snapshot.cleanupIssue",
          1,
          MAX_TEXT_LENGTH
        );
  const jobMemoryReceipt =
    snapshot.jobMemoryReceipt === null
      ? null
      : assertJobMemoryReceipt(snapshot.jobMemoryReceipt);
  const terminalCleanupReceipt =
    snapshot.terminalCleanupReceipt === null
      ? null
      : assertTerminalCleanupReceipt(snapshot.terminalCleanupReceipt);
  if (status === "released" && activeJobId !== null) {
    throw new Error("invalid released session active job");
  }
  if (status === "cleanup-blocked" && cleanupIssue === null) {
    throw new Error("invalid cleanup-blocked session issue");
  }
  if (status !== "cleanup-blocked" && cleanupIssue !== null) {
    throw new Error("invalid non-blocked session issue");
  }
  if (status === "released" && terminalCleanupReceipt === null) {
    throw new Error("invalid released session terminal cleanup receipt");
  }
  if (status !== "released" && terminalCleanupReceipt !== null) {
    throw new Error("invalid non-released session terminal cleanup receipt");
  }
  if (status === "released" && jobMemoryReceipt === null) {
    throw new Error("invalid released session Job memory receipt");
  }
  if (status !== "released" && jobMemoryReceipt !== null) {
    throw new Error("invalid non-released session Job memory receipt");
  }
  if (
    jobMemoryReceipt &&
    (jobMemoryReceipt.sessionId !== sessionId ||
      jobMemoryReceipt.runManifestDigest !== environment.workloadStorage.runManifestDigest ||
      jobMemoryReceipt.workloadDigest !== environment.workloadStorage.workloadDigest ||
      jobMemoryReceipt.workloadStorageReceiptDigest !==
        environment.workloadStorage.receiptDigest)
  ) {
    throw new Error("Job memory receipt 未绑定当前 session/workload/storage receipt");
  }
  if (
    terminalCleanupReceipt &&
    (terminalCleanupReceipt.sessionId !== sessionId ||
      terminalCleanupReceipt.runManifestDigest !==
        environment.workloadStorage.runManifestDigest ||
      terminalCleanupReceipt.workloadDigest !== environment.workloadStorage.workloadDigest ||
      terminalCleanupReceipt.workloadStorageReceiptDigest !==
        environment.workloadStorage.receiptDigest ||
      terminalCleanupReceipt.finalCacheGeneration !== cacheGeneration)
  ) {
    throw new Error("terminal cleanup receipt 未绑定当前 session/workload/cache generation");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    sessionId,
    status,
    sessionOriginTickNs: "0",
    cacheGeneration,
    memoryScope: "application-process-tree",
    memorySampleIntervalMs,
    environment,
    activeJobId,
    cleanupIssue,
    jobMemoryReceipt,
    terminalCleanupReceipt
  };
}

function assertJobMemoryReceipt(value: unknown): AlignmentBenchmarkJobMemoryReceipt {
  const receipt = requireRecord(value, "Job memory receipt");
  requireExactKeys(
    receipt,
    [
      "schemaVersion",
      "sessionId",
      "runManifestDigest",
      "workloadDigest",
      "workloadStorageReceiptDigest",
      "sampler",
      "memoryScope",
      "jobCount",
      "totalSampleCount",
      "totalFailedSampleCount",
      "maximumSampleGapMicros",
      "peakJobHierarchyRssBytes",
      "jobMemoryInventoryDigest",
      "allJobsCoverageComplete",
      "allSamplesJobBound",
      "allTerminalProcessTreesEmpty",
      "receiptDigest"
    ],
    "Job memory receipt"
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sampler !== "windows-job-object-working-set-v1" ||
    receipt.memoryScope !== "application-process-tree" ||
    receipt.totalFailedSampleCount !== 0 ||
    receipt.allJobsCoverageComplete !== true ||
    receipt.allSamplesJobBound !== true ||
    receipt.allTerminalProcessTreesEmpty !== true
  ) {
    throw new Error("invalid Job memory receipt completion claims");
  }
  const jobCount = requireBoundedNonNegativeSafeInteger(
    receipt.jobCount,
    "Job memory receipt.jobCount",
    64_000
  );
  const totalSampleCount = requireBoundedNonNegativeSafeInteger(
    receipt.totalSampleCount,
    "Job memory receipt.totalSampleCount",
    Number.MAX_SAFE_INTEGER
  );
  const peakJobHierarchyRssBytes = requireBoundedNonNegativeSafeInteger(
    receipt.peakJobHierarchyRssBytes,
    "Job memory receipt.peakJobHierarchyRssBytes",
    Number.MAX_SAFE_INTEGER
  );
  if (
    (jobCount === 0 && (totalSampleCount !== 0 || peakJobHierarchyRssBytes !== 0)) ||
    (jobCount > 0 && (totalSampleCount < jobCount || peakJobHierarchyRssBytes === 0))
  ) {
    throw new Error("invalid Job memory receipt aggregate counts");
  }
  const withoutReceiptDigest: Omit<AlignmentBenchmarkJobMemoryReceipt, "receiptDigest"> = {
    schemaVersion: 1,
    sessionId: requireOpaqueResponseId(receipt.sessionId, "Job memory receipt.sessionId"),
    runManifestDigest: requireSha256Digest(
      receipt.runManifestDigest,
      "Job memory receipt.runManifestDigest"
    ),
    workloadDigest: requireSha256Digest(
      receipt.workloadDigest,
      "Job memory receipt.workloadDigest"
    ),
    workloadStorageReceiptDigest: requireSha256Digest(
      receipt.workloadStorageReceiptDigest,
      "Job memory receipt.workloadStorageReceiptDigest"
    ),
    sampler: "windows-job-object-working-set-v1",
    memoryScope: "application-process-tree",
    jobCount,
    totalSampleCount,
    totalFailedSampleCount: 0,
    maximumSampleGapMicros: requireCanonicalDecimalTick(
      receipt.maximumSampleGapMicros,
      "Job memory receipt.maximumSampleGapMicros"
    ),
    peakJobHierarchyRssBytes,
    jobMemoryInventoryDigest: requireSha256Digest(
      receipt.jobMemoryInventoryDigest,
      "Job memory receipt.jobMemoryInventoryDigest"
    ),
    allJobsCoverageComplete: true,
    allSamplesJobBound: true,
    allTerminalProcessTreesEmpty: true
  };
  const receiptDigest = requireSha256Digest(
    receipt.receiptDigest,
    "Job memory receipt.receiptDigest"
  );
  const expectedReceiptDigest = `sha256:${sha256Hex(canonicalJson({
    domain: "c137-performance-job-memory-receipt-v1",
    receipt: withoutReceiptDigest
  }))}`;
  if (receiptDigest !== expectedReceiptDigest) {
    throw new Error("invalid Job memory receipt.receiptDigest binding");
  }
  return { ...withoutReceiptDigest, receiptDigest };
}

function assertTerminalCleanupReceipt(
  value: unknown
): AlignmentBenchmarkTerminalCleanupReceipt {
  const receipt = requireRecord(value, "terminal cleanup receipt");
  requireExactKeys(
    receipt,
    [
      "schemaVersion",
      "sessionId",
      "runManifestDigest",
      "workloadDigest",
      "workloadStorageReceiptDigest",
      "terminalTickNs",
      "finalCacheGeneration",
      "jobCount",
      "completedJobCount",
      "failedJobCount",
      "cancelledJobCount",
      "jobInventoryDigest",
      "allJobsTerminal",
      "processTreeEmpty",
      "residualProcessCount",
      "supervisionCleanupStatus",
      "toolchainReverified",
      "workloadReverified",
      "featureCachesEmpty",
      "receiptDigest"
    ],
    "terminal cleanup receipt"
  );
  if (receipt.schemaVersion !== 1) {
    throw new Error("invalid terminal cleanup receipt.schemaVersion");
  }
  const jobCount = requireBoundedNonNegativeSafeInteger(
    receipt.jobCount,
    "terminal cleanup receipt.jobCount",
    64_000
  );
  const completedJobCount = requireBoundedNonNegativeSafeInteger(
    receipt.completedJobCount,
    "terminal cleanup receipt.completedJobCount",
    jobCount
  );
  const failedJobCount = requireBoundedNonNegativeSafeInteger(
    receipt.failedJobCount,
    "terminal cleanup receipt.failedJobCount",
    jobCount
  );
  const cancelledJobCount = requireBoundedNonNegativeSafeInteger(
    receipt.cancelledJobCount,
    "terminal cleanup receipt.cancelledJobCount",
    jobCount
  );
  if (completedJobCount + failedJobCount + cancelledJobCount !== jobCount) {
    throw new Error("invalid terminal cleanup receipt job counts");
  }
  if (
    receipt.allJobsTerminal !== true ||
    receipt.processTreeEmpty !== true ||
    receipt.residualProcessCount !== 0 ||
    receipt.supervisionCleanupStatus !== "clean" ||
    receipt.toolchainReverified !== true ||
    receipt.workloadReverified !== true ||
    receipt.featureCachesEmpty !== true
  ) {
    throw new Error("invalid terminal cleanup receipt completion claims");
  }
  const withoutReceiptDigest: Omit<AlignmentBenchmarkTerminalCleanupReceipt, "receiptDigest"> = {
    schemaVersion: 1,
    sessionId: requireOpaqueResponseId(
      receipt.sessionId,
      "terminal cleanup receipt.sessionId"
    ),
    runManifestDigest: requireSha256Digest(
      receipt.runManifestDigest,
      "terminal cleanup receipt.runManifestDigest"
    ),
    workloadDigest: requireSha256Digest(
      receipt.workloadDigest,
      "terminal cleanup receipt.workloadDigest"
    ),
    workloadStorageReceiptDigest: requireSha256Digest(
      receipt.workloadStorageReceiptDigest,
      "terminal cleanup receipt.workloadStorageReceiptDigest"
    ),
    terminalTickNs: requireCanonicalDecimalTick(
      receipt.terminalTickNs,
      "terminal cleanup receipt.terminalTickNs"
    ),
    finalCacheGeneration: requireNonNegativeSafeInteger(
      receipt.finalCacheGeneration,
      "terminal cleanup receipt.finalCacheGeneration"
    ),
    jobCount,
    completedJobCount,
    failedJobCount,
    cancelledJobCount,
    jobInventoryDigest: requireSha256Digest(
      receipt.jobInventoryDigest,
      "terminal cleanup receipt.jobInventoryDigest"
    ),
    allJobsTerminal: true,
    processTreeEmpty: true,
    residualProcessCount: 0,
    supervisionCleanupStatus: "clean",
    toolchainReverified: true,
    workloadReverified: true,
    featureCachesEmpty: true
  };
  const receiptDigest = requireSha256Digest(
    receipt.receiptDigest,
    "terminal cleanup receipt.receiptDigest"
  );
  const expectedReceiptDigest = `sha256:${sha256Hex(canonicalJson({
    domain: "c137-performance-terminal-cleanup-receipt-v1",
    receipt: withoutReceiptDigest
  }))}`;
  if (receiptDigest !== expectedReceiptDigest) {
    throw new Error("invalid terminal cleanup receipt.receiptDigest binding");
  }
  return { ...withoutReceiptDigest, receiptDigest };
}

function assertEnvironmentReceipt(value: unknown): AlignmentBenchmarkEnvironmentReceipt {
  const environment = requireRecord(value, "environment receipt");
  requireExactKeys(
    environment,
    [
      "schemaVersion",
      "collectorVersion",
      "measurementStatus",
      "issues",
      "operatingSystem",
      "operatingSystemVersion",
      "architecture",
      "cpuModel",
      "physicalCoreCount",
      "logicalCoreCount",
      "totalMemoryBytes",
      "storageScope",
      "storageKind",
      "workloadStorage",
      "powerProfile",
      "ffmpeg",
      "ffprobe"
    ],
    "environment receipt"
  );
  requireSchemaVersion(environment.schemaVersion, "environment.schemaVersion");
  const issues = requireBoundedStringArray(
    environment.issues,
    "environment.issues",
    MAX_ENVIRONMENT_ISSUES,
    MAX_SHORT_TEXT_LENGTH
  );
  const measurementStatus = requireEnum(
    environment.measurementStatus,
    ["complete", "incomplete"] as const,
    "environment.measurementStatus"
  );
  if (measurementStatus === "complete" && issues.length !== 0) {
    throw new Error("invalid complete environment issues");
  }
  if (measurementStatus === "incomplete" && issues.length === 0) {
    throw new Error("invalid incomplete environment issues");
  }
  const physicalCoreCount = requirePositiveSafeInteger(
    environment.physicalCoreCount,
    "environment.physicalCoreCount"
  );
  const logicalCoreCount = requirePositiveSafeInteger(
    environment.logicalCoreCount,
    "environment.logicalCoreCount"
  );
  if (physicalCoreCount > logicalCoreCount) {
    throw new Error("invalid environment core topology");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    collectorVersion: requireBoundedString(
      environment.collectorVersion,
      "environment.collectorVersion",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    measurementStatus,
    issues,
    operatingSystem: requireBoundedString(
      environment.operatingSystem,
      "environment.operatingSystem",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    operatingSystemVersion: requireBoundedString(
      environment.operatingSystemVersion,
      "environment.operatingSystemVersion",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    architecture: requireBoundedString(
      environment.architecture,
      "environment.architecture",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    cpuModel: requireBoundedString(
      environment.cpuModel,
      "environment.cpuModel",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    physicalCoreCount,
    logicalCoreCount,
    totalMemoryBytes: requirePositiveSafeInteger(
      environment.totalMemoryBytes,
      "environment.totalMemoryBytes"
    ),
    storageScope: requireEnum(
      environment.storageScope,
      STORAGE_SCOPES,
      "environment.storageScope"
    ),
    storageKind: requireBoundedString(
      environment.storageKind,
      "environment.storageKind",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    workloadStorage: assertWorkloadStorageReceipt(environment.workloadStorage),
    powerProfile: requireBoundedString(
      environment.powerProfile,
      "environment.powerProfile",
      1,
      MAX_SHORT_TEXT_LENGTH
    ),
    ffmpeg: assertToolFingerprint(environment.ffmpeg, "environment.ffmpeg"),
    ffprobe: assertToolFingerprint(environment.ffprobe, "environment.ffprobe")
  };
}

function assertWorkloadStorageReceipt(
  value: unknown
): AlignmentBenchmarkWorkloadStorageReceipt {
  const receipt = requireRecord(value, "environment.workloadStorage");
  requireExactKeys(
    receipt,
    [
      "schemaVersion",
      "runManifestDigest",
      "workloadDigest",
      "bindingCount",
      "uniqueMediaCount",
      "volumeCount",
      "mediaSetDigest",
      "bindings",
      "volumes",
      "receiptDigest"
    ],
    "environment.workloadStorage"
  );
  requireSchemaVersion(receipt.schemaVersion, "environment.workloadStorage.schemaVersion");
  const runManifestDigest = requireSha256Digest(
    receipt.runManifestDigest,
    "environment.workloadStorage.runManifestDigest"
  );
  const workloadDigest = requireSha256Digest(
    receipt.workloadDigest,
    "environment.workloadStorage.workloadDigest"
  );
  if (runManifestDigest !== workloadDigest) {
    throw new Error("invalid environment.workloadStorage workload binding");
  }
  const bindingCount = requirePositiveSafeInteger(
    receipt.bindingCount,
    "environment.workloadStorage.bindingCount"
  );
  if (bindingCount > MAX_WORKLOAD_BINDINGS || bindingCount % 2 !== 0) {
    throw new Error("invalid environment.workloadStorage.bindingCount");
  }
  const uniqueMediaCount = requirePositiveSafeInteger(
    receipt.uniqueMediaCount,
    "environment.workloadStorage.uniqueMediaCount"
  );
  if (uniqueMediaCount > bindingCount) {
    throw new Error("invalid environment.workloadStorage.uniqueMediaCount");
  }
  const volumeCount = requirePositiveSafeInteger(
    receipt.volumeCount,
    "environment.workloadStorage.volumeCount"
  );
  if (volumeCount > uniqueMediaCount) {
    throw new Error("invalid environment.workloadStorage.volumeCount");
  }
  const bindings = assertWorkloadStorageBindings(receipt.bindings, bindingCount, volumeCount);
  const volumes = assertWorkloadStorageVolumes(receipt.volumes, volumeCount, bindings);
  const mediaSetDigest = requireSha256Digest(
    receipt.mediaSetDigest,
    "environment.workloadStorage.mediaSetDigest"
  );
  const withoutReceiptDigest: Omit<AlignmentBenchmarkWorkloadStorageReceipt, "receiptDigest"> =
    {
      schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
      runManifestDigest,
      workloadDigest,
      bindingCount,
      uniqueMediaCount,
      volumeCount,
      mediaSetDigest,
      bindings,
      volumes
    };
  const receiptDigest = requireSha256Digest(
    receipt.receiptDigest,
    "environment.workloadStorage.receiptDigest"
  );
  const expectedReceiptDigest = `sha256:${sha256Hex(canonicalJson(withoutReceiptDigest))}`;
  if (receiptDigest !== expectedReceiptDigest) {
    throw new Error("invalid environment.workloadStorage.receiptDigest binding");
  }
  return { ...withoutReceiptDigest, receiptDigest };
}

function assertWorkloadStorageBindings(
  value: unknown,
  bindingCount: number,
  volumeCount: number
): AlignmentBenchmarkWorkloadStorageBinding[] {
  if (!Array.isArray(value) || value.length !== bindingCount) {
    throw new Error("invalid environment.workloadStorage.bindings");
  }
  return value.map((item, bindingOrdinal) => {
    const binding = requireRecord(
      item,
      `environment.workloadStorage.bindings[${bindingOrdinal}]`
    );
    requireExactKeys(
      binding,
      ["bindingOrdinal", "caseOrdinal", "side", "volumeOrdinal"],
      `environment.workloadStorage.bindings[${bindingOrdinal}]`
    );
    const expectedCaseOrdinal = Math.floor(bindingOrdinal / 2);
    const expectedSide = bindingOrdinal % 2 === 0 ? "source" : "target";
    if (
      binding.bindingOrdinal !== bindingOrdinal ||
      binding.caseOrdinal !== expectedCaseOrdinal ||
      binding.side !== expectedSide ||
      !Number.isSafeInteger(binding.volumeOrdinal) ||
      (binding.volumeOrdinal as number) < 0 ||
      (binding.volumeOrdinal as number) >= volumeCount
    ) {
      throw new Error(`invalid environment.workloadStorage.bindings[${bindingOrdinal}]`);
    }
    return {
      bindingOrdinal,
      caseOrdinal: expectedCaseOrdinal,
      side: expectedSide,
      volumeOrdinal: binding.volumeOrdinal as number
    };
  });
}

function assertWorkloadStorageVolumes(
  value: unknown,
  volumeCount: number,
  bindings: AlignmentBenchmarkWorkloadStorageBinding[]
): AlignmentBenchmarkWorkloadStorageVolume[] {
  if (!Array.isArray(value) || value.length !== volumeCount) {
    throw new Error("invalid environment.workloadStorage.volumes");
  }
  const actualBindingCounts = Array.from({ length: volumeCount }, () => 0);
  const minimumBindingOrdinals = Array.from({ length: volumeCount }, () => Infinity);
  for (const binding of bindings) {
    actualBindingCounts[binding.volumeOrdinal] += 1;
    minimumBindingOrdinals[binding.volumeOrdinal] = Math.min(
      minimumBindingOrdinals[binding.volumeOrdinal],
      binding.bindingOrdinal
    );
  }
  let previousMinimum = -1;
  return value.map((item, volumeOrdinal) => {
    const volume = requireRecord(item, `environment.workloadStorage.volumes[${volumeOrdinal}]`);
    requireExactKeys(
      volume,
      ["volumeOrdinal", "bindingCount", "driveType", "seekPenalty", "measurementStatus"],
      `environment.workloadStorage.volumes[${volumeOrdinal}]`
    );
    if (
      volume.volumeOrdinal !== volumeOrdinal ||
      volume.bindingCount !== actualBindingCounts[volumeOrdinal] ||
      actualBindingCounts[volumeOrdinal] <= 0 ||
      volume.driveType !== "fixed" ||
      (volume.seekPenalty !== "incurs" && volume.seekPenalty !== "none") ||
      volume.measurementStatus !== "complete" ||
      minimumBindingOrdinals[volumeOrdinal] <= previousMinimum
    ) {
      throw new Error(`invalid environment.workloadStorage.volumes[${volumeOrdinal}]`);
    }
    previousMinimum = minimumBindingOrdinals[volumeOrdinal];
    return {
      volumeOrdinal,
      bindingCount: actualBindingCounts[volumeOrdinal],
      driveType: "fixed",
      seekPenalty: volume.seekPenalty,
      measurementStatus: "complete"
    };
  });
}

function assertToolFingerprint(
  value: unknown,
  path: string
): AlignmentBenchmarkToolFingerprint {
  const fingerprint = requireRecord(value, path);
  requireExactKeys(fingerprint, ["version", "binaryDigest"], path);
  return {
    version: requireBoundedString(fingerprint.version, `${path}.version`, 1, MAX_TEXT_LENGTH),
    binaryDigest: requireSha256Digest(fingerprint.binaryDigest, `${path}.binaryDigest`)
  };
}

function assertCacheResetReceipt(value: unknown): AlignmentBenchmarkCacheResetReceipt {
  const receipt = requireRecord(value, "cache reset receipt");
  requireSchemaVersion(receipt.schemaVersion, "cache reset receipt.schemaVersion");
  const sessionId = requireOpaqueResponseId(receipt.sessionId, "cache reset receipt.sessionId");
  const resetTickNs = requireCanonicalDecimalTick(
    receipt.resetTickNs,
    "cache reset receipt.resetTickNs"
  );
  const previousGeneration = requireNonNegativeSafeInteger(
    receipt.previousGeneration,
    "cache reset receipt.previousGeneration"
  );
  const cacheGeneration = requireNonNegativeSafeInteger(
    receipt.cacheGeneration,
    "cache reset receipt.cacheGeneration"
  );
  if (cacheGeneration !== previousGeneration + 1) {
    throw new Error("invalid cache reset generation transition");
  }
  const before = assertCacheCounts(receipt.before, "cache reset receipt.before");
  const after = assertCacheCounts(receipt.after, "cache reset receipt.after");
  if (receipt.allCachesEmpty !== true || !areCachesEmpty(after)) {
    throw new Error("invalid cache reset empty state");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    sessionId,
    resetTickNs,
    previousGeneration,
    cacheGeneration,
    before,
    after,
    allCachesEmpty: true
  };
}

function assertJobSnapshot(value: unknown): AlignmentBenchmarkJobSnapshot {
  const snapshot = requireRecord(value, "benchmark job snapshot");
  requireSchemaVersion(snapshot.schemaVersion, "benchmark job snapshot.schemaVersion");
  const sessionId = requireOpaqueResponseId(
    snapshot.sessionId,
    "benchmark job snapshot.sessionId"
  );
  const jobId = requireOpaqueResponseId(snapshot.jobId, "benchmark job snapshot.jobId");
  const status = requireEnum(snapshot.status, JOB_STATUSES, "benchmark job snapshot.status");
  const stageKey = requireEnum(
    snapshot.stageKey,
    STAGE_KEYS,
    "benchmark job snapshot.stageKey"
  );
  const stageLabel = requireBoundedString(
    snapshot.stageLabel,
    "benchmark job snapshot.stageLabel",
    1,
    MAX_SHORT_TEXT_LENGTH
  );
  const proposal = assertProposalRecord(snapshot.proposal);
  const errorCode =
    snapshot.errorCode === null
      ? null
      : requireEnum(snapshot.errorCode, ERROR_CODES, "benchmark job snapshot.errorCode");
  const telemetry = assertJobTelemetry(snapshot.telemetry, status);
  assertJobStageConsistency(status, stageKey);
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    sessionId,
    jobId,
    status,
    stageKey,
    stageLabel,
    proposal,
    errorCode,
    telemetry
  };
}

function assertJobTelemetry(
  value: unknown,
  jobStatus: AudioAlignmentJobStatus
): AlignmentBenchmarkJobTelemetry {
  const telemetry = requireRecord(value, "benchmark job telemetry");
  requireSchemaVersion(telemetry.schemaVersion, "benchmark job telemetry.schemaVersion");
  if (telemetry.clock !== "rust-std-instant-session-relative-v1") {
    throw new Error("invalid benchmark job telemetry.clock");
  }
  const startTickNs = requireCanonicalDecimalTick(
    telemetry.startTickNs,
    "benchmark job telemetry.startTickNs"
  );
  const terminal = isAlignmentBenchmarkJobFinished(jobStatus);
  const endTickNs =
    telemetry.endTickNs === null
      ? null
      : requireCanonicalDecimalTick(telemetry.endTickNs, "benchmark job telemetry.endTickNs");
  if (terminal !== (endTickNs !== null)) {
    throw new Error("invalid benchmark job terminal tick state");
  }
  if (endTickNs !== null) requireTickOrder(startTickNs, endTickNs, "benchmark job telemetry");
  const elapsedMs = requireNonNegativeFiniteNumber(
    telemetry.elapsedMs,
    "benchmark job telemetry.elapsedMs"
  );
  if (endTickNs !== null) {
    requireElapsedMatchesTicks(startTickNs, endTickNs, elapsedMs, "benchmark job telemetry");
  }
  const stages = assertStageTimings(telemetry.stages, startTickNs, endTickNs, jobStatus);
  const cache = assertCacheTelemetry(telemetry.cache);
  const memory = assertMemoryTelemetry(telemetry.memory, terminal);
  const cancellation = assertCancellationTelemetry(
    telemetry.cancellation,
    startTickNs,
    endTickNs,
    jobStatus
  );
  if (jobStatus === "cancelled" && cancellation === null) {
    throw new Error("invalid cancelled job without cancellation telemetry");
  }
  return {
    schemaVersion: ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION,
    clock: "rust-std-instant-session-relative-v1",
    startTickNs,
    endTickNs,
    elapsedMs,
    stages,
    cache,
    memory,
    cancellation
  };
}

function assertStageTimings(
  value: unknown,
  jobStartTickNs: string,
  jobEndTickNs: string | null,
  jobStatus: AudioAlignmentJobStatus
): AlignmentBenchmarkStageTiming[] {
  if (!Array.isArray(value) || value.length > MAX_STAGE_TIMINGS) {
    throw new Error("invalid benchmark job telemetry.stages");
  }
  const stages = value.map((stage, index) => assertStageTiming(stage, index));
  const occurrenceByStage = new Map<AudioAlignmentStageKey, number>();
  let previousEnd = jobStartTickNs;
  stages.forEach((stage, index) => {
    requireTickOrder(jobStartTickNs, stage.startTickNs, `stage ${index} job range`);
    requireTickOrder(previousEnd, stage.startTickNs, `stage ${index} ordering`);
    if (jobEndTickNs !== null) {
      requireTickOrder(stage.endTickNs, jobEndTickNs, `stage ${index} job range`);
    }
    const expectedOccurrence = (occurrenceByStage.get(stage.stageKey) ?? 0) + 1;
    if (stage.occurrence !== expectedOccurrence) {
      throw new Error(`invalid stage ${index} occurrence`);
    }
    occurrenceByStage.set(stage.stageKey, stage.occurrence);
    if (index < stages.length - 1 && stage.status !== "completed") {
      throw new Error(`invalid non-final stage ${index} status`);
    }
    previousEnd = stage.endTickNs;
  });
  const lastStage = stages.at(-1);
  if (lastStage) {
    if (isAlignmentBenchmarkJobFinished(jobStatus)) {
      if (lastStage.status !== jobStatus) throw new Error("invalid terminal stage status");
    } else if (lastStage.status !== "completed") {
      throw new Error("invalid in-flight stage status");
    }
  }
  return stages;
}

function assertStageTiming(value: unknown, index: number): AlignmentBenchmarkStageTiming {
  const path = `benchmark job telemetry.stages[${index}]`;
  const stage = requireRecord(value, path);
  const stageKey = requireEnum(stage.stageKey, STAGE_KEYS, `${path}.stageKey`);
  const occurrence = requirePositiveSafeInteger(stage.occurrence, `${path}.occurrence`);
  const startTickNs = requireCanonicalDecimalTick(stage.startTickNs, `${path}.startTickNs`);
  const endTickNs = requireCanonicalDecimalTick(stage.endTickNs, `${path}.endTickNs`);
  requireTickOrder(startTickNs, endTickNs, path);
  const elapsedMs = requireNonNegativeFiniteNumber(stage.elapsedMs, `${path}.elapsedMs`);
  requireElapsedMatchesTicks(startTickNs, endTickNs, elapsedMs, path);
  return {
    stageKey,
    occurrence,
    startTickNs,
    endTickNs,
    elapsedMs,
    status: requireEnum(stage.status, TERMINAL_JOB_STATUSES, `${path}.status`)
  };
}

function assertCacheTelemetry(value: unknown): AlignmentBenchmarkCacheTelemetry {
  const cache = requireRecord(value, "benchmark job telemetry.cache");
  return {
    generation: requireNonNegativeSafeInteger(
      cache.generation,
      "benchmark job telemetry.cache.generation"
    ),
    before: assertCacheCounts(cache.before, "benchmark job telemetry.cache.before"),
    after: assertCacheCounts(cache.after, "benchmark job telemetry.cache.after"),
    audioFeatures: assertCacheCounter(
      cache.audioFeatures,
      "benchmark job telemetry.cache.audioFeatures"
    ),
    landmarks: assertCacheCounter(cache.landmarks, "benchmark job telemetry.cache.landmarks"),
    visualFeatures: assertCacheCounter(
      cache.visualFeatures,
      "benchmark job telemetry.cache.visualFeatures"
    )
  };
}

function assertCacheCounts(value: unknown, path: string): AlignmentBenchmarkCacheCounts {
  const counts = requireRecord(value, path);
  return {
    audioFeatureEntries: requireBoundedNonNegativeSafeInteger(
      counts.audioFeatureEntries,
      `${path}.audioFeatureEntries`,
      MAX_CACHE_ENTRY_COUNT
    ),
    landmarkEntries: requireBoundedNonNegativeSafeInteger(
      counts.landmarkEntries,
      `${path}.landmarkEntries`,
      MAX_CACHE_ENTRY_COUNT
    ),
    visualFeatureEntries: requireBoundedNonNegativeSafeInteger(
      counts.visualFeatureEntries,
      `${path}.visualFeatureEntries`,
      MAX_CACHE_ENTRY_COUNT
    )
  };
}

function assertCacheCounter(value: unknown, path: string): AlignmentBenchmarkCacheCounter {
  const counter = requireRecord(value, path);
  return {
    hits: requireNonNegativeSafeInteger(counter.hits, `${path}.hits`),
    misses: requireNonNegativeSafeInteger(counter.misses, `${path}.misses`),
    writes: requireNonNegativeSafeInteger(counter.writes, `${path}.writes`),
    evictions: requireNonNegativeSafeInteger(counter.evictions, `${path}.evictions`)
  };
}

function assertMemoryTelemetry(
  value: unknown,
  terminal: boolean
): AlignmentBenchmarkMemoryTelemetry {
  const memory = requireRecord(value, "benchmark job telemetry.memory");
  if (memory.scope !== "application-process-tree") {
    throw new Error("invalid benchmark job telemetry.memory.scope");
  }
  const sampler = requireEnum(
    memory.sampler,
    MEMORY_SAMPLERS,
    "benchmark job telemetry.memory.sampler"
  );
  const sampleCount = requireNonNegativeSafeInteger(
    memory.sampleCount,
    "benchmark job telemetry.memory.sampleCount"
  );
  const failedSampleCount = requireNonNegativeSafeInteger(
    memory.failedSampleCount,
    "benchmark job telemetry.memory.failedSampleCount"
  );
  const peakProcessTreeRssBytes =
    memory.peakProcessTreeRssBytes === null
      ? null
      : requireNonNegativeSafeInteger(
          memory.peakProcessTreeRssBytes,
          "benchmark job telemetry.memory.peakProcessTreeRssBytes"
        );
  if ((sampleCount === 0) !== (peakProcessTreeRssBytes === null)) {
    throw new Error("invalid benchmark memory sample/peak relation");
  }
  const coverageComplete = requireBoolean(
    memory.coverageComplete,
    "benchmark job telemetry.memory.coverageComplete"
  );
  if (coverageComplete && (failedSampleCount !== 0 || sampler === "unsupported")) {
    throw new Error("invalid benchmark memory coverage state");
  }
  const processTreeEmptyAtTerminal = requireBoolean(
    memory.processTreeEmptyAtTerminal,
    "benchmark job telemetry.memory.processTreeEmptyAtTerminal"
  );
  const residualProcessCount = requireNonNegativeSafeInteger(
    memory.residualProcessCount,
    "benchmark job telemetry.memory.residualProcessCount"
  );
  if (terminal && processTreeEmptyAtTerminal !== (residualProcessCount === 0)) {
    throw new Error("invalid terminal process tree state");
  }
  return {
    scope: "application-process-tree",
    sampler,
    sampleIntervalMs: requireSampleInterval(
      memory.sampleIntervalMs,
      "benchmark job telemetry.memory.sampleIntervalMs"
    ),
    sampleCount,
    failedSampleCount,
    maximumSampleGapMs: requireNonNegativeFiniteNumber(
      memory.maximumSampleGapMs,
      "benchmark job telemetry.memory.maximumSampleGapMs"
    ),
    peakProcessTreeRssBytes,
    coverageComplete,
    processTreeEmptyAtTerminal,
    residualProcessCount
  };
}

function assertCancellationTelemetry(
  value: unknown,
  jobStartTickNs: string,
  jobEndTickNs: string | null,
  jobStatus: AudioAlignmentJobStatus
): AlignmentBenchmarkCancellationTelemetry | null {
  if (value === null) return null;
  const cancellation = requireRecord(value, "benchmark job telemetry.cancellation");
  const requestTickNs = requireCanonicalDecimalTick(
    cancellation.requestTickNs,
    "benchmark job telemetry.cancellation.requestTickNs"
  );
  requireTickOrder(jobStartTickNs, requestTickNs, "benchmark cancellation request");
  const latencyMs = requireNonNegativeFiniteNumber(
    cancellation.latencyMs,
    "benchmark job telemetry.cancellation.latencyMs"
  );
  const commandAccepted = requireBoolean(
    cancellation.commandAccepted,
    "benchmark job telemetry.cancellation.commandAccepted"
  );
  if (cancellation.terminalTickNs === "") {
    if (
      isAlignmentBenchmarkJobFinished(jobStatus) ||
      jobEndTickNs !== null ||
      latencyMs !== 0
    ) {
      throw new Error("invalid pending cancellation sentinel");
    }
    return { requestTickNs, terminalTickNs: "", latencyMs, commandAccepted };
  }
  const terminalTickNs = requireCanonicalDecimalTick(
    cancellation.terminalTickNs,
    "benchmark job telemetry.cancellation.terminalTickNs"
  );
  if (jobEndTickNs === null || terminalTickNs !== jobEndTickNs) {
    throw new Error("invalid cancellation terminal binding");
  }
  requireTickOrder(requestTickNs, terminalTickNs, "benchmark cancellation");
  requireElapsedMatchesTicks(
    requestTickNs,
    terminalTickNs,
    latencyMs,
    "benchmark cancellation"
  );
  return { requestTickNs, terminalTickNs, latencyMs, commandAccepted };
}

function assertProposalRecord(value: unknown): AlignmentProposal | null {
  if (value === null) return null;
  if (!isAlignmentProposalRecord(value)) throw new Error("invalid benchmark job proposal");
  return value;
}

function assertJobStageConsistency(
  status: AudioAlignmentJobStatus,
  stageKey: AudioAlignmentStageKey
): void {
  const expectedTerminalStage =
    status === "completed" || status === "failed" || status === "cancelled" ? status : null;
  if (expectedTerminalStage !== null && stageKey !== expectedTerminalStage) {
    throw new Error("invalid benchmark job terminal stage");
  }
  if (status === "queued" && stageKey !== "queued") {
    throw new Error("invalid queued benchmark job stage");
  }
}

function assertMatchingId(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("mismatched native response identifier");
}

function assertRunManifestShape(
  value: unknown
): asserts value is RealMediaBenchmarkRunManifest {
  const manifest = requireRecord(value, "blind run manifest");
  requireExactKeys(
    manifest,
    ["schemaVersion", "manifestId", "datasetVersion", "cases"],
    "blind run manifest"
  );
  if (manifest.schemaVersion !== 1) throw new Error("blind run manifest schema 无效。");
  requireNonBlankString(manifest.manifestId, "blind run manifest.manifestId");
  requireNonBlankString(manifest.datasetVersion, "blind run manifest.datasetVersion");
  if (!Array.isArray(manifest.cases)) throw new Error("blind run manifest cases 无效。");
  const caseIds = new Set<string>();
  manifest.cases.forEach((item, caseOrdinal) => {
    const benchmarkCase = requireRecord(item, `blind run manifest.cases[${caseOrdinal}]`);
    requireExactKeys(
      benchmarkCase,
      ["caseId", "source", "target"],
      `blind run manifest.cases[${caseOrdinal}]`
    );
    const caseId = requireNonBlankString(
      benchmarkCase.caseId,
      `blind run manifest.cases[${caseOrdinal}].caseId`
    );
    if (caseIds.has(caseId)) throw new Error("blind run manifest caseId 重复。");
    caseIds.add(caseId);
    assertRunManifestMediaInput(
      benchmarkCase.source,
      `blind run manifest.cases[${caseOrdinal}].source`
    );
    assertRunManifestMediaInput(
      benchmarkCase.target,
      `blind run manifest.cases[${caseOrdinal}].target`
    );
  });
}

function assertRunManifestMediaInput(value: unknown, path: string): void {
  const media = requireRecord(value, path);
  requireExactKeys(
    media,
    [
      "path",
      "audioStreamIndex",
      "videoStreamIndex",
      "contentIdentity",
      "versionNote",
      "licenseNote"
    ],
    path
  );
  requireNonBlankString(media.path, `${path}.path`);
  if (!Number.isSafeInteger(media.audioStreamIndex) || (media.audioStreamIndex as number) < 0) {
    throw new Error(`${path}.audioStreamIndex 无效。`);
  }
  if (
    media.videoStreamIndex !== null &&
    (!Number.isSafeInteger(media.videoStreamIndex) || (media.videoStreamIndex as number) < 0)
  ) {
    throw new Error(`${path}.videoStreamIndex 无效。`);
  }
  requireNonBlankString(media.versionNote, `${path}.versionNote`);
  requireNonBlankString(media.licenseNote, `${path}.licenseNote`);
  const identity = requireRecord(media.contentIdentity, `${path}.contentIdentity`);
  requireExactKeys(identity, ["algorithm", "sizeBytes", "digest"], `${path}.contentIdentity`);
  if (
    identity.algorithm !== "sha256-full-file-v2" ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    (identity.sizeBytes as number) < 0 ||
    typeof identity.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.digest)
  ) {
    throw new Error(`${path}.contentIdentity 无效。`);
  }
}

function requireNonBlankString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} 无效。`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const keys = Object.keys(value);
  const allowedKeys = new Set(allowed);
  if (keys.length !== allowed.length || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error(`invalid ${path} fields`);
  }
}

function requireBoundedUtf8(value: unknown, path: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`${path} 大小无效。`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 不接受 undefined、函数或 symbol。");
}

function requireSchemaVersion(value: unknown, path: string): void {
  if (value !== ALIGNMENT_BENCHMARK_NATIVE_SCHEMA_VERSION) {
    throw new Error(`invalid ${path}`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`invalid ${path}`);
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (!isOneOf(value, allowed)) throw new Error(`invalid ${path}`);
  return value;
}

function requireBoundedString(
  value: unknown,
  path: string,
  minimumLength: number,
  maximumLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireBoundedStringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumItemLength: number
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`invalid ${path}`);
  }
  return value.map((item, index) =>
    requireBoundedString(item, `${path}[${index}]`, 1, maximumItemLength)
  );
}

function requireOpaqueResponseId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireSha256Digest(value: unknown, path: string): `sha256:${string}` {
  if (!isSha256Digest(value)) throw new Error(`invalid ${path}`);
  return value;
}

function requireCanonicalDecimalTick(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,38})$/.test(value) ||
    BigInt(value) > MAX_U128
  ) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireTickOrder(startTickNs: string, endTickNs: string, path: string): void {
  if (BigInt(endTickNs) < BigInt(startTickNs)) throw new Error(`invalid ${path} tick order`);
}

function requireElapsedMatchesTicks(
  startTickNs: string,
  endTickNs: string,
  elapsedMs: number,
  path: string
): void {
  const elapsedNanoseconds = BigInt(endTickNs) - BigInt(startTickNs);
  const wholeMilliseconds = elapsedNanoseconds / 1_000_000n;
  if (wholeMilliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`invalid ${path} elapsed range`);
  }
  const expectedElapsedMs =
    Number(wholeMilliseconds) + Number(elapsedNanoseconds % 1_000_000n) / 1_000_000;
  const tolerance = Math.max(0.000_001, expectedElapsedMs * Number.EPSILON * 8);
  if (Math.abs(elapsedMs - expectedElapsedMs) > tolerance) {
    throw new Error(`invalid ${path} elapsed value`);
  }
}

function requireSampleInterval(value: unknown, path: string): number {
  const interval = requireNonNegativeSafeInteger(value, path);
  if (
    interval < ALIGNMENT_BENCHMARK_MIN_SAMPLE_INTERVAL_MS ||
    interval > ALIGNMENT_BENCHMARK_MAX_SAMPLE_INTERVAL_MS
  ) {
    throw new Error(`invalid ${path}`);
  }
  return interval;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  const integer = requireNonNegativeSafeInteger(value, path);
  if (integer === 0) throw new Error(`invalid ${path}`);
  return integer;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireBoundedNonNegativeSafeInteger(
  value: unknown,
  path: string,
  maximum: number
): number {
  const integer = requireNonNegativeSafeInteger(value, path);
  if (integer > maximum) throw new Error(`invalid ${path}`);
  return integer;
}

function requireNonNegativeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid ${path}`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${path}`);
  return value;
}

function areCachesEmpty(counts: AlignmentBenchmarkCacheCounts): boolean {
  return (
    counts.audioFeatureEntries === 0 &&
    counts.landmarkEntries === 0 &&
    counts.visualFeatureEntries === 0
  );
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isAlignmentProposalRecord(value: unknown): value is AlignmentProposal {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
