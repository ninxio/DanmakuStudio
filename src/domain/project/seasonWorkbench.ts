import type { BatchMergePlan } from "../danmaku/batchMerge";
import { statusLabel, type WorkspaceStatusId } from "../shared/statusVocabulary";
import type { EditorProject } from "./types";

export type SeasonWorkbenchStepState = "complete" | "active" | "blocked" | "idle";

export interface SeasonWorkbenchMetric {
  label: string;
  value: string;
}

export interface SeasonWorkbenchStep {
  id: "source" | "target" | "split" | "alignment" | "export";
  label: string;
  state: SeasonWorkbenchStepState;
  statusId: WorkspaceStatusId;
  stateText: string;
  detail: string;
}

export interface SeasonWorkbenchSummary {
  statusId: WorkspaceStatusId;
  statusLabel: string;
  headline: string;
  nextActionLabel: string;
  metrics: SeasonWorkbenchMetric[];
  steps: SeasonWorkbenchStep[];
}

export function createSeasonWorkbenchSummary(
  project: EditorProject,
  plan: BatchMergePlan,
  warnings: readonly string[]
): SeasonWorkbenchSummary {
  const hasAssets = project.assets.length > 0;
  const hasTarget = Boolean(project.mediaBinding);
  const hasEpisodes = plan.episodes.length > 0;
  const hasWarnings = warnings.length > 0 || plan.diagnostics.some((diagnostic) => diagnostic.includes("无法"));
  const hasAlignment = project.cutMarkers.length > 0 || project.syncAnchors.length > 0 || Boolean(project.alignmentProposal);
  const canExport = hasEpisodes && !hasWarnings;
  const sourceStatusId: WorkspaceStatusId = hasAssets ? "confirmed" : "preparing";
  const targetStatusId: WorkspaceStatusId = hasTarget
    ? "confirmed"
    : hasAssets
      ? "runnable"
      : "preparing";
  const splitStatusId: WorkspaceStatusId =
    hasEpisodes && !hasWarnings ? "confirmed" : hasAssets ? "actionRequired" : "preparing";
  const alignmentStatusId: WorkspaceStatusId = hasAlignment
    ? "confirmed"
    : hasTarget && hasEpisodes
      ? "reviewRequired"
      : "preparing";
  const exportStatusId: WorkspaceStatusId = canExport
    ? "runnable"
    : hasEpisodes
      ? "blocked"
      : "preparing";
  const steps: SeasonWorkbenchStep[] = [
    {
      id: "source",
      label: "导入 XML",
      state: hasAssets ? "complete" : "active",
      statusId: sourceStatusId,
      stateText: statusLabel(sourceStatusId),
      detail: hasAssets ? `已导入 ${project.assets.length} 个 XML。` : "先导入一季或一组 B 站 XML。"
    },
    {
      id: "target",
      label: "绑定目标原片",
      state: hasTarget ? "complete" : hasAssets ? "active" : "idle",
      statusId: targetStatusId,
      stateText: statusLabel(targetStatusId),
      detail: hasTarget ? "后续评分、对齐和复核会读取同一个目标来源。" : "绑定本地文件或 Emby 条目作为完整版目标。"
    },
    {
      id: "split",
      label: "生成分集草案",
      state: hasEpisodes && !hasWarnings ? "complete" : hasAssets ? "active" : "blocked",
      statusId: splitStatusId,
      stateText: statusLabel(splitStatusId),
      detail: hasEpisodes
        ? `当前规则可生成 ${plan.episodes.length} 个分集 XML。`
        : "按文件名、Emby 时长或手动切点生成分集草案。"
    },
    {
      id: "alignment",
      label: "复核版本差异",
      state: hasAlignment ? "complete" : hasTarget && hasEpisodes ? "active" : "idle",
      statusId: alignmentStatusId,
      stateText: statusLabel(alignmentStatusId),
      detail: hasAlignment
        ? `已有 ${project.cutMarkers.length} 个版本差异、${project.syncAnchors.length} 个同步锚点。`
        : "有删减或错位时，再运行对齐或手动标记版本差异。"
    },
    {
      id: "export",
      label: "导出分集 XML",
      state: canExport ? "active" : hasEpisodes ? "blocked" : "idle",
      statusId: exportStatusId,
      stateText: statusLabel(exportStatusId),
      detail: canExport ? "可使用现有导出按钮生成分集 XML。" : "导出前会重新序列化并验证每个 XML。"
    }
  ];
  const statusId = createStatusId(hasAssets, hasTarget, hasEpisodes, canExport);
  return {
    statusId,
    statusLabel: statusLabel(statusId),
    headline: createHeadline(hasAssets, hasTarget, hasEpisodes, canExport),
    nextActionLabel: createNextActionLabel(steps),
    metrics: [
      { label: "XML", value: `${project.assets.length} 个` },
      { label: "目标原片", value: hasTarget ? "已绑定" : "未绑定" },
      { label: "输出", value: `${plan.episodes.length} 个` },
      { label: "版本差异", value: `${project.cutMarkers.length} 个` }
    ],
    steps
  };
}

function createStatusId(
  hasAssets: boolean,
  hasTarget: boolean,
  hasEpisodes: boolean,
  canExport: boolean
): WorkspaceStatusId {
  if (canExport && hasTarget) {
    return "runnable";
  }
  if (hasEpisodes) {
    return "reviewRequired";
  }
  if (hasAssets) {
    return "actionRequired";
  }
  return "preparing";
}

function createHeadline(
  hasAssets: boolean,
  hasTarget: boolean,
  hasEpisodes: boolean,
  canExport: boolean
): string {
  if (canExport && hasTarget) {
    return "这一季已经具备批量导出的基础条件";
  }
  if (hasEpisodes) {
    return "先确认分集草案和提示，再批量导出";
  }
  if (hasAssets) {
    return "把已导入 XML 整理成可导出的分集草案";
  }
  return "导入一季 XML 后开始批量工作";
}

function createNextActionLabel(steps: readonly SeasonWorkbenchStep[]): string {
  const next = steps.find((step) => step.state === "active" || step.state === "blocked" || step.state === "idle");
  return next ? `${next.label}：${next.detail}` : "继续复核并导出。";
}
