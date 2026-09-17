import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type { EditorProject } from "../project/types";
import { createPlayerSessionSummary } from "./playerSession";

describe("播放器会话摘要", () => {
  it("为空项目生成普通用户下一步", () => {
    const summary = createPlayerSessionSummary({
      project: createEmptyProject(),
      isPlaying: false,
      backend: "htmlVideo",
      loadState: "empty",
      hasPreviewSource: false,
      videoError: null,
      mpvConfigured: false
    });

    expect(summary.sourceLabel).toBe("尚未连接");
    expect(summary.playbackLabel).toBe("等待媒体");
    expect(summary.nextActionLabel).toBe("导入参考视频或绑定目标原片。");
  });

  it("说明 Emby 目标原片可用于对齐但预览仍需播放器接入", () => {
    const project: EditorProject = {
      ...createEmptyProject(),
      mediaBinding: {
        id: "binding-emby",
        kind: "embyItem",
        displayName: "Demo / S01E01",
        itemId: "episode-1",
        itemName: "Episode 1",
        itemType: "Episode",
        seriesName: "Demo",
        seasonNumber: 1,
        episodeNumber: 1,
        runtimeMs: 3_000_000,
        linkedAt: "2026-07-10T00:00:00.000Z",
        server: { serverUrl: "https://emby.example.test", pathPrefix: "/emby", username: "tester" },
        mediaSources: [
          {
            id: "source-1",
            name: "1080p",
            container: "mkv",
            videoCodec: "h264",
            audioCodec: "aac",
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            sizeBytes: 1_000_000_000,
            runtimeMs: 3_000_000
          }
        ]
      }
    };

    const summary = createPlayerSessionSummary({
      project,
      isPlaying: false,
      backend: "htmlVideo",
      loadState: "empty",
      hasPreviewSource: false,
      videoError: null,
      mpvConfigured: false
    });

    expect(summary.sourceLabel).toBe("Emby 目标原片");
    expect(summary.audioTrackLabel).toBe("Emby 元数据：aac");
    expect(summary.nextActionLabel).toContain("音频对齐可使用 Emby 授权输入");
  });

  it("本地视频就绪时提示可播放和标记版本差异", () => {
    const project: EditorProject = {
      ...createEmptyProject(),
      media: {
        id: "media-local",
        name: "demo",
        fileName: "demo.mp4",
        objectUrl: "blob:demo",
        durationMs: 12_345
      }
    };

    const summary = createPlayerSessionSummary({
      project,
      isPlaying: true,
      backend: "htmlVideo",
      loadState: "ready",
      hasPreviewSource: true,
      videoError: null,
      mpvConfigured: false
    });

    expect(summary.sourceLabel).toBe("参考视频");
    expect(summary.playbackLabel).toBe("播放中");
    expect(summary.nextActionLabel).toBe("播放预览、标记版本差异或运行对齐。");
  });

  it("优先显示播放器探测到的真实音轨和字幕轨", () => {
    const summary = createPlayerSessionSummary({
      project: createEmptyProject(),
      isPlaying: false,
      backend: "nativeMpv",
      loadState: "ready",
      hasPreviewSource: true,
      videoError: null,
      mpvConfigured: true,
      tracks: [
        {
          id: 1,
          trackType: "audio",
          title: "日语 2.0",
          language: "jpn",
          codec: "aac",
          selected: true,
          external: false
        },
        {
          id: 2,
          trackType: "subtitle",
          title: "简体中文",
          language: "chi",
          codec: "ass",
          selected: true,
          external: true
        }
      ]
    });

    expect(summary.audioTrackLabel).toBe("当前音轨：日语 2.0 / jpn / aac");
    expect(summary.subtitleTrackLabel).toBe("当前字幕：简体中文 / chi / ass");
  });
});
