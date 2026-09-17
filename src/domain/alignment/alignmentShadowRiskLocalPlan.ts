import {
  createAlignmentReviewRecordEvidenceDigestForProject,
  createAlignmentShadowRiskAssociationManifest
} from "./alignmentShadowRiskOverlay";
import {
  areMediaContentIdentitiesEqual,
  MEDIA_CONTENT_IDENTITY_ALGORITHM
} from "../project/mediaIdentity";
import type {
  AlignmentReviewRecord,
  EditorProject,
  MediaTimeMap,
  ProjectMediaReference
} from "../project/types";
import { sha256Hex } from "../shared/sha256";

const PLAN_DIGEST_DOMAIN = "danmaku-studio/alignment-shadow-risk-local-plan/v1";
const MEDIA_KEY_DOMAIN = "danmaku-studio/alignment-shadow-risk-local-media/v1";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type AlignmentShadowRiskLocalPlanSkipCode =
  | "missing-current-time-map"
  | "missing-local-media"
  | "missing-full-file-identity"
  | "missing-audio-stream"
  | "invalid-media-duration"
  | "invalid-record-range";

export interface AlignmentShadowRiskLocalPlanMedia {
  mediaKey: string;
  mediaId: string;
  path: string;
  contentDigest: string;
  sizeBytes: number;
  durationMs: number;
  audioStreamIndex: number;
}

export interface AlignmentShadowRiskLocalPlanRecord {
  recordId: string;
  recordEvidenceDigest: string;
  timeMapId: string;
  timeMapRevision: number;
  sourceMediaId: string;
  targetMediaId: string;
  sourceMediaKey: string;
  targetMediaKey: string;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
}

export interface AlignmentShadowRiskLocalPlan {
  schemaVersion: "alignment-shadow-risk-local-plan-v1";
  associationManifestId: string;
  projectIdDigest: string;
  featureRecipeVersion: "rule-audio-local-support-risk-v1";
  createdAt: string;
  containsSensitiveLocalPaths: true;
  permission: "local-offline-shadow-scoring-only";
  releaseEligible: false;
  media: AlignmentShadowRiskLocalPlanMedia[];
  records: AlignmentShadowRiskLocalPlanRecord[];
  planId: string;
}

export interface AlignmentShadowRiskLocalPlanBuildResult {
  plan: AlignmentShadowRiskLocalPlan | null;
  eligibleRecordCount: number;
  skippedRecordCount: number;
  skippedByReason: Record<AlignmentShadowRiskLocalPlanSkipCode, number>;
}

export function buildAlignmentShadowRiskLocalPlan(
  project: Pick<
    EditorProject,
    "id" | "mediaLibrary" | "mediaTimeMaps" | "alignmentReviewRecords"
  >,
  createdAt = new Date().toISOString()
): AlignmentShadowRiskLocalPlanBuildResult {
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("本机算分计划的创建时间无效。");
  }
  const association = createAlignmentShadowRiskAssociationManifest(project);
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const timeMapsById = new Map(project.mediaTimeMaps.map((timeMap) => [timeMap.id, timeMap]));
  const plannedMedia = new Map<string, AlignmentShadowRiskLocalPlanMedia>();
  const records: AlignmentShadowRiskLocalPlanRecord[] = [];
  const skippedByReason = createEmptySkipCounts();

  for (const record of [...project.alignmentReviewRecords]
    .filter((item) => item.recordState === "active")
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const timeMap = timeMapsById.get(record.timeMapId);
    if (!isCurrentTimeMapForRecord(timeMap, record)) {
      skippedByReason["missing-current-time-map"] += 1;
      continue;
    }
    const source = mediaById.get(record.sourceMediaId);
    const target = mediaById.get(record.targetMediaId);
    if (!hasLocalPath(source) || !hasLocalPath(target)) {
      skippedByReason["missing-local-media"] += 1;
      continue;
    }
    if (
      !hasMatchingFullFileIdentity(source, timeMap.sourceIdentity) ||
      !hasMatchingFullFileIdentity(target, timeMap.targetIdentity)
    ) {
      skippedByReason["missing-full-file-identity"] += 1;
      continue;
    }
    if (!isAudioStreamIndex(timeMap.sourceStream) || !isAudioStreamIndex(timeMap.targetStream)) {
      skippedByReason["missing-audio-stream"] += 1;
      continue;
    }
    if (!isPositiveSafeInteger(source.durationMs) || !isPositiveSafeInteger(target.durationMs)) {
      skippedByReason["invalid-media-duration"] += 1;
      continue;
    }
    if (!hasValidRanges(record, source.durationMs, target.durationMs)) {
      skippedByReason["invalid-record-range"] += 1;
      continue;
    }

    const plannedSource = toPlannedMedia(
      source,
      source.durationMs,
      timeMap.sourceStream.index
    );
    const plannedTarget = toPlannedMedia(
      target,
      target.durationMs,
      timeMap.targetStream.index
    );
    plannedMedia.set(plannedSource.mediaKey, plannedSource);
    plannedMedia.set(plannedTarget.mediaKey, plannedTarget);
    records.push({
      recordId: record.id,
      recordEvidenceDigest: createAlignmentReviewRecordEvidenceDigestForProject(project, record),
      timeMapId: record.timeMapId,
      timeMapRevision: record.timeMapRevision,
      sourceMediaId: record.sourceMediaId,
      targetMediaId: record.targetMediaId,
      sourceMediaKey: plannedSource.mediaKey,
      targetMediaKey: plannedTarget.mediaKey,
      sourceStartMs: record.sourceStartMs,
      sourceEndMs: record.sourceEndMs,
      targetStartMs: record.targetStartMs,
      targetEndMs: record.targetEndMs
    });
  }

  const skippedRecordCount = Object.values(skippedByReason).reduce((sum, count) => sum + count, 0);
  if (records.length === 0) {
    return { plan: null, eligibleRecordCount: 0, skippedRecordCount, skippedByReason };
  }
  const body = {
    schemaVersion: "alignment-shadow-risk-local-plan-v1" as const,
    associationManifestId: association.manifestId,
    projectIdDigest: association.projectIdDigest,
    featureRecipeVersion: "rule-audio-local-support-risk-v1" as const,
    createdAt,
    containsSensitiveLocalPaths: true as const,
    permission: "local-offline-shadow-scoring-only" as const,
    releaseEligible: false as const,
    media: [...plannedMedia.values()].sort((left, right) => left.mediaKey.localeCompare(right.mediaKey)),
    records
  };
  return {
    plan: { ...body, planId: domainDigest(PLAN_DIGEST_DOMAIN, body) },
    eligibleRecordCount: records.length,
    skippedRecordCount,
    skippedByReason
  };
}

