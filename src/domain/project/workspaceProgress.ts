import { findDanmakuSourceBinding } from "./mediaLibrary";
import type { EditorProject } from "./types";
import { getProjectWorkflowMode, type ProjectWorkflowMode } from "./workflowMode";
import {
  projectDanmakuToTargets,
  type SourceProjectionResult
} from "../timeline/sourceProjection";
import { statusLabel, type WorkspaceStatusId } from "../shared/statusVocabulary";

export type WorkspacePageId = "materials" | "matching" | "editing" | "export";
export type WorkspaceStepState = "complete" | "active" | "blocked" | "idle";

export interface WorkspacePageStep {
  id: WorkspacePageId;
  order: number;
  label: string;
  state: WorkspaceStepState;
  statusId: WorkspaceStatusId;
  stateText: string;
  headline: string;
  detail: string;
  blockers: string[];
}

export interface WorkspaceProgress {
  workflowMode: ProjectWorkflowMode;
  steps: WorkspacePageStep[];
  completeStepCount: number;
  totalStepCount: number;
  progressPercent: number;
  recommendedPage: WorkspacePageId;
  recommendedAction: string;
  liveSummary: string;
  projection: SourceProjectionResult;
  exportableEpisodeCount: number;
  analyzedTargetCount: number;
  confirmedTargetCount: number;
  pendingMatchCandidateCount: number;
  timelineExportReady: boolean;
}

