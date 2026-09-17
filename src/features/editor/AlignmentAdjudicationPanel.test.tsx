import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import type { AlignmentReviewRecord, EditorProject } from "../../domain/project/types";
import {
  createAlignmentShadowRiskOverlay,
  type AlignmentShadowRiskAssociationManifest
} from "../../domain/alignment/alignmentShadowRiskOverlay";
import { useEditorStore } from "../../stores/editorStore";
import { AlignmentAdjudicationPanel } from "./AlignmentAdjudicationPanel";
import { MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY } from "../../infrastructure/alignment/multimodalRuleSnapshotArchiveStore";
import { createRealAlignmentBlindReviewPackFixture } from "../../test/multimodalBlindReviewFixture";

const browserFileMocks = vi.hoisted(() => ({
  downloadTextFile: vi.fn()
}));
const tauriCoreMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(() => Promise.resolve(null))
}));
const alignmentEvidenceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  open: vi.fn(),
  build: vi.fn()
}));

vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual("@tauri-apps/api/core");
  return {
    ...actual,
    isTauri: tauriCoreMocks.isTauri,
    invoke: tauriCoreMocks.invoke
  };
});

vi.mock("../../infrastructure/alignment/tauriAudioAlignment", async () => {
  const actual = await vi.importActual("../../infrastructure/alignment/tauriAudioAlignment");
  return {
    ...actual,
    listAudioAlignmentSensitiveManifestSummaries: alignmentEvidenceMocks.list,
    openAudioAlignmentSensitiveManifestDirectory: alignmentEvidenceMocks.open,
    buildAudioAlignmentSensitiveBlindReviewPack: alignmentEvidenceMocks.build
  };
});

vi.mock("../../infrastructure/file-system/browserFiles", async () => {
  const actual = await vi.importActual("../../infrastructure/file-system/browserFiles");
  return { ...actual, downloadTextFile: browserFileMocks.downloadTextFile };
});

