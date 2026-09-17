import { describe, expect, it } from "vitest";
import {
  applyAudioTrackIntentCommand,
  evaluateAudioTrackPreparation,
  isAudioTrackIntent,
  type AudioTrackInventoryObservation
} from "./audioTrackPreparation";

describe("audio track preparation", () => {
  it("把成功 fallback 的唯一推荐轨解析为自动就绪", () => {
    const observation: AudioTrackInventoryObservation = {
      state: "ready",
      inventoryRevision: "inventory-v1:0000000000000001",
      streamIndexes: [2, 7],
      probeCompleteness: "fallbackRequired",
      recommendation: {
        state: "recommended",
        streamIndex: 2
      }
    };

    expect(evaluateAudioTrackPreparation({ mode: "auto" }, observation)).toEqual({
      state: "ready",
      source: "auto",
      inventoryRevision: "inventory-v1:0000000000000001",
      finalStreamIndex: 2
    });
  });

  it("partial metadata 即使携带推荐也要求用户选择", () => {
    const observation = readyObservation({ probeCompleteness: "partial" });

    expect(evaluateAudioTrackPreparation({ mode: "auto" }, observation)).toEqual({
      state: "needsChoice",
      reason: "metadataPartial",
      inventoryRevision: observation.inventoryRevision,
      finalStreamIndex: null
    });
  });

  it("同 revision 的显式选择覆盖相反推荐和特殊用途排序", () => {
    const observation = readyObservation({
      recommendation: { state: "recommended", streamIndex: 2 }
    });

    expect(
      evaluateAudioTrackPreparation(
        {
          mode: "explicit",
          streamIndex: 7,
          inventoryRevision: observation.inventoryRevision
        },
        observation
      )
    ).toMatchObject({ state: "ready", source: "explicit", finalStreamIndex: 7 });
  });

  it("revision 改变或轨消失都保留显式意图并进入需复核", () => {
    expect(
      evaluateAudioTrackPreparation(
        {
          mode: "explicit",
          streamIndex: 7,
          inventoryRevision: "inventory-v1:old"
        },
        readyObservation()
      )
    ).toMatchObject({
      state: "needsReview",
      reason: "inventoryRevisionChanged",
      previousStreamIndex: 7,
      finalStreamIndex: null
    });

    expect(
      evaluateAudioTrackPreparation(
        {
          mode: "explicit",
          streamIndex: 9,
          inventoryRevision: "inventory-v1:current"
        },
        readyObservation()
      )
    ).toMatchObject({
      state: "needsReview",
      reason: "streamMissing",
      previousStreamIndex: 9,
      finalStreamIndex: null
    });
  });

  it("显式选择只能由当前 ready inventory 盖章", () => {
    expect(
      applyAudioTrackIntentCommand(readyObservation(), {
        mode: "explicit",
        streamIndex: 7
      })
    ).toEqual({
      mode: "explicit",
      streamIndex: 7,
      inventoryRevision: "inventory-v1:current"
    });
    expect(() =>
      applyAudioTrackIntentCommand(readyObservation(), {
        mode: "explicit",
        streamIndex: 9
      })
    ).toThrow("当前音轨清单中不存在 #9");
    expect(() =>
      applyAudioTrackIntentCommand({ state: "probing" }, { mode: "explicit", streamIndex: 7 })
    ).toThrow("音轨清单尚未就绪");
    expect(applyAudioTrackIntentCommand({ state: "probing" }, { mode: "auto" })).toEqual({
      mode: "auto"
    });
  });

  it("只接受有界 opaque revision 与非负安全整数 index", () => {
    expect(isAudioTrackIntent({ mode: "auto" })).toBe(true);
    expect(
      isAudioTrackIntent({
        mode: "explicit",
        streamIndex: 0,
        inventoryRevision: "future-contract:opaque"
      })
    ).toBe(true);
    expect(isAudioTrackIntent({ mode: "explicit", streamIndex: -1, inventoryRevision: "x" })).toBe(
      false
    );
    expect(isAudioTrackIntent({ mode: "explicit", streamIndex: 1.5, inventoryRevision: "x" })).toBe(
      false
    );
    expect(isAudioTrackIntent({ mode: "explicit", streamIndex: 1, inventoryRevision: " " })).toBe(
      false
    );
    expect(
      isAudioTrackIntent({ mode: "explicit", streamIndex: 1, inventoryRevision: "界".repeat(43) })
    ).toBe(false);
  });
});

function readyObservation(
  overrides: Partial<Extract<AudioTrackInventoryObservation, { state: "ready" }>> = {}
): Extract<AudioTrackInventoryObservation, { state: "ready" }> {
  return {
    state: "ready",
    inventoryRevision: "inventory-v1:current",
    streamIndexes: [2, 7],
    probeCompleteness: "complete",
    recommendation: { state: "recommended", streamIndex: 2 },
    ...overrides
  };
}
