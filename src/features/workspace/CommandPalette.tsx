import { Button } from "../../components/Button";
import { CornerDownLeft, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Dialog } from "../../components/Dialog";
import {
  WORKSPACE_SHORTCUTS,
  searchWorkspaceCommands,
  type WorkspaceCommand,
  type WorkspaceCommandIntent
} from "./workspaceCommands";

interface CommandPaletteProps {
  commands: readonly WorkspaceCommand[];
  onClose: () => void;
  onExecute: (intent: WorkspaceCommandIntent) => void;
  returnFocusRef: RefObject<HTMLButtonElement>;
}

export function CommandPalette({
  commands,
  onClose,
  onExecute,
  returnFocusRef
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const filteredCommands = useMemo(
    () => searchWorkspaceCommands(commands, query),
    [commands, query]
  );
  const enabledIndexes = useMemo(
    () => filteredCommands.flatMap((command, index) => (command.enabled ? [index] : [])),
    [filteredCommands]
  );
  const showShortcutHelp = query.trim() === "" || filteredCommands.length === 0;

  useEffect(() => {
    setActiveIndex((current) =>
      current >= 0 && filteredCommands[current]?.enabled ? current : (enabledIndexes[0] ?? -1)
    );
  }, [enabledIndexes, filteredCommands]);

  const execute = (command: WorkspaceCommand | undefined): void => {
    if (!command?.enabled) {
      return;
    }
    onExecute(command.intent);
    onClose();
  };

  const moveActive = (direction: 1 | -1): void => {
    if (enabledIndexes.length === 0) {
      return;
    }
    const currentPosition = enabledIndexes.indexOf(activeIndex);
    const nextPosition =
      currentPosition < 0
        ? direction > 0
          ? 0
          : enabledIndexes.length - 1
        : (currentPosition + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPosition] ?? -1);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      execute(filteredCommands[activeIndex]);
      return;
    }
  };

  return (
    <Dialog
      ariaLabel="命令与快捷键"
      onClose={onClose}
      initialFocusRef={searchRef}
      returnFocusRef={returnFocusRef}
      overlayClassName="items-start px-4 pt-[8vh] backdrop-blur-sm"
      className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border-boundary-strong/80 bg-surface-raised"
      onKeyDownCapture={handleKeyDown}
    >
      <div className="border-b border-boundary/80 p-3">
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <div>
            <h2 className="text-sm font-semibold text-content-primary">命令与快捷键</h2>
            <p className="text-xs text-content-muted">搜索操作，或使用快捷键快速切换。</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="command-search">
            <Search size={16} aria-hidden="true" className="shrink-0 text-feedback-running" />
            <input
              ref={searchRef}
              role="combobox"
              aria-label="搜索命令"
              aria-controls={resultsId}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex >= 0 ? `${resultsId}-${activeIndex}` : undefined
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入“素材”“导出”或“撤销”…"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-content-primary outline-none placeholder:text-content-subtle"
            />
            <kbd className="rounded border border-boundary-strong bg-surface-soft px-1.5 py-0.5 text-ui-caption text-content-muted">
              Esc
            </kbd>
          </label>
          <Button
            tone="unstyled"
            type="button"
            onClick={onClose}
            aria-label="关闭命令入口"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-boundary text-content-secondary transition hover:border-boundary-strong hover:bg-surface-soft"
          >
            <X size={17} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div
        className={`grid min-h-0 flex-1 ${showShortcutHelp ? "md:grid-cols-[minmax(0,1.05fr)_minmax(18rem,0.95fr)]" : "grid-cols-1"}`}
      >
        <section className="min-h-0 overflow-y-auto border-boundary/80 p-3 md:border-r">
          <h3 className="mb-2 px-2 text-ui-caption font-semibold uppercase tracking-[0.14em] text-content-subtle">
            命令
          </h3>
          <div id={resultsId} role="listbox" aria-label="命令结果" className="space-y-1">
            {filteredCommands.map((command, index) => {
              const reasonId = command.disabledReason
                ? `${resultsId}-${index}-reason`
                : undefined;
              return (
                <div
                  id={`${resultsId}-${index}`}
                  key={command.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={activeIndex === index}
                  aria-disabled={!command.enabled}
                  aria-describedby={reasonId}
                  onMouseMove={() => command.enabled && setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => execute(command)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                    command.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-55"
                  } ${
                    activeIndex === index
                      ? "border-feedback-running/70 bg-feedback-running/10"
                      : "border-transparent hover:border-boundary hover:bg-surface-soft/70"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-content-primary">
                      {command.label}
                    </span>
                    <span className="block text-xs leading-5 text-content-muted">
                      {command.description}
                    </span>
                    {command.disabledReason ? (
                      <span id={reasonId} className="block text-xs text-feedback-warning">
                        {command.disabledReason}
                      </span>
                    ) : null}
                  </span>
                  {command.shortcut ? (
                    <kbd className="shrink-0 rounded border border-boundary-strong bg-surface-canvas px-1.5 py-0.5 text-ui-caption text-content-secondary">
                      {command.shortcut}
                    </kbd>
                  ) : (
                    command.enabled && (
                      <CornerDownLeft
                        size={14}
                        aria-hidden="true"
                        className="shrink-0 text-content-subtle"
                      />
                    )
                  )}
                </div>
              );
            })}
          </div>
          {filteredCommands.length === 0 ? (
            <p
              role="status"
              className="rounded-xl border border-dashed border-boundary px-3 py-5 text-center text-sm text-content-muted"
            >
              没有匹配命令，可从右侧快捷键帮助继续。
            </p>
          ) : null}
        </section>

        {showShortcutHelp ? (
          <section
            className="min-h-0 overflow-y-auto p-3"
            aria-labelledby="shortcut-help-heading"
          >
            <h3
              id="shortcut-help-heading"
              className="mb-2 px-2 text-ui-caption font-semibold uppercase tracking-[0.14em] text-content-subtle"
            >
              快捷键
            </h3>
            <div className="space-y-1.5">
              {WORKSPACE_SHORTCUTS.map((shortcut) => (
                <div
                  key={shortcut.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-lg px-2 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-content-secondary">
                      {shortcut.label}
                    </span>
                    <span className="block text-ui-caption leading-4 text-content-subtle">
                      {shortcut.description}
                    </span>
                  </span>
                  <kbd className="rounded border border-boundary-strong bg-surface-canvas px-1.5 py-0.5 text-ui-caption text-content-secondary">
                    {shortcut.displayKeys}
                  </kbd>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
