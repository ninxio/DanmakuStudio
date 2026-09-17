import type { DanmakuItem } from "../danmaku/types";
import type { EditorProject, MediaTimeMap } from "../project/types";
import { compileTimeMap } from "../alignment/timeMap";
import { ROLLING_DANMAKU_DURATION_MS, STATIC_DANMAKU_DURATION_MS } from "./visibleEvents";

export interface PreviewComment {
  id: string;
  item: DanmakuItem;
  finalTimeMs: number;
  originalIndex: number;
  enabled: boolean;
}

/** Draft visualization only: no receipt, acceptance, or export authority is created. */
export function createRelationDanmakuTracks(
  project: Pick<EditorProject, "assets" | "danmakuSourceBindings" | "disabledItemIds">,
  timeMap: Pick<MediaTimeMap, "spans">,
  sourceMediaId: string
) {
  const bound = new Set(
    project.danmakuSourceBindings
      .filter((b) => b.sourceMediaId === sourceMediaId)
      .map((b) => b.assetId)
  );
  const disabled = new Set(project.disabledItemIds);
  const source: PreviewComment[] = [];
  const target: PreviewComment[] = [];
  const map = compileTimeMap(timeMap.spans);
  let uncertain = 0;
  for (const asset of project.assets) {
    if (!bound.has(asset.id)) continue;
    for (const item of asset.items) {
      if (!item.enabled || disabled.has(item.id)) continue;
      const event = {
        id: item.id,
        item,
        finalTimeMs: item.sourceTimeMs,
        originalIndex: item.originalIndex,
        enabled: true
      };
      source.push(event);
      const mapped = map.mapSourceTime(item.sourceTimeMs);
      if (mapped.status === "mapped")
        target.push({ ...event, finalTimeMs: mapped.targetTimeMs });
      else uncertain++;
    }
  }
  source.sort((a, b) => a.finalTimeMs - b.finalTimeMs);
  target.sort((a, b) => a.finalTimeMs - b.finalTimeMs);
  return { source, target, uncertain };
}

export function previewCommentDuration(item: DanmakuItem): number {
  return item.mode === 4 || item.mode === 5
    ? STATIC_DANMAKU_DURATION_MS
    : ROLLING_DANMAKU_DURATION_MS;
}

/** Binary window lookup keeps UI playback independent of the size of the imported family. */
export function visiblePreviewComments(
  events: readonly PreviewComment[],
  time: number
): PreviewComment[] {
  let low = 0,
    high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].finalTimeMs < time - ROLLING_DANMAKU_DURATION_MS) low = mid + 1;
    else high = mid;
  }
  const result: PreviewComment[] = [];
  for (
    let i = low;
    i < events.length && events[i].finalTimeMs <= time && result.length < 80;
    i++
  ) {
    const event = events[i];
    if (event.enabled && time < event.finalTimeMs + previewCommentDuration(event.item))
      result.push(event);
  }
  return result;
}

/** One bounded ASS document per edit, never one IPC command per rendered comment/frame. */
export function serializePreviewAss(events: readonly PreviewComment[], opacity = 1): string {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Danmaku,Microsoft YaHei,32,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,1.5,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, "0");
  const lines: string[] = [header];
  let bytes = header.length;
  let lane = 0;
  for (const event of events) {
    if (!event.enabled || !Number.isSafeInteger(event.finalTimeMs) || event.finalTimeMs < 0)
      continue;
    const item = event.item;
    const y = 38 + (lane++ % 10) * 44;
    const rgb = (item.color ?? 0xffffff) >>> 0;
    const bgr = ((rgb & 255) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 255);
    const fs = Math.round(Math.min(48, Math.max(18, (item.fontSize ?? 25) * 1.28)));
    const movement =
      item.mode === 5
        ? `\\an8\\pos(640,${y})`
        : item.mode === 4
          ? `\\an2\\pos(640,${720 - y})`
          : item.mode === 6
            ? `\\an7\\move(-400,${y},1280,${y})`
            : `\\an7\\move(1280,${y},-${Math.max(400, item.text.length * fs)},${y})`;
    // Fullwidth syntax characters render literally without allowing XML text to inject ASS tags.
    const text = item.text
      .replace(/\\/g, "＼")
      .replace(/\{/g, "｛")
      .replace(/\}/g, "｝")
      .replace(/[\r\n]+/g, " ");
    const line = `Dialogue: 0,${assTime(event.finalTimeMs)},${assTime(event.finalTimeMs + previewCommentDuration(item))},Danmaku,,0,0,0,,{${movement}\\fs${fs}\\c&H${bgr.toString(16).padStart(6, "0")}&\\alpha&H${alpha}&}${text}\n`;
    bytes += new TextEncoder().encode(line).length;
    if (bytes > 8 * 1024 * 1024)
      throw new Error("弹幕预览轨超过 8 MiB，请缩小来源范围后预览；导出内容未改变。");
    lines.push(line);
  }
  return lines.join("");
}
function assTime(ms: number): string {
  const cs = Math.floor(ms / 10);
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}
