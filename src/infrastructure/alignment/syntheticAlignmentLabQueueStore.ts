import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  parseSyntheticAlignmentLabQueueJson,
  recoverSyntheticAlignmentLabQueue,
  serializeSyntheticAlignmentLabQueue,
  type SyntheticAlignmentLabQueue
} from "../../domain/alignment/syntheticAlignmentLabQueue";

export const SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY =
  "danmaku-studio:synthetic-alignment-lab-queue:v1";

export interface SyntheticAlignmentLabQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DesktopSyntheticAlignmentLabQueueBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

const defaultDesktopBridge: DesktopSyntheticAlignmentLabQueueBridge = {
  load: () => invoke<string | null>("load_synthetic_alignment_lab_queue_file"),
  save: (content) => invoke<void>("save_synthetic_alignment_lab_queue_file", { content }),
  clear: () => invoke<void>("clear_synthetic_alignment_lab_queue_file")
};

let pendingDesktopWrite: Promise<void> | null = null;

export function loadSyntheticAlignmentLabQueue(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  nowMs: number = Date.now()
): SyntheticAlignmentLabQueue | null {
  if (!storage) return null;
  const content = storage.getItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY);
  if (!content) return null;
  try {
    const queue = parseSyntheticAlignmentLabQueueJson(content);
    const recovered = recoverSyntheticAlignmentLabQueue(queue, nowMs);
    if (recovered !== queue) saveSyntheticAlignmentLabQueue(recovered, storage);
    return recovered;
  } catch {
    storage.removeItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY);
    return null;
  }
}

export function saveSyntheticAlignmentLabQueue(
  queue: SyntheticAlignmentLabQueue,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): void {
  storage?.setItem(
    SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY,
    serializeSyntheticAlignmentLabQueue(queue)
  );
}

export function clearSyntheticAlignmentLabQueue(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): void {
  storage?.removeItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY);
}

export async function hydrateDesktopSyntheticAlignmentLabQueue(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentLabQueueBridge = defaultDesktopBridge,
  nowMs: number = Date.now()
): Promise<SyntheticAlignmentLabQueue | null> {
  const local = loadSyntheticAlignmentLabQueue(storage, nowMs);
  if (bridge === defaultDesktopBridge && !isTauri()) return local;
  await pendingDesktopWrite?.catch(() => undefined);
  const content = await bridge.load();
  if (!content) {
    if (local) await bridge.save(serializeSyntheticAlignmentLabQueue(local));
    return local;
  }
  try {
    const queue = parseSyntheticAlignmentLabQueueJson(content);
    const recovered = recoverSyntheticAlignmentLabQueue(queue, nowMs);
    if (recovered !== queue) await bridge.save(serializeSyntheticAlignmentLabQueue(recovered));
    saveSyntheticAlignmentLabQueue(recovered, storage);
    return recovered;
  } catch {
    clearSyntheticAlignmentLabQueue(storage);
    await bridge.clear();
    return null;
  }
}

export function persistDesktopSyntheticAlignmentLabQueue(
  queue: SyntheticAlignmentLabQueue,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentLabQueueBridge = defaultDesktopBridge
): Promise<boolean> {
  saveSyntheticAlignmentLabQueue(queue, storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return Promise.resolve(false);
  return enqueueDesktopWrite(() => bridge.save(serializeSyntheticAlignmentLabQueue(queue))).then(
    () => true
  );
}

export function clearDesktopSyntheticAlignmentLabQueue(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentLabQueueBridge = defaultDesktopBridge
): Promise<boolean> {
  clearSyntheticAlignmentLabQueue(storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return Promise.resolve(false);
  return enqueueDesktopWrite(() => bridge.clear()).then(() => true);
}

function getDefaultStorage(): SyntheticAlignmentLabQueueStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function enqueueDesktopWrite(operation: () => Promise<void>): Promise<void> {
  const previous = pendingDesktopWrite ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  pendingDesktopWrite = next;
  const clear = () => {
    if (pendingDesktopWrite === next) pendingDesktopWrite = null;
  };
  void next.then(clear, clear);
  return next;
}
