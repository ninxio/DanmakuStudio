import type {
  DanmakuSourceBinding,
  MediaMatchCandidate,
  MediaTimeMap,
  MediaTimeMapQualityLevel,
  ProjectMediaReference
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import type { BatchTask } from "../matching/matchingTaskModels";

export type AlignmentReviewGroupKind = "blocked" | "lowConfidence" | "needsAdjudication";

export type AlignmentReviewIntent =
  { kind: "openCandidate"; candidateId: string } | { kind: "resumeMatching" };

export interface AlignmentReviewItemViewModel {
  pairId: string;
  sourceLabel: string;
  targetLabel: string;
  statusLabel: string;
  rangeLabel: string | null;
  reasons: string[];
  nextAction: AlignmentReviewIntent;
}

export interface AlignmentReviewGroupViewModel {
  kind: AlignmentReviewGroupKind;
  title: string;
  items: AlignmentReviewItemViewModel[];
}

export interface AlignmentReviewWorkbenchViewModel {
  summary: {
    priorityCount: number;
    completedCount: number;
    inProgressCount: number;
    label: string;
  };
  priorityGroups: AlignmentReviewGroupViewModel[];
  completedItems: AlignmentReviewItemViewModel[];
}

export interface AlignmentReviewWorkbenchInput {
  media: readonly ProjectMediaReference[];
  candidates: readonly MediaMatchCandidate[];
  timeMaps: readonly MediaTimeMap[];
  bindings: readonly DanmakuSourceBinding[];
  tasks: readonly BatchTask[];
}

interface ClassifiedReviewItem {
  group: AlignmentReviewGroupKind | "completed";
  item: AlignmentReviewItemViewModel;
  acceptedBlocked: boolean;
  updatedAt: string;
}

const GROUPS: ReadonlyArray<{
  kind: AlignmentReviewGroupKind;
  title: string;
}> = [
  { kind: "blocked", title: "阻断项" },
  { kind: "lowConfidence", title: "低可信" },
  { kind: "needsAdjudication", title: "待人工裁决" }
];

export function createAlignmentReviewWorkbenchModel(
  input: AlignmentReviewWorkbenchInput
): AlignmentReviewWorkbenchViewModel {
  const mediaById = new Map(input.media.map((media) => [media.id, media]));
  const mapsById = new Map(input.timeMaps.map((timeMap) => [timeMap.id, timeMap]));
  const taskByPair = new Map<string, BatchTask>();
  const inProgressPairs = new Set<string>();
  for (const task of input.tasks) {
    const pairId = createPairId(task.sourceMediaId, task.targetMediaId);
    taskByPair.set(pairId, task);
    if (task.state === "waiting" || task.state === "running") {
      inProgressPairs.add(pairId);
    }
  }

  const candidatesByPair = new Map<string, MediaMatchCandidate[]>();
  for (const candidate of input.candidates) {
    const pairId = createPairId(candidate.sourceMediaId, candidate.targetMediaId);
    const pairCandidates = candidatesByPair.get(pairId) ?? [];
    pairCandidates.push(candidate);
    candidatesByPair.set(pairId, pairCandidates);
  }

  const classified: ClassifiedReviewItem[] = [];
  const representedPairs = new Set<string>();
  for (const [pairId, pairCandidates] of candidatesByPair) {
    const visibleCandidates = pairCandidates.filter(
      (candidate) => candidate.state !== "rejected"
    );
    representedPairs.add(pairId);
    if (visibleCandidates.length === 0) continue;
    const task = taskByPair.get(pairId) ?? null;
    const selected = visibleCandidates
      .map((candidate) =>
        classifyCandidate(candidate, task, input.bindings, mapsById, mediaById)
      )
      .sort(compareClassifiedItems)[0];
    if (selected) classified.push(selected);
  }

  for (const task of input.tasks) {
    const pairId = createPairId(task.sourceMediaId, task.targetMediaId);
    if (representedPairs.has(pairId) || inProgressPairs.has(pairId)) continue;
    classified.push(classifyTask(task, mediaById));
  }

  const priorityGroups = GROUPS.map(({ kind, title }) => ({
    kind,
    title,
    items: classified
      .filter((entry) => entry.group === kind)
      .sort(compareWithinGroup)
      .map((entry) => entry.item)
  })).filter((group) => group.items.length > 0);
  const completedItems = classified
    .filter((entry) => entry.group === "completed")
    .sort(compareWithinGroup)
    .map((entry) => entry.item);
  const priorityCount = priorityGroups.reduce((total, group) => total + group.items.length, 0);
  const inProgressCount = inProgressPairs.size;

  return {
    summary: {
      priorityCount,
      completedCount: completedItems.length,
      inProgressCount,
      label: summaryLabel(priorityCount, completedItems.length, inProgressCount)
    },
    priorityGroups,
    completedItems
  };
}

function classifyCandidate(
  candidate: MediaMatchCandidate,
  task: BatchTask | null,
  bindings: readonly DanmakuSourceBinding[],
  mapsById: ReadonlyMap<string, MediaTimeMap>,
  mediaById: ReadonlyMap<string, ProjectMediaReference>
): ClassifiedReviewItem {
  const pairId = createPairId(candidate.sourceMediaId, candidate.targetMediaId);
  const confirmedMap = candidate.confirmedTimeMapId
    ? (mapsById.get(candidate.confirmedTimeMapId) ?? null)
    : null;
  const candidateMap = mapsById.get(candidate.timeMapId) ?? null;
  const proposalMap = candidate.proposal.timeMap;
  const qualityLevels = [
    confirmedMap?.quality.level,
    candidateMap?.quality.level,
    proposalMap?.quality.level
  ].filter((level): level is MediaTimeMapQualityLevel => Boolean(level));
  const qualityReasons = uniqueStrings([
    ...(confirmedMap?.quality.reasons ?? []),
    ...(candidateMap?.quality.reasons ?? []),
    ...(proposalMap?.quality.reasons ?? [])
  ]);
  const evidence = candidate.proposal.evidence;
  const acceptedWithoutConfirmedMap = candidate.state === "accepted" && !confirmedMap;
  const acceptedBlocked =
    candidate.state === "accepted" &&
    (acceptedWithoutConfirmedMap || confirmedMap?.quality.level === "blocked");
  const taskBlocks = task?.state === "failed" || task?.state === "notFound";
  const evidenceBlocks = evidence?.quality === "blocked";
  const qualityBlocks = qualityLevels.includes("blocked");

  let group: ClassifiedReviewItem["group"];
  if (
    candidate.state === "blocked" ||
    acceptedBlocked ||
    (candidate.state !== "accepted" && (taskBlocks || evidenceBlocks || qualityBlocks))
  ) {
    group = "blocked";
  } else if (candidate.state === "accepted" && confirmedMap?.quality.level === "verified") {
    group = "completed";
  } else if (
    qualityLevels.some(isReviewQuality) ||
    evidence?.quality === "low" ||
    (evidence?.lowConfidenceRegionCount ?? 0) > 0
  ) {
    group = "lowConfidence";
  } else {
    group = "needsAdjudication";
  }

  const reasons = candidateReasons({
    candidate,
    task,
    group,
    qualityReasons,
    acceptedWithoutConfirmedMap,
    sourceHasBinding: bindings.some(
      (binding) => binding.sourceMediaId === candidate.sourceMediaId
    )
  });
  return {
    group,
    acceptedBlocked,
    updatedAt: candidate.updatedAt,
    item: {
      pairId,
      sourceLabel: mediaById.get(candidate.sourceMediaId)?.name ?? candidate.sourceMediaId,
      targetLabel: mediaById.get(candidate.targetMediaId)?.name ?? candidate.targetMediaId,
      statusLabel: candidateStatusLabel(group, acceptedBlocked),
      rangeLabel: `参考 ${formatTimecode(candidate.sourceStartMs)}–${formatTimecode(candidate.sourceEndMs)}`,
      reasons,
      nextAction: { kind: "openCandidate", candidateId: candidate.id }
    }
  };
}

function classifyTask(
  task: BatchTask,
  mediaById: ReadonlyMap<string, ProjectMediaReference>
): ClassifiedReviewItem {
  const group: AlignmentReviewGroupKind =
    task.state === "failed" || task.state === "notFound" ? "blocked" : "needsAdjudication";
  return {
    group,
    acceptedBlocked: false,
    updatedAt: "",
    item: {
      pairId: createPairId(task.sourceMediaId, task.targetMediaId),
      sourceLabel: mediaById.get(task.sourceMediaId)?.name ?? task.sourceMediaId,
      targetLabel: mediaById.get(task.targetMediaId)?.name ?? task.targetMediaId,
      statusLabel: group === "blocked" ? "匹配结果阻断后续流程" : "等待在匹配页继续处理",
      rangeLabel: null,
      reasons: uniqueStrings([
        task.message ||
          (group === "blocked"
            ? "这组素材没有形成可复核的候选。"
            : "这组素材仍需继续匹配或人工裁决。")
      ]),
      nextAction: { kind: "resumeMatching" }
    }
  };
}

function candidateReasons(input: {
  candidate: MediaMatchCandidate;
  task: BatchTask | null;
  group: ClassifiedReviewItem["group"];
  qualityReasons: readonly string[];
  acceptedWithoutConfirmedMap: boolean;
  sourceHasBinding: boolean;
}): string[] {
  const reasons = [...input.qualityReasons];
  if (input.acceptedWithoutConfirmedMap) {
    reasons.unshift("已接受关系缺少可用的确认时间图，不能进入后续流程。");
  }
  if (input.candidate.state === "blocked" && !input.sourceHasBinding) {
    reasons.unshift("参考素材尚未绑定弹幕 XML。");
  }
  if (input.candidate.proposal.evidence?.quality === "blocked") {
    reasons.push("现有证据无法支持这条关系。");
  } else if (input.candidate.proposal.evidence?.quality === "low") {
    reasons.push("现有证据可信度较低，需要人工复核。");
  }
  const lowConfidenceRegionCount =
    input.candidate.proposal.evidence?.lowConfidenceRegionCount ?? 0;
  if (lowConfidenceRegionCount > 0) {
    reasons.push(`有 ${lowConfidenceRegionCount} 个低可信区段需要复核。`);
  }
  if (
    input.task &&
    input.task.state !== "running" &&
    input.task.state !== "waiting" &&
    input.task.message.trim()
  ) {
    reasons.push(input.task.message);
  }
  if (reasons.length === 0) {
    if (input.group === "blocked") {
      reasons.push("这条关系尚未满足进入后续流程的质量门。");
    } else if (input.group === "lowConfidence") {
      reasons.push("现有质量结果要求人工复核后再继续。");
    } else if (input.group === "completed") {
      reasons.push("关系已保存，确认时间图已通过现有验证门。");
    } else {
      reasons.push("候选已生成，需要人工确认关系与时间范围。");
    }
  }
  return uniqueStrings(reasons).slice(0, 3);
}

function candidateStatusLabel(
  group: ClassifiedReviewItem["group"],
  acceptedBlocked: boolean
): string {
  if (group === "blocked") {
    return acceptedBlocked ? "已接受，但仍被质量门阻断" : "阻断后续流程";
  }
  if (group === "lowConfidence") return "需要证据复核";
  if (group === "completed") return "关系已保存并验证";
  return "等待人工裁决";
}

function isReviewQuality(level: MediaTimeMapQualityLevel): boolean {
  return level === "review" || level === "legacy-unverified";
}

function compareClassifiedItems(
  left: ClassifiedReviewItem,
  right: ClassifiedReviewItem
): number {
  const groupDifference = groupRank(left.group) - groupRank(right.group);
  if (groupDifference !== 0) return groupDifference;
  return right.updatedAt.localeCompare(left.updatedAt);
}

const episodeOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function compareWithinGroup(left: ClassifiedReviewItem, right: ClassifiedReviewItem): number {
  if (left.acceptedBlocked !== right.acceptedBlocked) {
    return left.acceptedBlocked ? -1 : 1;
  }
  return (
    episodeOrder.compare(left.item.targetLabel, right.item.targetLabel) ||
    episodeOrder.compare(left.item.sourceLabel, right.item.sourceLabel) ||
    left.item.pairId.localeCompare(right.item.pairId)
  );
}

function groupRank(group: ClassifiedReviewItem["group"]): number {
  if (group === "blocked") return 0;
  if (group === "lowConfidence") return 1;
  if (group === "needsAdjudication") return 2;
  return 3;
}

function summaryLabel(
  priorityCount: number,
  completedCount: number,
  inProgressCount: number
): string {
  if (priorityCount > 0) return `${priorityCount} 项需要复核`;
  if (inProgressCount > 0) return `${inProgressCount} 项正在分析`;
  if (completedCount > 0) return "当前没有待复核异常";
  return "尚无复核结果";
}

function createPairId(sourceMediaId: string, targetMediaId: string): string {
  return `${sourceMediaId}\u0000${targetMediaId}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
