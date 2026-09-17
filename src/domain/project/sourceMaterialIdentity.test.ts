import { describe, expect, it } from "vitest";
import { matchSourceMaterialNames, parseSourceMaterialName } from "./sourceMaterialIdentity";
import { createMaterialIntakePlan } from "./materialIntakePlan";
import { createEmptyProject } from "./factory";
import { createLocalPathMediaReference } from "./mediaLibrary";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import type { EditorProject } from "./types";

function project(xmlNames: string[], mediaNames: string[]): EditorProject {
  return {
    ...createEmptyProject(),
    assets: xmlNames.map((fileName, index) =>
      parseBilibiliXml(`<i><d p="1,1,25,16777215,0,0,u,${index}">素材${index}</d></i>`, {
        fileName,
        assetId: `xml-${index}`
      })
    ),
    mediaLibrary: mediaNames.map((fileName, index) =>
      createLocalPathMediaReference(`ref-${index}`, "bilibiliReference", `C:/refs/${fileName}`)
    )
  };
}

describe("source material names", () => {
  it.each([
    ["Ｐ０１.XML", "p01.m4a", "exactStem"],
    ["影片_P01.xml", "影片 Part1.mp4", "sourcePart"],
    ["P001.xml", "p1.m4a", "sourcePart"],
    ["正片.xml", "正片.mp4", "exactStem"],
    ["作品甲_P01.xml", "作品乙_P01.mp4", null],
    ["P01.xml", "作品乙_P01.mp4", null],
    ["movie 1080p60.xml", "movie 1080p060.mp4", null]
  ])("%s and %s associate only by a shared source name", (xml, media, expected) => {
    expect(
      matchSourceMaterialNames(parseSourceMaterialName(xml), parseSourceMaterialName(media))
    ).toBe(expected);
  });

  it("名称或规范 Part 生成来源建议，不伪造季集或原片时间关系", () => {
    const input = project(
      ["电影_P01.xml", "P14.xml", "未命名.xml"],
      ["电影 Part1.m4a", "P014.mp4", "未命名.mp4"]
    );
    const plan = createMaterialIntakePlan(input);
    expect(plan.suggestions).toHaveLength(3);
    expect(plan.suggestions.map((row) => row.episodeIdentity)).toEqual([null, null, null]);
    expect(plan.suggestions.every((row) => row.targetMediaId === null)).toBe(true);
    expect(input.danmakuSourceBindings).toEqual([]);
    expect(input.mediaTimeMaps).toEqual([]);
  });

  it("同名参考重复和规范 P 的 XML 双向重复都集中为冲突", () => {
    expect(
      createMaterialIntakePlan(project(["P01.xml"], ["P01.mp4", "P1.m4a"])).conflicts
    ).toEqual([expect.objectContaining({ reason: "multipleReferenceCandidates" })]);
    const duplicateXml = createMaterialIntakePlan(project(["P01.xml", "p1.xml"], ["P1.mp4"]));
    expect(duplicateXml.suggestions).toEqual([]);
    expect(duplicateXml.conflicts).toHaveLength(2);
    expect(duplicateXml.conflicts.every((row) => row.reason === "duplicateXmlEpisode")).toBe(
      true
    );
  });

  it("跨作品同集不关联，但两部作品各自唯一同名的同集可以同时关联", () => {
    expect(
      createMaterialIntakePlan(project(["作品甲.S01E01.xml"], ["作品乙.S01E01.mp4"]))
        .suggestions
    ).toEqual([]);
    const plan = createMaterialIntakePlan(
      project(
        ["作品甲.S01E01.xml", "作品乙.S01E01.xml"],
        ["作品乙.S01E01.mp4", "作品甲.S01E01.mp4"]
      )
    );
    expect(plan.suggestions).toHaveLength(2);
    expect(plan.conflicts).toEqual([]);
  });

  it("同名不覆盖明确季集元数据冲突，缺季号也不跨已知原片季号", () => {
    const input = project(["S01E01.xml"], ["S01E01.mp4"]);
    input.mediaLibrary[0].episodeKey = "S02E01";
    expect(createMaterialIntakePlan(input).conflicts).toEqual([
      expect.objectContaining({ reason: "crossSeason" })
    ]);
    const crossTarget = project(["E01.xml"], ["S02E01.mp4"]);
    crossTarget.mediaLibrary.push(
      createLocalPathMediaReference("target", "targetOriginal", "C:/Original.S01E01.mkv")
    );
    expect(createMaterialIntakePlan(crossTarget).suggestions).toEqual([]);
  });
});
