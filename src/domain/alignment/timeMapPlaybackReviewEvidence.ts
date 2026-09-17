import type { EditorProject, MediaTimeMap } from "../project/types";
import { sha256Hex } from "../shared/sha256";
import { isCompleteTimeMapSpanEvidence, type TimeMapSpan } from "./timeMap";
import {
  createTimeMapPlaybackBoundaryContext,
  createTimeMapPlaybackSpanPlan,
  intervalForAxis,
  type TimeMapPlaybackAxis,
  type TimeMapPlaybackInterval
} from "./timeMapPlayback";
import {
  readTimeMapSpanReviewDecision,
  reconcileCandidateTimeMapManualReview
} from "./timeMapReviewDecision";

export const TIME_MAP_PLAYBACK_REVIEW_POLICY_VERSION = 2;
export const MATCHED_MINIMUM_EFFECTIVE_MS = 2_000;
export const MATCHED_MINIMUM_COVERED_MS = 1_500;
export const DIFFERENCE_SPAN_MINIMUM_EFFECTIVE_MS = 2_000;
export const DIFFERENCE_SPAN_MINIMUM_COVERED_MS = 1_500;
export const BOUNDARY_MINIMUM_EFFECTIVE_MS = 1_500;
export const BOUNDARY_MINIMUM_COVERED_MS = 1_000;
export const PLAYBACK_OBSERVATION_MAX_WALL_GAP_MS = 750;
export const TIME_MAP_PLAYBACK_REVIEW_MAX_RANGES_PER_SLOT = 256;
export const TIME_MAP_PLAYBACK_REVIEW_MAX_TOKEN_LENGTH = 65_536;

const PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v2:";
const LEGACY_PLAYBACK_REVIEW_PREFIX = "manual-playback-review:v1:";
const PLAYBACK_OBSERVATION_RATE_TOLERANCE = 1.35;
const PLAYBACK_OBSERVATION_JITTER_MS = 120;
const MAX_SLOT_EFFECTIVE_MS = 6 * 60 * 60 * 1_000;

export type TimeMapPlaybackReviewScope = "span" | "startBoundary" | "endBoundary";
export type TimeMapPlaybackReviewSlot = `${TimeMapPlaybackReviewScope}:${TimeMapPlaybackAxis}`;

export interface TimeMapPlaybackSlotProgress {
  effectiveDurationMs: number;
  coveredRanges: TimeMapPlaybackInterval[];
}

export interface TimeMapSpanPlaybackEvidence {
  evidenceVersion: 2;
  slots: Record<TimeMapPlaybackReviewSlot, TimeMapPlaybackSlotProgress>;
}

export interface TimeMapPlaybackObservation {
  scope: TimeMapPlaybackReviewScope;
  axis: TimeMapPlaybackAxis;
  positionMs: number;
  observedAtMs: number;
  playing: boolean;
  visible: boolean;
}

export interface TimeMapPlaybackAccumulatorState {
  lastObservation: TimeMapPlaybackObservation | null;
}

export interface TimeMapPlaybackAccumulationResult {
  evidence: TimeMapSpanPlaybackEvidence;
  accumulator: TimeMapPlaybackAccumulatorState;
  creditedDurationMs: number;
  reason: "credited" | "seeded" | "paused" | "hidden" | "stalled" | "discontinuity" | "invalid";
}

export interface TimeMapSpanPlaybackRequirement {
  slot: TimeMapPlaybackReviewSlot;
  scope: TimeMapPlaybackReviewScope;
  axis: TimeMapPlaybackAxis;
  label: string;
  interval: TimeMapPlaybackInterval;
  minimumEffectiveMs: number;
  minimumCoveredMs: number;
}

export interface TimeMapSpanPlaybackRequirementProgress extends TimeMapSpanPlaybackRequirement {
  effectiveDurationMs: number;
  coveredDurationMs: number;
  complete: boolean;
}

export interface RecordedTimeMapSpanPlaybackReview extends TimeMapSpanPlaybackEvidence {
  spanIndex: number;
  spanDigest: string;
  policyVersion: number;
  reviewedAt: string;
  token: string;
}

const PLAYBACK_SCOPES: readonly TimeMapPlaybackReviewScope[] = [
  "span",
  "startBoundary",
  "endBoundary"
];
const PLAYBACK_AXES: readonly TimeMapPlaybackAxis[] = ["source", "target"];
const PLAYBACK_SLOTS = PLAYBACK_SCOPES.flatMap((scope) =>
  PLAYBACK_AXES.map((axis): TimeMapPlaybackReviewSlot => `${scope}:${axis}`)
);

