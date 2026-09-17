import {
  commitTauriProjectLibrarySession,
  openTauriProjectLibrarySession,
  queryTauriProjectLibrary,
  type CommitProjectLibrarySessionReply,
  type CommitProjectLibrarySessionRequest,
  type OpenProjectLibrarySessionReply,
  type OpenProjectLibrarySessionRequest,
  type ProjectLibraryQueryReply,
  type ProjectLibraryQueryRequest
} from "../infrastructure/persistence/tauriProjectLibrary";
import { createEmptyProject } from "../domain/project/factory";
import {
  parseProjectJsonWithMetadata,
  serializeProject,
  type ProjectParseResult
} from "../domain/project/schema";
import type { EditorProject } from "../domain/project/types";

export interface ProjectLibraryRecentProject {
  libraryProjectId: string;
  displayName: string;
  headRevision: number;
  stableRevision: number;
  lastOpenedAtUnixMs: number;
  hasRecovery: boolean;
}

export interface ProjectLibraryRecoveryOption {
  libraryProjectId: string;
  displayName: string;
  recoverySessionId: string;
  openedRevision: number;
  recoveryRevision: number;
  stableRevision: number;
  lastSavedAtUnixMs: number;
  hasNewerAutosave: boolean;
}

export interface ProjectLibraryRevisionOption {
  revision: number;
  sourceRevision: number | null;
  saveKind:
    "create" | "autosave" | "checkpoint" | "recovered" | "rollback" | "recoveryDiscarded";
  label: string | null;
  savedAtUnixMs: number;
  snapshotBytes: number;
}

export interface ProjectLibraryActiveProject {
  libraryProjectId: string;
  displayName: string;
  headRevision: number;
  stableRevision: number;
}

export interface ProjectLibrarySessionState {
  switchingProject: boolean;
  availability: "checking" | "ready" | "browser" | "failed";
  operation: "idle" | "opening" | "loadingHistory" | "rollingBack" | "closing";
  saveStatus: "idle" | "saving" | "saved" | "failed" | "recoverable";
  canRetrySave: boolean;
  message: string;
  recentProjects: ProjectLibraryRecentProject[];
  recoveryCandidates: ProjectLibraryRecoveryOption[];
  activeProject: ProjectLibraryActiveProject | null;
  revisionProjectId: string | null;
  revisions: ProjectLibraryRevisionOption[];
  lastSavedAtUnixMs: number | null;
  focusRequestSequence: number;
}

