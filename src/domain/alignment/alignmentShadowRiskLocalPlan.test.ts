import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import type {
  AlignmentReviewRecord,
  EditorProject,
  MediaContentIdentity,
  MediaTimeMap,
  ProjectMediaReference
} from "../project/types";
import { createAlignmentShadowRiskAssociationManifest } from "./alignmentShadowRiskOverlay";
import {
  buildAlignmentShadowRiskLocalPlan,
  serializeAlignmentShadowRiskLocalPlan
} from "./alignmentShadowRiskLocalPlan";

describe("项目绑定的本机音频风险计算计划", () => {
  it("只导出具备本地路径、全文件身份、明确音轨和有效区间的记录", () => {
    const project = createEligibleProject();
    project.alignmentReviewRecords.push({
      ...createReviewRecord(),
      id: "review:missing-map",
      timeMapId: "map:missing"
    });

    const result = buildAlignmentShadowRiskLocalPlan(
      project,
      "2026-07-22T18:00:00.000Z"
    );
    const plan = result.plan!;
    const vector = JSON.parse(
      readFileSync(
        resolve("ml/contracts/alignment-shadow-risk-local-plan-cross-language-vector-v1.json"),
        "utf8"
      )
    ) as {
      association: ReturnType<typeof createAlignmentShadowRiskAssociationManifest>;
      plan: typeof plan;
    };

    expect(result).toMatchObject({ eligibleRecordCount: 1, skippedRecordCount: 1 });
    expect(result.skippedByReason["missing-current-time-map"]).toBe(1);
    expect(plan.associationManifestId).toBe(
      createAlignmentShadowRiskAssociationManifest(project).manifestId
    );
    expect(plan.permission).toBe("local-offline-shadow-scoring-only");
    expect(plan.releaseEligible).toBe(false);
    expect(plan.containsSensitiveLocalPaths).toBe(true);
    expect(plan.media.map((media) => media.mediaId).sort()).toEqual(["source-1", "target-1"]);
    expect(plan.media.find((media) => media.mediaId === "source-1")).toMatchObject({
      path: "C:\\authorized\\source.wav",
      contentDigest: `sha256:${"a".repeat(64)}`,
      audioStreamIndex: 1
    });
    expect(plan.records).toEqual([
      expect.objectContaining({
        recordId: "review:eligible",
        sourceStartMs: 1_000,
        sourceEndMs: 9_000,
        targetStartMs: 2_000,
        targetEndMs: 10_000
      })
    ]);
    const serialized = serializeAlignmentShadowRiskLocalPlan(plan);
    expect(serialized).toContain("C:\\\\authorized\\\\source.wav");
    expect(serialized).not.toContain('"decision"');
    expect(serialized).not.toContain("unresolved");
    expect(plan.planId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(createAlignmentShadowRiskAssociationManifest(project)).toEqual(vector.association);
    expect(plan).toEqual(vector.plan);
  });

  it("缺少本地媒体或全文件身份时拒绝生成假计划", () => {
    const project = createEligibleProject();
    project.mediaLibrary[0] = { ...project.mediaLibrary[0], localPath: null };
    project.mediaLibrary[1] = {
      ...project.mediaLibrary[1],
      contentIdentity: {
        ...project.mediaLibrary[1].contentIdentity!,
        algorithm: "legacy-sample-v1"
      }
    };

    const result = buildAlignmentShadowRiskLocalPlan(project);

    expect(result.plan).toBeNull();
    expect(result.eligibleRecordCount).toBe(0);
    expect(result.skippedRecordCount).toBe(1);
    expect(result.skippedByReason["missing-local-media"]).toBe(1);
  });

  it("TimeMap 选轨或媒体身份变化会改变关联证据与计划摘要", () => {
    const project = createEligibleProject();
    const first = buildAlignmentShadowRiskLocalPlan(project, "2026-07-22T18:00:00.000Z").plan!;
    const firstAssociation = createAlignmentShadowRiskAssociationManifest(project);

    project.mediaTimeMaps[0] = {
      ...project.mediaTimeMaps[0],
      sourceStream: { ...project.mediaTimeMaps[0].sourceStream!, index: 2 }
    };
    const second = buildAlignmentShadowRiskLocalPlan(project, "2026-07-22T18:00:00.000Z").plan!;
    const secondAssociation = createAlignmentShadowRiskAssociationManifest(project);

    expect(second.planId).not.toBe(first.planId);
    expect(second.records[0].recordEvidenceDigest).not.toBe(
      first.records[0].recordEvidenceDigest
    );
    expect(secondAssociation.manifestId).not.toBe(firstAssociation.manifestId);
  });

  it("同一媒体被不同记录选择不同音轨时保留独立媒体音轨身份", () => {
    const project = createEligibleProject();
    const secondRecord = {
      ...createReviewRecord(),
      id: "review:second-stream",
      timeMapId: "map-2",
      spanId: "span-2"
    };
    const secondMap = createTimeMap(secondRecord);
    secondMap.sourceStream = { ...secondMap.sourceStream!, index: 2 };
    secondMap.targetStream = { ...secondMap.targetStream!, index: 2 };
    project.alignmentReviewRecords.push(secondRecord);
    project.mediaTimeMaps.push(secondMap);

    const plan = buildAlignmentShadowRiskLocalPlan(
      project,
      "2026-07-22T18:00:00.000Z"
    ).plan!;

    expect(plan.records).toHaveLength(2);
    expect(plan.media).toHaveLength(4);
    expect(new Set(plan.media.map((media) => media.mediaKey)).size).toBe(4);
    expect(plan.records[0].sourceMediaKey).not.toBe(plan.records[1].sourceMediaKey);
    expect(plan.records[0].targetMediaKey).not.toBe(plan.records[1].targetMediaKey);
  });
});

function createEligibleProject(): EditorProject {
  const project = createEmptyProject("local-shadow-plan");
  project.id = "local-shadow-plan-project-v1";
  const record = createReviewRecord();
  project.alignmentReviewRecords = [record];
  project.mediaLibrary = [
    createMedia("source-1", "bilibiliReference", "C:\\authorized\\source.wav", "a"),
    createMedia("target-1", "targetOriginal", "C:\\authorized\\target.wav", "b")
  ];
  project.mediaTimeMaps = [createTimeMap(record)];
  return project;
}

function createMedia(
  id: string,
  role: ProjectMediaReference["role"],
  localPath: string,
  digest: string
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: `${id}.wav`,
    objectUrl: null,
    durationMs: 20_000,
    contentIdentity: createIdentity(digest),
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地测试媒体",
    localPath,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z"
  };
}