export function createWorkspaceProgress(project: EditorProject): WorkspaceProgress {
  const projection = projectDanmakuToTargets(project);
  const workflowMode = getProjectWorkflowMode(project);
  const targetMedia = project.mediaLibrary.filter((media) => media.role === "targetOriginal");
  const referenceMedia = project.mediaLibrary.filter(
    (media) => media.role === "bilibiliReference"
  );
  const assetCount = project.assets.length;
  if (workflowMode === "xml-only") {
    return createXmlOnlyWorkspaceProgress(project, projection);
  }
  const unboundXmlCount = project.assets.filter(
    (asset) => !findDanmakuSourceBinding(project.danmakuSourceBindings, asset.id)
  ).length;
  const contentSegments = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "content"
  );
  const confirmedTargetIds = new Set(
    contentSegments
      .map((segment) => segment.targetMediaId)
      .filter((mediaId): mediaId is string => targetMedia.some((media) => media.id === mediaId))
  );
  const confirmedTargetCount = confirmedTargetIds.size;
  const editableCandidates = project.mediaMatchCandidates.filter(
    (candidate) =>
      candidate.state !== "rejected" &&
      targetMedia.some((media) => media.id === candidate.targetMediaId) &&
      project.mediaTimeMaps.some((timeMap) => timeMap.id === candidate.timeMapId)
  );
  const analyzedTargetIds = new Set([
    ...confirmedTargetIds,
    ...editableCandidates.map((candidate) => candidate.targetMediaId)
  ]);
  const analyzedTargetCount = analyzedTargetIds.size;
  const pendingMatchCandidateCount = editableCandidates.filter(
    (candidate) => candidate.state === "pending" || candidate.state === "blocked"
  ).length;
  const exportableEpisodeCount = projection.groups.filter(
    (group) => group.entries.length > 0
  ).length;

  const materialsBlockers = createMaterialsBlockers({
    assetCount,
    targetCount: targetMedia.length,
    referenceCount: referenceMedia.length,
    unboundXmlCount
  });
  const matchingBlockers = createMatchingBlockers({
    materialsComplete: materialsBlockers.length === 0 && assetCount > 0,
    analyzedTargetCount,
    targetCount: targetMedia.length
  });
  const editingBlockers = createEditingBlockers({
    confirmedTargetCount,
    targetCount: targetMedia.length,
    pendingCandidateCount: pendingMatchCandidateCount
  });

  const materialsState = resolveStepState(materialsBlockers, assetCount > 0);
  const matchingState = resolveMatchingState(
    materialsState,
    matchingBlockers,
    analyzedTargetCount,
    targetMedia.length
  );
  const editingState = resolveEditingState(
    materialsState,
    matchingState,
    editingBlockers,
    analyzedTargetCount,
    confirmedTargetCount,
    targetMedia.length
  );
  const exportState = resolveExportState(editingState, projection, exportableEpisodeCount);
  const materialsStatusId: WorkspaceStatusId =
    materialsState === "complete" ? "confirmed" : "actionRequired";
  const matchingStatusId: WorkspaceStatusId =
    matchingState === "complete"
      ? "confirmed"
      : matchingState === "active"
        ? "actionRequired"
        : matchingState === "blocked"
          ? "blocked"
          : "preparing";
  const editingStatusId: WorkspaceStatusId =
    editingState === "complete"
      ? "confirmed"
      : editingState === "active"
        ? "reviewRequired"
        : "preparing";
  const exportStatusId: WorkspaceStatusId =
    exportState === "active" ? "runnable" : exportState === "blocked" ? "blocked" : "preparing";

  const steps: WorkspacePageStep[] = [
    {
      id: "materials",
      order: 1,
      label: "素材",
      state: materialsState,
      statusId: materialsStatusId,
      stateText: statusLabel(materialsStatusId),
      headline:
        materialsState === "complete"
          ? "素材和绑定关系已齐备"
          : assetCount === 0
            ? "先导入原片、参考视频和弹幕 XML"
            : "补齐素材或完成 XML 绑定",
      detail: "导入原片素材、B 站参考素材和弹幕 XML，并把每个 XML 关联到对应的参考视频。",
      blockers: materialsBlockers
    },
    {
      id: "matching",
      order: 2,
      label: "匹配",
      state: matchingState,
      statusId: matchingStatusId,
      stateText: statusLabel(matchingStatusId),
      headline:
        matchingState === "complete"
          ? "智能分析已生成可编辑的时间关系"
          : "计算参考视频与每个原片的候选关系",
      detail:
        "这里只选择范围、运行自动分析并查看诊断摘要；播放、色块判断和边界修改统一交给下一步。",
      blockers: matchingBlockers
    },
    {
      id: "editing",
      order: 3,
      label: "编辑",
      state: editingState,
      statusId: editingStatusId,
      stateText: statusLabel(editingStatusId),
      headline:
        editingState === "complete"
          ? "时间关系已经播放检查并保存"
          : "播放并直接修正每条候选时间线",
      detail:
        "在同一工作台切换参考 A 与原片 B，操作双轨色块、风险热力图和边界；保存后才形成正式来源段。",
      blockers: editingBlockers
    },
    {
      id: "export",
      order: 4,
      label: "导出",
      state: exportState,
      statusId: exportStatusId,
      stateText: statusLabel(exportStatusId),
      headline:
        exportState === "active"
          ? "可以按原片分集导出修正后的弹幕 XML"
          : "完成时间线编辑并保存关系后再导出",
      detail: "按目标原片分组投影弹幕时间，为每集生成一个可重新解析验证的 XML 文件。",
      blockers: createExportBlockers(projection, exportableEpisodeCount)
    }
  ];

  const completeStepCount = steps.filter((step) => step.state === "complete").length;
  const recommended = pickRecommendedPage(steps);

  return {
    workflowMode,
    steps,
    completeStepCount,
    totalStepCount: steps.length,
    progressPercent: Math.round((completeStepCount / steps.length) * 100),
    recommendedPage: recommended.page,
    recommendedAction: recommended.action,
    liveSummary: `${assetCount} 个 XML · ${analyzedTargetCount}/${targetMedia.length} 个原片已分析 · ${confirmedTargetCount}/${targetMedia.length} 个关系已保存 · ${pendingMatchCandidateCount} 个待编辑`,
    projection,
    exportableEpisodeCount,
    analyzedTargetCount,
    confirmedTargetCount,
    pendingMatchCandidateCount,
    timelineExportReady: false
  };
}

