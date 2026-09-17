import { CircleAlert, CircleOff, LoaderCircle } from "lucide-react";
import { useId } from "react";

type WorkspaceState = "loading" | "empty" | "cancelled" | "error";

interface WorkspaceStatePanelProps {
  state: WorkspaceState;
  title: string;
  description: string;
  impact?: string;
  recovery?: string;
  className?: string;
}

const STATE_CLASSES: Record<WorkspaceState, string> = {
  loading: "border-feedback-running/30 bg-feedback-running/10",
  empty: "border-boundary bg-surface-inset",
  cancelled: "border-feedback-warning/30 bg-feedback-warning/10",
  error: "border-feedback-danger/35 bg-feedback-danger/10"
};

const TITLE_CLASSES: Record<WorkspaceState, string> = {
  loading: "text-feedback-running",
  empty: "text-content-secondary",
  cancelled: "text-feedback-warning",
  error: "text-feedback-danger"
};

export function WorkspaceStatePanel({
  state,
  title,
  description,
  impact,
  recovery,
  className = ""
}: WorkspaceStatePanelProps) {
  const titleId = useId();
  const role = state === "loading" ? "status" : state === "error" ? "alert" : "region";

  return (
    <section
      role={role}
      aria-labelledby={titleId}
      aria-busy={state === "loading" ? true : undefined}
      className={`rounded-panel border p-3 text-ui-helper ${STATE_CLASSES[state]} ${className}`}
    >
      <div className={`flex items-center gap-2 font-medium ${TITLE_CLASSES[state]}`}>
        {state === "loading" ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
        ) : state === "error" ? (
          <CircleAlert aria-hidden="true" size={14} />
        ) : (
          <CircleOff aria-hidden="true" size={14} />
        )}
        <h3 id={titleId}>{title}</h3>
      </div>
      <p className="mt-1 leading-5 text-content-secondary">{description}</p>
      {impact ? (
        <p className="mt-1 leading-5 text-content-muted">
          <span className="font-medium text-content-secondary">影响：</span>
          {impact}
        </p>
      ) : null}
      {recovery ? (
        <p className="mt-1 leading-5 text-content-muted">
          <span className="font-medium text-content-secondary">恢复：</span>
          {recovery}
        </p>
      ) : null}
      {state === "loading" ? (
        <div
          role="progressbar"
          aria-label={title}
          className="mt-3 h-1.5 overflow-hidden rounded-control bg-surface-inset"
        >
          <div className="h-full w-2/5 animate-pulse rounded-control bg-feedback-running" />
        </div>
      ) : null}
    </section>
  );
}
