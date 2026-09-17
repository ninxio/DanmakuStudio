import { findDanmakuSourceBinding } from "./mediaLibrary";
import type { EditorProject } from "./types";
import {
  createWorkspaceProgress,
  type WorkspacePageId,
  type WorkspacePageStep,
  type WorkspaceProgress
} from "./workspaceProgress";
import {
  statusLabel,
  type WorkspaceStatusId
} from "../shared/statusVocabulary";

export type UsabilityStepState =
  | "complete"
  | "current"
  | "attention"
  | "available"
  | "upcoming";

export type UsabilityIssueSeverity = "review" | "blocking";

export interface UsabilityProjectSummary {
  originalCount: number;
  referenceCount: number;
  xmlCount: number;
  boundXmlCount: number;
  matchedEpisodeCount: number;
  totalEpisodeCount: number;
  reviewIssueCount: number;
  exportableEpisodeCount: number;
  materialSummary: string;
  resultSummary: string;
}

export interface UsabilityStepViewModel {
  id: WorkspacePageId;
  order: number;
  label: string;
  state: UsabilityStepState;
  statusId: WorkspaceStatusId;
  stateLabel: string;
  headline: string;
  detail: string;
  issueCount: number;
}

export interface UsabilityIssueViewModel {
  id: string;
  stepId: WorkspacePageId;
  severity: UsabilityIssueSeverity;
  title: string;
  detail: string;
}

export interface UsabilityPrimaryAction {
  id: "add-materials" | "review-matches" | "calibrate" | "export";
  stepId: WorkspacePageId;
  label: string;
  detail: string;
}

export interface UsabilityViewModel {
  projectName: string;
  workflowMode: WorkspaceProgress["workflowMode"];
  currentStepId: WorkspacePageId;
  summary: UsabilityProjectSummary;
  steps: UsabilityStepViewModel[];
  issues: UsabilityIssueViewModel[];
  primaryAction: UsabilityPrimaryAction;
}

const STEP_LABELS: Record<WorkspacePageId, string> = {
  materials: "素材",
  matching: "智能匹配",
  editing: "编辑",
  export: "导出"
};

/**
 * 把现有项目状态翻译为新外壳使用的用户语言。
 *
 * 本层只消费现有 workspace progress 和项目事实，不重新判断对齐是否可信、
 * TimeMap 是否可确认或 XML 是否允许导出。
 */
export function createUsabilityViewModel(
  project: EditorProject,
  progress: WorkspaceProgress = createWorkspaceProgress(project)
): UsabilityViewModel {
  const originalCount = project.mediaLibrary.filter(
    (media) => media.role === "targetOriginal"
  ).length;
  const referenceCount = project.mediaLibrary.filter(
    (media) => media.role === "bilibiliReference"
  ).length;
  const xmlCount = project.assets.length;
  const boundXmlCount = project.assets.filter((asset) =>
    findDanmakuSourceBinding(project.danmakuSourceBindings, asset.id)
  ).length;
  const issues = createIssues(progress);
  const currentStepId = progress.recommendedPage;
  const summary: UsabilityProjectSummary = {
    originalCount,
    referenceCount,
    xmlCount,
    boundXmlCount,
    matchedEpisodeCount: progress.confirmedTargetCount,
    totalEpisodeCount: originalCount,
    reviewIssueCount: issues.length,
    exportableEpisodeCount: progress.exportableEpisodeCount,
    materialSummary: createMaterialSummary(
      originalCount,
      referenceCount,
      xmlCount,
      progress.workflowMode
    ),
    resultSummary: createResultSummary(progress, issues.length)
  };

  return {
    projectName: project.name,
    workflowMode: progress.workflowMode,
    currentStepId,
    summary,
    steps: progress.steps.map((step) =>
      createStepViewModel(step, currentStepId, issues, progress.workflowMode)
    ),
    issues,
    primaryAction: createPrimaryAction(currentStepId, summary, progress)
  };
}

