import { invoke, isTauri } from "@tauri-apps/api/core";

export type ProjectLibrarySaveKind =
  "create" | "autosave" | "checkpoint" | "recovered" | "rollback" | "recoveryDiscarded";

export type ProjectLibraryErrorCode =
  | "invalidRequest"
  | "invalidSnapshotJson"
  | "snapshotTooLarge"
  | "projectNotFound"
  | "revisionNotFound"
  | "sessionNotFound"
  | "sessionClosed"
  | "projectAlreadyOpen"
  | "recoveryDecisionRequired"
  | "revisionConflict"
  | "idempotencyMismatch"
  | "libraryBusy"
  | "libraryQuotaExceeded"
  | "unsupportedStorageVersion"
  | "migrationFailed"
  | "storageCorrupt"
  | "storageUnavailable"
  | "storageFull"
  | "permissionDenied"
  | "internal";

export interface ProjectLibraryError {
  code: ProjectLibraryErrorCode;
  message: string;
  retryable: boolean;
  actualHeadRevision: number | null;
}

export type ProjectLibraryReply<T> =
  | { contractVersion: 1; ok: true; value: T }
  | { contractVersion: 1; ok: false; error: ProjectLibraryError };

export type ProjectLibraryQuery =
  | { kind: "recent"; limit: number; cursor: string | null }
  | { kind: "recoveries" }
  | {
      kind: "revisions";
      libraryProjectId: string;
      beforeRevision: number | null;
      limit: number;
    }
  | { kind: "revision"; libraryProjectId: string; revision: number };

export interface ProjectLibraryQueryRequest {
  contractVersion: 1;
  query: ProjectLibraryQuery;
}

export interface ProjectLibraryProjectSummary {
  libraryProjectId: string;
  displayName: string;
  projectSchemaVersion: number;
  headRevision: number;
  stableRevision: number;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  lastOpenedAtUnixMs: number;
  hasRecovery: boolean;
}

export interface ProjectLibraryRevisionSummary {
  revision: number;
  parentRevision: number | null;
  sourceRevision: number | null;
  saveKind: ProjectLibrarySaveKind;
  label: string | null;
  savedAtUnixMs: number;
  snapshotBytes: number;
}

export interface StoredProjectSnapshot {
  libraryProjectId: string;
  revision: number;
  displayName: string;
  projectSchemaVersion: number;
  savedAtUnixMs: number;
  snapshotJson: string;
}

export interface ProjectLibraryRecoveryCandidate {
  libraryProjectId: string;
  displayName: string;
  recoverySessionId: string;
  openedRevision: number;
  recoveryRevision: number;
  stableRevision: number;
  lastSavedAtUnixMs: number;
  hasNewerAutosave: boolean;
}

export type ProjectLibraryQueryValue =
  | {
      kind: "recent";
      projects: ProjectLibraryProjectSummary[];
      nextCursor: string | null;
    }
  | { kind: "recoveries"; recoveries: ProjectLibraryRecoveryCandidate[] }
  | {
      kind: "revisions";
      project: ProjectLibraryProjectSummary;
      revisions: ProjectLibraryRevisionSummary[];
    }
  | { kind: "revision"; snapshot: StoredProjectSnapshot };

export type ProjectLibraryQueryReply = ProjectLibraryReply<ProjectLibraryQueryValue>;

export type OpenProjectLibrarySessionSource =
  | {
      kind: "create";
      displayName: string;
      projectSchemaVersion: number;
      snapshotJson: string;
    }
  | { kind: "head"; libraryProjectId: string; expectedHeadRevision: number }
  | {
      kind: "recover";
      libraryProjectId: string;
      recoverySessionId: string;
      recoveryRevision: number;
      expectedHeadRevision: number;
    }
  | {
      kind: "discardRecovery";
      libraryProjectId: string;
      recoverySessionId: string;
      expectedHeadRevision: number;
      sourceRevision: number;
      displayName: string;
      projectSchemaVersion: number;
      snapshotJson: string;
    };

export interface OpenProjectLibrarySessionRequest {
  contractVersion: 1;
  clientRequestId: string;
  source: OpenProjectLibrarySessionSource;
}

