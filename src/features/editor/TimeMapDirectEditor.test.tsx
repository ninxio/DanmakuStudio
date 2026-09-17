import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MediaTimeMap } from "../../domain/project/types";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import { TimeMapDirectEditor } from "./TimeMapDirectEditor";

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null)
  });
});

describe("TimeMapDirectEditor", () => {
  it("shows equally scaled source and target rulers instead of stretching each axis independently", () => {
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={vi.fn()}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );
    const source = screen.getByRole("img", { name: "参考时间刻度" });
    const target = screen.getByRole("img", { name: "原片时间刻度" });
    expect(Number(source.getAttribute("data-duration-ms"))).toBe(
      Number(target.getAttribute("data-duration-ms"))
    );
    expect(source.querySelectorAll("[data-time-ms]").length).toBeGreaterThan(2);
  });
  it("关闭精确工具保留未提交草稿与同一画布，重新打开后才明确提交", () => {
    const onOriginal = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );
    const canvas = screen.getByRole("img", { name: "原片轨道差异风险热力图和时间偏移阶梯" });
    const trigger = screen.getByRole("button", { name: "精确边界" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "精确边界" });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "原片独有开始（毫秒）" }), {
      target: { value: "370000" }
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onOriginal).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "原片轨道差异风险热力图和时间偏移阶梯" })).toBe(
      canvas
    );
    fireEvent.click(trigger);
    const reopened = screen.getByRole("dialog", { name: "精确边界" });
    expect(
      within(reopened).getByRole("spinbutton", { name: "原片独有开始（毫秒）" })
    ).toHaveValue(370000);
    fireEvent.click(within(reopened).getByRole("button", { name: /确认原片独有 35.025 秒/ }));
    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 366775,
      targetStartMs: 370000,
      targetEndMs: 405025
    });
  });
  it("把长目标尾部差异直接建议为原片独有并一次提交", () => {
    const onOriginal = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    expect(screen.getByText("原片可能多出一段")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /确认原片独有 38.250 秒/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /确认原片独有 38.250 秒/ }));

    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 366_775,
      targetStartMs: 366_775,
      targetEndMs: 405_025
    });
  });

  it("可用 A/B 当前播放位置精调边界，并显示局部证据轨", () => {
    const onOriginal = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        evidenceProfile={{
          version: "alignment-evidence-profile-v1",
          windowMs: 1_000,
          samples: [
            {
              axis: "target",
              startMs: 365_000,
              endMs: 366_000,
              counterpartMs: 365_000,
              strength: 0.9,
              anchorCount: 3,
              heldOutAnchorCount: 1,
              medianAbsResidualMs: 20,
              offsetMs: 0,
              state: "supported"
            }
          ]
        }}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "target", positionMs: 370_000 }}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "图例与分析" }));
    expect(screen.getByText(/局部证据 · 1.000 秒\/窗/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭图例与分析" }));
    expect(
      screen.getByRole("img", { name: "原片轨道差异风险热力图和时间偏移阶梯" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "精确边界" }));
    fireEvent.click(screen.getByRole("button", { name: "将当前播放位置设为开始" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "精确边界" })).getByRole("button", {
        name: /确认原片独有 35.025 秒/
      })
    );

    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 366_775,
      targetStartMs: 370_000,
      targetEndMs: 405_025
    });
  });

  it("边界支持毫秒精确输入、100 毫秒步进与可关闭吸附", () => {
    const onOriginal = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "target", positionMs: 370_000 }}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "精确边界" }));
    const startInput = screen.getByRole("spinbutton", {
      name: "原片独有开始（毫秒）"
    });
    expect(startInput).toHaveValue(366_775);
    fireEvent.change(startInput, { target: { value: "369900" } });
    expect(startInput).toHaveValue(370_000);
    expect(screen.getByText("已吸附到 B 当前播放头 00:06:10.000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "边界吸附" }));
    fireEvent.click(screen.getByRole("button", { name: "开始向后 100 毫秒" }));
    expect(startInput).toHaveValue(370_100);
    expect(screen.getByText(/拖动、输入与步进使用同一边界草稿/)).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "精确边界" })).getByRole("button", {
        name: /确认原片独有 34.925 秒/
      })
    );
    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 366_775,
      targetStartMs: 370_100,
      targetEndMs: 405_025
    });
  });

  it("同一边界草稿可用时间码和显式帧率下的帧号精确定位", () => {
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "target", positionMs: 370_000 }}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={vi.fn()}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "精确边界" }));
    expect(screen.getByRole("combobox", { name: "边界精调帧率" })).toHaveValue("25");
    expect(screen.getByRole("textbox", { name: "原片独有开始（时间码）" })).toHaveValue(
      "00:06:06.775"
    );
    expect(screen.getByRole("spinbutton", { name: "原片独有开始（帧）" })).toHaveValue(9169);

    fireEvent.click(screen.getByRole("checkbox", { name: "边界吸附" }));
    const timecodeInput = screen.getByRole("textbox", { name: "原片独有开始（时间码）" });
    fireEvent.change(timecodeInput, { target: { value: "00:06:09.900" } });
    fireEvent.blur(timecodeInput);
    expect(screen.getByRole("spinbutton", { name: "原片独有开始（毫秒）" })).toHaveValue(
      369_900
    );
    expect(screen.getByRole("spinbutton", { name: "原片独有开始（帧）" })).toHaveValue(9248);

    fireEvent.change(screen.getByRole("spinbutton", { name: "原片独有开始（帧）" }), {
      target: { value: "9250" }
    });
    expect(screen.getByRole("spinbutton", { name: "原片独有开始（毫秒）" })).toHaveValue(
      370_000
    );
  });

  it("从共同内容证据两侧的 offset 阶跃自动提出中间原片独有段", () => {
    const onOriginal = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        evidenceProfile={{
          version: "alignment-evidence-profile-v1",
          windowMs: 1_000,
          samples: [
            createSupportedSample("target", 190_000, 200_000, 0),
            createSupportedSample("target", 240_000, 250_000, 40_000)
          ]
        }}
        selectedSpanIndex={0}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    expect(screen.getByText(/00:03:20.000–00:04:00.000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /确认原片独有 40.000 秒/ }));
    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 200_000,
      targetStartMs: 200_000,
      targetEndMs: 240_000
    });
  });

  it("对称识别 offset 反向阶跃并提出中间参考独有段", () => {
    const onReference = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        evidenceProfile={{
          version: "alignment-evidence-profile-v1",
          windowMs: 1_000,
          samples: [
            createSupportedSample("source", 190_000, 200_000, 0),
            createSupportedSample("source", 240_000, 250_000, -40_000)
          ]
        }}
        selectedSpanIndex={0}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={vi.fn()}
        onResolveReferenceOnlyGap={onReference}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /确认参考独有 40.000 秒/ }));
    expect(onReference).toHaveBeenCalledWith({
      sourceStartMs: 200_000,
      sourceEndMs: 240_000,
      targetAtMs: 200_000
    });
  });

  it("把唯一视觉锚点的 offset 阶跃变成一次确认的原片独有建议", () => {
    const onOriginal = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        evidenceProfile={{
          version: "alignment-evidence-profile-v2",
          windowMs: 10_000,
          samples: [
            createSupportedSample("source", 190_000, 200_000, 0),
            {
              ...createSupportedSample("source", 200_000, 210_000, 0),
              state: "weak",
              visualMatchMs: 245_000,
              visualOffsetMs: 40_000,
              visualConfidence: 0.86,
              visualMargin: 0.42,
              visualRecoveryState: "recovered" as const
            }
          ]
        }}
        selectedSpanIndex={0}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "图例与分析" }));
    expect(screen.getByText("画面已重新定位 1 个音频疑点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭图例与分析" }));
    fireEvent.click(screen.getByRole("button", { name: /确认原片独有 40.000 秒/ }));
    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 200_000,
      targetStartMs: 200_000,
      targetEndMs: 240_000
    });
  });

  it("可把另一侧 A/B 播放位置直接用作单侧差异接缝", () => {
    const onOriginal = vi.fn();
    const timeMap = createGapMap();
    const { rerender } = render(
      <TimeMapDirectEditor
        timeMap={timeMap}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "target", positionMs: 200_000 }}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "精确边界" }));
    fireEvent.click(screen.getByRole("button", { name: "将当前播放位置设为开始" }));
    rerender(
      <TimeMapDirectEditor
        timeMap={timeMap}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "target", positionMs: 240_000 }}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "将当前播放位置设为结束" }));
    rerender(
      <TimeMapDirectEditor
        timeMap={timeMap}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "source", positionMs: 200_000 }}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={onOriginal}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "将另一侧当前位置设为接缝" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "精确边界" })).getByRole("button", {
        name: /确认原片独有 40.000 秒/
      })
    );

    expect(onOriginal).toHaveBeenCalledWith({
      sourceAtMs: 200_000,
      targetStartMs: 200_000,
      targetEndMs: 240_000
    });
  });

  it("共同内容和灰色疑点都可进入单侧拖选，不再只允许 ambiguous 自动建议", () => {
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={1}
        relationState="candidate"
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={vi.fn()}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "标记多出内容" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "标记原片多出" }));
    expect(screen.getByLabelText(/原片轨道色块轨，可直接拖动选择独有内容/)).toBeInTheDocument();
    expect(screen.getByLabelText(/原片轨道局部证据轨，可拖动选择独有内容/)).toBeInTheDocument();
    expect(screen.getByLabelText("参考轨道局部证据轨")).toBeInTheDocument();
  });

  it("正式色块轨显示播放位置，并可用键盘直接请求 A/B 定位", () => {
    const onSeekPlayback = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="candidate"
        playbackCursor={{ side: "target", positionMs: 200_000 }}
        onSeekPlayback={onSeekPlayback}
        onSelectSpan={vi.fn()}
        onResolveOriginalOnlyGap={vi.fn()}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    const targetTrack = screen.getByRole("slider", { name: /^原片轨道色块轨/ });
    expect(targetTrack).toHaveAttribute("aria-valuenow", "200000");
    fireEvent.keyDown(targetTrack, { key: "ArrowRight" });
    expect(onSeekPlayback).toHaveBeenLastCalledWith({
      side: "target",
      positionMs: 201_000
    });
    fireEvent.keyDown(targetTrack, { key: "ArrowLeft", shiftKey: true });
    expect(onSeekPlayback).toHaveBeenLastCalledWith({
      side: "target",
      positionMs: 199_900
    });
  });

  it("已保存关系仍可选择色块和查看热力图，并明确提示如何解锁编辑", () => {
    const onSelectSpan = vi.fn();
    render(
      <TimeMapDirectEditor
        timeMap={createGapMap()}
        selectedSpanIndex={0}
        relationState="accepted"
        onSelectSpan={onSelectSpan}
        onResolveOriginalOnlyGap={vi.fn()}
        onResolveReferenceOnlyGap={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /参考轨道第 2 段/ }));
    expect(onSelectSpan).toHaveBeenCalledWith(1);
    expect(screen.getByText(/点击“修改这一段”/)).toBeInTheDocument();
  });
});

