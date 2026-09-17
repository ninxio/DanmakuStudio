import { describe, expect, it } from "vitest";
import type { AlignmentReviewRecord } from "../project/types";
import {
  ALIGNMENT_CONFIDENCE_FEATURE_NAMES,
  parseAlignmentConfidenceLinearModel,
  rankAlignmentRecordsByShadowRisk,
  scoreAlignmentReviewRecord
} from "./alignmentConfidenceModel";

describe("alignment confidence shadow model", () => {
  it("严格校验训练脚本导出的特征顺序，并且永不授予自动采用权限", () => {
    const model = parseAlignmentConfidenceLinearModel(createModel());
    const score = scoreAlignmentReviewRecord(createRecord("record-a", 0.8), model);

    expect(score.mode).toBe("shadow-risk-ranking");
    expect(score.canAutoAccept).toBe(false);
    expect(score.proposalCorrectProbability).toBeGreaterThan(0.5);

    const invalid = createModel();
    invalid.featureNames = [...invalid.featureNames].reverse();
    expect(() => parseAlignmentConfidenceLinearModel(invalid)).toThrow("特征顺序");
  });

  it("按风险从高到低排序，并对缺失值使用训练时中位数", () => {
    const model = parseAlignmentConfidenceLinearModel(createModel());
    const lowerCoverage = createRecord("record-risky", 0.1);
    const missingCoverage = createRecord("record-missing", null);
    const safer = createRecord("record-safer", 0.9);
    const ranked = rankAlignmentRecordsByShadowRisk(
      [safer, missingCoverage, lowerCoverage],
      model
    );

    expect(ranked.map((item) => item.recordId)).toEqual([
      "record-risky",
      "record-missing",
      "record-safer"
    ]);
  });
});

function createModel() {
  const length = ALIGNMENT_CONFIDENCE_FEATURE_NAMES.length;
  return {
    schemaVersion: "alignment-confidence-linear-model-v1",
    featureNames: [...ALIGNMENT_CONFIDENCE_FEATURE_NAMES],
    imputerMedian: [0.5, ...Array.from({ length: length - 1 }, () => 0)],
    scalerMean: Array.from({ length }, () => 0),
    scalerScale: Array.from({ length }, () => 1),
    coefficients: [4, ...Array.from({ length: length - 1 }, () => 0)],
    intercept: -2,
    safeAutoAcceptThreshold: null,
    permission: "risk-ranking-only-until-frozen-gold-approved"
  };
}

function createRecord(id: string, sourceCoverage: number | null): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id,
    timeMapId: "map",
    timeMapRevision: 1,
    spanId: "span",
    spanIndex: 0,
    sourceMediaId: "source",
    targetMediaId: "target",
    mediaGroupId: "group",
    action: "classifySpan",
    decision: "replacement",
    precision: "rough",
    algorithmPrediction: "ambiguous",
    sourceStartMs: 0,
    sourceEndMs: 1_000,
    targetStartMs: 0,
    targetEndMs: 1_000,
    boundaryToleranceMs: null,
    features: {
      sourceCoverage,
      uniqueContentCoverage: null,
      anchorCount: null,
      heldOutAnchorCount: null,
      anchorRegionCount: null,
      p95ResidualMs: null,
      p99ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      alternativeMargin: null,
      ambiguousRatio: null,
      bidirectionalAgreement: null,
      differenceRiskP50: null,
      differenceRiskP90: null,
      differenceRiskP99: null,
      informativenessP50: null,
      visualRecoveredRatio: null,
      visualAmbiguousRatio: null,
      visualMarginP50: null
    },
    engineVersion: "test",
    featureVersion: "test",
    parametersHash: "test",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-07-22T00:00:00.000Z"
  };
}
