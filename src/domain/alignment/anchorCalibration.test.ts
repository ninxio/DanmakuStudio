import { describe, expect, it } from "vitest";
import {
  createAnchorCalibrationProposal,
  inferCutCandidatesFromAnchors,
  parseAnchorCalibrationText
} from "./anchorCalibration";

describe("锚点校准", () => {
  it("解析当前视频时间到完整版时间的锚点文本", () => {
    const parsed = parseAnchorCalibrationText("00:10 -> 00:10\n01:20.500 -> 01:30.500");

    expect(parsed.warnings).toEqual([]);
    expect(parsed.anchors).toHaveLength(2);
    expect(parsed.anchors[0]).toMatchObject({ sourceMs: 10_000, targetMs: 10_000, origin: "manual" });
    expect(parsed.anchors[1]).toMatchObject({ sourceMs: 80_500, targetMs: 90_500, origin: "manual" });
  });

  it("根据相邻锚点的累计差值变化推断缺失时长", () => {
    const candidates = inferCutCandidatesFromAnchors([
      { id: "a1", sourceMs: 10_000, targetMs: 10_000, origin: "manual" },
      { id: "a2", sourceMs: 20_000, targetMs: 30_000, origin: "manual" },
      { id: "a3", sourceMs: 40_000, targetMs: 70_000, origin: "manual" }
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.sourceAtMs)).toEqual([20_000, 40_000]);
    expect(candidates.map((candidate) => candidate.targetGapMs)).toEqual([10_000, 20_000]);
  });

  it("忽略小于阈值的累计差值变化", () => {
    const proposal = createAnchorCalibrationProposal("00:10 -> 00:10\n00:20 -> 00:20.500");

    expect(proposal.anchors).toHaveLength(2);
    expect(proposal.cutCandidates).toEqual([]);
    expect(proposal.diagnostics.join(" ")).toContain("新增缺失时长");
  });

  it("保留无法解析行的警告", () => {
    const proposal = createAnchorCalibrationProposal("bad line\n00:10 -> 00:20");

    expect(proposal.anchors).toHaveLength(1);
    expect(proposal.diagnostics[0]).toContain("第 1 行");
    expect(proposal.diagnostics.join(" ")).toContain("至少需要两个锚点");
  });
});
