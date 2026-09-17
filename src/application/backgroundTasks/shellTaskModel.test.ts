import { describe, expect, it, vi } from "vitest";
import type { ProjectLibrarySessionState } from "../projectLibrarySessionController";
import { createShellTaskRegistrations } from "./shellTaskModel";

const projectLibrary: ProjectLibrarySessionState = {
  switchingProject: false,
  availability: "ready",
  operation: "idle",
  saveStatus: "failed",
  canRetrySave: true,
  message: "自动保存失败：磁盘已满。请释放空间后重试。",
  recentProjects: [],
  recoveryCandidates: [],
  activeProject: {
    libraryProjectId: "library-a",
    displayName: "测试项目",
    headRevision: 2,
    stableRevision: 1
  },
  revisionProjectId: null,
  revisions: [],
  lastSavedAtUnixMs: null,
  focusRequestSequence: 0
};

describe("shell task model", () => {
  it("同时发布 XML、音轨准备与自动保存，并保留完整错误和语义动作", () => {
    const cancelInventory = vi.fn();
    const retryInventory = vi.fn();
    const retrySave = vi.fn();
    const locate = vi.fn();
    const registrations = createShellTaskRegistrations({
      status: { message: "正在处理后台工作", tone: "neutral" },
      importProgress: 0.25,
      inventory: {
        phase: "running",
        counts: { total: 4, queued: 1, probing: 1, ready: 1, failed: 1, cancelled: 0 },
        cancelling: false,
        restartRequired: false,
        terminalMessage: "音轨准备失败：这是必须完整显示的详细错误。",
        firstIssueMediaId: "media-failed"
      },
      projectLibrary,
      actions: {
        cancelInventory,
        retryInventory,
        retrySave,
        locateInventoryIssue: locate,
        runStatusAction: vi.fn()
      }
    });

    expect(registrations.map(({ task }) => task.title)).toEqual([
      "XML 导入",
      "音轨准备",
      "自动保存"
    ]);
    const inventory = registrations[1];
    expect(inventory.task).toMatchObject({
      phase: "正在准备音轨 · 1/4 已就绪 · 1 项失败",
      progress: 0.5,
      error: "音轨准备失败：这是必须完整显示的详细错误。",
      target: { kind: "audioIssue", mediaId: "media-failed" }
    });
    expect(inventory.task.actions.map((action) => action.kind)).toEqual(["cancel", "locate"]);
    expect(inventory.handlers?.cancel).toBe(cancelInventory);
    expect(inventory.handlers?.locate).toBe(locate);
    expect(registrations[2].task.actions).toEqual([
      { id: "retry", kind: "retry", label: "重试保存" }
    ]);
    expect(registrations[2].handlers?.retry).toBe(retrySave);
  });

  it("restartRequired 为粘性阻断，不发布任何可启动 native inventory 的重试动作", () => {
    const retryInventory = vi.fn();
    const registrations = createShellTaskRegistrations({
      status: { message: "需重启应用", tone: "error" },
      importProgress: null,
      inventory: {
        phase: "failed",
        counts: { total: 2, queued: 0, probing: 0, ready: 0, failed: 2, cancelled: 0 },
        cancelling: false,
        restartRequired: true,
        terminalMessage: "进程清理状态不确定，需重启应用。",
        firstIssueMediaId: "media-a"
      },
      projectLibrary: { ...projectLibrary, saveStatus: "idle", canRetrySave: false },
      actions: {
        cancelInventory: vi.fn(),
        retryInventory,
        retrySave: vi.fn(),
        locateInventoryIssue: vi.fn(),
        runStatusAction: vi.fn()
      }
    });

    const inventory = registrations.find(({ task }) => task.source === "mediaInventory");
    expect(inventory?.task.statusId).toBe("blocked");
    expect(inventory?.task.actions.map((action) => action.kind)).toEqual(["locate"]);
    expect(inventory?.handlers?.retry).toBeUndefined();
    expect(retryInventory).not.toHaveBeenCalled();
  });
});
