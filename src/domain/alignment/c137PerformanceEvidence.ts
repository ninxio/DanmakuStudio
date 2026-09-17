import { sha256Hex } from "../shared/sha256";
import type { SpectralBackendPreference } from "./spectralBackendPreference";

export const C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION_V2 = 2 as const;
export const C137_PERFORMANCE_PLAN_SCHEMA_VERSION = 1 as const;
export const C137_PERFORMANCE_NATIVE_SCHEMA_VERSION = 1 as const;
export const C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2 = 2 as const;
export const C137_PERFORMANCE_MAX_TRIALS = 64;
export const C137_PERFORMANCE_MAX_CASES_PER_RUN = 1_000;
export const C137_PERFORMANCE_MAX_STAGES_PER_CASE = 128;
export const C137_PERFORMANCE_MAX_PEAK_PROCESS_TREE_RSS_BYTES = 1_073_741_824;

export type C137PerformanceDigest = `sha256:${string}`;
export type C137PerformanceEvidenceStatus =
  | "complete"
  | "failed"
  | "cancelled"
  | "cleanup-blocked"
  | "preflight-failed";
export type C137PerformanceRunKindV1 = "cold" | "warmup" | "hot";
export type C137PerformanceStageKeyV1 =
  | "queued"
  | "validating"
  | "extracting-complete"
  | "extracting-source"
  | "extracting-visual"
  | "fingerprinting"
  | "matching"
  | "fitting"
  | "refining"
  | "reporting"
  | "completed"
  | "failed"
  | "cancelled";

export interface C137PerformancePlanTrialV1 {
  trialId: string;
  kind: C137PerformanceRunKindV1 | "cancellation";
  repetition: number;
  warmupTrialId: string | null;
  cancellationStageKey: C137PerformanceStageKeyV1 | null;
  cancellationCaseOrdinal: number | null;
}

export interface C137PerformanceAlgorithmParametersV1 {
  spectralBackend: SpectralBackendPreference;
  sampleRate: number | null;
  windowMs: number | null;
  matchThreshold: number | null;
  minGapMs: number | null;
  maxCells: number | null;
  enableVisualEvidence: boolean | null;
  visualSampleIntervalMs: number | null;
}

export interface C137PerformancePlanV1 {
  schemaVersion: typeof C137_PERFORMANCE_PLAN_SCHEMA_VERSION;
  planId: string;
  workloadDigest: C137PerformanceDigest;
  expectedCaseCount: number;
  trialOrder: C137PerformancePlanTrialV1[];
  requiredStageKeys: C137PerformanceStageKeyV1[];
  memorySampleIntervalMs: number;
  maximumMemorySampleGapMs: number;
  outputCanonicalization: "c137-time-map-output-digest-v1";
  parameters: C137PerformanceAlgorithmParametersV1;
}

export interface C137PerformanceToolchainV1 {
  version: string;
  binaryDigest: C137PerformanceDigest;
}

export interface C137PerformanceEnvironmentV1 {
  schemaVersion: 1;
  digest: C137PerformanceDigest;
  measurementStatus: "complete" | "incomplete";
  issues: string[];
  operatingSystem: string;
  operatingSystemVersion: string;
  architecture: string;
  cpuModel: string;
  physicalCoreCount: number;
  logicalCoreCount: number;
  totalMemoryBytes: number;
  storageScope: "system-volume" | "workload-media-volumes";
  storageKind: string;
  powerProfile: string;
  ffmpeg: C137PerformanceToolchainV1;
  ffprobe: C137PerformanceToolchainV1;
}

export interface C137PerformanceCollectorV1 {
  schemaVersion: 1;
  collectorVersion: string;
  nativeSchemaVersion: number;
  clock: "rust-std-instant-session-relative-v1";
  memoryScope: "application-process-tree";
  sampler:
    | "windows-toolhelp-working-set-v1"
    | "windows-job-object-working-set-v1"
    | "unsupported";
  sessionId: string;
  sessionOriginTickNs: "0";
  memorySampleIntervalMs: number;
  terminalSessionStatus: "released" | "cleanup-blocked" | null;
}

export interface C137PerformancePreflightV1 {
  ok: boolean;
  realRelationCount: number;
  checkedFileCount: number;
  issueCodes: string[];
}

export interface C137PerformanceCacheCountsV1 {
  audioFeatureEntries: number;
  landmarkEntries: number;
  visualFeatureEntries: number;
}

export interface C137PerformanceCacheCounterV1 {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

export interface C137PerformanceCacheTelemetryV1 {
  generation: number;
  before: C137PerformanceCacheCountsV1;
  after: C137PerformanceCacheCountsV1;
  audioFeatures: C137PerformanceCacheCounterV1;
  landmarks: C137PerformanceCacheCounterV1;
  visualFeatures: C137PerformanceCacheCounterV1;
}

export interface C137PerformanceCacheResetReceiptV1 {
  schemaVersion: 1;
  receiptDigest: C137PerformanceDigest;
  trialId: string;
  sessionId: string;
  resetTickNs: string;
  previousGeneration: number;
  cacheGeneration: number;
  before: C137PerformanceCacheCountsV1;
  after: C137PerformanceCacheCountsV1;
  allCachesEmpty: boolean;
}

export interface C137PerformanceStageTimingV1 {
  stageKey: C137PerformanceStageKeyV1;
  occurrence: number;
  startTickNs: string;
  endTickNs: string;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
}

export interface C137PerformanceMemoryTelemetryV1 {
  scope: "application-process-tree";
  sampler:
    | "windows-toolhelp-working-set-v1"
    | "windows-job-object-working-set-v1"
    | "unsupported";
  sampleIntervalMs: number;
  sampleCount: number;
  failedSampleCount: number;
  maximumSampleGapMs: number;
  peakProcessTreeRssBytes: number | null;
  coverageComplete: boolean;
  processTreeEmptyAtTerminal: boolean;
  residualProcessCount: number;
}

export interface C137PerformanceCancellationTelemetryV1 {
  requestTickNs: string;
  terminalTickNs: string;
  latencyMs: number;
  commandAccepted: boolean;
}

export interface C137PerformanceNativeTelemetryV1 {
  schemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION;
  clock: "rust-std-instant-session-relative-v1";
  startTickNs: string;
  endTickNs: string | null;
  elapsedMs: number;
  stages: C137PerformanceStageTimingV1[];
  cache: C137PerformanceCacheTelemetryV1;
  memory: C137PerformanceMemoryTelemetryV1;
  cancellation: C137PerformanceCancellationTelemetryV1 | null;
}

export interface C137PerformanceCaseV1 {
  caseOrdinal: number;
  jobId: string;
  status: "completed" | "failed" | "cancelled";
  requestParametersDigest: C137PerformanceDigest;
  timeMapParametersHash: string | null;
  timeMapDigest: C137PerformanceDigest | null;
  outputDigest: C137PerformanceDigest | null;
  telemetry: C137PerformanceNativeTelemetryV1;
}

export interface C137PerformanceRunV1 {
  trialType: "run";
  trialId: string;
  runKind: C137PerformanceRunKindV1;
  repetition: number;
  sessionId: string;
  workloadDigest: C137PerformanceDigest;
  status: "completed" | "failed" | "cancelled";
  startTickNs: string;
  endTickNs: string;
  elapsedMs: number;
  cacheResetReceiptDigest: C137PerformanceDigest | null;
  warmupTrialId: string | null;
  outputDigest: C137PerformanceDigest | null;
  cases: C137PerformanceCaseV1[];
}

export interface C137PerformanceCancellationTrialV1 {
  trialType: "cancellation";
  trialId: string;
  repetition: number;
  sessionId: string;
  workloadDigest: C137PerformanceDigest;
  caseOrdinal: number;
  jobId: string;
  triggerStageKey: C137PerformanceStageKeyV1;
  requestTickNs: string;
  terminalTickNs: string;
  latencyMs: number;
  commandAccepted: boolean;
  terminalStatus: "cancelled" | "completed" | "failed" | "timeout";
  processTreeEmpty: boolean;
  residualProcessCount: number;
  cacheResetReceiptDigest: C137PerformanceDigest;
  telemetry: C137PerformanceNativeTelemetryV1;
}

export type C137PerformanceTrialV1 =
  | C137PerformanceRunV1
  | C137PerformanceCancellationTrialV1;

export interface C137PerformanceEvidenceDraftV1 {
  schemaVersion: typeof C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION;
  reportKind: "c137-performance-raw-evidence";
  releaseEligible: false;
  trustStatus: "untrusted-raw-evidence";
  plan: C137PerformancePlanV1;
  planDigest: C137PerformanceDigest;
  environment: C137PerformanceEnvironmentV1;
  collector: C137PerformanceCollectorV1;
  preflight: C137PerformancePreflightV1;
  cacheResets: C137PerformanceCacheResetReceiptV1[];
  trials: C137PerformanceTrialV1[];
  status: C137PerformanceEvidenceStatus;
  issueCodes: string[];
}

export interface C137PerformanceRawEvidenceV1 extends C137PerformanceEvidenceDraftV1 {
  evidenceDigest: C137PerformanceDigest;
}

export interface C137PerformanceWorkloadStorageBindingV2 {
  bindingOrdinal: number;
  caseOrdinal: number;
  side: "source" | "target";
  volumeOrdinal: number;
}

export interface C137PerformanceWorkloadStorageVolumeV2 {
  volumeOrdinal: number;
  bindingCount: number;
  driveType: "fixed";
  seekPenalty: "incurs" | "none";
  measurementStatus: "complete";
}

/**
 * Path-free native receipt for the exact media volumes used by the frozen run manifest.
 * The digest intentionally covers only these fields (apart from receiptDigest itself),
 * matching the native schema-v2 receipt byte-for-byte after canonical JSON encoding.
 */
export interface C137PerformanceWorkloadStorageReceiptV2 {
  schemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2;
  runManifestDigest: C137PerformanceDigest;
  workloadDigest: C137PerformanceDigest;
  bindingCount: number;
  uniqueMediaCount: number;
  volumeCount: number;
  mediaSetDigest: C137PerformanceDigest;
  bindings: C137PerformanceWorkloadStorageBindingV2[];
  volumes: C137PerformanceWorkloadStorageVolumeV2[];
  receiptDigest: C137PerformanceDigest;
}

export interface C137PerformanceEnvironmentV2 {
  schemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2;
  digest: C137PerformanceDigest;
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
  workloadStorage: C137PerformanceWorkloadStorageReceiptV2;
  powerProfile: string;
  ffmpeg: C137PerformanceToolchainV1;
  ffprobe: C137PerformanceToolchainV1;
}

export interface C137PerformanceCollectorV2 {
  schemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2;
  collectorVersion: string;
  nativeSchemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2;
  clock: "rust-std-instant-session-relative-v1";
  memoryScope: "application-process-tree";
  sampler:
    | "windows-toolhelp-working-set-v1"
    | "windows-job-object-working-set-v1"
    | "unsupported";
  sessionId: string;
  sessionOriginTickNs: "0";
  memorySampleIntervalMs: number;
  terminalSessionStatus: "released" | "cleanup-blocked" | null;
  runManifestDigest: C137PerformanceDigest;
  workloadDigest: C137PerformanceDigest;
  workloadStorageReceiptDigest: C137PerformanceDigest;
}

export type C137PerformanceStageTimingV2 = C137PerformanceStageTimingV1;
export type C137PerformanceCacheTelemetryV2 = C137PerformanceCacheTelemetryV1;
export type C137PerformanceMemoryTelemetryV2 = C137PerformanceMemoryTelemetryV1;
export type C137PerformanceCancellationTelemetryV2 =
  C137PerformanceCancellationTelemetryV1;

export interface C137PerformanceCacheResetReceiptV2
  extends Omit<C137PerformanceCacheResetReceiptV1, "schemaVersion"> {
  schemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2;
}

export interface C137PerformanceNativeTelemetryV2
  extends Omit<C137PerformanceNativeTelemetryV1, "schemaVersion"> {
  schemaVersion: typeof C137_PERFORMANCE_NATIVE_SCHEMA_VERSION_V2;
}

export interface C137PerformanceCaseV2
  extends Omit<C137PerformanceCaseV1, "telemetry"> {
  telemetry: C137PerformanceNativeTelemetryV2;
}

export interface C137PerformanceRunV2
  extends Omit<C137PerformanceRunV1, "cases"> {
  cases: C137PerformanceCaseV2[];
}

export interface C137PerformanceCancellationTrialV2
  extends Omit<C137PerformanceCancellationTrialV1, "telemetry"> {
  telemetry: C137PerformanceNativeTelemetryV2;
}

export type C137PerformanceTrialV2 =
  | C137PerformanceRunV2
  | C137PerformanceCancellationTrialV2;

export interface C137PerformanceTerminalCleanupJobInventoryEntryV1 {
  jobId: string;
  status: "completed" | "failed" | "cancelled";
  endTickNs: string;
  processTreeEmptyAtTerminal: true;
  residualProcessCount: 0;
}

export interface C137PerformanceJobMemoryInventoryEntryV1 {
  jobId: string;
  sampleIntervalMs: number;
  sampleCount: number;
  failedSampleCount: 0;
  maximumSampleGapMicros: string;
  peakJobHierarchyRssBytes: number;
  coverageComplete: true;
  processTreeEmptyAtTerminal: true;
  residualProcessCount: 0;
}

export interface C137PerformanceJobMemoryReceiptV1 {
  schemaVersion: 1;
  sessionId: string;
  runManifestDigest: C137PerformanceDigest;
  workloadDigest: C137PerformanceDigest;
  workloadStorageReceiptDigest: C137PerformanceDigest;
  sampler: "windows-job-object-working-set-v1";
  memoryScope: "application-process-tree";
  jobCount: number;
  totalSampleCount: number;
  totalFailedSampleCount: 0;
  maximumSampleGapMicros: string;
  peakJobHierarchyRssBytes: number;
  jobMemoryInventoryDigest: C137PerformanceDigest;
  allJobsCoverageComplete: true;
  allSamplesJobBound: true;
  allTerminalProcessTreesEmpty: true;
  receiptDigest: C137PerformanceDigest;
}

export interface C137PerformanceTerminalCleanupReceiptV1 {
  schemaVersion: 1;
  sessionId: string;
  runManifestDigest: C137PerformanceDigest;
  workloadDigest: C137PerformanceDigest;
  workloadStorageReceiptDigest: C137PerformanceDigest;
  terminalTickNs: string;
  finalCacheGeneration: number;
  jobCount: number;
  completedJobCount: number;
  failedJobCount: number;
  cancelledJobCount: number;
  jobInventoryDigest: C137PerformanceDigest;
  allJobsTerminal: true;
  processTreeEmpty: true;
  residualProcessCount: 0;
  supervisionCleanupStatus: "clean";
  toolchainReverified: true;
  workloadReverified: true;
  featureCachesEmpty: true;
  receiptDigest: C137PerformanceDigest;
}

export interface C137PerformanceAssuranceV2 {
  schemaVersion: 1;
  workloadStorageReceiptDigest: C137PerformanceDigest;
  jobMemoryReceipt: C137PerformanceJobMemoryReceiptV1 | null;
  terminalCleanupReceipt: C137PerformanceTerminalCleanupReceiptV1 | null;
  attestation: null;
}

export interface C137PerformanceEvidenceDraftV2 {
  schemaVersion: typeof C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION_V2;
  reportKind: "c137-performance-raw-evidence";
  releaseEligible: false;
  trustStatus: "untrusted-raw-evidence";
  runManifestDigest: C137PerformanceDigest;
  plan: C137PerformancePlanV1;
  planDigest: C137PerformanceDigest;
  environment: C137PerformanceEnvironmentV2;
  collector: C137PerformanceCollectorV2;
  assurance: C137PerformanceAssuranceV2;
  preflight: C137PerformancePreflightV1;
  cacheResets: C137PerformanceCacheResetReceiptV2[];
  trials: C137PerformanceTrialV2[];
  status: C137PerformanceEvidenceStatus;
  issueCodes: string[];
}

export interface C137PerformanceRawEvidenceV2 extends C137PerformanceEvidenceDraftV2 {
  evidenceDigest: C137PerformanceDigest;
}

export type C137PerformanceRawEvidence =
  | C137PerformanceRawEvidenceV1
  | C137PerformanceRawEvidenceV2;

export interface C137PerformanceEvidenceValidation {
  valid: boolean;
  complete: boolean;
  issues: string[];
  completenessIssues: string[];
}

const STAGE_KEYS = new Set<C137PerformanceStageKeyV1>([
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
]);

export function createC137PerformancePlanDigest(
  plan: C137PerformancePlanV1
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-plan-v1",
    plan
  });
}

