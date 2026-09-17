import {
  evaluateRealMediaBenchmark,
  validateRealMediaBenchmarkResult,
  type RealMediaBenchmarkContentIdentity,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput,
  type RealMediaBenchmarkPrediction,
  type RealMediaBenchmarkResult
} from "../../domain/alignment/realMediaBenchmark";
import { sha256Hex } from "../../domain/shared/sha256";
import type {
  AlignmentProposal,
  AlignmentTimeMapStreamIdentity
} from "../../domain/alignment/types";
import type { MediaContentIdentity } from "../../domain/project/types";
import type { SpectralBackendPreference } from "../../domain/alignment/spectralBackendPreference";
import {
  preflightRealMediaBenchmark,
  type RealMediaBenchmarkPreflightIssue,
  type RealMediaBenchmarkPreflightOptions,
  type RealMediaBenchmarkPreflightResult
} from "./realMediaBenchmarkPreflight";
import {
  cancelTauriAudioAlignmentJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  startTauriAudioAlignmentJob,
  normalizeTauriSpectralBackendPreference,
  type AudioAlignmentJobInvoker,
  type AudioAlignmentJobSnapshot,
  type TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";
import { discloseKnownAlignmentFailure } from "./safeAlignmentFailureDisclosure";
import { containsSensitiveText, redactSensitiveText } from "./sensitiveTextRedaction";

export const REAL_MEDIA_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_BENCHMARK_RUN_REPORT_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_BENCHMARK_RUNNER_VERSION = "c137-manifest-v2-production-job-v1";

export interface RealMediaBenchmarkBlindCase {
  caseId: string;
  source: RealMediaBenchmarkMediaInput;
  target: RealMediaBenchmarkMediaInput;
}

/**
 * Execution-only projection. It deliberately excludes gold, split, reviewers, adjudication and
 * scenario labels so the production analyzer cannot inspect frozen answers.
 */
export interface RealMediaBenchmarkRunManifest {
  schemaVersion: typeof REAL_MEDIA_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION;
  manifestId: string;
  datasetVersion: string;
  cases: RealMediaBenchmarkBlindCase[];
}

export type RealMediaBenchmarkCaseRunStatus = "success" | "failed" | "cancelled";
export type RealMediaBenchmarkRunStatus =
  | "insufficient-data"
  | "preflight-failed"
  | "completed"
  | "completed-with-errors"
  | "cancelled";

export type RealMediaBenchmarkCaseFailureCode =
  | "preflight-failed"
  | "job-start-failed"
  | "job-read-failed"
  | "job-reported-failure"
  | "job-timeout"
  | "cancellation-failed"
  | "cancellation-timeout"
  | "run-cancelled"
  | "missing-time-map"
  | "not-alignment-v2"
  | "identity-mismatch"
  | "stream-mismatch";

export interface RealMediaBenchmarkCaseFailure {
  code: RealMediaBenchmarkCaseFailureCode;
  message: string;
}

export interface RealMediaBenchmarkParameterSummary {
  localizationMode: true;
  spectralBackend: SpectralBackendPreference;
  sampleRate: number | null;
  windowMs: number | null;
  matchThreshold: number | null;
  minGapMs: number | null;
  maxCells: number | null;
  enableVisualEvidence: boolean;
  visualSampleIntervalMs: number | null;
  sourceAudioStreamIndex: number;
  targetAudioStreamIndex: number;
  sourceVideoStreamIndex: number | null;
  targetVideoStreamIndex: number | null;
}

export interface RealMediaBenchmarkCaseRunResult {
  caseId: string;
  status: RealMediaBenchmarkCaseRunStatus;
  wallElapsedMs: number;
  engineVersion: string | null;
  featureVersion: string | null;
  qualityLevel: string | null;
  sourceVisualStreamIndex: number | null;
  targetVisualStreamIndex: number | null;
  parameters: RealMediaBenchmarkParameterSummary;
  failure: RealMediaBenchmarkCaseFailure | null;
}

export interface RealMediaBenchmarkRunReport {
  schemaVersion: typeof REAL_MEDIA_BENCHMARK_RUN_REPORT_SCHEMA_VERSION;
  reportKind: "c137-real-media-benchmark-run";
  scope: "time-map-component";
  releaseEligible: false;
  runnerVersion: typeof REAL_MEDIA_BENCHMARK_RUNNER_VERSION;
  manifestId: string;
  datasetVersion: string;
  runManifestDigest: string;
  status: RealMediaBenchmarkRunStatus;
  wallElapsedMs: number;
  skippedNonRealCaseCount: number;
  preflight: RealMediaBenchmarkPreflightResult;
  cases: RealMediaBenchmarkCaseRunResult[];
  evaluation: RealMediaBenchmarkResult | null;
  reasons: string[];
}

export interface RealMediaBenchmarkRunReportValidationResult {
  valid: boolean;
  issues: string[];
}

export interface RealMediaBenchmarkRunnerOptions {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  spectralBackend?: SpectralBackendPreference;
  sampleRate?: number;
  windowMs?: number;
  matchThreshold?: number;
  minGapMs?: number;
  maxCells?: number;
  enableVisualEvidence?: boolean;
  visualSampleIntervalMs?: number;
  pollIntervalMs?: number;
  maxJobWallMs?: number;
  cancellationGraceMs?: number;
  signal?: AbortSignal;
  preflightOptions?: Omit<RealMediaBenchmarkPreflightOptions, "ffmpegPath" | "ffprobePath">;
  alignmentInvoker?: AudioAlignmentJobInvoker;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface RealMediaBenchmarkBlindPreflightReceipt {
  schemaVersion: 1;
  runManifestDigest: string;
  preflight: RealMediaBenchmarkPreflightResult;
}

export interface RealMediaBenchmarkBlindRunReceipt {
  schemaVersion: 1;
  receiptKind: "c137-real-media-benchmark-blind-run";
  runManifestDigest: string;
  manifestId: string;
  datasetVersion: string;
  cases: RealMediaBenchmarkCaseRunResult[];
  predictions: RealMediaBenchmarkPrediction[];
}

interface CaseExecutionResult {
  result: RealMediaBenchmarkCaseRunResult;
  prediction: RealMediaBenchmarkPrediction | null;
}

interface ExecutionDependencies {
  options: RealMediaBenchmarkRunnerOptions;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_JOB_WALL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CANCELLATION_GRACE_MS = 30_000;
const CASE_FAILURE_CODES = new Set<RealMediaBenchmarkCaseFailureCode>([
  "preflight-failed",
  "job-start-failed",
  "job-read-failed",
  "job-reported-failure",
  "job-timeout",
  "cancellation-failed",
  "cancellation-timeout",
  "run-cancelled",
  "missing-time-map",
  "not-alignment-v2",
  "identity-mismatch",
  "stream-mismatch"
]);

export function projectRealMediaBenchmarkRunManifest(
  manifest: RealMediaBenchmarkManifest
): RealMediaBenchmarkRunManifest {
  return {
    schemaVersion: REAL_MEDIA_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION,
    manifestId: manifest.id,
    datasetVersion: manifest.datasetVersion,
    cases: manifest.cases
      .filter((benchmarkCase) => benchmarkCase.mediaKind === "real")
      .map((benchmarkCase) => ({
        caseId: benchmarkCase.id,
        source: cloneMediaInput(benchmarkCase.source),
        target: cloneMediaInput(benchmarkCase.target)
      }))
  };
}

export function createRealMediaBenchmarkRunManifestDigest(
  manifest: RealMediaBenchmarkRunManifest
): string {
  return `sha256:${sha256Hex(canonicalJson(manifest))}`;
}

export function createRealMediaBenchmarkBlindPreflightReceipt(
  manifest: RealMediaBenchmarkRunManifest,
  preflight: RealMediaBenchmarkPreflightResult
): RealMediaBenchmarkBlindPreflightReceipt {
  const manifestValidation = validateRealMediaBenchmarkRunManifest(manifest);
  if (!manifestValidation.valid) {
    throw new Error(`blind run manifest 无效：${manifestValidation.issues.join("；")}`);
  }
  if (
    !preflight.ok ||
    !isPreflightResult(preflight) ||
    preflight.issues.length > 0 ||
    preflight.realRelationCount !== manifest.cases.length
  ) {
    throw new Error("blind run preflight 未通过，不能创建执行凭据。");
  }
  return {
    schemaVersion: 1,
    runManifestDigest: createRealMediaBenchmarkRunManifestDigest(manifest),
    preflight: {
      ...preflight,
      issues: preflight.issues.map((issue) => ({ ...issue }))
    }
  };
}

/**
 * End-to-end coordinator: validate and preflight the governed manifest, execute only its blind
 * real-media projection through the production Tauri job API, then reveal gold to the evaluator
 * only after every real case succeeded.
 */
export async function runRealMediaBenchmarkManifest(
  manifest: RealMediaBenchmarkManifest,
  options: RealMediaBenchmarkRunnerOptions = {}
): Promise<RealMediaBenchmarkRunReport> {
  if (
    manifest.cases.some(
      (benchmarkCase) =>
        benchmarkCase.mediaKind === "real" && benchmarkCase.split === "frozen-test"
    )
  ) {
    throw new Error(
      "formal frozen-test 缺少可验证的外部签名与撤销 authority；当前 runner 仅接受 development。"
    );
  }
  const now = options.now ?? defaultNow;
  const wait = options.wait ?? defaultWait;
  const startedAt = now();
  const sanitize = createManifestSanitizer(manifest);
  const runManifest = projectRealMediaBenchmarkRunManifest(manifest);
  const skippedNonRealCaseCount = manifest.cases.length - runManifest.cases.length;
  let preflight: RealMediaBenchmarkPreflightResult;
  try {
    preflight = await preflightRealMediaBenchmark(manifest, {
      ...options.preflightOptions,
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath
    });
  } catch {
    preflight = {
      ok: false,
      realRelationCount: runManifest.cases.length,
      checkedFileCount: 0,
      issues: [
        {
          caseId: null,
          side: null,
          code: "probe-failed",
          message: "运行前核验异常；原始工具错误已从可分享报告移除。"
        }
      ]
    };
  }
  preflight = sanitizePreflight(preflight, sanitize);

  if (!preflight.ok) {
    return finalizeReport(
      createBaseReport({
        manifest,
        status: "preflight-failed",
        wallElapsedMs: elapsedMs(startedAt, now()),
        skippedNonRealCaseCount,
        preflight,
        cases: runManifest.cases.map((benchmarkCase) =>
          createNonSuccessCaseResult(
            benchmarkCase,
            "failed",
            0,
            "preflight-failed",
            "运行前身份或显式流核验未通过；未启动生产分析。",
            options
          )
        ),
        evaluation: null,
        reasons: ["运行前身份或显式流核验失败；所有真实媒体任务均保持未启动。"]
      }),
      manifest
    );
  }

  if (runManifest.cases.length === 0) {
    return finalizeReport(
      createBaseReport({
        manifest,
        status: "insufficient-data",
        wallElapsedMs: elapsedMs(startedAt, now()),
        skippedNonRealCaseCount,
        preflight,
        cases: [],
        evaluation: null,
        reasons: ["manifest 未包含任何 mediaKind=real 关系；未启动分析，也没有生成质量结论。"]
      }),
      manifest
    );
  }

  const receipt = await runRealMediaBenchmarkBlindManifest(
    runManifest,
    createRealMediaBenchmarkBlindPreflightReceipt(runManifest, preflight),
    { ...options, now, wait }
  );
  const expectedDigest = createRealMediaBenchmarkRunManifestDigest(runManifest);
  if (receipt.runManifestDigest !== expectedDigest) {
    throw new Error("真实媒体 benchmark blind manifest 在执行期间发生变化，拒绝评估。");
  }
  const hasCancelled = receipt.cases.some((item) => item.status === "cancelled");
  const hasFailed = receipt.cases.some((item) => item.status === "failed");
  let status: RealMediaBenchmarkRunStatus;
  if (hasCancelled) {
    status = "cancelled";
  } else if (hasFailed) {
    status = "completed-with-errors";
  } else {
    status = "completed";
  }

  // A failed/cancelled job is an execution failure, not a missing prediction. Never feed a
  // partial prediction set to the quality evaluator.
  const evaluation =
    status === "completed"
      ? evaluateRealMediaBenchmarkBlindRunReceipt(manifest, receipt)
      : null;
  const reasons =
    status === "completed"
      ? ["全部真实关系完成生产 Alignment V2 分析与组件级评估；该报告不代表 release 验收通过。"]
      : status === "cancelled"
        ? ["运行被取消；部分或全部关系没有质量结果，evaluation 保持 null。"]
        : ["至少一个生产分析任务失败；失败未伪装成 missing prediction，evaluation 保持 null。"];
  return finalizeReport(
    createBaseReport({
      manifest,
      status,
      wallElapsedMs: elapsedMs(startedAt, now()),
      skippedNonRealCaseCount,
      preflight,
      cases: receipt.cases,
      evaluation,
      reasons
    }),
    manifest
  );
}

/** Production execution entry for a process that receives no gold or reviewer metadata. */
export async function runRealMediaBenchmarkBlindManifest(
  manifest: RealMediaBenchmarkRunManifest,
  preflightReceipt: RealMediaBenchmarkBlindPreflightReceipt,
  options: RealMediaBenchmarkRunnerOptions = {}
): Promise<RealMediaBenchmarkBlindRunReceipt> {
  const validation = validateRealMediaBenchmarkRunManifest(manifest);
  if (!validation.valid) {
    throw new Error(`blind run manifest 无效：${validation.issues.join("；")}`);
  }
  const digest = createRealMediaBenchmarkRunManifestDigest(manifest);
  if (
    preflightReceipt.schemaVersion !== 1 ||
    !preflightReceipt.preflight.ok ||
    !isPreflightResult(preflightReceipt.preflight) ||
    preflightReceipt.preflight.issues.length > 0 ||
    preflightReceipt.preflight.realRelationCount !== manifest.cases.length ||
    preflightReceipt.runManifestDigest !== digest
  ) {
    throw new Error("blind run manifest 与 preflight 凭据不一致，拒绝启动生产分析。");
  }
  const now = options.now ?? defaultNow;
  const wait = options.wait ?? defaultWait;
  return executeBlindRunManifest(manifest, {
    options,
    now,
    wait
  });
}

/** Gold is revealed only here, after the blind receipt proves every real case succeeded. */
export function evaluateRealMediaBenchmarkBlindRunReceipt(
  manifest: RealMediaBenchmarkManifest,
  receipt: RealMediaBenchmarkBlindRunReceipt
): RealMediaBenchmarkResult {
  const runManifest = projectRealMediaBenchmarkRunManifest(manifest);
  const expectedDigest = createRealMediaBenchmarkRunManifestDigest(runManifest);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== "c137-real-media-benchmark-blind-run" ||
    receipt.manifestId !== runManifest.manifestId ||
    receipt.datasetVersion !== runManifest.datasetVersion ||
    receipt.runManifestDigest !== expectedDigest
  ) {
    throw new Error("blind run receipt 与 gold manifest 的执行投影不一致，拒绝评估。");
  }
  if (
    receipt.cases.length !== runManifest.cases.length ||
    receipt.cases.some((item) => item.status !== "success") ||
    receipt.predictions.length !== runManifest.cases.length
  ) {
    throw new Error(
      "blind run 未全部成功；失败或取消不得作为 missing prediction 参与质量评估。"
    );
  }
  const expectedCaseIds = runManifest.cases.map((item) => item.caseId);
  if (
    receipt.cases.some((item, index) => item.caseId !== expectedCaseIds[index]) ||
    receipt.predictions.some((item, index) => item.caseId !== expectedCaseIds[index])
  ) {
    throw new Error("blind run receipt 的 case/prediction 顺序或身份与执行投影不一致。");
  }
  return evaluateRealMediaBenchmark(
    {
      ...manifest,
      cases: manifest.cases.filter((benchmarkCase) => benchmarkCase.mediaKind === "real")
    },
    receipt.predictions
  );
}

async function executeBlindRunManifest(
  manifest: RealMediaBenchmarkRunManifest,
  dependencies: ExecutionDependencies
): Promise<RealMediaBenchmarkBlindRunReceipt> {
  const digest = createRealMediaBenchmarkRunManifestDigest(manifest);
  const cases: RealMediaBenchmarkCaseRunResult[] = [];
  const predictions: RealMediaBenchmarkPrediction[] = [];
  let unsafeToContinue = false;
  for (const benchmarkCase of manifest.cases) {
    if (unsafeToContinue || dependencies.options.signal?.aborted) {
      cases.push(
        createNonSuccessCaseResult(
          benchmarkCase,
          "cancelled",
          0,
          "run-cancelled",
          "运行已取消；该关系未启动。",
          dependencies.options
        )
      );
      continue;
    }
    const execution = await executeBlindCase(benchmarkCase, dependencies);
    cases.push(execution.result);
    if (execution.prediction) predictions.push(execution.prediction);
    if (
      execution.result.failure?.code === "cancellation-timeout" ||
      execution.result.failure?.code === "cancellation-failed"
    ) {
      unsafeToContinue = true;
    }
  }
  return {
    schemaVersion: 1,
    receiptKind: "c137-real-media-benchmark-blind-run",
    runManifestDigest: digest,
    manifestId: manifest.manifestId,
    datasetVersion: manifest.datasetVersion,
    cases,
    predictions
  };
}

async function executeBlindCase(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  dependencies: ExecutionDependencies
): Promise<CaseExecutionResult> {
  const { options, now, wait } = dependencies;
  const startedAt = now();
  const request = createRealMediaBenchmarkAlignmentRequest(benchmarkCase, options);
  let snapshot: AudioAlignmentJobSnapshot;
  try {
    snapshot = await startTauriAudioAlignmentJob(request, options.alignmentInvoker);
  } catch (error: unknown) {
    const disclosure = discloseKnownAlignmentFailure(error);
    return failedExecution(
      benchmarkCase,
      elapsedMs(startedAt, now()),
      "job-start-failed",
      disclosure?.message ?? "生产 Alignment V2 任务启动失败；原始工具错误已从可分享报告移除。",
      options
    );
  }

  while (!isAudioAlignmentJobFinished(snapshot.status)) {
    if (options.signal?.aborted) {
      return cancelActiveCase(benchmarkCase, snapshot.jobId, startedAt, dependencies);
    }
    if (elapsedMs(startedAt, now()) >= (options.maxJobWallMs ?? DEFAULT_MAX_JOB_WALL_MS)) {
      return cancelTimedOutCase(benchmarkCase, snapshot.jobId, startedAt, dependencies);
    }
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    try {
      snapshot = await getTauriAudioAlignmentJob(snapshot.jobId, options.alignmentInvoker);
    } catch {
      return failedExecution(
        benchmarkCase,
        elapsedMs(startedAt, now()),
        "job-read-failed",
        "生产 Alignment V2 任务状态读取失败；原始工具错误已从可分享报告移除。",
        options
      );
    }
  }
  return finalizeTerminalSnapshot(benchmarkCase, snapshot, startedAt, dependencies);
}

async function cancelTimedOutCase(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  jobId: string,
  startedAt: number,
  dependencies: ExecutionDependencies
): Promise<CaseExecutionResult> {
  const { options, now, wait } = dependencies;
  let snapshot: AudioAlignmentJobSnapshot;
  try {
    snapshot = await cancelTauriAudioAlignmentJob(jobId, options.alignmentInvoker);
  } catch {
    return failedExecution(
      benchmarkCase,
      elapsedMs(startedAt, now()),
      "cancellation-timeout",
      "生产任务超过 wall elapsed，且取消请求未能确认；已停止后续 case。",
      options
    );
  }
  const cancellationStartedAt = now();
  while (!isAudioAlignmentJobFinished(snapshot.status)) {
    if (
      elapsedMs(cancellationStartedAt, now()) >=
      (options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS)
    ) {
      return failedExecution(
        benchmarkCase,
        elapsedMs(startedAt, now()),
        "cancellation-timeout",
        "生产任务超过 wall elapsed，取消后仍未安全退出；已停止后续 case。",
        options
      );
    }
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    try {
      snapshot = await getTauriAudioAlignmentJob(jobId, options.alignmentInvoker);
    } catch {
      return failedExecution(
        benchmarkCase,
        elapsedMs(startedAt, now()),
        "cancellation-timeout",
        "生产任务超过 wall elapsed，且无法确认取消后的真实终态；已停止后续 case。",
        options
      );
    }
  }
  return failedExecution(
    benchmarkCase,
    elapsedMs(startedAt, now()),
    "job-timeout",
    `生产任务超过 wall elapsed，已确认安全退出终态：${snapshot.status}。`,
    options
  );
}

async function cancelActiveCase(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  jobId: string,
  startedAt: number,
  dependencies: ExecutionDependencies
): Promise<CaseExecutionResult> {
  const { options, now, wait } = dependencies;
  let snapshot: AudioAlignmentJobSnapshot;
  try {
    snapshot = await cancelTauriAudioAlignmentJob(jobId, options.alignmentInvoker);
  } catch {
    return failedExecution(
      benchmarkCase,
      elapsedMs(startedAt, now()),
      "cancellation-failed",
      "生产 Alignment V2 任务取消失败；原始工具错误已从可分享报告移除。",
      options
    );
  }
  const cancellationStartedAt = now();
  while (!isAudioAlignmentJobFinished(snapshot.status)) {
    if (
      elapsedMs(cancellationStartedAt, now()) >=
      (options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS)
    ) {
      return failedExecution(
        benchmarkCase,
        elapsedMs(startedAt, now()),
        "cancellation-timeout",
        "已请求取消，但生产任务未在安全退出宽限期内变为终态。",
        options
      );
    }
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    try {
      snapshot = await getTauriAudioAlignmentJob(jobId, options.alignmentInvoker);
    } catch {
      return failedExecution(
        benchmarkCase,
        elapsedMs(startedAt, now()),
        "job-read-failed",
        "取消后的生产任务状态读取失败；原始工具错误已从可分享报告移除。",
        options
      );
    }
  }
  return finalizeTerminalSnapshot(benchmarkCase, snapshot, startedAt, dependencies);
}

function finalizeTerminalSnapshot(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  snapshot: AudioAlignmentJobSnapshot,
  startedAt: number,
  dependencies: ExecutionDependencies
): CaseExecutionResult {
  const wallElapsedMs = elapsedMs(startedAt, dependencies.now());
  if (snapshot.status === "cancelled") {
    return {
      result: createNonSuccessCaseResult(
        benchmarkCase,
        "cancelled",
        wallElapsedMs,
        "run-cancelled",
        "生产 Alignment V2 任务已取消。",
        dependencies.options
      ),
      prediction: null
    };
  }
  if (snapshot.status === "failed") {
    const disclosure = discloseKnownAlignmentFailure(snapshot.error);
    return failedExecution(
      benchmarkCase,
      wallElapsedMs,
      "job-reported-failure",
      disclosure?.message ?? "生产 Alignment V2 任务报告失败；原始工具错误已从可分享报告移除。",
      dependencies.options
    );
  }
  if (snapshot.status !== "completed" || !snapshot.proposal) {
    return failedExecution(
      benchmarkCase,
      wallElapsedMs,
      "job-reported-failure",
      "生产任务返回了不完整的终态。",
      dependencies.options
    );
  }
  const validationFailure = validateRealMediaBenchmarkProposalBinding(
    benchmarkCase,
    snapshot.proposal,
    dependencies.options
  );
  if (validationFailure) {
    return failedExecution(
      benchmarkCase,
      wallElapsedMs,
      validationFailure.code,
      validationFailure.message,
      dependencies.options
    );
  }
  const timeMap = snapshot.proposal.timeMap;
  if (!timeMap) {
    return failedExecution(
      benchmarkCase,
      wallElapsedMs,
      "missing-time-map",
      "生产 Alignment V2 完成但没有返回 TimeMap。",
      dependencies.options
    );
  }
  return {
    result: {
      caseId: benchmarkCase.caseId,
      status: "success",
      wallElapsedMs,
      engineVersion: timeMap.engineVersion,
      featureVersion: timeMap.featureVersion,
      qualityLevel: timeMap.quality.level,
      sourceVisualStreamIndex: timeMap.sourceVisualStream?.index ?? null,
      targetVisualStreamIndex: timeMap.targetVisualStream?.index ?? null,
      parameters: createParameterSummary(benchmarkCase, dependencies.options),
      failure: null
    },
    prediction: {
      caseId: benchmarkCase.caseId,
      spans: timeMap.spans.map((span) => ({ ...span }))
    }
  };
}

export function validateRealMediaBenchmarkProposalBinding(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  proposal: AlignmentProposal,
  options: RealMediaBenchmarkRunnerOptions
): RealMediaBenchmarkCaseFailure | null {
  const timeMap = proposal.timeMap;
  if (!timeMap) {
    return { code: "missing-time-map", message: "生产 Alignment V2 没有返回 TimeMap。" };
  }
  if (
    !timeMap.engineVersion.toLowerCase().includes("alignment-v2") ||
    timeMap.featureVersion.trim().length === 0 ||
    timeMap.parametersHash.trim().length === 0
  ) {
    return {
      code: "not-alignment-v2",
      message: "结果不是可复核的生产 Alignment V2 工件。"
    };
  }
  if (
    !matchesBenchmarkIdentity(benchmarkCase.source.contentIdentity, timeMap.sourceIdentity) ||
    !matchesBenchmarkIdentity(benchmarkCase.target.contentIdentity, timeMap.targetIdentity)
  ) {
    return {
      code: "identity-mismatch",
      message: "分析结果绑定的媒体身份与 blind run manifest 不一致。"
    };
  }
  if (
    !matchesExpectedStream(benchmarkCase.source, timeMap.sourceStream) ||
    !matchesExpectedStream(benchmarkCase.target, timeMap.targetStream)
  ) {
    return {
      code: "stream-mismatch",
      message: "分析结果使用的显式流与 blind run manifest 不一致。"
    };
  }
  const expectsVisual =
    options.enableVisualEvidence ??
    (benchmarkCase.source.videoStreamIndex !== null &&
      benchmarkCase.target.videoStreamIndex !== null);
  if (
    expectsVisual &&
    (!matchesExpectedVisualStream(benchmarkCase.source, timeMap.sourceVisualStream) ||
      !matchesExpectedVisualStream(benchmarkCase.target, timeMap.targetVisualStream))
  ) {
    return {
      code: "stream-mismatch",
      message: "分析结果没有证明视觉校验实际消费了 blind run manifest 指定的视频流。"
    };
  }
  return null;
}

function matchesBenchmarkIdentity(
  expected: RealMediaBenchmarkContentIdentity | null,
  actual: MediaContentIdentity | null
): boolean {
  if (!expected || !actual) return false;
  const digest = expected.digest.toLowerCase();
  return (
    actual.algorithm === expected.algorithm &&
    actual.sizeBytes === expected.sizeBytes &&
    actual.firstSampleDigest.toLowerCase() === digest &&
    actual.middleSampleDigest.toLowerCase() === digest &&
    actual.lastSampleDigest.toLowerCase() === digest
  );
}

function matchesExpectedStream(
  media: RealMediaBenchmarkMediaInput,
  actual: AlignmentTimeMapStreamIdentity | null
): boolean {
  if (!actual) return false;
  if (actual.type === "audio") return actual.index === media.audioStreamIndex;
  return media.videoStreamIndex !== null && actual.index === media.videoStreamIndex;
}

function matchesExpectedVisualStream(
  media: RealMediaBenchmarkMediaInput,
  actual: AlignmentTimeMapStreamIdentity | null | undefined
): boolean {
  return (
    media.videoStreamIndex !== null &&
    actual?.type === "video" &&
    actual.index === media.videoStreamIndex
  );
}

export function createRealMediaBenchmarkAlignmentRequest(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  options: RealMediaBenchmarkRunnerOptions
): TauriAudioAlignmentRequest {
  return {
    completePath: benchmarkCase.target.path,
    sourcePath: benchmarkCase.source.path,
    ffmpegPath: options.ffmpegPath ?? null,
    ffprobePath: options.ffprobePath ?? null,
    spectralBackend: normalizeTauriSpectralBackendPreference(options.spectralBackend),
    completeAudioStreamIndex: benchmarkCase.target.audioStreamIndex,
    sourceAudioStreamIndex: benchmarkCase.source.audioStreamIndex,
    completeVideoStreamIndex: benchmarkCase.target.videoStreamIndex,
    sourceVideoStreamIndex: benchmarkCase.source.videoStreamIndex,
    sampleRate: options.sampleRate,
    windowMs: options.windowMs,
    matchThreshold: options.matchThreshold,
    minGapMs: options.minGapMs,
    maxCells: options.maxCells,
    enableVisualEvidence:
      options.enableVisualEvidence ??
      (benchmarkCase.source.videoStreamIndex !== null &&
        benchmarkCase.target.videoStreamIndex !== null),
    visualSampleIntervalMs: options.visualSampleIntervalMs,
    localizationMode: true
  };
}

function createParameterSummary(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  options: RealMediaBenchmarkRunnerOptions
): RealMediaBenchmarkParameterSummary {
  return {
    localizationMode: true,
    spectralBackend: normalizeTauriSpectralBackendPreference(options.spectralBackend),
    sampleRate: options.sampleRate ?? null,
    windowMs: options.windowMs ?? null,
    matchThreshold: options.matchThreshold ?? null,
    minGapMs: options.minGapMs ?? null,
    maxCells: options.maxCells ?? null,
    enableVisualEvidence:
      options.enableVisualEvidence ??
      (benchmarkCase.source.videoStreamIndex !== null &&
        benchmarkCase.target.videoStreamIndex !== null),
    visualSampleIntervalMs: options.visualSampleIntervalMs ?? null,
    sourceAudioStreamIndex: benchmarkCase.source.audioStreamIndex,
    targetAudioStreamIndex: benchmarkCase.target.audioStreamIndex,
    sourceVideoStreamIndex: benchmarkCase.source.videoStreamIndex,
    targetVideoStreamIndex: benchmarkCase.target.videoStreamIndex
  };
}

function failedExecution(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  wallElapsedMs: number,
  code: RealMediaBenchmarkCaseFailureCode,
  message: string,
  options: RealMediaBenchmarkRunnerOptions
): CaseExecutionResult {
  return {
    result: createNonSuccessCaseResult(
      benchmarkCase,
      "failed",
      wallElapsedMs,
      code,
      message,
      options
    ),
    prediction: null
  };
}

function createNonSuccessCaseResult(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  status: Exclude<RealMediaBenchmarkCaseRunStatus, "success">,
  wallElapsedMs: number,
  code: RealMediaBenchmarkCaseFailureCode,
  message: string,
  options: RealMediaBenchmarkRunnerOptions
): RealMediaBenchmarkCaseRunResult {
  return {
    caseId: benchmarkCase.caseId,
    status,
    wallElapsedMs,
    engineVersion: null,
    featureVersion: null,
    qualityLevel: null,
    sourceVisualStreamIndex: null,
    targetVisualStreamIndex: null,
    parameters: createParameterSummary(benchmarkCase, options),
    failure: { code, message }
  };
}

interface BaseReportInput {
  manifest: RealMediaBenchmarkManifest;
  status: RealMediaBenchmarkRunStatus;
  wallElapsedMs: number;
  skippedNonRealCaseCount: number;
  preflight: RealMediaBenchmarkPreflightResult;
  cases: RealMediaBenchmarkCaseRunResult[];
  evaluation: RealMediaBenchmarkResult | null;
  reasons: string[];
}

function createBaseReport(input: BaseReportInput): RealMediaBenchmarkRunReport {
  return {
    schemaVersion: REAL_MEDIA_BENCHMARK_RUN_REPORT_SCHEMA_VERSION,
    reportKind: "c137-real-media-benchmark-run",
    scope: "time-map-component",
    releaseEligible: false,
    runnerVersion: REAL_MEDIA_BENCHMARK_RUNNER_VERSION,
    manifestId: input.manifest.id,
    datasetVersion: input.manifest.datasetVersion,
    runManifestDigest: createRealMediaBenchmarkRunManifestDigest(
      projectRealMediaBenchmarkRunManifest(input.manifest)
    ),
    status: input.status,
    wallElapsedMs: input.wallElapsedMs,
    skippedNonRealCaseCount: input.skippedNonRealCaseCount,
    preflight: input.preflight,
    cases: input.cases,
    evaluation: input.evaluation,
    reasons: input.reasons
  };
}

function finalizeReport(
  report: RealMediaBenchmarkRunReport,
  manifest: RealMediaBenchmarkManifest
): RealMediaBenchmarkRunReport {
  const validation = validateRealMediaBenchmarkRunReport(report);
  if (!validation.valid) {
    throw new Error(`内部生成的真实媒体运行报告无效：${validation.issues.join("；")}`);
  }
  const serialized = JSON.stringify(report);
  if (containsSensitiveText(serialized, collectManifestSecrets(manifest))) {
    throw new Error("真实媒体运行报告包含本地路径或媒体身份，拒绝输出。 ");
  }
  return report;
}

export function validateRealMediaBenchmarkRunReport(
  value: unknown
): RealMediaBenchmarkRunReportValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: ["真实媒体运行报告必须是对象。"] };
  }
  if (value.schemaVersion !== REAL_MEDIA_BENCHMARK_RUN_REPORT_SCHEMA_VERSION) {
    issues.push("report.schemaVersion 必须为 1。");
  }
  if (value.reportKind !== "c137-real-media-benchmark-run") {
    issues.push("report.reportKind 不正确。");
  }
  if (value.scope !== "time-map-component" || value.releaseEligible !== false) {
    issues.push("报告必须明确限定为 time-map-component，且 releaseEligible 必须为 false。");
  }
  if (value.runnerVersion !== REAL_MEDIA_BENCHMARK_RUNNER_VERSION) {
    issues.push("report.runnerVersion 不受支持。");
  }
  if (!isNonEmptyString(value.manifestId) || !isNonEmptyString(value.datasetVersion)) {
    issues.push("report manifestId/datasetVersion 必须是非空字符串。");
  }
  if (
    typeof value.runManifestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.runManifestDigest)
  ) {
    issues.push("report.runManifestDigest 必须是规范 SHA-256。");
  }
  if (!isRunStatus(value.status)) issues.push("report.status 不受支持。");
  if (!isNonNegativeInteger(value.wallElapsedMs)) issues.push("report.wallElapsedMs 无效。");
  if (!isNonNegativeInteger(value.skippedNonRealCaseCount)) {
    issues.push("report.skippedNonRealCaseCount 无效。");
  }
  if (!isPreflightResult(value.preflight)) issues.push("report.preflight 结构无效。");
  if (!Array.isArray(value.cases) || !value.cases.every(isCaseRunResult)) {
    issues.push("report.cases 结构无效。");
  }
  if (value.evaluation !== null) {
    const validation = validateRealMediaBenchmarkResult(value.evaluation);
    if (!validation.valid)
      issues.push(...validation.issues.map((issue) => `evaluation: ${issue}`));
  }
  if (!isNonEmptyStringArray(value.reasons))
    issues.push("report.reasons 必须是非空字符串数组。");

  if (Array.isArray(value.cases) && isRunStatus(value.status)) {
    const statuses = value.cases
      .filter(isRecord)
      .map((item) => item.status)
      .filter((status): status is RealMediaBenchmarkCaseRunStatus => isCaseStatus(status));
    if (
      value.status === "completed" &&
      (statuses.some((status) => status !== "success") || value.evaluation === null)
    ) {
      issues.push("completed 报告必须全部 success 且包含 evaluation。");
    }
    if (value.status !== "completed" && value.evaluation !== null) {
      issues.push("非 completed 报告不得包含部分质量 evaluation。");
    }
    if (value.status === "completed-with-errors" && !statuses.includes("failed")) {
      issues.push("completed-with-errors 必须包含 failed case。");
    }
    if (value.status === "cancelled" && !statuses.includes("cancelled")) {
      issues.push("cancelled 报告必须包含 cancelled case。");
    }
  }
  return { valid: issues.length === 0, issues };
}

