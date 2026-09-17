import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  parseSyntheticAlignmentLabQueueSummaryJson,
  serializeSyntheticAlignmentLabQueueSummaryValue,
  type SyntheticAlignmentLabQueueSummary
} from "../../domain/alignment/syntheticAlignmentLabQueue";
import type { SyntheticAlignmentLabQueueStorage } from "./syntheticAlignmentLabQueueStore";

export const SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY =
  "danmaku-studio:synthetic-alignment-lab-baseline:v1";

export interface DesktopSyntheticAlignmentLabBaselineBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

const defaultDesktopBridge: DesktopSyntheticAlignmentLabBaselineBridge = {
  load: () => invoke<string | null>("load_synthetic_alignment_lab_baseline_file"),
  save: (content) => invoke<void>("save_synthetic_alignment_lab_baseline_file", { content }),
  clear: () => invoke<void>("clear_synthetic_alignment_lab_baseline_file")
};

let pendingDesktopWrite: Promise<void> | null = null;

export function loadSyntheticAlignmentLabBaseline(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): SyntheticAlignmentLabQueueSummary | null {
  if (!storage) return null;
  const content = storage.getItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY);
  if (!content) return null;
  try {
    return requireTerminalBaseline(parseSyntheticAlignmentLabQueueSummaryJson(content));
  } catch {
    storage.removeItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY);
    return null;
  }
}

export function saveSyntheticAlignmentLabBaseline(
  summary: SyntheticAlignmentLabQueueSummary,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): void {
  const checked = requireTerminalBaseline(summary);
  storage?.setItem(
    SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY,
    serializeSyntheticAlignmentLabQueueSummaryValue(checked)
  );
}

export function clearSyntheticAlignmentLabBaseline(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage()
): void {
  storage?.removeItem(SYNTHETIC_ALIGNMENT_LAB_BASELINE_STORAGE_KEY);
}

export async function hydrateDesktopSyntheticAlignmentLabBaseline(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentLabBaselineBridge = defaultDesktopBridge
): Promise<SyntheticAlignmentLabQueueSummary | null> {
  const local = loadSyntheticAlignmentLabBaseline(storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return local;
  await pendingDesktopWrite?.catch(() => undefined);
  const content = await bridge.load();
  if (!content) {
    if (local) await bridge.save(serializeSyntheticAlignmentLabQueueSummaryValue(local));
    return local;
  }
  try {
    const baseline = requireTerminalBaseline(parseSyntheticAlignmentLabQueueSummaryJson(content));
    saveSyntheticAlignmentLabBaseline(baseline, storage);
    return baseline;
  } catch {
    clearSyntheticAlignmentLabBaseline(storage);
    await bridge.clear();
    return null;
  }
}

export function persistDesktopSyntheticAlignmentLabBaseline(
  summary: SyntheticAlignmentLabQueueSummary,
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentLabBaselineBridge = defaultDesktopBridge
): Promise<boolean> {
  const checked = requireTerminalBaseline(summary);
  saveSyntheticAlignmentLabBaseline(checked, storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return Promise.resolve(false);
  return enqueueDesktopWrite(() =>
    bridge.save(serializeSyntheticAlignmentLabQueueSummaryValue(checked))
  ).then(() => true);
}

export function clearDesktopSyntheticAlignmentLabBaseline(
  storage: SyntheticAlignmentLabQueueStorage | null = getDefaultStorage(),
  bridge: DesktopSyntheticAlignmentLabBaselineBridge = defaultDesktopBridge
): Promise<boolean> {
  clearSyntheticAlignmentLabBaseline(storage);
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

function requireTerminalBaseline(
  summary: SyntheticAlignmentLabQueueSummary
): SyntheticAlignmentLabQueueSummary {
  if (summary.state !== "completed" && summary.state !== "completedWithIssues") {
    throw new Error("程序化回归基线必须已经运行到终态。");
  }
  return summary;
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
