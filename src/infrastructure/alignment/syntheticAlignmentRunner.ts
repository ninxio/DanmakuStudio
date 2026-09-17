import {
  evaluateRealMediaBenchmark,
  parseRealMediaBenchmarkResultJson,
  validateRealMediaBenchmarkManifest,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkPrediction,
  type RealMediaBenchmarkResult
} from "../../domain/alignment/realMediaBenchmark";
import {
  isSpectralBackendPreference,
  type SpectralBackendPreference
} from "../../domain/alignment/spectralBackendPreference";
import { validateTimeMap } from "../../domain/alignment/timeMap";
import { sha256Hex } from "../../domain/shared/sha256";
import { createSyntheticManifestDigest } from "../../domain/alignment/syntheticAlignmentLabQueue";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentJob,
  type AudioAlignmentJobInvoker,
  type AudioAlignmentJobSnapshot
} from "./tauriAudioAlignment";

export interface SyntheticAlignmentRunCaseReceipt {
  caseId: string;
  state: "completed" | "failed" | "cancelled";
  nativeJobId: string | null;
  proposalAvailable: boolean;
  qualityLevel: string | null;
  engineVersion: string | null;
  featureVersion: string | null;
  parametersHash: string | null;
  failureCode: "start" | "poll" | "native-failed" | "missing-time-map" | "cancelled" | null;
}

export interface SyntheticAlignmentRunReport {
  schemaVersion: "alignment-synthetic-run-report-v2";
  manifestId: string;
  datasetVersion: string;
  manifestDigest: `sha256:${string}`;
  status: "completed" | "completed-with-failures" | "cancelled";
  startedAtMs: number;
  completedAtMs: number;
  configuration: {
    spectralBackend: SpectralBackendPreference;
    windowMs: number;
    minGapMs: number;
    matchThreshold: number;
    enableVisualEvidence: false;
    localizationMode: true;
  };
  caseReceipts: SyntheticAlignmentRunCaseReceipt[];
  /** Path-free production TimeMaps retained for same-query rule-only retrieval evaluation. */
  predictions: RealMediaBenchmarkPrediction[];
  result: RealMediaBenchmarkResult;
  releaseEligible: false;
  note: "programmatic-development-evidence-never-real-gold";
}

