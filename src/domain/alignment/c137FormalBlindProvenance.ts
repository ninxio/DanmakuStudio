import type { C137Digest } from "./c137Acceptance";
import {
  deriveC137BlindBatchRawPredictionFromNativeReceipt,
  orderC137BlindBatchMediaInputs,
  createC137BlindBatchMediaBindingCommitment,
  type C137BlindBatchExecutionProjection,
  type C137BlindBatchRawPrediction
} from "./c137BlindBatchEvidence";
import {
  C137_FORMAL_BLIND_MATRIX_COVERAGE,
  C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION,
  C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
  computeC137FormalBlindCandidateUniverseDigest,
  computeC137FormalBlindMatrixPlanDigest,
  createC137FormalBlindMatrixExecutionProjection,
  createC137FormalBlindMatrixModel,
  createC137FormalBlindMatrixPlan,
  createC137FormalBlindMatrixTileLayout,
  type C137FormalBlindMatrixCandidateEntry,
  type C137FormalBlindMatrixPlanBatchV2,
  type C137FormalBlindMatrixPlanOptions,
  type C137FormalBlindMatrixPlanV2,
  type C137FormalBlindMatrixTile
} from "./c137FormalBlindMatrixPlan";
import {
  validateRealMediaBenchmarkManifest,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput
} from "./realMediaBenchmark";
import {
  validateRealMediaBlindBatchExecutionSuite,
  type NativeBatchRelationRankingEvidence,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchRunReceipt
} from "./realMediaBlindBatchContract";
import { sha256Hex } from "../shared/sha256";

export const C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION = 3 as const;
export const C137_FORMAL_BLIND_CALIBRATION_FEATURE_CONTRACT =
  "normalized-top1-relation-score-margin-v1" as const;

const MANIFEST_DIGEST_DOMAIN = "c137-formal-blind-full-manifest-v3";
const GOLD_DIGEST_DOMAIN = "c137-formal-blind-gold-v3";
const MEDIA_BINDINGS_DIGEST_DOMAIN = "c137-formal-blind-media-bindings-v3";
const PARAMETERS_DIGEST_DOMAIN = "c137-formal-blind-execution-parameters-v3";
const PROVENANCE_DIGEST_DOMAIN = "c137-formal-blind-provenance-v3";
const OBSERVATION_DIGEST_DOMAIN = "c137-formal-blind-query-observations-v3";
const DECISION_DIGEST_DOMAIN = "c137-formal-blind-global-decision-v3";
const GLOBAL_PAIR_ID_DOMAIN = "c137-formal-blind-global-pair-v3";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface C137FormalBlindProvenanceBatchEnvelopeV3 {
  schemaVersion: typeof C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION;
  kind: "c137-formal-blind-provenance-batch";
  batchId: string;
  projection: C137BlindBatchExecutionProjection;
  executionSuite: RealMediaBlindBatchExecutionSuite;
  nativeReceipt: RealMediaBlindBatchRunReceipt;
  rawPrediction: C137BlindBatchRawPrediction;
}

export interface C137FormalBlindProvenanceV3 {
  schemaVersion: typeof C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION;
  kind: "c137-formal-blind-provenance";
  releaseEligible: false;
  trustStatus: "untrusted-self-consistent-provenance";
  manifest: RealMediaBenchmarkManifest;
  manifestDigest: C137Digest;
  goldDigest: C137Digest;
  mediaBindingsDigest: C137Digest;
  executionIdentityDigest: C137Digest;
  plan: C137FormalBlindMatrixPlanV2;
  batches: C137FormalBlindProvenanceBatchEnvelopeV3[];
  provenanceDigest: C137Digest;
}

export interface C137FormalBlindProvenanceExpectations {
  manifestDigest: C137Digest;
  datasetVersion: string;
  planDigest: C137Digest;
  parametersDigest: C137Digest;
  topK: number;
}

export interface C137FormalBlindDerivedRelationshipDecisionV3 {
  caseId: string;
  provenanceRef: C137Digest;
  goldPairId: C137Digest;
  rankedPairIds: C137Digest[];
  top1Score: number;
  top2Score: number;
  scoreMargin: number;
}

export interface C137FormalBlindGlobalScoreObservation {
  candidateOrdinal: number;
  pairId: C137Digest;
  score: number | null;
}

export interface C137FormalBlindProvenanceEvaluation {
  valid: boolean;
  issues: string[];
  coverageValid: boolean;
  decisions: C137FormalBlindDerivedRelationshipDecisionV3[];
}

interface MatrixObservation {
  queryCaseId: string;
  candidateOrdinal: number;
  candidateRepresentativeCaseId: string;
  pairId: C137Digest;
  batchId: string;
  receiptDigest: C137Digest;
  pairOrdinal: number;
  relationRanking: NativeBatchRelationRankingEvidence;
}

type C137FormalBlindProvenanceDraft = Omit<C137FormalBlindProvenanceV3, "provenanceDigest">;

export {
  C137_FORMAL_BLIND_MATRIX_COVERAGE,
  C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION,
  C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
  computeC137FormalBlindCandidateUniverseDigest,
  computeC137FormalBlindMatrixPlanDigest,
  createC137FormalBlindMatrixExecutionProjection,
  createC137FormalBlindMatrixModel,
  createC137FormalBlindMatrixPlan,
  createC137FormalBlindMatrixTileLayout
};
export type {
  C137FormalBlindMatrixPlanBatchV2,
  C137FormalBlindMatrixPlanOptions,
  C137FormalBlindMatrixPlanV2,
  C137FormalBlindMatrixTile
};

export function computeC137FormalBlindManifestDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return digest(MANIFEST_DIGEST_DOMAIN, canonicalJson(manifest));
}