export function validateRealMediaBenchmarkRunManifest(
  value: unknown
): RealMediaBenchmarkRunReportValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: ["blind run manifest 必须是对象。"] };
  }
  if (
    !hasOnlyKeys(value, ["schemaVersion", "manifestId", "datasetVersion", "cases"]) ||
    value.schemaVersion !== REAL_MEDIA_BENCHMARK_RUN_MANIFEST_SCHEMA_VERSION
  ) {
    issues.push("blind run manifest 根字段或 schemaVersion 无效。");
  }
  if (!isNonEmptyString(value.manifestId) || !isNonEmptyString(value.datasetVersion)) {
    issues.push("blind run manifestId/datasetVersion 必须是非空字符串。");
  }
  if (!Array.isArray(value.cases)) {
    issues.push("blind run cases 必须是数组。");
    return { valid: false, issues };
  }
  const caseIds = new Set<string>();
  value.cases.forEach((benchmarkCase, index) => {
    if (
      !isRecord(benchmarkCase) ||
      !hasOnlyKeys(benchmarkCase, ["caseId", "source", "target"])
    ) {
      issues.push(`blind run cases[${index}] 含有 gold/reviewer 等禁止字段或结构无效。`);
      return;
    }
    if (!isNonEmptyString(benchmarkCase.caseId) || caseIds.has(benchmarkCase.caseId)) {
      issues.push(`blind run cases[${index}].caseId 无效或重复。`);
    } else {
      caseIds.add(benchmarkCase.caseId);
    }
    validateBlindMediaInput(benchmarkCase.source, `cases[${index}].source`, issues);
    validateBlindMediaInput(benchmarkCase.target, `cases[${index}].target`, issues);
  });
  return { valid: issues.length === 0, issues };
}

