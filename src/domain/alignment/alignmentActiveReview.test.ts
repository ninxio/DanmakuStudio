import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type { AlignmentReviewRecord } from "../project/types";
import { rankAlignmentRecordsForActiveReview } from "./alignmentActiveReview";

describe("有噪声人工标签的主动复核排序", () => {
  it("优先暴露人工结论反复和边界漂移，而不把它升级为 Gold", () => {
    const project = createEmptyProject("active-review");
    const prior = createRecord("prior", "target-extra", "rough", null, "superseded");
    const revised = createRecord(
      "revised",
      "source-extra",
      "rough",
      prior.id,
      "active",
      5_000
    );
    const stable = createRecord("stable", "target-extra", "playbackChecked", null, "active");
    project.alignmentReviewRecords = [prior, stable, revised];

    const ranked = rankAlignmentRecordsForActiveReview(project);
    expect(ranked.map((item) => item.recordId)).toEqual([revised.id, stable.id]);
    expect(ranked[0]).toMatchObject({
      level: "critical",
      revisionCount: 1,
      selfConflict: true,
      maximumBoundaryRevisionMs: 5_000
    });
    expect(ranked[0]?.reasons).toEqual(
      expect.arrayContaining(["这段的人工判断曾发生改变", "人工边界曾有明显漂移"])
    );
  });

  it("影子风险只改变排序分数，不产生人工结论或 Gold", () => {
    const project = createEmptyProject("shadow-active-review");
    const first = createRecord("first", "target-extra", "playbackChecked", null, "active");
    const second = createRecord("second", "target-extra", "playbackChecked", null, "active");
    project.alignmentReviewRecords = [first, second];

    const ranked = rankAlignmentRecordsForActiveReview(
      project,
      new Map([
        [first.id, 0.1],
        [second.id, 0.9]
      ])
    );
    expect(ranked[0]?.recordId).toBe(second.id);
    expect(ranked.every((item) => item.level !== "gold")).toBe(true);
    expect(project.alignmentReviewVotes).toHaveLength(0);
  });
});

function createRecord(
  id: string,
  decision: AlignmentReviewRecord["decision"],
  precision: AlignmentReviewRecord["precision"],
  supersedesRecordId: string | null,
  recordState: AlignmentReviewRecord["recordState"],
  boundaryShiftMs = 0
): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id: `review:${id}`,
    timeMapId: "map-1",
    timeMapRevision: 1,
    spanId: "span-1",
    spanIndex: 0,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    mediaGroupId: "group-1",
    action: "classifySpan",
    decision,
    precision,
    algorithmPrediction: "ambiguous",
    sourceStartMs: boundaryShiftMs,
    sourceEndMs: 10_000 + boundaryShiftMs,
    targetStartMs: boundaryShiftMs,
    targetEndMs: 10_000 + boundaryShiftMs,
    boundaryToleranceMs: 500,
    features: {
      sourceCoverage: 0.8,
      uniqueContentCoverage: 0.7,
      anchorCount: 8,
      heldOutAnchorCount: 3,
      anchorRegionCount: 2,
      p95ResidualMs: 120,
      p99ResidualMs: 180,
      maxResidualMs: 220,
      boundaryUncertaintyMs: 800,
      alternativeMargin: 0.15,
      ambiguousRatio: 0.6,
      bidirectionalAgreement: null,
      differenceRiskP50: 0.5,
      differenceRiskP90: 0.75,
      differenceRiskP99: 0.9,
      informativenessP50: 0.5,
      visualRecoveredRatio: 0.2,
      visualAmbiguousRatio: 0.7,
      visualMarginP50: 0.1
    },
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    supersedesRecordId,
    recordState,
    reviewedAt: "2026-07-22T00:00:00.000Z"
  };
}
