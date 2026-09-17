import { invoke, isTauri } from "@tauri-apps/api/core";

export interface StorageSettings {
  rootDirectory: string;
  cacheDirectory: string;
}
export interface StoragePaths {
  root: string;
  projects: string;
  database: string;
  bilibili: string;
  originals: string;
  embyAudio: string;
  features: string;
  exports: string;
}
export interface StorageStatus {
  retainedLegacyDirectories: string[];
  fixedLocalData: string | null;
  fixedOutbox: string | null;
  active: StoragePaths | null;
  requested: StoragePaths | null;
  restartRequired: boolean;
  error: string | null;
}
export interface HostEnvironment {
  os: string;
  architecture: string;
  logicalCpus: number | null;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  if (!isTauri())
    return {
      retainedLegacyDirectories: [],
      fixedLocalData: null,
      fixedOutbox: null,
      active: null,
      requested: null,
      restartRequired: false,
      error: "目录管理需要在桌面版 Studio 中使用。"
    };
  return invoke<StorageStatus>("get_storage_status");
}
export async function getHostEnvironment(): Promise<HostEnvironment | null> {
  return isTauri() ? invoke<HostEnvironment>("get_host_environment") : null;
}
export async function resolveExportDirectory(explicit: string): Promise<string> {
  if (explicit.trim() || !isTauri()) return explicit.trim();
  const status = await getStorageStatus();
  if (!status.active) throw new Error(status.error || "存储目录尚不可用。");
  return status.active.exports;
}
