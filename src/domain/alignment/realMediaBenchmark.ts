import {
  mapSourceTime,
  validateTimeMap,
  type TimeMapSpan,
  type TimeMapSpanKind,
  type TimeMapValidationIssueCode
} from "./timeMap";

/**
 * 真实媒体路径只属于本地评测清单和运行期输入，不得写入 EditorProject 或评测结果。
 * 结果只保存 caseId、场景和聚合指标，因而可以安全分享而不泄漏本地路径。
 */

export const REAL_MEDIA_BENCHMARK_SCHEMA_VERSION = 2 as const;

export type RealMediaBenchmarkScenario =
  | "global-offset"
  | "time-stretch"
  | "source-only"
  | "target-only"
  | "ambiguous"
  | "multi-edit"
  | "multi-audio"
  | "long-reference"
  | "visual-fallback"
  | "repeated-content"
  | "pts-offset"
  | "codec-variant";

export type RealMediaBenchmarkMediaKind = "real" | "synthetic" | "placeholder";
export type RealMediaBenchmarkSplit = "development" | "frozen-test";
export type BenchmarkEditKind = Exclude<TimeMapSpanKind, "matched">;

export interface RealMediaBenchmarkContentIdentity {
  algorithm: "sha256-full-file-v2";
  sizeBytes: number;
  digest: string;
}

export interface RealMediaBenchmarkMediaInput {
  path: string;
  audioStreamIndex: number;
  videoStreamIndex: number | null;
  contentIdentity: RealMediaBenchmarkContentIdentity | null;
  versionNote: string;
  licenseNote: string;
}

export interface RealMediaBenchmarkAnchor {
  id: string;
  sourceMs: number;
  targetMs: number;
}

export interface RealMediaBenchmarkSourceOnlySpan extends TimeMapSpan {
  kind: "sourceOnly";
}

export interface RealMediaBenchmarkTargetOnlySpan extends TimeMapSpan {
  kind: "targetOnly";
}

export interface RealMediaBenchmarkAmbiguousSpan extends TimeMapSpan {
  kind: "ambiguous";
}

export interface RealMediaBenchmarkGold {
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  matchedAnchors: RealMediaBenchmarkAnchor[];
  sourceOnlySpans: RealMediaBenchmarkSourceOnlySpan[];
  targetOnlySpans: RealMediaBenchmarkTargetOnlySpan[];
  ambiguousSpans: RealMediaBenchmarkAmbiguousSpan[];
}

export interface RealMediaBenchmarkIndependentAnnotation {
  /** Pseudonymous stable reviewer identifier; never store a person's real name here. */
  reviewerId: string;
  gold: RealMediaBenchmarkGold;
}

export interface RealMediaBenchmarkAdjudication {
  status: "not-needed" | "resolved";
  adjudicatorId: string | null;
  note: string;
}

export interface RealMediaBenchmarkCase {
  id: string;
  title: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: RealMediaBenchmarkSplit;
  scenarios: RealMediaBenchmarkScenario[];
  source: RealMediaBenchmarkMediaInput;
  target: RealMediaBenchmarkMediaInput;
  boundaryToleranceMs: number;
  versionNotes: string[];
  licenseNotes: string[];
  independentAnnotations: RealMediaBenchmarkIndependentAnnotation[];
  adjudication: RealMediaBenchmarkAdjudication | null;
  gold: RealMediaBenchmarkGold;
}

export interface RealMediaBenchmarkManifest {
  schemaVersion: typeof REAL_MEDIA_BENCHMARK_SCHEMA_VERSION;
  id: string;
  name: string;
  datasetVersion: string;
  description: string;
  isExample: boolean;
  licenseNotes: string[];
  cases: RealMediaBenchmarkCase[];
}

export interface RealMediaBenchmarkPrediction {
  caseId: string;
  spans: TimeMapSpan[];
}

export interface RealMediaBenchmarkValidationResult {
  valid: boolean;
  issues: string[];
}

export interface BenchmarkErrorDistribution {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface BenchmarkClassificationMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface BenchmarkEventReference {
  kind: BenchmarkEditKind;
  index: number;
}

export interface RealMediaBenchmarkCaseResult {
  caseId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  scenarios: RealMediaBenchmarkScenario[];
  missingPrediction: boolean;
  structureValid: boolean;
  structureIssues: string[];
  structuralFailureCount: number;
  monotonicityFailureCount: number;
  anchorAbsoluteErrorsMs: number[];
  anchorError: BenchmarkErrorDistribution;
  mappedAnchorCount: number;
  unmappedAnchorCount: number;
  boundaryAbsoluteErrorsMs: number[];
  boundaryError: BenchmarkErrorDistribution;
  editClassification: BenchmarkClassificationMetrics;
  editClassificationByKind: Record<BenchmarkEditKind, BenchmarkClassificationMetrics>;
  missedEvents: BenchmarkEventReference[];
  falsePositiveEvents: BenchmarkEventReference[];
  goldEditCount: number;
  predictedEditCount: number;
  sourceDurationMs: number;
  coveredSourceDurationMs: number;
  matchedSourceDurationMs: number;
  ambiguousSourceDurationMs: number;
  mappingCoverage: number;
  ambiguousRatio: number;
}

export interface RealMediaBenchmarkSummary {
  relationCount: number;
  realRelationCount: number;
  missingPredictionCount: number;
  structuralFailureCount: number;
  monotonicityFailureCount: number;
  anchorError: BenchmarkErrorDistribution;
  mappedAnchorCount: number;
  unmappedAnchorCount: number;
  boundaryError: BenchmarkErrorDistribution;
  editClassification: BenchmarkClassificationMetrics;
  editClassificationByKind: Record<BenchmarkEditKind, BenchmarkClassificationMetrics>;
  missedEditCount: number;
  falsePositiveEditCount: number;
  goldEditCount: number;
  predictedEditCount: number;
  mappingCoverage: number;
  ambiguousRatio: number;
}

export interface RealMediaBenchmarkScenarioSummary extends RealMediaBenchmarkSummary {
  scenario: RealMediaBenchmarkScenario;
}

export type C137BenchmarkGateStatus = "insufficient-data" | "pass" | "fail";

export interface C137BenchmarkGateCheck {
  id: string;
  passed: boolean;
  actual: number | string | boolean;
  requirement: string;
}

export interface C137BenchmarkGateResult {
  /**
   * This evaluator only measures a TimeMap for an already-known media pair. It does not cover
   * relationship ranking, calibration, performance, North Star, UI, or release acceptance.
   */
  scope: "time-map-component";
  status: C137BenchmarkGateStatus;
  /** A component result must never grant full C137 verified eligibility. */
  verifiedEligible: false;
  dataChecks: C137BenchmarkGateCheck[];
  qualityChecks: C137BenchmarkGateCheck[];
  reasons: string[];
}

export interface RealMediaBenchmarkResult {
  schemaVersion: typeof REAL_MEDIA_BENCHMARK_SCHEMA_VERSION;
  manifestId: string;
  datasetVersion: string;
  caseResults: RealMediaBenchmarkCaseResult[];
  scenarioSummaries: RealMediaBenchmarkScenarioSummary[];
  overall: RealMediaBenchmarkSummary;
  realMediaOverall: RealMediaBenchmarkSummary;
  unexpectedPredictionCaseIds: string[];
  gate: C137BenchmarkGateResult;
}

export const C137_REQUIRED_SCENARIOS: readonly RealMediaBenchmarkScenario[] = [
  "global-offset",
  "time-stretch",
  "source-only",
  "target-only",
  "ambiguous",
  "multi-audio",
  "long-reference",
  "visual-fallback",
  "repeated-content"
];

export const C137_BENCHMARK_MINIMUMS = {
  realRelationCount: 150,
  longReferenceRelationCount: 30,
  goldEditCount: 500,
  frozenTestRatio: 0.3,
  relationsPerRequiredScenario: 1
} as const;

const EDIT_KINDS: readonly BenchmarkEditKind[] = ["sourceOnly", "targetOnly", "ambiguous"];
const MONOTONICITY_ISSUE_CODES = new Set<TimeMapValidationIssueCode>([
  "outOfOrder",
  "sourceOverlap",
  "targetOverlap"
]);
const SCENARIOS = new Set<RealMediaBenchmarkScenario>([
  "global-offset",
  "time-stretch",
  "source-only",
  "target-only",
  "ambiguous",
  "multi-edit",
  "multi-audio",
  "long-reference",
  "visual-fallback",
  "repeated-content",
  "pts-offset",
  "codec-variant"
]);
const BENCHMARK_SPLITS = new Set<RealMediaBenchmarkSplit>(["development", "frozen-test"]);
const SHA256_HEX = /^[a-f0-9]{64}$/i;

export function validateRealMediaBenchmarkManifest(
  value: unknown
): RealMediaBenchmarkValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: ["真实媒体基准 manifest 必须是对象。"] };
  }
  if (value.schemaVersion !== REAL_MEDIA_BENCHMARK_SCHEMA_VERSION) {
    issues.push("真实媒体基准 manifest schemaVersion 必须为 2。v1 缺少媒体身份、双人标注和冻结集治理字段，不能用于精度验收。");
  }
  validateRequiredString(value.id, "manifest.id", issues);
  validateRequiredString(value.name, "manifest.name", issues);
  validateRequiredString(value.datasetVersion, "manifest.datasetVersion", issues);
  validateRequiredString(value.description, "manifest.description", issues);
  if (typeof value.isExample !== "boolean") {
    issues.push("manifest.isExample 必须是布尔值。");
  }
  if (!isNonEmptyStringArray(value.licenseNotes)) {
    issues.push("manifest.licenseNotes 必须至少包含一条许可说明。");
  }
  if (!Array.isArray(value.cases)) {
    issues.push("manifest.cases 必须是数组。");
    return { valid: false, issues };
  }

  const caseIds = new Set<string>();
  value.cases.forEach((benchmarkCase, caseIndex) => {
    validateManifestCase(benchmarkCase, caseIndex, issues);
    if (isRecord(benchmarkCase) && typeof benchmarkCase.id === "string") {
      if (caseIds.has(benchmarkCase.id)) {
        issues.push(`manifest.cases[${caseIndex}].id 与其他关系重复。`);
      }
      caseIds.add(benchmarkCase.id);
      if (value.isExample === true && benchmarkCase.mediaKind === "real") {
        issues.push("示例 manifest 不能把占位素材声明为 real。");
      }
    }
  });
  return { valid: issues.length === 0, issues };
}

