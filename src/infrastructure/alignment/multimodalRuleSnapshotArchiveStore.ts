import { invoke, isTauri } from "@tauri-apps/api/core";
import type { AlignmentMultimodalRuleSnapshot } from "../../domain/alignment/alignmentMultimodalRuleSnapshot";
import type { SyntheticAlignmentLabQueueStorage } from "./syntheticAlignmentLabQueueStore";
import {
  addMultimodalRuleSnapshotToArchive,
  archiveContainsEquivalentMultimodalRuleSnapshot,
  parseMultimodalRuleSnapshotArchiveJson,
  serializeMultimodalRuleSnapshotArchive,
  type MultimodalRuleSnapshotArchive
} from "./multimodalRuleSnapshotArchive";

export const MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY =
  "danmaku-studio:multimodal-rule-snapshot-archive:v1";

export interface DesktopMultimodalRuleSnapshotArchiveBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

export interface PersistDesktopMultimodalRuleSnapshotResult {
  archive: MultimodalRuleSnapshotArchive;
  desktopPersisted: boolean;
}

export interface EnsureDesktopMultimodalRuleSnapshotResult
  extends PersistDesktopMultimodalRuleSnapshotResult {
  added: boolean;
}

const defaultDesktopBridge: DesktopMultimodalRuleSnapshotArchiveBridge = {
  load: () => invoke<string | null>("load_multimodal_rule_snapshot_archive_file"),
  save: (content) => invoke<void>("save_multimodal_rule_snapshot_archive_file", { content }),
  clear: () => invoke<void>("clear_multimodal_rule_snapshot_archive_file")
};

let pendingDesktopWrite: Promise<void> | null = null;

export function loadMultimodalRuleSnapshotArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): MultimodalRuleSnapshotArchive | null {
  if (!storage) return null;
  try {
    const content = storage.getItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY);
    if (!content) return null;
    return parseMultimodalRuleSnapshotArchiveJson(content);
  } catch {
    clearMultimodalRuleSnapshotArchive(storage);
    return null;
  }
}

export function saveMultimodalRuleSnapshotArchive(
  archive: MultimodalRuleSnapshotArchive,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): boolean {
  if (!storage) return false;
  const content = serializeMultimodalRuleSnapshotArchive(archive);
  try {
    storage.setItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY, content);
    return true;
  } catch {
    return false;
  }
}

export function clearMultimodalRuleSnapshotArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): void {
  try {
    storage?.removeItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY);
  } catch {
    // app-data is authoritative; compatibility-mirror failures must not block clear.
  }
}

export async function hydrateDesktopMultimodalRuleSnapshotArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalRuleSnapshotArchiveBridge = defaultDesktopBridge
): Promise<MultimodalRuleSnapshotArchive | null> {
  const local = loadMultimodalRuleSnapshotArchive(storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return local;
  await pendingDesktopWrite?.catch(() => undefined);
  const content = await bridge.load();
  if (!content) {
    if (local) await bridge.save(serializeMultimodalRuleSnapshotArchive(local));
    return local;
  }
  try {
    const archive = parseMultimodalRuleSnapshotArchiveJson(content);
    saveMultimodalRuleSnapshotArchive(archive, storage);
    return archive;
  } catch {
    clearMultimodalRuleSnapshotArchive(storage);
    await bridge.clear();
    return null;
  }
}

export function persistDesktopMultimodalRuleSnapshotArchive(
  archive: MultimodalRuleSnapshotArchive,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalRuleSnapshotArchiveBridge = defaultDesktopBridge
): Promise<boolean> {
  const content = serializeMultimodalRuleSnapshotArchive(archive);
  if (bridge === defaultDesktopBridge && !isTauri()) {
    saveMultimodalRuleSnapshotArchive(archive, storage);
    return Promise.resolve(false);
  }
  return enqueueDesktopWrite(() => bridge.save(content)).then(() => {
    saveMultimodalRuleSnapshotArchive(archive, storage);
    return true;
  });
}

export function persistDesktopMultimodalRuleSnapshot(
  snapshot: AlignmentMultimodalRuleSnapshot,
  savedAtMs: number = Date.now(),
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalRuleSnapshotArchiveBridge = defaultDesktopBridge
): Promise<PersistDesktopMultimodalRuleSnapshotResult> {
  if (bridge === defaultDesktopBridge && !isTauri()) {
    const archive = addMultimodalRuleSnapshotToArchive(
      loadMultimodalRuleSnapshotArchive(storage),
      snapshot,
      savedAtMs
    );
    saveMultimodalRuleSnapshotArchive(archive, storage);
    return Promise.resolve({ archive, desktopPersisted: false });
  }
  let mergedArchive: MultimodalRuleSnapshotArchive | null = null;
  return enqueueDesktopWrite(async () => {
    const desktopContent = await bridge.load();
    const current = desktopContent
      ? parseMultimodalRuleSnapshotArchiveJson(desktopContent)
      : loadMultimodalRuleSnapshotArchive(storage);
    mergedArchive = addMultimodalRuleSnapshotToArchive(current, snapshot, savedAtMs);
    await bridge.save(serializeMultimodalRuleSnapshotArchive(mergedArchive));
  }).then(() => {
    if (!mergedArchive) throw new Error("视觉对照规则未能合并到本机档案。");
    saveMultimodalRuleSnapshotArchive(mergedArchive, storage);
    return { archive: mergedArchive, desktopPersisted: true };
  });
}

export function ensureDesktopMultimodalRuleSnapshot(
  snapshot: AlignmentMultimodalRuleSnapshot,
  savedAtMs: number = Date.now(),
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalRuleSnapshotArchiveBridge = defaultDesktopBridge
): Promise<EnsureDesktopMultimodalRuleSnapshotResult> {
  if (bridge === defaultDesktopBridge && !isTauri()) {
    const current = loadMultimodalRuleSnapshotArchive(storage);
    if (archiveContainsEquivalentMultimodalRuleSnapshot(current, snapshot)) {
      return Promise.resolve({ archive: current!, desktopPersisted: false, added: false });
    }
    const archive = addMultimodalRuleSnapshotToArchive(current, snapshot, savedAtMs);
    saveMultimodalRuleSnapshotArchive(archive, storage);
    return Promise.resolve({ archive, desktopPersisted: false, added: true });
  }
  let mergedArchive: MultimodalRuleSnapshotArchive | null = null;
  let added = false;
  return enqueueDesktopWrite(async () => {
    const desktopContent = await bridge.load();
    const current = desktopContent
      ? parseMultimodalRuleSnapshotArchiveJson(desktopContent)
      : loadMultimodalRuleSnapshotArchive(storage);
    if (archiveContainsEquivalentMultimodalRuleSnapshot(current, snapshot)) {
      mergedArchive = current;
      return;
    }
    mergedArchive = addMultimodalRuleSnapshotToArchive(current, snapshot, savedAtMs);
    added = true;
    await bridge.save(serializeMultimodalRuleSnapshotArchive(mergedArchive));
  }).then(() => {
    if (!mergedArchive) throw new Error("视觉对照规则未能合并到本机档案。");
    saveMultimodalRuleSnapshotArchive(mergedArchive, storage);
    return { archive: mergedArchive, desktopPersisted: true, added };
  });
}

export function clearDesktopMultimodalRuleSnapshotArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalRuleSnapshotArchiveBridge = defaultDesktopBridge
): Promise<boolean> {
  clearMultimodalRuleSnapshotArchive(storage);
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
