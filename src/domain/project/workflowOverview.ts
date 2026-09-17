import type { AlignmentProposal } from "../alignment/types";
import { resolveProjectDanmakuEvents } from "../timeline/mapping";
import { createProjectHealthSummary } from "./health";
import { formatMediaBindingSource, formatMediaBindingTitle } from "./mediaBinding";
import {
  createProjectMatchAssessment,
  formatProjectMatchScore,
  type ProjectMatchAssessment
} from "./matchAssessment";
import type { EditorProject } from "./types";
import { createWorkspaceProgress } from "./workspaceProgress";
import { statusLabel, type WorkspaceStatusId } from "../shared/statusVocabulary";

export type WorkflowStageId = "materials" | "matching" | "editing" | "export";
export type WorkflowStageState = "complete" | "active" | "blocked" | "idle";
export type WorkflowActionId =
  | "import-video"
  | "import-xml"
  | "auto-arrange"
  | "review-matches"
  | "edit-relations"
  | "cleanup-edit-references"
  | "cleanup-missing-clips"
  | "save-project"
  | "export-xml";

export interface WorkflowMetric {
  label: string;
  value: string;
}

export interface WorkflowActionDescriptor {
  id: WorkflowActionId;
  label: string;
  detail: string;
  enabled: boolean;
  reason: string | null;
  tone: "primary" | "neutral" | "danger";
}

export interface WorkflowCapability {
  id: string;
  title: string;
  detail: string;
  visibleWhen: "always" | "with-source" | "with-timeline" | "with-alignment-proposal";
  stateText: string;
  active: boolean;
}

export interface WorkflowStage {
  id: WorkflowStageId;
  order: number;
  title: string;
  state: WorkflowStageState;
  statusId: WorkspaceStatusId;
  stateText: string;
  headline: string;
  detail: string;
  metrics: WorkflowMetric[];
  capabilityIds: string[];
  actionIds: WorkflowActionId[];
}

export interface WorkflowOverview {
  projectName: string;
  updatedAt: string;
  totalStageCount: number;
  completeStageCount: number;
  progressPercent: number;
  nextActionId: WorkflowActionId;
  nextActionLabel: string;
  liveSummary: string;
  stages: WorkflowStage[];
  actions: WorkflowActionDescriptor[];
  capabilities: WorkflowCapability[];
}

