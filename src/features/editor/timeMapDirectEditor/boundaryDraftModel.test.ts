import { describe, expect, it } from "vitest";
import type { TimeMapSpan } from "../../../domain/alignment/timeMap";
import {
  resolveGapDraft,
  updateGapDraft,
  type GapDraft
} from "./boundaryDraftModel";

const SPAN: TimeMapSpan = {
  kind: "ambiguous",
  sourceStartMs: 0,
  sourceEndMs: 366_775,
  targetStartMs: 0,
  targetEndMs: 405_025
};

describe("boundaryDraftModel", () => {
  it("统一应用 250 毫秒吸附、接缝推断与确认 payload", () => {
    const updated = updateGapDraft({
      span: SPAN,
      side: "target",
      firstMs: 369_900,
      secondMs: 405_025,
      snapEnabled: true,
      playbackCursor: { side: "target", positionMs: 370_000 }
    });

    expect(updated).toEqual({
      draft: {
        side: "target",
        startMs: 370_000,
        endMs: 405_025,
        seamMs: 366_775
      },
      snapMessage: "已吸附到 B 当前播放头 00:06:10.000"
    });
    expect(resolveGapDraft(SPAN, updated.draft)).toEqual({
      kind: "targetGap",
      input: {
        sourceAtMs: 366_775,
        targetStartMs: 370_000,
        targetEndMs: 405_025
      }
    });
  });

  it("拒绝没有接缝或无法形成连续 TimeMap 的草稿", () => {
    const draft: GapDraft = {
      side: "source",
      startMs: 10_000,
      endMs: 20_000,
      seamMs: null
    };

    expect(resolveGapDraft(SPAN, draft)).toBeNull();
  });
});
