import { describe, expect, it } from "vitest";
import { isAlignmentProposal, parseAlignmentProposal } from "./manualProvider";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";

describe("manual alignment provider", () => {
  it("解析合法的手动对齐提案", () => {
    const proposal = parseAlignmentProposal(
      JSON.stringify({
        anchors: [{ id: "anchor-1", sourceMs: 1000, targetMs: 1200, origin: "manual", confidence: 0.9 }],
        cutCandidates: [
          {
            id: "cut-1",
            name: "片头差异",
            sourceAtMs: 30_000,
            sourceRangeStartMs: 28_000,
            sourceRangeEndMs: 32_000,
            targetGapMs: 45_000,
            confidence: 0.8,
            note: "完整版多出片头"
          }
        ],
        confidence: 0.85,
        diagnostics: ["手动标注"],
        matchRange: {
          sourceStartMs: 500_000,
          sourceEndMs: 620_000,
          targetStartMs: 0,
          targetEndMs: 120_000,
          coverage: 0.95
        }
      })
    );

    expect(proposal.anchors).toHaveLength(1);
    expect(proposal.cutCandidates[0]?.sourceRangeStartMs).toBe(28_000);
    expect(proposal.cutCandidates[0]?.targetGapMs).toBe(45_000);
    expect(proposal.matchRange?.sourceStartMs).toBe(500_000);
    expect(proposal.matchRange?.coverage).toBe(0.95);
  });

  it("拒绝字段缺失的候选删减点", () => {
    expect(() =>
      parseAlignmentProposal(
        JSON.stringify({
          anchors: [],
          cutCandidates: [{ id: "cut-1", sourceAtMs: 30_000, targetGapMs: 45_000 }],
          confidence: 0.8,
          diagnostics: []
        })
      )
    ).toThrow("对齐提案 JSON 格式不正确。");
  });

  it("公开同一领域 guard 并拒绝空对象与畸形 evidence profile", () => {
    const valid = {
      anchors: [],
      cutCandidates: [],
      confidence: 0.8,
      diagnostics: []
    };

    expect(isAlignmentProposal(valid)).toBe(true);
    expect(isAlignmentProposal({})).toBe(false);
    expect(
      isAlignmentProposal({
        ...valid,
        evidenceProfile: {
          version: "alignment-evidence-profile-v2",
          windowMs: 1_000,
          samples: [{}]
        }
      })
    ).toBe(false);
  });

  it("对 anchor 与 cut 的毫秒和置信度执行 fail-closed 校验", () => {
    const anchor = {
      id: "anchor-1",
      sourceMs: 1_000,
      targetMs: 2_000,
      origin: "automatic" as const,
      confidence: 0.9
    };
    const cut = {
      id: "cut-1",
      name: "版本差异",
      sourceAtMs: 3_000,
      sourceRangeStartMs: 2_500,
      sourceRangeEndMs: 3_500,
      targetGapMs: -500,
      confidence: 0.8,
      note: "目标时间轴较短"
    };
    const proposal = {
      anchors: [anchor],
      cutCandidates: [cut],
      confidence: 0.8,
      diagnostics: []
    };

    expect(isAlignmentProposal(proposal)).toBe(true);
    expect(
      isAlignmentProposal({ ...proposal, anchors: [{ ...anchor, sourceMs: -1 }] })
    ).toBe(false);
    expect(
      isAlignmentProposal({ ...proposal, anchors: [{ ...anchor, targetMs: 1.5 }] })
    ).toBe(false);
    expect(
      isAlignmentProposal({ ...proposal, anchors: [{ ...anchor, confidence: 1.01 }] })
    ).toBe(false);
    expect(
      isAlignmentProposal({
        ...proposal,
        cutCandidates: [{ ...cut, sourceRangeStartMs: -1 }]
      })
    ).toBe(false);
    expect(
      isAlignmentProposal({ ...proposal, cutCandidates: [{ ...cut, sourceAtMs: 1.5 }] })
    ).toBe(false);
    expect(
      isAlignmentProposal({ ...proposal, cutCandidates: [{ ...cut, targetGapMs: 0.5 }] })
    ).toBe(false);
    expect(
      isAlignmentProposal({ ...proposal, cutCandidates: [{ ...cut, confidence: -0.01 }] })
    ).toBe(false);
  });

  it("拒绝无效的定位范围", () => {
    expect(() =>
      parseAlignmentProposal(
        JSON.stringify({
          anchors: [],
          cutCandidates: [],
          confidence: 0.8,
          diagnostics: [],
          matchRange: {
            sourceStartMs: 620_000,
            sourceEndMs: 500_000,
            targetStartMs: 0,
            targetEndMs: 120_000,
            coverage: 1.2
          }
        })
      )
    ).toThrow("对齐提案 JSON 格式不正确。");
  });

  it("严格校验 Alignment V2 的分段时间图快照", () => {
    const proposal = createTimeMapProposal();
    expect(parseAlignmentProposal(JSON.stringify(proposal)).timeMap).toMatchObject({
      engineVersion: "alignment-v2-test",
      evidence: {
        uniqueContentCoverage: 0.82,
        repeatedContentOnly: true
      },
      quality: { level: "review" },
      spans: [{ kind: "matched" }, { kind: "targetOnly" }, { kind: "matched" }]
    });

    const invalid = createTimeMapProposal();
    if (!invalid.timeMap) {
      throw new Error("测试提案缺少时间图。");
    }
    invalid.timeMap.spans[2].targetStartMs = 11_000;
    expect(() => parseAlignmentProposal(JSON.stringify(invalid))).toThrow(
      "对齐提案 JSON 格式不正确。"
    );
  });
});

