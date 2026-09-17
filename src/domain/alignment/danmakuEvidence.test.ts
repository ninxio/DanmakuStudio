import { describe, expect, it } from "vitest";
import type { SuspectedCutCandidate } from "../danmaku/cutHints";
import type { DanmakuAsset } from "../danmaku/types";
import { augmentAlignmentProposalWithDanmakuEvidence } from "./danmakuEvidence";
import type { AlignmentProposal } from "./types";

describe("弹幕证据融合", () => {
  it("没有 XML 弹幕时保持未参与状态", () => {
    const proposal = createProposal();

    const augmented = augmentAlignmentProposalWithDanmakuEvidence(proposal, {
      assets: [],
      suspectedCutCandidates: []
    });

    expect(augmented.evidence?.signals?.find((signal) => signal.kind === "danmaku")).toMatchObject({
      status: "notConfigured",
      observations: 0,
      weight: 0
    });
    expect(augmented.cutCandidates[0].confidence).toBe(0.72);
  });

  it("相邻弹幕文本聚类会支持候选版本差异", () => {
    const proposal = createProposal();

    const augmented = augmentAlignmentProposalWithDanmakuEvidence(proposal, {
      assets: [createAsset()],
      suspectedCutCandidates: [createSuspectedCut(20_500), createSuspectedCut(120_000)]
    });

    expect(augmented.cutCandidates[0].confidence).toBeCloseTo(0.75);
    expect(augmented.cutCandidates[0].note).toContain("弹幕文本线索");
    expect(augmented.diagnostics).toContain("弹幕证据：1 个文本聚类支持 1 个候选版本差异。");
    expect(augmented.evidence?.signals?.find((signal) => signal.kind === "danmaku")).toMatchObject({
      status: "used",
      observations: 2,
      weight: 0.2
    });
  });
});

function createProposal(): AlignmentProposal {
  return {
    anchors: [],
    cutCandidates: [
      {
        id: "audio-gap-1",
        name: "音频时间映射差异 1",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 18_000,
        sourceRangeEndMs: 22_000,
        targetGapMs: 20_000,
        confidence: 0.72,
        note: "音频候选"
      }
    ],
    confidence: 0.8,
    diagnostics: [],
    evidence: {
      algorithm: "time-map-audio",
      completeFingerprintCount: 10,
      sourceFingerprintCount: 8,
      fingerprintMatchCount: 8,
      monotonicMatchCount: 8,
      strongAnchorCount: 6,
      weakAnchorCount: 2,
      offsetClusterCount: 2,
      refinedCandidateCount: 1,
      lowConfidenceRegionCount: 0,
      quality: "medium",
      timeMappingSegmentCount: 2,
      confirmedChangeCount: 1,
      signals: [
        {
          kind: "audio",
          status: "used",
          label: "音频时间映射",
          observations: 8,
          weight: 1,
          note: "音频支持"
        },
        {
          kind: "danmaku",
          status: "notConfigured",
          label: "弹幕文本线索",
          observations: 0,
          weight: 0,
          note: "未参与"
        }
      ]
    }
  };
}

function createAsset(): DanmakuAsset {
  return {
    id: "asset-1",
    name: "asset",
    fileName: "asset.xml",
    color: "#fff",
    warnings: [],
    importedAt: "2026-07-11T00:00:00.000Z",
    sourceReceipt: null,
    items: [
      {
        id: "item-1",
        assetId: "asset-1",
        originalIndex: 0,
        sourceTimeMs: 20_000,
        mode: null,
        fontSize: null,
        color: null,
        timestamp: null,
        pool: null,
        userHash: null,
        rowId: null,
        text: "这里是不是删了一段",
        rawPFields: [],
        enabled: true
      }
    ]
  };
}

function createSuspectedCut(sourceAtMs: number): SuspectedCutCandidate {
  return {
    id: `hint-${sourceAtMs}`,
    assetId: "asset-1",
    assetFileName: "asset.xml",
    sourceAtMs,
    startMs: sourceAtMs - 1000,
    endMs: sourceAtMs + 1000,
    hitCount: 2,
    score: 6,
    confidence: "medium",
    keywords: ["删了"],
    sampleTexts: ["这里是不是删了一段"],
    itemIds: ["item-1"]
  };
}
