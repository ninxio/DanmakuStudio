import { describe, expect, it } from "vitest";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import {
  createCutHintRulesFromKeywords,
  createCutHintSearchPlan,
  findSuspectedCutCandidates,
  isSuspectedCutCandidateApplied
} from "./cutHints";

describe("疑似删减点扫描", () => {
  it("按时间窗口聚类弹幕文本中的删减提示", () => {
    const asset = createAsset("range.xml", [
      [10_000, "这里是不是删了"],
      [20_000, "刚才怎么跳了"],
      [25_000, "少了一段吧"],
      [120_000, "正常弹幕"]
    ]);

    const candidates = findSuspectedCutCandidates([asset]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      assetFileName: "range.xml",
      hitCount: 3,
      confidence: "medium"
    });
    expect(candidates[0].sourceAtMs).toBe(20_000);
    expect(candidates[0].keywords).toEqual(expect.arrayContaining(["删了", "跳了", "没了"]));
  });

  it("忽略未形成聚类的单条提示", () => {
    const asset = createAsset("single.xml", [
      [10_000, "这里删了"],
      [120_000, "普通弹幕"]
    ]);

    expect(findSuspectedCutCandidates([asset])).toEqual([]);
  });

  it("不同资源的相近提示不会混成同一个候选", () => {
    const first = createAsset("01.xml", [
      [10_000, "这里被删了"],
      [20_000, "刚刚剪掉了"]
    ]);
    const second = createAsset("02.xml", [
      [10_000, "怎么和谐了"],
      [20_000, "中间没了"]
    ]);

    const candidates = findSuspectedCutCandidates([first, second]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.assetFileName).sort()).toEqual(["01.xml", "02.xml"]);
  });

  it("支持从用户关键词生成安全的自定义扫描规则", () => {
    const asset = createAsset("custom.xml", [
      [10_000, "这里有广告时间"],
      [15_000, "广告被处理了吗"],
      [20_000, "片头[删]"],
      [25_000, "这里写了[删]"]
    ]);
    const candidates = findSuspectedCutCandidates([asset], {
      windowMs: 20_000,
      minHitCount: 2,
      rules: createCutHintRulesFromKeywords("广告, [删]")
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.keywords).flat()).toEqual(expect.arrayContaining(["广告", "[删]"]));
  });

  it("把 UI 扫描设置解析为领域扫描参数", () => {
    const plan = createCutHintSearchPlan({
      keywordsText: "广告；[删]",
      windowSeconds: "15.5",
      minHitCount: "3"
    });

    expect(plan.warnings).toEqual([]);
    expect(plan.options.windowMs).toBe(15_500);
    expect(plan.options.minHitCount).toBe(3);
    expect(plan.options.rules?.map((rule) => rule.label)).toEqual(["广告", "[删]"]);
  });

  it("识别已由附近版本差异承接的文本候选", () => {
    const asset = createAsset("applied.xml", [
      [10_000, "这里是不是删了"],
      [20_000, "刚才怎么跳了"],
      [25_000, "少了一段吧"]
    ]);
    const [candidate] = findSuspectedCutCandidates([asset]);

    expect(
      isSuspectedCutCandidateApplied(candidate, [
        { id: "cut-near", name: "版本差异", sourceAtMs: 24_000, targetGapMs: 45_000, note: "" }
      ])
    ).toBe(true);
    expect(
      isSuspectedCutCandidateApplied(candidate, [
        { id: "cut-far", name: "版本差异", sourceAtMs: 30_500, targetGapMs: 45_000, note: "" }
      ])
    ).toBe(false);
  });
});

function createAsset(fileName: string, entries: Array<[number, string]>) {
  const lines = entries.map(([timeMs, text], index) => {
    const seconds = (timeMs / 1000).toFixed(3);
    return `<d p="${seconds},1,25,16777215,0,0,user${index},row${index}">${text}</d>`;
  });
  return parseBilibiliXml(`<?xml version="1.0" encoding="UTF-8"?><i>${lines.join("")}</i>`, { fileName });
}
