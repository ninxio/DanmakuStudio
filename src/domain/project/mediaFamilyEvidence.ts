import { parseEpisodeIdentity, type EpisodeIdentity } from "./episodeIdentity";
import type {
  FamilyNumberingMode,
  FamilyNumberingSuggestion,
  MediaFamilyContext,
  MediaFamilyIssue,
  MediaFamilyProject
} from "./mediaFamilyTypes";

interface Observation {
  assetId: string;
  stem: string;
  title: string;
  directory: string | null;
  sourceGroupKey: string;
  sourceLabel: string;
  sequenceNumber: number | null;
  partNumber: number | null;
  identity: EpisodeIdentity | null;
  numbers: number[];
  season: number | null;
  declaredCount: number | null;
  blocked: boolean;
}

const numberWords = "[零〇一二两三四五六七八九十百\\d]+";
const collectionCount = new RegExp(`(?:全|共)\\s*(${numberWords})\\s*[集话話]`, "g");
const partPattern =
  /(?:^|[\s._-])(?:part|pt|p|cd|disc|disk|dvd)[\s._-]*(\d{1,4})(?=$|[\s._-])/i;
const releaseNoise =
  /(?:\b(?:2160|1080|720|480)[pi]\b|\b(?:x26[45]|h[ .]?26[45]|hevc|avc|web[- .]?dl|bluray|aac|flac)\b|\[[a-f\d]{8}\])/gi;

/** One batch pass gathers context; numeric roles are inferred within stable source families.
 * The reusable explicit parser remains authoritative. No media/content or I/O is inspected.
 * See docs/research/2026-09-09-media-family-recognition.md for parser comparisons.
 */
