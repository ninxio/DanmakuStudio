import { isAlignmentTimeMapProposal } from "./timeMapProposal";
import { isLockedFineSpectralBackendIdentity } from "./fineSpectralBackend";
import type { AlignmentTimeMapProposal } from "./types";
import {
  areMediaContentIdentitiesEqual,
  cloneMediaContentIdentity,
  isMediaContentIdentity
} from "../project/mediaIdentity";
import type { MediaContentIdentity } from "../project/types";
import { sha256Hex } from "../shared/sha256";

export const REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION = 2 as const;
export const REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION = 5 as const;
export const REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION =
  "c137-real-media-blind-full-cartesian-batch-v5" as const;
export const REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION = 5 as const;
export const REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION =
  "alignment-v2-pair-intrinsic-global-weight-v1" as const;
export const REAL_MEDIA_BLIND_BATCH_EXECUTION_IDENTITY_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_BLIND_BATCH_FINE_FRONTIER_CONTRACT_VERSION =
  "alignment-v2-adaptive-fine-frontier-v3" as const;
export const REAL_MEDIA_BLIND_BATCH_FINE_SCORE_VERSION =
  "alignment-v2-coarse-upper-times-confidence-v1" as const;

const NATIVE_BATCH_TOP_K_LIMIT = 10;
const RELATION_MIN_TEMPORAL_COVERAGE = 0.2;
const RELATION_MIN_INLIER_COUNT = 6;
const FINE_FRONTIER_RECEIPT_DIGEST_DOMAIN = "audio-alignment-v5/fine-frontier-receipt/v3";
const FINE_FRONTIER_INVENTORY_DIGEST_DOMAIN = "audio-alignment-v5/fine-frontier-inventory/v3";
const FINE_EXECUTION_EVIDENCE_DIGEST_DOMAIN = "audio-alignment-v5/fine-execution-evidence/v2";
const FINE_PROPOSAL_TIME_MAP_DIGEST_DOMAIN = "audio-alignment-v5/proposal-time-map/v1";
const FINE_PARAMETERS_DIGEST_DOMAIN = "audio-alignment-v5/fine-parameters/v1";
const FINE_WINDOW_DECODE_TOLERANCE_MS = 50;

export interface RealMediaBlindBatchExecutionMedia {
  mediaId: string;
  path: string;
  contentIdentity: MediaContentIdentity;
  audioStreamIndex: number;
  videoStreamIndex: number | null;
}

export interface RealMediaBlindBatchPairRegistration {
  pairOrdinal: number;
  sourceMediaId: string;
  targetMediaId: string;
}

export type RealMediaBlindBatchVersionGroupSide = "source" | "target";

export interface RealMediaBlindBatchVersionReuseGroup {
  groupId: string;
  side: RealMediaBlindBatchVersionGroupSide;
  mediaIds: string[];
}

export interface RealMediaBlindBatchVersionReuseGroupSnapshot extends RealMediaBlindBatchVersionReuseGroup {
  groupOrdinal: number;
}

export interface RealMediaBlindBatchAlignmentParameters {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  sampleRate: number | null;
  windowMs: number | null;
  matchThreshold: number | null;
  minGapMs: number | null;
  maxCells: number | null;
  enableVisualEvidence: boolean;
  visualSampleIntervalMs: number | null;
}

/**
 * Execution-only suite. Its exact-key schema deliberately has no gold, reviewer, split, label,
 * expected relation or expected TimeMap field. Gold evaluation must happen after a path-free
 * native receipt has crossed this contract boundary.
 */
export interface RealMediaBlindBatchExecutionSuite {
  schemaVersion: typeof REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION;
  suiteId: string;
  datasetVersion: string;
  topK: number;
  sources: RealMediaBlindBatchExecutionMedia[];
  targets: RealMediaBlindBatchExecutionMedia[];
  pairs: RealMediaBlindBatchPairRegistration[];
  versionReuseGroups: RealMediaBlindBatchVersionReuseGroup[];
  parameters: RealMediaBlindBatchAlignmentParameters;
}

export type NativeBatchPairingMode = "fullCartesian" | "explicit";
export type NativeBatchGlobalSelectionState =
  "pending" | "selected" | "blocked" | "failed" | "cancelled";

export interface NativeBatchGlobalCandidateEvidence {
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

export interface NativeBatchGlobalSelectionEvidence {
  state: NativeBatchGlobalSelectionState;
  selected: boolean;
  selectedRank: number | null;
  selectedScore: number | null;
  decisionRank: number | null;
  decisionScore: number | null;
  margin: number | null;
  candidateCount: number;
  eligibleCandidateCount: number;
  topK: NativeBatchGlobalCandidateEvidence[];
  decisionCandidate: NativeBatchGlobalCandidateEvidence | null;
}

export type NativeBatchRelationRankingState =
  "pending" | "ranked" | "noEligibleCandidate" | "failed" | "cancelled";

export interface NativeBatchRelationCandidateEvidence {
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

export interface NativeBatchSpectralBackendExecutionIdentity {
  backendId: string;
  requestedBackend: string;
  backendDetail: string;
  fallbackReason: string | null;
}

export interface NativeBatchFineCandidateId {
  pairOrdinal: number;
  candidateOrdinal: number;
}

export interface NativeBatchFineInventoryCandidate {
  id: NativeBatchFineCandidateId;
  coarseUpperBoundMicros: number;
  sourceAxisReuseGroupOrdinal: number | null;
  targetAxisReuseGroupOrdinal: number | null;
  members: NativeBatchRelationCandidateEvidence[];
}

export interface NativeBatchFineStateCounts {
  unresolved: number;
  scored: number;
  evaluatedIneligible: number;
  evidenceBlocked: number;
  resourceBlocked: number;
  infrastructureFailed: number;
  cancelled: number;
}

export interface NativeBatchFineAssignment {
  candidateIds: NativeBatchFineCandidateId[];
  totalScoreMicros: number;
}

export interface NativeBatchFineOmittedAssignment {
  candidateIds: NativeBatchFineCandidateId[];
  totalUpperBoundMicros: number;
  openCandidateIds: NativeBatchFineCandidateId[];
  unresolvedCandidateIds: NativeBatchFineCandidateId[];
  blockedCandidateIds: NativeBatchFineCandidateId[];
}

export interface NativeBatchFineLimits {
  maxCandidates: number;
  maxSearchStates: number;
  maxSearchExpansions: number;
  maxIntervalComparisons: number;
  maxIntervalsPerAxis: number;
  maxTotalIntervals: number;
  refinementBatchSize: number;
}

export interface NativeBatchFineFrontierReceipt {
  contractVersion: typeof REAL_MEDIA_BLIND_BATCH_FINE_FRONTIER_CONTRACT_VERSION;
  scoreVersion: typeof REAL_MEDIA_BLIND_BATCH_FINE_SCORE_VERSION;
  inventoryDigest: `sha256:${string}`;
  inventoryCandidates: NativeBatchFineInventoryCandidate[];
  receiptDigest: `sha256:${string}`;
  componentOrdinal: number;
  componentPairOrdinals: number[];
  inventoryCandidateCount: number;
  resolutionMarginMicros: number;
  overlapToleranceMs: number;
  limits: NativeBatchFineLimits;
  inventoryStateCounts: NativeBatchFineStateCounts;
  refinementRoundCount: number;
  evaluatedCandidateCount: number;
  finalState: "resolved" | "noEligibleCandidate" | "unresolved" | "failed";
  resolved: boolean;
  selectedCandidateIds: NativeBatchFineCandidateId[];
  selectedTotalScoreMicros: number | null;
  bestCompleted: NativeBatchFineAssignment;
  runnerUpCompleted: NativeBatchFineAssignment | null;
  optimisticOmitted: NativeBatchFineOmittedAssignment | null;
  nextRefinementCandidateIds: NativeBatchFineCandidateId[];
  deferredCandidateCount: number;
  proof: {
    beatsRunnerUpWithMargin: boolean;
    beatsOptimisticOmittedWithMargin: boolean;
  };
  search: {
    statesVisited: number;
    expansionsConsidered: number;
    intervalComparisons: number;
  };
}

export interface NativeBatchFineDecodeWindow {
  startMs: number;
  endMs: number;
  presentationOffsetMs: number;
  sampleRate: number;
  expectedSampleCount: number;
  actualDecodedSampleCount: number | null;
}

export interface NativeBatchFineExecutionEvidence {
  candidateId: NativeBatchFineCandidateId;
  selectedMemberRank: number;
  groupMemberRanks: number[];
  sourceStreamIndex: number;
  targetStreamIndex: number;
  sourceCoarseBackend: NativeBatchSpectralBackendExecutionIdentity;
  targetCoarseBackend: NativeBatchSpectralBackendExecutionIdentity;
  sourceFineBackend: NativeBatchSpectralBackendExecutionIdentity;
  targetFineBackend: NativeBatchSpectralBackendExecutionIdentity;
  sourceRequestedWindow: NativeBatchFineDecodeWindow;
  targetRequestedWindow: NativeBatchFineDecodeWindow;
  sourceEffectiveWindow: NativeBatchFineDecodeWindow;
  targetEffectiveWindow: NativeBatchFineDecodeWindow;
  parametersHash: `sha256:${string}`;
  occupancyDigest: `sha256:${string}`;
  proposalTimeMapDigest: `sha256:${string}`;
  scoreMicros: number;
  evidenceDigest: `sha256:${string}`;
}

export interface NativeBatchExecutionIdentity {
  schemaVersion: typeof REAL_MEDIA_BLIND_BATCH_EXECUTION_IDENTITY_SCHEMA_VERSION;
  engineVersion: string;
  featureVersion: string;
  relationScoreVersion: typeof REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION;
  nativeExecutableDigest: `sha256:${string}`;
  ffmpegBinaryDigest: `sha256:${string}`;
  ffprobeBinaryDigest: `sha256:${string}`;
  sourceSpectralBackends: NativeBatchSpectralBackendExecutionIdentity[];
  targetSpectralBackends: NativeBatchSpectralBackendExecutionIdentity[];
}

export interface NativeBatchRelationRankingEvidence {
  scoreVersion: typeof REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION;
  executionIdentityDigest: `sha256:${string}` | null;
  executionIdentity: NativeBatchExecutionIdentity | null;
  state: NativeBatchRelationRankingState;
  candidateCount: number;
  eligibleCandidateCount: number;
  score: number | null;
  bestEligibleCandidate: NativeBatchRelationCandidateEvidence | null;
}

export type RealMediaBlindBatchPairFailureCode = "native-pair-failed" | "native-pair-cancelled";

export interface RealMediaBlindBatchPairOutcome {
  pairIndex: number;
  pairOrdinal: number;
  sourceMediaId: string;
  targetMediaId: string;
  nativeStatus: "completed" | "failed" | "cancelled";
  failureCode: RealMediaBlindBatchPairFailureCode | null;
  /** Pair-intrinsic coarse relation score; independent of tile-local conflicts and fine budget. */
  relationRanking: NativeBatchRelationRankingEvidence;
  /** Native N×M coarse shortlist membership only; never a gold-aware relationship verdict. */
  globalSelected: boolean;
  globalSelection: NativeBatchGlobalSelectionEvidence;
  fineFrontier: NativeBatchFineFrontierReceipt | null;
  fineExecutionEvidence: NativeBatchFineExecutionEvidence | null;
  proposalTimeMap: AlignmentTimeMapProposal | null;
}

export interface RealMediaBlindBatchRankedCandidate {
  relationRank: number;
  pairOrdinal: number;
  targetMediaId: string;
  nativeStatus: "completed" | "failed" | "cancelled";
  /** Mirrors native coarse shortlist membership, not final relation truth. */
  globalSelected: boolean;
  decisionScore: number | null;
  pairLocalScore: number | null;
  margin: number | null;
  qualityLevel: string | null;
}

export interface RealMediaBlindBatchSourceRanking {
  sourceMediaId: string;
  candidates: RealMediaBlindBatchRankedCandidate[];
  topK: RealMediaBlindBatchRankedCandidate[];
}

export interface RealMediaBlindBatchTargetRankedCandidate {
  relationRank: number;
  pairOrdinal: number;
  sourceMediaId: string;
  nativeStatus: "completed" | "failed" | "cancelled";
  /** Mirrors native coarse shortlist membership, not final relation truth. */
  globalSelected: boolean;
  decisionScore: number | null;
  pairLocalScore: number | null;
  margin: number | null;
  qualityLevel: string | null;
}

export interface RealMediaBlindBatchTargetRanking {
  targetMediaId: string;
  candidates: RealMediaBlindBatchTargetRankedCandidate[];
  topK: RealMediaBlindBatchTargetRankedCandidate[];
}

export type RealMediaBlindBatchRunStatus =
  "completed" | "completed-with-errors" | "failed" | "cancelled" | "timed-out";

export interface RealMediaBlindBatchRunReceipt {
  schemaVersion: typeof REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION;
  receiptKind: "c137-real-media-blind-batch-run";
  runnerVersion: typeof REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION;
  suiteId: string;
  datasetVersion: string;
  executionDigest: `sha256:${string}`;
  /** Exact actual scoring identity shared by every completed matrix cell in this receipt. */
  executionIdentityDigest: `sha256:${string}` | null;
  nativeJobId: string;
  nativeEvidenceVersion: typeof REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION;
  pairingMode: "fullCartesian";
  status: RealMediaBlindBatchRunStatus;
  terminationReason: "native-terminal" | "abort-signal" | "job-timeout";
  wallElapsedMs: number;
  sourceCount: number;
  targetCount: number;
  pairCount: number;
  topK: number;
  versionReuseGroups: RealMediaBlindBatchVersionReuseGroupSnapshot[];
  /**
   * Complete source-major partition of the execution space. Every pair retains native selection
   * evidence and its V2 TimeMap, so a later gold-aware domain compiler can reproduce relation
   * decisions without treating the native coarse `selected` bit as the final relationship label.
   */
  pairOutcomes: RealMediaBlindBatchPairOutcome[];
  sourceRankings: RealMediaBlindBatchSourceRanking[];
  targetRankings: RealMediaBlindBatchTargetRanking[];
  /** Public, unkeyed self-consistency checksum. This is not a signature or native authority. */
  receiptDigest: `sha256:${string}`;
}

export function createRealMediaBlindBatchExecutionDigest(value: unknown): `sha256:${string}` {
  const suite = validateRealMediaBlindBatchExecutionSuite(value);
  return `sha256:${sha256Hex(canonicalJson(suite))}`;
}

export function createNativeBatchExecutionIdentityDigest(
  identity: NativeBatchExecutionIdentity
): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(identity))}`;
}

export function createNativeBatchFineFrontierReceiptDigest(
  receipt: NativeBatchFineFrontierReceipt
): `sha256:${string}` {
  return createNativeBatchFineV3Digest(FINE_FRONTIER_RECEIPT_DIGEST_DOMAIN, {
    ...receipt,
    receiptDigest: ""
  });
}

export function createNativeBatchFineInventoryDigest(
  candidates: readonly NativeBatchFineInventoryCandidate[]
): `sha256:${string}` {
  return createNativeBatchFineV3Digest(FINE_FRONTIER_INVENTORY_DIGEST_DOMAIN, candidates);
}

export function createNativeBatchFineExecutionEvidenceDigest(
  evidence: NativeBatchFineExecutionEvidence
): `sha256:${string}` {
  return createNativeBatchFineV3Digest(FINE_EXECUTION_EVIDENCE_DIGEST_DOMAIN, {
    ...evidence,
    evidenceDigest: ""
  });
}

export function createNativeBatchFineProposalTimeMapDigest(
  timeMap: AlignmentTimeMapProposal
): `sha256:${string}` {
  return createNativeBatchFineV3Digest(FINE_PROPOSAL_TIME_MAP_DIGEST_DOMAIN, timeMap);
}

export function createNativeBatchFineParametersHash(
  engineVersion: string,
  featureVersion: string,
  legacyParametersHash: string
): `sha256:${string}` {
  return createNativeBatchFineV3Digest(FINE_PARAMETERS_DIGEST_DOMAIN, {
    engineVersion,
    featureVersion,
    fineScoreVersion: REAL_MEDIA_BLIND_BATCH_FINE_SCORE_VERSION,
    legacyParametersHash
  });
}

function createNativeBatchFineV3Digest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(`${domain}\n${canonicalFineV3Json(value)}`)}`;
}

