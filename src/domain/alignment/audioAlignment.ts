import type { SyncAnchor } from "../danmaku/types";
import type { Milliseconds } from "../shared/time";
import { clampMilliseconds } from "../shared/time";
import type {
  AlignmentEvidenceAlgorithm,
  AlignmentEvidenceQuality,
  AlignmentEvidenceSignalSummary,
  AlignmentProposal,
  CutCandidate
} from "./types";

export interface AudioFeatureFrame {
  timeMs: Milliseconds;
  values: number[];
}

export interface AudioFeatureMatch {
  completeIndex: number;
  sourceIndex: number;
  completeTimeMs: Milliseconds;
  sourceTimeMs: Milliseconds;
  distance: number;
}

export interface AudioAlignmentOptions {
  matchThreshold?: number;
  minGapMs?: Milliseconds;
  maxCells?: number;
  anchorStride?: number;
}

const DEFAULT_MATCH_THRESHOLD = 0.18;
const DEFAULT_MIN_GAP_MS = 1000;
const DEFAULT_MAX_CELLS = 16_000_000;
const DEFAULT_ANCHOR_STRIDE = 8;
const FINGERPRINT_BUCKET_MS = 1000;
const MAX_COMPLETE_FINGERPRINTS_PER_KEY = 32;
const MAX_SPARSE_MATCH_CANDIDATES = 80_000;
const MIN_SPARSE_MATCHES = 3;
const MIN_SPARSE_COVERAGE = 0.25;
const OFFSET_PATH_TARGET_BLOCK_FRAMES = 24;
const OFFSET_PATH_MIN_BLOCK_FRAMES = 4;
const OFFSET_PATH_MIN_SOURCE_FRAMES = 32;
const OFFSET_PATH_STEP_DIVISOR = 4;
const OFFSET_PATH_SEARCH_MARGIN_MS = 60_000;
const OFFSET_PATH_MAX_SEARCH_MS = 240_000;
const OFFSET_PATH_MIN_OBSERVATIONS = 2;
const OFFSET_PATH_STABLE_OBSERVATIONS = 5;
const OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER = 3;
const OFFSET_PATH_STABLE_SUPPORT_RATIO = 0.7;
const TIME_MAPPING_MIN_STABLE_SPAN_MS = 10_000;

const DIRECTION_SKIP_COMPLETE = 1;
const DIRECTION_SKIP_SOURCE = 2;
const DIRECTION_MATCH = 3;

interface SparseAudioFingerprint {
  key: string;
  frameIndex: number;
  timeMs: Milliseconds;
}

interface SparseAudioCandidate {
  completeIndex: number;
  sourceIndex: number;
  completeTimeMs: Milliseconds;
  sourceTimeMs: Milliseconds;
  distance: number;
  offsetMs: number;
  offsetBucket: number;
}

interface OffsetPathObservation {
  sourceIndex: number;
  sourceTimeMs: Milliseconds;
  offsetMs: number;
  distance: number;
}

interface TimeMappingSegment {
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  offsetMs: number;
  observationCount: number;
  meanDistance: number;
}

interface TimeMappingChangePoint {
  sourceAtMs: Milliseconds;
  sourceRangeStartMs: Milliseconds;
  sourceRangeEndMs: Milliseconds;
  targetGapMs: Milliseconds;
  confidence: number;
  supportCount: number;
}

interface TimeMappingResult {
  observations: OffsetPathObservation[];
  segments: TimeMappingSegment[];
  changePoints: TimeMappingChangePoint[];
  diagnostics: string[];
}

interface SparseAudioAlignmentResult {
  matches: AudioFeatureMatch[];
  completeFingerprintCount: number;
  sourceFingerprintCount: number;
  fingerprintMatchCount: number;
  offsetClusterCount: number;
  lowConfidenceRegionCount: number;
  diagnostics: string[];
  timeMappingSegmentCount?: number;
  changePoints?: TimeMappingChangePoint[];
}

interface MultistageAudioAlignmentResult extends SparseAudioAlignmentResult {
  algorithm: AlignmentEvidenceAlgorithm;
}

