import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTrustedAutomaticMediaTimeMapVerification,
  applyAuthorityIssuedManualMediaTimeMapVerification,
  areMediaTimeMapImmutableLineagesEquivalent,
  areMediaTimeMapsSemanticallyEquivalent,
  assessMediaTimeMapVerification,
  assessTrustedAutomaticMediaTimeMapVerificationEligibility,
  clearRegisteredManualMediaTimeMapVerificationTrust,
  computeMediaTimeMapCoreDigest,
  confirmCandidateTimeMap,
  createCandidateTimeMapId,
  createConfirmedTimeMapId,
  createLegacyMediaTimeMap,
  createMediaTimeMapCoreCanonicalJson,
  createManualMediaTimeMapVerificationRequest,
  reconcileMediaTimeMapQuality,
  registerManualMediaTimeMapVerificationAuthorityResult,
  supersedeMediaTimeMap
} from "./mediaTimeMap";
import type { MediaContentIdentity, MediaTimeMap } from "../project/types";
import { sha256Hex } from "../shared/sha256";
import { createTimeMapSpanPlaybackReviewToken } from "./timeMapPlaybackReviewEvidence";
import { createTestCompleteTimeMapSpanPlaybackEvidence } from "../../test/manualVerification";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";

const TIMESTAMP = "2026-07-12T00:00:00.000Z";

