import { createTestCompleteTimeMapSpan } from "./timeMapEvidence";
import { deriveLockedFineSpectralBackendIdentity } from "../domain/alignment/fineSpectralBackend";
import {
  createTestFineExecutionEvidence,
  createTestFineFrontierReceipt
} from "./audioAlignmentBatchEvidenceV3";
import {
  createC137BlindBatchMediaBindingCommitment,
  deriveC137BlindBatchRawPredictionFromNativeReceipt,
  orderC137BlindBatchMediaInputs,
  type C137BlindBatchExecutionProjection
} from "../domain/alignment/c137BlindBatchEvidence";
import {
  C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
  C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
  computeC137FormalBlindManifestDigest as computeFixtureManifestDigest,
  computeC137FormalBlindParametersDigest,
  computeC137FormalBlindProvenanceDigest,
  createC137FormalBlindMatrixExecutionProjection,
  createC137FormalBlindMatrixModel,
  createC137FormalBlindMatrixPlan,
  evaluateC137FormalBlindProvenance,
  sealC137FormalBlindProvenanceV3,
  type C137FormalBlindMatrixPlanBatchV2,
  type C137FormalBlindMatrixPlanV2,
  type C137FormalBlindProvenanceBatchEnvelopeV3,
  type C137FormalBlindProvenanceEvaluation,
  type C137FormalBlindProvenanceExpectations,
  type C137FormalBlindProvenanceV3
} from "../domain/alignment/c137FormalBlindProvenance";
import {
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkGold,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput
} from "../domain/alignment/realMediaBenchmark";
import {
  REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
  REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
  REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
  REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
  REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
  createNativeBatchExecutionIdentityDigest,
  createRealMediaBlindBatchExecutionDigest,
  createRealMediaBlindBatchRunReceiptDigest,
  createRealMediaBlindBatchSourceRanking,
  createRealMediaBlindBatchTargetRanking,
  type NativeBatchGlobalCandidateEvidence,
  type NativeBatchExecutionIdentity,
  type NativeBatchGlobalSelectionEvidence,
  type NativeBatchRelationRankingEvidence,
  type RealMediaBlindBatchExecutionMedia,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchPairOutcome,
  type RealMediaBlindBatchRunReceipt
} from "../domain/alignment/realMediaBlindBatchContract";

import type { AlignmentTimeMapProposal } from "../domain/alignment/types";
import type { MediaContentIdentity } from "../domain/project/types";

const TEST_NATIVE_EXECUTION_IDENTITY: NativeBatchExecutionIdentity = {
  schemaVersion: 1,
  engineVersion: "alignment-v2.2-rust",
  featureVersion: "test-feature-v1",
  relationScoreVersion: REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
  nativeExecutableDigest: `sha256:${"a".repeat(64)}`,
  ffmpegBinaryDigest: `sha256:${"b".repeat(64)}`,
  ffprobeBinaryDigest: `sha256:${"c".repeat(64)}`,
  sourceSpectralBackends: [
    {
      backendId: "cuda-cufft-r2c-512-v1",
      requestedBackend: "cuda",
      backendDetail: "test RTX 4090",
      fallbackReason: null
    }
  ],
  targetSpectralBackends: [
    {
      backendId: "cuda-cufft-r2c-512-v1",
      requestedBackend: "cuda",
      backendDetail: "test RTX 4090",
      fallbackReason: null
    }
  ]
};
const TEST_NATIVE_EXECUTION_IDENTITY_DIGEST = createNativeBatchExecutionIdentityDigest(
  TEST_NATIVE_EXECUTION_IDENTITY
);

export interface C137FormalBlindProvenanceFixtureOptions {
  caseCount?: number;
  relationshipAxis?: "source" | "target";
  visualEvidenceEnabled?: boolean;
  globalTopK?: number;
  mutateManifest?: (manifest: RealMediaBenchmarkManifest) => void;
  relationScore?: (input: {
    queryCaseId: string;
    candidateRepresentativeCaseId: string;
    candidateOrdinal: number;
    gold: boolean;
  }) => number;
}