export function createAudioAlignmentProposal(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): AlignmentProposal {
  if (completeFrames.length === 0 || sourceFrames.length === 0) {
    return {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: ["音频特征为空，无法对齐。"],
      evidence: {
        algorithm: "sparse-fingerprint",
        completeFingerprintCount: 0,
        sourceFingerprintCount: 0,
        fingerprintMatchCount: 0,
        monotonicMatchCount: 0,
        strongAnchorCount: 0,
        weakAnchorCount: 0,
        offsetClusterCount: 0,
        refinedCandidateCount: 0,
        lowConfidenceRegionCount: 1,
        quality: "blocked"
      }
    };
  }

  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const alignment = createMultistageAudioAlignment(completeFrames, sourceFrames, options);
  const rawCutCandidates = alignment.changePoints
    ? createCutCandidatesFromTimeMappingChanges(alignment.changePoints)
    : inferAudioCutCandidates(alignment.matches, {
        matchThreshold,
        minGapMs: options.minGapMs ?? DEFAULT_MIN_GAP_MS
      });
  const cutCandidates = refineAudioCutCandidates(rawCutCandidates);
  const anchors = createAnchorsFromMatches(alignment.matches, options.anchorStride ?? DEFAULT_ANCHOR_STRIDE, matchThreshold);
  const coverage = alignment.matches.length / Math.max(1, sourceFrames.length);
  const diagnostics = [
    ...alignment.diagnostics,
    `音频特征匹配 ${alignment.matches.length} / ${sourceFrames.length} 帧，覆盖率 ${Math.round(coverage * 100)}%。`,
    cutCandidates.length > 0
      ? `已推断 ${cutCandidates.length} 个候选缺失段。`
      : "未发现超过阈值的候选缺失段。"
  ];
  const strongAnchorCount = alignment.matches.filter((match) => match.distance <= matchThreshold * 0.5).length;
  const weakAnchorCount = alignment.matches.length - strongAnchorCount;

  return {
    anchors,
    cutCandidates,
    confidence: clampNumber(coverage, 0, 1),
    diagnostics,
    evidence: {
      algorithm: alignment.algorithm,
      completeFingerprintCount: alignment.completeFingerprintCount,
      sourceFingerprintCount: alignment.sourceFingerprintCount,
      fingerprintMatchCount: alignment.fingerprintMatchCount,
      monotonicMatchCount: alignment.matches.length,
      strongAnchorCount,
      weakAnchorCount,
      offsetClusterCount: alignment.offsetClusterCount,
      refinedCandidateCount: cutCandidates.length,
      lowConfidenceRegionCount: alignment.lowConfidenceRegionCount,
      timeMappingSegmentCount: alignment.timeMappingSegmentCount,
      confirmedChangeCount: alignment.changePoints ? cutCandidates.length : undefined,
      signals: createEvidenceSignals(alignment, cutCandidates.length),
      quality: createEvidenceQuality(coverage, strongAnchorCount, weakAnchorCount, alignment.lowConfidenceRegionCount)
    }
  };
}

export function alignSparseAudioFeatureSequences(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): AudioFeatureMatch[] {
  return createSparseAudioAlignment(completeFrames, sourceFrames, options).matches;
}

function createMultistageAudioAlignment(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): MultistageAudioAlignmentResult {
  if (sourceFrames.length >= OFFSET_PATH_MIN_SOURCE_FRAMES) {
    const offsetPath = createOffsetPathAudioAlignment(completeFrames, sourceFrames, options);
    const offsetPathCoverage = offsetPath.matches.length / Math.max(1, sourceFrames.length);
    if (offsetPath.fingerprintMatchCount >= OFFSET_PATH_MIN_OBSERVATIONS && offsetPathCoverage >= 0.6) {
      return {
        ...offsetPath,
        algorithm: "time-map-audio"
      };
    }
  }

  const sparse = createSparseAudioAlignment(completeFrames, sourceFrames, options);
  const sparseCoverage = sparse.matches.length / Math.max(1, sourceFrames.length);
  const requiredMatches = Math.min(MIN_SPARSE_MATCHES, sourceFrames.length);
  if (sparse.matches.length >= requiredMatches && sparseCoverage >= MIN_SPARSE_COVERAGE) {
    return {
      ...sparse,
      algorithm: "sparse-fingerprint"
    };
  }

  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const cellCount = (completeFrames.length + 1) * (sourceFrames.length + 1);
  if (cellCount > maxCells) {
    return {
      ...sparse,
      algorithm: "sparse-fingerprint",
      diagnostics: [
        ...sparse.diagnostics,
        `稀疏锚点不足，已跳过 ${cellCount} 个 DP 单元的密集回退以避免平方级爆炸。`
      ]
    };
  }

  const denseMatches = alignAudioFeatureSequences(completeFrames, sourceFrames, options);
  return {
    ...sparse,
    algorithm: "sparse-fingerprint-fallback",
    matches: denseMatches,
    lowConfidenceRegionCount: Math.max(
      sparse.lowConfidenceRegionCount,
      estimateLowConfidenceRegionCount(denseMatches.length, sourceFrames.length)
    ),
    diagnostics: [
      ...sparse.diagnostics,
      `稀疏锚点不足，已回退到密集 DP：${denseMatches.length} 个匹配点。`
    ]
  };
}

function createOffsetPathAudioAlignment(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): SparseAudioAlignmentResult {
  const frameStepMs = estimateFrameStepMs(sourceFrames, options);
  const blockSize = createOffsetPathBlockSize(sourceFrames.length);
  const stepSize = Math.max(1, Math.round(blockSize / OFFSET_PATH_STEP_DIVISOR));
  const rawObservations = createOffsetPathObservations(completeFrames, sourceFrames, options, blockSize, stepSize, frameStepMs);
  const timeMapping = createTimeMappingFromOffsetObservations(rawObservations, options, frameStepMs);
  const matches = expandOffsetPathMatches(completeFrames, sourceFrames, timeMapping.observations);
  const offsetClusterCount = timeMapping.segments.length;
  const lowConfidenceRegionCount = rawObservations.filter(
    (observation) => observation.distance > (options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD)
  ).length;

  return {
    matches,
    completeFingerprintCount: completeFrames.length,
    sourceFingerprintCount: sourceFrames.length,
    fingerprintMatchCount: rawObservations.length,
    offsetClusterCount,
    lowConfidenceRegionCount,
    timeMappingSegmentCount: timeMapping.segments.length,
    changePoints: timeMapping.changePoints,
    diagnostics: [
      `音频时间映射：用 ${blockSize} 帧局部窗口生成 ${rawObservations.length} 个 offset 观测。`,
      ...timeMapping.diagnostics,
      `音频时间映射：展开为 ${matches.length} 个单调匹配点。`
    ]
  };
}

