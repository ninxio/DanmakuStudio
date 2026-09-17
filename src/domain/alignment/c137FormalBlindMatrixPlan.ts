import type { C137Digest } from "./c137Acceptance";
import {
  C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION,
  computeC137BlindBatchProjectionDigest,
  createC137BlindBatchMediaBindingCommitment,
  orderC137BlindBatchMediaInputs,
  type C137BlindBatchExecutionProjection,
  type C137BlindBatchMediaProjection,
  type C137BlindBatchRelationshipAxis
} from "./c137BlindBatchEvidence";
import {
  validateRealMediaBenchmarkManifest,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput
} from "./realMediaBenchmark";
import { REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION } from "./realMediaBlindBatchContract";
import { sha256Hex } from "../shared/sha256";

export const C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION = 2 as const;
export const C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT =
  REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION;
export const C137_FORMAL_BLIND_MATRIX_COVERAGE = "exhaustive" as const;

const MAXIMUM_MEDIA_PER_SIDE = 256;
const MAXIMUM_PAIR_COUNT = 256;
const MINIMUM_GLOBAL_TOP_K = 2;
const MAXIMUM_GLOBAL_TOP_K = 20;
const CANDIDATE_UNIVERSE_DIGEST_DOMAIN = "c137-formal-blind-candidate-universe-v2";
const PLAN_DIGEST_DOMAIN = "c137-formal-blind-matrix-plan-v2";
const SUITE_ID_DOMAIN = "c137-formal-blind-matrix-suite-v2";
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface C137FormalBlindMatrixPlanBatchV2 {
  batchId: string;
  queryCaseIds: string[];
  candidateCaseIds: string[];
  projectionDigest: C137Digest;
}

export interface C137FormalBlindMatrixPlanV2 {
  schemaVersion: typeof C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION;
  kind: "c137-formal-blind-matrix-plan";
  manifestDigest: C137Digest;
  datasetVersion: string;
  relationshipAxis: C137BlindBatchRelationshipAxis;
  visualEvidenceEnabled: boolean;
  globalTopK: number;
  scoreContract: typeof C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
  candidateUniverseDigest: C137Digest;
  matrixCoverage: typeof C137_FORMAL_BLIND_MATRIX_COVERAGE;
  batches: C137FormalBlindMatrixPlanBatchV2[];
  planDigest: C137Digest;
}

export interface C137FormalBlindMatrixPlanOptions {
  relationshipAxis: C137BlindBatchRelationshipAxis;
  visualEvidenceEnabled: boolean;
  globalTopK: number;
  scoreContract?: typeof C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
}

export interface C137FormalBlindMatrixTile {
  queryStart: number;
  queryEnd: number;
  candidateStart: number;
  candidateEnd: number;
}

export interface C137FormalBlindMatrixQueryEntry {
  ordinal: number;
  caseId: string;
  physicalKey: string;
  bindingCommitment: C137Digest;
  benchmarkCase: RealMediaBenchmarkCase;
  media: RealMediaBenchmarkMediaInput;
}

export interface C137FormalBlindMatrixCandidateEntry {
  ordinal: number;
  representativeCaseId: string;
  physicalKey: string;
  effectiveStreamKey: string;
  bindingCommitment: C137Digest;
  benchmarkCase: RealMediaBenchmarkCase;
  media: RealMediaBenchmarkMediaInput;
}

export interface C137FormalBlindMatrixModel {
  querySide: "source" | "target";
  candidateSide: "source" | "target";
  queries: C137FormalBlindMatrixQueryEntry[];
  candidates: C137FormalBlindMatrixCandidateEntry[];
  candidateByPhysicalKey: ReadonlyMap<string, C137FormalBlindMatrixCandidateEntry>;
  caseById: ReadonlyMap<string, RealMediaBenchmarkCase>;
}

type C137FormalBlindMatrixPlanDraft = Omit<C137FormalBlindMatrixPlanV2, "planDigest">;

