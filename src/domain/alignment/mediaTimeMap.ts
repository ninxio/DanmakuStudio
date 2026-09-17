import type {
  CompactMediaTimeMapEvidence,
  MediaContentIdentity,
  MediaTimeMap,
  MediaTimeMapQuality,
  MediaTimeMapState,
  MediaTimeMapVerificationRevocation,
  SignedManualMediaTimeMapVerificationRecord,
  SegmentTimingRule
} from "../project/types";
import {
  areMediaContentIdentitiesEqual,
  cloneMediaContentIdentity
} from "../project/mediaIdentity";
import type { Milliseconds } from "../shared/time";
import { sha256Hex } from "../shared/sha256";
import {
  readTimeMapManualTakeover,
  readTimeMapSpanReviewDecision
} from "./timeMapReviewDecision";
import {
  readTimeMapSpanPlaybackReview,
  summarizeTimeMapSpanPlaybackEvidence
} from "./timeMapPlaybackReviewEvidence";
import {
  isCompleteTimeMapSpanEvidence,
  migrateLegacyTimeMap,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  reconcileTimeMapQualityClaim,
  type CompleteTimeMapSpan,
  type TimeMapBoundaryEvidence,
  type TimeMapQualityInput,
  type TimeMapSpan
} from "./timeMap";

export const LEGACY_ALIGNMENT_ENGINE_VERSION = "legacy-v9";
export const LEGACY_ALIGNMENT_FEATURE_VERSION = "legacy-v9";

const TIME_MAP_CORE_DIGEST_PREFIX = "sha256";
const VERIFICATION_RECORD_REQUIRED_REASON =
  "缺少与当前时间图核心、revision 和媒体身份绑定的可信验证记录；已阻断“已验证”资格，必须重新校准或完成明确人工复核。";
const LEGACY_MANUAL_RECORD_REASON =
  "旧人工验证记录没有安装级签名，无法在保存重开后证明签发来源；必须重新完成人工复核。";
const PERSISTED_MANUAL_RECORD_UNCHECKED_REASON =
  "人工验证签名尚未通过本机安装级验证机构和撤销注册表复核；当前按未验证处理。";

/**
 * 自动校准策略必须随应用代码和 native 导出门禁同步发布。该策略不伪造金标准概率；
 * 它只接受指定引擎、独立留出锚点、三段覆盖、唯一内容和逐段边界均通过硬门的结果。
 */
export const TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT = {
  id: "alignment-v2.5-independent-holdout-policy",
  version: "1"
} as const;

const TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACTS: readonly {
  id: string;
  version: string;
}[] = [TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT];

const TRUSTED_AUTOMATIC_ENGINE_VERSION = "alignment-v2.5-rust";
const TRUSTED_AUTOMATIC_FEATURE_VERSION =
  "pcm-s16le-16k-pts-tiled-fine-content-window-sequence-reuse-frontier-v25";

interface RegisteredManualVerificationTrust {
  status: "active" | "revoked";
  requestDigest: string;
}

/**
 * 只缓存 native 验证机构已经验证过的值身份，而不是 JS 对象身份。这样 structuredClone、
 * undo/redo 和保存序列化不会丢失同一次运行中的信任；应用重启后仍必须重新查询 native
 * 撤销注册表，任意 JSON 不能自己注册。
 */
const registeredManualVerificationTrust = new Map<string, RegisteredManualVerificationTrust>();

export interface ManualMediaTimeMapVerificationInput {
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

export interface AutomaticMediaTimeMapVerificationEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface ManualMediaTimeMapVerificationRequest {
  payload: string;
  requestDigest: string;
  reviewEvidenceDigest: string;
}

export interface ManualMediaTimeMapVerificationSeal {
  verificationId: string;
  issuerKeyId: string;
  issuerSequence: number;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
  requestDigest: string;
}

export interface ManualMediaTimeMapVerificationAuthorityResult {
  verificationId: string;
  issuerKeyId: string;
  signature: string;
  requestDigest: string;
  status: "active" | "revoked" | "unknown" | "invalid";
  reason: string;
}

export interface ManualMediaTimeMapVerificationRevocationInput {
  reason: string;
  revokedBy: string;
  revokedAt: string;
}

export interface ManualMediaTimeMapVerificationRevocationRequest extends ManualMediaTimeMapVerificationRevocationInput {
  verificationId: string;
  issuerKeyId: string;
  signature: string;
  requestDigest: string;
}

export interface ManualMediaTimeMapVerificationRevocationSeal {
  verificationId: string;
  issuerKeyId: string;
  issuerSequence: number;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
}

export interface MediaTimeMapVerificationAssessment {
  trusted: boolean;
  reason: string | null;
}

export interface ManualMediaTimeMapVerificationEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface LegacyMediaTimeMapInput {
  id: string;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  expectedTargetEndMs: Milliseconds | null;
  timingRules: readonly SegmentTimingRule[];
  state: MediaTimeMapState;
  timestamp: string;
  coverage: number | null;
  anchorCount: number;
}

/**
 * 把旧引擎的“段首 + 累计 gap”封装成显式时间图。
 * 该函数只负责无损迁移，结果永远不会被标为 verified。
 */
export function createLegacyMediaTimeMap(input: LegacyMediaTimeMapInput): MediaTimeMap {
  const migration = migrateLegacyTimeMap({
    sourceStartMs: input.sourceStartMs,
    sourceEndMs: input.sourceEndMs,
    targetStartMs: input.targetStartMs,
    timingRules: input.timingRules
  });
  const migratedSpans = [...migration.spans];
  const migratedEnd = migratedSpans.at(-1);
  const expectedRangeMismatch =
    input.expectedTargetEndMs !== null &&
    (!migratedEnd || migratedEnd.targetEndMs !== input.expectedTargetEndMs);
  const blocked = migration.status === "blocked" || expectedRangeMismatch;
  const rawSpans: TimeMapSpan[] = blocked
    ? [
        {
          kind: "ambiguous",
          sourceStartMs: input.sourceStartMs,
          sourceEndMs: input.sourceEndMs,
          targetStartMs: input.targetStartMs,
          targetEndMs:
            input.expectedTargetEndMs ?? migratedEnd?.targetEndMs ?? input.targetStartMs
        }
      ]
    : migratedSpans;
  const spans = rawSpans.map((span, index) =>
    normalizeLegacyUnverifiedTimeMapSpanEvidence(span, {
      id: `${input.id}:span:${String(index + 1).padStart(4, "0")}`,
      blocked
    })
  );
  const finalSpan = spans.at(-1);
  const reasons = ["由旧阶跃规则迁移，未经真实媒体重新分析或精度验证。"];
  migration.issues.forEach((issue) => reasons.push(issue.message));
  if (expectedRangeMismatch) {
    reasons.push(
      "旧候选声明的目标范围与 timingRules 推导范围不一致，已阻断并标记为 ambiguous。"
    );
  }

  return {
    id: input.id,
    revision: 1,
    sourceMediaId: input.sourceMediaId,
    targetMediaId: input.targetMediaId,
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    sourceStartMs: input.sourceStartMs,
    sourceEndMs: input.sourceEndMs,
    targetStartMs: input.targetStartMs,
    targetEndMs: finalSpan?.targetEndMs ?? input.targetStartMs,
    spans,
    quality: {
      level: blocked ? "blocked" : "legacy-unverified",
      probability: null,
      metricSource: input.coverage === null ? "missing" : "estimated",
      coverage: input.coverage,
      uniqueContentCoverage: null,
      p50ResidualMs: null,
      p95ResidualMs: null,
      p99ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      alternativeMargin: null,
      anchorCount: input.anchorCount,
      anchorRegionCount: 0,
      heldOutAnchorCount: 0,
      reasons
    },
    evidence: {
      types: ["legacy"],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 0,
      top1Top2Margin: null,
      uniqueContentCoverage: null,
      repeatedContentOnly: false,
      selectedTrackReason: "旧规则迁移没有保存媒体轨道排序证据。",
      alternativeTrackScores: [],
      notes: reasons
    },
    verification: null,
    engineVersion: LEGACY_ALIGNMENT_ENGINE_VERSION,
    featureVersion: LEGACY_ALIGNMENT_FEATURE_VERSION,
    parametersHash: `${LEGACY_ALIGNMENT_ENGINE_VERSION}:${input.id}`,
    state: input.state,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    confirmedAt: input.state === "candidate" ? null : input.timestamp
  };
}

export function createCandidateTimeMapId(candidateId: string): string {
  return `${candidateId}:time-map:candidate`;
}

export function createConfirmedTimeMapId(candidateId: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError("时间图 revision 必须是正整数。");
  }
  return `${candidateId}:time-map:confirmed:${revision}`;
}