export function parseRealMediaBenchmarkManifestJson(json: string): RealMediaBenchmarkManifest {
  const parsed = JSON.parse(json) as unknown;
  const validation = validateRealMediaBenchmarkManifest(parsed);
  if (!validation.valid) {
    throw new Error(`真实媒体基准 manifest 无效：${validation.issues.join("；")}`);
  }
  return parsed as RealMediaBenchmarkManifest;
}

export function evaluateRealMediaBenchmark(
  manifest: RealMediaBenchmarkManifest,
  predictions: readonly RealMediaBenchmarkPrediction[]
): RealMediaBenchmarkResult {
  const validation = validateRealMediaBenchmarkManifest(manifest);
  if (!validation.valid) {
    throw new Error(`真实媒体基准 manifest 无效：${validation.issues.join("；")}`);
  }
  validatePredictionsOrThrow(predictions);

  const casesById = new Set(manifest.cases.map((benchmarkCase) => benchmarkCase.id));
  const predictionsByCaseId = new Map(
    predictions.map((prediction) => [prediction.caseId, prediction])
  );
  const unexpectedPredictionCaseIds = predictions
    .map((prediction) => prediction.caseId)
    .filter((caseId) => !casesById.has(caseId))
    .sort();
  const caseResults = manifest.cases.map((benchmarkCase) =>
    evaluateBenchmarkCase(benchmarkCase, predictionsByCaseId.get(benchmarkCase.id))
  );
  const scenarioSummaries = [...new Set(manifest.cases.flatMap((item) => item.scenarios))]
    .sort()
    .map((scenario) => ({
      scenario,
      ...summarizeCaseResults(
        caseResults.filter((caseResult) => caseResult.scenarios.includes(scenario))
      )
    }));
  const overall = summarizeCaseResults(caseResults);
  const realMediaOverall = summarizeCaseResults(
    caseResults.filter((caseResult) => caseResult.mediaKind === "real")
  );
  const gate = evaluateC137BenchmarkGate(
    manifest,
    realMediaOverall,
    caseResults.filter((caseResult) => caseResult.mediaKind === "real"),
    unexpectedPredictionCaseIds
  );
  const result: RealMediaBenchmarkResult = {
    schemaVersion: REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
    manifestId: manifest.id,
    datasetVersion: manifest.datasetVersion,
    caseResults,
    scenarioSummaries,
    overall,
    realMediaOverall,
    unexpectedPredictionCaseIds,
    gate
  };
  const resultValidation = validateRealMediaBenchmarkResult(result);
  if (!resultValidation.valid) {
    throw new Error(`内部生成的真实媒体评测结果无效：${resultValidation.issues.join("；")}`);
  }
  return result;
}

export function validateRealMediaBenchmarkResult(
  value: unknown
): RealMediaBenchmarkValidationResult {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, issues: ["真实媒体评测结果必须是对象。"] };
  }
  if (value.schemaVersion !== REAL_MEDIA_BENCHMARK_SCHEMA_VERSION) {
    issues.push("真实媒体评测结果 schemaVersion 必须为 2。");
  }
  validateRequiredString(value.manifestId, "result.manifestId", issues);
  validateRequiredString(value.datasetVersion, "result.datasetVersion", issues);
  if (!Array.isArray(value.caseResults) || !value.caseResults.every(isBenchmarkCaseResult)) {
    issues.push("result.caseResults 结构不完整。");
  }
  if (
    !Array.isArray(value.scenarioSummaries) ||
    !value.scenarioSummaries.every(isBenchmarkScenarioSummary)
  ) {
    issues.push("result.scenarioSummaries 结构不完整。");
  }
  if (!isBenchmarkSummary(value.overall) || !isBenchmarkSummary(value.realMediaOverall)) {
    issues.push("result 总体汇总结构不完整。");
  }
  if (!isStringArray(value.unexpectedPredictionCaseIds)) {
    issues.push("result.unexpectedPredictionCaseIds 必须是字符串数组。");
  }
  if (!isC137GateResult(value.gate)) {
    issues.push("result.gate 结构不完整。");
  }
  if (
    Array.isArray(value.caseResults) &&
    value.caseResults.every(isBenchmarkCaseResult) &&
    Array.isArray(value.scenarioSummaries) &&
    value.scenarioSummaries.every(isBenchmarkScenarioSummary) &&
    isBenchmarkSummary(value.overall) &&
    isBenchmarkSummary(value.realMediaOverall)
  ) {
    const caseResults = value.caseResults as RealMediaBenchmarkCaseResult[];
    const expectedOverall = summarizeCaseResults(caseResults);
    const expectedRealOverall = summarizeCaseResults(
      caseResults.filter((item) => item.mediaKind === "real")
    );
    const expectedScenarioSummaries = [...new Set(caseResults.flatMap((item) => item.scenarios))]
      .sort()
      .map((scenario) => ({
        scenario,
        ...summarizeCaseResults(caseResults.filter((item) => item.scenarios.includes(scenario)))
      }));
    if (!deepEqualUnknown(value.overall, expectedOverall)) {
      issues.push("result.overall 与 caseResults 重算结果不一致，拒绝接受外部 summary。");
    }
    if (!deepEqualUnknown(value.realMediaOverall, expectedRealOverall)) {
      issues.push("result.realMediaOverall 与真实 caseResults 重算结果不一致。");
    }
    if (!deepEqualUnknown(value.scenarioSummaries, expectedScenarioSummaries)) {
      issues.push("result.scenarioSummaries 与 caseResults 分层重算结果不一致。");
    }
  }
  if (isC137GateResult(value.gate) && !isTimeMapComponentGateSelfConsistent(value.gate)) {
    issues.push("result.gate 状态与 dataChecks/qualityChecks 不一致，拒绝接受外部 gate。");
  }
  return { valid: issues.length === 0, issues };
}

export function parseRealMediaBenchmarkResultJson(json: string): RealMediaBenchmarkResult {
  const parsed = JSON.parse(json) as unknown;
  const validation = validateRealMediaBenchmarkResult(parsed);
  if (!validation.valid) {
    throw new Error(`真实媒体评测结果无效：${validation.issues.join("；")}`);
  }
  return parsed as RealMediaBenchmarkResult;
}

