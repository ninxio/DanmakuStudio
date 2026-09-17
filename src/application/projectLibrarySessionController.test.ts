import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../domain/project/factory";
import { CURRENT_SCHEMA_VERSION } from "../domain/project/types";
import type {
  CommitProjectLibrarySessionReply,
  CommitProjectLibrarySessionRequest,
  OpenProjectLibrarySessionReply,
  OpenProjectLibrarySessionRequest,
  ProjectLibraryQueryReply,
  ProjectLibraryQueryRequest
} from "../infrastructure/persistence/tauriProjectLibrary";
import {
  createProjectLibrarySessionController,
  type ProjectLibraryRepository,
  type ProjectLibrarySessionState
} from "./projectLibrarySessionController";

describe("project library session controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("explicit creation synchronously locks replacement and cannot start a concurrent auto-create", async () => {
    const opening = deferred<OpenProjectLibrarySessionReply>();
    const open = vi.fn<ProjectLibraryRepository["open"]>(() => opening.promise);
    const publications: ProjectLibrarySessionState[] = [];
    const applyProject = vi.fn();
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open
      }),
      publish: (state) => publications.push(state),
      applyProject
    });
    await controller.start();
    const creating = controller.dispatch({ kind: "createProject" });
    expect(publications.at(-1)?.switchingProject).toBe(true);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    controller.observeProject(createEmptyProject("late import during switch"), 1);
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    opening.resolve(createOpenReply(open.mock.calls[0][0]));
    await creating;
    expect(publications.at(-1)?.switchingProject).toBe(false);
    expect(applyProject).toHaveBeenCalledOnce();
    expect(publications.at(-1)?.activeProject?.displayName).toBe("未命名项目");
  });

  it("retries a failed initial auto-create without being blocked by its own dispatch", async () => {
    const open = vi
      .fn<ProjectLibraryRepository["open"]>()
      .mockRejectedValueOnce(new Error("temporary disk failure"))
      .mockImplementation((request) => resolved(createOpenReply(request)));
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open
      }),
      publish: (state) => publications.push(state),
      applyProject: vi.fn()
    });
    await controller.start();
    controller.observeProject(createEmptyProject("retain my import"), 1);
    await vi.waitFor(() => expect(publications.at(-1)?.canRetrySave).toBe(true));
    await controller.dispatch({ kind: "retrySave" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(publications.at(-1)).toMatchObject({ saveStatus: "saved", switchingProject: false });
  });

  it("启动只读取最近项目与恢复候选，不预读任何 snapshot", async () => {
    const query = vi.fn<
      (request: ProjectLibraryQueryRequest) => Promise<ProjectLibraryQueryReply>
    >((request) => {
      if (request.query.kind === "recent") {
        return resolved(recentReply());
      }
      if (request.query.kind === "recoveries") {
        return resolved(recoveryReply());
      }
      throw new Error(`启动不应查询 ${request.query.kind}`);
    });
    const repository = createRepository({ query });
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository,
      publish: (state) => publications.push(state),
      applyProject: vi.fn(),
      createClientId: createSequentialId()
    });

    await controller.start();

    expect(query.mock.calls.map(([request]) => request.query.kind)).toEqual([
      "recent",
      "recoveries"
    ]);
    expect(repository.open).not.toHaveBeenCalled();
    expect(repository.commit).not.toHaveBeenCalled();
    expect(publications.at(-1)).toMatchObject({
      availability: "ready",
      saveStatus: "recoverable",
      message: "发现 1 个未关闭项目，请从本机项目库选择恢复。",
      recentProjects: [
        {
          libraryProjectId: "library-a",
          displayName: "最近项目 A",
          headRevision: 3,
          hasRecovery: true
        }
      ],
      recoveryCandidates: [
        {
          libraryProjectId: "library-a",
          recoverySessionId: "abandoned-session",
          recoveryRevision: 3,
          stableRevision: 2
        }
      ]
    });
  });

  it("自动保存最多一个 in-flight，并在旧回执后只提交合并后的 latest", async () => {
    vi.useFakeTimers();
    const firstCommit = deferred<CommitProjectLibrarySessionReply>();
    const secondCommit = deferred<CommitProjectLibrarySessionReply>();
    const commit = vi
      .fn<
        (
          request: CommitProjectLibrarySessionRequest
        ) => Promise<CommitProjectLibrarySessionReply>
      >()
      .mockReturnValueOnce(firstCommit.promise)
      .mockReturnValueOnce(secondCommit.promise);
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(createOpenReply(request)));
    const publications: ProjectLibrarySessionState[] = [];
    const applyProject = vi.fn();
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open,
        commit
      }),
      publish: (state) => publications.push(state),
      applyProject,
      createClientId: createSequentialId(),
      debounceMs: 100
    });
    await controller.start();
    await controller.dispatch({ kind: "createProject" });
    expect(applyProject).toHaveBeenCalledOnce();

    const initial = createEmptyProject("自动保存");
    controller.observeProject({ ...initial, name: "第一次修改" }, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0][0]).toMatchObject({
      expectedHeadRevision: 1,
      change: { kind: "save", saveKind: "autosave", displayName: "第一次修改" }
    });

    controller.observeProject({ ...initial, name: "应被合并" }, 2);
    controller.observeProject({ ...initial, name: "最终修改" }, 3);
    await vi.advanceTimersByTimeAsync(100);
    expect(commit).toHaveBeenCalledOnce();
    const savedCountBeforeFirstAck = publications.filter(
      (state) => state.saveStatus === "saved"
    ).length;

    firstCommit.resolve(commitReply(2, 1, 2_000));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls[1][0]).toMatchObject({
      expectedHeadRevision: 2,
      change: { kind: "save", saveKind: "autosave", displayName: "最终修改" }
    });
    expect(publications.filter((state) => state.saveStatus === "saved")).toHaveLength(
      savedCountBeforeFirstAck
    );

    secondCommit.resolve(commitReply(3, 1, 3_000));
    await vi.waitFor(() =>
      expect(publications.at(-1)).toMatchObject({
        saveStatus: "saved",
        lastSavedAtUnixMs: 3_000,
        activeProject: { headRevision: 3 }
      })
    );
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("空白桌面会话的首次领域提交会建立项目库 session，且不重置 store 项目", async () => {
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(createOpenReply(request)));
    const applyProject = vi.fn();
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open
      }),
      publish: (state) => publications.push(state),
      applyProject,
      createClientId: createSequentialId(),
      debounceMs: 10
    });
    await controller.start();

    controller.observeProject(createEmptyProject("首次导入后的项目"), 1);

    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open.mock.calls[0][0]).toMatchObject({
      source: { kind: "create", displayName: "首次导入后的项目" }
    });
    expect(applyProject).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(publications.at(-1)).toMatchObject({
        activeProject: { libraryProjectId: "library-created" },
        saveStatus: "saved"
      })
    );
  });

  it("恢复候选只在明确 recover intent 后打开，并把恢复决定追加为新修订", async () => {
    const recoveredProject = createEmptyProject("恢复后的项目");
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(recoveryOpenReply(request, recoveredProject)));
    const applyProject = vi.fn();
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) => {
          if (request.query.kind === "recent") return resolved(recentReply());
          if (request.query.kind === "recoveries") return resolved(recoveryReply());
          throw new Error("恢复测试不应读取 snapshot。");
        }),
        open
      }),
      publish: (state) => publications.push(state),
      applyProject,
      createClientId: createSequentialId()
    });

    await controller.start();
    expect(open).not.toHaveBeenCalled();

    await controller.dispatch({
      kind: "recoverProject",
      libraryProjectId: "library-a",
      recoverySessionId: "abandoned-session"
    });

    expect(open).toHaveBeenCalledWith({
      contractVersion: 1,
      clientRequestId: "project-recover-1",
      source: {
        kind: "recover",
        libraryProjectId: "library-a",
        recoverySessionId: "abandoned-session",
        recoveryRevision: 3,
        expectedHeadRevision: 3
      }
    });
    expect(applyProject).toHaveBeenCalledWith(expect.any(Object), {
      reason: "recover",
      libraryProjectId: "library-a",
      revision: 4
    });
    expect(publications.at(-1)).toMatchObject({
      saveStatus: "saved",
      recoveryCandidates: [],
      activeProject: { libraryProjectId: "library-a", headRevision: 4, stableRevision: 2 },
      message: "已恢复自动保存内容 · 修订 4"
    });
  });

  it("放弃恢复会先读取稳定修订，再以 recoveryDiscarded 新修订打开", async () => {
    const stableProject = createEmptyProject("稳定版本");
    const stableSnapshotJson = JSON.stringify(stableProject);
    const query = vi.fn<
      (request: ProjectLibraryQueryRequest) => Promise<ProjectLibraryQueryReply>
    >((request) => {
      if (request.query.kind === "recent") return resolved(recentReply());
      if (request.query.kind === "recoveries") return resolved(recoveryReply());
      if (request.query.kind === "revision" && request.query.revision === 2) {
        return resolved(revisionReply("library-a", 2, stableSnapshotJson, stableProject.name));
      }
      throw new Error(`没有为 ${request.query.kind} 提供响应。`);
    });
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(discardOpenReply(request)));
    const applyProject = vi.fn();
    const controller = createProjectLibrarySessionController({
      repository: createRepository({ query, open }),
      publish: vi.fn(),
      applyProject,
      createClientId: createSequentialId()
    });
    await controller.start();

    await controller.dispatch({
      kind: "discardRecovery",
      libraryProjectId: "library-a",
      recoverySessionId: "abandoned-session"
    });

    expect(query.mock.calls.map(([request]) => request.query.kind)).toEqual([
      "recent",
      "recoveries",
      "revision"
    ]);
    const discardRequest = open.mock.calls[0]?.[0];
    expect(discardRequest).toMatchObject({
      contractVersion: 1,
      clientRequestId: "project-discard-recovery-1",
      source: {
        kind: "discardRecovery",
        libraryProjectId: "library-a",
        recoverySessionId: "abandoned-session",
        expectedHeadRevision: 3,
        sourceRevision: 2,
        displayName: "稳定版本",
        projectSchemaVersion: CURRENT_SCHEMA_VERSION
      }
    });
    if (!discardRequest || discardRequest.source.kind !== "discardRecovery") {
      throw new Error("放弃恢复没有发出 discardRecovery 请求。");
    }
    expect(discardRequest.source.snapshotJson).toContain(
      `"schemaVersion": ${CURRENT_SCHEMA_VERSION}`
    );
    expect(applyProject).toHaveBeenCalledWith(expect.any(Object), {
      reason: "discardRecovery",
      libraryProjectId: "library-a",
      revision: 4
    });
  });

  it("历史回退读取所选 snapshot，并以 rollback 追加新 head 而不倒退指针", async () => {
    const originalProject = createEmptyProject("原始版本");
    const query = vi.fn<
      (request: ProjectLibraryQueryRequest) => Promise<ProjectLibraryQueryReply>
    >((request) => {
      if (request.query.kind === "recent" || request.query.kind === "recoveries") {
        return resolved(emptyQueryReply(request));
      }
      if (request.query.kind === "revisions") {
        return resolved(revisionsReply(request.query.libraryProjectId, 2));
      }
      if (request.query.kind === "revision" && request.query.revision === 1) {
        return resolved(
          revisionReply(
            request.query.libraryProjectId,
            1,
            JSON.stringify(originalProject),
            originalProject.name
          )
        );
      }
      throw new Error(`没有为 ${request.query.kind} 提供响应。`);
    });
    const commit = vi.fn<
      (request: CommitProjectLibrarySessionRequest) => Promise<CommitProjectLibrarySessionReply>
    >(() => resolved(commitReply(2, 2, 5_000)));
    const applyProject = vi.fn();
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query,
        open: vi.fn((request: OpenProjectLibrarySessionRequest) =>
          resolved(createOpenReply(request))
        ),
        commit
      }),
      publish: (state) => publications.push(state),
      applyProject,
      createClientId: createSequentialId()
    });
    await controller.start();
    await controller.dispatch({ kind: "createProject" });

    await controller.dispatch({ kind: "loadRevisions" });
    expect(publications.at(-1)).toMatchObject({
      revisionProjectId: "library-created",
      revisions: [{ revision: 1, saveKind: "create" }]
    });

    await controller.dispatch({ kind: "rollbackToRevision", revision: 1 });

    const rollbackRequest = commit.mock.calls[0]?.[0];
    expect(rollbackRequest).toMatchObject({
      contractVersion: 1,
      libraryProjectId: "library-created",
      sessionId: "session-created",
      clientMutationId: "project-rollback-2",
      expectedHeadRevision: 1,
      change: {
        kind: "save",
        saveKind: "rollback",
        sourceRevision: 1,
        label: "回退到修订 1",
        displayName: "原始版本",
        projectSchemaVersion: CURRENT_SCHEMA_VERSION
      }
    });
    if (!rollbackRequest || rollbackRequest.change.kind !== "save") {
      throw new Error("版本回退没有发出 save 请求。");
    }
    expect(rollbackRequest.change.snapshotJson).toContain(
      `"schemaVersion": ${CURRENT_SCHEMA_VERSION}`
    );
    expect(applyProject).toHaveBeenCalledWith(expect.any(Object), {
      reason: "rollback",
      libraryProjectId: "library-created",
      revision: 2,
      sourceRevision: 1
    });
    expect(publications.at(-1)).toMatchObject({
      activeProject: { headRevision: 2, stableRevision: 2 },
      saveStatus: "saved",
      message: "已把修订 1 追加为当前修订 2。"
    });
  });

  it("切项目先 drain 最新修改并 clean close，完成前不打开下一个项目", async () => {
    vi.useFakeTimers();
    const autosave = deferred<CommitProjectLibrarySessionReply>();
    const calls: string[] = [];
    let openCount = 0;
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => {
      openCount += 1;
      calls.push(`open-${openCount}`);
      return resolved(createOpenReply(request, openCount));
    });
    const commit = vi.fn<
      (request: CommitProjectLibrarySessionRequest) => Promise<CommitProjectLibrarySessionReply>
    >((request) => {
      if (request.change.kind === "save") {
        calls.push("autosave");
        return autosave.promise;
      }
      calls.push("close");
      return resolved(closeReply(request, 2, 2));
    });
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open,
        commit
      }),
      publish: vi.fn(),
      applyProject: vi.fn(),
      createClientId: createSequentialId(),
      debounceMs: 100
    });
    await controller.start();
    await controller.dispatch({ kind: "createProject" });
    controller.observeProject(createEmptyProject("切换前最新内容"), 1);
    await vi.advanceTimersByTimeAsync(100);

    const switching = controller.dispatch({ kind: "createProject" });
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    expect(calls).toEqual(["open-1", "autosave"]);

    autosave.resolve(commitReply(2, 1, 2_000));
    await switching;

    expect(calls).toEqual(["open-1", "autosave", "close", "open-2"]);
    expect(commit.mock.calls[1][0]).toMatchObject({
      expectedHeadRevision: 2,
      change: { kind: "close" }
    });
  });

  it("最近项目按 head 打开，带恢复候选时不静默裁决", async () => {
    const openedProject = createEmptyProject("最近项目 A");
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(headOpenReply(request, openedProject)));
    const applyProject = vi.fn();
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(request.query.kind === "recent" ? recentReply() : recoveryReply())
        ),
        open
      }),
      publish: (state) => publications.push(state),
      applyProject,
      createClientId: createSequentialId()
    });
    await controller.start();

    await controller.dispatch({ kind: "openRecent", libraryProjectId: "library-a" });

    expect(open).not.toHaveBeenCalled();
    expect(applyProject).not.toHaveBeenCalled();
    expect(publications.at(-1)).toMatchObject({
      saveStatus: "recoverable",
      message: "“最近项目 A”存在未关闭会话，请从本机项目库选择恢复。"
    });
  });

  it("活跃实例没有恢复候选时询问后端占用状态，不指向空恢复列表", async () => {
    const open = vi.fn<ProjectLibraryRepository["open"]>().mockResolvedValue({
      contractVersion: 1,
      ok: false,
      error: {
        code: "projectAlreadyOpen",
        message: "请先在另一实例保存并关闭项目。",
        retryable: false,
        actualHeadRevision: null
      }
    });
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(request.query.kind === "recent" ? recentReply() : emptyQueryReply(request))
        ),
        open
      }),
      publish: (state) => publications.push(state),
      applyProject: vi.fn()
    });
    await controller.start();
    await controller.dispatch({ kind: "openRecent", libraryProjectId: "library-a" });
    expect(open).toHaveBeenCalledOnce();
    expect(publications.at(-1)?.message).toContain("请先在另一实例保存并关闭项目");
  });

  it("无恢复冲突的最近项目按已知 head 打开并应用已解析 snapshot", async () => {
    const openedProject = createEmptyProject("最近项目 A");
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(headOpenReply(request, openedProject)));
    const applyProject = vi.fn();
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(
            request.query.kind === "recent"
              ? recentWithoutRecoveryReply()
              : emptyQueryReply(request)
          )
        ),
        open
      }),
      publish: vi.fn(),
      applyProject,
      createClientId: createSequentialId()
    });
    await controller.start();

    await controller.dispatch({ kind: "openRecent", libraryProjectId: "library-a" });

    expect(open).toHaveBeenCalledWith({
      contractVersion: 1,
      clientRequestId: "project-open-recent-1",
      source: { kind: "head", libraryProjectId: "library-a", expectedHeadRevision: 3 }
    });
    expect(applyProject).toHaveBeenCalledWith(expect.any(Object), {
      reason: "recent",
      libraryProjectId: "library-a",
      revision: 3
    });
  });

  it("有效备份在关闭旧会话后进入本机项目库，无效备份不触碰当前会话", async () => {
    let openCount = 0;
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(createOpenReply(request, ++openCount)));
    const commit = vi.fn<
      (request: CommitProjectLibrarySessionRequest) => Promise<CommitProjectLibrarySessionReply>
    >((request) => resolved(closeReply(request, 1, 1)));
    const applyProject = vi.fn();
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open,
        commit
      }),
      publish: (state) => publications.push(state),
      applyProject,
      createClientId: createSequentialId()
    });
    await controller.start();
    await controller.dispatch({ kind: "createProject" });

    await controller.dispatch({
      kind: "importBackup",
      text: "not-json",
      sourceFileName: "坏.json"
    });
    expect(commit).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();

    const backup = createEmptyProject("备份项目");
    await controller.dispatch({
      kind: "importBackup",
      text: JSON.stringify(backup),
      sourceFileName: "备份.json"
    });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ change: { kind: "close" } }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1][0]).toMatchObject({
      source: { kind: "create", displayName: "备份项目" }
    });
    expect(applyProject).toHaveBeenLastCalledWith(expect.any(Object), {
      reason: "importBackup",
      libraryProjectId: "library-created-2",
      revision: 1
    });
    expect(publications.at(-1)).toMatchObject({
      saveStatus: "saved",
      message: "已从备份 备份.json 导入并保存。"
    });
  });

  it("自动保存失败时不假成功，也不关闭或打开下一个项目", async () => {
    vi.useFakeTimers();
    const commit = vi.fn<
      (request: CommitProjectLibrarySessionRequest) => Promise<CommitProjectLibrarySessionReply>
    >(() => resolved(failedCommitReply("storageFull", "磁盘空间不足")));
    const open = vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >((request) => resolved(createOpenReply(request)));
    const publications: ProjectLibrarySessionState[] = [];
    const controller = createProjectLibrarySessionController({
      repository: createRepository({
        query: vi.fn((request: ProjectLibraryQueryRequest) =>
          resolved(emptyQueryReply(request))
        ),
        open,
        commit
      }),
      publish: (state) => publications.push(state),
      applyProject: vi.fn(),
      createClientId: createSequentialId(),
      debounceMs: 100
    });
    await controller.start();
    await controller.dispatch({ kind: "createProject" });
    controller.observeProject(createEmptyProject("未保存修改"), 1);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(publications.at(-1)?.saveStatus).toBe("failed"));

    await controller.dispatch({ kind: "createProject" });

    expect(open).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls.every(([request]) => request.change.kind === "save")).toBe(true);
    expect(publications.at(-1)?.saveStatus).toBe("failed");
    expect(publications.at(-1)?.message).toContain("自动保存失败");
  });
});

