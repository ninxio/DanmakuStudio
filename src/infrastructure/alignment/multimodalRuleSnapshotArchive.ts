import {
  parseAlignmentMultimodalRuleSnapshot,
  type AlignmentMultimodalRuleSnapshot
} from "../../domain/alignment/alignmentMultimodalRuleSnapshot";

export const MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_SCHEMA_VERSION =
  "alignment-multimodal-rule-snapshot-archive-v1" as const;
export const MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_ENTRIES = 16;
export const MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;

const PERMISSION = "local-multimodal-rule-snapshot-archive-only" as const;

export interface MultimodalRuleSnapshotArchiveEntry {
  snapshotId: string;
  savedAtMs: number;
  snapshot: AlignmentMultimodalRuleSnapshot;
}

export interface MultimodalRuleSnapshotArchive {
  schemaVersion: typeof MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_SCHEMA_VERSION;
  updatedAtMs: number;
  entries: MultimodalRuleSnapshotArchiveEntry[];
  containsSensitiveMediaDigests: true;
  permission: typeof PERMISSION;
  releaseEligible: false;
}

export function createEmptyMultimodalRuleSnapshotArchive(
  nowMs: number = Date.now()
): MultimodalRuleSnapshotArchive {
  return buildArchive(requireTimestamp(nowMs, "档案更新时间"), []);
}

export function addMultimodalRuleSnapshotToArchive(
  archive: MultimodalRuleSnapshotArchive | null,
  snapshot: AlignmentMultimodalRuleSnapshot,
  savedAtMs: number = Date.now()
): MultimodalRuleSnapshotArchive {
  const base = archive
    ? parseMultimodalRuleSnapshotArchive(archive)
    : createEmptyMultimodalRuleSnapshotArchive(savedAtMs);
  const checkedSnapshot = parseAlignmentMultimodalRuleSnapshot(snapshot);
  const checkedSavedAtMs = requireTimestamp(savedAtMs, "快照保存时间");
  const entries = [
    {
      snapshotId: checkedSnapshot.snapshotId,
      savedAtMs: checkedSavedAtMs,
      snapshot: checkedSnapshot
    },
    ...base.entries.filter(
      (entry) =>
        entry.snapshotId !== checkedSnapshot.snapshotId &&
        !haveEquivalentMultimodalRuleSnapshotRules(entry.snapshot, checkedSnapshot)
    )
  ]
    .sort(compareEntriesNewestFirst)
    .slice(0, MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_ENTRIES);
  let next = buildArchive(Math.max(base.updatedAtMs, checkedSavedAtMs), entries);
  while (
    next.entries.length > 1 &&
    byteLength(serializeUnchecked(next)) > MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_BYTES
  ) {
    next = buildArchive(next.updatedAtMs, next.entries.slice(0, -1));
  }
  if (byteLength(serializeUnchecked(next)) > MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_BYTES) {
    throw new Error("单份视觉对照规则超过 8 MiB 本机档案上限，请仅手动下载该文件。");
  }
  return parseMultimodalRuleSnapshotArchive(next);
}

export function multimodalRuleSnapshotRuleSetKey(
  snapshot: AlignmentMultimodalRuleSnapshot
): string {
  return parseAlignmentMultimodalRuleSnapshot(snapshot).timeMaps
    .map((timeMap) => timeMap.timeMapKey)
    .join("\n");
}

export function haveEquivalentMultimodalRuleSnapshotRules(
  left: AlignmentMultimodalRuleSnapshot,
  right: AlignmentMultimodalRuleSnapshot
): boolean {
  return multimodalRuleSnapshotRuleSetKey(left) === multimodalRuleSnapshotRuleSetKey(right);
}

export function archiveContainsEquivalentMultimodalRuleSnapshot(
  archive: MultimodalRuleSnapshotArchive | null,
  snapshot: AlignmentMultimodalRuleSnapshot
): boolean {
  if (!archive) return false;
  const checkedArchive = parseMultimodalRuleSnapshotArchive(archive);
  return checkedArchive.entries.some((entry) =>
    haveEquivalentMultimodalRuleSnapshotRules(entry.snapshot, snapshot)
  );
}

