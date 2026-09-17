import {
  parseRealMediaBenchmarkManifestJson,
  type RealMediaBenchmarkManifest
} from "./realMediaBenchmark";
import { sha256Hex } from "../shared/sha256";

export const SYNTHETIC_ALIGNMENT_LAB_QUEUE_SCHEMA_VERSION = 1 as const;
const MAX_SUITES = 32;
const MAX_TOTAL_CASES = 4_096;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MANIFEST_DIGEST_DOMAIN = "danmaku-studio/synthetic-alignment-manifest/v1";

export type SyntheticAlignmentLabQueueState =
  | "ready"
  | "running"
  | "interrupted"
  | "completed"
  | "completedWithIssues";

export type SyntheticAlignmentLabSuiteState =
  | "pending"
  | "running"
  | "completed"
  | "completedWithIssues"
  | "failed"
  | "cancelled";

export interface SyntheticAlignmentLabSuiteReceipt {
  status: "completed" | "completed-with-failures" | "cancelled" | "runner-failed";
  completedAtMs: number;
  completedCaseCount: number;
  failedCaseCount: number;
  cancelledCaseCount: number;
  missingPredictionCount: number | null;
  boundaryP95Ms: number | null;
  editClassificationF1: number | null;
  mappingCoverage: number | null;
  failureCode: "runner" | null;
}

export interface SyntheticAlignmentLabRunOutcome {
  schemaVersion: "alignment-synthetic-run-report-v2";
  manifestId: string;
  datasetVersion: string;
  status: "completed" | "completed-with-failures" | "cancelled";
  caseReceipts: Array<{ state: "completed" | "failed" | "cancelled" }>;
  result: {
    overall: {
      missingPredictionCount: number;
      boundaryError: { p95Ms: number | null };
      editClassification: { f1: number };
      mappingCoverage: number;
    };
  };
  releaseEligible: false;
  note: "programmatic-development-evidence-never-real-gold";
}

export interface SyntheticAlignmentLabSuite {
  suiteId: string;
  manifestDigest: `sha256:${string}`;
  manifest: RealMediaBenchmarkManifest;
  state: SyntheticAlignmentLabSuiteState;
  attemptCount: number;
  interruptionCount: number;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  receipt: SyntheticAlignmentLabSuiteReceipt | null;
}

export interface SyntheticAlignmentLabQueue {
  schemaVersion: typeof SYNTHETIC_ALIGNMENT_LAB_QUEUE_SCHEMA_VERSION;
  queueId: string;
  state: SyntheticAlignmentLabQueueState;
  activeSuiteId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastError: string | null;
  suites: SyntheticAlignmentLabSuite[];
}

export interface SyntheticAlignmentLabQueueSummary {
  schemaVersion: "alignment-synthetic-lab-summary-v1";
  queueId: string;
  state: SyntheticAlignmentLabQueueState;
  createdAtMs: number;
  updatedAtMs: number;
  suiteCount: number;
  totalCaseCount: number;
  releaseEligible: false;
  note: "programmatic-development-evidence-never-real-gold";
  suites: Array<{
    suiteId: string;
    manifestDigest: `sha256:${string}`;
    manifestId: string;
    datasetVersion: string;
    caseCount: number;
    state: SyntheticAlignmentLabSuiteState;
    attemptCount: number;
    interruptionCount: number;
    receipt: SyntheticAlignmentLabSuiteReceipt | null;
  }>;
}

export function createSyntheticAlignmentLabQueue(
  queueId: string,
  manifests: readonly RealMediaBenchmarkManifest[],
  nowMs: number
): SyntheticAlignmentLabQueue {
  const suites = normalizeUniqueManifests(manifests).map(createSuite);
  if (suites.length === 0) throw new Error("便携实验队列至少需要一个程序化变体清单。");
  return {
    schemaVersion: SYNTHETIC_ALIGNMENT_LAB_QUEUE_SCHEMA_VERSION,
    queueId: requireIdentifier(queueId, "便携实验队列 ID"),
    state: "ready",
    activeSuiteId: null,
    createdAtMs: requireTimestamp(nowMs, "队列创建时间"),
    updatedAtMs: nowMs,
    lastError: null,
    suites
  };
}

