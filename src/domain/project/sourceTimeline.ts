import type { BatchMergePlan } from "../danmaku/batchMerge";
import { formatTimecode, type Milliseconds } from "../shared/time";
import { statusLabel, type WorkspaceStatusId } from "../shared/statusVocabulary";
import { createSeasonEpisodeKey } from "./seasonEpisodeBinding";
import type {
  DanmakuSourceSegment,
  DanmakuSourceSegmentKind,
  EditorProject,
  SegmentTimingRule
} from "./types";

export interface SegmentTimingRuleDraft {
  id?: string;
  sourceAtMs: Milliseconds;
  gapMs: Milliseconds;
  note?: string;
}

export interface DanmakuSourceSegmentDraft {
  label?: string;
  kind: DanmakuSourceSegmentKind;
  assetId: string | null;
  sourceMediaId: string | null;
  sourceStartMs: Milliseconds;
  sourceEndMs: Milliseconds;
  targetMediaId: string | null;
  targetStartMs?: Milliseconds | null;
  timingRules?: SegmentTimingRuleDraft[];
  timeMapId?: string | null;
  episodeKey: string | null;
  episodeLabel: string | null;
  note?: string;
}

export type DanmakuSourceSegmentPatch = Partial<DanmakuSourceSegmentDraft>;

export type SourceTimelineStatus = "waiting" | "needsSegments" | "needsReview" | "ready";

export interface SourceTimelineMetric {
  label: string;
  value: string;
}

export interface SourceTimelineFinding {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
}

export interface SourceTimelineSummary {
  status: SourceTimelineStatus;
  statusId: WorkspaceStatusId;
  statusLabel: string;
  headline: string;
  nextActionLabel: string;
  metrics: SourceTimelineMetric[];
  findings: SourceTimelineFinding[];
}

