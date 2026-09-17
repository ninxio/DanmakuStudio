import type { BatchMergeOptions } from "../../domain/danmaku/batchMerge";
import {
  parseCutPointsText,
  parseEpisodeDurationsText,
  parseMinutesInput
} from "../../domain/danmaku/manualRules";

export type PartWindowMode = "full" | "prefix" | "suffix" | "range";
export type LongSplitMode = "auto" | "durations" | "cuts";

export function createBatchMergeOptions({
  partWindowMode,
  partWindowMinutes,
  partRangeStartMinutes,
  partRangeEndMinutes,
  longSplitMode,
  episodeDurationsText,
  cutPointsText
}: {
  partWindowMode: PartWindowMode;
  partWindowMinutes: string;
  partRangeStartMinutes: string;
  partRangeEndMinutes: string;
  longSplitMode: LongSplitMode;
  episodeDurationsText: string;
  cutPointsText: string;
}): { options: BatchMergeOptions; warnings: string[] } {
  const options: BatchMergeOptions = {};
  const warnings: string[] = [];
  if (partWindowMode === "prefix" || partWindowMode === "suffix") {
    const durationMs = parseMinutesInput(partWindowMinutes);
    if (durationMs === null || durationMs <= 0) {
      warnings.push("每分 P 的 N 分钟必须是大于 0 的数字。");
    } else {
      options.segmentWindow = { mode: partWindowMode, durationMs };
    }
  }
  if (partWindowMode === "range") {
    const startMs = parseMinutesInput(partRangeStartMinutes);
    const endMs = parseMinutesInput(partRangeEndMinutes);
    if (startMs === null || endMs === null || endMs <= startMs) {
      warnings.push("统一起止分钟需要填写有效的开始和结束。");
    } else {
      options.segmentWindow = { mode: "range", startMs, endMs };
    }
  }
  if (longSplitMode === "durations") {
    const parsed = parseEpisodeDurationsText(episodeDurationsText);
    warnings.push(...parsed.warnings);
    if (parsed.episodes.length > 0) {
      options.rangeSplit = { mode: "episodeDurations", episodes: parsed.episodes };
    }
  }
  if (longSplitMode === "cuts") {
    const parsed = parseCutPointsText(cutPointsText);
    warnings.push(...parsed.warnings);
    if (parsed.cutPointsMs.length > 0) {
      options.rangeSplit = { mode: "manualCutPoints", cutPointsMs: parsed.cutPointsMs };
    }
  }
  return { options, warnings };
}
