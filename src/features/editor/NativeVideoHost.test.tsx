import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NativeVideoHost } from "./NativeVideoHost";

describe("NativeVideoHost", () => {
  it("只承载原生画面 bounds，不成为鼠标、键盘或拖放交互目标", () => {
    const onHostRef = vi.fn();
    render(
      <NativeVideoHost
        accessibleLabel="参考 A libmpv 应用内画面"
        onHostRef={onHostRef}
      >
        参考 A 正在应用内准备画面。
      </NativeVideoHost>
    );

    const host = screen.getByRole("img", { name: "参考 A libmpv 应用内画面" });
    expect(host).toHaveClass("pointer-events-none");
    expect(host).not.toHaveAttribute("tabindex");
    expect(host).toHaveAttribute("draggable", "false");
    expect(onHostRef).toHaveBeenCalledWith(host);
  });
});