describe("独立复核队列离线音频风险", () => {
  beforeEach(() => {
    browserFileMocks.downloadTextFile.mockReset();
    tauriCoreMocks.isTauri.mockReset();
    tauriCoreMocks.isTauri.mockReturnValue(false);
    tauriCoreMocks.invoke.mockReset();
    tauriCoreMocks.invoke.mockResolvedValue(null);
    alignmentEvidenceMocks.list.mockReset();
    alignmentEvidenceMocks.open.mockReset();
    alignmentEvidenceMocks.build.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("没有人工记录时也展示跨重启保存的真实运行证据库存", async () => {
    const user = userEvent.setup();
    tauriCoreMocks.isTauri.mockReturnValue(true);
    alignmentEvidenceMocks.list.mockResolvedValue([
      {
        runId: "audio-align-batch-ready",
        manifestPayloadDigest: `sha256:${"a".repeat(64)}`,
        manifestCanonicalPayloadDigest: `sha256:${"b".repeat(64)}`,
        lifecycleStage: "terminal",
        createdAtMs: 100,
        updatedAtMs: 200,
        appVersion: "0.1.0",
        engineVersion: "alignment-v2-test",
        featureVersion: "feature-test",
        status: "completed",
        sourceMediaCount: 1,
        targetMediaCount: 1,
        pairCount: 1,
        processedPairCount: 1,
        completedPairCount: 1,
        failedPairCount: 0,
        cancelledPairCount: 0,
        preparedMediaCount: 2,
        identifiedMediaCount: 2,
        audioCandidateCount: 2,
        landmarkArtifactCount: 2,
        landmarkCacheHitCount: 2,
        evidenceSpanCount: 4,
        uncertainSpanCount: 2,
        visualEvidencePairCount: 1,
        visualEvidenceRequested: true,
        evidenceGroupKey: `sha256:${"b".repeat(64)}`,
        intakeState: "ready",
        readyForTrainingIntake: true,
        reviewCandidatePairs: [
          {
            pairOrdinal: 1,
            sourceMediaIdDigest: `sha256:${"c".repeat(64)}`,
            targetMediaIdDigest: `sha256:${"d".repeat(64)}`,
            riskyTaskCount: 1,
            tasks: [
              {
                queryKey: `sha256:${"e".repeat(64)}`,
                sourceTimestampMs: 10_000,
                sourcePreviewStartMs: 5_000,
                sourcePreviewEndMs: 15_000,
                targetReviewStartMs: 4_000,
                targetReviewEndMs: 20_000,
                candidateTimestampsMs: [11_500, 12_000],
                category: "evidence-conflict",
                riskScoreMicros: 900_000
              }
            ]
          }
        ],
        notes: ["可进入真实证据整理。"]
      }
    ]);
    alignmentEvidenceMocks.open.mockResolvedValue(undefined);
    alignmentEvidenceMocks.build.mockResolvedValue(
      JSON.stringify(createRealAlignmentBlindReviewPackFixture())
    );
    const project = createEmptyProject("真实验证库存");

    render(<AlignmentAdjudicationPanel project={project} />);

    const summary = await screen.findByText("真实验证数据 · 1 次运行可整理");
    await user.click(summary);
    expect(screen.getByText(/1 个完成关系、2 个疑点段/)).toBeInTheDocument();
    expect(screen.getByText(/运行组只是内容身份去重结果/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开证据目录" }));
    expect(alignmentEvidenceMocks.open).toHaveBeenCalledTimes(1);
    await user.type(
      screen.getByPlaceholderText(/同一季度的不同版本请填写相同名称/),
      "Dark 第三季"
    );
    await user.click(screen.getByRole("button", { name: "打开盲复核" }));
    expect(alignmentEvidenceMocks.build).toHaveBeenCalledWith(
      "audio-align-batch-ready",
      1,
      "Dark 第三季"
    );
    expect(await screen.findByText(/已导入 1 个盲复核任务/)).toBeInTheDocument();
  });

  it("加载项目绑定风险后显示原因、提高队列顺序并可无损移除", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    resetProject(project);
    const riskyRecord = project.alignmentReviewRecords[1];
    const overlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"a".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [
        {
          recordId: riskyRecord.id,
          risk: 0.95,
          reasonCodes: ["audio-shadow-risk", "weak-local-audio-support"]
        }
      ]
    });
    render(<StoreBackedPanel />);

    await user.upload(
      screen.getByLabelText("加载音频风险"),
      new File([JSON.stringify(overlay)], "risk.json", { type: "application/json" })
    );

    expect(await screen.findByText(/离线音频风险已关联 1 条记录/)).toBeInTheDocument();
    expect(screen.getByText("音频风险 95.0%")).toHaveAttribute(
      "title",
      expect.stringContaining("规则位置附近的音频支持较弱")
    );
    expect(screen.getAllByText(/^片段 \d+$/)[0]).toHaveTextContent("片段 2");
    expect(useEditorStore.getState().project.mediaTimeMaps).toEqual(project.mediaTimeMaps);

    await user.click(screen.getByRole("button", { name: "移除音频风险" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.alignmentShadowRiskOverlay).toBeNull()
    );
    expect(screen.queryByText("音频风险 95.0%")).not.toBeInTheDocument();
    expect(useEditorStore.getState().project.mediaTimeMaps).toEqual(project.mediaTimeMaps);
  });

  it("导出的关联清单不含项目名、媒体路径、人工决定或原始项目 ID", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    project.id = "private/project:id";
    project.name = "私人测试项目";
    resetProject(project);
    render(<StoreBackedPanel />);

    await user.click(screen.getByRole("button", { name: "导出关联清单" }));

    expect(browserFileMocks.downloadTextFile).toHaveBeenCalledTimes(1);
    const [fileName, content] = browserFileMocks.downloadTextFile.mock.calls[0] as [string, string];
    expect(fileName).toMatch(/^danmaku-shadow-risk-association-[0-9a-f]{16}\.json$/);
    expect(fileName).not.toContain(project.id);
    expect(content).not.toContain(project.id);
    expect(content).not.toContain(project.name);
    expect(content).not.toContain("source-extra");
    expect(content).not.toContain("path");
    const manifest = JSON.parse(content) as AlignmentShadowRiskAssociationManifest;
    expect(manifest.records).toHaveLength(2);
    expect(Object.keys(manifest.records[0]).sort()).toEqual([
      "recordEvidenceDigest",
      "recordId"
    ]);
  });

  it("明确确认后同时导出无路径关联清单和仅限本机的含路径算分计划", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    resetProject(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StoreBackedPanel />);

    await user.click(screen.getByRole("button", { name: "导出本机算分包" }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("包含完整媒体路径"));
    expect(browserFileMocks.downloadTextFile).toHaveBeenCalledTimes(2);
    const associationContent = browserFileMocks.downloadTextFile.mock.calls[0][1] as string;
    const [planName, planContent] = browserFileMocks.downloadTextFile.mock.calls[1] as [
      string,
      string
    ];
    expect(associationContent).not.toContain("C:\\private-media");
    expect(planName).toMatch(/^danmaku-shadow-risk-local-plan-[0-9a-f]{16}\.json$/);
    expect(planContent).toContain("C:\\\\private-media\\\\source.wav");
    expect(planContent).toContain('"containsSensitiveLocalPaths": true');
    expect(planContent).not.toContain('"decision"');
  });

  it("明确确认后导出不含路径但绑定完整媒体摘要的视觉对照规则", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    resetProject(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StoreBackedPanel />);

    await user.click(screen.getByRole("button", { name: "下载当前视觉对照规则" }));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("完整媒体 SHA-256"));
    await waitFor(() => expect(browserFileMocks.downloadTextFile).toHaveBeenCalledTimes(1));
    const [fileName, content] = browserFileMocks.downloadTextFile.mock.calls[0] as [
      string,
      string
    ];
    expect(fileName).toMatch(/^danmaku-multimodal-rule-snapshot-[0-9a-f]{16}\.json$/);
    expect(content).toContain('"schemaVersion": "alignment-multimodal-rule-snapshot-v1"');
    expect(content).toContain(`sha256:${"a".repeat(64)}`);
    expect(content).not.toContain("C:\\private-media");
    expect(content).not.toContain("source-risk");
    expect(content).not.toContain('"decision"');
    expect(await screen.findByText(/本机已自动保留 1 份生产规则快照/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下载最近快照" }));
    expect(browserFileMocks.downloadTextFile).toHaveBeenCalledTimes(2);
    expect(browserFileMocks.downloadTextFile.mock.calls[1]).toEqual(
      browserFileMocks.downloadTextFile.mock.calls[0]
    );

    cleanup();
    render(<StoreBackedPanel />);
    expect(await screen.findByText(/本机已自动保留 1 份生产规则快照/)).toBeInTheDocument();
  });

  it("自动保存合格生产规则，即使当前没有独立复核记录", async () => {
    const project = createReviewProject();
    project.alignmentReviewRecords = [];
    resetProject(project);

    const { container } = render(<StoreBackedPanel />);

    expect(container).toBeEmptyDOMElement();
    await waitFor(() =>
      expect(localStorage.getItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY)).toContain(
        "alignment-multimodal-rule-snapshot-v1"
      )
    );
    expect(browserFileMocks.downloadTextFile).not.toHaveBeenCalled();
  });

  it("清空自动档案后不会立刻重建相同规则", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    resetProject(project);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<StoreBackedPanel />);

    expect(await screen.findByText(/本机已自动保留 1 份生产规则快照/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清空快照档案" }));

    await waitFor(() =>
      expect(localStorage.getItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY)).toBeNull()
    );
    expect(await screen.findByText(/当前规则不会立即重建/)).toBeInTheDocument();
  });

  it("记录变化后保留覆盖层审计信息但停止使用旧风险", async () => {
    const project = createReviewProject();
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"b".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [
        {
          recordId: project.alignmentReviewRecords[0].id,
          risk: 0.9,
          reasonCodes: ["audio-shadow-risk"]
        }
      ]
    });
    project.alignmentReviewRecords[0] = {
      ...project.alignmentReviewRecords[0],
      targetEndMs: project.alignmentReviewRecords[0].targetEndMs + 1
    };
    resetProject(project);
    render(<StoreBackedPanel />);

    expect(await screen.findByText(/本机已自动保留 1 份生产规则快照/)).toBeInTheDocument();
    expect(screen.getByText(/已关联 0 条记录，1 条因记录变化已失效/)).toBeInTheDocument();
    expect(screen.queryByText(/音频风险 90.0%/)).not.toBeInTheDocument();
  });

  it("用户首次操作复核表单后自动保存近似耗时和当时风险，不增加额外点击", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"d".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [{
        recordId: project.alignmentReviewRecords[0].id,
        risk: 0.73,
        reasonCodes: ["audio-shadow-risk"]
      }]
    });
    resetProject(project);
    render(<StoreBackedPanel />);

    await user.type(screen.getByLabelText(/本次复核者代号/), "reviewer-a");
    await user.selectOptions(screen.getAllByLabelText("本次独立判断")[0], "target-extra");
    await user.click(screen.getAllByRole("button", { name: "提交独立复核" })[0]);

    const vote = useEditorStore.getState().project.alignmentReviewVotes[0];
    expect(vote.reviewDurationBasis).toBe("first-form-interaction-to-submit-v1");
    expect(typeof vote.reviewDurationMs).toBe("number");
    expect(vote.shadowRiskSourceRunId).toBe(`sha256:${"d".repeat(64)}`);
    expect(vote.shadowRiskAtReview).toBe(0.73);
    expect(screen.getByText(/已自动记录 1\/1 次表单复核耗时/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "导出复核耗时收据" }));
    const [fileName, content] = browserFileMocks.downloadTextFile.mock.calls.at(-1) as [
      string,
      string
    ];
    expect(fileName).toMatch(/^danmaku-review-efficiency-[0-9a-f]{16}\.json$/);
    expect(content).toContain('"permission": "review-efficiency-measurement-only"');
    expect(content).not.toContain("reviewer-a");
    expect(content).not.toContain("target-extra");
    expect(content).not.toContain("C:\\private-media");
  });

  it("导出无路径复核效果收据，并明确弱复核不能宣称准确率", async () => {
    const user = userEvent.setup();
    const project = createReviewProject();
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"c".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: project.alignmentReviewRecords.map((record, index) => ({
        recordId: record.id,
        risk: index === 0 ? 0.9 : 0.2,
        reasonCodes: ["audio-shadow-risk"]
      }))
    });
    resetProject(project);
    render(<StoreBackedPanel />);

    expect(screen.getByText(/它们只用于选样，不能计算准确率/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出复核效果收据" }));

    expect(browserFileMocks.downloadTextFile).toHaveBeenCalledTimes(1);
    const [fileName, content] = browserFileMocks.downloadTextFile.mock.calls[0] as [string, string];
    expect(fileName).toMatch(/^danmaku-shadow-risk-evaluation-[0-9a-f]{16}\.json$/);
    expect(content).toContain('"permission": "shadow-evaluation-only"');
    expect(content).toContain('"accuracyClaimReady": false');
    expect(content).not.toContain("C:\\private-media");
    expect(content).not.toContain("review:low");
    expect(content).not.toContain("review:high");
  });
});

