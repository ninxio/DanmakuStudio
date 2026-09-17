import { describe, expect, it } from "vitest";
import type { BatchMergePlan } from "../danmaku/batchMerge";
import type { DanmakuAsset } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import {
  createDanmakuSourceSegment,
  createSourceTimelineSummary,
  parseSourceTimecode,
  updateDanmakuSourceSegment
} from "./sourceTimeline";
import type { ProjectMediaReference, ProjectMediaRole } from "./types";

describe("danmaku source timeline", () => {
  it("创建正片内容段并保留对应输出集", () => {
    const segment = createDanmakuSourceSegment(
      "segment-1",
      {
        kind: "content",
        assetId: "asset",
        sourceMediaId: "source-media",
        sourceStartMs: 7_200_000,
        sourceEndMs: 7_260_000,
        targetMediaId: "target-media",
        episodeKey: "S01E01",
        episodeLabel: "第 1 集",
        note: "正片开始"
      },
      "2026-07-11T00:00:00.000Z"
    );

    expect(segment).toMatchObject({
      id: "segment-1",
      label: "第 1 集 来源段",
      kind: "content",
      assetId: "asset",
      sourceMediaId: "source-media",
      sourceStartMs: 7_200_000,
      sourceEndMs: 7_260_000,
      targetMediaId: "target-media",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      note: "正片开始"
    });
  });

  it("忽略范围不会保留分集关联", () => {
    const segment = createDanmakuSourceSegment("ignored", {
      kind: "ignored",
      assetId: "asset",
      sourceMediaId: "source-media",
      sourceStartMs: 0,
      sourceEndMs: 7_200_000,
      targetMediaId: "target-media",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集"
    });
    const updated = updateDanmakuSourceSegment(segment, {
      kind: "content",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集"
    });

    expect(segment.episodeKey).toBeNull();
    expect(segment.episodeLabel).toBeNull();
    expect(updated.kind).toBe("content");
    expect(updated.episodeKey).toBe("S01E01");
  });

  it("解析常用来源时间码", () => {
    expect(parseSourceTimecode("02:00:00.000")).toBe(7_200_000);
    expect(parseSourceTimecode("24:05.250")).toBe(1_445_250);
    expect(parseSourceTimecode("00:61")).toBeNull();
    expect(parseSourceTimecode("bad")).toBeNull();
  });

  it("已确认时间图拥有的来源段只允许修改标签类元数据", () => {
    const segment = createDanmakuSourceSegment("mapped", {
      kind: "content",
      assetId: "asset",
      sourceMediaId: "source-media",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetMediaId: "target-media",
      targetStartMs: 5_000,
      timingRules: [],
      timeMapId: "confirmed-map",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集"
    });

    expect(
      updateDanmakuSourceSegment(segment, {
        label: "人工备注后的标签",
        note: "仅改说明",
        episodeKey: "S01E02",
        episodeLabel: "第 2 集"
      })
    ).toMatchObject({
      label: "人工备注后的标签",
      note: "仅改说明",
      episodeKey: "S01E02",
      timeMapId: "confirmed-map"
    });
    expect(() =>
      updateDanmakuSourceSegment(segment, { sourceStartMs: 1_000 })
    ).toThrow("由已确认时间图管理");
    expect(() =>
      updateDanmakuSourceSegment(segment, {
        timingRules: [{ sourceAtMs: 20_000, gapMs: 5_000 }]
      })
    ).toThrow("由已确认时间图管理");
  });

  it("摘要提示未标注、重叠和就绪状态", () => {
    const plan = createPlan();
    const emptyProject = {
      ...createEmptyProject(),
      assets: [createAsset()],
      mediaLibrary: [
        createMedia("source-media", "bilibiliReference"),
        createMedia("target-media", "targetOriginal")
      ]
    };

    expect(createSourceTimelineSummary(emptyProject, plan)).toMatchObject({
      status: "needsSegments",
      statusId: "actionRequired",
      statusLabel: "需处理"
    });

    const segmentA = createDanmakuSourceSegment("segment-a", {
      kind: "content",
      assetId: "asset",
      sourceMediaId: "source-media",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetMediaId: "target-media",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集"
    });
    const segmentB = createDanmakuSourceSegment("segment-b", {
      kind: "ignored",
      assetId: "asset",
      sourceMediaId: "source-media",
      sourceStartMs: 30_000,
      sourceEndMs: 90_000,
      targetMediaId: null,
      episodeKey: null,
      episodeLabel: null
    });
    expect(
      createSourceTimelineSummary(
        {
          ...emptyProject,
          danmakuSourceSegments: [segmentA, segmentB]
        },
        plan
      ).findings.some((finding) => finding.title === "来源内容段时间重叠")
    ).toBe(true);

    const readySummary = createSourceTimelineSummary(
      {
        ...emptyProject,
        danmakuSourceSegments: [
          segmentA,
          {
            ...segmentB,
            sourceStartMs: 60_000,
            sourceEndMs: 90_000
          }
        ]
      },
      plan
    );
    expect(readySummary.status).toBe("ready");
    expect(readySummary.statusId).toBe("confirmed");
    expect(readySummary.statusLabel).toBe("已确认");
    expect(readySummary.metrics).toContainEqual({ label: "已关联原片", value: "1 个" });

    const targetOnlySummary = createSourceTimelineSummary(
      {
        ...emptyProject,
        danmakuSourceSegments: [
          {
            ...segmentA,
            episodeKey: null,
            episodeLabel: null
          }
        ]
      },
      { ...plan, episodes: [] }
    );
    expect(targetOnlySummary.status).toBe("ready");
    expect(
      targetOnlySummary.findings.some((finding) => finding.title === "内容段未关联输出集")
    ).toBe(false);

    const multiTargetSummary = createSourceTimelineSummary(
      {
        ...emptyProject,
        mediaLibrary: [
          ...emptyProject.mediaLibrary,
          createMedia("target-media-2", "targetOriginal")
        ],
        danmakuSourceSegments: [
          segmentA,
          {
            ...segmentA,
            id: "segment-same-source-other-target",
            targetMediaId: "target-media-2"
          }
        ]
      },
      plan
    );
    expect(multiTargetSummary.status).toBe("ready");
    expect(
      multiTargetSummary.findings.some((finding) => finding.title === "来源内容段时间重叠")
    ).toBe(false);
    expect(multiTargetSummary.metrics).toContainEqual({ label: "已关联原片", value: "2 个" });
  });
});