/**
 * 对正式映射核心生成稳定 SHA-256。固定顺序的数组编码避免对象键顺序影响结果；运行时
 * 信任诊断不参与，但用户/算法写入的 reasons、notes 和所有映射、指标、证据字段均绑定。
 */
export function computeMediaTimeMapCoreDigest(map: MediaTimeMap): string {
  return `${TIME_MAP_CORE_DIGEST_PREFIX}:${sha256Hex(
    createMediaTimeMapCoreCanonicalJson(map)
  )}`;
}

/**
 * 对两张时间图的映射语义生成稳定摘要。
 *
 * 该摘要只用于校验 proposal.timeMap → candidate map 的完整确定性派生。它忽略
 * map/revision/state/verification/时间戳等生命周期字段，以及仅用于数组寻址的 span id；
 * 其余媒体、流、内容身份、完整 spans、图级质量、证据和引擎 provenance 均参与摘要。
 * candidate → confirmed 的签发/撤销生命周期另用下方 immutable lineage 摘要。
 */
export function computeMediaTimeMapSemanticDigest(map: MediaTimeMap): string {
  return `${TIME_MAP_CORE_DIGEST_PREFIX}:${sha256Hex(
    createMediaTimeMapSemanticCanonicalJson(map)
  )}`;
}

export function areMediaTimeMapsSemanticallyEquivalent(
  left: MediaTimeMap,
  right: MediaTimeMap
): boolean {
  try {
    return computeMediaTimeMapSemanticDigest(left) === computeMediaTimeMapSemanticDigest(right);
  } catch {
    return false;
  }
}

/**
 * 候选图复制为确认图后不可变化的映射与 provenance。图级 quality/evidence/verification
 * 会在明确的人工签发、撤销和重开复核中变化，因此不属于 clone lineage；逐段映射及其
 * 独立质量/边界证据仍然被完整绑定。
 */
export function computeMediaTimeMapImmutableLineageDigest(map: MediaTimeMap): string {
  return `${TIME_MAP_CORE_DIGEST_PREFIX}:${sha256Hex(
    createMediaTimeMapImmutableLineageCanonicalJson(map)
  )}`;
}

export function areMediaTimeMapImmutableLineagesEquivalent(
  left: MediaTimeMap,
  right: MediaTimeMap
): boolean {
  try {
    return (
      computeMediaTimeMapImmutableLineageDigest(left) ===
      computeMediaTimeMapImmutableLineageDigest(right)
    );
  } catch {
    return false;
  }
}

/**
 * Returns the exact positional JSON signed by a MediaTimeMap core digest.
 * Native verified export consumes this same value so it can reconstruct spans without trusting
 * a second, independently assembled representation of the map.
 */
export function createMediaTimeMapCoreCanonicalJson(map: MediaTimeMap): string {
  if (!map.spans.every(isCompleteTimeMapSpanEvidence)) {
    throw new Error("时间图缺少完整逐段质量、边界或备选路径证据，不能生成 v2 核心摘要。");
  }
  return JSON.stringify([
    "media-time-map-core-v2",
    map.id,
    map.revision,
    map.sourceMediaId,
    map.targetMediaId,
    canonicalStreamIdentity(map.sourceStream),
    canonicalStreamIdentity(map.targetStream),
    canonicalContentIdentity(map.sourceIdentity),
    canonicalContentIdentity(map.targetIdentity),
    map.sourceStartMs,
    map.sourceEndMs,
    map.targetStartMs,
    map.targetEndMs,
    map.spans.map(canonicalCompleteSpan),
    canonicalQualityMetrics(map.quality),
    canonicalEvidence(map.evidence),
    map.engineVersion,
    map.featureVersion,
    map.parametersHash
  ]);
}

function createMediaTimeMapSemanticCanonicalJson(map: MediaTimeMap): string {
  if (!map.spans.every(isCompleteTimeMapSpanEvidence)) {
    throw new Error("时间图缺少完整逐段质量、边界或备选路径证据，不能生成语义摘要。");
  }
  return JSON.stringify([
    "media-time-map-semantic-v1",
    map.sourceMediaId,
    map.targetMediaId,
    canonicalStreamIdentity(map.sourceStream),
    canonicalStreamIdentity(map.targetStream),
    canonicalContentIdentity(map.sourceIdentity),
    canonicalContentIdentity(map.targetIdentity),
    map.sourceStartMs,
    map.sourceEndMs,
    map.targetStartMs,
    map.targetEndMs,
    map.spans.map((span) => canonicalCompleteSpan(span).slice(1)),
    canonicalQualityMetrics(map.quality),
    canonicalEvidence(map.evidence),
    map.engineVersion,
    map.featureVersion,
    map.parametersHash
  ]);
}

