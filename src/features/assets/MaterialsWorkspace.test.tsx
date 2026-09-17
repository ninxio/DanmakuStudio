import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { createDanmakuSourceBinding } from "../../domain/project/mediaLibrary";
import type { ProjectMediaReference, ProjectMediaRole } from "../../domain/project/types";
import type {
  MediaInventoryGenerationKey,
  MediaInventoryPublication
} from "../../application/mediaInventorySupervisor";
import { pickMediaPaths } from "../../infrastructure/file-system/nativeDialogs";
import {
  clearAppSettings,
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import {
  clearVolatileEmbyCredentials,
  saveVolatileEmbyPassword
} from "../../infrastructure/settings/volatileEmbyCredentials";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { MaterialsWorkspace } from "./MaterialsWorkspace";

const embyMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  search: vi.fn(),
  playbackInfo: vi.fn(),
  createStreamUrl: vi.fn(),
  createDirectStreamUrl: vi.fn(),
  estimateSourceBytes: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  listenProgress: vi.fn(),
  probe: vi.fn()
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

vi.mock("../../infrastructure/metadata/embyClient", () => ({
  authenticateEmby: embyMocks.authenticate,
  searchEmbyItems: embyMocks.search,
  fetchEmbyPlaybackInfo: embyMocks.playbackInfo,
  createEmbyAudioStreamUrl: embyMocks.createStreamUrl,
  createEmbyDirectVideoStreamUrl: embyMocks.createDirectStreamUrl,
  estimateEmbySourceBytes: embyMocks.estimateSourceBytes
}));

vi.mock("../../infrastructure/metadata/embyAudioDownload", () => ({
  cancelEmbyAudioDownload: embyMocks.cancel,
  downloadEmbyAudio: embyMocks.download,
  listenToEmbyAudioDownloadProgress: embyMocks.listenProgress
}));

vi.mock("../../infrastructure/media/tauriMediaProbe", () => ({
  probeTauriMediaTimeline: embyMocks.probe
}));

describe("MaterialsWorkspace", () => {
  beforeEach(() => {
    clearAppSettings();
    clearVolatileEmbyCredentials();
    vi.mocked(pickMediaPaths).mockReset();
    for (const mock of Object.values(embyMocks)) {
      mock.mockReset();
    }
    setProject(createEmptyProject());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("从公开工作台把浏览器与桌面媒体入口映射到各自导入编排", async () => {
    const browserView = render(<MaterialsWorkspace />);
    const targetInput = screen.getByLabelText("导入原片素材文件");
    const inputClick = vi.spyOn(targetInput, "click");

    chooseMaterialImport("批量导入原片素材");
    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(pickMediaPaths).not.toHaveBeenCalled();
    browserView.unmount();

    const restoreTauri = enableTauriForTest();
    vi.mocked(pickMediaPaths).mockResolvedValue(["D:\\media\\S01E01.mkv"]);
    try {
      render(<MaterialsWorkspace />);
      chooseMaterialImport("批量导入原片素材");

      await waitFor(() => expect(pickMediaPaths).toHaveBeenCalledWith("targetOriginal"));
      await waitFor(() =>
        expect(useEditorStore.getState().project.mediaLibrary).toEqual([
          expect.objectContaining({
            role: "targetOriginal",
            fileName: "S01E01.mkv",
            localPath: "D:\\media\\S01E01.mkv"
          })
        ])
      );
    } finally {
      restoreTauri();
    }
  });

  it("空项目首屏集中三类批量导入、异常建议区与明确下一步", () => {
    render(<MaterialsWorkspace />);

    const intake = screen.getByRole("region", { name: "素材工作台" });
    expect(within(intake).getByRole("tablist", { name: "素材分类" })).toBeVisible();
    expect(within(intake).getByTestId("materials-primary-action")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(within(intake).getByRole("button", { name: "添加素材" }));
    const menu = screen.getByRole("menu", { name: "添加素材" });
    for (const label of ["批量导入原片素材", "批量导入 B 站参考素材", "导入 XML"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeVisible();
    }
  });

  it("空项目导向 XML 文件选择，已有 XML 则自动排列并进入编辑", async () => {
    const user = userEvent.setup();
    const emptyView = render(<MaterialsWorkspace />);
    const xmlInput = screen.getByLabelText("导入弹幕 XML 文件");
    const inputClick = vi.spyOn(xmlInput, "click");

    chooseMaterialImport("导入 XML");
    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().workspacePage).toBe("materials");
    emptyView.unmount();

    const asset = createXmlAsset();
    setProject({
      ...createEmptyProject(),
      assets: [asset]
    });
    render(<MaterialsWorkspace />);
    await user.click(screen.getByRole("button", { name: "开始编辑弹幕" }));

    await waitFor(() =>
      expect(useEditorStore.getState().project.clips).toEqual([
        expect.objectContaining({ assetId: asset.id })
      ])
    );
    expect(useEditorStore.getState().workspacePage).toBe("editing");
  });

  it("首次编辑保留 XML 时间零点，不把第一条弹幕提前", async () => {
    const asset = createXmlAsset();
    setProject({ ...createEmptyProject(), assets: [asset] });
    render(<MaterialsWorkspace />);
    await userEvent.setup().click(screen.getByRole("button", { name: "开始编辑弹幕" }));
    const [clip] = useEditorStore.getState().project.clips;
    expect(clip.sourceInMs).toBe(0);
    expect(clip.timelineStartMs).toBe(0);
    expect(asset.items[0].sourceTimeMs).toBe(1000);
  });

  it("继续编辑一次追加新 XML，保留既有拆分与偏移且可一次撤销", async () => {
    const first = createXmlAsset("first");
    const second = createXmlAsset("second", "second.xml");
    const clip = {
      id: "edited",
      assetId: first.id,
      name: first.name,
      timelineStartMs: 5000,
      sourceInMs: 400,
      sourceOutMs: 1001,
      localOffsetMs: 200,
      enabled: false
    };
    setProject({ ...createEmptyProject(), assets: [first, second], clips: [clip] });
    render(<MaterialsWorkspace />);
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "加入 1 个 XML 并编辑" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "加入 1 个 XML 并编辑" }));
    expect(useEditorStore.getState().project.clips).toHaveLength(2);
    expect(useEditorStore.getState().project.clips[0]).toEqual(clip);
    expect(useEditorStore.getState().project.clips[1]).toMatchObject({
      assetId: second.id,
      sourceInMs: 0,
      timelineStartMs: 5801
    });
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "继续编辑当前时间线" }));
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState().project.clips).toEqual([clip]);
  });

  it("重新连接文件时保留请求中的媒体身份", async () => {
    const createObjectUrl = vi.fn(() => "blob:reconnected.mp4");
    const restoreObjectUrl = replaceObjectUrlFactory(createObjectUrl);
    const media = createProjectMediaReference("target-stable", "targetOriginal", {
      objectUrl: null,
      referenceKind: "browserFile",
      connectionState: "needsReconnect"
    });
    setProject({
      ...createEmptyProject(),
      mediaLibrary: [media]
    });

    try {
      render(<MaterialsWorkspace />);
      fireEvent.click(screen.getByRole("tab", { name: /^原片/ }));
      fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
      fireEvent.change(screen.getByLabelText("重新连接媒体素材文件"), {
        target: {
          files: [new File(["video"], "reconnected.mp4", { type: "video/mp4" })]
        }
      });

      await waitFor(() =>
        expect(useEditorStore.getState().project.mediaLibrary[0]).toMatchObject({
          id: "target-stable",
          fileName: "reconnected.mp4",
          objectUrl: "blob:reconnected.mp4",
          connectionState: "connected"
        })
      );
      expect(createObjectUrl).toHaveBeenCalledTimes(1);
    } finally {
      restoreObjectUrl();
    }
  });

  it("自动展示五集关系建议，键盘一次应用，并把歧义留给既有逐项选择", async () => {
    const project = createEmptyProject();
    project.assets = [1, 2, 3, 4, 5, 6].map((episode) =>
      createXmlAsset(
        `batch-asset-${episode}`,
        `${episode} - S01E${episode.toString().padStart(2, "0")}.xml`
      )
    );
    project.mediaLibrary = [
      ...[1, 2, 3, 4, 5].map((episode) =>
        createProjectMediaReference(`batch-reference-${episode}`, "bilibiliReference", {
          name: `Reference S01E${episode.toString().padStart(2, "0")}`,
          fileName: `Reference.S01E${episode.toString().padStart(2, "0")}.mp4`
        })
      ),
      createProjectMediaReference("batch-reference-6a", "bilibiliReference", {
        name: "Reference S01E06 A",
        fileName: "Reference.S01E06.A.mp4"
      }),
      createProjectMediaReference("batch-reference-6b", "bilibiliReference", {
        name: "Reference S01E06 B",
        fileName: "Reference.S01E06.B.mp4"
      }),
      ...[1, 2, 3, 4, 5, 6].map((episode) =>
        createProjectMediaReference(`batch-target-${episode}`, "targetOriginal", {
          name: `Original S01E${episode.toString().padStart(2, "0")}`,
          fileName: `Original.S01E${episode.toString().padStart(2, "0")}.mkv`
        })
      )
    ];
    setProject(project);
    const user = userEvent.setup();
    render(<MaterialsWorkspace />);

    await user.click(screen.getByRole("tab", { name: /^待处理/ }));
    expect(screen.getByRole("heading", { name: "批量关系建议" })).toBeInTheDocument();
    expect(screen.getByText(/有 2 个 B 站参考素材都与第 1 季第 6 集一致/)).toBeInTheDocument();
    const applyButton = screen.getByRole("button", { name: "一次应用 5 条建议" });
    applyButton.focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(5)
    );
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    await user.click(screen.getByRole("tab", { name: /^弹幕 XML/ }));
    expect(screen.getByLabelText("1 - S01E01.xml 弹幕来源素材")).toHaveValue(
      "batch-reference-1"
    );
    await user.click(screen.getByRole("tab", { name: /^待处理/ }));
    expect(screen.getByText("已保留 5")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^弹幕 XML/ }));

    await user.type(screen.getByRole("searchbox", { name: "查找弹幕素材" }), "S01E01");
    expect(screen.queryByLabelText("6 - S01E06.xml 弹幕来源素材")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^待处理/ }));
    await user.click(screen.getByRole("button", { name: "处理 6 - S01E06.xml" }));
    expect(screen.getByRole("searchbox", { name: "查找弹幕素材" })).toHaveValue("");
    const ambiguousSelect = screen.getByLabelText("6 - S01E06.xml 弹幕来源素材");
    expect(ambiguousSelect).toHaveFocus();
    await user.selectOptions(ambiguousSelect, "batch-reference-6a");

    await waitFor(() =>
      expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(6)
    );
    expect(ambiguousSelect).toHaveValue("batch-reference-6a");
  });

  it("Emby 弹窗在动态零焦点状态仍封闭双向键盘导航并在关闭后回焦", async () => {
    let rejectDownload!: (reason?: unknown) => void;
    let resolveCancel!: (accepted: boolean) => void;
    const download = new Promise<never>((_resolve, reject) => {
      rejectDownload = reject;
    });
    const cancel = new Promise<boolean>((resolve) => {
      resolveCancel = resolve;
    });
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      emby: {
        serverUrl: "https://emby.example.test",
        pathPrefix: "/emby",
        username: "tester"
      }
    });
    saveVolatileEmbyPassword("session-password");
    embyMocks.authenticate.mockResolvedValue({
      userId: "user-1",
      userName: "tester",
      accessToken: "access-token"
    });
    embyMocks.search.mockResolvedValue([
      {
        id: "movie-1",
        name: "Midsommar",
        type: "Movie",
        seriesName: null,
        seasonNumber: null,
        episodeNumber: null,
        durationMs: 8_880_000,
        mediaSources: []
      }
    ]);
    embyMocks.playbackInfo.mockResolvedValue({
      playSessionId: "play-session-1",
      mediaSources: [
        {
          id: "source-1",
          name: "Main audio",
          container: "mkv",
          runtimeMs: 8_880_000,
          sizeBytes: 1_024,
          bitrate: 1_000_000,
          supportsDirectPlay: true,
          supportsDirectStream: true,
          supportsTranscoding: true,
          defaultAudioStreamIndex: 0,
          audioStreams: [
            {
              index: 0,
              codec: "flac",
              language: "eng",
              title: null,
              displayTitle: "English FLAC",
              channels: 2,
              sampleRate: 48_000,
              bitrate: null,
              default: true,
              commentary: false
            }
          ]
        }
      ]
    });
    embyMocks.createStreamUrl.mockReturnValue(
      "https://emby.example.test/emby/Audio/movie-1/stream.flac"
    );
    embyMocks.createDirectStreamUrl.mockReturnValue(
      "https://emby.example.test/emby/Videos/movie-1/stream?Static=true"
    );
    embyMocks.estimateSourceBytes.mockReturnValue(1_024);
    embyMocks.listenProgress.mockResolvedValue(() => undefined);
    embyMocks.download.mockReturnValue(download);
    embyMocks.cancel.mockReturnValue(cancel);

    const user = userEvent.setup();
    render(<MaterialsWorkspace />);

    const embyTrigger = screen.getByRole("button", { name: "添加素材" });
    await user.click(embyTrigger);
    await user.click(screen.getByRole("menuitem", { name: "从 Emby 导入原片音频" }));
    const dialog = screen.getByRole("dialog", { name: "从 Emby 获取原片音频" });

    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await screen.findByText(/已连接 tester/);
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.type(screen.getByLabelText("搜索 Emby 电影或剧集"), "Midsommar");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await user.click(await screen.findByRole("button", { name: /Midsommar/ }));
    await user.click(screen.getByRole("button", { name: "获取并导入原片音频" }));
    const cancelButton = await screen.findByRole("button", { name: "取消并清理" });
    await user.click(cancelButton);

    const cancellingButton = await screen.findByRole("button", { name: "正在取消并清理…" });
    expect(cancellingButton).toBeDisabled();
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);

    await user.tab();
    expect(document.activeElement).toBe(dialog);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(dialog);

    resolveCancel(false);
    await waitFor(() => expect(cancelButton).toBeEnabled());
    await user.tab();
    expect(cancelButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancelButton).toHaveFocus();

    rejectDownload(new Error("测试结束下载"));
    await screen.findByText("测试结束下载");

    await user.click(screen.getByRole("button", { name: "关闭 Emby 音频导入" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "从 Emby 获取原片音频" })
      ).not.toBeInTheDocument()
    );
    await waitFor(() => expect(embyTrigger).toHaveFocus());
  });

  it("24 个自动成功媒体保持折叠态零新增 Tab stop，文件详情内展示全部音轨且刷新不重置焦点", async () => {
    const { project, target } = createAudioPreparationProject();
    const targets = [
      target,
      ...Array.from({ length: 23 }, (_, index) =>
        createProjectMediaReference(`target-local-${index + 2}`, "targetOriginal", {
          fileName: `Original.S01E${String(index + 2).padStart(2, "0")}.mkv`,
          objectUrl: null,
          referenceKind: "localPath",
          connectionState: "connected",
          localPath: `D:\\media\\Original.S01E${String(index + 2).padStart(2, "0")}.mkv`
        })
      )
    ];
    const reference = project.mediaLibrary.find((media) => media.role === "bilibiliReference");
    if (!reference) throw new Error("测试项目缺少参考素材");
    project.mediaLibrary = [...targets, reference];
    setProject(project);
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    const readyRows = [
      ...targets.map((media) =>
        readyAudioRow(media.id, "recommended", "inventory-v1:aaaaaaaaaaaaaaaa")
      ),
      readyAudioRow(reference.id, "recommended", "inventory-v1:aaaaaaaaaaaaaaaa")
    ];
    useEditorStore
      .getState()
      .applyMediaInventoryPublication(
        audioPublication(generationKey, readyRows, readyRows.length)
      );
    const user = userEvent.setup();
    render(<MaterialsWorkspace />);

    expect(screen.queryByLabelText(`${target.fileName} 素材详情`)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^原片/ }));
    const targetSection = screen.getByTestId("targetOriginal-dropzone");
    expect(within(targetSection).getAllByRole("button", { name: /文件详情$/ })).toHaveLength(
      24
    );
    expect(within(targetSection).queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `${target.fileName} 文件详情` }));
    const card = screen.getByRole("dialog", { name: "素材详情与音轨" });
    const cardUi = within(card);
    expect(cardUi.getByText("自动推荐音轨 #2")).toBeInTheDocument();
    const detailsSummary = cardUi.getByText("文件详情");
    expect(detailsSummary.closest("details")).not.toHaveAttribute("open");
    await user.click(detailsSummary);
    const select = cardUi.getByRole("combobox", { name: `${target.fileName} 音轨选择` });
    expect((select.closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("#1"),
        expect.stringContaining("#2"),
        expect.stringContaining("评论音轨")
      ])
    );
    const deleteButton = cardUi.getByRole("button", { name: "删除" });
    expect(detailsSummary.compareDocumentPosition(select)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(select.compareDocumentPosition(deleteButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    select.focus();
    expect(select).toHaveFocus();

    act(() => {
      useEditorStore
        .getState()
        .applyMediaInventoryPublication(
          audioPublication(generationKey, [
            readyAudioRow(target.id, "recommended", "inventory-v1:aaaaaaaaaaaaaaaa")
          ])
        );
    });
    expect(select).toHaveFocus();
  });

  it("歧义只选择一次并持久化，revision 变化要求复核；blocker 可聚焦且清理不确定时要求重启", async () => {
    const { project, target } = createAudioPreparationProject();
    setProject(project);
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    useEditorStore
      .getState()
      .applyMediaInventoryPublication(
        audioPublication(generationKey, [
          readyAudioRow(target.id, "needsChoice", "inventory-v1:aaaaaaaaaaaaaaaa"),
          readyAudioRow("reference-local", "recommended", "inventory-v1:aaaaaaaaaaaaaaaa")
        ])
      );
    const user = userEvent.setup();
    render(<MaterialsWorkspace />);

    await user.click(screen.getByRole("tab", { name: /^待处理/ }));
    const issues = screen.getByRole("region", { name: "音轨与文件问题" });
    expect(issues).toHaveTextContent(target.fileName);
    await user.click(within(issues).getByRole("button", { name: `处理 ${target.fileName}` }));
    await screen.findByRole("dialog", { name: "素材详情与音轨" });
    expect(useEditorStore.getState().workspaceIntentRequest).toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭素材详情与音轨" }));
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      act(() =>
        useEditorStore.getState().requestWorkspaceIntent({
          page: "materials",
          target: { kind: "audioIssue", mediaId: target.id }
        })
      );
      const reopened = await screen.findByRole("dialog", { name: "素材详情与音轨" });
      expect(reopened).toContainElement(document.activeElement as HTMLElement);
      expect(useEditorStore.getState().workspaceIntentSequence).toBe(sequence);
      expect(useEditorStore.getState().workspaceIntentRequest).toBeNull();
      if (sequence === 1)
        await user.click(screen.getByRole("button", { name: "关闭素材详情与音轨" }));
    }
    const cardUi = within(screen.getByRole("dialog", { name: "素材详情与音轨" }));
    await user.click(cardUi.getByText("文件详情"));
    const select = cardUi.getByRole("combobox", { name: `${target.fileName} 音轨选择` });
    await user.selectOptions(select, "explicit:2");

    expect(useEditorStore.getState().project.mediaLibrary[0].audioTrackIntent).toEqual({
      mode: "explicit",
      streamIndex: 2,
      inventoryRevision: "inventory-v1:aaaaaaaaaaaaaaaa"
    });
    expect(useEditorStore.getState().history.past).toHaveLength(1);

    select.focus();
    act(() => {
      useEditorStore
        .getState()
        .applyMediaInventoryPublication(
          audioPublication(generationKey, [
            readyAudioRow(target.id, "recommended", "inventory-v1:bbbbbbbbbbbbbbbb")
          ])
        );
    });
    expect(cardUi.getByText("需要复核音轨")).toBeInTheDocument();
    expect(select).toHaveFocus();

    act(() => useEditorStore.getState().refreshMediaInventory());
    const refreshedKey = useEditorStore.getState().mediaInventoryGenerationKey!;
    act(() => {
      useEditorStore
        .getState()
        .applyMediaInventoryPublication(
          queuedAudioPublication(refreshedKey, [target.id, "reference-local"])
        );
    });
    await user.click(screen.getByRole("button", { name: "关闭素材详情与音轨" }));
    const cancelButton = screen.getByRole("button", { name: "停止准备" });
    cancelButton.focus();
    await user.keyboard("{Enter}");
    expect(useEditorStore.getState().mediaInventoryPaused).toBe(true);
    expect(useEditorStore.getState().mediaInventoryCancelling).toBe(true);
    expect(useEditorStore.getState().mediaInventoryPhase).toBe("running");
    expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();

    act(() => {
      useEditorStore.getState().applyMediaInventoryPublication({
        generationKey: refreshedKey,
        phase: "failed",
        counts: { total: 2, queued: 0, probing: 0, ready: 0, failed: 2, cancelled: 0 },
        changedRows: [target.id, "reference-local"].map((mediaId) => ({
          mediaId,
          status: "failed" as const,
          error: {
            code: "processCleanupUncertain",
            message: "媒体清单进程清理状态不确定，需重启应用。"
          }
        })),
        terminalMessage: "媒体清单进程清理状态不确定，需重启应用。",
        restartRequired: true
      });
    });
    expect(useEditorStore.getState().mediaInventoryCancelling).toBe(false);
    expect(useEditorStore.getState().mediaInventoryPhase).toBe("failed");
    expect(screen.getByRole("button", { name: "重启应用后继续" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "重新准备音轨" })).not.toBeInTheDocument();
  });

  it("session cleanup 不确定时即使全部音轨 ready 也要求重启，refresh 不能伪装恢复", () => {
    const { project, target } = createAudioPreparationProject();
    setProject(project);
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    useEditorStore
      .getState()
      .applyMediaInventoryPublication(
        audioPublication(generationKey, [
          readyAudioRow(target.id, "recommended", "inventory-v1:aaaaaaaaaaaaaaaa"),
          readyAudioRow("reference-local", "recommended", "inventory-v1:aaaaaaaaaaaaaaaa")
        ])
      );
    useEditorStore.getState().applyMediaInventoryPublication({
      generationKey,
      phase: "failed",
      counts: { total: 2, queued: 0, probing: 0, ready: 2, failed: 0, cancelled: 0 },
      changedRows: [],
      terminalMessage: "媒体清单进程清理状态不确定，需重启应用。",
      restartRequired: true
    });

    render(<MaterialsWorkspace />);

    expect(
      within(screen.getByTestId("materials-summary")).getByRole("alert")
    ).toHaveTextContent("媒体清单进程清理状态不确定，需重启应用。");
    expect(screen.queryByText("对齐素材已经准备好")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入智能匹配" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重启应用后继续" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /刷新|重新准备音轨/ })).not.toBeInTheDocument();

    act(() => useEditorStore.getState().refreshMediaInventory());

    expect(useEditorStore.getState().mediaInventoryRestartRequired).toBe(true);
    expect(screen.getByRole("button", { name: "重启应用后继续" })).toBeDisabled();
  });

  it("session cleanup 不确定时统一覆盖 ready 与 cancelled 行文案并移除音轨选择", () => {
    const { project, target } = createAudioPreparationProject();
    setProject(project);
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    const restartMessage = "媒体清单进程清理状态不确定，需重启应用。";
    useEditorStore.getState().applyMediaInventoryPublication({
      generationKey,
      phase: "failed",
      counts: { total: 2, queued: 0, probing: 0, ready: 1, failed: 0, cancelled: 1 },
      changedRows: [
        readyAudioRow(target.id, "recommended", "inventory-v1:aaaaaaaaaaaaaaaa"),
        { mediaId: "reference-local", status: "cancelled" }
      ],
      terminalMessage: restartMessage,
      restartRequired: true
    });

    render(<MaterialsWorkspace />);

    for (const [fileName, tab] of [
      [target.fileName, /^原片/],
      ["Reference.S01E01.mkv", /^参考/]
    ] as const) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      fireEvent.click(screen.getByRole("button", { name: `${fileName} 文件详情` }));
      const details = within(screen.getByRole("dialog", { name: "素材详情与音轨" }));
      expect(details.getByText("需重启应用")).toBeInTheDocument();
      expect(details.getByText(/重启后继续/)).toBeInTheDocument();
      expect(details.queryByRole("combobox")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "关闭素材详情与音轨" }));
    }
    expect(screen.queryByText(/可直接匹配/)).not.toBeInTheDocument();
    expect(screen.queryByText("可从素材摘要重新准备")).not.toBeInTheDocument();
  });
});

