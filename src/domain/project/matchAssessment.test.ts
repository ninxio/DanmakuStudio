import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuItem } from "../danmaku/types";
import { createEmptyProject } from "./factory";
import { createEmbyItemMediaBinding } from "./mediaBinding";
import { createProjectMatchAssessment, formatProjectMatchScore } from "./matchAssessment";

describe("项目匹配评分", () => {
  it("缺少目标原片时只给确认提示，不生成对齐提案", () => {
    const project = {
      ...createEmptyProject("测试项目"),
      assets: [createAsset("测试剧集 S01E01.xml", 20, 30_000)]
    };

    const assessment = createProjectMatchAssessment(project);

    expect(assessment.conclusion).toBe("review");
    expect(assessment.conclusionLabel).toBe("需要确认");
    expect(assessment.proposal).toBeNull();
    expect(assessment.criteria.find((criterion) => criterion.id === "target")).toMatchObject({
      state: "negative",
      summary: "还没有绑定目标原片"
    });
  });

  it("标题、集数、时长和密度一致时给出很可能匹配并生成复核提案", () => {
    const project = {
      ...createEmptyProject("测试剧集 S01E02"),
      mediaBinding: createTestEmbyBinding(3_600_000),
      assets: [createAsset("测试剧集 S01E02.xml", 240, 15_000)]
    };

    const assessment = createProjectMatchAssessment(project);

    expect(assessment.conclusion).toBe("likely");
    expect(formatProjectMatchScore(assessment.score)).toMatch(/\d+%/);
    expect(assessment.criteria.find((criterion) => criterion.id === "titleEpisode")).toMatchObject({
      state: "positive"
    });
    expect(assessment.criteria.find((criterion) => criterion.id === "duration")).toMatchObject({
      state: "positive"
    });
    expect(assessment.criteria.find((criterion) => criterion.id === "density")).toMatchObject({
      state: "positive"
    });
    expect(assessment.proposal?.anchors).toHaveLength(1);
    expect(assessment.proposal?.anchors[0]).toMatchObject({
      sourceMs: 3_585_000,
      targetMs: 3_600_000,
      origin: "automatic"
    });
    expect(assessment.proposal?.diagnostics[0]).toContain("匹配评分");
    expect(JSON.stringify(assessment.proposal)).not.toContain("token");
  });

  it("片名和时长明显冲突时不会伪装成匹配", () => {
    const project = {
      ...createEmptyProject("完全不同的电影"),
      mediaBinding: createTestEmbyBinding(3_600_000),
      assets: [createAsset("另一个短片.xml", 8, 20_000)]
    };

    const assessment = createProjectMatchAssessment(project);

    expect(assessment.conclusion).toBe("unlikely");
    expect(assessment.conclusionLabel).toBe("看起来不是同一集");
    expect(assessment.criteria.find((criterion) => criterion.id === "duration")).toMatchObject({
      state: "negative"
    });
    expect(assessment.proposal?.cutCandidates).toEqual([]);
    expect(assessment.proposal?.diagnostics).toContain(
      "总时长差不会自动生成版本差异；需要音频、视觉或人工复核定位后再应用会影响导出的规则。"
    );
  });
});

function createTestEmbyBinding(runtimeMs: number) {
  return createEmbyItemMediaBinding(
    "binding-emby",
    {
      id: "emby-item-2",
      name: "第二集",
      type: "Episode",
      seriesName: "测试剧集",
      seasonNumber: 1,
      episodeNumber: 2,
      durationMs: runtimeMs,
      mediaSources: []
    },
    {
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    },
    "2026-07-10T00:00:00.000Z"
  );
}

function createAsset(fileName: string, itemCount: number, intervalMs: number): DanmakuAsset {
  const assetId = `asset-${fileName}`;
  return {
    id: assetId,
    name: fileName.replace(/\.xml$/i, ""),
    fileName,
    color: "#38bdf8",
    importedAt: "2026-07-10T00:00:00.000Z",
    sourceReceipt: null,
    warnings: [],
    items: Array.from({ length: itemCount }, (_, index): DanmakuItem => {
      const timeMs = index * intervalMs;
      return {
        id: `${assetId}-${index}`,
        assetId,
        originalIndex: index,
        sourceTimeMs: timeMs,
        mode: 1,
        fontSize: 25,
        color: 0xffffff,
        timestamp: null,
        pool: null,
        userHash: null,
        rowId: null,
        text: `弹幕 ${index + 1}`,
        rawPFields: [String(timeMs / 1000)],
        enabled: true
      };
    })
  };
}
