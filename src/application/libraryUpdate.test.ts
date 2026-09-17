import { expect, it } from "vitest";
import {
  inferLibraryEpisode,
  newLibraryWork,
  planLibraryUpdate,
  recoverUpdateDraft
} from "./libraryUpdate";
import type {
  LibraryEpisode,
  LibraryWork
} from "../infrastructure/private-library/libraryTypes";
import type { PublicationDelivery } from "../domain/publication/types";
import { sha256Hex } from "../domain/shared/sha256";
const work: LibraryWork = {
  workKey: "existing",
  title: "正式片名",
  kind: "tv",
  year: null,
  episodeCount: 3,
  seasonCount: 2
};
const delivery: PublicationDelivery = {
  projectId: "p",
  projectName: "p",
  projectUpdatedAt: "now",
  createdAt: "now",
  kind: "xml",
  files: [
    { fileName: "第2季第1集.xml", content: "new" },
    { fileName: "S02E03.xml", content: "third" }
  ]
};
const episode = (season: number, n: number): LibraryEpisode => ({
  episodeId: season * 10 + n,
  revision: "a".repeat(64),
  metadataVersion: 4,
  reviewStatus: "pending",
  isVisible: false,
  canonicalMetadata: {
    workKey: "existing",
    title: "正式片名",
    kind: "tv",
    year: null,
    editionKey: "original-edition",
    sourceKey: "original-source",
    sourceLabel: "收藏",
    edition: "旧内部名称",
    aliases: ["可搜索旧称"]
  },
  manifest: {
    workKey: "existing",
    title: "正式片名",
    kind: "tv",
    year: null,
    editionKey: "original-edition",
    edition: "旧内部名称",
    aliases: [],
    season,
    episode: n,
    label: "",
    durationMs: null,
    fileNames: [],
    allowAutoMatch: false,
    commentCount: 900,
    xmlHash: sha256Hex("old")
  }
});
it("replaces selected episodes under their existing identities and adds missing episodes without touching other seasons", () => {
  const cloud = [episode(1, 1), episode(2, 1), episode(2, 2)];
  const before = structuredClone(cloud),
    original = structuredClone(delivery);
  const rows = planLibraryUpdate(delivery, work, cloud, 2, "replace", ["1", "3"]);
  expect(rows.map((r) => r.action)).toEqual(["replace", "create"]);
  expect(rows[0]).toMatchObject({
    existingEpisodeId: 21,
    expectedRevision: "a".repeat(64),
    oldCount: 900,
    metadata: {
      workKey: "existing",
      editionKey: "original-edition",
      sourceKey: "original-source",
      expectedMetadataVersion: 4,
      season: 2,
      episode: 1
    }
  });
  expect(rows[1]).toMatchObject({
    expectedRevision: null,
    metadata: { sourceKey: "original-source", episode: 3 }
  });
  expect(cloud).toEqual(before);
  expect(delivery).toEqual(original);
});
it("append only skips existing episodes; identical content still needs explicit review", () => {
  const row = episode(2, 1);
  row.manifest.xmlHash = sha256Hex("new");
  expect(
    planLibraryUpdate(delivery, work, [row], 2, "append", ["1", "3"]).map((r) => r.action)
  ).toEqual(["skip", "create"]);
  const result = planLibraryUpdate(delivery, work, [row], 2, "replace", ["1", "3"])[0];
  expect(result.action).toBe("unchanged");
  expect(result.reviewed).toBe(false);
  row.reviewStatus = "approved";
  expect(planLibraryUpdate(delivery, work, [row], 2, "replace", ["1", "3"])[0].reviewed).toBe(
    true
  );
});
it("uses explicit season/episode evidence and never equates download ordinals with episodes", () => {
  expect(inferLibraryEpisode("【某剧】 - 01 - 第 2 季第 8 集.xml")).toEqual({
    season: 2,
    episode: 8
  });
  expect(inferLibraryEpisode("P12-03.xml")).toEqual({ season: null, episode: null });
  expect(() => planLibraryUpdate(delivery, work, [], 2, "replace", ["1", "1"])).toThrow(
    "不重复"
  );
  expect(() => planLibraryUpdate(delivery, work, [], 1, "replace", ["1", "3"])).toThrow("季号");
  expect(() => planLibraryUpdate(delivery, work, [], 2, "replace", ["", "3"])).toThrow("集数");
  expect(() =>
    planLibraryUpdate(delivery, { ...work, kind: "movie" }, [], 0, "replace", ["1", "2"])
  ).toThrow("一份完整");
  expect(recoverUpdateDraft({ schemaVersion: 1, rows: [] }, 2)).toBeNull();
  expect(newLibraryWork("正式片名", "tv", null).workKey).toBe(
    newLibraryWork(" 正式片名 ", "tv", null).workKey
  );
});