export interface ProjectLibrarySessionSummary {
  sessionId: string;
  openedRevision: number;
  currentRevision: number;
  stableRevision: number;
  openedAtUnixMs: number;
}

export interface OpenProjectLibrarySessionValue {
  project: ProjectLibraryProjectSummary;
  session: ProjectLibrarySessionSummary;
  snapshot: StoredProjectSnapshot;
}

export type OpenProjectLibrarySessionReply =
  ProjectLibraryReply<OpenProjectLibrarySessionValue>;

export type CommitProjectLibrarySessionChange =
  | {
      kind: "save";
      saveKind: "autosave" | "checkpoint" | "rollback";
      sourceRevision: number | null;
      label: string | null;
      displayName: string;
      projectSchemaVersion: number;
      snapshotJson: string;
    }
  | { kind: "close" };

export interface CommitProjectLibrarySessionRequest {
  contractVersion: 1;
  libraryProjectId: string;
  sessionId: string;
  clientMutationId: string;
  expectedHeadRevision: number;
  change: CommitProjectLibrarySessionChange;
}

export interface CommitProjectLibrarySessionValue {
  disposition: "committed" | "alreadyCommitted" | "unchanged";
  libraryProjectId: string;
  sessionId: string;
  headRevision: number;
  stableRevision: number;
  occurredAtUnixMs: number;
  sessionClosed: boolean;
}

export type CommitProjectLibrarySessionReply =
  ProjectLibraryReply<CommitProjectLibrarySessionValue>;

export type ProjectLibraryQueryInvoker = (
  request: ProjectLibraryQueryRequest
) => Promise<unknown>;
export type OpenProjectLibrarySessionInvoker = (
  request: OpenProjectLibrarySessionRequest
) => Promise<unknown>;
export type CommitProjectLibrarySessionInvoker = (
  request: CommitProjectLibrarySessionRequest
) => Promise<unknown>;

const ERROR_CODES = new Set<ProjectLibraryErrorCode>([
  "invalidRequest",
  "invalidSnapshotJson",
  "snapshotTooLarge",
  "projectNotFound",
  "revisionNotFound",
  "sessionNotFound",
  "sessionClosed",
  "projectAlreadyOpen",
  "recoveryDecisionRequired",
  "revisionConflict",
  "idempotencyMismatch",
  "libraryBusy",
  "libraryQuotaExceeded",
  "unsupportedStorageVersion",
  "migrationFailed",
  "storageCorrupt",
  "storageUnavailable",
  "storageFull",
  "permissionDenied",
  "internal"
]);
const SAVE_KINDS = new Set<ProjectLibrarySaveKind>([
  "create",
  "autosave",
  "checkpoint",
  "recovered",
  "rollback",
  "recoveryDiscarded"
]);
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

export async function queryTauriProjectLibrary(
  request: ProjectLibraryQueryRequest,
  invoker: ProjectLibraryQueryInvoker = defaultQueryInvoker
): Promise<ProjectLibraryQueryReply> {
  validateQueryRequest(request);
  assertDesktop(invoker === defaultQueryInvoker);
  const response = await invokeWithContext("项目库查询失败", () => invoker(request));
  const reply = parseProjectLibraryReply(response, validateQueryValue);
  validateReplyCorrelation(() => validateQueryReplyCorrelation(request, reply));
  return reply;
}

export async function openTauriProjectLibrarySession(
  request: OpenProjectLibrarySessionRequest,
  invoker: OpenProjectLibrarySessionInvoker = defaultOpenInvoker
): Promise<OpenProjectLibrarySessionReply> {
  validateOpenRequest(request);
  assertDesktop(invoker === defaultOpenInvoker);
  const response = await invokeWithContext("项目库打开失败", () => invoker(request));
  const reply = parseProjectLibraryReply(response, validateOpenValue);
  validateReplyCorrelation(() => validateOpenReplyCorrelation(request, reply));
  return reply;
}

export async function commitTauriProjectLibrarySession(
  request: CommitProjectLibrarySessionRequest,
  invoker: CommitProjectLibrarySessionInvoker = defaultCommitInvoker
): Promise<CommitProjectLibrarySessionReply> {
  validateCommitRequest(request);
  assertDesktop(invoker === defaultCommitInvoker);
  const response = await invokeWithContext("项目库提交失败", () => invoker(request));
  const reply = parseProjectLibraryReply(response, validateCommitValue);
  validateReplyCorrelation(() => validateCommitReplyCorrelation(request, reply));
  return reply;
}

