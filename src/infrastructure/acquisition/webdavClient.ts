import { invoke, isTauri } from "@tauri-apps/api/core";
import type { WebDavAudioCacheMediaDraft } from "../../domain/project/mediaLibrary";

export interface WebDavConnection {
  id: string;
  name: string;
  root: string;
}
export interface WebDavEntry {
  href: string;
  name: string;
  directory: boolean;
  size: number | null;
}
export interface WebDavInspection {
  probeId: string;
  name: string;
  sourcePresentationOriginMs: number;
  sourceReportedDurationMs: number | null;
  streams: {
    index: number;
    codec: string;
    language: string | null;
    title: string | null;
    channels: number | null;
  }[];
}
export type WebDavJobStatus =
  | "queued"
  | "downloading"
  | "awaitingTrack"
  | "extracting"
  | "verifying"
  | "cancelling"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "completed";
export interface WebDavJob {
  id: string;
  connectionId: string;
  href: string;
  name: string;
  streamIndex: number;
  status: WebDavJobStatus;
  message: string;
  createdAtMs: number;
  directory: string;
}
export interface WebDavWorkspace {
  connections: WebDavConnection[];
  jobs: WebDavJob[];
}
export function webDavActive(job: WebDavJob) {
  return ["queued", "downloading", "extracting", "verifying", "cancelling"].includes(
    job.status
  );
}
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("WebDAV 音轨获取需要桌面版 Studio。");
  return invoke<T>(command, args);
}
export const webdavClient = {
  workspace: () => call<WebDavWorkspace>("get_webdav_workspace"),
  save: (input: { name: string; root: string; username: string; password: string }) =>
    call<WebDavConnection>("save_webdav_connection", { input }),
  remove: (connectionId: string) => call<void>("remove_webdav_connection", { connectionId }),
  list: (connectionId: string, directory: string) =>
    call<WebDavEntry[]>("list_webdav_entries", { connectionId, directory }),
  inspect: (connectionId: string, href: string, ffmpegPath: string | null) =>
    call<WebDavInspection>("inspect_webdav_entry", { connectionId, href, ffmpegPath }),
  prepareSource: (connectionId: string, href: string) =>
    call<WebDavJob>("prepare_webdav_source_job", { connectionId, href }),
  inspectSource: (jobId: string, ffmpegPath: string | null) =>
    call<WebDavInspection>("inspect_webdav_source_job", { jobId, ffmpegPath }),
  start: (probeId: string, streamIndex: number) =>
    call<WebDavJob>("start_webdav_audio_job", { probeId, streamIndex }),
  cancel: (jobId: string) => call<void>("cancel_webdav_audio_job", { jobId }),
  forget: (jobId: string) => call<void>("remove_webdav_job", { jobId }),
  import: (jobId: string) =>
    call<WebDavAudioCacheMediaDraft>("import_webdav_audio_job", { jobId })
};
