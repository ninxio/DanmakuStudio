import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import { createWorkspaceCommands, type WorkspaceCommandIntent } from "./workspaceCommands";

function PaletteHarness({ onExecute }: { onExecute: (intent: WorkspaceCommandIntent) => void }) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const commands = createWorkspaceCommands({
    currentPage: "materials",
    canUndo: true,
    canRedo: false,
    projectSidebarCollapsed: false,
    contextPanelCollapsed: false,
  });

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        命令
      </button>
      {open ? (
        <CommandPalette
          commands={commands}
          onClose={() => setOpen(false)}
          onExecute={onExecute}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </>
  );
}

describe("CommandPalette", () => {
  it("打开即聚焦搜索，并在空查询中展示集中快捷键与禁用原因", () => {
    render(<PaletteHarness onExecute={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "命令与快捷键" });
    const search = within(dialog).getByRole("combobox", { name: "搜索命令" });
    const results = within(dialog).getByRole("listbox", { name: "命令结果" });
    const activeOptionId = search.getAttribute("aria-activedescendant");
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-controls", results.id);
    expect(activeOptionId).not.toBeNull();
    expect(document.getElementById(activeOptionId ?? "")).toHaveRole("option");
    expect(document.getElementById(activeOptionId ?? "")).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("heading", { name: "快捷键" })).toBeInTheDocument();
    expect(within(dialog).getByText("Ctrl+K")).toBeInTheDocument();
    expect(within(dialog).getByText("Ctrl+Shift+K")).toBeInTheDocument();
    expect(within(results).getByRole("option", { name: /前往素材页/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(dialog).getByText("当前已在素材页")).toBeInTheDocument();
  });

  it("搜索不丢焦点，方向键与 Enter 执行当前可用命令", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn();
    render(<PaletteHarness onExecute={onExecute} />);
    const search = screen.getByRole("combobox", { name: "搜索命令" });

    await user.type(search, "前往");
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /前往编辑页/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onExecute).toHaveBeenCalledWith({ type: "navigate", page: "editing" });
    expect(screen.queryByRole("dialog", { name: "命令与快捷键" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "命令" })).toHaveFocus();
  });

  it("Tab 被限制在对话框内，Escape 关闭并返回工具栏入口", () => {
    render(<PaletteHarness onExecute={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "命令与快捷键" });
    const search = within(dialog).getByRole("combobox", { name: "搜索命令" });

    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "命令与快捷键" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "命令" })).toHaveFocus();
  });
});
