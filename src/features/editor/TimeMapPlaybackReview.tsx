import { ClipboardCopy, Pause, Play, Repeat2, RotateCcw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createRelationDanmakuTracks,
  serializePreviewAss,
  visiblePreviewComments
} from "../../domain/preview/danmakuTrack";
import { CommentOverlay } from "../preview/CommentOverlay";
import { ToolSheet } from "../../components/ToolSheet";
import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { TextButton } from "../../components/TextButton";
import {
  createTimeMapPlaybackBoundaryContext,
  createTimeMapPlaybackSpanPlan,
  intervalForAxis,
  mapTimeMapPlaybackCounterpart,
  resolveTimeMapBoundaryPlaybackSwitch,
  resolveTimeMapPlaybackBoundary,
  type TimeMapPlaybackAxis,
  type TimeMapPlaybackBoundaryContext,
  type TimeMapPlaybackBoundaryKind,
  type TimeMapPlaybackInterval
} from "../../domain/alignment/timeMapPlayback";
import type { TimeMapSpan } from "../../domain/alignment/timeMap";
import {
  accumulateTimeMapPlaybackObservation,
  assessTimeMapSpanPlaybackEvidence,
  createEmptyTimeMapSpanPlaybackEvidence,
  describeMissingTimeMapSpanPlaybackEvidence,
  resetTimeMapPlaybackAccumulator
} from "../../domain/alignment/timeMapPlaybackReviewEvidence";
import type { MediaTimeMap, ProjectMediaReference } from "../../domain/project/types";
import { resolvePlaybackMediaPair } from "../../domain/player/playbackMediaPair";
import {
  canLinkDualPlayback,
  decideFollowerCorrection,
  linkedPlaybackRate,
  preferredDualPlaybackAxis,
  resolveLinkedPlaybackPositions
} from "../../domain/player/dualPlaybackCoordinator";
import { formatTimecode } from "../../domain/shared/time";
import { usePlaybackSettings } from "../preview/usePlaybackSettings";
import {
  isNativeVideoObstructed,
  subscribeNativeVideoLayout
} from "../../infrastructure/media/nativeVideoLayout";
import { useEditorStore } from "../../stores/editorStore";
import { DualViewerWorkbench } from "./DualViewerWorkbench";
import {
  useTimeMapPlaybackMediaSession,
  type TimeMapPlaybackAdapterFactory,
  type TimeMapPlaybackBackend
} from "./timeMapPlayback/useTimeMapPlaybackMediaSession";

export type {
  TimeMapPlaybackAdapterFactory,
  TimeMapPlaybackBackend
} from "./timeMapPlayback/useTimeMapPlaybackMediaSession";

export interface TimeMapPlaybackSeekRequest {
  side: "source" | "target";
  positionMs: number;
  token: number;
}

export interface TimeMapPlaybackPositions {
  source: number;
  target: number;
}

interface TimeMapPlaybackReviewProps {
  timeMap: MediaTimeMap;
  span: TimeMapSpan;
  spanIndex: number;
  timeMapId: string;
  relationState: "candidate" | "accepted";
  persistedReview: boolean;
  sourceMapRange: TimeMapPlaybackInterval;
  targetMapRange: TimeMapPlaybackInterval;
  sourceMedia: ProjectMediaReference | null | undefined;
  targetMedia: ProjectMediaReference | null | undefined;
  open: boolean;
  visible?: boolean;
  onOpenChange: (open: boolean) => void;
  onCursorChange?: (cursor: { side: "source" | "target"; positionMs: number }) => void;
  onPositionsChange?: (positions: TimeMapPlaybackPositions) => void;
  seekRequest?: TimeMapPlaybackSeekRequest | null;
  adapterFactory?: TimeMapPlaybackAdapterFactory;
}