export function createEmptyTimeMapSpanPlaybackEvidence(): TimeMapSpanPlaybackEvidence {
  const slots = {} as Record<TimeMapPlaybackReviewSlot, TimeMapPlaybackSlotProgress>;
  for (const slot of PLAYBACK_SLOTS) {
    slots[slot] = { effectiveDurationMs: 0, coveredRanges: [] };
  }
  return {
    evidenceVersion: 2,
    slots
  };
}

export function resetTimeMapPlaybackAccumulator(): TimeMapPlaybackAccumulatorState {
  return { lastObservation: null };
}

/**
 * 只累计可观察到的前向媒体时间推进。暂停、后台、倒退、seek、大幅跳跃或事件循环
 * 长时间停滞均重置采样基线，不会转化为试听时长。
 */
export function accumulateTimeMapPlaybackObservation(
  evidence: TimeMapSpanPlaybackEvidence,
  accumulator: TimeMapPlaybackAccumulatorState,
  observation: TimeMapPlaybackObservation,
  interval: TimeMapPlaybackInterval
): TimeMapPlaybackAccumulationResult {
  const normalizedEvidence = normalizeEvidence(evidence);
  if (!isValidObservation(observation) || !isValidInterval(interval)) {
    return result(normalizedEvidence, null, 0, "invalid");
  }
  const clampedObservation = {
    ...observation,
    positionMs: clampPosition(observation.positionMs, interval)
  };
  if (!observation.playing) {
    return result(normalizedEvidence, null, 0, "paused");
  }
  if (!observation.visible) {
    return result(normalizedEvidence, null, 0, "hidden");
  }
  const previous = accumulator.lastObservation;
  if (
    !previous ||
    previous.scope !== observation.scope ||
    previous.axis !== observation.axis ||
    !previous.playing ||
    !previous.visible
  ) {
    return result(normalizedEvidence, clampedObservation, 0, "seeded");
  }
  const wallDeltaMs = observation.observedAtMs - previous.observedAtMs;
  const mediaDeltaMs = clampedObservation.positionMs - previous.positionMs;
  if (wallDeltaMs <= 0 || mediaDeltaMs < 0) {
    return result(normalizedEvidence, clampedObservation, 0, "discontinuity");
  }
  if (mediaDeltaMs === 0) {
    return wallDeltaMs <= PLAYBACK_OBSERVATION_MAX_WALL_GAP_MS
      ? result(normalizedEvidence, previous, 0, "stalled")
      : result(normalizedEvidence, clampedObservation, 0, "discontinuity");
  }
  const maximumPlausibleMediaDeltaMs =
    wallDeltaMs * PLAYBACK_OBSERVATION_RATE_TOLERANCE + PLAYBACK_OBSERVATION_JITTER_MS;
  if (
    wallDeltaMs > PLAYBACK_OBSERVATION_MAX_WALL_GAP_MS ||
    mediaDeltaMs > maximumPlausibleMediaDeltaMs
  ) {
    return result(normalizedEvidence, clampedObservation, 0, "discontinuity");
  }
  const slot = createSlot(observation.scope, observation.axis);
  const currentProgress = normalizedEvidence.slots[slot];
  const coveredRanges = mergeRanges([
    ...currentProgress.coveredRanges,
    { startMs: previous.positionMs, endMs: clampedObservation.positionMs }
  ]);
  if (coveredRanges.length > TIME_MAP_PLAYBACK_REVIEW_MAX_RANGES_PER_SLOT) {
    return result(normalizedEvidence, clampedObservation, 0, "invalid");
  }
  const nextProgress: TimeMapPlaybackSlotProgress = {
    effectiveDurationMs: Math.min(
      MAX_SLOT_EFFECTIVE_MS,
      currentProgress.effectiveDurationMs + mediaDeltaMs
    ),
    coveredRanges
  };
  return result(
    {
      ...normalizedEvidence,
      slots: { ...normalizedEvidence.slots, [slot]: nextProgress }
    },
    clampedObservation,
    mediaDeltaMs,
    "credited"
  );
}

