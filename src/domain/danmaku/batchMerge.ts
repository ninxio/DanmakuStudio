import type { CutMarker, DanmakuAsset, DanmakuItem } from "./types";
import { getKnownBilibiliDuration } from "./bilibiliAcquisition";
import { applyCutMapping, getAppliedCutGap } from "./timeCompensation";
import type { Milliseconds } from "../shared/time";
import { clampMilliseconds } from "../shared/time";
import { parseBatchMergeEpisodeIdentity } from "../project/episodeIdentity";

export type BatchMergeConfidence = "high" | "medium" | "low";

export interface BatchMergeEntry {
  item: DanmakuItem;
  finalTimeMs: Milliseconds;
}

export interface BatchMergeEpisode {
  id: string;
  seasonNumber: number | null;
  episodeNumber: number;
  label: string;
  fileName: string;
  sourceFileNames: string[];
  itemCount: number;
  entries: BatchMergeEntry[];
  warnings: string[];
}

export interface BatchMergePlan {
  episodes: BatchMergeEpisode[];
  diagnostics: string[];
  confidence: BatchMergeConfidence;
  compensation: BatchMergeCompensationSummary;
}

export interface BatchMergeCompensationSummary {
  markerCount: number;
  totalGapMs: Milliseconds;
  affectedEntryCount: number;
  affectedEpisodeCount: number;
}

export type SegmentWindowRule =
  | { mode: "full" }
  | { mode: "prefix"; durationMs: Milliseconds }
  | { mode: "suffix"; durationMs: Milliseconds }
  | { mode: "range"; startMs: Milliseconds; endMs: Milliseconds };

export interface EpisodeDurationMetadata {
  seasonNumber: number | null;
  episodeNumber: number | null;
  durationMs: Milliseconds;
}

export type RangeSplitRule =
  | { mode: "auto" }
  | { mode: "episodeDurations"; episodes: EpisodeDurationMetadata[] }
  | { mode: "manualCutPoints"; cutPointsMs: Milliseconds[] };

export interface BatchMergeOptions {
  segmentWindow?: SegmentWindowRule;
  rangeSplit?: RangeSplitRule;
  cutMarkers?: CutMarker[];
}

interface ParsedAssetName {
  asset: DanmakuAsset;
  sourceOrder: number;
  sortNumber: number;
  seasonNumber: number | null;
  episodeStart: number;
  episodeEnd: number;
  partNumber: number | null;
  confidence: BatchMergeConfidence;
  fallback: boolean;
}

interface EpisodeSegment {
  seasonNumber: number | null;
  episodeNumber: number;
  sourceOrder: number;
  partNumber: number | null;
  sourceFileName: string;
  entries: BatchMergeEntry[];
  durationMs: Milliseconds | null;
  warnings: string[];
}

interface TimedEntry {
  item: DanmakuItem;
  mappedTimeMs: Milliseconds;
}

export function buildBatchMergePlan(assets: DanmakuAsset[], options: BatchMergeOptions = {}): BatchMergePlan {
  if (assets.length === 0) {
    return {
      episodes: [],
      diagnostics: ["尚未导入 XML，无法生成分集合并草案。"],
      confidence: "low",
      compensation: createCompensationSummary([], options.cutMarkers ?? [])
    };
  }

  const parsedAssets = assets
    .map((asset, index) => parseAssetName(asset, index))
    .sort((left, right) => left.sortNumber - right.sortNumber || left.sourceOrder - right.sourceOrder);
  const segments = parsedAssets.flatMap((asset) => createSegmentsFromParsedAsset(asset, options));
  const groupMap = new Map<string, EpisodeSegment[]>();
  for (const segment of segments) {
    const key = createEpisodeKey(segment.seasonNumber, segment.episodeNumber);
    groupMap.set(key, [...(groupMap.get(key) ?? []), segment]);
  }

  const seasons = new Set(segments.map((segment) => segment.seasonNumber).filter((season): season is number => season !== null));
  const hasMultipleSeasons = seasons.size > 1;
  const episodes = Array.from(groupMap.values())
    .map((group) => createEpisodeDraft(group, hasMultipleSeasons))
    .sort(
      (left, right) =>
        (left.seasonNumber ?? 0) - (right.seasonNumber ?? 0) || left.episodeNumber - right.episodeNumber
    );
  const compensation = createCompensationSummary(episodes, options.cutMarkers ?? []);
  const diagnostics = createDiagnostics(parsedAssets, episodes, compensation);
  return {
    episodes,
    diagnostics,
    confidence: mergeConfidence(parsedAssets.map((asset) => asset.confidence)),
    compensation
  };
}