export interface SyntheticAlignmentRunnerOptions {
  ffmpegPath: string | null;
  ffprobePath?: string | null;
  spectralBackend: SpectralBackendPreference;
  windowMs: number;
  minGapMs: number;
  matchThreshold: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxCaseWallMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  invoker?: AudioAlignmentJobInvoker;
  onProgress?: (completed: number, total: number, caseId: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 300;
const DEFAULT_MAX_CASE_WALL_MS = 6 * 60 * 60 * 1_000;

export async function runSyntheticAlignmentManifest(
  manifest: RealMediaBenchmarkManifest,
  options: SyntheticAlignmentRunnerOptions
): Promise<SyntheticAlignmentRunReport> {
  assertSyntheticDevelopmentManifest(manifest);
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const invoker = options.invoker;
  const startedAtMs = now();
  const receipts: SyntheticAlignmentRunCaseReceipt[] = [];
  const predictions: RealMediaBenchmarkPrediction[] = [];
  let cancelled = false;

  for (const benchmarkCase of manifest.cases) {
    if (options.signal?.aborted) {
      cancelled = true;
      receipts.push(cancelledReceipt(benchmarkCase.id, null));
      break;
    }
    let snapshot: AudioAlignmentJobSnapshot;
    try {
      snapshot = await startTauriAudioAlignmentJob(
        {
          completePath: benchmarkCase.target.path,
          sourcePath: benchmarkCase.source.path,
          ffmpegPath: options.ffmpegPath,
          ffprobePath: options.ffprobePath ?? null,
          completeAudioStreamIndex: benchmarkCase.target.audioStreamIndex,
          sourceAudioStreamIndex: benchmarkCase.source.audioStreamIndex,
          completeVideoStreamIndex: benchmarkCase.target.videoStreamIndex,
          sourceVideoStreamIndex: benchmarkCase.source.videoStreamIndex,
          spectralBackend: options.spectralBackend,
          windowMs: options.windowMs,
          minGapMs: options.minGapMs,
          matchThreshold: options.matchThreshold,
          enableVisualEvidence: false,
          localizationMode: true
        },
        invoker
      );
    } catch {
      receipts.push(failedReceipt(benchmarkCase.id, null, "start"));
      options.onProgress?.(receipts.length, manifest.cases.length, benchmarkCase.id);
      continue;
    }
    const terminal = await waitForTerminalSnapshot(snapshot, options, invoker, now, wait);
    if (terminal.kind === "poll-failed") {
      receipts.push(failedReceipt(benchmarkCase.id, snapshot.jobId, "poll"));
    } else if (terminal.snapshot.status === "cancelled") {
      receipts.push(cancelledReceipt(benchmarkCase.id, terminal.snapshot.jobId));
      cancelled = true;
    } else if (terminal.snapshot.status !== "completed") {
      receipts.push(failedReceipt(benchmarkCase.id, terminal.snapshot.jobId, "native-failed"));
    } else if (!terminal.snapshot.proposal?.timeMap) {
      receipts.push(failedReceipt(benchmarkCase.id, terminal.snapshot.jobId, "missing-time-map"));
    } else {
      const timeMap = terminal.snapshot.proposal.timeMap;
      predictions.push({ caseId: benchmarkCase.id, spans: structuredClone(timeMap.spans) });
      receipts.push({
        caseId: benchmarkCase.id,
        state: "completed",
        nativeJobId: terminal.snapshot.jobId,
        proposalAvailable: true,
        qualityLevel: timeMap.quality.level,
        engineVersion: timeMap.engineVersion,
        featureVersion: timeMap.featureVersion,
        parametersHash: timeMap.parametersHash,
        failureCode: null
      });
    }
    options.onProgress?.(receipts.length, manifest.cases.length, benchmarkCase.id);
    if (cancelled) break;
  }

  return {
    schemaVersion: "alignment-synthetic-run-report-v2",
    manifestId: manifest.id,
    datasetVersion: manifest.datasetVersion,
    manifestDigest: createSyntheticManifestDigest(manifest),
    status: cancelled
      ? "cancelled"
      : receipts.some((receipt) => receipt.state === "failed")
        ? "completed-with-failures"
        : "completed",
    startedAtMs,
    completedAtMs: now(),
    configuration: {
      spectralBackend: options.spectralBackend,
      windowMs: options.windowMs,
      minGapMs: options.minGapMs,
      matchThreshold: options.matchThreshold,
      enableVisualEvidence: false,
      localizationMode: true
    },
    caseReceipts: receipts,
    predictions: structuredClone(predictions),
    result: evaluateRealMediaBenchmark(manifest, predictions),
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold"
  };
}

export function serializeSyntheticAlignmentRunReport(
  report: SyntheticAlignmentRunReport
): string {
  return `${JSON.stringify(parseSyntheticAlignmentRunReport(report), null, 2)}\n`;
}

export function parseSyntheticAlignmentRunReportJson(
  json: string
): SyntheticAlignmentRunReport {
  return parseSyntheticAlignmentRunReport(JSON.parse(json) as unknown);
}

export function parseSyntheticAlignmentRunReport(
  value: unknown
): SyntheticAlignmentRunReport {
  const record = requireRecord(value, "程序化详细报告");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "manifestId",
      "datasetVersion",
      "manifestDigest",
      "status",
      "startedAtMs",
      "completedAtMs",
      "configuration",
      "caseReceipts",
      "predictions",
      "result",
      "releaseEligible",
      "note"
    ],
    "程序化详细报告"
  );
  if (record.schemaVersion !== "alignment-synthetic-run-report-v2") {
    throw new Error("程序化详细报告 schemaVersion 不受支持。");
  }
  if (
    record.releaseEligible !== false ||
    record.note !== "programmatic-development-evidence-never-real-gold"
  ) {
    throw new Error("程序化详细报告的开发证据边界无效。");
  }
  const manifestId = requireIdentifier(record.manifestId, "manifestId");
  const datasetVersion = requireIdentifier(record.datasetVersion, "datasetVersion");
  const manifestDigest = requireDigest(record.manifestDigest, "manifestDigest");
  const status = requireReportStatus(record.status);
  const startedAtMs = requireTimestamp(record.startedAtMs, "startedAtMs");
  const completedAtMs = requireTimestamp(record.completedAtMs, "completedAtMs");
  if (completedAtMs < startedAtMs) throw new Error("程序化详细报告完成时间早于开始时间。");
  const configuration = parseConfiguration(record.configuration);
  const caseReceipts = requireArray(record.caseReceipts, "caseReceipts").map(parseCaseReceipt);
  if (caseReceipts.length === 0 || caseReceipts.length > 256) {
    throw new Error("程序化详细报告必须包含 1–256 个 case 回执。");
  }
  assertUnique(caseReceipts.map((item) => item.caseId), "程序化详细报告包含重复 case 回执。");
  const predictions = requireArray(record.predictions, "predictions").map(parsePrediction);
  if (predictions.length > 256) throw new Error("程序化详细报告预测数超过 256。" );
  assertUnique(predictions.map((item) => item.caseId), "程序化详细报告包含重复预测。");
  const completedCaseIds = new Set(
    caseReceipts.filter((item) => item.state === "completed").map((item) => item.caseId)
  );
  const predictionCaseIds = new Set(predictions.map((item) => item.caseId));
  if (
    completedCaseIds.size !== predictionCaseIds.size ||
    [...completedCaseIds].some((caseId) => !predictionCaseIds.has(caseId))
  ) {
    throw new Error("程序化详细报告的完成回执与 TimeMap 预测不一致。");
  }
  const failedCount = caseReceipts.filter((item) => item.state === "failed").length;
  const cancelledCount = caseReceipts.filter((item) => item.state === "cancelled").length;
  if (
    (status === "completed" && (failedCount > 0 || cancelledCount > 0)) ||
    (status === "completed-with-failures" && failedCount === 0) ||
    (status === "cancelled" && cancelledCount === 0)
  ) {
    throw new Error("程序化详细报告状态与 case 回执不一致。");
  }
  const result = parseRealMediaBenchmarkResultJson(JSON.stringify(record.result));
  if (result.manifestId !== manifestId || result.datasetVersion !== datasetVersion) {
    throw new Error("程序化详细报告与评测结果身份不一致。");
  }
  const resultCaseIds = new Set(result.caseResults.map((item) => item.caseId));
  if ([...predictionCaseIds].some((caseId) => !resultCaseIds.has(caseId))) {
    throw new Error("程序化详细报告预测不属于评测结果 case。");
  }
  return {
    schemaVersion: "alignment-synthetic-run-report-v2",
    manifestId,
    datasetVersion,
    manifestDigest,
    status,
    startedAtMs,
    completedAtMs,
    configuration,
    caseReceipts,
    predictions,
    result,
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold"
  };
}

