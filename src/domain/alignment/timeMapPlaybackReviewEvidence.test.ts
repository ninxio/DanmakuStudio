import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type {
  MediaContentIdentity,
  MediaMatchCandidate,
  MediaTimeMap
} from "../project/types";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import {
  accumulateTimeMapPlaybackObservation,
  assessTimeMapSpanPlaybackEvidence,
  createEmptyTimeMapSpanPlaybackEvidence,
  createTimeMapSpanPlaybackRequirements,
  createTimeMapSpanPlaybackReviewToken,
  describeMissingTimeMapSpanPlaybackEvidence,
  readTimeMapSpanPlaybackReview,
  recordCandidateTimeMapSpanPlaybackReview,
  resetTimeMapPlaybackAccumulator,
  type TimeMapPlaybackAccumulatorState,
  type TimeMapPlaybackReviewScope,
  type TimeMapSpanPlaybackEvidence
} from "./timeMapPlaybackReviewEvidence";
import type { TimeMapPlaybackAxis } from "./timeMapPlayback";

const REVIEWED_AT = "2026-07-12T08:00:00.000Z";

describe("TimeMap 累计有效播放复核证据", () => {
  it("一次 play 对应的首个采样只建立基线，不能立即满足 matched", () => {
    const map = createMap("matched");
    const evidence = createEmptyTimeMapSpanPlaybackEvidence();
    const seeded = observe(evidence, resetTimeMapPlaybackAccumulator(), {
      axis: "source",
      positionMs: 0,
      observedAtMs: 0
    });

    expect(seeded.reason).toBe("seeded");
    expect(seeded.creditedDurationMs).toBe(0);
    expect(describeMissingTimeMapSpanPlaybackEvidence(map, 0, seeded.evidence)).toHaveLength(2);
  });

  it("matched 的 A 与 B 各自累计 2 秒真实推进和至少 1.5 秒覆盖后才完成", () => {
    const map = createMap("matched");
    let evidence = createEmptyTimeMapSpanPlaybackEvidence();
    let accumulator = resetTimeMapPlaybackAccumulator();

    ({ evidence, accumulator } = advance(evidence, accumulator, "span", "source", 0, 2_000));
    expect(assessTimeMapSpanPlaybackEvidence(map, 0, evidence)).toMatchObject([
      { axis: "source", effectiveDurationMs: 2_000, coveredDurationMs: 2_000, complete: true },
      { axis: "target", effectiveDurationMs: 0, coveredDurationMs: 0, complete: false }
    ]);

    ({ evidence, accumulator } = advance(
      evidence,
      resetTimeMapPlaybackAccumulator(),
      "span",
      "target",
      0,
      2_000
    ));
    expect(accumulator.lastObservation?.axis).toBe("target");
    expect(describeMissingTimeMapSpanPlaybackEvidence(map, 0, evidence)).toEqual([]);
  });

  it("暂停、后台、位置不推进和大幅 seek 都不累计", () => {
    const evidence = createEmptyTimeMapSpanPlaybackEvidence();
    let accumulator = resetTimeMapPlaybackAccumulator();

    const paused = observe(evidence, accumulator, {
      positionMs: 0,
      observedAtMs: 0,
      playing: false
    });
    expect(paused.reason).toBe("paused");
    accumulator = paused.accumulator;

    const seeded = observe(paused.evidence, accumulator, {
      positionMs: 0,
      observedAtMs: 100
    });
    const stalled = observe(seeded.evidence, seeded.accumulator, {
      positionMs: 0,
      observedAtMs: 300
    });
    expect(stalled.reason).toBe("stalled");

    const hidden = observe(stalled.evidence, stalled.accumulator, {
      positionMs: 200,
      observedAtMs: 500,
      visible: false
    });
    expect(hidden.reason).toBe("hidden");
    expect(hidden.accumulator.lastObservation).toBeNull();

    const afterHidden = observe(hidden.evidence, hidden.accumulator, {
      positionMs: 400,
      observedAtMs: 700
    });
    expect(afterHidden.reason).toBe("seeded");
    const seek = observe(afterHidden.evidence, afterHidden.accumulator, {
      positionMs: 5_000,
      observedAtMs: 800
    });
    expect(seek.reason).toBe("discontinuity");
    expect(seek.evidence.slots["span:source"].effectiveDurationMs).toBe(0);
  });

  it("切轴和循环跳回不会跨区间记时，重复区间只增加有效时长而不重复覆盖", () => {
    let evidence = createEmptyTimeMapSpanPlaybackEvidence();
    let accumulator = resetTimeMapPlaybackAccumulator();
    ({ evidence, accumulator } = advance(evidence, accumulator, "span", "source", 0, 1_500));

    const switchedAxis = observe(evidence, accumulator, {
      axis: "target",
      positionMs: 1_500,
      observedAtMs: 2_000
    });
    expect(switchedAxis.reason).toBe("seeded");

    const loopJump = observe(evidence, accumulator, {
      positionMs: 0,
      observedAtMs: 2_000
    });
    expect(loopJump.reason).toBe("discontinuity");
    const replay = observe(loopJump.evidence, loopJump.accumulator, {
      positionMs: 500,
      observedAtMs: 2_500
    });

    expect(replay.evidence.slots["span:source"]).toEqual({
      effectiveDurationMs: 2_000,
      coveredRanges: [{ startMs: 0, endMs: 1_500 }]
    });
  });

  it("sourceOnly 要求存在侧 2 秒，并要求段首段尾双方各 1.5 秒", () => {
    const map = createMap("sourceOnly");
    const requirements = createTimeMapSpanPlaybackRequirements(map, 0);

    expect(requirements.map((requirement) => requirement.slot)).toEqual([
      "span:source",
      "startBoundary:source",
      "startBoundary:target",
      "endBoundary:source",
      "endBoundary:target"
    ]);
    expect(requirements.map((requirement) => requirement.minimumEffectiveMs)).toEqual([
      2_000, 1_500, 1_500, 1_500, 1_500
    ]);
  });

  it("短区间把有效门槛收敛为一次完整时长，覆盖门槛为区间的 80%", () => {
    const map = createMap("matched", 800);
    expect(createTimeMapSpanPlaybackRequirements(map, 0)).toMatchObject([
      { minimumEffectiveMs: 800, minimumCoveredMs: 640 },
      { minimumEffectiveMs: 800, minimumCoveredMs: 640 }
    ]);

    const shortDifferenceMap = createMap("sourceOnly", 800);
    const boundaryRequirements = createTimeMapSpanPlaybackRequirements(
      shortDifferenceMap,
      0
    ).filter((requirement) => requirement.scope !== "span");
    expect(boundaryRequirements).toHaveLength(4);
    expect(
      boundaryRequirements.map((requirement) => [
        requirement.minimumEffectiveMs,
        requirement.minimumCoveredMs
      ])
    ).toEqual(Array.from({ length: 4 }, () => [800, 640]));
  });

  it("v2 token 往返保留版本化时长和覆盖摘要，span 边界变化后失效", () => {
    const map = createMap("matched");
    const evidence = completeEvidence(map, 0);
    const token = createTimeMapSpanPlaybackReviewToken(map, 0, evidence, REVIEWED_AT);
    const reviewedMap = withNote(map, token);
    const review = readTimeMapSpanPlaybackReview(reviewedMap, 0);

    expect(token).toMatch(/^manual-playback-review:v2:/);
    expect(review).toMatchObject({
      evidenceVersion: 2,
      policyVersion: 2,
      reviewedAt: REVIEWED_AT
    });
    expect(review?.slots["span:source"]).toEqual(evidence.slots["span:source"]);

    const originalSpan = reviewedMap.spans[0];
    if (!originalSpan) throw new Error("token 测试缺少 matched span");
    const changedMap = {
      ...reviewedMap,
      spans: [{ ...originalSpan, sourceEndMs: 9_900 }]
    };
    expect(readTimeMapSpanPlaybackReview(changedMap, 0)).toBeNull();
  });

  it("旧 v1 的一次启动 token 在升级后保留为审计文本但 fail-closed", () => {
    const map = withNote(
      createMap("matched"),
      `manual-playback-review:v1:0:${"a".repeat(64)}:source,target:::${REVIEWED_AT}`
    );

    expect(map.evidence.notes).toHaveLength(1);
    expect(readTimeMapSpanPlaybackReview(map, 0)).toBeNull();
  });

  it("拒绝异常碎片化或超长 token，避免 evidence.notes 无界膨胀", () => {
    const map = createMap("matched");
    const evidence = completeEvidence(map, 0);
    evidence.slots["span:source"].coveredRanges = Array.from({ length: 257 }, (_, index) => ({
      startMs: index * 3,
      endMs: index * 3 + 1
    }));
    expect(() => createTimeMapSpanPlaybackReviewToken(map, 0, evidence, REVIEWED_AT)).toThrow(
      "覆盖区间数量过多"
    );

    const oversized = `manual-playback-review:v2:${"x".repeat(70_000)}`;
    expect(readTimeMapSpanPlaybackReview(withNote(map, oversized), 0)).toBeNull();
  });

  it("blocked matched 候选完成真实 A/B 后降为 review，并恢复可确认状态", () => {
    const project = createEmptyProject("manual-recovery");
    const map = createMap("matched");
    map.sourceIdentity = createIdentity("1");
    map.targetIdentity = createIdentity("2");
    map.spans = [
      {
        ...createTestCompleteTimeMapSpan(
          {
            kind: "matched",
            sourceStartMs: 0,
            sourceEndMs: 10_000,
            targetStartMs: 0,
            targetEndMs: 10_000
          },
          "candidate:playback-review:span:0001"
        ),
        quality: {
          ...createTestCompleteTimeMapSpan(
            {
              kind: "matched",
              sourceStartMs: 0,
              sourceEndMs: 10_000,
              targetStartMs: 0,
              targetEndMs: 10_000
            },
            "candidate:playback-review:span:0001"
          ).quality,
          level: "blocked",
          reasons: ["自动候选需要逐段人工复核。"]
        }
      }
    ];
    map.quality.level = "blocked";
    project.mediaTimeMaps = [map];
    project.mediaMatchCandidates = [createCandidate(map)];
    project.assets = [
      {
        id: "asset-review",
        name: "review.xml",
        fileName: "review.xml",
        color: "#ffffff",
        items: [],
        warnings: [],
        importedAt: REVIEWED_AT,
        sourceReceipt: null
      }
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-review",
        assetId: "asset-review",
        sourceMediaId: map.sourceMediaId,
        linkedAt: REVIEWED_AT,
        updatedAt: REVIEWED_AT
      }
    ];

    const reviewed = recordCandidateTimeMapSpanPlaybackReview(
      project,
      map.id,
      0,
      completeEvidence(map, 0),
      REVIEWED_AT
    );

    expect(reviewed.mediaTimeMaps[0]).toMatchObject({
      quality: { level: "review" },
      spans: [{ quality: { level: "review" } }]
    });
    expect(reviewed.mediaMatchCandidates[0]?.state).toBe("pending");
    expect(readTimeMapSpanPlaybackReview(reviewed.mediaTimeMaps[0], 0)).not.toBeNull();
  });
});