function parseAssetName(asset: DanmakuAsset, sourceOrder: number): ParsedAssetName {
  const identity = parseBatchMergeEpisodeIdentity(asset.fileName, sourceOrder);
  return {
    asset,
    sourceOrder,
    sortNumber: identity.sortNumber,
    seasonNumber: identity.seasonNumber,
    episodeStart: identity.episodeStart,
    episodeEnd: identity.episodeEnd,
    partNumber: identity.partNumber,
    confidence:
      identity.evidenceStrength === "strong"
        ? "high"
        : identity.evidenceStrength === "moderate"
          ? "medium"
          : "low",
    fallback: identity.fallback
  };
}

function createSegmentsFromParsedAsset(parsed: ParsedAssetName, options: BatchMergeOptions): EpisodeSegment[] {
  if (parsed.episodeEnd > parsed.episodeStart) {
    return splitRangeAsset(parsed, options.rangeSplit ?? { mode: "auto" }, options.cutMarkers ?? []);
  }
  const windowed = applySegmentWindow(parsed.asset, options.segmentWindow ?? { mode: "full" }, options.cutMarkers ?? []);
  return [
    {
      seasonNumber: parsed.seasonNumber,
      episodeNumber: parsed.episodeStart,
      sourceOrder: parsed.sourceOrder,
      partNumber: parsed.partNumber,
      sourceFileName: parsed.asset.fileName,
      entries: windowed.entries,
      durationMs: windowed.durationMs,
      warnings: uniqueStrings([
        ...(parsed.fallback ? [`${parsed.asset.fileName} 未识别到集数，已按导入顺序处理。`] : []),
        ...windowed.warnings
      ])
    }
  ];
}

function splitRangeAsset(parsed: ParsedAssetName, splitRule: RangeSplitRule, cutMarkers: CutMarker[]): EpisodeSegment[] {
  const episodeCount = parsed.episodeEnd - parsed.episodeStart + 1;
  const timedEntries = createTimedEntries(parsed.asset.items, cutMarkers);
  const boundaries = inferRangeBoundaries(parsed, timedEntries, episodeCount, splitRule);
  const segments: EpisodeSegment[] = [];
  for (let index = 0; index < episodeCount; index += 1) {
    const startMs = boundaries[index];
    const endMs = boundaries[index + 1];
    const episodeNumber = parsed.episodeStart + index;
    const entries = timedEntries.filter((entry) =>
      index === episodeCount - 1
        ? entry.mappedTimeMs >= startMs && entry.mappedTimeMs <= endMs
        : entry.mappedTimeMs >= startMs && entry.mappedTimeMs < endMs
    );
    const warnings = [...boundaries.warnings];
    if (entries.length === 0) {
      warnings.push(`${parsed.asset.fileName} 的第 ${episodeNumber} 集切片没有弹幕。`);
    }
    segments.push({
      seasonNumber: parsed.seasonNumber,
      episodeNumber,
      sourceOrder: parsed.sourceOrder,
      partNumber: index + 1,
      sourceFileName: parsed.asset.fileName,
      entries: entries.map((entry) => ({
        item: entry.item,
        finalTimeMs: clampMilliseconds(entry.mappedTimeMs - startMs)
      })),
      durationMs: clampMilliseconds(endMs - startMs),
      warnings
    });
  }
  return segments;
}

function createEpisodeDraft(segments: EpisodeSegment[], hasMultipleSeasons: boolean): BatchMergeEpisode {
  const sortedSegments = [...segments].sort(
    (left, right) =>
      left.sourceOrder - right.sourceOrder || (left.partNumber ?? 0) - (right.partNumber ?? 0) || left.sourceFileName.localeCompare(right.sourceFileName, "zh-CN")
  );
  const entries = appendSegments(sortedSegments);
  const first = sortedSegments[0];
  const sourceFileNames = Array.from(new Set(sortedSegments.map((segment) => segment.sourceFileName)));
  return {
    id: createEpisodeKey(first.seasonNumber, first.episodeNumber),
    seasonNumber: first.seasonNumber,
    episodeNumber: first.episodeNumber,
    label: formatEpisodeLabel(first.seasonNumber, first.episodeNumber, hasMultipleSeasons),
    fileName: formatEpisodeFileName(first.seasonNumber, first.episodeNumber, hasMultipleSeasons),
    sourceFileNames,
    itemCount: entries.length,
    entries,
    warnings: Array.from(new Set(sortedSegments.flatMap((segment) => segment.warnings)))
  };
}