export function serializeRealMediaBenchmarkRunReport(
  report: RealMediaBenchmarkRunReport
): string {
  const validation = validateRealMediaBenchmarkRunReport(report);
  if (!validation.valid) {
    throw new Error(`真实媒体运行报告无效：${validation.issues.join("；")}`);
  }
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function parseRealMediaBenchmarkRunReportJson(
  json: string
): RealMediaBenchmarkRunReport {
  const parsed = JSON.parse(json) as unknown;
  const validation = validateRealMediaBenchmarkRunReport(parsed);
  if (!validation.valid) {
    throw new Error(`真实媒体运行报告无效：${validation.issues.join("；")}`);
  }
  return parsed as RealMediaBenchmarkRunReport;
}

function sanitizePreflight(
  result: RealMediaBenchmarkPreflightResult,
  sanitize: (text: string) => string
): RealMediaBenchmarkPreflightResult {
  return {
    ...result,
    issues: result.issues.map((issue) => ({ ...issue, message: sanitize(issue.message) }))
  };
}

function createManifestSanitizer(
  manifest: RealMediaBenchmarkManifest
): (text: string) => string {
  const secrets = collectManifestSecrets(manifest);
  return (text) => redactSensitiveText(text, secrets);
}

function collectManifestSecrets(manifest: RealMediaBenchmarkManifest): string[] {
  return [
    ...new Set(
      manifest.cases.flatMap((benchmarkCase) =>
        [benchmarkCase.source, benchmarkCase.target].flatMap((media) => [
          media.path,
          media.contentIdentity?.digest ?? ""
        ])
      )
    )
  ].filter((secret) => secret.length > 0);
}

function cloneMediaInput(media: RealMediaBenchmarkMediaInput): RealMediaBenchmarkMediaInput {
  return {
    ...media,
    contentIdentity: media.contentIdentity ? { ...media.contentIdentity } : null
  };
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function defaultNow(): number {
  return globalThis.performance.now();
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function isRunStatus(value: unknown): value is RealMediaBenchmarkRunStatus {
  return (
    value === "insufficient-data" ||
    value === "preflight-failed" ||
    value === "completed" ||
    value === "completed-with-errors" ||
    value === "cancelled"
  );
}

function isCaseStatus(value: unknown): value is RealMediaBenchmarkCaseRunStatus {
  return value === "success" || value === "failed" || value === "cancelled";
}

function isCaseRunResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isParameterSummary(value.parameters)) return false;
  const visualStreamShape =
    value.status !== "success" || !value.parameters.enableVisualEvidence
      ? isOptionalNonNegativeInteger(value.sourceVisualStreamIndex) &&
        isOptionalNonNegativeInteger(value.targetVisualStreamIndex)
      : value.sourceVisualStreamIndex === value.parameters.sourceVideoStreamIndex &&
        value.targetVisualStreamIndex === value.parameters.targetVideoStreamIndex &&
        value.sourceVisualStreamIndex !== null &&
        value.targetVisualStreamIndex !== null;
  const successShape =
    value.status === "success"
      ? isNonEmptyString(value.engineVersion) &&
        isNonEmptyString(value.featureVersion) &&
        isNonEmptyString(value.qualityLevel) &&
        isOptionalNonNegativeInteger(value.sourceVisualStreamIndex) &&
        isOptionalNonNegativeInteger(value.targetVisualStreamIndex) &&
        visualStreamShape &&
        value.failure === null
      : value.engineVersion === null &&
        value.featureVersion === null &&
        value.qualityLevel === null &&
        value.sourceVisualStreamIndex === null &&
        value.targetVisualStreamIndex === null &&
        isCaseFailure(value.failure);
  return (
    isNonEmptyString(value.caseId) &&
    isCaseStatus(value.status) &&
    isNonNegativeInteger(value.wallElapsedMs) &&
    successShape
  );
}

function isCaseFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    CASE_FAILURE_CODES.has(value.code as RealMediaBenchmarkCaseFailureCode) &&
    isNonEmptyString(value.message)
  );
}