function createPlan(): BatchMergePlan {
  return {
    episodes: [
      {
        id: "episode-1",
        seasonNumber: 1,
        episodeNumber: 1,
        label: "第 1 集",
        fileName: "S01E01.xml",
        sourceFileNames: ["S01E01.xml"],
        itemCount: 1,
        entries: [],
        warnings: []
      }
    ],
    diagnostics: [],
    confidence: "high",
    compensation: {
      markerCount: 0,
      totalGapMs: 0,
      affectedEntryCount: 0,
      affectedEpisodeCount: 0
    }
  };
}

function createMedia(id: string, role: ProjectMediaRole): ProjectMediaReference {
  return {
    id,
    role,
    name: role === "bilibiliReference" ? "B 站参考" : "目标原片",
    fileName: role === "bilibiliReference" ? "reference.mp4" : "target.mp4",
    objectUrl: "blob:test",
    durationMs: 120_000,
    contentIdentity: null,
    referenceKind: "browserFile",
    connectionState: "connected",
    sourceSummary: "浏览器文件",
    localPath: null,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}

function createAsset(): DanmakuAsset {
  return {
    id: "asset",
    name: "source",
    fileName: "source.xml",
    color: "#4cc9f0",
    importedAt: "2026-07-11T00:00:00.000Z",
    sourceReceipt: null,
    warnings: [],
    items: [
      {
        id: "item",
        assetId: "asset",
        originalIndex: 0,
        sourceTimeMs: 0,
        mode: 1,
        fontSize: 25,
        color: 16_777_215,
        timestamp: 0,
        pool: 0,
        userHash: "u",
        rowId: "r",
        text: "测试",
        rawPFields: ["0", "1", "25", "16777215", "0", "0", "u", "r"],
        enabled: true
      }
    ]
  };
}
