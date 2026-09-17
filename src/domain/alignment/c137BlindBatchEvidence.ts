import type { C137Digest } from "./c137Acceptance";
import {
  validateRealMediaBenchmarkManifest,
  type BenchmarkErrorDistribution,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput
} from "./realMediaBenchmark";
import {
  validateRealMediaBlindBatchExecutionSuite,
  validateRealMediaBlindBatchRunReceipt,
  type RealMediaBlindBatchExecutionSuite
} from "./realMediaBlindBatchContract";
import { mapSourceTime, validateTimeMap, type TimeMapSpan } from "./timeMap";
import { sha256Hex } from "../shared/sha256";

export const C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION = 1 as const;

const PROJECTION_DOMAIN = "c137-blind-batch-execution-projection-v1";
const RAW_PREDICTION_DOMAIN = "c137-blind-batch-raw-prediction-v1";
const EVIDENCE_DOMAIN = "c137-blind-batch-benchmark-evidence-v1";
const DERIVED_RELATIONSHIP_DECISION_DOMAIN =
  "c137-blind-batch-derived-relationship-decision-v1";
const SUITE_DOMAIN = "c137-blind-batch-suite-v1";
const MEDIA_BINDING_COMMITMENT_DOMAIN = "c137-blind-batch-media-binding-v1";
const MINIMUM_TOP_K = 2;
const MAXIMUM_TOP_K = 20;
const MAXIMUM_MEDIA_PER_SIDE = 256;
const MAXIMUM_PAIR_COUNT = 256;
const MAXIMUM_SPANS_PER_PAIR = 4_096;
const OPAQUE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type C137BlindBatchRelationshipAxis = "source" | "target";
export type C137BlindBatchPairOutcomeStatus = "candidate" | "blocked";

export interface C137BlindBatchProjectionOptions {
  /** Caller-declared cross-media relationship query axis; it is never inferred from gold. */
  relationshipAxis: C137BlindBatchRelationshipAxis;
  /** Must equal the native execution setting; disabled video streams cannot create candidates. */
  visualEvidenceEnabled: boolean;
  /**
   * K for ranking distinct media pairs on the declared relationship axis. C137 v1 does not use
   * this value to evaluate alternative windows inside one source/target pair.
   */
  topK: number;
  /**
   * Optional frozen decision/query subset for one bounded native batch. When present it must be
   * unique and preserve manifest order; the identifiers never enter the gold-free projection.
   */
  caseIds?: readonly string[];
  /**
   * Optional frozen candidate-universe subset. It must be unique and preserve manifest order.
   * A formal matrix tile may omit a query's gold candidate; only the exhaustive matrix aggregator
   * may combine such shards. The single-batch evidence compiler still requires every gold pair.
   * Omission retains the legacy behavior: candidates equal decisions.
   */
  candidateCaseIds?: readonly string[];
}

export interface C137BlindBatchMediaProjection {
  mediaId: string;
  /** Salted commitment to full identity + explicit streams; never the media hash itself. */
  bindingCommitment: C137Digest;
  audioStreamIndex: number;
  videoStreamIndex: number | null;
}

export interface C137BlindBatchPairProjection {
  pairId: string;
  sourceMediaId: string;
  targetMediaId: string;
}

/** Gold-free, path-free shape that a native batch runner may consume or bind. */
export interface C137BlindBatchExecutionProjection {
  schemaVersion: typeof C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION;
  kind: "c137-blind-batch-execution-projection";
  suiteId: string;
  /** Cross-media pair-ranking K, not native within-pair window K. */
  topK: number;
  relationshipAxis: C137BlindBatchRelationshipAxis;
  visualEvidenceEnabled: boolean;
  sources: C137BlindBatchMediaProjection[];
  targets: C137BlindBatchMediaProjection[];
  pairs: C137BlindBatchPairProjection[];
  projectionDigest: C137Digest;
}

/** Minimal prediction geometry. Derived errors are deliberately not representable here. */
export interface C137BlindBatchPredictedSpan {
  kind: TimeMapSpan["kind"];
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
}

export interface C137BlindBatchPairOutcome {
  pairId: string;
  sourceMediaId: string;
  targetMediaId: string;
  status: C137BlindBatchPairOutcomeStatus;
  proposalTimeMapSpans: C137BlindBatchPredictedSpan[];
}

export interface C137BlindBatchSourceRanking {
  sourceMediaId: string;
  rankedPairIds: string[];
}

export interface C137BlindBatchTargetRanking {
  targetMediaId: string;
  rankedPairIds: string[];
}

export interface C137BlindBatchNativeShortlist {
  shortlistedPairIds: string[];
  nonShortlistedPairIds: string[];
}

export interface C137BlindBatchRawPredictionDraft {
  schemaVersion: typeof C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION;
  kind: "c137-blind-batch-raw-prediction";
  suiteId: string;
  projectionDigest: C137Digest;
  executionDigest: C137Digest;
  nativeReceiptDigest: C137Digest;
  /** Cross-media pair-ranking K, not native within-pair window K. */
  topK: number;
  pairOutcomes: C137BlindBatchPairOutcome[];
  sourceRankings: C137BlindBatchSourceRanking[];
  targetRankings: C137BlindBatchTargetRanking[];
  nativeShortlist: C137BlindBatchNativeShortlist;
}

/** Path-free normalized prediction, bound to both the execution and native runner receipt. */
export interface C137BlindBatchRawPrediction extends C137BlindBatchRawPredictionDraft {
  receiptDigest: C137Digest;
}

/** Private, gold-revealing decision. It must never enter the aggregate shareable DTO. */
export interface C137BlindBatchDerivedRelationshipDecision {
  suiteId: string;
  caseId: string;
  provenanceRef: C137Digest;
  goldPairId: string;
  rankedPairIds: string[];
}

interface C137BlindBatchCaseMeasurement {
  top1Hit: boolean;
  topKHit: boolean;
  goldPairShortlisted: boolean;
  /** Wrong cross-media pair at rank 1; this is not a wrong window inside one long pair. */
  top1WrongRelationship: boolean;
  knownPairMappedAnchorCount: number;
  knownPairUnmappedAnchorCount: number;
  /** Absolute timing errors for mapped anchors only; blocked/unmapped anchors are excluded. */
  knownPairMappedAnchorAbsoluteErrorsMs: number[];
}

/**
 * Aggregate-only self-consistent component evidence. Per-case identifiers, gold pair mappings and
 * rankings deliberately stay private. This does not prove native provenance, release quality,
 * within-pair window Top-K, edit classification, or cut-boundary accuracy.
 */
export interface C137BlindBatchBenchmarkEvidence {
  schemaVersion: typeof C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION;
  kind: "c137-blind-batch-benchmark-evidence";
  scope: "cross-media-relationship-and-known-pair-anchor-component";
  releaseEligible: false;
  trustStatus: "untrusted-self-consistent-evidence";
  manifestId: string;
  datasetVersion: string;
  suiteId: string;
  projectionDigest: C137Digest;
  executionDigest: C137Digest;
  nativeReceiptDigest: C137Digest;
  rawPredictionDigest: C137Digest;
  topK: number;
  relationshipAxis: C137BlindBatchRelationshipAxis;
  decisionCount: number;
  top1HitCount: number;
  topKHitCount: number;
  top1Accuracy: number;
  topKAccuracy: number;
  shortlistedGoldPairCount: number;
  top1WrongRelationshipCount: number;
  knownPairMappedAnchorCount: number;
  knownPairUnmappedAnchorCount: number;
  knownPairAnchorCoverage: number;
  knownPairMappedAnchorError: BenchmarkErrorDistribution & { p99Ms: number | null };
  evidenceDigest: C137Digest;
}