export function createTimeMapSpanPlaybackRequirements(
  timeMap: MediaTimeMap,
  spanIndex: number
): TimeMapSpanPlaybackRequirement[] {
  const span = requireSpan(timeMap, spanIndex);
  const plan = createTimeMapPlaybackSpanPlan(span);
  const requirements: TimeMapSpanPlaybackRequirement[] = [];
  const spanAxes: TimeMapPlaybackAxis[] =
    span.kind === "sourceOnly"
      ? ["source"]
      : span.kind === "targetOnly"
        ? ["target"]
        : ["source", "target"];
  for (const axis of spanAxes) {
    const interval = intervalForAxis(plan, axis);
    if (!interval) continue;
    requirements.push(
      createRequirement(
        "span",
        axis,
        span.kind === "matched"
          ? axis === "source"
            ? "共同内容 · 参考 A"
            : "共同内容 · 原片 B"
          : axis === "source"
            ? "差异内容 · 参考 A"
            : "差异内容 · 原片 B",
        interval,
        span.kind === "matched"
          ? MATCHED_MINIMUM_EFFECTIVE_MS
          : DIFFERENCE_SPAN_MINIMUM_EFFECTIVE_MS,
        span.kind === "matched"
          ? MATCHED_MINIMUM_COVERED_MS
          : DIFFERENCE_SPAN_MINIMUM_COVERED_MS
      )
    );
  }
  if (span.kind !== "matched") {
    const sourceRange = {
      startMs: timeMap.sourceStartMs,
      endMs: timeMap.sourceEndMs
    };
    const targetRange = {
      startMs: timeMap.targetStartMs,
      endMs: timeMap.targetEndMs
    };
    for (const scope of ["startBoundary", "endBoundary"] as const) {
      const context = createTimeMapPlaybackBoundaryContext(
        span,
        scope,
        sourceRange,
        targetRange
      );
      for (const axis of PLAYBACK_AXES) {
        requirements.push(
          createRequirement(
            scope,
            axis,
            `${scope === "startBoundary" ? "段首" : "段尾"}边界 · ${axis === "source" ? "参考 A" : "原片 B"}`,
            axis === "source" ? context.sourceInterval : context.targetInterval,
            BOUNDARY_MINIMUM_EFFECTIVE_MS,
            BOUNDARY_MINIMUM_COVERED_MS
          )
        );
      }
    }
  }
  return requirements;
}

export function assessTimeMapSpanPlaybackEvidence(
  timeMap: MediaTimeMap,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence
): TimeMapSpanPlaybackRequirementProgress[] {
  const normalizedEvidence = normalizeEvidence(evidence);
  return createTimeMapSpanPlaybackRequirements(timeMap, spanIndex).map((requirement) => {
    const progress = normalizedEvidence.slots[requirement.slot];
    const coveredDurationMs = measureCoveredDuration(progress.coveredRanges);
    return {
      ...requirement,
      effectiveDurationMs: progress.effectiveDurationMs,
      coveredDurationMs,
      complete:
        progress.effectiveDurationMs >= requirement.minimumEffectiveMs &&
        coveredDurationMs >= requirement.minimumCoveredMs
    };
  });
}

export function describeMissingTimeMapSpanPlaybackEvidence(
  timeMap: MediaTimeMap,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence
): string[] {
  return assessTimeMapSpanPlaybackEvidence(timeMap, spanIndex, evidence)
    .filter((progress) => !progress.complete)
    .map((progress) => {
      const missingEffectiveMs = Math.max(
        0,
        progress.minimumEffectiveMs - progress.effectiveDurationMs
      );
      const missingCoveredMs = Math.max(
        0,
        progress.minimumCoveredMs - progress.coveredDurationMs
      );
      const parts: string[] = [];
      if (missingEffectiveMs > 0)
        parts.push(`有效播放还差 ${formatSeconds(missingEffectiveMs)}`);
      if (missingCoveredMs > 0) parts.push(`新增覆盖还差 ${formatSeconds(missingCoveredMs)}`);
      return `${progress.label}（${parts.join("，")}）`;
    });
}

