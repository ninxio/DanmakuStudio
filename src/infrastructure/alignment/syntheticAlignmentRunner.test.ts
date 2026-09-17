import { describe, expect, it, vi } from "vitest";
import type { RealMediaBenchmarkManifest } from "../../domain/alignment/realMediaBenchmark";
import type { AlignmentProposal } from "../../domain/alignment/types";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import type {
  AudioAlignmentJobInvoker,
  AudioAlignmentJobSnapshot,
  NormalizedTauriAudioAlignmentRequest
} from "./tauriAudioAlignment";
import {
  createSyntheticAlignmentRunReportId,
  parseSyntheticAlignmentRunReportJson,
  runSyntheticAlignmentManifest,
  serializeSyntheticAlignmentRunReport
} from "./syntheticAlignmentRunner";

describe("程序化音频变体回归 runner", () => {
  it("只接受非示例的 synthetic/development manifest", async () => {
    const manifest = createManifest(1);
    manifest.cases[0].mediaKind = "real";
    const invoker = emptyInvoker();

    await expect(runSyntheticAlignmentManifest(manifest, options(invoker))).rejects.toThrow(
      "manifest 无效"
    );
    expect(invoker.start).not.toHaveBeenCalled();

    const frozen = createManifest(1);
    frozen.cases[0].split = "frozen-test";
    await expect(runSyntheticAlignmentManifest(frozen, options(invoker))).rejects.toThrow(
      "只接受 synthetic/development"
    );
    expect(invoker.start).not.toHaveBeenCalled();
  });

  it("逐 case 运行、隔离失败并导出不含媒体路径的开发报告", async () => {
    const manifest = createManifest(2);
    const requests: NormalizedTauriAudioAlignmentRequest[] = [];
    let startCount = 0;
    const invoker: AudioAlignmentJobInvoker = {
      start: vi.fn((request: NormalizedTauriAudioAlignmentRequest) => {
        requests.push(request);
        startCount += 1;
        return Promise.resolve(runningSnapshot(`job-${startCount}`));
      }),
      get: vi.fn((jobId: string) =>
        Promise.resolve(
          jobId === "job-1"
            ? completedSnapshot(jobId, createProposal())
            : failedSnapshot(jobId)
        )
      ),
      cancel: vi.fn()
    };
    const progress = vi.fn();
    const clock = createClock();

    const report = await runSyntheticAlignmentManifest(manifest, {
      ...options(invoker),
      now: clock.now,
      wait: clock.wait,
      onProgress: progress
    });

    expect(report.status).toBe("completed-with-failures");
    expect(report.schemaVersion).toBe("alignment-synthetic-run-report-v2");
    expect(report.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.releaseEligible).toBe(false);
    expect(report.note).toBe("programmatic-development-evidence-never-real-gold");
    expect(report.caseReceipts).toMatchObject([
      { caseId: "synthetic-case-1", state: "completed", nativeJobId: "job-1" },
      {
        caseId: "synthetic-case-2",
        state: "failed",
        nativeJobId: "job-2",
        failureCode: "native-failed"
      }
    ]);
    expect(report.result.overall.missingPredictionCount).toBe(1);
    expect(report.predictions).toHaveLength(1);
    expect(report.predictions[0]).toMatchObject({
      caseId: "synthetic-case-1",
      spans: [{ kind: "matched", sourceStartMs: 0, sourceEndMs: 10_000 }]
    });
    expect(report.configuration).toEqual({
      spectralBackend: "cpu",
      windowMs: 8_000,
      minGapMs: 1_000,
      matchThreshold: 0.7,
      enableVisualEvidence: false,
      localizationMode: true
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      sourcePath: "C:/private/source-1.flac",
      completePath: "C:/private/target-1.flac",
      sourceAudioStreamIndex: 0,
      completeAudioStreamIndex: 0,
      sourceVideoStreamIndex: null,
      completeVideoStreamIndex: null,
      enableVisualEvidence: false,
      localizationMode: true
    });
    expect(progress).toHaveBeenCalledTimes(2);
    const serialized = serializeSyntheticAlignmentRunReport(report);
    expect(serialized).not.toContain("C:/private");
    expect(serialized).not.toContain("native diagnostic");
    expect(parseSyntheticAlignmentRunReportJson(serialized)).toEqual(report);
    expect(createSyntheticAlignmentRunReportId(report)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("严格拒绝详细报告的未知字段、开发边界伪造和回执预测矛盾", async () => {
    const report = await runSyntheticAlignmentManifest(createManifest(1), {
      ...options({
        start: vi.fn(() => Promise.resolve(completedSnapshot("job-1", createProposal()))),
        get: vi.fn(),
        cancel: vi.fn()
      }),
      now: () => 1
    });
    const unknown = { ...report, unexpected: true };
    expect(() => parseSyntheticAlignmentRunReportJson(JSON.stringify(unknown))).toThrow(
      "未知字段"
    );
    expect(() =>
      parseSyntheticAlignmentRunReportJson(JSON.stringify({ ...report, releaseEligible: true }))
    ).toThrow("开发证据边界");
    expect(() =>
      parseSyntheticAlignmentRunReportJson(JSON.stringify({ ...report, predictions: [] }))
    ).toThrow("完成回执与 TimeMap 预测不一致");
  });

  it("收到取消信号后请求原生任务取消并停止后续 case", async () => {
    const manifest = createManifest(2);
    const controller = new AbortController();
    const invoker: AudioAlignmentJobInvoker = {
      start: vi.fn(() => Promise.resolve(runningSnapshot("job-cancel"))),
      get: vi.fn(),
      cancel: vi.fn((jobId: string) => Promise.resolve(cancelledSnapshot(jobId)))
    };
    const clock = createClock(() => controller.abort());

    const report = await runSyntheticAlignmentManifest(manifest, {
      ...options(invoker),
      signal: controller.signal,
      now: clock.now,
      wait: clock.wait
    });

    expect(report.status).toBe("cancelled");
    expect(report.caseReceipts).toHaveLength(1);
    expect(report.caseReceipts[0]).toMatchObject({
      state: "cancelled",
      failureCode: "cancelled"
    });
    expect(invoker.cancel).toHaveBeenCalledWith("job-cancel");
    expect(invoker.get).not.toHaveBeenCalled();
    expect(invoker.start).toHaveBeenCalledTimes(1);
  });
});

function createManifest(caseCount: number): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id: "synthetic-suite-test",
    name: "程序化测试集",
    datasetVersion: "synthetic-v1",
    description: "确定性变体，只用于开发回归。",
    isExample: false,
    licenseNotes: ["Authorized local fixture."],
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `synthetic-case-${index + 1}`,
      title: `变体 ${index + 1}`,
      mediaKind: "synthetic",
      split: "development",
      scenarios: ["codec-variant"],
      source: media(`C:/private/source-${index + 1}.flac`),
      target: media(`C:/private/target-${index + 1}.flac`),
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
    }))
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