function createRepository(
  overrides: Partial<ProjectLibraryRepository> = {}
): ProjectLibraryRepository {
  return {
    query: vi.fn<(request: ProjectLibraryQueryRequest) => Promise<ProjectLibraryQueryReply>>(),
    open: vi.fn<
      (request: OpenProjectLibrarySessionRequest) => Promise<OpenProjectLibrarySessionReply>
    >(),
    commit:
      vi.fn<
        (
          request: CommitProjectLibrarySessionRequest
        ) => Promise<CommitProjectLibrarySessionReply>
      >(),
    ...overrides
  };
}

function recentReply(): ProjectLibraryQueryReply {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      kind: "recent",
      projects: [
        {
          libraryProjectId: "library-a",
          displayName: "最近项目 A",
          projectSchemaVersion: 17,
          headRevision: 3,
          stableRevision: 2,
          createdAtUnixMs: 1_000,
          updatedAtUnixMs: 3_000,
          lastOpenedAtUnixMs: 3_000,
          hasRecovery: true
        }
      ],
      nextCursor: null
    }
  };
}

function recentWithoutRecoveryReply(): ProjectLibraryQueryReply {
  const reply = recentReply();
  if (!reply.ok || reply.value.kind !== "recent") throw new Error("最近项目 fixture 无效。");
  return {
    ...reply,
    value: {
      ...reply.value,
      projects: reply.value.projects.map((project) => ({ ...project, hasRecovery: false }))
    }
  };
}