function createTimeMappingFromOffsetObservations(
  observations: OffsetPathObservation[],
  options: AudioAlignmentOptions,
  frameStepMs: number
): TimeMappingResult {
  const stableObservations = stabilizeOffsetObservations(
    smoothOffsetObservations(observations),
    options.minGapMs ?? DEFAULT_MIN_GAP_MS,
    frameStepMs
  );
  const segments = createTimeMappingSegments(stableObservations, frameStepMs);
  const changePoints = createTimeMappingChangePoints(segments, options.minGapMs ?? DEFAULT_MIN_GAP_MS, frameStepMs);
  return {
    observations: stableObservations,
    segments,
    changePoints,
    diagnostics: [
      `时间映射：稳定后得到 ${segments.length} 个持续 offset 段。`,
      changePoints.length > 0
        ? `时间映射：确认 ${changePoints.length} 个持续阶跃变点。`
        : "时间映射：未确认持续阶跃变点。"
    ]
  };
}

function createTimeMappingSegments(observations: OffsetPathObservation[], frameStepMs: number): TimeMappingSegment[] {
  const segments: TimeMappingSegment[] = [];
  for (const observation of observations) {
    const offsetMs = roundToStep(observation.offsetMs, frameStepMs);
    const previous = segments.at(-1);
    if (previous && previous.offsetMs === offsetMs) {
      previous.sourceEndMs = observation.sourceTimeMs;
      previous.observationCount += 1;
      previous.meanDistance =
        (previous.meanDistance * (previous.observationCount - 1) + observation.distance) / previous.observationCount;
    } else {
      segments.push({
        sourceStartMs: observation.sourceTimeMs,
        sourceEndMs: observation.sourceTimeMs,
        offsetMs,
        observationCount: 1,
        meanDistance: observation.distance
      });
    }
  }
  return segments;
}

function createTimeMappingChangePoints(
  segments: TimeMappingSegment[],
  minGapMs: number,
  frameStepMs: number
): TimeMappingChangePoint[] {
  const changePoints: TimeMappingChangePoint[] = [];
  const minStableSpanMs = Math.max(TIME_MAPPING_MIN_STABLE_SPAN_MS, frameStepMs * OFFSET_PATH_STABLE_OBSERVATIONS);
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    const targetGapMs = current.offsetMs - previous.offsetMs;
    const currentSpanMs = Math.max(frameStepMs, current.sourceEndMs - current.sourceStartMs + frameStepMs);
    if (targetGapMs < minGapMs || currentSpanMs < minStableSpanMs) {
      continue;
    }
    const sourceAtMs = clampMilliseconds(Math.round((previous.sourceEndMs + current.sourceStartMs) / 2));
    const supportScore = clampNumber(current.observationCount / OFFSET_PATH_STABLE_OBSERVATIONS, 0, 1);
    const distanceScore = clampNumber(1 - current.meanDistance / DEFAULT_MATCH_THRESHOLD, 0, 1);
    changePoints.push({
      sourceAtMs,
      sourceRangeStartMs: previous.sourceEndMs,
      sourceRangeEndMs: current.sourceStartMs,
      targetGapMs,
      supportCount: current.observationCount,
      confidence: clampNumber(0.45 + supportScore * 0.35 + distanceScore * 0.15, 0.1, 0.98)
    });
  }
  return changePoints;
}

function createOffsetPathObservations(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions,
  blockSize: number,
  stepSize: number,
  frameStepMs: number
): OffsetPathObservation[] {
  const halfBlock = Math.floor(blockSize / 2);
  const offsetSteps = createOffsetSearchSteps(completeFrames, sourceFrames, frameStepMs);
  const observations: OffsetPathObservation[] = [];
  for (let sourceIndex = halfBlock; sourceIndex < sourceFrames.length - halfBlock; sourceIndex += stepSize) {
    const observation = findBestOffsetObservation(completeFrames, sourceFrames, sourceIndex, blockSize, offsetSteps);
    if (observation) {
      observations.push(observation);
    }
  }
  if (observations.length === 0 && sourceFrames.length > 0) {
    const observation = findBestOffsetObservation(
      completeFrames,
      sourceFrames,
      Math.floor(sourceFrames.length / 2),
      Math.min(blockSize, sourceFrames.length),
      offsetSteps
    );
    if (observation) {
      observations.push(observation);
    }
  }
  void options;
  return observations;
}