export interface C137FormalBlindProvenanceFixture {
  provenance: C137FormalBlindProvenanceV3;
  manifest: RealMediaBenchmarkManifest;
  plan: C137FormalBlindMatrixPlanV2;
  expectations: C137FormalBlindProvenanceExpectations;
  evaluation: C137FormalBlindProvenanceEvaluation;
  decisions: C137FormalBlindProvenanceEvaluation["decisions"];
}

export function createC137FormalBlindProvenanceFixture(
  options: C137FormalBlindProvenanceFixtureOptions = {}
): C137FormalBlindProvenanceFixture {
  const manifest = createManifest(options.caseCount ?? 6);
  options.mutateManifest?.(manifest);
  const relationshipAxis = options.relationshipAxis ?? "source";
  const visualEvidenceEnabled = options.visualEvidenceEnabled ?? false;
  const globalTopK = options.globalTopK ?? 2;
  const manifestDigest = computeFixtureManifestDigest(manifest);
  const plan = createC137FormalBlindMatrixPlan(manifest, manifestDigest, {
    relationshipAxis,
    visualEvidenceEnabled,
    globalTopK,
    scoreContract: C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT
  });
  const batches = plan.batches.map((batch) =>
    createC137FormalBlindBatchEnvelopeFixture(manifest, plan, batch, options.relationScore)
  );
  const provenance = sealC137FormalBlindProvenanceV3({ manifest, plan, batches });
  const expectations: C137FormalBlindProvenanceExpectations = {
    manifestDigest: provenance.manifestDigest,
    datasetVersion: manifest.datasetVersion,
    planDigest: plan.planDigest,
    parametersDigest: computeC137FormalBlindParametersDigest(provenance),
    topK: globalTopK
  };
  const evaluation = evaluateC137FormalBlindProvenance(provenance, expectations);
  return {
    provenance,
    manifest,
    plan,
    expectations,
    evaluation,
    decisions: evaluation.decisions
  };
}

export function createC137FormalBlindBatchEnvelopeFixture(
  manifest: RealMediaBenchmarkManifest,
  plan: C137FormalBlindMatrixPlanV2,
  planBatch: C137FormalBlindMatrixPlanBatchV2,
  relationScore?: C137FormalBlindProvenanceFixtureOptions["relationScore"]
): C137FormalBlindProvenanceBatchEnvelopeV3 {
  const projection = createProjection(manifest, plan, planBatch);
  const executionSuite = createExecutionSuite(manifest, plan, planBatch, projection);
  const nativeReceipt = createNativeReceipt(
    manifest,
    plan,
    planBatch,
    projection,
    executionSuite,
    relationScore
  );
  const rawPrediction = deriveC137BlindBatchRawPredictionFromNativeReceipt(
    projection,
    executionSuite,
    nativeReceipt
  );
  return {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance-batch",
    batchId: planBatch.batchId,
    projection,
    executionSuite,
    nativeReceipt,
    rawPrediction
  };
}

function createProjection(
  manifest: RealMediaBenchmarkManifest,
  plan: C137FormalBlindMatrixPlanV2,
  batch: C137FormalBlindMatrixPlanBatchV2
): C137BlindBatchExecutionProjection {
  return createC137FormalBlindMatrixExecutionProjection(manifest, {
    queryCaseIds: batch.queryCaseIds,
    candidateCaseIds: batch.candidateCaseIds,
    relationshipAxis: plan.relationshipAxis,
    visualEvidenceEnabled: plan.visualEvidenceEnabled,
    globalTopK: plan.globalTopK
  });
}