function recoveryReply(): ProjectLibraryQueryReply {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      kind: "recoveries",
      recoveries: [
        {
          libraryProjectId: "library-a",
          displayName: "最近项目 A",
          recoverySessionId: "abandoned-session",
          openedRevision: 2,
          recoveryRevision: 3,
          stableRevision: 2,
          lastSavedAtUnixMs: 3_000,
          hasNewerAutosave: true
        }
      ]
    }
  };
}

function emptyQueryReply(request: ProjectLibraryQueryRequest): ProjectLibraryQueryReply {
  if (request.query.kind === "recent") {
    return {
      contractVersion: 1,
      ok: true,
      value: { kind: "recent", projects: [], nextCursor: null }
    };
  }
  if (request.query.kind === "recoveries") {
    return {
      contractVersion: 1,
      ok: true,
      value: { kind: "recoveries", recoveries: [] }
    };
  }
  throw new Error(`测试没有为 ${request.query.kind} 提供响应。`);
}

function createOpenReply(
  request: OpenProjectLibrarySessionRequest,
  sequence = 1
): OpenProjectLibrarySessionReply {
  if (request.source.kind !== "create") {
    throw new Error("测试只接受 create open。");
  }
  const suffix = sequence === 1 ? "" : `-${sequence}`;
  return {
    contractVersion: 1,
    ok: true,
    value: {
      project: {
        libraryProjectId: `library-created${suffix}`,
        displayName: request.source.displayName,
        projectSchemaVersion: request.source.projectSchemaVersion,
        headRevision: 1,
        stableRevision: 1,
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 1_000,
        lastOpenedAtUnixMs: 1_000,
        hasRecovery: false
      },
      session: {
        sessionId: `session-created${suffix}`,
        openedRevision: 1,
        currentRevision: 1,
        stableRevision: 1,
        openedAtUnixMs: 1_000
      },
      snapshot: {
        libraryProjectId: `library-created${suffix}`,
        revision: 1,
        displayName: request.source.displayName,
        projectSchemaVersion: CURRENT_SCHEMA_VERSION,
        savedAtUnixMs: 1_000,
        snapshotJson: request.source.snapshotJson
      }
    }
  };
}

