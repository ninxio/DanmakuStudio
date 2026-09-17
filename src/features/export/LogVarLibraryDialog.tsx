import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { inferLibraryEpisode, newLibraryWork } from "../../application/libraryUpdate";
import type { LibraryProfile } from "../../domain/project/discovery";
import type { PublicationDelivery } from "../../domain/publication/types";
import { selectLibraryFiles } from "../../infrastructure/private-library/libraryBrowser";
import {
  listLogvarLibrary,
  logvarStatus,
  previewLogvarUpload,
  uploadLogvarXml,
  type LogVarMetadata,
  type LogVarPreview,
  type LogVarResource
} from "../../infrastructure/private-library/logvar";
import {
  privateLibraryError,
  privateLibraryStatus
} from "../../infrastructure/private-library/privateLibrary";
import { LogVarConnectionPanel } from "./LogVarConnectionPanel";
import { PublicationLibraryDialog } from "./PublicationLibraryDialog";
import { PrivateLibraryPublishDialog } from "./PrivateLibraryPublishDialog";

interface Row {
  index: number;
  metadata: LogVarMetadata;
  preview: LogVarPreview;
  skip: boolean;
  result?: string;
}
export function LogVarLibraryDialog({
  onClose,
  delivery: initialDelivery,
  onChooseProfile
}: {
  onClose: () => void;
  delivery?: PublicationDelivery;
  onChooseProfile?: (profile: LibraryProfile) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [resources, setResources] = useState<LogVarResource[]>([]);
  const [query, setQuery] = useState("");
  const [delivery, setDelivery] = useState(initialDelivery);
  const [title, setTitle] = useState(initialDelivery?.libraryProfile?.title ?? "");
  const [year, setYear] = useState("");
  const [kind, setKind] = useState<"tv" | "movie">("tv");
  const [season, setSeason] = useState("1");
  const [numbers, setNumbers] = useState<string[]>(
    () =>
      initialDelivery?.files.map(
        (f) => inferLibraryEpisode(f.fileName).episode?.toString() ?? ""
      ) ?? []
  );
  const [appendOnly, setAppendOnly] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const running = useRef(false),
    stop = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);
  const refresh = async () => {
    const s = await logvarStatus();
    if (!alive.current) return;
    setConnected(s.configured);
    if (s.configured) {
      const found = await listLogvarLibrary();
      if (alive.current) setResources(found);
    }
  };
  useEffect(() => {
    void refresh().catch((e) => {
      if (alive.current) setMessage(privateLibraryError(e));
    });
    void privateLibraryStatus()
      .then((s) => {
        if (alive.current) setLegacyAvailable(s.configured);
      })
      .catch(() => {});
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    stop.current = false;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setMessage(privateLibraryError(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const invalidate = () => {
    setRows([]);
    setConfirmed(false);
  };
  const choose = (r: LogVarResource) => {
    setTitle(r.title);
    setYear(String(r.year));
    setKind(r.type);
    setSeason(String(r.season));
    if (delivery?.files.length === 1) setNumbers([String(r.episode ?? 1)]);
    invalidate();
  };
  const filtered = useMemo(
    () =>
      resources.filter((r) => r.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    [resources, query]
  );
  const preview = async () => {
    if (!delivery || !delivery.files.length || delivery.files.length > 64)
      throw new Error("一次请选择 1–64 份 XML。");
    if (
      !title.trim() ||
      !/^\d{4}$/.test(year) ||
      Number(year) < 1900 ||
      Number(year) > new Date().getFullYear()
    )
      throw new Error("请填写正式片名与有效年份。");
    if (!/^\d+$/.test(season) || Number(season) < 1 || Number(season) > 999)
      throw new Error("季数需为 1–999。");
    if (kind === "movie" && delivery.files.length !== 1)
      throw new Error("电影请使用一份完整弹幕。");
    if (
      kind === "tv" &&
      (numbers.length !== delivery.files.length ||
        numbers.some((n) => !/^\d+$/.test(n) || Number(n) < 1 || Number(n) > 9999) ||
        new Set(numbers.map(Number)).size !== numbers.length)
    )
      throw new Error("请核对每份 XML 的集数，不能重复或把文件序号自动当作集数。");
    const next: Row[] = [];
    for (let index = 0; index < delivery.files.length; index++) {
      if (stop.current) break;
      const file = delivery.files[index];
      const inferred = inferLibraryEpisode(file.fileName);
      if (kind === "tv" && inferred.season !== null && inferred.season !== Number(season))
        throw new Error(`${file.fileName} 的季号与目标不一致。`);
      const metadata: LogVarMetadata = {
        title: title.trim(),
        year: Number(year),
        type: kind,
        season: Number(season),
        episode: kind === "movie" ? null : Number(numbers[index])
      };
      const result = await previewLogvarUpload(file.content, metadata);
      next.push({
        index,
        metadata,
        preview: result,
        skip: appendOnly && result.expectedVersion !== null
      });
    }
    if (alive.current) {
      setRows(stop.current ? [] : next);
      setConfirmed(false);
      setMessage(
        stop.current ? "已停止，未上传。" : "清单已生成，尚未上传。请核对新增和替换范围。"
      );
    }
  };
  const upload = async () => {
    if (!delivery || !confirmed || !rows.length) return;
    const next = rows.map((r) => ({ ...r }));
    let done = 0;
    for (const row of next) {
      if (stop.current) break;
      if (row.skip || row.result) continue;
      try {
        const result = await uploadLogvarXml(
          delivery.files[row.index].content,
          row.metadata,
          row.preview
        );
        row.result = `回读一致 · ${result.verifiedCount} 条`;
        done++;
      } catch (e) {
        row.result = `需核对：${privateLibraryError(e)}`;
        setRows([...next]);
        setConfirmed(false);
        throw new Error(row.result);
      }
      if (alive.current) setRows([...next]);
    }
    if (alive.current) {
      setConfirmed(false);
      setMessage(
        `${stop.current ? "已在文件之间停止" : "本次处理结束"}，${done} 份上传并回读一致。该结果不代表已证明对齐精度。重新上传前请重新预览。`
      );
      await refresh();
    }
  };
  if (legacy)
    return delivery ? (
      <PrivateLibraryPublishDialog delivery={delivery} onClose={onClose} />
    ) : (
      <PublicationLibraryDialog onClose={onClose} onChooseProfile={onChooseProfile} />
    );
  return (
    <Dialog
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnEscape={!busy}
      ariaLabel="LogVar 私人弹幕库"
      className="flex max-h-[90vh] w-[min(1000px,95vw)] flex-col overflow-hidden rounded-xl border border-panel-line bg-panel-base p-5 text-sm text-content-secondary"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-content-primary">LogVar 私人弹幕库</h2>
        <Button disabled={busy} onClick={onClose}>
          关闭
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto thin-scrollbar">
        {!connected ? (
          <LogVarConnectionPanel onConnected={() => void run(refresh)} />
        ) : (
          <>
            <p>
              先选择已有影视，或填写新影视。上传后会通过播放器接口回读；同一片名、年份、类型、季集的上传会替换原弹幕。
            </p>
            <fieldset disabled={busy} className="grid gap-3">
              <div className="flex flex-wrap items-end gap-2">
                <Field
                  label="搜索本地库片名"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <Button onClick={() => void run(refresh)}>刷新列表</Button>
                <Button
                  onClick={() =>
                    void run(async () => {
                      const selected = await selectLibraryFiles(false);
                      if (selected) {
                        setDelivery(selected);
                        setNumbers(
                          selected.files.map(
                            (f) => inferLibraryEpisode(f.fileName).episode?.toString() ?? ""
                          )
                        );
                        invalidate();
                      }
                    })
                  }
                >
                  选择要上传的 XML
                </Button>
              </div>
              <div className="max-h-48 overflow-auto rounded border border-panel-line">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="p-2">影视</th>
                      <th>季集</th>
                      <th>弹幕数</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(0, 200).map((r) => (
                      <tr key={r.resourceKey}>
                        <td className="p-2">
                          {r.title}（{r.year}）
                        </td>
                        <td>
                          {r.type === "movie" ? "电影" : `S${r.season} E${r.episode ?? "全部"}`}
                        </td>
                        <td>{r.count}</td>
                        <td>
                          <Button onClick={() => choose(r)}>选用影视资料</Button>
                          {onChooseProfile && (
                            <Button
                              onClick={() =>
                                onChooseProfile({
                                  schemaVersion: 1,
                                  workKey: newLibraryWork(r.title, r.type, r.year).workKey,
                                  editionKey: "current",
                                  sourceKey: "logvar",
                                  title: r.title,
                                  aliases: [],
                                  kind: r.type,
                                  year: r.year,
                                  edition: "当前弹幕",
                                  sourceLabel: "LogVar 本地库",
                                  season: r.season
                                })
                              }
                            >
                              用作项目资料
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && (
                  <p className="p-3">没有匹配的本地弹幕；可在下方填写新影视。</p>
                )}
                {filtered.length > 200 && <p>当前仅显示前 200 项，请输入片名缩小范围。</p>}
              </div>
              {delivery && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="正式片名"
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        invalidate();
                      }}
                    />
                    <Field
                      label="年份"
                      value={year}
                      onChange={(e) => {
                        setYear(e.target.value);
                        invalidate();
                      }}
                    />
                    <label>
                      类型
                      <select
                        aria-label="影视类型"
                        className="ml-2 rounded border border-panel-line bg-panel-base p-2"
                        value={kind}
                        onChange={(e) => {
                          setKind(e.target.value as "tv" | "movie");
                          invalidate();
                        }}
                      >
                        <option value="tv">剧集</option>
                        <option value="movie">电影</option>
                      </select>
                    </label>
                    <Field
                      label="季数"
                      value={season}
                      onChange={(e) => {
                        setSeason(e.target.value);
                        invalidate();
                      }}
                    />
                  </div>
                  <div className="grid gap-2">
                    {delivery.files.map((f, i) => (
                      <div key={i} className="flex items-center justify-between gap-3">
                        <span className="break-all">{f.fileName}</span>
                        {kind === "tv" && (
                          <Field
                            label={`第 ${i + 1} 份 XML 对应集数`}
                            value={numbers[i] ?? ""}
                            onChange={(e) => {
                              setNumbers((n) =>
                                n.map((v, j) => (j === i ? e.target.value : v))
                              );
                              invalidate();
                            }}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={appendOnly}
                      onChange={(e) => {
                        setAppendOnly(e.target.checked);
                        invalidate();
                      }}
                    />
                    只补缺集（已有季集跳过）
                  </label>
                  <Button onClick={() => void run(preview)}>预览上传清单</Button>
                </>
              )}
            </fieldset>
            <p className="text-xs text-content-muted">
              LogVar 每文件最多 10 MiB、20 万条；上传转换为兼容
              JSON，时间保留两位小数，正文首尾空白会去除，原 XML
              不变。没有云端修订锁，请避免其他设备同时更新同一集；上传前会再次检查已知版本，上传后回读验证。
            </p>
            {rows.length > 0 && (
              <div className="grid gap-3 rounded border border-panel-line p-3">
                {rows.map((row) => (
                  <p key={row.index}>
                    {delivery?.files[row.index].fileName} →{" "}
                    {row.skip
                      ? "跳过已有集"
                      : row.preview.expectedVersion
                        ? "替换已有集"
                        : "新增"}{" "}
                    · {row.preview.count} 条
                    {row.preview.trimmedTextCount > 0
                      ? ` · ${row.preview.trimmedTextCount} 条将去除首尾空白`
                      : ""}
                    {row.result ? ` · ${row.result}` : ""}
                  </p>
                ))}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已检查所选内容与季集，并同意清单中的新增、替换及格式转换。
                </label>
                <Button
                  disabled={busy || !confirmed || rows.every((r) => r.skip || r.result)}
                  onClick={() => void run(upload)}
                >
                  上传并回读核验
                </Button>
              </div>
            )}
          </>
        )}
        <p role="status" className="whitespace-pre-wrap">
          {busy ? "正在处理，可在当前文件完成后停止…" : message}
        </p>
        {busy && (
          <Button
            onClick={() => {
              stop.current = true;
              setMessage("停止请求已记录。");
            }}
          >
            停止后续文件
          </Button>
        )}
        {legacyAvailable && (
          <details>
            <summary>已有旧版专用服务</summary>
            <p>旧连接独立保存；不会把旧凭据传给 LogVar，也不会自动迁移云端内容。</p>
            <Button disabled={busy} onClick={() => setLegacy(true)}>
              打开旧版专用库
            </Button>
          </details>
        )}
      </div>
    </Dialog>
  );
}
