import type {
  CutMarker,
  DanmakuAsset,
  DanmakuClip,
  ImportWarning,
  ResolvedDanmakuEvent,
  SyncAnchor
} from "../danmaku/types";
import { reconcileMediaTimeMapQuality } from "../alignment/mediaTimeMap";
import { formatTimeMapQualityLevel } from "../alignment/timeMap";
import {
  isTimeMapManualTakeoverExportApproved,
  readTimeMapSpanReviewDecision
} from "../alignment/timeMapReviewDecision";
import { areMediaContentIdentitiesEqual } from "./mediaIdentity";
import { formatTimecode, type Milliseconds } from "../shared/time";
import { statusLabel, type WorkspaceStatusId } from "../shared/statusVocabulary";
import { isItemInsideClip, resolveProjectDanmakuEvents } from "../timeline/mapping";
import {
  formatMediaConnectionState,
  formatMediaRole,
  validateSourceSegmentReferences
} from "./mediaLibrary";
import { formatMediaBindingSource, formatMediaBindingTitle } from "./mediaBinding";
import type { EditorProject } from "./types";

const EVIDENCE_PREVIEW_LIMIT = 5;

export type ProjectHealthStatus = "ready" | "attention" | "blocked";
export type ProjectHealthFindingSeverity = "info" | "warning" | "error";

export interface ProjectHealthFinding {
  id: string;
  severity: ProjectHealthFindingSeverity;
  title: string;
  detail: string;
  evidence?: string[];
}

export interface ProjectHealthMetrics {
  schemaVersion: number;
  assetCount: number;
  itemCount: number;
  enabledItemCount: number;
  disabledItemCount: number;
  clipCount: number;
  activeClipCount: number;
  cutMarkerCount: number;
  totalCutGapMs: Milliseconds;
  syncAnchorCount: number;
  importWarningCount: number;
  itemAdjustmentCount: number;
  orphanedEditReferenceCount: number;
  missingAssetClipCount: number;
  duplicateIdCount: number;
  negativeFinalTimeItemCount: number;
  mediaNeedsReconnect: boolean;
  mediaBindingKind: "none" | "localFile" | "embyItem";
  mediaBindingNeedsReconnect: boolean;
}

export interface ProjectHealthSummary {
  status: ProjectHealthStatus;
  statusId: WorkspaceStatusId;
  statusLabel: string;
  statusDetail: string;
  metrics: ProjectHealthMetrics;
  findings: ProjectHealthFinding[];
}

export interface ProjectEditReferenceCleanup {
  project: EditorProject;
  removedDisabledItemIds: number;
  removedItemAdjustments: number;
  changed: boolean;
}

export interface ProjectMissingAssetClipCleanup {
  project: EditorProject;
  removedClipIds: string[];
  removedClipCount: number;
  changed: boolean;
}

interface DuplicateIdEntry {
  value: string;
  label: string;
}

interface DuplicateIdGroup {
  value: string;
  labels: string[];
}