function setProject(project: ReturnType<typeof createEmptyProject>): void {
  useEditorStore.setState({
    project,
    history: createHistoryState(),
    selection: { kind: "none", ids: [] },
    importProgress: null,
    workspacePage: "materials",
    projectEpoch: 0,
    mediaInventoryGeneration: 0,
    mediaInventoryGenerationKey: null,
    mediaInventoryPhase: "idle",
    mediaInventoryCounts: null,
    mediaInventoryRows: {},
    mediaInventoryPaused: false,
    mediaInventoryCancelling: false,
    mediaInventoryRestartRequired: false,
    mediaInventoryTerminalMessage: null,
    workspaceIntentSequence: 0,
    workspaceIntentRequest: null
  });
}

function createXmlAsset(assetId = "workspace-asset", fileName = "01 - 1.1.xml") {
  return parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,0,0,u,r">测试</d></i>`,
    { assetId, fileName }
  );
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
    createdAt: overrides.createdAt ?? "2026-08-10T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-10T00:00:00.000Z"
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

function replaceObjectUrlFactory(factory: typeof URL.createObjectURL): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: factory
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(URL, "createObjectURL", descriptor);
      return;
    }
    Reflect.deleteProperty(URL, "createObjectURL");
  };
}

function createAudioPreparationProject() {
  const asset = createXmlAsset("audio-asset", "S01E01.xml");
  const target = createProjectMediaReference("target-local", "targetOriginal", {
    fileName: "Original.S01E01.mkv",
    objectUrl: null,
    referenceKind: "localPath",
    connectionState: "connected",
    localPath: "D:\\media\\Original.S01E01.mkv"
  });
  const reference = createProjectMediaReference("reference-local", "bilibiliReference", {
    fileName: "Reference.S01E01.mkv",
    objectUrl: null,
    referenceKind: "localPath",
    connectionState: "connected",
    localPath: "D:\\media\\Reference.S01E01.mkv"
  });
  const project = {
    ...createEmptyProject("音轨准备项目"),
    assets: [asset],
    mediaLibrary: [target, reference],
    danmakuSourceBindings: [createDanmakuSourceBinding("binding-audio", asset.id, reference.id)]
  };
  return { project, target };
}

