import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceStatePanel } from "./WorkspaceStatePanel";

describe("WorkspaceStatePanel", () => {
  it("只把真正的局部加载态作为低噪声状态播报", () => {
    render(
      <WorkspaceStatePanel
        state="loading"
        title="正在加载弹幕精修工作台"
        description="编辑工作台仍然保留，只加载当前工具。"
      />
    );

    const status = screen.getByRole("status", {
      name: "正在加载弹幕精修工作台"
    });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("编辑工作台仍然保留，只加载当前工具。");
    expect(
      screen.getByRole("progressbar", { name: "正在加载弹幕精修工作台" })
    ).not.toHaveAttribute("aria-valuenow");
  });

  it("错误就地说明原因、影响与恢复路径，空态不制造 live region", () => {
    const { rerender } = render(
      <WorkspaceStatePanel
        state="error"
        title="导出未完成"
        description="媒体身份已变化。"
        impact="本次没有生成新的分集 XML。"
        recovery="重新连接媒体后，使用右上角主动作重试。"
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("媒体身份已变化");
    expect(alert).toHaveTextContent("影响：本次没有生成新的分集 XML。");
    expect(alert).toHaveTextContent("恢复：重新连接媒体后，使用右上角主动作重试。");

    rerender(
      <WorkspaceStatePanel
        state="empty"
        title="还没有可复核关系"
        description="先运行智能匹配，候选结果会出现在这里。"
      />
    );
    expect(screen.getByRole("region", { name: "还没有可复核关系" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
