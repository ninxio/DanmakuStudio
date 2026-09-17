import type {
  BilibiliProjectContext,
  BilibiliJobDraft,
  BilibiliJobPhase,
  BilibiliSavedJob
} from "../infrastructure/bilibili/bilibiliClient";
export type {
  BilibiliProjectContext,
  BilibiliJobDraft,
  BilibiliJobPhase,
  BilibiliSavedJob
} from "../infrastructure/bilibili/bilibiliClient";
import type {
  BilibiliDownloadOutcome,
  BilibiliDownloadedPage,
  BilibiliDownloadRequest,
  BilibiliProgress
} from "../infrastructure/bilibili/bilibiliClient";
import type { BilibiliImportSummary } from "./importBilibiliMaterials";

export interface BilibiliJobSnapshot {
  phase: BilibiliJobPhase;
  requestId: string | null;
  draft: BilibiliJobDraft | null;
  context: BilibiliProjectContext | null;
  progress: BilibiliProgress | null;
  outcome: BilibiliDownloadOutcome | null;
  message: string;
  importSummary: BilibiliImportSummary | null;
  storageWarning: string | null;
}

export interface BilibiliAcquisitionDependencies {
  download: (request: BilibiliDownloadRequest) => Promise<BilibiliDownloadOutcome>;
  cancel: (requestId: string) => Promise<boolean>;
  listen: (callback: (progress: BilibiliProgress) => void) => Promise<() => void>;
  importResults: (
    results: readonly BilibiliDownloadedPage[],
    context: BilibiliProjectContext
  ) => Promise<BilibiliImportSummary | null>;
  currentContext: () => BilibiliProjectContext;
  save: (job: BilibiliSavedJob | null) => void;
  load: () => BilibiliSavedJob | null;
  createRequestId: () => string;
}
export function isBilibiliJobBusy(phase: BilibiliJobPhase) {
  return phase === "running" || phase === "cancelling" || phase === "importing";
}
export function createBilibiliAcquisitionController(deps: BilibiliAcquisitionDependencies) {
  let snapshot: BilibiliJobSnapshot = {
    phase: "idle",
    requestId: null,
    draft: null,
    context: null,
    progress: null,
    outcome: null,
    message: "",
    importSummary: null,
    storageWarning: null
  };
  const listeners = new Set<() => void>();
  let cancelRequested = false;
  let cancelAcknowledged = false;
  let cancelInFlight = false;
  const publish = (patch: Partial<BilibiliJobSnapshot>, persist = false) => {
    snapshot = { ...snapshot, ...patch };
    if (persist) {
      try {
        deps.save(
          snapshot.draft && snapshot.context
            ? {
                version: 1,
                draft: snapshot.draft,
                context: snapshot.context,
                results: snapshot.outcome?.results ?? [],
                phase: snapshot.phase
              }
            : null
        );
      } catch {
        snapshot = {
          ...snapshot,
          storageWarning:
            "本机任务记录未保存；已下载文件仍在所选文件夹。重启后请重新解析并选择同一文件夹继续。"
        };
      }
    }
    listeners.forEach((listener) => listener());
  };
  try {
    const saved = deps.load();
    if (saved) {
      const needsImport = saved.results.length > 0 && saved.phase !== "completed";
      snapshot = {
        ...snapshot,
        draft: saved.draft,
        context: saved.context,
        phase: needsImport
          ? "pendingImport"
          : saved.phase === "completed"
            ? "completed"
            : "interrupted",
        outcome: {
          requestId: "restored",
          results: saved.results,
          status: saved.phase === "completed" ? "completed" : "cancelled",
          error: null
        },
        message: needsImport
          ? "上次下载结果已恢复，请确认目标项目后导入；未完成的 P 可继续获取。"
          : saved.phase === "completed"
            ? "上次已获取完成。可重新校验文件，或将已有结果导入当前项目。"
            : "上次获取未完成。重新提供登录信息（如需要），继续获取会校验并跳过完整文件。"
      };
    }
  } catch {
    snapshot = {
      ...snapshot,
      storageWarning: "上次任务记录无法读取。文件未受影响，请重新解析并选择原文件夹。"
    };
  }

  const requestCancellation = async () => {
    if (!snapshot.requestId || cancelAcknowledged || cancelInFlight) return;
    const requestId = snapshot.requestId;
    cancelInFlight = true;
    try {
      const acknowledged = await deps.cancel(requestId);
      if (snapshot.requestId === requestId) cancelAcknowledged = acknowledged;
    } catch {
      if (snapshot.requestId === requestId)
        publish({ message: "取消请求暂未送达；仍在等待下载终态，可再次取消。" });
    } finally {
      if (snapshot.requestId === requestId) cancelInFlight = false;
    }
  };
  const importOutcome = async (context: BilibiliProjectContext, explicit: boolean) => {
    const outcome = snapshot.outcome;
    if (!outcome || outcome.results.length === 0) return;
    const current = deps.currentContext();
    if (
      current.projectId !== context.projectId ||
      current.projectEpoch !== context.projectEpoch
    ) {
      publish(
        {
          phase: "pendingImport",
          message: "获取完成，但项目已经切换。已保留文件，请确认目标项目后导入。"
        },
        true
      );
      return;
    }
    publish(
      { phase: "importing", message: "正在验证 XML 并将参考音轨、弹幕及来源绑定一起导入…" },
      true
    );
    try {
      const summary = await deps.importResults(outcome.results, context);
      if (!summary) {
        publish(
          {
            phase: "pendingImport",
            message: "验证期间项目已切换，素材尚未导入。请确认目标项目后重试。"
          },
          true
        );
        return;
      }
      publish(
        {
          phase: outcome.status,
          importSummary: summary,
          message:
            `已新增 ${summary.added} 个 XML、${summary.audioAdded} 个参考音轨，建立 ${summary.bound} 个来源绑定；复用 ${summary.reused} 个，保留 ${summary.preserved} 个已有版本。` +
            (outcome.error ? ` ${outcome.error}` : "") +
            (summary.retainedAudioReferences
              ? ` ${summary.retainedAudioReferences} 个参考沿用已有路径；若旧文件已移动，请在素材页重新连接。`
              : "") +
            (explicit ? " 已写入当前项目。" : "")
        },
        true
      );
    } catch (error) {
      publish(
        { phase: "pendingImport", message: `文件已保存，导入尚未完成：${errorText(error)}` },
        true
      );
    }
  };
  const start = async (
    draft: BilibiliJobDraft,
    cookie = "",
    context = deps.currentContext()
  ) => {
    if (isBilibiliJobBusy(snapshot.phase)) throw new Error("已有 B 站获取任务正在运行。");
    if (!draft.input.trim() || !draft.outputFolder.trim() || draft.selectedCids.length === 0)
      throw new Error("请先解析视频、选择分 P 和保存文件夹。");
    const requestId = deps.createRequestId();
    cancelRequested = false;
    cancelAcknowledged = false;
    cancelInFlight = false;
    publish(
      {
        phase: "running",
        requestId,
        draft: { ...draft, selectedCids: [...draft.selectedCids] },
        context,
        progress: null,
        outcome: null,
        importSummary: null,
        message: "正在开始获取…"
      },
      true
    );
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await deps.listen((progress) => {
        if (progress.requestId !== requestId || !isBilibiliJobBusy(snapshot.phase)) return;
        publish({
          progress,
          message: cancelRequested ? "正在取消，保留已完成的分 P…" : progress.message
        });
        if (cancelRequested && !cancelAcknowledged) void requestCancellation();
      });
      const outcome = cancelRequested
        ? { requestId, status: "cancelled" as const, results: [], error: null }
        : await deps.download({ ...draft, requestId, cookie: cookie.trim() || null });
      if (outcome.requestId !== requestId)
        throw new Error("下载回执与本次任务不一致，结果未自动导入。");
      publish(
        {
          outcome,
          phase: outcome.status,
          message:
            outcome.error ??
            (outcome.status === "cancelled" ? "已取消获取，文件已保留。" : "下载完成。")
        },
        true
      );
      if (outcome.results.length > 0) await importOutcome(context, false);
    } catch (error) {
      publish({ phase: "failed", message: errorText(error) }, true);
    } finally {
      unlisten?.();
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    async cancel() {
      if (snapshot.phase !== "running" && snapshot.phase !== "cancelling") return;
      cancelRequested = true;
      publish({ phase: "cancelling", message: "正在取消，保留已完成的分 P…" }, true);
      await requestCancellation();
    },
    async retry(
      cookie = "",
      options?: Pick<BilibiliJobDraft, "outputFolder" | "downloadAudio">
    ) {
      if (!snapshot.draft) return;
      // Downloads may resume for the original project; project writes remain guarded by its session.
      await start(
        { ...snapshot.draft, ...options },
        cookie,
        snapshot.context ?? deps.currentContext()
      );
    },
    async importIntoCurrentProject() {
      if (isBilibiliJobBusy(snapshot.phase)) return;
      await importOutcome(deps.currentContext(), true);
    }
  };
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
