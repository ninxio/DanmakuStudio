import type {
  AlignmentReviewRecord,
  AlignmentShadowRiskOverlay,
  AlignmentShadowRiskOverlayEntry,
  AlignmentShadowRiskReasonCode,
  EditorProject,
  MediaTimeMap
} from "../project/types";
import { sha256Hex } from "../shared/sha256";

const OVERLAY_DIGEST_DOMAIN = "danmaku-studio/alignment-shadow-risk-overlay/v1";
const RECORD_DIGEST_DOMAIN = "danmaku-studio/alignment-review-record-evidence/v1";
const PROJECT_RECORD_DIGEST_DOMAIN =
  "danmaku-studio/alignment-review-record-project-evidence/v2";
const ASSOCIATION_DIGEST_DOMAIN = "danmaku-studio/alignment-shadow-risk-association/v1";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_OVERLAY_ENTRIES = 100_000;
const REASON_CODES = [
  "audio-shadow-risk",
  "global-audio-disagreement",
  "missing-local-audio-support",
  "weak-local-audio-support"
] as const satisfies readonly AlignmentShadowRiskReasonCode[];

export interface AlignmentShadowRiskAssociationManifest {
  schemaVersion: "alignment-shadow-risk-association-v1";
  projectIdDigest: string;
  featureRecipeVersion: "rule-audio-local-support-risk-v1";
  records: Array<{ recordId: string; recordEvidenceDigest: string }>;
  permission: "association-only-no-labels";
  manifestId: string;
}

export interface ResolvedAlignmentShadowRiskOverlay {
  risks: Map<string, number>;
  reasons: Map<string, AlignmentShadowRiskReasonCode[]>;
  appliedCount: number;
  staleCount: number;
}

export function createAlignmentShadowRiskOverlay(
  project: Pick<EditorProject, "id" | "alignmentReviewRecords" | "mediaTimeMaps">,
  input: {
    sourceRunId: string;
    generatedAt: string;
    entries: Array<{
      recordId: string;
      risk: number;
      reasonCodes: AlignmentShadowRiskReasonCode[];
    }>;
  }
): AlignmentShadowRiskOverlay {
  const records = new Map(project.alignmentReviewRecords.map((record) => [record.id, record]));
  const entries = input.entries
    .map((entry) => {
      const record = records.get(entry.recordId);
      if (!record || record.recordState !== "active") {
        throw new Error("只能为当前有效的复核记录建立影子风险。");
      }
      return {
        recordId: entry.recordId,
        recordEvidenceDigest: createAlignmentReviewRecordEvidenceDigestForProject(project, record),
        risk: entry.risk,
        reasonCodes: [...entry.reasonCodes].sort()
      };
    })
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  const body = {
    schemaVersion: "alignment-shadow-risk-overlay-v1" as const,
    projectIdDigest: projectIdDigest(project.id),
    featureRecipeVersion: "rule-audio-local-support-risk-v1" as const,
    sourceRunId: input.sourceRunId,
    generatedAt: input.generatedAt,
    permission: "shadow-review-ranking-only" as const,
    entries
  };
  return parseAlignmentShadowRiskOverlayForProject(
    { ...body, overlayId: digest(OVERLAY_DIGEST_DOMAIN, body) },
    project
  );
}

export function createAlignmentReviewRecordEvidenceDigest(
  record: AlignmentReviewRecord
): string {
  return digest(RECORD_DIGEST_DOMAIN, {
    recordId: record.id,
    timeMapId: record.timeMapId,
    timeMapRevision: record.timeMapRevision,
    spanId: record.spanId,
    spanIndex: record.spanIndex,
    sourceMediaId: record.sourceMediaId,
    targetMediaId: record.targetMediaId,
    mediaGroupId: record.mediaGroupId,
    algorithmPrediction: record.algorithmPrediction,
    sourceStartMs: record.sourceStartMs,
    sourceEndMs: record.sourceEndMs,
    targetStartMs: record.targetStartMs,
    targetEndMs: record.targetEndMs,
    features: record.features,
    engineVersion: record.engineVersion,
    featureVersion: record.featureVersion,
    parametersHash: record.parametersHash
  });
}

/**
 * Bind an active review record to the exact media bytes, selected streams and TimeMap that
 * supplied its evidence. Historical records without a matching TimeMap deliberately keep the
 * v1 record-only digest so existing path-free vectors remain readable.
 */
export function createAlignmentReviewRecordEvidenceDigestForProject(
  project: Pick<EditorProject, "mediaTimeMaps">,
  record: AlignmentReviewRecord
): string {
  const timeMap = findMatchingTimeMap(project.mediaTimeMaps, record);
  if (!timeMap) return createAlignmentReviewRecordEvidenceDigest(record);
  return digest(PROJECT_RECORD_DIGEST_DOMAIN, {
    recordEvidenceDigest: createAlignmentReviewRecordEvidenceDigest(record),
    timeMapEvidence: timeMapEvidenceSnapshot(timeMap)
  });
}

