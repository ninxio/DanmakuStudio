import type { ProjectMediaReference } from "../../domain/project/types";
import type {
  BatchTask,
  BatchTaskState
} from "../../application/backgroundTasks/matchingTaskChannel";
import { statusLabel, type WorkspaceStatusId } from "../../domain/shared/statusVocabulary";

export type {
  BatchTask,
  BatchTaskState
} from "../../application/backgroundTasks/matchingTaskChannel";

export interface MatchingAudioPreparationView {
  ready: boolean;
  label: string;
}

export type MatchingRunGroupId = "blocked" | "review" | "running" | "waiting" | "completed";

export type MatchingRunPrimaryActionKind =
  "start" | "cancel" | "focusIssue" | "resolveAudio" | "continue" | "restart";

export interface MatchingRunResult {
  candidateId: string;
  sourceMediaId: string;
  targetMediaId: string;
  classification: Exclude<MatchingRunGroupId, "running" | "waiting">;
  message: string;
}

export interface MatchingRunPrimaryAction {
  kind: MatchingRunPrimaryActionKind;
  label: string;
  disabled: boolean;
}

export interface MatchingRunConsoleRow {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  title: string;
  group: MatchingRunGroupId;
  stateLabel: string;
  stageLabel: string;
  message: string;
  nextAction: string;
  progress: number;
  jobId: string | null;
  logs: string[];
  candidateId: string | null;
}

export interface MatchingRunConsoleGroup {
  id: MatchingRunGroupId;
  title: string;
  rows: MatchingRunConsoleRow[];
  collapsedByDefault: boolean;
}

export interface MatchingRunConsoleModel {
  runBar: {
    selectedSourceCount: number;
    selectedTargetCount: number;
    selectedPairCount: number;
    selectedMediaCount: number;
    audioReadyCount: number;
    audioBlockerCount: number;
    blockerCount: number;
    running: boolean;
    restartRequired: boolean;
  };
  groups: MatchingRunConsoleGroup[];
  primaryAction: MatchingRunPrimaryAction;
  diagnosticJobId: string | null;
}

export interface BuildMatchingRunConsoleModelInput {
  selectedSourceCount: number;
  selectedTargetCount: number;
  selectedPairCount: number;
  selectedMediaCount: number;
  audioReadyCount: number;
  audioBlockerCount: number;
  running: boolean;
  restartRequired: boolean;
  tasks: BatchTask[];
  results: MatchingRunResult[];
  mediaNames: Record<string, string>;
  primaryAction: MatchingRunPrimaryAction;
}

const MATCHING_RUN_GROUPS: ReadonlyArray<{
  id: MatchingRunGroupId;
  title: string;
  collapsedByDefault: boolean;
}> = [
  { id: "blocked", title: statusLabel("blocked"), collapsedByDefault: false },
  { id: "review", title: statusLabel("reviewRequired"), collapsedByDefault: false },
  { id: "running", title: statusLabel("running"), collapsedByDefault: false },
  { id: "waiting", title: "待分析", collapsedByDefault: false },
  { id: "completed", title: statusLabel("confirmed"), collapsedByDefault: true }
];

export function buildMatchingRunConsoleModel(
  input: BuildMatchingRunConsoleModelInput
): MatchingRunConsoleModel {
  const resultByPair = new Map(
    input.results.map((result) => [
      createMatchingPairKey(result.sourceMediaId, result.targetMediaId),
      result
    ])
  );
  const taskPairKeys = new Set<string>();
  const rows = input.tasks.map((task) => {
    const pairKey = createMatchingPairKey(task.sourceMediaId, task.targetMediaId);
    taskPairKeys.add(pairKey);
    const result = resultByPair.get(pairKey) ?? null;
    const group = result?.classification ?? groupForTaskState(task.state, input.running);
    return createRunRow({
      id: task.id,
      sourceMediaId: task.sourceMediaId,
      targetMediaId: task.targetMediaId,
      group,
      message: task.message,
      taskState: task.state,
      batchRunning: input.running,
      progress: task.progress,
      jobId: task.jobId,
      logs: task.logs,
      candidateId: result?.candidateId ?? null,
      mediaNames: input.mediaNames
    });
  });

  for (const result of input.results) {
    const pairKey = createMatchingPairKey(result.sourceMediaId, result.targetMediaId);
    if (taskPairKeys.has(pairKey)) continue;
    rows.push(
      createRunRow({
        id: `result:${result.candidateId}`,
        sourceMediaId: result.sourceMediaId,
        targetMediaId: result.targetMediaId,
        group: result.classification,
        message: result.message,
        taskState: null,
        batchRunning: input.running,
        progress: 1,
        jobId: null,
        logs: [],
        candidateId: result.candidateId,
        mediaNames: input.mediaNames
      })
    );
  }

  const groups = MATCHING_RUN_GROUPS.map((group) => ({
    ...group,
    title:
      group.id === "waiting" && input.running
        ? "排队等待"
        : group.id === "blocked" &&
            rows
              .filter((row) => row.group === "blocked")
              .every((row) => row.stateLabel === "未定位")
          ? "未定位"
          : group.title,
    rows: rows.filter((row) => row.group === group.id)
  })).filter((group) => group.rows.length > 0);
  const blockerCount =
    input.audioBlockerCount +
    groups
      .filter((group) => group.id === "blocked" || group.id === "review")
      .reduce((count, group) => count + group.rows.length, 0);

  return {
    runBar: {
      selectedSourceCount: input.selectedSourceCount,
      selectedTargetCount: input.selectedTargetCount,
      selectedPairCount: input.selectedPairCount,
      selectedMediaCount: input.selectedMediaCount,
      audioReadyCount: input.audioReadyCount,
      audioBlockerCount: input.audioBlockerCount,
      blockerCount,
      running: input.running,
      restartRequired: input.restartRequired
    },
    groups,
    primaryAction: input.primaryAction,
    diagnosticJobId: input.tasks.find((task) => task.jobId !== null)?.jobId ?? null
  };
}