export function computeC137FormalBlindGoldDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return digest(
    GOLD_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.id,
      datasetVersion: manifest.datasetVersion,
      cases: manifest.cases.map((benchmarkCase) => ({
        id: benchmarkCase.id,
        mediaKind: benchmarkCase.mediaKind,
        split: benchmarkCase.split,
        scenarios: benchmarkCase.scenarios,
        boundaryToleranceMs: benchmarkCase.boundaryToleranceMs,
        independentAnnotations: benchmarkCase.independentAnnotations,
        adjudication: benchmarkCase.adjudication,
        gold: benchmarkCase.gold
      }))
    })
  );
}

export function computeC137FormalBlindMediaBindingsDigest(
  manifest: RealMediaBenchmarkManifest
): C137Digest {
  return digest(
    MEDIA_BINDINGS_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: manifest.schemaVersion,
      manifestId: manifest.id,
      datasetVersion: manifest.datasetVersion,
      cases: manifest.cases.map((benchmarkCase) => ({
        caseId: benchmarkCase.id,
        source: formalMediaBinding(benchmarkCase.source),
        target: formalMediaBinding(benchmarkCase.target)
      }))
    })
  );
}

export function computeC137FormalBlindPlanDigest(
  plan: Omit<C137FormalBlindMatrixPlanV2, "planDigest"> | C137FormalBlindMatrixPlanV2
): C137Digest {
  return computeC137FormalBlindMatrixPlanDigest(plan);
}

export function computeC137FormalBlindParametersDigest(
  provenance: Pick<C137FormalBlindProvenanceV3, "plan" | "batches">
): C137Digest {
  const first = provenance.batches[0]?.executionSuite.parameters;
  if (first === undefined) throw new Error("formal blind provenance 至少需要一个 batch。");
  if (
    provenance.batches.some((batch) => !canonicalEqual(batch.executionSuite.parameters, first))
  ) {
    throw new Error("formal blind matrix 所有 batch execution parameters 必须 exact equal。");
  }
  return digest(
    PARAMETERS_DIGEST_DOMAIN,
    canonicalJson({
      scoreContract: provenance.plan.scoreContract,
      parameters: first
    })
  );
}

function requireUnifiedExecutionIdentityDigest(
  batches: readonly C137FormalBlindProvenanceBatchEnvelopeV3[]
): C137Digest {
  const first = batches[0]?.nativeReceipt.executionIdentityDigest;
  if (first === undefined || first === null || !DIGEST.test(first)) {
    throw new Error("formal blind matrix 首个 tile 缺少规范 executionIdentityDigest。");
  }
  for (const batch of batches) {
    if (batch.nativeReceipt.executionIdentityDigest !== first) {
      throw new Error(
        `formal blind batch ${batch.batchId} execution identity 与首个 tile 漂移。`
      );
    }
    if (
      batch.nativeReceipt.pairOutcomes.some(
        (outcome) => outcome.relationRanking.executionIdentityDigest !== first
      )
    ) {
      throw new Error(
        `formal blind batch ${batch.batchId} 存在 cell execution identity 漂移。`
      );
    }
  }
  return first;
}

export function computeC137FormalBlindProvenanceDigest(
  provenance: C137FormalBlindProvenanceDraft | C137FormalBlindProvenanceV3
): C137Digest {
  return digest(
    PROVENANCE_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: provenance.schemaVersion,
      kind: provenance.kind,
      releaseEligible: provenance.releaseEligible,
      trustStatus: provenance.trustStatus,
      manifest: provenance.manifest,
      manifestDigest: provenance.manifestDigest,
      goldDigest: provenance.goldDigest,
      mediaBindingsDigest: provenance.mediaBindingsDigest,
      executionIdentityDigest: provenance.executionIdentityDigest,
      plan: provenance.plan,
      batches: provenance.batches
    })
  );
}

export function sealC137FormalBlindProvenanceV3(input: {
  manifest: RealMediaBenchmarkManifest;
  plan: C137FormalBlindMatrixPlanV2;
  batches: readonly C137FormalBlindProvenanceBatchEnvelopeV3[];
}): C137FormalBlindProvenanceV3 {
  const manifest = structuredClone(input.manifest);
  const manifestDigest = computeC137FormalBlindManifestDigest(manifest);
  const expectedPlan = createC137FormalBlindMatrixPlan(manifest, manifestDigest, {
    relationshipAxis: input.plan.relationshipAxis,
    visualEvidenceEnabled: input.plan.visualEvidenceEnabled,
    globalTopK: input.plan.globalTopK,
    scoreContract: input.plan.scoreContract
  });
  if (!canonicalEqual(input.plan, expectedPlan)) {
    throw new Error("formal blind seal 拒绝非唯一、非 exhaustive 或摘要未闭合的 matrix plan。");
  }
  const draft: C137FormalBlindProvenanceDraft = {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance",
    releaseEligible: false,
    trustStatus: "untrusted-self-consistent-provenance",
    manifest,
    manifestDigest,
    goldDigest: computeC137FormalBlindGoldDigest(manifest),
    mediaBindingsDigest: computeC137FormalBlindMediaBindingsDigest(manifest),
    executionIdentityDigest: requireUnifiedExecutionIdentityDigest(input.batches),
    plan: structuredClone(expectedPlan),
    batches: structuredClone([...input.batches])
  };
  const sealed: C137FormalBlindProvenanceV3 = {
    ...draft,
    provenanceDigest: computeC137FormalBlindProvenanceDigest(draft)
  };
  const validation = validateC137FormalBlindProvenance(sealed);
  if (!validation.valid) {
    throw new Error(`formal blind seal 校验失败：${validation.issues.join("；")}`);
  }
  return structuredClone(sealed);
}

