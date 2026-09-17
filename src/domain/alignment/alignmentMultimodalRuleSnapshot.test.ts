import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type { MediaTimeMap } from "../project/types";
import {
  buildAlignmentMultimodalRuleSnapshot,
  parseAlignmentMultimodalRuleSnapshot,
  serializeAlignmentMultimodalRuleSnapshot
} from "./alignmentMultimodalRuleSnapshot";
import crossLanguageVector from "../../../ml/contracts/alignment-multimodal-rule-snapshot-cross-language-vector-v1.json";

describe("多模态生产规则快照", () => {
  it("只导出未被人工接管且绑定完整媒体摘要的生产时间图", () => {
    const project = createEmptyProject("snapshot");
    const base = createTimeMap();
    project.mediaTimeMaps = [
      base,
      { ...base, id: "confirmed-copy", state: "confirmed" },
      {
        ...base,
        id: "manual-map",
        evidence: { ...base.evidence, types: ["audio", "manual"] }
      },
      { ...base, id: "legacy-map", sourceIdentity: null }
    ];

    const result = buildAlignmentMultimodalRuleSnapshot(
      project,
      "2026-07-22T18:00:00.000Z"
    );

    expect(result.eligibleTimeMapCount).toBe(1);
    expect(result.skippedTimeMapCount).toBe(2);
    expect(result.snapshot?.timeMaps).toHaveLength(1);
    expect(result.snapshot?.timeMaps[0].sourceContentDigest).toBe(`sha256:${"a".repeat(64)}`);
    expect(result.snapshot?.timeMaps[0].spans).toEqual([
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 2_000,
        targetEndMs: 12_000
      }
    ]);
    const serialized = serializeAlignmentMultimodalRuleSnapshot(result.snapshot!);
    expect(serialized).not.toContain("source-media-id");
    expect(serialized).not.toContain("target-media-id");
    expect(serialized).not.toContain("manual-map");
    expect(serialized).toContain('"containsSensitiveMediaDigests": true');
    expect(serialized).toContain('"permission": "local-multimodal-shadow-association-only"');
    expect(result.snapshot).toEqual(crossLanguageVector);
  });

  it("媒体摘要、规则参数或分段变化都会改变绑定身份", () => {
    const first = createEmptyProject("first");
    first.mediaTimeMaps = [createTimeMap()];
    const baseline = buildAlignmentMultimodalRuleSnapshot(
      first,
      "2026-07-22T18:00:00.000Z"
    ).snapshot!;
    const changed = createEmptyProject("changed");
    changed.mediaTimeMaps = [{
      ...createTimeMap(),
      parametersHash: "sha256:changed",
      spans: [{
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 2_100,
        targetEndMs: 12_100
      }]
    }];
    const changedSnapshot = buildAlignmentMultimodalRuleSnapshot(
      changed,
      "2026-07-22T18:00:00.000Z"
    ).snapshot!;

    expect(changedSnapshot.timeMaps[0].ruleProfileDigest).not.toBe(
      baseline.timeMaps[0].ruleProfileDigest
    );
    expect(changedSnapshot.timeMaps[0].timeMapKey).not.toBe(baseline.timeMaps[0].timeMapKey);
    expect(changedSnapshot.snapshotId).not.toBe(baseline.snapshotId);
  });

  it("严格解析跨语言快照并拒绝内层分段篡改", () => {
    expect(parseAlignmentMultimodalRuleSnapshot(crossLanguageVector)).toEqual(crossLanguageVector);
    const tampered = structuredClone(crossLanguageVector);
    tampered.timeMaps[0].spans[0].targetStartMs += 1;
    expect(() => parseAlignmentMultimodalRuleSnapshot(tampered)).toThrow(/摘要不匹配/);
  });
});

function createTimeMap(): MediaTimeMap {
  return {
    id: "map-id",
    revision: 1,
    sourceMediaId: "source-media-id",
    targetMediaId: "target-media-id",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: identity("a"),
    targetIdentity: identity("b"),
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 2_000,
    targetEndMs: 12_000,
    spans: [{
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 2_000,
      targetEndMs: 12_000
    }],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 100,
      p95ResidualMs: 200,
      maxResidualMs: 300,
      boundaryUncertaintyMs: 400,
      alternativeMargin: 0.2,
      anchorCount: 3,
      heldOutAnchorCount: 1,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 3,
      visualAnchorCount: 0,
      heldOutAnchorCount: 1,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    state: "candidate",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    confirmedAt: null
  };
}

function identity(digit: string) {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: 1000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: digit.repeat(64),
    lastSampleDigest: digit.repeat(64)
  };
}
