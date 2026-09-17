import type {
  CompleteTimeMapSpan,
  TimeMapBoundaryEvidence,
  TimeMapSpan
} from "../domain/alignment/timeMap";

/** Minimal complete v12 span evidence for tests whose subject is not boundary estimation. */
export function createTestCompleteTimeMapSpan(
  span: TimeMapSpan,
  id = "test-span-1"
): CompleteTimeMapSpan {
  const boundary = (): TimeMapBoundaryEvidence => ({
    status: "notApplicable",
    axis: null,
    contextSide: null,
    coarseMs: null,
    refinedMs: null,
    uncertaintyStartMs: null,
    uncertaintyEndMs: null,
    supportDurationMs: null,
    correlation: null,
    alternativeMargin: null,
    reason: "该测试不评估片段边界。"
  });
  return {
    ...span,
    id,
    reason: "testFixture",
    quality: {
      level: "review",
      metricSource: "missing",
      probability: null,
      coverage: null,
      uniqueContentCoverage: null,
      alternativeMargin: null,
      anchorCount: 0,
      heldOutAnchorCount: 0,
      p50ResidualMs: null,
      p95ResidualMs: null,
      p99ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      leftSupport: "notApplicable",
      rightSupport: "notApplicable",
      signals: { audio: "blocked", visual: "blocked", danmaku: "blocked" },
      reasons: ["该测试不评估逐段质量。"]
    },
    boundaries: { start: boundary(), end: boundary() },
    alternatives: []
  };
}