function createXmlOnlyWorkspaceProgress(
  project: EditorProject,
  projection: SourceProjectionResult
): WorkspaceProgress {
  const assetCount = project.assets.length;
  const clipCount = project.clips.length;
  const hasAssets = assetCount > 0;
  const timelineExportReady = clipCount > 0;
  const steps: WorkspacePageStep[] = [
    {
      id: "materials",
      order: 1,
      label: "素材",
      state: hasAssets ? "complete" : "active",
      statusId: hasAssets ? "confirmed" : "preparing",
      stateText: statusLabel(hasAssets ? "confirmed" : "preparing"),
      headline: hasAssets ? "弹幕 XML 已准备好" : "导入要编辑的弹幕 XML",
      detail: "只编辑弹幕时不需要原片或参考视频；视频对齐工具可按需启用。",
      blockers: hasAssets ? [] : ["还没有导入弹幕 XML。"]
    },
    {
      id: "matching",
      order: 2,
      label: "匹配",
      state: hasAssets ? "complete" : "idle",
      statusId: hasAssets ? "confirmed" : "preparing",
      stateText: statusLabel(hasAssets ? "confirmed" : "preparing"),
      headline: "当前项目不需要智能匹配",
      detail: "没有导入视频对齐素材，因此会直接使用 XML 自身的时间轴。",
      blockers: []
    },
    {
      id: "editing",
      order: 3,
      label: "编辑",
      state: !hasAssets ? "idle" : timelineExportReady ? "complete" : "active",
      statusId: !hasAssets ? "preparing" : timelineExportReady ? "confirmed" : "actionRequired",
      stateText: statusLabel(
        !hasAssets ? "preparing" : timelineExportReady ? "confirmed" : "actionRequired"
      ),
      headline: timelineExportReady ? "可以直接编辑弹幕时间线" : "把弹幕放入时间线开始编辑",
      detail: "可调整整体偏移、片段位置、版本差异和单条弹幕，不会修改原始 XML。",
      blockers: hasAssets && !timelineExportReady ? ["已导入的 XML 还没有放入编辑时间线。"] : []
    },
    {
      id: "export",
      order: 4,
      label: "导出",
      state: timelineExportReady ? "active" : "idle",
      statusId: timelineExportReady ? "runnable" : "preparing",
      stateText: statusLabel(timelineExportReady ? "runnable" : "preparing"),
      headline: timelineExportReady ? "可以导出当前编辑时间线" : "完成弹幕时间线后再导出",
      detail: "导出前会重新生成并解析验证 XML；不要求导入任何视频素材。",
      blockers: timelineExportReady ? [] : ["时间线上还没有可导出的弹幕片段。"]
    }
  ];
  const completeStepCount = steps.filter((step) => step.state === "complete").length;
  const recommendedPage: WorkspacePageId = !hasAssets
    ? "materials"
    : !timelineExportReady
      ? "editing"
      : "export";

  return {
    workflowMode: "xml-only",
    steps,
    completeStepCount,
    totalStepCount: steps.length,
    progressPercent: Math.round((completeStepCount / steps.length) * 100),
    recommendedPage,
    recommendedAction: !hasAssets
      ? "导入弹幕 XML"
      : !timelineExportReady
        ? "开始编辑弹幕"
        : "预览并导出单个 XML",
    liveSummary: hasAssets
      ? `${assetCount} 个 XML · ${clipCount} 个时间线片段 · 无需视频匹配`
      : "尚未导入弹幕 XML · 视频素材为可选项",
    projection,
    exportableEpisodeCount: 0,
    analyzedTargetCount: 0,
    confirmedTargetCount: 0,
    pendingMatchCandidateCount: 0,
    timelineExportReady
  };
}

function createMaterialsBlockers(input: {
  assetCount: number;
  targetCount: number;
  referenceCount: number;
  unboundXmlCount: number;
}): string[] {
  const blockers: string[] = [];
  if (input.assetCount === 0) {
    blockers.push("还没有导入弹幕 XML。");
  }
  if (input.targetCount === 0) {
    blockers.push("还没有导入原片素材。");
  }
  if (input.referenceCount === 0) {
    blockers.push("还没有导入 B 站参考素材。");
  }
  if (input.assetCount > 0 && input.unboundXmlCount > 0) {
    blockers.push(`还有 ${input.unboundXmlCount} 个 XML 未关联参考视频。`);
  }
  return blockers;
}

function createMatchingBlockers(input: {
  materialsComplete: boolean;
  analyzedTargetCount: number;
  targetCount: number;
}): string[] {
  if (!input.materialsComplete) {
    return ["请先在素材页补齐导入和 XML 绑定。"];
  }
  const blockers: string[] = [];
  if (input.targetCount > 0 && input.analyzedTargetCount < input.targetCount) {
    blockers.push(
      `还有 ${input.targetCount - input.analyzedTargetCount} 个原片没有完成智能分析。`
    );
  }
  return blockers;
}

