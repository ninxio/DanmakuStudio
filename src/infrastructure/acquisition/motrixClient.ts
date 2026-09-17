import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
export interface MotrixDownload {
  key: string;
  projectId: string;
  title: string;
  uri: string;
  saveDir: string;
  taskId: string | null;
  status: string;
  progress: number;
  message: string;
  files: string[];
}
export interface MotrixWorkspace {
  connected: boolean;
  message: string;
  defaultDirectory: string;
  downloads: MotrixDownload[];
}
function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    return Promise.reject(new Error("原片搜索与 Motrix 下载需要在桌面版 Studio 中使用。"));
  return invoke<T>(command, args);
}
export const getMotrixWorkspace = (projectId: string) =>
  call<MotrixWorkspace>("get_motrix_workspace", { projectId });
export const addMotrixDownload = (
  projectId: string,
  title: string,
  uri: string,
  directory: string,
  restartMissing = false
) =>
  call<MotrixDownload>("add_motrix_download", {
    projectId,
    title,
    uri,
    directory,
    restartMissing
  });
export const refreshMotrixDownloads = (projectId: string) =>
  call<MotrixDownload[]>("refresh_motrix_downloads", { projectId });
export const repairMotrixDownload = (projectId: string, key: string) =>
  call<MotrixDownload>("repair_motrix_download", { projectId, key });
export const verifiedMotrixFiles = (projectId: string, key: string) =>
  call<string[]>("get_motrix_completed_files", { projectId, key });
export const fetchSourcePage = (url: string) =>
  call<string>("fetch_original_source_page", { url });
export const openSourcePage = (url: string) => call<void>("open_original_source_page", { url });
export const openSourceBrowser = (projectId: string, url: string) =>
  call<void>("open_original_source_browser", { projectId, url });
export async function listenSourceMagnet(
  callback: (value: { projectId: string; magnet: string; title: string }) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<{ projectId: string; magnet: string; title: string }>(
    "original-source-magnet",
    (event) => callback(event.payload)
  );
}
export function acquisitionError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "操作未完成，请重试。";
}
