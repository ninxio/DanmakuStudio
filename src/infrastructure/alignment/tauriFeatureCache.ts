import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AlignmentFeatureCacheBucketStatus {
  memoryEntries: number;
  persistentEntries: number;
  persistentBytes: number;
  maxPersistentEntries: number;
  maxPersistentBytes: number;
  directory: string | null;
}

export interface AlignmentFeatureCacheStatus {
  coarse: AlignmentFeatureCacheBucketStatus;
  finePcm: AlignmentFeatureCacheBucketStatus;
  visual: AlignmentFeatureCacheBucketStatus;
}

export interface AlignmentFeatureCacheClearReceipt {
  removedFiles: number;
  removedBytes: number;
  before: AlignmentFeatureCacheStatus;
  after: AlignmentFeatureCacheStatus;
}

export type AlignmentFeatureCacheStatusInvoker = () => Promise<AlignmentFeatureCacheStatus>;
export type AlignmentFeatureCacheClearInvoker = () => Promise<AlignmentFeatureCacheClearReceipt>;

export async function getAlignmentFeatureCacheStatus(
  invoker: AlignmentFeatureCacheStatusInvoker = defaultStatusInvoker
): Promise<AlignmentFeatureCacheStatus> {
  ensureDesktop(invoker === defaultStatusInvoker);
  try {
    return await invoker();
  } catch (error: unknown) {
    throw new Error(`读取特征缓存状态失败：${formatFailure(error)}`);
  }
}

export async function clearAlignmentFeatureCaches(
  invoker: AlignmentFeatureCacheClearInvoker = defaultClearInvoker
): Promise<AlignmentFeatureCacheClearReceipt> {
  ensureDesktop(invoker === defaultClearInvoker);
  try {
    return await invoker();
  } catch (error: unknown) {
    throw new Error(`清理特征缓存失败：${formatFailure(error)}`);
  }
}

const defaultStatusInvoker: AlignmentFeatureCacheStatusInvoker = () =>
  invoke<AlignmentFeatureCacheStatus>("get_alignment_feature_cache_status");

const defaultClearInvoker: AlignmentFeatureCacheClearInvoker = () =>
  invoke<AlignmentFeatureCacheClearReceipt>("clear_alignment_feature_caches");

function ensureDesktop(usesDefaultInvoker: boolean): void {
  if (usesDefaultInvoker && !isTauri()) {
    throw new Error("匹配特征缓存管理需要在 Tauri 桌面端运行。");
  }
}

function formatFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "未知错误";
}