export function recordCandidateTimeMapSpanPlaybackReview(
  project: EditorProject,
  timeMapId: string,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence,
  reviewedAt: string
): EditorProject {
  const timeMap = project.mediaTimeMaps.find((item) => item.id === timeMapId);
  const candidate = project.mediaMatchCandidates.find(
    (item) =>
      item.timeMapId === timeMapId && (item.state === "pending" || item.state === "blocked")
  );
  if (!timeMap || timeMap.state !== "candidate" || !candidate) {
    throw new Error("只能为待复核候选记录播放证据；已确认关系请先撤销后重新复核。");
  }
  const token = createTimeMapSpanPlaybackReviewToken(timeMap, spanIndex, evidence, reviewedAt);
  const notes = timeMap.evidence.notes.filter(
    (note) =>
      !note.startsWith(`${PLAYBACK_REVIEW_PREFIX}${spanIndex}:`) &&
      !note.startsWith(`${LEGACY_PLAYBACK_REVIEW_PREFIX}${spanIndex}:`)
  );
  const spans = timeMap.spans.map((span, index) => {
    if (index !== spanIndex || !isCompleteTimeMapSpanEvidence(span)) {
      return span;
    }
    const decision = readTimeMapSpanReviewDecision(timeMap, spanIndex)?.decision;
    const manuallyResolved =
      span.kind === "matched" ||
      (span.kind === "sourceOnly" && decision === "source-extra") ||
      (span.kind === "targetOnly" && decision === "target-extra") ||
      (span.kind === "ambiguous" && decision === "replacement");
    if (!manuallyResolved) {
      return span;
    }
    return {
      ...span,
      quality: {
        ...span.quality,
        level: "review" as const,
        reasons: [
          `第 ${spanIndex + 1} 段已完成与当前边界绑定的 A/B 播放复核；人工签发前仍保留 review。`
        ]
      }
    };
  });
  const provisionalMap: MediaTimeMap = {
    ...timeMap,
    revision: timeMap.revision + 1,
    spans,
    evidence: {
      ...timeMap.evidence,
      types: timeMap.evidence.types.includes("manual")
        ? [...timeMap.evidence.types]
        : [...timeMap.evidence.types, "manual"],
      notes: [...notes, token]
    },
    verification: null,
    updatedAt: reviewedAt
  };
  const playbackReviewedSpanIndexes = new Set(
    provisionalMap.spans.flatMap((_, index) =>
      readTimeMapSpanPlaybackReview(provisionalMap, index) ? [index] : []
    )
  );
  const reviewedMap = reconcileCandidateTimeMapManualReview({
    timeMap: provisionalMap,
    playbackReviewedSpanIndexes
  });
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === candidate.sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  const proposalTimeMap = candidate.proposal.timeMap
    ? {
        ...candidate.proposal.timeMap,
        spans: structuredClone(reviewedMap.spans),
        quality: structuredClone(reviewedMap.quality),
        evidence: {
          ...candidate.proposal.timeMap.evidence,
          types: [...reviewedMap.evidence.types],
          notes: [...reviewedMap.evidence.notes]
        }
      }
    : undefined;
  return {
    ...project,
    mediaTimeMaps: project.mediaTimeMaps.map((item) =>
      item.id === timeMapId ? reviewedMap : item
    ),
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            state:
              hasBoundAsset && reviewedMap.quality.level !== "blocked"
                ? "pending"
                : "blocked",
            proposal: proposalTimeMap
              ? { ...item.proposal, timeMap: proposalTimeMap }
              : item.proposal,
            updatedAt: reviewedAt
          }
        : item
    )
  };
}

export function createTimeMapSpanPlaybackReviewToken(
  timeMap: MediaTimeMap,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence,
  reviewedAt: string
): string {
  requireSpan(timeMap, spanIndex);
  const normalizedEvidence = validateEvidenceForMap(timeMap, spanIndex, evidence);
  const missing = describeMissingTimeMapSpanPlaybackEvidence(
    timeMap,
    spanIndex,
    normalizedEvidence
  );
  if (missing.length > 0) throw new Error(`播放复核尚未完成：${missing.join("；")}。`);
  if (!isIsoTimestamp(reviewedAt)) throw new Error("播放复核时间必须是规范 ISO 时间戳。");
  const encodedEvidence = encodeURIComponent(
    JSON.stringify(serializeEvidence(normalizedEvidence))
  );
  const token = `${PLAYBACK_REVIEW_PREFIX}${spanIndex}:${computeSpanDigest(timeMap, spanIndex).slice(7)}:${TIME_MAP_PLAYBACK_REVIEW_POLICY_VERSION}:${encodedEvidence}:${reviewedAt}`;
  if (token.length > TIME_MAP_PLAYBACK_REVIEW_MAX_TOKEN_LENGTH) {
    throw new Error("播放复核 token 超出 64 KiB 安全上限，请重新完成连续试听。");
  }
  return token;
}

