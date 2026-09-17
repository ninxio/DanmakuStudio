import {
  compileTimeMap,
  isCompleteTimeMapSpanEvidence,
  validateTimeMap,
  type CompiledTimeMap
} from "../alignment/timeMap";
import { reconcileMediaTimeMapQuality } from "../alignment/mediaTimeMap";
import {
  isTimeMapManualTakeoverExportApproved,
  readTimeMapSpanReviewDecision
} from "../alignment/timeMapReviewDecision";
import { areMediaContentIdentitiesEqual } from "../project/mediaIdentity";
import type { DanmakuItem } from "../danmaku/types";
import type {
  DanmakuSourceSegment,
  EditorProject,
  MediaTimeMap,
  ProjectMediaReference
} from "../project/types";
import type { Milliseconds } from "../shared/time";

/**
 * 来源段投影：把"B 站参考时间轴上的弹幕"投影到"目标原片时间轴"。
 *
 * 坐标系说明：
 * - 输入时间：弹幕 XML 原始时间（即 B 站参考素材时间轴，二者强关联）。
 * - 输出时间：目标原片时间轴。
 *
 * 已验证时间图是正式投影路径：matched 段执行整数毫秒分段仿射插值，sourceOnly 不投影，
 * targetOnly 通过后续 matched 段的目标边界产生跳变，ambiguous 会阻断导出。单条调整最后叠加。
 *
 * ignored 段内的弹幕不投影；sourceOnly 内弹幕属于时间图明确舍弃的内容，单独计数。未被任何
 * 有效映射覆盖的弹幕计入 unexpectedUnmappedItemCount 并提示用户，但数量本身不阻断导出：
 * 原 XML 可以合法地长于当前已确认、准备导出的来源范围。
 * 本模块不修改原始 XML 数据，仅产出投影结果。
 */

export interface ProjectionEntry {
  item: DanmakuItem;
  finalTimeMs: Milliseconds;
  segmentId: string;
}

export interface ProjectionAppliedRule {
  segmentId: string;
  segmentLabel: string;
  ruleId: string;
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
  affectedCount: number;
  note: string;
}

export interface TargetProjectionGroup {
  targetMediaId: string;
  targetName: string;
  targetFileName: string;
  episodeLabel: string | null;
  exportFileName: string;
  segments: DanmakuSourceSegment[];
  entries: ProjectionEntry[];
  disabledCount: number;
  appliedRules: ProjectionAppliedRule[];
  warnings: string[];
}

export type ProjectionIssueSeverity = "warning" | "error";

export interface ProjectionIssue {
  id: string;
  severity: ProjectionIssueSeverity;
  segmentId: string | null;
  message: string;
}

export type SourceProjectionStatus = "empty" | "blocked" | "ready" | "readyWithWarnings";

export interface SourceProjectionResult {
  status: SourceProjectionStatus;
  groups: TargetProjectionGroup[];
  issues: ProjectionIssue[];
  contentSegmentCount: number;
  ignoredSegmentCount: number;
  projectedItemCount: number;
  ignoredItemCount: number;
  sourceOnlyItemCount: number;
  unexpectedUnmappedItemCount: number;
  /** sourceOnly 与意外未覆盖的合计，供兼容摘要使用。 */
  unmappedItemCount: number;
}

/**
 * Once a project has entered the source-to-original workflow, legacy timeline/file-name exports
 * are unsafe because they do not consume the confirmed MediaTimeMap.
 */
export function requiresProjectionOnlyExport(project: EditorProject): boolean {
  return (
    project.danmakuSourceSegments.some((segment) => segment.kind === "content") ||
    project.mediaTimeMaps.length > 0 ||
    project.mediaLibrary.some((media) => media.role === "targetOriginal")
  );
}

interface UsableProjectionSegment {
  segment: DanmakuSourceSegment;
  timeMap: MediaTimeMap;
  compiledTimeMap: CompiledTimeMap;
}