describe("媒体时间图 revision", () => {
  beforeEach(() => clearRegisteredManualMediaTimeMapVerificationTrust());
  it("旧正 gap 只迁移为 legacy-unverified candidate", () => {
    const map = createLegacyMediaTimeMap({
      id: createCandidateTimeMapId("candidate-1"),
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      sourceStartMs: 10_000,
      sourceEndMs: 70_000,
      targetStartMs: 20_000,
      expectedTargetEndMs: 85_000,
      timingRules: [{ id: "gap-1", sourceAtMs: 40_000, gapMs: 5_000, note: "旧删减" }],
      state: "candidate",
      timestamp: TIMESTAMP,
      coverage: 0.9,
      anchorCount: 12
    });

    expect(map.quality.level).toBe("legacy-unverified");
    expect(map.verification).toBeNull();
    expect(map.state).toBe("candidate");
    expect(map.confirmedAt).toBeNull();
    expect(map.spans.map((span) => span.kind)).toEqual(["matched", "targetOnly", "matched"]);
  });

  it("目标范围不一致或负 gap 时阻断，绝不修饰成已验证", () => {
    const mismatch = createLegacyMediaTimeMap({
      id: "mismatch",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      expectedTargetEndMs: 80_000,
      timingRules: [],
      state: "candidate",
      timestamp: TIMESTAMP,
      coverage: null,
      anchorCount: 0
    });
    const negative = createLegacyMediaTimeMap({
      id: "negative",
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      expectedTargetEndMs: 55_000,
      timingRules: [{ id: "gap", sourceAtMs: 20_000, gapMs: -5_000, note: "未知" }],
      state: "candidate",
      timestamp: TIMESTAMP,
      coverage: 0.8,
      anchorCount: 4
    });

    expect(mismatch).toMatchObject({
      targetEndMs: 80_000,
      quality: { level: "blocked" },
      spans: [{ kind: "ambiguous" }]
    });
    expect(negative).toMatchObject({
      targetEndMs: 55_000,
      quality: { level: "blocked" },
      spans: [{ kind: "ambiguous" }]
    });
  });

  it("确认会创建独立 revision，撤销后保留 superseded 审计记录", () => {
    const candidate = createLegacyMediaTimeMap({
      id: createCandidateTimeMapId("candidate-1"),
      sourceMediaId: "source-1",
      targetMediaId: "target-1",
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      expectedTargetEndMs: 60_000,
      timingRules: [],
      state: "candidate",
      timestamp: TIMESTAMP,
      coverage: null,
      anchorCount: 0
    });
    const confirmed = confirmCandidateTimeMap(
      candidate,
      createConfirmedTimeMapId("candidate-1", 1),
      1,
      "2026-07-12T00:01:00.000Z"
    );
    const superseded = supersedeMediaTimeMap(confirmed, "2026-07-12T00:02:00.000Z");

    expect(confirmed.id).not.toBe(candidate.id);
    expect(confirmed).toMatchObject({ state: "confirmed", revision: 1 });
    expect(superseded).toMatchObject({
      state: "superseded",
      updatedAt: "2026-07-12T00:02:00.000Z"
    });
    expect(() => createConfirmedTimeMapId("candidate-1", 0)).toThrow("正整数");
  });

  it("没有 verification record 的自报 verified 一律降为 review", () => {
    const map = createVerificationEligibleMap();
    map.quality.level = "verified";

    const reconciled = reconcileMediaTimeMapQuality(map);

    expect(reconciled.quality.level).toBe("review");
    expect(reconciled.quality.reasons.join(" ")).toContain("可信验证记录");
  });

  it("canonical digest 会绑定 spans、revision、媒体身份、指标与引擎 provenance", () => {
    const map = createVerificationEligibleMap();
    const canonicalJson = createMediaTimeMapCoreCanonicalJson(map);
    const digest = computeMediaTimeMapCoreDigest(map);
    expect((JSON.parse(canonicalJson) as unknown[]).slice(0, 5)).toEqual([
      "media-time-map-core-v2",
      map.id,
      map.revision,
      map.sourceMediaId,
      map.targetMediaId
    ]);
    expect(digest).toBe(`sha256:${sha256Hex(canonicalJson)}`);
    const mutations: Array<(candidate: MediaTimeMap) => void> = [
      (candidate) => {
        candidate.spans[0].targetEndMs += 1;
      },
      (candidate) => {
        candidate.revision += 1;
      },
      (candidate) => {
        candidate.sourceIdentity!.firstSampleDigest = "f".repeat(16);
      },
      (candidate) => {
        candidate.quality.p95ResidualMs = 99;
      },
      (candidate) => {
        candidate.parametersHash = "changed";
      },
      (candidate) => {
        candidate.quality.reasons.push("被篡改的质量理由");
      },
      (candidate) => {
        candidate.evidence.notes.push("被篡改的人工审计备注");
      }
    ];

    for (const mutate of mutations) {
      const changed = structuredClone(map);
      mutate(changed);
      expect(computeMediaTimeMapCoreDigest(changed)).not.toBe(digest);
    }
  });

  it("proposal 语义与 confirmed immutable lineage 使用分层摘要", () => {
    const candidate = createVerificationEligibleMap();
    candidate.state = "candidate";
    candidate.confirmedAt = null;
    const confirmed = confirmCandidateTimeMap(
      candidate,
      createConfirmedTimeMapId("semantic-layer", 1),
      1,
      "2026-07-12T00:01:00.000Z"
    );

    expect(areMediaTimeMapsSemanticallyEquivalent(candidate, confirmed)).toBe(true);
    expect(areMediaTimeMapImmutableLineagesEquivalent(candidate, confirmed)).toBe(true);

    const verificationLifecycle = structuredClone(confirmed);
    verificationLifecycle.quality = {
      ...verificationLifecycle.quality,
      p95ResidualMs: 99,
      reasons: [...verificationLifecycle.quality.reasons, "人工签发生命周期质量记录"]
    };
    verificationLifecycle.evidence = {
      ...verificationLifecycle.evidence,
      notes: [...verificationLifecycle.evidence.notes, "人工签发生命周期证据"]
    };
    expect(areMediaTimeMapsSemanticallyEquivalent(candidate, verificationLifecycle)).toBe(false);
    expect(areMediaTimeMapImmutableLineagesEquivalent(candidate, verificationLifecycle)).toBe(true);

    const tamperedMapping = structuredClone(verificationLifecycle);
    tamperedMapping.spans[0].targetEndMs += 1;
    expect(areMediaTimeMapImmutableLineagesEquivalent(candidate, tamperedMapping)).toBe(false);
  });

  it("签名人工 record 按值跨 structuredClone 可信，应用重启前必须重新核验注册表", () => {
    const verified = createSignedVerification();

    expect(verified.quality.level).toBe("verified");
    expect(assessMediaTimeMapVerification(verified)).toEqual({ trusted: true, reason: null });
    expect(assessMediaTimeMapVerification(structuredClone(verified))).toEqual({
      trusted: true,
      reason: null
    });

    const importedJson = JSON.parse(JSON.stringify(verified)) as MediaTimeMap;
    clearRegisteredManualMediaTimeMapVerificationTrust();
    const reopened = reconcileMediaTimeMapQuality(importedJson);
    expect(reopened.quality.level).toBe("review");
    expect(reopened.quality.reasons.join(" ")).toContain("安装级验证机构");

    const record = verified.verification;
    if (!record || record.recordVersion !== 2) throw new Error("测试签名记录缺失");
    registerManualMediaTimeMapVerificationAuthorityResult({
      verificationId: record.verificationId,
      issuerKeyId: record.issuerKeyId,
      signature: record.signature,
      requestDigest: record.requestDigest,
      status: "active",
      reason: "测试 native 复核"
    });
    const restored = reconcileMediaTimeMapQuality({
      ...reopened,
      quality: { ...reopened.quality, level: "verified" }
    });
    expect(restored.quality.level).toBe("verified");
  });

  it("自动 record 即使摘要正确，calibration artifact 不在内置白名单也不能 verified", () => {
    const map = createVerificationEligibleMap();
    map.quality.level = "verified";
    map.verification = {
      recordVersion: 1,
      method: "automatic-calibration",
      mapCoreDigest: computeMediaTimeMapCoreDigest(map),
      mapRevision: map.revision,
      sourceIdentity: structuredClone(map.sourceIdentity!),
      targetIdentity: structuredClone(map.targetIdentity!),
      calibrationArtifactId: "self-reported-benchmark",
      calibrationArtifactVersion: "999",
      verifier: "external-json",
      verifiedAt: TIMESTAMP
    };

    const reconciled = reconcileMediaTimeMapQuality(map);
    expect(reconciled.quality.level).toBe("review");
    expect(reconciled.quality.reasons.join(" ")).toContain("不在应用内置受信列表");
  });

  it("只有指定 V2.5 引擎且通过独立留出硬门的确认图才能自动签发并在重开后保持可信", () => {
    const eligible = createAutomaticVerificationEligibleMap();
    expect(assessTrustedAutomaticMediaTimeMapVerificationEligibility(eligible)).toEqual({
      eligible: true,
      reason: null
    });

    const verified = applyTrustedAutomaticMediaTimeMapVerification(eligible, TIMESTAMP);
    expect(verified).toMatchObject({
      state: "confirmed",
      quality: { level: "verified" },
      verification: {
        recordVersion: 1,
        method: "automatic-calibration",
        calibrationArtifactId: "alignment-v2.5-independent-holdout-policy",
        calibrationArtifactVersion: "1"
      }
    });
    expect(assessMediaTimeMapVerification(verified)).toEqual({ trusted: true, reason: null });
    expect(
      reconcileMediaTimeMapQuality(JSON.parse(JSON.stringify(verified)) as MediaTimeMap).quality
        .level
    ).toBe("verified");

    const wrongEngine = createAutomaticVerificationEligibleMap();
    wrongEngine.engineVersion = "alignment-v2.4-rust";
    expect(assessTrustedAutomaticMediaTimeMapVerificationEligibility(wrongEngine)).toMatchObject({
      eligible: false
    });

    const ambiguous = createAutomaticVerificationEligibleMap();
    ambiguous.spans[0] = {
      ...ambiguous.spans[0],
      kind: "ambiguous"
    };
    expect(assessTrustedAutomaticMediaTimeMapVerificationEligibility(ambiguous)).toMatchObject({
      eligible: false
    });
  });

  it("record 与 revision、身份或核心摘要任一不匹配时都会失去 verified", () => {
    const verified = createSignedVerification();
    const cases: Array<[string, (candidate: MediaTimeMap) => void]> = [
      ["revision", (candidate) => candidate.revision++],
      ["媒体身份", (candidate) => (candidate.sourceIdentity!.sizeBytes += 1)],
      ["核心摘要", (candidate) => (candidate.parametersHash = "tampered")]
    ];

    for (const [reasonFragment, mutate] of cases) {
      const candidate = structuredClone(verified);
      candidate.verification = verified.verification;
      mutate(candidate);
      const reconciled = reconcileMediaTimeMapQuality(candidate);
      expect(reconciled.quality.level).toBe("review");
      expect(reconciled.quality.reasons.join(" ")).toContain(reasonFragment);
    }
  });

  it("拒绝未分类的 ambiguous 与单侧差异，人工分类 note 会进入签名摘要", () => {
    const ambiguous = createVerificationEligibleMap();
    ambiguous.spans = [
      createTestCompleteTimeMapSpan({
        kind: "ambiguous",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetStartMs: 0,
        targetEndMs: 60_000
      })
    ];
    expect(() =>
      createManualMediaTimeMapVerificationRequest(ambiguous, verificationInput())
    ).toThrow("replacement");
    ambiguous.evidence.notes.push(`manual-span-review:v1:0:replacement:${TIMESTAMP}`);
    attachTestPlaybackReviews(ambiguous);
    expect(
      createManualMediaTimeMapVerificationRequest(ambiguous, verificationInput()).requestDigest
    ).toMatch(/^sha256:[0-9a-f]{64}$/);

    const oneSided = createVerificationEligibleMap();
    oneSided.targetEndMs = 55_000;
    oneSided.spans = [
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 20_000,
        targetStartMs: 0,
        targetEndMs: 20_000
      }, "one-sided:span:0001"),
      createTestCompleteTimeMapSpan({
        kind: "sourceOnly",
        sourceStartMs: 20_000,
        sourceEndMs: 25_000,
        targetStartMs: 20_000,
        targetEndMs: 20_000
      }, "one-sided:span:0002"),
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 25_000,
        sourceEndMs: 60_000,
        targetStartMs: 20_000,
        targetEndMs: 55_000
      }, "one-sided:span:0003")
    ];
    attachTestPlaybackReviews(oneSided);
    expect(() =>
      createManualMediaTimeMapVerificationRequest(oneSided, verificationInput())
    ).toThrow("source-extra");

    oneSided.evidence.notes.push(`manual-span-review:v1:1:source-extra:${TIMESTAMP}`);
    const request = createManualMediaTimeMapVerificationRequest(oneSided, verificationInput());
    expect(request.reviewEvidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const changed = structuredClone(oneSided);
    changed.evidence.notes[changed.evidence.notes.length - 1] =
      `manual-span-review:v1:1:source-extra:2026-07-12T00:00:01.000Z`;
    expect(
      createManualMediaTimeMapVerificationRequest(changed, verificationInput()).requestDigest
    ).not.toBe(request.requestDigest);
  });
});

