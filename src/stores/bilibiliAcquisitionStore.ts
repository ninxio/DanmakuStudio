import { create } from "zustand";
import { applicationTaskRegistry } from "../application/backgroundTasks/applicationTaskRegistry";
import {
  createBilibiliAcquisitionController,
  isBilibiliJobBusy
} from "../application/bilibiliAcquisitionController";
import { createId } from "../domain/project/factory";
import {
  downloadBilibiliPackage,
  cancelBilibiliDownload,
  listenBilibiliProgress,
  type BilibiliVideo
} from "../infrastructure/bilibili/bilibiliClient";
import {
  loadBilibiliJob,
  saveBilibiliJob
} from "../infrastructure/bilibili/bilibiliJobStorage";
import { useEditorStore } from "./editorStore";
import { loadAppSettings } from "../infrastructure/settings/appSettings";

interface BilibiliWorkspaceSession {
  generation: number;
  open: boolean;
  input: string;
  cookie: string;
  outputFolder: string;
  downloadAudio: boolean;
  video: BilibiliVideo | null;
  selectedCids: number[];
}
export const biliAcquisition = createBilibiliAcquisitionController({
  download: downloadBilibiliPackage,
  cancel: cancelBilibiliDownload,
  listen: listenBilibiliProgress,
  currentContext: () => {
    const state = useEditorStore.getState();
    return {
      projectId: state.project.id,
      projectEpoch: state.projectEpoch,
      projectName: state.project.name
    };
  },
  importResults: (results, context) =>
    useEditorStore.getState().importBilibiliMaterials(results, context),
  load: loadBilibiliJob,
  save: saveBilibiliJob,
  createRequestId: () => createId("bilibili")
});
const recovered = biliAcquisition.getSnapshot().draft;
export const useBilibiliWorkspaceSession = create<BilibiliWorkspaceSession>(() => ({
  generation: 0,
  open: false,
  input: recovered?.input ?? "",
  cookie: "",
  outputFolder: recovered?.outputFolder ?? "",
  downloadAudio: recovered?.downloadAudio ?? true,
  video: null,
  selectedCids: []
}));
export function openBilibiliAcquisition(prefill?: {
  input: string;
  projectId: string;
  projectEpoch: number;
}) {
  const current = useEditorStore.getState();
  if (prefill) {
    if (/^https?:\/\/(?:www\.)?b23\.tv(?:[/:?#]|$)/i.test(prefill.input.trim()))
      throw new Error(
        "b23 短链接可以收藏，但当前不能直接采集。请先在浏览器打开短链接，将跳转后的完整 bilibili.com/video/BV 链接保存为待办，再带入 B站获取。"
      );
    if (
      current.project.id !== prefill.projectId ||
      current.projectEpoch !== prefill.projectEpoch ||
      current.projectLibrary.switchingProject
    )
      throw new Error("项目已切换，请重新选择待办。");
    if (
      isBilibiliJobBusy(biliAcquisition.getSnapshot().phase) ||
      biliAcquisition.getSnapshot().phase === "pendingImport"
    ) {
      throw new Error(
        "B站已有进行中或待导入的任务。请关闭发现与整理，在原 B站获取窗口处理任务后再带入新链接。"
      );
    }
    useBilibiliWorkspaceSession.setState((s) => ({
      generation: s.generation + 1,
      input: prefill.input,
      video: null,
      selectedCids: [],
      downloadAudio: loadAppSettings().acquisition?.downloadAudio ?? true
    }));
  } else if (
    !isBilibiliJobBusy(biliAcquisition.getSnapshot().phase) &&
    biliAcquisition.getSnapshot().phase === "idle"
  ) {
    useBilibiliWorkspaceSession.setState({
      downloadAudio:
        loadAppSettings().acquisition?.downloadAudio ??
        useBilibiliWorkspaceSession.getState().downloadAudio
    });
  }
  useEditorStore.getState().setWorkspacePage("materials");
  useBilibiliWorkspaceSession.setState({ open: true });
}
let taskStartedAt = Date.now();
const syncTask = () => {
  const state = biliAcquisition.getSnapshot();
  if (state.phase === "idle") {
    applicationTaskRegistry.clearSource("bilibili");
    return;
  }
  const busy = isBilibiliJobBusy(state.phase);
  const progress = state.progress;
  const ratio =
    progress && progress.total > 0
      ? Math.max(
          0,
          Math.min(1, (progress.current - 1 + progress.percent / 100) / progress.total)
        )
      : null;
  if (busy && !progress) taskStartedAt = Date.now();
  applicationTaskRegistry.replaceSource("bilibili", [
    {
      task: {
        id: "bilibili-acquisition",
        source: "acquisition",
        title: `B 站素材 · ${state.context?.projectName ?? "项目"}`,
        phase: state.message,
        statusId: busy
          ? "running"
          : state.phase === "completed"
            ? "confirmed"
            : "actionRequired",
        progress: busy ? ratio : null,
        startedAtMs: taskStartedAt,
        updatedAtMs: Date.now(),
        error:
          state.phase === "failed" || state.phase === "pendingImport" ? state.message : null,
        actions: [
          { id: "open", kind: "open", label: "查看获取任务" },
          ...(state.phase === "running" || state.phase === "cancelling"
            ? [{ id: "cancel", kind: "cancel" as const, label: "取消获取" }]
            : [])
        ]
      },
      handlers: {
        open: openBilibiliAcquisition,
        cancel: () => {
          void biliAcquisition.cancel();
        }
      }
    }
  ]);
};
biliAcquisition.subscribe(syncTask);
syncTask();
