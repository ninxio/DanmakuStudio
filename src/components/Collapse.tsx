import { useRef, type DetailsHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

interface CollapseProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "children"> {
  summary: ReactNode;
  children: ReactNode;
  summaryClassName?: string;
  contentClassName?: string;
}

export function Collapse({
  summary,
  children,
  className = "",
  summaryClassName = "",
  contentClassName = "",
  ...props
}: CollapseProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const handleSummaryKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    if (detailsRef.current) {
      detailsRef.current.open = !detailsRef.current.open;
    }
  };
  return (
    <details
      {...props}
      ref={detailsRef}
      className={`rounded-panel border border-boundary bg-surface-soft ${className}`}
    >
      <summary
        className={`cursor-pointer select-none rounded-control text-content-secondary ${summaryClassName}`}
        onKeyDown={handleSummaryKeyDown}
      >
        {summary}
      </summary>
      <div className={contentClassName}>{children}</div>
    </details>
  );
}