export function createSyntheticAlignmentRunReportId(
  report: SyntheticAlignmentRunReport
): `sha256:${string}` {
  const checked = parseSyntheticAlignmentRunReport(report);
  return `sha256:${sha256Hex(`danmaku-studio/synthetic-run-report/v2\n${canonicalJson(checked)}`)}`;
}

function assertSyntheticDevelopmentManifest(manifest: RealMediaBenchmarkManifest): void {
  const validation = validateRealMediaBenchmarkManifest(manifest);
  if (!validation.valid) {
    throw new Error(`程序化变体 manifest 无效：${validation.issues.join("；")}`);
  }
  if (manifest.isExample || manifest.cases.length === 0 || manifest.cases.length > 256) {
    throw new Error("程序化变体 manifest 必须包含 1–256 个可执行 case，且不能是示例。");
  }
  if (
    manifest.cases.some(
      (benchmarkCase) =>
        benchmarkCase.mediaKind !== "synthetic" || benchmarkCase.split !== "development"
    )
  ) {
    throw new Error("程序化变体运行只接受 synthetic/development，不能读取真实或冻结 Gold。");
  }
}

async function waitForTerminalSnapshot(
  initial: AudioAlignmentJobSnapshot,
  options: SyntheticAlignmentRunnerOptions,
  invoker: AudioAlignmentJobInvoker | undefined,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>
): Promise<
  | { kind: "terminal"; snapshot: AudioAlignmentJobSnapshot }
  | { kind: "poll-failed" }
> {
  let snapshot = initial;
  const startedAt = now();
  while (!isAudioAlignmentJobFinished(snapshot.status)) {
    if (options.signal?.aborted || now() - startedAt > (options.maxCaseWallMs ?? DEFAULT_MAX_CASE_WALL_MS)) {
      try {
        snapshot = await cancelTauriAudioAlignmentJob(snapshot.jobId, invoker);
      } catch {
        return { kind: "poll-failed" };
      }
    }
    if (isAudioAlignmentJobFinished(snapshot.status)) break;
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    // Do not issue one more expensive poll after the user cancelled during the wait interval.
    // Re-enter the loop so cancellation is sent to the native job immediately.
    if (options.signal?.aborted) continue;
    try {
      snapshot = await getTauriAudioAlignmentJob(snapshot.jobId, invoker);
    } catch {
      return { kind: "poll-failed" };
    }
  }
  return { kind: "terminal", snapshot };
}

function failedReceipt(
  caseId: string,
  nativeJobId: string | null,
  failureCode: Exclude<SyntheticAlignmentRunCaseReceipt["failureCode"], "cancelled" | null>
): SyntheticAlignmentRunCaseReceipt {
  return {
    caseId,
    state: "failed",
    nativeJobId,
    proposalAvailable: false,
    qualityLevel: null,
    engineVersion: null,
    featureVersion: null,
    parametersHash: null,
    failureCode
  };
}

