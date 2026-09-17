import type {
  RealMediaBenchmarkMediaKind,
  RealMediaBenchmarkScenario
} from "./realMediaBenchmark";
import {
  getC137PerformanceMeasuredRuns,
  getC137PerformancePeakRss,
  validateC137PerformanceEvidence,
  type C137PerformanceRawEvidenceV1,
  type C137PerformanceRawEvidenceV2
} from "./c137PerformanceEvidence";
import {
  C137_FORMAL_BLIND_CALIBRATION_FEATURE_CONTRACT,
  C137_FORMAL_BLIND_MATRIX_COVERAGE,
  C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION,
  C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
  C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
  computeC137FormalBlindGoldDigest,
  computeC137FormalBlindManifestDigest,
  computeC137FormalBlindMediaBindingsDigest,
  computeC137FormalBlindParametersDigest,
  evaluateC137FormalBlindProvenance,
  validateC137FormalBlindProvenance,
  type C137FormalBlindDerivedRelationshipDecisionV3,
  type C137FormalBlindProvenanceV3
} from "./c137FormalBlindProvenance";
import {
  REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
  REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION
} from "./realMediaBlindBatchContract";
import {
  c137RelationshipModalitiesEqualPairLocalEvidence,
  c137TimeMapCasesEqualPairLocalEvidence,
  deriveC137PairLocalFineEvidence
} from "./c137PairLocalFineEvidence";
import { sha256Hex } from "../shared/sha256";

export const C137_ACCEPTANCE_SCHEMA_VERSION = 6 as const;
export const C137_ACCEPTANCE_PROTOCOL_SCHEMA_VERSION = 8 as const;
export const C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const C137_ACCEPTANCE_REPORT_SCHEMA_VERSION = 1 as const;
export const C137_CALIBRATION_MODEL_SCHEMA_VERSION = 1 as const;
export const C137_CALIBRATION_REPORT_SCHEMA_VERSION = 2 as const;
export const C137_RELATIONSHIP_RANKING_REPORT_SCHEMA_VERSION = 3 as const;
export const C137_PERFORMANCE_ACCEPTANCE_REPORT_SCHEMA_VERSION = 3 as const;
export const C137_FORMAL_PERFORMANCE_RAW_SCHEMA_VERSION = 2 as const;
export const C137_BLIND_GLOBAL_AGGREGATION_CONTRACT =
  "global-recompute-from-all-matrix-cells-v1" as const;
export const C137_RELATIONSHIP_RANKING_SCOPE = "global-exhaustive-matrix" as const;
const C137_CALIBRATION_MODEL_DIGEST_DOMAIN = "c137-native-score-calibration-model-v1";

export const C137_FIXED_ACCEPTANCE_THRESHOLDS = {
  targetPhysicalCoreCount: 4,
  minimumRealRelationCount: 150,
  minimumLongReferenceRelationCount: 30,
  minimumGoldEditEventCount: 500,
  minimumFrozenRelationRatio: 0.3,
  minimumFrozenEditEventRatio: 0.3,
  minimumSameAudioTop1Accuracy: 0.995,
  minimumFrozenRelationshipDecisionCount: 1_000,
  maximumVerifiedWrongRelationshipCount: 0,
  maximumMatchedProjectionP95Ms: 200,
  maximumMatchedProjectionP99Ms: 500,
  maximumEndDriftAt45MinutesMs: 250,
  minimumEditEventF1: 0.97,
  maximumBoundaryErrorP95Ms: 250,
  maximumDurationErrorP95Ms: 250,
  minimumPerEditClassF1: 0.95,
  minimumVisualFallbackTop1Accuracy: 0.99,
  maximumVisualFallbackProjectionP95Ms: 500,
  minimumNorthStarSuiteCount: 20,
  requiredCorrectEpisodesPerNorthStarSuite: 5,
  maximumNorthStarCrossEpisodeMismatchCount: 0,
  maximumColdElapsedMs: 10 * 60 * 1_000,
  maximumHotElapsedMs: 2 * 60 * 1_000,
  maximumPeakProcessTreeRssBytes: 1_073_741_824,
  maximumUnsafeDegradationCount: 0
} as const;

export type C137Digest = `sha256:${string}`;
export type C137CertificationClass = "synthetic-smoke" | "real-development" | "real-frozen";
export type C137DatasetSplit = "development" | "calibration" | "frozen-test";
export type C137EditKind = "sourceOnly" | "targetOnly" | "replacement";
export type C137QualityLevel = "verified" | "review" | "blocked" | "legacy-unverified";

export interface C137CalibrationThresholdApproval {
  status: "pending" | "approved";
  approvalId: string | null;
  maximumEce: number | null;
  maximumBrierScore: number | null;
}

export interface C137CalibrationCurvePoint {
  scoreMargin: number;
  probability: number;
}

export interface C137CalibrationModelV1 {
  schemaVersion: typeof C137_CALIBRATION_MODEL_SCHEMA_VERSION;
  kind: "c137-native-score-calibration-model";
  modelId: string;
  featureContract: typeof C137_FORMAL_BLIND_CALIBRATION_FEATURE_CONTRACT;
  sourceScoreContract: typeof C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
  calibrationSplit: "calibration";
  calibrationDatasetVersion: string;
  calibrationDatasetDigest: C137Digest;
  points: C137CalibrationCurvePoint[];
  modelDigest: C137Digest;
}

export interface C137CalibrationModelApproval {
  status: "pending" | "approved";
  approvalId: string | null;
  model: C137CalibrationModelV1 | null;
}

export interface C137CancellationThresholdApproval {
  status: "pending" | "approved";
  approvalId: string | null;
  maximumP95Ms: number | null;
}

export interface C137AcceptanceProtocol {
  schemaVersion: typeof C137_ACCEPTANCE_PROTOCOL_SCHEMA_VERSION;
  id: string;
  version: "8";
  topK: number;
  calibrationBinCount: number;
  requiredColdRuns: number;
  requiredHotRuns: number;
  requiredCancellationRuns: number;
  performancePlanDigest: C137Digest;
  blindRankingPlanDigest: C137Digest;
  requiredFormalBlindProvenanceSchemaVersion: typeof C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION;
  requiredBlindMatrixPlanSchemaVersion: typeof C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION;
  requiredBlindProjectionSchemaVersion: 1;
  requiredNativeEvidenceVersion: typeof REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION;
  requiredNativeReceiptSchemaVersion: typeof REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION;
  requiredBlindPairingMode: "fullCartesian";
  requiredBlindScoreContract: typeof C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
  requiredBlindMatrixCoverage: typeof C137_FORMAL_BLIND_MATRIX_COVERAGE;
  requiredBlindAggregation: typeof C137_BLIND_GLOBAL_AGGREGATION_CONTRACT;
  requiredPerformanceRawSchemaVersion: typeof C137_FORMAL_PERFORMANCE_RAW_SCHEMA_VERSION;
  maximumMemorySampleIntervalMs: number;
  requiredMonotonicClock: "rust-std-instant-session-relative-v1";
  requiredMemorySampler: "windows-job-object-working-set-v1";
  requiredStorageScope: "workload-media-volumes";
  performanceAggregation: "maximum";
  memoryScope: "application-process-tree";
  coldCacheDefinition: "empty-application-feature-cache";
  hotCacheDefinition: "same-process-after-complete-warmup";
  targetEnvironmentDigest: C137Digest;
  calibrationThresholds: C137CalibrationThresholdApproval;
  calibrationModel: C137CalibrationModelApproval;
  cancellationThreshold: C137CancellationThresholdApproval;
}

export interface C137EnvironmentFingerprint {
  schemaVersion: 2;
  digest: C137Digest;
  operatingSystem: string;
  operatingSystemVersion: string;
  architecture: string;
  cpuModel: string;
  physicalCoreCount: number;
  logicalCoreCount: number;
  totalMemoryBytes: number;
  storageScope: "system-volume" | "workload-media-volumes";
  storageKind: string;
  powerProfile: string;
  ffmpegVersion: string;
  ffmpegBinaryDigest: C137Digest;
  ffprobeVersion: string;
  ffprobeBinaryDigest: C137Digest;
}

export interface C137RunnerFingerprint {
  schemaVersion: 1;
  appVersion: string;
  gitCommit: string;
  buildProfile: "debug" | "release";
  buildDigest: C137Digest;
  engineVersion: string;
  featureVersion: string;
  parametersDigest: C137Digest;
}

export interface C137DatasetApprovalReceipt {
  schemaVersion: typeof C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  manifestDigest: C137Digest;
  goldDigest: C137Digest;
  datasetVersion: string;
  certificationClass: C137CertificationClass;
  licenseReviewComplete: boolean;
  independentReviewComplete: boolean;
  frozenGoldSealed: boolean;
  approvedAt: string;
}

export interface C137PreflightReceipt {
  schemaVersion: typeof C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  manifestDigest: C137Digest;
  datasetVersion: string;
  mediaBindingsDigest: C137Digest;
  ok: boolean;
  realRelationCount: number;
  checkedFileCount: number;
  completedAt: string;
}

export interface C137PredictionRunReceipt {
  schemaVersion: typeof C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  manifestDigest: C137Digest;
  datasetVersion: string;
  predictionsDigest: C137Digest;
  protocolId: string;
  environmentDigest: C137Digest;
  buildDigest: C137Digest;
  engineVersion: string;
  featureVersion: string;
  parametersDigest: C137Digest;
  completedAt: string;
}

export interface C137EvidenceBinding {
  manifestDigest: C137Digest;
  goldDigest: C137Digest;
  datasetVersion: string;
  predictionsDigest: C137Digest;
  protocolId: string;
  environmentDigest: C137Digest;
  buildDigest: C137Digest;
  engineVersion: string;
  featureVersion: string;
  parametersDigest: C137Digest;
  evidenceDigest: C137Digest;
}

export interface C137DatasetCaseEvidence {
  caseId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  scenarios: RealMediaBenchmarkScenario[];
  goldEditEventCount: number;
  independentlyReviewed: boolean;
  adjudicationComplete: boolean;
}

export interface C137DatasetReport {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  cases: C137DatasetCaseEvidence[];
}

export interface C137RelationshipDecisionEvidence {
  decisionId: C137Digest;
  provenanceRef: C137Digest;
  caseId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  modality: "same-audio" | "visual-only" | "mixed" | "no-common-content";
  goldCandidateId: C137Digest;
  rankedCandidateIds: C137Digest[];
  verifiedCandidateId: null;
}

export interface C137RelationshipRankingReport {
  schemaVersion: typeof C137_RELATIONSHIP_RANKING_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  rankingScope: typeof C137_RELATIONSHIP_RANKING_SCOPE;
  scoreContract: typeof C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
  globalTopK: number;
  decisions: C137RelationshipDecisionEvidence[];
}

export interface C137EditDecisionEvidence {
  eventId: string;
  goldKind: C137EditKind | null;
  predictedKind: C137EditKind | null;
  durationMs: number;
  boundaryErrorMs: number | null;
  durationErrorMs: number | null;
}

export interface C137TimeMapCaseEvidence {
  caseId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  scenarios: RealMediaBenchmarkScenario[];
  matchedProjectionErrorsMs: number[];
  endDriftAt45MinutesMs: number | null;
  editDecisions: C137EditDecisionEvidence[];
}

export interface C137TimeMapReport {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  cases: C137TimeMapCaseEvidence[];
}

export interface C137CalibrationSample {
  decisionId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  top1Score: number;
  top2Score: number;
  scoreMargin: number;
  probability: number;
  correct: boolean;
}

export interface C137CalibrationReport {
  schemaVersion: typeof C137_CALIBRATION_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  modelDigest: C137Digest;
  samples: C137CalibrationSample[];
}

export interface C137VisualFallbackCaseEvidence {
  caseId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  goldCandidateId: string;
  rankedCandidateIds: string[];
  projectionErrorsMs: number[];
  sparseVisualAutomaticVerified: boolean;
}

export interface C137VisualFallbackReport {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  cases: C137VisualFallbackCaseEvidence[];
}

export interface C137DegradationCaseEvidence {
  caseId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  expectedLevel: C137QualityLevel;
  actualLevel: C137QualityLevel;
  expectedReasonCode: string;
  actualReasonCode: string;
}

export interface C137DegradationReport {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  cases: C137DegradationCaseEvidence[];
}

export interface C137NorthStarSuiteEvidence {
  suiteId: string;
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
  expectedEpisodeCount: number;
  correctlyLocatedEpisodeCount: number;
  crossEpisodeMismatchCount: number;
  exportCompleted: boolean;
}

export interface C137NorthStarReport {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  suites: C137NorthStarSuiteEvidence[];
}

export interface C137PerformanceReport {
  schemaVersion: typeof C137_PERFORMANCE_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  /**
   * v1 remains readable as engineering evidence during migration. The formal gate independently
   * requires native v3 evidence plus its four assurance receipts, so legacy evidence can never
   * grant release status.
   */
  rawEvidence: C137PerformanceRawEvidenceV1 | C137PerformanceRawEvidenceV2;
}

export interface C137UiWalkthroughReceipt {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  passed: boolean;
  completedSuiteCount: number;
  buildDigest: C137Digest;
  completedAt: string;
}

export interface C137ReleaseVerificationReceipt {
  schemaVersion: typeof C137_ACCEPTANCE_REPORT_SCHEMA_VERSION;
  binding: C137EvidenceBinding;
  sourceAuditPassed: boolean;
  lintPassed: boolean;
  frontendTestsPassed: boolean;
  rustTestsPassed: boolean;
  e2ePassed: boolean;
  buildPassed: boolean;
  tauriReleasePassed: boolean;
  buildDigest: C137Digest;
  completedAt: string;
}

export interface C137AcceptanceReports {
  dataset: C137DatasetReport | null;
  relationshipRanking: C137RelationshipRankingReport | null;
  timeMap: C137TimeMapReport | null;
  calibration: C137CalibrationReport | null;
  visualFallback: C137VisualFallbackReport | null;
  degradation: C137DegradationReport | null;
  northStar: C137NorthStarReport | null;
  performance: C137PerformanceReport | null;
  uiWalkthrough: C137UiWalkthroughReceipt | null;
  releaseVerification: C137ReleaseVerificationReceipt | null;
}

export interface C137AcceptanceFormalEvidence {
  /** Private evidence: it contains frozen gold bindings and execution paths; never share it. */
  blindRelationship: C137FormalBlindProvenanceV3 | null;
}

export interface C137AcceptanceBundle {
  schemaVersion: typeof C137_ACCEPTANCE_SCHEMA_VERSION;
  kind: "c137-acceptance-bundle";
  manifestDigest: C137Digest;
  datasetVersion: string;
  certificationClass: C137CertificationClass;
  protocol: C137AcceptanceProtocol;
  environment: C137EnvironmentFingerprint;
  runner: C137RunnerFingerprint;
  receipts: {
    datasetApproval: C137DatasetApprovalReceipt | null;
    preflight: C137PreflightReceipt | null;
    predictionRun: C137PredictionRunReceipt | null;
  };
  formalEvidence: C137AcceptanceFormalEvidence;
  reports: C137AcceptanceReports;
}

export type C137BoundAcceptanceReport = Exclude<
  C137AcceptanceReports[keyof C137AcceptanceReports],
  null
>;

/**
 * An unauthenticated digest snapshot supplied by the caller.
 *
 * It is useful for detecting mutation against a separately captured snapshot,
 * but it is not an authority credential and must never make a release eligible
 * by itself. A future formal gate needs a separately verified authority envelope.
 */
export interface C137AcceptanceTrustContext {
  trustedProtocolDigest: C137Digest;
  trustedReceiptDigests: {
    datasetApproval: C137Digest;
    preflight: C137Digest;
    predictionRun: C137Digest;
  };
  trustedReportEvidenceDigests: {
    [Key in keyof C137AcceptanceReports]: C137Digest;
  };
}

export type C137AcceptanceCheckStatus = "pass" | "fail" | "incomplete";

export interface C137AcceptanceCheck {
  id: string;
  status: C137AcceptanceCheckStatus;
  actual: number | string | boolean;
  requirement: string;
}

export interface C137AcceptanceGate {
  scope: "c137-release-acceptance";
  status: "incomplete-evidence" | "fail" | "pass";
  verifiedEligible: boolean;
  checks: C137AcceptanceCheck[];
  reasons: string[];
}

export interface C137AcceptanceValidationResult {
  valid: boolean;
  issues: string[];
}

const REQUIRED_REPORT_KEYS: readonly (keyof C137AcceptanceReports)[] = [
  "dataset",
  "relationshipRanking",
  "timeMap",
  "calibration",
  "visualFallback",
  "degradation",
  "northStar",
  "performance",
  "uiWalkthrough",
  "releaseVerification"
];

