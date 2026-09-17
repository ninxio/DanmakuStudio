import {
  normalizeTauriSpectralBackendPreference,
  type AudioAlignmentStageKey,
  type TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";
import type { SpectralBackendPreference } from "../../domain/alignment/spectralBackendPreference";
import {
  computeC137CanonicalDigest,
  type C137Digest
} from "../../domain/alignment/c137Acceptance";
import {
  appendC137PerformanceCacheResetReceiptV2,
  appendC137PerformanceTrialV2,
  computeC137PerformanceCacheResetReceiptDigestV2,
  computeC137PerformanceCaseOutputDigest,
  computeC137PerformanceEnvironmentDigestV2,
  createC137PerformanceEvidenceDraftV2,
  createC137PerformancePlanDigest,
  finalizeC137PerformanceEvidenceV2,
  C137_PERFORMANCE_MAX_CASES_PER_RUN,
  validateC137PerformanceEvidence,
  type C137PerformanceCacheResetReceiptV2,
  type C137PerformanceEnvironmentV2,
  type C137PerformanceEvidenceDraftV2,
  type C137PerformanceEvidenceStatus,
  type C137PerformanceNativeTelemetryV2,
  type C137PerformancePlanV1,
  type C137PerformanceRawEvidenceV2,
  type C137PerformanceTrialV2
} from "../../domain/alignment/c137PerformanceEvidence";
import type { RealMediaBenchmarkManifest } from "../../domain/alignment/realMediaBenchmark";
import {
  discloseKnownAlignmentFailure,
  type SafeAlignmentFailureDisclosure
} from "./safeAlignmentFailureDisclosure";
import {
  createRealMediaBenchmarkAlignmentRequest,
  createRealMediaBenchmarkRunManifestDigest,
  projectRealMediaBenchmarkRunManifest,
  validateRealMediaBenchmarkProposalBinding,
  type RealMediaBenchmarkBlindCase,
  type RealMediaBenchmarkRunManifest,
  type RealMediaBenchmarkRunnerOptions
} from "./realMediaBenchmarkRunner";
import {
  preflightRealMediaBenchmark,
  type RealMediaBenchmarkPreflightOptions
} from "./realMediaBenchmarkPreflight";
import {
  beginAlignmentBenchmarkSession,
  cancelAlignmentBenchmarkJob,
  createAlignmentBenchmarkRunManifestCanonicalJson,
  finishAlignmentBenchmarkSession,
  getAlignmentBenchmarkJob,
  isAlignmentBenchmarkJobFinished,
  resetAlignmentBenchmarkCaches,
  startAlignmentBenchmarkJob,
  type AlignmentBenchmarkCacheCounts,
  type AlignmentBenchmarkCacheCounter,
  type AlignmentBenchmarkCacheResetReceipt,
  type AlignmentBenchmarkEnvironmentReceipt,
  type AlignmentBenchmarkInvoker,
  type AlignmentBenchmarkJobSnapshot,
  type AlignmentBenchmarkJobTelemetry,
  type AlignmentBenchmarkSessionSnapshot,
  type AlignmentBenchmarkStageTiming
} from "./tauriAlignmentBenchmark";
import {
  sealC137PerformanceRawEvidence,
  type C137ProcessAttestationInvoker,
  type C137ProcessEvidenceBindingV1
} from "./tauriC137ProcessAttestation";

export const REAL_MEDIA_PERFORMANCE_COLLECTOR_VERSION =
  "c137-native-performance-collector-v2" as const;

export type RealMediaPerformanceTrialKind = "cold" | "warmup" | "hot" | "cancellation";

export interface RealMediaPerformancePlanTrial {
  trialId: string;
  kind: RealMediaPerformanceTrialKind;
  repetition: number;
  warmupTrialId: string | null;
  cancellationStageKey: AudioAlignmentStageKey | null;
  cancellationCaseOrdinal: number | null;
}

export interface RealMediaPerformanceAlgorithmParameters {
  spectralBackend: SpectralBackendPreference;
  sampleRate: number | null;
  windowMs: number | null;
  matchThreshold: number | null;
  minGapMs: number | null;
  maxCells: number | null;
  enableVisualEvidence: boolean | null;
  visualSampleIntervalMs: number | null;
}

/** A pre-registered execution plan. The runner refuses to invent or drop trials at runtime. */
export interface RealMediaPerformanceExecutionPlan {
  schemaVersion: 1;
  planId: string;
  workloadDigest: C137Digest;
  expectedCaseCount: number;
  trialOrder: RealMediaPerformancePlanTrial[];
  requiredStageKeys: AudioAlignmentStageKey[];
  memorySampleIntervalMs: number;
  maximumMemorySampleGapMs: number;
  outputCanonicalization: "c137-time-map-output-digest-v1";
  parameters: RealMediaPerformanceAlgorithmParameters;
}

export interface RealMediaPerformancePreflightReceipt {
  ok: boolean;
  realRelationCount: number;
  checkedFileCount: number;
  issueCodes: string[];
}

export interface RealMediaPerformanceCaseEvidence {
  caseOrdinal: number;
  jobId: string;
  status: "completed" | "failed" | "cancelled";
  requestParametersDigest: C137Digest;
  timeMapParametersHash: string | null;
  timeMapDigest: C137Digest | null;
  outputDigest: C137Digest | null;
  telemetry: AlignmentBenchmarkJobTelemetry;
}

export interface RealMediaPerformanceStageEvidence extends AlignmentBenchmarkStageTiming {
  caseOrdinal: number;
  jobId: string;
}

export interface RealMediaPerformanceCacheEvidence {
  generation: number;
  resetReceiptDigest: C137Digest | null;
  before: AlignmentBenchmarkCacheCounts;
  after: AlignmentBenchmarkCacheCounts;
  audioFeatures: AlignmentBenchmarkCacheCounter;
  landmarks: AlignmentBenchmarkCacheCounter;
  visualFeatures: AlignmentBenchmarkCacheCounter;
  warmupTrialId: string | null;
}

export interface RealMediaPerformanceMemoryEvidence {
  scope: "application-process-tree";
  sampleIntervalMs: number;
  sampleCount: number;
  failedSampleCount: number;
  maximumSampleGapMs: number;
  peakProcessTreeRssBytes: number | null;
  coverageComplete: boolean;
  processTreeEmptyAtTerminal: boolean;
  residualProcessCount: number;
}

export interface RealMediaPerformanceRunEvidence {
  trialId: string;
  kind: "cold" | "warmup" | "hot";
  repetition: number;
  sessionId: string;
  workloadDigest: C137Digest;
  status: "completed" | "failed" | "cancelled";
  startTickNs: string;
  endTickNs: string;
  elapsedMs: number;
  stages: RealMediaPerformanceStageEvidence[];
  cache: RealMediaPerformanceCacheEvidence;
  memory: RealMediaPerformanceMemoryEvidence;
  outputDigest: C137Digest | null;
  cases: RealMediaPerformanceCaseEvidence[];
}

export interface RealMediaPerformanceCancellationEvidence {
  trialId: string;
  repetition: number;
  sessionId: string;
  workloadDigest: C137Digest;
  caseOrdinal: number;
  jobId: string;
  triggerStageKey: AudioAlignmentStageKey;
  requestTickNs: string;
  terminalTickNs: string;
  latencyMs: number;
  commandAccepted: boolean;
  terminalStatus: "cancelled" | "completed" | "failed" | "timeout";
  processTreeEmpty: boolean;
  residualProcessCount: number;
  telemetry: AlignmentBenchmarkJobTelemetry;
}

export type RealMediaPerformanceTrialEvidence =
  | { kind: "run"; run: RealMediaPerformanceRunEvidence }
  | { kind: "cancellation"; cancellation: RealMediaPerformanceCancellationEvidence };

export type RealMediaPerformanceCollectionStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "cleanup-blocked"
  | "preflight-failed";

export interface RealMediaPerformanceCollectionJournal {
  collectorVersion: typeof REAL_MEDIA_PERFORMANCE_COLLECTOR_VERSION;
  status: RealMediaPerformanceCollectionStatus;
  plan: RealMediaPerformanceExecutionPlan;
  planDigest: C137Digest;
  preflight: RealMediaPerformancePreflightReceipt;
  session: AlignmentBenchmarkSessionSnapshot | null;
  environment: AlignmentBenchmarkEnvironmentReceipt | null;
  cacheResets: AlignmentBenchmarkCacheResetReceipt[];
  trials: RealMediaPerformanceTrialEvidence[];
  terminalSessionStatus: AlignmentBenchmarkSessionSnapshot["status"] | null;
  terminalSession: AlignmentBenchmarkSessionSnapshot | null;
  failure: SafeAlignmentFailureDisclosure | null;
  issueCodes: string[];
}

export interface RealMediaPerformanceRunnerOptions {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  spectralBackend?: SpectralBackendPreference;
  signal?: AbortSignal;
  preflightOptions?: Omit<
    RealMediaBenchmarkPreflightOptions,
    "ffmpegPath" | "ffprobePath" | "signal"
  >;
  benchmarkInvoker?: AlignmentBenchmarkInvoker;
  pollIntervalMs?: number;
  watchdogWallMs?: number;
  cancellationGraceMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  onProgress?: (progress: RealMediaPerformanceProgress) => void;
}

export type RealMediaPerformancePhase =
  | "acquiring-session"
  | "preflight"
  | "resetting-cache"
  | "running-cold"
  | "running-warmup"
  | "running-hot"
  | "running-cancellation"
  | "cleaning-up"
  | "completed";

export interface RealMediaPerformanceProgress {
  phase: RealMediaPerformancePhase;
  trialId: string | null;
  trialIndex: number;
  trialCount: number;
}

interface JobExecutionResult {
  snapshot: AlignmentBenchmarkJobSnapshot | null;
  state: "terminal" | "start-failed" | "terminal-unknown" | "timeout";
  userCancelled: boolean;
}

type PerformanceRunnerOptionsWithWorkload = RealMediaBenchmarkRunnerOptions & {
  performanceWorkloadDigest: C137Digest;
};

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_WATCHDOG_WALL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_CANCELLATION_GRACE_MS = 30_000;

export function createRealMediaPerformanceWorkloadDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return createRealMediaBenchmarkRunManifestDigest(
    projectRealMediaBenchmarkRunManifest(manifest)
  ) as C137Digest;
}

