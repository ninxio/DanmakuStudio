import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { AlignmentEditorWorkspace } from "./AlignmentEditorWorkspace";

vi.mock("./AlignmentRelationEditor", () => ({
  AlignmentRelationEditor: () => <div data-testid="relation-editor-stub">关系编辑器</div>
}));

vi.mock("./AlignmentLearningPanel", () => ({
  AlignmentLearningPanel: () => <div data-testid="learning-panel-stub">算法改进数据工作台</div>
}));

vi.mock("./DanmakuFineTuneWorkspace", () => ({
  DanmakuFineTuneWorkspace: () => <div data-testid="danmaku-fine-tune-stub">弹幕精修工作台</div>
}));

vi.mock("../matching/ManualAlignmentWorkspace", () => ({
  ManualAlignmentWorkspace: () => <div>手工工具内容</div>
}));

describe("AlignmentEditorWorkspace", () => {
  beforeEach(() => {
    const project = createEmptyProject();
    project.mediaLibrary = [
      {
        id: "target-1",
        role: "targetOriginal",
        name: "原片",
        fileName: "target.mkv",
        objectUrl: null,
        durationMs: 60_000,
        referenceKind: "localPath",
        connectionState: "connected",
        sourceSummary: "本地文件",
        localPath: "C:\\media\\target.mkv",
        emby: null,
        episodeKey: null,
        episodeLabel: null,
        contentIdentity: null,
        audioTrackIntent: { mode: "auto" },
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      }
    ];
    useEditorStore.setState({ project, workspaceIntentRequest: null });
  });

  it("算法工具只在编辑工作台局部显示可播报加载状态", async () => {
    render(<AlignmentEditorWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: "更多工具" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "算法改进数据" }));

    const status = screen.getByRole("status", { name: "正在加载算法改进数据" });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("alignment-editor-shell")).toContainElement(status);
    expect(
      within(status).getByRole("progressbar", { name: "正在加载算法改进数据" })
    ).toBeInTheDocument();
    expect(await screen.findByTestId("learning-panel-stub")).toBeInTheDocument();
  });

  it("手工工具打开时，候选定位请求会返回关系编辑器并保留待消费请求", async () => {
    render(<AlignmentEditorWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "更多工具" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "来源段与手工规则" }));
    expect(await screen.findByText("手工工具内容")).toBeInTheDocument();
    act(() => {
      useEditorStore.getState().requestWorkspaceIntent({
        page: "editing",
        target: { kind: "candidate", candidateId: "requested-candidate" }
      });
    });
    expect(screen.getByTestId("relation-editor-stub")).toBeInTheDocument();
    expect(screen.queryByText("手工工具内容")).not.toBeInTheDocument();
    expect(useEditorStore.getState().workspaceIntentRequest?.intent).toEqual({
      page: "editing",
      target: { kind: "candidate", candidateId: "requested-candidate" }
    });
  });

  it("默认进入覆盖分析，并把弹幕精修和算法数据放在独立模式", async () => {
    render(<AlignmentEditorWorkspace />);

    expect(screen.getByRole("region", { name: "匹配覆盖分析" })).toBeInTheDocument();
    expect(screen.queryByTestId("learning-panel-stub")).not.toBeInTheDocument();
    const primaryModes = screen.getByRole("tablist", { name: "编辑工作台主要模式" });
    const advancedTools = screen.getByRole("group", { name: "编辑高级工具" });
    expect(
      within(primaryModes).queryByRole("button", { name: "算法改进数据" })
    ).not.toBeInTheDocument();
    expect(within(advancedTools).getByRole("button", { name: "更多工具" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "覆盖分析" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.click(screen.getByRole("tab", { name: "弹幕精修" }));
    expect(screen.getByRole("status", { name: "正在加载弹幕精修工作台" })).toBeInTheDocument();
    expect(await screen.findByTestId("danmaku-fine-tune-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("relation-editor-stub")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多工具" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "算法改进数据" }));

    expect(await screen.findByTestId("learning-panel-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("relation-editor-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "算法改进数据" })).toBeInTheDocument();
    expect(screen.getByTestId("danmaku-fine-tune-stub")).toBeInTheDocument();

    const returnButton = screen.getByRole("button", { name: "关闭算法改进数据" });
    fireEvent.click(returnButton);
    expect(screen.getByTestId("danmaku-fine-tune-stub")).toBeInTheDocument();
    expect(screen.queryByTestId("learning-panel-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多工具" })).toHaveFocus();
  });

  it("仅 XML 项目直接打开弹幕编辑器，不显示 A/B 关系工具", async () => {
    useEditorStore.setState({ project: createEmptyProject() });
    render(<AlignmentEditorWorkspace />);

    expect(screen.getByTestId("xml-only-editor-shell")).toBeInTheDocument();
    expect(await screen.findByTestId("danmaku-fine-tune-stub")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "覆盖分析" })).not.toBeInTheDocument();
  });
});