export function recognizeFamilyEvidence(
  project: MediaFamilyProject,
  context: MediaFamilyContext
) {
  const issues: MediaFamilyIssue[] = [];
  const observations = project.assets.map((asset): Observation => {
    const source =
      asset.xmlMetadata?.sources.length === 1 ? asset.xmlMetadata.sources[0] : undefined;
    const path =
      context.assetPaths?.[asset.id] ?? asset.sourcePath ?? asset.acquisition?.xmlPath;
    const directory = path ? parentDirectory(path) : null;
    const file = splitOrdinal(asset.fileName.normalize("NFKC").replace(/\.xml$/i, ""));
    const rawTitle = source?.title ?? context.importTitle ?? "";
    // Metadata's original page title survives renaming and is independent of its download ordinal.
    const stem = source?.part.trim() || file.stem;
    const explicit = explicitIdentity(stem);
    const named = explicitIdentity(file.stem);
    const declaredCountText = [...rawTitle.matchAll(collectionCount)][0]?.[1];
    const declaredCount = declaredCountText
      ? (parseEpisodeIdentity(`第${declaredCountText}集`)?.episodeStart ?? null)
      : null;
    const folderContext = folderIdentity(directory);
    const titleSeason = seasonNumber(rawTitle);
    const season = folderContext.season ?? titleSeason;
    const crossSeason = stem.match(/S(\d+)\s*E\d+\s*[-~–—]\s*S(\d+)\s*E\d+/i);
    let blocked = Boolean(crossSeason && crossSeason[1] !== crossSeason[2]);
    let identity = explicit ?? named;
    if (explicit && named && !compatible(explicit, named)) {
      blocked = true;
      issues.push({
        code: "conflictingIdentity",
        assetIds: [asset.id],
        message: "文件名与 XML 内嵌的季集信息冲突，请核对后手动安排。"
      });
    }
    if (blocked && crossSeason)
      issues.push({
        code: "crossSeasonRange",
        assetIds: [asset.id],
        message: "同一文件跨越不同季，需指定各季的来源窗口。"
      });
    if (identity && folderContext.identity && !compatible(identity, folderContext.identity)) {
      blocked = true;
      issues.push({
        code: "conflictingIdentity",
        assetIds: [asset.id],
        message: "目录与文件的季集信息冲突，请确认归属。"
      });
    }
    if (!identity && folderContext.identity) identity = folderContext.identity;
    if (
      identity &&
      identity.seasonNumber !== null &&
      folderContext.season !== null &&
      identity.seasonNumber !== folderContext.season
    ) {
      blocked = true;
      issues.push({
        code: "conflictingIdentity",
        assetIds: [asset.id],
        message: "目录季号与文件季号不一致，请确认后再合并。"
      });
    }
    if (identity && identity.seasonNumber === null && season !== null)
      identity = { ...identity, seasonNumber: season };
    const title = familyTitle(file.stem);
    const bvid = asset.acquisition?.bvid ?? source?.bvid;
    // Provider identity outranks per-file storage directories. Repeated pieces are rejected later.
    const sourceGroupKey = bvid
      ? `bilibili:${bvid}`
      : `${folderContext.root ?? "unscoped"}::${title.toLocaleLowerCase()}`;
    const sourceLabel =
      rawTitle || folderContext.root?.split("/").at(-1) || title || "本批导入";
    const numbers = numericTokens(stem, rawTitle);
    const explicitPart = stem.match(partPattern);
    const folderPart =
      folderContext.identity && /^\d{1,4}$/.test(stem.trim()) ? Number(stem.trim()) : null;
    const partNumber = identity?.partNumber ?? (explicitPart ? +explicitPart[1] : folderPart);
    if (identity && partNumber !== null) identity = { ...identity, partNumber };
    return {
      assetId: asset.id,
      stem,
      title,
      directory,
      sourceGroupKey,
      sourceLabel,
      sequenceNumber: asset.acquisition?.page ?? source?.page ?? file.ordinal,
      partNumber,
      identity: blocked ? null : identity,
      numbers,
      season,
      declaredCount,
      blocked
    };
  });
  const batches = new Map<string, Observation[]>();
  for (const observation of observations) {
    const batch = batches.get(observation.sourceGroupKey) ?? [];
    batch.push(observation);
    batches.set(observation.sourceGroupKey, batch);
  }
  const suggestions: FamilyNumberingSuggestion[] = [];
  for (const [sourceGroupKey, members] of batches) {
    const candidates = members.filter(
      (file) => !file.identity && !file.blocked && file.numbers.length
    );
    const pairs = candidates.filter((file) => file.numbers.length === 2);
    const singles = candidates.filter((file) => file.numbers.length === 1);
    const columns = new Map<number, Set<number>>();
    for (const file of pairs) {
      const values = columns.get(file.numbers[0]) ?? new Set<number>();
      values.add(file.numbers[1]);
      columns.set(file.numbers[0], values);
    }
    const repeated = [...columns.values()].filter((values) => values.size > 1);
    const reset = repeated.length >= 2;
    const ranges =
      pairs.length >= 2 &&
      pairs.every((file) => file.numbers[0] < file.numbers[1]) &&
      pairs
        .slice()
        .sort((a, b) => a.numbers[0] - b.numbers[0])
        .every(
          (file, index, sorted) => index === 0 || file.numbers[0] > sorted[index - 1].numbers[1]
        );
    const uniqueSingles = new Set(singles.map((file) => file.numbers[0]));
    const singleSequence = singles.length >= 2 && uniqueSingles.size === singles.length;
    const recommendedMode: FamilyNumberingMode = reset
      ? "episodePart"
      : ranges
        ? "episodeRange"
        : singleSequence || singles.some((file) => file.season !== null)
          ? "episode"
          : "auto";
    const modes: FamilyNumberingMode[] = ["auto"];
    if (pairs.length) modes.push("episodePart", "seasonEpisode", "episodeRange");
    if (singles.length) modes.push("episode");
    const requested = context.numberingBySource?.[sourceGroupKey] ?? "auto";
    const selectedMode = modes.includes(requested) ? requested : "auto";
    const mode = selectedMode === "auto" ? recommendedMode : selectedMode;
    const reasons: string[] = [];
    if (reset)
      reasons.push(
        `${columns.size} 组首位编号各自包含递增的次位编号，建议解释为“集号 · 片段”；也可切换为“季号 · 集号”。`
      );
    else if (ranges)
      reasons.push("编号形成互不重叠的范围，建议先按多集合集保留，切集时间仍需指定。");
    else if (singleSequence)
      reasons.push(
        "同一来源中的单列编号没有重复，建议按集号排列；若是电影切片，可选择合成正片。"
      );
    else if (pairs.length)
      reasons.push("数字既可能是集内片段，也可能是季集或集范围；请选择含义，预览后再应用。");
    if (members[0].declaredCount !== null && columns.size) {
      reasons.push(
        members[0].declaredCount === columns.size
          ? "识别出的集数与来源标题标注的总集数一致。"
          : `来源标题标注 ${members[0].declaredCount} 集，目前编号有 ${columns.size} 组；可能尚未导入完整。`
      );
    }
    if (candidates.length)
      suggestions.push({
        sourceGroupKey,
        sourceLabel: members[0].sourceLabel,
        fileCount: members.length,
        selectedMode,
        recommendedMode,
        reasons,
        modes
      });
    for (const file of candidates) {
      const values = file.numbers;
      if (values.length === 3)
        file.identity = identity(values[1], values[1], values[0], values[2]);
      else if (values.length === 2) {
        if (mode === "episodePart")
          file.identity = identity(values[0], values[0], file.season, values[1]);
        if (mode === "seasonEpisode")
          file.identity = identity(values[1], values[1], values[0], null);
        if (mode === "episodeRange")
          file.identity = identity(values[0], values[1], file.season, null);
      } else if (mode === "episode")
        file.identity = identity(values[0], values[0], file.season, null);
      if (file.identity) file.partNumber = file.identity.partNumber ?? file.partNumber;
      else
        issues.push({
          code: "ambiguousNumbers",
          assetIds: [file.assetId],
          message: "编号含义尚未确定；可选择数字含义或手动设置输出集。"
        });
    }
    const byEpisode = new Map<string, Observation[]>();
    for (const file of members) {
      if (!file.identity?.partNumber) continue;
      const key = `${file.identity.seasonNumber}:${file.identity.episodeStart}:${file.identity.episodeEnd}`;
      const rows = byEpisode.get(key) ?? [];
      rows.push(file);
      byEpisode.set(key, rows);
    }
    for (const rows of byEpisode.values()) {
      const parts = [...new Set(rows.map((file) => file.identity!.partNumber!))].sort(
        (a, b) => a - b
      );
      if (
        parts[0] !== 1 ||
        parts.some((part, index) => index > 0 && part !== parts[index - 1] + 1)
      )
        issues.push({
          code: "missingParts",
          assetIds: rows.map((file) => file.assetId),
          message: "片段编号有空缺或不是从 1 开始；请确认是否漏导入，不能据此推算缺失时长。"
        });
    }
    const seasons = new Map<number | null, Observation[]>();
    for (const file of members) {
      if (!file.identity) continue;
      const rows = seasons.get(file.identity.seasonNumber) ?? [];
      rows.push(file);
      seasons.set(file.identity.seasonNumber, rows);
    }
    for (const rows of seasons.values()) {
      const ranges = [
        ...new Map(
          rows.map((file) => [
            `${file.identity!.episodeStart}:${file.identity!.episodeEnd}`,
            file.identity!
          ])
        ).values()
      ].sort((a, b) => a.episodeStart - b.episodeStart);
      let end = ranges[0]?.episodeEnd ?? 0;
      let gap = false;
      let overlap = false;
      for (const range of ranges.slice(1)) {
        gap ||= range.episodeStart > end + 1;
        overlap ||= range.episodeStart <= end;
        end = Math.max(end, range.episodeEnd);
      }
      if (gap)
        issues.push({
          code: "missingEpisodes",
          assetIds: rows.map((file) => file.assetId),
          message: "同一季的集号或集范围之间有空缺；可能是分批导入，也可能缺少文件，请核对。"
        });
      if (overlap)
        issues.push({
          code: "overlappingEpisodes",
          assetIds: rows.map((file) => file.assetId),
          message: "部分集范围互相重叠，可能包含重复内容或不同版本；已分别保留。"
        });
    }
  }
  return {
    observations: new Map(observations.map((file) => [file.assetId, file])),
    suggestions,
    issues
  };
}