export function projectDanmakuToTargets(project: EditorProject): SourceProjectionResult {
  const issues: ProjectionIssue[] = [];
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const sourceBindingByAssetId = new Map(
    project.danmakuSourceBindings.map((binding) => [binding.assetId, binding.sourceMediaId])
  );
  const timeMapById = new Map(project.mediaTimeMaps.map((timeMap) => [timeMap.id, timeMap]));
  const disabled = new Set(project.disabledItemIds);

  const contentSegments = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "content"
  );
  const ignoredSegments = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "ignored"
  );

  if (contentSegments.length === 0) {
    return {
      status: "empty",
      groups: [],
      issues: [
        {
          id: "no-content-segments",
          severity: "warning",
          segmentId: null,
          message: "还没有可投影的正片来源段。请先在匹配页标出参考视频与原片的对应关系。"
        }
      ],
      contentSegmentCount: 0,
      ignoredSegmentCount: ignoredSegments.length,
      projectedItemCount: 0,
      ignoredItemCount: 0,
      sourceOnlyItemCount: 0,
      unexpectedUnmappedItemCount: project.assets.reduce(
        (count, asset) => count + asset.items.length,
        0
      ),
      unmappedItemCount: project.assets.reduce((count, asset) => count + asset.items.length, 0)
    };
  }

  const overlappingSegmentIds = new Set<string>();
  findOverlappingProjectionSegments([...contentSegments, ...ignoredSegments]).forEach(
    ([left, right]) => {
      overlappingSegmentIds.add(left.id);
      overlappingSegmentIds.add(right.id);
      issues.push({
        id: `segment-overlap-${left.id}-${right.id}`,
        severity: "error",
        segmentId: right.id,
        message: `${left.label} 与 ${right.label} 的来源范围冲突，继续投影会产生重复弹幕或覆盖已标记的忽略范围。`
      });
    }
  );

  const usableSegments: UsableProjectionSegment[] = [];
  for (const segment of contentSegments) {
    if (overlappingSegmentIds.has(segment.id)) {
      continue;
    }
    const problem = findSegmentBlocker(segment, assetsById, mediaById, sourceBindingByAssetId);
    if (problem) {
      issues.push({
        id: `segment-blocked-${segment.id}`,
        severity: "error",
        segmentId: segment.id,
        message: problem
      });
      continue;
    }
    if (!segment.timeMapId) {
      issues.push({
        id: `segment-missing-time-map-${segment.id}`,
        severity: "error",
        segmentId: segment.id,
        message: `${segment.label} 未关联已确认时间图；旧的段首与删减规则不再允许进入导出链路。`
      });
      continue;
    }

    const timeMap = timeMapById.get(segment.timeMapId);
    const timeMapProblem = findTimeMapBlocker(segment, timeMap, mediaById);
    if (timeMapProblem || !timeMap) {
      issues.push({
        id: `segment-time-map-blocked-${segment.id}`,
        severity: "error",
        segmentId: segment.id,
        message: timeMapProblem ?? `${segment.label} 引用的可验证时间图不存在，无法导出。`
      });
      continue;
    }
    usableSegments.push({
      segment,
      timeMap,
      compiledTimeMap: compileTimeMap(timeMap.spans)
    });
  }

  const usableIgnoredSegments: DanmakuSourceSegment[] = [];
  for (const segment of ignoredSegments) {
    const problem = findSourceSegmentBlocker(
      segment,
      assetsById,
      mediaById,
      sourceBindingByAssetId
    );
    if (problem) {
      issues.push({
        id: `ignored-segment-blocked-${segment.id}`,
        severity: "error",
        segmentId: segment.id,
        message: problem
      });
      continue;
    }
    if (!overlappingSegmentIds.has(segment.id)) {
      usableIgnoredSegments.push(segment);
    }
  }

  const groupsByTarget = new Map<string, TargetProjectionGroup>();
  const coveredItemKeys = new Set<string>();
  const sourceOnlyItemKeys = new Set<string>();
  const mappedItemKeys = new Set<string>();
  let projectedItemCount = 0;
  let disabledTotal = 0;

  for (const { segment, timeMap, compiledTimeMap } of usableSegments) {
    const asset = assetsById.get(segment.assetId as string);
    const target = mediaById.get(segment.targetMediaId as string);
    if (!asset || !target) {
      continue;
    }
    const group = ensureGroup(groupsByTarget, target);
    group.segments.push(segment);

    let disabledCount = 0;

    for (const item of asset.items) {
      if (
        item.sourceTimeMs < segment.sourceStartMs ||
        item.sourceTimeMs >= segment.sourceEndMs
      ) {
        continue;
      }

      const mapping = compiledTimeMap.mapSourceTime(item.sourceTimeMs);
      if (mapping.status === "unmapped") {
        const itemKey = createItemKey(asset.id, item.id);
        coveredItemKeys.add(itemKey);
        if (!mappedItemKeys.has(itemKey)) {
          sourceOnlyItemKeys.add(itemKey);
        }
        continue;
      }
      if (mapping.status === "ambiguous") {
        // “版本替换”表示双方都有内容，但参考侧弹幕不应投到另一版画面。
        // 可信人工验证允许把它作为已解释的来源舍弃区间；其余 ambiguous 仍 fail-closed。
        if (
          readTimeMapSpanReviewDecision(timeMap, mapping.spanIndex)?.decision === "replacement"
        ) {
          const itemKey = createItemKey(asset.id, item.id);
          coveredItemKeys.add(itemKey);
          if (!mappedItemKeys.has(itemKey)) {
            sourceOnlyItemKeys.add(itemKey);
          }
        }
        continue;
      }
      const mappedTimeMs = mapping.targetTimeMs;

      const itemKey = createItemKey(asset.id, item.id);
      coveredItemKeys.add(itemKey);
      mappedItemKeys.add(itemKey);
      sourceOnlyItemKeys.delete(itemKey);
      if (!item.enabled || disabled.has(item.id)) {
        disabledCount += 1;
        continue;
      }
      const adjustmentMs = project.itemTimeAdjustments[item.id] ?? 0;
      const finalTimeMs = mappedTimeMs + adjustmentMs;
      group.entries.push({ item, finalTimeMs, segmentId: segment.id });
      projectedItemCount += 1;
    }

    group.disabledCount += disabledCount;
    disabledTotal += disabledCount;
  }

  const groups = Array.from(groupsByTarget.values());
  ensureUniqueExportFileNames(groups);
  for (const group of groups) {
    group.entries.sort(
      (left, right) =>
        left.finalTimeMs - right.finalTimeMs ||
        left.item.originalIndex - right.item.originalIndex
    );
    if (group.entries.length === 0) {
      group.warnings.push(`${group.targetName} 的来源段内没有可导出的弹幕。`);
      issues.push({
        id: `target-empty-${group.targetMediaId}`,
        severity: "warning",
        segmentId: null,
        message: `${group.targetName} 的来源段内没有可导出的弹幕。`
      });
    }
    const negativeCount = group.entries.filter((entry) => entry.finalTimeMs < 0).length;
    if (negativeCount > 0) {
      const message = `${group.targetName} 有 ${negativeCount} 条弹幕投影后时间为负；静默限制为 0 会破坏同步，已阻断导出。`;
      group.warnings.push(message);
      issues.push({
        id: `target-negative-${group.targetMediaId}`,
        severity: "error",
        segmentId: null,
        message
      });
    }
    const targetDurationMs = mediaById.get(group.targetMediaId)?.durationMs ?? null;
    if (targetDurationMs !== null) {
      const overflowCount = group.entries.filter(
        (entry) => entry.finalTimeMs >= targetDurationMs
      ).length;
      if (overflowCount > 0) {
        const message = `${group.targetName} 有 ${overflowCount} 条弹幕投影后超出原片时长，请复核来源范围或目标起点。`;
        group.warnings.push(message);
        issues.push({
          id: `target-overflow-${group.targetMediaId}`,
          severity: "error",
          segmentId: null,
          message
        });
      }
    }
  }
  groups.sort((left, right) => compareGroupOrder(left, right));

  const ignoredItemCount = countItemsInSegments(usableIgnoredSegments, assetsById);
  const unexpectedUnmappedItemCount = countUnmappedItems(
    assetsById,
    coveredItemKeys,
    usableIgnoredSegments
  );
  const sourceOnlyItemCount = Array.from(sourceOnlyItemKeys).filter(
    (itemKey) => !mappedItemKeys.has(itemKey)
  ).length;
  const unmappedItemCount = unexpectedUnmappedItemCount + sourceOnlyItemCount;
  if (sourceOnlyItemCount > 0) {
    issues.push({
      id: "source-only-items",
      severity: "warning",
      segmentId: null,
      message: `${sourceOnlyItemCount} 条弹幕位于参考视频独有内容中，已按确认时间图明确舍弃，不会触发来源段覆盖错误。`
    });
  }
  if (unexpectedUnmappedItemCount > 0) {
    issues.push({
      id: "unmapped-items",
      severity: "warning",
      segmentId: null,
      message: `${unexpectedUnmappedItemCount} 条弹幕不在任何已确认来源段内，本次不会导出并已计入未映射统计。原 XML 可以长于当前导出范围，此项不会阻断导出；如需保留这些弹幕，请补充对应来源段。`
    });
  }

  const hasBlocker = issues.some((issue) => issue.severity === "error");
  const status: SourceProjectionStatus = hasBlocker
    ? "blocked"
    : issues.length > 0 || disabledTotal > 0
      ? "readyWithWarnings"
      : "ready";

  return {
    status: groups.length === 0 && hasBlocker ? "blocked" : status,
    groups,
    issues,
    contentSegmentCount: contentSegments.length,
    ignoredSegmentCount: ignoredSegments.length,
    projectedItemCount,
    ignoredItemCount,
    sourceOnlyItemCount,
    unexpectedUnmappedItemCount,
    unmappedItemCount
  };
}