function findBestOffsetObservation(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  sourceIndex: number,
  blockSize: number,
  offsetSteps: number[]
): OffsetPathObservation | null {
  const halfBlock = Math.floor(blockSize / 2);
  let best: OffsetPathObservation | null = null;
  for (const offsetStep of offsetSteps) {
    const completeCenterIndex = sourceIndex + offsetStep;
    const sourceStart = sourceIndex - halfBlock;
    const completeStart = completeCenterIndex - halfBlock;
    if (
      sourceStart < 0 ||
      completeStart < 0 ||
      sourceStart + blockSize > sourceFrames.length ||
      completeStart + blockSize > completeFrames.length
    ) {
      continue;
    }
    let totalDistance = 0;
    for (let blockOffset = 0; blockOffset < blockSize; blockOffset += 1) {
      totalDistance += getFeatureDistance(
        completeFrames[completeStart + blockOffset],
        sourceFrames[sourceStart + blockOffset]
      );
    }
    const distance = totalDistance / blockSize;
    if (!best || distance < best.distance) {
      best = {
        sourceIndex,
        sourceTimeMs: sourceFrames[sourceIndex].timeMs,
        offsetMs: completeFrames[completeCenterIndex].timeMs - sourceFrames[sourceIndex].timeMs,
        distance
      };
    }
  }
  return best;
}

function createOffsetSearchSteps(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  frameStepMs: number
): number[] {
  const completeEndMs = completeFrames.at(-1)?.timeMs ?? 0;
  const sourceEndMs = sourceFrames.at(-1)?.timeMs ?? 0;
  const durationDeltaMs = completeEndMs - sourceEndMs;
  const minOffsetMs = Math.max(
    -OFFSET_PATH_MAX_SEARCH_MS,
    Math.min(0, durationDeltaMs) - OFFSET_PATH_SEARCH_MARGIN_MS
  );
  const maxOffsetMs = Math.min(
    OFFSET_PATH_MAX_SEARCH_MS,
    Math.max(0, durationDeltaMs) + OFFSET_PATH_SEARCH_MARGIN_MS
  );
  const minStep = Math.floor(minOffsetMs / frameStepMs);
  const maxStep = Math.ceil(maxOffsetMs / frameStepMs);
  const steps: number[] = [];
  for (let step = minStep; step <= maxStep; step += 1) {
    steps.push(step);
  }
  return steps;
}

function smoothOffsetObservations(observations: OffsetPathObservation[]): OffsetPathObservation[] {
  return observations.map((observation, index) => {
    const nearbyOffsets = observations
      .slice(Math.max(0, index - 2), Math.min(observations.length, index + 3))
      .map((item) => item.offsetMs)
      .sort((left, right) => left - right);
    return {
      ...observation,
      offsetMs: nearbyOffsets[Math.floor(nearbyOffsets.length / 2)] ?? observation.offsetMs
    };
  });
}

function stabilizeOffsetObservations(
  observations: OffsetPathObservation[],
  minGapMs: number,
  frameStepMs: number
): OffsetPathObservation[] {
  if (observations.length === 0) {
    return [];
  }
  const stable: OffsetPathObservation[] = [];
  let activeOffsetMs = roundToStep(observations[0].offsetMs, frameStepMs);
  for (let index = 0; index < observations.length; index += 1) {
    const candidateOffsetMs = roundToStep(observations[index].offsetMs, frameStepMs);
    if (candidateOffsetMs - activeOffsetMs >= minGapMs) {
      const supportCount = countOffsetSupport(observations, index, candidateOffsetMs, frameStepMs);
      const supportWindowSize = Math.min(
        observations.length - index,
        OFFSET_PATH_STABLE_OBSERVATIONS * OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER
      );
      const requiredSupport = Math.max(
        Math.min(OFFSET_PATH_STABLE_OBSERVATIONS, supportWindowSize),
        Math.ceil(supportWindowSize * OFFSET_PATH_STABLE_SUPPORT_RATIO)
      );
      if (supportCount >= requiredSupport) {
        activeOffsetMs = candidateOffsetMs;
      }
    }
    stable.push({
      ...observations[index],
      offsetMs: activeOffsetMs
    });
  }
  return stable;
}

function countOffsetSupport(
  observations: OffsetPathObservation[],
  startIndex: number,
  offsetMs: number,
  frameStepMs: number
): number {
  let count = 0;
  const endIndex = Math.min(
    observations.length,
    startIndex + OFFSET_PATH_STABLE_OBSERVATIONS * OFFSET_PATH_SUPPORT_LOOKAHEAD_MULTIPLIER
  );
  for (let index = startIndex; index < endIndex; index += 1) {
    if (Math.abs(roundToStep(observations[index].offsetMs, frameStepMs) - offsetMs) <= frameStepMs) {
      count += 1;
    }
  }
  return count;
}

