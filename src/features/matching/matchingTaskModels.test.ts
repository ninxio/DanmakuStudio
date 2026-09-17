import { describe, expect, it } from "vitest";
import type { ProjectMediaReference } from "../../domain/project/types";
import {
  batchTaskStateText,
  buildMatchingRunConsoleModel,
  canAnalyzeMedia,
  unavailableMediaHint,
  type BatchTask,
  type BatchTaskState
} from "./matchingTaskModels";

describe("matching task models", () => {
  it("only enables connected media with a usable local path", () => {
    expect(canAnalyzeMedia(createMedia())).toBe(true);
    expect(canAnalyzeMedia(createMedia({ localPath: "  " }))).toBe(false);
    expect(canAnalyzeMedia(createMedia({ connectionState: "needsReconnect" }))).toBe(false);
  });

  it("explains browser-only and reconnectable media differently", () => {
    expect(unavailableMediaHint(createMedia({ referenceKind: "browserFile" }))).toContain(
      "桌面批量导入"
    );
    expect(unavailableMediaHint(createMedia({ referenceKind: "localPath" }))).toContain(
      "本地路径重新连接"
    );
  });

  it("keeps every batch terminal state user-readable", () => {
    const states: BatchTaskState[] = [
      "waiting",
      "running",
      "found",
      "unresolved",
      "notFound",
      "failed",
      "cancelled"
    ];
    expect(states.map(batchTaskStateText)).toEqual([
      "待分析",
      "运行中",
      "需复核",
      "需复核",
      "已阻断",
      "已阻断",
      "需处理"
    ]);
  });

  it("把同一关系的权威结果合并为阻断、需复核、运行中、已完成四组", () => {
    const tasks: BatchTask[] = [
      createTask("failed-pair", "source", "target-failed", "failed", "运行环境失败"),
      createTask("review-pair", "source", "target-review", "found", "已找到候选"),
      createTask("running-pair", "source", "target-running", "running", "正在分析"),
      createTask("done-pair", "source", "target-done", "found", "已自动确认")
    ];

    const model = buildMatchingRunConsoleModel({
      selectedSourceCount: 1,
      selectedTargetCount: 4,
      selectedPairCount: 4,
      selectedMediaCount: 5,
      audioReadyCount: 5,
      audioBlockerCount: 0,
      running: true,
      restartRequired: false,
      tasks,
      results: [
        {
          candidateId: "candidate-review",
          sourceMediaId: "source",
          targetMediaId: "target-review",
          classification: "review",
          message: "差异边界需要人工复核"
        }
      ],
      mediaNames: {
        source: "长视频参考",
        "target-failed": "第 1 集",
        "target-review": "第 2 集",
        "target-running": "第 3 集",
        "target-done": "第 4 集"
      },
      primaryAction: {
        kind: "cancel",
        label: "取消剩余任务",
        disabled: false
      }
    });

    expect(model.groups.map((group) => group.id)).toEqual([
      "blocked",
      "review",
      "running",
      "completed"
    ]);
    expect(model.groups.map((group) => group.title)).toEqual([
      "已阻断",
      "需复核",
      "运行中",
      "已确认"
    ]);
    expect(model.groups.flatMap((group) => group.rows.map((row) => row.id))).toEqual([
      "failed-pair",
      "review-pair",
      "running-pair",
      "done-pair"
    ]);
    expect(model.groups[1]?.rows[0]).toMatchObject({
      candidateId: "candidate-review",
      title: "第 2 集 ← 长视频参考",
      message: "已找到候选"
    });
    expect(model.runBar).toMatchObject({
      selectedPairCount: 4,
      audioReadyCount: 5,
      audioBlockerCount: 0,
      running: true
    });
  });

  it.each([false, true])("等待关系不伪装为运行；批次运行状态 %s", (running) => {
    const model = buildMatchingRunConsoleModel({
      selectedSourceCount: 40,
      selectedTargetCount: 8,
      selectedPairCount: 320,
      selectedMediaCount: 48,
      audioReadyCount: 48,
      audioBlockerCount: 0,
      running,
      restartRequired: false,
      tasks: Array.from({ length: 320 }, (_, i) =>
        createTask(`pair-${i}`, "source", `target-${i}`, "waiting", "等待分析")
      ),
      results: [],
      mediaNames: {},
      primaryAction: { kind: running ? "cancel" : "start", label: "匹配", disabled: false }
    });
    expect(model.groups.map((g) => g.id)).toEqual(["waiting"]);
    expect(model.groups[0].title).toBe(running ? "排队等待" : "待分析");
    expect(model.groups[0].rows).toHaveLength(320);
    for (const row of model.groups[0].rows) {
      expect(row.stateLabel).not.toBe("运行中");
      expect(row.nextAction).not.toContain("后台任务会继续");
      expect(row.progress).toBe(0);
    }
  });
});

function createTask(
  id: string,
  sourceMediaId: string,
  targetMediaId: string,
  state: BatchTaskState,
  message: string
): BatchTask {
  return {
    id,
    sourceMediaId,
    targetMediaId,
    state,
    progress: state === "running" ? 0.5 : 1,
    message,
    jobId: null,
    logs: []
  };
}

function createMedia(overrides: Partial<ProjectMediaReference> = {}): ProjectMediaReference {
  return {
    id: "media-1",
    role: "targetOriginal",
    name: "Episode 1",
    fileName: "episode-1.mkv",
    objectUrl: null,
    durationMs: 60_000,
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地文件",
    localPath: "C:\\media\\episode-1.mkv",
    emby: null,
    episodeKey: "S01E01",
    episodeLabel: "第 1 集",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
    audioTrackIntent: overrides.audioTrackIntent ?? { mode: "auto" }
  };
}