function StoreBackedPanel() {
  const project = useEditorStore((state) => state.project);
  return <AlignmentAdjudicationPanel project={project} />;
}

function resetProject(project: EditorProject): void {
  useEditorStore.setState({
    project,
    history: createHistoryState(),
    status: { message: "准备就绪", tone: "neutral" }
  });
}

function createReviewProject(): EditorProject {
  const project = createEmptyProject("离线风险复核");
  project.alignmentReviewRecords = [
    createReviewRecord("review:low", 0),
    createReviewRecord("review:high", 1)
  ];
  project.mediaLibrary = [
    {
      id: "source-risk",
      role: "bilibiliReference",
      name: "source",
      fileName: "source.wav",
      objectUrl: null,
      durationMs: 60_000,
      contentIdentity: createIdentity("a"),
      referenceKind: "localPath",
      connectionState: "connected",
      sourceSummary: "local",
      localPath: "C:\\private-media\\source.wav",
      emby: null,
      episodeKey: null,
      episodeLabel: null,
      audioTrackIntent: { mode: "auto" },
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z"
    },
    {
      id: "target-risk",
      role: "targetOriginal",
      name: "target",
      fileName: "target.wav",
      objectUrl: null,
      durationMs: 60_000,
      contentIdentity: createIdentity("b"),
      referenceKind: "localPath",
      connectionState: "connected",
      sourceSummary: "local",
      localPath: "C:\\private-media\\target.wav",
      emby: null,
      episodeKey: null,
      episodeLabel: null,
      audioTrackIntent: { mode: "auto" },
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z"
    }
  ];
  project.mediaTimeMaps = [{
    id: "map-risk",
    revision: 1,
    sourceMediaId: "source-risk",
    targetMediaId: "target-risk",
    sourceStream: createAudioStream(1),
    targetStream: createAudioStream(1),
    sourceIdentity: createIdentity("a"),
    targetIdentity: createIdentity("b"),
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      { id: "span-risk-0", kind: "matched", sourceStartMs: 0, sourceEndMs: 20_000, targetStartMs: 0, targetEndMs: 20_000 },
      { id: "span-risk-1", kind: "matched", sourceStartMs: 20_000, sourceEndMs: 40_000, targetStartMs: 20_000, targetEndMs: 40_000 }
    ],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 50,
      p95ResidualMs: 100,
      maxResidualMs: 150,
      boundaryUncertaintyMs: 200,
      alternativeMargin: 0.2,
      anchorCount: 8,
      heldOutAnchorCount: 3,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 8,
      visualAnchorCount: 0,
      heldOutAnchorCount: 3,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    state: "confirmed",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    confirmedAt: "2026-07-22T00:00:00.000Z"
  }];
  return project;
}

