import { describe, expect, it } from "vitest";
import { parseBilibiliXml, serializeBilibiliXml, validateExportedXml } from "../../infrastructure/xml/bilibiliXml";
import { buildBatchMergePlan } from "./batchMerge";

describe("批量分集合并", () => {
  it("大量弹幕不超过 JavaScript 函数参数数量上限", () => {
    const asset = createAsset("P1.xml", [0]);
    asset.items = Array.from({ length: 150_000 }, (_, index) => ({
      ...asset.items[0], id: `item-${index}`, sourceTimeMs: index
    }));
    const plan = buildBatchMergePlan([asset]);
    expect(plan.episodes[0].entries).toHaveLength(150_000);
    expect(plan.episodes[0].entries.at(-1)?.finalTimeMs).toBe(149_999);
  });
  it("将 1.1、1.2 这类分 P 命名追加合并到同一集", () => {
    const assets = [
      createAsset("01 - 1.1.xml", [0, 1000]),
      createAsset("02 - 1.2.xml", [0, 2000]),
      createAsset("03 - 2.1.xml", [0, 1500])
    ];
    const plan = buildBatchMergePlan(assets);
    expect(plan.confidence).toBe("high");
    expect(plan.episodes).toHaveLength(2);
    expect(plan.episodes[0].fileName).toBe("1 - 1.xml");
    expect(plan.episodes[0].sourceFileNames).toEqual(["01 - 1.1.xml", "02 - 1.2.xml"]);
    expect(plan.episodes[0].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 1000, 1000, 3000]);
  });

  it("将 第一季1-3 这类范围文件切分成多个分集输出", () => {
    const asset = createAsset("1 - 第一季1-3.xml", [0, 1000, 120_000, 121_000, 240_000]);
    const plan = buildBatchMergePlan([asset]);
    expect(plan.episodes).toHaveLength(3);
    expect(plan.episodes.map((episode) => episode.label)).toEqual(["第 1 集", "第 2 集", "第 3 集"]);
    for (const episode of plan.episodes) {
      const xml = serializeBilibiliXml(episode.entries).xml;
      expect(validateExportedXml(xml).ok).toBe(true);
    }
  });

  it("可用人工规则只取每个分 P 的前若干时间并按固定时长追加", () => {
    const assets = [
      createAsset("01 - 1.1.xml", [0, 60_000, 540_000, 700_000]),
      createAsset("02 - 1.2.xml", [0, 120_000, 650_000])
    ];
    const plan = buildBatchMergePlan(assets, {
      segmentWindow: { mode: "prefix", durationMs: 540_000 }
    });
    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 60_000, 540_000, 660_000]);
  });

  it("可用真实集时长切分长合集并丢弃尾部额外内容", () => {
    const asset = createAsset("1 - 第一季1-2.xml", [0, 1_000, 90_000, 91_000, 220_000]);
    const plan = buildBatchMergePlan([asset], {
      rangeSplit: {
        mode: "episodeDurations",
        episodes: [
          { seasonNumber: 1, episodeNumber: 1, durationMs: 90_000 },
          { seasonNumber: 1, episodeNumber: 2, durationMs: 90_000 }
        ]
      }
    });
    expect(plan.episodes).toHaveLength(2);
    expect(plan.episodes[0].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 1_000]);
    expect(plan.episodes[1].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 1_000]);
    expect(plan.episodes[1].warnings.join(" ")).toContain("尾部内容");
  });

  it("按真实集时长切分前会先应用版本差异映射", () => {
    const asset = createAsset("1 - 第一季1-2.xml", [0, 40_000, 80_000, 90_000, 91_000]);
    const plan = buildBatchMergePlan([asset], {
      rangeSplit: {
        mode: "episodeDurations",
        episodes: [
          { seasonNumber: 1, episodeNumber: 1, durationMs: 100_000 },
          { seasonNumber: 1, episodeNumber: 2, durationMs: 100_000 }
        ]
      },
      cutMarkers: [
        {
          id: "cut-1",
          name: "版本差异 1",
          sourceAtMs: 50_000,
          targetGapMs: 10_000,
          note: "第一集前段缺失 10 秒"
        }
      ]
    });

    expect(plan.episodes).toHaveLength(2);
    expect(plan.episodes[0].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 40_000, 90_000]);
    expect(plan.episodes[1].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 1_000]);
    expect(plan.compensation).toEqual({
      markerCount: 1,
      totalGapMs: 10_000,
      affectedEntryCount: 3,
      affectedEpisodeCount: 2
    });
    for (const episode of plan.episodes) {
      const xml = serializeBilibiliXml(episode.entries).xml;
      expect(validateExportedXml(xml).ok).toBe(true);
    }
  });

  it("多个版本差异会累计影响同一分集内的最终时间", () => {
    const asset = createAsset("01 - 1.1.xml", [0, 70_000, 110_000]);
    const plan = buildBatchMergePlan([asset], {
      cutMarkers: [
        { id: "cut-1", name: "版本差异 1", sourceAtMs: 50_000, targetGapMs: 10_000, note: "" },
        { id: "cut-2", name: "版本差异 2", sourceAtMs: 100_000, targetGapMs: 20_000, note: "" }
      ]
    });

    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0].entries.map((entry) => entry.finalTimeMs)).toEqual([0, 80_000, 140_000]);
    expect(plan.compensation.totalGapMs).toBe(30_000);
    expect(plan.compensation.affectedEntryCount).toBe(2);
  });

  it("复用共享解析时保持既有批量合并兜底语义", () => {
    const plan = buildBatchMergePlan([
      createAsset("E02.xml", [0]),
      createAsset("E01.xml", [0])
    ]);

    expect(plan.confidence).toBe("low");
    expect(plan.episodes.map((episode) => episode.sourceFileNames)).toEqual([
      ["E02.xml"],
      ["E01.xml"]
    ]);
    expect(plan.diagnostics.join(" ")).toContain("2 个文件未识别到集数");

    const legacyRange = buildBatchMergePlan([
      createAsset("Show 第一季1_2.xml", [0, 1000])
    ]);
    expect(legacyRange.confidence).toBe("high");
    expect(legacyRange.episodes).toHaveLength(2);

    const fullWidthLegacyFallback = buildBatchMergePlan([
      createAsset("Ｓ０１Ｅ０２.xml", [0])
    ]);
    expect(fullWidthLegacyFallback.confidence).toBe("low");
    expect(fullWidthLegacyFallback.episodes[0].episodeNumber).toBe(1);
    expect(fullWidthLegacyFallback.diagnostics.join(" ")).toContain(
      "1 个文件未识别到集数"
    );
  });
});

function createAsset(fileName: string, timesMs: number[]) {
  const lines = timesMs.map((timeMs, index) => {
    const seconds = (timeMs / 1000).toFixed(3);
    return `<d p="${seconds},1,25,16777215,0,0,user${index},row${index}">${fileName}-${index}</d>`;
  });
  return parseBilibiliXml(`<?xml version="1.0" encoding="UTF-8"?><i>${lines.join("")}</i>`, { fileName });
}
