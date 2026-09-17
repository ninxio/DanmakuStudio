import { describe, expect, it } from "vitest";
import type { ProjectMediaReference } from "../project/types";
import { createSmartBatchPairingPlan, parseMediaEpisodeHint } from "./smartBatchPairing";

describe("smart batch pairing", () => {
  it("把第三季两个分段参考准确路由到八个原片", () => {
    const sources = [
      media("source-1", "5-第三季1-4-720P 准高清-HEVC.mp4", "bilibiliReference"),
      media("source-2", "6-第三季5-8-720P 准高清-HEVC.mp4", "bilibiliReference")
    ];
    const targets = Array.from({ length: 8 }, (_, index) =>
      media(
        `target-${index + 1}`,
        `Dark.S03E${String(index + 1).padStart(2, "0")}.mkv`,
        "targetOriginal"
      )
    );

    const plan = createSmartBatchPairingPlan(sources, targets);

    expect(plan.mode).toBe("metadataGuided");
    expect(plan.pairs).toHaveLength(8);
    expect(plan.excludedPairCount).toBe(8);
    expect(plan.pairs.slice(0, 4).every((pair) => pair.sourceMediaId === "source-1")).toBe(true);
    expect(plan.pairs.slice(4).every((pair) => pair.sourceMediaId === "source-2")).toBe(true);
  });

  it("把三段参考和十二集缩减为十二个建议组合", () => {
    const sources = [
      media("a", "S03E01-E04.mp4", "bilibiliReference"),
      media("b", "S03E05-E08.mp4", "bilibiliReference"),
      media("c", "S03E09-E12.mp4", "bilibiliReference")
    ];
    const targets = Array.from({ length: 12 }, (_, index) =>
      media(`t${index + 1}`, `Show S03E${index + 1}.mkv`, "targetOriginal")
    );

    const plan = createSmartBatchPairingPlan(sources, targets);

    expect(plan.mode).toBe("metadataGuided");
    expect(plan.pairs).toHaveLength(12);
    expect(plan.totalCartesianPairCount).toBe(36);
    expect(plan.excludedPairCount).toBe(24);
  });

  it("存在无法解释或重叠范围时安全回退全部组合", () => {
    const sources = [
      media("a", "reference A.mp4", "bilibiliReference"),
      media("b", "reference B.mp4", "bilibiliReference")
    ];
    const targets = [media("t1", "Show S03E01.mkv", "targetOriginal")];

    const plan = createSmartBatchPairingPlan(sources, targets);

    expect(plan.mode).toBe("fullCartesian");
    expect(plan.pairs).toHaveLength(2);
    expect(plan.excludedPairCount).toBe(0);
  });

  it("优先采用项目分集元数据并支持中文数字", () => {
    const emby = media("t", "unhelpful.mkv", "targetOriginal", {
      episodeKey: "S03E08"
    });
    expect(parseMediaEpisodeHint(emby)).toMatchObject({
      seasonNumber: 3,
      episodeStart: 8,
      episodeEnd: 8,
      source: "projectMetadata"
    });
    expect(
      parseMediaEpisodeHint(media("s", "第十二季第十一至十二集.mp4", "bilibiliReference"))
    ).toMatchObject({
      seasonNumber: 12,
      episodeStart: 11,
      episodeEnd: 12
    });
  });

  it("匹配与共享季集语法一致，保留范围和中文集号", () => {
    expect(
      parseMediaEpisodeHint(media("range", "Episode E01-E02.mp4", "bilibiliReference"))
    ).toMatchObject({
      seasonNumber: null,
      episodeStart: 1,
      episodeEnd: 2
    });
    expect(
      parseMediaEpisodeHint(media("chinese", "第十一集.mp4", "bilibiliReference"))
    ).toMatchObject({ episodeStart: 11, episodeEnd: 11 });
  });
});

function media(
  id: string,
  fileName: string,
  role: ProjectMediaReference["role"],
  patch: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role,
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
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...patch,
    audioTrackIntent: patch.audioTrackIntent ?? { mode: "auto" }
  };
}
