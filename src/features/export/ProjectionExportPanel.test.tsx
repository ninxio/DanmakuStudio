import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DanmakuItem } from "../../domain/danmaku/types";
import { createEmptyProject } from "../../domain/project/factory";
import { createLocalPathMediaReference } from "../../domain/project/mediaLibrary";
import type { EditorProject } from "../../domain/project/types";
import type { SourceProjectionResult } from "../../domain/timeline/sourceProjection";
import {
  clearAppSettings,
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import { useEditorStore } from "../../stores/editorStore";
import { ProjectionExportPanel } from "./ProjectionExportPanel";

const item: DanmakuItem = {
  id: "item-export",
  assetId: "asset-export",
  originalIndex: 0,
  sourceTimeMs: 0,
  mode: 1,
  fontSize: 25,
  color: 16_777_215,
  timestamp: 0,
  pool: 0,
  userHash: "user",
  rowId: "row",
  text: "测试弹幕",
  rawPFields: [],
  enabled: true
};

const materialRouteCases: Array<
  [condition: string, invalidateMaterials: (project: EditorProject) => void]
> = [
  [
    "XML 绑定不一致",
    (project) => {
      project.danmakuSourceBindings = [
        {
          ...project.danmakuSourceBindings[0],
          sourceMediaId: "other-source"
        }
      ];
    }
  ],
  [
    "参考媒体记录缺失",
    (project) => {
      project.mediaLibrary = project.mediaLibrary.filter(
        (media) => media.id !== "source-export"
      );
    }
  ]
];

function createProjection(
  overrides: Partial<SourceProjectionResult> = {}
): SourceProjectionResult {
  return {
    status: "ready",
    groups: [
      {
        targetMediaId: "target-export",
        targetName: "目标原片",
        targetFileName: "target.mkv",
        episodeLabel: "第 1 集",
        exportFileName: "target.xml",
        segments: [],
        entries: [{ item, finalTimeMs: 0, segmentId: "segment-export" }],
        disabledCount: 0,
        appliedRules: [],
        warnings: []
      }
    ],
    issues: [],
    contentSegmentCount: 1,
    ignoredSegmentCount: 0,
    projectedItemCount: 1,
    ignoredItemCount: 0,
    sourceOnlyItemCount: 0,
    unexpectedUnmappedItemCount: 0,
    unmappedItemCount: 0,
    ...overrides
  };
}

describe("ProjectionExportPanel", () => {
  beforeEach(() => {
    clearAppSettings();
    useEditorStore.setState({
      status: { message: "准备就绪", tone: "neutral" },
      workspaceIntentSequence: 0,
      workspaceIntentRequest: null
    });
  });

  it("空态不给禁用假按钮，首屏主动作一步回到匹配页", async () => {
    const user = userEvent.setup();
    const onGoMatching = vi.fn();
    const project = createEmptyProject();

    render(
      <ProjectionExportPanel
        projection={createProjection({
          status: "empty",
          groups: [],
          contentSegmentCount: 0,
          projectedItemCount: 0
        })}
        project={project}
        onGoMatching={onGoMatching}
      />
    );

    expect(screen.getByText("准备中")).toBeInTheDocument();
    expect(screen.getByText(/这里会按目标原片列出每一集的交付状态/)).toBeInTheDocument();
    expect(screen.queryByText("导出全部可用 XML")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "处理首个问题" }));
    expect(onGoMatching).toHaveBeenCalledOnce();
  });

  it("使用 segmentId 关系一步定位负责的编辑候选，不复制阻断判定", async () => {
    const user = userEvent.setup();
    const project = createProjectWithLocatedSegment();
    useEditorStore.setState({
      project,
      workspacePage: "export",
      alignmentEditorCandidateId: null
    });
    render(
      <ProjectionExportPanel
        projection={createProjection({
          status: "blocked",
          groups: [],
          issues: [
            {
              id: "segment-missing-time-map-segment-export",
              severity: "error",
              segmentId: "segment-export",
              message: "第 1 集未关联已确认时间图。"
            }
          ],
          projectedItemCount: 0
        })}
        project={project}
        onGoMatching={() => useEditorStore.getState().setWorkspacePage("matching")}
      />
    );

    await user.click(screen.getByRole("button", { name: "处理首个问题" }));
    expect(useEditorStore.getState().workspacePage).toBe("editing");
    expect(useEditorStore.getState().alignmentEditorCandidateId).toBeNull();
    expect(useEditorStore.getState().workspaceIntentRequest).toEqual({
      sequence: 1,
      intent: {
        page: "editing",
        target: { kind: "candidate", candidateId: "candidate-export" }
      }
    });
  });

  it.each(materialRouteCases)(
    "候选已引用来源段但%s时一步回素材页处理",
    async (_condition, invalidateMaterials) => {
      const user = userEvent.setup();
      const project = createProjectWithLocatedSegment();
      invalidateMaterials(project);
      useEditorStore.setState({
        project,
        workspacePage: "export",
        alignmentEditorCandidateId: null
      });
      const onGoMatching = vi.fn();
      render(
        <ProjectionExportPanel
          projection={createProjection({
            status: "blocked",
            groups: [],
            issues: [
              {
                id: "segment-missing-time-map-segment-export",
                severity: "error",
                segmentId: "segment-export",
                message: "第 1 集未关联已确认时间图。"
              }
            ],
            projectedItemCount: 0
          })}
          project={project}
          onGoMatching={onGoMatching}
        />
      );

      await user.click(screen.getByRole("button", { name: "处理首个问题" }));
      expect(useEditorStore.getState().workspacePage).toBe("materials");
      expect(useEditorStore.getState().alignmentEditorCandidateId).toBeNull();
      expect(useEditorStore.getState().workspaceIntentRequest).toEqual({
        sequence: 1,
        intent: {
          page: "materials",
          target:
            _condition === "XML 绑定不一致"
              ? { kind: "media", mediaId: "source-export" }
              : { kind: "xml", assetId: "asset-export" }
        }
      });
      expect(onGoMatching).not.toHaveBeenCalled();
    }
  );

  it("消费 exportEntry 意图并聚焦对应交付行，重复请求不会丢失", async () => {
    const project = createProjectWithLocatedSegment();
    useEditorStore.setState({ project, workspacePage: "export" });
    const view = render(
      <ProjectionExportPanel
        projection={createProjection()}
        project={project}
        onGoMatching={() => undefined}
      />
    );

    act(() => {
      useEditorStore.getState().requestWorkspaceIntent({
        page: "export",
        target: { kind: "exportEntry", targetMediaId: "target-export" }
      });
    });
    await waitFor(() => expect(useEditorStore.getState().workspaceIntentRequest).toBeNull());
    const summary = screen.getByText(/第 1 集/).closest("summary");
    expect(summary).toHaveFocus();

    act(() => {
      useEditorStore.getState().requestWorkspaceIntent({
        page: "export",
        target: { kind: "exportEntry", targetMediaId: "target-export" }
      });
    });
    view.rerender(
      <ProjectionExportPanel
        projection={createProjection()}
        project={project}
        onGoMatching={() => undefined}
      />
    );
    await waitFor(() => expect(useEditorStore.getState().workspaceIntentRequest).toBeNull());
    expect(summary).toHaveFocus();
  });

  it("投影已就绪但导出环境不可用时独立说明恢复方式，不伪造交付阻断", () => {
    render(
      <ProjectionExportPanel
        projection={createProjection()}
        project={createEmptyProject("环境不可用")}
        onGoMatching={() => undefined}
      />
    );

    const blockerMetric = screen.getByText("阻断").parentElement;
    expect(blockerMetric).not.toBeNull();
    expect(blockerMetric).toHaveTextContent("0 项");
    const unavailableReason = "高精度分集导出必须先在设置中选择桌面导出文件夹。";
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const availability = screen.getByTestId("delivery-availability");
    expect(availability).toBeVisible();
    expect(availability).toHaveTextContent(unavailableReason);
    expect(screen.getAllByTestId("delivery-availability")).toHaveLength(1);
    expect(availability).toHaveTextContent("正式导出暂不可用");
    fireEvent.click(screen.getByRole("button", { name: /^检查详情/ }));
    expect(screen.getByText("投影内容没有交付阻断")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭导出检查详情" }));
    expect(screen.getByRole("button", { name: "导出全部分集 XML" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出全部分集 XML" })).toHaveAttribute(
      "title",
      unavailableReason
    );
  });

  it("防止并发导出，保留目录失败反馈，并在项目变化后清除完成态", async () => {
    const restoreTauri = enableTauriForTest();
    const user = userEvent.setup();
    const project = createEmptyProject();
    const deferred = createDeferred<{
      mode: "directory";
      fileCount: number;
      fileName: string;
      filePath: string;
      directoryPath: string;
      wasRenamed: boolean;
    }>();
    const exportGroups = vi.fn(() => deferred.promise);
    const openDirectory = vi.fn().mockRejectedValue(new Error("目录不可用"));
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      export: { defaultDirectory: "D:\\exports" }
    });

    try {
      const { rerender } = render(
        <ProjectionExportPanel
          projection={createProjection()}
          project={project}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
          openDirectory={openDirectory}
        />
      );
      const exportButton = screen.getByText("导出全部可用 XML").closest("button");
      if (!exportButton) throw new Error("未找到批量导出主动作。");

      fireEvent.click(exportButton);
      fireEvent.click(exportButton);
      expect(exportGroups).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "正在核验并导出…" })).toBeDisabled();

      deferred.resolve({
        mode: "directory",
        fileCount: 1,
        fileName: "target.xml",
        filePath: "D:\\exports\\target.xml",
        directoryPath: "D:\\exports",
        wasRenamed: false
      });
      expect(await screen.findByTestId("export-completion")).toHaveTextContent(
        "D:\\exports\\target.xml"
      );

      await user.click(screen.getByRole("button", { name: "打开导出目录" }));
      expect(openDirectory).toHaveBeenCalledWith("D:\\exports");
      await waitFor(() =>
        expect(useEditorStore.getState().status).toEqual({
          message: "打开目录失败：目录不可用",
          tone: "error"
        })
      );

      const changedProject: EditorProject = {
        ...project,
        id: "project-after-export"
      };
      rerender(
        <ProjectionExportPanel
          projection={createProjection()}
          project={changedProject}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
          openDirectory={openDirectory}
        />
      );

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "导出" })).toBeInTheDocument()
      );
      expect(screen.queryByTestId("export-completion")).not.toBeInTheDocument();
    } finally {
      restoreTauri();
    }
  });

  it("离开导出页再返回仍恢复同一项目版本的运行与完成结果", async () => {
    const restoreTauri = enableTauriForTest();
    const project = { ...createEmptyProject("离页恢复"), id: "project-export-resume" };
    const deferred = createDeferred<{
      mode: "directory";
      fileCount: number;
      fileName: string;
      filePath: string;
      directoryPath: string;
      wasRenamed: boolean;
    }>();
    const exportGroups = vi.fn(() => deferred.promise);
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      export: { defaultDirectory: "D:\\exports" }
    });

    try {
      const firstVisit = render(
        <ProjectionExportPanel
          projection={createProjection()}
          project={project}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
        />
      );
      fireEvent.click(screen.getByText("导出全部可用 XML"));
      expect(screen.getByRole("button", { name: "正在核验并导出…" })).toBeDisabled();
      firstVisit.unmount();

      render(
        <ProjectionExportPanel
          projection={createProjection()}
          project={project}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
        />
      );
      expect(screen.getByRole("button", { name: "正在核验并导出…" })).toBeDisabled();
      expect(exportGroups).toHaveBeenCalledOnce();

      deferred.resolve({
        mode: "directory",
        fileCount: 1,
        fileName: "target.xml",
        filePath: "D:\\exports\\target.xml",
        directoryPath: "D:\\exports",
        wasRenamed: false
      });
      expect(await screen.findByTestId("export-completion")).toHaveTextContent(
        "已导出 1 个分集 XML"
      );
    } finally {
      restoreTauri();
    }
  });

  it("导出失败后离页返回仍保留失败原因并提供同一主动作重试", async () => {
    const restoreTauri = enableTauriForTest();
    const user = userEvent.setup();
    const project = { ...createEmptyProject("失败恢复"), id: "project-export-failure" };
    const exportGroups = vi.fn(() => {
      useEditorStore.setState({
        status: { message: "媒体身份已变化，请重新连接。", tone: "error" }
      });
      return Promise.resolve(null);
    });
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      export: { defaultDirectory: "D:\\exports" }
    });

    try {
      const firstVisit = render(
        <ProjectionExportPanel
          projection={createProjection()}
          project={project}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
        />
      );
      await user.click(screen.getByText("导出全部可用 XML"));
      expect(await screen.findByRole("alert")).toHaveTextContent("媒体身份已变化");
      expect(screen.getByText("重试导出全部可用 XML")).toBeInTheDocument();
      firstVisit.unmount();

      render(
        <ProjectionExportPanel
          projection={createProjection()}
          project={project}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
        />
      );
      expect(screen.getByRole("alert")).toHaveTextContent("媒体身份已变化");
      expect(exportGroups).toHaveBeenCalledOnce();
    } finally {
      restoreTauri();
    }
  });
});

