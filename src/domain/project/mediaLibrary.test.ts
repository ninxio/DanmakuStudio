import { describe, expect, it } from "vitest";
import { createMediaMatchCandidate } from "../alignment/mediaMatching";
import type { DanmakuAsset } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import {
  collectMediaReferenceUsages,
  createDanmakuSourceBinding,
  reconnectMediaReference,
  removeMediaReference,
  sanitizeMediaReferencesForSave,
  validateDanmakuSourceBinding,
  validateSourceSegmentReferences
} from "./mediaLibrary";
import type { ProjectMediaReference, ProjectMediaRole } from "./types";

const TIMESTAMP = "2026-07-11T00:00:00.000Z";

describe("project media library", () => {
  it("保存时清除临时对象 URL，并把浏览器文件标记为需要重连", () => {
    const saved = sanitizeMediaReferencesForSave([
      createMediaReference("source-media", "bilibiliReference", {
        objectUrl: "blob:source",
        referenceKind: "browserFile",
        connectionState: "connected"
      }),
      createMediaReference("target-media", "targetOriginal", {
        objectUrl: "blob:target",
        referenceKind: "localPath",
        connectionState: "connected",
        localPath: "D:\\media\\full.mkv"
      })
    ]);

    expect(saved[0]).toMatchObject({
      id: "source-media",
      objectUrl: null,
      connectionState: "needsReconnect"
    });
    expect(saved[1]).toMatchObject({
      id: "target-media",
      objectUrl: null,
      connectionState: "connected"
    });
  });

  it("XML 只能绑定 B 站参考素材", () => {
    const project = {
      ...createEmptyProject(),
      assets: [createAsset()],
      mediaLibrary: [
        createMediaReference("source-media", "bilibiliReference"),
        createMediaReference("target-media", "targetOriginal")
      ]
    };

    expect(validateDanmakuSourceBinding(project, "asset", "source-media")).toBeNull();
    expect(validateDanmakuSourceBinding(project, "asset", "target-media")).toBe("XML 只能绑定 B 站参考素材。");
    expect(validateDanmakuSourceBinding(project, "missing-asset", "source-media")).toBe("XML 资源不存在。");
  });

  it("校验来源段的 XML、来源角色、目标角色和参考素材时间范围", () => {
    const project = {
      ...createEmptyProject(),
      assets: [createAsset()],
      mediaLibrary: [
        createMediaReference("source-media", "bilibiliReference", { durationMs: 1000 }),
        createMediaReference("target-media", "targetOriginal")
      ]
    };

    expect(
      validateSourceSegmentReferences(project, {
        kind: "content",
        assetId: "asset",
        sourceMediaId: "source-media",
        targetMediaId: "target-media",
        sourceStartMs: 0,
        sourceEndMs: 2000
      })
    ).toContainEqual({
      severity: "warning",
      message: "来源段时间超出了参考素材已知时长，请确认是否为长视频或元数据不完整。"
    });

    const invalidRoleIssues = validateSourceSegmentReferences(project, {
      kind: "content",
      assetId: "asset",
      sourceMediaId: "target-media",
      targetMediaId: "source-media",
      sourceStartMs: 0,
      sourceEndMs: 1000
    });
    expect(invalidRoleIssues).toContainEqual({
      severity: "error",
      message: "来源段的来源素材只能是 B 站参考素材。"
    });
    expect(invalidRoleIssues).toContainEqual({
      severity: "error",
      message: "来源段的目标素材只能是原片素材。"
    });

    expect(
      validateSourceSegmentReferences(project, {
        kind: "content",
        assetId: "missing-asset",
        sourceMediaId: null,
        targetMediaId: null,
        sourceStartMs: 0,
        sourceEndMs: 1000
      })
    ).toEqual([
      { severity: "error", message: "来源段必须选择所属 XML。" },
      { severity: "error", message: "来源段必须选择 B 站参考素材。" },
      { severity: "warning", message: "正片内容段尚未选择目标原片。" }
    ]);
  });

  it("删除媒体素材时阻止悬空引用，并允许删除未被引用的素材", () => {
    const project = {
      ...createEmptyProject(),
      assets: [createAsset()],
      mediaLibrary: [
        createMediaReference("source-media", "bilibiliReference"),
        createMediaReference("target-media", "targetOriginal"),
        createMediaReference("loose-media", "bilibiliReference")
      ],
      mediaBinding: {
        id: "target-binding",
        kind: "localFile" as const,
        displayName: "目标原片",
        fileName: "target.mp4",
        mediaId: "target-media",
        localPath: null,
        runtimeMs: 120_000,
        linkedAt: TIMESTAMP
      },
      seasonEpisodeBindings: [
        {
          id: "season-binding",
          episodeKey: "S01E01",
          episodeLabel: "第 1 集",
          linkedAt: TIMESTAMP,
          targetBinding: {
            id: "season-target",
            kind: "localFile" as const,
            displayName: "目标原片",
            fileName: "target.mp4",
            mediaId: "target-media",
            localPath: null,
            runtimeMs: 120_000,
            linkedAt: TIMESTAMP
          }
        }
      ],
      danmakuSourceBindings: [createDanmakuSourceBinding("xml-binding", "asset", "source-media", TIMESTAMP)],
      danmakuSourceSegments: [
        {
          id: "segment",
          label: "第 1 集来源段",
          kind: "content" as const,
          assetId: "asset",
          sourceMediaId: "source-media",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetMediaId: "target-media",
          targetStartMs: null,
          timingRules: [],
          timeMapId: null,
          episodeKey: "S01E01",
          episodeLabel: "第 1 集",
          note: "",
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP
        }
      ]
    };

    expect(collectMediaReferenceUsages(project, "source-media").map((usage) => usage.kind)).toEqual([
      "xmlBinding",
      "sourceSegmentSource"
    ]);
    expect(collectMediaReferenceUsages(project, "target-media").map((usage) => usage.kind)).toEqual([
      "sourceSegmentTarget",
      "mediaBinding",
      "seasonEpisodeBinding"
    ]);
    expect(removeMediaReference(project, "source-media").ok).toBe(false);
    expect(removeMediaReference(project, "target-media").ok).toBe(false);

    const removed = removeMediaReference(project, "loose-media");
    expect(removed.ok).toBe(true);
    expect(removed.project.mediaLibrary.map((media) => media.id)).toEqual(["source-media", "target-media"]);
  });

  it("删除仅被匹配候选引用的媒体时同步清理候选，真实 XML 绑定仍阻止误删", () => {
    const baseProject = {
      ...createEmptyProject(),
      assets: [createAsset()],
      mediaLibrary: [
        createMediaReference("source-media", "bilibiliReference"),
        createMediaReference("target-media", "targetOriginal")
      ],
      danmakuSourceBindings: [createDanmakuSourceBinding("xml-binding", "asset", "source-media", TIMESTAMP)]
    };
    const candidate = createMediaMatchCandidate(baseProject, {
      id: "candidate",
      batchId: "batch",
      sourceMediaId: "source-media",
      targetMediaId: "target-media",
      proposal: {
        anchors: [],
        cutCandidates: [],
        confidence: 0.9,
        diagnostics: [],
        matchRange: {
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000,
          coverage: 1
        }
      }
    });
    const project = { ...baseProject, mediaMatchCandidates: [candidate] };

    expect(collectMediaReferenceUsages(project, "source-media").map((usage) => usage.kind)).toEqual([
      "xmlBinding",
      "matchCandidateSource"
    ]);
    expect(collectMediaReferenceUsages(project, "target-media").map((usage) => usage.kind)).toEqual([
      "matchCandidateTarget"
    ]);
    expect(removeMediaReference(project, "source-media").ok).toBe(false);
    const removedTarget = removeMediaReference(project, "target-media");
    expect(removedTarget.ok).toBe(true);
    expect(removedTarget.project.mediaMatchCandidates).toEqual([]);
    expect(removedTarget.project.mediaLibrary.map((media) => media.id)).toEqual(["source-media"]);

    const rejectedProject = {
      ...project,
      mediaMatchCandidates: [{ ...candidate, state: "rejected" as const }]
    };
    const removedRejectedTarget = removeMediaReference(rejectedProject, "target-media");
    expect(removedRejectedTarget.ok).toBe(true);
    expect(removedRejectedTarget.project.mediaMatchCandidates).toEqual([]);
  });

  it("重新连接素材保留稳定 ID 和角色，只更新会话文件引用", () => {
    const media = createMediaReference("source-media", "bilibiliReference", {
      name: "旧参考",
      fileName: "old.mp4",
      objectUrl: null,
      durationMs: 120_000,
      connectionState: "needsReconnect",
      audioTrackIntent: {
        mode: "explicit",
        streamIndex: 7,
        inventoryRevision: "inventory-v1:before-reconnect"
      }
    });

    const reconnected = reconnectMediaReference(
      media,
      {
        name: "新参考",
        fileName: "new.mp4",
        objectUrl: "blob:new",
        durationMs: null
      },
      "2026-07-11T01:00:00.000Z"
    );

    expect(reconnected).toMatchObject({
      id: "source-media",
      role: "bilibiliReference",
      name: "新参考",
      fileName: "new.mp4",
      objectUrl: "blob:new",
      durationMs: 120_000,
      connectionState: "connected",
      audioTrackIntent: {
        mode: "explicit",
        streamIndex: 7,
        inventoryRevision: "inventory-v1:before-reconnect"
      },
      updatedAt: "2026-07-11T01:00:00.000Z"
    });

    expect(sanitizeMediaReferencesForSave([reconnected])[0].audioTrackIntent).toEqual({
      mode: "explicit",
      streamIndex: 7,
      inventoryRevision: "inventory-v1:before-reconnect"
    });
  });
});

