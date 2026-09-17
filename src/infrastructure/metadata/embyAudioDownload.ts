import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EmbyAudioDownloadProfile } from "./embyClient";

export type EmbyAudioDownloadStrategy = "serverAudio" | "directVideoLocalExtract";

export interface EmbyAudioDownloadRequest {
  requestId: string;
  url: string;
  accessToken: string;
  cacheIdentity: string;
  displayName: string;
  profile: EmbyAudioDownloadProfile;
  strategy: EmbyAudioDownloadStrategy;
  audioStreamIndex: number | null;
  ffmpegPath: string | null;
}

export interface EmbyAudioDownloadResult {
  localPath: string;
  sizeBytes: number;
  cacheHit: boolean;
}

export interface EmbyAudioDownloadProgress {
  requestId: string;
  receivedBytes: number;
  totalBytes: number | null;
}

export interface EmbyAudioCacheStatus {
  fileCount: number;
  totalBytes: number;
  directoryPath: string;
}

export interface EmbyAudioCacheClearReceipt {
  removedFiles: number;
  removedBytes: number;
  after: EmbyAudioCacheStatus;
}

export type EmbyAudioDownloadInvoker = (
  request: EmbyAudioDownloadRequest
) => Promise<EmbyAudioDownloadResult>;

export async function downloadEmbyAudio(
  request: EmbyAudioDownloadRequest,
  invoker: EmbyAudioDownloadInvoker = defaultDownloadInvoker
): Promise<EmbyAudioDownloadResult> {
  if (invoker === defaultDownloadInvoker && !isTauri()) {
    throw new Error("Emby 音频缓存只支持桌面版。");
  }
  if (!request.requestId.trim() || !request.cacheIdentity.trim()) {
    throw new Error("Emby 音频下载请求缺少稳定身份。");
  }
  try {
    return await invoker(request);
  } catch (error) {
    throw new Error(`Emby 音频获取失败：${formatFailure(error)}`);
  }
}

export async function cancelEmbyAudioDownload(requestId: string): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  return invoke<boolean>("cancel_emby_audio_download", { requestId });
}

export async function getEmbyAudioCacheStatus(): Promise<EmbyAudioCacheStatus> {
  if (!isTauri()) {
    return { fileCount: 0, totalBytes: 0, directoryPath: "" };
  }
  return invoke<EmbyAudioCacheStatus>("get_emby_audio_cache_status");
}

export async function clearEmbyAudioCache(): Promise<EmbyAudioCacheClearReceipt> {
  if (!isTauri()) {
    return {
      removedFiles: 0,
      removedBytes: 0,
      after: { fileCount: 0, totalBytes: 0, directoryPath: "" }
    };
  }
  return invoke<EmbyAudioCacheClearReceipt>("clear_emby_audio_cache");
}

export async function listenToEmbyAudioDownloadProgress(
  listener: (progress: EmbyAudioDownloadProgress) => void
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => undefined;
  }
  return listen<EmbyAudioDownloadProgress>("emby-audio-download-progress", (event) => {
    listener(event.payload);
  });
}

function defaultDownloadInvoker(
  request: EmbyAudioDownloadRequest
): Promise<EmbyAudioDownloadResult> {
  return invoke<EmbyAudioDownloadResult>("download_emby_audio", { request });
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
