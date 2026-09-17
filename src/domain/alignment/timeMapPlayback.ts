import type { Milliseconds } from "../shared/time";
import type { TimeMapSpan } from "./timeMap";

export type TimeMapPlaybackAxis = "source" | "target";
export type TimeMapPlaybackBoundaryKind = "startBoundary" | "endBoundary";

export interface TimeMapPlaybackInterval {
  startMs: Milliseconds;
  endMs: Milliseconds;
}

export type TimeMapPlaybackSyncKind = "mapped" | "sourceOnly" | "targetOnly" | "ambiguous";

export interface TimeMapPlaybackSpanPlan {
  kind: TimeMapPlaybackSyncKind;
  sourceInterval: TimeMapPlaybackInterval | null;
  targetInterval: TimeMapPlaybackInterval | null;
  initialAxis: TimeMapPlaybackAxis;
  canSynchronize: boolean;
  explanation: string;
}

export type TimeMapPlaybackSwitchResult =
  | {
      status: "mapped";
      positionMs: Milliseconds;
    }
  | {
      status: "independent";
      positionMs: Milliseconds;
      reason: "ambiguous" | "boundary-context";
    }
  | {
      status: "unavailable";
      reason: "sourceOnly" | "targetOnly";
    };

export interface TimeMapPlaybackBoundaryResult {
  reachedEnd: boolean;
  shouldPause: boolean;
  seekToMs: Milliseconds | null;
}

export interface TimeMapPlaybackBoundaryContext {
  boundaryKind: TimeMapPlaybackBoundaryKind;
  sourceBoundaryMs: Milliseconds;
  targetBoundaryMs: Milliseconds;
  sourceInterval: TimeMapPlaybackInterval;
  targetInterval: TimeMapPlaybackInterval;
  canSynchronize: boolean;
}

/**
 * 把一段 TimeMap 解释为用户可试听的 A/B 区间。这里不修改时间图，也不会把
 * sourceOnly、targetOnly 或 ambiguous 猜成 matched。
 */
export function createTimeMapPlaybackSpanPlan(span: TimeMapSpan): TimeMapPlaybackSpanPlan {
  assertSpanCoordinates(span);
  const sourceInterval = createPositiveInterval(span.sourceStartMs, span.sourceEndMs);
  const targetInterval = createPositiveInterval(span.targetStartMs, span.targetEndMs);

  if (span.kind === "matched") {
    if (!sourceInterval || !targetInterval) {
      throw new RangeError("共同内容分段必须同时具有正长度的参考和原片区间。");
    }
    return {
      kind: "mapped",
      sourceInterval,
      targetInterval,
      initialAxis: "source",
      canSynchronize: true,
      explanation: "共同内容可按时间图在参考 A 与原片 B 之间双向同步切换。"
    };
  }

  if (span.kind === "sourceOnly") {
    if (!sourceInterval || targetInterval) {
      throw new RangeError("参考独有分段必须只有正长度的参考区间。");
    }
    return {
      kind: "sourceOnly",
      sourceInterval,
      targetInterval: null,
      initialAxis: "source",
      canSynchronize: false,
      explanation: "这段只存在于参考视频；可以循环试听 A，但没有可切换的原片 B 位置。"
    };
  }

  if (span.kind === "targetOnly") {
    if (sourceInterval || !targetInterval) {
      throw new RangeError("原片独有分段必须只有正长度的原片区间。");
    }
    return {
      kind: "targetOnly",
      sourceInterval: null,
      targetInterval,
      initialAxis: "target",
      canSynchronize: false,
      explanation: "这段只存在于原片；可以循环试听 B，但没有可切换的参考 A 位置。"
    };
  }

  if (!sourceInterval && !targetInterval) {
    throw new RangeError("无法判断分段至少要在一条时间轴上具有正长度区间。");
  }
  return {
    kind: "ambiguous",
    sourceInterval,
    targetInterval,
    initialAxis: sourceInterval ? "source" : "target",
    canSynchronize: false,
    explanation:
      "这段关系无法唯一判断；可以分别试听 A/B，但切换时只回到各自段首，不会伪造同步位置。"
  };
}

/**
 * 根据当前播放头切换 A/B。matched 使用整数毫秒分段仿射映射；ambiguous 只回到
 * 另一侧段首；单侧内容明确拒绝不存在的一侧。
 */
