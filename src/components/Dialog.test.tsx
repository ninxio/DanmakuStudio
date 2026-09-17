import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        打开设置
      </button>
      {open ? (
        <Dialog
          ariaLabel="设置"
          onClose={() => setOpen(false)}
          initialFocusRef={initialFocusRef}
          returnFocusRef={triggerRef}
        >
          <input ref={initialFocusRef} aria-label="项目名称" />
          <button type="button" onClick={() => setOpen(false)}>
            保存
          </button>
        </Dialog>
      ) : null}
    </>
  );
}

describe("Dialog", () => {
  it("提供 modal 语义、初始焦点、Tab 焦点陷阱与关闭回焦", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开设置" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "设置" });
    const input = screen.getByRole("textbox", { name: "项目名称" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "设置" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

it("Escape only closes the top dialog and closed disclosure contents are skipped", async () => {
  const user = userEvent.setup();
  const parentClose = vi.fn();
  function Nested() {
    const [child, setChild] = useState(false);
    return (
      <Dialog ariaLabel="外层" onClose={parentClose}>
        <button onClick={() => setChild(true)}>打开内层</button>
        <details>
          <summary>折叠选项</summary>
          <button>隐藏选项</button>
        </details>
        {child && (
          <Dialog ariaLabel="内层" onClose={() => setChild(false)}>
            <button>内层动作</button>
          </Dialog>
        )}
      </Dialog>
    );
  }
  render(<Nested />);
  const trigger = screen.getByRole("button", { name: "打开内层" });
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "内层" })).not.toBeInTheDocument();
  expect(parentClose).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
  fireEvent.keyDown(trigger, { key: "Tab", shiftKey: true });
  expect(screen.getByText("折叠选项")).toHaveFocus();
});
