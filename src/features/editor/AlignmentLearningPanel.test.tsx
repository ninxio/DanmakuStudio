import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import type {
  AlignmentReviewRecord,
  AlignmentReviewVote,
  EditorProject
} from "../../domain/project/types";
import { useEditorStore } from "../../stores/editorStore";
import { AlignmentLearningPanel } from "./AlignmentLearningPanel";

const browserFileMocks = vi.hoisted(() => ({
  downloadTextFiles: vi.fn(() => ({
    fileCount: 3,
    archiveFileName: "personal-gold.zip",
    downloadedFileName: "personal-gold.zip"
  }))
}));

vi.mock("../../infrastructure/file-system/browserFiles", () => ({
  downloadTextFiles: browserFileMocks.downloadTextFiles
}));

vi.mock("./AlignmentAdjudicationPanel", () => ({
  AlignmentAdjudicationPanel: () => (
    <div data-testid="adjudication-panel-stub">独立复核</div>
  )
}));

describe("AlignmentLearningPanel", () => {
  beforeEach(() => {
    browserFileMocks.downloadTextFiles.mockClear();
    useEditorStore.setState({
      project: createEmptyProject(),
      history: createHistoryState(),
      projectContentRevision: 0,
      status: { message: "准备就绪", tone: "neutral" }
    });
  });

  it("没有样本时仍提供数据工作台，但不会伪造可导出记录", () => {
    render(<AlignmentLearningPanel />);

    expect(screen.getByRole("heading", { name: "算法改进数据" })).toBeInTheDocument();
    expect(screen.getByTestId("adjudication-panel-stub")).toBeInTheDocument();
    expect(screen.getByText("当前人工记录").parentElement).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: "导出训练数据包" })).toBeDisabled();
  });

  it("从可解释 Gold 卡一次冻结并把焦点交给可导出的冻结 case", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ project: createLearningGoldProject() });
    render(<AlignmentLearningPanel />);

    expect(screen.getByText("项目内媒体家族")).toBeInTheDocument();
    expect(screen.getByText(/两名独立复核者结论一致/)).toBeInTheDocument();
    expect(screen.getByText(/不会修改 TimeMap 或签发状态/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "冻结为 Personal Gold" }));

    const frozenCase = await screen.findByRole("group", {
      name: /已冻结 Personal Gold case/
    });
    expect(frozenCase).toHaveFocus();
    expect(useEditorStore.getState().project.alignmentPersonalGoldCases).toHaveLength(1);
    const exportButton = screen.getByRole("button", { name: "导出 Personal Gold 数据包" });
    expect(exportButton).toBeEnabled();
    await user.click(exportButton);
    expect(browserFileMocks.downloadTextFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ fileName: "personal-gold-manifest.json" }),
        expect.objectContaining({ fileName: "personal-gold-cases.jsonl" }),
        expect.objectContaining({ fileName: "personal-gold-confidence-samples.jsonl" })
      ]),
      "application/json;charset=utf-8",
      expect.stringMatching(/^danmaku-studio-personal-gold-/)
    );
  });

  it("待独立复核时提供真实下一动作，并把焦点交回既有复核工作区", async () => {
    const user = userEvent.setup();
    const pending = createLearningGoldProject();
    pending.alignmentReviewVotes = pending.alignmentReviewVotes.slice(0, 1);
    useEditorStore.setState({ project: pending });
    render(<AlignmentLearningPanel />);

    expect(screen.getByText(/待独立复核 1 条，冲突待仲裁 0 条/)).toBeInTheDocument();
    const personalGold = screen.getByTestId("personal-gold-workbench");
    const adjudication = screen.getByLabelText("独立复核区");
    expect(
      personalGold.compareDocumentPosition(adjudication) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "继续独立复核" }));
    expect(adjudication).toHaveFocus();
  });

  it("来源记录和票据 supersede 后仍展示冻结 case，不从当前状态重算快照", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ project: createLearningGoldProject() });
    expect(useEditorStore.getState().freezePersonalGoldCase("review-ui-gold")).toBe(true);
    const snapshot = structuredClone(
      useEditorStore.getState().project.alignmentPersonalGoldCases[0]
    );
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        alignmentReviewRecords: state.project.alignmentReviewRecords.map((record) => ({
          ...record,
          recordState: "superseded"
        })),
        alignmentReviewVotes: state.project.alignmentReviewVotes.map((vote) => ({
          ...vote,
          voteState: "superseded"
        }))
      }
    }));
    render(<AlignmentLearningPanel />);

    await user.click(screen.getByRole("button", { name: "查看 case" }));
    expect(screen.getByText("来源记录已有更新，冻结版本仍保留")).toBeInTheDocument();
    expect(useEditorStore.getState().project.alignmentPersonalGoldCases[0]).toEqual(snapshot);
    expect(screen.getByRole("button", { name: "导出 Personal Gold 数据包" })).toBeEnabled();
  });

  it("已有冻结 case 时仍公开剩余待复核数量和下一动作", () => {
    useEditorStore.setState({ project: createLearningGoldProject() });
    expect(useEditorStore.getState().freezePersonalGoldCase("review-ui-gold")).toBe(true);
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        alignmentReviewRecords: [
          ...state.project.alignmentReviewRecords,
          {
            ...createLearningReviewRecord(),
            id: "review-ui-pending",
            spanId: "span-ui-pending",
            reviewedAt: "2026-08-30T12:00:00.000Z"
          }
        ],
        alignmentReviewVotes: [
          ...state.project.alignmentReviewVotes,
          {
            ...createLearningVote("vote-ui-pending", "c", 650),
            reviewRecordId: "review-ui-pending"
          }
        ]
      }
    }));

    render(<AlignmentLearningPanel />);

    expect(screen.getByText(/待独立复核 1 条，冲突待仲裁 0 条/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续独立复核" })).toBeEnabled();
    expect(screen.getByText("已冻结 1 个 case")).toBeInTheDocument();
  });
});

