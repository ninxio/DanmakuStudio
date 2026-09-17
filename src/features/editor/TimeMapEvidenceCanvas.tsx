import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../components/useTheme";
import type { AlignmentEvidenceProfile } from "../../domain/alignment/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  drawTimeMapEvidenceCanvas,
  evidenceSampleSummary
} from "./timeMapDirectEditor/evidenceCanvasModel";

export interface TimeMapEvidenceCanvasProps {
  samples: AlignmentEvidenceProfile["samples"];
  rangeStartMs: number;
  rangeEndMs: number;
  label: string;
}

export function TimeMapEvidenceCanvas({
  samples,
  rangeStartMs,
  rangeEndMs,
  label
}: TimeMapEvidenceCanvasProps) {
  const { revision: themeRevision } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<AlignmentEvidenceProfile["samples"][number] | null>(
    null
  );
  const [hoverLeft, setHoverLeft] = useState(50);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawTimeMapEvidenceCanvas(canvas, samples, rangeStartMs, rangeEndMs);
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [samples, rangeStartMs, rangeEndMs, themeRevision]);

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        role="img"
        aria-label={label}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (bounds.width <= 0) return;
          const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
          const timeMs = rangeStartMs + ratio * (rangeEndMs - rangeStartMs);
          setHovered(
            samples.find((sample) => timeMs >= sample.startMs && timeMs < sample.endMs) ?? null
          );
          setHoverLeft(Math.max(10, Math.min(90, ratio * 100)));
        }}
        onMouseLeave={() => setHovered(null)}
      />
      {hovered ? (
        <div
          className="pointer-events-none absolute bottom-full z-30 mb-1 w-max max-w-72 -translate-x-1/2 rounded border border-boundary-strong bg-surface-inset/95 px-2 py-1 text-ui-caption leading-4 text-content-secondary shadow-xl"
          style={{ left: hoverLeft + "%" }}
          role="tooltip"
        >
          <div className="font-medium">{evidenceSampleSummary(hovered)}</div>
          <div className="text-content-muted">
            {formatTimecode(hovered.startMs)}–{formatTimecode(hovered.endMs)}
            {hovered.offsetMs === null
              ? ""
              : " · 时间差 " + formatSignedDuration(hovered.offsetMs)}
            {hovered.visualSupport === undefined
              ? ""
              : " · 画面支持 " + Math.round(hovered.visualSupport * 100) + "%"}
            {hovered.visualRecoveryState === "recovered" && hovered.visualMatchMs !== undefined
              ? " · 画面定位到 " + formatTimecode(hovered.visualMatchMs)
              : hovered.visualRecoveryState === "ambiguous"
                ? " · 画面存在重复候选"
                : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatSignedDuration(durationMs: number) {
  const prefix = durationMs > 0 ? "+" : durationMs < 0 ? "−" : "";
  return prefix + (Math.abs(durationMs) / 1_000).toFixed(3) + " 秒";
}
