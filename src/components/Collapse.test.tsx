import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Collapse } from "./Collapse";

describe("Collapse", () => {
  it("使用原生键盘语义展开并显示内容", async () => {
    const user = userEvent.setup();
    render(<Collapse summary="高级设置">诊断内容</Collapse>);

    const summary = screen.getByText("高级设置");
    summary.focus();
    expect(summary).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("诊断内容").closest("details")).toHaveAttribute("open");
  });
});
