import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  commitTauriProjectLibrarySession,
  openTauriProjectLibrarySession,
  queryTauriProjectLibrary,
  type CommitProjectLibrarySessionReply,
  type CommitProjectLibrarySessionRequest,
  type OpenProjectLibrarySessionReply,
  type OpenProjectLibrarySessionRequest,
  type ProjectLibraryQueryRequest,
  type ProjectLibraryQueryReply
} from "./tauriProjectLibrary";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

const recentReply = {
  contractVersion: 1,
  ok: true,
  value: {
    kind: "recent",
    projects: [
      {
        libraryProjectId: "project-001",
        displayName: "示例项目",
        projectSchemaVersion: 17,
        headRevision: 3,
        stableRevision: 2,
        createdAtUnixMs: 1_700_000_000_000,
        updatedAtUnixMs: 1_700_000_000_100,
        lastOpenedAtUnixMs: 1_700_000_000_200,
        hasRecovery: false
      }
    ],
    nextCursor: null
  }
} satisfies ProjectLibraryQueryReply;

const openReply = {
  contractVersion: 1,
  ok: true,
  value: {
    project: recentReply.value.projects[0],
    session: {
      sessionId: "session-001",
      openedRevision: 3,
      currentRevision: 3,
      stableRevision: 2,
      openedAtUnixMs: 1_700_000_000_300
    },
    snapshot: {
      libraryProjectId: "project-001",
      revision: 3,
      displayName: "示例项目",
      projectSchemaVersion: 17,
      savedAtUnixMs: 1_700_000_000_100,
      snapshotJson: '{"schemaVersion":17}'
    }
  }
} satisfies OpenProjectLibrarySessionReply;

const commitReply = {
  contractVersion: 1,
  ok: true,
  value: {
    disposition: "committed",
    libraryProjectId: "project-001",
    sessionId: "session-001",
    headRevision: 4,
    stableRevision: 2,
    occurredAtUnixMs: 1_700_000_000_400,
    sessionClosed: false
  }
} satisfies CommitProjectLibrarySessionReply;

