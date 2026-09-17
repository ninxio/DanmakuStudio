import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeXmlReceiptModule from "../infrastructure/xml/nativeXmlReceipt";

const manualVerificationMocks = vi.hoisted(() => ({
  rehydrateProject: vi.fn()
}));
const nativeXmlMocks = vi.hoisted(() => ({
  importPaths: vi.fn()
}));

vi.mock("../infrastructure/media/manualVerificationAuthority", () => ({
  issuePersistedManualMediaTimeMapVerification: vi.fn(() =>
    Promise.reject(new Error("测试未配置人工验证签发"))
  ),
  rehydrateProjectManualMediaTimeMapVerifications: manualVerificationMocks.rehydrateProject,
  revokePersistedManualMediaTimeMapVerification: vi.fn(() =>
    Promise.reject(new Error("测试未配置人工验证撤销"))
  )
}));
vi.mock("../infrastructure/xml/nativeXmlReceipt", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeXmlReceiptModule>()),
  importNativeXmlPaths: nativeXmlMocks.importPaths
}));
import type {
  DanmakuAsset,
  DanmakuClip,
  DanmakuXmlSourceReceipt
} from "../domain/danmaku/types";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../domain/danmaku/cutHints";
import { createHistoryState } from "../domain/history/history";
import { createMediaMatchCandidate } from "../domain/alignment/mediaMatching";
import { createAlignmentShadowRiskOverlay } from "../domain/alignment/alignmentShadowRiskOverlay";
import { createEmptyProject } from "../domain/project/factory";
import { createMaterialIntakePlan } from "../domain/project/materialIntakePlan";
import {
  CURRENT_SCHEMA_VERSION,
  type AlignmentReviewRecord,
  type AlignmentReviewVote,
  type EditorProject,
  type ProjectMediaReference,
  type ProjectMediaRole
} from "../domain/project/types";
import { parseProjectJsonWithMetadata, serializeProject } from "../domain/project/schema";
import {
  createEmptyTimeMapSpanPlaybackEvidence,
  readTimeMapSpanPlaybackReview
} from "../domain/alignment/timeMapPlaybackReviewEvidence";
import { createTestCompleteTimeMapSpanPlaybackEvidence } from "../test/manualVerification";
import { createTestCompleteTimeMapSpan } from "../test/timeMapEvidence";
import { parseBilibiliXml } from "../infrastructure/xml/bilibiliXml";
import type { NativeXmlImportedFile } from "../infrastructure/xml/nativeXmlReceipt";
import type { MediaInventoryPublication } from "../application/mediaInventorySupervisor";
import { createInitialProjectLibrarySessionState } from "../application/projectLibrarySessionController";
import { useEditorStore } from "./editorStore";

function resetStore(project: EditorProject = createEmptyProject()): void {
  useEditorStore.setState({
    project,
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
    alignmentEditorCandidateId: null,
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
    mediaInventoryPaused: false,
    mediaInventoryCancelling: false,
    mediaInventoryRestartRequired: false,
    mediaInventoryTerminalMessage: null
  });
}

describe("project library session state", () => {
  it("只为领域提交递增内容修订，临时项目库状态不进入 JSON 或 undo", () => {
    resetStore(createEmptyProject("内容修订"));
    useEditorStore.setState({
      projectContentRevision: 0,
      projectLibraryIntentSequence: 0,
      projectLibraryIntent: null
    });
    const beforeJson = serializeProject(useEditorStore.getState().project);
    const beforeHistory = useEditorStore.getState().history;

    useEditorStore.getState().setPlayhead(1_000);
    useEditorStore.getState().setTimelineZoom(72);
    useEditorStore.getState().select({ kind: "none", ids: [] });
    expect(useEditorStore.getState().projectContentRevision).toBe(0);

    useEditorStore.getState().setGlobalOffset(250);
    expect(useEditorStore.getState().projectContentRevision).toBe(1);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().projectContentRevision).toBe(2);

    const historyBeforeIntent = useEditorStore.getState().history;
    useEditorStore.getState().requestProjectLibrary({ kind: "createProject" });
    expect(useEditorStore.getState().projectLibraryIntent).toMatchObject({
      sequence: 1,
      intent: { kind: "createProject" }
    });
    useEditorStore.getState().acknowledgeProjectLibraryIntent(1);
    useEditorStore.getState().requestProjectLibrary({ kind: "createProject" });
    expect(useEditorStore.getState().projectLibraryIntent?.sequence).toBe(2);
    expect(historyBeforeIntent).not.toBe(beforeHistory);
    expect(useEditorStore.getState().history).toBe(historyBeforeIntent);
    expect(beforeJson).not.toContain('"projectLibrary"');
    expect(serializeProject(useEditorStore.getState().project)).not.toContain(
      '"projectLibrary"'
    );
  });

  it("冻结 Personal Gold 只形成一次领域提交并保持 TimeMap 与签发状态不变", () => {
    const project = createEmptyProject("Personal Gold store");
    const record = {
      ...createShadowRiskReviewRecord("review:personal-gold"),
      decision: "target-extra" as const,
      algorithmPrediction: "targetOnly" as const
    };
    project.alignmentReviewRecords = [record];
    project.alignmentReviewVotes = [
      createPersonalGoldVote("vote:gold:a", "a", 600),
      createPersonalGoldVote("vote:gold:b", "b", 900)
    ];
    resetStore(project);
    const timeMapsBefore = structuredClone(useEditorStore.getState().project.mediaTimeMaps);

    expect(useEditorStore.getState().freezePersonalGoldCase(record.id)).toBe(true);

    const frozen = useEditorStore.getState();
    expect(frozen.project.alignmentPersonalGoldCases).toHaveLength(1);
    expect(frozen.project.mediaTimeMaps).toEqual(timeMapsBefore);
    expect(frozen.projectContentRevision).toBe(1);
    expect(frozen.history.past.at(-1)?.label).toBe("冻结 Personal Gold");
    expect(frozen.status.message).toContain("不会修改 TimeMap 或签发状态");

    expect(frozen.freezePersonalGoldCase(record.id)).toBe(true);
    const idempotent = useEditorStore.getState();
    expect(idempotent.project.alignmentPersonalGoldCases).toHaveLength(1);
    expect(idempotent.projectContentRevision).toBe(1);
    expect(idempotent.history.past).toHaveLength(1);
    expect(idempotent.status.message).toContain("已经冻结");

    idempotent.undo();
    expect(useEditorStore.getState().project.alignmentPersonalGoldCases).toEqual([]);
    expect(useEditorStore.getState().projectContentRevision).toBe(2);
  });

  it("从 library 已解析 snapshot 替换项目，不重复解析也不制造 undo/自动保存提交", () => {
    resetStore(createEmptyProject("旧项目"));
    useEditorStore.setState({ projectContentRevision: 7 });
    const result = parseProjectJsonWithMetadata(
      serializeProject(createEmptyProject("库内项目"))
    );
    manualVerificationMocks.rehydrateProject.mockResolvedValue(result.project);

    useEditorStore.getState().openProjectFromLibrary(result, {
      reason: "recent",
      libraryProjectId: "library-a",
      revision: 4
    });

    const state = useEditorStore.getState();
    expect(state.project.name).toBe("库内项目");
    expect(state.history.past).toHaveLength(0);
    expect(state.history.future).toHaveLength(0);
    expect(state.projectContentRevision).toBe(7);
  });
});

function createAsset(assetId: string, fileName: string) {
  return parseBilibiliXml(
    `<?xml version="1.0" encoding="UTF-8"?><i>
      <d p="0.000,1,25,16777215,0,0,u,a">开始</d>
      <d p="1.000,1,25,16777215,0,0,u,b">结束</d>
    </i>`,
    { assetId, fileName }
  );
}

function createAlignmentProposal() {
  return {
    anchors: [
      {
        id: "proposal-anchor",
        sourceMs: 10_000,
        targetMs: 12_000,
        confidence: 0.9,
        origin: "automatic" as const
      }
    ],
    cutCandidates: [
      {
        id: "proposal-cut",
        name: "候选版本差异",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 18_000,
        sourceRangeEndMs: 22_000,
        targetGapMs: 5000,
        confidence: 0.8,
        note: "测试"
      }
    ],
    confidence: 0.85,
    diagnostics: ["测试诊断"]
  };
}

function createEmbyBinding() {
  return {
    id: "binding-emby",
    kind: "embyItem" as const,
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
    mediaSources: []
  };
}

function mockRevokeObjectUrl(): ReturnType<typeof vi.fn> {
  const revokeObjectUrl = vi.fn();
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectUrl
  });
  return revokeObjectUrl;
}