function evaluateBenchmarkCase(
  benchmarkCase: RealMediaBenchmarkCase,
  prediction: RealMediaBenchmarkPrediction | undefined
): RealMediaBenchmarkCaseResult {
  const spans = prediction?.spans ?? [];
  const mapValidation = validateTimeMap(spans);
  const missingPrediction = prediction === undefined;
  const structureIssues = missingPrediction
    ? ["缺少该关系的预测 TimeMap。"]
    : mapValidation.valid
      ? []
      : mapValidation.issues.map((issue) => issue.message);
  const monotonicityFailureCount = mapValidation.valid
    ? 0
    : mapValidation.issues.filter((issue) => MONOTONICITY_ISSUE_CODES.has(issue.code)).length;
  const structureValid = !missingPrediction && mapValidation.valid;
  const anchorAbsoluteErrorsMs: number[] = [];
  let unmappedAnchorCount = 0;
  for (const anchor of benchmarkCase.gold.matchedAnchors) {
    if (!structureValid) {
      unmappedAnchorCount += 1;
      continue;
    }
    const mapped = mapSourceTime(spans, anchor.sourceMs);
    if (mapped.status !== "mapped") {
      unmappedAnchorCount += 1;
      continue;
    }
    anchorAbsoluteErrorsMs.push(Math.abs(mapped.targetTimeMs - anchor.targetMs));
  }

  const editEvaluation = evaluateEditEvents(benchmarkCase, spans);
  const sourceDurationMs = benchmarkCase.gold.sourceEndMs - benchmarkCase.gold.sourceStartMs;
  const matchedSourceDurationMs = measureSpanSourceCoverage(
    spans,
    "matched",
    benchmarkCase.gold.sourceStartMs,
    benchmarkCase.gold.sourceEndMs
  );
  const ambiguousSourceDurationMs = measureSpanSourceCoverage(
    spans,
    "ambiguous",
    benchmarkCase.gold.sourceStartMs,
    benchmarkCase.gold.sourceEndMs
  );
  const coveredSourceDurationMs = measureTimeMapSourceCoverage(
    spans,
    benchmarkCase.gold.sourceStartMs,
    benchmarkCase.gold.sourceEndMs
  );

  return {
    caseId: benchmarkCase.id,
    mediaKind: benchmarkCase.mediaKind,
    scenarios: [...benchmarkCase.scenarios],
    missingPrediction,
    structureValid,
    structureIssues,
    structuralFailureCount: structureIssues.length,
    monotonicityFailureCount,
    anchorAbsoluteErrorsMs,
    anchorError: createErrorDistribution(anchorAbsoluteErrorsMs),
    mappedAnchorCount: anchorAbsoluteErrorsMs.length,
    unmappedAnchorCount,
    boundaryAbsoluteErrorsMs: editEvaluation.boundaryErrors,
    boundaryError: createErrorDistribution(editEvaluation.boundaryErrors),
    editClassification: editEvaluation.overall,
    editClassificationByKind: editEvaluation.byKind,
    missedEvents: editEvaluation.missedEvents,
    falsePositiveEvents: editEvaluation.falsePositiveEvents,
    goldEditCount: editEvaluation.goldCount,
    predictedEditCount: editEvaluation.predictedCount,
    sourceDurationMs,
    coveredSourceDurationMs,
    matchedSourceDurationMs,
    ambiguousSourceDurationMs,
    mappingCoverage: safeRatio(coveredSourceDurationMs, sourceDurationMs),
    ambiguousRatio: safeRatio(ambiguousSourceDurationMs, sourceDurationMs)
  };
}

interface IndexedEditEvent {
  kind: BenchmarkEditKind;
  index: number;
  span: TimeMapSpan;
}

interface EditEvaluationResult {
  boundaryErrors: number[];
  overall: BenchmarkClassificationMetrics;
  byKind: Record<BenchmarkEditKind, BenchmarkClassificationMetrics>;
  missedEvents: BenchmarkEventReference[];
  falsePositiveEvents: BenchmarkEventReference[];
  goldCount: number;
  predictedCount: number;
}

function evaluateEditEvents(
  benchmarkCase: RealMediaBenchmarkCase,
  predictedSpans: readonly TimeMapSpan[]
): EditEvaluationResult {
  const goldEvents = collectGoldEditEvents(benchmarkCase.gold);
  const predictedEvents = predictedSpans
    .map((span, index): IndexedEditEvent | null =>
      span.kind === "matched" ? null : { kind: span.kind, index, span }
    )
    .filter((event): event is IndexedEditEvent => event !== null);
  const byKind = createEmptyClassificationByKind();
  const boundaryErrors: number[] = [];
  const missedEvents: BenchmarkEventReference[] = [];
  const falsePositiveEvents: BenchmarkEventReference[] = [];

  for (const kind of EDIT_KINDS) {
    const goldForKind = goldEvents.filter((event) => event.kind === kind);
    const predictedForKind = predictedEvents.filter((event) => event.kind === kind);
    const assignments = assignEditEvents(
      goldForKind,
      predictedForKind,
      benchmarkCase.boundaryToleranceMs
    );
    const assignedGold = new Set<number>();
    const assignedPredicted = new Set<number>();
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;

    assignments.forEach((assignment) => {
      assignedGold.add(assignment.gold.index);
      assignedPredicted.add(assignment.predicted.index);
      boundaryErrors.push(...assignment.boundaryErrors);
      if (assignment.maxBoundaryErrorMs <= benchmarkCase.boundaryToleranceMs) {
        truePositive += 1;
      } else {
        falsePositive += 1;
        falseNegative += 1;
        missedEvents.push({ kind, index: assignment.gold.index });
        falsePositiveEvents.push({ kind, index: assignment.predicted.index });
      }
    });

    goldForKind.forEach((event) => {
      if (!assignedGold.has(event.index)) {
        falseNegative += 1;
        missedEvents.push({ kind, index: event.index });
      }
    });
    predictedForKind.forEach((event) => {
      if (!assignedPredicted.has(event.index)) {
        falsePositive += 1;
        falsePositiveEvents.push({ kind, index: event.index });
      }
    });
    byKind[kind] = createClassificationMetrics(truePositive, falsePositive, falseNegative);
  }

  return {
    boundaryErrors,
    overall: sumClassificationMetrics(Object.values(byKind)),
    byKind,
    missedEvents: sortEventReferences(missedEvents),
    falsePositiveEvents: sortEventReferences(falsePositiveEvents),
    goldCount: goldEvents.length,
    predictedCount: predictedEvents.length
  };
}

interface EditAssignment {
  gold: IndexedEditEvent;
  predicted: IndexedEditEvent;
  boundaryErrors: number[];
  maxBoundaryErrorMs: number;
}