function createExecutionSuite(
  manifest: RealMediaBenchmarkManifest,
  plan: C137FormalBlindMatrixPlanV2,
  planBatch: C137FormalBlindMatrixPlanBatchV2,
  projection: C137BlindBatchExecutionProjection
): RealMediaBlindBatchExecutionSuite {
  const byId = new Map(
    manifest.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase])
  );
  const queries = planBatch.queryCaseIds.map((caseId) => requireCase(byId, caseId));
  const candidates = planBatch.candidateCaseIds.map((caseId) => requireCase(byId, caseId));
  const sourceCases = plan.relationshipAxis === "source" ? queries : candidates;
  const targetCases = plan.relationshipAxis === "target" ? queries : candidates;
  return {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_EXECUTION_SCHEMA_VERSION,
    suiteId: projection.suiteId,
    datasetVersion: manifest.datasetVersion,
    topK: plan.globalTopK,
    sources: createExecutionMedia(
      manifest,
      "source",
      plan.visualEvidenceEnabled,
      sourceCases.map((benchmarkCase) => benchmarkCase.source),
      projection.sources
    ),
    targets: createExecutionMedia(
      manifest,
      "target",
      plan.visualEvidenceEnabled,
      targetCases.map((benchmarkCase) => benchmarkCase.target),
      projection.targets
    ),
    pairs: projection.pairs.map((pair, index) => ({
      pairOrdinal: index + 1,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId
    })),
    versionReuseGroups: [],
    parameters: {
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      ffprobePath: "C:\\tools\\ffprobe.exe",
      sampleRate: 16_000,
      windowMs: 32,
      matchThreshold: 0.72,
      minGapMs: 250,
      maxCells: 20_000,
      enableVisualEvidence: plan.visualEvidenceEnabled,
      visualSampleIntervalMs: plan.visualEvidenceEnabled ? 500 : null
    }
  };
}

function createExecutionMedia(
  manifest: RealMediaBenchmarkManifest,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[],
  projected: readonly C137BlindBatchExecutionProjection["sources"][number][]
): RealMediaBlindBatchExecutionMedia[] {
  const ordered = orderC137BlindBatchMediaInputs(
    manifest.id,
    manifest.datasetVersion,
    side,
    visualEvidenceEnabled,
    mediaInputs
  );
  return ordered.map((media, index) => {
    const projectionMedia = projected[index];
    if (projectionMedia === undefined || media.contentIdentity === null) {
      throw new Error("fixture projected media missing");
    }
    const expectedCommitment = createC137BlindBatchMediaBindingCommitment(
      manifest.id,
      manifest.datasetVersion,
      side,
      visualEvidenceEnabled,
      media
    );
    if (projectionMedia.bindingCommitment !== expectedCommitment) {
      throw new Error("fixture projected media binding commitment mismatch");
    }
    return {
      mediaId: projectionMedia.mediaId,
      path: media.path,
      contentIdentity: createExecutionIdentity(media),
      audioStreamIndex: media.audioStreamIndex,
      videoStreamIndex: visualEvidenceEnabled ? media.videoStreamIndex : null
    };
  });
}

