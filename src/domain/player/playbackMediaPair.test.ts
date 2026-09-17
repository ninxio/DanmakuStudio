import { describe, expect, it } from "vitest";
import type { ProjectMediaReference } from "../project/types";
import { resolvePlaybackMediaPair } from "./playbackMediaPair";

describe("resolvePlaybackMediaPair", () => {
  it("缺失任一媒体时拒绝启动复核", () => {
    const result = resolvePlaybackMediaPair(
      undefined,
      createMedia("target", ".mkv"),
      "auto",
      "mpv"
    );

    expect(result.available).toBe(false);
    expect(result.message).toContain("参考素材或原片已不存在");
  });

  it("自动模式为复杂格式选择本地 mpv", () => {
    const source = createMedia("source", ".mp4", { objectUrl: "blob:source" });
    const target = createMedia("target", ".mkv", { objectUrl: "blob:target" });

    const result = resolvePlaybackMediaPair(source, target, "auto", "C:\\tools\\mpv.exe");

    expect(result.backend).toBe("nativeMpv");
    expect(result.source?.kind).toBe("file");
    expect(result.target?.url).toBe("C:\\media\\target.mkv");
  });

  it("自动模式为浏览器兼容格式保留内嵌 HTML Video", () => {
    const source = createMedia("source", ".mp4", { objectUrl: "blob:source" });
    const target = createMedia("target", ".webm", { objectUrl: "blob:target" });

    const result = resolvePlaybackMediaPair(source, target, "auto", "C:\\tools\\mpv.exe");

    expect(result.backend).toBe("htmlVideo");
    expect(result.source).toEqual({ kind: "url", name: "source", url: "blob:source" });
  });

  it("浏览器会话可直接试听两侧纯音频并标记无画面", () => {
    const source = createMedia("source", ".flac", { objectUrl: "blob:source" });
    const target = createMedia("target", ".m4a", { objectUrl: "blob:target" });

    const result = resolvePlaybackMediaPair(source, target, "auto", "");

    expect(result.available).toBe(true);
    expect(result.backend).toBe("htmlVideo");
    expect(result.sourceContentKind).toBe("audio");
    expect(result.targetContentKind).toBe("audio");
  });

  it("用户强制 mpv 时优先使用真实本地路径", () => {
    const source = createMedia("source", ".mp4", { objectUrl: "blob:source" });
    const target = createMedia("target", ".mp4", { objectUrl: "blob:target" });

    const result = resolvePlaybackMediaPair(source, target, "nativeMpv", "mpv");

    expect(result.backend).toBe("nativeMpv");
  });

  it("历史设置强制 HTML 时也不会把 MKV 送进 WebView 黑屏", () => {
    const source = createMedia("source", ".mp4", { objectUrl: "blob:source" });
    const target = createMedia("target", ".mkv", { objectUrl: "blob:target" });

    const result = resolvePlaybackMediaPair(source, target, "htmlVideo", "C:\\tools\\mpv.exe");

    expect(result.backend).toBe("nativeMpv");
    expect(result.message).toContain("已自动改用应用内 libmpv");
  });

  it("本地路径在未配置 mpv 时交给原生运行库自动发现", () => {
    const result = resolvePlaybackMediaPair(
      createMedia("source", ".mkv"),
      createMedia("target", ".mkv"),
      "auto",
      ""
    );

    expect(result.available).toBe(true);
    expect(result.backend).toBe("nativeMpv");
  });
});

function createMedia(
  name: string,
  extension: string,
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id: `${name}-id`,
    role: name === "source" ? "bilibiliReference" : "targetOriginal",
    referenceKind: "localPath",
    name,
    fileName: `${name}${extension}`,
    objectUrl: null,
    localPath: `C:\\media\\${name}${extension}`,
    durationMs: 60_000,
    contentIdentity: null,
    connectionState: "connected",
    sourceSummary: "本地测试视频",
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" }
  };
}