function findOverlappingProjectionSegments(
  segments: readonly DanmakuSourceSegment[]
): Array<[DanmakuSourceSegment, DanmakuSourceSegment]> {
  const groups = new Map<string, DanmakuSourceSegment[]>();
  segments.forEach((segment) => {
    if (!segment.assetId || !segment.sourceMediaId) {
      return;
    }
    const key = `${segment.assetId}\u0000${segment.sourceMediaId}`;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  });
  const overlaps: Array<[DanmakuSourceSegment, DanmakuSourceSegment]> = [];
  groups.forEach((group) => {
    const sorted = [...group].sort(
      (left, right) =>
        left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
    );
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      const left = sorted[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const right = sorted[rightIndex];
        if (right.sourceStartMs >= left.sourceEndMs) {
          break;
        }
        const conflictsWithIgnored = left.kind === "ignored" || right.kind === "ignored";
        const duplicatesSameTarget =
          left.kind === "content" &&
          right.kind === "content" &&
          Boolean(left.targetMediaId) &&
          left.targetMediaId === right.targetMediaId;
        if (conflictsWithIgnored || duplicatesSameTarget) {
          overlaps.push([left, right]);
        }
      }
    }
  });
  return overlaps;
}

function findSegmentBlocker(
  segment: DanmakuSourceSegment,
  assetsById: Map<string, EditorProject["assets"][number]>,
  mediaById: Map<string, ProjectMediaReference>,
  sourceBindingByAssetId: Map<string, string>
): string | null {
  const sourceProblem = findSourceSegmentBlocker(
    segment,
    assetsById,
    mediaById,
    sourceBindingByAssetId
  );
  if (sourceProblem) {
    return sourceProblem;
  }
  if (!segment.targetMediaId) {
    return `${segment.label} 还没有选择目标原片，无法投影。`;
  }
  if (mediaById.get(segment.targetMediaId)?.role !== "targetOriginal") {
    return `${segment.label} 的目标素材不是原片角色，无法投影。`;
  }
  return null;
}