describe("Tauri Project Library v1", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("以 exact camelCase request 调用 query command 并严格验证 tagged reply", async () => {
    const request: ProjectLibraryQueryRequest = {
      contractVersion: 1,
      query: { kind: "recent", limit: 20, cursor: null }
    };
    tauriMocks.invoke.mockResolvedValue(recentReply);

    const result = await queryTauriProjectLibrary(request);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("query_project_library", { request });
    expect(result).toEqual(recentReply);
    expectTypeOf(result).toEqualTypeOf<ProjectLibraryQueryReply>();
  });

  it("拒绝包含内部路径等额外字段的响应", async () => {
    tauriMocks.invoke.mockResolvedValue({
      ...recentReply,
      databasePath: "C:\\Users\\secret\\library.sqlite3"
    });

    await expect(
      queryTauriProjectLibrary({
        contractVersion: 1,
        query: { kind: "recent", limit: 20, cursor: null }
      })
    ).rejects.toThrow("项目库响应无效");
  });

  it("open/commit 只调用固定 command 并严格验证各自响应", async () => {
    const openRequest: OpenProjectLibrarySessionRequest = {
      contractVersion: 1,
      clientRequestId: "open-001",
      source: {
        kind: "head",
        libraryProjectId: "project-001",
        expectedHeadRevision: 3
      }
    };
    tauriMocks.invoke.mockResolvedValueOnce(openReply);
    await expect(openTauriProjectLibrarySession(openRequest)).resolves.toEqual(openReply);
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("open_project_library_session", {
      request: openRequest
    });

    const commitRequest: CommitProjectLibrarySessionRequest = {
      contractVersion: 1,
      libraryProjectId: "project-001",
      sessionId: "session-001",
      clientMutationId: "save-001",
      expectedHeadRevision: 3,
      change: {
        kind: "save",
        saveKind: "autosave",
        sourceRevision: null,
        label: null,
        displayName: "示例项目",
        projectSchemaVersion: 17,
        snapshotJson: '{"schemaVersion":17}'
      }
    };
    tauriMocks.invoke.mockResolvedValueOnce(commitReply);
    await expect(commitTauriProjectLibrarySession(commitRequest)).resolves.toEqual(commitReply);
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("commit_project_library_session", {
      request: commitRequest
    });
  });

  it("覆盖四种 query tagged union，且最近项目永不携带 snapshot 或本地路径", async () => {
    const replies: ProjectLibraryQueryReply[] = [
      recentReply,
      {
        contractVersion: 1,
        ok: true,
        value: {
          kind: "recoveries",
          recoveries: [
            {
              libraryProjectId: "project-001",
              displayName: "示例项目",
              recoverySessionId: "session-old",
              openedRevision: 2,
              recoveryRevision: 4,
              stableRevision: 2,
              lastSavedAtUnixMs: 1_700_000_000_500,
              hasNewerAutosave: true
            },
            {
              libraryProjectId: "legacy-project",
              displayName: "旧版稳定项目",
              recoverySessionId: "legacy-session",
              openedRevision: 2,
              recoveryRevision: 2,
              stableRevision: 2,
              lastSavedAtUnixMs: 1_700_000_000_500,
              hasNewerAutosave: false
            }
          ]
        }
      },
      {
        contractVersion: 1,
        ok: true,
        value: {
          kind: "revisions",
          project: recentReply.value.projects[0],
          revisions: [
            {
              revision: 4,
              parentRevision: 3,
              sourceRevision: 3,
              saveKind: "recovered",
              label: null,
              savedAtUnixMs: 1_700_000_000_500,
              snapshotBytes: 1234
            }
          ]
        }
      },
      {
        contractVersion: 1,
        ok: true,
        value: {
          kind: "revision",
          snapshot: openReply.value.snapshot
        }
      }
    ];
    const requests: ProjectLibraryQueryRequest[] = [
      { contractVersion: 1, query: { kind: "recent", limit: 20, cursor: null } },
      { contractVersion: 1, query: { kind: "recoveries" } },
      {
        contractVersion: 1,
        query: {
          kind: "revisions",
          libraryProjectId: "project-001",
          beforeRevision: null,
          limit: 20
        }
      },
      {
        contractVersion: 1,
        query: { kind: "revision", libraryProjectId: "project-001", revision: 3 }
      }
    ];

    for (const [index, request] of requests.entries()) {
      const invoker = vi.fn().mockResolvedValue(replies[index]);
      await expect(queryTauriProjectLibrary(request, invoker)).resolves.toEqual(replies[index]);
      expect(invoker).toHaveBeenCalledWith(request);
    }
    expect(JSON.stringify(replies[0])).not.toContain("snapshotJson");
    expect(JSON.stringify(replies[0])).not.toContain("databasePath");
  });

  it("拒绝不一致 open、伪造 close/unchanged 以及错误码上下文漂移", async () => {
    const openRequest: OpenProjectLibrarySessionRequest = {
      contractVersion: 1,
      clientRequestId: "strict-open",
      source: { kind: "head", libraryProjectId: "project-001", expectedHeadRevision: 3 }
    };
    const invalidOpen = {
      ...openReply,
      value: {
        ...openReply.value,
        session: { ...openReply.value.session, openedRevision: 2 }
      }
    };
    await expect(
      openTauriProjectLibrarySession(openRequest, vi.fn().mockResolvedValue(invalidOpen))
    ).rejects.toThrow("项目库响应无效");

    const invalidCommit = {
      ...commitReply,
      value: {
        ...commitReply.value,
        disposition: "unchanged",
        headRevision: 2,
        stableRevision: 2,
        sessionClosed: true
      }
    };
    await expect(
      commitTauriProjectLibrarySession(
        {
          contractVersion: 1,
          libraryProjectId: "project-001",
          sessionId: "session-001",
          clientMutationId: "strict-commit",
          expectedHeadRevision: 2,
          change: { kind: "close" }
        },
        vi.fn().mockResolvedValue(invalidCommit)
      )
    ).rejects.toThrow("项目库响应无效");

    await expect(
      queryTauriProjectLibrary(
        { contractVersion: 1, query: { kind: "recoveries" } },
        vi.fn().mockResolvedValue({
          contractVersion: 1,
          ok: false,
          error: {
            code: "storageFull",
            message: "本地磁盘空间不足，项目未保存。",
            retryable: true,
            actualHeadRevision: 4
          }
        })
      )
    ).rejects.toThrow("项目库响应无效");
  });

  it("按 saveKind 和 disposition 拒绝不可能的 commit 成功矩阵", async () => {
    const saveRequest = (
      saveKind: "autosave" | "checkpoint" | "rollback"
    ): CommitProjectLibrarySessionRequest => ({
      contractVersion: 1,
      libraryProjectId: "project-001",
      sessionId: "session-001",
      clientMutationId: `strict-${saveKind}`,
      expectedHeadRevision: 3,
      change: {
        kind: "save",
        saveKind,
        sourceRevision: saveKind === "rollback" ? 1 : null,
        label: null,
        displayName: "示例项目",
        projectSchemaVersion: 17,
        snapshotJson: '{"schemaVersion":17}'
      }
    });
    const impossibleReplies = [
      {
        request: saveRequest("autosave"),
        value: { ...commitReply.value, disposition: "committed", stableRevision: 4 }
      },
      {
        request: saveRequest("checkpoint"),
        value: {
          ...commitReply.value,
          disposition: "unchanged",
          headRevision: 3,
          stableRevision: 3
        }
      },
      {
        request: saveRequest("rollback"),
        value: {
          ...commitReply.value,
          disposition: "alreadyCommitted",
          headRevision: 3,
          stableRevision: 3
        }
      },
      {
        request: saveRequest("autosave"),
        value: { ...commitReply.value, disposition: "alreadyCommitted", stableRevision: 4 }
      }
    ] as const;

    for (const { request, value } of impossibleReplies) {
      await expect(
        commitTauriProjectLibrarySession(
          request,
          vi.fn().mockResolvedValue({ contractVersion: 1, ok: true, value })
        )
      ).rejects.toThrow("项目库响应无效");
    }
  });

  it("在 invoke 前拒绝非法 JSON、未知字段和非安全整数", async () => {
    const invoker = vi.fn();
    await expect(
      openTauriProjectLibrarySession(
        {
          contractVersion: 1,
          clientRequestId: "invalid-json",
          source: {
            kind: "create",
            displayName: "非法 JSON",
            projectSchemaVersion: 17,
            snapshotJson: "{not-json}"
          }
        },
        invoker
      )
    ).rejects.toThrow("create source 无效");
    await expect(
      queryTauriProjectLibrary(
        {
          contractVersion: 1,
          query: {
            kind: "revision",
            libraryProjectId: "project-001",
            revision: Number.MAX_SAFE_INTEGER + 1
          }
        },
        invoker
      )
    ).rejects.toThrow("revision query 无效");
    await expect(
      queryTauriProjectLibrary(
        {
          contractVersion: 1,
          query: { kind: "recoveries", hiddenSql: "SELECT *" }
        } as unknown as ProjectLibraryQueryRequest,
        invoker
      )
    ).rejects.toThrow("字段不匹配");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("拒绝 native 返回的非 JSON object 快照", async () => {
    await expect(
      queryTauriProjectLibrary(
        {
          contractVersion: 1,
          query: { kind: "revision", libraryProjectId: "project-001", revision: 3 }
        },
        vi.fn().mockResolvedValue({
          contractVersion: 1,
          ok: true,
          value: {
            kind: "revision",
            snapshot: { ...openReply.value.snapshot, snapshotJson: "{not-json}" }
          }
        })
      )
    ).rejects.toThrow("项目库响应无效");
  });

  it("非 Tauri 环境保留手动备份退路，但显式测试 adapter 仍可调用", async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    await expect(
      queryTauriProjectLibrary({
        contractVersion: 1,
        query: { kind: "recent", limit: 20, cursor: null }
      })
    ).rejects.toThrow("手动 JSON 备份");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();

    const invoker = vi.fn().mockResolvedValue(recentReply);
    await expect(
      queryTauriProjectLibrary(
        { contractVersion: 1, query: { kind: "recent", limit: 20, cursor: null } },
        invoker
      )
    ).resolves.toEqual(recentReply);
  });

  it("接受经过净化且错误码上下文一致的 tagged failure", async () => {
    const storageFull = {
      contractVersion: 1,
      ok: false,
      error: {
        code: "storageFull",
        message: "本地磁盘空间不足，项目未保存。",
        retryable: true,
        actualHeadRevision: null
      }
    } as const;
    await expect(
      queryTauriProjectLibrary(
        { contractVersion: 1, query: { kind: "recoveries" } },
        vi.fn().mockResolvedValue(storageFull)
      )
    ).resolves.toEqual(storageFull);

    const conflict = {
      contractVersion: 1,
      ok: false,
      error: {
        code: "revisionConflict",
        message: "项目库已有更新修订，本次操作未覆盖它。",
        retryable: false,
        actualHeadRevision: 4
      }
    } as const;
    await expect(
      queryTauriProjectLibrary(
        { contractVersion: 1, query: { kind: "recoveries" } },
        vi.fn().mockResolvedValue(conflict)
      )
    ).resolves.toEqual(conflict);
  });

  it("拒绝与原请求不对应的 query kind、project 或 session 回执", async () => {
    await expect(
      queryTauriProjectLibrary(
        { contractVersion: 1, query: { kind: "recent", limit: 20, cursor: null } },
        vi.fn().mockResolvedValue({
          contractVersion: 1,
          ok: true,
          value: { kind: "revision", snapshot: openReply.value.snapshot }
        })
      )
    ).rejects.toThrow("项目库响应无效");

    await expect(
      openTauriProjectLibrarySession(
        {
          contractVersion: 1,
          clientRequestId: "wrong-project-open",
          source: {
            kind: "head",
            libraryProjectId: "project-expected",
            expectedHeadRevision: 3
          }
        },
        vi.fn().mockResolvedValue(openReply)
      )
    ).rejects.toThrow("项目库响应无效");

    await expect(
      commitTauriProjectLibrarySession(
        {
          contractVersion: 1,
          libraryProjectId: "project-001",
          sessionId: "session-expected",
          clientMutationId: "wrong-session-commit",
          expectedHeadRevision: 3,
          change: { kind: "close" }
        },
        vi.fn().mockResolvedValue(commitReply)
      )
    ).rejects.toThrow("项目库响应无效");
  });

  it("create 和 discardRecovery 拒绝内部自洽但内容不属于原请求的响应", async () => {
    const selfConsistentReply = (
      headRevision: number,
      stableRevision: number,
      displayName: string,
      projectSchemaVersion: number,
      snapshotJson: string
    ) => ({
      contractVersion: 1,
      ok: true,
      value: {
        project: {
          ...recentReply.value.projects[0],
          displayName,
          projectSchemaVersion,
          headRevision,
          stableRevision,
          hasRecovery: false
        },
        session: {
          ...openReply.value.session,
          openedRevision: headRevision,
          currentRevision: headRevision,
          stableRevision
        },
        snapshot: {
          ...openReply.value.snapshot,
          revision: headRevision,
          displayName,
          projectSchemaVersion,
          snapshotJson
        }
      }
    });

    await expect(
      openTauriProjectLibrarySession(
        {
          contractVersion: 1,
          clientRequestId: "create-request-a",
          source: {
            kind: "create",
            displayName: "请求 A",
            projectSchemaVersion: 17,
            snapshotJson: '{"schemaVersion":17,"value":"A"}'
          }
        },
        vi
          .fn()
          .mockResolvedValue(
            selfConsistentReply(1, 1, "响应 B", 18, '{"schemaVersion":18,"value":"B"}')
          )
      )
    ).rejects.toThrow("项目库响应无效");

    await expect(
      openTauriProjectLibrarySession(
        {
          contractVersion: 1,
          clientRequestId: "discard-request-a",
          source: {
            kind: "discardRecovery",
            libraryProjectId: "project-001",
            recoverySessionId: "recovery-old",
            expectedHeadRevision: 3,
            sourceRevision: 2,
            displayName: "请求 A",
            projectSchemaVersion: 17,
            snapshotJson: '{"schemaVersion":17,"value":"A"}'
          }
        },
        vi
          .fn()
          .mockResolvedValue(
            selfConsistentReply(4, 4, "响应 B", 18, '{"schemaVersion":18,"value":"B"}')
          )
      )
    ).rejects.toThrow("项目库响应无效");
  });
});
