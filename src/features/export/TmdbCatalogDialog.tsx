import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import type { LibraryWork } from "../../application/libraryUpdate";
import { searchLibraryWorks } from "../../infrastructure/private-library/libraryBrowser";
import { privateLibraryError } from "../../infrastructure/private-library/privateLibrary";
import {
  getCatalogProfile,
  getTmdbWork,
  planCatalog,
  saveCatalog,
  searchTmdb,
  type CatalogChange,
  type CatalogPlan,
  type CatalogProfile,
  type TmdbCandidate,
  type TmdbWork
} from "../../infrastructure/private-library/tmdbCatalog";

export function TmdbCatalogDialog({
  existingWork,
  initialSeason = 1,
  onChoose,
  onClose
}: {
  existingWork?: LibraryWork;
  initialSeason?: number;
  onChoose: (work: LibraryWork, season: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(existingWork?.title ?? "");
  const [kind, setKind] = useState<"tv" | "movie">(existingWork?.kind ?? "tv");
  const [results, setResults] = useState<TmdbCandidate[]>([]);
  const [work, setWork] = useState<TmdbWork | null>(null);
  const [profile, setProfile] = useState<CatalogProfile | null>(null);
  const [season, setSeason] = useState(String(initialSeason));
  const [date, setDate] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [proposal, setProposal] = useState<{ data: CatalogChange; plan: CatalogPlan } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0),
    running = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    const id = ++generation.current,
      current = () => id === generation.current;
    try {
      await action(current);
    } catch (e) {
      if (current()) setMessage(privateLibraryError(e));
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  };
  const choose = async (candidate: TmdbCandidate, current: () => boolean) => {
    const { work: w } = await getTmdbWork(candidate.kind, candidate.id);
    const workKey = existingWork?.workKey ?? w.workKey;
    const { profile: p } = await getCatalogProfile(workKey);
    if (!current()) return;
    if (
      existingWork &&
      w.workKey !== `tmdb-${w.kind}-${w.id}` &&
      w.workKey !== existingWork.workKey
    )
      throw new Error("这部作品已关联到库中其他影视，请返回并选择已有影视。");
    setWork({ ...w, workKey });
    setProfile(p);
    setProposal(null);
    setCorrecting(false);
    const s =
      w.kind === "movie"
        ? 0
        : w.seasons.some((s) => s.number === initialSeason)
          ? initialSeason
          : (w.seasons.find((s) => s.number > 0)?.number ?? 0);
    setSeason(String(s));
  };
  const preview = async () => {
    if (!work) return;
    const data: CatalogChange = {
      workKey: work.workKey,
      selection: { provider: "tmdb", kind: work.kind, id: work.id },
      season: work.kind === "movie" ? 0 : Number(season),
      expectedVersion: profile?.version ?? null,
      ...(correcting
        ? {
            correction: {
              season: Number(season),
              airDate: date,
              sourceUrl: source.trim(),
              note: note.trim()
            }
          }
        : {})
    };
    if (
      correcting &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !source.startsWith("https://") ||
        note.trim().length < 8)
    )
      throw new Error("请填写发行日期、HTTPS 官方资料链接和至少 8 字的修正说明。");
    setProposal({ data, plan: await planCatalog(data) });
  };
  const save = async () => {
    if (!work || !proposal) return;
    const result = await saveCatalog({ ...proposal.data, expectedPlan: proposal.plan.planId });
    const found = await searchLibraryWorks(result.snapshot.titleZh || result.snapshot.titleEn);
    const current = found.find((w) => w.workKey === result.workKey);
    onChoose(
      {
        ...current,
        workKey: result.workKey,
        title: result.snapshot.titleZh || result.snapshot.titleEn,
        titleEn: result.snapshot.titleEn,
        kind: result.snapshot.kind,
        year: result.snapshot.workYear,
        episodeCount: current?.episodeCount ?? 0,
        seasonCount: current?.seasonCount ?? 0,
        tmdbId: result.snapshot.id,
        catalogVersion: result.version
      },
      proposal.data.season
    );
  };
  const savedSeason = profile?.seasons.find((s) => s.snapshot.season?.number === Number(season))
    ?.snapshot.season;
  const rawSeason = work?.seasons.find((s) => s.number === Number(season));
  return (
    <Dialog
      ariaLabel="影视资料与季年份"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="dialog-shell flex max-h-[90vh] w-full max-w-4xl flex-col"
    >
      <header className="flex items-center justify-between gap-3 border-b border-panel-line p-4">
        <div>
          <h2 className="text-lg font-semibold">影视资料与季年份</h2>
          <p className="text-sm text-content-muted">
            {existingWork
              ? `补全 ${existingWork.title} 的资料`
              : "从 TMDB 选择作品，再选择这一批弹幕所属的季"}
          </p>
        </div>
        <Button disabled={busy} onClick={onClose}>
          返回
        </Button>
      </header>
      <div className="thin-scrollbar grid min-h-0 gap-4 overflow-y-auto p-4 text-sm">
        {!proposal ? (
          <fieldset disabled={busy} className="grid min-w-0 gap-4">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async (current) => {
                  const r = await searchTmdb(kind, query.trim());
                  if (current()) {
                    setResults(r.results);
                    setMessage(
                      r.results.length
                        ? r.hasMore
                          ? "结果较多，请补充片名缩小范围。"
                          : "可用中文、英文名或部分片名搜索。"
                        : "没有找到作品，请换一个片名或别名。"
                    );
                  }
                });
              }}
            >
              <label className="grid gap-1">
                类型
                <select
                  aria-label="搜索影视类型"
                  value={kind}
                  disabled={!!existingWork}
                  onChange={(e) => {
                    setKind(e.target.value as "tv" | "movie");
                    setResults([]);
                  }}
                >
                  <option value="tv">剧集</option>
                  <option value="movie">电影</option>
                </select>
              </label>
              <Field
                label="中文或英文片名"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button type="submit">搜索 TMDB</Button>
            </form>
            <div className="grid gap-2">
              {results.map((r) => (
                <Button
                  key={r.id}
                  aria-pressed={work?.id === r.id}
                  className="h-auto justify-start whitespace-normal text-left"
                  onClick={() => void run((current) => choose(r, current))}
                >
                  <span>
                    <strong>{r.titleZh || r.titleEn || r.originalTitle}</strong>
                    <span className="ml-2 text-content-muted">
                      {r.titleEn} · {r.workYear ?? "首播年未知"}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            {work && (
              <section className="grid gap-3 rounded border border-boundary p-4">
                <h3 className="font-semibold">
                  {work.titleZh || work.titleEn} / {work.titleEn || work.originalTitle}
                </h3>
                <p className="text-content-muted">
                  作品首播年：{work.workYear ?? "未知"}。每一季单独使用本季日期。
                </p>
                {work.kind === "tv" ? (
                  <>
                    <label className="grid gap-1">
                      本次更新的季
                      <select
                        aria-label="本次更新的季"
                        value={season}
                        onChange={(e) => {
                          setSeason(e.target.value);
                          setCorrecting(false);
                        }}
                      >
                        {work.seasons.map((s) => (
                          <option key={s.number} value={s.number}>
                            {s.number === 0 ? "特别篇" : `第 ${s.number} 季`} ·{" "}
                            {s.year ?? "日期未知"} · {s.episodeCount} 集
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>
                      本季已保存日期：{savedSeason?.airDate ?? "尚未保存"} · TMDB 日期：
                      {rawSeason?.airDate ?? "未知"}
                    </p>
                    {savedSeason?.dateEvidence && (
                      <p className="text-content-muted">
                        已保存发行资料修正：{savedSeason.dateEvidence.note}
                      </p>
                    )}
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={correcting}
                        onChange={(e) => setCorrecting(e.target.checked)}
                      />
                      以有出处的发行日期修正本季
                    </label>
                    {correcting && (
                      <div className="grid gap-3">
                        <Field
                          label="本季发行日期"
                          type="date"
                          value={date}
                          onChange={(e) => setDate(e.target.value)}
                        />
                        <Field
                          label="官方发行资料链接"
                          value={source}
                          onChange={(e) => setSource(e.target.value)}
                        />
                        <Field
                          label="修正说明"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                        <p className="text-content-muted">
                          保留 TMDB 原始日期和出处；其他季的日期保持原值。
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <p>电影上映年：{work.workYear ?? "未知"} · 使用一份完整弹幕。</p>
                )}
                <Button tone="primary" onClick={() => void run(preview)}>
                  预览资料变化
                </Button>
              </section>
            )}
          </fieldset>
        ) : (
          <section className="grid gap-4">
            <h3 className="font-semibold">
              {proposal.plan.snapshot.titleZh} / {proposal.plan.snapshot.titleEn}
            </h3>
            <p>
              {proposal.data.selection.kind === "tv" ? `第 ${proposal.data.season} 季` : "电影"}
              ：
              {proposal.plan.previous?.season?.airDate ??
                proposal.plan.previous?.workDate ??
                "未关联"}{" "}
              →{" "}
              {proposal.plan.snapshot.season?.airDate ??
                proposal.plan.snapshot.workDate ??
                "未知"}
            </p>
            <p>
              这份季资料适用于已有 {proposal.plan.affectedEpisodes}{" "}
              集和随后新增的分集。弹幕内容、原有集号、成品确认与播放器地址保留。
            </p>
            <div className="flex flex-wrap gap-2">
              {proposal.plan.episodes.map((e) => (
                <span key={e.number} className="rounded border border-boundary px-2 py-1">
                  {e.number} · {e.titleZh || e.titleEn}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" disabled={busy} onClick={() => void run(save)}>
                保存资料并使用这一季
              </Button>
              <Button disabled={busy} onClick={() => setProposal(null)}>
                返回调整
              </Button>
            </div>
          </section>
        )}
        {busy && <p role="status">正在读取或保存影视资料…</p>}
        {message && (
          <p role="status" className="break-words">
            {message}
          </p>
        )}
        <details className="text-xs text-content-muted">
          <summary>关于影视资料</summary>
          <div className="mt-2 grid gap-2">
            <img src="/tmdb-logo.svg" width="86" alt="TMDB" />
            <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
            <p>TMDB 提供中英文、别名和部分片名查询；未知日期留空。凭据仅由私人服务端保存。</p>
          </div>
        </details>
      </div>
    </Dialog>
  );
}
