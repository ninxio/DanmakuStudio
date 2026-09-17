import { isNativeVideoObstructed } from "./nativeVideoLayout";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MpvControlAction, MpvPlaybackStatus, MpvTrackSummary } from "./tauriMpvPlayer";

export interface NativeVideoBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export interface LibMpvRuntimeRequest {
  mpvPath: string;
}

export interface LibMpvDanmakuRequest {
  sessionId: string;
  revision: number;
  assContent: string | null;
  visible: boolean;
}

export interface LibMpvDanmakuResult {
  revision: number;
  state: "applied" | "pending" | "cleared";
}

export type NativeDanmakuTrack = Omit<LibMpvDanmakuRequest, "sessionId">;

export interface LibMpvRuntimeStatus {
  available: boolean;
  libraryPath: string | null;
  clientApiVersion: string | null;
  message: string;
}

export interface LibMpvCreateSessionRequest {
  sessionId: string;
  mpvPath: string;
  mediaPath: string;
  startPositionMs?: number;
  startPaused?: boolean;
  bounds: NativeVideoBounds;
}

export interface LibMpvControlRequest {
  sessionId: string;
  action: MpvControlAction | "load";
  mediaPath?: string;
  positionMs?: number;
  playbackRate?: number;
  muted?: boolean;
  startPaused?: boolean;
}

export interface LibMpvSessionIdRequest {
  sessionId: string;
}

export interface LibMpvBoundsRequest extends LibMpvSessionIdRequest {
  bounds: NativeVideoBounds;
}

export interface LibMpvSessionStatus {
  sessionId: string;
  running: boolean;
  loadRevision: number;
  loadState: "idle" | "loading" | "ready" | "failed";
  playbackStatus: MpvPlaybackStatus;
  mediaName: string | null;
  positionMs: number;
  durationMs: number;
  tracks: MpvTrackSummary[];
  message: string;
  error: string | null;
}

/** Local subscription snapshot. Position continues through the existing playback getter. */
export type LibMpvMediaStatus = Pick<
  LibMpvSessionStatus,
  | "loadRevision"
  | "loadState"
  | "running"
  | "playbackStatus"
  | "durationMs"
  | "tracks"
  | "error"
>;

export interface TauriLibMpvBridge {
  setDanmakuTrack?: (request: LibMpvDanmakuRequest) => Promise<LibMpvDanmakuResult>;
  detectRuntime: (request: LibMpvRuntimeRequest) => Promise<LibMpvRuntimeStatus>;
  createSession: (request: LibMpvCreateSessionRequest) => Promise<LibMpvSessionStatus>;
  controlSession: (request: LibMpvControlRequest) => Promise<LibMpvSessionStatus>;
  getSessionStatus: (request: LibMpvSessionIdRequest) => Promise<LibMpvSessionStatus>;
  setSessionBounds: (request: LibMpvBoundsRequest) => Promise<LibMpvSessionStatus>;
  destroySession: (request: LibMpvSessionIdRequest) => Promise<LibMpvSessionStatus>;
}

const defaultTauriLibMpvBridge: TauriLibMpvBridge = {
  setDanmakuTrack: (request) =>
    invoke<LibMpvDanmakuResult>("set_libmpv_danmaku_track", { request }),
  detectRuntime: (request) => invoke<LibMpvRuntimeStatus>("detect_libmpv_runtime", { request }),
  createSession: (request) => invoke<LibMpvSessionStatus>("create_libmpv_session", { request }),
  controlSession: (request) =>
    invoke<LibMpvSessionStatus>("control_libmpv_session", { request }),
  getSessionStatus: (request) =>
    invoke<LibMpvSessionStatus>("get_libmpv_session_status", { request }),
  setSessionBounds: (request) =>
    invoke<LibMpvSessionStatus>("set_libmpv_session_bounds", { request }),
  destroySession: (request) =>
    invoke<LibMpvSessionStatus>("destroy_libmpv_session", { request })
};

export async function detectTauriLibMpvRuntime(
  request: LibMpvRuntimeRequest,
  bridge?: TauriLibMpvBridge
): Promise<LibMpvRuntimeStatus> {
  return getTauriLibMpvBridge(bridge, "检测 libmpv 运行库").detectRuntime(request);
}

export function getTauriLibMpvBridge(
  bridge: TauriLibMpvBridge | undefined,
  action: string
): TauriLibMpvBridge {
  if (!bridge && !isTauri()) {
    throw new Error(`${action}需要在 Tauri 桌面端运行。`);
  }
  return bridge ?? defaultTauriLibMpvBridge;
}

export function measureNativeVideoBounds(element: HTMLElement): NativeVideoBounds {
  const rect = element.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const scale = window.devicePixelRatio || 1;
  const visible =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewportHeight &&
    rect.left < viewportWidth &&
    isNativeHostVisible(element) &&
    !isNativeVideoObstructed(element, rect);
  return {
    x: Math.round(rect.left * scale),
    y: Math.round(rect.top * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
    visible
  };
}

function isNativeHostVisible(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  }
  for (
    let ancestor: HTMLElement | null = element;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (
      ancestor.matches("details:not([open])") &&
      !ancestor.querySelector(":scope > summary")?.contains(element)
    )
      return false;
    const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor);
    if (
      ancestor.hidden ||
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    )
      return false;
  }
  return true;
}
