import { ManualAlignmentWorkspace } from "../matching/ManualAlignmentWorkspace";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import {
  createEmbyItemMediaBinding,
  createLocalPathMediaBinding
} from "../../domain/project/mediaBinding";
import {
  CURRENT_SCHEMA_VERSION,
  type ProjectMediaReference,
  type ProjectMediaRole
} from "../../domain/project/types";
import type { SourceProjectionResult } from "../../domain/timeline/sourceProjection";
import {
  pickAlignmentMediaPath,
  pickMediaPaths,
  pickXmlPaths
} from "../../infrastructure/file-system/nativeDialogs";
import {
  clearAppSettings,
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { AssetPanel, ProjectionExportPanel } from "./AssetPanel";

const nativeXmlMocks = vi.hoisted(() => ({
  importPaths: vi.fn()
}));

vi.mock("../../infrastructure/file-system/nativeDialogs", () => ({
  MEDIA_FILE_EXTENSIONS: [
    "mp4",
    "mkv",
    "webm",
    "mov",
    "m4v",
    "avi",
    "flv",
    "ts",
    "m2ts",
    "mp3",
    "m4a",
    "aac",
    "flac",
    "wav",
    "ogg",
    "opus"
  ],
  pickMediaPaths: vi.fn(),
  pickXmlPaths: vi.fn(),
  pickAlignmentMediaPath: vi.fn()
}));
vi.mock("../../infrastructure/xml/nativeXmlReceipt", () => ({
  importNativeXmlPaths: nativeXmlMocks.importPaths
}));

describe("资源面板", () => {
  beforeEach(() => {
    clearAppSettings();
    vi.mocked(pickAlignmentMediaPath).mockReset();
    vi.mocked(pickMediaPaths).mockReset();
    vi.mocked(pickXmlPaths).mockReset();
    nativeXmlMocks.importPaths.mockReset();
    nativeXmlMocks.importPaths.mockRejectedValue(new Error("测试未配置原生 XML 导入"));
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>`,
      { fileName: "01 - 1.1.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
      workspacePage: "materials"
    });
  });

  it("可以从资源栏删除已导入的弹幕素材", async () => {
    const user = userEvent.setup();
    render(<AssetPanel section="materials" />);
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(0));
  });

  it("浏览器预览资源明确提示正式导出前需桌面重新导入", () => {
    render(<AssetPanel section="materials" />);

    expect(screen.getByText("仅预览")).toBeInTheDocument();
    expect(screen.getByText(/正式原片投影前需在桌面端重新导入/)).toBeInTheDocument();
  });

  it("桌面导入按钮使用原生多选并把权威收据显示为已受验证", async () => {
    const restoreTauri = enableTauriForTest();
    const asset = useEditorStore.getState().project.assets[0];
    vi.mocked(pickXmlPaths).mockResolvedValue(["D:\\danmaku\\verified.xml"]);
    nativeXmlMocks.importPaths.mockResolvedValue([
      {
        fileName: "verified.xml",
        receipt: createTestXmlSourceReceipt(),
        items: asset.items.map((item) => ({
          originalIndex: item.originalIndex,
          sourceTimeMs: item.sourceTimeMs,
          mode: item.mode,
          fontSize: item.fontSize,
          color: item.color,
          timestamp: item.timestamp,
          pool: item.pool,
          userHash: item.userHash,
          rowId: item.rowId,
          text: item.text,
          rawPFields: [...item.rawPFields]
        })),
        warnings: []
      }
    ]);

    try {
      const user = userEvent.setup();
      render(<AssetPanel section="materials" />);
      await selectMenuItem(user, "添加素材", "导入 XML");

      await waitFor(() => expect(screen.getByText("已受验证")).toBeInTheDocument());
      expect(pickXmlPaths).toHaveBeenCalledTimes(1);
      expect(nativeXmlMocks.importPaths).toHaveBeenCalledWith(["D:\\danmaku\\verified.xml"]);
      expect(useEditorStore.getState().project.assets).toHaveLength(1);
      expect(useEditorStore.getState().project.assets[0].sourceReceipt).toEqual(
        createTestXmlSourceReceipt()
      );
    } finally {
      restoreTauri();
    }
  });

  it("弹幕素材页可以绑定、更换和解除 XML 的 B 站参考素材", async () => {
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const asset = project.assets[0];
    useEditorStore.setState({
      project: {
        ...project,
        mediaLibrary: [
          createProjectMediaReference("source-a", "bilibiliReference", {
            name: "B 站参考 A",
            fileName: "source-a.mp4"
          }),
          createProjectMediaReference("source-b", "bilibiliReference", {
            name: "B 站参考 B",
            fileName: "source-b.mp4"
          }),
          createProjectMediaReference("target-media", "targetOriginal", {
            name: "目标原片",
            fileName: "target.mp4"
          })
        ]
      }
    });

    render(<AssetPanel section="materials" />);
    expect(screen.getByText("待选来源")).toBeInTheDocument();
    const sourceSelect = screen.getByLabelText(`${asset.fileName} 弹幕来源素材`);
    expect(
      within(sourceSelect).getByRole("option", { name: "B 站参考 A" })
    ).toBeInTheDocument();
    expect(
      within(sourceSelect).getByRole("option", { name: "B 站参考 B" })
    ).toBeInTheDocument();
    expect(
      within(sourceSelect).queryByRole("option", { name: "目标原片" })
    ).not.toBeInTheDocument();

    await user.selectOptions(sourceSelect, "source-a");
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceBindings).toMatchObject([
        {
          assetId: asset.id,
          sourceMediaId: "source-a"
        }
      ])
    );
    const bindingId = useEditorStore.getState().project.danmakuSourceBindings[0].id;
    expect(sourceSelect).toHaveValue("source-a");

    await user.selectOptions(sourceSelect, "source-b");
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceBindings[0]).toMatchObject({
        id: bindingId,
        assetId: asset.id,
        sourceMediaId: "source-b"
      })
    );
    expect(sourceSelect).toHaveValue("source-b");

    await user.selectOptions(sourceSelect, "");
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceBindings).toEqual([])
    );
    expect(screen.getByText("待选来源")).toBeInTheDocument();
  });

  it("媒体页可以批量导入原片和 B 站参考素材", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>((object) =>
      object instanceof File ? `blob:${object.name}` : "blob:media"
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });

    try {
      render(<AssetPanel section="materials" />);
      expect(screen.getByRole("button", { name: "添加素材" })).toBeInTheDocument();
      expect(screen.getByRole("tablist", { name: "素材分类" })).toBeInTheDocument();
      expect(screen.getByTestId("materials-primary-action")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("导入原片素材文件"), {
        target: {
          files: [
            new File(["target-a"], "full-a.mp4", { type: "video/mp4" }),
            new File(["target-b"], "full-b.webm", { type: "video/webm" })
          ]
        }
      });
      fireEvent.change(screen.getByLabelText("导入 B 站参考素材文件"), {
        target: {
          files: [new File(["source-a"], "bilibili-a.mp4", { type: "video/mp4" })]
        }
      });

      await waitFor(() =>
        expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(3)
      );
      const project = useEditorStore.getState().project;
      const targetMedia = project.mediaLibrary.filter(
        (media) => media.role === "targetOriginal"
      );
      const sourceMedia = project.mediaLibrary.filter(
        (media) => media.role === "bilibiliReference"
      );
      expect(targetMedia.map((media) => media.fileName)).toEqual(["full-a.mp4", "full-b.webm"]);
      expect(sourceMedia.map((media) => media.fileName)).toEqual(["bilibili-a.mp4"]);
      expect(project.mediaLibrary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileName: "full-a.mp4",
            referenceKind: "browserFile",
            sourceSummary: "本地浏览器文件引用",
            localPath: null
          }),
          expect.objectContaining({
            fileName: "full-b.webm",
            referenceKind: "browserFile",
            sourceSummary: "本地浏览器文件引用",
            localPath: null
          }),
          expect.objectContaining({
            fileName: "bilibili-a.mp4",
            referenceKind: "browserFile",
            sourceSummary: "本地浏览器文件引用",
            localPath: null
          })
        ])
      );
      expect(project.mediaBinding).toBeNull();
      expect(project.media).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /^原片 / }));
      expect(
        within(screen.getByTestId("targetOriginal-dropzone")).getByText("full-a.mp4")
      ).toBeVisible();
      expect(
        within(screen.getByTestId("targetOriginal-dropzone")).getByText("full-b.webm")
      ).toBeVisible();
      for (const fileName of ["full-a.mp4", "full-b.webm"]) {
        fireEvent.click(screen.getByRole("button", { name: `${fileName} 文件详情` }));
        expect(
          within(screen.getByRole("dialog", { name: "素材详情与音轨" })).getByText("已连接")
        ).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "关闭素材详情与音轨" }));
      }
      fireEvent.click(screen.getByRole("tab", { name: /^参考 / }));
      expect(
        within(screen.getByTestId("bilibiliReference-dropzone")).getByText("bilibili-a.mp4")
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "bilibili-a.mp4 文件详情" }));
      expect(
        within(screen.getByRole("dialog", { name: "素材详情与音轨" })).getByText("已连接")
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "关闭素材详情与音轨" }));
      await expandLegacyMaterialsPanel(userEvent.setup());
      const targetPanel = getTargetMediaBindingPanel();
      expect(within(targetPanel).getByText("未绑定")).toBeInTheDocument();
      expect(within(targetPanel).queryByText("本地文件已连接")).not.toBeInTheDocument();
      expect(createObjectUrl).toHaveBeenCalledTimes(3);
    } finally {
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
    }
  });

  it("三个素材区支持直接拖放，并用摘要给出下一步", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn<(object: Blob | MediaSource) => string>((object) =>
        object instanceof File ? `blob:${object.name}` : "blob:media"
      )
    });

    try {
      render(<AssetPanel section="materials" />);
      expect(screen.getByTestId("materials-summary")).toHaveTextContent("开始编辑弹幕");

      fireEvent.click(screen.getByRole("tab", { name: /^原片 / }));
      fireEvent.drop(screen.getByTestId("targetOriginal-dropzone"), {
        dataTransfer: {
          types: ["Files"],
          files: [new File(["target"], "S01E01.mkv", { type: "video/x-matroska" })]
        }
      });
      fireEvent.click(screen.getByRole("tab", { name: /^参考 / }));
      fireEvent.drop(screen.getByTestId("bilibiliReference-dropzone"), {
        dataTransfer: {
          types: ["Files"],
          files: [new File(["reference"], "reference.mp4", { type: "video/mp4" })]
        }
      });
      fireEvent.click(screen.getByRole("tab", { name: /^弹幕 XML / }));
      fireEvent.drop(screen.getByTestId("xml-material-dropzone"), {
        dataTransfer: {
          types: ["Files"],
          files: [
            new File(
              [
                '<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,0,0,u,r">拖入</d></i>'
              ],
              "02.xml",
              { type: "text/xml" }
            )
          ]
        }
      });

      await waitFor(() => {
        expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(2);
        expect(useEditorStore.getState().project.assets).toHaveLength(2);
      });
      expect(screen.getByTestId("materials-summary")).toHaveTextContent("确认 2 个弹幕来源");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen
          .getByRole("table", { name: "弹幕素材与来源关系" })
          .querySelectorAll("tbody details")
      ).toHaveLength(2);
      for (const [category, fileName] of [
        ["原片", "S01E01.mkv"],
        ["参考", "reference.mp4"]
      ]) {
        fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${category} `) }));
        fireEvent.click(screen.getByRole("button", { name: `${fileName} 文件详情` }));
        const detailSheet = screen.getByRole("dialog", { name: "素材详情与音轨" });
        expect(
          within(detailSheet).getByText("文件详情").closest("details")
        ).not.toHaveAttribute("open");
        fireEvent.click(
          within(detailSheet).getByRole("button", { name: "关闭素材详情与音轨" })
        );
      }
    } finally {
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
    }
  });

  it("仅有 XML 时一键建立时间线并直接进入弹幕编辑", async () => {
    const user = userEvent.setup();
    render(<AssetPanel section="materials" />);

    await user.click(screen.getByRole("button", { name: /开始编辑弹幕/ }));

    expect(useEditorStore.getState().project.clips).toHaveLength(1);
    expect(useEditorStore.getState().workspacePage).toBe("editing");
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(0);
  });

  it("仅 XML 项目在导出页直接显示单文件导出主入口", () => {
    const project = useEditorStore.getState().project;
    const asset = {
      ...project.assets[0],
      sourceReceipt: createTestXmlSourceReceipt()
    };
    useEditorStore.setState({
      project: {
        ...project,
        assets: [asset],
        clips: [
          {
            id: "xml-only-clip",
            assetId: asset.id,
            name: "弹幕时间线",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 1,
            localOffsetMs: 0,
            enabled: true
          }
        ]
      }
    });
    render(<AssetPanel section="export" />);

    expect(screen.getByTestId("xml-only-export-panel")).toHaveTextContent("导出当前弹幕时间线");
    expect(screen.getByTestId("xml-export-summary")).toHaveTextContent("1 条弹幕");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "统计与报告" }));
    expect(screen.getByRole("dialog", { name: "弹幕统计与报告" })).toHaveTextContent(
      "验证条数：1"
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭弹幕统计与报告" }));
    expect(screen.getByRole("button", { name: "导出 XML" })).toBeEnabled();
    expect(useEditorStore.getState().exportDraft).toBeNull();
  });

  it("桌面端批量按钮会把原生多选返回的全部路径按角色导入", async () => {
    const restoreTauri = enableTauriForTest();
    const user = userEvent.setup();
    vi.mocked(pickMediaPaths).mockImplementation((role) =>
      Promise.resolve(
        role === "targetOriginal"
          ? ["D:\\media\\S01E01.mkv", "D:\\media\\S01E02.mp4"]
          : ["D:\\media\\collection.mkv"]
      )
    );

    try {
      render(<AssetPanel section="materials" />);

      await user.click(screen.getByRole("button", { name: "添加素材" }));
      expect(
        screen.getByRole("menuitem", { name: "从 Emby 导入原片音频" })
      ).toBeInTheDocument();
      await user.keyboard("{Escape}");
      await selectMenuItem(user, "添加素材", "批量导入原片素材");
      await waitFor(() =>
        expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(2)
      );
      await selectMenuItem(user, "添加素材", "批量导入 B 站参考素材");
      await waitFor(() =>
        expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(3)
      );

      expect(pickMediaPaths).toHaveBeenNthCalledWith(1, "targetOriginal");
      expect(pickMediaPaths).toHaveBeenNthCalledWith(2, "bilibiliReference");
      expect(useEditorStore.getState().project.mediaLibrary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "targetOriginal",
            localPath: "D:\\media\\S01E01.mkv",
            referenceKind: "localPath",
            connectionState: "connected"
          }),
          expect.objectContaining({
            role: "targetOriginal",
            localPath: "D:\\media\\S01E02.mp4"
          }),
          expect.objectContaining({
            role: "bilibiliReference",
            localPath: "D:\\media\\collection.mkv"
          })
        ])
      );
      expect(useEditorStore.getState().history.past.map((entry) => entry.label)).toEqual([
        "批量导入原片素材",
        "批量导入 B 站参考素材"
      ]);
      expect(useEditorStore.getState().project.media).toBeNull();
      expect(useEditorStore.getState().project.mediaBinding).toBeNull();
    } finally {
      restoreTauri();
    }
  });

  it("桌面端取消原生批量选择时不改变项目", async () => {
    const restoreTauri = enableTauriForTest();
    const user = userEvent.setup();
    vi.mocked(pickMediaPaths).mockResolvedValue([]);

    try {
      render(<AssetPanel section="materials" />);

      await selectMenuItem(user, "添加素材", "批量导入原片素材");
      await waitFor(() => expect(pickMediaPaths).toHaveBeenCalledWith("targetOriginal"));

      expect(useEditorStore.getState().project.mediaLibrary).toEqual([]);
      expect(useEditorStore.getState().history.past).toEqual([]);
    } finally {
      restoreTauri();
    }
  });

  it("媒体页可以选择本地路径作为 mpv 目标原片", async () => {
    const user = userEvent.setup();
    vi.mocked(pickAlignmentMediaPath).mockResolvedValue("D:\\media\\full.mkv");

    render(<AssetPanel section="materials" />);
    await expandLegacyMaterialsPanel(user);
    await user.click(
      within(getTargetMediaBindingPanel()).getByRole("button", { name: "选择本地路径" })
    );

    await waitFor(() =>
      expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
        kind: "localFile",
        displayName: "full",
        fileName: "full.mkv",
        localPath: "D:\\media\\full.mkv"
      })
    );
    const targetPanel = getTargetMediaBindingPanel();
    expect(within(targetPanel).getByText("本地文件已连接")).toBeInTheDocument();
    expect(within(targetPanel).getByText("D:\\media\\full.mkv")).toBeInTheDocument();
  });

  it("媒体页显示保存恢复的 Emby 目标原片绑定", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        mediaBinding: {
          id: "binding-emby",
          kind: "embyItem",
          displayName: "测试剧集 / S01E02 / 第二集",
          itemId: "emby-item-1",
          itemName: "第二集",
          itemType: "Episode",
          seriesName: "测试剧集",
          seasonNumber: 1,
          episodeNumber: 2,
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z",
          server: {
            serverUrl: "https://emby.example.test",
            pathPrefix: "/emby",
            username: "tester"
          },
          mediaSources: [
            {
              id: "source-1",
              name: "主媒体源",
              container: "mkv",
              videoCodec: "h264",
              audioCodec: "aac",
              width: 1920,
              height: 1080,
              bitrate: 8_000_000,
              sizeBytes: 1_000_000_000,
              runtimeMs: 3_000_000
            }
          ]
        }
      }
    });

    render(<AssetPanel section="materials" />);
    await expandLegacyMaterialsPanel(user);

    const targetPanel = getTargetMediaBindingPanel();
    expect(within(targetPanel).getByText("Emby 条目已保存")).toBeInTheDocument();
    expect(within(targetPanel).getByText("测试剧集 / S01E02 / 第二集")).toBeInTheDocument();
    expect(
      within(targetPanel).getByText("主媒体源 / mkv / h264 / aac / 1920x1080")
    ).toBeInTheDocument();
  });

  it("媒体页展示匹配评分并可发送评分提案到时间轴预览", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(createTimedXml(240, 15), {
      fileName: "测试剧集 S01E02.xml"
    });
    useEditorStore.setState({
      project: {
        ...createEmptyProject("测试剧集 S01E02"),
        assets: [asset],
        mediaBinding: createEmbyItemMediaBinding(
          "binding-emby",
          {
            id: "emby-item-2",
            name: "第二集",
            type: "Episode",
            seriesName: "测试剧集",
            seasonNumber: 1,
            episodeNumber: 2,
            durationMs: 3_600_000,
            mediaSources: []
          },
          {
            serverUrl: "https://emby.example.test",
            pathPrefix: "/emby",
            username: "tester"
          },
          "2026-07-10T00:00:00.000Z"
        )
      }
    });

    render(<AssetPanel section="materials" />);
    await expandLegacyMaterialsPanel(user);

    expect(screen.getByText("匹配评分")).toBeInTheDocument();
    expect(screen.getByText("很可能匹配")).toBeInTheDocument();
    expect(screen.getByText("片名与季集")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "预览评分提案" }));

    await waitFor(() =>
      expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(1)
    );
    expect(useEditorStore.getState().alignmentProposal?.diagnostics[0]).toContain("匹配评分");
    expect(useEditorStore.getState().status.message).toBe(
      "已发送到时间轴预览：1 个同步线索，0 个候选版本差异。"
    );
  });

  it("传统分 P 导出默认收起，展开后 Emby 时长面板只保留搜索入口", async () => {
    const user = userEvent.setup();
    render(<AssetPanel section="export" />);

    expect(screen.queryByText("Emby 时长")).not.toBeInTheDocument();
    await selectMenuItem(user, "导出工具", "单文件导出与高级检查");
    await user.click(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ }));
    expect(screen.getByText("Emby 时长")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeInTheDocument();
    expect(screen.queryByLabelText("服务器")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("路径")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("用户名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("大量未覆盖弹幕只显示提示，不禁用已配置目录的分集导出", () => {
    const restoreTauri = enableTauriForTest();
    const project = useEditorStore.getState().project;
    const item = project.assets[0].items[0];
    const projection: SourceProjectionResult = {
      status: "readyWithWarnings",
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
      issues: [
        {
          id: "unmapped-items",
          severity: "warning",
          segmentId: null,
          message:
            "6551 条弹幕不在任何已确认来源段内，本次不会导出并已计入未映射统计。原 XML 可以长于当前导出范围，此项不会阻断导出；如需保留这些弹幕，请补充对应来源段。"
        }
      ],
      contentSegmentCount: 1,
      ignoredSegmentCount: 0,
      projectedItemCount: 1,
      ignoredItemCount: 0,
      sourceOnlyItemCount: 0,
      unexpectedUnmappedItemCount: 6551,
      unmappedItemCount: 6551
    };
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      export: { defaultDirectory: "D:\\exports" }
    });

    try {
      render(
        <ProjectionExportPanel
          projection={projection}
          project={project}
          onGoMatching={() => undefined}
        />
      );

      expect(screen.getByText("需复核")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /^检查详情/ }));
      expect(screen.getByText("6,551 条")).toBeInTheDocument();
      expect(screen.getByText(/此项不会阻断导出/)).toBeInTheDocument();
      expect(screen.queryByText(/安全阈值/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "关闭导出检查详情" }));
      expect(screen.getByRole("button", { name: "导出全部分集 XML" })).toBeEnabled();
    } finally {
      restoreTauri();
    }
  });

  it("正式分集导出完成后显示实际路径、再次导出和打开目录", async () => {
    const restoreTauri = enableTauriForTest();
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const item = project.assets[0].items[0];
    const projection: SourceProjectionResult = {
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
      unmappedItemCount: 0
    };
    const exportGroups = vi.fn().mockResolvedValue({
      mode: "directory" as const,
      fileCount: 1,
      fileName: "target.xml",
      filePath: "D:\\exports\\target.xml",
      directoryPath: "D:\\exports",
      wasRenamed: false
    });
    const openDirectory = vi.fn().mockResolvedValue(undefined);
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      export: { defaultDirectory: "D:\\exports" }
    });

    try {
      render(
        <ProjectionExportPanel
          projection={projection}
          project={project}
          onGoMatching={() => undefined}
          exportGroups={exportGroups}
          openDirectory={openDirectory}
        />
      );
      await user.click(screen.getByRole("button", { name: "导出全部分集 XML" }));

      expect(await screen.findByTestId("export-completion")).toHaveTextContent(
        "D:\\exports\\target.xml"
      );
      expect(screen.getByRole("button", { name: "再次导出全部分集 XML" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "打开导出目录" }));
      expect(openDirectory).toHaveBeenCalledWith("D:\\exports");
    } finally {
      restoreTauri();
    }
  });

  it("存在目标原片时禁用所有不消费时间图的导出旁路", async () => {
    const project = useEditorStore.getState().project;
    const asset = project.assets[0];
    useEditorStore.setState({
      project: {
        ...project,
        clips: [
          {
            id: "legacy-export-clip",
            assetId: asset.id,
            name: "旧时间轴片段",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 1,
            localOffsetMs: 0,
            enabled: true
          }
        ],
        mediaLibrary: [
          createProjectMediaReference("target-export", "targetOriginal", {
            referenceKind: "localPath",
            localPath: "D:\\media\\target.mkv"
          })
        ]
      }
    });

    const user = userEvent.setup();
    render(<AssetPanel section="export" />);
    await selectMenuItem(user, "导出工具", "单文件导出与高级检查");

    expect(screen.getByText(/只可使用上方「按原片分集导出」/)).toBeInTheDocument();
    expect(
      screen.getByText(/高精度分集导出必须先在设置中选择桌面导出文件夹/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览并导出单个 XML" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /按文件名分 P 合并导出/ })).toBeDisabled();
  });

  it("高级工具展示剧集工作台状态摘要", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="12,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset],
        mediaBinding: createLocalPathMediaBinding(
          "binding-local",
          "D:\\media\\full.mkv",
          3_000_000
        ),
        cutMarkers: [
          {
            id: "cut-1",
            name: "片头差异",
            sourceAtMs: 10_000,
            targetGapMs: 45_000,
            note: ""
          }
        ]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<AssetPanel section="export" />);
    await selectMenuItem(user, "导出工具", "单文件导出与高级检查");
    await user.click(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ }));

    const workbench = screen.getByRole("region", { name: "剧集工作台" });
    expect(within(workbench).getAllByText("可运行").length).toBeGreaterThan(0);
    expect(within(workbench).getByText("导入 XML")).toBeInTheDocument();
    expect(within(workbench).getByText("绑定目标原片")).toBeInTheDocument();
    expect(within(workbench).getByText("导出分集 XML")).toBeInTheDocument();
    expect(
      within(workbench).getByText("下一步：导出分集 XML：可使用现有导出按钮生成分集 XML。")
    ).toBeInTheDocument();
  });

  it("高级工具可以把当前目标原片绑定到分集输出", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="12,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset],
        mediaBinding: createLocalPathMediaBinding(
          "binding-local",
          "D:\\media\\full.mkv",
          3_000_000
        )
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<AssetPanel section="export" />);
    await selectMenuItem(user, "导出工具", "单文件导出与高级检查");
    await user.click(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ }));

    const bindingPanel = screen.getByRole("region", { name: "逐集目标绑定" });
    expect(within(bindingPanel).getByText("当前目标：full")).toBeInTheDocument();
    await user.click(within(bindingPanel).getByRole("button", { name: "绑定当前目标" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(1)
    );
    expect(useEditorStore.getState().project.seasonEpisodeBindings[0]).toMatchObject({
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      targetBinding: {
        kind: "localFile",
        fileName: "full.mkv"
      }
    });
    expect(within(bindingPanel).getByText("已绑定")).toBeInTheDocument();

    await user.click(within(bindingPanel).getByRole("button", { name: "清除" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(0)
    );
  });

  it("高级工具可以标注弹幕来源内容段", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="12,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset],
        mediaLibrary: [
          createProjectMediaReference("source-media", "bilibiliReference", {
            name: "B 站参考 A",
            fileName: "bilibili-a.mp4"
          }),
          createProjectMediaReference("target-media", "targetOriginal", {
            name: "原片 A",
            fileName: "full-a.mp4"
          })
        ],
        danmakuSourceBindings: [
          {
            id: "source-binding",
            assetId: asset.id,
            sourceMediaId: "source-media",
            linkedAt: "2026-07-11T00:00:00.000Z",
            updatedAt: "2026-07-11T00:00:00.000Z"
          }
        ]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));

    await user.click(screen.getByText("手动补充或精修来源段"));

    const panel = screen.getByRole("region", { name: "弹幕来源内容段" });
    expect(within(panel).getByText("需处理")).toBeInTheDocument();
    expect(within(panel).getByText(/不剪切、不修改视频文件/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(panel).getByLabelText("来源段 B 站参考素材")).toHaveValue("source-media")
    );
    expect(within(panel).getByLabelText("来源段目标原片")).toHaveValue("target-media");

    await user.clear(within(panel).getByLabelText("来源段开始"));
    await user.type(within(panel).getByLabelText("来源段开始"), "02:00:00.000");
    await user.clear(within(panel).getByLabelText("来源段结束"));
    await user.type(within(panel).getByLabelText("来源段结束"), "02:24:00.000");
    await user.click(within(panel).getByRole("button", { name: "新增来源段" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1)
    );
    expect(useEditorStore.getState().project.danmakuSourceSegments[0]).toMatchObject({
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "source-media",
      targetMediaId: "target-media",
      episodeKey: "S01E01",
      sourceStartMs: 7_200_000,
      sourceEndMs: 8_640_000
    });
    expect(within(panel).getByText("已确认")).toBeInTheDocument();
    expect(within(panel).getByText("第 1 集 来源段")).toBeInTheDocument();
    expect(within(panel).getByText(/B 站参考：B 站参考 A/)).toBeInTheDocument();
    expect(within(panel).getByText(/目标原片：原片 A/)).toBeInTheDocument();

    await user.selectOptions(within(panel).getByLabelText("第 1 集 来源段 用途"), "ignored");
    await user.clear(within(panel).getByLabelText("第 1 集 来源段 名称"));
    await user.type(within(panel).getByLabelText("第 1 集 来源段 名称"), "前置无意义片段");
    await user.click(within(panel).getByRole("button", { name: "更新" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments[0]).toMatchObject({
        kind: "ignored",
        label: "前置无意义片段",
        targetMediaId: null,
        episodeKey: null
      })
    );

    await user.click(within(panel).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(0)
    );
  });

  it("不同 B 站参考素材拥有独立时间标尺和编辑泳道", async () => {
    const sourceAAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="12,1,25,16777215,0,0,u1,r1">参考 A</d></i>`,
      { assetId: "asset-source-a", fileName: "source-a.xml" }
    );
    const sourceBAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="7205,1,25,16777215,0,0,u2,r2">参考 B</d></i>`,
      { assetId: "asset-source-b", fileName: "source-b.xml" }
    );
    const timestamp = "2026-07-11T00:00:00.000Z";
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [sourceAAsset, sourceBAsset],
        mediaLibrary: [
          createProjectMediaReference("source-a", "bilibiliReference", {
            name: "B 站参考 A",
            fileName: "source-a.mp4"
          }),
          createProjectMediaReference("source-b", "bilibiliReference", {
            name: "B 站参考 B",
            fileName: "source-b.mp4"
          }),
          createProjectMediaReference("target-a", "targetOriginal", {
            name: "原片 A",
            fileName: "target-a.mp4"
          }),
          createProjectMediaReference("target-b", "targetOriginal", {
            name: "原片 B",
            fileName: "target-b.mp4"
          })
        ],
        danmakuSourceBindings: [
          {
            id: "binding-source-a",
            assetId: sourceAAsset.id,
            sourceMediaId: "source-a",
            linkedAt: timestamp,
            updatedAt: timestamp
          },
          {
            id: "binding-source-b",
            assetId: sourceBAsset.id,
            sourceMediaId: "source-b",
            linkedAt: timestamp,
            updatedAt: timestamp
          }
        ],
        danmakuSourceSegments: [
          {
            id: "segment-a-1",
            label: "参考 A 第一段",
            kind: "content",
            assetId: sourceAAsset.id,
            sourceMediaId: "source-a",
            sourceStartMs: 10_000,
            sourceEndMs: 20_000,
            targetMediaId: "target-a",
            targetStartMs: 0,
            timingRules: [],
            timeMapId: null,
            episodeKey: "S01E01",
            episodeLabel: "第 1 集",
            note: "",
            createdAt: timestamp,
            updatedAt: timestamp
          },
          {
            id: "segment-a-2",
            label: "参考 A 第二段",
            kind: "content",
            assetId: sourceAAsset.id,
            sourceMediaId: "source-a",
            sourceStartMs: 20_000,
            sourceEndMs: 40_000,
            targetMediaId: "target-b",
            targetStartMs: 0,
            timingRules: [],
            timeMapId: null,
            episodeKey: "S01E02",
            episodeLabel: "第 2 集",
            note: "",
            createdAt: timestamp,
            updatedAt: timestamp
          },
          {
            id: "segment-b-1",
            label: "参考 B 第一段",
            kind: "content",
            assetId: sourceBAsset.id,
            sourceMediaId: "source-b",
            sourceStartMs: 7_200_000,
            sourceEndMs: 7_260_000,
            targetMediaId: "target-a",
            targetStartMs: 0,
            timingRules: [],
            timeMapId: null,
            episodeKey: "S01E01",
            episodeLabel: "第 1 集",
            note: "",
            createdAt: timestamp,
            updatedAt: timestamp
          },
          {
            id: "segment-b-2",
            label: "参考 B 第二段",
            kind: "content",
            assetId: sourceBAsset.id,
            sourceMediaId: "source-b",
            sourceStartMs: 7_380_000,
            sourceEndMs: 7_500_000,
            targetMediaId: "target-b",
            targetStartMs: 0,
            timingRules: [],
            timeMapId: null,
            episodeKey: "S01E02",
            episodeLabel: "第 2 集",
            note: "",
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));
    await userEvent.click(screen.getByText("手动补充或精修来源段"));

    const sourceATimeline = screen.getByRole("region", { name: "B 站参考 A 独立时间带" });
    const sourceBTimeline = screen.getByRole("region", { name: "B 站参考 B 独立时间带" });
    expect(within(sourceATimeline).getByText("00:00:10.000")).toBeInTheDocument();
    expect(within(sourceATimeline).getByText("00:00:40.000")).toBeInTheDocument();
    expect(within(sourceBTimeline).getByText("02:00:00.000")).toBeInTheDocument();
    expect(within(sourceBTimeline).getByText("02:05:00.000")).toBeInTheDocument();

    const sourceAEditingLane = screen.getByRole("region", { name: "B 站参考 A 来源段" });
    const sourceBEditingLane = screen.getByRole("region", { name: "B 站参考 B 来源段" });
    expect(within(sourceAEditingLane).getByText("参考 A 第一段")).toBeInTheDocument();
    expect(within(sourceAEditingLane).getByText("参考 A 第二段")).toBeInTheDocument();
    expect(within(sourceAEditingLane).queryByText("参考 B 第一段")).not.toBeInTheDocument();
    expect(within(sourceBEditingLane).getByText("参考 B 第一段")).toBeInTheDocument();
    expect(within(sourceBEditingLane).getByText("参考 B 第二段")).toBeInTheDocument();
    expect(within(sourceBEditingLane).queryByText("参考 A 第一段")).not.toBeInTheDocument();
  });

  it("导出检查会展示人话摘要并按需显示诊断详情", async () => {
    const user = userEvent.setup();
    render(<AssetPanel section="export" />);

    expect(screen.getByTestId("project-health-panel")).toBeInTheDocument();
    expect(screen.getByText("导出前检查")).toBeInTheDocument();
    expect(screen.getByText("弹幕还没放到时间轴")).toBeInTheDocument();
    expect(screen.getByText("需复核")).toBeInTheDocument();
    expect(screen.queryByText("项目版本")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看诊断详情" }));
    expect(screen.getByText("项目版本")).toBeInTheDocument();
    expect(screen.getByText(`v${CURRENT_SCHEMA_VERSION}`)).toBeInTheDocument();
    expect(screen.getByText("01 - 1.1.xml（1 条弹幕）")).toBeInTheDocument();
    expect(screen.getByText("视频重连")).toBeInTheDocument();
    expect(getDiagnosticMetricText("视频重连")).toContain("不需要");
    expect(getDiagnosticMetricText("目标重连")).toContain("不需要");
  });

  it("导出检查会展示重复 ID 的具体位置", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="1,1,25,16777215,0,0,u1,r1">第一条</d>
        <d p="2,1,25,16777215,0,0,u2,r2">第二条</d>
      </i>`,
      { fileName: "duplicate.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [
          {
            ...asset,
            items: asset.items.map((item, index) =>
              index === 1 ? { ...item, id: asset.items[0].id } : item
            )
          }
        ]
      }
    });
    render(<AssetPanel section="export" />);

    expect(screen.getByText("项目内部 ID 有重复")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看诊断详情" }));
    expect(screen.getByText("重复 ID")).toBeInTheDocument();
    expect(
      screen.getByText(/资源 duplicate\.xml 的第 1 条弹幕；资源 duplicate\.xml 的第 2 条弹幕/)
    ).toBeInTheDocument();
  });

  it("导出检查会展示负最终时间风险", () => {
    const project = useEditorStore.getState().project;
    const assetId = project.assets[0].id;
    useEditorStore.setState({
      project: {
        ...project,
        globalOffsetMs: -1500,
        clips: [
          {
            id: "clip-negative",
            assetId,
            name: "负时间片段",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 3000,
            localOffsetMs: 0,
            enabled: true
          }
        ]
      }
    });
    render(<AssetPanel section="export" />);

    expect(screen.getByText("有弹幕会被挤到 0 秒")).toBeInTheDocument();
    expect(screen.getByText(/负时间片段.*-00:00:01\.500/)).toBeInTheDocument();
  });

  it("可以从导出检查下载检查报告", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(
      () => "blob:project-health-report"
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
          ...useEditorStore.getState().project,
          name: "健康/报告:项目"
        }
      });
      render(<AssetPanel section="export" />);
      await user.click(screen.getByRole("button", { name: "下载检查报告" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("检查报告下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("健康_报告_项目-health-report.txt");
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的检查报告不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain("导出前检查报告");
      await expect(readBlobText(blob)).resolves.toContain(
        `项目版本：v${CURRENT_SCHEMA_VERSION}`
      );
      await expect(readBlobText(blob)).resolves.toContain("没有时间轴片段");
      await expect(readBlobText(blob)).resolves.toContain("01 - 1.1.xml（1 条弹幕）");
      expect(useEditorStore.getState().status.message).toBe(
        "已导出检查报告：健康_报告_项目-health-report.txt。"
      );
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:project-health-report");
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

  it("可以从导出检查清理失效编辑引用", async () => {
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const validItemId = project.assets[0].items[0].id;
    useEditorStore.setState({
      project: {
        ...project,
        disabledItemIds: [validItemId, "missing-disabled"],
        itemTimeAdjustments: {
          [validItemId]: 100,
          "missing-adjustment": 200
        }
      }
    });
    render(<AssetPanel section="export" />);

    expect(screen.getByText("有失效的弹幕调整记录")).toBeInTheDocument();
    expect(screen.getByText("失效禁用：missing-disabled")).toBeInTheDocument();
    expect(
      screen.getByText("失效微调：missing-adjustment（+00:00:00.200）")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清理失效调整" }));

    expect(useEditorStore.getState().project.disabledItemIds).toEqual([validItemId]);
    expect(useEditorStore.getState().project.itemTimeAdjustments).toEqual({
      [validItemId]: 100
    });
    expect(screen.queryByText("有失效的弹幕调整记录")).not.toBeInTheDocument();
  });

  it("可以从导出检查清理缺失资源片段", async () => {
    const user = userEvent.setup();
    const project = useEditorStore.getState().project;
    const assetId = project.assets[0].id;
    useEditorStore.setState({
      project: {
        ...project,
        clips: [
          {
            id: "clip-valid",
            assetId,
            name: "有效片段",
            timelineStartMs: 0,
            sourceInMs: 0,
            sourceOutMs: 1,
            localOffsetMs: 0,
            enabled: true
          },
          {
            id: "clip-missing",
            assetId: "missing-asset",
            name: "坏片段",
            timelineStartMs: 1,
            sourceInMs: 0,
            sourceOutMs: 1,
            localOffsetMs: 0,
            enabled: true
          }
        ]
      },
      selection: { kind: "clip", ids: ["clip-missing"] }
    });
    render(<AssetPanel section="export" />);

    expect(screen.getByText("有时间轴片段找不到原来的 XML")).toBeInTheDocument();
    expect(
      screen.getByText(/坏片段（片段 ID：clip-missing，缺失资源 ID：missing-asset/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移除缺失片段" }));

    expect(useEditorStore.getState().project.clips.map((clip) => clip.id)).toEqual([
      "clip-valid"
    ]);
    expect(useEditorStore.getState().selection).toEqual({ kind: "none", ids: [] });
    expect(screen.queryByText("有时间轴片段找不到原来的 XML")).not.toBeInTheDocument();
  });

  it("可以把疑似版本差异候选转为待确认版本差异", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="10,1,25,16777215,0,0,u1,r1">这里是不是删了</d>
        <d p="20,1,25,16777215,0,0,u2,r2">刚才怎么跳了</d>
        <d p="25,1,25,16777215,0,0,u3,r3">少了一段吧</d>
      </i>`,
      { fileName: "第一季1-2.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));
    expect(screen.getByText("疑似版本差异")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "转为版本差异" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    const marker = useEditorStore.getState().project.cutMarkers[0];
    expect(marker.name).toContain("待确认版本差异");
    expect(marker.sourceAtMs).toBe(20_000);
    expect(marker.note).toContain("第一季1-2.xml");
  });

  it("可以配置疑似版本差异扫描关键词", async () => {
    const user = userEvent.setup();
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i>
        <d p="10,1,25,16777215,0,0,u1,r1">广告时间没了</d>
        <d p="20,1,25,16777215,0,0,u2,r2">广告被处理了吗</d>
      </i>`,
      { fileName: "custom.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS }
    });

    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));
    expect(screen.getByText("暂无候选")).toBeInTheDocument();
    await user.type(screen.getByLabelText("疑似版本差异关键词"), "广告");
    expect(useEditorStore.getState().cutHintSettings.keywordsText).toBe("广告");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "转为版本差异" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "转为版本差异" }));

    await waitFor(() => expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1));
    expect(useEditorStore.getState().project.cutMarkers[0].note).toContain("广告");
  });

  it("匹配页退役旧单对单路径实验室，仅保留手工 JSON 只读诊断", async () => {
    const user = userEvent.setup();
    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));

    expect(screen.queryByTestId("legacy-alignment-diagnostics")).not.toBeInTheDocument();
    expect(screen.queryByText("视频对齐实验室")).not.toBeInTheDocument();

    const diagnostics = screen.getByTestId("manual-alignment-diagnostics");
    expect(diagnostics).toHaveAttribute("open");

    expect(within(diagnostics).getByText(/不会选择视频、不会运行自动匹配/)).toBeInTheDocument();
    expect(within(diagnostics).queryByLabelText("完整版输入")).not.toBeInTheDocument();
    expect(within(diagnostics).queryByLabelText("B 站删减版输入")).not.toBeInTheDocument();
    expect(within(diagnostics).queryByLabelText("FFmpeg 路径")).not.toBeInTheDocument();
    expect(
      within(diagnostics).queryByRole("button", { name: "运行本地对齐" })
    ).not.toBeInTheDocument();

    const proposalText = JSON.stringify({
      anchors: [],
      cutCandidates: [],
      confidence: 0.5,
      diagnostics: ["外部诊断样例"]
    });
    fireEvent.change(within(diagnostics).getByLabelText("对齐提案 JSON"), {
      target: { value: proposalText }
    });
    await user.click(within(diagnostics).getByRole("button", { name: "解析为只读诊断" }));

    await waitFor(() =>
      expect(useEditorStore.getState().alignmentProposal?.diagnostics).toEqual(["外部诊断样例"])
    );
    expect(within(diagnostics).getByText("外部诊断样例")).toBeInTheDocument();
    expect(
      within(diagnostics).queryByRole("button", { name: "应用候选" })
    ).not.toBeInTheDocument();
  });

  it("导出多分集时使用项目名生成 ZIP 文件名", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(
      () => "blob:batch-merge-archive"
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
    const firstAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u1,r1">第一集</d></i>`,
      { fileName: "S01E01.xml" }
    );
    const secondAsset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u2,r2">第二集</d></i>`,
      { fileName: "S01E02.xml" }
    );

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "合集/导出:项目",
          assets: [firstAsset, secondAsset]
        },
        history: createHistoryState(),
        selection: { kind: "none", ids: [] }
      });

      render(<AssetPanel section="export" />);
      await selectMenuItem(user, "导出工具", "单文件导出与高级检查");
      await user.click(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ }));
      await user.click(screen.getByRole("button", { name: "导出分集 XML" }));

      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("分集 ZIP 下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("合集_导出_项目-danmaku-exports.zip");
      expect(useEditorStore.getState().status.message).toContain(
        "合集_导出_项目-danmaku-exports.zip"
      );
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:batch-merge-archive");
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

  it("导出单个分集时状态显示实际 XML 文件名", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(
      () => "blob:single-batch-merge"
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
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u1,r1">单集</d></i>`,
      { fileName: "01 - 1.1.xml" }
    );

    try {
      useEditorStore.setState({
        project: {
          ...createEmptyProject(),
          name: "单集/导出:项目",
          assets: [asset]
        },
        history: createHistoryState(),
        selection: { kind: "none", ids: [] }
      });

      render(<AssetPanel section="export" />);
      await selectMenuItem(user, "导出工具", "单文件导出与高级检查");
      await user.click(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ }));
      await user.click(screen.getByRole("button", { name: "导出分集 XML" }));

      await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("单分集 XML 下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("1 - 1.xml");
      expect(useEditorStore.getState().status.message).toBe(
        "已触发下载 1 个分集 XML：1 - 1.xml。"
      );
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:single-batch-merge");
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

  it("可以在版本差异列表定位、微调并删除版本差异", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        cutMarkers: [
          {
            id: "cut-manual",
            name: "手动版本差异",
            sourceAtMs: 3000,
            targetGapMs: 45000,
            note: "人工确认"
          }
        ]
      },
      selection: { kind: "none", ids: [] }
    });

    render(<AssetPanel section="editing" />);
    await user.click(screen.getByRole("button", { name: "定位版本差异 手动版本差异" }));
    expect(useEditorStore.getState().selection).toEqual({ kind: "cut", ids: ["cut-manual"] });
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(3000);

    fireEvent.change(screen.getByLabelText("手动版本差异 相差 ms"), {
      target: { value: "12000" }
    });
    expect(useEditorStore.getState().project.cutMarkers[0].targetGapMs).toBe(12000);

    await user.click(screen.getByRole("button", { name: "删除版本差异 手动版本差异" }));
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(0);
  });

  it("可以在同步锚点管理面板定位、微调并删除锚点", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: {
        ...useEditorStore.getState().project,
        syncAnchors: [
          {
            id: "anchor-manual",
            sourceMs: 4000,
            targetMs: 9000,
            confidence: 1,
            origin: "manual"
          }
        ]
      }
    });

    render(<AssetPanel section="editing" />);
    await user.click(screen.getByRole("button", { name: "定位同步锚点 1" }));
    expect(useEditorStore.getState().project.timeline.playheadMs).toBe(4000);

    fireEvent.change(screen.getByLabelText("同步锚点 1 完整版时间 ms"), {
      target: { value: "12000" }
    });
    expect(useEditorStore.getState().project.syncAnchors[0].targetMs).toBe(12000);

    await user.click(screen.getByRole("button", { name: "删除同步锚点 1" }));
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
  });

  it("可以应用锚点校准推断出的版本差异", async () => {
    const user = userEvent.setup();
    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));

    await user.type(
      screen.getByPlaceholderText(/每行一个对应点/),
      "00:10 -> 00:10\n00:20 -> 00:30"
    );
    await user.click(screen.getByRole("button", { name: "应用线索与差异" }));

    await waitFor(() => expect(useEditorStore.getState().project.syncAnchors).toHaveLength(2));
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 20_000,
      targetGapMs: 10_000
    });
  });

  it("可以把锚点校准提案发送到时间轴预览", async () => {
    const user = userEvent.setup();
    render(<ManualAlignmentWorkspace />);
    await userEvent.click(screen.getByText("手工提案、同步锚点与版本差异"));

    await user.type(
      screen.getByPlaceholderText(/每行一个对应点/),
      "00:10 -> 00:10\n00:20 -> 00:30"
    );
    await user.click(screen.getByRole("button", { name: "预览到时间轴" }));

    await waitFor(() =>
      expect(useEditorStore.getState().alignmentProposal?.cutCandidates).toHaveLength(1)
    );
    expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(2);
    expect(useEditorStore.getState().status.message).toContain("时间轴预览");
  });
});