/**
 * Converts the in-memory collection journal to the strict, path-free raw evidence envelope.
 * This does not create trust: the resulting file always remains releaseEligible=false and still
 * needs an independently approved protocol/evidence digest before C137 acceptance can consume it.
 */
export function createC137PerformanceRawEvidenceFromJournal(
  journal: RealMediaPerformanceCollectionJournal
): C137PerformanceRawEvidenceV2 {
  if (!journal.session || !journal.environment) {
    throw new Error("没有原生 session/environment receipt，不能生成性能 raw evidence。");
  }
  const plan = toRawPerformancePlan(journal.plan);
  if (journal.planDigest !== createC137PerformancePlanDigest(plan)) {
    throw new Error("性能 journal 的预注册 plan digest 与采集后计划不一致。");
  }
  const environment = toRawPerformanceEnvironment(journal.environment);
  const resetTrials = plan.trialOrder.filter(
    (trial) => trial.kind === "cold" || trial.kind === "cancellation"
  );
  const rawResets = journal.cacheResets.map((receipt, index) =>
    toRawCacheResetReceipt(
      receipt,
      resetTrials[index]?.trialId ?? `unmatched-reset-${index + 1}`
    )
  );
  const resetByTrial = new Map(rawResets.map((receipt) => [receipt.trialId, receipt]));
  let draft: C137PerformanceEvidenceDraftV2 = createC137PerformanceEvidenceDraftV2({
    runManifestDigest: environment.workloadStorage.runManifestDigest,
    plan,
    environment,
    collector: {
      schemaVersion: 2,
      collectorVersion: `${journal.collectorVersion}+${journal.environment.collectorVersion}`,
      nativeSchemaVersion: 2,
      clock: "rust-std-instant-session-relative-v1",
      memoryScope: "application-process-tree",
      sampler: findJournalSampler(journal),
      sessionId: journal.session.sessionId,
      sessionOriginTickNs: journal.session.sessionOriginTickNs,
      memorySampleIntervalMs: journal.session.memorySampleIntervalMs,
      terminalSessionStatus:
        journal.terminalSessionStatus === "active" ? null : journal.terminalSessionStatus,
      runManifestDigest: environment.workloadStorage.runManifestDigest,
      workloadDigest: environment.workloadStorage.workloadDigest,
      workloadStorageReceiptDigest: environment.workloadStorage.receiptDigest
    },
    preflight: structuredClone(journal.preflight),
    jobMemoryReceipt:
      journal.terminalSession?.jobMemoryReceipt === null ||
      journal.terminalSession?.jobMemoryReceipt === undefined
        ? null
        : structuredClone(journal.terminalSession.jobMemoryReceipt),
    terminalCleanupReceipt:
      journal.terminalSession?.terminalCleanupReceipt === null ||
      journal.terminalSession?.terminalCleanupReceipt === undefined
        ? null
        : structuredClone(journal.terminalSession.terminalCleanupReceipt),
    status: toRawEvidenceStatus(journal.status),
    issueCodes: [...journal.issueCodes]
  });
  for (const reset of rawResets) {
    draft = appendC137PerformanceCacheResetReceiptV2(draft, reset);
  }
  for (const trial of journal.trials) {
    const rawTrial = toRawTrial(trial, resetByTrial);
    draft = appendC137PerformanceTrialV2(draft, rawTrial);
  }
  return finalizeC137PerformanceEvidenceV2(
    draft,
    toRawEvidenceStatus(journal.status),
    journal.issueCodes
  );
}

export async function sealC137PerformanceEvidenceForProcess(
  evidence: C137PerformanceRawEvidenceV2,
  liveProcessAttestationSessionId: string,
  invoker?: C137ProcessAttestationInvoker
): Promise<C137ProcessEvidenceBindingV1> {
  const validation = validateC137PerformanceEvidence(evidence);
  if (!validation.valid) {
    throw new Error(
      `性能 raw evidence 未通过严格校验，拒绝交给原生进程封存：${validation.issues.join(
        "；"
      )}`
    );
  }
  return sealC137PerformanceRawEvidence(
    liveProcessAttestationSessionId,
    evidence.collector.sessionId,
    evidence.evidenceDigest,
    invoker
  );
}