function createTimeMapProposal() {
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.7,
    diagnostics: ["候选时间图"],
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 20_000,
      targetStartMs: 0,
      targetEndMs: 25_000,
      coverage: 0.9
    },
    timeMap: {
      sourceStartMs: 0,
      sourceEndMs: 20_000,
      targetStartMs: 0,
      targetEndMs: 25_000,
      spans: [
        createTestCompleteTimeMapSpan({
          kind: "matched" as const,
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }, "manual:span:0001"),
        createTestCompleteTimeMapSpan({
          kind: "targetOnly" as const,
          sourceStartMs: 10_000,
          sourceEndMs: 10_000,
          targetStartMs: 10_000,
          targetEndMs: 15_000
        }, "manual:span:0002"),
        createTestCompleteTimeMapSpan({
          kind: "matched" as const,
          sourceStartMs: 10_000,
          sourceEndMs: 20_000,
          targetStartMs: 15_000,
          targetEndMs: 25_000
        }, "manual:span:0003")
      ],
      quality: {
        level: "review" as const,
        probability: null,
        metricSource: "measured" as const,
        coverage: 0.9,
        uniqueContentCoverage: 0.82,
        p50ResidualMs: 30,
        p95ResidualMs: 80,
        p99ResidualMs: 100,
        maxResidualMs: 120,
        boundaryUncertaintyMs: 200,
        alternativeMargin: 0.2,
        anchorCount: 20,
        anchorRegionCount: 3,
        heldOutAnchorCount: 4,
        reasons: ["尚未通过真实冻结基准。"]
      },
      evidence: {
        types: ["audio" as const],
        audioAnchorCount: 20,
        visualAnchorCount: 0,
        heldOutAnchorCount: 4,
        top1Top2Margin: 0.2,
        uniqueContentCoverage: 0.82,
        repeatedContentOnly: true,
        selectedTrackReason: "测试轨道排序。",
        alternativeTrackScores: [],
        notes: []
      },
      sourceStream: null,
      targetStream: null,
      engineVersion: "alignment-v2-test",
      featureVersion: "landmark-v1",
      parametersHash: "test-parameters"
    }
  };
}