export interface C137BlindBatchEvidenceValidationResult {
  valid: boolean;
  issues: string[];
}

interface C137BlindBatchManifestModel {
  selectedCases: RealMediaBenchmarkCase[];
  sourceMediaIdByCaseId: Map<string, string>;
  targetMediaIdByCaseId: Map<string, string>;
  pairIdByMediaIds: Map<string, string>;
  projection: C137BlindBatchExecutionProjection;
}

/**
 * Build the only execution projection accepted by the compiler. It contains no path, SHA-256,
 * case id, split, scenario, annotation, adjudication or gold timestamp.
 */
export function createC137BlindBatchExecutionProjection(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchProjectionOptions
): C137BlindBatchExecutionProjection {
  return buildManifestModel(manifest, options).projection;
}

/**
 * A single public benchmark may reveal gold accuracy only when its local candidate universe is
 * complete. Formal matrix tiles deliberately bypass this guard and are aggregated only after the
 * exhaustive query×candidate coverage has completed.
 */
export function assertC137BlindBatchSingleBatchCandidateUniverse(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchProjectionOptions,
  projection: C137BlindBatchExecutionProjection
): void {
  const model = buildManifestModel(manifest, options);
  assertProjectionMatchesManifestModel(projection, model);
  assertCompleteSingleBatchCandidateUniverse(model);
}

/**
 * Deduplicate and independently permute one media side without consulting case pairing or gold.
 * The opaque hash ordering prevents episode-like size/digest ordering from becoming an ID oracle.
 */
export function orderC137BlindBatchMediaInputs(
  manifestId: string,
  datasetVersion: string,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[]
): RealMediaBenchmarkMediaInput[] {
  const uniqueByBindingKey = new Map<string, RealMediaBenchmarkMediaInput>();
  for (const media of mediaInputs) {
    const bindingKey = mediaBindingKey(media, visualEvidenceEnabled);
    if (!uniqueByBindingKey.has(bindingKey)) {
      uniqueByBindingKey.set(bindingKey, structuredClone(media));
    }
  }
  return [...uniqueByBindingKey.entries()]
    .map(([bindingKey, media]) => ({
      bindingKey,
      bindingCommitment: createC137BlindBatchMediaBindingCommitment(
        manifestId,
        datasetVersion,
        side,
        visualEvidenceEnabled,
        media
      ),
      media
    }))
    .sort(
      (left, right) =>
        compareAscii(left.bindingCommitment, right.bindingCommitment) ||
        compareAscii(left.bindingKey, right.bindingKey)
    )
    .map((entry) => structuredClone(entry.media));
}

export function createC137BlindBatchMediaBindingCommitment(
  manifestId: string,
  datasetVersion: string,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  media: RealMediaBenchmarkMediaInput
): C137Digest {
  return `sha256:${sha256Hex(
    JSON.stringify([
      MEDIA_BINDING_COMMITMENT_DOMAIN,
      manifestId,
      datasetVersion,
      side,
      visualEvidenceEnabled,
      mediaBindingKey(media, visualEvidenceEnabled)
    ])
  )}`;
}

export function computeC137BlindBatchProjectionDigest(
  projection: Omit<C137BlindBatchExecutionProjection, "projectionDigest">
): C137Digest {
  return digest(PROJECTION_DOMAIN, canonicalProjectionPayload(projection));
}

/**
 * Integrity seal for a normalized payload only. This digest does not attest that native code ran
 * or that `nativeReceiptDigest` came from the governed runner.
 */
export function sealC137BlindBatchRawPrediction(
  draft: C137BlindBatchRawPredictionDraft
): C137BlindBatchRawPrediction {
  const cloned = structuredClone(draft);
  assertRawPredictionDraftShape(cloned);
  return {
    ...cloned,
    receiptDigest: computeC137BlindBatchRawPredictionDigest(cloned)
  };
}

/**
 * Strictly bind a gold-free projection to one full-Cartesian native execution and derive the only
 * accepted path-free raw prediction. Serialized ranking arrays are validated and recomputed by
 * the native receipt contract before they are normalized here.
 */
export function deriveC137BlindBatchRawPredictionFromNativeReceipt(
  projectionValue: unknown,
  executionSuiteValue: unknown,
  nativeReceiptValue: unknown
): C137BlindBatchRawPrediction {
  const projection = assertExecutionProjectionShape(projectionValue);
  const executionSuite = validateRealMediaBlindBatchExecutionSuite(executionSuiteValue);
  validateProjectionExecutionSuiteBinding(projection, executionSuite);
  const receipt = validateRealMediaBlindBatchRunReceipt(nativeReceiptValue, executionSuite);
  if (
    receipt.status !== "completed" ||
    receipt.pairOutcomes.some((outcome) => outcome.nativeStatus !== "completed")
  ) {
    throw new Error(
      "blind batch raw prediction 只允许从整批 completed 且每个 pair completed 的 native receipt 派生。"
    );
  }

  const pairIdByOrdinal = new Map<number, string>();
  executionSuite.pairs.forEach((pair, index) => {
    const projectedPair = projection.pairs[index];
    if (projectedPair === undefined) {
      throw new Error("blind batch execution pair 数量超过 projection。");
    }
    pairIdByOrdinal.set(pair.pairOrdinal, projectedPair.pairId);
  });
  const requirePairId = (ordinal: number): string => {
    const pairId = pairIdByOrdinal.get(ordinal);
    if (pairId === undefined) {
      throw new Error(`native receipt pairOrdinal ${ordinal} 无 projection pair。`);
    }
    return pairId;
  };
  const shortlistedPairIds = new Set(
    receipt.pairOutcomes
      .filter((outcome) => outcome.globalSelected)
      .map((outcome) => requirePairId(outcome.pairOrdinal))
  );

  const rawPrediction = sealC137BlindBatchRawPrediction({
    schemaVersion: C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION,
    kind: "c137-blind-batch-raw-prediction",
    suiteId: projection.suiteId,
    projectionDigest: projection.projectionDigest,
    executionDigest: receipt.executionDigest,
    nativeReceiptDigest: receipt.receiptDigest,
    topK: projection.topK,
    pairOutcomes: receipt.pairOutcomes.map((outcome, index) => {
      const projectedPair = projection.pairs[index];
      if (projectedPair === undefined) {
        throw new Error("native receipt pair 数量超过 projection。");
      }
      const proposal = outcome.proposalTimeMap;
      const candidate =
        outcome.globalSelected &&
        proposal !== null &&
        (proposal.quality.level === "review" || proposal.quality.level === "verified") &&
        proposal.spans.some((span) => span.kind === "matched");
      return {
        pairId: requirePairId(outcome.pairOrdinal),
        sourceMediaId: projectedPair.sourceMediaId,
        targetMediaId: projectedPair.targetMediaId,
        status: candidate ? "candidate" : "blocked",
        proposalTimeMapSpans:
          proposal?.spans.map((span) => ({
            kind: span.kind,
            sourceStartMs: span.sourceStartMs,
            sourceEndMs: span.sourceEndMs,
            targetStartMs: span.targetStartMs,
            targetEndMs: span.targetEndMs
          })) ?? []
      };
    }),
    sourceRankings: receipt.sourceRankings.map((ranking) => ({
      sourceMediaId: ranking.sourceMediaId,
      rankedPairIds: ranking.candidates.map((candidate) => requirePairId(candidate.pairOrdinal))
    })),
    targetRankings: receipt.targetRankings.map((ranking) => ({
      targetMediaId: ranking.targetMediaId,
      rankedPairIds: ranking.candidates.map((candidate) => requirePairId(candidate.pairOrdinal))
    })),
    nativeShortlist: {
      shortlistedPairIds: projection.pairs
        .map((pair) => pair.pairId)
        .filter((pairId) => shortlistedPairIds.has(pairId)),
      nonShortlistedPairIds: projection.pairs
        .map((pair) => pair.pairId)
        .filter((pairId) => !shortlistedPairIds.has(pairId))
    }
  });
  validateRawPredictionBinding(projection, rawPrediction);
  return rawPrediction;
}

