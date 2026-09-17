import { subscribeNativeVideoLayout } from "../../infrastructure/media/nativeVideoLayout";
import { serializePreviewAss } from "../../domain/preview/danmakuTrack";
import { Flag, Pause, Play } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import type { ResolvedDanmakuEvent } from "../../domain/danmaku/types";
import {
  getPreviewEvents,
  ROLLING_DANMAKU_DURATION_MS,
  STATIC_DANMAKU_DURATION_MS
} from "../../domain/preview/visibleEvents";
import {
  createPlayerSessionSummary,
  type PlayerLoadState,
  type PlayerMediaTrack,
  type PlayerPreviewBackend,
  type PlayerSessionSummary
} from "../../domain/player/playerSession";
import { isLikelyHtmlMediaFile } from "../../domain/player/playbackMediaPair";
import {
  createPlayerReliabilitySummary,
  PLAYER_SEEK_SYNC_TOLERANCE_MS,
  type PlayerReliabilitySourceKind,
  type PlayerReliabilitySummary
} from "../../domain/player/playerReliability";
import {
  createPlayerSourceComparisonSummary,
  type PlayerSourceComparisonSummary
} from "../../domain/player/playerComparison";
import { statusLabel } from "../../domain/shared/statusVocabulary";
import { formatTimecode } from "../../domain/shared/time";
import { resolveProjectDanmakuEvents } from "../../domain/timeline/mapping";
import {
  HtmlVideoMediaAdapter,
  TauriLibMpvMediaAdapter,
  type EmbeddedMpvMediaAdapter,
  type MediaAdapter,
  type MediaSource
} from "../../infrastructure/media/mediaAdapter";
import { measureNativeVideoBounds } from "../../infrastructure/media/tauriLibMpvPlayer";
import {
  authenticateEmby,
  createEmbyAuthorizedStreamUrl,
  fetchEmbyItem
} from "../../infrastructure/metadata/embyClient";
import { usePlaybackSettings } from "./usePlaybackSettings";
import { loadVolatileEmbyPassword } from "../../infrastructure/settings/volatileEmbyCredentials";
import { useEditorStore } from "../../stores/editorStore";

type VideoLoadState = PlayerLoadState;
type PreviewBackend = PlayerPreviewBackend;

interface EmbyPreviewInput {
  url: string;
  label: string;
}

interface EmbyPreviewStatus {
  tone: "neutral" | "success" | "warning" | "error";
  message: string;
}

type PreviewAdapterFactory = (options: {
  backend: PreviewBackend;
  video: HTMLVideoElement | null;
  nativeHost: HTMLDivElement | null;
  mpvPath: string;
}) => MediaAdapter | null;

interface PreviewPanelProps {
  adapterFactory?: PreviewAdapterFactory;
  compact?: boolean;
}

const defaultPreviewAdapterFactory: PreviewAdapterFactory = ({
  backend,
  video,
  nativeHost,
  mpvPath
}) =>
  backend === "nativeMpv"
    ? nativeHost
      ? new TauriLibMpvMediaAdapter({
          sessionId: "main_preview",
          mpvPath,
          getBounds: () => measureNativeVideoBounds(nativeHost)
        })
      : null
    : video
      ? new HtmlVideoMediaAdapter(video)
      : null;