function createIdentity(digit: string) {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: digit.repeat(64),
    lastSampleDigest: digit.repeat(64)
  };
}

function createAudioStream(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "pcm_s16le",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 1,
    frameRate: null,
    language: null,
    title: null
  };
}

function createReviewRecord(id: string, spanIndex: number): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id,
    timeMapId: "map-risk",
    timeMapRevision: 1,
    spanId: `span-risk-${spanIndex}`,
    spanIndex,
    sourceMediaId: "source-risk",
    targetMediaId: "target-risk",
    mediaGroupId: "group-risk",
    action: "classifySpan",
    decision: "unresolved",
    precision: "rough",
    algorithmPrediction: "ambiguous",
    sourceStartMs: spanIndex * 20_000,
    sourceEndMs: spanIndex * 20_000 + 10_000,
    targetStartMs: spanIndex * 20_000,
    targetEndMs: spanIndex * 20_000 + 10_000,
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
      alternativeMargin: 0.4,
      ambiguousRatio: 0.2,
      bidirectionalAgreement: null,
      differenceRiskP50: 0.2,
      differenceRiskP90: 0.2,
      differenceRiskP99: 0.3,
      informativenessP50: 0.5,
      visualRecoveredRatio: 0.2,
      visualAmbiguousRatio: 0.2,
      visualMarginP50: 0.4
    },
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-07-22T00:00:00.000Z"
  };
}
