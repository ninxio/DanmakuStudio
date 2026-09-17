import type { EditorProject } from "../domain/project/types";
import { isTauri } from "@tauri-apps/api/core";
import {
  listDeliveries,
  loadDelivery,
  persistDelivery
} from "../infrastructure/private-library/publicationOutbox";

import type { PublicationFile, PublicationDelivery } from "../domain/publication/types";
export type { PublicationFile, PublicationDelivery } from "../domain/publication/types";
let latest: PublicationDelivery | null = null;
const listeners = new Set<() => void>();
let persistenceMessage = "";
const notify = () => {
  for (const listener of listeners) listener();
};
/** Retain the exact exported batch locally; publishing remains an explicit action. */
export function recordPublicationDelivery(
  project: Pick<EditorProject, "id" | "updatedAt" | "name" | "libraryProfile">,
  kind: PublicationDelivery["kind"],
  files: readonly PublicationFile[]
): void {
  if (!files.length) return;
  const profile = project.libraryProfile ? structuredClone(project.libraryProfile) : undefined;
  if (profile) {
    Object.freeze(profile.aliases);
    Object.freeze(profile);
  }
  latest = Object.freeze({
    ...(profile ? { libraryProfile: profile } : {}),
    projectId: project.id,
    projectUpdatedAt: project.updatedAt,
    projectName: project.name,
    kind,
    createdAt: new Date().toISOString(),
    files: Object.freeze(files.map((file) => Object.freeze({ ...file })))
  });
  const delivery = latest;
  persistenceMessage = isTauri() ? "正在保存成品快照…" : "浏览器预览中的成品仅保留于当前会话。";
  notify();
  if (isTauri())
    void persistDelivery(delivery)
      .then(() => {
        if (latest === delivery) {
          persistenceMessage = "成品已保存，重启后可继续发布。";
          notify();
        }
      })
      .catch((error: unknown) => {
        if (latest === delivery) {
          persistenceMessage = `成品记录保存失败：${String(error)} 已导出的 XML 不受影响。`;
          notify();
        }
      });
}
export const readPublicationPersistence = () => persistenceMessage;
export async function restorePublicationDelivery(projectId: string): Promise<void> {
  if (latest?.projectId === projectId || !isTauri()) return;
  const before = latest;
  try {
    const row = (await listDeliveries()).find((item) => item.projectId === projectId);
    if (!row) return;
    const record = await loadDelivery(row.key);
    if (latest !== before) return;
    latest = record.delivery;
    persistenceMessage = "已恢复上次成品，可继续发布或查看历史记录。";
  } catch (error) {
    persistenceMessage = `读取成品记录失败：${String(error)}`;
  }
  notify();
}
export const readPublicationDelivery = (): PublicationDelivery | null => latest;
export function subscribePublicationDelivery(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
