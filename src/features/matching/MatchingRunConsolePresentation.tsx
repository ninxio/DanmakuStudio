import { WorkspaceTabs } from "../../components/WorkspaceTabs";
import { ToolSheet } from "../../components/ToolSheet";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { useRovingFocusList } from "../../components/useRovingFocusList";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";
import { useLayoutEffect, useRef, useState, type KeyboardEventHandler } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FolderOpen,
  LoaderCircle,
  Play,
  Settings2,
  Square
} from "lucide-react";
import { TextButton } from "../../components/TextButton";
import { matchingRunGroupStatusId } from "./matchingTaskModels";
import type {
  MatchingRunConsoleGroup,
  MatchingRunConsoleModel,
  MatchingRunConsoleRow,
  MatchingRunPrimaryActionKind
} from "./matchingTaskModels";

type MatchingRunConsoleIntent =
  | { type: "primary"; action: Exclude<MatchingRunPrimaryActionKind, "focusIssue"> }
  | { type: "configure" }
  | { type: "openCandidate"; candidateId: string }
  | { type: "openDiagnosticLog" }
  | { type: "openSensitiveManifest" };

interface MatchingRunConsolePresentationProps {
  model: MatchingRunConsoleModel;
  onIntent: (intent: MatchingRunConsoleIntent) => void;
}

