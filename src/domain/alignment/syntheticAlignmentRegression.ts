import { sha256Hex } from "../shared/sha256";
import {
  parseSyntheticAlignmentLabQueueSummary,
  type SyntheticAlignmentLabQueueSummary,
  type SyntheticAlignmentLabSuiteReceipt
} from "./syntheticAlignmentLabQueue";

export const DEFAULT_SYNTHETIC_ALIGNMENT_REGRESSION_THRESHOLDS = {
  maxMissingPredictionIncrease: 0,
  maxFailedCaseIncrease: 0,
  maxBoundaryP95IncreaseMs: 250,
  maxEditClassificationF1Drop: 0.02,
  maxMappingCoverageDrop: 0.01
} as const;

export interface SyntheticAlignmentRegressionThresholds {
  maxMissingPredictionIncrease: number;
  maxFailedCaseIncrease: number;
  maxBoundaryP95IncreaseMs: number;
  maxEditClassificationF1Drop: number;
  maxMappingCoverageDrop: number;
}

export interface SyntheticAlignmentRegressionFinding {
  manifestDigest: string;
  metric: string;
  baseline: number;
  candidate: number;
  regressionDelta: number;
  allowedDelta: number;
  code: "metric-regressed" | "baseline-suite-missing";
}

export interface SyntheticAlignmentRegressionEvidenceIssue {
  manifestDigest: string;
  code:
    | "candidate-queue-not-terminal"
    | "baseline-receipt-unavailable"
    | "candidate-suite-incomplete"
    | `candidate-metric-missing:${string}`;
}

export type SyntheticAlignmentRegressionVerdict =
  | "pass"
  | "regression"
  | "incomplete"
  | "regression-with-incomplete-evidence";

export interface SyntheticAlignmentRegressionReceipt {
  schemaVersion: "alignment-synthetic-regression-receipt-v1";
  comparisonId: `sha256:${string}`;
  baselineSummaryDigest: `sha256:${string}`;
  candidateSummaryDigests: `sha256:${string}`[];
  thresholds: SyntheticAlignmentRegressionThresholds;
  overallVerdict: SyntheticAlignmentRegressionVerdict;
  releaseEligible: false;
  note: "programmatic-development-evidence-never-real-gold";
  comparisons: Array<{
    candidateSummaryDigest: `sha256:${string}`;
    candidateQueueState: SyntheticAlignmentLabQueueSummary["state"];
    comparableSuiteCount: number;
    addedSuiteDigests: string[];
    missingSuiteDigests: string[];
    verdict: SyntheticAlignmentRegressionVerdict;
    regressions: SyntheticAlignmentRegressionFinding[];
    evidenceIssues: SyntheticAlignmentRegressionEvidenceIssue[];
  }>;
}

export function createSyntheticAlignmentRegressionReceipt(
  baselineValue: SyntheticAlignmentLabQueueSummary,
  candidateValues: readonly SyntheticAlignmentLabQueueSummary[],
  thresholdsValue: SyntheticAlignmentRegressionThresholds = DEFAULT_SYNTHETIC_ALIGNMENT_REGRESSION_THRESHOLDS
): SyntheticAlignmentRegressionReceipt {
  const baseline = parseSyntheticAlignmentLabQueueSummary(baselineValue);
  const thresholds = validateThresholds(thresholdsValue);
  if (baseline.state !== "completed" && baseline.state !== "completedWithIssues") {
    throw new Error("程序化回归基线必须已经运行到终态。");
  }
  const baselineDigest = digest(baseline);
  const candidates = new Map<`sha256:${string}`, SyntheticAlignmentLabQueueSummary>();
  for (const candidateValue of candidateValues) {
    const candidate = parseSyntheticAlignmentLabQueueSummary(candidateValue);
    const candidateDigest = digest(candidate);
    if (candidateDigest === baselineDigest) throw new Error("候选汇总与回归基线完全相同。");
    if (candidates.has(candidateDigest)) throw new Error("不能重复比较同一个候选汇总。");
    candidates.set(candidateDigest, candidate);
  }
  if (candidates.size === 0) throw new Error("至少需要一个候选汇总。");

  const baselineSuites = new Map(baseline.suites.map((suite) => [suite.manifestDigest, suite]));
  const comparisons = [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([candidateDigest, candidate]) =>
      compareCandidate(baselineSuites, candidateDigest, candidate, thresholds)
    );
  const hasRegression = comparisons.some((comparison) => comparison.regressions.length > 0);
  const hasIncomplete = comparisons.some((comparison) => comparison.evidenceIssues.length > 0);
  const candidateSummaryDigests = comparisons.map((comparison) => comparison.candidateSummaryDigest);
  const comparisonIdentity = {
    baselineSummaryDigest: baselineDigest,
    candidateSummaryDigests,
    thresholds
  };
  return {
    schemaVersion: "alignment-synthetic-regression-receipt-v1",
    comparisonId: digest(comparisonIdentity),
    baselineSummaryDigest: baselineDigest,
    candidateSummaryDigests,
    thresholds,
    overallVerdict: createVerdict(hasRegression, hasIncomplete),
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold",
    comparisons
  };
}

export function serializeSyntheticAlignmentRegressionReceipt(
  receipt: SyntheticAlignmentRegressionReceipt
): string {
  return `${canonicalJson(receipt)}\n`;
}