export function validateC137FormalBlindProvenance(
  value: unknown
): C137FormalBlindProvenanceEvaluation {
  return evaluateInternal(value, undefined);
}

export function evaluateC137FormalBlindProvenance(
  value: unknown,
  expected: C137FormalBlindProvenanceExpectations
): C137FormalBlindProvenanceEvaluation {
  return evaluateInternal(value, expected);
}

function evaluateInternal(
  value: unknown,
  expected: C137FormalBlindProvenanceExpectations | undefined
): C137FormalBlindProvenanceEvaluation {
  try {
    if (expected !== undefined) validateExpectations(expected);
    const provenance = parseProvenance(value);
    validateFormalManifest(provenance.manifest);
    validateConsistentPathIdentities(provenance.manifest);
    validateUniquePhysicalRelationships(provenance.manifest);

    const manifestDigest = computeC137FormalBlindManifestDigest(provenance.manifest);
    if (provenance.manifestDigest !== manifestDigest) {
      throw new Error("formal blind manifestDigest 与完整 manifest 不一致。");
    }
    if (provenance.goldDigest !== computeC137FormalBlindGoldDigest(provenance.manifest)) {
      throw new Error("formal blind goldDigest 与完整冻结 gold 不一致。");
    }
    if (
      provenance.mediaBindingsDigest !==
      computeC137FormalBlindMediaBindingsDigest(provenance.manifest)
    ) {
      throw new Error("formal blind mediaBindingsDigest 与路径/全文件身份/流绑定不一致。");
    }
    if (
      provenance.executionIdentityDigest !==
      requireUnifiedExecutionIdentityDigest(provenance.batches)
    ) {
      throw new Error("formal blind executionIdentityDigest 未精确绑定全部 matrix tile/cell。");
    }
    const expectedPlan = createC137FormalBlindMatrixPlan(provenance.manifest, manifestDigest, {
      relationshipAxis: provenance.plan.relationshipAxis,
      visualEvidenceEnabled: provenance.plan.visualEvidenceEnabled,
      globalTopK: provenance.plan.globalTopK,
      scoreContract: provenance.plan.scoreContract
    });
    if (!canonicalEqual(provenance.plan, expectedPlan)) {
      throw new Error(
        "formal blind matrix plan 不是 manifest 的唯一 exhaustive query×candidate tile 计划。"
      );
    }
    if (
      provenance.plan.candidateUniverseDigest !==
      computeC137FormalBlindCandidateUniverseDigest(
        provenance.manifest,
        provenance.plan.relationshipAxis,
        provenance.plan.visualEvidenceEnabled
      )
    ) {
      throw new Error("formal blind candidateUniverseDigest 不一致。");
    }
    if (provenance.provenanceDigest !== computeC137FormalBlindProvenanceDigest(provenance)) {
      throw new Error("formal blind provenanceDigest 与完整私有 provenance 内容不一致。");
    }

    if (expected !== undefined) {
      if (manifestDigest !== expected.manifestDigest) {
        throw new Error("formal blind manifestDigest 未命中外部期望。");
      }
      if (provenance.manifest.datasetVersion !== expected.datasetVersion) {
        throw new Error("formal blind datasetVersion 未命中外部期望。");
      }
      if (provenance.plan.planDigest !== expected.planDigest) {
        throw new Error("formal blind planDigest 未命中外部期望。");
      }
      if (provenance.plan.globalTopK !== expected.topK) {
        throw new Error("formal blind globalTopK 未命中外部期望。");
      }
    }

    if (provenance.batches.length !== provenance.plan.batches.length) {
      throw new Error("formal blind plan 与 batch envelope 数量不一一对应。");
    }
    const model = createC137FormalBlindMatrixModel(
      provenance.manifest,
      provenance.plan.relationshipAxis,
      provenance.plan.visualEvidenceEnabled
    );
    const queryByCommitment = new Map(
      model.queries.map((query) => [query.bindingCommitment, query])
    );
    const candidateByCommitment = new Map(
      model.candidates.map((candidate) => [candidate.bindingCommitment, candidate])
    );
    const seenBatchIds = new Set<string>();
    const seenNativeJobIds = new Set<string>();
    const seenReceiptDigests = new Set<C137Digest>();
    const coveredCells = new Set<string>();
    const observations: MatrixObservation[] = [];
    const orderedReceiptDigests: C137Digest[] = [];
    let commonParameters: RealMediaBlindBatchExecutionSuite["parameters"] | null = null;

    provenance.plan.batches.forEach((planBatch, batchIndex) => {
      if (seenBatchIds.has(planBatch.batchId)) {
        throw new Error(`formal blind batchId 重复：${planBatch.batchId}。`);
      }
      seenBatchIds.add(planBatch.batchId);
      const envelope = provenance.batches[batchIndex];
      if (envelope === undefined || envelope.batchId !== planBatch.batchId) {
        throw new Error("formal blind plan/envelope 必须按序以 batchId 一一对应。");
      }
      const expectedProjection = createC137FormalBlindMatrixExecutionProjection(
        provenance.manifest,
        {
          queryCaseIds: planBatch.queryCaseIds,
          candidateCaseIds: planBatch.candidateCaseIds,
          relationshipAxis: provenance.plan.relationshipAxis,
          visualEvidenceEnabled: provenance.plan.visualEvidenceEnabled,
          globalTopK: provenance.plan.globalTopK
        }
      );
      if (
        expectedProjection.projectionDigest !== planBatch.projectionDigest ||
        !canonicalEqual(envelope.projection, expectedProjection)
      ) {
        throw new Error(
          `formal blind batch ${planBatch.batchId} projection/projectionDigest 不是唯一重建结果。`
        );
      }
      const executionSuite = validateExecutionManifestBinding(
        provenance.manifest,
        provenance.plan,
        planBatch,
        expectedProjection,
        envelope.executionSuite
      );
      if (commonParameters === null) {
        commonParameters = executionSuite.parameters;
      } else if (!canonicalEqual(commonParameters, executionSuite.parameters)) {
        throw new Error(
          "formal blind matrix 所有 batch execution parameters 必须 exact equal。"
        );
      }
      const derivedRaw = deriveC137BlindBatchRawPredictionFromNativeReceipt(
        expectedProjection,
        executionSuite,
        envelope.nativeReceipt
      );
      if (!canonicalEqual(envelope.rawPrediction, derivedRaw)) {
        throw new Error(
          `formal blind batch ${planBatch.batchId} rawPrediction 不是 native receipt 的唯一派生结果。`
        );
      }
      const receipt = envelope.nativeReceipt;
      if (receipt.executionIdentityDigest !== provenance.executionIdentityDigest) {
        throw new Error(
          `formal blind batch ${planBatch.batchId} execution identity 与 matrix pin 漂移。`
        );
      }
      if (seenNativeJobIds.has(receipt.nativeJobId)) {
        throw new Error(`formal blind nativeJobId replay：${receipt.nativeJobId}。`);
      }
      if (seenReceiptDigests.has(receipt.receiptDigest)) {
        throw new Error(`formal blind receiptDigest replay：${receipt.receiptDigest}。`);
      }
      seenNativeJobIds.add(receipt.nativeJobId);
      seenReceiptDigests.add(receipt.receiptDigest);
      orderedReceiptDigests.push(receipt.receiptDigest);

      const projectedMediaById = new Map(
        [...expectedProjection.sources, ...expectedProjection.targets].map((media) => [
          media.mediaId,
          media
        ])
      );
      envelope.nativeReceipt.pairOutcomes.forEach((outcome, pairIndex) => {
        const pair = expectedProjection.pairs[pairIndex];
        if (pair === undefined || outcome.pairOrdinal !== pairIndex + 1) {
          throw new Error(`formal blind batch ${planBatch.batchId} pair outcome 顺序错配。`);
        }
        const queryMediaId =
          provenance.plan.relationshipAxis === "source"
            ? pair.sourceMediaId
            : pair.targetMediaId;
        const candidateMediaId =
          provenance.plan.relationshipAxis === "source"
            ? pair.targetMediaId
            : pair.sourceMediaId;
        const queryProjection = projectedMediaById.get(queryMediaId);
        const candidateProjection = projectedMediaById.get(candidateMediaId);
        const query =
          queryProjection === undefined
            ? undefined
            : queryByCommitment.get(queryProjection.bindingCommitment);
        const candidate =
          candidateProjection === undefined
            ? undefined
            : candidateByCommitment.get(candidateProjection.bindingCommitment);
        if (query === undefined || candidate === undefined) {
          throw new Error(`formal blind batch ${planBatch.batchId} pair 无法映射到全局矩阵。`);
        }
        if (outcome.relationRanking.scoreVersion !== provenance.plan.scoreContract) {
          throw new Error(
            `formal blind batch ${planBatch.batchId} relationRanking scoreVersion 错配。`
          );
        }
        if (
          outcome.relationRanking.executionIdentityDigest !== provenance.executionIdentityDigest
        ) {
          throw new Error(
            `formal blind batch ${planBatch.batchId} pair execution identity 与 matrix pin 漂移。`
          );
        }
        const cellKey = matrixCellKey(query.caseId, candidate.ordinal);
        if (coveredCells.has(cellKey)) {
          throw new Error(
            `formal blind matrix cell 重复：${query.caseId}×${candidate.representativeCaseId}。`
          );
        }
        coveredCells.add(cellKey);
        observations.push({
          queryCaseId: query.caseId,
          candidateOrdinal: candidate.ordinal,
          candidateRepresentativeCaseId: candidate.representativeCaseId,
          pairId: createGlobalPairId(provenance.plan, query.caseId, candidate),
          batchId: planBatch.batchId,
          receiptDigest: receipt.receiptDigest,
          pairOrdinal: outcome.pairOrdinal,
          relationRanking: structuredClone(outcome.relationRanking)
        });
      });
    });

    const expectedCellCount = model.queries.length * model.candidates.length;
    if (coveredCells.size !== expectedCellCount) {
      const missing: string[] = [];
      for (const query of model.queries) {
        for (const candidate of model.candidates) {
          const key = matrixCellKey(query.caseId, candidate.ordinal);
          if (!coveredCells.has(key)) {
            missing.push(`${query.caseId}×${candidate.representativeCaseId}`);
          }
        }
      }
      throw new Error(
        `formal blind exhaustive matrix coverage 缺少 ${expectedCellCount - coveredCells.size} cell：${missing.slice(0, 8).join(", ")}。`
      );
    }
    if (observations.length !== expectedCellCount) {
      throw new Error("formal blind matrix observation 数量与 exhaustive coverage 不一致。");
    }
    const parametersDigest = computeC137FormalBlindParametersDigest(provenance);
    if (expected !== undefined && parametersDigest !== expected.parametersDigest) {
      throw new Error("formal blind parametersDigest 未命中外部期望。");
    }

    const decisions = deriveGlobalDecisions(
      provenance.manifest,
      provenance.plan,
      model.candidates,
      model.candidateByPhysicalKey,
      observations,
      orderedReceiptDigests
    );
    return { valid: true, issues: [], coverageValid: true, decisions };
  } catch (error) {
    return {
      valid: false,
      issues: [error instanceof Error ? error.message : "formal blind provenance 校验失败。"],
      coverageValid: false,
      decisions: []
    };
  }
}

