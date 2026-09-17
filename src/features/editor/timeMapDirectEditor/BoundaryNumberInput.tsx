import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import { formatTimecode } from "../../../domain/shared/time";

interface BoundaryNumberInputProps {
  label: string;
  value: number;
  frameRate: number;
  onChange: (value: number) => void;
  onStep: (deltaMs: number) => void;
  stepLabel: string;
}

export function BoundaryNumberInput({
  label,
  value,
  frameRate,
  onChange,
  onStep,
  stepLabel
}: BoundaryNumberInputProps) {
  const [timecodeValue, setTimecodeValue] = useState(() => formatTimecode(value));

  useEffect(() => {
    setTimecodeValue(formatTimecode(value));
  }, [value]);

  const commitTimecode = () => {
    const parsed = parseBoundaryTimecode(timecodeValue);
    if (parsed === null) {
      setTimecodeValue(formatTimecode(value));
      return;
    }
    onChange(parsed);
  };

  return (
    <div className="grid gap-1">
      <label className="grid gap-1 text-ui-caption text-feedback-running/80">
        {label}（毫秒）
        <input
          className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-ui-caption tabular-nums text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
          type="number"
          step={1}
          value={value}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) onChange(Math.round(next));
          }}
        />
      </label>
      <div className="grid grid-cols-2 gap-1">
        <label className="grid gap-1 text-ui-caption text-feedback-running/70">
          {label}（时间码）
          <input
            className="h-7 min-w-0 rounded border border-panel-line bg-surface-inset px-1.5 text-ui-caption tabular-nums text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
            type="text"
            inputMode="numeric"
            value={timecodeValue}
            onChange={(event) => setTimecodeValue(event.currentTarget.value)}
            onBlur={commitTimecode}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label className="grid gap-1 text-ui-caption text-feedback-running/70">
          {label}（帧）
          <input
            className="h-7 min-w-0 rounded border border-panel-line bg-surface-inset px-1.5 text-ui-caption tabular-nums text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
            type="number"
            step={1}
            value={Math.round((value * frameRate) / 1000)}
            onChange={(event) => {
              const nextFrame = event.currentTarget.valueAsNumber;
              if (Number.isFinite(nextFrame)) {
                onChange(Math.round((nextFrame * 1000) / frameRate));
              }
            }}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <Button
          tone="unstyled"
          type="button"
          className="rounded border border-panel-line px-1.5 py-1 text-ui-caption text-content-secondary hover:bg-surface-soft"
          aria-label={`${stepLabel}向前 100 毫秒`}
          onClick={() => onStep(-100)}
        >
          −100 ms
        </Button>
        <Button
          tone="unstyled"
          type="button"
          className="rounded border border-panel-line px-1.5 py-1 text-ui-caption text-content-secondary hover:bg-surface-soft"
          aria-label={`${stepLabel}向后 100 毫秒`}
          onClick={() => onStep(100)}
        >
          +100 ms
        </Button>
      </div>
    </div>
  );
}

function parseBoundaryTimecode(value: string): number | null {
  const match = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, hoursText, minutesText, secondsText, millisecondsText = "0"] = match;
  const milliseconds = Number(millisecondsText.padEnd(3, "0"));
  const total =
    Number(hoursText) * 3_600_000 +
    Number(minutesText) * 60_000 +
    Number(secondsText) * 1000 +
    milliseconds;
  return Number.isSafeInteger(total) ? total : null;
}