export function createC137FormalBlindMatrixModel(
  manifest: RealMediaBenchmarkManifest,
  relationshipAxis: C137BlindBatchRelationshipAxis,
  visualEvidenceEnabled: boolean
): C137FormalBlindMatrixModel {
  assertFormalManifest(manifest);
  assertRelationshipAxis(relationshipAxis);
  if (typeof visualEvidenceEnabled !== "boolean") {
    throw new Error("formal blind visualEvidenceEnabled 必须是 boolean。");
  }
  const querySide = relationshipAxis;
  const candidateSide = relationshipAxis === "source" ? "target" : "source";
  const caseById = new Map(
    manifest.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase])
  );
  const queryPhysicalOwners = new Map<string, string>();
  const queries = manifest.cases.map((benchmarkCase, index) => {
    const media = benchmarkCase[querySide];
    const physicalKey = fullFileIdentityKey(media, `${benchmarkCase.id}.${querySide}`);
    const previous = queryPhysicalOwners.get(physicalKey);
    if (previous !== undefined) {
      throw new Error(
        `formal blind ${querySide}-axis duplicate physical query identity：${previous}/${benchmarkCase.id}。`
      );
    }
    queryPhysicalOwners.set(physicalKey, benchmarkCase.id);
    return {
      ordinal: index,
      caseId: benchmarkCase.id,
      physicalKey,
      bindingCommitment: createC137BlindBatchMediaBindingCommitment(
        manifest.id,
        manifest.datasetVersion,
        querySide,
        visualEvidenceEnabled,
        media
      ),
      benchmarkCase,
      media
    };
  });

  const candidateByPhysicalKey = new Map<string, C137FormalBlindMatrixCandidateEntry>();
  const candidates: C137FormalBlindMatrixCandidateEntry[] = [];
  for (const benchmarkCase of manifest.cases) {
    const media = benchmarkCase[candidateSide];
    const physicalKey = fullFileIdentityKey(media, `${benchmarkCase.id}.${candidateSide}`);
    const effectiveStreamKey = createEffectiveStreamKey(media, visualEvidenceEnabled);
    const previous = candidateByPhysicalKey.get(physicalKey);
    if (previous !== undefined) {
      if (previous.effectiveStreamKey !== effectiveStreamKey) {
        throw new Error(
          `formal blind candidate physical file ${previous.representativeCaseId}/${benchmarkCase.id} 声明了不同有效流。`
        );
      }
      continue;
    }
    const candidate: C137FormalBlindMatrixCandidateEntry = {
      ordinal: candidates.length,
      representativeCaseId: benchmarkCase.id,
      physicalKey,
      effectiveStreamKey,
      bindingCommitment: createC137BlindBatchMediaBindingCommitment(
        manifest.id,
        manifest.datasetVersion,
        candidateSide,
        visualEvidenceEnabled,
        media
      ),
      benchmarkCase,
      media
    };
    candidates.push(candidate);
    candidateByPhysicalKey.set(physicalKey, candidate);
  }

  return {
    querySide,
    candidateSide,
    queries,
    candidates,
    candidateByPhysicalKey,
    caseById
  };
}

export function computeC137FormalBlindCandidateUniverseDigest(
  manifest: RealMediaBenchmarkManifest,
  relationshipAxis: C137BlindBatchRelationshipAxis,
  visualEvidenceEnabled: boolean
): C137Digest {
  const model = createC137FormalBlindMatrixModel(
    manifest,
    relationshipAxis,
    visualEvidenceEnabled
  );
  return digest(
    CANDIDATE_UNIVERSE_DIGEST_DOMAIN,
    canonicalJson({
      manifestId: manifest.id,
      datasetVersion: manifest.datasetVersion,
      relationshipAxis,
      visualEvidenceEnabled,
      candidates: model.candidates.map((candidate) => ({
        ordinal: candidate.ordinal,
        representativeCaseId: candidate.representativeCaseId,
        physicalKey: candidate.physicalKey,
        effectiveStreamKey: candidate.effectiveStreamKey,
        bindingCommitment: candidate.bindingCommitment
      }))
    })
  );
}

