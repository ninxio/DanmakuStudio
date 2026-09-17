import { describe, expect, it } from "vitest";
import { createEpisodeMatchingProject } from "../../test/episodeMatching";
import { createSmartBatchPairingPlan } from "../alignment/smartBatchPairing";
import { createLocalPathMediaReference } from "./mediaLibrary";
import {
  resolveProjectEpisodeEvidence,
  updateReferenceEpisodeHint
} from "./mediaEpisodeEvidence";
import { parseProjectJson, serializeProject } from "./schema";
import type { EditorProject } from "./types";

function plan(project: EditorProject) {
  return createSmartBatchPairingPlan(
    project.mediaLibrary.filter((m) => m.role === "bilibiliReference"),
    project.mediaLibrary.filter((m) => m.role === "targetOriginal"),
    resolveProjectEpisodeEvidence(project)
  );
}
describe("episode evidence routing", () => {
  it("merged XML and conflicting seasons are local uncertainties", () => {
    const p = createEpisodeMatchingProject([2, 2]);
    p.assets[0].xmlMetadata!.sources.push({ ...p.assets[0].xmlMetadata!.sources[0], bvid: "BV1yy411c7mD" });
    const source = p.mediaLibrary.find(m => m.id === "source-3")!;
    source.episodeLabel = "E02";
    source.name = "S01E02";
    source.fileName = "S02E02.m4a";
    const result = plan(p);
    expect(result.pairs.filter(p => p.sourceMediaId === "source-1")).toHaveLength(2);
    expect(result.pairs.filter(p => p.sourceMediaId === "source-3")).toHaveLength(2);
  });
  it("routes forty bound pieces to eight originals without mutating source data", () => {
    const project = createEpisodeMatchingProject();
    const before = JSON.stringify(project);
    const result = plan(project);
    expect(result).toMatchObject({
      mode: "metadataGuided",
      totalCartesianPairCount: 320,
      excludedPairCount: 280,
      uncertainPairCount: 0
    });
    expect(result.pairs).toHaveLength(40);
    for (let episode = 1; episode <= 8; episode++)
      expect(
        result.pairs
          .filter((p) => p.targetMediaId === "target-" + episode)
          .map((p) => p.sourceMediaId)
      ).toEqual(
        Array.from({ length: 5 }, (_, part) => "source-" + ((episode - 1) * 5 + part + 1))
      );
    expect(JSON.stringify(project)).toBe(before);
  });
  it("uses full family context when only one piece is selected and avoids reading comments", () => {
    const p = createEpisodeMatchingProject([2, 3]);
    for (const a of p.assets)
      Object.defineProperty(a, "items", {
        get: () => {
          throw new Error("comments must not be read");
        }
      });
    const evidence = resolveProjectEpisodeEvidence(p);
    const result = createSmartBatchPairingPlan(
      p.mediaLibrary.filter((m) => m.id === "source-2"),
      p.mediaLibrary.filter((m) => m.role === "targetOriginal"),
      evidence
    );
    expect(result.pairs.map((p) => p.targetMediaId)).toEqual(["target-1"]);
  });
  it("holds out unequal sizes, shifted episodes, renaming and shuffled order", () => {
    const p = createEpisodeMatchingProject([3, 1, 6, 2], 4, 11);
    p.assets.reverse();
    p.mediaLibrary.reverse();
    p.assets.forEach((a) => (a.fileName = a.id + ".xml"));
    p.mediaLibrary
      .filter((m) => m.role === "bilibiliReference")
      .forEach((m) => {
        m.name = m.id;
        m.fileName = m.id + ".m4a";
      });
    const result = plan(p);
    expect(
      [11, 12, 13, 14].map(
        (e) => result.pairs.filter((p) => p.targetMediaId === "target-" + e).length
      )
    ).toEqual([3, 1, 6, 2]);
  });
  it("expands only an unknown reference and leaves known rows pruned", () => {
    const p = createEpisodeMatchingProject([2, 2, 2]);
    p.mediaLibrary.push(
      createLocalPathMediaReference("unknown", "bilibiliReference", "D:/unknown.m4a")
    );
    const result = plan(p);
    expect(result.pairs).toHaveLength(9);
    expect(result.uncertainPairCount).toBe(3);
    expect(result.excludedPairCount).toBe(12);
  });
  it("expands only an unknown original", () => {
    const p = createEpisodeMatchingProject([2, 2]);
    p.mediaLibrary.push(
      createLocalPathMediaReference("unknown", "targetOriginal", "D:/unknown.mkv")
    );
    expect(plan(p).pairs).toHaveLength(8);
    expect(plan(p).uncertainPairCount).toBe(4);
  });
  it("preserves overlapping collections, duplicate pieces and parallel sources as distinct candidates", () => {
    const p = createEpisodeMatchingProject([2, 2, 2]);
    p.mediaLibrary.push(
      createLocalPathMediaReference("collection", "bilibiliReference", "D:/S01E01-E03.mkv")
    );
    const duplicate = structuredClone(p.assets[0]);
    duplicate.id = "duplicate";
    p.assets.push(duplicate);
    p.mediaLibrary.push(
      createLocalPathMediaReference("parallel", "bilibiliReference", "D:/S01E01.mkv")
    );
    const result = plan(p);
    expect(result.pairs).toHaveLength(10);
    expect(result.pairs.filter((p) => p.targetMediaId === "target-1")).toHaveLength(4);
  });
  it("keeps seasons separate and does not reinterpret missing pieces as later episodes", () => {
    const p = createEpisodeMatchingProject([3, 2]);
    p.assets.splice(0, 1);
    p.mediaLibrary = p.mediaLibrary.filter((m) => m.id !== "source-1");
    p.danmakuSourceBindings.splice(0, 1);
    p.mediaLibrary.push(
      createLocalPathMediaReference("other-season", "targetOriginal", "D:/Show S02E01.mkv")
    );
    expect(plan(p).pairs).toHaveLength(4);
    expect(plan(p).pairs.some((pair) => pair.targetMediaId === "other-season")).toBe(false);
  });
  it("does not discard either season for a cross-season collection", () => {
    const p = createEpisodeMatchingProject([2, 2]);
    p.mediaLibrary.push(
      createLocalPathMediaReference("cross", "bilibiliReference", "D:/S01E02-S02E01.mp4")
    );
    p.mediaLibrary.push(
      createLocalPathMediaReference("next-season", "targetOriginal", "D:/S02E01.mkv")
    );
    expect(plan(p).pairs.filter((pair) => pair.sourceMediaId === "cross")).toHaveLength(3);
  });
  it("expands only a reference whose XML name conflicts with its original part", () => {
    const p = createEpisodeMatchingProject([2, 2, 2]);
    p.assets[0].fileName = "S01E03.xml";
    p.assets[0].xmlMetadata!.sources[0].part = "S01E01 Part 1";
    const result = plan(p);
    expect(result.pairs).toHaveLength(8);
    expect(result.pairs.filter((p) => p.sourceMediaId === "source-1")).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("冲突");
  });
  it("does not borrow ambiguous XML bindings, and preserves other valid hints", () => {
    const p = createEpisodeMatchingProject([2, 2]);
    p.danmakuSourceBindings.push({
      ...p.danmakuSourceBindings[0],
      id: "ambiguous",
      sourceMediaId: "source-3"
    });
    const result = plan(p);
    expect(result.pairs.filter((p) => p.sourceMediaId === "source-1")).toHaveLength(2);
    expect(result.pairs.filter((p) => p.sourceMediaId === "source-3")).toHaveLength(2);
    expect(result.pairs.filter((p) => p.sourceMediaId === "source-2")).toHaveLength(1);
  });
  it("keeps a fully out-of-scope reference excluded and explains empty target coverage", () => {
    const p = createEpisodeMatchingProject([2, 2]);
    p.mediaLibrary.push(
      createLocalPathMediaReference("outside", "bilibiliReference", "D:/S03E01.mp4")
    );
    expect(plan(p).pairs).toHaveLength(4);
    expect(plan(p).warnings.join(" ")).toContain("所选原片范围");
  });
  it("an explicit correction overrides the suggestion, round-trips and can return to automatic", () => {
    const p = createEpisodeMatchingProject([2, 2]);
    const updated = updateReferenceEpisodeHint(p, "source-1", "S01E02");
    const restored = parseProjectJson(serializeProject(updated));
    expect(
      plan(restored).pairs.find((p) => p.sourceMediaId === "source-1")?.targetMediaId
    ).toBe("target-2");
    expect(
      plan(updateReferenceEpisodeHint(restored, "source-1", "")).pairs.find(
        (p) => p.sourceMediaId === "source-1"
      )?.targetMediaId
    ).toBe("target-1");
    expect(p.mediaLibrary.find((m) => m.id === "source-1")?.episodeKey).toBeNull();
    expect(updated.mediaTimeMaps).toBe(p.mediaTimeMaps);
    expect(updated.assets).toBe(p.assets);
    expect(() => updateReferenceEpisodeHint(p, "source-1", "1.2")).toThrow("请输入");
  });
});