function assignEditEvents(
  goldEvents: readonly IndexedEditEvent[],
  predictedEvents: readonly IndexedEditEvent[],
  boundaryToleranceMs: number
): EditAssignment[] {
  if (goldEvents.length === 0 || predictedEvents.length === 0) {
    return [];
  }

  interface FlowEdge {
    to: number;
    reverseIndex: number;
    capacity: number;
    cost: number;
  }
  interface CandidateFlowEdge {
    edge: FlowEdge;
    assignment: EditAssignment;
  }

  const sourceNode = 0;
  const goldNodeStart = 1;
  const predictedNodeStart = goldNodeStart + goldEvents.length;
  const sinkNode = predictedNodeStart + predictedEvents.length;
  const nodeCount = sinkNode + 1;
  const graph: FlowEdge[][] = Array.from({ length: nodeCount }, () => []);
  const addEdge = (from: number, to: number, capacity: number, cost: number): FlowEdge => {
    const forward: FlowEdge = {
      to,
      reverseIndex: graph[to].length,
      capacity,
      cost
    };
    const reverse: FlowEdge = {
      to: from,
      reverseIndex: graph[from].length,
      capacity: 0,
      cost: -cost
    };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
  };

  goldEvents.forEach((_event, index) => addEdge(sourceNode, goldNodeStart + index, 1, 0));
  predictedEvents.forEach((_event, index) =>
    addEdge(predictedNodeStart + index, sinkNode, 1, 0)
  );
  const candidateEdges: CandidateFlowEdge[] = [];
  goldEvents.forEach((gold, goldIndex) => {
    predictedEvents.forEach((predicted, predictedIndex) => {
      const boundaryErrors = compareEditBoundaries(gold.span, predicted.span);
      const maxBoundaryErrorMs = Math.max(...boundaryErrors);
      if (maxBoundaryErrorMs > boundaryToleranceMs) {
        return;
      }
      const assignment = { gold, predicted, boundaryErrors, maxBoundaryErrorMs };
      const totalBoundaryErrorMs = sum(boundaryErrors);
      const edge = addEdge(
        goldNodeStart + goldIndex,
        predictedNodeStart + predictedIndex,
        1,
        maxBoundaryErrorMs * 16 + totalBoundaryErrorMs
      );
      candidateEdges.push({ edge, assignment });
    });
  });

  // 每次最短增广都会增加一个匹配，因此先得到最大 TP 数，再最小化总边界代价。
  for (;;) {
    const distance = new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
    const previousNode = new Array<number>(nodeCount).fill(-1);
    const previousEdge = new Array<number>(nodeCount).fill(-1);
    distance[sourceNode] = 0;
    for (let iteration = 0; iteration < nodeCount - 1; iteration += 1) {
      let changed = false;
      for (let from = 0; from < nodeCount; from += 1) {
        if (!Number.isFinite(distance[from])) {
          continue;
        }
        graph[from].forEach((edge, edgeIndex) => {
          const candidateDistance = distance[from] + edge.cost;
          if (edge.capacity > 0 && candidateDistance < distance[edge.to]) {
            distance[edge.to] = candidateDistance;
            previousNode[edge.to] = from;
            previousEdge[edge.to] = edgeIndex;
            changed = true;
          }
        });
      }
      if (!changed) {
        break;
      }
    }
    if (!Number.isFinite(distance[sinkNode])) {
      break;
    }
    for (let node = sinkNode; node !== sourceNode; node = previousNode[node]) {
      const from = previousNode[node];
      const edgeIndex = previousEdge[node];
      if (from < 0 || edgeIndex < 0) {
        throw new Error("编辑事件最大匹配增广路径损坏。");
      }
      const edge = graph[from][edgeIndex];
      edge.capacity -= 1;
      graph[node][edge.reverseIndex].capacity += 1;
    }
  }

  const withinTolerance = candidateEdges
    .filter(({ edge }) => edge.capacity === 0)
    .map(({ assignment }) => assignment)
  const assignedGold = new Set(withinTolerance.map((assignment) => assignment.gold.index));
  const assignedPredicted = new Set(
    withinTolerance.map((assignment) => assignment.predicted.index)
  );
  const remainingCandidates: EditAssignment[] = [];
  goldEvents
    .filter((gold) => !assignedGold.has(gold.index))
    .forEach((gold) => {
      predictedEvents
        .filter((predicted) => !assignedPredicted.has(predicted.index))
        .forEach((predicted) => {
          const boundaryErrors = compareEditBoundaries(gold.span, predicted.span);
          remainingCandidates.push({
            gold,
            predicted,
            boundaryErrors,
            maxBoundaryErrorMs: Math.max(...boundaryErrors)
          });
        });
    });
  remainingCandidates.sort(
    (left, right) =>
      left.maxBoundaryErrorMs - right.maxBoundaryErrorMs ||
      sum(left.boundaryErrors) - sum(right.boundaryErrors) ||
      left.gold.index - right.gold.index ||
      left.predicted.index - right.predicted.index
  );
  const outsideTolerance: EditAssignment[] = [];
  for (const candidate of remainingCandidates) {
    if (
      assignedGold.has(candidate.gold.index) ||
      assignedPredicted.has(candidate.predicted.index)
    ) {
      continue;
    }
    assignedGold.add(candidate.gold.index);
    assignedPredicted.add(candidate.predicted.index);
    outsideTolerance.push(candidate);
  }
  return [...withinTolerance, ...outsideTolerance].sort(
    (left, right) =>
      left.gold.index - right.gold.index || left.predicted.index - right.predicted.index
  );
}

function compareEditBoundaries(gold: TimeMapSpan, predicted: TimeMapSpan): number[] {
  const errors = [
    Math.abs(gold.sourceStartMs - predicted.sourceStartMs),
    Math.abs(gold.targetStartMs - predicted.targetStartMs)
  ];
  if (
    gold.sourceEndMs !== gold.sourceStartMs ||
    predicted.sourceEndMs !== predicted.sourceStartMs
  ) {
    errors.push(Math.abs(gold.sourceEndMs - predicted.sourceEndMs));
  }
  if (
    gold.targetEndMs !== gold.targetStartMs ||
    predicted.targetEndMs !== predicted.targetStartMs
  ) {
    errors.push(Math.abs(gold.targetEndMs - predicted.targetEndMs));
  }
  return errors;
}

function collectGoldEditEvents(gold: RealMediaBenchmarkGold): IndexedEditEvent[] {
  return [
    ...gold.sourceOnlySpans.map((span, index) => ({
      kind: "sourceOnly" as const,
      index,
      span
    })),
    ...gold.targetOnlySpans.map((span, index) => ({
      kind: "targetOnly" as const,
      index,
      span
    })),
    ...gold.ambiguousSpans.map((span, index) => ({ kind: "ambiguous" as const, index, span }))
  ];
}

function summarizeCaseResults(
  caseResults: readonly RealMediaBenchmarkCaseResult[]
): RealMediaBenchmarkSummary {
  const anchorErrors = caseResults.flatMap((result) => result.anchorAbsoluteErrorsMs);
  const boundaryErrors = caseResults.flatMap((result) => result.boundaryAbsoluteErrorsMs);
  const sourceDurationMs = sum(caseResults.map((result) => result.sourceDurationMs));
  const coveredSourceDurationMs = sum(
    caseResults.map((result) => result.coveredSourceDurationMs)
  );
  const ambiguousSourceDurationMs = sum(
    caseResults.map((result) => result.ambiguousSourceDurationMs)
  );
  const byKind = createEmptyClassificationByKind();
  for (const kind of EDIT_KINDS) {
    byKind[kind] = sumClassificationMetrics(
      caseResults.map((result) => result.editClassificationByKind[kind])
    );
  }
  return {
    relationCount: caseResults.length,
    realRelationCount: caseResults.filter((result) => result.mediaKind === "real").length,
    missingPredictionCount: caseResults.filter((result) => result.missingPrediction).length,
    structuralFailureCount: sum(caseResults.map((result) => result.structuralFailureCount)),
    monotonicityFailureCount: sum(caseResults.map((result) => result.monotonicityFailureCount)),
    anchorError: createErrorDistribution(anchorErrors),
    mappedAnchorCount: sum(caseResults.map((result) => result.mappedAnchorCount)),
    unmappedAnchorCount: sum(caseResults.map((result) => result.unmappedAnchorCount)),
    boundaryError: createErrorDistribution(boundaryErrors),
    editClassification: sumClassificationMetrics(Object.values(byKind)),
    editClassificationByKind: byKind,
    missedEditCount: sum(caseResults.map((result) => result.missedEvents.length)),
    falsePositiveEditCount: sum(caseResults.map((result) => result.falsePositiveEvents.length)),
    goldEditCount: sum(caseResults.map((result) => result.goldEditCount)),
    predictedEditCount: sum(caseResults.map((result) => result.predictedEditCount)),
    mappingCoverage: safeRatio(coveredSourceDurationMs, sourceDurationMs),
    ambiguousRatio: safeRatio(ambiguousSourceDurationMs, sourceDurationMs)
  };
}

