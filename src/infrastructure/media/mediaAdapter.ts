import type { Milliseconds } from "../../domain/shared/time";
import type {
  PlayerEngine,
  PlayerMediaSource,
  PlayerTrack
} from "../../domain/player/playerEngine";
import {
  controlTauriMpvSidecar,
  getTauriMpvSidecarStatus,
  startTauriMpvSidecar,
  stopTauriMpvSidecar,
  type MpvSidecarStatus,
  type TauriMpvBridge
} from "./tauriMpvPlayer";
import {
  getTauriLibMpvBridge,
  type NativeVideoBounds,
  type TauriLibMpvBridge,
  type LibMpvSessionStatus,
  type LibMpvMediaStatus
} from "./tauriLibMpvPlayer";
import type { NativeDanmakuTrack } from "./tauriLibMpvPlayer";

export type MediaSource = PlayerMediaSource;
export type MediaAdapter = PlayerEngine & {
  setDanmakuTrack?(track: NativeDanmakuTrack): Promise<void>;
  subscribeStatus?(listener: (status: LibMpvMediaStatus) => void): () => void;
  getStatus?(): LibMpvMediaStatus;
};

export class HtmlVideoMediaAdapter implements PlayerEngine {
  private video: HTMLVideoElement;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async load(source: MediaSource, startPositionMs: Milliseconds = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(
          new Error(
            "HTML Video 无法播放此视频。请改用 MP4/WebM；MKV 或复杂编码需要后续启用 mpv 播放器。"
          )
        );
      };
      const cleanup = (): void => {
        this.video.removeEventListener("loadedmetadata", onLoaded);
        this.video.removeEventListener("error", onError);
      };
      this.video.addEventListener("loadedmetadata", onLoaded);
      this.video.addEventListener("error", onError);
      this.video.src = source.url;
      this.video.load();
    });
    this.seek(startPositionMs);
  }

  async play(): Promise<void> {
    await this.video.play();
  }

  pause(): void {
    this.video.pause();
  }

  seek(timeMs: Milliseconds): void {
    this.video.currentTime = Math.max(0, timeMs) / 1000;
  }

  getCurrentTimeMs(): Milliseconds {
    return Math.round(this.video.currentTime * 1000);
  }

  getDurationMs(): Milliseconds {
    if (!Number.isFinite(this.video.duration)) {
      return 0;
    }
    return Math.round(this.video.duration * 1000);
  }

  getTracks(): PlayerTrack[] {
    return [];
  }

  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted;
  }

  dispose(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

export interface NativeMpvMediaAdapter extends PlayerEngine {
  readonly kind: "native-mpv";
  getSupportedContainerNote(): string;
  setDanmakuTrack?(track: NativeDanmakuTrack): Promise<void>;
}

export interface EmbeddedMpvMediaAdapter extends NativeMpvMediaAdapter {
  prepare(): Promise<void>;
  setHostBounds(bounds: NativeVideoBounds): void;
  subscribeStatus?(listener: (status: LibMpvMediaStatus) => void): () => void;
  getStatus?(): LibMpvMediaStatus;
}

export interface TauriLibMpvMediaAdapterOptions {
  sessionId: string;
  mpvPath: string;
  getBounds: () => NativeVideoBounds;
  bridge?: TauriLibMpvBridge;
}

const libMpvSessionOwners = new Map<string, TauriLibMpvMediaAdapter>();
const LIBMPV_LOAD_TIMEOUT_MS = 30_000;

function sameNativeVideoBounds(
  left: NativeVideoBounds | null,
  right: NativeVideoBounds | null
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height &&
      left.visible === right.visible
    )
  );
}

export class TauriLibMpvMediaAdapter implements EmbeddedMpvMediaAdapter {
  readonly kind = "native-mpv";

