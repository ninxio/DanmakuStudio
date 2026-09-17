import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SHORTCUTS,
  createWorkspaceCommands,
  resolveWorkspaceShortcut,
  searchWorkspaceCommands,
} from "./workspaceCommands";

const commandContext = {
  currentPage: "matching" as const,
  canUndo: false,
  canRedo: true,
  projectSidebarCollapsed: false,
  contextPanelCollapsed: true,
};

describe("workspaceCommands", () => {
  it("describes four route commands and real shell actions with explicit availability", () => {
    const commands = createWorkspaceCommands(commandContext);

    expect(
      commands
        .filter((command) => command.intent.type === "navigate")
        .map((command) => command.intent),
    ).toEqual([
      { type: "navigate", page: "materials" },
      { type: "navigate", page: "matching" },
      { type: "navigate", page: "editing" },
      { type: "navigate", page: "export" },
    ]);
    expect(commands.find((command) => command.id === "go-matching")).toMatchObject({
      enabled: false,
      disabledReason: "当前已在匹配页",
    });
    expect(commands.find((command) => command.id === "undo")).toMatchObject({
      enabled: false,
      disabledReason: "当前没有可撤销的操作",
    });
    expect(commands.find((command) => command.id === "redo")).toMatchObject({
      enabled: true,
      intent: { type: "redo" },
    });
    expect(commands.find((command) => command.id === "toggle-project-sidebar")).toMatchObject({
      enabled: true,
      intent: { type: "toggle-project-sidebar" },
    });
  });

  it("searches labels, descriptions, and Chinese workflow keywords without hiding disabled results", () => {
    const commands = createWorkspaceCommands(commandContext);

    expect(searchWorkspaceCommands(commands, "原片").map((command) => command.id)).toEqual([
      "go-materials",
    ]);
    expect(searchWorkspaceCommands(commands, "当前批次").map((command) => command.id)).toEqual([
      "go-matching",
    ]);
    expect(searchWorkspaceCommands(commands, "撤销").map((command) => command.id)).toContain(
      "undo",
    );
  });

  it("reserves Ctrl+K for commands and makes the moved split shortcut discoverable", () => {
    const baseEvent = {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    };

    expect(resolveWorkspaceShortcut(baseEvent)).toBe("command-palette");
    expect(resolveWorkspaceShortcut({ ...baseEvent, shiftKey: true })).toBe("split-clips");
    expect(WORKSPACE_SHORTCUTS.find((shortcut) => shortcut.id === "command-palette")).toMatchObject({
      displayKeys: "Ctrl+K",
      label: "打开命令入口",
    });
    expect(WORKSPACE_SHORTCUTS.find((shortcut) => shortcut.id === "split-clips")).toMatchObject({
      displayKeys: "Ctrl+Shift+K",
      label: "在播放头处分割",
    });
  });
});
