import { describe, expect, it } from "vitest";
import type { ResolvedDanmakuEvent } from "../danmaku/types";
import { aggregateDensity, getEventsInRange, lowerBoundByTime, upperBoundByTime } from "./search";

function event(id: string, finalTimeMs: number): ResolvedDanmakuEvent {
  return {
    id,
    finalTimeMs,
    originalIndex: Number(id),
    enabled: true,
    item: {
      id,
      assetId: "asset",
      originalIndex: Number(id),
      sourceTimeMs: finalTimeMs,
      mode: 1,
      fontSize: 25,
      color: 16_777_215,
      timestamp: null,
      pool: null,
      userHash: null,
      rowId: null,
      text: id,
      rawPFields: [],
      enabled: true
    },
    clip: {
      id: "clip",
      assetId: "asset",
      name: "clip",
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 10_000,
      localOffsetMs: 0,
      enabled: true
    },
    asset: {
      id: "asset",
      name: "asset",
      fileName: "asset.xml",
      color: "#4cc9f0",
      items: [],
      warnings: [],
      importedAt: "now",
      sourceReceipt: null
    }
  };
}

describe("timeline search", () => {
  const events = [event("0", 0), event("1", 1000), event("2", 2000), event("3", 3000)];

  it("二分查找时间范围", () => {
    expect(lowerBoundByTime(events, 1500)).toBe(2);
    expect(upperBoundByTime(events, 2000)).toBe(3);
    expect(getEventsInRange(events, 900, 2100).map((item) => item.id)).toEqual(["1", "2"]);
  });

  it("按时间桶聚合密度", () => {
    const buckets = aggregateDensity(events, 0, 4000, 2000);
    expect(buckets.map((bucket) => bucket.count)).toEqual([2, 2]);
  });
});
