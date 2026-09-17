import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface BilibiliPage {
  cid: number;
  page: number;
  part: string;
  durationMs: number;
  durationSource: string;
  exactDuration: boolean;
  audioAvailable: boolean | null;
  audioCodec: string | null;
  audioBandwidth: number | null;
}
export interface BilibiliVideo {
  bvid: string;
  aid: number;
  title: string;
  ownerName: string;
  pageCount: number;
  pages: BilibiliPage[];
  warnings: string[];
}
export interface BilibiliDownloadRequest {
  requestId: string;
  input: string;
  cookie: string | null;
  outputFolder: string;
  selectedCids: number[];
  downloadAudio: boolean;
}
export interface BilibiliDownloadedPage {
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  part: string;
  durationMs: number;
  exactDuration: boolean;
  danmakuCount: number;
  xmlPath: string;
  audioPath: string | null;
}
export interface BilibiliDownloadOutcome {
  requestId: string;
  status: "completed" | "cancelled" | "failed";
  results: BilibiliDownloadedPage[];
  error: string | null;
}
export interface BilibiliProgress {
  requestId: string;
  stage: string;
  current: number;
  total: number;
  page: number;
  percent: number;
  message: string;
}
export interface BilibiliLogin {
  loggedIn: boolean;
  username: string | null;
  message: string;
}
function requireDesktop() {
  if (!isTauri()) throw new Error("从 B 站获取素材需要桌面版。网页版仍可导入本地 XML。");
}
export async function inspectBilibiliVideo(
  input: string,
  cookie: string
): Promise<BilibiliVideo> {
  requireDesktop();
  return invoke("inspect_bilibili_video", { input, cookie: cookie.trim() || null });
}
export async function checkBilibiliLogin(cookie: string): Promise<BilibiliLogin> {
  requireDesktop();
  return invoke("check_bilibili_login", { cookie });
}
export async function downloadBilibiliPackage(
  request: BilibiliDownloadRequest
): Promise<BilibiliDownloadOutcome> {
  requireDesktop();
  return invoke("download_bilibili_package", { request });
}
export async function cancelBilibiliDownload(requestId: string): Promise<boolean> {
  requireDesktop();
  return invoke("cancel_bilibili_download", { requestId });
}
export async function listenBilibiliProgress(
  callback: (progress: BilibiliProgress) => void
): Promise<() => void> {
  requireDesktop();
  return listen<BilibiliProgress>("bilibili-download-progress", (event) =>
    callback(event.payload)
  );
}

export interface BilibiliProjectContext {
  projectId: string;
  projectEpoch: number;
  projectName: string;
}
export type BilibiliJobDraft = Omit<BilibiliDownloadRequest, "cookie" | "requestId">;
export type BilibiliJobPhase =
  | "idle"
  | "running"
  | "cancelling"
  | "importing"
  | "completed"
  | "cancelled"
  | "failed"
  | "pendingImport"
  | "interrupted";
export interface BilibiliSavedJob {
  version: 1;
  draft: BilibiliJobDraft;
  context: BilibiliProjectContext;
  results: BilibiliDownloadedPage[];
  phase: BilibiliJobPhase;
}