function createMediaTimeMapImmutableLineageCanonicalJson(map: MediaTimeMap): string {
  if (!map.spans.every(isCompleteTimeMapSpanEvidence)) {
    throw new Error("时间图缺少完整逐段质量、边界或备选路径证据，不能生成 lineage 摘要。");
  }
  return JSON.stringify([
    "media-time-map-immutable-lineage-v1",
    map.sourceMediaId,
    map.targetMediaId,
    canonicalStreamIdentity(map.sourceStream),
    canonicalStreamIdentity(map.targetStream),
    canonicalContentIdentity(map.sourceIdentity),
    canonicalContentIdentity(map.targetIdentity),
    map.sourceStartMs,
    map.sourceEndMs,
    map.targetStartMs,
    map.targetEndMs,
    map.spans.map((span) => canonicalCompleteSpan(span).slice(1)),
    map.engineVersion,
    map.featureVersion,
    map.parametersHash
  ]);
}

function canonicalCompleteSpan(span: CompleteTimeMapSpan): readonly unknown[] {
  return [
    span.id,
    span.kind,
    span.sourceStartMs,
    span.sourceEndMs,
    span.targetStartMs,
    span.targetEndMs,
    span.reason,
    [
      span.quality.level,
      span.quality.metricSource,
      span.quality.probability,
      span.quality.coverage,
      span.quality.uniqueContentCoverage,
      span.quality.alternativeMargin,
      span.quality.anchorCount,
      span.quality.heldOutAnchorCount,
      span.quality.p50ResidualMs,
      span.quality.p95ResidualMs,
      span.quality.p99ResidualMs,
      span.quality.maxResidualMs,
      span.quality.boundaryUncertaintyMs,
      span.quality.leftSupport,
      span.quality.rightSupport,
      [
        span.quality.signals.audio,
        span.quality.signals.visual,
        span.quality.signals.danmaku
      ],
      canonicalSignedQualityReasons(span.quality.reasons)
    ],
    [canonicalBoundary(span.boundaries.start), canonicalBoundary(span.boundaries.end)],
    span.alternatives.map((alternative) => [
      alternative.kind,
      alternative.score,
      alternative.sourceStartMs,
      alternative.sourceEndMs,
      alternative.targetStartMs,
      alternative.targetEndMs,
      alternative.reason
    ])
  ];
}

function canonicalBoundary(boundary: TimeMapBoundaryEvidence): readonly unknown[] {
  return [
    boundary.status,
    boundary.axis,
    boundary.contextSide,
    boundary.coarseMs,
    boundary.refinedMs,
    boundary.uncertaintyStartMs,
    boundary.uncertaintyEndMs,
    boundary.supportDurationMs,
    boundary.correlation,
    boundary.alternativeMargin,
    boundary.reason
  ];
}

/** 检查 record 是否仍精确绑定当前 map，并且其签发来源受信。 */
export function assessMediaTimeMapVerification(
  map: MediaTimeMap
): MediaTimeMapVerificationAssessment {
  const record = map.verification;
  if (!record) {
    return { trusted: false, reason: VERIFICATION_RECORD_REQUIRED_REASON };
  }
  if (map.state !== "confirmed") {
    return {
      trusted: false,
      reason:
        "验证记录只能绑定 state=confirmed 的正式时间图，候选或已替代 revision 不能保持已验证资格。"
    };
  }
  if (record.mapRevision !== map.revision) {
    return {
      trusted: false,
      reason: "验证记录绑定的 revision 与当前时间图不一致，必须重新验证。"
    };
  }
  if (
    !map.sourceIdentity ||
    !map.targetIdentity ||
    !areMediaContentIdentitiesEqual(record.sourceIdentity, map.sourceIdentity) ||
    !areMediaContentIdentitiesEqual(record.targetIdentity, map.targetIdentity)
  ) {
    return {
      trusted: false,
      reason: "验证记录绑定的源/目标媒体身份与当前时间图不一致，必须重新分析。"
    };
  }
  if (record.mapCoreDigest !== computeMediaTimeMapCoreDigest(map)) {
    return {
      trusted: false,
      reason: "验证记录的核心摘要与当前时间图范围、spans、指标或引擎 provenance 不一致。"
    };
  }
  if (record.method === "automatic-calibration") {
    const trustedArtifact = TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACTS.some(
      (artifact) =>
        artifact.id === record.calibrationArtifactId &&
        artifact.version === record.calibrationArtifactVersion
    );
    return trustedArtifact
      ? { trusted: true, reason: null }
      : {
          trusted: false,
          reason: "自动验证所声明的 calibration artifact/version 不在应用内置受信列表中。"
        };
  }
  if (record.recordVersion === 1) {
    return {
      trusted: false,
      reason: LEGACY_MANUAL_RECORD_REASON
    };
  }
  if (record.revocation) {
    return {
      trusted: false,
      reason: `人工验证已于 ${record.revocation.revokedAt} 由 ${record.revocation.revokedBy} 撤销：${record.revocation.reason}`
    };
  }
  let expectedRequest: ManualMediaTimeMapVerificationRequest;
  try {
    expectedRequest = createManualVerificationRequestWithoutEligibilityCheck(map, {
      calibrationArtifactId: record.calibrationArtifactId,
      calibrationArtifactVersion: record.calibrationArtifactVersion,
      verifier: record.verifier,
      verifiedAt: record.verifiedAt
    });
  } catch {
    return {
      trusted: false,
      reason: "当前时间图已不满足签发门槛或人工差异分类要求，原验证失效。"
    };
  }
  if (
    record.requestDigest !== expectedRequest.requestDigest ||
    record.reviewEvidenceDigest !== expectedRequest.reviewEvidenceDigest
  ) {
    return {
      trusted: false,
      reason: "人工验证签名请求摘要与当前时间图、复核证据或签发元数据不一致。"
    };
  }
  const registered = registeredManualVerificationTrust.get(
    createManualVerificationTrustKey(record)
  );
  if (!registered) {
    return { trusted: false, reason: PERSISTED_MANUAL_RECORD_UNCHECKED_REASON };
  }
  if (registered.requestDigest !== record.requestDigest) {
    return {
      trusted: false,
      reason: "本机验证机构返回的签发请求摘要与项目记录不一致。"
    };
  }
  if (registered.status === "revoked") {
    return {
      trusted: false,
      reason: "本机撤销注册表已将该人工验证标记为 revoked；项目文件不能自行恢复它。"
    };
  }
  return { trusted: true, reason: null };
}

/**
 * 评估内置 V2.5 独立留出策略。这里故意不用模型自报 confidence，也不会填造 probability；
 * 任一身份、provenance、图级留出或逐段边界证据不足都会 fail-closed。
 */
