import { subscribeNativeVideoLayout } from "../../../infrastructure/media/nativeVideoLayout";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimeMapPlaybackAxis } from "../../../domain/alignment/timeMapPlayback";
import type { DualPlaybackMode } from "../../../domain/player/dualPlaybackCoordinator";
import type {
  PlaybackBackend,
  PlaybackMediaPair
} from "../../../domain/player/playbackMediaPair";
import {
  HtmlVideoMediaAdapter,
  TauriLibMpvMediaAdapter,
  type EmbeddedMpvMediaAdapter,
  type MediaAdapter
} from "../../../infrastructure/media/mediaAdapter";
import { measureNativeVideoBounds } from "../../../infrastructure/media/tauriLibMpvPlayer";

type AxisRecord<T> = Record<TimeMapPlaybackAxis, T>;

export type TimeMapPlaybackBackend = PlaybackBackend;

export type TimeMapPlaybackAdapterFactory = (options: {
  axis: TimeMapPlaybackAxis;
  backend: TimeMapPlaybackBackend;
  video: HTMLVideoElement | null;
  nativeHost: HTMLDivElement | null;
  sessionId: string;
  mpvPath: string;
}) => MediaAdapter | null;

interface TimeMapPlaybackMediaSessionOptions {
  open: boolean;
  playbackPair: PlaybackMediaPair;
  nativeSessionIds: Readonly<AxisRecord<string>>;
  mpvPath: string;
  initialPositions: AxisRecord<number>;
  initialPlaybackMode: DualPlaybackMode;
  initialSoloAxis: TimeMapPlaybackAxis;
  adapterFactory?: TimeMapPlaybackAdapterFactory;
  onPlaybackStopped: () => void;
  onInitializationError?: (message: string | null) => void;
}

export interface TimeMapPlaybackMediaSession {
  snapshot: {
    adapterReady: AxisRecord<boolean>;
    positions: AxisRecord<number>;
    playing: boolean;
    playbackMode: DualPlaybackMode;
    soloAxis: TimeMapPlaybackAxis;
  };
  hosts: {
    video: (axis: TimeMapPlaybackAxis, element: HTMLVideoElement | null) => void;
    native: (axis: TimeMapPlaybackAxis, element: HTMLDivElement | null) => void;
  };
  actions: {
    adapter: (axis: TimeMapPlaybackAxis) => MediaAdapter | null;
    pauseAll: () => void;
    loaded: (axis: TimeMapPlaybackAxis, next?: boolean) => boolean;
    beginOperation: (axis: TimeMapPlaybackAxis) => () => boolean;
    position: (axis: TimeMapPlaybackAxis, next?: number) => number;
    isPlaying: () => boolean;
    isAxisPlaying: (axis: TimeMapPlaybackAxis) => boolean;
    setPlayingAxes: (source: boolean, target: boolean) => void;
    setPlaybackMode: (mode: DualPlaybackMode) => void;
    setSoloAxis: (axis: TimeMapPlaybackAxis) => void;
    resetForSpan: (options: {
      positions: AxisRecord<number>;
      playbackMode: DualPlaybackMode;
      soloAxis: TimeMapPlaybackAxis;
    }) => void;
  };
}

const defaultAdapterFactory: TimeMapPlaybackAdapterFactory = ({
  backend,
  video,
  nativeHost,
  sessionId,
  mpvPath
}) =>
  backend === "nativeMpv"
    ? nativeHost
      ? new TauriLibMpvMediaAdapter({
          sessionId,
          mpvPath,
          getBounds: () => measureNativeVideoBounds(nativeHost)
        })
      : null
    : video
      ? new HtmlVideoMediaAdapter(video)
      : null;

