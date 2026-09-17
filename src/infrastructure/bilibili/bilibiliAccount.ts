import { invoke, isTauri } from "@tauri-apps/api/core";

export interface BilibiliAccount {
  mid: string;
  username: string;
}
export interface BilibiliAccountStatus {
  state: "anonymous" | "authenticated" | "needs_login" | "unverified";
  account: BilibiliAccount | null;
  persisted: boolean;
  lastVerifiedAt: number | null;
  message: string;
}
export interface BilibiliQr {
  attemptId: string;
  qrImage: string;
  expiresAt: number;
}
export interface BilibiliQrPoll {
  phase: "waiting_scan" | "waiting_confirm" | "verifying" | "completed" | "expired" | "failed";
  account: BilibiliAccount | null;
  persisted: boolean;
  message: string;
}
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("B 站扫码登录需要桌面版 Studio。"));
  return invoke<T>(command, args);
}
export const getBilibiliAccount = (verify = false) =>
  call<BilibiliAccountStatus>("bilibili_auth_status", { verify });
export const startBilibiliQr = () => call<BilibiliQr>("bilibili_auth_start_qr");
export const pollBilibiliQr = (attemptId: string) =>
  call<BilibiliQrPoll>("bilibili_auth_poll_qr", { attemptId });
export const cancelBilibiliQr = (attemptId: string) =>
  call<boolean>("bilibili_auth_cancel_qr", { attemptId });
export const logoutBilibili = () => call<void>("bilibili_auth_logout");