/** Deterministic SHA-256 for externally approved C137 protocols, receipts, and evidence. */
export function computeC137CanonicalDigest(value: unknown): C137Digest {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function computeC137CalibrationModelDigest(
  model: Omit<C137CalibrationModelV1, "modelDigest"> | C137CalibrationModelV1
): C137Digest {
  const { modelDigest: ignoredModelDigest, ...payload } = model as C137CalibrationModelV1;
  void ignoredModelDigest;
  return computeC137CanonicalDigest({
    domain: C137_CALIBRATION_MODEL_DIGEST_DOMAIN,
    model: payload
  });
}

export function sealC137CalibrationModel(
  draft: Omit<C137CalibrationModelV1, "modelDigest">
): C137CalibrationModelV1 {
  const model: C137CalibrationModelV1 = {
    ...draft,
    points: draft.points.map((point) => ({ ...point })),
    modelDigest: computeC137CalibrationModelDigest(draft)
  };
  const issues: string[] = [];
  validateC137CalibrationModelValue(model, "calibrationModel", issues);
  if (issues.length > 0) {
    throw new Error(issues.join("；"));
  }
  return model;
}

export function applyC137CalibrationModel(
  model: C137CalibrationModelV1,
  scoreMargin: number
): number {
  const issues: string[] = [];
  validateC137CalibrationModelValue(model, "calibrationModel", issues);
  if (issues.length > 0) {
    throw new Error(issues.join("；"));
  }
  if (!isUnitNumber(scoreMargin)) {
    throw new Error("calibration scoreMargin 必须是 0–1 的有限数字。");
  }
  return interpolateC137CalibrationModel(model, scoreMargin);
}

function interpolateC137CalibrationModel(
  model: C137CalibrationModelV1,
  scoreMargin: number
): number {
  const exact = model.points.find((point) => point.scoreMargin === scoreMargin);
  if (exact !== undefined) {
    return exact.probability;
  }
  for (let index = 1; index < model.points.length; index += 1) {
    const right = model.points[index];
    const left = model.points[index - 1];
    if (left === undefined || right === undefined || scoreMargin > right.scoreMargin) {
      continue;
    }
    const weight = (scoreMargin - left.scoreMargin) / (right.scoreMargin - left.scoreMargin);
    return left.probability + weight * (right.probability - left.probability);
  }
  throw new Error("calibration model 未覆盖 scoreMargin。");
}

/**
 * Environment identity is derived from every allowlisted hardware and toolchain field. Keeping
 * the claimed digest out of the payload prevents a caller from editing CPU/tool data while
 * retaining an unrelated, externally approved digest string.
 */
export function computeC137EnvironmentDigest(
  environment: Omit<C137EnvironmentFingerprint, "digest"> | C137EnvironmentFingerprint
): C137Digest {
  return computeC137CanonicalDigest({
    domain: "c137-environment-fingerprint-v2",
    schemaVersion: environment.schemaVersion,
    operatingSystem: environment.operatingSystem,
    operatingSystemVersion: environment.operatingSystemVersion,
    architecture: environment.architecture,
    cpuModel: environment.cpuModel,
    physicalCoreCount: environment.physicalCoreCount,
    logicalCoreCount: environment.logicalCoreCount,
    totalMemoryBytes: environment.totalMemoryBytes,
    storageScope: environment.storageScope,
    storageKind: environment.storageKind,
    powerProfile: environment.powerProfile,
    ffmpegVersion: environment.ffmpegVersion,
    ffmpegBinaryDigest: environment.ffmpegBinaryDigest,
    ffprobeVersion: environment.ffprobeVersion,
    ffprobeBinaryDigest: environment.ffprobeBinaryDigest
  });
}

/**
 * Recomputes a report digest from raw evidence. The embedded evidenceDigest is deliberately
 * excluded so a report cannot authenticate itself by changing both its content and claimed hash.
 */
export function computeC137ReportEvidenceDigest(report: C137BoundAcceptanceReport): C137Digest {
  return computeC137CanonicalDigest({
    ...report,
    binding: {
      manifestDigest: report.binding.manifestDigest,
      goldDigest: report.binding.goldDigest,
      datasetVersion: report.binding.datasetVersion,
      predictionsDigest: report.binding.predictionsDigest,
      protocolId: report.binding.protocolId,
      environmentDigest: report.binding.environmentDigest,
      buildDigest: report.binding.buildDigest,
      engineVersion: report.binding.engineVersion,
      featureVersion: report.binding.featureVersion,
      parametersDigest: report.binding.parametersDigest
    }
  });
}

export function evaluateC137AcceptanceBundle(
  value: unknown,
  trustContext?: C137AcceptanceTrustContext
): C137AcceptanceGate {
  const validation = validateC137AcceptanceBundle(value);
  if (!validation.valid) {
    return createAcceptanceGate([
      createCheck(
        "bundle-schema",
        "incomplete",
        validation.issues.join("；"),
        "验收 bundle 必须通过严格 schema 与原始 evidence 校验"
      )
    ]);
  }

  const bundle = value as C137AcceptanceBundle;
  const evidenceChecks = evaluateEvidenceCompleteness(bundle, trustContext);
  const reports = requireCompleteReports(bundle.reports);
  const receipts = requireCompleteReceipts(bundle.receipts);
  if (reports === null || receipts === null) {
    return createAcceptanceGate(evidenceChecks);
  }

  const thresholdChecks = [
    ...evaluateDatasetThresholds(reports.dataset),
    ...evaluateRelationshipThresholds(reports.relationshipRanking, bundle.protocol),
    ...evaluateTimeMapThresholds(reports.timeMap),
    ...evaluateCalibrationThresholds(reports.calibration, bundle.protocol),
    ...evaluateVisualFallbackThresholds(reports.visualFallback),
    ...evaluateDegradationThresholds(reports.degradation),
    ...evaluateNorthStarThresholds(reports.northStar),
    ...evaluatePerformanceThresholds(reports.performance, bundle.protocol),
    ...evaluateUiAndReleaseThresholds(
      reports.uiWalkthrough,
      reports.releaseVerification,
      bundle.runner
    )
  ];
  return createAcceptanceGate([...evidenceChecks, ...thresholdChecks]);
}

function evaluateEvidenceCompleteness(
  bundle: C137AcceptanceBundle,
  trustContext: C137AcceptanceTrustContext | undefined
): C137AcceptanceCheck[] {
  const checks: C137AcceptanceCheck[] = [
    ...evaluateExternalTrust(bundle, trustContext),
    ...evaluateFormalBlindRankingEvidence(bundle),
    ...evaluatePairLocalFineEvidence(bundle),
    createCheck(
      "certification-class",
      bundle.certificationClass === "real-frozen" ? "pass" : "incomplete",
      bundle.certificationClass,
      "完整 C137 验收只接受已审批的 real-frozen 数据"
    ),
    createCheck(
      "target-hardware",
      bundle.environment.digest === bundle.protocol.targetEnvironmentDigest &&
        bundle.environment.physicalCoreCount ===
          C137_FIXED_ACCEPTANCE_THRESHOLDS.targetPhysicalCoreCount
        ? "pass"
        : "incomplete",
      `${bundle.environment.physicalCoreCount} cores / ${bundle.environment.digest}`,
      "必须在协议锁定的 4 核目标环境运行"
    ),
    createCheck(
      "release-build-profile",
      bundle.runner.buildProfile === "release" ? "pass" : "incomplete",
      bundle.runner.buildProfile,
      "完整验收必须使用 release 构建"
    ),
    createCheck(
      "calibration-threshold-approved",
      isApprovedCalibrationThreshold(bundle.protocol.calibrationThresholds)
        ? "pass"
        : "incomplete",
      bundle.protocol.calibrationThresholds.status,
      "ECE/Brier 数值门槛必须先经版本化协议批准，禁止临时猜测"
    ),
    createCheck(
      "calibration-model-approved",
      isApprovedCalibrationModel(bundle.protocol.calibrationModel) ? "pass" : "incomplete",
      bundle.protocol.calibrationModel.status,
      "校准模型必须由协议冻结 calibration split、原生 score contract、单调曲线与模型摘要，禁止使用 frozen-test 拟合或临时填写概率"
    ),
    createCheck(
      "cancellation-threshold-approved",
      isApprovedCancellationThreshold(bundle.protocol.cancellationThreshold)
        ? "pass"
        : "incomplete",
      bundle.protocol.cancellationThreshold.status,
      "取消响应 p95 门槛必须先经版本化协议批准，禁止临时猜测"
    )
  ];

  const { datasetApproval, preflight, predictionRun } = bundle.receipts;
  checks.push(
    createCheck(
      "dataset-approval-receipt",
      datasetApproval === null ? "incomplete" : "pass",
      datasetApproval === null ? "missing" : datasetApproval.receiptId,
      "必须有绑定真实冻结集、许可和双人复核的审批 receipt"
    ),
    createCheck(
      "preflight-receipt",
      preflight === null ? "incomplete" : "pass",
      preflight === null ? "missing" : preflight.receiptId,
      "必须有成功的媒体身份与流索引 preflight receipt"
    ),
    createCheck(
      "prediction-run-receipt",
      predictionRun === null ? "incomplete" : "pass",
      predictionRun === null ? "missing" : predictionRun.receiptId,
      "必须有封存预测、引擎、参数、构建和环境的运行 receipt"
    )
  );

  for (const key of REQUIRED_REPORT_KEYS) {
    checks.push(
      createCheck(
        `report:${key}`,
        bundle.reports[key] === null ? "incomplete" : "pass",
        bundle.reports[key] === null ? "missing" : "present",
        `必须提供 ${key} 原始 evidence 报告`
      )
    );
  }

  if (datasetApproval !== null) {
    const approvalComplete =
      datasetApproval.manifestDigest === bundle.manifestDigest &&
      datasetApproval.datasetVersion === bundle.datasetVersion &&
      datasetApproval.certificationClass === bundle.certificationClass &&
      datasetApproval.licenseReviewComplete &&
      datasetApproval.independentReviewComplete &&
      datasetApproval.frozenGoldSealed;
    checks.push(
      createCheck(
        "dataset-approval-binding",
        approvalComplete ? "pass" : "incomplete",
        approvalComplete,
        "审批 receipt 必须绑定同一 manifest/dataset，且许可、双人复核、冻结封存均完成"
      )
    );
  }

  if (preflight !== null) {
    const preflightComplete =
      preflight.ok &&
      preflight.manifestDigest === bundle.manifestDigest &&
      preflight.datasetVersion === bundle.datasetVersion;
    checks.push(
      createCheck(
        "preflight-binding",
        preflightComplete ? "pass" : "incomplete",
        preflightComplete,
        "preflight 必须成功并绑定同一 manifest/dataset"
      )
    );
  }

  if (predictionRun !== null) {
    const runComplete =
      predictionRun.manifestDigest === bundle.manifestDigest &&
      predictionRun.datasetVersion === bundle.datasetVersion &&
      predictionRun.protocolId === protocolIdentity(bundle.protocol) &&
      predictionRun.environmentDigest === bundle.environment.digest &&
      predictionRun.buildDigest === bundle.runner.buildDigest &&
      predictionRun.engineVersion === bundle.runner.engineVersion &&
      predictionRun.featureVersion === bundle.runner.featureVersion &&
      predictionRun.parametersDigest === bundle.runner.parametersDigest;
    checks.push(
      createCheck(
        "prediction-run-binding",
        runComplete ? "pass" : "incomplete",
        runComplete,
        "预测 receipt 必须绑定同一 manifest、协议、环境、构建、引擎、特征和参数"
      )
    );
  }

  if (datasetApproval !== null && predictionRun !== null) {
    for (const key of REQUIRED_REPORT_KEYS) {
      const report = bundle.reports[key];
      if (report === null) {
        continue;
      }
      const bound = bindingMatchesBundle(
        report.binding,
        bundle,
        datasetApproval,
        predictionRun
      );
      checks.push(
        createCheck(
          `binding:${key}`,
          bound ? "pass" : "incomplete",
          bound,
          `${key} 必须绑定同一 manifest、gold、predictions、协议、环境和算法构建`
        )
      );
    }
  }

  const dataset = bundle.reports.dataset;
  if (dataset !== null) {
    const allReal =
      dataset.cases.length > 0 && dataset.cases.every((item) => item.mediaKind === "real");
    checks.push(
      createCheck(
        "real-media-only",
        allReal ? "pass" : "incomplete",
        allReal,
        "synthetic/placeholder 不得冒充或混入 real-frozen 验收"
      )
    );
  }

  checks.push(...evaluateRawEvidenceCompleteness(bundle));
  return checks;
}

function evaluatePairLocalFineEvidence(bundle: C137AcceptanceBundle): C137AcceptanceCheck[] {
  const provenance = bundle.formalEvidence.blindRelationship;
  if (provenance === null) {
    return [
      createCheck(
        "native-pair-local-fine-integrity",
        "incomplete",
        "missing-private-provenance",
        "必须从同一 private formal provenance 的 frozen Gold、fine frontier、实际解码窗口与 proposal TimeMap 唯一推导 pair-local 证据"
      ),
      createCheck(
        "native-pair-local-time-map-binding",
        "incomplete",
        "missing-private-provenance",
        "TimeMap 报告必须逐 case 等于 native proposal 对 frozen Gold 的重算结果，禁止调用方手填误差、删减类别和边界"
      ),
      createCheck(
        "native-pair-local-window-inventory",
        "incomplete",
        "missing-private-provenance",
        "每个 frozen gold pair 必须公开并摘要绑定完整的 pair-local 多窗口候选 ID 清单"
      ),
      createCheck(
        "native-pair-local-bilateral-boundaries",
        "incomplete",
        "missing-private-provenance",
        "编辑事件必须从 frozen Gold 与 proposal TimeMap 推导 source/target 双轴起止边界误差"
      ),
      createCheck(
        "native-blind-modality-provenance",
        "incomplete",
        "missing-private-provenance",
        "relationship modality 必须从同一 native gold pair 的实际音频/视觉锚点与双端流身份唯一推导"
      )
    ];
  }

  try {
    const evidence = deriveC137PairLocalFineEvidence(provenance);
    const measured = evidence.cases.filter((item) => item.status === "measured");
    const allMeasured = measured.length === evidence.cases.length && evidence.cases.length > 0;
    const timeMapReport = bundle.reports.timeMap;
    const timeMapBound =
      allMeasured &&
      timeMapReport !== null &&
      c137TimeMapCasesEqualPairLocalEvidence(timeMapReport.cases, evidence);
    const completeInventories =
      evidence.cases.length > 0 &&
      evidence.cases.every((item) => item.completePairCandidateInventoryEnumerated);
    const alternativesObserved = evidence.cases.filter(
      (item) => item.samePairAlternativeObserved
    ).length;
    const manyToManyObserved = evidence.cases.filter(
      (item) => item.sameSegmentManyToManyObserved
    ).length;
    const bilateralDecisionCount = evidence.cases.reduce(
      (count, item) =>
        count +
        (item.timeMap?.editDecisions.filter(
          (decision) => decision.bilateralBoundaryErrorsMs !== null
        ).length ?? 0),
      0
    );
    const pairedDecisionCount = evidence.cases.reduce(
      (count, item) =>
        count +
        (item.timeMap?.editDecisions.filter(
          (decision) => decision.goldKind !== null && decision.predictedKind !== null
        ).length ?? 0),
      0
    );
    const bilateralComplete =
      allMeasured && pairedDecisionCount > 0 && bilateralDecisionCount === pairedDecisionCount;
    const modalityBound =
      allMeasured &&
      bundle.reports.relationshipRanking !== null &&
      c137RelationshipModalitiesEqualPairLocalEvidence(
        bundle.reports.relationshipRanking.decisions.map((decision) => ({
          caseId: decision.caseId,
          modality: decision.modality
        })),
        evidence
      );
    const blockedSummary = evidence.cases
      .filter((item) => item.status === "blocked")
      .map((item) => `${item.caseId}:${item.issues.join("/")}`)
      .join("；");
    return [
      createCheck(
        "native-pair-local-fine-integrity",
        allMeasured ? "pass" : "incomplete",
        allMeasured ? evidence.evidenceDigest : blockedSummary || "no-measured-case",
        "每个 frozen case 必须唯一定位 gold native pair，并闭合 resolved fine frontier、selected candidate、实际 decode windows 与 proposal TimeMap digest"
      ),
      createCheck(
        "native-pair-local-time-map-binding",
        timeMapBound ? "pass" : "incomplete",
        timeMapBound ? evidence.evidenceDigest : "report-mismatch-or-incomplete",
        "TimeMap 报告必须逐 case 精确等于同一 native proposal 对同一 frozen Gold 唯一重算的 anchor、45 分钟漂移、编辑分类、边界与时长误差"
      ),
      createCheck(
        "native-pair-local-window-inventory",
        completeInventories && alternativesObserved === evidence.cases.length
          ? "pass"
          : "incomplete",
        `${alternativesObserved}/${evidence.cases.length} observed; complete=${String(completeInventories)}`,
        "native receipt 必须枚举并摘要绑定每个 gold pair 的完整多窗口候选 ID 清单，且每个 pair 至少证明两个实际候选；仅有 inventoryCandidateCount 不足以证明"
      ),
      createCheck(
        "native-pair-local-many-to-many",
        manyToManyObserved > 0 ? "pass" : "incomplete",
        manyToManyObserved,
        "冻结证据必须至少覆盖一个显式多版本组：两个不同 pair 在同一 fine component 中同时入选，并在获准复用的物理轴上实际重叠超过容差；单 pair 多轨道成员不能冒充多对多"
      ),
      createCheck(
        "native-pair-local-bilateral-boundaries",
        bilateralComplete ? "pass" : "incomplete",
        `${bilateralDecisionCount}/${pairedDecisionCount}`,
        "所有配对编辑事件都必须保存由 Gold/TimeMap 重算的 sourceStart/sourceEnd/targetStart/targetEnd 四个绝对误差；无编辑样本不能通过"
      ),
      createCheck(
        "native-blind-modality-provenance",
        modalityBound ? "pass" : "incomplete",
        modalityBound ? evidence.evidenceDigest : "report-mismatch-or-native-modality-blocked",
        "same-audio/visual-only/mixed 必须逐 case 等于 native TimeMap 的实际锚点类型、双端流身份与 fine execution；调用方不能事后改写"
      )
    ];
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      createCheck(
        "native-pair-local-fine-integrity",
        "incomplete",
        message,
        "pair-local fine evidence 必须可从严格有效的 formal provenance 唯一推导"
      ),
      createCheck(
        "native-pair-local-time-map-binding",
        "incomplete",
        "derivation-failed",
        "TimeMap 报告不得绕过 pair-local frozen Gold 重算"
      ),
      createCheck(
        "native-blind-modality-provenance",
        "incomplete",
        "derivation-failed",
        "modality 不得绕过 native pair-local evidence 推导"
      )
    ];
  }
}

