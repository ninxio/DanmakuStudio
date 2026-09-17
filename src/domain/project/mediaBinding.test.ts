import { describe, expect, it } from "vitest";
import {
  createEmbyItemMediaBinding,
  createLocalFileMediaBinding,
  createLocalPathMediaBinding,
  formatMediaBindingEpisode,
  formatMediaBindingSource,
  formatMediaBindingTitle,
  formatMediaSourceSummary
} from "./mediaBinding";
import type { MediaReference } from "./types";

describe("目标原片绑定", () => {
  it("可从本地视频引用创建目标原片绑定", () => {
    const media: MediaReference = {
      id: "media-1",
      name: "完整版",
      fileName: "full.mp4",
      objectUrl: "blob:full",
      durationMs: 3_000_000
    };

    const binding = createLocalFileMediaBinding("binding-1", media, "2026-07-10T00:00:00.000Z");

    expect(binding).toMatchObject({
      kind: "localFile",
      displayName: "完整版",
      fileName: "full.mp4",
      runtimeMs: 3_000_000,
      localPath: null
    });
    expect(formatMediaBindingTitle(binding)).toBe("完整版");
    expect(formatMediaBindingSource(binding)).toBe("本地文件 / full.mp4");
  });

  it("可从本地路径创建 mpv 可用的目标原片绑定", () => {
    const binding = createLocalPathMediaBinding(
      "binding-path",
      " D:\\media\\测试剧集 S01E02.mkv ",
      3_100_000,
      "2026-07-10T00:00:00.000Z"
    );

    expect(binding).toMatchObject({
      kind: "localFile",
      displayName: "测试剧集 S01E02",
      fileName: "测试剧集 S01E02.mkv",
      mediaId: null,
      localPath: "D:\\media\\测试剧集 S01E02.mkv",
      runtimeMs: 3_100_000
    });
    expect(formatMediaBindingSource(binding)).toBe("本地文件 / 测试剧集 S01E02.mkv");
  });

  it("可从 Emby 条目创建不含 token 的目标原片绑定", () => {
    const binding = createEmbyItemMediaBinding(
      "binding-emby",
      {
        id: "item-1",
        name: "第二集",
        type: "Episode",
        seriesName: "测试剧集",
        seasonNumber: 1,
        episodeNumber: 2,
        durationMs: 3_000_000,
        mediaSources: [
          {
            id: "source-1",
            name: "主媒体源",
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
      },
      {
        serverUrl: " https://emby.example.test ",
        pathPrefix: " /emby ",
        username: " tester "
      },
      "2026-07-10T00:00:00.000Z"
    );

    expect(binding.displayName).toBe("测试剧集 / S01E02 / 第二集");
    expect(formatMediaBindingEpisode(binding)).toBe("测试剧集 / 第 1 季 / 第 2 集");
    expect(formatMediaBindingSource(binding)).toBe("Emby / https://emby.example.test/emby");
    expect(formatMediaSourceSummary(binding.mediaSources[0])).toBe("主媒体源 / mkv / h264 / aac / 1920x1080");
    expect(JSON.stringify(binding)).not.toContain("token");
  });
});
