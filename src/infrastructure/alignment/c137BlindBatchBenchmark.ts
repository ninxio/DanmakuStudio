import {
  assertC137BlindBatchSingleBatchCandidateUniverse,
  compileC137BlindBatchBenchmarkEvidence,
  createC137BlindBatchMediaBindingCommitment,
  createC137BlindBatchExecutionProjection,
  deriveC137BlindBatchRawPredictionFromNativeReceipt,
  orderC137BlindBatchMediaInputs,
  type C137BlindBatchBenchmarkEvidence,
  type C137BlindBatchExecutionProjection,
  type C137BlindBatchProjectionOptions
} from "../../domain/alignment/c137BlindBatchEvidence";
import type {
  RealMediaBenchmarkCase,
  RealMediaBenchmarkManifest,
  RealMediaBenchmarkMediaInput
} from "../../domain/alignment/realMediaBenchmark";
import {
  C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
  computeC137FormalBlindManifestDigest,
  createC137FormalBlindMatrixExecutionProjection,
  createC137FormalBlindMatrixPlan,
  sealC137FormalBlindProvenanceV3,
  type C137FormalBlindMatrixPlanV2,
  type C137FormalBlindProvenanceBatchEnvelopeV3,
  type C137FormalBlindProvenanceV3
} from "../../domain/alignment/c137FormalBlindProvenance";
import type { MediaContentIdentity } from "../../domain/project/types";
import {
  probeTauriMediaTimeline,
  type MediaTimelineProbeInvoker,
  type MediaTimelineProbeResult
} from "../media/tauriMediaProbe";
import {
  preflightRealMediaBenchmark,
  type RealMediaBenchmarkPreflightOptions,
  type RealMediaBenchmarkPreflightResult
} from "./realMediaBenchmarkPreflight";
import {
  REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
  runRealMediaBlindBatchSuite,
  validateRealMediaBlindBatchExecutionSuite,
  validateRealMediaBlindBatchRunReceipt,
  type RealMediaBlindBatchAlignmentParameters,
  type RealMediaBlindBatchExecutionMedia,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchRunReceipt,
  type RealMediaBlindBatchRunnerOptions,
  type RealMediaBlindBatchRunStatus
} from "./realMediaBlindBatchRunner";

export const C137_BLIND_BATCH_BENCHMARK_REPORT_SCHEMA_VERSION = 1 as const;

export type C137BlindBatchBenchmarkRunStatus =
  | "completed"
  | "preflight-failed"
  | "execution-invalid"
  | "runner-failed"
  | "receipt-invalid"
  | "incomplete-run"
  | "compilation-failed";

export type C137BlindBatchSuiteRunner = (
  suite: RealMediaBlindBatchExecutionSuite,
  options: RealMediaBlindBatchRunnerOptions
) => Promise<unknown>;

export interface C137BlindBatchBenchmarkOptions extends C137BlindBatchProjectionOptions {
  parameters: RealMediaBlindBatchAlignmentParameters;
  preflightOptions?: Omit<RealMediaBenchmarkPreflightOptions, "ffmpegPath" | "ffprobePath">;
  runnerOptions?: RealMediaBlindBatchRunnerOptions;
  runner?: C137BlindBatchSuiteRunner;
}

export const C137_FORMAL_BLIND_MATRIX_BENCHMARK_RESULT_SCHEMA_VERSION = 1 as const;

export type C137FormalBlindMatrixBenchmarkRunStatus =
  | "completed"
  | "preflight-failed"
  | "execution-invalid"
  | "runner-failed"
  | "receipt-invalid"
  | "incomplete-run"
  | "sealing-failed";

export interface C137FormalBlindMatrixBenchmarkOptions {
  /** The deterministic exhaustive plan must be frozen before this coordinator performs I/O. */
  plan: C137FormalBlindMatrixPlanV2;
  parameters: RealMediaBlindBatchAlignmentParameters;
  preflightOptions?: Omit<RealMediaBenchmarkPreflightOptions, "ffmpegPath" | "ffprobePath">;
  runnerOptions?: RealMediaBlindBatchRunnerOptions;
  runner?: C137BlindBatchSuiteRunner;
}