function appendSegments(segments: EpisodeSegment[]): BatchMergeEntry[] {
  const entries: BatchMergeEntry[] = [];
  let cursor = 0;
  for (const segment of segments) {
    let segmentMax = 0;
    const sortedEntries = [...segment.entries].sort(
      (left, right) => left.finalTimeMs - right.finalTimeMs || left.item.originalIndex - right.item.originalIndex
    );
    for (const entry of sortedEntries) {
      const finalTimeMs = clampMilliseconds(entry.finalTimeMs + cursor);
      segmentMax = Math.max(segmentMax, entry.finalTimeMs);
      entries.push({
        item: entry.item,
        finalTimeMs
      });
    }
    cursor += Math.max(0, segment.durationMs ?? segmentMax);
  }
  return entries;
}

function applySegmentWindow(
  asset: DanmakuAsset,
  rule: SegmentWindowRule,
  cutMarkers: CutMarker[]
): { entries: BatchMergeEntry[]; durationMs: Milliseconds | null; warnings: string[] } {
  const warnings: string[] = [];
  let sourceStart = asset.items.length > 0 ? Infinity : 0;
  let sourceEnd = 0;
  for (const item of asset.items) {
    sourceStart = Math.min(sourceStart, item.sourceTimeMs);
    sourceEnd = Math.max(sourceEnd, item.sourceTimeMs);
  }
  const knownDuration = getKnownBilibiliDuration(asset);
  const knownEnd = knownDuration !== null ? Math.max(knownDuration, sourceEnd + 1) : null;
  const window = knownEnd !== null && rule.mode === "full"
    ? { startMs: 0, endMs: knownEnd }
    : knownEnd !== null && rule.mode === "suffix"
      ? { startMs: Math.max(0, knownEnd - rule.durationMs), endMs: knownEnd }
      : resolveSegmentWindow(rule, sourceStart, sourceEnd);
  if (window.endMs <= window.startMs) {
    return {
      entries: [],
      durationMs: 0,
      warnings: [`${asset.fileName} 的人工截取范围为空。`]
    };
  }
  const mappedStartMs = applyCutMapping(window.startMs, cutMarkers);
  const mappedEndMs = applyCutMapping(window.endMs, cutMarkers);
  const entries = asset.items
    .filter((item) => item.sourceTimeMs >= window.startMs && item.sourceTimeMs < window.endMs)
    .map((item) => ({
      item,
      finalTimeMs: clampMilliseconds(applyCutMapping(item.sourceTimeMs, cutMarkers) - mappedStartMs)
    }));
  if (entries.length === 0 && asset.items.length > 0) {
    warnings.push(`${asset.fileName} 的人工截取范围内没有弹幕。`);
  }
  return {
    entries,
    durationMs: rule.mode === "full" && knownEnd === null ? null : clampMilliseconds(mappedEndMs - mappedStartMs),
    warnings
  };
}

function resolveSegmentWindow(
  rule: SegmentWindowRule,
  sourceStart: Milliseconds,
  sourceEnd: Milliseconds
): { startMs: Milliseconds; endMs: Milliseconds } {
  if (rule.mode === "prefix") {
    return {
      startMs: 0,
      endMs: clampMilliseconds(rule.durationMs)
    };
  }
  if (rule.mode === "suffix") {
    const durationMs = clampMilliseconds(rule.durationMs);
    return {
      startMs: Math.max(0, sourceEnd - durationMs),
      endMs: sourceEnd + 1
    };
  }
  if (rule.mode === "range") {
    return {
      startMs: clampMilliseconds(rule.startMs),
      endMs: clampMilliseconds(rule.endMs)
    };
  }
  return {
    startMs: sourceStart,
    endMs: sourceEnd + 1
  };
}