function identity(
  first: number,
  last: number,
  season: number | null,
  part: number | null
): EpisodeIdentity | null {
  if (
    first < 0 ||
    last < first ||
    last > 9999 ||
    (season !== null && season > 999) ||
    (part !== null && (part < 1 || part > 9999))
  )
    return null;
  return {
    seasonNumber: season,
    episodeStart: first,
    episodeEnd: last,
    partNumber: part,
    pattern: part !== null ? "episodePart" : first !== last ? "episodeRange" : "episode",
    evidenceStrength: "moderate"
  };
}
function compatible(a: EpisodeIdentity, b: EpisodeIdentity) {
  return (
    (a.seasonNumber === null || b.seasonNumber === null || a.seasonNumber === b.seasonNumber) &&
    a.episodeStart === b.episodeStart &&
    a.episodeEnd === b.episodeEnd &&
    (a.partNumber === null || b.partNumber === null || a.partNumber === b.partNumber)
  );
}
function explicitIdentity(text: string): EpisodeIdentity | null {
  const cleaned = text
    .normalize("NFKC")
    .replace(collectionCount, " ")
    .replace(releaseNoise, " ");
  // 1x02 is an explicit season/episode notation, unlike an unlabelled decimal pair.
  const canonical = cleaned
    .replace(/\bepisode\s*(\d+)/gi, "E$1")
    .replace(
      /\b(\d{1,3})x(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?\b/gi,
      (_, season: string, episode: string, end: string | undefined) =>
        `S${season}E${episode}${end ? `-E${end}` : ""}`
    );
  const parsed = parseEpisodeIdentity(canonical);
  const part = canonical.match(partPattern);
  return parsed && part ? { ...parsed, partNumber: +part[1] } : parsed;
}
function splitOrdinal(text: string) {
  const match = text.trim().match(/^(?:P\s*(\d{1,6})\s*[-_.—]\s*|(\d{1,6})\s+[-_.—]\s*)(.+)$/i);
  return { stem: match?.[3] ?? text.trim(), ordinal: match ? +(match[1] ?? match[2]) : null };
}
function numericTokens(text: string, expectedTitle: string): number[] {
  let clean = text
    .normalize("NFKC")
    .replace(releaseNoise, " ")
    .replace(collectionCount, " ")
    .trim();
  if (expectedTitle && clean.startsWith(expectedTitle))
    clean = clean.slice(expectedTitle.length).trim();
  // Only a terminal numeric field; years, dates, codecs, dimensions and P-only labels are not episodes.
  const match = clean.match(/(?:^|[\s._–—-])(\d{1,4}(?:[\s._-]+\d{1,4}){0,2})$/);
  if (!match) return [];
  const values = match[1].split(/[\s._-]+/).map(Number);
  if (
    values.some((value) => value >= 1900 && value <= 2099) ||
    values.some((value) => value > 9999)
  )
    return [];
  return values;
}
function seasonNumber(text: string): number | null {
  const normalized = text.normalize("NFKC");
  const english = normalized.match(
    /(?:^|[\s._[（(])(?:season\s*|s)(\d{1,3})(?=$|[\s._\]）)])/i
  );
  if (english) return +english[1];
  const chinese = normalized.match(new RegExp(`第?${numberWords}\\s*季`));
  return chinese ? (parseEpisodeIdentity(`${chinese[0]}第1集`)?.seasonNumber ?? null) : null;
}
function folderIdentity(directory: string | null) {
  let root = directory;
  let season: number | null = null;
  let episode: EpisodeIdentity | null = null;
  // Structural season/episode folders are context, while version directories remain distinct.
  for (let depth = 0; root && depth < 3; depth++) {
    const label = root.split("/").at(-1) ?? "";
    const candidateSeason = seasonNumber(label);
    const candidateEpisode = explicitIdentity(label);
    const structural =
      /^(?:s\d+(?:e\d+)?|season\s*\d+|(?:episode|e(?:p)?)\s*\d+|第?[零〇一二两三四五六七八九十百\d]+[季集话話])$/i.test(
        label.normalize("NFKC")
      );
    if (!structural) break;
    season ??= candidateSeason;
    episode ??= candidateEpisode;
    root = parentDirectory(root);
  }
  return { root, season, identity: episode };
}
export function familyTitle(text: string): string {
  return text
    .replace(collectionCount, " ")
    .replace(
      /\b(?:S\d+\s*E\d+(?:\s*[-~–—]\s*(?:S\d+\s*)?E?\d+)?|\d+x\d+(?:-\d+)?|E(?:P)?\s*\d+(?:-E?\d+)?)/gi,
      " "
    )
    .replace(
      new RegExp(
        `第?${numberWords}\\s*季(?:\\s*第?${numberWords}(?:[-~–—至到]${numberWords})?[集话話]?)?`,
        "g"
      ),
      " "
    )
    .replace(new RegExp(`第?${numberWords}(?:[-~–—至到]${numberWords})?[集话話]`, "g"), " ")
    .replace(/(?:^|[\s._-])(?:part|pt|p|cd|disc|disk|dvd)[\s._-]*\d+(?=$|[\s._-])/gi, " ")
    .replace(/(?:^|[\s._–—-])\d+(?:[\s._-]+\d+){0,2}$/, "")
    .replace(/^[\d\s._-]+$/, "")
    .replace(/[【】[\]]/g, " ")
    .replace(/^[\s._\-（(]+|[\s._\-）)]+$/g, "")
    .trim();
}
function parentDirectory(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? null : normalized.slice(0, index) || null;
}
