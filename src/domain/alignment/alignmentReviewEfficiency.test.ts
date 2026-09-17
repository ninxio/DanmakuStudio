import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type { AlignmentReviewRecord } from "../project/types";
import { submitAlignmentReviewVote } from "./alignmentAdjudication";
import {
  buildAlignmentReviewEfficiencyReceipt,
  serializeAlignmentReviewEfficiencyReceipt
} from "./alignmentReviewEfficiency";
import { createAlignmentShadowRiskOverlay } from "./alignmentShadowRiskOverlay";

describe("独立复核效率收据", () => {
  it("只导出无路径近似耗时，并区分提交时风险和后来失效的证据", () => {
    const project = createEmptyProject("private-review-project");
    project.alignmentReviewRecords = [createRecord("record:high", 0), createRecord("record:low", 1)];
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"a".repeat(64)}`,
      generatedAt: "2026-07-22T10:00:00.000Z",
      entries: [
        { recordId: "record:high", risk: 0.9, reasonCodes: ["audio-shadow-risk"] },
        { recordId: "record:low", risk: 0.2, reasonCodes: ["audio-shadow-risk"] }
      ]
    });
    const first = submitAlignmentReviewVote(project, {
      reviewRecordId: "record:high",
      reviewerId: "reviewer-private-a",
      reviewSessionId: "session-a",
      role: "independent",
      decision: "target-extra",
      reviewStartedAt: "2026-07-22T10:59:50.000Z",
      reviewedAt: "2026-07-22T11:00:00.000Z"
    }).project;
    const second = submitAlignmentReviewVote(first, {
      reviewRecordId: "record:low",
      reviewerId: "reviewer-private-b",
      reviewSessionId: "session-b",
      role: "independent",
      decision: "replacement",
      reviewStartedAt: "2026-07-22T11:59:30.000Z",
      reviewedAt: "2026-07-22T12:00:00.000Z"
    }).project;
    second.alignmentReviewRecords[1] = {
      ...second.alignmentReviewRecords[1],
      targetEndMs: second.alignmentReviewRecords[1].targetEndMs + 1
    };

    const receipt = buildAlignmentReviewEfficiencyReceipt(
      second,
      "2026-07-22T13:00:00.000Z"
    );
    const serialized = serializeAlignmentReviewEfficiencyReceipt(receipt);

    expect(receipt.summary).toMatchObject({
      submittedVoteCount: 2,
      measuredVoteCount: 2,
      medianDurationMs: 10_000,
      p90DurationMs: 30_000,
      measuredWithShadowRiskCount: 1,
      staleCapturedRiskCount: 1,
      currentOverlayEntryCount: 2,
      currentOverlayAppliedCount: 1,
      currentOverlayStaleCount: 1,
      currentOverlayStaleRatio: 0.5
    });
    expect(receipt.rows.map((row) => row.shadowRiskEvidenceState)).toEqual([
      "matching",
      "stale"
    ]);
    expect(receipt.summary.riskBands[0]).toMatchObject({
      band: "high",
      measuredVoteCount: 1,
      medianDurationMs: 10_000
    });
    expect(serialized).not.toContain("private-review-project");
    expect(serialized).not.toContain("reviewer-private");
    expect(serialized).not.toContain("target-extra");
    expect(serialized).not.toContain("replacement");
    expect(serialized).not.toContain("path");
    expect(receipt.receiptId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("没有提交过复核时拒绝生成看似有效的效率数据", () => {
    const project = createEmptyProject("empty-review");
    project.alignmentReviewRecords = [createRecord("record:empty", 0)];
    expect(() => buildAlignmentReviewEfficiencyReceipt(project)).toThrow(
      /没有可测量的独立复核提交/
    );
  });
});

function createRecord(id: string, spanIndex: number): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id,
    timeMapId: "map:review",
    timeMapRevision: 1,
    spanId: `span:${spanIndex}`,
    spanIndex,
    sourceMediaId: "source:private",
    targetMediaId: "target:private",
    mediaGroupId: "group:private",
    action: "classifySpan",
    decision: "unresolved",
    precision: "rough",
    algorithmPrediction: "ambiguous",
    sourceStartMs: spanIndex * 10_000,
    sourceEndMs: spanIndex * 10_000 + 5_000,
    targetStartMs: spanIndex * 10_000,
    targetEndMs: spanIndex * 10_000 + 5_000,
    boundaryToleranceMs: null,
    features: {
      sourceCoverage: 0.8,
      uniqueContentCoverage: 0.7,
      anchorCount: 5,
      heldOutAnchorCount: 2,
      anchorRegionCount: 2,
      p95ResidualMs: 120,
      p99ResidualMs: 180,
      maxResidualMs: 240,
      boundaryUncertaintyMs: 800,
      alternativeMargin: 0.2,
      ambiguousRatio: 0.3,
      bidirectionalAgreement: null,
      differenceRiskP50: 0.2,
      differenceRiskP90: 0.4,
      differenceRiskP99: 0.6,
      informativenessP50: 0.5,
      visualRecoveredRatio: 0.1,
      visualAmbiguousRatio: 0.2,
      visualMarginP50: 0.3
    },
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-07-22T09:00:00.000Z"
  };
}