function createTimedXml(count: number, intervalSeconds: number): string {
  const lines = Array.from(
    { length: count },
    (_, index) =>
      `<d p="${index * intervalSeconds},1,25,16777215,0,0,u${index},r${index}">测试 ${index + 1}</d>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?><i>${lines.join("")}</i>`;
}

function createProjectMediaReference(
  id: string,
  role: ProjectMediaRole,
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  const fileName =
    overrides.fileName ?? (role === "bilibiliReference" ? "reference.mp4" : "target.mp4");
  return {
    id,
    role,
    name: overrides.name ?? (role === "bilibiliReference" ? "B 站参考素材" : "目标原片"),
    fileName,
    objectUrl: "objectUrl" in overrides ? (overrides.objectUrl ?? null) : `blob:${fileName}`,
    durationMs: "durationMs" in overrides ? (overrides.durationMs ?? null) : 10_000_000,
    contentIdentity: overrides.contentIdentity ?? null,
    referenceKind: overrides.referenceKind ?? "browserFile",
    connectionState: overrides.connectionState ?? "connected",
    sourceSummary: overrides.sourceSummary ?? "测试媒体",
    localPath: overrides.localPath ?? null,
    emby: overrides.emby ?? null,
    episodeKey: overrides.episodeKey ?? null,
    episodeLabel: overrides.episodeLabel ?? null,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" },
    createdAt: overrides.createdAt ?? "2026-07-11T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-11T00:00:00.000Z"
  };
}

function createTestXmlSourceReceipt() {
  return {
    domain: "danmaku-xml-content-receipt-v1" as const,
    version: 1 as const,
    receiptId: `xmlr-sha256:${"1".repeat(64)}`,
    contentDigest: `sha256:${"2".repeat(64)}`,
    sizeBytes: 128,
    parserVersion: "bilibili-xml-native-v1" as const,
    inventoryDigest: `sha256:${"3".repeat(64)}`,
    issuerKeyId: `install-sha256:${"4".repeat(32)}`,
    signatureAlgorithm: "hmac-sha256-v1" as const,
    signature: "5".repeat(64)
  };
}

function getTargetMediaBindingPanel(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "目标原片（完整版）" });
  const panel = heading.closest("section");
  if (!(panel instanceof HTMLElement)) {
    throw new Error("未找到目标原片面板。");
  }
  return panel;
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

async function expandLegacyMaterialsPanel(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await selectMenuItem(user, "素材工具", "单目标绑定与素材说明");
}

function getDiagnosticMetricText(label: string): string {
  const labelElement = screen.getByText(label);
  const metric = labelElement.closest("div");
  if (!(metric instanceof HTMLElement)) {
    throw new Error(`未找到诊断项：${label}`);
  }
  return metric.textContent ?? "";
}

function readBlobText(blob: Blob): Promise<string> {
  const modernBlob = blob as Blob & { text?: () => Promise<string> };
  if (typeof modernBlob.text === "function") {
    return modernBlob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      if (reader.result instanceof ArrayBuffer) {
        resolve(new TextDecoder().decode(reader.result));
        return;
      }
      resolve("");
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsText(blob);
  });
}

async function selectMenuItem(
  user: ReturnType<typeof userEvent.setup>,
  menu: string,
  item: string
): Promise<void> {
  await user.click(screen.getByRole("button", { name: menu }));
  await user.click(screen.getByRole("menuitem", { name: item }));
}