function createSignedVerification(): MediaTimeMap {
  return applyAuthorityIssuedManualMediaTimeMapVerification(
    createVerificationEligibleMap(),
    {
      calibrationArtifactId: "manual-review-protocol",
      calibrationArtifactVersion: "1",
      verifier: "reviewer-1",
      verifiedAt: TIMESTAMP
    },
    {
      verificationId: "verification-1",
      issuerKeyId: "install-key-1",
      issuerSequence: 1,
      signatureAlgorithm: "hmac-sha256-v1",
      signature: "1".repeat(64),
      requestDigest: createRequestDigest()
    }
  );
}

function verificationInput() {
  return {
    calibrationArtifactId: "manual-review-protocol",
    calibrationArtifactVersion: "1",
    verifier: "reviewer-1",
    verifiedAt: TIMESTAMP
  };
}

function createRequestDigest(): string {
  const map = createVerificationEligibleMap();
  const input = verificationInput();
  return createManualMediaTimeMapVerificationRequest(map, input).requestDigest;
}

function createVerificationEligibleMap(): MediaTimeMap {
  const identity = createIdentity("1");
  return attachTestPlaybackReviews({
    id: "verified-map-1",
    revision: 1,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: structuredClone(identity),
    targetIdentity: createIdentity("2"),
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetStartMs: 0,
        targetEndMs: 60_000
      })
    ],
    quality: {
      level: "review",
      probability: 0.999,
      metricSource: "measured",
      coverage: 1,
      uniqueContentCoverage: 1,
      p50ResidualMs: 10,
      p95ResidualMs: 50,
      p99ResidualMs: 70,
      maxResidualMs: 80,
      boundaryUncertaintyMs: 100,
      alternativeMargin: 0.5,
      anchorCount: 40,
      anchorRegionCount: 3,
      heldOutAnchorCount: 5,
      reasons: ["等待明确人工复核。"]
    },
    evidence: {
      types: ["manual"],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 5,
      top1Top2Margin: 0.5,
      uniqueContentCoverage: 1,
      repeatedContentOnly: false,
      selectedTrackReason: "测试人工复核轨道。",
      alternativeTrackScores: [],
      notes: ["测试人工复核证据。"]
    },
    verification: null,
    engineVersion: "alignment-v2-test",
    featureVersion: "features-v2-test",
    parametersHash: "parameters-test",
    state: "confirmed",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    confirmedAt: TIMESTAMP
  });
}

