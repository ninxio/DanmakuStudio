import type { PlayerLoadState, PlayerPreviewBackend } from "./playerSession";

export const PLAYER_SEEK_SYNC_TOLERANCE_MS = 240;

export type PlayerReliabilitySourceKind = "none" | "localObject" | "localPath" | "embyStream";

export interface PlayerReliabilityInput {
  backend: PlayerPreviewBackend;
  loadState: PlayerLoadState;
  hasPreviewSource: boolean;
  sourceKind: PlayerReliabilitySourceKind;
  videoError: string | null;
  mpvConfigured: boolean;
}

export interface PlayerReliabilitySummary {
  statusLabel: string;
  performanceTargetLabel: string;
  performanceStateLabel: string;
  cachePolicyLabel: string;
  cacheDetail: string;
  recoveryLabel: string;
  recoveryDetail: string;
}

export function createPlayerReliabilitySummary(input: PlayerReliabilityInput): PlayerReliabilitySummary {
  return {
    statusLabel: describeStatus(input),
    performanceTargetLabel: `同步目标 ${PLAYER_SEEK_SYNC_TOLERANCE_MS}ms 内`,
    performanceStateLabel: describePerformanceState(input),
    cachePolicyLabel: describeCachePolicy(input.sourceKind),
    cacheDetail: describeCacheDetail(input.sourceKind),
    recoveryLabel: describeRecoveryLabel(input),
    recoveryDetail: describeRecoveryDetail(input)
  };
}

function describeStatus(input: PlayerReliabilityInput): string {
  if (input.videoError || input.loadState === "unsupported") {
    return "需要恢复";
  }
  if (input.loadState === "ready" && input.hasPreviewSource) {
    return "可靠性正常";
  }
  if (input.loadState === "loading") {
    return "正在确认";
  }
  return "等待媒体";
}

function describePerformanceState(input: PlayerReliabilityInput): string {
  if (input.videoError || input.loadState === "unsupported") {
    return "当前不能同步播放头";
  }
  if (!input.hasPreviewSource) {
    return "导入或绑定媒体后开始同步";
  }
  if (input.loadState === "loading") {
    return "载入后按目标纠偏";
  }
  const backendLabel = input.backend === "nativeMpv" ? "mpv" : "HTML Video";
  return `${backendLabel} 超过目标偏差时主动纠偏`;
}

function describeCachePolicy(sourceKind: PlayerReliabilitySourceKind): string {
  if (sourceKind === "embyStream") {
    return "临时流不落盘";
  }
  if (sourceKind === "localPath") {
    return "本地路径可复用";
  }
  if (sourceKind === "localObject") {
    return "对象 URL 不持久化";
  }
  return "等待媒体后可缓存";
}

function describeCacheDetail(sourceKind: PlayerReliabilitySourceKind): string {
  if (sourceKind === "embyStream") {
    return "Emby URL 只在本次会话内使用；音频特征缓存使用遮蔽 key。";
  }
  if (sourceKind === "localPath") {
    return "音频特征按文件状态、FFmpeg 路径和参数复用。";
  }
  if (sourceKind === "localObject") {
    return "项目只保存媒体引用，浏览器播放地址关闭后失效。";
  }
  return "有媒体后再建立播放状态和音频特征缓存。";
}

function describeRecoveryLabel(input: PlayerReliabilityInput): string {
  if (input.videoError || input.loadState === "unsupported") {
    return "已阻断静默失败";
  }
  if (!input.hasPreviewSource) {
    return "需要接入媒体";
  }
  if (input.sourceKind === "embyStream") {
    return "可重新生成授权流";
  }
  if (input.backend === "nativeMpv" && !input.mpvConfigured) {
    return "需要配置 mpv";
  }
  return "可继续复核";
}

function describeRecoveryDetail(input: PlayerReliabilityInput): string {
  if (input.videoError || input.loadState === "unsupported") {
    return "改用 MP4/WebM、本地路径或 mpv 后端。";
  }
  if (!input.hasPreviewSource) {
    return "导入参考视频、绑定本地路径，或为 Emby 目标生成授权流。";
  }
  if (input.sourceKind === "embyStream") {
    return "授权过期或网络失败时，可重新连接 Emby 后再生成本次会话流。";
  }
  if (input.loadState === "loading") {
    return "等待播放器载入；失败会显示可处理原因。";
  }
  return "继续播放预览、标记版本差异或运行对齐。";
}