export function createWorkflowOverview(
  project: EditorProject,
  alignmentProposal: AlignmentProposal | null
): WorkflowOverview {
  const workspace = createWorkspaceProgress(project);
  const assetCount = project.assets.length;
  const clipCount = project.clips.length;
  const enabledEvents = resolveProjectDanmakuEvents(project).filter((event) => event.enabled);
  const health = createProjectHealthSummary(project);
  const matchAssessment = createProjectMatchAssessment(project);
  const targetCount = project.mediaLibrary.filter(
    (media) => media.role === "targetOriginal"
  ).length;
  const referenceCount = project.mediaLibrary.filter(
    (media) => media.role === "bilibiliReference"
  ).length;
  const contentSegmentCount = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "content"
  ).length;
  const canExportProjection =
    workspace.exportableEpisodeCount > 0 &&
    (workspace.projection.status === "ready" ||
      workspace.projection.status === "readyWithWarnings");
  const canExportTimeline = enabledEvents.length > 0 && health.status !== "blocked";
  const hasTimeline = clipCount > 0;
  const hasAlignmentWork =
    project.syncAnchors.length > 0 ||
    project.cutMarkers.length > 0 ||
    Boolean(alignmentProposal) ||
    contentSegmentCount > 0;
  const xmlOnlyWorkflow = workspace.workflowMode === "xml-only";

  const actions: WorkflowActionDescriptor[] = [
    {
      id: "import-video",
      label: xmlOnlyWorkflow ? "添加视频对齐素材（可选）" : "去素材页导入视频",
      detail:
        targetCount > 0 || referenceCount > 0
          ? `已导入 ${targetCount} 个原片、${referenceCount} 个参考视频。`
          : xmlOnlyWorkflow
            ? "只有要把弹幕对齐到另一份视频时才需要。"
            : "在素材页导入原片素材和 B 站参考素材。",
      enabled: true,
      reason: null,
      tone: "neutral"
    },
    {
      id: "import-xml",
      label: "去素材页导入 XML",
      detail:
        assetCount > 0
          ? `已导入 ${formatCount(assetCount)} 个 XML。`
          : xmlOnlyWorkflow
            ? "在素材页导入弹幕 XML 即可开始编辑。"
            : "在素材页导入 Bilibili XML 并绑定参考视频。",
      enabled: true,
      reason: null,
      tone: "primary"
    },
    {
      id: "auto-arrange",
      label: "按顺序放入时间轴",
      detail: "编辑页可选操作：把弹幕按分 P 顺序放入时间轴以便预览微调。",
      enabled: assetCount > 0,
      reason: assetCount > 0 ? null : "需要先导入 XML。",
      tone: "neutral"
    },
    {
      id: "review-matches",
      label: xmlOnlyWorkflow ? "智能匹配（当前可跳过）" : "去匹配页运行智能分析",
      detail:
        workspace.analyzedTargetCount < targetCount
          ? `${formatCount(workspace.analyzedTargetCount)} / ${formatCount(targetCount)} 个原片已有分析结果；匹配页只负责计算和诊断。`
          : `${formatCount(targetCount)} 个原片均已有分析结果；可直接进入编辑页播放和校正。`,
      enabled: !xmlOnlyWorkflow && assetCount > 0 && targetCount > 0 && referenceCount > 0,
      reason:
        xmlOnlyWorkflow
          ? "当前项目直接使用 XML 自身时间轴，不需要智能匹配。"
          : assetCount === 0 || targetCount === 0 || referenceCount === 0
          ? "请先在素材页导入 XML、B 站参考素材和原片素材。"
          : null,
      tone: "primary"
    },
    {
      id: "edit-relations",
      label: xmlOnlyWorkflow ? "去编辑页编辑弹幕" : "去编辑页播放和校正",
      detail:
        workspace.pendingMatchCandidateCount > 0
          ? `有 ${formatCount(workspace.pendingMatchCandidateCount)} 条候选时间线待处理；播放、色块判断、边界修改和保存都在编辑页完成。`
          : `${formatCount(workspace.confirmedTargetCount)} / ${formatCount(targetCount)} 个时间关系已保存。`,
      enabled: xmlOnlyWorkflow ? assetCount > 0 : workspace.analyzedTargetCount > 0,
      reason:
        xmlOnlyWorkflow
          ? assetCount > 0
            ? null
            : "请先导入弹幕 XML。"
          : workspace.analyzedTargetCount > 0
          ? null
          : "请先在匹配页为至少一个原片生成分析候选。",
      tone: "primary"
    },
    {
      id: "cleanup-edit-references",
      label: "清理失效调整",
      detail: "移除已经找不到对应弹幕的禁用和微调记录。",
      enabled: health.metrics.orphanedEditReferenceCount > 0,
      reason: health.metrics.orphanedEditReferenceCount > 0 ? null : "当前没有失效调整记录。",
      tone: "neutral"
    },
    {
      id: "cleanup-missing-clips",
      label: "移除缺失片段",
      detail: "移除找不到原始 XML 的时间轴片段。",
      enabled: health.metrics.missingAssetClipCount > 0,
      reason: health.metrics.missingAssetClipCount > 0 ? null : "当前没有缺失片段。",
      tone: "danger"
    },
    {
      id: "save-project",
      label: "保存项目",
      detail: "导出项目 JSON，只保存媒体引用和编辑状态。",
      enabled: true,
      reason: null,
      tone: "neutral"
    },
    {
      id: "export-xml",
      label: xmlOnlyWorkflow ? "去导出页导出 XML" : "去导出页导出分集 XML",
      detail: canExportProjection
        ? `可按 ${formatCount(workspace.exportableEpisodeCount)} 个原片分集导出。`
        : canExportTimeline
          ? `也可导出编辑时间轴上的 ${formatCount(enabledEvents.length)} 条弹幕（单文件）。`
          : "完成匹配并建立来源段后再导出。",
      enabled: canExportProjection || canExportTimeline,
      reason: createExportReason(
        canExportProjection,
        canExportTimeline,
        workspace.recommendedAction
      ),
      tone: "primary"
    }
  ];

  const materialsStep = workspace.steps.find((step) => step.id === "materials");
  const matchingStep = workspace.steps.find((step) => step.id === "matching");
  const editingStep = workspace.steps.find((step) => step.id === "editing");
  const exportStep = workspace.steps.find((step) => step.id === "export");

  const stages: WorkflowStage[] = [
    {
      id: "materials",
      order: 1,
      title: "素材",
      state: materialsStep?.state ?? "active",
      statusId: materialsStep?.statusId ?? "actionRequired",
      stateText: materialsStep?.stateText ?? statusLabel("actionRequired"),
      headline: materialsStep?.headline ?? "导入并关联素材",
      detail: materialsStep?.detail ?? "",
      metrics: [
        { label: "原片素材", value: `${formatCount(targetCount)} 个` },
        { label: "B 站参考", value: `${formatCount(referenceCount)} 个` },
        { label: "XML", value: `${formatCount(assetCount)} 个` },
        {
          label: "兼容绑定",
          value: project.mediaBinding ? formatMediaBindingTitle(project.mediaBinding) : "未使用"
        }
      ],
      capabilityIds: [
        "multi-media-library",
        "xml-binding",
        "raw-xml-safe",
        "target-media",
        "match-score"
      ],
      actionIds: ["import-xml", "import-video"]
    },
    {
      id: "matching",
      order: 2,
      title: "匹配",
      state: matchingStep?.state ?? "idle",
      statusId: matchingStep?.statusId ?? "preparing",
      stateText: matchingStep?.stateText ?? statusLabel("preparing"),
      headline: matchingStep?.headline ?? "建立参考视频与原片的对应关系",
      detail: matchingStep?.detail ?? "",
      metrics: [
        {
          label: "已分析原片",
          value: `${formatCount(workspace.analyzedTargetCount)} / ${formatCount(targetCount)}`
        },
        {
          label: "候选时间线",
          value: `${formatCount(workspace.pendingMatchCandidateCount)} 条`
        },
        {
          label: "已保存关系",
          value: `${formatCount(workspace.confirmedTargetCount)} 个`
        },
        { label: "匹配评分", value: createMatchMetricValue(matchAssessment, assetCount) }
      ],
      capabilityIds: [
        "source-segments",
        "alignment-proposal",
        "cut-hints",
        "anchor-calibration"
      ],
      actionIds: ["review-matches"]
    },
    {
      id: "editing",
      order: 3,
      title: "编辑",
      state: editingStep?.state ?? "idle",
      statusId: editingStep?.statusId ?? "preparing",
      stateText: editingStep?.stateText ?? statusLabel("preparing"),
      headline: editingStep?.headline ?? "时间轴预览与微调",
      detail: editingStep?.detail ?? "",
      metrics: [
        {
          label: "待编辑关系",
          value: `${formatCount(workspace.pendingMatchCandidateCount)} 条`
        },
        { label: "已保存关系", value: `${formatCount(workspace.confirmedTargetCount)} 个` },
        { label: "高级时间轴片段", value: `${formatCount(clipCount)} 个` },
        {
          label: "单条微调",
          value: `${formatCount(Object.keys(project.itemTimeAdjustments).length)} 条`
        }
      ],
      capabilityIds: ["alignment-review", "timeline-edit", "item-adjustment", "history"],
      actionIds: ["edit-relations", "auto-arrange"]
    },
    {
      id: "export",
      order: 4,
      title: "导出",
      state: exportStep?.state ?? "idle",
      statusId: exportStep?.statusId ?? "preparing",
      stateText: exportStep?.stateText ?? statusLabel("preparing"),
      headline: exportStep?.headline ?? "按原片分集导出修正弹幕",
      detail: exportStep?.detail ?? "",
      metrics: [
        {
          label: "分集导出",
          value: canExportProjection
            ? `${formatCount(workspace.exportableEpisodeCount)} 个原片`
            : "未就绪"
        },
        { label: "投影状态", value: projectionStatusLabel(workspace.projection.status) },
        { label: "健康检查", value: health.statusLabel },
        {
          label: "时间轴导出",
          value: hasTimeline ? `${formatCount(enabledEvents.length)} 条` : "未使用"
        }
      ],
      capabilityIds: ["projection-export", "project-health", "xml-export", "export-report"],
      actionIds: [
        "export-xml",
        "save-project",
        "cleanup-edit-references",
        "cleanup-missing-clips"
      ]
    }
  ];

  const completeStageCount = stages.filter((stage) => stage.state === "complete").length;
  const nextAction = pickNextAction(workspace.recommendedPage, stages, actions);

  return {
    projectName: project.name,
    updatedAt: project.updatedAt,
    totalStageCount: stages.length,
    completeStageCount,
    progressPercent: workspace.progressPercent,
    nextActionId: nextAction.id,
    nextActionLabel: nextAction.label,
    liveSummary: workspace.liveSummary,
    stages,
    actions,
    capabilities: createCapabilities({
      hasAssets: assetCount > 0,
      hasTimeline,
      hasAlignmentProposal: Boolean(alignmentProposal),
      hasAlignmentWork,
      hasContentSegments: contentSegmentCount > 0,
      canExportProjection,
      matchAssessment,
      project,
      pendingRelationCount: workspace.pendingMatchCandidateCount,
      confirmedRelationCount: workspace.confirmedTargetCount
    })
  };
}