/**
 * Reveal only the private relationship decisions deterministically implied by frozen gold and a
 * strictly bound raw prediction. Callers cannot submit hit flags, gold pairs or rankings here.
 */
export function deriveC137BlindBatchRelationshipDecisions(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchProjectionOptions,
  projectionValue: unknown,
  rawPredictionValue: unknown
): C137BlindBatchDerivedRelationshipDecision[] {
  const model = buildManifestModel(manifest, options);
  const projection = assertExecutionProjectionShape(projectionValue);
  assertProjectionMatchesManifestModel(projection, model);
  const rawPrediction = assertRawPredictionShape(rawPredictionValue);
  validateRawPredictionBinding(projection, rawPrediction);
  assertCompleteSingleBatchCandidateUniverse(model);

  const sourceRankingsByMediaId = new Map(
    rawPrediction.sourceRankings.map((ranking) => [ranking.sourceMediaId, ranking])
  );
  const targetRankingsByMediaId = new Map(
    rawPrediction.targetRankings.map((ranking) => [ranking.targetMediaId, ranking])
  );
  return model.selectedCases.map((benchmarkCase) => {
    const sourceMediaId = requireMapValue(
      model.sourceMediaIdByCaseId,
      benchmarkCase.id,
      "source media"
    );
    const targetMediaId = requireMapValue(
      model.targetMediaIdByCaseId,
      benchmarkCase.id,
      "target media"
    );
    const goldPairId = requireMapValue(
      model.pairIdByMediaIds,
      pairKey(sourceMediaId, targetMediaId),
      "gold pair"
    );
    const ranking =
      projection.relationshipAxis === "target"
        ? requireMapValue(targetRankingsByMediaId, targetMediaId, "target ranking")
        : requireMapValue(sourceRankingsByMediaId, sourceMediaId, "source ranking");
    return {
      suiteId: projection.suiteId,
      caseId: benchmarkCase.id,
      provenanceRef: digest(
        DERIVED_RELATIONSHIP_DECISION_DOMAIN,
        JSON.stringify([projection.suiteId, benchmarkCase.id])
      ),
      goldPairId,
      rankedPairIds: ranking.rankedPairIds.slice(0, projection.topK)
    };
  });
}

export function computeC137BlindBatchRawPredictionDigest(
  prediction: C137BlindBatchRawPredictionDraft
): C137Digest {
  return digest(RAW_PREDICTION_DOMAIN, canonicalRawPredictionPayload(prediction));
}

export function computeC137BlindBatchBenchmarkEvidenceDigest(
  evidence: Omit<C137BlindBatchBenchmarkEvidence, "evidenceDigest">
): C137Digest {
  return digest(EVIDENCE_DOMAIN, canonicalEvidencePayload(evidence));
}

/**
 * Reveal frozen gold only after a complete, digest-bound blind receipt exists. All relationship
 * and TimeMap metrics are recomputed here; the raw receipt has no fields in which callers can
 * submit precomputed errors or hit flags.
 */
export function compileC137BlindBatchBenchmarkEvidence(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchProjectionOptions,
  projectionValue: unknown,
  rawPredictionValue: unknown
): C137BlindBatchBenchmarkEvidence {
  const model = buildManifestModel(manifest, options);
  const projection = assertExecutionProjectionShape(projectionValue);
  assertProjectionMatchesManifestModel(projection, model);

  const rawPrediction = assertRawPredictionShape(rawPredictionValue);
  validateRawPredictionBinding(projection, rawPrediction);
  assertCompleteSingleBatchCandidateUniverse(model);

  const outcomesByPairId = new Map(
    rawPrediction.pairOutcomes.map((outcome) => [outcome.pairId, outcome])
  );
  const sourceRankingsByMediaId = new Map(
    rawPrediction.sourceRankings.map((ranking) => [ranking.sourceMediaId, ranking])
  );
  const targetRankingsByMediaId = new Map(
    rawPrediction.targetRankings.map((ranking) => [ranking.targetMediaId, ranking])
  );
  const shortlistedPairIds = new Set(rawPrediction.nativeShortlist.shortlistedPairIds);
  const caseMeasurements = model.selectedCases.map((benchmarkCase) => {
    const sourceMediaId = requireMapValue(
      model.sourceMediaIdByCaseId,
      benchmarkCase.id,
      "source media"
    );
    const targetMediaId = requireMapValue(
      model.targetMediaIdByCaseId,
      benchmarkCase.id,
      "target media"
    );
    const goldPairId = requireMapValue(
      model.pairIdByMediaIds,
      pairKey(sourceMediaId, targetMediaId),
      "gold pair"
    );
    const queryMediaId =
      projection.relationshipAxis === "target" ? targetMediaId : sourceMediaId;
    const ranking =
      projection.relationshipAxis === "target"
        ? requireMapValue(targetRankingsByMediaId, queryMediaId, "target ranking")
        : requireMapValue(sourceRankingsByMediaId, queryMediaId, "source ranking");
    const rankedPairIds = ranking.rankedPairIds.slice(
      0,
      Math.min(projection.topK, ranking.rankedPairIds.length)
    );
    const outcome = requireMapValue(outcomesByPairId, goldPairId, "known pair outcome");
    const anchorMeasurement = measureKnownPairAnchors(benchmarkCase, outcome);
    const goldPairShortlisted = shortlistedPairIds.has(goldPairId);
    const top1Hit = rankedPairIds[0] === goldPairId;
    return {
      top1Hit,
      topKHit: rankedPairIds.includes(goldPairId),
      goldPairShortlisted,
      top1WrongRelationship: !top1Hit,
      knownPairMappedAnchorCount: anchorMeasurement.errors.length,
      knownPairUnmappedAnchorCount: anchorMeasurement.unmappedCount,
      knownPairMappedAnchorAbsoluteErrorsMs: anchorMeasurement.errors
    } satisfies C137BlindBatchCaseMeasurement;
  });

  const knownPairAnchorErrors = caseMeasurements.flatMap(
    (item) => item.knownPairMappedAnchorAbsoluteErrorsMs
  );
  const knownPairMappedAnchorCount = caseMeasurements.reduce(
    (count, item) => count + item.knownPairMappedAnchorCount,
    0
  );
  const knownPairUnmappedAnchorCount = caseMeasurements.reduce(
    (count, item) => count + item.knownPairUnmappedAnchorCount,
    0
  );
  const draft: Omit<C137BlindBatchBenchmarkEvidence, "evidenceDigest"> = {
    schemaVersion: C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION,
    kind: "c137-blind-batch-benchmark-evidence",
    scope: "cross-media-relationship-and-known-pair-anchor-component",
    releaseEligible: false,
    trustStatus: "untrusted-self-consistent-evidence",
    manifestId: manifest.id,
    datasetVersion: manifest.datasetVersion,
    suiteId: projection.suiteId,
    projectionDigest: projection.projectionDigest,
    executionDigest: rawPrediction.executionDigest,
    nativeReceiptDigest: rawPrediction.nativeReceiptDigest,
    rawPredictionDigest: rawPrediction.receiptDigest,
    topK: projection.topK,
    relationshipAxis: projection.relationshipAxis,
    decisionCount: caseMeasurements.length,
    top1HitCount: caseMeasurements.filter((item) => item.top1Hit).length,
    topKHitCount: caseMeasurements.filter((item) => item.topKHit).length,
    top1Accuracy: ratio(
      caseMeasurements.filter((item) => item.top1Hit).length,
      caseMeasurements.length
    ),
    topKAccuracy: ratio(
      caseMeasurements.filter((item) => item.topKHit).length,
      caseMeasurements.length
    ),
    shortlistedGoldPairCount: caseMeasurements.filter((item) => item.goldPairShortlisted)
      .length,
    top1WrongRelationshipCount: caseMeasurements.filter((item) => item.top1WrongRelationship)
      .length,
    knownPairMappedAnchorCount,
    knownPairUnmappedAnchorCount,
    knownPairAnchorCoverage: ratio(
      knownPairMappedAnchorCount,
      knownPairMappedAnchorCount + knownPairUnmappedAnchorCount
    ),
    knownPairMappedAnchorError: createErrorDistribution(knownPairAnchorErrors)
  };
  return {
    ...draft,
    evidenceDigest: computeC137BlindBatchBenchmarkEvidenceDigest(draft)
  };
}

