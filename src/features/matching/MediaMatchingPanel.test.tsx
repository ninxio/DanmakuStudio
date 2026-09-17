import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CUT_HINT_SEARCH_SETTINGS,
  type SuspectedCutCandidate
} from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { serializeProject } from "../../domain/project/schema";
import { createDanmakuSourceSegment } from "../../domain/project/sourceTimeline";
import type {
  EditorProject,
  MediaTimeMapQualityLevel,
  ProjectMediaReference,
  ProjectMediaRole
} from "../../domain/project/types";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  isCompleteTimeMapSpanEvidence,
  type TimeMapSpan
} from "../../domain/alignment/timeMap";
import {
  isAlignmentTimeMapProposal,
  reconcileAlignmentTimeMapProposalQuality
} from "../../domain/alignment/timeMapProposal";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import {
  readTimeMapManualTakeover,
  readTimeMapSpanReviewDecision
} from "../../domain/alignment/timeMapReviewDecision";
import {
  applyAuthorityIssuedManualMediaTimeMapVerification,
  createManualMediaTimeMapVerificationRequest
} from "../../domain/alignment/mediaTimeMap";
import {
  cancelTauriAudioAlignmentBatchJob,
  cancelTauriAudioAlignmentJob,
  AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
  AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
  AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
  createAudioAlignmentBatchProposalTimeMapDigest,
  getTauriAudioAlignmentBatchJob,
  getTauriAudioAlignmentJob,
  openAudioAlignmentDiagnosticLogDirectory,
  openAudioAlignmentSensitiveManifestDirectory,
  startTauriAudioAlignmentBatchJob,
  startTauriAudioAlignmentJob,
  type AudioAlignmentBatchFineExecutionEvidenceSnapshot,
  type AudioAlignmentBatchFineFrontierReceiptSnapshot,
  type AudioAlignmentBatchFineStateCountsSnapshot,
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentJobSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import type { MediaAdapter } from "../../infrastructure/media/mediaAdapter";
import { isManualVerificationAuthorityAvailable } from "../../infrastructure/media/manualVerificationAuthority";
import { probeTauriMediaTimeline } from "../../infrastructure/media/tauriMediaProbe";
import type { MediaInventoryPublication } from "../../application/mediaInventorySupervisor";
import {
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";
import { MediaMatchingPanel } from "./MediaMatchingPanel";
import { createEpisodeMatchingProject } from "../../test/episodeMatching";
import {
  applyWorkflowDefaults,
  currentWorkflowDefaults
} from "../../application/workflowPresets";
import { AlignmentEditorWorkspace } from "../editor/AlignmentEditorWorkspace";
import { MaterialsWorkspace } from "../assets/MaterialsWorkspace";
import type { TimeMapPlaybackAdapterFactory } from "../editor/TimeMapPlaybackReview";
import { createTestCompleteTimeMapSpanPlaybackEvidence } from "../../test/manualVerification";

vi.mock("../../infrastructure/alignment/tauriAudioAlignment", async () => {
  const actual = await vi.importActual("../../infrastructure/alignment/tauriAudioAlignment");
  return {
    ...actual,
    startTauriAudioAlignmentJob: vi.fn(),
    getTauriAudioAlignmentJob: vi.fn(),
    cancelTauriAudioAlignmentJob: vi.fn(),
    startTauriAudioAlignmentBatchJob: vi.fn(),
    getTauriAudioAlignmentBatchJob: vi.fn(),
    cancelTauriAudioAlignmentBatchJob: vi.fn(),
    openAudioAlignmentDiagnosticLogDirectory: vi.fn(),
    openAudioAlignmentSensitiveManifestDirectory: vi.fn()
  };
});

vi.mock("../../infrastructure/media/manualVerificationAuthority", async () => {
  const actual = await vi.importActual(
    "../../infrastructure/media/manualVerificationAuthority"
  );
  return {
    ...actual,
    isManualVerificationAuthorityAvailable: vi.fn(() => false)
  };
});

vi.mock("../../infrastructure/media/tauriMediaProbe", async () => {
  const actual = await vi.importActual("../../infrastructure/media/tauriMediaProbe");
  return {
    ...actual,
    probeTauriMediaTimeline: vi.fn()
  };
});

const defaultIssueManualVerification =
  useEditorStore.getState().issueManualMediaTimeMapVerification;
const defaultRevokeManualVerification =
  useEditorStore.getState().revokeManualMediaTimeMapVerification;

interface LegacyBatchPairState {
  sourceMediaId: string;
  targetMediaId: string;
  snapshot: AudioAlignmentJobSnapshot;
}

interface TestFineBatchOptions {
  finalState?: AudioAlignmentBatchFineFrontierReceiptSnapshot["finalState"];
  selectedPairOrdinals?: readonly number[];
  stateCounts?: Partial<AudioAlignmentBatchFineStateCountsSnapshot>;
  inventoryCandidateCount?: number;
}

const legacyBatchJobs = new Map<string, LegacyBatchPairState[]>();
let legacyBatchSequence = 0;
let testFineBatchOptions: TestFineBatchOptions | null = null;

function installLegacyPairwiseBatchAdapter(): void {
  vi.mocked(startTauriAudioAlignmentBatchJob).mockImplementation(async (request) => {
    const jobId = `native-batch-${++legacyBatchSequence}`;
    const sources = new Map(request.sources.map((media) => [media.mediaId, media]));
    const targets = new Map(request.targets.map((media) => [media.mediaId, media]));
    const requestedPairs =
      request.pairs ??
      request.sources.flatMap((source) =>
        request.targets.map((target) => ({
          sourceMediaId: source.mediaId,
          targetMediaId: target.mediaId
        }))
      );
    const pairs: LegacyBatchPairState[] = [];
    for (const pair of requestedPairs) {
      const source = sources.get(pair.sourceMediaId);
      const target = targets.get(pair.targetMediaId);
      if (!source || !target) {
        throw new Error("测试批次引用了不存在的媒体");
      }
      try {
        const snapshot = await startTauriAudioAlignmentJob({
          sourcePath: source.path,
          completePath: target.path,
          ffmpegPath: request.ffmpegPath,
          ffprobePath: request.ffprobePath,
          spectralBackend: request.spectralBackend,
          windowMs: request.windowMs,
          minGapMs: request.minGapMs,
          matchThreshold: request.matchThreshold,
          localizationMode: request.localizationMode
        });
        pairs.push({
          sourceMediaId: pair.sourceMediaId,
          targetMediaId: pair.targetMediaId,
          snapshot
        });
      } catch (error) {
        pairs.push({
          sourceMediaId: pair.sourceMediaId,
          targetMediaId: pair.targetMediaId,
          snapshot: {
            jobId: `${jobId}-failed-${pairs.length + 1}`,
            status: "failed",
            ...audioAlignmentJobStage("failed"),
            progress: 1,
            message: "这组素材未能完成分析",
            logs: [],
            proposal: null,
            error: error instanceof Error ? error.message : "分析失败",
            updatedAtMs: 1
          }
        });
      }
    }
    legacyBatchJobs.set(jobId, pairs);
    return createLegacyBatchSnapshot(jobId, pairs);
  });
  vi.mocked(getTauriAudioAlignmentBatchJob).mockImplementation(async (jobId) => {
    const pairs = legacyBatchJobs.get(jobId);
    if (!pairs) {
      throw new Error("测试批任务不存在");
    }
    for (const pair of pairs) {
      if (pair.snapshot.status === "queued" || pair.snapshot.status === "running") {
        const next = await getTauriAudioAlignmentJob(pair.snapshot.jobId);
        if (next) {
          pair.snapshot = next;
        }
      }
    }
    return createLegacyBatchSnapshot(jobId, pairs);
  });
  vi.mocked(cancelTauriAudioAlignmentBatchJob).mockImplementation(async (jobId) => {
    const pairs = legacyBatchJobs.get(jobId);
    if (!pairs) {
      throw new Error("测试批任务不存在");
    }
    for (const pair of pairs) {
      if (pair.snapshot.status === "queued" || pair.snapshot.status === "running") {
        const cancelled = await cancelTauriAudioAlignmentJob(pair.snapshot.jobId);
        pair.snapshot =
          cancelled ??
          ({
            ...pair.snapshot,
            status: "cancelled",
            ...audioAlignmentJobStage("cancelled"),
            progress: 1,
            message: "已取消",
            proposal: null,
            error: null
          } satisfies AudioAlignmentJobSnapshot);
      }
    }
    return createLegacyBatchSnapshot(jobId, pairs);
  });
}

function createLegacyBatchSnapshot(
  jobId: string,
  pairs: readonly LegacyBatchPairState[],
  fineOptions: TestFineBatchOptions | null = testFineBatchOptions
): AudioAlignmentBatchJobSnapshot {
  const sourceMediaIds = [...new Set(pairs.map((pair) => pair.sourceMediaId))];
  const targetMediaIds = [...new Set(pairs.map((pair) => pair.targetMediaId))];
  const hasActivePair = pairs.some(
    (pair) => pair.snapshot.status === "queued" || pair.snapshot.status === "running"
  );
  const cancelled =
    !hasActivePair && pairs.some((pair) => pair.snapshot.status === "cancelled");
  const status = hasActivePair ? "running" : cancelled ? "cancelled" : "completed";
  const processedPairCount = pairs.filter(
    (pair) => pair.snapshot.status === "completed" || pair.snapshot.status === "failed"
  ).length;
  const fineFrontier = createTestFineFrontier(pairs, status, fineOptions ?? {});
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId,
    pairingMode: "explicit",
    sourceMediaIds,
    targetMediaIds,
    versionReuseGroups: [],
    status,
    progress:
      status === "running"
        ? pairs.reduce((sum, pair) => sum + pair.snapshot.progress, 0) /
          Math.max(1, pairs.length)
        : 1,
    message:
      status === "cancelled"
        ? "批次已取消"
        : status === "completed"
          ? "批次已完成"
          : "批次执行中",
    totalPairCount: pairs.length,
    processedPairCount: status === "cancelled" ? pairs.length : processedPairCount,
    failedPairCount: pairs.filter((pair) => pair.snapshot.status === "failed").length,
    currentPairOrdinal:
      pairs.findIndex(
        (pair) => pair.snapshot.status === "queued" || pair.snapshot.status === "running"
      ) + 1 || null,
    diagnosticEvents: [],
    pairs: pairs.map((pair, index) => {
      const proposal = createTestFineCompatibleProposal(pair.snapshot.proposal);
      return {
        pairIndex: index,
        pairOrdinal: index + 1,
        sourceMediaId: pair.sourceMediaId,
        targetMediaId: pair.targetMediaId,
        status: pair.snapshot.status,
        progress: pair.snapshot.progress,
        message: pair.snapshot.message,
        relationRanking: createTestBatchRelationRanking(pair.snapshot.status, proposal),
        globalSelection: createTestBatchGlobalSelection(pair.snapshot.status, proposal),
        fineFrontier:
          pair.snapshot.status === "completed" && status !== "running" ? fineFrontier : null,
        fineExecutionEvidence:
          pair.snapshot.status === "completed" &&
          status !== "running" &&
          proposal?.timeMap &&
          fineFrontier.selectedCandidateIds.some(
            (candidateId) => candidateId.pairOrdinal === index + 1
          )
            ? createTestFineExecutionEvidence(index + 1, proposal)
            : null,
        proposal,
        error: pair.snapshot.error
      };
    }),
    error: null,
    updatedAtMs: Math.max(1, ...pairs.map((pair) => pair.snapshot.updatedAtMs))
  };
}

function createTestFineCompatibleProposal(
  proposal: AlignmentProposal | null
): AlignmentProposal | null {
  if (!proposal || proposal.timeMap || !proposal.matchRange) {
    return proposal;
  }
  const range = proposal.matchRange;
  const template = createV2Proposal(range.sourceStartMs, "review").timeMap;
  if (!template) {
    throw new Error("测试 V2 TimeMap 模板缺失");
  }
  return {
    ...proposal,
    timeMap: {
      ...template,
      sourceStartMs: range.sourceStartMs,
      sourceEndMs: range.sourceEndMs,
      targetStartMs: range.targetStartMs,
      targetEndMs: range.targetEndMs,
      spans: [
        createProposalSpan(
          {
            kind: "matched",
            sourceStartMs: range.sourceStartMs,
            sourceEndMs: range.sourceEndMs,
            targetStartMs: range.targetStartMs,
            targetEndMs: range.targetEndMs
          },
          `fine-fixture-${range.sourceStartMs}:span:0001`,
          "review"
        )
      ]
    }
  };
}

function createTestFineFrontier(
  pairs: readonly LegacyBatchPairState[],
  batchStatus: AudioAlignmentBatchJobSnapshot["status"],
  options: TestFineBatchOptions
): AudioAlignmentBatchFineFrontierReceiptSnapshot {
  const candidatePairOrdinals = pairs.flatMap((pair, index) =>
    pair.snapshot.status === "completed" && pair.snapshot.proposal?.matchRange
      ? [index + 1]
      : []
  );
  const hasFailedPair = pairs.some((pair) => pair.snapshot.status === "failed");
  const finalState =
    options.finalState ??
    (batchStatus === "cancelled"
      ? "unresolved"
      : hasFailedPair
        ? "failed"
        : candidatePairOrdinals.length === 0
          ? "noEligibleCandidate"
          : "resolved");
  const resolved = finalState === "resolved";
  const selectedPairOrdinals = resolved
    ? (options.selectedPairOrdinals ?? candidatePairOrdinals).filter((ordinal) =>
        candidatePairOrdinals.includes(ordinal)
      )
    : [];
  const selectedCandidateIds = selectedPairOrdinals.map((pairOrdinal) => ({
    pairOrdinal,
    candidateOrdinal: 1
  }));
  const totalScoreMicros = selectedPairOrdinals.reduce((sum, pairOrdinal) => {
    const confidence = pairs[pairOrdinal - 1]?.snapshot.proposal?.confidence ?? 0;
    return sum + Math.round(confidence * 1_000_000);
  }, 0);
  const inventoryCandidateCount =
    options.inventoryCandidateCount ?? Math.max(candidatePairOrdinals.length, 1);
  const inventoryPairOrdinals = candidatePairOrdinals.length > 0 ? candidatePairOrdinals : [1];
  const inventoryCounts = new Map(inventoryPairOrdinals.map((pairOrdinal) => [pairOrdinal, 0]));
  for (let index = 0; index < inventoryCandidateCount; index += 1) {
    const pairOrdinal = inventoryPairOrdinals[index % inventoryPairOrdinals.length];
    inventoryCounts.set(pairOrdinal, (inventoryCounts.get(pairOrdinal) ?? 0) + 1);
  }
  const inventoryCandidates = inventoryPairOrdinals.flatMap((pairOrdinal) =>
    Array.from({ length: inventoryCounts.get(pairOrdinal) ?? 0 }, (_, index) => ({
      id: { pairOrdinal, candidateOrdinal: index + 1 },
      coarseUpperBoundMicros: 900_000 - index,
      sourceAxisReuseGroupOrdinal: null,
      targetAxisReuseGroupOrdinal: null,
      members: [
        {
          rank: index + 1,
          sourceStreamIndex: 0,
          targetStreamIndex: 0,
          score: 0.9,
          globalScore: 0.9,
          scale: 1,
          offsetMs: index * 1_000,
          sourceStartMs: index * 10_000,
          sourceEndMs: index * 10_000 + 9_000,
          targetStartMs: index * 10_000,
          targetEndMs: index * 10_000 + 9_000,
          inlierCount: 12,
          temporalCoverage: 0.9,
          uniqueSourceCoverage: 0.9
        }
      ]
    }))
  );
  const defaultStateCounts: AudioAlignmentBatchFineStateCountsSnapshot = {
    unresolved: finalState === "unresolved" ? inventoryCandidateCount : 0,
    scored: resolved ? candidatePairOrdinals.length : 0,
    evaluatedIneligible: finalState === "noEligibleCandidate" ? inventoryCandidateCount : 0,
    evidenceBlocked: 0,
    resourceBlocked: 0,
    infrastructureFailed: finalState === "failed" ? 1 : 0,
    cancelled: batchStatus === "cancelled" ? inventoryCandidateCount : 0
  };
  const inventoryStateCounts = { ...defaultStateCounts, ...options.stateCounts };
  const unresolvedCandidateIds =
    finalState === "unresolved"
      ? candidatePairOrdinals.map((pairOrdinal) => ({ pairOrdinal, candidateOrdinal: 1 }))
      : [];
  return {
    contractVersion: AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
    scoreVersion: AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
    inventoryDigest: `sha256:${"1".repeat(64)}`,
    inventoryCandidates,
    receiptDigest: `sha256:${"2".repeat(64)}`,
    componentOrdinal: 1,
    componentPairOrdinals: pairs.map((_pair, index) => index + 1),
    inventoryCandidateCount,
    resolutionMarginMicros: 10_000,
    overlapToleranceMs: 250,
    limits: {
      maxCandidates: 128,
      maxSearchStates: 100_000,
      maxSearchExpansions: 1_000_000,
      maxIntervalComparisons: 1_000_000,
      maxIntervalsPerAxis: 256,
      maxTotalIntervals: 4_096,
      refinementBatchSize: 8
    },
    inventoryStateCounts,
    refinementRoundCount: resolved ? 1 : 0,
    evaluatedCandidateCount: inventoryStateCounts.scored,
    finalState,
    resolved,
    selectedCandidateIds,
    selectedTotalScoreMicros: resolved ? totalScoreMicros : null,
    bestCompleted: { candidateIds: selectedCandidateIds, totalScoreMicros },
    runnerUpCompleted: null,
    optimisticOmitted:
      finalState === "unresolved"
        ? {
            candidateIds: unresolvedCandidateIds,
            totalUpperBoundMicros: unresolvedCandidateIds.length * 900_000,
            openCandidateIds: unresolvedCandidateIds,
            unresolvedCandidateIds,
            blockedCandidateIds: []
          }
        : null,
    nextRefinementCandidateIds: unresolvedCandidateIds,
    deferredCandidateCount: 0,
    proof: {
      beatsRunnerUpWithMargin: resolved,
      beatsOptimisticOmittedWithMargin: resolved
    },
    search: {
      statesVisited: Math.max(1, inventoryCandidateCount),
      expansionsConsidered: Math.max(1, inventoryCandidateCount),
      intervalComparisons: Math.max(1, inventoryCandidateCount)
    }
  };
}

function createTestFineExecutionEvidence(
  pairOrdinal: number,
  proposal: AlignmentProposal
): AudioAlignmentBatchFineExecutionEvidenceSnapshot {
  const timeMap = proposal.timeMap;
  if (!timeMap) {
    throw new Error("测试精执行证据需要 TimeMap");
  }
  const createWindow = (startMs: number, endMs: number, effective: boolean) => {
    const expectedSampleCount = Math.ceil(((endMs - startMs) * 16_000) / 1_000);
    return {
      startMs,
      endMs,
      presentationOffsetMs: startMs,
      sampleRate: 16_000,
      expectedSampleCount,
      actualDecodedSampleCount: effective ? expectedSampleCount : null
    };
  };
  const backend = {
    backendId: "cpu-radix2-f64-r2c-512-v1",
    requestedBackend: "auto",
    backendDetail: "unit test fine backend",
    fallbackReason: null
  };
  return {
    candidateId: { pairOrdinal, candidateOrdinal: 1 },
    selectedMemberRank: 1,
    groupMemberRanks: [1],
    sourceStreamIndex: timeMap.sourceStream?.index ?? 0,
    targetStreamIndex: timeMap.targetStream?.index ?? 0,
    sourceCoarseBackend: backend,
    targetCoarseBackend: backend,
    sourceFineBackend: backend,
    targetFineBackend: backend,
    sourceRequestedWindow: createWindow(timeMap.sourceStartMs, timeMap.sourceEndMs, false),
    targetRequestedWindow: createWindow(timeMap.targetStartMs, timeMap.targetEndMs, false),
    sourceEffectiveWindow: createWindow(timeMap.sourceStartMs, timeMap.sourceEndMs, true),
    targetEffectiveWindow: createWindow(timeMap.targetStartMs, timeMap.targetEndMs, true),
    parametersHash: `sha256:${"3".repeat(64)}`,
    occupancyDigest: `sha256:${"4".repeat(64)}`,
    proposalTimeMapDigest: createAudioAlignmentBatchProposalTimeMapDigest(timeMap),
    scoreMicros: Math.round(proposal.confidence * 1_000_000),
    evidenceDigest: `sha256:${"5".repeat(64)}`
  };
}

function createTestBatchRelationRanking(
  status: AudioAlignmentJobSnapshot["status"],
  proposal: AlignmentProposal | null
) {
  if (status === "completed") {
    const sourceStartMs = proposal?.timeMap?.sourceStartMs ?? 0;
    const sourceEndMs = Math.max(sourceStartMs + 1, proposal?.timeMap?.sourceEndMs ?? 1);
    const targetStartMs = proposal?.timeMap?.targetStartMs ?? 0;
    const targetEndMs = Math.max(targetStartMs + 1, proposal?.timeMap?.targetEndMs ?? 1);
    const candidate = {
      rank: 1,
      sourceStreamIndex: proposal?.timeMap?.sourceStream?.index ?? 0,
      targetStreamIndex: proposal?.timeMap?.targetStream?.index ?? 0,
      score: 0.9,
      globalScore: 0.8,
      scale: 1,
      offsetMs: targetStartMs - sourceStartMs,
      sourceStartMs,
      sourceEndMs,
      targetStartMs,
      targetEndMs,
      inlierCount: 20,
      temporalCoverage: 0.8,
      uniqueSourceCoverage: 0.7
    };
    return {
      scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
      executionIdentityDigest: `sha256:${"d".repeat(64)}` as const,
      executionIdentity: createTestExecutionIdentity(),
      state: "ranked" as const,
      candidateCount: 1,
      eligibleCandidateCount: 1,
      score: candidate.globalScore,
      bestEligibleCandidate: candidate
    };
  }
  return {
    scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
    executionIdentityDigest: null,
    executionIdentity: null,
    state:
      status === "failed"
        ? ("failed" as const)
        : status === "cancelled"
          ? ("cancelled" as const)
          : ("pending" as const),
    candidateCount: 0,
    eligibleCandidateCount: 0,
    score: null,
    bestEligibleCandidate: null
  };
}

function createTestExecutionIdentity() {
  return {
    schemaVersion: 1 as const,
    engineVersion: "alignment-v2.2-rust",
    featureVersion: "test-feature-v1",
    relationScoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
    nativeExecutableDigest: `sha256:${"a".repeat(64)}` as const,
    ffmpegBinaryDigest: `sha256:${"b".repeat(64)}` as const,
    ffprobeBinaryDigest: `sha256:${"c".repeat(64)}` as const,
    sourceSpectralBackends: [
      {
        backendId: "cpu-radix2-f64-r2c-512-v1",
        requestedBackend: "cpu",
        backendDetail: "test CPU",
        fallbackReason: null
      }
    ],
    targetSpectralBackends: [
      {
        backendId: "cpu-radix2-f64-r2c-512-v1",
        requestedBackend: "cpu",
        backendDetail: "test CPU",
        fallbackReason: null
      }
    ]
  };
}

function createTestBatchGlobalSelection(
  status: AudioAlignmentJobSnapshot["status"],
  proposal: AlignmentProposal | null
) {
  if (status === "completed") {
    const blocked = proposal?.timeMap?.quality.level === "blocked";
    if (!blocked) {
      const sourceStartMs = proposal?.timeMap?.sourceStartMs ?? 0;
      const sourceEndMs = Math.max(sourceStartMs + 1, proposal?.timeMap?.sourceEndMs ?? 1);
      const targetStartMs = proposal?.timeMap?.targetStartMs ?? 0;
      const targetEndMs = Math.max(targetStartMs + 1, proposal?.timeMap?.targetEndMs ?? 1);
      const candidate = {
        rank: 1,
        sourceStreamIndex: proposal?.timeMap?.sourceStream?.index ?? 0,
        targetStreamIndex: proposal?.timeMap?.targetStream?.index ?? 0,
        score: 0.9,
        globalScore: 0.8,
        scale: 1,
        offsetMs: targetStartMs - sourceStartMs,
        sourceStartMs,
        sourceEndMs,
        targetStartMs,
        targetEndMs,
        inlierCount: 20,
        temporalCoverage: 0.8,
        uniqueSourceCoverage: 0.7,
        eligible: true,
        globalSelected: true
      };
      return {
        state: "selected" as const,
        selected: true,
        selectedRank: 1,
        selectedScore: 0.8,
        decisionRank: 1,
        decisionScore: 0.8,
        margin: 1,
        candidateCount: 1,
        eligibleCandidateCount: 1,
        topK: [candidate],
        decisionCandidate: candidate
      };
    }
    return {
      state: "blocked" as const,
      selected: false,
      selectedRank: null,
      selectedScore: null,
      decisionRank: null,
      decisionScore: null,
      margin: 0,
      candidateCount: 0,
      eligibleCandidateCount: 0,
      topK: [],
      decisionCandidate: null
    };
  }
  return {
    state:
      status === "failed"
        ? ("failed" as const)
        : status === "cancelled"
          ? ("cancelled" as const)
          : ("pending" as const),
    selected: false,
    selectedRank: null,
    selectedScore: null,
    decisionRank: null,
    decisionScore: null,
    margin: null,
    candidateCount: 0,
    eligibleCandidateCount: 0,
    topK: [],
    decisionCandidate: null
  };
}

function audioAlignmentJobStage(
  status: AudioAlignmentJobSnapshot["status"]
): Pick<
  AudioAlignmentJobSnapshot,
  "stageKey" | "stageLabel" | "stageIndex" | "stageCount" | "stageProgress"
> {
  if (status === "queued") {
    return {
      stageKey: "queued",
      stageLabel: "排队",
      stageIndex: 0,
      stageCount: 9,
      stageProgress: 0
    };
  }
  if (status === "running") {
    return {
      stageKey: "extracting-complete",
      stageLabel: "提取完整版特征",
      stageIndex: 2,
      stageCount: 9,
      stageProgress: 0.5
    };
  }
  return {
    stageKey: status,
    stageLabel: status === "completed" ? "已完成" : status === "failed" ? "失败" : "已取消",
    stageIndex: 9,
    stageCount: 9,
    stageProgress: 1
  };
}

function createTestBatchPair(
  sourceMediaId: string,
  targetMediaId: string,
  status: AudioAlignmentJobSnapshot["status"],
  proposal: AlignmentProposal | null = null,
  message: string = status
): LegacyBatchPairState {
  return {
    sourceMediaId,
    targetMediaId,
    snapshot: {
      jobId: `pair-${sourceMediaId}-${targetMediaId}`,
      status,
      progress: status === "queued" ? 0 : status === "running" ? 0.35 : 1,
      message,
      ...audioAlignmentJobStage(status),
      logs: [],
      proposal,
      error: status === "failed" ? message : null,
      updatedAtMs: 1
    }
  };
}

describe("多媒体自动匹配工作台", () => {
  it("测试 V2 fixture 满足 v12 逐段证据契约", () => {
    const proposal = createV2Proposal(0, "verified").timeMap;
    expect(proposal).toBeDefined();
    expect(proposal?.spans.every(isCompleteTimeMapSpanEvidence)).toBe(true);
    expect(isAlignmentTimeMapProposal(proposal)).toBe(true);
    if (!proposal) throw new Error("测试提案缺失");
    expect(isAlignmentTimeMapProposal(reconcileAlignmentTimeMapProposalQuality(proposal))).toBe(
      true
    );
  });
  beforeEach(() => {
    window.localStorage.clear();
    testFineBatchOptions = null;
    const project = createMatchingProject();
    useEditorStore.setState({
      project,
      selection: { kind: "none", ids: [] },
      history: createHistoryState(),
      isPlaying: false,
      status: { message: "准备就绪", tone: "neutral" },
      importProgress: null,
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
      timelineTool: "select",
      workspacePage: "matching",
      alignmentEditorCandidateId: null,
      projectEpoch: 0,
      mediaInventoryGeneration: 0,
      mediaInventoryGenerationKey: null,
      mediaInventoryPhase: "idle",
      mediaInventoryCounts: null,
      mediaInventoryRows: {},
      mediaInventoryPaused: false,
      mediaInventoryCancelling: false,
      mediaInventoryRestartRequired: false,
      mediaInventoryTerminalMessage: null,
      workspaceIntentSequence: 0,
      workspaceIntentRequest: null,
      issueManualMediaTimeMapVerification: defaultIssueManualVerification,
      revokeManualMediaTimeMapVerification: defaultRevokeManualVerification
    });
    publishMatchingInventory(project);
    vi.mocked(isManualVerificationAuthorityAvailable).mockReturnValue(false);
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) =>
      Promise.resolve({
        jobId: request.completePath.includes("ep1") ? "job-ep1" : "job-ep2",
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: ["使用缓存音频特征"],
        proposal: createProposal(request.completePath.includes("ep1") ? 0 : 60_000),
        error: null,
        updatedAtMs: 1
      })
    );
    vi.mocked(getTauriAudioAlignmentJob).mockReset();
    vi.mocked(cancelTauriAudioAlignmentJob).mockReset();
    vi.mocked(openAudioAlignmentDiagnosticLogDirectory).mockResolvedValue(undefined);
    vi.mocked(openAudioAlignmentSensitiveManifestDirectory).mockResolvedValue(undefined);
    vi.mocked(probeTauriMediaTimeline).mockImplementation((request) =>
      Promise.resolve({
        presentationOriginMs: 0,
        durationMs: 60_000,
        contentIdentity: null,
        videoStreams: [],
        preferredAudioStreamIndex: 1,
        audioStreams: [
          {
            index: 1,
            codec: "aac",
            startMs: 0,
            timelineOffsetMs: 0,
            durationMs: 60_000,
            timeBase: "1/48000",
            language: "deu",
            title: "German",
            default: true,
            commentary: false,
            sampleRate: 48_000,
            channels: 2
          },
          ...(request.path.includes("ep")
            ? [
                {
                  index: 2,
                  codec: "aac",
                  startMs: 0,
                  timelineOffsetMs: 0,
                  durationMs: 60_000,
                  timeBase: "1/48000",
                  language: "eng",
                  title: "English",
                  default: false,
                  commentary: false,
                  sampleRate: 48_000,
                  channels: 2
                }
              ]
            : [])
        ]
      })
    );
    legacyBatchJobs.clear();
    installLegacyPairwiseBatchAdapter();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("匹配页只负责计算和候选摘要，不再挂载人工复核工作台", async () => {
    render(<MatchingHarness />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始批量匹配" })).toBeInTheDocument()
    );
    expect(screen.queryByText("独立复核队列")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("算法改进数据工作台")).not.toBeInTheDocument();
  });

  it("首屏用唯一 Run Bar 汇总 cohort、音轨与批次主动作", async () => {
    render(<MatchingHarness />);

    const runConsole = await screen.findByRole("region", { name: "匹配结果" });
    expect(within(runConsole).getByTestId("matching-summary")).toHaveTextContent("1 个参考");
    expect(within(runConsole).getByTestId("matching-summary")).toHaveTextContent("2 个原片");
    expect(within(runConsole).getByTestId("matching-summary")).toHaveTextContent("2 组关系");
    expect(within(runConsole).getByTestId("matching-summary")).toHaveTextContent(
      "3 / 3 音轨就绪"
    );
    expect(within(runConsole).getAllByRole("button", { name: "开始批量匹配" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "开始批量匹配" })).toHaveLength(1);
    expect(within(runConsole).getByText("运行队列")).toBeInTheDocument();
    expect(within(runConsole).getByText("还没有运行记录")).toBeInTheDocument();
  });

  it("直接使用项目素材批量生成并确认一对多候选", async () => {
    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());
    expect(
      matchingConfigurationQuery().getByTestId("spectral-backend-policy")
    ).toHaveTextContent("计算策略：自动推荐");
    expect(screen.queryByLabelText("完整版输入")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择当前视频" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          {
            mediaId: "source-long",
            path: "D:\\video\\collection.mkv",
            audioStreamIndex: 2
          }
        ],
        targets: [
          { mediaId: "target-ep1", path: "D:\\video\\ep1.mkv", audioStreamIndex: 2 },
          { mediaId: "target-ep2", path: "D:\\video\\ep2.mkv", audioStreamIndex: 2 }
        ],
        pairs: [
          { sourceMediaId: "source-long", targetMediaId: "target-ep1" },
          { sourceMediaId: "source-long", targetMediaId: "target-ep2" }
        ],
        versionReuseGroups: [],
        spectralBackend: "auto",
        localizationMode: true
      })
    );
    expect(getMatchingCandidates()).toHaveLength(2);
    expect(screen.getAllByText(/target-ep1 ← source-long/).length).toBeGreaterThan(0);
    expect(useEditorStore.getState().status.message).toBe("批量匹配完成：2 组可逐项确认。");
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.every(
          (candidate) =>
            candidate.state === "pending" &&
            candidate.proposal.diagnostics.includes(
              "原生精匹配：组件最终分配已解析，当前候选由后端选定。"
            )
        )
    ).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "进入编辑工作台" })[0]);
    expect(await screen.findByTestId("alignment-editor-workspace")).toBeInTheDocument();
    selectWorkspaceAction("关系工具", "保存为待复核关系");
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    const secondCandidate = useEditorStore
      .getState()
      .project.mediaMatchCandidates.find((candidate) => candidate.state === "pending");
    if (!secondCandidate) throw new Error("第二条候选缺失");
    act(() => useEditorStore.getState().selectAlignmentEditorCandidate(secondCandidate.id));
    selectWorkspaceAction("关系工具", "保存为待复核关系");

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(2)
    );
    expect(
      useEditorStore
        .getState()
        .project.danmakuSourceSegments.map((segment) => segment.targetMediaId)
    ).toEqual(expect.arrayContaining(["target-ep1", "target-ep2"]));
    expect(useEditorStore.getState().project.cutMarkers).toEqual([]);
    expect(useEditorStore.getState().project.syncAnchors).toEqual([]);

    selectWorkspaceAction("关系工具", "撤销关系确认并继续编辑");
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.map((candidate) => candidate.state)
        .sort()
    ).toEqual(["accepted", "pending"]);
  });

  it("重新挂载后恢复逐 case 回执，不把上次运行中的任务伪装成新结果", async () => {
    const first = render(<MatchingHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(
      matchingResultQuery().getByTestId("alignment-experiment-queue-status")
    ).toHaveTextContent("已保存 2 份终态回执");
    first.unmount();

    render(<MatchingHarness />);
    expect(
      await matchingResultQuery().findByTestId("alignment-experiment-queue-status")
    ).toHaveTextContent("2 个组合");
    expect(
      matchingResultQuery().getByTestId("alignment-experiment-queue-status")
    ).toHaveTextContent("已保存 2 份终态回执");
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
  });

  it("根据季集范围把 2×8 缩小为八个显式关系且保留全部组合开关", async () => {
    const project = createMatchingProject();
    const sources = [
      createMedia(
        "source-1-4",
        "bilibiliReference",
        "D:\\video\\5-第三季1-4-720P 准高清-HEVC.mp4",
        19_830_513
      ),
      createMedia(
        "source-5-8",
        "bilibiliReference",
        "D:\\video\\6-第三季5-8-720P 准高清-HEVC.mp4",
        21_479_104
      )
    ];
    const targets = Array.from({ length: 8 }, (_, index) =>
      createMedia(
        `target-${index + 1}`,
        "targetOriginal",
        `D:\\video\\Dark.S03E${String(index + 1).padStart(2, "0")}.mkv`,
        3_600_000
      )
    );
    project.mediaLibrary = [...sources, ...targets];
    setMatchingProject(project);
    render(<MatchingHarness />);

    expect(
      await matchingConfigurationQuery().findByTestId("smart-pairing-summary")
    ).toHaveTextContent("建议分析 8 组，跳过 8 组");
    expect(screen.getByText(/共 8 组/)).toBeInTheDocument();
    fireEvent.change(matchingConfigurationQuery().getByLabelText("匹配组合范围"), {
      target: { value: "all" }
    });
    expect(screen.getByText(/共 16 组/)).toBeInTheDocument();
    fireEvent.change(matchingConfigurationQuery().getByLabelText("匹配组合范围"), {
      target: { value: "smart" }
    });
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        pairs: [
          ...targets.slice(0, 4).map((target) => ({
            sourceMediaId: "source-1-4",
            targetMediaId: target.id
          })),
          ...targets.slice(4).map((target) => ({
            sourceMediaId: "source-5-8",
            targetMediaId: target.id
          }))
        ]
      })
    );
  });

  it("绑定 XML 的四十段在界面生成四十组，修正可撤销，桥接只提交分集关系", async () => {
    const project = createEpisodeMatchingProject();
    // Existing batch bridge fixture emits offset proposals across the inventory.
    project.mediaLibrary = project.mediaLibrary.map((media) => ({
      ...media,
      durationMs: 3_600_000
    }));
    setMatchingProject(project);
    render(<MatchingHarness />);
    const configuration = matchingConfigurationQuery();
    expect(await configuration.findByTestId("smart-pairing-summary")).toHaveTextContent(
      "建议分析 40 组，跳过 280 组"
    );
    fireEvent.click(configuration.getByText("查看分集对应与修正编号"));
    expect(configuration.getByText(/Show S1E1 ← 5 个参考/)).toBeInTheDocument();
    fireEvent.change(configuration.getByLabelText("参考集号"), { target: { value: "S01E02" } });
    fireEvent.click(configuration.getByRole("button", { name: "应用参考集号" }));
    expect(configuration.getByText(/Show S1E1 ← 4 个参考/)).toBeInTheDocument();
    expect(configuration.getByText(/Show S1E2 ← 6 个参考/)).toBeInTheDocument();
    act(() => useEditorStore.getState().undo());
    expect(configuration.getByText(/Show S1E1 ← 5 个参考/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    const request = vi.mocked(startTauriAudioAlignmentBatchJob).mock.calls[0][0];
    expect(request.pairs).toHaveLength(40);
    expect(
      request.pairs
        ?.filter((pair) => pair.targetMediaId === "target-1")
        .map((pair) => pair.sourceMediaId)
    ).toEqual(["source-1", "source-2", "source-3", "source-4", "source-5"]);
    expect(useEditorStore.getState().project.assets).toEqual(project.assets);
  });

  it.each([257, 320])("拒绝 %s 个待分析组合时不生成伪运行任务", async (count) => {
    const project = createMatchingProject();
    const source = createMedia(
      "source-long",
      "bilibiliReference",
      "D:/video/reference.wav",
      180_000
    );
    project.mediaLibrary = [
      source,
      ...Array.from({ length: count }, (_, i) =>
        createMedia(`target-${i}`, "targetOriginal", `D:/video/target-${i}.wav`, 60_000)
      )
    ];
    setMatchingProject(project);
    render(<MatchingHarness />);
    fireEvent.change(await matchingConfigurationQuery().findByLabelText("匹配组合范围"), {
      target: { value: "all" }
    });
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    expect(
      await screen.findByText(new RegExp(`本次还有 ${count} 组待分析，单批最多 256 组`))
    ).toHaveAttribute("role", "alert");
    expect(startTauriAudioAlignmentBatchJob).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("matching-run-row")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "开始批量匹配" })).toBeEnabled();
  });

  it("批次容量只计算待分析关系，已有关系不会消耗名额", async () => {
    const project = createMatchingProject();
    const source = project.mediaLibrary[0];
    const targets = Array.from({ length: 257 }, (_, i) =>
      createMedia(`target-${i}`, "targetOriginal", `D:/video/target-${i}.wav`, 60_000)
    );
    project.mediaLibrary = [source, ...targets];
    project.danmakuSourceSegments = targets.slice(0, 255).map((target, i) =>
      createDanmakuSourceSegment(`saved-${i}`, {
        kind: "content",
        assetId: null,
        sourceMediaId: source.id,
        targetMediaId: target.id,
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetStartMs: 0,
        episodeKey: null,
        episodeLabel: null
      })
    );
    setMatchingProject(project);
    render(<MatchingHarness />);
    fireEvent.change(await matchingConfigurationQuery().findByLabelText("匹配组合范围"), {
      target: { value: "all" }
    });
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startTauriAudioAlignmentBatchJob).mock.calls[0][0].pairs).toHaveLength(2);
    expect(screen.queryByText(/单批最多 256 组/)).not.toBeInTheDocument();
  });

  it("不再逐文件检查音轨，并把 inventory gate 的最终索引交给旧 proof", async () => {
    const project = createMatchingProject();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "target-ep1"
        ? {
            ...media,
            audioTrackIntent: {
              mode: "explicit" as const,
              streamIndex: 7,
              inventoryRevision: MATCHING_INVENTORY_REVISION
            }
          }
        : media
    );
    setMatchingProject(project, {
      "target-ep1": { recommendation: "needsChoice", indexes: [2, 7] }
    });

    render(<MatchingHarness />);

    expect(screen.queryByRole("button", { name: "检查所选素材音轨" })).not.toBeInTheDocument();
    expect(probeTauriMediaTimeline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    const request = vi.mocked(startTauriAudioAlignmentBatchJob).mock.calls[0]?.[0];
    expect(request?.sources).toEqual([
      {
        mediaId: "source-long",
        path: "D:\\video\\collection.mkv",
        audioStreamIndex: 2
      }
    ]);
    expect(request?.targets).toEqual([
      { mediaId: "target-ep1", path: "D:\\video\\ep1.mkv", audioStreamIndex: 7 },
      { mediaId: "target-ep2", path: "D:\\video\\ep2.mkv", audioStreamIndex: 2 }
    ]);
    expect(probeTauriMediaTimeline).not.toHaveBeenCalled();
  });

  it("顶部主按钮遇到阻断项会回素材页聚焦异常，取消勾选后只运行 ready 子集", async () => {
    const project = createMatchingProject();
    setMatchingProject(project, { "target-ep1": { recommendation: "needsChoice" } });
    render(<MatchingWorkflowHarness />);

    expect(screen.queryByRole("button", { name: "开始智能匹配" })).not.toBeInTheDocument();
    const primaryBlockerAction = screen.getByRole("button", { name: "处理 1 个音轨" });
    expect(
      screen.getByText("匹配结果已保留。可以查看覆盖并采用，未定位部分单独显示。")
    ).toBeInTheDocument();
    fireEvent.click(primaryBlockerAction);

    const targetDetails = await screen.findByRole("dialog", { name: "素材详情与音轨" });
    expect(targetDetails).toHaveTextContent("ep1.mkv");
    await waitFor(() => expect(targetDetails.contains(document.activeElement)).toBe(true));
    expect(useEditorStore.getState().workspaceIntentRequest).toBeNull();

    act(() => useEditorStore.getState().setWorkspacePage("matching"));
    fireEvent.click(await screen.findByRole("button", { name: "处理 1 个音轨" }));
    const repeatedDetails = await screen.findByRole("dialog", { name: "素材详情与音轨" });
    expect(repeatedDetails).toHaveTextContent("ep1.mkv");
    await waitFor(() => expect(repeatedDetails.contains(document.activeElement)).toBe(true));
    expect(useEditorStore.getState().workspaceIntentSequence).toBe(2);
    expect(useEditorStore.getState().workspaceIntentRequest).toBeNull();

    act(() => useEditorStore.getState().setWorkspacePage("matching"));
    const blockedTarget = await matchingConfigurationQuery().findByRole("checkbox", {
      name: /target-ep1/
    });
    fireEvent.click(blockedTarget);
    expect(
      screen.queryByRole("button", { name: "回素材页处理 1 个音轨" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始智能匹配" })).not.toBeInTheDocument();
    const startButton = screen.getByRole("button", { name: "开始批量匹配" });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startTauriAudioAlignmentBatchJob).mock.calls[0]?.[0].targets).toEqual([
      { mediaId: "target-ep2", path: "D:\\video\\ep2.mkv", audioStreamIndex: 2 }
    ]);
  });

  it("session restart-required 优先阻断顶部、底部与 stale runBatch，取消故障行也不能启动", async () => {
    const project = createMatchingProject();
    setMatchingProject(project);
    render(<MatchingHarness />);
    const staleStartButton = screen.getByRole("button", { name: "开始批量匹配" });
    expect(staleStartButton).toBeEnabled();
    const generationKey = useEditorStore.getState().mediaInventoryGenerationKey!;
    const restartMessage = "媒体清单进程清理状态不确定，需重启应用。";

    await act(async () => {
      useEditorStore.getState().applyMediaInventoryPublication({
        generationKey,
        phase: "failed",
        counts: {
          total: project.mediaLibrary.length,
          queued: 0,
          probing: 0,
          ready: project.mediaLibrary.length,
          failed: 0,
          cancelled: 0
        },
        changedRows: [],
        terminalMessage: restartMessage,
        restartRequired: true
      });
      staleStartButton.click();
      await Promise.resolve();
    });

    expect(startTauriAudioAlignmentBatchJob).not.toHaveBeenCalled();
    expect(matchingConfigurationQuery().getByText(restartMessage)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "重启应用后继续" })) {
      expect(button).toBeDisabled();
    }

    act(() => {
      useEditorStore.getState().applyMediaInventoryPublication({
        generationKey,
        phase: "failed",
        counts: {
          total: project.mediaLibrary.length,
          queued: 0,
          probing: 0,
          ready: project.mediaLibrary.length - 1,
          failed: 1,
          cancelled: 0
        },
        changedRows: [
          {
            mediaId: "target-ep1",
            status: "failed",
            error: { code: "processCleanupUncertain", message: restartMessage }
          }
        ],
        terminalMessage: restartMessage,
        restartRequired: true
      });
    });
    fireEvent.click(matchingConfigurationQuery().getByRole("checkbox", { name: /target-ep1/ }));

    expect(matchingConfigurationQuery().getByText(restartMessage)).toBeInTheDocument();
    expect(startTauriAudioAlignmentBatchJob).not.toHaveBeenCalled();
  });

  it("accepted 关系缺少 confirmed TimeMap 时保持阻断且不能进入校准", async () => {
    render(<MatchingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    act(() => acceptAllMatchingCandidates(null));

    expect(screen.getByRole("region", { name: "已阻断 2 个" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看覆盖并导出（2 个结果）" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "查看覆盖并导出" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "已确认 2 个" })).not.toBeInTheDocument();
  });

  it.each([
    ["blocked", "已阻断"],
    ["review", "需复核"],
    ["legacy-unverified", "需复核"]
  ] as const)(
    "accepted + confirmed %s 进入 %s 而不是正常完成",
    async (qualityLevel, expectedGroup) => {
      render(<MatchingHarness />);
      fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
      await waitFor(() =>
        expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
      );

      act(() => acceptAllMatchingCandidates(qualityLevel));

      expect(screen.getByRole("region", { name: `${expectedGroup} 2 个` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "查看覆盖并导出（2 个结果）" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "查看覆盖并导出" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "已确认 2 个" })).not.toBeInTheDocument();
    }
  );

  it("只有部分 accepted 关系的 confirmed TimeMap verified 时仍先定位异常", async () => {
    render(<MatchingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    act(() => acceptMatchingCandidatesWithQualities(["verified", "review"]));

    expect(screen.getByRole("region", { name: "需复核 1 个" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "已确认 1 个" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看覆盖并导出（1 个结果）" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "查看覆盖并导出" })).not.toBeInTheDocument();
  });

  it("全部 accepted 关系都有 confirmed verified TimeMap 时才开放进入校准", async () => {
    render(<MatchingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    act(() => acceptAllMatchingCandidates("verified"));

    expect(screen.getByRole("region", { name: "已确认 2 个" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看覆盖并导出" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /检查 .*个结果/ })).not.toBeInTheDocument();
  });

  it("session restart-required 不遮蔽已有候选审核与已完成关系的校准入口", async () => {
    const project = createMatchingProject();
    setMatchingProject(project);
    render(<MatchingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    const generationKey = useEditorStore.getState().mediaInventoryGenerationKey!;
    act(() => {
      useEditorStore.getState().applyMediaInventoryPublication({
        generationKey,
        phase: "failed",
        counts: {
          total: project.mediaLibrary.length,
          queued: 0,
          probing: 0,
          ready: project.mediaLibrary.length,
          failed: 0,
          cancelled: 0
        },
        changedRows: [],
        terminalMessage: "媒体清单进程清理状态不确定，需重启应用。",
        restartRequired: true
      });
    });

    const reviewButton = screen.getByRole("button", { name: "查看覆盖并导出（2 个结果）" });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);
    expect(useEditorStore.getState().workspacePage).toBe("editing");
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
  });

  it("把持久化的强制 GPU 策略送入整个原生批次并就地说明失败不回退", async () => {
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      alignment: {
        ...DEFAULT_APP_SETTINGS.alignment,
        spectralBackend: "cuda"
      }
    });
    render(<MatchingHarness />);

    expect(
      await matchingConfigurationQuery().findByTestId("spectral-backend-policy")
    ).toHaveTextContent("CUDA/cuFFT 不可用或执行失败时停止本次匹配，不回退 CPU");
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ spectralBackend: "cuda" })
    );
  });

  it("允许在匹配页为本次批次直接切换 CPU，不依赖重新打开设置", async () => {
    render(<MatchingHarness />);

    fireEvent.change(await matchingConfigurationQuery().findByLabelText("本次匹配计算设备"), {
      target: { value: "cpu" }
    });
    expect(
      matchingConfigurationQuery().getByTestId("spectral-backend-policy")
    ).toHaveTextContent("本次匹配完全禁用 CUDA");
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ spectralBackend: "cpu" })
    );
  });
  it("手选GPU后明确应用CPU预设，已挂载面板的下一次原生请求采用新预设", async () => {
    render(<MatchingHarness />);
    const select = await matchingConfigurationQuery().findByLabelText("本次匹配计算设备");
    fireEvent.change(select, { target: { value: "cuda" } });
    await waitFor(() => expect(currentWorkflowDefaults().spectralBackend).toBe("cuda"));
    await act(async () =>
      applyWorkflowDefaults({
        ...currentWorkflowDefaults(),
        spectralBackend: "cpu",
        windowMs: 12000,
        minGapMs: 1500,
        matchThreshold: 0.71
      })
    );
    expect(select).toHaveValue("cpu");
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        spectralBackend: "cpu",
        windowMs: 12000,
        minGapMs: 1500,
        matchThreshold: 0.71
      })
    );
  });

  it("多版本复用默认关闭，只有显式勾选后才把所选原片绑定为版本组", async () => {
    render(<MatchingHarness />);

    expect(
      matchingConfigurationQuery().getByLabelText(/所选 B 站参考素材是同一内容的不同版本/)
    ).toBeDisabled();
    fireEvent.click(screen.getByText("高级：同一内容的多个版本"));
    fireEvent.click(screen.getByLabelText(/所选原片素材是同一内容的不同版本/));
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        versionReuseGroups: [
          {
            groupId: "selected-target-versions",
            side: "target",
            mediaIds: ["target-ep1", "target-ep2"]
          }
        ]
      })
    );
  });

  it("共享媒体预处理期间显示真实批次阶段，不把所有组合误报为逐组排队", async () => {
    const preparingSnapshot = {
      ...createLegacyBatchSnapshot("batch-preparing", [
        createTestBatchPair("source-long", "target-ep1", "queued", null, "等待执行"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ]),
      status: "running" as const,
      progress: 0.08,
      message: "正在预处理第 1/3 个素材（B 站参考）：读取 PTS、音轨并生成共享声谱特征。",
      currentPairOrdinal: null,
      diagnosticEvents: [
        {
          sequence: 1,
          atMs: 1_000,
          elapsedMs: 12_345,
          level: "info" as const,
          stageKey: "media.timeline-probe",
          mediaOrdinal: 1,
          pairOrdinal: null,
          message: "媒体身份与容器时间线读取完成。",
          durationMs: 10_500
        }
      ]
    } satisfies AudioAlignmentBatchJobSnapshot;
    const cancelledSnapshot = createLegacyBatchSnapshot("batch-preparing", [
      createTestBatchPair("source-long", "target-ep1", "cancelled", null, "已停止"),
      createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已停止")
    ]);
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(preparingSnapshot);
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockResolvedValueOnce(cancelledSnapshot);
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    const taskList = await screen.findByLabelText("批量匹配任务");
    await waitFor(() => {
      const taskMessages = within(taskList).getAllByTestId("batch-task-message");
      expect(taskMessages).toHaveLength(2);
      for (const taskMessage of taskMessages) {
        expect(taskMessage).toHaveTextContent(/正在预处理第 1\/3 个素材/);
      }
    });
    expect(within(taskList).getAllByText("运行中")).toHaveLength(2);
    expect(within(taskList).getAllByText("8%")).toHaveLength(2);
    expect(screen.queryByText("等待前面的组合完成")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "结果详情与运行记录" }));
    expect(screen.getByLabelText("脱敏运行诊断")).toHaveTextContent(
      "[+0:12.345] [信息] [素材 #1] 媒体身份与容器时间线读取完成。（本阶段耗时 0:10.500）"
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭结果详情与运行记录" }));
    fireEvent.click(within(taskList).getByText("批次诊断与运行编号"));
    expect(within(taskList).getByText("batch-preparing")).toBeInTheDocument();
    fireEvent.click(within(taskList).getByRole("button", { name: "打开可分享日志" }));
    await waitFor(() =>
      expect(openAudioAlignmentDiagnosticLogDirectory).toHaveBeenCalledTimes(1)
    );
    expect(useEditorStore.getState().status.message).toContain("已打开脱敏诊断日志目录");

    fireEvent.click(within(taskList).getByRole("button", { name: "打开本机训练证据" }));
    await waitFor(() =>
      expect(openAudioAlignmentSensitiveManifestDirectory).toHaveBeenCalledTimes(1)
    );
    expect(useEditorStore.getState().status.message).toContain("只能留在本机");

    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));
    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("batch-preparing")
    );
  });

  it("只启动一个原生批次并用同一 jobId 轮询一对多结果", async () => {
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-poll-once", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "正在检查第一组"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    vi.mocked(getTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-poll-once", [
        createTestBatchPair(
          "source-long",
          "target-ep1",
          "completed",
          createProposal(0),
          "完成"
        ),
        createTestBatchPair(
          "source-long",
          "target-ep2",
          "completed",
          createProposal(60_000),
          "完成"
        )
      ])
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(getTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(getTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("batch-poll-once");
    expect(startTauriAudioAlignmentJob).not.toHaveBeenCalled();
  });

  it("轮询异常时先停止仍在运行的原生批次，再释放前端任务引用", async () => {
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-poll-error", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "正在分析"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    vi.mocked(getTauriAudioAlignmentBatchJob).mockRejectedValueOnce(new Error("状态读取失败"));
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-poll-error", [
        createTestBatchPair("source-long", "target-ep1", "cancelled", null, "已停止"),
        createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已停止")
      ])
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("batch-poll-error")
    );
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("批量匹配已取消")
    );
    expect(screen.getByRole("button", { name: "继续剩余任务" })).toBeEnabled();
  });

  it("原生批次清理未确认时保留任务引用，并阻止新的批次覆盖它", async () => {
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-cleanup-uncertain", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "正在分析"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    vi.mocked(getTauriAudioAlignmentBatchJob).mockRejectedValueOnce(new Error("状态读取失败"));
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockRejectedValue(
      new Error("无法确认原生任务已停止")
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("清理状态不确定")
    );
    expect(useEditorStore.getState().status.message).toContain("状态读取失败");
    expect(useEditorStore.getState().status.message).toContain("无法确认原生任务已停止");
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("已拒绝启动新任务")
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(2);
  });

  it("等待旧批次 cancel 时 inventory sticky 到达，返回后不创建 queue 或启动新批次", async () => {
    const cancelDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-await-recheck", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "正在分析"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    vi.mocked(getTauriAudioAlignmentBatchJob).mockRejectedValueOnce(new Error("状态读取失败"));
    vi.mocked(cancelTauriAudioAlignmentBatchJob)
      .mockRejectedValueOnce(new Error("无法确认原生任务已停止"))
      .mockReturnValueOnce(cancelDeferred.promise);
    render(<MatchingHarness />);
    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("清理状态不确定")
    );
    const queueKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith("danmaku-studio:alignment-experiment-queue:v1:")
    );
    expect(queueKey).toBeDefined();
    const queueBefore = window.localStorage.getItem(queueKey!);

    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(2));
    const generationKey = useEditorStore.getState().mediaInventoryGenerationKey!;
    await act(async () => {
      useEditorStore.getState().applyMediaInventoryPublication({
        generationKey,
        phase: "failed",
        counts: { total: 3, queued: 0, probing: 0, ready: 3, failed: 0, cancelled: 0 },
        changedRows: [],
        terminalMessage: "媒体清单进程清理状态不确定，需重启应用。",
        restartRequired: true
      });
      cancelDeferred.resolve(
        createLegacyBatchSnapshot("batch-await-recheck", [
          createTestBatchPair("source-long", "target-ep1", "cancelled", null, "已停止"),
          createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已停止")
        ])
      );
      await cancelDeferred.promise;
    });

    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("需重启应用")
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(queueKey!)).toBe(queueBefore);
  });

  it("轮询与清理首次失败后重新读取真实终态，并采用已完成结果", async () => {
    const runningSnapshot = createLegacyBatchSnapshot("batch-terminal-reconcile", [
      createTestBatchPair("source-long", "target-ep1", "running", null, "正在分析"),
      createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
    ]);
    const terminalSnapshot = createLegacyBatchSnapshot("batch-terminal-reconcile", [
      createTestBatchPair("source-long", "target-ep1", "completed", createProposal(0), "完成"),
      createTestBatchPair(
        "source-long",
        "target-ep2",
        "completed",
        createProposal(60_000),
        "完成"
      )
    ]);
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(runningSnapshot);
    vi.mocked(getTauriAudioAlignmentBatchJob)
      .mockRejectedValueOnce(new Error("终态响应首次读取失败"))
      .mockResolvedValueOnce(terminalSnapshot);
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockRejectedValueOnce(
      new Error("终态清理首次确认失败")
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(getTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(2);
    expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().status.message).not.toContain("清理状态不确定");
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(within(taskList).queryByText("失败")).not.toBeInTheDocument();
  });

  it("缺少本地路径的素材会用唯一主动作返回素材页重连", async () => {
    const project = createMatchingProject();
    project.mediaLibrary[0] = {
      ...project.mediaLibrary[0],
      localPath: null,
      referenceKind: "browserFile",
      connectionState: "needsReconnect"
    };
    setMatchingProject(project);

    render(<MatchingHarness />);

    expect(
      await matchingConfigurationQuery().findByText(
        "临时浏览器引用；自动匹配请回素材页删除后用桌面批量导入"
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始批量匹配" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "处理 1 个音轨" })).toBeEnabled();
  });

  it("组件中有一组运行失败时不发布同组件的任何候选", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob)
      .mockRejectedValueOnce(new Error("第一组音轨不可用"))
      .mockImplementation((request) =>
        Promise.resolve({
          jobId: `job-${request.sourcePath}-${request.completePath}`,
          status: "completed",
          ...audioAlignmentJobStage("completed"),
          progress: 1,
          message: "完成",
          logs: [],
          proposal: createProposal(request.completePath.includes("ep1") ? 0 : 60_000),
          error: null,
          updatedAtMs: 1
        })
      );

    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 4 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("未完成分析")
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        pairs: [
          { sourceMediaId: "source-long", targetMediaId: "target-ep1" },
          { sourceMediaId: "source-long", targetMediaId: "target-ep2" },
          { sourceMediaId: "source-long-b", targetMediaId: "target-ep1" },
          { sourceMediaId: "source-long-b", targetMediaId: "target-ep2" }
        ]
      })
    );
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(within(taskList).getAllByText(/运行环境或证据链失败/)).toHaveLength(4);
    expect(within(taskList).queryByText("没有找到可信对应片段")).not.toBeInTheDocument();
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：0 组可逐项确认，4 组未完成分析。"
    );
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("批次内部证据校验失败时明确说明不是素材或 GPU 故障", async () => {
    const internalFailure =
      "应用内部结果校验失败；素材未被判定为损坏，请保留任务日志并使用修复版本重试。";
    const baseSnapshot = createLegacyBatchSnapshot("native-batch-contract-failed", [
      {
        sourceMediaId: "source-long",
        targetMediaId: "target-ep1",
        snapshot: {
          jobId: "contract-failed-1",
          status: "failed",
          ...audioAlignmentJobStage("failed"),
          progress: 1,
          message: "批次最终证据合同校验失败；该 pair 的结果已作废。",
          logs: [],
          proposal: null,
          error: internalFailure,
          updatedAtMs: 1
        }
      },
      {
        sourceMediaId: "source-long",
        targetMediaId: "target-ep2",
        snapshot: {
          jobId: "contract-failed-2",
          status: "failed",
          ...audioAlignmentJobStage("failed"),
          progress: 1,
          message: "批次最终证据合同校验失败；该 pair 的结果已作废。",
          logs: [],
          proposal: null,
          error: internalFailure,
          updatedAtMs: 1
        }
      }
    ]);
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce({
      ...baseSnapshot,
      status: "failed",
      message: "批次最终证据合同校验失败；所有 proposal 已清除。",
      error: internalFailure
    });

    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("内部结果校验失败")
    );

    const taskList = screen.getByLabelText("批量匹配任务");
    expect(
      within(taskList).getAllByText(
        /应用内部结果校验失败，素材未被判定为损坏。请展开“运行诊断”查看原因/
      )
    ).toHaveLength(2);
    expect(within(taskList).queryByText(/请检查 FFmpeg、GPU 环境/)).not.toBeInTheDocument();
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("前端分数偏好第一组时仍只发布后端最终分配选中的第二组", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) => {
      const probability = request.sourcePath.includes("collection-b") ? 0.62 : 0.999;
      return Promise.resolve({
        jobId: `job-n-to-1-${probability}`,
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createV2ProposalWithProbability(0, probability),
        error: null,
        updatedAtMs: 1
      });
    });
    testFineBatchOptions = { selectedPairOrdinals: [2] };
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(1)
    );

    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    expect(candidates[0]).toMatchObject({
      sourceMediaId: "source-long-b",
      targetMediaId: "target-ep1",
      confidence: 0.62,
      state: "pending",
      proposal: { timeMap: { quality: { level: "review", probability: 0.62 } } }
    });
    expect(candidates.some((candidate) => candidate.sourceMediaId === "source-long")).toBe(
      false
    );
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：1 组可逐项确认，1 组暂不可确认。"
    );
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(
      within(taskList).getByText(/target-ep1 ← source-long-b .*已唯一确定/)
    ).toBeInTheDocument();
    expect(
      within(taskList).getByText(/最终分配采用了同一组件中的另一组关系/)
    ).toBeInTheDocument();
    expect(getMatchingCandidates()[0]).toHaveTextContent("target-ep1 ← source-long-b");
  });

  it("N×M 只发布原生组件最终分配，不按前端 confidence 重新求解", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    setMatchingProject(project);
    const scores = new Map([
      ["collection.mkv|ep1.mkv", 0.98],
      ["collection.mkv|ep2.mkv", 0.2],
      ["collection-b.mkv|ep1.mkv", 0.1],
      ["collection-b.mkv|ep2.mkv", 0.9]
    ]);
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) => {
      const sourceName = request.sourcePath.split("\\").at(-1) ?? "";
      const targetName = request.completePath.split("\\").at(-1) ?? "";
      const proposal = createProposal(0);
      proposal.confidence = scores.get(`${sourceName}|${targetName}`) ?? 0;
      return Promise.resolve({
        jobId: `job-nxm-${sourceName}-${targetName}`,
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: [],
        proposal,
        error: null,
        updatedAtMs: 1
      });
    });
    testFineBatchOptions = { selectedPairOrdinals: [2, 3] };
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    const publishedPairs = candidates
      .map((candidate) => `${candidate.sourceMediaId}->${candidate.targetMediaId}`)
      .sort();
    expect(publishedPairs).toEqual(["source-long->target-ep2", "source-long-b->target-ep1"]);
    expect(candidates.map((candidate) => candidate.confidence).sort()).toEqual([0.1, 0.2]);
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：2 组可逐项确认，2 组暂不可确认。"
    );
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("批量匹配任务")).getAllByText(
          /最终分配采用了同一组件中的另一组关系/
        )
      ).toHaveLength(2)
    );
  });

  it("原生精匹配未决时不发布候选并明确说明接近位置数量", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) => {
      const probability = request.sourcePath.includes("collection-b") ? 0.895 : 0.9;
      return Promise.resolve({
        jobId: `job-ambiguous-${probability}`,
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createV2ProposalWithProbability(0, probability),
        error: null,
        updatedAtMs: 1
      });
    });
    testFineBatchOptions = { finalState: "unresolved", inventoryCandidateCount: 2 };
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("暂不可确认")
    );

    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：0 组可逐项确认，2 组暂不可确认。"
    );
    expect(
      within(screen.getByLabelText("批量匹配任务")).getAllByText(
        "发现 2 个接近位置，原生精匹配暂时不能唯一确定；本组不能确认。"
      )
    ).toHaveLength(2);
    expect(screen.queryByText("没有找到可信对应片段")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /确认关系|保存关系/ })).not.toBeInTheDocument();
  });

  it("精匹配找到高覆盖 blocked TimeMap 时保留人工复核候选而不是误报未找到", async () => {
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation(() => {
      const proposal = createV2Proposal(30_000, "blocked");
      proposal.confidence = 0;
      return Promise.resolve({
        jobId: "job-blocked-review-candidate",
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: [],
        proposal,
        error: null,
        updatedAtMs: 1
      });
    });
    testFineBatchOptions = { finalState: "noEligibleCandidate", inventoryCandidateCount: 2 };
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );

    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    expect(candidates.every((candidate) => candidate.state === "blocked")).toBe(true);
    expect(
      candidates.every((candidate) => candidate.proposal.timeMap?.quality.level === "blocked")
    ).toBe(true);
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：0 组可逐项确认，2 组暂不可确认。"
    );
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("批量匹配任务")).getAllByText(
          /找到候选，但差异边界需要人工复核/
        )
      ).toHaveLength(2)
    );
    expect(getMatchingCandidates()).toHaveLength(2);
    expect(screen.queryByText(/没有可用的对应候选/)).not.toBeInTheDocument();
  });

  it("精匹配受资源限制时显示可操作原因且绝不误报为未找到", async () => {
    testFineBatchOptions = {
      finalState: "unresolved",
      inventoryCandidateCount: 2,
      stateCounts: { unresolved: 0, resourceBlocked: 2 }
    };
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("未完成分析")
    );

    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(
      within(taskList).getAllByText(
        /这组没有完成分析：可用资源不足。精匹配窗口超过本机安全资源预算；可改用 CPU、减少同时选中的多音轨版本，或查看诊断中的窗口大小。/
      )
    ).toHaveLength(2);
    expect(within(taskList).queryByText(/没有找到可信对应片段/)).not.toBeInTheDocument();
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配完成：0 组可逐项确认，2 组未完成分析。"
    );
  });

  it("取消后不发布任何迟到候选，并可继续剩余任务", async () => {
    const startDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    const pollDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    const project = createMatchingProject();
    project.mediaLibrary.push(
      createMedia("target-ep3", "targetOriginal", "D:\\video\\ep3.mkv", 60_000)
    );
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentBatchJob).mockReturnValueOnce(startDeferred.promise);
    vi.mocked(getTauriAudioAlignmentBatchJob).mockReturnValueOnce(pollDeferred.promise);
    const runningSnapshot = createLegacyBatchSnapshot("native-batch-cancel", [
      createTestBatchPair(
        "source-long",
        "target-ep1",
        "completed",
        createProposal(0),
        "第一组已完成"
      ),
      createTestBatchPair("source-long", "target-ep2", "running", null, "正在分析第二组"),
      createTestBatchPair("source-long", "target-ep3", "queued", null, "等待执行")
    ]);
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("native-batch-cancel", [
        createTestBatchPair(
          "source-long",
          "target-ep1",
          "completed",
          createProposal(0),
          "第一组已完成"
        ),
        createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已取消"),
        createTestBatchPair("source-long", "target-ep3", "cancelled", null, "已取消")
      ])
    );

    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 3 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    act(() => startDeferred.resolve(runningSnapshot));
    await screen.findByText("正在寻找可能对应的片段");
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));
    pollDeferred.resolve(runningSnapshot);

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("native-batch-cancel")
    );
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("批量匹配已取消")
    );
    expect(useEditorStore.getState().status.message).toBe(
      "批量匹配已取消：0 组可逐项确认，3 组已取消。已取消结果不会发布为可确认关系。"
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    const taskList = screen.getByLabelText("批量匹配任务");
    expect(within(taskList).getAllByText(/任务已取消；取消结果不会用于确认/)).toHaveLength(3);

    const continueButton = await screen.findByRole("button", { name: "继续剩余任务" });
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) =>
      Promise.resolve({
        jobId: `job-resume-${request.completePath}`,
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createProposal(request.completePath.includes("ep2") ? 60_000 : 120_000),
        error: null,
        updatedAtMs: 4
      })
    );

    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(3)
    );
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(2));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pairs: [
          { sourceMediaId: "source-long", targetMediaId: "target-ep1" },
          { sourceMediaId: "source-long", targetMediaId: "target-ep2" },
          { sourceMediaId: "source-long", targetMediaId: "target-ep3" }
        ]
      })
    );
    expect(screen.queryByRole("button", { name: "开始批量匹配" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看覆盖并导出（3 个结果）" })).toBeEnabled();
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(3);
  });

  it("旧项目已有确认来源段但没有候选记录时跳过对应素材对", async () => {
    const project = createMatchingProject();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("legacy-segment", {
        kind: "content",
        assetId: "asset-long",
        sourceMediaId: "source-long",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetMediaId: "target-ep1",
        targetStartMs: 0,
        timingRules: [],
        episodeKey: null,
        episodeLabel: null
      })
    ];
    setMatchingProject(project);
    render(<MatchingHarness />);

    const legacyQuality = matchingResultQuery().getByTestId("confirmed-time-map-quality");
    expect(legacyQuality).toHaveTextContent("已保存关系的时间图缺失");
    expect(legacyQuality).toHaveTextContent("导出闸门：已阻断");
    expect(legacyQuality).toHaveTextContent("正式导出已停用旧规则兼容投影");

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));

    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({
        pairs: [{ sourceMediaId: "source-long", targetMediaId: "target-ep2" }]
      })
    );
    expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(1);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0].targetMediaId).toBe(
      "target-ep2"
    );
    fireEvent.click(screen.getByRole("button", { name: /展开已确认/ }));
    expect(
      within(screen.getByLabelText("批量匹配任务")).getByText(
        "已有候选或已保存关系，未重复分析"
      )
    ).toBeInTheDocument();
  });

  it("明确说明 Evidence v5 发布边界，并且不提供批量确认", async () => {
    render(<MatchingHarness />);

    const warning = matchingResultQuery().getByTestId("legacy-alignment-warning");
    expect(warning).toHaveTextContent("不会直接用于导出");
    expect(warning).toHaveTextContent("全局占用冲突");
    expect(warning).toHaveTextContent("A/B 复核");
    expect(warning).toHaveTextContent("Evidence v5");
    expect(warning).toHaveTextContent("显式多版本复用策略");
    expect(warning).toHaveTextContent("前端不会再次求解");
    expect(screen.queryByText(/高可信候选/)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(getMatchingCandidates()).toHaveLength(2));

    expect(screen.getAllByText("定位线索分数 90% · 不是校准概率")).toHaveLength(2);
    expect(screen.queryByText(/高可信候选/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /批量.*确认|确认.*高可信/ })
    ).not.toBeInTheDocument();
    expect(
      useEditorStore.getState().project.mediaMatchCandidates.map((candidate) => candidate.state)
    ).toEqual(["pending", "pending"]);
  });

  it.each([
    ["verified", "需复核", "可采用系统建议", true],
    ["review", "需复核", "可采用系统建议", false],
    ["blocked", "可人工接管", "自动确认未通过", false],
    ["legacy-unverified", "旧版未验证", "旧版候选可由你明确接管", false]
  ] as const)(
    "V2 自报质量等级 %s 经过 provenance 重算后显示对应导出闸门",
    async (level, label, gateMessage, keepsReportedProbability) => {
      configureSingleTargetV2Project(level);
      render(<MatchingHarness />);

      fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
      const card = await findMatchingCandidate();
      const qualityPanel = within(card).getByTestId("candidate-time-map-quality");
      const action = within(card).getByRole("button", { name: "进入编辑工作台" });

      expect(within(qualityPanel).getByTestId("time-map-quality-label")).toHaveTextContent(
        label
      );
      expect(qualityPanel).toHaveTextContent(gateMessage);
      expect(qualityPanel).toHaveTextContent(
        level === "verified" ? "校准概率：99.9%" : "校准概率：尚未完成真实基准校准"
      );
      expect(action).toBeEnabled();
      expect(qualityPanel).toHaveTextContent(
        keepsReportedProbability ? "可信验证记录" : gateMessage
      );
      if (level === "blocked") {
        fireEvent.click(action);
        expect(useEditorStore.getState().project.danmakuSourceSegments).toEqual([]);
        expect(useEditorStore.getState().workspacePage).toBe("editing");
      }
    }
  );

  it("严格自动质量门槛只阻止自动确认，用户可采用系统建议直接建立可导出方案", async () => {
    const user = userEvent.setup();
    configureSingleTargetV2Project("blocked");
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    expect(within(card).getByTestId("candidate-time-map-quality")).toHaveTextContent(
      "导出状态：可建立人工方案"
    );
    expect(within(card).getAllByText("可人工接管")).toHaveLength(2);
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const workspace = await screen.findByTestId("alignment-editor-workspace");
    fireEvent.click(screen.getByRole("button", { name: "采用当前结果并允许导出" }));
    expect(
      screen.queryByRole("dialog", { name: "采用当前结果并允许导出" })
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("accepted")
    );
    const confirmedMap = useEditorStore
      .getState()
      .project.mediaTimeMaps.find((map) => map.state === "confirmed");
    expect(confirmedMap?.quality.level).toBe("review");
    expect(readTimeMapManualTakeover(confirmedMap!)).not.toBeNull();
    selectWorkspaceAction("关系工具", "关系详情与导出检查");
    const relationDetails = screen.getByRole("dialog", { name: "关系详情与导出检查" });
    expect(within(relationDetails).getByText("已采用用于播放")).toBeInTheDocument();
    expect(within(relationDetails).getByText("已允许导出")).toBeInTheDocument();
    expect(relationDetails).toHaveTextContent("未验证区间和潜在错位仍保留在诊断中");
    expect(
      within(workspace).queryByRole("button", { name: "签发人工方案并允许导出" })
    ).not.toBeInTheDocument();
  });

  it("在折叠详情展示 V2 指标、分段、音轨和主要原因", async () => {
    configureSingleTargetV2Project("verified");
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    const qualityPanel = within(card).getByTestId("candidate-time-map-quality");

    expect(qualityPanel).toHaveTextContent("引擎 / 特征：alignment-v2.4 / chroma-v2");
    expect(qualityPanel).toHaveTextContent("覆盖率：96%");
    expect(qualityPanel).toHaveTextContent("P95 残差：80 毫秒");
    expect(qualityPanel).toHaveTextContent("边界不确定度：180 毫秒");
    expect(qualityPanel).toHaveTextContent("Top1/Top2 差距：32%");
    expect(qualityPanel).toHaveTextContent(
      "时间图片段：matched 1 · sourceOnly 0 · targetOnly 0 · ambiguous 0"
    );
    expect(qualityPanel).toHaveTextContent(
      "选中音轨：参考音轨 #1 · AAC · 48000 Hz · 2 声道 · zh · 国语；原片音轨 #2 · FLAC · 48000 Hz · 6 声道 · zh · 正片"
    );
    expect(qualityPanel).toHaveTextContent("双证据和留出锚点均达到门槛。");
    expect(within(qualityPanel).getByText("时间图证据详情")).toHaveClass(
      "focus-visible:outline"
    );
  });

  it("用双时间轴和结果语言展示四类分段，并让分段按钮可点击和键盘定位", async () => {
    const user = userEvent.setup();
    const project = createMatchingProject();
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-v2-four-span-kinds",
      status: "completed",
      ...audioAlignmentJobStage("completed"),
      progress: 1,
      message: "完成",
      logs: [],
      proposal: createFourKindV2Proposal(),
      error: null,
      updatedAtMs: 1
    });
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const review = await screen.findByTestId("alignment-editor-workspace");
    selectWorkspaceAction("关系工具", "关系详情与导出检查");
    expect(screen.getByRole("dialog", { name: "关系详情与导出检查" })).toHaveTextContent(
      "共同 1 · 参考独有 1 · 原片独有 1 · 待确认 1"
    );
    await user.click(screen.getByRole("button", { name: "关闭关系详情与导出检查" }));
    expect(within(review).getByRole("region", { name: "双轨差异编辑器" })).toBeInTheDocument();
    expect(within(review).getByText("参考轨道")).toBeInTheDocument();
    expect(within(review).getByText("原片轨道")).toBeInTheDocument();
    expect(review).toHaveTextContent("第 4 / 4 段");
    expect(within(review).getByRole("button", { name: "需要确认" })).toBeInTheDocument();
    const previousButton = within(review).getByRole("button", { name: "上一段" });
    previousButton.focus();
    await user.keyboard("{Enter}");
    expect(previousButton).toHaveFocus();
    expect(review).toHaveTextContent("第 3 / 4 段");
    expect(within(review).getByRole("button", { name: "原片独有" })).toBeInTheDocument();
  });

  it("真实加载两路媒体，按 matched 映射切换播放头，并让单侧差异的边界前后循环可达", async () => {
    const user = userEvent.setup();
    const project = createMatchingProject();
    project.mediaLibrary = project.mediaLibrary
      .filter((media) => media.id !== "target-ep2")
      .map((media) => ({
        ...media,
        fileName: `${media.id}.mp4`,
        objectUrl: `blob:${media.id}`
      }));
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-v2-ab-playback",
      status: "completed",
      ...audioAlignmentJobStage("completed"),
      progress: 1,
      message: "完成",
      logs: [],
      proposal: createFourKindV2Proposal(),
      error: null,
      updatedAtMs: 1
    });
    const sourcePlayback = createFakePlaybackAdapter();
    const targetPlayback = createFakePlaybackAdapter();
    const adapterFactory = vi.fn<TimeMapPlaybackAdapterFactory>(({ axis }) =>
      axis === "source" ? sourcePlayback.adapter : targetPlayback.adapter
    );
    render(<MatchingHarness playbackAdapterFactory={adapterFactory} />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const review = await screen.findByTestId("alignment-editor-workspace");
    const playback = within(review).getByTestId("time-map-playback-review");
    const previousButton = within(review).getByRole("button", { name: "上一段" });
    await user.click(previousButton);
    await user.click(previousButton);
    await user.click(previousButton);

    await waitFor(() =>
      expect(within(playback).getByRole("button", { name: "播放当前段" })).toBeEnabled()
    );
    expect(within(playback).getByTestId("dual-video-viewers")).toBeInTheDocument();
    expect(
      within(playback).getByRole("button", { name: /(?:只听|正在听)原片 B/ })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(sourcePlayback.load).toHaveBeenCalledTimes(1);
      expect(targetPlayback.load).toHaveBeenCalledTimes(1);
      expect(sourcePlayback.seek).toHaveBeenLastCalledWith(5_000);
      expect(targetPlayback.seek).toHaveBeenLastCalledWith(0);
    });
    await user.click(within(playback).getByRole("button", { name: "播放当前段" }));
    expect(sourcePlayback.play).toHaveBeenCalledTimes(1);
    expect(targetPlayback.play).toHaveBeenCalledTimes(1);
    expect(sourcePlayback.setMuted).toHaveBeenLastCalledWith(true);
    expect(targetPlayback.setMuted).toHaveBeenLastCalledWith(false);

    const targetTimeline = within(review).getByRole("slider", {
      name: "原片轨道色块轨"
    });
    fireEvent.keyDown(targetTimeline, { key: "ArrowRight" });
    await waitFor(() => {
      expect(sourcePlayback.seek).toHaveBeenCalledWith(6_000);
      expect(targetPlayback.seek).toHaveBeenCalledWith(1_000);
    });
    await user.click(within(playback).getByRole("button", { name: /(?:只听|正在听)参考 A/ }));
    expect(sourcePlayback.setMuted).toHaveBeenLastCalledWith(false);
    expect(targetPlayback.setMuted).toHaveBeenLastCalledWith(true);
    expect(playback).toHaveTextContent("双方播放头仍保持联动");
    await user.click(within(playback).getByRole("button", { name: "播放当前段" }));
    await user.click(within(playback).getByRole("button", { name: "试听记录" }));
    expect(screen.getByRole("button", { name: "记录本段已复核" })).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "试听记录" })).toHaveTextContent(
      "只累计页面可见且播放器时间连续向前推进"
    );
    await user.click(screen.getByRole("button", { name: "关闭试听记录" }));

    await user.click(within(review).getByRole("button", { name: "下一段" }));
    expect(review).toHaveTextContent("第 2 / 4 段");
    expect(within(review).getByRole("button", { name: "参考独有" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(playback).getByRole("button", { name: /(?:只听|正在听)原片 B/ })
      ).toBeDisabled()
    );
    selectWorkspaceAction("当前分段", "段首前后 3 秒");
    await waitFor(() =>
      expect(
        within(playback).getByRole("button", { name: /(?:只听|正在听)原片 B/ })
      ).toBeEnabled()
    );
    await user.click(within(playback).getByRole("button", { name: /(?:只听|正在听)原片 B/ }));
    expect(targetPlayback.load).toHaveBeenCalledTimes(1);
    expect(targetPlayback.seek).toHaveBeenLastCalledWith(7_000);
    expect(playback).toHaveTextContent("对应边界位置 00:00:07.000");
    await user.click(within(playback).getByRole("button", { name: "试听记录" }));
    expect(screen.getByRole("button", { name: "记录本段已复核" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "关闭试听记录" }));
    expect(within(playback).getByRole("button", { name: "循环复核区间：开" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("matched 联动播放会分别累计 A/B 的真实推进证据并解锁复核", async () => {
    const user = userEvent.setup();
    const project = createMatchingProject();
    project.mediaLibrary = project.mediaLibrary
      .filter((media) => media.id !== "target-ep2")
      .map((media) => ({
        ...media,
        fileName: `${media.id}.mp4`,
        objectUrl: `blob:${media.id}`
      }));
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-v2-effective-playback",
      status: "completed",
      ...audioAlignmentJobStage("completed"),
      progress: 1,
      message: "完成",
      logs: [],
      proposal: createV2Proposal(0, "review"),
      error: null,
      updatedAtMs: 1
    });
    const sourcePlayback = createAdvancingPlaybackAdapter();
    const targetPlayback = createAdvancingPlaybackAdapter();
    render(
      <MatchingHarness
        playbackAdapterFactory={({ axis }) =>
          axis === "source" ? sourcePlayback.adapter : targetPlayback.adapter
        }
      />
    );

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const review = await screen.findByTestId("alignment-editor-workspace");
    const playback = within(review).getByTestId("time-map-playback-review");
    await user.click(await within(playback).findByRole("button", { name: "播放当前段" }));

    await user.click(within(playback).getByRole("button", { name: "试听记录" }));
    expect(screen.getByRole("button", { name: "记录本段已复核" })).toBeDisabled();
    const reviewSheet = screen.getByRole("dialog", { name: "试听记录" });
    expect(reviewSheet).toHaveTextContent("共同内容 · 参考 A");
    expect(reviewSheet).toHaveTextContent("共同内容 · 原片 B");
    await waitFor(
      () => expect(reviewSheet).toHaveTextContent("有效 2.0 秒/2.0 秒 · 覆盖 1.5 秒/1.5 秒"),
      { timeout: 3_000 }
    );
    await waitFor(
      () =>
        expect(
          within(reviewSheet).getByRole("button", { name: "记录本段已复核" })
        ).toBeEnabled(),
      { timeout: 3_000 }
    );
    expect(sourcePlayback.play).toHaveBeenCalledTimes(1);
    expect(targetPlayback.play).toHaveBeenCalledTimes(1);
    expect(reviewSheet).toHaveTextContent("已达到本段要求的有效试听时长和覆盖范围");
  });

  it("四种快捷判定始终可操作，不兼容形状会打开对应边界编辑并在保存重开后恢复", async () => {
    const user = userEvent.setup();
    const project = createMatchingProject();
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
      jobId: "job-v2-persistent-span-review",
      status: "completed",
      ...audioAlignmentJobStage("completed"),
      progress: 1,
      message: "完成",
      logs: [],
      proposal: createFourKindV2Proposal(),
      error: null,
      updatedAtMs: 1
    });
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    let review = await screen.findByTestId("alignment-editor-workspace");
    await user.click(within(review).getByRole("button", { name: "上一段" }));
    await user.click(within(review).getByRole("button", { name: "上一段" }));
    expect(review).toHaveTextContent("第 2 / 4 段");
    expect(within(review).getByRole("button", { name: "参考独有" })).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: "标记多出内容" }));
    expect(screen.getByRole("menuitem", { name: "标记参考多出" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "标记原片多出" })).toBeEnabled();
    await user.keyboard("{Escape}");
    await user.click(within(review).getByRole("button", { name: "参考独有" }));
    expect(screen.getByRole("menuitem", { name: "版本不同" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "暂不确定" })).toBeEnabled();
    await user.keyboard("{Escape}");
    selectWorkspaceAction("标记多出内容", "标记参考多出");
    const reviewedMap = useEditorStore.getState().project.mediaTimeMaps[0];
    expect(readTimeMapSpanReviewDecision(reviewedMap, 1)?.decision).toBe("source-extra");
    expect(reviewedMap.verification).toBeNull();
    expect(reviewedMap.evidence.types).toContain("manual");
    const saved = serializeProject(useEditorStore.getState().project);

    act(() => useEditorStore.getState().openProjectFromText(saved, "reviewed-project.json"));
    const reopenedMap = useEditorStore
      .getState()
      .project.mediaTimeMaps.find((timeMap) => timeMap.id === reviewedMap.id);
    expect(reopenedMap).toBeDefined();
    expect(readTimeMapSpanReviewDecision(reopenedMap!, 1)?.decision).toBe("source-extra");

    await user.click(screen.getByRole("tab", { name: "精确修正" }));
    review = await screen.findByTestId("alignment-editor-workspace");
    await user.click(within(review).getByRole("button", { name: "下一段" }));
    await user.click(within(review).getByRole("button", { name: "下一段" }));
    await user.click(within(review).getByRole("button", { name: "下一段" }));
    expect(review).toHaveTextContent("第 4 / 4 段");
    expect(within(review).getByRole("button", { name: "需要确认" })).toBeInTheDocument();
    selectWorkspaceAction("需要确认", "版本不同");
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("blocked");
    expect(useEditorStore.getState().project.mediaTimeMaps[0]?.quality.level).toBe("blocked");
    expect(review).toHaveTextContent("需要人工处理");
  });

  it("候选保存后明确显示关系待复核，不用绿色已确认暗示可导出", async () => {
    const user = userEvent.setup();
    configureSingleTargetV2Project("review");
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const acceptedReview = await screen.findByTestId("alignment-editor-workspace");
    selectWorkspaceAction("关系工具", "保存为待复核关系");

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("accepted")
    );
    expect(acceptedReview).toHaveTextContent("关系已保存");
    expect(
      useEditorStore.getState().project.mediaMatchCandidates[0]?.confirmedTimeMapId
    ).not.toBeNull();
    expect(
      useEditorStore
        .getState()
        .project.mediaTimeMaps.find((timeMap) => timeMap.state === "confirmed")
    ).toBeDefined();
    expect(acceptedReview).toHaveTextContent("第 1 / 1 段");
    selectWorkspaceAction("关系工具", "关系详情与导出检查");
    const verification = screen.getByTestId("manual-time-map-verification");
    expect(within(verification).getByRole("button", { name: "完成复核并签发" })).toBeDisabled();
    expect(verification).toHaveTextContent("安装级人工验证只在 Tauri 桌面端可用");
  });

  it("只在桌面预检通过后由明确按钮签发，并为活动签名提供真实撤销动作", async () => {
    const user = userEvent.setup();
    configureSingleTargetV2Project("verified");
    vi.mocked(isManualVerificationAuthorityAvailable).mockReturnValue(true);
    const issue = vi.fn<typeof defaultIssueManualVerification>(() => Promise.resolve());
    const revoke = vi.fn<typeof defaultRevokeManualVerification>(() => Promise.resolve());
    useEditorStore.setState({
      issueManualMediaTimeMapVerification: issue,
      revokeManualMediaTimeMapVerification: revoke
    });
    render(<MatchingHarness />);

    await user.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await findMatchingCandidate();
    const candidateMap = useEditorStore.getState().project.mediaTimeMaps[0];
    act(() =>
      useEditorStore
        .getState()
        .recordTimeMapSpanPlaybackReview(
          candidateMap.id,
          0,
          createTestCompleteTimeMapSpanPlaybackEvidence(candidateMap, 0)
        )
    );
    const card = await findMatchingCandidate();
    await user.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const workspace = await screen.findByTestId("alignment-editor-workspace");
    fireEvent.click(within(workspace).getByRole("button", { name: "关系工具" }));
    const saveRelationship = screen.getByRole("menuitem", { name: "保存为待复核关系" });
    await waitFor(() => expect(saveRelationship).toBeEnabled());
    await user.click(saveRelationship);
    await waitFor(() => {
      const state = useEditorStore.getState();
      if (state.project.mediaMatchCandidates[0]?.state !== "accepted") {
        throw new Error(state.status.message);
      }
    });

    selectWorkspaceAction("关系工具", "关系详情与导出检查");
    const verification = screen.getByTestId("manual-time-map-verification");
    expect(verification).toHaveTextContent("已通过签发预检");
    await user.click(within(verification).getByRole("button", { name: "完成复核并签发" }));
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    const confirmedMap = useEditorStore
      .getState()
      .project.mediaTimeMaps.find((timeMap) => timeMap.state === "confirmed");
    expect(confirmedMap).toBeDefined();
    const issueCall = issue.mock.calls[0];
    if (!issueCall) throw new Error("签发按钮没有调用 store action");
    expect(issueCall[0]).toBe(confirmedMap?.id);
    expect(issueCall[1]).toMatchObject({
      calibrationArtifactId: "manual-a-b-review",
      calibrationArtifactVersion: "1",
      verifier: "本机用户"
    });
    expect(Number.isFinite(Date.parse(issueCall[1].verifiedAt))).toBe(true);

    if (!confirmedMap) throw new Error("签发 UI 测试缺少确认时间图");
    const verificationInput = {
      calibrationArtifactId: "manual-a-b-review",
      calibrationArtifactVersion: "1",
      verifier: "本机用户",
      verifiedAt: "2026-07-12T10:00:00.000Z"
    };
    const verificationRequest = createManualMediaTimeMapVerificationRequest(
      confirmedMap,
      verificationInput
    );
    const issuedMap = applyAuthorityIssuedManualMediaTimeMapVerification(
      confirmedMap,
      verificationInput,
      {
        verificationId: "verification-ui-test",
        issuerKeyId: "issuer-ui-test",
        issuerSequence: 1,
        signatureAlgorithm: "hmac-sha256-v1",
        signature: "a".repeat(64),
        requestDigest: verificationRequest.requestDigest
      }
    );
    act(() => {
      useEditorStore.setState((state) => ({
        project: {
          ...state.project,
          mediaTimeMaps: state.project.mediaTimeMaps.map((timeMap) =>
            timeMap.id === confirmedMap.id ? issuedMap : timeMap
          )
        }
      }));
    });

    const signedPanel = screen.getByTestId("manual-time-map-verification");
    expect(signedPanel).toHaveTextContent("本机签名已验证");
    await user.click(within(signedPanel).getByRole("button", { name: "撤销人工验证" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    const revokeCall = revoke.mock.calls[0];
    if (!revokeCall) throw new Error("撤销按钮没有调用 store action");
    expect(revokeCall[0]).toBe(confirmedMap.id);
    expect(revokeCall[1]).toMatchObject({
      reason: "用户在编辑工作台撤销了人工 A/B 复核验证。",
      revokedBy: "本机用户"
    });
    expect(Number.isFinite(Date.parse(revokeCall[1].revokedAt))).toBe(true);
  });

  it("候选时间图缺失时明确报错并禁止确认", async () => {
    configureSingleTargetV2Project("verified");
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await findMatchingCandidate();
    act(() => {
      useEditorStore.setState((state) => ({
        project: { ...state.project, mediaTimeMaps: [] }
      }));
    });

    const card = await findMatchingCandidate();
    const qualityPanel = within(card).getByTestId("candidate-time-map-quality");
    expect(qualityPanel).toHaveTextContent("时间图缺失");
    expect(qualityPanel).toHaveTextContent("不能确认或导出");
    fireEvent.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("这条关系缺少可编辑的时间图");
  });

  it("时间图分段越界时停止绘制和定位，不生成可误触的分段按钮", async () => {
    configureSingleTargetV2Project("review");
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await findMatchingCandidate();
    act(() => {
      useEditorStore.setState((state) => {
        const timeMap = state.project.mediaTimeMaps[0];
        if (!timeMap || !timeMap.spans[0]) {
          throw new Error("测试候选缺少时间图分段。");
        }
        return {
          project: {
            ...state.project,
            mediaTimeMaps: [
              {
                ...timeMap,
                spans: [
                  {
                    ...timeMap.spans[0],
                    targetEndMs: timeMap.targetEndMs + 1_000
                  }
                ]
              }
            ]
          }
        };
      });
    });

    const card = await findMatchingCandidate();
    fireEvent.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const review = await screen.findByTestId("time-map-review");
    expect(review).toHaveAttribute("role", "alert");
    expect(review).toHaveTextContent("时间图结构无效，已停止绘制和定位");
    expect(review).toHaveTextContent("分段没有完整覆盖时间图声明的双方范围");
    expect(within(review).queryByRole("button")).not.toBeInTheDocument();
  });

  it("blocked 状态提供人工接管路径，缺 XML 时仍显示缺少绑定", async () => {
    configureSingleTargetV2Project("verified");
    const project = useEditorStore.getState().project;
    useEditorStore.setState({
      project: { ...project, danmakuSourceBindings: [] }
    });
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    const card = await findMatchingCandidate();

    fireEvent.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
    const workspace = await screen.findByTestId("alignment-editor-workspace");
    expect(workspace).toHaveTextContent("参考素材还没有绑定 XML");
    expect(
      within(workspace).getByRole("button", { name: "采用当前结果并允许导出" })
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "采用当前结果并允许导出" }));
    expect(
      screen.queryByRole("dialog", { name: "采用当前结果并允许导出" })
    ).not.toBeInTheDocument();
    expect(useEditorStore.getState().project.mediaMatchCandidates[0].state).not.toBe(
      "accepted"
    );
  });

  it.each([
    ["verified", "review", "需复核", "导出状态：待复核与签发", "仍不能导出"],
    ["review", "review", "需复核", "导出状态：待复核与签发", "仍不能导出"],
    [
      "legacy-unverified",
      "legacy-unverified",
      "旧版未验证",
      "导出状态：待复核与签发",
      "仍不能导出"
    ]
  ] as const)(
    "%s 候选保存后在已保存关系显示 provenance 重算后的时间图质量",
    async (level, expectedLevel, label, gateText, message) => {
      configureSingleTargetV2Project(level);
      render(<MatchingHarness />);

      fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
      const card = await findMatchingCandidate();
      fireEvent.click(within(card).getByRole("button", { name: "进入编辑工作台" }));
      await screen.findByTestId("alignment-editor-workspace");
      selectWorkspaceAction("关系工具", "保存为待复核关系");

      act(() => useEditorStore.getState().setWorkspacePage("matching"));
      const relations = await matchingResultQuery().findByTestId("confirmed-media-relations");
      const confirmedQuality = within(relations).getByTestId("confirmed-time-map-quality");
      expect(within(confirmedQuality).getByTestId("time-map-quality-label")).toHaveTextContent(
        label
      );
      expect(confirmedQuality).toHaveTextContent(gateText);
      expect(confirmedQuality).toHaveTextContent(message);
      expect(
        useEditorStore
          .getState()
          .project.mediaTimeMaps.find((timeMap) => timeMap.state === "confirmed")?.quality.level
      ).toBe(expectedLevel);
    }
  );

  it("编辑工作台只采用当前参考素材已绑定且仍存在的 XML", async () => {
    const project = createMatchingProject();
    const extraAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="20,1,25,16777215,0,0,u,r">附加弹幕</d></i>`,
      { assetId: "asset-extra", fileName: "collection-extra.xml" }
    );
    project.assets.push(extraAsset);
    setMatchingProject(project);
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(getMatchingCandidates()).toHaveLength(2));
    const episodeOneCard = screen
      .getAllByTestId("media-match-candidate")
      .find((card) => card.textContent?.includes("target-ep1"));
    expect(episodeOneCard).toBeDefined();
    fireEvent.click(within(episodeOneCard!).getByRole("button", { name: "进入编辑工作台" }));
    await screen.findByTestId("alignment-editor-workspace");
    selectWorkspaceAction("关系工具", "保存为待复核关系");

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    const segments = useEditorStore.getState().project.danmakuSourceSegments;
    expect(segments.map((segment) => segment.assetId)).toEqual(["asset-long"]);
    expect(segments[0]?.targetMediaId).toBe("target-ep1");
    expect(
      useEditorStore
        .getState()
        .project.mediaMatchCandidates.map((candidate) => candidate.state)
        .sort()
    ).toEqual(["accepted", "pending"]);

    expect(segments.some((segment) => segment.assetId === extraAsset.id)).toBe(false);
  });

  it("每组自动匹配只融合当前参考素材所绑定 XML 的弹幕证据", async () => {
    const project = createMatchingProject();
    addSecondSource(project);
    project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
    setMatchingProject(project);
    vi.mocked(startTauriAudioAlignmentJob).mockImplementation((request) =>
      Promise.resolve({
        jobId: `job-${request.sourcePath}`,
        status: "completed",
        ...audioAlignmentJobStage("completed"),
        progress: 1,
        message: "完成",
        logs: [],
        proposal: createProposalWithCut(),
        error: null,
        updatedAtMs: 1
      })
    );
    render(
      <MatchingHarness
        suspectedCutCandidates={[
          createSuspectedCut("hint-a", "asset-long", "collection.xml", 100_000),
          createSuspectedCut("hint-b", "asset-long-b", "collection-b.xml", 20_000)
        ]}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    const candidates = useEditorStore.getState().project.mediaMatchCandidates;
    const sourceA = candidates.find((candidate) => candidate.sourceMediaId === "source-long");
    const sourceB = candidates.find((candidate) => candidate.sourceMediaId === "source-long-b");
    expect(sourceA?.proposal.cutCandidates[0]?.confidence).toBe(0.72);
    expect(sourceA?.proposal.diagnostics).toContain(
      "弹幕证据：未发现与候选版本差异相邻的文本聚类。"
    );
    expect(sourceB?.proposal.cutCandidates[0]?.confidence).toBeCloseTo(0.75);
    expect(sourceB?.proposal.diagnostics).toContain(
      "弹幕证据：1 个文本聚类支持 1 个候选版本差异。"
    );
    expect(
      candidates.map(
        (candidate) =>
          candidate.proposal.evidence?.signals?.find((signal) => signal.kind === "danmaku")
            ?.observations
      )
    ).toEqual([1, 1]);
  });

  it("在启动接口返回 jobId 前取消，拿到 jobId 后仍会取消后端任务且不落候选", async () => {
    const startDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentBatchJob).mockReturnValueOnce(startDeferred.promise);
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-returned-after-cancel", [
        createTestBatchPair("source-long", "target-ep1", "cancelled", null, "已取消"),
        createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已取消")
      ])
    );
    render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));
    expect(cancelTauriAudioAlignmentBatchJob).not.toHaveBeenCalled();

    startDeferred.resolve(
      createLegacyBatchSnapshot("batch-returned-after-cancel", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "刚刚开始"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith(
        "batch-returned-after-cancel"
      )
    );
    await waitFor(() =>
      expect(useEditorStore.getState().status.message).toContain("批量匹配已取消")
    );
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("离开匹配页后批次继续，返回恢复同一任务且不会重复启动", async () => {
    const pollDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentBatchJob).mockResolvedValueOnce(
      createLegacyBatchSnapshot("batch-active-on-unmount", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "批次运行中"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    vi.mocked(getTauriAudioAlignmentBatchJob).mockReturnValueOnce(pollDeferred.promise);
    const firstRender = render(<MatchingHarness />);

    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始批量匹配" }));
    await screen.findByText("正在寻找可能对应的片段");

    firstRender.unmount();
    expect(cancelTauriAudioAlignmentBatchJob).not.toHaveBeenCalled();

    render(<MatchingHarness />);
    expect(
      await screen.findByText("分析在后台继续，你可以随时切换工作区。")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始批量匹配" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消剩余任务" })).toBeEnabled();
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);

    pollDeferred.resolve(
      createLegacyBatchSnapshot("batch-active-on-unmount", [
        createTestBatchPair(
          "source-long",
          "target-ep1",
          "completed",
          createProposal(0),
          "完成"
        ),
        createTestBatchPair(
          "source-long",
          "target-ep2",
          "completed",
          createProposal(60_000),
          "完成"
        )
      ])
    );
    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1);
  });

  it("离页时启动响应已经完成仍保存权威结果", async () => {
    const startDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentBatchJob).mockReturnValueOnce(startDeferred.promise);
    const { unmount } = render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));
    unmount();
    startDeferred.resolve(
      createLegacyBatchSnapshot("batch-completed-after-unmount", [
        createTestBatchPair(
          "source-long",
          "target-ep1",
          "completed",
          createProposal(0),
          "完成"
        ),
        createTestBatchPair(
          "source-long",
          "target-ep2",
          "completed",
          createProposal(60_000),
          "完成"
        )
      ])
    );

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaMatchCandidates).toHaveLength(2)
    );
    expect(cancelTauriAudioAlignmentBatchJob).not.toHaveBeenCalled();
  });

  it("运行中打开同 ID 的另一项目版本会取消旧任务且不跨项目写入候选或状态", async () => {
    const startDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentBatchJob).mockReturnValueOnce(startDeferred.promise);
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockImplementation((jobId) =>
      Promise.resolve(
        createLegacyBatchSnapshot(jobId, [
          createTestBatchPair("source-long", "target-ep1", "cancelled", null, "已取消"),
          createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已取消")
        ])
      )
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));

    const previousProject = useEditorStore.getState().project;
    const replacement = createMatchingProject();
    replacement.id = previousProject.id;
    replacement.name = "同 ID 的重开版本";
    replacement.mediaLibrary = replacement.mediaLibrary.map((media) =>
      media.id === "source-long" ? { ...media, localPath: "D:\\video\\replacement.mkv" } : media
    );
    act(() =>
      useEditorStore
        .getState()
        .openProjectFromText(serializeProject(replacement), "replacement.json")
    );

    startDeferred.resolve(
      createLegacyBatchSnapshot("batch-from-old-project", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "旧项目任务迟到"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );

    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("batch-from-old-project")
    );
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(useEditorStore.getState().project.name).toBe("同 ID 的重开版本");
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
    expect(useEditorStore.getState().status.message).toContain("已打开项目");
  });

  it("旧项目 start 迟到时不会覆盖新批次活动 job，取消仍终止新任务", async () => {
    const oldStartDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    const newPollDeferred = createDeferred<AudioAlignmentBatchJobSnapshot>();
    vi.mocked(startTauriAudioAlignmentBatchJob)
      .mockReturnValueOnce(oldStartDeferred.promise)
      .mockResolvedValueOnce(
        createLegacyBatchSnapshot("batch-new-project", [
          createTestBatchPair("source-long", "target-ep1", "running", null, "新项目任务运行中"),
          createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
        ])
      );
    vi.mocked(getTauriAudioAlignmentBatchJob).mockReturnValueOnce(newPollDeferred.promise);
    vi.mocked(cancelTauriAudioAlignmentBatchJob).mockImplementation((jobId) =>
      Promise.resolve(
        createLegacyBatchSnapshot(jobId, [
          createTestBatchPair("source-long", "target-ep1", "cancelled", null, "已取消"),
          createTestBatchPair("source-long", "target-ep2", "cancelled", null, "已取消")
        ])
      )
    );
    render(<MatchingHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await waitFor(() => expect(startTauriAudioAlignmentBatchJob).toHaveBeenCalledTimes(1));

    const replacement = createMatchingProject();
    replacement.id = useEditorStore.getState().project.id;
    replacement.name = "并发切换后的项目";
    act(() =>
      useEditorStore
        .getState()
        .openProjectFromText(serializeProject(replacement), "replacement.json")
    );
    act(() => publishMatchingInventory(useEditorStore.getState().project));
    fireEvent.click(await screen.findByRole("button", { name: "开始批量匹配" }));
    await screen.findByText("分析在后台继续，你可以随时切换工作区。");

    oldStartDeferred.resolve(
      createLegacyBatchSnapshot("batch-old-project", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "旧项目任务迟到"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("batch-old-project")
    );
    expect(screen.queryByText("旧项目任务迟到")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消剩余任务" }));
    newPollDeferred.resolve(
      createLegacyBatchSnapshot("batch-new-project", [
        createTestBatchPair("source-long", "target-ep1", "running", null, "新项目任务运行中"),
        createTestBatchPair("source-long", "target-ep2", "queued", null, "等待执行")
      ])
    );
    await waitFor(() =>
      expect(cancelTauriAudioAlignmentBatchJob).toHaveBeenCalledWith("batch-new-project")
    );
    expect(useEditorStore.getState().project.name).toBe("并发切换后的项目");
    expect(useEditorStore.getState().project.mediaMatchCandidates).toEqual([]);
  });

  it("打开同项目 ID 但媒体 ID 已变化的版本时重新默认选择全部新素材", async () => {
    render(<MatchingHarness />);
    await waitFor(() => expect(screen.getByText(/共 2 组/)).toBeInTheDocument());

    const replacement = createMatchingProject();
    replacement.id = useEditorStore.getState().project.id;
    replacement.mediaLibrary = [
      createMedia(
        "source-reopened",
        "bilibiliReference",
        "D:\\video\\reopened-source.mkv",
        180_000
      ),
      createMedia("target-reopened", "targetOriginal", "D:\\video\\reopened-target.mkv", 60_000)
    ];
    replacement.danmakuSourceBindings = replacement.danmakuSourceBindings.map((binding) => ({
      ...binding,
      sourceMediaId: "source-reopened"
    }));
    act(() =>
      useEditorStore
        .getState()
        .openProjectFromText(serializeProject(replacement), "reopened.json")
    );

    await waitFor(() =>
      expect(screen.getByText(/将分析 1 个参考 × 1 个原片，共 1 组/)).toBeInTheDocument()
    );
  });
});

function MatchingHarness({
  suspectedCutCandidates = [],
  playbackAdapterFactory
}: {
  suspectedCutCandidates?: SuspectedCutCandidate[];
  playbackAdapterFactory?: TimeMapPlaybackAdapterFactory;
}) {
  const project = useEditorStore((state) => state.project);
  const workspacePage = useEditorStore((state) => state.workspacePage);
  if (workspacePage === "editing") {
    return <AlignmentEditorWorkspace playbackAdapterFactory={playbackAdapterFactory} />;
  }
  return (
    <MediaMatchingPanel project={project} suspectedCutCandidates={suspectedCutCandidates} />
  );
}

function MatchingWorkflowHarness() {
  const workspacePage = useEditorStore((state) => state.workspacePage);
  if (workspacePage === "materials") {
    return <MaterialsWorkspace />;
  }
  return <MatchingHarness />;
}

function createFakePlaybackAdapter(): {
  adapter: MediaAdapter;
  load: ReturnType<typeof vi.fn<MediaAdapter["load"]>>;
  play: ReturnType<typeof vi.fn<MediaAdapter["play"]>>;
  seek: ReturnType<typeof vi.fn<MediaAdapter["seek"]>>;
  setMuted: ReturnType<typeof vi.fn<NonNullable<MediaAdapter["setMuted"]>>>;
} {
  let currentTimeMs = 0;
  const load = vi.fn<MediaAdapter["load"]>((_source, startPositionMs = 0) => {
    currentTimeMs = startPositionMs;
    return Promise.resolve();
  });
  const play = vi.fn<MediaAdapter["play"]>(() => Promise.resolve());
  const seek = vi.fn<MediaAdapter["seek"]>((positionMs) => {
    currentTimeMs = positionMs;
  });
  const setMuted = vi.fn<NonNullable<MediaAdapter["setMuted"]>>();
  return {
    load,
    play,
    seek,
    setMuted,
    adapter: {
      load,
      play,
      pause: vi.fn<MediaAdapter["pause"]>(),
      seek,
      getCurrentTimeMs: vi.fn<MediaAdapter["getCurrentTimeMs"]>(() => currentTimeMs),
      getDurationMs: vi.fn<MediaAdapter["getDurationMs"]>(() => 180_000),
      getTracks: vi.fn<MediaAdapter["getTracks"]>(() => []),
      setPlaybackRate: vi.fn<MediaAdapter["setPlaybackRate"]>(),
      setMuted,
      dispose: vi.fn<MediaAdapter["dispose"]>()
    }
  };
}

function createAdvancingPlaybackAdapter(): {
  adapter: MediaAdapter;
  play: ReturnType<typeof vi.fn<MediaAdapter["play"]>>;
} {
  let currentTimeMs = 0;
  let playing = false;
  let lastObservedAtMs = Date.now();
  const observe = (): number => {
    const now = Date.now();
    if (playing) {
      currentTimeMs += Math.max(0, now - lastObservedAtMs);
    }
    lastObservedAtMs = now;
    return currentTimeMs;
  };
  const play = vi.fn<MediaAdapter["play"]>(() => {
    lastObservedAtMs = Date.now();
    playing = true;
    return Promise.resolve();
  });
  return {
    play,
    adapter: {
      load: vi.fn<MediaAdapter["load"]>((_source, startPositionMs = 0) => {
        currentTimeMs = startPositionMs;
        playing = false;
        lastObservedAtMs = Date.now();
        return Promise.resolve();
      }),
      play,
      pause: vi.fn<MediaAdapter["pause"]>(() => {
        observe();
        playing = false;
      }),
      seek: vi.fn<MediaAdapter["seek"]>((positionMs) => {
        currentTimeMs = positionMs;
        lastObservedAtMs = Date.now();
      }),
      getCurrentTimeMs: vi.fn<MediaAdapter["getCurrentTimeMs"]>(observe),
      getDurationMs: vi.fn<MediaAdapter["getDurationMs"]>(() => 180_000),
      getTracks: vi.fn<MediaAdapter["getTracks"]>(() => []),
      setPlaybackRate: vi.fn<MediaAdapter["setPlaybackRate"]>(),
      setMuted: vi.fn<NonNullable<MediaAdapter["setMuted"]>>(),
      dispose: vi.fn<MediaAdapter["dispose"]>()
    }
  };
}

function createMatchingProject(): EditorProject {
  const project = createEmptyProject("暗黑 S01");
  const asset = parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i><d p="10,1,25,16777215,0,0,u,r">测试</d></i>`,
    { assetId: "asset-long", fileName: "collection.xml" }
  );
  project.assets = [asset];
  project.mediaLibrary = [
    createMedia("source-long", "bilibiliReference", "D:\\video\\collection.mkv", 180_000),
    createMedia("target-ep1", "targetOriginal", "D:\\video\\ep1.mkv", 60_000),
    createMedia("target-ep2", "targetOriginal", "D:\\video\\ep2.mkv", 60_000)
  ];
  project.danmakuSourceBindings = [
    {
      id: "binding-long",
      assetId: asset.id,
      sourceMediaId: "source-long",
      linkedAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z"
    }
  ];
  return project;
}

function acceptAllMatchingCandidates(qualityLevel: MediaTimeMapQualityLevel | null): void {
  const candidateCount = useEditorStore.getState().project.mediaMatchCandidates.length;
  acceptMatchingCandidatesWithQualities(
    Array.from({ length: candidateCount }, () => qualityLevel)
  );
}

function acceptMatchingCandidatesWithQualities(
  qualityLevels: ReadonlyArray<MediaTimeMapQualityLevel | null>
): void {
  useEditorStore.setState((state) => {
    if (qualityLevels.length !== state.project.mediaMatchCandidates.length) {
      throw new Error("测试质量级别必须逐项对应候选关系。");
    }
    const confirmedMaps = state.project.mediaMatchCandidates.flatMap((candidate, index) => {
      const qualityLevel = qualityLevels[index];
      if (!qualityLevel) return [];
      const candidateMap = state.project.mediaTimeMaps.find(
        (timeMap) => timeMap.id === candidate.timeMapId
      );
      if (!candidateMap) {
        throw new Error(`测试候选 ${candidate.id} 缺少候选 TimeMap。`);
      }
      return [
        {
          ...candidateMap,
          id: `confirmed:${candidate.id}:${qualityLevel}`,
          state: "confirmed" as const,
          quality: { ...candidateMap.quality, level: qualityLevel },
          confirmedAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z"
        }
      ];
    });
    return {
      project: {
        ...state.project,
        mediaTimeMaps: [...state.project.mediaTimeMaps, ...confirmedMaps],
        mediaMatchCandidates: state.project.mediaMatchCandidates.map((candidate, index) => {
          const qualityLevel = qualityLevels[index];
          return {
            ...candidate,
            state: "accepted" as const,
            confirmedTimeMapId: qualityLevel
              ? `confirmed:${candidate.id}:${qualityLevel}`
              : null
          };
        })
      }
    };
  });
}

const MATCHING_INVENTORY_REVISION = "inventory-v1:matching-ready";

interface MatchingInventoryOverride {
  recommendation?: "recommended" | "needsChoice" | "unavailable";
  indexes?: number[];
  probeCompleteness?: "complete" | "partial" | "fallbackRequired";
}

function setMatchingProject(
  project: EditorProject,
  overrides: Record<string, MatchingInventoryOverride> = {}
): void {
  useEditorStore.setState({
    project,
    mediaInventoryGeneration: 0,
    mediaInventoryGenerationKey: null,
    mediaInventoryPhase: "idle",
    mediaInventoryCounts: null,
    mediaInventoryRows: {},
    mediaInventoryPaused: false,
    mediaInventoryCancelling: false,
    mediaInventoryRestartRequired: false,
    mediaInventoryTerminalMessage: null,
    workspaceIntentSequence: 0,
    workspaceIntentRequest: null
  });
  publishMatchingInventory(project, overrides);
}

function publishMatchingInventory(
  project: EditorProject,
  overrides: Record<string, MatchingInventoryOverride> = {}
): void {
  const generationKey = useEditorStore.getState().synchronizeMediaInventory();
  const changedRows = project.mediaLibrary.map((media) =>
    createMatchingInventoryRow(media.id, overrides[media.id])
  );
  useEditorStore.getState().applyMediaInventoryPublication({
    generationKey,
    phase: "completed",
    counts: {
      total: changedRows.length,
      queued: 0,
      probing: 0,
      ready: changedRows.length,
      failed: 0,
      cancelled: 0
    },
    changedRows,
    terminalMessage: null,
    restartRequired: false
  });
}

function createMatchingInventoryRow(
  mediaId: string,
  override: MatchingInventoryOverride = {}
): MediaInventoryPublication["changedRows"][number] {
  const indexes = override.indexes ?? [2];
  const recommendation = override.recommendation ?? "recommended";
  return {
    mediaId,
    status: "ready",
    inventoryRevision: MATCHING_INVENTORY_REVISION,
    durationMs: 120_000,
    audioTracks: indexes.map((index) => ({
      index,
      codec: "aac",
      language: index === 2 ? "jpn" : "eng",
      title: index === 2 ? "Original" : "Commentary",
      sampleRate: 48_000,
      channels: 2,
      channelLayout: "stereo",
      durationMs: 120_000,
      dispositions: {
        default: index === 2,
        original: index === 2,
        dub: false,
        commentary: index === 7,
        descriptions: false,
        visualImpaired: false,
        hearingImpaired: false,
        cleanEffects: false,
        karaoke: false
      },
      recommendationRank: index,
      reasonCodes: []
    })),
    recommendation: {
      state: recommendation,
      streamIndex: recommendation === "recommended" ? (indexes[0] ?? null) : null,
      reasonCodes: recommendation === "recommended" ? ["originalDisposition"] : []
    },
    probeCompleteness: override.probeCompleteness ?? "complete",
    cacheState: "miss"
  };
}

function configureSingleTargetV2Project(level: MediaTimeMapQualityLevel): void {
  const project = createMatchingProject();
  project.mediaLibrary = project.mediaLibrary.filter((media) => media.id !== "target-ep2");
  setMatchingProject(project);
  vi.mocked(startTauriAudioAlignmentJob).mockResolvedValue({
    jobId: `job-v2-${level}`,
    status: "completed",
    ...audioAlignmentJobStage("completed"),
    progress: 1,
    message: "完成",
    logs: [],
    proposal: createV2Proposal(0, level),
    error: null,
    updatedAtMs: 1
  });
}

function addSecondSource(project: EditorProject): void {
  const asset = parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i><d p="15,1,25,16777215,0,0,u,r">测试 B</d></i>`,
    { assetId: "asset-long-b", fileName: "collection-b.xml" }
  );
  project.assets.push(asset);
  project.mediaLibrary.push(
    createMedia("source-long-b", "bilibiliReference", "D:\\video\\collection-b.mkv", 180_000)
  );
  project.danmakuSourceBindings.push({
    id: "binding-long-b",
    assetId: asset.id,
    sourceMediaId: "source-long-b",
    linkedAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  });
}

function createMedia(
  id: string,
  role: ProjectMediaRole,
  localPath: string,
  durationMs: number
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: localPath.split("\\").at(-1) ?? id,
    objectUrl: null,
    durationMs,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件路径",
    localPath,
    emby: null,
    episodeKey: role === "targetOriginal" ? id : null,
    episodeLabel: role === "targetOriginal" ? id : null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function createProposal(sourceStartMs: number): AlignmentProposal {
  return {
    anchors: [
      {
        id: "audio-anchor-1",
        sourceMs: sourceStartMs,
        targetMs: 0,
        origin: "automatic",
        confidence: 0.9
      },
      {
        id: "audio-anchor-2",
        sourceMs: sourceStartMs + 50_000,
        targetMs: 50_000,
        origin: "automatic",
        confidence: 0.9
      }
    ],
    cutCandidates: [],
    confidence: 0.9,
    diagnostics: ["长参考定位成功"],
    matchRange: {
      sourceStartMs,
      sourceEndMs: sourceStartMs + 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 0.9
    }
  };
}

function createV2Proposal(
  sourceStartMs: number,
  level: MediaTimeMapQualityLevel
): AlignmentProposal {
  const sourceEndMs = sourceStartMs + 60_000;
  const qualityReasons: Record<MediaTimeMapQualityLevel, string[]> = {
    verified: ["双证据和留出锚点均达到门槛。"],
    review: ["备选路径差距偏小，需要试听复核。"],
    blocked: ["存在无法唯一解释的歧义区间。"],
    "legacy-unverified": ["由旧版规则迁移，尚未经过真实媒体验证。"]
  };
  return {
    ...createProposal(sourceStartMs),
    confidence: 0.91,
    timeMap: {
      sourceStartMs,
      sourceEndMs,
      targetStartMs: 0,
      targetEndMs: 60_000,
      spans: [
        createProposalSpan(
          {
            kind: "matched",
            sourceStartMs,
            sourceEndMs,
            targetStartMs: 0,
            targetEndMs: 60_000
          },
          `v2-${level}:span:0001`,
          level
        )
      ],
      quality: {
        level,
        probability: level === "verified" ? 0.999 : null,
        metricSource: level === "legacy-unverified" ? "estimated" : "measured",
        coverage: 0.96,
        uniqueContentCoverage: 0.94,
        p50ResidualMs: 35,
        p95ResidualMs: 80,
        p99ResidualMs: 120,
        maxResidualMs: 140,
        boundaryUncertaintyMs: 180,
        alternativeMargin: 0.32,
        anchorCount: 36,
        anchorRegionCount: 3,
        heldOutAnchorCount: 6,
        reasons: qualityReasons[level]
      },
      evidence: {
        types: level === "legacy-unverified" ? ["legacy"] : ["audio", "visual"],
        audioAnchorCount: 36,
        visualAnchorCount: level === "legacy-unverified" ? 0 : 12,
        heldOutAnchorCount: 6,
        top1Top2Margin: 0.32,
        uniqueContentCoverage: 0.94,
        repeatedContentOnly: false,
        selectedTrackReason: "国语音轨覆盖完整且残差最低。",
        alternativeTrackScores: [
          {
            sourceStreamIndex: 1,
            targetStreamIndex: 2,
            score: 0.92,
            scale: 1,
            offsetMs: 0,
            inlierCount: 36
          },
          {
            sourceStreamIndex: 1,
            targetStreamIndex: 3,
            score: 0.6,
            scale: 1,
            offsetMs: 500,
            inlierCount: 20
          }
        ],
        notes: []
      },
      sourceStream: {
        type: "audio",
        index: 1,
        codec: "aac",
        startMs: 0,
        timelineOffsetMs: 0,
        timeBase: "1/48000",
        sampleRate: 48_000,
        channels: 2,
        frameRate: null,
        language: "zh",
        title: "国语"
      },
      targetStream: {
        type: "audio",
        index: 2,
        codec: "flac",
        startMs: 0,
        timelineOffsetMs: 0,
        timeBase: "1/48000",
        sampleRate: 48_000,
        channels: 6,
        frameRate: null,
        language: "zh",
        title: "正片"
      },
      sourceIdentity: testContentIdentity("source"),
      targetIdentity: testContentIdentity("target"),
      engineVersion: "alignment-v2.4",
      featureVersion: "chroma-v2",
      parametersHash: `v2-test-${level}`
    }
  };
}

function createFourKindV2Proposal(): AlignmentProposal {
  const proposal = createV2Proposal(5_000, "blocked");
  if (!proposal.timeMap) {
    throw new Error("测试 V2 提案缺少时间图。");
  }
  return {
    ...proposal,
    anchors: [
      {
        id: "audio-anchor-four-kinds-1",
        sourceMs: 6_000,
        targetMs: 1_000,
        origin: "automatic",
        confidence: 0.9
      },
      {
        id: "audio-anchor-four-kinds-2",
        sourceMs: 14_000,
        targetMs: 9_000,
        origin: "automatic",
        confidence: 0.9
      }
    ],
    matchRange: {
      sourceStartMs: 5_000,
      sourceEndMs: 25_000,
      targetStartMs: 0,
      targetEndMs: 21_000,
      coverage: 0.72
    },
    timeMap: {
      ...proposal.timeMap,
      sourceStartMs: 5_000,
      sourceEndMs: 25_000,
      targetStartMs: 0,
      targetEndMs: 21_000,
      spans: [
        createProposalSpan(
          {
            kind: "matched",
            sourceStartMs: 5_000,
            sourceEndMs: 15_000,
            targetStartMs: 0,
            targetEndMs: 10_000
          },
          "four-kind:span:0001",
          "review"
        ),
        createProposalSpan(
          {
            kind: "sourceOnly",
            sourceStartMs: 15_000,
            sourceEndMs: 17_000,
            targetStartMs: 10_000,
            targetEndMs: 10_000
          },
          "four-kind:span:0002",
          "review"
        ),
        createProposalSpan(
          {
            kind: "targetOnly",
            sourceStartMs: 17_000,
            sourceEndMs: 17_000,
            targetStartMs: 10_000,
            targetEndMs: 13_000
          },
          "four-kind:span:0003",
          "review"
        ),
        createProposalSpan(
          {
            kind: "ambiguous",
            sourceStartMs: 17_000,
            sourceEndMs: 25_000,
            targetStartMs: 13_000,
            targetEndMs: 21_000
          },
          "four-kind:span:0004",
          "blocked"
        )
      ],
      quality: {
        ...proposal.timeMap.quality,
        level: "blocked",
        probability: null,
        coverage: 0.72,
        reasons: ["存在无法唯一解释的歧义区间。"]
      },
      parametersHash: "v2-test-four-span-kinds"
    }
  };
}

function createProposalSpan(span: TimeMapSpan, id: string, level: MediaTimeMapQualityLevel) {
  const complete = createTestCompleteTimeMapSpan(span, id);
  return {
    ...complete,
    quality: {
      ...complete.quality,
      level,
      metricSource: "measured" as const,
      coverage: 0.96,
      uniqueContentCoverage: 0.94,
      alternativeMargin: 0.32,
      anchorCount: span.kind === "matched" ? 12 : 0,
      heldOutAnchorCount: span.kind === "matched" ? 3 : 0,
      p50ResidualMs: span.kind === "matched" ? 35 : null,
      p95ResidualMs: span.kind === "matched" ? 80 : null,
      p99ResidualMs: span.kind === "matched" ? 120 : null,
      maxResidualMs: span.kind === "matched" ? 140 : null,
      boundaryUncertaintyMs: 180,
      reasons: [`测试逐段质量：${level}`]
    }
  };
}

function testContentIdentity(seed: string) {
  const digit = seed === "source" ? "1" : "2";
  return {
    algorithm: "fnv1a64-first-middle-last-64k-v1",
    sizeBytes: seed === "source" ? 1_000_000 : 2_000_000,
    modifiedUnixMs: seed === "source" ? 1_000 : 2_000,
    firstSampleDigest: digit.repeat(16),
    middleSampleDigest: (seed === "source" ? "3" : "4").repeat(16),
    lastSampleDigest: (seed === "source" ? "5" : "6").repeat(16)
  };
}

function createV2ProposalWithProbability(
  sourceStartMs: number,
  probability: number
): AlignmentProposal {
  const proposal = createV2Proposal(sourceStartMs, "verified");
  if (!proposal.timeMap) {
    throw new Error("测试 V2 提案缺少时间图。");
  }
  return {
    ...proposal,
    confidence: probability,
    timeMap: {
      ...proposal.timeMap,
      quality: {
        ...proposal.timeMap.quality,
        probability
      }
    }
  };
}

function createProposalWithCut(): AlignmentProposal {
  return {
    anchors: [],
    cutCandidates: [
      {
        id: "audio-gap",
        name: "音频差异",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 19_000,
        sourceRangeEndMs: 21_000,
        targetGapMs: 5_000,
        confidence: 0.72,
        note: "音频候选"
      }
    ],
    confidence: 0.9,
    diagnostics: [],
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 0.9
    },
    evidence: {
      algorithm: "time-map-audio",
      completeFingerprintCount: 10,
      sourceFingerprintCount: 8,
      fingerprintMatchCount: 8,
      monotonicMatchCount: 8,
      strongAnchorCount: 6,
      weakAnchorCount: 2,
      offsetClusterCount: 2,
      refinedCandidateCount: 1,
      lowConfidenceRegionCount: 0,
      quality: "medium",
      timeMappingSegmentCount: 2,
      confirmedChangeCount: 1,
      signals: []
    }
  };
}

function createSuspectedCut(
  id: string,
  assetId: string,
  assetFileName: string,
  sourceAtMs: number
): SuspectedCutCandidate {
  return {
    id,
    assetId,
    assetFileName,
    sourceAtMs,
    startMs: sourceAtMs - 1_000,
    endMs: sourceAtMs + 1_000,
    hitCount: 2,
    score: 6,
    confidence: "medium",
    keywords: ["删了"],
    sampleTexts: ["这里是不是删了"],
    itemIds: [`${assetId}-item`]
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function selectWorkspaceAction(menu: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: menu }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}
function matchingResultQuery() {
  if (!screen.queryByRole("dialog", { name: "全部结果与已保存关系" })) {
    const close = screen.queryByRole("button", { name: "关闭匹配范围与计算设置" });
    if (close) fireEvent.click(close);
    selectWorkspaceAction("匹配工具", "全部结果与已保存关系");
  }
  return screen;
}
function matchingConfigurationQuery() {
  if (!screen.queryByRole("dialog", { name: "匹配范围与计算设置" })) {
    const close = screen.queryByRole("button", { name: "关闭全部结果与已保存关系" });
    if (close) fireEvent.click(close);
    selectWorkspaceAction("匹配工具", "匹配范围与计算设置");
  }
  return screen;
}
async function findMatchingCandidate() {
  matchingResultQuery();
  return screen.findByTestId("media-match-candidate");
}
function getMatchingCandidates() {
  matchingResultQuery();
  return screen.getAllByTestId("media-match-candidate");
}