function createStepViewModel(
  step: WorkspacePageStep,
  currentStepId: WorkspacePageId,
  issues: UsabilityIssueViewModel[],
  workflowMode: WorkspaceProgress["workflowMode"]
): UsabilityStepViewModel {
  const state = translateStepState(step, currentStepId);
  const statusId = usabilityStepStatusId(state);
  return {
    id: step.id,
    order: step.order,
    label: STEP_LABELS[step.id],
    state,
    statusId,
    stateLabel: statusLabel(statusId),
    headline: translateHeadline(step, workflowMode),
    detail: translateDetail(step, workflowMode),
    issueCount: issues.filter((issue) => issue.stepId === step.id).length
  };
}

function translateStepState(
  step: WorkspacePageStep,
  currentStepId: WorkspacePageId
): UsabilityStepState {
  if (step.state === "complete") {
    return "complete";
  }
  if (step.state === "blocked") {
    return "attention";
  }
  if (step.id === currentStepId) {
    return "current";
  }
  if (step.state === "active") {
    return "available";
  }
  return "upcoming";
}

function usabilityStepStatusId(state: UsabilityStepState): WorkspaceStatusId {
  if (state === "complete") return "confirmed";
  if (state === "current") return "actionRequired";
  if (state === "attention") return "blocked";
  if (state === "available") return "runnable";
  return "preparing";
}

function translateHeadline(
  step: WorkspacePageStep,
  workflowMode: WorkspaceProgress["workflowMode"]
): string {
  if (workflowMode === "xml-only") {
    return step.headline;
  }
  if (step.id === "materials") {
    return step.state === "complete" ? "素材已经准备好" : "准备原片和弹幕来源";
  }
  if (step.id === "matching") {
    return step.state === "complete"
      ? "每集都已有智能分析候选"
      : "计算参考视频与原片的候选关系";
  }
  if (step.id === "editing") {
    return step.state === "complete"
      ? "时间关系已保留，可随时修正"
      : "查看匹配覆盖，采用结果并导出";
  }
  return step.state === "active" ? "可以导出分集 XML" : "检查后导出 XML";
}

function translateDetail(
  step: WorkspacePageStep,
  workflowMode: WorkspaceProgress["workflowMode"]
): string {
  if (workflowMode === "xml-only") {
    return step.detail;
  }
  if (step.id === "materials") {
    return "添加原片、参考视频和弹幕 XML，并确认每个 XML 的来源。";
  }
  if (step.id === "matching") {
    return "选择计算范围并运行自动分析；这里只展示结果摘要和诊断。";
  }
  if (step.id === "editing") {
    return "先查看各集覆盖并采用可用结果；发现错位后再进入精确修正。";
  }
  return "确认文件名、保存位置和风险提示，然后按原片分集导出。";
}

function createIssues(progress: WorkspaceProgress): UsabilityIssueViewModel[] {
  const issues: UsabilityIssueViewModel[] = [];
  const seen = new Set<string>();
  const materials = progress.steps.find((step) => step.id === "materials");
  const matching = progress.steps.find((step) => step.id === "matching");
  const editing = progress.steps.find((step) => step.id === "editing");
  appendStepBlockers(issues, seen, materials, "review");

  if (materials?.state === "complete") {
    appendStepBlockers(
      issues,
      seen,
      matching,
      matching?.state === "blocked" ? "blocking" : "review"
    );
  }

  if (matching?.state === "complete") {
    appendStepBlockers(
      issues,
      seen,
      editing,
      editing?.state === "blocked" ? "blocking" : "review"
    );
  }

  if (progress.pendingMatchCandidateCount > 0) {
    appendIssue(issues, seen, {
      id: "editing-pending-results",
      stepId: "editing",
      severity: "review",
      title: `${progress.pendingMatchCandidateCount} 条候选时间线需要编辑`,
      detail: "自动分析只生成候选；播放检查、色块判断和边界调整都在编辑页完成。"
    });
  }

  if (
    progress.workflowMode === "media-alignment" &&
    materials?.state === "complete" &&
    matching?.state !== "idle"
  ) {
    for (const issue of progress.projection.issues) {
      appendIssue(issues, seen, {
        id: `export-${issue.id}`,
        stepId: "export",
        severity: issue.severity === "error" ? "blocking" : "review",
        title: issue.severity === "error" ? "导出前需要处理" : "导出时请留意",
        detail: issue.message
      });
    }
  }

  return issues;
}

