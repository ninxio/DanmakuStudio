import { describe, expect, it } from "vitest";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { createEmptyProject } from "./factory";
import type { EditorProject, ProjectMediaReference } from "./types";
import { createUsabilityViewModel } from "./usabilityViewModel";
import { createWorkspaceProgress, type WorkspaceProgress } from "./workspaceProgress";

describe("createUsabilityViewModel", () => {
  it("空项目优先引导导入 XML，视频对齐保持可选", () => {
    const model = createUsabilityViewModel(createEmptyProject("新项目"));

    expect(model.currentStepId).toBe("materials");
    expect(model.summary.materialSummary).toBe("还没有添加素材");
    expect(model.primaryAction).toMatchObject({
      id: "add-materials",
      label: "导入弹幕 XML"
    });
    expect(model.steps.map((step) => step.label)).toEqual([
      "素材",
      "智能匹配",
      "编辑",
      "导出"
    ]);
    expect(model.issues.map((issue) => issue.title)).toEqual([
      "还需要添加弹幕 XML"
    ]);
    expect(JSON.stringify(model)).not.toMatch(/C137|fingerprint|HMAC|sourceAtMs/);
  });

  it("素材齐备后把下一步翻译为开始智能匹配", () => {
    const project = createMaterialsReadyProject(2);
    const model = createUsabilityViewModel(project);

    expect(model.currentStepId).toBe("matching");
    expect(model.summary).toMatchObject({
      originalCount: 2,
      referenceCount: 1,
      xmlCount: 1,
      boundXmlCount: 1,
      materialSummary: "2 集原片 · 1 个参考视频 · 1 个 XML"
    });
    expect(model.primaryAction).toMatchObject({
      id: "review-matches",
      label: "开始智能匹配"
    });
    expect(model.steps.find((step) => step.id === "materials")).toMatchObject({
      state: "complete",
      statusId: "confirmed",
      stateLabel: "已确认"
    });
  });

  it("有候选时把人工处理明确归入编辑步骤", () => {
    const project = createMaterialsReadyProject(5);
    const baseline = createWorkspaceProgress(project);
    const progress: WorkspaceProgress = {
      ...baseline,
      steps: baseline.steps.map((step) => ({
        ...step,
        state:
          step.id === "materials" || step.id === "matching"
            ? "complete"
            : step.id === "editing"
              ? "active"
              : step.state,
        blockers:
          step.id === "editing"
            ? ["还有 2 条候选时间关系需要播放检查或确认。"]
            : []
      })),
      recommendedPage: "editing",
      recommendedAction: "播放并检查时间关系",
      analyzedTargetCount: 5,
      pendingMatchCandidateCount: 2
    };
    const model = createUsabilityViewModel(project, progress);

    expect(model.primaryAction.label).toBe("编辑 2 条候选时间线");
    expect(model.issues).toContainEqual(
      expect.objectContaining({
        stepId: "editing",
        title: "2 条候选时间线需要编辑",
        severity: "review"
      })
    );
  });

  it("导出就绪时给出面向结果的主动作", () => {
    const project = createMaterialsReadyProject(5);
    const baseline = createWorkspaceProgress(project);
    const progress: WorkspaceProgress = {
      ...baseline,
      steps: baseline.steps.map((step) => ({
        ...step,
        state:
          step.id === "materials" || step.id === "matching"
            ? "complete"
            : step.id === "export"
              ? "active"
              : step.state,
        blockers: []
      })),
      recommendedPage: "export",
      recommendedAction: "导出全部分集 XML",
      exportableEpisodeCount: 5,
      analyzedTargetCount: 5,
      confirmedTargetCount: 5,
      pendingMatchCandidateCount: 0,
      projection: {
        ...baseline.projection,
        issues: []
      }
    };
    const model = createUsabilityViewModel(project, progress);

    expect(model.currentStepId).toBe("export");
    expect(model.summary.resultSummary).toBe("5 集可以导出");
    expect(model.primaryAction).toMatchObject({
      id: "export",
      label: "导出 5 集 XML"
    });
  });
});

function createMaterialsReadyProject(originalCount: number): EditorProject {
  const project = createEmptyProject("暗黑 S01");
  const asset = parseBilibiliXml(
    '<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,0,0,u,r">测试</d></i>',
    { assetId: "xml-1", fileName: "S01.xml" }
  );
  const reference = createMedia("reference", "bilibiliReference");
  project.assets = [asset];
  project.mediaLibrary = [
    reference,
    ...Array.from({ length: originalCount }, (_, index) =>
      createMedia(`episode-${index + 1}`, "targetOriginal")
    )
  ];
  project.danmakuSourceBindings = [
    {
      id: "binding-1",
      assetId: asset.id,
      sourceMediaId: reference.id,
      linkedAt: project.createdAt,
      updatedAt: project.updatedAt
    }
  ];
  return project;
}

function createMedia(
  id: string,
  role: ProjectMediaReference["role"]
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: `${id}.mkv`,
    objectUrl: null,
    durationMs: 1_200_000,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件",
    localPath: `C:\\media\\${id}.mkv`,
    emby: null,
    episodeKey: null,
    episodeLabel: role === "targetOriginal" ? id : null,
    contentIdentity: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z"
  };
}
