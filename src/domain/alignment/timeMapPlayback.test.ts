import { describe, expect, it } from "vitest";
import type { TimeMapSpan } from "./timeMap";
import {
  createTimeMapPlaybackSpanPlan,
  createTimeMapPlaybackBoundaryContext,
  mapTimeMapPlaybackCounterpart,
  resolveTimeMapPlaybackBoundary,
  resolveTimeMapBoundaryPlaybackSwitch,
  resolveTimeMapPlaybackSwitch
} from "./timeMapPlayback";

describe("TimeMap A/B 播放复核", () => {
  it("对速度漂移 matched 段执行双向整数毫秒同步且保持半开边界", () => {
    const span: TimeMapSpan = {
      kind: "matched",
      sourceStartMs: 10_000,
      sourceEndMs: 20_000,
      targetStartMs: 30_000,
      targetEndMs: 42_000
    };

    expect(createTimeMapPlaybackSpanPlan(span)).toMatchObject({
      kind: "mapped",
      initialAxis: "source",
      canSynchronize: true
    });
    expect(resolveTimeMapPlaybackSwitch(span, "source", "target", 15_000)).toEqual({
      status: "mapped",
      positionMs: 36_000
    });
    expect(resolveTimeMapPlaybackSwitch(span, "target", "source", 36_000)).toEqual({
      status: "mapped",
      positionMs: 15_000
    });
    expect(mapTimeMapPlaybackCounterpart(span, "source", 20_000)).toBe(41_999);
  });

  it("sourceOnly 只允许参考 A，明确拒绝不存在的原片 B", () => {
    const span: TimeMapSpan = {
      kind: "sourceOnly",
      sourceStartMs: 15_000,
      sourceEndMs: 17_000,
      targetStartMs: 10_000,
      targetEndMs: 10_000
    };

    expect(createTimeMapPlaybackSpanPlan(span)).toMatchObject({
      kind: "sourceOnly",
      sourceInterval: { startMs: 15_000, endMs: 17_000 },
      targetInterval: null,
      initialAxis: "source",
      canSynchronize: false
    });
    expect(resolveTimeMapPlaybackSwitch(span, "source", "target", 16_000)).toEqual({
      status: "unavailable",
      reason: "sourceOnly"
    });
    expect(mapTimeMapPlaybackCounterpart(span, "source", 16_000)).toBeNull();
  });

  it("targetOnly 只允许原片 B", () => {
    const span: TimeMapSpan = {
      kind: "targetOnly",
      sourceStartMs: 17_000,
      sourceEndMs: 17_000,
      targetStartMs: 10_000,
      targetEndMs: 13_000
    };

    expect(createTimeMapPlaybackSpanPlan(span)).toMatchObject({
      kind: "targetOnly",
      sourceInterval: null,
      targetInterval: { startMs: 10_000, endMs: 13_000 },
      initialAxis: "target"
    });
    expect(resolveTimeMapPlaybackSwitch(span, "target", "source", 11_000)).toEqual({
      status: "unavailable",
      reason: "targetOnly"
    });
  });

  it("ambiguous 允许分别试听但切换只回到另一侧段首", () => {
    const span: TimeMapSpan = {
      kind: "ambiguous",
      sourceStartMs: 17_000,
      sourceEndMs: 25_000,
      targetStartMs: 13_000,
      targetEndMs: 21_000
    };

    expect(createTimeMapPlaybackSpanPlan(span)).toMatchObject({
      kind: "ambiguous",
      canSynchronize: false
    });
    expect(resolveTimeMapPlaybackSwitch(span, "source", "target", 20_000)).toEqual({
      status: "independent",
      positionMs: 13_000,
      reason: "ambiguous"
    });
    expect(mapTimeMapPlaybackCounterpart(span, "source", 20_000)).toBeNull();
  });

  it("在区间末端按循环开关回到段首或暂停在末端前", () => {
    const interval = { startMs: 5_000, endMs: 8_000 };

    expect(resolveTimeMapPlaybackBoundary(interval, 7_999, true)).toEqual({
      reachedEnd: false,
      shouldPause: false,
      seekToMs: null
    });
    expect(resolveTimeMapPlaybackBoundary(interval, 8_000, true)).toEqual({
      reachedEnd: true,
      shouldPause: false,
      seekToMs: 5_000
    });
    expect(resolveTimeMapPlaybackBoundary(interval, 8_001, false)).toEqual({
      reachedEnd: true,
      shouldPause: true,
      seekToMs: 7_999
    });
  });

  it("为 sourceOnly 的双方边界生成前后上下文，但切换结果明确为非映射对照", () => {
    const span: TimeMapSpan = {
      kind: "sourceOnly",
      sourceStartMs: 10_000,
      sourceEndMs: 12_000,
      targetStartMs: 20_000,
      targetEndMs: 20_000
    };
    const context = createTimeMapPlaybackBoundaryContext(
      span,
      "startBoundary",
      { startMs: 0, endMs: 30_000 },
      { startMs: 0, endMs: 40_000 }
    );

    expect(context).toMatchObject({
      sourceBoundaryMs: 10_000,
      targetBoundaryMs: 20_000,
      sourceInterval: { startMs: 7_000, endMs: 13_000 },
      targetInterval: { startMs: 17_000, endMs: 23_000 },
      canSynchronize: false
    });
    expect(
      resolveTimeMapBoundaryPlaybackSwitch(span, context, "source", "target", 9_000)
    ).toEqual({
      status: "independent",
      positionMs: 19_000,
      reason: "boundary-context"
    });
  });

  it("matched 边界上下文按分段斜率同步相对边界偏移", () => {
    const span: TimeMapSpan = {
      kind: "matched",
      sourceStartMs: 10_000,
      sourceEndMs: 20_000,
      targetStartMs: 30_000,
      targetEndMs: 42_000
    };
    const context = createTimeMapPlaybackBoundaryContext(
      span,
      "endBoundary",
      { startMs: 0, endMs: 25_000 },
      { startMs: 0, endMs: 50_000 }
    );

    expect(
      resolveTimeMapBoundaryPlaybackSwitch(span, context, "source", "target", 19_000)
    ).toEqual({
      status: "mapped",
      positionMs: 40_800
    });
  });
});
