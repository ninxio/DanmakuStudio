import type { WorkspaceStatusId } from "../../domain/shared/statusVocabulary";
import {
  applicationTaskRegistry,
  createApplicationLiveTaskChannel,
  type ApplicationTaskRegistration
} from "./applicationTaskRegistry";

export type BatchTaskState =
  | "waiting"
  | "running"
  | "found"
  | "unresolved"
  | "notFound"
  | "failed"
  | "cancelled";

export interface BatchTask {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  state: BatchTaskState;
  progress: number;
  message: string;
  jobId: string | null;
  logs: string[];
}

export interface MatchingLiveRunSnapshot {
  tasks: BatchTask[];
  running: boolean;
  selectedSourceIds: string[];
  selectedTargetIds: string[];
}

export interface MatchingLiveRun extends MatchingLiveRunSnapshot {
  startedAtMs: number;
  updatedAtMs: number;
  requestCancel: () => void;
}

export const matchingLiveRunChannel = createApplicationLiveTaskChannel<MatchingLiveRun>(
  applicationTaskRegistry,
  "matching",
  projectMatchingRun,
  { maxEntries: 4 }
);

export function toMatchingLiveRunSnapshot(run: MatchingLiveRun): MatchingLiveRunSnapshot {
  return {
    tasks: run.tasks,
    running: run.running,
    selectedSourceIds: run.selectedSourceIds,
    selectedTargetIds: run.selectedTargetIds
  };
}

function projectMatchingRun(
  key: string,
  run: MatchingLiveRun
): readonly ApplicationTaskRegistration[] {
  if (run.tasks.length === 0) return [];
  const completedCount = run.tasks.filter((task) => isTerminalTaskState(task.state)).length;
  const failedTasks = run.tasks.filter((task) => task.state === "failed");
  const reviewCount = run.tasks.filter((task) =>
    task.state === "unresolved" || task.state === "notFound" || task.state === "cancelled"
  ).length;
  const progress = run.tasks.reduce((sum, task) => sum + clampProgress(task.progress), 0) /
    run.tasks.length;
  const statusId: WorkspaceStatusId = run.running
    ? "running"
    : failedTasks.length > 0
      ? "blocked"
      : reviewCount > 0
        ? "reviewRequired"
        : "confirmed";
  const actions = run.running
    ? [{ id: "cancel", kind: "cancel" as const, label: "取消匹配" }]
    : [];
  return [{
    task: {
      id: `matching:${key}`,
      source: "matching",
      title: `智能匹配 · ${run.tasks.length} 组`,
      phase: run.running
        ? `正在匹配 · ${completedCount}/${run.tasks.length} 组完成`
        : failedTasks.length > 0
          ? `匹配结束 · ${failedTasks.length} 组失败`
          : reviewCount > 0
            ? `匹配结束 · ${reviewCount} 组需复核`
            : `匹配完成 · ${completedCount}/${run.tasks.length} 组`,
      statusId,
      progress,
      startedAtMs: run.startedAtMs,
      updatedAtMs: run.updatedAtMs,
      error: failedTasks.length > 0
        ? failedTasks.map((task) => [task.message, ...task.logs].filter(Boolean).join("\n")).join("\n\n")
        : null,
      actions
    },
    handlers: run.running ? { cancel: run.requestCancel } : undefined
  }];
}

function isTerminalTaskState(state: BatchTaskState): boolean {
  return state !== "waiting" && state !== "running";
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}