function cancelledReceipt(
  caseId: string,
  nativeJobId: string | null
): SyntheticAlignmentRunCaseReceipt {
  return {
    caseId,
    state: "cancelled",
    nativeJobId,
    proposalAvailable: false,
    qualityLevel: null,
    engineVersion: null,
    featureVersion: null,
    parametersHash: null,
    failureCode: "cancelled"
  };
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function parseConfiguration(
  value: unknown
): SyntheticAlignmentRunReport["configuration"] {
  const record = requireRecord(value, "程序化详细报告 configuration");
  requireExactKeys(
    record,
    [
      "spectralBackend",
      "windowMs",
      "minGapMs",
      "matchThreshold",
      "enableVisualEvidence",
      "localizationMode"
    ],
    "程序化详细报告 configuration"
  );
  if (!isSpectralBackendPreference(record.spectralBackend)) {
    throw new Error("程序化详细报告 spectralBackend 无效。");
  }
  if (record.enableVisualEvidence !== false || record.localizationMode !== true) {
    throw new Error("程序化详细报告不符合 audio-only 本地化运行边界。");
  }
  return {
    spectralBackend: record.spectralBackend,
    windowMs: requirePositiveInteger(record.windowMs, "windowMs"),
    minGapMs: requireNonNegativeInteger(record.minGapMs, "minGapMs"),
    matchThreshold: requireUnitFinite(record.matchThreshold, "matchThreshold"),
    enableVisualEvidence: false,
    localizationMode: true
  };
}

function parseCaseReceipt(value: unknown): SyntheticAlignmentRunCaseReceipt {
  const record = requireRecord(value, "程序化详细报告 case 回执");
  requireExactKeys(
    record,
    [
      "caseId",
      "state",
      "nativeJobId",
      "proposalAvailable",
      "qualityLevel",
      "engineVersion",
      "featureVersion",
      "parametersHash",
      "failureCode"
    ],
    "程序化详细报告 case 回执"
  );
  const state = record.state;
  if (state !== "completed" && state !== "failed" && state !== "cancelled") {
    throw new Error("程序化详细报告 case 状态无效。");
  }
  if (typeof record.proposalAvailable !== "boolean") {
    throw new Error("程序化详细报告 proposalAvailable 无效。");
  }
  const proposalAvailable = record.proposalAvailable;
  const failureCode = record.failureCode;
  if (
    failureCode !== null &&
    failureCode !== "start" &&
    failureCode !== "poll" &&
    failureCode !== "native-failed" &&
    failureCode !== "missing-time-map" &&
    failureCode !== "cancelled"
  ) {
    throw new Error("程序化详细报告 failureCode 无效。");
  }
  if (
    (state === "completed" && (!proposalAvailable || failureCode !== null)) ||
    (state === "failed" && (proposalAvailable || failureCode === null || failureCode === "cancelled")) ||
    (state === "cancelled" && (proposalAvailable || failureCode !== "cancelled"))
  ) {
    throw new Error("程序化详细报告 case 状态、候选与失败码不一致。");
  }
  return {
    caseId: requireIdentifier(record.caseId, "caseId"),
    state,
    nativeJobId: requireNullableIdentifier(record.nativeJobId, "nativeJobId"),
    proposalAvailable,
    qualityLevel: requireNullableIdentifier(record.qualityLevel, "qualityLevel"),
    engineVersion: requireNullableIdentifier(record.engineVersion, "engineVersion"),
    featureVersion: requireNullableIdentifier(record.featureVersion, "featureVersion"),
    parametersHash: requireNullableIdentifier(record.parametersHash, "parametersHash"),
    failureCode
  };
}

function parsePrediction(value: unknown): RealMediaBenchmarkPrediction {
  const record = requireRecord(value, "程序化详细报告预测");
  requireExactKeys(record, ["caseId", "spans"], "程序化详细报告预测");
  if (!Array.isArray(record.spans)) throw new Error("程序化详细报告预测缺少 spans。" );
  const spans: unknown = structuredClone(record.spans);
  const validation = validateTimeMap(spans as RealMediaBenchmarkPrediction["spans"]);
  if (!validation.valid) {
    throw new Error(`程序化详细报告 TimeMap 无效：${validation.issues.map((item) => item.message).join("；")}`);
  }
  return {
    caseId: requireIdentifier(record.caseId, "prediction.caseId"),
    spans: spans as RealMediaBenchmarkPrediction["spans"]
  };
}

function requireReportStatus(value: unknown): SyntheticAlignmentRunReport["status"] {
  if (value === "completed" || value === "completed-with-failures" || value === "cancelled") {
    return value;
  }
  throw new Error("程序化详细报告状态无效。");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > 512 ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
  ) {
    throw new Error(`${label} 无效。`);
  }
  return value.trim();
}

function requireNullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : requireIdentifier(value, label);
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负整数毫秒。`);
  }
  return Number(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负安全整数。`);
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, label: string): number {
  const result = requireNonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} 必须是正整数。`);
  return result;
}

function requireUnitFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} 必须位于 0–1。`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 SHA-256 摘要。`);
  }
  return value as `sha256:${string}`;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不完整或包含未知字段。`);
  }
}

function assertUnique(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
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