/**
 * This is deliberately private evidence: successful provenance contains frozen gold and local
 * media paths. Any non-completed result is fail-closed and contains no tile envelope or gold data.
 */
export interface C137FormalBlindMatrixBenchmarkResult {
  schemaVersion: typeof C137_FORMAL_BLIND_MATRIX_BENCHMARK_RESULT_SCHEMA_VERSION;
  resultKind: "c137-formal-blind-matrix-benchmark";
  status: C137FormalBlindMatrixBenchmarkRunStatus;
  preflight: RealMediaBenchmarkPreflightResult;
  completedBatchCount: number;
  totalBatchCount: number;
  provenance: C137FormalBlindProvenanceV3 | null;
  reasons: string[];
}

/**
 * The pathful execution suite, projection inventory, raw prediction and per-case gold deliberately
 * never cross this boundary. Failed reports never contain accuracy evidence.
 */
export interface C137BlindBatchBenchmarkReport {
  schemaVersion: typeof C137_BLIND_BATCH_BENCHMARK_REPORT_SCHEMA_VERSION;
  reportKind: "c137-blind-batch-benchmark";
  status: C137BlindBatchBenchmarkRunStatus;
  preflight: RealMediaBenchmarkPreflightResult;
  nativeRunStatus: RealMediaBlindBatchRunStatus | null;
  evidence: C137BlindBatchShareableEvidence | null;
  reasons: string[];
}

export type C137BlindBatchShareableEvidence = Omit<
  C137BlindBatchBenchmarkEvidence,
  | "manifestId"
  | "datasetVersion"
  | "suiteId"
  | "projectionDigest"
  | "executionDigest"
  | "nativeReceiptDigest"
  | "rawPredictionDigest"
  | "evidenceDigest"
>;

interface ReportState {
  status: C137BlindBatchBenchmarkRunStatus;
  preflight: RealMediaBenchmarkPreflightResult;
  nativeRunStatus?: RealMediaBlindBatchRunStatus | null;
  evidence?: C137BlindBatchBenchmarkEvidence | null;
  reasons: string[];
}

interface FormalMatrixResultState {
  status: C137FormalBlindMatrixBenchmarkRunStatus;
  preflight: RealMediaBenchmarkPreflightResult;
  completedBatchCount: number;
  provenance?: C137FormalBlindProvenanceV3 | null;
  reasons: string[];
}

interface CapturedProbeState {
  byPath: Map<string, MediaTimelineProbeResult>;
  invoker: MediaTimelineProbeInvoker;
}

/**
 * Run one governed blind N×M benchmark. Gold is reachable only after a strictly validated,
 * complete native receipt has been normalized and sealed.
 */
