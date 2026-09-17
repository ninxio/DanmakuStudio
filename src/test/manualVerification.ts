import {
  applyAuthorityIssuedManualMediaTimeMapVerification,
  createManualMediaTimeMapVerificationRequest
} from "../domain/alignment/mediaTimeMap";
import {
  createEmptyTimeMapSpanPlaybackEvidence,
  createTimeMapSpanPlaybackRequirements,
  createTimeMapSpanPlaybackReviewToken,
  type TimeMapSpanPlaybackEvidence
} from "../domain/alignment/timeMapPlaybackReviewEvidence";
import type { MediaTimeMap } from "../domain/project/types";
import { isCompleteTimeMapSpanEvidence } from "../domain/alignment/timeMap";
import { createTestCompleteTimeMapSpan } from "./timeMapEvidence";

interface TestManualVerificationInput {
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

/** Test fixture helper. Production code must use the native manualVerificationAuthority bridge. */
export function applyTestManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: TestManualVerificationInput
): MediaTimeMap {
  const hydratedMap: MediaTimeMap = {
    ...map,
    spans: map.spans.map((span, spanIndex) =>
      isCompleteTimeMapSpanEvidence(span)
        ? structuredClone(span)
        : createTestCompleteTimeMapSpan(
            span,
            span.id ?? `${map.id}:span:${String(spanIndex + 1).padStart(4, "0")}`
          )
    )
  };
  const hasUnresolvedAmbiguous = hydratedMap.spans.some(
    (span, spanIndex) =>
      span.kind === "ambiguous" &&
      !hydratedMap.evidence.notes.some((note) =>
        note.startsWith(`manual-span-review:v1:${spanIndex}:replacement:`)
      )
  );
  if (hasUnresolvedAmbiguous) {
    // Some projection tests intentionally construct an impossible self-reported verified map to
    // assert that the export path still blocks it. Production issuance rejects this shape.
    return {
      ...hydratedMap,
      quality: { ...hydratedMap.quality, level: "verified" },
      verification: null
    };
  }
  const reviewNotes = map.spans.flatMap((span, spanIndex) => {
    if (span.kind === "sourceOnly") {
      return [`manual-span-review:v1:${spanIndex}:source-extra:${input.verifiedAt}`];
    }
    if (span.kind === "targetOnly") {
      return [`manual-span-review:v1:${spanIndex}:target-extra:${input.verifiedAt}`];
    }
    return [];
  });
  const reviewedMap: MediaTimeMap = {
    ...hydratedMap,
    quality: {
      ...map.quality,
      uniqueContentCoverage:
        map.quality.uniqueContentCoverage ??
        map.evidence.uniqueContentCoverage ??
        map.quality.coverage,
      p99ResidualMs: map.quality.p99ResidualMs ?? map.quality.maxResidualMs,
      anchorCount: Math.max(30, map.quality.anchorCount),
      anchorRegionCount: map.quality.anchorRegionCount ?? 3
    },
    evidence: {
      ...map.evidence,
      types: map.evidence.types.includes("manual")
        ? [...map.evidence.types]
        : [...map.evidence.types, "manual"],
      top1Top2Margin: map.evidence.top1Top2Margin ?? map.quality.alternativeMargin,
      uniqueContentCoverage:
        map.quality.uniqueContentCoverage ??
        map.evidence.uniqueContentCoverage ??
        map.quality.coverage,
      repeatedContentOnly: map.evidence.repeatedContentOnly ?? false,
      selectedTrackReason: map.evidence.selectedTrackReason ?? "测试人工验证轨道。",
      alternativeTrackScores: (map.evidence.alternativeTrackScores ?? []).map(
        (alternative) => ({
          ...alternative,
          scale: alternative.scale ?? 1,
          offsetMs: alternative.offsetMs ?? 0,
          inlierCount: alternative.inlierCount ?? 0
        })
      ),
      notes: [...map.evidence.notes, ...reviewNotes]
    }
  };
  reviewedMap.evidence.notes.push(
    ...reviewedMap.spans.map((_, spanIndex) =>
      createTimeMapSpanPlaybackReviewToken(
        reviewedMap,
        spanIndex,
        createTestCompleteTimeMapSpanPlaybackEvidence(reviewedMap, spanIndex),
        input.verifiedAt
      )
    )
  );
  const completeInput = { ...input };
  const request = createManualMediaTimeMapVerificationRequest(reviewedMap, completeInput);
  return applyAuthorityIssuedManualMediaTimeMapVerification(reviewedMap, completeInput, {
    verificationId: `test-verification-${map.id}`,
    issuerKeyId: "vitest-install-key",
    issuerSequence: 1,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: "1".repeat(64),
    requestDigest: request.requestDigest
  });
}

/** 构造刚好满足当前 v2 策略的测试证据，避免测试依赖一次 play() 的旧语义。 */
export function createTestCompleteTimeMapSpanPlaybackEvidence(
  map: MediaTimeMap,
  spanIndex: number
): TimeMapSpanPlaybackEvidence {
  const evidence = createEmptyTimeMapSpanPlaybackEvidence();
  for (const requirement of createTimeMapSpanPlaybackRequirements(map, spanIndex)) {
    evidence.slots[requirement.slot] = {
      effectiveDurationMs: requirement.minimumEffectiveMs,
      coveredRanges: [
        {
          startMs: requirement.interval.startMs,
          endMs: requirement.interval.startMs + requirement.minimumCoveredMs
        }
      ]
    };
  }
  return evidence;
}