export function assessTrustedAutomaticMediaTimeMapVerificationEligibility(
  map: MediaTimeMap
): AutomaticMediaTimeMapVerificationEligibility {
  const reject = (reason: string): AutomaticMediaTimeMapVerificationEligibility => ({
    eligible: false,
    reason
  });
  if (map.state !== "confirmed") {
    return reject("自动验证只接受 state=confirmed 的正式时间图。");
  }
  if (map.engineVersion !== TRUSTED_AUTOMATIC_ENGINE_VERSION) {
    return reject("时间图不是当前受信的 Alignment V2.5 引擎产物。");
  }
  if (map.featureVersion !== TRUSTED_AUTOMATIC_FEATURE_VERSION) {
    return reject("时间图的特征/时间轴版本不在当前自动验证策略内。");
  }
  if (!map.sourceIdentity || !map.targetIdentity) {
    return reject("自动验证缺少源文件或目标文件的内容身份快照。");
  }
  if (map.sourceStream?.type !== "audio" || map.targetStream?.type !== "audio") {
    return reject("自动验证缺少两端完整的已选择音轨身份。");
  }
  if (map.evidence.types.includes("legacy") || map.evidence.types.includes("manual")) {
    return reject("自动验证不能复用 legacy 或人工接管证据。");
  }
  if (!map.evidence.types.includes("audio") || map.evidence.audioAnchorCount < 12) {
    return reject("自动验证至少需要 12 个音频锚点。");
  }
  if (map.evidence.repeatedContentOnly === true) {
    return reject("重复内容不能取得自动验证资格。");
  }
  const quality = map.quality;
  if (quality.level !== "review" && quality.level !== "verified") {
    return reject("时间图当前质量不是可升级的 review/verified 状态。");
  }
  if (quality.metricSource !== "measured") {
    return reject("自动验证只接受完整实测指标。");
  }
  if (quality.probability !== null && quality.probability < 0.995) {
    return reject("已有金标准校准概率低于 99.5%。");
  }
  if (quality.coverage === null || quality.coverage < 0.9) {
    return reject("最终图来源覆盖率低于 90%。");
  }
  if (
    quality.uniqueContentCoverage === null ||
    quality.uniqueContentCoverage === undefined ||
    quality.uniqueContentCoverage < 0.8 ||
    map.evidence.uniqueContentCoverage !== quality.uniqueContentCoverage
  ) {
    return reject("独特内容覆盖率低于 80% 或图级证据不一致。");
  }
  if (
    quality.p50ResidualMs === null ||
    quality.p95ResidualMs === null ||
    quality.p95ResidualMs > 100 ||
    quality.p99ResidualMs === null ||
    quality.p99ResidualMs === undefined ||
    quality.p99ResidualMs > 250 ||
    quality.maxResidualMs === null ||
    quality.maxResidualMs > 500
  ) {
    return reject("独立留出重投影残差超过 100/250/500 ms 硬门或指标缺失。");
  }
  if (quality.boundaryUncertaintyMs === null || quality.boundaryUncertaintyMs > 250) {
    return reject("边界不确定性超过 250 ms 或指标缺失。");
  }
  if (quality.alternativeMargin === null || quality.alternativeMargin < 0.35) {
    return reject("最佳路径相对备选路径的 margin 低于 0.35。");
  }
  if (
    quality.anchorCount < 12 ||
    (quality.anchorRegionCount ?? 0) < 3 ||
    quality.heldOutAnchorCount < 6 ||
    map.evidence.heldOutAnchorCount !== quality.heldOutAnchorCount
  ) {
    return reject("锚点、三段覆盖或独立留出锚点数量未达到自动验证硬门。");
  }
  if (map.spans.length === 0) {
    return reject("时间图没有可投影片段。");
  }
  for (const [spanIndex, span] of map.spans.entries()) {
    if (!isCompleteTimeMapSpanEvidence(span)) {
      return reject(`时间图第 ${spanIndex + 1} 段缺少完整逐段证据。`);
    }
    if (span.kind === "ambiguous") {
      return reject(`时间图第 ${spanIndex + 1} 段仍为 ambiguous。`);
    }
    if (span.quality.level === "blocked" || span.quality.level === "legacy-unverified") {
      return reject(`时间图第 ${spanIndex + 1} 段仍为阻断或旧版状态。`);
    }
    if (span.quality.signals.audio !== "used") {
      return reject(`时间图第 ${spanIndex + 1} 段没有可用音频证据。`);
    }
    for (const boundary of [span.boundaries.start, span.boundaries.end]) {
      if (
        boundary.status === "ambiguous" ||
        boundary.status === "unsupported" ||
        boundary.status === "legacyUnverified"
      ) {
        return reject(`时间图第 ${spanIndex + 1} 段仍有未唯一定位的边界。`);
      }
    }
    if (
      span.kind !== "matched" &&
      (span.boundaries.start.status !== "refined" ||
        span.boundaries.end.status !== "refined")
    ) {
      return reject(`时间图第 ${spanIndex + 1} 个单侧差异缺少双边精修证据。`);
    }
    if (
      span.kind === "matched" &&
      (span.quality.metricSource !== "measured" ||
        span.quality.coverage === null ||
        span.quality.coverage < 0.7 ||
        span.quality.p95ResidualMs === null ||
        span.quality.p95ResidualMs > 250)
    ) {
      return reject(`时间图第 ${spanIndex + 1} 个 matched 片段的实测覆盖或残差不足。`);
    }
  }
  return { eligible: true, reason: null };
}

export function applyTrustedAutomaticMediaTimeMapVerification(
  map: MediaTimeMap,
  verifiedAt = new Date().toISOString()
): MediaTimeMap {
  if (!isIsoTimestamp(verifiedAt)) {
    throw new Error("自动验证字段 verifiedAt 必须是规范 ISO 时间戳。");
  }
  const eligibility = assessTrustedAutomaticMediaTimeMapVerificationEligibility(map);
  if (!eligibility.eligible) {
    throw new Error(eligibility.reason ?? "时间图不满足自动验证硬门。");
  }
  if (map.verification && assessMediaTimeMapVerification(map).trusted) {
    return map;
  }
  if (map.verification) {
    throw new Error("时间图已有不受信或不同方法的验证记录，必须先重新分析。");
  }
  const sourceIdentity = map.sourceIdentity;
  const targetIdentity = map.targetIdentity;
  if (!sourceIdentity || !targetIdentity) {
    throw new Error("自动验证缺少两端媒体身份。");
  }
  const declaredVerified: MediaTimeMap = {
    ...map,
    quality: {
      ...map.quality,
      level: "verified",
      reasons: canonicalSignedQualityReasons([
        ...map.quality.reasons,
        "内置 V2.5 独立留出策略已验证三段覆盖、唯一内容、残差和逐段边界；未伪造金标准概率。"
      ])
    },
    verification: null
  };
  const record = {
    recordVersion: 1 as const,
    method: "automatic-calibration" as const,
    mapCoreDigest: computeMediaTimeMapCoreDigest(declaredVerified),
    mapRevision: declaredVerified.revision,
    sourceIdentity: cloneRequiredIdentity(sourceIdentity),
    targetIdentity: cloneRequiredIdentity(targetIdentity),
    calibrationArtifactId: TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT.id,
    calibrationArtifactVersion: TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT.version,
    verifier: "Danmaku Timeline Studio native+domain policy",
    verifiedAt
  };
  return reconcileMediaTimeMapQuality({ ...declaredVerified, verification: record });
}