function inferRangeBoundaries(
  parsed: ParsedAssetName,
  timedEntries: TimedEntry[],
  segmentCount: number,
  splitRule: RangeSplitRule
): (Milliseconds[] & { warnings: string[] }) {
  const warnings: string[] = [];
  if (timedEntries.length === 0) {
    const emptyBoundaries = Array.from({ length: segmentCount + 1 }, () => 0) as Milliseconds[] & {
      warnings: string[];
    };
    emptyBoundaries.warnings = ["范围文件没有可切分的弹幕。"];
    return emptyBoundaries;
  }
  const sortedTimes = timedEntries.map((entry) => entry.mappedTimeMs).sort((left, right) => left - right);
  const start = sortedTimes[0];
  const end = sortedTimes[sortedTimes.length - 1];
  const manualBoundaries = createManualRangeBoundaries(parsed, start, end, segmentCount, splitRule);
  if (manualBoundaries) {
    return manualBoundaries;
  }
  const duration = Math.max(1, end - start);
  const expectedSegment = duration / segmentCount;
  const boundaries: Milliseconds[] = [start];
  const usedGapIndexes = new Set<number>();
  for (let index = 1; index < segmentCount; index += 1) {
    const expected = start + expectedSegment * index;
    const windowSize = expectedSegment * 0.35;
    const gap = findBoundaryGap(sortedTimes, expected, windowSize, usedGapIndexes);
    if (gap) {
      usedGapIndexes.add(gap.index);
      boundaries.push(clampMilliseconds(gap.boundaryMs));
      continue;
    }
    boundaries.push(clampMilliseconds(expected));
    warnings.push("未找到足够明显的集间空隙，已按时长均分切分。");
  }
  boundaries.push(end + 1);
  const result = boundaries as Milliseconds[] & { warnings: string[] };
  result.warnings = Array.from(new Set(warnings));
  return result;
}

function createManualRangeBoundaries(
  parsed: ParsedAssetName,
  startMs: Milliseconds,
  endMs: Milliseconds,
  segmentCount: number,
  splitRule: RangeSplitRule
): (Milliseconds[] & { warnings: string[] }) | null {
  if (splitRule.mode === "manualCutPoints") {
    const cutPoints = splitRule.cutPointsMs
      .map(clampMilliseconds)
      .filter((timeMs) => timeMs > startMs && timeMs < endMs)
      .sort((left, right) => left - right)
      .slice(0, Math.max(0, segmentCount - 1));
    if (cutPoints.length < segmentCount - 1) {
      return null;
    }
    const result = [startMs, ...cutPoints, endMs + 1] as Milliseconds[] & { warnings: string[] };
    result.warnings = ["已使用人工切点切分长合集。"];
    return result;
  }
  if (splitRule.mode !== "episodeDurations") {
    return null;
  }
  const durations = getDurationsForRange(parsed, splitRule.episodes, segmentCount);
  if (durations.length < segmentCount) {
    return null;
  }
  const boundaries: Milliseconds[] = [startMs];
  let cursor = startMs;
  for (const durationMs of durations) {
    cursor += durationMs;
    boundaries.push(cursor);
  }
  const warnings =
    cursor < endMs
      ? ["已按真实集时长切分；最后一个切点之后的长合集尾部内容会被丢弃。"]
      : ["已按真实集时长切分。"];
  const result = boundaries as Milliseconds[] & { warnings: string[] };
  result.warnings = warnings;
  return result;
}

function getDurationsForRange(
  parsed: ParsedAssetName,
  metadata: EpisodeDurationMetadata[],
  segmentCount: number
): Milliseconds[] {
  const episodeNumbers = Array.from({ length: segmentCount }, (_, index) => parsed.episodeStart + index);
  const exactDurations = episodeNumbers.map((episodeNumber) => {
    const match = metadata.find(
      (episode) =>
        episode.episodeNumber === episodeNumber &&
        (episode.seasonNumber === null || parsed.seasonNumber === null || episode.seasonNumber === parsed.seasonNumber)
    );
    return match?.durationMs ?? null;
  });
  if (exactDurations.every((duration): duration is Milliseconds => duration !== null && duration > 0)) {
    return exactDurations;
  }
  if (parsed.seasonNumber === null) {
    const indexedDurations = episodeNumbers
      .map((episodeNumber) => metadata[episodeNumber - 1]?.durationMs ?? null)
      .filter((duration): duration is Milliseconds => duration !== null && duration > 0);
    if (indexedDurations.length >= segmentCount) {
      return indexedDurations.slice(0, segmentCount);
    }
  }
  return metadata
    .map((episode) => episode.durationMs)
    .filter((durationMs) => durationMs > 0)
    .slice(0, segmentCount);
}

