import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("发布可读名称与规范化进度", () => {
    render(<ProgressBar label="匹配进度" value={6} max={8} />);
    expect(screen.getByRole("progressbar", { name: "匹配进度" })).toHaveAttribute(
      "aria-valuenow",
      "6",
    );
    expect(screen.getByText("75%")).toBeVisible();
  });
});
