import { describe, expect, it } from "vitest";
import { migrateLegacyTimeMap, type TimeMapSpan } from "../alignment/timeMap";
import { applyTestManualMediaTimeMapVerification as applyManualMediaTimeMapVerification } from "../../test/manualVerification";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "../project/factory";
import { createDanmakuSourceBinding } from "../project/mediaLibrary";
import { createDanmakuSourceSegment } from "../project/sourceTimeline";
import type {
  EditorProject,
  MediaTimeMap,
  MediaTimeMapQualityLevel,
  ProjectMediaReference
} from "../project/types";
import { projectDanmakuToTargets, requiresProjectionOnlyExport } from "./sourceProjection";

function createItem(
  assetId: string,
  index: number,
  sourceTimeMs: number,
  text = `弹幕 ${index}`
): DanmakuItem {
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
    text,
    rawPFields: [
      String(sourceTimeMs / 1000),
      "1",
      "25",
      "16777215",
      "0",
      "0",
      "hash",
      String(index)
    ],
    enabled: true
  };
}

function createAsset(id: string, times: number[]): DanmakuAsset {
  return {
    id,
    name: id,
    fileName: `${id}.xml`,
    color: "#ffffff",
    items: times.map((timeMs, index) => createItem(id, index, timeMs)),
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
    episodeLabel: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" },
    contentIdentity: overrides.contentIdentity ?? createTestMediaIdentity()
  };
}

function createSingleSegmentProject(times: number[], sourceEndMs = 40_000): EditorProject {
  const project = createEmptyProject("可验证时间图投影测试");
  const asset = createAsset("asset_verified", times);
  project.assets = [asset];
  project.mediaLibrary = [
    createMedia("ref_verified", "bilibiliReference"),
    createMedia("target_verified", "targetOriginal")
  ];
  project.danmakuSourceBindings = [
    createDanmakuSourceBinding("binding_verified", asset.id, "ref_verified")
  ];
  project.danmakuSourceSegments = [
    createDanmakuSourceSegment("segment_verified", {
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "ref_verified",
      sourceStartMs: 0,
      sourceEndMs,
      targetMediaId: "target_verified",
      targetStartMs: 0,
      episodeKey: null,
      episodeLabel: null
    })
  ];
  return project;
}

function attachTimeMap(
  project: EditorProject,
  segmentId: string,
  spans: TimeMapSpan[],
  qualityLevel: MediaTimeMapQualityLevel = "verified"
): MediaTimeMap {
  const segment = project.danmakuSourceSegments.find((candidate) => candidate.id === segmentId);
  if (!segment?.sourceMediaId || !segment.targetMediaId || spans.length === 0) {
    throw new Error("测试时间图缺少有效来源段或 spans。");
  }
  const lastSpan = spans[spans.length - 1];
  const timestamp = "2026-07-12T00:00:00.000Z";
  const timeMap: MediaTimeMap = {
    id: `time_map_${segment.id}`,
    revision: 1,
    sourceMediaId: segment.sourceMediaId,
    targetMediaId: segment.targetMediaId,
    sourceStream: createAudioStreamIdentity(0),
    targetStream: createAudioStreamIdentity(0),
    sourceIdentity: createTestMediaIdentity(),
    targetIdentity: createTestMediaIdentity(),
    sourceStartMs: segment.sourceStartMs,
    sourceEndMs: segment.sourceEndMs,
    targetStartMs: segment.targetStartMs ?? 0,
    targetEndMs: lastSpan.targetEndMs,
    spans: spans.map((span, spanIndex) =>
      createTestCompleteTimeMapSpan(
        span,
        `time_map_${segment.id}:span:${String(spanIndex + 1).padStart(4, "0")}`
      )
    ),
    quality: {
      level: qualityLevel,
      probability: qualityLevel === "verified" ? 0.999 : null,
      metricSource: "measured",
      coverage: 0.98,
      uniqueContentCoverage: 0.9,
      p50ResidualMs: 20,
      p95ResidualMs: 50,
      p99ResidualMs: 70,
      maxResidualMs: 90,
      boundaryUncertaintyMs: 100,
      alternativeMargin: 0.5,
      anchorCount: 30,
      anchorRegionCount: 3,
      heldOutAnchorCount: 5,
      reasons: []
    },
    evidence: {
      types: qualityLevel === "verified" ? ["audio", "visual", "manual"] : ["audio", "visual"],
      audioAnchorCount: 20,
      visualAnchorCount: 20,
      heldOutAnchorCount: 5,
      top1Top2Margin: 0.5,
      uniqueContentCoverage: 0.9,
      repeatedContentOnly: false,
      selectedTrackReason: "测试轨道。",
      alternativeTrackScores: [],
      notes: []
    },
    verification: null,
    engineVersion: "test-engine",
    featureVersion: "test-feature",
    parametersHash: "test-parameters",
    state: "confirmed",
    createdAt: timestamp,
    updatedAt: timestamp,
    confirmedAt: timestamp
  };
  const signedTimeMap =
    qualityLevel === "verified"
      ? applyManualMediaTimeMapVerification(timeMap, {
          calibrationArtifactId: "test-manual-review-protocol",
          calibrationArtifactVersion: "1",
          verifier: "vitest",
          verifiedAt: timestamp
        })
      : timeMap;
  segment.timeMapId = signedTimeMap.id;
  project.mediaTimeMaps.push(signedTimeMap);
  return signedTimeMap;
}

