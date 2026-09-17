import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import { validateProjectSchema } from "../project/schema";
import type {
  AlignmentReviewRecord,
  AlignmentShadowRiskOverlay,
  AlignmentShadowRiskReasonCode,
  MediaTimeMap
} from "../project/types";
import {
  createAlignmentReviewRecordEvidenceDigest,
  createAlignmentShadowRiskAssociationManifest,
  createAlignmentShadowRiskOverlay,
  isAlignmentShadowRiskOverlayBoundToProject,
  parseAlignmentShadowRiskOverlayForProject,
  resolveAlignmentShadowRiskOverlay,
  serializeAlignmentShadowRiskAssociationManifest
} from "./alignmentShadowRiskOverlay";

describe("项目绑定的离线影子风险覆盖层", () => {
  it("导出无路径关联清单并只对摘要完全一致的有效记录应用风险", () => {
    const project = createEmptyProject("overlay");
    const record = createRecord("review:a");
    project.alignmentReviewRecords = [record];
    const manifest = createAlignmentShadowRiskAssociationManifest(project);
    const overlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"1".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [
        {
          recordId: record.id,
          risk: 0.82,
          reasonCodes: ["missing-local-audio-support", "audio-shadow-risk"]
        }
      ]
    });
    project.alignmentShadowRiskOverlay = overlay;

    expect(manifest.records).toEqual([
      {
        recordId: record.id,
        recordEvidenceDigest: createAlignmentReviewRecordEvidenceDigest(record)
      }
    ]);
    expect(serializeAlignmentShadowRiskAssociationManifest(project)).not.toContain("path");
    expect(resolveAlignmentShadowRiskOverlay(project)).toMatchObject({
      appliedCount: 1,
      staleCount: 0
    });
    expect(resolveAlignmentShadowRiskOverlay(project)?.risks.get(record.id)).toBe(0.82);

    project.alignmentReviewRecords = [{ ...record, targetEndMs: record.targetEndMs + 1 }];
    expect(resolveAlignmentShadowRiskOverlay(project)).toMatchObject({
      appliedCount: 0,
      staleCount: 1
    });
  });

  it("拒绝跨项目、内容篡改、未知记录和伪造权限", () => {
    const project = createEmptyProject("overlay-source");
    const record = createRecord("review:a");
    project.alignmentReviewRecords = [record];
    const overlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"2".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [{ recordId: record.id, risk: 0.4, reasonCodes: ["audio-shadow-risk"] }]
    });

    const other = createEmptyProject("overlay-target");
    other.alignmentReviewRecords = [record];
    expect(isAlignmentShadowRiskOverlayBoundToProject(overlay, project.id)).toBe(true);
    expect(isAlignmentShadowRiskOverlayBoundToProject(overlay, other.id)).toBe(false);
    expect(validateProjectSchema({ ...project, id: other.id, alignmentShadowRiskOverlay: overlay })).toMatchObject({
      ok: false,
      message: "项目文件中的离线风险数据不属于当前项目。"
    });
    expect(() => parseAlignmentShadowRiskOverlayForProject(overlay, other)).toThrow(
      "另一个项目"
    );
    expect(() =>
      parseAlignmentShadowRiskOverlayForProject({ ...overlay, sourceRunId: `sha256:${"3".repeat(64)}` }, project)
    ).toThrow("摘要不匹配");
    expect(() =>
      parseAlignmentShadowRiskOverlayForProject(
        { ...overlay, permission: "automatic-time-map" },
        project
      )
    ).toThrow("权限");
    expect(() =>
      createAlignmentShadowRiskOverlay(project, {
        sourceRunId: `sha256:${"2".repeat(64)}`,
        generatedAt: "2026-07-22T16:00:00.000Z",
        entries: [{ recordId: "missing", risk: 0.4, reasonCodes: ["audio-shadow-risk"] }]
      })
    ).toThrow("有效的复核记录");
  });

  it("媒体内容、音轨或 TimeMap 证据变化后旧风险立即失效", () => {
    const project = createEmptyProject("overlay-media-bound");
    const record = createRecord("review:media-bound");
    project.alignmentReviewRecords = [record];
    project.mediaTimeMaps = [createTimeMap(record)];
    project.alignmentShadowRiskOverlay = createAlignmentShadowRiskOverlay(project, {
      sourceRunId: `sha256:${"4".repeat(64)}`,
      generatedAt: "2026-07-22T16:00:00.000Z",
      entries: [{ recordId: record.id, risk: 0.7, reasonCodes: ["audio-shadow-risk"] }]
    });

    expect(resolveAlignmentShadowRiskOverlay(project)?.appliedCount).toBe(1);

    project.mediaTimeMaps = [{
      ...project.mediaTimeMaps[0],
      sourceStream: { ...project.mediaTimeMaps[0].sourceStream!, index: 2 }
    }];
    expect(resolveAlignmentShadowRiskOverlay(project)).toMatchObject({ appliedCount: 0, staleCount: 1 });

    project.mediaTimeMaps = [createTimeMap(record)];
    project.mediaTimeMaps[0] = {
      ...project.mediaTimeMaps[0],
      targetIdentity: {
        ...project.mediaTimeMaps[0].targetIdentity!,
        firstSampleDigest: "c".repeat(64),
        middleSampleDigest: "c".repeat(64),
        lastSampleDigest: "c".repeat(64)
      }
    };
    expect(resolveAlignmentShadowRiskOverlay(project)).toMatchObject({ appliedCount: 0, staleCount: 1 });
  });

  it("与 Python 生成器共享完全一致的关联和覆盖层固定向量", () => {
    const vector = JSON.parse(
      readFileSync(
        resolve("ml/contracts/alignment-shadow-risk-cross-language-vector-v1.json"),
        "utf8"
      )
    ) as {
      projectId: string;
      record: AlignmentReviewRecord;
      score: {
        recordId: string;
        risk: number;
        reasonCodes: AlignmentShadowRiskReasonCode[];
      };
      sourceRunId: string;
      generatedAt: string;
      association: ReturnType<typeof createAlignmentShadowRiskAssociationManifest>;
      overlay: AlignmentShadowRiskOverlay;
    };
    const project = createEmptyProject("cross-language-vector");
    project.id = vector.projectId;
    project.alignmentReviewRecords = [vector.record];

    expect(createAlignmentShadowRiskAssociationManifest(project)).toEqual(vector.association);
    expect(
      createAlignmentShadowRiskOverlay(project, {
        sourceRunId: vector.sourceRunId,
        generatedAt: vector.generatedAt,
        entries: [vector.score]
      })
    ).toEqual(vector.overlay);
    expect(parseAlignmentShadowRiskOverlayForProject(vector.overlay, project)).toEqual(
      vector.overlay
    );
  });
});

function createRecord(id: string): AlignmentReviewRecord {
  return {
    recordVersion: 1,
    id,
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
    sourceEndMs: 11_000,
    targetStartMs: 2_000,
    targetEndMs: 12_000,
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
    codec: "aac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 2,
    frameRate: null,
    language: "deu",
    title: null
  });
  const identity = (digest: string) => ({
    algorithm: "sha256-full-file-v2",
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digest.repeat(64),
    middleSampleDigest: digest.repeat(64),
    lastSampleDigest: digest.repeat(64)
  });
  return {
    id: record.timeMapId,
    revision: record.timeMapRevision,
    sourceMediaId: record.sourceMediaId,
    targetMediaId: record.targetMediaId,
    sourceStream: stream(1),
    targetStream: stream(1),
    sourceIdentity: identity("a"),
    targetIdentity: identity("b"),
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
