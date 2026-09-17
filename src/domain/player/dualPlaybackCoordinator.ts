import type { TimeMapSpan } from "../alignment/timeMap";
import {
  createTimeMapPlaybackSpanPlan,
  mapTimeMapPlaybackCounterpart,
  type TimeMapPlaybackAxis
} from "../alignment/timeMapPlayback";
import type { Milliseconds } from "../shared/time";

export type DualPlaybackMode = "linked" | "independent";

export interface DualPlaybackPositions {
  sourceMs: Milliseconds;
  targetMs: Milliseconds;
}

export type FollowerCorrection =
  | { action: "none"; driftMs: number }
  | { action: "seek"; driftMs: number; positionMs: Milliseconds };

/**
 * 最终 XML 投影到原片时间轴，所以双方都存在时默认让原片 B 成为主时钟。
 * 单侧分段仍选择真实存在的那一侧。
 */
export function preferredDualPlaybackAxis(span: TimeMapSpan): TimeMapPlaybackAxis {
  const plan = createTimeMapPlaybackSpanPlan(span);
  return plan.targetInterval ? "target" : "source";
}

export function canLinkDualPlayback(span: TimeMapSpan): boolean {
  const plan = createTimeMapPlaybackSpanPlan(span);
  return plan.canSynchronize && Boolean(plan.sourceInterval && plan.targetInterval);
}

/**
 * 将主时钟位置转换成双方位置。只允许 matched 段进入联动模式，避免为差异段
 * 伪造逐帧对应关系。
 */
export function resolveLinkedPlaybackPositions(
  span: TimeMapSpan,
  masterAxis: TimeMapPlaybackAxis,
  masterPositionMs: Milliseconds
): DualPlaybackPositions {
  if (!canLinkDualPlayback(span)) {
    throw new RangeError("只有共同内容分段可以联动播放。");
  }
  const counterpart = mapTimeMapPlaybackCounterpart(span, masterAxis, masterPositionMs);
  if (counterpart === null) {
    throw new RangeError("共同内容分段缺少可用的另一侧播放位置。");
  }
  return masterAxis === "target"
    ? { sourceMs: counterpart, targetMs: Math.round(masterPositionMs) }
    : { sourceMs: Math.round(masterPositionMs), targetMs: counterpart };
}

/**
 * 当双方时长存在小幅伸缩时，跟随侧按 TimeMap 斜率播放，而不是强制两边都 1x。
 */
export function linkedPlaybackRate(
  span: TimeMapSpan,
  axis: TimeMapPlaybackAxis,
  masterAxis: TimeMapPlaybackAxis
): number {
  if (!canLinkDualPlayback(span) || axis === masterAxis) return 1;
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  const rate =
    masterAxis === "target"
      ? sourceDurationMs / targetDurationMs
      : targetDurationMs / sourceDurationMs;
  return Math.min(4, Math.max(0.25, rate));
}

/**
 * 小漂移不做频繁 seek；超过硬阈值才把跟随侧拉回 TimeMap 位置。
 */
export function decideFollowerCorrection(
  expectedPositionMs: Milliseconds,
  actualPositionMs: Milliseconds,
  seekThresholdMs = 250
): FollowerCorrection {
  if (!Number.isSafeInteger(expectedPositionMs) || !Number.isSafeInteger(actualPositionMs)) {
    throw new RangeError("播放器位置必须是整数毫秒。");
  }
  if (!Number.isSafeInteger(seekThresholdMs) || seekThresholdMs <= 0) {
    throw new RangeError("漂移修正阈值必须是正整数毫秒。");
  }
  const driftMs = actualPositionMs - expectedPositionMs;
  return Math.abs(driftMs) >= seekThresholdMs
    ? { action: "seek", driftMs, positionMs: expectedPositionMs }
    : { action: "none", driftMs };
}
