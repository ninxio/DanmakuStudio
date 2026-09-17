import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAlignmentExperimentAttempt,
  createAlignmentExperimentQueue,
  parseAlignmentExperimentQueueJson,
  type AlignmentExperimentQueueConfig
} from "../../domain/alignment/alignmentExperimentQueue";
import {
  alignmentExperimentQueueStorageKey,
  clearAlignmentExperimentQueue,
  clearDesktopAlignmentExperimentQueue,
  hydrateDesktopAlignmentExperimentQueue,
  loadAlignmentExperimentQueue,
  persistDesktopAlignmentExperimentQueue,
  saveAlignmentExperimentQueue
} from "./alignmentExperimentQueueStore";

const config: AlignmentExperimentQueueConfig = {
  sourceMediaIds: ["source"],
  targetMediaIds: ["target"],
  pairs: [{ sourceMediaId: "source", targetMediaId: "target" }],
  versionReuseGroups: [],
  audioStreamSelections: {},
  spectralBackend: "cpu",
  windowMs: 100,
  minGapMs: 5_000,
  matchThreshold: 0.6,
  enableVisualEvidence: true
};

describe("alignment experiment queue store", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists queues under a hashed project key", () => {
    const queue = createQueue();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    saveAlignmentExperimentQueue(queue);
    setItem.mockClear();
    expect(alignmentExperimentQueueStorageKey(queue.projectId)).not.toContain(queue.projectId);
    expect(loadAlignmentExperimentQueue(queue.projectId, undefined, 2_000)).toEqual(queue);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("recovers running cases to pending after restart", () => {
    const running = beginAlignmentExperimentAttempt(createQueue(), {
      jobId: "job-1",
      pairs: config.pairs,
      nowMs: 2_000
    });
    saveAlignmentExperimentQueue(running);
    expect(loadAlignmentExperimentQueue("project-sensitive-name", undefined, 3_000)).toMatchObject({
      state: "interrupted",
      activeJobId: null,
      pairs: [{ state: "pending", attemptCount: 1, interruptionCount: 1 }]
    });
  });

  it("removes corrupt or cross-project payloads instead of guessing", () => {
    const key = alignmentExperimentQueueStorageKey("project-sensitive-name");
    window.localStorage.setItem(key, "{bad-json");
    expect(loadAlignmentExperimentQueue("project-sensitive-name")).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();

    const other = createAlignmentExperimentQueue({
      queueId: "queue-other",
      projectId: "other-project",
      config,
      nowMs: 1_000
    });
    window.localStorage.setItem(key, JSON.stringify(other));
    expect(loadAlignmentExperimentQueue("project-sensitive-name")).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("clears only the requested project queue", () => {
    const queue = createQueue();
    saveAlignmentExperimentQueue(queue);
    clearAlignmentExperimentQueue(queue.projectId);
    expect(loadAlignmentExperimentQueue(queue.projectId)).toBeNull();
  });

  it("migrates a local queue into desktop app-data and then treats desktop as authority", async () => {
    const queue = createQueue();
    saveAlignmentExperimentQueue(queue);
    let nativeContent: string | null = null;
    const bridge = {
      load: vi.fn(() => Promise.resolve(nativeContent)),
      save: vi.fn((_projectId: string, content: string) => {
        nativeContent = content;
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        nativeContent = null;
        return Promise.resolve();
      })
    };

    expect(await hydrateDesktopAlignmentExperimentQueue(queue.projectId, undefined, bridge)).toEqual(
      queue
    );
    expect(bridge.save).toHaveBeenCalledTimes(1);

    const changed = createAlignmentExperimentQueue({
      queueId: "queue-native",
      projectId: queue.projectId,
      config,
      nowMs: 4_000
    });
    nativeContent = JSON.stringify(changed);
    expect(await hydrateDesktopAlignmentExperimentQueue(queue.projectId, undefined, bridge)).toEqual(
      changed
    );
    expect(loadAlignmentExperimentQueue(queue.projectId)).toEqual(changed);
  });

  it("serializes desktop writes and clears both durable and compatibility copies", async () => {
    const queue = createQueue();
    const operations: string[] = [];
    const bridge = {
      load: vi.fn(() => Promise.resolve(null)),
      save: vi.fn(async (_projectId: string, content: string) => {
        await Promise.resolve();
        operations.push(parseAlignmentExperimentQueueJson(content).queueId);
      }),
      clear: vi.fn(() => {
        operations.push("clear");
        return Promise.resolve();
      })
    };
    const next = createAlignmentExperimentQueue({
      queueId: "queue-2",
      projectId: queue.projectId,
      config,
      nowMs: 2_000
    });

    await Promise.all([
      persistDesktopAlignmentExperimentQueue(queue, undefined, bridge),
      persistDesktopAlignmentExperimentQueue(next, undefined, bridge),
      clearDesktopAlignmentExperimentQueue(queue.projectId, undefined, bridge)
    ]);
    expect(operations).toEqual(["queue-1", "queue-2", "clear"]);
    expect(loadAlignmentExperimentQueue(queue.projectId)).toBeNull();
  });

  it("fails closed when the desktop queue is corrupt", async () => {
    const queue = createQueue();
    saveAlignmentExperimentQueue(queue);
    const bridge = {
      load: vi.fn(() => Promise.resolve("{bad-json")),
      save: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve())
    };

    expect(
      await hydrateDesktopAlignmentExperimentQueue(queue.projectId, undefined, bridge)
    ).toBeNull();
    expect(bridge.clear).toHaveBeenCalledWith(queue.projectId);
    expect(loadAlignmentExperimentQueue(queue.projectId)).toBeNull();
  });
});

function createQueue() {
  return createAlignmentExperimentQueue({
    queueId: "queue-1",
    projectId: "project-sensitive-name",
    config,
    nowMs: 1_000
  });
}