function createNativeReceipt(
  manifest: RealMediaBenchmarkManifest,
  plan: C137FormalBlindMatrixPlanV2,
  planBatch: C137FormalBlindMatrixPlanBatchV2,
  projection: C137BlindBatchExecutionProjection,
  suite: RealMediaBlindBatchExecutionSuite,
  scoreOverride: C137FormalBlindProvenanceFixtureOptions["relationScore"]
): RealMediaBlindBatchRunReceipt {
  const model = createC137FormalBlindMatrixModel(
    manifest,
    plan.relationshipAxis,
    plan.visualEvidenceEnabled
  );
  const queryByCommitment = new Map(
    model.queries.map((query) => [query.bindingCommitment, query])
  );
  const candidateByCommitment = new Map(
    model.candidates.map((candidate) => [candidate.bindingCommitment, candidate])
  );
  const projectedById = new Map(
    [...projection.sources, ...projection.targets].map((media) => [media.mediaId, media])
  );
  const draftOutcomes = suite.pairs.map((pair, index) => {
    const source = requireExecutionMedia(suite.sources, pair.sourceMediaId);
    const target = requireExecutionMedia(suite.targets, pair.targetMediaId);
    const queryMediaId =
      plan.relationshipAxis === "source" ? pair.sourceMediaId : pair.targetMediaId;
    const candidateMediaId =
      plan.relationshipAxis === "source" ? pair.targetMediaId : pair.sourceMediaId;
    const queryProjection = projectedById.get(queryMediaId);
    const candidateProjection = projectedById.get(candidateMediaId);
    const query =
      queryProjection === undefined
        ? undefined
        : queryByCommitment.get(queryProjection.bindingCommitment);
    const candidate =
      candidateProjection === undefined
        ? undefined
        : candidateByCommitment.get(candidateProjection.bindingCommitment);
    if (query === undefined || candidate === undefined) {
      throw new Error("fixture pair cannot map to matrix model");
    }
    const candidateSide = plan.relationshipAxis === "source" ? "target" : "source";
    const gold = samePhysicalMedia(query.benchmarkCase[candidateSide], candidate.media);
    const score =
      scoreOverride?.({
        queryCaseId: query.caseId,
        candidateRepresentativeCaseId: candidate.representativeCaseId,
        candidateOrdinal: candidate.ordinal,
        gold
      }) ?? (gold ? 0.95 : 0.25 - candidate.ordinal / 10_000);
    const selected = gold;
    const proposalTimeMap = createProposal(source, target);
    return {
      pairIndex: index,
      pairOrdinal: pair.pairOrdinal,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId,
      nativeStatus: "completed" as const,
      failureCode: null,
      relationRanking: createRelationRanking(source, target, score),
      globalSelected: selected,
      globalSelection: createSelection(source, target, score, selected),
      proposalTimeMap: selected ? proposalTimeMap : null,
      selected
    };
  });
  const selectedCandidateIds = draftOutcomes
    .filter((outcome) => outcome.selected)
    .map((outcome) => ({ pairOrdinal: outcome.pairOrdinal, candidateOrdinal: 1 }));
  const fineFrontier = createTestFineFrontierReceipt(
    suite.pairs.map((pair) => pair.pairOrdinal),
    selectedCandidateIds
  );
  const coarseBackend = TEST_NATIVE_EXECUTION_IDENTITY.sourceSpectralBackends[0];
  const pairOutcomes: RealMediaBlindBatchPairOutcome[] = draftOutcomes.map(
    ({ selected, ...outcome }) => ({
      ...outcome,
      fineFrontier: structuredClone(fineFrontier),
      fineExecutionEvidence:
        selected && outcome.proposalTimeMap !== null
          ? createTestFineExecutionEvidence(outcome.proposalTimeMap, {
              pairOrdinal: outcome.pairOrdinal,
              sourceStreamIndex: outcome.proposalTimeMap.sourceStream?.index ?? 0,
              targetStreamIndex: outcome.proposalTimeMap.targetStream?.index ?? 0,
              engineVersion: TEST_NATIVE_EXECUTION_IDENTITY.engineVersion,
              featureVersion: TEST_NATIVE_EXECUTION_IDENTITY.featureVersion,
              coarseBackend,
              fineBackend: coarseBackend
            })
          : null
    })
  );
  const withoutDigest: Omit<RealMediaBlindBatchRunReceipt, "receiptDigest"> = {
    schemaVersion: REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
    receiptKind: "c137-real-media-blind-batch-run",
    runnerVersion: REAL_MEDIA_BLIND_BATCH_RUNNER_VERSION,
    suiteId: suite.suiteId,
    datasetVersion: suite.datasetVersion,
    executionDigest: createRealMediaBlindBatchExecutionDigest(suite),
    executionIdentityDigest: TEST_NATIVE_EXECUTION_IDENTITY_DIGEST,
    nativeJobId: `native-${planBatch.batchId}`,
    nativeEvidenceVersion: REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
    pairingMode: "fullCartesian",
    status: "completed",
    terminationReason: "native-terminal",
    wallElapsedMs: 1_000,
    sourceCount: suite.sources.length,
    targetCount: suite.targets.length,
    pairCount: suite.pairs.length,
    topK: suite.topK,
    versionReuseGroups: suite.versionReuseGroups.map((group, index) => ({
      ...structuredClone(group),
      groupOrdinal: index + 1
    })),
    pairOutcomes,
    sourceRankings: suite.sources.map((source) =>
      createRealMediaBlindBatchSourceRanking(source.mediaId, pairOutcomes, suite.topK)
    ),
    targetRankings: suite.targets.map((target) =>
      createRealMediaBlindBatchTargetRanking(
        target.mediaId,
        pairOutcomes,
        Math.min(suite.topK, suite.sources.length)
      )
    )
  };
  return {
    ...withoutDigest,
    receiptDigest: createRealMediaBlindBatchRunReceiptDigest(withoutDigest)
  };
}