export function createAlignmentShadowRiskAssociationManifest(
  project: Pick<EditorProject, "id" | "alignmentReviewRecords" | "mediaTimeMaps">
): AlignmentShadowRiskAssociationManifest {
  const body = {
    schemaVersion: "alignment-shadow-risk-association-v1" as const,
    projectIdDigest: projectIdDigest(project.id),
    featureRecipeVersion: "rule-audio-local-support-risk-v1" as const,
    records: project.alignmentReviewRecords
      .filter((record) => record.recordState === "active")
      .map((record) => ({
        recordId: record.id,
        recordEvidenceDigest: createAlignmentReviewRecordEvidenceDigestForProject(project, record)
      }))
      .sort((left, right) => left.recordId.localeCompare(right.recordId)),
    permission: "association-only-no-labels" as const
  };
  return {
    ...body,
    manifestId: digest(ASSOCIATION_DIGEST_DOMAIN, body)
  };
}

export function serializeAlignmentShadowRiskAssociationManifest(
  project: Pick<EditorProject, "id" | "alignmentReviewRecords" | "mediaTimeMaps">
): string {
  return `${JSON.stringify(createAlignmentShadowRiskAssociationManifest(project), null, 2)}\n`;
}

export function parseAlignmentShadowRiskOverlayForProject(
  value: unknown,
  project: Pick<EditorProject, "id" | "alignmentReviewRecords" | "mediaTimeMaps">
): AlignmentShadowRiskOverlay {
  const overlay = parseAlignmentShadowRiskOverlay(value);
  if (overlay.projectIdDigest !== projectIdDigest(project.id)) {
    throw new Error("风险文件属于另一个项目，已拒绝加载。");
  }
  const records = new Map(project.alignmentReviewRecords.map((record) => [record.id, record]));
  for (const entry of overlay.entries) {
    const record = records.get(entry.recordId);
    if (!record || record.recordState !== "active") {
      throw new Error("风险文件包含当前项目中不存在或已失效的复核记录。");
    }
    if (
      entry.recordEvidenceDigest !==
      createAlignmentReviewRecordEvidenceDigestForProject(project, record)
    ) {
      throw new Error("风险文件对应的复核记录已经变化，请重新运行离线分析。");
    }
  }
  return overlay;
}

export function parseAlignmentShadowRiskOverlay(value: unknown): AlignmentShadowRiskOverlay {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "projectIdDigest",
    "featureRecipeVersion",
    "sourceRunId",
    "generatedAt",
    "permission",
    "entries",
    "overlayId"
  ])) {
    throw new Error("离线风险文件字段不完整。");
  }
  if (
    value.schemaVersion !== "alignment-shadow-risk-overlay-v1" ||
    value.featureRecipeVersion !== "rule-audio-local-support-risk-v1" ||
    value.permission !== "shadow-review-ranking-only" ||
    !isSha256(value.projectIdDigest) ||
    !isSha256(value.sourceRunId) ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !isSha256(value.overlayId) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > MAX_OVERLAY_ENTRIES
  ) {
    throw new Error("离线风险文件版本、权限、摘要或时间无效。");
  }
  const entries = value.entries.map(parseEntry);
  const sorted = [...entries].sort((left, right) => left.recordId.localeCompare(right.recordId));
  if (
    entries.some((entry, index) => entry.recordId !== sorted[index]?.recordId) ||
    entries.some((entry, index) => index > 0 && entry.recordId === entries[index - 1]?.recordId)
  ) {
    throw new Error("离线风险条目必须按记录 ID 排序且不能重复。");
  }
  const body: Omit<AlignmentShadowRiskOverlay, "overlayId"> = {
    schemaVersion: "alignment-shadow-risk-overlay-v1",
    projectIdDigest: value.projectIdDigest,
    featureRecipeVersion: "rule-audio-local-support-risk-v1",
    sourceRunId: value.sourceRunId,
    generatedAt: value.generatedAt,
    permission: "shadow-review-ranking-only",
    entries
  };
  if (value.overlayId !== digest(OVERLAY_DIGEST_DOMAIN, body)) {
    throw new Error("离线风险文件摘要不匹配，文件可能被修改。");
  }
  return { ...body, overlayId: value.overlayId };
}

