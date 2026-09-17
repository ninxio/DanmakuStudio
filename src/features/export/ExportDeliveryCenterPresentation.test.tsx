import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExportDeliveryCenterPresentation } from "./ExportDeliveryCenterPresentation";

const readyRow = {
  id: "target-01",
  targetLabel: "第 01 集 · 正片.mkv",
  fileName: "正片.xml",
  sourceSummary: "00:00:00.000 – 00:24:00.000",
  segmentSummary: "2 个来源段",
  correctionSummary: "1 处版本修正 · 3 条精调",
  danmakuSummary: "12,480 条弹幕",
  verificationLabel: "已验证",
  outputLabel: "可运行",
  state: "ready" as const,
  blockers: []
};

function createModel() {
  return {
    summary: {
      state: "ready" as const,
      badgeLabel: "可运行",
      headline: "2 集已通过交付检查",
      detail: "导出前仍会重新核验媒体身份与 XML。",
      exportableCount: 2,
      totalCount: 2,
      blockerCount: 0,
      projectedItemCount: 18_200
    },
    primaryAction: {
      type: "export-all" as const,
      label: "导出全部可用 XML"
    },
    availability: null,
    phase: "idle" as const,
    completion: null,
    failureMessage: null,
    blockers: [],
    notices: [],
    omitted: {
      ignoredItemCount: 0,
      sourceOnlyItemCount: 0,
      unexpectedUnmappedItemCount: 0
    },
    rows: [readyRow, { ...readyRow, id: "target-02", targetLabel: "第 02 集 · 正片.mkv" }]
  };
}