export interface ProjectLibraryRepository {
  query: (request: ProjectLibraryQueryRequest) => Promise<ProjectLibraryQueryReply>;
  open: (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>;
  commit: (
    request: CommitProjectLibrarySessionRequest
  ) => Promise<CommitProjectLibrarySessionReply>;
}

export interface ProjectLibrarySessionController {
  start: () => Promise<void>;
  dispatch: (intent: ProjectLibraryIntent) => Promise<void>;
  observeProject: (project: EditorProject, contentRevision: number) => void;
  close: () => Promise<boolean>;
}

export type ProjectLibraryIntent =
  | { kind: "createProject" }
  | { kind: "openRecent"; libraryProjectId: string }
  | { kind: "importBackup"; text: string; sourceFileName?: string }
  | { kind: "retrySave" }
  | {
      kind: "recoverProject";
      libraryProjectId: string;
      recoverySessionId: string;
    }
  | {
      kind: "discardRecovery";
      libraryProjectId: string;
      recoverySessionId: string;
    }
  | { kind: "loadRevisions" }
  | { kind: "rollbackToRevision"; revision: number };

export interface ProjectLibraryAppliedProjectContext {
  reason: "create" | "recent" | "importBackup" | "recover" | "discardRecovery" | "rollback";
  libraryProjectId: string;
  revision: number;
  sourceRevision?: number;
}

export function replacesCurrentProject(intent: ProjectLibraryIntent): boolean {
  return intent.kind !== "retrySave" && intent.kind !== "loadRevisions";
}

export interface ProjectLibrarySessionControllerOptions {
  repository?: ProjectLibraryRepository;
  publish: (state: ProjectLibrarySessionState) => void;
  applyProject: (
    result: ProjectParseResult,
    context: ProjectLibraryAppliedProjectContext
  ) => void;
  createClientId?: (prefix: string) => string;
  debounceMs?: number;
}

interface ActiveSession {
  libraryProjectId: string;
  sessionId: string;
  displayName: string;
  headRevision: number;
  stableRevision: number;
  acknowledgedSnapshotJson: string;
  generation: number;
}

interface PendingSave {
  project: EditorProject;
  contentRevision: number;
}

const DEFAULT_REPOSITORY: ProjectLibraryRepository = {
  query: queryTauriProjectLibrary,
  open: openTauriProjectLibrarySession,
  commit: commitTauriProjectLibrarySession
};

export function createInitialProjectLibrarySessionState(): ProjectLibrarySessionState {
  return {
    switchingProject: false,
    availability: "checking",
    operation: "idle",
    saveStatus: "idle",
    canRetrySave: false,
    message: "正在连接本机项目库…",
    recentProjects: [],
    recoveryCandidates: [],
    activeProject: null,
    revisionProjectId: null,
    revisions: [],
    lastSavedAtUnixMs: null,
    focusRequestSequence: 0
  };
}

export function createProjectLibrarySessionController(
  options: ProjectLibrarySessionControllerOptions
): ProjectLibrarySessionController {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const createClientId = options.createClientId ?? createDefaultClientId;
  const debounceMs = options.debounceMs ?? 600;
  let state = createInitialProjectLibrarySessionState();
  let startPromise: Promise<void> | null = null;
  let active: ActiveSession | null = null;
  let activeGeneration = 0;
  let lastObservedContentRevision = -1;
  let pendingSave: PendingSave | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveInFlight: Promise<void> | null = null;
  let transitionInFlight: Promise<void> | null = null;
  let bootstrapInFlight: Promise<void> | null = null;

  const readPendingSave = (): PendingSave | null => pendingSave;

  const publish = (patch: Partial<ProjectLibrarySessionState>): void => {
    state = { ...state, ...patch };
    options.publish(state);
  };

  const start = (): Promise<void> => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        const [recentValue, recoveryValue] = await Promise.all([
          queryValue(repository, { kind: "recent", limit: 20, cursor: null }),
          queryValue(repository, { kind: "recoveries" })
        ]);
        if (recentValue.kind !== "recent" || recoveryValue.kind !== "recoveries") {
          throw new Error("项目库启动查询返回了错误的数据类型。");
        }
        const recoveries = recoveryValue.recoveries.map((recovery) => ({ ...recovery }));
        publish({
          availability: "ready",
          saveStatus: recoveries.length > 0 ? "recoverable" : "idle",
          message:
            recoveries.length > 0
              ? `发现 ${recoveries.length} 个未关闭项目，请从本机项目库选择恢复。`
              : "本机项目库已就绪。",
          recentProjects: recentValue.projects.map((project) => ({
            libraryProjectId: project.libraryProjectId,
            displayName: project.displayName,
            headRevision: project.headRevision,
            stableRevision: project.stableRevision,
            lastOpenedAtUnixMs: project.lastOpenedAtUnixMs,
            hasRecovery: project.hasRecovery
          })),
          recoveryCandidates: recoveries
        });
      } catch (error: unknown) {
        publish({
          availability: "failed",
          saveStatus: "failed",
          message: formatControllerError("读取本机项目库失败", error)
        });
      }
    })();
    return startPromise;
  };

  const dispatchIntent = async (intent: ProjectLibraryIntent): Promise<void> => {
    await start();
    if (state.availability !== "ready") return;
    if (intent.kind === "createProject") {
      if (!(await closeActiveSession())) return;
      const project = createEmptyProject();
      const snapshotJson = serializeProject(project);
      publish({ operation: "opening", message: "正在创建本机项目…" });
      try {
        const reply = await repository.open({
          contractVersion: 1,
          clientRequestId: createClientId("project-create"),
          source: {
            kind: "create",
            displayName: project.name,
            projectSchemaVersion: project.schemaVersion,
            snapshotJson
          }
        });
        const opened = unwrapReply(reply);
        activeGeneration += 1;
        active = {
          libraryProjectId: opened.project.libraryProjectId,
          sessionId: opened.session.sessionId,
          displayName: opened.project.displayName,
          headRevision: opened.project.headRevision,
          stableRevision: opened.project.stableRevision,
          acknowledgedSnapshotJson: opened.snapshot.snapshotJson,
          generation: activeGeneration
        };
        pendingSave = null;
        lastObservedContentRevision = -1;
        options.applyProject(parseProjectJsonWithMetadata(opened.snapshot.snapshotJson), {
          reason: "create",
          libraryProjectId: opened.project.libraryProjectId,
          revision: opened.project.headRevision
        });
        publish({
          operation: "idle",
          saveStatus: "saved",
          message: `已保存到本机项目库 · 修订 ${opened.project.headRevision}`,
          activeProject: toActiveProject(active),
          recentProjects: upsertRecentProject(state.recentProjects, opened.project),
          lastSavedAtUnixMs: opened.snapshot.savedAtUnixMs,
          focusRequestSequence: state.focusRequestSequence + 1
        });
      } catch (error: unknown) {
        publish({
          operation: "idle",
          saveStatus: "failed",
          message: formatControllerError("创建本机项目失败", error)
        });
      }
      return;
    }
    if (intent.kind === "openRecent") {
      const recent = state.recentProjects.find(
        (candidate) => candidate.libraryProjectId === intent.libraryProjectId
      );
      if (!recent) {
        publish({ saveStatus: "failed", message: "最近项目列表已经变化，请重新选择。" });
        return;
      }
      if (
        state.recoveryCandidates.some(
          (candidate) => candidate.libraryProjectId === recent.libraryProjectId
        )
      ) {
        publish({
          saveStatus: "recoverable",
          message: `“${recent.displayName}”存在未关闭会话，请从本机项目库选择恢复。`
        });
        return;
      }
      if (!(await closeActiveSession())) return;
      publish({ operation: "opening", message: `正在打开：${recent.displayName}…` });
      try {
        const reply = await repository.open({
          contractVersion: 1,
          clientRequestId: createClientId("project-open-recent"),
          source: {
            kind: "head",
            libraryProjectId: recent.libraryProjectId,
            expectedHeadRevision: recent.headRevision
          }
        });
        const opened = unwrapReply(reply);
        const result = parseProjectJsonWithMetadata(opened.snapshot.snapshotJson);
        activateSession(opened, serializeProject(result.project));
        options.applyProject(result, {
          reason: "recent",
          libraryProjectId: opened.project.libraryProjectId,
          revision: opened.project.headRevision
        });
        publishOpenedSession(opened, `已打开：${opened.project.displayName}`);
      } catch (error: unknown) {
        publish({
          operation: "idle",
          saveStatus: "failed",
          message: formatControllerError("打开最近项目失败", error)
        });
      }
      return;
    }
    if (intent.kind === "importBackup") {
      let result: ProjectParseResult;
      try {
        result = parseProjectJsonWithMetadata(intent.text);
      } catch (error: unknown) {
        publish({
          saveStatus: "failed",
          message: formatControllerError("项目备份无法导入", error)
        });
        return;
      }
      if (!(await closeActiveSession())) return;
      const snapshotJson = serializeProject(result.project);
      publish({ operation: "opening", message: "正在把备份导入本机项目库…" });
      try {
        const reply = await repository.open({
          contractVersion: 1,
          clientRequestId: createClientId("project-import-backup"),
          source: {
            kind: "create",
            displayName: result.project.name,
            projectSchemaVersion: result.project.schemaVersion,
            snapshotJson
          }
        });
        const opened = unwrapReply(reply);
        activateSession(opened, snapshotJson);
        options.applyProject(result, {
          reason: "importBackup",
          libraryProjectId: opened.project.libraryProjectId,
          revision: opened.project.headRevision
        });
        publishOpenedSession(
          opened,
          intent.sourceFileName
            ? `已从备份 ${intent.sourceFileName} 导入并保存。`
            : "已从备份导入并保存。"
        );
      } catch (error: unknown) {
        publish({
          operation: "idle",
          saveStatus: "failed",
          message: formatControllerError("从备份导入项目失败", error)
        });
      }
      return;
    }
    if (intent.kind === "retrySave") {
      if (!pendingSave) {
        publish({ message: active ? "当前没有待重试的修改。" : "当前没有待保存的修改。" });
        return;
      }
      if (!active) {
        publish({
          saveStatus: "saving",
          canRetrySave: false,
          message: "正在重试建立本机项目…"
        });
        await bootstrapPendingProject();
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      publish({
        saveStatus: "saving",
        canRetrySave: false,
        message: "正在重试自动保存…"
      });
      await flushPendingSave();
      return;
    }
    if (intent.kind === "recoverProject") {
      const recovery = state.recoveryCandidates.find(
        (candidate) =>
          candidate.libraryProjectId === intent.libraryProjectId &&
          candidate.recoverySessionId === intent.recoverySessionId
      );
      if (!recovery) {
        publish({
          saveStatus: "failed",
          message: "恢复候选已经变化，请刷新项目库后重试。"
        });
        return;
      }
      if (!(await closeActiveSession())) return;
      publish({ operation: "opening", message: `正在恢复：${recovery.displayName}…` });
      try {
        const reply = await repository.open({
          contractVersion: 1,
          clientRequestId: createClientId("project-recover"),
          source: {
            kind: "recover",
            libraryProjectId: recovery.libraryProjectId,
            recoverySessionId: recovery.recoverySessionId,
            recoveryRevision: recovery.recoveryRevision,
            expectedHeadRevision: recovery.recoveryRevision
          }
        });
        const opened = unwrapReply(reply);
        activeGeneration += 1;
        active = {
          libraryProjectId: opened.project.libraryProjectId,
          sessionId: opened.session.sessionId,
          displayName: opened.project.displayName,
          headRevision: opened.project.headRevision,
          stableRevision: opened.project.stableRevision,
          acknowledgedSnapshotJson: opened.snapshot.snapshotJson,
          generation: activeGeneration
        };
        pendingSave = null;
        lastObservedContentRevision = -1;
        options.applyProject(parseProjectJsonWithMetadata(opened.snapshot.snapshotJson), {
          reason: "recover",
          libraryProjectId: opened.project.libraryProjectId,
          revision: opened.project.headRevision
        });
        publish({
          operation: "idle",
          saveStatus: "saved",
          message: `${recovery.hasNewerAutosave ? "已恢复自动保存内容" : "已恢复打开项目"} · 修订 ${opened.project.headRevision}`,
          activeProject: toActiveProject(active),
          recentProjects: upsertRecentProject(state.recentProjects, opened.project),
          recoveryCandidates: state.recoveryCandidates.filter(
            (candidate) => candidate.recoverySessionId !== recovery.recoverySessionId
          ),
          lastSavedAtUnixMs: opened.snapshot.savedAtUnixMs,
          focusRequestSequence: state.focusRequestSequence + 1
        });
      } catch (error: unknown) {
        publish({
          operation: "idle",
          saveStatus: "failed",
          message: formatControllerError("恢复项目失败", error)
        });
      }
      return;
    }
    if (intent.kind === "discardRecovery") {
      const recovery = state.recoveryCandidates.find(
        (candidate) =>
          candidate.libraryProjectId === intent.libraryProjectId &&
          candidate.recoverySessionId === intent.recoverySessionId
      );
      if (!recovery) {
        publish({
          saveStatus: "failed",
          message: "恢复候选已经变化，请刷新项目库后重试。"
        });
        return;
      }
      publish({ operation: "opening", message: `正在放弃恢复内容：${recovery.displayName}…` });
      try {
        const revisionValue = await queryValue(repository, {
          kind: "revision",
          libraryProjectId: recovery.libraryProjectId,
          revision: recovery.stableRevision
        });
        if (revisionValue.kind !== "revision") {
          throw new Error("项目库没有返回请求的稳定修订。");
        }
        const stableResult = parseProjectJsonWithMetadata(revisionValue.snapshot.snapshotJson);
        const snapshotJson = serializeProject(stableResult.project);
        if (!(await closeActiveSession())) return;
        const reply = await repository.open({
          contractVersion: 1,
          clientRequestId: createClientId("project-discard-recovery"),
          source: {
            kind: "discardRecovery",
            libraryProjectId: recovery.libraryProjectId,
            recoverySessionId: recovery.recoverySessionId,
            expectedHeadRevision: recovery.recoveryRevision,
            sourceRevision: recovery.stableRevision,
            displayName: stableResult.project.name,
            projectSchemaVersion: stableResult.project.schemaVersion,
            snapshotJson
          }
        });
        const opened = unwrapReply(reply);
        activeGeneration += 1;
        active = {
          libraryProjectId: opened.project.libraryProjectId,
          sessionId: opened.session.sessionId,
          displayName: opened.project.displayName,
          headRevision: opened.project.headRevision,
          stableRevision: opened.project.stableRevision,
          acknowledgedSnapshotJson: snapshotJson,
          generation: activeGeneration
        };
        pendingSave = null;
        lastObservedContentRevision = -1;
        options.applyProject(stableResult, {
          reason: "discardRecovery",
          libraryProjectId: opened.project.libraryProjectId,
          revision: opened.project.headRevision
        });
        publish({
          operation: "idle",
          saveStatus: "saved",
          message: `已放弃恢复内容并打开稳定版本 · 修订 ${opened.project.headRevision}`,
          activeProject: toActiveProject(active),
          recentProjects: upsertRecentProject(state.recentProjects, opened.project),
          recoveryCandidates: state.recoveryCandidates.filter(
            (candidate) => candidate.recoverySessionId !== recovery.recoverySessionId
          ),
          lastSavedAtUnixMs: opened.snapshot.savedAtUnixMs,
          focusRequestSequence: state.focusRequestSequence + 1
        });
      } catch (error: unknown) {
        publish({
          operation: "idle",
          saveStatus: "failed",
          message: formatControllerError("放弃恢复内容失败", error)
        });
      }
      return;
    }
    if (intent.kind === "loadRevisions") {
      if (!active) {
        publish({ message: "请先从项目库创建或打开一个项目。", saveStatus: "failed" });
        return;
      }
      const sessionAtStart = active;
      publish({ operation: "loadingHistory", message: "正在读取版本记录…" });
      try {
        const value = await queryValue(repository, {
          kind: "revisions",
          libraryProjectId: sessionAtStart.libraryProjectId,
          beforeRevision: null,
          limit: 50
        });
        if (value.kind !== "revisions") {
          throw new Error("项目库没有返回版本记录。");
        }
        if (!active || active.generation !== sessionAtStart.generation) return;
        publish({
          operation: "idle",
          message: `已读取 ${value.revisions.length} 条版本记录。`,
          revisionProjectId: value.project.libraryProjectId,
          revisions: value.revisions.map((revision) => ({
            revision: revision.revision,
            sourceRevision: revision.sourceRevision,
            saveKind: revision.saveKind,
            label: revision.label,
            savedAtUnixMs: revision.savedAtUnixMs,
            snapshotBytes: revision.snapshotBytes
          }))
        });
      } catch (error: unknown) {
        publish({
          operation: "idle",
          message: formatControllerError("读取版本记录失败", error)
        });
      }
      return;
    }
    if (intent.kind === "rollbackToRevision") {
      if (!active) {
        publish({ message: "请先打开要回退的项目。", saveStatus: "failed" });
        return;
      }
      if (!(await drainPendingSaves())) return;
      const sessionAtStart = active;
      if (!sessionAtStart) return;
      publish({ operation: "rollingBack", message: `正在回退到修订 ${intent.revision}…` });
      try {
        const value = await queryValue(repository, {
          kind: "revision",
          libraryProjectId: sessionAtStart.libraryProjectId,
          revision: intent.revision
        });
        if (value.kind !== "revision") {
          throw new Error("项目库没有返回所选修订。");
        }
        const result = parseProjectJsonWithMetadata(value.snapshot.snapshotJson);
        const snapshotJson = serializeProject(result.project);
        if (!(await drainPendingSaves())) return;
        const sessionForCommit = active;
        if (
          !sessionForCommit ||
          sessionForCommit.generation !== sessionAtStart.generation ||
          sessionForCommit.libraryProjectId !== sessionAtStart.libraryProjectId
        ) {
          return;
        }
        const reply = await repository.commit({
          contractVersion: 1,
          libraryProjectId: sessionForCommit.libraryProjectId,
          sessionId: sessionForCommit.sessionId,
          clientMutationId: createClientId("project-rollback"),
          expectedHeadRevision: sessionForCommit.headRevision,
          change: {
            kind: "save",
            saveKind: "rollback",
            sourceRevision: intent.revision,
            label: `回退到修订 ${intent.revision}`,
            displayName: result.project.name,
            projectSchemaVersion: result.project.schemaVersion,
            snapshotJson
          }
        });
        const committed = unwrapReply(reply);
        if (!active || active.generation !== sessionForCommit.generation) return;
        active = {
          ...active,
          displayName: result.project.name,
          headRevision: committed.headRevision,
          stableRevision: committed.stableRevision,
          acknowledgedSnapshotJson: snapshotJson
        };
        pendingSave = null;
        options.applyProject(result, {
          reason: "rollback",
          libraryProjectId: active.libraryProjectId,
          revision: committed.headRevision,
          sourceRevision: intent.revision
        });
        publish({
          operation: "idle",
          saveStatus: "saved",
          message: `已把修订 ${intent.revision} 追加为当前修订 ${committed.headRevision}。`,
          activeProject: toActiveProject(active),
          recentProjects: upsertActiveRecentProject(
            state.recentProjects,
            active,
            committed.occurredAtUnixMs
          ),
          revisionProjectId: null,
          revisions: [],
          lastSavedAtUnixMs: committed.occurredAtUnixMs,
          focusRequestSequence: state.focusRequestSequence + 1
        });
      } catch (error: unknown) {
        publish({
          operation: "idle",
          saveStatus: "failed",
          message: formatControllerError("版本回退失败", error)
        });
      }
    }
  };

  const dispatch = (intent: ProjectLibraryIntent): Promise<void> => {
    if (transitionInFlight || bootstrapInFlight) {
      publish({ message: "项目库正在处理上一项操作，请稍候。" });
      return Promise.resolve();
    }
    const replacing = replacesCurrentProject(intent);
    if (replacing) publish({ switchingProject: true });
    const operation = dispatchIntent(intent);
    transitionInFlight = operation;
    void operation.finally(() => {
      if (transitionInFlight === operation) transitionInFlight = null;
      if (replacing) publish({ switchingProject: false });
    });
    return operation;
  };

  const observeProject = (project: EditorProject, contentRevision: number): void => {
    if (state.switchingProject) return;
    if (contentRevision <= lastObservedContentRevision) return;
    lastObservedContentRevision = contentRevision;
    pendingSave = { project, contentRevision };
    publish({
      saveStatus: "saving",
      canRetrySave: false,
      message: "正在自动保存…"
    });
    if (!active) {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      void bootstrapPendingProject();
      return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPendingSave();
    }, debounceMs);
  };

  const flushPendingSave = (): Promise<void> => {
    if (saveInFlight || !active || !pendingSave) return saveInFlight ?? Promise.resolve();
    const observation = pendingSave;
    pendingSave = null;
    const snapshotJson = serializeProject(observation.project);
    if (snapshotJson === active.acknowledgedSnapshotJson) {
      if (!pendingSave) {
        publish({ saveStatus: "saved", message: `已保存 · 修订 ${active.headRevision}` });
      }
      return Promise.resolve();
    }
    const sessionAtStart = active;
    const operation = (async () => {
      try {
        const reply = await repository.commit({
          contractVersion: 1,
          libraryProjectId: sessionAtStart.libraryProjectId,
          sessionId: sessionAtStart.sessionId,
          clientMutationId: createClientId(`autosave-${observation.contentRevision}`),
          expectedHeadRevision: sessionAtStart.headRevision,
          change: {
            kind: "save",
            saveKind: "autosave",
            sourceRevision: null,
            label: null,
            displayName: observation.project.name,
            projectSchemaVersion: observation.project.schemaVersion,
            snapshotJson
          }
        });
        const committed = unwrapReply(reply);
        if (!active || active.generation !== sessionAtStart.generation) return;
        active = {
          ...active,
          displayName: observation.project.name,
          headRevision: committed.headRevision,
          stableRevision: committed.stableRevision,
          acknowledgedSnapshotJson: snapshotJson
        };
        publish({
          saveStatus: pendingSave ? "saving" : "saved",
          canRetrySave: false,
          message: pendingSave
            ? "检测到更新内容，正在继续自动保存…"
            : `已保存 · 修订 ${committed.headRevision}`,
          activeProject: toActiveProject(active),
          recentProjects: upsertActiveRecentProject(
            state.recentProjects,
            active,
            committed.occurredAtUnixMs
          ),
          lastSavedAtUnixMs: committed.occurredAtUnixMs
        });
      } catch (error: unknown) {
        if (!active || active.generation !== sessionAtStart.generation) return;
        const latestPending = readPendingSave();
        if (!latestPending || latestPending.contentRevision < observation.contentRevision) {
          pendingSave = observation;
        }
        publish({
          saveStatus: "failed",
          canRetrySave: true,
          message: formatControllerError("自动保存失败，当前修改仍保留在内存中", error)
        });
      }
    })();
    saveInFlight = operation;
    void operation.finally(() => {
      if (saveInFlight !== operation) return;
      saveInFlight = null;
      if (pendingSave && state.saveStatus !== "failed") {
        void flushPendingSave();
      }
    });
    return operation;
  };

  const drainPendingSaves = async (): Promise<boolean> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    while (saveInFlight || pendingSave) {
      if (!saveInFlight) {
        await flushPendingSave();
      } else {
        await saveInFlight;
      }
      if (state.saveStatus === "failed") return false;
    }
    return true;
  };

  const bootstrapPendingProject = (): Promise<void> => {
    if (state.switchingProject || bootstrapInFlight || active || !pendingSave) {
      return bootstrapInFlight ?? Promise.resolve();
    }
    const operation = (async () => {
      await start();
      if (state.availability !== "ready" || active || !pendingSave) return;
      const observation = pendingSave;
      pendingSave = null;
      const snapshotJson = serializeProject(observation.project);
      publish({ operation: "opening", saveStatus: "saving", message: "正在建立本机项目…" });
      try {
        const reply = await repository.open({
          contractVersion: 1,
          clientRequestId: createClientId("project-autocreate"),
          source: {
            kind: "create",
            displayName: observation.project.name,
            projectSchemaVersion: observation.project.schemaVersion,
            snapshotJson
          }
        });
        const opened = unwrapReply(reply);
        if (opened.snapshot.snapshotJson !== snapshotJson) {
          throw new Error("本机项目库返回的创建快照与提交内容不一致。");
        }
        const queuedAfterOpen = readPendingSave();
        activateSession(opened, snapshotJson);
        pendingSave = queuedAfterOpen;
        lastObservedContentRevision = Math.max(
          observation.contentRevision,
          queuedAfterOpen?.contentRevision ?? observation.contentRevision
        );
        if (!active) return;
        publish({
          operation: "idle",
          saveStatus: queuedAfterOpen ? "saving" : "saved",
          canRetrySave: false,
          message: queuedAfterOpen
            ? "本机项目已建立，正在保存后续修改…"
            : `已保存到本机项目库 · 修订 ${opened.project.headRevision}`,
          activeProject: toActiveProject(active),
          recentProjects: upsertRecentProject(state.recentProjects, opened.project),
          lastSavedAtUnixMs: opened.snapshot.savedAtUnixMs
        });
        if (queuedAfterOpen) void flushPendingSave();
      } catch (error: unknown) {
        const latestPending = readPendingSave();
        if (!latestPending || latestPending.contentRevision < observation.contentRevision) {
          pendingSave = observation;
        }
        publish({
          operation: "idle",
          saveStatus: "failed",
          canRetrySave: true,
          message: formatControllerError("建立本机项目失败，当前修改仍保留在内存中", error)
        });
      }
    })();
    bootstrapInFlight = operation;
    void operation.finally(() => {
      if (bootstrapInFlight === operation) bootstrapInFlight = null;
    });
    return operation;
  };

  const activateSession = (
    opened: Extract<OpenProjectLibrarySessionReply, { ok: true }>["value"],
    acknowledgedSnapshotJson: string
  ): void => {
    activeGeneration += 1;
    active = {
      libraryProjectId: opened.project.libraryProjectId,
      sessionId: opened.session.sessionId,
      displayName: opened.project.displayName,
      headRevision: opened.project.headRevision,
      stableRevision: opened.project.stableRevision,
      acknowledgedSnapshotJson,
      generation: activeGeneration
    };
    pendingSave = null;
    lastObservedContentRevision = -1;
  };

  const publishOpenedSession = (
    opened: Extract<OpenProjectLibrarySessionReply, { ok: true }>["value"],
    message: string
  ): void => {
    if (!active) return;
    publish({
      operation: "idle",
      saveStatus: "saved",
      canRetrySave: false,
      message,
      activeProject: toActiveProject(active),
      recentProjects: upsertRecentProject(state.recentProjects, opened.project),
      lastSavedAtUnixMs: opened.snapshot.savedAtUnixMs,
      focusRequestSequence: state.focusRequestSequence + 1
    });
  };

  const closeActiveSession = async (): Promise<boolean> => {
    if (!active) return true;
    if (!(await drainPendingSaves())) return false;
    const sessionAtStart = active;
    if (!sessionAtStart) return true;
    publish({ operation: "closing", message: "正在安全关闭当前项目…" });
    try {
      const reply = await repository.commit({
        contractVersion: 1,
        libraryProjectId: sessionAtStart.libraryProjectId,
        sessionId: sessionAtStart.sessionId,
        clientMutationId: createClientId("project-close"),
        expectedHeadRevision: sessionAtStart.headRevision,
        change: { kind: "close" }
      });
      const committed = unwrapReply(reply);
      if (!committed.sessionClosed) {
        throw new Error("本机项目库未确认会话已经关闭。");
      }
      if (!active || active.generation !== sessionAtStart.generation) return false;
      const closedRecentProjects = upsertActiveRecentProject(
        state.recentProjects,
        {
          ...sessionAtStart,
          headRevision: committed.headRevision,
          stableRevision: committed.stableRevision
        },
        committed.occurredAtUnixMs
      );
      activeGeneration += 1;
      active = null;
      pendingSave = null;
      lastObservedContentRevision = -1;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      publish({
        operation: "idle",
        saveStatus: "idle",
        canRetrySave: false,
        message: "当前项目已安全关闭。",
        activeProject: null,
        recentProjects: closedRecentProjects,
        revisionProjectId: null,
        revisions: [],
        lastSavedAtUnixMs: committed.occurredAtUnixMs
      });
      return true;
    } catch (error: unknown) {
      publish({
        operation: "idle",
        saveStatus: "failed",
        canRetrySave: false,
        message: formatControllerError("关闭当前项目失败，未切换项目", error)
      });
      return false;
    }
  };

  const closeController = async (): Promise<boolean> => {
    if (bootstrapInFlight) await bootstrapInFlight;
    if (transitionInFlight) await transitionInFlight;
    return closeActiveSession();
  };

  return { start, dispatch, observeProject, close: closeController };
}

