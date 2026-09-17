export interface VisualFeatureFrame {
  timeMs: number;
  values: number[];
}

export interface VisualEvidenceSummary {
  observations: number;
  supportedObservations: number;
  meanDistance: number;
  supportRatio: number;
}

export interface VisualEvidenceAnchor {
  sourceMs: number;
  targetMs: number;
}

const VISUAL_SAMPLE_WIDTH = 32;
const VISUAL_SAMPLE_HEIGHT = 18;
const VISUAL_GRID_COLUMNS = 4;
const VISUAL_GRID_ROWS = 2;
const VISUAL_MATCH_THRESHOLD = 0.16;
const DEFAULT_VISUAL_SAMPLE_INTERVAL_MS = 5000;

export function createRobustVisualFeatureFrame(timeMs: number, pixels: Uint8Array): VisualFeatureFrame {
  if (pixels.length !== VISUAL_SAMPLE_WIDTH * VISUAL_SAMPLE_HEIGHT) {
    throw new Error("视觉特征需要 32x18 灰度采样帧。");
  }
  return {
    timeMs,
    values: createRobustVisualValues(pixels)
  };
}

export function summarizeVisualEvidence(
  completeFrames: VisualFeatureFrame[],
  sourceFrames: VisualFeatureFrame[],
  anchors: VisualEvidenceAnchor[]
): VisualEvidenceSummary | null {
  if (completeFrames.length === 0 || sourceFrames.length === 0 || anchors.length === 0) {
    return null;
  }
  const maxDistanceMs = Math.max(estimateFrameStepMs(completeFrames), estimateFrameStepMs(sourceFrames)) * 2;
  const stride = Math.max(1, Math.floor(anchors.length / 160));
  let observations = 0;
  let supportedObservations = 0;
  let totalDistance = 0;
  for (let index = 0; index < anchors.length; index += stride) {
    const anchor = anchors[index];
    const completeFrame = findNearestFrame(completeFrames, anchor.targetMs);
    const sourceFrame = findNearestFrame(sourceFrames, anchor.sourceMs);
    if (!completeFrame || !sourceFrame) {
      continue;
    }
    if (
      Math.abs(completeFrame.timeMs - anchor.targetMs) > maxDistanceMs ||
      Math.abs(sourceFrame.timeMs - anchor.sourceMs) > maxDistanceMs
    ) {
      continue;
    }
    const distance = getVisualFeatureDistance(completeFrame, sourceFrame);
    observations += 1;
    totalDistance += distance;
    if (distance <= VISUAL_MATCH_THRESHOLD) {
      supportedObservations += 1;
    }
  }
  if (observations === 0) {
    return null;
  }
  return {
    observations,
    supportedObservations,
    meanDistance: totalDistance / observations,
    supportRatio: supportedObservations / observations
  };
}

export function getVisualFeatureDistance(left: VisualFeatureFrame, right: VisualFeatureFrame): number {
  const width = Math.max(left.values.length, right.values.length);
  if (width === 0) {
    return 1;
  }
  let total = 0;
  for (let index = 0; index < width; index += 1) {
    const delta = (left.values[index] ?? 0) - (right.values[index] ?? 0);
    total += delta * delta;
  }
  return Math.sqrt(total / width);
}

function createRobustVisualValues(pixels: Uint8Array): number[] {
  const totals = Array.from({ length: VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS }, () => 0);
  const counts = Array.from({ length: VISUAL_GRID_COLUMNS * VISUAL_GRID_ROWS }, () => 0);
  for (let y = 0; y < VISUAL_SAMPLE_HEIGHT; y += 1) {
    for (let x = 0; x < VISUAL_SAMPLE_WIDTH; x += 1) {
      if (!isCoreVisualPixel(x, y)) {
        continue;
      }
      const column = Math.min(VISUAL_GRID_COLUMNS - 1, Math.floor((x * VISUAL_GRID_COLUMNS) / VISUAL_SAMPLE_WIDTH));
      const row = Math.min(VISUAL_GRID_ROWS - 1, Math.floor(((y - 1) * VISUAL_GRID_ROWS) / 13));
      const index = row * VISUAL_GRID_COLUMNS + column;
      totals[index] += pixels[y * VISUAL_SAMPLE_WIDTH + x] / 255;
      counts[index] += 1;
    }
  }
  const globalCount = Math.max(1, counts.reduce((total, count) => total + count, 0));
  const globalMean = totals.reduce((total, value) => total + value, 0) / globalCount;
  return totals.map((total, index) => (counts[index] === 0 ? globalMean : total / counts[index]));
}

function isCoreVisualPixel(x: number, y: number): boolean {
  if (x < 2 || x >= VISUAL_SAMPLE_WIDTH - 2 || y === 0 || y >= 14) {
    return false;
  }
  return !(x >= 24 && y <= 5);
}

function estimateFrameStepMs(frames: VisualFeatureFrame[]): number {
  if (frames.length >= 2) {
    return Math.max(1, frames[1].timeMs - frames[0].timeMs);
  }
  return DEFAULT_VISUAL_SAMPLE_INTERVAL_MS;
}

function findNearestFrame(frames: VisualFeatureFrame[], timeMs: number): VisualFeatureFrame | null {
  if (frames.length === 0) {
    return null;
  }
  let best = frames[0];
  let bestDistance = Math.abs(best.timeMs - timeMs);
  for (const frame of frames.slice(1)) {
    const distance = Math.abs(frame.timeMs - timeMs);
    if (distance >= bestDistance) {
      break;
    }
    best = frame;
    bestDistance = distance;
  }
  return best;
}
