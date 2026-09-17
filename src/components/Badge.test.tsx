import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("状态不只依赖颜色并保留可读文本", () => {
    render(<Badge tone="warning" icon={<span aria-hidden="true">!</span>}>需复核</Badge>);
    expect(screen.getByText("需复核")).toBeVisible();
    expect(screen.getByText("需复核").parentElement).toHaveAttribute("data-tone", "warning");
  });
});