function deriveGlobalDecisions(
  manifest: RealMediaBenchmarkManifest,
  plan: C137FormalBlindMatrixPlanV2,
  candidates: readonly C137FormalBlindMatrixCandidateEntry[],
  candidateByPhysicalKey: ReadonlyMap<string, C137FormalBlindMatrixCandidateEntry>,
  observations: readonly MatrixObservation[],
  orderedReceiptDigests: readonly C137Digest[]
): C137FormalBlindDerivedRelationshipDecisionV3[] {
  const candidateSide = plan.relationshipAxis === "source" ? "target" : "source";
  const observationsByQuery = new Map<string, MatrixObservation[]>();
  for (const observation of observations) {
    const list = observationsByQuery.get(observation.queryCaseId) ?? [];
    list.push(observation);
    observationsByQuery.set(observation.queryCaseId, list);
  }
  return manifest.cases.map((benchmarkCase) => {
    const queryObservations = observationsByQuery.get(benchmarkCase.id) ?? [];
    if (queryObservations.length !== candidates.length) {
      throw new Error(
        `formal blind query ${benchmarkCase.id} 未收齐完整 candidate universe 后不得生成 Top-K。`
      );
    }
    const orderedByCandidate = [...queryObservations].sort(
      (left, right) => left.candidateOrdinal - right.candidateOrdinal
    );
    if (
      orderedByCandidate.some((observation, index) => observation.candidateOrdinal !== index)
    ) {
      throw new Error(`formal blind query ${benchmarkCase.id} candidate ordinal 缺失或重复。`);
    }
    const rankedObservations = rankC137FormalBlindGlobalScoreObservations(
      orderedByCandidate.map((observation) => ({
        candidateOrdinal: observation.candidateOrdinal,
        pairId: observation.pairId,
        score: observation.relationRanking.score
      })),
      plan.globalTopK,
      benchmarkCase.id
    );
    const rankedPairIds = rankedObservations.map((observation) => observation.pairId);
    const top1Score = requireRankedScore(rankedObservations[0], benchmarkCase.id, 1);
    const top2Score = requireRankedScore(rankedObservations[1], benchmarkCase.id, 2);
    const scoreMargin = deriveC137FormalBlindCalibrationScoreMargin(top1Score, top2Score);
    const goldPhysicalKey = fullFileIdentityKey(
      benchmarkCase[candidateSide],
      `${benchmarkCase.id}.${candidateSide}`
    );
    const goldCandidate = candidateByPhysicalKey.get(goldPhysicalKey);
    if (goldCandidate === undefined) {
      throw new Error(
        `formal blind query ${benchmarkCase.id} 的 gold candidate 不在全局 union。`
      );
    }
    const observationDigest = digest(
      OBSERVATION_DIGEST_DOMAIN,
      canonicalJson(
        orderedByCandidate.map((observation) => ({
          candidateOrdinal: observation.candidateOrdinal,
          candidateRepresentativeCaseId: observation.candidateRepresentativeCaseId,
          pairId: observation.pairId,
          batchId: observation.batchId,
          receiptDigest: observation.receiptDigest,
          pairOrdinal: observation.pairOrdinal,
          relationRanking: observation.relationRanking
        }))
      )
    );
    const provenanceRef = digest(
      DECISION_DIGEST_DOMAIN,
      canonicalJson({
        planDigest: plan.planDigest,
        caseId: benchmarkCase.id,
        orderedReceiptDigests,
        observationDigest,
        rankedPairIds
      })
    );
    return {
      caseId: benchmarkCase.id,
      provenanceRef,
      goldPairId: createGlobalPairId(plan, benchmarkCase.id, goldCandidate),
      rankedPairIds,
      top1Score,
      top2Score,
      scoreMargin
    };
  });
}

