import { describe, expect, it } from "vitest";
import type {
  DanmakuAsset,
  DanmakuClip,
  DanmakuItem,
  ResolvedDanmakuEvent
} from "../danmaku/types";
import { getPreviewEvents, MAX_PREVIEW_DANMAKU_EVENTS } from "./visibleEvents";

const asset: DanmakuAsset = {
  id: "asset",
  name: "asset",
  fileName: "asset.xml",
  color: "#4cc9f0",
  items: [],
  warnings: [],
  importedAt: "2026-07-03T00:00:00.000Z",
  sourceReceipt: null
};

const clip: DanmakuClip = {
  id: "clip",
  assetId: asset.id,
  name: "clip",
  timelineStartMs: 0,
  sourceInMs: 0,
  sourceOutMs: 10_000,
  localOffsetMs: 0,
  enabled: true
};

function createEvent(
  id: string,
  finalTimeMs: number,
  mode = 1,
  enabled = true
): ResolvedDanmakuEvent {
  const item: DanmakuItem = {
    id,
    assetId: asset.id,
    originalIndex: Number(id.replace(/\D/g, "")) || 0,
    sourceTimeMs: finalTimeMs,
    mode,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "user",
    rowId: id,
    text: id,
    rawPFields: [],
    enabled
  };
  return {
    id,
    item,
    clip,
    asset,
    finalTimeMs,
    originalIndex: item.originalIndex,
    enabled
  };
}

describe("preview visible events", () => {
  it("只返回当前预览时间内仍可见的启用弹幕", () => {
    const events = [
      createEvent("rolling-expired", 1000),
      createEvent("rolling-visible", 2500),
      createEvent("top-expired", 5000, 5),
      createEvent("top-visible", 9000, 5),
      createEvent("disabled", 9500, 1, false),
      createEvent("future", 11_000)
    ];
    expect(getPreviewEvents(events, 10_000).map((event) => event.id)).toEqual([
      "rolling-visible",
      "top-visible"
    ]);
  });

  it("限制单帧最多渲染的弹幕数量", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      createEvent(`event-${index}`, index)
    );
    expect(getPreviewEvents(events, 1000)).toHaveLength(MAX_PREVIEW_DANMAKU_EVENTS);
  });
});
