import { useTheme } from "../../components/useTheme";
import {
  Combine,
  Magnet,
  Maximize2,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import {
  createAlignmentReviewItemStatuses,
  createAlignmentReviewStatusSummary
} from "../../domain/alignment/alignmentReport";
import { buildAlignmentPreview } from "../../domain/alignment/preview";
import {
  createCutHintSearchPlan,
  findSuspectedCutCandidates,
  isSuspectedCutCandidateApplied
} from "../../domain/danmaku/cutHints";
import type { CutMarker, DanmakuClip, ResolvedDanmakuEvent } from "../../domain/danmaku/types";
import { formatTimecode } from "../../domain/shared/time";
import type { Milliseconds } from "../../domain/shared/time";
import { clamp, clampMilliseconds } from "../../domain/shared/time";
import {
  getClipDurationMs,
  getProjectDurationMs,
  resolveProjectDanmakuEvents
} from "../../domain/timeline/mapping";
import { getEventsInRange } from "../../domain/timeline/search";
import {
  formatPixelsPerSecond,
  sliderValueToZoom,
  TIMELINE_ZOOM_SLIDER_MAX,
  TIMELINE_ZOOM_SLIDER_MIN,
  zoomToSliderValue
} from "../../domain/timeline/view";
import { useEditorStore } from "../../stores/editorStore";
import {
  TIMELINE_LABEL_WIDTH,
  createTimelineTracks,
  drawTimelineCanvas,
  timelineTimeToX,
  type TimelineEdgeFeedback,
  type TimelineTrackRect,
  type TimelineTracks
} from "./timelinePanel/timelineCanvasRenderer";

const SNAP_THRESHOLD_MS = 180;
const EDGE_SCROLL_ZONE_PX = 36;
const TIMELINE_TOOL_BUTTON_CLASS = "shrink-0 whitespace-nowrap";
const TIMELINE_TOOL_CHIP_CLASS =
  "shrink-0 whitespace-nowrap rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary";

type DragState =
  | { type: "none" }
  | { type: "playhead" }
  | {
      type: "clip";
      clipIds: string[];
      startX: number;
      primaryClipId: string;
      originalStartMs: Milliseconds;
    }
  | { type: "danmaku"; startX: number }
  | { type: "box"; startX: number; currentX: number; additive: boolean };

export function TimelinePanel() {
  const { revision: themeRevision } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState>({ type: "none" });
  const [size, setSize] = useState({ width: 1000, height: 320 });
  const [boxPreview, setBoxPreview] = useState<{ startX: number; currentX: number } | null>(
    null
  );
  const [edgeFeedback, setEdgeFeedback] = useState<TimelineEdgeFeedback>(null);

  const project = useEditorStore((state) => state.project);
  const selection = useEditorStore((state) => state.selection);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const timelineTool = useEditorStore((state) => state.timelineTool);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setTimelineScroll = useEditorStore((state) => state.setTimelineScroll);
  const setTimelineZoom = useEditorStore((state) => state.setTimelineZoom);
  const moveClip = useEditorStore((state) => state.moveClip);
  const moveSelectedClips = useEditorStore((state) => state.moveSelectedClips);
  const moveSelectedDanmaku = useEditorStore((state) => state.moveSelectedDanmaku);
  const toggleDanmakuSelection = useEditorStore((state) => state.toggleDanmakuSelection);
  const toggleClipSelection = useEditorStore((state) => state.toggleClipSelection);
  const toggleCutSelection = useEditorStore((state) => state.toggleCutSelection);
  const selectDanmakuRange = useEditorStore((state) => state.selectDanmakuRange);
  const addCutMarkerAtPlayhead = useEditorStore((state) => state.addCutMarkerAtPlayhead);
  const fitTimelineToContent = useEditorStore((state) => state.fitTimelineToContent);
  const splitClipAtTime = useEditorStore((state) => state.splitClipAtTime);
  const splitSelectedClipsAtPlayhead = useEditorStore(
    (state) => state.splitSelectedClipsAtPlayhead
  );
  const mergeSelectedClips = useEditorStore((state) => state.mergeSelectedClips);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const setTimelineTool = useEditorStore((state) => state.setTimelineTool);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const cutHintSettings = useEditorStore((state) => state.cutHintSettings);

  const tracks = useMemo(() => createTimelineTracks(size.height), [size.height]);
  const allEvents = useMemo(() => resolveProjectDanmakuEvents(project), [project]);
  const timelineDurationMs = useMemo(() => getProjectDurationMs(project), [project]);
  const alignmentPreview = useMemo(
    () => buildAlignmentPreview(project, alignmentProposal),
    [project, alignmentProposal]
  );
  const alignmentReviewStatuses = useMemo(
    () =>
      alignmentProposal
        ? createAlignmentReviewItemStatuses(alignmentProposal, {
            existingAnchors: project.syncAnchors,
            existingCutMarkers: project.cutMarkers
          })
        : [],
    [alignmentProposal, project.cutMarkers, project.syncAnchors]
  );
  const alignmentReviewSummary = useMemo(
    () => createAlignmentReviewStatusSummary(alignmentReviewStatuses),
    [alignmentReviewStatuses]
  );
  const cutHintSearch = useMemo(
    () => createCutHintSearchPlan(cutHintSettings),
    [cutHintSettings]
  );
  const suspectedCutCandidates = useMemo(
    () => findSuspectedCutCandidates(project.assets, cutHintSearch.options),
    [cutHintSearch, project.assets]
  );
  const pendingSuspectedCutCount = useMemo(
    () =>
      suspectedCutCandidates.filter(
        (candidate) => !isSuspectedCutCandidateApplied(candidate, project.cutMarkers)
      ).length,
    [project.cutMarkers, suspectedCutCandidates]
  );
  const viewport = useMemo(() => {
    const durationMs =
      ((size.width - TIMELINE_LABEL_WIDTH) * 1000) / project.timeline.pixelsPerSecond;
    return {
      startMs: project.timeline.scrollMs,
      endMs: project.timeline.scrollMs + durationMs
    };
  }, [project.timeline.pixelsPerSecond, project.timeline.scrollMs, size.width]);
  const visibleEvents = useMemo(
    () => getEventsInRange(allEvents, viewport.startMs - 1000, viewport.endMs + 1000),
    [allEvents, viewport.startMs, viewport.endMs]
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setSize({ width: Math.max(500, rect.width), height: Math.max(220, rect.height) });
      }
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * ratio);
    canvas.height = Math.floor(size.height * ratio);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawTimelineCanvas(context, {
      width: size.width,
      height: size.height,
      project,
      tracks,
      visibleEvents,
      allEvents,
      selection,
      boxPreview,
      edgeFeedback,
      alignmentPreview,
      suspectedCutCandidates
    });
  }, [
    themeRevision,
    size,
    project,
    tracks,
    visibleEvents,
    allEvents,
    selection,
    boxPreview,
    edgeFeedback,
    alignmentPreview,
    suspectedCutCandidates
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel-base" data-testid="timeline-panel">
      <div
        className="grid min-h-10 shrink-0 grid-cols-1 gap-1 border-b border-panel-line px-2 py-1 2xl:grid-cols-[minmax(0,1fr)_auto] 2xl:items-center"
        data-testid="timeline-toolbar"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <IconButton
            label={isPlaying ? "暂停高级弹幕时间线" : "播放高级弹幕时间线"}
            icon={isPlaying ? <Pause size={15} /> : <Play size={15} />}
            active={isPlaying}
            onClick={togglePlayback}
          />
          <span className="shrink-0 text-ui-caption text-content-muted">高级弹幕时间线</span>
          <output
            aria-label="高级弹幕时间线播放头"
            className="min-w-28 shrink-0 rounded-md border border-panel-line bg-surface-inset px-2 py-1 font-mono text-ui-caption text-accent-cyan"
          >
            {formatTimecode(project.timeline.playheadMs)}
          </output>
          <span className="shrink-0 text-ui-caption text-content-muted">高级时间轴缩放</span>
          <IconButton
            label="缩小时间轴"
            icon={<ZoomOut size={15} />}
            onClick={() => setTimelineZoom(project.timeline.pixelsPerSecond * 0.8)}
          />
          <input
            aria-label="时间轴缩放比例"
            title="时间轴缩放比例"
            className="h-1.5 w-24 shrink-0 accent-accent-cyan"
            type="range"
            min={TIMELINE_ZOOM_SLIDER_MIN}
            max={TIMELINE_ZOOM_SLIDER_MAX}
            step={1}
            value={zoomToSliderValue(project.timeline.pixelsPerSecond)}
            onChange={(event) => setTimelineZoom(sliderValueToZoom(Number(event.target.value)))}
          />
          <IconButton
            label="放大时间轴"
            icon={<ZoomIn size={15} />}
            onClick={() => setTimelineZoom(project.timeline.pixelsPerSecond * 1.25)}
          />
          <span className="h-5 w-px shrink-0 bg-panel-line" aria-hidden="true" />
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            onClick={() => setTimelineTool("select")}
            tone={timelineTool === "select" ? "primary" : "neutral"}
            aria-label="选择"
            title="选择"
          >
            <MousePointer2 size={14} />
            <span className="sr-only 2xl:not-sr-only">选择</span>
          </TextButton>
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            onClick={() => setTimelineTool("blade")}
            tone={timelineTool === "blade" ? "primary" : "neutral"}
            aria-label="剪刀"
            title="剪刀"
          >
            <Scissors size={14} />
            <span className="sr-only 2xl:not-sr-only">剪刀</span>
          </TextButton>
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            aria-label="标记版本差异"
            title="当前视频和完整版在这里多出或少了一段内容时使用"
            onClick={addCutMarkerAtPlayhead}
          >
            <Plus size={14} />
            <span className="sr-only 2xl:not-sr-only">标记版本差异</span>
          </TextButton>
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            aria-label="剪切播放头"
            title="剪切播放头"
            onClick={splitSelectedClipsAtPlayhead}
          >
            <Scissors size={14} />
            <span className="sr-only 2xl:not-sr-only">剪切播放头</span>
          </TextButton>
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            aria-label="合并片段"
            title="合并片段"
            onClick={mergeSelectedClips}
          >
            <Combine size={14} />
            <span className="sr-only 2xl:not-sr-only">合并片段</span>
          </TextButton>
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            aria-label="删除"
            title="删除所选内容"
            onClick={deleteSelection}
            tone="danger"
          >
            <Trash2 size={14} />
            <span className="sr-only 2xl:not-sr-only">删除</span>
          </TextButton>
          <TextButton
            className={TIMELINE_TOOL_BUTTON_CLASS}
            aria-label="缩放到全部"
            title="缩放到全部"
            onClick={() =>
              fitTimelineToContent(Math.max(240, size.width - TIMELINE_LABEL_WIDTH - 24))
            }
          >
            <Maximize2 size={14} />
            <span className="sr-only 2xl:not-sr-only">缩放到全部</span>
          </TextButton>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-content-muted 2xl:justify-end">
          {alignmentReviewSummary.totalCount > 0 ? (
            <span className={TIMELINE_TOOL_CHIP_CLASS} data-toolbar-chip="true">
              对齐待应用 {alignmentReviewSummary.pendingCount} / 已落点{" "}
              {alignmentReviewSummary.appliedCount}
              {alignmentReviewSummary.blockedCount > 0
                ? ` / 阻断 ${alignmentReviewSummary.blockedCount}`
                : ""}
            </span>
          ) : null}
          {suspectedCutCandidates.length > 0 ? (
            <span className={TIMELINE_TOOL_CHIP_CLASS} data-toolbar-chip="true">
              文本候选 {pendingSuspectedCutCount} / 已落点{" "}
              {suspectedCutCandidates.length - pendingSuspectedCutCount}
            </span>
          ) : null}
          <span
            className="flex shrink-0 items-center gap-1 whitespace-nowrap"
            data-toolbar-chip="true"
          >
            <Magnet size={14} className="text-accent-cyan" />
            吸附播放头 / 版本差异
          </span>
          <span className={`${TIMELINE_TOOL_CHIP_CLASS} font-mono`} data-toolbar-chip="true">
            {formatPixelsPerSecond(project.timeline.pixelsPerSecond)}
          </span>
          <span className={TIMELINE_TOOL_CHIP_CLASS} data-toolbar-chip="true">
            选择 {selection.ids.length}
          </span>
        </div>
      </div>
      <div ref={wrapperRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="timeline-canvas absolute inset-0 cursor-crosshair"
          data-testid="timeline-canvas"
          onPointerDown={(event) => {
            const point = getCanvasPoint(event);
            const timeMs = xToTime(
              point.x,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond
            );
            const cutHit = hitCut(
              point,
              project.cutMarkers,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            const clipHit = hitClip(
              point,
              project.clips,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            const eventHit = hitEvent(
              point,
              visibleEvents,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            event.currentTarget.setPointerCapture(event.pointerId);
            setEdgeFeedback(null);
            if (timelineTool === "blade") {
              if (clipHit) {
                splitClipAtTime(clipHit.id, timeMs);
              }
              dragRef.current = { type: "none" };
              return;
            }
            if (eventHit) {
              toggleDanmakuSelection(eventHit.item.id, event.shiftKey);
              dragRef.current = { type: "danmaku", startX: point.x };
              return;
            }
            if (clipHit) {
              const clipIds =
                selection.kind === "clip" && selection.ids.includes(clipHit.id)
                  ? selection.ids
                  : [clipHit.id];
              toggleClipSelection(clipHit.id, event.shiftKey);
              dragRef.current = {
                type: "clip",
                clipIds,
                primaryClipId: clipHit.id,
                startX: point.x,
                originalStartMs: clipHit.timelineStartMs + clipHit.localOffsetMs
              };
              return;
            }
            if (cutHit) {
              toggleCutSelection(cutHit.id, event.shiftKey);
              return;
            }
            if (isInsideTrack(point.y, tracks.events)) {
              dragRef.current = {
                type: "box",
                startX: point.x,
                currentX: point.x,
                additive: event.shiftKey
              };
              setBoxPreview({ startX: point.x, currentX: point.x });
              return;
            }
            setPlayhead(timeMs);
            dragRef.current = { type: "playhead" };
          }}
          onPointerMove={(event) => {
            const point = getCanvasPoint(event);
            const drag = dragRef.current;
            if (drag.type === "playhead") {
              const next = getPlayheadDragUpdate({
                pointX: point.x,
                width: size.width,
                scrollMs: project.timeline.scrollMs,
                pixelsPerSecond: project.timeline.pixelsPerSecond,
                durationMs: timelineDurationMs
              });
              if (next.scrollMs !== project.timeline.scrollMs) {
                setTimelineScroll(next.scrollMs);
              }
              setPlayhead(next.playheadMs);
              setEdgeFeedback(next.edge);
            } else if (drag.type === "box") {
              dragRef.current = { ...drag, currentX: point.x };
              setBoxPreview({ startX: drag.startX, currentX: point.x });
            }
          }}
          onPointerUp={(event) => {
            const point = getCanvasPoint(event);
            const drag = dragRef.current;
            if (drag.type === "clip") {
              const rawDelta =
                ((point.x - drag.startX) * 1000) / project.timeline.pixelsPerSecond;
              const proposedStart = clampMilliseconds(drag.originalStartMs + rawDelta);
              const snappedStart = snapTime(
                proposedStart,
                project.timeline.playheadMs,
                project.cutMarkers
              );
              if (drag.clipIds.length > 1) {
                moveSelectedClips(Math.round(snappedStart - drag.originalStartMs));
              } else {
                moveClip(drag.primaryClipId, snappedStart - drag.originalStartMs);
              }
            } else if (drag.type === "danmaku") {
              const rawDelta =
                ((point.x - drag.startX) * 1000) / project.timeline.pixelsPerSecond;
              const firstSelected = visibleEvents.find(
                (eventItem) =>
                  selection.kind === "danmaku" && selection.ids.includes(eventItem.item.id)
              );
              const snappedDelta = firstSelected
                ? snapTime(
                    firstSelected.finalTimeMs + rawDelta,
                    project.timeline.playheadMs,
                    project.cutMarkers
                  ) - firstSelected.finalTimeMs
                : rawDelta;
              moveSelectedDanmaku(Math.round(snappedDelta));
            } else if (drag.type === "box") {
              const start = xToTime(
                drag.startX,
                project.timeline.scrollMs,
                project.timeline.pixelsPerSecond
              );
              const end = xToTime(
                point.x,
                project.timeline.scrollMs,
                project.timeline.pixelsPerSecond
              );
              selectDanmakuRange(start, end, drag.additive);
              setBoxPreview(null);
            }
            dragRef.current = { type: "none" };
            setEdgeFeedback(null);
          }}
          onDoubleClick={(event) => {
            const point = getCanvasPoint(event);
            const eventHit = hitEvent(
              point,
              visibleEvents,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond,
              tracks
            );
            if (eventHit) {
              toggleDanmakuSelection(eventHit.item.id, false);
              setPlayhead(eventHit.finalTimeMs);
            }
          }}
          onWheel={(event) => {
            event.preventDefault();
            const point = getCanvasPoint(event);
            const pointerTime = xToTime(
              point.x,
              project.timeline.scrollMs,
              project.timeline.pixelsPerSecond
            );
            if (event.ctrlKey || event.metaKey) {
              const direction = event.deltaY > 0 ? 0.88 : 1.14;
              setTimelineZoom(
                project.timeline.pixelsPerSecond * direction,
                pointerTime,
                point.x - TIMELINE_LABEL_WIDTH
              );
            } else {
              const deltaPx = event.deltaX !== 0 ? event.deltaX : event.deltaY;
              const deltaMs = (deltaPx * 1000) / project.timeline.pixelsPerSecond;
              setTimelineScroll(project.timeline.scrollMs + deltaMs);
            }
          }}
        />
      </div>
    </div>
  );
}

function xToTime(x: number, scrollMs: Milliseconds, pixelsPerSecond: number): Milliseconds {
  return clampMilliseconds(scrollMs + ((x - TIMELINE_LABEL_WIDTH) * 1000) / pixelsPerSecond);
}

function getPlayheadDragUpdate({
  pointX,
  width,
  scrollMs,
  pixelsPerSecond,
  durationMs
}: {
  pointX: number;
  width: number;
  scrollMs: Milliseconds;
  pixelsPerSecond: number;
  durationMs: Milliseconds;
}): { playheadMs: Milliseconds; scrollMs: Milliseconds; edge: TimelineEdgeFeedback } {
  const visibleMs = ((width - TIMELINE_LABEL_WIDTH) * 1000) / pixelsPerSecond;
  const maxScrollMs = clampMilliseconds(Math.max(0, durationMs - visibleMs));
  let nextScrollMs = Math.min(scrollMs, maxScrollMs);

  if (pointX < TIMELINE_LABEL_WIDTH + EDGE_SCROLL_ZONE_PX && scrollMs > 0) {
    const edgePressure = TIMELINE_LABEL_WIDTH + EDGE_SCROLL_ZONE_PX - pointX;
    nextScrollMs = clampMilliseconds(scrollMs - (edgePressure * 1000) / pixelsPerSecond);
  } else if (pointX > width - EDGE_SCROLL_ZONE_PX && scrollMs < maxScrollMs) {
    const edgePressure = pointX - (width - EDGE_SCROLL_ZONE_PX);
    nextScrollMs = clampMilliseconds(
      Math.min(maxScrollMs, scrollMs + (edgePressure * 1000) / pixelsPerSecond)
    );
  }

  const clampedX = clamp(pointX, TIMELINE_LABEL_WIDTH, width);
  const playheadMs = clampMilliseconds(
    clamp(xToTime(clampedX, nextScrollMs, pixelsPerSecond), 0, durationMs)
  );
  const edge =
    playheadMs <= 0 && pointX <= TIMELINE_LABEL_WIDTH
      ? "start"
      : playheadMs >= durationMs && pointX >= width - EDGE_SCROLL_ZONE_PX
        ? "end"
        : null;

  return { playheadMs, scrollMs: nextScrollMs, edge };
}

function getCanvasPoint(
  event:
    | ReactPointerEvent<HTMLCanvasElement>
    | ReactWheelEvent<HTMLCanvasElement>
    | ReactMouseEvent<HTMLCanvasElement>
): {
  x: number;
  y: number;
} {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function isInsideTrack(y: number, track: TimelineTrackRect): boolean {
  return y >= track.y && y <= track.y + track.height;
}

function hitClip(
  point: { x: number; y: number },
  clips: DanmakuClip[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  tracks: TimelineTracks
): DanmakuClip | null {
  if (!isInsideTrack(point.y, tracks.clips)) {
    return null;
  }
  return (
    clips.find((clip) => {
      const x = timelineTimeToX(
        clip.timelineStartMs + clip.localOffsetMs,
        scrollMs,
        pixelsPerSecond
      );
      const width = Math.max(18, (getClipDurationMs(clip) / 1000) * pixelsPerSecond);
      return point.x >= x && point.x <= x + width;
    }) ?? null
  );
}

function hitCut(
  point: { x: number; y: number },
  markers: CutMarker[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  tracks: TimelineTracks
): CutMarker | null {
  if (!isInsideTrack(point.y, tracks.cuts)) {
    return null;
  }
  return (
    markers.find(
      (marker) =>
        Math.abs(point.x - timelineTimeToX(marker.sourceAtMs, scrollMs, pixelsPerSecond)) <= 9
    ) ?? null
  );
}

function hitEvent(
  point: { x: number; y: number },
  events: ResolvedDanmakuEvent[],
  scrollMs: Milliseconds,
  pixelsPerSecond: number,
  tracks: TimelineTracks
): ResolvedDanmakuEvent | null {
  if (!isInsideTrack(point.y, tracks.events)) {
    return null;
  }
  let best: ResolvedDanmakuEvent | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const x = timelineTimeToX(event.finalTimeMs, scrollMs, pixelsPerSecond);
    const distance = Math.abs(point.x - x);
    if (distance < bestDistance && distance <= 8) {
      best = event;
      bestDistance = distance;
    }
  }
  return best;
}

function snapTime(
  timeMs: Milliseconds,
  playheadMs: Milliseconds,
  cutMarkers: CutMarker[]
): Milliseconds {
  const candidates = [playheadMs, ...cutMarkers.map((marker) => marker.sourceAtMs)];
  let best = timeMs;
  let bestDistance = SNAP_THRESHOLD_MS + 1;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - timeMs);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= SNAP_THRESHOLD_MS ? best : timeMs;
}
