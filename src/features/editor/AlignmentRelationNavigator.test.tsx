import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAlignmentExperimentQueue,
  type AlignmentExperimentPairState,
  type AlignmentExperimentQueue
} from "../../domain/alignment/alignmentExperimentQueue";
import type { AlignmentProposal } from "../../domain/alignment/types";
import { createEmptyProject } from "../../domain/project/factory";
import type {
  EditorProject,
  MediaMatchCandidate,
  MediaTimeMap,
  MediaTimeMapQualityLevel,
  ProjectMediaReference,
  ProjectMediaRole
} from "../../domain/project/types";
import { useEditorStore } from "../../stores/editorStore";
import { AlignmentRelationNavigator } from "./AlignmentRelationNavigator";

const queueMocks = vi.hoisted(() => ({
  load: vi.fn(),
  hydrate: vi.fn()
}));

vi.mock("../../infrastructure/alignment/alignmentExperimentQueueStore", () => ({
  loadAlignmentExperimentQueue: queueMocks.load,
  hydrateDesktopAlignmentExperimentQueue: queueMocks.hydrate
}));

describe("AlignmentRelationNavigator", () => {
  beforeEach(() => {
    queueMocks.load.mockReturnValue(null);
    queueMocks.hydrate.mockReturnValue(new Promise(() => undefined));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("把阻断、低可信和待裁决关系按异常优先顺序汇总，并默认折叠已验证关系", () => {
    const project = createReviewProject();
    resetStore(project);

    render(<AlignmentRelationNavigator />);

    expect(screen.getByText("3 项需要复核")).toBeInTheDocument();
    const blockedHeading = screen.getByRole("heading", { name: "阻断项 1" });
    const lowHeading = screen.getByRole("heading", { name: "低可信 1" });
    const pendingHeading = screen.getByRole("heading", { name: "待人工裁决 1" });
    expect(blockedHeading.compareDocumentPosition(lowHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(lowHeading.compareDocumentPosition(pendingHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(screen.getByTitle(/独立留出证据不足，不能确认。/)).toBeInTheDocument();
    expect(screen.getByTitle(/有 2 个低可信区段需要复核。/)).toBeInTheDocument();

    const pendingRelation = within(screen.getByRole("list", { name: "异常优先复核队列" }))
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("待裁决原片"));
    expect(pendingRelation).toBeDefined();
    expect(
      within(pendingRelation as HTMLElement).getByRole("button", {
        name: /等待人工裁决.*待裁决原片.*打开这条关系/
      })
    ).toBeInTheDocument();

    const completed = screen.getByText("已完成并验证 1").closest("details");
    expect(completed).not.toBeNull();
    expect(completed).not.toHaveAttribute("open");
    expect(within(completed as HTMLElement).getByText("已验证原片")).toBeInTheDocument();
  });

  it("把已接受但仍被质量门阻断的关系放在普通阻断项之前", () => {
    const project = createEmptyProject("已接受异常");
    project.mediaLibrary = [
      createMedia("source-regular", "bilibiliReference", "普通阻断参考"),
      createMedia("target-regular", "targetOriginal", "普通阻断原片"),
      createMedia("source-accepted-blocked", "bilibiliReference", "阻断已接受参考"),
      createMedia("target-accepted-blocked", "targetOriginal", "阻断已接受原片"),
      createMedia("source-accepted-review", "bilibiliReference", "复核已接受参考"),
      createMedia("target-accepted-review", "targetOriginal", "复核已接受原片")
    ];
    project.mediaMatchCandidates = [
      createCandidate(
        "candidate-regular",
        "source-regular",
        "target-regular",
        "blocked",
        createProposal(null, [], 0)
      ),
      {
        ...createCandidate(
          "candidate-accepted-review",
          "source-accepted-review",
          "target-accepted-review",
          "accepted",
          createProposal("review", ["候选边界仍需人工复核。"], 0)
        ),
        confirmedTimeMapId: "map-accepted-review"
      },
      {
        ...createCandidate(
          "candidate-accepted-blocked",
          "source-accepted-blocked",
          "target-accepted-blocked",
          "accepted",
          createProposal("blocked", ["确认图缺少独立留出证据。"], 0)
        ),
        confirmedTimeMapId: "map-accepted-blocked"
      }
    ];
    project.mediaTimeMaps = [
      createTimeMap(
        "map-accepted-review",
        "source-accepted-review",
        "target-accepted-review",
        "review",
        ["候选边界仍需人工复核。"]
      ),
      createTimeMap(
        "map-accepted-blocked",
        "source-accepted-blocked",
        "target-accepted-blocked",
        "blocked",
        ["确认图缺少独立留出证据。"]
      )
    ];
    resetStore(project);

    render(<AlignmentRelationNavigator />);

    const acceptedBlocked = screen.getByRole("button", {
      name: /已接受，但仍被质量门阻断.*阻断已接受原片/
    });
    const regularBlocked = screen.getByRole("button", {
      name: /阻断后续流程.*普通阻断原片/
    });
    expect(acceptedBlocked.compareDocumentPosition(regularBlocked)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(screen.getByTitle(/确认图缺少独立留出证据。/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "低可信 1" })).toBeInTheDocument();
    expect(screen.getByTitle(/候选边界仍需人工复核。/)).toBeInTheDocument();
  });

  it("恢复持久任务时去重候选，隐藏拒绝与运行行，并只汇总真实终态异常", () => {
    const project = createEmptyProject("持久任务复核");
    const pairs = [
      ["source-failed", "target-failed", "failed"],
      ["source-not-found", "target-not-found", "notFound"],
      ["source-review", "target-review", "reviewCandidate"],
      ["source-running", "target-running", "running"],
      ["source-rejected", "target-rejected", "failed"]
    ] as const;
    project.mediaLibrary = pairs.flatMap(([sourceId, targetId]) => [
      createMedia(sourceId, "bilibiliReference", `${sourceId} 参考`),
      createMedia(targetId, "targetOriginal", `${targetId} 原片`)
    ]);
    project.mediaMatchCandidates = [
      createCandidate(
        "candidate-review",
        "source-review",
        "target-review",
        "pending",
        createProposal(null, [], 0)
      ),
      createCandidate(
        "candidate-rejected",
        "source-rejected",
        "target-rejected",
        "rejected",
        createProposal(null, [], 0)
      )
    ];
    queueMocks.load.mockReturnValue(
      createQueue(
        project.id,
        pairs.map(([sourceMediaId, targetMediaId, state]) => ({
          sourceMediaId,
          targetMediaId,
          state
        }))
      )
    );
    resetStore(project);

    render(<AlignmentRelationNavigator />);

    expect(screen.getByRole("heading", { name: "阻断项 2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "待人工裁决 1" })).toBeInTheDocument();
    expect(screen.getAllByText("target-review 原片")).toHaveLength(1);
    expect(screen.getByTitle(/上次尝试失败，可单独重试/)).toBeInTheDocument();
    expect(screen.getByTitle(/计算完成，但没有可用候选/)).toBeInTheDocument();
    expect(screen.getByText("1 项分析中")).toBeInTheDocument();
    expect(screen.queryByText("target-running 原片")).not.toBeInTheDocument();
    expect(screen.queryByText("target-rejected 原片")).not.toBeInTheDocument();
  });

  it("把等待与运行任务只按唯一关系计入进行中，并保留同关系候选的复核信息", () => {
    const project = createEmptyProject("进行中关系");
    const pairs = [
      ["source-waiting", "target-waiting", "pending"],
      ["source-running", "target-running", "running"],
      ["source-candidate", "target-candidate", "pending"]
    ] as const;
    project.mediaLibrary = pairs.flatMap(([sourceId, targetId]) => [
      createMedia(sourceId, "bilibiliReference", `${sourceId} 参考`),
      createMedia(targetId, "targetOriginal", `${targetId} 原片`)
    ]);
    project.mediaMatchCandidates = [
      createCandidate(
        "candidate-in-progress",
        "source-candidate",
        "target-candidate",
        "pending",
        createProposal(null, [], 0)
      )
    ];
    queueMocks.load.mockReturnValue(
      createQueue(
        project.id,
        pairs.map(([sourceMediaId, targetMediaId, state]) => ({
          sourceMediaId,
          targetMediaId,
          state
        }))
      )
    );
    resetStore(project);

    render(<AlignmentRelationNavigator />);

    expect(screen.getByText("1 项需要复核")).toBeInTheDocument();
    expect(screen.getByText("3 项分析中")).toBeInTheDocument();
    expect(screen.queryByText("target-waiting 原片")).not.toBeInTheDocument();
    expect(screen.queryByText("target-running 原片")).not.toBeInTheDocument();
    expect(screen.getAllByText("target-candidate 原片")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: /等待人工裁决.*target-candidate 原片.*打开这条关系/
      })
    ).toBeInTheDocument();
  });

  it("用键盘打开候选时只发布统一意图并保留当前行焦点", async () => {
    const user = userEvent.setup();
    const project = createEmptyProject("键盘复核");
    project.mediaLibrary = [
      createMedia("source-keyboard", "bilibiliReference", "键盘参考"),
      createMedia("target-keyboard", "targetOriginal", "键盘原片")
    ];
    project.mediaMatchCandidates = [
      createCandidate(
        "candidate-keyboard",
        "source-keyboard",
        "target-keyboard",
        "pending",
        createProposal(null, [], 0)
      )
    ];
    resetStore(project);
    render(<AlignmentRelationNavigator />);
    const candidateButton = screen.getByRole("button", {
      name: /等待人工裁决.*键盘原片.*打开这条关系/
    });

    candidateButton.focus();
    await user.keyboard("{Enter}");

    expect(useEditorStore.getState().alignmentEditorCandidateId).toBeNull();
    expect(useEditorStore.getState().workspaceIntentRequest).toEqual({
      sequence: 1,
      intent: {
        page: "editing",
        target: { kind: "candidate", candidateId: "candidate-keyboard" }
      }
    });
    expect(candidateButton).toHaveFocus();
    expect(candidateButton).toHaveAttribute("aria-pressed", "false");
  });

  it("异常队列只保留一个 Tab 行，并用方向键移动、Home/End 与 Escape 返回上级", async () => {
    const user = userEvent.setup();
    resetStore(createReviewProject());
    render(<AlignmentRelationNavigator />);

    const queue = screen.getByRole("list", { name: "异常优先复核队列" });
    const rows = within(queue)
      .getAllByRole("button")
      .filter((button) => !button.closest("details"));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    rows[0].focus();
    await user.keyboard("{ArrowDown}{End}");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(rows[0]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "返回智能匹配" })).toHaveFocus();
  });

  it("任务尚未形成候选时只通过键盘返回匹配继续处理", async () => {
    const user = userEvent.setup();
    const project = createEmptyProject("返回匹配");
    project.mediaLibrary = [
      createMedia("source-task", "bilibiliReference", "任务参考"),
      createMedia("target-task", "targetOriginal", "任务原片")
    ];
    queueMocks.load.mockReturnValue(
      createQueue(project.id, [
        {
          sourceMediaId: "source-task",
          targetMediaId: "target-task",
          state: "reviewCandidate"
        }
      ])
    );
    resetStore(project);
    render(<AlignmentRelationNavigator />);
    const taskButton = screen.getByRole("button", {
      name: /任务原片.*返回匹配处理/
    });

    taskButton.focus();
    await user.keyboard("{Enter}");

    expect(useEditorStore.getState().workspacePage).toBe("matching");
    expect(useEditorStore.getState().alignmentEditorCandidateId).toBeNull();
  });

  it("桌面队列刷新同一 pair 的分组时不替换已聚焦的操作行", async () => {
    const project = createEmptyProject("刷新焦点");
    project.mediaLibrary = [
      createMedia("source-refresh", "bilibiliReference", "刷新参考"),
      createMedia("target-refresh", "targetOriginal", "刷新原片")
    ];
    const localQueue = createQueue(project.id, [
      {
        sourceMediaId: "source-refresh",
        targetMediaId: "target-refresh",
        state: "reviewCandidate"
      }
    ]);
    const desktopQueue = createQueue(project.id, [
      {
        sourceMediaId: "source-refresh",
        targetMediaId: "target-refresh",
        state: "failed"
      }
    ]);
    const hydration = deferred<AlignmentExperimentQueue | null>();
    queueMocks.load.mockReturnValue(localQueue);
    queueMocks.hydrate.mockReturnValue(hydration.promise);
    resetStore(project);
    render(<AlignmentRelationNavigator />);
    const row = screen.getByRole("button", {
      name: /等待在匹配页继续处理.*刷新原片/
    });
    row.focus();

    await act(async () => {
      hydration.resolve(desktopQueue);
      await hydration.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("匹配结果阻断后续流程")).toBeInTheDocument();
    });
    expect(row).toHaveFocus();
    expect(screen.getByRole("button", { name: /匹配结果阻断后续流程.*刷新原片/ })).toBe(row);
  });

  it("项目切换后忽略上一个项目迟到的桌面队列", async () => {
    const firstProject = createEmptyProject("旧项目");
    firstProject.mediaLibrary = [
      createMedia("source-old", "bilibiliReference", "旧项目参考"),
      createMedia("target-old", "targetOriginal", "旧项目原片")
    ];
    const nextProject = createEmptyProject("新项目");
    const staleHydration = deferred<AlignmentExperimentQueue | null>();
    const oldQueue = createQueue(firstProject.id, [
      {
        sourceMediaId: "source-old",
        targetMediaId: "target-old",
        state: "reviewCandidate"
      }
    ]);
    queueMocks.load.mockImplementation((projectId: string) =>
      projectId === firstProject.id ? oldQueue : null
    );
    queueMocks.hydrate.mockImplementation((projectId: string) =>
      projectId === firstProject.id ? staleHydration.promise : new Promise(() => undefined)
    );
    resetStore(firstProject);
    render(<AlignmentRelationNavigator />);
    expect(screen.getByText("旧项目原片")).toBeInTheDocument();

    act(() => {
      useEditorStore.setState({ project: nextProject });
    });
    await waitFor(() => {
      expect(screen.getByText(/还没有可复核的关系/)).toBeInTheDocument();
    });
    await act(async () => {
      staleHydration.resolve(
        createQueue(firstProject.id, [
          {
            sourceMediaId: "source-old",
            targetMediaId: "target-old",
            state: "failed"
          }
        ])
      );
      await staleHydration.promise;
    });

    expect(screen.queryByText("旧项目原片")).not.toBeInTheDocument();
    expect(screen.getByText(/还没有可复核的关系/)).toBeInTheDocument();
  });

  it("空项目只提供真实的匹配入口，不制造可编辑关系", () => {
    resetStore(createEmptyProject("空项目"));

    render(<AlignmentRelationNavigator />);

    expect(screen.getByText("尚无复核结果")).toBeInTheDocument();
    expect(screen.getByText(/还没有可复核的关系/)).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "返回智能匹配" })).toBeInTheDocument();
  });
});