export async function runC137BlindBatchBenchmark(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchBenchmarkOptions
): Promise<C137BlindBatchBenchmarkReport> {
  if (options.visualEvidenceEnabled !== options.parameters.enableVisualEvidence) {
    throw new Error(
      "blind benchmark visualEvidenceEnabled 必须与 native parameters.enableVisualEvidence 一致。"
    );
  }
  const projectionOptions: C137BlindBatchProjectionOptions = {
    relationshipAxis: options.relationshipAxis,
    visualEvidenceEnabled: options.visualEvidenceEnabled,
    topK: options.topK,
    ...(options.caseIds === undefined ? {} : { caseIds: options.caseIds }),
    ...(options.candidateCaseIds === undefined
      ? {}
      : { candidateCaseIds: options.candidateCaseIds })
  };
  const projection = createC137BlindBatchExecutionProjection(manifest, projectionOptions);
  assertC137BlindBatchSingleBatchCandidateUniverse(manifest, projectionOptions, projection);
  const decisionCases = selectFrozenCases(manifest, options.caseIds);
  const candidateCases = selectFrozenCases(
    manifest,
    options.candidateCaseIds ?? options.caseIds
  );
  const selectedManifest: RealMediaBenchmarkManifest = {
    ...structuredClone(manifest),
    cases: createPreflightCases(
      decisionCases,
      candidateCases,
      options.relationshipAxis,
      options.visualEvidenceEnabled
    )
  };
  const capturedProbes = createCapturedProbeState(options.preflightOptions?.probe);
  let preflight: RealMediaBenchmarkPreflightResult;
  try {
    preflight = await preflightRealMediaBenchmark(selectedManifest, {
      ...options.preflightOptions,
      ffmpegPath: options.parameters.ffmpegPath,
      ffprobePath: options.parameters.ffprobePath,
      probe: capturedProbes.invoker,
      signal: options.preflightOptions?.signal ?? options.runnerOptions?.signal
    });
  } catch {
    preflight = createExceptionalPreflight(decisionCases.length);
  }

  if (!preflight.ok) {
    return finalizeShareableReport(candidateCases, projection, {
      status: "preflight-failed",
      preflight,
      reasons: ["运行前路径、全文件身份或显式流核验未通过；native batch 未启动。"]
    });
  }

  let executionSuite: RealMediaBlindBatchExecutionSuite;
  try {
    executionSuite = validateRealMediaBlindBatchExecutionSuite(
      createExecutionSuite(
        manifest.id,
        manifest.datasetVersion,
        decisionCases,
        candidateCases,
        projection,
        capturedProbes.byPath,
        options.parameters
      )
    );
  } catch {
    return finalizeShareableReport(candidateCases, projection, {
      status: "execution-invalid",
      preflight,
      reasons: ["预检捕获结果无法形成与 blind projection 一致的执行计划。"]
    });
  }

  const runner = options.runner ?? defaultSuiteRunner;
  let receiptValue: unknown;
  try {
    receiptValue = await runner(structuredClone(executionSuite), options.runnerOptions ?? {});
  } catch {
    return finalizeShareableReport(candidateCases, projection, {
      status: "runner-failed",
      preflight,
      reasons: ["native blind batch 执行异常；原始工具错误已从可分享结果移除。"]
    });
  }

  let receipt: RealMediaBlindBatchRunReceipt;
  try {
    receipt = validateRealMediaBlindBatchRunReceipt(receiptValue, executionSuite);
  } catch {
    return finalizeShareableReport(candidateCases, projection, {
      status: "receipt-invalid",
      preflight,
      reasons: ["native blind batch 回执未通过严格 digest、顺序或内容闭合校验。"]
    });
  }

  if (
    receipt.status !== "completed" ||
    receipt.pairOutcomes.some((outcome) => outcome.nativeStatus !== "completed")
  ) {
    return finalizeShareableReport(candidateCases, projection, {
      status: "incomplete-run",
      preflight,
      nativeRunStatus: receipt.status,
      reasons: ["native batch 未完整成功；未揭示 frozen gold，也未生成 accuracy evidence。"]
    });
  }

  try {
    const rawPrediction = deriveC137BlindBatchRawPredictionFromNativeReceipt(
      projection,
      executionSuite,
      receipt
    );
    const evidence = compileC137BlindBatchBenchmarkEvidence(
      manifest,
      projectionOptions,
      projection,
      rawPrediction
    );
    return finalizeShareableReport(candidateCases, projection, {
      status: "completed",
      preflight,
      nativeRunStatus: receipt.status,
      evidence,
      reasons: []
    });
  } catch {
    return finalizeShareableReport(candidateCases, projection, {
      status: "compilation-failed",
      preflight,
      nativeRunStatus: receipt.status,
      reasons: ["严格回执无法确定性转换或编译为 blind benchmark evidence。"]
    });
  }
}

/**
 * Execute one pre-registered exhaustive query×candidate matrix. The full manifest is preflighted
 * exactly once, tiles run sequentially because native media jobs are exclusive, and no private
 * provenance is published until every tile has completed and the global ranking validates.
 */