/** Recompute the complete evidence object, so re-signing hand-written errors still fails. */
export function validateC137BlindBatchBenchmarkEvidence(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchProjectionOptions,
  projection: unknown,
  rawPrediction: unknown,
  evidenceValue: unknown
): C137BlindBatchEvidenceValidationResult {
  try {
    const evidence = assertBenchmarkEvidenceShape(evidenceValue);
    const expected = compileC137BlindBatchBenchmarkEvidence(
      manifest,
      options,
      projection,
      rawPrediction
    );
    if (
      canonicalEvidencePayload(evidence) !== canonicalEvidencePayload(expected) ||
      evidence.evidenceDigest !== expected.evidenceDigest
    ) {
      throw new Error(
        "blind batch evidence 不是由冻结 gold 与原始 blind prediction 确定性重算得到。"
      );
    }
    return { valid: true, issues: [] };
  } catch (error) {
    return {
      valid: false,
      issues: [error instanceof Error ? error.message : "blind batch evidence 校验失败。"]
    };
  }
}

function buildManifestModel(
  manifest: RealMediaBenchmarkManifest,
  options: C137BlindBatchProjectionOptions
): C137BlindBatchManifestModel {
  const validation = validateRealMediaBenchmarkManifest(manifest);
  if (!validation.valid) {
    throw new Error(`冻结 benchmark manifest 无效：${validation.issues.join("；")}`);
  }
  assertRelationshipAxis(options.relationshipAxis);
  assertBoolean(options.visualEvidenceEnabled, "blind batch visualEvidenceEnabled");
  assertTopK(options.topK);
  const frozenCases = manifest.cases.filter(
    (benchmarkCase) =>
      benchmarkCase.mediaKind === "real" && benchmarkCase.split === "frozen-test"
  );
  const selectedCases = selectFrozenCases(frozenCases, options.caseIds, "caseIds");
  const candidateCases = selectFrozenCases(
    frozenCases,
    options.candidateCaseIds ?? options.caseIds,
    "candidateCaseIds"
  );
  const sourceCases = options.relationshipAxis === "source" ? selectedCases : candidateCases;
  const targetCases = options.relationshipAxis === "target" ? selectedCases : candidateCases;
  if (
    options.visualEvidenceEnabled &&
    (sourceCases.some((benchmarkCase) => benchmarkCase.source.videoStreamIndex === null) ||
      targetCases.some((benchmarkCase) => benchmarkCase.target.videoStreamIndex === null))
  ) {
    throw new Error(
      "formal blind visual benchmark 要求每个 selected source/target 显式指定 videoStreamIndex；禁止 null/auto。"
    );
  }

  const sources = createMediaProjection(
    manifest.id,
    manifest.datasetVersion,
    options.visualEvidenceEnabled,
    sourceCases.map((benchmarkCase) => benchmarkCase.source),
    "source"
  );
  const targets = createMediaProjection(
    manifest.id,
    manifest.datasetVersion,
    options.visualEvidenceEnabled,
    targetCases.map((benchmarkCase) => benchmarkCase.target),
    "target"
  );
  if (
    sources.entries.length > MAXIMUM_MEDIA_PER_SIDE ||
    targets.entries.length > MAXIMUM_MEDIA_PER_SIDE
  ) {
    throw new Error(`blind batch 每侧最多允许 ${MAXIMUM_MEDIA_PER_SIDE} 个 distinct media。`);
  }
  const pairCount = sources.entries.length * targets.entries.length;
  if (pairCount < 2 || (sources.entries.length === 1 && targets.entries.length === 1)) {
    throw new Error(
      "blind batch 必须形成至少两个不同 source/target pair；单 pair 不能冒充 batch。 "
    );
  }
  if (pairCount > MAXIMUM_PAIR_COUNT) {
    throw new Error(`blind batch 笛卡尔积超过 ${MAXIMUM_PAIR_COUNT} pair，请拆分冻结 suite。`);
  }
  const sourceMediaIdByCaseId = new Map<string, string>();
  const targetMediaIdByCaseId = new Map<string, string>();
  const goldPairKeys = new Set<string>();
  for (const benchmarkCase of selectedCases) {
    const sourceMediaId = sources.idByKey.get(
      mediaBindingKey(benchmarkCase.source, options.visualEvidenceEnabled)
    );
    const targetMediaId = targets.idByKey.get(
      mediaBindingKey(benchmarkCase.target, options.visualEvidenceEnabled)
    );
    if (sourceMediaId !== undefined) {
      sourceMediaIdByCaseId.set(benchmarkCase.id, sourceMediaId);
    }
    if (targetMediaId !== undefined) {
      targetMediaIdByCaseId.set(benchmarkCase.id, targetMediaId);
    }
    if (sourceMediaId !== undefined && targetMediaId !== undefined) {
      const key = pairKey(sourceMediaId, targetMediaId);
      if (goldPairKeys.has(key)) {
        throw new Error(
          `冻结 suite 含重复 gold pair ${sourceMediaId}/${targetMediaId}；单批 compiler 要求每个关系唯一。`
        );
      }
      goldPairKeys.add(key);
    }
  }
  const relationshipAxis = options.relationshipAxis;
  const queryMediaIds =
    relationshipAxis === "target"
      ? [...targetMediaIdByCaseId.values()]
      : [...sourceMediaIdByCaseId.values()];
  if (new Set(queryMediaIds).size !== selectedCases.length) {
    throw new Error(
      `relationshipAxis=${relationshipAxis} 要求每个 frozen case 的 query media 唯一；v1 只评测跨媒体 pair ranking，不评测同一 query 的多 gold 或 pair 内窗口 Top-K。`
    );
  }
  const pairs: C137BlindBatchPairProjection[] = [];
  const pairIdByMediaIds = new Map<string, string>();
  for (const source of sources.entries) {
    for (const target of targets.entries) {
      const pairId = `pair-${source.mediaId}-${target.mediaId}`;
      pairs.push({
        pairId,
        sourceMediaId: source.mediaId,
        targetMediaId: target.mediaId
      });
      pairIdByMediaIds.set(pairKey(source.mediaId, target.mediaId), pairId);
    }
  }
  const suiteId = `suite-${sha256Hex(
    JSON.stringify([
      SUITE_DOMAIN,
      manifest.id,
      manifest.datasetVersion,
      selectedCases.map((benchmarkCase) => benchmarkCase.id),
      candidateCases.map((benchmarkCase) => benchmarkCase.id),
      options.topK,
      relationshipAxis,
      options.visualEvidenceEnabled
    ])
  ).slice(0, 24)}`;
  const projectionDraft: Omit<C137BlindBatchExecutionProjection, "projectionDigest"> = {
    schemaVersion: C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION,
    kind: "c137-blind-batch-execution-projection",
    suiteId,
    topK: options.topK,
    relationshipAxis,
    visualEvidenceEnabled: options.visualEvidenceEnabled,
    sources: sources.entries,
    targets: targets.entries,
    pairs
  };
  const projection = {
    ...projectionDraft,
    projectionDigest: computeC137BlindBatchProjectionDigest(projectionDraft)
  };
  return {
    selectedCases,
    sourceMediaIdByCaseId,
    targetMediaIdByCaseId,
    pairIdByMediaIds,
    projection
  };
}