function findBoundaryGap(
  sortedTimes: Milliseconds[],
  expectedBoundaryMs: number,
  windowSizeMs: number,
  usedGapIndexes: Set<number>
): { index: number; boundaryMs: number } | null {
  let best: { index: number; boundaryMs: number; score: number } | null = null;
  for (let index = 0; index < sortedTimes.length - 1; index += 1) {
    if (usedGapIndexes.has(index)) {
      continue;
    }
    const left = sortedTimes[index];
    const right = sortedTimes[index + 1];
    const gap = right - left;
    const boundaryMs = (left + right) / 2;
    const distance = Math.abs(boundaryMs - expectedBoundaryMs);
    if (distance > windowSizeMs || gap < 60_000) {
      continue;
    }
    const score = gap - distance * 0.2;
    if (!best || score > best.score) {
      best = { index, boundaryMs, score };
    }
  }
  return best ? { index: best.index, boundaryMs: best.boundaryMs } : null;
}

function createEpisodeKey(seasonNumber: number | null, episodeNumber: number): string {
  return `${seasonNumber ?? "s"}:${episodeNumber}`;
}

function formatEpisodeLabel(seasonNumber: number | null, episodeNumber: number, hasMultipleSeasons: boolean): string {
  if (hasMultipleSeasons && seasonNumber !== null) {
    return `第 ${seasonNumber} 季 第 ${episodeNumber} 集`;
  }
  return `第 ${episodeNumber} 集`;
}

function formatEpisodeFileName(seasonNumber: number | null, episodeNumber: number, hasMultipleSeasons: boolean): string {
  if (hasMultipleSeasons && seasonNumber !== null) {
    return `S${seasonNumber.toString().padStart(2, "0")}E${episodeNumber.toString().padStart(2, "0")}.xml`;
  }
  return `${episodeNumber} - ${episodeNumber}.xml`;
}

function createDiagnostics(
  parsedAssets: ParsedAssetName[],
  episodes: BatchMergeEpisode[],
  compensation: BatchMergeCompensationSummary
): string[] {
  const diagnostics = [
    `识别到 ${episodes.length} 个分集输出，来源 ${parsedAssets.length} 个 XML。`,
    "合并策略：追加式，后一个分 P 的时间整体接到前一个分 P 最后一条弹幕之后。"
  ];
  const fallbackCount = parsedAssets.filter((asset) => asset.fallback).length;
  if (fallbackCount > 0) {
    diagnostics.push(`${fallbackCount} 个文件未识别到集数，已按导入顺序兜底。`);
  }
  const rangeCount = parsedAssets.filter((asset) => asset.episodeEnd > asset.episodeStart).length;
  if (rangeCount > 0) {
    diagnostics.push(`${rangeCount} 个多集范围文件已按集数切分，优先寻找集间空隙，找不到时按时长均分。`);
  }
  if (compensation.markerCount > 0) {
    diagnostics.push(
      `已应用 ${compensation.markerCount} 个版本差异，累计调整 ${formatDurationMs(compensation.totalGapMs)}，影响 ${compensation.affectedEpisodeCount} 个分集输出。`
    );
  }
  return diagnostics;
}

function mergeConfidence(values: BatchMergeConfidence[]): BatchMergeConfidence {
  if (values.includes("low")) {
    return "low";
  }
  if (values.includes("medium")) {
    return "medium";
  }
  return "high";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function createTimedEntries(items: DanmakuItem[], cutMarkers: CutMarker[]): TimedEntry[] {
  return items
    .map((item) => ({
      item,
      mappedTimeMs: applyCutMapping(item.sourceTimeMs, cutMarkers)
    }))
    .sort(
      (left, right) =>
        left.mappedTimeMs - right.mappedTimeMs || left.item.originalIndex - right.item.originalIndex
    );
}

function createCompensationSummary(
  episodes: BatchMergeEpisode[],
  cutMarkers: CutMarker[]
): BatchMergeCompensationSummary {
  const affectedEpisodes = episodes.filter((episode) =>
    episode.entries.some((entry) => getAppliedCutGap(entry.item.sourceTimeMs, cutMarkers) !== 0)
  );
  return {
    markerCount: cutMarkers.length,
    totalGapMs: cutMarkers.reduce((sum, marker) => sum + marker.targetGapMs, 0),
    affectedEntryCount: episodes.reduce(
      (count, episode) =>
        count + episode.entries.filter((entry) => getAppliedCutGap(entry.item.sourceTimeMs, cutMarkers) !== 0).length,
      0
    ),
    affectedEpisodeCount: affectedEpisodes.length
  };
}

function formatDurationMs(durationMs: Milliseconds): string {
  const sign = durationMs < 0 ? "-" : "";
  const absoluteMs = Math.abs(durationMs);
  const totalSeconds = Math.floor(absoluteMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${minutes}:${seconds.toString().padStart(2, "0")}`;
}
