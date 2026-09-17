import { MEDIA_CONTENT_IDENTITY_ALGORITHM } from "../project/mediaIdentity";
import type { EditorProject, MediaContentIdentity, MediaTimeMap } from "../project/types";
import { sha256Hex } from "../shared/sha256";
import { assertValidTimeMap } from "./timeMap";

const SNAPSHOT_DIGEST_DOMAIN = "danmaku-studio/alignment-multimodal-rule-snapshot/v1";
const PROFILE_DIGEST_DOMAIN = "danmaku-studio/alignment-multimodal-rule-profile/v1";
const MAP_KEY_DOMAIN = "danmaku-studio/alignment-multimodal-rule-map/v1";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface AlignmentMultimodalRuleSpan {
  kind: "matched" | "sourceOnly" | "targetOnly" | "ambiguous";
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
}

export interface AlignmentMultimodalRuleTimeMap {
  timeMapKey: string;
  sourceContentDigest: string;
  targetContentDigest: string;
  ruleProfileDigest: string;
  engineVersion: string;
  featureVersion: string;
  parametersHash: string;
  spans: AlignmentMultimodalRuleSpan[];
}

export interface AlignmentMultimodalRuleSnapshot {
  schemaVersion: "alignment-multimodal-rule-snapshot-v1";
  createdAt: string;
  containsSensitiveMediaDigests: true;
  permission: "local-multimodal-shadow-association-only";
  releaseEligible: false;
  timeMaps: AlignmentMultimodalRuleTimeMap[];
  snapshotId: string;
}

export interface AlignmentMultimodalRuleSnapshotBuildResult {
  snapshot: AlignmentMultimodalRuleSnapshot | null;
  eligibleTimeMapCount: number;
  skippedTimeMapCount: number;
}

export function buildAlignmentMultimodalRuleSnapshot(
  project: Pick<EditorProject, "mediaTimeMaps">,
  createdAt = new Date().toISOString()
): AlignmentMultimodalRuleSnapshotBuildResult {
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("多模态规则快照的创建时间无效。");
  }
  const unique = new Map<string, AlignmentMultimodalRuleTimeMap>();
  let skippedTimeMapCount = 0;
  for (const timeMap of project.mediaTimeMaps) {
    const exported = exportableTimeMap(timeMap);
    if (!exported) {
      skippedTimeMapCount += 1;
      continue;
    }
    unique.set(exported.timeMapKey, exported);
  }
  const timeMaps = [...unique.values()].sort((left, right) =>
    left.timeMapKey.localeCompare(right.timeMapKey)
  );
  if (timeMaps.length === 0) {
    return { snapshot: null, eligibleTimeMapCount: 0, skippedTimeMapCount };
  }
  const body = {
    schemaVersion: "alignment-multimodal-rule-snapshot-v1" as const,
    createdAt,
    containsSensitiveMediaDigests: true as const,
    permission: "local-multimodal-shadow-association-only" as const,
    releaseEligible: false as const,
    timeMaps
  };
  return {
    snapshot: { ...body, snapshotId: domainDigest(SNAPSHOT_DIGEST_DOMAIN, body) },
    eligibleTimeMapCount: timeMaps.length,
    skippedTimeMapCount
  };
}

export function serializeAlignmentMultimodalRuleSnapshot(
  snapshot: AlignmentMultimodalRuleSnapshot
): string {
  return `${JSON.stringify(parseAlignmentMultimodalRuleSnapshot(snapshot), null, 2)}\n`;
}

export function parseAlignmentMultimodalRuleSnapshotJson(
  json: string
): AlignmentMultimodalRuleSnapshot {
  return parseAlignmentMultimodalRuleSnapshot(JSON.parse(json) as unknown);
}