export function canAnalyzeMedia(media: ProjectMediaReference): boolean {
  return media.connectionState === "connected" && Boolean(media.localPath?.trim());
}

export function unavailableMediaHint(media: ProjectMediaReference): string {
  if (media.referenceKind === "browserFile") {
    return "临时浏览器引用；自动匹配请回素材页删除后用桌面批量导入";
  }
  return "需要回素材页用本地路径重新连接";
}

export function batchTaskStateText(state: BatchTaskState): string {
  if (state === "waiting") return "待分析";
  return statusLabel(batchTaskStatusId(state));
}

export function batchTaskStatusId(state: BatchTaskState): WorkspaceStatusId {
  if (state === "waiting") return "runnable";
  if (state === "running") return "running";
  if (state === "found" || state === "unresolved") return "reviewRequired";
  if (state === "cancelled") return "actionRequired";
  return "blocked";
}

function createRunRow(input: {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  group: MatchingRunGroupId;
  message: string;
  taskState: BatchTaskState | null;
  batchRunning: boolean;
  progress: number;
  jobId: string | null;
  logs: string[];
  candidateId: string | null;
  mediaNames: Record<string, string>;
}): MatchingRunConsoleRow {
  return {
    id: input.id,
    sourceMediaId: input.sourceMediaId,
    targetMediaId: input.targetMediaId,
    title: `${input.mediaNames[input.targetMediaId] ?? input.targetMediaId} ← ${input.mediaNames[input.sourceMediaId] ?? input.sourceMediaId}`,
    group: input.group,
    stateLabel:
      input.group === "waiting"
        ? input.batchRunning
          ? "排队等待"
          : "待分析"
        : input.taskState === "notFound"
          ? "未定位"
          : groupStateLabel(input.group),
    stageLabel:
      input.group === "waiting"
        ? input.batchRunning
          ? "等待本批次开始此组分析"
          : "本组尚未开始分析"
        : input.taskState === "notFound"
          ? "计算完成，未生成可用时间图"
          : groupStageLabel(input.group),
    message: input.message,
    nextAction:
      input.group === "waiting"
        ? input.batchRunning
          ? "本批次正在运行，此组尚在排队"
          : "点击开始或继续匹配后才会运行"
        : input.taskState === "notFound"
          ? "当前没有可以确认的时间关系；弹幕仍保留，可重新匹配或手动定位。"
          : groupNextAction(input.group),
    progress: input.group === "waiting" ? 0 : input.progress,
    jobId: input.jobId,
    logs: [...input.logs],
    candidateId: input.candidateId
  };
}

function groupForTaskState(state: BatchTaskState, batchRunning: boolean): MatchingRunGroupId {
  if (state === "failed" || state === "notFound" || state === "cancelled") {
    return "blocked";
  }
  if (state === "unresolved") return "review";
  if (state === "waiting" || (state === "running" && !batchRunning)) return "waiting";
  if (state === "running") return "running";
  return "completed";
}

function groupStateLabel(group: MatchingRunGroupId): string {
  return statusLabel(matchingRunGroupStatusId(group));
}

export function matchingRunGroupStatusId(group: MatchingRunGroupId): WorkspaceStatusId {
  if (group === "blocked") return "blocked";
  if (group === "review") return "reviewRequired";
  if (group === "running") return "running";
  if (group === "waiting") return "runnable";
  return "confirmed";
}

function groupStageLabel(group: MatchingRunGroupId): string {
  if (group === "blocked") return "分析已停止";
  if (group === "review") return "结果等待人工判断";
  if (group === "running") return "正在准备或分析音视频";
  return "本组计算已经结束";
}

function groupNextAction(group: MatchingRunGroupId): string {
  if (group === "blocked") return "检查原因后调整素材或本次计算设置";
  if (group === "review") return "进入编辑工作台复核差异和边界";
  if (group === "running") return "可以离开本页，后台任务会继续";
  return "结果已保存，无需重复运行";
}

function createMatchingPairKey(sourceMediaId: string, targetMediaId: string): string {
  return `${sourceMediaId}\u0000${targetMediaId}`;
}