export function resolveAlignmentShadowRiskOverlay(
  project: Pick<
    EditorProject,
    "alignmentReviewRecords" | "alignmentShadowRiskOverlay" | "mediaTimeMaps"
  >
): ResolvedAlignmentShadowRiskOverlay | null {
  const overlay = project.alignmentShadowRiskOverlay;
  if (!overlay) return null;
  const records = new Map(project.alignmentReviewRecords.map((record) => [record.id, record]));
  const risks = new Map<string, number>();
  const reasons = new Map<string, AlignmentShadowRiskReasonCode[]>();
  let staleCount = 0;
  for (const entry of overlay.entries) {
    const record = records.get(entry.recordId);
    if (
      !record ||
      record.recordState !== "active" ||
      entry.recordEvidenceDigest !==
        createAlignmentReviewRecordEvidenceDigestForProject(project, record)
    ) {
      staleCount += 1;
      continue;
    }
    risks.set(entry.recordId, entry.risk);
    reasons.set(entry.recordId, entry.reasonCodes);
  }
  return { risks, reasons, appliedCount: risks.size, staleCount };
}

function findMatchingTimeMap(
  timeMaps: MediaTimeMap[],
  record: AlignmentReviewRecord
): MediaTimeMap | null {
  return (
    timeMaps.find(
      (timeMap) =>
        timeMap.id === record.timeMapId &&
        timeMap.revision === record.timeMapRevision &&
        timeMap.sourceMediaId === record.sourceMediaId &&
        timeMap.targetMediaId === record.targetMediaId
    ) ?? null
  );
}

function timeMapEvidenceSnapshot(timeMap: MediaTimeMap): object {
  return {
    id: timeMap.id,
    revision: timeMap.revision,
    sourceMediaId: timeMap.sourceMediaId,
    targetMediaId: timeMap.targetMediaId,
    sourceStream: timeMap.sourceStream,
    targetStream: timeMap.targetStream,
    sourceIdentity: timeMap.sourceIdentity,
    targetIdentity: timeMap.targetIdentity,
    sourceStartMs: timeMap.sourceStartMs,
    sourceEndMs: timeMap.sourceEndMs,
    targetStartMs: timeMap.targetStartMs,
    targetEndMs: timeMap.targetEndMs,
    spans: timeMap.spans.map((span) => ({
      id: span.id ?? null,
      kind: span.kind,
      sourceStartMs: span.sourceStartMs,
      sourceEndMs: span.sourceEndMs,
      targetStartMs: span.targetStartMs,
      targetEndMs: span.targetEndMs,
      reason: span.reason ?? null,
      quality: span.quality ?? null,
      boundaries: span.boundaries ?? null,
      alternatives: span.alternatives ?? []
    })),
    engineVersion: timeMap.engineVersion,
    featureVersion: timeMap.featureVersion,
    parametersHash: timeMap.parametersHash
  };
}

export function isAlignmentShadowRiskOverlay(value: unknown): value is AlignmentShadowRiskOverlay {
  try {
    parseAlignmentShadowRiskOverlay(value);
    return true;
  } catch {
    return false;
  }
}

export function isAlignmentShadowRiskOverlayBoundToProject(
  value: unknown,
  projectId: string
): value is AlignmentShadowRiskOverlay {
  try {
    return parseAlignmentShadowRiskOverlay(value).projectIdDigest === projectIdDigest(projectId);
  } catch {
    return false;
  }
}

function parseEntry(value: unknown): AlignmentShadowRiskOverlayEntry {
  if (!isRecord(value) || !hasExactKeys(value, [
    "recordId",
    "recordEvidenceDigest",
    "risk",
    "reasonCodes"
  ])) {
    throw new Error("离线风险条目字段不完整。");
  }
  if (
    typeof value.recordId !== "string" ||
    !value.recordId ||
    !isSha256(value.recordEvidenceDigest) ||
    typeof value.risk !== "number" ||
    !Number.isFinite(value.risk) ||
    value.risk < 0 ||
    value.risk > 1 ||
    !Array.isArray(value.reasonCodes) ||
    value.reasonCodes.length === 0 ||
    value.reasonCodes.length > REASON_CODES.length ||
    !value.reasonCodes.every(isReasonCode)
  ) {
    throw new Error("离线风险条目的记录摘要、分数或原因无效。");
  }
  const rawReasonCodes = value.reasonCodes;
  const reasonCodes = [...rawReasonCodes].sort();
  if (
    new Set(reasonCodes).size !== reasonCodes.length ||
    reasonCodes.some((reason, index) => reason !== rawReasonCodes[index])
  ) {
    throw new Error("离线风险原因必须排序且不能重复。");
  }
  return {
    recordId: value.recordId,
    recordEvidenceDigest: value.recordEvidenceDigest,
    risk: value.risk,
    reasonCodes
  };
}

function projectIdDigest(projectId: string): string {
  return `sha256:${sha256Hex(projectId)}`;
}

function digest(domain: string, value: unknown): string {
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
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}

function isReasonCode(value: unknown): value is AlignmentShadowRiskReasonCode {
  return typeof value === "string" && (REASON_CODES as readonly string[]).includes(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
