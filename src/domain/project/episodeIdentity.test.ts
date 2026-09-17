import { describe, expect, it } from "vitest";
import type { ProjectMediaReference } from "./types";
import {
  formatEpisodeIdentity,
  parseEpisodeIdentity,
  parseOrderedEpisodeIdentity,
  parseProjectMediaEpisodeIdentity
} from "./episodeIdentity";

describe("episode identity", () => {
  it("合集总集数不能冒充分集编号", () => {
    expect(parseEpisodeIdentity("作品 全八集")).toBeNull();
    expect(parseEpisodeIdentity("作品 共8集 第3集")).toMatchObject({ episodeStart: 3, episodeEnd: 3 });
  });
  it("规范化全角字符、Unicode 范围分隔符和 Part", () => {
    expect(parseEpisodeIdentity("【来源】Ｓ０２Ｅ０５～Ｅ０６ Part２")).toMatchObject({
      seasonNumber: 2,
      episodeStart: 5,
      episodeEnd: 6,
      partNumber: 2,
      pattern: "seasonEpisodeRange",
      evidenceStrength: "strong"
    });
    expect(parseEpisodeIdentity("第十二季第十一至十二集")).toMatchObject({
      seasonNumber: 12,
      episodeStart: 11,
      episodeEnd: 12,
      partNumber: null
    });
  });

  it("识别 XML 的导入前缀与分 P，并把无法识别的顺序兜底显式标弱", () => {
    expect(parseOrderedEpisodeIdentity("０３ - 1.２.xml", 0)).toMatchObject({
      seasonNumber: null,
      episodeStart: 1,
      episodeEnd: 1,
      partNumber: 2,
      sortNumber: 3,
      fallback: false,
      pattern: "episodePart",
      evidenceStrength: "strong"
    });
    expect(parseOrderedEpisodeIdentity("完全无法识别.xml", 4)).toMatchObject({
      episodeStart: 5,
      episodeEnd: 5,
      sortNumber: 5,
      fallback: true,
      evidenceStrength: "fallback"
    });
    expect(parseOrderedEpisodeIdentity("S01E03-E01.xml", 0)).toMatchObject({
      seasonNumber: 1,
      episodeStart: 1,
      episodeEnd: 3,
      fallback: false
    });
    expect(parseOrderedEpisodeIdentity("1.2.xml", 4)).toMatchObject({
      seasonNumber: null,
      episodeStart: 1,
      episodeEnd: 1,
      partNumber: 2,
      sortNumber: 5,
      fallback: false,
      pattern: "episodePart"
    });
  });

  it("优先采用项目元数据，并提供稳定的人话标签", () => {
    const parsed = parseProjectMediaEpisodeIdentity(
      media("media", "unhelpful.mkv", {
        emby: {
          itemId: "episode-8",
          itemName: "Episode 8",
          itemType: "Episode",
          seriesName: "Series",
          seasonNumber: 3,
          episodeNumber: 8,
          server: {
            serverUrl: "https://emby.example.test",
            pathPrefix: "/emby",
            username: "tester"
          },
          mediaSources: []
        }
      })
    );

    expect(parsed).toMatchObject({
      seasonNumber: 3,
      episodeStart: 8,
      episodeEnd: 8,
      source: "projectMetadata"
    });
    expect(parsed && formatEpisodeIdentity(parsed)).toBe("第 3 季第 8 集");
    expect(
      parseProjectMediaEpisodeIdentity(
        media("file-name", "Reference.S01E01.mp4", { name: "无季集展示名" })
      )
    ).toMatchObject({
      seasonNumber: 1,
      episodeStart: 1,
      episodeEnd: 1,
      partNumber: null
    });
  });
});

function media(
  id: string,
  fileName: string,
  patch: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role: "bilibiliReference",
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    objectUrl: null,
    durationMs: null,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: fileName,
    localPath: `F:\\TEST\\${fileName}`,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...patch,
    audioTrackIntent: patch.audioTrackIntent ?? { mode: "auto" }
  };
}