export function createEngineeringRealMediaPerformancePlan(
  manifest: RealMediaBenchmarkManifest,
  planId: string,
  spectralBackend: SpectralBackendPreference = "auto"
): RealMediaPerformanceExecutionPlan {
  assertPerformanceWorkloadCaseLimit(manifest);
  const normalizedPlanId = requireOpaqueId(planId, "planId");
  return {
    schemaVersion: 1,
    planId: normalizedPlanId,
    workloadDigest: createRealMediaPerformanceWorkloadDigest(manifest),
    expectedCaseCount: projectRealMediaBenchmarkRunManifest(manifest).cases.length,
    trialOrder: [
      createPlanTrial(`${normalizedPlanId}-cold-1`, "cold", 1),
      createPlanTrial(`${normalizedPlanId}-warmup-1`, "warmup", 1),
      {
        ...createPlanTrial(`${normalizedPlanId}-hot-1`, "hot", 1),
        warmupTrialId: `${normalizedPlanId}-warmup-1`
      },
      {
        ...createPlanTrial(`${normalizedPlanId}-cancel-1`, "cancellation", 1),
        cancellationStageKey: "extracting-source",
        cancellationCaseOrdinal: 0
      }
    ],
    requiredStageKeys: [
      "validating",
      "extracting-complete",
      "extracting-source",
      "matching",
      "fitting",
      "refining",
      "reporting"
    ],
    memorySampleIntervalMs: 20,
    maximumMemorySampleGapMs: 60,
    outputCanonicalization: "c137-time-map-output-digest-v1",
    parameters: {
      spectralBackend: normalizeTauriSpectralBackendPreference(spectralBackend),
      sampleRate: null,
      windowMs: null,
      matchThreshold: null,
      minGapMs: null,
      maxCells: null,
      enableVisualEvidence: null,
      visualSampleIntervalMs: null
    }
  };
}

export async function collectRealMediaPerformanceEvidence(
  manifest: RealMediaBenchmarkManifest,
  plan: RealMediaPerformanceExecutionPlan,
  options: RealMediaPerformanceRunnerOptions = {}
): Promise<RealMediaPerformanceCollectionJournal> {
  assertPerformanceWorkloadCaseLimit(manifest);
  const executionOptions = createExecutionOptionsSnapshot(options);
  const manifestSnapshot = deepFreeze(structuredClone(manifest));
  const planSnapshot = deepFreeze(clonePlan(plan));
  const planIssues = validateExecutionPlan(planSnapshot, manifestSnapshot);
  if (planIssues.length > 0) {
    throw new Error(`C137 性能运行计划无效：${planIssues.join("；")}`);
  }
  if (planSnapshot.parameters.spectralBackend !== executionOptions.spectralBackend) {
    throw new Error("C137 性能运行计划的声谱计算策略与采集请求不一致。");
  }
  const runManifest = deepFreeze(projectRealMediaBenchmarkRunManifest(manifestSnapshot));
  const journal: RealMediaPerformanceCollectionJournal = {
    collectorVersion: REAL_MEDIA_PERFORMANCE_COLLECTOR_VERSION,
    status: "failed",
    plan: planSnapshot,
    planDigest: computeC137CanonicalDigest({
      domain: "c137-performance-plan-v1",
      plan: planSnapshot
    }),
    preflight: {
      ok: false,
      realRelationCount: runManifest.cases.length,
      checkedFileCount: 0,
      issueCodes: []
    },
    session: null,
    environment: null,
    cacheResets: [],
    trials: [],
    terminalSessionStatus: null,
    terminalSession: null,
    failure: null,
    issueCodes: []
  };
  if (manifestSnapshot.isExample || runManifest.cases.length === 0) {
    journal.status = "preflight-failed";
    journal.issueCodes.push(
      manifestSnapshot.isExample ? "example-manifest" : "no-real-relations"
    );
    return journal;
  }
  const runManifestCanonicalJson = createAlignmentBenchmarkRunManifestCanonicalJson(runManifest);
  const runManifestDigest = createRealMediaBenchmarkRunManifestDigest(runManifest) as C137Digest;
  const beginRequest = Object.freeze({
    schemaVersion: 2 as const,
    ffmpegPath: executionOptions.ffmpegPath ?? null,
    ffprobePath: executionOptions.ffprobePath ?? null,
    memorySampleIntervalMs: planSnapshot.memorySampleIntervalMs,
    runManifestCanonicalJson,
    runManifestDigest,
    workloadDigest: planSnapshot.workloadDigest
  });

  let session: AlignmentBenchmarkSessionSnapshot | null = null;
  const activeJobRef: { current: AlignmentBenchmarkJobSnapshot | null } = { current: null };
  const wait = executionOptions.wait ?? defaultWait;
  const now = executionOptions.now ?? defaultNow;
  try {
    emitProgress(
      executionOptions,
      "acquiring-session",
      null,
      0,
      planSnapshot.trialOrder.length
    );
    session = await beginAlignmentBenchmarkSession(
      beginRequest,
      executionOptions.benchmarkInvoker
    );
    journal.session = cloneSessionSnapshot(session);
    journal.environment = structuredClone(session.environment);
    if (!sessionWorkloadStorageMatchesRunManifest(session, runManifest, runManifestDigest)) {
      journal.issueCodes.push("workload-storage-receipt-mismatch");
      return journal;
    }
    if (session.environment.measurementStatus !== "complete") {
      journal.issueCodes.push("environment-incomplete");
    }

    emitProgress(executionOptions, "preflight", null, 0, planSnapshot.trialOrder.length);
    const preflight = await preflightRealMediaBenchmark(manifestSnapshot, {
      ...executionOptions.preflightOptions,
      ffmpegPath: executionOptions.ffmpegPath,
      ffprobePath: executionOptions.ffprobePath,
      signal: executionOptions.signal
    });
    journal.preflight = {
      ok: preflight.ok,
      realRelationCount: preflight.realRelationCount,
      checkedFileCount: preflight.checkedFileCount,
      issueCodes: [...new Set(preflight.issues.map((issue) => issue.code))]
    };
    if (!preflight.ok) {
      journal.status = "preflight-failed";
      journal.issueCodes.push("preflight-failed");
      return journal;
    }

    const runOptions = createProductionRunnerOptions(planSnapshot, executionOptions);
    let lastReset: AlignmentBenchmarkCacheResetReceipt | null = null;
    for (const [trialIndex, trial] of planSnapshot.trialOrder.entries()) {
      if (executionOptions.signal?.aborted) {
        journal.status = "cancelled";
        journal.issueCodes.push("user-cancelled");
        break;
      }
      if (trial.kind === "cold" || trial.kind === "cancellation") {
        emitProgress(
          executionOptions,
          "resetting-cache",
          trial.trialId,
          trialIndex,
          planSnapshot.trialOrder.length
        );
        try {
          lastReset = await resetAlignmentBenchmarkCaches(
            session.sessionId,
            executionOptions.benchmarkInvoker
          );
          journal.cacheResets.push(structuredClone(lastReset));
        } catch {
          journal.status = "failed";
          journal.issueCodes.push("cache-reset-failed");
          break;
        }
      }

      if (trial.kind === "cancellation") {
        emitProgress(
          executionOptions,
          "running-cancellation",
          trial.trialId,
          trialIndex,
          planSnapshot.trialOrder.length
        );
        const cancellation = await executeCancellationTrial(
          runManifest.cases[trial.cancellationCaseOrdinal ?? 0],
          trial,
          session,
          runOptions,
          executionOptions,
          (snapshot) => {
            activeJobRef.current = snapshot;
          },
          wait,
          now
        );
        if (cancellation === null) {
          journal.status = executionOptions.signal?.aborted ? "cancelled" : "failed";
          journal.issueCodes.push(
            executionOptions.signal?.aborted
              ? "user-cancelled"
              : "cancellation-trial-failed"
          );
          break;
        }
        if (executionOptions.signal?.aborted) {
          activeJobRef.current = null;
          journal.status = "cancelled";
          journal.issueCodes.push("user-cancelled");
          break;
        }
        journal.trials.push({ kind: "cancellation", cancellation });
        activeJobRef.current = null;
        if (
          cancellation.terminalStatus !== "cancelled" ||
          !cancellation.processTreeEmpty ||
          cancellation.residualProcessCount !== 0
        ) {
          journal.status = "failed";
          journal.issueCodes.push("cancellation-not-clean");
          break;
        }
        continue;
      }

      const measuredTrial = trial as RealMediaPerformancePlanTrial & {
        kind: "cold" | "warmup" | "hot";
      };
      emitProgress(
        executionOptions,
        measuredTrial.kind === "cold"
          ? "running-cold"
          : measuredTrial.kind === "warmup"
            ? "running-warmup"
            : "running-hot",
        measuredTrial.trialId,
        trialIndex,
        planSnapshot.trialOrder.length
      );
      const run = await executeMeasuredRun(
        runManifest.cases,
        measuredTrial,
        session,
        runOptions,
        lastReset,
        executionOptions,
        (snapshot) => {
          activeJobRef.current = snapshot;
        },
        wait,
        now
      );
      journal.trials.push({ kind: "run", run });
      if (run.status !== "completed") {
        journal.status = run.status === "cancelled" ? "cancelled" : "failed";
        journal.issueCodes.push(`trial-${run.status}`);
        break;
      }
      lastReset = null;
    }

    if (executionOptions.signal?.aborted) {
      journal.status = "cancelled";
      journal.issueCodes.push("user-cancelled");
    } else if (
      journal.trials.length === planSnapshot.trialOrder.length &&
      journal.trials.every((trial) =>
        trial.kind === "run"
          ? trial.run.status === "completed"
          : trial.cancellation.terminalStatus === "cancelled"
      )
    ) {
      journal.status = "completed";
    }
  } catch (error: unknown) {
    const disclosure = discloseKnownAlignmentFailure(error);
    if (disclosure) {
      journal.failure = disclosure;
    }
    journal.status = executionOptions.signal?.aborted ? "cancelled" : "failed";
    journal.issueCodes.push(
      disclosure?.code ??
      (activeJobRef.current &&
        !isAlignmentBenchmarkJobFinished(activeJobRef.current.status)
        ? "native-terminal-unknown"
        : "collector-exception")
    );
  } finally {
    if (session) {
      emitProgress(
        executionOptions,
        "cleaning-up",
        null,
        planSnapshot.trialOrder.length,
        planSnapshot.trialOrder.length
      );
      const activeJob = activeJobRef.current;
      if (activeJob && !isAlignmentBenchmarkJobFinished(activeJob.status)) {
        await bestEffortCancelAndWait(
          session.sessionId,
          activeJob.jobId,
          executionOptions,
          wait,
          now
        );
      }
      try {
        const terminalSession = await finishAlignmentBenchmarkSession(
          session.sessionId,
          executionOptions.benchmarkInvoker
        );
        journal.terminalSessionStatus = terminalSession.status;
        journal.terminalSession = cloneSessionSnapshot(terminalSession);
        if (terminalSession.status === "cleanup-blocked") {
          journal.status = "cleanup-blocked";
          journal.issueCodes.push("cleanup-blocked");
        }
      } catch {
        journal.status = "cleanup-blocked";
        journal.issueCodes.push("cleanup-terminal-unknown");
      }
    }
  }
  journal.issueCodes = [...new Set(journal.issueCodes)];
  emitProgress(
    executionOptions,
    "completed",
    null,
    planSnapshot.trialOrder.length,
    planSnapshot.trialOrder.length
  );
  return journal;
}