function assertProjectionMatchesManifestModel(
  projection: C137BlindBatchExecutionProjection,
  model: C137BlindBatchManifestModel
): void {
  if (
    canonicalProjectionPayload(projection) !== canonicalProjectionPayload(model.projection) ||
    projection.projectionDigest !== model.projection.projectionDigest
  ) {
    throw new Error(
      "blind batch execution projection 与冻结 manifest 的唯一 gold-free 投影不一致。"
    );
  }
}

function assertCompleteSingleBatchCandidateUniverse(model: C137BlindBatchManifestModel): void {
  const projection = model.projection;
  const candidateMediaCount =
    projection.relationshipAxis === "target"
      ? projection.sources.length
      : projection.targets.length;
  const candidateSide = projection.relationshipAxis === "target" ? "source" : "target";
  if (projection.topK >= candidateMediaCount) {
    throw new Error(
      `单批 relationshipAxis=${projection.relationshipAxis} accuracy 要求 distinct ${candidateSide} 候选数严格大于 topK=${projection.topK}；partial candidate shard 只能交给 exhaustive matrix aggregator。`
    );
  }
  for (const benchmarkCase of model.selectedCases) {
    const sourceMediaId = model.sourceMediaIdByCaseId.get(benchmarkCase.id);
    const targetMediaId = model.targetMediaIdByCaseId.get(benchmarkCase.id);
    if (
      sourceMediaId === undefined ||
      targetMediaId === undefined ||
      !model.pairIdByMediaIds.has(pairKey(sourceMediaId, targetMediaId))
    ) {
      throw new Error(
        `单批 accuracy 的 candidateCaseIds 未包含 ${benchmarkCase.id} 的 gold candidate；partial shard 不得单独揭示或编译准确率。`
      );
    }
  }
}

function validateProjectionExecutionSuiteBinding(
  projection: C137BlindBatchExecutionProjection,
  suite: RealMediaBlindBatchExecutionSuite
): void {
  if (suite.suiteId !== projection.suiteId || suite.topK !== projection.topK) {
    throw new Error("blind batch execution suite 未绑定同一 projection suiteId/topK。");
  }
  if (suite.parameters.enableVisualEvidence !== projection.visualEvidenceEnabled) {
    throw new Error("blind batch execution suite visual evidence 设置与 projection 不一致。");
  }
  for (const [label, projectedMedia, executionMedia] of [
    ["source", projection.sources, suite.sources],
    ["target", projection.targets, suite.targets]
  ] as const) {
    if (projectedMedia.length !== executionMedia.length) {
      throw new Error(`blind batch ${label} media 数量与 projection 不一致。`);
    }
    projectedMedia.forEach((projected, index) => {
      const execution = executionMedia[index];
      if (
        execution === undefined ||
        execution.mediaId !== projected.mediaId ||
        execution.audioStreamIndex !== projected.audioStreamIndex ||
        execution.videoStreamIndex !== projected.videoStreamIndex ||
        (projection.visualEvidenceEnabled && projected.videoStreamIndex === null) ||
        (!projection.visualEvidenceEnabled && projected.videoStreamIndex !== null)
      ) {
        throw new Error(`blind batch ${label} mediaId/stream 与 projection 有序绑定不一致。`);
      }
    });
  }

  if (suite.pairs.length !== projection.pairs.length) {
    throw new Error("blind batch fullCartesian pair 数量与 projection 不一致。");
  }
  suite.pairs.forEach((executionPair, index) => {
    const projectedPair = projection.pairs[index];
    if (
      projectedPair === undefined ||
      executionPair.pairOrdinal !== index + 1 ||
      executionPair.sourceMediaId !== projectedPair.sourceMediaId ||
      executionPair.targetMediaId !== projectedPair.targetMediaId
    ) {
      throw new Error(
        "blind batch fullCartesian pair 必须与 projection source-major 顺序逐项一致。"
      );
    }
  });
}

function selectFrozenCases(
  frozenCases: readonly RealMediaBenchmarkCase[],
  requestedIds: readonly string[] | undefined,
  fieldName: "caseIds" | "candidateCaseIds"
): RealMediaBenchmarkCase[] {
  if (requestedIds === undefined) {
    return frozenCases.map((benchmarkCase) => structuredClone(benchmarkCase));
  }
  if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
    throw new Error(`blind batch ${fieldName} 必须非空且不重复。 `);
  }
  requestedIds.forEach((caseId) => assertNonemptyString(caseId, fieldName));
  const requested = new Set(requestedIds);
  const selected = frozenCases.filter((benchmarkCase) => requested.has(benchmarkCase.id));
  if (selected.length !== requestedIds.length) {
    throw new Error(`blind batch ${fieldName} 含不存在、非 real 或非 frozen-test 的关系。 `);
  }
  if (selected.some((benchmarkCase, index) => benchmarkCase.id !== requestedIds[index])) {
    throw new Error(`blind batch ${fieldName} 必须保持冻结 manifest 顺序。 `);
  }
  return selected.map((benchmarkCase) => structuredClone(benchmarkCase));
}

function createMediaProjection(
  manifestId: string,
  datasetVersion: string,
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[],
  prefix: "source" | "target"
): {
  entries: C137BlindBatchMediaProjection[];
  idByKey: Map<string, string>;
} {
  const entries: C137BlindBatchMediaProjection[] = [];
  const idByKey = new Map<string, string>();
  const orderedMedia = orderC137BlindBatchMediaInputs(
    manifestId,
    datasetVersion,
    prefix,
    visualEvidenceEnabled,
    mediaInputs
  );
  for (const media of orderedMedia) {
    const key = mediaBindingKey(media, visualEvidenceEnabled);
    const mediaId = `${prefix}-${String(entries.length + 1).padStart(4, "0")}`;
    idByKey.set(key, mediaId);
    entries.push({
      mediaId,
      bindingCommitment: createC137BlindBatchMediaBindingCommitment(
        manifestId,
        datasetVersion,
        prefix,
        visualEvidenceEnabled,
        media
      ),
      audioStreamIndex: media.audioStreamIndex,
      videoStreamIndex: visualEvidenceEnabled ? media.videoStreamIndex : null
    });
  }
  return { entries, idByKey };
}

function mediaBindingKey(
  media: RealMediaBenchmarkMediaInput,
  visualEvidenceEnabled: boolean
): string {
  const identity = media.contentIdentity;
  if (identity === null) {
    throw new Error("frozen real media 缺少全文件身份。 ");
  }
  return JSON.stringify([
    identity.algorithm,
    identity.sizeBytes,
    identity.digest.toLowerCase(),
    media.audioStreamIndex,
    visualEvidenceEnabled ? media.videoStreamIndex : null
  ]);
}