function recoveryOpenReply(
  request: OpenProjectLibrarySessionRequest,
  project: ReturnType<typeof createEmptyProject>
): OpenProjectLibrarySessionReply {
  if (request.source.kind !== "recover") {
    throw new Error("测试只接受 recover open。");
  }
  const snapshotJson = JSON.stringify(project);
  return {
    contractVersion: 1,
    ok: true,
    value: {
      project: {
        libraryProjectId: request.source.libraryProjectId,
        displayName: project.name,
        projectSchemaVersion: project.schemaVersion,
        headRevision: request.source.expectedHeadRevision + 1,
        stableRevision: 2,
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 4_000,
        lastOpenedAtUnixMs: 4_000,
        hasRecovery: false
      },
      session: {
        sessionId: "session-recovered",
        openedRevision: 4,
        currentRevision: 4,
        stableRevision: 2,
        openedAtUnixMs: 4_000
      },
      snapshot: {
        libraryProjectId: request.source.libraryProjectId,
        revision: 4,
        displayName: project.name,
        projectSchemaVersion: project.schemaVersion,
        savedAtUnixMs: 4_000,
        snapshotJson
      }
    }
  };
}

function headOpenReply(
  request: OpenProjectLibrarySessionRequest,
  project: ReturnType<typeof createEmptyProject>
): OpenProjectLibrarySessionReply {
  if (request.source.kind !== "head") {
    throw new Error("测试只接受 head open。");
  }
  return {
    contractVersion: 1,
    ok: true,
    value: {
      project: {
        libraryProjectId: request.source.libraryProjectId,
        displayName: project.name,
        projectSchemaVersion: project.schemaVersion,
        headRevision: request.source.expectedHeadRevision,
        stableRevision: request.source.expectedHeadRevision,
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 3_000,
        lastOpenedAtUnixMs: 3_000,
        hasRecovery: false
      },
      session: {
        sessionId: "session-head",
        openedRevision: request.source.expectedHeadRevision,
        currentRevision: request.source.expectedHeadRevision,
        stableRevision: request.source.expectedHeadRevision,
        openedAtUnixMs: 3_000
      },
      snapshot: {
        libraryProjectId: request.source.libraryProjectId,
        revision: request.source.expectedHeadRevision,
        displayName: project.name,
        projectSchemaVersion: project.schemaVersion,
        savedAtUnixMs: 3_000,
        snapshotJson: JSON.stringify(project)
      }
    }
  };
}