async function executeMeasuredRun(
  cases: RealMediaBenchmarkBlindCase[],
  trial: RealMediaPerformancePlanTrial & { kind: "cold" | "warmup" | "hot" },
  session: AlignmentBenchmarkSessionSnapshot,
  runnerOptions: PerformanceRunnerOptionsWithWorkload,
  resetReceipt: AlignmentBenchmarkCacheResetReceipt | null,
  options: RealMediaPerformanceRunnerOptions,
  onActiveJob: (snapshot: AlignmentBenchmarkJobSnapshot | null) => void,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number
): Promise<RealMediaPerformanceRunEvidence> {
  const evidence: RealMediaPerformanceCaseEvidence[] = [];
  for (const [caseOrdinal, benchmarkCase] of cases.entries()) {
    if (options.signal?.aborted) {
      return createIncompleteRun(
        trial,
        session,
        evidence,
        resetReceipt,
        runnerOptions.performanceWorkloadDigest,
        "cancelled"
      );
    }
    const request = createRealMediaBenchmarkAlignmentRequest(benchmarkCase, runnerOptions);
    const requestParametersDigest = createPerformanceRequestParametersDigest(
      runnerOptions.performanceWorkloadDigest,
      caseOrdinal,
      request
    );
    const execution = await executeJobToTerminal(
      request,
      session.sessionId,
      options,
      onActiveJob,
      wait,
      now
    );
    const snapshot = execution.snapshot;
    if (!snapshot) {
      return createIncompleteRun(
        trial,
        session,
        evidence,
        resetReceipt,
        runnerOptions.performanceWorkloadDigest,
        execution.userCancelled ? "cancelled" : "failed"
      );
    }
    const status = normalizeTerminalStatus(snapshot.status);
    const terminalDisclosure = discloseKnownAlignmentFailure(snapshot.errorCode);
    if (terminalDisclosure) {
      throw new Error(terminalDisclosure.code);
    }
    let timeMapParametersHash: string | null = null;
    let timeMapDigest: C137Digest | null = null;
    let outputDigest: C137Digest | null = null;
    if (status === "completed" && snapshot.proposal) {
      const bindingFailure = validateRealMediaBenchmarkProposalBinding(
        benchmarkCase,
        snapshot.proposal,
        runnerOptions
      );
      const timeMap = snapshot.proposal.timeMap;
      const normalizedParametersHash = normalizeTimeMapParametersHash(
        timeMap?.parametersHash
      );
      if (bindingFailure === null && timeMap && normalizedParametersHash !== null) {
        timeMapParametersHash = normalizedParametersHash;
        timeMapDigest = computeC137CanonicalDigest({
          domain: "c137-time-map-content-v1",
          engineVersion: timeMap.engineVersion,
          featureVersion: timeMap.featureVersion,
          spans: timeMap.spans
        });
        outputDigest = computeC137PerformanceCaseOutputDigest({
          caseOrdinal,
          requestParametersDigest,
          timeMapParametersHash,
          timeMapDigest
        });
      }
    }
    evidence.push({
      caseOrdinal,
      jobId: snapshot.jobId,
      status: outputDigest === null && status === "completed" ? "failed" : status,
      requestParametersDigest,
      timeMapParametersHash,
      timeMapDigest,
      outputDigest,
      telemetry: structuredClone(snapshot.telemetry)
    });
    onActiveJob(null);
    if (evidence.at(-1)?.status !== "completed") break;
  }
  return finalizeMeasuredRun(
    trial,
    session,
    evidence,
    resetReceipt,
    runnerOptions.performanceWorkloadDigest
  );
}