function findTimeMapBlocker(
  segment: DanmakuSourceSegment,
  timeMap: MediaTimeMap | undefined,
  mediaById: Map<string, ProjectMediaReference>
): string | null {
  if (!timeMap) {
    return `${segment.label} 引用的可验证时间图不存在，无法导出。`;
  }
  if (timeMap.state !== "confirmed") {
    return `${segment.label} 引用的时间图尚未确认（当前状态：${timeMap.state}），无法导出。`;
  }
  if (
    timeMap.sourceMediaId !== segment.sourceMediaId ||
    timeMap.targetMediaId !== segment.targetMediaId ||
    timeMap.sourceStartMs !== segment.sourceStartMs ||
    timeMap.sourceEndMs !== segment.sourceEndMs ||
    timeMap.targetStartMs !== (segment.targetStartMs ?? 0)
  ) {
    return `${segment.label} 引用的时间图与来源素材、目标原片或分段范围不一致，无法导出。`;
  }

  const validation = validateTimeMap(timeMap.spans);
  if (!validation.valid || timeMap.spans.length === 0) {
    const detail = validation.valid
      ? "时间图没有任何分段"
      : validation.issues.map((issue) => issue.message).join("；");
    return `${segment.label} 的时间图结构无效：${detail}。`;
  }
  const incompleteSpanIndex = timeMap.spans.findIndex(
    (span) => !isCompleteTimeMapSpanEvidence(span)
  );
  if (incompleteSpanIndex >= 0) {
    return `${segment.label} 的时间图第 ${incompleteSpanIndex + 1} 段缺少独立质量或边界证据，不能用整图平均值替代逐段验证。`;
  }
  const blockedSpanIndex = timeMap.spans.findIndex(
    (span) => isCompleteTimeMapSpanEvidence(span) && span.quality.level === "blocked"
  );
  if (blockedSpanIndex >= 0) {
    return `${segment.label} 的时间图第 ${blockedSpanIndex + 1} 段质量评估已阻断，必须先重新分析或完成复核。`;
  }
  const legacySpanIndex = timeMap.spans.findIndex(
    (span) => isCompleteTimeMapSpanEvidence(span) && span.quality.level === "legacy-unverified"
  );
  if (legacySpanIndex >= 0) {
    return `${segment.label} 的时间图第 ${legacySpanIndex + 1} 段只有旧版未验证证据，必须重新分析。`;
  }

  const firstSpan = timeMap.spans[0];
  const lastSpan = timeMap.spans[timeMap.spans.length - 1];
  if (
    firstSpan.sourceStartMs !== timeMap.sourceStartMs ||
    lastSpan.sourceEndMs !== timeMap.sourceEndMs ||
    firstSpan.targetStartMs !== timeMap.targetStartMs ||
    lastSpan.targetEndMs !== timeMap.targetEndMs
  ) {
    return `${segment.label} 的时间图边界与其声明范围不一致，无法导出。`;
  }
  if (
    timeMap.spans.some(
      (span, spanIndex) =>
        span.kind === "ambiguous" &&
        readTimeMapSpanReviewDecision(timeMap, spanIndex)?.decision !== "replacement"
    )
  ) {
    return `${segment.label} 的时间图包含歧义（ambiguous）区间，必须先人工消除歧义才能导出。`;
  }

  const manualTakeoverApproved = isTimeMapManualTakeoverExportApproved(timeMap);
  const effectiveQuality = reconcileMediaTimeMapQuality(timeMap).quality;
  if (effectiveQuality.level === "review" && !manualTakeoverApproved) {
    return `${segment.label} 的时间图仍需人工复核，不能导出。`;
  }
  if (effectiveQuality.level === "blocked" && !manualTakeoverApproved) {
    return `${segment.label} 的时间图质量评估已阻断，不能导出。`;
  }
  if (effectiveQuality.level === "legacy-unverified" && !manualTakeoverApproved) {
    return `${segment.label} 的时间图由旧规则迁移且未经验证，不能导出。`;
  }
  const sourceMedia = mediaById.get(timeMap.sourceMediaId);
  const targetMedia = mediaById.get(timeMap.targetMediaId);
  if (
    !sourceMedia?.contentIdentity ||
    !targetMedia?.contentIdentity ||
    !timeMap.sourceIdentity ||
    !timeMap.targetIdentity
  ) {
    return `${segment.label} 的已验证时间图缺少当前媒体或分析时的内容身份快照，必须重新分析后才能导出。`;
  }
  if (!areMediaContentIdentitiesEqual(sourceMedia.contentIdentity, timeMap.sourceIdentity)) {
    return `${segment.label} 的 B 站参考文件已被替换或修改，原时间图已经失效，必须重新分析。`;
  }
  if (!areMediaContentIdentitiesEqual(targetMedia.contentIdentity, timeMap.targetIdentity)) {
    return `${segment.label} 的目标原片已被替换或修改，原时间图已经失效，必须重新分析。`;
  }
  return null;
}