export function computeC137PerformanceEnvironmentDigest(
  environment: Omit<C137PerformanceEnvironmentV1, "digest">
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-environment-v1",
    environment
  });
}

export function computeC137PerformanceEnvironmentDigestV2(
  environment: Omit<C137PerformanceEnvironmentV2, "digest">
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-environment-v2",
    environment
  });
}

export function computeC137PerformanceCanonicalDigest(value: unknown): C137PerformanceDigest {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function computeC137PerformanceCacheResetReceiptDigest(
  receipt: Omit<C137PerformanceCacheResetReceiptV1, "receiptDigest">
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-cache-reset-v1",
    receipt
  });
}

export function computeC137PerformanceCacheResetReceiptDigestV2(
  receipt: Omit<C137PerformanceCacheResetReceiptV2, "receiptDigest">
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-cache-reset-v2",
    receipt
  });
}

export function computeC137PerformanceWorkloadStorageReceiptDigest(
  receipt:
    | Omit<C137PerformanceWorkloadStorageReceiptV2, "receiptDigest">
    | C137PerformanceWorkloadStorageReceiptV2
): C137PerformanceDigest {
  const payload = "receiptDigest" in receipt
    ? omitWorkloadStorageReceiptDigest(receipt)
    : receipt;
  return computeC137PerformanceCanonicalDigest(payload);
}

export function projectC137PerformanceJobMemoryInventory(
  trials: readonly C137PerformanceTrialV2[]
): C137PerformanceJobMemoryInventoryEntryV1[] {
  const jobs = trials.flatMap((trial) => {
    const project = (
      jobId: string,
      memory: C137PerformanceMemoryTelemetryV2
    ): C137PerformanceJobMemoryInventoryEntryV1 => {
      if (
        memory.sampler !== "windows-job-object-working-set-v1" ||
        memory.sampleCount <= 0 ||
        memory.failedSampleCount !== 0 ||
        memory.peakProcessTreeRssBytes === null ||
        memory.peakProcessTreeRssBytes <= 0 ||
        !memory.coverageComplete ||
        !memory.processTreeEmptyAtTerminal ||
        memory.residualProcessCount !== 0
      ) {
        throw new Error(`Job memory inventory 遇到覆盖不完整的 job：${jobId}。`);
      }
      const maximumSampleGapMicros = Math.round(memory.maximumSampleGapMs * 1_000);
      if (!Number.isSafeInteger(maximumSampleGapMicros) || maximumSampleGapMicros < 0) {
        throw new Error(`Job memory inventory 的最大采样间隔越界：${jobId}。`);
      }
      return {
        jobId,
        sampleIntervalMs: memory.sampleIntervalMs,
        sampleCount: memory.sampleCount,
        failedSampleCount: 0,
        maximumSampleGapMicros: String(maximumSampleGapMicros),
        peakJobHierarchyRssBytes: memory.peakProcessTreeRssBytes,
        coverageComplete: true,
        processTreeEmptyAtTerminal: true,
        residualProcessCount: 0
      };
    };
    if (trial.trialType === "run") {
      return trial.cases.map((benchmarkCase) =>
        project(benchmarkCase.jobId, benchmarkCase.telemetry.memory)
      );
    }
    return [project(trial.jobId, trial.telemetry.memory)];
  });
  jobs.sort((left, right) => compareAscii(left.jobId, right.jobId));
  return jobs;
}

export function computeC137PerformanceJobMemoryInventoryDigest(
  jobs: readonly C137PerformanceJobMemoryInventoryEntryV1[]
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-job-memory-inventory-v1",
    jobs
  });
}

export function computeC137PerformanceJobMemoryReceiptDigest(
  receipt:
    | Omit<C137PerformanceJobMemoryReceiptV1, "receiptDigest">
    | C137PerformanceJobMemoryReceiptV1
): C137PerformanceDigest {
  const payload = "receiptDigest" in receipt
    ? omitJobMemoryReceiptDigest(receipt)
    : receipt;
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-job-memory-receipt-v1",
    receipt: payload
  });
}

export function projectC137PerformanceTerminalCleanupJobInventory(
  trials: readonly C137PerformanceTrialV2[]
): C137PerformanceTerminalCleanupJobInventoryEntryV1[] {
  const jobs = trials.flatMap((trial) => {
    if (trial.trialType === "run") {
      return trial.cases.map((benchmarkCase) => ({
        jobId: benchmarkCase.jobId,
        status: benchmarkCase.status,
        endTickNs: requireTerminalTelemetryEndTick(benchmarkCase.telemetry, benchmarkCase.jobId),
        processTreeEmptyAtTerminal: true as const,
        residualProcessCount: 0 as const
      }));
    }
    if (trial.terminalStatus === "timeout") {
      throw new Error(`terminal cleanup inventory 不接受 timeout job：${trial.jobId}。`);
    }
    return [
      {
        jobId: trial.jobId,
        status: trial.terminalStatus,
        endTickNs: requireTerminalTelemetryEndTick(trial.telemetry, trial.jobId),
        processTreeEmptyAtTerminal: true as const,
        residualProcessCount: 0 as const
      }
    ];
  });
  jobs.sort((left, right) => compareAscii(left.jobId, right.jobId));
  return jobs;
}

export function computeC137PerformanceTerminalCleanupJobInventoryDigest(
  jobs: readonly C137PerformanceTerminalCleanupJobInventoryEntryV1[]
): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-terminal-job-inventory-v1",
    jobs
  });
}

export function computeC137PerformanceTerminalCleanupReceiptDigest(
  receipt:
    | Omit<C137PerformanceTerminalCleanupReceiptV1, "receiptDigest">
    | C137PerformanceTerminalCleanupReceiptV1
): C137PerformanceDigest {
  const payload = "receiptDigest" in receipt
    ? omitTerminalCleanupReceiptDigest(receipt)
    : receipt;
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-terminal-cleanup-receipt-v1",
    receipt: payload
  });
}

export function computeC137PerformanceCaseOutputDigest(input: {
  caseOrdinal: number;
  requestParametersDigest: C137PerformanceDigest;
  timeMapParametersHash: string;
  timeMapDigest: C137PerformanceDigest;
}): C137PerformanceDigest {
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-time-map-output-case-v1",
    caseOrdinal: input.caseOrdinal,
    requestParametersDigest: input.requestParametersDigest,
    timeMapParametersHash: input.timeMapParametersHash,
    timeMapDigest: input.timeMapDigest
  });
}

export function computeC137PerformanceEvidenceDigest(
  evidence: C137PerformanceEvidenceDraftV1 | C137PerformanceRawEvidenceV1
): C137PerformanceDigest {
  const payload = "evidenceDigest" in evidence
    ? omitEvidenceDigest(evidence)
    : evidence;
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-raw-evidence-v1",
    evidence: payload
  });
}

export function computeC137PerformanceEvidenceDigestV2(
  evidence: C137PerformanceEvidenceDraftV2 | C137PerformanceRawEvidenceV2
): C137PerformanceDigest {
  const payload = "evidenceDigest" in evidence
    ? omitEvidenceDigestV2(evidence)
    : evidence;
  return computeC137PerformanceCanonicalDigest({
    domain: "c137-performance-raw-evidence-v2",
    evidence: payload
  });
}

export function createC137PerformanceEvidenceDraft(input: {
  plan: C137PerformancePlanV1;
  environment: C137PerformanceEnvironmentV1;
  collector: C137PerformanceCollectorV1;
  preflight: C137PerformancePreflightV1;
  status?: C137PerformanceEvidenceStatus;
  issueCodes?: string[];
}): C137PerformanceEvidenceDraftV1 {
  return {
    schemaVersion: C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION,
    reportKind: "c137-performance-raw-evidence",
    releaseEligible: false,
    trustStatus: "untrusted-raw-evidence",
    plan: structuredClone(input.plan),
    planDigest: createC137PerformancePlanDigest(input.plan),
    environment: structuredClone(input.environment),
    collector: structuredClone(input.collector),
    preflight: structuredClone(input.preflight),
    cacheResets: [],
    trials: [],
    status: input.status ?? "failed",
    issueCodes: [...new Set(input.issueCodes ?? [])]
  };
}

export function appendC137PerformanceCacheResetReceipt(
  draft: C137PerformanceEvidenceDraftV1,
  receipt: C137PerformanceCacheResetReceiptV1
): C137PerformanceEvidenceDraftV1 {
  return {
    ...draft,
    cacheResets: [...draft.cacheResets, structuredClone(receipt)]
  };
}

export function appendC137PerformanceTrial(
  draft: C137PerformanceEvidenceDraftV1,
  trial: C137PerformanceTrialV1
): C137PerformanceEvidenceDraftV1 {
  return {
    ...draft,
    trials: [...draft.trials, structuredClone(trial)]
  };
}

export function finalizeC137PerformanceEvidence(
  draft: C137PerformanceEvidenceDraftV1,
  status: C137PerformanceEvidenceStatus,
  issueCodes: string[] = draft.issueCodes
): C137PerformanceRawEvidenceV1 {
  const finalizedDraft: C137PerformanceEvidenceDraftV1 = {
    ...structuredClone(draft),
    status,
    issueCodes: [...new Set(issueCodes)]
  };
  const evidence: C137PerformanceRawEvidenceV1 = {
    ...finalizedDraft,
    evidenceDigest: computeC137PerformanceEvidenceDigest(finalizedDraft)
  };
  const validation = validateC137PerformanceEvidence(evidence);
  if (!validation.valid) {
    throw new Error(`C137 性能 raw evidence 无效：${validation.issues.join("；")}`);
  }
  return evidence;
}

export function createC137PerformanceEvidenceDraftV2(input: {
  runManifestDigest: C137PerformanceDigest;
  plan: C137PerformancePlanV1;
  environment: C137PerformanceEnvironmentV2;
  collector: C137PerformanceCollectorV2;
  preflight: C137PerformancePreflightV1;
  jobMemoryReceipt?: C137PerformanceJobMemoryReceiptV1 | null;
  terminalCleanupReceipt?: C137PerformanceTerminalCleanupReceiptV1 | null;
  status?: C137PerformanceEvidenceStatus;
  issueCodes?: string[];
}): C137PerformanceEvidenceDraftV2 {
  return {
    schemaVersion: C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION_V2,
    reportKind: "c137-performance-raw-evidence",
    releaseEligible: false,
    trustStatus: "untrusted-raw-evidence",
    runManifestDigest: input.runManifestDigest,
    plan: structuredClone(input.plan),
    planDigest: createC137PerformancePlanDigest(input.plan),
    environment: structuredClone(input.environment),
    collector: structuredClone(input.collector),
    assurance: {
      schemaVersion: 1,
      workloadStorageReceiptDigest: input.environment.workloadStorage.receiptDigest,
      jobMemoryReceipt: input.jobMemoryReceipt
        ? structuredClone(input.jobMemoryReceipt)
        : null,
      terminalCleanupReceipt: input.terminalCleanupReceipt
        ? structuredClone(input.terminalCleanupReceipt)
        : null,
      attestation: null
    },
    preflight: structuredClone(input.preflight),
    cacheResets: [],
    trials: [],
    status: input.status ?? "failed",
    issueCodes: [...new Set(input.issueCodes ?? [])]
  };
}