/**
 * 在调用 native 安装级签发机构前创建唯一的规范化请求。自动分析结果不得调用此函数；
 * 调用方必须来自明确人工动作，并先持久化 A/B 复核产物。
 */
export function createManualMediaTimeMapVerificationRequest(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput
): ManualMediaTimeMapVerificationRequest {
  assertManualVerificationEligible(map, input);
  return createManualVerificationRequestWithoutEligibilityCheck(map, input);
}

export function assessManualMediaTimeMapVerificationEligibility(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput
): ManualMediaTimeMapVerificationEligibility {
  try {
    assertManualVerificationEligible(map, input);
    return { eligible: true, reason: null };
  } catch (error) {
    return {
      eligible: false,
      reason: error instanceof Error ? error.message : "人工验证签发预检失败。"
    };
  }
}

/**
 * 应用 native 签发结果。该函数只接受已回显当前 requestDigest 的 seal；生产调用必须由
 * manualVerificationAuthority bridge 取得 seal，不能从项目 JSON 读取后直接调用。
 */
export function applyAuthorityIssuedManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput,
  seal: ManualMediaTimeMapVerificationSeal
): MediaTimeMap {
  const request = createManualMediaTimeMapVerificationRequest(map, input);
  assertManualVerificationSeal(seal, request.requestDigest);
  const sourceIdentity = map.sourceIdentity;
  const targetIdentity = map.targetIdentity;
  if (!sourceIdentity || !targetIdentity) {
    throw new Error("人工验证前必须记录源文件与目标文件的内容身份。");
  }
  const declaredVerified = createDeclaredVerifiedMap(map);
  const record: SignedManualMediaTimeMapVerificationRecord = {
    recordVersion: 2,
    method: "manual-review",
    verificationId: seal.verificationId,
    issuerKeyId: seal.issuerKeyId,
    issuerSequence: seal.issuerSequence,
    signatureAlgorithm: seal.signatureAlgorithm,
    signature: seal.signature,
    requestDigest: request.requestDigest,
    mapCoreDigest: computeMediaTimeMapCoreDigest(declaredVerified),
    mapRevision: declaredVerified.revision,
    sourceIdentity: cloneRequiredIdentity(sourceIdentity),
    targetIdentity: cloneRequiredIdentity(targetIdentity),
    calibrationArtifactId: input.calibrationArtifactId,
    calibrationArtifactVersion: input.calibrationArtifactVersion,
    reviewEvidenceDigest: request.reviewEvidenceDigest,
    verifier: input.verifier,
    verifiedAt: input.verifiedAt,
    revocation: null
  };
  registerManualMediaTimeMapVerificationAuthorityResult({
    verificationId: seal.verificationId,
    issuerKeyId: seal.issuerKeyId,
    signature: seal.signature,
    requestDigest: seal.requestDigest,
    status: "active",
    reason: "刚刚由本机验证机构签发。"
  });
  return reconcileMediaTimeMapQuality({ ...declaredVerified, verification: record });
}

/** 将 native 复核结果注册到当前运行；unknown/invalid 始终不会取得信任。 */
export function registerManualMediaTimeMapVerificationAuthorityResult(
  result: ManualMediaTimeMapVerificationAuthorityResult
): void {
  assertNonEmptyAuthorityField("verificationId", result.verificationId);
  assertNonEmptyAuthorityField("issuerKeyId", result.issuerKeyId);
  assertSha256Digest("requestDigest", result.requestDigest);
  assertHexDigest("signature", result.signature, 64);
  const key = createManualVerificationTrustKey(result);
  if (result.status === "active" || result.status === "revoked") {
    registeredManualVerificationTrust.set(key, {
      status: result.status,
      requestDigest: result.requestDigest
    });
  } else {
    registeredManualVerificationTrust.delete(key);
  }
}

/** 测试和新项目切换时清空运行时缓存；不会影响 native 安装级注册表。 */
export function clearRegisteredManualMediaTimeMapVerificationTrust(): void {
  registeredManualVerificationTrust.clear();
}

export function createManualMediaTimeMapVerificationRevocationRequest(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationRevocationInput
): ManualMediaTimeMapVerificationRevocationRequest {
  const record = requireSignedManualVerificationRecord(map);
  if (record.revocation) {
    throw new Error("该人工验证已经撤销，不能重复撤销。");
  }
  validateRevocationInput(input);
  return {
    verificationId: record.verificationId,
    issuerKeyId: record.issuerKeyId,
    signature: record.signature,
    requestDigest: record.requestDigest,
    ...input
  };
}

/** 应用 native 已原子登记的撤销回执；项目内回执只用于审计，信任以 native 注册表为准。 */
export function applyAuthorityRevokedManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationRevocationInput,
  seal: ManualMediaTimeMapVerificationRevocationSeal
): MediaTimeMap {
  const record = requireSignedManualVerificationRecord(map);
  validateRevocationInput(input);
  if (
    seal.verificationId !== record.verificationId ||
    seal.issuerKeyId !== record.issuerKeyId
  ) {
    throw new Error("撤销回执没有绑定当前人工验证凭据。");
  }
  assertPositiveSafeInteger("issuerSequence", seal.issuerSequence);
  if (seal.issuerSequence <= record.issuerSequence) {
    throw new Error("撤销回执序号必须晚于原签发事件。");
  }
  if (seal.signatureAlgorithm !== "hmac-sha256-v1") {
    throw new Error("撤销回执使用了不受支持的签名算法。");
  }
  assertHexDigest("signature", seal.signature, 64);
  const revocation: MediaTimeMapVerificationRevocation = {
    recordVersion: 1,
    verificationId: record.verificationId,
    issuerKeyId: record.issuerKeyId,
    issuerSequence: seal.issuerSequence,
    signatureAlgorithm: seal.signatureAlgorithm,
    signature: seal.signature,
    ...input
  };
  registerManualMediaTimeMapVerificationAuthorityResult({
    verificationId: record.verificationId,
    issuerKeyId: record.issuerKeyId,
    signature: record.signature,
    requestDigest: record.requestDigest,
    status: "revoked",
    reason: input.reason
  });
  return reconcileMediaTimeMapQuality({
    ...map,
    verification: { ...record, revocation },
    quality: { ...map.quality, level: "verified" }
  });
}