export function parseMultimodalRuleSnapshotArchiveJson(
  json: string
): MultimodalRuleSnapshotArchive {
  if (byteLength(json) > MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_BYTES) {
    throw new Error("视觉对照规则档案超过 8 MiB 上限。");
  }
  return parseMultimodalRuleSnapshotArchive(JSON.parse(json) as unknown);
}

export function parseMultimodalRuleSnapshotArchive(
  value: unknown
): MultimodalRuleSnapshotArchive {
  const record = requireRecord(value, "视觉对照规则档案");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "updatedAtMs",
      "entries",
      "containsSensitiveMediaDigests",
      "permission",
      "releaseEligible"
    ],
    "视觉对照规则档案"
  );
  if (
    record.schemaVersion !== MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_SCHEMA_VERSION ||
    record.containsSensitiveMediaDigests !== true ||
    record.permission !== PERMISSION ||
    record.releaseEligible !== false ||
    !Array.isArray(record.entries)
  ) {
    throw new Error("视觉对照规则档案的结构或本机权限边界无效。");
  }
  if (record.entries.length > MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_ENTRIES) {
    throw new Error("视觉对照规则档案条目数超过 16。" );
  }
  const updatedAtMs = requireTimestamp(record.updatedAtMs, "档案更新时间");
  const entries = record.entries.map(parseArchiveEntry);
  if (new Set(entries.map((entry) => entry.snapshotId)).size !== entries.length) {
    throw new Error("视觉对照规则档案包含重复快照。" );
  }
  if (entries.some((entry) => entry.savedAtMs > updatedAtMs)) {
    throw new Error("视觉对照规则档案更新时间早于快照保存时间。" );
  }
  if (
    entries.some(
      (entry, index) => index > 0 && compareEntriesNewestFirst(entries[index - 1], entry) > 0
    )
  ) {
    throw new Error("视觉对照规则档案没有按保存时间稳定排序。" );
  }
  const archive = buildArchive(updatedAtMs, entries);
  if (byteLength(serializeUnchecked(archive)) > MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_BYTES) {
    throw new Error("视觉对照规则档案超过 8 MiB 上限。" );
  }
  return archive;
}

export function serializeMultimodalRuleSnapshotArchive(
  archive: MultimodalRuleSnapshotArchive
): string {
  return serializeUnchecked(parseMultimodalRuleSnapshotArchive(archive));
}

function parseArchiveEntry(value: unknown): MultimodalRuleSnapshotArchiveEntry {
  const record = requireRecord(value, "视觉对照规则档案条目");
  requireExactKeys(record, ["snapshotId", "savedAtMs", "snapshot"], "视觉对照规则档案条目");
  const snapshot = parseAlignmentMultimodalRuleSnapshot(record.snapshot);
  if (record.snapshotId !== snapshot.snapshotId) {
    throw new Error("视觉对照规则档案条目与 snapshotId 摘要不匹配。" );
  }
  return {
    snapshotId: snapshot.snapshotId,
    savedAtMs: requireTimestamp(record.savedAtMs, "快照保存时间"),
    snapshot
  };
}

function buildArchive(
  updatedAtMs: number,
  entries: MultimodalRuleSnapshotArchiveEntry[]
): MultimodalRuleSnapshotArchive {
  return {
    schemaVersion: MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_SCHEMA_VERSION,
    updatedAtMs,
    entries: structuredClone(entries),
    containsSensitiveMediaDigests: true,
    permission: PERMISSION,
    releaseEligible: false
  };
}

function serializeUnchecked(archive: MultimodalRuleSnapshotArchive): string {
  return `${JSON.stringify(archive)}\n`;
}

function compareEntriesNewestFirst(
  left: MultimodalRuleSnapshotArchiveEntry,
  right: MultimodalRuleSnapshotArchiveEntry
): number {
  return right.savedAtMs - left.savedAtMs || left.snapshotId.localeCompare(right.snapshotId);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不完整或包含未知字段。`);
  }
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负整数毫秒。`);
  }
  return Number(value);
}
