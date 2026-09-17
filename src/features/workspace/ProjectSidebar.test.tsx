import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { createUsabilityViewModel } from "../../domain/project/usabilityViewModel";
import {
  createInitialProjectLibrarySessionState,
  type ProjectLibraryIntent
} from "../../application/projectLibrarySessionController";
import { ProjectSidebar } from "./ProjectSidebar";

describe("ProjectSidebar project library", () => {
  it("首屏把项目任务与异常计数放在明确的导航标题中", () => {
    const project = createEmptyProject("当前项目");
    const model = createUsabilityViewModel(project);

    render(
      <ProjectSidebar
        project={project}
        model={model}
        library={createInitialProjectLibrarySessionState()}
        onLibraryIntent={vi.fn()}
      />
    );

    const sidebar = screen.getByRole("complementary", { name: "项目与任务" });
    expect(within(sidebar).getByText("项目与任务")).toBeInTheDocument();
    expect(within(sidebar).getByText(`${model.issues.length} 项待处理`)).toBeInTheDocument();
  });

  it("原片分集状态使用固定词表与共享语义色", () => {
    const project = createEmptyProject("状态项目");
    project.mediaLibrary = [
      {
        id: "target-1",
        role: "targetOriginal",
        name: "第 1 集",
        fileName: "S01E01.mkv",
        objectUrl: null,
        durationMs: 1_200_000,
        contentIdentity: null,
        referenceKind: "localPath",
        connectionState: "connected",
        sourceSummary: "本地文件",
        localPath: "D:\\media\\S01E01.mkv",
        emby: null,
        episodeKey: "S01E01",
        episodeLabel: "第 1 集",
        audioTrackIntent: { mode: "auto" },
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z"
      }
    ];

    render(
      <ProjectSidebar
        project={project}
        model={createUsabilityViewModel(project)}
        library={createInitialProjectLibrarySessionState()}
        onLibraryIntent={vi.fn()}
      />
    );

    const episodes = screen.getByRole("list", { name: "原片分集" });
    const status = within(episodes).getByText("准备中").closest("[data-tone]");
    expect(status).toHaveAttribute("data-tone", "running");
  });

  it("最近项目、恢复裁决与追加式回退均通过明确语义动作", () => {
    const project = createEmptyProject("当前项目");
    const onLibraryIntent = vi.fn<(intent: ProjectLibraryIntent) => void>();
    const library = {
      ...createInitialProjectLibrarySessionState(),
      availability: "ready" as const,
      activeProject: {
        libraryProjectId: "library-current",
        displayName: "当前项目",
        headRevision: 5,
        stableRevision: 4
      },
      recentProjects: [
        {
          libraryProjectId: "library-recent",
          displayName: "最近项目",
          headRevision: 3,
          stableRevision: 3,
          lastOpenedAtUnixMs: 3_000,
          hasRecovery: false
        }
      ],
      recoveryCandidates: [
        {
          libraryProjectId: "library-recovery",
          displayName: "待恢复项目",
          recoverySessionId: "session-abandoned",
          openedRevision: 2,
          recoveryRevision: 4,
          stableRevision: 2,
          lastSavedAtUnixMs: 4_000,
          hasNewerAutosave: true
        },
        {
          libraryProjectId: "library-legacy",
          displayName: "旧版稳定项目",
          recoverySessionId: "session-legacy",
          openedRevision: 1,
          recoveryRevision: 1,
          stableRevision: 1,
          lastSavedAtUnixMs: 2_000,
          hasNewerAutosave: false
        }
      ],
      revisionProjectId: "library-current",
      revisions: [
        {
          revision: 4,
          sourceRevision: null,
          saveKind: "autosave" as const,
          label: null,
          savedAtUnixMs: 4_000,
          snapshotBytes: 128
        }
      ]
    };
    render(
      <ProjectSidebar
        project={project}
        model={createUsabilityViewModel(project)}
        library={library}
        onLibraryIntent={onLibraryIntent}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "打开最近项目：最近项目" }));
    expect(onLibraryIntent).toHaveBeenLastCalledWith({
      kind: "openRecent",
      libraryProjectId: "library-recent"
    });

    expect(screen.getByRole("button", { name: "恢复：旧版稳定项目" })).toHaveTextContent(
      "恢复打开"
    );
    expect(
      screen.queryByRole("button", { name: "放弃恢复：旧版稳定项目" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "恢复：待恢复项目" }));
    expect(onLibraryIntent).toHaveBeenLastCalledWith({
      kind: "recoverProject",
      libraryProjectId: "library-recovery",
      recoverySessionId: "session-abandoned"
    });
    fireEvent.click(screen.getByRole("button", { name: "放弃恢复：待恢复项目" }));
    expect(onLibraryIntent).toHaveBeenLastCalledWith({
      kind: "discardRecovery",
      libraryProjectId: "library-recovery",
      recoverySessionId: "session-abandoned"
    });

    fireEvent.click(screen.getByLabelText("选择修订 4"));
    fireEvent.click(screen.getByRole("button", { name: "回退到修订 4 并追加新版本" }));
    expect(onLibraryIntent).toHaveBeenLastCalledWith({
      kind: "rollbackToRevision",
      revision: 4
    });
  });

  it("打开或回退完成后焦点回到当前项目标题", () => {
    const project = createEmptyProject("焦点项目");
    const initial = createInitialProjectLibrarySessionState();
    const { rerender } = render(
      <ProjectSidebar
        project={project}
        model={createUsabilityViewModel(project)}
        library={initial}
        onLibraryIntent={vi.fn()}
      />
    );

    rerender(
      <ProjectSidebar
        project={project}
        model={createUsabilityViewModel(project)}
        library={{ ...initial, focusRequestSequence: 1 }}
        onLibraryIntent={vi.fn()}
      />
    );

    expect(screen.getByTestId("project-sidebar-heading")).toHaveFocus();
  });
});
