import type { EditorProject } from "../../domain/project/types";
import type { SaveTextExportResult } from "../../infrastructure/file-system/exportFiles";
import {
  applicationTaskRegistry,
  createApplicationLiveTaskChannel,
  type ApplicationTaskAction,
  type ApplicationTaskRegistration
} from "./applicationTaskRegistry";

export interface ExportSessionState {
  phase: "idle" | "running" | "completed" | "failed";
  result: SaveTextExportResult | null;
  failureMessage: string | null;
  startedAtMs: number;
  updatedAtMs: number;
  retry?: () => void;
  open?: () => void;
  locate?: () => void;
  targetMediaId?: string;
}

export const IDLE_EXPORT_SESSION: ExportSessionState = {
  phase: "idle",
  result: null,
  failureMessage: null,
  startedAtMs: 0,
  updatedAtMs: 0
};

export const exportTaskChannel = createApplicationLiveTaskChannel<ExportSessionState>(
  applicationTaskRegistry,
  "export",
  projectExportSession,
  { maxEntries: 8 }
);

function projectExportSession(
  key: string,
  session: ExportSessionState
): readonly ApplicationTaskRegistration[] {
  if (session.phase === "idle") return [];
  const actions: ApplicationTaskAction[] = [];
  const handlers: Record<string, () => void> = {};
  if (session.phase === "failed" && session.retry) {
    actions.push({ id: "retry", kind: "retry", label: "重试导出" });
    handlers.retry = session.retry;
  }
  if (session.locate) {
    actions.push({ id: "locate", kind: "locate", label: "定位交付项" });
    handlers.locate = session.locate;
  }
  if (session.phase === "completed" && session.open) {
    actions.push({ id: "open", kind: "open", label: "打开交付目录" });
    handlers.open = session.open;
  }
  return [
    {
      task: {
        id: `export:${key}`,
        source: "export",
        title: "分集导出",
        phase:
          session.phase === "running"
            ? "正在验证并写入分集 XML"
            : session.phase === "completed"
              ? `已导出 ${session.result?.fileCount ?? 0} 个文件`
              : "分集导出失败",
        statusId:
          session.phase === "running"
            ? "running"
            : session.phase === "completed"
              ? "exported"
              : "blocked",
        progress: session.phase === "completed" ? 1 : null,
        startedAtMs: session.startedAtMs,
        updatedAtMs: session.updatedAtMs,
        error: session.failureMessage,
        target: session.targetMediaId
          ? { kind: "exportEntry", targetMediaId: session.targetMediaId }
          : undefined,
        actions
      },
      handlers
    }
  ];
}

export function createExportSessionKey(project: EditorProject): string {
  return `${project.id}\u0000${project.updatedAt}`;
}
