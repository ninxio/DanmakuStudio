import { describe, expect, it } from "vitest";
import type { DanmakuAsset, DanmakuClip } from "../danmaku/types";
import { createEmptyProject } from "../project/factory";
import type { EditorProject } from "../project/types";
import { createPlayerSourceComparisonSummary } from "./playerComparison";

describe("播放器双源对比摘要", () => {
  it("为空项目保持隐藏，避免打扰第一步导入", () => {
    const summary = createPlayerSourceComparisonSummary({
      project: createEmptyProject(),
      referenceTimeMs: 0,
      hasReferencePlaybackSource: false
    });

    expect(summary.visible).toBe(false);
    expect(summary.stateLabel).toBe("等待素材");
    expect(summary.nextActionLabel).toBe("先导入 B 站 XML 或参考视频。");
  });

  it("说明 Emby 目标可以授权采样并显式生成 mpv 预览流", () => {
    const project: EditorProject = {
      ...createEmptyProject(),
      assets: [createAsset("asset-1")],
      clips: [createClip("clip-1", "asset-1")],
      mediaBinding: {
        id: "binding-emby",
        kind: "embyItem",
        displayName: "Demo / S01E01 / Episode 1",
        itemId: "episode-1",
        itemName: "Episode 1",
        itemType: "Episode",
        seriesName: "Demo",
        seasonNumber: 1,
        episodeNumber: 1,
        runtimeMs: 3_000_000,
        linkedAt: "2026-07-10T00:00:00.000Z",
        server: { serverUrl: "https://emby.example.test", pathPrefix: "/emby", username: "tester" },
        mediaSources: []
      }
    };

    const summary = createPlayerSourceComparisonSummary({
      project,
      referenceTimeMs: 12_000,
      hasReferencePlaybackSource: false
    });

    expect(summary.visible).toBe(true);
    expect(summary.stateLabel).toBe("双源对比可复核");
    expect(summary.referenceLabel).toBe("B 站 XML 时间轴");
    expect(summary.targetLabel).toBe("Emby 目标原片");
    expect(summary.referenceTimeLabel).toBe("00:00:12.000");
    expect(summary.nextActionLabel).toBe("可显式生成 Emby 授权流进行 mpv 预览；音频对齐也可使用授权输入。");
  });

  it("把当前参考时间映射到已应用版本差异后的目标时间", () => {
    const project: EditorProject = {
      ...createEmptyProject(),
      media: {
        id: "media-local",
        name: "cut",
        fileName: "cut.mp4",
        objectUrl: "blob:cut",
        durationMs: 120_000
      },
      mediaBinding: {
        id: "binding-local",
        kind: "localFile",
        displayName: "完整版",
        fileName: "full.mkv",
        mediaId: null,
        localPath: "D:\\media\\full.mkv",
        runtimeMs: 180_000,
        linkedAt: "2026-07-10T00:00:00.000Z"
      },
      cutMarkers: [
        {
          id: "cut-1",
          name: "片头缺失",
          sourceAtMs: 2_000,
          targetGapMs: 45_000,
          note: "目标完整版在此处额外存在内容"
        }
      ]
    };

    const summary = createPlayerSourceComparisonSummary({
      project,
      referenceTimeMs: 2_500,
      hasReferencePlaybackSource: true
    });

    expect(summary.referenceLabel).toBe("B 站参考视频");
    expect(summary.targetLabel).toBe("本地目标原片");
    expect(summary.referenceTimeLabel).toBe("00:00:02.500");
    expect(summary.targetTimeLabel).toBe("00:00:47.500");
    expect(summary.compensationLabel).toBe("+00:00:45.000");
    expect(summary.compensationDetail).toBe("1 个版本差异，当前点已应用补偿。");
  });
});

function createAsset(id: string): DanmakuAsset {
  return {
    id,
    name: "B 站弹幕",
    fileName: "episode.xml",
    color: "#38bdf8",
    items: [],
    warnings: [],
    importedAt: "2026-07-10T00:00:00.000Z",
    sourceReceipt: null
  };
}

function createClip(id: string, assetId: string): DanmakuClip {
  return {
    id,
    assetId,
    name: "片段",
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 60_000,
    localOffsetMs: 0,
    enabled: true
  };
}