function canonicalFineV3Json(value: unknown): string {
  return JSON.stringify(canonicalizeFineV3Value(value));
}

function canonicalizeFineV3Value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeFineV3Value);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalizeFineV3Value(nested)])
    );
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("fine v3 canonical JSON 不接受非有限数值。");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("fine v3 canonical JSON 不接受超出安全范围的整数。");
    }
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, value, false);
    return `f64:${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  throw new Error("fine v3 canonical JSON 不接受 undefined、函数或 symbol。");
}

export function deriveRealMediaBlindBatchReceiptExecutionIdentityDigest(
  pairOutcomes: readonly RealMediaBlindBatchPairOutcome[]
): `sha256:${string}` | null {
  if (pairOutcomes.length === 0) return null;
  const first = pairOutcomes[0]?.relationRanking.executionIdentityDigest ?? null;
  if (
    first === null ||
    pairOutcomes.some((outcome) => outcome.relationRanking.executionIdentityDigest !== first)
  ) {
    return null;
  }
  return first;
}

/**
 * Public, unkeyed integrity checksum only. Anyone who can construct a receipt can recompute this
 * digest, so it proves canonical self-consistency but never native origin or release authority.
 */
export function createRealMediaBlindBatchRunReceiptDigest(
  receipt: Omit<RealMediaBlindBatchRunReceipt, "receiptDigest">
): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(receipt))}`;
}

/**
 * Strict injection boundary for a later gold-aware compiler. Validation deliberately recomputes
 * all derived rankings from complete pair outcomes instead of trusting serialized ranking arrays.
 * A passing receipt remains untrusted self-consistent evidence: this validator does not attest
 * that `nativeJobId` existed and the public digest is not a signature or trust root.
 */
export function validateRealMediaBlindBatchRunReceipt(
  value: unknown,
  executionSuite: unknown
): RealMediaBlindBatchRunReceipt {
  const suite = validateRealMediaBlindBatchExecutionSuite(executionSuite);
  const receipt = requireExactRecord(
    value,
    [
      "schemaVersion",
      "receiptKind",
      "runnerVersion",
      "suiteId",
      "datasetVersion",
      "executionDigest",
      "executionIdentityDigest",
      "nativeJobId",
      "nativeEvidenceVersion",
      "pairingMode",
      "status",
      "terminationReason",
      "wallElapsedMs",
      "sourceCount",
      "targetCount",
      "pairCount",
      "topK",
      "versionReuseGroups",
      "pairOutcomes",
      "sourceRankings",
      "targetRankings",
      "receiptDigest"
    ],
    "blind batch run receipt"
  );
  if (
    receipt.schemaVersion !== REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION ||
    receipt.receiptKind !== "c137-real-media-blind-batch-run" ||
    receipt.runnerVersion !== REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION
  ) {
    throw new Error("blind batch run receipt schema/kind/runnerVersion 无效。");
  }
  if (receipt.suiteId !== suite.suiteId || receipt.datasetVersion !== suite.datasetVersion) {
    throw new Error("blind batch run receipt 与 execution suite 身份不一致。");
  }
  const executionDigest = requireSha256Digest(receipt.executionDigest, "executionDigest");
  if (executionDigest !== createRealMediaBlindBatchExecutionDigest(suite)) {
    throw new Error("blind batch run receipt executionDigest 与 canonical suite 不一致。");
  }
  const declaredExecutionIdentityDigest =
    receipt.executionIdentityDigest === null
      ? null
      : requireSha256Digest(receipt.executionIdentityDigest, "executionIdentityDigest");
  const nativeJobId = requireNonBlankString(receipt.nativeJobId, "nativeJobId");
  if (
    receipt.nativeEvidenceVersion !== REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION ||
    receipt.pairingMode !== "fullCartesian"
  ) {
    throw new Error(
      `blind batch run receipt 缺少 fullCartesian native evidence v${REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION} 绑定。`
    );
  }
  const status = validateReceiptRunStatus(receipt.status);
  const terminationReason = validateReceiptTerminationReason(receipt.terminationReason);
  validateReceiptStatusTerminationCoherence(status, terminationReason);
  const wallElapsedMs = requireNonNegativeSafeInteger(receipt.wallElapsedMs, "wallElapsedMs");
  if (
    receipt.sourceCount !== suite.sources.length ||
    receipt.targetCount !== suite.targets.length ||
    receipt.pairCount !== suite.pairs.length ||
    receipt.topK !== suite.topK
  ) {
    throw new Error("blind batch run receipt 的 source/target/pair/topK 计数与 suite 不一致。");
  }
  const versionReuseGroups = validateVersionReuseGroupSnapshots(
    receipt.versionReuseGroups,
    suite.versionReuseGroups,
    "blind batch run receipt.versionReuseGroups"
  );
  if (
    !Array.isArray(receipt.pairOutcomes) ||
    receipt.pairOutcomes.length !== suite.pairs.length
  ) {
    throw new Error("blind batch run receipt pairOutcomes 不完整。");
  }
  const pairOutcomes = receipt.pairOutcomes.map((outcome, index) =>
    validateReceiptPairOutcome(outcome, index, suite)
  );
  validateReceiptFineComponentCoherence(pairOutcomes);
  validateReceiptRunOutcomeCoherence(status, pairOutcomes);
  const executionIdentityDigest =
    deriveRealMediaBlindBatchReceiptExecutionIdentityDigest(pairOutcomes);
  if (declaredExecutionIdentityDigest !== executionIdentityDigest) {
    throw new Error(
      "blind batch run receipt executionIdentityDigest 未精确绑定全部 pair 的实际 scoring identity。"
    );
  }
  if (status === "completed" && executionIdentityDigest === null) {
    throw new Error("completed blind batch receipt 必须只有一个统一 executionIdentityDigest。");
  }
  const sourceRankings = suite.sources.map((source) =>
    createRealMediaBlindBatchSourceRanking(source.mediaId, pairOutcomes, suite.topK)
  );
  const targetRankings = suite.targets.map((target) =>
    createRealMediaBlindBatchTargetRanking(
      target.mediaId,
      pairOutcomes,
      Math.min(suite.topK, suite.sources.length)
    )
  );
  assertCanonicalEqual(
    receipt.sourceRankings,
    sourceRankings,
    "blind batch run receipt sourceRankings 顺序、字段或内容不闭合。"
  );
  assertCanonicalEqual(
    receipt.targetRankings,
    targetRankings,
    "blind batch run receipt targetRankings 顺序、字段或内容不闭合。"
  );
  const receiptDigest = requireSha256Digest(receipt.receiptDigest, "receiptDigest");
  const withoutDigest: Omit<RealMediaBlindBatchRunReceipt, "receiptDigest"> = {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
    receiptKind: "c137-real-media-blind-batch-run",
    runnerVersion: REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
    suiteId: suite.suiteId,
    datasetVersion: suite.datasetVersion,
    executionDigest,
    executionIdentityDigest,
    nativeJobId,
    nativeEvidenceVersion: REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
    pairingMode: "fullCartesian",
    status,
    terminationReason,
    wallElapsedMs,
    sourceCount: suite.sources.length,
    targetCount: suite.targets.length,
    pairCount: suite.pairs.length,
    topK: suite.topK,
    versionReuseGroups,
    pairOutcomes,
    sourceRankings,
    targetRankings
  };
  if (receiptDigest !== createRealMediaBlindBatchRunReceiptDigest(withoutDigest)) {
    throw new Error("blind batch run receiptDigest 与 canonical receipt 内容不一致。");
  }
  const validated: RealMediaBlindBatchRunReceipt = { ...withoutDigest, receiptDigest };
  assertRealMediaBlindBatchReceiptIsPathFree(validated, suite);
  return validated;
}

export function validateRealMediaBlindBatchExecutionSuite(
  value: unknown
): RealMediaBlindBatchExecutionSuite {
  const suite = requireExactRecord(
    value,
    [
      "schemaVersion",
      "suiteId",
      "datasetVersion",
      "topK",
      "sources",
      "targets",
      "pairs",
      "versionReuseGroups",
      "parameters"
    ],
    "blind batch execution suite"
  );
  if (suite.schemaVersion !== REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION) {
    throw new Error("blind batch execution suite schemaVersion 无效。");
  }
  const suiteId = requireIdentifier(suite.suiteId, "suiteId");
  const datasetVersion = requireIdentifier(suite.datasetVersion, "datasetVersion");
  const sources = validateExecutionMediaArray(suite.sources, "sources");
  const targets = validateExecutionMediaArray(suite.targets, "targets");
  const pairCount = sources.length * targets.length;
  if (pairCount <= 1) {
    throw new Error("blind batch execution suite 必须包含多个 pair，拒绝 single-pair suite。");
  }
  if (pairCount > 256) {
    throw new Error("blind batch execution suite 最多允许 256 个全笛卡尔 pair。");
  }
  const topK = requirePositiveSafeInteger(suite.topK, "topK");
  if (topK > Math.max(sources.length, targets.length)) {
    throw new Error("blind batch execution suite.topK 不能超过任一关系查询轴的最大候选数。");
  }
  const parameters = validateAlignmentParameters(suite.parameters);
  ensureDistinctExecutionMedia(sources, targets, parameters.enableVisualEvidence);
  const pairs = validateFullCartesianPairs(suite.pairs, sources, targets);
  const versionReuseGroups = validateVersionReuseGroups(
    suite.versionReuseGroups,
    sources,
    targets
  );
  return {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
    suiteId,
    datasetVersion,
    topK,
    sources,
    targets,
    pairs,
    versionReuseGroups,
    parameters
  };
}

