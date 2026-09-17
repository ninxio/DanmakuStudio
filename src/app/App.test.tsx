import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../domain/danmaku/cutHints";
import type { DanmakuAsset } from "../domain/danmaku/types";
import { createMediaMatchCandidate } from "../domain/alignment/mediaMatching";
import type { AlignmentProposal } from "../domain/alignment/types";
import { createHistoryState } from "../domain/history/history";
import { createEmptyProject } from "../domain/project/factory";
import {
  createBrowserFileMediaReference,
  createLocalPathMediaReference
} from "../domain/project/mediaLibrary";
import type { EditorProject, MediaTimeMap } from "../domain/project/types";
import type { MediaInventoryRequest } from "../infrastructure/media/tauriMediaInventory";
import type * as TauriMediaInventoryModule from "../infrastructure/media/tauriMediaInventory";
import { MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY } from "../infrastructure/alignment/multimodalRuleSnapshotArchiveStore";
import { createTestCompleteTimeMapSpan } from "../test/timeMapEvidence";
import { useEditorStore } from "../stores/editorStore";
import { createInitialProjectLibrarySessionState } from "../application/projectLibrarySessionController";
import { App } from "./App";
import { StrictMode } from "react";

const inventoryMocks = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn()
}));

vi.mock("../infrastructure/media/tauriMediaInventory", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriMediaInventoryModule>()),
  startTauriMediaInventoryJob: inventoryMocks.start,
  getTauriMediaInventoryJob: inventoryMocks.get,
  cancelTauriMediaInventoryJob: inventoryMocks.cancel
}));

vi.mock("../infrastructure/settings/desktopAppSettings", () => ({
  hydrateDesktopAppSettings: vi.fn(() => Promise.resolve(null)),
  formatDesktopSettingsError: (error: unknown) =>
    error instanceof Error ? error.message : String(error)
}));

