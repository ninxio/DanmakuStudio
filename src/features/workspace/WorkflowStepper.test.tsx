import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsabilityStepViewModel } from "../../domain/project/usabilityViewModel";
import { WorkflowStepper } from "./WorkflowStepper";

const steps: UsabilityStepViewModel[] = [
  {
    id: "materials",
    order: 1,
    label: "素材",
    state: "complete",
    statusId: "confirmed",
    stateLabel: "已确认",
    headline: "素材已经准备好",
    detail: "准备素材",
    issueCount: 0
  },
  {
    id: "matching",
    order: 2,
    label: "智能匹配",
    state: "attention",
    statusId: "blocked",
    stateLabel: "已阻断",
    headline: "找出时间关系",
    detail: "自动分析",
    issueCount: 2
  },
  {
    id: "editing",
    order: 3,
    label: "校准",
    state: "available",
    statusId: "runnable",
    stateLabel: "可运行",
    headline: "预览并校准",
    detail: "修正位置",
    issueCount: 0
  },
  {
    id: "export",
    order: 4,
    label: "导出",
    state: "upcoming",
    statusId: "preparing",
    stateLabel: "准备中",
    headline: "检查后导出",
    detail: "导出 XML",
    issueCount: 0
  }
];

describe("WorkflowStepper", () => {
  afterEach(cleanup);

  it("展示四个固定步骤、当前页和待处理数量", () => {
    render(<WorkflowStepper steps={steps} activePage="matching" onChange={vi.fn()} />);

    expect(screen.getByRole("navigation", { name: "工作区页面" })).toBeVisible();
    expect(screen.getByTestId("workspace-nav-matching")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByLabelText("2 项待处理")).toBeVisible();
    expect(screen.getByTestId("workspace-nav-export")).toHaveAttribute(
      "title",
      "检查后导出 · 准备中"
    );
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.getByTestId("workspace-nav-editing")).toHaveTextContent("编辑");
  });

  it("点击步骤时只请求切换对应页面", () => {
    const onChange = vi.fn();
    render(<WorkflowStepper steps={steps} activePage="materials" onChange={onChange} />);

    fireEvent.click(screen.getByTestId("workspace-nav-export"));
    expect(onChange).toHaveBeenCalledWith("export");
  });
});
