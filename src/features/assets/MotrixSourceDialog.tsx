import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import type { MotrixPrefill } from "../../application/discoveryPrefill";
import { rememberAcquisition } from "../../application/workflowPresets";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { pickSingleNativeDirectoryPath } from "../../infrastructure/file-system/nativeDialogs";
import {
  acquisitionError,
  addMotrixDownload,
  fetchSourcePage,
  getMotrixWorkspace,
  openSourcePage,
  openSourceBrowser,
  listenSourceMagnet,
  refreshMotrixDownloads,
  repairMotrixDownload,
  verifiedMotrixFiles,
  type MotrixDownload
} from "../../infrastructure/acquisition/motrixClient";
import {
  normalizeMagnet,
  parseSourceMagnet,
  parseSourceSearch,
  sourceProviders,
  sourceSearchUrl,
  validateSourceUrl,
  type SourceCandidate,
  type SourceProviderId
} from "../../infrastructure/acquisition/sourceProviders";

const statusNames: Record<string, string> = {
  submitting: "正在提交",
  uncertain: "提交结果待确认",
  duplicate_conflict: "同一资源的任务冲突",
  file_conflict: "下载目录存在同名文件",
  rejected: "请求未被接受",
  queued: "等待下载",
  fetching_metadata: "获取磁力元数据",
  awaiting_download: "等待原片任务",
  metadata_error: "种子信息未就绪",
  metadata_ready: "等待选择种子文件",
  downloading: "下载中",
  paused: "已暂停",
  seeding: "下载数据已齐，正在做种",
  finalizing: "正在整理文件",
  completed: "已完成",
  error: "下载失败",
  missing: "任务已移除",
  unknown: "状态待确认"
};
function draft(projectId: string): {
  query: string;
  provider: SourceProviderId;
  directory: string;
} {
  try {
    const v: unknown = JSON.parse(
      localStorage.getItem(`studio.acquisition.${projectId}`) ?? "null"
    );
    if (
      v &&
      typeof v === "object" &&
      "query" in v &&
      typeof v.query === "string" &&
      "provider" in v &&
      (v.provider === "ext" || v.provider === "nyaa") &&
      "directory" in v &&
      typeof v.directory === "string"
    )
      return { query: v.query, provider: v.provider, directory: v.directory };
  } catch {
    /* Optional preference. */
  }
  return {
    query: "",
    provider: loadAppSettings().acquisition?.provider ?? "ext",
    directory: ""
  };
}
export function MotrixSourceDialog({
  open,
  projectId,
  projectEpoch = 0,
  prefill,
  onClose,
  onImport
}: {
  open: boolean;
  projectId: string;
  projectEpoch?: number;
  prefill?: MotrixPrefill;
  onClose: () => void;
  onImport: (paths: string[]) => number;
}) {
  const [preferences, setPreferences] = useState(() => draft(projectId));
  const [results, setResults] = useState<SourceCandidate[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [magnet, setMagnet] = useState("");
  const [title, setTitle] = useState("");
  const [downloads, setDownloads] = useState<MotrixDownload[]>([]);
  const [connection, setConnection] = useState("正在读取 Motrix 连接…");
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const consumedPrefill = useRef<string>();
  useEffect(() => {
    if (!open || !prefill || consumedPrefill.current === prefill.requestId) return;
    consumedPrefill.current = prefill.requestId;
    if (prefill.projectId !== projectId || prefill.projectEpoch !== projectEpoch) return;
    if (running.current) {
      setMessage("当前操作尚未结束，未覆盖输入；请完成后重新带入待办。");
      return;
    }
    setResults([]);
    setHasNext(false);
    setPage(1);
    setMagnet("");
    setTitle(prefill.title);
    setPreferences((p) => ({
      ...p,
      provider: prefill.provider,
      query: prefill.kind === "search" ? prefill.value : ""
    }));
    if (prefill.kind === "detail")
      setResults([
        {
          id: prefill.value,
          title: prefill.title || "已选详情页",
          detailsUrl: validateSourceUrl(prefill.value),
          size: "未知",
          seeds: "未知",
          magnet: null
        }
      ]);
    if (prefill.kind === "magnet") setMagnet(normalizeMagnet(prefill.value));
    setMessage("已带入待办。请核对，点击搜索、获取磁力或发送到 Motrix；尚未开始下载。");
  }, [open, prefill, projectId, projectEpoch]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(acquisitionError(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const connect = async () => {
    const v = await getMotrixWorkspace(projectId);
    setConnection(v.message);
    setConnected(v.connected);
    setDownloads(v.downloads);
    setPreferences((p) => ({ ...p, directory: p.directory || v.defaultDirectory }));
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    void getMotrixWorkspace(projectId)
      .then((v) => {
        if (!active) return;
        setConnection(v.message);
        setConnected(v.connected);
        setDownloads(v.downloads);
        setPreferences((p) => ({ ...p, directory: p.directory || v.defaultDirectory }));
      })
      .catch((e) => {
        if (active) {
          setConnected(false);
          setConnection(acquisitionError(e));
        }
      });
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing || running.current) return;
      refreshing = true;
      void refreshMotrixDownloads(projectId)
        .then((rows) => {
          if (active) setDownloads(rows);
        })
        .catch(() => {
          /* Manual refresh explains errors without repeated notices. */
        })
        .finally(() => {
          refreshing = false;
        });
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, projectId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listenSourceMagnet((value) => {
      if (!active || value.projectId !== projectId || running.current) return;
      try {
        setMagnet(normalizeMagnet(value.magnet));
        setTitle(value.title);
        setMessage("已从浏览器接收磁力。核对标题和目录后，点击发送到 Motrix。");
      } catch (e) {
        setMessage(acquisitionError(e));
      }
    })
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch((e) => {
        if (active) setMessage(acquisitionError(e));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [open, projectId]);
  useEffect(() => {
    try {
      localStorage.setItem(`studio.acquisition.${projectId}`, JSON.stringify(preferences));
    } catch {
      /* Keep working if preferences cannot be saved. */
    }
  }, [preferences, projectId]);
  const search = (nextPage: number) =>
    run(async () => {
      setResults([]);
      setHasNext(false);
      setMagnet("");
      setTitle("");
      const url = sourceSearchUrl(preferences.provider, preferences.query, nextPage);
      const parsed = parseSourceSearch(preferences.provider, await fetchSourcePage(url));
      setResults(parsed.results);
      setHasNext(parsed.hasNext);
      setPage(nextPage);
      setMessage(
        parsed.results.length
          ? `第 ${nextPage} 页 · ${parsed.results.length} 个候选。请核对年份、季集和观看版本。`
          : "没有找到结果，可尝试原名、英文名或 IMDb 编号。"
      );
    });
  const resolve = (result: SourceCandidate) =>
    run(async () => {
      setMagnet("");
      setTitle(result.title);
      const value =
        result.magnet ??
        parseSourceMagnet(await fetchSourcePage(validateSourceUrl(result.detailsUrl)));
      if (!value) {
        setMessage(
          "此页需要点击网页按钮才能显示磁力。选择“浏览并送回磁力”，在网页中显示哈希后送回 Studio。"
        );
        return;
      }
      setMagnet(normalizeMagnet(value));
      setMessage("磁力已取得。确认下方标题和下载目录后，发送到 Motrix。");
    });
  if (!open) return null;
  return (
    <Dialog
      ariaLabel="搜索原片与 Motrix 下载"
      onClose={() => {
        if (!running.current) onClose();
      }}
      closeOnEscape={!busy}
      className="dialog-shell flex max-h-[90vh] w-full max-w-5xl flex-col"
    >
      <header className="flex items-center justify-between gap-3 border-b border-panel-line p-4">
        <h2 className="text-lg font-semibold">搜索原片与 Motrix 下载</h2>
        <Button disabled={busy} onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="thin-scrollbar grid min-h-0 gap-4 overflow-y-auto p-4 text-sm">
        <p>
          选好观看版本后交给 Motrix 下载；完成的原片可从这里导入当前项目。关闭 Studio 后，Motrix
          会继续下载。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <span role="status">{connection}</span>
          <Button disabled={busy} onClick={() => void run(connect)}>
            刷新连接
          </Button>
        </div>
        <fieldset disabled={busy} className="grid gap-3">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search(1);
            }}
          >
            <label>
              搜索网站
              <select
                aria-label="搜索网站"
                className="ml-2 rounded border border-boundary bg-surface-base p-2"
                value={preferences.provider}
                onChange={(e) => {
                  void rememberAcquisition({
                    provider: e.target.value as SourceProviderId
                  }).catch((error) => setMessage(`默认来源未保存：${acquisitionError(error)}`));
                  setPreferences((p) => ({
                    ...p,
                    provider: e.target.value as SourceProviderId
                  }));
                  setResults([]);
                  setHasNext(false);
                  setPage(1);
                }}
              >
                {sourceProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              className="min-w-48 flex-1"
              label="片名或 IMDb 编号"
              value={preferences.query}
              placeholder="如：英文原名、年份、S01E01"
              onChange={(e) => setPreferences((p) => ({ ...p, query: e.target.value }))}
            />
            <Button type="submit">搜索原片</Button>
            <Button
              type="button"
              disabled={!preferences.query.trim()}
              onClick={() =>
                void run(() =>
                  openSourceBrowser(
                    projectId,
                    sourceSearchUrl(preferences.provider, preferences.query, page)
                  )
                )
              }
            >
              打开搜索网页
            </Button>
            <Button
              type="button"
              disabled={!preferences.query.trim()}
              onClick={() =>
                void run(() =>
                  openSourcePage(sourceSearchUrl(preferences.provider, preferences.query, 1))
                )
              }
            >
              用外部浏览器打开
            </Button>
          </form>
          {results.length > 0 && (
            <div className="grid gap-2" aria-label="原片搜索结果">
              {results.map((r) => (
                <section
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-boundary p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">{r.title}</p>
                    <p className="text-content-muted">
                      {r.size} · 做种 {r.seeds}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => void resolve(r)}>选择并获取磁力</Button>
                    <Button
                      onClick={() => void run(() => openSourceBrowser(projectId, r.detailsUrl))}
                    >
                      浏览并送回磁力
                    </Button>
                  </div>
                </section>
              ))}
            </div>
          )}
          {(page > 1 || hasNext) && (
            <div className="flex gap-2">
              <Button disabled={page <= 1} onClick={() => void search(page - 1)}>
                上一页
              </Button>
              <span>第 {page} 页</span>
              <Button disabled={!hasNext || page >= 100} onClick={() => void search(page + 1)}>
                下一页
              </Button>
            </div>
          )}
          <Field
            label="下载标题"
            value={title}
            placeholder="可填写作品、季集和版本，方便找到这个任务"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Field
            label="磁力链接或 Info Hash"
            value={magnet}
            placeholder="也可从其它网站复制 magnet:?xt=…"
            onChange={(e) => setMagnet(e.target.value)}
          />
          <div className="flex flex-wrap items-end gap-2">
            <Field
              className="min-w-48 flex-1"
              label="原片下载目录"
              value={preferences.directory}
              onChange={(e) => setPreferences((p) => ({ ...p, directory: e.target.value }))}
            />
            <Button
              onClick={() =>
                void run(async () => {
                  const path = await pickSingleNativeDirectoryPath({
                    title: "选择原片下载目录",
                    defaultPath: preferences.directory || undefined
                  });
                  if (path) setPreferences((p) => ({ ...p, directory: path }));
                })
              }
            >
              选择文件夹
            </Button>
          </div>
          <p className="text-xs text-content-muted">
            下载文件独立保存，不嵌入 Studio 项目，也不会自动清理。整季磁力的文件选择可在 Motrix
            中完成。
          </p>
          <div>
            <Button
              tone="primary"
              disabled={!connected || !magnet.trim() || !preferences.directory.trim()}
              onClick={() =>
                void run(async () => {
                  setMessage(
                    "正在获取种子信息，通常需要几秒；最长等待 90 秒。随后由 Motrix 下载原片。"
                  );
                  const result = await addMotrixDownload(
                    projectId,
                    title.trim() || "原片下载",
                    normalizeMagnet(magnet),
                    preferences.directory.trim()
                  );
                  setDownloads((rows) => [...rows.filter((r) => r.key !== result.key), result]);
                  setMessage(result.message || "已交给 Motrix。下面的下载记录会自动刷新。");
                })
              }
            >
              发送到 Motrix
            </Button>
          </div>
        </fieldset>
        {message && (
          <p role="status" className="break-words">
            {message}
          </p>
        )}
        <section className="grid gap-2">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">当前项目的下载</h3>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => setDownloads(await refreshMotrixDownloads(projectId)))
              }
            >
              刷新下载
            </Button>
          </div>
          {!downloads.length && (
            <p className="text-content-muted">
              提交后会在此保留记录，重新打开 Studio 仍可继续导入。
            </p>
          )}
          {downloads.map((row) => (
            <div key={row.key} className="grid gap-2 rounded border border-boundary p-3">
              <p className="break-words font-medium">{row.title}</p>
              <p>
                {statusNames[row.status] ?? "状态待确认"} · {Math.round(row.progress * 100)}%
              </p>
              <p className="break-all text-xs text-content-muted">{row.saveDir}</p>
              {row.message && <p role="status">{row.message}</p>}
              {row.status === "seeding" && !row.files.length && (
                <p>
                  Motrix
                  完成做种并报告最终路径后可直接导入；需要提前使用时，可从“批量导入原片素材”选择已下载文件。
                </p>
              )}
              {row.files.length > 0 && (
                <details>
                  <summary>{row.files.length} 个已完成的媒体文件</summary>
                  <ul className="break-all">
                    {row.files.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="flex flex-wrap gap-2">
                {(row.status === "error" || row.status === "duplicate_conflict") && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setMessage(
                          "正在核对同一资源的任务；正常任务直接关联，只清理失败或已完成元数据的记录，下载文件保留。"
                        );
                        const result = await repairMotrixDownload(projectId, row.key);
                        setDownloads((list) =>
                          list.map((item) => (item.key === result.key ? result : item))
                        );
                        setMessage(
                          result.message || "已关联或重新提交原片任务，下载记录会自动刷新。"
                        );
                      })
                    }
                  >
                    {row.status === "duplicate_conflict"
                      ? "修复重复任务并重试"
                      : "修复路径并重试"}
                  </Button>
                )}
                {row.status !== "duplicate_conflict" &&
                  (!row.taskId || row.status === "missing" || row.status === "error") && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const directory = await pickSingleNativeDirectoryPath({
                            title: "选择新的原片下载文件夹",
                            defaultPath: row.saveDir
                          });
                          if (!directory) return;
                          const result = await addMotrixDownload(
                            projectId,
                            row.title,
                            row.uri,
                            directory,
                            true
                          );
                          setDownloads((rows) => [
                            ...rows.filter((r) => r.key !== result.key),
                            result
                          ]);
                          setMessage(result.message || "已交给 Motrix，原目录中的文件保留。");
                        })
                      }
                    >
                      换目录重新下载
                    </Button>
                  )}
                {row.status !== "duplicate_conflict" &&
                  (!row.taskId || row.status === "missing") && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await addMotrixDownload(
                            projectId,
                            row.title,
                            row.uri,
                            row.saveDir,
                            row.status === "missing"
                          );
                          setDownloads((rows) => rows.map((v) => (v.key === r.key ? r : v)));
                          setMessage(r.message || "已交给 Motrix。");
                        })
                      }
                    >
                      {row.status === "missing" ? "重新创建下载" : "重试原请求"}
                    </Button>
                  )}
                <Button
                  disabled={
                    busy || !["completed", "seeding"].includes(row.status) || !row.files.length
                  }
                  onClick={() =>
                    void run(async () => {
                      const files = await verifiedMotrixFiles(projectId, row.key);
                      const added = onImport(files);
                      setMessage(
                        added > 0
                          ? `已导入 ${added} 个原片；可关闭窗口，在素材页查看。`
                          : "没有新增原片；这些文件已在项目中，或格式不受支持。"
                      );
                    })
                  }
                >
                  导入完成的原片
                </Button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </Dialog>
  );
}
