import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import type { WebDavAudioCacheMediaDraft } from "../../domain/project/mediaLibrary";
import {
  webdavClient,
  webDavActive,
  type WebDavWorkspace,
  type WebDavEntry,
  type WebDavInspection
} from "../../infrastructure/acquisition/webdavClient";

export function WebDavAudioDialog({
  open,
  onClose,
  onImport
}: {
  open: boolean;
  onClose: () => void;
  onImport: (draft: WebDavAudioCacheMediaDraft) => void;
}) {
  const [workspace, setWorkspace] = useState<WebDavWorkspace>({ connections: [], jobs: [] });
  const [connectionId, setConnectionId] = useState("");
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<WebDavEntry[]>([]);
  const [selected, setSelected] = useState<WebDavEntry | null>(null);
  const [inspection, setInspection] = useState<WebDavInspection | null>(null);
  const [streamIndex, setStreamIndex] = useState(0);
  const [form, setForm] = useState({ name: "", root: "", username: "", password: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const importRef = useRef(onImport);
  importRef.current = onImport;
  const connection = workspace.connections.find((c) => c.id === connectionId);

  useEffect(() => {
    if (!open) {
      generation.current++;
      setBusy(false);
      setForm((v) => ({ ...v, password: "" }));
      return;
    }
    let alive = true;
    const invalidate = () => {
      generation.current++;
    };
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await webdavClient.workspace();
        if (alive) setWorkspace(next);
      } catch (e) {
        if (alive) setMessage(String(e));
      }
      if (alive) timer = setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      invalidate();
    };
  }, [open]);

  async function perform(work: (current: () => boolean) => Promise<void>) {
    const own = ++generation.current;
    setBusy(true);
    setMessage("");
    const current = () => generation.current === own;
    try {
      await work(current);
    } catch (e) {
      if (current()) setMessage(String(e));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function refresh(current: () => boolean, apply: () => void) {
    const value = await webdavClient.workspace();
    if (current()) {
      setWorkspace(value);
      apply();
    }
  }
  function browse(id: string, path: string) {
    setSelected(null);
    setInspection(null);
    void perform(async (current) => {
      const list = await webdavClient.list(id, path);
      if (current()) {
        setConnectionId(id);
        setDirectory(path);
        setEntries(list);
      }
    });
  }
  function applyInspection(value: WebDavInspection) {
    setInspection(value);
    setStreamIndex(value.streams[0]?.index ?? 0);
  }
  function selectEntry(entry: WebDavEntry) {
    setSelected(entry);
    setInspection(null);
    void perform(async (current) => {
      const result = await webdavClient.inspect(
        connectionId,
        entry.href,
        loadAppSettings().alignment.ffmpegPath || null
      );
      if (current()) applyInspection(result);
    });
  }
  if (!open) return null;
  return (
    <Dialog
      ariaLabel="WebDAV 原片音轨"
      onClose={onClose}
      className="flex max-h-[90vh] w-[min(1000px,95vw)] flex-col gap-3 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-ui-title font-semibold">WebDAV 原片音轨</h2>
        <Button onClick={onClose}>关闭</Button>
      </div>
      <p className="text-ui-helper text-content-muted">
        浏览文件、选择音轨并缓存到本机。原片末尾的无声画面不会额外补入，发布前请核对观看版本。关闭窗口后后台任务继续；退出
        Studio 会中断未完成获取。
      </p>
      <div className="grid min-h-0 gap-4 overflow-auto">
        <details open={workspace.connections.length === 0}>
          <summary className="cursor-pointer text-ui-body">添加 WebDAV 连接</summary>
          <form
            className="mt-2 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async (current) => {
                const saved = await webdavClient.save(form);
                await refresh(current, () => {
                  setConnectionId(saved.id);
                  setDirectory(new URL(saved.root).pathname);
                  setEntries([]);
                  setSelected(null);
                  setInspection(null);
                  setForm((v) => ({ ...v, password: "" }));
                  setMessage("连接已加密保存，请点击打开根目录。");
                });
              });
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Field
                label="连接名称"
                value={form.name}
                required
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Field
                label="WebDAV 根目录 URL"
                value={form.root}
                required
                placeholder="https://example.com/dav/"
                onChange={(e) => setForm({ ...form, root: e.target.value })}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field
                label="WebDAV 用户名"
                value={form.username}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
              <Field
                label="WebDAV 密码"
                type="password"
                value={form.password}
                autoComplete="new-password"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            <p className="text-ui-helper text-content-muted">
              账户由 Windows DPAPI 加密保存在本机，不写入项目。HTTP
              连接自身不加密，请按服务器实际配置选择。
            </p>
            <Button type="submit" disabled={busy}>
              加密保存连接
            </Button>
          </form>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <label>
            连接{" "}
            <select
              aria-label="WebDAV 连接"
              className="rounded border border-boundary bg-surface-base p-2"
              value={connectionId}
              disabled={busy}
              onChange={(e) => {
                generation.current++;
                setConnectionId(e.target.value);
                setEntries([]);
                setSelected(null);
                setInspection(null);
                setDirectory("");
              }}
            >
              <option value="">请选择连接</option>
              {workspace.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={busy || !connection}
            onClick={() =>
              connection && browse(connection.id, new URL(connection.root).pathname)
            }
          >
            打开根目录
          </Button>
          <Button
            disabled={
              busy ||
              !connection ||
              !directory ||
              directory === new URL(connection.root).pathname
            }
            onClick={() => browse(connectionId, directory.replace(/[^/]+\/$/, ""))}
          >
            上级目录
          </Button>
          <Button
            disabled={busy || !connection}
            onClick={() =>
              void perform(async (current) => {
                await webdavClient.remove(connectionId);
                await refresh(current, () => {
                  setConnectionId("");
                  setEntries([]);
                  setInspection(null);
                  setSelected(null);
                });
              })
            }
          >
            移除连接
          </Button>
        </div>
        {directory && (
          <p className="break-all text-ui-helper text-content-muted">{directory}</p>
        )}
        <ul aria-label="WebDAV 目录" className="grid max-h-60 gap-1 overflow-auto">
          {entries.map((entry) => (
            <li key={entry.href}>
              <Button
                className="w-full justify-start"
                disabled={busy}
                onClick={() =>
                  entry.directory ? browse(connectionId, entry.href) : selectEntry(entry)
                }
              >
                {entry.directory ? "目录：" : "文件："}
                {entry.name}
                {entry.size !== null ? ` · ${(entry.size / 1024 / 1024).toFixed(1)} MiB` : ""}
              </Button>
            </li>
          ))}
        </ul>
        {selected && !inspection && !busy && (
          <div className="grid gap-2">
            <p className="text-ui-helper">
              已选：{selected.name}
              。若服务器不支持流式读取，可一次下载临时原片；需要完整原片空间及额外 8
              GiB，提取后删除临时输入。
            </p>
            <Button
              onClick={() =>
                void perform(async (current) => {
                  await webdavClient.prepareSource(connectionId, selected.href);
                  await refresh(current, () => {
                    setSelected(null);
                    setMessage("临时原片下载已排队，请在下方任务中查看。");
                  });
                })
              }
            >
              一次下载临时原片
            </Button>
          </div>
        )}
        {inspection && (
          <div className="grid gap-2 rounded border border-boundary p-3">
            <p className="text-ui-body">{inspection.name}</p>
            <label>
              音轨{" "}
              <select
                aria-label="WebDAV 音轨"
                className="rounded border border-boundary bg-surface-base p-2"
                disabled={busy}
                value={streamIndex}
                onChange={(e) => setStreamIndex(Number(e.target.value))}
              >
                {inspection.streams.map((s) => (
                  <option key={s.index} value={s.index}>
                    {s.index} · {s.language ?? "未知语言"} · {s.title ?? s.codec} ·{" "}
                    {s.channels ?? "?"} 声道
                  </option>
                ))}
              </select>
            </label>
            <p className="text-ui-helper text-content-muted">
              保留音轨开头相对偏移，原片末尾的无声画面不会额外补入。远程读取可能传输大部分视频字节。
            </p>
            <details className="text-ui-helper text-content-muted">
              <summary>时间与输出详情</summary>
              <p>
                播放原点 {inspection.sourcePresentationOriginMs} ms；输出单声道 16 kHz
                FLAC。完整原片版本及音轨尾部覆盖未证明。
              </p>
            </details>
            <Button
              tone="primary"
              disabled={busy}
              onClick={() =>
                void perform(async (current) => {
                  await webdavClient.start(inspection.probeId, streamIndex);
                  await refresh(current, () => {
                    setInspection(null);
                    setSelected(null);
                  });
                })
              }
            >
              缓存所选音轨
            </Button>
          </div>
        )}
        <p role="status" className="text-ui-helper text-content-secondary">
          {busy ? "正在处理，请稍候…" : message}
        </p>
        <section aria-label="WebDAV 后台任务" className="grid gap-2">
          <h3 className="font-semibold">获取任务</h3>
          {workspace.jobs
            .slice()
            .reverse()
            .map((job) => (
              <article key={job.id} className="grid gap-2 rounded border border-boundary p-3">
                <p className="break-all text-ui-body">{job.name}</p>
                <p className="text-ui-helper text-content-muted">{job.message}</p>
                <div className="flex flex-wrap gap-2">
                  {webDavActive(job) && (
                    <Button
                      disabled={job.status === "cancelling"}
                      onClick={() =>
                        void webdavClient
                          .cancel(job.id)
                          .catch((e: unknown) => setMessage(String(e)))
                      }
                    >
                      取消获取
                    </Button>
                  )}
                  {job.status === "awaitingTrack" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(async (current) => {
                          const result = await webdavClient.inspectSource(
                            job.id,
                            loadAppSettings().alignment.ffmpegPath || null
                          );
                          if (current()) {
                            setSelected(null);
                            applyInspection(result);
                          }
                        })
                      }
                    >
                      探测临时原片并选音轨
                    </Button>
                  )}
                  {job.status === "completed" && (
                    <Button
                      tone="primary"
                      disabled={busy}
                      onClick={() => {
                        const importIntoProject = importRef.current;
                        void perform(async (current) => {
                          const draft = await webdavClient.import(job.id);
                          if (current()) {
                            importIntoProject(draft);
                            setMessage("音轨已导入当前项目。");
                          }
                        });
                      }}
                    >
                      验证并导入当前项目
                    </Button>
                  )}
                  {["failed", "interrupted", "cancelled"].includes(job.status) && (
                    <Button
                      disabled={
                        busy || !workspace.connections.some((c) => c.id === job.connectionId)
                      }
                      onClick={() => {
                        setConnectionId(job.connectionId);
                        setSelected({
                          href: job.href,
                          name: job.name,
                          directory: false,
                          size: null
                        });
                        void perform(async (current) => {
                          const result = await webdavClient.inspect(
                            job.connectionId,
                            job.href,
                            loadAppSettings().alignment.ffmpegPath || null
                          );
                          if (current()) applyInspection(result);
                        });
                      }}
                    >
                      重新探测源文件
                    </Button>
                  )}
                  {!webDavActive(job) && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(async (current) => {
                          await webdavClient.forget(job.id);
                          await refresh(current, () => {
                            setInspection(null);
                            setMessage("任务记录及自有临时原片已移除，完成音轨继续保留。");
                          });
                        })
                      }
                    >
                      移除任务记录和临时原片
                    </Button>
                  )}
                </div>
              </article>
            ))}
        </section>
      </div>
    </Dialog>
  );
}
