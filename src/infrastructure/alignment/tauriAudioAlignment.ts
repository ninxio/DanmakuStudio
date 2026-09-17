import { invoke, isTauri } from "@tauri-apps/api/core";
import { isLockedFineSpectralBackendIdentity } from "../../domain/alignment/fineSpectralBackend";
import { isAlignmentProposal } from "../../domain/alignment/manualProvider";
import {
  isSpectralBackendPreference,
  type SpectralBackendPreference
} from "../../domain/alignment/spectralBackendPreference";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA,
  parseMultimodalBlindReviewPackJson
} from "../../domain/alignment/multimodalBlindReview";
import { sha256Hex } from "../../domain/shared/sha256";

export interface TauriAudioAlignmentRequest {
  algorithm?: "audio" | "visual-aap";
  completePath: string;
  sourcePath: string;
  ffmpegPath: string | null;
  ffprobePath?: string | null;
  completeAudioStreamIndex?: number | null;
  sourceAudioStreamIndex?: number | null;
  completeVideoStreamIndex?: number | null;
  sourceVideoStreamIndex?: number | null;
  spectralBackend?: SpectralBackendPreference;
  sampleRate?: number;
  windowMs?: number;
  matchThreshold?: number;
  minGapMs?: number;
  maxCells?: number;
  enableVisualEvidence?: boolean;
  visualSampleIntervalMs?: number;
  localizationMode?: boolean;
}

export interface NormalizedTauriAudioAlignmentRequest extends Omit<
  TauriAudioAlignmentRequest,
  | "ffprobePath"
  | "completeAudioStreamIndex"
  | "sourceAudioStreamIndex"
  | "completeVideoStreamIndex"
  | "sourceVideoStreamIndex"
  | "spectralBackend"
> {
  ffprobePath: string | null;
  completeAudioStreamIndex: number | null;
  sourceAudioStreamIndex: number | null;
  completeVideoStreamIndex: number | null;
  sourceVideoStreamIndex: number | null;
  spectralBackend: SpectralBackendPreference;
}

export type AudioAlignmentInvoker = (
  request: NormalizedTauriAudioAlignmentRequest
) => Promise<AlignmentProposal>;

export type AudioAlignmentJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

const AUDIO_ALIGNMENT_STAGE_CONTRACT = {
  queued: { status: "queued", label: "排队", index: 0 },
  validating: { status: "running", label: "校验输入", index: 1 },
  "extracting-complete": { status: "running", label: "提取完整版特征", index: 2 },
  "extracting-source": { status: "running", label: "提取删减版特征", index: 3 },
  "extracting-visual": { status: "running", label: "提取视觉证据", index: 4 },
  fingerprinting: { status: "running", label: "生成稀疏指纹", index: 5 },
  matching: { status: "running", label: "建立候选观测", index: 6 },
  fitting: { status: "running", label: "拟合时间映射", index: 7 },
  refining: { status: "running", label: "确认持续变点", index: 8 },
  reporting: { status: "running", label: "生成复核数据", index: 9 },
  completed: { status: "completed", label: "已完成", index: 9 },
  failed: { status: "failed", label: "失败", index: 9 },
  cancelled: { status: "cancelled", label: "已取消", index: 9 }
} as const satisfies Record<
  string,
  { status: AudioAlignmentJobStatus; label: string; index: number }
>;

export type AudioAlignmentStageKey = keyof typeof AUDIO_ALIGNMENT_STAGE_CONTRACT;

const AUDIO_ALIGNMENT_STAGE_KEYS = Object.keys(
  AUDIO_ALIGNMENT_STAGE_CONTRACT
) as AudioAlignmentStageKey[];
const AUDIO_ALIGNMENT_STAGE_COUNT = Math.max(
  ...Object.values(AUDIO_ALIGNMENT_STAGE_CONTRACT).map((stage) => stage.index)
);

export interface AudioAlignmentJobSnapshot {
  jobId: string;
  status: AudioAlignmentJobStatus;
  progress: number;
  message: string;
  stageKey: AudioAlignmentStageKey;
  stageLabel: string;
  stageIndex: number;
  stageCount: number;
  stageProgress: number;
  logs: string[];
  proposal: AlignmentProposal | null;
  error: string | null;
  updatedAtMs: number;
}

export interface AudioAlignmentJobInvoker {
  start: (request: NormalizedTauriAudioAlignmentRequest) => Promise<AudioAlignmentJobSnapshot>;
  get: (jobId: string) => Promise<AudioAlignmentJobSnapshot>;
  cancel: (jobId: string) => Promise<AudioAlignmentJobSnapshot>;
}

export interface TauriAudioAlignmentBatchMedia {
  mediaId: string;
  path: string;
  audioStreamIndex?: number | null;
  videoStreamIndex?: number | null;
}

export interface TauriAudioAlignmentBatchPair {
  sourceMediaId: string;
  targetMediaId: string;
}

export type AudioAlignmentBatchVersionGroupSide = "source" | "target";

export interface AudioAlignmentBatchVersionReuseGroup {
  groupId: string;
  side: AudioAlignmentBatchVersionGroupSide;
  mediaIds: string[];
}

export interface AudioAlignmentBatchVersionReuseGroupSnapshot extends AudioAlignmentBatchVersionReuseGroup {
  groupOrdinal: number;
}

export interface TauriAudioAlignmentBatchRequest {
  sources: TauriAudioAlignmentBatchMedia[];
  targets: TauriAudioAlignmentBatchMedia[];
  pairs?: TauriAudioAlignmentBatchPair[];
  versionReuseGroups?: AudioAlignmentBatchVersionReuseGroup[];
  ffmpegPath: string | null;
  ffprobePath?: string | null;
  spectralBackend?: SpectralBackendPreference;
  sampleRate?: number;
  windowMs?: number;
  matchThreshold?: number;
  minGapMs?: number;
  maxCells?: number;
  enableVisualEvidence?: boolean;
  visualSampleIntervalMs?: number;
  localizationMode: true;
}

export interface NormalizedTauriAudioAlignmentBatchRequest extends Omit<
  TauriAudioAlignmentBatchRequest,
  "sources" | "targets" | "ffprobePath" | "spectralBackend" | "versionReuseGroups"
> {
  schemaVersion: 2;
  sources: Required<TauriAudioAlignmentBatchMedia>[];
  targets: Required<TauriAudioAlignmentBatchMedia>[];
  versionReuseGroups: AudioAlignmentBatchVersionReuseGroup[];
  ffprobePath: string | null;
  spectralBackend: SpectralBackendPreference;
}

export interface AudioAlignmentBatchPairSnapshot {
  pairIndex: number;
  pairOrdinal: number;
  sourceMediaId: string;
  targetMediaId: string;
  status: AudioAlignmentJobStatus;
  progress: number;
  message: string;
  relationRanking: AudioAlignmentBatchRelationRankingSnapshot;
  globalSelection: AudioAlignmentBatchGlobalSelectionSnapshot;
  fineFrontier: AudioAlignmentBatchFineFrontierReceiptSnapshot | null;
  fineExecutionEvidence: AudioAlignmentBatchFineExecutionEvidenceSnapshot | null;
  proposal: AlignmentProposal | null;
  error: string | null;
}

export type AudioAlignmentBatchDiagnosticLevel = "info" | "warning" | "error";

export interface AudioAlignmentBatchDiagnosticEvent {
  sequence: number;
  atMs: number;
  elapsedMs: number;
  level: AudioAlignmentBatchDiagnosticLevel;
  stageKey: string;
  mediaOrdinal: number | null;
  pairOrdinal: number | null;
  message: string;
  durationMs: number | null;
}

export type AudioAlignmentBatchPairingMode = "fullCartesian" | "explicit";
export type AudioAlignmentBatchGlobalSelectionState =
  "pending" | "selected" | "blocked" | "failed" | "cancelled";

export interface AudioAlignmentBatchGlobalCandidateSnapshot {
  rank: number;
  sourceStreamIndex: number;
  targetStreamIndex: number;
  score: number;
  globalScore: number;
  scale: number;
  offsetMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  inlierCount: number;
  temporalCoverage: number;
  uniqueSourceCoverage: number;
  eligible: boolean;
  globalSelected: boolean;
}

export interface AudioAlignmentBatchGlobalSelectionSnapshot {
  state: AudioAlignmentBatchGlobalSelectionState;
  selected: boolean;
  selectedRank: number | null;
  selectedScore: number | null;
  decisionRank: number | null;
  decisionScore: number | null;
  margin: number | null;
  candidateCount: number;
  eligibleCandidateCount: number;
  topK: AudioAlignmentBatchGlobalCandidateSnapshot[];
  decisionCandidate: AudioAlignmentBatchGlobalCandidateSnapshot | null;
}

export const AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION =
  "alignment-v2-pair-intrinsic-global-weight-v1" as const;

export type AudioAlignmentBatchRelationRankingState =
  "pending" | "ranked" | "noEligibleCandidate" | "failed" | "cancelled";

export interface AudioAlignmentBatchRelationCandidateSnapshot {
  rank: number;
  sourceStreamIndex: number;
  targetStreamIndex: number;
  score: number;
  globalScore: number;
  scale: number;
  offsetMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  inlierCount: number;
  temporalCoverage: number;
  uniqueSourceCoverage: number;
}

export interface AudioAlignmentBatchSpectralBackendIdentitySnapshot {
  backendId: string;
  requestedBackend: string;
  backendDetail: string;
  fallbackReason: string | null;
}

export const AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION =
  "alignment-v2-adaptive-fine-frontier-v3" as const;
export const AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION =
  "alignment-v2-coarse-upper-times-confidence-v1" as const;

export interface AudioAlignmentBatchFineCandidateIdSnapshot {
  pairOrdinal: number;
  candidateOrdinal: number;
}

export interface AudioAlignmentBatchFineInventoryCandidateSnapshot {
  id: AudioAlignmentBatchFineCandidateIdSnapshot;
  coarseUpperBoundMicros: number;
  sourceAxisReuseGroupOrdinal: number | null;
  targetAxisReuseGroupOrdinal: number | null;
  members: AudioAlignmentBatchRelationCandidateSnapshot[];
}

export interface AudioAlignmentBatchFineStateCountsSnapshot {
  unresolved: number;
  scored: number;
  evaluatedIneligible: number;
  evidenceBlocked: number;
  resourceBlocked: number;
  infrastructureFailed: number;
  cancelled: number;
}

export interface AudioAlignmentBatchFineAssignmentSnapshot {
  candidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
  totalScoreMicros: number;
}

export interface AudioAlignmentBatchFineOmittedAssignmentSnapshot {
  candidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
  totalUpperBoundMicros: number;
  openCandidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
  unresolvedCandidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
  blockedCandidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
}

export interface AudioAlignmentBatchFineResolutionProofSnapshot {
  beatsRunnerUpWithMargin: boolean;
  beatsOptimisticOmittedWithMargin: boolean;
}

export interface AudioAlignmentBatchFineSearchSnapshot {
  statesVisited: number;
  expansionsConsidered: number;
  intervalComparisons: number;
}

export interface AudioAlignmentBatchFineLimitsSnapshot {
  maxCandidates: number;
  maxSearchStates: number;
  maxSearchExpansions: number;
  maxIntervalComparisons: number;
  maxIntervalsPerAxis: number;
  maxTotalIntervals: number;
  refinementBatchSize: number;
}

export type AudioAlignmentBatchFineFrontierState =
  "resolved" | "noEligibleCandidate" | "unresolved" | "failed";

export interface AudioAlignmentBatchFineFrontierReceiptSnapshot {
  contractVersion: typeof AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION;
  scoreVersion: typeof AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION;
  inventoryDigest: `sha256:${string}`;
  inventoryCandidates: AudioAlignmentBatchFineInventoryCandidateSnapshot[];
  receiptDigest: `sha256:${string}`;
  componentOrdinal: number;
  componentPairOrdinals: number[];
  inventoryCandidateCount: number;
  resolutionMarginMicros: number;
  overlapToleranceMs: number;
  limits: AudioAlignmentBatchFineLimitsSnapshot;
  inventoryStateCounts: AudioAlignmentBatchFineStateCountsSnapshot;
  refinementRoundCount: number;
  evaluatedCandidateCount: number;
  finalState: AudioAlignmentBatchFineFrontierState;
  resolved: boolean;
  selectedCandidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
  selectedTotalScoreMicros: number | null;
  bestCompleted: AudioAlignmentBatchFineAssignmentSnapshot;
  runnerUpCompleted: AudioAlignmentBatchFineAssignmentSnapshot | null;
  optimisticOmitted: AudioAlignmentBatchFineOmittedAssignmentSnapshot | null;
  nextRefinementCandidateIds: AudioAlignmentBatchFineCandidateIdSnapshot[];
  deferredCandidateCount: number;
  proof: AudioAlignmentBatchFineResolutionProofSnapshot;
  search: AudioAlignmentBatchFineSearchSnapshot;
}

export interface AudioAlignmentBatchFineDecodeWindowSnapshot {
  startMs: number;
  endMs: number;
  presentationOffsetMs: number;
  sampleRate: number;
  expectedSampleCount: number;
  actualDecodedSampleCount: number | null;
}

export interface AudioAlignmentBatchFineExecutionEvidenceSnapshot {
  candidateId: AudioAlignmentBatchFineCandidateIdSnapshot;
  selectedMemberRank: number;
  groupMemberRanks: number[];
  sourceStreamIndex: number;
  targetStreamIndex: number;
  sourceCoarseBackend: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
  targetCoarseBackend: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
  sourceFineBackend: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
  targetFineBackend: AudioAlignmentBatchSpectralBackendIdentitySnapshot;
  sourceRequestedWindow: AudioAlignmentBatchFineDecodeWindowSnapshot;
  targetRequestedWindow: AudioAlignmentBatchFineDecodeWindowSnapshot;
  sourceEffectiveWindow: AudioAlignmentBatchFineDecodeWindowSnapshot;
  targetEffectiveWindow: AudioAlignmentBatchFineDecodeWindowSnapshot;
  parametersHash: `sha256:${string}`;
  occupancyDigest: `sha256:${string}`;
  proposalTimeMapDigest: `sha256:${string}`;
  scoreMicros: number;
  evidenceDigest: `sha256:${string}`;
}

export interface AudioAlignmentBatchExecutionIdentitySnapshot {
  schemaVersion: 1;
  engineVersion: string;
  featureVersion: string;
  relationScoreVersion: typeof AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION;
  nativeExecutableDigest: `sha256:${string}`;
  ffmpegBinaryDigest: `sha256:${string}`;
  ffprobeBinaryDigest: `sha256:${string}`;
  sourceSpectralBackends: AudioAlignmentBatchSpectralBackendIdentitySnapshot[];
  targetSpectralBackends: AudioAlignmentBatchSpectralBackendIdentitySnapshot[];
}

export interface AudioAlignmentBatchRelationRankingSnapshot {
  scoreVersion: typeof AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION;
  executionIdentityDigest: `sha256:${string}` | null;
  executionIdentity: AudioAlignmentBatchExecutionIdentitySnapshot | null;
  state: AudioAlignmentBatchRelationRankingState;
  candidateCount: number;
  eligibleCandidateCount: number;
  score: number | null;
  bestEligibleCandidate: AudioAlignmentBatchRelationCandidateSnapshot | null;
}

export interface AudioAlignmentBatchJobSnapshot {
  schemaVersion: 2;
  evidenceVersion: 5;
  jobId: string;
  pairingMode: AudioAlignmentBatchPairingMode;
  sourceMediaIds: string[];
  targetMediaIds: string[];
  versionReuseGroups: AudioAlignmentBatchVersionReuseGroupSnapshot[];
  status: AudioAlignmentJobStatus;
  progress: number;
  message: string;
  totalPairCount: number;
  processedPairCount: number;
  failedPairCount: number;
  currentPairOrdinal: number | null;
  diagnosticEvents: AudioAlignmentBatchDiagnosticEvent[];
  pairs: AudioAlignmentBatchPairSnapshot[];
  error: string | null;
  updatedAtMs: number;
}