/** Shared strict parser used both at the native snapshot boundary and receipt reinjection. */
export function validateRealMediaBlindBatchGlobalSelectionEvidence(
  value: unknown,
  pairStatus: "queued" | "running" | "completed" | "failed" | "cancelled",
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  label: string
): NativeBatchGlobalSelectionEvidence {
  const evidence = requireExactRecord(
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
    `${label}.globalSelection`
  );
  if (
    evidence.state !== "pending" &&
    evidence.state !== "selected" &&
    evidence.state !== "blocked" &&
    evidence.state !== "failed" &&
    evidence.state !== "cancelled"
  ) {
    throw new Error(`${label}.globalSelection.state 无效。`);
  }
  if (typeof evidence.selected !== "boolean") {
    throw new Error(`${label}.globalSelection.selected 必须是 boolean。`);
  }
  const selectedRank = requirePositiveSafeIntegerOrNull(
    evidence.selectedRank,
    `${label}.selectedRank`
  );
  const selectedScore = requireFiniteNumberOrNull(
    evidence.selectedScore,
    `${label}.selectedScore`
  );
  const decisionRank = requirePositiveSafeIntegerOrNull(
    evidence.decisionRank,
    `${label}.decisionRank`
  );
  const decisionScore = requireFiniteNumberOrNull(
    evidence.decisionScore,
    `${label}.decisionScore`
  );
  const margin = requireUnitNumberOrNull(evidence.margin, `${label}.margin`);
  const candidateCount = requireNonNegativeSafeInteger(
    evidence.candidateCount,
    `${label}.candidateCount`
  );
  const eligibleCandidateCount = requireNonNegativeSafeInteger(
    evidence.eligibleCandidateCount,
    `${label}.eligibleCandidateCount`
  );
  if (eligibleCandidateCount > candidateCount) {
    throw new Error(`${label}.eligibleCandidateCount 超过 candidateCount。`);
  }
  if (!Array.isArray(evidence.topK)) throw new Error(`${label}.topK 必须是数组。`);
  if (evidence.topK.length !== Math.min(NATIVE_BATCH_TOP_K_LIMIT, candidateCount)) {
    throw new Error(`${label}.topK 数量没有覆盖 native 确定性 Top-K。`);
  }
  const topK = evidence.topK.map((candidate, index) =>
    validateGlobalCandidateEvidence(candidate, index + 1, candidateCount, source, target, label)
  );
  const decisionCandidate =
    evidence.decisionCandidate === null
      ? null
      : validateGlobalCandidateEvidence(
          evidence.decisionCandidate,
          decisionRank,
          candidateCount,
          source,
          target,
          `${label}.decisionCandidate`
        );
  const state = evidence.state;
  if (state === "selected") {
    if (
      !evidence.selected ||
      selectedRank === null ||
      selectedScore === null ||
      decisionRank !== selectedRank ||
      decisionScore !== selectedScore ||
      decisionCandidate === null ||
      decisionCandidate.rank !== selectedRank ||
      decisionCandidate.globalScore !== selectedScore ||
      !decisionCandidate.eligible ||
      !decisionCandidate.globalSelected
    ) {
      throw new Error(`${label} selected globalSelection 内部不自洽。`);
    }
  } else if (evidence.selected || selectedRank !== null || selectedScore !== null) {
    throw new Error(
      `${label} 非 selected globalSelection 不得声明 selectedRank/selectedScore。`
    );
  }
  if (
    (decisionRank === null) !== (decisionScore === null) ||
    (decisionRank === null) !== (decisionCandidate === null)
  ) {
    throw new Error(
      `${label} decisionRank/decisionScore/decisionCandidate 必须同时存在或同时为空。`
    );
  }
  if (decisionCandidate) {
    if (
      decisionCandidate.rank !== decisionRank ||
      decisionCandidate.globalScore !== decisionScore
    ) {
      throw new Error(`${label} decisionCandidate 与 decision rank/score 不一致。`);
    }
    if (decisionCandidate.rank <= topK.length) {
      assertCanonicalEqual(
        decisionCandidate,
        topK[decisionCandidate.rank - 1],
        `${label} decisionCandidate 与 Top-K 同 rank 候选不一致。`
      );
    }
  }
  const selectedTopK = topK.filter((candidate) => candidate.globalSelected);
  if (
    state === "selected" && selectedRank !== null && selectedRank <= topK.length
      ? selectedTopK.length !== 1 || selectedTopK[0]?.rank !== selectedRank
      : selectedTopK.length !== 0
  ) {
    throw new Error(`${label}.topK 的 globalSelected 标记不自洽。`);
  }
  if (
    (state === "pending" || state === "cancelled") &&
    (candidateCount !== 0 ||
      eligibleCandidateCount !== 0 ||
      topK.length !== 0 ||
      decisionCandidate !== null ||
      decisionRank !== null ||
      decisionScore !== null ||
      margin !== null)
  ) {
    throw new Error(`${label} ${state} evidence 不得公开候选证据。`);
  }
  if (
    pairStatus === "completed" &&
    state !== "selected" &&
    state !== "blocked" &&
    state !== "failed"
  ) {
    throw new Error(`${label} completed pair 的 coarse diagnostic state 无效。`);
  }
  return {
    state,
    selected: evidence.selected,
    selectedRank,
    selectedScore,
    decisionRank,
    decisionScore,
    margin,
    candidateCount,
    eligibleCandidateCount,
    topK,
    decisionCandidate
  };
}

export function validateRealMediaBlindBatchRelationRankingEvidence(
  value: unknown,
  pairStatus: "queued" | "running" | "completed" | "failed" | "cancelled",
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  label: string
): NativeBatchRelationRankingEvidence {
  const evidence = requireExactRecord(
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
    `${label}.relationRanking`
  );
  if (evidence.scoreVersion !== REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION) {
    throw new Error(`${label}.relationRanking.scoreVersion 无效。`);
  }
  const executionIdentityDigest =
    evidence.executionIdentityDigest === null
      ? null
      : requireSha256Digest(
          evidence.executionIdentityDigest,
          `${label}.relationRanking.executionIdentityDigest`
        );
  const executionIdentity =
    evidence.executionIdentity === null
      ? null
      : validateNativeBatchExecutionIdentity(
          evidence.executionIdentity,
          `${label}.relationRanking.executionIdentity`
        );
  if ((executionIdentityDigest === null) !== (executionIdentity === null)) {
    throw new Error(`${label}.relationRanking execution identity/digest 不成对。`);
  }
  if (
    executionIdentity !== null &&
    executionIdentityDigest !== createNativeBatchExecutionIdentityDigest(executionIdentity)
  ) {
    throw new Error(`${label}.relationRanking executionIdentityDigest 与内容不一致。`);
  }
  if (
    evidence.state !== "pending" &&
    evidence.state !== "ranked" &&
    evidence.state !== "noEligibleCandidate" &&
    evidence.state !== "failed" &&
    evidence.state !== "cancelled"
  ) {
    throw new Error(`${label}.relationRanking.state 无效。`);
  }
  const state = evidence.state;
  const candidateCount = requireNonNegativeSafeInteger(
    evidence.candidateCount,
    `${label}.relationRanking.candidateCount`
  );
  const eligibleCandidateCount = requireNonNegativeSafeInteger(
    evidence.eligibleCandidateCount,
    `${label}.relationRanking.eligibleCandidateCount`
  );
  if (eligibleCandidateCount > candidateCount) {
    throw new Error(`${label}.relationRanking eligibleCandidateCount 超过 candidateCount。`);
  }
  const score = requireFiniteNumberOrNull(evidence.score, `${label}.relationRanking.score`);
  const bestEligibleCandidate =
    evidence.bestEligibleCandidate === null
      ? null
      : validateRelationCandidateEvidence(
          evidence.bestEligibleCandidate,
          candidateCount,
          source,
          target,
          `${label}.relationRanking.bestEligibleCandidate`
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
      throw new Error(`${label} ranked relationRanking 内部不闭合。`);
    }
  } else if (state === "noEligibleCandidate") {
    if (
      eligibleCandidateCount !== 0 ||
      score !== null ||
      bestEligibleCandidate !== null ||
      executionIdentity === null
    ) {
      throw new Error(`${label} noEligibleCandidate relationRanking 夹带了候选或分数。`);
    }
  } else if (
    candidateCount !== 0 ||
    eligibleCandidateCount !== 0 ||
    score !== null ||
    bestEligibleCandidate !== null ||
    executionIdentity !== null
  ) {
    throw new Error(`${label} 非结果态 relationRanking 不得夹带候选证据。`);
  }

  if (
    (pairStatus === "completed" && state !== "ranked" && state !== "noEligibleCandidate") ||
    (pairStatus === "failed" &&
      state !== "failed" &&
      state !== "ranked" &&
      state !== "noEligibleCandidate") ||
    (pairStatus === "cancelled" && state !== "cancelled") ||
    ((pairStatus === "queued" || pairStatus === "running") && state !== "pending")
  ) {
    throw new Error(`${label} pair status 与 relationRanking.state 不一致。`);
  }
  return {
    scoreVersion: REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
    executionIdentityDigest,
    executionIdentity,
    state,
    candidateCount,
    eligibleCandidateCount,
    score,
    bestEligibleCandidate
  };
}

function validateNativeBatchExecutionIdentity(
  value: unknown,
  label: string
): NativeBatchExecutionIdentity {
  const identity = requireExactRecord(
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
  if (identity.schemaVersion !== REAL_MEDIA_BLIND_BATCH_EXECUTION_IDENTITY_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion 无效。`);
  }
  const engineVersion = requireNonBlankString(identity.engineVersion, `${label}.engineVersion`);
  const featureVersion = requireNonBlankString(
    identity.featureVersion,
    `${label}.featureVersion`
  );
  if (identity.relationScoreVersion !== REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION) {
    throw new Error(`${label}.relationScoreVersion 无效。`);
  }
  return {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_EXECUTION_IDENTITY_SCHEMA_VERSION,
    engineVersion,
    featureVersion,
    relationScoreVersion: REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
    nativeExecutableDigest: requireSha256Digest(
      identity.nativeExecutableDigest,
      `${label}.nativeExecutableDigest`
    ),
    ffmpegBinaryDigest: requireSha256Digest(
      identity.ffmpegBinaryDigest,
      `${label}.ffmpegBinaryDigest`
    ),
    ffprobeBinaryDigest: requireSha256Digest(
      identity.ffprobeBinaryDigest,
      `${label}.ffprobeBinaryDigest`
    ),
    sourceSpectralBackends: validateNativeBatchSpectralBackendIdentities(
      identity.sourceSpectralBackends,
      `${label}.sourceSpectralBackends`
    ),
    targetSpectralBackends: validateNativeBatchSpectralBackendIdentities(
      identity.targetSpectralBackends,
      `${label}.targetSpectralBackends`
    )
  };
}

function validateNativeBatchSpectralBackendIdentities(
  value: unknown,
  label: string
): NativeBatchSpectralBackendExecutionIdentity[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是非空 canonical backend 集合。`);
  }
  const identities = value.map((item, index) => {
    const backend = requireExactRecord(
      item,
      ["backendId", "requestedBackend", "backendDetail", "fallbackReason"],
      `${label}[${index}]`
    );
    const fallbackReason =
      backend.fallbackReason === null
        ? null
        : requireNonBlankString(backend.fallbackReason, `${label}[${index}].fallbackReason`);
    return {
      backendId: requireNonBlankString(backend.backendId, `${label}[${index}].backendId`),
      requestedBackend: requireNonBlankString(
        backend.requestedBackend,
        `${label}[${index}].requestedBackend`
      ),
      backendDetail: requireNonBlankString(
        backend.backendDetail,
        `${label}[${index}].backendDetail`
      ),
      fallbackReason
    };
  });
  const canonical = [...identities].sort(compareNativeBatchSpectralBackendIdentity);
  if (
    identities.some((item, index) => canonicalJson(item) !== canonicalJson(canonical[index])) ||
    identities.some(
      (item, index) => index > 0 && canonicalJson(item) === canonicalJson(identities[index - 1])
    )
  ) {
    throw new Error(`${label} 必须按实际 backend identity 排序且去重。`);
  }
  return identities;
}

function compareNativeBatchSpectralBackendIdentity(
  left: NativeBatchSpectralBackendExecutionIdentity,
  right: NativeBatchSpectralBackendExecutionIdentity
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

function validateRelationCandidateEvidence(
  value: unknown,
  candidateCount: number,
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  label: string
): NativeBatchRelationCandidateEvidence {
  const candidate = requireExactRecord(
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
  const rank = requirePositiveSafeInteger(candidate.rank, `${label}.rank`);
  if (rank > candidateCount) throw new Error(`${label}.rank 超过 candidateCount。`);
  const sourceStreamIndex = requireNonNegativeSafeInteger(
    candidate.sourceStreamIndex,
    `${label}.sourceStreamIndex`
  );
  const targetStreamIndex = requireNonNegativeSafeInteger(
    candidate.targetStreamIndex,
    `${label}.targetStreamIndex`
  );
  if (
    sourceStreamIndex !== source.audioStreamIndex ||
    targetStreamIndex !== target.audioStreamIndex
  ) {
    throw new Error(`${label} 的音轨索引与 execution suite 错配。`);
  }
  const score = requireFiniteNumber(candidate.score, `${label}.score`);
  const globalScore = requirePositiveFiniteNumber(
    candidate.globalScore,
    `${label}.globalScore`
  );
  const scale = requirePositiveFiniteNumber(candidate.scale, `${label}.scale`);
  const offsetMs = requireSafeInteger(candidate.offsetMs, `${label}.offsetMs`);
  const sourceStartMs = requireSafeInteger(candidate.sourceStartMs, `${label}.sourceStartMs`);
  const sourceEndMs = requireSafeInteger(candidate.sourceEndMs, `${label}.sourceEndMs`);
  const targetStartMs = requireSafeInteger(candidate.targetStartMs, `${label}.targetStartMs`);
  const targetEndMs = requireSafeInteger(candidate.targetEndMs, `${label}.targetEndMs`);
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的内容区间无效。`);
  }
  const inlierCount = requireNonNegativeSafeInteger(
    candidate.inlierCount,
    `${label}.inlierCount`
  );
  if (inlierCount < RELATION_MIN_INLIER_COUNT) {
    throw new Error(`${label}.inlierCount 未达到 intrinsic eligibility。`);
  }
  const temporalCoverage = requireUnitNumber(
    candidate.temporalCoverage,
    `${label}.temporalCoverage`
  );
  if (temporalCoverage < RELATION_MIN_TEMPORAL_COVERAGE) {
    throw new Error(`${label}.temporalCoverage 未达到 intrinsic eligibility。`);
  }
  const uniqueSourceCoverage = requireUnitNumber(
    candidate.uniqueSourceCoverage,
    `${label}.uniqueSourceCoverage`
  );
  return {
    rank,
    sourceStreamIndex,
    targetStreamIndex,
    score,
    globalScore,
    scale,
    offsetMs,
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs,
    inlierCount,
    temporalCoverage,
    uniqueSourceCoverage
  };
}

function validateFineInventoryMember(
  value: unknown,
  label: string
): NativeBatchRelationCandidateEvidence {
  const candidate = requireExactRecord(
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
  const sourceStartMs = requireSafeInteger(candidate.sourceStartMs, `${label}.sourceStartMs`);
  const sourceEndMs = requireSafeInteger(candidate.sourceEndMs, `${label}.sourceEndMs`);
  const targetStartMs = requireSafeInteger(candidate.targetStartMs, `${label}.targetStartMs`);
  const targetEndMs = requireSafeInteger(candidate.targetEndMs, `${label}.targetEndMs`);
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的内容区间无效。`);
  }
  const inlierCount = requireNonNegativeSafeInteger(
    candidate.inlierCount,
    `${label}.inlierCount`
  );
  const temporalCoverage = requireUnitNumber(
    candidate.temporalCoverage,
    `${label}.temporalCoverage`
  );
  return {
    rank: requirePositiveSafeInteger(candidate.rank, `${label}.rank`),
    sourceStreamIndex: requireNonNegativeSafeInteger(
      candidate.sourceStreamIndex,
      `${label}.sourceStreamIndex`
    ),
    targetStreamIndex: requireNonNegativeSafeInteger(
      candidate.targetStreamIndex,
      `${label}.targetStreamIndex`
    ),
    score: requireFiniteNumber(candidate.score, `${label}.score`),
    globalScore: requirePositiveFiniteNumber(candidate.globalScore, `${label}.globalScore`),
    scale: requirePositiveFiniteNumber(candidate.scale, `${label}.scale`),
    offsetMs: requireSafeInteger(candidate.offsetMs, `${label}.offsetMs`),
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs,
    inlierCount,
    temporalCoverage,
    uniqueSourceCoverage: requireUnitNumber(
      candidate.uniqueSourceCoverage,
      `${label}.uniqueSourceCoverage`
    )
  };
}

