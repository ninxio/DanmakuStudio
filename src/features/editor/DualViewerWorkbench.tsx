import { FileAudio, Link2, Unlink2, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import { TextButton } from "../../components/TextButton";
import type { TimeMapPlaybackAxis } from "../../domain/alignment/timeMapPlayback";
import type { DualPlaybackMode } from "../../domain/player/dualPlaybackCoordinator";
import type { PlaybackMediaPair } from "../../domain/player/playbackMediaPair";
import { formatTimecode } from "../../domain/shared/time";
import { NativeVideoHost } from "./NativeVideoHost";

interface DualViewerWorkbenchProps {
  playbackPair: PlaybackMediaPair;
  positions: Record<TimeMapPlaybackAxis, number>;
  activeAxis: TimeMapPlaybackAxis;
  soloAxis: TimeMapPlaybackAxis;
  adapterReady: Record<TimeMapPlaybackAxis, boolean>;
  playbackMode: DualPlaybackMode;
  linkedModeAvailable: boolean;
  soloAvailable?: Record<TimeMapPlaybackAxis, boolean>;
  onVideoRef: (axis: TimeMapPlaybackAxis, element: HTMLVideoElement | null) => void;
  onNativeHostRef: (axis: TimeMapPlaybackAxis, element: HTMLDivElement | null) => void;
  onSoloAxis: (axis: TimeMapPlaybackAxis) => void;
  onPlaybackMode: (mode: DualPlaybackMode) => void;
  controls?: ReactNode;
  overlays?: Partial<Record<TimeMapPlaybackAxis, ReactNode>>;
}

const PLAYBACK_AXES: readonly TimeMapPlaybackAxis[] = ["source", "target"];

export function DualViewerWorkbench({
  playbackPair,
  positions,
  activeAxis,
  soloAxis,
  adapterReady,
  playbackMode,
  linkedModeAvailable,
  soloAvailable,
  onVideoRef,
  onNativeHostRef,
  onSoloAxis,
  onPlaybackMode,
  controls,
  overlays
}: DualViewerWorkbenchProps) {
  return (
    <div className="dual-viewer-workbench">
      <div
        className="dual-viewer-pictures"
        data-testid="dual-video-viewers"
        role="group"
        aria-label="A/B 等宽监视器"
      >
        {PLAYBACK_AXES.map((axis) => {
          const media = axis === "source" ? playbackPair.source : playbackPair.target;
          const contentKind =
            axis === "source" ? playbackPair.sourceContentKind : playbackPair.targetContentKind;
          const audioOnly = contentKind === "audio";
          return (
            <article
              key={axis}
              className="dual-viewer-monitor"
              data-active={activeAxis === axis}
            >
              <div className="dual-viewer-caption">
                <span
                  className="font-medium text-content-secondary"
                  title={axis === "target" ? "原片 B 是联动播放的主时钟" : media?.name}
                >
                  {axis === "source" ? "A · 参考素材" : "B · 目标原片"}
                </span>
                {audioOnly ? (
                  <span className="inline-flex items-center gap-1 rounded border border-feedback-running/30 bg-feedback-running/10 px-1.5 py-0.5 text-ui-caption text-feedback-running">
                    <FileAudio size={11} aria-hidden="true" />
                    纯音频
                  </span>
                ) : null}
                <span className="text-ui-caption text-content-muted">
                  {formatTimecode(positions[axis])}
                </span>
                <TextButton
                  className="viewer-solo"
                  tone={soloAxis === axis ? "primary" : "neutral"}
                  disabled={!media || !adapterReady[axis] || soloAvailable?.[axis] === false}
                  aria-pressed={soloAxis === axis}
                  onClick={() => onSoloAxis(axis)}
                >
                  <Volume2 size={12} />
                  {soloAxis === axis ? `正在听${axisLabel(axis)}` : `只听${axisLabel(axis)}`}
                </TextButton>
              </div>
              <div className="dual-viewer-frame">
                <div
                  className={
                    playbackPair.backend === "htmlVideo"
                      ? "relative h-full min-h-0 w-full overflow-hidden bg-black"
                      : "hidden"
                  }
                >
                  <video
                    ref={(element) => onVideoRef(axis, element)}
                    className="absolute inset-0 h-full w-full object-contain"
                    playsInline
                    preload="metadata"
                    aria-label={`${axisLabel(axis)}媒体`}
                  />
                  {audioOnly || !media ? (
                    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-gradient-to-b from-violet-950/40 to-black px-4 text-center">
                      <div className="grid justify-items-center gap-2 text-xs text-white/80">
                        <FileAudio size={30} aria-hidden="true" />
                        <span>
                          {media
                            ? "纯音频素材：可试听、同步和编辑时间线，无画面可复核"
                            : "当前没有可播放媒体"}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {overlays?.[axis]}
                </div>
                {playbackPair.backend === "nativeMpv" ? (
                  <NativeVideoHost
                    accessibleLabel={`${axisLabel(axis)} libmpv 应用内画面`}
                    onHostRef={(element) => onNativeHostRef(axis, element)}
                  >
                    {media
                      ? audioOnly
                        ? `${axisLabel(axis)}是纯音频素材；可正常试听和同步，但没有画面。`
                        : `${axisLabel(axis)}正在应用内准备画面。`
                      : `${axisLabel(axis)}当前没有可播放媒体。`}
                  </NativeVideoHost>
                ) : null}
                {playbackPair.backend !== "htmlVideo" &&
                playbackPair.backend !== "nativeMpv" ? (
                  <div className="viewer-unavailable">{playbackPair.message}</div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <div className="editor-transport" role="group" aria-label="选择双视频播放模式">
        {controls}
        <TextButton
          tone={playbackMode === "linked" ? "primary" : "neutral"}
          disabled={!linkedModeAvailable}
          aria-pressed={playbackMode === "linked"}
          onClick={() => onPlaybackMode("linked")}
        >
          <Link2 size={13} />
          联动播放
        </TextButton>
        <TextButton
          tone={playbackMode === "independent" ? "primary" : "neutral"}
          aria-pressed={playbackMode === "independent"}
          onClick={() => onPlaybackMode("independent")}
        >
          <Unlink2 size={13} />
          独立操作
        </TextButton>
      </div>
    </div>
  );
}

function axisLabel(axis: TimeMapPlaybackAxis): string {
  return axis === "source" ? "参考 A" : "原片 B";
}