export interface AudioAlignmentBatchJobInvoker {
  start: (
    request: NormalizedTauriAudioAlignmentBatchRequest
  ) => Promise<AudioAlignmentBatchJobSnapshot>;
  get: (jobId: string) => Promise<AudioAlignmentBatchJobSnapshot>;
  cancel: (jobId: string) => Promise<AudioAlignmentBatchJobSnapshot>;
}

export type AlignmentSensitiveManifestIntakeState =
  "collecting" | "ready" | "partial" | "unusable";

export interface AlignmentSensitiveReviewTaskSummary {
  queryKey: `sha256:${string}`;
  sourceTimestampMs: number;
  sourcePreviewStartMs: number;
  sourcePreviewEndMs: number;
  targetReviewStartMs: number;
  targetReviewEndMs: number;
  candidateTimestampsMs: number[];
  category: string;
  riskScoreMicros: number;
}

export interface AlignmentSensitiveReviewPairSummary {
  pairOrdinal: number;
  sourceMediaIdDigest: `sha256:${string}`;
  targetMediaIdDigest: `sha256:${string}`;
  riskyTaskCount: number;
  tasks: AlignmentSensitiveReviewTaskSummary[];
}

export interface AlignmentSensitiveManifestSummary {
  runId: string;
  manifestPayloadDigest: `sha256:${string}`;
  manifestCanonicalPayloadDigest: `sha256:${string}` | null;
  lifecycleStage: "queued" | "prepared" | "terminal";
  createdAtMs: number;
  updatedAtMs: number;
  appVersion: string;
  engineVersion: string;
  featureVersion: string;
  status: AudioAlignmentJobStatus;
  sourceMediaCount: number;
  targetMediaCount: number;
  pairCount: number;
  processedPairCount: number;
  completedPairCount: number;
  failedPairCount: number;
  cancelledPairCount: number;
  preparedMediaCount: number;
  identifiedMediaCount: number;
  audioCandidateCount: number;
  landmarkArtifactCount: number;
  landmarkCacheHitCount: number;
  evidenceSpanCount: number;
  uncertainSpanCount: number;
  visualEvidencePairCount: number;
  visualEvidenceRequested: boolean;
  evidenceGroupKey: `sha256:${string}` | null;
  intakeState: AlignmentSensitiveManifestIntakeState;
  readyForTrainingIntake: boolean;
  reviewCandidatePairs: AlignmentSensitiveReviewPairSummary[];
  notes: string[];
}

export type AlignmentSensitiveManifestSummaryInvoker = () => Promise<unknown>;

export interface BuildAlignmentSensitiveBlindReviewPackRequest {
  runId: string;
  pairOrdinal: number;
  mediaFamilyId: `sha256:${string}`;
}

export type BuildAlignmentSensitiveBlindReviewPackInvoker = (
  request: BuildAlignmentSensitiveBlindReviewPackRequest
) => Promise<unknown>;

export type AudioAlignmentDiagnosticLogDirectoryInvoker = () => Promise<void>;

