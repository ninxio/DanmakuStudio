import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { CalibrationOverview } from "./CalibrationOverview";

describe("CalibrationOverview", () => {
  beforeEach(() => {
    const asset = parseBilibiliXml(
      '<?xml version="1.0" encoding="UTF-8"?><i><d p="2,1,25,16777215,0,0,u,r">测试</d></i>',
      { fileName: "episode.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      selection: { kind: "none", ids: [] },
      history: createHistoryState(),
      isPlaying: false,
      status: { message: "准备就绪", tone: "neutral" },
      importProgress: null,
      exportDraft: null,
      alignmentProposal: null,
      cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
      timelineTool: "select",
      workspacePage: "editing"
    });
  });

  afterEach(cleanup);

  it("从唯一下一步进入播放，并提供可撤销的自然语言修复", () => {
    render(<CalibrationOverview />);

    fireEvent.click(screen.getByRole("button", { name: /开始编辑弹幕/ }));
    expect(useEditorStore.getState().project.clips).toHaveLength(1);
    act(() => useEditorStore.getState().prepareExport());
    const exported = parseBilibiliXml(useEditorStore.getState().exportDraft?.xml ?? "", {
      fileName: "result.xml"
    });
    expect(exported.items[0].sourceTimeMs).toBe(2_000);
    act(() => useEditorStore.getState().clearExport());
    expect(screen.getByRole("button", { name: /播放检查/ })).toBeVisible();

    fireEvent.click(screen.getByText("常用修复", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "整体延后 0.5 秒" }));
    expect(useEditorStore.getState().project.globalOffsetMs).toBe(500);
    expect(screen.getByText(/整体偏移 延后 0.5 秒/)).toBeVisible();

    act(() => useEditorStore.getState().setPlayhead(2_000));
    fireEvent.click(screen.getByRole("button", { name: /从这里重新同步/ }));
    fireEvent.change(screen.getByLabelText("对应原片时间"), {
      target: { value: "00:00:03.000" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存同步点" }));
    expect(useEditorStore.getState().project.syncAnchors).toEqual([
      expect.objectContaining({ sourceMs: 2_000, targetMs: 3_000, origin: "manual" })
    ]);

    fireEvent.click(screen.getByRole("button", { name: /这之后有版本差异/ }));
    fireEvent.change(screen.getByLabelText("版本差异秒数"), {
      target: { value: "-1.5" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存版本差异" }));
    expect(useEditorStore.getState().project.cutMarkers).toEqual([
      expect.objectContaining({ sourceAtMs: 2_000, targetGapMs: -1_500 })
    ]);
    expect(useEditorStore.getState().history.past.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        "加入未放入时间线的 XML",
        "修改全局偏移",
        "添加同步锚点",
        "添加版本差异"
      ])
    );
  });
});
