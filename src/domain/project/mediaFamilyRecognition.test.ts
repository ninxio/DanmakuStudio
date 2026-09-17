import { describe, expect, it } from "vitest";
import { createEmptyProject } from "./factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { analyzeMediaFamily } from "./mediaFamily";
import { createFamilyArrangement } from "./familyArrangement";
import { buildFamilyArrangementExport } from "./familyArrangement";

function batch(parts: string[], metadata = true) {
  const project = createEmptyProject();
  project.assets = parts.map((part, index) => {
    const name = `P${String(index + 1).padStart(3, "0")} - ${part}.xml`;
    return {
      ...parseBilibiliXml(
        `<i>${metadata ? `<dbx:meta xmlns:dbx="urn:danmakubox:xml:metadata:1" schema-version="1" source="bilibili" bvid="BV1xx411c7mD" aid="1" cid="${100 + index}" page-index="${index + 1}" page-count="${parts.length}" title="Example 第二季 全两集" part="${part}" duration-ms="261000" duration-source="playurl.dash.duration" duration-source-unit="second" exact-duration="true"/>` : ""}<d p="1,1,25,16777215,0,0,u,1">sample</d></i>`,
        { fileName: name, assetId: `a${index}` }
      ),
      sourcePath: metadata
        ? `D:/download/BV1xx411c7mD/P${index + 1}-${100 + index}/${name}`
        : `D:/imports/Example/${name}`
    };
  });
  return project;
}

