import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import type { LibraryProfile } from "../../domain/project/discovery";
import { Dialog } from "../../components/Dialog";
import {
  listDeliveries,
  loadDelivery,
  type DeliveryRecord,
  type DeliverySummary
} from "../../infrastructure/private-library/publicationOutbox";
import {
  privateLibraryError,
  type CanonicalMetadata,
  type PublicationMetadata
} from "../../infrastructure/private-library/privateLibrary";
import { PrivateLibraryPublishDialog } from "./PrivateLibraryPublishDialog";
import {
  searchLibraryWorks,
  getLibraryEpisodes,
  selectLibraryFiles,
  reviewLibraryEpisode
} from "../../infrastructure/private-library/libraryBrowser";
import type { LibraryWork } from "../../application/libraryUpdate";
import type { PublicationDelivery } from "../../domain/publication/types";

const TmdbCatalogDialog = lazy(() =>
  import("./TmdbCatalogDialog").then((m) => ({ default: m.TmdbCatalogDialog }))
);

interface Manifest extends PublicationMetadata {
  commentCount: number;
}
interface Episode {
  episodeId: number;
  revision: string;
  manifest: Manifest;
  canonicalMetadata: CanonicalMetadata;
  reviewStatus?: "pending" | "approved";
  isVisible?: boolean;
}
interface Revision {
  revision: string;
  createdAt: string;
  isCurrent: boolean;
  manifest: Manifest;
}
interface History {
  canRestore?: boolean;
  currentRevision: string;
  revisions: Revision[];
  nextCursor: number | null;
}
export function PublicationLibraryDialog({
  onClose,
  onChooseProfile
}: {
  onClose: () => void;
  onChooseProfile?: (profile: LibraryProfile) => void;
}) {
  const [catalog, setCatalog] = useState(false);
  const [tab, setTab] = useState<"local" | "cloud">("cloud");
  const [works, setWorks] = useState<LibraryWork[]>([]);
  const [chosenWork, setChosenWork] = useState<LibraryWork | null>(null);
  const [input, setInput] = useState<PublicationDelivery | null>(null);
  const [local, setLocal] = useState<DeliverySummary[]>([]);
  const [selected, setSelected] = useState<DeliveryRecord | null>(null);
  const [cloud, setCloud] = useState<Episode[]>([]);
  const [reviewTarget, setReviewTarget] = useState<Episode | null>(null);
  const [reviewApproved, setReviewApproved] = useState(false);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [target, setTarget] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  useEffect(() => {
    let active = true;
    void listDeliveries()
      .then((rows) => {
        if (active) setLocal(rows);
      })
      .catch((e) => {
        if (active) setMessage(privateLibraryError(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(privateLibraryError(e));
    } finally {
      setBusy(false);
    }
  };
  const fetchCloud = async () => {
    const requestGeneration = ++generation.current,
      q = queryRef.current;
    if (q.length > 200) throw new Error("作品或别名搜索最多 200 字符。");
    const result = await searchLibraryWorks(q);
    if (requestGeneration !== generation.current || q !== queryRef.current) return;
    setWorks(result);
    setChosenWork(null);
    setReviewTarget(null);
    setCloud([]);
  };
  const fetchHistory = async (item: Episode, before: number | null = null) => {
    const result = await invoke<History>("list_private_library_revisions", {
      episodeId: item.episodeId,
      before: before?.toString() ?? null
    });
    setEpisode(item);
    setTarget(null);
    setHistory((previous) =>
      before && previous
        ? { ...result, revisions: [...previous.revisions, ...result.revisions] }
        : result
    );
  };
  useEffect(() => {
    let active = true;
    const requestGeneration = ++generation.current;
    void searchLibraryWorks("")
      .then((rows) => {
        if (active && requestGeneration === generation.current) setWorks(rows);
      })
      .catch((e) => {
        if (active && requestGeneration === generation.current)
          setMessage(privateLibraryError(e));
      });
    return () => {
      active = false;
    };
  }, []);
  if (catalog && chosenWork)
    return (
      <Suspense fallback={<p role="status">正在打开影视资料…</p>}>
        <TmdbCatalogDialog
          existingWork={chosenWork}
          onClose={() => setCatalog(false)}
          onChoose={(w) => {
            setChosenWork(w);
            setCatalog(false);
            void run(async () => {
              setWorks(await searchLibraryWorks(queryRef.current));
            });
          }}
        />
      </Suspense>
    );
  if (input)
    return (
      <PrivateLibraryPublishDialog
        delivery={input}
        initialWork={chosenWork ?? undefined}
        onClose={() => {
          setInput(null);
          void run(() => fetchCloud());
        }}
      />
    );
  if (selected)
    return (
      <PrivateLibraryPublishDialog
        delivery={selected.delivery}
        onClose={() => setSelected(null)}
      />
    );
  return (
    <Dialog
      ariaLabel="私人弹幕库"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="dialog-shell flex max-h-[90vh] w-full max-w-3xl flex-col"
    >
      <header className="flex items-center justify-between border-b border-panel-line p-4">
        <h2 className="text-lg font-semibold">私人弹幕库</h2>
        <Button disabled={busy} onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="thin-scrollbar grid min-h-0 gap-3 overflow-y-auto p-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Button
            aria-pressed={tab === "local"}
            onClick={() => {
              generation.current++;
              setTab("local");
              setEpisode(null);
            }}
          >
            本机文件与更新记录
          </Button>
          <Button
            disabled={busy}
            aria-pressed={tab === "cloud"}
            onClick={() => {
              setTab("cloud");
              setEpisode(null);
              void run(() => fetchCloud());
            }}
          >
            我的影视
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const d = await selectLibraryFiles(true);
                if (d) setInput(d);
              })
            }
          >
            从文件夹更新弹幕
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const d = await selectLibraryFiles(false);
                if (d) setInput(d);
              })
            }
          >
            选择 XML 文件
          </Button>
        </div>
        <p>
          {chosenWork
            ? `将为“${chosenWork.title}”选择要检查、更新的文件。`
            : "先选择已有影视更新，也可以直接选择文件后再选影视。无需创建编辑项目。"}
        </p>
        <p className="rounded border border-boundary p-3">
          待检查不等于成品。旧批量导入的文件仍需逐项检查；更新、恢复旧修订后也要重新确认。目录位置和
          XML 解析成功都不能证明已修整。
        </p>
        {reviewTarget && (
          <section
            className="grid gap-2 rounded border border-boundary p-3"
            aria-label="确认检查结果"
          >
            <p>
              {reviewTarget.canonicalMetadata.title} ·{" "}
              {reviewTarget.manifest.kind === "movie"
                ? "电影"
                : `第 ${reviewTarget.manifest.season} 季第 ${reviewTarget.manifest.episode} 集`}{" "}
              · {reviewTarget.manifest.commentCount} 条
            </p>
            <p>
              {reviewApproved
                ? "请确认已检查这一集内容完整、完成修整且与观看版本一致。确认后才标为成品并上架。"
                : "这份弹幕将保持待检查，播放器不再显示；文件和修订保留。"}
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const approved = reviewApproved;
                  await reviewLibraryEpisode(
                    reviewTarget.episodeId,
                    reviewTarget.revision,
                    approved
                  );
                  if (chosenWork) setCloud(await getLibraryEpisodes(chosenWork.workKey));
                  setReviewTarget(null);
                  setMessage(
                    approved ? "已确认成品并上架。" : "已退回待检查并下架，内容保留。"
                  );
                })
              }
            >
              {reviewApproved ? "我已检查，确认成品并上架" : "确认暂不上架"}
            </Button>
            <Button disabled={busy} onClick={() => setReviewTarget(null)}>
              取消检查操作
            </Button>
          </section>
        )}
        {tab === "local" ? (
          <>
            <p>
              每次导出的内容单独保存。打开一批成品可继续填写、发布或重试，不要求重新打开原项目。
            </p>
            {!local.length && (
              <p>还没有本机成品记录。可在导出页导出 XML，或直接选择已有文件。</p>
            )}
            {local.map((row) => (
              <section
                key={row.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-boundary p-3"
              >
                <div>
                  <p>
                    {row.projectName} · {row.fileCount} 个 XML
                  </p>
                  <p className="text-xs text-content-muted">
                    {new Date(row.createdAt).toLocaleString()} ·{" "}
                    {(row.byteCount / 1024 / 1024).toFixed(1)} MiB
                  </p>
                </div>
                <Button
                  disabled={busy}
                  onClick={() => void run(async () => setSelected(await loadDelivery(row.key)))}
                >
                  打开发布草稿
                </Button>
              </section>
            ))}
          </>
        ) : episode && history ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setEpisode(null);
                setHistory(null);
                setTarget(null);
              }}
            >
              返回云端目录
            </Button>
            <h3 className="font-semibold">
              {episode.canonicalMetadata.title} · S{episode.manifest.season}E
              {episode.manifest.episode}
            </h3>
            <p>
              {history.canRestore === false
                ? "云端只保存当前播放器数据。以下是发布记录，不含旧成品文件；需要换回旧弹幕时，请选择本地 XML，更新这部影视的对应集。"
                : "恢复这一集的旧弹幕；正式片名与其他分集保留。恢复后先处于待检查，需重新确认上架。"}
            </p>
            {history.revisions.map((row) => (
              <section
                key={row.revision}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-boundary p-3"
              >
                <div>
                  <p>
                    {row.createdAt} · {row.manifest.commentCount} 条
                  </p>
                  <p className="text-xs text-content-muted">
                    修订 {row.revision.slice(0, 12)}
                    {row.isCurrent ? " · 当前使用" : ""}
                  </p>
                </div>
                {history.canRestore !== false && (
                  <Button disabled={busy || row.isCurrent} onClick={() => setTarget(row)}>
                    选择恢复这版
                  </Button>
                )}
              </section>
            ))}
            {history.nextCursor && (
              <Button
                disabled={busy}
                onClick={() => void run(() => fetchHistory(episode, history.nextCursor))}
              >
                更早的修订
              </Button>
            )}
            {target && history.canRestore !== false && (
              <section className="space-y-2 rounded border border-boundary p-3">
                <p>
                  将此集恢复为 {target.createdAt} 的 {target.manifest.commentCount}{" "}
                  条弹幕，提交后重新回读验证 XML。
                </p>
                <Button
                  tone="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await invoke("rollback_private_library_episode", {
                        episodeId: episode.episodeId,
                        revision: target.revision,
                        expectedRevision: history.currentRevision
                      });
                      await fetchHistory(episode);
                      await fetchCloud();
                      setMessage(
                        "已恢复选定修订，XML 回读校验通过；内容待检查，确认后才能上架。"
                      );
                    })
                  }
                >
                  确认恢复选定修订
                </Button>
                <Button disabled={busy} onClick={() => setTarget(null)}>
                  取消
                </Button>
              </section>
            )}
          </>
        ) : (
          <>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => fetchCloud());
              }}
            >
              <Field
                label="搜索私人库影视"
                maxLength={200}
                value={query}
                onChange={(e) => {
                  queryRef.current = e.target.value;
                  setQuery(e.target.value);
                  generation.current++;
                  setCloud([]);
                  setWorks([]);
                  setChosenWork(null);
                  setReviewTarget(null);

                  setMessage("");
                }}
              />
              <Button type="submit" disabled={busy}>
                搜索
              </Button>
            </form>
            {chosenWork && (
              <>
                <h3 className="font-semibold">{chosenWork.title}</h3>
                <Button disabled={busy} onClick={() => setCatalog(true)}>
                  影视资料与季年份
                </Button>
                <Button disabled={busy} onClick={() => void run(fetchCloud)}>
                  返回影视列表
                </Button>
              </>
            )}
            {!chosenWork && !works.length && !busy && (
              <p>未找到影视。可重新搜索，或选择 XML 后新增。</p>
            )}
            {!chosenWork &&
              works.map((w) => (
                <section
                  key={w.workKey}
                  className="flex items-center justify-between gap-3 rounded border border-boundary p-3"
                >
                  <div>
                    <strong>
                      {w.title}
                      {w.year ? `（${w.year}）` : ""}
                    </strong>
                    <p className="text-content-muted">
                      {w.kind === "movie"
                        ? "电影"
                        : `${w.seasonCount} 季 · ${w.episodeCount} 集`}
                    </p>
                    <p>
                      {w.pendingCount ?? 0} 集待检查 · {w.visibleCount ?? 0} 集播放器可见
                    </p>
                  </div>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const requestGeneration = ++generation.current;
                        const rows = await getLibraryEpisodes(w.workKey);
                        if (requestGeneration !== generation.current) return;
                        setReviewTarget(null);
                        setChosenWork(w);
                        setCloud(rows);
                      })
                    }
                  >
                    管理与更新
                  </Button>
                </section>
              ))}
            {cloud.map((row) => (
              <section
                key={row.episodeId}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-boundary p-3"
              >
                <div>
                  <p>
                    {row.canonicalMetadata.title} ·{" "}
                    {row.manifest.kind === "movie"
                      ? "电影"
                      : `S${row.manifest.season}E${row.manifest.episode}`}
                  </p>
                  <p className="text-xs text-content-muted">
                    {row.manifest.commentCount} 条 ·{" "}
                    {row.reviewStatus === "approved" ? "已确认成品" : "待检查"} ·{" "}
                    {row.isVisible ? "播放器可见" : "未上架"}
                  </p>
                </div>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setReviewApproved(row.reviewStatus !== "approved");
                    setReviewTarget(row);
                  }}
                >
                  {row.reviewStatus === "approved" ? "退回待检查" : "确认检查结果"}
                </Button>
                {row.reviewStatus !== "approved" && row.isVisible && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setReviewApproved(false);
                      setReviewTarget(row);
                    }}
                  >
                    暂不上架
                  </Button>
                )}
                <Button disabled={busy} onClick={() => void run(() => fetchHistory(row))}>
                  查看发布记录
                </Button>
                {onChooseProfile && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      onChooseProfile({
                        schemaVersion: 1,
                        ...row.canonicalMetadata,
                        season: row.manifest.season
                      })
                    }
                  >
                    用于本项目资料
                  </Button>
                )}
              </section>
            ))}
          </>
        )}
        <p role="status">{busy ? "正在读取与核验…" : message}</p>
      </div>
    </Dialog>
  );
}
