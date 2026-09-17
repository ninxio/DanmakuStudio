import type {
  CutMarker,
  DanmakuAsset,
  DanmakuClip,
  DanmakuItem,
  ResolvedDanmakuEvent
} from "../danmaku/types";
import type { EditorProject } from "../project/types";
import type { Milliseconds } from "../shared/time";
import { clampMilliseconds } from "../shared/time";
export { applyCutMapping } from "../danmaku/timeCompensation";
import { applyCutMapping } from "../danmaku/timeCompensation";

export interface EditTimingState {
  globalOffsetMs: Milliseconds;
  cutMarkers: CutMarker[];
  itemTimeAdjustments: Record<string, Milliseconds>;
}

export function getResolvedDanmakuTime(
  item: DanmakuItem,
  clip: DanmakuClip,
  editState: EditTimingState
): Milliseconds {
  const clipRelativeMs = item.sourceTimeMs - clip.sourceInMs;
  const itemAdjustmentMs = editState.itemTimeAdjustments[item.id] ?? 0;
  const beforeCuts =
    clip.timelineStartMs +
    clipRelativeMs +
    clip.localOffsetMs +
    itemAdjustmentMs +
    editState.globalOffsetMs;
  return applyCutMapping(beforeCuts, editState.cutMarkers);
}

export function isItemInsideClip(item: DanmakuItem, clip: DanmakuClip): boolean {
  return item.sourceTimeMs >= clip.sourceInMs && item.sourceTimeMs < clip.sourceOutMs;
}

export function getAssetTimeRange(asset: DanmakuAsset): {
  earliestMs: Milliseconds;
  latestMs: Milliseconds;
} {
  if (asset.items.length === 0) {
    return { earliestMs: 0, latestMs: 0 };
  }
  let earliestMs = Number.POSITIVE_INFINITY;
  let latestMs = 0;
  for (const item of asset.items) {
    earliestMs = Math.min(earliestMs, item.sourceTimeMs);
    latestMs = Math.max(latestMs, item.sourceTimeMs);
  }
  return { earliestMs, latestMs };
}

export function getClipDurationMs(clip: DanmakuClip): Milliseconds {
  return Math.max(0, clip.sourceOutMs - clip.sourceInMs);
}

export function resolveProjectDanmakuEvents(
  project: Pick<
    EditorProject,
    | "assets"
    | "clips"
    | "disabledItemIds"
    | "globalOffsetMs"
    | "cutMarkers"
    | "itemTimeAdjustments"
  >
): ResolvedDanmakuEvent[] {
  const disabled = new Set(project.disabledItemIds);
  const events: ResolvedDanmakuEvent[] = [];
  for (const clip of project.clips) {
    if (!clip.enabled) {
      continue;
    }
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    if (!asset) {
      continue;
    }
    for (const item of asset.items) {
      if (!isItemInsideClip(item, clip)) {
        continue;
      }
      const enabled = item.enabled && !disabled.has(item.id);
      events.push({
        id: `${clip.id}:${item.id}`,
        item,
        clip,
        asset,
        finalTimeMs: getResolvedDanmakuTime(item, clip, project),
        originalIndex: item.originalIndex,
        enabled
      });
    }
  }
  events.sort((a, b) => a.finalTimeMs - b.finalTimeMs || a.originalIndex - b.originalIndex);
  return events;
}

type DurationCache = {
  assets: EditorProject["assets"];
  cuts: EditorProject["cutMarkers"];
  adjustments: EditorProject["itemTimeAdjustments"];
  offset: number;
  mediaEnd: number;
  value: number;
};
const durationCache = new WeakMap<EditorProject["clips"], DurationCache>();

export function getProjectDurationMs(project: EditorProject): Milliseconds {
  const mediaEnd = project.media?.durationMs ?? 0;
  const cached = durationCache.get(project.clips);
  if (
    cached &&
    cached.assets === project.assets &&
    cached.cuts === project.cutMarkers &&
    cached.adjustments === project.itemTimeAdjustments &&
    cached.offset === project.globalOffsetMs &&
    cached.mediaEnd === mediaEnd
  )
    return cached.value;
  const clipEnd = project.clips.reduce(
    (max, clip) =>
      Math.max(max, clip.timelineStartMs + getClipDurationMs(clip) + clip.localOffsetMs),
    0
  );
  const eventEnd = resolveProjectDanmakuEvents(project).reduce(
    (max, event) => Math.max(max, clampMilliseconds(event.finalTimeMs)),
    0
  );
  const value = Math.max(60_000, clipEnd, eventEnd, mediaEnd);
  durationCache.set(project.clips, {
    assets: project.assets,
    cuts: project.cutMarkers,
    adjustments: project.itemTimeAdjustments,
    offset: project.globalOffsetMs,
    mediaEnd,
    value
  });
  return value;
}