describe("editor store", () => {
  beforeEach(() => {
    manualVerificationMocks.rehydrateProject.mockReset();
    manualVerificationMocks.rehydrateProject.mockImplementation((project: EditorProject) =>
      Promise.resolve(project)
    );
    nativeXmlMocks.importPaths.mockReset();
    nativeXmlMocks.importPaths.mockRejectedValue(new Error("测试未配置原生 XML 导入"));
    resetStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  it("新建项目时释放旧视频 objectUrl", () => {
    const revokeSpy = mockRevokeObjectUrl();
    resetStore({
      ...createEmptyProject(),
      media: {
        id: "media",
        name: "demo",
        fileName: "demo.mp4",
        objectUrl: "blob:old",
        durationMs: 1000
      }
    });
    useEditorStore.getState().newProject();
    expect(revokeSpy).toHaveBeenCalledWith("blob:old");
    expect(useEditorStore.getState().project.media).toBeNull();
  });

  it("打开项目时释放旧视频 objectUrl", () => {
    const revokeSpy = mockRevokeObjectUrl();
    resetStore({
      ...createEmptyProject(),
      media: {
        id: "media",
        name: "old",
        fileName: "old.mp4",
        objectUrl: "blob:old-project",
        durationMs: 1000
      }
    });
    const nextProject = createEmptyProject("打开的项目");
    useEditorStore.getState().openProjectFromText(serializeProject(nextProject));
    expect(revokeSpy).toHaveBeenCalledWith("blob:old-project");
    expect(useEditorStore.getState().project.name).toBe("打开的项目");
  });

  it("加载项目绑定的离线音频风险并支持保存、清除、撤销和重做", () => {
    const project = createEmptyProject("离线风险往返");
    const record = createShadowRiskReviewRecord("review:store");
    project.alignmentReviewRecords = [record];
    const overlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"7".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [
        {
          recordId: record.id,
          risk: 0.87,
          reasonCodes: ["audio-shadow-risk", "weak-local-audio-support"]
        }
      ]
    });
    const timeMapsBefore = structuredClone(project.mediaTimeMaps);
    resetStore(project);

    expect(
      useEditorStore.getState().importAlignmentShadowRiskOverlayJson(JSON.stringify(overlay))
    ).toBe(true);
    expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toEqual(overlay);
    expect(useEditorStore.getState().project.mediaTimeMaps).toEqual(timeMapsBefore);
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("加载离线音频风险");

    const saved = serializeProject(useEditorStore.getState().project);
    resetStore();
    useEditorStore.getState().openProjectFromText(saved, "risk-project.json");
    expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toEqual(overlay);

    useEditorStore.getState().clearAlignmentShadowRiskOverlay();
    expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toBeNull();
    expect(useEditorStore.getState().project.mediaTimeMaps).toEqual(timeMapsBefore);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toEqual(overlay);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toBeNull();
  });

  it("拒绝另一个项目或已变化记录的离线音频风险", () => {
    const source = createEmptyProject("风险来源项目");
    const sourceRecord = createShadowRiskReviewRecord("review:foreign");
    source.alignmentReviewRecords = [sourceRecord];
    const overlay = createAlignmentShadowRiskOverlay(source, {
      sourceRunId: `sha256:${"8".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [{ recordId: sourceRecord.id, risk: 0.72, reasonCodes: ["audio-shadow-risk"] }]
    });
    const target = createEmptyProject("风险目标项目");
    target.alignmentReviewRecords = [sourceRecord];
    resetStore(target);

    expect(
      useEditorStore.getState().importAlignmentShadowRiskOverlayJson(JSON.stringify(overlay))
    ).toBe(false);
    expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toBeNull();
    expect(useEditorStore.getState().status.message).toContain("另一个项目");

    resetStore(source);
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        alignmentReviewRecords: [{ ...sourceRecord, targetEndMs: sourceRecord.targetEndMs + 1 }]
      }
    }));
    expect(
      useEditorStore.getState().importAlignmentShadowRiskOverlayJson(JSON.stringify(overlay))
    ).toBe(false);
    expect(useEditorStore.getState().status.message).toContain("已经变化");
  });

  it("迟到的安装级验证恢复结果不能跨 projectEpoch 覆盖后来打开的项目", async () => {
    const resolveFirst = vi.fn<(project: EditorProject) => void>();
    manualVerificationMocks.rehydrateProject
      .mockImplementationOnce(
        (project: EditorProject) =>
          new Promise<EditorProject>((resolve) => {
            resolveFirst.mockImplementation(() =>
              resolve({ ...project, name: "不应写回的迟到项目" })
            );
          })
      )
      .mockImplementationOnce((project: EditorProject) => Promise.resolve(project));

    useEditorStore
      .getState()
      .openProjectFromText(serializeProject(createEmptyProject("先打开")));
    useEditorStore
      .getState()
      .openProjectFromText(serializeProject(createEmptyProject("后打开")));
    await Promise.resolve();
    expect(useEditorStore.getState().project.name).toBe("后打开");

    expect(resolveFirst).toHaveBeenCalledTimes(0);
    resolveFirst(createEmptyProject());
    await Promise.resolve();
    expect(useEditorStore.getState().project.name).toBe("后打开");
  });

  it("同一项目验证恢复期间的用户编辑不会被打开时快照覆盖", async () => {
    const resolveHydration = vi.fn<(project: EditorProject) => void>();
    manualVerificationMocks.rehydrateProject.mockImplementationOnce(
      () =>
        new Promise<EditorProject>((resolve) => {
          resolveHydration.mockImplementation(resolve);
        })
    );
    useEditorStore
      .getState()
      .openProjectFromText(serializeProject(createEmptyProject("并发编辑")));
    useEditorStore.getState().setGlobalOffset(1_234);
    expect(useEditorStore.getState().project.globalOffsetMs).toBe(1_234);

    expect(resolveHydration).toHaveBeenCalledTimes(0);
    resolveHydration({
      ...createEmptyProject("不应覆盖当前项目"),
      globalOffsetMs: 0
    });
    await Promise.resolve();
    expect(useEditorStore.getState().project.name).toBe("并发编辑");
    expect(useEditorStore.getState().project.globalOffsetMs).toBe(1_234);
  });

  it("打开旧版项目时提示 schema 迁移和片段边界兼容", () => {
    const asset = createAsset("asset-legacy-open", "legacy.xml");
    const legacyProject: EditorProject = {
      ...createEmptyProject("旧版项目"),
      schemaVersion: 1,
      assets: [asset],
      clips: [
        {
          id: "clip-legacy-open",
          assetId: asset.id,
          name: "旧片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    useEditorStore.getState().openProjectFromText(JSON.stringify(legacyProject));

    expect(useEditorStore.getState().project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(useEditorStore.getState().project.clips[0].sourceOutMs).toBe(1001);
    expect(useEditorStore.getState().status).toEqual({
      message: `已打开旧版项目：旧版项目。已从 v1 升级到 v${CURRENT_SCHEMA_VERSION}，并兼容调整 1 个片段边界。`,
      tone: "warning"
    });
  });

  it("打开项目时恢复持久化的对齐提案", () => {
    const project = {
      ...createEmptyProject("带提案项目"),
      alignmentProposal: createAlignmentProposal()
    };

    useEditorStore.getState().openProjectFromText(serializeProject(project));

    expect(useEditorStore.getState().alignmentProposal?.cutCandidates[0].id).toBe(
      "proposal-cut"
    );
    expect(useEditorStore.getState().project.alignmentProposal?.anchors[0].id).toBe(
      "proposal-anchor"
    );
  });

  it("可把当前本地视频绑定为目标原片并随时解除", () => {
    resetStore({
      ...createEmptyProject(),
      media: {
        id: "media-local",
        name: "本地完整版",
        fileName: "full.mp4",
        objectUrl: "blob:full",
        durationMs: 3_000_000
      }
    });

    useEditorStore.getState().bindCurrentMediaAsTarget();

    expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
      kind: "localFile",
      displayName: "本地完整版",
      fileName: "full.mp4",
      runtimeMs: 3_000_000
    });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("绑定本地目标原片");

    useEditorStore.getState().clearMediaBinding();

    expect(useEditorStore.getState().project.mediaBinding).toBeNull();
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.mediaBinding?.kind).toBe("localFile");
  });

  it("打开项目时恢复持久化的 Emby 目标原片绑定", () => {
    const project = {
      ...createEmptyProject("Emby 绑定项目"),
      mediaBinding: createEmbyBinding()
    };

    useEditorStore.getState().openProjectFromText(serializeProject(project));

    expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
      kind: "embyItem",
      itemId: "emby-item-1",
      seriesName: "测试剧集",
      episodeNumber: 2
    });
    expect(JSON.stringify(useEditorStore.getState().project.mediaBinding)).not.toContain(
      "token"
    );
  });

  it("可以把当前目标原片绑定到分集并支持清除", () => {
    resetStore({
      ...createEmptyProject("逐集绑定项目"),
      mediaBinding: createEmbyBinding()
    });

    useEditorStore.getState().bindCurrentTargetToSeasonEpisode("S01E02", "第 2 集");

    expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(1);
    expect(useEditorStore.getState().project.seasonEpisodeBindings[0]).toMatchObject({
      episodeKey: "S01E02",
      episodeLabel: "第 2 集",
      targetBinding: {
        kind: "embyItem",
        itemId: "emby-item-1"
      }
    });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("绑定分集目标原片");

    useEditorStore.getState().clearSeasonEpisodeBinding("S01E02");

    expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(0);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.seasonEpisodeBindings).toHaveLength(1);
  });

  it("可以增删改弹幕来源内容段并支持撤销", () => {
    const asset = createAsset("asset-source-segment", "source-segment.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      mediaLibrary: [
        createProjectMediaReference("source-media", "bilibiliReference"),
        createProjectMediaReference("target-media", "targetOriginal")
      ],
      danmakuSourceBindings: [
        {
          id: "binding-source-segment",
          assetId: asset.id,
          sourceMediaId: "source-media",
          linkedAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    });

    useEditorStore.getState().addDanmakuSourceSegment({
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "source-media",
      sourceStartMs: 7_200_000,
      sourceEndMs: 7_260_000,
      targetMediaId: "target-media",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集",
      note: "正片开始"
    });

    const segment = useEditorStore.getState().project.danmakuSourceSegments[0];
    expect(segment).toMatchObject({
      kind: "content",
      label: "第 1 集 来源段",
      sourceStartMs: 7_200_000,
      episodeKey: "S01E01"
    });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("新增弹幕来源内容段");

    useEditorStore.getState().updateDanmakuSourceSegment(segment.id, {
      kind: "ignored",
      sourceStartMs: 0,
      sourceEndMs: 7_200_000,
      targetMediaId: null,
      label: "前置无意义片段"
    });

    expect(useEditorStore.getState().project.danmakuSourceSegments[0]).toMatchObject({
      kind: "ignored",
      label: "前置无意义片段",
      episodeKey: null,
      episodeLabel: null
    });

    useEditorStore.getState().deleteDanmakuSourceSegment(segment.id);
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(0);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1);
  });

  it("批量应用素材关系只形成一个历史项，并可一次撤销整批绑定", () => {
    const project = createEmptyProject();
    project.assets = Array.from({ length: 5 }, (_, index) => {
      const episode = index + 1;
      return createAsset(
        `batch-asset-${episode}`,
        `${episode} - S01E${episode.toString().padStart(2, "0")}.xml`
      );
    });
    project.mediaLibrary = Array.from({ length: 5 }, (_, index) => {
      const episode = index + 1;
      return createProjectMediaReference(`batch-reference-${episode}`, "bilibiliReference", {
        fileName: `Reference.S01E${episode.toString().padStart(2, "0")}.mp4`
      });
    });
    resetStore(project);
    const plan = createMaterialIntakePlan(project);
    expect(plan.conflicts).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.suggestions).toHaveLength(5);

    useEditorStore.getState().applyMaterialIntakeSuggestions(
      plan,
      plan.suggestions.map((suggestion) => suggestion.id)
    );

    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(5);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().history.past[0]?.label).toBe("批量应用素材关系建议");
    expect(useEditorStore.getState().status.message).toContain("已一次应用 5 条");

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.danmakuSourceBindings).toEqual([]);
  });

  it("来源段存在时阻止 XML 改绑或解绑，并拒绝不一致的来源段新增与更新", () => {
    const asset = createAsset("asset-binding-consistency", "binding-consistency.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      mediaLibrary: [
        createProjectMediaReference("source-a", "bilibiliReference"),
        createProjectMediaReference("source-b", "bilibiliReference"),
        createProjectMediaReference("target", "targetOriginal")
      ],
      danmakuSourceBindings: [
        {
          id: "binding-consistency",
          assetId: asset.id,
          sourceMediaId: "source-a",
          linkedAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    });
    useEditorStore.getState().addDanmakuSourceSegment({
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "source-a",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetMediaId: "target",
      episodeKey: "S01E01",
      episodeLabel: "第 1 集"
    });
    const segment = useEditorStore.getState().project.danmakuSourceSegments[0];
    const historyLength = useEditorStore.getState().history.past.length;

    useEditorStore.getState().bindXmlToSourceMedia(asset.id, "source-b");
    expect(useEditorStore.getState().project.danmakuSourceBindings[0].sourceMediaId).toBe(
      "source-a"
    );
    expect(useEditorStore.getState().status.tone).toBe("warning");
    expect(useEditorStore.getState().status.message).toContain("不能更换 XML 来源");

    useEditorStore.getState().clearXmlSourceBinding(asset.id);
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(1);
    expect(useEditorStore.getState().status.tone).toBe("warning");
    expect(useEditorStore.getState().status.message).toContain("不能解除 XML 来源绑定");

    useEditorStore.getState().addDanmakuSourceSegment({
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "source-b",
      sourceStartMs: 60_000,
      sourceEndMs: 90_000,
      targetMediaId: "target",
      episodeKey: "S01E02",
      episodeLabel: "第 2 集"
    });
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1);
    expect(useEditorStore.getState().status.message).toContain(
      "必须与所属 XML 在素材页的绑定一致"
    );

    useEditorStore
      .getState()
      .updateDanmakuSourceSegment(segment.id, { sourceMediaId: "source-b" });
    expect(useEditorStore.getState().project.danmakuSourceSegments[0].sourceMediaId).toBe(
      "source-a"
    );
    expect(useEditorStore.getState().status.message).toContain(
      "必须与所属 XML 在素材页的绑定一致"
    );
    expect(useEditorStore.getState().history.past).toHaveLength(historyLength);
  });

  it("绑定、解绑或删除 XML 后会统一刷新待复核候选的派生状态", () => {
    const project = createEmptyProject();
    const asset = createAsset("asset-reconcile", "reconcile.xml");
    project.assets = [asset];
    project.mediaLibrary = [
      createProjectMediaReference("source-reconcile", "bilibiliReference"),
      createProjectMediaReference("target-reconcile", "targetOriginal")
    ];
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate-reconcile",
        batchId: "batch-reconcile",
        sourceMediaId: "source-reconcile",
        targetMediaId: "target-reconcile",
        proposal: {
          anchors: [],
          cutCandidates: [],
          confidence: 0.9,
          diagnostics: [],
          matchRange: {
            sourceStartMs: 0,
            sourceEndMs: 60_000,
            targetStartMs: 0,
            targetEndMs: 60_000,
            coverage: 0.9
          }
        }
      })
    ];
    resetStore(project);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("blocked");

    useEditorStore.getState().bindXmlToSourceMedia(asset.id, "source-reconcile");
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("pending");

    useEditorStore.getState().clearXmlSourceBinding(asset.id);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("blocked");

    useEditorStore.getState().bindXmlToSourceMedia(asset.id, "source-reconcile");
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("pending");

    useEditorStore.getState().removeAsset(asset.id);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("blocked");
  });

  it("同一跨页目标可重复发布，并且只有匹配 sequence 的消费确认会清除", () => {
    const project = createEmptyProject();
    project.mediaLibrary = [
      createProjectMediaReference("source-editor", "bilibiliReference"),
      createProjectMediaReference("target-editor", "targetOriginal")
    ];
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-editor",
      batchId: "batch-editor",
      sourceMediaId: "source-editor",
      targetMediaId: "target-editor",
      proposal: {
        anchors: [],
        cutCandidates: [],
        confidence: 0.5,
        diagnostics: [],
        matchRange: {
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000,
          coverage: 0.5
        }
      }
    });
    project.mediaMatchCandidates = [candidate];
    resetStore(project);

    useEditorStore.getState().requestWorkspaceIntent({
      page: "editing",
      target: { kind: "candidate", candidateId: candidate.id }
    });
    expect(useEditorStore.getState()).toMatchObject({
      workspacePage: "editing",
      alignmentEditorCandidateId: null,
      workspaceIntentSequence: 1,
      workspaceIntentRequest: {
        sequence: 1,
        intent: {
          page: "editing",
          target: { kind: "candidate", candidateId: candidate.id }
        }
      }
    });

    useEditorStore.getState().acknowledgeWorkspaceIntent(0);
    expect(useEditorStore.getState().workspaceIntentRequest?.sequence).toBe(1);
    useEditorStore.getState().requestWorkspaceIntent({
      page: "editing",
      target: { kind: "candidate", candidateId: candidate.id }
    });
    expect(useEditorStore.getState().workspaceIntentRequest?.sequence).toBe(2);
    useEditorStore.getState().acknowledgeWorkspaceIntent(2);
    expect(useEditorStore.getState().workspaceIntentRequest).toBeNull();

    useEditorStore.getState().selectAlignmentEditorCandidate("missing-candidate");
    expect(useEditorStore.getState().alignmentEditorCandidateId).toBeNull();
    expect(useEditorStore.getState().status.message).toContain("已经不存在");
  });

  it("阻止删除仍被引用的媒体素材，并允许删除空闲素材", () => {
    const revokeSpy = mockRevokeObjectUrl();
    const asset = createAsset("asset-media-delete", "delete.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      mediaLibrary: [
        createProjectMediaReference("source-media", "bilibiliReference", {
          objectUrl: "blob:source"
        }),
        createProjectMediaReference("target-media", "targetOriginal", {
          objectUrl: "blob:target"
        }),
        createProjectMediaReference("loose-media", "bilibiliReference", {
          objectUrl: "blob:loose"
        })
      ],
      mediaBinding: {
        id: "target-binding",
        kind: "localFile",
        displayName: "目标原片",
        fileName: "target.mp4",
        mediaId: "target-media",
        localPath: null,
        runtimeMs: 120_000,
        linkedAt: "2026-07-11T00:00:00.000Z"
      },
      danmakuSourceBindings: [
        {
          id: "xml-binding",
          assetId: asset.id,
          sourceMediaId: "source-media",
          linkedAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      danmakuSourceSegments: [
        {
          id: "segment",
          label: "第 1 集来源段",
          kind: "content",
          assetId: asset.id,
          sourceMediaId: "source-media",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetMediaId: "target-media",
          targetStartMs: null,
          timingRules: [],
          timeMapId: null,
          episodeKey: "S01E01",
          episodeLabel: "第 1 集",
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    });

    useEditorStore.getState().removeMediaReference("source-media");
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(3);
    expect(useEditorStore.getState().status.message).toContain(
      "不能删除该素材：XML 绑定：delete.xml"
    );

    useEditorStore.getState().removeMediaReference("loose-media");
    expect(useEditorStore.getState().project.mediaLibrary.map((media) => media.id)).toEqual([
      "source-media",
      "target-media"
    ]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:loose");
  });

  it("重新连接媒体素材时不创建重复素材并保留已有绑定 ID", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>((object) =>
      object instanceof File ? `blob:${object.name}` : "blob:media"
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    const asset = createAsset("asset-media-reconnect", "reconnect.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      mediaLibrary: [
        createProjectMediaReference("source-media", "bilibiliReference", {
          objectUrl: null,
          connectionState: "needsReconnect"
        }),
        createProjectMediaReference("target-media", "targetOriginal", {
          objectUrl: null,
          connectionState: "needsReconnect"
        })
      ],
      mediaBinding: {
        id: "target-binding",
        kind: "localFile",
        displayName: "目标原片",
        fileName: "target.mp4",
        mediaId: "target-media",
        localPath: null,
        runtimeMs: 120_000,
        linkedAt: "2026-07-11T00:00:00.000Z"
      },
      danmakuSourceBindings: [
        {
          id: "xml-binding",
          assetId: asset.id,
          sourceMediaId: "source-media",
          linkedAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ],
      danmakuSourceSegments: [
        {
          id: "segment",
          label: "第 1 集来源段",
          kind: "content",
          assetId: asset.id,
          sourceMediaId: "source-media",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetMediaId: "target-media",
          targetStartMs: null,
          timingRules: [],
          timeMapId: null,
          episodeKey: "S01E01",
          episodeLabel: "第 1 集",
          note: "",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z"
        }
      ]
    });

    try {
      useEditorStore
        .getState()
        .reconnectMediaReference(
          "source-media",
          new File(["source"], "source-new.flac", { type: "audio/flac" })
        );
      expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(2);
      expect(useEditorStore.getState().project.mediaLibrary[0]).toMatchObject({
        id: "source-media",
        fileName: "source-new.flac",
        objectUrl: "blob:source-new.flac",
        connectionState: "connected"
      });
      expect(useEditorStore.getState().project.media).toMatchObject({
        id: "source-media",
        fileName: "source-new.flac"
      });
      expect(useEditorStore.getState().project.danmakuSourceBindings[0].sourceMediaId).toBe(
        "source-media"
      );
      expect(useEditorStore.getState().project.danmakuSourceSegments[0]).toMatchObject({
        sourceMediaId: "source-media",
        targetMediaId: "target-media"
      });

      useEditorStore
        .getState()
        .reconnectMediaReference(
          "target-media",
          new File(["target"], "target-new.m4a", { type: "audio/mp4" })
        );
      expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(2);
      expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
        kind: "localFile",
        mediaId: "target-media",
        fileName: "target-new.m4a"
      });
      expect(useEditorStore.getState().project.danmakuSourceSegments[0].targetMediaId).toBe(
        "target-media"
      );
      expect(createObjectUrl).toHaveBeenCalledTimes(2);
    } finally {
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
    }
  });

  it("接受媒体匹配候选会生成段内映射，并可显式撤销确认后撤销/重做", async () => {
    const project = createEmptyProject();
    const asset = createAsset("asset-match", "match.xml");
    project.assets = [asset];
    project.mediaLibrary = [
      createProjectMediaReference("source-match", "bilibiliReference"),
      createProjectMediaReference("target-match", "targetOriginal")
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-match",
        assetId: asset.id,
        sourceMediaId: "source-match",
        linkedAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    ];
    resetStore(project);
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-match",
      batchId: "batch-match",
      sourceMediaId: "source-match",
      targetMediaId: "target-match",
      proposal: {
        anchors: [
          { id: "anchor-1", sourceMs: 0, targetMs: 0, origin: "automatic", confidence: 0.9 },
          {
            id: "anchor-2",
            sourceMs: 50_000,
            targetMs: 55_000,
            origin: "automatic",
            confidence: 0.9
          }
        ],
        cutCandidates: [
          {
            id: "cut-1",
            name: "删减",
            sourceAtMs: 20_000,
            targetGapMs: 5_000,
            confidence: 0.9,
            note: "测试"
          }
        ],
        confidence: 0.9,
        diagnostics: [],
        matchRange: {
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 65_000,
          coverage: 0.9
        }
      }
    });

    useEditorStore.getState().addMediaMatchCandidate(candidate);
    useEditorStore.getState().acceptMediaMatchCandidate(candidate.id, [asset.id]);

    const accepted = useEditorStore.getState().project;
    expect(accepted.mediaMatchCandidates[0]?.state).toBe("accepted");
    expect(accepted.danmakuSourceSegments[0]).toMatchObject({
      sourceMediaId: "source-match",
      targetMediaId: "target-match",
      targetStartMs: 0,
      timingRules: [expect.objectContaining({ sourceAtMs: 20_000, gapMs: 5_000 })]
    });
    expect(accepted.syncAnchors).toEqual([]);
    expect(accepted.cutMarkers).toEqual([]);

    const foreignIdentity = {
      algorithm: "sha256-full-file-v2",
      sizeBytes: 1,
      modifiedUnixMs: 1,
      firstSampleDigest: "1".repeat(64),
      middleSampleDigest: "2".repeat(64),
      lastSampleDigest: "3".repeat(64)
    };
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        mediaTimeMaps: state.project.mediaTimeMaps.map((map) =>
          map.state === "confirmed"
            ? {
                ...map,
                verification: {
                  recordVersion: 2 as const,
                  method: "manual-review" as const,
                  verificationId: "foreign-verification",
                  issuerKeyId: "another-installation",
                  issuerSequence: 1,
                  signatureAlgorithm: "hmac-sha256-v1" as const,
                  signature: "1".repeat(64),
                  requestDigest: `sha256:${"2".repeat(64)}`,
                  mapCoreDigest: `sha256:${"3".repeat(64)}`,
                  mapRevision: map.revision,
                  sourceIdentity: foreignIdentity,
                  targetIdentity: foreignIdentity,
                  calibrationArtifactId: "manual-a-b-review",
                  calibrationArtifactVersion: "1",
                  reviewEvidenceDigest: `sha256:${"4".repeat(64)}`,
                  verifier: "other-device",
                  verifiedAt: "2026-07-12T00:00:00.000Z",
                  revocation: null
                }
              }
            : map
        )
      }
    }));
    await useEditorStore.getState().revokeMediaMatchCandidateAcceptance(candidate.id);
    expect(useEditorStore.getState().project.danmakuSourceSegments).toEqual([]);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("pending");
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("撤销媒体匹配确认");
    expect(useEditorStore.getState().status.message).toContain("无法修改原安装撤销注册表");

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("accepted");

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().project.danmakuSourceSegments).toEqual([]);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]?.state).toBe("pending");

    useEditorStore.getState().acceptMediaMatchCandidate(candidate.id, [asset.id]);
    const generatedSegmentId = useEditorStore.getState().project.danmakuSourceSegments[0]?.id;
    expect(generatedSegmentId).toBeTruthy();
    useEditorStore.getState().deleteDanmakuSourceSegment(generatedSegmentId ?? "");
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]).toMatchObject({
      state: "accepted",
      appliedSegmentIds: [generatedSegmentId]
    });
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1);
    expect(useEditorStore.getState().status.message).toContain("不能单独删除");

    await useEditorStore.getState().revokeMediaMatchCandidateAcceptance(candidate.id);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]).toMatchObject({
      state: "pending",
      appliedSegmentIds: []
    });

    useEditorStore.getState().removeAsset(asset.id);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]).toMatchObject({
      state: "blocked",
      appliedSegmentIds: []
    });

    const staleAcceptedProject = {
      ...accepted,
      danmakuSourceSegments: []
    };
    resetStore(createEmptyProject());
    useEditorStore
      .getState()
      .openProjectFromText(serializeProject(staleAcceptedProject), "stale-accepted.json");
    expect(useEditorStore.getState().project.mediaMatchCandidates[0]).toMatchObject({
      state: "pending",
      appliedSegmentIds: []
    });
  });

  it("A/B 播放证据拒绝零时长提交，并让有效 v2 摘要在保存重开后仍可复核", () => {
    const project = createEmptyProject();
    const asset = createAsset("asset-playback", "playback.xml");
    project.assets = [asset];
    project.mediaLibrary = [
      createProjectMediaReference("source-playback", "bilibiliReference"),
      createProjectMediaReference("target-playback", "targetOriginal")
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-playback",
        assetId: asset.id,
        sourceMediaId: "source-playback",
        linkedAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z"
      }
    ];
    resetStore(project);
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-playback",
      batchId: "batch-playback",
      sourceMediaId: "source-playback",
      targetMediaId: "target-playback",
      proposal: {
        anchors: [],
        cutCandidates: [],
        confidence: 0.9,
        diagnostics: [],
        matchRange: {
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000,
          coverage: 1
        }
      }
    });
    useEditorStore.getState().addMediaMatchCandidate(candidate);
    const candidateMap = useEditorStore.getState().project.mediaTimeMaps[0];
    if (!candidateMap) throw new Error("A/B store 测试缺少候选时间图");
    const initialRevision = candidateMap.revision;
    const initialHistoryLength = useEditorStore.getState().history.past.length;

    useEditorStore
      .getState()
      .recordTimeMapSpanPlaybackReview(
        candidateMap.id,
        0,
        createEmptyTimeMapSpanPlaybackEvidence()
      );
    expect(useEditorStore.getState().project.mediaTimeMaps[0]?.revision).toBe(initialRevision);
    expect(useEditorStore.getState().history.past).toHaveLength(initialHistoryLength);
    expect(useEditorStore.getState().status.tone).toBe("error");
    expect(useEditorStore.getState().status.message).toContain("播放复核尚未完成");

    useEditorStore
      .getState()
      .recordTimeMapSpanPlaybackReview(
        candidateMap.id,
        0,
        createTestCompleteTimeMapSpanPlaybackEvidence(candidateMap, 0)
      );
    const reviewedMap = useEditorStore.getState().project.mediaTimeMaps[0];
    expect(reviewedMap?.revision).toBe(initialRevision + 1);
    expect(
      reviewedMap?.evidence.notes.some((note) => note.startsWith("manual-playback-review:v2:"))
    ).toBe(true);
    expect(reviewedMap && readTimeMapSpanPlaybackReview(reviewedMap, 0)).not.toBeNull();

    const serialized = serializeProject(useEditorStore.getState().project);
    useEditorStore.getState().openProjectFromText(serialized, "playback-review.json");
    const reopenedMap = useEditorStore.getState().project.mediaTimeMaps[0];
    expect(reopenedMap && readTimeMapSpanPlaybackReview(reopenedMap, 0)).toMatchObject({
      evidenceVersion: 2,
      policyVersion: 2
    });
  });

  it("原片独有直接接管只产生一条历史记录，并可一次撤销完整拆段", () => {
    const project = createEmptyProject();
    const asset = createAsset("asset-direct-gap", "direct-gap.xml");
    project.assets = [asset];
    project.mediaLibrary = [
      createProjectMediaReference("source-direct-gap", "bilibiliReference", {
        durationMs: 800_000
      }),
      createProjectMediaReference("target-direct-gap", "targetOriginal", {
        durationMs: 800_000
      })
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-direct-gap",
        assetId: asset.id,
        sourceMediaId: "source-direct-gap",
        linkedAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z"
      }
    ];
    resetStore(project);
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-direct-gap",
      batchId: "batch-direct-gap",
      sourceMediaId: "source-direct-gap",
      targetMediaId: "target-direct-gap",
      proposal: {
        anchors: [],
        cutCandidates: [],
        confidence: 0.7,
        diagnostics: [],
        matchRange: {
          sourceStartMs: 0,
          sourceEndMs: 700_000,
          targetStartMs: 0,
          targetEndMs: 738_250,
          coverage: 0.8
        }
      }
    });
    useEditorStore.getState().addMediaMatchCandidate(candidate);
    const candidateMap = useEditorStore.getState().project.mediaTimeMaps[0];
    if (!candidateMap) throw new Error("直接接管 store 测试缺少候选时间图");
    const ambiguous = {
      ...createTestCompleteTimeMapSpan(
        {
          kind: "ambiguous" as const,
          sourceStartMs: 0,
          sourceEndMs: 366_775,
          targetStartMs: 0,
          targetEndMs: 405_025
        },
        `${candidateMap.id}:ambiguous`
      ),
      quality: {
        ...createTestCompleteTimeMapSpan(
          {
            kind: "ambiguous" as const,
            sourceStartMs: 0,
            sourceEndMs: 366_775,
            targetStartMs: 0,
            targetEndMs: 405_025
          },
          `${candidateMap.id}:ambiguous`
        ).quality,
        level: "blocked" as const,
        reasons: ["需要人工确认。"]
      }
    };
    const following = createTestCompleteTimeMapSpan(
      {
        kind: "matched",
        sourceStartMs: 366_775,
        sourceEndMs: 700_000,
        targetStartMs: 405_025,
        targetEndMs: 738_250
      },
      `${candidateMap.id}:following`
    );
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        mediaTimeMaps: state.project.mediaTimeMaps.map((map) =>
          map.id === candidateMap.id
            ? {
                ...map,
                sourceEndMs: 700_000,
                targetEndMs: 738_250,
                spans: [ambiguous, following],
                quality: { ...map.quality, level: "blocked", reasons: ["需要人工确认。"] }
              }
            : map
        )
      },
      history: createHistoryState()
    }));

    useEditorStore.getState().resolveOriginalOnlyGap(candidateMap.id, 0, {
      sourceAtMs: 366_775,
      targetStartMs: 366_775,
      targetEndMs: 405_025
    });

    expect(
      useEditorStore.getState().project.mediaTimeMaps[0]?.spans.map((span) => span.kind)
    ).toEqual(["matched", "targetOnly", "matched"]);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().history.past[0]?.label).toBe("标记原片独有内容");

    useEditorStore.getState().undo();
    expect(
      useEditorStore.getState().project.mediaTimeMaps[0]?.spans.map((span) => span.kind)
    ).toEqual(["ambiguous", "matched"]);
  });

  it("同一候选绑定多个 XML 时删除其中一个不会留下 confirmed 时间图孤儿段", () => {
    const project = createEmptyProject();
    const firstAsset = createAsset("asset-multi-a", "multi-a.xml");
    const secondAsset = createAsset("asset-multi-b", "multi-b.xml");
    project.assets = [firstAsset, secondAsset];
    project.mediaLibrary = [
      createProjectMediaReference("source-multi", "bilibiliReference"),
      createProjectMediaReference("target-multi", "targetOriginal")
    ];
    project.danmakuSourceBindings = [firstAsset, secondAsset].map((asset, index) => ({
      id: `binding-multi-${index}`,
      assetId: asset.id,
      sourceMediaId: "source-multi",
      linkedAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z"
    }));
    resetStore(project);
    const candidate = createMediaMatchCandidate(project, {
      id: "candidate-multi-xml",
      batchId: "batch-multi-xml",
      sourceMediaId: "source-multi",
      targetMediaId: "target-multi",
      proposal: {
        anchors: [],
        cutCandidates: [],
        confidence: 0.9,
        diagnostics: [],
        matchRange: {
          sourceStartMs: 0,
          sourceEndMs: 2_000,
          targetStartMs: 0,
          targetEndMs: 2_000,
          coverage: 1
        }
      }
    });

    useEditorStore.getState().addMediaMatchCandidate(candidate);
    useEditorStore
      .getState()
      .acceptMediaMatchCandidate(candidate.id, [firstAsset.id, secondAsset.id]);
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(2);

    useEditorStore.getState().removeAsset(firstAsset.id);

    const afterRemoval = useEditorStore.getState().project;
    expect(afterRemoval.danmakuSourceSegments).toHaveLength(1);
    expect(afterRemoval.danmakuSourceSegments[0]?.assetId).toBe(secondAsset.id);
    expect(afterRemoval.mediaMatchCandidates[0]).toMatchObject({
      state: "accepted",
      appliedSegmentIds: [expect.stringContaining(secondAsset.id)]
    });
    const serialized = serializeProject(afterRemoval);
    expect(() =>
      useEditorStore.getState().openProjectFromText(serialized, "multi.json")
    ).not.toThrow();
    expect(useEditorStore.getState().project.danmakuSourceSegments).toHaveLength(1);
  });

  it("批量导入本地路径会保留全部素材、跳过重复项并只产生一次历史记录", () => {
    resetStore(createEmptyProject());

    useEditorStore
      .getState()
      .importMediaPaths(
        [
          "D:\\Dark\\S01E01.mkv",
          "D:\\Dark\\S01E02.mp4",
          "D:\\Dark\\S01E03.flac",
          "D:\\Dark\\S01E04.m4a",
          " d:\\dark\\s01e01.MKV ",
          "D:\\Dark\\notes.txt"
        ],
        "targetOriginal"
      );

    const imported = useEditorStore.getState();
    expect(imported.project.mediaLibrary).toHaveLength(4);
    expect(imported.project.mediaLibrary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "targetOriginal",
          referenceKind: "localPath",
          localPath: "D:\\Dark\\S01E01.mkv",
          connectionState: "connected"
        }),
        expect.objectContaining({ localPath: "D:\\Dark\\S01E02.mp4" }),
        expect.objectContaining({ localPath: "D:\\Dark\\S01E03.flac" }),
        expect.objectContaining({ localPath: "D:\\Dark\\S01E04.m4a" })
      ])
    );
    expect(imported.project.media).toBeNull();
    expect(imported.project.mediaBinding).toBeNull();
    expect(imported.history.past).toHaveLength(1);
    expect(imported.history.past[0]?.label).toBe("批量导入原片素材");

    useEditorStore
      .getState()
      .importMediaPaths(["D:\\Dark\\S01E02.mp4", "D:\\Dark\\S01E05.mov"], "targetOriginal");
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(5);
    expect(useEditorStore.getState().status.message).toContain("跳过 1 个重复路径");

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(4);
  });

  it("Emby 音频缓存按本地路径持久导入且项目中不保存 token", () => {
    resetStore(createEmptyProject());
    const draft = {
      localPath: "C:\\AppData\\emby-audio-cache-v1\\Dark-S03E01.flac",
      durationMs: 3_000_000,
      profileLabel: "无损 FLAC",
      audioTrackLabel: "German · AAC · 默认",
      emby: {
        itemId: "episode-1",
        itemName: "Episode 1",
        itemType: "Episode",
        seriesName: "Dark",
        seasonNumber: 3,
        episodeNumber: 1,
        server: {
          serverUrl: "https://emby.example",
          pathPrefix: "/emby",
          username: "tester"
        },
        mediaSources: []
      }
    };

    useEditorStore.getState().importEmbyAudioCache(draft);

    const imported = useEditorStore.getState();
    expect(imported.project.mediaLibrary).toHaveLength(1);
    expect(imported.project.mediaLibrary[0]).toMatchObject({
      role: "targetOriginal",
      referenceKind: "localPath",
      connectionState: "connected",
      localPath: draft.localPath,
      episodeLabel: "S03E01",
      episodeKey: "emby:https://emby.example:episode-1",
      emby: {
        itemId: "episode-1",
        server: { username: "tester" }
      }
    });
    expect(imported.project.mediaLibrary[0]?.sourceSummary).toContain("无损 FLAC");
    expect(JSON.stringify(imported.project)).not.toContain("token");
    expect(imported.history.past.at(-1)?.label).toBe("导入 Emby 原片音频");

    useEditorStore.getState().importEmbyAudioCache(draft);
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(1);
    expect(useEditorStore.getState().status.message).toContain("已在原片素材中");
  });

  it("更新媒体时长时可以按稳定 ID 写回目标原片素材", () => {
    resetStore({
      ...createEmptyProject(),
      media: null,
      mediaLibrary: [
        createProjectMediaReference("target-media", "targetOriginal", {
          durationMs: null
        })
      ],
      mediaBinding: {
        id: "target-binding",
        kind: "localFile",
        displayName: "目标原片",
        fileName: "target.mp4",
        mediaId: "target-media",
        localPath: null,
        runtimeMs: null,
        linkedAt: "2026-07-11T00:00:00.000Z"
      }
    });

    useEditorStore.getState().updateMediaDuration(123_456, "target-media");

    expect(useEditorStore.getState().project.media).toBeNull();
    expect(useEditorStore.getState().project.mediaLibrary[0].durationMs).toBe(123_456);
    expect(useEditorStore.getState().project.mediaBinding).toMatchObject({
      kind: "localFile",
      mediaId: "target-media",
      runtimeMs: 123_456
    });
  });

  it("预览对齐提案时同步写入项目文件状态", () => {
    const proposal = createAlignmentProposal();

    useEditorStore.getState().previewAlignmentProposalData(proposal);

    expect(useEditorStore.getState().alignmentProposal).toBe(proposal);
    expect(useEditorStore.getState().project.alignmentProposal).toBe(proposal);
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("预览对齐提案");
  });

  it("重复预览相同对齐提案时不追加历史记录", () => {
    const proposal = createAlignmentProposal();

    useEditorStore.getState().previewAlignmentProposalData(proposal);
    useEditorStore.getState().previewAlignmentProposalData(createAlignmentProposal());

    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
  });

  it("清空对齐提案时同步项目状态并支持撤销重做", () => {
    const proposal = createAlignmentProposal();
    useEditorStore.getState().previewAlignmentProposalData(proposal);

    useEditorStore.getState().clearAlignmentProposal();

    expect(useEditorStore.getState().alignmentProposal).toBeNull();
    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "已清空当前对齐提案。",
      tone: "success"
    });

    useEditorStore.getState().undo();

    expect(useEditorStore.getState().alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
    expect(useEditorStore.getState().project.alignmentProposal?.cutCandidates[0].id).toBe(
      "proposal-cut"
    );

    useEditorStore.getState().redo();

    expect(useEditorStore.getState().alignmentProposal).toBeNull();
    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
  });

  it("撤销和重做对齐提案预览时同步顶层对齐提案", () => {
    const asset = createAsset("asset-with-preview", "preview.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });
    useEditorStore.getState().addAssetToTimeline(asset.id);
    useEditorStore.getState().previewAlignmentProposalData(createAlignmentProposal());

    expect(useEditorStore.getState().alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
    expect(useEditorStore.getState().project.alignmentProposal?.anchors[0].id).toBe(
      "proposal-anchor"
    );

    useEditorStore.getState().undo();

    expect(useEditorStore.getState().project.clips).toHaveLength(1);
    expect(useEditorStore.getState().project.alignmentProposal).toBeNull();
    expect(useEditorStore.getState().alignmentProposal).toBeNull();

    useEditorStore.getState().redo();

    expect(useEditorStore.getState().project.alignmentProposal?.anchors[0].id).toBe(
      "proposal-anchor"
    );
    expect(useEditorStore.getState().alignmentProposal?.anchors[0].id).toBe("proposal-anchor");
  });

  it("追加片段时使用已有片段包含 localOffsetMs 的视觉结束点", () => {
    const firstAsset = createAsset("asset-a", "a.xml");
    const secondAsset = createAsset("asset-b", "b.xml");
    const existingClip: DanmakuClip = {
      id: "clip-a",
      assetId: firstAsset.id,
      name: firstAsset.name,
      timelineStartMs: 1000,
      sourceInMs: 0,
      sourceOutMs: 1000,
      localOffsetMs: 500,
      enabled: true
    };
    resetStore({
      ...createEmptyProject(),
      assets: [firstAsset, secondAsset],
      clips: [existingClip]
    });
    useEditorStore.getState().addAssetToTimeline(secondAsset.id);
    const addedClip = useEditorStore
      .getState()
      .project.clips.find((clip) => clip.assetId === secondAsset.id);
    expect(addedClip?.timelineStartMs).toBe(2500);
  });

  it("新增片段使用半开源区间并覆盖最后一条弹幕", () => {
    const asset = createAsset("asset-source-range", "source-range.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });

    useEditorStore.getState().addAssetToTimeline(asset.id);

    const clip = useEditorStore.getState().project.clips[0];
    expect(clip.sourceInMs).toBe(0);
    expect(clip.sourceOutMs).toBe(1001);
    useEditorStore.getState().prepareExport();
    expect(useEditorStore.getState().exportDraft?.summary.enabledCount).toBe(2);
  });

  it("自动排列片段使用半开源区间并覆盖最后一条弹幕", () => {
    const asset = createAsset("asset-auto-range", "auto-range.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });

    useEditorStore.getState().autoArrangeClips();

    const clip = useEditorStore.getState().project.clips[0];
    expect(clip.sourceInMs).toBe(0);
    expect(clip.sourceOutMs).toBe(1001);
  });

  it("旧排列入口首次建立 XML 时间线也保留延迟，已有时间线仍可显式重排", () => {
    const asset = createAsset("delayed-initial", "delayed.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [
        {
          ...asset,
          items: asset.items.map((item) => ({
            ...item,
            sourceTimeMs: item.sourceTimeMs + 17_250
          }))
        }
      ]
    });
    useEditorStore.getState().autoArrangeClips();
    useEditorStore.getState().prepareExport();
    const draft = useEditorStore.getState().exportDraft;
    expect(draft?.validation.ok).toBe(true);
    expect(draft?.xml).toContain('p="17.250,');
    expect(draft?.xml).toContain('p="18.250,');
    const clip = useEditorStore.getState().project.clips[0];
    useEditorStore.getState().moveClip(clip.id, 5_000);
    useEditorStore.getState().autoArrangeClips();
    expect(useEditorStore.getState().project.clips[0].timelineStartMs).toBe(0);
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("按顺序排列分 P");
  });

  it("导入多个 XML 时按共享调色板顺序分配颜色", async () => {
    const firstFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,a">A</d></i>'],
      "a.xml",
      {
        type: "application/xml"
      }
    );
    const secondFile = new File(
      ['<?xml version="1.0" encoding="UTF-8"?><i><d p="0,1,25,16777215,0,0,u,b">B</d></i>'],
      "b.xml",
      {
        type: "application/xml"
      }
    );
    await useEditorStore.getState().importXmlFiles([firstFile, secondFile]);
    expect(useEditorStore.getState().project.assets.map((asset) => asset.color)).toEqual([
      "#4cc9f0",
      "#7bd88f"
    ]);
    expect(
      useEditorStore.getState().project.assets.every((asset) => asset.sourceReceipt === null)
    ).toBe(true);
    expect(useEditorStore.getState().status.tone).toBe("warning");
    expect(useEditorStore.getState().status.message).toContain("正式受验证导出前");
  });

  it("原生多文件导入只生成一次原子历史提交并保存收据", async () => {
    const first = createAsset("native-source-a", "a.xml");
    const second = createAsset("native-source-b", "b.xml");
    nativeXmlMocks.importPaths.mockResolvedValue([
      createNativeImportedFile(first, "a.xml", "1"),
      createNativeImportedFile(second, "b.xml", "2")
    ]);

    await useEditorStore
      .getState()
      .importXmlPaths(["D:\\danmaku\\a.xml", "D:\\danmaku\\b.xml"]);

    const state = useEditorStore.getState();
    expect(nativeXmlMocks.importPaths).toHaveBeenCalledTimes(1);
    expect(state.project.assets).toHaveLength(2);
    expect(state.project.assets.every((asset) => asset.sourceReceipt !== null)).toBe(true);
    expect(state.history.past).toHaveLength(1);
    expect(state.history.past[0].label).toBe("原生导入 XML");
    expect(state.status.message).toContain("新增 2 个");
  });

  it("原生重新导入按不可变库存唯一认领旧资源并保留所有项目引用", async () => {
    const legacyAsset = createAsset("legacy-asset", "old-name.xml");
    legacyAsset.name = "用户保留名称";
    legacyAsset.color = "#abcdef";
    legacyAsset.importedAt = "2026-07-01T00:00:00.000Z";
    const originalFirstItemId = legacyAsset.items[0].id;
    resetStore({
      ...createEmptyProject("旧项目"),
      assets: [legacyAsset],
      danmakuSourceBindings: [
        {
          id: "binding-1",
          assetId: legacyAsset.id,
          sourceMediaId: "source-media",
          linkedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z"
        }
      ],
      disabledItemIds: [originalFirstItemId],
      itemTimeAdjustments: { [originalFirstItemId]: 1250 }
    });
    nativeXmlMocks.importPaths.mockResolvedValue([
      createNativeImportedFile(legacyAsset, "reselected.xml", "3")
    ]);

    await useEditorStore.getState().importXmlPaths(["D:\\danmaku\\reselected.xml"]);

    const project = useEditorStore.getState().project;
    expect(project.assets).toHaveLength(1);
    expect(project.assets[0]).toMatchObject({
      id: "legacy-asset",
      name: "用户保留名称",
      fileName: "reselected.xml",
      color: "#abcdef",
      importedAt: "2026-07-01T00:00:00.000Z",
      sourceReceipt: { receiptId: `xmlr-sha256:${"3".repeat(64)}` }
    });
    expect(project.assets[0].items.map((item) => item.id)).toEqual([
      "legacy-asset_item_0",
      "legacy-asset_item_1"
    ]);
    expect(project.assets[0].items.every((item) => item.enabled)).toBe(true);
    expect(project.danmakuSourceBindings[0].assetId).toBe("legacy-asset");
    expect(project.disabledItemIds).toEqual([originalFirstItemId]);
    expect(project.itemTimeAdjustments).toEqual({ [originalFirstItemId]: 1250 });
    expect(useEditorStore.getState().status.message).toContain("认领旧资源 1 个，新增 0 个");
  });

  it("多个旧资源库存相同时不猜测认领对象而是新增资源", async () => {
    const firstLegacy = createAsset("legacy-a", "a.xml");
    const secondLegacy = createAsset("legacy-b", "b.xml");
    resetStore({
      ...createEmptyProject("歧义旧项目"),
      assets: [firstLegacy, secondLegacy]
    });
    nativeXmlMocks.importPaths.mockResolvedValue([
      createNativeImportedFile(firstLegacy, "reselected.xml", "4")
    ]);

    await useEditorStore.getState().importXmlPaths(["D:\\danmaku\\reselected.xml"]);

    const assets = useEditorStore.getState().project.assets;
    expect(assets).toHaveLength(3);
    expect(assets.filter((asset) => asset.sourceReceipt === null)).toHaveLength(2);
    expect(assets.filter((asset) => asset.sourceReceipt !== null)).toHaveLength(1);
    expect(useEditorStore.getState().status.message).toContain("认领旧资源 0 个，新增 1 个");
  });

  it("原生批量读取失败时不提交任何部分资源", async () => {
    nativeXmlMocks.importPaths.mockRejectedValue(new Error("第二个 XML 签名失败"));

    await useEditorStore
      .getState()
      .importXmlPaths(["D:\\danmaku\\a.xml", "D:\\danmaku\\b.xml"]);

    const state = useEditorStore.getState();
    expect(state.project.assets).toEqual([]);
    expect(state.history.past).toEqual([]);
    expect(state.importProgress).toBeNull();
    expect(state.status).toEqual({
      message: "XML 导入失败：第二个 XML 签名失败",
      tone: "error"
    });
  });

  it("XML 文件读取失败时清除导入进度并显示错误", async () => {
    const file = new File([""], "broken.xml", { type: "application/xml" });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: vi.fn<() => Promise<string>>(() => Promise.reject(new Error("读取被拒绝")))
    });

    await useEditorStore.getState().importXmlFiles([file]);

    expect(useEditorStore.getState().project.assets).toHaveLength(0);
    expect(useEditorStore.getState().importProgress).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "XML 导入失败：读取文件 broken.xml 失败：读取被拒绝",
      tone: "error"
    });
  });

  it("没有可导出弹幕时不会生成空 XML 草稿", () => {
    const asset = createAsset("asset-empty-export", "empty-export.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "当前没有可导出的弹幕，请先把 XML 放入时间轴。",
      tone: "warning"
    });
  });

  it("存在目标原片时单文件导出入口在状态层严格阻断", () => {
    const asset = createAsset("asset-projection-only", "projection-only.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-projection-only",
          assetId: asset.id,
          name: "旧时间轴片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1001,
          localOffsetMs: 0,
          enabled: true
        }
      ],
      mediaLibrary: [createProjectMediaReference("target-export", "targetOriginal")]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "导出已阻断：当前项目必须在导出页通过已确认时间图按原片分集导出。",
      tone: "warning"
    });
  });

  it("导出前检查存在阻断项时不会生成导出草稿", () => {
    const asset = createAsset("asset-blocked-export", "blocked-export.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-missing-asset",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message: "导出前检查未通过：片段引用了缺失资源。请在导出检查中处理后再导出。",
      tone: "warning"
    });
  });

  it("导出前检查存在多个阻断项时导出提示会汇总标题", () => {
    const asset = createAsset("asset-multi-blocked-export", "multi-blocked-export.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [
        {
          ...asset,
          items: asset.items.map((item, index) =>
            index === 1 ? { ...item, id: asset.items[0].id } : item
          )
        }
      ],
      clips: [
        {
          id: "clip-missing-asset",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    useEditorStore.getState().prepareExport();

    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().status).toEqual({
      message:
        "导出前检查未通过：弹幕 ID 重复、片段引用了缺失资源。请在导出检查中处理后再导出。",
      tone: "warning"
    });
  });

  it("更新共享疑似删减扫描配置", () => {
    useEditorStore.getState().setCutHintSettings({
      keywordsText: "广告",
      windowSeconds: "30"
    });

    expect(useEditorStore.getState().cutHintSettings).toEqual({
      ...DEFAULT_CUT_HINT_SEARCH_SETTINGS,
      keywordsText: "广告",
      windowSeconds: "30"
    });
  });

  it("清理失效编辑引用并写入历史", () => {
    const asset = createAsset("asset-cleanup", "cleanup.xml");
    const validItemId = asset.items[0].id;
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      disabledItemIds: [validItemId, "missing-disabled"],
      itemTimeAdjustments: {
        [validItemId]: 100,
        "missing-adjustment": 200
      }
    });

    useEditorStore.getState().cleanupProjectEditReferences();

    expect(useEditorStore.getState().project.disabledItemIds).toEqual([validItemId]);
    expect(useEditorStore.getState().project.itemTimeAdjustments).toEqual({
      [validItemId]: 100
    });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("清理失效编辑引用");
    expect(useEditorStore.getState().status).toEqual({
      message: "已清理 2 条失效编辑引用。",
      tone: "success"
    });
  });

  it("没有失效编辑引用时不写入历史", () => {
    const asset = createAsset("asset-no-cleanup", "no-cleanup.xml");
    const validItemId = asset.items[0].id;
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      disabledItemIds: [validItemId],
      itemTimeAdjustments: {
        [validItemId]: 100
      }
    });

    useEditorStore.getState().cleanupProjectEditReferences();

    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "当前没有需要清理的失效编辑引用。",
      tone: "neutral"
    });
  });

  it("清理缺失资源片段并过滤选择状态", () => {
    const asset = createAsset("asset-missing-clip-cleanup", "missing-clip-cleanup.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-valid",
          assetId: asset.id,
          name: "有效片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        },
        {
          id: "clip-missing",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 1000,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });
    useEditorStore.setState({
      selection: { kind: "clip", ids: ["clip-valid", "clip-missing"] }
    });

    useEditorStore.getState().cleanupProjectMissingAssetClips();

    expect(useEditorStore.getState().project.clips.map((clip) => clip.id)).toEqual([
      "clip-valid"
    ]);
    expect(useEditorStore.getState().selection).toEqual({ kind: "clip", ids: ["clip-valid"] });
    expect(useEditorStore.getState().history.past.at(-1)?.label).toBe("清理缺失资源片段");
    expect(useEditorStore.getState().status).toEqual({
      message: "已清理 1 个缺失资源片段。",
      tone: "success"
    });
  });

  it("没有缺失资源片段时不写入历史", () => {
    const asset = createAsset("asset-valid-clip-cleanup", "valid-clip-cleanup.xml");
    resetStore({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-valid",
          assetId: asset.id,
          name: "有效片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    useEditorStore.getState().cleanupProjectMissingAssetClips();

    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "当前没有需要清理的缺失资源片段。",
      tone: "neutral"
    });
  });

  it("可把对齐提案发送到时间轴预览", () => {
    useEditorStore.getState().previewAlignmentProposalData({
      anchors: [
        { id: "anchor", sourceMs: 10_000, targetMs: 20_000, confidence: 1, origin: "manual" }
      ],
      cutCandidates: [],
      confidence: 0.5,
      diagnostics: []
    });

    expect(useEditorStore.getState().alignmentProposal?.anchors).toHaveLength(1);
    expect(useEditorStore.getState().status.message).toContain("时间轴预览");
  });

  it("阻止明显异常的对齐提案写入项目", () => {
    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [
        { id: "anchor", sourceMs: 10_000, targetMs: 20_000, confidence: 1, origin: "manual" }
      ],
      cutCandidates: [
        {
          id: "cut",
          name: "异常区间",
          sourceAtMs: 20_000,
          sourceRangeStartMs: 22_000,
          sourceRangeEndMs: 18_000,
          targetGapMs: 20_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: ["测试"]
    });

    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message:
        "对齐提案存在应用阻断：1 个候选版本差异的不确定区间起止顺序异常，请修正后再应用。",
      tone: "warning"
    });
  });

  it("阻止对齐提案使用当前项目已有 ID", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [
        {
          id: "anchor-existing",
          sourceMs: 1000,
          targetMs: 2000,
          confidence: 1,
          origin: "manual"
        }
      ],
      cutMarkers: [
        {
          id: "cut-existing",
          name: "已有版本差异",
          sourceAtMs: 3000,
          targetGapMs: 1200,
          note: ""
        }
      ]
    });

    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [
        {
          id: "anchor-existing",
          sourceMs: 4000,
          targetMs: 6000,
          confidence: 0.9,
          origin: "automatic"
        }
      ],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "冲突版本差异",
          sourceAtMs: 7000,
          targetGapMs: 2000,
          confidence: 0.9,
          note: ""
        }
      ],
      confidence: 0.9,
      diagnostics: ["测试"]
    });

    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message:
        "对齐提案存在应用阻断：1 个同步锚点 ID 已存在于当前项目（ID：anchor-existing），应用会丢失新锚点。",
      tone: "warning"
    });
  });

  it("应用对齐提案时跳过已经按时间落点的项目", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [
        {
          id: "anchor-existing",
          sourceMs: 10_000,
          targetMs: 20_000,
          confidence: 1,
          origin: "manual"
        }
      ],
      cutMarkers: [
        {
          id: "cut-existing",
          name: "已有版本差异",
          sourceAtMs: 30_000,
          targetGapMs: 12_000,
          note: ""
        }
      ]
    });

    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [
        {
          id: "anchor-duplicate-time",
          sourceMs: 10_000,
          targetMs: 20_000,
          confidence: 0.8,
          origin: "automatic"
        },
        {
          id: "anchor-new",
          sourceMs: 40_000,
          targetMs: 52_000,
          confidence: 0.8,
          origin: "automatic"
        }
      ],
      cutCandidates: [
        {
          id: "cut-duplicate-time",
          name: "重复时间版本差异",
          sourceAtMs: 30_000,
          targetGapMs: 12_000,
          confidence: 0.8,
          note: ""
        },
        {
          id: "cut-new",
          name: "新版本差异",
          sourceAtMs: 60_000,
          targetGapMs: 15_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: []
    });

    expect(useEditorStore.getState().project.syncAnchors.map((anchor) => anchor.id)).toEqual([
      "anchor-existing",
      "anchor-new"
    ]);
    expect(useEditorStore.getState().project.cutMarkers.map((marker) => marker.id)).toEqual([
      "cut-existing",
      "cut-new"
    ]);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(useEditorStore.getState().status).toEqual({
      message: "已应用对齐提案：新增 1 个同步线索，1 个版本差异。",
      tone: "success"
    });
  });

  it("对齐提案全部已落点时不写入历史", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [
        {
          id: "anchor-existing",
          sourceMs: 10_000,
          targetMs: 20_000,
          confidence: 1,
          origin: "manual"
        }
      ],
      cutMarkers: [
        {
          id: "cut-existing",
          name: "已有版本差异",
          sourceAtMs: 30_000,
          targetGapMs: 12_000,
          note: ""
        }
      ]
    });

    useEditorStore.getState().applyAlignmentProposalData({
      anchors: [
        {
          id: "anchor-existing",
          sourceMs: 10_000,
          targetMs: 20_000,
          confidence: 0.8,
          origin: "automatic"
        }
      ],
      cutCandidates: [
        {
          id: "cut-existing",
          name: "重复时间版本差异",
          sourceAtMs: 30_000,
          targetGapMs: 12_000,
          confidence: 0.8,
          note: ""
        }
      ],
      confidence: 0.8,
      diagnostics: []
    });

    expect(useEditorStore.getState().project.syncAnchors.map((anchor) => anchor.id)).toEqual([
      "anchor-existing"
    ]);
    expect(useEditorStore.getState().project.cutMarkers.map((marker) => marker.id)).toEqual([
      "cut-existing"
    ]);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().status).toEqual({
      message: "对齐提案没有新的可应用项。",
      tone: "neutral"
    });
  });

  it("更新和删除同步锚点", () => {
    resetStore({
      ...createEmptyProject(),
      syncAnchors: [
        { id: "anchor", sourceMs: 1000, targetMs: 2000, confidence: 1, origin: "manual" }
      ]
    });
    useEditorStore.setState({ selection: { kind: "anchor", ids: ["anchor"] } });

    useEditorStore.getState().updateSyncAnchor("anchor", { sourceMs: 1500, targetMs: 2600 });
    expect(useEditorStore.getState().project.syncAnchors[0]).toMatchObject({
      sourceMs: 1500,
      targetMs: 2600
    });

    useEditorStore.getState().deleteSyncAnchor("anchor");
    expect(useEditorStore.getState().project.syncAnchors).toHaveLength(0);
    expect(useEditorStore.getState().selection).toEqual({ kind: "none", ids: [] });
  });

  it("同一 projectEpoch 与 media signature 同步幂等，素材变化与新项目各换一代", () => {
    resetStore({
      ...createEmptyProject("音轨代际"),
      mediaLibrary: [
        createProjectMediaReference("media-a", "targetOriginal", {
          referenceKind: "localPath",
          localPath: "C:\\media\\a.mkv",
          objectUrl: null
        })
      ]
    });

    const first = useEditorStore.getState().synchronizeMediaInventory();
    const strictModeRepeat = useEditorStore.getState().synchronizeMediaInventory();
    expect(strictModeRepeat).toEqual(first);
    expect(useEditorStore.getState().mediaInventoryGeneration).toBe(1);

    useEditorStore.getState().importMediaPaths(["C:\\media\\b.mkv"], "targetOriginal");
    const imported = useEditorStore.getState().synchronizeMediaInventory();
    expect(imported.inventoryGeneration).toBe(2);

    useEditorStore.getState().newProject();
    const reopened = useEditorStore.getState().synchronizeMediaInventory();
    expect(reopened.projectEpoch).toBe(1);
    expect(reopened.inventoryGeneration).toBe(3);
  });

  it("只接受当前代际的探测时长，音轨推荐不改变选择或 history", () => {
    const media = createProjectMediaReference("media-a", "targetOriginal", {
      referenceKind: "localPath",
      localPath: "C:\\media\\a.mkv",
      objectUrl: null
    });
    resetStore({ ...createEmptyProject("推荐只读"), mediaLibrary: [{ ...media, durationMs: null }] });
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    const publication = readyPublication(generationKey, "media-a", 2);
    publication.changedRows = publication.changedRows.map((row) =>
      row.status === "ready" ? { ...row, durationMs: 2526176 } : row
    );

    useEditorStore.getState().applyMediaInventoryPublication(publication);

    expect(useEditorStore.getState().mediaInventoryRows["media-a"]).toMatchObject({
      status: "ready",
      recommendation: { state: "recommended", streamIndex: 2 }
    });
    expect(useEditorStore.getState().project.mediaLibrary[0].audioTrackIntent).toEqual({
      mode: "auto"
    });
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(useEditorStore.getState().project.mediaLibrary[0].durationMs).toBe(2526176);

    useEditorStore.getState().refreshMediaInventory();
    useEditorStore.getState().applyMediaInventoryPublication(publication);
    expect(useEditorStore.getState().mediaInventoryRows["media-a"]).toEqual({
      mediaId: "media-a",
      status: "unobserved"
    });
    expect(useEditorStore.getState().project.mediaLibrary[0].durationMs).toBe(2526176);
  });

  it("一次显式选择只形成一个 history，并可 undo/redo；revision 变化后进入需复核", () => {
    const media = createProjectMediaReference("media-a", "targetOriginal", {
      referenceKind: "localPath",
      localPath: "C:\\media\\a.mkv",
      objectUrl: null
    });
    resetStore({ ...createEmptyProject("显式音轨"), mediaLibrary: [media] });
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    useEditorStore
      .getState()
      .applyMediaInventoryPublication(readyPublication(generationKey, "media-a", null));

    expect(
      useEditorStore
        .getState()
        .setMediaAudioTrackIntent("media-a", { mode: "explicit", streamIndex: 2 })
    ).toBe(true);
    expect(useEditorStore.getState().project.mediaLibrary[0].audioTrackIntent).toEqual({
      mode: "explicit",
      streamIndex: 2,
      inventoryRevision: "inventory-v1:aaaaaaaaaaaaaaaa"
    });
    expect(useEditorStore.getState().history.past).toHaveLength(1);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.mediaLibrary[0].audioTrackIntent).toEqual({
      mode: "auto"
    });
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().project.mediaLibrary[0].audioTrackIntent.mode).toBe(
      "explicit"
    );

    useEditorStore.getState().applyMediaInventoryPublication({
      ...readyPublication(generationKey, "media-a", 1),
      changedRows: [
        {
          ...readyPublication(generationKey, "media-a", 1).changedRows[0],
          inventoryRevision: "inventory-v1:bbbbbbbbbbbbbbbb"
        }
      ]
    } as MediaInventoryPublication);
    expect(useEditorStore.getState().getMediaAudioTrackPreparation("media-a")).toMatchObject({
      state: "needsReview",
      reason: "inventoryRevisionChanged",
      finalStreamIndex: null
    });
    expect(useEditorStore.getState().history.past).toHaveLength(1);
  });

  it("用户取消先进入 cancelling 且不伪造行状态，只接受当前代权威 terminal", () => {
    const media = createProjectMediaReference("media-a", "targetOriginal", {
      referenceKind: "localPath",
      localPath: "C:\\media\\a.mkv",
      objectUrl: null
    });
    resetStore({ ...createEmptyProject("取消音轨准备"), mediaLibrary: [media] });
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    useEditorStore.getState().applyMediaInventoryPublication({
      generationKey,
      phase: "running",
      counts: { total: 1, queued: 0, probing: 1, ready: 0, failed: 0, cancelled: 0 },
      changedRows: [{ mediaId: "media-a", status: "probing" }],
      terminalMessage: null,
      restartRequired: false
    });

    useEditorStore.getState().cancelMediaInventory();

    expect(useEditorStore.getState()).toMatchObject({
      mediaInventoryPaused: true,
      mediaInventoryCancelling: true,
      mediaInventoryPhase: "running",
      mediaInventoryRows: { "media-a": { mediaId: "media-a", status: "probing" } }
    });

    useEditorStore.getState().applyMediaInventoryPublication({
      generationKey,
      phase: "cancelled",
      counts: { total: 1, queued: 0, probing: 0, ready: 0, failed: 0, cancelled: 1 },
      changedRows: [{ mediaId: "media-a", status: "cancelled" }],
      terminalMessage: null,
      restartRequired: false
    });

    expect(useEditorStore.getState()).toMatchObject({
      mediaInventoryPaused: true,
      mediaInventoryCancelling: false,
      mediaInventoryPhase: "cancelled",
      mediaInventoryRows: { "media-a": { mediaId: "media-a", status: "cancelled" } }
    });
  });

  it("cleanup restart-required 在 refresh、普通终态与新项目之间保持 session 级 sticky", () => {
    const media = createProjectMediaReference("media-a", "targetOriginal", {
      referenceKind: "localPath",
      localPath: "C:\\media\\a.mkv",
      objectUrl: null
    });
    resetStore({ ...createEmptyProject("清理状态不确定"), mediaLibrary: [media] });
    const generationKey = useEditorStore.getState().synchronizeMediaInventory();
    useEditorStore.getState().applyMediaInventoryPublication({
      generationKey,
      phase: "failed",
      counts: { total: 1, queued: 0, probing: 0, ready: 1, failed: 0, cancelled: 0 },
      changedRows: [readyPublication(generationKey, media.id, null).changedRows[0]],
      terminalMessage: "媒体清单进程清理状态不确定，需重启应用。",
      restartRequired: true
    });

    expect(useEditorStore.getState()).toMatchObject({
      mediaInventoryRestartRequired: true,
      mediaInventoryTerminalMessage: "媒体清单进程清理状态不确定，需重启应用。"
    });

    useEditorStore.getState().refreshMediaInventory();
    const refreshedKey = useEditorStore.getState().mediaInventoryGenerationKey!;
    useEditorStore.getState().applyMediaInventoryPublication({
      ...readyPublication(refreshedKey, media.id, null),
      restartRequired: false
    });
    useEditorStore.getState().newProject();

    expect(useEditorStore.getState()).toMatchObject({
      mediaInventoryRestartRequired: true,
      mediaInventoryTerminalMessage: "媒体清单进程清理状态不确定，需重启应用。"
    });
  });
});

function createNativeImportedFile(
  asset: DanmakuAsset,
  fileName: string,
  digestCharacter: string
): NativeXmlImportedFile {
  return {
    fileName,
    receipt: createTestXmlSourceReceipt(digestCharacter),
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
  };
}

function createShadowRiskReviewRecord(id: string): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id,
    timeMapId: "map-shadow-risk",
    timeMapRevision: 1,
    spanId: "span-shadow-risk",
    spanIndex: 0,
    sourceMediaId: "source-shadow-risk",
    targetMediaId: "target-shadow-risk",
    mediaGroupId: "group-shadow-risk",
    action: "classifySpan",
    decision: "unresolved",
    precision: "rough",
    algorithmPrediction: "ambiguous",
    sourceStartMs: 1_000,
    sourceEndMs: 11_000,
    targetStartMs: 2_000,
    targetEndMs: 12_000,
    boundaryToleranceMs: 500,
    features: {
      sourceCoverage: 0.8,
      uniqueContentCoverage: 0.7,
      anchorCount: 8,
      heldOutAnchorCount: 3,
      anchorRegionCount: 2,
      p95ResidualMs: 120,
      p99ResidualMs: 180,
      maxResidualMs: 220,
      boundaryUncertaintyMs: 800,
      alternativeMargin: 0.15,
      ambiguousRatio: 0.6,
      bidirectionalAgreement: null,
      differenceRiskP50: 0.5,
      differenceRiskP90: 0.75,
      differenceRiskP99: 0.9,
      informativenessP50: 0.5,
      visualRecoveredRatio: 0.2,
      visualAmbiguousRatio: 0.7,
      visualMarginP50: 0.1
    },
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-07-22T00:00:00.000Z"
  };
}

function createPersonalGoldVote(
  id: string,
  reviewerCharacter: string,
  boundaryToleranceMs: number
): AlignmentReviewVote {
  return {
    voteVersion: 1,
    id,
    reviewRecordId: "review:personal-gold",
    reviewerIdDigest: `sha256:${reviewerCharacter.repeat(64)}`,
    reviewSessionId: `session:${id}`,
    role: "independent",
    decision: "target-extra",
    boundaryToleranceMs,
    supersedesVoteId: null,
    voteState: "active",
    reviewedAt: `2026-08-30T1${reviewerCharacter === "a" ? "0" : "1"}:00:00.000Z`,
    reviewStartedAt: null,
    reviewDurationMs: null,
    reviewDurationBasis: null,
    shadowRiskSourceRunId: null,
    shadowRiskEvidenceDigest: null,
    shadowRiskAtReview: null
  };
}

function createTestXmlSourceReceipt(digestCharacter: string): DanmakuXmlSourceReceipt {
  return {
    domain: "danmaku-xml-content-receipt-v1",
    version: 1,
    receiptId: `xmlr-sha256:${digestCharacter.repeat(64)}`,
    contentDigest: `sha256:${digestCharacter.repeat(64)}`,
    sizeBytes: 256,
    parserVersion: "bilibili-xml-native-v1",
    inventoryDigest: `sha256:${digestCharacter.repeat(64)}`,
    issuerKeyId: `install-sha256:${digestCharacter.repeat(32)}`,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: digestCharacter.repeat(64)
  };
}

function createProjectMediaReference(
  id: string,
  role: ProjectMediaRole,
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role,
    name: overrides.name ?? (role === "bilibiliReference" ? "B 站参考素材" : "目标原片"),
    fileName:
      overrides.fileName ?? (role === "bilibiliReference" ? "reference.mp4" : "target.mp4"),
    objectUrl: "objectUrl" in overrides ? (overrides.objectUrl ?? null) : "blob:test",
    durationMs: "durationMs" in overrides ? (overrides.durationMs ?? null) : 120_000,
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

function readyPublication(
  generationKey: MediaInventoryPublication["generationKey"],
  mediaId: string,
  recommendedStreamIndex: number | null
): MediaInventoryPublication {
  return {
    generationKey,
    phase: "completed",
    counts: { total: 1, queued: 0, probing: 0, ready: 1, failed: 0, cancelled: 0 },
    changedRows: [
      {
        mediaId,
        status: "ready",
        inventoryRevision: "inventory-v1:aaaaaaaaaaaaaaaa",
        durationMs: 120_000,
        audioTracks: [1, 2].map((index) => ({
          index,
          codec: "aac",
          language: index === 1 ? "eng" : "jpn",
          title: index === 1 ? "Dub" : "Original",
          sampleRate: 48_000,
          channels: 2,
          channelLayout: "stereo",
          durationMs: 120_000,
          dispositions: {
            default: index === 1,
            original: index === 2,
            dub: index === 1,
            commentary: false,
            descriptions: false,
            visualImpaired: false,
            hearingImpaired: false,
            cleanEffects: false,
            karaoke: false
          },
          recommendationRank: index,
          reasonCodes: []
        })),
        recommendation:
          recommendedStreamIndex === null
            ? { state: "needsChoice", streamIndex: null, reasonCodes: ["equivalentCandidate"] }
            : {
                state: "recommended",
                streamIndex: recommendedStreamIndex,
                reasonCodes: ["originalDisposition"]
              },
        probeCompleteness: "complete",
        cacheState: "miss"
      }
    ],
    terminalMessage: null,
    restartRequired: false
  };
}

describe("B 站获取素材提交", () => {
  const page = {
    bvid: "BV1xx411c7mD",
    aid: 170001,
    cid: 1,
    page: 1,
    part: "第一部分",
    durationMs: 60_000,
    exactDuration: true,
    danmakuCount: 0,
    xmlPath: "C:/Bili/P1.xml",
    audioPath: "C:/Bili/P1.m4a"
  };
  const file = () => ({
    fileName: "P1.xml",
    receipt: createTestXmlSourceReceipt("a"),
    items: [],
    warnings: []
  });
  beforeEach(() => {
    resetStore();
    nativeXmlMocks.importPaths.mockReset();
  });
  it("XML、音轨和绑定只占一次撤销，重复结果不增加撤销", async () => {
    nativeXmlMocks.importPaths.mockResolvedValue([file()]);
    const state = useEditorStore.getState();
    const context = {
      projectId: state.project.id,
      projectEpoch: state.projectEpoch,
      projectName: state.project.name
    };
    await state.importBilibiliMaterials([page], context);
    const imported = useEditorStore.getState().project;
    expect(imported.assets).toHaveLength(1);
    expect(imported.mediaLibrary).toHaveLength(1);
    expect(imported.danmakuSourceBindings).toHaveLength(1);
    await useEditorStore.getState().importBilibiliMaterials([page], context);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.assets).toHaveLength(0);
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(0);
    useEditorStore.getState().redo();
    expect(useEditorStore.getState().project.assets[0].sourceReceipt).toEqual(file().receipt);
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(1);
  });
  it("原生 XML 验证期间切项目不会污染新项目", async () => {
    let complete!: (files: NativeXmlImportedFile[]) => void;
    nativeXmlMocks.importPaths.mockReturnValue(
      new Promise<NativeXmlImportedFile[]>((resolve) => {
        complete = resolve;
      })
    );
    const state = useEditorStore.getState();
    const pending = state.importBilibiliMaterials([page], {
      projectId: state.project.id,
      projectEpoch: state.projectEpoch,
      projectName: state.project.name
    });
    state.newProject();
    complete([file()]);
    expect(await pending).toBeNull();
    expect(useEditorStore.getState().project.assets).toHaveLength(0);
    expect(useEditorStore.getState().project.mediaLibrary).toHaveLength(0);
  });
});