function resetStore(project: EditorProject): void {
  useEditorStore.setState({
    project,
    workspacePage: "editing",
    workspaceIntentSequence: 0,
    workspaceIntentRequest: null,
    alignmentEditorCandidateId: null
  });
}

function createReviewProject(): EditorProject {
  const project = createEmptyProject("异常优先复核");
  project.mediaLibrary = [
    createMedia("source-blocked", "bilibiliReference", "阻断参考"),
    createMedia("target-blocked", "targetOriginal", "阻断原片"),
    createMedia("source-low", "bilibiliReference", "低可信参考"),
    createMedia("target-low", "targetOriginal", "低可信原片"),
    createMedia("source-pending", "bilibiliReference", "待裁决参考"),
    createMedia("target-pending", "targetOriginal", "待裁决原片"),
    createMedia("source-verified", "bilibiliReference", "已验证参考"),
    createMedia("target-verified", "targetOriginal", "已验证原片")
  ];
  project.mediaMatchCandidates = [
    createCandidate(
      "candidate-blocked",
      "source-blocked",
      "target-blocked",
      "blocked",
      createProposal("blocked", ["独立留出证据不足，不能确认。"], 0)
    ),
    createCandidate(
      "candidate-low",
      "source-low",
      "target-low",
      "pending",
      createProposal("review", ["局部证据需要人工复核。"], 2)
    ),
    createCandidate(
      "candidate-pending",
      "source-pending",
      "target-pending",
      "pending",
      createProposal(null, [], 0)
    ),
    {
      ...createCandidate(
        "candidate-verified",
        "source-verified",
        "target-verified",
        "accepted",
        createProposal("verified", ["独立证据已验证。"], 0)
      ),
      confirmedTimeMapId: "map-verified"
    }
  ];
  project.mediaTimeMaps = [
    createTimeMap("map-verified", "source-verified", "target-verified", "verified", [
      "独立证据已验证。"
    ])
  ];
  return project;
}