  private readonly sessionId: string;
  private mpvPath: string;
  private readonly getBounds: () => NativeVideoBounds;
  private readonly bridge?: TauriLibMpvBridge;
  private currentTimeMs: Milliseconds = 0;
  private durationMs: Milliseconds = 0;
  private tracks: PlayerTrack[] = [];
  private sessionCreated = false;
  private runtimePrepared = false;
  private preparation: Promise<void> | null = null;
  private disposed = false;
  private generation = 0;
  private statusRevision = 0;
  private commandTail: Promise<void> = Promise.resolve();
  private pendingCommands = 0;
  private closing: Promise<void> | null = null;
  private pollingEnabled = false;
  private pollTimer: number | null = null;
  private pollInFlight: Promise<void> | null = null;
  private desiredBounds: NativeVideoBounds | null = null;
  private appliedBounds: NativeVideoBounds | null = null;
  private boundsInFlight: Promise<void> | null = null;
  private desiredDanmaku: NativeDanmakuTrack | null = null;
  private appliedDanmakuRevision: number | null = null;
  private loadSequence = 0;
  private expectedLoadRevision: number | null = null;
  private pendingSeek: Milliseconds | null = null;
  private loadSeekInFlight = false;
  private loadWaiter: {
    sequence: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  } | null = null;
  private readonly statusListeners = new Set<(status: LibMpvMediaStatus) => void>();
  private mediaStatus: LibMpvMediaStatus = {
    loadRevision: 0,
    loadState: "idle",
    running: false,
    playbackStatus: "idle",
    durationMs: 0,
    tracks: [],
    error: null
  };

  constructor(options: TauriLibMpvMediaAdapterOptions) {
    this.sessionId = options.sessionId;
    this.mpvPath = options.mpvPath.trim();
    this.getBounds = options.getBounds;
    this.bridge = options.bridge;
  }

  async prepare(): Promise<void> {
    this.assertActive();
    if (this.runtimePrepared) return;
    if (this.preparation) return this.preparation;
    const generation = this.generation;
    const pending = getTauriLibMpvBridge(this.bridge, "检测 libmpv 运行库")
      .detectRuntime({ mpvPath: this.mpvPath })
      .then((status) => {
        this.assertActive(generation);
        if (!status.available) {
          throw new Error(status.message || "配置的目录没有可用的 libmpv 运行库。");
        }
        this.runtimePrepared = true;
        if (!this.mpvPath && status.libraryPath) this.mpvPath = status.libraryPath;
      });
    this.preparation = pending;
    try {
      await pending;
    } finally {
      if (this.preparation === pending) this.preparation = null;
    }
  }