export function rankC137FormalBlindGlobalScores(
  observations: readonly C137FormalBlindGlobalScoreObservation[],
  globalTopK: number,
  queryLabel: string = "unknown"
): C137Digest[] {
  return rankC137FormalBlindGlobalScoreObservations(observations, globalTopK, queryLabel).map(
    (observation) => observation.pairId
  );
}

export function deriveC137FormalBlindCalibrationScoreMargin(
  top1Score: number,
  top2Score: number
): number {
  if (!Number.isFinite(top1Score) || !Number.isFinite(top2Score)) {
    throw new Error("formal blind calibration Top-1/Top-2 score 必须是有限数字。");
  }
  if (top2Score > top1Score) {
    throw new Error("formal blind calibration Top-2 score 不得高于 Top-1。");
  }
  const denominator = Math.max(Math.abs(top1Score), 0.001);
  return Math.min(1, Math.max(0, (top1Score - top2Score) / denominator));
}

function rankC137FormalBlindGlobalScoreObservations(
  observations: readonly C137FormalBlindGlobalScoreObservation[],
  globalTopK: number,
  queryLabel: string
): C137FormalBlindGlobalScoreObservation[] {
  assertGlobalTopK(globalTopK);
  const ordinals = new Set<number>();
  const pairIds = new Set<C137Digest>();
  for (const observation of observations) {
    if (
      !Number.isSafeInteger(observation.candidateOrdinal) ||
      observation.candidateOrdinal < 0
    ) {
      throw new Error("formal blind global score candidateOrdinal 无效。");
    }
    if (ordinals.has(observation.candidateOrdinal) || pairIds.has(observation.pairId)) {
      throw new Error("formal blind global score observation 含重复 candidate/pair。");
    }
    assertDigest(observation.pairId, "formal blind global score pairId");
    if (observation.score !== null && !Number.isFinite(observation.score)) {
      throw new Error("formal blind global score 必须是 finite number 或 null。");
    }
    ordinals.add(observation.candidateOrdinal);
    pairIds.add(observation.pairId);
  }
  const eligible = observations.filter((observation) => observation.score !== null);
  if (eligible.length < globalTopK) {
    throw new Error(
      `formal blind query ${queryLabel} 只有 ${eligible.length} 个 intrinsic eligible candidate，少于 globalTopK=${globalTopK}。`
    );
  }
  return [...eligible].sort(compareGlobalScoreObservations).slice(0, globalTopK);
}