function evaluateFormalBlindRankingEvidence(
  bundle: C137AcceptanceBundle
): C137AcceptanceCheck[] {
  const provenance = bundle.formalEvidence.blindRelationship;
  if (provenance === null) {
    return [
      createCheck(
        "native-blind-envelope-integrity",
        "incomplete",
        "missing",
        "必须提交私有 formal v3 blind envelope，包含预注册 exhaustive matrix 计划、每个 tile 的 execution suite、native receipt v4 与确定性 raw prediction"
      ),
      createCheck(
        "native-blind-protocol-structure",
        "incomplete",
        "missing",
        "protocol v8 必须精确绑定 formal schema3、matrix plan schema2、native evidence/receipt v4、完整 fine inventory、shard-invariant score、exhaustive coverage、原生 score margin 与批准校准模型"
      ),
      createCheck(
        "native-blind-decision-coverage",
        "incomplete",
        "missing",
        "formal blind 计划必须无重无漏覆盖全部 query×candidate matrix cell，并在收齐所有候选分片后为每个冻结 query 生成一次全局决策"
      ),
      createCheck(
        "native-blind-ranking-binding",
        "incomplete",
        "missing",
        "relationship report v3 必须声明 global exhaustive scope，并逐条等于所有 native matrix cell 的确定性全局 Top-K 重算"
      ),
      createCheck(
        "native-blind-ranking-provenance",
        "incomplete",
        "missing-private-provenance",
        "acceptance v6 不信任调用方或单个 candidate shard 自报 Top-K；缺少 private exhaustive-matrix provenance 时不得放行"
      ),
      createCheck(
        "native-blind-calibration-provenance",
        "incomplete",
        "missing-private-provenance",
        "calibration probability 必须由 formal exhaustive-matrix 的原生 Top-1/Top-2 score margin 和协议批准模型唯一重算"
      ),
      ...createPendingBlindAuthorityChecks("missing-private-provenance")
    ];
  }

  const evaluation = evaluateC137FormalBlindProvenance(provenance, {
    manifestDigest: bundle.manifestDigest,
    datasetVersion: bundle.datasetVersion,
    planDigest: bundle.protocol.blindRankingPlanDigest,
    topK: bundle.protocol.topK,
    parametersDigest: bundle.runner.parametersDigest
  });
  const integrityValid = evaluation.valid;
  const coverageValid = integrityValid && evaluation.coverageValid;
  const protocolStructureBound =
    integrityValid &&
    provenance.schemaVersion === bundle.protocol.requiredFormalBlindProvenanceSchemaVersion &&
    provenance.plan.schemaVersion === bundle.protocol.requiredBlindMatrixPlanSchemaVersion &&
    provenance.plan.scoreContract === bundle.protocol.requiredBlindScoreContract &&
    provenance.plan.matrixCoverage === bundle.protocol.requiredBlindMatrixCoverage &&
    provenance.plan.globalTopK === bundle.protocol.topK &&
    bundle.protocol.requiredBlindAggregation === C137_BLIND_GLOBAL_AGGREGATION_CONTRACT &&
    provenance.batches.every(
      (batch) =>
        batch.projection.schemaVersion ===
          bundle.protocol.requiredBlindProjectionSchemaVersion &&
        batch.nativeReceipt.pairingMode === bundle.protocol.requiredBlindPairingMode &&
        batch.nativeReceipt.schemaVersion ===
          bundle.protocol.requiredNativeReceiptSchemaVersion &&
        batch.nativeReceipt.nativeEvidenceVersion ===
          bundle.protocol.requiredNativeEvidenceVersion
    );
  const manifestDigest = integrityValid
    ? computeC137FormalBlindManifestDigest(provenance.manifest)
    : null;
  const goldDigest = integrityValid
    ? computeC137FormalBlindGoldDigest(provenance.manifest)
    : null;
  const mediaBindingsDigest = integrityValid
    ? computeC137FormalBlindMediaBindingsDigest(provenance.manifest)
    : null;
  const parametersDigest = integrityValid
    ? computeC137FormalBlindParametersDigest(provenance)
    : null;
  const datasetApproval = bundle.receipts.datasetApproval;
  const preflight = bundle.receipts.preflight;
  const predictionRun = bundle.receipts.predictionRun;
  const manifestBound = integrityValid && manifestDigest === bundle.manifestDigest;
  const goldBound =
    integrityValid && datasetApproval !== null && goldDigest === datasetApproval.goldDigest;
  const mediaBound =
    integrityValid &&
    preflight !== null &&
    mediaBindingsDigest === preflight.mediaBindingsDigest;
  const predictionRootBound =
    integrityValid &&
    predictionRun !== null &&
    predictionRun.predictionsDigest === provenance.provenanceDigest;
  const parametersBound = integrityValid && parametersDigest === bundle.runner.parametersDigest;
  const rankingBound =
    integrityValid &&
    coverageValid &&
    protocolStructureBound &&
    formalDecisionsMatchRelationshipReport(
      evaluation.decisions,
      bundle.reports.relationshipRanking,
      bundle.protocol.topK
    );
  const calibrationBinding = evaluateNativeCalibrationBinding(bundle, evaluation.decisions);

  const structuralClosure =
    integrityValid &&
    coverageValid &&
    protocolStructureBound &&
    manifestBound &&
    goldBound &&
    mediaBound &&
    parametersBound &&
    predictionRootBound &&
    rankingBound;
  const issueSummary = evaluation.issues.join("；") || "valid";
  return [
    createCheck(
      "native-blind-envelope-integrity",
      integrityValid ? "pass" : "incomplete",
      integrityValid ? provenance.provenanceDigest : issueSummary,
      "每个 formal v3 matrix tile 必须由冻结 manifest 唯一重建 projection，并严格闭合 execution、completed native receipt v4 与 raw prediction"
    ),
    createCheck(
      "native-blind-protocol-structure",
      protocolStructureBound ? "pass" : "incomplete",
      protocolStructureBound,
      "protocol v8 必须精确绑定 formal schema3、matrix plan schema2、native evidence/receipt v4、完整 fine inventory、固定 shard-invariant scoreContract、exhaustive coverage、原生 score margin 与批准校准模型"
    ),
    createCheck(
      "native-blind-plan-binding",
      integrityValid &&
        protocolStructureBound &&
        provenance.plan.planDigest === bundle.protocol.blindRankingPlanDigest
        ? "pass"
        : "incomplete",
      provenance.plan.planDigest,
      "预运行 matrix plan 摘要必须由 protocol v8 锁定 axis、visual、global K、query/candidate tiles、candidate universe、score contract 与 exhaustive coverage"
    ),
    createCheck(
      "native-blind-decision-coverage",
      coverageValid ? "pass" : "incomplete",
      coverageValid ? evaluation.decisions.length : issueSummary,
      "计划与 native receipt 必须无重无漏覆盖全部 frozen query×candidate cell；每个 query 只能在全候选 union 上生成一个全局决策"
    ),
    createCheck(
      "native-blind-manifest-binding",
      manifestBound ? "pass" : "incomplete",
      manifestDigest ?? "unavailable",
      "私有完整 manifest 的 domain-separated 摘要必须等于当前 acceptance bundle.manifestDigest"
    ),
    createCheck(
      "native-blind-gold-binding",
      goldBound ? "pass" : "incomplete",
      goldDigest ?? "unavailable",
      "逐 case gold、独立标注与裁决摘要必须等于 dataset approval 的冻结 goldDigest"
    ),
    createCheck(
      "native-blind-media-binding",
      mediaBound ? "pass" : "incomplete",
      mediaBindingsDigest ?? "unavailable",
      "候选路径、全文件身份与显式音视频流摘要必须等于 preflight mediaBindingsDigest"
    ),
    createCheck(
      "native-blind-provenance-root-binding",
      predictionRootBound ? "pass" : "incomplete",
      provenance.provenanceDigest,
      "prediction receipt 必须绑定 formal provenance root，禁止跨运行、跨计划或跨候选全集复用"
    ),
    createCheck(
      "native-blind-parameters-binding",
      parametersBound ? "pass" : "incomplete",
      parametersDigest ?? "unavailable",
      "所有 formal batch 的 execution parameters 必须按序绑定 runner.parametersDigest，禁止事后更换工具、采样或视觉参数"
    ),
    createCheck(
      "native-blind-ranking-binding",
      rankingBound ? "pass" : "incomplete",
      rankingBound,
      "relationship report v3 的 scope/score/globalTopK 及每条 decisionId/provenanceRef/case/gold/有序全局 Top-K/verified policy 必须逐项等于 formal 全矩阵重算"
    ),
    createCheck(
      "native-blind-calibration-provenance",
      calibrationBinding.bound ? "pass" : "incomplete",
      calibrationBinding.actual,
      "calibration report v2 必须逐 decision 精确绑定原生 Top-1/Top-2 score、规范化 margin、协议批准模型摘要及唯一插值概率"
    ),
    createCheck(
      "native-blind-ranking-provenance",
      "incomplete",
      structuralClosure
        ? "self-consistent-no-native-authority"
        : "private-provenance-not-closed",
      "formal v3 内容闭环仍不能证明签发者或 native job 真实存在；当前仍缺少独立 plan authority、native attestation、challenge freshness 与有状态 replay ledger"
    ),
    ...createPendingBlindAuthorityChecks(
      structuralClosure
        ? "not-implemented-in-formal-provenance-v3"
        : "private-provenance-not-closed"
    )
  ];
}

function formalDecisionsMatchRelationshipReport(
  decisions: readonly {
    provenanceRef: C137Digest;
    caseId: string;
    goldPairId: string;
    rankedPairIds: string[];
  }[],
  report: C137RelationshipRankingReport | null,
  globalTopK: number
): boolean {
  if (
    report === null ||
    report.rankingScope !== C137_RELATIONSHIP_RANKING_SCOPE ||
    report.scoreContract !== C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT ||
    report.globalTopK !== globalTopK ||
    report.decisions.length !== decisions.length
  ) {
    return false;
  }
  return report.decisions.every((reported, index) => {
    const derived = decisions[index];
    return (
      derived !== undefined &&
      derived.rankedPairIds.length === globalTopK &&
      reported.rankedCandidateIds.length === globalTopK &&
      reported.decisionId === derived.provenanceRef &&
      reported.provenanceRef === derived.provenanceRef &&
      reported.caseId === derived.caseId &&
      reported.mediaKind === "real" &&
      reported.split === "frozen-test" &&
      reported.goldCandidateId === derived.goldPairId &&
      reported.verifiedCandidateId === null &&
      equalOrderedStrings(reported.rankedCandidateIds, derived.rankedPairIds)
    );
  });
}

function evaluateNativeCalibrationBinding(
  bundle: C137AcceptanceBundle,
  decisions: readonly C137FormalBlindDerivedRelationshipDecisionV3[]
): { bound: boolean; actual: string } {
  const report = bundle.reports.calibration;
  const approval = bundle.protocol.calibrationModel;
  if (report === null) {
    return { bound: false, actual: "missing-calibration-report" };
  }
  if (!isApprovedCalibrationModel(approval)) {
    return { bound: false, actual: "calibration-model-not-approved" };
  }
  const model = approval.model;
  if (report.modelDigest !== model.modelDigest || report.samples.length !== decisions.length) {
    return { bound: false, actual: "model-digest-or-sample-count-mismatch" };
  }
  const bound = report.samples.every((sample, index) => {
    const decision = decisions[index];
    if (decision === undefined) {
      return false;
    }
    const probability = interpolateC137CalibrationModel(model, decision.scoreMargin);
    return (
      sample.decisionId === decision.provenanceRef &&
      sample.mediaKind === "real" &&
      sample.split === "frozen-test" &&
      sample.top1Score === decision.top1Score &&
      sample.top2Score === decision.top2Score &&
      sample.scoreMargin === decision.scoreMargin &&
      sample.probability === probability &&
      sample.correct === (decision.rankedPairIds[0] === decision.goldPairId)
    );
  });
  return {
    bound,
    actual: bound ? model.modelDigest : "native-score-or-model-probability-mismatch"
  };
}

function createPendingBlindAuthorityChecks(actual: string): C137AcceptanceCheck[] {
  return [
    createCheck(
      "native-blind-plan-authority",
      "incomplete",
      actual,
      "blind plan 必须在运行前由 bundle 外部信任根签发，禁止看完结果后挑选 batch"
    ),
    createCheck(
      "native-blind-authenticode-artifact",
      "incomplete",
      actual,
      "外部 authority 必须独立复核 formal execution identity 指向的 EXE 全文件摘要、Windows Authenticode 信任、固定 signer 证书与时间戳证书"
    ),
    createCheck(
      "native-blind-native-attestation",
      "incomplete",
      actual,
      "native execution attestation 必须进一步证明 challenge 与动态 plan/projection/execution/receipt/provenance 确由同一个受信运行进程产生；仅验证磁盘上的 Authenticode 文件不等于进程证明"
    ),
    createCheck(
      "native-blind-challenge-freshness",
      "incomplete",
      actual,
      "必须由独立 authority 签发并核验一次性 challenge、有效期与 plan/run 绑定"
    ),
    createCheck(
      "native-blind-replay-ledger",
      "incomplete",
      actual,
      "必须由有状态 authority ledger 原子登记 challenge、native job、receipt 与 provenance root，拒绝跨 bundle 重放"
    )
  ];
}

function equalOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function evaluateExternalTrust(
  bundle: C137AcceptanceBundle,
  value: C137AcceptanceTrustContext | undefined
): C137AcceptanceCheck[] {
  const authorityCheck = createCheck(
    "external-trust-authority",
    "incomplete",
    "unverified-caller-snapshot",
    "调用方摘要快照只能检测内容变化，不能证明签发者身份；正式放行必须验证独立 authority 的签名或受信封装"
  );
  if (value === undefined) {
    return [
      authorityCheck,
      createCheck(
        "external-trust-context",
        "incomplete",
        "missing",
        "release 默认没有内置审批白名单；必须由独立信任根提供 protocol、receipts 和 raw reports 的受信 SHA-256"
      )
    ];
  }
  const validation = validateC137AcceptanceTrustContext(value);
  if (!validation.valid) {
    return [
      authorityCheck,
      createCheck(
        "external-trust-context",
        "incomplete",
        validation.issues.join("；"),
        "外部 trustContext 必须使用严格 schema 和规范化 SHA-256"
      )
    ];
  }

  const trust = value;
  const checks: C137AcceptanceCheck[] = [authorityCheck];
  const protocolDigest = computeC137CanonicalDigest(bundle.protocol);
  checks.push(
    createCheck(
      "trusted-protocol-digest",
      protocolDigest === trust.trustedProtocolDigest ? "pass" : "incomplete",
      protocolDigest === trust.trustedProtocolDigest,
      "当前 protocol 的 canonical SHA-256 必须命中外部受信摘要"
    )
  );

  const receiptEntries = [
    ["datasetApproval", bundle.receipts.datasetApproval],
    ["preflight", bundle.receipts.preflight],
    ["predictionRun", bundle.receipts.predictionRun]
  ] as const;
  for (const [key, receipt] of receiptEntries) {
    const trustedDigest = trust.trustedReceiptDigests[key];
    const computedDigest = receipt === null ? null : computeC137CanonicalDigest(receipt);
    checks.push(
      createCheck(
        `trusted-receipt:${key}`,
        computedDigest !== null && computedDigest === trustedDigest ? "pass" : "incomplete",
        computedDigest === null ? "missing" : computedDigest === trustedDigest,
        `${key} receipt 内容的 canonical SHA-256 必须命中外部受信摘要`
      )
    );
  }

  for (const key of REQUIRED_REPORT_KEYS) {
    const report = bundle.reports[key];
    if (report === null) {
      checks.push(
        createCheck(
          `trusted-report:${key}`,
          "incomplete",
          "missing",
          `${key} raw report 必须存在并命中外部受信 evidence SHA-256`
        )
      );
      continue;
    }
    const recomputed = computeC137ReportEvidenceDigest(report);
    const embeddedMatches = report.binding.evidenceDigest === recomputed;
    const externallyTrusted = trust.trustedReportEvidenceDigests[key] === recomputed;
    checks.push(
      createCheck(
        `trusted-report:${key}`,
        embeddedMatches && externallyTrusted ? "pass" : "incomplete",
        embeddedMatches && externallyTrusted,
        `${key} 必须从 raw evidence 重算摘要，且 embedded 与外部受信 SHA-256 同时匹配`
      )
    );
  }
  return checks;
}

