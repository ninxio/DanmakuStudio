import type {
  AlignmentReviewAction,
  AlignmentReviewDecision,
  AlignmentReviewFeatureSnapshot,
  AlignmentReviewPrecision,
  AlignmentReviewRecord,
  EditorProject,
  MediaContentIdentity,
  MediaTimeMap
} from "../project/types";
import { sha256Hex } from "../shared/sha256";
import { isCompleteTimeMapSpanEvidence, type TimeMapSpan } from "./timeMap";
import {
  assessAlignmentAdjudication,
  buildAlignmentMediaFamilyAssignments,
  type AlignmentMediaFamilyAssignment
} from "./alignmentAdjudication";

export interface AlignmentReviewRecordInput {
  timeMapId: string;
  spanIndex: number;
  decision: AlignmentReviewDecision;
  precision: AlignmentReviewPrecision;
  action: AlignmentReviewAction;
  reviewedAt: string;
  labeledRange?: {
    sourceStartMs: number;
    sourceEndMs: number;
    targetStartMs: number;
    targetEndMs: number;
  };
  boundaryToleranceMs?: number | null;
}

export interface AlignmentTrainingDatasetExport {
  manifest: {
    schemaVersion: "alignment-training-export-v2";
    datasetId: string;
    projectIdDigest: string;
    createdAt: string;
    activeRecordCount: number;
    weakLabelCount: number;
    supervisedLabelCount: number;
    unresolvedCount: number;
    activeVoteCount: number;
    goldLabelCount: number;
    conflictCount: number;
    pendingIndependentCount: number;
    mediaFamilyCount: number;
    splitCounts: Record<"development" | "calibration" | "frozen-test", number>;
    note: string;
  };
  samples: AlignmentConfidenceSampleV2[];
}

export interface AlignmentConfidenceSampleV2 {
  schemaVersion: "alignment-confidence-sample-v2";
  datasetId: string;
  sampleId: string;
  mediaGroupId: string;
  split: "development" | "calibration" | "frozen-test";
  labelSource:
    | "manualRough"
    | "manualPlaybackChecked"
    | "manualFrameAccurate"
    | "adjudicatedGold";
  trainingUse: "weakOnly" | "supervised" | "frozenEvaluation";
  proposalCorrect: boolean | null;
  decision: AlignmentReviewDecision;
  boundaryToleranceMs: number | null;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  features: AlignmentReviewFeatureSnapshot;
}

/**
 * 把人工动作发生前的算法证据冻结进项目。updatedProject 必须是已经完成领域改写的结果；
 * 记录从 originalProject 取证，避免拿到被人工操作清空后的逐段指标。
 */
export function appendAlignmentReviewRecord(
  originalProject: EditorProject,
  updatedProject: EditorProject,
  input: AlignmentReviewRecordInput
): EditorProject {
  const timeMap = originalProject.mediaTimeMaps.find((item) => item.id === input.timeMapId);
  const span = timeMap?.spans[input.spanIndex];
  const candidate = originalProject.mediaMatchCandidates.find(
    (item) => item.timeMapId === input.timeMapId
  );
  if (!timeMap || !span || !candidate) {
    return updatedProject;
  }
  const spanId = span.id ?? `${timeMap.id}:span:${input.spanIndex}`;
  const prior = [...originalProject.alignmentReviewRecords]
    .reverse()
    .find(
      (record) =>
        record.timeMapId === timeMap.id &&
        record.spanId === spanId &&
        record.recordState === "active"
    );
  const labeledRange = input.labeledRange ?? span;
  const recordId = `alignment-review:${sha256Hex(
    JSON.stringify([
      timeMap.id,
      timeMap.revision,
      spanId,
      input.decision,
      input.precision,
      input.reviewedAt,
      labeledRange
    ])
  )}`;
  const record: AlignmentReviewRecord = {
    recordVersion: 1,
    id: recordId,
    timeMapId: timeMap.id,
    timeMapRevision: timeMap.revision,
    spanId,
    spanIndex: input.spanIndex,
    sourceMediaId: timeMap.sourceMediaId,
    targetMediaId: timeMap.targetMediaId,
    mediaGroupId: createMediaGroupId(timeMap),
    action: input.action,
    decision: input.decision,
    precision: input.precision,
    algorithmPrediction: span.kind,
    sourceStartMs: labeledRange.sourceStartMs,
    sourceEndMs: labeledRange.sourceEndMs,
    targetStartMs: labeledRange.targetStartMs,
    targetEndMs: labeledRange.targetEndMs,
    boundaryToleranceMs: normalizeBoundaryTolerance(input.boundaryToleranceMs),
    features: createFeatureSnapshot(timeMap, span, candidate.proposal.evidenceProfile),
    engineVersion: timeMap.engineVersion,
    featureVersion: timeMap.featureVersion,
    parametersHash: timeMap.parametersHash,
    supersedesRecordId: prior?.id ?? null,
    recordState: "active",
    reviewedAt: input.reviewedAt
  };
  const records = originalProject.alignmentReviewRecords.map((item) =>
    prior && item.id === prior.id ? { ...item, recordState: "superseded" as const } : item
  );
  return {
    ...updatedProject,
    alignmentReviewRecords: [...records, record]
  };
}