function requireRankedScore(
  observation: C137FormalBlindGlobalScoreObservation | undefined,
  queryLabel: string,
  rank: number
): number {
  if (observation?.score === null || observation?.score === undefined) {
    throw new Error(`formal blind query ${queryLabel} 缺少 Top-${rank} calibration score。`);
  }
  return observation.score;
}

function compareGlobalScoreObservations(
  left: C137FormalBlindGlobalScoreObservation,
  right: C137FormalBlindGlobalScoreObservation
): number {
  const leftScore = left.score;
  const rightScore = right.score;
  if (leftScore === null && rightScore !== null) return 1;
  if (leftScore !== null && rightScore === null) return -1;
  if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  return left.candidateOrdinal - right.candidateOrdinal;
}

function createGlobalPairId(
  plan: C137FormalBlindMatrixPlanV2,
  queryCaseId: string,
  candidate: C137FormalBlindMatrixCandidateEntry
): C137Digest {
  return digest(
    GLOBAL_PAIR_ID_DOMAIN,
    canonicalJson({
      manifestDigest: plan.manifestDigest,
      candidateUniverseDigest: plan.candidateUniverseDigest,
      relationshipAxis: plan.relationshipAxis,
      visualEvidenceEnabled: plan.visualEvidenceEnabled,
      queryCaseId,
      candidateOrdinal: candidate.ordinal,
      candidateBindingCommitment: candidate.bindingCommitment
    })
  );
}

function validateExecutionManifestBinding(
  manifest: RealMediaBenchmarkManifest,
  plan: C137FormalBlindMatrixPlanV2,
  planBatch: C137FormalBlindMatrixPlanBatchV2,
  projection: C137BlindBatchExecutionProjection,
  executionSuiteValue: unknown
): RealMediaBlindBatchExecutionSuite {
  const executionSuite = validateRealMediaBlindBatchExecutionSuite(executionSuiteValue);
  if (
    executionSuite.datasetVersion !== manifest.datasetVersion ||
    executionSuite.suiteId !== projection.suiteId ||
    executionSuite.topK !== plan.globalTopK
  ) {
    throw new Error(`formal blind batch ${planBatch.batchId} execution identity/topK 错配。`);
  }
  const model = createC137FormalBlindMatrixModel(
    manifest,
    plan.relationshipAxis,
    plan.visualEvidenceEnabled
  );
  const queryCases = planBatch.queryCaseIds.map((caseId) =>
    requireCase(model.caseById, caseId)
  );
  const candidateCases = planBatch.candidateCaseIds.map((caseId) =>
    requireCase(model.caseById, caseId)
  );
  const sourceCases = plan.relationshipAxis === "source" ? queryCases : candidateCases;
  const targetCases = plan.relationshipAxis === "target" ? queryCases : candidateCases;
  validateExecutionSideBinding(
    manifest,
    "source",
    plan.visualEvidenceEnabled,
    sourceCases.map((benchmarkCase) => benchmarkCase.source),
    projection.sources,
    executionSuite.sources
  );
  validateExecutionSideBinding(
    manifest,
    "target",
    plan.visualEvidenceEnabled,
    targetCases.map((benchmarkCase) => benchmarkCase.target),
    projection.targets,
    executionSuite.targets
  );
  return executionSuite;
}

function validateExecutionSideBinding(
  manifest: RealMediaBenchmarkManifest,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[],
  projectedMedia: readonly C137BlindBatchExecutionProjection["sources"][number][],
  executionMedia: readonly RealMediaBlindBatchExecutionSuite["sources"][number][]
): void {
  const ordered = orderC137BlindBatchMediaInputs(
    manifest.id,
    manifest.datasetVersion,
    side,
    visualEvidenceEnabled,
    mediaInputs
  );
  if (ordered.length !== projectedMedia.length || ordered.length !== executionMedia.length) {
    throw new Error(`formal blind ${side} manifest/projection/execution media 数量错配。`);
  }
  ordered.forEach((media, index) => {
    const projected = projectedMedia[index];
    const execution = executionMedia[index];
    const expectedVideoStreamIndex = visualEvidenceEnabled ? media.videoStreamIndex : null;
    const fullFileDigest = media.contentIdentity?.digest.toLowerCase();
    if (
      projected === undefined ||
      execution === undefined ||
      media.contentIdentity === null ||
      projected.bindingCommitment !==
        createC137BlindBatchMediaBindingCommitment(
          manifest.id,
          manifest.datasetVersion,
          side,
          visualEvidenceEnabled,
          media
        ) ||
      execution.mediaId !== projected.mediaId ||
      execution.path !== media.path ||
      execution.audioStreamIndex !== media.audioStreamIndex ||
      execution.videoStreamIndex !== expectedVideoStreamIndex ||
      execution.contentIdentity.algorithm !== media.contentIdentity.algorithm ||
      execution.contentIdentity.sizeBytes !== media.contentIdentity.sizeBytes ||
      execution.contentIdentity.firstSampleDigest.toLowerCase() !== fullFileDigest ||
      execution.contentIdentity.middleSampleDigest.toLowerCase() !== fullFileDigest ||
      execution.contentIdentity.lastSampleDigest.toLowerCase() !== fullFileDigest
    ) {
      throw new Error(
        `formal blind ${side}[${index}] 未精确绑定 manifest path/full identity commitment/streams。`
      );
    }
  });
}

