import { describe, expect, it } from "vitest";
import type { DanmakuAsset } from "../domain/danmaku/types";
import { createEmptyProject } from "../domain/project/factory";
import { createMaterialIntakePlan } from "../domain/project/materialIntakePlan";
import type {
  EditorProject,
  ProjectMediaReference,
  ProjectMediaRole
} from "../domain/project/types";
import { applyMaterialIntakePlan } from "./applyMaterialIntakePlan";

describe("apply material intake plan", () => {
  it("只把用户选中的建议一次写入项目，并保持计划顺序", () => {
    const project = projectWithEpisodes([3, 1, 2]);
    const plan = createMaterialIntakePlan(project);
    let bindingSequence = 0;

    const result = applyMaterialIntakePlan(project, plan, {
      selectedSuggestionIds: [plan.suggestions[0].id, plan.suggestions[2].id],
      timestamp: "2026-08-29T01:00:00.000Z",
      createBindingId: () => `batch-binding-${++bindingSequence}`
    });

    expect(result.appliedSuggestionIds).toEqual([
      "material-intake:asset-1:reference-1",
      "material-intake:asset-3:reference-3"
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.project.danmakuSourceBindings).toEqual([
      {
        id: "batch-binding-1",
        assetId: "asset-1",
        sourceMediaId: "reference-1",
        linkedAt: "2026-08-29T01:00:00.000Z",
        updatedAt: "2026-08-29T01:00:00.000Z"
      },
      {
        id: "batch-binding-2",
        assetId: "asset-3",
        sourceMediaId: "reference-3",
        linkedAt: "2026-08-29T01:00:00.000Z",
        updatedAt: "2026-08-29T01:00:00.000Z"
      }
    ]);
    expect(project.danmakuSourceBindings).toEqual([]);
  });

  it("提案后新增重复候选时拒绝过期建议", () => {
    const project = projectWithEpisodes([1]);
    const plan = createMaterialIntakePlan(project);
    const changedProject = {
      ...project,
      mediaLibrary: [
        ...project.mediaLibrary,
        media("reference-duplicate", "Another.S01E01.mp4", "bilibiliReference")
      ]
    };

    const result = applyMaterialIntakePlan(changedProject, plan, {
      selectedSuggestionIds: [plan.suggestions[0].id]
    });

    expect(result.project).toBe(changedProject);
    expect(result.project.danmakuSourceBindings).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        suggestionId: plan.suggestions[0].id,
        reason: "noLongerSuggested"
      })
    ]);
  });

  it("提案后已有人工绑定时保留新状态，不覆盖也不追加", () => {
    const project = projectWithEpisodes([1]);
    const plan = createMaterialIntakePlan(project);
    const manuallyBoundProject: EditorProject = {
      ...project,
      danmakuSourceBindings: [
        {
          id: "manual-binding",
          assetId: "asset-1",
          sourceMediaId: "manual-reference",
          linkedAt: "2026-08-29T02:00:00.000Z",
          updatedAt: "2026-08-29T02:00:00.000Z"
        }
      ],
      mediaLibrary: [
        ...project.mediaLibrary,
        media("manual-reference", "Manual.S01E01.mp4", "bilibiliReference")
      ]
    };

    const result = applyMaterialIntakePlan(manuallyBoundProject, plan, {
      selectedSuggestionIds: [plan.suggestions[0].id]
    });

    expect(result.project).toBe(manuallyBoundProject);
    expect(result.project.danmakuSourceBindings).toEqual(
      manuallyBoundProject.danmakuSourceBindings
    );
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "alreadyBound" })]);
  });
});

function projectWithEpisodes(episodes: number[]): EditorProject {
  return {
    ...createEmptyProject("应用批量关系测试"),
    assets: episodes.map((episode) =>
      asset(`asset-${episode}`, `${episode} - S01E${pad(episode)}.xml`)
    ),
    mediaLibrary: episodes.flatMap((episode) => [
      media(`reference-${episode}`, `Reference.S01E${pad(episode)}.mp4`, "bilibiliReference"),
      media(`target-${episode}`, `Target.S01E${pad(episode)}.mkv`, "targetOriginal")
    ])
  };
}

function asset(id: string, fileName: string): DanmakuAsset {
  return {
    id,
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    color: "#38bdf8",
    items: [],
    warnings: [],
    importedAt: "2026-08-29T00:00:00.000Z",
    sourceReceipt: null
  };
}

function media(id: string, fileName: string, role: ProjectMediaRole): ProjectMediaReference {
  return {
    id,
    role,
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    objectUrl: null,
    durationMs: null,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: fileName,
    localPath: `F:\\TEST\\${fileName}`,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z"
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