async function queryValue(
  repository: ProjectLibraryRepository,
  query: ProjectLibraryQueryRequest["query"]
): Promise<Extract<ProjectLibraryQueryReply, { ok: true }>["value"]> {
  const reply = await repository.query({ contractVersion: 1, query });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

function formatControllerError(prefix: string, error: unknown): string {
  const detail = error instanceof Error && error.message.trim() ? error.message : String(error);
  return `${prefix}：${detail}`;
}

function unwrapReply<T>(
  reply: { ok: true; value: T } | { ok: false; error: { message: string } }
): T {
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.value;
}

function toActiveProject(active: ActiveSession): ProjectLibraryActiveProject {
  return {
    libraryProjectId: active.libraryProjectId,
    displayName: active.displayName,
    headRevision: active.headRevision,
    stableRevision: active.stableRevision
  };
}

function upsertRecentProject(
  current: readonly ProjectLibraryRecentProject[],
  project: {
    libraryProjectId: string;
    displayName: string;
    headRevision: number;
    stableRevision: number;
    lastOpenedAtUnixMs: number;
    hasRecovery: boolean;
  }
): ProjectLibraryRecentProject[] {
  const next = {
    libraryProjectId: project.libraryProjectId,
    displayName: project.displayName,
    headRevision: project.headRevision,
    stableRevision: project.stableRevision,
    lastOpenedAtUnixMs: project.lastOpenedAtUnixMs,
    hasRecovery: project.hasRecovery
  };
  return [next, ...current.filter((item) => item.libraryProjectId !== next.libraryProjectId)];
}

function upsertActiveRecentProject(
  current: readonly ProjectLibraryRecentProject[],
  active: ActiveSession,
  occurredAtUnixMs: number
): ProjectLibraryRecentProject[] {
  const existing = current.find(
    (project) => project.libraryProjectId === active.libraryProjectId
  );
  return upsertRecentProject(current, {
    libraryProjectId: active.libraryProjectId,
    displayName: active.displayName,
    headRevision: active.headRevision,
    stableRevision: active.stableRevision,
    lastOpenedAtUnixMs: existing?.lastOpenedAtUnixMs ?? occurredAtUnixMs,
    hasRecovery: false
  });
}

let fallbackClientSequence = 0;
function createDefaultClientId(prefix: string): string {
  const randomPart =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++fallbackClientSequence}`;
  return `${prefix}-${randomPart}`;
}