function createMediaReference(
  id: string,
  role: ProjectMediaRole,
  overrides: Partial<ProjectMediaReference> = {}
): ProjectMediaReference {
  return {
    id,
    role,
    name: overrides.name ?? (role === "bilibiliReference" ? "B 站参考素材" : "目标原片"),
    fileName: overrides.fileName ?? (role === "bilibiliReference" ? "reference.mp4" : "target.mp4"),
    objectUrl: "objectUrl" in overrides ? overrides.objectUrl ?? null : "blob:media",
    durationMs: "durationMs" in overrides ? overrides.durationMs ?? null : 120_000,
    contentIdentity: overrides.contentIdentity ?? null,
    referenceKind: overrides.referenceKind ?? "browserFile",
    connectionState: overrides.connectionState ?? "connected",
    sourceSummary: overrides.sourceSummary ?? "测试媒体",
    localPath: overrides.localPath ?? null,
    emby: overrides.emby ?? null,
    episodeKey: overrides.episodeKey ?? null,
    episodeLabel: overrides.episodeLabel ?? null,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" },
    createdAt: overrides.createdAt ?? TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TIMESTAMP
  };
}

function createAsset(): DanmakuAsset {
  return {
    id: "asset",
    name: "测试 XML",
    fileName: "source.xml",
    color: "#4cc9f0",
    importedAt: TIMESTAMP,
    sourceReceipt: null,
    warnings: [],
    items: []
  };
}