export function createC137FormalBlindMatrixTileLayout(
  queryCount: number,
  candidateCount: number,
  globalTopK: number
): C137FormalBlindMatrixTile[] {
  assertPositiveInteger(queryCount, "formal blind queryCount");
  assertPositiveInteger(candidateCount, "formal blind candidateCount");
  assertGlobalTopK(globalTopK);
  if (candidateCount <= globalTopK) {
    throw new Error("formal blind candidate universe 必须严格大于 globalTopK。");
  }

  const candidateShardCount = Math.ceil(candidateCount / MAXIMUM_MEDIA_PER_SIDE);
  const candidateRanges = createBalancedRanges(candidateCount, candidateShardCount);
  if (candidateRanges.some(([start, end]) => end - start <= globalTopK)) {
    throw new Error("formal blind candidate tile 必须各自严格大于 globalTopK。");
  }
  const maximumCandidateTileSize = Math.max(
    ...candidateRanges.map(([start, end]) => end - start)
  );
  const maximumQueriesPerTile = Math.min(
    MAXIMUM_MEDIA_PER_SIDE,
    Math.floor(MAXIMUM_PAIR_COUNT / maximumCandidateTileSize)
  );
  if (maximumQueriesPerTile < 1) {
    throw new Error("formal blind matrix 无法形成受限 query tile。");
  }
  const queryRanges = createContiguousRanges(queryCount, maximumQueriesPerTile);
  return queryRanges.flatMap(([queryStart, queryEnd]) =>
    candidateRanges.map(([candidateStart, candidateEnd]) => ({
      queryStart,
      queryEnd,
      candidateStart,
      candidateEnd
    }))
  );
}

export function createC137FormalBlindMatrixPlan(
  manifest: RealMediaBenchmarkManifest,
  manifestDigest: C137Digest,
  options: C137FormalBlindMatrixPlanOptions
): C137FormalBlindMatrixPlanV2 {
  assertDigest(manifestDigest, "formal blind manifestDigest");
  assertRelationshipAxis(options.relationshipAxis);
  if (typeof options.visualEvidenceEnabled !== "boolean") {
    throw new Error("formal blind visualEvidenceEnabled 必须是 boolean。");
  }
  assertGlobalTopK(options.globalTopK);
  const scoreContract = options.scoreContract ?? C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
  if (scoreContract !== C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT) {
    throw new Error("formal blind scoreContract 不是受支持的 shard-invariant contract。");
  }
  const model = createC137FormalBlindMatrixModel(
    manifest,
    options.relationshipAxis,
    options.visualEvidenceEnabled
  );
  const layout = createC137FormalBlindMatrixTileLayout(
    model.queries.length,
    model.candidates.length,
    options.globalTopK
  );
  const batches = layout.map((tile, index) => {
    const queryCaseIds = model.queries
      .slice(tile.queryStart, tile.queryEnd)
      .map((query) => query.caseId);
    const candidateCaseIds = model.candidates
      .slice(tile.candidateStart, tile.candidateEnd)
      .map((candidate) => candidate.representativeCaseId);
    const projection = createC137FormalBlindMatrixExecutionProjection(manifest, {
      queryCaseIds,
      candidateCaseIds,
      relationshipAxis: options.relationshipAxis,
      visualEvidenceEnabled: options.visualEvidenceEnabled,
      globalTopK: options.globalTopK
    });
    return {
      batchId: `matrix-batch-${String(index + 1).padStart(4, "0")}-${projection.suiteId.slice(-8)}`,
      queryCaseIds,
      candidateCaseIds,
      projectionDigest: projection.projectionDigest
    };
  });
  const draft: C137FormalBlindMatrixPlanDraft = {
    schemaVersion: C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION,
    kind: "c137-formal-blind-matrix-plan",
    manifestDigest,
    datasetVersion: manifest.datasetVersion,
    relationshipAxis: options.relationshipAxis,
    visualEvidenceEnabled: options.visualEvidenceEnabled,
    globalTopK: options.globalTopK,
    scoreContract,
    candidateUniverseDigest: computeC137FormalBlindCandidateUniverseDigest(
      manifest,
      options.relationshipAxis,
      options.visualEvidenceEnabled
    ),
    matrixCoverage: C137_FORMAL_BLIND_MATRIX_COVERAGE,
    batches
  };
  return { ...draft, planDigest: computeC137FormalBlindMatrixPlanDigest(draft) };
}

export function computeC137FormalBlindMatrixPlanDigest(
  plan: C137FormalBlindMatrixPlanDraft | C137FormalBlindMatrixPlanV2
): C137Digest {
  return digest(
    PLAN_DIGEST_DOMAIN,
    canonicalJson({
      schemaVersion: plan.schemaVersion,
      kind: plan.kind,
      manifestDigest: plan.manifestDigest,
      datasetVersion: plan.datasetVersion,
      relationshipAxis: plan.relationshipAxis,
      visualEvidenceEnabled: plan.visualEvidenceEnabled,
      globalTopK: plan.globalTopK,
      scoreContract: plan.scoreContract,
      candidateUniverseDigest: plan.candidateUniverseDigest,
      matrixCoverage: plan.matrixCoverage,
      batches: plan.batches
    })
  );
}