function evaluateC137BenchmarkGate(
  manifest: RealMediaBenchmarkManifest,
  realSummary: RealMediaBenchmarkSummary,
  realCaseResults: readonly RealMediaBenchmarkCaseResult[],
  unexpectedPredictionCaseIds: readonly string[]
): C137BenchmarkGateResult {
  const realCases = manifest.cases.filter(
    (benchmarkCase) => benchmarkCase.mediaKind === "real"
  );
  const scenarioCounts = new Map<RealMediaBenchmarkScenario, number>();
  realCases.forEach((benchmarkCase) =>
    benchmarkCase.scenarios.forEach((scenario) =>
      scenarioCounts.set(scenario, (scenarioCounts.get(scenario) ?? 0) + 1)
    )
  );
  const longReferenceCount = scenarioCounts.get("long-reference") ?? 0;
  const frozenTestCount = realCases.filter(
    (benchmarkCase) => benchmarkCase.split === "frozen-test"
  ).length;
  const frozenTestRatio = realCases.length === 0 ? 0 : frozenTestCount / realCases.length;
  const dataChecks: C137BenchmarkGateCheck[] = [
    createGateCheck(
      "real-relations",
      realCases.length >= C137_BENCHMARK_MINIMUMS.realRelationCount,
      realCases.length,
      `至少 ${C137_BENCHMARK_MINIMUMS.realRelationCount} 组真实媒体关系`
    ),
    createGateCheck(
      "long-reference-relations",
      longReferenceCount >= C137_BENCHMARK_MINIMUMS.longReferenceRelationCount,
      longReferenceCount,
      `至少 ${C137_BENCHMARK_MINIMUMS.longReferenceRelationCount} 组长参考关系`
    ),
    createGateCheck(
      "gold-edit-events",
      realSummary.goldEditCount >= C137_BENCHMARK_MINIMUMS.goldEditCount,
      realSummary.goldEditCount,
      `至少 ${C137_BENCHMARK_MINIMUMS.goldEditCount} 个真实标注编辑事件`
    ),
    createGateCheck(
      "frozen-test-ratio",
      frozenTestRatio >= C137_BENCHMARK_MINIMUMS.frozenTestRatio,
      frozenTestRatio,
      `至少 ${Math.round(C137_BENCHMARK_MINIMUMS.frozenTestRatio * 100)}% 真实关系属于从不参与参数选择的 frozen-test`
    ),
    ...C137_REQUIRED_SCENARIOS.map((scenario) => {
      const count = scenarioCounts.get(scenario) ?? 0;
      return createGateCheck(
        `scenario:${scenario}`,
        count >= C137_BENCHMARK_MINIMUMS.relationsPerRequiredScenario,
        count,
        `场景 ${scenario} 至少 ${C137_BENCHMARK_MINIMUMS.relationsPerRequiredScenario} 组真实关系`
      );
    })
  ];
  if (dataChecks.some((check) => !check.passed)) {
    return {
      scope: "time-map-component",
      status: "insufficient-data",
      verifiedEligible: false,
      dataChecks,
      qualityChecks: [],
      reasons: ["真实关系数量、编辑事件或必需场景覆盖不足，不能宣称 C137 精度已验证。"]
    };
  }

  const realAnchorP95 = realSummary.anchorError.p95Ms;
  const realAnchorMax = realSummary.anchorError.maxMs;
  const realBoundaryP95 = realSummary.boundaryError.p95Ms;
  const minimumRelationCoverage = Math.min(
    ...realCaseResults.map((result) => result.mappingCoverage)
  );
  const maximumRelationAmbiguousRatio = Math.max(
    ...realCaseResults.map((result) => result.ambiguousRatio)
  );
  const longReferenceResults = realCaseResults.filter((result) =>
    result.scenarios.includes("long-reference")
  );
  const longReferenceCoverage = summarizeCaseResults(longReferenceResults).mappingCoverage;
  const qualityChecks: C137BenchmarkGateCheck[] = [
    createGateCheck(
      "all-real-predictions-present",
      realSummary.missingPredictionCount === 0,
      realSummary.missingPredictionCount,
      "真实关系缺失预测数必须为 0"
    ),
    createGateCheck(
      "no-unexpected-predictions",
      unexpectedPredictionCaseIds.length === 0,
      unexpectedPredictionCaseIds.length,
      "清单外预测数必须为 0"
    ),
    createGateCheck(
      "valid-time-map-structure",
      realSummary.structuralFailureCount === 0,
      realSummary.structuralFailureCount,
      "TimeMap 结构失败数必须为 0"
    ),
    createGateCheck(
      "monotonic-time-map",
      realSummary.monotonicityFailureCount === 0,
      realSummary.monotonicityFailureCount,
      "TimeMap 单调性失败数必须为 0"
    ),
    createGateCheck(
      "all-gold-anchors-mapped",
      realSummary.unmappedAnchorCount === 0,
      realSummary.unmappedAnchorCount,
      "gold matched anchor 未映射数必须为 0"
    ),
    createGateCheck(
      "mapping-coverage",
      realSummary.mappingCoverage >= 0.98,
      realSummary.mappingCoverage,
      "真实关系显式 TimeMap 来源轴总覆盖率 ≥ 98%"
    ),
    createGateCheck(
      "per-relation-mapping-coverage",
      minimumRelationCoverage >= 0.95,
      minimumRelationCoverage,
      "每组真实关系的显式 TimeMap 来源轴覆盖率 ≥ 95%"
    ),
    createGateCheck(
      "long-reference-mapping-coverage",
      longReferenceCoverage >= 0.98,
      longReferenceCoverage,
      "长参考关系的显式 TimeMap 来源轴总覆盖率 ≥ 98%"
    ),
    createGateCheck(
      "ambiguous-ratio",
      realSummary.ambiguousRatio <= 0.05,
      realSummary.ambiguousRatio,
      "真实关系 ambiguous 来源轴占比 ≤ 5%"
    ),
    createGateCheck(
      "per-relation-ambiguous-ratio",
      maximumRelationAmbiguousRatio <= 0.25,
      maximumRelationAmbiguousRatio,
      "任一真实关系 ambiguous 来源轴占比 ≤ 25%"
    ),
    createGateCheck(
      "anchor-p95",
      realAnchorP95 !== null && realAnchorP95 <= 200,
      realAnchorP95 ?? "无样本",
      "matched anchor 绝对误差 p95 ≤ 200ms"
    ),
    createGateCheck(
      "anchor-max",
      realAnchorMax !== null && realAnchorMax <= 500,
      realAnchorMax ?? "无样本",
      "当前评测使用 max ≤ 500ms 作为 p99 ≤ 500ms 的保守替代"
    ),
    createGateCheck(
      "boundary-p95",
      realBoundaryP95 !== null && realBoundaryP95 <= 250,
      realBoundaryP95 ?? "无样本",
      "编辑边界绝对误差 p95 ≤ 250ms"
    ),
    createGateCheck(
      "edit-f1",
      realSummary.editClassification.f1 >= 0.97,
      realSummary.editClassification.f1,
      "编辑事件总体 F1 ≥ 0.97"
    ),
    ...EDIT_KINDS.map((kind) =>
      createGateCheck(
        `edit-class:${kind}`,
        realSummary.editClassificationByKind[kind].f1 >= 0.95,
        realSummary.editClassificationByKind[kind].f1,
        `${kind} 分类 F1 ≥ 0.95`
      )
    )
  ];
  const failedChecks = qualityChecks.filter((check) => !check.passed);
  return {
    scope: "time-map-component",
    status: failedChecks.length === 0 ? "pass" : "fail",
    verifiedEligible: false,
    dataChecks,
    qualityChecks,
    reasons:
      failedChecks.length === 0
        ? ["真实媒体数据规模与本模块覆盖的 C137 时间映射质量门槛均已通过。"]
        : failedChecks.map((check) => `${check.id} 未通过：${check.requirement}。`)
  };
}

function createGateCheck(
  id: string,
  passed: boolean,
  actual: number | string | boolean,
  requirement: string
): C137BenchmarkGateCheck {
  return { id, passed, actual, requirement };
}

function createErrorDistribution(values: readonly number[]): BenchmarkErrorDistribution {
  if (values.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, maxMs: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    p50Ms: nearestRankPercentile(sorted, 0.5),
    p95Ms: nearestRankPercentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1]
  };
}

function nearestRankPercentile(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

function createClassificationMetrics(
  truePositive: number,
  falsePositive: number,
  falseNegative: number
): BenchmarkClassificationMetrics {
  const precisionDenominator = truePositive + falsePositive;
  const recallDenominator = truePositive + falseNegative;
  const precision =
    precisionDenominator === 0
      ? falseNegative === 0
        ? 1
        : 0
      : truePositive / precisionDenominator;
  const recall =
    recallDenominator === 0 ? (falsePositive === 0 ? 1 : 0) : truePositive / recallDenominator;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositive, falsePositive, falseNegative, precision, recall, f1 };
}

function sumClassificationMetrics(
  metrics: readonly BenchmarkClassificationMetrics[]
): BenchmarkClassificationMetrics {
  return createClassificationMetrics(
    sum(metrics.map((metric) => metric.truePositive)),
    sum(metrics.map((metric) => metric.falsePositive)),
    sum(metrics.map((metric) => metric.falseNegative))
  );
}

function createEmptyClassificationByKind(): Record<
  BenchmarkEditKind,
  BenchmarkClassificationMetrics
> {
  return {
    sourceOnly: createClassificationMetrics(0, 0, 0),
    targetOnly: createClassificationMetrics(0, 0, 0),
    ambiguous: createClassificationMetrics(0, 0, 0)
  };
}