export function appendC137PerformanceCacheResetReceiptV2(
  draft: C137PerformanceEvidenceDraftV2,
  receipt: C137PerformanceCacheResetReceiptV2
): C137PerformanceEvidenceDraftV2 {
  return {
    ...draft,
    cacheResets: [...draft.cacheResets, structuredClone(receipt)]
  };
}

export function appendC137PerformanceTrialV2(
  draft: C137PerformanceEvidenceDraftV2,
  trial: C137PerformanceTrialV2
): C137PerformanceEvidenceDraftV2 {
  return {
    ...draft,
    trials: [...draft.trials, structuredClone(trial)]
  };
}

export function finalizeC137PerformanceEvidenceV2(
  draft: C137PerformanceEvidenceDraftV2,
  status: C137PerformanceEvidenceStatus,
  issueCodes: string[] = draft.issueCodes
): C137PerformanceRawEvidenceV2 {
  const finalizedDraft: C137PerformanceEvidenceDraftV2 = {
    ...structuredClone(draft),
    status,
    issueCodes: [...new Set(issueCodes)]
  };
  const evidence: C137PerformanceRawEvidenceV2 = {
    ...finalizedDraft,
    evidenceDigest: computeC137PerformanceEvidenceDigestV2(finalizedDraft)
  };
  const validation = validateC137PerformanceEvidence(evidence);
  if (!validation.valid) {
    throw new Error(`C137 性能 raw evidence v2 无效：${validation.issues.join("；")}`);
  }
  return evidence;
}

export function validateC137PerformanceEvidence(
  value: unknown
): C137PerformanceEvidenceValidation {
  if (!isRecord(value)) {
    return {
      valid: false,
      complete: false,
      issues: ["evidence 必须为对象。"],
      completenessIssues: []
    };
  }
  if (value.schemaVersion === C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION) {
    return validateC137PerformanceEvidenceV1(value);
  }
  if (value.schemaVersion === C137_PERFORMANCE_EVIDENCE_SCHEMA_VERSION_V2) {
    return validateC137PerformanceEvidenceV2(value);
  }
  return {
    valid: false,
    complete: false,
    issues: ["evidence.schemaVersion 不是受支持的严格 schema。"],
    completenessIssues: []
  };
}

function validateC137PerformanceEvidenceV1(
  value: unknown
): C137PerformanceEvidenceValidation {
  const issues: string[] = [];
  const completenessIssues: string[] = [];
  const record = strictRecord(
    value,
    "evidence",
    [
      "schemaVersion",
      "reportKind",
      "releaseEligible",
      "trustStatus",
      "plan",
      "planDigest",
      "environment",
      "collector",
      "preflight",
      "cacheResets",
      "trials",
      "status",
      "issueCodes",
      "evidenceDigest"
    ],
    issues
  );
  if (record === null) return { valid: false, complete: false, issues, completenessIssues };
  requireLiteral(record.schemaVersion, 1, "evidence.schemaVersion", issues);
  requireLiteral(record.reportKind, "c137-performance-raw-evidence", "evidence.reportKind", issues);
  requireLiteral(record.releaseEligible, false, "evidence.releaseEligible", issues);
  requireLiteral(record.trustStatus, "untrusted-raw-evidence", "evidence.trustStatus", issues);
  validatePlan(record.plan, issues);
  requireDigest(record.planDigest, "evidence.planDigest", issues);
  validateEnvironment(record.environment, issues);
  validateCollector(record.collector, issues);
  validatePreflight(record.preflight, issues);
  validateCacheResets(record.cacheResets, issues);
  validateTrials(record.trials, issues);
  requireOneOf(
    record.status,
    ["complete", "failed", "cancelled", "cleanup-blocked", "preflight-failed"],
    "evidence.status",
    issues
  );
  validateStringArray(record.issueCodes, "evidence.issueCodes", issues, 256);
  requireDigest(record.evidenceDigest, "evidence.evidenceDigest", issues);
  if (issues.length > 0) return { valid: false, complete: false, issues, completenessIssues };

  const evidence = value as C137PerformanceRawEvidenceV1;
  if (evidence.planDigest !== createC137PerformancePlanDigest(evidence.plan)) {
    issues.push("evidence.planDigest 与预注册计划不一致。");
  }
  if (
    evidence.environment.digest !==
    computeC137PerformanceEnvironmentDigest(omitEnvironmentDigest(evidence.environment))
  ) {
    issues.push("evidence.environment.digest 与环境字段不一致。");
  }
  for (const receipt of evidence.cacheResets) {
    if (
      receipt.receiptDigest !==
      computeC137PerformanceCacheResetReceiptDigest(omitReceiptDigest(receipt))
    ) {
      issues.push(`cache reset ${receipt.trialId} receiptDigest 不一致。`);
    }
  }
  if (evidence.evidenceDigest !== computeC137PerformanceEvidenceDigest(evidence)) {
    issues.push("evidence.evidenceDigest 与 raw evidence 不一致。");
  }
  if (issues.length > 0) return { valid: false, complete: false, issues, completenessIssues };

  evaluateCompleteness(evidence, completenessIssues);
  return {
    valid: true,
    complete: completenessIssues.length === 0,
    issues: [],
    completenessIssues
  };
}

function validateC137PerformanceEvidenceV2(
  value: unknown
): C137PerformanceEvidenceValidation {
  const issues: string[] = [];
  const completenessIssues: string[] = [];
  const record = strictRecord(
    value,
    "evidence",
    [
      "schemaVersion",
      "reportKind",
      "releaseEligible",
      "trustStatus",
      "runManifestDigest",
      "plan",
      "planDigest",
      "environment",
      "collector",
      "assurance",
      "preflight",
      "cacheResets",
      "trials",
      "status",
      "issueCodes",
      "evidenceDigest"
    ],
    issues
  );
  if (record === null) return { valid: false, complete: false, issues, completenessIssues };
  requireLiteral(record.schemaVersion, 2, "evidence.schemaVersion", issues);
  requireLiteral(record.reportKind, "c137-performance-raw-evidence", "evidence.reportKind", issues);
  requireLiteral(record.releaseEligible, false, "evidence.releaseEligible", issues);
  requireLiteral(record.trustStatus, "untrusted-raw-evidence", "evidence.trustStatus", issues);
  requireDigest(record.runManifestDigest, "evidence.runManifestDigest", issues);
  validatePlan(record.plan, issues);
  requireDigest(record.planDigest, "evidence.planDigest", issues);
  validateEnvironmentV2(record.environment, issues);
  validateCollectorV2(record.collector, issues);
  validateAssuranceV2(record.assurance, issues);
  validatePreflight(record.preflight, issues);
  validateCacheResets(record.cacheResets, issues, 2);
  validateTrials(record.trials, issues, 2);
  requireOneOf(
    record.status,
    ["complete", "failed", "cancelled", "cleanup-blocked", "preflight-failed"],
    "evidence.status",
    issues
  );
  validateStringArray(record.issueCodes, "evidence.issueCodes", issues, 256);
  requireDigest(record.evidenceDigest, "evidence.evidenceDigest", issues);
  if (issues.length > 0) return { valid: false, complete: false, issues, completenessIssues };

  const evidence = value as C137PerformanceRawEvidenceV2;
  const storage = evidence.environment.workloadStorage;
  if (evidence.planDigest !== createC137PerformancePlanDigest(evidence.plan)) {
    issues.push("evidence.planDigest 与预注册计划不一致。");
  }
  if (
    evidence.runManifestDigest !== evidence.plan.workloadDigest ||
    storage.runManifestDigest !== evidence.runManifestDigest ||
    storage.workloadDigest !== evidence.runManifestDigest
  ) {
    issues.push("run manifest、plan 与 workload storage receipt 摘要未闭合。");
  }
  if (storage.bindingCount !== evidence.plan.expectedCaseCount * 2) {
    issues.push("workload storage bindingCount 与计划 case 数不一致。");
  }
  if (
    evidence.environment.digest !==
    computeC137PerformanceEnvironmentDigestV2(omitEnvironmentDigestV2(evidence.environment))
  ) {
    issues.push("evidence.environment.digest 与 v2 环境字段不一致。");
  }
  if (
    storage.receiptDigest !==
    computeC137PerformanceWorkloadStorageReceiptDigest(storage)
  ) {
    issues.push("workload storage receiptDigest 与 path-free receipt 字段不一致。");
  }
  if (
    evidence.collector.runManifestDigest !== evidence.runManifestDigest ||
    evidence.collector.workloadDigest !== evidence.plan.workloadDigest ||
    evidence.collector.workloadStorageReceiptDigest !== storage.receiptDigest
  ) {
    issues.push("collector 未绑定同一 run manifest/workload/storage receipt。");
  }
  if (evidence.assurance.workloadStorageReceiptDigest !== storage.receiptDigest) {
    issues.push("assurance 未绑定 workload storage receipt。");
  }
  const jobMemoryReceipt = evidence.assurance.jobMemoryReceipt;
  if (jobMemoryReceipt !== null) {
    try {
      const inventory = projectC137PerformanceJobMemoryInventory(evidence.trials);
      const inventoryIds = new Set(inventory.map((job) => job.jobId));
      const totalSampleCount = inventory.reduce((total, job) => total + job.sampleCount, 0);
      const maximumSampleGapMicros = inventory.reduce(
        (maximum, job) =>
          compareDecimalTicks(job.maximumSampleGapMicros, maximum) > 0
            ? job.maximumSampleGapMicros
            : maximum,
        "0"
      );
      const peakJobHierarchyRssBytes = inventory.reduce(
        (maximum, job) => Math.max(maximum, job.peakJobHierarchyRssBytes),
        0
      );
      if (
        jobMemoryReceipt.sessionId !== evidence.collector.sessionId ||
        jobMemoryReceipt.runManifestDigest !== evidence.runManifestDigest ||
        jobMemoryReceipt.workloadDigest !== evidence.plan.workloadDigest ||
        jobMemoryReceipt.workloadStorageReceiptDigest !== storage.receiptDigest
      ) {
        issues.push("Job memory receipt 未绑定同一 session/run/workload/storage receipt。");
      }
      if (
        evidence.collector.sampler !== "windows-job-object-working-set-v1" ||
        jobMemoryReceipt.sampler !== evidence.collector.sampler ||
        jobMemoryReceipt.memoryScope !== evidence.collector.memoryScope
      ) {
        issues.push("Job memory receipt 未绑定 collector 的 Job Object 采样契约。");
      }
      if (
        inventoryIds.size !== inventory.length ||
        jobMemoryReceipt.jobCount !== inventory.length ||
        jobMemoryReceipt.totalSampleCount !== totalSampleCount ||
        jobMemoryReceipt.totalFailedSampleCount !== 0 ||
        jobMemoryReceipt.maximumSampleGapMicros !== maximumSampleGapMicros ||
        jobMemoryReceipt.peakJobHierarchyRssBytes !== peakJobHierarchyRssBytes
      ) {
        issues.push("Job memory receipt 的聚合值与 raw trial inventory 不一致。");
      }
      if (
        jobMemoryReceipt.jobMemoryInventoryDigest !==
        computeC137PerformanceJobMemoryInventoryDigest(inventory)
      ) {
        issues.push("Job memory receipt 的 inventory digest 不一致。");
      }
      if (evidence.collector.terminalSessionStatus !== "released") {
        issues.push("Job memory receipt 只能绑定 released session。");
      }
      if (
        jobMemoryReceipt.receiptDigest !==
        computeC137PerformanceJobMemoryReceiptDigest(jobMemoryReceipt)
      ) {
        issues.push("Job memory receiptDigest 与规范化内容不一致。");
      }
    } catch (error: unknown) {
      issues.push(`Job memory receipt 无法重算：${formatError(error)}`);
    }
  }
  const terminalCleanupReceipt = evidence.assurance.terminalCleanupReceipt;
  if (terminalCleanupReceipt !== null) {
    try {
      const inventory = projectC137PerformanceTerminalCleanupJobInventory(evidence.trials);
      const inventoryIds = new Set(inventory.map((job) => job.jobId));
      const completedJobCount = inventory.filter((job) => job.status === "completed").length;
      const failedJobCount = inventory.filter((job) => job.status === "failed").length;
      const cancelledJobCount = inventory.filter((job) => job.status === "cancelled").length;
      const latestJobTick = inventory.reduce(
        (latest, job) =>
          compareDecimalTicks(job.endTickNs, latest) > 0 ? job.endTickNs : latest,
        "0"
      );
      if (
        terminalCleanupReceipt.sessionId !== evidence.collector.sessionId ||
        terminalCleanupReceipt.runManifestDigest !== evidence.runManifestDigest ||
        terminalCleanupReceipt.workloadDigest !== evidence.plan.workloadDigest ||
        terminalCleanupReceipt.workloadStorageReceiptDigest !== storage.receiptDigest
      ) {
        issues.push("terminal cleanup receipt 未绑定同一 session/run/workload/storage receipt。");
      }
      if (
        inventoryIds.size !== inventory.length ||
        terminalCleanupReceipt.jobCount !== inventory.length ||
        terminalCleanupReceipt.completedJobCount !== completedJobCount ||
        terminalCleanupReceipt.failedJobCount !== failedJobCount ||
        terminalCleanupReceipt.cancelledJobCount !== cancelledJobCount
      ) {
        issues.push("terminal cleanup receipt 的 job 计数与 raw trial inventory 不一致。");
      }
      if (
        terminalCleanupReceipt.jobInventoryDigest !==
        computeC137PerformanceTerminalCleanupJobInventoryDigest(inventory)
      ) {
        issues.push("terminal cleanup receipt 的 jobInventoryDigest 不一致。");
      }
      if (compareDecimalTicks(terminalCleanupReceipt.terminalTickNs, latestJobTick) < 0) {
        issues.push("terminal cleanup receipt 的 terminal tick 早于 job 终态。");
      }
      if (evidence.collector.terminalSessionStatus !== "released") {
        issues.push("terminal cleanup receipt 只能绑定 released session。");
      }
      if (
        terminalCleanupReceipt.receiptDigest !==
        computeC137PerformanceTerminalCleanupReceiptDigest(terminalCleanupReceipt)
      ) {
        issues.push("terminal cleanup receiptDigest 与规范化内容不一致。");
      }
    } catch (error: unknown) {
      issues.push(`terminal cleanup receipt 无法重算：${formatError(error)}`);
    }
  }
  for (const receipt of evidence.cacheResets) {
    if (
      receipt.receiptDigest !==
      computeC137PerformanceCacheResetReceiptDigestV2(omitReceiptDigestV2(receipt))
    ) {
      issues.push(`cache reset ${receipt.trialId} v2 receiptDigest 不一致。`);
    }
  }
  if (evidence.evidenceDigest !== computeC137PerformanceEvidenceDigestV2(evidence)) {
    issues.push("evidence.evidenceDigest 与 raw evidence v2 不一致。");
  }
  if (issues.length > 0) return { valid: false, complete: false, issues, completenessIssues };

  evaluateCompleteness(evidence, completenessIssues);
  return {
    valid: true,
    complete: completenessIssues.length === 0,
    issues: [],
    completenessIssues
  };
}

