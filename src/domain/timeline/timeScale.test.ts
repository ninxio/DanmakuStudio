import { describe, expect, it } from "vitest";
import { createTimeScale, equalizeTimeRanges } from "./timeScale";
describe("time scale", () => {
  it("keeps clock divisions aligned at fractional starts and avoids crowded labels", () => {
    for (const width of [240, 800, 1700]) {
      const scale = createTimeScale(2025, 2478825, width);
      expect(scale.ticks.every((tick) => tick.timeMs % scale.stepMs === 0)).toBe(true);
      for (let i = 1; i < scale.ticks.length; i++)
        expect(
          ((scale.ticks[i].percent - scale.ticks[i - 1].percent) / 100) * width
        ).toBeGreaterThanOrEqual(90);
    }
  });
  it("uses true millisecond positions and expands the short axis without stretching it", () => {
    const ranges = equalizeTimeRanges(
      { startMs: 0, endMs: 10000 },
      { startMs: 330000, endMs: 380000 }
    );
    expect(ranges).toEqual({
      source: { startMs: 0, endMs: 50000 },
      target: { startMs: 330000, endMs: 380000 }
    });
    const scale = createTimeScale(2001, 2701, 800);
    expect(scale.ticks[0].timeMs).toBe(2100);
    expect(scale.ticks[0].label).toBe("00:02.100");
    expect(scale.ticks[0].percent).toBeCloseTo((99 / 700) * 100);
  });
});