function discardOpenReply(
  request: OpenProjectLibrarySessionRequest
): OpenProjectLibrarySessionReply {
  if (request.source.kind !== "discardRecovery") {
    throw new Error("测试只接受 discardRecovery open。");
  }
  return {
    contractVersion: 1,
    ok: true,
    value: {
      project: {
        libraryProjectId: request.source.libraryProjectId,
        displayName: request.source.displayName,
        projectSchemaVersion: request.source.projectSchemaVersion,
        headRevision: request.source.expectedHeadRevision + 1,
        stableRevision: request.source.expectedHeadRevision + 1,
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 4_000,
        lastOpenedAtUnixMs: 4_000,
        hasRecovery: false
      },
      session: {
        sessionId: "session-discarded",
        openedRevision: 4,
        currentRevision: 4,
        stableRevision: 4,
        openedAtUnixMs: 4_000
      },
      snapshot: {
        libraryProjectId: request.source.libraryProjectId,
        revision: 4,
        displayName: request.source.displayName,
        projectSchemaVersion: request.source.projectSchemaVersion,
        savedAtUnixMs: 4_000,
        snapshotJson: request.source.snapshotJson
      }
    }
  };
}

function revisionReply(
  libraryProjectId: string,
  revision: number,
  snapshotJson: string,
  displayName: string
): ProjectLibraryQueryReply {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      kind: "revision",
      snapshot: {
        libraryProjectId,
        revision,
        displayName,
        projectSchemaVersion: CURRENT_SCHEMA_VERSION,
        savedAtUnixMs: revision * 1_000,
        snapshotJson
      }
    }
  };
}