export async function runC137FormalBlindMatrixBenchmark(
  manifest: RealMediaBenchmarkManifest,
  options: C137FormalBlindMatrixBenchmarkOptions
): Promise<C137FormalBlindMatrixBenchmarkResult> {
  if (options.plan.visualEvidenceEnabled !== options.parameters.enableVisualEvidence) {
    throw new Error(
      "formal blind matrix visualEvidenceEnabled 必须与 native parameters.enableVisualEvidence 一致。"
    );
  }
  const manifestDigest = computeC137FormalBlindManifestDigest(manifest);
  const canonicalPlan = createC137FormalBlindMatrixPlan(manifest, manifestDigest, {
    relationshipAxis: options.plan.relationshipAxis,
    visualEvidenceEnabled: options.plan.visualEvidenceEnabled,
    globalTopK: options.plan.globalTopK,
    scoreContract: options.plan.scoreContract
  });
  if (!canonicalValuesEqual(options.plan, canonicalPlan)) {
    throw new Error(
      "formal blind matrix plan 必须在媒体 I/O 前精确等于 manifest 的唯一 exhaustive 计划。"
    );
  }

  const capturedProbes = createCapturedProbeState(options.preflightOptions?.probe);
  const preflightManifest: RealMediaBenchmarkManifest = {
    ...structuredClone(manifest),
    cases: manifest.cases.map((benchmarkCase) =>
      normalizePreflightCase(benchmarkCase, canonicalPlan.visualEvidenceEnabled)
    )
  };
  let preflight: RealMediaBenchmarkPreflightResult;
  try {
    preflight = await preflightRealMediaBenchmark(preflightManifest, {
      ...options.preflightOptions,
      ffmpegPath: options.parameters.ffmpegPath,
      ffprobePath: options.parameters.ffprobePath,
      probe: capturedProbes.invoker,
      signal: options.preflightOptions?.signal ?? options.runnerOptions?.signal
    });
  } catch {
    preflight = createExceptionalPreflight(manifest.cases.length);
  }
  if (!preflight.ok) {
    return createFormalMatrixResult(canonicalPlan, {
      status: "preflight-failed",
      preflight,
      completedBatchCount: 0,
      reasons: ["全量 manifest 的路径、全文件身份或显式流预检未通过；未启动任何 tile。"]
    });
  }

  const runner = options.runner ?? defaultSuiteRunner;
  const envelopes: C137FormalBlindProvenanceBatchEnvelopeV3[] = [];
  let pinnedExecutionIdentityDigest: string | null = null;
  for (const planBatch of canonicalPlan.batches) {
    const queryCases = selectFrozenCases(manifest, planBatch.queryCaseIds);
    const candidateCases = selectFrozenCases(manifest, planBatch.candidateCaseIds);
    const projection = createC137FormalBlindMatrixExecutionProjection(manifest, {
      queryCaseIds: planBatch.queryCaseIds,
      candidateCaseIds: planBatch.candidateCaseIds,
      relationshipAxis: canonicalPlan.relationshipAxis,
      visualEvidenceEnabled: canonicalPlan.visualEvidenceEnabled,
      globalTopK: canonicalPlan.globalTopK
    });
    let executionSuite: RealMediaBlindBatchExecutionSuite;
    try {
      if (projection.projectionDigest !== planBatch.projectionDigest) {
        throw new Error("matrix tile projectionDigest 与预注册计划不一致。");
      }
      executionSuite = validateRealMediaBlindBatchExecutionSuite(
        createExecutionSuite(
          manifest.id,
          manifest.datasetVersion,
          queryCases,
          candidateCases,
          projection,
          capturedProbes.byPath,
          options.parameters
        )
      );
    } catch {
      return createFormalMatrixResult(canonicalPlan, {
        status: "execution-invalid",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "已核验媒体无法形成与预注册 matrix tile 一致的 pathful execution suite；全部私有 tile envelope 已丢弃。"
        ]
      });
    }

    let receiptValue: unknown;
    try {
      receiptValue = await runner(structuredClone(executionSuite), options.runnerOptions ?? {});
    } catch {
      return createFormalMatrixResult(canonicalPlan, {
        status: "runner-failed",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "native matrix tile 执行异常；全部私有 tile envelope 已丢弃，未生成 provenance。"
        ]
      });
    }

    let receipt: RealMediaBlindBatchRunReceipt;
    try {
      receipt = validateRealMediaBlindBatchRunReceipt(receiptValue, executionSuite);
    } catch {
      return createFormalMatrixResult(canonicalPlan, {
        status: "receipt-invalid",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "native matrix tile 回执未通过严格 digest、顺序或内容闭合校验；未生成 provenance。"
        ]
      });
    }
    if (
      receipt.status !== "completed" ||
      receipt.pairOutcomes.some((outcome) => outcome.nativeStatus !== "completed")
    ) {
      return createFormalMatrixResult(canonicalPlan, {
        status: "incomplete-run",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "至少一个 native matrix tile 未完整成功；全部私有 tile envelope 已丢弃，未揭示 frozen gold。"
        ]
      });
    }
    if (receipt.executionIdentityDigest === null) {
      return createFormalMatrixResult(canonicalPlan, {
        status: "receipt-invalid",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "native matrix tile 缺少统一 actual execution identity；全部私有 tile envelope 已丢弃。"
        ]
      });
    }
    if (pinnedExecutionIdentityDigest === null) {
      pinnedExecutionIdentityDigest = receipt.executionIdentityDigest;
    } else if (receipt.executionIdentityDigest !== pinnedExecutionIdentityDigest) {
      return createFormalMatrixResult(canonicalPlan, {
        status: "receipt-invalid",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "native matrix tile 的 FFmpeg、FFprobe、原生构建或实际声谱后端身份发生漂移；全部私有 tile envelope 已丢弃。"
        ]
      });
    }
    try {
      const rawPrediction = deriveC137BlindBatchRawPredictionFromNativeReceipt(
        projection,
        executionSuite,
        receipt
      );
      envelopes.push({
        schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
        kind: "c137-formal-blind-provenance-batch",
        batchId: planBatch.batchId,
        projection,
        executionSuite,
        nativeReceipt: receipt,
        rawPrediction
      });
    } catch {
      return createFormalMatrixResult(canonicalPlan, {
        status: "receipt-invalid",
        preflight,
        completedBatchCount: envelopes.length,
        reasons: [
          "native matrix tile 无法确定性派生 raw prediction；全部私有 tile envelope 已丢弃。"
        ]
      });
    }
  }

  try {
    const provenance = sealC137FormalBlindProvenanceV3({
      manifest,
      plan: canonicalPlan,
      batches: envelopes
    });
    return createFormalMatrixResult(canonicalPlan, {
      status: "completed",
      preflight,
      completedBatchCount: envelopes.length,
      provenance,
      reasons: []
    });
  } catch {
    return createFormalMatrixResult(canonicalPlan, {
      status: "sealing-failed",
      preflight,
      completedBatchCount: envelopes.length,
      reasons: [
        "全部 tile 已结束，但 exhaustive coverage、统一参数或全局 Top-K 未闭合；未发布 provenance。"
      ]
    });
  }
}

