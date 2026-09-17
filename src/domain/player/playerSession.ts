import type { EditorProject, EmbyItemMediaBinding, MediaBinding } from "../project/types";

export type PlayerPreviewBackend = "htmlVideo" | "nativeMpv";
export type PlayerLoadState = "empty" | "loading" | "ready" | "unsupported";
export type PlayerMediaTrackType = "video" | "audio" | "subtitle" | "unknown";

export interface PlayerMediaTrack {
  id: number;
  trackType: PlayerMediaTrackType;
  title: string | null;
  language: string | null;
  codec: string | null;
  selected: boolean;
  external: boolean;
}

export interface PlayerSessionInput {
  project: EditorProject;
  isPlaying: boolean;
  backend: PlayerPreviewBackend;
  loadState: PlayerLoadState;
  hasPreviewSource: boolean;
  videoError: string | null;
  mpvConfigured: boolean;
  tracks?: readonly PlayerMediaTrack[];
}

export interface PlayerSessionSummary {
  sourceLabel: string;
  sourceDetail: string;
  backendLabel: string;
  backendDetail: string;
  playbackLabel: string;
  audioTrackLabel: string;
  subtitleTrackLabel: string;
  danmakuTrackLabel: string;
  cacheLabel: string;
  nextActionLabel: string;
  issueLabel: string | null;
}

export function createPlayerSessionSummary(input: PlayerSessionInput): PlayerSessionSummary {
  const source = describePlayerSource(input.project, input.hasPreviewSource);
  const tracks = input.tracks ?? [];
  return {
    sourceLabel: source.label,
    sourceDetail: source.detail,
    backendLabel: describeBackendLabel(input.backend),
    backendDetail: describeBackendDetail(input),
    playbackLabel: describePlayback(input),
    audioTrackLabel: describeAudioTrack(input.project.mediaBinding, input.hasPreviewSource, tracks),
    subtitleTrackLabel: describeSubtitleTrack(input.hasPreviewSource, tracks),
    danmakuTrackLabel: describeDanmakuTrack(input.project),
    cacheLabel: input.hasPreviewSource ? "音频特征缓存由对齐任务复用" : "等待媒体后可缓存特征",
    nextActionLabel: describeNextAction(input),
    issueLabel: input.videoError
  };
}

function describePlayerSource(
  project: EditorProject,
  hasPreviewSource: boolean
): { label: string; detail: string } {
  if (project.mediaBinding?.kind === "embyItem") {
    return {
      label: "Emby 目标原片",
      detail: formatEmbySourceDetail(project.mediaBinding, hasPreviewSource)
    };
  }
  if (project.mediaBinding?.kind === "localFile") {
    const binding = project.mediaBinding;
    const bindingMedia = binding.mediaId
      ? project.mediaLibrary.find((media) => media.id === binding.mediaId)
      : null;
    return {
      label: "本地目标原片",
      detail: binding.localPath
        ? `本地路径已连接：${binding.fileName}`
        : bindingMedia?.objectUrl
          ? `当前会话已连接：${binding.fileName}`
          : `需要重新连接：${binding.fileName}`
    };
  }
  if (project.media?.objectUrl) {
    return {
      label: "参考视频",
      detail: project.media.fileName
    };
  }
  if (project.media) {
    return {
      label: "媒体引用待重连",
      detail: project.media.fileName
    };
  }
  const connectedReference = project.mediaLibrary.find((media) => media.role === "bilibiliReference" && media.objectUrl);
  if (connectedReference) {
    return {
      label: "B 站参考视频",
      detail: connectedReference.fileName
    };
  }
  const reconnectReference = project.mediaLibrary.find(
    (media) => media.role === "bilibiliReference" && media.connectionState === "needsReconnect"
  );
  if (reconnectReference) {
    return {
      label: "媒体引用待重连",
      detail: reconnectReference.fileName
    };
  }
  return {
    label: "尚未连接",
    detail: "导入参考视频或绑定目标原片后开始预览。"
  };
}