describe("ExportDeliveryCenterPresentation", () => {
  it("全部就绪时首屏只有一个批量导出主动作，正常分集默认折叠", async () => {
    const user = userEvent.setup();
    const onIntent = vi.fn();
    render(<ExportDeliveryCenterPresentation model={createModel()} onIntent={onIntent} />);

    expect(screen.getByRole("heading", { name: "导出" })).toBeInTheDocument();
    expect(screen.getByText("2 集已通过交付检查")).toBeInTheDocument();
    expect(screen.getAllByText("导出全部可用 XML")).toHaveLength(1);
    expect(screen.getAllByTestId("delivery-episode-row")).toHaveLength(2);
    expect(screen.getAllByTestId("delivery-episode-row")[0]).not.toHaveAttribute("open");

    await user.click(screen.getByText("导出全部可用 XML"));
    expect(onIntent).toHaveBeenCalledWith({ type: "export-all" });
  });

  it("有阻断时把首个异常与定位动作放在首屏，阻断分集默认展开", async () => {
    const user = userEvent.setup();
    const onIntent = vi.fn();
    const blocker = {
      id: "segment-blocked-segment-01",
      message: "第 01 集缺少已确认时间图。",
      targetLabel: "第 01 集 · 正片.mkv",
      locationLabel: "编辑 · 第 01 集关系"
    };
    const model = {
      ...createModel(),
      summary: {
        ...createModel().summary,
        state: "blocked" as const,
        badgeLabel: "已阻断",
        headline: "先处理 1 项交付阻断",
        blockerCount: 1,
        exportableCount: 1
      },
      primaryAction: {
        type: "locate-blocker" as const,
        issueId: blocker.id,
        label: "定位第一个阻断"
      },
      blockers: [blocker],
      rows: [
        {
          ...readyRow,
          state: "blocked" as const,
          outputLabel: "阻止导出",
          blockers: [blocker]
        }
      ]
    };
    render(<ExportDeliveryCenterPresentation model={model} onIntent={onIntent} />);

    await user.click(screen.getByRole("button", { name: /^检查详情/ }));
    const firstBlocker = screen.getByTestId("delivery-first-blocker");
    expect(firstBlocker).toHaveTextContent("第 01 集缺少已确认时间图");
    expect(firstBlocker).toHaveTextContent("编辑 · 第 01 集关系");
    expect(screen.getByTestId("delivery-episode-row")).toHaveAttribute("open");
    expect(screen.queryByText("导出全部可用 XML")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "关闭导出检查详情" }));
    await user.click(screen.getByRole("button", { name: "定位第一个阻断" }));
    expect(onIntent).toHaveBeenCalledWith({
      type: "locate-blocker",
      issueId: blocker.id
    });
  });

  it("在原位持续展示运行、失败与完成目录", async () => {
    const user = userEvent.setup();
    const onIntent = vi.fn();
    const { rerender } = render(
      <ExportDeliveryCenterPresentation
        model={{
          ...createModel(),
          phase: "running",
          rows: [{ ...readyRow, state: "running", outputLabel: "运行中" }]
        }}
        onIntent={onIntent}
      />
    );
    const primaryAction = screen.getByRole("button", { name: "正在核验并导出…" });
    expect(primaryAction).toBeDisabled();
    expect(primaryAction).toHaveClass("w-40");
    expect(screen.getAllByText("运行中").length).toBeGreaterThan(0);

    rerender(
      <ExportDeliveryCenterPresentation
        model={{
          ...createModel(),
          phase: "failed",
          failureMessage: "媒体身份已变化，请重新连接后再试。",
          rows: [{ ...readyRow, state: "failed", outputLabel: "已阻断" }]
        }}
        onIntent={onIntent}
      />
    );
    expect(screen.getByRole("button", { name: "导出全部分集 XML" })).toBe(primaryAction);
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("媒体身份已变化");
    await user.click(screen.getByRole("button", { name: /^检查详情/ }));
    const failureDetails = within(
      screen.getByRole("dialog", { name: "导出检查详情" })
    ).getByRole("alert");
    expect(failureDetails).toHaveTextContent("影响：本次没有生成新的分集 XML");
    expect(failureDetails).toHaveTextContent(
      "恢复：处理上述原因后，使用右上角主动作重新核验并导出"
    );

    rerender(
      <ExportDeliveryCenterPresentation
        model={{
          ...createModel(),
          phase: "completed",
          completion: {
            fileCount: 2,
            directoryPath: "D:\\exports",
            filePath: "D:\\exports\\正片.xml",
            wasRenamed: false
          },
          rows: [{ ...readyRow, state: "completed", outputLabel: "已导出" }]
        }}
        onIntent={onIntent}
      />
    );
    expect(screen.getByRole("button", { name: "再次导出全部分集 XML" })).toBe(primaryAction);
    await user.click(screen.getByRole("button", { name: "关闭导出检查详情" }));
    const completion = screen.getByTestId("export-completion");
    expect(completion).toHaveTextContent("已导出 2 个分集 XML");
    expect(completion).toHaveTextContent("D:\\exports");
    await user.click(within(completion).getByRole("button", { name: "打开导出目录" }));
    expect(onIntent).toHaveBeenCalledWith({ type: "open-directory" });
  });

  it("额外阻断只保留一个 Tab 行，并用方向键定位、Enter 打开、Escape 返回主动作", async () => {
    const user = userEvent.setup();
    const onIntent = vi.fn();
    const blockers = [1, 2, 3].map((episode) => ({
      id: `blocker-${episode}`,
      message: `第 ${episode} 集缺少已确认时间图。`,
      targetLabel: `第 ${episode} 集`,
      locationLabel: `编辑 · 第 ${episode} 集关系`
    }));
    const model = {
      ...createModel(),
      summary: {
        ...createModel().summary,
        state: "blocked" as const,
        badgeLabel: "已阻断",
        headline: "先处理 3 项交付阻断",
        blockerCount: 3,
        exportableCount: 0
      },
      primaryAction: {
        type: "locate-blocker" as const,
        issueId: blockers[0].id,
        label: "定位第一个阻断"
      },
      blockers
    };
    render(<ExportDeliveryCenterPresentation model={model} onIntent={onIntent} />);

    await user.click(screen.getByRole("button", { name: /^检查详情/ }));
    const issueList = screen.getByRole("list", { name: "其余交付阻断" });
    const rows = within(issueList).getAllByRole("button");
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);

    rows[0].focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onIntent).toHaveBeenCalledWith({
      type: "locate-blocker",
      issueId: blockers[2].id
    });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "定位第一个阻断" })).toHaveFocus();
  });
});
