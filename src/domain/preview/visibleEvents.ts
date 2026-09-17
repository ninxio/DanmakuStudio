import type { ResolvedDanmakuEvent } from "../danmaku/types";
import type { Milliseconds } from "../shared/time";
import { getEventsInRange } from "../timeline/search";

export const ROLLING_DANMAKU_DURATION_MS = 8000;
export const STATIC_DANMAKU_DURATION_MS = 4500;
export const MAX_PREVIEW_DANMAKU_EVENTS = 80;

export function getPreviewEvents(
  events: ResolvedDanmakuEvent[],
  currentTimeMs: Milliseconds,
  limit = MAX_PREVIEW_DANMAKU_EVENTS
): ResolvedDanmakuEvent[] {
  return getEventsInRange(
    events,
    currentTimeMs - ROLLING_DANMAKU_DURATION_MS,
    currentTimeMs + 500
  )
    .filter((event) => {
      if (!event.enabled) {
        return false;
      }
      const duration = getPreviewEventDurationMs(event);
      return (
        event.finalTimeMs <= currentTimeMs && currentTimeMs <= event.finalTimeMs + duration
      );
    })
    .slice(0, limit);
}

export function getPreviewEventDurationMs(event: ResolvedDanmakuEvent): Milliseconds {
  const mode = event.item.mode ?? 1;
  return mode === 4 || mode === 5 ? STATIC_DANMAKU_DURATION_MS : ROLLING_DANMAKU_DURATION_MS;
}