function findSourceSegmentBlocker(
  segment: DanmakuSourceSegment,
  assetsById: Map<string, EditorProject["assets"][number]>,
  mediaById: Map<string, ProjectMediaReference>,
  sourceBindingByAssetId: Map<string, string>
): string | null {
  if (!segment.assetId || !assetsById.has(segment.assetId)) {
    return `${segment.label} 还没有关联弹幕 XML，无法投影。`;
  }
  if (
    !segment.sourceMediaId ||
    mediaById.get(segment.sourceMediaId)?.role !== "bilibiliReference"
  ) {
    return `${segment.label} 还没有关联 B 站参考素材，无法投影。`;
  }
  const boundSourceMediaId = sourceBindingByAssetId.get(segment.assetId);
  if (!boundSourceMediaId) {
    return `${segment.label} 所属 XML 尚未在素材页绑定 B 站参考素材，无法投影。`;
  }
  if (boundSourceMediaId !== segment.sourceMediaId) {
    return `${segment.label} 使用的参考素材与所属 XML 在素材页的绑定不一致，无法投影。`;
  }
  return null;
}

function ensureGroup(
  groups: Map<string, TargetProjectionGroup>,
  target: ProjectMediaReference
): TargetProjectionGroup {
  const existing = groups.get(target.id);
  if (existing) {
    return existing;
  }
  const group: TargetProjectionGroup = {
    targetMediaId: target.id,
    targetName: target.name,
    targetFileName: target.fileName,
    episodeLabel: target.episodeLabel,
    exportFileName: createExportFileName(target),
    segments: [],
    entries: [],
    disabledCount: 0,
    appliedRules: [],
    warnings: []
  };
  groups.set(target.id, group);
  return group;
}

