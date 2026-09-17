import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  loadDelivery,
  persistDelivery,
  savePublicationDraft
} from "../../infrastructure/private-library/publicationOutbox";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import type { PublicationDelivery } from "../../application/publicationDelivery";
import { sha256Hex } from "../../domain/shared/sha256";
import {
  publishPrivateLibraryXml,
  privateLibraryError,
  getPrivateLibraryMetadata,
  preparePrivateLibraryPublication,
  type PublicationMetadata,
  type PublicationResult,
  type PublicationBaseline
} from "../../infrastructure/private-library/privateLibrary";
import { PrivateLibraryConnectionPanel } from "./PrivateLibraryConnectionPanel";
import {
  explicitSeasonEpisode,
  hasVideoMatchingEvidence,
  publicationConflict
} from "../../domain/publication/publicationGuards";

interface SavedDetails {
  workKey: string;
  editionKey: string;
  title: string;
  edition: string;
  aliases: string;
  year: string;
  kind: "tv" | "movie";
  season: string;
  sourceKey?: string;
  sourceLabel?: string;
  metadataVersion?: number | null;
}
interface PublishRow {
  selected: boolean;
  episode: string;
  fileName: string;
  auto: boolean;
  message: string;
  inputHash?: string;
  receipt?: PublicationResult;
  baseline?: PublicationBaseline;
}
interface Draft {
  schemaVersion: 1;
  details: SavedDetails;
  rows: PublishRow[];
}
function rowMetadata(
  details: SavedDetails,
  row: PublishRow,
  file: PublicationDelivery["files"][number]
): PublicationMetadata {
  return {
    workKey: details.workKey,
    editionKey: details.editionKey,
    sourceKey: details.sourceKey,
    sourceLabel: details.sourceLabel,
    expectedMetadataVersion: details.metadataVersion ?? null,
    title: details.title.trim(),
    aliases: details.aliases
      .split(/[,，]/)
      .map((v) => v.trim())
      .filter(Boolean),
    year: details.year ? Number(details.year) : null,
    kind: details.kind,
    edition: details.edition.trim(),
    season: details.kind === "movie" ? 0 : Number(details.season),
    episode: Number(row.episode),
    label: details.kind === "movie" ? details.title.trim() : `第 ${Number(row.episode)} 集`,
    durationMs: hasVideoMatchingEvidence(file) ? (file.durationMs ?? null) : null,
    fileNames:
      hasVideoMatchingEvidence(file) && row.fileName.trim() ? [row.fileName.trim()] : [],
    allowAutoMatch: row.auto && Boolean(row.fileName.trim()) && hasVideoMatchingEvidence(file)
  };
}
function parseDraft(value: unknown, count: number): Draft | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Partial<Draft>;
  if (d.schemaVersion !== 1 || !d.details || !Array.isArray(d.rows) || d.rows.length !== count)
    return null;
  if (
    ![
      d.details.workKey,
      d.details.editionKey,
      d.details.title,
      d.details.edition,
      d.details.aliases,
      d.details.year,
      d.details.season
    ].every((v) => typeof v === "string")
  )
    return null;
  if (d.details.kind !== "movie" && d.details.kind !== "tv") return null;
  if (
    !d.rows.every(
      (r) =>
        r &&
        typeof r.selected === "boolean" &&
        typeof r.auto === "boolean" &&
        [r.episode, r.fileName, r.message].every((v) => typeof v === "string")
    )
  )
    return null;
  return d as Draft;
}
function initialDetails(delivery: PublicationDelivery): SavedDetails {
  const profile = delivery.libraryProfile;
  if (profile)
    return {
      workKey: profile.workKey,
      editionKey: profile.editionKey,
      sourceKey: profile.sourceKey,
      title: profile.title,
      aliases: profile.aliases.join("，"),
      edition: profile.edition,
      year: profile.year?.toString() ?? "",
      kind: profile.kind ?? "tv",
      season: profile.season?.toString() ?? "",
      sourceLabel: profile.sourceLabel,
      metadataVersion: null
    };
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`danmaku.privateLibrary.details.v1.${delivery.projectId}`) ?? "null"
    );
    if (value && typeof value === "object" && "title" in value && "workKey" in value) {
      const v = value as Partial<SavedDetails>;
      if (
        [v.workKey, v.editionKey, v.title, v.edition, v.aliases, v.year, v.season].every(
          (x) => typeof x === "string"
        ) &&
        (v.kind === "tv" || v.kind === "movie")
      )
        return v as SavedDetails;
    }
  } catch {
    /* A broken preference never blocks export. */
  }
  return {
    workKey: "",
    editionKey: "",
    title: delivery.projectName,
    edition: "",
    aliases: "",
    year: "",
    kind: "tv",
    season: "1",
    sourceKey: `studio-${sha256Hex(delivery.projectId).slice(0, 24)}`,
    sourceLabel: "个人整理",
    metadataVersion: null
  };
}
export function LegacyPublicationDialog({
  delivery,
  onClose
}: {
  delivery: PublicationDelivery;
  onClose: () => void;
}) {
  const [details, setDetails] = useState(() => initialDetails(delivery));
  const [rows, setRows] = useState<PublishRow[]>(() =>
    delivery.files.map((file) => ({
      selected: true,
      episode: /S\d{1,3}E(\d{1,4})/i.exec(file.fileName)?.[1] ?? "",
      fileName: file.targetFileName ?? "",
      auto: false,
      message: ""
    }))
  );
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(!isTauri());
  const [recordKey, setRecordKey] = useState<string | null>(null);
  const [storageMessage, setStorageMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [baselineProposal, setBaselineProposal] = useState<{
    index: number;
    baseline: PublicationBaseline;
  } | null>(null);
  const running = useRef(false);
  const stopRequested = useRef(false);
  const draft = useRef<Draft>({ schemaVersion: 1, details, rows });
  const updateDetails = (next: SavedDetails) => {
    draft.current.details = next;
    setDetails(next);
  };
  const updateRows = (next: PublishRow[]) => {
    draft.current.rows = next;
    setRows(next);
  };
  const change = (patch: Partial<SavedDetails>) =>
    updateDetails({ ...draft.current.details, ...patch });
  const rowChange = (index: number, patch: Partial<PublishRow>) =>
    updateRows(draft.current.rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const flush = async () => {
    if (recordKey) {
      await savePublicationDraft(recordKey, { ...draft.current });
      setStorageMessage("发布草稿已保存。");
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void (async () => {
      const summary = await persistDelivery(delivery);
      const record = await loadDelivery(summary.key);
      const recovered = parseDraft(record.draft, delivery.files.length);
      const nextDetails = recovered?.details ?? initialDetails(delivery);
      const shouldReadCloud =
        !recovered && Boolean(nextDetails.workKey && nextDetails.editionKey);
      if (shouldReadCloud) nextDetails.metadataVersion = undefined;
      if (!active) return;
      draft.current.details = nextDetails;
      setDetails(nextDetails);
      if (recovered) {
        const nextRows = recovered.rows.map((r) => ({
          ...r,
          message: r.message.startsWith("正在") ? "上次发布中断，可继续。" : r.message
        }));
        draft.current.rows = nextRows;
        setRows(nextRows);
      }
      setRecordKey(summary.key);
      setReady(true);
      setStorageMessage("成品和发布草稿可在重启后恢复。");
      if (shouldReadCloud) {
        const cloud = await getPrivateLibraryMetadata({
          workKey: nextDetails.workKey,
          editionKey: nextDetails.editionKey,
          sourceKey: nextDetails.sourceKey,
          season: Number(nextDetails.season) || 0,
          episode: 1
        });
        const m = cloud?.canonicalMetadata;
        const cloudDetails = {
          ...nextDetails,
          ...(m && !delivery.libraryProfile
            ? {
                title: m.title,
                aliases: m.aliases.join("，"),
                year: m.year?.toString() ?? "",
                kind: m.kind,
                edition: m.edition,
                sourceLabel: m.sourceLabel
              }
            : {}),
          metadataVersion: cloud?.metadataVersion ?? null
        };
        if (active && draft.current.details === nextDetails) {
          draft.current.details = cloudDetails;
          setDetails(cloudDetails);
        }
      }
    })().catch((e: unknown) => {
      if (active)
        setStorageMessage(
          `读取未完成：${privateLibraryError(e)} 可保留草稿，连接恢复后点击“载入云端最新作品信息”。`
        );
    });
    return () => {
      active = false;
    };
  }, [delivery]);
  useEffect(() => {
    if (!ready || !recordKey || busy) return;
    const saved = { schemaVersion: 1, details, rows };
    const timer = setTimeout(() => {
      void savePublicationDraft(recordKey, saved)
        .then(() => setStorageMessage("发布草稿已保存。"))
        .catch((e: unknown) => setStorageMessage(`草稿未保存：${privateLibraryError(e)}`));
    }, 400);
    return () => clearTimeout(timer);
  }, [details, rows, recordKey, ready, busy]);
  const close = async () => {
    if (busy) return;
    try {
      await flush();
      onClose();
    } catch (e) {
      setStorageMessage(`草稿未保存：${privateLibraryError(e)}`);
    }
  };
  const publish = async () => {
    if (running.current || !ready) return;
    const conflict = publicationConflict(delivery, details, rows);
    if (conflict) {
      setMessage(conflict);
      return;
    }
    if (isTauri() && details.metadataVersion === undefined) {
      setMessage("请先载入云端最新作品信息并核对，再发布。离线时仍可保存草稿。");
      return;
    }
    const selected = rows.map((row, index) => ({ row, index })).filter((v) => v.row.selected);
    const season = details.kind === "movie" ? 0 : Number(details.season);
    if (
      !details.title.trim() ||
      !details.edition.trim() ||
      (details.kind === "tv" && !/^\d+$/.test(details.season)) ||
      !selected.length ||
      !Number.isInteger(season) ||
      season < 0 ||
      season > 999 ||
      (details.year &&
        (!/^\d{4}$/.test(details.year) ||
          Number(details.year) < 1880 ||
          Number(details.year) > 2200))
    ) {
      setMessage("请填写作品名称、观看版本和有效季数；年份可留空。");
      return;
    }
    if (
      selected.some(
        ({ row }) =>
          !/^\d+$/.test(row.episode) || Number(row.episode) < 1 || Number(row.episode) > 9999
      ) ||
      new Set(selected.map(({ row }) => Number(row.episode))).size !== selected.length ||
      (details.kind === "movie" &&
        (selected.length !== 1 || Number(selected[0].row.episode) !== 1))
    ) {
      setMessage("请确认每个文件的集数，不能重复；电影只发布一个文件，集数填 1。");
      return;
    }
    const identity = {
      ...details,
      workKey:
        details.workKey ||
        sha256Hex(`${details.kind}:${details.title.trim().normalize("NFKC")}:${details.year}`),
      editionKey: details.editionKey || sha256Hex(details.edition.trim().normalize("NFKC"))
    };
    updateDetails(identity);
    try {
      localStorage.setItem(
        `danmaku.privateLibrary.details.v1.${delivery.projectId}`,
        JSON.stringify(identity)
      );
    } catch {
      /* Cloud publishing remains available when preference storage is full. */
    }
    running.current = true;
    stopRequested.current = false;
    setBusy(true);
    setMessage("");
    let completed = 0;
    try {
      await flush();
      for (const { row, index } of selected) {
        if (stopRequested.current) break;
        rowChange(index, { message: "正在校验、上传并回读…" });
        const file = delivery.files[index];
        const metadata = rowMetadata(identity, row, file);
        const { expectedMetadataVersion: _version, ...contentMetadata } = metadata;
        void _version;
        const inputHash = sha256Hex(JSON.stringify([contentMetadata, file.content]));
        try {
          const baseline =
            row.baseline ??
            (isTauri() ? await preparePrivateLibraryPublication(metadata) : undefined);
          if (baseline) rowChange(index, { baseline });
          await flush();
          const result = baseline
            ? await publishPrivateLibraryXml(file.content, metadata, baseline)
            : await publishPrivateLibraryXml(file.content, metadata);
          completed++;
          identity.metadataVersion = result.metadataVersion ?? identity.metadataVersion;
          updateDetails({ ...identity });
          try {
            localStorage.setItem(
              `danmaku.privateLibrary.details.v1.${delivery.projectId}`,
              JSON.stringify(identity)
            );
          } catch {
            /* Native batch remains the durable source. */
          }
          rowChange(index, {
            message: `已上传并核验 · ${result.commentCount} 条 · 分集 ${result.episodeId}`,
            inputHash,
            receipt: result,
            baseline: baseline ? { ...baseline, expectedRevision: result.revision } : undefined
          });
          await flush();
        } catch (e) {
          rowChange(index, { message: `未完成：${privateLibraryError(e)}` });
          await flush();
          throw e;
        }
      }
      setMessage(
        stopRequested.current
          ? `已停止后续发布，本次已完成 ${completed} 集。`
          : `本次 ${completed} 集已上传并完成云端回读；请在私人库管理中检查当前修订，确认成品后上架。`
      );
    } catch (e) {
      setMessage(
        `本次已完成 ${completed} 集，其余未完成。${privateLibraryError(e)} 已完成的集可安全重复发布。`
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      ariaLabel="发布到私人弹幕库"
      onClose={() => {
        if (!busy) void close();
      }}
      className="dialog-shell flex max-h-[90vh] w-full max-w-3xl flex-col"
    >
      <header className="flex items-center justify-between border-b border-panel-line p-4">
        <h2 className="text-lg font-semibold">旧版发布草稿</h2>
        <Button disabled={busy} onClick={() => void close()}>
          关闭
        </Button>
      </header>
      <div className="thin-scrollbar grid min-h-0 gap-4 overflow-y-auto p-4 text-sm">
        <p>此入口用于恢复旧草稿。新上传内容先处于待检查；日常请使用选择已有影视的更新流程。</p>
        <p>
          发布 {new Date(delivery.createdAt).toLocaleString()} 准备的 {delivery.files.length}{" "}
          个成品快照。若之后修改了弹幕，请先重新导出。
        </p>
        <p role="status">{storageMessage}</p>
        {publicationConflict(delivery, details, rows) && (
          <p role="alert" className="text-feedback-warning">
            {publicationConflict(delivery, details, rows)}
          </p>
        )}
        <details>
          <summary>连接设置与播放器地址</summary>
          <fieldset disabled={busy} className="pt-3">
            <PrivateLibraryConnectionPanel />
          </fieldset>
        </details>
        <fieldset disabled={busy || !ready} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="作品名称"
              value={details.title}
              onChange={(e) => change({ title: e.target.value })}
            />
            <Field
              label="别名（用逗号分隔）"
              value={details.aliases}
              onChange={(e) => change({ aliases: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              类型
              <select
                aria-label="类型"
                className="mt-1 w-full rounded border border-boundary bg-surface-base p-2"
                value={details.kind}
                onChange={(e) => change({ kind: e.target.value as "tv" | "movie" })}
              >
                <option value="tv">剧集</option>
                <option value="movie">电影</option>
              </select>
            </label>
            <Field
              label="年份（可选）"
              value={details.year}
              onChange={(e) => change({ year: e.target.value })}
            />
            <Field
              label="季"
              type="number"
              min={0}
              max={999}
              value={details.season}
              disabled={details.kind === "movie"}
              onChange={(e) => change({ season: e.target.value })}
            />
          </div>
          <Field
            label="观看版本"
            placeholder="如：WEB 版、蓝光版；请与观看的原片对应"
            value={details.edition}
            onChange={(e) => change({ edition: e.target.value })}
          />
          <Field
            label="弹幕来源"
            value={details.sourceLabel ?? "历史整理"}
            onChange={(e) => change({ sourceLabel: e.target.value })}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                updateRows(rows.map((r, index) => ({ ...r, episode: String(index + 1) })))
              }
            >
              按列表顺序填入集数
            </Button>
            <Button
              onClick={() => change({ workKey: "", editionKey: "", metadataVersion: null })}
            >
              作为新的作品或版本
            </Button>
            <Button
              disabled={!details.workKey || !details.editionKey}
              onClick={() => {
                setBusy(true);
                void getPrivateLibraryMetadata({
                  workKey: details.workKey,
                  editionKey: details.editionKey,
                  sourceKey: details.sourceKey,
                  season: Number(details.season) || 0,
                  episode: 1
                })
                  .then((cloud) => {
                    const m = cloud?.canonicalMetadata;
                    change({
                      ...(m
                        ? {
                            title: m.title,
                            aliases: m.aliases.join("，"),
                            year: m.year?.toString() ?? "",
                            kind: m.kind,
                            edition: m.edition,
                            sourceLabel: m.sourceLabel
                          }
                        : {}),
                      metadataVersion: cloud?.metadataVersion ?? null
                    });
                    setMessage("已载入云端最新作品信息，请核对后发布。");
                  })
                  .catch((e: unknown) => setMessage(privateLibraryError(e)))
                  .finally(() => setBusy(false));
              }}
            >
              载入云端最新作品信息
            </Button>
          </div>
          <p className="text-xs text-content-muted">
            下载序号不会自动当成集数。请核对下方对应关系；已发布条目的身份会保留，修改名称仍更新同一条目。
          </p>
          {rows.map((row, index) => (
            <section
              key={`${index}:${delivery.files[index].fileName}`}
              className="grid gap-2 rounded border border-boundary p-3"
            >
              <label className="flex items-start gap-2 break-all">
                <input
                  type="checkbox"
                  checked={row.selected}
                  onChange={(e) => rowChange(index, { selected: e.target.checked })}
                />
                {delivery.files[index].fileName}
              </label>
              <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
                <Field
                  label={`文件 ${index + 1} 的集数`}
                  type="number"
                  min={1}
                  max={9999}
                  value={row.episode}
                  onChange={(e) => rowChange(index, { episode: e.target.value })}
                />
                <Field
                  label={`文件 ${index + 1} 对应的原片文件名（可选）`}
                  value={row.fileName}
                  onChange={(e) => rowChange(index, { fileName: e.target.value })}
                />
              </div>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={row.auto}
                  disabled={
                    !row.fileName.trim() || !hasVideoMatchingEvidence(delivery.files[index])
                  }
                  onChange={(e) => rowChange(index, { auto: e.target.checked })}
                />
                允许播放器自动选择已确认文件名与时长的原片
              </label>
              {row.message && <p role="status">{row.message}</p>}
              {explicitSeasonEpisode(delivery.files[index].fileName) &&
                Number(row.episode) !==
                  explicitSeasonEpisode(delivery.files[index].fileName)?.episode && (
                  <p className="text-feedback-warning">
                    填写集号与文件名建议不同；将按你填写的集号发布，请核对。
                  </p>
                )}
              {row.baseline && (
                <p className="text-xs text-content-muted">
                  发布基线：{row.baseline.expectedRevision?.slice(0, 12) ?? "云端尚无此集"}
                </p>
              )}
              <Button
                disabled={
                  !details.workKey ||
                  !details.editionKey ||
                  !row.episode ||
                  !!publicationConflict(delivery, details, rows)
                }
                onClick={() => {
                  setBusy(true);
                  void preparePrivateLibraryPublication(
                    rowMetadata(details, row, delivery.files[index])
                  )
                    .then((baseline) => setBaselineProposal({ index, baseline }))
                    .catch((e: unknown) => setMessage(privateLibraryError(e)))
                    .finally(() => setBusy(false));
                }}
              >
                核对云端这集
              </Button>
              {baselineProposal?.index === index && (
                <div className="space-y-2 rounded border border-boundary p-2">
                  <p>
                    {baselineProposal.baseline.connectionScope} · 当前修订{" "}
                    {baselineProposal.baseline.expectedRevision?.slice(0, 12) ?? "尚未发布"}。
                  </p>
                  <p>
                    采用后，下一次发布会更新这一集。云端只保留当前播放器数据；旧 XML
                    由你在本地保存。
                  </p>
                  <Button
                    onClick={() => {
                      rowChange(index, {
                        baseline: baselineProposal.baseline,
                        receipt: undefined
                      });
                      setBaselineProposal(null);
                    }}
                  >
                    采用这版为发布基线
                  </Button>
                  <Button onClick={() => setBaselineProposal(null)}>取消</Button>
                </div>
              )}
            </section>
          ))}
        </fieldset>
        <p role="status">{message}</p>
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-panel-line p-4">
        <Button tone="primary" disabled={busy || !ready} onClick={() => void publish()}>
          {busy ? "正在发布…" : "发布选中的成品"}
        </Button>
        {busy && (
          <Button
            onClick={() => {
              stopRequested.current = true;
              setMessage("当前这集完成后停止，已提交的成品保留。");
            }}
          >
            当前集完成后停止
          </Button>
        )}
      </footer>
    </Dialog>
  );
}
