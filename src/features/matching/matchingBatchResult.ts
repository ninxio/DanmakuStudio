import { formatTimecode } from "../../domain/shared/time";
import {
  createAudioAlignmentBatchProposalTimeMapDigest,
  type AudioAlignmentBatchDiagnosticEvent,
  type AudioAlignmentBatchFineCandidateIdSnapshot,
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentBatchPairSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import type { BatchTask, BatchTaskState } from "./matchingTaskModels";

export type NativeFineDispositionKind =
  | "confirmable"
  | "reviewCandidate"
  | "alternative"
  | "unresolved"
  | "noEligibleCandidate"
  | "resourceBlocked"
  | "evidenceBlocked"
  | "infrastructureFailed"
  | "cancelled";

export interface NativeFineDisposition {
  kind: NativeFineDispositionKind;
  taskState: BatchTaskState;
  message: string;
  reason: string | null;
}

export function batchTaskPatchFromPairSnapshot(
  snapshot: AudioAlignmentBatchPairSnapshot,
  batchSnapshot: AudioAlignmentBatchJobSnapshot
): Partial<BatchTask> {
  const batchMessage = batchSnapshot.message.trim();
  const pairMessage = snapshot.message.trim();
  const diagnosticLogs = formatBatchDiagnosticEvents(
    batchSnapshot.diagnosticEvents,
    snapshot.pairOrdinal
  );
  const base = {
    jobId: batchSnapshot.jobId,
    progress: Math.max(snapshot.progress, batchSnapshot.progress),
    logs: diagnosticLogs.length > 0 ? diagnosticLogs : pairMessage ? [pairMessage] : []
  };
  if (snapshot.status === "queued") {
    if (batchSnapshot.status === "running" && batchSnapshot.currentPairOrdinal === null) {
      return {
        ...base,
        state: "running",
        logs:
          diagnosticLogs.length > 0
            ? diagnosticLogs
            : [...new Set([batchMessage, pairMessage].filter((message) => message.length > 0))],
        message: batchMessage || pairMessage || "正在进行整批共享预处理"
      };
    }
    if (batchSnapshot.status === "running" && batchSnapshot.currentPairOrdinal !== null) {
      return {
        ...base,
        state: "waiting",
        message: `等待当前第 ${batchSnapshot.currentPairOrdinal}/${batchSnapshot.totalPairCount} 组分析完成`
      };
    }
    return {
      ...base,
      state: "waiting",
      message: pairMessage || "批次已提交，等待原生工作线程启动"
    };
  }
  if (snapshot.status === "running") {
    return { ...base, state: "running", message: "正在寻找可能对应的片段" };
  }
  if (snapshot.status === "failed") {
    const disposition = describeNativeFineDisposition(snapshot, "failed");
    return {
      ...base,
      state: "failed",
      progress: 1,
      message: disposition.message
    };
  }
  if (snapshot.status === "cancelled") {
    return { ...base, state: "cancelled", progress: 1, message: "未完成，已停止" };
  }
  if (!snapshot.fineFrontier) {
    return {
      ...base,
      state: "running",
      progress: Math.min(snapshot.progress, 0.99),
      message: "精匹配已执行，正在等待原生组件最终裁决"
    };
  }
  const disposition = describeNativeFineDisposition(snapshot, "completed");
  return {
    ...base,
    state: disposition.taskState,
    progress: 1,
    message: disposition.message
  };
}

function formatBatchDiagnosticEvents(
  events: readonly AudioAlignmentBatchDiagnosticEvent[],
  pairOrdinal: number
): string[] {
  return events
    .filter((event) => event.pairOrdinal === null || event.pairOrdinal === pairOrdinal)
    .map((event) => {
      const scope =
        event.pairOrdinal !== null
          ? `组合 #${event.pairOrdinal}`
          : event.mediaOrdinal !== null
            ? `素材 #${event.mediaOrdinal}`
            : "批次";
      const duration =
        event.durationMs === null
          ? ""
          : `（本阶段耗时 ${formatDiagnosticDuration(event.durationMs)}）`;
      const level = event.level === "error" ? "错误" : event.level === "warning" ? "注意" : "信息";
      return `[+${formatDiagnosticDuration(event.elapsedMs)}] [${level}] [${scope}] ${event.message}${duration}`;
    });
}

function formatDiagnosticDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const fraction = Math.floor(milliseconds % 1_000)
    .toString()
    .padStart(3, "0");
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
        .toString()
        .padStart(2, "0")}.${fraction}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}.${fraction}`;
}

export function describeNativeFineDisposition(
  snapshot: AudioAlignmentBatchPairSnapshot,
  batchStatus: AudioAlignmentBatchJobSnapshot["status"]
): NativeFineDisposition {
  if (batchStatus === "cancelled" || snapshot.status === "cancelled") {
    const reason = "这组没有完成分析：任务已取消；取消结果不会用于确认。";
    return { kind: "cancelled", taskState: "cancelled", message: reason, reason };
  }
  const failureText = `${snapshot.error ?? ""} ${snapshot.message}`;
  if (
    (batchStatus === "failed" || snapshot.status === "failed") &&
    isInternalResultValidationFailure(failureText)
  ) {
    const reason =
      "这组没有完成分析：应用内部结果校验失败，素材未被判定为损坏。请展开“运行诊断”查看原因，并使用修复版本重试。";
    return { kind: "infrastructureFailed", taskState: "failed", message: reason, reason };
  }
  if (snapshot.status === "failed" && isResourceLimitedFineFailure(failureText)) {
    const reason =
      "这组没有完成分析：可用资源不足。精匹配窗口超过本机安全资源预算；可改用 CPU、减少同时选中的多音轨版本，或查看诊断中的窗口大小。";
    return { kind: "resourceBlocked", taskState: "failed", message: reason, reason };
  }
  if (batchStatus === "failed" || snapshot.status === "failed") {
    const reason =
      "这组没有完成分析：原生精匹配的运行环境或证据链失败。请检查 FFmpeg、GPU 环境和任务日志后重试。";
    return { kind: "infrastructureFailed", taskState: "failed", message: reason, reason };
  }
  if (snapshot.status !== "completed") {
    const reason = "这组没有完成分析：未收到原生精匹配终态。";
    return { kind: "infrastructureFailed", taskState: "failed", message: reason, reason };
  }

  const frontier = snapshot.fineFrontier;
  if (!frontier) {
    const reason = "这组没有完成分析：缺少原生精匹配最终裁决证据。";
    return { kind: "infrastructureFailed", taskState: "failed", message: reason, reason };
  }
  if (frontier.finalState === "noEligibleCandidate") {
    const reviewTimeMap = snapshot.proposal?.timeMap ?? null;
    if (
      reviewTimeMap?.quality.level === "blocked" &&
      snapshot.proposal?.matchRange &&
      reviewTimeMap.spans.length > 0
    ) {
      return {
        kind: "reviewCandidate",
        taskState: "unresolved",
        message:
          "找到一张候选时间图，但检测到删减边界、证据空白或局部歧义；已加入人工复核，不能直接确认或导出。",
        reason: "候选时间图未通过自动确认门控，必须逐段复核并修正阻断区域。"
      };
    }
    return {
      kind: "noEligibleCandidate",
      taskState: "notFound",
      message: "没有找到对应关系；计算已正常完成，这不是运行错误。",
      reason: "所选两段素材没有足够的共同音视频证据，或并非同一集内容。"
    };
  }

  const execution = snapshot.fineExecutionEvidence;
  const candidateId = execution?.candidateId ?? null;
  const selectedByFinalAssignment =
    candidateId !== null &&
    frontier.selectedCandidateIds.some((id) => sameFineCandidateId(id, candidateId)) &&
    frontier.bestCompleted.candidateIds.some((id) => sameFineCandidateId(id, candidateId));
  const selectionReceiptConsistent =
    frontier.selectedTotalScoreMicros === frontier.bestCompleted.totalScoreMicros &&
    sameFineCandidateIdSet(frontier.selectedCandidateIds, frontier.bestCompleted.candidateIds);
  const componentBindsPair = frontier.componentPairOrdinals.includes(snapshot.pairOrdinal);
  const executionBindsPair = candidateId?.pairOrdinal === snapshot.pairOrdinal;
  const proposalTimeMap = snapshot.proposal?.timeMap ?? null;
  const executionBindsProposal =
    proposalTimeMap !== null &&
    execution !== null &&
    createAudioAlignmentBatchProposalTimeMapDigest(proposalTimeMap) ===
      execution.proposalTimeMapDigest;
  if (
    frontier.resolved &&
    frontier.finalState === "resolved" &&
    selectedByFinalAssignment &&
    selectionReceiptConsistent &&
    componentBindsPair &&
    executionBindsPair &&
    executionBindsProposal &&
    snapshot.proposal?.matchRange
  ) {
    const range = snapshot.proposal.matchRange;
    return {
      kind: "confirmable",
      taskState: "found",
      message: `${snapshot.targetMediaId} ← ${snapshot.sourceMediaId} ${formatTimecode(range.sourceStartMs)}–${formatTimecode(range.sourceEndMs)}；已唯一确定，等待逐项确认`,
      reason: null
    };
  }

  if (frontier.resolved && frontier.finalState === "resolved") {
    if (selectedByFinalAssignment) {
      const reason =
        "原生精匹配结果的候选、组件裁决或 TimeMap 绑定校验未通过；为避免错配，本组不能确认。";
      return { kind: "evidenceBlocked", taskState: "unresolved", message: reason, reason };
    }
    const reason = "原生最终分配采用了同一组件中的另一组关系；当前结果只作为不可确认备选。";
    return { kind: "alternative", taskState: "unresolved", message: reason, reason };
  }

  const stateCounts = frontier.inventoryStateCounts;
  if (stateCounts.resourceBlocked > 0) {
    const reason =
      "这组没有完成分析：可用资源不足。精匹配窗口超过本机安全资源预算；可改用 CPU、减少同时选中的多音轨版本，或查看诊断中的窗口大小。";
    return { kind: "resourceBlocked", taskState: "failed", message: reason, reason };
  }
  if (frontier.finalState === "failed" || stateCounts.infrastructureFailed > 0) {
    const reason =
      "这组没有完成分析：原生精匹配的运行环境或证据链失败。请检查 FFmpeg、GPU 环境和任务日志后重试。";
    return { kind: "infrastructureFailed", taskState: "failed", message: reason, reason };
  }
  if (stateCounts.cancelled > 0) {
    const reason = "这组没有完成分析：任务已取消；取消结果不会用于确认。";
    return { kind: "cancelled", taskState: "cancelled", message: reason, reason };
  }
  if (stateCounts.evidenceBlocked > 0) {
    const reason = "原生精匹配证据未通过完整性检查；本组不能确认。";
    return { kind: "evidenceBlocked", taskState: "unresolved", message: reason, reason };
  }
  const candidateCount = Math.max(1, frontier.inventoryCandidateCount);
  const reason = `发现 ${candidateCount} 个接近位置，原生精匹配暂时不能唯一确定；本组不能确认。`;
  return { kind: "unresolved", taskState: "unresolved", message: reason, reason };
}

function sameFineCandidateId(
  left: AudioAlignmentBatchFineCandidateIdSnapshot,
  right: AudioAlignmentBatchFineCandidateIdSnapshot
): boolean {
  return (
    left.pairOrdinal === right.pairOrdinal && left.candidateOrdinal === right.candidateOrdinal
  );
}

function sameFineCandidateIdSet(
  left: readonly AudioAlignmentBatchFineCandidateIdSnapshot[],
  right: readonly AudioAlignmentBatchFineCandidateIdSnapshot[]
): boolean {
  return (
    left.length === right.length &&
    left.every((leftId) => right.some((rightId) => sameFineCandidateId(leftId, rightId)))
  );
}

function isResourceLimitedFineFailure(message: string): boolean {
  const normalized = message.toLocaleLowerCase("en-US");
  return (
    normalized.includes("blocked:resource-limit") ||
    normalized.includes("resourceblocked") ||
    normalized.includes("resource blocked") ||
    normalized.includes("out of memory") ||
    normalized.includes("memory budget") ||
    normalized.includes("资源不足") ||
    normalized.includes("资源上限")
  );
}

function isInternalResultValidationFailure(message: string): boolean {
  const normalized = message.toLocaleLowerCase("en-US");
  return (
    normalized.includes("staged evidence binding invalid") ||
    normalized.includes("evidence-contract-failed") ||
    normalized.includes("证据合同校验失败") ||
    normalized.includes("内部结果校验失败")
  );
}