/** v1 只证明调用过 play()，没有有效时长与覆盖信息；升级后必须 fail-closed。 */
export function isLegacyTimeMapSpanPlaybackReviewToken(note: string): boolean {
  return note.startsWith(LEGACY_PLAYBACK_REVIEW_PREFIX);
}

/** 只返回与当前媒体关系、span、策略版本、时长和覆盖范围完全一致的 v2 证据。 */
export function readTimeMapSpanPlaybackReview(
  timeMap: MediaTimeMap,
  spanIndex: number
): RecordedTimeMapSpanPlaybackReview | null {
  if (!timeMap.spans[spanIndex]) return null;
  for (let index = timeMap.evidence.notes.length - 1; index >= 0; index -= 1) {
    const parsed = parsePlaybackReview(timeMap.evidence.notes[index] ?? "");
    if (!parsed || parsed.spanIndex !== spanIndex) continue;
    if (
      parsed.policyVersion !== TIME_MAP_PLAYBACK_REVIEW_POLICY_VERSION ||
      parsed.spanDigest !== computeSpanDigest(timeMap, spanIndex)
    ) {
      continue;
    }
    try {
      const normalized = validateEvidenceForMap(timeMap, spanIndex, parsed);
      if (
        describeMissingTimeMapSpanPlaybackEvidence(timeMap, spanIndex, normalized).length > 0
      ) {
        continue;
      }
      return { ...parsed, ...normalized };
    } catch {
      continue;
    }
  }
  return null;
}

export function summarizeTimeMapSpanPlaybackEvidence(
  evidence: TimeMapSpanPlaybackEvidence
): readonly unknown[] {
  const normalized = normalizeEvidence(evidence);
  return [
    normalized.evidenceVersion,
    ...PLAYBACK_SLOTS.map((slot) => {
      const progress = normalized.slots[slot];
      return [
        slot,
        progress.effectiveDurationMs,
        measureCoveredDuration(progress.coveredRanges),
        progress.coveredRanges.map((range) => [range.startMs, range.endMs])
      ];
    })
  ];
}

function parsePlaybackReview(note: string): RecordedTimeMapSpanPlaybackReview | null {
  if (
    !note.startsWith(PLAYBACK_REVIEW_PREFIX) ||
    note.length > TIME_MAP_PLAYBACK_REVIEW_MAX_TOKEN_LENGTH
  ) {
    return null;
  }
  const fields = note.slice(PLAYBACK_REVIEW_PREFIX.length).split(":");
  if (fields.length < 6) return null;
  const spanIndex = Number(fields[0]);
  const spanDigest = `sha256:${fields[1] ?? ""}`;
  const policyVersion = Number(fields[2]);
  const encodedEvidence = fields[3] ?? "";
  const reviewedAt = fields.slice(4).join(":");
  if (
    !Number.isSafeInteger(spanIndex) ||
    spanIndex < 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(spanDigest) ||
    policyVersion !== TIME_MAP_PLAYBACK_REVIEW_POLICY_VERSION ||
    !isIsoTimestamp(reviewedAt)
  ) {
    return null;
  }
  try {
    const evidence = parseSerializedEvidence(JSON.parse(decodeURIComponent(encodedEvidence)));
    return { spanIndex, spanDigest, policyVersion, reviewedAt, token: note, ...evidence };
  } catch {
    return null;
  }
}

function computeSpanDigest(timeMap: MediaTimeMap, spanIndex: number): string {
  const span = timeMap.spans[spanIndex];
  if (!span) return "sha256:";
  return `sha256:${sha256Hex(
    JSON.stringify([
      "manual-playback-review-span-v2",
      TIME_MAP_PLAYBACK_REVIEW_POLICY_VERSION,
      timeMap.sourceMediaId,
      timeMap.targetMediaId,
      span.kind,
      span.sourceStartMs,
      span.sourceEndMs,
      span.targetStartMs,
      span.targetEndMs
    ])
  )}`;
}

