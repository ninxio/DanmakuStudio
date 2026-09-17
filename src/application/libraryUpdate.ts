import type { PublicationDelivery } from "../domain/publication/types";
import { sha256Hex } from "../domain/shared/sha256";
import { hasVideoMatchingEvidence } from "../domain/publication/publicationGuards";
import type {
  LibraryWork,
  LibraryEpisode,
  UpdateMode,
  UpdateRow,
  UpdateDraft
} from "../infrastructure/private-library/libraryTypes";
export type {
  LibraryWork,
  LibraryEpisode,
  UpdateMode,
  UpdateRow,
  UpdateDraft
} from "../infrastructure/private-library/libraryTypes";
export function inferLibraryEpisode(name: string): {
  season: number | null;
  episode: number | null;
} {
  const se = /(?:^|[^a-z\d])S(\d{1,3})[ ._-]*E(\d{1,4})(?!\d)/i.exec(name);
  if (se) return { season: Number(se[1]), episode: Number(se[2]) };
  const season =
    /第\s*(\d+)\s*季/i.exec(name)?.[1] ??
    /(?:^|[^a-z\d])S(\d{1,3})(?![a-z\d])/i.exec(name)?.[1];
  const ep = /第\s*(\d+)\s*[集话]/.exec(name)?.[1];
  return { season: season ? Number(season) : null, episode: ep ? Number(ep) : null };
}
export const normalizedLibraryTitle = (title: string) =>
  title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s_]+/gu, "");
export function newLibraryWork(
  title: string,
  kind: "tv" | "movie",
  year: number | null
): LibraryWork {
  return {
    workKey: `title-${sha256Hex(`${kind}:${normalizedLibraryTitle(title)}:${year ?? ""}`).slice(0, 48)}`,
    title: title.trim(),
    kind,
    year,
    episodeCount: 0,
    seasonCount: 0
  };
}
export function planLibraryUpdate(
  delivery: PublicationDelivery,
  work: LibraryWork,
  cloud: LibraryEpisode[],
  season: number,
  mode: UpdateMode,
  numbers: string[]
): UpdateRow[] {
  if (
    !work.title.trim() ||
    !Number.isInteger(season) ||
    season < 0 ||
    season > 999 ||
    (work.kind === "tv" && season < 1)
  )
    throw new Error("请确认正式片名和季数。");
  if (numbers.length !== delivery.files.length || !numbers.length)
    throw new Error("请选择要更新的 XML。");
  const episodes = numbers.map((n) => (/^\d+$/.test(n) ? Number(n) : NaN));
  if (
    episodes.some((n) => !Number.isInteger(n) || n < 1 || n > 9999) ||
    new Set(episodes).size !== episodes.length
  )
    throw new Error("请填写不重复的集数；文件序号不会自动当作集数。");
  if (work.kind === "movie" && (episodes.length !== 1 || episodes[0] !== 1 || season !== 0))
    throw new Error("电影只使用一份完整 XML。");
  if (
    delivery.files.some((f) => {
      const n = inferLibraryEpisode(f.fileName);
      return n.season !== null && n.season !== season;
    })
  )
    throw new Error("文件季号与目标不一致，请按季选择文件并核对。");
  const seasonRows = cloud.filter((e) => e.manifest.season === season);
  if (cloud.some((e) => e.canonicalMetadata.workKey !== work.workKey))
    throw new Error("返回的影视身份不一致，请重新选择。");
  return delivery.files.map((file, index) => {
    const current = seasonRows.find((e) => e.manifest.episode === episodes[index]);
    const base = current ?? seasonRows[0] ?? cloud[0];
    const shared = base?.canonicalMetadata ?? {
      workKey: work.workKey,
      editionKey: "current",
      sourceKey: "personal",
      sourceLabel: "个人整理",
      title: work.title,
      aliases: [],
      year: work.year,
      kind: work.kind,
      edition: "当前弹幕"
    };
    const same = current?.manifest.xmlHash === sha256Hex(file.content);
    return {
      index,
      episode: episodes[index],
      action: current
        ? mode === "append"
          ? "skip"
          : same
            ? "unchanged"
            : "replace"
        : "create",
      expectedRevision: current?.revision ?? null,
      existingEpisodeId: current?.episodeId,
      reviewed: same && current?.reviewStatus === "approved",
      oldCount: current?.manifest.commentCount ?? null,
      metadata: {
        ...shared,
        expectedMetadataVersion: base?.metadataVersion ?? null,
        season,
        episode: episodes[index],
        label: work.kind === "movie" ? work.title : `第 ${episodes[index]} 集`,
        durationMs: hasVideoMatchingEvidence(file) ? (file.durationMs ?? null) : null,
        fileNames:
          hasVideoMatchingEvidence(file) && file.targetFileName ? [file.targetFileName] : [],
        allowAutoMatch: false
      }
    };
  });
}
export function recoverUpdateDraft(value: unknown, count: number): UpdateDraft | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Partial<UpdateDraft>;
  if (
    d.schemaVersion !== 1 ||
    d.workflow !== "library-update-v2" ||
    !d.work ||
    !Array.isArray(d.rows) ||
    d.rows.length !== count ||
    !Number.isInteger(d.season) ||
    !["replace", "append"].includes(d.mode ?? "")
  )
    return null;
  if (
    !d.rows.every(
      (r, i) =>
        r.index === i &&
        r.metadata &&
        r.metadata.workKey === d.work?.workKey &&
        ["create", "replace", "unchanged", "skip"].includes(r.action)
    )
  )
    return null;
  return d as UpdateDraft;
}