function audioPublication(
  generationKey: MediaInventoryGenerationKey,
  changedRows: MediaInventoryPublication["changedRows"],
  total = 2
): MediaInventoryPublication {
  return {
    generationKey,
    phase: "completed",
    counts: {
      total,
      queued: 0,
      probing: 0,
      ready: total,
      failed: 0,
      cancelled: 0
    },
    changedRows,
    terminalMessage: null,
    restartRequired: false
  };
}

function queuedAudioPublication(
  generationKey: MediaInventoryGenerationKey,
  mediaIds: string[]
): MediaInventoryPublication {
  return {
    generationKey,
    phase: "running",
    counts: {
      total: mediaIds.length,
      queued: mediaIds.length,
      probing: 0,
      ready: 0,
      failed: 0,
      cancelled: 0
    },
    changedRows: mediaIds.map((mediaId) => ({ mediaId, status: "queued" as const })),
    terminalMessage: null,
    restartRequired: false
  };
}

function readyAudioRow(
  mediaId: string,
  recommendationState: "recommended" | "needsChoice",
  inventoryRevision: string
): MediaInventoryPublication["changedRows"][number] {
  return {
    mediaId,
    status: "ready",
    inventoryRevision,
    durationMs: 120_000,
    audioTracks: [
      audioTrack(1, "eng", "English dub", { default: true, dub: true }),
      audioTrack(2, "jpn", "Original", { original: true }),
      audioTrack(3, "eng", "Director commentary", { commentary: true })
    ],
    recommendation:
      recommendationState === "recommended"
        ? { state: "recommended", streamIndex: 2, reasonCodes: ["originalDisposition"] }
        : { state: "needsChoice", streamIndex: null, reasonCodes: ["equivalentCandidate"] },
    probeCompleteness: "complete",
    cacheState: "miss"
  };
}

function audioTrack(
  index: number,
  language: string,
  title: string,
  dispositions: Partial<{
    default: boolean;
    original: boolean;
    dub: boolean;
    commentary: boolean;
    descriptions: boolean;
    visualImpaired: boolean;
    hearingImpaired: boolean;
    cleanEffects: boolean;
    karaoke: boolean;
  }>
) {
  return {
    index,
    codec: "aac",
    language,
    title,
    sampleRate: 48_000,
    channels: 2,
    channelLayout: "stereo",
    durationMs: 120_000,
    dispositions: {
      default: false,
      original: false,
      dub: false,
      commentary: false,
      descriptions: false,
      visualImpaired: false,
      hearingImpaired: false,
      cleanEffects: false,
      karaoke: false,
      ...dispositions
    },
    recommendationRank: index,
    reasonCodes: []
  };
}

function chooseMaterialImport(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "添加素材" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}
