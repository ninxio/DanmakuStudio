import { describe, expect, it } from "vitest";
import type { AlignmentProposal } from "./types";
import { buildAlignmentPreview } from "./preview";
import { createEmptyProject } from "../project/factory";

describe("alignment preview", () => {
  it("在没有对齐提案时只返回项目已有锚点", () => {
    const project = {
      ...createEmptyProject(),
      syncAnchors: [
        { id: "anchor-b", sourceMs: 2000, targetMs: 2500, origin: "manual" as const },
        { id: "anchor-a", sourceMs: 1000, targetMs: 1200, origin: "manual" as const }
      ]
    };

    const preview = buildAlignmentPreview(project, null);

    expect(preview.projectAnchors.map((anchor) => anchor.id)).toEqual(["anchor-a", "anchor-b"]);
    expect(preview.proposalAnchors).toEqual([]);
    expect(preview.proposalCuts).toEqual([]);
    expect(preview.summary).toEqual({
      proposalAnchorCount: 0,
      proposalCutCount: 0,
      candidateAnchorCount: 0,
      candidateCutCount: 0,
      appliedAnchorCount: 0,
      appliedCutCount: 0
    });
  });

  it("区分待应用和已应用的锚点与删减候选", () => {
    const project = {
      ...createEmptyProject(),
      syncAnchors: [{ id: "anchor-existing", sourceMs: 10_000, targetMs: 12_000, origin: "manual" as const }],
      cutMarkers: [
        { id: "cut-existing", name: "已有删减点", sourceAtMs: 30_000, targetGapMs: 45_000, note: "" }
      ]
    };
    const proposal: AlignmentProposal = {
      anchors: [
        { id: "anchor-new", sourceMs: 20_000, targetMs: 22_000, origin: "automatic", confidence: 0.86 },
        { id: "anchor-existing", sourceMs: 10_000, targetMs: 12_000, origin: "automatic", confidence: 0.99 },
        { id: "anchor-existing", sourceMs: 12_000, targetMs: 14_000, origin: "automatic", confidence: 0.7 }
      ],
      cutCandidates: [
        {
          id: "cut-new",
          name: "候选删减点",
          sourceAtMs: 60_000,
          sourceRangeStartMs: 58_000,
          sourceRangeEndMs: 62_000,
          targetGapMs: 15_000,
          confidence: 0.78,
          note: "候选"
        },
        {
          id: "cut-existing",
          name: "已有删减点",
          sourceAtMs: 30_000,
          targetGapMs: 45_000,
          confidence: 0.95,
          note: "已应用"
        },
        {
          id: "cut-existing",
          name: "同 ID 不同时间",
          sourceAtMs: 33_000,
          targetGapMs: 12_000,
          confidence: 0.7,
          note: "冲突候选"
        }
      ],
      confidence: 0.8,
      diagnostics: []
    };

    const preview = buildAlignmentPreview(project, proposal);

    expect(preview.proposalAnchors.map((anchor) => [anchor.id, anchor.state])).toEqual([
      ["anchor-existing", "applied"],
      ["anchor-existing", "candidate"],
      ["anchor-new", "candidate"]
    ]);
    expect(preview.proposalCuts.map((candidate) => [candidate.id, candidate.state])).toEqual([
      ["cut-existing", "applied"],
      ["cut-existing", "candidate"],
      ["cut-new", "candidate"]
    ]);
    expect(preview.proposalCuts.find((candidate) => candidate.id === "cut-new")).toMatchObject({
      sourceRangeStartMs: 58_000,
      sourceRangeEndMs: 62_000
    });
    expect(preview.summary).toMatchObject({
      proposalAnchorCount: 3,
      proposalCutCount: 3,
      candidateAnchorCount: 2,
      candidateCutCount: 2,
      appliedAnchorCount: 1,
      appliedCutCount: 1
    });
  });
});