function createMedia(id: string, role: ProjectMediaRole, name: string): ProjectMediaReference {
  return {
    id,
    role,
    name,
    fileName: `${id}.mkv`,
    objectUrl: null,
    durationMs: 60_000,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "测试素材",
    localPath: `C:\\media\\${id}.mkv`,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  };
}

function createCandidate(
  id: string,
  sourceMediaId: string,
  targetMediaId: string,
  state: MediaMatchCandidate["state"],
  proposal: AlignmentProposal
): MediaMatchCandidate {
  return {
    id,
    batchId: "batch-review",
    sourceMediaId,
    targetMediaId,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    timingRules: [],
    confidence: proposal.confidence,
    proposal,
    timeMapId: `map-${id}`,
    confirmedTimeMapId: null,
    state,
    appliedSegmentIds: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
  };
}

function createProposal(
  qualityLevel: MediaTimeMapQualityLevel | null,
  reasons: string[],
  lowConfidenceRegionCount: number
): AlignmentProposal {
  const timeMap = qualityLevel ? createTimeMapProposal(qualityLevel, reasons) : undefined;
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.8,
    diagnostics: [],
    evidence: {
      algorithm: "alignment-v2-edit-map",
      completeFingerprintCount: 10,
      sourceFingerprintCount: 10,
      fingerprintMatchCount: 8,
      monotonicMatchCount: 8,
      strongAnchorCount: 6,
      weakAnchorCount: 2,
      offsetClusterCount: 1,
      refinedCandidateCount: 1,
      lowConfidenceRegionCount,
      quality:
        qualityLevel === "blocked" ? "blocked" : qualityLevel === "review" ? "low" : "high"
    },
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 1
    },
    timeMap
  };
}