function evaluateRawEvidenceCompleteness(bundle: C137AcceptanceBundle): C137AcceptanceCheck[] {
  const reports = requireCompleteReports(bundle.reports);
  if (reports === null) {
    return [];
  }
  const datasetIds = new Set(reports.dataset.cases.map((item) => item.caseId));
  const datasetById = new Map(reports.dataset.cases.map((item) => [item.caseId, item]));
  const timeMapIds = new Set(reports.timeMap.cases.map((item) => item.caseId));
  const rankingCaseIds = new Set(
    reports.relationshipRanking.decisions.map((item) => item.caseId)
  );
  const everyDatasetCaseMeasured = [...datasetIds].every(
    (caseId) => timeMapIds.has(caseId) && rankingCaseIds.has(caseId)
  );
  const allReportCasesKnown = [
    ...reports.timeMap.cases.map((item) => item.caseId),
    ...reports.relationshipRanking.decisions.map((item) => item.caseId),
    ...reports.visualFallback.cases.map((item) => item.caseId),
    ...reports.degradation.cases.map((item) => item.caseId)
  ].every((caseId) => datasetIds.has(caseId));
  const caseMetadataConsistent =
    reports.relationshipRanking.decisions.every((item) => {
      const datasetCase = datasetById.get(item.caseId);
      return (
        datasetCase !== undefined &&
        item.mediaKind === datasetCase.mediaKind &&
        item.split === datasetCase.split
      );
    }) &&
    reports.timeMap.cases.every((item) => {
      const datasetCase = datasetById.get(item.caseId);
      return (
        datasetCase !== undefined &&
        item.mediaKind === datasetCase.mediaKind &&
        item.split === datasetCase.split &&
        sameStringSet(item.scenarios, datasetCase.scenarios)
      );
    }) &&
    reports.visualFallback.cases.every((item) => {
      const datasetCase = datasetById.get(item.caseId);
      return (
        datasetCase !== undefined &&
        item.mediaKind === datasetCase.mediaKind &&
        item.split === datasetCase.split
      );
    }) &&
    reports.degradation.cases.every((item) => {
      const datasetCase = datasetById.get(item.caseId);
      return (
        datasetCase !== undefined &&
        item.mediaKind === datasetCase.mediaKind &&
        item.split === datasetCase.split
      );
    });
  const frozenTimeMapCases = reports.timeMap.cases.filter(isFrozenRealEvidence);
  const measurementsComplete =
    frozenTimeMapCases.length > 0 &&
    frozenTimeMapCases.every(
      (item) =>
        item.matchedProjectionErrorsMs.length > 0 &&
        item.editDecisions.every(
          (event) =>
            (event.goldKind === null && event.predictedKind === null) ||
            event.goldKind === null ||
            event.predictedKind === null ||
            (event.boundaryErrorMs !== null && event.durationErrorMs !== null)
        )
    );
  const frozenTimeStretchCases = frozenTimeMapCases.filter((item) =>
    item.scenarios.includes("time-stretch")
  );
  const driftEvidenceComplete =
    frozenTimeStretchCases.length > 0 &&
    frozenTimeStretchCases.every((item) => item.endDriftAt45MinutesMs !== null);
  const frozenRankingDecisions =
    reports.relationshipRanking.decisions.filter(isFrozenRealEvidence);
  const rankingByDecisionId = new Map<string, C137RelationshipDecisionEvidence>(
    reports.relationshipRanking.decisions.map((item) => [item.decisionId, item])
  );
  const calibrationByDecisionId = new Map(
    reports.calibration.samples.map((item) => [item.decisionId, item])
  );
  const frozenCalibrationSamples = reports.calibration.samples.filter(isFrozenRealEvidence);
  const calibrationModelBound =
    isApprovedCalibrationModel(bundle.protocol.calibrationModel) &&
    reports.calibration.modelDigest === bundle.protocol.calibrationModel.model.modelDigest;
  const everyCalibrationSampleBound = reports.calibration.samples.every((sample) => {
    const decision = rankingByDecisionId.get(sample.decisionId);
    return (
      decision !== undefined &&
      sample.mediaKind === decision.mediaKind &&
      sample.split === decision.split &&
      sample.correct === (decision.rankedCandidateIds[0] === decision.goldCandidateId)
    );
  });
  const calibrationComplete =
    frozenRankingDecisions.length > 0 &&
    frozenCalibrationSamples.length === frozenRankingDecisions.length &&
    calibrationModelBound &&
    everyCalibrationSampleBound &&
    frozenRankingDecisions.every((decision) => {
      const sample = calibrationByDecisionId.get(decision.decisionId);
      return (
        sample !== undefined &&
        sample.mediaKind === decision.mediaKind &&
        sample.split === decision.split &&
        sample.correct === (decision.rankedCandidateIds[0] === decision.goldCandidateId)
      );
    });
  const timeMapByCaseId = new Map(reports.timeMap.cases.map((item) => [item.caseId, item]));
  const goldEditEventCountsConsistent = reports.dataset.cases.every((datasetCase) => {
    const timeMapCase = timeMapByCaseId.get(datasetCase.caseId);
    return (
      timeMapCase !== undefined &&
      datasetCase.goldEditEventCount ===
        timeMapCase.editDecisions.filter((event) => event.goldKind !== null).length
    );
  });
  const visualComplete =
    reports.visualFallback.cases.length > 0 &&
    reports.visualFallback.cases.every(
      (item) =>
        isFrozenRealEvidence(item) &&
        item.rankedCandidateIds.length > 0 &&
        item.projectionErrorsMs.length > 0
    );
  const degradationComplete =
    reports.degradation.cases.length > 0 &&
    reports.degradation.cases.every(isFrozenRealEvidence);
  const performanceValidation = validateC137PerformanceEvidence(
    reports.performance.rawEvidence
  );
  const performanceRaw = reports.performance.rawEvidence;
  const performanceWorkloadManifestBound =
    performanceRaw.schemaVersion === 1 ||
    performanceRaw.runManifestDigest === bundle.manifestDigest;
  const performanceComplete =
    performanceValidation.valid &&
    performanceValidation.complete &&
    performanceWorkloadManifestBound &&
    matchesC137PerformanceEnvironment(bundle.environment, reports.performance.rawEvidence) &&
    reports.performance.rawEvidence.planDigest === bundle.protocol.performancePlanDigest &&
    reports.performance.rawEvidence.collector.clock ===
      bundle.protocol.requiredMonotonicClock &&
    reports.performance.rawEvidence.collector.sampler ===
      bundle.protocol.requiredMemorySampler &&
    reports.performance.rawEvidence.environment.storageScope ===
      bundle.protocol.requiredStorageScope &&
    reports.performance.rawEvidence.plan.memorySampleIntervalMs <=
      bundle.protocol.maximumMemorySampleIntervalMs &&
    reports.performance.rawEvidence.trials.filter((trial) => trial.trialType === "cancellation")
      .length >= bundle.protocol.requiredCancellationRuns;

  return [
    createCheck(
      "case-coverage",
      everyDatasetCaseMeasured && allReportCasesKnown ? "pass" : "incomplete",
      everyDatasetCaseMeasured && allReportCasesKnown,
      "每个数据集 case 必须有 ranking 与 TimeMap 原始 evidence，且报告不得引用清单外 case"
    ),
    createCheck(
      "case-metadata-consistency",
      caseMetadataConsistent ? "pass" : "incomplete",
      caseMetadataConsistent,
      "ranking、TimeMap、视觉回退和降级报告的 mediaKind/split 必须与 dataset 一致，TimeMap scenarios 还必须与 dataset 完全一致"
    ),
    createCheck(
      "gold-edit-event-count-binding",
      goldEditEventCountsConsistent ? "pass" : "incomplete",
      goldEditEventCountsConsistent,
      "每个 dataset case 声明的 goldEditEventCount 必须等于对应 TimeMap 中 goldKind 非空的原始事件数"
    ),
    createCheck(
      "time-map-measurements",
      measurementsComplete ? "pass" : "incomplete",
      measurementsComplete,
      "冻结真实 TimeMap 必须提供 matched 采样和成对事件边界/时长误差"
    ),
    createCheck(
      "drift-measurements",
      driftEvidenceComplete ? "pass" : "incomplete",
      driftEvidenceComplete,
      "每个冻结 time-stretch 关系都必须提供 45 分钟片尾漂移，禁止选择性漏测"
    ),
    createCheck(
      "calibration-samples",
      calibrationComplete ? "pass" : "incomplete",
      calibrationComplete,
      "校准报告必须绑定协议批准模型；样本与全部冻结 ranking decision 一对一、mediaKind/split 一致，且 correct 必须由 Top-1 是否命中 gold 重算"
    ),
    createCheck(
      "visual-fallback-samples",
      visualComplete ? "pass" : "incomplete",
      visualComplete,
      "必须提供冻结真实视觉回退排名与投影误差"
    ),
    createCheck(
      "degradation-samples",
      degradationComplete ? "pass" : "incomplete",
      degradationComplete,
      "必须提供冻结真实无法判断/冲突/PTS 风险的降级样本"
    ),
    createCheck(
      "performance-workload-manifest-binding",
      performanceWorkloadManifestBound ? "pass" : "incomplete",
      performanceRaw.schemaVersion === 2
        ? performanceRaw.runManifestDigest
        : "not-applicable-schema-v1",
      "raw v2 性能 evidence 的 runManifestDigest 必须与当前冻结验收 bundle.manifestDigest 完全一致，禁止跨工作负载复用性能证据"
    ),
    createCheck(
      "performance-measurements",
      performanceComplete ? "pass" : "incomplete",
      performanceComplete,
      "性能报告必须包含阶段耗时和取消响应原始测量"
    )
  ];
}

function matchesC137PerformanceEnvironment(
  environment: C137EnvironmentFingerprint,
  rawEvidence: C137PerformanceRawEvidenceV1 | C137PerformanceRawEvidenceV2
): boolean {
  const measured = rawEvidence.environment;
  return (
    environment.operatingSystem === measured.operatingSystem &&
    environment.operatingSystemVersion === measured.operatingSystemVersion &&
    environment.architecture === measured.architecture &&
    environment.cpuModel === measured.cpuModel &&
    environment.physicalCoreCount === measured.physicalCoreCount &&
    environment.logicalCoreCount === measured.logicalCoreCount &&
    environment.totalMemoryBytes === measured.totalMemoryBytes &&
    environment.storageScope === measured.storageScope &&
    environment.storageKind === measured.storageKind &&
    environment.powerProfile === measured.powerProfile &&
    environment.ffmpegVersion === measured.ffmpeg.version &&
    environment.ffmpegBinaryDigest === measured.ffmpeg.binaryDigest &&
    environment.ffprobeVersion === measured.ffprobe.version &&
    environment.ffprobeBinaryDigest === measured.ffprobe.binaryDigest
  );
}

function evaluateDatasetThresholds(report: C137DatasetReport): C137AcceptanceCheck[] {
  const cases = report.cases.filter((item) => item.mediaKind === "real");
  const frozen = cases.filter((item) => item.split === "frozen-test");
  const goldEditEventCount = sum(cases.map((item) => item.goldEditEventCount));
  const frozenEditEventCount = sum(frozen.map((item) => item.goldEditEventCount));
  const longReferenceCount = cases.filter((item) =>
    item.scenarios.includes("long-reference")
  ).length;
  const frozenRelationRatio = safeRatio(frozen.length, cases.length);
  const frozenEditEventRatio = safeRatio(frozenEditEventCount, goldEditEventCount);
  const reviewFailures = cases.filter(
    (item) => !item.independentlyReviewed || !item.adjudicationComplete
  ).length;
  return [
    thresholdCheck(
      "dataset-real-relations",
      cases.length >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumRealRelationCount,
      cases.length,
      `真实媒体关系数 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumRealRelationCount}`
    ),
    thresholdCheck(
      "dataset-long-references",
      longReferenceCount >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumLongReferenceRelationCount,
      longReferenceCount,
      `长参考关系数 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumLongReferenceRelationCount}`
    ),
    thresholdCheck(
      "dataset-gold-edit-events",
      goldEditEventCount >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumGoldEditEventCount,
      goldEditEventCount,
      `双人复核编辑事件数 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumGoldEditEventCount}`
    ),
    thresholdCheck(
      "dataset-frozen-relation-ratio",
      frozenRelationRatio >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumFrozenRelationRatio,
      frozenRelationRatio,
      `frozen-test 关系占比 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumFrozenRelationRatio}`
    ),
    thresholdCheck(
      "dataset-frozen-event-ratio",
      frozenEditEventRatio >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumFrozenEditEventRatio,
      frozenEditEventRatio,
      `frozen-test 编辑事件占比 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumFrozenEditEventRatio}`
    ),
    thresholdCheck(
      "dataset-independent-review",
      reviewFailures === 0,
      reviewFailures,
      "所有真实关系均完成双人独立复核与必要仲裁"
    )
  ];
}

function evaluateRelationshipThresholds(
  report: C137RelationshipRankingReport,
  protocol: C137AcceptanceProtocol
): C137AcceptanceCheck[] {
  const frozen = report.decisions.filter(isFrozenRealEvidence);
  const sameAudio = frozen.filter((item) => item.modality === "same-audio");
  const sameAudioTop1Correct = sameAudio.filter(
    (item) => item.rankedCandidateIds[0] === item.goldCandidateId
  ).length;
  const sameAudioTop1Accuracy = safeRatio(sameAudioTop1Correct, sameAudio.length);
  const verifiedWrongCount = frozen.filter(
    (item) =>
      item.verifiedCandidateId !== null && item.verifiedCandidateId !== item.goldCandidateId
  ).length;
  const topKReported = frozen.filter(
    (item) => item.rankedCandidateIds.length === protocol.topK
  ).length;
  const topKHitCount = frozen.filter((item) =>
    item.rankedCandidateIds.includes(item.goldCandidateId)
  ).length;
  return [
    thresholdCheck(
      "ranking-frozen-decisions",
      frozen.length >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumFrozenRelationshipDecisionCount,
      frozen.length,
      `frozen-test 关系判断数 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumFrozenRelationshipDecisionCount}`
    ),
    thresholdCheck(
      "ranking-same-audio-top1",
      sameAudio.length > 0 &&
        sameAudioTop1Accuracy >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumSameAudioTop1Accuracy,
      sameAudioTop1Accuracy,
      `同源音轨 Top-1 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumSameAudioTop1Accuracy}`
    ),
    thresholdCheck(
      "ranking-verified-wrong",
      verifiedWrongCount ===
        C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumVerifiedWrongRelationshipCount,
      verifiedWrongCount,
      `verified 错误关系数 = ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumVerifiedWrongRelationshipCount}`
    ),
    thresholdCheck(
      "ranking-top-k-reported",
      topKReported === frozen.length && frozen.length > 0,
      topKReported,
      `每个 frozen-test 判断必须恰好保存 ${protocol.topK} 个不重复的有序候选，以便报告协议锁定的 Top-K`
    ),
    thresholdCheck(
      "ranking-top-k-hit",
      topKHitCount === frozen.length && frozen.length > 0,
      topKHitCount,
      "每个 frozen-test 判断的正确关系都必须实际出现在协议锁定的 Top-K 中"
    )
  ];
}