function measureSpanSourceCoverage(
  spans: readonly TimeMapSpan[],
  kind: TimeMapSpanKind,
  rangeStartMs: number,
  rangeEndMs: number
): number {
  const intervals = spans
    .filter((span) => span.kind === kind)
    .map((span) => ({
      startMs: Math.max(rangeStartMs, span.sourceStartMs),
      endMs: Math.min(rangeEndMs, span.sourceEndMs)
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let total = 0;
  let activeStart: number | null = null;
  let activeEnd = 0;
  for (const interval of intervals) {
    if (activeStart === null) {
      activeStart = interval.startMs;
      activeEnd = interval.endMs;
      continue;
    }
    if (interval.startMs <= activeEnd) {
      activeEnd = Math.max(activeEnd, interval.endMs);
      continue;
    }
    total += activeEnd - activeStart;
    activeStart = interval.startMs;
    activeEnd = interval.endMs;
  }
  return activeStart === null ? 0 : total + activeEnd - activeStart;
}

function measureTimeMapSourceCoverage(
  spans: readonly TimeMapSpan[],
  rangeStartMs: number,
  rangeEndMs: number
): number {
  const intervals = spans
    .map((span) => ({
      startMs: Math.max(rangeStartMs, span.sourceStartMs),
      endMs: Math.min(rangeEndMs, span.sourceEndMs)
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let coveredMs = 0;
  let activeStart: number | null = null;
  let activeEnd = 0;
  for (const interval of intervals) {
    if (activeStart === null) {
      activeStart = interval.startMs;
      activeEnd = interval.endMs;
      continue;
    }
    if (interval.startMs <= activeEnd) {
      activeEnd = Math.max(activeEnd, interval.endMs);
      continue;
    }
    coveredMs += activeEnd - activeStart;
    activeStart = interval.startMs;
    activeEnd = interval.endMs;
  }
  return activeStart === null ? 0 : coveredMs + activeEnd - activeStart;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sortEventReferences(events: BenchmarkEventReference[]): BenchmarkEventReference[] {
  return [...events].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.index - right.index
  );
}

function validatePredictionsOrThrow(
  predictions: readonly RealMediaBenchmarkPrediction[]
): void {
  const ids = new Set<string>();
  for (const prediction of predictions) {
    if (!isNonEmptyString(prediction.caseId) || !Array.isArray(prediction.spans)) {
      throw new Error("真实媒体评测预测必须包含 caseId 和 spans。");
    }
    if (ids.has(prediction.caseId)) {
      throw new Error(`真实媒体评测预测 caseId 重复：${prediction.caseId}。`);
    }
    ids.add(prediction.caseId);
  }
}

function validateManifestCase(value: unknown, caseIndex: number, issues: string[]): void {
  const prefix = `manifest.cases[${caseIndex}]`;
  if (!isRecord(value)) {
    issues.push(`${prefix} 必须是对象。`);
    return;
  }
  validateRequiredString(value.id, `${prefix}.id`, issues);
  validateRequiredString(value.title, `${prefix}.title`, issues);
  if (
    value.mediaKind !== "real" &&
    value.mediaKind !== "synthetic" &&
    value.mediaKind !== "placeholder"
  ) {
    issues.push(`${prefix}.mediaKind 无效。`);
  }
  if (typeof value.split !== "string" || !BENCHMARK_SPLITS.has(value.split as RealMediaBenchmarkSplit)) {
    issues.push(`${prefix}.split 必须为 development 或 frozen-test。`);
  }
  if (
    !Array.isArray(value.scenarios) ||
    value.scenarios.length === 0 ||
    !value.scenarios.every(
      (scenario) =>
        typeof scenario === "string" && SCENARIOS.has(scenario as RealMediaBenchmarkScenario)
    ) ||
    new Set(value.scenarios).size !== value.scenarios.length
  ) {
    issues.push(`${prefix}.scenarios 必须是非空且不重复的已知场景数组。`);
  }
  const isReal = value.mediaKind === "real";
  validateMediaInput(value.source, `${prefix}.source`, isReal, issues);
  validateMediaInput(value.target, `${prefix}.target`, isReal, issues);
  if (!isNonNegativeInteger(value.boundaryToleranceMs)) {
    issues.push(`${prefix}.boundaryToleranceMs 必须是非负整数毫秒。`);
  } else if (isReal && (value.boundaryToleranceMs < 40 || value.boundaryToleranceMs > 100)) {
    issues.push(`${prefix}.boundaryToleranceMs 对真实关系必须位于 40–100ms。`);
  }
  if (!isNonEmptyStringArray(value.versionNotes)) {
    issues.push(`${prefix}.versionNotes 至少需要一条版本说明。`);
  }
  if (!isNonEmptyStringArray(value.licenseNotes)) {
    issues.push(`${prefix}.licenseNotes 至少需要一条许可说明。`);
  }
  validateGold(value.gold, prefix, issues);
  validateIndependentAnnotations(value, prefix, issues);
  validateScenarioGoldConsistency(value, prefix, issues);
  if (isReal) {
    validateRealGoldAnchorDistribution(value.gold, prefix, issues);
  }
}

function validateRealGoldAnchorDistribution(
  gold: unknown,
  casePrefix: string,
  issues: string[]
): void {
  if (!isRecord(gold) || !Array.isArray(gold.matchedAnchors)) {
    return;
  }
  if (
    !isNonNegativeInteger(gold.sourceStartMs) ||
    !isNonNegativeInteger(gold.sourceEndMs) ||
    gold.sourceEndMs <= gold.sourceStartMs
  ) {
    return;
  }
  const anchors = gold.matchedAnchors.filter(
    (anchor): anchor is Record<string, unknown> =>
      isRecord(anchor) && isNonNegativeInteger(anchor.sourceMs)
  );
  if (anchors.length < 5) {
    issues.push(`${casePrefix}.gold 真实关系至少需要 5 个独立 matched anchor。`);
    return;
  }
  const sourceStartMs = gold.sourceStartMs;
  const sourceEndMs = gold.sourceEndMs;
  const durationMs = sourceEndMs - sourceStartMs;
  const occupiedQuintiles = new Set(
    anchors.map((anchor) =>
      Math.min(
        4,
        Math.floor(
          (((anchor.sourceMs as number) - sourceStartMs) / durationMs) * 5
        )
      )
    )
  );
  if (occupiedQuintiles.size < 5) {
    issues.push(
      `${casePrefix}.gold 真实关系的 matched anchor 必须覆盖来源时间轴全部五个等分区间。`
    );
  }
}

function validateScenarioGoldConsistency(
  benchmarkCase: Record<string, unknown>,
  prefix: string,
  issues: string[]
): void {
  if (!Array.isArray(benchmarkCase.scenarios) || !isRecord(benchmarkCase.gold)) {
    return;
  }
  const scenarios = new Set(
    benchmarkCase.scenarios.filter((item): item is string => typeof item === "string")
  );
  const gold = benchmarkCase.gold;
  const sourceOnlyCount = Array.isArray(gold.sourceOnlySpans) ? gold.sourceOnlySpans.length : 0;
  const targetOnlyCount = Array.isArray(gold.targetOnlySpans) ? gold.targetOnlySpans.length : 0;
  const ambiguousCount = Array.isArray(gold.ambiguousSpans) ? gold.ambiguousSpans.length : 0;
  if (scenarios.has("source-only") && sourceOnlyCount === 0) {
    issues.push(`${prefix} 声明 source-only 场景但没有 sourceOnly gold 区间。`);
  }
  if (scenarios.has("target-only") && targetOnlyCount === 0) {
    issues.push(`${prefix} 声明 target-only 场景但没有 targetOnly gold 区间。`);
  }
  if (scenarios.has("ambiguous") && ambiguousCount === 0) {
    issues.push(`${prefix} 声明 ambiguous 场景但没有 ambiguous gold 区间。`);
  }
  if (scenarios.has("multi-edit") && sourceOnlyCount + targetOnlyCount + ambiguousCount < 2) {
    issues.push(`${prefix} 声明 multi-edit 场景但 gold 编辑事件少于 2 个。`);
  }
}

function validateMediaInput(
  value: unknown,
  prefix: string,
  requireIdentity: boolean,
  issues: string[]
): void {
  if (!isRecord(value)) {
    issues.push(`${prefix} 必须是对象。`);
    return;
  }
  validateRequiredString(value.path, `${prefix}.path`, issues);
  if (!isNonNegativeInteger(value.audioStreamIndex)) {
    issues.push(`${prefix}.audioStreamIndex 必须显式指定为非负整数。`);
  }
  if (value.videoStreamIndex !== null && !isNonNegativeInteger(value.videoStreamIndex)) {
    issues.push(`${prefix}.videoStreamIndex 必须为非负整数或 null。`);
  }
  if (value.contentIdentity === null) {
    if (requireIdentity) {
      issues.push(`${prefix}.contentIdentity 真实媒体必须绑定全文件 SHA-256。`);
    }
  } else if (!isBenchmarkContentIdentity(value.contentIdentity)) {
    issues.push(`${prefix}.contentIdentity 必须是 sha256-full-file-v2 全文件身份。`);
  }
  validateRequiredString(value.versionNote, `${prefix}.versionNote`, issues);
  validateRequiredString(value.licenseNote, `${prefix}.licenseNote`, issues);
}

function validateIndependentAnnotations(
  benchmarkCase: Record<string, unknown>,
  prefix: string,
  issues: string[]
): void {
  const annotations = benchmarkCase.independentAnnotations;
  const isReal = benchmarkCase.mediaKind === "real";
  if (!Array.isArray(annotations)) {
    issues.push(`${prefix}.independentAnnotations 必须是数组。`);
    return;
  }
  if (isReal && annotations.length < 2) {
    issues.push(`${prefix}.independentAnnotations 真实关系至少需要两名独立复核者。`);
  }
  const reviewerIds = new Set<string>();
  annotations.forEach((annotation, index) => {
    const annotationPrefix = `${prefix}.independentAnnotations[${index}]`;
    if (!isRecord(annotation)) {
      issues.push(`${annotationPrefix} 必须是对象。`);
      return;
    }
    validateRequiredString(annotation.reviewerId, `${annotationPrefix}.reviewerId`, issues);
    if (typeof annotation.reviewerId === "string") {
      if (reviewerIds.has(annotation.reviewerId)) {
        issues.push(`${annotationPrefix}.reviewerId 必须与其他复核者不同。`);
      }
      reviewerIds.add(annotation.reviewerId);
    }
    validateGold(annotation.gold, annotationPrefix, issues);
  });

  if (!isReal) {
    if (benchmarkCase.adjudication !== null) {
      validateAdjudication(benchmarkCase.adjudication, prefix, false, reviewerIds, issues);
    }
    return;
  }
  if (annotations.length < 2 || !isRecord(annotations[0]) || !isRecord(annotations[1])) {
    return;
  }
  const toleranceMs = isNonNegativeInteger(benchmarkCase.boundaryToleranceMs)
    ? benchmarkCase.boundaryToleranceMs
    : 0;
  const requiresAdjudication = annotationsDisagreeBeyondTolerance(
    annotations[0].gold,
    annotations[1].gold,
    toleranceMs
  );
  validateAdjudication(
    benchmarkCase.adjudication,
    prefix,
    requiresAdjudication,
    reviewerIds,
    issues
  );
  if (
    !requiresAdjudication &&
    isRecord(benchmarkCase.adjudication) &&
    benchmarkCase.adjudication.status === "not-needed" &&
    (annotationsDisagreeBeyondTolerance(annotations[0].gold, benchmarkCase.gold, toleranceMs) ||
      annotationsDisagreeBeyondTolerance(annotations[1].gold, benchmarkCase.gold, toleranceMs))
  ) {
    issues.push(
      `${prefix}.gold 必须与两份独立标注保持在容差内；否则需要记录第三人仲裁。`
    );
  }
}

function validateAdjudication(
  value: unknown,
  prefix: string,
  required: boolean,
  reviewerIds: ReadonlySet<string>,
  issues: string[]
): void {
  const field = `${prefix}.adjudication`;
  if (!isRecord(value)) {
    issues.push(`${field} 真实关系必须记录是否需要仲裁。`);
    return;
  }
  if (value.status !== "not-needed" && value.status !== "resolved") {
    issues.push(`${field}.status 必须为 not-needed 或 resolved。`);
  }
  validateRequiredString(value.note, `${field}.note`, issues);
  if (required) {
    if (value.status !== "resolved") {
      issues.push(`${field} 两份独立标注超出容差或结构不一致，必须完成仲裁。`);
    }
    if (!isNonEmptyString(value.adjudicatorId)) {
      issues.push(`${field}.adjudicatorId 仲裁时必须填写。`);
    } else if (reviewerIds.has(value.adjudicatorId)) {
      issues.push(`${field}.adjudicatorId 必须独立于两名原始复核者。`);
    }
  } else if (value.status === "not-needed" && value.adjudicatorId !== null) {
    issues.push(`${field}.adjudicatorId 无需仲裁时必须为 null。`);
  }
}

function isBenchmarkContentIdentity(value: unknown): value is RealMediaBenchmarkContentIdentity {
  return (
    isRecord(value) &&
    value.algorithm === "sha256-full-file-v2" &&
    isNonNegativeInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    typeof value.digest === "string" &&
    SHA256_HEX.test(value.digest)
  );
}

interface AnnotationBoundaryVector {
  key: string;
  values: number[];
}

function annotationsDisagreeBeyondTolerance(
  first: unknown,
  second: unknown,
  toleranceMs: number
): boolean {
  const firstVectors = collectAnnotationBoundaryVectors(first);
  const secondVectors = collectAnnotationBoundaryVectors(second);
  if (firstVectors === null || secondVectors === null || firstVectors.length !== secondVectors.length) {
    return true;
  }
  return firstVectors.some((firstVector, index) => {
    const secondVector = secondVectors[index];
    return (
      secondVector === undefined ||
      firstVector.key !== secondVector.key ||
      firstVector.values.length !== secondVector.values.length ||
      firstVector.values.some(
        (value, valueIndex) =>
          Math.abs(value - (secondVector.values[valueIndex] ?? Number.POSITIVE_INFINITY)) > toleranceMs
      )
    );
  });
}

function collectAnnotationBoundaryVectors(gold: unknown): AnnotationBoundaryVector[] | null {
  if (!isRecord(gold) || !Array.isArray(gold.matchedAnchors)) {
    return null;
  }
  const totalRange = [gold.sourceStartMs, gold.sourceEndMs, gold.targetStartMs, gold.targetEndMs];
  if (!totalRange.every(isNonNegativeInteger)) {
    return null;
  }
  const vectors: AnnotationBoundaryVector[] = [
    { key: "total-range", values: totalRange }
  ];
  const anchors = gold.matchedAnchors
    .map((anchor) => {
      if (
        !isRecord(anchor) ||
        !isNonEmptyString(anchor.id) ||
        !isNonNegativeInteger(anchor.sourceMs) ||
        !isNonNegativeInteger(anchor.targetMs)
      ) {
        return null;
      }
      return {
        key: `anchor:${anchor.id}`,
        values: [anchor.sourceMs, anchor.targetMs]
      } satisfies AnnotationBoundaryVector;
    })
    .filter((item): item is AnnotationBoundaryVector => item !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  if (anchors.length !== gold.matchedAnchors.length) {
    return null;
  }
  vectors.push(...anchors);
  for (const kind of EDIT_KINDS) {
    const field = `${kind}Spans`;
    const rawSpansValue: unknown = gold[field];
    if (!Array.isArray(rawSpansValue)) {
      return null;
    }
    const spans: TimeMapSpan[] = [];
    for (const spanValue of rawSpansValue as unknown[]) {
      if (!isTimeMapSpan(spanValue) || spanValue.kind !== kind) {
        return null;
      }
      spans.push(spanValue);
    }
    spans.sort(
      (left, right) =>
        left.sourceStartMs - right.sourceStartMs ||
        left.targetStartMs - right.targetStartMs ||
        left.sourceEndMs - right.sourceEndMs ||
        left.targetEndMs - right.targetEndMs
    );
    spans.forEach((span, index) =>
      vectors.push({
        key: `${kind}:${index}`,
        values: [span.sourceStartMs, span.sourceEndMs, span.targetStartMs, span.targetEndMs]
      })
    );
  }
  return vectors;
}

function validateGold(value: unknown, casePrefix: string, issues: string[]): void {
  const prefix = `${casePrefix}.gold`;
  if (!isRecord(value)) {
    issues.push(`${prefix} 必须是对象。`);
    return;
  }
  const sourceStartMs = value.sourceStartMs;
  const sourceEndMs = value.sourceEndMs;
  const targetStartMs = value.targetStartMs;
  const targetEndMs = value.targetEndMs;
  if (
    !isNonNegativeInteger(sourceStartMs) ||
    !isNonNegativeInteger(sourceEndMs) ||
    sourceEndMs <= sourceStartMs ||
    !isNonNegativeInteger(targetStartMs) ||
    !isNonNegativeInteger(targetEndMs) ||
    targetEndMs <= targetStartMs
  ) {
    issues.push(`${prefix} 的来源或目标总范围无效。`);
    return;
  }
  if (!Array.isArray(value.matchedAnchors) || value.matchedAnchors.length === 0) {
    issues.push(`${prefix}.matchedAnchors 至少需要一个 gold anchor。`);
  } else {
    const anchorIds = new Set<string>();
    value.matchedAnchors.forEach((anchor, anchorIndex) => {
      if (
        !isRecord(anchor) ||
        !isNonEmptyString(anchor.id) ||
        !isNonNegativeInteger(anchor.sourceMs) ||
        !isNonNegativeInteger(anchor.targetMs) ||
        anchor.sourceMs < sourceStartMs ||
        anchor.sourceMs >= sourceEndMs ||
        anchor.targetMs < targetStartMs ||
        anchor.targetMs >= targetEndMs
      ) {
        issues.push(`${prefix}.matchedAnchors[${anchorIndex}] 无效或超出 gold 总范围。`);
        return;
      }
      if (anchorIds.has(anchor.id)) {
        issues.push(`${prefix}.matchedAnchors[${anchorIndex}].id 重复。`);
      }
      anchorIds.add(anchor.id);
    });
  }
  validateGoldSpans(value.sourceOnlySpans, "sourceOnly", value, prefix, issues);
  validateGoldSpans(value.targetOnlySpans, "targetOnly", value, prefix, issues);
  validateGoldSpans(value.ambiguousSpans, "ambiguous", value, prefix, issues);
}

function validateGoldSpans(
  value: unknown,
  expectedKind: BenchmarkEditKind,
  goldRange: Record<string, unknown>,
  prefix: string,
  issues: string[]
): void {
  const field = `${expectedKind}Spans`;
  if (!Array.isArray(value)) {
    issues.push(`${prefix}.${field} 必须是数组。`);
    return;
  }
  value.forEach((span, spanIndex) => {
    if (!isTimeMapSpan(span) || span.kind !== expectedKind) {
      issues.push(`${prefix}.${field}[${spanIndex}] 结构或 kind 无效。`);
      return;
    }
    const validation = validateTimeMap([span]);
    if (!validation.valid) {
      issues.push(`${prefix}.${field}[${spanIndex}] 形状无效。`);
      return;
    }
    if (
      span.sourceStartMs < Number(goldRange.sourceStartMs) ||
      span.sourceEndMs > Number(goldRange.sourceEndMs) ||
      span.targetStartMs < Number(goldRange.targetStartMs) ||
      span.targetEndMs > Number(goldRange.targetEndMs)
    ) {
      issues.push(`${prefix}.${field}[${spanIndex}] 超出 gold 总范围。`);
    }
  });
}

function isBenchmarkCaseResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.caseId) &&
    (value.mediaKind === "real" ||
      value.mediaKind === "synthetic" ||
      value.mediaKind === "placeholder") &&
    Array.isArray(value.scenarios) &&
    value.scenarios.every(
      (scenario) =>
        typeof scenario === "string" && SCENARIOS.has(scenario as RealMediaBenchmarkScenario)
    ) &&
    typeof value.missingPrediction === "boolean" &&
    typeof value.structureValid === "boolean" &&
    isStringArray(value.structureIssues) &&
    isNonNegativeInteger(value.structuralFailureCount) &&
    isNonNegativeInteger(value.monotonicityFailureCount) &&
    isNonNegativeNumberArray(value.anchorAbsoluteErrorsMs) &&
    isErrorDistribution(value.anchorError) &&
    isNonNegativeInteger(value.mappedAnchorCount) &&
    isNonNegativeInteger(value.unmappedAnchorCount) &&
    isNonNegativeNumberArray(value.boundaryAbsoluteErrorsMs) &&
    isErrorDistribution(value.boundaryError) &&
    isClassificationMetrics(value.editClassification) &&
    isClassificationByKind(value.editClassificationByKind) &&
    isEventReferenceArray(value.missedEvents) &&
    isEventReferenceArray(value.falsePositiveEvents) &&
    isNonNegativeInteger(value.goldEditCount) &&
    isNonNegativeInteger(value.predictedEditCount) &&
    isNonNegativeInteger(value.sourceDurationMs) &&
    isNonNegativeInteger(value.coveredSourceDurationMs) &&
    isNonNegativeInteger(value.matchedSourceDurationMs) &&
    isNonNegativeInteger(value.ambiguousSourceDurationMs) &&
    isUnitNumber(value.mappingCoverage) &&
    isUnitNumber(value.ambiguousRatio)
  );
}

function isBenchmarkScenarioSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.scenario === "string" &&
    SCENARIOS.has(value.scenario as RealMediaBenchmarkScenario) &&
    isBenchmarkSummary(value)
  );
}

function isBenchmarkSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.relationCount) &&
    isNonNegativeInteger(value.realRelationCount) &&
    isNonNegativeInteger(value.missingPredictionCount) &&
    isNonNegativeInteger(value.structuralFailureCount) &&
    isNonNegativeInteger(value.monotonicityFailureCount) &&
    isErrorDistribution(value.anchorError) &&
    isNonNegativeInteger(value.mappedAnchorCount) &&
    isNonNegativeInteger(value.unmappedAnchorCount) &&
    isErrorDistribution(value.boundaryError) &&
    isClassificationMetrics(value.editClassification) &&
    isClassificationByKind(value.editClassificationByKind) &&
    isNonNegativeInteger(value.missedEditCount) &&
    isNonNegativeInteger(value.falsePositiveEditCount) &&
    isNonNegativeInteger(value.goldEditCount) &&
    isNonNegativeInteger(value.predictedEditCount) &&
    isUnitNumber(value.mappingCoverage) &&
    isUnitNumber(value.ambiguousRatio)
  );
}

