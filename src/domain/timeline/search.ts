import type { ResolvedDanmakuEvent } from "../danmaku/types";
import type { Milliseconds } from "../shared/time";

export interface DensityBucket {
  startMs: Milliseconds;
  endMs: Milliseconds;
  count: number;
}

export function lowerBoundByTime(events: ResolvedDanmakuEvent[], timeMs: Milliseconds): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].finalTimeMs < timeMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function upperBoundByTime(events: ResolvedDanmakuEvent[], timeMs: Milliseconds): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (events[mid].finalTimeMs <= timeMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function getEventsInRange(
  events: ResolvedDanmakuEvent[],
  startMs: Milliseconds,
  endMs: Milliseconds
): ResolvedDanmakuEvent[] {
  const startIndex = lowerBoundByTime(events, startMs);
  const endIndex = upperBoundByTime(events, endMs);
  return events.slice(startIndex, endIndex);
}

export function chooseBucketSizeMs(pixelsPerSecond: number): Milliseconds {
  if (pixelsPerSecond < 18) {
    return 30_000;
  }
  if (pixelsPerSecond < 45) {
    return 10_000;
  }
  if (pixelsPerSecond < 130) {
    return 1_000;
  }
  if (pixelsPerSecond < 420) {
    return 500;
  }
  return 100;
}

export function aggregateDensity(
  events: ResolvedDanmakuEvent[],
  startMs: Milliseconds,
  endMs: Milliseconds,
  bucketSizeMs: Milliseconds
): DensityBucket[] {
  const safeBucketSize = Math.max(1, bucketSizeMs);
  const firstBucketStart = Math.floor(startMs / safeBucketSize) * safeBucketSize;
  const bucketCount = Math.max(1, Math.ceil((endMs - firstBucketStart) / safeBucketSize));
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    startMs: firstBucketStart + index * safeBucketSize,
    endMs: firstBucketStart + (index + 1) * safeBucketSize,
    count: 0
  }));
  const visible = getEventsInRange(events, firstBucketStart, endMs);
  for (const event of visible) {
    if (!event.enabled) {
      continue;
    }
    const index = Math.floor((event.finalTimeMs - firstBucketStart) / safeBucketSize);
    if (index >= 0 && index < buckets.length) {
      buckets[index].count += 1;
    }
  }
  return buckets;
}