function evaluateTimeMapThresholds(report: C137TimeMapReport): C137AcceptanceCheck[] {
  const frozenCases = report.cases.filter(isFrozenRealEvidence);
  const projectionErrors = frozenCases.flatMap((item) => item.matchedProjectionErrorsMs);
  const projectionP95 = percentile(projectionErrors, 0.95);
  const projectionP99 = percentile(projectionErrors, 0.99);
  const driftValues = frozenCases
    .filter((item) => item.scenarios.includes("time-stretch"))
    .map((item) => item.endDriftAt45MinutesMs)
    .filter((value): value is number => value !== null);
  const maximumDrift =
    driftValues.length > 0 ? Math.max(...driftValues) : Number.POSITIVE_INFINITY;
  const events = frozenCases
    .flatMap((item) => item.editDecisions)
    .filter((item) => item.durationMs >= 1_000);
  const overall = evaluateEditClassification(events);
  const paired = events.filter((item) => item.goldKind !== null && item.predictedKind !== null);
  const boundaryP95 = percentile(
    paired
      .map((item) => item.boundaryErrorMs)
      .filter((value): value is number => value !== null),
    0.95
  );
  const durationP95 = percentile(
    paired
      .map((item) => item.durationErrorMs)
      .filter((value): value is number => value !== null),
    0.95
  );
  const checks: C137AcceptanceCheck[] = [
    thresholdCheck(
      "time-map-projection-p95",
      projectionP95 !== null &&
        projectionP95 <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumMatchedProjectionP95Ms,
      projectionP95 ?? "missing",
      `matched 投影误差 p95 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumMatchedProjectionP95Ms}ms`
    ),
    thresholdCheck(
      "time-map-projection-p99",
      projectionP99 !== null &&
        projectionP99 <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumMatchedProjectionP99Ms,
      projectionP99 ?? "missing",
      `matched 投影误差 p99 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumMatchedProjectionP99Ms}ms`
    ),
    thresholdCheck(
      "time-map-end-drift-45m",
      maximumDrift <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumEndDriftAt45MinutesMs,
      Number.isFinite(maximumDrift) ? maximumDrift : "missing",
      `45 分钟 scale 片尾累计漂移 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumEndDriftAt45MinutesMs}ms`
    ),
    thresholdCheck(
      "time-map-edit-event-f1",
      events.length > 0 && overall.f1 >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumEditEventF1,
      overall.f1,
      `持续时间 ≥1 秒的编辑事件 F1 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumEditEventF1}`
    ),
    thresholdCheck(
      "time-map-boundary-p95",
      boundaryP95 !== null &&
        boundaryP95 <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumBoundaryErrorP95Ms,
      boundaryP95 ?? "missing",
      `编辑边界误差 p95 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumBoundaryErrorP95Ms}ms`
    ),
    thresholdCheck(
      "time-map-duration-p95",
      durationP95 !== null &&
        durationP95 <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumDurationErrorP95Ms,
      durationP95 ?? "missing",
      `编辑持续时长误差 p95 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumDurationErrorP95Ms}ms`
    )
  ];
  for (const kind of ["sourceOnly", "targetOnly", "replacement"] as const) {
    const metrics = evaluateEditClassificationByKind(events, kind);
    const sampleCount = events.filter(
      (item) => item.goldKind === kind || item.predictedKind === kind
    ).length;
    checks.push(
      thresholdCheck(
        `time-map-edit-class:${kind}`,
        sampleCount > 0 && metrics.f1 >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumPerEditClassF1,
        metrics.f1,
        `${kind} 分类 F1 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumPerEditClassF1}`
      )
    );
  }
  return checks;
}

function evaluateCalibrationThresholds(
  report: C137CalibrationReport,
  protocol: C137AcceptanceProtocol
): C137AcceptanceCheck[] {
  const samples = report.samples.filter(isFrozenRealEvidence);
  const ece = calculateEce(samples, protocol.calibrationBinCount);
  const brier =
    samples.length === 0
      ? Number.POSITIVE_INFINITY
      : sum(samples.map((item) => (item.probability - Number(item.correct)) ** 2)) /
        samples.length;
  const thresholds = protocol.calibrationThresholds;
  const maximumEce = thresholds.maximumEce ?? Number.NEGATIVE_INFINITY;
  const maximumBrier = thresholds.maximumBrierScore ?? Number.NEGATIVE_INFINITY;
  return [
    thresholdCheck(
      "calibration-ece",
      samples.length > 0 && ece <= maximumEce,
      Number.isFinite(ece) ? ece : "missing",
      `ECE ≤ ${thresholds.maximumEce ?? "unapproved"}`
    ),
    thresholdCheck(
      "calibration-brier",
      samples.length > 0 && brier <= maximumBrier,
      Number.isFinite(brier) ? brier : "missing",
      `Brier score ≤ ${thresholds.maximumBrierScore ?? "unapproved"}`
    )
  ];
}

function evaluateVisualFallbackThresholds(
  report: C137VisualFallbackReport
): C137AcceptanceCheck[] {
  const cases = report.cases.filter(isFrozenRealEvidence);
  const top1Correct = cases.filter(
    (item) => item.rankedCandidateIds[0] === item.goldCandidateId
  ).length;
  const top1Accuracy = safeRatio(top1Correct, cases.length);
  const projectionP95 = percentile(
    cases.flatMap((item) => item.projectionErrorsMs),
    0.95
  );
  const unsafeSparseVerifiedCount = cases.filter(
    (item) => item.sparseVisualAutomaticVerified
  ).length;
  return [
    thresholdCheck(
      "visual-fallback-top1",
      cases.length > 0 &&
        top1Accuracy >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumVisualFallbackTop1Accuracy,
      top1Accuracy,
      `独立视觉回退 Top-1 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumVisualFallbackTop1Accuracy}`
    ),
    thresholdCheck(
      "visual-fallback-projection-p95",
      projectionP95 !== null &&
        projectionP95 <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumVisualFallbackProjectionP95Ms,
      projectionP95 ?? "missing",
      `独立视觉回退投影误差 p95 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumVisualFallbackProjectionP95Ms}ms`
    ),
    thresholdCheck(
      "visual-fallback-no-sparse-auto-verify",
      unsafeSparseVerifiedCount === 0,
      unsafeSparseVerifiedCount,
      "仅靠稀疏视觉证据自动升级 verified 的数量必须为 0"
    )
  ];
}

function evaluateDegradationThresholds(report: C137DegradationReport): C137AcceptanceCheck[] {
  const cases = report.cases.filter(isFrozenRealEvidence);
  const unsafe = cases.filter(
    (item) =>
      item.actualLevel !== item.expectedLevel ||
      item.actualReasonCode !== item.expectedReasonCode
  ).length;
  return [
    thresholdCheck(
      "safe-degradation",
      cases.length > 0 &&
        unsafe === C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumUnsafeDegradationCount,
      unsafe,
      "无法判断、音画冲突、PTS 不可信和低覆盖样本必须按 gold 质量级别与原因降级"
    )
  ];
}

function evaluateNorthStarThresholds(report: C137NorthStarReport): C137AcceptanceCheck[] {
  const suites = report.suites.filter(isFrozenRealEvidence);
  const incorrectSuites = suites.filter(
    (item) =>
      item.expectedEpisodeCount !==
        C137_FIXED_ACCEPTANCE_THRESHOLDS.requiredCorrectEpisodesPerNorthStarSuite ||
      item.correctlyLocatedEpisodeCount !==
        C137_FIXED_ACCEPTANCE_THRESHOLDS.requiredCorrectEpisodesPerNorthStarSuite ||
      item.crossEpisodeMismatchCount !==
        C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumNorthStarCrossEpisodeMismatchCount ||
      !item.exportCompleted
  ).length;
  return [
    thresholdCheck(
      "north-star-suite-count",
      suites.length >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumNorthStarSuiteCount,
      suites.length,
      `北极星长合集套数 ≥ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumNorthStarSuiteCount}`
    ),
    thresholdCheck(
      "north-star-five-of-five",
      suites.length > 0 && incorrectSuites === 0,
      incorrectSuites,
      "每套北极星必须 5/5 定位正确、跨集错配为 0 且完成导出"
    )
  ];
}

function evaluatePerformanceThresholds(
  report: C137PerformanceReport,
  protocol: C137AcceptanceProtocol
): C137AcceptanceCheck[] {
  const rawSchemaVersion = readRuntimeIntegerField(report.rawEvidence, "schemaVersion");
  const requiredRawSchemaVersion = readRuntimeIntegerField(
    protocol,
    "requiredPerformanceRawSchemaVersion"
  );
  const formalRawSchemaMatches =
    requiredRawSchemaVersion === C137_FORMAL_PERFORMANCE_RAW_SCHEMA_VERSION &&
    rawSchemaVersion === requiredRawSchemaVersion;
  const validation = validateC137PerformanceEvidence(report.rawEvidence);
  const measuredRuns =
    report.rawEvidence.schemaVersion === 1
      ? getC137PerformanceMeasuredRuns(report.rawEvidence)
      : getC137PerformanceMeasuredRuns(report.rawEvidence);
  const coldRuns = measuredRuns.filter((item) => item.runKind === "cold");
  const hotRuns = measuredRuns.filter((item) => item.runKind === "hot");
  const coldElapsed = maximum(coldRuns.map((item) => item.elapsedMs));
  const hotElapsed = maximum(hotRuns.map((item) => item.elapsedMs));
  const peakValues = measuredRuns.map(getC137PerformancePeakRss);
  const peakRss = peakValues.every((item) => item !== null) ? maximum(peakValues) : null;
  const resultDigestCount = new Set(measuredRuns.map((item) => item.outputDigest)).size;
  const cancellations = report.rawEvidence.trials.filter(
    (trial) => trial.trialType === "cancellation"
  );
  const cancellationP95 = percentile(
    cancellations.map((trial) => trial.latencyMs),
    0.95
  );
  const maximumCancellationP95 =
    protocol.cancellationThreshold.maximumP95Ms ?? Number.NEGATIVE_INFINITY;
  const v2Evidence = report.rawEvidence.schemaVersion === 2 ? report.rawEvidence : null;
  const assurance = v2Evidence?.assurance ?? null;
  const workloadStorageReceiptComplete =
    formalRawSchemaMatches &&
    validation.valid &&
    v2Evidence !== null &&
    assurance !== null &&
    assurance.workloadStorageReceiptDigest ===
      v2Evidence.environment.workloadStorage.receiptDigest;
  const jobMemoryReceiptComplete =
    formalRawSchemaMatches &&
    validation.valid &&
    v2Evidence !== null &&
    v2Evidence.collector.terminalSessionStatus === "released" &&
    v2Evidence.collector.sampler === "windows-job-object-working-set-v1" &&
    v2Evidence.assurance.jobMemoryReceipt !== null;
  const terminalCleanupReceiptComplete =
    formalRawSchemaMatches &&
    validation.valid &&
    v2Evidence !== null &&
    v2Evidence.collector.terminalSessionStatus === "released" &&
    v2Evidence.assurance.terminalCleanupReceipt !== null;
  return [
    createCheck(
      "performance-formal-raw-schema-version",
      formalRawSchemaMatches ? "pass" : "incomplete",
      rawSchemaVersion ?? "missing",
      `正式性能验收只接受原生采集链生成的 raw evidence schemaVersion=${C137_FORMAL_PERFORMANCE_RAW_SCHEMA_VERSION}；v1 工程证据即使改写采样器、存储范围和自摘要也不得晋升`
    ),
    createCheck(
      "workload-storage-receipt",
      workloadStorageReceiptComplete ? "pass" : "incomplete",
      workloadStorageReceiptComplete
        ? (v2Evidence?.environment.workloadStorage.receiptDigest ?? "missing")
        : "missing-or-unbound",
      "正式性能验收必须有结构完整、经严格重算并绑定 run manifest/workload 的 path-free 工作负载存储 receipt；其原生来源真实性由独立 native attestation 与 authority 验证"
    ),
    createCheck(
      "job-memory-receipt",
      jobMemoryReceiptComplete ? "pass" : "incomplete",
      jobMemoryReceiptComplete
        ? (v2Evidence?.assurance.jobMemoryReceipt?.receiptDigest ?? "missing")
        : "missing-or-invalid",
      "正式性能验收必须有严格重算并绑定全部 native job 的 Job Object 成员采样、覆盖、峰值内存和终态进程树归零的 path-free receipt；其原生来源真实性仍由独立 attestation 与 authority 验证"
    ),
    createCheck(
      "terminal-cleanup-receipt",
      terminalCleanupReceiptComplete ? "pass" : "incomplete",
      terminalCleanupReceiptComplete
        ? (v2Evidence?.assurance.terminalCleanupReceipt?.receiptDigest ?? "missing")
        : "missing-or-invalid",
      "正式性能验收必须有严格重算并绑定全部 native job 终态、后代进程归零、监督器清理、工具/媒体复核、缓存清空和 released session 的 path-free terminal cleanup receipt；其原生来源真实性仍由独立 attestation 与 authority 验证"
    ),
    createCheck(
      "authenticode-artifact-attestation",
      "incomplete",
      "awaiting-external-authenticode-authority-v3",
      "外部 authority v3 必须对同一 bundle 独立复核 native EXE 全文件摘要、Windows Authenticode 信任、固定 signer 证书和时间戳证书"
    ),
    createCheck(
      "native-attestation",
      "incomplete",
      "awaiting-authority-v3-live-process-challenge",
      "raw v2 内部字段继续保持 null；正式放行还必须由 authority v3 验证进程内临时 Ed25519 challenge-response、Windows PID/启动时间/映像复核，以及全部 formal/performance 原生运行摘要库存"
    ),
    thresholdCheck(
      "performance-raw-evidence",
      validation.valid && validation.complete,
      validation.complete,
      "性能报告必须包含完整、严格校验的工程原始测量"
    ),
    thresholdCheck(
      "performance-plan-binding",
      report.rawEvidence.planDigest === protocol.performancePlanDigest,
      report.rawEvidence.planDigest,
      "性能 raw evidence 必须命中受信协议预注册的 plan digest"
    ),
    thresholdCheck(
      "performance-sampler-binding",
      report.rawEvidence.collector.sampler === protocol.requiredMemorySampler,
      report.rawEvidence.collector.sampler,
      `正式性能证据必须使用 ${protocol.requiredMemorySampler}`
    ),
    thresholdCheck(
      "performance-storage-scope-binding",
      report.rawEvidence.environment.storageScope === protocol.requiredStorageScope,
      report.rawEvidence.environment.storageScope,
      `正式性能环境必须测量 ${protocol.requiredStorageScope}`
    ),
    thresholdCheck(
      "performance-cold-run-count",
      coldRuns.length >= protocol.requiredColdRuns,
      coldRuns.length,
      `冷缓存重复次数 ≥ ${protocol.requiredColdRuns}`
    ),
    thresholdCheck(
      "performance-hot-run-count",
      hotRuns.length >= protocol.requiredHotRuns,
      hotRuns.length,
      `热缓存重复次数 ≥ ${protocol.requiredHotRuns}`
    ),
    thresholdCheck(
      "performance-cancellation-run-count",
      cancellations.length >= protocol.requiredCancellationRuns,
      cancellations.length,
      `取消探针次数 ≥ ${protocol.requiredCancellationRuns}`
    ),
    thresholdCheck(
      "performance-cold-elapsed",
      coldElapsed !== null &&
        coldElapsed <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumColdElapsedMs,
      coldElapsed ?? "missing",
      `冷缓存最大完成时间 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumColdElapsedMs}ms`
    ),
    thresholdCheck(
      "performance-hot-elapsed",
      hotElapsed !== null && hotElapsed <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumHotElapsedMs,
      hotElapsed ?? "missing",
      `热缓存最大完成时间 ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumHotElapsedMs}ms`
    ),
    thresholdCheck(
      "performance-peak-rss",
      peakRss !== null &&
        peakRss <= C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumPeakProcessTreeRssBytes,
      peakRss ?? "missing",
      `应用及 FFmpeg 子进程树峰值 RSS ≤ ${C137_FIXED_ACCEPTANCE_THRESHOLDS.maximumPeakProcessTreeRssBytes} bytes`
    ),
    thresholdCheck(
      "performance-cache-consistency",
      measuredRuns.length > 0 && resultDigestCount === 1,
      resultDigestCount,
      "冷/热缓存输出 digest 必须完全一致"
    ),
    thresholdCheck(
      "performance-cancellation-p95",
      cancellationP95 !== null && cancellationP95 <= maximumCancellationP95,
      cancellationP95 ?? "missing",
      `取消响应 p95 ≤ ${protocol.cancellationThreshold.maximumP95Ms ?? "unapproved"}ms`
    )
  ];
}

function evaluateUiAndReleaseThresholds(
  ui: C137UiWalkthroughReceipt,
  release: C137ReleaseVerificationReceipt,
  runner: C137RunnerFingerprint
): C137AcceptanceCheck[] {
  const uiPassed =
    ui.passed &&
    ui.completedSuiteCount >= C137_FIXED_ACCEPTANCE_THRESHOLDS.minimumNorthStarSuiteCount &&
    ui.buildDigest === runner.buildDigest;
  const releasePassed =
    release.sourceAuditPassed &&
    release.lintPassed &&
    release.frontendTestsPassed &&
    release.rustTestsPassed &&
    release.e2ePassed &&
    release.buildPassed &&
    release.tauriReleasePassed &&
    release.buildDigest === runner.buildDigest;
  return [
    thresholdCheck(
      "ui-north-star-walkthrough",
      uiPassed,
      uiPassed,
      "从空项目到至少 20 套北极星导出的 UI 走查必须绑定同一 release 构建并通过"
    ),
    thresholdCheck(
      "release-verification",
      releasePassed,
      releasePassed,
      "源码审计、lint、前端/Rust 测试、E2E、构建和 Tauri release 必须全部通过"
    )
  ];
}

interface ClassificationMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  f1: number;
}

type CompleteReports = {
  [Key in keyof C137AcceptanceReports]-?: NonNullable<C137AcceptanceReports[Key]>;
};

type CompleteReceipts = {
  datasetApproval: C137DatasetApprovalReceipt;
  preflight: C137PreflightReceipt;
  predictionRun: C137PredictionRunReceipt;
};

function requireCompleteReports(reports: C137AcceptanceReports): CompleteReports | null {
  if (REQUIRED_REPORT_KEYS.some((key) => reports[key] === null)) {
    return null;
  }
  return reports as CompleteReports;
}

function requireCompleteReceipts(
  receipts: C137AcceptanceBundle["receipts"]
): CompleteReceipts | null {
  if (
    receipts.datasetApproval === null ||
    receipts.preflight === null ||
    receipts.predictionRun === null
  ) {
    return null;
  }
  return receipts as CompleteReceipts;
}