export function appendSyntheticAlignmentLabManifests(
  queue: SyntheticAlignmentLabQueue,
  manifests: readonly RealMediaBenchmarkManifest[],
  nowMs: number
): SyntheticAlignmentLabQueue {
  const checked = parseSyntheticAlignmentLabQueue(queue);
  if (checked.state === "running") throw new Error("运行中不能修改便携实验队列。");
  const known = new Set(checked.suites.map((suite) => suite.manifestDigest));
  const additions = normalizeUniqueManifests(manifests)
    .map(createSuite)
    .filter((suite) => !known.has(suite.manifestDigest));
  const suites = [...checked.suites, ...additions];
  validateSuiteLimits(suites);
  return {
    ...checked,
    state: deriveQueueState(suites),
    updatedAtMs: requireTimestamp(nowMs, "队列更新时间"),
    lastError: null,
    suites
  };
}

export function beginSyntheticAlignmentLabSuite(
  queue: SyntheticAlignmentLabQueue,
  suiteId: string,
  nowMs: number
): SyntheticAlignmentLabQueue {
  const checked = parseSyntheticAlignmentLabQueue(queue);
  if (checked.state === "running") throw new Error("便携实验队列已有套件在运行。");
  const normalizedSuiteId = requireIdentifier(suiteId, "程序化套件 ID");
  let found = false;
  const suites = checked.suites.map((suite) => {
    if (suite.suiteId !== normalizedSuiteId) return suite;
    if (suite.state === "running") throw new Error("程序化套件已经在运行。");
    found = true;
    return {
      ...suite,
      state: "running" as const,
      attemptCount: suite.attemptCount + 1,
      lastStartedAtMs: requireTimestamp(nowMs, "套件开始时间"),
      receipt: null
    };
  });
  if (!found) throw new Error("便携实验队列中不存在该程序化套件。");
  return {
    ...checked,
    state: "running",
    activeSuiteId: normalizedSuiteId,
    updatedAtMs: nowMs,
    lastError: null,
    suites
  };
}

export function finishSyntheticAlignmentLabSuite(
  queue: SyntheticAlignmentLabQueue,
  suiteId: string,
  report: SyntheticAlignmentLabRunOutcome,
  nowMs: number
): SyntheticAlignmentLabQueue {
  const checked = requireActiveSuite(queue, suiteId);
  const suite = checked.suites.find((item) => item.suiteId === suiteId);
  if (!suite || report.manifestId !== suite.manifest.id || report.datasetVersion !== suite.manifest.datasetVersion) {
    throw new Error("程序化运行报告与当前套件不一致。");
  }
  const receipt = createReceipt(report, suite.manifest.cases.length, nowMs);
  const suites = checked.suites.map((item) =>
    item.suiteId === suiteId
      ? {
          ...item,
          state: report.status === "completed" ? "completed" as const : report.status === "cancelled" ? "cancelled" as const : "completedWithIssues" as const,
          lastFinishedAtMs: receipt.completedAtMs,
          receipt
        }
      : item
  );
  return finalizeQueue(checked, suites, nowMs, null);
}

export function failSyntheticAlignmentLabSuite(
  queue: SyntheticAlignmentLabQueue,
  suiteId: string,
  nowMs: number
): SyntheticAlignmentLabQueue {
  const checked = requireActiveSuite(queue, suiteId);
  const completedAtMs = requireTimestamp(nowMs, "套件失败时间");
  const suites = checked.suites.map((suite) =>
    suite.suiteId === suiteId
      ? {
          ...suite,
          state: "failed" as const,
          lastFinishedAtMs: completedAtMs,
          receipt: {
            status: "runner-failed" as const,
            completedAtMs,
            completedCaseCount: 0,
            failedCaseCount: suite.manifest.cases.length,
            cancelledCaseCount: 0,
            missingPredictionCount: null,
            boundaryP95Ms: null,
            editClassificationF1: null,
            mappingCoverage: null,
            failureCode: "runner" as const
          }
        }
      : suite
  );
  return finalizeQueue(checked, suites, nowMs, "程序化套件 runner 失败；已保留其余任务。" );
}

