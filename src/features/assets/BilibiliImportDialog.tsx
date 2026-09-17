import { BilibiliAccountPanel } from "./BilibiliAccountPanel";
import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog } from "../../components/Dialog";
import { TextButton } from "../../components/TextButton";
import { TextInput } from "../../components/TextInput";
import { isBilibiliJobBusy } from "../../application/bilibiliAcquisitionController";
import { formatTimecode } from "../../domain/shared/time";
import { inspectBilibiliVideo } from "../../infrastructure/bilibili/bilibiliClient";
import { pickSingleNativeDirectoryPath } from "../../infrastructure/file-system/nativeDialogs";
import {
  biliAcquisition,
  useBilibiliWorkspaceSession
} from "../../stores/bilibiliAcquisitionStore";
import { useEditorStore } from "../../stores/editorStore";
import { getStorageStatus } from "../../infrastructure/settings/storageClient";
import { rememberAcquisition } from "../../application/workflowPresets";

export function BilibiliImportDialog() {
  const session = useBilibiliWorkspaceSession();
  const job = useSyncExternalStore(biliAcquisition.subscribe, biliAcquisition.getSnapshot);
  const projectName = useEditorStore((state) => state.project.name);
  const projectId = useEditorStore((state) => state.project.id);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const [operation, setOperation] = useState<"scan" | "login" | "folder" | null>(null);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const requestSequence = useRef(0);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isTauri() || useBilibiliWorkspaceSession.getState().outputFolder.trim()) return;
    let active = true;
    void getStorageStatus()
      .then((status) => {
        if (!active || useBilibiliWorkspaceSession.getState().outputFolder.trim()) return;
        if (status.active)
          useBilibiliWorkspaceSession.setState({ outputFolder: status.active.bilibili });
        else setMessage(status.error || "存储目录不可用。");
      })
      .catch((e) => {
        if (active) setMessage(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(
    () => () => {
      requestSequence.current++;
    },
    []
  );
  useEffect(() => {
    requestSequence.current++;
    setOperation(null);
    setFilter("");
    setPageIndex(0);
    setMessage("");
  }, [session.generation, projectId, projectEpoch]);
  const close = () => {
    requestSequence.current++;
    useBilibiliWorkspaceSession.setState((s) => ({
      open: false,
      generation: s.generation + 1
    }));
  };
  const busy = isBilibiliJobBusy(job.phase);
  const disabled = busy || operation !== null || !isTauri();
  const video = session.video;
  const selected = new Set(session.selectedCids);
  const filtered =
    video?.pages.filter((p) =>
      `P${p.page} ${p.part}`.toLowerCase().includes(filter.trim().toLowerCase())
    ) ?? [];
  const visible = filtered.slice(pageIndex * 100, (pageIndex + 1) * 100);
  const runOperation = async (
    kind: "scan" | "login" | "folder",
    run: (sequence: number) => Promise<void>
  ) => {
    const sequence = ++requestSequence.current;
    setOperation(kind);
    setMessage("");
    try {
      await run(sequence);
    } catch (error) {
      if (requestSequence.current === sequence)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestSequence.current === sequence) setOperation(null);
    }
  };
  const start = () => {
    if (!video) return;
    setMessage("");
    void biliAcquisition
      .start(
        {
          input: video.bvid,
          selectedCids: session.selectedCids,
          outputFolder: session.outputFolder,
          downloadAudio: session.downloadAudio
        },
        session.cookie
      )
      .catch((error: unknown) => setMessage(String(error)));
  };
  const selectAudio = (downloadAudio: boolean) => {
    useBilibiliWorkspaceSession.setState({ downloadAudio });
    void rememberAcquisition({ downloadAudio }).catch((e) =>
      setMessage(`采集默认值未保存：${String(e)}`)
    );
  };
  const canStart =
    Boolean(video && session.selectedCids.length && session.outputFolder.trim()) && !disabled;
  return (
    <Dialog
      onClose={close}
      ariaLabel="从 B 站获取素材"
      initialFocusRef={initialFocusRef}
      className="flex max-h-[calc(100dvh-32px)] w-[min(860px,calc(100vw-32px))] flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-panel-line p-4">
        <div>
          <h2 className="text-base font-semibold text-content-primary">从 B 站获取素材</h2>
          <p className="mt-1 text-xs text-content-muted">
            选择分 P，获取弹幕与参考音轨，自动配对加入素材。
          </p>
        </div>
        <TextButton onClick={close} aria-label="关闭 B 站获取">
          {busy ? "后台继续" : "关闭"}
        </TextButton>
      </header>
      <div className="thin-scrollbar min-h-0 space-y-3 overflow-y-auto p-4 text-xs text-content-secondary">
        {!isTauri() && (
          <p
            role="status"
            className="rounded border border-feedback-warning/30 p-3 text-feedback-warning"
          >
            从 B 站获取素材需要桌面版。网页版可继续导入本地 XML。
          </p>
        )}
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1">
            <span className="block">B 站视频链接或 BV / av 号</span>
            <TextInput
              className="w-full"
              ref={initialFocusRef}
              value={session.input}
              disabled={disabled}
              placeholder="https://www.bilibili.com/video/BV…"
              onChange={(event) => {
                useBilibiliWorkspaceSession.setState({
                  input: event.target.value,
                  video: null,
                  selectedCids: []
                });
                setMessage("");
              }}
            />
          </label>
          <TextButton
            disabled={disabled || !session.input.trim()}
            onClick={() =>
              void runOperation("scan", async (sequence) => {
                const capturedInput = session.input,
                  generation = session.generation;
                const info = await inspectBilibiliVideo(capturedInput, session.cookie);
                const now = useEditorStore.getState(),
                  active = useBilibiliWorkspaceSession.getState();
                if (
                  sequence !== requestSequence.current ||
                  !active.open ||
                  active.generation !== generation ||
                  active.input !== capturedInput ||
                  now.project.id !== projectId ||
                  now.projectEpoch !== projectEpoch ||
                  now.projectLibrary.switchingProject
                )
                  return;
                const linkedPage = Number(/[?&]p=(\d+)/.exec(session.input)?.[1]);
                const linked = info.pages.find((p) => p.page === linkedPage);
                useBilibiliWorkspaceSession.setState({
                  video: info,
                  selectedCids: linked ? [linked.cid] : info.pages.map((p) => p.cid)
                });
                setFilter("");
                setPageIndex(0);
              })
            }
          >
            {operation === "scan" ? "解析中…" : "解析视频"}
          </TextButton>
        </div>
        <BilibiliAccountPanel />
        {video && (
          <section aria-label="选择分 P" className="rounded border border-panel-line">
            <div className="space-y-2 border-b border-panel-line p-3">
              <div className="flex justify-between gap-2">
                <h3 className="font-medium text-content-primary">{video.title}</h3>
                <span className="shrink-0">
                  已选 {selected.size} / {video.pageCount} P
                </span>
              </div>
              <p className="text-content-muted">
                {video.ownerName} · {video.bvid}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <TextButton
                  disabled={disabled}
                  onClick={() =>
                    useBilibiliWorkspaceSession.setState({
                      selectedCids: video.pages.map((p) => p.cid)
                    })
                  }
                >
                  全选分 P
                </TextButton>
                <TextButton
                  disabled={disabled}
                  onClick={() => useBilibiliWorkspaceSession.setState({ selectedCids: [] })}
                >
                  清空选择
                </TextButton>
                <TextInput
                  aria-label="筛选分 P"
                  className="min-w-0 flex-1"
                  placeholder="按标题或 P 序号筛选"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                    setPageIndex(0);
                  }}
                />
              </div>
            </div>
            <div className="thin-scrollbar max-h-48 overflow-y-auto divide-y divide-panel-line/50">
              {visible.map((p) => (
                <label
                  key={p.cid}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-soft"
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={selected.has(p.cid)}
                    onChange={() =>
                      useBilibiliWorkspaceSession.setState({
                        selectedCids: selected.has(p.cid)
                          ? session.selectedCids.filter((cid) => cid !== p.cid)
                          : video.pages
                              .filter((item) => selected.has(item.cid) || item.cid === p.cid)
                              .map((item) => item.cid)
                      })
                    }
                  />
                  <span className="shrink-0 text-content-muted">P{p.page}</span>
                  <span className="min-w-0 flex-1 break-words">{p.part}</span>
                  <span className="shrink-0 tabular-nums text-content-muted">
                    {p.durationMs ? formatTimecode(p.durationMs) : "时长待获取"}
                  </span>
                </label>
              ))}
              {filtered.length === 0 && (
                <p className="p-3 text-content-muted">没有符合筛选的分 P。</p>
              )}
            </div>
            {filtered.length > 100 && (
              <div className="flex justify-between p-2">
                <TextButton
                  disabled={pageIndex === 0}
                  onClick={() => setPageIndex(pageIndex - 1)}
                >
                  上一页
                </TextButton>
                <span>
                  {pageIndex + 1} / {Math.ceil(filtered.length / 100)}
                </span>
                <TextButton
                  disabled={(pageIndex + 1) * 100 >= filtered.length}
                  onClick={() => setPageIndex(pageIndex + 1)}
                >
                  下一页
                </TextButton>
              </div>
            )}
            {video.warnings.map((warning, index) => (
              <p className="px-3 pb-2 text-feedback-warning" key={index}>
                {warning}
              </p>
            ))}
          </section>
        )}
        <fieldset disabled={disabled} className="flex flex-wrap gap-x-5 gap-y-2">
          <legend className="mb-2 text-content-muted">获取内容</legend>
          <label className="flex gap-2">
            <input
              type="radio"
              name="bilibili-content"
              checked={session.downloadAudio}
              onChange={() => selectAudio(true)}
            />
            弹幕 + 参考音轨（用于匹配原片）
          </label>
          <label className="flex gap-2">
            <input
              type="radio"
              name="bilibili-content"
              checked={!session.downloadAudio}
              onChange={() => selectAudio(false)}
            />
            仅弹幕 XML（直接编辑）
          </label>
        </fieldset>
        <p className="text-content-muted">
          {session.downloadAudio
            ? "音轨保留原始 M4A，不转码；可用于匹配和试听，没有参考画面。下载不会自动确认与原片的时间关系。"
            : "保留每个 P 的时间零点和已知播放时长，可直接进入弹幕编辑与导出。"}
        </p>
        <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1">
            <span className="block">素材保存文件夹</span>
            <TextInput
              className="w-full"
              value={session.outputFolder}
              readOnly
              placeholder="选择长期保留的文件夹"
            />
          </label>
          <TextButton
            disabled={disabled}
            onClick={() =>
              void runOperation("folder", async (sequence) => {
                const folder = await pickSingleNativeDirectoryPath({
                  title: "选择 B 站素材保存文件夹",
                  defaultPath: session.outputFolder || undefined
                });
                if (folder && sequence === requestSequence.current)
                  useBilibiliWorkspaceSession.setState({ outputFolder: folder });
              })
            }
          >
            选择文件夹
          </TextButton>
        </div>
        <p className="text-content-muted">
          项目会引用这里的音轨，请保留文件。再次选择同一文件夹会校验并跳过已完成的分 P。
        </p>
        {message && (
          <p
            role="status"
            className="break-words rounded border border-feedback-warning/30 p-3 text-feedback-warning"
          >
            {message}
          </p>
        )}
        {job.phase === "idle" && job.storageWarning && (
          <p role="status" className="text-feedback-warning">
            {job.storageWarning}
          </p>
        )}
        {job.phase !== "idle" && (
          <section
            aria-label="B 站获取进度"
            className="space-y-2 rounded border border-accent-cyan/30 bg-accent-cyan/5 p-3"
          >
            <p className="text-content-muted">目标项目：{job.context?.projectName}</p>
            {job.draft && (
              <p className="break-all text-content-muted">
                恢复任务：{job.draft.input} ·{" "}
                {job.draft.downloadAudio ? "弹幕与参考音轨" : "仅弹幕"}
                。继续获取沿用此任务原选项，新的表单不会改变它。
              </p>
            )}
            <p role="status" className="break-words">
              {job.message}
            </p>
            {busy && job.progress && (
              <progress
                aria-label="分 P 下载进度"
                className="w-full"
                max={job.progress.total}
                value={Math.max(0, job.progress.current - 1 + job.progress.percent / 100)}
              />
            )}
            {job.outcome && (
              <p className="text-content-muted">本次已保存 {job.outcome.results.length} 个 P</p>
            )}
            {job.storageWarning && (
              <p className="text-feedback-warning">{job.storageWarning}</p>
            )}
            {!busy && job.draft && (
              <div className="flex flex-wrap gap-2">
                {job.phase !== "completed" && (
                  <TextButton
                    onClick={() => {
                      const original = biliAcquisition.getSnapshot().draft;
                      if (!original) return;
                      useBilibiliWorkspaceSession.setState((s) => ({
                        generation: s.generation + 1,
                        input: original.input,
                        outputFolder: original.outputFolder,
                        downloadAudio: original.downloadAudio,
                        selectedCids: [...original.selectedCids],
                        video: null
                      }));
                      void biliAcquisition
                        .retry(session.cookie)
                        .catch((error: unknown) => setMessage(String(error)));
                    }}
                  >
                    继续获取未完成分 P
                  </TextButton>
                )}
                {Boolean(job.outcome?.results.length) && (
                  <TextButton onClick={() => void biliAcquisition.importIntoCurrentProject()}>
                    将已保存结果导入当前项目
                  </TextButton>
                )}
              </div>
            )}
          </section>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-panel-line p-4">
        <p className="min-w-0 text-xs text-content-muted">
          {busy
            ? "关闭面板后继续获取，可在任务中心查看。"
            : `获取后加入当前项目：${projectName}`}
        </p>
        {busy ? (
          <TextButton
            disabled={job.phase === "importing"}
            onClick={() => void biliAcquisition.cancel()}
          >
            {job.phase === "cancelling"
              ? "再次发送取消"
              : job.phase === "importing"
                ? "正在导入…"
                : "取消获取"}
          </TextButton>
        ) : (
          <TextButton tone="primary" disabled={!canStart} onClick={start}>
            获取并加入素材{selected.size ? `（${selected.size} P）` : ""}
          </TextButton>
        )}
      </footer>
    </Dialog>
  );
}