async function executeCancellationTrial(
  benchmarkCase: RealMediaBenchmarkBlindCase,
  trial: RealMediaPerformancePlanTrial,
  session: AlignmentBenchmarkSessionSnapshot,
  runnerOptions: PerformanceRunnerOptionsWithWorkload,
  options: RealMediaPerformanceRunnerOptions,
  onActiveJob: (snapshot: AlignmentBenchmarkJobSnapshot | null) => void,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number
): Promise<RealMediaPerformanceCancellationEvidence | null> {
  const triggerStageKey = trial.cancellationStageKey;
  const caseOrdinal = trial.cancellationCaseOrdinal;
  if (!triggerStageKey || caseOrdinal === null) return null;
  let snapshot: AlignmentBenchmarkJobSnapshot;
  try {
    snapshot = await startAlignmentBenchmarkJob(
      session.sessionId,
      createRealMediaBenchmarkAlignmentRequest(benchmarkCase, runnerOptions),
      options.benchmarkInvoker
    );
    onActiveJob(snapshot);
  } catch (error: unknown) {
    const disclosure = discloseKnownAlignmentFailure(error);
    if (disclosure) throw new Error(disclosure.code);
    return null;
  }
  const watchdogStartedAt = now();
  let requested = false;
  let cancellationStartedAt: number | null = null;
  let timedOut = false;
  while (!isAlignmentBenchmarkJobFinished(snapshot.status)) {
    if (!requested && (snapshot.stageKey === triggerStageKey || options.signal?.aborted)) {
      try {
        snapshot = await cancelAlignmentBenchmarkJob(
          session.sessionId,
          snapshot.jobId,
          options.benchmarkInvoker
        );
        requested = true;
        cancellationStartedAt = now();
        onActiveJob(snapshot);
      } catch {
        return null;
      }
    }
    if (!requested && now() - watchdogStartedAt >= (options.watchdogWallMs ?? DEFAULT_WATCHDOG_WALL_MS)) {
      timedOut = true;
      try {
        snapshot = await cancelAlignmentBenchmarkJob(
          session.sessionId,
          snapshot.jobId,
          options.benchmarkInvoker
        );
        requested = true;
        cancellationStartedAt = now();
      } catch {
        return null;
      }
    }
    if (
      requested &&
      cancellationStartedAt !== null &&
      now() - cancellationStartedAt >=
        (options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS)
    ) {
      return null;
    }
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    try {
      snapshot = await getAlignmentBenchmarkJob(
        session.sessionId,
        snapshot.jobId,
        options.benchmarkInvoker
      );
      onActiveJob(snapshot);
    } catch {
      return null;
    }
  }
  const cancellation = snapshot.telemetry.cancellation;
  if (!requested || !cancellation) return null;
  return {
    trialId: trial.trialId,
    repetition: trial.repetition,
    sessionId: session.sessionId,
    workloadDigest: runnerOptions.performanceWorkloadDigest,
    caseOrdinal,
    jobId: snapshot.jobId,
    triggerStageKey,
    requestTickNs: cancellation.requestTickNs,
    terminalTickNs: cancellation.terminalTickNs,
    latencyMs: cancellation.latencyMs,
    commandAccepted: cancellation.commandAccepted,
    terminalStatus: timedOut ? "timeout" : normalizeCancellationTerminal(snapshot.status),
    processTreeEmpty: snapshot.telemetry.memory.processTreeEmptyAtTerminal,
    residualProcessCount: snapshot.telemetry.memory.residualProcessCount,
    telemetry: structuredClone(snapshot.telemetry)
  };
}

async function executeJobToTerminal(
  request: TauriAudioAlignmentRequest,
  sessionId: string,
  options: RealMediaPerformanceRunnerOptions,
  onActiveJob: (snapshot: AlignmentBenchmarkJobSnapshot | null) => void,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number
): Promise<JobExecutionResult> {
  let snapshot: AlignmentBenchmarkJobSnapshot;
  try {
    snapshot = await startAlignmentBenchmarkJob(
      sessionId,
      request,
      options.benchmarkInvoker
    );
    onActiveJob(snapshot);
  } catch (error: unknown) {
    const disclosure = discloseKnownAlignmentFailure(error);
    if (disclosure) throw new Error(disclosure.code);
    return { snapshot: null, state: "start-failed", userCancelled: false };
  }
  const watchdogStartedAt = now();
  let cancellationRequested = false;
  let cancellationStartedAt: number | null = null;
  let timedOut = false;
  while (!isAlignmentBenchmarkJobFinished(snapshot.status)) {
    if (
      !cancellationRequested &&
      (options.signal?.aborted ||
        now() - watchdogStartedAt >= (options.watchdogWallMs ?? DEFAULT_WATCHDOG_WALL_MS))
    ) {
      timedOut = !options.signal?.aborted;
      try {
        snapshot = await cancelAlignmentBenchmarkJob(
          sessionId,
          snapshot.jobId,
          options.benchmarkInvoker
        );
        cancellationRequested = true;
        cancellationStartedAt = now();
        onActiveJob(snapshot);
      } catch {
        return { snapshot: null, state: "terminal-unknown", userCancelled: !!options.signal?.aborted };
      }
    }
    if (
      cancellationRequested &&
      cancellationStartedAt !== null &&
      now() - cancellationStartedAt >=
        (options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS)
    ) {
      return {
        snapshot: null,
        state: "terminal-unknown",
        userCancelled: !!options.signal?.aborted
      };
    }
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    try {
      snapshot = await getAlignmentBenchmarkJob(
        sessionId,
        snapshot.jobId,
        options.benchmarkInvoker
      );
      onActiveJob(snapshot);
    } catch {
      return { snapshot: null, state: "terminal-unknown", userCancelled: !!options.signal?.aborted };
    }
  }
  return {
    snapshot,
    state: timedOut ? "timeout" : "terminal",
    userCancelled: cancellationRequested && !!options.signal?.aborted
  };
}

function finalizeMeasuredRun(
  trial: RealMediaPerformancePlanTrial & { kind: "cold" | "warmup" | "hot" },
  session: AlignmentBenchmarkSessionSnapshot,
  cases: RealMediaPerformanceCaseEvidence[],
  resetReceipt: AlignmentBenchmarkCacheResetReceipt | null,
  workloadDigest: C137Digest
): RealMediaPerformanceRunEvidence {
  const completed = cases.length > 0 && cases.every((item) => item.status === "completed");
  const cancelled = cases.some((item) => item.status === "cancelled");
  const terminalCases = cases.filter((item) => item.telemetry.endTickNs !== null);
  const first = terminalCases[0];
  const last = terminalCases.at(-1);
  const startTickNs = first?.telemetry.startTickNs ?? "0";
  const endTickNs = last?.telemetry.endTickNs ?? startTickNs;
  const outputDigest = completed
    ? computeC137CanonicalDigest({
        domain: "c137-time-map-output-suite-v1",
        cases: cases.map((item) => ({ caseOrdinal: item.caseOrdinal, digest: item.outputDigest }))
      })
    : null;
  return {
    trialId: trial.trialId,
    kind: trial.kind,
    repetition: trial.repetition,
    sessionId: session.sessionId,
    workloadDigest,
    status: completed ? "completed" : cancelled ? "cancelled" : "failed",
    startTickNs,
    endTickNs,
    elapsedMs: elapsedTicksMs(startTickNs, endTickNs),
    stages: cases.flatMap((item) =>
      item.telemetry.stages.map((stage) => ({
        ...structuredClone(stage),
        caseOrdinal: item.caseOrdinal,
        jobId: item.jobId
      }))
    ),
    cache: aggregateCacheEvidence(cases, resetReceipt, trial.warmupTrialId),
    memory: aggregateMemoryEvidence(cases),
    outputDigest,
    cases
  };
}

