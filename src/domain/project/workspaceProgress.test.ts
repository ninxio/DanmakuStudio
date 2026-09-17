import { describe, expect, it } from "vitest";
import { applyTestManualMediaTimeMapVerification as applyManualMediaTimeMapVerification } from "../../test/manualVerification";
import { createDanmakuSourceSegment } from "./sourceTimeline";
import { createEmptyProject } from "./factory";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import type { EditorProject, MediaTimeMap, ProjectMediaReference } from "./types";
import { createWorkspaceProgress } from "./workspaceProgress";

function createItem(assetId: string, index: number, sourceTimeMs: number): DanmakuItem {
  return {
    id: `${assetId}_item_${index}`,
    assetId,
    originalIndex: index,
    sourceTimeMs,
    mode: 1,
    fontSize: 25,
    color: 16777215,
    timestamp: 0,
    pool: 0,
    userHash: "hash",
    rowId: `${index}`,
    text: `弹幕 ${index}`,
    rawPFields: [String(sourceTimeMs / 1000), "1", "25", "16777215", "0", "0", "hash", String(index)],
    enabled: true
  };
}

function createAsset(id: string): DanmakuAsset {
  return {
    id,
    name: id,
    fileName: `${id}.xml`,
    color: "#ffffff",
    items: [createItem(id, 0, 10_000), createItem(id, 1, 600_000)],
    warnings: [],
    importedAt: "2026-07-11T00:00:00.000Z",
    sourceReceipt: null
  };
}

function createMedia(
  id: string,
  role: ProjectMediaReference["role"],
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: `${id}.mp4`,
    objectUrl: null,
    durationMs: 3_600_000,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件",
    localPath: `C:/media/${id}.mp4`,
    emby: null,
    episodeKey: null,
    episodeLabel: role === "targetOriginal" ? id : null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" },
    contentIdentity:
      overrides.contentIdentity ?? testContentIdentity(role === "bilibiliReference" ? "1" : "2")
  };
}

describe("createWorkspaceProgress", () => {
  it("空项目推荐从素材页开始", () => {
    const progress = createWorkspaceProgress(createEmptyProject());
    expect(progress.recommendedPage).toBe("materials");
    expect(progress.completeStepCount).toBe(0);
    expect(progress.steps.find((step) => step.id === "materials")?.state).toBe("active");
    expect(progress.steps.find((step) => step.id === "export")?.state).toBe("idle");
  });

  it("素材齐备且来源段完成后推荐导出", () => {
    const project = createEmptyProject("暗黑 S01");
    const asset = createAsset("xml_long");
    project.assets = [asset];
    project.mediaLibrary = [
      createMedia("ref_long", "bilibiliReference"),
      createMedia("ep1", "targetOriginal", { episodeLabel: "第 1 集" }),
      createMedia("ep2", "targetOriginal", { episodeLabel: "第 2 集" })
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding-1",
        assetId: asset.id,
        sourceMediaId: "ref_long",
        linkedAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    ];
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_ep1", {
        kind: "content",
        assetId: asset.id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 1_200_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集"
      }),
      createDanmakuSourceSegment("seg_ep2", {
        kind: "content",
        assetId: asset.id,
        sourceMediaId: "ref_long",
        sourceStartMs: 1_200_000,
        sourceEndMs: 2_400_000,
        targetMediaId: "ep2",
        episodeKey: null,
        episodeLabel: "第 2 集"
      })
    ];
    project.assets[0].items.push(createItem(project.assets[0].id, 2, 1_310_000));
    attachVerifiedTimeMap(project, "seg_ep1", "map-ep1");
    attachVerifiedTimeMap(project, "seg_ep2", "map-ep2");

    const progress = createWorkspaceProgress(project);
    expect(progress.steps.find((step) => step.id === "materials")?.state).toBe("complete");
    expect(progress.steps.find((step) => step.id === "matching")?.state).toBe("complete");
    expect(progress.exportableEpisodeCount).toBe(2);
    expect(progress.steps.find((step) => step.id === "export")?.state).toBe("active");
    expect(progress.recommendedPage).toBe("export");
  });

  it("仅导入 XML 时跳过智能匹配并在建立时间线后允许单文件导出", () => {
    const project = createEmptyProject("单纯弹幕编辑");
    const asset = createAsset("xml-only");
    project.assets = [asset];

    const beforeTimeline = createWorkspaceProgress(project);
    expect(beforeTimeline.workflowMode).toBe("xml-only");
    expect(beforeTimeline.recommendedPage).toBe("editing");
    expect(beforeTimeline.steps.find((step) => step.id === "matching")).toMatchObject({
      state: "complete",
      stateText: "已确认"
    });

    project.clips = [
      {
        id: "clip-1",
        assetId: asset.id,
        name: "xml-only",
        timelineStartMs: 0,
        sourceInMs: 10_000,
        sourceOutMs: 600_001,
        localOffsetMs: 0,
        enabled: true
      }
    ];
    const ready = createWorkspaceProgress(project);
    expect(ready.timelineExportReady).toBe(true);
    expect(ready.recommendedPage).toBe("export");
    expect(ready.steps.find((step) => step.id === "export")).toMatchObject({
      state: "active",
      stateText: "可运行"
    });
  });

  it("未绑定 XML 会阻断素材页完成", () => {
    const project = createEmptyProject();
    project.assets = [createAsset("xml_1")];
    project.mediaLibrary = [
      createMedia("ref", "bilibiliReference"),
      createMedia("ep1", "targetOriginal")
    ];
    const progress = createWorkspaceProgress(project);
    expect(progress.steps.find((step) => step.id === "materials")?.state).toBe("active");
    expect(progress.steps.find((step) => step.id === "materials")?.blockers).toContain(
      "还有 1 个 XML 未关联参考视频。"
    );
  });

  it("只完成部分原片时继续推荐智能分析，并把保存关系留给编辑步骤", () => {
    const project = createEmptyProject();
    const asset = createAsset("xml_long");
    project.assets = [asset];
    project.mediaLibrary = [
      createMedia("ref", "bilibiliReference"),
      createMedia("ep1", "targetOriginal"),
      createMedia("ep2", "targetOriginal")
    ];
    project.danmakuSourceBindings = [
      {
        id: "binding",
        assetId: asset.id,
        sourceMediaId: "ref",
        linkedAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z"
      }
    ];
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg-1", {
        kind: "content",
        assetId: asset.id,
        sourceMediaId: "ref",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集"
      })
    ];
    attachVerifiedTimeMap(project, "seg-1", "map-partial");

    const progress = createWorkspaceProgress(project);
    const matching = progress.steps.find((step) => step.id === "matching");

    expect(progress.confirmedTargetCount).toBe(1);
    expect(matching?.state).toBe("active");
    expect(matching?.stateText).toBe("需处理");
    expect(matching?.blockers).toContain("还有 1 个原片没有完成智能分析。");
    expect(progress.steps.find((step) => step.id === "editing")?.blockers).toContain(
      "还有 1 个原片没有保存时间关系。"
    );
  });
});

