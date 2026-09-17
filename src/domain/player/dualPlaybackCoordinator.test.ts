import { describe, expect, it } from "vitest";
import type { TimeMapSpan } from "../alignment/timeMap";
import {
  canLinkDualPlayback,
  decideFollowerCorrection,
  linkedPlaybackRate,
  preferredDualPlaybackAxis,
  resolveLinkedPlaybackPositions
} from "./dualPlaybackCoordinator";

const matchedSpan: TimeMapSpan = {
  kind: "matched",
  sourceStartMs: 10_000,
  sourceEndMs: 20_000,
  targetStartMs: 30_000,
  targetEndMs: 42_000
};

describe("双播放器协调器", () => {
  it("双方存在时默认以原片 B 为主时钟并按 TimeMap 计算 A 位置", () => {
    expect(preferredDualPlaybackAxis(matchedSpan)).toBe("target");
    expect(canLinkDualPlayback(matchedSpan)).toBe(true);
    expect(resolveLinkedPlaybackPositions(matchedSpan, "target", 36_000)).toEqual({
      sourceMs: 15_000,
      targetMs: 36_000
    });
  });

  it("按双方时长比例设置跟随侧倍率", () => {
    expect(linkedPlaybackRate(matchedSpan, "target", "target")).toBe(1);
    expect(linkedPlaybackRate(matchedSpan, "source", "target")).toBeCloseTo(10 / 12);
  });

  it("差异段不能伪装成联动映射，并选择真实存在的一侧", () => {
    const sourceOnly: TimeMapSpan = {
      kind: "sourceOnly",
      sourceStartMs: 1_000,
      sourceEndMs: 3_000,
      targetStartMs: 4_000,
      targetEndMs: 4_000
    };
    expect(preferredDualPlaybackAxis(sourceOnly)).toBe("source");
    expect(canLinkDualPlayback(sourceOnly)).toBe(false);
    expect(() => resolveLinkedPlaybackPositions(sourceOnly, "source", 2_000)).toThrow(
      "只有共同内容分段可以联动播放"
    );
  });

  it("只在漂移达到阈值时 seek 跟随侧", () => {
    expect(decideFollowerCorrection(10_000, 10_180)).toEqual({
      action: "none",
      driftMs: 180
    });
    expect(decideFollowerCorrection(10_000, 10_300)).toEqual({
      action: "seek",
      driftMs: 300,
      positionMs: 10_000
    });
  });
});