function createIncompleteRun(
  trial: RealMediaPerformancePlanTrial & { kind: "cold" | "warmup" | "hot" },
  session: AlignmentBenchmarkSessionSnapshot,
  cases: RealMediaPerformanceCaseEvidence[],
  resetReceipt: AlignmentBenchmarkCacheResetReceipt | null,
  workloadDigest: C137Digest,
  status: "failed" | "cancelled"
): RealMediaPerformanceRunEvidence {
  const partial = finalizeMeasuredRun(
    trial,
    session,
    cases,
    resetReceipt,
    workloadDigest
  );
  return { ...partial, status, outputDigest: null };
}

function aggregateCacheEvidence(
  cases: RealMediaPerformanceCaseEvidence[],
  resetReceipt: AlignmentBenchmarkCacheResetReceipt | null,
  warmupTrialId: string | null
): RealMediaPerformanceCacheEvidence {
  const first = cases[0]?.telemetry.cache;
  const last = cases.at(-1)?.telemetry.cache;
  return {
    generation: first?.generation ?? resetReceipt?.cacheGeneration ?? 0,
    resetReceiptDigest: resetReceipt
      ? computeC137CanonicalDigest({ domain: "c137-cache-reset-receipt-v1", resetReceipt })
      : null,
    before: structuredClone(first?.before ?? emptyCacheCounts()),
    after: structuredClone(last?.after ?? emptyCacheCounts()),
    audioFeatures: sumCacheCounter(cases, "audioFeatures"),
    landmarks: sumCacheCounter(cases, "landmarks"),
    visualFeatures: sumCacheCounter(cases, "visualFeatures"),
    warmupTrialId
  };
}

function aggregateMemoryEvidence(
  cases: RealMediaPerformanceCaseEvidence[]
): RealMediaPerformanceMemoryEvidence {
  const memories = cases.map((item) => item.telemetry.memory);
  const peaks = memories.map((item) => item.peakProcessTreeRssBytes);
  return {
    scope: "application-process-tree",
    sampleIntervalMs: maximum(memories.map((item) => item.sampleIntervalMs)) ?? 0,
    sampleCount: sum(memories.map((item) => item.sampleCount)),
    failedSampleCount: sum(memories.map((item) => item.failedSampleCount)),
    maximumSampleGapMs: maximum(memories.map((item) => item.maximumSampleGapMs)) ?? 0,
    peakProcessTreeRssBytes: peaks.every((item) => item !== null)
      ? maximum(peaks)
      : null,
    coverageComplete: memories.length > 0 && memories.every((item) => item.coverageComplete),
    processTreeEmptyAtTerminal:
      memories.length > 0 && memories.every((item) => item.processTreeEmptyAtTerminal),
    residualProcessCount: maximum(memories.map((item) => item.residualProcessCount)) ?? 0
  };
}

function sumCacheCounter(
  cases: RealMediaPerformanceCaseEvidence[],
  key: "audioFeatures" | "landmarks" | "visualFeatures"
): AlignmentBenchmarkCacheCounter {
  return cases.reduce<AlignmentBenchmarkCacheCounter>(
    (total, item) => {
      const counter = item.telemetry.cache[key];
      return {
        hits: total.hits + counter.hits,
        misses: total.misses + counter.misses,
        writes: total.writes + counter.writes,
        evictions: total.evictions + counter.evictions
      };
    },
    { hits: 0, misses: 0, writes: 0, evictions: 0 }
  );
}

function validateExecutionPlan(
  plan: RealMediaPerformanceExecutionPlan,
  manifest: RealMediaBenchmarkManifest
): string[] {
  const issues: string[] = [];
  if (plan.schemaVersion !== 1) issues.push("schemaVersion 必须为 1");
  try {
    requireOpaqueId(plan.planId, "planId");
  } catch (error: unknown) {
    issues.push(error instanceof Error ? error.message : "planId 无效");
  }
  if (plan.workloadDigest !== createRealMediaPerformanceWorkloadDigest(manifest)) {
    issues.push("workloadDigest 与 blind 运行投影不一致");
  }
  if (
    !Number.isSafeInteger(plan.expectedCaseCount) ||
    plan.expectedCaseCount < 0 ||
    plan.expectedCaseCount > C137_PERFORMANCE_MAX_CASES_PER_RUN ||
    (!manifest.isExample && plan.expectedCaseCount === 0) ||
    plan.expectedCaseCount !== projectRealMediaBenchmarkRunManifest(manifest).cases.length
  ) {
    issues.push(
      `expectedCaseCount 必须命中 blind 真实关系数且不超过 ${C137_PERFORMANCE_MAX_CASES_PER_RUN}`
    );
  }
  if (
    !Number.isSafeInteger(plan.memorySampleIntervalMs) ||
    plan.memorySampleIntervalMs < 10 ||
    plan.memorySampleIntervalMs > 1_000
  ) {
    issues.push("memorySampleIntervalMs 必须为 10–1000ms 安全整数");
  }
  if (
    !Number.isSafeInteger(plan.maximumMemorySampleGapMs) ||
    plan.maximumMemorySampleGapMs < plan.memorySampleIntervalMs ||
    plan.maximumMemorySampleGapMs > 10_000
  ) {
    issues.push("maximumMemorySampleGapMs 必须不小于采样间隔且不超过 10000ms");
  }
  if (plan.outputCanonicalization !== "c137-time-map-output-digest-v1") {
    issues.push("outputCanonicalization 不受支持");
  }
  if (
    plan.parameters.spectralBackend !== "auto" &&
    plan.parameters.spectralBackend !== "cuda" &&
    plan.parameters.spectralBackend !== "cpu"
  ) {
    issues.push("parameters.spectralBackend 仅支持 auto、cuda 或 cpu");
  }
  if (plan.trialOrder.length === 0 || plan.trialOrder.length > 64) {
    issues.push("trialOrder 数量必须为 1–64");
  }
  const trialIds = new Set<string>();
  const warmups = new Set<string>();
  let coldCount = 0;
  let hotCount = 0;
  let cancellationCount = 0;
  for (const [index, trial] of plan.trialOrder.entries()) {
    try {
      requireOpaqueId(trial.trialId, `trialOrder[${index}].trialId`);
    } catch (error: unknown) {
      issues.push(error instanceof Error ? error.message : `trial ${index} ID 无效`);
    }
    if (trialIds.has(trial.trialId)) issues.push(`trialId 重复：${trial.trialId}`);
    trialIds.add(trial.trialId);
    if (!Number.isSafeInteger(trial.repetition) || trial.repetition <= 0) {
      issues.push(`trial ${trial.trialId} repetition 无效`);
    }
    if (trial.kind === "cold") coldCount += 1;
    if (trial.kind === "warmup") warmups.add(trial.trialId);
    if (trial.kind === "hot") {
      hotCount += 1;
      if (!trial.warmupTrialId || !warmups.has(trial.warmupTrialId)) {
        issues.push(`hot trial ${trial.trialId} 没有绑定先前 warmup`);
      }
    }
    if (trial.kind === "cancellation") {
      cancellationCount += 1;
      if (!trial.cancellationStageKey) {
        issues.push(`cancellation trial ${trial.trialId} 缺 trigger stage`);
      }
      if (
        !manifest.isExample &&
        (!Number.isSafeInteger(trial.cancellationCaseOrdinal) ||
          (trial.cancellationCaseOrdinal ?? -1) < 0 ||
          (trial.cancellationCaseOrdinal ?? plan.expectedCaseCount) >=
            plan.expectedCaseCount)
      ) {
        issues.push(`cancellation trial ${trial.trialId} 的 caseOrdinal 无效`);
      }
    } else if (trial.cancellationStageKey !== null) {
      issues.push(`非 cancellation trial ${trial.trialId} 不得带 trigger stage`);
    } else if (trial.cancellationCaseOrdinal !== null) {
      issues.push(`非 cancellation trial ${trial.trialId} 不得带 cancellation case`);
    }
  }
  if (coldCount === 0 || hotCount === 0 || cancellationCount === 0) {
    issues.push("计划必须同时包含 cold、hot 与 cancellation trial");
  }
  if (new Set(plan.requiredStageKeys).size !== plan.requiredStageKeys.length) {
    issues.push("requiredStageKeys 不得重复");
  }
  return issues;
}

