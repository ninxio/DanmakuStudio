import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { useEditorStore } from "../../stores/editorStore";
import { EditorToolbar } from "../editor/EditorToolbar";
import { TimelinePanel } from "./TimelinePanel";

describe("时间轴面板", () => {
  beforeEach(() => {
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
      timelineTool: "select"
    });
  });

  it("对齐状态计数会区分待应用、已落点和阻断", () => {
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        syncAnchors: [{ id: "anchor-existing", sourceMs: 1000, targetMs: 2000, origin: "manual" }],
        cutMarkers: [{ id: "cut-existing", name: "已有版本差异", sourceAtMs: 3000, targetGapMs: 1200, note: "" }]
      },
      alignmentProposal: {
        anchors: [{ id: "anchor-existing", sourceMs: 1200, targetMs: 2400, origin: "automatic" }],
        cutCandidates: [
          {
            id: "cut-existing",
            name: "同 ID 不同版本差异",
            sourceAtMs: 3000,
            targetGapMs: 2400,
            confidence: 0.9,
            note: ""
          }
        ],
        confidence: 0.9,
        diagnostics: []
      }
    });

    render(<TimelinePanel />);

    expect(screen.getByText("对齐待应用 0 / 已落点 0 / 阻断 2")).toBeInTheDocument();
  });

  it("播放、播放头与缩放只有一个正式控制面，并归属于时间轴", () => {
    useEditorStore.setState({
      workspacePage: "editing",
      project: {
        ...createEmptyProject(),
        timeline: {
          playheadMs: 12_345,
          scrollMs: 0,
          pixelsPerSecond: 100
        }
      }
    });

    render(
      <>
        <EditorToolbar />
        <TimelinePanel />
      </>
    );

    expect(screen.getAllByRole("button", { name: "播放高级弹幕时间线" })).toHaveLength(1);
    expect(screen.getAllByRole("slider", { name: "时间轴缩放比例" })).toHaveLength(1);

    const timelineToolbar = screen.getByTestId("timeline-toolbar");
    const playButton = within(timelineToolbar).getByRole("button", {
      name: "播放高级弹幕时间线"
    });
    const zoomSlider = within(timelineToolbar).getByRole("slider", {
      name: "时间轴缩放比例"
    });
    const playhead = within(timelineToolbar).getByRole("status", {
      name: "高级弹幕时间线播放头"
    });

    expect(playhead).toHaveTextContent("00:00:12.345");
    playButton.focus();
    expect(playButton).toHaveFocus();
    fireEvent.click(playButton);
    expect(useEditorStore.getState().isPlaying).toBe(true);

    zoomSlider.focus();
    expect(zoomSlider).toHaveFocus();
    fireEvent.change(zoomSlider, { target: { value: "1000" } });
    expect(useEditorStore.getState().project.timeline.pixelsPerSecond).toBeGreaterThan(100);
  });
});