function expandOffsetPathMatches(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  observations: OffsetPathObservation[]
): AudioFeatureMatch[] {
  if (observations.length === 0) {
    return [];
  }
  const matches: AudioFeatureMatch[] = [];
  let observationIndex = 0;
  for (let sourceIndex = 0; sourceIndex < sourceFrames.length; sourceIndex += 1) {
    const sourceFrame = sourceFrames[sourceIndex];
    while (
      observationIndex + 1 < observations.length &&
      Math.abs(observations[observationIndex + 1].sourceTimeMs - sourceFrame.timeMs) <=
        Math.abs(observations[observationIndex].sourceTimeMs - sourceFrame.timeMs)
    ) {
      observationIndex += 1;
    }
    const completeTimeMs = sourceFrame.timeMs + observations[observationIndex].offsetMs;
    const completeIndex = findNearestFrameIndex(completeFrames, completeTimeMs);
    if (completeIndex === null) {
      continue;
    }
    matches.push({
      completeIndex,
      sourceIndex,
      completeTimeMs: completeFrames[completeIndex].timeMs,
      sourceTimeMs: sourceFrame.timeMs,
      distance: getFeatureDistance(completeFrames[completeIndex], sourceFrame)
    });
  }
  return matches;
}

function findNearestFrameIndex(frames: AudioFeatureFrame[], timeMs: number): number | null {
  if (frames.length === 0 || timeMs < frames[0].timeMs || timeMs > frames[frames.length - 1].timeMs) {
    return null;
  }
  let bestIndex = 0;
  let bestDistance = Math.abs(frames[0].timeMs - timeMs);
  for (let index = 1; index < frames.length; index += 1) {
    const distance = Math.abs(frames[index].timeMs - timeMs);
    if (distance > bestDistance) {
      break;
    }
    bestIndex = index;
    bestDistance = distance;
  }
  return bestIndex;
}

function createOffsetPathBlockSize(sourceFrameCount: number): number {
  if (sourceFrameCount <= OFFSET_PATH_MIN_BLOCK_FRAMES) {
    return Math.max(1, sourceFrameCount);
  }
  return Math.min(OFFSET_PATH_TARGET_BLOCK_FRAMES, Math.max(OFFSET_PATH_MIN_BLOCK_FRAMES, Math.floor(sourceFrameCount / 4)));
}

