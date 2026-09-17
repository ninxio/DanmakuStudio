import { ProjectSidebar } from "../features/workspace/ProjectSidebar";
import { createEmptyProject } from "../domain/project/factory";
import { createUsabilityViewModel } from "../domain/project/usabilityViewModel";
import { createInitialProjectLibrarySessionState } from "../application/projectLibrarySessionController";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ToolSheet } from "./ToolSheet";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { WorkspaceTabs } from "./WorkspaceTabs";

describe("workspace tools", () => {
  it("页签方向键切换与回绕，不冒泡移动时间线", () => {
    const parentKey = vi.fn();
    function Tabs() {
      const [value, setValue] = useState("first");
      return (
        <div onKeyDown={parentKey}>
          <WorkspaceTabs
            label="工作面"
            value={value}
            onChange={setValue}
            items={[
              { id: "first", label: "预览" },
              { id: "second", label: "时间线" }
            ]}
          />
        </div>
      );
    }
    render(<Tabs />);
    const preview = screen.getByRole("tab", { name: "预览" });
    const timeline = screen.getByRole("tab", { name: "时间线" });
    preview.focus();
    fireEvent.keyDown(preview, { key: "ArrowRight" });
    expect(timeline).toHaveFocus();
    expect(timeline).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(preview).toHaveFocus();
    expect(parentKey).not.toHaveBeenCalled();
  });

  it("全禁用菜单仍可聚焦，并用 Escape 返回触发器", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    render(
      <WorkspaceMenu
        label="编辑操作"
        items={[{ id: "disabled", label: "拆分", disabled: true, onSelect: action }]}
      />
    );
    const trigger = screen.getByRole("button", { name: "编辑操作" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowUp}{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(action).not.toHaveBeenCalled();
  });

  it("工具内菜单 Escape 只关闭菜单；Tab 与 Shift+Tab 封闭在工具内", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(
      <ToolSheet title="精确工具" open onClose={close}>
        <WorkspaceMenu
          label="段操作"
          items={[{ id: "copy", label: "复制", onSelect: vi.fn() }]}
        />
        <button>保存草稿</button>
      </ToolSheet>
    );
    const dialog = screen.getByRole("dialog", { name: "精确工具" });
    const trigger = within(dialog).getByRole("button", { name: "段操作" });
    await user.click(trigger);
    expect(dialog).toContainElement(screen.getByRole("menu"));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    const first = within(dialog).getByRole("button", { name: "关闭精确工具" });
    const last = within(dialog).getByRole("button", { name: "保存草稿" });
    last.focus();
    await user.tab();
    expect(first).toHaveFocus();
    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

it("项目工具初始聚焦标题后，关闭仍返回原触发器", async () => {
  const user = userEvent.setup();
  const project = createEmptyProject("焦点回归");
  const model = createUsabilityViewModel(project);
  const library = { ...createInitialProjectLibrarySessionState(), focusRequestSequence: 1 };
  function Harness() {
    const [open, setOpen] = useState(false);
    const headingRef = useRef<HTMLDivElement>(null);
    return (
      <>
        <button onClick={() => setOpen(true)}>打开项目工具</button>
        <ToolSheet
          title="项目与分集"
          open={open}
          onClose={() => setOpen(false)}
          initialFocusRef={headingRef}
        >
          <ProjectSidebar
            project={project}
            model={model}
            library={library}
            onLibraryIntent={vi.fn()}
            headingFocusRef={headingRef}
          />
        </ToolSheet>
      </>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "打开项目工具" });
  await user.click(trigger);
  expect(screen.getByTestId("project-sidebar-heading")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "关闭项目与分集" }));
  expect(trigger).toHaveFocus();
});