function createTimeMapProposal(
  level: MediaTimeMapQualityLevel,
  reasons: string[]
): NonNullable<AlignmentProposal["timeMap"]> {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [],
    quality: createQuality(level, reasons),
    evidence: {
      types: ["audio"],
      audioAnchorCount: 8,
      visualAnchorCount: 0,
      heldOutAnchorCount: 2,
      top1Top2Margin: 0.4,
      notes: []
    },
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    engineVersion: "alignment-v2-test",
    featureVersion: "test",
    parametersHash: "test"
  };
}

function createTimeMap(
  id: string,
  sourceMediaId: string,
  targetMediaId: string,
  level: MediaTimeMapQualityLevel,
  reasons: string[]
): MediaTimeMap {
  return {
    id,
    revision: 1,
    sourceMediaId,
    targetMediaId,
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [],
    quality: createQuality(level, reasons),
    evidence: {
      types: ["audio"],
      audioAnchorCount: 8,
      visualAnchorCount: 0,
      heldOutAnchorCount: 2,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2-test",
    featureVersion: "test",
    parametersHash: "test",
    state: "confirmed",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    confirmedAt: "2026-08-30T00:00:00.000Z"
  };
}

function createQuality(level: MediaTimeMapQualityLevel, reasons: string[]) {
  return {
    level,
    probability: level === "verified" ? 0.999 : null,
    metricSource: level === "verified" ? ("measured" as const) : ("estimated" as const),
    coverage: 0.9,
    uniqueContentCoverage: 0.8,
    p50ResidualMs: 20,
    p95ResidualMs: 80,
    p99ResidualMs: 120,
    maxResidualMs: 160,
    boundaryUncertaintyMs: 180,
    alternativeMargin: 0.4,
    anchorCount: 8,
    anchorRegionCount: 3,
    heldOutAnchorCount: 2,
    reasons
  };
}

function createQueue(
  projectId: string,
  pairs: ReadonlyArray<{
    sourceMediaId: string;
    targetMediaId: string;
    state: AlignmentExperimentPairState;
  }>
): AlignmentExperimentQueue {
  const queue = createAlignmentExperimentQueue({
    queueId: `queue-${projectId}`,
    projectId,
    config: {
      sourceMediaIds: [...new Set(pairs.map((pair) => pair.sourceMediaId))],
      targetMediaIds: [...new Set(pairs.map((pair) => pair.targetMediaId))],
      pairs: pairs.map(({ sourceMediaId, targetMediaId }) => ({
        sourceMediaId,
        targetMediaId
      })),
      versionReuseGroups: [],
      audioStreamSelections: {},
      spectralBackend: "auto",
      windowMs: 100,
      minGapMs: 5_000,
      matchThreshold: 0.62,
      enableVisualEvidence: true
    },
    nowMs: 1_000
  });
  queue.pairs = queue.pairs.map((pair, index) => ({
    ...pair,
    state: pairs[index].state
  }));
  return queue;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
