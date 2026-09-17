import { invoke, isTauri } from "@tauri-apps/api/core";

export interface LogVarStatus {
  configured: boolean;
  serviceUrl: string;
  hasAdminToken: boolean;
}
export interface LogVarMetadata {
  title: string;
  year: number;
  type: "tv" | "movie";
  season: number;
  episode: number | null;
}
export interface LogVarResource extends LogVarMetadata {
  resourceKey: string;
  count: number;
  updatedAt: string;
  filename: string;
}
export interface LogVarPreview {
  connectionKey: string;
  sourceHash: string;
  resourceKey: string;
  expectedVersion: string | null;
  count: number;
  uploadBytes: number;
  trimmedTextCount: number;
}
function desktop() {
  if (!isTauri()) throw new Error("LogVar 连接和上传需要 Windows 桌面版。");
}
export async function logvarStatus(): Promise<LogVarStatus> {
  if (!isTauri()) return { configured: false, serviceUrl: "", hasAdminToken: false };
  return invoke("logvar_status");
}
export async function configureLogvar(request: {
  apiAddress: string;
  readToken: string;
  adminToken: string;
}): Promise<LogVarStatus> {
  desktop();
  return invoke("configure_logvar", { request });
}
export async function clearLogvar(): Promise<void> {
  desktop();
  return invoke("clear_logvar");
}
export async function logvarPlayerUrl(): Promise<string> {
  desktop();
  return invoke("logvar_player_url");
}
export async function listLogvarLibrary(): Promise<LogVarResource[]> {
  desktop();
  return invoke("list_logvar_library");
}
export async function previewLogvarUpload(
  xml: string,
  metadata: LogVarMetadata
): Promise<LogVarPreview> {
  desktop();
  return invoke("preview_logvar_upload", { xml, metadata });
}
export async function uploadLogvarXml(
  xml: string,
  metadata: LogVarMetadata,
  preview: LogVarPreview
): Promise<{ resource: LogVarResource; verifiedCount: number }> {
  desktop();
  return invoke("upload_logvar_xml", { request: { xml, metadata, preview } });
}
