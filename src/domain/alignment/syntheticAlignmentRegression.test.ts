import { describe, expect, it } from "vitest";
import type { SyntheticAlignmentLabQueueSummary } from "./syntheticAlignmentLabQueue";
import {
  createSyntheticAlignmentRegressionReceipt,
  serializeSyntheticAlignmentRegressionReceipt
} from "./syntheticAlignmentRegression";

describe("程序化对齐跨版本退化比较", () => {
  it("以内容摘要锁定确定性通过结果且不包含路径", () => {
    const result = createSyntheticAlignmentRegressionReceipt(
      summary("baseline", [suite("a", 500, 0.9, 0.95)]),
      [summary("candidate", [suite("a", 600, 0.89, 0.95)])]
    );

    expect(result.overallVerdict).toBe("pass");
    expect(result.releaseEligible).toBe(false);
    expect(result.baselineSummaryDigest).toBe(
      "sha256:b520b9c188939d2fc305e8832ff4123f03bb0003072dd2376ae5d1513ac2e24f"
    );
    expect(result.candidateSummaryDigests).toEqual([
      "sha256:2689e73d4771329bffdc11c0dc6b0fe8fdeffccf983368afd3a162c65ffc29d4"
    ]);
    expect(result.comparisonId).toBe(
      "sha256:582a8c782db37ec8f64adcf691fe98b4c574f02c89024386874a0a48ecdaa6ea"
    );
    expect(serializeSyntheticAlignmentRegressionReceipt(result)).not.toContain("C:/private");
  });

  it("报告五类指标退化", () => {
    const baseline = summary("baseline", [suite("a", 500, 0.95, 0.98)]);
    const candidateSuite = suite("a", 900, 0.8, 0.9);
    candidateSuite.state = "completedWithIssues";
    if (!candidateSuite.receipt) throw new Error("fixture receipt missing");
    candidateSuite.receipt.status = "completed-with-failures";
    candidateSuite.receipt.completedCaseCount = 0;
    candidateSuite.receipt.failedCaseCount = 1;
    candidateSuite.receipt.missingPredictionCount = 2;

    const result = createSyntheticAlignmentRegressionReceipt(baseline, [
      summary("candidate", [candidateSuite], "completedWithIssues")
    ]);

    expect(result.overallVerdict).toBe("regression");
    expect(result.comparisons[0].regressions.map((item) => item.metric)).toEqual([
      "boundaryP95Ms",
      "editClassificationF1",
      "failedCaseCount",
      "mappingCoverage",
      "missingPredictionCount"
    ]);
  });

  it("把基线套件消失和候选未完成分别标成退化与证据不完整", () => {
    const pending = suite("a");
    pending.state = "pending";
    pending.receipt = null;
    const result = createSyntheticAlignmentRegressionReceipt(
      summary("baseline", [suite("a"), suite("b")]),
      [summary("candidate", [pending], "ready")]
    );

    expect(result.overallVerdict).toBe("regression-with-incomplete-evidence");
    expect(result.comparisons[0].missingSuiteDigests).toEqual([manifestDigest("b")]);
    expect(result.comparisons[0].evidenceIssues).toContainEqual({
      manifestDigest: "queue",
      code: "candidate-queue-not-terminal"
    });
  });

  it("拒绝相同候选、重复候选和越界阈值", () => {
    const baseline = summary("baseline", [suite("a")]);
    const candidate = summary("candidate", [suite("a", 600)]);
    expect(() => createSyntheticAlignmentRegressionReceipt(baseline, [baseline])).toThrow(
      "完全相同"
    );
    expect(() => createSyntheticAlignmentRegressionReceipt(baseline, [candidate, candidate])).toThrow(
      "重复比较"
    );
    expect(() =>
      createSyntheticAlignmentRegressionReceipt(baseline, [candidate], {
        maxMissingPredictionIncrease: 0,
        maxFailedCaseIncrease: 0,
        maxBoundaryP95IncreaseMs: -1,
        maxEditClassificationF1Drop: 0.02,
        maxMappingCoverageDrop: 0.01
      })
    ).toThrow("非负有限数");
  });
});

function summary(
  queueId: string,
  suites: SyntheticAlignmentLabQueueSummary["suites"],
  state: SyntheticAlignmentLabQueueSummary["state"] = "completed"
): SyntheticAlignmentLabQueueSummary {
  return {
    schemaVersion: "alignment-synthetic-lab-summary-v1",
    queueId,
    state,
    createdAtMs: 100,
    updatedAtMs: 200,
    suiteCount: suites.length,
    totalCaseCount: suites.reduce((sum, item) => sum + item.caseCount, 0),
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold",
    suites
  };
}

function suite(
  suffix: string,
  boundaryP95Ms = 500,
  editClassificationF1 = 0.95,
  mappingCoverage = 0.98
): SyntheticAlignmentLabQueueSummary["suites"][number] {
  return {
    suiteId: `suite-${suffix}`,
    manifestDigest: manifestDigest(suffix),
    manifestId: `manifest-${suffix}`,
    datasetVersion: "v1",
    caseCount: 1,
    state: "completed",
    attemptCount: 1,
    interruptionCount: 0,
    receipt: {
      status: "completed",
      completedAtMs: 200,
      completedCaseCount: 1,
      failedCaseCount: 0,
      cancelledCaseCount: 0,
      missingPredictionCount: 0,
      boundaryP95Ms,
      editClassificationF1,
      mappingCoverage,
      failureCode: null
    }
  };
}

function manifestDigest(suffix: string): `sha256:${string}` {
  return `sha256:${suffix.codePointAt(0)?.toString(16).padStart(2, "0")}${"0".repeat(62)}`;
}