export function serializeAlignmentShadowRiskLocalPlan(plan: AlignmentShadowRiskLocalPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function isCurrentTimeMapForRecord(
  timeMap: MediaTimeMap | undefined,
  record: AlignmentReviewRecord
): timeMap is MediaTimeMap {
  return Boolean(
    timeMap &&
      timeMap.state !== "superseded" &&
      timeMap.revision === record.timeMapRevision &&
      timeMap.sourceMediaId === record.sourceMediaId &&
      timeMap.targetMediaId === record.targetMediaId
  );
}

function hasLocalPath(
  media: ProjectMediaReference | undefined
): media is ProjectMediaReference & { localPath: string } {
  return Boolean(
    media &&
      typeof media.localPath === "string" &&
      media.localPath.trim() &&
      (/^[a-zA-Z]:[\\/]/.test(media.localPath) || /^\\\\/.test(media.localPath) || media.localPath.startsWith("/"))
  );
}

function hasMatchingFullFileIdentity(
  media: ProjectMediaReference,
  timeMapIdentity: MediaTimeMap["sourceIdentity"]
): boolean {
  const identity = media.contentIdentity;
  return Boolean(
    identity &&
      timeMapIdentity &&
      identity.algorithm === MEDIA_CONTENT_IDENTITY_ALGORITHM &&
      Number.isSafeInteger(identity.sizeBytes) &&
      identity.sizeBytes > 0 &&
      SHA256_HEX_PATTERN.test(identity.firstSampleDigest) &&
      identity.firstSampleDigest === identity.middleSampleDigest &&
      identity.middleSampleDigest === identity.lastSampleDigest &&
      areMediaContentIdentitiesEqual(identity, timeMapIdentity)
  );
}

function isAudioStreamIndex(
  stream: MediaTimeMap["sourceStream"]
): stream is NonNullable<MediaTimeMap["sourceStream"]> {
  return Boolean(
    stream &&
      stream.type === "audio" &&
      Number.isSafeInteger(stream.index) &&
      stream.index >= 0
  );
}

function hasValidRanges(
  record: AlignmentReviewRecord,
  sourceDurationMs: number,
  targetDurationMs: number
): boolean {
  return (
    record.sourceMediaId !== record.targetMediaId &&
    isNonNegativeSafeInteger(record.sourceStartMs) &&
    isNonNegativeSafeInteger(record.sourceEndMs) &&
    isNonNegativeSafeInteger(record.targetStartMs) &&
    isNonNegativeSafeInteger(record.targetEndMs) &&
    record.sourceEndMs > record.sourceStartMs &&
    record.targetEndMs > record.targetStartMs &&
    record.sourceEndMs <= sourceDurationMs &&
    record.targetEndMs <= targetDurationMs
  );
}

function toPlannedMedia(
  media: ProjectMediaReference & { localPath: string },
  durationMs: number,
  audioStreamIndex: number
): AlignmentShadowRiskLocalPlanMedia {
  return {
    mediaKey: domainDigest(MEDIA_KEY_DOMAIN, {
      mediaId: media.id,
      audioStreamIndex
    }),
    mediaId: media.id,
    path: media.localPath,
    contentDigest: `sha256:${media.contentIdentity!.firstSampleDigest}`,
    sizeBytes: media.contentIdentity!.sizeBytes,
    durationMs,
    audioStreamIndex
  };
}

function createEmptySkipCounts(): Record<AlignmentShadowRiskLocalPlanSkipCode, number> {
  return {
    "missing-current-time-map": 0,
    "missing-local-media": 0,
    "missing-full-file-identity": 0,
    "missing-audio-stream": 0,
    "invalid-media-duration": 0,
    "invalid-record-range": 0
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function domainDigest(domain: string, value: unknown): string {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数字。");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}
