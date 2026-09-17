import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuClip, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "../project/factory";
import {
  applyCutMapping,
  getResolvedDanmakuTime,
  isItemInsideClip,
  resolveProjectDanmakuEvents
} from "./mapping";

function item(id: string, sourceTimeMs: number, index: number): DanmakuItem {
  return {
    id,
    assetId: "asset",
    originalIndex: index,
    sourceTimeMs,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: null,
    pool: null,
    userHash: "user",
    rowId: `row${index}`,
    text: id,
    rawPFields: [String(sourceTimeMs / 1000), "1", "25", "16777215", "0", "0", "user", `row${index}`],
    enabled: true
  };
}

const clip: DanmakuClip = {
  id: "clip",
  assetId: "asset",
  name: "clip",
  timelineStartMs: 10_000,
  sourceInMs: 1000,
  sourceOutMs: 20_000,
  localOffsetMs: 250,
  enabled: true
};

describe("timeline mapping", () => {
  it("计算片段偏移、全局偏移和单条调整", () => {
    const resolved = getResolvedDanmakuTime(item("a", 4000, 0), clip, {
      globalOffsetMs: 500,
      cutMarkers: [],
      itemTimeAdjustments: { a: -100 }
    });
    expect(resolved).toBe(13_650);
  });

  it("多个版本差异会累计影响后续时间", () => {
    expect(
      applyCutMapping(21 * 60_000, [
        { id: "c1", name: "cut1", sourceAtMs: 20 * 60_000, targetGapMs: 45_000, note: "" },
        { id: "c2", name: "cut2", sourceAtMs: 20 * 60_000 + 30_000, targetGapMs: 15_000, note: "" }
      ])
    ).toBe(22 * 60_000);
  });

  it("导出事件按最终时间和原始顺序排序", () => {
    const asset: DanmakuAsset = {
      id: "asset",
      name: "asset",
      fileName: "a.xml",
      color: "#4cc9f0",
      importedAt: new Date().toISOString(),
      sourceReceipt: null,
      warnings: [],
      items: [item("late", 3000, 2), item("early", 1000, 0), item("same", 1000, 1)]
    };
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [{ ...clip, timelineStartMs: 0, sourceInMs: 0, sourceOutMs: 5000, localOffsetMs: 0 }]
    };
    expect(resolveProjectDanmakuEvents(project).map((event) => event.item.id)).toEqual(["early", "same", "late"]);
  });

  it("片段源区间按左闭右开匹配，避免剪切边界重复", () => {
    const boundaryItem = item("boundary", 1000, 0);
    const leftClip = { ...clip, sourceInMs: 0, sourceOutMs: 1000 };
    const rightClip = { ...clip, sourceInMs: 1000, sourceOutMs: 2000 };
    const asset: DanmakuAsset = {
      id: "asset",
      name: "asset",
      fileName: "a.xml",
      color: "#4cc9f0",
      importedAt: new Date().toISOString(),
      sourceReceipt: null,
      warnings: [],
      items: [item("before", 999, 0), boundaryItem, item("after", 1999, 2)]
    };
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        { ...leftClip, id: "left", timelineStartMs: 0, localOffsetMs: 0 },
        { ...rightClip, id: "right", timelineStartMs: 1000, localOffsetMs: 0 }
      ]
    };

    expect(isItemInsideClip(boundaryItem, leftClip)).toBe(false);
    expect(isItemInsideClip(boundaryItem, rightClip)).toBe(true);
    expect(resolveProjectDanmakuEvents(project).map((event) => event.id)).toEqual([
      "left:before",
      "right:boundary",
      "right:after"
    ]);
  });
});
