import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import type { PublicationDelivery } from "../../domain/publication/types";
import {
  inferLibraryEpisode,
  newLibraryWork,
  normalizedLibraryTitle,
  planLibraryUpdate,
  recoverUpdateDraft,
  type LibraryWork,
  type UpdateDraft,
  type UpdateMode
} from "../../application/libraryUpdate";
import {
  searchLibraryWorks,
  getLibraryEpisodes,
  reviewLibraryEpisode
} from "../../infrastructure/private-library/libraryBrowser";
import { getCatalogProfile } from "../../infrastructure/private-library/tmdbCatalog";
import {
  persistDelivery,
  loadDelivery,
  savePublicationDraft
} from "../../infrastructure/private-library/publicationOutbox";
import {
  preparePrivateLibraryPublication,
  publishPrivateLibraryXml,
  privateLibraryError
} from "../../infrastructure/private-library/privateLibrary";
const TmdbCatalogDialog = lazy(() =>
  import("./TmdbCatalogDialog").then((m) => ({ default: m.TmdbCatalogDialog }))
);
const LegacyPublicationDialog = lazy(() =>
  import("./LegacyPublicationDialog").then((m) => ({ default: m.LegacyPublicationDialog }))
);

export function PrivateLibraryPublishDialog({
  delivery,
  onClose,
  initialWork
}: {
  delivery: PublicationDelivery;
  onClose: () => void;
  initialWork?: LibraryWork;
}) {
  const [catalog, setCatalog] = useState(false);
  const [work, setWork] = useState<LibraryWork | null>(initialWork ?? null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibraryWork[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState(delivery.libraryProfile?.title ?? "");
  const [kind, setKind] = useState<"tv" | "movie">("tv");
  const [year, setYear] = useState("");
  const inferred = delivery.files.map((f) => inferLibraryEpisode(f.fileName));
  const [season, setSeason] = useState(
    String(
      initialWork?.kind === "movie"
        ? 0
        : (inferred.find((n) => n.season !== null)?.season ??
            delivery.libraryProfile?.season ??
            1)
    )
  );
  const [numbers, setNumbers] = useState(() =>
    inferred.map((n) => (initialWork?.kind === "movie" ? "1" : (n.episode?.toString() ?? "")))
  );
  const [mode, setMode] = useState<UpdateMode>("replace");
  const [plan, setPlan] = useState<UpdateDraft | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [legacy, setLegacy] = useState(false);
  const [hasLegacy, setHasLegacy] = useState(false);
  const [effectiveDelivery, setEffectiveDelivery] = useState(delivery);
  const request = useRef(0),
    running = useRef(false),
    stop = useRef(false);
  useEffect(() => {
    let active = true;
    const requestRef = request;
    void (async () => {
      const summary = await persistDelivery(effectiveDelivery),
        record = await loadDelivery(summary.key);
      if (!active) return;
      const saved = recoverUpdateDraft(record.draft, effectiveDelivery.files.length);
      setKey(summary.key);
      if (saved) {
        setPlan(saved);
        setWork(saved.work);
        setSeason(String(saved.season));
        setMode(saved.mode);
        setNumbers(saved.rows.map((r) => String(r.episode)));
        setMessage("已恢复上次更新清单，可继续；不会自动接受云端后来的修改。");
      } else if (record.draft) {
        setHasLegacy(true);
        setMessage(
          "此批成品有旧版发布草稿。可以查看旧记录，或用新流程重新选择影视；旧草稿会保留。"
        );
      }
    })().catch((e) => {
      if (active) setMessage(privateLibraryError(e));
    });
    return () => {
      active = false;
      requestRef.current++;
    };
  }, [effectiveDelivery]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(privateLibraryError(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const search = async () => {
    const generation = ++request.current;
    const found = await searchLibraryWorks(query.trim());
    if (generation === request.current) setResults(found);
  };
  const choose = (value: LibraryWork) => {
    setWork(value);
    setCreating(false);
    setPlan(null);
    if (value.kind === "movie") {
      setSeason("0");
      setNumbers(effectiveDelivery.files.map(() => "1"));
    }
  };
  const preview = async () => {
    let target = work;
    if (creating) {
      if (!title.trim()) throw new Error("请填写正式片名。");
      if (year && (!/^\d{4}$/.test(year) || Number(year) < 1880 || Number(year) > 2200))
        throw new Error("年份可留空，或填写有效的四位年份。");
      const matches = await searchLibraryWorks(title.trim());
      const existing = matches.filter(
        (w) =>
          normalizedLibraryTitle(w.title) === normalizedLibraryTitle(title) &&
          w.kind === kind &&
          (!year || w.year === null || w.year === Number(year))
      );
      if (existing.length) {
        setResults(existing);
        setCreating(false);
        setWork(null);
        throw new Error("库里已有这部影视，请直接选择下方结果更新。");
      }
      target = newLibraryWork(title, kind, year ? Number(year) : null);
    }
    if (!target) throw new Error("先选择库中已有影视，或明确新增影视。");
    if (target.tmdbId) {
      const { profile } = await getCatalogProfile(target.workKey);
      const selected = profile?.seasons.find((s) =>
        target.kind === "movie"
          ? s.snapshot.season === null
          : s.snapshot.season?.number === Number(season)
      );
      if (!selected)
        throw new Error("请打开“影视资料与季年份”，选择并保存这一季，再预览上传。");
      if (numbers.some((n) => !selected.episodes.some((e) => e.number === Number(n))))
        throw new Error("文件集号不属于这一季的目录，请核对集数。");
    }
    const cloud = creating ? [] : await getLibraryEpisodes(target.workKey);
    const rows = planLibraryUpdate(
      effectiveDelivery,
      target,
      cloud,
      target.kind === "movie" ? 0 : Number(season),
      mode,
      numbers
    );
    for (const row of rows) {
      if (row.action === "skip" || row.action === "unchanged") continue;
      row.baseline = await preparePrivateLibraryPublication(row.metadata);
      if (row.baseline.expectedRevision !== row.expectedRevision)
        throw new Error("读取过程中云端有更新，请重新预览；本次尚未上传。");
    }
    const next: UpdateDraft = {
      schemaVersion: 1,
      workflow: "library-update-v2",
      work: target,
      season: target.kind === "movie" ? 0 : Number(season),
      mode,
      rows
    };
    let recordKey = key;
    if (hasLegacy) {
      const fresh = { ...effectiveDelivery, createdAt: new Date().toISOString() };
      const summary = await persistDelivery(fresh);
      recordKey = summary.key;
      setKey(recordKey);
      setHasLegacy(false);
      setEffectiveDelivery(fresh);
    }
    if (!recordKey) throw new Error("成品尚未保存到本机，请稍后重试。");
    await savePublicationDraft(recordKey, next);
    setWork(target);
    setPlan(next);
    setConfirmed(false);
    setMessage("请核对下面的逐集变化，确认后才会上传。未选中的其他集保留。");
  };
  const publish = async () => {
    if (!plan || !key || !confirmed) return;
    stop.current = false;
    const current: UpdateDraft = structuredClone(plan);
    const save = async () => {
      await savePublicationDraft(key, current);
      setPlan(structuredClone(current));
    };
    await save();
    for (const row of current.rows) {
      if (stop.current) break;
      if (row.action === "skip" || row.reviewed) continue;
      try {
        row.message = "正在更新并校验…";
        await save();
        if (!row.receipt && row.action !== "unchanged") {
          if (!row.baseline) throw new Error("这份清单缺少更新检查，请重新预览。");
          const result = await publishPrivateLibraryXml(
            effectiveDelivery.files[row.index].content,
            row.metadata,
            row.baseline
          );
          row.receipt = result;
          row.message = `已更新 · ${result.commentCount} 条弹幕`;
          // All later rows in the same shared metadata scope use our own successful result.
          if (result.metadataVersion != null)
            for (const sibling of current.rows) {
              if (
                sibling.metadata.editionKey === row.metadata.editionKey &&
                sibling.metadata.sourceKey === row.metadata.sourceKey
              )
                sibling.metadata.expectedMetadataVersion = result.metadataVersion;
            }
          await save();
        }
        const episodeId = row.receipt?.episodeId ?? row.existingEpisodeId;
        const revision = row.receipt?.revision ?? row.expectedRevision;
        if (!episodeId || !revision) throw new Error("缺少待检查修订，请重新预览。");
        await reviewLibraryEpisode(episodeId, revision, true);
        row.reviewed = true;
        row.message = "已确认成品并上架";
        await save();
      } catch (e) {
        row.message = `未完成：${privateLibraryError(e)}`;
        await save();
        throw e;
      }
    }
    const left = current.rows.filter((r) => r.action !== "skip" && !r.reviewed).length;
    setMessage(
      left
        ? `已停止，剩余 ${left} 集可继续。已成功的集保留。`
        : `更新完成。播放器地址不变，重新搜索“${current.work.title}”即可加载当前弹幕。`
    );
  };
  if (catalog)
    return (
      <Suspense fallback={<p role="status">正在打开影视资料…</p>}>
        <TmdbCatalogDialog
          existingWork={work ?? undefined}
          initialSeason={Number(season)}
          onClose={() => setCatalog(false)}
          onChoose={(w, s) => {
            choose(w);
            setSeason(String(s));
            setCatalog(false);
          }}
        />
      </Suspense>
    );
  if (legacy)
    return (
      <Suspense fallback={<p role="status">正在读取旧记录…</p>}>
        <LegacyPublicationDialog delivery={delivery} onClose={() => setLegacy(false)} />
      </Suspense>
    );
  const counts = plan?.rows.reduce((a, r) => ({ ...a, [r.action]: a[r.action] + 1 }), {
    create: 0,
    replace: 0,
    unchanged: 0,
    skip: 0
  });
  const canSubmit = plan?.rows.some((r) => r.action !== "skip" && !r.reviewed);
  return (
    <Dialog
      ariaLabel="更新私人弹幕库"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="dialog-shell flex max-h-[90vh] w-full max-w-4xl flex-col"
    >
      <header className="flex items-center justify-between border-b border-panel-line p-4">
        <h2 className="text-lg font-semibold">更新私人弹幕库</h2>
        <Button disabled={busy} onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="thin-scrollbar grid min-h-0 gap-4 overflow-y-auto p-4 text-sm">
        <p>
          {effectiveDelivery.files.length} 个 XML ·
          目录和文件名不能证明已修整。每集只使用一份当前成品，恢复资料保留在本机／OneDrive。
        </p>
        {!plan ? (
          <fieldset disabled={busy || !key} className="grid gap-4">
            <h3 className="font-semibold">1. 选择影视</h3>
            {work ? (
              <div className="flex items-center justify-between gap-2 rounded border border-boundary p-3">
                <strong>
                  {work.title} · {work.kind === "movie" ? "电影" : "剧集"}
                </strong>
                <Button onClick={() => setCatalog(true)}>影视资料与季年份</Button>
                <Button
                  onClick={() => {
                    setWork(null);
                    setCreating(false);
                  }}
                >
                  重新选择
                </Button>
              </div>
            ) : (
              <>
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(search);
                  }}
                >
                  <Field
                    label="搜索已有影视"
                    placeholder="输入正式片名"
                    value={query}
                    onChange={(e) => {
                      request.current++;
                      setQuery(e.target.value);
                      setResults([]);
                    }}
                  />
                  <Button type="submit">搜索</Button>
                </form>
                {results.map((w) => (
                  <div
                    key={w.workKey}
                    className="flex items-center justify-between gap-2 rounded border border-boundary p-3"
                  >
                    <span>
                      {w.title}
                      {w.year ? `（${w.year}）` : ""} · {w.episodeCount} 集
                    </span>
                    <Button onClick={() => choose(w)}>
                      更新这部{w.kind === "movie" ? "电影" : "剧集"}
                    </Button>
                  </div>
                ))}
                <Button tone="primary" onClick={() => setCatalog(true)}>
                  通过 TMDB 选择新影视
                </Button>
                <Button
                  onClick={() => {
                    setCreating((v) => !v);
                    setTitle(query || title);
                  }}
                >
                  库里没有，新增影视
                </Button>
                {creating && (
                  <div className="grid gap-3 rounded border border-boundary p-3">
                    <Field
                      label="正式片名"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    <label>
                      类型{" "}
                      <select
                        aria-label="影视类型"
                        value={kind}
                        onChange={(e) => {
                          setKind(e.target.value as "tv" | "movie");
                          if (e.target.value === "movie")
                            setNumbers(effectiveDelivery.files.map(() => "1"));
                        }}
                      >
                        <option value="tv">剧集</option>
                        <option value="movie">电影</option>
                      </select>
                    </label>
                    <Field
                      label="上映年份（可选，用于区分同名作品）"
                      value={year}
                      onChange={(e) => setYear(e.target.value)}
                    />
                  </div>
                )}
              </>
            )}
            {(work || creating) && (
              <>
                <h3 className="font-semibold">2. 核对集数与更新方式</h3>
                {(work?.kind ?? kind) === "tv" && (
                  <Field
                    label="更新第几季"
                    type="number"
                    min={1}
                    max={999}
                    value={season}
                    onChange={(e) => setSeason(e.target.value)}
                  />
                )}
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="update-mode"
                    checked={mode === "replace"}
                    onChange={() => setMode("replace")}
                  />
                  <span>
                    <strong>更新并补全（默认）</strong>
                    <br />
                    替换所选已有集，新增缺集；其他集保留。
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="update-mode"
                    checked={mode === "append"}
                    onChange={() => setMode("append")}
                  />
                  <span>
                    <strong>只补充缺集</strong>
                    <br />
                    已有集全部跳过，不合并或重复追加弹幕。
                  </span>
                </label>
                <div className="grid gap-2">
                  {effectiveDelivery.files.map((f, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3"
                    >
                      <span className="break-all">{f.fileName}</span>
                      <Field
                        label={`文件 ${i + 1} 的集数`}
                        type="number"
                        min={1}
                        value={numbers[i]}
                        onChange={(e) =>
                          setNumbers((v) => v.map((n, j) => (i === j ? e.target.value : n)))
                        }
                      />
                    </div>
                  ))}
                </div>
                {numbers.some((n) => !n) && (
                  <Button
                    onClick={() =>
                      setNumbers(effectiveDelivery.files.map((_, i) => String(i + 1)))
                    }
                  >
                    确认按当前列表从第 1 集编号
                  </Button>
                )}
              </>
            )}
          </fieldset>
        ) : (
          <>
            <h3 className="font-semibold">
              {plan.work.title} · {plan.work.kind === "movie" ? "电影" : `第 ${plan.season} 季`}
            </h3>
            <p>
              新增 {counts!.create} 集 · 替换 {counts!.replace} 集 · 内容相同{" "}
              {counts!.unchanged} 集 · 跳过 {counts!.skip} 集
            </p>
            {plan.rows.map((r) => (
              <div key={r.index} className="grid gap-1 rounded border border-boundary p-3">
                <strong>
                  第 {r.episode} 集 ·{" "}
                  {
                    {
                      create: "新增",
                      replace: "替换已有弹幕",
                      unchanged: "内容相同，核对上架状态",
                      skip: "已有弹幕，跳过"
                    }[r.action]
                  }
                </strong>
                <span className="break-all text-content-muted">
                  {effectiveDelivery.files[r.index].fileName}
                  {r.oldCount !== null ? ` · 云端原有 ${r.oldCount} 条` : ""}
                </span>
                {r.message && <p>{r.message}</p>}
              </div>
            ))}
            <Button
              disabled={busy}
              onClick={() => {
                setPlan(null);
                setCreating(false);
                setMessage("重新预览会读取云端最新状态，请核对后再次确认。");
              }}
            >
              重新选择或预览
            </Button>
          </>
        )}
        {plan && canSubmit && (
          <p className="text-content-muted">
            本地 XML 保持原样。云端只保存当前弹幕的压缩播放器数据；旧成品请在本地保留。
          </p>
        )}
        {plan && canSubmit && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              我已检查这些 XML 是完整、修整后的成品，并核对了影视和季集。确认后上架到播放器。
            </span>
          </label>
        )}
        {hasLegacy && (
          <Button disabled={busy} onClick={() => setLegacy(true)}>
            查看旧版发布草稿
          </Button>
        )}
        <p role="status">{message}</p>
      </div>
      <footer className="flex gap-2 border-t border-panel-line p-4">
        {!plan ? (
          <Button
            tone="primary"
            disabled={busy || !key || (!work && !creating)}
            onClick={() => void run(preview)}
          >
            {busy ? "正在核对…" : "预览更新"}
          </Button>
        ) : (
          <Button
            tone="primary"
            disabled={busy || !canSubmit || !confirmed}
            onClick={() => void run(publish)}
          >
            {busy ? "正在更新…" : "确认更新并上架"}
          </Button>
        )}
        {busy && plan && (
          <Button
            onClick={() => {
              stop.current = true;
            }}
          >
            当前集完成后停止
          </Button>
        )}
      </footer>
    </Dialog>
  );
}
