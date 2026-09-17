import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";

describe("Field", () => {
  it("用标签关联输入并保留后缀", () => {
    render(<Field label="时间偏移" suffix="毫秒" />);
    expect(screen.getByRole("textbox", { name: "时间偏移" })).toBeInTheDocument();
    expect(screen.getByText("毫秒")).toBeVisible();
  });
});
