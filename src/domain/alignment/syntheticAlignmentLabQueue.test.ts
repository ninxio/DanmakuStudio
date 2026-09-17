import { describe, expect, it } from "vitest";
import {
  evaluateRealMediaBenchmark,
  type RealMediaBenchmarkManifest
} from "./realMediaBenchmark";
import {
  appendSyntheticAlignmentLabManifests,
  beginSyntheticAlignmentLabSuite,
  createSyntheticAlignmentLabQueueSummary,
  createSyntheticAlignmentLabQueue,
  failSyntheticAlignmentLabSuite,
  finishSyntheticAlignmentLabSuite,
  parseSyntheticAlignmentLabQueue,
  parseSyntheticAlignmentLabQueueJson,
  parseSyntheticAlignmentLabQueueSummary,
  parseSyntheticAlignmentLabQueueSummaryJson,
  recoverSyntheticAlignmentLabQueue,
  retrySyntheticAlignmentLabSuites,
  serializeSyntheticAlignmentLabQueue,
  serializeSyntheticAlignmentLabQueueSummary,
  type SyntheticAlignmentLabRunOutcome
} from "./syntheticAlignmentLabQueue";

describe("便携程序化对齐实验队列", () => {
  it("跨 manifest 建队、确定性去重并严格限制程序化 development 输入", () => {
    const first = manifest("suite-a");
    const second = manifest("suite-b");
    const queue = createSyntheticAlignmentLabQueue("portable-1", [first, first], 1);
    expect(queue.suites).toHaveLength(1);

    const appended = appendSyntheticAlignmentLabManifests(queue, [first, second], 2);
    expect(appended.suites).toHaveLength(2);
    expect(appended.suites[0].suiteId).not.toBe(appended.suites[1].suiteId);

    const frozen = manifest("frozen");
    frozen.cases[0].split = "frozen-test";
    expect(() => createSyntheticAlignmentLabQueue("bad", [frozen], 1)).toThrow(
      "只接受非示例 synthetic/development"
    );
  });

  it("逐套件记录尝试和无路径摘要，并让其余待办继续存在", () => {
    const first = manifest("suite-a");
    const second = manifest("suite-b");
    let queue = createSyntheticAlignmentLabQueue("portable-1", [first, second], 1);
    const firstId = queue.suites[0].suiteId;
    queue = beginSyntheticAlignmentLabSuite(queue, firstId, 2);
    expect(queue.state).toBe("running");
    expect(queue.suites[0].attemptCount).toBe(1);

    queue = finishSyntheticAlignmentLabSuite(queue, firstId, report(first), 3);
    expect(queue.state).toBe("ready");
    expect(queue.suites[0]).toMatchObject({
      state: "completed",
      receipt: {
        completedCaseCount: 1,
        failedCaseCount: 0,
        missingPredictionCount: 0,
        editClassificationF1: 1
      }
    });
    expect(queue.suites[1].state).toBe("pending");
    expect(serializeSyntheticAlignmentLabQueue(queue)).not.toContain("native-job-id");
    const summary = createSyntheticAlignmentLabQueueSummary(queue);
    expect(summary.releaseEligible).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("C:/private");
  });

  it("runner 异常只终结当前套件，失败套件可显式重试", () => {
    let queue = createSyntheticAlignmentLabQueue("portable-1", [manifest("suite-a")], 1);
    const suiteId = queue.suites[0].suiteId;
    queue = beginSyntheticAlignmentLabSuite(queue, suiteId, 2);
    queue = failSyntheticAlignmentLabSuite(queue, suiteId, 3);
    expect(queue.state).toBe("completedWithIssues");
    expect(queue.suites[0]).toMatchObject({
      state: "failed",
      receipt: { status: "runner-failed", failureCode: "runner" }
    });

    queue = retrySyntheticAlignmentLabSuites(queue, [suiteId], 4);
    expect(queue.state).toBe("ready");
    expect(queue.suites[0]).toMatchObject({ state: "pending", attemptCount: 1, receipt: null });
  });

  it("应用中断时把运行套件降回 pending 并累计中断次数", () => {
    let queue = createSyntheticAlignmentLabQueue("portable-1", [manifest("suite-a")], 1);
    queue = beginSyntheticAlignmentLabSuite(queue, queue.suites[0].suiteId, 2);

    const recovered = recoverSyntheticAlignmentLabQueue(queue, 3);

    expect(recovered.state).toBe("interrupted");
    expect(recovered.activeSuiteId).toBeNull();
    expect(recovered.suites[0]).toMatchObject({ state: "pending", interruptionCount: 1 });
    expect(recovered.lastError).toContain("不能视为完成");
  });

  it("序列化 round-trip 并拒绝 manifest 摘要和状态篡改", () => {
    const queue = createSyntheticAlignmentLabQueue("portable-1", [manifest("suite-a")], 1);
    const serialized = serializeSyntheticAlignmentLabQueue(queue);
    expect(parseSyntheticAlignmentLabQueueJson(serialized)).toEqual(queue);

    const tampered = structuredClone(queue);
    tampered.suites[0].manifest.name = "tampered";
    expect(() => parseSyntheticAlignmentLabQueue(tampered)).toThrow("manifest 摘要不匹配");

    const invalidState = structuredClone(queue);
    invalidState.state = "running";
    expect(() => parseSyntheticAlignmentLabQueue(invalidState)).toThrow(
      "运行状态与 activeSuiteId 不一致"
    );

    const falseCompletion = structuredClone(queue);
    falseCompletion.state = "completed";
    expect(() => parseSyntheticAlignmentLabQueue(falseCompletion)).toThrow(
      "汇总状态与套件状态不一致"
    );
  });

  it("拒绝伪造完成状态、缺失 case 和越界指标", () => {
    const manifestValue = manifest("suite-a");
    const initial = createSyntheticAlignmentLabQueue("portable-1", [manifestValue], 1);
    const suiteId = initial.suites[0].suiteId;
    const running = beginSyntheticAlignmentLabSuite(initial, suiteId, 2);

    const missingCase = report(manifestValue);
    missingCase.caseReceipts = [];
    expect(() => finishSyntheticAlignmentLabSuite(running, suiteId, missingCase, 3)).toThrow(
      "case 数与 manifest 不一致"
    );

    const contradictory = report(manifestValue);
    contradictory.caseReceipts[0].state = "failed";
    expect(() => finishSyntheticAlignmentLabSuite(running, suiteId, contradictory, 3)).toThrow(
      "状态与 case 回执不一致"
    );

    const invalidMetric = report(manifestValue);
    invalidMetric.result.overall.mappingCoverage = 1.1;
    expect(() => finishSyntheticAlignmentLabSuite(running, suiteId, invalidMetric, 3)).toThrow(
      "mappingCoverage 必须位于 0–1 或为 null"
    );
  });

  it("严格读取无路径汇总并拒绝状态、计数和未知字段篡改", () => {
    const manifestValue = manifest("suite-a");
    let queue = createSyntheticAlignmentLabQueue("portable-1", [manifestValue], 1);
    queue = beginSyntheticAlignmentLabSuite(queue, queue.suites[0].suiteId, 2);
    queue = finishSyntheticAlignmentLabSuite(
      queue,
      queue.suites[0].suiteId,
      report(manifestValue),
      3
    );
    const summary = parseSyntheticAlignmentLabQueueSummaryJson(
      serializeSyntheticAlignmentLabQueueSummary(queue)
    );
    expect(summary.state).toBe("completed");

    const badState = structuredClone(summary);
    badState.state = "ready";
    expect(() => parseSyntheticAlignmentLabQueueSummary(badState)).toThrow(
      "状态与套件状态不一致"
    );

    const badCount = structuredClone(summary);
    badCount.totalCaseCount = 2;
    expect(() => parseSyntheticAlignmentLabQueueSummary(badCount)).toThrow(
      "totalCaseCount 不一致"
    );

    const unknown = { ...summary, path: "C:/private/source.flac" };
    expect(() => parseSyntheticAlignmentLabQueueSummary(unknown)).toThrow("包含未知字段");
  });
});

