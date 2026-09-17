import { designTokenColor } from "../../../components/designTokens";
import type {
  AlignmentPreviewAnchor,
  AlignmentPreviewCutCandidate,
  AlignmentPreviewModel
} from "../../../domain/alignment/preview";
import {
  isSuspectedCutCandidateApplied,
  type SuspectedCutCandidate
} from "../../../domain/danmaku/cutHints";
import type { CutMarker, DanmakuClip, ResolvedDanmakuEvent } from "../../../domain/danmaku/types";
import type { EditorProject, EditorSelection } from "../../../domain/project/types";
import { clamp, formatTimecode, type Milliseconds } from "../../../domain/shared/time";
import { getClipDurationMs } from "../../../domain/timeline/mapping";
import { aggregateDensity, chooseBucketSizeMs } from "../../../domain/timeline/search";

export const TIMELINE_LABEL_WIDTH = 104;

export type TimelineEdgeFeedback = "start" | "end" | null;

export interface TimelineTracks {
  ruler: TimelineTrackRect;
  video: TimelineTrackRect;
  cuts: TimelineTrackRect;
  clips: TimelineTrackRect;
  density: TimelineTrackRect;
  events: TimelineTrackRect;
}

export interface TimelineTrackRect {
  y: number;
  height: number;
}

export interface TimelineCanvasFrame {
  width: number;
  height: number;
  project: EditorProject;
  tracks: TimelineTracks;
  visibleEvents: ResolvedDanmakuEvent[];
  allEvents: ResolvedDanmakuEvent[];
  selection: EditorSelection;
  boxPreview: { startX: number; currentX: number } | null;
  edgeFeedback: TimelineEdgeFeedback;
  alignmentPreview: AlignmentPreviewModel;
  suspectedCutCandidates: SuspectedCutCandidate[];
}

export function drawTimelineCanvas(
  context: CanvasRenderingContext2D,
  props: TimelineCanvasFrame
): void {
  const {
    width,
    height,
    project,
    tracks,
    visibleEvents,
    allEvents,
    selection,
    boxPreview,
    edgeFeedback,
    alignmentPreview,
    suspectedCutCandidates
  } = props;
  context.clearRect(0, 0, width, height);
  context.fillStyle = designTokenColor("surface-canvas");
  context.fillRect(0, 0, width, height);
  drawTrack(context, tracks.ruler, width, "时间标尺");
  drawTrack(context, tracks.video, width, "视频轨道");
  drawTrack(context, tracks.cuts, width, "版本差异");
  drawTrack(context, tracks.clips, width, "弹幕片段");
  drawTrack(context, tracks.density, width, "密度热力图");
  drawTrack(context, tracks.events, width, "弹幕事件");
  drawRuler(
    context,
    width,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    tracks.ruler
  );
  drawVideoTrack(context, project, tracks.video);
  drawClips(context, project.clips, project, tracks.clips, selection);
  drawDensity(
    context,
    allEvents,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    width,
    tracks.density
  );
  drawEvents(
    context,
    visibleEvents,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    tracks.events,
    selection
  );
  drawSuspectedCutHints(
    context,
    suspectedCutCandidates,
    project.cutMarkers,
    tracks,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    width,
    height
  );
  drawCutMarkers(
    context,
    project.cutMarkers,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    tracks.cuts,
    selection
  );
  drawAlignmentPreview(
    context,
    alignmentPreview,
    tracks,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    width,
    height
  );
  drawPlayhead(
    context,
    project.timeline.playheadMs,
    project.timeline.scrollMs,
    project.timeline.pixelsPerSecond,
    height
  );
  drawEdgeFeedback(context, edgeFeedback, width, height);
  if (boxPreview) {
    context.fillStyle = designTokenColor("feedback-running", 0.16);
    context.strokeStyle = designTokenColor("feedback-running", 0.9);
    const left = Math.min(boxPreview.startX, boxPreview.currentX);
    const boxWidth = Math.abs(boxPreview.currentX - boxPreview.startX);
    context.fillRect(left, tracks.events.y, boxWidth, tracks.events.height);
    context.strokeRect(left, tracks.events.y + 1, boxWidth, tracks.events.height - 2);
  }
}