export function createC137FormalBlindMatrixExecutionProjection(
  manifest: RealMediaBenchmarkManifest,
  options: {
    queryCaseIds: readonly string[];
    candidateCaseIds: readonly string[];
    relationshipAxis: C137BlindBatchRelationshipAxis;
    visualEvidenceEnabled: boolean;
    globalTopK: number;
  }
): C137BlindBatchExecutionProjection {
  assertRelationshipAxis(options.relationshipAxis);
  if (typeof options.visualEvidenceEnabled !== "boolean") {
    throw new Error("formal blind visualEvidenceEnabled 必须是 boolean。");
  }
  assertGlobalTopK(options.globalTopK);
  const model = createC137FormalBlindMatrixModel(
    manifest,
    options.relationshipAxis,
    options.visualEvidenceEnabled
  );
  const queries = selectQueries(model, options.queryCaseIds);
  const candidates = selectCandidates(model, options.candidateCaseIds);
  if (candidates.length <= options.globalTopK) {
    throw new Error("formal blind matrix batch candidate 数必须严格大于 globalTopK。");
  }
  const sourceMedia =
    model.querySide === "source"
      ? queries.map((query) => query.media)
      : candidates.map((candidate) => candidate.media);
  const targetMedia =
    model.querySide === "target"
      ? queries.map((query) => query.media)
      : candidates.map((candidate) => candidate.media);
  const sources = createMediaProjection(
    manifest,
    "source",
    options.visualEvidenceEnabled,
    sourceMedia
  );
  const targets = createMediaProjection(
    manifest,
    "target",
    options.visualEvidenceEnabled,
    targetMedia
  );
  if (sources.length > MAXIMUM_MEDIA_PER_SIDE || targets.length > MAXIMUM_MEDIA_PER_SIDE) {
    throw new Error("formal blind matrix batch 每侧最多允许 256 个 distinct media。");
  }
  const pairCount = sources.length * targets.length;
  if (pairCount < 2 || pairCount > MAXIMUM_PAIR_COUNT) {
    throw new Error("formal blind matrix batch 必须包含 2..256 个 full-Cartesian pair。");
  }
  const pairs = sources.flatMap((source) =>
    targets.map((target) => ({
      pairId: `pair-${source.mediaId}-${target.mediaId}`,
      sourceMediaId: source.mediaId,
      targetMediaId: target.mediaId
    }))
  );
  const suiteId = `suite-${sha256Hex(
    JSON.stringify([
      SUITE_ID_DOMAIN,
      manifest.id,
      manifest.datasetVersion,
      options.relationshipAxis,
      options.visualEvidenceEnabled,
      options.globalTopK,
      [...options.queryCaseIds],
      [...options.candidateCaseIds],
      sources.map((media) => media.bindingCommitment),
      targets.map((media) => media.bindingCommitment)
    ])
  ).slice(0, 24)}`;
  const draft: Omit<C137BlindBatchExecutionProjection, "projectionDigest"> = {
    schemaVersion: C137_BLIND_BATCH_EVIDENCE_SCHEMA_VERSION,
    kind: "c137-blind-batch-execution-projection",
    suiteId,
    topK: options.globalTopK,
    relationshipAxis: options.relationshipAxis,
    visualEvidenceEnabled: options.visualEvidenceEnabled,
    sources,
    targets,
    pairs
  };
  return {
    ...draft,
    projectionDigest: computeC137BlindBatchProjectionDigest(draft)
  };
}

function selectQueries(
  model: C137FormalBlindMatrixModel,
  requestedIds: readonly string[]
): C137FormalBlindMatrixQueryEntry[] {
  assertOrderedUniqueIdentifiers(requestedIds, "formal blind queryCaseIds");
  const byId = new Map(model.queries.map((query) => [query.caseId, query]));
  const selected = requestedIds.map((caseId) => {
    const query = byId.get(caseId);
    if (query === undefined) throw new Error(`formal blind query case 不存在：${caseId}。`);
    return query;
  });
  const ordinals = selected.map((query) => query.ordinal);
  if (
    ordinals.some((ordinal, index) => {
      const previous = ordinals[index - 1];
      return previous !== undefined && ordinal <= previous;
    })
  ) {
    throw new Error("formal blind queryCaseIds 必须保持 manifest 顺序。");
  }
  return selected;
}