function createProjectWithLocatedSegment(): EditorProject {
  const project = createEmptyProject("精确定位");
  const sourceMedia = createLocalPathMediaReference(
    "source-export",
    "bilibiliReference",
    "C:\\media\\source.mp4",
    60_000,
    project.createdAt
  );
  const targetMedia = {
    ...createLocalPathMediaReference(
      "target-export",
      "targetOriginal",
      "C:\\media\\target.mkv",
      60_000,
      project.createdAt
    ),
    episodeLabel: "第 1 集"
  };
  return {
    ...project,
    id: "project-located-segment",
    assets: [
      {
        id: "asset-export",
        name: "第 1 集弹幕",
        fileName: "S01E01.xml",
        color: "#4cc9f0",
        items: [item],
        warnings: [],
        importedAt: project.createdAt,
        sourceReceipt: null
      }
    ],
    mediaLibrary: [sourceMedia, targetMedia],
    danmakuSourceBindings: [
      {
        id: "binding-export",
        assetId: "asset-export",
        sourceMediaId: "source-export",
        linkedAt: project.createdAt,
        updatedAt: project.updatedAt
      }
    ],
    danmakuSourceSegments: [
      {
        id: "segment-export",
        label: "第 1 集",
        kind: "content",
        assetId: "asset-export",
        sourceMediaId: "source-export",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetMediaId: "target-export",
        targetStartMs: 0,
        timingRules: [],
        timeMapId: null,
        episodeKey: "S01E01",
        episodeLabel: "第 1 集",
        note: "",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      }
    ],
    mediaMatchCandidates: [
      {
        id: "candidate-export",
        batchId: "batch-export",
        sourceMediaId: "source-export",
        targetMediaId: "target-export",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetStartMs: 0,
        targetEndMs: 60_000,
        timingRules: [],
        confidence: 0.8,
        proposal: {
          anchors: [],
          cutCandidates: [],
          confidence: 0.8,
          diagnostics: [],
          evidence: {
            algorithm: "alignment-v2-edit-map",
            completeFingerprintCount: 0,
            sourceFingerprintCount: 0,
            fingerprintMatchCount: 0,
            monotonicMatchCount: 0,
            strongAnchorCount: 0,
            weakAnchorCount: 0,
            offsetClusterCount: 0,
            refinedCandidateCount: 0,
            lowConfidenceRegionCount: 1,
            quality: "low"
          },
          matchRange: {
            sourceStartMs: 0,
            sourceEndMs: 60_000,
            targetStartMs: 0,
            targetEndMs: 60_000,
            coverage: 1
          }
        },
        timeMapId: "candidate-map-export",
        confirmedTimeMapId: null,
        state: "blocked",
        appliedSegmentIds: ["segment-export"],
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      }
    ]
  };
}

function enableTauriForTest(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", {
    configurable: true,
    value: true
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "isTauri", descriptor);
      return;
    }
    Reflect.deleteProperty(globalThis, "isTauri");
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
