import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { analyzeMediaFamily, nameImportedProject } from "./mediaFamily";
import {
  buildFamilyArrangementExport,
  createFamilyArrangement,
  isFamilyArrangement
} from "./familyArrangement";
import { parseProjectJson, serializeProject } from "./schema";

const asset = (fileName: string, index = 0) => ({
  ...parseBilibiliXml('<i><d p="1,1,25,16777215,0,0,u,1">示例</d></i>', {
    fileName,
    assetId: `a${index}`
  }),
  sourcePath: `C:/imports/Example Series/${fileName}`
});
describe("explainable media families", () => {
  it.each(["银河全8集.xml", "【银河】共十二集.xml"])(
    "keeps collection counts out of episode identities: %s",
    (fileName) => {
      const project = createEmptyProject();
      project.assets = [asset(fileName)];
      const analysis = analyzeMediaFamily(project);
      expect(analysis.files[0].episodeIdentity).toBeNull();
      expect(
        analysis.hypotheses.some((hypothesis) => hypothesis.kind === "longCollection")
      ).toBe(true);
    }
  );
  it("uses the explicit episode after a collection count", () => {
    const project = createEmptyProject();
    project.assets = [asset("银河全8集 第2集.xml")];
    expect(analyzeMediaFamily(project).files[0].episodeIdentity).toMatchObject({
      episodeStart: 2,
      episodeEnd: 2
    });
  });
  it("recognizes variable episode pieces in shuffled imports, independently of titles", () => {
    const project = createEmptyProject();
    let ordinal = 2;
    project.assets = [10, 11, 10, 14, 13, 12, 13, 13]
      .flatMap((count, episode) =>
        Array.from({ length: count }, (_, part) =>
          asset(
            `${String(ordinal++).padStart(2, "0")} - ${String(episode + 1).padStart(2, "0")}${episode < 4 ? " " : "-"}${part + 1}.xml`,
            ordinal
          )
        )
      )
      .reverse();
    const analysis = analyzeMediaFamily(project);
    expect(analysis.groups.map((group) => group.assetIds.length)).toEqual([
      10, 11, 10, 14, 13, 12, 13, 13
    ]);
    expect(new Set(analysis.files.map((file) => file.sequenceNumber)).size).toBe(96);
    expect(nameImportedProject(project).name).toBe("Example Series");
    expect(nameImportedProject({ ...project, name: "我的收藏" }).name).toBe("我的收藏");
  });
  it("keeps season and range separate from part and isolates parallel sources", () => {
    const project = createEmptyProject();
    project.assets = [
      asset("01 - 2.1.1.xml"),
      asset("02 - 3.1.1.xml", 1),
      asset("1 - 第四季1-5.xml", 2),
      { ...asset("01 - 2.1.1.xml", 3), sourcePath: "C:/other/source/01 - 2.1.1.xml" }
    ];
    const analysis = analyzeMediaFamily(project);
    expect(analysis.groups).toHaveLength(4);
    expect(analysis.files.find((file) => file.assetId === "a2")?.episodeIdentity).toMatchObject(
      { seasonNumber: 4, episodeStart: 1, episodeEnd: 5, partNumber: null }
    );
    expect(analysis.files.find((file) => file.assetId === "a0")?.episodeIdentity).toMatchObject(
      { seasonNumber: 2, episodeStart: 1, partNumber: 1 }
    );
  });
  it("never gives a P-only source an episode number or blindly joins duplicate parts", () => {
    const project = createEmptyProject();
    project.assets = [asset("Movie P01.xml"), asset("Movie P01.xml", 1)];
    const analysis = analyzeMediaFamily(project);
    expect(analysis.files.every((file) => file.episodeIdentity === null)).toBe(true);
    expect(
      new Set(createFamilyArrangement(analysis, "movieParts").rows.map((row) => row.episodeKey))
        .size
    ).toBe(2);
  });
  it("preserves distinct physical directories with compatibility-equivalent Unicode names", () => {
    const project = createEmptyProject();
    project.assets = [
      { ...asset("Show S01E01 P01.xml"), sourcePath: "C:/versions/①/Show S01E01 P01.xml" },
      { ...asset("Show S01E01 P02.xml", 1), sourcePath: "C:/versions/1/Show S01E01 P02.xml" }
    ];
    expect(analyzeMediaFamily(project).groups).toHaveLength(2);
  });
  it("requires exact join boundaries and exports arbitrary source windows without editing inputs", () => {
    const project = createEmptyProject();
    project.assets = [asset("Movie P01.xml"), asset("Movie P02.xml", 1)];
    const original = JSON.stringify(project.assets);
    const arrangement = createFamilyArrangement(analyzeMediaFamily(project), "movieParts");
    expect(
      buildFamilyArrangementExport(project, arrangement).issues.some(
        (issue) => issue.code === "unknownPreviousEnd"
      )
    ).toBe(true);
    arrangement.rows[0].sourceOutMs = 2000;
    arrangement.rows[1].sourceInMs = 500;
    const result = buildFamilyArrangementExport(project, arrangement);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.groups[0].entries.map((entry) => entry.finalTimeMs)).toEqual([1000, 2500]);
    expect(JSON.stringify(project.assets)).toBe(original);
    const parsed = parseProjectJson(
      serializeProject({ ...project, familyArrangement: arrangement })
    );
    expect(parsed.familyArrangement).toEqual(arrangement);
    expect(parsed.assets[0].sourcePath).toBe(project.assets[0].sourcePath);
    expect(
      isFamilyArrangement({ ...arrangement, rows: [arrangement.rows[0], arrangement.rows[0]] })
    ).toBe(false);
  });
  it("retains an unknown tail even when a later piece has explicit placement", () => {
    const project = createEmptyProject();
    project.assets = [asset("Movie P01.xml"), asset("Movie P02.xml", 1)];
    const arrangement = createFamilyArrangement(analyzeMediaFamily(project), "movieParts");
    arrangement.rows[1].targetStartMs = 10000;
    arrangement.rows[1].sourceOutMs = 5000;
    expect(buildFamilyArrangementExport(project, arrangement).groups[0].endMs).toBeNull();
  });
  it("appends to the previous piece after a manual backward placement and retains total extent", () => {
    const project = createEmptyProject();
    project.assets = [
      asset("Movie P01.xml"),
      asset("Movie P02.xml", 1),
      asset("Movie P03.xml", 2)
    ];
    const arrangement = createFamilyArrangement(analyzeMediaFamily(project), "movieParts");
    arrangement.rows[0].sourceOutMs = 10000;
    arrangement.rows[1].targetStartMs = 2000;
    arrangement.rows[1].sourceOutMs = 2000;
    arrangement.rows[2].sourceOutMs = 2000;
    const result = buildFamilyArrangementExport(project, arrangement);
    expect(result.issues).toEqual([]);
    expect(result.groups[0].entries.map((entry) => entry.finalTimeMs)).toEqual([
      1000, 3000, 5000
    ]);
    expect(result.groups[0].endMs).toBe(10000);
  });
});