function createAutomaticVerificationEligibleMap(): MediaTimeMap {
  const map = createVerificationEligibleMap();
  map.sourceStream = createTestAudioStreamIdentity(0);
  map.targetStream = createTestAudioStreamIdentity(1);
  map.engineVersion = "alignment-v2.5-rust";
  map.featureVersion =
    "pcm-s16le-16k-pts-tiled-fine-content-window-sequence-reuse-frontier-v25";
  map.quality = {
    ...map.quality,
    level: "review",
    probability: null,
    coverage: 0.95,
    uniqueContentCoverage: 0.9,
    p50ResidualMs: 20,
    p95ResidualMs: 80,
    p99ResidualMs: 120,
    maxResidualMs: 180,
    boundaryUncertaintyMs: 100,
    alternativeMargin: 0.5,
    anchorCount: 16,
    anchorRegionCount: 3,
    heldOutAnchorCount: 8,
    reasons: ["等待内置独立留出策略复核。"]
  };
  map.evidence = {
    ...map.evidence,
    types: ["audio"],
    audioAnchorCount: 16,
    visualAnchorCount: 0,
    heldOutAnchorCount: 8,
    uniqueContentCoverage: 0.9,
    repeatedContentOnly: false,
    notes: ["独立留出证据未参与拟合。"]
  };
  map.spans = map.spans.map((span) => ({
    ...span,
    quality: {
      ...span.quality,
      level: "review",
      metricSource: "measured",
      probability: null,
      coverage: 0.95,
      uniqueContentCoverage: 0.9,
      alternativeMargin: 0.5,
      anchorCount: 16,
      heldOutAnchorCount: 8,
      p50ResidualMs: 20,
      p95ResidualMs: 80,
      p99ResidualMs: 120,
      maxResidualMs: 180,
      boundaryUncertaintyMs: 100,
      leftSupport: "supported",
      rightSupport: "supported",
      signals: { audio: "used", visual: "blocked", danmaku: "blocked" },
      reasons: ["自动策略测试逐段证据完整。"]
    }
  }));
  return map;
}

function createTestAudioStreamIdentity(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "aac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 2,
    frameRate: null,
    language: "zh",
    title: null
  };
}

function attachTestPlaybackReviews(map: MediaTimeMap): MediaTimeMap {
  map.evidence.notes = map.evidence.notes.filter(
    (note) =>
      !note.startsWith("manual-playback-review:v1:") &&
      !note.startsWith("manual-playback-review:v2:")
  );
  map.evidence.notes.push(
    ...map.spans.map((_, spanIndex) =>
      createTimeMapSpanPlaybackReviewToken(
        map,
        spanIndex,
        createTestCompleteTimeMapSpanPlaybackEvidence(map, spanIndex),
        TIMESTAMP
      )
    )
  );
  return map;
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