export function buildAlignmentTrainingDatasetExport(
  project: EditorProject,
  createdAt = new Date().toISOString()
): AlignmentTrainingDatasetExport {
  const active = project.alignmentReviewRecords.filter(
    (record) => record.recordState === "active"
  );
  const datasetId = `dataset:${sha256Hex(
    JSON.stringify([
      project.id,
      active.map((record) => record.id).sort(),
      project.alignmentReviewVotes
        .filter((vote) => vote.voteState === "active")
        .map((vote) => vote.id)
        .sort()
    ])
  )}`;
  const familyAssignments = buildAlignmentMediaFamilyAssignments(project, active);
  const samples = active.map((record) =>
    toConfidenceSample(
      record,
      datasetId,
      familyAssignments.get(record.id) ?? {
        mediaGroupId: record.mediaGroupId,
        split: "development"
      },
      assessAlignmentAdjudication(project, record.id)
    )
  );
  const weakLabelCount = samples.filter((sample) => sample.trainingUse === "weakOnly").length;
  const supervisedLabelCount = samples.filter(
    (sample) => sample.trainingUse !== "weakOnly"
  ).length;
  const statuses = active.map((record) => assessAlignmentAdjudication(project, record.id));
  const splitCounts = {
    development: samples.filter((sample) => sample.split === "development").length,
    calibration: samples.filter((sample) => sample.split === "calibration").length,
    "frozen-test": samples.filter((sample) => sample.split === "frozen-test").length
  };
  return {
    manifest: {
      schemaVersion: "alignment-training-export-v2",
      datasetId,
      projectIdDigest: `sha256:${sha256Hex(project.id)}`,
      createdAt,
      activeRecordCount: active.length,
      weakLabelCount,
      supervisedLabelCount,
      unresolvedCount: samples.filter((sample) => sample.proposalCorrect === null).length,
      activeVoteCount: project.alignmentReviewVotes.filter(
        (vote) => vote.voteState === "active"
      ).length,
      goldLabelCount: statuses.filter((status) => status.state === "gold").length,
      conflictCount: statuses.filter((status) => status.state === "conflict").length,
      pendingIndependentCount: statuses.filter(
        (status) => status.state === "awaiting-independent"
      ).length,
      mediaFamilyCount: new Set(
        [...familyAssignments.values()].map((assignment) => assignment.mediaGroupId)
      ).size,
      splitCounts,
      note:
        "单人粗略/播放复核记录仅为 weakOnly；两名不同复核者一致或冲突后第三人仲裁才形成 Gold。同一媒体连接分量固定进入同一 split。"
    },
    samples
  };
}

export function serializeAlignmentTrainingDataset(
  dataset: AlignmentTrainingDatasetExport
): { manifestJson: string; samplesJsonl: string } {
  return {
    manifestJson: `${JSON.stringify(dataset.manifest, null, 2)}\n`,
    samplesJsonl:
      dataset.samples.length === 0
        ? ""
        : `${dataset.samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`
  };
}

function toConfidenceSample(
  record: AlignmentReviewRecord,
  datasetId: string,
  family: AlignmentMediaFamilyAssignment,
  adjudication: ReturnType<typeof assessAlignmentAdjudication>
): AlignmentConfidenceSampleV2 {
  const isGold = adjudication.state === "gold" && adjudication.decision !== null;
  const labelSource = isGold
    ? "adjudicatedGold"
    : record.precision === "rough"
      ? "manualRough"
      : record.precision === "playbackChecked"
        ? "manualPlaybackChecked"
        : record.precision === "frameAccurate"
          ? "manualFrameAccurate"
          : "manualFrameAccurate";
  const decision: AlignmentReviewDecision =
    isGold && adjudication.decision ? adjudication.decision : record.decision;
  const expectedKind = decisionToKind(decision);
  const trainingUse = isGold
    ? family.split === "frozen-test"
      ? "frozenEvaluation"
      : "supervised"
    : "weakOnly";
  return {
    schemaVersion: "alignment-confidence-sample-v2",
    datasetId,
    sampleId: isGold
      ? `${record.id}:gold:${sha256Hex(
          JSON.stringify(adjudication.activeVotes.map((vote) => vote.id).sort())
        )}`
      : record.id,
    mediaGroupId: family.mediaGroupId,
    split: family.split,
    labelSource,
    trainingUse,
    proposalCorrect: expectedKind === null ? null : expectedKind === record.algorithmPrediction,
    decision,
    boundaryToleranceMs: isGold
      ? adjudication.boundaryToleranceMs
      : record.boundaryToleranceMs,
    engineVersion: record.engineVersion,
    featureVersion: record.featureVersion,
    parametersHash: record.parametersHash,
    features: record.features
  };
}