function assertManualVerificationEligible(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput
): void {
  if (map.state !== "confirmed") {
    throw new Error("只能人工验证 state=confirmed 的正式时间图。");
  }
  const sourceIdentity = map.sourceIdentity;
  const targetIdentity = map.targetIdentity;
  if (!sourceIdentity || !targetIdentity) {
    throw new Error("人工验证前必须记录源文件与目标文件的内容身份。");
  }
  if (!map.evidence.types.includes("manual")) {
    throw new Error("人工验证前必须先写入真实 manual 复核证据。");
  }
  const manualTakeoverAt = readTimeMapManualTakeover(map);
  for (const [label, value] of [
    ["calibrationArtifactId", input.calibrationArtifactId],
    ["calibrationArtifactVersion", input.calibrationArtifactVersion],
    ["verifier", input.verifier],
    ["verifiedAt", input.verifiedAt]
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`人工验证字段 ${label} 不能为空。`);
    }
  }
  if (!isIsoTimestamp(input.verifiedAt)) {
    throw new Error("人工验证字段 verifiedAt 必须是规范 ISO 时间戳。");
  }
  map.spans.forEach((span, spanIndex) => {
    if (!isCompleteTimeMapSpanEvidence(span)) {
      throw new Error(`时间图第 ${spanIndex + 1} 段缺少完整逐段证据，不能签发人工验证。`);
    }
    if (span.quality.level === "blocked" || span.quality.level === "legacy-unverified") {
      throw new Error(
        `时间图第 ${spanIndex + 1} 段仍为${span.quality.level === "blocked" ? "已阻断" : "旧版未验证"}状态，不能签发人工验证。`
      );
    }
    if (span.kind === "matched") {
      if (!manualTakeoverAt && !readTimeMapSpanPlaybackReview(map, spanIndex)) {
        throw new Error(
          `时间图第 ${spanIndex + 1} 段缺少与当前边界一致的真实 A/B 播放复核证据。`
        );
      }
      return;
    }
    const review = readTimeMapSpanReviewDecision(map, spanIndex);
    const expectedDecision =
      span.kind === "sourceOnly"
        ? "source-extra"
        : span.kind === "targetOnly"
          ? "target-extra"
          : "replacement";
    if (review?.decision !== expectedDecision) {
      throw new Error(
        `时间图第 ${spanIndex + 1} 段必须先人工分类为“${expectedDecision}”，不能凭自动结果签发。`
      );
    }
    if (!manualTakeoverAt && !readTimeMapSpanPlaybackReview(map, spanIndex)) {
      throw new Error(
        `时间图第 ${spanIndex + 1} 段缺少与当前边界一致的真实 A/B 播放复核证据。`
      );
    }
  });
  createDeclaredVerifiedMap(map);
}

function createDeclaredVerifiedMap(map: MediaTimeMap): MediaTimeMap {
  const verificationReason = readTimeMapManualTakeover(map)
    ? "用户已明确采用系统建议、接受未验证区间可能造成的弹幕错位，并由安装级验证机构签发人工接管方案。"
    : "全部片段已完成与当前媒体身份和边界绑定的 A/B 播放复核，并由安装级验证机构签发人工验证。";
  const reasons = canonicalSignedQualityReasons([
    ...map.quality.reasons,
    verificationReason
  ]);
  return {
    ...map,
    quality: { ...map.quality, level: "verified", reasons },
    verification: null
  };
}

function createManualVerificationRequestWithoutEligibilityCheck(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput
): ManualMediaTimeMapVerificationRequest {
  const normalizedMap = createDeclaredVerifiedMap(map);
  const reviewEvidenceDigest = computeManualReviewEvidenceDigest(normalizedMap, input);
  const payload = JSON.stringify([
    "manual-time-map-verification-request-v1",
    "manual-review",
    normalizedMap.id,
    normalizedMap.revision,
    computeMediaTimeMapCoreDigest(normalizedMap),
    canonicalContentIdentity(normalizedMap.sourceIdentity),
    canonicalContentIdentity(normalizedMap.targetIdentity),
    input.calibrationArtifactId,
    input.calibrationArtifactVersion,
    reviewEvidenceDigest,
    input.verifier,
    input.verifiedAt
  ]);
  return {
    payload,
    requestDigest: `sha256:${sha256Hex(payload)}`,
    reviewEvidenceDigest
  };
}

function assertManualVerificationSeal(
  seal: ManualMediaTimeMapVerificationSeal,
  expectedRequestDigest: string
): void {
  assertNonEmptyAuthorityField("verificationId", seal.verificationId);
  assertNonEmptyAuthorityField("issuerKeyId", seal.issuerKeyId);
  assertPositiveSafeInteger("issuerSequence", seal.issuerSequence);
  if (seal.signatureAlgorithm !== "hmac-sha256-v1") {
    throw new Error("人工验证签发结果使用了不受支持的签名算法。");
  }
  assertHexDigest("signature", seal.signature, 64);
  if (seal.requestDigest !== expectedRequestDigest) {
    throw new Error("人工验证签发结果没有回显当前规范化请求摘要。");
  }
}

function requireSignedManualVerificationRecord(
  map: MediaTimeMap
): SignedManualMediaTimeMapVerificationRecord {
  const record = map.verification;
  if (!record || record.recordVersion !== 2 || record.method !== "manual-review") {
    throw new Error("当前时间图没有可撤销的签名人工验证凭据。");
  }
  return record;
}

function validateRevocationInput(input: ManualMediaTimeMapVerificationRevocationInput): void {
  for (const [label, value] of [
    ["reason", input.reason],
    ["revokedBy", input.revokedBy],
    ["revokedAt", input.revokedAt]
  ] as const) {
    assertNonEmptyAuthorityField(label, value);
  }
}

function createManualVerificationTrustKey(
  value: Pick<
    SignedManualMediaTimeMapVerificationRecord,
    "verificationId" | "issuerKeyId" | "signature"
  >
): string {
  return `${value.issuerKeyId}\u0000${value.verificationId}\u0000${value.signature}`;
}

function assertNonEmptyAuthorityField(label: string, value: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new Error(`人工验证字段 ${label} 必须是 1 到 512 个字符。`);
  }
}

function assertSha256Digest(label: string, value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`人工验证字段 ${label} 必须是规范 SHA-256 摘要。`);
  }
}

function assertHexDigest(label: string, value: string, length: number): void {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`人工验证字段 ${label} 必须是 ${length} 位小写十六进制。`);
  }
}

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`人工验证字段 ${label} 必须是正整数。`);
  }
}