function createRelationRanking(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number
): NativeBatchRelationRankingEvidence {
  return {
    scoreVersion: REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
    executionIdentityDigest: TEST_NATIVE_EXECUTION_IDENTITY_DIGEST,
    executionIdentity: structuredClone(TEST_NATIVE_EXECUTION_IDENTITY),
    state: "ranked",
    candidateCount: 1,
    eligibleCandidateCount: 1,
    score,
    bestEligibleCandidate: {
      rank: 1,
      sourceStreamIndex: source.audioStreamIndex,
      targetStreamIndex: target.audioStreamIndex,
      score: Math.max(0, score - 0.05),
      globalScore: score,
      scale: 1,
      offsetMs: 0,
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      inlierCount: 40,
      temporalCoverage: 0.95,
      uniqueSourceCoverage: 0.9
    }
  };
}

function createSelection(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number,
  selected: boolean
): NativeBatchGlobalSelectionEvidence {
  const candidate = createGlobalCandidate(source, target, score, selected);
  return {
    state: selected ? "selected" : "blocked",
    selected,
    selectedRank: selected ? 1 : null,
    selectedScore: selected ? score : null,
    decisionRank: 1,
    decisionScore: score,
    margin: 0.25,
    candidateCount: 1,
    eligibleCandidateCount: 1,
    topK: [{ ...candidate }],
    decisionCandidate: { ...candidate }
  };
}

function createGlobalCandidate(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number,
  selected: boolean
): NativeBatchGlobalCandidateEvidence {
  return {
    rank: 1,
    sourceStreamIndex: source.audioStreamIndex,
    targetStreamIndex: target.audioStreamIndex,
    score: Math.max(0, score - 0.05),
    globalScore: score,
    scale: 1,
    offsetMs: 0,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    inlierCount: 40,
    temporalCoverage: 0.95,
    uniqueSourceCoverage: 0.9,
    eligible: true,
    globalSelected: selected
  };
}

function createProposal(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia
): AlignmentTimeMapProposal {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      createTestCompleteTimeMapSpan(
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000
        },
        `${source.mediaId}-${target.mediaId}-span`
      )
    ],
    quality: {
      level: "review",
      probability: 0.91,
      metricSource: "measured",
      coverage: 0.95,
      uniqueContentCoverage: 0.9,
      p50ResidualMs: 30,
      p95ResidualMs: 80,
      p99ResidualMs: 120,
      maxResidualMs: 150,
      boundaryUncertaintyMs: 200,
      alternativeMargin: 0.25,
      anchorCount: 40,
      anchorRegionCount: 3,
      heldOutAnchorCount: 8,
      reasons: ["formal fixture review"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 40,
      visualAnchorCount: 0,
      heldOutAnchorCount: 8,
      top1Top2Margin: 0.25,
      uniqueContentCoverage: 0.9,
      repeatedContentOnly: false,
      selectedTrackReason: "formal fixture",
      alternativeTrackScores: [
        {
          sourceStreamIndex: source.audioStreamIndex,
          targetStreamIndex: target.audioStreamIndex,
          score: 0.9,
          scale: 1,
          offsetMs: 0,
          inlierCount: 40
        }
      ],
      notes: []
    },
    sourceStream: createAudioStream(source.audioStreamIndex),
    targetStream: createAudioStream(target.audioStreamIndex),
    sourceVisualStream: null,
    targetVisualStream: null,
    sourceIdentity: { ...source.contentIdentity },
    targetIdentity: { ...target.contentIdentity },
    engineVersion: "alignment-v2.0-rust",
    featureVersion: "c137-formal-matrix-fixture-v2",
    parametersHash: "sha256:test-parameters"
  };
}