function observe(
  evidence: TimeMapSpanPlaybackEvidence,
  accumulator: TimeMapPlaybackAccumulatorState,
  input: {
    scope?: TimeMapPlaybackReviewScope;
    axis?: TimeMapPlaybackAxis;
    positionMs: number;
    observedAtMs: number;
    playing?: boolean;
    visible?: boolean;
  }
) {
  return accumulateTimeMapPlaybackObservation(
    evidence,
    accumulator,
    {
      scope: input.scope ?? "span",
      axis: input.axis ?? "source",
      positionMs: input.positionMs,
      observedAtMs: input.observedAtMs,
      playing: input.playing ?? true,
      visible: input.visible ?? true
    },
    { startMs: 0, endMs: 10_000 }
  );
}

function advance(
  initialEvidence: TimeMapSpanPlaybackEvidence,
  initialAccumulator: TimeMapPlaybackAccumulatorState,
  scope: TimeMapPlaybackReviewScope,
  axis: TimeMapPlaybackAxis,
  startMs: number,
  durationMs: number
): { evidence: TimeMapSpanPlaybackEvidence; accumulator: TimeMapPlaybackAccumulatorState } {
  let evidence = initialEvidence;
  let accumulator = initialAccumulator;
  for (let elapsedMs = 0; elapsedMs <= durationMs; elapsedMs += 500) {
    const result = observe(evidence, accumulator, {
      scope,
      axis,
      positionMs: startMs + elapsedMs,
      observedAtMs: elapsedMs
    });
    evidence = result.evidence;
    accumulator = result.accumulator;
  }
  return { evidence, accumulator };
}