export function createProjectHealthSummary(project: EditorProject): ProjectHealthSummary {
  const itemIds = collectProjectItemIds(project);
  const disabledIdSet = new Set(project.disabledItemIds);
  const orphanedDisabledIds = project.disabledItemIds.filter((id) => !itemIds.has(id));
  const adjustedItemIds = Object.keys(project.itemTimeAdjustments);
  const orphanedAdjustmentIds = adjustedItemIds.filter((id) => !itemIds.has(id));
  const itemCount = project.assets.reduce((total, asset) => total + asset.items.length, 0);
  const enabledItemCount = project.assets.reduce(
    (total, asset) => total + asset.items.filter((item) => item.enabled && !disabledIdSet.has(item.id)).length,
    0
  );
  const importWarningCount = project.assets.reduce((total, asset) => total + asset.warnings.length, 0);
  const totalCutGapMs = project.cutMarkers.reduce((total, marker) => total + marker.targetGapMs, 0);
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const missingAssetClips = project.clips.filter((clip) => !assetIds.has(clip.assetId));
  const missingAssetClipCount = missingAssetClips.length;
  const emptyClips = project.clips
    .map((clip) => {
      const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
      return asset && !clipHasVisibleItem(asset, clip) ? { clip, asset } : null;
    })
    .filter((entry): entry is { clip: DanmakuClip; asset: DanmakuAsset } => entry !== null);
  const emptyClipCount = emptyClips.length;
  const zeroGapMarkers = project.cutMarkers.filter((marker) => marker.targetGapMs === 0);
  const activeClipCount = project.clips.filter((clip) => clip.enabled).length;
  const lowConfidenceAnchors = project.syncAnchors.filter(
    (anchor) => anchor.confidence !== undefined && anchor.confidence < 0.75
  );
  const lowConfidenceAnchorCount = lowConfidenceAnchors.length;
  const mediaBindingNeedsReconnect = isLocalMediaBindingDisconnected(project);
  const negativeFinalTimeEvents = resolveProjectDanmakuEvents(project).filter(
    (event) => event.enabled && event.finalTimeMs < 0
  );
  const duplicateAssetIdGroups = findDuplicateGroups(
    project.assets.map((asset, index) => ({
      value: asset.id,
      label: `资源 ${index + 1}（${asset.fileName}）`
    }))
  );
  const duplicateItemIdGroups = findDuplicateGroups(
    project.assets.flatMap((asset) =>
      asset.items.map((item) => ({
        value: item.id,
        label: `资源 ${asset.fileName} 的第 ${item.originalIndex + 1} 条弹幕`
      }))
    )
  );
  const duplicateClipIdGroups = findDuplicateGroups(
    project.clips.map((clip, index) => ({
      value: clip.id,
      label: `片段 ${index + 1}（${clip.name}）`
    }))
  );
  const duplicateCutIdGroups = findDuplicateGroups(
    project.cutMarkers.map((marker, index) => ({
      value: marker.id,
      label: `版本差异 ${index + 1}（${marker.name} @ ${formatTimecode(marker.sourceAtMs)}）`
    }))
  );
  const duplicateAnchorIdGroups = findDuplicateGroups(
    project.syncAnchors.map((anchor, index) => ({
      value: anchor.id,
      label: `同步锚点 ${index + 1}（${formatTimecode(anchor.sourceMs)} -> ${formatTimecode(anchor.targetMs)}）`
    }))
  );
  const duplicateMediaIdGroups = findDuplicateGroups(
    project.mediaLibrary.map((media, index) => ({
      value: media.id,
      label: `媒体素材 ${index + 1}（${formatMediaRole(media.role)} / ${media.fileName}）`
    }))
  );
  const duplicateSourceBindingIdGroups = findDuplicateGroups(
    project.danmakuSourceBindings.map((binding, index) => ({
      value: binding.id,
      label: `XML 来源绑定 ${index + 1}（${binding.assetId} -> ${binding.sourceMediaId}）`
    }))
  );
  const duplicateSourceSegmentIdGroups = findDuplicateGroups(
    project.danmakuSourceSegments.map((segment, index) => ({
      value: segment.id,
      label: `弹幕来源内容段 ${index + 1}（${segment.label} / ${formatTimecode(segment.sourceStartMs)} - ${formatTimecode(
        segment.sourceEndMs
      )}）`
    }))
  );
  const duplicateIdCount =
    duplicateAssetIdGroups.length +
    duplicateItemIdGroups.length +
    duplicateClipIdGroups.length +
    duplicateCutIdGroups.length +
    duplicateAnchorIdGroups.length +
    duplicateMediaIdGroups.length +
    duplicateSourceBindingIdGroups.length +
    duplicateSourceSegmentIdGroups.length;

  const findings: ProjectHealthFinding[] = [];
  appendDuplicateFinding(findings, "asset-id", "资源 ID 重复", duplicateAssetIdGroups);
  appendDuplicateFinding(findings, "item-id", "弹幕 ID 重复", duplicateItemIdGroups);
  appendDuplicateFinding(findings, "clip-id", "片段 ID 重复", duplicateClipIdGroups);
  appendDuplicateFinding(findings, "cut-id", "版本差异 ID 重复", duplicateCutIdGroups);
  appendDuplicateFinding(findings, "anchor-id", "同步锚点 ID 重复", duplicateAnchorIdGroups);
  appendDuplicateFinding(findings, "media-id", "媒体素材 ID 重复", duplicateMediaIdGroups);
  appendDuplicateFinding(findings, "source-binding-id", "XML 来源绑定 ID 重复", duplicateSourceBindingIdGroups);
  appendDuplicateFinding(findings, "source-segment-id", "弹幕来源内容段 ID 重复", duplicateSourceSegmentIdGroups);

  if (project.assets.length === 0) {
    findings.push({
      id: "no-assets",
      severity: "warning",
      title: "尚未导入 XML",
      detail: "项目还没有弹幕资源，保存后可恢复项目壳，但无法导出有效弹幕。"
    });
  }
  if (project.assets.length > 0 && project.clips.length === 0) {
    findings.push({
      id: "no-clips",
      severity: "warning",
      title: "没有时间轴片段",
      detail: "已导入的 XML 还没有放入时间轴，导出前请至少放入一个片段。",
      evidence: formatNoClipAssetEvidence(project.assets)
    });
  }
  if (missingAssetClipCount > 0) {
    findings.push({
      id: "clip-missing-asset",
      severity: "error",
      title: "片段引用了缺失资源",
      detail: `${missingAssetClipCount.toLocaleString("zh-CN")} 个时间轴片段找不到对应弹幕资源，建议重新打开上一个 checkpoint 或删除这些片段。`,
      evidence: formatMissingAssetClipEvidence(missingAssetClips)
    });
  }
  if (emptyClipCount > 0) {
    findings.push({
      id: "empty-clips",
      severity: "warning",
      title: "存在空片段",
      detail: `${emptyClipCount.toLocaleString("zh-CN")} 个时间轴片段当前源区间内没有弹幕，导出前建议确认片段裁剪范围。`,
      evidence: formatEmptyClipEvidence(emptyClips)
    });
  }
  if (project.clips.length > 0 && activeClipCount === 0) {
    findings.push({
      id: "all-clips-disabled",
      severity: "warning",
      title: "所有片段都已禁用",
      detail: "时间轴上没有启用片段，导出结果可能为空。",
      evidence: formatClipEvidence(project.clips, project.assets)
    });
  }
  if (orphanedDisabledIds.length > 0 || orphanedAdjustmentIds.length > 0) {
    findings.push({
      id: "orphaned-edits",
      severity: "warning",
      title: "存在失效编辑引用",
      detail: `有 ${(orphanedDisabledIds.length + orphanedAdjustmentIds.length).toLocaleString(
        "zh-CN"
      )} 条禁用或单条微调引用已不存在的弹幕，保存前建议清理。`,
      evidence: formatOrphanedEditEvidence(orphanedDisabledIds, orphanedAdjustmentIds, project.itemTimeAdjustments)
    });
  }
  if (negativeFinalTimeEvents.length > 0) {
    findings.push({
      id: "negative-final-times",
      severity: "warning",
      title: "存在负最终时间",
      detail: `${negativeFinalTimeEvents.length.toLocaleString(
        "zh-CN"
      )} 条启用弹幕最终时间早于 0ms，导出时会被限制为 0ms；建议复核全局偏移、片段偏移或单条微调。`,
      evidence: formatNegativeFinalTimeEvidence(negativeFinalTimeEvents)
    });
  }
  if (project.media && project.media.objectUrl === null) {
    findings.push({
      id: "media-needs-reconnect",
      severity: "warning",
      title: "视频引用需要重新连接",
      detail: "项目文件不会嵌入视频内容，重新打开后需要再次导入参考视频才能恢复预览。",
      evidence: formatMediaEvidence(project.media)
    });
  }
  if (project.media && project.media.durationMs === null) {
    findings.push({
      id: "media-duration-missing",
      severity: "warning",
      title: "视频时长未知",
      detail: "预览视频尚未读取到时长，时间轴总长会更多依赖片段和弹幕范围。",
      evidence: formatMediaEvidence(project.media)
    });
  }
  const reconnectMedia = project.mediaLibrary.filter((media) => media.connectionState === "needsReconnect");
  if (reconnectMedia.length > 0) {
    findings.push({
      id: "media-library-needs-reconnect",
      severity: "warning",
      title: "媒体素材需要重新连接",
      detail: `${reconnectMedia.length.toLocaleString("zh-CN")} 个素材只有项目引用，没有当前会话可用的视频对象。`,
      evidence: formatMediaLibraryEvidence(reconnectMedia)
    });
  }
  const unknownDurationMedia = project.mediaLibrary.filter((media) => media.durationMs === null);
  if (unknownDurationMedia.length > 0) {
    findings.push({
      id: "media-library-duration-missing",
      severity: "warning",
      title: "媒体素材时长未知",
      detail: `${unknownDurationMedia.length.toLocaleString("zh-CN")} 个素材还没有读取到时长，来源段越界检查会较弱。`,
      evidence: formatMediaLibraryEvidence(unknownDurationMedia)
    });
  }
  collectDanglingDanmakuSourceBindingEvidence(project).forEach((evidence) => {
    findings.push({
      id: `dangling-source-binding-${evidence.id}`,
      severity: "error",
      title: "XML 来源绑定引用失效",
      detail: evidence.detail,
      evidence: evidence.rows
    });
  });
  project.danmakuSourceSegments.forEach((segment) => {
    validateSourceSegmentReferences(project, segment).forEach((issue, index) => {
      findings.push({
        id: `source-segment-reference-${segment.id}-${index}`,
        severity: issue.severity,
        title: issue.severity === "error" ? "来源段引用无效" : "来源段需要复核",
        detail: `${segment.label}：${issue.message}`,
        evidence: [`${formatTimecode(segment.sourceStartMs)} - ${formatTimecode(segment.sourceEndMs)}`]
      });
    });
  });
  const timeMapsById = new Map(project.mediaTimeMaps.map((timeMap) => [timeMap.id, timeMap]));
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  project.danmakuSourceSegments
    .filter((segment) => segment.kind === "content")
    .forEach((segment) => {
      if (!segment.timeMapId) {
        findings.push({
          id: `source-segment-time-map-missing-${segment.id}`,
          severity: "error",
          title: "来源段缺少确认时间图",
          detail: `${segment.label} 未关联已确认时间图；旧兼容投影已停用，不能导出。`
        });
        return;
      }
      const timeMap = timeMapsById.get(segment.timeMapId);
      if (!timeMap || timeMap.state !== "confirmed") {
        findings.push({
          id: `source-segment-time-map-invalid-${segment.id}`,
          severity: "error",
          title: "来源段时间图无效",
          detail: `${segment.label} 引用的确认时间图不存在或状态不正确，不能导出。`
        });
        return;
      }
      const effectiveQuality = reconcileMediaTimeMapQuality(timeMap).quality;
      const manualTakeoverApproved = isTimeMapManualTakeoverExportApproved(timeMap);
      if (effectiveQuality.level !== "verified") {
        findings.push({
          id: `source-segment-time-map-quality-${segment.id}`,
          severity: manualTakeoverApproved ? "warning" : "error",
          title: manualTakeoverApproved ? "正在使用人工接管方案" : "时间映射尚未验证",
          detail: manualTakeoverApproved
            ? `${segment.label} 已由用户采用系统最高可能性建议并接受错位风险；允许导出，但建议先抽查开头、中段和结尾。`
            : `${segment.label} 的时间图质量为“${formatTimeMapQualityLevel(effectiveQuality.level)}”，默认阻断导出。`,
          evidence: effectiveQuality.reasons.slice(0, EVIDENCE_PREVIEW_LIMIT)
        });
      } else {
        const sourceMedia = mediaById.get(timeMap.sourceMediaId);
        const targetMedia = mediaById.get(timeMap.targetMediaId);
        const missingIdentity =
          !sourceMedia?.contentIdentity ||
          !targetMedia?.contentIdentity ||
          !timeMap.sourceIdentity ||
          !timeMap.targetIdentity;
        const sourceChanged =
          sourceMedia?.contentIdentity && timeMap.sourceIdentity
            ? !areMediaContentIdentitiesEqual(sourceMedia.contentIdentity, timeMap.sourceIdentity)
            : false;
        const targetChanged =
          targetMedia?.contentIdentity && timeMap.targetIdentity
            ? !areMediaContentIdentitiesEqual(targetMedia.contentIdentity, timeMap.targetIdentity)
            : false;
        if (missingIdentity || sourceChanged || targetChanged) {
          findings.push({
            id: `source-segment-time-map-media-identity-${segment.id}`,
            severity: "error",
            title: "时间映射对应的媒体文件已失效",
            detail: missingIdentity
              ? `${segment.label} 缺少当前媒体或分析时的内容身份快照，必须重新分析。`
              : `${segment.label} 对应的${sourceChanged ? " B 站参考文件" : "目标原片"}已被替换或修改，必须重新分析。`
          });
        }
      }
      if (
        timeMap.spans.some(
          (span, spanIndex) =>
            span.kind === "ambiguous" &&
            readTimeMapSpanReviewDecision(timeMap, spanIndex)?.decision !== "replacement"
        )
      ) {
        findings.push({
          id: `source-segment-time-map-ambiguous-${segment.id}`,
          severity: "error",
          title: "时间映射仍有歧义区间",
          detail: `${segment.label} 包含 ambiguous 区间，必须先确定对应关系或标为双边版本差异。`
        });
      }
    });
  if (mediaBindingNeedsReconnect && project.mediaBinding) {
    findings.push({
      id: "target-local-needs-reconnect",
      severity: "warning",
      title: "目标原片需要重新连接",
      detail: "项目文件保存了本地目标原片引用，但不会嵌入视频内容。重新打开项目后，请重新导入参考视频，或在目标原片中选择本地路径再复核。",
      evidence: formatMediaBindingEvidence(project)
    });
  }
  if (importWarningCount > 0) {
    findings.push({
      id: "import-warnings",
      severity: "warning",
      title: "导入时存在警告",
      detail: `${importWarningCount.toLocaleString("zh-CN")} 条 XML 导入警告会保存在项目中，导出前建议抽样复核。`,
      evidence: formatImportWarningEvidence(project.assets)
    });
  }
  if (lowConfidenceAnchorCount > 0) {
    findings.push({
      id: "low-confidence-anchors",
      severity: "warning",
      title: "存在低置信同步锚点",
      detail: `${lowConfidenceAnchorCount.toLocaleString("zh-CN")} 个自动锚点置信度低于 75%，应用版本差异前建议人工复核。`,
      evidence: formatLowConfidenceAnchorEvidence(lowConfidenceAnchors)
    });
  }
  if (zeroGapMarkers.length > 0) {
    findings.push({
      id: "zero-gap-markers",
      severity: "info",
      title: "存在 0ms 版本差异",
      detail: "0ms 版本差异不会改变时间轴，可保留作标记，也可在确认后删除。",
      evidence: formatZeroGapMarkerEvidence(zeroGapMarkers)
    });
  }
  if (findings.length === 0) {
    findings.push({
      id: "ready",
      severity: "info",
      title: "项目结构健康",
      detail: "当前没有发现保存、重开或导出前需要优先处理的结构问题。"
    });
  }

  const status = createStatus(findings);
  const statusId = projectHealthStatusId(status);
  return {
    status,
    statusId,
    statusLabel: statusLabel(statusId),
    statusDetail: statusToDetail(status),
    metrics: {
      schemaVersion: project.schemaVersion,
      assetCount: project.assets.length,
      itemCount,
      enabledItemCount,
      disabledItemCount: itemCount - enabledItemCount,
      clipCount: project.clips.length,
      activeClipCount,
      cutMarkerCount: project.cutMarkers.length,
      totalCutGapMs,
      syncAnchorCount: project.syncAnchors.length,
      importWarningCount,
      itemAdjustmentCount: adjustedItemIds.length,
      orphanedEditReferenceCount: orphanedDisabledIds.length + orphanedAdjustmentIds.length,
      missingAssetClipCount,
      duplicateIdCount,
      negativeFinalTimeItemCount: negativeFinalTimeEvents.length,
      mediaNeedsReconnect:
        Boolean(project.media && project.media.objectUrl === null) ||
        project.mediaLibrary.some((media) => media.connectionState === "needsReconnect"),
      mediaBindingKind: project.mediaBinding?.kind ?? "none",
      mediaBindingNeedsReconnect
    },
    findings
  };
}