export function resolveTimeMapPlaybackSwitch(
  span: TimeMapSpan,
  fromAxis: TimeMapPlaybackAxis,
  toAxis: TimeMapPlaybackAxis,
  currentPositionMs: Milliseconds
): TimeMapPlaybackSwitchResult {
  const plan = createTimeMapPlaybackSpanPlan(span);
  const destination = intervalForAxis(plan, toAxis);
  if (!destination) {
    return {
      status: "unavailable",
      reason: toAxis === "target" ? "sourceOnly" : "targetOnly"
    };
  }

  if (fromAxis === toAxis) {
    return {
      status: "mapped",
      positionMs: clampToHalfOpenInterval(currentPositionMs, destination)
    };
  }

  if (plan.kind === "ambiguous") {
    return {
      status: "independent",
      positionMs: destination.startMs,
      reason: "ambiguous"
    };
  }
  if (plan.kind !== "mapped") {
    return {
      status: "unavailable",
      reason: plan.kind
    };
  }

  const origin = intervalForAxis(plan, fromAxis);
  if (!origin) {
    return {
      status: "unavailable",
      reason: fromAxis === "source" ? "targetOnly" : "sourceOnly"
    };
  }
  const clampedPositionMs = clampToHalfOpenInterval(currentPositionMs, origin);
  return {
    status: "mapped",
    positionMs:
      fromAxis === "source"
        ? interpolateHalfOpen(
            clampedPositionMs,
            span.sourceStartMs,
            span.sourceEndMs,
            span.targetStartMs,
            span.targetEndMs
          )
        : interpolateHalfOpen(
            clampedPositionMs,
            span.targetStartMs,
            span.targetEndMs,
            span.sourceStartMs,
            span.sourceEndMs
          )
  };
}

/** 返回 matched 另一侧的同步显示位置；非 matched 不返回虚假的对应点。 */
export function mapTimeMapPlaybackCounterpart(
  span: TimeMapSpan,
  fromAxis: TimeMapPlaybackAxis,
  currentPositionMs: Milliseconds
): Milliseconds | null {
  if (span.kind !== "matched") {
    return null;
  }
  const result = resolveTimeMapPlaybackSwitch(
    span,
    fromAxis,
    fromAxis === "source" ? "target" : "source",
    currentPositionMs
  );
  return result.status === "mapped" ? result.positionMs : null;
}

/**
 * 检查当前分段的半开结束边界。循环开启时回到本侧段首；关闭时暂停在末端前
 * 最后一个整数毫秒，避免播放头落到下一段却仍显示为当前段。
 */
export function resolveTimeMapPlaybackBoundary(
  interval: TimeMapPlaybackInterval,
  currentPositionMs: Milliseconds,
  loopEnabled: boolean
): TimeMapPlaybackBoundaryResult {
  assertInterval(interval);
  if (currentPositionMs < interval.endMs) {
    return { reachedEnd: false, shouldPause: false, seekToMs: null };
  }
  return loopEnabled
    ? { reachedEnd: true, shouldPause: false, seekToMs: interval.startMs }
    : { reachedEnd: true, shouldPause: true, seekToMs: interval.endMs - 1 };
}

/**
 * 生成某个差异边界前后固定时长的双侧上下文。即使 sourceOnly/targetOnly 的一侧在
 * 当前 span 中只是点，也仍允许围绕该点试听真实媒体上下文，但不会称其为匹配区间。
 */
export function createTimeMapPlaybackBoundaryContext(
  span: TimeMapSpan,
  boundaryKind: TimeMapPlaybackBoundaryKind,
  sourceMapRange: TimeMapPlaybackInterval,
  targetMapRange: TimeMapPlaybackInterval,
  radiusMs = 3_000
): TimeMapPlaybackBoundaryContext {
  assertSpanCoordinates(span);
  assertInterval(sourceMapRange);
  assertInterval(targetMapRange);
  if (!Number.isSafeInteger(radiusMs) || radiusMs <= 0) {
    throw new RangeError("边界复核半径必须是正整数毫秒。");
  }
  const sourceBoundaryMs =
    boundaryKind === "startBoundary" ? span.sourceStartMs : span.sourceEndMs;
  const targetBoundaryMs =
    boundaryKind === "startBoundary" ? span.targetStartMs : span.targetEndMs;
  return {
    boundaryKind,
    sourceBoundaryMs,
    targetBoundaryMs,
    sourceInterval: createClippedBoundaryInterval(sourceBoundaryMs, sourceMapRange, radiusMs),
    targetInterval: createClippedBoundaryInterval(targetBoundaryMs, targetMapRange, radiusMs),
    canSynchronize: span.kind === "matched"
  };
}

/**
 * 边界上下文切换：matched 使用该段仿射斜率保持相对边界位置；差异/歧义段只以双方
 * TimeMap 边界为中心保留相同毫秒偏移，并明确返回 independent。
 */
