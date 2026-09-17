import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SyntheticAlignmentLabQueueStorage } from "./syntheticAlignmentLabQueueStore";
import {
  parseSyntheticAlignmentReportArchiveJson,
  serializeSyntheticAlignmentReportArchive,
  type SyntheticAlignmentReportArchive
} from "./syntheticAlignmentReportArchive";

export const SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY =
  "danmaku-studio:synthetic-alignment-report-archive:v1";

export interface DesktopSyntheticAlignmentReportArchiveBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

const defaultDesktopBridge: DesktopSyntheticAlignmentReportArchiveBridge = {
  load: () => invoke<string | null>("load_synthetic_alignment_report_archive_file"),
  save: (content) => invoke<void>("save_synthetic_alignment_report_archive_file", { content }),
  clear: () => invoke<void>("clear_synthetic_alignment_report_archive_file")
};

let pendingDesktopWrite: Promise<void> | null = null;

export function loadSyntheticAlignmentReportArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): SyntheticAlignmentReportArchive | null {
  if (!storage) return null;
  try {
    const content = storage.getItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY);
    if (!content) return null;
    return parseSyntheticAlignmentReportArchiveJson(content);
  } catch {
    clearSyntheticAlignmentReportArchive(storage);
    return null;
  }
}

export function saveSyntheticAlignmentReportArchive(
  archive: SyntheticAlignmentReportArchive,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): boolean {
  if (!storage) return false;
  const content = serializeSyntheticAlignmentReportArchive(archive);
  try {
    storage.setItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY, content);
    return true;
  } catch {
    return false;
  }
}

export function clearSyntheticAlignmentReportArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): void {
  try {
    storage?.removeItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY);
  } catch {
    // The desktop archive is authoritative; a blocked compatibility mirror must not block clear.
  }
}

export async function hydrateDesktopSyntheticAlignmentReportArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentReportArchiveBridge = defaultDesktopBridge
): Promise<SyntheticAlignmentReportArchive | null> {
  const local = loadSyntheticAlignmentReportArchive(storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return local;
  await pendingDesktopWrite?.catch(() => undefined);
  const content = await bridge.load();
  if (!content) {
    if (local) await bridge.save(serializeSyntheticAlignmentReportArchive(local));
    return local;
  }
  try {
    const archive = parseSyntheticAlignmentReportArchiveJson(content);
    saveSyntheticAlignmentReportArchive(archive, storage);
    return archive;
  } catch {
    clearSyntheticAlignmentReportArchive(storage);
    await bridge.clear();
    return null;
  }
}

export function persistDesktopSyntheticAlignmentReportArchive(
  archive: SyntheticAlignmentReportArchive,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentReportArchiveBridge = defaultDesktopBridge
): Promise<boolean> {
  const content = serializeSyntheticAlignmentReportArchive(archive);
  if (bridge === defaultDesktopBridge && !isTauri()) {
    saveSyntheticAlignmentReportArchive(archive, storage);
    return Promise.resolve(false);
  }
  return enqueueDesktopWrite(() => bridge.save(content)).then(() => {
    // A localStorage quota error must never prevent the authoritative app-data write.
    saveSyntheticAlignmentReportArchive(archive, storage);
    return true;
  });
}

export function clearDesktopSyntheticAlignmentReportArchive(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentReportArchiveBridge = defaultDesktopBridge
): Promise<boolean> {
  clearSyntheticAlignmentReportArchive(storage);
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