function defaultSuiteRunner(
  suite: RealMediaBlindBatchExecutionSuite,
  options: RealMediaBlindBatchRunnerOptions
): Promise<RealMediaBlindBatchRunReceipt> {
  return runRealMediaBlindBatchSuite(suite, options);
}

function createCapturedProbeState(
  underlyingProbe: MediaTimelineProbeInvoker | undefined
): CapturedProbeState {
  const byPath = new Map<string, MediaTimelineProbeResult>();
  const invoker: MediaTimelineProbeInvoker = async (request) => {
    const measured = await probeTauriMediaTimeline(request, underlyingProbe);
    const captured = structuredClone(measured);
    byPath.set(request.path, captured);
    return structuredClone(captured);
  };
  return { byPath, invoker };
}

function selectFrozenCases(
  manifest: RealMediaBenchmarkManifest,
  requestedCaseIds: readonly string[] | undefined
): RealMediaBenchmarkCase[] {
  const frozenCases = manifest.cases.filter(
    (benchmarkCase) =>
      benchmarkCase.mediaKind === "real" && benchmarkCase.split === "frozen-test"
  );
  if (requestedCaseIds === undefined) return structuredClone(frozenCases);
  const requested = new Set(requestedCaseIds);
  return structuredClone(
    frozenCases.filter((benchmarkCase) => requested.has(benchmarkCase.id))
  );
}