export function parseC137PerformanceEvidence(json: string): C137PerformanceRawEvidence {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error(`C137 性能 evidence JSON 无法解析：${formatError(error)}`);
  }
  const validation = validateC137PerformanceEvidence(value);
  if (!validation.valid) {
    throw new Error(`C137 性能 evidence 无效：${validation.issues.join("；")}`);
  }
  return value as C137PerformanceRawEvidence;
}

export function serializeC137PerformanceEvidence(
  evidence: C137PerformanceRawEvidence
): string {
  const validation = validateC137PerformanceEvidence(evidence);
  if (!validation.valid) {
    throw new Error(`拒绝序列化无效的 C137 性能 evidence：${validation.issues.join("；")}`);
  }
  return `${canonicalJson(evidence)}\n`;
}

export function getC137PerformanceMeasuredRuns(
  evidence: C137PerformanceRawEvidenceV1
): C137PerformanceRunV1[];
export function getC137PerformanceMeasuredRuns(
  evidence: C137PerformanceRawEvidenceV2
): C137PerformanceRunV2[];
export function getC137PerformanceMeasuredRuns(
  evidence: C137PerformanceRawEvidence
): Array<C137PerformanceRunV1 | C137PerformanceRunV2> {
  return evidence.trials.filter(
    (trial): trial is C137PerformanceRunV1 | C137PerformanceRunV2 =>
      trial.trialType === "run" && trial.runKind !== "warmup"
  );
}

export function getC137PerformancePeakRss(
  run: C137PerformanceRunV1 | C137PerformanceRunV2
): number | null {
  const peaks = run.cases.map((item) => item.telemetry.memory.peakProcessTreeRssBytes);
  if (peaks.length === 0 || peaks.some((item) => item === null)) return null;
  return Math.max(...(peaks as number[]));
}

function evaluateCompleteness(
  evidence: C137PerformanceRawEvidence,
  issues: string[]
): void {
  if (evidence.status !== "complete") issues.push(`evidence status 为 ${evidence.status}。`);
  if (!evidence.preflight.ok) issues.push("媒体 preflight 未通过。");
  if (evidence.preflight.realRelationCount !== evidence.plan.expectedCaseCount) {
    issues.push("preflight 真实关系数与计划 expectedCaseCount 不一致。");
  }
  if (evidence.environment.measurementStatus !== "complete") {
    issues.push("环境与工具链指纹不完整。");
  }
  if (evidence.environment.issues.length > 0) {
    issues.push("环境采集器报告了未解决问题。");
  }
  if (evidence.environment.physicalCoreCount !== 4) {
    issues.push("性能 evidence 不是在规定 4 物理核目标机上采集。");
  }
  if (evidence.collector.terminalSessionStatus !== "released") {
    issues.push("原生独占 session 没有安全释放。");
  }
  if (evidence.collector.sampler === "unsupported") {
    issues.push("当前平台没有受支持的进程树 RSS 采集器。");
  }
  if (evidence.collector.memorySampleIntervalMs !== evidence.plan.memorySampleIntervalMs) {
    issues.push("collector 采样间隔与预注册计划不一致。");
  }
  if (evidence.issueCodes.length > 0) issues.push("raw evidence 带有运行问题码。");
  const observedSamplers = evidence.trials.flatMap((trial) =>
    trial.trialType === "run"
      ? trial.cases.map((item) => item.telemetry.memory.sampler)
      : [trial.telemetry.memory.sampler]
  );
  if (observedSamplers.some((sampler) => sampler !== evidence.collector.sampler)) {
    issues.push("collector sampler 与 job telemetry 不一致。");
  }

  const expected = evidence.plan.trialOrder;
  if (evidence.trials.length !== expected.length) {
    issues.push("实际 trial 数量与预注册计划不一致，不能挑选性删除或补写 trial。");
  }
  const resetByTrial = new Map(evidence.cacheResets.map((item) => [item.trialId, item]));
  const runById = new Map<string, C137PerformanceRunV1 | C137PerformanceRunV2>();
  const completedOutputDigests: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const planned = expected[index];
    const actual = evidence.trials[index];
    if (!actual || actual.trialId !== planned.trialId) {
      issues.push(`trial[${index}] 与预注册顺序不一致。`);
      continue;
    }
    if (actual.trialType === "run") {
      if (planned.kind !== actual.runKind) {
        issues.push(`trial ${planned.trialId} kind 与计划不一致。`);
      }
      validateCompleteRun(evidence, planned, actual, resetByTrial, runById, issues);
      runById.set(actual.trialId, actual);
      if (actual.outputDigest) completedOutputDigests.push(actual.outputDigest);
    } else {
      if (planned.kind !== "cancellation") {
        issues.push(`trial ${planned.trialId} 被错误替换为 cancellation。`);
      }
      validateCompleteCancellation(evidence, planned, actual, resetByTrial, issues);
    }
  }
  if (new Set(completedOutputDigests).size !== 1) {
    issues.push("cold/warmup/hot 输出 digest 不完全一致。");
  }
  if (resetByTrial.size !== evidence.cacheResets.length) {
    issues.push("cache reset receipt trialId 重复。");
  }
  const resetRequired = expected.filter(
    (trial) => trial.kind === "cold" || trial.kind === "cancellation"
  );
  if (
    evidence.cacheResets.length !== resetRequired.length ||
    resetRequired.some((trial) => !resetByTrial.has(trial.trialId))
  ) {
    issues.push("cold/cancellation 的 cache reset receipt 不完整或有多余记录。");
  }
  for (const [index, reset] of evidence.cacheResets.entries()) {
    if (reset.sessionId !== evidence.collector.sessionId) {
      issues.push(`cache reset ${reset.trialId} session 与 collector 不一致。`);
    }
    if (reset.cacheGeneration <= reset.previousGeneration) {
      issues.push(`cache reset ${reset.trialId} generation 没有前进。`);
    }
    const previous = evidence.cacheResets[index - 1];
    if (previous && reset.previousGeneration !== previous.cacheGeneration) {
      issues.push(`cache reset ${reset.trialId} generation 链不连续。`);
    }
  }
  const jobIds = evidence.trials.flatMap((trial) =>
    trial.trialType === "run"
      ? trial.cases.map((item) => item.jobId)
      : [trial.jobId]
  );
  if (new Set(jobIds).size !== jobIds.length) {
    issues.push("不同 trial/case 不得复用同一个原生 jobId。");
  }
}

function validateCompleteRun(
  evidence: C137PerformanceRawEvidence,
  planned: C137PerformancePlanTrialV1,
  run: C137PerformanceRunV1 | C137PerformanceRunV2,
  resetByTrial: Map<string, C137PerformanceCacheResetReceiptV1 | C137PerformanceCacheResetReceiptV2>,
  runById: Map<string, C137PerformanceRunV1 | C137PerformanceRunV2>,
  issues: string[]
): void {
  if (run.status !== "completed") issues.push(`run ${run.trialId} 未完成。`);
  if (run.sessionId !== evidence.collector.sessionId) issues.push(`run ${run.trialId} session 不一致。`);
  if (run.workloadDigest !== evidence.plan.workloadDigest) issues.push(`run ${run.trialId} workload 不一致。`);
  if (run.repetition !== planned.repetition) issues.push(`run ${run.trialId} repetition 不一致。`);
  if (run.warmupTrialId !== planned.warmupTrialId) {
    issues.push(`run ${run.trialId} warmup 绑定与计划不一致。`);
  }
  if (elapsedTicksMs(run.startTickNs, run.endTickNs) !== run.elapsedMs) {
    issues.push(`run ${run.trialId} elapsedMs 不是由原生 tick 重算。`);
  }
  if (run.cases.length !== evidence.plan.expectedCaseCount) {
    issues.push(`run ${run.trialId} case 数与计划不一致。`);
  }
  if (new Set(run.cases.map((item) => item.caseOrdinal)).size !== run.cases.length) {
    issues.push(`run ${run.trialId} caseOrdinal 重复。`);
  }
  const expectedOrdinals = Array.from(
    { length: evidence.plan.expectedCaseCount },
    (_, index) => index
  );
  if (!deepEqual(run.cases.map((item) => item.caseOrdinal), expectedOrdinals)) {
    issues.push(`run ${run.trialId} caseOrdinal 不连续或被重排。`);
  }
  if (run.outputDigest === null || run.cases.some((item) => item.outputDigest === null)) {
    issues.push(`run ${run.trialId} 缺输出 digest。`);
  } else {
    const derivedOutputDigest = computeC137PerformanceCanonicalDigest({
      domain: "c137-time-map-output-suite-v1",
      cases: run.cases.map((item) => ({
        caseOrdinal: item.caseOrdinal,
        digest: item.outputDigest
      }))
    });
    if (run.outputDigest !== derivedOutputDigest) {
      issues.push(`run ${run.trialId} outputDigest 不是由 case 输出重算。`);
    }
  }
  const firstCase = run.cases[0];
  const lastCase = run.cases.at(-1);
  if (
    !firstCase ||
    !lastCase ||
    lastCase.telemetry.endTickNs === null ||
    run.startTickNs !== firstCase.telemetry.startTickNs ||
    run.endTickNs !== lastCase.telemetry.endTickNs
  ) {
    issues.push(`run ${run.trialId} 总区间没有绑定首尾 case 的原生 tick。`);
  }
  for (const [caseIndex, item] of run.cases.entries()) {
    validateCompleteCase(evidence.plan, run, item, issues);
    const previous = run.cases[caseIndex - 1];
    if (
      previous?.telemetry.endTickNs !== null &&
      previous !== undefined &&
      compareDecimalTicks(item.telemetry.startTickNs, previous.telemetry.endTickNs) < 0
    ) {
      issues.push(`run ${run.trialId} case ${item.caseOrdinal} 与前一 case 时间区间重叠。`);
    }
    if (
      item.telemetry.cache.generation !== firstCase?.telemetry.cache.generation
    ) {
      issues.push(`run ${run.trialId} 的 case cache generation 不一致。`);
    }
    if (
      previous &&
      !deepEqual(previous.telemetry.cache.after, item.telemetry.cache.before)
    ) {
      issues.push(`run ${run.trialId} 的相邻 case 缓存状态不连续。`);
    }
  }

  const reset = resetByTrial.get(run.trialId);
  if (run.runKind === "cold") {
    if (!reset || run.cacheResetReceiptDigest !== reset.receiptDigest) {
      issues.push(`cold run ${run.trialId} 没有绑定对应 reset receipt。`);
    } else {
      if (
        reset.sessionId !== run.sessionId ||
        compareDecimalTicks(reset.resetTickNs, run.startTickNs) > 0
      ) {
        issues.push(`cold run ${run.trialId} reset receipt 的 session/tick 不匹配。`);
      }
      if (!reset.allCachesEmpty || !isEmptyCacheCounts(reset.after)) {
        issues.push(`cold run ${run.trialId} reset 后缓存不为空。`);
      }
      if (run.cases[0]?.telemetry.cache.generation !== reset.cacheGeneration) {
        issues.push(`cold run ${run.trialId} cache generation 不一致。`);
      }
      const firstCacheBefore = run.cases[0]?.telemetry.cache.before;
      if (
        !firstCacheBefore ||
        !isEmptyCacheCounts(firstCacheBefore) ||
        !deepEqual(firstCacheBefore, reset.after)
      ) {
        issues.push(`cold run ${run.trialId} 实际起跑缓存不为空或未消费 reset 状态。`);
      }
    }
  } else if (run.cacheResetReceiptDigest !== null) {
    issues.push(`${run.runKind} run ${run.trialId} 不得伪装成 cold reset。`);
  }
  if (run.runKind === "hot") {
    if (run.warmupTrialId !== planned.warmupTrialId || !run.warmupTrialId) {
      issues.push(`hot run ${run.trialId} 未绑定计划中的 warmup。`);
    } else {
      const warmup = runById.get(run.warmupTrialId);
      if (!warmup || warmup.runKind !== "warmup" || warmup.sessionId !== run.sessionId) {
        issues.push(`hot run ${run.trialId} 的 warmup 不存在或不在同一进程 session。`);
      } else if (
        warmup.cases.at(-1)?.telemetry.cache.generation !==
        run.cases[0]?.telemetry.cache.generation
      ) {
        issues.push(`hot run ${run.trialId} 与 warmup cache generation 不一致。`);
      } else if (
        !deepEqual(
          warmup.cases.at(-1)?.telemetry.cache.after,
          run.cases[0]?.telemetry.cache.before
        )
      ) {
        issues.push(`hot run ${run.trialId} 没有从 warmup 的完整缓存状态继续。`);
      }
    }
    const cacheCounters = run.cases.map((item) => item.telemetry.cache);
    const misses = sum(cacheCounters.flatMap(cacheMissCounts));
    const hits = sum(cacheCounters.flatMap(cacheHitCounts));
    const evictions = sum(cacheCounters.flatMap(cacheEvictionCounts));
    if (hits <= 0 || misses !== 0 || evictions !== 0) {
      issues.push(`hot run ${run.trialId} 没有证明完整 warm cache 命中。`);
    }
  }
}

