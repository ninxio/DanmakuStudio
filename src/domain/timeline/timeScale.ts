/** Millisecond axes use measured width and stable clock divisions in every editor view. */
export function createTimeScale(startMs: number, endMs: number, widthPx: number) {
  const durationMs = Math.max(1, endMs - startMs);
  const desiredStep = durationMs / Math.max(1, Math.floor(widthPx / 95));
  const divisions = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000,
    300000, 600000, 900000, 1800000, 3600000
  ];
  const stepMs =
    divisions.find((step) => step >= desiredStep) ?? Math.ceil(desiredStep / 3600000) * 3600000;
  const ticks = [];
  for (let timeMs = Math.ceil(startMs / stepMs) * stepMs; timeMs <= endMs; timeMs += stepMs) {
    ticks.push({
      timeMs,
      percent: ((timeMs - startMs) / durationMs) * 100,
      label: clockLabel(timeMs, stepMs < 1000)
    });
  }
  return { durationMs, stepMs, ticks };
}

export function clockLabel(timeMs: number, milliseconds = false) {
  const value = Math.max(0, Math.round(timeMs));
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? hours + ":" : ""}${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}${milliseconds ? "." + String(value % 1000).padStart(3, "0") : ""}`;
}

export function equalizeTimeRanges(
  source: { startMs: number; endMs: number },
  target: { startMs: number; endMs: number }
) {
  const duration = Math.max(1, source.endMs - source.startMs, target.endMs - target.startMs);
  const expand = (range: typeof source) => {
    const startMs = Math.max(0, Math.round((range.startMs + range.endMs - duration) / 2));
    return { startMs, endMs: startMs + duration };
  };
  return { source: expand(source), target: expand(target) };
}