export function cleanupProjectMissingAssetClips(project: EditorProject): ProjectMissingAssetClipCleanup {
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const removedClipIds = project.clips.filter((clip) => !assetIds.has(clip.assetId)).map((clip) => clip.id);
  const removedClipIdSet = new Set(removedClipIds);
  const changed = removedClipIds.length > 0;
  return {
    project: changed
      ? {
          ...project,
          clips: project.clips.filter((clip) => !removedClipIdSet.has(clip.id))
        }
      : project,
    removedClipIds,
    removedClipCount: removedClipIds.length,
    changed
  };
}

export function cleanupProjectEditReferences(project: EditorProject): ProjectEditReferenceCleanup {
  const itemIds = collectProjectItemIds(project);
  const disabledItemIds = project.disabledItemIds.filter((id) => itemIds.has(id));
  const itemTimeAdjustments: Record<string, Milliseconds> = {};
  for (const [itemId, adjustmentMs] of Object.entries(project.itemTimeAdjustments)) {
    if (itemIds.has(itemId)) {
      itemTimeAdjustments[itemId] = adjustmentMs;
    }
  }
  const removedDisabledItemIds = project.disabledItemIds.length - disabledItemIds.length;
  const removedItemAdjustments = Object.keys(project.itemTimeAdjustments).length - Object.keys(itemTimeAdjustments).length;
  const changed = removedDisabledItemIds > 0 || removedItemAdjustments > 0;
  return {
    project: changed
      ? {
          ...project,
          disabledItemIds,
          itemTimeAdjustments
        }
      : project,
    removedDisabledItemIds,
    removedItemAdjustments,
    changed
  };
}