export function createTimelineTracks(height: number): TimelineTracks {
  const ruler = { y: 0, height: 28 };
  const video = { y: 28, height: 34 };
  const cuts = { y: 62, height: 36 };
  const clips = { y: 98, height: 62 };
  const density = { y: 160, height: 52 };
  const events = { y: 212, height: Math.max(48, height - 212) };
  return { ruler, video, cuts, clips, density, events };
}

function drawTrack(
  context: CanvasRenderingContext2D,
  track: TimelineTrackRect,
  width: number,
  label: string
): void {
  context.fillStyle = track.y % 2 === 0 ? designTokenColor("surface-base") : designTokenColor("timeline-track-alternate");
  context.fillRect(0, track.y, width, track.height);
  context.strokeStyle = designTokenColor("boundary-default");
  context.beginPath();
  context.moveTo(0, track.y + track.height);
  context.lineTo(width, track.y + track.height);
  context.stroke();
  context.fillStyle = designTokenColor("timeline-label");
  context.font = "12px Segoe UI";
  context.fillText(label, 12, track.y + Math.min(22, track.height - 8));
  context.fillStyle = designTokenColor("surface-soft");
  context.fillRect(TIMELINE_LABEL_WIDTH - 1, track.y, 1, track.height);
}

function drawRuler(
  context: CanvasRenderingContext2D,
  width: number,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  track: TimelineTrackRect
): void {
  const visibleMs = ((width - TIMELINE_LABEL_WIDTH) * 1000) / pixelsPerSecond;
  const step = chooseTickStep(pixelsPerSecond);
  const first = Math.floor(scrollMs / step) * step;
  context.strokeStyle = designTokenColor("timeline-guide");
  context.fillStyle = designTokenColor("timeline-axis-text");
  context.font = "11px ui-monospace, Consolas";
  for (let time = first; time <= scrollMs + visibleMs + step; time += step) {
    const x = timelineTimeToX(time, scrollMs, pixelsPerSecond);
    if (x < TIMELINE_LABEL_WIDTH) {
      continue;
    }
    context.beginPath();
    context.moveTo(x, track.y + 4);
    context.lineTo(x, track.y + track.height);
    context.stroke();
    context.fillText(formatTimecode(time), x + 4, track.y + 18);
  }
}

function drawVideoTrack(
  context: CanvasRenderingContext2D,
  project: EditorProject,
  track: TimelineTrackRect
): void {
  const media =
    project.media ??
    project.mediaLibrary.find((candidate) => candidate.role === "bilibiliReference") ??
    project.mediaLibrary.find((candidate) => candidate.role === "targetOriginal") ??
    null;
  const duration = media?.durationMs ?? 0;
  if (duration <= 0) {
    context.fillStyle = designTokenColor("content-subtle");
    context.font = "12px Segoe UI";
    context.fillText("导入参考视频后显示素材长度", TIMELINE_LABEL_WIDTH + 12, track.y + 22);
    return;
  }
  const x = timelineTimeToX(0, project.timeline.scrollMs, project.timeline.pixelsPerSecond);
  const width = (duration / 1000) * project.timeline.pixelsPerSecond;
  context.fillStyle = designTokenColor("timeline-video");
  context.fillRect(Math.max(TIMELINE_LABEL_WIDTH, x), track.y + 7, width, track.height - 14);
  context.fillStyle = designTokenColor("timeline-video-text");
  context.font = "12px Segoe UI";
  context.fillText(
    media?.fileName ?? "视频",
    Math.max(TIMELINE_LABEL_WIDTH + 8, x + 8),
    track.y + 22
  );
}

