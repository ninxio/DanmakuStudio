import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "running" | "success" | "warning" | "danger";

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: ReactNode;
  className?: string;
  title?: string;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "border-boundary bg-surface-inset text-content-muted",
  running: "border-feedback-running/40 bg-feedback-running/10 text-feedback-running",
  success: "border-feedback-success/40 bg-feedback-success/10 text-feedback-success",
  warning: "border-feedback-warning/40 bg-feedback-warning/10 text-feedback-warning",
  danger: "border-feedback-danger/40 bg-feedback-danger/10 text-feedback-danger",
};

export function Badge({ children, tone = "neutral", icon, className = "", title }: BadgeProps) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={`inline-flex min-h-5 items-center gap-1 rounded-control border px-2 py-0.5 text-ui-caption font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {icon}
      <span>{children}</span>
    </span>
  );
}