export function recoverSyntheticAlignmentLabQueue(
  queue: SyntheticAlignmentLabQueue,
  nowMs: number
): SyntheticAlignmentLabQueue {
  const checked = parseSyntheticAlignmentLabQueue(queue);
  if (checked.state !== "running" && !checked.suites.some((suite) => suite.state === "running")) {
    return checked;
  }
  return {
    ...checked,
    state: "interrupted",
    activeSuiteId: null,
    updatedAtMs: requireTimestamp(nowMs, "队列恢复时间"),
    lastError: "应用在套件终态前关闭；运行项已回到待重试，不能视为完成。",
    suites: checked.suites.map((suite) =>
      suite.state === "running"
        ? { ...suite, state: "pending" as const, interruptionCount: suite.interruptionCount + 1 }
        : suite
    )
  };
}

export function retrySyntheticAlignmentLabSuites(
  queue: SyntheticAlignmentLabQueue,
  suiteIds: readonly string[],
  nowMs: number
): SyntheticAlignmentLabQueue {
  const checked = parseSyntheticAlignmentLabQueue(queue);
  if (checked.state === "running") throw new Error("运行中不能重置程序化套件。");
  const selected = new Set(suiteIds.map((id) => requireIdentifier(id, "程序化套件 ID")));
  const suites = checked.suites.map((suite) =>
    selected.has(suite.suiteId)
      ? { ...suite, state: "pending" as const, receipt: null }
      : suite
  );
  if (suites.filter((suite) => selected.has(suite.suiteId)).length !== selected.size) {
    throw new Error("待重试列表引用了不存在的程序化套件。");
  }
  return {
    ...checked,
    state: deriveQueueState(suites),
    activeSuiteId: null,
    updatedAtMs: requireTimestamp(nowMs, "队列重试时间"),
    lastError: null,
    suites
  };
}

export function serializeSyntheticAlignmentLabQueue(queue: SyntheticAlignmentLabQueue): string {
  const serialized = `${canonicalJson(parseSyntheticAlignmentLabQueue(queue))}\n`;
  if (new TextEncoder().encode(serialized).byteLength > MAX_QUEUE_BYTES) {
    throw new Error("便携实验队列超过 8 MiB 安全上限。");
  }
  return serialized;
}

export function createSyntheticAlignmentLabQueueSummary(
  queue: SyntheticAlignmentLabQueue
): SyntheticAlignmentLabQueueSummary {
  const checked = parseSyntheticAlignmentLabQueue(queue);
  return {
    schemaVersion: "alignment-synthetic-lab-summary-v1",
    queueId: checked.queueId,
    state: checked.state,
    createdAtMs: checked.createdAtMs,
    updatedAtMs: checked.updatedAtMs,
    suiteCount: checked.suites.length,
    totalCaseCount: checked.suites.reduce((sum, suite) => sum + suite.manifest.cases.length, 0),
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold",
    suites: checked.suites.map((suite) => ({
      suiteId: suite.suiteId,
      manifestDigest: suite.manifestDigest,
      manifestId: suite.manifest.id,
      datasetVersion: suite.manifest.datasetVersion,
      caseCount: suite.manifest.cases.length,
      state: suite.state,
      attemptCount: suite.attemptCount,
      interruptionCount: suite.interruptionCount,
      receipt: suite.receipt ? { ...suite.receipt } : null
    }))
  };
}

export function serializeSyntheticAlignmentLabQueueSummary(
  queue: SyntheticAlignmentLabQueue
): string {
  return serializeSyntheticAlignmentLabQueueSummaryValue(
    createSyntheticAlignmentLabQueueSummary(queue)
  );
}

export function serializeSyntheticAlignmentLabQueueSummaryValue(
  summary: SyntheticAlignmentLabQueueSummary
): string {
  return `${canonicalJson(parseSyntheticAlignmentLabQueueSummary(summary))}\n`;
}

export function parseSyntheticAlignmentLabQueueSummaryJson(
  json: string
): SyntheticAlignmentLabQueueSummary {
  if (new TextEncoder().encode(json).byteLength > MAX_QUEUE_BYTES) {
    throw new Error("程序化回归汇总超过 8 MiB 安全上限。");
  }
  return parseSyntheticAlignmentLabQueueSummary(JSON.parse(json));
}