function createAudioStream(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "flac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 2,
    frameRate: null,
    language: "zh",
    title: "main"
  };
}

function createManifest(caseCount: number): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id: "formal-blind-unit-suite",
    name: "正式盲测矩阵结构证据单元测试",
    datasetVersion: "formal-frozen-v2",
    description: `程序构造的 ${caseCount} 关系冻结 manifest。`,
    isExample: false,
    licenseNotes: ["不包含真实媒体内容。"],
    cases: Array.from({ length: caseCount }, (_, index) => createCase(index + 1))
  };
}

function createCase(index: number): RealMediaBenchmarkCase {
  const gold = createGold(index);
  return {
    id: `formal-case-${index}`,
    title: `冻结关系 ${index}`,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: ["global-offset"],
    source: createMedia("source", index),
    target: createMedia("target", index),
    boundaryToleranceMs: 100,
    versionNotes: [`关系 ${index} 的程序构造版本。`],
    licenseNotes: ["不包含真实媒体内容。"],
    independentAnnotations: [
      { reviewerId: `reviewer-alpha-${index}`, gold: structuredClone(gold) },
      { reviewerId: `reviewer-beta-${index}`, gold: structuredClone(gold) }
    ],
    adjudication: {
      status: "not-needed",
      adjudicatorId: null,
      note: "两份独立标注一致。"
    },
    gold
  };
}

function createMedia(side: "source" | "target", index: number): RealMediaBenchmarkMediaInput {
  const digestSeed = side === "source" ? `source-${index}` : `target-${index}`;
  const digest = deterministicDigest(digestSeed);
  return {
    path: `C:\\formal-suite\\${side}-${index}.mkv`,
    audioStreamIndex: side === "source" ? 0 : 1,
    videoStreamIndex: 0,
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: side === "source" ? 1_000_000 + index : 2_000_000 + index,
      digest
    },
    versionNote: `${side} ${index} 的冻结版本。`,
    licenseNote: "程序构造路径。"
  };
}

function deterministicDigest(seed: string): string {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return Array.from({ length: 8 }, (_, index) =>
    ((state + Math.imul(index + 1, 2654435761)) >>> 0).toString(16).padStart(8, "0")
  ).join("");
}

function createExecutionIdentity(media: RealMediaBenchmarkMediaInput): MediaContentIdentity {
  if (media.contentIdentity === null) throw new Error("fixture full identity missing");
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: media.contentIdentity.sizeBytes,
    modifiedUnixMs: media.contentIdentity.sizeBytes,
    firstSampleDigest: media.contentIdentity.digest,
    middleSampleDigest: media.contentIdentity.digest,
    lastSampleDigest: media.contentIdentity.digest
  };
}

function createGold(index: number): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    matchedAnchors: [1_000, 15_000, 30_000, 45_000, 59_000].map((timeMs, anchorIndex) => ({
      id: `formal-${index}-anchor-${anchorIndex}`,
      sourceMs: timeMs,
      targetMs: timeMs
    })),
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function samePhysicalMedia(
  left: RealMediaBenchmarkMediaInput,
  right: RealMediaBenchmarkMediaInput
): boolean {
  return (
    left.contentIdentity !== null &&
    right.contentIdentity !== null &&
    left.contentIdentity.algorithm === right.contentIdentity.algorithm &&
    left.contentIdentity.sizeBytes === right.contentIdentity.sizeBytes &&
    left.contentIdentity.digest.toLowerCase() === right.contentIdentity.digest.toLowerCase()
  );
}

function requireCase(
  cases: ReadonlyMap<string, RealMediaBenchmarkCase>,
  caseId: string
): RealMediaBenchmarkCase {
  const benchmarkCase = cases.get(caseId);
  if (benchmarkCase === undefined) throw new Error(`fixture case missing: ${caseId}`);
  return benchmarkCase;
}

