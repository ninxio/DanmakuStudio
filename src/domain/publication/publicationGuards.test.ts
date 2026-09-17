import { expect, it } from "vitest";
import { hasVideoMatchingEvidence, publicationConflict } from "./publicationGuards";
import type { PublicationDelivery } from "./types";
import { createLibraryProfile } from "../project/discovery";
import {
  recordPublicationDelivery,
  readPublicationDelivery
} from "../../application/publicationDelivery";
const batch = (names: string[]): PublicationDelivery => ({
  projectId: "p",
  projectName: "p",
  projectUpdatedAt: "now",
  createdAt: "now",
  kind: "projection",
  files: names.map((fileName) => ({ fileName, content: "<i/>" }))
});
it("blocks mixed season and duplicate identity but permits user-corrected episode numbers", () => {
  const rows = [
    { selected: true, episode: "1" },
    { selected: true, episode: "2" }
  ];
  expect(
    publicationConflict(batch(["S01E01.xml", "S02E01.xml"]), { kind: "tv", season: "1" }, rows)
  ).toMatch(/多个明确季号/);
  expect(
    publicationConflict(batch(["S02E01.xml"]), { kind: "tv", season: "1" }, rows.slice(0, 1))
  ).toMatch(/季号与表单冲突/);
  expect(
    publicationConflict(
      batch(["S01E01.xml", "S01E02.xml"]),
      { kind: "tv", season: "1" },
      rows.map((r) => ({ ...r, episode: "1" }))
    )
  ).toMatch(/身份重复/);
  expect(
    publicationConflict(batch(["S01E01.xml"]), { kind: "tv", season: "1" }, [
      { selected: true, episode: "3" }
    ])
  ).toBeNull();
  const d = {
    ...batch(["S02E01.xml"]),
    libraryProfile: { ...createLibraryProfile("p"), season: 1 }
  };
  expect(publicationConflict(d, { kind: "tv", season: "2" }, rows.slice(0, 1))).toMatch(
    /资料季号/
  );
});
it("audio cache filename and decoded duration never become video matching evidence", () => {
  for (const ext of ["flac", "wav", "mka"])
    expect(
      hasVideoMatchingEvidence({
        fileName: "S01E01.xml",
        content: "<i/>",
        targetFileName: `S01E01.${ext}`,
        durationMs: 5000
      })
    ).toBe(false);
  expect(
    hasVideoMatchingEvidence({
      fileName: "S01E01.xml",
      content: "<i/>",
      targetFileName: "S01E01.mkv",
      durationMs: 5000
    })
  ).toBe(true);
});
it("all successful export kinds freeze the profile and absent profiles remain omitted", () => {
  for (const kind of ["xml", "family", "projection"] as const) {
    const p = {
      id: "p",
      name: "p",
      updatedAt: "now",
      libraryProfile: createLibraryProfile("p", "Original")
    };
    p.libraryProfile.aliases = ["old"];
    recordPublicationDelivery(p, kind, [{ fileName: "out.xml", content: "<i/>" }]);
    p.libraryProfile.title = "New";
    p.libraryProfile.aliases.push("new");
    expect(readPublicationDelivery()?.libraryProfile).toMatchObject({
      title: "Original",
      aliases: ["old"]
    });
  }
  recordPublicationDelivery({ id: "old", name: "old", updatedAt: "old" }, "xml", [
    { fileName: "out.xml", content: "<i/>" }
  ]);
  expect(JSON.stringify(readPublicationDelivery())).not.toContain("libraryProfile");
});