export async function runTauriAudioAlignment(
  request: TauriAudioAlignmentRequest,
  invoker: AudioAlignmentInvoker = defaultAudioAlignmentInvoker
): Promise<AlignmentProposal> {
  if (invoker === defaultAudioAlignmentInvoker && !isTauri()) {
    throw new Error("本地媒体对齐需要在 Tauri 桌面端运行。");
  }
  const normalizedRequest = normalizeAudioAlignmentRequest(request);
  try {
    return await invoker(normalizedRequest);
  } catch (error: unknown) {
    throw new Error(`本地音频对齐失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function startTauriAudioAlignmentJob(
  request: TauriAudioAlignmentRequest,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  const normalizedRequest = normalizeAudioAlignmentRequest(request);
  try {
    return validateAudioAlignmentJobSnapshot(await invoker.start(normalizedRequest));
  } catch (error: unknown) {
    throw new Error(`音频对齐任务启动失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function getTauriAudioAlignmentJob(
  jobId: string,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  try {
    return validateAudioAlignmentJobSnapshot(await invoker.get(jobId), jobId);
  } catch (error: unknown) {
    throw new Error(`音频对齐任务读取失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function cancelTauriAudioAlignmentJob(
  jobId: string,
  invoker: AudioAlignmentJobInvoker = defaultAudioAlignmentJobInvoker
): Promise<AudioAlignmentJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentJobInvoker);
  try {
    return validateAudioAlignmentJobSnapshot(await invoker.cancel(jobId), jobId);
  } catch (error: unknown) {
    throw new Error(`音频对齐任务取消失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export function isAudioAlignmentJobFinished(status: AudioAlignmentJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export async function startTauriAudioAlignmentBatchJob(
  request: TauriAudioAlignmentBatchRequest,
  invoker: AudioAlignmentBatchJobInvoker = defaultAudioAlignmentBatchJobInvoker
): Promise<AudioAlignmentBatchJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentBatchJobInvoker);
  const normalizedRequest = normalizeAudioAlignmentBatchRequest(request);
  try {
    const snapshot = validateAudioAlignmentBatchJobSnapshot(
      await invoker.start(normalizedRequest)
    );
    validateStartedAudioAlignmentBatchSnapshot(snapshot, normalizedRequest);
    return snapshot;
  } catch (error: unknown) {
    throw new Error(`批量音频对齐任务启动失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function getTauriAudioAlignmentBatchJob(
  jobId: string,
  invoker: AudioAlignmentBatchJobInvoker = defaultAudioAlignmentBatchJobInvoker
): Promise<AudioAlignmentBatchJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentBatchJobInvoker);
  try {
    return validateAudioAlignmentBatchJobSnapshot(await invoker.get(jobId), jobId);
  } catch (error: unknown) {
    throw new Error(`批量音频对齐任务读取失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function cancelTauriAudioAlignmentBatchJob(
  jobId: string,
  invoker: AudioAlignmentBatchJobInvoker = defaultAudioAlignmentBatchJobInvoker
): Promise<AudioAlignmentBatchJobSnapshot> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentBatchJobInvoker);
  try {
    return validateAudioAlignmentBatchJobSnapshot(await invoker.cancel(jobId), jobId);
  } catch (error: unknown) {
    throw new Error(`批量音频对齐任务取消失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function openAudioAlignmentDiagnosticLogDirectory(
  invoker: AudioAlignmentDiagnosticLogDirectoryInvoker = defaultAudioAlignmentDiagnosticLogDirectoryInvoker
): Promise<void> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentDiagnosticLogDirectoryInvoker);
  try {
    await invoker();
  } catch (error: unknown) {
    throw new Error(`打开对齐诊断日志目录失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function openAudioAlignmentSensitiveManifestDirectory(
  invoker: AudioAlignmentDiagnosticLogDirectoryInvoker = defaultAudioAlignmentSensitiveManifestDirectoryInvoker
): Promise<void> {
  ensureDesktopAudioAlignment(
    invoker === defaultAudioAlignmentSensitiveManifestDirectoryInvoker
  );
  try {
    await invoker();
  } catch (error: unknown) {
    throw new Error(`打开本机训练证据目录失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function listAudioAlignmentSensitiveManifestSummaries(
  invoker: AlignmentSensitiveManifestSummaryInvoker = defaultAudioAlignmentSensitiveManifestSummaryInvoker
): Promise<AlignmentSensitiveManifestSummary[]> {
  ensureDesktopAudioAlignment(invoker === defaultAudioAlignmentSensitiveManifestSummaryInvoker);
  try {
    const value = await invoker();
    if (!Array.isArray(value) || value.length > 16) {
      throw new Error("本机训练证据索引必须是最多 16 项的数组。");
    }
    const summaries = value.map((item, index) =>
      validateAlignmentSensitiveManifestSummary(item, `本机训练证据[${index}]`)
    );
    summaries.forEach((summary, index) => {
      if (index > 0 && summary.updatedAtMs > summaries[index - 1].updatedAtMs) {
        throw new Error("本机训练证据索引未按更新时间倒序排列。");
      }
      if (
        summaries.some(
          (candidate, candidateIndex) =>
            candidateIndex < index && candidate.runId === summary.runId
        )
      ) {
        throw new Error("本机训练证据索引包含重复运行编号。");
      }
    });
    return summaries;
  } catch (error: unknown) {
    throw new Error(`读取本机训练证据索引失败：${formatAudioAlignmentFailure(error)}`);
  }
}

export async function buildAudioAlignmentSensitiveBlindReviewPack(
  runId: string,
  pairOrdinal: number,
  mediaFamilyLabel: string,
  invoker: BuildAlignmentSensitiveBlindReviewPackInvoker = defaultBuildAlignmentSensitiveBlindReviewPackInvoker
): Promise<string> {
  ensureDesktopAudioAlignment(invoker === defaultBuildAlignmentSensitiveBlindReviewPackInvoker);
  const normalizedRunId = runId.trim();
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(normalizedRunId)) {
    throw new Error("真实证据运行编号无效。");
  }
  if (!Number.isSafeInteger(pairOrdinal) || pairOrdinal < 1 || pairOrdinal > 65_536) {
    throw new Error("真实证据关系序号无效。");
  }
  const normalizedFamilyLabel = mediaFamilyLabel.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalizedFamilyLabel.length < 3 || normalizedFamilyLabel.length > 80) {
    throw new Error("媒体家族名称需要 3 至 80 个字符，例如“Dark 第三季”。");
  }
  const mediaFamilyId = `sha256:${sha256Hex(
    `danmaku-studio/real-evidence-media-family/v1\n${normalizedFamilyLabel.toLowerCase()}`
  )}` as const;
  try {
    const result = await invoker({ runId: normalizedRunId, pairOrdinal, mediaFamilyId });
    if (typeof result !== "string" || result.length === 0 || result.length > 1024 * 1024) {
      throw new Error("桌面端返回的盲复核任务包大小或类型无效。");
    }
    const pack = parseMultimodalBlindReviewPackJson(result);
    if (
      pack.schemaVersion !== ALIGNMENT_BLIND_REVIEW_PACK_V2_SCHEMA ||
      pack.mediaFamilyId !== mediaFamilyId ||
      pack.provenance.pairOrdinal !== pairOrdinal ||
      pack.provenance.kind !== "realAlignmentRun"
    ) {
      throw new Error("盲复核任务包与所选运行、关系或媒体家族不一致。");
    }
    return result;
  } catch (error: unknown) {
    throw new Error(`生成真实证据盲复核任务失败：${formatAudioAlignmentFailure(error)}`);
  }
}

function defaultAudioAlignmentInvoker(
  request: NormalizedTauriAudioAlignmentRequest
): Promise<AlignmentProposal> {
  return invoke<AlignmentProposal>("align_audio_files", { request });
}

const defaultAudioAlignmentJobInvoker: AudioAlignmentJobInvoker = {
  start: (request) =>
    invoke<AudioAlignmentJobSnapshot>("start_audio_alignment_job", { request }),
  get: (jobId) => invoke<AudioAlignmentJobSnapshot>("get_audio_alignment_job", { jobId }),
  cancel: (jobId) => invoke<AudioAlignmentJobSnapshot>("cancel_audio_alignment_job", { jobId })
};

const defaultAudioAlignmentBatchJobInvoker: AudioAlignmentBatchJobInvoker = {
  start: (request) =>
    invoke<AudioAlignmentBatchJobSnapshot>("start_audio_alignment_batch_job", { request }),
  get: (jobId) =>
    invoke<AudioAlignmentBatchJobSnapshot>("get_audio_alignment_batch_job", { jobId }),
  cancel: (jobId) =>
    invoke<AudioAlignmentBatchJobSnapshot>("cancel_audio_alignment_batch_job", { jobId })
};

const defaultAudioAlignmentDiagnosticLogDirectoryInvoker: AudioAlignmentDiagnosticLogDirectoryInvoker =
  () => invoke<void>("open_alignment_diagnostic_log_directory");

const defaultAudioAlignmentSensitiveManifestDirectoryInvoker: AudioAlignmentDiagnosticLogDirectoryInvoker =
  () => invoke<void>("open_alignment_sensitive_manifest_directory");

const defaultAudioAlignmentSensitiveManifestSummaryInvoker: AlignmentSensitiveManifestSummaryInvoker =
  () => invoke<unknown>("list_alignment_sensitive_manifest_summaries");

const defaultBuildAlignmentSensitiveBlindReviewPackInvoker: BuildAlignmentSensitiveBlindReviewPackInvoker =
  (request) => invoke<unknown>("build_alignment_sensitive_blind_review_pack", { request });

function ensureDesktopAudioAlignment(usesDefaultInvoker: boolean): void {
  if (usesDefaultInvoker && !isTauri()) {
    throw new Error("本地媒体对齐需要在 Tauri 桌面端运行。");
  }
}

function normalizeAudioAlignmentRequest(
  request: TauriAudioAlignmentRequest
): NormalizedTauriAudioAlignmentRequest {
  return {
    ...request,
    ffprobePath: request.ffprobePath ?? null,
    completeAudioStreamIndex: normalizeAudioStreamIndex(
      request.completeAudioStreamIndex,
      "原片音轨索引"
    ),
    sourceAudioStreamIndex: normalizeAudioStreamIndex(
      request.sourceAudioStreamIndex,
      "参考视频音轨索引"
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

function normalizeAudioAlignmentBatchRequest(
  request: TauriAudioAlignmentBatchRequest
): NormalizedTauriAudioAlignmentBatchRequest {
  const sources = normalizeBatchMedia(request.sources, "B 站参考素材");
  const targets = normalizeBatchMedia(request.targets, "原片素材");
  const sourceIds = new Set(sources.map((item) => item.mediaId));
  const duplicateAcrossSides = targets.find((item) => sourceIds.has(item.mediaId));
  if (duplicateAcrossSides) {
    throw new Error(`批量音频对齐的媒体 ID 必须全局唯一：${duplicateAcrossSides.mediaId}`);
  }
  const pairs = request.pairs
    ? normalizeBatchPairs(
        request.pairs,
        sourceIds,
        new Set(targets.map((item) => item.mediaId))
      )
    : undefined;
  const versionReuseGroups = normalizeVersionReuseGroups(
    request.versionReuseGroups ?? [],
    sources.map((item) => item.mediaId),
    targets.map((item) => item.mediaId)
  );
  if ((pairs?.length ?? sources.length * targets.length) > 256) {
    throw new Error("批量音频对齐一次最多分析 256 个素材组合。");
  }
  return {
    ...request,
    schemaVersion: 2,
    sources,
    targets,
    ...(pairs ? { pairs } : {}),
    versionReuseGroups,
    ffprobePath: request.ffprobePath ?? null,
    spectralBackend: normalizeTauriSpectralBackendPreference(request.spectralBackend),
    localizationMode: true
  };
}

function normalizeVersionReuseGroups(
  groups: readonly AudioAlignmentBatchVersionReuseGroup[],
  sourceMediaIds: readonly string[],
  targetMediaIds: readonly string[]
): AudioAlignmentBatchVersionReuseGroup[] {
  const sourceOrder = new Map(sourceMediaIds.map((mediaId, index) => [mediaId, index]));
  const targetOrder = new Map(targetMediaIds.map((mediaId, index) => [mediaId, index]));
  const seenGroupIds = new Set<string>();
  const groupedMedia = new Set<string>();
  const normalized = groups.map((group) => {
    const groupId = group.groupId.trim();
    if (
      !/^[A-Za-z0-9._:-]+$/.test(groupId) ||
      new TextEncoder().encode(groupId).byteLength > 160
    ) {
      throw new Error("多版本组标识必须是最多 160 bytes 的字母数字/._:-。");
    }
    if (seenGroupIds.has(groupId)) {
      throw new Error(`多版本组标识不能重复：${groupId}`);
    }
    seenGroupIds.add(groupId);
    if (group.side !== "source" && group.side !== "target") {
      throw new Error(`多版本组 ${groupId} 的 side 无效。`);
    }
    if (!Array.isArray(group.mediaIds) || group.mediaIds.length < 2) {
      throw new Error(`多版本组 ${groupId} 至少需要两个不同媒体。`);
    }
    const order = group.side === "source" ? sourceOrder : targetOrder;
    const seenMembers = new Set<string>();
    const mediaIds = group.mediaIds.map((value) => value.trim());
    for (const mediaId of mediaIds) {
      if (!order.has(mediaId)) {
        throw new Error(`多版本组 ${groupId} 引用了错误侧或不存在的媒体：${mediaId}`);
      }
      if (seenMembers.has(mediaId)) {
        throw new Error(`多版本组 ${groupId} 包含重复媒体：${mediaId}`);
      }
      seenMembers.add(mediaId);
      const membershipKey = `${group.side}\u0000${mediaId}`;
      if (groupedMedia.has(membershipKey)) {
        throw new Error(`媒体 ${mediaId} 不能同时属于同一侧的多个多版本组。`);
      }
      groupedMedia.add(membershipKey);
    }
    mediaIds.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    return { groupId, side: group.side, mediaIds };
  });
  return normalized.sort(
    (left, right) =>
      (left.side === "source" ? 0 : 1) - (right.side === "source" ? 0 : 1) ||
      left.groupId.localeCompare(right.groupId)
  );
}

export function normalizeTauriSpectralBackendPreference(
  value: unknown
): SpectralBackendPreference {
  if (value === undefined) {
    return "auto";
  }
  if (!isSpectralBackendPreference(value)) {
    throw new Error("声谱计算策略仅支持 auto、cuda 或 cpu。");
  }
  return value;
}

function normalizeBatchPairs(
  pairs: readonly TauriAudioAlignmentBatchPair[],
  sourceIds: ReadonlySet<string>,
  targetIds: ReadonlySet<string>
): TauriAudioAlignmentBatchPair[] {
  if (pairs.length === 0) {
    throw new Error("批量音频对齐的显式素材组合不能为空。");
  }
  const seen = new Set<string>();
  return pairs.map((pair, index) => {
    const sourceMediaId = pair.sourceMediaId.trim();
    const targetMediaId = pair.targetMediaId.trim();
    if (!sourceIds.has(sourceMediaId) || !targetIds.has(targetMediaId)) {
      throw new Error(`第 ${index + 1} 个素材组合引用了未纳入批次的媒体。`);
    }
    const key = `${sourceMediaId}\u0000${targetMediaId}`;
    if (seen.has(key)) {
      throw new Error(`批量音频对齐包含重复素材组合：${sourceMediaId} → ${targetMediaId}`);
    }
    seen.add(key);
    return { sourceMediaId, targetMediaId };
  });
}

function normalizeBatchMedia(
  media: readonly TauriAudioAlignmentBatchMedia[],
  label: string
): Required<TauriAudioAlignmentBatchMedia>[] {
  if (media.length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  if (media.length > 256) {
    throw new Error(`${label}一次最多选择 256 个。`);
  }
  const ids = new Set<string>();
  return media.map((item, index) => {
    const mediaId = item.mediaId.trim();
    if (!mediaId) {
      throw new Error(`${label}第 ${index + 1} 项的媒体 ID 不能为空。`);
    }
    if (
      new TextEncoder().encode(mediaId).byteLength > 512 ||
      containsInvalidMediaIdCharacter(mediaId)
    ) {
      throw new Error(
        `${label}第 ${index + 1} 项的媒体 ID 必须是最多 512 UTF-8 bytes 的无路径标识。`
      );
    }
    if (ids.has(mediaId)) {
      throw new Error(`${label}包含重复媒体 ID：${mediaId}`);
    }
    ids.add(mediaId);
    if (!item.path.trim()) {
      throw new Error(`${label}第 ${index + 1} 项缺少本地路径。`);
    }
    return {
      mediaId,
      path: item.path,
      audioStreamIndex: normalizeStreamIndex(item.audioStreamIndex, `${label}音轨索引`),
      videoStreamIndex: normalizeStreamIndex(item.videoStreamIndex, `${label}视频流索引`)
    };
  });
}

function validateStartedAudioAlignmentBatchSnapshot(
  snapshot: AudioAlignmentBatchJobSnapshot,
  request: NormalizedTauriAudioAlignmentBatchRequest
): void {
  const expectedPairingMode = request.pairs === undefined ? "fullCartesian" : "explicit";
  const expectedSourceIds = request.sources.map((media) => media.mediaId);
  const expectedTargetIds = request.targets.map((media) => media.mediaId);
  if (
    snapshot.pairingMode !== expectedPairingMode ||
    !sameOrderedStrings(snapshot.sourceMediaIds, expectedSourceIds) ||
    !sameOrderedStrings(snapshot.targetMediaIds, expectedTargetIds) ||
    !sameVersionReuseGroups(
      snapshot.versionReuseGroups,
      request.versionReuseGroups.map((group, index) => ({
        ...group,
        groupOrdinal: index + 1
      }))
    )
  ) {
    throw new Error(
      "原生批任务启动响应未绑定本次请求的 fullCartesian pairingMode 或媒体 inventory。"
    );
  }
  const expectedPairs =
    request.pairs ??
    request.sources.flatMap((source) =>
      request.targets.map((target) => ({
        sourceMediaId: source.mediaId,
        targetMediaId: target.mediaId
      }))
    );
  if (
    snapshot.pairs.length !== expectedPairs.length ||
    snapshot.pairs.some(
      (pair, index) =>
        pair.sourceMediaId !== expectedPairs[index]?.sourceMediaId ||
        pair.targetMediaId !== expectedPairs[index]?.targetMediaId
    )
  ) {
    throw new Error("原生批任务启动响应未绑定本次请求的完整 pair inventory。");
  }
}

function sameVersionReuseGroups(
  left: readonly AudioAlignmentBatchVersionReuseGroupSnapshot[],
  right: readonly AudioAlignmentBatchVersionReuseGroupSnapshot[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (group, index) =>
        group.groupOrdinal === right[index]?.groupOrdinal &&
        group.groupId === right[index]?.groupId &&
        group.side === right[index]?.side &&
        sameOrderedStrings(group.mediaIds, right[index]?.mediaIds ?? [])
    )
  );
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createAudioAlignmentBatchProposalTimeMapDigest(
  timeMap: unknown
): `sha256:${string}` {
  return createAudioAlignmentBatchV3Digest(
    AUDIO_ALIGNMENT_BATCH_FINE_TIME_MAP_DIGEST_DOMAIN,
    timeMap
  );
}

export function createAudioAlignmentBatchFineParametersHash(
  engineVersion: string,
  featureVersion: string,
  legacyParametersHash: string
): `sha256:${string}` {
  return createAudioAlignmentBatchV3Digest(
    AUDIO_ALIGNMENT_BATCH_FINE_PARAMETERS_DIGEST_DOMAIN,
    {
      engineVersion,
      featureVersion,
      fineScoreVersion: AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
      legacyParametersHash
    }
  );
}

export function createAudioAlignmentBatchFineExecutionEvidenceDigest(
  evidence: AudioAlignmentBatchFineExecutionEvidenceSnapshot
): `sha256:${string}` {
  return createAudioAlignmentBatchV3Digest(AUDIO_ALIGNMENT_BATCH_FINE_EXECUTION_DIGEST_DOMAIN, {
    ...evidence,
    evidenceDigest: ""
  });
}

export function createAudioAlignmentBatchFineFrontierReceiptDigest(
  receipt: AudioAlignmentBatchFineFrontierReceiptSnapshot
): `sha256:${string}` {
  return createAudioAlignmentBatchV3Digest(AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_DIGEST_DOMAIN, {
    ...receipt,
    receiptDigest: ""
  });
}

export function createAudioAlignmentBatchFineInventoryDigest(
  candidates: readonly AudioAlignmentBatchFineInventoryCandidateSnapshot[]
): `sha256:${string}` {
  return createAudioAlignmentBatchV3Digest(
    AUDIO_ALIGNMENT_BATCH_FINE_INVENTORY_DIGEST_DOMAIN,
    candidates
  );
}

function createAudioAlignmentBatchV3Digest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(`${domain}\n${canonicalRuntimeJson(value)}`)}`;
}

const AUDIO_ALIGNMENT_JOB_STATUSES = new Set<AudioAlignmentJobStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

const AUDIO_ALIGNMENT_MAX_JOB_LOGS = 80;

function validateAudioAlignmentJobSnapshot(
  value: unknown,
  expectedJobId?: string
): AudioAlignmentJobSnapshot {
  if (!isRecord(value)) {
    throw new Error("原生单任务返回了不支持的响应结构。");
  }
  requireRuntimeExactKeys(
    value,
    [
      "jobId",
      "status",
      "progress",
      "message",
      "stageKey",
      "stageLabel",
      "stageIndex",
      "stageCount",
      "stageProgress",
      "logs",
      "proposal",
      "error",
      "updatedAtMs"
    ],
    "原生单任务响应"
  );
  const jobId = requireRuntimeText(value.jobId, "单任务 jobId");
  if (expectedJobId !== undefined && jobId !== expectedJobId) {
    throw new Error("原生单任务响应的 jobId 与请求不一致。");
  }
  const status = requireRuntimeJobStatus(value.status, "单任务状态");
  requireRuntimeProgress(value.progress, "单任务进度");
  requireRuntimeText(value.message, "单任务消息");
  const stageKey = requireRuntimeEnum(value.stageKey, AUDIO_ALIGNMENT_STAGE_KEYS, "单任务阶段");
  const stageLabel = requireRuntimeText(value.stageLabel, "单任务阶段标签");
  const stageIndex = requireRuntimeInteger(
    value.stageIndex,
    "单任务阶段索引",
    0,
    AUDIO_ALIGNMENT_STAGE_COUNT
  );
  const stageCount = requireRuntimeInteger(
    value.stageCount,
    "单任务阶段总数",
    AUDIO_ALIGNMENT_STAGE_COUNT,
    AUDIO_ALIGNMENT_STAGE_COUNT
  );
  requireRuntimeProgress(value.stageProgress, "单任务阶段进度");
  if (stageIndex > stageCount) {
    throw new Error("原生单任务响应的阶段索引超出阶段总数。");
  }
  validateAudioAlignmentJobStage(status, stageKey, stageLabel, stageIndex);
  if (!Array.isArray(value.logs) || value.logs.length > AUDIO_ALIGNMENT_MAX_JOB_LOGS) {
    throw new Error(`单任务日志必须是至多 ${AUDIO_ALIGNMENT_MAX_JOB_LOGS} 条的数组。`);
  }
  value.logs.forEach((line, index) => requireRuntimeText(line, `单任务日志[${index}]`));
  validateAudioAlignmentJobTerminalPayload(status, value.proposal, value.error);
  requireRuntimeInteger(value.updatedAtMs, "单任务更新时间", 0, Number.MAX_SAFE_INTEGER);
  return value as unknown as AudioAlignmentJobSnapshot;
}

function validateAudioAlignmentJobStage(
  status: AudioAlignmentJobStatus,
  stageKey: AudioAlignmentStageKey,
  stageLabel: string,
  stageIndex: number
): void {
  const expected = AUDIO_ALIGNMENT_STAGE_CONTRACT[stageKey];
  if (
    expected.status !== status ||
    expected.label !== stageLabel ||
    expected.index !== stageIndex
  ) {
    throw new Error("原生单任务响应的状态与阶段 key/index/label 不一致。");
  }
}

function validateAudioAlignmentJobTerminalPayload(
  status: AudioAlignmentJobStatus,
  proposal: unknown,
  error: unknown
): void {
  if (status === "completed") {
    if (!isAlignmentProposal(proposal) || error !== null) {
      throw new Error("已完成单任务必须包含 proposal 且不能包含 error。");
    }
    return;
  }
  if (proposal !== null) {
    throw new Error("未完成单任务不能包含 proposal。");
  }
  if (status === "failed") {
    requireRuntimeText(error, "失败单任务 error");
    return;
  }
  if (error !== null) {
    if (status !== "cancelled") {
      throw new Error("排队或运行中的单任务不能包含 error。");
    }
    requireRuntimeText(error, "已取消单任务 error");
  }
}

function validateAudioAlignmentBatchJobSnapshot(
  value: unknown,
  expectedJobId?: string
): AudioAlignmentBatchJobSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 2) {
    throw new Error("原生批任务返回了不支持的响应结构或 schemaVersion。");
  }
  requireRuntimeExactKeys(
    value,
    [
      "schemaVersion",
      "evidenceVersion",
      "jobId",
      "pairingMode",
      "sourceMediaIds",
      "targetMediaIds",
      "versionReuseGroups",
      "status",
      "progress",
      "message",
      "totalPairCount",
      "processedPairCount",
      "failedPairCount",
      "currentPairOrdinal",
      "diagnosticEvents",
      "pairs",
      "error",
      "updatedAtMs"
    ],
    "原生批任务响应"
  );
  if (value.evidenceVersion !== 5) {
    throw new Error("原生批任务返回了不支持的 evidenceVersion。");
  }
  const jobId = requireRuntimeText(value.jobId, "批任务 jobId");
  if (expectedJobId !== undefined && jobId !== expectedJobId) {
    throw new Error("原生批任务响应的 jobId 与请求不一致。");
  }
  const pairingMode = requireRuntimeEnum(
    value.pairingMode,
    ["fullCartesian", "explicit"] as const,
    "批任务 pairingMode"
  );
  const sourceMediaIds = requireRuntimeIdArray(
    value.sourceMediaIds,
    "批任务来源媒体 inventory"
  );
  const targetMediaIds = requireRuntimeIdArray(
    value.targetMediaIds,
    "批任务目标媒体 inventory"
  );
  if (sourceMediaIds.some((mediaId) => targetMediaIds.includes(mediaId))) {
    throw new Error("原生批任务响应的两侧媒体 inventory 必须全局唯一。");
  }
  const versionReuseGroups = validateVersionReuseGroupSnapshots(
    value.versionReuseGroups,
    sourceMediaIds,
    targetMediaIds,
    "批任务多版本复用组"
  );
  const status = requireRuntimeJobStatus(value.status, "批任务状态");
  requireRuntimeProgress(value.progress, "批任务进度");
  requireRuntimeText(value.message, "批任务消息");
  const totalPairCount = requireRuntimeInteger(
    value.totalPairCount,
    "批任务 pair 总数",
    1,
    256
  );
  const processedPairCount = requireRuntimeInteger(
    value.processedPairCount,
    "批任务已处理 pair 数",
    0,
    totalPairCount
  );
  const failedPairCount = requireRuntimeInteger(
    value.failedPairCount,
    "批任务失败 pair 数",
    0,
    totalPairCount
  );
  if (!Array.isArray(value.pairs) || value.pairs.length !== totalPairCount) {
    throw new Error("原生批任务响应的 pairs 数量与 totalPairCount 不一致。");
  }
  const cartesianPairCount = sourceMediaIds.length * targetMediaIds.length;
  if (
    totalPairCount > cartesianPairCount ||
    (pairingMode === "fullCartesian" && totalPairCount !== cartesianPairCount)
  ) {
    throw new Error("原生批任务响应的 pair 数量与 pairingMode/inventory 不一致。");
  }
  const pairOrdinals = new Set<number>();
  const pairKeys = new Set<string>();
  const pairs = value.pairs.map((pair, index) =>
    validateAudioAlignmentBatchPairSnapshot(
      pair,
      index,
      totalPairCount,
      pairOrdinals,
      pairKeys,
      new Set(sourceMediaIds),
      new Set(targetMediaIds)
    )
  );
  validatePairVersionReuseOrdinals(pairs, versionReuseGroups, pairingMode, targetMediaIds);
  validateAudioAlignmentBatchFineComponentCoherence(pairs);
  if (pairingMode === "fullCartesian") {
    pairs.forEach((pair, index) => {
      const sourceIndex = Math.floor(index / targetMediaIds.length);
      const targetIndex = index % targetMediaIds.length;
      if (
        pair.sourceMediaId !== sourceMediaIds[sourceIndex] ||
        pair.targetMediaId !== targetMediaIds[targetIndex]
      ) {
        throw new Error("原生 fullCartesian 批任务响应未按 source-major 完整顺序返回 pair。");
      }
    });
  }
  const actualProcessed = pairs.filter(
    (pair) => pair.status === "completed" || pair.status === "failed"
  ).length;
  const actualFailed = pairs.filter((pair) => pair.status === "failed").length;
  if (processedPairCount !== actualProcessed || failedPairCount !== actualFailed) {
    throw new Error("原生批任务响应的 processed/failed 计数与 pair 状态不一致。");
  }
  const currentPairOrdinal = value.currentPairOrdinal;
  if (currentPairOrdinal !== null) {
    if (
      typeof currentPairOrdinal !== "number" ||
      !Number.isSafeInteger(currentPairOrdinal) ||
      currentPairOrdinal < 1 ||
      currentPairOrdinal > totalPairCount
    ) {
      throw new Error("原生批任务响应的 currentPairOrdinal 无效。");
    }
  }
  const diagnosticEvents = validateAudioAlignmentBatchDiagnosticEvents(
    value.diagnosticEvents,
    totalPairCount
  );
  if (
    diagnosticEvents.some(
      (event) => event.pairOrdinal !== null && !pairOrdinals.has(event.pairOrdinal)
    )
  ) {
    throw new Error("原生批任务诊断日志引用了不存在的 pair。");
  }
  if (isAudioAlignmentJobFinished(status)) {
    if (
      currentPairOrdinal !== null ||
      pairs.some((pair) => !isAudioAlignmentJobFinished(pair.status))
    ) {
      throw new Error("原生批任务已结束，但仍包含运行中的 pair 或 currentPairOrdinal。");
    }
  }
  if (value.error !== null && typeof value.error !== "string") {
    throw new Error("原生批任务响应的 error 必须是字符串或 null。");
  }
  if (
    status === "completed" &&
    (value.error !== null ||
      processedPairCount !== totalPairCount ||
      pairs.some((pair) => pair.status !== "completed" && pair.status !== "failed"))
  ) {
    throw new Error("原生批任务标记 completed 时全部 pair 必须处理完毕且 error 为空。");
  }
  requireRuntimeInteger(value.updatedAtMs, "批任务更新时间", 0, Number.MAX_SAFE_INTEGER);
  return value as unknown as AudioAlignmentBatchJobSnapshot;
}

function validateAudioAlignmentBatchDiagnosticEvents(
  value: unknown,
  totalPairCount: number
): AudioAlignmentBatchDiagnosticEvent[] {
  if (!Array.isArray(value) || value.length > 512) {
    throw new Error("原生批任务诊断日志必须是至多 512 条事件的数组。");
  }
  let previousSequence = 0;
  let previousElapsedMs = 0;
  return value.map((event, index) => {
    if (!isRecord(event)) {
      throw new Error(`第 ${index + 1} 条批任务诊断日志不是对象。`);
    }
    requireRuntimeExactKeys(
      event,
      [
        "sequence",
        "atMs",
        "elapsedMs",
        "level",
        "stageKey",
        "mediaOrdinal",
        "pairOrdinal",
        "message",
        "durationMs"
      ],
      `第 ${index + 1} 条批任务诊断日志`
    );
    const sequence = requireRuntimeInteger(
      event.sequence,
      `第 ${index + 1} 条诊断日志序号`,
      1,
      Number.MAX_SAFE_INTEGER
    );
    if (sequence <= previousSequence) {
      throw new Error("原生批任务诊断日志序号必须严格递增。");
    }
    previousSequence = sequence;
    requireRuntimeInteger(
      event.atMs,
      `第 ${index + 1} 条诊断日志时间`,
      0,
      Number.MAX_SAFE_INTEGER
    );
    const elapsedMs = requireRuntimeInteger(
      event.elapsedMs,
      `第 ${index + 1} 条诊断日志累计耗时`,
      0,
      Number.MAX_SAFE_INTEGER
    );
    if (elapsedMs < previousElapsedMs) {
      throw new Error("原生批任务诊断日志累计耗时不能倒退。");
    }
    previousElapsedMs = elapsedMs;
    requireRuntimeEnum(
      event.level,
      ["info", "warning", "error"] as const,
      `第 ${index + 1} 条诊断日志级别`
    );
    requireRuntimeText(event.stageKey, `第 ${index + 1} 条诊断日志阶段`);
    requireRuntimeText(event.message, `第 ${index + 1} 条诊断日志消息`);
    for (const [field, maximum] of [
      ["mediaOrdinal", Number.MAX_SAFE_INTEGER],
      ["pairOrdinal", totalPairCount]
    ] as const) {
      const fieldValue = event[field];
      if (fieldValue !== null) {
        requireRuntimeInteger(fieldValue, `第 ${index + 1} 条诊断日志 ${field}`, 1, maximum);
      }
    }
    if (event.durationMs !== null) {
      requireRuntimeInteger(
        event.durationMs,
        `第 ${index + 1} 条诊断日志阶段耗时`,
        0,
        Number.MAX_SAFE_INTEGER
      );
    }
    return event as unknown as AudioAlignmentBatchDiagnosticEvent;
  });
}

function validatePairVersionReuseOrdinals(
  pairs: readonly AudioAlignmentBatchPairSnapshot[],
  groups: readonly AudioAlignmentBatchVersionReuseGroupSnapshot[],
  pairingMode: AudioAlignmentBatchPairingMode,
  targetMediaIds: readonly string[]
): void {
  const automaticTargetAxisGroups = new Map<string, number>();
  if (pairingMode === "explicit") {
    const sourcesByTarget = new Map<string, Set<string>>();
    for (const pair of pairs) {
      const sources = sourcesByTarget.get(pair.targetMediaId) ?? new Set<string>();
      sources.add(pair.sourceMediaId);
      sourcesByTarget.set(pair.targetMediaId, sources);
    }
    let nextGroupOrdinal =
      groups.reduce((maximum, group) => Math.max(maximum, group.groupOrdinal), 0) + 1;
    for (const targetMediaId of targetMediaIds) {
      if ((sourcesByTarget.get(targetMediaId)?.size ?? 0) < 2) continue;
      automaticTargetAxisGroups.set(targetMediaId, nextGroupOrdinal);
      nextGroupOrdinal += 1;
    }
  }
  for (const pair of pairs) {
    const sourceAxisReuseGroupOrdinal =
      groups.find(
        (group) => group.side === "target" && group.mediaIds.includes(pair.targetMediaId)
      )?.groupOrdinal ?? null;
    const targetAxisReuseGroupOrdinal =
      automaticTargetAxisGroups.get(pair.targetMediaId) ??
      groups.find(
        (group) => group.side === "source" && group.mediaIds.includes(pair.sourceMediaId)
      )?.groupOrdinal ??
      null;
    for (const candidate of pair.fineFrontier?.inventoryCandidates ?? []) {
      if (candidate.id.pairOrdinal !== pair.pairOrdinal) continue;
      if (
        candidate.sourceAxisReuseGroupOrdinal !== sourceAxisReuseGroupOrdinal ||
        candidate.targetAxisReuseGroupOrdinal !== targetAxisReuseGroupOrdinal
      ) {
        throw new Error(
          `第 ${pair.pairOrdinal} 个 pair 的 fine inventory 多版本复用组 ordinal 未绑定批次策略。`
        );
      }
    }
  }
}

function validateAudioAlignmentBatchPairSnapshot(
  value: unknown,
  index: number,
  totalPairCount: number,
  pairOrdinals: Set<number>,
  pairKeys: Set<string>,
  sourceMediaIds: ReadonlySet<string>,
  targetMediaIds: ReadonlySet<string>
): AudioAlignmentBatchPairSnapshot {
  if (!isRecord(value)) {
    throw new Error(`原生批任务第 ${index + 1} 个 pair 响应不是对象。`);
  }
  requireRuntimeExactKeys(
    value,
    [
      "pairIndex",
      "pairOrdinal",
      "sourceMediaId",
      "targetMediaId",
      "status",
      "progress",
      "message",
      "relationRanking",
      "globalSelection",
      "fineFrontier",
      "fineExecutionEvidence",
      "proposal",
      "error"
    ],
    `原生批任务第 ${index + 1} 个 pair 响应`
  );
  const pairIndex = requireRuntimeInteger(
    value.pairIndex,
    `第 ${index + 1} 个 pair 索引`,
    0,
    totalPairCount - 1
  );
  const pairOrdinal = requireRuntimeInteger(
    value.pairOrdinal,
    `第 ${index + 1} 个 pair 序号`,
    1,
    totalPairCount
  );
  if (pairIndex !== index || pairOrdinal !== index + 1 || pairOrdinals.has(pairOrdinal)) {
    throw new Error("原生批任务响应的 pairIndex/pairOrdinal 不是连续 canonical 顺序。");
  }
  pairOrdinals.add(pairOrdinal);
  const sourceMediaId = requireRuntimeText(
    value.sourceMediaId,
    `第 ${index + 1} 个 pair 来源媒体 ID`
  );
  const targetMediaId = requireRuntimeText(
    value.targetMediaId,
    `第 ${index + 1} 个 pair 目标媒体 ID`
  );
  if (!sourceMediaIds.has(sourceMediaId) || !targetMediaIds.has(targetMediaId)) {
    throw new Error("原生批任务 pair 引用了 inventory 外的媒体 ID。");
  }
  const pairKey = `${sourceMediaId}\u0000${targetMediaId}`;
  if (pairKeys.has(pairKey)) {
    throw new Error("原生批任务响应包含重复媒体 pair。");
  }
  pairKeys.add(pairKey);
  const status = requireRuntimeJobStatus(value.status, `第 ${index + 1} 个 pair 状态`);
  requireRuntimeProgress(value.progress, `第 ${index + 1} 个 pair 进度`);
  requireRuntimeText(value.message, `第 ${index + 1} 个 pair 消息`);
  const relationRanking = validateAudioAlignmentBatchRelationRanking(
    value.relationRanking,
    `第 ${index + 1} 个 pair relationRanking`
  );
  const globalSelection = validateAudioAlignmentBatchGlobalSelection(
    value.globalSelection,
    `第 ${index + 1} 个 pair globalSelection`
  );
  const fineFrontier =
    value.fineFrontier === null
      ? null
      : validateAudioAlignmentBatchFineFrontier(
          value.fineFrontier,
          `第 ${index + 1} 个 pair fineFrontier`,
          totalPairCount
        );
  const fineExecutionEvidence =
    value.fineExecutionEvidence === null
      ? null
      : validateAudioAlignmentBatchFineExecutionEvidence(
          value.fineExecutionEvidence,
          `第 ${index + 1} 个 pair fineExecutionEvidence`,
          pairOrdinal
        );
  validateAudioAlignmentBatchFinePairBinding(
    value,
    status,
    pairOrdinal,
    relationRanking,
    fineFrontier,
    fineExecutionEvidence,
    `第 ${index + 1} 个 pair`
  );
  if (status === "completed") {
    if (!isRecord(value.proposal) || value.error !== null) {
      throw new Error("已完成 pair 必须包含 proposal 且不能包含 error。");
    }
    if (
      globalSelection.state !== "selected" &&
      globalSelection.state !== "blocked" &&
      globalSelection.state !== "failed"
    ) {
      throw new Error("已完成 pair 必须发布 terminal coarse 诊断证据。");
    }
    if (relationRanking.state !== "ranked" && relationRanking.state !== "noEligibleCandidate") {
      throw new Error("已完成 pair 必须发布 ranked 或 noEligibleCandidate 的关系排名证据。");
    }
  } else if (status === "failed") {
    if (value.proposal !== null || typeof value.error !== "string" || !value.error.trim()) {
      throw new Error("失败 pair 必须包含 error 且不能包含 proposal。");
    }
    if (globalSelection.state !== "failed") {
      throw new Error("失败 pair 必须发布 failed 的全局选择证据。");
    }
    if (
      relationRanking.state !== "failed" &&
      relationRanking.state !== "ranked" &&
      relationRanking.state !== "noEligibleCandidate"
    ) {
      throw new Error("失败 pair 必须发布已冻结的 coarse 关系排名或 failed 证据。");
    }
  } else if (value.proposal !== null || value.error !== null) {
    throw new Error("未完成或已取消 pair 不能包含 proposal/error。");
  }
  if (
    ((status === "queued" || status === "running") && globalSelection.state !== "pending") ||
    (status === "cancelled" && globalSelection.state !== "cancelled")
  ) {
    throw new Error("原生批任务 pair 状态与全局选择证据状态不一致。");
  }
  if (
    ((status === "queued" || status === "running") && relationRanking.state !== "pending") ||
    (status === "cancelled" && relationRanking.state !== "cancelled")
  ) {
    throw new Error("原生批任务 pair 状态与关系排名证据状态不一致。");
  }
  return value as unknown as AudioAlignmentBatchPairSnapshot;
}

const AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_STATES = [
  "resolved",
  "noEligibleCandidate",
  "unresolved",
  "failed"
] as const;

const AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_DIGEST_DOMAIN =
  "audio-alignment-v5/fine-frontier-receipt/v3";
const AUDIO_ALIGNMENT_BATCH_FINE_INVENTORY_DIGEST_DOMAIN =
  "audio-alignment-v5/fine-frontier-inventory/v3";
const AUDIO_ALIGNMENT_BATCH_FINE_EXECUTION_DIGEST_DOMAIN =
  "audio-alignment-v5/fine-execution-evidence/v2";
const AUDIO_ALIGNMENT_BATCH_FINE_TIME_MAP_DIGEST_DOMAIN =
  "audio-alignment-v5/proposal-time-map/v1";
const AUDIO_ALIGNMENT_BATCH_FINE_PARAMETERS_DIGEST_DOMAIN =
  "audio-alignment-v5/fine-parameters/v1";
const AUDIO_ALIGNMENT_BATCH_FINE_SAMPLE_RATE = 16_000;
const AUDIO_ALIGNMENT_BATCH_FINE_SCORE_MICROS_ONE = 1_000_000;
const AUDIO_ALIGNMENT_BATCH_FINE_WINDOW_DECODE_TOLERANCE_MS = 50;

function validateAudioAlignmentBatchFineFrontier(
  value: unknown,
  label: string,
  totalPairCount: number
): AudioAlignmentBatchFineFrontierReceiptSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "contractVersion",
      "scoreVersion",
      "inventoryDigest",
      "inventoryCandidates",
      "receiptDigest",
      "componentOrdinal",
      "componentPairOrdinals",
      "inventoryCandidateCount",
      "resolutionMarginMicros",
      "overlapToleranceMs",
      "limits",
      "inventoryStateCounts",
      "refinementRoundCount",
      "evaluatedCandidateCount",
      "finalState",
      "resolved",
      "selectedCandidateIds",
      "selectedTotalScoreMicros",
      "bestCompleted",
      "runnerUpCompleted",
      "optimisticOmitted",
      "nextRefinementCandidateIds",
      "deferredCandidateCount",
      "proof",
      "search"
    ],
    label
  );
  if (value.contractVersion !== AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION) {
    throw new Error(`${label}.contractVersion 无效。`);
  }
  if (value.scoreVersion !== AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION) {
    throw new Error(`${label}.scoreVersion 无效。`);
  }
  const inventoryDigest = requireRuntimeSha256(
    value.inventoryDigest,
    `${label}.inventoryDigest`
  );
  const receiptDigest = requireRuntimeSha256(value.receiptDigest, `${label}.receiptDigest`);
  requireRuntimeInteger(value.componentOrdinal, `${label}.componentOrdinal`, 1, totalPairCount);
  const componentPairOrdinals = requireRuntimeIntegerArray(
    value.componentPairOrdinals,
    `${label}.componentPairOrdinals`,
    1,
    totalPairCount,
    true
  );
  if (componentPairOrdinals.length === 0) {
    throw new Error(`${label}.componentPairOrdinals 不能为空。`);
  }
  const inventoryCandidateCount = requireRuntimeInteger(
    value.inventoryCandidateCount,
    `${label}.inventoryCandidateCount`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const inventoryCandidates = validateAudioAlignmentBatchFineInventoryCandidates(
    value.inventoryCandidates,
    `${label}.inventoryCandidates`,
    componentPairOrdinals
  );
  if (inventoryCandidates.length !== inventoryCandidateCount) {
    throw new Error(`${label}.inventoryCandidates 未完整枚举 inventoryCandidateCount。`);
  }
  if (createAudioAlignmentBatchFineInventoryDigest(inventoryCandidates) !== inventoryDigest) {
    throw new Error(`${label}.inventoryDigest 与完整候选清单不一致。`);
  }
  requireRuntimeInteger(
    value.resolutionMarginMicros,
    `${label}.resolutionMarginMicros`,
    1,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.overlapToleranceMs,
    `${label}.overlapToleranceMs`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const limits = validateAudioAlignmentBatchFineLimits(value.limits, `${label}.limits`);
  if (inventoryCandidateCount > limits.maxCandidates) {
    throw new Error(`${label}.inventoryCandidateCount 超过声明的 maxCandidates。`);
  }
  const stateCounts = validateAudioAlignmentBatchFineStateCounts(
    value.inventoryStateCounts,
    `${label}.inventoryStateCounts`
  );
  if (
    stateCounts.unresolved +
      stateCounts.scored +
      stateCounts.evaluatedIneligible +
      stateCounts.evidenceBlocked +
      stateCounts.resourceBlocked +
      stateCounts.infrastructureFailed +
      stateCounts.cancelled !==
    inventoryCandidateCount
  ) {
    throw new Error(`${label}.inventoryStateCounts 未完整划分候选库存。`);
  }
  requireRuntimeInteger(
    value.refinementRoundCount,
    `${label}.refinementRoundCount`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.evaluatedCandidateCount,
    `${label}.evaluatedCandidateCount`,
    0,
    inventoryCandidateCount
  );
  const finalState = requireRuntimeEnum(
    value.finalState,
    AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_STATES,
    `${label}.finalState`
  );
  if (typeof value.resolved !== "boolean" || value.resolved !== (finalState === "resolved")) {
    throw new Error(`${label}.resolved 与 finalState 不一致。`);
  }
  const selectedCandidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.selectedCandidateIds,
    `${label}.selectedCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const selectedTotalScoreMicros =
    value.selectedTotalScoreMicros === null
      ? null
      : requireRuntimeInteger(
          value.selectedTotalScoreMicros,
          `${label}.selectedTotalScoreMicros`,
          0,
          Number.MAX_SAFE_INTEGER
        );
  const bestCompleted = validateAudioAlignmentBatchFineAssignment(
    value.bestCompleted,
    `${label}.bestCompleted`,
    componentPairOrdinals
  );
  const runnerUpCompleted =
    value.runnerUpCompleted === null
      ? null
      : validateAudioAlignmentBatchFineAssignment(
          value.runnerUpCompleted,
          `${label}.runnerUpCompleted`,
          componentPairOrdinals
        );
  if (
    runnerUpCompleted !== null &&
    runnerUpCompleted.totalScoreMicros > bestCompleted.totalScoreMicros
  ) {
    throw new Error(`${label}.runnerUpCompleted 分数不能超过 bestCompleted。`);
  }
  const optimisticOmitted =
    value.optimisticOmitted === null
      ? null
      : validateAudioAlignmentBatchFineOmittedAssignment(
          value.optimisticOmitted,
          `${label}.optimisticOmitted`,
          componentPairOrdinals
        );
  const nextRefinementCandidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.nextRefinementCandidateIds,
    `${label}.nextRefinementCandidateIds`,
    componentPairOrdinals,
    false,
    false
  );
  const deferredCandidateCount = requireRuntimeInteger(
    value.deferredCandidateCount,
    `${label}.deferredCandidateCount`,
    0,
    inventoryCandidateCount
  );
  const proof = validateAudioAlignmentBatchFineProof(value.proof, `${label}.proof`);
  validateAudioAlignmentBatchFineSearch(value.search, `${label}.search`, limits);

  if (finalState === "resolved") {
    if (
      selectedCandidateIds.length === 0 ||
      !sameFineCandidateIds(selectedCandidateIds, bestCompleted.candidateIds) ||
      selectedTotalScoreMicros !== bestCompleted.totalScoreMicros ||
      !proof.beatsRunnerUpWithMargin ||
      !proof.beatsOptimisticOmittedWithMargin ||
      nextRefinementCandidateIds.length !== 0 ||
      deferredCandidateCount !== 0
    ) {
      throw new Error(`${label} resolved 终态的选择、分数或 proof 不闭合。`);
    }
  } else if (selectedCandidateIds.length !== 0 || selectedTotalScoreMicros !== null) {
    throw new Error(`${label} 非 resolved 终态不能发布最终选择。`);
  }
  if (
    finalState === "noEligibleCandidate" &&
    (bestCompleted.candidateIds.length !== 0 ||
      bestCompleted.totalScoreMicros !== 0 ||
      runnerUpCompleted !== null ||
      optimisticOmitted !== null ||
      nextRefinementCandidateIds.length !== 0 ||
      stateCounts.scored !== 0)
  ) {
    throw new Error(`${label} noEligibleCandidate 终态夹带了已完成或待评估候选。`);
  }
  if (
    createAudioAlignmentBatchFineFrontierReceiptDigest(
      value as unknown as AudioAlignmentBatchFineFrontierReceiptSnapshot
    ) !== receiptDigest
  ) {
    throw new Error(`${label}.receiptDigest 与 canonical receipt 不一致。`);
  }
  return value as unknown as AudioAlignmentBatchFineFrontierReceiptSnapshot;
}

function validateAudioAlignmentBatchFineExecutionEvidence(
  value: unknown,
  label: string,
  pairOrdinal: number
): AudioAlignmentBatchFineExecutionEvidenceSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "candidateId",
      "selectedMemberRank",
      "groupMemberRanks",
      "sourceStreamIndex",
      "targetStreamIndex",
      "sourceCoarseBackend",
      "targetCoarseBackend",
      "sourceFineBackend",
      "targetFineBackend",
      "sourceRequestedWindow",
      "targetRequestedWindow",
      "sourceEffectiveWindow",
      "targetEffectiveWindow",
      "parametersHash",
      "occupancyDigest",
      "proposalTimeMapDigest",
      "scoreMicros",
      "evidenceDigest"
    ],
    label
  );
  const candidateId = validateAudioAlignmentBatchFineCandidateId(
    value.candidateId,
    `${label}.candidateId`,
    [pairOrdinal]
  );
  const selectedMemberRank = requireRuntimeInteger(
    value.selectedMemberRank,
    `${label}.selectedMemberRank`,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const groupMemberRanks = requireRuntimeIntegerArray(
    value.groupMemberRanks,
    `${label}.groupMemberRanks`,
    1,
    Number.MAX_SAFE_INTEGER,
    true
  );
  if (groupMemberRanks.length === 0 || !groupMemberRanks.includes(selectedMemberRank)) {
    throw new Error(`${label}.selectedMemberRank 必须属于非空 groupMemberRanks。`);
  }
  requireRuntimeInteger(
    value.sourceStreamIndex,
    `${label}.sourceStreamIndex`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.targetStreamIndex,
    `${label}.targetStreamIndex`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const sourceCoarseBackend = validateAudioAlignmentBatchSpectralBackendIdentity(
    value.sourceCoarseBackend,
    `${label}.sourceCoarseBackend`
  );
  const targetCoarseBackend = validateAudioAlignmentBatchSpectralBackendIdentity(
    value.targetCoarseBackend,
    `${label}.targetCoarseBackend`
  );
  const sourceFineBackend = validateAudioAlignmentBatchSpectralBackendIdentity(
    value.sourceFineBackend,
    `${label}.sourceFineBackend`
  );
  const targetFineBackend = validateAudioAlignmentBatchSpectralBackendIdentity(
    value.targetFineBackend,
    `${label}.targetFineBackend`
  );
  validateFineBackendContinuity(sourceCoarseBackend, sourceFineBackend, `${label}.source`);
  validateFineBackendContinuity(targetCoarseBackend, targetFineBackend, `${label}.target`);
  const sourceRequestedWindow = validateAudioAlignmentBatchFineWindow(
    value.sourceRequestedWindow,
    `${label}.sourceRequestedWindow`,
    false
  );
  const targetRequestedWindow = validateAudioAlignmentBatchFineWindow(
    value.targetRequestedWindow,
    `${label}.targetRequestedWindow`,
    false
  );
  const sourceEffectiveWindow = validateAudioAlignmentBatchFineWindow(
    value.sourceEffectiveWindow,
    `${label}.sourceEffectiveWindow`,
    true
  );
  const targetEffectiveWindow = validateAudioAlignmentBatchFineWindow(
    value.targetEffectiveWindow,
    `${label}.targetEffectiveWindow`,
    true
  );
  validateAudioAlignmentBatchFineWindowRelation(
    sourceRequestedWindow,
    sourceEffectiveWindow,
    `${label}.source`
  );
  validateAudioAlignmentBatchFineWindowRelation(
    targetRequestedWindow,
    targetEffectiveWindow,
    `${label}.target`
  );
  requireRuntimeSha256(value.parametersHash, `${label}.parametersHash`);
  requireRuntimeSha256(value.occupancyDigest, `${label}.occupancyDigest`);
  requireRuntimeSha256(value.proposalTimeMapDigest, `${label}.proposalTimeMapDigest`);
  requireRuntimeInteger(
    value.scoreMicros,
    `${label}.scoreMicros`,
    1,
    AUDIO_ALIGNMENT_BATCH_FINE_SCORE_MICROS_ONE
  );
  const evidenceDigest = requireRuntimeSha256(value.evidenceDigest, `${label}.evidenceDigest`);
  if (
    createAudioAlignmentBatchFineExecutionEvidenceDigest(
      value as unknown as AudioAlignmentBatchFineExecutionEvidenceSnapshot
    ) !== evidenceDigest
  ) {
    throw new Error(`${label}.evidenceDigest 与 canonical evidence 不一致。`);
  }
  return {
    ...(value as unknown as AudioAlignmentBatchFineExecutionEvidenceSnapshot),
    candidateId
  };
}

function validateAudioAlignmentBatchFinePairBinding(
  pair: Record<string, unknown>,
  status: AudioAlignmentJobStatus,
  pairOrdinal: number,
  relationRanking: AudioAlignmentBatchRelationRankingSnapshot,
  frontier: AudioAlignmentBatchFineFrontierReceiptSnapshot | null,
  execution: AudioAlignmentBatchFineExecutionEvidenceSnapshot | null,
  label: string
): void {
  if (status === "queued" || status === "running" || status === "cancelled") {
    if (frontier !== null || execution !== null) {
      throw new Error(`${label} 非终态或 cancelled 状态不能发布 fine 证据。`);
    }
    return;
  }
  if (frontier === null) {
    throw new Error(`${label} 终态缺少 fineFrontier receipt。`);
  }
  if (!frontier.componentPairOrdinals.includes(pairOrdinal)) {
    throw new Error(`${label}.fineFrontier 未绑定当前 pairOrdinal。`);
  }
  const selectedForPair = frontier.selectedCandidateIds.filter(
    (candidate) => candidate.pairOrdinal === pairOrdinal
  );
  if (selectedForPair.length > 1) {
    throw new Error(`${label}.fineFrontier 对同一 pair 选择了多个候选。`);
  }
  if (selectedForPair.length === 0) {
    if (execution !== null) {
      throw new Error(`${label} 未进入第二次 assignment，却夹带 fineExecutionEvidence。`);
    }
    return;
  }
  if (
    status !== "completed" ||
    execution === null ||
    !sameFineCandidateId(selectedForPair[0], execution.candidateId)
  ) {
    throw new Error(`${label} 第二次 assignment 与 fineExecutionEvidence 不一致。`);
  }
  const identity = relationRanking.executionIdentity;
  if (
    identity === null ||
    !identity.sourceSpectralBackends.some((backend) =>
      sameSpectralBackendIdentity(backend, execution.sourceCoarseBackend)
    ) ||
    !identity.targetSpectralBackends.some((backend) =>
      sameSpectralBackendIdentity(backend, execution.targetCoarseBackend)
    )
  ) {
    throw new Error(`${label} fine coarse backend 未绑定 relation execution identity。`);
  }
  const proposal = pair.proposal;
  if (!isRecord(proposal) || !isRecord(proposal.timeMap)) {
    throw new Error(`${label} 已选 fine candidate 缺少 proposal.timeMap。`);
  }
  if (
    createAudioAlignmentBatchProposalTimeMapDigest(proposal.timeMap) !==
    execution.proposalTimeMapDigest
  ) {
    throw new Error(`${label} proposal.timeMap 与 fineExecutionEvidence 摘要不一致。`);
  }
  const legacyParametersHash = requireRuntimeText(
    proposal.timeMap.parametersHash,
    `${label}.proposal.timeMap.parametersHash`
  );
  if (
    createAudioAlignmentBatchFineParametersHash(
      identity.engineVersion,
      identity.featureVersion,
      legacyParametersHash
    ) !== execution.parametersHash
  ) {
    throw new Error(`${label} fine parametersHash 未绑定 coarse identity/TimeMap 参数。`);
  }
}

function validateAudioAlignmentBatchFineLimits(
  value: unknown,
  label: string
): AudioAlignmentBatchFineLimitsSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  const keys = [
    "maxCandidates",
    "maxSearchStates",
    "maxSearchExpansions",
    "maxIntervalComparisons",
    "maxIntervalsPerAxis",
    "maxTotalIntervals",
    "refinementBatchSize"
  ] as const;
  requireRuntimeExactKeys(value, keys, label);
  for (const key of keys) {
    requireRuntimeInteger(value[key], `${label}.${key}`, 1, Number.MAX_SAFE_INTEGER);
  }
  return value as unknown as AudioAlignmentBatchFineLimitsSnapshot;
}

function validateAudioAlignmentBatchFineStateCounts(
  value: unknown,
  label: string
): AudioAlignmentBatchFineStateCountsSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  const keys = [
    "unresolved",
    "scored",
    "evaluatedIneligible",
    "evidenceBlocked",
    "resourceBlocked",
    "infrastructureFailed",
    "cancelled"
  ] as const;
  requireRuntimeExactKeys(value, keys, label);
  for (const key of keys) {
    requireRuntimeInteger(value[key], `${label}.${key}`, 0, Number.MAX_SAFE_INTEGER);
  }
  return value as unknown as AudioAlignmentBatchFineStateCountsSnapshot;
}

function validateAudioAlignmentBatchFineAssignment(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): AudioAlignmentBatchFineAssignmentSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(value, ["candidateIds", "totalScoreMicros"], label);
  const candidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.candidateIds,
    `${label}.candidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const totalScoreMicros = requireRuntimeInteger(
    value.totalScoreMicros,
    `${label}.totalScoreMicros`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (candidateIds.length === 0 && totalScoreMicros !== 0) {
    throw new Error(`${label} 空 assignment 的总分必须为 0。`);
  }
  return { candidateIds, totalScoreMicros };
}

function validateAudioAlignmentBatchFineOmittedAssignment(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): AudioAlignmentBatchFineOmittedAssignmentSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "candidateIds",
      "totalUpperBoundMicros",
      "openCandidateIds",
      "unresolvedCandidateIds",
      "blockedCandidateIds"
    ],
    label
  );
  const candidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.candidateIds,
    `${label}.candidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const openCandidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.openCandidateIds,
    `${label}.openCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const unresolvedCandidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.unresolvedCandidateIds,
    `${label}.unresolvedCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const blockedCandidateIds = validateAudioAlignmentBatchFineCandidateIds(
    value.blockedCandidateIds,
    `${label}.blockedCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const totalUpperBoundMicros = requireRuntimeInteger(
    value.totalUpperBoundMicros,
    `${label}.totalUpperBoundMicros`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const openKeys = new Set(openCandidateIds.map(fineCandidateIdKey));
  const stateKeys = [...unresolvedCandidateIds, ...blockedCandidateIds].map(fineCandidateIdKey);
  if (
    openCandidateIds.length === 0 ||
    candidateIds.length === 0 ||
    stateKeys.length !== new Set(stateKeys).size ||
    stateKeys.length !== openKeys.size ||
    stateKeys.some((key) => !openKeys.has(key)) ||
    openCandidateIds.some(
      (candidate) => !candidateIds.some((item) => sameFineCandidateId(item, candidate))
    )
  ) {
    throw new Error(`${label} open/unresolved/blocked candidate partition 不闭合。`);
  }
  return {
    candidateIds,
    totalUpperBoundMicros,
    openCandidateIds,
    unresolvedCandidateIds,
    blockedCandidateIds
  };
}

function validateAudioAlignmentBatchFineProof(
  value: unknown,
  label: string
): AudioAlignmentBatchFineResolutionProofSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    ["beatsRunnerUpWithMargin", "beatsOptimisticOmittedWithMargin"],
    label
  );
  if (
    typeof value.beatsRunnerUpWithMargin !== "boolean" ||
    typeof value.beatsOptimisticOmittedWithMargin !== "boolean"
  ) {
    throw new Error(`${label} proof 字段必须为 boolean。`);
  }
  return value as unknown as AudioAlignmentBatchFineResolutionProofSnapshot;
}

function validateAudioAlignmentBatchFineSearch(
  value: unknown,
  label: string,
  limits: AudioAlignmentBatchFineLimitsSnapshot
): AudioAlignmentBatchFineSearchSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    ["statesVisited", "expansionsConsidered", "intervalComparisons"],
    label
  );
  requireRuntimeInteger(
    value.statesVisited,
    `${label}.statesVisited`,
    0,
    limits.maxSearchStates
  );
  requireRuntimeInteger(
    value.expansionsConsidered,
    `${label}.expansionsConsidered`,
    0,
    limits.maxSearchExpansions
  );
  requireRuntimeInteger(
    value.intervalComparisons,
    `${label}.intervalComparisons`,
    0,
    limits.maxIntervalComparisons
  );
  return value as unknown as AudioAlignmentBatchFineSearchSnapshot;
}

function validateAudioAlignmentBatchFineWindow(
  value: unknown,
  label: string,
  requireActualSamples: boolean
): AudioAlignmentBatchFineDecodeWindowSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "startMs",
      "endMs",
      "presentationOffsetMs",
      "sampleRate",
      "expectedSampleCount",
      "actualDecodedSampleCount"
    ],
    label
  );
  const startMs = requireRuntimeInteger(
    value.startMs,
    `${label}.startMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const endMs = requireRuntimeInteger(
    value.endMs,
    `${label}.endMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  if (endMs <= startMs) throw new Error(`${label} 必须为正长度半开区间。`);
  const presentationOffsetMs = requireRuntimeInteger(
    value.presentationOffsetMs,
    `${label}.presentationOffsetMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  if (presentationOffsetMs !== startMs) {
    throw new Error(`${label}.presentationOffsetMs 必须绑定窗口起点。`);
  }
  if (value.sampleRate !== AUDIO_ALIGNMENT_BATCH_FINE_SAMPLE_RATE) {
    throw new Error(`${label}.sampleRate 必须为 ${AUDIO_ALIGNMENT_BATCH_FINE_SAMPLE_RATE}。`);
  }
  const expectedSampleCount = requireRuntimeInteger(
    value.expectedSampleCount,
    `${label}.expectedSampleCount`,
    1,
    Number.MAX_SAFE_INTEGER
  );
  const expectedFromRange = Math.ceil(
    ((endMs - startMs) * AUDIO_ALIGNMENT_BATCH_FINE_SAMPLE_RATE) / 1_000
  );
  if (expectedSampleCount !== expectedFromRange) {
    throw new Error(`${label}.expectedSampleCount 与窗口时长不一致。`);
  }
  if (requireActualSamples) {
    const actual = requireRuntimeInteger(
      value.actualDecodedSampleCount,
      `${label}.actualDecodedSampleCount`,
      1,
      expectedSampleCount
    );
    if (actual > expectedSampleCount) {
      throw new Error(`${label}.actualDecodedSampleCount 超过请求上限。`);
    }
  } else if (value.actualDecodedSampleCount !== null) {
    throw new Error(`${label} requested window 不能伪报实际解码样本数。`);
  }
  return value as unknown as AudioAlignmentBatchFineDecodeWindowSnapshot;
}

function validateAudioAlignmentBatchFineWindowRelation(
  requested: AudioAlignmentBatchFineDecodeWindowSnapshot,
  effective: AudioAlignmentBatchFineDecodeWindowSnapshot,
  label: string
): void {
  if (
    effective.startMs !== requested.startMs ||
    effective.endMs > requested.endMs + AUDIO_ALIGNMENT_BATCH_FINE_WINDOW_DECODE_TOLERANCE_MS
  ) {
    throw new Error(
      `${label} effective window 必须与 requested 同起点，且结束点最多放宽 ${AUDIO_ALIGNMENT_BATCH_FINE_WINDOW_DECODE_TOLERANCE_MS}ms。`
    );
  }
}

function validateAudioAlignmentBatchFineCandidateIds(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[],
  requireCanonicalOrder: boolean,
  requireOnePerPair: boolean
): AudioAlignmentBatchFineCandidateIdSnapshot[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const ids = value.map((item, index) =>
    validateAudioAlignmentBatchFineCandidateId(
      item,
      `${label}[${index}]`,
      componentPairOrdinals
    )
  );
  const keys = ids.map(fineCandidateIdKey);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} 包含重复 candidateId。`);
  if (requireOnePerPair && new Set(ids.map((id) => id.pairOrdinal)).size !== ids.length) {
    throw new Error(`${label} 同一 pair 只能选择一个候选。`);
  }
  if (requireCanonicalOrder) {
    const sorted = [...ids].sort(compareFineCandidateId);
    if (!sameFineCandidateIds(ids, sorted)) {
      throw new Error(`${label} 必须按 pairOrdinal/candidateOrdinal canonical 排序。`);
    }
  }
  return ids;
}

function validateAudioAlignmentBatchFineInventoryCandidates(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): AudioAlignmentBatchFineInventoryCandidateSnapshot[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const candidates = value.map((item, index) => {
    const candidateLabel = `${label}[${index}]`;
    if (!isRecord(item)) throw new Error(`${candidateLabel} 不是对象。`);
    requireRuntimeExactKeys(
      item,
      [
        "id",
        "coarseUpperBoundMicros",
        "sourceAxisReuseGroupOrdinal",
        "targetAxisReuseGroupOrdinal",
        "members"
      ],
      candidateLabel
    );
    const id = validateAudioAlignmentBatchFineCandidateId(
      item.id,
      `${candidateLabel}.id`,
      componentPairOrdinals
    );
    const coarseUpperBoundMicros = requireRuntimeInteger(
      item.coarseUpperBoundMicros,
      `${candidateLabel}.coarseUpperBoundMicros`,
      0,
      AUDIO_ALIGNMENT_BATCH_FINE_SCORE_MICROS_ONE
    );
    const sourceAxisReuseGroupOrdinal = requireRuntimeNullableInteger(
      item.sourceAxisReuseGroupOrdinal,
      `${candidateLabel}.sourceAxisReuseGroupOrdinal`,
      1,
      Number.MAX_SAFE_INTEGER
    );
    const targetAxisReuseGroupOrdinal = requireRuntimeNullableInteger(
      item.targetAxisReuseGroupOrdinal,
      `${candidateLabel}.targetAxisReuseGroupOrdinal`,
      1,
      Number.MAX_SAFE_INTEGER
    );
    if (!Array.isArray(item.members) || item.members.length === 0) {
      throw new Error(`${candidateLabel}.members 必须是非空数组。`);
    }
    const members = item.members.map((member, memberIndex) =>
      validateAudioAlignmentBatchRelationCandidate(
        member,
        `${candidateLabel}.members[${memberIndex}]`,
        Number.MAX_SAFE_INTEGER,
        false
      )
    );
    if (
      members.some(
        (member, memberIndex) => memberIndex > 0 && member.rank <= members[memberIndex - 1].rank
      )
    ) {
      throw new Error(`${candidateLabel}.members 必须按 rank 严格递增。`);
    }
    return {
      id,
      coarseUpperBoundMicros,
      sourceAxisReuseGroupOrdinal,
      targetAxisReuseGroupOrdinal,
      members
    };
  });
  const ids = candidates.map((candidate) => candidate.id);
  const canonical = [...ids].sort(compareFineCandidateId);
  if (!sameFineCandidateIds(ids, canonical)) {
    throw new Error(`${label} 必须按 pairOrdinal/candidateOrdinal canonical 排序。`);
  }
  if (new Set(ids.map(fineCandidateIdKey)).size !== ids.length) {
    throw new Error(`${label} 包含重复 candidateId。`);
  }
  for (const pairOrdinal of componentPairOrdinals) {
    const pairCandidates = candidates.filter(
      (candidate) => candidate.id.pairOrdinal === pairOrdinal
    );
    const first = pairCandidates[0];
    if (
      pairCandidates.some(
        (candidate, index) =>
          candidate.id.candidateOrdinal !== index + 1 ||
          candidate.sourceAxisReuseGroupOrdinal !== first?.sourceAxisReuseGroupOrdinal ||
          candidate.targetAxisReuseGroupOrdinal !== first?.targetAxisReuseGroupOrdinal
      )
    ) {
      throw new Error(`${label} 的每个 pair 必须连续完整枚举且版本复用组保持一致。`);
    }
  }
  return candidates;
}

function validateAudioAlignmentBatchFineCandidateId(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): AudioAlignmentBatchFineCandidateIdSnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(value, ["pairOrdinal", "candidateOrdinal"], label);
  const pairOrdinal = requireRuntimeInteger(
    value.pairOrdinal,
    `${label}.pairOrdinal`,
    1,
    Number.MAX_SAFE_INTEGER
  );
  if (!componentPairOrdinals.includes(pairOrdinal)) {
    throw new Error(`${label}.pairOrdinal 不属于当前 component。`);
  }
  const candidateOrdinal = requireRuntimeInteger(
    value.candidateOrdinal,
    `${label}.candidateOrdinal`,
    1,
    Number.MAX_SAFE_INTEGER
  );
  return { pairOrdinal, candidateOrdinal };
}

