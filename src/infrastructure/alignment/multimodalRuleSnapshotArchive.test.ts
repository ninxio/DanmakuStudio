import { describe, expect, it } from "vitest";
import {
  buildAlignmentMultimodalRuleSnapshot,
  type AlignmentMultimodalRuleSnapshot
} from "../../domain/alignment/alignmentMultimodalRuleSnapshot";
import { createEmptyProject } from "../../domain/project/factory";
import type { MediaTimeMap } from "../../domain/project/types";
import {
  MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_ENTRIES,
  addMultimodalRuleSnapshotToArchive,
  archiveContainsEquivalentMultimodalRuleSnapshot,
  createEmptyMultimodalRuleSnapshotArchive,
  parseMultimodalRuleSnapshotArchiveJson,
  serializeMultimodalRuleSnapshotArchive
} from "./multimodalRuleSnapshotArchive";

describe("视觉对照规则本机档案", () => {
  it("按内容去重、保留最近 16 份并可严格往返", () => {
    const snapshot = makeSnapshot();
    let archive = createEmptyMultimodalRuleSnapshotArchive(1);
    archive = addMultimodalRuleSnapshotToArchive(archive, snapshot, 2);
    const sameRulesNewTimestamp = makeSnapshot("2026-07-22T00:00:01.000Z");
    archive = addMultimodalRuleSnapshotToArchive(archive, sameRulesNewTimestamp, 3);
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0].savedAtMs).toBe(3);
    expect(archive.entries[0].snapshotId).toBe(sameRulesNewTimestamp.snapshotId);
    expect(archiveContainsEquivalentMultimodalRuleSnapshot(archive, snapshot)).toBe(true);

    for (let index = 0; index < 20; index += 1) {
      archive = addMultimodalRuleSnapshotToArchive(
        archive,
        makeSnapshot(new Date(10_000 + index).toISOString(), index + 1),
        10 + index
      );
    }
    expect(archive.entries).toHaveLength(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_ENTRIES);
    expect(parseMultimodalRuleSnapshotArchiveJson(
      serializeMultimodalRuleSnapshotArchive(archive)
    )).toEqual(archive);
    expect(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_MAX_ENTRIES).toBe(16);
  });

  it("拒绝档案和内层快照篡改", () => {
    const archive = addMultimodalRuleSnapshotToArchive(null, makeSnapshot(), 2);
    const tampered = structuredClone(archive);
    tampered.entries[0].snapshot.timeMaps[0].spans[0].targetStartMs += 1;
    expect(() => parseMultimodalRuleSnapshotArchiveJson(JSON.stringify(tampered))).toThrow(
      /摘要不匹配/
    );

    const extra = { ...archive, unexpected: true };
    expect(() => parseMultimodalRuleSnapshotArchiveJson(JSON.stringify(extra))).toThrow(
      /未知字段/
    );
  });
});

function makeSnapshot(
  createdAt = "2026-07-22T00:00:00.000Z",
  variant = 0
): AlignmentMultimodalRuleSnapshot {
  const project = createEmptyProject("snapshot-archive");
  project.mediaTimeMaps = [createTimeMap(variant)];
  const result = buildAlignmentMultimodalRuleSnapshot(project, createdAt);
  if (!result.snapshot) throw new Error("fixture must produce a snapshot");
  return result.snapshot;
}

function createTimeMap(variant = 0): MediaTimeMap {
  return {
    id: "map-id",
    revision: 1,
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: identity("a"),
    targetIdentity: identity("b"),
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 2_000 + variant,
    targetEndMs: 12_000 + variant,
    spans: [{
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 2_000 + variant,
      targetEndMs: 12_000 + variant
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
    algorithm: "sha256-full-file-v2" as const,
    sizeBytes: 1000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: digit.repeat(64),
    lastSampleDigest: digit.repeat(64)
  };
}