function validateRawPredictionBinding(
  projection: C137BlindBatchExecutionProjection,
  raw: C137BlindBatchRawPrediction
): void {
  if (
    raw.suiteId !== projection.suiteId ||
    raw.projectionDigest !== projection.projectionDigest ||
    raw.topK !== projection.topK
  ) {
    throw new Error("blind batch raw prediction 未绑定同一 suite/projection/topK。 ");
  }
  if (raw.receiptDigest !== computeC137BlindBatchRawPredictionDigest(raw)) {
    throw new Error("blind batch raw prediction receiptDigest 与原始有序内容不一致。 ");
  }
  if (raw.pairOutcomes.length !== projection.pairs.length) {
    throw new Error("blind batch raw prediction pair outcome 数量不完整。 ");
  }
  const outcomesByPairId = new Map<string, C137BlindBatchPairOutcome>();
  raw.pairOutcomes.forEach((outcome, index) => {
    const expected = projection.pairs[index];
    if (
      expected === undefined ||
      outcome.pairId !== expected.pairId ||
      outcome.sourceMediaId !== expected.sourceMediaId ||
      outcome.targetMediaId !== expected.targetMediaId
    ) {
      throw new Error(
        "blind batch pair outcomes 必须完整、唯一并保持 execution projection 顺序。 "
      );
    }
    if (outcomesByPairId.has(outcome.pairId)) {
      throw new Error(`blind batch pair outcome 重复：${outcome.pairId}。`);
    }
    outcomesByPairId.set(outcome.pairId, outcome);
  });
  validateRankings(
    "source",
    projection.sources.map((item) => item.mediaId),
    projection.pairs,
    raw.sourceRankings.map((item) => ({
      mediaId: item.sourceMediaId,
      pairIds: item.rankedPairIds
    }))
  );
  validateRankings(
    "target",
    projection.targets.map((item) => item.mediaId),
    projection.pairs,
    raw.targetRankings.map((item) => ({
      mediaId: item.targetMediaId,
      pairIds: item.rankedPairIds
    }))
  );

  const shortlisted = raw.nativeShortlist.shortlistedPairIds;
  const nonShortlisted = raw.nativeShortlist.nonShortlistedPairIds;
  const partition = [...shortlisted, ...nonShortlisted];
  if (
    new Set(partition).size !== partition.length ||
    partition.length !== projection.pairs.length ||
    projection.pairs.some((pair) => !partition.includes(pair.pairId))
  ) {
    throw new Error(
      "native shortlist 必须无重复地完整划分 shortlisted/non-shortlisted pair。 "
    );
  }
  const shortlistedSet = new Set(shortlisted);
  const expectedShortlisted = projection.pairs
    .map((pair) => pair.pairId)
    .filter((pairId) => shortlistedSet.has(pairId));
  const expectedNonShortlisted = projection.pairs
    .map((pair) => pair.pairId)
    .filter((pairId) => !shortlistedSet.has(pairId));
  if (
    shortlisted.some((pairId, index) => pairId !== expectedShortlisted[index]) ||
    nonShortlisted.some((pairId, index) => pairId !== expectedNonShortlisted[index])
  ) {
    throw new Error("native shortlist 两个分区必须分别保持 execution projection 顺序。 ");
  }
  for (const outcome of raw.pairOutcomes) {
    if (outcome.status === "candidate" && !shortlistedSet.has(outcome.pairId)) {
      throw new Error("raw candidate 必须属于 native shortlist。 ");
    }
  }
}

function validateRankings(
  axis: "source" | "target",
  expectedMediaIds: readonly string[],
  pairs: readonly C137BlindBatchPairProjection[],
  rankings: readonly { mediaId: string; pairIds: string[] }[]
): void {
  if (rankings.length !== expectedMediaIds.length) {
    throw new Error(`blind batch ${axis} rankings 数量不完整。`);
  }
  rankings.forEach((ranking, index) => {
    const expectedMediaId = expectedMediaIds[index];
    if (ranking.mediaId !== expectedMediaId) {
      throw new Error(`blind batch ${axis} rankings 必须保持 execution projection 顺序。`);
    }
    const expectedPairIds = pairs
      .filter((pair) =>
        axis === "source"
          ? pair.sourceMediaId === expectedMediaId
          : pair.targetMediaId === expectedMediaId
      )
      .map((pair) => pair.pairId);
    if (
      ranking.pairIds.length !== expectedPairIds.length ||
      new Set(ranking.pairIds).size !== ranking.pairIds.length ||
      expectedPairIds.some((pairId) => !ranking.pairIds.includes(pairId))
    ) {
      throw new Error(
        `blind batch ${axis} ranking ${expectedMediaId} 必须恰好包含该 query 的全部候选 pair，且不得重复。`
      );
    }
  });
}

function measureKnownPairAnchors(
  benchmarkCase: RealMediaBenchmarkCase,
  outcome: C137BlindBatchPairOutcome
): { errors: number[]; unmappedCount: number } {
  if (outcome.status === "blocked") {
    return {
      errors: [],
      unmappedCount: benchmarkCase.gold.matchedAnchors.length
    };
  }
  const errors: number[] = [];
  let unmappedCount = 0;
  for (const anchor of benchmarkCase.gold.matchedAnchors) {
    const mapped = mapSourceTime(outcome.proposalTimeMapSpans, anchor.sourceMs);
    if (mapped.status !== "mapped") {
      unmappedCount += 1;
    } else {
      errors.push(Math.abs(mapped.targetTimeMs - anchor.targetMs));
    }
  }
  return { errors, unmappedCount };
}

