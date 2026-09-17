import { describe, expect, it } from "vitest";
import {
  alignAudioFeatureSequences,
  alignSparseAudioFeatureSequences,
  createAudioAlignmentProposal,
  inferAudioCutCandidates,
  type AudioFeatureFrame
} from "./audioAlignment";

describe("音频特征对齐", () => {
  it("从完整版和当前视频特征序列中推断缺失段", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const source = createFrames([0.1, 0.2, 0.5, 0.6]);

    const proposal = createAudioAlignmentProposal(complete, source, {
      matchThreshold: 0.01,
      minGapMs: 1000,
      anchorStride: 1
    });

    expect(proposal.cutCandidates).toHaveLength(1);
    expect(proposal.cutCandidates[0]).toMatchObject({
      sourceAtMs: 15_000,
      sourceRangeStartMs: 10_000,
      sourceRangeEndMs: 20_000,
      targetGapMs: 20_000
    });
    expect(proposal.anchors.map((anchor) => [anchor.sourceMs, anchor.targetMs])).toEqual([
      [0, 0],
      [10_000, 10_000],
      [20_000, 40_000],
      [30_000, 50_000]
    ]);
    expect(proposal.evidence).toMatchObject({
      algorithm: "sparse-fingerprint",
      fingerprintMatchCount: 4,
      monotonicMatchCount: 4,
      refinedCandidateCount: 1
    });
    expect(proposal.diagnostics.join("\n")).toContain("稀疏音频指纹");
  });

  it("稀疏路径可在低 maxCells 下避开密集 DP 爆炸", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    const source = createFrames([0.1, 0.2, 0.5, 0.6]);

    const proposal = createAudioAlignmentProposal(complete, source, {
      matchThreshold: 0.01,
      minGapMs: 1000,
      maxCells: 1,
      anchorStride: 1
    });

    expect(proposal.cutCandidates).toHaveLength(1);
    expect(proposal.evidence?.algorithm).toBe("sparse-fingerprint");
  });

  it("公开的稀疏锚点匹配会输出单调路径", () => {
    const matches = alignSparseAudioFeatureSequences(
      createFrames([0.1, 0.2, 0.3, 0.4, 0.5]),
      createFrames([0.1, 0.2, 0.5]),
      { matchThreshold: 0.01 }
    );

    expect(matches.map((match) => [match.sourceTimeMs, match.completeTimeMs])).toEqual([
      [0, 0],
      [10_000, 10_000],
      [20_000, 40_000]
    ]);
  });

  it("音频时间映射在长视频样本中只把持续 offset 阶跃识别为版本差异", () => {
    const complete = createPatternFrames(120);
    const source = [...complete.slice(0, 30), ...complete.slice(50)].map((frame, index) => ({
      timeMs: index * 1000,
      values: frame.values
    }));

    const proposal = createAudioAlignmentProposal(complete, source, {
      matchThreshold: 0.35,
      minGapMs: 3000,
      anchorStride: 12
    });

    expect(proposal.evidence?.algorithm).toBe("time-map-audio");
    expect(proposal.evidence?.timeMappingSegmentCount).toBe(2);
    expect(proposal.evidence?.confirmedChangeCount).toBe(1);
    expect(proposal.cutCandidates).toHaveLength(1);
    expect(proposal.cutCandidates[0].targetGapMs).toBe(20_000);
    expect(proposal.cutCandidates[0].sourceAtMs).toBeGreaterThanOrEqual(24_000);
    expect(proposal.cutCandidates[0].sourceAtMs).toBeLessThanOrEqual(36_000);
    expect(proposal.diagnostics.join("\n")).toContain("时间映射：确认 1 个持续阶跃变点");
  });

  it("短暂误配到后方片段时不会把整段时间轴错误平移", () => {
    const complete = createPatternFrames(180);
    const source = complete.map((frame, index) => ({
      timeMs: index * 1000,
      values: index >= 60 && index < 70 ? complete[index + 20].values : frame.values
    }));

    const proposal = createAudioAlignmentProposal(complete, source, {
      matchThreshold: 0.35,
      minGapMs: 3000,
      anchorStride: 12
    });

    expect(proposal.evidence?.algorithm).toBe("time-map-audio");
    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.evidence?.confirmedChangeCount).toBe(0);
  });

  it("相同序列不产生缺失段", () => {
    const complete = createFrames([0.1, 0.2, 0.3, 0.4]);
    const source = createFrames([0.1, 0.2, 0.3, 0.4]);

    const proposal = createAudioAlignmentProposal(complete, source, { matchThreshold: 0.01 });

    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.confidence).toBe(1);
  });

  it("匹配路径中的完整版额外跨度会变成候选版本差异", () => {
    const matches = alignAudioFeatureSequences(
      createFrames([0.1, 0.2, 0.3, 0.4, 0.5]),
      createFrames([0.1, 0.2, 0.5]),
      { matchThreshold: 0.01 }
    );

    const candidates = inferAudioCutCandidates(matches, { matchThreshold: 0.01, minGapMs: 1000 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceAtMs).toBe(15_000);
    expect(candidates[0].targetGapMs).toBe(20_000);
    expect(candidates[0].note).toContain("候选边界约在当前视频 0:15");
  });

  it("空特征序列返回诊断而不是抛错", () => {
    const proposal = createAudioAlignmentProposal([], createFrames([0.1]));

    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.diagnostics[0]).toContain("音频特征为空");
  });
});

function createFrames(values: number[]): AudioFeatureFrame[] {
  return values.map((value, index) => ({
    timeMs: index * 10_000,
    values: [value]
  }));
}

function createPatternFrames(count: number): AudioFeatureFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    timeMs: index * 1000,
    values: [
      0.5 + Math.sin(index * 0.37) * 0.25,
      0.5 + Math.cos(index * 0.19) * 0.2,
      0.5 + Math.sin(index * 0.11 + 0.4) * 0.18
    ]
  }));
}