function validateFineBackendContinuity(
  coarse: AudioAlignmentBatchSpectralBackendIdentitySnapshot,
  fine: AudioAlignmentBatchSpectralBackendIdentitySnapshot,
  label: string
): void {
  if (!isLockedFineSpectralBackendIdentity(coarse, fine)) {
    throw new Error(`${label} coarse→fine backend continuity 不闭合。`);
  }
}

function sameSpectralBackendIdentity(
  left: AudioAlignmentBatchSpectralBackendIdentitySnapshot,
  right: AudioAlignmentBatchSpectralBackendIdentitySnapshot
): boolean {
  return (
    left.backendId === right.backendId &&
    left.requestedBackend === right.requestedBackend &&
    left.backendDetail === right.backendDetail &&
    left.fallbackReason === right.fallbackReason
  );
}

function compareFineCandidateId(
  left: AudioAlignmentBatchFineCandidateIdSnapshot,
  right: AudioAlignmentBatchFineCandidateIdSnapshot
): number {
  return left.pairOrdinal - right.pairOrdinal || left.candidateOrdinal - right.candidateOrdinal;
}

function fineCandidateIdKey(value: AudioAlignmentBatchFineCandidateIdSnapshot): string {
  return `${value.pairOrdinal}:${value.candidateOrdinal}`;
}