function defaultQueryInvoker(request: ProjectLibraryQueryRequest): Promise<unknown> {
  return invoke("query_project_library", { request });
}

function defaultOpenInvoker(request: OpenProjectLibrarySessionRequest): Promise<unknown> {
  return invoke("open_project_library_session", { request });
}

function defaultCommitInvoker(request: CommitProjectLibrarySessionRequest): Promise<unknown> {
  return invoke("commit_project_library_session", { request });
}

function assertDesktop(usingDefaultInvoker: boolean): void {
  if (usingDefaultInvoker && !isTauri()) {
    throw new Error("项目库需要在 Tauri 桌面端运行；仍可使用手动 JSON 备份。");
  }
}

async function invokeWithContext(
  label: string,
  operation: () => Promise<unknown>
): Promise<unknown> {
  try {
    return await operation();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}：${detail}`);
  }
}

function parseProjectLibraryReply<T>(
  value: unknown,
  validateValue: (candidate: unknown) => asserts candidate is T
): ProjectLibraryReply<T> {
  try {
    if (!isRecord(value) || value.contractVersion !== 1 || typeof value.ok !== "boolean") {
      throw new Error("reply 根字段无效。");
    }
    if (value.ok) {
      assertExactKeys(value, ["contractVersion", "ok", "value"]);
      validateValue(value.value);
      return value as ProjectLibraryReply<T>;
    }
    assertExactKeys(value, ["contractVersion", "ok", "error"]);
    validateError(value.error);
    return value as ProjectLibraryReply<T>;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`项目库响应无效：${detail}`);
  }
}

function validateReplyCorrelation(operation: () => void): void {
  try {
    operation();
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`项目库响应无效：${detail}`);
  }
}

function validateQueryReplyCorrelation(
  request: ProjectLibraryQueryRequest,
  reply: ProjectLibraryQueryReply
): void {
  if (!reply.ok) return;
  if (reply.value.kind !== request.query.kind) {
    throw new Error("query reply kind 与请求不一致。");
  }
  if (request.query.kind === "revisions" && reply.value.kind === "revisions") {
    if (reply.value.project.libraryProjectId !== request.query.libraryProjectId) {
      throw new Error("revisions reply 的项目与请求不一致。");
    }
  }
  if (request.query.kind === "revision" && reply.value.kind === "revision") {
    if (
      reply.value.snapshot.libraryProjectId !== request.query.libraryProjectId ||
      reply.value.snapshot.revision !== request.query.revision
    ) {
      throw new Error("revision reply 的项目或修订与请求不一致。");
    }
  }
}

function validateOpenReplyCorrelation(
  request: OpenProjectLibrarySessionRequest,
  reply: OpenProjectLibrarySessionReply
): void {
  if (!reply.ok) return;
  const { project, session, snapshot } = reply.value;
  const source = request.source;
  if (source.kind !== "create" && project.libraryProjectId !== source.libraryProjectId) {
    throw new Error("open reply 的项目与请求不一致。");
  }
  switch (source.kind) {
    case "create":
      if (
        project.headRevision !== 1 ||
        project.stableRevision !== 1 ||
        project.displayName !== source.displayName ||
        project.projectSchemaVersion !== source.projectSchemaVersion ||
        snapshot.snapshotJson !== source.snapshotJson
      ) {
        throw new Error("create reply 的初始修订或项目内容无效。");
      }
      return;
    case "head":
      if (project.headRevision !== source.expectedHeadRevision) {
        throw new Error("head reply 未返回请求的 head。");
      }
      return;
    case "recover":
      if (
        project.headRevision !== source.expectedHeadRevision + 1 ||
        session.stableRevision >= project.headRevision
      ) {
        throw new Error("recover reply 未追加恢复决定修订。");
      }
      return;
    case "discardRecovery":
      if (
        project.headRevision !== source.expectedHeadRevision + 1 ||
        project.stableRevision !== project.headRevision ||
        project.displayName !== source.displayName ||
        project.projectSchemaVersion !== source.projectSchemaVersion ||
        snapshot.snapshotJson !== source.snapshotJson
      ) {
        throw new Error("discardRecovery reply 未追加请求的稳定修订。");
      }
  }
}

function validateCommitReplyCorrelation(
  request: CommitProjectLibrarySessionRequest,
  reply: CommitProjectLibrarySessionReply
): void {
  if (!reply.ok) return;
  const value = reply.value;
  if (
    value.libraryProjectId !== request.libraryProjectId ||
    value.sessionId !== request.sessionId
  ) {
    throw new Error("commit reply 的项目或会话与请求不一致。");
  }
  if (request.change.kind === "close") {
    if (
      value.headRevision !== request.expectedHeadRevision ||
      !value.sessionClosed ||
      value.disposition === "unchanged"
    ) {
      throw new Error("close reply 与请求不一致。");
    }
    return;
  }
  if (value.sessionClosed) throw new Error("save reply 不得关闭会话。");
  const saveKind = request.change.saveKind;
  const appendedRevision = request.expectedHeadRevision + 1;
  const isAutosave = saveKind === "autosave";
  const valid = (() => {
    switch (value.disposition) {
      case "committed":
        return (
          value.headRevision === appendedRevision &&
          (isAutosave
            ? value.stableRevision <= request.expectedHeadRevision
            : value.stableRevision === value.headRevision)
        );
      case "unchanged":
        return (
          isAutosave &&
          value.headRevision === request.expectedHeadRevision &&
          value.stableRevision <= request.expectedHeadRevision
        );
      case "alreadyCommitted":
        return isAutosave
          ? (value.headRevision === request.expectedHeadRevision ||
              value.headRevision === appendedRevision) &&
              value.stableRevision <= request.expectedHeadRevision
          : value.headRevision === appendedRevision &&
              value.stableRevision === value.headRevision;
    }
  })();
  if (!valid) throw new Error("save reply 的修订、稳定点或 disposition 与请求不一致。");
}

function validateQueryRequest(value: unknown): asserts value is ProjectLibraryQueryRequest {
  assertExactKeys(value, ["contractVersion", "query"]);
  if (value.contractVersion !== 1 || !isRecord(value.query)) {
    throw new Error("query request 根字段无效。");
  }
  const query = value.query;
  switch (query.kind) {
    case "recent":
      assertExactKeys(query, ["kind", "limit", "cursor"]);
      if (
        !isIntegerInRange(query.limit, 1, 50) ||
        !isNullableBoundedString(query.cursor, 256)
      ) {
        throw new Error("recent query 无效。");
      }
      return;
    case "recoveries":
      assertExactKeys(query, ["kind"]);
      return;
    case "revisions":
      assertExactKeys(query, ["kind", "libraryProjectId", "beforeRevision", "limit"]);
      if (
        !isBoundedNonEmptyString(query.libraryProjectId, 128) ||
        !isNullablePositiveSafeInteger(query.beforeRevision) ||
        !isIntegerInRange(query.limit, 1, 100)
      ) {
        throw new Error("revisions query 无效。");
      }
      return;
    case "revision":
      assertExactKeys(query, ["kind", "libraryProjectId", "revision"]);
      if (
        !isBoundedNonEmptyString(query.libraryProjectId, 128) ||
        !isPositiveSafeInteger(query.revision)
      ) {
        throw new Error("revision query 无效。");
      }
      return;
    default:
      throw new Error("query kind 无效。");
  }
}

function validateOpenRequest(
  value: unknown
): asserts value is OpenProjectLibrarySessionRequest {
  assertExactKeys(value, ["contractVersion", "clientRequestId", "source"]);
  if (
    value.contractVersion !== 1 ||
    !isBoundedNonEmptyString(value.clientRequestId, 128) ||
    !isRecord(value.source)
  ) {
    throw new Error("open request 根字段无效。");
  }
  const source = value.source;
  switch (source.kind) {
    case "create":
      assertExactKeys(source, ["kind", "displayName", "projectSchemaVersion", "snapshotJson"]);
      if (!isSnapshotWrite(source)) throw new Error("create source 无效。");
      return;
    case "head":
      assertExactKeys(source, ["kind", "libraryProjectId", "expectedHeadRevision"]);
      if (
        !isBoundedNonEmptyString(source.libraryProjectId, 128) ||
        !isPositiveSafeInteger(source.expectedHeadRevision)
      ) {
        throw new Error("head source 无效。");
      }
      return;
    case "recover":
      assertExactKeys(source, [
        "kind",
        "libraryProjectId",
        "recoverySessionId",
        "recoveryRevision",
        "expectedHeadRevision"
      ]);
      if (
        !isBoundedNonEmptyString(source.libraryProjectId, 128) ||
        !isBoundedNonEmptyString(source.recoverySessionId, 128) ||
        !isPositiveSafeInteger(source.recoveryRevision) ||
        !isPositiveSafeInteger(source.expectedHeadRevision)
      ) {
        throw new Error("recover source 无效。");
      }
      return;
    case "discardRecovery":
      assertExactKeys(source, [
        "kind",
        "libraryProjectId",
        "recoverySessionId",
        "expectedHeadRevision",
        "sourceRevision",
        "displayName",
        "projectSchemaVersion",
        "snapshotJson"
      ]);
      if (
        !isBoundedNonEmptyString(source.libraryProjectId, 128) ||
        !isBoundedNonEmptyString(source.recoverySessionId, 128) ||
        !isPositiveSafeInteger(source.expectedHeadRevision) ||
        !isPositiveSafeInteger(source.sourceRevision) ||
        !isSnapshotWrite(source)
      ) {
        throw new Error("discardRecovery source 无效。");
      }
      return;
    default:
      throw new Error("open source kind 无效。");
  }
}

function validateCommitRequest(
  value: unknown
): asserts value is CommitProjectLibrarySessionRequest {
  assertExactKeys(value, [
    "contractVersion",
    "libraryProjectId",
    "sessionId",
    "clientMutationId",
    "expectedHeadRevision",
    "change"
  ]);
  if (
    value.contractVersion !== 1 ||
    !isBoundedNonEmptyString(value.libraryProjectId, 128) ||
    !isBoundedNonEmptyString(value.sessionId, 128) ||
    !isBoundedNonEmptyString(value.clientMutationId, 128) ||
    !isPositiveSafeInteger(value.expectedHeadRevision) ||
    !isRecord(value.change)
  ) {
    throw new Error("commit request 根字段无效。");
  }
  const change = value.change;
  if (change.kind === "close") {
    assertExactKeys(change, ["kind"]);
    return;
  }
  if (change.kind !== "save") throw new Error("commit change kind 无效。");
  assertExactKeys(change, [
    "kind",
    "saveKind",
    "sourceRevision",
    "label",
    "displayName",
    "projectSchemaVersion",
    "snapshotJson"
  ]);
  if (
    !new Set(["autosave", "checkpoint", "rollback"]).has(String(change.saveKind)) ||
    !isNullableBoundedString(change.label, 256) ||
    !isSnapshotWrite(change)
  ) {
    throw new Error("commit save 字段无效。");
  }
  if (
    (change.saveKind === "rollback" && !isPositiveSafeInteger(change.sourceRevision)) ||
    (change.saveKind !== "rollback" && change.sourceRevision !== null)
  ) {
    throw new Error("commit sourceRevision 与 saveKind 不一致。");
  }
}

function validateQueryValue(value: unknown): asserts value is ProjectLibraryQueryValue {
  if (!isRecord(value)) throw new Error("query value 必须是对象。");
  switch (value.kind) {
    case "recent":
      assertExactKeys(value, ["kind", "projects", "nextCursor"]);
      if (!Array.isArray(value.projects) || !isNullableBoundedString(value.nextCursor, 256)) {
        throw new Error("recent value 无效。");
      }
      value.projects.forEach(validateProjectSummary);
      return;
    case "recoveries":
      assertExactKeys(value, ["kind", "recoveries"]);
      if (!Array.isArray(value.recoveries)) throw new Error("recoveries 必须是数组。");
      value.recoveries.forEach(validateRecoveryCandidate);
      return;
    case "revisions":
      assertExactKeys(value, ["kind", "project", "revisions"]);
      validateProjectSummary(value.project);
      if (!Array.isArray(value.revisions)) throw new Error("revisions 必须是数组。");
      value.revisions.forEach(validateRevisionSummary);
      return;
    case "revision":
      assertExactKeys(value, ["kind", "snapshot"]);
      validateStoredSnapshot(value.snapshot);
      return;
    default:
      throw new Error("query value kind 无效。");
  }
}

function validateOpenValue(value: unknown): asserts value is OpenProjectLibrarySessionValue {
  assertExactKeys(value, ["project", "session", "snapshot"]);
  validateProjectSummary(value.project);
  validateSessionSummary(value.session);
  validateStoredSnapshot(value.snapshot);
  if (
    value.project.libraryProjectId !== value.snapshot.libraryProjectId ||
    value.project.headRevision !== value.session.currentRevision ||
    value.session.currentRevision !== value.snapshot.revision ||
    value.session.openedRevision !== value.session.currentRevision ||
    value.project.stableRevision !== value.session.stableRevision ||
    value.project.displayName !== value.snapshot.displayName ||
    value.project.projectSchemaVersion !== value.snapshot.projectSchemaVersion ||
    value.project.hasRecovery
  ) {
    throw new Error("open value 的项目、会话和快照不一致。");
  }
}

function validateSessionSummary(value: unknown): asserts value is ProjectLibrarySessionSummary {
  assertExactKeys(value, [
    "sessionId",
    "openedRevision",
    "currentRevision",
    "stableRevision",
    "openedAtUnixMs"
  ]);
  if (
    !isBoundedNonEmptyString(value.sessionId, 128) ||
    !isPositiveSafeInteger(value.openedRevision) ||
    !isPositiveSafeInteger(value.currentRevision) ||
    !isPositiveSafeInteger(value.stableRevision) ||
    value.stableRevision > value.currentRevision ||
    !isNonNegativeSafeInteger(value.openedAtUnixMs)
  ) {
    throw new Error("session summary 字段无效。");
  }
}

function validateCommitValue(
  value: unknown
): asserts value is CommitProjectLibrarySessionValue {
  assertExactKeys(value, [
    "disposition",
    "libraryProjectId",
    "sessionId",
    "headRevision",
    "stableRevision",
    "occurredAtUnixMs",
    "sessionClosed"
  ]);
  if (
    !new Set(["committed", "alreadyCommitted", "unchanged"]).has(String(value.disposition)) ||
    !isBoundedNonEmptyString(value.libraryProjectId, 128) ||
    !isBoundedNonEmptyString(value.sessionId, 128) ||
    !isPositiveSafeInteger(value.headRevision) ||
    !isPositiveSafeInteger(value.stableRevision) ||
    value.stableRevision > value.headRevision ||
    !isNonNegativeSafeInteger(value.occurredAtUnixMs) ||
    typeof value.sessionClosed !== "boolean" ||
    (value.sessionClosed && value.stableRevision !== value.headRevision) ||
    (value.disposition === "unchanged" && value.sessionClosed)
  ) {
    throw new Error("commit value 字段无效。");
  }
}

function validateProjectSummary(value: unknown): asserts value is ProjectLibraryProjectSummary {
  assertExactKeys(value, [
    "libraryProjectId",
    "displayName",
    "projectSchemaVersion",
    "headRevision",
    "stableRevision",
    "createdAtUnixMs",
    "updatedAtUnixMs",
    "lastOpenedAtUnixMs",
    "hasRecovery"
  ]);
  if (
    !isBoundedNonEmptyString(value.libraryProjectId, 128) ||
    !isBoundedNonEmptyString(value.displayName, 1024) ||
    !isPositiveU32(value.projectSchemaVersion) ||
    !isPositiveSafeInteger(value.headRevision) ||
    !isPositiveSafeInteger(value.stableRevision) ||
    value.stableRevision > value.headRevision ||
    !isNonNegativeSafeInteger(value.createdAtUnixMs) ||
    !isNonNegativeSafeInteger(value.updatedAtUnixMs) ||
    !isNonNegativeSafeInteger(value.lastOpenedAtUnixMs) ||
    typeof value.hasRecovery !== "boolean"
  ) {
    throw new Error("project summary 字段无效。");
  }
}

function validateRevisionSummary(
  value: unknown
): asserts value is ProjectLibraryRevisionSummary {
  assertExactKeys(value, [
    "revision",
    "parentRevision",
    "sourceRevision",
    "saveKind",
    "label",
    "savedAtUnixMs",
    "snapshotBytes"
  ]);
  if (
    !isPositiveSafeInteger(value.revision) ||
    !isNullablePositiveSafeInteger(value.parentRevision) ||
    !isNullablePositiveSafeInteger(value.sourceRevision) ||
    !SAVE_KINDS.has(value.saveKind as ProjectLibrarySaveKind) ||
    !isNullableBoundedString(value.label, 256) ||
    !isNonNegativeSafeInteger(value.savedAtUnixMs) ||
    !isNonNegativeSafeInteger(value.snapshotBytes)
  ) {
    throw new Error("revision summary 字段无效。");
  }
}

function validateStoredSnapshot(value: unknown): asserts value is StoredProjectSnapshot {
  assertExactKeys(value, [
    "libraryProjectId",
    "revision",
    "displayName",
    "projectSchemaVersion",
    "savedAtUnixMs",
    "snapshotJson"
  ]);
  if (
    !isBoundedNonEmptyString(value.libraryProjectId, 128) ||
    !isPositiveSafeInteger(value.revision) ||
    !isBoundedNonEmptyString(value.displayName, 1024) ||
    !isPositiveU32(value.projectSchemaVersion) ||
    !isNonNegativeSafeInteger(value.savedAtUnixMs) ||
    typeof value.snapshotJson !== "string" ||
    !isJsonObjectString(value.snapshotJson)
  ) {
    throw new Error("stored snapshot 字段无效。");
  }
}

function validateRecoveryCandidate(
  value: unknown
): asserts value is ProjectLibraryRecoveryCandidate {
  assertExactKeys(value, [
    "libraryProjectId",
    "displayName",
    "recoverySessionId",
    "openedRevision",
    "recoveryRevision",
    "stableRevision",
    "lastSavedAtUnixMs",
    "hasNewerAutosave"
  ]);
  if (
    !isBoundedNonEmptyString(value.libraryProjectId, 128) ||
    !isBoundedNonEmptyString(value.displayName, 1024) ||
    !isBoundedNonEmptyString(value.recoverySessionId, 128) ||
    !isPositiveSafeInteger(value.openedRevision) ||
    !isPositiveSafeInteger(value.recoveryRevision) ||
    !isPositiveSafeInteger(value.stableRevision) ||
    value.recoveryRevision < value.stableRevision ||
    !isNonNegativeSafeInteger(value.lastSavedAtUnixMs) ||
    typeof value.hasNewerAutosave !== "boolean" ||
    value.hasNewerAutosave !== value.recoveryRevision > value.stableRevision
  ) {
    throw new Error("recovery candidate 字段无效。");
  }
}

function validateError(value: unknown): asserts value is ProjectLibraryError {
  assertExactKeys(value, ["code", "message", "retryable", "actualHeadRevision"]);
  if (
    !ERROR_CODES.has(value.code as ProjectLibraryErrorCode) ||
    !isBoundedNonEmptyString(value.message, 512) ||
    typeof value.retryable !== "boolean" ||
    !isNullablePositiveSafeInteger(value.actualHeadRevision)
  ) {
    throw new Error("project library error 无效。");
  }
  const headContextRequired =
    value.code === "revisionConflict" || value.code === "recoveryDecisionRequired";
  if (
    (headContextRequired && value.actualHeadRevision === null) ||
    (!headContextRequired && value.actualHeadRevision !== null)
  ) {
    throw new Error("project library error 的 actualHeadRevision 与错误码不一致。");
  }
}

function isSnapshotWrite(value: Record<string, unknown>): boolean {
  return (
    isBoundedNonEmptyString(value.displayName, 1024) &&
    isPositiveU32(value.projectSchemaVersion) &&
    typeof value.snapshotJson === "string" &&
    isJsonObjectString(value.snapshotJson)
  );
}

function isJsonObjectString(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > MAX_SNAPSHOT_BYTES) return false;
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("预期对象。");
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`字段不匹配：${actual.join(",")}。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveU32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
  return value === null || isPositiveSafeInteger(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function isBoundedNonEmptyString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function isNullableBoundedString(value: unknown, maximumBytes: number): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximumBytes)
  );
}