export function validateRealMediaBlindBatchProposalBinding(
  timeMap: AlignmentTimeMapProposal,
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  parameters: RealMediaBlindBatchAlignmentParameters,
  pairOrdinal: number
): void {
  if (
    !timeMap.engineVersion.toLowerCase().includes("alignment-v2") ||
    !timeMap.featureVersion.trim() ||
    !timeMap.parametersHash.trim()
  ) {
    throw new Error(`native pair #${pairOrdinal} proposal 不是可复核的 Alignment V2 工件。`);
  }
  if (
    !areMediaContentIdentitiesEqual(source.contentIdentity, timeMap.sourceIdentity) ||
    !areMediaContentIdentitiesEqual(target.contentIdentity, timeMap.targetIdentity)
  ) {
    throw new Error(`native pair #${pairOrdinal} proposal 媒体身份错配。`);
  }
  if (
    timeMap.sourceStream?.type !== "audio" ||
    timeMap.sourceStream.index !== source.audioStreamIndex ||
    timeMap.targetStream?.type !== "audio" ||
    timeMap.targetStream.index !== target.audioStreamIndex
  ) {
    throw new Error(`native pair #${pairOrdinal} proposal 音轨索引错配。`);
  }
  validateVisualStreamBinding(
    timeMap.sourceVisualStream,
    source.videoStreamIndex,
    parameters.enableVisualEvidence,
    `native pair #${pairOrdinal} source visual stream`
  );
  validateVisualStreamBinding(
    timeMap.targetVisualStream,
    target.videoStreamIndex,
    parameters.enableVisualEvidence,
    `native pair #${pairOrdinal} target visual stream`
  );
}

export function assertRealMediaBlindBatchDecisionCandidateMatchesTimeMap(
  candidate: NativeBatchGlobalCandidateEvidence,
  timeMap: AlignmentTimeMapProposal,
  pairOrdinal: number
): void {
  if (
    timeMap.sourceStream?.index !== candidate.sourceStreamIndex ||
    timeMap.targetStream?.index !== candidate.targetStreamIndex
  ) {
    throw new Error(`native pair #${pairOrdinal} decision candidate 与 proposal 音轨错配。`);
  }
}