function sameFineCandidateId(
  left: AudioAlignmentBatchFineCandidateIdSnapshot | undefined,
  right: AudioAlignmentBatchFineCandidateIdSnapshot | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pairOrdinal === right.pairOrdinal &&
    left.candidateOrdinal === right.candidateOrdinal
  );
}

function sameFineCandidateIds(
  left: readonly AudioAlignmentBatchFineCandidateIdSnapshot[],
  right: readonly AudioAlignmentBatchFineCandidateIdSnapshot[]
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => sameFineCandidateId(item, right[index]))
  );
}

function validateAudioAlignmentBatchFineComponentCoherence(
  pairs: readonly AudioAlignmentBatchPairSnapshot[]
): void {
  const components = new Map<number, AudioAlignmentBatchFineFrontierReceiptSnapshot>();
  for (const pair of pairs) {
    const frontier = pair.fineFrontier;
    if (frontier === null) continue;
    const existing = components.get(frontier.componentOrdinal);
    if (existing && canonicalRuntimeJson(existing) !== canonicalRuntimeJson(frontier)) {
      throw new Error("同一 fine component 的 frontier receipt 发生漂移。");
    }
    components.set(frontier.componentOrdinal, frontier);
  }
  const componentOrdinals = [...components.keys()].sort((left, right) => left - right);
  if (componentOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new Error("fine componentOrdinal 必须从 1 开始连续且无缺口。");
  }
  for (const frontier of components.values()) {
    const componentPairs = frontier.componentPairOrdinals.map((pairOrdinal) => {
      const pair = pairs[pairOrdinal - 1];
      if (
        pair === undefined ||
        pair.fineFrontier === null ||
        canonicalRuntimeJson(pair.fineFrontier) !== canonicalRuntimeJson(frontier)
      ) {
        throw new Error("fine component receipt 未由全部成员 pair 原子复用。");
      }
      return pair;
    });
    const executions = componentPairs
      .map((pair) => pair.fineExecutionEvidence)
      .filter(
        (evidence): evidence is AudioAlignmentBatchFineExecutionEvidenceSnapshot =>
          evidence !== null
      );
    if (
      frontier.resolved &&
      (executions.length !== frontier.selectedCandidateIds.length ||
        executions.some(
          (evidence) =>
            !frontier.selectedCandidateIds.some((candidate) =>
              sameFineCandidateId(candidate, evidence.candidateId)
            )
        ) ||
        executions.reduce((sum, evidence) => sum + evidence.scoreMicros, 0) !==
          frontier.selectedTotalScoreMicros)
    ) {
      throw new Error("fine component 的 selected IDs、execution evidence 与总分不闭合。");
    }
  }
}

