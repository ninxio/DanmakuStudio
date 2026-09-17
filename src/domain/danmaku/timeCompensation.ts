import type { CutMarker } from "./types";
import type { Milliseconds } from "../shared/time";

export function getAppliedCutGap(timeMs: Milliseconds, cutMarkers: CutMarker[]): Milliseconds {
  return cutMarkers.reduce((total, marker) => {
    if (timeMs >= marker.sourceAtMs) {
      return total + marker.targetGapMs;
    }
    return total;
  }, 0);
}

export function applyCutMapping(timeMs: Milliseconds, cutMarkers: CutMarker[]): Milliseconds {
  const sortedMarkers = [...cutMarkers].sort((left, right) => left.sourceAtMs - right.sourceAtMs);
  return timeMs + getAppliedCutGap(timeMs, sortedMarkers);
}