function validateGlobalCandidateEvidence(
  value: unknown,
  expectedRank: number | null,
  candidateCount: number,
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  label: string
): NativeBatchGlobalCandidateEvidence {
  const candidate = requireExactRecord(
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
  const rank = requirePositiveSafeInteger(candidate.rank, `${label}.rank`);
  if (expectedRank !== null && rank !== expectedRank) {
    throw new Error(`${label}.rank 不是连续的确定性候选序号。`);
  }
  if (rank > candidateCount) throw new Error(`${label}.rank 超过 candidateCount。`);
  const sourceStreamIndex = requireNonNegativeSafeInteger(
    candidate.sourceStreamIndex,
    `${label}.sourceStreamIndex`
  );
  const targetStreamIndex = requireNonNegativeSafeInteger(
    candidate.targetStreamIndex,
    `${label}.targetStreamIndex`
  );
  if (
    sourceStreamIndex !== source.audioStreamIndex ||
    targetStreamIndex !== target.audioStreamIndex
  ) {
    throw new Error(`${label} 的音轨索引与 execution suite 错配。`);
  }
  const score = requireFiniteNumber(candidate.score, `${label}.score`);
  const globalScore = requireFiniteNumber(candidate.globalScore, `${label}.globalScore`);
  const scale = requirePositiveFiniteNumber(candidate.scale, `${label}.scale`);
  const offsetMs = requireSafeInteger(candidate.offsetMs, `${label}.offsetMs`);
  const sourceStartMs = requireSafeInteger(candidate.sourceStartMs, `${label}.sourceStartMs`);
  const sourceEndMs = requireSafeInteger(candidate.sourceEndMs, `${label}.sourceEndMs`);
  const targetStartMs = requireSafeInteger(candidate.targetStartMs, `${label}.targetStartMs`);
  const targetEndMs = requireSafeInteger(candidate.targetEndMs, `${label}.targetEndMs`);
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的内容区间无效。`);
  }
  const inlierCount = requireNonNegativeSafeInteger(
    candidate.inlierCount,
    `${label}.inlierCount`
  );
  const temporalCoverage = requireUnitNumber(
    candidate.temporalCoverage,
    `${label}.temporalCoverage`
  );
  const uniqueSourceCoverage = requireUnitNumber(
    candidate.uniqueSourceCoverage,
    `${label}.uniqueSourceCoverage`
  );
  if (
    typeof candidate.eligible !== "boolean" ||
    typeof candidate.globalSelected !== "boolean"
  ) {
    throw new Error(`${label} eligible/globalSelected 必须是 boolean。`);
  }
  if (candidate.globalSelected && !candidate.eligible) {
    throw new Error(`${label} globalSelected candidate 必须 eligible。`);
  }
  return {
    rank,
    sourceStreamIndex,
    targetStreamIndex,
    score,
    globalScore,
    scale,
    offsetMs,
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs,
    inlierCount,
    temporalCoverage,
    uniqueSourceCoverage,
    eligible: candidate.eligible,
    globalSelected: candidate.globalSelected
  };
}

function validateReceiptFineFrontier(
  value: unknown,
  label: string,
  suite: RealMediaBlindBatchExecutionSuite
): NativeBatchFineFrontierReceipt {
  const pairCount = suite.pairs.length;
  const frontier = requireExactRecord(
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
  if (
    frontier.contractVersion !== REAL_MEDIA_BLIND_BATCH_FINE_FRONTIER_CONTRACT_VERSION ||
    frontier.scoreVersion !== REAL_MEDIA_BLIND_BATCH_FINE_SCORE_VERSION
  ) {
    throw new Error(`${label} contractVersion/scoreVersion 无效。`);
  }
  const inventoryDigest = requireSha256Digest(
    frontier.inventoryDigest,
    `${label}.inventoryDigest`
  );
  const receiptDigest = requireSha256Digest(frontier.receiptDigest, `${label}.receiptDigest`);
  const componentOrdinal = requirePositiveSafeInteger(
    frontier.componentOrdinal,
    `${label}.componentOrdinal`
  );
  if (componentOrdinal > pairCount) throw new Error(`${label}.componentOrdinal 越界。`);
  const componentPairOrdinals = requireFineIntegerArray(
    frontier.componentPairOrdinals,
    `${label}.componentPairOrdinals`,
    1,
    pairCount,
    true
  );
  if (componentPairOrdinals.length === 0) {
    throw new Error(`${label}.componentPairOrdinals 不能为空。`);
  }
  const inventoryCandidateCount = requireNonNegativeSafeInteger(
    frontier.inventoryCandidateCount,
    `${label}.inventoryCandidateCount`
  );
  const inventoryCandidates = validateReceiptFineInventoryCandidates(
    frontier.inventoryCandidates,
    `${label}.inventoryCandidates`,
    componentPairOrdinals,
    suite
  );
  if (inventoryCandidates.length !== inventoryCandidateCount) {
    throw new Error(`${label}.inventoryCandidates 未完整枚举 inventoryCandidateCount。`);
  }
  if (createNativeBatchFineInventoryDigest(inventoryCandidates) !== inventoryDigest) {
    throw new Error(`${label}.inventoryDigest 与完整候选清单不一致。`);
  }
  const resolutionMarginMicros = requirePositiveSafeInteger(
    frontier.resolutionMarginMicros,
    `${label}.resolutionMarginMicros`
  );
  const overlapToleranceMs = requireNonNegativeSafeInteger(
    frontier.overlapToleranceMs,
    `${label}.overlapToleranceMs`
  );
  const limits = validateReceiptFineLimits(frontier.limits, `${label}.limits`);
  if (inventoryCandidateCount > limits.maxCandidates) {
    throw new Error(`${label}.inventoryCandidateCount 超过 maxCandidates。`);
  }
  const inventoryStateCounts = validateReceiptFineStateCounts(
    frontier.inventoryStateCounts,
    `${label}.inventoryStateCounts`
  );
  if (
    inventoryStateCounts.unresolved +
      inventoryStateCounts.scored +
      inventoryStateCounts.evaluatedIneligible +
      inventoryStateCounts.evidenceBlocked +
      inventoryStateCounts.resourceBlocked +
      inventoryStateCounts.infrastructureFailed +
      inventoryStateCounts.cancelled !==
    inventoryCandidateCount
  ) {
    throw new Error(`${label}.inventoryStateCounts 未完整划分库存。`);
  }
  const refinementRoundCount = requireNonNegativeSafeInteger(
    frontier.refinementRoundCount,
    `${label}.refinementRoundCount`
  );
  const evaluatedCandidateCount = requireNonNegativeSafeInteger(
    frontier.evaluatedCandidateCount,
    `${label}.evaluatedCandidateCount`
  );
  if (evaluatedCandidateCount > inventoryCandidateCount) {
    throw new Error(`${label}.evaluatedCandidateCount 超过库存。`);
  }
  const finalState = requireFineFrontierState(frontier.finalState, `${label}.finalState`);
  if (
    typeof frontier.resolved !== "boolean" ||
    frontier.resolved !== (finalState === "resolved")
  ) {
    throw new Error(`${label}.resolved 与 finalState 不一致。`);
  }
  const selectedCandidateIds = validateFineCandidateIds(
    frontier.selectedCandidateIds,
    `${label}.selectedCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const selectedTotalScoreMicros = requireNonNegativeSafeIntegerOrNull(
    frontier.selectedTotalScoreMicros,
    `${label}.selectedTotalScoreMicros`
  );
  const bestCompleted = validateReceiptFineAssignment(
    frontier.bestCompleted,
    `${label}.bestCompleted`,
    componentPairOrdinals
  );
  const runnerUpCompleted =
    frontier.runnerUpCompleted === null
      ? null
      : validateReceiptFineAssignment(
          frontier.runnerUpCompleted,
          `${label}.runnerUpCompleted`,
          componentPairOrdinals
        );
  if (
    runnerUpCompleted &&
    runnerUpCompleted.totalScoreMicros > bestCompleted.totalScoreMicros
  ) {
    throw new Error(`${label}.runnerUpCompleted 分数超过 bestCompleted。`);
  }
  const optimisticOmitted =
    frontier.optimisticOmitted === null
      ? null
      : validateReceiptFineOmitted(
          frontier.optimisticOmitted,
          `${label}.optimisticOmitted`,
          componentPairOrdinals
        );
  const nextRefinementCandidateIds = validateFineCandidateIds(
    frontier.nextRefinementCandidateIds,
    `${label}.nextRefinementCandidateIds`,
    componentPairOrdinals,
    false,
    false
  );
  const deferredCandidateCount = requireNonNegativeSafeInteger(
    frontier.deferredCandidateCount,
    `${label}.deferredCandidateCount`
  );
  if (deferredCandidateCount > inventoryCandidateCount) {
    throw new Error(`${label}.deferredCandidateCount 超过库存。`);
  }
  const proofRecord = requireExactRecord(
    frontier.proof,
    ["beatsRunnerUpWithMargin", "beatsOptimisticOmittedWithMargin"],
    `${label}.proof`
  );
  if (
    typeof proofRecord.beatsRunnerUpWithMargin !== "boolean" ||
    typeof proofRecord.beatsOptimisticOmittedWithMargin !== "boolean"
  ) {
    throw new Error(`${label}.proof 字段必须是 boolean。`);
  }
  const proof = {
    beatsRunnerUpWithMargin: proofRecord.beatsRunnerUpWithMargin,
    beatsOptimisticOmittedWithMargin: proofRecord.beatsOptimisticOmittedWithMargin
  };
  const searchRecord = requireExactRecord(
    frontier.search,
    ["statesVisited", "expansionsConsidered", "intervalComparisons"],
    `${label}.search`
  );
  const search = {
    statesVisited: requireBoundedFineInteger(
      searchRecord.statesVisited,
      `${label}.search.statesVisited`,
      0,
      limits.maxSearchStates
    ),
    expansionsConsidered: requireBoundedFineInteger(
      searchRecord.expansionsConsidered,
      `${label}.search.expansionsConsidered`,
      0,
      limits.maxSearchExpansions
    ),
    intervalComparisons: requireBoundedFineInteger(
      searchRecord.intervalComparisons,
      `${label}.search.intervalComparisons`,
      0,
      limits.maxIntervalComparisons
    )
  };
  if (finalState === "resolved") {
    if (
      selectedCandidateIds.length === 0 ||
      !sameFineCandidateIdArrays(selectedCandidateIds, bestCompleted.candidateIds) ||
      selectedTotalScoreMicros !== bestCompleted.totalScoreMicros ||
      !proof.beatsRunnerUpWithMargin ||
      !proof.beatsOptimisticOmittedWithMargin ||
      nextRefinementCandidateIds.length !== 0 ||
      deferredCandidateCount !== 0
    ) {
      throw new Error(`${label} resolved 选择、分数或 proof 不闭合。`);
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
      inventoryStateCounts.scored !== 0)
  ) {
    throw new Error(`${label} noEligibleCandidate 夹带候选结果。`);
  }
  const validated: NativeBatchFineFrontierReceipt = {
    contractVersion: REAL_MEDIA_BLIND_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
    scoreVersion: REAL_MEDIA_BLIND_BATCH_FINE_SCORE_VERSION,
    inventoryDigest,
    inventoryCandidates,
    receiptDigest,
    componentOrdinal,
    componentPairOrdinals,
    inventoryCandidateCount,
    resolutionMarginMicros,
    overlapToleranceMs,
    limits,
    inventoryStateCounts,
    refinementRoundCount,
    evaluatedCandidateCount,
    finalState,
    resolved: frontier.resolved,
    selectedCandidateIds,
    selectedTotalScoreMicros,
    bestCompleted,
    runnerUpCompleted,
    optimisticOmitted,
    nextRefinementCandidateIds,
    deferredCandidateCount,
    proof,
    search
  };
  if (createNativeBatchFineFrontierReceiptDigest(validated) !== receiptDigest) {
    throw new Error(`${label}.receiptDigest 与 canonical receipt 不一致。`);
  }
  return validated;
}

function validateReceiptFineInventoryCandidates(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[],
  suite: RealMediaBlindBatchExecutionSuite
): NativeBatchFineInventoryCandidate[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const candidates = value.map((item, index) => {
    const candidateLabel = `${label}[${index}]`;
    const record = requireExactRecord(
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
    const id = validateFineCandidateId(
      record.id,
      `${candidateLabel}.id`,
      componentPairOrdinals
    );
    if (!suite.pairs.some((item) => item.pairOrdinal === id.pairOrdinal)) {
      throw new Error(`${candidateLabel}.id 无法绑定 execution suite 媒体。`);
    }
    const coarseUpperBoundMicros = requireBoundedFineInteger(
      record.coarseUpperBoundMicros,
      `${candidateLabel}.coarseUpperBoundMicros`,
      0,
      1_000_000
    );
    const sourceAxisReuseGroupOrdinal = requirePositiveSafeIntegerOrNull(
      record.sourceAxisReuseGroupOrdinal,
      `${candidateLabel}.sourceAxisReuseGroupOrdinal`
    );
    const targetAxisReuseGroupOrdinal = requirePositiveSafeIntegerOrNull(
      record.targetAxisReuseGroupOrdinal,
      `${candidateLabel}.targetAxisReuseGroupOrdinal`
    );
    const pair = suite.pairs.find((item) => item.pairOrdinal === id.pairOrdinal);
    if (pair === undefined) {
      throw new Error(`${candidateLabel}.id 无法绑定 execution suite pair。`);
    }
    const expectedSourceReuseOrdinal =
      suite.versionReuseGroups.findIndex(
        (group) => group.side === "target" && group.mediaIds.includes(pair.targetMediaId)
      ) + 1;
    const expectedTargetReuseOrdinal =
      suite.versionReuseGroups.findIndex(
        (group) => group.side === "source" && group.mediaIds.includes(pair.sourceMediaId)
      ) + 1;
    if (
      sourceAxisReuseGroupOrdinal !==
        (expectedSourceReuseOrdinal === 0 ? null : expectedSourceReuseOrdinal) ||
      targetAxisReuseGroupOrdinal !==
        (expectedTargetReuseOrdinal === 0 ? null : expectedTargetReuseOrdinal)
    ) {
      throw new Error(`${candidateLabel} 多版本复用组 ordinal 未绑定当前 pair 的 suite 策略。`);
    }
    if (!Array.isArray(record.members) || record.members.length === 0) {
      throw new Error(`${candidateLabel}.members 必须是非空数组。`);
    }
    const members = record.members.map((member, memberIndex) =>
      validateFineInventoryMember(member, `${candidateLabel}.members[${memberIndex}]`)
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
  if (!sameFineCandidateIdArrays(ids, [...ids].sort(compareFineCandidateId))) {
    throw new Error(`${label} 未按 candidateId canonical 排序。`);
  }
  if (new Set(ids.map(fineCandidateKey)).size !== ids.length) {
    throw new Error(`${label} 包含重复 candidateId。`);
  }
  for (const pairOrdinal of componentPairOrdinals) {
    const pairCandidates = candidates.filter(
      (candidate) => candidate.id.pairOrdinal === pairOrdinal
    );
    if (
      pairCandidates.some((candidate, index) => candidate.id.candidateOrdinal !== index + 1)
    ) {
      throw new Error(`${label} 的每个 pair 必须从 candidateOrdinal=1 连续完整枚举。`);
    }
    const sourceReuseOrdinals = new Set(
      pairCandidates.map((candidate) => candidate.sourceAxisReuseGroupOrdinal)
    );
    const targetReuseOrdinals = new Set(
      pairCandidates.map((candidate) => candidate.targetAxisReuseGroupOrdinal)
    );
    if (sourceReuseOrdinals.size > 1 || targetReuseOrdinals.size > 1) {
      throw new Error(`${label} 的同一 pair 多版本复用组绑定不一致。`);
    }
  }
  return candidates;
}

function validateReceiptFineLimits(value: unknown, label: string): NativeBatchFineLimits {
  const record = requireExactRecord(
    value,
    [
      "maxCandidates",
      "maxSearchStates",
      "maxSearchExpansions",
      "maxIntervalComparisons",
      "maxIntervalsPerAxis",
      "maxTotalIntervals",
      "refinementBatchSize"
    ],
    label
  );
  return {
    maxCandidates: requirePositiveSafeInteger(record.maxCandidates, `${label}.maxCandidates`),
    maxSearchStates: requirePositiveSafeInteger(
      record.maxSearchStates,
      `${label}.maxSearchStates`
    ),
    maxSearchExpansions: requirePositiveSafeInteger(
      record.maxSearchExpansions,
      `${label}.maxSearchExpansions`
    ),
    maxIntervalComparisons: requirePositiveSafeInteger(
      record.maxIntervalComparisons,
      `${label}.maxIntervalComparisons`
    ),
    maxIntervalsPerAxis: requirePositiveSafeInteger(
      record.maxIntervalsPerAxis,
      `${label}.maxIntervalsPerAxis`
    ),
    maxTotalIntervals: requirePositiveSafeInteger(
      record.maxTotalIntervals,
      `${label}.maxTotalIntervals`
    ),
    refinementBatchSize: requirePositiveSafeInteger(
      record.refinementBatchSize,
      `${label}.refinementBatchSize`
    )
  };
}

function validateReceiptFineStateCounts(
  value: unknown,
  label: string
): NativeBatchFineStateCounts {
  const record = requireExactRecord(
    value,
    [
      "unresolved",
      "scored",
      "evaluatedIneligible",
      "evidenceBlocked",
      "resourceBlocked",
      "infrastructureFailed",
      "cancelled"
    ],
    label
  );
  return {
    unresolved: requireNonNegativeSafeInteger(record.unresolved, `${label}.unresolved`),
    scored: requireNonNegativeSafeInteger(record.scored, `${label}.scored`),
    evaluatedIneligible: requireNonNegativeSafeInteger(
      record.evaluatedIneligible,
      `${label}.evaluatedIneligible`
    ),
    evidenceBlocked: requireNonNegativeSafeInteger(
      record.evidenceBlocked,
      `${label}.evidenceBlocked`
    ),
    resourceBlocked: requireNonNegativeSafeInteger(
      record.resourceBlocked,
      `${label}.resourceBlocked`
    ),
    infrastructureFailed: requireNonNegativeSafeInteger(
      record.infrastructureFailed,
      `${label}.infrastructureFailed`
    ),
    cancelled: requireNonNegativeSafeInteger(record.cancelled, `${label}.cancelled`)
  };
}

function validateReceiptFineAssignment(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): NativeBatchFineAssignment {
  const record = requireExactRecord(value, ["candidateIds", "totalScoreMicros"], label);
  const candidateIds = validateFineCandidateIds(
    record.candidateIds,
    `${label}.candidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const totalScoreMicros = requireNonNegativeSafeInteger(
    record.totalScoreMicros,
    `${label}.totalScoreMicros`
  );
  if (candidateIds.length === 0 && totalScoreMicros !== 0) {
    throw new Error(`${label} 空 assignment 总分必须为 0。`);
  }
  return { candidateIds, totalScoreMicros };
}

function validateReceiptFineOmitted(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): NativeBatchFineOmittedAssignment {
  const record = requireExactRecord(
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
  const candidateIds = validateFineCandidateIds(
    record.candidateIds,
    `${label}.candidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const openCandidateIds = validateFineCandidateIds(
    record.openCandidateIds,
    `${label}.openCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const unresolvedCandidateIds = validateFineCandidateIds(
    record.unresolvedCandidateIds,
    `${label}.unresolvedCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const blockedCandidateIds = validateFineCandidateIds(
    record.blockedCandidateIds,
    `${label}.blockedCandidateIds`,
    componentPairOrdinals,
    true,
    true
  );
  const openKeys = new Set(openCandidateIds.map(fineCandidateKey));
  const partitionKeys = [...unresolvedCandidateIds, ...blockedCandidateIds].map(
    fineCandidateKey
  );
  if (
    candidateIds.length === 0 ||
    openKeys.size === 0 ||
    partitionKeys.length !== new Set(partitionKeys).size ||
    partitionKeys.length !== openKeys.size ||
    partitionKeys.some((key) => !openKeys.has(key)) ||
    openCandidateIds.some(
      (candidate) => !candidateIds.some((item) => sameFineCandidateId(item, candidate))
    )
  ) {
    throw new Error(`${label} open/unresolved/blocked partition 不闭合。`);
  }
  return {
    candidateIds,
    totalUpperBoundMicros: requireNonNegativeSafeInteger(
      record.totalUpperBoundMicros,
      `${label}.totalUpperBoundMicros`
    ),
    openCandidateIds,
    unresolvedCandidateIds,
    blockedCandidateIds
  };
}

function validateFineCandidateIds(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[],
  canonicalOrder: boolean,
  onePerPair: boolean
): NativeBatchFineCandidateId[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const ids = value.map((item, index) =>
    validateFineCandidateId(item, `${label}[${index}]`, componentPairOrdinals)
  );
  const keys = ids.map(fineCandidateKey);
  if (new Set(keys).size !== keys.length) throw new Error(`${label} 包含重复 candidateId。`);
  if (onePerPair && new Set(ids.map((id) => id.pairOrdinal)).size !== ids.length) {
    throw new Error(`${label} 同一 pair 只能选择一个候选。`);
  }
  if (canonicalOrder) {
    const sorted = [...ids].sort(compareFineCandidateId);
    if (!sameFineCandidateIdArrays(ids, sorted)) {
      throw new Error(`${label} 未按 candidateId canonical 排序。`);
    }
  }
  return ids;
}

function validateFineCandidateId(
  value: unknown,
  label: string,
  componentPairOrdinals: readonly number[]
): NativeBatchFineCandidateId {
  const record = requireExactRecord(value, ["pairOrdinal", "candidateOrdinal"], label);
  const pairOrdinal = requirePositiveSafeInteger(record.pairOrdinal, `${label}.pairOrdinal`);
  if (!componentPairOrdinals.includes(pairOrdinal)) {
    throw new Error(`${label}.pairOrdinal 不属于当前 component。`);
  }
  return {
    pairOrdinal,
    candidateOrdinal: requirePositiveSafeInteger(
      record.candidateOrdinal,
      `${label}.candidateOrdinal`
    )
  };
}

function requireFineFrontierState(
  value: unknown,
  label: string
): NativeBatchFineFrontierReceipt["finalState"] {
  if (
    value !== "resolved" &&
    value !== "noEligibleCandidate" &&
    value !== "unresolved" &&
    value !== "failed"
  ) {
    throw new Error(`${label} 无效。`);
  }
  return value;
}

function requireFineIntegerArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  canonicalOrder: boolean
): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const items = value.map((item, index) =>
    requireBoundedFineInteger(item, `${label}[${index}]`, minimum, maximum)
  );
  if (new Set(items).size !== items.length) throw new Error(`${label} 包含重复值。`);
  if (
    canonicalOrder &&
    items.some((item, index) => index > 0 && item <= (items[index - 1] ?? item))
  ) {
    throw new Error(`${label} 必须严格递增。`);
  }
  return items;
}

function requireBoundedFineInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  const integer = requireSafeInteger(value, label);
  if (integer < minimum || integer > maximum) throw new Error(`${label} 越界。`);
  return integer;
}

function compareFineCandidateId(
  left: NativeBatchFineCandidateId,
  right: NativeBatchFineCandidateId
): number {
  return left.pairOrdinal - right.pairOrdinal || left.candidateOrdinal - right.candidateOrdinal;
}

function fineCandidateKey(value: NativeBatchFineCandidateId): string {
  return `${value.pairOrdinal}:${value.candidateOrdinal}`;
}

function sameFineCandidateId(
  left: NativeBatchFineCandidateId | undefined,
  right: NativeBatchFineCandidateId | undefined
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pairOrdinal === right.pairOrdinal &&
    left.candidateOrdinal === right.candidateOrdinal
  );
}

function sameFineCandidateIdArrays(
  left: readonly NativeBatchFineCandidateId[],
  right: readonly NativeBatchFineCandidateId[]
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => sameFineCandidateId(item, right[index]))
  );
}

function validateReceiptFineExecutionEvidence(
  value: unknown,
  label: string,
  pairOrdinal: number,
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  relationRanking: NativeBatchRelationRankingEvidence
): NativeBatchFineExecutionEvidence {
  const record = requireExactRecord(
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
  const candidateId = validateFineCandidateId(record.candidateId, `${label}.candidateId`, [
    pairOrdinal
  ]);
  const selectedMemberRank = requirePositiveSafeInteger(
    record.selectedMemberRank,
    `${label}.selectedMemberRank`
  );
  const groupMemberRanks = requireFineIntegerArray(
    record.groupMemberRanks,
    `${label}.groupMemberRanks`,
    1,
    Number.MAX_SAFE_INTEGER,
    true
  );
  if (groupMemberRanks.length === 0 || !groupMemberRanks.includes(selectedMemberRank)) {
    throw new Error(`${label}.selectedMemberRank 不属于 groupMemberRanks。`);
  }
  const sourceStreamIndex = requireNonNegativeSafeInteger(
    record.sourceStreamIndex,
    `${label}.sourceStreamIndex`
  );
  const targetStreamIndex = requireNonNegativeSafeInteger(
    record.targetStreamIndex,
    `${label}.targetStreamIndex`
  );
  if (
    sourceStreamIndex !== source.audioStreamIndex ||
    targetStreamIndex !== target.audioStreamIndex
  ) {
    throw new Error(`${label} 音轨索引与 execution suite 不一致。`);
  }
  const sourceCoarseBackend = validateReceiptFineBackend(
    record.sourceCoarseBackend,
    `${label}.sourceCoarseBackend`
  );
  const targetCoarseBackend = validateReceiptFineBackend(
    record.targetCoarseBackend,
    `${label}.targetCoarseBackend`
  );
  const sourceFineBackend = validateReceiptFineBackend(
    record.sourceFineBackend,
    `${label}.sourceFineBackend`
  );
  const targetFineBackend = validateReceiptFineBackend(
    record.targetFineBackend,
    `${label}.targetFineBackend`
  );
  validateReceiptFineBackendContinuity(
    sourceCoarseBackend,
    sourceFineBackend,
    `${label}.source`
  );
  validateReceiptFineBackendContinuity(
    targetCoarseBackend,
    targetFineBackend,
    `${label}.target`
  );
  const executionIdentity = relationRanking.executionIdentity;
  if (
    executionIdentity === null ||
    !executionIdentity.sourceSpectralBackends.some((backend) =>
      canonicalEqual(backend, sourceCoarseBackend)
    ) ||
    !executionIdentity.targetSpectralBackends.some((backend) =>
      canonicalEqual(backend, targetCoarseBackend)
    )
  ) {
    throw new Error(`${label} coarse backend 未绑定 relation execution identity。`);
  }
  const sourceRequestedWindow = validateReceiptFineWindow(
    record.sourceRequestedWindow,
    `${label}.sourceRequestedWindow`,
    false
  );
  const targetRequestedWindow = validateReceiptFineWindow(
    record.targetRequestedWindow,
    `${label}.targetRequestedWindow`,
    false
  );
  const sourceEffectiveWindow = validateReceiptFineWindow(
    record.sourceEffectiveWindow,
    `${label}.sourceEffectiveWindow`,
    true
  );
  const targetEffectiveWindow = validateReceiptFineWindow(
    record.targetEffectiveWindow,
    `${label}.targetEffectiveWindow`,
    true
  );
  validateReceiptFineWindowRelation(
    sourceRequestedWindow,
    sourceEffectiveWindow,
    `${label}.source`
  );
  validateReceiptFineWindowRelation(
    targetRequestedWindow,
    targetEffectiveWindow,
    `${label}.target`
  );
  const validated: NativeBatchFineExecutionEvidence = {
    candidateId,
    selectedMemberRank,
    groupMemberRanks,
    sourceStreamIndex,
    targetStreamIndex,
    sourceCoarseBackend,
    targetCoarseBackend,
    sourceFineBackend,
    targetFineBackend,
    sourceRequestedWindow,
    targetRequestedWindow,
    sourceEffectiveWindow,
    targetEffectiveWindow,
    parametersHash: requireSha256Digest(record.parametersHash, `${label}.parametersHash`),
    occupancyDigest: requireSha256Digest(record.occupancyDigest, `${label}.occupancyDigest`),
    proposalTimeMapDigest: requireSha256Digest(
      record.proposalTimeMapDigest,
      `${label}.proposalTimeMapDigest`
    ),
    scoreMicros: requireBoundedFineInteger(
      record.scoreMicros,
      `${label}.scoreMicros`,
      1,
      1_000_000
    ),
    evidenceDigest: requireSha256Digest(record.evidenceDigest, `${label}.evidenceDigest`)
  };
  if (createNativeBatchFineExecutionEvidenceDigest(validated) !== validated.evidenceDigest) {
    throw new Error(`${label}.evidenceDigest 与 canonical evidence 不一致。`);
  }
  return validated;
}

function validateReceiptFineWindow(
  value: unknown,
  label: string,
  requireActual: boolean
): NativeBatchFineDecodeWindow {
  const record = requireExactRecord(
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
  const startMs = requireSafeInteger(record.startMs, `${label}.startMs`);
  const endMs = requireSafeInteger(record.endMs, `${label}.endMs`);
  if (endMs <= startMs) throw new Error(`${label} 必须是正长度半开窗口。`);
  const presentationOffsetMs = requireSafeInteger(
    record.presentationOffsetMs,
    `${label}.presentationOffsetMs`
  );
  if (presentationOffsetMs !== startMs) {
    throw new Error(`${label}.presentationOffsetMs 未绑定窗口起点。`);
  }
  if (record.sampleRate !== 16_000) throw new Error(`${label}.sampleRate 必须为 16000。`);
  const expectedSampleCount = requirePositiveSafeInteger(
    record.expectedSampleCount,
    `${label}.expectedSampleCount`
  );
  if (expectedSampleCount !== Math.ceil(((endMs - startMs) * 16_000) / 1_000)) {
    throw new Error(`${label}.expectedSampleCount 与窗口时长不一致。`);
  }
  const actualDecodedSampleCount =
    record.actualDecodedSampleCount === null
      ? null
      : requirePositiveSafeInteger(
          record.actualDecodedSampleCount,
          `${label}.actualDecodedSampleCount`
        );
  if (
    (requireActual &&
      (actualDecodedSampleCount === null || actualDecodedSampleCount > expectedSampleCount)) ||
    (!requireActual && actualDecodedSampleCount !== null)
  ) {
    throw new Error(`${label}.actualDecodedSampleCount 与 requested/effective 语义不一致。`);
  }
  return {
    startMs,
    endMs,
    presentationOffsetMs,
    sampleRate: 16_000,
    expectedSampleCount,
    actualDecodedSampleCount
  };
}

function validateReceiptFineWindowRelation(
  requested: NativeBatchFineDecodeWindow,
  effective: NativeBatchFineDecodeWindow,
  label: string
): void {
  if (
    effective.startMs !== requested.startMs ||
    effective.endMs > requested.endMs + FINE_WINDOW_DECODE_TOLERANCE_MS
  ) {
    throw new Error(
      `${label} effective window 必须与 requested 同起点，且结束点最多放宽 ${FINE_WINDOW_DECODE_TOLERANCE_MS}ms。`
    );
  }
}

function validateReceiptFineBackend(
  value: unknown,
  label: string
): NativeBatchSpectralBackendExecutionIdentity {
  return validateNativeBatchSpectralBackendIdentities([value], label)[0];
}

function validateReceiptFineBackendContinuity(
  coarse: NativeBatchSpectralBackendExecutionIdentity,
  fine: NativeBatchSpectralBackendExecutionIdentity,
  label: string
): void {
  if (!isLockedFineSpectralBackendIdentity(coarse, fine)) {
    throw new Error(`${label} coarse→fine backend continuity 不闭合。`);
  }
}

function validateReceiptFinePairBinding(
  pairOrdinal: number,
  frontier: NativeBatchFineFrontierReceipt | null,
  execution: NativeBatchFineExecutionEvidence | null,
  proposalTimeMap: AlignmentTimeMapProposal | null,
  relationRanking: NativeBatchRelationRankingEvidence,
  label: string
): void {
  if (frontier === null || !frontier.componentPairOrdinals.includes(pairOrdinal)) {
    throw new Error(`${label} completed pair 缺少绑定当前 pair 的 fineFrontier。`);
  }
  const selected = frontier.selectedCandidateIds.filter(
    (candidate) => candidate.pairOrdinal === pairOrdinal
  );
  if (selected.length > 1) throw new Error(`${label} 第二次 assignment 对同一 pair 多选。`);
  if (selected.length === 0) {
    if (execution !== null || proposalTimeMap !== null) {
      throw new Error(`${label} 未被最终选择却夹带 fine execution 或 TimeMap。`);
    }
    return;
  }
  if (
    execution === null ||
    proposalTimeMap === null ||
    !sameFineCandidateId(selected[0], execution.candidateId)
  ) {
    throw new Error(`${label} 最终 candidate 与 fine execution 不一致。`);
  }
  if (
    createNativeBatchFineProposalTimeMapDigest(proposalTimeMap) !==
    execution.proposalTimeMapDigest
  ) {
    throw new Error(`${label} proposal TimeMap 与 fine execution 摘要不一致。`);
  }
  const identity = relationRanking.executionIdentity;
  if (
    identity === null ||
    createNativeBatchFineParametersHash(
      identity.engineVersion,
      identity.featureVersion,
      proposalTimeMap.parametersHash
    ) !== execution.parametersHash
  ) {
    throw new Error(`${label} fine parametersHash 未绑定 coarse identity/TimeMap 参数。`);
  }
}

function validateReceiptFineComponentCoherence(
  outcomes: readonly RealMediaBlindBatchPairOutcome[]
): void {
  const byComponent = new Map<number, NativeBatchFineFrontierReceipt>();
  for (const outcome of outcomes) {
    const frontier = outcome.fineFrontier;
    if (frontier === null) continue;
    const existing = byComponent.get(frontier.componentOrdinal);
    if (existing && !canonicalEqual(existing, frontier)) {
      throw new Error("同一 fine component 的 receipt 内容发生漂移。");
    }
    byComponent.set(frontier.componentOrdinal, frontier);
  }
  const componentOrdinals = [...byComponent.keys()].sort((left, right) => left - right);
  if (componentOrdinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new Error("fine componentOrdinal 必须从 1 开始连续且无缺口。");
  }
  for (const frontier of byComponent.values()) {
    const componentOutcomes: RealMediaBlindBatchPairOutcome[] = [];
    for (const pairOrdinal of frontier.componentPairOrdinals) {
      const outcome = outcomes[pairOrdinal - 1];
      if (
        outcome === undefined ||
        outcome.fineFrontier === null ||
        !canonicalEqual(outcome.fineFrontier, frontier)
      ) {
        throw new Error("fine component receipt 未由全部成员 pair 原子复用。");
      }
      componentOutcomes.push(outcome);
    }
    const executions = componentOutcomes
      .map((outcome) => outcome.fineExecutionEvidence)
      .filter((evidence): evidence is NativeBatchFineExecutionEvidence => evidence !== null);
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
      throw new Error("fine component selected IDs、execution evidence 与总分不闭合。");
    }
  }
}

function validateReceiptPairOutcome(
  value: unknown,
  pairIndex: number,
  suite: RealMediaBlindBatchExecutionSuite
): RealMediaBlindBatchPairOutcome {
  const outcome = requireExactRecord(
    value,
    [
      "pairIndex",
      "pairOrdinal",
      "sourceMediaId",
      "targetMediaId",
      "nativeStatus",
      "failureCode",
      "relationRanking",
      "globalSelected",
      "globalSelection",
      "fineFrontier",
      "fineExecutionEvidence",
      "proposalTimeMap"
    ],
    `pairOutcomes[${pairIndex}]`
  );
  const expected = suite.pairs[pairIndex];
  if (!expected) throw new Error("receipt pairOutcomes 索引超过 execution suite。");
  if (
    outcome.pairIndex !== pairIndex ||
    outcome.pairOrdinal !== expected.pairOrdinal ||
    outcome.sourceMediaId !== expected.sourceMediaId ||
    outcome.targetMediaId !== expected.targetMediaId
  ) {
    throw new Error("receipt pairOutcomes 未按 source-major canonical 顺序完整绑定 suite。");
  }
  const source = suite.sources.find((media) => media.mediaId === expected.sourceMediaId);
  const target = suite.targets.find((media) => media.mediaId === expected.targetMediaId);
  if (!source || !target) throw new Error("receipt pair outcome 引用了缺失媒体。");
  const nativeStatus = validateReceiptNativePairStatus(outcome.nativeStatus);
  const relationRanking = validateRealMediaBlindBatchRelationRankingEvidence(
    outcome.relationRanking,
    nativeStatus,
    source,
    target,
    `receipt pair #${expected.pairOrdinal}`
  );
  const globalSelection = validateRealMediaBlindBatchGlobalSelectionEvidence(
    outcome.globalSelection,
    nativeStatus,
    source,
    target,
    `receipt pair #${expected.pairOrdinal}`
  );
  if (
    typeof outcome.globalSelected !== "boolean" ||
    outcome.globalSelected !== globalSelection.selected
  ) {
    throw new Error("receipt pair outcome 的 globalSelected 与 native evidence 不一致。");
  }
  const fineFrontier =
    outcome.fineFrontier === null
      ? null
      : validateReceiptFineFrontier(
          outcome.fineFrontier,
          `receipt pair #${expected.pairOrdinal}.fineFrontier`,
          suite
        );
  const fineExecutionEvidence =
    outcome.fineExecutionEvidence === null
      ? null
      : validateReceiptFineExecutionEvidence(
          outcome.fineExecutionEvidence,
          `receipt pair #${expected.pairOrdinal}.fineExecutionEvidence`,
          expected.pairOrdinal,
          source,
          target,
          relationRanking
        );
  let failureCode: RealMediaBlindBatchPairFailureCode | null;
  let proposalTimeMap: AlignmentTimeMapProposal | null;
  if (nativeStatus === "completed") {
    if (outcome.failureCode !== null) {
      throw new Error("completed receipt pair 不得包含 failureCode。");
    }
    if (outcome.proposalTimeMap === null) {
      proposalTimeMap = null;
    } else {
      assertAlignmentTimeMapExactKeys(
        outcome.proposalTimeMap,
        `receipt pair #${expected.pairOrdinal}`
      );
      if (!isAlignmentTimeMapProposal(outcome.proposalTimeMap, true)) {
        throw new Error("completed receipt pair 的 proposalTimeMap 不是完整 V2 TimeMap。");
      }
      proposalTimeMap = structuredClone(outcome.proposalTimeMap);
      validateRealMediaBlindBatchProposalBinding(
        proposalTimeMap,
        source,
        target,
        suite.parameters,
        expected.pairOrdinal
      );
    }
    validateReceiptFinePairBinding(
      expected.pairOrdinal,
      fineFrontier,
      fineExecutionEvidence,
      proposalTimeMap,
      relationRanking,
      `receipt pair #${expected.pairOrdinal}`
    );
    failureCode = null;
  } else {
    const expectedFailureCode =
      nativeStatus === "failed" ? "native-pair-failed" : "native-pair-cancelled";
    if (outcome.failureCode !== expectedFailureCode || outcome.proposalTimeMap !== null) {
      throw new Error("failed/cancelled receipt pair 的 failureCode/TimeMap 不闭合。");
    }
    failureCode = expectedFailureCode;
    proposalTimeMap = null;
    if (fineExecutionEvidence !== null) {
      throw new Error("failed/cancelled receipt pair 不能包含 fineExecutionEvidence。");
    }
    if (nativeStatus === "cancelled" && fineFrontier !== null) {
      throw new Error("cancelled receipt pair 不能包含 fineFrontier。");
    }
  }
  return {
    pairIndex,
    pairOrdinal: expected.pairOrdinal,
    sourceMediaId: expected.sourceMediaId,
    targetMediaId: expected.targetMediaId,
    nativeStatus,
    failureCode,
    relationRanking,
    globalSelected: globalSelection.selected,
    globalSelection,
    fineFrontier,
    fineExecutionEvidence,
    proposalTimeMap
  };
}

function validateReceiptRunStatus(value: unknown): RealMediaBlindBatchRunStatus {
  if (
    value !== "completed" &&
    value !== "completed-with-errors" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "timed-out"
  ) {
    throw new Error("blind batch run receipt status 无效。");
  }
  return value;
}

function validateReceiptTerminationReason(
  value: unknown
): "native-terminal" | "abort-signal" | "job-timeout" {
  if (value !== "native-terminal" && value !== "abort-signal" && value !== "job-timeout") {
    throw new Error("blind batch run receipt terminationReason 无效。");
  }
  return value;
}

function validateReceiptStatusTerminationCoherence(
  status: RealMediaBlindBatchRunStatus,
  terminationReason: "native-terminal" | "abort-signal" | "job-timeout"
): void {
  if (
    (terminationReason === "job-timeout" && status !== "timed-out") ||
    (terminationReason === "abort-signal" && status !== "cancelled") ||
    (terminationReason !== "job-timeout" && status === "timed-out")
  ) {
    throw new Error("blind batch run receipt status 与 terminationReason 不一致。");
  }
}

function validateReceiptRunOutcomeCoherence(
  status: RealMediaBlindBatchRunStatus,
  outcomes: readonly RealMediaBlindBatchPairOutcome[]
): void {
  const failed = outcomes.filter((outcome) => outcome.nativeStatus === "failed").length;
  const cancelled = outcomes.filter((outcome) => outcome.nativeStatus === "cancelled").length;
  if (
    (status === "completed" && (failed !== 0 || cancelled !== 0)) ||
    (status === "completed-with-errors" && (failed === 0 || cancelled !== 0)) ||
    (status === "failed" && failed === 0) ||
    ((status === "cancelled" || status === "timed-out") && cancelled === 0)
  ) {
    throw new Error("blind batch run receipt status 与完整 pair outcomes 不一致。");
  }
}

function validateReceiptNativePairStatus(value: unknown): "completed" | "failed" | "cancelled" {
  if (value !== "completed" && value !== "failed" && value !== "cancelled") {
    throw new Error("receipt nativeStatus 必须是 completed/failed/cancelled。");
  }
  return value;
}

function assertAlignmentTimeMapExactKeys(value: unknown, label: string): void {
  const timeMap = requireExactRecord(
    value,
    [
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "spans",
      "quality",
      "evidence",
      "sourceStream",
      "targetStream",
      "sourceVisualStream",
      "targetVisualStream",
      "sourceIdentity",
      "targetIdentity",
      "engineVersion",
      "featureVersion",
      "parametersHash"
    ],
    `${label}.proposalTimeMap`
  );
  requireExactRecord(
    timeMap.quality,
    [
      "level",
      "probability",
      "metricSource",
      "coverage",
      "uniqueContentCoverage",
      "p50ResidualMs",
      "p95ResidualMs",
      "p99ResidualMs",
      "maxResidualMs",
      "boundaryUncertaintyMs",
      "alternativeMargin",
      "anchorCount",
      "anchorRegionCount",
      "heldOutAnchorCount",
      "reasons"
    ],
    `${label}.proposalTimeMap.quality`
  );
  const evidence = requireExactRecord(
    timeMap.evidence,
    [
      "types",
      "audioAnchorCount",
      "visualAnchorCount",
      "heldOutAnchorCount",
      "top1Top2Margin",
      "uniqueContentCoverage",
      "repeatedContentOnly",
      "selectedTrackReason",
      "alternativeTrackScores",
      "notes"
    ],
    `${label}.proposalTimeMap.evidence`
  );
  if (!Array.isArray(evidence.alternativeTrackScores)) {
    throw new Error(`${label}.proposalTimeMap.evidence.alternativeTrackScores 必须是数组。`);
  }
  evidence.alternativeTrackScores.forEach((alternative, index) => {
    requireExactRecord(
      alternative,
      ["sourceStreamIndex", "targetStreamIndex", "score", "scale", "offsetMs", "inlierCount"],
      `${label}.proposalTimeMap.evidence.alternativeTrackScores[${index}]`
    );
  });
  assertStreamExactKeys(timeMap.sourceStream, `${label}.sourceStream`, false);
  assertStreamExactKeys(timeMap.targetStream, `${label}.targetStream`, false);
  assertStreamExactKeys(timeMap.sourceVisualStream, `${label}.sourceVisualStream`, true);
  assertStreamExactKeys(timeMap.targetVisualStream, `${label}.targetVisualStream`, true);
  assertIdentityExactKeys(timeMap.sourceIdentity, `${label}.sourceIdentity`);
  assertIdentityExactKeys(timeMap.targetIdentity, `${label}.targetIdentity`);
  if (!Array.isArray(timeMap.spans)) {
    throw new Error(`${label}.proposalTimeMap.spans 必须是数组。`);
  }
  timeMap.spans.forEach((span, index) =>
    assertCompleteSpanExactKeys(span, `${label}.spans[${index}]`)
  );
}

function assertStreamExactKeys(value: unknown, label: string, nullable: boolean): void {
  if (value === null && nullable) return;
  requireExactRecord(
    value,
    [
      "type",
      "index",
      "codec",
      "startMs",
      "timelineOffsetMs",
      "timeBase",
      "sampleRate",
      "channels",
      "frameRate",
      "language",
      "title"
    ],
    label
  );
}

function assertIdentityExactKeys(value: unknown, label: string): void {
  requireExactRecord(
    value,
    [
      "algorithm",
      "sizeBytes",
      "modifiedUnixMs",
      "firstSampleDigest",
      "middleSampleDigest",
      "lastSampleDigest"
    ],
    label
  );
}

function assertCompleteSpanExactKeys(value: unknown, label: string): void {
  const span = requireExactRecord(
    value,
    [
      "kind",
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "id",
      "reason",
      "quality",
      "boundaries",
      "alternatives"
    ],
    label
  );
  const quality = requireExactRecord(
    span.quality,
    [
      "level",
      "metricSource",
      "probability",
      "coverage",
      "uniqueContentCoverage",
      "alternativeMargin",
      "anchorCount",
      "heldOutAnchorCount",
      "p50ResidualMs",
      "p95ResidualMs",
      "p99ResidualMs",
      "maxResidualMs",
      "boundaryUncertaintyMs",
      "leftSupport",
      "rightSupport",
      "signals",
      "reasons"
    ],
    `${label}.quality`
  );
  requireExactRecord(
    quality.signals,
    ["audio", "visual", "danmaku"],
    `${label}.quality.signals`
  );
  const boundaries = requireExactRecord(
    span.boundaries,
    ["start", "end"],
    `${label}.boundaries`
  );
  assertBoundaryExactKeys(boundaries.start, `${label}.boundaries.start`);
  assertBoundaryExactKeys(boundaries.end, `${label}.boundaries.end`);
  if (!Array.isArray(span.alternatives)) {
    throw new Error(`${label}.alternatives 必须是数组。`);
  }
  span.alternatives.forEach((alternative, index) => {
    requireExactRecord(
      alternative,
      [
        "kind",
        "score",
        "sourceStartMs",
        "sourceEndMs",
        "targetStartMs",
        "targetEndMs",
        "reason"
      ],
      `${label}.alternatives[${index}]`
    );
  });
}

function assertBoundaryExactKeys(value: unknown, label: string): void {
  requireExactRecord(
    value,
    [
      "status",
      "axis",
      "contextSide",
      "coarseMs",
      "refinedMs",
      "uncertaintyStartMs",
      "uncertaintyEndMs",
      "supportDurationMs",
      "correlation",
      "alternativeMargin",
      "reason"
    ],
    label
  );
}

function validateVisualStreamBinding(
  stream: AlignmentTimeMapProposal["sourceVisualStream"],
  expectedIndex: number | null,
  visualRequired: boolean,
  label: string
): void {
  if (!visualRequired) {
    if (stream !== undefined && stream !== null) {
      throw new Error(`${label} 在关闭视觉证据时意外存在，拒绝混入未请求的视觉结果。`);
    }
    return;
  }
  if (stream === undefined || stream === null) {
    throw new Error(`${label} 未证明视觉证据实际消费了视频流。`);
  }
  if (stream.type !== "video" || (expectedIndex !== null && stream.index !== expectedIndex)) {
    throw new Error(`${label} 索引错配。`);
  }
}

export function createRealMediaBlindBatchSourceRanking(
  sourceMediaId: string,
  outcomes: readonly RealMediaBlindBatchPairOutcome[],
  topK: number
): RealMediaBlindBatchSourceRanking {
  const candidates = outcomes
    .filter((outcome) => outcome.sourceMediaId === sourceMediaId)
    .map((outcome) => {
      const decision = outcome.globalSelection.decisionCandidate;
      return {
        relationRank: 0,
        pairOrdinal: outcome.pairOrdinal,
        targetMediaId: outcome.targetMediaId,
        nativeStatus: outcome.nativeStatus,
        globalSelected: outcome.globalSelected,
        decisionScore: outcome.globalSelection.decisionScore,
        pairLocalScore: decision?.score ?? null,
        margin: outcome.globalSelection.margin,
        qualityLevel: outcome.proposalTimeMap?.quality.level ?? null
      } satisfies RealMediaBlindBatchRankedCandidate;
    })
    .sort(compareRankedCandidates)
    .map((candidate, index) => ({ ...candidate, relationRank: index + 1 }));
  return {
    sourceMediaId,
    candidates,
    topK: candidates.slice(0, topK).map((candidate) => ({ ...candidate }))
  };
}

export function createRealMediaBlindBatchTargetRanking(
  targetMediaId: string,
  outcomes: readonly RealMediaBlindBatchPairOutcome[],
  topK: number
): RealMediaBlindBatchTargetRanking {
  const candidates = outcomes
    .filter((outcome) => outcome.targetMediaId === targetMediaId)
    .map((outcome) => {
      const decision = outcome.globalSelection.decisionCandidate;
      return {
        relationRank: 0,
        pairOrdinal: outcome.pairOrdinal,
        sourceMediaId: outcome.sourceMediaId,
        nativeStatus: outcome.nativeStatus,
        globalSelected: outcome.globalSelected,
        decisionScore: outcome.globalSelection.decisionScore,
        pairLocalScore: decision?.score ?? null,
        margin: outcome.globalSelection.margin,
        qualityLevel: outcome.proposalTimeMap?.quality.level ?? null
      } satisfies RealMediaBlindBatchTargetRankedCandidate;
    })
    .sort(compareTargetRankedCandidates)
    .map((candidate, index) => ({ ...candidate, relationRank: index + 1 }));
  return {
    targetMediaId,
    candidates,
    topK: candidates.slice(0, topK).map((candidate) => ({ ...candidate }))
  };
}

function compareRankedCandidates(
  left: RealMediaBlindBatchRankedCandidate,
  right: RealMediaBlindBatchRankedCandidate
): number {
  if (left.decisionScore === null && right.decisionScore !== null) return 1;
  if (left.decisionScore !== null && right.decisionScore === null) return -1;
  if (left.decisionScore !== null && right.decisionScore !== null) {
    const scoreOrder = right.decisionScore - left.decisionScore;
    if (scoreOrder !== 0) return scoreOrder;
  }
  if (left.pairLocalScore === null && right.pairLocalScore !== null) return 1;
  if (left.pairLocalScore !== null && right.pairLocalScore === null) return -1;
  if (left.pairLocalScore !== null && right.pairLocalScore !== null) {
    const pairScoreOrder = right.pairLocalScore - left.pairLocalScore;
    if (pairScoreOrder !== 0) return pairScoreOrder;
  }
  return left.pairOrdinal - right.pairOrdinal;
}

function compareTargetRankedCandidates(
  left: RealMediaBlindBatchTargetRankedCandidate,
  right: RealMediaBlindBatchTargetRankedCandidate
): number {
  if (left.decisionScore === null && right.decisionScore !== null) return 1;
  if (left.decisionScore !== null && right.decisionScore === null) return -1;
  if (left.decisionScore !== null && right.decisionScore !== null) {
    const scoreOrder = right.decisionScore - left.decisionScore;
    if (scoreOrder !== 0) return scoreOrder;
  }
  if (left.pairLocalScore === null && right.pairLocalScore !== null) return 1;
  if (left.pairLocalScore !== null && right.pairLocalScore === null) return -1;
  if (left.pairLocalScore !== null && right.pairLocalScore !== null) {
    const pairScoreOrder = right.pairLocalScore - left.pairLocalScore;
    if (pairScoreOrder !== 0) return pairScoreOrder;
  }
  return left.pairOrdinal - right.pairOrdinal;
}

function validateExecutionMediaArray(
  value: unknown,
  label: "sources" | "targets"
): RealMediaBlindBatchExecutionMedia[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error(`${label} 必须包含 1–256 个 distinct media。`);
  }
  return value.map((item, index) => {
    const media = requireExactRecord(
      item,
      ["mediaId", "path", "contentIdentity", "audioStreamIndex", "videoStreamIndex"],
      `${label}[${index}]`
    );
    const mediaId = requireIdentifier(media.mediaId, `${label}[${index}].mediaId`);
    const path = requireCanonicalPath(media.path, `${label}[${index}].path`);
    if (path.includes("\u0000")) throw new Error(`${label}[${index}].path 含 NUL。`);
    const contentIdentity = requireExactRecord(
      media.contentIdentity,
      [
        "algorithm",
        "sizeBytes",
        "modifiedUnixMs",
        "firstSampleDigest",
        "middleSampleDigest",
        "lastSampleDigest"
      ],
      `${label}[${index}].contentIdentity`
    );
    if (!isMediaContentIdentity(contentIdentity)) {
      throw new Error(`${label}[${index}].contentIdentity 无效。`);
    }
    if (contentIdentity.algorithm !== "sha256-full-file-v2") {
      throw new Error(`${label}[${index}].contentIdentity 必须是完整文件 SHA-256 v2 身份。`);
    }
    const audioStreamIndex = requireNonNegativeSafeInteger(
      media.audioStreamIndex,
      `${label}[${index}].audioStreamIndex`
    );
    const videoStreamIndex = requireNonNegativeSafeIntegerOrNull(
      media.videoStreamIndex,
      `${label}[${index}].videoStreamIndex`
    );
    return {
      mediaId,
      path,
      contentIdentity: cloneMediaContentIdentity(contentIdentity)!,
      audioStreamIndex,
      videoStreamIndex
    };
  });
}

function validateVersionReuseGroups(
  value: unknown,
  sources: readonly RealMediaBlindBatchExecutionMedia[],
  targets: readonly RealMediaBlindBatchExecutionMedia[]
): RealMediaBlindBatchVersionReuseGroup[] {
  if (!Array.isArray(value)) {
    throw new Error("blind batch execution suite.versionReuseGroups 必须是数组。");
  }
  const sourceOrder = new Map(sources.map((media, index) => [media.mediaId, index]));
  const targetOrder = new Map(targets.map((media, index) => [media.mediaId, index]));
  const seenGroupIds = new Set<string>();
  const groupedMedia = new Set<string>();
  const groups = value.map((item, index) => {
    const label = `versionReuseGroups[${index}]`;
    const group = requireExactRecord(item, ["groupId", "side", "mediaIds"], label);
    const groupId = requireNonBlankString(group.groupId, `${label}.groupId`).trim();
    if (
      !/^[A-Za-z0-9._:-]+$/.test(groupId) ||
      new TextEncoder().encode(groupId).byteLength > 160 ||
      seenGroupIds.has(groupId)
    ) {
      throw new Error(`${label}.groupId 无效或重复。`);
    }
    seenGroupIds.add(groupId);
    if (group.side !== "source" && group.side !== "target") {
      throw new Error(`${label}.side 仅支持 source 或 target。`);
    }
    const side: RealMediaBlindBatchVersionGroupSide = group.side;
    if (!Array.isArray(group.mediaIds) || group.mediaIds.length < 2) {
      throw new Error(`${label}.mediaIds 至少需要两个不同媒体。`);
    }
    const order = side === "source" ? sourceOrder : targetOrder;
    const members = new Set<string>();
    const mediaIds = group.mediaIds.map((value, memberIndex) => {
      const mediaId = requireIdentifier(value, `${label}.mediaIds[${memberIndex}]`);
      if (!order.has(mediaId)) {
        throw new Error(`${label} 引用了错误侧或不存在的媒体：${mediaId}`);
      }
      if (members.has(mediaId)) {
        throw new Error(`${label} 包含重复媒体：${mediaId}`);
      }
      members.add(mediaId);
      const membershipKey = `${side}\u0000${mediaId}`;
      if (groupedMedia.has(membershipKey)) {
        throw new Error(`媒体 ${mediaId} 不能同时属于同一侧的多个多版本组。`);
      }
      groupedMedia.add(membershipKey);
      return mediaId;
    });
    mediaIds.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    return { groupId, side, mediaIds };
  });
  return groups.sort(
    (left, right) =>
      (left.side === "source" ? 0 : 1) - (right.side === "source" ? 0 : 1) ||
      left.groupId.localeCompare(right.groupId)
  );
}

function validateVersionReuseGroupSnapshots(
  value: unknown,
  groups: readonly RealMediaBlindBatchVersionReuseGroup[],
  label: string
): RealMediaBlindBatchVersionReuseGroupSnapshot[] {
  if (!Array.isArray(value) || value.length !== groups.length) {
    throw new Error(`${label} 与 execution suite 的多版本复用策略不一致。`);
  }
  const snapshots = value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const snapshot = requireExactRecord(
      item,
      ["groupOrdinal", "groupId", "side", "mediaIds"],
      itemLabel
    );
    const groupOrdinal = requirePositiveSafeInteger(
      snapshot.groupOrdinal,
      `${itemLabel}.groupOrdinal`
    );
    const expected = groups[index];
    if (
      groupOrdinal !== index + 1 ||
      snapshot.groupId !== expected?.groupId ||
      snapshot.side !== expected?.side ||
      !canonicalEqual(snapshot.mediaIds, expected?.mediaIds)
    ) {
      throw new Error(`${itemLabel} 未精确绑定 execution suite 的 canonical 多版本组。`);
    }
    return {
      groupOrdinal,
      groupId: expected.groupId,
      side: expected.side,
      mediaIds: [...expected.mediaIds]
    };
  });
  return snapshots;
}

