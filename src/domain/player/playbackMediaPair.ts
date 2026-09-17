import type { ProjectMediaReference } from "../project/types";
import { classifyMediaContent, type MediaContentKind } from "../project/mediaFormat";
import type { PlayerBackendPreference, PlayerMediaSource } from "./playerEngine";

export type PlaybackBackend = "htmlVideo" | "nativeMpv";

export interface PlaybackMediaPair {
  available: boolean;
  backend: PlaybackBackend | null;
  source: PlayerMediaSource | null;
  target: PlayerMediaSource | null;
  sourceContentKind: MediaContentKind | null;
  targetContentKind: MediaContentKind | null;
  message: string;
}

export function resolvePlaybackMediaPair(
  sourceMedia: ProjectMediaReference | null | undefined,
  targetMedia: ProjectMediaReference | null | undefined,
  preferredBackend: PlayerBackendPreference,
  mpvPath: string
): PlaybackMediaPair {
  if (!sourceMedia || !targetMedia) {
    return unavailablePair(
      "候选引用的参考素材或原片已不存在，无法启动 A/B 复核。",
      sourceMedia,
      targetMedia
    );
  }
  const hasHtmlPair = Boolean(sourceMedia.objectUrl && targetMedia.objectUrl);
  const hasMpvPair = Boolean(sourceMedia.localPath?.trim() && targetMedia.localPath?.trim());
  const htmlLikelySupported =
    isLikelyHtmlMediaFile(sourceMedia.fileName) && isLikelyHtmlMediaFile(targetMedia.fileName);
  const chooseMpv =
    hasMpvPair &&
    (preferredBackend === "nativeMpv" ||
      !hasHtmlPair ||
      // “HTML Video” is a preference, not permission to route known-incompatible
      // MKV/complex containers into WebView and leave the user with a black box.
      // When both real local paths and libmpv are available, safety wins.
      !htmlLikelySupported);

  if (chooseMpv) {
    return {
      available: true,
      backend: "nativeMpv",
      source: {
        kind: "file",
        name: sourceMedia.name,
        url: sourceMedia.localPath?.trim() ?? ""
      },
      target: {
        kind: "file",
        name: targetMedia.name,
        url: targetMedia.localPath?.trim() ?? ""
      },
      sourceContentKind: classifyMediaContent(sourceMedia.fileName),
      targetContentKind: classifyMediaContent(targetMedia.fileName),
      message:
        preferredBackend === "htmlVideo" && !htmlLikelySupported
          ? "所选媒体包含 HTML Video 通常无法播放的格式，已自动改用应用内 libmpv。"
          : mpvPath.trim()
            ? "使用配置的 libmpv 读取本地媒体。"
            : "自动查找 libmpv，使用本地媒体进行 A/B 播放。"
    };
  }

  if (hasHtmlPair) {
    return {
      available: true,
      backend: "htmlVideo",
      source: { kind: "url", name: sourceMedia.name, url: sourceMedia.objectUrl ?? "" },
      target: { kind: "url", name: targetMedia.name, url: targetMedia.objectUrl ?? "" },
      sourceContentKind: classifyMediaContent(sourceMedia.fileName),
      targetContentKind: classifyMediaContent(targetMedia.fileName),
      message:
        "使用本次导入会话中的两条媒体连接内嵌播放；重新打开项目后如连接失效，请回素材页重新连接。"
    };
  }

  if (hasMpvPair) {
    return {
      available: true,
      backend: "nativeMpv",
      source: {
        kind: "file",
        name: sourceMedia.name,
        url: sourceMedia.localPath?.trim() ?? ""
      },
      target: {
        kind: "file",
        name: targetMedia.name,
        url: targetMedia.localPath?.trim() ?? ""
      },
      sourceContentKind: classifyMediaContent(sourceMedia.fileName),
      targetContentKind: classifyMediaContent(targetMedia.fileName),
      message: "HTML 媒体连接不可用，已改用进程内 libmpv 读取两条本地路径。"
    };
  }

  const missing: string[] = [];
  if (!sourceMedia.objectUrl && !sourceMedia.localPath?.trim()) missing.push("参考素材未连接");
  if (!targetMedia.objectUrl && !targetMedia.localPath?.trim()) missing.push("原片未连接");
  return unavailablePair(
    `${missing.join("；") || "两条媒体没有共同可用的播放后端"}。请回素材页重新连接，或在设置中心配置 libmpv。`,
    sourceMedia,
    targetMedia
  );
}

export function isLikelyHtmlMediaFile(fileName: string): boolean {
  return /\.(mp4|m4v|webm|ogv|ogg|oga|opus|mp3|m4a|aac|wav|wave|flac)$/i.test(fileName.trim());
}

function unavailablePair(
  message: string,
  sourceMedia?: ProjectMediaReference | null,
  targetMedia?: ProjectMediaReference | null
): PlaybackMediaPair {
  return {
    available: false,
    backend: null,
    source: null,
    target: null,
    sourceContentKind: sourceMedia ? classifyMediaContent(sourceMedia.fileName) : null,
    targetContentKind: targetMedia ? classifyMediaContent(targetMedia.fileName) : null,
    message
  };
}