export function MatchingRunConsolePresentation({
  model,
  onIntent
}: MatchingRunConsolePresentationProps) {
  const [filter, setFilter] = useState<"all" | "pending" | "completed">("all");
  const groups = model.groups.filter(
    (group) =>
      filter === "all" ||
      (filter === "completed" ? group.id === "completed" : group.id !== "completed")
  );
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const queueRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusRestoreRowIdRef = useRef<string | null>(null);
  const allRows = groups.flatMap((group) => group.rows);
  const selectedRow =
    allRows.find((row) => row.id === selectedRowId) ?? firstVisibleRow(groups, completedOpen);
  const visibleRows = groups.flatMap((group) => {
    const selectedIsInGroup = group.rows.some((row) => row.id === selectedRow?.id);
    return group.id === "completed" && !completedOpen && !selectedIsInGroup ? [] : group.rows;
  });
  const rovingRows = useRovingFocusList({
    itemIds: visibleRows.map((row) => row.id),
    preferredId: selectedRow?.id ?? null,
    onEscape: () => queueRef.current?.focus()
  });

  useLayoutEffect(() => {
    const rowId = focusRestoreRowIdRef.current;
    if (rowId) {
      rowRefs.current.get(rowId)?.focus();
    }
  }, [model.groups]);

  const focusFirstIssue = () => {
    const firstIssue = model.groups
      .filter((group) => group.id === "blocked" || group.id === "review")
      .flatMap((group) => group.rows)[0];
    if (!firstIssue) return;
    setFilter("all");
    setSelectedRowId(firstIssue.id);
    window.requestAnimationFrame(() => rowRefs.current.get(firstIssue.id)?.focus());
  };

  return (
    <section
      className="workspace-page"
      aria-label="匹配结果"
      data-testid="matching-run-console"
    >
      <header className="page-heading">
        <div className="flex w-full flex-wrap items-center gap-3">
          <div className="mr-auto min-w-[14rem]">
            <div className="flex items-center gap-2">
              {model.runBar.running ? (
                <LoaderCircle size={16} className="animate-spin text-accent-cyan" />
              ) : model.runBar.restartRequired || model.runBar.blockerCount > 0 ? (
                <CircleAlert size={16} className="text-accent-yellow" />
              ) : (
                <CheckCircle2 size={16} className="text-accent-green" />
              )}
              <h2>匹配</h2>
            </div>
            <p className="mt-1 text-ui-caption leading-5 text-content-muted">
              {model.runBar.running
                ? "分析在后台继续，你可以随时切换工作区。"
                : model.runBar.blockerCount > 0
                  ? "匹配结果已保留。可以查看覆盖并采用，未定位部分单独显示。"
                  : "分析参考素材与原片的时间关系。"}
            </p>
          </div>
          <TextButton onClick={() => onIntent({ type: "configure" })}>
            <Settings2 size={14} />
            调整范围
          </TextButton>
          <TextButton
            tone={model.primaryAction.kind === "cancel" ? "danger" : "primary"}
            disabled={model.primaryAction.disabled}
            data-testid="matching-primary-action"
            onClick={() => {
              if (model.primaryAction.kind === "focusIssue") {
                focusFirstIssue();
                return;
              }
              onIntent({ type: "primary", action: model.primaryAction.kind });
            }}
          >
            <PrimaryIcon kind={model.primaryAction.kind} />
            {model.primaryAction.label}
          </TextButton>
        </div>
      </header>

      <div className="workspace-bar">
        <WorkspaceTabs
          label="匹配结果分类"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setSelectedRowId(null);
            if (value === "completed") setCompletedOpen(true);
          }}
          items={[
            {
              id: "all",
              label: "全部",
              count: model.groups.reduce((sum, group) => sum + group.rows.length, 0)
            },
            {
              id: "pending",
              label: "待处理",
              count: model.groups
                .filter((g) => g.id !== "completed")
                .reduce((sum, g) => sum + g.rows.length, 0)
            },
            {
              id: "completed",
              label: "已完成",
              count: model.groups.find((g) => g.id === "completed")?.rows.length ?? 0
            }
          ]}
        />
        <span className="text-xs text-content-muted" data-testid="matching-summary">
          {model.runBar.selectedSourceCount} 个参考 → {model.runBar.selectedTargetCount} 个原片
          · {model.runBar.selectedPairCount} 组关系 · {model.runBar.audioReadyCount} /{" "}
          {model.runBar.selectedMediaCount} 音轨就绪
        </span>
      </div>
      <div className="matching-results-layout">
        <aside
          ref={queueRef}
          tabIndex={-1}
          className="matching-result-list thin-scrollbar"
          aria-label="批量匹配任务"
          data-testid="matching-task-queue"
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <h3 className="text-xs font-semibold text-content-secondary">运行队列</h3>
            <span className="text-ui-caption text-content-muted">异常优先</span>
          </div>
          {model.diagnosticJobId ? (
            <details
              className="mb-2 rounded border border-panel-line bg-surface-inset px-2 py-1.5 text-ui-caption text-content-muted"
              open={diagnosticsOpen}
            >
              <summary
                className="cursor-pointer text-content-muted"
                onClick={(event) => {
                  event.preventDefault();
                  setDiagnosticsOpen((open) => !open);
                }}
              >
                批次诊断与运行编号
              </summary>
              {diagnosticsOpen ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span>
                    运行编号：
                    <code className="text-content-secondary">{model.diagnosticJobId}</code>
                  </span>
                  <TextButton
                    className="h-7"
                    onClick={() => onIntent({ type: "openDiagnosticLog" })}
                  >
                    <FolderOpen size={13} />
                    打开可分享日志
                  </TextButton>
                  <TextButton
                    className="h-7"
                    onClick={() => onIntent({ type: "openSensitiveManifest" })}
                  >
                    <FolderOpen size={13} />
                    打开本机训练证据
                  </TextButton>
                </div>
              ) : null}
            </details>
          ) : null}
          {groups.length === 0 ? (
            <div className="rounded border border-dashed border-panel-line p-4 text-center text-ui-caption leading-5 text-content-muted">
              <div className="font-medium text-content-secondary">还没有运行记录</div>
              当前所选素材准备好后，可从上方开始一个批次。
            </div>
          ) : (
            <div className="grid gap-2">
              {groups.map((group) => {
                const selectedIsInGroup = group.rows.some((row) => row.id === selectedRowId);
                const collapsed =
                  group.id === "completed" && !completedOpen && !selectedIsInGroup;
                return (
                  <section key={group.id} aria-label={`${group.title} ${group.rows.length} 个`}>
                    {group.id === "completed" ? (
                      <Button
                        tone="unstyled"
                        type="button"
                        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-ui-caption font-medium text-content-muted hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
                        aria-expanded={!collapsed}
                        onClick={() => setCompletedOpen((open) => !open)}
                      >
                        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        {collapsed ? "展开" : "收起"}
                        {group.title} {group.rows.length} 个
                      </Button>
                    ) : (
                      <div className="px-1 py-1 text-ui-caption font-medium text-content-muted">
                        {group.title} · {group.rows.length}
                      </div>
                    )}
                    {collapsed ? null : (
                      <div className="grid gap-1">
                        {group.rows.map((row) => (
                          <TaskRow
                            key={row.id}
                            row={row}
                            selected={selectedRow?.id === row.id}
                            buttonRef={(element) => {
                              if (element) rowRefs.current.set(row.id, element);
                              else rowRefs.current.delete(row.id);
                              rovingRows.setItemRef(row.id, element);
                            }}
                            onFocus={() => {
                              focusRestoreRowIdRef.current = row.id;
                              rovingRows.onItemFocus(row.id);
                            }}
                            onBlur={(relatedTarget) => {
                              if (relatedTarget) focusRestoreRowIdRef.current = null;
                            }}
                            onSelect={() => setSelectedRowId(row.id)}
                            tabIndex={rovingRows.getItemTabIndex(row.id)}
                            onKeyDown={(event) => rovingRows.onItemKeyDown(event, row.id)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </aside>

        <article
          className="matching-result-detail thin-scrollbar"
          aria-label="当前匹配任务"
          data-testid="matching-task-detail"
        >
          {selectedRow ? (
            <CurrentTask row={selectedRow} onIntent={onIntent} />
          ) : (
            <div className="flex h-full min-h-40 flex-col items-center justify-center rounded border border-dashed border-panel-line text-center">
              <Play size={20} className="text-content-subtle" />
              <h3 className="mt-2 text-sm font-medium text-content-secondary">等待开始匹配</h3>
              <p className="mt-1 max-w-md text-ui-caption leading-5 text-content-muted">
                默认分析已准备好的素材。需要时可调整范围、计算设备和多版本关系。
              </p>
              <TextButton className="mt-3" onClick={() => onIntent({ type: "configure" })}>
                <Settings2 size={13} />
                匹配范围与计算设置
              </TextButton>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function TaskRow({
  row,
  selected,
  buttonRef,
  onFocus,
  onBlur,
  onSelect,
  tabIndex,
  onKeyDown
}: {
  row: MatchingRunConsoleRow;
  selected: boolean;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onBlur: (relatedTarget: EventTarget | null) => void;
  onSelect: () => void;
  tabIndex: 0 | -1;
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
}) {
  return (
    <div
      className={`rounded border ${selected ? "border-accent-cyan/60 bg-accent-cyan/10" : "border-transparent bg-surface-inset"}`}
    >
      <Button
        tone="unstyled"
        ref={buttonRef}
        type="button"
        data-testid="matching-run-row"
        className="w-full rounded px-2 py-1.5 text-left hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-cyan"
        aria-pressed={selected}
        tabIndex={tabIndex}
        onClick={onSelect}
        onFocus={onFocus}
        onBlur={(event) => onBlur(event.relatedTarget)}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-content-secondary">
            {row.title}
          </span>
          <Badge
            tone={getStatusVocabulary(matchingRunGroupStatusId(row.group)).tone}
            title={row.stageLabel}
          >
            {row.stateLabel}
          </Badge>
        </div>
        <div data-testid="batch-task-message" className="sr-only">
          {row.message}
        </div>
        <div className="mt-1 flex items-center gap-2 text-ui-caption text-content-subtle">
          {row.group === "running" ? (
            <LoaderCircle size={11} className="animate-spin text-accent-cyan" />
          ) : null}
          <span>
            {row.group === "waiting" ? row.stageLabel : `${Math.round(row.progress * 100)}%`}
          </span>
        </div>
      </Button>
    </div>
  );
}

function CurrentTask({
  row,
  onIntent
}: {
  row: MatchingRunConsoleRow;
  onIntent: MatchingRunConsolePresentationProps["onIntent"];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <div className="grid content-start gap-5">
      <div>
        <Badge tone={getStatusVocabulary(matchingRunGroupStatusId(row.group)).tone}>
          {row.stateLabel}
        </Badge>
        <h3 className="mt-3 break-words text-lg font-semibold text-content-primary">
          {row.title}
        </h3>
        <p className="mt-2 text-sm text-content-muted">
          {row.candidateId ? row.message : row.nextAction}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {row.candidateId ? (
          <TextButton
            tone="primary"
            onClick={() => onIntent({ type: "openCandidate", candidateId: row.candidateId! })}
          >
            进入编辑工作台
            <ArrowRight size={14} />
          </TextButton>
        ) : row.group === "blocked" ? (
          <TextButton onClick={() => onIntent({ type: "configure" })}>调整本次匹配</TextButton>
        ) : null}
        <TextButton onClick={() => setDetailsOpen(true)}>结果详情与运行记录</TextButton>
      </div>
      {row.group === "running" && (
        <progress max={1} value={row.progress} aria-label="当前分析进度" className="w-full" />
      )}
      <ToolSheet
        title="结果详情与运行记录"
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      >
        <dl className="grid gap-4">
          <div>
            <dt className="text-content-muted">当前阶段</dt>
            <dd>{row.stageLabel}</dd>
          </div>
          <div>
            <dt className="text-content-muted">结果与原因</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words leading-6">{row.message}</dd>
          </div>
          <div>
            <dt className="text-content-muted">下一步</dt>
            <dd>{row.nextAction}</dd>
          </div>
        </dl>
        {row.logs.length > 0 && (
          <pre
            className="mt-5 whitespace-pre-wrap break-words text-xs leading-5"
            aria-label="脱敏运行诊断"
          >
            {row.logs.join("\n")}
          </pre>
        )}
      </ToolSheet>
    </div>
  );
}

function PrimaryIcon({ kind }: { kind: MatchingRunPrimaryActionKind }) {
  if (kind === "cancel") return <Square size={13} />;
  if (kind === "focusIssue" || kind === "resolveAudio" || kind === "restart") {
    return <CircleAlert size={13} />;
  }
  if (kind === "continue") return <ArrowRight size={13} />;
  return <Play size={13} />;
}

function firstVisibleRow(
  groups: MatchingRunConsoleGroup[],
  completedOpen: boolean
): MatchingRunConsoleRow | null {
  for (const group of groups) {
    if (group.id === "completed" && !completedOpen) continue;
    if (group.rows[0]) return group.rows[0];
  }
  return null;
}