export function parseSyntheticAlignmentLabQueueSummary(
  value: unknown
): SyntheticAlignmentLabQueueSummary {
  const record = requireRecord(value, "程序化回归汇总");
  requireExactKeys(
    record,
    [
      "schemaVersion",
      "queueId",
      "state",
      "createdAtMs",
      "updatedAtMs",
      "suiteCount",
      "totalCaseCount",
      "releaseEligible",
      "note",
      "suites"
    ],
    "程序化回归汇总"
  );
  if (
    record.schemaVersion !== "alignment-synthetic-lab-summary-v1" ||
    record.releaseEligible !== false ||
    record.note !== "programmatic-development-evidence-never-real-gold"
  ) {
    throw new Error("程序化回归汇总的开发证据边界无效。");
  }
  const suites = requireArray(record.suites, "程序化回归套件").map(parseSummarySuite);
  if (suites.length === 0 || suites.length > MAX_SUITES) {
    throw new Error("程序化回归汇总必须包含 1–32 个套件。");
  }
  if (new Set(suites.map((suite) => suite.manifestDigest)).size !== suites.length) {
    throw new Error("程序化回归汇总不能包含重复 manifest。" );
  }
  const suiteCount = requireNonNegativeInteger(record.suiteCount, "suiteCount");
  const totalCaseCount = requireNonNegativeInteger(record.totalCaseCount, "totalCaseCount");
  if (suiteCount !== suites.length) throw new Error("程序化回归汇总 suiteCount 不一致。");
  if (totalCaseCount !== suites.reduce((sum, suite) => sum + suite.caseCount, 0)) {
    throw new Error("程序化回归汇总 totalCaseCount 不一致。");
  }
  if (totalCaseCount > MAX_TOTAL_CASES) throw new Error("程序化回归汇总超过 4096 个 case。");
  const state = requireQueueState(record.state);
  const derivedState = deriveSummaryState(suites);
  if (
    (state === "ready" && derivedState !== "ready") ||
    (state === "interrupted" && derivedState !== "ready") ||
    (state !== "ready" && state !== "interrupted" && state !== derivedState)
  ) {
    throw new Error("程序化回归汇总状态与套件状态不一致。");
  }
  return {
    schemaVersion: "alignment-synthetic-lab-summary-v1",
    queueId: requireIdentifier(record.queueId, "程序化回归队列 ID"),
    state,
    createdAtMs: requireTimestamp(record.createdAtMs, "汇总创建时间"),
    updatedAtMs: requireTimestamp(record.updatedAtMs, "汇总更新时间"),
    suiteCount,
    totalCaseCount,
    releaseEligible: false,
    note: "programmatic-development-evidence-never-real-gold",
    suites
  };
}

export function parseSyntheticAlignmentLabQueueJson(json: string): SyntheticAlignmentLabQueue {
  if (new TextEncoder().encode(json).byteLength > MAX_QUEUE_BYTES) {
    throw new Error("便携实验队列超过 8 MiB 安全上限。");
  }
  return parseSyntheticAlignmentLabQueue(JSON.parse(json));
}