const AUDIO_ALIGNMENT_BATCH_SELECTION_STATES = [
  "pending",
  "selected",
  "blocked",
  "failed",
  "cancelled"
] as const;

const AUDIO_ALIGNMENT_BATCH_RELATION_RANKING_STATES = [
  "pending",
  "ranked",
  "noEligibleCandidate",
  "failed",
  "cancelled"
] as const;

function validateAudioAlignmentBatchRelationRanking(
  value: unknown,
  label: string
): AudioAlignmentBatchRelationRankingSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${label} 不是对象。`);
  }
  requireRuntimeExactKeys(
    value,
    [
      "scoreVersion",
      "executionIdentityDigest",
      "executionIdentity",
      "state",
      "candidateCount",
      "eligibleCandidateCount",
      "score",
      "bestEligibleCandidate"
    ],
    label
  );
  if (value.scoreVersion !== AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION) {
    throw new Error(`${label}.scoreVersion 无效。`);
  }
  const executionIdentityDigest =
    value.executionIdentityDigest === null
      ? null
      : requireRuntimeSha256(value.executionIdentityDigest, `${label}.executionIdentityDigest`);
  const executionIdentity =
    value.executionIdentity === null
      ? null
      : validateAudioAlignmentBatchExecutionIdentity(
          value.executionIdentity,
          `${label}.executionIdentity`
        );
  if ((executionIdentityDigest === null) !== (executionIdentity === null)) {
    throw new Error(`${label} execution identity/digest 必须同时存在或同时为空。`);
  }
  const state = requireRuntimeEnum(
    value.state,
    AUDIO_ALIGNMENT_BATCH_RELATION_RANKING_STATES,
    `${label}.state`
  );
  const candidateCount = requireRuntimeInteger(
    value.candidateCount,
    `${label}.candidateCount`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const eligibleCandidateCount = requireRuntimeInteger(
    value.eligibleCandidateCount,
    `${label}.eligibleCandidateCount`,
    0,
    candidateCount
  );
  const score = requireRuntimeNullableFinite(value.score, `${label}.score`);
  const bestEligibleCandidate =
    value.bestEligibleCandidate === null
      ? null
      : validateAudioAlignmentBatchRelationCandidate(
          value.bestEligibleCandidate,
          `${label}.bestEligibleCandidate`,
          candidateCount
        );
  if (state === "ranked") {
    if (
      candidateCount === 0 ||
      eligibleCandidateCount === 0 ||
      score === null ||
      bestEligibleCandidate === null ||
      score !== bestEligibleCandidate.globalScore ||
      executionIdentity === null
    ) {
      throw new Error(`${label} ranked 内容不闭合。`);
    }
  } else if (state === "noEligibleCandidate") {
    if (
      eligibleCandidateCount !== 0 ||
      score !== null ||
      bestEligibleCandidate !== null ||
      executionIdentity === null
    ) {
      throw new Error(`${label} noEligibleCandidate 夹带了候选或分数。`);
    }
  } else if (
    candidateCount !== 0 ||
    eligibleCandidateCount !== 0 ||
    score !== null ||
    bestEligibleCandidate !== null ||
    executionIdentity !== null
  ) {
    throw new Error(`${label} 非结果态不能夹带候选证据。`);
  }
  return value as unknown as AudioAlignmentBatchRelationRankingSnapshot;
}

function validateAudioAlignmentBatchExecutionIdentity(
  value: unknown,
  label: string
): AudioAlignmentBatchExecutionIdentitySnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "schemaVersion",
      "engineVersion",
      "featureVersion",
      "relationScoreVersion",
      "nativeExecutableDigest",
      "ffmpegBinaryDigest",
      "ffprobeBinaryDigest",
      "sourceSpectralBackends",
      "targetSpectralBackends"
    ],
    label
  );
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion 无效。`);
  requireRuntimeText(value.engineVersion, `${label}.engineVersion`);
  requireRuntimeText(value.featureVersion, `${label}.featureVersion`);
  if (value.relationScoreVersion !== AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION) {
    throw new Error(`${label}.relationScoreVersion 无效。`);
  }
  requireRuntimeSha256(value.nativeExecutableDigest, `${label}.nativeExecutableDigest`);
  requireRuntimeSha256(value.ffmpegBinaryDigest, `${label}.ffmpegBinaryDigest`);
  requireRuntimeSha256(value.ffprobeBinaryDigest, `${label}.ffprobeBinaryDigest`);
  validateAudioAlignmentBatchSpectralBackendIdentities(
    value.sourceSpectralBackends,
    `${label}.sourceSpectralBackends`
  );
  validateAudioAlignmentBatchSpectralBackendIdentities(
    value.targetSpectralBackends,
    `${label}.targetSpectralBackends`
  );
  return value as unknown as AudioAlignmentBatchExecutionIdentitySnapshot;
}

