import { describe, expect, it } from "vitest";
import type {
  RealMediaBenchmarkContentIdentity,
  RealMediaBenchmarkGold
} from "./realMediaBenchmark";
import { deriveRealMediaBenchmarkScenarios } from "./realMediaBenchmarkScenarios";

describe("C137 real-media scenario derivation", () => {
  it("从 Gold 结构确定性派生差异类标签，不接受 probe-only 猜测", () => {
    const gold = createGold();
    gold.sourceOnlySpans.push({
      kind: "sourceOnly",
      sourceStartMs: 10_000,
      sourceEndMs: 11_000,
      targetStartMs: 10_000,
      targetEndMs: 10_000
    });
    gold.targetOnlySpans.push({
      kind: "targetOnly",
      sourceStartMs: 20_000,
      sourceEndMs: 20_000,
      targetStartMs: 19_000,
      targetEndMs: 20_000
    });

    const scenarios = deriveRealMediaBenchmarkScenarios(gold, identity("a"), identity("b"));
    expect(scenarios).toEqual(["multi-edit", "source-only", "target-only"]);
    expect(scenarios).not.toContain("multi-audio");
    expect(scenarios).not.toContain("visual-fallback");
    expect(scenarios).not.toContain("pts-offset");
  });

  it("区分固定偏移、无编辑变速和长参考", () => {
    const gold = createGold();
    gold.sourceEndMs = 3_000_000;
    gold.targetEndMs = 3_003_000;
    gold.matchedAnchors = [
      { id: "a", sourceMs: 0, targetMs: 1_000 },
      { id: "b", sourceMs: 3_000_000, targetMs: 3_003_000 }
    ];
    expect(deriveRealMediaBenchmarkScenarios(gold, identity("a"), identity("b"))).toEqual([
      "global-offset",
      "long-reference",
      "time-stretch"
    ]);
  });

  it("无结构差异时只把不同全文件身份归为 codec-variant", () => {
    expect(
      deriveRealMediaBenchmarkScenarios(createGold(), identity("a"), identity("b"))
    ).toEqual(["codec-variant"]);
    expect(() =>
      deriveRealMediaBenchmarkScenarios(createGold(), identity("a"), identity("a"))
    ).toThrow("禁止手工补造标签");
  });
});

function createGold(): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 30_000,
    targetStartMs: 0,
    targetEndMs: 30_000,
    matchedAnchors: [
      { id: "a", sourceMs: 0, targetMs: 0 },
      { id: "b", sourceMs: 30_000, targetMs: 30_000 }
    ],
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function identity(seed: string): RealMediaBenchmarkContentIdentity {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: seed.charCodeAt(0),
    digest: seed.repeat(64)
  };
}
