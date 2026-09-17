import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextInput } from "./TextInput";

describe("TextInput", () => {
  it("转发原生输入属性和可读名称", () => {
    render(<TextInput aria-label="搜索素材" placeholder="输入文件名" />);
    expect(screen.getByRole("textbox", { name: "搜索素材" })).toHaveAttribute(
      "placeholder",
      "输入文件名",
    );
  });
});