function isErrorDistribution(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sampleCount) &&
    isNonNegativeNumberOrNull(value.p50Ms) &&
    isNonNegativeNumberOrNull(value.p95Ms) &&
    isNonNegativeNumberOrNull(value.maxMs) &&
    (value.sampleCount > 0
      ? value.p50Ms !== null && value.p95Ms !== null && value.maxMs !== null
      : value.p50Ms === null && value.p95Ms === null && value.maxMs === null)
  );
}

function isClassificationByKind(value: unknown): boolean {
  return isRecord(value) && EDIT_KINDS.every((kind) => isClassificationMetrics(value[kind]));
}

function isClassificationMetrics(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.truePositive) &&
    isNonNegativeInteger(value.falsePositive) &&
    isNonNegativeInteger(value.falseNegative) &&
    isUnitNumber(value.precision) &&
    isUnitNumber(value.recall) &&
    isUnitNumber(value.f1)
  );
}

function isEventReferenceArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (event) =>
        isRecord(event) &&
        (event.kind === "sourceOnly" ||
          event.kind === "targetOnly" ||
          event.kind === "ambiguous") &&
        isNonNegativeInteger(event.index)
    )
  );
}

function isC137GateResult(value: unknown): value is C137BenchmarkGateResult {
  return (
    isRecord(value) &&
    value.scope === "time-map-component" &&
    (value.status === "insufficient-data" ||
      value.status === "pass" ||
      value.status === "fail") &&
    value.verifiedEligible === false &&
    Array.isArray(value.dataChecks) &&
    value.dataChecks.every(isGateCheck) &&
    Array.isArray(value.qualityChecks) &&
    value.qualityChecks.every(isGateCheck) &&
    isNonEmptyStringArray(value.reasons)
  );
}

