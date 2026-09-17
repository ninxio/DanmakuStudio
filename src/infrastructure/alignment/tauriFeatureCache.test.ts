import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAlignmentFeatureCaches,
  getAlignmentFeatureCacheStatus,
  type AlignmentFeatureCacheStatus
} from "./tauriFeatureCache";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

describe("Tauri 匹配特征缓存桥", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("读取并清理可持久复用的匹配特征缓存", async () => {
    const status = createStatus();
    await expect(getAlignmentFeatureCacheStatus(() => Promise.resolve(status))).resolves.toEqual(status);
    await expect(
      clearAlignmentFeatureCaches(() => Promise.resolve({
        removedFiles: 8,
        removedBytes: 14336,
        before: status,
        after: {
          coarse: { ...status.coarse, memoryEntries: 0, persistentEntries: 0, persistentBytes: 0 },
          finePcm: { ...status.finePcm, persistentEntries: 0, persistentBytes: 0 },
          visual: { ...status.visual, memoryEntries: 0, persistentEntries: 0, persistentBytes: 0 }
        }
      }))
    ).resolves.toMatchObject({ removedFiles: 8, removedBytes: 14336 });
  });

  it("默认调用独立的桌面命令，网页模式明确拒绝", async () => {
    const status = createStatus();
    tauriMocks.invoke.mockResolvedValueOnce(status);
    await expect(getAlignmentFeatureCacheStatus()).resolves.toEqual(status);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("get_alignment_feature_cache_status");

    tauriMocks.isTauri.mockReturnValue(false);
    await expect(clearAlignmentFeatureCaches()).rejects.toThrow(/Tauri 桌面端/);
  });
});

function createStatus(): AlignmentFeatureCacheStatus {
  return {
    coarse: {
      memoryEntries: 2,
      persistentEntries: 4,
      persistentBytes: 4096,
      maxPersistentEntries: 128,
      maxPersistentBytes: 512 * 1024 * 1024,
      directory: "C:\\cache\\coarse"
    },
    finePcm: {
      memoryEntries: 0,
      persistentEntries: 1,
      persistentBytes: 8192,
      maxPersistentEntries: 64,
      maxPersistentBytes: 1024 * 1024 * 1024,
      directory: "C:\\cache\\fine"
    },
    visual: {
      memoryEntries: 1,
      persistentEntries: 3,
      persistentBytes: 2048,
      maxPersistentEntries: 64,
      maxPersistentBytes: 512 * 1024 * 1024,
      directory: "C:\\cache\\visual"
    }
  };
}
