import { useId, type ReactNode } from "react";

interface PanelProps {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, action, children, className = "" }: PanelProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={`flex min-h-0 flex-col border-boundary bg-surface-base ${className}`}
    >
      {title ? (
        <header className="workspace-panel-heading flex shrink-0 items-center justify-between border-b border-boundary">
          <h2
            id={titleId}
            className="truncate text-ui-body font-semibold text-content-secondary"
          >
            {title}
          </h2>
          {action}
        </header>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