export function resolveTimeMapBoundaryPlaybackSwitch(
  span: TimeMapSpan,
  context: TimeMapPlaybackBoundaryContext,
  fromAxis: TimeMapPlaybackAxis,
  toAxis: TimeMapPlaybackAxis,
  currentPositionMs: Milliseconds
): TimeMapPlaybackSwitchResult {
  if (fromAxis === toAxis) {
    return {
      status: "mapped",
      positionMs: clampToHalfOpenInterval(
        currentPositionMs,
        toAxis === "source" ? context.sourceInterval : context.targetInterval
      )
    };
  }
  const originBoundaryMs =
    fromAxis === "source" ? context.sourceBoundaryMs : context.targetBoundaryMs;
  const destinationBoundaryMs =
    toAxis === "source" ? context.sourceBoundaryMs : context.targetBoundaryMs;
  const destinationInterval =
    toAxis === "source" ? context.sourceInterval : context.targetInterval;
  const offsetMs = currentPositionMs - originBoundaryMs;
  const mappedOffsetMs =
    span.kind === "matched"
      ? scaleSignedOffset(
          offsetMs,
          fromAxis === "source"
            ? span.sourceEndMs - span.sourceStartMs
            : span.targetEndMs - span.targetStartMs,
          fromAxis === "source"
            ? span.targetEndMs - span.targetStartMs
            : span.sourceEndMs - span.sourceStartMs
        )
      : offsetMs;
  const positionMs = clampToHalfOpenInterval(
    destinationBoundaryMs + mappedOffsetMs,
    destinationInterval
  );
  return span.kind === "matched"
    ? { status: "mapped", positionMs }
    : { status: "independent", positionMs, reason: "boundary-context" };
}

export function intervalForAxis(
  plan: TimeMapPlaybackSpanPlan,
  axis: TimeMapPlaybackAxis
): TimeMapPlaybackInterval | null {
  return axis === "source" ? plan.sourceInterval : plan.targetInterval;
}

function interpolateHalfOpen(
  valueMs: Milliseconds,
  fromStartMs: Milliseconds,
  fromEndMs: Milliseconds,
  toStartMs: Milliseconds,
  toEndMs: Milliseconds
): Milliseconds {
  const fromDurationMs = fromEndMs - fromStartMs;
  const toDurationMs = toEndMs - toStartMs;
  if (fromDurationMs <= 0 || toDurationMs <= 0) {
    throw new RangeError("同步插值要求双方都是正长度区间。");
  }
  const deltaMs = valueMs - fromStartMs;
  const numerator = BigInt(deltaMs) * BigInt(toDurationMs);
  const denominator = BigInt(fromDurationMs);
  const roundedDeltaMs = Number((numerator * 2n + denominator) / (denominator * 2n));
  return Math.min(toEndMs - 1, toStartMs + roundedDeltaMs);
}

function createClippedBoundaryInterval(
  boundaryMs: Milliseconds,
  mapRange: TimeMapPlaybackInterval,
  radiusMs: Milliseconds
): TimeMapPlaybackInterval {
  const clampedBoundaryMs = Math.min(mapRange.endMs, Math.max(mapRange.startMs, boundaryMs));
  const startMs = Math.max(mapRange.startMs, clampedBoundaryMs - radiusMs);
  const endMs = Math.min(mapRange.endMs, clampedBoundaryMs + radiusMs);
  if (endMs > startMs) {
    return { startMs, endMs };
  }
  // 仅在边界等于总范围端点且范围比半径更短时触发；仍返回真实的正长度上下文。
  return { startMs: mapRange.startMs, endMs: mapRange.endMs };
}

function scaleSignedOffset(
  valueMs: number,
  fromDurationMs: number,
  toDurationMs: number
): number {
  if (fromDurationMs <= 0 || toDurationMs <= 0) {
    throw new RangeError("边界同步斜率要求双方都是正长度区间。");
  }
  const sign = valueMs < 0 ? -1 : 1;
  const numerator = BigInt(Math.abs(valueMs)) * BigInt(toDurationMs);
  const denominator = BigInt(fromDurationMs);
  const rounded = Number((numerator * 2n + denominator) / (denominator * 2n));
  return sign * rounded;
}

function createPositiveInterval(
  startMs: Milliseconds,
  endMs: Milliseconds
): TimeMapPlaybackInterval | null {
  return endMs > startMs ? { startMs, endMs } : null;
}

function clampToHalfOpenInterval(
  valueMs: Milliseconds,
  interval: TimeMapPlaybackInterval
): Milliseconds {
  return Math.min(interval.endMs - 1, Math.max(interval.startMs, Math.round(valueMs)));
}

function assertSpanCoordinates(span: TimeMapSpan): void {
  const values = [span.sourceStartMs, span.sourceEndMs, span.targetStartMs, span.targetEndMs];
  if (
    !values.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    span.sourceEndMs < span.sourceStartMs ||
    span.targetEndMs < span.targetStartMs
  ) {
    throw new RangeError("播放复核分段包含无效的非负整数毫秒边界。");
  }
}

function assertInterval(interval: TimeMapPlaybackInterval): void {
  if (
    !Number.isSafeInteger(interval.startMs) ||
    !Number.isSafeInteger(interval.endMs) ||
    interval.startMs < 0 ||
    interval.endMs <= interval.startMs
  ) {
    throw new RangeError("播放复核区间必须是有效的正长度半开整数毫秒区间。");
  }
}