function protocolIdentity(protocol: C137AcceptanceProtocol): string {
  return `${protocol.id}@${protocol.version}`;
}

function bindingMatchesBundle(
  binding: C137EvidenceBinding,
  bundle: C137AcceptanceBundle,
  approval: C137DatasetApprovalReceipt,
  prediction: C137PredictionRunReceipt
): boolean {
  return (
    binding.manifestDigest === bundle.manifestDigest &&
    binding.goldDigest === approval.goldDigest &&
    binding.datasetVersion === bundle.datasetVersion &&
    binding.predictionsDigest === prediction.predictionsDigest &&
    binding.protocolId === protocolIdentity(bundle.protocol) &&
    binding.environmentDigest === bundle.environment.digest &&
    binding.buildDigest === bundle.runner.buildDigest &&
    binding.engineVersion === bundle.runner.engineVersion &&
    binding.featureVersion === bundle.runner.featureVersion &&
    binding.parametersDigest === bundle.runner.parametersDigest
  );
}

function isApprovedCalibrationThreshold(value: C137CalibrationThresholdApproval): boolean {
  return (
    value.status === "approved" &&
    value.approvalId !== null &&
    value.maximumEce !== null &&
    value.maximumBrierScore !== null
  );
}

function isApprovedCalibrationModel(
  value: C137CalibrationModelApproval
): value is C137CalibrationModelApproval & {
  status: "approved";
  model: C137CalibrationModelV1;
} {
  return (
    value.status === "approved" &&
    value.approvalId !== null &&
    value.model !== null &&
    value.model.modelDigest === computeC137CalibrationModelDigest(value.model)
  );
}

function isApprovedCancellationThreshold(value: C137CancellationThresholdApproval): boolean {
  return (
    value.status === "approved" && value.approvalId !== null && value.maximumP95Ms !== null
  );
}

function isFrozenRealEvidence(value: {
  mediaKind: RealMediaBenchmarkMediaKind;
  split: C137DatasetSplit;
}): boolean {
  return value.mediaKind === "real" && value.split === "frozen-test";
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

function evaluateEditClassification(
  events: readonly C137EditDecisionEvidence[]
): ClassificationMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const event of events) {
    if (event.goldKind !== null && event.predictedKind !== null) {
      truePositive += 1;
    } else if (event.predictedKind !== null) {
      falsePositive += 1;
    } else if (event.goldKind !== null) {
      falseNegative += 1;
    }
  }
  return createClassificationMetrics(truePositive, falsePositive, falseNegative);
}

function evaluateEditClassificationByKind(
  events: readonly C137EditDecisionEvidence[],
  kind: C137EditKind
): ClassificationMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const event of events) {
    if (event.goldKind === kind && event.predictedKind === kind) {
      truePositive += 1;
    } else {
      if (event.predictedKind === kind) {
        falsePositive += 1;
      }
      if (event.goldKind === kind) {
        falseNegative += 1;
      }
    }
  }
  return createClassificationMetrics(truePositive, falsePositive, falseNegative);
}

function createClassificationMetrics(
  truePositive: number,
  falsePositive: number,
  falseNegative: number
): ClassificationMetrics {
  const precisionDenominator = truePositive + falsePositive;
  const recallDenominator = truePositive + falseNegative;
  const precision = precisionDenominator === 0 ? 0 : truePositive / precisionDenominator;
  const recall = recallDenominator === 0 ? 0 : truePositive / recallDenominator;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositive, falsePositive, falseNegative, f1 };
}

function calculateEce(samples: readonly C137CalibrationSample[], binCount: number): number {
  if (samples.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  let ece = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    const lower = bin / binCount;
    const upper = (bin + 1) / binCount;
    const inBin = samples.filter(
      (item) =>
        item.probability >= lower &&
        (bin === binCount - 1 ? item.probability <= upper : item.probability < upper)
    );
    if (inBin.length === 0) {
      continue;
    }
    const confidence = sum(inBin.map((item) => item.probability)) / inBin.length;
    const accuracy = sum(inBin.map((item) => Number(item.correct))) / inBin.length;
    ece += (inBin.length / samples.length) * Math.abs(accuracy - confidence);
  }
  return ece;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? null;
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function thresholdCheck(
  id: string,
  passed: boolean,
  actual: number | string | boolean,
  requirement: string
): C137AcceptanceCheck {
  return createCheck(id, passed ? "pass" : "fail", actual, requirement);
}

function createCheck(
  id: string,
  status: C137AcceptanceCheckStatus,
  actual: number | string | boolean,
  requirement: string
): C137AcceptanceCheck {
  return { id, status, actual, requirement };
}

function createAcceptanceGate(checks: C137AcceptanceCheck[]): C137AcceptanceGate {
  const incomplete = checks.filter((check) => check.status === "incomplete");
  const failed = checks.filter((check) => check.status === "fail");
  const status =
    incomplete.length > 0 ? "incomplete-evidence" : failed.length > 0 ? "fail" : "pass";
  const diagnostics = [...incomplete, ...failed];
  return {
    scope: "c137-release-acceptance",
    status,
    verifiedEligible: status === "pass",
    checks,
    reasons:
      status === "pass"
        ? ["完整 real-frozen C137 evidence、硬门槛、UI 与 release 验收均已通过。"]
        : diagnostics.map(
            (check) => `${check.id}：${check.requirement}（实际：${String(check.actual)}）。`
          )
  };
}

export function validateC137AcceptanceBundle(value: unknown): C137AcceptanceValidationResult {
  const issues: string[] = [];
  const bundle = strictRecord(
    value,
    "bundle",
    [
      "schemaVersion",
      "kind",
      "manifestDigest",
      "datasetVersion",
      "certificationClass",
      "protocol",
      "environment",
      "runner",
      "receipts",
      "formalEvidence",
      "reports"
    ],
    issues
  );
  if (bundle === null) {
    return { valid: false, issues };
  }
  requireLiteral(
    bundle.schemaVersion,
    C137_ACCEPTANCE_SCHEMA_VERSION,
    "bundle.schemaVersion",
    issues
  );
  requireLiteral(bundle.kind, "c137-acceptance-bundle", "bundle.kind", issues);
  requireDigest(bundle.manifestDigest, "bundle.manifestDigest", issues);
  requireString(bundle.datasetVersion, "bundle.datasetVersion", issues);
  requireOneOf(
    bundle.certificationClass,
    ["synthetic-smoke", "real-development", "real-frozen"],
    "bundle.certificationClass",
    issues
  );
  validateProtocol(bundle.protocol, issues);
  validateEnvironment(bundle.environment, issues);
  validateRunner(bundle.runner, issues);
  validateReceipts(bundle.receipts, issues);
  validateFormalEvidence(bundle.formalEvidence, issues);
  validateReports(bundle.reports, issues);
  validateRelationshipProtocolContract(bundle.protocol, bundle.reports, issues);
  return { valid: issues.length === 0, issues };
}

function validateFormalEvidence(value: unknown, issues: string[]): void {
  const record = strictRecord(value, "bundle.formalEvidence", ["blindRelationship"], issues);
  if (record === null || record.blindRelationship === null) {
    return;
  }
  const validation = validateC137FormalBlindProvenance(record.blindRelationship);
  if (!validation.valid) {
    for (const issue of validation.issues) {
      issues.push(`bundle.formalEvidence.blindRelationship: ${issue}`);
    }
  }
}

export function validateC137AcceptanceTrustContext(
  value: unknown
): C137AcceptanceValidationResult {
  const issues: string[] = [];
  const trust = strictRecord(
    value,
    "trustContext",
    ["trustedProtocolDigest", "trustedReceiptDigests", "trustedReportEvidenceDigests"],
    issues
  );
  if (trust === null) {
    return { valid: false, issues };
  }
  requireDigest(trust.trustedProtocolDigest, "trustContext.trustedProtocolDigest", issues);
  const receipts = strictRecord(
    trust.trustedReceiptDigests,
    "trustContext.trustedReceiptDigests",
    ["datasetApproval", "preflight", "predictionRun"],
    issues
  );
  if (receipts !== null) {
    requireDigest(
      receipts.datasetApproval,
      "trustContext.trustedReceiptDigests.datasetApproval",
      issues
    );
    requireDigest(receipts.preflight, "trustContext.trustedReceiptDigests.preflight", issues);
    requireDigest(
      receipts.predictionRun,
      "trustContext.trustedReceiptDigests.predictionRun",
      issues
    );
  }
  const reports = strictRecord(
    trust.trustedReportEvidenceDigests,
    "trustContext.trustedReportEvidenceDigests",
    REQUIRED_REPORT_KEYS,
    issues
  );
  if (reports !== null) {
    for (const key of REQUIRED_REPORT_KEYS) {
      requireDigest(reports[key], `trustContext.trustedReportEvidenceDigests.${key}`, issues);
    }
  }
  return { valid: issues.length === 0, issues };
}

function validateProtocol(value: unknown, issues: string[]): void {
  const record = strictRecord(
    value,
    "bundle.protocol",
    [
      "schemaVersion",
      "id",
      "version",
      "topK",
      "calibrationBinCount",
      "requiredColdRuns",
      "requiredHotRuns",
      "requiredCancellationRuns",
      "performancePlanDigest",
      "blindRankingPlanDigest",
      "requiredFormalBlindProvenanceSchemaVersion",
      "requiredBlindMatrixPlanSchemaVersion",
      "requiredBlindProjectionSchemaVersion",
      "requiredNativeEvidenceVersion",
      "requiredNativeReceiptSchemaVersion",
      "requiredBlindPairingMode",
      "requiredBlindScoreContract",
      "requiredBlindMatrixCoverage",
      "requiredBlindAggregation",
      "requiredPerformanceRawSchemaVersion",
      "maximumMemorySampleIntervalMs",
      "requiredMonotonicClock",
      "requiredMemorySampler",
      "requiredStorageScope",
      "performanceAggregation",
      "memoryScope",
      "coldCacheDefinition",
      "hotCacheDefinition",
      "targetEnvironmentDigest",
      "calibrationThresholds",
      "calibrationModel",
      "cancellationThreshold"
    ],
    issues
  );
  if (record === null) {
    return;
  }
  requireLiteral(
    record.schemaVersion,
    C137_ACCEPTANCE_PROTOCOL_SCHEMA_VERSION,
    "bundle.protocol.schemaVersion",
    issues
  );
  requireString(record.id, "bundle.protocol.id", issues);
  requireLiteral(record.version, "8", "bundle.protocol.version", issues);
  requirePositiveInteger(record.topK, "bundle.protocol.topK", issues);
  if (
    Number.isSafeInteger(record.topK) &&
    ((record.topK as number) < 2 || (record.topK as number) > 20)
  ) {
    issues.push("bundle.protocol.topK 必须位于 2..20，与 formal blind 协议一致。");
  }
  requirePositiveInteger(
    record.calibrationBinCount,
    "bundle.protocol.calibrationBinCount",
    issues
  );
  requirePositiveInteger(record.requiredColdRuns, "bundle.protocol.requiredColdRuns", issues);
  requirePositiveInteger(record.requiredHotRuns, "bundle.protocol.requiredHotRuns", issues);
  requirePositiveInteger(
    record.requiredCancellationRuns,
    "bundle.protocol.requiredCancellationRuns",
    issues
  );
  requireDigest(record.performancePlanDigest, "bundle.protocol.performancePlanDigest", issues);
  requireDigest(
    record.blindRankingPlanDigest,
    "bundle.protocol.blindRankingPlanDigest",
    issues
  );
  requireLiteral(
    record.requiredFormalBlindProvenanceSchemaVersion,
    C137_FORMAL_BLIND_PROVENANCE_SCHEMA_VERSION,
    "bundle.protocol.requiredFormalBlindProvenanceSchemaVersion",
    issues
  );
  requireLiteral(
    record.requiredBlindMatrixPlanSchemaVersion,
    C137_FORMAL_BLIND_MATRIX_PLAN_SCHEMA_VERSION,
    "bundle.protocol.requiredBlindMatrixPlanSchemaVersion",
    issues
  );
  requireLiteral(
    record.requiredBlindProjectionSchemaVersion,
    1,
    "bundle.protocol.requiredBlindProjectionSchemaVersion",
    issues
  );
  requireLiteral(
    record.requiredNativeEvidenceVersion,
    REAL_MEDIA_BLIND_BATCH_NATIVE_EVIDENCE_VERSION,
    "bundle.protocol.requiredNativeEvidenceVersion",
    issues
  );
  requireLiteral(
    record.requiredNativeReceiptSchemaVersion,
    REAL_MEDIA_BLIND_BATCH_RECEIPT_SCHEMA_VERSION,
    "bundle.protocol.requiredNativeReceiptSchemaVersion",
    issues
  );
  requireLiteral(
    record.requiredBlindPairingMode,
    "fullCartesian",
    "bundle.protocol.requiredBlindPairingMode",
    issues
  );
  requireLiteral(
    record.requiredBlindScoreContract,
    C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
    "bundle.protocol.requiredBlindScoreContract",
    issues
  );
  requireLiteral(
    record.requiredBlindMatrixCoverage,
    C137_FORMAL_BLIND_MATRIX_COVERAGE,
    "bundle.protocol.requiredBlindMatrixCoverage",
    issues
  );
  requireLiteral(
    record.requiredBlindAggregation,
    C137_BLIND_GLOBAL_AGGREGATION_CONTRACT,
    "bundle.protocol.requiredBlindAggregation",
    issues
  );
  requireLiteral(
    record.requiredPerformanceRawSchemaVersion,
    C137_FORMAL_PERFORMANCE_RAW_SCHEMA_VERSION,
    "bundle.protocol.requiredPerformanceRawSchemaVersion",
    issues
  );
  requirePositiveInteger(
    record.maximumMemorySampleIntervalMs,
    "bundle.protocol.maximumMemorySampleIntervalMs",
    issues
  );
  requireLiteral(
    record.requiredMonotonicClock,
    "rust-std-instant-session-relative-v1",
    "bundle.protocol.requiredMonotonicClock",
    issues
  );
  requireLiteral(
    record.requiredMemorySampler,
    "windows-job-object-working-set-v1",
    "bundle.protocol.requiredMemorySampler",
    issues
  );
  requireLiteral(
    record.requiredStorageScope,
    "workload-media-volumes",
    "bundle.protocol.requiredStorageScope",
    issues
  );
  requireLiteral(
    record.performanceAggregation,
    "maximum",
    "bundle.protocol.performanceAggregation",
    issues
  );
  requireLiteral(
    record.memoryScope,
    "application-process-tree",
    "bundle.protocol.memoryScope",
    issues
  );
  requireLiteral(
    record.coldCacheDefinition,
    "empty-application-feature-cache",
    "bundle.protocol.coldCacheDefinition",
    issues
  );
  requireLiteral(
    record.hotCacheDefinition,
    "same-process-after-complete-warmup",
    "bundle.protocol.hotCacheDefinition",
    issues
  );
  requireDigest(
    record.targetEnvironmentDigest,
    "bundle.protocol.targetEnvironmentDigest",
    issues
  );
  validateCalibrationThresholdApproval(record.calibrationThresholds, issues);
  validateCalibrationModelApproval(record.calibrationModel, issues);
  validateCancellationThresholdApproval(record.cancellationThreshold, issues);
}

function validateCalibrationThresholdApproval(value: unknown, issues: string[]): void {
  const path = "bundle.protocol.calibrationThresholds";
  const record = strictRecord(
    value,
    path,
    ["status", "approvalId", "maximumEce", "maximumBrierScore"],
    issues
  );
  if (record === null) {
    return;
  }
  requireOneOf(record.status, ["pending", "approved"], `${path}.status`, issues);
  requireNullableString(record.approvalId, `${path}.approvalId`, issues);
  requireNullableUnitNumber(record.maximumEce, `${path}.maximumEce`, issues);
  requireNullableUnitNumber(record.maximumBrierScore, `${path}.maximumBrierScore`, issues);
  if (record.status === "pending") {
    if (
      record.approvalId !== null ||
      record.maximumEce !== null ||
      record.maximumBrierScore !== null
    ) {
      issues.push(`${path} pending 状态不得携带伪批准阈值。`);
    }
  } else if (
    !isNonEmptyString(record.approvalId) ||
    !isUnitNumber(record.maximumEce) ||
    !isUnitNumber(record.maximumBrierScore)
  ) {
    issues.push(`${path} approved 状态必须包含 approvalId、maximumEce 和 maximumBrierScore。`);
  }
}

function validateCalibrationModelApproval(value: unknown, issues: string[]): void {
  const path = "bundle.protocol.calibrationModel";
  const record = strictRecord(value, path, ["status", "approvalId", "model"], issues);
  if (record === null) {
    return;
  }
  requireOneOf(record.status, ["pending", "approved"], `${path}.status`, issues);
  requireNullableString(record.approvalId, `${path}.approvalId`, issues);
  if (record.status === "pending") {
    if (record.approvalId !== null || record.model !== null) {
      issues.push(`${path} pending 状态不得携带 approvalId 或模型。`);
    }
    return;
  }
  if (!isNonEmptyString(record.approvalId) || record.model === null) {
    issues.push(`${path} approved 状态必须包含 approvalId 与模型。`);
    return;
  }
  validateC137CalibrationModelValue(record.model, `${path}.model`, issues);
}

function validateC137CalibrationModelValue(
  value: unknown,
  path: string,
  issues: string[]
): void {
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "kind",
      "modelId",
      "featureContract",
      "sourceScoreContract",
      "calibrationSplit",
      "calibrationDatasetVersion",
      "calibrationDatasetDigest",
      "points",
      "modelDigest"
    ],
    issues
  );
  if (record === null) {
    return;
  }
  requireLiteral(
    record.schemaVersion,
    C137_CALIBRATION_MODEL_SCHEMA_VERSION,
    `${path}.schemaVersion`,
    issues
  );
  requireLiteral(record.kind, "c137-native-score-calibration-model", `${path}.kind`, issues);
  requireString(record.modelId, `${path}.modelId`, issues);
  requireLiteral(
    record.featureContract,
    C137_FORMAL_BLIND_CALIBRATION_FEATURE_CONTRACT,
    `${path}.featureContract`,
    issues
  );
  requireLiteral(
    record.sourceScoreContract,
    C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
    `${path}.sourceScoreContract`,
    issues
  );
  requireLiteral(record.calibrationSplit, "calibration", `${path}.calibrationSplit`, issues);
  requireString(record.calibrationDatasetVersion, `${path}.calibrationDatasetVersion`, issues);
  requireDigest(record.calibrationDatasetDigest, `${path}.calibrationDatasetDigest`, issues);
  requireDigest(record.modelDigest, `${path}.modelDigest`, issues);
  validateArray(record.points, `${path}.points`, issues, (point, pointPath) => {
    const pointRecord = strictRecord(point, pointPath, ["scoreMargin", "probability"], issues);
    if (pointRecord === null) {
      return;
    }
    requireUnitNumber(pointRecord.scoreMargin, `${pointPath}.scoreMargin`, issues);
    requireUnitNumber(pointRecord.probability, `${pointPath}.probability`, issues);
  });
  if (Array.isArray(record.points)) {
    if (record.points.length < 2 || record.points.length > 64) {
      issues.push(`${path}.points 必须包含 2..64 个控制点。`);
    }
    const points = record.points.filter(
      (point): point is C137CalibrationCurvePoint =>
        isRecord(point) && isUnitNumber(point.scoreMargin) && isUnitNumber(point.probability)
    );
    if (points.length === record.points.length && points.length >= 2) {
      if (points[0]?.scoreMargin !== 0 || points[points.length - 1]?.scoreMargin !== 1) {
        issues.push(`${path}.points 必须从 scoreMargin=0 覆盖到 1。`);
      }
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (previous === undefined || current === undefined) {
          continue;
        }
        if (current.scoreMargin <= previous.scoreMargin) {
          issues.push(`${path}.points scoreMargin 必须严格递增。`);
          break;
        }
        if (current.probability < previous.probability) {
          issues.push(`${path}.points probability 必须单调不减。`);
          break;
        }
      }
    }
  }
  try {
    if (
      typeof record.modelDigest === "string" &&
      record.modelDigest !==
        computeC137CalibrationModelDigest(record as unknown as C137CalibrationModelV1)
    ) {
      issues.push(`${path}.modelDigest 与模型内容不一致。`);
    }
  } catch {
    issues.push(`${path}.modelDigest 无法从模型内容唯一重算。`);
  }
}

