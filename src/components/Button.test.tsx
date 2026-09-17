import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

describe("Button", () => {
  it("默认使用安全的 button 类型并执行真实动作", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>继续</Button>);

    const button = screen.getByRole("button", { name: "继续" });
    expect(button).toHaveAttribute("type", "button");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("禁用时把原因加入可访问名称与悬停说明", () => {
    render(
      <Button disabled disabledReason="请先选择导出目录">
        批量导出
      </Button>,
    );

    const button = screen.getByRole("button", { name: /批量导出/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "请先选择导出目录");
    expect(button).toHaveAccessibleDescription("请先选择导出目录");
  });
});