export function parseSyntheticAlignmentLabQueue(value: unknown): SyntheticAlignmentLabQueue {
  const record = requireRecord(value, "便携实验队列");
  requireExactKeys(record, ["schemaVersion", "queueId", "state", "activeSuiteId", "createdAtMs", "updatedAtMs", "lastError", "suites"], "便携实验队列");
  if (record.schemaVersion !== SYNTHETIC_ALIGNMENT_LAB_QUEUE_SCHEMA_VERSION) {
    throw new Error("便携实验队列 schemaVersion 不受支持。");
  }
  const suites = requireArray(record.suites, "程序化套件").map(parseSuite);
  validateSuiteLimits(suites);
  if (new Set(suites.map((suite) => suite.manifestDigest)).size !== suites.length) {
    throw new Error("便携实验队列不能包含重复 manifest。");
  }
  const state = requireQueueState(record.state);
  const activeSuiteId = record.activeSuiteId === null ? null : requireIdentifier(record.activeSuiteId, "activeSuiteId");
  const runningSuites = suites.filter((suite) => suite.state === "running");
  if ((state === "running") !== (activeSuiteId !== null) || runningSuites.length > 1 || (activeSuiteId !== null && runningSuites[0]?.suiteId !== activeSuiteId)) {
    throw new Error("便携实验队列运行状态与 activeSuiteId 不一致。");
  }
  const derivedState = deriveQueueState(suites);
  if (
    (state === "ready" && derivedState !== "ready") ||
    (state === "interrupted" && derivedState !== "ready") ||
    (state === "completed" && derivedState !== "completed") ||
    (state === "completedWithIssues" && derivedState !== "completedWithIssues")
  ) {
    throw new Error("便携实验队列汇总状态与套件状态不一致。");
  }
  return {
    schemaVersion: SYNTHETIC_ALIGNMENT_LAB_QUEUE_SCHEMA_VERSION,
    queueId: requireIdentifier(record.queueId, "便携实验队列 ID"),
    state,
    activeSuiteId,
    createdAtMs: requireTimestamp(record.createdAtMs, "队列创建时间"),
    updatedAtMs: requireTimestamp(record.updatedAtMs, "队列更新时间"),
    lastError: record.lastError === null ? null : requireMessage(record.lastError, "队列错误"),
    suites
  };
}

export function createSyntheticManifestDigest(manifest: RealMediaBenchmarkManifest): `sha256:${string}` {
  const checked = normalizeManifest(manifest);
  return `sha256:${sha256Hex(`${MANIFEST_DIGEST_DOMAIN}\n${canonicalJson(checked)}`)}`;
}

function createSuite(manifest: RealMediaBenchmarkManifest): SyntheticAlignmentLabSuite {
  const checked = normalizeManifest(manifest);
  const manifestDigest = createSyntheticManifestDigest(checked);
  return {
    suiteId: `suite-${manifestDigest.slice(7, 39)}`,
    manifestDigest,
    manifest: checked,
    state: "pending",
    attemptCount: 0,
    interruptionCount: 0,
    lastStartedAtMs: null,
    lastFinishedAtMs: null,
    receipt: null
  };
}

function normalizeUniqueManifests(manifests: readonly RealMediaBenchmarkManifest[]): RealMediaBenchmarkManifest[] {
  const result: RealMediaBenchmarkManifest[] = [];
  const digests = new Set<string>();
  for (const manifest of manifests) {
    const checked = normalizeManifest(manifest);
    const digest = createSyntheticManifestDigest(checked);
    if (digests.has(digest)) continue;
    digests.add(digest);
    result.push(checked);
  }
  validateSuiteLimits(result.map(createSuite));
  return result;
}

function normalizeManifest(manifest: RealMediaBenchmarkManifest): RealMediaBenchmarkManifest {
  const checked = parseRealMediaBenchmarkManifestJson(JSON.stringify(manifest));
  if (checked.isExample || checked.cases.length === 0 || checked.cases.length > 256 || checked.cases.some((item) => item.mediaKind !== "synthetic" || item.split !== "development")) {
    throw new Error("便携实验队列只接受非示例 synthetic/development manifest。");
  }
  return checked;
}

