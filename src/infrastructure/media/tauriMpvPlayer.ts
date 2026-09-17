import { invoke, isTauri } from "@tauri-apps/api/core";

export type MediaToolKind = "ffmpeg" | "mpv";
export type MpvPlaybackStatus = "idle" | "playing" | "paused" | "stopped" | "failed";
export type MpvControlAction =
  | "play"
  | "pause"
  | "seek"
  | "setPlaybackRate"
  | "setMuted";
export type MpvTrackType = "video" | "audio" | "subtitle" | "unknown";

export interface MediaToolDetectionRequest {
  tool: MediaToolKind;
  executablePath: string | null;
}

export interface MediaToolDetectionResult {
  tool: MediaToolKind;
  executablePath: string;
  available: boolean;
  version: string | null;
  message: string;
}

export interface MpvStartRequest {
  mpvPath: string;
  mediaPath: string;
  startPositionMs?: number;
  startPaused?: boolean;
}

export interface MpvControlRequest {
  action: MpvControlAction;
  positionMs?: number;
  playbackRate?: number;
}

export interface MpvTrackSummary {
  id: number;
  trackType: MpvTrackType;
  title: string | null;
  language: string | null;
  codec: string | null;
  selected: boolean;
  external: boolean;
}

export interface MpvSidecarStatus {
  running: boolean;
  backend: "native-mpv";
  playbackStatus: MpvPlaybackStatus;
  mediaPath: string | null;
  positionMs: number;
  durationMs: number;
  tracks: MpvTrackSummary[];
  message: string;
  error: string | null;
  updatedAtMs: number;
}

export interface TauriMpvBridge {
  detectTool: (request: MediaToolDetectionRequest) => Promise<MediaToolDetectionResult>;
  start: (request: MpvStartRequest) => Promise<MpvSidecarStatus>;
  stop: () => Promise<MpvSidecarStatus>;
  status: () => Promise<MpvSidecarStatus>;
  control: (request: MpvControlRequest) => Promise<MpvSidecarStatus>;
}

const defaultTauriMpvBridge: TauriMpvBridge = {
  detectTool: (request) => invoke<MediaToolDetectionResult>("detect_media_tool", { request }),
  start: (request) => invoke<MpvSidecarStatus>("start_mpv_sidecar", { request }),
  stop: () => invoke<MpvSidecarStatus>("stop_mpv_sidecar"),
  status: () => invoke<MpvSidecarStatus>("get_mpv_sidecar_status"),
  control: (request) => invoke<MpvSidecarStatus>("control_mpv_sidecar", { request })
};

export async function detectMediaTool(
  request: MediaToolDetectionRequest,
  bridge: TauriMpvBridge = defaultTauriMpvBridge
): Promise<MediaToolDetectionResult> {
  ensureDesktopMpvBridge(bridge === defaultTauriMpvBridge, "检测播放器工具");
  return bridge.detectTool(request);
}

export async function startTauriMpvSidecar(
  request: MpvStartRequest,
  bridge: TauriMpvBridge = defaultTauriMpvBridge
): Promise<MpvSidecarStatus> {
  ensureDesktopMpvBridge(bridge === defaultTauriMpvBridge, "启动 mpv 播放器");
  return bridge.start(request);
}

export async function stopTauriMpvSidecar(
  bridge: TauriMpvBridge = defaultTauriMpvBridge
): Promise<MpvSidecarStatus> {
  ensureDesktopMpvBridge(bridge === defaultTauriMpvBridge, "停止 mpv 播放器");
  return bridge.stop();
}

export async function getTauriMpvSidecarStatus(
  bridge: TauriMpvBridge = defaultTauriMpvBridge
): Promise<MpvSidecarStatus> {
  ensureDesktopMpvBridge(bridge === defaultTauriMpvBridge, "读取 mpv 播放器状态");
  return bridge.status();
}

export async function controlTauriMpvSidecar(
  request: MpvControlRequest,
  bridge: TauriMpvBridge = defaultTauriMpvBridge
): Promise<MpvSidecarStatus> {
  ensureDesktopMpvBridge(bridge === defaultTauriMpvBridge, "控制 mpv 播放器");
  return bridge.control(request);
}

export function formatMpvSidecarError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureDesktopMpvBridge(usesDefaultBridge: boolean, action: string): void {
  if (usesDefaultBridge && !isTauri()) {
    throw new Error(`${action}需要在 Tauri 桌面端运行。`);
  }
}
