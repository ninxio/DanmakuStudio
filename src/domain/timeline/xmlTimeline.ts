import type { EditorProject } from "../project/types";
import { getKnownBilibiliDuration } from "../danmaku/bilibiliAcquisition";
import { createId } from "../project/factory";
import { isXmlOnlyProject } from "../project/workflowMode";
import { getAssetTimeRange, getClipDurationMs } from "./mapping";

/** Asset membership is distinct from clip count: a split asset may own many clips. */
export function inspectXmlTimeline(project: Pick<EditorProject, "assets" | "clips">) {
  const placed = new Set(project.clips.map((clip) => clip.assetId));
  const enabled = new Set(
    project.clips.filter((clip) => clip.enabled).map((clip) => clip.assetId)
  );
  const unplacedAssets = project.assets.filter((asset) => !placed.has(asset.id));
  return {
    assetCount: project.assets.length,
    placedAssetCount: project.assets.length - unplacedAssets.length,
    disabledAssetCount: project.assets.filter(
      (asset) => placed.has(asset.id) && !enabled.has(asset.id)
    ).length,
    unplacedAssets
  };
}

/**
 * Explicit intake into the XML editor, never a replacement for rearranging clips.
 * New files retain their zero origin. Existing edits and disabled/split clips are
 * preserved, including their occupied space. Downloaded P use their known playback
 * duration; ordinary XML falls back to the last comment (exclusive end).
 */
export function appendUnplacedXmlAssets(
  project: EditorProject,
  nextClipId: () => string = () => createId("clip")
): EditorProject {
  if (!isXmlOnlyProject(project)) {
    throw new Error("视频对齐项目请在编辑工作台处理时间关系。");
  }
  const { unplacedAssets } = inspectXmlTimeline(project);
  if (unplacedAssets.length === 0) return project;
  let cursor = project.clips.reduce(
    (end, clip) =>
      Math.max(end, clip.timelineStartMs + clip.localOffsetMs + getClipDurationMs(clip)),
    0
  );
  const additions = unplacedAssets.map((asset) => {
    const sourceOutMs = Math.max(1, getKnownBilibiliDuration(asset) ?? 0, getAssetTimeRange(asset).latestMs + 1);
    const end = cursor + sourceOutMs;
    if (!Number.isSafeInteger(end) || !Number.isSafeInteger(cursor)) {
      throw new Error("时间线超出安全毫秒范围，请先调整片段位置。");
    }
    const clip = {
      id: nextClipId(),
      assetId: asset.id,
      name: asset.name,
      timelineStartMs: cursor,
      sourceInMs: 0,
      sourceOutMs,
      localOffsetMs: 0,
      enabled: true
    };
    cursor = end;
    return clip;
  });
  return { ...project, clips: [...project.clips, ...additions] };
}
