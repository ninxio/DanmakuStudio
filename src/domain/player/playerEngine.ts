import type { Milliseconds } from "../shared/time";

export type PlayerEngineKind = "html-video" | "native-mpv";
export type PlayerBackendPreference = "auto" | "htmlVideo" | "nativeMpv";
export type PlayerTrackType = "video" | "audio" | "subtitle" | "unknown";

export interface PlayerMediaSource {
  kind: "file" | "url";
  name: string;
  url: string;
}

export interface PlayerTrack {
  id: number;
  trackType: PlayerTrackType;
  title: string | null;
  language: string | null;
  codec: string | null;
  selected: boolean;
  external: boolean;
}

/**
 * 与具体播放器实现无关的最小控制契约。
 *
 * React 只依赖这层；HTML Video 和进程内 libmpv 都通过基础设施
 * 适配器实现它，不把原生 handle 或窗口状态泄漏给界面。
 */
export interface PlayerEngine {
  load(source: PlayerMediaSource, startPositionMs?: Milliseconds): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(timeMs: Milliseconds): void;
  getCurrentTimeMs(): Milliseconds;
  getDurationMs(): Milliseconds;
  getTracks(): PlayerTrack[];
  setPlaybackRate(rate: number): void;
  setMuted?(muted: boolean): void;
  dispose(): void;
}