function estimateFrameStepMs(frames: AudioFeatureFrame[], options: AudioAlignmentOptions): number {
  if (frames.length >= 2) {
    return Math.max(1, frames[1].timeMs - frames[0].timeMs);
  }
  return Math.max(1, Math.round(options.minGapMs ?? DEFAULT_MIN_GAP_MS));
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function createSparseAudioAlignment(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): SparseAudioAlignmentResult {
  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const completeFingerprints = createAudioFingerprints(completeFrames);
  const sourceFingerprints = createAudioFingerprints(sourceFrames);
  const candidates = createSparseAudioCandidates(completeFrames, sourceFrames, completeFingerprints, sourceFingerprints, matchThreshold);
  const offsetClusters = createOffsetClusters(candidates);
  const matches = selectMonotonicSparseMatches(candidates, offsetClusters, matchThreshold);
  const lowConfidenceRegionCount = estimateLowConfidenceRegionCount(matches.length, sourceFrames.length);
  return {
    matches,
    completeFingerprintCount: completeFingerprints.length,
    sourceFingerprintCount: sourceFingerprints.length,
    fingerprintMatchCount: candidates.length,
    offsetClusterCount: offsetClusters.size,
    lowConfidenceRegionCount,
    diagnostics: [
      `多阶段对齐：生成完整版 ${completeFingerprints.length} 个、B 站删减版 ${sourceFingerprints.length} 个稀疏音频指纹。`,
      `稀疏锚点匹配 ${candidates.length} 对，单调路径保留 ${matches.length} 个锚点，offset 簇 ${offsetClusters.size} 个。`
    ]
  };
}

function createAudioFingerprints(frames: AudioFeatureFrame[]): SparseAudioFingerprint[] {
  return frames.map((frame, frameIndex) => ({
    key: createAudioFingerprintKey(frame),
    frameIndex,
    timeMs: frame.timeMs
  }));
}

function createAudioFingerprintKey(frame: AudioFeatureFrame): string {
  const width = Math.min(4, Math.max(1, frame.values.length));
  const bins: number[] = [];
  for (let index = 0; index < width; index += 1) {
    bins.push(quantizeFeature(frame.values[index] ?? 0));
  }
  return bins.join(":");
}

function quantizeFeature(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(clampNumber(value, 0, 1) * 32);
}

function createSparseAudioCandidates(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  completeFingerprints: SparseAudioFingerprint[],
  sourceFingerprints: SparseAudioFingerprint[],
  matchThreshold: number
): SparseAudioCandidate[] {
  const completeByKey = new Map<string, SparseAudioFingerprint[]>();
  for (const fingerprint of completeFingerprints) {
    const items = completeByKey.get(fingerprint.key) ?? [];
    items.push(fingerprint);
    completeByKey.set(fingerprint.key, items);
  }

  const candidates: SparseAudioCandidate[] = [];
  for (const sourceFingerprint of sourceFingerprints) {
    const completeMatches = completeByKey.get(sourceFingerprint.key);
    if (!completeMatches) {
      continue;
    }
    for (const completeFingerprint of selectCompleteFingerprintsForKey(completeMatches)) {
      const completeFrame = completeFrames[completeFingerprint.frameIndex];
      const sourceFrame = sourceFrames[sourceFingerprint.frameIndex];
      const distance = getFeatureDistance(completeFrame, sourceFrame);
      if (distance > Math.max(matchThreshold, 0.05)) {
        continue;
      }
      const offsetMs = completeFingerprint.timeMs - sourceFingerprint.timeMs;
      candidates.push({
        completeIndex: completeFingerprint.frameIndex,
        sourceIndex: sourceFingerprint.frameIndex,
        completeTimeMs: completeFingerprint.timeMs,
        sourceTimeMs: sourceFingerprint.timeMs,
        distance,
        offsetMs,
        offsetBucket: Math.round(offsetMs / FINGERPRINT_BUCKET_MS)
      });
      if (candidates.length >= MAX_SPARSE_MATCH_CANDIDATES) {
        return candidates;
      }
    }
  }
  return candidates;
}

function selectCompleteFingerprintsForKey(items: SparseAudioFingerprint[]): SparseAudioFingerprint[] {
  if (items.length <= MAX_COMPLETE_FINGERPRINTS_PER_KEY) {
    return items;
  }
  const selected: SparseAudioFingerprint[] = [];
  const step = (items.length - 1) / (MAX_COMPLETE_FINGERPRINTS_PER_KEY - 1);
  for (let index = 0; index < MAX_COMPLETE_FINGERPRINTS_PER_KEY; index += 1) {
    selected.push(items[Math.round(index * step)]);
  }
  return selected;
}

function createOffsetClusters(candidates: SparseAudioCandidate[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const candidate of candidates) {
    counts.set(candidate.offsetBucket, (counts.get(candidate.offsetBucket) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  const accepted = new Map<number, number>();
  for (const [bucket, count] of sorted.slice(0, 24)) {
    if (count >= 2 || accepted.size < 8) {
      accepted.set(bucket, count);
    }
  }
  return accepted;
}

function selectMonotonicSparseMatches(
  candidates: SparseAudioCandidate[],
  offsetClusters: Map<number, number>,
  matchThreshold: number
): AudioFeatureMatch[] {
  const bySourceIndex = new Map<number, SparseAudioCandidate[]>();
  for (const candidate of candidates) {
    if (!offsetClusters.has(candidate.offsetBucket)) {
      continue;
    }
    const items = bySourceIndex.get(candidate.sourceIndex) ?? [];
    items.push(candidate);
    bySourceIndex.set(candidate.sourceIndex, items);
  }

  const matches: AudioFeatureMatch[] = [];
  let previousCompleteIndex = -1;
  let previousOffsetMs = Number.NEGATIVE_INFINITY;
  for (const sourceIndex of [...bySourceIndex.keys()].sort((left, right) => left - right)) {
    const group = bySourceIndex.get(sourceIndex) ?? [];
    const candidate = group
      .filter((item) => item.completeIndex > previousCompleteIndex)
      .filter((item) => item.offsetMs + FINGERPRINT_BUCKET_MS >= previousOffsetMs)
      .sort((left, right) => {
        const leftScore = scoreSparseCandidate(left, previousOffsetMs, offsetClusters, matchThreshold);
        const rightScore = scoreSparseCandidate(right, previousOffsetMs, offsetClusters, matchThreshold);
        return rightScore - leftScore || left.completeIndex - right.completeIndex;
      })[0];
    if (!candidate) {
      continue;
    }
    matches.push({
      completeIndex: candidate.completeIndex,
      sourceIndex: candidate.sourceIndex,
      completeTimeMs: candidate.completeTimeMs,
      sourceTimeMs: candidate.sourceTimeMs,
      distance: candidate.distance
    });
    previousCompleteIndex = candidate.completeIndex;
    previousOffsetMs = Math.max(previousOffsetMs, candidate.offsetMs);
  }
  return matches;
}

function scoreSparseCandidate(
  candidate: SparseAudioCandidate,
  previousOffsetMs: number,
  offsetClusters: Map<number, number>,
  matchThreshold: number
): number {
  const clusterScore = offsetClusters.get(candidate.offsetBucket) ?? 0;
  const matchScore = 1 - candidate.distance / Math.max(matchThreshold, 0.000_001);
  const offsetPenalty = Number.isFinite(previousOffsetMs)
    ? Math.abs(candidate.offsetMs - previousOffsetMs) / FINGERPRINT_BUCKET_MS
    : 0;
  return clusterScore * 3 + matchScore - offsetPenalty;
}

export function alignAudioFeatureSequences(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  options: AudioAlignmentOptions = {}
): AudioFeatureMatch[] {
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  const cellCount = (completeFrames.length + 1) * (sourceFrames.length + 1);
  if (cellCount > maxCells) {
    throw new Error(`音频特征数量过多：${cellCount} 个 DP 单元，请增大采样窗口或提高 maxCells。`);
  }

  const matchThreshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const width = sourceFrames.length + 1;
  let previous = new Float64Array(width);
  let current = new Float64Array(width);
  const directions = new Uint8Array(cellCount);

  for (let completeIndex = 1; completeIndex <= completeFrames.length; completeIndex += 1) {
    current = new Float64Array(width);
    for (let sourceIndex = 1; sourceIndex <= sourceFrames.length; sourceIndex += 1) {
      const distance = getFeatureDistance(completeFrames[completeIndex - 1], sourceFrames[sourceIndex - 1]);
      const matchScore = distance <= matchThreshold ? 1 - distance / matchThreshold : Number.NEGATIVE_INFINITY;
      const skipCompleteScore = previous[sourceIndex];
      const skipSourceScore = current[sourceIndex - 1];
      const matchedScore = previous[sourceIndex - 1] + matchScore;
      const cellOffset = completeIndex * width + sourceIndex;
      if (matchedScore >= skipCompleteScore && matchedScore >= skipSourceScore) {
        current[sourceIndex] = matchedScore;
        directions[cellOffset] = DIRECTION_MATCH;
      } else if (skipCompleteScore >= skipSourceScore) {
        current[sourceIndex] = skipCompleteScore;
        directions[cellOffset] = DIRECTION_SKIP_COMPLETE;
      } else {
        current[sourceIndex] = skipSourceScore;
        directions[cellOffset] = DIRECTION_SKIP_SOURCE;
      }
    }
    previous = current;
  }

  return backtrackMatches(completeFrames, sourceFrames, directions);
}

export function inferAudioCutCandidates(
  matches: AudioFeatureMatch[],
  options: Required<Pick<AudioAlignmentOptions, "matchThreshold" | "minGapMs">>
): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    const completeDeltaMs = current.completeTimeMs - previous.completeTimeMs;
    const sourceDeltaMs = current.sourceTimeMs - previous.sourceTimeMs;
    const missingDurationMs = Math.round(completeDeltaMs - sourceDeltaMs);
    if (missingDurationMs < options.minGapMs) {
      continue;
    }
    const sourceAtMs = estimateCutBoundaryMs(previous, current);
    const confidence = clampNumber(
      1 - (previous.distance + current.distance) / (2 * options.matchThreshold),
      0.1,
      0.95
    );
    candidates.push({
      id: `audio-gap-${candidates.length + 1}`,
      name: `音频推断差异 ${candidates.length + 1}`,
      sourceAtMs,
      sourceRangeStartMs: clampMilliseconds(previous.sourceTimeMs),
      sourceRangeEndMs: clampMilliseconds(current.sourceTimeMs),
      targetGapMs: missingDurationMs,
      confidence,
      note: `音频对齐显示完整版在 ${formatDuration(previous.completeTimeMs)} 到 ${formatDuration(current.completeTimeMs)} 之间比当前视频多出约 ${formatDuration(missingDurationMs)}，候选边界约在当前视频 ${formatDuration(sourceAtMs)}。`
    });
  }
  return mergeNearbyCandidates(candidates);
}

function createCutCandidatesFromTimeMappingChanges(changePoints: TimeMappingChangePoint[]): CutCandidate[] {
  return changePoints.map((changePoint, index) => ({
    id: `audio-gap-${index + 1}`,
    name: `音频时间映射差异 ${index + 1}`,
    sourceAtMs: changePoint.sourceAtMs,
    sourceRangeStartMs: changePoint.sourceRangeStartMs,
    sourceRangeEndMs: changePoint.sourceRangeEndMs,
    targetGapMs: changePoint.targetGapMs,
    confidence: changePoint.confidence,
    note: `音频时间映射显示 offset 在当前视频 ${formatDuration(changePoint.sourceAtMs)} 附近持续增加 ${formatDuration(
      changePoint.targetGapMs
    )}，后续 ${changePoint.supportCount} 个观测窗口保持稳定，建议在该区间试听复核。`
  }));
}

function refineAudioCutCandidates(candidates: CutCandidate[]): CutCandidate[] {
  return candidates.map((candidate) => {
    const rangeStartMs = candidate.sourceRangeStartMs ?? candidate.sourceAtMs;
    const rangeEndMs = candidate.sourceRangeEndMs ?? candidate.sourceAtMs;
    if (rangeEndMs <= rangeStartMs) {
      return candidate;
    }
    const sourceAtMs = clampMilliseconds(rangeStartMs + Math.round((rangeEndMs - rangeStartMs) / 2));
    return {
      ...candidate,
      sourceAtMs,
      confidence: clampNumber(candidate.confidence + 0.03, 0.1, 0.98),
      note: `${candidate.note} 已用相邻单调锚点给出复核区间 ${formatDuration(rangeStartMs)}-${formatDuration(rangeEndMs)}。`
    };
  });
}

function estimateLowConfidenceRegionCount(matchCount: number, sourceFrameCount: number): number {
  const unmatchedCount = Math.max(0, sourceFrameCount - matchCount);
  if (unmatchedCount === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(unmatchedCount / 5));
}

function createEvidenceQuality(
  coverage: number,
  strongAnchorCount: number,
  weakAnchorCount: number,
  lowConfidenceRegionCount: number
): AlignmentEvidenceQuality {
  if (coverage === 0 || lowConfidenceRegionCount >= 6) {
    return "blocked";
  }
  if (coverage >= 0.75 && strongAnchorCount >= weakAnchorCount && lowConfidenceRegionCount <= 1) {
    return "high";
  }
  if (coverage >= 0.45 && lowConfidenceRegionCount <= 3) {
    return "medium";
  }
  return "low";
}

function createEvidenceSignals(
  alignment: MultistageAudioAlignmentResult,
  confirmedChangeCount: number
): AlignmentEvidenceSignalSummary[] {
  return [
    {
      kind: "audio",
      status: alignment.matches.length > 0 ? "used" : "blocked",
      label: "音频时间映射",
      observations: alignment.fingerprintMatchCount,
      weight: 1,
      note:
        alignment.algorithm === "time-map-audio"
          ? `已用音频指纹建立 ${alignment.timeMappingSegmentCount ?? alignment.offsetClusterCount} 个稳定时间段，确认 ${confirmedChangeCount} 个持续变点。`
          : "已用音频指纹生成单调锚点；未进入持续时间映射路径。"
    },
    {
      kind: "visual",
      status: "notConfigured",
      label: "鲁棒视觉指纹",
      observations: 0,
      weight: 0,
      note: "当前版本未采样视觉证据；未来只作为水印/字幕降权后的辅助确认，不单独宣判删减。"
    },
    {
      kind: "danmaku",
      status: "notConfigured",
      label: "弹幕文本线索",
      observations: 0,
      weight: 0,
      note: "当前本地音频对齐未融合弹幕语义；弹幕线索仍保留为人工复核参考。"
    }
  ];
}

function estimateCutBoundaryMs(previous: AudioFeatureMatch, current: AudioFeatureMatch): Milliseconds {
  const sourceDeltaMs = Math.max(0, current.sourceTimeMs - previous.sourceTimeMs);
  return clampMilliseconds(previous.sourceTimeMs + Math.round(sourceDeltaMs / 2));
}

function backtrackMatches(
  completeFrames: AudioFeatureFrame[],
  sourceFrames: AudioFeatureFrame[],
  directions: Uint8Array
): AudioFeatureMatch[] {
  const width = sourceFrames.length + 1;
  const matches: AudioFeatureMatch[] = [];
  let completeIndex = completeFrames.length;
  let sourceIndex = sourceFrames.length;
  while (completeIndex > 0 && sourceIndex > 0) {
    const direction = directions[completeIndex * width + sourceIndex];
    if (direction === DIRECTION_MATCH) {
      const completeFrame = completeFrames[completeIndex - 1];
      const sourceFrame = sourceFrames[sourceIndex - 1];
      matches.push({
        completeIndex: completeIndex - 1,
        sourceIndex: sourceIndex - 1,
        completeTimeMs: completeFrame.timeMs,
        sourceTimeMs: sourceFrame.timeMs,
        distance: getFeatureDistance(completeFrame, sourceFrame)
      });
      completeIndex -= 1;
      sourceIndex -= 1;
    } else if (direction === DIRECTION_SKIP_COMPLETE) {
      completeIndex -= 1;
    } else {
      sourceIndex -= 1;
    }
  }
  return matches.reverse();
}

function createAnchorsFromMatches(
  matches: AudioFeatureMatch[],
  anchorStride: number,
  matchThreshold: number
): SyncAnchor[] {
  const stride = Math.max(1, Math.round(anchorStride));
  return matches
    .filter((_, index) => index % stride === 0 || index === matches.length - 1)
    .map((match, index) => ({
      id: `audio-anchor-${index + 1}`,
      sourceMs: match.sourceTimeMs,
      targetMs: match.completeTimeMs,
      confidence: clampNumber(1 - match.distance / matchThreshold, 0, 1),
      origin: "automatic"
    }));
}

function mergeNearbyCandidates(candidates: CutCandidate[]): CutCandidate[] {
  const merged: CutCandidate[] = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous && Math.abs(candidate.sourceAtMs - previous.sourceAtMs) <= 2000) {
      previous.targetGapMs += candidate.targetGapMs;
      previous.confidence = Math.min(previous.confidence, candidate.confidence);
      previous.sourceRangeStartMs = Math.min(
        previous.sourceRangeStartMs ?? previous.sourceAtMs,
        candidate.sourceRangeStartMs ?? candidate.sourceAtMs
      );
      previous.sourceRangeEndMs = Math.max(
        previous.sourceRangeEndMs ?? previous.sourceAtMs,
        candidate.sourceRangeEndMs ?? candidate.sourceAtMs
      );
      previous.note = `${previous.note} ${candidate.note}`;
    } else {
      merged.push({ ...candidate });
    }
  }
  return merged.map((candidate, index) => ({
    ...candidate,
    id: `audio-gap-${index + 1}`,
    name: `音频推断差异 ${index + 1}`
  }));
}

function getFeatureDistance(left: AudioFeatureFrame, right: AudioFeatureFrame): number {
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

function formatDuration(milliseconds: Milliseconds): string {
  const safe = clampMilliseconds(milliseconds);
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