  load(source: MediaSource, startPositionMs: Milliseconds = this.currentTimeMs): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("播放器会话已关闭。"));
    this.finishLoad(new Error("已被新的媒体加载替代。"));
    const sequence = ++this.loadSequence;
    this.expectedLoadRevision = null;
    this.pendingSeek = null;
    this.loadSeekInFlight = false;
    this.currentTimeMs = Math.max(0, Math.round(startPositionMs));
    this.durationMs = 0;
    this.tracks = [];
    this.publishStatus({
      ...this.mediaStatus,
      loadState: "loading",
      durationMs: 0,
      tracks: [],
      error: null
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.loadWaiter?.sequence !== sequence) return;
        this.failLoad(new Error("媒体加载超时，请检查文件或网络后重新加载。"));
      }, LIBMPV_LOAD_TIMEOUT_MS);
      this.loadWaiter = { sequence, resolve, reject, timer };
    });
    // Only command acknowledgement occupies commandTail. Waiting for FILE_LOADED here
    // would deadlock the existing poll (which waits for pendingCommands === 0).
    const accepted = this.enqueueStatusOperation(async () => {
      if (sequence !== this.loadSequence || !this.loadWaiter)
        throw new Error("媒体加载已取消。");
      await this.prepare();
      this.assertActive();
      if (sequence !== this.loadSequence || !this.loadWaiter)
        throw new Error("媒体加载已取消。");
      if (!isSupportedMpvSource(source)) {
        throw new Error(
          "libmpv 应用内播放需要真实本地文件路径，或本次会话生成的 HTTP(S) 授权播放地址。"
        );
      }
      await this.acquireSession();
      this.assertActive();
      const bridge = getTauriLibMpvBridge(this.bridge, "创建 libmpv 播放会话");
      if (this.sessionCreated) {
        const status = await bridge.controlSession({
          sessionId: this.sessionId,
          action: "load",
          mediaPath: source.url,
          positionMs: Math.max(0, Math.round(startPositionMs)),
          startPaused: true
        });
        this.appliedDanmakuRevision = null;
        if (this.loadWaiter?.sequence === sequence) {
          this.expectedLoadRevision = status.loadRevision;
          await this.flushDanmaku();
        }
        return status;
      }
      const bounds = { ...(this.desiredBounds ?? this.getBounds()) };
      const status = await bridge.createSession({
        sessionId: this.sessionId,
        mpvPath: this.mpvPath,
        mediaPath: source.url,
        startPositionMs: Math.max(0, Math.round(startPositionMs)),
        startPaused: true,
        bounds
      });
      // A late create still owns a native session that dispose must destroy.
      this.sessionCreated = true;
      this.appliedBounds = bounds;
      this.desiredBounds ??= bounds;
      this.flushBounds();
      if (this.loadWaiter?.sequence === sequence) {
        this.expectedLoadRevision = status.loadRevision;
        await this.flushDanmaku();
      }
      return status;
    });
    void accepted.catch((error: unknown) => {
      if (this.loadWaiter?.sequence === sequence)
        this.failLoad(error instanceof Error ? error : new Error("媒体加载失败。"));
    });
    return ready;
  }

  async play(): Promise<void> {
    this.assertActive();
    if (!this.sessionCreated) {
      throw new Error("播放器尚未载入媒体。请先重新载入当前片段。");
    }
    await this.control({ action: "play" });
  }

  pause(): void {
    if (this.disposed || !this.sessionCreated) return;
    void this.control({ action: "pause" }).catch(() => undefined);
  }

  seek(timeMs: Milliseconds): void {
    if (this.disposed) return;
    this.currentTimeMs = Math.max(0, Math.round(timeMs));
    if (this.loadWaiter) {
      this.pendingSeek = this.currentTimeMs;
      return;
    }
    if (!this.sessionCreated) return;
    void this.control({ action: "seek", positionMs: this.currentTimeMs }).catch(
      () => undefined
    );
  }

  getCurrentTimeMs(): Milliseconds {
    return this.currentTimeMs;
  }

  getDurationMs(): Milliseconds {
    return this.durationMs;
  }

  getTracks(): PlayerTrack[] {
    return this.tracks;
  }

  getStatus(): LibMpvMediaStatus {
    return {
      ...this.mediaStatus,
      tracks: this.mediaStatus.tracks.map((track) => ({ ...track }))
    };
  }

  subscribeStatus(listener: (status: LibMpvMediaStatus) => void): () => void {
    if (this.disposed) return () => undefined;
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  setPlaybackRate(rate: number): void {
    if (this.disposed || !this.sessionCreated) return;
    void this.control({ action: "setPlaybackRate", playbackRate: rate }).catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    if (this.disposed || !this.sessionCreated) return;
    void this.control({ action: "setMuted", muted }).catch(() => undefined);
  }

  setHostBounds(bounds: NativeVideoBounds): void {
    if (this.disposed) return;
    this.desiredBounds = { ...bounds };
    this.flushBounds();
  }

  setDanmakuTrack(track: NativeDanmakuTrack): Promise<void> {
    if (!Number.isSafeInteger(track.revision) || track.revision < 0)
      return Promise.reject(new Error("弹幕轨版本必须是非负安全整数。"));
    if (this.disposed) return Promise.reject(new Error("播放器会话已关闭。"));
    if (this.desiredDanmaku && track.revision < this.desiredDanmaku.revision)
      return Promise.resolve();
    if (!this.desiredDanmaku || track.revision > this.desiredDanmaku.revision)
      this.desiredDanmaku = { ...track };
    if (this.appliedDanmakuRevision === track.revision) return Promise.resolve();
    if (!this.sessionCreated) return Promise.resolve();
    const generation = this.generation;
    const pending = this.commandTail.then(async () => {
      this.assertActive(generation);
      await this.flushDanmaku();
    });
    this.commandTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  private async flushDanmaku(): Promise<void> {
    const track = this.desiredDanmaku;
    if (!track || !this.sessionCreated || this.appliedDanmakuRevision === track.revision)
      return;
    const bridge = getTauriLibMpvBridge(this.bridge, "更新原生弹幕预览");
    if (!bridge.setDanmakuTrack) throw new Error("当前播放器不支持原生弹幕轨。");
    const result = await bridge.setDanmakuTrack({ sessionId: this.sessionId, ...track });
    this.appliedDanmakuRevision = result.revision;
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.finishLoad(new Error("播放器会话已关闭。"));
      this.statusListeners.clear();
      this.generation += 1;
      this.statusRevision += 1;
      this.pollingEnabled = false;
      this.clearPollTimer();
      this.desiredBounds = null;
    }
    // A later same-id load retries cleanup if this attempt fails.
    void this.closeSession().catch(() => undefined);
  }

  getSupportedContainerNote(): string {
    return "进程内 libmpv 直接渲染本地 MKV、HEVC 和复杂编码视频，不会弹出独立播放器窗口。";
  }

  private assertActive(generation = this.generation): void {
    if (!this.isActive(generation)) throw new Error("播放器会话已关闭。");
  }

  private isActive(generation = this.generation): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async acquireSession(): Promise<void> {
    for (;;) {
      this.assertActive();
      const owner = libMpvSessionOwners.get(this.sessionId);
      if (!owner || owner === this) {
        libMpvSessionOwners.set(this.sessionId, this);
        return;
      }
      if (!owner.disposed) {
        throw new Error("同名 libmpv 会话正在使用，请先关闭旧播放器。");
      }
      try {
        await owner.closeSession();
      } catch {
        throw new Error("旧播放器尚未完成关闭，请重试；若持续失败，请重启应用。");
      }
    }
  }

  private closeSession(): Promise<void> {
    if (this.closing) return this.closing;
    const pending = (async () => {
      await this.commandTail;
      await Promise.all([this.pollInFlight, this.boundsInFlight]);
      if (this.sessionCreated) {
        await getTauriLibMpvBridge(this.bridge, "销毁 libmpv 播放会话").destroySession({
          sessionId: this.sessionId
        });
        this.sessionCreated = false;
      }
      this.appliedBounds = null;
      if (libMpvSessionOwners.get(this.sessionId) === this) {
        libMpvSessionOwners.delete(this.sessionId);
      }
    })();
    this.closing = pending;
    const clearClosing = (): void => {
      if (this.closing === pending) this.closing = null;
    };
    void pending.then(clearClosing, clearClosing);
    return pending;
  }

  private control(
    request: Omit<Parameters<TauriLibMpvBridge["controlSession"]>[0], "sessionId">
  ): Promise<void> {
    return this.enqueueStatusOperation(() =>
      getTauriLibMpvBridge(this.bridge, "控制 libmpv 播放会话").controlSession({
        sessionId: this.sessionId,
        ...request
      })
    );
  }

  private enqueueStatusOperation(operation: () => Promise<LibMpvSessionStatus>): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("播放器会话已关闭。"));
    const generation = this.generation;
    const revision = ++this.statusRevision;
    this.pendingCommands += 1;
    this.pollingEnabled = true;
    this.clearPollTimer();
    const pending = this.commandTail
      .then(async () => {
        this.assertActive(generation);
        const status = await operation();
        this.assertActive(generation);
        if (revision === this.statusRevision) this.updateFromStatus(status);
      })
      .finally(() => {
        this.pendingCommands -= 1;
        this.schedulePoll();
      });
    // A failed load/control must not poison later commands or cleanup.
    this.commandTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  private schedulePoll(delayMs = 250): void {
    if (
      !this.isActive() ||
      !this.sessionCreated ||
      !this.pollingEnabled ||
      this.pendingCommands > 0 ||
      this.pollTimer !== null ||
      this.pollInFlight
    )
      return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, delayMs);
  }

  private poll(): void {
    if (
      !this.isActive() ||
      !this.sessionCreated ||
      !this.pollingEnabled ||
      this.pendingCommands > 0 ||
      this.pollInFlight
    )
      return;
    const generation = this.generation;
    const revision = this.statusRevision;
    let delayMs = 250;
    const pending = (async () => {
      try {
        const status = await getTauriLibMpvBridge(
          this.bridge,
          "读取 libmpv 播放状态"
        ).getSessionStatus({ sessionId: this.sessionId });
        if (this.isActive(generation) && revision === this.statusRevision) {
          this.updateFromStatus(status);
        }
      } catch {
        delayMs = 1_000;
      }
    })();
    this.pollInFlight = pending;
    void pending.then(() => {
      if (this.pollInFlight === pending) this.pollInFlight = null;
      if (this.isActive(generation)) this.schedulePoll(delayMs);
    });
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private flushBounds(): void {
    if (
      !this.isActive() ||
      !this.sessionCreated ||
      this.boundsInFlight ||
      !this.desiredBounds ||
      sameNativeVideoBounds(this.desiredBounds, this.appliedBounds)
    )
      return;
    const bounds = { ...this.desiredBounds };
    const generation = this.generation;
    let failed = false;
    const pending = (async () => {
      try {
        await getTauriLibMpvBridge(this.bridge, "调整 libmpv 视频区域").setSessionBounds({
          sessionId: this.sessionId,
          bounds
        });
        if (this.isActive(generation)) this.appliedBounds = bounds;
      } catch {
        failed = true;
        if (this.isActive(generation)) this.appliedBounds = null;
      }
    })();
    this.boundsInFlight = pending;
    void pending.then(() => {
      if (this.boundsInFlight === pending) this.boundsInFlight = null;
      if (!this.isActive(generation)) return;
      // Retry a newer target immediately; retry an unchanged failed target
      // only when the caller submits it again, avoiding an error spin loop.
      if (!failed || !sameNativeVideoBounds(this.desiredBounds, bounds)) this.flushBounds();
    });
  }

  private updateFromStatus(status: LibMpvSessionStatus): void {
    if (this.expectedLoadRevision === null || status.loadRevision !== this.expectedLoadRevision)
      return;
    if (status.loadState === "ready" && this.pendingSeek === null) {
      this.currentTimeMs = Math.max(0, Math.round(status.positionMs));
    }
    this.durationMs =
      status.loadState === "ready" ? Math.max(0, Math.round(status.durationMs)) : 0;
    this.tracks = status.loadState === "ready" ? status.tracks : [];
    this.publishStatus({
      loadRevision: status.loadRevision,
      loadState: status.loadState,
      running: status.running,
      playbackStatus: status.playbackStatus,
      durationMs: this.durationMs,
      tracks: this.tracks,
      error: status.error
    });
    if (this.loadWaiter && (status.loadState === "failed" || !status.running)) {
      this.failLoad(new Error(status.error || "媒体加载失败，播放器已经停止。"));
    } else if (this.loadWaiter && status.loadState === "ready") {
      this.completeReadyLoad();
    }
    if (!status.running) {
      this.pollingEnabled = false;
      this.clearPollTimer();
    }
  }

  private completeReadyLoad(): void {
    if (!this.loadWaiter || this.loadSeekInFlight) return;
    const position = this.pendingSeek;
    this.pendingSeek = null;
    if (position === null) {
      this.finishLoad();
      return;
    }
    const sequence = this.loadSequence;
    this.loadSeekInFlight = true;
    void this.control({ action: "seek", positionMs: position }).then(
      () => {
        if (this.loadWaiter?.sequence !== sequence) return;
        this.loadSeekInFlight = false;
        this.completeReadyLoad();
      },
      (error: unknown) => {
        if (this.loadWaiter?.sequence === sequence)
          this.failLoad(error instanceof Error ? error : new Error("初始定位失败。"));
      }
    );
  }

  private finishLoad(error?: Error): void {
    const waiter = this.loadWaiter;
    this.loadWaiter = null;
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  private failLoad(error: Error): void {
    this.expectedLoadRevision = null;
    this.pendingSeek = null;
    this.pollingEnabled = false;
    this.clearPollTimer();
    this.publishStatus({ ...this.mediaStatus, loadState: "failed", error: error.message });
    this.finishLoad(error);
  }

  private publishStatus(status: LibMpvMediaStatus): void {
    const previous = this.mediaStatus;
    const tracksEqual =
      previous.tracks.length === status.tracks.length &&
      previous.tracks.every((track, index) => {
        const next = status.tracks[index];
        return (
          track.id === next.id &&
          track.trackType === next.trackType &&
          track.title === next.title &&
          track.language === next.language &&
          track.codec === next.codec &&
          track.selected === next.selected &&
          track.external === next.external
        );
      });
    if (
      previous.loadRevision === status.loadRevision &&
      previous.loadState === status.loadState &&
      previous.running === status.running &&
      previous.playbackStatus === status.playbackStatus &&
      previous.durationMs === status.durationMs &&
      previous.error === status.error &&
      tracksEqual
    )
      return;
    this.mediaStatus = { ...status, tracks: status.tracks.map((track) => ({ ...track })) };
    for (const listener of this.statusListeners) {
      try {
        listener(this.getStatus());
      } catch {
        /* A UI observer cannot stop native polling. */
      }
    }
  }
}

/** @deprecated 仅保留给迁移期兼容和回归测试；新界面必须使用 TauriLibMpvMediaAdapter。 */
export class TauriMpvMediaAdapter implements NativeMpvMediaAdapter {
  readonly kind = "native-mpv";

  private readonly mpvPath: string;
  private readonly bridge?: TauriMpvBridge;
  private currentTimeMs: Milliseconds = 0;
  private durationMs: Milliseconds = 0;
  private tracks: PlayerTrack[] = [];
  private pollTimer: number | null = null;

  constructor(mpvPath: string, bridge?: TauriMpvBridge) {
    this.mpvPath = mpvPath.trim();
    this.bridge = bridge;
  }

  async load(
    source: MediaSource,
    startPositionMs: Milliseconds = this.currentTimeMs
  ): Promise<void> {
    if (this.mpvPath.length === 0) {
      throw new Error(
        "尚未配置 mpv 路径。请在“设置中心 / 播放器与工具”里选择 mpv 可执行文件。"
      );
    }
    if (!isSupportedMpvSource(source)) {
      throw new Error("mpv 播放需要真实本地文件路径，或本次会话生成的 Emby 授权播放地址。");
    }
    const status = await startTauriMpvSidecar(
      {
        mpvPath: this.mpvPath,
        mediaPath: source.url,
        startPositionMs: Math.max(0, Math.round(startPositionMs)),
        startPaused: true
      },
      this.bridge
    );
    this.updateFromStatus(status);
    this.startPolling();
  }

  async play(): Promise<void> {
    const status = await controlTauriMpvSidecar({ action: "play" }, this.bridge);
    this.updateFromStatus(status);
    this.startPolling();
  }

  pause(): void {
    void controlTauriMpvSidecar({ action: "pause" }, this.bridge)
      .then((status) => this.updateFromStatus(status))
      .catch(() => undefined);
  }

  seek(timeMs: Milliseconds): void {
    this.currentTimeMs = Math.max(0, Math.round(timeMs));
    void controlTauriMpvSidecar(
      {
        action: "seek",
        positionMs: this.currentTimeMs
      },
      this.bridge
    )
      .then((status) => this.updateFromStatus(status))
      .catch(() => undefined);
  }

  getCurrentTimeMs(): Milliseconds {
    return this.currentTimeMs;
  }

  getDurationMs(): Milliseconds {
    return this.durationMs;
  }

  getTracks(): PlayerTrack[] {
    return this.tracks;
  }

  setPlaybackRate(rate: number): void {
    void controlTauriMpvSidecar(
      {
        action: "setPlaybackRate",
        playbackRate: rate
      },
      this.bridge
    )
      .then((status) => this.updateFromStatus(status))
      .catch(() => undefined);
  }

  dispose(): void {
    this.stopPolling();
    void stopTauriMpvSidecar(this.bridge).catch(() => undefined);
  }

  getSupportedContainerNote(): string {
    return "mpv 后端用于本地 MKV、高码率、复杂编码视频和本次会话生成的 Emby 授权流；需要桌面端。";
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = window.setInterval(() => {
      void getTauriMpvSidecarStatus(this.bridge)
        .then((status) => this.updateFromStatus(status))
        .catch(() => this.stopPolling());
    }, 250);
  }

  private stopPolling(): void {
    if (!this.pollTimer) {
      return;
    }
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private updateFromStatus(status: MpvSidecarStatus): void {
    this.currentTimeMs = Math.max(0, Math.round(status.positionMs));
    this.durationMs = Math.max(0, Math.round(status.durationMs));
    this.tracks = status.tracks;
    if (!status.running) {
      this.stopPolling();
    }
  }
}

function isSupportedMpvSource(source: MediaSource): boolean {
  if (source.url.startsWith("blob:")) {
    return false;
  }
  if (source.kind === "file") {
    return source.url.trim().length > 0;
  }
  return source.kind === "url" && isHttpMediaUrl(source.url);
}

function isHttpMediaUrl(url: string): boolean {
  const normalized = url.trim().toLocaleLowerCase();
  return normalized.startsWith("http://") || normalized.startsWith("https://");
}
