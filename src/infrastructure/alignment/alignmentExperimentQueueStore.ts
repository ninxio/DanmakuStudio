import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  parseAlignmentExperimentQueueJson,
  recoverAlignmentExperimentQueue,
  serializeAlignmentExperimentQueue,
  type AlignmentExperimentQueue
} from "../../domain/alignment/alignmentExperimentQueue";
import { sha256Hex } from "../../domain/shared/sha256";

export const ALIGNMENT_EXPERIMENT_QUEUE_STORAGE_PREFIX =
  "danmaku-studio:alignment-experiment-queue:v1:";

export interface AlignmentExperimentQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DesktopAlignmentExperimentQueueBridge {
  load: (projectId: string) => Promise<string | null>;
  save: (projectId: string, content: string) => Promise<void>;
  clear: (projectId: string) => Promise<void>;
}

const defaultDesktopBridge: DesktopAlignmentExperimentQueueBridge = {
  load: (projectId) =>
    invoke<string | null>("load_alignment_experiment_queue_file", { projectId }),
  save: (projectId, content) =>
    invoke<void>("save_alignment_experiment_queue_file", { projectId, content }),
  clear: (projectId) =>
    invoke<void>("clear_alignment_experiment_queue_file", { projectId })
};

const pendingDesktopWrites = new Map<string, Promise<void>>();

export function loadAlignmentExperimentQueue(
  projectId: string,
  storage: AlignmentExperimentQueueStorage | null = getDefaultStorage(),
  nowMs: number = Date.now()
): AlignmentExperimentQueue | null {
  if (!storage) return null;
  const raw = storage.getItem(storageKey(projectId));
  if (!raw) return null;
  try {
    const queue = parseAlignmentExperimentQueueJson(raw);
    if (queue.projectId !== projectId) {
      storage.removeItem(storageKey(projectId));
      return null;
    }
    const needsRecovery =
      queue.state === "running" || queue.pairs.some((pair) => pair.state === "running");
    const recovered = recoverAlignmentExperimentQueue(queue, nowMs);
    if (needsRecovery) saveAlignmentExperimentQueue(recovered, storage);
    return recovered;
  } catch {
    storage.removeItem(storageKey(projectId));
    return null;
  }
}

export function saveAlignmentExperimentQueue(
  queue: AlignmentExperimentQueue,
  storage: AlignmentExperimentQueueStorage | null = getDefaultStorage()
): void {
  if (!storage) return;
  storage.setItem(storageKey(queue.projectId), serializeAlignmentExperimentQueue(queue));
}

export function clearAlignmentExperimentQueue(
  projectId: string,
  storage: AlignmentExperimentQueueStorage | null = getDefaultStorage()
): void {
  storage?.removeItem(storageKey(projectId));
}

export async function hydrateDesktopAlignmentExperimentQueue(
  projectId: string,
  storage: AlignmentExperimentQueueStorage | null = getDefaultStorage(),
  bridge: DesktopAlignmentExperimentQueueBridge = defaultDesktopBridge,
  nowMs: number = Date.now()
): Promise<AlignmentExperimentQueue | null> {
  const localQueue = loadAlignmentExperimentQueue(projectId, storage, nowMs);
  if (bridge === defaultDesktopBridge && !isTauri()) return localQueue;
  await waitForDesktopWrites(projectId);
  const content = await bridge.load(projectId);
  if (!content) {
    if (localQueue) {
      await bridge.save(projectId, serializeAlignmentExperimentQueue(localQueue));
    }
    return localQueue;
  }
  try {
    const queue = parseAlignmentExperimentQueueJson(content);
    if (queue.projectId !== projectId) throw new Error("匹配任务项目 ID 不一致。");
    const needsRecovery =
      queue.state === "running" || queue.pairs.some((pair) => pair.state === "running");
    const recovered = recoverAlignmentExperimentQueue(queue, nowMs);
    if (needsRecovery) {
      await bridge.save(projectId, serializeAlignmentExperimentQueue(recovered));
    }
    saveAlignmentExperimentQueue(recovered, storage);
    return recovered;
  } catch {
    clearAlignmentExperimentQueue(projectId, storage);
    await bridge.clear(projectId);
    return null;
  }
}

export function persistDesktopAlignmentExperimentQueue(
  queue: AlignmentExperimentQueue,
  storage: AlignmentExperimentQueueStorage | null = getDefaultStorage(),
  bridge: DesktopAlignmentExperimentQueueBridge = defaultDesktopBridge
): Promise<boolean> {
  saveAlignmentExperimentQueue(queue, storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return Promise.resolve(false);
  return enqueueDesktopWrite(queue.projectId, () =>
    bridge.save(queue.projectId, serializeAlignmentExperimentQueue(queue))
  ).then(() => true);
}

export function clearDesktopAlignmentExperimentQueue(
  projectId: string,
  storage: AlignmentExperimentQueueStorage | null = getDefaultStorage(),
  bridge: DesktopAlignmentExperimentQueueBridge = defaultDesktopBridge
): Promise<boolean> {
  clearAlignmentExperimentQueue(projectId, storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return Promise.resolve(false);
  return enqueueDesktopWrite(projectId, () => bridge.clear(projectId)).then(() => true);
}

export function alignmentExperimentQueueStorageKey(projectId: string): string {
  return storageKey(projectId);
}

function storageKey(projectId: string): string {
  return `${ALIGNMENT_EXPERIMENT_QUEUE_STORAGE_PREFIX}${sha256Hex(projectId)}`;
}

function getDefaultStorage(): AlignmentExperimentQueueStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function enqueueDesktopWrite(projectId: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingDesktopWrites.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  pendingDesktopWrites.set(projectId, next);
  const clearPending = () => {
    if (pendingDesktopWrites.get(projectId) === next) pendingDesktopWrites.delete(projectId);
  };
  void next.then(clearPending, clearPending);
  return next;
}

async function waitForDesktopWrites(projectId: string): Promise<void> {
  await pendingDesktopWrites.get(projectId)?.catch(() => undefined);
}
