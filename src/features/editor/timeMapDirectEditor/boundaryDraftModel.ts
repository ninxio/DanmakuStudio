import type { AlignmentEvidenceProfile } from "../../../domain/alignment/types";
import type { TimeMapSpan } from "../../../domain/alignment/timeMap";
import type {
  ResolveOriginalOnlyGapInput,
  ResolveReferenceOnlyGapInput
} from "../../../domain/alignment/timeMapReviewDecision";
import { formatTimecode } from "../../../domain/shared/time";
import { effectiveOffsetMs } from "./evidenceCanvasModel";

export interface GapDraft {
  side: "source" | "target";
  startMs: number;
  endMs: number;
  seamMs: number | null;
}

export type GapDraftResolution =
  | { kind: "targetGap"; input: ResolveOriginalOnlyGapInput }
  | { kind: "sourceGap"; input: ResolveReferenceOnlyGapInput };

export function createGapSuggestion(
  span: TimeMapSpan,
  evidenceProfile?: AlignmentEvidenceProfile
): GapDraft | null {
  if (span.kind !== "ambiguous") return null;
  const visualSuggestion = createVisualOffsetGapSuggestion(span, evidenceProfile);
  if (visualSuggestion) return visualSuggestion;
  const evidenceSuggestion = createEvidenceOffsetGapSuggestion(span, evidenceProfile);
  if (evidenceSuggestion) return evidenceSuggestion;
  const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
  const targetDurationMs = span.targetEndMs - span.targetStartMs;
  const differenceMs = targetDurationMs - sourceDurationMs;
  if (Math.abs(differenceMs) < 1_000) return null;
  return differenceMs > 0
    ? {
        side: "target",
        startMs: span.targetEndMs - differenceMs,
        endMs: span.targetEndMs,
        seamMs: span.sourceEndMs
      }
    : {
        side: "source",
        startMs: span.sourceEndMs + differenceMs,
        endMs: span.sourceEndMs,
        seamMs: span.targetEndMs
      };
}

export function updateGapDraft({
  span,
  side,
  firstMs,
  secondMs,
  snapEnabled,
  playbackCursor,
  evidenceProfile,
  shouldSnap = snapEnabled
}: {
  span: TimeMapSpan;
  side: "source" | "target";
  firstMs: number;
  secondMs: number;
  snapEnabled: boolean;
  playbackCursor?: { side: "source" | "target"; positionMs: number } | null;
  evidenceProfile?: AlignmentEvidenceProfile;
  shouldSnap?: boolean;
}): { draft: GapDraft; snapMessage: string | null } {
  const snappedFirst = shouldSnap
    ? snapBoundary(side, firstMs, playbackCursor, evidenceProfile)
    : { positionMs: firstMs, label: null };
  const snappedSecond = shouldSnap
    ? snapBoundary(side, secondMs, playbackCursor, evidenceProfile)
    : { positionMs: secondMs, label: null };
  const startMs = Math.min(snappedFirst.positionMs, snappedSecond.positionMs);
  const endMs = Math.max(snappedFirst.positionMs, snappedSecond.positionMs);
  const snapLabel = snappedFirst.label ?? snappedSecond.label;
  return {
    draft: {
      side,
      startMs,
      endMs,
      seamMs: inferGapSeam(span, side, startMs, endMs, evidenceProfile)
    },
    snapMessage: snapLabel ? `已吸附到 ${snapLabel}` : null
  };
}

export function isResolvableGapShape(span: TimeMapSpan, draft: GapDraft): boolean {
  if (
    draft.seamMs === null ||
    draft.startMs < (draft.side === "source" ? span.sourceStartMs : span.targetStartMs) ||
    draft.endMs > (draft.side === "source" ? span.sourceEndMs : span.targetEndMs) ||
    draft.endMs <= draft.startMs
  ) {
    return false;
  }
  const sourceGapStartMs = draft.side === "source" ? draft.startMs : draft.seamMs;
  const sourceGapEndMs = draft.side === "source" ? draft.endMs : draft.seamMs;
  const targetGapStartMs = draft.side === "target" ? draft.startMs : draft.seamMs;
  const targetGapEndMs = draft.side === "target" ? draft.endMs : draft.seamMs;
  if (
    sourceGapStartMs < span.sourceStartMs ||
    sourceGapEndMs > span.sourceEndMs ||
    targetGapStartMs < span.targetStartMs ||
    targetGapEndMs > span.targetEndMs
  ) {
    return false;
  }
  const hasBefore =
    sourceGapStartMs > span.sourceStartMs || targetGapStartMs > span.targetStartMs;
  if (
    hasBefore &&
    (sourceGapStartMs <= span.sourceStartMs || targetGapStartMs <= span.targetStartMs)
  ) {
    return false;
  }
  const hasAfter = sourceGapEndMs < span.sourceEndMs || targetGapEndMs < span.targetEndMs;
  return (
    !hasAfter ||
    (sourceGapEndMs < span.sourceEndMs && targetGapEndMs < span.targetEndMs)
  );
}