function pickNextAction(
  recommendedPage: WorkflowStageId,
  stages: WorkflowStage[],
  actions: WorkflowActionDescriptor[]
): WorkflowActionDescriptor {
  const actionMap = new Map(actions.map((action) => [action.id, action]));
  const pageActionMap: Record<WorkflowStageId, WorkflowActionId> = {
    materials: "import-xml",
    matching: "review-matches",
    editing: "edit-relations",
    export: "export-xml"
  };
  const preferred = actionMap.get(pageActionMap[recommendedPage]);
  if (preferred?.enabled) {
    return preferred;
  }
  for (const stage of stages) {
    if (stage.state === "complete") {
      continue;
    }
    const enabledAction = stage.actionIds
      .map((actionId) => actionMap.get(actionId))
      .find((action): action is WorkflowActionDescriptor => Boolean(action?.enabled));
    if (enabledAction) {
      return enabledAction;
    }
  }
  return actionMap.get("save-project") ?? actions[0];
}

function createExportReason(
  canExportProjection: boolean,
  canExportTimeline: boolean,
  recommendedAction: string
): string | null {
  if (canExportProjection) {
    return null;
  }
  if (canExportTimeline) {
    return "来源段投影未就绪，可先导出编辑时间轴单文件，或继续完成匹配。";
  }
  return recommendedAction;
}

