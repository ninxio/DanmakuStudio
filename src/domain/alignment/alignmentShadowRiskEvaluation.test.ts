import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type { AlignmentReviewRecord, EditorProject } from "../project/types";
import {
  buildAlignmentMediaFamilyAssignments,
  submitAlignmentReviewVote
} from "./alignmentAdjudication";
import {
  buildAlignmentShadowRiskEvaluationReceipt,
  serializeAlignmentShadowRiskEvaluationReceipt
} from "./alignmentShadowRiskEvaluation";
import { createAlignmentShadowRiskOverlay } from "./alignmentShadowRiskOverlay";

describe("音频影子风险复核效果收据", () => {
  it("只用非 frozen 独立 Gold 衡量错误捕获，弱票和冲突不会冒充正确率", () => {
    let project = createEvaluationProject();
    project = addVote(project, "review:0", "reviewer-a", "source-extra");
    project = addVote(project, "review:0", "reviewer-b", "source-extra");
    project = addVote(project, "review:1", "reviewer-a", "source-extra");
    project = addVote(project, "review:1", "reviewer-b", "source-extra");
    project = addVote(project, "review:2", "reviewer-a", "target-extra");
    project = addVote(project, "review:3", "reviewer-a", "source-extra");
    project = addVote(project, "review:3", "reviewer-b", "target-extra");
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"a".repeat(64)}`,
      generatedAt: "2026-07-22T00:00:00.000Z",
      entries: project.alignmentReviewRecords.map((record, index) => ({
        recordId: record.id,
        risk: index === 1 ? 0.99 : Math.max(0.05, 0.9 - index * 0.08),
        reasonCodes: ["audio-shadow-risk"]
      }))
    });

    const receipt = buildAlignmentShadowRiskEvaluationReceipt(
      project,
      "2026-07-22T01:00:00.000Z"
    );

    expect(receipt.summary).toMatchObject({
      rankedRecordCount: 10,
      evaluatedGoldCount: 2,
      goldErrorCount: 1,
      goldCorrectCount: 1,
      conflictCount: 1,
      weakReviewedCount: 1,
      pendingCount: 6,
      goldBaselineErrorRate: 0.5,
      accuracyClaimReady: false
    });
    expect(receipt.rows[0]).toMatchObject({
      state: "gold-error",
      proposalCorrect: false,
      risk: 0.99,
      rank: 1
    });
    expect(receipt.summary.buckets[0]).toMatchObject({
      fraction: 0.1,
      reviewedRecordCount: 1,
      capturedGoldErrorCount: 1,
      goldErrorCaptureRate: 1,
      goldErrorYield: 1,
      liftAgainstGoldBaseline: 2
    });
    expect(receipt.rows.find((row) => row.state === "weak-reviewed")?.proposalCorrect).toBeNull();
    expect(receipt.rows.find((row) => row.state === "conflict")?.proposalCorrect).toBeNull();
  });

  it("输出不含项目、媒体和原始记录标识，记录或风险变化会改变不可变收据", () => {
    const project = createEvaluationProject();
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"b".repeat(64)}`,
      generatedAt: "2026-07-22T00:00:00.000Z",
      entries: project.alignmentReviewRecords.map((record, index) => ({
        recordId: record.id,
        risk: 0.1 + index * 0.05,
        reasonCodes: ["audio-shadow-risk"]
      }))
    });
    const receipt = buildAlignmentShadowRiskEvaluationReceipt(
      project,
      "2026-07-22T01:00:00.000Z"
    );
    const serialized = serializeAlignmentShadowRiskEvaluationReceipt(receipt);

    expect(serialized).not.toContain(project.id);
    expect(serialized).not.toContain(project.name);
    expect(serialized).not.toContain("review:0");
    expect(serialized).not.toContain("source-private");
    expect(serialized).not.toContain("target-private");
    expect(serialized).not.toMatch(/[A-Z]:\\/i);
    expect(receipt.permission).toBe("shadow-evaluation-only");
    expect(receipt.releaseEligible).toBe(false);
    expect(receipt.sourceRunId).toBe(project.alignmentShadowRiskOverlay?.sourceRunId);

    const changed = structuredClone(project);
    changed.alignmentShadowRiskOverlay!.entries[0].risk += 0.01;
    expect(() => buildAlignmentShadowRiskEvaluationReceipt(changed)).toThrow(
      /摘要|风险文件|匹配/
    );
  });

  it("没有有效风险时拒绝伪造效果结果", () => {
    const project = createEvaluationProject();
    expect(() => buildAlignmentShadowRiskEvaluationReceipt(project)).toThrow(
      /没有仍与项目证据匹配的音频风险/
    );
  });
});

function createEvaluationProject(): EditorProject {
  const project = createEmptyProject("private-evaluation-project");
  project.alignmentReviewRecords = Array.from({ length: 10 }, (_, index) =>
    createRecord(index)
  );
  for (let suffix = 0; suffix < 100; suffix += 1) {
    project.id = `private-project-${suffix}`;
    const assignment = buildAlignmentMediaFamilyAssignments(
      project,
      project.alignmentReviewRecords
    ).get(project.alignmentReviewRecords[0].id);
    if (assignment?.split !== "frozen-test") return project;
  }
  throw new Error("测试夹具无法找到非 frozen 媒体家族。");
}

function createRecord(index: number): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id: `review:${index}`,
    timeMapId: "map-private",
    timeMapRevision: 1,
    spanId: `span:${index}`,
    spanIndex: index,
    sourceMediaId: "source-private",
    targetMediaId: "target-private",
    mediaGroupId: "group-private",
    action: "classifySpan",
    decision: "unresolved",
    precision: "rough",
    algorithmPrediction: index === 0 ? "sourceOnly" : "matched",
    sourceStartMs: index * 10_000,
    sourceEndMs: index * 10_000 + 8_000,
    targetStartMs: index * 10_000,
    targetEndMs: index * 10_000 + 8_000,
    boundaryToleranceMs: 1_000,
    features: {
      sourceCoverage: 0.8,
      uniqueContentCoverage: 0.7,
      anchorCount: 8,
      heldOutAnchorCount: 3,
      anchorRegionCount: 3,
      p95ResidualMs: 100,
      p99ResidualMs: 150,
      maxResidualMs: 200,
      boundaryUncertaintyMs: 500,
      alternativeMargin: 0.4,
      ambiguousRatio: 0.2,
      bidirectionalAgreement: null,
      differenceRiskP50: 0.2,
      differenceRiskP90: 0.3,
      differenceRiskP99: 0.4,
      informativenessP50: 0.6,
      visualRecoveredRatio: null,
      visualAmbiguousRatio: null,
      visualMarginP50: null
    },
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-07-22T00:00:00.000Z"
  };
}

function addVote(
  project: EditorProject,
  reviewRecordId: string,
  reviewerId: string,
  decision: "source-extra" | "target-extra"
): EditorProject {
  const result = submitAlignmentReviewVote(project, {
    reviewRecordId,
    reviewerId,
    reviewSessionId: `session:${reviewerId}`,
    role: "independent",
    decision,
    boundaryToleranceMs: 1_000,
    reviewedAt: "2026-07-22T00:30:00.000Z"
  });
  if (!result.ok) throw new Error(result.message);
  return result.project;
}
