import { describe, expect, it } from "vitest";
import { createHistoryState, pushHistory, redoHistory, undoHistory } from "./history";

describe("history", () => {
  it("支持撤销和重做", () => {
    let history = createHistoryState<number>(3);
    history = pushHistory(history, "one", 1, 2);
    const undone = undoHistory(history);
    expect(undone.value).toBe(1);
    const redone = redoHistory(undone.history);
    expect(redone.value).toBe(2);
  });

  it("限制历史长度", () => {
    let history = createHistoryState<number>(2);
    history = pushHistory(history, "one", 1, 2);
    history = pushHistory(history, "two", 2, 3);
    history = pushHistory(history, "three", 3, 4);
    expect(history.past.map((entry) => entry.label)).toEqual(["two", "three"]);
  });
});
