import { describe, expect, it } from "vitest";
import { createCompensationReport, createExportSummary } from "./exportSummary";
import type { CutMarker, DanmakuAsset, DanmakuClip, DanmakuItem, ResolvedDanmakuEvent } from "./types";

describe("导出版本差异报告", () => {
  it("按发生时间输出版本差异明细和累计调整时长", () => {
    const markers: CutMarker[] = [
      {
        id: "cut-late",
        name: "后段版本差异",
        sourceAtMs: 30_000,
        targetGapMs: 5_000,
        note: ""
      },
      {
        id: "cut-early",
        name: "前段版本差异",
        sourceAtMs: 10_000,
        targetGapMs: 12_000,
        note: "人工复核"
      }
    ];

    const summary = createExportSummary([], markers, false);
    const report = createCompensationReport("测试项目", summary, new Date("2026-07-10T01:02:03.000Z"));

    expect(summary.totalCutGapMs).toBe(17_000);
    expect(summary.compensationDetails.map((detail) => detail.id)).toEqual(["cut-early", "cut-late"]);
    expect(report).toContain("导出复核报告");
    expect(report).toContain("项目：测试项目");
    expect(report).toContain("生成时间：2026-07-10T01:02:03.000Z");
    expect(report).toContain("原始弹幕：0 条");
    expect(report).toContain("启用弹幕：0 条");
    expect(report).toContain("禁用弹幕：0 条");
    expect(report).toContain("最早最终时间：00:00:00.000");
    expect(report).toContain("最晚最终时间：00:00:00.000");
    expect(report).toContain("累计调整：+00:00:17.000");
    expect(report).toContain("导入警告：无");
    expect(report).toContain("负时间限制：0 项");
    expect(report).toContain("1. 前段版本差异");
    expect(report).toContain("ID：cut-early");
    expect(report).toContain("备注：人工复核");
  });

  it("记录负时间限制明细", () => {
    const event = createResolvedEvent(-500);
    const summary = createExportSummary([event], [], false);
    const report = createCompensationReport("负时间项目", summary);

    expect(summary.negativeClampCount).toBe(1);
    expect(summary.negativeClampDetails).toEqual([
      expect.objectContaining({
        assetFileName: "asset.xml",
        clipName: "片段",
        originalIndex: 0,
        finalTimeMs: -500,
        text: "过早弹幕"
      })
    ]);
    expect(report).toContain("本次导出未应用版本差异。");
    expect(report).toContain("原始弹幕：1 条");
    expect(report).toContain("启用弹幕：1 条");
    expect(report).toContain("最早最终时间：00:00:00.000");
    expect(report).toContain("负时间限制：1 项");
    expect(report).toContain("负时间限制明细");
    expect(report).toContain("事件 ID：clip:item");
    expect(report).toContain("原最终时间：-00:00:00.500 (-500 ms)");
    expect(report).toContain("文本：过早弹幕");
  });

  it("导出复核报告包含时间范围和导入警告摘要", () => {
    const summary = createExportSummary(
      [createResolvedEvent(1500), { ...createResolvedEvent(3200), id: "clip:item-2" }],
      [],
      true
    );
    const report = createCompensationReport("摘要项目", summary, new Date("2026-07-10T01:02:03.000Z"));

    expect(report).toContain("原始弹幕：2 条");
    expect(report).toContain("启用弹幕：2 条");
    expect(report).toContain("最早最终时间：00:00:01.500");
    expect(report).toContain("最晚最终时间：00:00:03.200");
    expect(report).toContain("导入警告：有");
  });
});

function createResolvedEvent(finalTimeMs: number): ResolvedDanmakuEvent {
  const item: DanmakuItem = {
    id: "item",
    assetId: "asset",
    originalIndex: 0,
    sourceTimeMs: 1000,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "user",
    rowId: "row",
    text: "过早弹幕",
    rawPFields: ["1.000", "1", "25", "16777215", "0", "0", "user", "row"],
    enabled: true
  };
  const asset: DanmakuAsset = {
    id: "asset",
    name: "asset",
    fileName: "asset.xml",
    color: "#4cc9f0",
    items: [item],
    warnings: [],
    importedAt: "now",
    sourceReceipt: null
  };
  const clip: DanmakuClip = {
    id: "clip",
    assetId: "asset",
    name: "片段",
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 2000,
    localOffsetMs: 0,
    enabled: true
  };
  return {
    id: "clip:item",
    item,
    asset,
    clip,
    finalTimeMs,
    originalIndex: item.originalIndex,
    enabled: true
  };
}
