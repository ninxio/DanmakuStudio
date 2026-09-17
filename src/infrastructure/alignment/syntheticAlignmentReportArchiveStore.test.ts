import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyntheticAlignmentLabQueueStorage } from "./syntheticAlignmentLabQueueStore";
import { createEmptySyntheticAlignmentReportArchive } from "./syntheticAlignmentReportArchive";
import {
  SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY,
  clearDesktopSyntheticAlignmentReportArchive,
  hydrateDesktopSyntheticAlignmentReportArchive,
  loadSyntheticAlignmentReportArchive,
  persistDesktopSyntheticAlignmentReportArchive,
  type DesktopSyntheticAlignmentReportArchiveBridge
} from "./syntheticAlignmentReportArchiveStore";

describe("程序化详细报告档案持久化", () => {
  beforeEach(() => localStorage.clear());

  it("严格读取本地兼容镜像并清除损坏内容", () => {
    localStorage.setItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY, "{}");
    expect(loadSyntheticAlignmentReportArchive(localStorage)).toBeNull();
    expect(localStorage.getItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY)).toBeNull();
  });

  it("桌面为空时迁移兼容镜像，桌面文件存在时以桌面为权威", async () => {
    const local = createEmptySyntheticAlignmentReportArchive(1);
    localStorage.setItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY, JSON.stringify(local));
    const emptyBridge = memoryBridge(null);
    await expect(
      hydrateDesktopSyntheticAlignmentReportArchive(localStorage, emptyBridge)
    ).resolves.toEqual(local);
    expect(emptyBridge.saved()).toContain("alignment-synthetic-report-archive-v1");

    const desktop = createEmptySyntheticAlignmentReportArchive(2);
    const desktopBridge = memoryBridge(JSON.stringify(desktop));
    await expect(
      hydrateDesktopSyntheticAlignmentReportArchive(localStorage, desktopBridge)
    ).resolves.toEqual(desktop);
    expect(loadSyntheticAlignmentReportArchive(localStorage)?.updatedAtMs).toBe(2);
  });

  it("localStorage 配额失败不阻止桌面权威写入", async () => {
    const archive = createEmptySyntheticAlignmentReportArchive(3);
    const storage: SyntheticAlignmentLabQueueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: vi.fn()
    };
    const bridge = memoryBridge(null);

    await expect(
      persistDesktopSyntheticAlignmentReportArchive(archive, storage, bridge)
    ).resolves.toBe(true);
    expect(bridge.saved()).toContain("alignment-synthetic-report-archive-v1");
  });

  it("损坏桌面档案会清理双端，显式清理也会串行落盘", async () => {
    const storage = localStorage;
    storage.setItem(
      SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY,
      JSON.stringify(createEmptySyntheticAlignmentReportArchive(1))
    );
    const bridge = memoryBridge("{broken");
    await expect(
      hydrateDesktopSyntheticAlignmentReportArchive(storage, bridge)
    ).resolves.toBeNull();
    expect(bridge.saved()).toBeNull();
    expect(storage.getItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY)).toBeNull();

    await persistDesktopSyntheticAlignmentReportArchive(
      createEmptySyntheticAlignmentReportArchive(4),
      storage,
      bridge
    );
    await expect(clearDesktopSyntheticAlignmentReportArchive(storage, bridge)).resolves.toBe(true);
    expect(bridge.saved()).toBeNull();
    expect(storage.getItem(SYNTHETIC_ALIGNMENT_REPORT_ARCHIVE_STORAGE_KEY)).toBeNull();
  });
});

function memoryBridge(initial: string | null): DesktopSyntheticAlignmentReportArchiveBridge & {
  saved: () => string | null;
} {
  let value = initial;
  return {
    load: () => Promise.resolve(value),
    save: (content) => {
      value = content;
      return Promise.resolve();
    },
    clear: () => {
      value = null;
      return Promise.resolve();
    },
    saved: () => value
  };
}
