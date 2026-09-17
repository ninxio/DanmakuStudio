import { describe, expect, it } from "vitest";
import type { AlignmentProposal, AlignmentTimeMapProposal } from "../../domain/alignment/types";
import {
  AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
  AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
  AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
  type AudioAlignmentBatchFineFrontierReceiptSnapshot,
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentBatchPairSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import {
  batchTaskPatchFromPairSnapshot,
  describeNativeFineDisposition
} from "./matchingBatchResult";

describe("原生精匹配结果解释", () => {
  it("把正常完成但没有合格候选解释为计算正常的无对应关系", () => {
    const snapshot = createPairSnapshot({
      fineFrontier: createFineFrontier("noEligibleCandidate")
    });

    expect(describeNativeFineDisposition(snapshot, "completed")).toEqual({
      kind: "noEligibleCandidate",
      taskState: "notFound",
      message: "没有找到对应关系；计算已正常完成，这不是运行错误。",
      reason: "所选两段素材没有足够的共同音视频证据，或并非同一集内容。"
    });
  });

  it("为 blocked TimeMap 保留逐段人工复核候选", () => {
    const snapshot = createPairSnapshot({
      fineFrontier: createFineFrontier("noEligibleCandidate"),
      proposal: createBlockedReviewProposal()
    });

    expect(describeNativeFineDisposition(snapshot, "completed")).toEqual({
      kind: "reviewCandidate",
      taskState: "unresolved",
      message:
        "找到一张候选时间图，但检测到删减边界、证据空白或局部歧义；已加入人工复核，不能直接确认或导出。",
      reason: "候选时间图未通过自动确认门控，必须逐段复核并修正阻断区域。"
    });
  });

  it("把资源上限失败解释为可操作的资源阻断", () => {
    const snapshot = createPairSnapshot({
      status: "failed",
      message: "fine match failed",
      error: "blocked:resource-limit memory budget exceeded"
    });

    const disposition = describeNativeFineDisposition(snapshot, "failed");

    expect(disposition.kind).toBe("resourceBlocked");
    expect(disposition.taskState).toBe("failed");
    expect(disposition.message).toBe(
      "这组没有完成分析：可用资源不足。精匹配窗口超过本机安全资源预算；可改用 CPU、减少同时选中的多音轨版本，或查看诊断中的窗口大小。"
    );
  });

  it("优先把 evidence-contract 失败解释为应用内部校验错误", () => {
    const snapshot = createPairSnapshot({
      status: "failed",
      message: "evidence-contract-failed",
      error: "staged evidence binding invalid"
    });

    const disposition = describeNativeFineDisposition(snapshot, "failed");

    expect(disposition.kind).toBe("infrastructureFailed");
    expect(disposition.message).toBe(
      "这组没有完成分析：应用内部结果校验失败，素材未被判定为损坏。请展开“运行诊断”查看原因，并使用修复版本重试。"
    );
  });

  it("取消状态永远不会发布为候选", () => {
    const snapshot = createPairSnapshot({ status: "cancelled" });

    expect(describeNativeFineDisposition(snapshot, "completed")).toEqual({
      kind: "cancelled",
      taskState: "cancelled",
      message: "这组没有完成分析：任务已取消；取消结果不会用于确认。",
      reason: "这组没有完成分析：任务已取消；取消结果不会用于确认。"
    });
  });

  it("拒绝尚未进入原生终态的组合", () => {
    const snapshot = createPairSnapshot({ status: "running" });

    expect(describeNativeFineDisposition(snapshot, "completed")).toEqual({
      kind: "infrastructureFailed",
      taskState: "failed",
      message: "这组没有完成分析：未收到原生精匹配终态。",
      reason: "这组没有完成分析：未收到原生精匹配终态。"
    });
  });

  it("拒绝已完成但缺少最终裁决证据的组合", () => {
    const snapshot = createPairSnapshot();

    expect(describeNativeFineDisposition(snapshot, "completed")).toEqual({
      kind: "infrastructureFailed",
      taskState: "failed",
      message: "这组没有完成分析：缺少原生精匹配最终裁决证据。",
      reason: "这组没有完成分析：缺少原生精匹配最终裁决证据。"
    });
  });

  it("任务补丁只保留当前组合与批次级诊断并保持既有时间格式", () => {
    const pair = createPairSnapshot({ status: "running", progress: 0.2 });
    const batch = createBatchSnapshot(pair, {
      status: "running",
      progress: 0.4,
      diagnosticEvents: [
        {
          sequence: 1,
          atMs: 1,
          elapsedMs: 12_345,
          level: "info",
          stageKey: "media",
          mediaOrdinal: 1,
          pairOrdinal: null,
          message: "共享素材已读取",
          durationMs: 10_500
        },
        {
          sequence: 2,
          atMs: 2,
          elapsedMs: 13_000,
          level: "warning",
          stageKey: "pair",
          mediaOrdinal: null,
          pairOrdinal: 1,
          message: "当前组合需复核",
          durationMs: null
        },
        {
          sequence: 3,
          atMs: 3,
          elapsedMs: 14_000,
          level: "error",
          stageKey: "other-pair",
          mediaOrdinal: null,
          pairOrdinal: 2,
          message: "其他组合错误",
          durationMs: null
        }
      ]
    });

    expect(batchTaskPatchFromPairSnapshot(pair, batch)).toEqual({
      jobId: "batch-1",
      progress: 0.4,
      state: "running",
      message: "正在寻找可能对应的片段",
      logs: [
        "[+0:12.345] [信息] [素材 #1] 共享素材已读取（本阶段耗时 0:10.500）",
        "[+0:13.000] [注意] [组合 #1] 当前组合需复核"
      ]
    });
  });
});

function createPairSnapshot(
  patch: Partial<AudioAlignmentBatchPairSnapshot> = {}
): AudioAlignmentBatchPairSnapshot {
  return {
    pairIndex: 0,
    pairOrdinal: 1,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    status: "completed",
    progress: 1,
    message: "批次组合已完成",
    relationRanking: {
      scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
      executionIdentityDigest: null,
      executionIdentity: null,
      state: "noEligibleCandidate",
      candidateCount: 0,
      eligibleCandidateCount: 0,
      score: null,
      bestEligibleCandidate: null
    },
    globalSelection: {
      state: "blocked",
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
    },
    fineFrontier: null,
    fineExecutionEvidence: null,
    proposal: null,
    error: null,
    ...patch
  };
}

function createBatchSnapshot(
  pair: AudioAlignmentBatchPairSnapshot,
  patch: Partial<AudioAlignmentBatchJobSnapshot> = {}
): AudioAlignmentBatchJobSnapshot {
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "batch-1",
    pairingMode: "explicit",
    sourceMediaIds: [pair.sourceMediaId],
    targetMediaIds: [pair.targetMediaId],
    versionReuseGroups: [],
    status: "completed",
    progress: 1,
    message: "批次已完成",
    totalPairCount: 1,
    processedPairCount: 1,
    failedPairCount: 0,
    currentPairOrdinal: null,
    diagnosticEvents: [],
    pairs: [pair],
    error: null,
    updatedAtMs: 1,
    ...patch
  };
}