function createAudioStreamIdentity(index: number): MediaTimeMap["sourceStream"] {
  return {
    type: "audio",
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

function createTestMediaIdentity() {
  return {
    algorithm: "fnv1a64-first-middle-last-64k-v1",
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: "a".repeat(16),
    middleSampleDigest: "b".repeat(16),
    lastSampleDigest: "c".repeat(16)
  };
}

function attachVerifiedMapsToContentSegments(project: EditorProject): void {
  for (const segment of project.danmakuSourceSegments) {
    if (segment.kind !== "content") {
      continue;
    }
    const migration = migrateLegacyTimeMap({
      sourceStartMs: segment.sourceStartMs,
      sourceEndMs: segment.sourceEndMs,
      targetStartMs: segment.targetStartMs ?? 0,
      timingRules: segment.timingRules
    });
    if (migration.status !== "migrated") {
      throw new Error("测试来源段无法生成显式时间图。");
    }
    attachTimeMap(project, segment.id, [...migration.spans]);
  }
}

function createProjectWithLongReference(withTimeMaps = true): EditorProject {
  const project = createEmptyProject("投影测试");
  const asset = createAsset("asset_long", [
    10_000, // 集1 开头
    600_000, // 集1 中部
    1_310_000, // 集2 开头附近
    1_500_000, // 集2 内、位于删减点之后
    2_650_000, // 集3 内
    2_900_000 // 未覆盖区域（无来源段）
  ]);
  project.assets = [asset];
  project.mediaLibrary = [
    createMedia("ref_long", "bilibiliReference"),
    createMedia("ep1", "targetOriginal", { episodeLabel: "第 1 集" }),
    createMedia("ep2", "targetOriginal", { episodeLabel: "第 2 集" }),
    createMedia("ep3", "targetOriginal", { episodeLabel: "第 3 集" })
  ];
  project.danmakuSourceBindings = [
    createDanmakuSourceBinding("binding_asset_long", asset.id, "ref_long")
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
    createDanmakuSourceSegment("seg_gap", {
      kind: "ignored",
      assetId: asset.id,
      sourceMediaId: "ref_long",
      sourceStartMs: 1_200_000,
      sourceEndMs: 1_290_000,
      targetMediaId: null,
      episodeKey: null,
      episodeLabel: null
    }),
    createDanmakuSourceSegment("seg_ep2", {
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "ref_long",
      sourceStartMs: 1_290_000,
      sourceEndMs: 2_400_000,
      targetMediaId: "ep2",
      episodeKey: null,
      episodeLabel: "第 2 集",
      timingRules: [{ sourceAtMs: 1_400_000, gapMs: 45_000, note: "审核删减补偿" }]
    }),
    createDanmakuSourceSegment("seg_ep3", {
      kind: "content",
      assetId: asset.id,
      sourceMediaId: "ref_long",
      sourceStartMs: 2_400_000,
      sourceEndMs: 2_800_000,
      targetMediaId: "ep3",
      episodeKey: null,
      episodeLabel: "第 3 集",
      targetStartMs: 90_000
    })
  ];
  if (withTimeMaps) {
    attachVerifiedMapsToContentSegments(project);
  }
  return project;
}
it("audio and video targets use the shared media extension contract without altering projection", () => {
  const project = createProjectWithLongReference();
  const baseline = projectDanmakuToTargets(project);
  for (const ext of ["flac", "FLAC", "wav", "mka", "mkv"]) {
    const renamed = structuredClone(project);
    const target = renamed.mediaLibrary.find((m) => m.id === "ep1")!;
    target.fileName = `Title.S01E01.${ext}`;
    const result = projectDanmakuToTargets(renamed);
    expect(result.groups.find((g) => g.targetMediaId === "ep1")?.exportFileName).toBe(
      "Title.S01E01.xml"
    );
    expect(result.groups.map((g) => g.entries)).toEqual(baseline.groups.map((g) => g.entries));
    expect(renamed.mediaTimeMaps).toEqual(project.mediaTimeMaps);
  }
});

describe("projectDanmakuToTargets", () => {
  it("目标原片、内容段或时间图任一出现后都要求只走投影导出", () => {
    const legacyProject = createEmptyProject("传统项目");
    expect(requiresProjectionOnlyExport(legacyProject)).toBe(false);

    expect(
      requiresProjectionOnlyExport({
        ...legacyProject,
        mediaLibrary: [createMedia("target-only", "targetOriginal")]
      })
    ).toBe(true);
    expect(
      requiresProjectionOnlyExport({
        ...legacyProject,
        danmakuSourceSegments: [
          createDanmakuSourceSegment("content-only", {
            kind: "content",
            assetId: "asset",
            sourceMediaId: "source",
            sourceStartMs: 0,
            sourceEndMs: 1000,
            targetMediaId: "target",
            targetStartMs: 0,
            episodeKey: null,
            episodeLabel: null
          })
        ]
      })
    ).toBe(true);
    const mappedProject = createSingleSegmentProject([100], 1000);
    attachTimeMap(mappedProject, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 1000,
        targetStartMs: 0,
        targetEndMs: 1000
      }
    ]);
    mappedProject.danmakuSourceSegments = [];
    mappedProject.mediaLibrary = [];
    expect(requiresProjectionOnlyExport(mappedProject)).toBe(true);
  });
  it("content 段没有 timeMapId 时阻断且不进入 usableSegments", () => {
    const project = createProjectWithLongReference(false);
    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.issues.filter((issue) => issue.id.includes("missing-time-map"))).toHaveLength(
      3
    );
    expect(
      result.issues.every(
        (issue) => issue.severity === "error" || issue.id === "unmapped-items"
      )
    ).toBe(true);
    expect(result.groups).toHaveLength(0);
    expect(result.contentSegmentCount).toBe(3);
    expect(result.ignoredSegmentCount).toBe(1);
    expect(result.projectedItemCount).toBe(0);
    expect(result.unmappedItemCount).toBe(6);
  });

  it("忽略段内的弹幕不投影", () => {
    const project = createProjectWithLongReference();
    project.assets[0].items.push(createItem(project.assets[0].id, 100, 1_250_000, "忽略段内"));
    const result = projectDanmakuToTargets(project);
    const allEntryIds = result.groups.flatMap((group) =>
      group.entries.map((entry) => entry.item.id)
    );
    expect(allEntryIds).not.toContain(`${project.assets[0].id}_item_100`);
    expect(result.ignoredItemCount).toBe(1);
  });

  it("没有任何来源段的其他 XML 弹幕也计入未映射", () => {
    const project = createProjectWithLongReference();
    project.assets.push(createAsset("asset_without_segments", [5_000, 15_000]));

    const result = projectDanmakuToTargets(project);
    const unmappedIssue = result.issues.find((issue) => issue.id === "unmapped-items");

    expect(result.unmappedItemCount).toBe(3);
    expect(unmappedIssue?.severity).toBe("warning");
    expect(unmappedIssue?.message).toContain("3 条弹幕");
  });

  it("禁用弹幕不投影但计入统计", () => {
    const project = createProjectWithLongReference();
    project.disabledItemIds = [`${project.assets[0].id}_item_0`];
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([600_000]);
    expect(ep1?.disabledCount).toBe(1);
  });

  it("单条弹幕时间调整参与投影", () => {
    const project = createProjectWithLongReference();
    project.itemTimeAdjustments = { [`${project.assets[0].id}_item_0`]: -2_000 };
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([8_000, 600_000]);
  });

  it("缺少目标原片的正片段会阻断并给出可读错误", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_no_target", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 1_200_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    ];
    const result = projectDanmakuToTargets(project);
    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.issues[0].severity).toBe("error");
    expect(result.issues[0].message).toContain("目标原片");
  });

  it("XML 绑定的参考素材与来源段不一致时阻断投影", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary.push(createMedia("ref_bound", "bilibiliReference"));
    project.danmakuSourceBindings = [
      createDanmakuSourceBinding("binding_asset_long", project.assets[0].id, "ref_bound")
    ];
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1"
    );

    const result = projectDanmakuToTargets(project);
    const mismatchIssue = result.issues.find((issue) => issue.segmentId === "seg_ep1");

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(mismatchIssue?.severity).toBe("error");
    expect(mismatchIssue?.message).toContain("与所属 XML 在素材页的绑定不一致");
  });

  it("来源段所属 XML 完全没有参考素材绑定时阻断投影", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceBindings = [];
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1"
    );

    const result = projectDanmakuToTargets(project);
    const missingBindingIssue = result.issues.find((issue) => issue.segmentId === "seg_ep1");

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(missingBindingIssue?.severity).toBe("error");
    expect(missingBindingIssue?.message).toContain("尚未在素材页绑定 B 站参考素材");
  });

  it("忽略段使用与 XML 绑定不一致的参考素材时阻断且不静默吞掉弹幕", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary.push(createMedia("ref_other", "bilibiliReference"));
    project.danmakuSourceSegments.push(
      createDanmakuSourceSegment("ignored_wrong_source", {
        label: "错误参考忽略段",
        kind: "ignored",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_other",
        sourceStartMs: 2_800_000,
        sourceEndMs: 3_000_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    );

    const result = projectDanmakuToTargets(project);
    const issue = result.issues.find(
      (candidate) => candidate.segmentId === "ignored_wrong_source"
    );

    expect(result.status).toBe("blocked");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("绑定不一致");
    expect(result.unmappedItemCount).toBeGreaterThan(0);
  });

  it("忽略段所属 XML 没有参考绑定时阻断且不计为有效忽略覆盖", () => {
    const project = createProjectWithLongReference();
    const unboundAsset = createAsset("asset_unbound_ignored", [5_000]);
    project.assets.push(unboundAsset);
    project.danmakuSourceSegments.push(
      createDanmakuSourceSegment("ignored_without_binding", {
        label: "未绑定 XML 忽略段",
        kind: "ignored",
        assetId: unboundAsset.id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    );

    const result = projectDanmakuToTargets(project);
    const issue = result.issues.find(
      (candidate) => candidate.segmentId === "ignored_without_binding"
    );

    expect(result.status).toBe("blocked");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toContain("尚未在素材页绑定");
    expect(result.ignoredItemCount).toBe(0);
    expect(result.unmappedItemCount).toBeGreaterThanOrEqual(2);
  });

  it("没有任何正片段时返回 empty 状态", () => {
    const project = createEmptyProject("空项目");
    const result = projectDanmakuToTargets(project);
    expect(result.status).toBe("empty");
    expect(result.groups).toHaveLength(0);
  });

  it("多个来源段指向同一个原片时合并导出", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_a", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 100_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集"
      }),
      createDanmakuSourceSegment("seg_b", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: "第 1 集",
        targetStartMs: 480_000
      })
    ];
    attachVerifiedMapsToContentSegments(project);
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.segments).toHaveLength(2);
    // item_0 (10s) 来自 seg_a → 10_000；item_1 (600s) 来自 seg_b → 600_000-500_000+480_000=580_000
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([10_000, 580_000]);
  });

  it("同一 XML、参考素材和目标原片的手工来源段重叠时阻断导出", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_overlap_a", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: null
      }),
      createDanmakuSourceSegment("seg_overlap_b", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 900_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: null
      })
    ];

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.projectedItemCount).toBe(0);
    expect(result.issues.some((issue) => issue.message.includes("会产生重复弹幕"))).toBe(true);
  });

  it("正片来源段覆盖同一 XML 的忽略范围时阻断导出", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_content", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        episodeKey: null,
        episodeLabel: null
      }),
      createDanmakuSourceSegment("seg_ignored_overlap", {
        kind: "ignored",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 650_000,
        targetMediaId: null,
        episodeKey: null,
        episodeLabel: null
      })
    ];

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.issues.some((issue) => issue.message.includes("忽略范围"))).toBe(true);
  });

  it("同名目标原片的导出文件名会自动添加唯一序号", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "ep1" || media.id === "ep2"
        ? { ...media, fileName: "same-title.mkv" }
        : media
    );
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1" || segment.id === "seg_ep2"
    );

    const result = projectDanmakuToTargets(project);

    expect(result.groups.map((group) => group.exportFileName)).toEqual([
      "same-title-1.xml",
      "same-title-2.xml"
    ]);
    expect(
      result.groups.every((group) =>
        group.warnings.some((warning) => warning.includes("导出文件名已自动添加序号"))
      )
    ).toBe(true);
  });

  it("同名自动后缀不会与另一个原片的原始文件名再次碰撞", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) => {
      if (media.id === "ep1" || media.id === "ep2") {
        return { ...media, fileName: "foo.mkv" };
      }
      if (media.id === "ep3") {
        return { ...media, fileName: "foo-1.mkv" };
      }
      return media;
    });

    const result = projectDanmakuToTargets(project);
    const fileNames = result.groups.map((group) => group.exportFileName);

    expect(fileNames).toEqual(["foo-2.xml", "foo-3.xml", "foo-1.xml"]);
    expect(new Set(fileNames.map((name) => name.toLocaleLowerCase("en-US"))).size).toBe(3);
  });

  it("M4V 原片导出时会正确替换视频扩展名", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "ep1" ? { ...media, fileName: "episode.m4v" } : media
    );
    project.danmakuSourceSegments = project.danmakuSourceSegments.filter(
      (segment) => segment.id === "seg_ep1"
    );

    const result = projectDanmakuToTargets(project);

    expect(result.groups[0]?.exportFileName).toBe("episode.xml");
  });

  it("投影时间超出目标原片已知时长时阻断导出", () => {
    const project = createProjectWithLongReference();
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.id === "ep1" ? { ...media, durationMs: 100_000 } : media
    );

    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    const overflowIssue = result.issues.find((issue) => issue.id === "target-overflow-ep1");

    expect(ep1?.entries.some((entry) => entry.finalTimeMs > 100_000)).toBe(true);
    expect(
      ep1?.warnings.some((warning) => warning.includes("1 条弹幕投影后超出原片时长"))
    ).toBe(true);
    expect(overflowIssue?.severity).toBe("error");
    expect(result.status).toBe("blocked");
    expect(overflowIssue?.message).toContain("1 条弹幕投影后超出原片时长");
  });

  it("投影时间恰好等于半开目标时长边界时也阻断", () => {
    const project = createSingleSegmentProject([5_000], 10_000);
    project.mediaLibrary = project.mediaLibrary.map((media) =>
      media.role === "targetOriginal" ? { ...media, durationMs: 5_000 } : media
    );
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);

    const result = projectDanmakuToTargets(project);

    expect(result.groups[0]?.entries[0]?.finalTimeMs).toBe(5_000);
    expect(result.issues.some((issue) => issue.id.startsWith("target-overflow-"))).toBe(true);
    expect(result.status).toBe("blocked");
  });

  it("负时间投影会阻断导出而不是静默压到零", () => {
    const project = createProjectWithLongReference();
    project.itemTimeAdjustments = { [`${project.assets[0].id}_item_0`]: -60_000 };
    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    expect(ep1?.warnings.some((warning) => warning.includes("时间为负"))).toBe(true);
    expect(result.issues.find((issue) => issue.id === "target-negative-ep1")?.severity).toBe(
      "error"
    );
    expect(result.status).toBe("blocked");
  });

  it("大量未覆盖弹幕只计入警告，不因数量阻断合法来源段导出", () => {
    const project = createSingleSegmentProject(
      [
        1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 11_000, 12_000, 13_000, 14_000, 15_000, 16_000
      ],
      10_000
    );
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);

    const result = projectDanmakuToTargets(project);

    expect(result.unmappedItemCount).toBe(6);
    const unmappedIssue = result.issues.find((issue) => issue.id === "unmapped-items");
    expect(unmappedIssue?.severity).toBe("warning");
    expect(unmappedIssue?.message).toContain("此项不会阻断导出");
    expect(unmappedIssue?.message).not.toContain("安全阈值");
    expect(result.status).toBe("readyWithWarnings");
  });

  it("已验证时间图在媒体身份快照变化后立即失效", () => {
    const project = createSingleSegmentProject([1_000], 10_000);
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);
    project.mediaLibrary[0].contentIdentity = {
      ...createTestMediaIdentity(),
      firstSampleDigest: "d".repeat(16)
    };

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.message.includes("已被替换或修改"))).toBe(true);
    expect(result.projectedItemCount).toBe(0);
  });

  it("已验证时间图按整数分段仿射投影并在最后叠加单条调整", () => {
    const project = createSingleSegmentProject([1_000, 5_000], 10_000);
    project.danmakuSourceSegments[0].timingRules = [
      { id: "legacy_rule", sourceAtMs: 2_000, gapMs: 99_000, note: "不得参与正式投影" }
    ];
    project.itemTimeAdjustments = { asset_verified_item_0: 125 };
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 11_000
      }
    ]);

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("ready");
    expect(result.groups[0]?.entries.map((entry) => entry.finalTimeMs)).toEqual([1_225, 5_500]);
    expect(result.groups[0]?.appliedRules).toEqual([]);
    expect(result.unmappedItemCount).toBe(0);
  });

  it("targetOnly 让后续 matched 正确跳变，sourceOnly 内弹幕单独计为有意舍弃", () => {
    const project = createSingleSegmentProject([5_000, 10_000, 15_000, 25_000, 35_000]);
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      },
      {
        kind: "targetOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 10_000,
        targetStartMs: 10_000,
        targetEndMs: 20_000
      },
      {
        kind: "matched",
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        targetStartMs: 20_000,
        targetEndMs: 30_000
      },
      {
        kind: "sourceOnly",
        sourceStartMs: 20_000,
        sourceEndMs: 30_000,
        targetStartMs: 30_000,
        targetEndMs: 30_000
      },
      {
        kind: "matched",
        sourceStartMs: 30_000,
        sourceEndMs: 40_000,
        targetStartMs: 30_000,
        targetEndMs: 40_000
      }
    ]);

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("readyWithWarnings");
    expect(result.groups[0]?.entries.map((entry) => entry.finalTimeMs)).toEqual([
      5_000, 20_000, 25_000, 35_000
    ]);
    expect(result.unmappedItemCount).toBe(1);
    expect(result.sourceOnlyItemCount).toBe(1);
    expect(result.unexpectedUnmappedItemCount).toBe(0);
    expect(result.groups[0]?.entries.some((entry) => entry.item.sourceTimeMs === 25_000)).toBe(
      false
    );
  });

  it("大量 sourceOnly 弹幕不会被误判为来源段未覆盖并阻断导出", () => {
    const project = createSingleSegmentProject(
      [1_000, 11_000, 12_000, 13_000, 14_000, 15_000, 16_000, 25_000],
      30_000
    );
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      },
      {
        kind: "sourceOnly",
        sourceStartMs: 10_000,
        sourceEndMs: 20_000,
        targetStartMs: 10_000,
        targetEndMs: 10_000
      },
      {
        kind: "matched",
        sourceStartMs: 20_000,
        sourceEndMs: 30_000,
        targetStartMs: 10_000,
        targetEndMs: 20_000
      }
    ]);

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("readyWithWarnings");
    expect(result.projectedItemCount).toBe(2);
    expect(result.sourceOnlyItemCount).toBe(6);
    expect(result.unexpectedUnmappedItemCount).toBe(0);
    expect(result.issues.find((issue) => issue.id === "unmapped-items")).toBeUndefined();
  });

  it("同一参考弹幕在前一目标被舍弃、后一目标成功映射时只计入导出", () => {
    const project = createSingleSegmentProject([5_000], 10_000);
    project.mediaLibrary.push(createMedia("target_second", "targetOriginal"));
    project.danmakuSourceSegments.push(
      createDanmakuSourceSegment("segment_second", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_verified",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetMediaId: "target_second",
        targetStartMs: 0,
        episodeKey: null,
        episodeLabel: null
      })
    );
    attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 1_000,
        targetStartMs: 0,
        targetEndMs: 1_000
      },
      {
        kind: "sourceOnly",
        sourceStartMs: 1_000,
        sourceEndMs: 10_000,
        targetStartMs: 1_000,
        targetEndMs: 1_000
      }
    ]);
    attachTimeMap(project, "segment_second", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);

    const result = projectDanmakuToTargets(project);
    const secondTarget = result.groups.find((group) => group.targetMediaId === "target_second");

    expect(result.status).toBe("readyWithWarnings");
    expect(result.projectedItemCount).toBe(1);
    expect(result.sourceOnlyItemCount).toBe(0);
    expect(result.unexpectedUnmappedItemCount).toBe(0);
    expect(secondTarget?.entries.map((entry) => entry.item.sourceTimeMs)).toEqual([5_000]);
  });

  it("即使质量标记为 verified，包含 ambiguous 区间也会阻断导出", () => {
    const project = createSingleSegmentProject([5_000], 10_000);
    attachTimeMap(project, "segment_verified", [
      {
        kind: "ambiguous",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.unmappedItemCount).toBe(1);
    expect(result.issues.some((issue) => issue.message.includes("歧义（ambiguous）"))).toBe(
      true
    );
  });

  it("经 A/B 复核并签发的版本替换区间可导出，但不会把参考弹幕投到另一版画面", () => {
    const project = createSingleSegmentProject([5_000], 10_000);
    const candidate = attachTimeMap(
      project,
      "segment_verified",
      [
        {
          kind: "ambiguous",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }
      ],
      "review"
    );
    candidate.evidence.types.push("manual");
    candidate.evidence.notes.push(
      "manual-span-review:v1:0:replacement:2026-07-12T00:00:00.000Z"
    );
    const verified = applyManualMediaTimeMapVerification(candidate, {
      calibrationArtifactId: "test-manual-review-protocol",
      calibrationArtifactVersion: "1",
      verifier: "vitest",
      verifiedAt: "2026-07-12T00:00:00.000Z"
    });
    project.mediaTimeMaps = [verified];

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("readyWithWarnings");
    expect(result.groups[0]?.entries).toHaveLength(0);
    expect(result.sourceOnlyItemCount).toBe(1);
    expect(result.unexpectedUnmappedItemCount).toBe(0);
  });

  it("用户明确接管系统建议后可直接导出，不再要求安装级二次签发", () => {
    const project = createSingleSegmentProject([5_000], 10_000);
    const timeMap = attachTimeMap(
      project,
      "segment_verified",
      [
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }
      ],
      "review"
    );
    timeMap.evidence.types.push("manual");
    timeMap.evidence.notes.push("manual-takeover:v1:2026-07-12T00:00:00.000Z");

    const result = projectDanmakuToTargets(project);

    expect(timeMap.verification).toBeNull();
    expect(result.status).toBe("ready");
    expect(result.projectedItemCount).toBe(1);
    expect(result.groups[0]?.entries[0]?.finalTimeMs).toBe(5_000);
  });

  it.each<{
    level: MediaTimeMapQualityLevel;
    expectedStatus: "ready" | "blocked";
    expectedMessage: string | null;
  }>([
    { level: "verified", expectedStatus: "ready", expectedMessage: null },
    { level: "review", expectedStatus: "blocked", expectedMessage: "仍需人工复核" },
    { level: "blocked", expectedStatus: "blocked", expectedMessage: "质量评估已阻断" },
    {
      level: "legacy-unverified",
      expectedStatus: "blocked",
      expectedMessage: "旧规则迁移且未经验证"
    }
  ])("质量等级 $level 的导出闸门符合预期", ({ level, expectedStatus, expectedMessage }) => {
    const project = createSingleSegmentProject([5_000], 10_000);
    attachTimeMap(
      project,
      "segment_verified",
      [
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }
      ],
      level
    );

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe(expectedStatus);
    expect(result.groups).toHaveLength(level === "verified" ? 1 : 0);
    if (expectedMessage) {
      expect(result.issues.some((issue) => issue.message.includes(expectedMessage))).toBe(true);
    }
  });

  it("导出链路会重算自报 verified，低于校准概率门槛时不加入导出组", () => {
    const project = createSingleSegmentProject([5_000], 10_000);
    const timeMap = attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);
    timeMap.quality.probability = 0.99;

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toEqual([]);
    expect(result.issues.some((issue) => issue.message.includes("仍需人工复核"))).toBe(true);
  });

  it.each([
    {
      name: "候选状态",
      mutate: (project: EditorProject, timeMap: MediaTimeMap) => {
        timeMap.state = "candidate";
      },
      expected: "尚未确认"
    },
    {
      name: "错误来源",
      mutate: (project: EditorProject, timeMap: MediaTimeMap) => {
        timeMap.sourceMediaId = "other_source";
      },
      expected: "与来源素材、目标原片或分段范围不一致"
    },
    {
      name: "错误目标",
      mutate: (project: EditorProject, timeMap: MediaTimeMap) => {
        timeMap.targetMediaId = "other_target";
      },
      expected: "与来源素材、目标原片或分段范围不一致"
    },
    {
      name: "错误来源范围",
      mutate: (project: EditorProject, timeMap: MediaTimeMap) => {
        timeMap.sourceEndMs = 9_000;
      },
      expected: "与来源素材、目标原片或分段范围不一致"
    },
    {
      name: "错误目标起点",
      mutate: (project: EditorProject, timeMap: MediaTimeMap) => {
        timeMap.targetStartMs = 1_000;
      },
      expected: "与来源素材、目标原片或分段范围不一致"
    },
    {
      name: "引用不存在",
      mutate: (project: EditorProject) => {
        project.danmakuSourceSegments[0].timeMapId = "missing_time_map";
      },
      expected: "时间图不存在"
    }
  ])("$name 的时间图不会被错用", ({ mutate, expected }) => {
    const project = createSingleSegmentProject([5_000], 10_000);
    const timeMap = attachTimeMap(project, "segment_verified", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ]);
    mutate(project, timeMap);

    const result = projectDanmakuToTargets(project);

    expect(result.status).toBe("blocked");
    expect(result.groups).toHaveLength(0);
    expect(result.issues.some((issue) => issue.message.includes(expected))).toBe(true);
  });

  it("多段可汇入同一目标，同一来源也可分别投影到多个目标", () => {
    const project = createProjectWithLongReference();
    project.danmakuSourceSegments = [
      createDanmakuSourceSegment("seg_multi_a", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 500_000,
        targetMediaId: "ep1",
        targetStartMs: 0,
        episodeKey: null,
        episodeLabel: "第 1 集"
      }),
      createDanmakuSourceSegment("seg_multi_b", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 500_000,
        sourceEndMs: 700_000,
        targetMediaId: "ep1",
        targetStartMs: 500_000,
        episodeKey: null,
        episodeLabel: "第 1 集"
      }),
      createDanmakuSourceSegment("seg_multi_target", {
        kind: "content",
        assetId: project.assets[0].id,
        sourceMediaId: "ref_long",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetMediaId: "ep2",
        targetStartMs: 100_000,
        episodeKey: null,
        episodeLabel: "第 2 集"
      })
    ];
    attachTimeMap(project, "seg_multi_a", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 500_000,
        targetStartMs: 0,
        targetEndMs: 500_000
      }
    ]);
    attachTimeMap(project, "seg_multi_b", [
      {
        kind: "matched",
        sourceStartMs: 500_000,
        sourceEndMs: 700_000,
        targetStartMs: 500_000,
        targetEndMs: 700_000
      }
    ]);
    attachTimeMap(project, "seg_multi_target", [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 700_000,
        targetStartMs: 100_000,
        targetEndMs: 800_000
      }
    ]);

    const result = projectDanmakuToTargets(project);
    const ep1 = result.groups.find((group) => group.targetMediaId === "ep1");
    const ep2 = result.groups.find((group) => group.targetMediaId === "ep2");

    expect(ep1?.segments).toHaveLength(2);
    expect(ep1?.entries.map((entry) => entry.finalTimeMs)).toEqual([10_000, 600_000]);
    expect(ep2?.entries.map((entry) => entry.finalTimeMs)).toEqual([110_000, 700_000]);
  });
});