function parseSuite(value: unknown): SyntheticAlignmentLabSuite {
  const record = requireRecord(value, "程序化套件");
  requireExactKeys(record, ["suiteId", "manifestDigest", "manifest", "state", "attemptCount", "interruptionCount", "lastStartedAtMs", "lastFinishedAtMs", "receipt"], "程序化套件");
  const manifest = normalizeManifest(record.manifest as RealMediaBenchmarkManifest);
  const manifestDigest = requireDigest(record.manifestDigest, "manifestDigest");
  if (manifestDigest !== createSyntheticManifestDigest(manifest)) throw new Error("程序化套件 manifest 摘要不匹配。");
  const suiteId = requireIdentifier(record.suiteId, "程序化套件 ID");
  if (suiteId !== `suite-${manifestDigest.slice(7, 39)}`) throw new Error("程序化套件 ID 与 manifest 摘要不一致。");
  const state = requireSuiteState(record.state);
  const receipt = record.receipt === null ? null : parseReceipt(record.receipt);
  if ((state === "pending" || state === "running") && receipt !== null) throw new Error("非终态套件不能保留结果回执。");
  if (state !== "pending" && state !== "running" && receipt === null) throw new Error("终态套件缺少结果回执。");
  const expectedReceiptStatus =
    state === "completed"
      ? "completed"
      : state === "completedWithIssues"
        ? "completed-with-failures"
        : state === "cancelled"
          ? "cancelled"
          : state === "failed"
            ? "runner-failed"
            : null;
  if (receipt && receipt.status !== expectedReceiptStatus) {
    throw new Error("程序化套件状态与结果回执不一致。");
  }
  if (
    receipt &&
    receipt.completedCaseCount + receipt.failedCaseCount + receipt.cancelledCaseCount >
      manifest.cases.length
  ) {
    throw new Error("程序化套件回执 case 数超过 manifest。" );
  }
  return {
    suiteId,
    manifestDigest,
    manifest,
    state,
    attemptCount: requireNonNegativeInteger(record.attemptCount, "attemptCount"),
    interruptionCount: requireNonNegativeInteger(record.interruptionCount, "interruptionCount"),
    lastStartedAtMs: requireNullableTimestamp(record.lastStartedAtMs, "lastStartedAtMs"),
    lastFinishedAtMs: requireNullableTimestamp(record.lastFinishedAtMs, "lastFinishedAtMs"),
    receipt
  };
}

function parseSummarySuite(value: unknown): SyntheticAlignmentLabQueueSummary["suites"][number] {
  const record = requireRecord(value, "程序化回归汇总套件");
  requireExactKeys(
    record,
    [
      "suiteId",
      "manifestDigest",
      "manifestId",
      "datasetVersion",
      "caseCount",
      "state",
      "attemptCount",
      "interruptionCount",
      "receipt"
    ],
    "程序化回归汇总套件"
  );
  const state = requireSuiteState(record.state);
  const caseCount = requirePositiveInteger(record.caseCount, "caseCount");
  const receipt = record.receipt === null ? null : parseReceipt(record.receipt);
  if ((state === "pending" || state === "running") !== (receipt === null)) {
    throw new Error("程序化回归汇总套件状态与回执存在性不一致。");
  }
  const expectedStatus =
    state === "completed"
      ? "completed"
      : state === "completedWithIssues"
        ? "completed-with-failures"
        : state === "failed"
          ? "runner-failed"
          : state === "cancelled"
            ? "cancelled"
            : null;
  if (receipt && receipt.status !== expectedStatus) {
    throw new Error("程序化回归汇总套件状态与回执状态不一致。");
  }
  if (
    receipt &&
    receipt.completedCaseCount + receipt.failedCaseCount + receipt.cancelledCaseCount > caseCount
  ) {
    throw new Error("程序化回归汇总回执 case 数超过 manifest。" );
  }
  if (
    receipt &&
    receipt.status !== "cancelled" &&
    receipt.completedCaseCount + receipt.failedCaseCount + receipt.cancelledCaseCount !== caseCount
  ) {
    throw new Error("程序化回归汇总终态回执没有覆盖全部 case。");
  }
  if (
    receipt?.status === "completed" &&
    (receipt.failedCaseCount > 0 || receipt.cancelledCaseCount > 0)
  ) {
    throw new Error("程序化回归汇总完成回执不能包含失败或取消 case。");
  }
  if (receipt?.status === "completed-with-failures" && receipt.failedCaseCount === 0) {
    throw new Error("程序化回归汇总失败终态缺少失败 case。");
  }
  if (receipt?.status === "cancelled" && receipt.cancelledCaseCount === 0) {
    throw new Error("程序化回归汇总取消终态缺少取消 case。");
  }
  if (receipt && ((receipt.status === "runner-failed") !== (receipt.failureCode === "runner"))) {
    throw new Error("程序化回归汇总 runner failureCode 与状态不一致。");
  }
  return {
    suiteId: requireIdentifier(record.suiteId, "程序化回归套件 ID"),
    manifestDigest: requireDigest(record.manifestDigest, "manifestDigest"),
    manifestId: requireIdentifier(record.manifestId, "manifestId"),
    datasetVersion: requireIdentifier(record.datasetVersion, "datasetVersion"),
    caseCount,
    state,
    attemptCount: requireNonNegativeInteger(record.attemptCount, "attemptCount"),
    interruptionCount: requireNonNegativeInteger(record.interruptionCount, "interruptionCount"),
    receipt
  };
}