function selectCandidates(
  model: C137FormalBlindMatrixModel,
  requestedIds: readonly string[]
): C137FormalBlindMatrixCandidateEntry[] {
  assertOrderedUniqueIdentifiers(requestedIds, "formal blind candidateCaseIds");
  const byId = new Map(
    model.candidates.map((candidate) => [candidate.representativeCaseId, candidate])
  );
  const selected = requestedIds.map((caseId) => {
    const candidate = byId.get(caseId);
    if (candidate === undefined) {
      throw new Error(
        `formal blind candidateCaseIds 只能使用每个候选物理文件的首个 canonical representative：${caseId}。`
      );
    }
    return candidate;
  });
  const ordinals = selected.map((candidate) => candidate.ordinal);
  if (
    ordinals.some((ordinal, index) => {
      const previous = ordinals[index - 1];
      return previous !== undefined && ordinal <= previous;
    })
  ) {
    throw new Error("formal blind candidateCaseIds 必须保持 candidate universe 顺序。");
  }
  return selected;
}

function createMediaProjection(
  manifest: RealMediaBenchmarkManifest,
  side: "source" | "target",
  visualEvidenceEnabled: boolean,
  mediaInputs: readonly RealMediaBenchmarkMediaInput[]
): C137BlindBatchMediaProjection[] {
  const ordered = orderC137BlindBatchMediaInputs(
    manifest.id,
    manifest.datasetVersion,
    side,
    visualEvidenceEnabled,
    mediaInputs
  );
  return ordered.map((media, index) => ({
    mediaId: `${side}-${String(index + 1).padStart(4, "0")}`,
    bindingCommitment: createC137BlindBatchMediaBindingCommitment(
      manifest.id,
      manifest.datasetVersion,
      side,
      visualEvidenceEnabled,
      media
    ),
    audioStreamIndex: media.audioStreamIndex,
    videoStreamIndex: visualEvidenceEnabled ? media.videoStreamIndex : null
  }));
}

function createBalancedRanges(total: number, groupCount: number): [number, number][] {
  const base = Math.floor(total / groupCount);
  const remainder = total % groupCount;
  const ranges: [number, number][] = [];
  let start = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    ranges.push([start, start + size]);
    start += size;
  }
  return ranges;
}

function createContiguousRanges(total: number, maximumSize: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < total; start += maximumSize) {
    ranges.push([start, Math.min(total, start + maximumSize)]);
  }
  return ranges;
}

function assertFormalManifest(manifest: RealMediaBenchmarkManifest): void {
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
    throw new Error("formal blind matrix 只接受非空、全 real frozen-test manifest。");
  }
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

function createEffectiveStreamKey(
  media: RealMediaBenchmarkMediaInput,
  visualEvidenceEnabled: boolean
): string {
  return canonicalJson([
    media.audioStreamIndex,
    visualEvidenceEnabled ? media.videoStreamIndex : null
  ]);
}

function assertOrderedUniqueIdentifiers(values: readonly string[], label: string): void {
  if (values.length === 0) throw new Error(`${label} 不能为空。`);
  for (const value of values) {
    if (!IDENTIFIER.test(value)) throw new Error(`${label} 含无效标识符。`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} 不得重复。`);
}

function assertRelationshipAxis(
  value: unknown
): asserts value is C137BlindBatchRelationshipAxis {
  if (value !== "source" && value !== "target") {
    throw new Error("formal blind relationshipAxis 无效。");
  }
}

function assertGlobalTopK(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < MINIMUM_GLOBAL_TOP_K ||
    (value as number) > MAXIMUM_GLOBAL_TOP_K
  ) {
    throw new Error("formal blind globalTopK 必须是 2..20 的安全整数。");
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} 必须是正安全整数。`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is C137Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} 必须是规范 SHA-256 digest。`);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function digest(domain: string, payload: string): C137Digest {
  return `sha256:${sha256Hex(JSON.stringify([domain, payload]))}`;
}
