import type { CutMarker, DanmakuAsset, DanmakuClip, SyncAnchor } from "../danmaku/types";
import type { AlignmentProposal } from "../alignment/types";
import type { TimeMapSpan } from "../alignment/timeMap";
import type { Milliseconds } from "../shared/time";
import type { AudioTrackIntent } from "./audioTrackPreparation";
import type { FamilyArrangement } from "./mediaFamilyTypes";
import type { DiscoveryItem, LibraryProfile } from "./discovery";

export const CURRENT_SCHEMA_VERSION = 18;

export interface MediaReference {
  id: string;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
}

export type ProjectMediaRole = "targetOriginal" | "bilibiliReference";
export type ProjectMediaReferenceKind = "browserFile" | "localPath" | "embyItem";
export type ProjectMediaConnectionState = "connected" | "needsReconnect" | "metadataOnly";

/**
 * Stable local-file snapshot used to invalidate a time map when the bytes behind a path change.
 * The digest is deliberately algorithm-versioned; equality always includes every field.
 */
export interface MediaContentIdentity {
  algorithm: string;
  sizeBytes: number;
  modifiedUnixMs: number;
  firstSampleDigest: string;
  middleSampleDigest: string;
  lastSampleDigest: string;
}

export interface ProjectMediaEmbyReference {
  itemId: string;
  itemName: string;
  itemType: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  server: EmbyServerReference;
  mediaSources: EmbyMediaSourceSummary[];
}

export interface ProjectMediaReference {
  id: string;
  role: ProjectMediaRole;
  name: string;
  fileName: string;
  objectUrl: string | null;
  durationMs: Milliseconds | null;
  contentIdentity: MediaContentIdentity | null;
  referenceKind: ProjectMediaReferenceKind;
  connectionState: ProjectMediaConnectionState;
  sourceSummary: string;
  localPath: string | null;
  emby: ProjectMediaEmbyReference | null;
  episodeKey: string | null;
  episodeLabel: string | null;
  audioTrackIntent: AudioTrackIntent;
  createdAt: string;
  updatedAt: string;
}

export interface EmbyServerReference {
  serverUrl: string;
  pathPrefix: string;
  username: string;
}

export interface EmbyMediaSourceSummary {
  id: string | null;
  name: string | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  sizeBytes: number | null;
  runtimeMs: Milliseconds | null;
}

interface MediaBindingBase {
  id: string;
  displayName: string;
  runtimeMs: Milliseconds | null;
  linkedAt: string;
}

export interface LocalFileMediaBinding extends MediaBindingBase {
  kind: "localFile";
  fileName: string;
  mediaId: string | null;
  localPath: string | null;
}

export interface EmbyItemMediaBinding extends MediaBindingBase {
  kind: "embyItem";
  itemId: string;
  itemName: string;
  itemType: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  server: EmbyServerReference;
  mediaSources: EmbyMediaSourceSummary[];
}

export type MediaBinding = LocalFileMediaBinding | EmbyItemMediaBinding;

export interface SeasonEpisodeBinding {
  id: string;
  episodeKey: string;
  episodeLabel: string;
  targetBinding: MediaBinding;
  linkedAt: string;
}

export type DanmakuSourceSegmentKind = "content" | "ignored";

export interface DanmakuSourceBinding {
  id: string;
  assetId: string;
  sourceMediaId: string;
  linkedAt: string;
  updatedAt: string;
}

/**
 * 段内时间修正规则：参考时间轴（B 站/XML 时间）到达 sourceAtMs 之后，
 * 目标原片相对参考版累计多出 gapMs 内容（参考版在此处被删减）。
 * 投影时对该点之后的弹幕整体加上 gapMs。
 */
export interface SegmentTimingRule {
  id: string;
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
  note: string;
}