export function PreviewPanel({
  adapterFactory = defaultPreviewAdapterFactory,
  compact = false
}: PreviewPanelProps = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nativeVideoHostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<MediaAdapter | null>(null);
  const playheadRef = useRef(0);
  const loadedSourceRef = useRef<string | null>(null);
  const project = useEditorStore((state) => state.project);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const setPlaying = useEditorStore((state) => state.setPlaying);
  const togglePlayback = useEditorStore((state) => state.togglePlayback);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const updateMediaDuration = useEditorStore((state) => state.updateMediaDuration);
  const updatePreview = useEditorStore((state) => state.updatePreview);
  const addCutMarkerAtPlayhead = useEditorStore((state) => state.addCutMarkerAtPlayhead);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoLoadState, setVideoLoadState] = useState<VideoLoadState>("empty");
  const [playerTracks, setPlayerTracks] = useState<PlayerMediaTrack[]>([]);
  const [embyPreviewInput, setEmbyPreviewInput] = useState<EmbyPreviewInput | null>(null);
  const [preparingEmbyPreview, setPreparingEmbyPreview] = useState(false);
  const [embyPreviewStatus, setEmbyPreviewStatus] = useState<EmbyPreviewStatus | null>(null);
  const appSettings = usePlaybackSettings();
  const preferredBackend = appSettings.player.preferredBackend;
  const mpvPath = appSettings.player.mpvPath;
  const embyBinding = project.mediaBinding?.kind === "embyItem" ? project.mediaBinding : null;
  const localBinding = project.mediaBinding?.kind === "localFile" ? project.mediaBinding : null;
  const boundLocalMedia = localBinding?.mediaId
    ? (project.mediaLibrary.find((media) => media.id === localBinding.mediaId) ?? null)
    : null;
  const activeLibraryReference =
    project.mediaLibrary.find(
      (media) =>
        media.role === "bilibiliReference" &&
        Boolean(media.objectUrl || media.localPath?.trim())
    ) ?? null;
  const activeReferenceMedia = project.media ?? activeLibraryReference ?? null;
  const mediaObjectUrl = activeReferenceMedia?.objectUrl ?? boundLocalMedia?.objectUrl ?? null;
  const mediaName = activeReferenceMedia?.name ?? boundLocalMedia?.name ?? "视频";
  const previewMediaId = activeReferenceMedia?.id ?? boundLocalMedia?.id ?? null;
  const localMediaPath =
    activeLibraryReference?.localPath?.trim() ??
    (localBinding ? (localBinding.localPath?.trim() ?? "") : "");
  const localMediaFileName =
    activeLibraryReference?.fileName ?? (localBinding ? localBinding.fileName : mediaName);
  const hasLocalMediaPath = localMediaPath.length > 0;
  const nativeMpvSource: { kind: MediaSource["kind"]; url: string; name: string } | null =
    hasLocalMediaPath
      ? { kind: "file", url: localMediaPath, name: localMediaFileName }
      : embyPreviewInput
        ? { kind: "url", url: embyPreviewInput.url, name: embyPreviewInput.label }
        : null;
  const canUseNativeMpv = nativeMpvSource !== null;
  const htmlLikelySupported = isLikelyHtmlMediaFile(
    activeReferenceMedia?.fileName ?? localMediaFileName
  );
  const previewBackend: PreviewBackend =
    canUseNativeMpv &&
    (Boolean(embyPreviewInput) ||
      preferredBackend === "nativeMpv" ||
      !mediaObjectUrl ||
      !htmlLikelySupported)
      ? "nativeMpv"
      : "htmlVideo";
  const previewSource =
    previewBackend === "nativeMpv" ? (nativeMpvSource?.url ?? null) : mediaObjectUrl;
  const previewSourceKind: MediaSource["kind"] =
    previewBackend === "nativeMpv" ? (nativeMpvSource?.kind ?? "file") : "url";
  const previewSourceName =
    previewBackend === "nativeMpv" ? (nativeMpvSource?.name ?? mediaName) : mediaName;
  const mediaFileName =
    previewBackend === "nativeMpv"
      ? (nativeMpvSource?.name ?? mediaName)
      : (activeReferenceMedia?.fileName ?? boundLocalMedia?.fileName ?? mediaName);
  const previewDurationMs =
    activeReferenceMedia?.durationMs ??
    boundLocalMedia?.durationMs ??
    project.mediaBinding?.runtimeMs ??
    0;
  const canPrepareEmbyPreview = Boolean(embyBinding && !hasLocalMediaPath && !embyPreviewInput);
  const localBindingNeedsReconnect =
    project.mediaBinding?.kind === "localFile" &&
    !hasLocalMediaPath &&
    !boundLocalMedia?.objectUrl &&
    (!project.media ||
      !project.media.objectUrl ||
      (project.mediaBinding.mediaId
        ? project.media.id !== project.mediaBinding.mediaId
        : project.media.fileName !== project.mediaBinding.fileName));
  const mediaReferenceNeedsReconnect = Boolean(
    activeReferenceMedia && !activeReferenceMedia.objectUrl
  );
  const reliabilitySourceKind: PlayerReliabilitySourceKind =
    previewBackend === "nativeMpv" && previewSourceKind === "url" && embyPreviewInput
      ? "embyStream"
      : previewBackend === "nativeMpv" && previewSourceKind === "file" && previewSource
        ? "localPath"
        : mediaObjectUrl
          ? "localObject"
          : "none";
  const playerSession = useMemo(
    () =>
      createPlayerSessionSummary({
        project,
        isPlaying,
        backend: previewBackend,
        loadState: videoLoadState,
        hasPreviewSource: Boolean(previewSource),
        videoError,
        mpvConfigured: mpvPath.trim().length > 0,
        tracks: playerTracks
      }),
    [
      project,
      isPlaying,
      previewBackend,
      videoLoadState,
      previewSource,
      videoError,
      mpvPath,
      playerTracks
    ]
  );
  const playerReliability = useMemo(
    () =>
      createPlayerReliabilitySummary({
        backend: previewBackend,
        loadState: videoLoadState,
        hasPreviewSource: Boolean(previewSource),
        sourceKind: reliabilitySourceKind,
        videoError,
        mpvConfigured: mpvPath.trim().length > 0
      }),
    [previewBackend, videoLoadState, previewSource, reliabilitySourceKind, videoError, mpvPath]
  );
  const sourceComparison = useMemo(
    () =>
      createPlayerSourceComparisonSummary({
        project,
        referenceTimeMs: project.timeline.playheadMs,
        hasReferencePlaybackSource: Boolean(mediaObjectUrl)
      }),
    [project, mediaObjectUrl]
  );

  const { assets, clips, disabledItemIds, globalOffsetMs, cutMarkers, itemTimeAdjustments } =
    project;
  const events = useMemo(
    () =>
      resolveProjectDanmakuEvents({
        assets,
        clips,
        disabledItemIds,
        globalOffsetMs,
        cutMarkers,
        itemTimeAdjustments
      }),
    [assets, clips, disabledItemIds, globalOffsetMs, cutMarkers, itemTimeAdjustments]
  );
  const danmakuRevision = useRef(0);
  const visibleEvents = useMemo(
    () => getPreviewEvents(events, project.timeline.playheadMs),
    [events, project.timeline.playheadMs]
  );
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter?.setDanmakuTrack || videoLoadState !== "ready") return;
    let cancelled = false;
    try {
      const assContent = project.preview.danmakuVisible
        ? serializePreviewAss(events, project.preview.opacity)
        : null;
      void adapter
        .setDanmakuTrack({
          revision: ++danmakuRevision.current,
          assContent,
          visible: project.preview.danmakuVisible
        })
        .catch((reason: unknown) => {
          if (!cancelled) setVideoError(`弹幕轨无法加载：${String(reason)}`);
        });
    } catch (reason) {
      setVideoError(String(reason));
    }
    return () => {
      cancelled = true;
    };
  }, [events, project.preview.danmakuVisible, project.preview.opacity, videoLoadState]);

  const prepareEmbyPreview = async (): Promise<void> => {
    if (!embyBinding) {
      setEmbyPreviewStatus({ tone: "warning", message: "当前项目没有绑定 Emby 目标原片。" });
      return;
    }
    const password = loadVolatileEmbyPassword(embyBinding.server).trim();
    if (password.length === 0) {
      setEmbyPreviewStatus({
        tone: "warning",
        message: "请在设置中心核对当前项目的 Emby 服务器和账号，再保存本次会话密码。"
      });
      return;
    }
    setPreparingEmbyPreview(true);
    setEmbyPreviewStatus({ tone: "neutral", message: "正在准备 Emby 授权流..." });
    try {
      const config = {
        serverUrl: embyBinding.server.serverUrl,
        pathPrefix: embyBinding.server.pathPrefix
      };
      const session = await authenticateEmby(config, {
        username: embyBinding.server.username,
        password
      });
      const item = await fetchEmbyItem(config, session, embyBinding.itemId);
      const mediaSourceId = item.mediaSources[0]?.id ?? embyBinding.mediaSources[0]?.id ?? null;
      const url = createEmbyAuthorizedStreamUrl(
        config,
        session,
        embyBinding.itemId,
        mediaSourceId
      );
      const label = formatEmbyPreviewInputLabel(item.name, mediaSourceId);
      setEmbyPreviewInput({ url, label });
      setEmbyPreviewStatus({
        tone: "success",
        message: `已准备 Emby 授权流：${label}。临时播放地址不会写入项目文件。`
      });
    } catch (error) {
      setEmbyPreviewStatus({
        tone: "error",
        message: `Emby 授权流准备失败：${error instanceof Error ? error.message : "Emby 请求失败。"}`
      });
    } finally {
      setPreparingEmbyPreview(false);
    }
  };

  useEffect(() => {
    playheadRef.current = project.timeline.playheadMs;
  }, [project.timeline.playheadMs]);

  useEffect(() => {
    setEmbyPreviewInput(null);
    setEmbyPreviewStatus(null);
  }, [project.mediaBinding?.id]);

  useEffect(() => {
    const video = videoRef.current;
    const adapter = adapterFactory({
      backend: previewBackend,
      video,
      nativeHost: nativeVideoHostRef.current,
      mpvPath
    });
    if (!adapter) {
      return;
    }
    adapterRef.current = adapter;
    loadedSourceRef.current = null;
    setPlayerTracks([]);
    return () => {
      adapter.dispose();
      if (adapterRef.current === adapter) {
        adapterRef.current = null;
      }
    };
  }, [adapterFactory, mpvPath, previewBackend, project.id, projectEpoch]);

  useEffect(() => {
    const host = nativeVideoHostRef.current;
    if (previewBackend !== "nativeMpv" || !previewSource || !host) return;
    let frame = 0;
    const updateBounds = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const adapter = adapterRef.current as EmbeddedMpvMediaAdapter | null;
        adapter?.setHostBounds?.(measureNativeVideoBounds(host));
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(host);
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
  }, [previewBackend, previewSource]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    if (!previewSource) {
      if (loadedSourceRef.current) {
        adapter.dispose();
        loadedSourceRef.current = null;
      }
      setVideoError(null);
      setVideoLoadState("empty");
      setPlayerTracks([]);
      setPlaying(false);
      return;
    }
    let cancelled = false;
    const sourceKey = `${previewBackend}:${previewSource}`;
    let publishedDuration: number | null = null;
    const isCurrent = (): boolean => {
      const current = useEditorStore.getState();
      return (
        !cancelled &&
        adapterRef.current === adapter &&
        current.project.id === project.id &&
        current.projectEpoch === projectEpoch
      );
    };
    const syncMetadata = (): void => {
      if (!isCurrent()) return;
      const duration = adapter.getDurationMs();
      // An unknown duration must not erase cached metadata or create a save on every poll.
      if (duration > 0 && duration !== publishedDuration) {
        publishedDuration = duration;
        updateMediaDuration(duration, previewMediaId);
      }
      updatePlayerTracks(setPlayerTracks, adapter.getTracks());
    };
    const unsubscribeStatus = adapter.subscribeStatus?.((status) => {
      if (!isCurrent()) return;
      if (status.loadState === "ready") syncMetadata();
      if (status.loadState === "failed") {
        setVideoError(status.error || "媒体加载失败，请重新加载。");
        setVideoLoadState("unsupported");
        setPlaying(false);
      }
    });
    setPlaying(false);
    setVideoLoadState("loading");
    setVideoError(null);
    void adapter
      .load(
        { kind: previewSourceKind, name: previewSourceName, url: previewSource },
        playheadRef.current
      )
      .then(() => {
        if (isCurrent()) {
          loadedSourceRef.current = sourceKey;
          syncMetadata();
          setVideoLoadState("ready");
        }
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          setVideoError(error instanceof Error ? error.message : "视频加载失败。");
          setVideoLoadState("unsupported");
          setPlaying(false);
        }
      });
    return () => {
      cancelled = true;
      unsubscribeStatus?.();
    };
  }, [
    project.id,
    projectEpoch,
    mpvPath,
    adapterFactory,
    previewBackend,
    previewMediaId,
    previewSource,
    previewSourceKind,
    previewSourceName,
    setPlaying,
    updateMediaDuration
  ]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    if (
      Math.abs(adapter.getCurrentTimeMs() - project.timeline.playheadMs) >
      PLAYER_SEEK_SYNC_TOLERANCE_MS
    ) {
      adapter.seek(project.timeline.playheadMs);
    }
  }, [project.timeline.playheadMs]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) {
      return;
    }
    if (isPlaying) {
      void adapter.play().catch(() => setPlaying(false));
    } else {
      adapter.pause();
    }
  }, [isPlaying, setPlaying]);

  useEffect(() => {
    let raf = 0;
    let lastTick = performance.now();
    let lastPublished = 0;
    const tick = (now: number): void => {
      if (isPlaying && now - lastPublished >= 32) {
        lastPublished = now;
        const adapter = adapterRef.current;
        if (adapter && previewSource) {
          const nextTime = Math.round(adapter.getCurrentTimeMs());
          if (nextTime !== playheadRef.current) setPlayhead(nextTime);
          updatePlayerTracks(setPlayerTracks, adapter.getTracks());
        } else {
          const delta = now - lastTick;
          setPlayhead(playheadRef.current + delta);
        }
        lastTick = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, previewSource, setPlayhead]);

  return (
    <div
      className={`flex h-full min-h-0 flex-col bg-surface-canvas ${compact ? "preview-compact" : ""}`}
    >
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
        data-testid="preview-panel"
      >
        <video
          ref={videoRef}
          aria-label="视频预览画面"
          className={`h-full w-full object-contain transition-opacity ${
            previewBackend === "htmlVideo" && mediaObjectUrl ? "opacity-100" : "opacity-0"
          }`}
          data-testid="preview-video"
          playsInline
          preload="metadata"
          onPause={() => setPlaying(false)}
        />
        {!previewSource ? (
          <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-white/80">
            <div className="max-w-[min(420px,calc(100%-32px))]">
              <div className="text-white/80">
                {localBindingNeedsReconnect || mediaReferenceNeedsReconnect
                  ? "需要重新连接视频"
                  : canPrepareEmbyPreview
                    ? "可使用 Emby 授权流预览"
                    : preferredBackend === "nativeMpv" && !hasLocalMediaPath
                      ? "需要选择本地原片路径"
                      : "尚未导入参考视频"}
              </div>
              <div className="mt-2 text-xs leading-5">
                {localBindingNeedsReconnect
                  ? "项目保存了目标原片引用，但没有保存视频内容。请重新导入同一份参考视频，或在目标原片中选择本地路径。"
                  : mediaReferenceNeedsReconnect
                    ? "项目里只有媒体引用，没有当前会话可播放的视频对象。请重新导入参考视频。"
                    : canPrepareEmbyPreview
                      ? "mpv 可以读取本次会话生成的 Emby 临时播放地址；项目文件不会保存密码、token 或播放 URL。"
                      : preferredBackend === "nativeMpv" && !hasLocalMediaPath
                        ? "mpv 需要真实本地文件路径。请在“媒体 / 目标原片”里选择本地路径。"
                        : "当前仍可编辑弹幕时间轴，导入 MP4/WebM 参考视频后可同步预览。"}
              </div>
              {canPrepareEmbyPreview ? (
                <div className="mt-3 grid justify-items-center gap-2">
                  <TextButton
                    onClick={() => void prepareEmbyPreview()}
                    disabled={preparingEmbyPreview}
                  >
                    {preparingEmbyPreview ? statusLabel("preparing") : "使用 Emby 授权流预览"}
                  </TextButton>
                  {embyPreviewStatus ? (
                    <div
                      className={`max-w-[360px] text-xs leading-5 ${
                        embyPreviewStatus.tone === "error"
                          ? "text-rose-200"
                          : embyPreviewStatus.tone === "warning"
                            ? "text-amber-200"
                            : embyPreviewStatus.tone === "success"
                              ? "text-emerald-200"
                              : "text-white/80"
                      }`}
                    >
                      {embyPreviewStatus.message}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {previewBackend === "nativeMpv" && previewSource ? (
          <div
            ref={nativeVideoHostRef}
            className="absolute inset-0 flex items-center justify-center bg-black text-center text-sm text-white/80"
            aria-label="libmpv 应用内视频画面"
          >
            <div className="max-w-[min(420px,calc(100%-32px))]">
              <div className="text-white/80">应用内 libmpv 播放器</div>
              <div className="mt-2 text-xs leading-5">
                {previewSourceKind === "url"
                  ? "Emby 授权流正在当前区域播放；临时地址只保存在本次会话内。"
                  : "本地视频将由进程内 libmpv 直接渲染在当前区域，不再弹出独立窗口。"}
              </div>
              {embyPreviewInput ? (
                <div className="mt-2 text-xs leading-5 text-sky-200">
                  已使用 Emby 授权流：{embyPreviewInput.label}。
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {previewSource ? (
          <div className="absolute left-3 top-3 max-w-[min(420px,calc(100%-24px))] rounded border border-white/10 bg-black/55 px-3 py-2 text-xs text-white/80 shadow-lg backdrop-blur">
            <div className="truncate font-medium text-white/80">{mediaFileName}</div>
            <div className="mt-1 text-white/80">
              {videoLoadState === "loading"
                ? "正在加载预览..."
                : videoLoadState === "ready"
                  ? `${formatPreviewBackend(previewBackend)} 已就绪 / ${formatTimecode(previewDurationMs)}`
                  : videoLoadState === "unsupported"
                    ? "格式不支持"
                    : "等待视频载入"}
            </div>
          </div>
        ) : null}
        {videoError ? (
          <div className="absolute left-4 top-4 max-w-[min(520px,calc(100%-32px))] rounded border border-rose-200/40 bg-[#411c29] px-3 py-2 text-xs leading-5 text-rose-100">
            <div className="font-medium">格式不支持</div>
            <div>{videoError}</div>
          </div>
        ) : null}
        {project.preview.safeAreaVisible ? (
          <div className="pointer-events-none absolute inset-[8%] border border-dashed border-white/35" />
        ) : null}
        {project.preview.danmakuVisible && previewBackend !== "nativeMpv" ? (
          <DanmakuOverlay
            events={visibleEvents}
            currentTimeMs={project.timeline.playheadMs}
            opacity={project.preview.opacity}
          />
        ) : null}
      </div>
      <details className="preview-diagnostics" open={compact ? undefined : true}>
        <summary>播放详情{videoError ? ` · ${videoError}` : ""}</summary>
        <PlayerSessionStrip summary={playerSession} />
        {sourceComparison.visible ? (
          <PlayerSourceComparisonStrip summary={sourceComparison} />
        ) : null}
        <PlayerReliabilityStrip summary={playerReliability} />
      </details>
      <div className="preview-transport flex min-h-12 shrink-0 items-center gap-3 border-t border-panel-line bg-panel-base px-3">
        <IconButton
          label={isPlaying ? "暂停预览" : "播放预览"}
          icon={isPlaying ? <Pause size={16} /> : <Play size={16} />}
          active={isPlaying}
          onClick={togglePlayback}
        />
        <div className="font-mono text-xs text-content-secondary">
          {formatTimecode(project.timeline.playheadMs)}
        </div>
        <div className="text-xs text-content-muted">/ {formatTimecode(previewDurationMs)}</div>
        <div className="text-xs text-content-muted">{formatPreviewBackend(previewBackend)}</div>
        <TextButton
          className="shrink-0 whitespace-nowrap"
          onClick={() => updatePreview({ danmakuVisible: !project.preview.danmakuVisible })}
        >
          {project.preview.danmakuVisible ? "隐藏弹幕" : "显示弹幕"}
        </TextButton>
        <TextButton className="shrink-0 whitespace-nowrap" onClick={addCutMarkerAtPlayhead}>
          <Flag size={14} />
          添加播放点差异
        </TextButton>
        <label className="ml-auto flex items-center gap-2 text-xs text-content-muted">
          透明度
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={project.preview.opacity}
            className="w-28 accent-accent-cyan"
            onChange={(event) => updatePreview({ opacity: Number(event.target.value) })}
          />
        </label>
      </div>
    </div>
  );
}

function PlayerSessionStrip({ summary }: { summary: PlayerSessionSummary }) {
  const items = [
    { label: "播放源", value: summary.sourceLabel, detail: summary.sourceDetail },
    { label: "后端", value: summary.backendLabel, detail: summary.backendDetail },
    {
      label: "播放",
      value: summary.playbackLabel,
      detail: summary.issueLabel ?? summary.nextActionLabel
    },
    { label: "音轨", value: summary.audioTrackLabel, detail: summary.subtitleTrackLabel },
    { label: "弹幕", value: summary.danmakuTrackLabel, detail: summary.cacheLabel }
  ];
  return (
    <section
      aria-label="播放器会话状态"
      className="shrink-0 border-t border-panel-line bg-surface-inset px-3 py-2 text-ui-caption text-content-muted"
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-content-muted">{item.label}</span>
              <span className="min-w-0 truncate text-content-secondary">{item.value}</span>
            </div>
            <div className="mt-0.5 truncate text-content-muted" title={item.detail}>
              {item.detail}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerSourceComparisonStrip({ summary }: { summary: PlayerSourceComparisonSummary }) {
  const items = [
    { label: "对比", value: summary.stateLabel, detail: summary.nextActionLabel },
    { label: "参考源", value: summary.referenceLabel, detail: summary.referenceDetail },
    { label: "目标源", value: summary.targetLabel, detail: summary.targetDetail },
    { label: "参考时间", value: summary.referenceTimeLabel, detail: "编辑时间轴当前位置" },
    { label: "目标时间", value: summary.targetTimeLabel, detail: summary.compensationDetail },
    { label: "已补偿", value: summary.compensationLabel, detail: summary.compensationDetail }
  ];
  return (
    <section
      aria-label="双源对比状态"
      className="shrink-0 border-t border-panel-line bg-surface-canvas px-3 py-2 text-ui-caption text-content-muted"
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-content-muted">{item.label}</span>
              <span className="min-w-0 truncate text-content-secondary">{item.value}</span>
            </div>
            <div className="mt-0.5 truncate text-content-muted" title={item.detail}>
              {item.detail}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlayerReliabilityStrip({ summary }: { summary: PlayerReliabilitySummary }) {
  const items = [
    { label: "可靠性", value: summary.statusLabel, detail: summary.recoveryDetail },
    {
      label: "同步",
      value: summary.performanceTargetLabel,
      detail: summary.performanceStateLabel
    },
    { label: "缓存", value: summary.cachePolicyLabel, detail: summary.cacheDetail },
    { label: "恢复", value: summary.recoveryLabel, detail: summary.recoveryDetail }
  ];
  return (
    <section
      aria-label="播放可靠性状态"
      className="shrink-0 border-t border-panel-line bg-surface-inset px-3 py-2 text-ui-caption text-content-muted"
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <div className="flex items-center gap-1">
              <span className="shrink-0 text-content-muted">{item.label}</span>
              <span className="min-w-0 truncate text-content-secondary">{item.value}</span>
            </div>
            <div className="mt-0.5 truncate text-content-muted" title={item.detail}>
              {item.detail}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DanmakuOverlay({
  events,
  currentTimeMs,
  opacity
}: {
  events: ResolvedDanmakuEvent[];
  currentTimeMs: number;
  opacity: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="danmaku-overlay"
    >
      {events.map((event) => {
        const mode = event.item.mode ?? 1;
        const isTop = mode === 5;
        const isBottom = mode === 4;
        const duration =
          isTop || isBottom ? STATIC_DANMAKU_DURATION_MS : ROLLING_DANMAKU_DURATION_MS;
        const progress = Math.min(
          1,
          Math.max(0, (currentTimeMs - event.finalTimeMs) / duration)
        );
        const lane = event.originalIndex % 10;
        const fontSize = Math.min(34, Math.max(14, event.item.fontSize ?? 25));
        const color = `#${(event.item.color ?? 16_777_215).toString(16).padStart(6, "0").slice(-6)}`;
        const baseStyle = {
          color,
          fontSize: `${fontSize}px`,
          opacity
        };
        if (isTop || isBottom) {
          return (
            <div
              key={event.id}
              className="danmaku-preview-text absolute left-1/2 max-w-[88%] -translate-x-1/2 whitespace-nowrap font-semibold"
              style={{
                ...baseStyle,
                top: isTop ? `${5 + lane * 6}%` : undefined,
                bottom: isBottom ? `${5 + lane * 6}%` : undefined
              }}
            >
              {event.item.text}
            </div>
          );
        }
        return (
          <div
            key={event.id}
            className="danmaku-preview-text absolute whitespace-nowrap font-semibold"
            style={{
              ...baseStyle,
              top: `${6 + lane * 7}%`,
              left: `${100 - progress * 145}%`
            }}
          >
            {event.item.text}
          </div>
        );
      })}
    </div>
  );
}

function formatPreviewBackend(backend: PreviewBackend): string {
  return backend === "nativeMpv" ? "libmpv" : "HTML Video";
}

function formatEmbyPreviewInputLabel(itemName: string, mediaSourceId: string | null): string {
  return mediaSourceId ? `${itemName} / 媒体源 ${mediaSourceId}` : itemName;
}

function updatePlayerTracks(
  setPlayerTracks: Dispatch<SetStateAction<PlayerMediaTrack[]>>,
  nextTracks: PlayerMediaTrack[]
): void {
  setPlayerTracks((currentTracks) =>
    arePlayerTracksEqual(currentTracks, nextTracks) ? currentTracks : nextTracks
  );
}

function arePlayerTracksEqual(
  left: readonly PlayerMediaTrack[],
  right: readonly PlayerMediaTrack[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((track, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      track.id === other.id &&
      track.trackType === other.trackType &&
      track.title === other.title &&
      track.language === other.language &&
      track.codec === other.codec &&
      track.selected === other.selected &&
      track.external === other.external
    );
  });
}
