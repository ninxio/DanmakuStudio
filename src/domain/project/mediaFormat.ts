export const SUPPORTED_VIDEO_FILE_EXTENSIONS = [
  "mp4",
  "mkv",
  "webm",
  "mov",
  "m4v",
  "avi",
  "flv",
  "ts",
  "m2ts"
] as const;

export const SUPPORTED_AUDIO_FILE_EXTENSIONS = [
  "mp3",
  "m4a",
  "aac",
  "flac",
  "wav",
  "wave",
  "ogg",
  "oga",
  "opus",
  "wma",
  "alac",
  "aiff",
  "aif",
  "ape",
  "ac3",
  "eac3",
  "dts",
  "mka"
] as const;

export const SUPPORTED_MEDIA_FILE_EXTENSIONS = [
  ...SUPPORTED_VIDEO_FILE_EXTENSIONS,
  ...SUPPORTED_AUDIO_FILE_EXTENSIONS
] as const;

export type MediaContentKind = "video" | "audio" | "unknown";

export function classifyMediaContent(fileNameOrPath: string): MediaContentKind {
  const extension = readFileExtension(fileNameOrPath);
  if (
    SUPPORTED_VIDEO_FILE_EXTENSIONS.some((candidate) => candidate === extension)
  ) {
    return "video";
  }
  if (
    SUPPORTED_AUDIO_FILE_EXTENSIONS.some((candidate) => candidate === extension)
  ) {
    return "audio";
  }
  return "unknown";
}

export function isSupportedMediaPath(path: string): boolean {
  return classifyMediaContent(path) !== "unknown";
}

export function isAudioOnlyMedia(fileNameOrPath: string): boolean {
  return classifyMediaContent(fileNameOrPath) === "audio";
}

export function formatMediaContentKind(fileNameOrPath: string): string {
  const kind = classifyMediaContent(fileNameOrPath);
  if (kind === "audio") {
    return "纯音频";
  }
  if (kind === "video") {
    return "视频";
  }
  return "未知媒体";
}

function readFileExtension(fileNameOrPath: string): string {
  const cleanPath = fileNameOrPath.trim().split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const match = /\.([^.\\/]+)$/.exec(cleanPath);
  return match?.[1] ?? "";
}
