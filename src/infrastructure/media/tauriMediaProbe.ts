import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MediaContentIdentity } from "../../domain/project/types";

export interface TauriMediaTimelineProbeRequest {
  path: string;
  ffprobePath?: string | null;
  ffmpegPath?: string | null;
}

export interface TauriMediaIdentityProbeRequest {
  path: string;
}

export interface MediaTimelineStreamBase {
  index: number;
  codec: string | null;
  startMs: number;
  timelineOffsetMs: number;
  durationMs: number | null;
  timeBase: string | null;
  language: string | null;
  title: string | null;
  default: boolean;
  commentary: boolean;
}

export interface MediaTimelineVideoStream extends MediaTimelineStreamBase {
  frameRate: number | null;
}

export interface MediaTimelineAudioStream extends MediaTimelineStreamBase {
  sampleRate: number | null;
  channels: number | null;
}

export interface MediaTimelineProbeResult {
  presentationOriginMs: number;
  durationMs: number | null;
  contentIdentity: MediaContentIdentity | null;
  videoStreams: MediaTimelineVideoStream[];
  audioStreams: MediaTimelineAudioStream[];
  preferredAudioStreamIndex: number | null;
}

export type MediaTimelineProbeInvoker = (
  request: TauriMediaTimelineProbeRequest
) => Promise<MediaTimelineProbeResult>;

export type MediaIdentityProbeInvoker = (
  request: TauriMediaIdentityProbeRequest
) => Promise<MediaContentIdentity>;

export async function probeTauriMediaTimeline(
  request: TauriMediaTimelineProbeRequest,
  invoker: MediaTimelineProbeInvoker = defaultMediaTimelineProbeInvoker
): Promise<MediaTimelineProbeResult> {
  if (invoker === defaultMediaTimelineProbeInvoker && !isTauri()) {
    throw new Error("媒体时间轴探测需要在 Tauri 桌面端运行。");
  }

  try {
    return await invoker(request);
  } catch (error: unknown) {
    throw new Error(`媒体时间轴探测失败：${formatProbeFailure(error)}`);
  }
}

export async function probeTauriMediaIdentity(
  request: TauriMediaIdentityProbeRequest,
  invoker: MediaIdentityProbeInvoker = defaultMediaIdentityProbeInvoker
): Promise<MediaContentIdentity> {
  if (invoker === defaultMediaIdentityProbeInvoker && !isTauri()) {
    throw new Error("媒体身份探测需要在 Tauri 桌面端运行。");
  }

  try {
    return await invoker(request);
  } catch (error: unknown) {
    throw new Error(`媒体身份探测失败：${formatProbeFailure(error)}`);
  }
}

function defaultMediaTimelineProbeInvoker(
  request: TauriMediaTimelineProbeRequest
): Promise<MediaTimelineProbeResult> {
  return invoke<MediaTimelineProbeResult>("probe_media_timeline", { request });
}

function defaultMediaIdentityProbeInvoker(
  request: TauriMediaIdentityProbeRequest
): Promise<MediaContentIdentity> {
  return invoke<MediaContentIdentity>("probe_media_identity", { request });
}

function formatProbeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
