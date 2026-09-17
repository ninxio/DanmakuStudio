import { describe, expect, it } from "vitest";
import {
  STATUS_VOCABULARY,
  WORKSPACE_STATUS_IDS,
  getStatusVocabulary,
} from "./statusVocabulary";

describe("statusVocabulary", () => {
  it("为八个固定状态提供唯一且完整的用户语言", () => {
    expect(WORKSPACE_STATUS_IDS).toEqual([
      "preparing",
      "actionRequired",
      "runnable",
      "running",
      "reviewRequired",
      "confirmed",
      "blocked",
      "exported",
    ]);

    const entries = WORKSPACE_STATUS_IDS.map((id) => getStatusVocabulary(id));

    expect(entries.map((entry) => entry.label)).toEqual([
      "准备中",
      "需处理",
      "可运行",
      "运行中",
      "需复核",
      "已确认",
      "已阻断",
      "已导出",
    ]);
    expect(new Set(entries.map((entry) => entry.label)).size).toBe(entries.length);
    expect(entries.every((entry) => entry.tone.length > 0)).toBe(true);
    expect(entries.every((entry) => entry.icon.length > 0)).toBe(true);
    expect(entries.every((entry) => entry.description.trim().length > 0)).toBe(true);
    expect(Object.keys(STATUS_VOCABULARY)).toEqual(WORKSPACE_STATUS_IDS);
  });

  it("只返回冻结词表中的同一不可变条目", () => {
    expect(getStatusVocabulary("blocked")).toBe(STATUS_VOCABULARY.blocked);
    expect(Object.isFrozen(STATUS_VOCABULARY)).toBe(true);
    expect(Object.isFrozen(STATUS_VOCABULARY.blocked)).toBe(true);
  });
});