export function createDanmakuSourceSegment(
  id: string,
  draft: DanmakuSourceSegmentDraft,
  timestamp = new Date().toISOString()
): DanmakuSourceSegment {
  const normalized = normalizeSegmentDraft(draft);
  return {
    id,
    ...normalized,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function updateDanmakuSourceSegment(
  segment: DanmakuSourceSegment,
  patch: DanmakuSourceSegmentPatch,
  timestamp = new Date().toISOString()
): DanmakuSourceSegment {
  const normalized = normalizeSegmentDraft({
    label: patch.label ?? segment.label,
    kind: patch.kind ?? segment.kind,
    assetId: patch.assetId !== undefined ? patch.assetId : segment.assetId,
    sourceMediaId:
      patch.sourceMediaId !== undefined ? patch.sourceMediaId : segment.sourceMediaId,
    sourceStartMs: patch.sourceStartMs ?? segment.sourceStartMs,
    sourceEndMs: patch.sourceEndMs ?? segment.sourceEndMs,
    targetMediaId:
      patch.targetMediaId !== undefined ? patch.targetMediaId : segment.targetMediaId,
    targetStartMs:
      patch.targetStartMs !== undefined ? patch.targetStartMs : segment.targetStartMs,
    timingRules: patch.timingRules !== undefined ? patch.timingRules : segment.timingRules,
    timeMapId: patch.timeMapId !== undefined ? patch.timeMapId : segment.timeMapId,
    episodeKey: patch.episodeKey !== undefined ? patch.episodeKey : segment.episodeKey,
    episodeLabel: patch.episodeLabel !== undefined ? patch.episodeLabel : segment.episodeLabel,
    note: patch.note ?? segment.note
  });
  if (segment.timeMapId && hasTimeMapOwnedStructureChanged(segment, normalized)) {
    throw new Error(
      "该来源段由已确认时间图管理，不能在旧来源段表单中修改用途、素材、范围、目标起点或删减修正；请先在匹配页撤销确认，再重新分析。"
    );
  }
  return {
    ...segment,
    ...normalized,
    updatedAt: timestamp
  };
}

function hasTimeMapOwnedStructureChanged(
  segment: DanmakuSourceSegment,
  normalized: Omit<DanmakuSourceSegment, "id" | "createdAt" | "updatedAt">
): boolean {
  return (
    normalized.kind !== segment.kind ||
    normalized.assetId !== segment.assetId ||
    normalized.sourceMediaId !== segment.sourceMediaId ||
    normalized.sourceStartMs !== segment.sourceStartMs ||
    normalized.sourceEndMs !== segment.sourceEndMs ||
    normalized.targetMediaId !== segment.targetMediaId ||
    normalized.targetStartMs !== segment.targetStartMs ||
    normalized.timeMapId !== segment.timeMapId ||
    !areTimingRulesEqual(normalized.timingRules, segment.timingRules)
  );
}

function areTimingRulesEqual(
  left: readonly SegmentTimingRule[],
  right: readonly SegmentTimingRule[]
): boolean {
  return (
    left.length === right.length &&
    left.every((rule, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        rule.id === other.id &&
        rule.sourceAtMs === other.sourceAtMs &&
        rule.gapMs === other.gapMs &&
        rule.note === other.note
      );
    })
  );
}

export function createSourceTimelineSummary(
  project: EditorProject,
  plan: BatchMergePlan
): SourceTimelineSummary {
  const segments = sortSegments(project.danmakuSourceSegments);
  const contentSegments = segments.filter((segment) => segment.kind === "content");
  const ignoredSegments = segments.filter((segment) => segment.kind === "ignored");
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const episodeLabelsByKey = new Map(
    plan.episodes.map((episode) => [createSeasonEpisodeKey(episode), episode.label])
  );
  const mappedTargetMediaIds = new Set(
    contentSegments
      .map((segment) => segment.targetMediaId)
      .filter((targetMediaId): targetMediaId is string => Boolean(targetMediaId))
  );
  const findings: SourceTimelineFinding[] = [];

  if (project.assets.length === 0) {
    findings.push({
      id: "no-assets",
      severity: "info",
      title: "等待 XML",
      detail: "导入 B 站 XML 后，再标注哪些弹幕时间范围对应原片正片。"
    });
  } else if (segments.length === 0) {
    findings.push({
      id: "no-source-segments",
      severity: "warning",
      title: "尚未标注来源时间轴",
      detail: "请把 B 站/XML 时间轴上的正片范围、前后无意义片段或空白范围标出来。"
    });
  }

  segments
    .filter((segment) => !segment.assetId || !assetsById.has(segment.assetId))
    .forEach((segment) => {
      findings.push({
        id: `segment-without-asset-${segment.id}`,
        severity: "error",
        title: "来源段未选择 XML",
        detail: `${segment.label} 还没有明确属于哪一个 XML。`
      });
    });

  segments
    .filter(
      (segment) =>
        !segment.sourceMediaId ||
        mediaById.get(segment.sourceMediaId)?.role !== "bilibiliReference"
    )
    .forEach((segment) => {
      findings.push({
        id: `segment-without-source-media-${segment.id}`,
        severity: "error",
        title: "来源段未选择 B 站参考素材",
        detail: `${segment.label} 需要选择具体的 B 站参考视频，不能使用原片素材作为来源。`
      });
    });

  contentSegments
    .filter((segment) => !segment.targetMediaId)
    .forEach((segment) => {
      findings.push({
        id: `content-without-target-media-${segment.id}`,
        severity: "warning",
        title: "正片段未选择目标原片",
        detail: `${segment.label} 还没有指向具体原片素材，后续无法可靠投影到原片时间轴。`
      });
    });

  contentSegments
    .filter(
      (segment) =>
        segment.targetMediaId && mediaById.get(segment.targetMediaId)?.role !== "targetOriginal"
    )
    .forEach((segment) => {
      findings.push({
        id: `content-invalid-target-media-${segment.id}`,
        severity: "error",
        title: "来源段目标素材角色错误",
        detail: `${segment.label} 的目标只能选择原片素材。`
      });
    });

  segments
    .filter((segment) => {
      const sourceMedia = segment.sourceMediaId ? mediaById.get(segment.sourceMediaId) : null;
      return Boolean(
        sourceMedia &&
        sourceMedia.role === "bilibiliReference" &&
        sourceMedia.durationMs !== null &&
        segment.sourceEndMs > sourceMedia.durationMs
      );
    })
    .forEach((segment) => {
      findings.push({
        id: `segment-out-of-source-media-range-${segment.id}`,
        severity: "warning",
        title: "来源段超出参考素材时长",
        detail: `${segment.label} 的结束时间超过所选 B 站参考素材已知时长，请确认元数据或重新连接。`
      });
    });

  contentSegments
    .filter(
      (segment) =>
        !segment.targetMediaId &&
        segment.episodeKey &&
        !episodeLabelsByKey.has(segment.episodeKey)
    )
    .forEach((segment) => {
      findings.push({
        id: `unknown-episode-${segment.id}`,
        severity: "warning",
        title: "内容段关联的分集已不存在",
        detail: `${segment.label} 指向 ${segment.episodeLabel ?? segment.episodeKey}，但当前分集草案里没有这个输出。`
      });
    });

  collectOverlaps(segments).forEach(([left, right]) => {
    findings.push({
      id: `overlap-${left.id}-${right.id}`,
      severity: "error",
      title: "来源内容段时间重叠",
      detail: `${left.label} 与 ${right.label} 在 B 站/XML 时间轴上有重叠，请调整起止时间。`
    });
  });

  if (segments.length > 0 && findings.length === 0) {
    findings.push({
      id: "ready",
      severity: "info",
      title: "来源时间轴已记录",
      detail: "这些内容段只描述弹幕来源时间轴，不会剪切、改写或导出视频。"
    });
  }

  const status = createStatus(project.assets.length, segments.length, findings);
  const statusId = sourceTimelineStatusId(status);
  return {
    status,
    statusId,
    statusLabel: statusLabel(statusId),
    headline: statusToHeadline(status),
    nextActionLabel: createNextActionLabel(status),
    metrics: [
      { label: "内容段", value: `${contentSegments.length} 个` },
      { label: "忽略段", value: `${ignoredSegments.length} 个` },
      { label: "已关联原片", value: `${mappedTargetMediaIds.size} 个` },
      { label: "覆盖时长", value: formatTimecode(sumSegmentDuration(segments)) }
    ],
    findings
  };
}

export function parseSourceTimecode(value: string): Milliseconds | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length > 3 || parts.some((part) => part.trim().length === 0)) {
    return null;
  }
  const secondsText = parts.at(-1);
  if (!secondsText || !/^\d+(?:\.\d{1,3})?$/.test(secondsText)) {
    return null;
  }
  const wholeParts = parts.slice(0, -1);
  if (!wholeParts.every((part) => /^\d+$/.test(part))) {
    return null;
  }
  const [secondsWholeText, millisecondsText = ""] = secondsText.split(".");
  const secondsWhole = Number(secondsWholeText);
  const milliseconds = Number(millisecondsText.padEnd(3, "0"));
  const minutes = wholeParts.length >= 1 ? Number(wholeParts.at(-1)) : 0;
  const hours = wholeParts.length === 2 ? Number(wholeParts[0]) : 0;
  if (
    !Number.isSafeInteger(hours) ||
    !Number.isSafeInteger(minutes) ||
    !Number.isSafeInteger(secondsWhole) ||
    !Number.isSafeInteger(milliseconds) ||
    minutes >= 60 ||
    secondsWhole >= 60
  ) {
    return null;
  }
  const totalMs = ((hours * 60 + minutes) * 60 + secondsWhole) * 1000 + milliseconds;
  return Number.isSafeInteger(totalMs) ? totalMs : null;
}