describe("App 拖放导入", () => {
  beforeEach(() => {
    localStorage.clear();
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
      workspacePage: "materials",
      workspaceIntentSequence: 0,
      workspaceIntentRequest: null,
      projectEpoch: 0,
      projectContentRevision: 0,
      projectLibrary: createInitialProjectLibrarySessionState(),
      projectLibraryIntentSequence: 0,
      projectLibraryIntent: null,
      mediaInventoryGeneration: 0,
      mediaInventoryGenerationKey: null,
      mediaInventoryPhase: "idle",
      mediaInventoryCounts: null,
      mediaInventoryRows: {},
      mediaInventoryPaused: false
    });
    inventoryMocks.start.mockReset();
    inventoryMocks.get.mockReset();
    inventoryMocks.cancel.mockReset();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn<(object: Blob | MediaSource) => string>((object) =>
        object instanceof File ? `blob:${object.name}` : "blob:dropped-video"
      )
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn<(url: string) => void>()
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("拖放 XML、视频和音频时先确认媒体角色，不再静默当作参考素材", async () => {
    await act(async () => {
      render(<App />);
      await vi.dynamicImportSettled();
    });
    const root = screen.getByTestId("app-root");
    const xmlFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,r">测试</d></i>'],
      "episode.xml",
      { type: "text/xml" }
    );
    const mediaFiles = [
      new File(["video-a"], "bilibili-cut-a.mp4", { type: "video/mp4" }),
      new File(["audio-b"], "bilibili-cut-b.flac", { type: "audio/flac" })
    ];

    fireEvent.dragEnter(root, {
      dataTransfer: createFileDataTransfer([xmlFile, ...mediaFiles])
    });
    expect(screen.getByText("拖放导入")).toBeInTheDocument();

    fireEvent.drop(root, { dataTransfer: createFileDataTransfer([xmlFile, ...mediaFiles]) });

    await waitFor(() => expect(useEditorStore.getState().project.assets).toHaveLength(1));
    expect(useEditorStore.getState().project.assets[0].fileName).toBe("episode.xml");
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "确认媒体角色" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "共 2 个媒体文件。原片素材代表最终观看的标准时间轴；参考素材只用于确定弹幕原始时间和删减关系。"
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "作为 B 站参考导入" }));

    expect(useEditorStore.getState().project.mediaLibrary).toEqual([
      expect.objectContaining({
        role: "bilibiliReference",
        fileName: "bilibili-cut-a.mp4",
        objectUrl: "blob:bilibili-cut-a.mp4",
        referenceKind: "browserFile",
        sourceSummary: "本地浏览器文件引用",
        localPath: null
      }),
      expect.objectContaining({
        role: "bilibiliReference",
        fileName: "bilibili-cut-b.flac",
        objectUrl: "blob:bilibili-cut-b.flac",
        referenceKind: "browserFile",
        sourceSummary: "本地浏览器文件引用",
        localPath: null
      })
    ]);
    expect(useEditorStore.getState().project.media).toBeNull();
    expect(useEditorStore.getState().project.mediaBinding).toBeNull();
    expect(screen.queryByRole("dialog", { name: "确认媒体角色" })).not.toBeInTheDocument();
    expect(screen.queryByText("拖放导入")).not.toBeInTheDocument();
  });

  it("稳定壳层把当前页面、项目任务、上下文和后台状态保持在同一视口", async () => {
    await act(async () => {
      render(<App />);
      await vi.dynamicImportSettled();
    });

    const workspace = screen.getByRole("main", { name: "素材工作台" });
    expect(screen.queryByTestId("project-sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-rail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("项目菜单"));
    fireEvent.click(screen.getByRole("button", { name: "项目与分集" }));
    const projectSheet = screen.getByRole("dialog", { name: "项目与分集" });
    expect(projectSheet).toContainElement(screen.getByTestId("project-sidebar"));
    expect(workspace).toBeInTheDocument();
    fireEvent.keyDown(projectSheet, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "项目与分集" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("项目菜单")).toHaveFocus();
    fireEvent.click(screen.getByLabelText("项目菜单"));
    fireEvent.click(screen.getByRole("button", { name: "当前项目状态" }));
    const stateSheet = screen.getByRole("dialog", { name: "当前项目状态" });
    expect(stateSheet).toContainElement(screen.getByTestId("context-rail"));
    fireEvent.keyDown(stateSheet, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(workspace).toContainElement(screen.getByTestId("materials-summary"));
    expect(screen.getByTestId("status-bar")).toHaveTextContent("后台任务");
  });

  it("Ctrl+K 从任意页面打开真实命令入口，Escape 回焦并可直接切换路由", async () => {
    await act(async () => {
      render(<App />);
      await vi.dynamicImportSettled();
    });

    const trigger = screen.getByRole("button", { name: "打开命令与快捷键" });
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    const search = screen.getByRole("combobox", { name: "搜索命令" });
    expect(search).toHaveFocus();
    expect(screen.getByText("当前已在素材页")).toBeInTheDocument();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "命令与快捷键" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const reopenedSearch = screen.getByRole("combobox", { name: "搜索命令" });
    fireEvent.change(reopenedSearch, { target: { value: "导出" } });
    fireEvent.keyDown(reopenedSearch, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("workspace-export")).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "命令与快捷键" })).not.toBeInTheDocument();
  });

  it("编辑默认覆盖分析，点选参考后才进入定位修正", async () => {
    useEditorStore.setState({
      project: createReviewWorkbenchProject(),
      workspacePage: "editing",
      workspaceIntentRequest: null
    });
    addReviewCandidate("review-candidate-1", "source-review-1", "target-review-1");
    addReviewCandidate("review-candidate-2", "source-review-2", "target-review-2");
    await act(async () => {
      render(<App />);
      await vi.dynamicImportSettled();
    });
    expect(await screen.findByRole("region", { name: "匹配覆盖分析" })).toBeInTheDocument();
    expect(screen.queryByTestId("alignment-relation-navigator")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /定位 .* 的时间区间/ })[0]);
    const monitor = await screen.findByRole("region", { name: "A/B 视频监视器与播放" });
    expect(monitor).toContainElement(screen.getByTestId("dual-video-viewers"));
    expect(screen.getByRole("region", { name: "正式 TimeMap 与风险区" })).toContainElement(
      screen.getByTestId("time-map-direct-editor")
    );
    expect(screen.getByText("第 1 / 3 段")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回覆盖分析" }));
    expect(screen.getByRole("button", { name: "采用全部并导出" })).toBeInTheDocument();
  });

  it("停留在素材页也会由应用壳层自动归档合格生产规则", async () => {
    const project = createEmptyProject("app-auto-archive");
    project.mediaTimeMaps = [createEligibleTimeMap()];
    useEditorStore.setState({ project, workspacePage: "materials" });

    await act(async () => {
      render(<App />);
      await vi.dynamicImportSettled();
    });

    await waitFor(() =>
      expect(localStorage.getItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY)).toContain(
        "alignment-multimodal-rule-snapshot-archive-v1"
      )
    );
    expect(useEditorStore.getState().workspacePage).toBe("materials");
  });

  it("应用根生命周期自动 start，StrictMode 同 signature 只一次且换路由不 cancel", async () => {
    const media = createLocalPathMediaReference(
      "media-local",
      "targetOriginal",
      "C:\\media\\feature.mkv"
    );
    useEditorStore.setState({
      project: { ...createEmptyProject("根生命周期"), mediaLibrary: [media] }
    });
    inventoryMocks.start.mockImplementation((request: MediaInventoryRequest) =>
      Promise.resolve(completedInventorySnapshot(request))
    );

    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>
      );
      await vi.dynamicImportSettled();
    });

    await waitFor(() => expect(inventoryMocks.start).toHaveBeenCalledOnce());
    expect(inventoryMocks.start.mock.calls[0][0]).toMatchObject({
      schemaVersion: 1,
      items: [{ itemId: "media-local", path: "C:\\media\\feature.mkv" }]
    });
    act(() => useEditorStore.getState().setWorkspacePage("matching"));
    await waitFor(() => expect(useEditorStore.getState().workspacePage).toBe("matching"));
    act(() => useEditorStore.getState().setWorkspacePage("editing"));
    await waitFor(() => expect(useEditorStore.getState().workspacePage).toBe("editing"));
    act(() => useEditorStore.getState().setWorkspacePage("export"));
    await waitFor(() => expect(useEditorStore.getState().workspacePage).toBe("export"));
    act(() => useEditorStore.getState().setWorkspacePage("materials"));
    await waitFor(() => expect(useEditorStore.getState().workspacePage).toBe("materials"));
    expect(inventoryMocks.start).toHaveBeenCalledOnce();
    expect(inventoryMocks.cancel).not.toHaveBeenCalled();
  });

  it("browser 与 needsReconnect 素材不会伪装 ready，也不会启动原生清单", async () => {
    const browser = createBrowserFileMediaReference("media-browser", "bilibiliReference", {
      name: "browser",
      fileName: "browser.mp4",
      objectUrl: "blob:browser"
    });
    const reconnect = createLocalPathMediaReference("media-reconnect", "targetOriginal", "");
    useEditorStore.setState({
      project: {
        ...createEmptyProject("不可准备素材"),
        mediaLibrary: [browser, reconnect]
      }
    });

    await act(async () => {
      render(<App />);
      await vi.dynamicImportSettled();
    });

    await waitFor(() =>
      expect(useEditorStore.getState().mediaInventoryGenerationKey).not.toBeNull()
    );
    expect(inventoryMocks.start).not.toHaveBeenCalled();
    expect(
      useEditorStore.getState().getMediaAudioTrackPreparation("media-browser")
    ).toMatchObject({
      state: "notEligible",
      reason: "missingLocalPath"
    });
    expect(
      useEditorStore.getState().getMediaAudioTrackPreparation("media-reconnect")
    ).toMatchObject({ state: "notEligible", reason: "needsReconnect" });
  });
});