function createExportFileName(target: ProjectMediaReference): string {
  const base = stripMediaExtension(target.fileName.trim()) || target.name.trim() || target.id;
  const sanitized = base.replace(/[\\/:*?"<>|]+/g, "_");
  return `${sanitized}.xml`;
}

function ensureUniqueExportFileNames(groups: TargetProjectionGroup[]): void {
  const groupsByName = new Map<string, TargetProjectionGroup[]>();
  groups.forEach((group) => {
    const key = group.exportFileName.toLocaleLowerCase("en-US");
    groupsByName.set(key, [...(groupsByName.get(key) ?? []), group]);
  });
  const usedNames = new Set(
    [...groupsByName.entries()]
      .filter(([, sameNameGroups]) => sameNameGroups.length === 1)
      .map(([name]) => name)
  );
  groupsByName.forEach((duplicates) => {
    if (duplicates.length < 2) {
      return;
    }
    duplicates
      .sort((left, right) => left.targetMediaId.localeCompare(right.targetMediaId))
      .forEach((group) => {
        const base = group.exportFileName.replace(/\.xml$/i, "");
        let sequence = 1;
        let nextName = `${base}-${sequence}.xml`;
        while (usedNames.has(nextName.toLocaleLowerCase("en-US"))) {
          sequence += 1;
          nextName = `${base}-${sequence}.xml`;
        }
        group.exportFileName = nextName;
        usedNames.add(nextName.toLocaleLowerCase("en-US"));
        group.warnings.push("存在同名原片，导出文件名已自动添加序号以避免覆盖。");
      });
  });
}

function stripMediaExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 &&
    SUPPORTED_MEDIA_FILE_EXTENSIONS.some(
      (ext) => ext === fileName.slice(index + 1).toLowerCase()
    )
    ? fileName.slice(0, index)
    : fileName;
}

function countItemsInSegments(
  segments: readonly DanmakuSourceSegment[],
  assetsById: Map<string, EditorProject["assets"][number]>
): number {
  let count = 0;
  for (const segment of segments) {
    if (!segment.assetId) {
      continue;
    }
    const asset = assetsById.get(segment.assetId);
    if (!asset) {
      continue;
    }
    count += asset.items.filter(
      (item) =>
        item.sourceTimeMs >= segment.sourceStartMs && item.sourceTimeMs < segment.sourceEndMs
    ).length;
  }
  return count;
}

function countUnmappedItems(
  assetsById: Map<string, EditorProject["assets"][number]>,
  coveredItemKeys: ReadonlySet<string>,
  ignoredSegments: readonly DanmakuSourceSegment[]
): number {
  let unmapped = 0;
  for (const asset of assetsById.values()) {
    const assetId = asset.id;
    const assetIgnoredSegments = ignoredSegments.filter(
      (segment) => segment.assetId === assetId
    );
    for (const item of asset.items) {
      const coveredByIgnoredSegment = assetIgnoredSegments.some(
        (segment) =>
          item.sourceTimeMs >= segment.sourceStartMs && item.sourceTimeMs < segment.sourceEndMs
      );
      if (!coveredItemKeys.has(createItemKey(asset.id, item.id)) && !coveredByIgnoredSegment) {
        unmapped += 1;
      }
    }
  }
  return unmapped;
}

function createItemKey(assetId: string, itemId: string): string {
  return `${assetId}\u0000${itemId}`;
}

function compareGroupOrder(left: TargetProjectionGroup, right: TargetProjectionGroup): number {
  const leftLabel = left.episodeLabel ?? left.targetName;
  const rightLabel = right.episodeLabel ?? right.targetName;
  return leftLabel.localeCompare(rightLabel, "zh-CN", { numeric: true });
}
import { SUPPORTED_MEDIA_FILE_EXTENSIONS } from "../project/mediaFormat";