export function parseAlignmentMultimodalRuleSnapshot(
  value: unknown
): AlignmentMultimodalRuleSnapshot {
  const record = requireRecord(value, "多模态规则快照");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "createdAt",
      "containsSensitiveMediaDigests",
      "permission",
      "releaseEligible",
      "timeMaps",
      "snapshotId"
    ],
    "多模态规则快照"
  );
  if (
    record.schemaVersion !== "alignment-multimodal-rule-snapshot-v1" ||
    record.containsSensitiveMediaDigests !== true ||
    record.permission !== "local-multimodal-shadow-association-only" ||
    record.releaseEligible !== false ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Array.isArray(record.timeMaps) ||
    record.timeMaps.length === 0
  ) {
    throw new Error("多模态规则快照的结构或本机权限边界无效。");
  }
  const timeMaps = record.timeMaps.map(parseRuleTimeMap);
  if (new Set(timeMaps.map((timeMap) => timeMap.timeMapKey)).size !== timeMaps.length) {
    throw new Error("多模态规则快照包含重复时间图。");
  }
  if (
    timeMaps.some(
      (timeMap, index) =>
        index > 0 && timeMaps[index - 1].timeMapKey.localeCompare(timeMap.timeMapKey) > 0
    )
  ) {
    throw new Error("多模态规则快照的时间图没有稳定排序。");
  }
  const body = {
    schemaVersion: "alignment-multimodal-rule-snapshot-v1" as const,
    createdAt: record.createdAt,
    containsSensitiveMediaDigests: true as const,
    permission: "local-multimodal-shadow-association-only" as const,
    releaseEligible: false as const,
    timeMaps
  };
  const snapshotId = requireDigest(record.snapshotId, "snapshotId");
  if (snapshotId !== domainDigest(SNAPSHOT_DIGEST_DOMAIN, body)) {
    throw new Error("多模态规则快照内容与 snapshotId 摘要不匹配。");
  }
  return { ...body, snapshotId };
}

function exportableTimeMap(timeMap: MediaTimeMap): AlignmentMultimodalRuleTimeMap | null {
  if (
    timeMap.state === "superseded" ||
    !timeMap.evidence.types.includes("audio") ||
    timeMap.evidence.types.includes("manual") ||
    timeMap.evidence.types.includes("legacy") ||
    !isFullIdentity(timeMap.sourceIdentity) ||
    !isFullIdentity(timeMap.targetIdentity) ||
    !timeMap.engineVersion.trim() ||
    !timeMap.featureVersion.trim() ||
    !timeMap.parametersHash.trim() ||
    timeMap.spans.length === 0
  ) {
    return null;
  }
  try {
    assertValidTimeMap(timeMap.spans);
  } catch {
    return null;
  }
  const spans = timeMap.spans.map((span) => ({
    kind: span.kind,
    sourceStartMs: span.sourceStartMs,
    sourceEndMs: span.sourceEndMs,
    targetStartMs: span.targetStartMs,
    targetEndMs: span.targetEndMs
  }));
  const sourceContentDigest = `sha256:${timeMap.sourceIdentity.firstSampleDigest}`;
  const targetContentDigest = `sha256:${timeMap.targetIdentity.firstSampleDigest}`;
  const profile = {
    engineVersion: timeMap.engineVersion,
    featureVersion: timeMap.featureVersion,
    parametersHash: timeMap.parametersHash,
    spans
  };
  const ruleProfileDigest = domainDigest(PROFILE_DIGEST_DOMAIN, profile);
  const key = { sourceContentDigest, targetContentDigest, ruleProfileDigest };
  return {
    timeMapKey: domainDigest(MAP_KEY_DOMAIN, key),
    sourceContentDigest,
    targetContentDigest,
    ruleProfileDigest,
    engineVersion: timeMap.engineVersion,
    featureVersion: timeMap.featureVersion,
    parametersHash: timeMap.parametersHash,
    spans
  };
}