export function resolveGapDraft(
  span: TimeMapSpan,
  draft: GapDraft
): GapDraftResolution | null {
  if (!isResolvableGapShape(span, draft) || draft.seamMs === null) return null;
  return draft.side === "target"
    ? {
        kind: "targetGap",
        input: {
          sourceAtMs: draft.seamMs,
          targetStartMs: draft.startMs,
          targetEndMs: draft.endMs
        }
      }
    : {
        kind: "sourceGap",
        input: {
          sourceStartMs: draft.startMs,
          sourceEndMs: draft.endMs,
          targetAtMs: draft.seamMs
        }
      };
}

function snapBoundary(
  side: "source" | "target",
  positionMs: number,
  playbackCursor: { side: "source" | "target"; positionMs: number } | null | undefined,
  evidenceProfile: AlignmentEvidenceProfile | undefined
): { positionMs: number; label: string | null } {
  const candidates = [
    ...(playbackCursor?.side === side
      ? [
          {
            positionMs: playbackCursor.positionMs,
            label: `${side === "target" ? "B" : "A"} 当前播放头 ${formatTimecode(playbackCursor.positionMs)}`
          }
        ]
      : []),
    ...(evidenceProfile?.samples
      .filter((sample) => sample.axis === side)
      .flatMap((sample) => [sample.startMs, sample.endMs])
      .map((candidateMs) => ({
        positionMs: candidateMs,
        label: `局部证据边界 ${formatTimecode(candidateMs)}`
      })) ?? [])
  ].sort(
    (left, right) =>
      Math.abs(left.positionMs - positionMs) - Math.abs(right.positionMs - positionMs)
  );
  const nearest = candidates[0];
  return !nearest || Math.abs(nearest.positionMs - positionMs) > 250
    ? { positionMs, label: null }
    : nearest;
}