function createFeatureSnapshot(
  timeMap: MediaTimeMap,
  span: TimeMapSpan,
  profile: EditorProject["mediaMatchCandidates"][number]["proposal"]["evidenceProfile"]
): AlignmentReviewFeatureSnapshot {
  const quality = isCompleteTimeMapSpanEvidence(span) ? span.quality : null;
  const samples = profile?.samples.filter((sample) => overlapsSpan(sample, span)) ?? [];
  const visualSamples = samples.filter((sample) => sample.visualRecoveryState !== undefined);
  return {
    sourceCoverage: finiteOrNull(quality?.coverage ?? timeMap.quality.coverage),
    uniqueContentCoverage: finiteOrNull(
      quality?.uniqueContentCoverage ?? timeMap.quality.uniqueContentCoverage ?? null
    ),
    anchorCount: finiteOrNull(quality?.anchorCount ?? timeMap.quality.anchorCount),
    heldOutAnchorCount: finiteOrNull(
      quality?.heldOutAnchorCount ?? timeMap.quality.heldOutAnchorCount
    ),
    anchorRegionCount: finiteOrNull(timeMap.quality.anchorRegionCount ?? null),
    p95ResidualMs: finiteOrNull(quality?.p95ResidualMs ?? timeMap.quality.p95ResidualMs),
    p99ResidualMs: finiteOrNull(quality?.p99ResidualMs ?? timeMap.quality.p99ResidualMs ?? null),
    maxResidualMs: finiteOrNull(quality?.maxResidualMs ?? timeMap.quality.maxResidualMs),
    boundaryUncertaintyMs: finiteOrNull(
      quality?.boundaryUncertaintyMs ?? timeMap.quality.boundaryUncertaintyMs
    ),
    alternativeMargin: finiteOrNull(
      quality?.alternativeMargin ?? timeMap.quality.alternativeMargin
    ),
    ambiguousRatio: ratio(
      samples.filter(
        (sample) =>
          sample.dominantState === "uncertain" ||
          sample.state === "conflicting" ||
          sample.state === "noEvidence"
      ).length,
      samples.length
    ),
    bidirectionalAgreement: null,
    differenceRiskP50: quantile(samples.map((sample) => sample.differenceRisk), 0.5),
    differenceRiskP90: quantile(samples.map((sample) => sample.differenceRisk), 0.9),
    differenceRiskP99: quantile(samples.map((sample) => sample.differenceRisk), 0.99),
    informativenessP50: quantile(samples.map((sample) => sample.informativeness), 0.5),
    visualRecoveredRatio: ratio(
      visualSamples.filter((sample) => sample.visualRecoveryState === "recovered").length,
      visualSamples.length
    ),
    visualAmbiguousRatio: ratio(
      visualSamples.filter((sample) => sample.visualRecoveryState === "ambiguous").length,
      visualSamples.length
    ),
    visualMarginP50: quantile(visualSamples.map((sample) => sample.visualMargin), 0.5)
  };
}

function createMediaGroupId(timeMap: MediaTimeMap): string {
  const payload = [
    contentIdentityKey(timeMap.sourceIdentity) ?? ["project-media-id", timeMap.sourceMediaId],
    contentIdentityKey(timeMap.targetIdentity) ?? ["project-media-id", timeMap.targetMediaId]
  ];
  return `media-group:${sha256Hex(JSON.stringify(payload))}`;
}

function contentIdentityKey(identity: MediaContentIdentity | null): unknown {
  return identity
    ? [
        identity.algorithm,
        identity.sizeBytes,
        identity.firstSampleDigest,
        identity.middleSampleDigest,
        identity.lastSampleDigest
      ]
    : null;
}

function overlapsSpan(
  sample: NonNullable<
    EditorProject["mediaMatchCandidates"][number]["proposal"]["evidenceProfile"]
  >["samples"][number],
  span: TimeMapSpan
): boolean {
  const start = sample.axis === "source" ? span.sourceStartMs : span.targetStartMs;
  const end = sample.axis === "source" ? span.sourceEndMs : span.targetEndMs;
  return sample.endMs > start && sample.startMs < end;
}

function decisionToKind(decision: AlignmentReviewDecision): TimeMapSpan["kind"] | null {
  if (decision === "source-extra") return "sourceOnly";
  if (decision === "target-extra") return "targetOnly";
  if (decision === "replacement") return "ambiguous";
  return null;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeBoundaryTolerance(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function quantile(values: Array<number | undefined>, fraction: number): number | null {
  const finite = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = Math.min(finite.length - 1, Math.max(0, Math.round((finite.length - 1) * fraction)));
  return finite[index] ?? null;
}
