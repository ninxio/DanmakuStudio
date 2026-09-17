import { describe, expect, it } from "vitest";
import type { MediaContentIdentity, MediaTimeMap } from "../project/types";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import { computeMediaTimeMapCoreDigest } from "./mediaTimeMap";
import {
  createRealMediaBenchmarkContentIdentity,
  createRealMediaBenchmarkGoldFromConfirmedTimeMap
} from "./realMediaGoldFromTimeMap";

describe("C137 confirmed TimeMap -> real-media gold", () => {
  it("按整数映射生成稳定 matched anchors，并剥离算法证据", () => {
    const gold = createRealMediaBenchmarkGoldFromConfirmedTimeMap(createTimeMap());

    expect(gold.matchedAnchors).toEqual([
      { id: "anchor-0001", sourceMs: 0, targetMs: 1_000 },
      { id: "anchor-0002", sourceMs: 2_500, targetMs: 3_500 },
      { id: "anchor-0003", sourceMs: 5_000, targetMs: 6_000 },
      { id: "anchor-0004", sourceMs: 7_500, targetMs: 8_500 },
      { id: "anchor-0005", sourceMs: 9_999, targetMs: 10_999 },
      { id: "anchor-0006", sourceMs: 10_000, targetMs: 13_000 },
      { id: "anchor-0007", sourceMs: 12_500, targetMs: 15_500 },
      { id: "anchor-0008", sourceMs: 15_000, targetMs: 18_000 },
      { id: "anchor-0009", sourceMs: 17_500, targetMs: 20_500 },
      { id: "anchor-0010", sourceMs: 19_999, targetMs: 22_999 }
    ]);
    expect(gold.targetOnlySpans).toEqual([
      {
        kind: "targetOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 10_000,
        targetStartMs: 11_000,
        targetEndMs: 13_000
      }
    ]);
    expect(JSON.stringify(gold)).not.toContain("quality");
    expect(JSON.stringify(gold)).not.toContain("probability");
  });

  it("拒绝候选、无 matched 内容和不合法时间图", () => {
    expect(() =>
      createRealMediaBenchmarkGoldFromConfirmedTimeMap(
        createTimeMap({ state: "candidate", confirmedAt: null })
      )
    ).toThrow("只有已确认");
    expect(() =>
      createRealMediaBenchmarkGoldFromConfirmedTimeMap(
        createTimeMap({
          spans: [
            {
              kind: "ambiguous",
              sourceStartMs: 0,
              sourceEndMs: 20_000,
              targetStartMs: 1_000,
              targetEndMs: 23_000
            }
          ]
        })
      )
    ).toThrow("5 个不同");
    expect(() =>
      createRealMediaBenchmarkGoldFromConfirmedTimeMap(
        createTimeMap({
          spans: [
            {
              kind: "matched",
              sourceStartMs: 10_000,
              sourceEndMs: 9_000,
              targetStartMs: 1_000,
              targetEndMs: 2_000
            }
          ]
        })
      )
    ).toThrow("时间图结构无效");
  });

  it("拒绝仅确认但未绑定 v2 人工签名的算法结果", () => {
    const base = createTimeMap();
    const unsigned = createTimeMap({
      quality: { ...base.quality, level: "review" },
      verification: null
    });
    expect(() => createRealMediaBenchmarkGoldFromConfirmedTimeMap(unsigned)).toThrow(
      "v2 人工复核签名"
    );
    const tampered = createTimeMap();
    if (!tampered.verification || tampered.verification.recordVersion !== 2) {
      throw new Error("测试夹具缺少签名记录。");
    }
    tampered.verification.mapCoreDigest = `sha256:${"f".repeat(64)}`;
    expect(() => createRealMediaBenchmarkGoldFromConfirmedTimeMap(tampered)).toThrow(
      "核心摘要"
    );
  });

  it("只接受三份字段一致的 full-file-v2 SHA-256", () => {
    expect(createRealMediaBenchmarkContentIdentity(createIdentity("a"))).toEqual({
      algorithm: "sha256-full-file-v2",
      sizeBytes: 123,
      digest: "a".repeat(64)
    });
    expect(() =>
      createRealMediaBenchmarkContentIdentity({
        ...createIdentity("a"),
        middleSampleDigest: "b".repeat(64)
      })
    ).toThrow("全文件摘要");
    expect(() => createRealMediaBenchmarkContentIdentity(null)).toThrow("尚未绑定");
  });
});

function createTimeMap(overrides: Partial<MediaTimeMap> = {}): MediaTimeMap {
  const map: MediaTimeMap = {
    id: "map-1",
    revision: 1,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: createIdentity("a"),
    targetIdentity: createIdentity("b"),
    sourceStartMs: 0,
    sourceEndMs: 20_000,
    targetStartMs: 1_000,
    targetEndMs: 23_000,
    spans: [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 1_000,
        targetEndMs: 11_000
      },
      {
        kind: "targetOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 10_000,
        targetStartMs: 11_000,
        targetEndMs: 13_000
      },
      {
        kind: "matched",
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        targetStartMs: 13_000,
        targetEndMs: 23_000
      }
    ],
    quality: {
      level: "verified",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 20,
      p95ResidualMs: 80,
      maxResidualMs: 90,
      boundaryUncertaintyMs: 50,
      alternativeMargin: 0.2,
      anchorCount: 20,
      heldOutAnchorCount: 5,
      reasons: []
    },
    evidence: {
      types: ["manual"],
      audioAnchorCount: 20,
      visualAnchorCount: 0,
      heldOutAnchorCount: 5,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v1",
    parametersHash: "sha256:test",
    state: "confirmed",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    confirmedAt: "2026-07-14T00:00:00.000Z",
    ...overrides
  };
  map.spans = map.spans.map((span, index) =>
    createTestCompleteTimeMapSpan(span, `gold-span-${index + 1}`)
  );
  if (overrides.verification === undefined) {
    map.verification = {
      recordVersion: 2,
      method: "manual-review",
      verificationId: "verification-gold-1",
      issuerKeyId: "install-key-gold-1",
      issuerSequence: 1,
      signatureAlgorithm: "hmac-sha256-v1",
      signature: "1".repeat(64),
      requestDigest: `sha256:${"2".repeat(64)}`,
      mapCoreDigest: computeMediaTimeMapCoreDigest(map),
      mapRevision: map.revision,
      sourceIdentity: structuredClone(map.sourceIdentity ?? createIdentity("a")),
      targetIdentity: structuredClone(map.targetIdentity ?? createIdentity("b")),
      calibrationArtifactId: "manual-review-protocol",
      calibrationArtifactVersion: "1",
      reviewEvidenceDigest: `sha256:${"3".repeat(64)}`,
      verifier: "reviewer-a",
      verifiedAt: "2026-07-14T00:00:00.000Z",
      revocation: null
    };
  }
  return map;
}

function createIdentity(seed: string): MediaContentIdentity {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: 123,
    modifiedUnixMs: 1,
    firstSampleDigest: seed.repeat(64),
    middleSampleDigest: seed.repeat(64),
    lastSampleDigest: seed.repeat(64)
  };
}