function validateAudioAlignmentBatchSpectralBackendIdentities(
  value: unknown,
  label: string
): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是非空数组。`);
  }
  const canonical = value.map((item, index) =>
    validateAudioAlignmentBatchSpectralBackendIdentity(item, `${label}[${index}]`)
  );
  const sorted = [...canonical].sort(compareSpectralBackendIdentity);
  if (
    canonical.some((item, index) => JSON.stringify(item) !== JSON.stringify(sorted[index])) ||
    canonical.some(
      (item, index) =>
        index > 0 && JSON.stringify(item) === JSON.stringify(canonical[index - 1])
    )
  ) {
    throw new Error(`${label} 必须 canonical 排序且去重。`);
  }
}

function validateAudioAlignmentBatchSpectralBackendIdentity(
  value: unknown,
  label: string
): AudioAlignmentBatchSpectralBackendIdentitySnapshot {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    ["backendId", "requestedBackend", "backendDetail", "fallbackReason"],
    label
  );
  return {
    backendId: requireRuntimeText(value.backendId, `${label}.backendId`),
    requestedBackend: requireRuntimeText(value.requestedBackend, `${label}.requestedBackend`),
    backendDetail: requireRuntimeText(value.backendDetail, `${label}.backendDetail`),
    fallbackReason:
      value.fallbackReason === null
        ? null
        : requireRuntimeText(value.fallbackReason, `${label}.fallbackReason`)
  };
}

function compareSpectralBackendIdentity(
  left: AudioAlignmentBatchSpectralBackendIdentitySnapshot,
  right: AudioAlignmentBatchSpectralBackendIdentitySnapshot
): number {
  return (
    compareCanonicalText(left.backendId, right.backendId) ||
    compareCanonicalText(left.requestedBackend, right.requestedBackend) ||
    compareCanonicalText(left.backendDetail, right.backendDetail) ||
    (left.fallbackReason === right.fallbackReason
      ? 0
      : left.fallbackReason === null
        ? -1
        : right.fallbackReason === null
          ? 1
          : compareCanonicalText(left.fallbackReason, right.fallbackReason))
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateAudioAlignmentBatchRelationCandidate(
  value: unknown,
  label: string,
  candidateCount: number,
  requireIntrinsicEligibility = true
): AudioAlignmentBatchRelationCandidateSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${label} 不是对象。`);
  }
  requireRuntimeExactKeys(
    value,
    [
      "rank",
      "sourceStreamIndex",
      "targetStreamIndex",
      "score",
      "globalScore",
      "scale",
      "offsetMs",
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "inlierCount",
      "temporalCoverage",
      "uniqueSourceCoverage"
    ],
    label
  );
  requireRuntimeInteger(value.rank, `${label}.rank`, 1, candidateCount);
  requireRuntimeInteger(
    value.sourceStreamIndex,
    `${label}.sourceStreamIndex`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.targetStreamIndex,
    `${label}.targetStreamIndex`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeFinite(value.score, `${label}.score`);
  const globalScore = requireRuntimeFinite(value.globalScore, `${label}.globalScore`);
  if (requireIntrinsicEligibility && globalScore <= 0) {
    throw new Error(`${label}.globalScore 未达到 intrinsic eligibility。`);
  }
  const scale = requireRuntimeFinite(value.scale, `${label}.scale`);
  if (scale <= 0) throw new Error(`${label}.scale 必须大于 0。`);
  requireRuntimeInteger(
    value.offsetMs,
    `${label}.offsetMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const sourceStartMs = requireRuntimeInteger(
    value.sourceStartMs,
    `${label}.sourceStartMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const sourceEndMs = requireRuntimeInteger(
    value.sourceEndMs,
    `${label}.sourceEndMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const targetStartMs = requireRuntimeInteger(
    value.targetStartMs,
    `${label}.targetStartMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const targetEndMs = requireRuntimeInteger(
    value.targetEndMs,
    `${label}.targetEndMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的候选区间必须为正长度。`);
  }
  requireRuntimeInteger(
    value.inlierCount,
    `${label}.inlierCount`,
    requireIntrinsicEligibility ? 6 : 0,
    Number.MAX_SAFE_INTEGER
  );
  const temporalCoverage = requireRuntimeUnit(
    value.temporalCoverage,
    `${label}.temporalCoverage`
  );
  if (requireIntrinsicEligibility && temporalCoverage < 0.2) {
    throw new Error(`${label}.temporalCoverage 未达到 intrinsic eligibility。`);
  }
  requireRuntimeUnit(value.uniqueSourceCoverage, `${label}.uniqueSourceCoverage`);
  return value as unknown as AudioAlignmentBatchRelationCandidateSnapshot;
}

function validateAudioAlignmentBatchGlobalSelection(
  value: unknown,
  label: string
): AudioAlignmentBatchGlobalSelectionSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${label} 不是对象。`);
  }
  requireRuntimeExactKeys(
    value,
    [
      "state",
      "selected",
      "selectedRank",
      "selectedScore",
      "decisionRank",
      "decisionScore",
      "margin",
      "candidateCount",
      "eligibleCandidateCount",
      "topK",
      "decisionCandidate"
    ],
    label
  );
  const state = requireRuntimeEnum(
    value.state,
    AUDIO_ALIGNMENT_BATCH_SELECTION_STATES,
    `${label}.state`
  );
  if (typeof value.selected !== "boolean") {
    throw new Error(`${label}.selected 必须是布尔值。`);
  }
  const candidateCount = requireRuntimeInteger(
    value.candidateCount,
    `${label}.candidateCount`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const eligibleCandidateCount = requireRuntimeInteger(
    value.eligibleCandidateCount,
    `${label}.eligibleCandidateCount`,
    0,
    candidateCount
  );
  if (!Array.isArray(value.topK) || value.topK.length !== Math.min(candidateCount, 10)) {
    throw new Error(`${label}.topK 数量无效。`);
  }
  const topK = value.topK.map((candidate, index) =>
    validateAudioAlignmentBatchGlobalCandidate(candidate, `${label}.topK[${index}]`, index + 1)
  );
  const selectedRank = requireRuntimeNullableInteger(
    value.selectedRank,
    `${label}.selectedRank`,
    1,
    candidateCount
  );
  const selectedScore = requireRuntimeNullableFinite(
    value.selectedScore,
    `${label}.selectedScore`
  );
  const decisionRank = requireRuntimeNullableInteger(
    value.decisionRank,
    `${label}.decisionRank`,
    1,
    candidateCount
  );
  const decisionScore = requireRuntimeNullableFinite(
    value.decisionScore,
    `${label}.decisionScore`
  );
  const margin = requireRuntimeNullableUnit(value.margin, `${label}.margin`);
  const decisionCandidate =
    value.decisionCandidate === null
      ? null
      : validateAudioAlignmentBatchGlobalCandidate(
          value.decisionCandidate,
          `${label}.decisionCandidate`,
          decisionRank ?? undefined
        );

  if (
    (decisionRank === null) !== (decisionScore === null) ||
    (decisionRank === null) !== (decisionCandidate === null)
  ) {
    throw new Error(`${label} 的 decision rank/score/candidate 必须同时存在或同时为空。`);
  }
  if (
    decisionCandidate !== null &&
    (decisionCandidate.rank !== decisionRank || decisionCandidate.globalScore !== decisionScore)
  ) {
    throw new Error(`${label} 的 decision candidate 未绑定 rank/score。`);
  }
  if (
    decisionCandidate !== null &&
    decisionRank !== null &&
    decisionRank <= topK.length &&
    globalCandidateKey(decisionCandidate) !== globalCandidateKey(topK[decisionRank - 1])
  ) {
    throw new Error(`${label} 的 decision candidate 与 Top-K 同 rank 候选不一致。`);
  }
  const selectedCandidates = [
    ...topK.filter((candidate) => candidate.globalSelected),
    ...(decisionCandidate?.globalSelected &&
    !topK.some(
      (candidate) => globalCandidateKey(candidate) === globalCandidateKey(decisionCandidate)
    )
      ? [decisionCandidate]
      : [])
  ];
  if (state === "selected") {
    if (
      value.selected !== true ||
      selectedRank === null ||
      selectedScore === null ||
      decisionCandidate === null ||
      selectedRank !== decisionRank ||
      selectedScore !== decisionScore ||
      !decisionCandidate.globalSelected ||
      !decisionCandidate.eligible ||
      selectedCandidates.length !== 1
    ) {
      throw new Error(`${label} 的 selected 证据不闭合。`);
    }
  } else if (
    value.selected !== false ||
    selectedRank !== null ||
    selectedScore !== null ||
    selectedCandidates.length !== 0
  ) {
    throw new Error(`${label} 的非 selected 状态夹带了选择结果。`);
  }
  if (
    (state === "pending" || state === "cancelled") &&
    (candidateCount !== 0 ||
      eligibleCandidateCount !== 0 ||
      topK.length !== 0 ||
      decisionRank !== null ||
      margin !== null)
  ) {
    throw new Error(`${label} 的 ${state} 状态不能夹带候选证据。`);
  }
  return value as unknown as AudioAlignmentBatchGlobalSelectionSnapshot;
}

function validateAudioAlignmentBatchGlobalCandidate(
  value: unknown,
  label: string,
  expectedRank?: number
): AudioAlignmentBatchGlobalCandidateSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${label} 不是对象。`);
  }
  requireRuntimeExactKeys(
    value,
    [
      "rank",
      "sourceStreamIndex",
      "targetStreamIndex",
      "score",
      "globalScore",
      "scale",
      "offsetMs",
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "inlierCount",
      "temporalCoverage",
      "uniqueSourceCoverage",
      "eligible",
      "globalSelected"
    ],
    label
  );
  const rank = requireRuntimeInteger(value.rank, `${label}.rank`, 1, Number.MAX_SAFE_INTEGER);
  if (expectedRank !== undefined && rank !== expectedRank) {
    throw new Error(`${label}.rank 不是连续 canonical 排名。`);
  }
  requireRuntimeInteger(
    value.sourceStreamIndex,
    `${label}.sourceStreamIndex`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.targetStreamIndex,
    `${label}.targetStreamIndex`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeFinite(value.score, `${label}.score`);
  requireRuntimeFinite(value.globalScore, `${label}.globalScore`);
  const scale = requireRuntimeFinite(value.scale, `${label}.scale`);
  if (scale <= 0) throw new Error(`${label}.scale 必须大于 0。`);
  requireRuntimeInteger(
    value.offsetMs,
    `${label}.offsetMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const sourceStartMs = requireRuntimeInteger(
    value.sourceStartMs,
    `${label}.sourceStartMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const sourceEndMs = requireRuntimeInteger(
    value.sourceEndMs,
    `${label}.sourceEndMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const targetStartMs = requireRuntimeInteger(
    value.targetStartMs,
    `${label}.targetStartMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  const targetEndMs = requireRuntimeInteger(
    value.targetEndMs,
    `${label}.targetEndMs`,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER
  );
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的候选区间必须为正长度。`);
  }
  requireRuntimeInteger(value.inlierCount, `${label}.inlierCount`, 0, Number.MAX_SAFE_INTEGER);
  requireRuntimeUnit(value.temporalCoverage, `${label}.temporalCoverage`);
  requireRuntimeUnit(value.uniqueSourceCoverage, `${label}.uniqueSourceCoverage`);
  if (typeof value.eligible !== "boolean" || typeof value.globalSelected !== "boolean") {
    throw new Error(`${label} 的 eligible/globalSelected 必须为布尔值。`);
  }
  if (value.globalSelected && !value.eligible) {
    throw new Error(`${label} 不能选择不合格候选。`);
  }
  return value as unknown as AudioAlignmentBatchGlobalCandidateSnapshot;
}

function validateAlignmentSensitiveManifestSummary(
  value: unknown,
  label: string
): AlignmentSensitiveManifestSummary {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "runId",
      "manifestPayloadDigest",
      "manifestCanonicalPayloadDigest",
      "lifecycleStage",
      "createdAtMs",
      "updatedAtMs",
      "appVersion",
      "engineVersion",
      "featureVersion",
      "status",
      "sourceMediaCount",
      "targetMediaCount",
      "pairCount",
      "processedPairCount",
      "completedPairCount",
      "failedPairCount",
      "cancelledPairCount",
      "preparedMediaCount",
      "identifiedMediaCount",
      "audioCandidateCount",
      "landmarkArtifactCount",
      "landmarkCacheHitCount",
      "evidenceSpanCount",
      "uncertainSpanCount",
      "visualEvidencePairCount",
      "visualEvidenceRequested",
      "evidenceGroupKey",
      "intakeState",
      "readyForTrainingIntake",
      "reviewCandidatePairs",
      "notes"
    ],
    label
  );
  const runId = requireRuntimeText(value.runId, `${label}.runId`);
  if (runId.length > 96 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`${label}.runId 无效。`);
  }
  requireRuntimeSha256(value.manifestPayloadDigest, `${label}.manifestPayloadDigest`);
  if (value.manifestCanonicalPayloadDigest !== null) {
    requireRuntimeSha256(
      value.manifestCanonicalPayloadDigest,
      `${label}.manifestCanonicalPayloadDigest`
    );
  }
  const lifecycleStage = requireRuntimeEnum(
    value.lifecycleStage,
    ["queued", "prepared", "terminal"] as const,
    `${label}.lifecycleStage`
  );
  const createdAtMs = requireRuntimeInteger(
    value.createdAtMs,
    `${label}.createdAtMs`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.updatedAtMs,
    `${label}.updatedAtMs`,
    createdAtMs,
    Number.MAX_SAFE_INTEGER
  );
  ["appVersion", "engineVersion", "featureVersion"].forEach((key) => {
    const text = requireRuntimeText(value[key], `${label}.${key}`);
    if (text.length > 256) throw new Error(`${label}.${key} 过长。`);
  });
  requireRuntimeJobStatus(value.status, `${label}.status`);
  const sourceMediaCount = requireRuntimeInteger(
    value.sourceMediaCount,
    `${label}.sourceMediaCount`,
    1,
    256
  );
  const targetMediaCount = requireRuntimeInteger(
    value.targetMediaCount,
    `${label}.targetMediaCount`,
    1,
    256
  );
  const pairCount = requireRuntimeInteger(value.pairCount, `${label}.pairCount`, 1, 65_536);
  requireRuntimeInteger(value.processedPairCount, `${label}.processedPairCount`, 0, pairCount);
  const completedPairCount = requireRuntimeInteger(
    value.completedPairCount,
    `${label}.completedPairCount`,
    0,
    pairCount
  );
  const failedPairCount = requireRuntimeInteger(
    value.failedPairCount,
    `${label}.failedPairCount`,
    0,
    pairCount
  );
  const cancelledPairCount = requireRuntimeInteger(
    value.cancelledPairCount,
    `${label}.cancelledPairCount`,
    0,
    pairCount
  );
  if (completedPairCount + failedPairCount + cancelledPairCount > pairCount) {
    throw new Error(`${label} 的关系终态计数超过总数。`);
  }
  const mediaCount = sourceMediaCount + targetMediaCount;
  const preparedMediaCount = requireRuntimeInteger(
    value.preparedMediaCount,
    `${label}.preparedMediaCount`,
    0,
    mediaCount
  );
  const identifiedMediaCount = requireRuntimeInteger(
    value.identifiedMediaCount,
    `${label}.identifiedMediaCount`,
    0,
    preparedMediaCount
  );
  requireRuntimeInteger(value.audioCandidateCount, `${label}.audioCandidateCount`, 0, 65_536);
  const landmarkArtifactCount = requireRuntimeInteger(
    value.landmarkArtifactCount,
    `${label}.landmarkArtifactCount`,
    0,
    65_536
  );
  requireRuntimeInteger(
    value.landmarkCacheHitCount,
    `${label}.landmarkCacheHitCount`,
    0,
    landmarkArtifactCount
  );
  const evidenceSpanCount = requireRuntimeInteger(
    value.evidenceSpanCount,
    `${label}.evidenceSpanCount`,
    0,
    1_000_000
  );
  requireRuntimeInteger(
    value.uncertainSpanCount,
    `${label}.uncertainSpanCount`,
    0,
    evidenceSpanCount
  );
  requireRuntimeInteger(
    value.visualEvidencePairCount,
    `${label}.visualEvidencePairCount`,
    0,
    pairCount
  );
  if (typeof value.visualEvidenceRequested !== "boolean") {
    throw new Error(`${label}.visualEvidenceRequested 必须是布尔值。`);
  }
  if (value.evidenceGroupKey !== null) {
    requireRuntimeSha256(value.evidenceGroupKey, `${label}.evidenceGroupKey`);
  }
  const intakeState = requireRuntimeEnum(
    value.intakeState,
    ["collecting", "ready", "partial", "unusable"] as const,
    `${label}.intakeState`
  );
  if (typeof value.readyForTrainingIntake !== "boolean") {
    throw new Error(`${label}.readyForTrainingIntake 必须是布尔值。`);
  }
  if (value.readyForTrainingIntake !== ["ready", "partial"].includes(intakeState)) {
    throw new Error(`${label} 的可整理标记与状态不一致。`);
  }
  if (
    value.readyForTrainingIntake &&
    (lifecycleStage !== "terminal" ||
      completedPairCount === 0 ||
      identifiedMediaCount !== mediaCount ||
      value.evidenceGroupKey === null)
  ) {
    throw new Error(`${label} 尚未满足真实训练证据整理条件。`);
  }
  if (
    !Array.isArray(value.reviewCandidatePairs) ||
    value.reviewCandidatePairs.length > completedPairCount
  ) {
    throw new Error(`${label}.reviewCandidatePairs 无效。`);
  }
  const pairOrdinals = new Set<number>();
  const queryKeys = new Set<string>();
  let reviewTaskCount = 0;
  value.reviewCandidatePairs.forEach((pairValue, pairIndex) => {
    const pair = validateAlignmentSensitiveReviewPairSummary(
      pairValue,
      `${label}.reviewCandidatePairs[${pairIndex}]`,
      pairCount,
      queryKeys
    );
    if (pairOrdinals.has(pair.pairOrdinal)) {
      throw new Error(`${label} 包含重复的复核关系。`);
    }
    pairOrdinals.add(pair.pairOrdinal);
    reviewTaskCount += pair.tasks.length;
  });
  if (reviewTaskCount > 64) throw new Error(`${label} 的复核任务超过 64 项上限。`);
  if (!Array.isArray(value.notes) || value.notes.length > 8) {
    throw new Error(`${label}.notes 必须是最多 8 项的数组。`);
  }
  value.notes.forEach((note, index) => {
    if (typeof note !== "string" || note.length > 512) {
      throw new Error(`${label}.notes[${index}] 无效。`);
    }
  });
  return value as unknown as AlignmentSensitiveManifestSummary;
}

function validateAlignmentSensitiveReviewPairSummary(
  value: unknown,
  label: string,
  pairCount: number,
  queryKeys: Set<string>
): AlignmentSensitiveReviewPairSummary {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    ["pairOrdinal", "sourceMediaIdDigest", "targetMediaIdDigest", "riskyTaskCount", "tasks"],
    label
  );
  requireRuntimeInteger(value.pairOrdinal, `${label}.pairOrdinal`, 1, pairCount);
  requireRuntimeSha256(value.sourceMediaIdDigest, `${label}.sourceMediaIdDigest`);
  requireRuntimeSha256(value.targetMediaIdDigest, `${label}.targetMediaIdDigest`);
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 20) {
    throw new Error(`${label}.tasks 必须包含 1 至 20 项。`);
  }
  requireRuntimeInteger(value.riskyTaskCount, `${label}.riskyTaskCount`, 0, value.tasks.length);
  value.tasks.forEach((task, index) =>
    validateAlignmentSensitiveReviewTaskSummary(task, `${label}.tasks[${index}]`, queryKeys)
  );
  return value as unknown as AlignmentSensitiveReviewPairSummary;
}

function validateAlignmentSensitiveReviewTaskSummary(
  value: unknown,
  label: string,
  queryKeys: Set<string>
): AlignmentSensitiveReviewTaskSummary {
  if (!isRecord(value)) throw new Error(`${label} 不是对象。`);
  requireRuntimeExactKeys(
    value,
    [
      "queryKey",
      "sourceTimestampMs",
      "sourcePreviewStartMs",
      "sourcePreviewEndMs",
      "targetReviewStartMs",
      "targetReviewEndMs",
      "candidateTimestampsMs",
      "category",
      "riskScoreMicros"
    ],
    label
  );
  const queryKey = requireRuntimeSha256(value.queryKey, `${label}.queryKey`);
  if (queryKeys.has(queryKey)) throw new Error(`${label}.queryKey 重复。`);
  queryKeys.add(queryKey);
  const sourceStart = requireRuntimeInteger(
    value.sourcePreviewStartMs,
    `${label}.sourcePreviewStartMs`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const sourceTimestamp = requireRuntimeInteger(
    value.sourceTimestampMs,
    `${label}.sourceTimestampMs`,
    sourceStart,
    Number.MAX_SAFE_INTEGER
  );
  requireRuntimeInteger(
    value.sourcePreviewEndMs,
    `${label}.sourcePreviewEndMs`,
    sourceTimestamp,
    Number.MAX_SAFE_INTEGER
  );
  const targetStart = requireRuntimeInteger(
    value.targetReviewStartMs,
    `${label}.targetReviewStartMs`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const targetEnd = requireRuntimeInteger(
    value.targetReviewEndMs,
    `${label}.targetReviewEndMs`,
    targetStart + 1,
    Number.MAX_SAFE_INTEGER
  );
  if (
    !Array.isArray(value.candidateTimestampsMs) ||
    value.candidateTimestampsMs.length < 1 ||
    value.candidateTimestampsMs.length > 4
  ) {
    throw new Error(`${label}.candidateTimestampsMs 必须包含 1 至 4 项。`);
  }
  const timestamps = value.candidateTimestampsMs.map((timestamp, index) =>
    requireRuntimeInteger(
      timestamp,
      `${label}.candidateTimestampsMs[${index}]`,
      targetStart,
      targetEnd
    )
  );
  if (new Set(timestamps).size !== timestamps.length) {
    throw new Error(`${label}.candidateTimestampsMs 包含重复位置。`);
  }
  const category = requireRuntimeText(value.category, `${label}.category`);
  if (category.length > 64) throw new Error(`${label}.category 过长。`);
  requireRuntimeInteger(value.riskScoreMicros, `${label}.riskScoreMicros`, 0, 1_000_000);
  return value as unknown as AlignmentSensitiveReviewTaskSummary;
}

function requireRuntimeJobStatus(value: unknown, label: string): AudioAlignmentJobStatus {
  if (
    typeof value !== "string" ||
    !AUDIO_ALIGNMENT_JOB_STATUSES.has(value as AudioAlignmentJobStatus)
  ) {
    throw new Error(`${label}无效。`);
  }
  return value as AudioAlignmentJobStatus;
}

function requireRuntimeProgress(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}必须位于 0 到 1。`);
  }
  return value;
}

function requireRuntimeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label}无效。`);
  }
  return value as number;
}

function requireRuntimeIntegerArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  requireCanonicalOrder: boolean
): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const numbers = value.map((item, index) =>
    requireRuntimeInteger(item, `${label}[${index}]`, minimum, maximum)
  );
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`${label} 包含重复值。`);
  }
  if (
    requireCanonicalOrder &&
    numbers.some((item, index) => index > 0 && item <= (numbers[index - 1] ?? item))
  ) {
    throw new Error(`${label} 必须严格递增。`);
  }
  return numbers;
}

function requireRuntimeNullableInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | null {
  return value === null ? null : requireRuntimeInteger(value, label, minimum, maximum);
}

function requireRuntimeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值。`);
  }
  return value;
}

function requireRuntimeNullableFinite(value: unknown, label: string): number | null {
  return value === null ? null : requireRuntimeFinite(value, label);
}

function requireRuntimeUnit(value: unknown, label: string): number {
  const number = requireRuntimeFinite(value, label);
  if (number < 0 || number > 1) {
    throw new Error(`${label} 必须位于 0 到 1。`);
  }
  return number;
}

function requireRuntimeNullableUnit(value: unknown, label: string): number | null {
  return value === null ? null : requireRuntimeUnit(value, label);
}

function requireRuntimeEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} 无效。`);
  }
  return value;
}

function requireRuntimeIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error(`${label} 必须包含 1–256 个媒体 ID。`);
  }
  const ids = value.map((item, index) => {
    const id = requireRuntimeText(item, `${label}[${index}]`);
    if (id.length > 512 || containsInvalidMediaIdCharacter(id)) {
      throw new Error(`${label}[${index}] 不是有界无路径媒体 ID。`);
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} 包含重复媒体 ID。`);
  }
  return ids;
}

function validateVersionReuseGroupSnapshots(
  value: unknown,
  sourceMediaIds: readonly string[],
  targetMediaIds: readonly string[],
  label: string
): AudioAlignmentBatchVersionReuseGroupSnapshot[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const sourceOrder = new Map(sourceMediaIds.map((mediaId, index) => [mediaId, index]));
  const targetOrder = new Map(targetMediaIds.map((mediaId, index) => [mediaId, index]));
  const seenGroupIds = new Set<string>();
  const groupedMedia = new Set<string>();
  const groups = value.map((item, index) => {
    const groupLabel = `${label}[${index}]`;
    if (!isRecord(item)) throw new Error(`${groupLabel} 不是对象。`);
    requireRuntimeExactKeys(item, ["groupOrdinal", "groupId", "side", "mediaIds"], groupLabel);
    const groupOrdinal = requireRuntimeInteger(
      item.groupOrdinal,
      `${groupLabel}.groupOrdinal`,
      1,
      value.length
    );
    if (groupOrdinal !== index + 1) {
      throw new Error(`${label} 必须按连续 groupOrdinal canonical 排序。`);
    }
    const groupId = requireRuntimeText(item.groupId, `${groupLabel}.groupId`);
    if (
      !/^[A-Za-z0-9._:-]+$/.test(groupId) ||
      new TextEncoder().encode(groupId).byteLength > 160 ||
      seenGroupIds.has(groupId)
    ) {
      throw new Error(`${groupLabel}.groupId 无效或重复。`);
    }
    seenGroupIds.add(groupId);
    const side = requireRuntimeEnum(
      item.side,
      ["source", "target"] as const,
      `${groupLabel}.side`
    );
    const order = side === "source" ? sourceOrder : targetOrder;
    const mediaIds = requireRuntimeIdArray(item.mediaIds, `${groupLabel}.mediaIds`);
    if (mediaIds.length < 2) {
      throw new Error(`${groupLabel}.mediaIds 至少需要两个成员。`);
    }
    mediaIds.forEach((mediaId, memberIndex) => {
      if (!order.has(mediaId)) {
        throw new Error(`${groupLabel} 引用了错误侧或不存在的媒体。`);
      }
      if (
        memberIndex > 0 &&
        (order.get(mediaIds[memberIndex - 1] ?? "") ?? -1) >= (order.get(mediaId) ?? -1)
      ) {
        throw new Error(`${groupLabel}.mediaIds 未按媒体 inventory canonical 排序。`);
      }
      const membershipKey = `${side}\u0000${mediaId}`;
      if (groupedMedia.has(membershipKey)) {
        throw new Error(`${groupLabel} 的媒体重复出现在多个同侧版本组。`);
      }
      groupedMedia.add(membershipKey);
    });
    return { groupOrdinal, groupId, side, mediaIds };
  });
  const canonical = [...groups].sort(
    (left, right) =>
      (left.side === "source" ? 0 : 1) - (right.side === "source" ? 0 : 1) ||
      left.groupId.localeCompare(right.groupId)
  );
  if (!sameVersionReuseGroups(groups, canonical)) {
    throw new Error(`${label} 未按 side/groupId canonical 排序。`);
  }
  return groups;
}

function containsInvalidMediaIdCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === "\\" ||
      character === "/" ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function requireRuntimeExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    throw new Error(`${label} 缺少必需字段或包含未知字段。`);
  }
}

function globalCandidateKey(candidate: AudioAlignmentBatchGlobalCandidateSnapshot): string {
  return JSON.stringify([
    candidate.rank,
    candidate.sourceStreamIndex,
    candidate.targetStreamIndex,
    candidate.score,
    candidate.globalScore,
    candidate.scale,
    candidate.offsetMs,
    candidate.sourceStartMs,
    candidate.sourceEndMs,
    candidate.targetStartMs,
    candidate.targetEndMs,
    candidate.inlierCount,
    candidate.temporalCoverage,
    candidate.uniqueSourceCoverage,
    candidate.eligible
  ]);
}

function requireRuntimeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空。`);
  }
  return value;
}

function requireRuntimeSha256(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} 必须是规范小写 SHA-256 摘要。`);
  }
  return value as `sha256:${string}`;
}

function canonicalRuntimeJson(value: unknown): string {
  const canonical = canonicalizeRuntimeValue(value);
  const json = JSON.stringify(canonical);
  if (json === undefined) {
    throw new Error("原生 v3 canonical JSON 不接受 undefined、函数或 symbol。");
  }
  return json;
}

function canonicalizeRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeRuntimeValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, nested]) => [key, canonicalizeRuntimeValue(nested)])
    );
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("原生 v3 canonical JSON 不接受非有限数值。");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("原生 v3 canonical JSON 不接受超出安全范围的整数。");
    }
    return `f64:${float64BitsHex(value)}`;
  }
  return value;
}

function float64BitsHex(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAudioStreamIndex(
  value: number | null | undefined,
  label: string
): number | null {
  return normalizeStreamIndex(value, label);
}

function normalizeStreamIndex(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负安全整数或 null。`);
  }
  if (value > 0xffff_ffff) {
    throw new Error(`${label}必须位于 Rust u32 的 0–4294967295 范围或为 null。`);
  }
  return value;
}

function formatAudioAlignmentFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