function createMatchMetricValue(
  assessment: ProjectMatchAssessment,
  assetCount: number
): string {
  if (assetCount === 0) {
    return "等待 XML";
  }
  if (assessment.targetTitle === "未绑定目标原片") {
    return "多集模式";
  }
  return `${formatProjectMatchScore(assessment.score)} / ${assessment.conclusionLabel}`;
}

function projectionStatusLabel(
  status: ReturnType<typeof createWorkspaceProgress>["projection"]["status"]
): string {
  if (status === "empty") {
    return statusLabel("preparing");
  }
  if (status === "blocked") {
    return statusLabel("blocked");
  }
  if (status === "readyWithWarnings") {
    return statusLabel("reviewRequired");
  }
  return statusLabel("runnable");
}

function createCapabilities({
  hasAssets,
  hasTimeline,
  hasAlignmentProposal,
  hasAlignmentWork,
  hasContentSegments,
  canExportProjection,
  matchAssessment,
  project,
  pendingRelationCount,
  confirmedRelationCount
}: {
  hasAssets: boolean;
  hasTimeline: boolean;
  hasAlignmentProposal: boolean;
  hasAlignmentWork: boolean;
  hasContentSegments: boolean;
  canExportProjection: boolean;
  matchAssessment: ProjectMatchAssessment;
  project: EditorProject;
  pendingRelationCount: number;
  confirmedRelationCount: number;
}): WorkflowCapability[] {
  return [
    {
      id: "multi-media-library",
      title: "多媒体素材库",
      detail: "分别管理原片素材和 B 站参考素材，使用稳定 ID 持久关联。",
      visibleWhen: "always",
      stateText: `${project.mediaLibrary.length} 个素材`,
      active: project.mediaLibrary.length > 0
    },
    {
      id: "xml-binding",
      title: "XML 绑定参考视频",
      detail: "每个弹幕 XML 绑定一个 B 站参考素材，作为来源段时间轴依据。",
      visibleWhen: "with-source",
      stateText: hasAssets ? "可绑定" : "等待 XML",
      active: project.danmakuSourceBindings.length > 0
    },
    {
      id: "raw-xml-safe",
      title: "原始 XML 安全",
      detail: "所有修改通过项目状态和导出结果表达，不直接改写源文件。",
      visibleWhen: "always",
      stateText: "始终启用",
      active: true
    },
    {
      id: "target-media",
      title: "兼容单目标绑定",
      detail: project.mediaBinding
        ? formatMediaBindingSource(project.mediaBinding)
        : "旧项目可继续使用单目标绑定；多集推荐用来源段。",
      visibleWhen: "always",
      stateText: project.mediaBinding ? "已绑定" : "未使用",
      active: Boolean(project.mediaBinding)
    },
    {
      id: "match-score",
      title: "匹配评分",
      detail: `${matchAssessment.conclusionLabel}：${matchAssessment.headline}`,
      visibleWhen: "always",
      stateText:
        project.mediaBinding && hasAssets
          ? formatProjectMatchScore(matchAssessment.score)
          : "多集模式",
      active: Boolean(project.mediaBinding && hasAssets)
    },
    {
      id: "source-segments",
      title: "弹幕来源内容段",
      detail: "标出参考视频的哪一段对应哪个原片，支持忽略范围和段内删减修正。",
      visibleWhen: "with-source",
      stateText: hasContentSegments ? `${project.danmakuSourceSegments.length} 个段` : "待创建",
      active: hasContentSegments
    },
    {
      id: "alignment-proposal",
      title: "音频对齐提案",
      detail: "匹配页运行自动分析并生成候选；人工播放和修改统一在编辑页。",
      visibleWhen: "with-source",
      stateText: hasAlignmentProposal ? "有候选" : statusLabel("runnable"),
      active: hasAlignmentProposal
    },
    {
      id: "cut-hints",
      title: "疑似删减扫描",
      detail: "按弹幕文本关键词辅助发现可能需要补时的位置。",
      visibleWhen: "with-source",
      stateText: hasAssets ? "可扫描" : "等待 XML",
      active: hasAssets
    },
    {
      id: "anchor-calibration",
      title: "人工同步线索",
      detail: "用对应点文本生成同步线索和版本差异候选。",
      visibleWhen: "with-source",
      stateText:
        project.syncAnchors.length > 0
          ? `${formatCount(project.syncAnchors.length)} 个`
          : "可录入",
      active: project.syncAnchors.length > 0
    },
    {
      id: "alignment-review",
      title: "双轨时间关系编辑",
      detail: "编辑页统一提供 A/B 播放、结论色块、风险热力图、边界调整和关系保存。",
      visibleWhen: "with-source",
      stateText:
        pendingRelationCount > 0
          ? `${formatCount(pendingRelationCount)} 条待处理`
          : confirmedRelationCount > 0
            ? `${formatCount(confirmedRelationCount)} 条已保存`
            : "等待候选",
      active: pendingRelationCount > 0 || confirmedRelationCount > 0
    },
    {
      id: "timeline-edit",
      title: "高级弹幕时间线",
      detail: "高级区继续支持弹幕片段排布、切割、合并和缩放查看。",
      visibleWhen: "with-source",
      stateText: hasTimeline ? `${formatCount(project.clips.length)} 个片段` : "可选",
      active: hasTimeline
    },
    {
      id: "item-adjustment",
      title: "单条弹幕微调",
      detail: "可禁用弹幕或以毫秒调整单条最终时间。",
      visibleWhen: "with-timeline",
      stateText: `${formatCount(Object.keys(project.itemTimeAdjustments).length)} 条微调`,
      active: Object.keys(project.itemTimeAdjustments).length > 0
    },
    {
      id: "history",
      title: "撤销 / 重做",
      detail: "片段、来源段、同步线索、版本差异等操作进入历史。",
      visibleWhen: "always",
      stateText: "可用",
      active: true
    },
    {
      id: "projection-export",
      title: "按原片分集导出",
      detail: "把弹幕从参考时间轴投影到每个原片，每集一个 XML。",
      visibleWhen: "with-source",
      stateText: statusLabel(canExportProjection ? "runnable" : "preparing"),
      active: canExportProjection
    },
    {
      id: "project-health",
      title: "导出前检查",
      detail: "汇总导出阻断、负时间、重复 ID 和媒体重连风险。",
      visibleWhen: "always",
      stateText: "实时计算",
      active: true
    },
    {
      id: "xml-export",
      title: "XML 导出验证",
      detail: "导出前重新序列化并解析验证生成的 XML。",
      visibleWhen: "with-source",
      stateText: canExportProjection || hasTimeline ? "导出前执行" : "等待就绪",
      active: canExportProjection || hasTimeline
    },
    {
      id: "export-report",
      title: "导出报告",
      detail: "导出检查报告和版本差异明细，辅助验收。",
      visibleWhen: "with-timeline",
      stateText: hasAlignmentWork ? "随导出生成" : "按需",
      active: hasAlignmentWork
    }
  ];
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}