function sessionWorkloadStorageMatchesRunManifest(
  session: AlignmentBenchmarkSessionSnapshot,
  runManifest: RealMediaBenchmarkRunManifest,
  runManifestDigest: C137Digest
): boolean {
  const receipt = session.environment.workloadStorage;
  const expectedBindingCount = runManifest.cases.length * 2;
  return (
    session.environment.storageScope === "workload-media-volumes" &&
    receipt.runManifestDigest === runManifestDigest &&
    receipt.workloadDigest === runManifestDigest &&
    receipt.bindingCount === expectedBindingCount &&
    receipt.bindings.length === expectedBindingCount &&
    receipt.uniqueMediaCount > 0 &&
    receipt.uniqueMediaCount <= expectedBindingCount &&
    receipt.volumeCount > 0 &&
    receipt.volumeCount <= receipt.uniqueMediaCount &&
    receipt.volumes.length === receipt.volumeCount
  );
}

function createProductionRunnerOptions(
  plan: RealMediaPerformanceExecutionPlan,
  options: RealMediaPerformanceRunnerOptions
): PerformanceRunnerOptionsWithWorkload {
  return {
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    spectralBackend: options.spectralBackend,
    sampleRate: plan.parameters.sampleRate ?? undefined,
    windowMs: plan.parameters.windowMs ?? undefined,
    matchThreshold: plan.parameters.matchThreshold ?? undefined,
    minGapMs: plan.parameters.minGapMs ?? undefined,
    maxCells: plan.parameters.maxCells ?? undefined,
    enableVisualEvidence: plan.parameters.enableVisualEvidence ?? undefined,
    visualSampleIntervalMs: plan.parameters.visualSampleIntervalMs ?? undefined,
    performanceWorkloadDigest: plan.workloadDigest
  };
}

function createPerformanceRequestParametersDigest(
  workloadDigest: C137Digest,
  caseOrdinal: number,
  request: TauriAudioAlignmentRequest
): C137Digest {
  return computeC137CanonicalDigest({
    domain: "c137-performance-request-parameters-v1",
    workloadDigest,
    caseOrdinal,
    completeAudioStreamIndex: request.completeAudioStreamIndex ?? null,
    sourceAudioStreamIndex: request.sourceAudioStreamIndex ?? null,
    completeVideoStreamIndex: request.completeVideoStreamIndex ?? null,
    sourceVideoStreamIndex: request.sourceVideoStreamIndex ?? null,
    spectralBackend: normalizeTauriSpectralBackendPreference(request.spectralBackend),
    sampleRate: request.sampleRate ?? null,
    windowMs: request.windowMs ?? null,
    matchThreshold: request.matchThreshold ?? null,
    minGapMs: request.minGapMs ?? null,
    maxCells: request.maxCells ?? null,
    enableVisualEvidence: request.enableVisualEvidence ?? null,
    visualSampleIntervalMs: request.visualSampleIntervalMs ?? null,
    localizationMode: request.localizationMode ?? null
  });
}

function normalizeTimeMapParametersHash(value: unknown): string | null {
  return typeof value === "string" && /^fnv1a64:[0-9a-f]{16}$/.test(value)
    ? value
    : null;
}

async function bestEffortCancelAndWait(
  sessionId: string,
  jobId: string,
  options: RealMediaPerformanceRunnerOptions,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number
): Promise<void> {
  let snapshot: AlignmentBenchmarkJobSnapshot;
  try {
    snapshot = await cancelAlignmentBenchmarkJob(sessionId, jobId, options.benchmarkInvoker);
  } catch {
    return;
  }
  const startedAt = now();
  while (
    !isAlignmentBenchmarkJobFinished(snapshot.status) &&
    now() - startedAt < (options.cancellationGraceMs ?? DEFAULT_CANCELLATION_GRACE_MS)
  ) {
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    try {
      snapshot = await getAlignmentBenchmarkJob(sessionId, jobId, options.benchmarkInvoker);
    } catch {
      return;
    }
  }
}

function normalizeTerminalStatus(
  status: AlignmentBenchmarkJobSnapshot["status"]
): "completed" | "failed" | "cancelled" {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function normalizeCancellationTerminal(
  status: AlignmentBenchmarkJobSnapshot["status"]
): "cancelled" | "completed" | "failed" {
  if (status === "cancelled") return "cancelled";
  if (status === "completed") return "completed";
  return "failed";
}

function elapsedTicksMs(startTickNs: string, endTickNs: string): number {
  try {
    const start = BigInt(startTickNs);
    const end = BigInt(endTickNs);
    if (start < 0n || end < start) return 0;
    const milliseconds = Number((end - start) / 1_000_000n);
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  } catch {
    return 0;
  }
}

function emptyCacheCounts(): AlignmentBenchmarkCacheCounts {
  return { audioFeatureEntries: 0, landmarkEntries: 0, visualFeatureEntries: 0 };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function maximum(values: number[]): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function createPlanTrial(
  trialId: string,
  kind: RealMediaPerformanceTrialKind,
  repetition: number
): RealMediaPerformancePlanTrial {
  return {
    trialId,
    kind,
    repetition,
    warmupTrialId: null,
    cancellationStageKey: null,
    cancellationCaseOrdinal: null
  };
}

function requireOpaqueId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(trimmed)) {
    throw new Error(`${label} 必须是 8–160 位 opaque ID。`);
  }
  return trimmed;
}

function clonePlan(plan: RealMediaPerformanceExecutionPlan): RealMediaPerformanceExecutionPlan {
  return structuredClone(plan);
}

function createExecutionOptionsSnapshot(
  options: RealMediaPerformanceRunnerOptions
): RealMediaPerformanceRunnerOptions {
  const invoker = options.benchmarkInvoker;
  const benchmarkInvoker = invoker
    ? Object.freeze({
        begin: invoker.begin.bind(invoker),
        getActive: invoker.getActive.bind(invoker),
        resetCaches: invoker.resetCaches.bind(invoker),
        startJob: invoker.startJob.bind(invoker),
        getJob: invoker.getJob.bind(invoker),
        cancelJob: invoker.cancelJob.bind(invoker),
        finish: invoker.finish.bind(invoker)
      })
    : undefined;
  const preflightOptions = options.preflightOptions
    ? Object.freeze({
        probe: options.preflightOptions.probe,
        concurrency: options.preflightOptions.concurrency
      })
    : undefined;
  return Object.freeze({
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    spectralBackend: normalizeTauriSpectralBackendPreference(options.spectralBackend),
    signal: options.signal,
    preflightOptions,
    benchmarkInvoker,
    pollIntervalMs: options.pollIntervalMs,
    watchdogWallMs: options.watchdogWallMs,
    cancellationGraceMs: options.cancellationGraceMs,
    now: options.now,
    wait: options.wait,
    onProgress: options.onProgress
  });
}