function requireExecutionMedia(
  media: readonly RealMediaBlindBatchExecutionMedia[],
  mediaId: string
): RealMediaBlindBatchExecutionMedia {
  const result = media.find((item) => item.mediaId === mediaId);
  if (result === undefined) throw new Error(`fixture media missing: ${mediaId}`);
  return result;
}

export function resealC137FormalBlindNativeReceiptFixture(
  envelope: C137FormalBlindProvenanceBatchEnvelopeV3
): void {
  const receipt = envelope.nativeReceipt;
  for (const outcome of receipt.pairOutcomes) {
    const current = outcome.fineExecutionEvidence;
    const identity = outcome.relationRanking.executionIdentity;
    if (current === null || identity === null || outcome.proposalTimeMap === null) continue;
    const sourceCoarseBackend = identity.sourceSpectralBackends[0];
    const targetCoarseBackend = identity.targetSpectralBackends[0];
    if (sourceCoarseBackend === undefined || targetCoarseBackend === undefined) {
      throw new Error("fixture execution identity backend missing");
    }
    outcome.fineExecutionEvidence = createTestFineExecutionEvidence(outcome.proposalTimeMap, {
      pairOrdinal: current.candidateId.pairOrdinal,
      candidateOrdinal: current.candidateId.candidateOrdinal,
      sourceStreamIndex: current.sourceStreamIndex,
      targetStreamIndex: current.targetStreamIndex,
      scoreMicros: current.scoreMicros,
      engineVersion: identity.engineVersion,
      featureVersion: identity.featureVersion,
      sourceCoarseBackend,
      targetCoarseBackend,
      sourceFineBackend: createFixtureFineBackend(sourceCoarseBackend),
      targetFineBackend: createFixtureFineBackend(targetCoarseBackend),
      selectedMemberRank: current.selectedMemberRank,
      groupMemberRanks: [...current.groupMemberRanks]
    });
  }
  receipt.sourceRankings = envelope.executionSuite.sources.map((source) =>
    createRealMediaBlindBatchSourceRanking(
      source.mediaId,
      receipt.pairOutcomes,
      envelope.executionSuite.topK
    )
  );
  receipt.targetRankings = envelope.executionSuite.targets.map((target) =>
    createRealMediaBlindBatchTargetRanking(
      target.mediaId,
      receipt.pairOutcomes,
      Math.min(envelope.executionSuite.topK, envelope.executionSuite.sources.length)
    )
  );
  const { receiptDigest, ...draft } = receipt;
  void receiptDigest;
  receipt.receiptDigest = createRealMediaBlindBatchRunReceiptDigest(draft);
  envelope.rawPrediction = deriveC137BlindBatchRawPredictionFromNativeReceipt(
    envelope.projection,
    envelope.executionSuite,
    receipt
  );
}

function createFixtureFineBackend(
  coarse: NativeBatchExecutionIdentity["sourceSpectralBackends"][number]
): NativeBatchExecutionIdentity["sourceSpectralBackends"][number] {
  const locked = deriveLockedFineSpectralBackendIdentity(coarse);
  if (locked === null)
    throw new Error(`fixture coarse backend 无法锁定 fine：${coarse.backendId}`);
  return locked;
}

export function resealC137FormalBlindProvenanceFixture(
  provenance: C137FormalBlindProvenanceV3
): void {
  const { provenanceDigest, ...draft } = provenance;
  void provenanceDigest;
  provenance.provenanceDigest = computeC137FormalBlindProvenanceDigest(draft);
}

export function resealC137FormalBlindPlanAndProvenanceFixture(
  provenance: C137FormalBlindProvenanceV3
): void {
  const expected = createC137FormalBlindMatrixPlan(
    provenance.manifest,
    provenance.manifestDigest,
    {
      relationshipAxis: provenance.plan.relationshipAxis,
      visualEvidenceEnabled: provenance.plan.visualEvidenceEnabled,
      globalTopK: provenance.plan.globalTopK,
      scoreContract: provenance.plan.scoreContract
    }
  );
  provenance.plan = expected;
  resealC137FormalBlindProvenanceFixture(provenance);
}
