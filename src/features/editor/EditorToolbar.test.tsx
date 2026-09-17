import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act, createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DanmakuClip } from "../../domain/danmaku/types";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectMediaReference,
  type ProjectMediaRole
} from "../../domain/project/types";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { createInitialProjectLibrarySessionState } from "../../application/projectLibrarySessionController";
import { EditorToolbar } from "./EditorToolbar";

function resetToolbarStore(): void {
  useEditorStore.setState({
    project: createEmptyProject(),
    selection: { kind: "none", ids: [] },
    history: createHistoryState(),
    isPlaying: false,
    status: { message: "准备就绪", tone: "neutral" },
    importProgress: null,
    exportDraft: null,
    alignmentProposal: null,
    cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
    timelineTool: "select",
    workspacePage: "matching",
    projectLibrary: {
      ...createInitialProjectLibrarySessionState(),
      availability: "browser"
    },
    projectLibraryIntentSequence: 0,
    projectLibraryIntent: null
  });
}

describe("编辑器工具栏", () => {
  beforeEach(() => {
    resetToolbarStore();
  });

  it("顶部导航可以切换工作区页面", () => {
    render(<EditorToolbar />);

    expect(screen.getByTestId("workspace-nav-matching")).toHaveAttribute(
      "aria-current",
      "page"
    );
    fireEvent.click(screen.getByTestId("workspace-nav-export"));
    expect(useEditorStore.getState().workspacePage).toBe("export");
    expect(screen.getByTestId("workspace-nav-export")).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByTestId("workspace-nav-materials"));
    expect(useEditorStore.getState().workspacePage).toBe("materials");
  });

  it("紧凑壳层在同一主栏展示项目、保存状态与四步导航", () => {
    useEditorStore.setState({
      project: createEmptyProject("第一季工程"),
      projectLibrary: {
        ...createInitialProjectLibrarySessionState(),
        availability: "ready",
        saveStatus: "saved",
        message: "自动保存已由本机项目库确认。"
      }
    });

    render(<EditorToolbar />);

    const shell = screen.getByRole("banner", { name: "项目与工作流" });
    const primaryRow = within(shell).getByTestId("toolbar-primary-row");
    expect(primaryRow).not.toHaveAttribute("data-tauri-drag-region");
    expect(shell.querySelector(".window-drag-region")).toHaveAttribute(
      "data-tauri-drag-region"
    );
    expect(within(primaryRow).getByText("第一季工程")).toBeInTheDocument();
    expect(within(primaryRow).getByTestId("project-library-save-status")).toHaveTextContent(
      "已保存"
    );
    const stepper = within(primaryRow).getByTestId("workflow-stepper");
    expect(within(stepper).getAllByRole("button")).toHaveLength(4);
  });

  it("工具栏提供可读的命令入口并暴露回焦锚点", () => {
    const onOpenCommandPalette = vi.fn();
    const commandPaletteTriggerRef = createRef<HTMLButtonElement>();
    render(
      <EditorToolbar
        onOpenCommandPalette={onOpenCommandPalette}
        commandPaletteTriggerRef={commandPaletteTriggerRef}
      />
    );

    const trigger = screen.getByRole("button", { name: "打开命令与快捷键" });
    expect(trigger).toHaveAccessibleName("打开命令与快捷键");
    expect(trigger).toHaveAttribute("title", expect.stringContaining("Ctrl"));
    expect(commandPaletteTriggerRef.current).toBe(trigger);
    fireEvent.click(trigger);
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
  });

  it("设置只在点击后局部加载，并在关闭后回到原入口", async () => {
    render(<EditorToolbar />);

    const trigger = screen.getByRole("button", { name: "设置" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("status", { name: "正在打开设置" })).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "设置中心" });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "关闭设置" }));
    expect(screen.queryByRole("dialog", { name: "设置中心" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("新手引导会展示下一步并随项目状态实时同步", async () => {
    render(<EditorToolbar />);

    fireEvent.click(screen.getByLabelText("项目菜单"));
    fireEvent.click(screen.getByRole("button", { name: "新手引导" }));

    expect(screen.getByTestId("workflow-overview-dialog")).toBeInTheDocument();
    expect(screen.getByText("开始 / 下一步")).toBeInTheDocument();
    expect(screen.getByText("建议下一步")).toBeInTheDocument();
    expect(screen.queryByText("能力地图")).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: "去素材页导入 XML" })
        .some((button) => !button.hasAttribute("disabled"))
    ).toBe(true);

    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { assetId: "asset-workflow-dialog", fileName: "workflow-dialog.xml" }
    );
    const clip: DanmakuClip = {
      id: "clip-workflow-dialog",
      assetId: asset.id,
      name: asset.name,
      timelineStartMs: 0,
      sourceInMs: 0,
      sourceOutMs: 1000,
      localOffsetMs: 0,
      enabled: true
    };
    act(() => {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          assets: [asset],
          clips: [clip]
        }
      });
    });

    await waitFor(() =>
      expect(screen.getByText(/1 个 XML · 1 个时间线片段 · 无需视频匹配/)).toBeInTheDocument()
    );
    expect(
      screen
        .getAllByRole("button", { name: "去导出页导出 XML" })
        .some((button) => !button.hasAttribute("disabled"))
    ).toBe(true);
  });

  it("新手引导主动作进入匹配页运行分析，不应用全局对齐提案", async () => {
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { assetId: "asset-review-matches", fileName: "review-matches.xml" }
    );
    const proposal: AlignmentProposal = {
      anchors: [
        {
          id: "legacy-proposal-anchor",
          sourceMs: 1000,
          targetMs: 2000,
          origin: "automatic",
          confidence: 0.9
        }
      ],
      cutCandidates: [],
      confidence: 0.9,
      diagnostics: ["旧全局提案只保留预览，不应由新手引导直接应用。"]
    };
    act(() => {
      useEditorStore.setState({
        workspacePage: "materials",
        alignmentProposal: proposal,
        project: {
          ...createEmptyProject(),
          assets: [asset],
          mediaLibrary: [
            createToolbarMedia("source-review", "bilibiliReference"),
            createToolbarMedia("target-review", "targetOriginal")
          ],
          danmakuSourceBindings: [
            {
              id: "binding-review",
              assetId: asset.id,
              sourceMediaId: "source-review",
              linkedAt: "2026-07-11T00:00:00.000Z",
              updatedAt: "2026-07-11T00:00:00.000Z"
            }
          ],
          alignmentProposal: proposal
        }
      });
    });
    render(<EditorToolbar />);

    fireEvent.click(screen.getByLabelText("项目菜单"));
    fireEvent.click(screen.getByRole("button", { name: "新手引导" }));

    expect(screen.queryByRole("button", { name: /应用.*对齐/ })).not.toBeInTheDocument();
    const reviewButton = screen
      .getAllByRole("button", { name: "去匹配页运行智能分析" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(reviewButton).toBeDefined();
    if (!reviewButton) {
      throw new Error("未找到可用的智能匹配主动作。");
    }

    fireEvent.click(reviewButton);

    await waitFor(() => expect(useEditorStore.getState().workspacePage).toBe("matching"));
    expect(screen.queryByTestId("workflow-overview-dialog")).not.toBeInTheDocument();
    expect(useEditorStore.getState().alignmentProposal).toBe(proposal);
    expect(useEditorStore.getState().project.alignmentProposal).toBe(proposal);
    expect(useEditorStore.getState().project.syncAnchors).toEqual([]);
    expect(useEditorStore.getState().project.cutMarkers).toEqual([]);
  });

  it("顶部导出项目备份时使用实际文件名更新状态", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(
      () => "blob:toolbar-project"
    );
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "保存/项目:草稿"
        }
      });

      render(<EditorToolbar />);
      fireEvent.click(screen.getByLabelText("项目菜单"));
      fireEvent.click(screen.getByRole("button", { name: "导出项目备份" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("顶部项目保存未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("保存_项目_草稿.danmaku-project.json");
      await waitFor(() =>
        expect(useEditorStore.getState().status.message).toBe(
          "已保存项目文件：保存_项目_草稿.danmaku-project.json"
        )
      );
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:toolbar-project");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("桌面项目库的新建与备份导入发出语义 intent，并显示真实保存状态", async () => {
    useEditorStore.setState({
      projectLibrary: {
        ...createInitialProjectLibrarySessionState(),
        availability: "ready",
        saveStatus: "saving",
        message: "正在自动保存…"
      }
    });
    render(<EditorToolbar />);

    expect(screen.getByTestId("project-library-save-status")).toHaveTextContent("保存中");
    fireEvent.click(screen.getByLabelText("项目菜单"));
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    expect(useEditorStore.getState().projectLibraryIntent?.intent).toEqual({
      kind: "createProject"
    });

    const backup = new File(
      [JSON.stringify(createEmptyProject("备份导入"))],
      "backup.danmaku-project.json",
      { type: "application/json" }
    );
    fireEvent.change(screen.getByTestId("project-input"), { target: { files: [backup] } });

    await waitFor(() =>
      expect(useEditorStore.getState().projectLibraryIntent?.intent).toMatchObject({
        kind: "importBackup",
        sourceFileName: "backup.danmaku-project.json"
      })
    );
  });

  it("打开项目文件读取失败时显示错误状态", async () => {
    const file = createRejectingTextFile("bad.danmaku-project.json", "项目读取被拒绝");

    render(<EditorToolbar />);
    fireEvent.change(screen.getByTestId("project-input"), { target: { files: [file] } });

    await waitFor(() =>
      expect(useEditorStore.getState().status).toEqual({
        message: "项目文件读取失败：读取文件 bad.danmaku-project.json 失败：项目读取被拒绝",
        tone: "error"
      })
    );
  });

  it("打开项目文件校验失败时显示来源文件名", async () => {
    const file = new File(
      [JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })],
      "future-project.danmaku-project.json",
      { type: "application/json" }
    );

    render(<EditorToolbar />);
    fireEvent.change(screen.getByTestId("project-input"), { target: { files: [file] } });

    await waitFor(() =>
      expect(useEditorStore.getState().status).toEqual({
        message: `项目文件打开失败：future-project.danmaku-project.json：项目版本 ${CURRENT_SCHEMA_VERSION + 1} 暂不支持，当前支持版本为 1 到 ${CURRENT_SCHEMA_VERSION}。`,
        tone: "error"
      })
    );
  });
});

function createRejectingTextFile(fileName: string, message: string): File {
  const file = new File([""], fileName, { type: "application/json" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: vi.fn<() => Promise<string>>(() => Promise.reject(new Error(message)))
  });
  return file;
}

function createToolbarMedia(id: string, role: ProjectMediaRole): ProjectMediaReference {
  const fileName = `${id}.mkv`;
  return {
    id,
    role,
    name: id,
    fileName,
    objectUrl: null,
    durationMs: 60_000,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件路径",
    localPath: `D:\\video\\${fileName}`,
    emby: null,
    episodeKey: role === "targetOriginal" ? "S01E01" : null,
    episodeLabel: role === "targetOriginal" ? "第 1 集" : null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z"
  };
}