/** 对持久化或外部输入的质量声明执行中央重算，且绝不自动提高声明等级。 */
export function reconcileMediaTimeMapQuality(map: MediaTimeMap): MediaTimeMap {
  const hasIncompleteSpan = map.spans.some((span) => !isCompleteTimeMapSpanEvidence(span));
  const completeSpans = map.spans.filter(isCompleteTimeMapSpanEvidence);
  const hasBlockedSpan = completeSpans.some((span) => span.quality.level === "blocked");
  const hasLegacySpan = completeSpans.some(
    (span) => span.quality.level === "legacy-unverified"
  );
  const missingIdentity = map.sourceIdentity === null || map.targetIdentity === null;
  const inconsistentUniqueCoverage =
    (map.quality.uniqueContentCoverage ?? null) !==
    (map.evidence.uniqueContentCoverage ?? null);
  const hasAutomaticVerification = map.verification?.method === "automatic-calibration";
  const automaticVerificationAssessment = hasAutomaticVerification
    ? assessMediaTimeMapVerification(map)
    : null;
  const automaticEligibility = hasAutomaticVerification
    ? assessTrustedAutomaticMediaTimeMapVerificationEligibility(map)
    : null;
  if (
    hasAutomaticVerification &&
    !hasIncompleteSpan &&
    !hasBlockedSpan &&
    !hasLegacySpan &&
    !missingIdentity &&
    !inconsistentUniqueCoverage &&
    map.quality.level === "verified" &&
    automaticVerificationAssessment?.trusted === true &&
    automaticEligibility?.eligible === true
  ) {
    return {
      ...map,
      quality: {
        ...map.quality,
        level: "verified",
        reasons: canonicalSignedQualityReasons(map.quality.reasons)
      }
    };
  }
  if (hasAutomaticVerification) {
    return {
      ...map,
      quality: {
        ...map.quality,
        level:
          hasIncompleteSpan || hasBlockedSpan || missingIdentity || inconsistentUniqueCoverage
            ? "blocked"
            : "review",
        reasons: uniqueReasons([
          ...canonicalSignedQualityReasons(map.quality.reasons),
          ...(automaticVerificationAssessment?.reason
            ? [automaticVerificationAssessment.reason]
            : []),
          ...(automaticEligibility?.reason ? [automaticEligibility.reason] : [])
        ])
      }
    };
  }
  const hasSignedManualVerification =
    map.verification?.recordVersion === 2 &&
    map.verification.method === "manual-review";
  const manualVerificationAssessment = hasSignedManualVerification
    ? assessMediaTimeMapVerification(map)
    : null;
  const trustedManualVerification =
    !hasIncompleteSpan &&
    !hasBlockedSpan &&
    !hasLegacySpan &&
    !missingIdentity &&
    !inconsistentUniqueCoverage &&
    map.quality.level === "verified" &&
    manualVerificationAssessment?.trusted === true;
  if (trustedManualVerification) {
    return {
      ...map,
      quality: {
        ...map.quality,
        level: "verified",
        reasons: canonicalSignedQualityReasons(map.quality.reasons)
      }
    };
  }
  if (hasSignedManualVerification) {
    const blocked =
      hasIncompleteSpan ||
      hasBlockedSpan ||
      missingIdentity ||
      inconsistentUniqueCoverage;
    const legacy = !blocked && hasLegacySpan;
    return {
      ...map,
      verification: legacy ? null : map.verification,
      quality: {
        ...map.quality,
        level: blocked ? "blocked" : legacy ? "legacy-unverified" : "review",
        reasons: uniqueReasons([
          ...canonicalSignedQualityReasons(map.quality.reasons),
          ...(manualVerificationAssessment?.reason
            ? [manualVerificationAssessment.reason]
            : []),
          ...(hasIncompleteSpan ? ["至少一个片段缺少完整逐段证据，已阻断整张时间图。"] : []),
          ...(hasBlockedSpan ? ["至少一个片段的逐段质量为 blocked，已阻断整张时间图。"] : []),
          ...(missingIdentity
            ? ["时间图缺少源文件或目标文件的内容身份快照，不能确认它仍对应当前媒体文件。"]
            : []),
          ...(inconsistentUniqueCoverage
            ? ["图级质量与轨道证据的独特内容覆盖率不一致，已阻断该时间图。"]
            : []),
          ...(legacy ? ["至少一个片段只有旧版未验证证据，整张时间图必须重新分析或复核。"] : [])
        ])
      }
    };
  }
  const reconciliation = reconcileTimeMapQualityClaim(
    map.quality.level,
    map.quality.reasons,
    toTimeMapQualityInput(map)
  );
  let level =
    reconciliation.level === "verified" && missingIdentity ? "blocked" : reconciliation.level;
  const reasons = [...reconciliation.reasons];
  const hasReviewSpan = completeSpans.some((span) => span.quality.level === "review");
  if (hasIncompleteSpan || hasBlockedSpan) {
    level = "blocked";
    reasons.push(
      hasIncompleteSpan
        ? "至少一个片段缺少完整逐段证据，已阻断整张时间图。"
        : "至少一个片段的逐段质量为 blocked，已阻断整张时间图。"
    );
  } else if (hasLegacySpan && level !== "blocked") {
    level = "legacy-unverified";
    reasons.push("至少一个片段只有旧版未验证证据，整张时间图必须重新分析或复核。");
  } else if (hasReviewSpan && level === "verified" && !trustedManualVerification) {
    level = "review";
    reasons.push("至少一个片段仍需复核，自动图级指标不能绕过逐段质量门禁。");
  }
  if (level === "blocked" && reconciliation.level === "verified" && missingIdentity) {
    reasons.push("时间图缺少源文件或目标文件的内容身份快照，不能确认它仍对应当前媒体文件。");
  }
  if (inconsistentUniqueCoverage) {
    level = "blocked";
    reasons.push("图级质量与轨道证据的独特内容覆盖率不一致，已阻断该时间图。");
  }
  if (map.quality.level === "verified") {
    const verification = assessMediaTimeMapVerification(map);
    if (!verification.trusted && level === "verified") {
      level = "review";
    }
    if (!verification.trusted && verification.reason) {
      reasons.push(verification.reason);
    }
  }
  return {
    ...map,
    verification: level === "legacy-unverified" ? null : (map.verification ?? null),
    quality: {
      ...map.quality,
      level,
      reasons: uniqueReasons(reasons)
    }
  };
}

export function confirmCandidateTimeMap(
  candidateMap: MediaTimeMap,
  id: string,
  revision: number,
  timestamp: string
): MediaTimeMap {
  if (candidateMap.state !== "candidate") {
    throw new Error("只能从候选时间图创建确认 revision。");
  }
  return {
    ...structuredClone(candidateMap),
    id,
    revision,
    verification: null,
    state: "confirmed",
    createdAt: timestamp,
    updatedAt: timestamp,
    confirmedAt: timestamp
  };
}