function isTimeMapComponentGateSelfConsistent(value: C137BenchmarkGateResult): boolean {
  const dataPassed = value.dataChecks.every((check) => check.passed);
  const qualityPassed =
    value.qualityChecks.length > 0 && value.qualityChecks.every((check) => check.passed);
  if (value.status === "insufficient-data") {
    return !dataPassed && value.qualityChecks.length === 0;
  }
  if (!dataPassed || value.qualityChecks.length === 0) {
    return false;
  }
  return value.status === "pass" ? qualityPassed : !qualityPassed;
}

function deepEqualUnknown(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqualUnknown(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && deepEqualUnknown(left[key], right[key])
    )
  );
}

function isGateCheck(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.passed === "boolean" &&
    (typeof value.actual === "number" ||
      typeof value.actual === "string" ||
      typeof value.actual === "boolean") &&
    isNonEmptyString(value.requirement)
  );
}

function isTimeMapSpan(value: unknown): value is TimeMapSpan {
  return (
    isRecord(value) &&
    (value.kind === "matched" ||
      value.kind === "sourceOnly" ||
      value.kind === "targetOnly" ||
      value.kind === "ambiguous") &&
    isNonNegativeInteger(value.sourceStartMs) &&
    isNonNegativeInteger(value.sourceEndMs) &&
    isNonNegativeInteger(value.targetStartMs) &&
    isNonNegativeInteger(value.targetEndMs)
  );
}

function validateRequiredString(value: unknown, field: string, issues: string[]): void {
  if (!isNonEmptyString(value)) {
    issues.push(`${field} 必须是非空字符串。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumberOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isNonNegativeNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)
  );
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