function appendStepBlockers(
  issues: UsabilityIssueViewModel[],
  seen: Set<string>,
  step: WorkspacePageStep | undefined,
  severity: UsabilityIssueSeverity
): void {
  if (!step) {
    return;
  }
  step.blockers.forEach((blocker, index) => {
    appendIssue(issues, seen, {
      id: `${step.id}-blocker-${index + 1}`,
      stepId: step.id,
      severity,
      title: createBlockerTitle(step.id, blocker),
      detail: blocker
    });
  });
}

function appendIssue(
  issues: UsabilityIssueViewModel[],
  seen: Set<string>,
  issue: UsabilityIssueViewModel
): void {
  const key = `${issue.stepId}:${issue.detail}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  issues.push(issue);
}

function createBlockerTitle(stepId: WorkspacePageId, detail: string): string {
  if (stepId === "materials") {
    if (detail.includes("原片")) {
      return "还需要添加原片";
    }
    if (detail.includes("参考素材")) {
      return "还需要添加参考视频";
    }
    if (detail.includes("XML")) {
      return detail.includes("未关联") ? "需要确认弹幕来源" : "还需要添加弹幕 XML";
    }
    return "素材还没有准备好";
  }
  if (stepId === "matching") {
    return "还有分集没有完成匹配";
  }
  if (stepId === "editing") {
    return "还有时间线需要编辑确认";
  }
  return "导出前需要处理";
}

function createMaterialSummary(
  originalCount: number,
  referenceCount: number,
  xmlCount: number,
  workflowMode: WorkspaceProgress["workflowMode"]
): string {
  if (originalCount === 0 && referenceCount === 0 && xmlCount === 0) {
    return "还没有添加素材";
  }
  if (workflowMode === "xml-only") {
    return `${xmlCount} 个 XML · 视频素材未启用`;
  }
  return `${originalCount} 集原片 · ${referenceCount} 个参考视频 · ${xmlCount} 个 XML`;
}

function createResultSummary(progress: WorkspaceProgress, issueCount: number): string {
  if (issueCount > 0) {
    return `${issueCount} 项需要处理`;
  }
  if (progress.exportableEpisodeCount > 0) {
    return `${progress.exportableEpisodeCount} 集可以导出`;
  }
  if (progress.timelineExportReady) {
    return "当前时间线可以导出";
  }
  if (progress.confirmedTargetCount > 0) {
    return `${progress.confirmedTargetCount} 集已经匹配`;
  }
  return "等待开始";
}

function createPrimaryAction(
  stepId: WorkspacePageId,
  summary: UsabilityProjectSummary,
  progress: WorkspaceProgress
): UsabilityPrimaryAction {
  if (progress.workflowMode === "xml-only") {
    if (stepId === "materials") {
      return {
        id: "add-materials",
        stepId,
        label: "导入弹幕 XML",
        detail: "只编辑弹幕时无需导入视频。"
      };
    }
    if (stepId === "editing") {
      return {
        id: "calibrate",
        stepId,
        label: "开始编辑弹幕",
        detail: "把 XML 放入时间线后可调整片段、偏移和单条弹幕。"
      };
    }
    return {
      id: "export",
      stepId: "export",
      label: "预览并导出 XML",
      detail: "导出前会重新生成并解析验证 XML。"
    };
  }
  if (stepId === "materials") {
    return {
      id: "add-materials",
      stepId,
      label:
        summary.xmlCount > summary.boundXmlCount
          ? "确认弹幕来源"
          : "添加素材",
      detail: "准备原片、参考视频和弹幕 XML。"
    };
  }
  if (stepId === "matching") {
    return {
      id: "review-matches",
      stepId,
      label: "开始智能匹配",
      detail: "系统会批量计算候选关系；人工修改统一在下一步进行。"
    };
  }
  if (stepId === "editing") {
    const pendingCount = progress.pendingMatchCandidateCount;
    return {
      id: "calibrate",
      stepId,
      label: pendingCount > 0 ? `编辑 ${pendingCount} 条候选时间线` : "进入时间线编辑",
      detail: "播放参考与原片，并直接操作双轨色块、风险热力图和分段边界。"
    };
  }
  return {
    id: "export",
    stepId,
    label: `导出 ${summary.exportableEpisodeCount} 集 XML`,
    detail: "导出前仍会执行完整性和 XML 重新解析检查。"
  };
}