function isParameterSummary(value: unknown): value is RealMediaBenchmarkParameterSummary {
  return (
    isRecord(value) &&
    value.localizationMode === true &&
    (value.spectralBackend === "auto" ||
      value.spectralBackend === "cuda" ||
      value.spectralBackend === "cpu") &&
    isOptionalNonNegativeNumber(value.sampleRate) &&
    isOptionalNonNegativeNumber(value.windowMs) &&
    isOptionalUnitNumber(value.matchThreshold) &&
    isOptionalNonNegativeNumber(value.minGapMs) &&
    isOptionalNonNegativeNumber(value.maxCells) &&
    typeof value.enableVisualEvidence === "boolean" &&
    isOptionalNonNegativeNumber(value.visualSampleIntervalMs) &&
    isNonNegativeInteger(value.sourceAudioStreamIndex) &&
    isNonNegativeInteger(value.targetAudioStreamIndex) &&
    isOptionalNonNegativeInteger(value.sourceVideoStreamIndex) &&
    isOptionalNonNegativeInteger(value.targetVideoStreamIndex)
  );
}

function isPreflightResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    isNonNegativeInteger(value.realRelationCount) &&
    isNonNegativeInteger(value.checkedFileCount) &&
    Array.isArray(value.issues) &&
    value.issues.every(isPreflightIssue)
  );
}

