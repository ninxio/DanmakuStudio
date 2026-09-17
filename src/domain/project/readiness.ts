import { createProjectHealthSummary, type ProjectHealthFinding } from "./health";
import type { EditorProject } from "./types";
import { statusLabel } from "../shared/statusVocabulary";
import type { WorkspaceStatusId } from "../shared/statusVocabulary";

export type ProjectReadinessStatus = "ready" | "attention" | "blocked";

export interface ProjectReadinessItem {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
  evidence: string[];
}

export interface ProjectReadinessDiagnostic {
  label: string;
  value: string;
}

export interface ProjectReadinessSummary {
  status: ProjectReadinessStatus;
  statusId: WorkspaceStatusId;
  statusLabel: string;
  headline: string;
  detail: string;
  items: ProjectReadinessItem[];
  diagnostics: ProjectReadinessDiagnostic[];
  canCleanupEditReferences: boolean;
  canCleanupMissingAssetClips: boolean;
}

export function createProjectReadinessSummary(project: EditorProject): ProjectReadinessSummary {
  const health = createProjectHealthSummary(project);
  const reviewItems = health.findings.filter((finding) => finding.id !== "ready").map(toReadinessItem);
  return {
    status: health.status,
    statusId: health.statusId,
    statusLabel: statusLabel(health.statusId),
    headline: createReadinessHeadline(health.status),
    detail: createReadinessDetail(health.status, reviewItems.length),
    items: reviewItems,
    diagnostics: [
      { label: "项目版本", value: `v${health.metrics.schemaVersion}` },
      { label: "资源", value: health.metrics.assetCount.toLocaleString("zh-CN") },
      {
        label: "弹幕",
        value: `${health.metrics.enabledItemCount.toLocaleString("zh-CN")} / ${health.metrics.itemCount.toLocaleString(
          "zh-CN"
        )}`
      },
      {
        label: "片段",
        value: `${health.metrics.activeClipCount.toLocaleString("zh-CN")} / ${health.metrics.clipCount.toLocaleString(
          "zh-CN"
        )}`
      },
      { label: "版本差异", value: health.metrics.cutMarkerCount.toLocaleString("zh-CN") },
      { label: "总补时", value: formatSignedDuration(health.metrics.totalCutGapMs) },
      { label: "同步线索", value: health.metrics.syncAnchorCount.toLocaleString("zh-CN") },
      { label: "导入警告", value: health.metrics.importWarningCount.toLocaleString("zh-CN") },
      { label: "单条微调", value: health.metrics.itemAdjustmentCount.toLocaleString("zh-CN") },
      { label: "重复 ID", value: health.metrics.duplicateIdCount.toLocaleString("zh-CN") },
      { label: "导出到 0 秒", value: health.metrics.negativeFinalTimeItemCount.toLocaleString("zh-CN") },
      { label: "视频重连", value: health.metrics.mediaNeedsReconnect ? "需要" : "不需要" },
      { label: "目标原片", value: formatMediaBindingKind(health.metrics.mediaBindingKind) },
      { label: "目标重连", value: health.metrics.mediaBindingNeedsReconnect ? "需要" : "不需要" }
    ],
    canCleanupEditReferences: health.metrics.orphanedEditReferenceCount > 0,
    canCleanupMissingAssetClips: health.metrics.missingAssetClipCount > 0
  };
}

function createReadinessHeadline(status: ProjectReadinessStatus): string {
  if (status === "blocked") {
    return "现在还不能安心导出";
  }
  if (status === "attention") {
    return "可以继续编辑，导出前建议看一眼";
  }
  return "项目已准备好导出";
}

function createReadinessDetail(status: ProjectReadinessStatus, itemCount: number): string {
  if (status === "blocked") {
    return "有会影响导出结果的问题，先处理下面的项目。";
  }
  if (status === "attention") {
    return itemCount > 0 ? "这些项目不会立刻阻止编辑，但可能影响最终效果。" : "没有发现需要立刻处理的问题。";
  }
  return "没有发现会影响保存、重开或导出的明显问题。";
}

function toReadinessItem(finding: ProjectHealthFinding): ProjectReadinessItem {
  const common = {
    id: finding.id,
    severity: finding.severity,
    evidence: finding.evidence ?? []
  };
  if (finding.id === "no-assets") {
    return {
      ...common,
      title: "还没有导入弹幕 XML",
      detail: "先导入一个或多个 B 站 XML，软件才知道要调整哪些弹幕。"
    };
  }
  if (finding.id === "no-clips") {
    return {
      ...common,
      title: "弹幕还没放到时间轴",
      detail: "把已导入的 XML 放入时间轴后，才能预览、调整和导出。"
    };
  }
  if (finding.id === "clip-missing-asset") {
    return {
      ...common,
      title: "有时间轴片段找不到原来的 XML",
      detail: "这些片段导出时会丢内容，建议移除缺失片段或重新打开最近保存的项目。"
    };
  }
  if (finding.id === "orphaned-edits") {
    return {
      ...common,
      title: "有失效的弹幕调整记录",
      detail: "一些禁用或微调记录已经找不到对应弹幕，可以一键清理。"
    };
  }
  if (finding.id === "negative-final-times") {
    return {
      ...common,
      title: "有弹幕会被挤到 0 秒",
      detail: "这些弹幕最终时间早于开头，导出时会被放到 0 秒，建议复核整体偏移或单条微调。"
    };
  }
  if (finding.id === "media-needs-reconnect") {
    return {
      ...common,
      title: "预览视频需要重新选择",
      detail: "项目不会嵌入视频文件，重新打开后需要再次选择本地视频才能预览。"
    };
  }
  if (finding.id === "media-duration-missing") {
    return {
      ...common,
      title: "还没读到视频时长",
      detail: "时间轴仍可编辑；如果需要按视频长度复核，请先让预览视频加载完成。"
    };
  }
  if (finding.id === "target-local-needs-reconnect") {
    return {
      ...common,
      title: "目标原片需要重新选择",
      detail: "项目不会嵌入本地视频。重新打开后，请导入同一个目标原片，后续对齐和导出检查才能继续读取它。"
    };
  }
  if (finding.id === "import-warnings") {
    return {
      ...common,
      title: "导入 XML 时有少量警告",
      detail: "大多数情况下仍可继续，导出前建议抽样看一下这些弹幕。"
    };
  }
  if (finding.id === "low-confidence-anchors") {
    return {
      ...common,
      title: "有不太确定的对齐线索",
      detail: "自动生成的同步线索需要人工确认后再放心应用。"
    };
  }
  if (finding.id === "zero-gap-markers") {
    return {
      ...common,
      title: "有不会改变时间的版本差异",
      detail: "这些标记目前相差 0 秒，可保留作备注，也可以确认后删除。"
    };
  }
  if (finding.id.endsWith("-id")) {
    return {
      ...common,
      title: "项目内部 ID 有重复",
      detail: "重复 ID 会影响选择、编辑和恢复，建议回到最近正常的项目文件。"
    };
  }
  return {
    ...common,
    title: finding.title,
    detail: finding.detail
  };
}

function formatMediaBindingKind(kind: "none" | "localFile" | "embyItem"): string {
  if (kind === "localFile") {
    return "本地文件";
  }
  if (kind === "embyItem") {
    return "Emby 条目";
  }
  return "未绑定";
}

function formatSignedDuration(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "+";
  const absolute = Math.abs(Math.round(milliseconds));
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1000);
  const ms = absolute % 1000;
  return `${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}
