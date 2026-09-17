import { CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  applicationTaskRegistry,
  type ApplicationTask
} from "../../application/backgroundTasks/applicationTaskRegistry";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ProgressBar } from "../../components/ProgressBar";
import { getStatusVocabulary } from "../../domain/shared/statusVocabulary";

export function BackgroundTaskBar() {
  const snapshot = useSyncExternalStore(
    (listener) => applicationTaskRegistry.subscribe(listener),
    () => applicationTaskRegistry.getSnapshot(),
    () => applicationTaskRegistry.getSnapshot()
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now);
  const primary = snapshot.tasks.find((task) => task.id === snapshot.primaryTaskId) ?? null;
  const applicationStatus = snapshot.tasks.find((task) => task.source === "status") ?? null;

  useEffect(() => {
    if (!detailsOpen && !snapshot.tasks.some((task) => task.statusId === "running")) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [detailsOpen, snapshot.tasks]);

  return (
    <footer
      className="relative flex h-8 shrink-0 items-center border-t border-panel-line bg-surface-canvas px-3 text-ui-caption"
      data-testid="status-bar"
      aria-live="polite"
    >
      <span className="mr-2 shrink-0 rounded border border-panel-line bg-surface-raised px-1.5 py-0.5 text-ui-caption font-semibold uppercase tracking-[0.12em] text-content-muted">
        后台任务
      </span>
      {primary ? (
        <>
          <TaskStateIcon task={primary} />
          <span
            data-testid="background-task-primary"
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <strong className="shrink-0 font-medium text-content-primary">
              {primary.title}
            </strong>
            <BadgeForTask task={primary} />
            <span className="min-w-0 truncate text-content-muted" title={primary.phase}>
              {primary.phase}
            </span>
            {applicationStatus && applicationStatus.id !== primary.id ? (
              <span
                className="min-w-0 max-w-[36%] truncate border-l border-boundary pl-2 text-content-muted"
                title={applicationStatus.phase}
              >
                {applicationStatus.phase}
              </span>
            ) : null}
          </span>
          {primary.progress !== null ? (
            <span className="ml-3 shrink-0 font-mono text-ui-caption text-content-muted">
              {formatProgress(primary.progress)}
            </span>
          ) : null}
          <span className="ml-3 shrink-0 text-content-muted">共 {snapshot.totalCount} 项</span>
          <Button
            tone="unstyled"
            type="button"
            aria-label="查看全部后台任务"
            aria-expanded={detailsOpen}
            aria-controls="background-task-details"
            onClick={() => setDetailsOpen((open) => !open)}
            className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-control border border-boundary px-1.5 py-0.5 text-ui-caption text-content-secondary transition hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-feedback-running"
          >
            任务中心
            <ChevronDown
              size={11}
              aria-hidden="true"
              className={`transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            />
          </Button>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-content-muted">暂无后台任务</span>
      )}
      {detailsOpen ? (
        <section
          id="background-task-details"
          role="region"
          aria-label="全部后台任务"
          className="absolute bottom-[calc(100%+0.375rem)] left-3 right-3 z-40 max-h-[55vh] overflow-y-auto rounded-panel border border-boundary-strong bg-surface-raised p-3 text-xs shadow-2xl"
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <strong className="text-content-primary">
              全部后台任务 · {snapshot.totalCount} 项
            </strong>
            <Button
              tone="unstyled"
              type="button"
              aria-label="收起全部后台任务"
              onClick={() => setDetailsOpen(false)}
              className="inline-flex h-6 w-6 items-center justify-center rounded-control text-content-muted hover:bg-surface-soft hover:text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-feedback-running"
            >
              <X size={13} aria-hidden="true" />
            </Button>
          </div>
          <div className="grid gap-2">
            {snapshot.tasks.map((task) => (
              <TaskRow key={task.id} task={task} nowMs={nowMs} />
            ))}
          </div>
        </section>
      ) : null}
      {primary?.progress !== null && primary?.progress !== undefined ? (
        <span
          className="absolute inset-x-0 bottom-0 h-px bg-feedback-running/20"
          aria-hidden="true"
        >
          <span
            className="block h-full bg-feedback-running transition-[width]"
            style={{ width: `${Math.max(0, Math.min(1, primary.progress)) * 100}%` }}
          />
        </span>
      ) : null}
    </footer>
  );
}

function TaskRow({ task, nowMs }: { task: ApplicationTask; nowMs: number }) {
  return (
    <article className="grid gap-2 rounded-panel border border-boundary bg-surface-soft p-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <TaskStateIcon task={task} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-content-primary">{task.title}</strong>
            <BadgeForTask task={task} />
            <span className="text-ui-caption text-content-muted">
              耗时 {formatElapsed(Math.max(0, nowMs - task.startedAtMs))}
            </span>
          </div>
          <p className="mt-1 break-words leading-5 text-content-secondary">{task.phase}</p>
          {task.error ? (
            <p className="mt-1 whitespace-pre-wrap break-words leading-5 text-feedback-danger">
              {task.error}
            </p>
          ) : null}
        </div>
      </div>
      {task.progress !== null ? (
        <ProgressBar label={`${task.title}进度`} value={task.progress} max={1} />
      ) : null}
      {task.actions.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-2">
          {task.actions.map((action) => (
            <Button
              key={action.id}
              size="small"
              tone={action.kind === "cancel" ? "danger" : "neutral"}
              onClick={() => applicationTaskRegistry.runAction(task.id, action.id)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function BadgeForTask({ task }: { task: ApplicationTask }) {
  const state = getStatusVocabulary(task.statusId);
  return (
    <Badge tone={state.tone} title={state.description} className="shrink-0 whitespace-nowrap">
      {state.label}
    </Badge>
  );
}

function TaskStateIcon({ task }: { task: ApplicationTask }) {
  const className =
    task.statusId === "blocked"
      ? "text-feedback-danger"
      : task.statusId === "actionRequired" || task.statusId === "reviewRequired"
        ? "text-feedback-warning"
        : task.statusId === "running" || task.statusId === "preparing"
          ? "text-feedback-running"
          : "text-feedback-success";
  return (
    <span className={`mt-0.5 shrink-0 ${className}`} aria-hidden="true">
      {task.statusId === "running" || task.statusId === "preparing" ? (
        <LoaderCircle size={13} className="animate-spin" />
      ) : task.statusId === "blocked" ||
        task.statusId === "actionRequired" ||
        task.statusId === "reviewRequired" ? (
        <CircleAlert size={13} />
      ) : (
        <CheckCircle2 size={13} />
      )}
    </span>
  );
}

function formatProgress(progress: number): string {
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}秒`;
  return `${minutes}分${String(remainingSeconds).padStart(2, "0")}秒`;
}