export type MediaTimeMapState = "candidate" | "confirmed" | "superseded";
export type MediaTimeMapQualityLevel = "verified" | "review" | "blocked" | "legacy-unverified";
export type MediaTimeMapMetricSource = "measured" | "estimated" | "missing";
export type MediaTimeMapEvidenceType = "audio" | "visual" | "manual" | "danmaku" | "legacy";

/**
 * 已选择媒体流的紧凑身份。整个字段可为 null（旧项目或尚未探测），
 * 但一旦存在，所有身份字段都必须完整出现，不能用部分对象冒充已探测流。
 */
export interface MediaTimeMapStreamIdentity {
  type: "audio" | "video";
  index: number;
  codec: string | null;
  startMs: Milliseconds | null;
  timelineOffsetMs: Milliseconds | null;
  timeBase: string | null;
  sampleRate: number | null;
  channels: number | null;
  frameRate: number | null;
  language: string | null;
  title: string | null;
}

export interface MediaTimeMapQuality {
  level: MediaTimeMapQualityLevel;
  /** 经真实金标准校准后的概率；尚未校准时必须为 null。 */
  probability: number | null;
  metricSource: MediaTimeMapMetricSource;
  coverage: number | null;
  uniqueContentCoverage?: number | null;
  p50ResidualMs: Milliseconds | null;
  p95ResidualMs: Milliseconds | null;
  /** v12 项目必填；旧内存夹具省略时按缺失处理。 */
  p99ResidualMs?: Milliseconds | null;
  maxResidualMs: Milliseconds | null;
  boundaryUncertaintyMs: Milliseconds | null;
  alternativeMargin: number | null;
  anchorCount: number;
  /** v12 项目必填；覆盖开头、中段、结尾时为 3。 */
  anchorRegionCount?: number;
  heldOutAnchorCount: number;
  reasons: string[];
}

export interface MediaTimeMapTrackAlternative {
  sourceStreamIndex: number;
  targetStreamIndex: number;
  score: number;
  scale?: number;
  offsetMs?: number;
  inlierCount?: number;
}

export interface CompactMediaTimeMapEvidence {
  types: MediaTimeMapEvidenceType[];
  audioAnchorCount: number;
  visualAnchorCount: number;
  heldOutAnchorCount: number;
  top1Top2Margin?: number | null;
  uniqueContentCoverage?: number | null;
  repeatedContentOnly?: boolean;
  selectedTrackReason?: string;
  alternativeTrackScores?: MediaTimeMapTrackAlternative[];
  notes: string[];
}

export type MediaTimeMapVerificationMethod = "automatic-calibration" | "manual-review";

/**
 * 与时间图核心内容绑定的验证凭据。
 *
 * 该记录本身不是权限令牌：自动记录还必须命中应用内置的校准产物白名单；人工记录
 * 只有在本次运行中由明确的领域签发函数创建时才可信。这样不能靠导入任意 JSON
 * 把时间图提升为 verified。
 */
/**
 * C137 首个预览版记录。它没有持久化签名，只能作为旧审计信息保留，不能在保存重开后
 * 恢复人工信任。
 */