function normalizeSegmentDraft(
  draft: DanmakuSourceSegmentDraft
): Omit<DanmakuSourceSegment, "id" | "createdAt" | "updatedAt"> {
  assertFiniteMilliseconds(draft.sourceStartMs, "内容段开始时间无效。");
  assertFiniteMilliseconds(draft.sourceEndMs, "内容段结束时间无效。");
  const sourceStartMs = Math.max(0, Math.round(draft.sourceStartMs));
  const sourceEndMs = Math.max(0, Math.round(draft.sourceEndMs));
  if (sourceEndMs <= sourceStartMs) {
    throw new Error("内容段结束时间必须晚于开始时间。");
  }
  const kind = draft.kind;
  if (kind !== "content" && kind !== "ignored") {
    throw new Error("内容段类型无效。");
  }
  const assetId = normalizeOptionalText(draft.assetId);
  const sourceMediaId = normalizeOptionalText(draft.sourceMediaId);
  const targetMediaId = kind === "content" ? normalizeOptionalText(draft.targetMediaId) : null;
  const episodeKey = kind === "content" ? normalizeOptionalText(draft.episodeKey) : null;
  const episodeLabel = kind === "content" ? normalizeOptionalText(draft.episodeLabel) : null;
  const targetStartMs = kind === "content" ? normalizeTargetStart(draft.targetStartMs) : null;
  const timingRules =
    kind === "content"
      ? normalizeTimingRules(draft.timingRules ?? [], sourceStartMs, sourceEndMs)
      : [];
  const timeMapId = kind === "content" ? normalizeOptionalText(draft.timeMapId ?? null) : null;
  return {
    label: normalizeLabel(draft.label, kind, episodeLabel, sourceStartMs, sourceEndMs),
    kind,
    assetId,
    sourceMediaId,
    sourceStartMs,
    sourceEndMs,
    targetMediaId,
    targetStartMs,
    timingRules,
    timeMapId,
    episodeKey,
    episodeLabel,
    note: draft.note?.trim() ?? ""
  };
}

