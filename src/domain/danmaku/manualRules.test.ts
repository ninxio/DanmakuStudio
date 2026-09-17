import { describe, expect, it } from "vitest";
import { parseCutPointsText, parseEpisodeDurationsText, parseMinutesInput } from "./manualRules";

describe("人工整理规则解析", () => {
  it("解析按行粘贴的真实集时长", () => {
    const parsed = parseEpisodeDurationsText("S01E01 51:20.123\nS01E02 50:45\n49.5");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.episodes).toEqual([
      { seasonNumber: 1, episodeNumber: 1, durationMs: 3_080_123 },
      { seasonNumber: 1, episodeNumber: 2, durationMs: 3_045_000 },
      { seasonNumber: null, episodeNumber: 3, durationMs: 2_970_000 }
    ]);
  });

  it("解析人工切点列表", () => {
    const parsed = parseCutPointsText("51:20, 1:42:05\n153:10");
    expect(parsed.cutPointsMs).toEqual([3_080_000, 6_125_000, 9_190_000]);
  });

  it("解析分钟输入", () => {
    expect(parseMinutesInput("9")).toBe(540_000);
    expect(parseMinutesInput("1.5")).toBe(90_000);
    expect(parseMinutesInput("abc")).toBeNull();
  });
});
