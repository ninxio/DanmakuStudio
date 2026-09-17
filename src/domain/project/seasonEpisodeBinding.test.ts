import { describe, expect, it } from "vitest";
import type { BatchMergeEpisode } from "../danmaku/batchMerge";
import { createSeasonEpisodeKey, findSeasonEpisodeBinding } from "./seasonEpisodeBinding";
import type { SeasonEpisodeBinding } from "./types";

describe("剧集分集目标绑定", () => {
  it("优先使用季集号生成稳定 key", () => {
    expect(createSeasonEpisodeKey(createEpisode({ seasonNumber: 1, episodeNumber: 2, fileName: "demo.xml" }))).toBe(
      "S01E02"
    );
  });

  it("没有季号时使用集号和文件名兜底", () => {
    expect(createSeasonEpisodeKey(createEpisode({ seasonNumber: null, episodeNumber: 3, fileName: "Part 03.XML" }))).toBe(
      "E03:part 03.xml"
    );
  });

  it("按 episodeKey 查找已保存绑定", () => {
    const binding: SeasonEpisodeBinding = {
      id: "season-binding-1",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      targetBinding: {
        id: "media-binding-1",
        kind: "localFile",
        displayName: "完整版",
        fileName: "full.mkv",
        mediaId: null,
        localPath: "D:\\media\\full.mkv",
        runtimeMs: 3_000_000,
        linkedAt: "2026-07-10T00:00:00.000Z"
      },
      linkedAt: "2026-07-10T00:00:00.000Z"
    };

    expect(findSeasonEpisodeBinding([binding], "S01E01")).toBe(binding);
    expect(findSeasonEpisodeBinding([binding], "S01E02")).toBeNull();
  });
});

function createEpisode(patch: Pick<BatchMergeEpisode, "seasonNumber" | "episodeNumber" | "fileName">): BatchMergeEpisode {
  return {
    id: "episode",
    label: "第 1 集",
    sourceFileNames: ["01.xml"],
    itemCount: 0,
    entries: [],
    warnings: [],
    ...patch
  };
}