function formatEmbySourceDetail(binding: EmbyItemMediaBinding, hasPreviewSource: boolean): string {
  const episodeParts = [
    binding.seriesName,
    binding.seasonNumber === null ? null : `第 ${binding.seasonNumber} 季`,
    binding.episodeNumber === null ? null : `第 ${binding.episodeNumber} 集`
  ].filter((part): part is string => Boolean(part));
  const mediaSource = binding.mediaSources[0];
  const codecParts = [mediaSource?.container, mediaSource?.videoCodec, mediaSource?.audioCodec].filter(
    (part): part is string => Boolean(part)
  );
  const prefix = episodeParts.length > 0 ? `${episodeParts.join(" / ")} / ` : "";
  const suffix = codecParts.length > 0 ? ` / ${codecParts.join(" / ")}` : "";
  return hasPreviewSource
    ? `${prefix}${binding.itemName}${suffix}`
    : `${prefix}${binding.itemName}${suffix}；可用本次会话授权流或本地路径接入预览。`;
}

function describeBackendLabel(backend: PlayerPreviewBackend): string {
  return backend === "nativeMpv" ? "应用内 libmpv" : "HTML Video";
}

function describeBackendDetail(input: PlayerSessionInput): string {
  if (input.backend === "nativeMpv") {
    return input.mpvConfigured
      ? "进程内 libmpv 后端已配置"
      : "需要先在设置中心配置 libmpv";
  }
  return "浏览器内置预览，适合 MP4/WebM fallback";
}

function describePlayback(input: PlayerSessionInput): string {
  if (input.videoError) {
    return "格式不支持";
  }
  if (input.loadState === "loading") {
    return "正在载入";
  }
  if (input.loadState === "ready") {
    return input.isPlaying ? "播放中" : "已就绪";
  }
  if (input.loadState === "unsupported") {
    return "格式不支持";
  }
  return "等待媒体";
}

function describeAudioTrack(
  binding: MediaBinding | null,
  hasPreviewSource: boolean,
  tracks: readonly PlayerMediaTrack[]
): string {
  const audioTracks = tracks.filter((track) => track.trackType === "audio");
  const selectedAudio = audioTracks.find((track) => track.selected) ?? audioTracks[0] ?? null;
  if (selectedAudio) {
    return `当前音轨：${formatTrackLabel(selectedAudio)}`;
  }
  if (binding?.kind === "embyItem") {
    const audioCodec = binding.mediaSources.find((source) => source.audioCodec)?.audioCodec;
    return audioCodec ? `Emby 元数据：${audioCodec}` : "Emby 音轨元数据暂缺";
  }
  return hasPreviewSource ? "由播放后端读取" : "等待媒体";
}

function describeSubtitleTrack(hasPreviewSource: boolean, tracks: readonly PlayerMediaTrack[]): string {
  const subtitleTracks = tracks.filter((track) => track.trackType === "subtitle");
  const selectedSubtitle = subtitleTracks.find((track) => track.selected) ?? null;
  if (selectedSubtitle) {
    return `当前字幕：${formatTrackLabel(selectedSubtitle)}`;
  }
  if (subtitleTracks.length > 0) {
    return `${subtitleTracks.length} 条字幕轨可选`;
  }
  return hasPreviewSource ? "未检测到字幕轨" : "等待媒体";
}

function formatTrackLabel(track: PlayerMediaTrack): string {
  const parts = [track.title, track.language, track.codec].filter(
    (part): part is string => Boolean(part && part.trim().length > 0)
  );
  return parts.length > 0 ? parts.join(" / ") : `#${track.id}`;
}

function describeDanmakuTrack(project: EditorProject): string {
  if (!project.preview.danmakuVisible) {
    return "弹幕轨已隐藏";
  }
  if (project.assets.length === 0) {
    return "等待 XML 弹幕";
  }
  return `${project.assets.length} 个 XML / ${project.clips.length} 个片段`;
}

function describeNextAction(input: PlayerSessionInput): string {
  if (input.videoError) {
    return "改用 MP4/WebM、本地路径或 libmpv 后端。";
  }
  if (!input.project.media && !input.project.mediaBinding) {
    return "导入参考视频或绑定目标原片。";
  }
  if (input.project.mediaBinding?.kind === "embyItem" && !input.hasPreviewSource) {
    return "音频对齐可使用 Emby 授权输入；预览可使用 Emby 授权流或本地路径。";
  }
  if (input.project.mediaBinding?.kind === "localFile" && !input.hasPreviewSource) {
    return "重新导入参考视频，或在目标原片中选择本地路径。";
  }
  if (input.loadState === "loading") {
    return "等待播放器载入完成。";
  }
  if (input.loadState === "ready") {
    return "播放预览、标记版本差异或运行对齐。";
  }
  return "确认媒体路径后开始预览。";
}
