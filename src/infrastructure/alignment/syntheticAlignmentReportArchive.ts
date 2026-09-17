import {
  createSyntheticAlignmentRunReportId,
  parseSyntheticAlignmentRunReport,
  type SyntheticAlignmentRunReport
} from "./syntheticAlignmentRunner";

export const SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_SCHEMA_VERSION =
  "alignment-synthetic-report-archive-v1" as const;
export const SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_ENTRIES = 16;
export const SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_BYTES = 24 * 1024 * 1024;

const DEVELOPMENT_NOTE = "programmatic-development-evidence-never-real-gold" as const;

export interface SyntheticAlignmentReportArchiveEntry {
  reportId: `sha256:${string}`;
  savedAtMs: number;
  report: SyntheticAlignmentRunReport;
}

export interface SyntheticAlignmentReportArchive {
  schemaVersion: typeof SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_SCHEMA_VERSION;
  updatedAtMs: number;
  entries: SyntheticAlignmentReportArchiveEntry[];
  releaseEligible: false;
  note: typeof DEVELOPMENT_NOTE;
}

export function createEmptySyntheticAlignmentReportArchive(
  nowMs: number = Date.now()
): SyntheticAlignmentReportArchive {
  return {
    schemaVersion: SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_SCHEMA_VERSION,
    updatedAtMs: requireTimestamp(nowMs, "档案更新时间"),
    entries: [],
    releaseEligible: false,
    note: DEVELOPMENT_NOTE
  };
}

export function addSyntheticAlignmentRunReport(
  archive: SyntheticAlignmentReportArchive | null,
  report: SyntheticAlignmentRunReport,
  savedAtMs: number = Date.now()
): SyntheticAlignmentReportArchive {
  const base = archive
    ? parseSyntheticAlignmentReportArchive(archive)
    : createEmptySyntheticAlignmentReportArchive(savedAtMs);
  const checkedReport = parseSyntheticAlignmentRunReport(report);
  const reportId = createSyntheticAlignmentRunReportId(checkedReport);
  const checkedSavedAtMs = requireTimestamp(savedAtMs, "报告保存时间");
  const entries = [
    { reportId, savedAtMs: checkedSavedAtMs, report: checkedReport },
    ...base.entries.filter((entry) => entry.reportId !== reportId)
  ]
    .sort(compareEntriesNewestFirst)
    .slice(0, SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_ENTRIES);
  let next = buildArchive(Math.max(base.updatedAtMs, checkedSavedAtMs), entries);
  while (
    next.entries.length > 1 &&
    byteLength(serializeSyntheticAlignmentReportArchiveUnchecked(next)) >
      SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_BYTES
  ) {
    next = buildArchive(next.updatedAtMs, next.entries.slice(0, -1));
  }
  if (
    byteLength(serializeSyntheticAlignmentReportArchiveUnchecked(next)) >
    SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_BYTES
  ) {
    throw new Error("单份程序化详细报告超过 24 MiB 本地档案上限，请先手动下载报告。");
  }
  return parseSyntheticAlignmentReportArchive(next);
}

export function parseSyntheticAlignmentReportArchiveJson(
  json: string
): SyntheticAlignmentReportArchive {
  if (byteLength(json) > SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_BYTES) {
    throw new Error("程序化详细报告档案超过 24 MiB 上限。");
  }
  return parseSyntheticAlignmentReportArchive(JSON.parse(json) as unknown);
}

export function parseSyntheticAlignmentReportArchive(
  value: unknown
): SyntheticAlignmentReportArchive {
  const record = requireRecord(value, "程序化详细报告档案");
  requireExactKeys(
    record,
    ["schemaVersion", "updatedAtMs", "entries", "releaseEligible", "note"],
    "程序化详细报告档案"
  );
  if (record.schemaVersion !== SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_SCHEMA_VERSION) {
    throw new Error("程序化详细报告档案 schemaVersion 不受支持。");
  }
  if (record.releaseEligible !== false || record.note !== DEVELOPMENT_NOTE) {
    throw new Error("程序化详细报告档案的开发证据边界无效。");
  }
  const updatedAtMs = requireTimestamp(record.updatedAtMs, "档案更新时间");
  if (!Array.isArray(record.entries)) throw new Error("程序化详细报告档案缺少 entries。" );
  if (record.entries.length > SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_ENTRIES) {
    throw new Error("程序化详细报告档案条目数超过 16。" );
  }
  const entries = record.entries.map(parseArchiveEntry);
  if (new Set(entries.map((entry) => entry.reportId)).size !== entries.length) {
    throw new Error("程序化详细报告档案包含重复内容摘要。");
  }
  if (entries.some((entry) => entry.savedAtMs > updatedAtMs)) {
    throw new Error("程序化详细报告档案更新时间早于报告保存时间。");
  }
  if (
    entries.some(
      (entry, index) => index > 0 && compareEntriesNewestFirst(entries[index - 1], entry) > 0
    )
  ) {
    throw new Error("程序化详细报告档案没有按保存时间稳定排序。");
  }
  const archive = buildArchive(updatedAtMs, entries);
  if (
    byteLength(serializeSyntheticAlignmentReportArchiveUnchecked(archive)) >
    SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_MAX_BYTES
  ) {
    throw new Error("程序化详细报告档案超过 24 MiB 上限。");
  }
  return archive;
}

export function serializeSyntheticAlignmentReportArchive(
  archive: SyntheticAlignmentReportArchive
): string {
  return serializeSyntheticAlignmentReportArchiveUnchecked(
    parseSyntheticAlignmentReportArchive(archive)
  );
}

function parseArchiveEntry(value: unknown): SyntheticAlignmentReportArchiveEntry {
  const record = requireRecord(value, "程序化详细报告档案条目");
  requireExactKeys(record, ["reportId", "savedAtMs", "report"], "程序化详细报告档案条目");
  const report = parseSyntheticAlignmentRunReport(record.report);
  const reportId = requireDigest(record.reportId, "reportId");
  if (reportId !== createSyntheticAlignmentRunReportId(report)) {
    throw new Error("程序化详细报告内容与 reportId 摘要不匹配。");
  }
  return {
    reportId,
    savedAtMs: requireTimestamp(record.savedAtMs, "报告保存时间"),
    report
  };
}

function buildArchive(
  updatedAtMs: number,
  entries: SyntheticAlignmentReportArchiveEntry[]
): SyntheticAlignmentReportArchive {
  return {
    schemaVersion: SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_SCHEMA_VERSION,
    updatedAtMs,
    entries: structuredClone(entries),
    releaseEligible: false,
    note: DEVELOPMENT_NOTE
  };
}

function serializeSyntheticAlignmentReportArchiveUnchecked(
  archive: SyntheticAlignmentReportArchive
): string {
  return `${JSON.stringify(archive)}\n`;
}

function compareEntriesNewestFirst(
  left: SyntheticAlignmentReportArchiveEntry,
  right: SyntheticAlignmentReportArchiveEntry
): number {
  return right.savedAtMs - left.savedAtMs || left.reportId.localeCompare(right.reportId);
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

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负整数毫秒。`);
  }
  return Number(value);
}

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 SHA-256 摘要。`);
  }
  return value as `sha256:${string}`;
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
