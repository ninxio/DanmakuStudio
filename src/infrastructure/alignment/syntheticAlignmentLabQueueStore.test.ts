import { describe, expect, it, vi } from "vitest";
import type { RealMediaBenchmarkManifest } from "../../domain/alignment/realMediaBenchmark";
import {
  beginSyntheticAlignmentLabSuite,
  createSyntheticAlignmentLabQueue,
  serializeSyntheticAlignmentLabQueue
} from "../../domain/alignment/syntheticAlignmentLabQueue";
import {
  SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY,
  clearDesktopSyntheticAlignmentLabQueue,
  hydrateDesktopSyntheticAlignmentLabQueue,
  loadSyntheticAlignmentLabQueue,
  persistDesktopSyntheticAlignmentLabQueue,
  type DesktopSyntheticAlignmentLabQueueBridge,
  type SyntheticAlignmentLabQueueStorage
} from "./syntheticAlignmentLabQueueStore";

describe("便携程序化实验队列持久化", () => {
  it("本地加载会恢复未完成套件并覆盖旧运行态", () => {
    const storage = memoryStorage();
    let queue = createSyntheticAlignmentLabQueue("portable", [manifest()], 1);
    queue = beginSyntheticAlignmentLabSuite(queue, queue.suites[0].suiteId, 2);
    storage.setItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY, serializeSyntheticAlignmentLabQueue(queue));

    const recovered = loadSyntheticAlignmentLabQueue(storage, 3);

    expect(recovered?.state).toBe("interrupted");
    expect(recovered?.suites[0]).toMatchObject({ state: "pending", interruptionCount: 1 });
    expect(storage.getItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY)).toContain("interrupted");
  });

  it("桌面权威文件覆盖浏览器镜像并恢复运行态", async () => {
    const storage = memoryStorage();
    const local = createSyntheticAlignmentLabQueue("local", [manifest("local")], 1);
    storage.setItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY, serializeSyntheticAlignmentLabQueue(local));
    let desktop = createSyntheticAlignmentLabQueue("desktop", [manifest("desktop")], 2);
    desktop = beginSyntheticAlignmentLabSuite(desktop, desktop.suites[0].suiteId, 3);
    const bridge = bridgeWith(serializeSyntheticAlignmentLabQueue(desktop));

    const recovered = await hydrateDesktopSyntheticAlignmentLabQueue(storage, bridge, 4);

    expect(recovered?.queueId).toBe("desktop");
    expect(recovered?.state).toBe("interrupted");
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(storage.getItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY)).toContain("desktop");
  });

  it("桌面为空时迁移浏览器镜像，持久写入串行且清理双端", async () => {
    const storage = memoryStorage();
    const queue = createSyntheticAlignmentLabQueue("portable", [manifest()], 1);
    storage.setItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY, serializeSyntheticAlignmentLabQueue(queue));
    const bridge = bridgeWith(null);

    expect(await hydrateDesktopSyntheticAlignmentLabQueue(storage, bridge, 2)).toEqual(queue);
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(await persistDesktopSyntheticAlignmentLabQueue(queue, storage, bridge)).toBe(true);
    expect(await clearDesktopSyntheticAlignmentLabQueue(storage, bridge)).toBe(true);
    expect(storage.getItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY)).toBeNull();
    expect(bridge.clear).toHaveBeenCalledTimes(1);
  });

  it("损坏的桌面权威文件会清理而不是回退到可能过时的镜像", async () => {
    const storage = memoryStorage();
    const queue = createSyntheticAlignmentLabQueue("portable", [manifest()], 1);
    storage.setItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY, serializeSyntheticAlignmentLabQueue(queue));
    const bridge = bridgeWith("{broken");

    expect(await hydrateDesktopSyntheticAlignmentLabQueue(storage, bridge, 2)).toBeNull();
    expect(storage.getItem(SYNTHETIC_ALIGNMENT_LAB_QUEUE_STORAGE_KEY)).toBeNull();
    expect(bridge.clear).toHaveBeenCalledTimes(1);
  });
});

function memoryStorage(): SyntheticAlignmentLabQueueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      values.delete(key);
    }
  };
}

function bridgeWith(content: string | null): DesktopSyntheticAlignmentLabQueueBridge {
  return {
    load: vi.fn(() => Promise.resolve(content)),
    save: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve())
  };
}

function manifest(id = "suite"): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id,
    name: id,
    datasetVersion: `${id}-v1`,
    description: "development",
    isExample: false,
    licenseNotes: ["Authorized."],
    cases: [{
      id: `${id}-case`,
      title: "case",
      mediaKind: "synthetic",
      split: "development",
      scenarios: ["codec-variant"],
      source: media(`C:/private/${id}-source.flac`),
      target: media(`C:/private/${id}-target.flac`),
      boundaryToleranceMs: 300,
      versionNotes: ["Known transform."],
      licenseNotes: ["Authorized."],
      independentAnnotations: [],
      adjudication: null,
      gold: {
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000,
        matchedAnchors: [{ id: "anchor", sourceMs: 5_000, targetMs: 5_000 }],
        sourceOnlySpans: [],
        targetOnlySpans: [],
        ambiguousSpans: []
      }
    }]
  };
}

function media(path: string) {
  return {
    path,
    audioStreamIndex: 0,
    videoStreamIndex: null,
    contentIdentity: null,
    versionNote: "16 kHz mono",
    licenseNote: "Authorized."
  };
}
