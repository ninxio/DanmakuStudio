import { describe, expect, it } from "vitest";
import type { DanmakuAsset } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import { createMaterialIntakePlan } from "./materialIntakePlan";
import type { EditorProject, ProjectMediaReference, ProjectMediaRole } from "./types";

describe("material intake plan", () => {
  it("为五集一对一素材生成稳定排序、可解释且带原片上下文的建议", () => {
    const assets = [3, 1, 5, 2, 4].map((episode) =>
      asset(`asset-${episode}`, `${episode} - S01E${pad(episode)}.xml`)
    );
    const references = [5, 2, 1, 4, 3].map((episode) =>
      media(`reference-${episode}`, `Series.S01E${pad(episode)}.mp4`, "bilibiliReference")
    );
    const targets = [2, 5, 4, 1, 3].map((episode) =>
      media(`target-${episode}`, `Original.S01E${pad(episode)}.mkv`, "targetOriginal")
    );
    const project = projectWith({ assets, mediaLibrary: [...references, ...targets] });

    const plan = createMaterialIntakePlan(project);
    const reorderedPlan = createMaterialIntakePlan(
      projectWith({
        assets: [...assets].reverse(),
        mediaLibrary: [...targets, ...references].reverse()
      })
    );

    expect(plan.suggestions.map((suggestion) => suggestion.assetId)).toEqual([
      "asset-1",
      "asset-2",
      "asset-3",
      "asset-4",
      "asset-5"
    ]);
    expect(plan.suggestions.map((suggestion) => suggestion.id)).toEqual(
      reorderedPlan.suggestions.map((suggestion) => suggestion.id)
    );
    expect(plan.suggestions[0]).toMatchObject({
      sourceMediaId: "reference-1",
      targetMediaId: "target-1",
      episodeLabel: "第 1 季第 1 集"
    });
    expect(plan.suggestions[0].evidence.map((item) => item.message).join(" ")).toContain(
      "只有一个参考素材候选"
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it("把重复、多候选、跨季、many-to-one 和缺失集号集中到异常，并保留已有绑定", () => {
    const project = projectWith({
      assets: [
        asset("duplicate-a", "S01E01.xml"),
        asset("duplicate-b", "S01E01.xml"),
        asset("ambiguous", "S01E02.xml"),
        asset("cross-season", "S01E03.xml"),
        asset("many-explicit", "S01E04.xml"),
        asset("many-episode-only", "E04.xml"),
        asset("missing", "未标集数.xml"),
        asset("existing", "S01E05.xml")
      ],
      mediaLibrary: [
        media("reference-1", "S01E01.mp4", "bilibiliReference"),
        media("reference-2a", "S01E02.A.mp4", "bilibiliReference"),
        media("reference-2b", "S01E02.B.mp4", "bilibiliReference"),
        media("reference-3", "S02E03.mp4", "bilibiliReference"),
        media("reference-4", "S01E04.mp4", "bilibiliReference"),
        media("reference-5", "S01E05.mp4", "bilibiliReference")
      ],
      danmakuSourceBindings: [
        {
          id: "existing-binding",
          assetId: "existing",
          sourceMediaId: "reference-5",
          linkedAt: "2026-08-29T00:00:00.000Z",
          updatedAt: "2026-08-29T00:00:00.000Z"
        }
      ]
    });

    const plan = createMaterialIntakePlan(project);
    const reasons = plan.conflicts.map((conflict) => conflict.reason);

    expect(plan.suggestions).toEqual([]);
    expect(reasons.filter((reason) => reason === "duplicateXmlEpisode")).toHaveLength(2);
    expect(reasons).toContain("multipleReferenceCandidates");
    expect(reasons).toContain("crossSeason");
    expect(reasons.filter((reason) => reason === "manyToOne")).toHaveLength(2);
    expect(plan.unresolved).toEqual([
      expect.objectContaining({ assetId: "missing", reason: "missingXmlEpisode" })
    ]);
    expect(plan.preservedBindings).toHaveLength(1);
    expect(plan.preservedBindings[0]).toMatchObject({
      assetId: "existing",
      sourceMediaId: "reference-5"
    });
    expect(plan.preservedBindings[0].message).toContain("保留");
  });

  it("只接受形状一致的范围与 Part，形状不一致进入冲突", () => {
    const plan = createMaterialIntakePlan(
      projectWith({
        assets: [
          asset("range", "01 - S01E06-E07.xml"),
          asset("part", "02 - S01E08 Part2.xml"),
          asset("part-mismatch", "03 - S01E09 Part2.xml")
        ],
        mediaLibrary: [
          media("range-reference", "S01E06-E07.mp4", "bilibiliReference"),
          media("part-reference", "S01E08 Part2.mp4", "bilibiliReference"),
          media("whole-reference", "S01E09.mp4", "bilibiliReference")
        ]
      })
    );

    expect(plan.suggestions.map((suggestion) => suggestion.assetId)).toEqual(["range", "part"]);
    expect(plan.suggestions[1].evidence.map((item) => item.message).join(" ")).toContain(
      "Part 2"
    );
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        assetId: "part-mismatch",
        reason: "relationshipShape"
      })
    ]);
  });

  it("缺季号 XML 遇到参考与原片跨季时拒绝生成建议", () => {
    const plan = createMaterialIntakePlan(
      projectWith({
        assets: [asset("season-unknown", "E01.xml")],
        mediaLibrary: [
          media("reference-season-2", "Reference.S02E01.mp4", "bilibiliReference"),
          media("target-season-1", "Original.S01E01.mkv", "targetOriginal")
        ]
      })
    );

    expect(plan.suggestions).toEqual([]);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        assetId: "season-unknown",
        reason: "crossSeason",
        candidateSourceMediaIds: ["reference-season-2"]
      })
    ]);
    expect(plan.conflicts[0].message).toContain("原片");
  });
});

function projectWith(
  patch: Pick<EditorProject, "assets" | "mediaLibrary"> &
    Partial<Pick<EditorProject, "danmakuSourceBindings">>
): EditorProject {
  return {
    ...createEmptyProject("批量关系测试"),
    assets: patch.assets,
    mediaLibrary: patch.mediaLibrary,
    danmakuSourceBindings: patch.danmakuSourceBindings ?? []
  };
}

function asset(id: string, fileName: string): DanmakuAsset {
  return {
    id,
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    color: "#38bdf8",
    items: [],
    warnings: [],
    importedAt: "2026-08-29T00:00:00.000Z",
    sourceReceipt: null
  };
}

function media(id: string, fileName: string, role: ProjectMediaRole): ProjectMediaReference {
  return {
    id,
    role,
    name: fileName.replace(/\.[^.]+$/, ""),
    fileName,
    objectUrl: null,
    durationMs: null,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: fileName,
    localPath: `F:\\TEST\\${fileName}`,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z"
  };
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