function isFullIdentity(identity: MediaContentIdentity | null): identity is MediaContentIdentity {
  return Boolean(
    identity &&
      identity.algorithm === MEDIA_CONTENT_IDENTITY_ALGORITHM &&
      SHA256_HEX_PATTERN.test(identity.firstSampleDigest) &&
      identity.firstSampleDigest === identity.middleSampleDigest &&
      identity.middleSampleDigest === identity.lastSampleDigest
  );
}

function parseRuleTimeMap(value: unknown): AlignmentMultimodalRuleTimeMap {
  const record = requireRecord(value, "多模态规则时间图");
  requireExactKeys(
    record,
    [
      "timeMapKey",
      "sourceContentDigest",
      "targetContentDigest",
      "ruleProfileDigest",
      "engineVersion",
      "featureVersion",
      "parametersHash",
      "spans"
    ],
    "多模态规则时间图"
  );
  if (
    typeof record.engineVersion !== "string" ||
    record.engineVersion.trim().length === 0 ||
    typeof record.featureVersion !== "string" ||
    record.featureVersion.trim().length === 0 ||
    typeof record.parametersHash !== "string" ||
    record.parametersHash.trim().length === 0 ||
    !Array.isArray(record.spans) ||
    record.spans.length === 0
  ) {
    throw new Error("多模态规则时间图的版本、参数或分段无效。");
  }
  const spans = record.spans.map(parseRuleSpan);
  assertValidTimeMap(spans);
  const sourceContentDigest = requireDigest(record.sourceContentDigest, "sourceContentDigest");
  const targetContentDigest = requireDigest(record.targetContentDigest, "targetContentDigest");
  const profile = {
    engineVersion: record.engineVersion,
    featureVersion: record.featureVersion,
    parametersHash: record.parametersHash,
    spans
  };
  const ruleProfileDigest = requireDigest(record.ruleProfileDigest, "ruleProfileDigest");
  if (ruleProfileDigest !== domainDigest(PROFILE_DIGEST_DOMAIN, profile)) {
    throw new Error("多模态规则时间图与 ruleProfileDigest 摘要不匹配。");
  }
  const key = { sourceContentDigest, targetContentDigest, ruleProfileDigest };
  const timeMapKey = requireDigest(record.timeMapKey, "timeMapKey");
  if (timeMapKey !== domainDigest(MAP_KEY_DOMAIN, key)) {
    throw new Error("多模态规则时间图与 timeMapKey 摘要不匹配。");
  }
  return {
    timeMapKey,
    sourceContentDigest,
    targetContentDigest,
    ruleProfileDigest,
    engineVersion: record.engineVersion,
    featureVersion: record.featureVersion,
    parametersHash: record.parametersHash,
    spans
  };
}

function parseRuleSpan(value: unknown): AlignmentMultimodalRuleSpan {
  const record = requireRecord(value, "多模态规则分段");
  requireExactKeys(
    record,
    ["kind", "sourceStartMs", "sourceEndMs", "targetStartMs", "targetEndMs"],
    "多模态规则分段"
  );
  if (!(["matched", "sourceOnly", "targetOnly", "ambiguous"] as unknown[]).includes(record.kind)) {
    throw new Error("多模态规则分段类型无效。");
  }
  return {
    kind: record.kind as AlignmentMultimodalRuleSpan["kind"],
    sourceStartMs: requireNonNegativeInteger(record.sourceStartMs, "sourceStartMs"),
    sourceEndMs: requireNonNegativeInteger(record.sourceEndMs, "sourceEndMs"),
    targetStartMs: requireNonNegativeInteger(record.targetStartMs, "targetStartMs"),
    targetEndMs: requireNonNegativeInteger(record.targetEndMs, "targetEndMs")
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不完整或包含未知字段。`);
  }
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} 必须是小写 SHA-256 摘要。`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负整数毫秒。`);
  }
  return Number(value);
}

function domainDigest(domain: string, value: unknown): string {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("多模态规则快照不能包含非有限数字。");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("多模态规则快照包含不支持的值。");
}