function normalizePreflightCase(
  benchmarkCase: RealMediaBenchmarkCase,
  visualEvidenceEnabled: boolean
): RealMediaBenchmarkCase {
  const normalized = structuredClone(benchmarkCase);
  if (!visualEvidenceEnabled) {
    normalized.source.videoStreamIndex = null;
    normalized.target.videoStreamIndex = null;
  }
  return normalized;
}

function createPreflightCases(
  decisionCases: readonly RealMediaBenchmarkCase[],
  candidateCases: readonly RealMediaBenchmarkCase[],
  relationshipAxis: C137BlindBatchProjectionOptions["relationshipAxis"],
  visualEvidenceEnabled: boolean
): RealMediaBenchmarkCase[] {
  const fallbackDecision = decisionCases[0];
  if (fallbackDecision === undefined) {
    throw new Error("blind batch preflight 缺少 decision case。");
  }
  const decisionById = new Map(
    decisionCases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase])
  );
  return candidateCases.map((candidateCase) => {
    const normalized = normalizePreflightCase(candidateCase, visualEvidenceEnabled);
    const decisionCase = decisionById.get(candidateCase.id) ?? fallbackDecision;
    if (relationshipAxis === "source") {
      normalized.source = normalizePreflightCase(decisionCase, visualEvidenceEnabled).source;
    } else {
      normalized.target = normalizePreflightCase(decisionCase, visualEvidenceEnabled).target;
    }
    return normalized;
  });
}

function createExecutionSuite(
  manifestId: string,
  datasetVersion: string,
  decisionCases: readonly RealMediaBenchmarkCase[],
  candidateCases: readonly RealMediaBenchmarkCase[],
  projection: C137BlindBatchExecutionProjection,
  probesByPath: ReadonlyMap<string, MediaTimelineProbeResult>,
  parameters: RealMediaBlindBatchAlignmentParameters
): RealMediaBlindBatchExecutionSuite {
  const sourceBindings = collectUniqueMedia(
    manifestId,
    datasetVersion,
    projection.relationshipAxis === "source" ? decisionCases : candidateCases,
    projection.visualEvidenceEnabled,
    "source"
  );
  const targetBindings = collectUniqueMedia(
    manifestId,
    datasetVersion,
    projection.relationshipAxis === "target" ? decisionCases : candidateCases,
    projection.visualEvidenceEnabled,
    "target"
  );
  const sources = bindExecutionMedia(
    manifestId,
    datasetVersion,
    projection.visualEvidenceEnabled,
    sourceBindings,
    projection.sources,
    probesByPath,
    "source"
  );
  const targets = bindExecutionMedia(
    manifestId,
    datasetVersion,
    projection.visualEvidenceEnabled,
    targetBindings,
    projection.targets,
    probesByPath,
    "target"
  );
  return {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
    suiteId: projection.suiteId,
    datasetVersion,
    topK: projection.topK,
    sources,
    targets,
    pairs: projection.pairs.map((pair, index) => ({
      pairOrdinal: index + 1,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId
    })),
    versionReuseGroups: [],
    parameters: structuredClone(parameters)
  };
}

function collectUniqueMedia(
  manifestId: string,
  datasetVersion: string,
  cases: readonly RealMediaBenchmarkCase[],
  visualEvidenceEnabled: boolean,
  side: "source" | "target"
): RealMediaBenchmarkMediaInput[] {
  return orderC137BlindBatchMediaInputs(
    manifestId,
    datasetVersion,
    side,
    visualEvidenceEnabled,
    cases.map((benchmarkCase) => benchmarkCase[side])
  );
}