function validateCompleteCase(
  plan: C137PerformancePlanV1,
  run: C137PerformanceRunV1 | C137PerformanceRunV2,
  item: C137PerformanceCaseV1 | C137PerformanceCaseV2,
  issues: string[]
): void {
  const telemetry = item.telemetry;
  if (item.status !== "completed") issues.push(`run ${run.trialId} case ${item.caseOrdinal} 未完成。`);
  if (
    item.timeMapParametersHash === null ||
    item.timeMapDigest === null ||
    item.outputDigest === null
  ) {
    issues.push(`run ${run.trialId} case ${item.caseOrdinal} 缺参数或 TimeMap 摘要。`);
  } else {
    const derivedOutputDigest = computeC137PerformanceCaseOutputDigest({
      caseOrdinal: item.caseOrdinal,
      requestParametersDigest: item.requestParametersDigest,
      timeMapParametersHash: item.timeMapParametersHash,
      timeMapDigest: item.timeMapDigest
    });
    if (item.outputDigest !== derivedOutputDigest) {
      issues.push(`run ${run.trialId} case ${item.caseOrdinal} 输出未绑定实际请求与原生参数摘要。`);
    }
  }
  if (telemetry.cancellation !== null) {
    issues.push(`run ${run.trialId} case ${item.caseOrdinal} 是 measured run，不得携带取消请求。`);
  }
  if (telemetry.endTickNs === null) issues.push(`run ${run.trialId} case ${item.caseOrdinal} 缺终态 tick。`);
  if (
    telemetry.endTickNs !== null &&
    elapsedTicksMs(telemetry.startTickNs, telemetry.endTickNs) !== Math.floor(telemetry.elapsedMs)
  ) {
    issues.push(`run ${run.trialId} case ${item.caseOrdinal} native elapsed 不一致。`);
  }
  validateStageSequence(
    telemetry,
    `run ${run.trialId} case ${item.caseOrdinal}`,
    "completed",
    issues
  );
  const stageKeys = new Set(telemetry.stages.map((stage) => stage.stageKey));
  for (const required of plan.requiredStageKeys) {
    if (!stageKeys.has(required)) {
      issues.push(`run ${run.trialId} case ${item.caseOrdinal} 缺 stage ${required}。`);
    }
  }
  for (const stage of telemetry.stages) {
    if (elapsedTicksMs(stage.startTickNs, stage.endTickNs) !== Math.floor(stage.elapsedMs)) {
      issues.push(`run ${run.trialId} case ${item.caseOrdinal} stage ${stage.stageKey} elapsed 不一致。`);
    }
  }
  validateCompleteMemory(
    plan,
    telemetry.memory,
    `run ${run.trialId} case ${item.caseOrdinal}`,
    issues
  );
}

function validateCompleteCancellation(
  evidence: C137PerformanceRawEvidence,
  planned: C137PerformancePlanTrialV1,
  trial: C137PerformanceCancellationTrialV1 | C137PerformanceCancellationTrialV2,
  resetByTrial: Map<string, C137PerformanceCacheResetReceiptV1 | C137PerformanceCacheResetReceiptV2>,
  issues: string[]
): void {
  const reset = resetByTrial.get(trial.trialId);
  if (!reset || trial.cacheResetReceiptDigest !== reset.receiptDigest) {
    issues.push(`cancellation ${trial.trialId} 没有绑定 reset receipt。`);
  } else {
    if (
      reset.sessionId !== trial.sessionId ||
      reset.cacheGeneration !== trial.telemetry.cache.generation ||
      compareDecimalTicks(reset.resetTickNs, trial.telemetry.startTickNs) > 0 ||
      !reset.allCachesEmpty ||
      !isEmptyCacheCounts(reset.after) ||
      !deepEqual(reset.after, trial.telemetry.cache.before)
    ) {
      issues.push(`cancellation ${trial.trialId} 没有从所绑定的空缓存 generation 起跑。`);
    }
  }
  if (trial.repetition !== planned.repetition) issues.push(`cancellation ${trial.trialId} repetition 不一致。`);
  if (trial.sessionId !== evidence.collector.sessionId) issues.push(`cancellation ${trial.trialId} session 不一致。`);
  if (trial.workloadDigest !== evidence.plan.workloadDigest) issues.push(`cancellation ${trial.trialId} workload 不一致。`);
  if (trial.triggerStageKey !== planned.cancellationStageKey) issues.push(`cancellation ${trial.trialId} trigger stage 不一致。`);
  if (trial.caseOrdinal !== planned.cancellationCaseOrdinal) {
    issues.push(`cancellation ${trial.trialId} caseOrdinal 与计划不一致。`);
  }
  if (elapsedTicksMs(trial.requestTickNs, trial.terminalTickNs) !== Math.floor(trial.latencyMs)) {
    issues.push(`cancellation ${trial.trialId} latency 不是由原生 tick 重算。`);
  }
  const nativeCancellation = trial.telemetry.cancellation;
  if (
    nativeCancellation === null ||
    trial.requestTickNs !== nativeCancellation.requestTickNs ||
    trial.terminalTickNs !== nativeCancellation.terminalTickNs ||
    trial.latencyMs !== nativeCancellation.latencyMs ||
    trial.commandAccepted !== nativeCancellation.commandAccepted
  ) {
    issues.push(`cancellation ${trial.trialId} 外层结果与原生 cancellation telemetry 不一致。`);
  }
  if (
    trial.telemetry.endTickNs === null ||
    trial.terminalTickNs !== trial.telemetry.endTickNs ||
    compareDecimalTicks(trial.requestTickNs, trial.telemetry.startTickNs) < 0 ||
    compareDecimalTicks(trial.requestTickNs, trial.terminalTickNs) > 0
  ) {
    issues.push(`cancellation ${trial.trialId} 请求/终态 tick 不在原生 job 区间内。`);
  }
  const triggerStage = trial.telemetry.stages.find(
    (stage) =>
      stage.stageKey === trial.triggerStageKey &&
      compareDecimalTicks(trial.requestTickNs, stage.startTickNs) >= 0 &&
      compareDecimalTicks(trial.requestTickNs, stage.endTickNs) <= 0
  );
  if (!triggerStage || triggerStage.status !== "cancelled") {
    issues.push(`cancellation ${trial.trialId} 请求 tick 未落在计划触发 stage 的 cancelled 区间。`);
  }
  validateStageSequence(
    trial.telemetry,
    `cancellation ${trial.trialId}`,
    "cancelled",
    issues
  );
  validateCompleteMemory(
    evidence.plan,
    trial.telemetry.memory,
    `cancellation ${trial.trialId}`,
    issues
  );
  if (
    !trial.commandAccepted ||
    trial.terminalStatus !== "cancelled" ||
    !trial.processTreeEmpty ||
    trial.residualProcessCount !== 0 ||
    trial.processTreeEmpty !== trial.telemetry.memory.processTreeEmptyAtTerminal ||
    trial.residualProcessCount !== trial.telemetry.memory.residualProcessCount
  ) {
    issues.push(`cancellation ${trial.trialId} 没有得到干净 cancelled 终态。`);
  }
}

function validateStageSequence(
  telemetry: C137PerformanceNativeTelemetryV1 | C137PerformanceNativeTelemetryV2,
  label: string,
  terminalStatus: "completed" | "cancelled",
  issues: string[]
): void {
  const terminalTick = telemetry.endTickNs;
  if (terminalTick === null || telemetry.stages.length === 0) return;
  const occurrences = new Map<C137PerformanceStageKeyV1, number>();
  let previousEndTick = telemetry.startTickNs;
  for (const [index, stage] of telemetry.stages.entries()) {
    const expectedOccurrence = (occurrences.get(stage.stageKey) ?? 0) + 1;
    occurrences.set(stage.stageKey, expectedOccurrence);
    if (stage.occurrence !== expectedOccurrence) {
      issues.push(`${label} stage ${stage.stageKey} occurrence 不连续。`);
    }
    if (
      compareDecimalTicks(stage.startTickNs, telemetry.startTickNs) < 0 ||
      compareDecimalTicks(stage.startTickNs, previousEndTick) < 0 ||
      compareDecimalTicks(stage.endTickNs, terminalTick) > 0
    ) {
      issues.push(`${label} stage ${stage.stageKey} 超出 job 区间或与前一阶段重叠。`);
    }
    const expectedStatus =
      terminalStatus === "cancelled" && index === telemetry.stages.length - 1
        ? "cancelled"
        : "completed";
    if (stage.status !== expectedStatus) {
      issues.push(`${label} stage ${stage.stageKey} 终态顺序不一致。`);
    }
    previousEndTick = stage.endTickNs;
  }
  if (previousEndTick !== terminalTick) {
    issues.push(`${label} 最后 stage 没有闭合到原生 terminal tick。`);
  }
}

function validateCompleteMemory(
  plan: C137PerformancePlanV1,
  memory: C137PerformanceMemoryTelemetryV1,
  label: string,
  issues: string[]
): void {
  if (
    memory.scope !== "application-process-tree" ||
    memory.sampler === "unsupported" ||
    memory.sampleIntervalMs !== plan.memorySampleIntervalMs ||
    memory.sampleCount <= 0 ||
    memory.failedSampleCount !== 0 ||
    memory.maximumSampleGapMs > plan.maximumMemorySampleGapMs ||
    memory.peakProcessTreeRssBytes === null ||
    memory.peakProcessTreeRssBytes > C137_PERFORMANCE_MAX_PEAK_PROCESS_TREE_RSS_BYTES ||
    !memory.coverageComplete ||
    !memory.processTreeEmptyAtTerminal ||
    memory.residualProcessCount !== 0
  ) {
    issues.push(`${label} 进程树 RSS evidence 不完整。`);
  }
}

