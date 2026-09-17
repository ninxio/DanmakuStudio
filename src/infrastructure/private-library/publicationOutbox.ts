import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PublicationDelivery } from "../../domain/publication/types";

export interface DeliverySummary {
  key: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  fileCount: number;
  byteCount: number;
}
export interface DeliveryRecord {
  key: string;
  delivery: PublicationDelivery;
  draft: unknown;
}
const pending = new WeakMap<PublicationDelivery, Promise<DeliverySummary>>();
const draftWrites = new Map<string, Promise<void>>();
export function persistDelivery(delivery: PublicationDelivery): Promise<DeliverySummary> {
  if (!isTauri()) return Promise.reject(new Error("成品历史记录需要桌面版 Studio。"));
  let result = pending.get(delivery);
  if (!result) {
    result = invoke<DeliverySummary>("save_publication_delivery", { delivery });
    pending.set(delivery, result);
    void result.catch(() => pending.delete(delivery));
  }
  return result;
}
export async function listDeliveries(): Promise<DeliverySummary[]> {
  if (!isTauri()) return [];
  return invoke("list_publication_deliveries");
}
export async function loadDelivery(key: string): Promise<DeliveryRecord> {
  const record = await invoke<DeliveryRecord>("load_publication_delivery", { key });
  return record;
}
export function savePublicationDraft(key: string, draft: unknown): Promise<void> {
  // Serialize writes per batch so a delayed autosave cannot replace a newer receipt.
  const next = (draftWrites.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => invoke<void>("save_publication_draft", { key, draft }));
  draftWrites.set(key, next);
  void next
    .finally(() => {
      if (draftWrites.get(key) === next) draftWrites.delete(key);
    })
    .catch(() => {});
  return next;
}
