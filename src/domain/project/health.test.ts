import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import { CURRENT_SCHEMA_VERSION } from "./types";
import {
  cleanupProjectEditReferences,
  cleanupProjectMissingAssetClips,
  createProjectHealthReport,
  createProjectHealthSummary,
  summarizeProjectHealthBlockers
} from "./health";

describe("project health", () => {
  it("为空项目提示需要导入 XML", () => {
    const summary = createProjectHealthSummary(createEmptyProject());

    expect(summary.status).toBe("attention");
    expect(summary.statusLabel).toBe("需复核");
    expect(summary.metrics.assetCount).toBe(0);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "no-assets",
        severity: "warning"
      })
    );
  });

  it("把未验证或含歧义的确认时间图列为导出阻断", () => {
    const project = createEmptyProject("时间图健康检查");
    project.danmakuSourceSegments = [
      {
        id: "segment-1",
        label: "第 1 集来源段",
        kind: "content",
        assetId: null,
        sourceMediaId: "source-1",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetMediaId: "target-1",
        targetStartMs: 0,
        timingRules: [],
        timeMapId: "time-map-1",
        episodeKey: null,
        episodeLabel: null,
        note: "",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z"
      }
    ];
    project.mediaTimeMaps = [
      {
        id: "time-map-1",
        revision: 1,
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        sourceStream: null,
        targetStream: null,
        sourceIdentity: null,
        targetIdentity: null,
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000,
        spans: [
          {
            kind: "ambiguous",
            sourceStartMs: 0,
            sourceEndMs: 10_000,
            targetStartMs: 0,
            targetEndMs: 10_000
          }
        ],
        quality: {
          level: "legacy-unverified",
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
          reasons: ["旧算法没有真实媒体精度指标。"]
        },
        evidence: {
          types: ["legacy"],
          audioAnchorCount: 0,
          visualAnchorCount: 0,
          heldOutAnchorCount: 0,
          notes: []
        },
        verification: null,
        engineVersion: "legacy-v9",
        featureVersion: "legacy-v9",
        parametersHash: "legacy-test",
        state: "confirmed",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
        confirmedAt: "2026-07-12T00:00:00.000Z"
      }
    ];

    const summary = createProjectHealthSummary(project);
    expect(summary.status).toBe("blocked");
    expect(summary.statusLabel).toBe("已阻断");
    expect(summary.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source-segment-time-map-quality-segment-1",
          severity: "error",
          title: "时间映射尚未验证"
        }),
        expect.objectContaining({
          id: "source-segment-time-map-ambiguous-segment-1",
          severity: "error",
          title: "时间映射仍有歧义区间"
        })
      ])
    );
  });

  it("没有时间图的 content 段直接列为导出阻断", () => {
    const project = createEmptyProject("手工兼容段");
    project.danmakuSourceSegments = [
      {
        id: "manual-segment",
        label: "手工来源段",
        kind: "content",
        assetId: null,
        sourceMediaId: null,
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetMediaId: null,
        targetStartMs: 0,
        timingRules: [],
        timeMapId: null,
        episodeKey: null,
        episodeLabel: null,
        note: "",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z"
      }
    ];

    expect(createProjectHealthSummary(project).findings).toContainEqual(
      expect.objectContaining({
        id: "source-segment-time-map-missing-manual-segment",
        severity: "error",
        title: "来源段缺少确认时间图"
      })
    );
  });

  it("统计可用弹幕、片段和版本差异规则", () => {
    const asset = createAsset("asset", [createItem("item-1"), { ...createItem("item-2"), enabled: false }]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ],
      cutMarkers: [{ id: "cut", name: "版本差异", sourceAtMs: 1000, targetGapMs: 2500, note: "确认" }],
      syncAnchors: [{ id: "anchor", sourceMs: 1000, targetMs: 3500, confidence: 0.95, origin: "manual" as const }]
    };

    const summary = createProjectHealthSummary(project);

    expect(summary.status).toBe("ready");
    expect(summary.statusLabel).toBe("可运行");
    expect(summary.metrics).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      assetCount: 1,
      itemCount: 2,
      enabledItemCount: 1,
      disabledItemCount: 1,
      clipCount: 1,
      activeClipCount: 1,
      cutMarkerCount: 1,
      totalCutGapMs: 2500,
      syncAnchorCount: 1,
      negativeFinalTimeItemCount: 0
    });
    expect(summary.findings).toContainEqual(expect.objectContaining({ id: "ready" }));
  });

  it("阻断缺失资源引用和重复 ID，并记录重复位置", () => {
    const asset = createAsset("asset", [createItem("same-id"), { ...createItem("same-id"), originalIndex: 1 }]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const summary = createProjectHealthSummary(project);

    expect(summary.status).toBe("blocked");
    expect(summary.metrics.missingAssetClipCount).toBe(1);
    expect(summary.metrics.duplicateIdCount).toBe(1);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "item-id",
        severity: "error",
        evidence: ["same-id：资源 asset.xml 的第 1 条弹幕；资源 asset.xml 的第 2 条弹幕"]
      })
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "clip-missing-asset",
        severity: "error",
        evidence: [
          "坏片段（片段 ID：clip，缺失资源 ID：missing-asset，时间轴 00:00:00.000，源区间 00:00:00.000 - 00:00:03.000）"
        ]
      })
    );

    const report = createProjectHealthReport("重复项目", summary);
    expect(report).toContain("重复 ID：1 个");
    expect(report).toContain("same-id：资源 asset.xml 的第 1 条弹幕；资源 asset.xml 的第 2 条弹幕");
    expect(report).toContain("缺失资源 ID：missing-asset");
    expect(summarizeProjectHealthBlockers(summary)).toBe("弹幕 ID 重复、片段引用了缺失资源");
  });

  it("重复 ID 证据超过预览限制时提示剩余数量", () => {
    const duplicatedItems = Array.from({ length: 12 }, (_, index) => ({
      ...createItem(`dup-${Math.floor(index / 2) + 1}`),
      originalIndex: index
    }));
    const project = {
      ...createEmptyProject(),
      assets: [createAsset("asset", duplicatedItems)]
    };

    const summary = createProjectHealthSummary(project);
    const duplicateFinding = summary.findings.find((finding) => finding.id === "item-id");

    expect(summary.metrics.duplicateIdCount).toBe(6);
    expect(duplicateFinding?.evidence).toContain("dup-1：资源 asset.xml 的第 1 条弹幕；资源 asset.xml 的第 2 条弹幕");
    expect(duplicateFinding?.evidence).toContain("dup-5：资源 asset.xml 的第 9 条弹幕；资源 asset.xml 的第 10 条弹幕");
    expect(duplicateFinding?.evidence).toContain("另有 1 个重复 ID 未列出，完整数量见上方计数。");
    expect(duplicateFinding?.evidence).not.toContain("dup-6：资源 asset.xml 的第 11 条弹幕；资源 asset.xml 的第 12 条弹幕");
  });

  it("提示媒体重连、导入警告、低置信锚点和失效编辑引用", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      media: {
        id: "media",
        name: "示例视频",
        fileName: "demo.mp4",
        objectUrl: null,
        durationMs: null
      },
      assets: [
        {
          ...asset,
          warnings: [
            {
              id: "warning",
              assetId: "asset",
              originalIndex: null,
              severity: "warning" as const,
              message: "跳过一条坏弹幕",
              rawSnippet: "<d/>"
            }
          ]
        }
      ],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ],
      syncAnchors: [{ id: "anchor", sourceMs: 1000, targetMs: 1200, confidence: 0.6, origin: "automatic" as const }],
      disabledItemIds: ["missing-item"],
      itemTimeAdjustments: { "missing-item": 100 }
    };

    const summary = createProjectHealthSummary(project);

    expect(summary.status).toBe("attention");
    expect(summary.metrics.mediaNeedsReconnect).toBe(true);
    expect(summary.metrics.orphanedEditReferenceCount).toBe(2);
    expect(summary.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "media-needs-reconnect",
        "media-duration-missing",
        "import-warnings",
        "low-confidence-anchors",
        "orphaned-edits"
      ])
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "orphaned-edits",
        evidence: ["失效禁用：missing-item", "失效微调：missing-item（+00:00:00.100）"]
      })
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "import-warnings",
        evidence: ["asset.xml / 文件级 / 警告：跳过一条坏弹幕，片段：<d/>"]
      })
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "media-needs-reconnect",
        evidence: ["demo.mp4（名称：示例视频）"]
      })
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "media-duration-missing",
        evidence: ["demo.mp4（名称：示例视频）"]
      })
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "low-confidence-anchors",
        evidence: ["anchor（自动，00:00:01.000 -> 00:00:01.200，置信度 60%）"]
      })
    );
  });

  it("提示本地目标原片重新打开后需要重新连接", () => {
    const summary = createProjectHealthSummary({
      ...createEmptyProject(),
      mediaBinding: {
        id: "binding-local",
        kind: "localFile",
        displayName: "本地完整版",
        fileName: "full.mp4",
        mediaId: "media-local",
        localPath: null,
        runtimeMs: 3_000_000,
        linkedAt: "2026-07-10T00:00:00.000Z"
      }
    });

    expect(summary.metrics.mediaBindingKind).toBe("localFile");
    expect(summary.metrics.mediaBindingNeedsReconnect).toBe(true);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "target-local-needs-reconnect",
        evidence: ["本地完整版（本地文件 / full.mp4）"]
      })
    );
    expect(createProjectHealthReport("目标绑定项目", summary)).toContain("目标原片重连：需要");
  });

  it("本地目标原片已有路径时不提示目标重连", () => {
    const summary = createProjectHealthSummary({
      ...createEmptyProject(),
      mediaBinding: {
        id: "binding-local-path",
        kind: "localFile",
        displayName: "本地完整版",
        fileName: "full.mkv",
        mediaId: null,
        localPath: "D:\\media\\full.mkv",
        runtimeMs: 3_000_000,
        linkedAt: "2026-07-10T00:00:00.000Z"
      }
    });

    expect(summary.metrics.mediaBindingKind).toBe("localFile");
    expect(summary.metrics.mediaBindingNeedsReconnect).toBe(false);
    expect(summary.findings.some((finding) => finding.id === "target-local-needs-reconnect")).toBe(false);
  });

  it("提示没有时间轴片段和所有片段禁用时显示证据", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const noClipSummary = createProjectHealthSummary({
      ...createEmptyProject(),
      assets: [asset]
    });
    const disabledClipSummary = createProjectHealthSummary({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-disabled",
          assetId: "asset",
          name: "禁用片段",
          timelineStartMs: 5000,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: false
        }
      ]
    });
    const report = createProjectHealthReport("禁用项目", disabledClipSummary);

    expect(noClipSummary.findings).toContainEqual(
      expect.objectContaining({
        id: "no-clips",
        evidence: ["asset.xml（1 条弹幕）"]
      })
    );
    expect(disabledClipSummary.findings).toContainEqual(
      expect.objectContaining({
        id: "all-clips-disabled",
        evidence: ["禁用片段 / asset.xml（时间轴 00:00:05.000，源区间 00:00:00.000 - 00:00:03.000）"]
      })
    );
    expect(report).toContain("禁用片段 / asset.xml");
  });

  it("提示空片段和 0ms 版本差异时显示证据", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-empty",
          assetId: "asset",
          name: "空片段",
          timelineStartMs: 5000,
          sourceInMs: 2000,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ],
      cutMarkers: [{ id: "zero", name: "标记", sourceAtMs: 1500, targetGapMs: 0, note: "仅标记" }]
    };

    const summary = createProjectHealthSummary(project);
    const report = createProjectHealthReport("复核项目", summary);

    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "empty-clips",
        evidence: ["空片段 / asset.xml（时间轴 00:00:05.000，源区间 00:00:02.000 - 00:00:03.000）"]
      })
    );
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "zero-gap-markers",
        evidence: ["标记（ID：zero，发生位置 00:00:01.500，备注：仅标记）"]
      })
    );
    expect(report).toContain("空片段 / asset.xml");
    expect(report).toContain("标记（ID：zero");
  });

  it("空片段判断使用半开源区间边界", () => {
    const asset = createAsset("asset", [createItem("edge-item")]);
    const summary = createProjectHealthSummary({
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-edge-empty",
          assetId: "asset",
          name: "边界空片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    });

    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "empty-clips",
        evidence: ["边界空片段 / asset.xml（时间轴 00:00:00.000，源区间 00:00:00.000 - 00:00:01.000）"]
      })
    );
  });

  it("提示会在导出时被限制为 0ms 的负最终时间", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      globalOffsetMs: -1500,
      assets: [asset],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const summary = createProjectHealthSummary(project);
    const report = createProjectHealthReport("负时间项目", summary);

    expect(summary.status).toBe("attention");
    expect(summary.metrics.negativeFinalTimeItemCount).toBe(1);
    expect(summary.findings).toContainEqual(
      expect.objectContaining({
        id: "negative-final-times",
        severity: "warning",
        evidence: ["asset.xml / 片段 / 第 1 条：-00:00:00.500，测试"]
      })
    );
    expect(report).toContain("负最终时间：1 条");
    expect(report).toContain("[需复核] 存在负最终时间");
  });

  it("负最终时间证据超过预览限制时提示剩余数量", () => {
    const negativeItems = Array.from({ length: 6 }, (_, index) => ({
      ...createItem(`item-${index + 1}`),
      originalIndex: index,
      sourceTimeMs: index * 100,
      text: `第 ${index + 1} 条`
    }));
    const project = {
      ...createEmptyProject(),
      globalOffsetMs: -1000,
      assets: [createAsset("asset", negativeItems)],
      clips: [
        {
          id: "clip",
          assetId: "asset",
          name: "片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 1000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const summary = createProjectHealthSummary(project);
    const negativeFinding = summary.findings.find((finding) => finding.id === "negative-final-times");
    const report = createProjectHealthReport("负时间项目", summary);

    expect(summary.metrics.negativeFinalTimeItemCount).toBe(6);
    expect(negativeFinding?.evidence).toContain("asset.xml / 片段 / 第 1 条：-00:00:01.000，第 1 条");
    expect(negativeFinding?.evidence).toContain("asset.xml / 片段 / 第 5 条：-00:00:00.600，第 5 条");
    expect(negativeFinding?.evidence).toContain("另有 1 条负最终时间未列出，完整数量见上方计数。");
    expect(negativeFinding?.evidence).not.toContain("asset.xml / 片段 / 第 6 条：-00:00:00.500，第 6 条");
    expect(report).toContain("另有 1 条负最终时间未列出，完整数量见上方计数。");
  });

  it("可清理指向不存在弹幕的禁用和微调引用", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      disabledItemIds: ["item-1", "missing-disabled"],
      itemTimeAdjustments: {
        "item-1": 100,
        "missing-adjustment": 200
      }
    };

    const cleanup = cleanupProjectEditReferences(project);

    expect(cleanup.changed).toBe(true);
    expect(cleanup.removedDisabledItemIds).toBe(1);
    expect(cleanup.removedItemAdjustments).toBe(1);
    expect(cleanup.project.disabledItemIds).toEqual(["item-1"]);
    expect(cleanup.project.itemTimeAdjustments).toEqual({ "item-1": 100 });
  });

  it("可清理引用缺失资源的片段", () => {
    const asset = createAsset("asset", [createItem("item-1")]);
    const project = {
      ...createEmptyProject(),
      assets: [asset],
      clips: [
        {
          id: "clip-valid",
          assetId: "asset",
          name: "有效片段",
          timelineStartMs: 0,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        },
        {
          id: "clip-missing",
          assetId: "missing-asset",
          name: "坏片段",
          timelineStartMs: 3000,
          sourceInMs: 0,
          sourceOutMs: 3000,
          localOffsetMs: 0,
          enabled: true
        }
      ]
    };

    const cleanup = cleanupProjectMissingAssetClips(project);

    expect(cleanup.changed).toBe(true);
    expect(cleanup.removedClipIds).toEqual(["clip-missing"]);
    expect(cleanup.removedClipCount).toBe(1);
    expect(cleanup.project.clips.map((clip) => clip.id)).toEqual(["clip-valid"]);
  });

  it("可生成导出前检查报告文本", () => {
    const summary = createProjectHealthSummary({
      ...createEmptyProject("报告项目"),
      assets: [createAsset("asset", [createItem("item-1")])],
      disabledItemIds: ["missing-disabled"]
    });

    const report = createProjectHealthReport("报告项目", summary, new Date("2026-07-10T01:02:03.000Z"));

    expect(report).toContain("导出前检查报告");
    expect(report).toContain("项目：报告项目");
    expect(report).toContain(`项目版本：v${CURRENT_SCHEMA_VERSION}`);
    expect(report).toContain("生成时间：2026-07-10T01:02:03.000Z");
    expect(report).toContain("状态：需复核");
    expect(report).toContain("失效编辑引用：1 条");
    expect(report).toContain("缺失资源片段：0 个");
    expect(report).toContain("重复 ID：0 个");
    expect(report).toContain("负最终时间：0 条");
    expect(report).toContain("[需复核] 存在失效编辑引用");
    expect(report).toContain("失效禁用：missing-disabled");
  });
});

function createAsset(id: string, items: DanmakuItem[]): DanmakuAsset {
  return {
    id,
    name: id,
    fileName: `${id}.xml`,
    color: "#4cc9f0",
    items,
    warnings: [],
    importedAt: "2026-07-03T00:00:00.000Z",
    sourceReceipt: null
  };
}

function createItem(id: string): DanmakuItem {
  return {
    id,
    assetId: "asset",
    originalIndex: 0,
    sourceTimeMs: 1000,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "u",
    rowId: "r",
    text: "测试",
    rawPFields: ["1", "1", "25", "16777215", "0", "0", "u", "r"],
    enabled: true
  };
}