function ensureDistinctExecutionMedia(
  sources: readonly RealMediaBlindBatchExecutionMedia[],
  targets: readonly RealMediaBlindBatchExecutionMedia[],
  enableVisualEvidence: boolean
): void {
  const ids = new Set<string>();
  const identityByPath = new Map<string, string>();
  const mediaViews = new Set<string>();
  for (const media of [...sources, ...targets]) {
    if (ids.has(media.mediaId)) throw new Error(`execution media ID 重复：${media.mediaId}`);
    ids.add(media.mediaId);
    const pathKey = normalizePathForDistinctness(media.path);
    const identityKey = contentIdentityDistinctnessKey(media.contentIdentity);
    const knownIdentity = identityByPath.get(pathKey);
    if (knownIdentity !== undefined && knownIdentity !== identityKey) {
      throw new Error("execution suite 的同一本地路径声明了不同内容身份。");
    }
    identityByPath.set(pathKey, identityKey);
    // A video stream is part of the effective evidence view only when the native V2 request will
    // actually execute visual validation. Otherwise differing video indices would create duplicate
    // logical candidates backed by the exact same physical content and audio evidence.
    const effectiveVideoStreamIndex = enableVisualEvidence ? media.videoStreamIndex : null;
    const viewKey = JSON.stringify([
      identityKey,
      media.audioStreamIndex,
      effectiveVideoStreamIndex
    ]);
    if (mediaViews.has(viewKey)) {
      throw new Error(
        enableVisualEvidence
          ? "execution suite 包含重复的内容身份与有效流视图：音轨和实际消费的视频流均相同。"
          : "execution suite 包含重复的内容身份与有效流视图：关闭视觉证据时，仅视频流不同不能形成独立候选。"
      );
    }
    mediaViews.add(viewKey);
  }
}

