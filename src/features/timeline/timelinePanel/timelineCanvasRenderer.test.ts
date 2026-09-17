import { describe, expect, it, vi } from "vitest";
import { designTokenColor } from "../../../components/designTokens";
import { buildAlignmentPreview } from "../../../domain/alignment/preview";
import { createEmptyProject } from "../../../domain/project/factory";
import {
  TIMELINE_LABEL_WIDTH,
  createTimelineTracks,
  drawTimelineCanvas,
  timelineTimeToX
} from "./timelineCanvasRenderer";

describe("timelineCanvasRenderer", () => {
  it("以单一 frame 按固定层序绘制令牌底面、六条轨道和边缘反馈", () => {
    const fillStyles: string[] = [];
    const clearRect = vi.fn<(x: number, y: number, width: number, height: number) => void>();
    const fillRect = vi.fn<(x: number, y: number, width: number, height: number) => void>();
    const fillText = vi.fn<
      (text: string, x: number, y: number, maxWidth?: number) => void
    >();
    const context = {
      canvas: { width: 800, height: 320 },
      clearRect,
      fillRect,
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      setLineDash: vi.fn(),
      fillText,
      measureText: (text: string) => ({ width: text.length * 8 }),
      strokeStyle: "",
      lineWidth: 1,
      font: "",
      globalAlpha: 1
    } as unknown as CanvasRenderingContext2D;
    Object.defineProperty(context, "fillStyle", {
      configurable: true,
      get: () => fillStyles.at(-1) ?? "",
      set: (value: string) => fillStyles.push(value)
    });
    const project = createEmptyProject();

    drawTimelineCanvas(context, {
      width: 800,
      height: 320,
      project,
      tracks: createTimelineTracks(320),
      visibleEvents: [],
      allEvents: [],
      selection: { kind: "none", ids: [] },
      boxPreview: null,
      edgeFeedback: "start",
      alignmentPreview: buildAlignmentPreview(project, null),
      suspectedCutCandidates: []
    });

    expect(clearRect).toHaveBeenCalledWith(0, 0, 800, 320);
    expect(fillStyles[0]).toBe(designTokenColor("surface-canvas"));
    expect(fillRect).toHaveBeenNthCalledWith(1, 0, 0, 800, 320);
    expect(fillText.mock.calls.slice(0, 6).map(([label]) => label)).toEqual([
      "时间标尺",
      "视频轨道",
      "版本差异",
      "弹幕片段",
      "密度热力图",
      "弹幕事件"
    ]);
    expect(fillText).toHaveBeenCalledWith("已到时间轴开端", expect.any(Number), 50);
  });

  it("共享整数毫秒坐标与轨道布局，而不让交互层复制 Canvas 常量", () => {
    expect(TIMELINE_LABEL_WIDTH).toBe(104);
    expect(createTimelineTracks(320).events).toEqual({ y: 212, height: 108 });
    expect(timelineTimeToX(5_000, 1_000, 100)).toBe(504);
  });
});