export interface LegacyMediaTimeMapVerificationRecord {
  recordVersion: 1;
  method: MediaTimeMapVerificationMethod;
  mapCoreDigest: string;
  mapRevision: number;
  sourceIdentity: MediaContentIdentity;
  targetIdentity: MediaContentIdentity;
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

export interface MediaTimeMapVerificationRevocation {
  recordVersion: 1;
  verificationId: string;
  issuerKeyId: string;
  issuerSequence: number;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
  reason: string;
  revokedBy: string;
  revokedAt: string;
}

/**
 * 由桌面端安装级验证机构签发的人工复核凭据。签名密钥和撤销注册表均不进入项目 JSON；
 * 因此仅修改项目文件不能伪造或恢复一份已撤销凭据。换机或本机密钥丢失时必须
 * fail-closed，重新完成人工复核。
 */
export interface SignedManualMediaTimeMapVerificationRecord {
  recordVersion: 2;
  method: "manual-review";
  verificationId: string;
  issuerKeyId: string;
  issuerSequence: number;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
  requestDigest: string;
  mapCoreDigest: string;
  mapRevision: number;
  sourceIdentity: MediaContentIdentity;
  targetIdentity: MediaContentIdentity;
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  reviewEvidenceDigest: string;
  verifier: string;
  verifiedAt: string;
  revocation: MediaTimeMapVerificationRevocation | null;
}

export type MediaTimeMapVerificationRecord =
  LegacyMediaTimeMapVerificationRecord | SignedManualMediaTimeMapVerificationRecord;

/** 来源（B 站/XML 时间轴）到目标原片时间轴的正式分段映射。 */
export interface MediaTimeMap {
  id: string;
  revision: number;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStream: MediaTimeMapStreamIdentity | null;
  targetStream: MediaTimeMapStreamIdentity | null;
  /** Identity snapshots measured in the same analysis run that produced this map. */
  sourceIdentity: MediaContentIdentity | null;
  targetIdentity: MediaContentIdentity | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  spans: TimeMapSpan[];
  quality: MediaTimeMapQuality;
  evidence: CompactMediaTimeMapEvidence;
  /** v12 验证凭据；null 表示尚无可信校准/人工复核闭环。 */
  verification: MediaTimeMapVerificationRecord | null;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  state: MediaTimeMapState;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export type MediaMatchCandidateState = "pending" | "accepted" | "rejected" | "blocked";

/**
 * 媒体级匹配候选。候选只描述参考素材与目标原片之间的时间关系；
 * 用户接受后，才会按 XML 来源绑定展开为非破坏性的 DanmakuSourceSegment。
 */
export interface MediaMatchCandidate {
  id: string;
  batchId: string;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  timingRules: SegmentTimingRule[];
  confidence: number;
  proposal: AlignmentProposal;
  /** 始终指向 state=candidate 的候选时间图。 */
  timeMapId: string;
  /** 接受后指向独立的 state=confirmed 时间图；不能与 timeMapId 相同。 */
  confirmedTimeMapId: string | null;
  state: MediaMatchCandidateState;
  appliedSegmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DanmakuSourceSegment {
  id: string;
  label: string;
  kind: DanmakuSourceSegmentKind;
  assetId: string | null;
  sourceMediaId: string | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetMediaId: string | null;
  /** 该段开头对应目标原片时间轴上的时间；null 表示 0（段首对齐原片开头）。 */
  targetStartMs: Milliseconds | null;
  /** 段内删减修正规则，sourceAtMs 使用参考时间轴。 */
  timingRules: SegmentTimingRule[];
  /** v10 已确认分段时间图；旧兼容或 ignored 段可为 null。 */
  timeMapId: string | null;
  episodeKey: string | null;
  episodeLabel: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineViewState {
  pixelsPerSecond: number;
  scrollMs: Milliseconds;
  playheadMs: Milliseconds;
}

export interface PreviewSettings {
  danmakuVisible: boolean;
  safeAreaVisible: boolean;
  opacity: number;
}

/**
 * 人工复核不是天然真值。rough / playbackChecked 都属于单人弱标签；只有独立裁决后
 * 才能升级为 adjudicatedGold。该分级会随项目保存，训练导出器据此决定是否允许进入
 * 监督训练，避免把一次粗略点击直接教给模型。
 */
export type AlignmentReviewPrecision =
  "rough" | "playbackChecked" | "frameAccurate" | "adjudicatedGold";

export type AlignmentReviewDecision =
  "source-extra" | "target-extra" | "replacement" | "unresolved";

export type AlignmentReviewAction = "classifySpan" | "resolveOneSidedGap";
export type AlignmentReviewRecordState = "active" | "superseded";

export type AlignmentReviewVoteRole = "independent" | "adjudicator";
export type AlignmentReviewVoteState = "active" | "superseded";
export type AlignmentReviewDurationBasis = "first-form-interaction-to-submit-v1";

/**
 * 对已冻结算法证据的独立复核票。reviewerIdDigest 只保存不可逆摘要；同一 reviewer
 * 的再次提交会 supersede 旧票，不能伪装成第二名复核者。只有两名不同 reviewer
 * 一致，或两名冲突后由第三名 adjudicator 裁决，才允许导出 Gold。
 */
export interface AlignmentReviewVote {
  voteVersion: 1;
  id: string;
  reviewRecordId: string;
  reviewerIdDigest: string;
  reviewSessionId: string;
  role: AlignmentReviewVoteRole;
  decision: AlignmentReviewDecision;
  boundaryToleranceMs: Milliseconds | null;
  supersedesVoteId: string | null;
  voteState: AlignmentReviewVoteState;
  reviewedAt: string;
  /** Optional v1-compatible telemetry; absent on projects saved before measurement existed. */
  reviewStartedAt?: string | null;
  reviewDurationMs?: Milliseconds | null;
  reviewDurationBasis?: AlignmentReviewDurationBasis | null;
  /** Exact shadow-risk context visible when this vote was submitted; never grants label authority. */
  shadowRiskSourceRunId?: string | null;
  shadowRiskEvidenceDigest?: string | null;
  shadowRiskAtReview?: number | null;
}

export interface AlignmentReviewFeatureSnapshot {
  sourceCoverage: number | null;
  uniqueContentCoverage: number | null;
  anchorCount: number | null;
  heldOutAnchorCount: number | null;
  anchorRegionCount: number | null;
  p95ResidualMs: number | null;
  p99ResidualMs: number | null;
  maxResidualMs: number | null;
  boundaryUncertaintyMs: number | null;
  alternativeMargin: number | null;
  ambiguousRatio: number | null;
  bidirectionalAgreement: number | null;
  differenceRiskP50: number | null;
  differenceRiskP90: number | null;
  differenceRiskP99: number | null;
  informativenessP50: number | null;
  visualRecoveredRatio: number | null;
  visualAmbiguousRatio: number | null;
  visualMarginP50: number | null;
}

/**
 * 在人工改写 TimeMap 之前冻结的训练证据。记录不包含标题、路径、音频或画面；
 * supersedesRecordId/recordState 让用户反悔时保留历史而不是静默覆盖。
 */
export interface AlignmentReviewRecord {
  recordVersion: 1;
  id: string;
  timeMapId: string;
  timeMapRevision: number;
  spanId: string;
  spanIndex: number;
  sourceMediaId: string;
  targetMediaId: string;
  mediaGroupId: string;
  action: AlignmentReviewAction;
  decision: AlignmentReviewDecision;
  precision: AlignmentReviewPrecision;
  algorithmPrediction: TimeMapSpan["kind"];
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  boundaryToleranceMs: Milliseconds | null;
  features: AlignmentReviewFeatureSnapshot;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  supersedesRecordId: string | null;
  recordState: AlignmentReviewRecordState;
  reviewedAt: string;
}

export interface AlignmentPersonalGoldRecordSnapshot {
  recordVersion: 1;
  reviewRecordId: string;
  recordEvidenceDigest: string;
  timeMapId: string;
  timeMapRevision: number;
  spanId: string;
  spanIndex: number;
  sourceMediaId: string;
  targetMediaId: string;
  action: AlignmentReviewAction;
  decision: AlignmentReviewDecision;
  precision: AlignmentReviewPrecision;
  algorithmPrediction: TimeMapSpan["kind"];
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetStartMs: Milliseconds;
  targetEndMs: Milliseconds;
  boundaryToleranceMs: Milliseconds | null;
  features: AlignmentReviewFeatureSnapshot;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  reviewedAt: string;
}

export interface AlignmentPersonalGoldVoteSnapshot {
  voteId: string;
  reviewerIdDigest: string;
  role: AlignmentReviewVoteRole;
  decision: AlignmentReviewDecision;
  boundaryToleranceMs: Milliseconds | null;
  reviewedAt: string;
  shadowRiskSourceRunId: string | null;
  shadowRiskEvidenceDigest: string | null;
  shadowRiskAtReview: number | null;
}

/**
 * 用户显式冻结的 Personal Gold 收据。它只保存既有人工裁决与算法证据快照，
 * 不拥有新的复核状态，也不授予 TimeMap 或导出权限。
 */
export interface AlignmentPersonalGoldCase {
  caseVersion: 1;
  id: string;
  sourceReviewRecordId: string;
  caseContentDigest: string;
  voteSetDigest: string;
  resolution: "independentAgreement" | "adjudicator";
  decision: AlignmentReviewDecision;
  boundaryToleranceMs: Milliseconds | null;
  recordSnapshot: AlignmentPersonalGoldRecordSnapshot;
  voteSnapshots: AlignmentPersonalGoldVoteSnapshot[];
  frozenAt: string;
}

export type AlignmentShadowRiskReasonCode =
  | "weak-local-audio-support"
  | "global-audio-disagreement"
  | "missing-local-audio-support"
  | "audio-shadow-risk";

export interface AlignmentShadowRiskOverlayEntry {
  recordId: string;
  recordEvidenceDigest: string;
  risk: number;
  reasonCodes: AlignmentShadowRiskReasonCode[];
}

/**
 * 可选的离线影子风险覆盖层。它只影响独立复核队列排序；项目摘要、记录证据摘要和
 * overlayId 防止跨项目或记录修改后的结果被静默复用。
 */
export interface AlignmentShadowRiskOverlay {
  schemaVersion: "alignment-shadow-risk-overlay-v1";
  projectIdDigest: string;
  featureRecipeVersion: "rule-audio-local-support-risk-v1";
  sourceRunId: string;
  generatedAt: string;
  permission: "shadow-review-ranking-only";
  entries: AlignmentShadowRiskOverlayEntry[];
  overlayId: string;
}

export interface EditorProject {
  discoveryItems?: DiscoveryItem[];
  libraryProfile?: LibraryProfile;
  /** Optional schema-18 extension; user organization, never alignment proof. */
  familyArrangement?: FamilyArrangement;
  schemaVersion: number;
  id: string;
  name: string;
  media: MediaReference | null;
  mediaLibrary: ProjectMediaReference[];
  mediaBinding: MediaBinding | null;
  seasonEpisodeBindings: SeasonEpisodeBinding[];
  danmakuSourceBindings: DanmakuSourceBinding[];
  danmakuSourceSegments: DanmakuSourceSegment[];
  mediaMatchCandidates: MediaMatchCandidate[];
  mediaTimeMaps: MediaTimeMap[];
  alignmentReviewRecords: AlignmentReviewRecord[];
  alignmentReviewVotes: AlignmentReviewVote[];
  alignmentPersonalGoldCases: AlignmentPersonalGoldCase[];
  alignmentShadowRiskOverlay: AlignmentShadowRiskOverlay | null;
  assets: DanmakuAsset[];
  clips: DanmakuClip[];
  globalOffsetMs: Milliseconds;
  cutMarkers: CutMarker[];
  syncAnchors: SyncAnchor[];
  alignmentProposal: AlignmentProposal | null;
  itemTimeAdjustments: Record<string, Milliseconds>;
  disabledItemIds: string[];
  timeline: TimelineViewState;
  preview: PreviewSettings;
  createdAt: string;
  updatedAt: string;
}

export type SelectionKind = "none" | "danmaku" | "clip" | "cut" | "anchor";

export interface EditorSelection {
  kind: SelectionKind;
  ids: string[];
}

export interface ProjectValidationResult {
  ok: boolean;
  version: number | null;
  message: string;
}