function createFileDataTransfer(files: File[]): DataTransfer {
  return {
    types: ["Files"],
    files,
    dropEffect: "none"
  } as unknown as DataTransfer;
}

function createReviewWorkbenchProject(): EditorProject {
  const project = createEmptyProject("UX-R3 编辑复核");
  project.mediaLibrary = [1, 2].flatMap((index) => [
    createBrowserFileMediaReference(`source-review-${index}`, "bilibiliReference", {
      name: `参考素材 ${index}`,
      fileName: `reference-${index}.mp4`,
      objectUrl: `blob:reference-${index}`
    }),
    createBrowserFileMediaReference(`target-review-${index}`, "targetOriginal", {
      name: `目标原片 ${index}`,
      fileName: `target-${index}.mkv`,
      objectUrl: `blob:target-${index}`
    })
  ]);
  project.assets = [createReviewAsset(1), createReviewAsset(2)];
  project.danmakuSourceBindings = [1, 2].map((index) => ({
    id: `review-binding-${index}`,
    assetId: `review-asset-${index}`,
    sourceMediaId: `source-review-${index}`,
    linkedAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  }));
  return project;
}

function addReviewCandidate(id: string, sourceMediaId: string, targetMediaId: string): void {
  const project = useEditorStore.getState().project;
  useEditorStore.getState().addMediaMatchCandidate(
    createMediaMatchCandidate(project, {
      id,
      batchId: "ux-r3-review-batch",
      sourceMediaId,
      targetMediaId,
      proposal: createReviewProposal()
    })
  );
}

function createReviewProposal(): AlignmentProposal {
  return {
    anchors: [],
    cutCandidates: [
      {
        id: "ux-r3-cut",
        name: "边界疑点",
        sourceAtMs: 20_000,
        targetGapMs: 5_000,
        confidence: 0.72,
        note: "这一段存在边界疑点，需要人工复核。"
      }
    ],
    confidence: 0.72,
    diagnostics: [],
    evidence: {
      algorithm: "alignment-v2-edit-map",
      completeFingerprintCount: 8,
      sourceFingerprintCount: 8,
      fingerprintMatchCount: 6,
      monotonicMatchCount: 6,
      strongAnchorCount: 4,
      weakAnchorCount: 2,
      offsetClusterCount: 1,
      refinedCandidateCount: 1,
      lowConfidenceRegionCount: 1,
      quality: "low"
    },
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 65_000,
      coverage: 1
    },
    timeMap: createReviewTimeMapProposal()
  };
}