function compareCandidate(
  baselineSuites: Map<string, SyntheticAlignmentLabQueueSummary["suites"][number]>,
  candidateSummaryDigest: `sha256:${string}`,
  candidate: SyntheticAlignmentLabQueueSummary,
  thresholds: SyntheticAlignmentRegressionThresholds
): SyntheticAlignmentRegressionReceipt["comparisons"][number] {
  const candidateSuites = new Map<
    string,
    SyntheticAlignmentLabQueueSummary["suites"][number]
  >(candidate.suites.map((suite) => [suite.manifestDigest, suite]));
  const regressions: SyntheticAlignmentRegressionFinding[] = [];
  const evidenceIssues: SyntheticAlignmentRegressionEvidenceIssue[] = [];
  const addedSuiteDigests = [...candidateSuites.keys()]
    .filter((key) => !baselineSuites.has(key))
    .sort();
  const missingSuiteDigests = [...baselineSuites.keys()]
    .filter((key) => !candidateSuites.has(key))
    .sort();
  for (const manifestDigest of missingSuiteDigests) {
    regressions.push({
      manifestDigest,
      metric: "suitePresence",
      baseline: 1,
      candidate: 0,
      regressionDelta: -1,
      allowedDelta: 0,
      code: "baseline-suite-missing"
    });
  }
  if (candidate.state !== "completed" && candidate.state !== "completedWithIssues") {
    evidenceIssues.push({ manifestDigest: "queue", code: "candidate-queue-not-terminal" });
  }
  let comparableSuiteCount = 0;
  for (const manifestDigest of [...baselineSuites.keys()].sort()) {
    const candidateSuite = candidateSuites.get(manifestDigest);
    if (!candidateSuite) continue;
    const baselineSuite = baselineSuites.get(manifestDigest);
    if (!baselineSuite?.receipt) {
      evidenceIssues.push({ manifestDigest, code: "baseline-receipt-unavailable" });
      continue;
    }
    if (!candidateSuite.receipt || candidateSuite.state === "pending" || candidateSuite.state === "running") {
      evidenceIssues.push({ manifestDigest, code: "candidate-suite-incomplete" });
      continue;
    }
    comparableSuiteCount += 1;
    compareMetric(regressions, evidenceIssues, manifestDigest, "missingPredictionCount", baselineSuite.receipt, candidateSuite.receipt, thresholds.maxMissingPredictionIncrease, true);
    compareMetric(regressions, evidenceIssues, manifestDigest, "failedCaseCount", baselineSuite.receipt, candidateSuite.receipt, thresholds.maxFailedCaseIncrease, true);
    compareMetric(regressions, evidenceIssues, manifestDigest, "boundaryP95Ms", baselineSuite.receipt, candidateSuite.receipt, thresholds.maxBoundaryP95IncreaseMs, true);
    compareMetric(regressions, evidenceIssues, manifestDigest, "editClassificationF1", baselineSuite.receipt, candidateSuite.receipt, thresholds.maxEditClassificationF1Drop, false);
    compareMetric(regressions, evidenceIssues, manifestDigest, "mappingCoverage", baselineSuite.receipt, candidateSuite.receipt, thresholds.maxMappingCoverageDrop, false);
  }
  regressions.sort((left, right) =>
    `${left.manifestDigest}\0${left.metric}`.localeCompare(`${right.manifestDigest}\0${right.metric}`)
  );
  evidenceIssues.sort((left, right) =>
    `${left.manifestDigest}\0${left.code}`.localeCompare(`${right.manifestDigest}\0${right.code}`)
  );
  return {
    candidateSummaryDigest,
    candidateQueueState: candidate.state,
    comparableSuiteCount,
    addedSuiteDigests,
    missingSuiteDigests,
    verdict: createVerdict(regressions.length > 0, evidenceIssues.length > 0),
    regressions,
    evidenceIssues
  };
}

type ComparableMetric =
  | "missingPredictionCount"
  | "failedCaseCount"
  | "boundaryP95Ms"
  | "editClassificationF1"
  | "mappingCoverage";

function compareMetric(
  regressions: SyntheticAlignmentRegressionFinding[],
  evidenceIssues: SyntheticAlignmentRegressionEvidenceIssue[],
  manifestDigest: string,
  metric: ComparableMetric,
  baselineReceipt: SyntheticAlignmentLabSuiteReceipt,
  candidateReceipt: SyntheticAlignmentLabSuiteReceipt,
  allowedDelta: number,
  higherIsWorse: boolean
): void {
  const baseline = baselineReceipt[metric];
  const candidate = candidateReceipt[metric];
  if (baseline === null) return;
  if (candidate === null) {
    evidenceIssues.push({ manifestDigest, code: `candidate-metric-missing:${metric}` });
    return;
  }
  const regressionDelta = higherIsWorse ? candidate - baseline : baseline - candidate;
  if (regressionDelta > allowedDelta) {
    regressions.push({
      manifestDigest,
      metric,
      baseline,
      candidate,
      regressionDelta,
      allowedDelta,
      code: "metric-regressed"
    });
  }
}

function validateThresholds(
  value: SyntheticAlignmentRegressionThresholds
): SyntheticAlignmentRegressionThresholds {
  const checked = { ...value };
  const entries = Object.entries(checked);
  if (
    !Number.isSafeInteger(checked.maxMissingPredictionIncrease) ||
    !Number.isSafeInteger(checked.maxFailedCaseIncrease)
  ) {
    throw new Error("case 数退化阈值必须是安全整数。");
  }
  if (entries.some(([, item]) => !Number.isFinite(item) || item < 0)) {
    throw new Error("程序化回归阈值必须是非负有限数。");
  }
  return checked;
}

function createVerdict(
  hasRegression: boolean,
  hasIncomplete: boolean
): SyntheticAlignmentRegressionVerdict {
  if (hasRegression && hasIncomplete) return "regression-with-incomplete-evidence";
  if (hasRegression) return "regression";
  return hasIncomplete ? "incomplete" : "pass";
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数字。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 不接受 undefined、函数或 symbol。");
}