function isPreflightIssue(value: unknown): value is RealMediaBenchmarkPreflightIssue {
  return (
    isRecord(value) &&
    (value.caseId === null || typeof value.caseId === "string") &&
    (value.side === null || value.side === "source" || value.side === "target") &&
    (value.code === "invalid-manifest" ||
      value.code === "probe-failed" ||
      value.code === "identity-mismatch" ||
      value.code === "audio-stream-missing" ||
      value.code === "video-stream-missing") &&
    isNonEmptyString(value.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === null || isNonNegativeInteger(value);
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isOptionalUnitNumber(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

function validateBlindMediaInput(value: unknown, prefix: string, issues: string[]): void {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "path",
      "audioStreamIndex",
      "videoStreamIndex",
      "contentIdentity",
      "versionNote",
      "licenseNote"
    ])
  ) {
    issues.push(`${prefix} 结构无效。`);
    return;
  }
  if (!isNonEmptyString(value.path)) issues.push(`${prefix}.path 必须是非空字符串。`);
  if (!isNonNegativeInteger(value.audioStreamIndex)) {
    issues.push(`${prefix}.audioStreamIndex 必须是非负整数。`);
  }
  if (!isOptionalNonNegativeInteger(value.videoStreamIndex)) {
    issues.push(`${prefix}.videoStreamIndex 必须是非负整数或 null。`);
  }
  if (
    !isRecord(value.contentIdentity) ||
    !hasOnlyKeys(value.contentIdentity, ["algorithm", "sizeBytes", "digest"]) ||
    value.contentIdentity.algorithm !== "sha256-full-file-v2" ||
    !isNonNegativeInteger(value.contentIdentity.sizeBytes) ||
    typeof value.contentIdentity.digest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.contentIdentity.digest)
  ) {
    issues.push(`${prefix}.contentIdentity 必须是完整 SHA-256 身份。`);
  }
  if (!isNonEmptyString(value.versionNote) || !isNonEmptyString(value.licenseNote)) {
    issues.push(`${prefix} 必须包含版本和许可说明。`);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
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