function bindExecutionMedia(
  manifestId: string,
  datasetVersion: string,
  visualEvidenceEnabled: boolean,
  bindings: readonly RealMediaBenchmarkMediaInput[],
  projected: readonly C137BlindBatchExecutionProjection["sources"][number][],
  probesByPath: ReadonlyMap<string, MediaTimelineProbeResult>,
  side: "source" | "target"
): RealMediaBlindBatchExecutionMedia[] {
  if (bindings.length !== projected.length) {
    throw new Error(`${side} projection 数量与预检 binding 不一致。`);
  }
  return bindings.map((binding, index) => {
    const projectedMedia = projected[index];
    const probe = probesByPath.get(binding.path);
    const videoStreamIndex = visualEvidenceEnabled ? binding.videoStreamIndex : null;
    if (
      projectedMedia === undefined ||
      probe?.contentIdentity === null ||
      probe?.contentIdentity === undefined ||
      projectedMedia.bindingCommitment !==
        createC137BlindBatchMediaBindingCommitment(
          manifestId,
          datasetVersion,
          side,
          visualEvidenceEnabled,
          binding
        ) ||
      projectedMedia.audioStreamIndex !== binding.audioStreamIndex ||
      projectedMedia.videoStreamIndex !== videoStreamIndex
    ) {
      throw new Error(`${side} projection 无法绑定已核验媒体。`);
    }
    return {
      mediaId: projectedMedia.mediaId,
      path: binding.path,
      contentIdentity: cloneIdentity(probe.contentIdentity),
      audioStreamIndex: binding.audioStreamIndex,
      videoStreamIndex
    };
  });
}

function cloneIdentity(identity: MediaContentIdentity): MediaContentIdentity {
  return {
    algorithm: identity.algorithm,
    sizeBytes: identity.sizeBytes,
    modifiedUnixMs: identity.modifiedUnixMs,
    firstSampleDigest: identity.firstSampleDigest,
    middleSampleDigest: identity.middleSampleDigest,
    lastSampleDigest: identity.lastSampleDigest
  };
}

function createExceptionalPreflight(
  realRelationCount: number
): RealMediaBenchmarkPreflightResult {
  return {
    ok: false,
    realRelationCount,
    checkedFileCount: 0,
    issues: [
      {
        caseId: null,
        side: null,
        code: "probe-failed",
        message: "运行前媒体核验异常；原始路径、身份和工具错误已移除。"
      }
    ]
  };
}

function createFormalMatrixResult(
  plan: C137FormalBlindMatrixPlanV2,
  state: FormalMatrixResultState
): C137FormalBlindMatrixBenchmarkResult {
  if (
    !Number.isSafeInteger(state.completedBatchCount) ||
    state.completedBatchCount < 0 ||
    state.completedBatchCount > plan.batches.length
  ) {
    throw new Error("formal blind matrix completedBatchCount 无效。");
  }
  const provenance = state.status === "completed" ? state.provenance : null;
  if ((state.status === "completed") !== (provenance !== null && provenance !== undefined)) {
    throw new Error("formal blind matrix 只有 completed 结果可以携带 provenance。");
  }
  return {
    schemaVersion: C137_FORMAL_BLIND_MATRIX_BENCHMARK_RESULT_SCHEMA_VERSION,
    resultKind: "c137-formal-blind-matrix-benchmark",
    status: state.status,
    preflight: createShareablePreflight(state.preflight),
    completedBatchCount: state.completedBatchCount,
    totalBatchCount: plan.batches.length,
    provenance: provenance ?? null,
    reasons: [...state.reasons]
  };
}

function finalizeShareableReport(
  selectedCases: readonly RealMediaBenchmarkCase[],
  projection: C137BlindBatchExecutionProjection,
  state: ReportState
): C137BlindBatchBenchmarkReport {
  const report: C137BlindBatchBenchmarkReport = {
    schemaVersion: C137_BLIND_BATCH_BENCHMARK_REPORT_SCHEMA_VERSION,
    reportKind: "c137-blind-batch-benchmark",
    status: state.status,
    preflight: createShareablePreflight(state.preflight),
    nativeRunStatus: state.nativeRunStatus ?? null,
    evidence: state.evidence ? createShareableEvidence(state.evidence) : null,
    reasons: [...state.reasons]
  };
  assertShareable(report, selectedCases, projection, state.evidence ?? null);
  return report;
}

