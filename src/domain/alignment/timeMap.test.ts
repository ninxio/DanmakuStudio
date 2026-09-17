import { describe, expect, it } from "vitest";
import {
  assessTimeMapQuality,
  assertValidTimeMap,
  compileTimeMap,
  formatTimeMapQualityLevel,
  isCompleteTimeMapSpanEvidence,
  mapSourceTime,
  migrateLegacyTimeMap,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  reconcileTimeMapQualityClaim,
  validateTimeMap,
  type LegacyTimingRuleInput,
  type TimeMapSpan
} from "./timeMap";

describe("分段时间映射", () => {
  it("把质量等级投影到固定状态词并保留旧版差异说明", () => {
    expect(formatTimeMapQualityLevel("verified")).toBe("已确认");
    expect(formatTimeMapQualityLevel("review")).toBe("需复核");
    expect(formatTimeMapQualityLevel("blocked")).toBe("已阻断");
    expect(formatTimeMapQualityLevel("legacy-unverified")).toBe("需复核（旧版未验证）");
  });

  it("只把缺失的旧逐段证据显式迁移为 legacy-unverified", () => {
    const plain = matched(0, 10_000, 0, 10_000);
    expect(isCompleteTimeMapSpanEvidence(plain)).toBe(false);

    const migrated = normalizeLegacyUnverifiedTimeMapSpanEvidence(plain, {
      id: "map-1:span:0001",
      blocked: false
    });

    expect(isCompleteTimeMapSpanEvidence(migrated)).toBe(true);
    expect(migrated).toMatchObject({
      id: "map-1:span:0001",
      reason: "legacyUnverified",
      quality: {
        level: "legacy-unverified",
        metricSource: "missing",
        p99ResidualMs: null,
        leftSupport: "legacyUnverified",
        rightSupport: "legacyUnverified"
      },
      boundaries: {
        start: { status: "legacyUnverified" },
        end: { status: "legacyUnverified" }
      },
      alternatives: []
    });
  });

  it("按 matched 段的独立斜率执行整数毫秒仿射投影", () => {
    const spans: TimeMapSpan[] = [
      matched(0, 10_000, 5_000, 15_000),
      matched(10_000, 20_000, 15_000, 35_000)
    ];

    expect(mapSourceTime(spans, 5_000)).toMatchObject({
      status: "mapped",
      targetTimeMs: 10_000,
      spanIndex: 0
    });
    expect(mapSourceTime(spans, 15_000)).toMatchObject({
      status: "mapped",
      targetTimeMs: 25_000,
      spanIndex: 1
    });
  });

  it("共享边界使用右侧 matched 段，避免把 targetOnly 点当成来源区间", () => {
    const spans: TimeMapSpan[] = [
      matched(0, 10_000, 0, 10_000),
      {
        kind: "targetOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 10_000,
        targetStartMs: 10_000,
        targetEndMs: 15_000
      },
      matched(10_000, 20_000, 15_000, 25_000)
    ];

    expect(mapSourceTime(spans, 9_999)).toMatchObject({
      status: "mapped",
      targetTimeMs: 9_999
    });
    expect(mapSourceTime(spans, 10_000)).toMatchObject({
      status: "mapped",
      targetTimeMs: 15_000,
      spanIndex: 2
    });
    expect(mapSourceTime(spans, 20_000)).toEqual({
      status: "unmapped",
      sourceTimeMs: 20_000,
      reason: "afterMap"
    });
  });

  it("明确区分 sourceOnly、targetOnly 边界和 ambiguous", () => {
    const sourceOnlyMap: TimeMapSpan[] = [
      matched(0, 10_000, 0, 10_000),
      {
        kind: "sourceOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 15_000,
        targetStartMs: 10_000,
        targetEndMs: 10_000
      },
      matched(15_000, 25_000, 10_000, 20_000)
    ];
    expect(mapSourceTime(sourceOnlyMap, 12_000)).toMatchObject({
      status: "unmapped",
      reason: "sourceOnly",
      spanIndex: 1
    });
    expect(mapSourceTime(sourceOnlyMap, 15_000)).toMatchObject({
      status: "mapped",
      targetTimeMs: 10_000
    });

    const targetOnlyMap: TimeMapSpan[] = [
      {
        kind: "targetOnly",
        sourceStartMs: 0,
        sourceEndMs: 0,
        targetStartMs: 0,
        targetEndMs: 3_000
      }
    ];
    expect(mapSourceTime(targetOnlyMap, 0)).toMatchObject({
      status: "unmapped",
      reason: "targetOnlyBoundary"
    });

    const ambiguousMap: TimeMapSpan[] = [
      {
        kind: "ambiguous",
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        targetStartMs: 30_000,
        targetEndMs: 43_000
      }
    ];
    expect(mapSourceTime(ambiguousMap, 15_000)).toEqual({
      status: "ambiguous",
      sourceTimeMs: 15_000,
      reason: "ambiguousSpan",
      spanIndex: 0
    });

    expect(
      mapSourceTime(
        [
          {
            kind: "ambiguous",
            sourceStartMs: 20_000,
            sourceEndMs: 20_000,
            targetStartMs: 30_000,
            targetEndMs: 35_000
          }
        ],
        20_000
      )
    ).toMatchObject({ status: "ambiguous", reason: "ambiguousSpan" });
  });

  it("严格拒绝形状错误、重叠和未显式表示的边界空档", () => {
    const result = validateTimeMap([
      matched(0, 10_000, 0, 10_000),
      matched(9_000, 20_000, 12_000, 23_000),
      {
        kind: "sourceOnly",
        sourceStartMs: 20_000,
        sourceEndMs: 20_000,
        targetStartMs: 23_000,
        targetEndMs: 24_000
      }
    ]);

    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("测试数据应当无效。");
    }
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["sourceOverlap", "targetDiscontinuity", "invalidKindShape"])
    );
    expect(() =>
      assertValidTimeMap([
        matched(0, 10_000, 0, 10_000),
        matched(11_000, 20_000, 10_000, 19_000)
      ])
    ).toThrow(/来源轴.*空档/);
  });

  it("空映射可安全返回明确的 unmapped 原因", () => {
    expect(validateTimeMap([])).toEqual({ valid: true, issues: [] });
    expect(mapSourceTime([], 1_000)).toEqual({
      status: "unmapped",
      sourceTimeMs: 1_000,
      reason: "emptyMap"
    });
  });

  it("编译后的映射器可复用二分查找且保持零长度边界语义", () => {
    const spans: TimeMapSpan[] = [];
    for (let index = 0; index < 200; index += 1) {
      spans.push(matched(index * 1_000, (index + 1) * 1_000, index * 1_100, (index + 1) * 1_100));
    }
    const compiled = compileTimeMap(spans);

    expect(compiled.mapSourceTime(150_500)).toMatchObject({
      status: "mapped",
      targetTimeMs: 165_550,
      spanIndex: 150
    });
    expect(compiled.mapSourceTime(200_000)).toMatchObject({
      status: "unmapped",
      reason: "afterMap"
    });
    expect(compiled.spans).not.toBe(spans);
  });

  it("强压缩插值不会舍入到排他的 targetEnd", () => {
    expect(mapSourceTime([matched(0, 2, 0, 1)], 1)).toEqual({
      status: "mapped",
      sourceTimeMs: 1,
      targetTimeMs: 0,
      spanIndex: 0
    });
  });

  it("零来源长度 ambiguous 点优先于同边界右侧 matched", () => {
    const spans: TimeMapSpan[] = [
      matched(0, 10, 0, 10),
      {
        kind: "ambiguous",
        sourceStartMs: 10,
        sourceEndMs: 10,
        targetStartMs: 10,
        targetEndMs: 20
      },
      matched(10, 20, 20, 30)
    ];

    expect(mapSourceTime(spans, 10)).toEqual({
      status: "ambiguous",
      sourceTimeMs: 10,
      reason: "ambiguousSpan",
      spanIndex: 1
    });
  });
});

