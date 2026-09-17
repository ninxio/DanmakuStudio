import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./factory";
import { getProjectWorkflowMode } from "./workflowMode";

describe("getProjectWorkflowMode", () => {
  it("空项目和仅含 XML 的项目使用轻量编辑流程", () => {
    const project = createEmptyProject();
    expect(getProjectWorkflowMode(project)).toBe("xml-only");

    project.assets = [
      {
        id: "asset-1",
        name: "episode",
        fileName: "episode.xml",
        color: "#22d3ee",
        items: [],
        warnings: [],
        importedAt: "2026-07-28T00:00:00.000Z",
        sourceReceipt: null
      }
    ];
    expect(getProjectWorkflowMode(project)).toBe("xml-only");
  });

  it("导入媒体或已有时间映射上下文时进入视频对齐流程", () => {
    const project = createEmptyProject();
    project.mediaLibrary = [
      {
        id: "media-1",
        role: "targetOriginal",
        name: "original",
        fileName: "original.mkv",
        objectUrl: null,
        durationMs: 60_000,
        referenceKind: "localPath",
        connectionState: "connected",
        sourceSummary: "本地文件",
        localPath: "C:\\media\\original.mkv",
        emby: null,
        episodeKey: null,
        episodeLabel: null,
        contentIdentity: null,
        audioTrackIntent: { mode: "auto" },
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z"
      }
    ];
    expect(getProjectWorkflowMode(project)).toBe("media-alignment");
  });
});