function parseProvenance(value: unknown): C137FormalBlindProvenanceV3 {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "releaseEligible",
      "trustStatus",
      "manifest",
      "manifestDigest",
      "goldDigest",
      "mediaBindingsDigest",
      "executionIdentityDigest",
      "plan",
      "batches",
      "provenanceDigest"
    ],
    "formal blind provenance"
  );
  if (
    record.schemaVersion !== C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION ||
    record.kind !== "c137-formal-blind-provenance" ||
    record.releaseEligible !== false ||
    record.trustStatus !== "untrusted-self-consistent-provenance"
  ) {
    throw new Error("formal blind provenance schema/kind/release/trust 标记无效。");
  }
  assertDigest(record.manifestDigest, "formal blind manifestDigest");
  assertDigest(record.goldDigest, "formal blind goldDigest");
  assertDigest(record.mediaBindingsDigest, "formal blind mediaBindingsDigest");
  assertDigest(record.executionIdentityDigest, "formal blind executionIdentityDigest");
  assertDigest(record.provenanceDigest, "formal blind provenanceDigest");
  if (!isRecord(record.manifest)) throw new Error("formal blind manifest 必须是对象。");
  const plan = parsePlan(record.plan);
  assertArray(record.batches, "formal blind batches");
  if (record.batches.length === 0) throw new Error("formal blind batches 不能为空。");
  return {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance",
    releaseEligible: false,
    trustStatus: "untrusted-self-consistent-provenance",
    manifest: record.manifest as unknown as RealMediaBenchmarkManifest,
    manifestDigest: record.manifestDigest,
    goldDigest: record.goldDigest,
    mediaBindingsDigest: record.mediaBindingsDigest,
    executionIdentityDigest: record.executionIdentityDigest,
    plan,
    batches: record.batches.map((batch, index) => parseBatchEnvelope(batch, index)),
    provenanceDigest: record.provenanceDigest
  };
}

function parsePlan(value: unknown): C137FormalBlindMatrixPlanV2 {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "manifestDigest",
      "datasetVersion",
      "relationshipAxis",
      "visualEvidenceEnabled",
      "globalTopK",
      "scoreContract",
      "candidateUniverseDigest",
      "matrixCoverage",
      "batches",
      "planDigest"
    ],
    "formal blind plan"
  );
  if (
    record.schemaVersion !== C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION ||
    record.kind !== "c137-formal-blind-matrix-plan" ||
    record.scoreContract !== C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT ||
    record.matrixCoverage !== C137_FORMAL_BLIND_MATRIX_COVERAGE
  ) {
    throw new Error("formal blind plan schema/kind/scoreContract/matrixCoverage 无效。");
  }
  assertDigest(record.manifestDigest, "formal blind plan.manifestDigest");
  assertNonemptyString(record.datasetVersion, "formal blind plan.datasetVersion");
  assertRelationshipAxis(record.relationshipAxis);
  if (typeof record.visualEvidenceEnabled !== "boolean") {
    throw new Error("formal blind plan.visualEvidenceEnabled 必须是 boolean。");
  }
  assertGlobalTopK(record.globalTopK);
  assertDigest(record.candidateUniverseDigest, "formal blind plan.candidateUniverseDigest");
  assertDigest(record.planDigest, "formal blind plan.planDigest");
  assertArray(record.batches, "formal blind plan.batches");
  if (record.batches.length === 0) throw new Error("formal blind plan 至少需要一个 batch。");
  return {
    schemaVersion: C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION,
    kind: "c137-formal-blind-matrix-plan",
    manifestDigest: record.manifestDigest,
    datasetVersion: record.datasetVersion,
    relationshipAxis: record.relationshipAxis,
    visualEvidenceEnabled: record.visualEvidenceEnabled,
    globalTopK: record.globalTopK,
    scoreContract: C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
    candidateUniverseDigest: record.candidateUniverseDigest,
    matrixCoverage: C137_FORMAL_BLIND_MATRIX_COVERAGE,
    batches: record.batches.map((batch, index) => parsePlanBatch(batch, index)),
    planDigest: record.planDigest
  };
}

function parsePlanBatch(value: unknown, index: number): C137FormalBlindMatrixPlanBatchV2 {
  const label = `formal blind plan.batches[${index}]`;
  const record = requireExactRecord(
    value,
    ["batchId", "queryCaseIds", "candidateCaseIds", "projectionDigest"],
    label
  );
  assertIdentifier(record.batchId, `${label}.batchId`);
  assertDigest(record.projectionDigest, `${label}.projectionDigest`);
  return {
    batchId: record.batchId,
    queryCaseIds: parseIdentifierArray(record.queryCaseIds, `${label}.queryCaseIds`),
    candidateCaseIds: parseIdentifierArray(
      record.candidateCaseIds,
      `${label}.candidateCaseIds`
    ),
    projectionDigest: record.projectionDigest
  };
}