function createErrorDistribution(
  values: readonly number[]
): BenchmarkErrorDistribution & { p99Ms: number | null } {
  if (values.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? null
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExecutionProjectionShape(value: unknown): C137BlindBatchExecutionProjection {
  const record = assertRecordWithKeys(value, "execution projection", [
    "schemaVersion",
    "kind",
    "suiteId",
    "topK",
    "relationshipAxis",
    "visualEvidenceEnabled",
    "sources",
    "targets",
    "pairs",
    "projectionDigest"
  ]);
  if (
    record.schemaVersion !== C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION ||
    record.kind !== "c137-blind-batch-execution-projection"
  ) {
    throw new Error("blind batch execution projection schema/kind 无效。 ");
  }
  assertOpaqueId(record.suiteId, "execution suiteId");
  assertTopK(record.topK);
  if (record.relationshipAxis !== "source" && record.relationshipAxis !== "target") {
    throw new Error("blind batch execution relationshipAxis 无效。 ");
  }
  assertBoolean(record.visualEvidenceEnabled, "execution visualEvidenceEnabled");
  assertDigest(record.projectionDigest, "projectionDigest");
  assertArray(record.sources, "execution sources");
  assertArray(record.targets, "execution targets");
  assertArray(record.pairs, "execution pairs");
  for (const [label, values] of [
    ["source", record.sources],
    ["target", record.targets]
  ] as const) {
    if (values.length === 0 || values.length > MAXIMUM_MEDIA_PER_SIDE) {
      throw new Error(`execution ${label} media 数量无效。`);
    }
    const ids = new Set<string>();
    values.forEach((item, index) => {
      const media = assertRecordWithKeys(item, `${label}[${index}]`, [
        "mediaId",
        "bindingCommitment",
        "audioStreamIndex",
        "videoStreamIndex"
      ]);
      assertOpaqueId(media.mediaId, `${label}[${index}].mediaId`);
      assertDigest(media.bindingCommitment, `${label}[${index}].bindingCommitment`);
      assertNonnegativeSafeInteger(media.audioStreamIndex, `${label} audioStreamIndex`);
      if (media.videoStreamIndex !== null) {
        assertNonnegativeSafeInteger(media.videoStreamIndex, `${label} videoStreamIndex`);
      }
      if (ids.has(media.mediaId)) throw new Error(`execution ${label} mediaId 重复。`);
      ids.add(media.mediaId);
    });
  }
  if (record.pairs.length < 2 || record.pairs.length > MAXIMUM_PAIR_COUNT) {
    throw new Error("execution pair 数量不足以构成 batch，或超过上限。 ");
  }
  const pairIds = new Set<string>();
  record.pairs.forEach((item, index) => {
    const pair = assertRecordWithKeys(item, `pairs[${index}]`, [
      "pairId",
      "sourceMediaId",
      "targetMediaId"
    ]);
    assertOpaqueId(pair.pairId, `pairs[${index}].pairId`);
    assertOpaqueId(pair.sourceMediaId, `pairs[${index}].sourceMediaId`);
    assertOpaqueId(pair.targetMediaId, `pairs[${index}].targetMediaId`);
    if (pairIds.has(pair.pairId)) throw new Error("execution pairId 重复。 ");
    pairIds.add(pair.pairId);
  });
  const projection = value as C137BlindBatchExecutionProjection;
  if (projection.projectionDigest !== computeC137BlindBatchProjectionDigest(projection)) {
    throw new Error("execution projectionDigest 与有序投影内容不一致。 ");
  }
  return projection;
}

function assertRawPredictionDraftShape(
  value: unknown
): asserts value is C137BlindBatchRawPredictionDraft {
  assertRawPredictionShapeInternal(value, false);
}

function assertRawPredictionShape(value: unknown): C137BlindBatchRawPrediction {
  return assertRawPredictionShapeInternal(value, true) as C137BlindBatchRawPrediction;
}

function assertRawPredictionShapeInternal(
  value: unknown,
  requireReceipt: boolean
): C137BlindBatchRawPredictionDraft | C137BlindBatchRawPrediction {
  const keys = [
    "schemaVersion",
    "kind",
    "suiteId",
    "projectionDigest",
    "executionDigest",
    "nativeReceiptDigest",
    "topK",
    "pairOutcomes",
    "sourceRankings",
    "targetRankings",
    "nativeShortlist",
    ...(requireReceipt ? ["receiptDigest"] : [])
  ];
  const record = assertRecordWithKeys(value, "raw prediction", keys);
  if (
    record.schemaVersion !== C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION ||
    record.kind !== "c137-blind-batch-raw-prediction"
  ) {
    throw new Error("blind batch raw prediction schema/kind 无效。 ");
  }
  assertOpaqueId(record.suiteId, "raw suiteId");
  assertDigest(record.projectionDigest, "raw projectionDigest");
  assertDigest(record.executionDigest, "raw executionDigest");
  assertDigest(record.nativeReceiptDigest, "raw nativeReceiptDigest");
  assertTopK(record.topK);
  if (requireReceipt) assertDigest(record.receiptDigest, "raw receiptDigest");
  assertArray(record.pairOutcomes, "raw pairOutcomes");
  if (record.pairOutcomes.length < 2 || record.pairOutcomes.length > MAXIMUM_PAIR_COUNT) {
    throw new Error("raw pairOutcomes 不能由单 pair 冒充 batch，且不得超过上限。 ");
  }
  const candidatePairIds: string[] = [];
  record.pairOutcomes.forEach((item, index) => {
    const outcome = assertRecordWithKeys(item, `pairOutcomes[${index}]`, [
      "pairId",
      "sourceMediaId",
      "targetMediaId",
      "status",
      "proposalTimeMapSpans"
    ]);
    assertOpaqueId(outcome.pairId, `pairOutcomes[${index}].pairId`);
    assertOpaqueId(outcome.sourceMediaId, `pairOutcomes[${index}].sourceMediaId`);
    assertOpaqueId(outcome.targetMediaId, `pairOutcomes[${index}].targetMediaId`);
    if (outcome.status !== "candidate" && outcome.status !== "blocked") {
      throw new Error(`pairOutcomes[${index}].status 无效。`);
    }
    if (outcome.status === "candidate") candidatePairIds.push(outcome.pairId);
    assertArray(outcome.proposalTimeMapSpans, `pairOutcomes[${index}].proposalTimeMapSpans`);
    if (outcome.proposalTimeMapSpans.length > MAXIMUM_SPANS_PER_PAIR) {
      throw new Error(`pairOutcomes[${index}] proposal TimeMap 超过上限。`);
    }
    if (outcome.status === "candidate" && outcome.proposalTimeMapSpans.length === 0) {
      throw new Error(`pairOutcomes[${index}] candidate 必须包含 proposal TimeMap。`);
    }
    const spans = outcome.proposalTimeMapSpans.map((span, spanIndex) =>
      assertPredictedSpan(span, `pairOutcomes[${index}].spans[${spanIndex}]`)
    );
    const timeMapValidation = validateTimeMap(spans);
    if (!timeMapValidation.valid) {
      throw new Error(
        `pairOutcomes[${index}] TimeMap 无效：${timeMapValidation.issues
          .map((issue) => issue.message)
          .join("；")}`
      );
    }
    if (outcome.status === "candidate" && !spans.some((span) => span.kind === "matched")) {
      throw new Error(`pairOutcomes[${index}] candidate 必须包含至少一个 matched span。`);
    }
  });
  for (const [field, idField] of [
    ["sourceRankings", "sourceMediaId"],
    ["targetRankings", "targetMediaId"]
  ] as const) {
    const rankings = record[field];
    assertArray(rankings, `raw ${field}`);
    rankings.forEach((item, index) => {
      const ranking = assertRecordWithKeys(item, `${field}[${index}]`, [
        idField,
        "rankedPairIds"
      ]);
      assertOpaqueId(ranking[idField], `${field}[${index}].${idField}`);
      assertArray(ranking.rankedPairIds, `${field}[${index}].rankedPairIds`);
      ranking.rankedPairIds.forEach((pairId, pairIndex) =>
        assertOpaqueId(pairId, `${field}[${index}].rankedPairIds[${pairIndex}]`)
      );
    });
  }
  const nativeShortlist = assertRecordWithKeys(record.nativeShortlist, "nativeShortlist", [
    "shortlistedPairIds",
    "nonShortlistedPairIds"
  ]);
  const shortlistedPairIds = new Set<string>();
  for (const field of ["shortlistedPairIds", "nonShortlistedPairIds"] as const) {
    assertArray(nativeShortlist[field], `nativeShortlist.${field}`);
    nativeShortlist[field].forEach((pairId, index) => {
      assertOpaqueId(pairId, `nativeShortlist.${field}[${index}]`);
      if (field === "shortlistedPairIds") shortlistedPairIds.add(pairId);
    });
  }
  if (candidatePairIds.some((pairId) => !shortlistedPairIds.has(pairId))) {
    throw new Error("raw candidate 必须属于 native shortlist。 ");
  }
  return value as C137BlindBatchRawPredictionDraft | C137BlindBatchRawPrediction;
}

function assertPredictedSpan(value: unknown, label: string): C137BlindBatchPredictedSpan {
  const record = assertRecordWithKeys(value, label, [
    "kind",
    "sourceStartMs",
    "sourceEndMs",
    "targetStartMs",
    "targetEndMs"
  ]);
  if (
    record.kind !== "matched" &&
    record.kind !== "sourceOnly" &&
    record.kind !== "targetOnly" &&
    record.kind !== "ambiguous"
  ) {
    throw new Error(`${label}.kind 无效。`);
  }
  for (const field of [
    "sourceStartMs",
    "sourceEndMs",
    "targetStartMs",
    "targetEndMs"
  ] as const) {
    assertNonnegativeSafeInteger(record[field], `${label}.${field}`);
  }
  return value as C137BlindBatchPredictedSpan;
}

function assertBenchmarkEvidenceShape(value: unknown): C137BlindBatchBenchmarkEvidence {
  const record = assertRecordWithKeys(value, "benchmark evidence", [
    "schemaVersion",
    "kind",
    "scope",
    "releaseEligible",
    "trustStatus",
    "manifestId",
    "datasetVersion",
    "suiteId",
    "projectionDigest",
    "executionDigest",
    "nativeReceiptDigest",
    "rawPredictionDigest",
    "topK",
    "relationshipAxis",
    "decisionCount",
    "top1HitCount",
    "topKHitCount",
    "top1Accuracy",
    "topKAccuracy",
    "shortlistedGoldPairCount",
    "top1WrongRelationshipCount",
    "knownPairMappedAnchorCount",
    "knownPairUnmappedAnchorCount",
    "knownPairAnchorCoverage",
    "knownPairMappedAnchorError",
    "evidenceDigest"
  ]);
  if (
    record.schemaVersion !== C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION ||
    record.kind !== "c137-blind-batch-benchmark-evidence"
  ) {
    throw new Error("blind batch benchmark evidence schema/kind 无效。 ");
  }
  if (
    record.scope !== "cross-media-relationship-and-known-pair-anchor-component" ||
    record.releaseEligible !== false ||
    record.trustStatus !== "untrusted-self-consistent-evidence"
  ) {
    throw new Error("blind batch benchmark evidence scope/trust/release 标记无效。 ");
  }
  assertNonemptyString(record.manifestId, "evidence.manifestId");
  assertNonemptyString(record.datasetVersion, "evidence.datasetVersion");
  assertOpaqueId(record.suiteId, "evidence.suiteId");
  assertDigest(record.projectionDigest, "evidence.projectionDigest");
  assertDigest(record.executionDigest, "evidence.executionDigest");
  assertDigest(record.nativeReceiptDigest, "evidence.nativeReceiptDigest");
  assertDigest(record.rawPredictionDigest, "evidence.rawPredictionDigest");
  assertDigest(record.evidenceDigest, "evidence.evidenceDigest");
  assertTopK(record.topK);
  if (record.relationshipAxis !== "source" && record.relationshipAxis !== "target") {
    throw new Error("evidence.relationshipAxis 无效。 ");
  }
  for (const field of [
    "decisionCount",
    "top1HitCount",
    "topKHitCount",
    "shortlistedGoldPairCount",
    "top1WrongRelationshipCount",
    "knownPairMappedAnchorCount",
    "knownPairUnmappedAnchorCount"
  ] as const) {
    assertNonnegativeSafeInteger(record[field], `evidence.${field}`);
  }
  assertUnitNumber(record.top1Accuracy, "evidence.top1Accuracy");
  assertUnitNumber(record.topKAccuracy, "evidence.topKAccuracy");
  assertUnitNumber(record.knownPairAnchorCoverage, "evidence.knownPairAnchorCoverage");
  assertErrorDistribution(
    record.knownPairMappedAnchorError,
    "evidence.knownPairMappedAnchorError"
  );
  return value as C137BlindBatchBenchmarkEvidence;
}

function assertErrorDistribution(value: unknown, label: string): void {
  const record = assertRecordWithKeys(value, label, [
    "sampleCount",
    "p50Ms",
    "p95Ms",
    "p99Ms",
    "maxMs"
  ]);
  assertNonnegativeSafeInteger(record.sampleCount, `${label}.sampleCount`);
  for (const field of ["p50Ms", "p95Ms", "p99Ms", "maxMs"] as const) {
    if (record[field] !== null)
      assertNonnegativeSafeInteger(record[field], `${label}.${field}`);
  }
}

function canonicalProjectionPayload(
  projection:
    | Omit<C137BlindBatchExecutionProjection, "projectionDigest">
    | C137BlindBatchExecutionProjection
): string {
  return JSON.stringify([
    PROJECTION_DOMAIN,
    projection.schemaVersion,
    projection.kind,
    projection.suiteId,
    projection.topK,
    projection.relationshipAxis,
    projection.visualEvidenceEnabled,
    projection.sources.map((item) => [
      item.mediaId,
      item.bindingCommitment,
      item.audioStreamIndex,
      item.videoStreamIndex
    ]),
    projection.targets.map((item) => [
      item.mediaId,
      item.bindingCommitment,
      item.audioStreamIndex,
      item.videoStreamIndex
    ]),
    projection.pairs.map((item) => [item.pairId, item.sourceMediaId, item.targetMediaId])
  ]);
}

function canonicalRawPredictionPayload(prediction: C137BlindBatchRawPredictionDraft): string {
  return JSON.stringify([
    RAW_PREDICTION_DOMAIN,
    prediction.schemaVersion,
    prediction.kind,
    prediction.suiteId,
    prediction.projectionDigest,
    prediction.executionDigest,
    prediction.nativeReceiptDigest,
    prediction.topK,
    prediction.pairOutcomes.map((outcome) => [
      outcome.pairId,
      outcome.sourceMediaId,
      outcome.targetMediaId,
      outcome.status,
      outcome.proposalTimeMapSpans.map((span) => [
        span.kind,
        span.sourceStartMs,
        span.sourceEndMs,
        span.targetStartMs,
        span.targetEndMs
      ])
    ]),
    prediction.sourceRankings.map((ranking) => [ranking.sourceMediaId, ranking.rankedPairIds]),
    prediction.targetRankings.map((ranking) => [ranking.targetMediaId, ranking.rankedPairIds]),
    [
      prediction.nativeShortlist.shortlistedPairIds,
      prediction.nativeShortlist.nonShortlistedPairIds
    ]
  ]);
}

function canonicalEvidencePayload(
  evidence:
    Omit<C137BlindBatchBenchmarkEvidence, "evidenceDigest"> | C137BlindBatchBenchmarkEvidence
): string {
  return JSON.stringify([
    EVIDENCE_DOMAIN,
    evidence.schemaVersion,
    evidence.kind,
    evidence.scope,
    evidence.releaseEligible,
    evidence.trustStatus,
    evidence.manifestId,
    evidence.datasetVersion,
    evidence.suiteId,
    evidence.projectionDigest,
    evidence.executionDigest,
    evidence.nativeReceiptDigest,
    evidence.rawPredictionDigest,
    evidence.topK,
    evidence.relationshipAxis,
    evidence.decisionCount,
    evidence.top1HitCount,
    evidence.topKHitCount,
    evidence.top1Accuracy,
    evidence.topKAccuracy,
    evidence.shortlistedGoldPairCount,
    evidence.top1WrongRelationshipCount,
    evidence.knownPairMappedAnchorCount,
    evidence.knownPairUnmappedAnchorCount,
    evidence.knownPairAnchorCoverage,
    canonicalErrorDistribution(evidence.knownPairMappedAnchorError)
  ]);
}

function canonicalErrorDistribution(
  value: BenchmarkErrorDistribution & { p99Ms: number | null }
): readonly (number | null)[] {
  return [value.sampleCount, value.p50Ms, value.p95Ms, value.p99Ms, value.maxMs];
}

function digest(domain: string, payload: string): C137Digest {
  return `sha256:${sha256Hex(JSON.stringify([domain, payload]))}`;
}

function pairKey(sourceMediaId: string, targetMediaId: string): string {
  return `${sourceMediaId}\u0000${targetMediaId}`;
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`内部错误：缺少 ${label}。`);
  return value;
}

function assertRecordWithKeys(
  value: unknown,
  label: string,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} 含未知或缺失字段；gold、手填 errors 与扩展字段均被拒绝。`);
  }
  return value;
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new Error(`${label} 必须是 path-free opaque id。`);
  }
}

function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is C137Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} 必须是规范 SHA-256。`);
  }
}

function assertNonnegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负安全整数。`);
  }
}

function assertUnitNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} 必须位于 0–1。`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值。`);
}

function assertTopK(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < MINIMUM_TOP_K ||
    Number(value) > MAXIMUM_TOP_K
  ) {
    throw new Error(`blind batch topK 必须位于 ${MINIMUM_TOP_K}–${MAXIMUM_TOP_K}。`);
  }
}

function assertRelationshipAxis(
  value: unknown
): asserts value is C137BlindBatchRelationshipAxis {
  if (value !== "source" && value !== "target") {
    throw new Error(
      "blind batch relationshipAxis 必须由调用方显式指定为 source 或 target；禁止从 gold 推断。"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