function createLearningGoldProject(): EditorProject {
  const project = createEmptyProject("Learning Gold");
  project.alignmentReviewRecords = [createLearningReviewRecord()];
  project.alignmentReviewVotes = [
    createLearningVote("vote-ui-a", "a", 500),
    createLearningVote("vote-ui-b", "b", 800)
  ];
  return project;
}

function createLearningReviewRecord(): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id: "review-ui-gold",
    timeMapId: "map-ui-gold",
    timeMapRevision: 1,
    spanId: "span-ui-gold",
    spanIndex: 0,
    sourceMediaId: "source-ui",
    targetMediaId: "target-ui",
    mediaGroupId: "legacy-ui-family",
    action: "classifySpan",
    decision: "target-extra",
    precision: "playbackChecked",
    algorithmPrediction: "targetOnly",
    sourceStartMs: 10_000,
    sourceEndMs: 10_000,
    targetStartMs: 10_000,
    targetEndMs: 13_000,
    boundaryToleranceMs: 500,
    features: {
      sourceCoverage: 0.8,
      uniqueContentCoverage: 0.75,
      anchorCount: 12,
      heldOutAnchorCount: 3,
      anchorRegionCount: 2,
      p95ResidualMs: 120,
      p99ResidualMs: 180,
      maxResidualMs: 220,
      boundaryUncertaintyMs: 300,
      alternativeMargin: 0.2,
      ambiguousRatio: 0.05,
      bidirectionalAgreement: 0.9,
      differenceRiskP50: null,
      differenceRiskP90: null,
      differenceRiskP99: null,
      informativenessP50: null,
      visualRecoveredRatio: null,
      visualAmbiguousRatio: null,
      visualMarginP50: null
    },
    engineVersion: "engine-v1",
    featureVersion: "features-v1",
    parametersHash: "parameters-v1",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-08-30T09:00:00.000Z"
  };
}

function createLearningVote(
  id: string,
  reviewerCharacter: string,
  boundaryToleranceMs: number
): AlignmentReviewVote {
  return {
    voteVersion: 1,
    id,
    reviewRecordId: "review-ui-gold",
    reviewerIdDigest: `sha256:${reviewerCharacter.repeat(64)}`,
    reviewSessionId: `session-${id}`,
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
