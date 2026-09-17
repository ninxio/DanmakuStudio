import { useEditorStore } from "../../stores/editorStore";
import { createEmptyProject } from "../../domain/project/factory";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DanmakuFineTuneWorkspace } from "./DanmakuFineTuneWorkspace";

vi.mock("../timeline/TimelinePanel", () => ({
  TimelinePanel: () => <canvas aria-label="弹幕编辑画布" />
}));
vi.mock("../preview/PreviewPanel", () => ({
  PreviewPanel: () => <div aria-label="弹幕播放预览" />
}));
vi.mock("../inspector/InspectorPanel", () => ({
  InspectorPanel: () => <button>修改单条弹幕</button>
}));

describe("DanmakuFineTuneWorkspace", () => {
  beforeEach(() => useEditorStore.setState({ project: createEmptyProject(), projectEpoch: 0 }));
  it("校准与属性按需打开，开关工具不卸载正式时间线", () => {
    render(<DanmakuFineTuneWorkspace />);
    const canvas = screen.getByLabelText("弹幕编辑画布");
    expect(screen.queryByTestId("calibration-overview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "偏移与校准" }));
    expect(screen.getByTestId("calibration-overview")).toBeInTheDocument();
    expect(screen.getByLabelText("弹幕编辑画布")).toBe(canvas);
    fireEvent.click(screen.getByRole("button", { name: "关闭偏移与校准" }));
    fireEvent.click(screen.getByRole("button", { name: "片段与单条属性" }));
    expect(screen.getByRole("button", { name: "修改单条弹幕" })).toBeInTheDocument();
    expect(screen.getByLabelText("弹幕编辑画布")).toBe(canvas);
  });
  it("校准草稿在关闭对照时间线后保留，", () => {
    render(<DanmakuFineTuneWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "偏移与校准" }));
    fireEvent.click(screen.getByText("常用修复"));
    fireEvent.click(screen.getByRole("button", { name: "从这里重新同步" }));
    fireEvent.change(screen.getByLabelText("对应原片时间"), {
      target: { value: "00:01:23.456" }
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭偏移与校准" }));
    fireEvent.click(screen.getByRole("button", { name: "偏移与校准" }));
    fireEvent.click(screen.getByText("常用修复"));
    expect(screen.getByLabelText("对应原片时间")).toHaveValue("00:01:23.456");
    fireEvent.click(screen.getByRole("button", { name: "这之后有版本差异" }));
    fireEvent.change(screen.getByLabelText("版本差异秒数"), { target: { value: "27.5" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭偏移与校准" }));
    fireEvent.click(screen.getByRole("button", { name: "偏移与校准" }));
    fireEvent.click(screen.getByText("常用修复"));
    expect(screen.getByLabelText("版本差异秒数")).toHaveValue(27.5);
  });
});