function toTimeMapQualityInput(map: MediaTimeMap): TimeMapQualityInput {
  return {
    probability: map.quality.probability,
    metricSource: map.quality.metricSource,
    coverage: map.quality.coverage,
    uniqueContentCoverage: map.quality.uniqueContentCoverage,
    p50ResidualMs: map.quality.p50ResidualMs,
    p95ResidualMs: map.quality.p95ResidualMs,
    p99ResidualMs: map.quality.p99ResidualMs,
    maxResidualMs: map.quality.maxResidualMs,
    boundaryUncertaintyMs: map.quality.boundaryUncertaintyMs,
    alternativeMargin: map.quality.alternativeMargin,
    anchorCount: map.quality.anchorCount,
    anchorRegionCount: map.quality.anchorRegionCount,
    heldOutAnchorCount: map.quality.heldOutAnchorCount,
    evidenceTypes: map.evidence.types,
    audioAnchorCount: map.evidence.audioAnchorCount,
    visualAnchorCount: map.evidence.visualAnchorCount,
    evidenceHeldOutAnchorCount: map.evidence.heldOutAnchorCount,
    sourceStreamType: map.sourceStream?.type ?? null,
    targetStreamType: map.targetStream?.type ?? null
  };
}

function canonicalStreamIdentity(
  stream: MediaTimeMap["sourceStream"]
): readonly unknown[] | null {
  return stream
    ? [
        stream.type,
        stream.index,
        stream.codec,
        stream.startMs,
        stream.timelineOffsetMs,
        stream.timeBase,
        stream.sampleRate,
        stream.channels,
        stream.frameRate,
        stream.language,
        stream.title
      ]
    : null;
}

function canonicalContentIdentity(
  identity: MediaContentIdentity | null
): readonly unknown[] | null {
  return identity
    ? [
        identity.algorithm,
        identity.sizeBytes,
        identity.modifiedUnixMs,
        identity.firstSampleDigest,
        identity.middleSampleDigest,
        identity.lastSampleDigest
      ]
    : null;
}

function canonicalQualityMetrics(quality: MediaTimeMapQuality): readonly unknown[] {
  return [
    quality.probability,
    quality.metricSource,
    quality.coverage,
    quality.uniqueContentCoverage ?? null,
    quality.p50ResidualMs,
    quality.p95ResidualMs,
    quality.p99ResidualMs ?? null,
    quality.maxResidualMs,
    quality.boundaryUncertaintyMs,
    quality.alternativeMargin,
    quality.anchorCount,
    quality.anchorRegionCount ?? 0,
    quality.heldOutAnchorCount,
    canonicalSignedQualityReasons(quality.reasons)
  ];
}

function canonicalEvidence(evidence: CompactMediaTimeMapEvidence): readonly unknown[] {
  return [
    [...evidence.types].sort(),
    evidence.audioAnchorCount,
    evidence.visualAnchorCount,
    evidence.heldOutAnchorCount,
    evidence.top1Top2Margin ?? null,
    evidence.uniqueContentCoverage ?? null,
    evidence.repeatedContentOnly ?? false,
    evidence.selectedTrackReason ?? "",
    (evidence.alternativeTrackScores ?? []).map((alternative) => [
      alternative.sourceStreamIndex,
      alternative.targetStreamIndex,
      alternative.score,
      alternative.scale ?? null,
      alternative.offsetMs ?? null,
      alternative.inlierCount ?? null
    ]),
    [...new Set(evidence.notes.map((note) => note.trim()).filter(Boolean))].sort()
  ];
}

function computeManualReviewEvidenceDigest(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput
): string {
  const decisions = map.spans.flatMap((span, spanIndex) => {
    if (span.kind === "matched") {
      return [];
    }
    const review = readTimeMapSpanReviewDecision(map, spanIndex);
    return [
      [
        spanIndex,
        span.kind,
        span.sourceStartMs,
        span.sourceEndMs,
        span.targetStartMs,
        span.targetEndMs,
        review?.decision ?? null,
        review?.reviewedAt ?? null
      ]
    ];
  });
  const playbackReviews = map.spans.map((_, spanIndex) => {
    const review = readTimeMapSpanPlaybackReview(map, spanIndex);
    return [
      spanIndex,
      review?.spanDigest ?? null,
      review?.policyVersion ?? null,
      review ? summarizeTimeMapSpanPlaybackEvidence(review) : null,
      review?.reviewedAt ?? null
    ];
  });
  const canonical = JSON.stringify([
    "manual-time-map-review-evidence-v3",
    map.id,
    map.revision,
    input.verifier,
    input.verifiedAt,
    decisions,
    playbackReviews
  ]);
  return `sha256:${sha256Hex(canonical)}`;
}

function canonicalSignedQualityReasons(reasons: readonly string[]): string[] {
  return [
    ...new Set(
      reasons
        .map((reason) => reason.trim())
        .filter((reason) => reason.length > 0 && !isRuntimeVerificationReason(reason))
    )
  ].sort();
}

function isRuntimeVerificationReason(reason: string): boolean {
  return (
    reason === VERIFICATION_RECORD_REQUIRED_REASON ||
    reason === LEGACY_MANUAL_RECORD_REASON ||
    reason === PERSISTED_MANUAL_RECORD_UNCHECKED_REASON ||
    reason.startsWith("验证记录只能绑定") ||
    reason.startsWith("验证记录绑定的 revision") ||
    reason.startsWith("验证记录绑定的源/目标媒体身份") ||
    reason.startsWith("验证记录的核心摘要") ||
    reason.startsWith("自动验证所声明的 calibration artifact") ||
    reason.startsWith("人工验证已于 ") ||
    reason.startsWith("人工验证签名请求摘要") ||
    reason.startsWith("本机验证机构返回的签发请求摘要") ||
    reason.startsWith("本机撤销注册表") ||
    reason.startsWith("当前时间图已不满足签发门槛")
    || reason.startsWith("至少一个片段缺少完整逐段证据")
    || reason.startsWith("至少一个片段的逐段质量为 blocked")
    || reason.startsWith("至少一个片段只有旧版未验证证据")
    || reason.startsWith("至少一个片段仍需复核")
  );
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cloneRequiredIdentity(identity: MediaContentIdentity): MediaContentIdentity {
  return cloneMediaContentIdentity(identity) as MediaContentIdentity;
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [
    ...new Set(reasons.map((reason) => reason.trim()).filter((reason) => reason.length > 0))
  ];
}

export function supersedeMediaTimeMap(map: MediaTimeMap, timestamp: string): MediaTimeMap {
  if (map.state === "superseded") {
    return map;
  }
  if (map.state !== "confirmed") {
    throw new Error("只有已确认时间图可以被替代。");
  }
  return {
    ...map,
    state: "superseded",
    updatedAt: timestamp
  };
}
