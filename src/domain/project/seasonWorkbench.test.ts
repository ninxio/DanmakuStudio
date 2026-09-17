import { describe, expect, it } from "vitest";
import type { BatchMergePlan } from "../danmaku/batchMerge";
import type { DanmakuAsset } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import { createSeasonWorkbenchSummary } from "./seasonWorkbench";

describe("剧集工作台摘要", () => {
  it("为空项目提示从导入 XML 开始", () => {
    const summary = createSeasonWorkbenchSummary(createEmptyProject(), createEmptyPlan(), []);

    expect(summary).toMatchObject({ statusId: "preparing", statusLabel: "准备中" });
    expect(summary.nextActionLabel).toContain("导入 XML");
    expect(summary.steps[0]).toMatchObject({ id: "source", state: "active" });
  });

  it("说明已具备批量导出基础条件", () => {
    const project = {
      ...createEmptyProject(),
      assets: [createAsset("asset-1")],
      mediaBinding: {
        id: "binding-local",
        kind: "localFile" as const,
        displayName: "完整版",
        fileName: "full.mkv",
        mediaId: null,
        localPath: "D:\\media\\full.mkv",
        runtimeMs: 3_000_000,
        linkedAt: "2026-07-10T00:00:00.000Z"
      },
      cutMarkers: [{ id: "cut-1", name: "片头", sourceAtMs: 10_000, targetGapMs: 45_000, note: "" }]
    };
    const summary = createSeasonWorkbenchSummary(
      project,
      {
        ...createEmptyPlan(),
        episodes: [
          {
            id: "episode-1",
            seasonNumber: 1,
            episodeNumber: 1,
            label: "第 1 集",
            fileName: "S01E01.xml",
            sourceFileNames: ["01.xml"],
            itemCount: 1,
            entries: [],
            warnings: []
          }
        ],
        confidence: "high"
      },
      []
    );

    expect(summary).toMatchObject({ statusId: "runnable", statusLabel: "可运行" });
    expect(summary.metrics).toContainEqual({ label: "输出", value: "1 个" });
    expect(summary.steps.map((step) => [step.id, step.state])).toEqual([
      ["source", "complete"],
      ["target", "complete"],
      ["split", "complete"],
      ["alignment", "complete"],
      ["export", "active"]
    ]);
    expect(summary.steps.map((step) => step.statusId)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
      "runnable"
    ]);
  });
});

function createEmptyPlan(): BatchMergePlan {
  return {
    episodes: [],
    diagnostics: [],
    confidence: "low",
    compensation: {
      markerCount: 0,
      totalGapMs: 0,
      affectedEntryCount: 0,
      affectedEpisodeCount: 0
    }
  };
}

function createAsset(id: string): DanmakuAsset {
  return {
    id,
    name: "第 1 集",
    fileName: "01.xml",
    color: "#38bdf8",
    items: [],
    warnings: [],
    importedAt: "2026-07-10T00:00:00.000Z",
    sourceReceipt: null
  };
}