function options(invoker: AudioAlignmentJobInvoker) {
  return {
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    spectralBackend: "cpu" as const,
    windowMs: 8_000,
    minGapMs: 1_000,
    matchThreshold: 0.7,
    pollIntervalMs: 10,
    invoker
  };
}

function createProposal(): AlignmentProposal {
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.9,
    diagnostics: ["native diagnostic must not be exported"],
    timeMap: {
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 0,
      targetEndMs: 10_000,
      spans: [
        createTestCompleteTimeMapSpan({
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        })
      ],
      quality: {
        level: "review",
        probability: null,
        metricSource: "measured",
        coverage: 1,
        uniqueContentCoverage: 1,
        p50ResidualMs: 10,
        p95ResidualMs: 20,
        p99ResidualMs: 25,
        maxResidualMs: 30,
        boundaryUncertaintyMs: 50,
        alternativeMargin: 0.5,
        anchorCount: 10,
        anchorRegionCount: 1,
        heldOutAnchorCount: 2,
        reasons: ["测试结果仍需复核。"]
      },
      evidence: {
        types: ["audio"],
        audioAnchorCount: 10,
        visualAnchorCount: 0,
        heldOutAnchorCount: 2,
        top1Top2Margin: 0.5,
        uniqueContentCoverage: 1,
        repeatedContentOnly: false,
        selectedTrackReason: "程序化测试固定单音轨。",
        alternativeTrackScores: [],
        notes: []
      },
      sourceStream: null,
      targetStream: null,
      sourceIdentity: null,
      targetIdentity: null,
      engineVersion: "alignment-v2-test",
      featureVersion: "spectral-test",
      parametersHash: "sha256:test"
    }
  };
}

function emptyInvoker(): AudioAlignmentJobInvoker {
  return {
    start: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn()
  };
}

function runningSnapshot(jobId: string): AudioAlignmentJobSnapshot {
  return snapshot(jobId, "running", null, null);
}

function completedSnapshot(
  jobId: string,
  proposal: AlignmentProposal
): AudioAlignmentJobSnapshot {
  return snapshot(jobId, "completed", proposal, null);
}

function failedSnapshot(jobId: string): AudioAlignmentJobSnapshot {
  return snapshot(jobId, "failed", null, "deliberate failure");
}

function cancelledSnapshot(jobId: string): AudioAlignmentJobSnapshot {
  return snapshot(jobId, "cancelled", null, null);
}

function snapshot(
  jobId: string,
  status: AudioAlignmentJobSnapshot["status"],
  proposal: AlignmentProposal | null,
  error: string | null
): AudioAlignmentJobSnapshot {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  return {
    jobId,
    status,
    progress: status === "running" ? 0.5 : 1,
    message: status,
    stageKey: terminal ? status : status === "queued" ? "queued" : "extracting-complete",
    stageLabel: terminal
      ? status === "completed"
        ? "已完成"
        : status === "failed"
          ? "失败"
          : "已取消"
      : status === "queued"
        ? "排队"
        : "提取完整版特征",
    stageIndex: terminal ? 9 : status === "queued" ? 0 : 2,
    stageCount: 9,
    stageProgress: terminal ? 1 : status === "queued" ? 0 : 0.5,
    logs: [],
    proposal,
    error,
    updatedAtMs: 1
  };
}

function createClock(onFirstWait?: () => void) {
  let milliseconds = 0;
  let waits = 0;
  return {
    now: () => milliseconds,
    wait: (durationMs: number) => {
      milliseconds += durationMs;
      waits += 1;
      if (waits === 1) onFirstWait?.();
      return Promise.resolve();
    }
  };
}