function createEditingBlockers(input: {
  confirmedTargetCount: number;
  targetCount: number;
  pendingCandidateCount: number;
}): string[] {
  const blockers: string[] = [];
  if (input.pendingCandidateCount > 0) {
    blockers.push(`还有 ${input.pendingCandidateCount} 条候选时间关系可采用，也可稍后修正。`);
  }
  if (input.targetCount > 0 && input.confirmedTargetCount < input.targetCount) {
    blockers.push(
      `还有 ${input.targetCount - input.confirmedTargetCount} 个原片没有保存时间关系。`
    );
  }
  return blockers;
}

function createExportBlockers(
  projection: SourceProjectionResult,
  exportableEpisodeCount: number
): string[] {
  if (projection.status === "blocked") {
    return projection.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
  }
  if (exportableEpisodeCount === 0) {
    return ["还没有可导出的分集弹幕，请先在匹配页完成来源段。"];
  }
  return [];
}

function resolveStepState(blockers: string[], hasStarted: boolean): WorkspaceStepState {
  if (blockers.length === 0 && hasStarted) {
    return "complete";
  }
  if (hasStarted || blockers.length > 0) {
    return blockers.length > 0 ? "active" : "complete";
  }
  return "active";
}

function resolveMatchingState(
  materialsState: WorkspaceStepState,
  blockers: string[],
  analyzedTargetCount: number,
  targetCount: number
): WorkspaceStepState {
  if (materialsState !== "complete") {
    return "idle";
  }
  if (targetCount > 0 && analyzedTargetCount >= targetCount && blockers.length === 0) {
    return "complete";
  }
  return "active";
}

function resolveEditingState(
  materialsState: WorkspaceStepState,
  matchingState: WorkspaceStepState,
  blockers: string[],
  analyzedTargetCount: number,
  confirmedTargetCount: number,
  targetCount: number
): WorkspaceStepState {
  if (materialsState !== "complete") {
    return "idle";
  }
  if (targetCount > 0 && confirmedTargetCount >= targetCount && blockers.length === 0) {
    return "complete";
  }
  if (analyzedTargetCount > 0 || matchingState === "complete") {
    return "active";
  }
  return "idle";
}

function resolveExportState(
  editingState: WorkspaceStepState,
  projection: SourceProjectionResult,
  exportableEpisodeCount: number
): WorkspaceStepState {
  if (projection.status !== "blocked" && exportableEpisodeCount > 0) {
    return "active";
  }
  if (editingState !== "complete") {
    return "idle";
  }
  if (projection.status === "blocked") {
    return "blocked";
  }
  if (
    exportableEpisodeCount > 0 &&
    (projection.status === "ready" || projection.status === "readyWithWarnings")
  ) {
    return "active";
  }
  if (editingState === "complete" && exportableEpisodeCount === 0) {
    return "blocked";
  }
  return "idle";
}

function pickRecommendedPage(steps: WorkspacePageStep[]): {
  page: WorkspacePageId;
  action: string;
} {
  const priority: WorkspacePageId[] = ["materials", "matching", "editing", "export"];
  for (const pageId of priority) {
    const step = steps.find((candidate) => candidate.id === pageId);
    if (!step) {
      continue;
    }
    if (step.state === "active" || step.state === "blocked") {
      const blocker = step.blockers[0];
      return {
        page: pageId,
        action: blocker ?? step.headline
      };
    }
  }
  const exportStep = steps.find((step) => step.id === "export");
  if (exportStep?.state === "active") {
    return { page: "export", action: "导出全部分集 XML" };
  }
  return { page: "editing", action: "播放并检查时间关系" };
}

export function createPageProgressHint(
  pageId: WorkspacePageId,
  progress: WorkspaceProgress
): string {
  const step = progress.steps.find((candidate) => candidate.id === pageId);
  if (!step) {
    return "";
  }
  if (step.blockers.length > 0) {
    return step.blockers[0];
  }
  if (step.state === "complete") {
    return step.headline;
  }
  return step.detail;
}