function createReceipt(
  report: SyntheticAlignmentLabRunOutcome,
  expectedCaseCount: number,
  nowMs: number
): SyntheticAlignmentLabSuiteReceipt {
  if (
    report.schemaVersion !== "alignment-synthetic-run-report-v2" ||
    report.releaseEligible !== false ||
    report.note !== "programmatic-development-evidence-never-real-gold"
  ) {
    throw new Error("程序化运行报告的开发证据边界无效。");
  }
  if (
    report.status !== "completed" &&
    report.status !== "completed-with-failures" &&
    report.status !== "cancelled"
  ) {
    throw new Error("程序化运行报告状态无效。");
  }
  if (!Array.isArray(report.caseReceipts)) {
    throw new Error("程序化运行报告缺少 case 回执。");
  }
  for (const receipt of report.caseReceipts) {
    if (
      !receipt ||
      (receipt.state !== "completed" && receipt.state !== "failed" && receipt.state !== "cancelled")
    ) {
      throw new Error("程序化运行报告包含无效 case 状态。");
    }
  }
  const completedCaseCount = report.caseReceipts.filter((item) => item.state === "completed").length;
  const failedCaseCount = report.caseReceipts.filter((item) => item.state === "failed").length;
  const cancelledCaseCount = report.caseReceipts.filter((item) => item.state === "cancelled").length;
  const reportedCaseCount = completedCaseCount + failedCaseCount + cancelledCaseCount;
  if (
    reportedCaseCount > expectedCaseCount ||
    (report.status !== "cancelled" && reportedCaseCount !== expectedCaseCount)
  ) {
    throw new Error("程序化运行报告的 case 数与 manifest 不一致。");
  }
  if (
    (report.status === "completed" && (failedCaseCount > 0 || cancelledCaseCount > 0)) ||
    (report.status === "completed-with-failures" && failedCaseCount === 0) ||
    (report.status === "cancelled" && cancelledCaseCount === 0)
  ) {
    throw new Error("程序化运行报告状态与 case 回执不一致。");
  }
  const overall = report.result?.overall;
  if (!overall) throw new Error("程序化运行报告缺少汇总指标。");
  return {
    status: report.status,
    completedAtMs: requireTimestamp(nowMs, "套件完成时间"),
    completedCaseCount,
    failedCaseCount,
    cancelledCaseCount,
    missingPredictionCount: requireNonNegativeInteger(
      overall.missingPredictionCount,
      "missingPredictionCount"
    ),
    boundaryP95Ms: requireNullableNonNegativeFinite(
      overall.boundaryError?.p95Ms,
      "boundaryP95Ms"
    ),
    editClassificationF1: requireNullableUnitFinite(
      overall.editClassification?.f1,
      "editClassificationF1"
    ),
    mappingCoverage: requireNullableUnitFinite(overall.mappingCoverage, "mappingCoverage"),
    failureCode: null
  };
}

function parseReceipt(value: unknown): SyntheticAlignmentLabSuiteReceipt {
  const record = requireRecord(value, "程序化套件回执");
  requireExactKeys(record, ["status", "completedAtMs", "completedCaseCount", "failedCaseCount", "cancelledCaseCount", "missingPredictionCount", "boundaryP95Ms", "editClassificationF1", "mappingCoverage", "failureCode"], "程序化套件回执");
  const status = record.status;
  if (status !== "completed" && status !== "completed-with-failures" && status !== "cancelled" && status !== "runner-failed") throw new Error("程序化套件回执状态无效。");
  return {
    status,
    completedAtMs: requireTimestamp(record.completedAtMs, "回执完成时间"),
    completedCaseCount: requireNonNegativeInteger(record.completedCaseCount, "completedCaseCount"),
    failedCaseCount: requireNonNegativeInteger(record.failedCaseCount, "failedCaseCount"),
    cancelledCaseCount: requireNonNegativeInteger(record.cancelledCaseCount, "cancelledCaseCount"),
    missingPredictionCount: requireNullableNonNegativeInteger(record.missingPredictionCount, "missingPredictionCount"),
    boundaryP95Ms: requireNullableNonNegativeFinite(record.boundaryP95Ms, "boundaryP95Ms"),
    editClassificationF1: requireNullableUnitFinite(record.editClassificationF1, "editClassificationF1"),
    mappingCoverage: requireNullableUnitFinite(record.mappingCoverage, "mappingCoverage"),
    failureCode: record.failureCode === null ? null : record.failureCode === "runner" ? "runner" : invalid("程序化套件 failureCode 无效。")
  };
}