function completeEvidence(map: MediaTimeMap, spanIndex: number): TimeMapSpanPlaybackEvidence {
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

function withNote(map: MediaTimeMap, note: string): MediaTimeMap {
  return {
    ...map,
    evidence: { ...map.evidence, notes: [...map.evidence.notes, note] }
  };
}

function createMap(
  kind: MediaTimeMap["spans"][number]["kind"],
  durationMs = 10_000
): MediaTimeMap {
  const sourceEndMs = kind === "targetOnly" ? 0 : durationMs;
  const targetEndMs = kind === "sourceOnly" ? 0 : durationMs;
  return {
    id: "candidate:playback-review",
    revision: 1,
    sourceMediaId: "source-media",
    targetMediaId: "target-media",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    sourceStartMs: 0,
    sourceEndMs: Math.max(durationMs, sourceEndMs),
    targetStartMs: 0,
    targetEndMs: Math.max(durationMs, targetEndMs),
    spans: [
      {
        kind,
        sourceStartMs: 0,
        sourceEndMs,
        targetStartMs: 0,
        targetEndMs
      }
    ],
    quality: {
      level: "review",
      probability: null,
      metricSource: "missing",
      coverage: null,
      p50ResidualMs: null,
      p95ResidualMs: null,
      maxResidualMs: null,
      boundaryUncertaintyMs: null,
      alternativeMargin: null,
      anchorCount: 0,
      heldOutAnchorCount: 0,
      reasons: []
    },
    evidence: {
      types: [],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 0,
      notes: []
    },
    verification: null,
    engineVersion: "test",
    featureVersion: "test",
    parametersHash: "test",
    state: "candidate",
    createdAt: REVIEWED_AT,
    updatedAt: REVIEWED_AT,
    confirmedAt: null
  };
}

function createCandidate(map: MediaTimeMap): MediaMatchCandidate {
  return {
    id: "candidate-playback-review",
    batchId: "batch-playback-review",
    sourceMediaId: map.sourceMediaId,
    targetMediaId: map.targetMediaId,
    sourceStartMs: map.sourceStartMs,
    sourceEndMs: map.sourceEndMs,
    targetStartMs: map.targetStartMs,
    targetEndMs: map.targetEndMs,
    confidence: 0,
    state: "blocked",
    proposal: {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: []
    },
    timingRules: [],
    appliedSegmentIds: [],
    timeMapId: map.id,
    confirmedTimeMapId: null,
    createdAt: REVIEWED_AT,
    updatedAt: REVIEWED_AT
  };
}

function createIdentity(digit: string): MediaContentIdentity {
  return {
    algorithm: "test-identity-v1",
    sizeBytes: Number(digit) * 1_000,
    modifiedUnixMs: Number(digit) * 100,
    firstSampleDigest: digit.repeat(16),
    middleSampleDigest: ((Number(digit) + 1) % 10).toString().repeat(16),
    lastSampleDigest: ((Number(digit) + 2) % 10).toString().repeat(16)
  };
}