function createReviewTimeMapProposal(): NonNullable<AlignmentProposal["timeMap"]> {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 65_000,
    spans: [
      createTestCompleteTimeMapSpan(
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 20_000,
          targetStartMs: 0,
          targetEndMs: 20_000
        },
        "ux-r3-span-1"
      ),
      createTestCompleteTimeMapSpan(
        {
          kind: "ambiguous",
          sourceStartMs: 20_000,
          sourceEndMs: 25_000,
          targetStartMs: 20_000,
          targetEndMs: 30_000
        },
        "ux-r3-span-2"
      ),
      createTestCompleteTimeMapSpan(
        {
          kind: "matched",
          sourceStartMs: 25_000,
          sourceEndMs: 60_000,
          targetStartMs: 30_000,
          targetEndMs: 65_000
        },
        "ux-r3-span-3"
      )
    ],
    quality: {
      level: "review",
      probability: 0.72,
      metricSource: "measured",
      coverage: 0.92,
      uniqueContentCoverage: 0.8,
      p50ResidualMs: 80,
      p95ResidualMs: 220,
      p99ResidualMs: 300,
      maxResidualMs: 360,
      boundaryUncertaintyMs: 240,
      alternativeMargin: 0.18,
      anchorCount: 12,
      anchorRegionCount: 2,
      heldOutAnchorCount: 3,
      reasons: ["边界需要人工复核。"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 12,
      visualAnchorCount: 0,
      heldOutAnchorCount: 3,
      top1Top2Margin: 0.18,
      uniqueContentCoverage: 0.8,
      repeatedContentOnly: false,
      selectedTrackReason: "测试音轨。",
      alternativeTrackScores: [],
      notes: ["UX-R3 工作台公开测试"]
    },
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    engineVersion: "alignment-v2-test",
    featureVersion: "ux-r3-review",
    parametersHash: "ux-r3-parameters"
  };
}

function createReviewAsset(index: number): DanmakuAsset {
  return {
    id: `review-asset-${index}`,
    name: `第 ${index} 集弹幕`,
    fileName: `episode-${index}.xml`,
    color: "#4cc9f0",
    items: [],
    warnings: [],
    importedAt: "2026-08-30T00:00:00.000Z",
    sourceReceipt: null
  };
}

function createEligibleTimeMap(): MediaTimeMap {
  return {
    id: "app-auto-map",
    revision: 1,
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: createIdentity("a"),
    targetIdentity: createIdentity("b"),
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 0,
    targetEndMs: 10_000,
    spans: [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 10,
      p95ResidualMs: 20,
      maxResidualMs: 30,
      boundaryUncertaintyMs: 40,
      alternativeMargin: 0.2,
      anchorCount: 3,
      heldOutAnchorCount: 1,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 3,
      visualAnchorCount: 0,
      heldOutAnchorCount: 1,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    state: "candidate",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    confirmedAt: null
  };
}

function createIdentity(digit: string) {
  return {
    algorithm: "sha256-full-file-v2" as const,
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: digit.repeat(64),
    lastSampleDigest: digit.repeat(64)
  };
}

function completedInventorySnapshot(request: MediaInventoryRequest) {
  return {
    schemaVersion: 1 as const,
    jobId: "job-app-lifecycle",
    status: "completed" as const,
    sequence: 1,
    cancelRequested: false,
    counts: {
      total: request.items.length,
      queued: 0,
      probing: 0,
      ready: request.items.length,
      failed: 0,
      cancelled: 0
    },
    items: request.items.map((item, ordinal) => ({
      ordinal,
      itemId: item.itemId,
      status: "ready" as const,
      result: {
        inventoryRevision: "inventory-v1:aaaaaaaaaaaaaaaa",
        durationMs: 120_000,
        audioTracks: [
          {
            index: 1,
            codec: "aac",
            language: "jpn",
            title: "Original",
            sampleRate: 48_000,
            channels: 2,
            channelLayout: "stereo",
            durationMs: 120_000,
            dispositions: {
              default: true,
              original: true,
              dub: false,
              commentary: false,
              descriptions: false,
              visualImpaired: false,
              hearingImpaired: false,
              cleanEffects: false,
              karaoke: false
            },
            recommendationRank: 1,
            reasonCodes: ["onlyNonSpecialTrack" as const]
          }
        ],
        recommendation: {
          state: "recommended" as const,
          streamIndex: 1,
          reasonCodes: ["onlyNonSpecialTrack" as const]
        },
        probeCompleteness: "complete" as const,
        cacheState: "miss" as const
      },
      error: null
    })),
    terminalError: null
  };
}