describe("旧 timingRules 迁移", () => {
  it("把正 gap 迁移为 targetOnly 并保持旧投影结果", () => {
    const timingRules: LegacyTimingRuleInput[] = [
      { sourceAtMs: 40_000, gapMs: 5_000 },
      { sourceAtMs: 60_000, gapMs: 3_000 }
    ];
    const result = migrateLegacyTimeMap({
      sourceStartMs: 10_000,
      sourceEndMs: 80_000,
      targetStartMs: 30_000,
      timingRules
    });

    expect(result.status).toBe("migrated");
    expect(result.spans.map((span) => span.kind)).toEqual([
      "matched",
      "targetOnly",
      "matched",
      "targetOnly",
      "matched"
    ]);
    for (const sourceTimeMs of [10_000, 39_999, 40_000, 59_999, 60_000, 79_999]) {
      const mapped = mapSourceTime(result.spans, sourceTimeMs);
      expect(mapped.status).toBe("mapped");
      if (mapped.status !== "mapped") {
        throw new Error("正 gap 迁移后应保持可投影。 ");
      }
      expect(mapped.targetTimeMs).toBe(
        legacyProjection(sourceTimeMs, 10_000, 30_000, timingRules)
      );
    }
  });

  it("同一边界的多个正 gap 确定性合并，零 gap 仅产生提示", () => {
    const result = migrateLegacyTimeMap({
      sourceStartMs: 0,
      sourceEndMs: 20_000,
      targetStartMs: 0,
      timingRules: [
        { sourceAtMs: 10_000, gapMs: 2_000 },
        { sourceAtMs: 10_000, gapMs: 0 },
        { sourceAtMs: 10_000, gapMs: 3_000 }
      ]
    });

    expect(result.status).toBe("migrated");
    expect(result.spans[1]).toEqual({
      kind: "targetOnly",
      sourceStartMs: 10_000,
      sourceEndMs: 10_000,
      targetStartMs: 10_000,
      targetEndMs: 15_000
    });
    expect(result.issues).toMatchObject([{ code: "zeroGapIgnored", severity: "warning" }]);
  });

  it("负 gap 不猜测 sourceOnly 边界，而是阻断并标记受影响余段", () => {
    const result = migrateLegacyTimeMap({
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 30_000,
      timingRules: [{ sourceAtMs: 40_000, gapMs: -5_000 }]
    });

    expect(result.status).toBe("blocked");
    expect(result.issues).toMatchObject([{ code: "negativeGap", severity: "error" }]);
    expect(result.spans).toEqual([
      matched(10_000, 40_000, 30_000, 60_000),
      {
        kind: "ambiguous",
        sourceStartMs: 40_000,
        sourceEndMs: 70_000,
        targetStartMs: 60_000,
        targetEndMs: 60_000
      }
    ]);
    expect(mapSourceTime(result.spans, 39_999).status).toBe("mapped");
    expect(mapSourceTime(result.spans, 40_000)).toMatchObject({
      status: "ambiguous",
      reason: "ambiguousSpan"
    });
  });
});

