import { applyCutMapping, getAppliedCutGap } from "../danmaku/timeCompensation";
import { formatMediaBindingTitle } from "../project/mediaBinding";
import type { EditorProject, MediaBinding } from "../project/types";
import { clampMilliseconds, formatTimecode, type Milliseconds } from "../shared/time";

export interface PlayerSourceComparisonInput {
  project: EditorProject;
  referenceTimeMs: Milliseconds;
  hasReferencePlaybackSource: boolean;
}

export interface PlayerSourceComparisonSummary {
  visible: boolean;
  stateLabel: string;
  referenceLabel: string;
  referenceDetail: string;
  targetLabel: string;
  targetDetail: string;
  referenceTimeLabel: string;
  targetTimeLabel: string;
  compensationLabel: string;
  compensationDetail: string;
  nextActionLabel: string;
}

export function createPlayerSourceComparisonSummary(
  input: PlayerSourceComparisonInput
): PlayerSourceComparisonSummary {
  const referenceTimeMs = clampMilliseconds(input.referenceTimeMs);
  const targetTimeMs = applyCutMapping(referenceTimeMs, input.project.cutMarkers);
  const appliedGapMs = getAppliedCutGap(referenceTimeMs, input.project.cutMarkers);
  const reference = describeReferenceSource(input.project, input.hasReferencePlaybackSource);
  const target = describeTargetSource(input.project.mediaBinding, input.project);
  const hasReference =
    input.project.assets.length > 0 ||
    Boolean(input.project.media) ||
    input.project.mediaLibrary.some((media) => media.role === "bilibiliReference");
  const hasTarget = Boolean(input.project.mediaBinding);
  return {
    visible: hasReference || hasTarget || input.project.cutMarkers.length > 0,
    stateLabel: describeComparisonState(hasReference, hasTarget),
    referenceLabel: reference.label,
    referenceDetail: reference.detail,
    targetLabel: target.label,
    targetDetail: target.detail,
    referenceTimeLabel: formatTimecode(referenceTimeMs),
    targetTimeLabel: formatTimecode(targetTimeMs),
    compensationLabel: formatSignedTimecode(appliedGapMs),
    compensationDetail: describeCompensation(input.project.cutMarkers.length, appliedGapMs),
    nextActionLabel: describeNextAction(input.project, hasReference, hasTarget)
  };
}

function describeReferenceSource(
  project: EditorProject,
  hasReferencePlaybackSource: boolean
): { label: string; detail: string } {
  if (project.media?.objectUrl && hasReferencePlaybackSource) {
    return {
      label: "B 站参考视频",
      detail: `${project.media.fileName} / 当前会话可播放`
    };
  }
  if (project.media) {
    return {
      label: "参考视频待重连",
      detail: `${project.media.fileName} / 项目不保存视频内容`
    };
  }
  const connectedReference = project.mediaLibrary.find((media) => media.role === "bilibiliReference" && media.objectUrl);
  if (connectedReference) {
    return {
      label: "B 站参考视频",
      detail: `${connectedReference.fileName} / 当前会话可播放`
    };
  }
  const reference = project.mediaLibrary.find((media) => media.role === "bilibiliReference");
  if (reference) {
    return {
      label: "参考视频待重连",
      detail: `${reference.fileName} / 项目不保存视频内容`
    };
  }
  if (project.assets.length > 0) {
    return {
      label: "B 站 XML 时间轴",
      detail: `${project.assets.length} 个 XML / ${project.clips.length} 个片段`
    };
  }
  return {
    label: "等待 B 站参考源",
    detail: "导入 XML，必要时导入删减版参考视频。"
  };
}

function describeTargetSource(
  binding: MediaBinding | null,
  project: EditorProject
): { label: string; detail: string } {
  if (!binding) {
    return {
      label: "等待目标原片",
      detail: "绑定本地或 Emby 原片后可复核目标时间。"
    };
  }
  if (binding.kind === "localFile") {
    if (binding.localPath) {
      return {
        label: "本地目标原片",
        detail: `${binding.fileName} / 本地路径可用于 mpv 和对齐`
      };
    }
    if (binding.mediaId && project.media?.id === binding.mediaId && project.media.objectUrl) {
      return {
        label: "本地目标原片",
        detail: `${binding.fileName} / 当前会话可播放，重开后需重连`
      };
    }
    const media = binding.mediaId ? project.mediaLibrary.find((candidate) => candidate.id === binding.mediaId) : null;
    if (media?.objectUrl) {
      return {
        label: "本地目标原片",
        detail: `${binding.fileName} / 当前会话可播放，重开后需重连`
      };
    }
    return {
      label: "本地目标待重连",
      detail: `${binding.fileName} / 重新导入或选择本地路径`
    };
  }
  return {
    label: "Emby 目标原片",
    detail: `${formatMediaBindingTitle(binding)} / 可授权采样，视频流播放待接入`
  };
}

function describeComparisonState(hasReference: boolean, hasTarget: boolean): string {
  if (hasReference && hasTarget) {
    return "双源对比可复核";
  }
  if (hasReference || hasTarget) {
    return "双源对比待补齐";
  }
  return "等待素材";
}

function describeCompensation(markerCount: number, appliedGapMs: Milliseconds): string {
  if (markerCount === 0) {
    return "尚未标记版本差异。";
  }
  if (appliedGapMs === 0) {
    return `${markerCount} 个版本差异，当前点之前未生效。`;
  }
  return `${markerCount} 个版本差异，当前点已应用补偿。`;
}

function describeNextAction(project: EditorProject, hasReference: boolean, hasTarget: boolean): string {
  if (!hasReference) {
    return "先导入 B 站 XML 或参考视频。";
  }
  if (!hasTarget) {
    return "绑定本地或 Emby 目标原片。";
  }
  if (project.mediaBinding?.kind === "embyItem") {
    return "可显式生成 Emby 授权流进行 mpv 预览；音频对齐也可使用授权输入。";
  }
  if (project.cutMarkers.length === 0) {
    return "试听疑似删减点，标记版本差异后会显示目标时间补偿。";
  }
  return "按目标时间复核，必要时继续微调版本差异。";
}

function formatSignedTimecode(milliseconds: Milliseconds): string {
  if (milliseconds === 0) {
    return "未补偿";
  }
  const sign = milliseconds > 0 ? "+" : "-";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}
