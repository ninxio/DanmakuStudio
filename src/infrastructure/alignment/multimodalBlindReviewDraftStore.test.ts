import { describe, expect, it } from "vitest";
import { createMultimodalBlindReviewPackFixture as createPack } from "../../test/multimodalBlindReviewFixture";
import {
  MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY,
  clearMultimodalBlindReviewDraft,
  clearDesktopMultimodalBlindReviewDraft,
  hydrateDesktopMultimodalBlindReviewDraft,
  loadMultimodalBlindReviewDraft,
  persistDesktopMultimodalBlindReviewDraft,
  saveMultimodalBlindReviewDraft,
  type DesktopMultimodalBlindReviewDraftBridge,
  type MultimodalBlindReviewDraftStorage
} from "./multimodalBlindReviewDraftStore";

function createStorage(): MultimodalBlindReviewDraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  };
}

function createBridge(initial: string | null = null): DesktopMultimodalBlindReviewDraftBridge & {
  saved: () => string | null;
} {
  let content = initial;
  return {
    load: () => Promise.resolve(content),
    save: (next) => {
      content = next;
      return Promise.resolve();
    },
    clear: () => {
      content = null;
      return Promise.resolve();
    },
    saved: () => content
  };
}

describe("multimodal blind review draft store", () => {
  it("restores answers without persisting a reviewer identity or media paths", () => {
    const storage = createStorage();
    const pack = createPack();
    expect(
      saveMultimodalBlindReviewDraft(
        pack,
        pack.tasks[0].taskId,
        [
          {
            taskId: pack.tasks[0].taskId,
            decision: "matched",
            targetTimestampMs: 12_000,
            boundaryToleranceMs: 750,
            precision: "playbackChecked"
          }
        ],
        storage,
        "2026-07-22T00:00:00.000Z"
      )
    ).toBe(true);
    expect(loadMultimodalBlindReviewDraft(pack, storage)?.answers[0].targetTimestampMs).toBe(12_000);
    const raw = storage.data.get(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("reference.mkv");
    expect(raw).not.toContain("reviewer");

    clearMultimodalBlindReviewDraft(pack.packId, storage);
    expect(loadMultimodalBlindReviewDraft(pack, storage)).toBeNull();
  });

  it("drops a corrupted compatibility archive instead of loading forged progress", () => {
    const storage = createStorage();
    const pack = createPack();
    storage.setItem(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY, "{\"schemaVersion\":\"bad\"}");
    expect(loadMultimodalBlindReviewDraft(pack, storage)).toBeNull();
    expect(storage.data.has(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("migrates a compatibility draft into desktop app-data and keeps app-data authoritative", async () => {
    const pack = createPack();
    const storage = createStorage();
    saveMultimodalBlindReviewDraft(
      pack,
      pack.tasks[0].taskId,
      [
        {
          taskId: pack.tasks[0].taskId,
          decision: "matched",
          targetTimestampMs: 12_000,
          boundaryToleranceMs: 750,
          precision: "playbackChecked"
        }
      ],
      storage,
      "2026-07-22T00:00:00.000Z"
    );
    const bridge = createBridge();
    expect(
      (await hydrateDesktopMultimodalBlindReviewDraft(pack, storage, bridge))?.answers[0]
        .targetTimestampMs
    ).toBe(12_000);
    expect(bridge.saved()).toContain("alignment-multimodal-blind-review-draft-archive-v1");

    await persistDesktopMultimodalBlindReviewDraft(
      pack,
      pack.tasks[0].taskId,
      [
        {
          taskId: pack.tasks[0].taskId,
          decision: "matched",
          targetTimestampMs: 11_500,
          boundaryToleranceMs: 500,
          precision: "frameAccurate"
        }
      ],
      storage,
      bridge,
      "2026-07-22T00:01:00.000Z"
    );
    storage.data.clear();
    expect(
      (await hydrateDesktopMultimodalBlindReviewDraft(pack, storage, bridge))?.answers[0]
        .targetTimestampMs
    ).toBe(11_500);
    expect(storage.data.get(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY)).toBe(bridge.saved());

    await clearDesktopMultimodalBlindReviewDraft(pack.packId, storage, bridge);
    expect(bridge.saved()).toBeNull();
    expect(loadMultimodalBlindReviewDraft(pack, storage)).toBeNull();
  });

  it("fails closed and clears a forged desktop archive", async () => {
    const pack = createPack();
    const storage = createStorage();
    const bridge = createBridge(
      '{"schemaVersion":"alignment-multimodal-blind-review-draft-archive-v1","entries":[],"mediaPath":"C:/private.mkv"}'
    );
    expect(await hydrateDesktopMultimodalBlindReviewDraft(pack, storage, bridge)).toBeNull();
    expect(bridge.saved()).toBeNull();
    expect(storage.data.size).toBe(0);
  });
});