function attachVerifiedTimeMap(project: EditorProject, segmentId: string, mapId: string): void {
  const segment = project.danmakuSourceSegments.find((item) => item.id === segmentId);
  if (!segment?.sourceMediaId || !segment.targetMediaId) {
    throw new Error("测试来源段缺少媒体引用。");
  }
  segment.timeMapId = mapId;
  const targetStartMs = segment.targetStartMs ?? 0;
  const targetEndMs = targetStartMs + segment.sourceEndMs - segment.sourceStartMs;
  const map: MediaTimeMap = {
    id: mapId,
    revision: 1,
    sourceMediaId: segment.sourceMediaId,
    targetMediaId: segment.targetMediaId,
    sourceStream: testAudioStream(1),
    targetStream: testAudioStream(2),
    sourceIdentity: { ...project.mediaLibrary.find((media) => media.id === segment.sourceMediaId)!.contentIdentity! },
    targetIdentity: { ...project.mediaLibrary.find((media) => media.id === segment.targetMediaId)!.contentIdentity! },
    sourceStartMs: segment.sourceStartMs,
    sourceEndMs: segment.sourceEndMs,
    targetStartMs,
    targetEndMs,
    spans: [
      {
        kind: "matched",
        sourceStartMs: segment.sourceStartMs,
        sourceEndMs: segment.sourceEndMs,
        targetStartMs,
        targetEndMs
      }
    ],
    quality: {
      level: "verified",
      probability: 0.999,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 0,
      p95ResidualMs: 0,
      maxResidualMs: 0,
      boundaryUncertaintyMs: 0,
      alternativeMargin: 1,
      anchorCount: 10,
      heldOutAnchorCount: 2,
      reasons: ["测试已验证时间图。"]
    },
    evidence: {
      types: ["audio", "visual", "manual"],
      audioAnchorCount: 10,
      visualAnchorCount: 5,
      heldOutAnchorCount: 2,
      notes: ["测试证据。"]
    },
    verification: null,
    engineVersion: "test-v2",
    featureVersion: "test-v2",
    parametersHash: mapId,
    state: "confirmed",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    confirmedAt: project.updatedAt
  };
  project.mediaTimeMaps.push(
    applyManualMediaTimeMapVerification(map, {
      calibrationArtifactId: "test-manual-review-protocol",
      calibrationArtifactVersion: "1",
      verifier: "vitest",
      verifiedAt: project.updatedAt
    })
  );
}

function testContentIdentity(digit: string) {
  return {
    algorithm: "fnv1a64-first-middle-last-64k-v1",
    sizeBytes: Number(digit) * 1_000_000,
    modifiedUnixMs: Number(digit) * 1_000,
    firstSampleDigest: digit.repeat(16),
    middleSampleDigest: ((Number(digit) + 2) % 10).toString().repeat(16),
    lastSampleDigest: ((Number(digit) + 4) % 10).toString().repeat(16)
  };
}

function testAudioStream(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "pcm_s16le",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/16000",
    sampleRate: 16_000,
    channels: 1,
    frameRate: null,
    language: "und",
    title: null
  };
}