function revisionsReply(
  libraryProjectId: string,
  headRevision: number
): ProjectLibraryQueryReply {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      kind: "revisions",
      project: {
        libraryProjectId,
        displayName: "版本项目",
        projectSchemaVersion: CURRENT_SCHEMA_VERSION,
        headRevision,
        stableRevision: headRevision,
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 2_000,
        lastOpenedAtUnixMs: 2_000,
        hasRecovery: false
      },
      revisions: [
        {
          revision: 1,
          parentRevision: null,
          sourceRevision: null,
          saveKind: "create",
          label: null,
          savedAtUnixMs: 1_000,
          snapshotBytes: 128
        }
      ]
    }
  };
}

function commitReply(
  headRevision: number,
  stableRevision: number,
  occurredAtUnixMs: number
): CommitProjectLibrarySessionReply {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      disposition: "committed",
      libraryProjectId: "library-created",
      sessionId: "session-created",
      headRevision,
      stableRevision,
      occurredAtUnixMs,
      sessionClosed: false
    }
  };
}

function closeReply(
  request: CommitProjectLibrarySessionRequest,
  headRevision: number,
  stableRevision: number
): CommitProjectLibrarySessionReply {
  return {
    contractVersion: 1,
    ok: true,
    value: {
      disposition: "committed",
      libraryProjectId: request.libraryProjectId,
      sessionId: request.sessionId,
      headRevision,
      stableRevision,
      occurredAtUnixMs: 3_000,
      sessionClosed: true
    }
  };
}

function failedCommitReply(
  code: "storageFull",
  message: string
): CommitProjectLibrarySessionReply {
  return {
    contractVersion: 1,
    ok: false,
    error: {
      code,
      message,
      retryable: true,
      actualHeadRevision: null
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createSequentialId(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
}

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}