function createShareableEvidence(
  evidence: C137BlindBatchBenchmarkEvidence
): C137BlindBatchShareableEvidence {
  return {
    schemaVersion: evidence.schemaVersion,
    kind: evidence.kind,
    scope: evidence.scope,
    releaseEligible: evidence.releaseEligible,
    trustStatus: evidence.trustStatus,
    topK: evidence.topK,
    relationshipAxis: evidence.relationshipAxis,
    decisionCount: evidence.decisionCount,
    top1HitCount: evidence.top1HitCount,
    topKHitCount: evidence.topKHitCount,
    top1Accuracy: evidence.top1Accuracy,
    topKAccuracy: evidence.topKAccuracy,
    shortlistedGoldPairCount: evidence.shortlistedGoldPairCount,
    top1WrongRelationshipCount: evidence.top1WrongRelationshipCount,
    knownPairMappedAnchorCount: evidence.knownPairMappedAnchorCount,
    knownPairUnmappedAnchorCount: evidence.knownPairUnmappedAnchorCount,
    knownPairAnchorCoverage: evidence.knownPairAnchorCoverage,
    knownPairMappedAnchorError: structuredClone(evidence.knownPairMappedAnchorError)
  };
}

function createShareablePreflight(
  preflight: RealMediaBenchmarkPreflightResult
): RealMediaBenchmarkPreflightResult {
  return {
    ok: preflight.ok,
    realRelationCount: preflight.realRelationCount,
    checkedFileCount: preflight.checkedFileCount,
    issues: preflight.issues.map((issue) => ({
      caseId: null,
      side: issue.side,
      code: issue.code,
      message: issue.message
    }))
  };
}

function assertShareable(
  report: C137BlindBatchBenchmarkReport,
  selectedCases: readonly RealMediaBenchmarkCase[],
  projection: C137BlindBatchExecutionProjection,
  privateEvidence: C137BlindBatchBenchmarkEvidence | null
): void {
  const strings = collectStrings(report);
  const normalizedStrings = strings.map(normalizePrivacyString);
  const forbiddenPaths = selectedCases
    .flatMap((benchmarkCase) => [benchmarkCase.source.path, benchmarkCase.target.path])
    .map(normalizePrivacyString);
  const forbiddenCaseIds = new Set(selectedCases.map((benchmarkCase) => benchmarkCase.id));
  const forbiddenPairAndMediaTokens = [
    projection.suiteId,
    projection.projectionDigest,
    ...(privateEvidence === null
      ? []
      : [
          privateEvidence.executionDigest,
          privateEvidence.nativeReceiptDigest,
          privateEvidence.rawPredictionDigest,
          privateEvidence.evidenceDigest
        ]),
    ...projection.pairs.map((pair) => pair.pairId),
    ...projection.sources.flatMap((media) => [media.mediaId, media.bindingCommitment]),
    ...projection.targets.flatMap((media) => [media.mediaId, media.bindingCommitment])
  ].map((value) => value.toLowerCase());
  const forbiddenPlainHashes = selectedCases
    .flatMap((benchmarkCase) => [
      benchmarkCase.source.contentIdentity?.digest.toLowerCase() ?? "",
      benchmarkCase.target.contentIdentity?.digest.toLowerCase() ?? ""
    ])
    .filter((value) => value.length > 0);
  const containsPrivateToken =
    strings.some((value) =>
      [...forbiddenCaseIds].some((caseId) => value.toLowerCase().includes(caseId.toLowerCase()))
    ) ||
    normalizedStrings.some((value) =>
      forbiddenPaths.some((path) => path.length > 0 && value.includes(path))
    ) ||
    strings.some((value) => {
      const normalized = value.toLowerCase();
      return (
        forbiddenPlainHashes.some((hash) => normalized.includes(hash)) ||
        forbiddenPairAndMediaTokens.some((token) => normalized.includes(token))
      );
    });
  if (containsPrivateToken) {
    throw new Error(
      "可分享 blind benchmark report 含 case、pair、media binding、本地路径或媒体 hash。"
    );
  }
}

function normalizePrivacyString(value: string): string {
  return value.split("/").join("\\").toLowerCase();
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item));
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((item) => collectStrings(item));
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right));
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
      .map(([key, nested]) => [key, canonicalizeValue(nested)])
  );
}
