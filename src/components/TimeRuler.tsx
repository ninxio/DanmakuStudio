import { useEffect, useRef, useState } from "react";
import { createTimeScale } from "../domain/timeline/timeScale";

export function TimeRuler({
  startMs,
  endMs,
  label,
  grid = false
}: {
  startMs: number;
  endMs: number;
  label: string;
  grid?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width || 800);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = createTimeScale(startMs, endMs, width);
  return (
    <div
      ref={ref}
      className={grid ? "time-grid" : "time-ruler"}
      role={grid ? "presentation" : "img"}
      aria-label={grid ? undefined : label}
      aria-hidden={grid || undefined}
      data-duration-ms={scale.durationMs}
      data-step-ms={scale.stepMs}
    >
      {scale.ticks.map((tick) => (
        <span
          key={tick.timeMs}
          className="time-ruler-tick"
          data-time-ms={tick.timeMs}
          style={{ left: `${tick.percent}%` }}
        >
          {!grid && (
            <span
              style={{
                transform:
                  tick.percent < 5
                    ? "none"
                    : tick.percent > 95
                      ? "translateX(-100%)"
                      : "translateX(-50%)"
              }}
            >
              {tick.label}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
