import {
  createAlignmentExperimentQueueConfigDigest,
  type AlignmentExperimentPairOutcome,
  type AlignmentExperimentQueue,
  type AlignmentExperimentQueueConfig,
  type FinishAlignmentExperimentPairInput
} from "../../domain/alignment/alignmentExperimentQueue";
import type { SpectralBackendPreference } from "../../domain/alignment/spectralBackendPreference";
import {
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentBatchPairSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { describeNativeFineDisposition } from "./matchingBatchResult";
import type { BatchTask, BatchTaskState } from "./matchingTaskModels";

export interface BuildMatchingExperimentQueueConfigInput {
  sourceMediaIds: string[];
  targetMediaIds: string[];
  pairs: Array<{ sourceMediaId: string; targetMediaId: string }>;
  versionReuseGroups: Array<{
    groupId: string;
    side: "source" | "target";
    mediaIds: string[];
  }>;
  selectedAudioStreamIndexes: Record<string, number | null>;
  spectralBackend: SpectralBackendPreference;
  windowMs: number;
  minGapMs: number;
  matchThreshold: number;
  enableVisualEvidence: boolean;
}

export function buildMatchingExperimentQueueConfig(
  input: BuildMatchingExperimentQueueConfigInput
): AlignmentExperimentQueueConfig {
  const inventory = new Set([...input.sourceMediaIds, ...input.targetMediaIds]);
  const audioStreamSelections = Object.fromEntries(
    Object.entries(input.selectedAudioStreamIndexes)
      .filter(([mediaId, streamIndex]) => inventory.has(mediaId) && streamIndex !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    sourceMediaIds: [...input.sourceMediaIds],
    targetMediaIds: [...input.targetMediaIds],
    pairs: input.pairs.map((pair) => ({ ...pair })),
    versionReuseGroups: input.versionReuseGroups.map((group) => ({
      ...group,
      mediaIds: [...group.mediaIds]
    })),
    audioStreamSelections,
    spectralBackend: input.spectralBackend,
    windowMs: input.windowMs,
    minGapMs: input.minGapMs,
    matchThreshold: input.matchThreshold,
    enableVisualEvidence: input.enableVisualEvidence
  };
}

export function alignmentExperimentQueueToBatchTasks(
  queue: AlignmentExperimentQueue
): BatchTask[] {
  return queue.pairs.map((pair) => ({
    id: createPairKey(pair.sourceMediaId, pair.targetMediaId),
    sourceMediaId: pair.sourceMediaId,
    targetMediaId: pair.targetMediaId,
    state: queuePairStateToTaskState(pair.state),
    progress: pair.state === "pending" ? 0 : pair.state === "running" ? 0.5 : 1,
    message: queuePairMessage(pair.state, pair.attemptCount, pair.interruptionCount),
    jobId: pair.receipts.at(-1)?.jobId ?? queue.activeJobId,
    logs: pair.receipts.map(
      (receipt) =>
        `[回执 ${receipt.receiptDigest.slice(0, 19)}…] ${receipt.message}`
    )
  }));
}

export function createAlignmentExperimentFinishResults(
  snapshot: AudioAlignmentBatchJobSnapshot
): FinishAlignmentExperimentPairInput[] {
  return snapshot.pairs.map((pair) => {
    const disposition = describeNativeFineDisposition(pair, snapshot.status);
    return {
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId,
      jobId: snapshot.jobId,
      pairIndex: pair.pairIndex,
      outcome: dispositionToOutcome(disposition.kind),
      message: disposition.message,
      completedAtMs: snapshot.updatedAtMs,
      executionIdentityDigest: pair.relationRanking.executionIdentityDigest,
      fineFrontierReceiptDigest: pair.fineFrontier?.receiptDigest ?? null,
      fineExecutionEvidenceDigest: pair.fineExecutionEvidence?.evidenceDigest ?? null,
      proposalTimeMapDigest: proposalDigest(pair)
    };
  });
}

export function queueMatchesConfig(
  queue: AlignmentExperimentQueue,
  config: AlignmentExperimentQueueConfig
): boolean {
  return queue.configDigest === createAlignmentExperimentQueueConfigDigest(config);
}

function dispositionToOutcome(
  kind: ReturnType<typeof describeNativeFineDisposition>["kind"]
): AlignmentExperimentPairOutcome {
  if (kind === "confirmable") return "confirmable";
  if (kind === "reviewCandidate" || kind === "alternative" || kind === "unresolved" || kind === "evidenceBlocked") {
    return "reviewCandidate";
  }
  if (kind === "noEligibleCandidate") return "notFound";
  if (kind === "cancelled") return "cancelled";
  return "failed";
}

function proposalDigest(pair: AudioAlignmentBatchPairSnapshot): `sha256:${string}` | null {
  return pair.fineExecutionEvidence?.proposalTimeMapDigest ?? null;
}

function queuePairStateToTaskState(state: AlignmentExperimentQueue["pairs"][number]["state"]): BatchTaskState {
  if (state === "pending") return "waiting";
  if (state === "running") return "running";
  if (state === "confirmable") return "found";
  if (state === "reviewCandidate") return "unresolved";
  return state;
}

function queuePairMessage(
  state: AlignmentExperimentQueue["pairs"][number]["state"],
  attemptCount: number,
  interruptionCount: number
): string {
  const suffix = attemptCount > 0 ? `（已尝试 ${attemptCount} 次${interruptionCount > 0 ? `，中断恢复 ${interruptionCount} 次` : ""}）` : "";
  if (state === "pending") return `等待继续分析${suffix}`;
  if (state === "running") return `上次运行未进入终态，重开后会安全重试${suffix}`;
  if (state === "confirmable") return `已找到候选；项目中仍需逐项确认${suffix}`;
  if (state === "reviewCandidate") return `已保留需人工复核的候选${suffix}`;
  if (state === "notFound") return `计算完成，但没有可用候选${suffix}`;
  if (state === "cancelled") return `上次尝试已取消，可再次运行${suffix}`;
  return `上次尝试失败，可单独重试${suffix}`;
}

function createPairKey(sourceMediaId: string, targetMediaId: string): string {
  return `${sourceMediaId}\u0000${targetMediaId}`;
}