function createVisualOffsetGapSuggestion(
  span: TimeMapSpan,
  profile: AlignmentEvidenceProfile | undefined
): GapDraft | null {
  if (!profile) return null;
  const samples = profile.samples
    .filter(
      (sample) =>
        sample.axis === "source" &&
        effectiveOffsetMs(sample) !== null &&
        (sample.state === "supported" || sample.state === "weak") &&
        sample.endMs > span.sourceStartMs &&
        sample.startMs < span.sourceEndMs
    )
    .sort((left, right) => left.startMs - right.startMs);
  const candidates: Array<{ draft: GapDraft; score: number }> = [];
  for (let index = 0; index < samples.length - 1; index += 1) {
    const before = samples[index];
    const after = samples[index + 1];
    if (!before || !after) continue;
    if (
      before.visualRecoveryState !== "recovered" &&
      after.visualRecoveryState !== "recovered"
    ) {
      continue;
    }
    if (after.startMs - before.endMs > Math.max(1_000, profile.windowMs * 3)) continue;
    const beforeOffsetMs = effectiveOffsetMs(before);
    const afterOffsetMs = effectiveOffsetMs(after);
    if (beforeOffsetMs === null || afterOffsetMs === null) continue;
    const offsetStepMs = afterOffsetMs - beforeOffsetMs;
    if (Math.abs(offsetStepMs) < 1_000) continue;
    const sourceSeamMs = Math.round((before.endMs + after.startMs) / 2);
    const draft: GapDraft =
      offsetStepMs > 0
        ? {
            side: "target",
            startMs: sourceSeamMs + beforeOffsetMs,
            endMs: sourceSeamMs + afterOffsetMs,
            seamMs: sourceSeamMs
          }
        : {
            side: "source",
            startMs: sourceSeamMs,
            endMs: sourceSeamMs - offsetStepMs,
            seamMs: sourceSeamMs + beforeOffsetMs
          };
    if (!isResolvableGapShape(span, draft)) continue;
    const visualConfidence = Math.max(
      before.visualConfidence ?? 0,
      after.visualConfidence ?? 0
    );
    candidates.push({
      draft,
      score: Math.abs(offsetStepMs) * Math.max(0.1, visualConfidence)
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.draft ?? null;
}

function createEvidenceOffsetGapSuggestion(
  span: TimeMapSpan,
  profile: AlignmentEvidenceProfile | undefined
): GapDraft | null {
  if (!profile) return null;
  const candidates: Array<{ draft: GapDraft; score: number }> = [];
  (["source", "target"] as const).forEach((axis) => {
    const axisStartMs = axis === "source" ? span.sourceStartMs : span.targetStartMs;
    const axisEndMs = axis === "source" ? span.sourceEndMs : span.targetEndMs;
    const samples = profile.samples
      .filter(
        (sample) =>
          sample.axis === axis &&
          effectiveOffsetMs(sample) !== null &&
          (sample.state === "supported" || sample.state === "weak") &&
          sample.endMs > axisStartMs &&
          sample.startMs < axisEndMs
      )
      .sort((left, right) => left.startMs - right.startMs);
    for (let index = 0; index < samples.length - 1; index += 1) {
      const before = samples[index];
      const after = samples[index + 1];
      const beforeOffsetMs = effectiveOffsetMs(before);
      const afterOffsetMs = effectiveOffsetMs(after);
      if (!before || !after || beforeOffsetMs === null || afterOffsetMs === null) continue;
      const offsetStepMs = afterOffsetMs - beforeOffsetMs;
      const expectedDirection = axis === "target" ? 1 : -1;
      if (offsetStepMs * expectedDirection < 1_000) continue;
      const seamBeforeMs =
        axis === "target"
          ? before.endMs - beforeOffsetMs
          : before.endMs + beforeOffsetMs;
      const seamAfterMs =
        axis === "target"
          ? after.startMs - afterOffsetMs
          : after.startMs + afterOffsetMs;
      const seamToleranceMs = Math.max(1_000, profile.windowMs * 3);
      if (Math.abs(seamAfterMs - seamBeforeMs) > seamToleranceMs) continue;
      const seamMs = Math.round((seamBeforeMs + seamAfterMs) / 2);
      const draft: GapDraft =
        axis === "target"
          ? {
              side: "target",
              startMs: seamMs + beforeOffsetMs,
              endMs: seamMs + afterOffsetMs,
              seamMs
            }
          : {
              side: "source",
              startMs: seamMs - beforeOffsetMs,
              endMs: seamMs - afterOffsetMs,
              seamMs
            };
      if (!isResolvableGapShape(span, draft)) continue;
      candidates.push({
        draft,
        score:
          Math.abs(offsetStepMs) * Math.max(0.1, Math.min(before.strength, after.strength))
      });
    }
  });
  return candidates.sort((left, right) => right.score - left.score)[0]?.draft ?? null;
}

function inferGapSeam(
  span: TimeMapSpan,
  side: "source" | "target",
  startMs: number,
  endMs: number,
  profile: AlignmentEvidenceProfile | undefined
): number | null {
  const axisStartMs = side === "source" ? span.sourceStartMs : span.targetStartMs;
  const axisEndMs = side === "source" ? span.sourceEndMs : span.targetEndMs;
  const otherStartMs = side === "source" ? span.targetStartMs : span.sourceStartMs;
  const otherEndMs = side === "source" ? span.targetEndMs : span.sourceEndMs;
  const toleranceMs = Math.max(profile?.windowMs ?? 0, 1_000);
  if (Math.abs(endMs - axisEndMs) <= toleranceMs) return otherEndMs;
  if (Math.abs(startMs - axisStartMs) <= toleranceMs) return otherStartMs;
  const supported = profile?.samples
    .filter(
      (sample) =>
        sample.axis === side &&
        sample.counterpartMs !== null &&
        (sample.state === "supported" || sample.state === "weak")
    )
    .sort((left, right) => left.startMs - right.startMs);
  if (!supported?.length) return null;
  const before = [...supported].reverse().find((sample) => sample.endMs <= startMs);
  const after = supported.find((sample) => sample.startMs >= endMs);
  if (before?.counterpartMs != null && !after) return before.counterpartMs;
  if (after?.counterpartMs != null && !before) return after.counterpartMs;
  if (
    before?.counterpartMs != null &&
    after?.counterpartMs != null &&
    Math.abs(after.counterpartMs - before.counterpartMs) <= toleranceMs * 2
  ) {
    return Math.round((before.counterpartMs + after.counterpartMs) / 2);
  }
  return null;
}
