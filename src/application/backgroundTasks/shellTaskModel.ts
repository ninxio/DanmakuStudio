import type { MediaInventorySemanticCounts } from "../mediaInventorySupervisor";
import type { ProjectLibrarySessionState } from "../projectLibrarySessionController";
import type { EditorStatus } from "../commandStatus";
import type {
  ApplicationTaskRegistration,
  ApplicationTaskAction
} from "./applicationTaskRegistry";

interface ShellInventoryState {
  phase: "idle" | "queued" | "running" | "completed" | "cancelled" | "failed";
  counts: MediaInventorySemanticCounts | null;
  cancelling: boolean;
  restartRequired: boolean;
  terminalMessage: string | null;
  firstIssueMediaId: string | null;
}

interface ShellTaskActions {
  cancelInventory: () => void;
  retryInventory: () => void;
  retrySave: () => void;
  locateInventoryIssue: () => void;
  runStatusAction: () => void;
}

export interface ShellTaskModelInput {
  status: EditorStatus;
  importProgress: number | null;
  inventory: ShellInventoryState;
  projectLibrary: ProjectLibrarySessionState;
  actions: ShellTaskActions;
}

export function createShellTaskRegistrations(
  input: ShellTaskModelInput
): ApplicationTaskRegistration[] {
  const registrations: ApplicationTaskRegistration[] = [];
  if (input.importProgress !== null) registrations.push(createImportTask(input));
  if (input.inventory.phase !== "idle" || input.inventory.restartRequired) {
    registrations.push(createInventoryTask(input));
  }
  if (input.projectLibrary.saveStatus !== "idle") {
    registrations.push(createProjectSaveTask(input));
  }
  if (
    registrations.length === 0 ||
    input.status.action !== undefined ||
    input.status.tone === "success" ||
    input.status.tone === "warning" ||
    input.status.tone === "error"
  ) {
    registrations.push(createStatusTask(input));
  }
  return registrations;
}

function createImportTask(input: ShellTaskModelInput): ApplicationTaskRegistration {
  return {
    task: {
      id: "shell:xml-import",
      source: "xmlImport",
      title: "XML 导入",
      phase: input.status.message || "正在读取并验证 XML",
      statusId: "running",
      progress: clampProgress(input.importProgress),
      startedAtMs: 0,
      updatedAtMs: 0,
      error: null,
      actions: []
    }
  };
}

function createInventoryTask(input: ShellTaskModelInput): ApplicationTaskRegistration {
  const { inventory } = input;
  const counts = inventory.counts;
  const handled = counts ? counts.ready + counts.failed + counts.cancelled : 0;
  const progress = counts && counts.total > 0 ? handled / counts.total : null;
  const actions: ApplicationTaskAction[] = [];
  const handlers: Record<string, () => void> = {};
  if (inventory.phase === "queued" || inventory.phase === "running") {
    actions.push({ id: "cancel", kind: "cancel", label: "取消准备" });
    handlers.cancel = input.actions.cancelInventory;
  } else if (inventory.phase === "failed" && !inventory.restartRequired) {
    actions.push({ id: "retry", kind: "retry", label: "重试准备" });
    handlers.retry = input.actions.retryInventory;
  }
  if (inventory.firstIssueMediaId) {
    actions.push({ id: "locate", kind: "locate", label: "定位异常素材" });
    handlers.locate = input.actions.locateInventoryIssue;
  }
  return {
    task: {
      id: "shell:media-inventory",
      source: "mediaInventory",
      title: "音轨准备",
      phase: formatInventoryPhase(inventory),
      statusId: inventory.restartRequired || inventory.phase === "failed"
        ? "blocked"
        : inventory.phase === "cancelled"
          ? "actionRequired"
          : inventory.phase === "completed"
            ? counts && counts.failed > 0
              ? "reviewRequired"
              : "confirmed"
            : inventory.phase === "queued"
              ? "preparing"
              : "running",
      progress: clampProgress(progress),
      startedAtMs: 0,
      updatedAtMs: 0,
      error: inventory.terminalMessage,
      target: inventory.firstIssueMediaId
        ? { kind: "audioIssue", mediaId: inventory.firstIssueMediaId }
        : undefined,
      actions
    },
    handlers
  };
}

function createProjectSaveTask(input: ShellTaskModelInput): ApplicationTaskRegistration {
  const { projectLibrary } = input;
  const retry = projectLibrary.saveStatus === "failed" && projectLibrary.canRetrySave;
  return {
    task: {
      id: "shell:project-save",
      source: "projectSave",
      title: "自动保存",
      phase: projectLibrary.message || formatSavePhase(projectLibrary.saveStatus),
      statusId: projectLibrary.saveStatus === "saving"
        ? "running"
        : projectLibrary.saveStatus === "saved"
          ? "confirmed"
          : projectLibrary.saveStatus === "recoverable"
            ? "actionRequired"
            : "blocked",
      progress: projectLibrary.saveStatus === "saved" ? 1 : null,
      startedAtMs: projectLibrary.lastSavedAtUnixMs ?? 0,
      updatedAtMs: projectLibrary.lastSavedAtUnixMs ?? 0,
      error: projectLibrary.saveStatus === "failed" ? projectLibrary.message : null,
      actions: retry ? [{ id: "retry", kind: "retry", label: "重试保存" }] : []
    },
    handlers: retry ? { retry: input.actions.retrySave } : undefined
  };
}

function createStatusTask(input: ShellTaskModelInput): ApplicationTaskRegistration {
  const action = input.status.action;
  return {
    task: {
      id: "shell:status",
      source: "status",
      title: "应用状态",
      phase: input.status.message,
      statusId: input.status.tone === "error"
        ? "blocked"
        : input.status.tone === "warning"
          ? "actionRequired"
          : input.status.tone === "success"
            ? "confirmed"
            : "runnable",
      progress: null,
      startedAtMs: 0,
      updatedAtMs: 0,
      error: input.status.tone === "error" ? input.status.message : null,
      actions: action ? [{ id: "open", kind: "open", label: action.label }] : []
    },
    handlers: action ? { open: input.actions.runStatusAction } : undefined
  };
}

function formatInventoryPhase(inventory: ShellInventoryState): string {
  if (inventory.restartRequired) return "进程清理状态不确定，需重启应用";
  const counts = inventory.counts;
  const countSummary = counts
    ? ` · ${counts.ready}/${counts.total} 已就绪${counts.failed > 0 ? ` · ${counts.failed} 项失败` : ""}`
    : "";
  if (inventory.cancelling) return `正在取消音轨准备${countSummary}`;
  if (inventory.phase === "queued") return `等待准备音轨${countSummary}`;
  if (inventory.phase === "running") return `正在准备音轨${countSummary}`;
  if (inventory.phase === "completed") return `音轨准备完成${countSummary}`;
  if (inventory.phase === "cancelled") return `音轨准备已取消${countSummary}`;
  return `音轨准备失败${countSummary}`;
}

function formatSavePhase(status: ProjectLibrarySessionState["saveStatus"]): string {
  if (status === "saving") return "正在保存项目";
  if (status === "saved") return "项目已保存";
  if (status === "recoverable") return "发现可恢复的项目草稿";
  if (status === "failed") return "自动保存失败";
  return "等待项目保存";
}

function clampProgress(progress: number | null): number | null {
  if (progress === null || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(1, progress));
}
