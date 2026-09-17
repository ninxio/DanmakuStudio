import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import type { DanmakuClip } from "../../domain/danmaku/types";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import type { ProjectMediaReference, ProjectMediaRole } from "../../domain/project/types";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { WorkflowOverviewDialog } from "./WorkflowOverviewDialog";

function resetDialogStore(): void {
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
    workspacePage: "matching"
  });
}

function renderDialog(overrides: Partial<ComponentProps<typeof WorkflowOverviewDialog>> = {}) {
  const props: ComponentProps<typeof WorkflowOverviewDialog> = {
    onClose: vi.fn(),
    onImportVideo: vi.fn(),
    onImportXml: vi.fn(),
    onGoMatching: vi.fn(),
    onGoEditing: vi.fn(),
    onSaveProject: vi.fn(),
    onExportXml: vi.fn(),
    ...overrides
  };
  return render(<WorkflowOverviewDialog {...props} />);
}

describe("WorkflowOverviewDialog", () => {
  beforeEach(() => {
    resetDialogStore();
  });

  it("保留初始焦点、关闭入口、Escape 和不关闭的遮罩", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ onClose });

    const closeButton = screen.getByRole("button", { name: "关闭新手引导" });
    expect(closeButton).toHaveFocus();

    await user.click(screen.getByTestId("workflow-overview-dialog"));
    expect(onClose).not.toHaveBeenCalled();

    const escapeEvent = createEvent.keyDown(window, {
      key: "Escape",
      code: "Escape"
    });
    fireEvent(window, escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("保留建议动作重复和可达顺序，实时刷新时不重置焦点", async () => {
    const user = userEvent.setup();
    renderDialog();

    const title = screen.getByRole("heading", { name: "开始 / 下一步" });
    const stageList = screen.getByRole("list", { name: "工作流阶段" });
    const recommendationLabel = screen.getByText("建议下一步");
    const commonActionsHeading = screen.getByRole("heading", { name: "常用操作" });
    const hintHeading = screen.getByRole("heading", { name: "提示" });
    expectDocumentOrder([
      title,
      stageList,
      recommendationLabel,
      commonActionsHeading,
      hintHeading
    ]);

    const importXmlButtons = screen.getAllByRole("button", {
      name: "去素材页导入 XML"
    });
    expect(importXmlButtons).toHaveLength(2);
    expectDocumentOrder(importXmlButtons);

    await user.tab();
    expect(importXmlButtons[0]).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "添加视频对齐素材（可选）" })).toHaveFocus();
    await user.tab();
    expect(importXmlButtons[1]).toHaveFocus();

    const saveButton = screen.getByRole("button", { name: "保存项目" });
    saveButton.focus();
    expect(saveButton).toHaveFocus();

    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { assetId: "asset-workflow-live", fileName: "workflow-live.xml" }
    );
    const clip: DanmakuClip = {
      id: "clip-workflow-live",
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
      expect(screen.getAllByRole("button", { name: "去导出页导出 XML" })).toHaveLength(2)
    );
    expect(saveButton).toHaveFocus();
    expect(screen.getAllByRole("button", { name: "去素材页导入 XML" })).toHaveLength(1);
  });

  it("禁用动作保留原因且不会触发关闭或目标动作", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onGoMatching = vi.fn();
    renderDialog({ onClose, onGoMatching });

    const disabledAction = screen.getByRole("button", {
      name: "智能匹配（当前可跳过）"
    });
    expect(disabledAction).toBeDisabled();
    expect(disabledAction).toHaveAttribute(
      "title",
      "当前项目直接使用 XML 自身时间轴，不需要智能匹配。"
    );

    await user.click(disabledAction);
    expect(onClose).not.toHaveBeenCalled();
    expect(onGoMatching).not.toHaveBeenCalled();
  });

  it("进入匹配时先关闭 Dialog 再调用目标动作", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { assetId: "asset-workflow-route", fileName: "workflow-route.xml" }
    );
    act(() => {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          assets: [asset],
          mediaLibrary: [
            createMedia("source-workflow-route", "bilibiliReference"),
            createMedia("target-workflow-route", "targetOriginal")
          ],
          danmakuSourceBindings: [
            {
              id: "binding-workflow-route",
              assetId: asset.id,
              sourceMediaId: "source-workflow-route",
              linkedAt: "2026-08-11T00:00:00.000Z",
              updatedAt: "2026-08-11T00:00:00.000Z"
            }
          ]
        }
      });
    });
    renderDialog({
      onClose: () => {
        callOrder.push("close");
      },
      onGoMatching: () => {
        callOrder.push("matching");
      }
    });

    const reviewButton = screen
      .getAllByRole("button", { name: "去匹配页运行智能分析" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(reviewButton).toBeDefined();
    if (!reviewButton) {
      throw new Error("未找到可用的匹配动作。");
    }

    await user.click(reviewButton);
    expect(callOrder).toEqual(["close", "matching"]);
  });

  it("导入动作只调用外部 callback，不由容器额外关闭", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    renderDialog({
      onClose: () => {
        callOrder.push("close");
      },
      onImportXml: () => {
        callOrder.push("import-xml");
      }
    });

    await user.click(screen.getAllByRole("button", { name: "去素材页导入 XML" })[0]);
    expect(callOrder).toEqual(["import-xml"]);
  });
});

function expectDocumentOrder(elements: HTMLElement[]): void {
  for (let index = 0; index < elements.length - 1; index += 1) {
    expect(
      elements[index].compareDocumentPosition(elements[index + 1]) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
  }
}

function createMedia(id: string, role: ProjectMediaRole): ProjectMediaReference {
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
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
}