export function createProjectHealthReport(
  projectName: string,
  summary: ProjectHealthSummary,
  generatedAt = new Date()
): string {
  const lines = [
    "导出前检查报告",
    `项目：${projectName.trim().length > 0 ? projectName : "未命名项目"}`,
    `项目版本：v${summary.metrics.schemaVersion}`,
    `生成时间：${generatedAt.toISOString()}`,
    `状态：${summary.statusLabel}`,
    `说明：${summary.statusDetail}`,
    "",
    "关键计数：",
    `资源：${summary.metrics.assetCount.toLocaleString("zh-CN")} 个`,
    `弹幕：${summary.metrics.enabledItemCount.toLocaleString("zh-CN")} / ${summary.metrics.itemCount.toLocaleString(
      "zh-CN"
    )} 条启用`,
    `片段：${summary.metrics.activeClipCount.toLocaleString("zh-CN")} / ${summary.metrics.clipCount.toLocaleString(
      "zh-CN"
    )} 个启用`,
    `版本差异：${summary.metrics.cutMarkerCount.toLocaleString("zh-CN")} 个`,
    `累计调整：${formatSignedDuration(summary.metrics.totalCutGapMs)}`,
    `同步锚点：${summary.metrics.syncAnchorCount.toLocaleString("zh-CN")} 个`,
    `导入警告：${summary.metrics.importWarningCount.toLocaleString("zh-CN")} 条`,
    `单条微调：${summary.metrics.itemAdjustmentCount.toLocaleString("zh-CN")} 条`,
    `失效编辑引用：${summary.metrics.orphanedEditReferenceCount.toLocaleString("zh-CN")} 条`,
    `缺失资源片段：${summary.metrics.missingAssetClipCount.toLocaleString("zh-CN")} 个`,
    `重复 ID：${summary.metrics.duplicateIdCount.toLocaleString("zh-CN")} 个`,
    `负最终时间：${summary.metrics.negativeFinalTimeItemCount.toLocaleString("zh-CN")} 条`,
    `媒体重连：${summary.metrics.mediaNeedsReconnect ? "需要" : "不需要"}`,
    `目标原片：${formatMediaBindingMetricLabel(summary.metrics.mediaBindingKind)}`,
    `目标原片重连：${summary.metrics.mediaBindingNeedsReconnect ? "需要" : "不需要"}`,
    "",
    "复核清单："
  ];
  summary.findings.forEach((finding, index) => {
    lines.push(
      `${index + 1}. [${severityLabel(finding.severity)}] ${finding.title}`,
      `   ${finding.detail}`
    );
    finding.evidence?.forEach((item) => {
      lines.push(`   - ${item}`);
    });
  });
  return `${lines.join("\n")}\n`;
}