function assertPerformanceWorkloadCaseLimit(manifest: RealMediaBenchmarkManifest): void {
  if (!Array.isArray(manifest.cases)) {
    throw new Error("C137 性能 workload 缺少 cases 数组。");
  }
  let realCaseCount = 0;
  for (const benchmarkCase of manifest.cases) {
    if (benchmarkCase.mediaKind !== "real") continue;
    realCaseCount += 1;
    if (realCaseCount > C137_PERFORMANCE_MAX_CASES_PER_RUN) {
      throw new Error(
        `C137 单次性能 workload 不得超过 ${C137_PERFORMANCE_MAX_CASES_PER_RUN} 个真实 case。`
      );
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function cloneSessionSnapshot(
  session: AlignmentBenchmarkSessionSnapshot
): AlignmentBenchmarkSessionSnapshot {
  return structuredClone(session);
}

function toRawPerformancePlan(
  plan: RealMediaPerformanceExecutionPlan
): C137PerformancePlanV1 {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    workloadDigest: plan.workloadDigest,
    expectedCaseCount: plan.expectedCaseCount,
    trialOrder: plan.trialOrder.map((trial) => ({ ...trial })),
    requiredStageKeys: [...plan.requiredStageKeys],
    memorySampleIntervalMs: plan.memorySampleIntervalMs,
    maximumMemorySampleGapMs: plan.maximumMemorySampleGapMs,
    outputCanonicalization: plan.outputCanonicalization,
    parameters: { ...plan.parameters }
  };
}

function toRawPerformanceEnvironment(
  environment: AlignmentBenchmarkEnvironmentReceipt
): C137PerformanceEnvironmentV2 {
  const withoutDigest: Omit<C137PerformanceEnvironmentV2, "digest"> = {
    schemaVersion: 2,
    measurementStatus: environment.measurementStatus,
    // Native diagnostic text may contain platform-specific details. Only stable ordinal issue
    // codes enter the shareable evidence envelope.
    issues: environment.issues.map((_, index) => `native-environment-issue-${index + 1}`),
    operatingSystem: environment.operatingSystem,
    operatingSystemVersion: environment.operatingSystemVersion,
    architecture: environment.architecture,
    cpuModel: environment.cpuModel,
    physicalCoreCount: environment.physicalCoreCount,
    logicalCoreCount: environment.logicalCoreCount,
    totalMemoryBytes: environment.totalMemoryBytes,
    storageScope: environment.storageScope,
    storageKind: environment.storageKind,
    workloadStorage: structuredClone(environment.workloadStorage),
    powerProfile: environment.powerProfile,
    ffmpeg: structuredClone(environment.ffmpeg),
    ffprobe: structuredClone(environment.ffprobe)
  };
  return {
    ...withoutDigest,
    digest: computeC137PerformanceEnvironmentDigestV2(withoutDigest)
  };
}

function toRawCacheResetReceipt(
  receipt: AlignmentBenchmarkCacheResetReceipt,
  trialId: string
): C137PerformanceCacheResetReceiptV2 {
  const withoutDigest: Omit<C137PerformanceCacheResetReceiptV2, "receiptDigest"> = {
    schemaVersion: 2,
    trialId,
    sessionId: receipt.sessionId,
    resetTickNs: receipt.resetTickNs,
    previousGeneration: receipt.previousGeneration,
    cacheGeneration: receipt.cacheGeneration,
    before: structuredClone(receipt.before),
    after: structuredClone(receipt.after),
    allCachesEmpty: receipt.allCachesEmpty
  };
  return {
    ...withoutDigest,
    receiptDigest: computeC137PerformanceCacheResetReceiptDigestV2(withoutDigest)
  };
}

function toRawTrial(
  trial: RealMediaPerformanceTrialEvidence,
  resetByTrial: Map<string, C137PerformanceCacheResetReceiptV2>
): C137PerformanceTrialV2 {
  if (trial.kind === "run") {
    const run = trial.run;
    return {
      trialType: "run",
      trialId: run.trialId,
      runKind: run.kind,
      repetition: run.repetition,
      sessionId: run.sessionId,
      workloadDigest: run.workloadDigest,
      status: run.status,
      startTickNs: run.startTickNs,
      endTickNs: run.endTickNs,
      elapsedMs: run.elapsedMs,
      cacheResetReceiptDigest:
        run.kind === "cold" ? (resetByTrial.get(run.trialId)?.receiptDigest ?? null) : null,
      warmupTrialId: run.cache.warmupTrialId,
      outputDigest: run.outputDigest,
      cases: run.cases.map((item) => ({
        caseOrdinal: item.caseOrdinal,
        jobId: item.jobId,
        status: item.status,
        requestParametersDigest: item.requestParametersDigest,
        timeMapParametersHash: item.timeMapParametersHash,
        timeMapDigest: item.timeMapDigest,
        outputDigest: item.outputDigest,
        telemetry: toRawTelemetry(item.telemetry)
      }))
    };
  }
  const cancellation = trial.cancellation;
  const reset = resetByTrial.get(cancellation.trialId);
  if (!reset) {
    throw new Error(`cancellation ${cancellation.trialId} 缺少 cache reset receipt。`);
  }
  return {
    trialType: "cancellation",
    trialId: cancellation.trialId,
    repetition: cancellation.repetition,
    sessionId: cancellation.sessionId,
    workloadDigest: cancellation.workloadDigest,
    caseOrdinal: cancellation.caseOrdinal,
    jobId: cancellation.jobId,
    triggerStageKey: cancellation.triggerStageKey,
    requestTickNs: cancellation.requestTickNs,
    terminalTickNs: cancellation.terminalTickNs,
    latencyMs: cancellation.latencyMs,
    commandAccepted: cancellation.commandAccepted,
    terminalStatus: cancellation.terminalStatus,
    processTreeEmpty: cancellation.processTreeEmpty,
    residualProcessCount: cancellation.residualProcessCount,
    cacheResetReceiptDigest: reset.receiptDigest,
    telemetry: toRawTelemetry(cancellation.telemetry)
  };
}

function toRawTelemetry(
  telemetry: AlignmentBenchmarkJobTelemetry
): C137PerformanceNativeTelemetryV2 {
  return structuredClone(telemetry);
}

function findJournalSampler(
  journal: RealMediaPerformanceCollectionJournal
):
  | "windows-toolhelp-working-set-v1"
  | "windows-job-object-working-set-v1"
  | "unsupported" {
  if (journal.terminalSession?.jobMemoryReceipt) {
    return journal.terminalSession.jobMemoryReceipt.sampler;
  }
  for (const trial of journal.trials) {
    if (trial.kind === "run") {
      const sampler = trial.run.cases[0]?.telemetry.memory.sampler;
      if (sampler) return sampler;
    } else {
      return trial.cancellation.telemetry.memory.sampler;
    }
  }
  return journal.environment?.operatingSystem.toLowerCase().includes("windows")
    ? "windows-job-object-working-set-v1"
    : "unsupported";
}

function toRawEvidenceStatus(
  status: RealMediaPerformanceCollectionStatus
): C137PerformanceEvidenceStatus {
  return status === "completed" ? "complete" : status;
}

function defaultNow(): number {
  return Date.now();
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function emitProgress(
  options: RealMediaPerformanceRunnerOptions,
  phase: RealMediaPerformancePhase,
  trialId: string | null,
  trialIndex: number,
  trialCount: number
): void {
  options.onProgress?.({ phase, trialId, trialIndex, trialCount });
}