function validateFullCartesianPairs(
  value: unknown,
  sources: readonly RealMediaBlindBatchExecutionMedia[],
  targets: readonly RealMediaBlindBatchExecutionMedia[]
): RealMediaBlindBatchPairRegistration[] {
  if (!Array.isArray(value) || value.length !== sources.length * targets.length) {
    throw new Error("execution suite.pairs 必须完整注册 source×target 全笛卡尔积。");
  }
  return value.map((item, index) => {
    const pair = requireExactRecord(
      item,
      ["pairOrdinal", "sourceMediaId", "targetMediaId"],
      `pairs[${index}]`
    );
    const expectedSource = sources[Math.floor(index / targets.length)];
    const expectedTarget = targets[index % targets.length];
    if (!expectedSource || !expectedTarget) throw new Error("全笛卡尔 pair 计划索引越界。");
    if (
      pair.pairOrdinal !== index + 1 ||
      pair.sourceMediaId !== expectedSource.mediaId ||
      pair.targetMediaId !== expectedTarget.mediaId
    ) {
      throw new Error(
        "execution suite.pairs 必须按 source-major/target-minor 完整且无重复注册。"
      );
    }
    return {
      pairOrdinal: index + 1,
      sourceMediaId: expectedSource.mediaId,
      targetMediaId: expectedTarget.mediaId
    };
  });
}

