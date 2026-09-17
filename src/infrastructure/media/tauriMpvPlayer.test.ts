import { describe, expect, it, vi } from "vitest";
import {
  controlTauriMpvSidecar,
  detectMediaTool,
  getTauriMpvSidecarStatus,
  startTauriMpvSidecar,
  stopTauriMpvSidecar,
  type TauriMpvBridge
} from "./tauriMpvPlayer";

describe("Tauri mpv 播放器桥", () => {
  it("把工具检测请求交给注入的 bridge", async () => {
    const bridge: TauriMpvBridge = createBridge();

    await expect(
      detectMediaTool(
        {
          tool: "mpv",
          executablePath: "C:\\tools\\mpv.exe"
        },
        bridge
      )
    ).resolves.toMatchObject({
      tool: "mpv",
      available: true,
      version: "mpv 0.38.0"
    });
    expect(bridge.detectTool).toHaveBeenCalledWith({
      tool: "mpv",
      executablePath: "C:\\tools\\mpv.exe"
    });
  });

  it("支持启动、控制、查询和停止 sidecar", async () => {
    const bridge: TauriMpvBridge = createBridge();

    await expect(
      startTauriMpvSidecar(
        {
          mpvPath: "C:\\tools\\mpv.exe",
          mediaPath: "D:\\media\\full.mkv",
          startPositionMs: 1200,
          startPaused: true
        },
        bridge
      )
    ).resolves.toMatchObject({
      running: true,
      playbackStatus: "paused",
      mediaPath: "D:\\media\\full.mkv"
    });
    await expect(controlTauriMpvSidecar({ action: "play" }, bridge)).resolves.toMatchObject({
      playbackStatus: "playing"
    });
    await expect(getTauriMpvSidecarStatus(bridge)).resolves.toMatchObject({
      running: true,
      positionMs: 1200
    });
    await expect(stopTauriMpvSidecar(bridge)).resolves.toMatchObject({
      running: false,
      playbackStatus: "stopped"
    });
  });
});

function createBridge(): TauriMpvBridge {
  return {
    detectTool: vi.fn<TauriMpvBridge["detectTool"]>((request) =>
      Promise.resolve({
        tool: request.tool,
        executablePath: request.executablePath ?? "mpv",
        available: true,
        version: request.tool === "mpv" ? "mpv 0.38.0" : "ffmpeg version 7.1",
        message: "检测通过。"
      })
    ),
    start: vi.fn<TauriMpvBridge["start"]>((request) =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: request.startPaused ? "paused" : "playing",
        mediaPath: request.mediaPath,
        positionMs: request.startPositionMs ?? 0,
        durationMs: 0,
        tracks: [],
        message: "mpv 已启动。",
        error: null,
        updatedAtMs: 1
      })
    ),
    stop: vi.fn<TauriMpvBridge["stop"]>(() =>
      Promise.resolve({
        running: false,
        backend: "native-mpv",
        playbackStatus: "stopped",
        mediaPath: null,
        positionMs: 0,
        durationMs: 0,
        tracks: [],
        message: "mpv 已停止。",
        error: null,
        updatedAtMs: 2
      })
    ),
    status: vi.fn<TauriMpvBridge["status"]>(() =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: "paused",
        mediaPath: "D:\\media\\full.mkv",
        positionMs: 1200,
        durationMs: 0,
        tracks: [],
        message: "mpv 已启动。",
        error: null,
        updatedAtMs: 3
      })
    ),
    control: vi.fn<TauriMpvBridge["control"]>((request) =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: request.action === "play" ? "playing" : "paused",
        mediaPath: "D:\\media\\full.mkv",
        positionMs: request.positionMs ?? 1200,
        durationMs: 0,
        tracks: [],
        message: "mpv 控制命令已发送。",
        error: null,
        updatedAtMs: 4
      })
    )
  };
}
