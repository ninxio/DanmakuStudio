import type { EditorProject } from "../project/types";
import { getKnownBilibiliDuration } from "../danmaku/bilibiliAcquisition";
import { applyCutMapping } from "../danmaku/timeCompensation";

/** Do not turn the last comment or a UI viewport extent into a media duration. */
export function getXmlExportDuration(project: EditorProject): number | null {
  const clips = project.clips.filter((clip) => clip.enabled);
  if (!clips.length) return null;
  let end = 0;
  for (const clip of clips) {
    const asset = project.assets.find((a) => a.id === clip.assetId);
    const known = asset ? getKnownBilibiliDuration(asset) : null;
    if (known === null || clip.sourceOutMs > known) return null;
    end = Math.max(
      end,
      applyCutMapping(
        clip.timelineStartMs +
          clip.sourceOutMs -
          clip.sourceInMs +
          clip.localOffsetMs +
          project.globalOffsetMs,
        project.cutMarkers
      )
    );
  }
  return Number.isSafeInteger(end) && end >= 0 ? end : null;
}