function manifest(id: string): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id,
    name: `程序化套件 ${id}`,
    datasetVersion: `${id}-v1`,
    description: "只用于开发回归。",
    isExample: false,
    licenseNotes: ["Authorized local fixture."],
    cases: [
      {
        id: `${id}-case-1`,
        title: "无编辑变体",
        mediaKind: "synthetic",
        split: "development",
        scenarios: ["codec-variant"],
        source: media(`C:/private/${id}-source.flac`),
        target: media(`C:/private/${id}-target.flac`),
        boundaryToleranceMs: 300,
        versionNotes: ["Known transform graph."],
        licenseNotes: ["Development-only synthetic evidence."],
        independentAnnotations: [],
        adjudication: null,
        gold: {
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000,
          matchedAnchors: [{ id: "middle", sourceMs: 5_000, targetMs: 5_000 }],
          sourceOnlySpans: [],
          targetOnlySpans: [],
          ambiguousSpans: []
        }
      }
    ]
  };
}

function media(path: string) {
  return {
    path,
    audioStreamIndex: 0,
    videoStreamIndex: null,
    contentIdentity: null,
    versionNote: "16 kHz mono",
    licenseNote: "Authorized local fixture."
  };
}

function report(manifestValue: RealMediaBenchmarkManifest): SyntheticAlignmentLabRunOutcome {
  const result = evaluateRealMediaBenchmark(manifestValue, [
    {
      caseId: manifestValue.cases[0].id,
      spans: [
        {
          kind: "matched" as const,
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }
      ]
    }
  ]);
  return {
    schemaVersion: "alignment-synthetic-run-report-v2" as const,
    manifestId: manifestValue.id,
    datasetVersion: manifestValue.datasetVersion,
    status: "completed" as const,
    caseReceipts: [{ state: "completed" as const }],
    result,
    releaseEligible: false as const,
    note: "programmatic-development-evidence-never-real-gold" as const
  };
}