describe("batch-level media recognition", () => {
  it("groups one metadata source across per-page folders and identifies repeating episode pieces", () => {
    const project = batch(["1.1", "1.2", "02_0001", "02_0002"]);
    expect(project.assets[0].xmlMetadata?.sources).toHaveLength(1);
    const analysis = analyzeMediaFamily(project);
    expect(new Set(analysis.files.map((file) => file.sourceGroupKey)).size).toBe(1);
    expect(analysis.groups.map((group) => group.assetIds.length)).toEqual([2, 2]);
    expect(
      new Set(createFamilyArrangement(analysis).rows.map((row) => row.episodeKey)).size
    ).toBe(2);
  });
  it("recognizes the same repeating structure for ordinary XML without embedded metadata", () => {
    const analysis = analyzeMediaFamily(batch(["1.1", "1.2", "02_0001", "02_0002"], false));
    expect(analysis.groups.map((group) => group.assetIds.length)).toEqual([2, 2]);
  });
  it.each([".", "_", "-", " "])(
    "normalizes delimiter %s and leading zero variants independently of import order",
    (separator) => {
      const project = batch(
        [`04${separator}0002`, `09${separator}001`, `04${separator}003`, `09${separator}002`],
        false
      );
      project.assets.reverse();
      const analysis = analyzeMediaFamily(project);
      expect(analysis.groups.map((group) => group.assetIds.length)).toEqual([2, 2]);
      expect(analysis.files.map((file) => file.episodeIdentity?.episodeStart)).toEqual([
        4, 4, 9, 9
      ]);
      expect(analysis.issues.some((issue) => issue.code === "missingParts")).toBe(true);
    }
  );
  it("uses original part metadata after unrelated file renaming", () => {
    const project = batch(["1.1", "1.2", "2.1", "2.2"]);
    project.assets.forEach((asset, index) => {
      asset.fileName = `renamed-${index}-opaque.xml`;
    });
    expect(analyzeMediaFamily(project).groups.map((group) => group.assetIds.length)).toEqual([
      2, 2
    ]);
  });
  it("offers season/episode and episode/part interpretations without changing source data", () => {
    const project = batch(["1.1", "1.2", "2.1", "2.2"], false);
    const before = JSON.stringify(project);
    const automatic = analyzeMediaFamily(project);
    const key = automatic.files[0].sourceGroupKey;
    const alternative = analyzeMediaFamily(project, {
      numberingBySource: { [key]: "seasonEpisode" }
    });
    expect(automatic.groups).toHaveLength(2);
    expect(alternative.groups).toHaveLength(4);
    expect(alternative.files[3].episodeIdentity).toMatchObject({
      seasonNumber: 2,
      episodeStart: 2,
      partNumber: null
    });
    expect(JSON.stringify(project)).toBe(before);
  });
  it("does not guess an isolated ambiguous pair but lets the user interpret it", () => {
    const project = batch(["3-5"], false);
    const initial = analyzeMediaFamily(project);
    expect(initial.files[0].episodeIdentity).toBeNull();
    const alternate = analyzeMediaFamily(project, {
      numberingBySource: { [initial.files[0].sourceGroupKey]: "episodeRange" }
    });
    expect(alternate.files[0].episodeIdentity).toMatchObject({
      episodeStart: 3,
      episodeEnd: 5
    });
  });
  it("detects nonoverlapping ranges without inventing boundaries inside long collections", () => {
    const analysis = analyzeMediaFamily(batch(["1-3", "4-6", "7-9"], false));
    expect(analysis.files.map((file) => file.episodeIdentity?.episodeEnd)).toEqual([3, 6, 9]);
    expect(analysis.hypotheses[0].kind).toBe("longCollection");
    expect(
      createFamilyArrangement(analysis).rows.every((row) => row.sourceOutMs === null)
    ).toBe(true);
  });
  it("separates explicit season, episode and piece columns", () => {
    const project = batch(["2.3.1", "2.3.2", "3.3.1"], false);
    expect(analyzeMediaFamily(project).groups.map((group) => group.assetIds.length)).toEqual([
      2, 1
    ]);
  });
  it("combines nested season and episode directories while retaining other series", () => {
    const project = batch(["a", "b", "c", "d"], false);
    project.assets.forEach((asset, index) => {
      asset.fileName = `${(index % 2) + 1}.xml`;
      asset.sourcePath = `D:/TV/${index < 2 ? "Orion" : "Lyra"}/Season 03/Episode 02/${asset.fileName}`;
    });
    const analysis = analyzeMediaFamily(project);
    expect(analysis.groups.map((group) => group.assetIds.length)).toEqual([2, 2]);
    expect(
      analysis.files.every(
        (file) =>
          file.episodeIdentity?.seasonNumber === 3 && file.episodeIdentity.episodeStart === 2
      )
    ).toBe(true);
  });
  it("borrows season context for numbered episodes in a season directory", () => {
    const project = batch(["a", "b"], false);
    project.assets.forEach((asset, index) => {
      asset.fileName = `${index + 1}.xml`;
      asset.sourcePath = `D:/Show/Season 04/${asset.fileName}`;
    });
    expect(
      analyzeMediaFamily(project).files.map((file) => file.episodeIdentity?.seasonNumber)
    ).toEqual([4, 4]);
  });
  it.each(["Orion.1x02.part-1.xml", "Orion 第三季第2集 Part 1.xml", "Orion S03E02 cd1.xml"])(
    "retains explicit naming conventions: %s",
    (name) => {
      const project = batch(["a", "b"], false);
      project.assets[0].fileName = name;
      project.assets[1].fileName = name.replace(/(?:1|cd1)\.xml$/, (match) =>
        match.replace("1", "2")
      );
      const analysis = analyzeMediaFamily(project);
      expect(analysis.files.every((file) => file.episodeIdentity?.episodeStart === 2)).toBe(
        true
      );
      expect(analysis.groups.map((group) => group.assetIds.length)).toEqual([2]);
    }
  );
  it.each(["P001", "Movie 2026.09.09", "Film 2024", "1080p", "Movie H.264", "Movie 全十二集"])(
    "avoids episode guesses from non-episode labels: %s",
    (stem) => {
      const project = batch([stem], false);
      expect(analyzeMediaFamily(project).files[0].episodeIdentity).toBeNull();
    }
  );
  it("keeps conflicts and duplicate pieces out of automatic joining", () => {
    const project = batch(["S01E01 P1", "S01E01 P1", "S01E01 P2"]);
    project.assets[2].fileName = "S02E09.xml";
    const analysis = analyzeMediaFamily(project);
    expect(analysis.issues.some((issue) => issue.code === "conflictingIdentity")).toBe(true);
    expect(analysis.issues.some((issue) => issue.code === "duplicatePart")).toBe(true);
    expect(
      new Set(createFamilyArrangement(analysis).rows.map((row) => row.episodeKey)).size
    ).toBe(3);
  });
  it("does not confuse a download ordinal with a semantic piece number for repeated episodes", () => {
    const project = batch(["S01E01", "S01E01"]);
    const analysis = analyzeMediaFamily(project);
    expect(analysis.issues.some((issue) => issue.code === "parallelVersions")).toBe(true);
    expect(
      new Set(createFamilyArrangement(analysis).rows.map((row) => row.episodeKey)).size
    ).toBe(2);
  });
  it("does not join different BVID families even when part titles and directories match", () => {
    const project = batch(["1.1", "1.2", "1.1", "1.2"]);
    project.assets.slice(2).forEach((asset) => {
      asset.xmlMetadata!.sources[0].bvid = "BV1yy411c7mD";
    });
    expect(
      new Set(analyzeMediaFamily(project).files.map((file) => file.sourceGroupKey)).size
    ).toBe(2);
  });
  it("uses the measured duration through recognition, arrangement and per-episode export", () => {
    const project = batch(["1.1", "1.2", "2.1", "2.2"]);
    const analysis = analyzeMediaFamily(project);
    const result = buildFamilyArrangementExport(project, createFamilyArrangement(analysis));
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(
      result.groups.map((group) => group.entries.map((entry) => entry.finalTimeMs))
    ).toEqual([
      [1000, 262000],
      [1000, 262000]
    ]);
  });
  it("recognizes held-out layouts with different titles, episode offsets, sizes and filename punctuation", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const counts = Array.from(
        { length: (seed % 4) + 2 },
        (_, episode) => 2 + ((seed * 3 + episode) % 7)
      );
      const project = batch(
        counts.flatMap((count, episode) =>
          Array.from({ length: count }, (_, part) => `${episode + 11}.${part + 1}`)
        ),
        false
      );
      project.assets.forEach((asset, index) => {
        const content = asset.fileName.replace(/^P\d+ - /, "");
        asset.fileName = seed % 2 ? content : `Nebula.${content}`;
        asset.sourcePath = `D:/Holdout/Case ${seed}/${asset.fileName}`;
        asset.id = `seed${seed}-${index}`;
      });
      project.assets.reverse();
      expect(analyzeMediaFamily(project).groups.map((group) => group.assetIds.length)).toEqual(
        counts
      );
    }
  });
});