function validateCancellationThresholdApproval(value: unknown, issues: string[]): void {
  const path = "bundle.protocol.cancellationThreshold";
  const record = strictRecord(value, path, ["status", "approvalId", "maximumP95Ms"], issues);
  if (record === null) {
    return;
  }
  requireOneOf(record.status, ["pending", "approved"], `${path}.status`, issues);
  requireNullableString(record.approvalId, `${path}.approvalId`, issues);
  requireNullableNonNegativeInteger(record.maximumP95Ms, `${path}.maximumP95Ms`, issues);
  if (record.status === "pending") {
    if (record.approvalId !== null || record.maximumP95Ms !== null) {
      issues.push(`${path} pending 状态不得携带伪批准阈值。`);
    }
  } else if (
    !isNonEmptyString(record.approvalId) ||
    !isNonNegativeInteger(record.maximumP95Ms)
  ) {
    issues.push(`${path} approved 状态必须包含 approvalId 和 maximumP95Ms。`);
  }
}

function validateEnvironment(value: unknown, issues: string[]): void {
  const path = "bundle.environment";
  const issueCountBefore = issues.length;
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "digest",
      "operatingSystem",
      "operatingSystemVersion",
      "architecture",
      "cpuModel",
      "physicalCoreCount",
      "logicalCoreCount",
      "totalMemoryBytes",
      "storageScope",
      "storageKind",
      "powerProfile",
      "ffmpegVersion",
      "ffmpegBinaryDigest",
      "ffprobeVersion",
      "ffprobeBinaryDigest"
    ],
    issues
  );
  if (record === null) {
    return;
  }
  requireLiteral(record.schemaVersion, 2, `${path}.schemaVersion`, issues);
  requireDigest(record.digest, `${path}.digest`, issues);
  for (const key of [
    "operatingSystem",
    "operatingSystemVersion",
    "architecture",
    "cpuModel",
    "storageKind",
    "powerProfile",
    "ffmpegVersion",
    "ffprobeVersion"
  ]) {
    requireString(record[key], `${path}.${key}`, issues);
  }
  requirePositiveInteger(record.physicalCoreCount, `${path}.physicalCoreCount`, issues);
  requirePositiveInteger(record.logicalCoreCount, `${path}.logicalCoreCount`, issues);
  requirePositiveInteger(record.totalMemoryBytes, `${path}.totalMemoryBytes`, issues);
  requireOneOf(
    record.storageScope,
    ["system-volume", "workload-media-volumes"],
    `${path}.storageScope`,
    issues
  );
  requireDigest(record.ffmpegBinaryDigest, `${path}.ffmpegBinaryDigest`, issues);
  requireDigest(record.ffprobeBinaryDigest, `${path}.ffprobeBinaryDigest`, issues);
  if (issues.length === issueCountBefore) {
    const environment = record as unknown as C137EnvironmentFingerprint;
    if (environment.digest !== computeC137EnvironmentDigest(environment)) {
      issues.push(`${path}.digest 与硬件及工具链字段的规范摘要不一致。`);
    }
  }
}

function validateRunner(value: unknown, issues: string[]): void {
  const path = "bundle.runner";
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "appVersion",
      "gitCommit",
      "buildProfile",
      "buildDigest",
      "engineVersion",
      "featureVersion",
      "parametersDigest"
    ],
    issues
  );
  if (record === null) {
    return;
  }
  requireLiteral(record.schemaVersion, 1, `${path}.schemaVersion`, issues);
  requireString(record.appVersion, `${path}.appVersion`, issues);
  requireString(record.gitCommit, `${path}.gitCommit`, issues);
  requireOneOf(record.buildProfile, ["debug", "release"], `${path}.buildProfile`, issues);
  requireDigest(record.buildDigest, `${path}.buildDigest`, issues);
  requireString(record.engineVersion, `${path}.engineVersion`, issues);
  requireString(record.featureVersion, `${path}.featureVersion`, issues);
  requireDigest(record.parametersDigest, `${path}.parametersDigest`, issues);
}

function validateReceipts(value: unknown, issues: string[]): void {
  const path = "bundle.receipts";
  const record = strictRecord(
    value,
    path,
    ["datasetApproval", "preflight", "predictionRun"],
    issues
  );
  if (record === null) {
    return;
  }
  if (record.datasetApproval !== null) {
    validateDatasetApprovalReceipt(record.datasetApproval, issues);
  }
  if (record.preflight !== null) {
    validatePreflightReceipt(record.preflight, issues);
  }
  if (record.predictionRun !== null) {
    validatePredictionRunReceipt(record.predictionRun, issues);
  }
}

function validateDatasetApprovalReceipt(value: unknown, issues: string[]): void {
  const path = "bundle.receipts.datasetApproval";
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "receiptId",
      "manifestDigest",
      "goldDigest",
      "datasetVersion",
      "certificationClass",
      "licenseReviewComplete",
      "independentReviewComplete",
      "frozenGoldSealed",
      "approvedAt"
    ],
    issues
  );
  if (record === null) return;
  requireLiteral(
    record.schemaVersion,
    C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    `${path}.schemaVersion`,
    issues
  );
  requireString(record.receiptId, `${path}.receiptId`, issues);
  requireDigest(record.manifestDigest, `${path}.manifestDigest`, issues);
  requireDigest(record.goldDigest, `${path}.goldDigest`, issues);
  requireString(record.datasetVersion, `${path}.datasetVersion`, issues);
  requireOneOf(
    record.certificationClass,
    ["synthetic-smoke", "real-development", "real-frozen"],
    `${path}.certificationClass`,
    issues
  );
  requireBoolean(record.licenseReviewComplete, `${path}.licenseReviewComplete`, issues);
  requireBoolean(record.independentReviewComplete, `${path}.independentReviewComplete`, issues);
  requireBoolean(record.frozenGoldSealed, `${path}.frozenGoldSealed`, issues);
  requireTimestamp(record.approvedAt, `${path}.approvedAt`, issues);
}

function validatePreflightReceipt(value: unknown, issues: string[]): void {
  const path = "bundle.receipts.preflight";
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "receiptId",
      "manifestDigest",
      "datasetVersion",
      "mediaBindingsDigest",
      "ok",
      "realRelationCount",
      "checkedFileCount",
      "completedAt"
    ],
    issues
  );
  if (record === null) return;
  requireLiteral(
    record.schemaVersion,
    C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    `${path}.schemaVersion`,
    issues
  );
  requireString(record.receiptId, `${path}.receiptId`, issues);
  requireDigest(record.manifestDigest, `${path}.manifestDigest`, issues);
  requireString(record.datasetVersion, `${path}.datasetVersion`, issues);
  requireDigest(record.mediaBindingsDigest, `${path}.mediaBindingsDigest`, issues);
  requireBoolean(record.ok, `${path}.ok`, issues);
  requireNonNegativeInteger(record.realRelationCount, `${path}.realRelationCount`, issues);
  requireNonNegativeInteger(record.checkedFileCount, `${path}.checkedFileCount`, issues);
  requireTimestamp(record.completedAt, `${path}.completedAt`, issues);
}

function validatePredictionRunReceipt(value: unknown, issues: string[]): void {
  const path = "bundle.receipts.predictionRun";
  const record = strictRecord(
    value,
    path,
    [
      "schemaVersion",
      "receiptId",
      "manifestDigest",
      "datasetVersion",
      "predictionsDigest",
      "protocolId",
      "environmentDigest",
      "buildDigest",
      "engineVersion",
      "featureVersion",
      "parametersDigest",
      "completedAt"
    ],
    issues
  );
  if (record === null) return;
  requireLiteral(
    record.schemaVersion,
    C137_ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    `${path}.schemaVersion`,
    issues
  );
  requireString(record.receiptId, `${path}.receiptId`, issues);
  requireDigest(record.manifestDigest, `${path}.manifestDigest`, issues);
  requireString(record.datasetVersion, `${path}.datasetVersion`, issues);
  requireDigest(record.predictionsDigest, `${path}.predictionsDigest`, issues);
  requireString(record.protocolId, `${path}.protocolId`, issues);
  requireDigest(record.environmentDigest, `${path}.environmentDigest`, issues);
  requireDigest(record.buildDigest, `${path}.buildDigest`, issues);
  requireString(record.engineVersion, `${path}.engineVersion`, issues);
  requireString(record.featureVersion, `${path}.featureVersion`, issues);
  requireDigest(record.parametersDigest, `${path}.parametersDigest`, issues);
  requireTimestamp(record.completedAt, `${path}.completedAt`, issues);
}

function validateReports(value: unknown, issues: string[]): void {
  const path = "bundle.reports";
  const record = strictRecord(value, path, REQUIRED_REPORT_KEYS, issues);
  if (record === null) return;
  validateNullableReport(record.dataset, validateDatasetReport, issues);
  validateNullableReport(record.relationshipRanking, validateRelationshipRankingReport, issues);
  validateNullableReport(record.timeMap, validateTimeMapReport, issues);
  validateNullableReport(record.calibration, validateCalibrationReport, issues);
  validateNullableReport(record.visualFallback, validateVisualFallbackReport, issues);
  validateNullableReport(record.degradation, validateDegradationReport, issues);
  validateNullableReport(record.northStar, validateNorthStarReport, issues);
  validateNullableReport(record.performance, validatePerformanceReport, issues);
  validateNullableReport(record.uiWalkthrough, validateUiWalkthroughReceipt, issues);
  validateNullableReport(
    record.releaseVerification,
    validateReleaseVerificationReceipt,
    issues
  );
}

function validateNullableReport(
  value: unknown,
  validator: (report: unknown, issues: string[]) => void,
  issues: string[]
): void {
  if (value !== null) {
    validator(value, issues);
  }
}

function validateDatasetReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.dataset";
  const record = validateReportHeader(value, path, ["cases"], issues);
  if (record === null) return;
  validateArray(record.cases, `${path}.cases`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "caseId",
        "mediaKind",
        "split",
        "scenarios",
        "goldEditEventCount",
        "independentlyReviewed",
        "adjudicationComplete"
      ],
      issues
    );
    if (entry === null) return;
    requireString(entry.caseId, `${itemPath}.caseId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    validateScenarios(entry.scenarios, `${itemPath}.scenarios`, issues);
    requireNonNegativeInteger(
      entry.goldEditEventCount,
      `${itemPath}.goldEditEventCount`,
      issues
    );
    requireBoolean(entry.independentlyReviewed, `${itemPath}.independentlyReviewed`, issues);
    requireBoolean(entry.adjudicationComplete, `${itemPath}.adjudicationComplete`, issues);
  });
  validateUniqueStringField(record.cases, "caseId", `${path}.cases`, issues);
}

function validateRelationshipRankingReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.relationshipRanking";
  const record = validateReportHeader(
    value,
    path,
    ["rankingScope", "scoreContract", "globalTopK", "decisions"],
    issues,
    C137_RELATIONSHIP_RANKING_REPORT_SCHEMA_VERSION
  );
  if (record === null) return;
  requireLiteral(
    record.rankingScope,
    C137_RELATIONSHIP_RANKING_SCOPE,
    `${path}.rankingScope`,
    issues
  );
  requireLiteral(
    record.scoreContract,
    C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
    `${path}.scoreContract`,
    issues
  );
  requirePositiveInteger(record.globalTopK, `${path}.globalTopK`, issues);
  if (
    Number.isSafeInteger(record.globalTopK) &&
    ((record.globalTopK as number) < 2 || (record.globalTopK as number) > 20)
  ) {
    issues.push(`${path}.globalTopK 必须位于 2..20。`);
  }
  validateArray(record.decisions, `${path}.decisions`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "decisionId",
        "provenanceRef",
        "caseId",
        "mediaKind",
        "split",
        "modality",
        "goldCandidateId",
        "rankedCandidateIds",
        "verifiedCandidateId"
      ],
      issues
    );
    if (entry === null) return;
    requireDigest(entry.decisionId, `${itemPath}.decisionId`, issues);
    requireDigest(entry.provenanceRef, `${itemPath}.provenanceRef`, issues);
    if (
      typeof entry.decisionId === "string" &&
      typeof entry.provenanceRef === "string" &&
      entry.decisionId !== entry.provenanceRef
    ) {
      issues.push(`${itemPath}.decisionId 必须等于 provenanceRef。`);
    }
    requireString(entry.caseId, `${itemPath}.caseId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    requireOneOf(
      entry.modality,
      ["same-audio", "visual-only", "mixed", "no-common-content"],
      `${itemPath}.modality`,
      issues
    );
    requireDigest(entry.goldCandidateId, `${itemPath}.goldCandidateId`, issues);
    validateDigestArray(
      entry.rankedCandidateIds,
      `${itemPath}.rankedCandidateIds`,
      issues,
      true
    );
    if (entry.verifiedCandidateId !== null) {
      issues.push(`${itemPath}.verifiedCandidateId 必须为 null。`);
    }
    if (
      Number.isSafeInteger(record.globalTopK) &&
      Array.isArray(entry.rankedCandidateIds) &&
      entry.rankedCandidateIds.length !== record.globalTopK
    ) {
      issues.push(
        `${itemPath}.rankedCandidateIds 必须恰好包含 report.globalTopK=${String(record.globalTopK)} 个候选。`
      );
    }
  });
  validateUniqueStringField(record.decisions, "decisionId", `${path}.decisions`, issues);
  validateUniqueStringField(record.decisions, "provenanceRef", `${path}.decisions`, issues);
}

function validateRelationshipProtocolContract(
  protocol: unknown,
  reports: unknown,
  issues: string[]
): void {
  if (!isRecord(protocol) || !isRecord(reports)) return;
  const report = reports.relationshipRanking;
  if (report === null || !isRecord(report)) return;
  if (
    Number.isSafeInteger(protocol.topK) &&
    Number.isSafeInteger(report.globalTopK) &&
    report.globalTopK !== protocol.topK
  ) {
    issues.push(
      "bundle.reports.relationshipRanking.globalTopK 必须精确等于 bundle.protocol.topK。"
    );
  }
}

function validateTimeMapReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.timeMap";
  const record = validateReportHeader(value, path, ["cases"], issues);
  if (record === null) return;
  validateArray(record.cases, `${path}.cases`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "caseId",
        "mediaKind",
        "split",
        "scenarios",
        "matchedProjectionErrorsMs",
        "endDriftAt45MinutesMs",
        "editDecisions"
      ],
      issues
    );
    if (entry === null) return;
    requireString(entry.caseId, `${itemPath}.caseId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    validateScenarios(entry.scenarios, `${itemPath}.scenarios`, issues);
    validateNumberArray(
      entry.matchedProjectionErrorsMs,
      `${itemPath}.matchedProjectionErrorsMs`,
      issues
    );
    requireNullableNonNegativeInteger(
      entry.endDriftAt45MinutesMs,
      `${itemPath}.endDriftAt45MinutesMs`,
      issues
    );
    validateArray(
      entry.editDecisions,
      `${itemPath}.editDecisions`,
      issues,
      (event, eventPath) => {
        const decision = strictRecord(
          event,
          eventPath,
          [
            "eventId",
            "goldKind",
            "predictedKind",
            "durationMs",
            "boundaryErrorMs",
            "durationErrorMs"
          ],
          issues
        );
        if (decision === null) return;
        requireString(decision.eventId, `${eventPath}.eventId`, issues);
        validateNullableEditKind(decision.goldKind, `${eventPath}.goldKind`, issues);
        validateNullableEditKind(decision.predictedKind, `${eventPath}.predictedKind`, issues);
        if (decision.goldKind === null && decision.predictedKind === null) {
          issues.push(`${eventPath} goldKind 与 predictedKind 不能同时为 null。`);
        }
        requireNonNegativeInteger(decision.durationMs, `${eventPath}.durationMs`, issues);
        requireNullableNonNegativeInteger(
          decision.boundaryErrorMs,
          `${eventPath}.boundaryErrorMs`,
          issues
        );
        requireNullableNonNegativeInteger(
          decision.durationErrorMs,
          `${eventPath}.durationErrorMs`,
          issues
        );
      }
    );
    validateUniqueStringField(
      entry.editDecisions,
      "eventId",
      `${itemPath}.editDecisions`,
      issues
    );
  });
  validateUniqueStringField(record.cases, "caseId", `${path}.cases`, issues);
}

function validateCalibrationReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.calibration";
  const record = validateReportHeader(
    value,
    path,
    ["modelDigest", "samples"],
    issues,
    C137_CALIBRATION_REPORT_SCHEMA_VERSION
  );
  if (record === null) return;
  requireDigest(record.modelDigest, `${path}.modelDigest`, issues);
  validateArray(record.samples, `${path}.samples`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "decisionId",
        "mediaKind",
        "split",
        "top1Score",
        "top2Score",
        "scoreMargin",
        "probability",
        "correct"
      ],
      issues
    );
    if (entry === null) return;
    requireString(entry.decisionId, `${itemPath}.decisionId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    requireFiniteNumber(entry.top1Score, `${itemPath}.top1Score`, issues);
    requireFiniteNumber(entry.top2Score, `${itemPath}.top2Score`, issues);
    if (
      typeof entry.top1Score === "number" &&
      Number.isFinite(entry.top1Score) &&
      typeof entry.top2Score === "number" &&
      Number.isFinite(entry.top2Score) &&
      entry.top2Score > entry.top1Score
    ) {
      issues.push(`${itemPath}.top2Score 不得高于 top1Score。`);
    }
    requireUnitNumber(entry.scoreMargin, `${itemPath}.scoreMargin`, issues);
    requireUnitNumber(entry.probability, `${itemPath}.probability`, issues);
    requireBoolean(entry.correct, `${itemPath}.correct`, issues);
  });
  validateUniqueStringField(record.samples, "decisionId", `${path}.samples`, issues);
}

function validateVisualFallbackReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.visualFallback";
  const record = validateReportHeader(value, path, ["cases"], issues);
  if (record === null) return;
  validateArray(record.cases, `${path}.cases`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "caseId",
        "mediaKind",
        "split",
        "goldCandidateId",
        "rankedCandidateIds",
        "projectionErrorsMs",
        "sparseVisualAutomaticVerified"
      ],
      issues
    );
    if (entry === null) return;
    requireString(entry.caseId, `${itemPath}.caseId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    requireString(entry.goldCandidateId, `${itemPath}.goldCandidateId`, issues);
    validateStringArray(
      entry.rankedCandidateIds,
      `${itemPath}.rankedCandidateIds`,
      issues,
      true
    );
    validateNumberArray(entry.projectionErrorsMs, `${itemPath}.projectionErrorsMs`, issues);
    requireBoolean(
      entry.sparseVisualAutomaticVerified,
      `${itemPath}.sparseVisualAutomaticVerified`,
      issues
    );
  });
  validateUniqueStringField(record.cases, "caseId", `${path}.cases`, issues);
}

function validateDegradationReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.degradation";
  const record = validateReportHeader(value, path, ["cases"], issues);
  if (record === null) return;
  validateArray(record.cases, `${path}.cases`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "caseId",
        "mediaKind",
        "split",
        "expectedLevel",
        "actualLevel",
        "expectedReasonCode",
        "actualReasonCode"
      ],
      issues
    );
    if (entry === null) return;
    requireString(entry.caseId, `${itemPath}.caseId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    validateQualityLevel(entry.expectedLevel, `${itemPath}.expectedLevel`, issues);
    validateQualityLevel(entry.actualLevel, `${itemPath}.actualLevel`, issues);
    requireString(entry.expectedReasonCode, `${itemPath}.expectedReasonCode`, issues);
    requireString(entry.actualReasonCode, `${itemPath}.actualReasonCode`, issues);
  });
  validateUniqueStringField(record.cases, "caseId", `${path}.cases`, issues);
}

function validateNorthStarReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.northStar";
  const record = validateReportHeader(value, path, ["suites"], issues);
  if (record === null) return;
  validateArray(record.suites, `${path}.suites`, issues, (item, itemPath) => {
    const entry = strictRecord(
      item,
      itemPath,
      [
        "suiteId",
        "mediaKind",
        "split",
        "expectedEpisodeCount",
        "correctlyLocatedEpisodeCount",
        "crossEpisodeMismatchCount",
        "exportCompleted"
      ],
      issues
    );
    if (entry === null) return;
    requireString(entry.suiteId, `${itemPath}.suiteId`, issues);
    validateMediaKind(entry.mediaKind, `${itemPath}.mediaKind`, issues);
    validateSplit(entry.split, `${itemPath}.split`, issues);
    requireNonNegativeInteger(
      entry.expectedEpisodeCount,
      `${itemPath}.expectedEpisodeCount`,
      issues
    );
    requireNonNegativeInteger(
      entry.correctlyLocatedEpisodeCount,
      `${itemPath}.correctlyLocatedEpisodeCount`,
      issues
    );
    requireNonNegativeInteger(
      entry.crossEpisodeMismatchCount,
      `${itemPath}.crossEpisodeMismatchCount`,
      issues
    );
    requireBoolean(entry.exportCompleted, `${itemPath}.exportCompleted`, issues);
  });
  validateUniqueStringField(record.suites, "suiteId", `${path}.suites`, issues);
}

function validatePerformanceReport(value: unknown, issues: string[]): void {
  const path = "bundle.reports.performance";
  const record = strictRecord(value, path, ["schemaVersion", "binding", "rawEvidence"], issues);
  if (record === null) return;
  requireLiteral(
    record.schemaVersion,
    C137_PERFORMANCE_ACCEPTANCE_REPORT_SCHEMA_VERSION,
    `${path}.schemaVersion`,
    issues
  );
  validateEvidenceBinding(record.binding, `${path}.binding`, issues);
  const validation = validateC137PerformanceEvidence(record.rawEvidence);
  if (!validation.valid) {
    for (const issue of validation.issues) {
      issues.push(`${path}.rawEvidence：${issue}`);
    }
  }
}

function validateUiWalkthroughReceipt(value: unknown, issues: string[]): void {
  const path = "bundle.reports.uiWalkthrough";
  const record = validateReportHeader(
    value,
    path,
    ["passed", "completedSuiteCount", "buildDigest", "completedAt"],
    issues
  );
  if (record === null) return;
  requireBoolean(record.passed, `${path}.passed`, issues);
  requireNonNegativeInteger(record.completedSuiteCount, `${path}.completedSuiteCount`, issues);
  requireDigest(record.buildDigest, `${path}.buildDigest`, issues);
  requireTimestamp(record.completedAt, `${path}.completedAt`, issues);
}

function validateReleaseVerificationReceipt(value: unknown, issues: string[]): void {
  const path = "bundle.reports.releaseVerification";
  const record = validateReportHeader(
    value,
    path,
    [
      "sourceAuditPassed",
      "lintPassed",
      "frontendTestsPassed",
      "rustTestsPassed",
      "e2ePassed",
      "buildPassed",
      "tauriReleasePassed",
      "buildDigest",
      "completedAt"
    ],
    issues
  );
  if (record === null) return;
  for (const key of [
    "sourceAuditPassed",
    "lintPassed",
    "frontendTestsPassed",
    "rustTestsPassed",
    "e2ePassed",
    "buildPassed",
    "tauriReleasePassed"
  ]) {
    requireBoolean(record[key], `${path}.${key}`, issues);
  }
  requireDigest(record.buildDigest, `${path}.buildDigest`, issues);
  requireTimestamp(record.completedAt, `${path}.completedAt`, issues);
}

function validateReportHeader(
  value: unknown,
  path: string,
  additionalKeys: readonly string[],
  issues: string[],
  schemaVersion: number = C137_ACCEPTANCE_REPORT_SCHEMA_VERSION
): Record<string, unknown> | null {
  const record = strictRecord(
    value,
    path,
    ["schemaVersion", "binding", ...additionalKeys],
    issues
  );
  if (record === null) return null;
  requireLiteral(record.schemaVersion, schemaVersion, `${path}.schemaVersion`, issues);
  validateEvidenceBinding(record.binding, `${path}.binding`, issues);
  return record;
}

function validateEvidenceBinding(value: unknown, path: string, issues: string[]): void {
  const record = strictRecord(
    value,
    path,
    [
      "manifestDigest",
      "goldDigest",
      "datasetVersion",
      "predictionsDigest",
      "protocolId",
      "environmentDigest",
      "buildDigest",
      "engineVersion",
      "featureVersion",
      "parametersDigest",
      "evidenceDigest"
    ],
    issues
  );
  if (record === null) return;
  requireDigest(record.manifestDigest, `${path}.manifestDigest`, issues);
  requireDigest(record.goldDigest, `${path}.goldDigest`, issues);
  requireString(record.datasetVersion, `${path}.datasetVersion`, issues);
  requireDigest(record.predictionsDigest, `${path}.predictionsDigest`, issues);
  requireString(record.protocolId, `${path}.protocolId`, issues);
  requireDigest(record.environmentDigest, `${path}.environmentDigest`, issues);
  requireDigest(record.buildDigest, `${path}.buildDigest`, issues);
  requireString(record.engineVersion, `${path}.engineVersion`, issues);
  requireString(record.featureVersion, `${path}.featureVersion`, issues);
  requireDigest(record.parametersDigest, `${path}.parametersDigest`, issues);
  requireDigest(record.evidenceDigest, `${path}.evidenceDigest`, issues);
}

const ALL_SCENARIOS = new Set<RealMediaBenchmarkScenario>([
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

function validateScenarios(value: unknown, path: string, issues: string[]): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item) =>
        typeof item === "string" && ALL_SCENARIOS.has(item as RealMediaBenchmarkScenario)
    ) ||
    new Set(value).size !== value.length
  ) {
    issues.push(`${path} 必须是非空、不重复的已知场景数组。`);
  }
}

function validateMediaKind(value: unknown, path: string, issues: string[]): void {
  requireOneOf(value, ["real", "synthetic", "placeholder"], path, issues);
}

function validateSplit(value: unknown, path: string, issues: string[]): void {
  requireOneOf(value, ["development", "calibration", "frozen-test"], path, issues);
}

function validateNullableEditKind(value: unknown, path: string, issues: string[]): void {
  if (value !== null) {
    requireOneOf(value, ["sourceOnly", "targetOnly", "replacement"], path, issues);
  }
}

function validateQualityLevel(value: unknown, path: string, issues: string[]): void {
  requireOneOf(value, ["verified", "review", "blocked", "legacy-unverified"], path, issues);
}

function validateArray(
  value: unknown,
  path: string,
  issues: string[],
  validateItem: (item: unknown, itemPath: string) => void
): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是数组。`);
    return;
  }
  value.forEach((item, index) => validateItem(item, `${path}[${index}]`));
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: string[],
  requireNonEmpty: boolean
): void {
  if (
    !Array.isArray(value) ||
    (requireNonEmpty && value.length === 0) ||
    !value.every(isNonEmptyString) ||
    new Set(value).size !== value.length
  ) {
    issues.push(`${path} 必须是${requireNonEmpty ? "非空、" : ""}不重复的非空字符串数组。`);
  }
}

function validateDigestArray(
  value: unknown,
  path: string,
  issues: string[],
  requireNonEmpty: boolean
): void {
  if (
    !Array.isArray(value) ||
    (requireNonEmpty && value.length === 0) ||
    !value.every((item) => typeof item === "string" && SHA256_DIGEST.test(item)) ||
    new Set(value).size !== value.length
  ) {
    issues.push(`${path} 必须是${requireNonEmpty ? "非空、" : ""}不重复的规范 SHA-256 数组。`);
  }
}

function validateNumberArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || !value.every(isNonNegativeInteger)) {
    issues.push(`${path} 必须是非负整数数组。`);
  }
}

function validateUniqueStringField(
  value: unknown,
  field: string,
  path: string,
  issues: string[]
): void {
  if (!Array.isArray(value)) return;
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item) || !isNonEmptyString(item[field])) return;
    const key = item[field];
    if (seen.has(key)) {
      issues.push(`${path}[${index}].${field} 与其他项重复。`);
    }
    seen.add(key);
  });
}

function strictRecord(
  value: unknown,
  path: string,
  expectedKeys: readonly (string | number | symbol)[],
  issues: string[]
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.push(`${path} 必须是对象。`);
    return null;
  }
  const keys = expectedKeys.map(String);
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issues.push(`${path}.${key} 缺失。`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      issues.push(`${path}.${key} 是未知字段；验收 evidence 使用严格 schema。`);
    }
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("C137 canonical JSON 不接受非有限数值。");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("C137 canonical JSON 不接受 undefined、函数或 symbol。");
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function requireDigest(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    issues.push(`${path} 必须是小写 sha256:<64 hex>。`);
  }
}

function requireString(value: unknown, path: string, issues: string[]): void {
  if (!isNonEmptyString(value)) {
    issues.push(`${path} 必须是非空字符串。`);
  }
}

function requireNullableString(value: unknown, path: string, issues: string[]): void {
  if (value !== null && !isNonEmptyString(value)) {
    issues.push(`${path} 必须是 null 或非空字符串。`);
  }
}

function requireBoolean(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "boolean") {
    issues.push(`${path} 必须是布尔值。`);
  }
}

function requireLiteral(
  value: unknown,
  expected: string | number,
  path: string,
  issues: string[]
): void {
  if (value !== expected) {
    issues.push(`${path} 必须为 ${String(expected)}。`);
  }
}

function requireOneOf(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: string[]
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issues.push(`${path} 必须为 ${allowed.join(" / ")}。`);
  }
}

function requirePositiveInteger(value: unknown, path: string, issues: string[]): void {
  if (!isNonNegativeInteger(value) || value === 0) {
    issues.push(`${path} 必须是正整数。`);
  }
}

function requireNonNegativeInteger(value: unknown, path: string, issues: string[]): void {
  if (!isNonNegativeInteger(value)) {
    issues.push(`${path} 必须是非负整数。`);
  }
}

function requireNullableNonNegativeInteger(
  value: unknown,
  path: string,
  issues: string[]
): void {
  if (value !== null && !isNonNegativeInteger(value)) {
    issues.push(`${path} 必须是 null 或非负整数。`);
  }
}

function requireFiniteNumber(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path} 必须是有限数字。`);
  }
}

function requireUnitNumber(value: unknown, path: string, issues: string[]): void {
  if (!isUnitNumber(value)) {
    issues.push(`${path} 必须是 0–1 的有限数字。`);
  }
}

function requireNullableUnitNumber(value: unknown, path: string, issues: string[]): void {
  if (value !== null && !isUnitNumber(value)) {
    issues.push(`${path} 必须是 null 或 0–1 的有限数字。`);
  }
}

function requireTimestamp(value: unknown, path: string, issues: string[]): void {
  if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
    issues.push(`${path} 必须是可解析的 ISO 时间。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRuntimeIntegerField(value: unknown, field: string): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const fieldValue = value[field];
  return isNonNegativeInteger(fieldValue) ? fieldValue : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