function createRequirement(
  scope: TimeMapPlaybackReviewScope,
  axis: TimeMapPlaybackAxis,
  label: string,
  interval: TimeMapPlaybackInterval,
  baseEffectiveMs: number,
  baseCoveredMs: number
): TimeMapSpanPlaybackRequirement {
  const durationMs = interval.endMs - interval.startMs;
  return {
    slot: createSlot(scope, axis),
    scope,
    axis,
    label,
    interval,
    minimumEffectiveMs: Math.min(baseEffectiveMs, durationMs),
    minimumCoveredMs: Math.min(baseCoveredMs, Math.max(1, Math.floor(durationMs * 0.8)))
  };
}

function validateEvidenceForMap(
  timeMap: MediaTimeMap,
  spanIndex: number,
  evidence: TimeMapSpanPlaybackEvidence
): TimeMapSpanPlaybackEvidence {
  const normalized = normalizeEvidence(evidence);
  const intervals = createSlotIntervals(timeMap, spanIndex);
  for (const slot of PLAYBACK_SLOTS) {
    const progress = normalized.slots[slot];
    const interval = intervals.get(slot);
    if (!interval) {
      if (progress.effectiveDurationMs !== 0 || progress.coveredRanges.length !== 0) {
        throw new Error(`播放证据槽 ${slot} 在当前分段不存在。`);
      }
      continue;
    }
    if (
      progress.coveredRanges.some(
        (range) => range.startMs < interval.startMs || range.endMs > interval.endMs
      )
    ) {
      throw new Error(`播放证据槽 ${slot} 的覆盖范围超出当前复核区间。`);
    }
  }
  return normalized;
}

function createSlotIntervals(
  timeMap: MediaTimeMap,
  spanIndex: number
): Map<TimeMapPlaybackReviewSlot, TimeMapPlaybackInterval> {
  const span = requireSpan(timeMap, spanIndex);
  const plan = createTimeMapPlaybackSpanPlan(span);
  const intervals = new Map<TimeMapPlaybackReviewSlot, TimeMapPlaybackInterval>();
  for (const axis of PLAYBACK_AXES) {
    const interval = intervalForAxis(plan, axis);
    if (interval) intervals.set(createSlot("span", axis), interval);
  }
  const sourceRange = { startMs: timeMap.sourceStartMs, endMs: timeMap.sourceEndMs };
  const targetRange = { startMs: timeMap.targetStartMs, endMs: timeMap.targetEndMs };
  for (const scope of ["startBoundary", "endBoundary"] as const) {
    const context = createTimeMapPlaybackBoundaryContext(span, scope, sourceRange, targetRange);
    intervals.set(createSlot(scope, "source"), context.sourceInterval);
    intervals.set(createSlot(scope, "target"), context.targetInterval);
  }
  return intervals;
}

function normalizeEvidence(evidence: TimeMapSpanPlaybackEvidence): TimeMapSpanPlaybackEvidence {
  if (evidence.evidenceVersion !== 2 || !evidence.slots) {
    throw new Error("播放复核证据不是受支持的 v2 时长结构。");
  }
  const slots = {} as Record<TimeMapPlaybackReviewSlot, TimeMapPlaybackSlotProgress>;
  for (const slot of PLAYBACK_SLOTS) {
    const progress = evidence.slots[slot];
    if (
      !progress ||
      !Number.isSafeInteger(progress.effectiveDurationMs) ||
      progress.effectiveDurationMs < 0 ||
      progress.effectiveDurationMs > MAX_SLOT_EFFECTIVE_MS ||
      !Array.isArray(progress.coveredRanges)
    ) {
      throw new Error(`播放复核证据槽 ${slot} 无效。`);
    }
    if (progress.coveredRanges.length > TIME_MAP_PLAYBACK_REVIEW_MAX_RANGES_PER_SLOT) {
      throw new Error(`播放复核证据槽 ${slot} 的覆盖区间数量过多。`);
    }
    const ranges = progress.coveredRanges.map((range) => {
      if (!isValidInterval(range)) throw new Error(`播放复核证据槽 ${slot} 的覆盖范围无效。`);
      return { startMs: range.startMs, endMs: range.endMs };
    });
    const coveredRanges = mergeRanges(ranges);
    if (coveredRanges.length > TIME_MAP_PLAYBACK_REVIEW_MAX_RANGES_PER_SLOT) {
      throw new Error(`播放复核证据槽 ${slot} 的覆盖区间数量过多。`);
    }
    slots[slot] = {
      effectiveDurationMs: progress.effectiveDurationMs,
      coveredRanges
    };
  }
  return { evidenceVersion: 2, slots };
}