function createGapMap(): MediaTimeMap {
  return {
    id: "gap-map",
    revision: 1,
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    sourceStartMs: 0,
    sourceEndMs: 700_000,
    targetStartMs: 0,
    targetEndMs: 738_250,
    spans: [
      {
        ...createTestCompleteTimeMapSpan(
          {
            kind: "ambiguous",
            sourceStartMs: 0,
            sourceEndMs: 366_775,
            targetStartMs: 0,
            targetEndMs: 405_025
          },
          "gap-map:ambiguous"
        ),
        quality: {
          ...createTestCompleteTimeMapSpan(
            {
              kind: "ambiguous",
              sourceStartMs: 0,
              sourceEndMs: 366_775,
              targetStartMs: 0,
              targetEndMs: 405_025
            },
            "gap-map:ambiguous"
          ).quality,
          level: "blocked",
          reasons: ["需要人工确认。"]
        }
      },
      createTestCompleteTimeMapSpan(
        {
          kind: "matched",
          sourceStartMs: 366_775,
          sourceEndMs: 700_000,
          targetStartMs: 405_025,
          targetEndMs: 738_250
        },
        "gap-map:after"
      )
    ],
    quality: {
      level: "blocked",
      probability: null,
      metricSource: "measured",
      coverage: 0.8,
      uniqueContentCoverage: 0.8,
      p50ResidualMs: 20,
      p95ResidualMs: 50,
      p99ResidualMs: 80,
      maxResidualMs: 100,
      boundaryUncertaintyMs: 500,
      alternativeMargin: 0.2,
      anchorCount: 10,
      anchorRegionCount: 3,
      heldOutAnchorCount: 2,
      reasons: ["需要人工确认。"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 10,
      visualAnchorCount: 0,
      heldOutAnchorCount: 2,
      top1Top2Margin: 0.2,
      uniqueContentCoverage: 0.8,
      repeatedContentOnly: false,
      selectedTrackReason: "测试音轨",
      alternativeTrackScores: [],
      notes: []
    },
    verification: null,
    engineVersion: "test",
    featureVersion: "test",
    parametersHash: "test",
    state: "candidate",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    confirmedAt: null
  };
}

function createSupportedSample(
  axis: "source" | "target",
  startMs: number,
  endMs: number,
  offsetMs: number
) {
  return {
    axis,
    startMs,
    endMs,
    counterpartMs: axis === "source" ? startMs + offsetMs : startMs - offsetMs,
    strength: 0.9,
    anchorCount: 3,
    heldOutAnchorCount: 1,
    medianAbsResidualMs: 20,
    offsetMs,
    state: "supported" as const
  };
}