function drawCutMarkers(
  context: CanvasRenderingContext2D,
  markers: CutMarker[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  track: TimelineTrackRect,
  selection: EditorSelection
): void {
  for (const marker of markers) {
    const x = timelineTimeToX(marker.sourceAtMs, scrollMs, pixelsPerSecond);
    if (x < TIMELINE_LABEL_WIDTH || x > context.canvas.width) {
      continue;
    }
    const selected = selection.kind === "cut" && selection.ids.includes(marker.id);
    context.strokeStyle = selected ? designTokenColor("feedback-running") : designTokenColor("feedback-warning");
    context.fillStyle = selected ? designTokenColor("feedback-running", 0.18) : designTokenColor("feedback-warning", 0.14);
    context.beginPath();
    context.moveTo(x, track.y + 4);
    context.lineTo(x + 7, track.y + 15);
    context.lineTo(x, track.y + track.height - 4);
    context.lineTo(x - 7, track.y + 15);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = designTokenColor("timeline-bright");
    context.font = "11px Segoe UI";
    context.fillText(
      `${marker.targetGapMs >= 0 ? "+" : ""}${marker.targetGapMs}ms`,
      x + 9,
      track.y + 22
    );
  }
}

function drawClips(
  context: CanvasRenderingContext2D,
  clips: DanmakuClip[],
  project: EditorProject,
  track: TimelineTrackRect,
  selection: EditorSelection
): void {
  for (const clip of clips) {
    const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
    const startX = timelineTimeToX(
      clip.timelineStartMs + clip.localOffsetMs,
      project.timeline.scrollMs,
      project.timeline.pixelsPerSecond
    );
    const width = Math.max(
      18,
      (getClipDurationMs(clip) / 1000) * project.timeline.pixelsPerSecond
    );
    if (startX + width < TIMELINE_LABEL_WIDTH || startX > context.canvas.width) {
      continue;
    }
    const selected = selection.kind === "clip" && selection.ids.includes(clip.id);
    context.fillStyle = clip.enabled ? (asset?.color ?? designTokenColor("feedback-running")) : designTokenColor("content-subtle");
    context.globalAlpha = selected ? 0.95 : 0.62;
    context.fillRect(Math.max(TIMELINE_LABEL_WIDTH, startX), track.y + 10, width, track.height - 20);
    context.globalAlpha = 1;
    context.strokeStyle = selected ? designTokenColor("timeline-bright") : designTokenColor("timeline-clip-outline");
    context.lineWidth = selected ? 2 : 1;
    context.strokeRect(Math.max(TIMELINE_LABEL_WIDTH, startX), track.y + 10, width, track.height - 20);
    context.fillStyle = designTokenColor("timeline-clip-text");
    context.font = "12px Segoe UI";
    context.fillText(clip.name, Math.max(TIMELINE_LABEL_WIDTH + 8, startX + 8), track.y + 34);
  }
}

function drawDensity(
  context: CanvasRenderingContext2D,
  events: ResolvedDanmakuEvent[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  track: TimelineTrackRect
): void {
  const endMs = scrollMs + ((width - TIMELINE_LABEL_WIDTH) * 1000) / pixelsPerSecond;
  const bucketSize = chooseBucketSizeMs(pixelsPerSecond);
  const buckets = aggregateDensity(events, scrollMs, endMs, bucketSize);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  for (const bucket of buckets) {
    const x = timelineTimeToX(bucket.startMs, scrollMs, pixelsPerSecond);
    const bucketWidth = Math.max(1, ((bucket.endMs - bucket.startMs) / 1000) * pixelsPerSecond);
    const normalized = bucket.count / max;
    context.fillStyle = designTokenColor("feedback-running", 0.12 + normalized * 0.72);
    context.fillRect(
      Math.max(TIMELINE_LABEL_WIDTH, x),
      track.y + track.height - normalized * (track.height - 8),
      bucketWidth,
      normalized * (track.height - 8)
    );
  }
}

function drawEvents(
  context: CanvasRenderingContext2D,
  events: ResolvedDanmakuEvent[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  track: TimelineTrackRect,
  selection: EditorSelection
): void {
  const maxToDraw = 2500;
  const step = Math.max(1, Math.ceil(events.length / maxToDraw));
  for (let index = 0; index < events.length; index += step) {
    const event = events[index];
    if (!event.enabled) {
      continue;
    }
    const x = timelineTimeToX(event.finalTimeMs, scrollMs, pixelsPerSecond);
    if (x < TIMELINE_LABEL_WIDTH || x > context.canvas.width) {
      continue;
    }
    const selected = selection.kind === "danmaku" && selection.ids.includes(event.item.id);
    const lane = event.originalIndex % 12;
    const y = track.y + 8 + lane * Math.max(4, (track.height - 16) / 12);
    context.fillStyle = selected ? designTokenColor("timeline-bright") : event.asset.color;
    context.fillRect(x - (selected ? 3 : 1), y, selected ? 6 : 2, selected ? 14 : 10);
    if (selected && pixelsPerSecond > 220) {
      context.font = "11px Segoe UI";
      context.fillText(event.item.text.slice(0, 16), x + 6, y + 10);
    }
  }
}

function drawSuspectedCutHints(
  context: CanvasRenderingContext2D,
  candidates: SuspectedCutCandidate[],
  cutMarkers: CutMarker[],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.cuts.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  const bandTop = tracks.cuts.y;
  const bandBottom = tracks.events.y + tracks.events.height;
  for (const candidate of candidates) {
    const x = timelineTimeToX(candidate.sourceAtMs, scrollMs, pixelsPerSecond);
    const startX = timelineTimeToX(candidate.startMs, scrollMs, pixelsPerSecond);
    const endX = timelineTimeToX(candidate.endMs, scrollMs, pixelsPerSecond);
    const rawBandLeft = Math.min(startX, endX, x - 3);
    const rawBandRight = Math.max(startX, endX, x + 3);
    const bandVisible = rawBandRight >= TIMELINE_LABEL_WIDTH && rawBandLeft <= width;
    const guideVisible = x >= TIMELINE_LABEL_WIDTH && x <= width;
    if (!bandVisible && !guideVisible) {
      continue;
    }

    const applied = isSuspectedCutCandidateApplied(candidate, cutMarkers);
    const strokeColor = applied ? designTokenColor("feedback-warning", 0.36) : designTokenColor("feedback-warning", 0.9);
    const fillColor = applied ? designTokenColor("feedback-warning", 0.035) : designTokenColor("feedback-warning", 0.085);
    context.save();
    if (bandVisible) {
      const left = clamp(rawBandLeft, TIMELINE_LABEL_WIDTH, width);
      const right = clamp(rawBandRight, TIMELINE_LABEL_WIDTH, width);
      if (right > left) {
        context.fillStyle = fillColor;
        context.fillRect(left, bandTop, Math.max(3, right - left), bandBottom - bandTop);
      }
    }
    context.restore();

    if (!guideVisible) {
      continue;
    }
    drawVerticalGuide(
      context,
      x,
      guideTop,
      guideBottom,
      strokeColor,
      applied ? [2, 5] : [4, 5],
      applied ? 1 : 1.4
    );
    drawSuspectedCutHintMarker(context, x, tracks.cuts, strokeColor, applied);
    if (!applied || pixelsPerSecond > 95) {
      drawTimelineLabel(
        context,
        `${applied ? "已落点" : "文本候选"} ${candidate.hitCount} 条`,
        x,
        tracks.cuts.y + 3,
        width,
        {
          borderColor: strokeColor,
          fillColor: applied ? designTokenColor("feedback-warning", 0.08) : designTokenColor("feedback-warning", 0.18)
        }
      );
    }
  }
}

function drawAlignmentPreview(
  context: CanvasRenderingContext2D,
  preview: AlignmentPreviewModel,
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  drawProjectAnchors(
    context,
    preview.projectAnchors,
    tracks,
    scrollMs,
    pixelsPerSecond,
    width,
    height
  );
  drawProposalAnchors(
    context,
    preview.proposalAnchors,
    tracks,
    scrollMs,
    pixelsPerSecond,
    width,
    height
  );
  drawProposalCutCandidates(
    context,
    preview.proposalCuts,
    tracks,
    scrollMs,
    pixelsPerSecond,
    width,
    height
  );
}

function drawSuspectedCutHintMarker(
  context: CanvasRenderingContext2D,
  x: number,
  track: TimelineTrackRect,
  color: string,
  applied: boolean
): void {
  const centerY = track.y + track.height / 2;
  const radius = applied ? 5 : 7;
  context.save();
  context.fillStyle = applied ? designTokenColor("feedback-warning", 0.1) : designTokenColor("feedback-warning", 0.24);
  context.strokeStyle = color;
  context.lineWidth = applied ? 1 : 1.4;
  context.setLineDash(applied ? [2, 4] : []);
  context.beginPath();
  context.arc(x, centerY, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawProjectAnchors(
  context: CanvasRenderingContext2D,
  anchors: AlignmentPreviewModel["projectAnchors"],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.video.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  for (const anchor of anchors) {
    const x = timelineTimeToX(anchor.sourceMs, scrollMs, pixelsPerSecond);
    if (x < TIMELINE_LABEL_WIDTH || x > width) {
      continue;
    }
    drawVerticalGuide(context, x, guideTop, guideBottom, designTokenColor("feedback-success"), [], 1.4);
    context.save();
    context.fillStyle = designTokenColor("feedback-success");
    context.fillRect(x - 3, tracks.cuts.y + tracks.cuts.height / 2 - 3, 6, 6);
    context.restore();
    if (pixelsPerSecond > 140) {
      drawTimelineLabel(
        context,
        `同步锚点 ${formatTimecode(anchor.sourceMs)}`,
        x,
        tracks.cuts.y + 3,
        width,
        {
          borderColor: designTokenColor("feedback-success"),
          fillColor: designTokenColor("feedback-success", 0.16)
        }
      );
    }
  }
}

function drawProposalAnchors(
  context: CanvasRenderingContext2D,
  anchors: AlignmentPreviewAnchor[],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.video.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  for (const anchor of anchors) {
    const x = timelineTimeToX(anchor.sourceMs, scrollMs, pixelsPerSecond);
    if (x < TIMELINE_LABEL_WIDTH || x > width) {
      continue;
    }
    const applied = anchor.state === "applied";
    const strokeColor = applied ? designTokenColor("feedback-success", 0.42) : designTokenColor("feedback-success", 0.92);
    drawVerticalGuide(
      context,
      x,
      guideTop,
      guideBottom,
      strokeColor,
      applied ? [2, 6] : [6, 4],
      applied ? 1 : 1.6
    );
    context.save();
    context.strokeStyle = strokeColor;
    context.fillStyle = applied ? designTokenColor("feedback-success", 0.12) : designTokenColor("feedback-success", 0.28);
    context.lineWidth = applied ? 1 : 1.5;
    context.beginPath();
    context.arc(x, tracks.cuts.y + tracks.cuts.height / 2, applied ? 4 : 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
    if (pixelsPerSecond > 95) {
      drawTimelineLabel(
        context,
        `${applied ? "已应用锚点" : "候选锚点"} ${formatSignedOffset(anchor.targetMs - anchor.sourceMs)}`,
        x,
        tracks.cuts.y + 3,
        width,
        {
          borderColor: strokeColor,
          fillColor: applied ? designTokenColor("feedback-success", 0.08) : designTokenColor("feedback-success", 0.18)
        }
      );
    }
  }
}

function drawProposalCutCandidates(
  context: CanvasRenderingContext2D,
  candidates: AlignmentPreviewCutCandidate[],
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  height: number
): void {
  const guideTop = tracks.cuts.y + 2;
  const guideBottom = Math.min(height - 3, tracks.events.y + tracks.events.height - 3);
  for (const candidate of candidates) {
    const x = timelineTimeToX(candidate.sourceAtMs, scrollMs, pixelsPerSecond);
    if (x < TIMELINE_LABEL_WIDTH || x > width) {
      continue;
    }
    const applied = candidate.state === "applied";
    const strokeColor = applied ? designTokenColor("timeline-correction", 0.42) : designTokenColor("timeline-correction", 0.94);
    drawCandidateSourceRange(context, candidate, tracks, scrollMs, pixelsPerSecond, width, applied);
    if (!applied) {
      context.save();
      context.fillStyle = designTokenColor("timeline-correction", 0.045);
      const impactLeft = Math.max(TIMELINE_LABEL_WIDTH, x);
      context.fillRect(
        impactLeft,
        tracks.cuts.y,
        width - impactLeft,
        tracks.events.y + tracks.events.height - tracks.cuts.y
      );
      drawImpactRegionText(
        context,
        `版本差异影响：后续弹幕整体 ${formatSignedOffset(candidate.targetGapMs)}`,
        impactLeft,
        tracks.events.y + 16,
        width
      );
      context.restore();
    }
    drawVerticalGuide(
      context,
      x,
      guideTop,
      guideBottom,
      strokeColor,
      applied ? [2, 6] : [7, 4],
      applied ? 1 : 1.6
    );
    drawCutCandidateDiamond(context, x, tracks.cuts, strokeColor, applied);
    if (!applied) {
      drawGapArrow(
        context,
        x,
        tracks.cuts.y + tracks.cuts.height - 8,
        candidate.targetGapMs,
        pixelsPerSecond,
        strokeColor
      );
    }
    drawTimelineLabel(
      context,
      `${applied ? "已应用版本差异" : "候选版本差异"} ${formatSignedOffset(candidate.targetGapMs)}`,
      x,
      tracks.cuts.y + 3,
      width,
      {
        borderColor: strokeColor,
        fillColor: applied ? designTokenColor("timeline-correction", 0.08) : designTokenColor("timeline-correction", 0.18)
      }
    );
  }
}

function drawCandidateSourceRange(
  context: CanvasRenderingContext2D,
  candidate: AlignmentPreviewCutCandidate,
  tracks: TimelineTracks,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  width: number,
  applied: boolean
): void {
  if (
    candidate.sourceRangeStartMs === undefined ||
    candidate.sourceRangeEndMs === undefined ||
    candidate.sourceRangeEndMs <= candidate.sourceRangeStartMs
  ) {
    return;
  }
  const startX = timelineTimeToX(candidate.sourceRangeStartMs, scrollMs, pixelsPerSecond);
  const endX = timelineTimeToX(candidate.sourceRangeEndMs, scrollMs, pixelsPerSecond);
  const left = clamp(Math.min(startX, endX), TIMELINE_LABEL_WIDTH, width);
  const right = clamp(Math.max(startX, endX), TIMELINE_LABEL_WIDTH, width);
  if (right <= TIMELINE_LABEL_WIDTH || left >= width || right - left < 2) {
    return;
  }
  context.save();
  context.fillStyle = applied ? designTokenColor("timeline-correction", 0.08) : designTokenColor("timeline-correction", 0.16);
  context.strokeStyle = applied ? designTokenColor("timeline-correction", 0.22) : designTokenColor("timeline-correction", 0.45);
  context.lineWidth = 1;
  const y = tracks.cuts.y + 4;
  const height = Math.max(6, tracks.cuts.height - 8);
  context.fillRect(left, y, right - left, height);
  context.strokeRect(left, y, right - left, height);
  context.restore();
}

function drawImpactRegionText(
  context: CanvasRenderingContext2D,
  text: string,
  left: number,
  baselineY: number,
  maxRight: number
): void {
  const availableWidth = maxRight - left - 12;
  if (availableWidth < 96) {
    return;
  }
  context.save();
  context.font = "11px Segoe UI";
  context.fillStyle = designTokenColor("timeline-correction-text", 0.92);
  context.fillText(text, left + 8, baselineY, availableWidth);
  context.restore();
}

function drawVerticalGuide(
  context: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  color: string,
  dash: number[],
  lineWidth: number
): void {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.setLineDash(dash);
  context.beginPath();
  context.moveTo(x, top);
  context.lineTo(x, bottom);
  context.stroke();
  context.restore();
}

function drawCutCandidateDiamond(
  context: CanvasRenderingContext2D,
  x: number,
  track: TimelineTrackRect,
  color: string,
  applied: boolean
): void {
  const centerY = track.y + track.height / 2;
  const radius = applied ? 7 : 9;
  context.save();
  context.fillStyle = applied ? designTokenColor("timeline-correction", 0.12) : designTokenColor("timeline-correction", 0.28);
  context.strokeStyle = color;
  context.lineWidth = applied ? 1 : 1.5;
  context.setLineDash(applied ? [2, 5] : [5, 3]);
  context.beginPath();
  context.moveTo(x, centerY - radius);
  context.lineTo(x + radius, centerY);
  context.lineTo(x, centerY + radius);
  context.lineTo(x - radius, centerY);
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}

function drawGapArrow(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  targetGapMs: Milliseconds,
  pixelsPerSecond: number,
  color: string
): void {
  const direction = targetGapMs >= 0 ? 1 : -1;
  const rawLength = (Math.abs(targetGapMs) / 1000) * pixelsPerSecond;
  const length = Math.max(16, Math.min(96, rawLength));
  const startX = x + direction * 10;
  const endX = x + direction * length;
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.4;
  context.beginPath();
  context.moveTo(startX, y);
  context.lineTo(endX, y);
  context.stroke();
  context.beginPath();
  context.moveTo(endX, y);
  context.lineTo(endX - direction * 6, y - 4);
  context.lineTo(endX - direction * 6, y + 4);
  context.closePath();
  context.fill();
  context.restore();
}

function drawTimelineLabel(
  context: CanvasRenderingContext2D,
  text: string,
  anchorX: number,
  y: number,
  maxRight: number,
  style: { borderColor: string; fillColor: string }
): void {
  const paddingX = 6;
  const labelHeight = 18;
  const maxLabelWidth = 168;
  context.save();
  context.font = "11px Segoe UI";
  const measuredWidth = Math.min(maxLabelWidth, context.measureText(text).width + paddingX * 2);
  const left = Math.max(TIMELINE_LABEL_WIDTH + 4, Math.min(anchorX + 8, maxRight - measuredWidth - 4));
  context.fillStyle = style.fillColor;
  context.strokeStyle = style.borderColor;
  context.fillRect(left, y, measuredWidth, labelHeight);
  context.strokeRect(left, y, measuredWidth, labelHeight);
  context.fillStyle = designTokenColor("timeline-bright");
  context.fillText(text, left + paddingX, y + 13, measuredWidth - paddingX * 2);
  context.restore();
}

function formatSignedOffset(milliseconds: Milliseconds): string {
  const rounded = Math.round(milliseconds);
  const sign = rounded >= 0 ? "+" : "-";
  const absolute = Math.abs(rounded);
  const fractionDigits = absolute % 1000 === 0 ? 0 : 3;
  return `${sign}${(absolute / 1000).toFixed(fractionDigits)}s`;
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  playheadMs: Milliseconds,
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  height: number
): void {
  const x = timelineTimeToX(playheadMs, scrollMs, pixelsPerSecond);
  if (x < TIMELINE_LABEL_WIDTH || x > context.canvas.width) {
    return;
  }
  context.strokeStyle = designTokenColor("feedback-danger");
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
  context.fillStyle = designTokenColor("feedback-danger");
  context.beginPath();
  context.moveTo(x - 6, 0);
  context.lineTo(x + 6, 0);
  context.lineTo(x, 9);
  context.closePath();
  context.fill();
}

function drawEdgeFeedback(
  context: CanvasRenderingContext2D,
  edge: TimelineEdgeFeedback,
  width: number,
  height: number
): void {
  if (!edge) {
    return;
  }
  const x = edge === "start" ? TIMELINE_LABEL_WIDTH : width - 1;
  const label = edge === "start" ? "已到时间轴开端" : "已到时间轴末端";
  context.save();
  context.strokeStyle = designTokenColor("feedback-danger");
  context.fillStyle = designTokenColor("feedback-danger", 0.12);
  context.lineWidth = 4;
  context.fillRect(edge === "start" ? TIMELINE_LABEL_WIDTH : width - 18, 0, 18, height);
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x, height);
  context.stroke();
  context.font = "12px Segoe UI";
  context.fillStyle = designTokenColor("timeline-correction-text");
  const textWidth = context.measureText(label).width + 16;
  const labelX =
    edge === "start" ? TIMELINE_LABEL_WIDTH + 10 : Math.max(TIMELINE_LABEL_WIDTH + 10, width - textWidth - 12);
  context.fillStyle = designTokenColor("timeline-danger-panel", 0.78);
  context.fillRect(labelX, 34, textWidth, 24);
  context.strokeStyle = designTokenColor("timeline-danger-outline", 0.9);
  context.lineWidth = 1;
  context.strokeRect(labelX, 34, textWidth, 24);
  context.fillStyle = designTokenColor("timeline-danger-text");
  context.fillText(label, labelX + 8, 50);
  context.restore();
}

function chooseTickStep(pixelsPerSecond: number): Milliseconds {
  if (pixelsPerSecond < 0.1) {
    return 6 * 60 * 60_000;
  }
  if (pixelsPerSecond < 0.25) {
    return 60 * 60_000;
  }
  if (pixelsPerSecond < 0.7) {
    return 30 * 60_000;
  }
  if (pixelsPerSecond < 1.5) {
    return 10 * 60_000;
  }
  if (pixelsPerSecond < 4) {
    return 5 * 60_000;
  }
  if (pixelsPerSecond < 8) {
    return 2 * 60_000;
  }
  if (pixelsPerSecond < 18) {
    return 60_000;
  }
  if (pixelsPerSecond < 45) {
    return 20_000;
  }
  if (pixelsPerSecond < 110) {
    return 10_000;
  }
  if (pixelsPerSecond < 280) {
    return 2_000;
  }
  return 1_000;
}

export function timelineTimeToX(
  timeMs: Milliseconds,
  scrollMs: Milliseconds,
  pixelsPerSecond: number
): number {
  return TIMELINE_LABEL_WIDTH + ((timeMs - scrollMs) / 1000) * pixelsPerSecond;
}
