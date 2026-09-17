import { describe, expect, it } from "vitest";
import {
  classifyMediaContent,
  formatMediaContentKind,
  isAudioOnlyMedia,
  isSupportedMediaPath
} from "./mediaFormat";

describe("mediaFormat", () => {
  it("同时接受常见视频和音频格式", () => {
    expect(isSupportedMediaPath("D:\\media\\episode.mkv")).toBe(true);
    expect(isSupportedMediaPath("D:\\media\\episode.FLAC")).toBe(true);
    expect(isSupportedMediaPath("D:\\media\\episode.m4a")).toBe(true);
    expect(isSupportedMediaPath("D:\\media\\notes.txt")).toBe(false);
  });

  it("能区分纯音频、视频和未知文件", () => {
    expect(classifyMediaContent("episode.opus")).toBe("audio");
    expect(classifyMediaContent("episode.mp4")).toBe("video");
    expect(classifyMediaContent("episode.bin")).toBe("unknown");
    expect(isAudioOnlyMedia("episode.wav")).toBe(true);
    expect(formatMediaContentKind("episode.wav")).toBe("纯音频");
  });
});
