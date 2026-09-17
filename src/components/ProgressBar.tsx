interface ProgressBarProps {
  label: string;
  value: number;
  max?: number;
  showValue?: boolean;
  className?: string;
}

export function ProgressBar({
  label,
  value,
  max = 100,
  showValue = true,
  className = "",
}: ProgressBarProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const safeValue = Math.min(safeMax, Math.max(0, Number.isFinite(value) ? value : 0));
  const percent = Math.round((safeValue / safeMax) * 100);
  return (
    <div className={`grid gap-1 ${className}`}>
      {showValue ? (
        <div className="flex items-center justify-between gap-2 text-ui-caption text-content-muted">
          <span>{label}</span>
          <span>{percent}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={safeValue}
        className="h-2 overflow-hidden rounded-control bg-surface-inset"
      >
        <div
          className="h-full rounded-control bg-feedback-running"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