function createFineFrontier(
  finalState: AudioAlignmentBatchFineFrontierReceiptSnapshot["finalState"]
): AudioAlignmentBatchFineFrontierReceiptSnapshot {
  return {
    contractVersion: AUDIO_ALIGNMENT_BATCH_FINE_FRONTIER_CONTRACT_VERSION,
    scoreVersion: AUDIO_ALIGNMENT_BATCH_FINE_SCORE_VERSION,
    inventoryDigest: "sha256:test-inventory",
    inventoryCandidates: [],
    receiptDigest: "sha256:test-receipt",
    componentOrdinal: 1,
    componentPairOrdinals: [1],
    inventoryCandidateCount: 0,
    resolutionMarginMicros: 0,
    overlapToleranceMs: 0,
    limits: {
      maxCandidates: 1,
      maxSearchStates: 1,
      maxSearchExpansions: 1,
      maxIntervalComparisons: 1,
      maxIntervalsPerAxis: 1,
      maxTotalIntervals: 1,
      refinementBatchSize: 1
    },
    inventoryStateCounts: {
      unresolved: 0,
      scored: 0,
      evaluatedIneligible: 0,
      evidenceBlocked: 0,
      resourceBlocked: 0,
      infrastructureFailed: 0,
      cancelled: 0
    },
    refinementRoundCount: 0,
    evaluatedCandidateCount: 0,
    finalState,
    resolved: false,
    selectedCandidateIds: [],
    selectedTotalScoreMicros: null,
    bestCompleted: { candidateIds: [], totalScoreMicros: 0 },
    runnerUpCompleted: null,
    optimisticOmitted: null,
    nextRefinementCandidateIds: [],
    deferredCandidateCount: 0,
    proof: {
      beatsRunnerUpWithMargin: false,
      beatsOptimisticOmittedWithMargin: false
    },
    search: { statesVisited: 0, expansionsConsidered: 0, intervalComparisons: 0 }
  };
}

function createBlockedReviewProposal(): AlignmentProposal {
  const timeMap: AlignmentTimeMapProposal = {
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 1_000,
    targetEndMs: 11_000,
    spans: [
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 1_000,
        targetEndMs: 11_000
      })
    ],
    quality: {
      level: "blocked",
      probability: null,
      metricSource: "missing",
      coverage: 1,
      p50ResidualMs: null,
      p95ResidualMs: null,
      p99ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      alternativeMargin: null,
      anchorCount: 0,
      heldOutAnchorCount: 0,
      reasons: ["测试阻断"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 0,
      top1Top2Margin: null,
      notes: []
    },
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    engineVersion: "test-engine",
    featureVersion: "test-feature",
    parametersHash: "test-parameters"
  };
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.5,
    diagnostics: [],
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 1_000,
      targetEndMs: 11_000,
      coverage: 1
    },
    timeMap
  };
}