function validateAlignmentParameters(value: unknown): RealMediaBlindBatchAlignmentParameters {
  const parameters = requireExactRecord(
    value,
    [
      "ffmpegPath",
      "ffprobePath",
      "sampleRate",
      "windowMs",
      "matchThreshold",
      "minGapMs",
      "maxCells",
      "enableVisualEvidence",
      "visualSampleIntervalMs"
    ],
    "parameters"
  );
  const ffmpegPath = requireCanonicalPathOrNull(parameters.ffmpegPath, "parameters.ffmpegPath");
  const ffprobePath = requireCanonicalPathOrNull(
    parameters.ffprobePath,
    "parameters.ffprobePath"
  );
  const sampleRate = requirePositiveSafeIntegerOrNull(
    parameters.sampleRate,
    "parameters.sampleRate"
  );
  const windowMs = requirePositiveSafeIntegerOrNull(parameters.windowMs, "parameters.windowMs");
  const matchThreshold = requireUnitNumberOrNull(
    parameters.matchThreshold,
    "parameters.matchThreshold"
  );
  const minGapMs = requireNonNegativeSafeIntegerOrNull(
    parameters.minGapMs,
    "parameters.minGapMs"
  );
  const maxCells = requirePositiveSafeIntegerOrNull(parameters.maxCells, "parameters.maxCells");
  if (typeof parameters.enableVisualEvidence !== "boolean") {
    throw new Error("parameters.enableVisualEvidence 必须是 boolean。");
  }
  const visualSampleIntervalMs = requirePositiveSafeIntegerOrNull(
    parameters.visualSampleIntervalMs,
    "parameters.visualSampleIntervalMs"
  );
  return {
    ffmpegPath,
    ffprobePath,
    sampleRate,
    windowMs,
    matchThreshold,
    minGapMs,
    maxCells,
    enableVisualEvidence: parameters.enableVisualEvidence,
    visualSampleIntervalMs
  };
}

export function assertRealMediaBlindBatchReceiptIsPathFree(
  receipt: RealMediaBlindBatchRunReceipt,
  suite: RealMediaBlindBatchExecutionSuite
): void {
  const receiptStrings: string[] = [];
  collectStringValues(receipt, receiptStrings);
  for (const path of [
    ...suite.sources.map((media) => media.path),
    ...suite.targets.map((media) => media.path),
    suite.parameters.ffmpegPath,
    suite.parameters.ffprobePath
  ]) {
    if (!path) continue;
    const normalized = normalizePathForDistinctness(path);
    if (
      receiptStrings.some((value) => normalizePathForDistinctness(value).includes(normalized))
    ) {
      throw new Error("blind batch receipt 意外包含本地路径，已拒绝返回。");
    }
  }
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown) => collectStringValues(item, output));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => collectStringValues(item, output));
  }
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const actualKeys = Object.keys(value).sort();
  const canonicalExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== canonicalExpectedKeys.length ||
    actualKeys.some((key, index) => key !== canonicalExpectedKeys[index])
  ) {
    throw new Error(`${label} 字段不完整或含 gold/额外字段。`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const text = requireNonBlankString(value, label);
  if (
    text !== text.trim() ||
    text.length > 512 ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    text.includes("/") ||
    text.includes("\\")
  ) {
    throw new Error(`${label} 无效。`);
  }
  return text;
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空。`);
  return value;
}

function requireCanonicalPath(value: unknown, label: string): string {
  const path = requireNonBlankString(value, label);
  if (
    path !== path.trim() ||
    path.includes("\u0000") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
  ) {
    throw new Error(`${label} 必须是 canonical 本地路径。`);
  }
  return path;
}

function requireCanonicalPathOrNull(value: unknown, label: string): string | null {
  return value === null ? null : requireCanonicalPath(value, label);
}

function requireSha256Digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 canonical sha256 digest。`);
  }
  return value as `sha256:${string}`;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const number = requireNonNegativeSafeInteger(value, label);
  if (number === 0) throw new Error(`${label} 必须是正安全整数。`);
  return number;
}

function requirePositiveSafeIntegerOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requirePositiveSafeInteger(value, label);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负安全整数。`);
  }
  return value;
}

function requireNonNegativeSafeIntegerOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requireNonNegativeSafeInteger(value, label);
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} 必须是安全整数。`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数值。`);
  }
  return value;
}

function requireFiniteNumberOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requireFiniteNumber(value, label);
}

function requirePositiveFiniteNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number <= 0) throw new Error(`${label} 必须大于 0。`);
  return number;
}

function requireUnitNumber(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number < 0 || number > 1) throw new Error(`${label} 必须位于 0 到 1。`);
  return number;
}

function requireUnitNumberOrNull(value: unknown, label: string): number | null {
  return value === null ? null : requireUnitNumber(value, label);
}

function contentIdentityDistinctnessKey(identity: MediaContentIdentity): string {
  return canonicalJson([
    identity.algorithm,
    identity.sizeBytes,
    identity.firstSampleDigest,
    identity.middleSampleDigest,
    identity.lastSampleDigest,
    identity.algorithm === "sha256-full-file-v2" ? null : identity.modifiedUnixMs
  ]);
}

function normalizePathForDistinctness(path: string): string {
  return path.trim().split("/").join("\\").toLocaleLowerCase("en-US");
}

function assertCanonicalEqual(left: unknown, right: unknown, message: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(message);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
