import type { Milliseconds } from "../shared/time";
import type {
  EmbyItemMediaBinding,
  EmbyMediaSourceSummary,
  EmbyServerReference,
  LocalFileMediaBinding,
  MediaBinding,
  MediaReference
} from "./types";

export interface EmbyItemBindingInput {
  id: string;
  name: string;
  type: string;
  seriesName: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  durationMs: Milliseconds | null;
  mediaSources: EmbyMediaSourceSummary[];
}

export function createLocalFileMediaBinding(
  id: string,
  media: MediaReference,
  linkedAt = new Date().toISOString()
): LocalFileMediaBinding {
  return {
    id,
    kind: "localFile",
    displayName: media.name || media.fileName,
    fileName: media.fileName,
    mediaId: media.id,
    localPath: null,
    runtimeMs: media.durationMs,
    linkedAt
  };
}

export function createLocalPathMediaBinding(
  id: string,
  localPath: string,
  runtimeMs: Milliseconds | null = null,
  linkedAt = new Date().toISOString()
): LocalFileMediaBinding {
  const normalizedPath = localPath.trim();
  const fileName = extractFileName(normalizedPath);
  return {
    id,
    kind: "localFile",
    displayName: stripExtension(fileName),
    fileName,
    mediaId: null,
    localPath: normalizedPath,
    runtimeMs,
    linkedAt
  };
}

export function createEmbyItemMediaBinding(
  id: string,
  item: EmbyItemBindingInput,
  server: EmbyServerReference,
  linkedAt = new Date().toISOString()
): EmbyItemMediaBinding {
  return {
    id,
    kind: "embyItem",
    displayName: createEmbyDisplayName(item),
    itemId: item.id,
    itemName: item.name,
    itemType: item.type,
    seriesName: item.seriesName,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    runtimeMs: item.durationMs,
    linkedAt,
    server: {
      serverUrl: server.serverUrl.trim(),
      pathPrefix: server.pathPrefix.trim(),
      username: server.username.trim()
    },
    mediaSources: item.mediaSources.map(normalizeMediaSourceSummary)
  };
}

export function formatMediaBindingTitle(binding: MediaBinding | null): string {
  if (!binding) {
    return "尚未绑定目标原片";
  }
  return binding.displayName.trim().length > 0 ? binding.displayName : "未命名目标原片";
}

export function formatMediaBindingSource(binding: MediaBinding | null): string {
  if (!binding) {
    return "绑定本地视频或 Emby 条目后，后续对齐、预览和导出检查会读取同一个目标来源。";
  }
  if (binding.kind === "localFile") {
    return `本地文件 / ${binding.fileName}`;
  }
  const server = binding.server.pathPrefix.trim().length > 0
    ? `${binding.server.serverUrl}${binding.server.pathPrefix}`
    : binding.server.serverUrl;
  return `Emby / ${server}`;
}

export function formatMediaBindingEpisode(binding: MediaBinding): string {
  if (binding.kind === "localFile") {
    return "本地目标原片";
  }
  const parts: string[] = [];
  if (binding.seriesName) {
    parts.push(binding.seriesName);
  }
  if (binding.seasonNumber !== null) {
    parts.push(`第 ${binding.seasonNumber} 季`);
  }
  if (binding.episodeNumber !== null) {
    parts.push(`第 ${binding.episodeNumber} 集`);
  }
  return parts.length > 0 ? parts.join(" / ") : binding.itemType;
}

export function formatMediaSourceSummary(source: EmbyMediaSourceSummary): string {
  const parts = [
    source.name,
    source.container,
    source.videoCodec,
    source.audioCodec,
    source.width && source.height ? `${source.width}x${source.height}` : null
  ].filter((part): part is string => Boolean(part && part.trim().length > 0));
  return parts.length > 0 ? parts.join(" / ") : "媒体源摘要暂缺";
}

function createEmbyDisplayName(item: EmbyItemBindingInput): string {
  const episodeParts: string[] = [];
  if (item.seriesName) {
    episodeParts.push(item.seriesName);
  }
  if (item.seasonNumber !== null && item.episodeNumber !== null) {
    episodeParts.push(`S${item.seasonNumber.toString().padStart(2, "0")}E${item.episodeNumber.toString().padStart(2, "0")}`);
  }
  episodeParts.push(item.name);
  return episodeParts.join(" / ");
}

function extractFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function normalizeMediaSourceSummary(source: EmbyMediaSourceSummary): EmbyMediaSourceSummary {
  return {
    id: normalizeOptionalString(source.id),
    name: normalizeOptionalString(source.name),
    container: normalizeOptionalString(source.container),
    videoCodec: normalizeOptionalString(source.videoCodec),
    audioCodec: normalizeOptionalString(source.audioCodec),
    width: normalizeOptionalNumber(source.width),
    height: normalizeOptionalNumber(source.height),
    bitrate: normalizeOptionalNumber(source.bitrate),
    sizeBytes: normalizeOptionalNumber(source.sizeBytes),
    runtimeMs: normalizeOptionalNumber(source.runtimeMs)
  };
}

function normalizeOptionalString(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalNumber(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}