describe("时间映射质量门槛", () => {
  const excellentMetrics = {
    probability: 0.999,
    coverage: 0.97,
    uniqueContentCoverage: 0.9,
    p50ResidualMs: 30,
    p95ResidualMs: 70,
    p99ResidualMs: 100,
    maxResidualMs: 130,
    boundaryUncertaintyMs: 180,
    alternativeMargin: 0.35,
    anchorCount: 40,
    anchorRegionCount: 3,
    heldOutAnchorCount: 8,
    audioAnchorCount: 32,
    visualAnchorCount: 8,
    evidenceHeldOutAnchorCount: 8,
    sourceStreamType: "audio",
    targetStreamType: "audio"
  } as const;

  it("只有完整实测指标和独立证据才能得到 verified", () => {
    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        metricSource: "measured",
        evidenceTypes: ["audio", "visual"]
      }).level
    ).toBe("verified");

    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        metricSource: "estimated",
        evidenceTypes: ["audio", "visual"]
      }).level
    ).toBe("review");

    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        metricSource: "measured",
        evidenceTypes: ["audio"]
      }).level
    ).toBe("review");

    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        p99ResidualMs: 501,
        maxResidualMs: 600,
        metricSource: "measured",
        evidenceTypes: ["audio", "visual"]
      }).level
    ).toBe("review");
  });

  it("缺失真实指标只能 review，弱证据或灾难性指标会 blocked", () => {
    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        coverage: 0.95,
        p95ResidualMs: null,
        boundaryUncertaintyMs: 100,
        alternativeMargin: 0.4,
        metricSource: "missing",
        evidenceTypes: ["audio", "visual"]
      })
    ).toMatchObject({ level: "review", hasCompleteMetrics: false });

    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        metricSource: "measured",
        evidenceTypes: ["danmaku"]
      }).level
    ).toBe("blocked");

    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        coverage: 0.8,
        p95ResidualMs: 2_500,
        boundaryUncertaintyMs: 500,
        alternativeMargin: 0.2,
        metricSource: "measured",
        evidenceTypes: ["audio", "visual"]
      }).level
    ).toBe("blocked");

    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        coverage: 0.1,
        p95ResidualMs: null,
        boundaryUncertaintyMs: null,
        alternativeMargin: null,
        metricSource: "missing",
        evidenceTypes: ["audio"]
      }).level
    ).toBe("blocked");
  });

  it("中央重算会降级夸大的 verified，且不会升级保守的 review", () => {
    const overclaimed = reconcileTimeMapQualityClaim(
      "verified",
      ["外部声称已验证"],
      { ...excellentMetrics, probability: 0.99, metricSource: "measured", evidenceTypes: ["audio", "visual"] }
    );
    expect(overclaimed.level).toBe("review");
    expect(overclaimed.reasons.join(" ")).toContain("已降级");

    const conservative = reconcileTimeMapQualityClaim(
      "review",
      ["请求人工复核"],
      { ...excellentMetrics, metricSource: "measured", evidenceTypes: ["audio", "visual"] }
    );
    expect(conservative.level).toBe("review");
    expect(conservative.assessment.level).toBe("verified");
  });

  it("音画证据缺少对应流身份或正锚点时不能 verified", () => {
    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        visualAnchorCount: 0,
        metricSource: "measured",
        evidenceTypes: ["audio", "visual"]
      })
    ).toMatchObject({ level: "review" });
    expect(
      assessTimeMapQuality({
        ...excellentMetrics,
        sourceStreamType: null,
        targetStreamType: null,
        metricSource: "measured",
        evidenceTypes: ["audio", "visual"]
      })
    ).toMatchObject({ level: "review" });
  });
});

function matched(
  sourceStartMs: number,
  sourceEndMs: number,
  targetStartMs: number,
  targetEndMs: number
): TimeMapSpan {
  return { kind: "matched", sourceStartMs, sourceEndMs, targetStartMs, targetEndMs };
}

function legacyProjection(
  sourceTimeMs: number,
  sourceStartMs: number,
  targetStartMs: number,
  timingRules: readonly LegacyTimingRuleInput[]
): number {
  return (
    sourceTimeMs -
    sourceStartMs +
    targetStartMs +
    timingRules
      .filter((rule) => sourceTimeMs >= rule.sourceAtMs)
      .reduce((sum, rule) => sum + rule.gapMs, 0)
  );
}
