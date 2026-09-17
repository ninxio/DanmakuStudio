import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuClip } from "../../domain/danmaku/types";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { InspectorPanel } from "./InspectorPanel";
import { useEditorStore } from "../../stores/editorStore";

const asset: DanmakuAsset = {
  id: "asset",
  name: "asset",
  fileName: "asset.xml",
  color: "#4cc9f0",
  importedAt: "now",
  sourceReceipt: null,
  warnings: [],
  items: [
    {
      id: "item",
      assetId: "asset",
      originalIndex: 0,
      sourceTimeMs: 1000,
      mode: 1,
      fontSize: 25,
      color: 16_777_215,
      timestamp: 0,
      pool: 0,
      userHash: "user",
      rowId: "row",
      text: "检查器弹幕",
      rawPFields: ["1.000", "1", "25", "16777215", "0", "0", "user", "row"],
      enabled: true
    }
  ]
};

const clip: DanmakuClip = {
  id: "clip",
  assetId: "asset",
  name: "片段",
  timelineStartMs: 0,
  sourceInMs: 0,
  sourceOutMs: 5000,
  localOffsetMs: 0,
  enabled: true
};

describe("检查器", () => {
  beforeEach(() => {
    useEditorStore.setState({
      project: { ...createEmptyProject(), assets: [asset], clips: [clip] },
      history: createHistoryState(),
      selection: { kind: "danmaku", ids: ["item"] }
    });
  });

  it("显示并修改单条弹幕微调", () => {
    render(<InspectorPanel />);
    expect(screen.getByDisplayValue("检查器弹幕")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("时间微调"), { target: { value: "120" } });
    expect(useEditorStore.getState().project.itemTimeAdjustments.item).toBe(120);
  });

  it("编辑版本差异时更新底层时间差", () => {
    useEditorStore.getState().addCutMarker(3000, 45000);
    const marker = useEditorStore.getState().project.cutMarkers[0];
    useEditorStore.getState().select({ kind: "cut", ids: [marker.id] });
    render(<InspectorPanel />);
    expect(screen.getByText("版本差异")).toBeInTheDocument();
    expect(screen.getByText("此点之后的弹幕会整体后移 00:00:45.000。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("相差多久"), { target: { value: "12000" } });
    expect(useEditorStore.getState().project.cutMarkers[0].targetGapMs).toBe(12000);
    fireEvent.change(screen.getByLabelText("完整版比当前版"), { target: { value: "less" } });
    expect(useEditorStore.getState().project.cutMarkers[0].targetGapMs).toBe(-12000);
  });
});