export function useTimeMapPlaybackMediaSession({
  open,
  playbackPair,
  nativeSessionIds,
  mpvPath,
  initialPositions,
  initialPlaybackMode,
  initialSoloAxis,
  adapterFactory = defaultAdapterFactory,
  onPlaybackStopped,
  onInitializationError
}: TimeMapPlaybackMediaSessionOptions): TimeMapPlaybackMediaSession {
  const videoHosts = useRef<AxisRecord<HTMLVideoElement | null>>({
    source: null,
    target: null
  });
  const nativeHosts = useRef<AxisRecord<HTMLDivElement | null>>({
    source: null,
    target: null
  });
  const adapters = useRef<AxisRecord<MediaAdapter | null>>({ source: null, target: null });
  const loadedAxes = useRef<AxisRecord<boolean>>({ source: false, target: false });
  const positionValues = useRef<AxisRecord<number>>(initialPositions);
  const playingValue = useRef(false);
  const playingAxes = useRef<AxisRecord<boolean>>({ source: false, target: false });
  const operations = useRef<AxisRecord<number>>({ source: 0, target: 0 });
  const [adapterReady, setAdapterReady] = useState<AxisRecord<boolean>>({
    source: false,
    target: false
  });
  const [positions, setPositions] = useState(initialPositions);
  const [playing, setPlaying] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(initialPlaybackMode);
  const [soloAxis, setSoloAxis] = useState(initialSoloAxis);

  const setPlayingAxes = useCallback(
    (source: boolean, target: boolean): void => {
      playingAxes.current = { source, target };
      const next = source || target;
      playingValue.current = next;
      if (!next) onPlaybackStopped();
      setPlaying(next);
    },
    [onPlaybackStopped]
  );

  const setPosition = useCallback((axis: TimeMapPlaybackAxis, next: number): void => {
    const normalized = Math.max(0, Math.round(next));
    positionValues.current = { ...positionValues.current, [axis]: normalized };
    setPositions((current) =>
      current[axis] === normalized ? current : { ...current, [axis]: normalized }
    );
  }, []);

  const pauseAll = useCallback((): void => {
    adapters.current.source?.pause();
    adapters.current.target?.pause();
  }, []);

  const invalidateOperations = useCallback((): void => {
    operations.current.source += 1;
    operations.current.target += 1;
  }, []);

  const resetForSpan = useCallback(
    ({
      positions: nextPositions,
      playbackMode: nextMode,
      soloAxis: nextSoloAxis
    }: {
      positions: AxisRecord<number>;
      playbackMode: DualPlaybackMode;
      soloAxis: TimeMapPlaybackAxis;
    }): void => {
      invalidateOperations();
      pauseAll();
      // New spans seek the same media pair; decoder ownership changes only with adapters.
      setPlayingAxes(false, false);
      setPlaybackMode(nextMode);
      setSoloAxis(nextSoloAxis);
      setPosition("source", nextPositions.source);
      setPosition("target", nextPositions.target);
    },
    [invalidateOperations, pauseAll, setPlayingAxes, setPosition]
  );

  const bindVideoHost = useCallback(
    (axis: TimeMapPlaybackAxis, element: HTMLVideoElement | null): void => {
      videoHosts.current[axis] = element;
    },
    []
  );
  const bindNativeHost = useCallback(
    (axis: TimeMapPlaybackAxis, element: HTMLDivElement | null): void => {
      nativeHosts.current[axis] = element;
    },
    []
  );
  const adapter = useCallback((axis: TimeMapPlaybackAxis) => adapters.current[axis], []);
  const loaded = useCallback((axis: TimeMapPlaybackAxis, next?: boolean): boolean => {
    if (next !== undefined) {
      loadedAxes.current = { ...loadedAxes.current, [axis]: next };
    }
    return loadedAxes.current[axis];
  }, []);
  const beginOperation = useCallback((axis: TimeMapPlaybackAxis): (() => boolean) => {
    const operation = operations.current[axis] + 1;
    operations.current[axis] = operation;
    return () => operations.current[axis] === operation;
  }, []);
  const position = useCallback(
    (axis: TimeMapPlaybackAxis, next?: number): number => {
      if (next !== undefined) setPosition(axis, next);
      return next === undefined ? positionValues.current[axis] : Math.max(0, Math.round(next));
    },
    [setPosition]
  );
  const isPlaying = useCallback((): boolean => playingValue.current, []);
  const isAxisPlaying = useCallback(
    (axis: TimeMapPlaybackAxis): boolean => playingAxes.current[axis],
    []
  );

  useEffect(() => {
    if (!open || !playbackPair.available || !playbackPair.backend) {
      setAdapterReady({ source: false, target: false });
      return;
    }
    const nextAdapters: AxisRecord<MediaAdapter | null> = {
      source: playbackPair.source
        ? adapterFactory({
            axis: "source",
            backend: playbackPair.backend,
            video: videoHosts.current.source,
            nativeHost: nativeHosts.current.source,
            sessionId: nativeSessionIds.source,
            mpvPath
          })
        : null,
      target: playbackPair.target
        ? adapterFactory({
            axis: "target",
            backend: playbackPair.backend,
            video: videoHosts.current.target,
            nativeHost: nativeHosts.current.target,
            sessionId: nativeSessionIds.target,
            mpvPath
          })
        : null
    };
    if (!nextAdapters.source && !nextAdapters.target) {
      setAdapterReady({ source: false, target: false });
      onInitializationError?.("播放器初始化失败，请关闭复核后重试。");
      return;
    }
    adapters.current = nextAdapters;
    setAdapterReady({
      source: Boolean(nextAdapters.source),
      target: Boolean(nextAdapters.target)
    });
    onInitializationError?.(null);
    const operationCounters = operations.current;
    return () => {
      operationCounters.source += 1;
      operationCounters.target += 1;
      for (const axis of playbackAxes()) {
        const adapter = nextAdapters[axis];
        adapter?.pause();
        adapter?.dispose();
        if (adapters.current[axis] === adapter) {
          adapters.current[axis] = null;
        }
      }
      loadedAxes.current = { source: false, target: false };
      playingValue.current = false;
      playingAxes.current = { source: false, target: false };
    };
  }, [
    adapterFactory,
    mpvPath,
    nativeSessionIds.source,
    nativeSessionIds.target,
    onInitializationError,
    open,
    playbackPair.available,
    playbackPair.backend,
    playbackPair.source,
    playbackPair.target
  ]);

  useEffect(() => {
    if (!open || playbackPair.backend !== "nativeMpv") return;
    let frame = 0;
    const updateBounds = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        for (const axis of playbackAxes()) {
          const host = nativeHosts.current[axis];
          const adapter = adapters.current[axis] as EmbeddedMpvMediaAdapter | null;
          if (host) adapter?.setHostBounds?.(measureNativeVideoBounds(host));
        }
      });
    };
    const observer = new ResizeObserver(updateBounds);
    for (const axis of playbackAxes()) {
      const host = nativeHosts.current[axis];
      if (host) observer.observe(host);
    }
    const unsubscribeLayout = subscribeNativeVideoLayout(updateBounds);
    window.addEventListener("resize", updateBounds);
    window.addEventListener("scroll", updateBounds, true);
    updateBounds();
    return () => {
      unsubscribeLayout();
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      window.removeEventListener("scroll", updateBounds, true);
      window.cancelAnimationFrame(frame);
    };
  }, [open, playbackPair.backend]);

  const hosts = useMemo(
    () => ({ video: bindVideoHost, native: bindNativeHost }),
    [bindNativeHost, bindVideoHost]
  );
  const actions = useMemo(
    () => ({
      adapter,
      pauseAll,
      loaded,
      beginOperation,
      position,
      isPlaying,
      isAxisPlaying,
      setPlayingAxes,
      setPlaybackMode,
      setSoloAxis,
      resetForSpan
    }),
    [
      adapter,
      beginOperation,
      isAxisPlaying,
      isPlaying,
      loaded,
      pauseAll,
      position,
      resetForSpan,
      setPlayingAxes
    ]
  );

  return {
    snapshot: { adapterReady, positions, playing, playbackMode, soloAxis },
    hosts,
    actions
  };
}

function playbackAxes(): readonly TimeMapPlaybackAxis[] {
  return ["source", "target"];
}