function parseBatchEnvelope(
  value: unknown,
  index: number
): C137FormalBlindProvenanceBatchEnvelopeV3 {
  const label = `formal blind batches[${index}]`;
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "batchId",
      "projection",
      "executionSuite",
      "nativeReceipt",
      "rawPrediction"
    ],
    label
  );
  if (
    record.schemaVersion !== C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION ||
    record.kind !== "c137-formal-blind-provenance-batch"
  ) {
    throw new Error(`${label} schema/kind 无效。`);
  }
  assertIdentifier(record.batchId, `${label}.batchId`);
  for (const field of [
    "projection",
    "executionSuite",
    "nativeReceipt",
    "rawPrediction"
  ] as const) {
    if (!isRecord(record[field])) throw new Error(`${label}.${field} 必须是对象。`);
  }
  return {
    schemaVersion: C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    kind: "c137-formal-blind-provenance-batch",
    batchId: record.batchId,
    projection: record.projection as C137BlindBatchExecutionProjection,
    executionSuite: record.executionSuite as RealMediaBlindBatchExecutionSuite,
    nativeReceipt: record.nativeReceipt as RealMediaBlindBatchRunReceipt,
    rawPrediction: record.rawPrediction as C137BlindBatchRawPrediction
  };
}

function validateFormalManifest(manifest: RealMediaBenchmarkManifest): void {
  const validation = validateRealMediaBenchmarkManifest(manifest);
  if (!validation.valid) {
    throw new Error(`formal blind manifest 无效：${validation.issues.join("；")}`);
  }
  if (
    manifest.cases.length === 0 ||
    manifest.cases.some(
      (benchmarkCase) =>
        benchmarkCase.mediaKind !== "real" || benchmarkCase.split !== "frozen-test"
    )
  ) {
    throw new Error("formal blind provenance 只接受非空、全 real frozen-test manifest。");
  }
}

function validateUniquePhysicalRelationships(manifest: RealMediaBenchmarkManifest): void {
  const relationships = new Map<string, string>();
  for (const benchmarkCase of manifest.cases) {
    const key = canonicalJson([
      fullFileIdentityKey(benchmarkCase.source, `${benchmarkCase.id}.source`),
      fullFileIdentityKey(benchmarkCase.target, `${benchmarkCase.id}.target`)
    ]);
    const previousCaseId = relationships.get(key);
    if (previousCaseId !== undefined) {
      throw new Error(
        `formal blind duplicate physical relationship：${previousCaseId}/${benchmarkCase.id}。`
      );
    }
    relationships.set(key, benchmarkCase.id);
  }
}

function validateConsistentPathIdentities(manifest: RealMediaBenchmarkManifest): void {
  const identitiesByPath = new Map<string, string>();
  for (const benchmarkCase of manifest.cases) {
    for (const side of ["source", "target"] as const) {
      const media = benchmarkCase[side];
      const pathKey = media.path.trim().split("/").join("\\").toLocaleLowerCase("en-US");
      const identityKey = fullFileIdentityKey(media, `${benchmarkCase.id}.${side}`);
      const previous = identitiesByPath.get(pathKey);
      if (previous !== undefined && previous !== identityKey) {
        throw new Error(
          "formal blind path identity conflict：同一规范化路径绑定了不同 full-file identity。"
        );
      }
      identitiesByPath.set(pathKey, identityKey);
    }
  }
}

function validateExpectations(expected: C137FormalBlindProvenanceExpectations): void {
  assertDigest(expected.manifestDigest, "formal blind expected.manifestDigest");
  assertNonemptyString(expected.datasetVersion, "formal blind expected.datasetVersion");
  assertDigest(expected.planDigest, "formal blind expected.planDigest");
  assertDigest(expected.parametersDigest, "formal blind expected.parametersDigest");
  assertGlobalTopK(expected.topK);
}

function formalMediaBinding(media: RealMediaBenchmarkMediaInput): unknown {
  return {
    path: media.path,
    audioStreamIndex: media.audioStreamIndex,
    videoStreamIndex: media.videoStreamIndex,
    contentIdentity: media.contentIdentity
  };
}

function fullFileIdentityKey(media: RealMediaBenchmarkMediaInput, label: string): string {
  if (media.contentIdentity === null) {
    throw new Error(`formal blind ${label} 缺少 full-file identity。`);
  }
  return canonicalJson([
    media.contentIdentity.algorithm.toLowerCase(),
    media.contentIdentity.sizeBytes,
    media.contentIdentity.digest.toLowerCase()
  ]);
}

function requireCase(
  cases: ReadonlyMap<string, RealMediaBenchmarkCase>,
  caseId: string
): RealMediaBenchmarkCase {
  const benchmarkCase = cases.get(caseId);
  if (benchmarkCase === undefined) throw new Error(`formal blind case 不存在：${caseId}。`);
  return benchmarkCase;
}

function matrixCellKey(queryCaseId: string, candidateOrdinal: number): string {
  return `${queryCaseId}\u0000${candidateOrdinal}`;
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const actualKeys = Object.keys(value).sort(compareAscii);
  const expected = [...expectedKeys].sort(compareAscii);
  if (!sameOrderedStrings(actualKeys, expected)) {
    throw new Error(`${label} 含未知或缺失字段；formal schema 使用 exact keys。`);
  }
  return value;
}

function parseIdentifierArray(value: unknown, label: string): string[] {
  assertArray(value, label);
  if (value.length === 0) throw new Error(`${label} 不能为空。`);
  const result = value.map((item, index) => {
    assertIdentifier(item, `${label}[${index}]`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} 不得重复。`);
  return result;
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} 必须是规范标识符。`);
  }
}

function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is C137Digest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} 必须是规范 sha256 digest。`);
  }
}

function assertRelationshipAxis(value: unknown): asserts value is "source" | "target" {
  if (value !== "source" && value !== "target") {
    throw new Error("formal blind relationshipAxis 无效。");
  }
}

function assertGlobalTopK(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 2 || (value as number) > 20) {
    throw new Error("formal blind globalTopK 必须是 2..20 的安全整数。");
  }
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareAscii(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function digest(domain: string, payload: string): C137Digest {
  return `sha256:${sha256Hex(JSON.stringify([domain, payload]))}`;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
