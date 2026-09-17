import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAlignmentMultimodalRuleSnapshot } from "../../domain/alignment/alignmentMultimodalRuleSnapshot";
import { createEmptyProject } from "../../domain/project/factory";
import type { MediaTimeMap } from "../../domain/project/types";
import type { SyntheticAlignmentLabQueueStorage } from "./syntheticAlignmentLabQueueStore";
import { createEmptyMultimodalRuleSnapshotArchive } from "./multimodalRuleSnapshotArchive";
import {
  MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY,
  clearDesktopMultimodalRuleSnapshotArchive,
  ensureDesktopMultimodalRuleSnapshot,
  hydrateDesktopMultimodalRuleSnapshotArchive,
  loadMultimodalRuleSnapshotArchive,
  persistDesktopMultimodalRuleSnapshot,
  persistDesktopMultimodalRuleSnapshotArchive,
  type DesktopMultimodalRuleSnapshotArchiveBridge
} from "./multimodalRuleSnapshotArchiveStore";

describe("视觉对照规则档案持久化", () => {
  beforeEach(() => localStorage.clear());

  it("严格读取兼容镜像并清除损坏内容", () => {
    localStorage.setItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY, "{}");
    expect(loadMultimodalRuleSnapshotArchive(localStorage)).toBeNull();
    expect(localStorage.getItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY)).toBeNull();
  });

  it("桌面为空时迁移镜像，桌面存在时以 app-data 为权威", async () => {
    const local = createEmptyMultimodalRuleSnapshotArchive(1);
    localStorage.setItem(MULTIMODAL_RULE_SNAPSHOT_ARCHIVE_STORAGE_KEY, JSON.stringify(local));
    const emptyBridge = memoryBridge(null);
    await expect(
      hydrateDesktopMultimodalRuleSnapshotArchive(localStorage, emptyBridge)
    ).resolves.toEqual(local);
    expect(emptyBridge.saved()).toContain("alignment-multimodal-rule-snapshot-archive-v1");

    const desktop = createEmptyMultimodalRuleSnapshotArchive(2);
    const desktopBridge = memoryBridge(JSON.stringify(desktop));
    await expect(
      hydrateDesktopMultimodalRuleSnapshotArchive(localStorage, desktopBridge)
    ).resolves.toEqual(desktop);
    expect(loadMultimodalRuleSnapshotArchive(localStorage)?.updatedAtMs).toBe(2);
  });

  it("localStorage 配额失败不阻止桌面权威写入", async () => {
    const archive = createEmptyMultimodalRuleSnapshotArchive(3);
    const storage: SyntheticAlignmentLabQueueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: vi.fn()
    };
    const bridge = memoryBridge(null);
    await expect(
      persistDesktopMultimodalRuleSnapshotArchive(archive, storage, bridge)
    ).resolves.toBe(true);
    expect(bridge.saved()).toContain("alignment-multimodal-rule-snapshot-archive-v1");
  });

  it("损坏桌面档案会清理双端，显式清理也会串行落盘", async () => {
    const bridge = memoryBridge("{broken");
    await expect(
      hydrateDesktopMultimodalRuleSnapshotArchive(localStorage, bridge)
    ).resolves.toBeNull();
    expect(bridge.saved()).toBeNull();

    await persistDesktopMultimodalRuleSnapshotArchive(
      createEmptyMultimodalRuleSnapshotArchive(4),
      localStorage,
      bridge
    );
    await expect(
      clearDesktopMultimodalRuleSnapshotArchive(localStorage, bridge)
    ).resolves.toBe(true);
    expect(bridge.saved()).toBeNull();
  });

  it("并发自动保存会在桌面权威档案中串行合并而不是互相覆盖", async () => {
    const bridge = memoryBridge(null);
    await Promise.all([
      persistDesktopMultimodalRuleSnapshot(makeSnapshot(0), 10, localStorage, bridge),
      persistDesktopMultimodalRuleSnapshot(makeSnapshot(1), 11, localStorage, bridge)
    ]);

    const archive = await hydrateDesktopMultimodalRuleSnapshotArchive(localStorage, bridge);
    expect(archive?.entries).toHaveLength(2);
    expect(archive?.entries.map((entry) => entry.savedAtMs)).toEqual([11, 10]);
  });

  it("应用级和匹配页同时观察到同一规则时只写入一次", async () => {
    const bridge = memoryBridge(null);
    const first = makeSnapshot(0);
    const equivalent = makeSnapshot(0, 2_000);

    const [applicationResult, panelResult] = await Promise.all([
      ensureDesktopMultimodalRuleSnapshot(first, 10, localStorage, bridge),
      ensureDesktopMultimodalRuleSnapshot(equivalent, 11, localStorage, bridge)
    ]);

    expect(applicationResult.added).toBe(true);
    expect(panelResult.added).toBe(false);
    expect(bridge.saveCount()).toBe(1);
    const archive = await hydrateDesktopMultimodalRuleSnapshotArchive(localStorage, bridge);
    expect(archive?.entries).toHaveLength(1);
    expect(archive?.entries[0].snapshotId).toBe(first.snapshotId);
  });
});

function makeSnapshot(variant: number, createdAtMs: number = 1_000 + variant) {
  const project = createEmptyProject("store-snapshot");
  project.mediaTimeMaps = [createTimeMap(variant)];
  const result = buildAlignmentMultimodalRuleSnapshot(
    project,
    new Date(createdAtMs).toISOString()
  );
  if (!result.snapshot) throw new Error("fixture must produce a snapshot");
  return result.snapshot;
}

function createTimeMap(variant: number): MediaTimeMap {
  return {
    id: `map-${variant}`,
    revision: 1,
    sourceMediaId: "source",
    targetMediaId: "target",
    sourceStream: null,
    targetStream: null,
    sourceIdentity: identity("a"),
    targetIdentity: identity("b"),
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: variant,
    targetEndMs: 10_000 + variant,
    spans: [{
      kind: "matched",
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: variant,
      targetEndMs: 10_000 + variant
    }],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 10,
      p95ResidualMs: 20,
      maxResidualMs: 30,
      boundaryUncertaintyMs: 40,
      alternativeMargin: 0.2,
      anchorCount: 3,
      heldOutAnchorCount: 1,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 3,
      visualAnchorCount: 0,
      heldOutAnchorCount: 1,
      notes: []
    },
    verification: null,
    engineVersion: "alignment-v2",
    featureVersion: "feature-v2",
    parametersHash: "sha256:parameters",
    state: "candidate",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    confirmedAt: null
  };
}

function identity(digit: string) {
  return {
    algorithm: "sha256-full-file-v2" as const,
    sizeBytes: 1_000,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: digit.repeat(64),
    lastSampleDigest: digit.repeat(64)
  };
}

function memoryBridge(initial: string | null): DesktopMultimodalRuleSnapshotArchiveBridge & {
  saved: () => string | null;
  saveCount: () => number;
} {
  let value = initial;
  let saves = 0;
  return {
    load: () => Promise.resolve(value),
    save: (content) => {
      value = content;
      saves += 1;
      return Promise.resolve();
    },
    clear: () => {
      value = null;
      return Promise.resolve();
    },
    saved: () => value,
    saveCount: () => saves
  };
}
