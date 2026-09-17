import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  probeTauriMediaIdentity,
  probeTauriMediaTimeline,
  type MediaIdentityProbeInvoker,
  type MediaTimelineAudioStream,
  type MediaTimelineProbeInvoker,
  type MediaTimelineProbeResult,
  type MediaTimelineVideoStream,
  type TauriMediaTimelineProbeRequest
} from "./tauriMediaProbe";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

const probeResult = {
  presentationOriginMs: -80,
  durationMs: 2_700_123,
  contentIdentity: null,
  videoStreams: [
    {
      index: 0,
      codec: "h264",
      startMs: 0,
      timelineOffsetMs: 80,
      durationMs: 2_700_000,
      timeBase: "1/90000",
      frameRate: 24_000 / 1_001,
      language: "jpn",
      title: "Main video",
      default: true,
      commentary: false
    }
  ],
  audioStreams: [
    {
      index: 2,
      codec: "aac",
      startMs: -80,
      timelineOffsetMs: 0,
      durationMs: 2_700_123,
      timeBase: "1/48000",
      sampleRate: 48_000,
      channels: 2,
      language: "jpn",
      title: "Original stereo",
      default: true,
      commentary: false
    },
    {
      index: 3,
      codec: "aac",
      startMs: -80,
      timelineOffsetMs: 0,
      durationMs: null,
      timeBase: "1/48000",
      sampleRate: 48_000,
      channels: 2,
      language: "eng",
      title: "Commentary",
      default: false,
      commentary: true
    }
  ],
  preferredAudioStreamIndex: 2
} satisfies MediaTimelineProbeResult;

describe("Tauri 媒体时间轴探测", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("以 camelCase 请求调用 probe_media_timeline 并透传响应", async () => {
    const request: TauriMediaTimelineProbeRequest = {
      path: "D:\\media\\episode-01.mkv",
      ffprobePath: "C:\\tools\\ffprobe.exe",
      ffmpegPath: null
    };
    tauriMocks.invoke.mockResolvedValue(probeResult);

    const result = await probeTauriMediaTimeline(request);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("probe_media_timeline", {
      request: {
        path: "D:\\media\\episode-01.mkv",
        ffprobePath: "C:\\tools\\ffprobe.exe",
        ffmpegPath: null
      }
    });
    expect(result).toBe(probeResult);
  });

  it("身份预检调用不依赖 FFprobe 的独立命令", async () => {
    const identity = {
      algorithm: "sha256-full-file-v2",
      sizeBytes: 100,
      modifiedUnixMs: 1_700_000_000_000,
      firstSampleDigest: "a".repeat(64),
      middleSampleDigest: "a".repeat(64),
      lastSampleDigest: "a".repeat(64)
    };
    tauriMocks.invoke.mockResolvedValue(identity);

    await expect(probeTauriMediaIdentity({ path: "D:\\media\\episode-01.mkv" })).resolves.toBe(
      identity
    );
    expect(tauriMocks.invoke).toHaveBeenCalledWith("probe_media_identity", {
      request: { path: "D:\\media\\episode-01.mkv" }
    });
  });

  it("身份探测允许注入严格的 identity-only invoker", async () => {
    const identity = {
      algorithm: "sha256-full-file-v2",
      sizeBytes: 0,
      modifiedUnixMs: 0,
      firstSampleDigest: "0".repeat(64),
      middleSampleDigest: "0".repeat(64),
      lastSampleDigest: "0".repeat(64)
    };
    const invoker: MediaIdentityProbeInvoker = () => Promise.resolve(identity);

    await expect(probeTauriMediaIdentity({ path: "empty.mkv" }, invoker)).resolves.toEqual(identity);
  });

  it("暴露严格的视频、音频和可空探测字段类型", async () => {
    const invoker: MediaTimelineProbeInvoker = () => Promise.resolve(probeResult);
    const result = await probeTauriMediaTimeline({ path: "episode.mkv" }, invoker);

    expectTypeOf(result).toEqualTypeOf<MediaTimelineProbeResult>();
    expectTypeOf(result.videoStreams[0]).toEqualTypeOf<MediaTimelineVideoStream>();
    expectTypeOf(result.audioStreams[0]).toEqualTypeOf<MediaTimelineAudioStream>();
    expectTypeOf(result.durationMs).toEqualTypeOf<number | null>();
    expectTypeOf(result.videoStreams[0].startMs).toEqualTypeOf<number>();
    expectTypeOf(result.videoStreams[0].timelineOffsetMs).toEqualTypeOf<number>();
    expectTypeOf(result.videoStreams[0].frameRate).toEqualTypeOf<number | null>();
    expectTypeOf(result.audioStreams[0].sampleRate).toEqualTypeOf<number | null>();
    expectTypeOf(result.audioStreams[0].channels).toEqualTypeOf<number | null>();
    expectTypeOf(result.preferredAudioStreamIndex).toEqualTypeOf<number | null>();
    expect(result.audioStreams[1]).toMatchObject({
      durationMs: null,
      commentary: true
    });
  });

  it("在非 Tauri 环境拒绝默认桌面探测", async () => {
    tauriMocks.isTauri.mockReturnValue(false);

    await expect(probeTauriMediaTimeline({ path: "episode.mkv" })).rejects.toThrow(
      "媒体时间轴探测需要在 Tauri 桌面端运行。"
    );
    expect(tauriMocks.invoke).not.toHaveBeenCalled();

    await expect(probeTauriMediaIdentity({ path: "episode.mkv" })).rejects.toThrow(
      "媒体身份探测需要在 Tauri 桌面端运行。"
    );
  });

  it("为 Rust 或 invoker 失败补充清楚的探测上下文", async () => {
    tauriMocks.invoke.mockRejectedValue("ffprobe 返回了无效 JSON");

    await expect(probeTauriMediaTimeline({ path: "broken.mkv" })).rejects.toThrow(
      "媒体时间轴探测失败：ffprobe 返回了无效 JSON"
    );
  });
});
