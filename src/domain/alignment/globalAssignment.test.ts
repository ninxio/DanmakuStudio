import { describe, expect, it } from "vitest";
import { assignGlobalMediaMatches, type GlobalMatchHypothesis } from "./globalAssignment";

describe("项目级多媒体全局分配", () => {
  it("一条长参考可按不重叠区间分配给多个目标原片（1→N）", () => {
    const result = assignGlobalMediaMatches([
      hypothesis("s1-t1", "source", "target-1", 0, 60_000, 0, 62_000, 0.95),
      hypothesis("s1-t2", "source", "target-2", 70_000, 130_000, 0, 61_000, 0.92),
      hypothesis("wrong", "source", "target-2", 0, 60_000, 0, 61_000, 0.7)
    ]);

    expect(result.selectedIds).toEqual(["s1-t1", "s1-t2"]);
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ id: "wrong", reason: "sourceOverlap" })
    );
  });

  it("多条参考可落到同一目标的不重叠部分，重叠重复关系只能选一条（N→1）", () => {
    const result = assignGlobalMediaMatches([
      hypothesis("part-a", "source-a", "target", 0, 50_000, 0, 50_000, 0.9),
      hypothesis("part-b", "source-b", "target", 0, 40_000, 55_000, 95_000, 0.88),
      hypothesis("duplicate", "source-c", "target", 0, 50_000, 0, 50_000, 0.6)
    ]);

    expect(result.selectedIds).toEqual(["part-a", "part-b"]);
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ id: "duplicate", reason: "targetOverlap" })
    );
  });

  it("近似等价的重复片头组合会报告全局歧义，而不是假装唯一", () => {
    const result = assignGlobalMediaMatches(
      [
        hypothesis("option-a", "source-a", "target", 0, 60_000, 0, 60_000, 0.9),
        hypothesis("option-b", "source-b", "target", 0, 60_000, 0, 60_000, 0.895)
      ],
      { ambiguityMargin: 0.05 }
    );

    expect(result.ambiguous).toBe(true);
    expect(result.normalizedMargin).toBeLessThan(0.05);
    expect(result.selectedIds).toHaveLength(1);
  });

  it("同一素材 pair 的 Top-K 区间即使不重叠也只能采用一个", () => {
    const result = assignGlobalMediaMatches([
      {
        ...hypothesis("pair-top-1", "source", "target", 0, 60_000, 0, 60_000, 0.95),
        alternativeGroupId: "source:target"
      },
      {
        ...hypothesis(
          "pair-top-2",
          "source",
          "target",
          120_000,
          180_000,
          120_000,
          180_000,
          0.8
        ),
        alternativeGroupId: "source:target"
      }
    ]);

    expect(result.selectedIds).toEqual(["pair-top-1"]);
    expect(result.rejected).toContainEqual({
      id: "pair-top-2",
      reason: "samePairAlternative",
      conflictsWith: ["pair-top-1"]
    });
  });

  it("重复内容和已阻断候选不会挤掉独特内容证据", () => {
    const result = assignGlobalMediaMatches([
      {
        ...hypothesis("unique", "source-a", "target", 0, 60_000, 0, 60_000, 0.78),
        uniqueCoverage: 0.95,
        alternativeMargin: 0.4
      },
      {
        ...hypothesis("opening-only", "source-b", "target", 0, 60_000, 0, 60_000, 0.98),
        uniqueCoverage: 0.05,
        alternativeMargin: 0.01,
        repeatedContentOnly: true
      },
      {
        ...hypothesis("blocked", "source-c", "target-2", 0, 60_000, 0, 60_000, 1),
        blocked: true
      }
    ]);

    expect(result.selectedIds).toEqual(["unique"]);
    expect(result.rejected).toContainEqual(
      expect.objectContaining({ id: "blocked", reason: "blocked" })
    );
  });

  it("候选规模超过上限时用确定性 beam 保留全部独立关系", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      hypothesis(
        `candidate-${index}`,
        "source",
        `target-${index}`,
        index * 70_000,
        index * 70_000 + 60_000,
        0,
        60_000,
        0.8
      )
    );
    const result = assignGlobalMediaMatches(candidates, { exactSearchLimit: 4 });

    expect(result.exact).toBe(false);
    expect(result.selectedIds).toHaveLength(8);
    expect(result.runnerUpScore).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it("超过精确搜索上限时仍把并列的冲突组合标为歧义", () => {
    const independent = Array.from({ length: 18 }, (_, index) =>
      hypothesis(
        `independent-${index}`,
        `source-${index}`,
        `target-${index}`,
        0,
        60_000,
        0,
        60_000,
        0.8
      )
    );
    const alternatives = [
      hypothesis("tie-a", "tie-source-a", "shared-target", 0, 60_000, 0, 60_000, 0.9),
      hypothesis("tie-b", "tie-source-b", "shared-target", 0, 60_000, 0, 60_000, 0.9)
    ];

    const result = assignGlobalMediaMatches([...independent, ...alternatives], {
      exactSearchLimit: 18
    });

    expect(result.exact).toBe(false);
    expect(result.selectedIds.filter((id) => id.startsWith("tie-"))).toHaveLength(1);
    expect(result.runnerUpScore).toBe(result.score);
    expect(result.runnerUpIds).not.toBeNull();
    expect(
      independent.every((candidate) => result.runnerUpIds?.includes(candidate.id))
    ).toBe(true);
    expect(result.normalizedMargin).toBe(0);
    expect(result.ambiguous).toBe(true);
  });

  it("互不冲突的独立关系不会把少选一条误当成关系歧义", () => {
    const candidates = Array.from({ length: 13 }, (_, index) =>
      hypothesis(
        `independent-${index}`,
        `source-${index}`,
        `target-${index}`,
        0,
        60_000,
        0,
        60_000,
        0.8
      )
    );

    const result = assignGlobalMediaMatches(candidates);

    expect(result.exact).toBe(true);
    expect(result.selectedIds).toHaveLength(13);
    expect(result.runnerUpScore).toBeNull();
    expect(result.normalizedMargin).toBe(1);
    expect(result.ambiguous).toBe(false);
  });

  it("近似搜索会忽略零增益尾项，不阻断已经选中的独立强关系", () => {
    const strong = Array.from({ length: 18 }, (_, index) =>
      hypothesis(
        `strong-${index}`,
        `source-${index}`,
        `target-${index}`,
        0,
        60_000,
        0,
        60_000,
        1
      )
    );
    const zeroGain = {
      ...hypothesis("zero-gain", "source-zero", "target-zero", 0, 60_000, 0, 60_000, 0),
      uniqueCoverage: 0,
      alternativeMargin: 0
    };

    const result = assignGlobalMediaMatches([...strong, zeroGain], {
      exactSearchLimit: 18
    });

    expect(result.exact).toBe(false);
    expect(result.selectedIds).toHaveLength(18);
    expect(result.selectedIds).not.toContain("zero-gain");
    expect(result.runnerUpIds).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it("精确搜索同样忽略零增益尾项", () => {
    const zeroGain = {
      ...hypothesis("zero", "source-zero", "target-zero", 0, 60_000, 0, 60_000, 0),
      uniqueCoverage: 0,
      alternativeMargin: 0
    };

    const result = assignGlobalMediaMatches([
      hypothesis("strong", "source-strong", "target-strong", 0, 60_000, 0, 60_000, 1),
      zeroGain
    ]);

    expect(result.exact).toBe(true);
    expect(result.selectedIds).toEqual(["strong"]);
    expect(result.runnerUpIds).toBeNull();
    expect(result.ambiguous).toBe(false);
  });

  it("规范化后重复的候选 ID 会直接拒绝", () => {
    expect(() =>
      assignGlobalMediaMatches([
        hypothesis("duplicate", "source-a", "target-a", 0, 60_000, 0, 60_000, 0.9),
        hypothesis(" duplicate ", "source-b", "target-b", 0, 60_000, 0, 60_000, 0.8)
      ])
    ).toThrow("规范化后必须唯一");
  });
});

function hypothesis(
  id: string,
  sourceMediaId: string,
  targetMediaId: string,
  sourceStartMs: number,
  sourceEndMs: number,
  targetStartMs: number,
  targetEndMs: number,
  score: number
): GlobalMatchHypothesis {
  return {
    id,
    sourceMediaId,
    targetMediaId,
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs,
    score,
    uniqueCoverage: 0.8,
    alternativeMargin: 0.2
  };
}