export function TimeMapPlaybackReview({
  timeMap,
  span,
  spanIndex,
  timeMapId,
  relationState,
  persistedReview,
  sourceMapRange,
  targetMapRange,
  sourceMedia,
  targetMedia,
  open,
  visible = true,
  onOpenChange,
  onCursorChange,
  onPositionsChange,
  seekRequest,
  adapterFactory
}: TimeMapPlaybackReviewProps) {
  const [reviewDetailsOpen, setReviewDetailsOpen] = useState(false);
  const [danmakuVisible, setDanmakuVisible] = useState(true);
  const assets = useEditorStore((state) => state.project.assets);
  const danmakuSourceBindings = useEditorStore((state) => state.project.danmakuSourceBindings);
  const disabledItemIds = useEditorStore((state) => state.project.disabledItemIds);
  const tracks = useMemo(
    () =>
      createRelationDanmakuTracks(
        { assets, danmakuSourceBindings, disabledItemIds },
        timeMap,
        sourceMedia?.id ?? ""
      ),
    [assets, danmakuSourceBindings, disabledItemIds, timeMap, sourceMedia?.id]
  );
  const trackRevision = useRef(0);
  const playbackSurfaceRef = useRef<HTMLElement>(null);
  const settings = usePlaybackSettings().player;
  const playbackPair = useMemo(
    () =>
      resolvePlaybackMediaPair(
        sourceMedia,
        targetMedia,
        settings.preferredBackend,
        settings.mpvPath
      ),
    [settings.mpvPath, settings.preferredBackend, sourceMedia, targetMedia]
  );
  const plan = useMemo(() => createTimeMapPlaybackSpanPlan(span), [span]);
  const initialAxis = useMemo(() => preferredDualPlaybackAxis(span), [span]);
  const initialPositions = useMemo(
    () => ({
      source: plan.sourceInterval?.startMs ?? 0,
      target: plan.targetInterval?.startMs ?? 0
    }),
    [plan.sourceInterval?.startMs, plan.targetInterval?.startMs]
  );
  const autoLoadedSpanRef = useRef<string | null>(null);
  const handledSeekTokenRef = useRef<number | null>(null);
  const playbackAccumulatorRefs = useRef({
    source: resetTimeMapPlaybackAccumulator(),
    target: resetTimeMapPlaybackAccumulator()
  });
  const sessionEvidenceRef = useRef(createEmptyTimeMapSpanPlaybackEvidence());
  const [activeAxis, setActiveAxis] = useState<TimeMapPlaybackAxis>(initialAxis);
  const [loading, setLoading] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [loopScope, setLoopScope] = useState<"span" | TimeMapPlaybackBoundaryKind>("span");
  const [status, setStatus] = useState(plan.explanation);
  const [error, setError] = useState<string | null>(null);
  const [diagnosticCopied, setDiagnosticCopied] = useState(false);
  const [sessionEvidence, setSessionEvidence] = useState(
    createEmptyTimeMapSpanPlaybackEvidence
  );
  const recordPlaybackReview = useEditorStore((state) => state.recordTimeMapSpanPlaybackReview);
  const nativeSessionIds = useMemo(
    () => ({
      source: createNativeSessionId(timeMapId, "source"),
      target: createNativeSessionId(timeMapId, "target")
    }),
    [timeMapId]
  );
  const boundaryContext = useMemo(
    () =>
      loopScope === "span"
        ? null
        : createTimeMapPlaybackBoundaryContext(span, loopScope, sourceMapRange, targetMapRange),
    [loopScope, sourceMapRange, span, targetMapRange]
  );

  const resetPlaybackObservation = useCallback(() => {
    playbackAccumulatorRefs.current = {
      source: resetTimeMapPlaybackAccumulator(),
      target: resetTimeMapPlaybackAccumulator()
    };
  }, []);
  const mediaSession = useTimeMapPlaybackMediaSession({
    open,
    playbackPair,
    nativeSessionIds,
    mpvPath: settings.mpvPath,
    initialPositions,
    initialPlaybackMode: canLinkDualPlayback(span) ? "linked" : "independent",
    initialSoloAxis: "target",
    adapterFactory,
    onPlaybackStopped: resetPlaybackObservation,
    onInitializationError: setError
  });
  const { adapterReady, positions, playing, playbackMode, soloAxis } = mediaSession.snapshot;
  const sessionActions = mediaSession.actions;
  const setPlayingAxes = sessionActions.setPlayingAxes;
  const setPlaybackMode = sessionActions.setPlaybackMode;
  const setSoloAxis = sessionActions.setSoloAxis;
  const updatePosition = sessionActions.position;
  useEffect(() => {
    autoLoadedSpanRef.current = null;
  }, [adapterReady]);

  useEffect(() => {
    let cancelled = false;
    const revision = ++trackRevision.current;
    for (const axis of playbackAxes()) {
      const adapter = sessionActions.adapter(axis);
      if (!adapterReady[axis] || !adapter?.setDanmakuTrack) continue;
      try {
        const assContent = danmakuVisible ? serializePreviewAss(tracks[axis]) : null;
        void adapter
          .setDanmakuTrack({ revision, assContent, visible: danmakuVisible })
          .catch((reason: unknown) => {
            if (!cancelled) setError(`弹幕预览加载失败：${String(reason)}`);
          });
      } catch (reason) {
        setError(String(reason));
      }
    }
    return () => {
      cancelled = true;
    };
  }, [adapterReady, danmakuVisible, sessionActions, tracks]);

  useEffect(() => {
    onCursorChange?.({ side: activeAxis, positionMs: positions[activeAxis] });
  }, [activeAxis, onCursorChange, positions]);

  useEffect(() => {
    onPositionsChange?.(positions);
  }, [onPositionsChange, positions]);

  useEffect(() => {
    sessionActions.resetForSpan({
      positions: {
        source: plan.sourceInterval?.startMs ?? 0,
        target: plan.targetInterval?.startMs ?? 0
      },
      playbackMode: canLinkDualPlayback(span) ? "linked" : "independent",
      soloAxis: plan.targetInterval ? "target" : "source"
    });
    setLoading(false);
    setError(null);
    setLoopScope("span");
    const emptyEvidence = createEmptyTimeMapSpanPlaybackEvidence();
    sessionEvidenceRef.current = emptyEvidence;
    setSessionEvidence(emptyEvidence);
    const nextAxis = preferredDualPlaybackAxis(span);
    setActiveAxis(nextAxis);
    setStatus(`已选择第 ${spanIndex + 1} 段。${plan.explanation}`);
  }, [plan, sessionActions, span, spanIndex]);

  const loadAxis = useCallback(
    async (
      axis: TimeMapPlaybackAxis,
      requestedPositionMs: number,
      autoplay: boolean
    ): Promise<boolean> => {
      const adapter = sessionActions.adapter(axis);
      const interval = reviewIntervalForAxis(plan, boundaryContext, axis);
      const mediaSource = axis === "source" ? playbackPair.source : playbackPair.target;
      if (!adapter || !interval || !mediaSource) {
        setError(
          !interval
            ? axis === "source"
              ? "当前分段没有可试听的参考 A 区间。"
              : "当前分段没有可试听的原片 B 区间。"
            : "播放器尚未准备完成，请稍后重试。"
        );
        return false;
      }
      const safePositionMs = Math.min(
        interval.endMs - 1,
        Math.max(interval.startMs, Math.round(requestedPositionMs))
      );
      const isCurrentOperation = sessionActions.beginOperation(axis);
      setLoading(true);
      setError(null);
      adapter.pause();
      setPlayingAxes(false, false);
      try {
        if (!sessionActions.loaded(axis)) {
          await adapter.load(mediaSource, safePositionMs);
        } else {
          adapter.seek(safePositionMs);
        }
        if (!isCurrentOperation()) {
          return false;
        }
        sessionActions.loaded(axis, true);
        adapter.setPlaybackRate(1);
        adapter.setMuted?.(axis !== soloAxis);
        setActiveAxis(axis);
        updatePosition(axis, safePositionMs);
        if (autoplay) {
          await adapter.play();
          if (!isCurrentOperation()) {
            return false;
          }
          setPlayingAxes(axis === "source", axis === "target");
        }
        return true;
      } catch (loadError) {
        if (isCurrentOperation()) {
          setError(formatPlaybackError(loadError, playbackPair.backend));
          sessionActions.loaded(axis, false);
          setPlayingAxes(false, false);
        }
        return false;
      } finally {
        if (isCurrentOperation()) {
          setLoading(false);
        }
      }
    },
    [
      boundaryContext,
      plan,
      playbackPair.backend,
      playbackPair.source,
      playbackPair.target,
      sessionActions,
      setPlayingAxes,
      soloAxis,
      updatePosition
    ]
  );

  const seekFromTimeline = useCallback(
    async (request: TimeMapPlaybackSeekRequest): Promise<void> => {
      const interval = reviewIntervalForAxis(plan, boundaryContext, request.side);
      if (!interval) {
        setStatus(`${axisLabel(request.side)}在当前分段没有可定位区间。`);
        return;
      }
      const safePositionMs = Math.min(
        interval.endMs - 1,
        Math.max(interval.startMs, Math.round(request.positionMs))
      );
      sessionActions.pauseAll();
      setPlayingAxes(false, false);

      if (playbackMode === "linked" && loopScope === "span" && canLinkDualPlayback(span)) {
        const pair = resolveLinkedPlaybackPositions(span, request.side, safePositionMs);
        const requestedPositions = {
          source: pair.sourceMs,
          target: pair.targetMs
        };
        let locatedBoth = true;
        for (const axis of playbackAxes()) {
          if (
            !reviewIntervalForAxis(plan, boundaryContext, axis) ||
            !sessionActions.adapter(axis)
          ) {
            locatedBoth = false;
            continue;
          }
          if (!sessionActions.loaded(axis)) {
            locatedBoth =
              (await loadAxis(axis, requestedPositions[axis], false)) && locatedBoth;
          } else {
            sessionActions.adapter(axis)?.seek(requestedPositions[axis]);
            updatePosition(axis, requestedPositions[axis]);
          }
        }
        setActiveAxis(request.side);
        setStatus(
          locatedBoth
            ? `已从正式时间轴定位 A/B：${axisLabel(request.side)} ${formatTimecode(
                safePositionMs
              )}。`
            : `已定位${axisLabel(request.side)}；另一侧当前不可用。`
        );
        return;
      }

      const located = await loadAxis(request.side, safePositionMs, false);
      if (located) {
        setActiveAxis(request.side);
        setStatus(
          `已从正式时间轴定位${axisLabel(request.side)} ${formatTimecode(safePositionMs)}。`
        );
      }
    },
    [
      boundaryContext,
      loadAxis,
      loopScope,
      plan,
      playbackMode,
      sessionActions,
      setPlayingAxes,
      span,
      updatePosition
    ]
  );

  useEffect(() => {
    if (
      !open ||
      !seekRequest ||
      handledSeekTokenRef.current === seekRequest.token ||
      (!adapterReady.source && !adapterReady.target)
    ) {
      return;
    }
    handledSeekTokenRef.current = seekRequest.token;
    void seekFromTimeline(seekRequest);
  }, [adapterReady, open, seekFromTimeline, seekRequest]);

  useEffect(() => {
    const anyAdapterReady = adapterReady.source || adapterReady.target;
    if (!open || !anyAdapterReady || !playbackPair.available) {
      if (!open) {
        autoLoadedSpanRef.current = null;
      }
      return;
    }
    const availableAxes = playbackAxes().filter(
      (axis) =>
        adapterReady[axis] && Boolean(reviewIntervalForAxis(plan, boundaryContext, axis))
    );
    if (availableAxes.length === 0) {
      return;
    }
    const key = `${timeMapId}:${spanIndex}:${loopScope}:${availableAxes
      .map((axis) => {
        const interval = reviewIntervalForAxis(plan, boundaryContext, axis);
        return `${axis}:${interval?.startMs}:${interval?.endMs}`;
      })
      .join("|")}`;
    if (autoLoadedSpanRef.current === key) {
      return;
    }
    autoLoadedSpanRef.current = key;
    void Promise.all(
      availableAxes.map((axis) => {
        const interval = reviewIntervalForAxis(plan, boundaryContext, axis);
        return interval ? loadAxis(axis, interval.startMs, false) : Promise.resolve(false);
      })
    ).then((loaded) => {
      if (loaded.some(Boolean)) {
        setActiveAxis(initialAxis);
        setStatus(
          loaded.every(Boolean) && loaded.length === 2
            ? `已同时加载参考 A 与原片 B 的第 ${spanIndex + 1} 段首帧。`
            : `已加载当前可用视频的第 ${spanIndex + 1} 段首帧。`
        );
      }
    });
  }, [
    adapterReady,
    boundaryContext,
    initialAxis,
    loadAxis,
    loopScope,
    open,
    plan,
    playbackPair.available,
    spanIndex,
    timeMapId
  ]);

  const switchAxis = useCallback(
    async (nextAxis: TimeMapPlaybackAxis): Promise<void> => {
      const interval = reviewIntervalForAxis(plan, boundaryContext, nextAxis);
      if (!interval || !sessionActions.adapter(nextAxis)) {
        setStatus(`${axisLabel(nextAxis)}在当前复核范围不可用。`);
        return;
      }
      const keepPlaying = sessionActions.isPlaying();
      const boundarySwitch =
        boundaryContext && nextAxis !== activeAxis
          ? resolveTimeMapBoundaryPlaybackSwitch(
              span,
              boundaryContext,
              activeAxis,
              nextAxis,
              sessionActions.position(activeAxis)
            )
          : null;
      const requestedPositionMs =
        boundarySwitch && boundarySwitch.status !== "unavailable"
          ? boundarySwitch.positionMs
          : sessionActions.position(nextAxis);
      if (!sessionActions.loaded(nextAxis)) {
        const loaded = await loadAxis(nextAxis, requestedPositionMs, false);
        if (!loaded) return;
      } else if (requestedPositionMs !== sessionActions.position(nextAxis)) {
        sessionActions.adapter(nextAxis)?.seek(requestedPositionMs);
        updatePosition(nextAxis, requestedPositionMs);
      }
      setSoloAxis(nextAxis);
      setStatus(
        playbackMode === "linked"
          ? `已切换为只听${axisLabel(nextAxis)}；双方播放头仍保持联动。`
          : boundarySwitch && boundarySwitch.status !== "unavailable"
            ? `已切换到${axisLabel(nextAxis)}的对应边界位置 ${formatTimecode(requestedPositionMs)}。`
            : `已选择${axisLabel(nextAxis)}独立操作。`
      );
      for (const axis of playbackAxes()) {
        sessionActions.adapter(axis)?.setMuted?.(axis !== nextAxis);
      }
      if (playbackMode === "independent" && keepPlaying && nextAxis !== activeAxis) {
        sessionActions.adapter(activeAxis)?.pause();
        await sessionActions.adapter(nextAxis)?.play();
        setPlayingAxes(nextAxis === "source", nextAxis === "target");
      }
      setActiveAxis(nextAxis);
    },
    [
      activeAxis,
      boundaryContext,
      loadAxis,
      plan,
      playbackMode,
      sessionActions,
      setPlayingAxes,
      setSoloAxis,
      span,
      updatePosition
    ]
  );

  const togglePlayback = useCallback(async (): Promise<void> => {
    const adapter = sessionActions.adapter(activeAxis);
    const interval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
    if (!adapter || !interval) {
      setError("播放器尚未准备完成，或当前一侧没有可试听区间。");
      return;
    }
    if (sessionActions.isPlaying()) {
      sessionActions.pauseAll();
      setPlayingAxes(false, false);
      setStatus(
        playbackMode === "linked" ? "已暂停 A/B 联动播放。" : `已暂停${axisLabel(activeAxis)}。`
      );
      return;
    }
    try {
      if (playbackMode === "linked") {
        const sourceAdapter = sessionActions.adapter("source");
        const targetAdapter = sessionActions.adapter("target");
        if (!canLinkDualPlayback(span) || !sourceAdapter || !targetAdapter) {
          setPlaybackMode("independent");
          setError("当前分段或媒体不满足联动条件，已切换为独立播放。");
          return;
        }
        for (const axis of playbackAxes()) {
          const axisInterval = reviewIntervalForAxis(plan, boundaryContext, axis);
          if (!axisInterval) continue;
          if (!sessionActions.loaded(axis)) {
            const loaded = await loadAxis(axis, axisInterval.startMs, false);
            if (!loaded) return;
          }
        }
        const masterPositionMs = sessionActions.position("target");
        const pair = resolveLinkedPlaybackPositions(span, "target", masterPositionMs);
        sourceAdapter.seek(pair.sourceMs);
        targetAdapter.seek(pair.targetMs);
        updatePosition("source", pair.sourceMs);
        updatePosition("target", pair.targetMs);
        sourceAdapter.setPlaybackRate(linkedPlaybackRate(span, "source", "target"));
        targetAdapter.setPlaybackRate(1);
        sourceAdapter.setMuted?.(soloAxis !== "source");
        targetAdapter.setMuted?.(soloAxis !== "target");
        await Promise.all([sourceAdapter.play(), targetAdapter.play()]);
        setPlayingAxes(true, true);
        setError(null);
        setStatus(
          `正在联动播放 A/B 第 ${spanIndex + 1} 段，默认只听${axisLabel(soloAxis)}${loopEnabled ? "，到段尾后循环" : "，到段尾后暂停"}。`
        );
        return;
      }
      const requestedPositionMs =
        sessionActions.position(activeAxis) >= interval.startMs &&
        sessionActions.position(activeAxis) < interval.endMs
          ? sessionActions.position(activeAxis)
          : interval.startMs;
      if (!sessionActions.loaded(activeAxis)) {
        const loaded = await loadAxis(activeAxis, requestedPositionMs, false);
        if (!loaded) return;
      }
      adapter.setMuted?.(false);
      await adapter.play();
      setPlayingAxes(activeAxis === "source", activeAxis === "target");
      setError(null);
      setStatus(
        `正在播放${axisLabel(activeAxis)}第 ${spanIndex + 1} 段${loopEnabled ? "，到段尾后循环" : "，到段尾后暂停"}。`
      );
    } catch (playError) {
      setError(formatPlaybackError(playError, playbackPair.backend));
    }
  }, [
    activeAxis,
    boundaryContext,
    loadAxis,
    loopEnabled,
    plan,
    playbackPair.backend,
    playbackMode,
    sessionActions,
    setPlaybackMode,
    setPlayingAxes,
    soloAxis,
    span,
    spanIndex,
    updatePosition
  ]);

  const restartInterval = useCallback(async (): Promise<void> => {
    sessionActions.pauseAll();
    setPlayingAxes(false, false);
    if (playbackMode === "linked" && canLinkDualPlayback(span)) {
      const targetInterval = reviewIntervalForAxis(plan, boundaryContext, "target");
      if (!targetInterval) return;
      const pair = resolveLinkedPlaybackPositions(span, "target", targetInterval.startMs);
      for (const axis of playbackAxes()) {
        if (!sessionActions.loaded(axis)) {
          const loaded = await loadAxis(
            axis,
            pair[axis === "source" ? "sourceMs" : "targetMs"],
            false
          );
          if (!loaded) return;
        } else {
          const nextPosition = axis === "source" ? pair.sourceMs : pair.targetMs;
          sessionActions.adapter(axis)?.seek(nextPosition);
          updatePosition(axis, nextPosition);
        }
      }
      setStatus(`已让 A/B 同时回到第 ${spanIndex + 1} 段段首。`);
      return;
    }
    const interval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
    if (!interval) return;
    const loaded = await loadAxis(activeAxis, interval.startMs, false);
    if (loaded) {
      setStatus(`已回到${axisLabel(activeAxis)}第 ${spanIndex + 1} 段段首。`);
    }
  }, [
    activeAxis,
    boundaryContext,
    loadAxis,
    plan,
    playbackMode,
    sessionActions,
    setPlayingAxes,
    span,
    spanIndex,
    updatePosition
  ]);

  const selectLoopScope = useCallback(
    (nextScope: "span" | TimeMapPlaybackBoundaryKind): void => {
      sessionActions.pauseAll();
      setPlayingAxes(false, false);
      setError(null);
      const nextContext =
        nextScope === "span"
          ? null
          : createTimeMapPlaybackBoundaryContext(
              span,
              nextScope,
              sourceMapRange,
              targetMapRange
            );
      const nextAxis =
        nextScope === "span" && !intervalForAxis(plan, activeAxis)
          ? plan.initialAxis
          : activeAxis;
      const nextInterval = reviewIntervalForAxis(plan, nextContext, nextAxis);
      setLoopScope(nextScope);
      setPlaybackMode(
        nextScope === "span" && canLinkDualPlayback(span) ? "linked" : "independent"
      );
      setActiveAxis(nextAxis);
      if (nextInterval) {
        updatePosition(nextAxis, nextInterval.startMs);
        if (sessionActions.loaded(nextAxis)) {
          sessionActions.adapter(nextAxis)?.seek(nextInterval.startMs);
        } else {
          sessionActions.loaded(nextAxis, false);
        }
      }
      setStatus(
        nextScope === "span"
          ? `已选择第 ${spanIndex + 1} 段完整区间。`
          : `已选择${nextScope === "startBoundary" ? "段首" : "段尾"}边界前后 3 秒；双方以 TimeMap 边界为中心对照。`
      );
    },
    [
      activeAxis,
      plan,
      sessionActions,
      setPlaybackMode,
      setPlayingAxes,
      sourceMapRange,
      span,
      spanIndex,
      targetMapRange,
      updatePosition
    ]
  );

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.hidden || document.visibilityState === "hidden") {
        resetPlaybackObservation();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [resetPlaybackObservation]);

  // A visible document can still have its pictures covered by a tool or menu.
  // Keep the session alive, but do not bridge observation across an obstruction.
  useEffect(
    () => subscribeNativeVideoLayout(resetPlaybackObservation),
    [resetPlaybackObservation]
  );
  useEffect(() => {
    resetPlaybackObservation();
    if (!visible) {
      sessionActions.pauseAll();
      setPlayingAxes(false, false);
    }
  }, [visible, resetPlaybackObservation, sessionActions, setPlayingAxes]);

  useEffect(() => {
    if (!open || (!adapterReady.source && !adapterReady.target)) {
      return;
    }
    const timer = window.setInterval(() => {
      const observedPositions = {
        source: sessionActions.position("source"),
        target: sessionActions.position("target")
      };
      for (const axis of playbackAxes()) {
        const adapter = sessionActions.adapter(axis);
        if (adapter && sessionActions.loaded(axis)) {
          observedPositions[axis] = adapter.getCurrentTimeMs();
          updatePosition(axis, observedPositions[axis]);
        }
      }
      if (!sessionActions.isPlaying()) {
        return;
      }
      if (
        playbackMode === "linked" &&
        sessionActions.isAxisPlaying("source") &&
        sessionActions.isAxisPlaying("target")
      ) {
        const targetPositionMs = observedPositions.target;
        const pair = resolveLinkedPlaybackPositions(span, "target", targetPositionMs);
        const sourcePositionMs = observedPositions.source;
        const correction = decideFollowerCorrection(pair.sourceMs, sourcePositionMs);
        if (correction.action === "seek") {
          sessionActions.adapter("source")?.seek(correction.positionMs);
          observedPositions.source = correction.positionMs;
          updatePosition("source", correction.positionMs);
        }
      }
      let nextEvidence = sessionEvidenceRef.current;
      let evidenceChanged = false;
      const surface = playbackSurfaceRef.current;
      const picturesVisible =
        visible &&
        !document.hidden &&
        document.visibilityState !== "hidden" &&
        !(surface && isNativeVideoObstructed(surface, surface.getBoundingClientRect()));
      for (const axis of playbackAxes()) {
        if (!sessionActions.isAxisPlaying(axis)) continue;
        const interval = reviewIntervalForAxis(plan, boundaryContext, axis);
        const adapter = sessionActions.adapter(axis);
        if (!interval || !adapter) continue;
        const accumulation = accumulateTimeMapPlaybackObservation(
          nextEvidence,
          playbackAccumulatorRefs.current[axis],
          {
            scope: loopScope,
            axis,
            positionMs: Math.max(0, Math.round(observedPositions[axis])),
            observedAtMs: performance.now(),
            playing: true,
            visible: picturesVisible
          },
          interval
        );
        playbackAccumulatorRefs.current[axis] = accumulation.accumulator;
        nextEvidence = accumulation.evidence;
        evidenceChanged = evidenceChanged || accumulation.creditedDurationMs > 0;
      }
      sessionEvidenceRef.current = nextEvidence;
      if (evidenceChanged) setSessionEvidence(nextEvidence);

      const boundaryAxis: TimeMapPlaybackAxis =
        playbackMode === "linked" ? "target" : activeAxis;
      const boundaryInterval = reviewIntervalForAxis(plan, boundaryContext, boundaryAxis);
      const boundaryAdapter = sessionActions.adapter(boundaryAxis);
      if (!boundaryInterval || !boundaryAdapter) return;
      const boundary = resolveTimeMapPlaybackBoundary(
        boundaryInterval,
        observedPositions[boundaryAxis],
        loopEnabled
      );
      if (!boundary.reachedEnd || boundary.seekToMs === null) {
        return;
      }
      resetPlaybackObservation();
      if (playbackMode === "linked") {
        const pair = resolveLinkedPlaybackPositions(span, "target", boundary.seekToMs);
        sessionActions.adapter("source")?.seek(pair.sourceMs);
        sessionActions.adapter("target")?.seek(pair.targetMs);
        updatePosition("source", pair.sourceMs);
        updatePosition("target", pair.targetMs);
      } else {
        boundaryAdapter.seek(boundary.seekToMs);
        updatePosition(boundaryAxis, boundary.seekToMs);
      }
      if (boundary.shouldPause) {
        sessionActions.pauseAll();
        setPlayingAxes(false, false);
        setStatus(
          playbackMode === "linked"
            ? "A/B 已到当前分段末端并暂停。"
            : `已到${axisLabel(activeAxis)}当前分段末端并暂停。`
        );
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [
    activeAxis,
    adapterReady,
    boundaryContext,
    loopEnabled,
    loopScope,
    open,
    plan,
    playbackMode,
    resetPlaybackObservation,
    sessionActions,
    setPlayingAxes,
    visible,
    span,
    updatePosition
  ]);

  const activeInterval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
  const counterpartResult = boundaryContext
    ? resolveTimeMapBoundaryPlaybackSwitch(
        span,
        boundaryContext,
        activeAxis,
        activeAxis === "source" ? "target" : "source",
        positions[activeAxis]
      )
    : null;
  const counterpartMs = boundaryContext
    ? counterpartResult?.status === "unavailable"
      ? null
      : (counterpartResult?.positionMs ?? null)
    : mapTimeMapPlaybackCounterpart(span, activeAxis, positions[activeAxis]);
  const counterpartKind = boundaryContext
    ? span.kind === "matched"
      ? "mapped"
      : "boundary-context"
    : counterpartMs === null
      ? "none"
      : "mapped";
  const sourcePositionLabel = playbackPositionLabel(
    "source",
    activeAxis,
    positions[activeAxis],
    counterpartMs,
    plan.kind,
    counterpartKind
  );
  const targetPositionLabel = playbackPositionLabel(
    "target",
    activeAxis,
    positions[activeAxis],
    counterpartMs,
    plan.kind,
    counterpartKind
  );
  const canOpen = playbackPair.available && Boolean(activeInterval);
  const playbackPhase = error
    ? "error"
    : loading
      ? "loading"
      : playing
        ? "playing"
        : sessionActions.loaded("source") || sessionActions.loaded("target")
          ? "ready"
          : adapterReady.source || adapterReady.target
            ? "preparing"
            : "unavailable";
  const retryCurrentMedia = async (): Promise<void> => {
    const interval = reviewIntervalForAxis(plan, boundaryContext, activeAxis);
    if (!interval) {
      setError("当前一侧没有可播放的时间范围。");
      return;
    }
    sessionActions.loaded(activeAxis, false);
    const loaded = await loadAxis(
      activeAxis,
      sessionActions.position(activeAxis) || interval.startMs,
      false
    );
    if (loaded) {
      setStatus(`已重新载入${axisLabel(activeAxis)}；可以播放。`);
    }
  };
  const copyPlaybackDiagnostic = async (): Promise<void> => {
    const snapshot = {
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      timeMapId,
      spanIndex,
      span,
      backend: playbackPair.backend,
      playbackPair: {
        available: playbackPair.available,
        backend: playbackPair.backend,
        message: playbackPair.message,
        source: diagnosticMediaSource(playbackPair.source),
        target: diagnosticMediaSource(playbackPair.target)
      },
      configuredMpvPath: settings.mpvPath,
      adapterReady,
      loadedAxes: {
        source: sessionActions.loaded("source"),
        target: sessionActions.loaded("target")
      },
      activeAxis,
      soloAxis,
      playbackMode,
      playbackPhase,
      positions,
      status,
      error
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setDiagnosticCopied(true);
      window.setTimeout(() => setDiagnosticCopied(false), 2_000);
    } catch (copyError) {
      setError(
        `复制调试快照失败：${copyError instanceof Error ? copyError.message : String(copyError)}`
      );
    }
  };
  const playbackProgress = assessTimeMapSpanPlaybackEvidence(
    timeMap,
    spanIndex,
    sessionEvidence
  );
  const missingPlaybackEvidence = describeMissingTimeMapSpanPlaybackEvidence(
    timeMap,
    spanIndex,
    sessionEvidence
  );

  return (
    <section
      ref={playbackSurfaceRef}
      className="playback-workspace"
      data-testid="time-map-playback-review"
    >
      {open ? (
        <div className="playback-workspace-main" aria-label="A/B 播放控制">
          <DualViewerWorkbench
            playbackPair={playbackPair}
            positions={positions}
            activeAxis={activeAxis}
            soloAxis={soloAxis}
            adapterReady={adapterReady}
            playbackMode={playbackMode}
            linkedModeAvailable={canLinkDualPlayback(span) && loopScope === "span"}
            soloAvailable={{
              source:
                !loading && Boolean(reviewIntervalForAxis(plan, boundaryContext, "source")),
              target:
                !loading && Boolean(reviewIntervalForAxis(plan, boundaryContext, "target"))
            }}
            onVideoRef={mediaSession.hosts.video}
            onNativeHostRef={mediaSession.hosts.native}
            overlays={
              danmakuVisible
                ? {
                    source: <CommentOverlay events={tracks.source} time={positions.source} />,
                    target: <CommentOverlay events={tracks.target} time={positions.target} />
                  }
                : undefined
            }
            onSoloAxis={(axis) => void switchAxis(axis)}
            onPlaybackMode={(mode) => {
              if (mode === "linked") {
                setPlaybackMode("linked");
                setStatus("已启用 A/B 联动播放；原片 B 为主时钟。");
                return;
              }
              sessionActions.pauseAll();
              setPlayingAxes(false, false);
              setPlaybackMode("independent");
              setStatus(`已解锁双视频；当前独立操作${axisLabel(activeAxis)}。`);
            }}
            controls={
              <>
                <TextButton
                  tone="primary"
                  disabled={loading || !adapterReady[activeAxis] || !activeInterval}
                  onClick={() => void togglePlayback()}
                >
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                  {loading ? "正在载入…" : playing ? "暂停当前段" : "播放当前段"}
                </TextButton>
                <TextButton
                  disabled={loading || !adapterReady[activeAxis] || !activeInterval}
                  onClick={() => void restartInterval()}
                  title="回到段首"
                >
                  <RotateCcw size={14} />
                  <span className="transport-optional-label">回到段首</span>
                </TextButton>
                <TextButton
                  aria-pressed={loopEnabled}
                  aria-label={loopEnabled ? "循环复核区间：开" : "循环复核区间：关"}
                  disabled={loading || !activeInterval}
                  onClick={() => {
                    setLoopEnabled((current) => !current);
                    setStatus(
                      loopEnabled ? "已关闭区间循环，到段尾后暂停。" : "已开启区间循环。"
                    );
                  }}
                >
                  <Repeat2 size={14} />
                  循环{loopEnabled ? "开" : "关"}
                </TextButton>
                <WorkspaceMenu
                  label={
                    loopScope === "span"
                      ? "当前分段"
                      : loopScope === "startBoundary"
                        ? "段首前后 3 秒"
                        : "段尾前后 3 秒"
                  }
                  items={[
                    { id: "span", label: "当前分段", onSelect: () => selectLoopScope("span") },
                    {
                      id: "start",
                      label: "段首前后 3 秒",
                      onSelect: () => selectLoopScope("startBoundary")
                    },
                    {
                      id: "end",
                      label: "段尾前后 3 秒",
                      onSelect: () => selectLoopScope("endBoundary")
                    }
                  ]}
                />
                <TextButton
                  onClick={() => setReviewDetailsOpen(true)}
                  title={missingPlaybackEvidence.join("、")}
                >
                  试听记录{persistedReview ? " ✓" : ""}
                </TextButton>
                <TextButton
                  aria-pressed={danmakuVisible}
                  onClick={() => setDanmakuVisible((value) => !value)}
                >
                  {danmakuVisible ? "隐藏弹幕" : "显示弹幕"}
                </TextButton>
              </>
            }
          />
          <div className="review-comment-strip" aria-label="当前弹幕对照">
            <span title="A 按来源时间显示；B 按正在编辑的时间映射显示。预览不会自动确认导出结果。">
              弹幕 A {tracks.source.length} → B {tracks.target.length}
              {tracks.uncertain > 0 ? ` · ${tracks.uncertain} 条未映射` : ""}
            </span>
            {visiblePreviewComments(tracks.source, positions.source)
              .slice(-3)
              .map((event) => (
                <button
                  key={event.id}
                  type="button"
                  title="定位这条弹幕的来源时间"
                  onClick={() =>
                    void seekFromTimeline({
                      side: "source",
                      positionMs: event.finalTimeMs,
                      token: 0
                    })
                  }
                >
                  <time>{formatTimecode(event.finalTimeMs)}</time> {event.item.text}
                </button>
              ))}
            {tracks.source.length === 0 ? (
              <span>在素材页将 XML 关联到此参考素材后显示弹幕。</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="viewer-unavailable">
          <p>
            {playbackPair.available ? "播放器已收起，时间线仍可编辑。" : playbackPair.message}
          </p>
          <TextButton disabled={!canOpen} onClick={() => onOpenChange(true)}>
            <Play size={14} />
            显示播放器
          </TextButton>
        </div>
      )}
      <div className="playback-status-line">
        <span className={playbackPhaseClass(playbackPhase)} role="status">
          {playbackPhaseLabel(playbackPhase)}
        </span>
        <span className="truncate" title={status} aria-live="polite">
          {loading ? "正在定位播放头…" : status}
        </span>
      </div>
      {error ? (
        <div className="editor-inline-error" role="alert">
          <span>{error}</span>
          <TextButton
            disabled={loading || !adapterReady[activeAxis]}
            onClick={() => void retryCurrentMedia()}
          >
            重新载入当前视频
          </TextButton>
        </div>
      ) : null}
      <ToolSheet
        title="试听记录"
        open={reviewDetailsOpen}
        onClose={() => setReviewDetailsOpen(false)}
      >
        <p className="mb-4 text-content-muted">
          {plan.explanation} 默认由原片 B 带动参考 A；只播放所选一侧的声音。
        </p>
        <p className="mb-4 tabular-nums">
          A 参考：{sourcePositionLabel} · B 原片：{targetPositionLabel}
        </p>
        {persistedReview ? (
          <p className="mb-4 text-feedback-success">本段已有与当前边界一致的播放复核证据。</p>
        ) : null}
        <div className="rounded border border-panel-line/70 bg-surface-inset p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-content-secondary">本段复核证据</span>
            {relationState === "candidate" ? (
              <TextButton
                className="ml-auto"
                tone="primary"
                disabled={missingPlaybackEvidence.length > 0 || loading}
                onClick={() => recordPlaybackReview(timeMapId, spanIndex, sessionEvidence)}
              >
                记录本段已复核
              </TextButton>
            ) : null}
          </div>
          <p className="mt-1 leading-5 text-content-muted">
            {missingPlaybackEvidence.length === 0
              ? "已达到本段要求的有效试听时长和覆盖范围，可以保存证据。"
              : `还需：${missingPlaybackEvidence.join("、")}。`}
          </p>
          <p className="mt-1 leading-5 text-content-muted">
            只累计页面可见且播放器时间连续向前推进的 1
            倍速试听；暂停、后台、拖动、切轴和循环跳回均不计时。
          </p>
          <ul className="mt-2 grid gap-1.5" aria-label="本段有效试听进度">
            {playbackProgress.map((progress) => {
              const completion = Math.min(
                1,
                progress.effectiveDurationMs / progress.minimumEffectiveMs,
                progress.coveredDurationMs / progress.minimumCoveredMs
              );
              return (
                <li
                  key={progress.slot}
                  className="grid gap-1 rounded border border-panel-line/60 bg-surface-inset px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={
                        progress.complete ? "text-feedback-success" : "text-content-secondary"
                      }
                    >
                      {progress.label}
                    </span>
                    <span className="text-content-muted">
                      有效{" "}
                      {formatPlaybackSeconds(
                        Math.min(progress.effectiveDurationMs, progress.minimumEffectiveMs)
                      )}
                      /{formatPlaybackSeconds(progress.minimumEffectiveMs)} · 覆盖{" "}
                      {formatPlaybackSeconds(
                        Math.min(progress.coveredDurationMs, progress.minimumCoveredMs)
                      )}
                      /{formatPlaybackSeconds(progress.minimumCoveredMs)}
                    </span>
                  </div>
                  <progress
                    className="h-1.5 w-full accent-cyan-400"
                    max={1}
                    value={completion}
                    aria-label={`${progress.label}完成进度`}
                  />
                </li>
              );
            })}
          </ul>
          {relationState === "accepted" && !persistedReview ? (
            <p className="mt-1 leading-5 text-feedback-warning">
              已确认图缺少本段播放证据；请撤销确认，回到候选完成真实播放复核后再保存关系。
            </p>
          ) : null}
        </div>

        <div className="mt-5 grid gap-3">
          <h3 className="font-medium">播放器技术诊断</h3>
          <p className="text-content-muted">{playbackPair.message}</p>
          <TextButton onClick={() => void copyPlaybackDiagnostic()}>
            <ClipboardCopy size={14} />
            {diagnosticCopied ? "已复制" : "复制调试快照"}
          </TextButton>
          <TextButton
            disabled={!canOpen}
            onClick={() => {
              onOpenChange(!open);
              setReviewDetailsOpen(false);
            }}
          >
            <Square size={14} />
            {open ? "收起播放器" : "显示播放器"}
          </TextButton>
        </div>
      </ToolSheet>
    </section>
  );
}

function playbackPhaseLabel(
  phase: "error" | "loading" | "playing" | "ready" | "preparing" | "unavailable"
) {
  if (phase === "error") return "载入失败";
  if (phase === "loading") return "正在载入";
  if (phase === "playing") return "正在播放";
  if (phase === "ready") return "可以播放";
  if (phase === "preparing") return "正在准备";
  return "不可用";
}

function playbackPhaseClass(
  phase: "error" | "loading" | "playing" | "ready" | "preparing" | "unavailable"
) {
  const tone =
    phase === "error" || phase === "unavailable"
      ? "border-feedback-danger/35 bg-feedback-danger/10 text-feedback-danger"
      : phase === "playing" || phase === "ready"
        ? "border-feedback-success/35 bg-feedback-success/10 text-feedback-success"
        : "border-feedback-running/30 bg-feedback-running/10 text-feedback-running";
  return `rounded border px-2 py-0.5 text-ui-caption ${tone}`;
}

function diagnosticMediaSource(source: { kind: string; name: string; url: string } | null) {
  if (!source) return null;
  const url = source.url.replace(
    /([?&](?:api_key|X-Emby-Token|token)=)[^&]*/gi,
    "$1<redacted>"
  );
  return { ...source, url };
}

function formatPlaybackError(error: unknown, backend: TimeMapPlaybackBackend | null): string {
  const detail = error instanceof Error ? error.message : String(error);
  return backend === "htmlVideo"
    ? `内嵌播放器无法播放这条媒体：${detail} 请在设置中心配置 libmpv 后重试。`
    : `libmpv A/B 复核失败：${detail}`;
}

function createNativeSessionId(timeMapId: string, axis: TimeMapPlaybackAxis): string {
  const normalized = timeMapId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-32) || "time-map";
  return `review_${normalized}_${axis}`.slice(0, 64);
}

function axisLabel(axis: TimeMapPlaybackAxis): string {
  return axis === "source" ? "参考 A" : "原片 B";
}

function playbackAxes(): readonly TimeMapPlaybackAxis[] {
  return ["source", "target"];
}

function formatPlaybackSeconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1_000).toFixed(1)} 秒`;
}

function reviewIntervalForAxis(
  plan: ReturnType<typeof createTimeMapPlaybackSpanPlan>,
  boundaryContext: TimeMapPlaybackBoundaryContext | null,
  axis: TimeMapPlaybackAxis
): TimeMapPlaybackInterval | null {
  if (boundaryContext) {
    return axis === "source" ? boundaryContext.sourceInterval : boundaryContext.targetInterval;
  }
  return intervalForAxis(plan, axis);
}

function playbackPositionLabel(
  axis: TimeMapPlaybackAxis,
  activeAxis: TimeMapPlaybackAxis,
  activePositionMs: number,
  counterpartMs: number | null,
  kind: ReturnType<typeof createTimeMapPlaybackSpanPlan>["kind"],
  counterpartKind: "mapped" | "boundary-context" | "none"
): string {
  if (axis === activeAxis) {
    return formatTimecode(activePositionMs);
  }
  if (counterpartMs !== null) {
    return counterpartKind === "boundary-context"
      ? `${formatTimecode(counterpartMs)}（边界对照，非映射）`
      : `${formatTimecode(counterpartMs)}（映射）`;
  }
  if (kind === "ambiguous") {
    return "未同步";
  }
  return "此段不存在";
}
