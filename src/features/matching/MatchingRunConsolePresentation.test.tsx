import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MatchingRunConsolePresentation } from "./MatchingRunConsolePresentation";
import type {
  MatchingRunConsoleGroup,
  MatchingRunConsoleModel,
  MatchingRunConsoleRow
} from "./matchingTaskModels";

describe("Matching Run Console presentation", () => {
  it("异常优先排列队列，并让正常完成默认折叠", () => {
    render(<MatchingRunConsolePresentation model={createModel()} onIntent={vi.fn()} />);

    const queue = screen.getByRole("complementary", { name: "批量匹配任务" });
    expect(within(queue).getByText("已阻断 · 1")).toBeInTheDocument();
    expect(within(queue).getByText("需复核 · 1")).toBeInTheDocument();
    expect(within(queue).getByText("运行中 · 1")).toBeInTheDocument();
    expect(within(queue).queryByText("正常完成关系")).not.toBeInTheDocument();

    fireEvent.click(within(queue).getByRole("button", { name: /展开已确认 1 个/ }));
    expect(within(queue).getAllByText("正常完成关系").length).toBeGreaterThan(0);
  });

  it("唯一主动作定位首个异常，实时刷新同一行时不重置焦点", async () => {
    const onIntent = vi.fn();
    const { rerender } = render(
      <MatchingRunConsolePresentation model={createModel()} onIntent={onIntent} />
    );

    fireEvent.click(screen.getByRole("button", { name: "定位首个异常" }));
    const firstIssue = screen.getAllByTestId("matching-run-row")[0];
    await waitFor(() => expect(firstIssue).toHaveFocus());

    const refreshed = createModel();
    refreshed.groups[0] = {
      ...refreshed.groups[0],
      rows: [{ ...refreshed.groups[0].rows[0], message: "仍然阻断，已收到最新状态" }]
    };
    rerender(<MatchingRunConsolePresentation model={refreshed} onIntent={onIntent} />);

    expect(screen.getAllByTestId("matching-run-row")[0]).toHaveFocus();
    expect(screen.getByText("仍然阻断，已收到最新状态")).toBeInTheDocument();

    const completed = createModel();
    const completedRow = {
      ...completed.groups[0].rows[0],
      group: "completed" as const,
      stateLabel: "已确认",
      message: "后台任务已经完成"
    };
    completed.groups = [
      completed.groups[1],
      completed.groups[2],
      {
        ...completed.groups[3],
        rows: [...completed.groups[3].rows, completedRow]
      }
    ];
    rerender(<MatchingRunConsolePresentation model={completed} onIntent={onIntent} />);

    expect(
      screen.getByRole("button", { name: /阻断关系 已确认 后台任务已经完成/ })
    ).toHaveFocus();
    expect(onIntent).not.toHaveBeenCalled();
  });

  it("运行队列只保留一个 Tab 行，并用方向键移动、Space 选择、Escape 返回队列", async () => {
    const user = userEvent.setup();
    render(<MatchingRunConsolePresentation model={createModel()} onIntent={vi.fn()} />);

    const queue = screen.getByRole("complementary", { name: "批量匹配任务" });
    const rows = within(queue).getAllByTestId("matching-run-row");
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    rows[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);

    await user.keyboard("{End}");
    expect(rows[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(rows[0]).toHaveFocus();
    await user.keyboard("{Space}");
    expect(rows[0]).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Escape}");
    expect(queue).toHaveFocus();
  });
});

function createModel(): MatchingRunConsoleModel {
  return {
    runBar: {
      selectedSourceCount: 1,
      selectedTargetCount: 4,
      selectedPairCount: 4,
      selectedMediaCount: 5,
      audioReadyCount: 5,
      audioBlockerCount: 0,
      blockerCount: 2,
      running: true,
      restartRequired: false
    },
    groups: [
      createGroup("blocked", "已阻断", createRow("blocked", "阻断关系")),
      createGroup("review", "需复核", createRow("review", "复核关系")),
      createGroup("running", "运行中", createRow("running", "运行关系")),
      createGroup("completed", "已确认", createRow("completed", "正常完成关系"), true)
    ],
    primaryAction: { kind: "focusIssue", label: "定位首个异常", disabled: false },
    diagnosticJobId: null
  };
}

function createGroup(
  id: MatchingRunConsoleGroup["id"],
  title: string,
  row: MatchingRunConsoleRow,
  collapsedByDefault = false
): MatchingRunConsoleGroup {
  return { id, title, rows: [row], collapsedByDefault };
}

function createRow(
  group: MatchingRunConsoleRow["group"],
  title: string
): MatchingRunConsoleRow {
  return {
    id: `${group}-row`,
    sourceMediaId: "source",
    targetMediaId: `target-${group}`,
    title,
    group,
    stateLabel:
      group === "blocked"
        ? "已阻断"
        : group === "review"
          ? "需复核"
          : group === "running"
            ? "运行中"
            : "已确认",
    stageLabel: "当前阶段",
    message: `${title}说明`,
    nextAction: "下一步",
    progress: group === "running" ? 0.5 : 1,
    jobId: null,
    logs: [],
    candidateId: group === "review" ? "candidate-review" : null
  };
}