function validatePlan(value: unknown, issues: string[]): void {
  const path = "evidence.plan";
  const record = strictRecord(value, path, ["schemaVersion", "planId", "workloadDigest", "expectedCaseCount", "trialOrder", "requiredStageKeys", "memorySampleIntervalMs", "maximumMemorySampleGapMs", "outputCanonicalization", "parameters"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireOpaqueId(record.planId, `${path}.planId`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireBoundedPositiveSafeInteger(
    record.expectedCaseCount,
    `${path}.expectedCaseCount`,
    1,
    C137_PERFORMANCE_MAX_CASES_PER_RUN,
    issues
  );
  validateArray(record.trialOrder, `${path}.trialOrder`, issues, C137_PERFORMANCE_MAX_TRIALS, (item, itemPath) => {
    const trial = strictRecord(item, itemPath, ["trialId", "kind", "repetition", "warmupTrialId", "cancellationStageKey", "cancellationCaseOrdinal"], issues);
    if (!trial) return;
    requireOpaqueId(trial.trialId, `${itemPath}.trialId`, issues);
    requireOneOf(trial.kind, ["cold", "warmup", "hot", "cancellation"], `${itemPath}.kind`, issues);
    requirePositiveSafeInteger(trial.repetition, `${itemPath}.repetition`, issues);
    requireNullableOpaqueId(trial.warmupTrialId, `${itemPath}.warmupTrialId`, issues);
    requireNullableStageKey(trial.cancellationStageKey, `${itemPath}.cancellationStageKey`, issues);
    requireNullableNonNegativeSafeInteger(
      trial.cancellationCaseOrdinal,
      `${itemPath}.cancellationCaseOrdinal`,
      issues
    );
    if (trial.kind === "hot") {
      if (trial.warmupTrialId === null) {
        issues.push(`${itemPath}.warmupTrialId：hot trial 必须绑定先前 warmup。`);
      }
    } else if (trial.warmupTrialId !== null) {
      issues.push(`${itemPath}.warmupTrialId：只有 hot trial 可以绑定 warmup。`);
    }
    if (trial.kind === "cancellation") {
      if (trial.cancellationStageKey === null) {
        issues.push(`${itemPath}.cancellationStageKey：cancellation trial 必须声明触发阶段。`);
      }
      if (
        !Number.isSafeInteger(trial.cancellationCaseOrdinal) ||
        (trial.cancellationCaseOrdinal as number) < 0 ||
        (trial.cancellationCaseOrdinal as number) >= (record.expectedCaseCount as number)
      ) {
        issues.push(`${itemPath}.cancellationCaseOrdinal 必须命中计划中的真实 case。`);
      }
    } else if (trial.cancellationStageKey !== null) {
      issues.push(`${itemPath}.cancellationStageKey：只有 cancellation trial 可以声明触发阶段。`);
    } else if (trial.cancellationCaseOrdinal !== null) {
      issues.push(`${itemPath}.cancellationCaseOrdinal：只有 cancellation trial 可以声明 case。`);
    }
  });
  validateUniqueObjectStringField(
    record.trialOrder,
    "trialId",
    `${path}.trialOrder`,
    C137_PERFORMANCE_MAX_TRIALS,
    issues
  );
  validateStageKeyArray(record.requiredStageKeys, `${path}.requiredStageKeys`, issues);
  requireBoundedPositiveSafeInteger(record.memorySampleIntervalMs, `${path}.memorySampleIntervalMs`, 10, 1_000, issues);
  requireBoundedPositiveSafeInteger(record.maximumMemorySampleGapMs, `${path}.maximumMemorySampleGapMs`, 10, 10_000, issues);
  if (
    Number.isSafeInteger(record.memorySampleIntervalMs) &&
    Number.isSafeInteger(record.maximumMemorySampleGapMs) &&
    (record.maximumMemorySampleGapMs as number) < (record.memorySampleIntervalMs as number)
  ) {
    issues.push(`${path}.maximumMemorySampleGapMs 不得小于 memorySampleIntervalMs。`);
  }
  requireLiteral(record.outputCanonicalization, "c137-time-map-output-digest-v1", `${path}.outputCanonicalization`, issues);
  validateParameters(record.parameters, issues);
}

function validateParameters(value: unknown, issues: string[]): void {
  const path = "evidence.plan.parameters";
  const record = strictRecord(value, path, ["spectralBackend", "sampleRate", "windowMs", "matchThreshold", "minGapMs", "maxCells", "enableVisualEvidence", "visualSampleIntervalMs"], issues);
  if (!record) return;
  requireOneOf(record.spectralBackend, ["auto", "cuda", "cpu"], `${path}.spectralBackend`, issues);
  requireNullablePositiveSafeInteger(record.sampleRate, `${path}.sampleRate`, issues);
  requireNullablePositiveSafeInteger(record.windowMs, `${path}.windowMs`, issues);
  requireNullablePositiveNumber(record.matchThreshold, `${path}.matchThreshold`, issues);
  requireNullablePositiveSafeInteger(record.minGapMs, `${path}.minGapMs`, issues);
  requireNullablePositiveSafeInteger(record.maxCells, `${path}.maxCells`, issues);
  if (record.enableVisualEvidence !== null && typeof record.enableVisualEvidence !== "boolean") issues.push(`${path}.enableVisualEvidence 必须为 boolean 或 null。`);
  requireNullablePositiveSafeInteger(record.visualSampleIntervalMs, `${path}.visualSampleIntervalMs`, issues);
}

function validateEnvironment(value: unknown, issues: string[]): void {
  const path = "evidence.environment";
  const record = strictRecord(value, path, ["schemaVersion", "digest", "measurementStatus", "issues", "operatingSystem", "operatingSystemVersion", "architecture", "cpuModel", "physicalCoreCount", "logicalCoreCount", "totalMemoryBytes", "storageScope", "storageKind", "powerProfile", "ffmpeg", "ffprobe"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireDigest(record.digest, `${path}.digest`, issues);
  requireOneOf(record.measurementStatus, ["complete", "incomplete"], `${path}.measurementStatus`, issues);
  validateStringArray(record.issues, `${path}.issues`, issues, 64);
  for (const key of ["operatingSystem", "operatingSystemVersion", "architecture", "cpuModel", "storageKind", "powerProfile"]) requireString(record[key], `${path}.${key}`, issues);
  requirePositiveSafeInteger(record.physicalCoreCount, `${path}.physicalCoreCount`, issues);
  requirePositiveSafeInteger(record.logicalCoreCount, `${path}.logicalCoreCount`, issues);
  requirePositiveSafeInteger(record.totalMemoryBytes, `${path}.totalMemoryBytes`, issues);
  requireOneOf(
    record.storageScope,
    ["system-volume", "workload-media-volumes"],
    `${path}.storageScope`,
    issues
  );
  validateToolchain(record.ffmpeg, `${path}.ffmpeg`, issues);
  validateToolchain(record.ffprobe, `${path}.ffprobe`, issues);
}

function validateEnvironmentV2(value: unknown, issues: string[]): void {
  const path = "evidence.environment";
  const record = strictRecord(value, path, ["schemaVersion", "digest", "measurementStatus", "issues", "operatingSystem", "operatingSystemVersion", "architecture", "cpuModel", "physicalCoreCount", "logicalCoreCount", "totalMemoryBytes", "storageScope", "storageKind", "workloadStorage", "powerProfile", "ffmpeg", "ffprobe"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 2, `${path}.schemaVersion`, issues);
  requireDigest(record.digest, `${path}.digest`, issues);
  requireOneOf(record.measurementStatus, ["complete", "incomplete"], `${path}.measurementStatus`, issues);
  validateStringArray(record.issues, `${path}.issues`, issues, 64);
  for (const key of ["operatingSystem", "operatingSystemVersion", "architecture", "cpuModel", "storageKind", "powerProfile"]) requireString(record[key], `${path}.${key}`, issues);
  requirePositiveSafeInteger(record.physicalCoreCount, `${path}.physicalCoreCount`, issues);
  requirePositiveSafeInteger(record.logicalCoreCount, `${path}.logicalCoreCount`, issues);
  requirePositiveSafeInteger(record.totalMemoryBytes, `${path}.totalMemoryBytes`, issues);
  requireLiteral(record.storageScope, "workload-media-volumes", `${path}.storageScope`, issues);
  validateWorkloadStorageReceiptV2(record.workloadStorage, issues);
  validateToolchain(record.ffmpeg, `${path}.ffmpeg`, issues);
  validateToolchain(record.ffprobe, `${path}.ffprobe`, issues);
}

function validateWorkloadStorageReceiptV2(value: unknown, issues: string[]): void {
  const path = "evidence.environment.workloadStorage";
  const record = strictRecord(value, path, ["schemaVersion", "runManifestDigest", "workloadDigest", "bindingCount", "uniqueMediaCount", "volumeCount", "mediaSetDigest", "bindings", "volumes", "receiptDigest"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 2, `${path}.schemaVersion`, issues);
  requireDigest(record.runManifestDigest, `${path}.runManifestDigest`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireBoundedPositiveSafeInteger(
    record.bindingCount,
    `${path}.bindingCount`,
    1,
    C137_PERFORMANCE_MAX_CASES_PER_RUN * 2,
    issues
  );
  requirePositiveSafeInteger(record.uniqueMediaCount, `${path}.uniqueMediaCount`, issues);
  requirePositiveSafeInteger(record.volumeCount, `${path}.volumeCount`, issues);
  requireDigest(record.mediaSetDigest, `${path}.mediaSetDigest`, issues);
  requireDigest(record.receiptDigest, `${path}.receiptDigest`, issues);

  const bindingCount = Number.isSafeInteger(record.bindingCount)
    ? (record.bindingCount as number)
    : 0;
  const uniqueMediaCount = Number.isSafeInteger(record.uniqueMediaCount)
    ? (record.uniqueMediaCount as number)
    : 0;
  const volumeCount = Number.isSafeInteger(record.volumeCount)
    ? (record.volumeCount as number)
    : 0;
  if (bindingCount % 2 !== 0) issues.push(`${path}.bindingCount 必须由 source/target 成对组成。`);
  if (
    volumeCount < 1 ||
    uniqueMediaCount < volumeCount ||
    bindingCount < uniqueMediaCount
  ) {
    issues.push(`${path} 必须满足 1 <= volumeCount <= uniqueMediaCount <= bindingCount。`);
  }

  validateArray(record.bindings, `${path}.bindings`, issues, C137_PERFORMANCE_MAX_CASES_PER_RUN * 2, (item, itemPath) => {
    const binding = strictRecord(item, itemPath, ["bindingOrdinal", "caseOrdinal", "side", "volumeOrdinal"], issues);
    if (!binding) return;
    requireNonNegativeSafeInteger(binding.bindingOrdinal, `${itemPath}.bindingOrdinal`, issues);
    requireNonNegativeSafeInteger(binding.caseOrdinal, `${itemPath}.caseOrdinal`, issues);
    requireOneOf(binding.side, ["source", "target"], `${itemPath}.side`, issues);
    requireNonNegativeSafeInteger(binding.volumeOrdinal, `${itemPath}.volumeOrdinal`, issues);
  });
  validateArray(record.volumes, `${path}.volumes`, issues, C137_PERFORMANCE_MAX_CASES_PER_RUN * 2, (item, itemPath) => {
    const volume = strictRecord(item, itemPath, ["volumeOrdinal", "bindingCount", "driveType", "seekPenalty", "measurementStatus"], issues);
    if (!volume) return;
    requireNonNegativeSafeInteger(volume.volumeOrdinal, `${itemPath}.volumeOrdinal`, issues);
    requirePositiveSafeInteger(volume.bindingCount, `${itemPath}.bindingCount`, issues);
    requireLiteral(volume.driveType, "fixed", `${itemPath}.driveType`, issues);
    requireOneOf(volume.seekPenalty, ["incurs", "none"], `${itemPath}.seekPenalty`, issues);
    requireLiteral(volume.measurementStatus, "complete", `${itemPath}.measurementStatus`, issues);
  });

  if (!Array.isArray(record.bindings) || !Array.isArray(record.volumes)) return;
  if (record.bindings.length !== bindingCount) {
    issues.push(`${path}.bindings 长度与 bindingCount 不一致。`);
  }
  if (record.volumes.length !== volumeCount) {
    issues.push(`${path}.volumes 长度与 volumeCount 不一致。`);
  }
  const actualVolumeCounts = Array.from({ length: Math.max(volumeCount, 0) }, () => 0);
  const firstBindingOrdinals = Array.from(
    { length: Math.max(volumeCount, 0) },
    () => Number.POSITIVE_INFINITY
  );
  for (const [index, item] of record.bindings.entries()) {
    if (!isRecord(item)) continue;
    const expectedCaseOrdinal = Math.floor(index / 2);
    const expectedSide = index % 2 === 0 ? "source" : "target";
    if (
      item.bindingOrdinal !== index ||
      item.caseOrdinal !== expectedCaseOrdinal ||
      item.side !== expectedSide
    ) {
      issues.push(`${path}.bindings[${index}] 未形成连续 case/source/target 闭环。`);
    }
    if (
      Number.isSafeInteger(item.volumeOrdinal) &&
      (item.volumeOrdinal as number) >= 0 &&
      (item.volumeOrdinal as number) < volumeCount
    ) {
      const ordinal = item.volumeOrdinal as number;
      actualVolumeCounts[ordinal] += 1;
      firstBindingOrdinals[ordinal] = Math.min(firstBindingOrdinals[ordinal], index);
    } else {
      issues.push(`${path}.bindings[${index}].volumeOrdinal 未指向已声明 volume。`);
    }
  }
  let previousFirstBindingOrdinal = -1;
  for (const [index, item] of record.volumes.entries()) {
    if (!isRecord(item)) continue;
    if (
      item.volumeOrdinal !== index ||
      item.bindingCount !== actualVolumeCounts[index] ||
      actualVolumeCounts[index] <= 0
    ) {
      issues.push(`${path}.volumes[${index}] ordinal/bindingCount 与 bindings 反向汇总不一致。`);
    }
    if (firstBindingOrdinals[index] <= previousFirstBindingOrdinal) {
      issues.push(`${path}.volumes[${index}] 未按首次 binding 顺序编号。`);
    }
    previousFirstBindingOrdinal = firstBindingOrdinals[index];
  }
}

function validateToolchain(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["version", "binaryDigest"], issues);
  if (!record) return;
  requireString(record.version, `${path}.version`, issues);
  requireDigest(record.binaryDigest, `${path}.binaryDigest`, issues);
}

function validateCollector(value: unknown, issues: string[]): void {
  const path = "evidence.collector";
  const record = strictRecord(value, path, ["schemaVersion", "collectorVersion", "nativeSchemaVersion", "clock", "memoryScope", "sampler", "sessionId", "sessionOriginTickNs", "memorySampleIntervalMs", "terminalSessionStatus"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireString(record.collectorVersion, `${path}.collectorVersion`, issues);
  requireLiteral(record.nativeSchemaVersion, 1, `${path}.nativeSchemaVersion`, issues);
  requireLiteral(record.clock, "rust-std-instant-session-relative-v1", `${path}.clock`, issues);
  requireLiteral(record.memoryScope, "application-process-tree", `${path}.memoryScope`, issues);
  requireOneOf(record.sampler, ["windows-toolhelp-working-set-v1", "windows-job-object-working-set-v1", "unsupported"], `${path}.sampler`, issues);
  requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
  requireLiteral(record.sessionOriginTickNs, "0", `${path}.sessionOriginTickNs`, issues);
  requireBoundedPositiveSafeInteger(record.memorySampleIntervalMs, `${path}.memorySampleIntervalMs`, 10, 1_000, issues);
  if (record.terminalSessionStatus !== null) requireOneOf(record.terminalSessionStatus, ["released", "cleanup-blocked"], `${path}.terminalSessionStatus`, issues);
}

function validateCollectorV2(value: unknown, issues: string[]): void {
  const path = "evidence.collector";
  const record = strictRecord(value, path, ["schemaVersion", "collectorVersion", "nativeSchemaVersion", "clock", "memoryScope", "sampler", "sessionId", "sessionOriginTickNs", "memorySampleIntervalMs", "terminalSessionStatus", "runManifestDigest", "workloadDigest", "workloadStorageReceiptDigest"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 2, `${path}.schemaVersion`, issues);
  requireString(record.collectorVersion, `${path}.collectorVersion`, issues);
  requireLiteral(record.nativeSchemaVersion, 2, `${path}.nativeSchemaVersion`, issues);
  requireLiteral(record.clock, "rust-std-instant-session-relative-v1", `${path}.clock`, issues);
  requireLiteral(record.memoryScope, "application-process-tree", `${path}.memoryScope`, issues);
  requireOneOf(record.sampler, ["windows-toolhelp-working-set-v1", "windows-job-object-working-set-v1", "unsupported"], `${path}.sampler`, issues);
  requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
  requireLiteral(record.sessionOriginTickNs, "0", `${path}.sessionOriginTickNs`, issues);
  requireBoundedPositiveSafeInteger(record.memorySampleIntervalMs, `${path}.memorySampleIntervalMs`, 10, 1_000, issues);
  if (record.terminalSessionStatus !== null) requireOneOf(record.terminalSessionStatus, ["released", "cleanup-blocked"], `${path}.terminalSessionStatus`, issues);
  requireDigest(record.runManifestDigest, `${path}.runManifestDigest`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireDigest(record.workloadStorageReceiptDigest, `${path}.workloadStorageReceiptDigest`, issues);
}

function validateAssuranceV2(value: unknown, issues: string[]): void {
  const path = "evidence.assurance";
  const record = strictRecord(value, path, ["schemaVersion", "workloadStorageReceiptDigest", "jobMemoryReceipt", "terminalCleanupReceipt", "attestation"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireDigest(record.workloadStorageReceiptDigest, `${path}.workloadStorageReceiptDigest`, issues);
  if (record.jobMemoryReceipt !== null) {
    validateJobMemoryReceiptV1(record.jobMemoryReceipt, `${path}.jobMemoryReceipt`, issues);
  }
  if (record.terminalCleanupReceipt !== null) {
    validateTerminalCleanupReceiptV1(
      record.terminalCleanupReceipt,
      `${path}.terminalCleanupReceipt`,
      issues
    );
  }
  requireLiteral(record.attestation, null, `${path}.attestation`, issues);
}

function validateJobMemoryReceiptV1(
  value: unknown,
  path: string,
  issues: string[]
): void {
  const record = strictRecord(
    value,
    path,
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
    issues
  );
  if (!record) return;
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
  requireDigest(record.runManifestDigest, `${path}.runManifestDigest`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireDigest(
    record.workloadStorageReceiptDigest,
    `${path}.workloadStorageReceiptDigest`,
    issues
  );
  requireLiteral(
    record.sampler,
    "windows-job-object-working-set-v1",
    `${path}.sampler`,
    issues
  );
  requireLiteral(
    record.memoryScope,
    "application-process-tree",
    `${path}.memoryScope`,
    issues
  );
  requireNonNegativeSafeInteger(record.jobCount, `${path}.jobCount`, issues);
  requireNonNegativeSafeInteger(record.totalSampleCount, `${path}.totalSampleCount`, issues);
  requireLiteral(record.totalFailedSampleCount, 0, `${path}.totalFailedSampleCount`, issues);
  requireDecimalTick(
    record.maximumSampleGapMicros,
    `${path}.maximumSampleGapMicros`,
    issues
  );
  requireNonNegativeSafeInteger(
    record.peakJobHierarchyRssBytes,
    `${path}.peakJobHierarchyRssBytes`,
    issues
  );
  requireDigest(
    record.jobMemoryInventoryDigest,
    `${path}.jobMemoryInventoryDigest`,
    issues
  );
  requireLiteral(
    record.allJobsCoverageComplete,
    true,
    `${path}.allJobsCoverageComplete`,
    issues
  );
  requireLiteral(record.allSamplesJobBound, true, `${path}.allSamplesJobBound`, issues);
  requireLiteral(
    record.allTerminalProcessTreesEmpty,
    true,
    `${path}.allTerminalProcessTreesEmpty`,
    issues
  );
  requireDigest(record.receiptDigest, `${path}.receiptDigest`, issues);
}

function validateTerminalCleanupReceiptV1(
  value: unknown,
  path: string,
  issues: string[]
): void {
  const record = strictRecord(
    value,
    path,
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
    issues
  );
  if (!record) return;
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
  requireDigest(record.runManifestDigest, `${path}.runManifestDigest`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireDigest(
    record.workloadStorageReceiptDigest,
    `${path}.workloadStorageReceiptDigest`,
    issues
  );
  requireDecimalTick(record.terminalTickNs, `${path}.terminalTickNs`, issues);
  requireNonNegativeSafeInteger(
    record.finalCacheGeneration,
    `${path}.finalCacheGeneration`,
    issues
  );
  for (const key of [
    "jobCount",
    "completedJobCount",
    "failedJobCount",
    "cancelledJobCount"
  ]) {
    requireNonNegativeSafeInteger(record[key], `${path}.${key}`, issues);
  }
  requireDigest(record.jobInventoryDigest, `${path}.jobInventoryDigest`, issues);
  requireLiteral(record.allJobsTerminal, true, `${path}.allJobsTerminal`, issues);
  requireLiteral(record.processTreeEmpty, true, `${path}.processTreeEmpty`, issues);
  requireLiteral(record.residualProcessCount, 0, `${path}.residualProcessCount`, issues);
  requireLiteral(
    record.supervisionCleanupStatus,
    "clean",
    `${path}.supervisionCleanupStatus`,
    issues
  );
  requireLiteral(record.toolchainReverified, true, `${path}.toolchainReverified`, issues);
  requireLiteral(record.workloadReverified, true, `${path}.workloadReverified`, issues);
  requireLiteral(record.featureCachesEmpty, true, `${path}.featureCachesEmpty`, issues);
  requireDigest(record.receiptDigest, `${path}.receiptDigest`, issues);
}

function validatePreflight(value: unknown, issues: string[]): void {
  const path = "evidence.preflight";
  const record = strictRecord(value, path, ["ok", "realRelationCount", "checkedFileCount", "issueCodes"], issues);
  if (!record) return;
  requireBoolean(record.ok, `${path}.ok`, issues);
  requireNonNegativeSafeInteger(record.realRelationCount, `${path}.realRelationCount`, issues);
  requireNonNegativeSafeInteger(record.checkedFileCount, `${path}.checkedFileCount`, issues);
  validateStringArray(record.issueCodes, `${path}.issueCodes`, issues, 256);
}

function validateCacheResets(
  value: unknown,
  issues: string[],
  schemaVersion: 1 | 2 = 1
): void {
  validateArray(value, "evidence.cacheResets", issues, C137_PERFORMANCE_MAX_TRIALS, (item, path) => {
    const record = strictRecord(item, path, ["schemaVersion", "receiptDigest", "trialId", "sessionId", "resetTickNs", "previousGeneration", "cacheGeneration", "before", "after", "allCachesEmpty"], issues);
    if (!record) return;
    requireLiteral(record.schemaVersion, schemaVersion, `${path}.schemaVersion`, issues);
    requireDigest(record.receiptDigest, `${path}.receiptDigest`, issues);
    requireOpaqueId(record.trialId, `${path}.trialId`, issues);
    requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
    requireDecimalTick(record.resetTickNs, `${path}.resetTickNs`, issues);
    requireNonNegativeSafeInteger(record.previousGeneration, `${path}.previousGeneration`, issues);
    requirePositiveSafeInteger(record.cacheGeneration, `${path}.cacheGeneration`, issues);
    validateCacheCounts(record.before, `${path}.before`, issues);
    validateCacheCounts(record.after, `${path}.after`, issues);
    requireBoolean(record.allCachesEmpty, `${path}.allCachesEmpty`, issues);
  });
  validateUniqueObjectStringField(
    value,
    "receiptDigest",
    "evidence.cacheResets",
    C137_PERFORMANCE_MAX_TRIALS,
    issues
  );
}

function validateTrials(
  value: unknown,
  issues: string[],
  schemaVersion: 1 | 2 = 1
): void {
  validateArray(value, "evidence.trials", issues, C137_PERFORMANCE_MAX_TRIALS, (item, path) => {
    if (!isRecord(item)) {
      issues.push(`${path} 必须为对象。`);
      return;
    }
    if (item.trialType === "run") validateRun(item, path, issues, schemaVersion);
    else if (item.trialType === "cancellation") validateCancellation(item, path, issues, schemaVersion);
    else issues.push(`${path}.trialType 无效。`);
  });
  validateUniqueObjectStringField(
    value,
    "trialId",
    "evidence.trials",
    C137_PERFORMANCE_MAX_TRIALS,
    issues
  );
}

function validateRun(
  value: unknown,
  path: string,
  issues: string[],
  schemaVersion: 1 | 2 = 1
): void {
  const record = strictRecord(value, path, ["trialType", "trialId", "runKind", "repetition", "sessionId", "workloadDigest", "status", "startTickNs", "endTickNs", "elapsedMs", "cacheResetReceiptDigest", "warmupTrialId", "outputDigest", "cases"], issues);
  if (!record) return;
  requireLiteral(record.trialType, "run", `${path}.trialType`, issues);
  requireOpaqueId(record.trialId, `${path}.trialId`, issues);
  requireOneOf(record.runKind, ["cold", "warmup", "hot"], `${path}.runKind`, issues);
  requirePositiveSafeInteger(record.repetition, `${path}.repetition`, issues);
  requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireOneOf(record.status, ["completed", "failed", "cancelled"], `${path}.status`, issues);
  requireDecimalTick(record.startTickNs, `${path}.startTickNs`, issues);
  requireDecimalTick(record.endTickNs, `${path}.endTickNs`, issues);
  requireNonNegativeSafeInteger(record.elapsedMs, `${path}.elapsedMs`, issues);
  requireNullableDigest(record.cacheResetReceiptDigest, `${path}.cacheResetReceiptDigest`, issues);
  requireNullableOpaqueId(record.warmupTrialId, `${path}.warmupTrialId`, issues);
  requireNullableDigest(record.outputDigest, `${path}.outputDigest`, issues);
  validateArray(record.cases, `${path}.cases`, issues, C137_PERFORMANCE_MAX_CASES_PER_RUN, (item, itemPath, itemIssues) => validateCase(item, itemPath, itemIssues, schemaVersion));
}

function validateCancellation(
  value: unknown,
  path: string,
  issues: string[],
  schemaVersion: 1 | 2 = 1
): void {
  const record = strictRecord(value, path, ["trialType", "trialId", "repetition", "sessionId", "workloadDigest", "caseOrdinal", "jobId", "triggerStageKey", "requestTickNs", "terminalTickNs", "latencyMs", "commandAccepted", "terminalStatus", "processTreeEmpty", "residualProcessCount", "cacheResetReceiptDigest", "telemetry"], issues);
  if (!record) return;
  requireLiteral(record.trialType, "cancellation", `${path}.trialType`, issues);
  requireOpaqueId(record.trialId, `${path}.trialId`, issues);
  requirePositiveSafeInteger(record.repetition, `${path}.repetition`, issues);
  requireOpaqueId(record.sessionId, `${path}.sessionId`, issues);
  requireDigest(record.workloadDigest, `${path}.workloadDigest`, issues);
  requireNonNegativeSafeInteger(record.caseOrdinal, `${path}.caseOrdinal`, issues);
  requireOpaqueId(record.jobId, `${path}.jobId`, issues);
  requireStageKey(record.triggerStageKey, `${path}.triggerStageKey`, issues);
  requireDecimalTick(record.requestTickNs, `${path}.requestTickNs`, issues);
  requireDecimalTick(record.terminalTickNs, `${path}.terminalTickNs`, issues);
  requireNonNegativeNumber(record.latencyMs, `${path}.latencyMs`, issues);
  requireBoolean(record.commandAccepted, `${path}.commandAccepted`, issues);
  requireOneOf(record.terminalStatus, ["cancelled", "completed", "failed", "timeout"], `${path}.terminalStatus`, issues);
  requireBoolean(record.processTreeEmpty, `${path}.processTreeEmpty`, issues);
  requireNonNegativeSafeInteger(record.residualProcessCount, `${path}.residualProcessCount`, issues);
  requireDigest(record.cacheResetReceiptDigest, `${path}.cacheResetReceiptDigest`, issues);
  validateTelemetry(record.telemetry, `${path}.telemetry`, issues, schemaVersion);
}

function validateCase(
  value: unknown,
  path: string,
  issues: string[],
  schemaVersion: 1 | 2 = 1
): void {
  const record = strictRecord(value, path, ["caseOrdinal", "jobId", "status", "requestParametersDigest", "timeMapParametersHash", "timeMapDigest", "outputDigest", "telemetry"], issues);
  if (!record) return;
  requireNonNegativeSafeInteger(record.caseOrdinal, `${path}.caseOrdinal`, issues);
  requireOpaqueId(record.jobId, `${path}.jobId`, issues);
  requireOneOf(record.status, ["completed", "failed", "cancelled"], `${path}.status`, issues);
  requireDigest(record.requestParametersDigest, `${path}.requestParametersDigest`, issues);
  requireNullableTimeMapParametersHash(
    record.timeMapParametersHash,
    `${path}.timeMapParametersHash`,
    issues
  );
  requireNullableDigest(record.timeMapDigest, `${path}.timeMapDigest`, issues);
  requireNullableDigest(record.outputDigest, `${path}.outputDigest`, issues);
  validateTelemetry(record.telemetry, `${path}.telemetry`, issues, schemaVersion);
}

function validateTelemetry(
  value: unknown,
  path: string,
  issues: string[],
  schemaVersion: 1 | 2 = 1
): void {
  const record = strictRecord(value, path, ["schemaVersion", "clock", "startTickNs", "endTickNs", "elapsedMs", "stages", "cache", "memory", "cancellation"], issues);
  if (!record) return;
  requireLiteral(record.schemaVersion, schemaVersion, `${path}.schemaVersion`, issues);
  requireLiteral(record.clock, "rust-std-instant-session-relative-v1", `${path}.clock`, issues);
  requireDecimalTick(record.startTickNs, `${path}.startTickNs`, issues);
  requireNullableDecimalTick(record.endTickNs, `${path}.endTickNs`, issues);
  requireNonNegativeNumber(record.elapsedMs, `${path}.elapsedMs`, issues);
  validateArray(record.stages, `${path}.stages`, issues, C137_PERFORMANCE_MAX_STAGES_PER_CASE, validateStage);
  validateCacheTelemetry(record.cache, `${path}.cache`, issues);
  validateMemory(record.memory, `${path}.memory`, issues);
  if (record.cancellation !== null) validateCancellationTelemetry(record.cancellation, `${path}.cancellation`, issues);
}

function validateStage(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["stageKey", "occurrence", "startTickNs", "endTickNs", "elapsedMs", "status"], issues);
  if (!record) return;
  requireStageKey(record.stageKey, `${path}.stageKey`, issues);
  requirePositiveSafeInteger(record.occurrence, `${path}.occurrence`, issues);
  requireDecimalTick(record.startTickNs, `${path}.startTickNs`, issues);
  requireDecimalTick(record.endTickNs, `${path}.endTickNs`, issues);
  requireNonNegativeNumber(record.elapsedMs, `${path}.elapsedMs`, issues);
  requireOneOf(record.status, ["completed", "failed", "cancelled"], `${path}.status`, issues);
}

function validateCacheTelemetry(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["generation", "before", "after", "audioFeatures", "landmarks", "visualFeatures"], issues);
  if (!record) return;
  requirePositiveSafeInteger(record.generation, `${path}.generation`, issues);
  validateCacheCounts(record.before, `${path}.before`, issues);
  validateCacheCounts(record.after, `${path}.after`, issues);
  validateCacheCounter(record.audioFeatures, `${path}.audioFeatures`, issues);
  validateCacheCounter(record.landmarks, `${path}.landmarks`, issues);
  validateCacheCounter(record.visualFeatures, `${path}.visualFeatures`, issues);
}

function validateCacheCounts(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["audioFeatureEntries", "landmarkEntries", "visualFeatureEntries"], issues);
  if (!record) return;
  for (const key of ["audioFeatureEntries", "landmarkEntries", "visualFeatureEntries"]) requireNonNegativeSafeInteger(record[key], `${path}.${key}`, issues);
}

function validateCacheCounter(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["hits", "misses", "writes", "evictions"], issues);
  if (!record) return;
  for (const key of ["hits", "misses", "writes", "evictions"]) requireNonNegativeSafeInteger(record[key], `${path}.${key}`, issues);
}

function validateMemory(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["scope", "sampler", "sampleIntervalMs", "sampleCount", "failedSampleCount", "maximumSampleGapMs", "peakProcessTreeRssBytes", "coverageComplete", "processTreeEmptyAtTerminal", "residualProcessCount"], issues);
  if (!record) return;
  requireLiteral(record.scope, "application-process-tree", `${path}.scope`, issues);
  requireOneOf(record.sampler, ["windows-toolhelp-working-set-v1", "windows-job-object-working-set-v1", "unsupported"], `${path}.sampler`, issues);
  requireBoundedPositiveSafeInteger(record.sampleIntervalMs, `${path}.sampleIntervalMs`, 10, 1_000, issues);
  requireNonNegativeSafeInteger(record.sampleCount, `${path}.sampleCount`, issues);
  requireNonNegativeSafeInteger(record.failedSampleCount, `${path}.failedSampleCount`, issues);
  requireNonNegativeNumber(record.maximumSampleGapMs, `${path}.maximumSampleGapMs`, issues);
  if (record.peakProcessTreeRssBytes !== null) requireNonNegativeSafeInteger(record.peakProcessTreeRssBytes, `${path}.peakProcessTreeRssBytes`, issues);
  requireBoolean(record.coverageComplete, `${path}.coverageComplete`, issues);
  requireBoolean(record.processTreeEmptyAtTerminal, `${path}.processTreeEmptyAtTerminal`, issues);
  requireNonNegativeSafeInteger(record.residualProcessCount, `${path}.residualProcessCount`, issues);
}

function validateCancellationTelemetry(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(value, path, ["requestTickNs", "terminalTickNs", "latencyMs", "commandAccepted"], issues);
  if (!record) return;
  requireDecimalTick(record.requestTickNs, `${path}.requestTickNs`, issues);
  requireDecimalTick(record.terminalTickNs, `${path}.terminalTickNs`, issues);
  requireNonNegativeNumber(record.latencyMs, `${path}.latencyMs`, issues);
  requireBoolean(record.commandAccepted, `${path}.commandAccepted`, issues);
}

function omitEvidenceDigest(evidence: C137PerformanceRawEvidenceV1): C137PerformanceEvidenceDraftV1 {
  const { evidenceDigest, ...draft } = evidence;
  void evidenceDigest;
  return draft;
}

function omitEvidenceDigestV2(
  evidence: C137PerformanceRawEvidenceV2
): C137PerformanceEvidenceDraftV2 {
  const { evidenceDigest, ...draft } = evidence;
  void evidenceDigest;
  return draft;
}

function omitEnvironmentDigest(environment: C137PerformanceEnvironmentV1): Omit<C137PerformanceEnvironmentV1, "digest"> {
  const { digest, ...value } = environment;
  void digest;
  return value;
}

function omitEnvironmentDigestV2(
  environment: C137PerformanceEnvironmentV2
): Omit<C137PerformanceEnvironmentV2, "digest"> {
  const { digest, ...value } = environment;
  void digest;
  return value;
}

function omitReceiptDigest(receipt: C137PerformanceCacheResetReceiptV1): Omit<C137PerformanceCacheResetReceiptV1, "receiptDigest"> {
  const { receiptDigest, ...value } = receipt;
  void receiptDigest;
  return value;
}

function omitReceiptDigestV2(
  receipt: C137PerformanceCacheResetReceiptV2
): Omit<C137PerformanceCacheResetReceiptV2, "receiptDigest"> {
  const { receiptDigest, ...value } = receipt;
  void receiptDigest;
  return value;
}

function omitWorkloadStorageReceiptDigest(
  receipt: C137PerformanceWorkloadStorageReceiptV2
): Omit<C137PerformanceWorkloadStorageReceiptV2, "receiptDigest"> {
  const { receiptDigest, ...value } = receipt;
  void receiptDigest;
  return value;
}

function omitJobMemoryReceiptDigest(
  receipt: C137PerformanceJobMemoryReceiptV1
): Omit<C137PerformanceJobMemoryReceiptV1, "receiptDigest"> {
  const { receiptDigest, ...value } = receipt;
  void receiptDigest;
  return value;
}

function omitTerminalCleanupReceiptDigest(
  receipt: C137PerformanceTerminalCleanupReceiptV1
): Omit<C137PerformanceTerminalCleanupReceiptV1, "receiptDigest"> {
  const { receiptDigest, ...value } = receipt;
  void receiptDigest;
  return value;
}

function requireTerminalTelemetryEndTick(
  telemetry: C137PerformanceNativeTelemetryV2,
  jobId: string
): string {
  if (
    telemetry.endTickNs === null ||
    !telemetry.memory.processTreeEmptyAtTerminal ||
    telemetry.memory.residualProcessCount !== 0
  ) {
    throw new Error(`terminal cleanup inventory 的 job ${jobId} 缺少可信终态。`);
  }
  return telemetry.endTickNs;
}

function cacheMissCounts(cache: C137PerformanceCacheTelemetryV1): number[] {
  return [cache.audioFeatures.misses, cache.landmarks.misses, cache.visualFeatures.misses];
}

function cacheHitCounts(cache: C137PerformanceCacheTelemetryV1): number[] {
  return [cache.audioFeatures.hits, cache.landmarks.hits, cache.visualFeatures.hits];
}

function cacheEvictionCounts(cache: C137PerformanceCacheTelemetryV1): number[] {
  return [cache.audioFeatures.evictions, cache.landmarks.evictions, cache.visualFeatures.evictions];
}

function isEmptyCacheCounts(counts: C137PerformanceCacheCountsV1): boolean {
  return counts.audioFeatureEntries === 0 && counts.landmarkEntries === 0 && counts.visualFeatureEntries === 0;
}

function elapsedTicksMs(start: string, end: string): number | null {
  try {
    const startTick = BigInt(start);
    const endTick = BigInt(end);
    if (startTick < 0n || endTick < startTick) return null;
    const value = Number((endTick - startTick) / 1_000_000n);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function compareDecimalTicks(left: string, right: string): number {
  const leftTick = BigInt(left);
  const rightTick = BigInt(right);
  return leftTick < rightTick ? -1 : leftTick > rightTick ? 1 : 0;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function strictRecord(value: unknown, path: string, keys: readonly string[], issues: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.push(`${path} 必须为对象。`);
    return null;
  }
  const expected = new Set(keys);
  for (const key of keys) if (!(key in value)) issues.push(`${path}.${key} 缺失。`);
  for (const key of Object.keys(value)) if (!expected.has(key)) issues.push(`${path}.${key} 是未知字段。`);
  return value;
}

function validateArray(value: unknown, path: string, issues: string[], maximumLength: number, validate: (item: unknown, path: string, issues: string[]) => void): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须为数组。`);
    return;
  }
  if (value.length > maximumLength) issues.push(`${path} 超过 ${maximumLength} 项上限。`);
  value
    .slice(0, maximumLength)
    .forEach((item, index) => validate(item, `${path}[${index}]`, issues));
}

function validateUniqueObjectStringField(
  value: unknown,
  field: string,
  path: string,
  maximumLength: number,
  issues: string[]
): void {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  for (const item of value.slice(0, maximumLength)) {
    if (!isRecord(item) || typeof item[field] !== "string") continue;
    const key = item[field];
    if (seen.has(key)) issues.push(`${path}.${field} 重复：${key}。`);
    seen.add(key);
  }
}

function validateStageKeyArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > STAGE_KEYS.size) {
    issues.push(`${path} 必须为非空且有界的 stage 数组。`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    requireStageKey(item, `${path}[${index}]`, issues);
    if (typeof item === "string" && seen.has(item)) issues.push(`${path} 不得重复 stage ${item}。`);
    if (typeof item === "string") seen.add(item);
  });
}

function validateStringArray(value: unknown, path: string, issues: string[], maximumLength: number): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须为数组。`);
    return;
  }
  if (value.length > maximumLength) issues.push(`${path} 超过 ${maximumLength} 项上限。`);
  value
    .slice(0, maximumLength)
    .forEach((item, index) => requireString(item, `${path}[${index}]`, issues));
}

function requireLiteral(value: unknown, expected: string | number | boolean | null, path: string, issues: string[]): void {
  if (value !== expected) issues.push(`${path} 必须为 ${String(expected)}。`);
}

function requireOneOf(value: unknown, expected: readonly string[], path: string, issues: string[]): void {
  if (typeof value !== "string" || !expected.includes(value)) issues.push(`${path} 必须为 ${expected.join(" / ")}。`);
}

function requireString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_024) issues.push(`${path} 必须为 1–1024 字符非空字符串。`);
}

function requireOpaqueId(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) issues.push(`${path} 必须为 8–160 位 opaque ID。`);
}

function requireNullableOpaqueId(value: unknown, path: string, issues: string[]): void {
  if (value !== null) requireOpaqueId(value, path, issues);
}

function requireDigest(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) issues.push(`${path} 必须为规范 SHA-256。`);
}

function requireNullableDigest(value: unknown, path: string, issues: string[]): void {
  if (value !== null) requireDigest(value, path, issues);
}

function requireNullableTimeMapParametersHash(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (value !== null && (typeof value !== "string" || !/^fnv1a64:[0-9a-f]{16}$/.test(value))) {
    issues.push(`${path} 必须为规范 fnv1a64 参数摘要或 null。`);
  }
}

function requireBoolean(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "boolean") issues.push(`${path} 必须为 boolean。`);
}

function requirePositiveSafeInteger(value: unknown, path: string, issues: string[]): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) issues.push(`${path} 必须为正安全整数。`);
}

function requireNonNegativeSafeInteger(value: unknown, path: string, issues: string[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) issues.push(`${path} 必须为非负安全整数。`);
}

function requireBoundedPositiveSafeInteger(value: unknown, path: string, minimum: number, maximum: number, issues: string[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) issues.push(`${path} 必须为 ${minimum}–${maximum} 的安全整数。`);
}

function requireNullablePositiveSafeInteger(value: unknown, path: string, issues: string[]): void {
  if (value !== null) requirePositiveSafeInteger(value, path, issues);
}

function requireNullableNonNegativeSafeInteger(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (value !== null) requireNonNegativeSafeInteger(value, path, issues);
}

function requireNonNegativeNumber(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) issues.push(`${path} 必须为非负有限数。`);
}

function requireNullablePositiveNumber(value: unknown, path: string, issues: string[]): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) issues.push(`${path} 必须为正有限数或 null。`);
}

function requireDecimalTick(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,30})$/.test(value)) issues.push(`${path} 必须为规范非负十进制 tick。`);
}

function requireNullableDecimalTick(value: unknown, path: string, issues: string[]): void {
  if (value !== null) requireDecimalTick(value, path, issues);
}

function requireStageKey(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !STAGE_KEYS.has(value as C137PerformanceStageKeyV1)) issues.push(`${path} 不是受支持的 stage key。`);
}

function requireNullableStageKey(value: unknown, path: string, issues: string[]): void {
  if (value !== null) requireStageKey(value, path, issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sum(values: number[]): number {
  return values.reduce((total, item) => total + item, 0);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