export function summarizeProjectHealthBlockers(summary: ProjectHealthSummary): string | null {
  const blockers = summary.findings.filter((finding) => finding.severity === "error");
  if (blockers.length === 0) {
    return null;
  }
  return formatLimitedList(blockers.map((finding) => finding.title));
}

function collectProjectItemIds(project: EditorProject): Set<string> {
  return new Set(project.assets.flatMap((asset) => asset.items.map((item) => item.id)));
}

function clipHasVisibleItem(asset: DanmakuAsset, clip: DanmakuClip): boolean {
  return asset.items.some((item) => isItemInsideClip(item, clip));
}

function appendDuplicateFinding(
  findings: ProjectHealthFinding[],
  id: string,
  title: string,
  groups: DuplicateIdGroup[]
) {
  if (groups.length === 0) {
    return;
  }
  findings.push({
    id,
    severity: "error",
    title,
    detail: `发现 ${groups.length.toLocaleString("zh-CN")} 个重复 ID：${formatLimitedList(
      groups.map((group) => group.value)
    )}。重复 ID 会影响选择、编辑、撤销和项目恢复。`,
    evidence: formatDuplicateEvidence(groups)
  });
}

function findDuplicateGroups(entries: DuplicateIdEntry[]): DuplicateIdGroup[] {
  const labelsByValue = new Map<string, string[]>();
  entries.forEach((entry) => {
    const labels = labelsByValue.get(entry.value);
    if (labels) {
      labels.push(entry.label);
    } else {
      labelsByValue.set(entry.value, [entry.label]);
    }
  });
  return [...labelsByValue.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([value, labels]) => ({ value, labels }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

function formatDuplicateEvidence(groups: DuplicateIdGroup[]): string[] {
  const evidence = groups.slice(0, EVIDENCE_PREVIEW_LIMIT).map((group) => {
    const suffix =
      group.labels.length > 3 ? `；另有 ${group.labels.length - 3} 处` : "";
    return `${group.value}：${group.labels.slice(0, 3).join("；")}${suffix}`;
  });
  return appendOmittedEvidenceNote(evidence, groups.length, "个重复 ID");
}

function formatNegativeFinalTimeEvidence(events: ResolvedDanmakuEvent[]): string[] {
  const evidence = events.slice(0, EVIDENCE_PREVIEW_LIMIT).map((event) => {
    const text = event.item.text.trim().length > 0 ? event.item.text.trim() : "空文本";
    return `${event.asset.fileName} / ${event.clip.name} / 第 ${
      event.item.originalIndex + 1
    } 条：${formatSignedDuration(event.finalTimeMs)}，${formatLimitedText(text)}`;
  });
  return appendOmittedEvidenceNote(evidence, events.length, "条负最终时间");
}

function formatNoClipAssetEvidence(assets: DanmakuAsset[]): string[] {
  const evidence = assets.slice(0, EVIDENCE_PREVIEW_LIMIT).map((asset) => {
    return `${asset.fileName}（${asset.items.length.toLocaleString("zh-CN")} 条弹幕）`;
  });
  return appendOmittedEvidenceNote(evidence, assets.length, "个资源");
}

function formatClipEvidence(clips: DanmakuClip[], assets: DanmakuAsset[]): string[] {
  const assetFileNames = new Map(assets.map((asset) => [asset.id, asset.fileName]));
  const evidence = clips.slice(0, EVIDENCE_PREVIEW_LIMIT).map((clip) => {
    const assetFileName = assetFileNames.get(clip.assetId) ?? `缺失资源 ${clip.assetId}`;
    return `${clip.name} / ${assetFileName}（时间轴 ${formatTimecode(clip.timelineStartMs)}，源区间 ${formatTimecode(
      clip.sourceInMs
    )} - ${formatTimecode(clip.sourceOutMs)}）`;
  });
  return appendOmittedEvidenceNote(evidence, clips.length, "个片段");
}

function formatMediaEvidence(media: NonNullable<EditorProject["media"]>): string[] {
  return [`${media.fileName}（名称：${media.name}）`];
}

function formatMediaLibraryEvidence(mediaLibrary: EditorProject["mediaLibrary"]): string[] {
  const evidence = mediaLibrary.slice(0, EVIDENCE_PREVIEW_LIMIT).map((media) => {
    const duration = media.durationMs === null ? "时长未知" : formatTimecode(media.durationMs);
    return `${formatMediaRole(media.role)} / ${media.fileName}（${formatMediaConnectionState(media)}，${duration}）`;
  });
  return appendOmittedEvidenceNote(evidence, mediaLibrary.length, "个媒体素材");
}

function collectDanglingDanmakuSourceBindingEvidence(project: EditorProject): Array<{
  id: string;
  detail: string;
  rows: string[];
}> {
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const sourceMediaIds = new Set(
    project.mediaLibrary.filter((media) => media.role === "bilibiliReference").map((media) => media.id)
  );
  return project.danmakuSourceBindings.flatMap((binding) => {
    const rows: string[] = [];
    if (!assetIds.has(binding.assetId)) {
      rows.push(`缺失 XML：${binding.assetId}`);
    }
    if (!sourceMediaIds.has(binding.sourceMediaId)) {
      rows.push(`缺失或角色错误的 B 站参考素材：${binding.sourceMediaId}`);
    }
    if (rows.length === 0) {
      return [];
    }
    return [
      {
        id: binding.id,
        detail: `绑定 ${binding.id} 指向不存在或角色不正确的对象。`,
        rows
      }
    ];
  });
}

function formatMediaBindingEvidence(project: EditorProject): string[] {
  return [`${formatMediaBindingTitle(project.mediaBinding)}（${formatMediaBindingSource(project.mediaBinding)}）`];
}

function isLocalMediaBindingDisconnected(project: EditorProject): boolean {
  const binding = project.mediaBinding;
  if (!binding || binding.kind !== "localFile") {
    return false;
  }
  if (binding.localPath && binding.localPath.trim().length > 0) {
    return false;
  }
  if (!project.media || project.media.objectUrl === null) {
    return true;
  }
  if (binding.mediaId && project.media.id === binding.mediaId) {
    return false;
  }
  return project.media.fileName !== binding.fileName;
}

function formatMediaBindingMetricLabel(kind: ProjectHealthMetrics["mediaBindingKind"]): string {
  if (kind === "localFile") {
    return "本地文件";
  }
  if (kind === "embyItem") {
    return "Emby 条目";
  }
  return "未绑定";
}

function formatMissingAssetClipEvidence(clips: DanmakuClip[]): string[] {
  const evidence = clips.slice(0, EVIDENCE_PREVIEW_LIMIT).map((clip) => {
    return `${clip.name}（片段 ID：${clip.id}，缺失资源 ID：${clip.assetId}，时间轴 ${formatTimecode(
      clip.timelineStartMs
    )}，源区间 ${formatTimecode(clip.sourceInMs)} - ${formatTimecode(clip.sourceOutMs)}）`;
  });
  return appendOmittedEvidenceNote(evidence, clips.length, "个缺失资源片段");
}

function formatOrphanedEditEvidence(
  disabledIds: string[],
  adjustmentIds: string[],
  itemTimeAdjustments: Record<string, Milliseconds>
): string[] {
  const rows = [
    ...disabledIds.map((id) => `失效禁用：${id}`),
    ...adjustmentIds.map((id) => `失效微调：${id}（${formatSignedDuration(itemTimeAdjustments[id] ?? 0)}）`)
  ];
  const evidence = rows.slice(0, EVIDENCE_PREVIEW_LIMIT);
  return appendOmittedEvidenceNote(evidence, rows.length, "条失效编辑引用");
}

function formatImportWarningEvidence(assets: DanmakuAsset[]): string[] {
  const rows = assets.flatMap((asset) =>
    asset.warnings.map((warning) => {
      const location = warning.originalIndex === null ? "文件级" : `第 ${warning.originalIndex + 1} 条`;
      const snippet = warning.rawSnippet.trim();
      const snippetText = snippet.length > 0 ? `，片段：${formatLimitedText(snippet)}` : "";
      return `${asset.fileName} / ${location} / ${importWarningSeverityLabel(warning.severity)}：${
        warning.message
      }${snippetText}`;
    })
  );
  const evidence = rows.slice(0, EVIDENCE_PREVIEW_LIMIT);
  return appendOmittedEvidenceNote(evidence, rows.length, "条导入警告");
}

function importWarningSeverityLabel(severity: ImportWarning["severity"]): string {
  if (severity === "error") {
    return "错误";
  }
  if (severity === "warning") {
    return "警告";
  }
  return "信息";
}

function formatLowConfidenceAnchorEvidence(anchors: SyncAnchor[]): string[] {
  const evidence = anchors.slice(0, EVIDENCE_PREVIEW_LIMIT).map((anchor) => {
    const confidence = anchor.confidence === undefined ? "未知" : `${Math.round(anchor.confidence * 100)}%`;
    const origin = anchor.origin === "manual" ? "手动" : "自动";
    return `${anchor.id}（${origin}，${formatTimecode(anchor.sourceMs)} -> ${formatTimecode(
      anchor.targetMs
    )}，置信度 ${confidence}）`;
  });
  return appendOmittedEvidenceNote(evidence, anchors.length, "个低置信锚点");
}

function formatEmptyClipEvidence(entries: Array<{ clip: DanmakuClip; asset: DanmakuAsset }>): string[] {
  const evidence = entries.slice(0, EVIDENCE_PREVIEW_LIMIT).map(({ clip, asset }) => {
    return `${clip.name} / ${asset.fileName}（时间轴 ${formatTimecode(clip.timelineStartMs)}，源区间 ${formatTimecode(
      clip.sourceInMs
    )} - ${formatTimecode(clip.sourceOutMs)}）`;
  });
  return appendOmittedEvidenceNote(evidence, entries.length, "个空片段");
}

function formatZeroGapMarkerEvidence(markers: CutMarker[]): string[] {
  const evidence = markers.slice(0, EVIDENCE_PREVIEW_LIMIT).map((marker) => {
    const note = marker.note.trim().length > 0 ? `，备注：${formatLimitedText(marker.note.trim())}` : "";
    return `${marker.name}（ID：${marker.id}，发生位置 ${formatTimecode(marker.sourceAtMs)}${note}）`;
  });
  return appendOmittedEvidenceNote(evidence, markers.length, "个 0ms 版本差异");
}

function appendOmittedEvidenceNote(evidence: string[], totalCount: number, unitLabel: string): string[] {
  const omittedCount = totalCount - EVIDENCE_PREVIEW_LIMIT;
  if (omittedCount <= 0) {
    return evidence;
  }
  const suffixSeparator = /[A-Za-z0-9]$/.test(unitLabel) ? " " : "";
  return [
    ...evidence,
    `另有 ${omittedCount.toLocaleString("zh-CN")} ${unitLabel}${suffixSeparator}未列出，完整数量见上方计数。`
  ];
}

function formatLimitedText(text: string): string {
  if (text.length <= 24) {
    return text;
  }
  return `${text.slice(0, 24)}...`;
}

function formatLimitedList(values: string[]): string {
  if (values.length <= 3) {
    return values.join("、");
  }
  return `${values.slice(0, 3).join("、")} 等 ${values.length.toLocaleString("zh-CN")} 项`;
}

function createStatus(findings: ProjectHealthFinding[]): ProjectHealthStatus {
  if (findings.some((finding) => finding.severity === "error")) {
    return "blocked";
  }
  if (findings.some((finding) => finding.severity === "warning")) {
    return "attention";
  }
  return "ready";
}

function projectHealthStatusId(status: ProjectHealthStatus): WorkspaceStatusId {
  if (status === "blocked") return "blocked";
  if (status === "attention") return "reviewRequired";
  return "runnable";
}

function statusToDetail(status: ProjectHealthStatus): string {
  if (status === "blocked") {
    return "发现引用或 ID 层面的结构问题，建议先处理后再导出。";
  }
  if (status === "attention") {
    return "项目可继续编辑，但保存、重开或导出前建议复核提示项。";
  }
  return "项目结构健康，可继续保存、重开和导出。";
}

function severityLabel(severity: ProjectHealthFindingSeverity): string {
  if (severity === "error") {
    return statusLabel("blocked");
  }
  if (severity === "warning") {
    return statusLabel("reviewRequired");
  }
  return "信息";
}

function formatSignedDuration(milliseconds: Milliseconds): string {
  const sign = milliseconds < 0 ? "-" : "+";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}