function normalizeTargetStart(value: Milliseconds | null | undefined): Milliseconds | null {
  if (value === null || value === undefined) {
    return null;
  }
  assertFiniteMilliseconds(value, "内容段的原片起始时间无效。");
  return Math.max(0, Math.round(value));
}

function normalizeTimingRules(
  rules: readonly SegmentTimingRuleDraft[],
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds
): SegmentTimingRule[] {
  return rules
    .map((rule, index) => {
      assertFiniteMilliseconds(rule.sourceAtMs, "删减修正点时间无效。");
      if (
        typeof rule.gapMs !== "number" ||
        !Number.isFinite(rule.gapMs) ||
        !Number.isSafeInteger(Math.round(rule.gapMs))
      ) {
        throw new Error("删减修正时长无效。");
      }
      const sourceAtMs = Math.round(rule.sourceAtMs);
      if (sourceAtMs < sourceStartMs || sourceAtMs > sourceEndMs) {
        throw new Error("删减修正点必须位于内容段范围内。");
      }
      return {
        id:
          rule.id && rule.id.trim().length > 0
            ? rule.id.trim()
            : `timing_rule_${index}_${sourceAtMs}`,
        sourceAtMs,
        gapMs: Math.round(rule.gapMs),
        note: rule.note?.trim() ?? ""
      };
    })
    .sort((left, right) => left.sourceAtMs - right.sourceAtMs);
}

function assertFiniteMilliseconds(value: Milliseconds, message: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(Math.round(value)) ||
    value < 0
  ) {
    throw new Error(message);
  }
}

function normalizeLabel(
  label: string | undefined,
  kind: DanmakuSourceSegmentKind,
  episodeLabel: string | null,
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds
): string {
  const trimmed = label?.trim() ?? "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  if (kind === "content") {
    return episodeLabel ? `${episodeLabel} 来源段` : "未关联内容段";
  }
  return `忽略范围 ${formatTimecode(sourceStartMs)} - ${formatTimecode(sourceEndMs)}`;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sortSegments(segments: readonly DanmakuSourceSegment[]): DanmakuSourceSegment[] {
  return [...segments].sort(
    (left, right) =>
      left.sourceStartMs - right.sourceStartMs || left.sourceEndMs - right.sourceEndMs
  );
}

function collectOverlaps(
  segments: readonly DanmakuSourceSegment[]
): Array<[DanmakuSourceSegment, DanmakuSourceSegment]> {
  const overlaps: Array<[DanmakuSourceSegment, DanmakuSourceSegment]> = [];
  const groups = new Map<string, DanmakuSourceSegment[]>();
  segments.forEach((segment) => {
    const key = `${segment.assetId ?? "unassigned"}:${segment.sourceMediaId ?? "unassigned"}`;
    const group = groups.get(key);
    if (group) {
      group.push(segment);
    } else {
      groups.set(key, [segment]);
    }
  });
  groups.forEach((group) => {
    const sorted = sortSegments(group);
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

function sumSegmentDuration(segments: readonly DanmakuSourceSegment[]): Milliseconds {
  return segments.reduce(
    (total, segment) => total + segment.sourceEndMs - segment.sourceStartMs,
    0
  );
}

function createStatus(
  assetCount: number,
  segmentCount: number,
  findings: readonly SourceTimelineFinding[]
): SourceTimelineStatus {
  if (assetCount === 0) {
    return "waiting";
  }
  if (segmentCount === 0) {
    return "needsSegments";
  }
  if (
    findings.some((finding) => finding.severity === "error" || finding.severity === "warning")
  ) {
    return "needsReview";
  }
  return "ready";
}

function sourceTimelineStatusId(status: SourceTimelineStatus): WorkspaceStatusId {
  if (status === "waiting") return "preparing";
  if (status === "needsSegments") return "actionRequired";
  if (status === "needsReview") return "reviewRequired";
  return "confirmed";
}

function statusToHeadline(status: SourceTimelineStatus): string {
  if (status === "waiting") {
    return "导入 XML 后开始标注弹幕来源时间轴";
  }
  if (status === "needsSegments") {
    return "把 B 站/XML 时间轴上的正片范围和无意义范围标出来";
  }
  if (status === "needsReview") {
    return "先处理重叠或未关联的来源内容段";
  }
  return "来源时间轴已经可用于后续弹幕投影复核";
}

function createNextActionLabel(status: SourceTimelineStatus): string {
  if (status === "waiting") {
    return "先导入 B 站 XML。";
  }
  if (status === "needsSegments") {
    return "新增内容段或忽略段。";
  }
  if (status === "needsReview") {
    return "修正提示中的内容段。";
  }
  return "继续逐集目标绑定或对齐复核。";
}