function serializeEvidence(evidence: TimeMapSpanPlaybackEvidence): readonly unknown[] {
  return PLAYBACK_SLOTS.map((slot) => {
    const progress = evidence.slots[slot];
    return [
      progress.effectiveDurationMs,
      progress.coveredRanges.map((range) => [range.startMs, range.endMs])
    ];
  });
}

function parseSerializedEvidence(value: unknown): TimeMapSpanPlaybackEvidence {
  const serializedSlots = asUnknownArray(value);
  if (!serializedSlots || serializedSlots.length !== PLAYBACK_SLOTS.length) {
    throw new Error("播放复核 token 的时长摘要无效。");
  }
  const evidence = createEmptyTimeMapSpanPlaybackEvidence();
  PLAYBACK_SLOTS.forEach((slot, index) => {
    const item = asUnknownArray(serializedSlots[index]);
    const serializedRanges = asUnknownArray(item?.[1]);
    if (!item || item.length !== 2 || !serializedRanges) {
      throw new Error("播放复核 token 的槽摘要无效。");
    }
    const effectiveDurationMs = item[0];
    if (typeof effectiveDurationMs !== "number") {
      throw new Error("播放复核 token 的有效时长无效。");
    }
    const ranges = serializedRanges.map((serializedRange) => {
      const range = asUnknownArray(serializedRange);
      if (
        !range ||
        range.length !== 2 ||
        typeof range[0] !== "number" ||
        typeof range[1] !== "number" ||
        !Number.isSafeInteger(range[0]) ||
        !Number.isSafeInteger(range[1])
      ) {
        throw new Error("播放复核 token 的覆盖摘要无效。");
      }
      return { startMs: Number(range[0]), endMs: Number(range[1]) };
    });
    evidence.slots[slot] = {
      effectiveDurationMs,
      coveredRanges: ranges
    };
  });
  return normalizeEvidence(evidence);
}

function asUnknownArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

function result(
  evidence: TimeMapSpanPlaybackEvidence,
  lastObservation: TimeMapPlaybackObservation | null,
  creditedDurationMs: number,
  reason: TimeMapPlaybackAccumulationResult["reason"]
): TimeMapPlaybackAccumulationResult {
  return {
    evidence,
    accumulator: { lastObservation },
    creditedDurationMs,
    reason
  };
}

function createSlot(
  scope: TimeMapPlaybackReviewScope,
  axis: TimeMapPlaybackAxis
): TimeMapPlaybackReviewSlot {
  return `${scope}:${axis}`;
}

function mergeRanges(ranges: readonly TimeMapPlaybackInterval[]): TimeMapPlaybackInterval[] {
  const sorted = ranges
    .filter(isValidInterval)
    .map((range) => ({ ...range }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: TimeMapPlaybackInterval[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.startMs > previous.endMs) {
      merged.push(range);
    } else {
      previous.endMs = Math.max(previous.endMs, range.endMs);
    }
  }
  return merged;
}

function measureCoveredDuration(ranges: readonly TimeMapPlaybackInterval[]): number {
  return mergeRanges(ranges).reduce((total, range) => total + (range.endMs - range.startMs), 0);
}

function requireSpan(timeMap: MediaTimeMap, spanIndex: number): TimeMapSpan {
  if (!Number.isSafeInteger(spanIndex) || spanIndex < 0) {
    throw new Error("播放复核分段序号无效。");
  }
  const span = timeMap.spans[spanIndex];
  if (!span) throw new Error("要记录播放复核的时间图片段不存在。");
  return span;
}

function isValidObservation(observation: TimeMapPlaybackObservation): boolean {
  return (
    PLAYBACK_SCOPES.includes(observation.scope) &&
    PLAYBACK_AXES.includes(observation.axis) &&
    Number.isSafeInteger(observation.positionMs) &&
    observation.positionMs >= 0 &&
    Number.isFinite(observation.observedAtMs) &&
    observation.observedAtMs >= 0
  );
}

function isValidInterval(interval: TimeMapPlaybackInterval): boolean {
  return (
    Number.isSafeInteger(interval.startMs) &&
    Number.isSafeInteger(interval.endMs) &&
    interval.startMs >= 0 &&
    interval.endMs > interval.startMs
  );
}

function clampPosition(positionMs: number, interval: TimeMapPlaybackInterval): number {
  return Math.min(interval.endMs, Math.max(interval.startMs, Math.round(positionMs)));
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)} 秒`;
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