function createReviewRecord(): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id: "review:eligible",
    timeMapId: "map-1",
    timeMapRevision: 1,
    spanId: "span-1",
    spanIndex: 0,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    mediaGroupId: "group-1",
    action: "classifySpan",
    decision: "unresolved",
    precision: "rough",
    algorithmPrediction: "ambiguous",
    sourceStartMs: 1_000,
    sourceEndMs: 9_000,
    targetStartMs: 2_000,
    targetEndMs: 10_000,
    boundaryToleranceMs: 500,
    features: {
      sourceCoverage: 0.8,
      uniqueContentCoverage: 0.7,
      anchorCount: 8,
      heldOutAnchorCount: 3,
      anchorRegionCount: 2,
      p95ResidualMs: 120,
      p99ResidualMs: 180,
      maxResidualMs: 220,
      boundaryUncertaintyMs: 800,
      alternativeMargin: 0.15,
      ambiguousRatio: 0.6,
      bidirectionalAgreement: null,
      differenceRiskP50: 0.5,
      differenceRiskP90: 0.75,
      differenceRiskP99: 0.9,
      informativenessP50: 0.5,
      visualRecoveredRatio: 0.2,
      visualAmbiguousRatio: 0.7,
      visualMarginP50: 0.1
    },
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    supersedesRecordId: null,
    recordState: "active",
    reviewedAt: "2026-07-22T00:00:00.000Z"
  };
}

function createTimeMap(record: AlignmentReviewRecord): MediaTimeMap {
  const stream = (index: number) => ({
    type: "audio" as const,
    index,
    codec: "pcm_s16le",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 1,
    frameRate: null,
    language: null,
    title: null
  });
  return {
    id: record.timeMapId,
    revision: record.timeMapRevision,
    sourceMediaId: record.sourceMediaId,
    targetMediaId: record.targetMediaId,
    sourceStream: stream(1),
    targetStream: stream(1),
    sourceIdentity: createIdentity("a"),
    targetIdentity: createIdentity("b"),
    sourceStartMs: 0,
    sourceEndMs: 20_000,
    targetStartMs: 0,
    targetEndMs: 20_000,
    spans: [{
      id: record.spanId,
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 20_000,
      targetStartMs: 0,
      targetEndMs: 20_000
    }],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 50,
      p95ResidualMs: 100,
      maxResidualMs: 150,
      boundaryUncertaintyMs: 200,
      alternativeMargin: 0.2,
      anchorCount: 8,
      heldOutAnchorCount: 3,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 8,
      visualAnchorCount: 0,
      heldOutAnchorCount: 3,
      notes: []
    },
    verification: null,
    engineVersion: record.engineVersion,
    featureVersion: record.featureVersion,
    parametersHash: record.parametersHash,
    state: "confirmed",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    confirmedAt: "2026-07-22T00:00:00.000Z"
  };
}

function createIdentity(digest: string): MediaContentIdentity {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digest.repeat(64),
    middleSampleDigest: digest.repeat(64),
    lastSampleDigest: digest.repeat(64)
  };
}