function requireActiveSuite(queue: SyntheticAlignmentLabQueue, suiteId: string): SyntheticAlignmentLabQueue {
  const checked = parseSyntheticAlignmentLabQueue(queue);
  if (checked.state !== "running" || checked.activeSuiteId !== suiteId || checked.suites.find((suite) => suite.suiteId === suiteId)?.state !== "running") {
    throw new Error("程序化套件不是当前运行项。");
  }
  return checked;
}

function finalizeQueue(queue: SyntheticAlignmentLabQueue, suites: SyntheticAlignmentLabSuite[], nowMs: number, lastError: string | null): SyntheticAlignmentLabQueue {
  return {
    ...queue,
    state: deriveQueueState(suites),
    activeSuiteId: null,
    updatedAtMs: requireTimestamp(nowMs, "队列终态时间"),
    lastError,
    suites
  };
}

function deriveQueueState(suites: readonly SyntheticAlignmentLabSuite[]): SyntheticAlignmentLabQueueState {
  if (suites.some((suite) => suite.state === "running")) return "running";
  if (suites.some((suite) => suite.state === "pending")) return "ready";
  return suites.some((suite) => suite.state !== "completed") ? "completedWithIssues" : "completed";
}

function deriveSummaryState(
  suites: SyntheticAlignmentLabQueueSummary["suites"]
): Exclude<SyntheticAlignmentLabQueueState, "interrupted"> {
  if (suites.some((suite) => suite.state === "running")) return "running";
  if (suites.some((suite) => suite.state === "pending")) return "ready";
  return suites.some((suite) => suite.state !== "completed") ? "completedWithIssues" : "completed";
}

function validateSuiteLimits(suites: readonly Pick<SyntheticAlignmentLabSuite, "manifest">[]): void {
  if (suites.length === 0 || suites.length > MAX_SUITES) throw new Error("便携实验队列必须包含 1–32 个 manifest。");
  const totalCases = suites.reduce((sum, suite) => sum + suite.manifest.cases.length, 0);
  if (totalCases > MAX_TOTAL_CASES) throw new Error("便携实验队列总 case 数不能超过 4096。");
}

function requireQueueState(value: unknown): SyntheticAlignmentLabQueueState {
  if (value === "ready" || value === "running" || value === "interrupted" || value === "completed" || value === "completedWithIssues") return value;
  throw new Error("便携实验队列状态无效。");
}

function requireSuiteState(value: unknown): SyntheticAlignmentLabSuiteState {
  if (value === "pending" || value === "running" || value === "completed" || value === "completedWithIssues" || value === "failed" || value === "cancelled") return value;
  throw new Error("程序化套件状态无效。");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || new TextEncoder().encode(value).byteLength > 512 || [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) throw new Error(`${label} 无效。`);
  return value.trim();
}

function requireMessage(value: unknown, label: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4_096) throw new Error(`${label} 无效。`);
  return value.trim();
}

function requireTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} 必须是非负整数毫秒。`);
  return Number(value);
}

function requireNullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : requireTimestamp(value, label);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} 必须是非负安全整数。`);
  return Number(value);
}

function requirePositiveInteger(value: unknown, label: string): number {
  const result = requireNonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} 必须是正整数。`);
  return result;
}

function requireNullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : requireNonNegativeInteger(value, label);
}

function requireNullableNonNegativeFinite(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负有限数或 null。`);
  return value;
}

function requireNullableUnitFinite(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} 必须位于 0–1 或为 null。`);
  return value;
}

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} 必须是 SHA-256 摘要。`);
  return value as `sha256:${string}`;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} 字段不完整或包含未知字段。`);
}

function invalid(message: string): never {
  throw new Error(message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数字。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical JSON 不接受 undefined、函数或 symbol。");
}
