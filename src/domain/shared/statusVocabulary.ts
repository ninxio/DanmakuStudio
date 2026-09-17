export const WORKSPACE_STATUS_IDS = [
  "preparing",
  "actionRequired",
  "runnable",
  "running",
  "reviewRequired",
  "confirmed",
  "blocked",
  "exported",
] as const;

export type WorkspaceStatusId = (typeof WORKSPACE_STATUS_IDS)[number];

export type StatusSemanticTone = "neutral" | "running" | "success" | "warning" | "danger";

export type StatusIconSemantic =
  | "preparing"
  | "action"
  | "ready"
  | "running"
  | "review"
  | "confirmed"
  | "blocked"
  | "exported";

export interface StatusVocabularyEntry {
  id: WorkspaceStatusId;
  label: string;
  tone: StatusSemanticTone;
  icon: StatusIconSemantic;
  description: string;
}

function status(
  id: WorkspaceStatusId,
  label: string,
  tone: StatusSemanticTone,
  icon: StatusIconSemantic,
  description: string,
): Readonly<StatusVocabularyEntry> {
  return Object.freeze({ id, label, tone, icon, description });
}

export const STATUS_VOCABULARY: Readonly<Record<WorkspaceStatusId, Readonly<StatusVocabularyEntry>>> =
  Object.freeze({
    preparing: status("preparing", "准备中", "running", "preparing", "正在准备运行所需的素材或数据。"),
    actionRequired: status(
      "actionRequired",
      "需处理",
      "warning",
      "action",
      "需要先完成一项明确处理才能继续。",
    ),
    runnable: status("runnable", "可运行", "neutral", "ready", "条件已齐备，可以开始当前任务。"),
    running: status("running", "运行中", "running", "running", "任务正在执行，离开当前页面也会继续。"),
    reviewRequired: status(
      "reviewRequired",
      "需复核",
      "warning",
      "review",
      "已有结果，但仍需人工确认后才能成为正式结论。",
    ),
    confirmed: status("confirmed", "已确认", "success", "confirmed", "结果已经通过用户确认或既定验证。"),
    blocked: status("blocked", "已阻断", "danger", "blocked", "当前存在阻断条件，必须处理后才能继续。"),
    exported: status("exported", "已导出", "success", "exported", "结果已经写入目标输出位置。"),
  });

export function getStatusVocabulary(id: WorkspaceStatusId): Readonly<StatusVocabularyEntry> {
  return STATUS_VOCABULARY[id];
}

export function statusLabel(id: WorkspaceStatusId): string {
  return getStatusVocabulary(id).label;
}
