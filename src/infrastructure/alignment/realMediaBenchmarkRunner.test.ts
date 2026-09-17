import { describe, expect, it, vi } from "vitest";
import type {
  RealMediaBenchmarkGold,
  RealMediaBenchmarkManifest,
  RealMediaBenchmarkMediaKind
} from "../../domain/alignment/realMediaBenchmark";
import type { AlignmentProposal } from "../../domain/alignment/types";
import type { MediaContentIdentity } from "../../domain/project/types";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import type { MediaTimelineProbeResult } from "../media/tauriMediaProbe";
import type {
  AudioAlignmentJobInvoker,
  AudioAlignmentJobSnapshot,
  NormalizedTauriAudioAlignmentRequest
} from "./tauriAudioAlignment";
import {
  createRealMediaBenchmarkBlindPreflightReceipt,
  createRealMediaBenchmarkRunManifestDigest,
  parseRealMediaBenchmarkRunReportJson,
  projectRealMediaBenchmarkRunManifest,
  runRealMediaBenchmarkBlindManifest,
  runRealMediaBenchmarkManifest,
  serializeRealMediaBenchmarkRunReport,
  validateRealMediaBenchmarkRunManifest,
  validateRealMediaBenchmarkRunReport,
  type RealMediaBenchmarkRunManifest
} from "./realMediaBenchmarkRunner";

describe("C137 manifest v2 生产 benchmark runner", () => {
  it("底层 runner 直接拒绝 raw frozen-test，不能绕过 React 门禁", async () => {
    const manifest = createManifest(1);
    if (!manifest.cases[0]) throw new Error("runner 冻结阻断测试缺少 case。");
    manifest.cases[0].split = "frozen-test";
    const bridge: AudioAlignmentJobInvoker = {
      start: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn()
    };

    await expect(
      runRealMediaBenchmarkManifest(manifest, { alignmentInvoker: bridge })
    ).rejects.toThrow("仅接受 development");
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("以 blind manifest 调生产 V2 job，显式绑定音视频流并输出可分享报告", async () => {
    const manifest = createManifest(1);
    const received: NormalizedTauriAudioAlignmentRequest[] = [];
    const bridge: AudioAlignmentJobInvoker = {
      start: (request) => {
        received.push(request);
        return Promise.resolve(runningSnapshot("job-1"));
      },
      get: () => Promise.resolve(completedSnapshot("job-1", createProposal(manifest, 0))),
      cancel: () => Promise.reject(new Error("不应取消"))
    };
    const clock = createClock();

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: createProbe(manifest) },
      enableVisualEvidence: true,
      pollIntervalMs: 25,
      now: clock.now,
      wait: clock.wait
    });

    expect(report.status).toBe("completed");
    expect(report.scope).toBe("time-map-component");
    expect(report.releaseEligible).toBe(false);
    expect(report.wallElapsedMs).toBe(25);
    expect(report.cases).toMatchObject([
      {
        caseId: "real-case-1",
        status: "success",
        wallElapsedMs: 25,
        engineVersion: "alignment-v2.0-rust",
        featureVersion: "pcm-v2-test",
        sourceVisualStreamIndex: 2,
        targetVisualStreamIndex: 3
      }
    ]);
    expect(report.evaluation?.overall.missingPredictionCount).toBe(0);
    expect(received[0]).toMatchObject({
      sourceAudioStreamIndex: 1,
      completeAudioStreamIndex: 4,
      sourceVideoStreamIndex: 2,
      completeVideoStreamIndex: 3,
      localizationMode: true,
      enableVisualEvidence: true
    });

    const runManifest = projectRealMediaBenchmarkRunManifest(manifest);
    expect(JSON.stringify(runManifest)).not.toMatch(
      /gold|reviewer|adjudication|split|scenario/i
    );
    expect(validateRealMediaBenchmarkRunManifest(runManifest)).toEqual({
      valid: true,
      issues: []
    });
    expect(validateRealMediaBenchmarkRunManifest({ ...runManifest, gold: {} }).valid).toBe(
      false
    );
    expect(report.runManifestDigest).toBe(
      createRealMediaBenchmarkRunManifestDigest(runManifest)
    );

    const serialized = serializeRealMediaBenchmarkRunReport(report);
    expect(serializeRealMediaBenchmarkRunReport(report)).toBe(serialized);
    expect(parseRealMediaBenchmarkRunReportJson(serialized)).toEqual(report);
    expect(validateRealMediaBenchmarkRunReport(report)).toEqual({ valid: true, issues: [] });
    const invalidDigest = structuredClone(report);
    invalidDigest.runManifestDigest = "fnv1a64:not-allowed";
    expect(validateRealMediaBenchmarkRunReport(invalidDigest).valid).toBe(false);
    const missingActualVisualStream = structuredClone(report);
    missingActualVisualStream.cases[0].sourceVisualStreamIndex = null;
    expect(validateRealMediaBenchmarkRunReport(missingActualVisualStream).valid).toBe(false);
    expect(serialized).not.toContain(manifest.cases[0].source.path);
    expect(serialized).not.toContain(manifest.cases[0].source.contentIdentity?.digest);
    expect(serialized).not.toContain("diagnostics");
  });

  it("blind manifest SHA-256 对对象字段顺序稳定，对执行输入篡改敏感", () => {
    const projected = projectRealMediaBenchmarkRunManifest(createManifest(1));
    const originalDigest = createRealMediaBenchmarkRunManifestDigest(projected);
    const firstCase = projected.cases[0];
    const reordered = {
      cases: [
        {
          target: {
            licenseNote: firstCase.target.licenseNote,
            contentIdentity: firstCase.target.contentIdentity,
            videoStreamIndex: firstCase.target.videoStreamIndex,
            versionNote: firstCase.target.versionNote,
            audioStreamIndex: firstCase.target.audioStreamIndex,
            path: firstCase.target.path
          },
          caseId: firstCase.caseId,
          source: {
            versionNote: firstCase.source.versionNote,
            path: firstCase.source.path,
            licenseNote: firstCase.source.licenseNote,
            videoStreamIndex: firstCase.source.videoStreamIndex,
            audioStreamIndex: firstCase.source.audioStreamIndex,
            contentIdentity: firstCase.source.contentIdentity
          }
        }
      ],
      datasetVersion: projected.datasetVersion,
      manifestId: projected.manifestId,
      schemaVersion: 1
    } satisfies RealMediaBenchmarkRunManifest;
    const tampered = structuredClone(projected);
    tampered.cases[0].source.path += ".replaced";

    expect(originalDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(createRealMediaBenchmarkRunManifestDigest(reordered)).toBe(originalDigest);
    expect(createRealMediaBenchmarkRunManifestDigest(tampered)).not.toBe(originalDigest);
  });

  it.each(["cuda", "cpu"] as const)(
    "把 %s 策略完整传到生产请求并写入可审计参数摘要",
    async (spectralBackend) => {
      const manifest = createManifest(1);
      const received: NormalizedTauriAudioAlignmentRequest[] = [];
      const bridge: AudioAlignmentJobInvoker = {
        start: (request) => {
          received.push(request);
          return Promise.resolve(completedSnapshot("job-policy", createProposal(manifest, 0)));
        },
        get: () => Promise.reject(new Error("不应读取")),
        cancel: () => Promise.reject(new Error("不应取消"))
      };

      const report = await runRealMediaBenchmarkManifest(manifest, {
        spectralBackend,
        alignmentInvoker: bridge,
        preflightOptions: { probe: createProbe(manifest) }
      });

      expect(received).toHaveLength(1);
      expect(received[0].spectralBackend).toBe(spectralBackend);
      expect(report.cases[0].parameters.spectralBackend).toBe(spectralBackend);
      expect(validateRealMediaBenchmarkRunReport(report).valid).toBe(true);
    }
  );

  it("显式未知声谱策略会在启动任何生产任务前拒绝", async () => {
    const manifest = createManifest(1);
    const start = vi.fn();
    const invalidBackend = "metal" as unknown as "auto";

    await expect(
      runRealMediaBenchmarkManifest(manifest, {
        spectralBackend: invalidBackend,
        alignmentInvoker: {
          start,
          get: vi.fn(),
          cancel: vi.fn()
        },
        preflightOptions: { probe: createProbe(manifest) }
      })
    ).rejects.toThrow("声谱计算策略仅支持 auto、cuda 或 cpu");
    expect(start).not.toHaveBeenCalled();
  });

  it("case 启动失败会隔离到该关系，后续 case 继续，但不会计算部分质量", async () => {
    const manifest = createManifest(2);
    const start = vi.fn((request: NormalizedTauriAudioAlignmentRequest) => {
      if (request.sourcePath.includes("case-1")) {
        const identity = manifest.cases[0].source.contentIdentity?.digest;
        return Promise.reject(new Error(`读取失败 ${request.sourcePath} ${identity}`));
      }
      return Promise.resolve(runningSnapshot("job-2"));
    });
    const bridge: AudioAlignmentJobInvoker = {
      start,
      get: () => Promise.resolve(completedSnapshot("job-2", createProposal(manifest, 1))),
      cancel: () => Promise.reject(new Error("不应取消"))
    };
    const clock = createClock();

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: createProbe(manifest) },
      now: clock.now,
      wait: clock.wait,
      pollIntervalMs: 10
    });

    expect(start).toHaveBeenCalledTimes(2);
    expect(report.status).toBe("completed-with-errors");
    expect(report.cases.map((item) => item.status)).toEqual(["failed", "success"]);
    expect(report.cases[0].failure?.code).toBe("job-start-failed");
    expect(report.evaluation).toBeNull();
    const serialized = serializeRealMediaBenchmarkRunReport(report);
    expect(serialized).not.toContain(manifest.cases[0].source.path);
    expect(serialized).not.toContain(manifest.cases[0].source.contentIdentity?.digest);
  });

  it.each([
    ["blocked:cuda-fft-unavailable", "CUDA/cuFFT 能力不可用", "检测 4090 / CUDA"],
    ["blocked:cuda-fft-runtime", "CUDA/cuFFT 执行失败", "强制 CPU"]
  ] as const)(
    "精度任务启动失败时只披露已知安全码 %s 的固定建议",
    async (nativeCode, expectedReason, expectedRemediation) => {
      const manifest = createManifest(1);
      const privateDetail = `${manifest.cases[0].source.path} driver stdout=SECRET`;
      const report = await runRealMediaBenchmarkManifest(manifest, {
        spectralBackend: "cuda",
        alignmentInvoker: {
          start: () => Promise.reject(new Error(`${nativeCode}：${privateDetail}`)),
          get: vi.fn(),
          cancel: vi.fn()
        },
        preflightOptions: { probe: createProbe(manifest) }
      });

      expect(report.cases[0].failure?.code).toBe("job-start-failed");
      expect(report.cases[0].failure?.message).toContain(expectedReason);
      expect(report.cases[0].failure?.message).toContain(expectedRemediation);
      const serialized = serializeRealMediaBenchmarkRunReport(report);
      expect(serialized).not.toContain(privateDetail);
      expect(serialized).not.toContain("SECRET");
      expect(serialized).not.toContain(manifest.cases[0].source.path);
    }
  );

  it("精度任务对未知伪 CUDA 码保持通用脱敏，不复述原始输出", async () => {
    const manifest = createManifest(1);
    const report = await runRealMediaBenchmarkManifest(manifest, {
      spectralBackend: "cuda",
      alignmentInvoker: {
        start: () =>
          Promise.reject(
            new Error("blocked:cuda-fft-private-extension：C:\\private\\driver.log SECRET")
          ),
        get: vi.fn(),
        cancel: vi.fn()
      },
      preflightOptions: { probe: createProbe(manifest) }
    });

    expect(report.cases[0].failure?.message).toBe(
      "生产 Alignment V2 任务启动失败；原始工具错误已从可分享报告移除。"
    );
    expect(serializeRealMediaBenchmarkRunReport(report)).not.toContain("SECRET");
  });

  it("视觉启用时拒绝只回报音轨、未证明实际视频流的 proposal", async () => {
    const manifest = createManifest(1);
    const proposal = createProposal(manifest, 0);
    if (!proposal.timeMap) throw new Error("测试 proposal 缺少 TimeMap");
    proposal.timeMap.sourceVisualStream = null;
    const bridge: AudioAlignmentJobInvoker = {
      start: () => Promise.resolve(completedSnapshot("job-1", proposal)),
      get: () => Promise.reject(new Error("不应读取")),
      cancel: () => Promise.reject(new Error("不应取消"))
    };

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: createProbe(manifest) },
      enableVisualEvidence: true
    });

    expect(report.status).toBe("completed-with-errors");
    expect(report.cases[0].failure?.code).toBe("stream-mismatch");
    expect(report.evaluation).toBeNull();
  });

  it("AbortSignal 会取消活动 job、等待真实终态，并把未启动 case 标为 cancelled", async () => {
    const manifest = createManifest(2);
    const controller = new AbortController();
    const events: string[] = [];
    let getCount = 0;
    const bridge: AudioAlignmentJobInvoker = {
      start: () => {
        events.push("start");
        return Promise.resolve(runningSnapshot("job-1"));
      },
      get: () => {
        getCount += 1;
        events.push(`get-${getCount}`);
        return Promise.resolve(
          getCount === 1 ? runningSnapshot("job-1") : cancelledSnapshot("job-1")
        );
      },
      cancel: () => {
        events.push("cancel");
        return Promise.resolve(runningSnapshot("job-1"));
      }
    };
    const clock = createClock(() => controller.abort());

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: createProbe(manifest) },
      signal: controller.signal,
      now: clock.now,
      wait: clock.wait,
      pollIntervalMs: 10
    });

    expect(events).toEqual(["start", "get-1", "cancel", "get-2"]);
    expect(report.status).toBe("cancelled");
    expect(report.cases.map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
    expect(report.evaluation).toBeNull();
  });

  it("job timeout 先等待取消终态再启动下一 case", async () => {
    const manifest = createManifest(2);
    const events: string[] = [];
    let activeCase = 0;
    let cancelling = false;
    const bridge: AudioAlignmentJobInvoker = {
      start: () => {
        activeCase += 1;
        events.push(`start-${activeCase}`);
        return Promise.resolve(runningSnapshot(`job-${activeCase}`));
      },
      get: (jobId) => {
        if (activeCase === 1 && cancelling) {
          events.push("get-cancelled-1");
          return Promise.resolve(cancelledSnapshot(jobId));
        }
        events.push(`get-${activeCase}`);
        return Promise.resolve(
          activeCase === 1
            ? runningSnapshot(jobId)
            : completedSnapshot(jobId, createProposal(manifest, 1))
        );
      },
      cancel: (jobId) => {
        cancelling = true;
        events.push("cancel-1");
        return Promise.resolve(runningSnapshot(jobId));
      }
    };
    const clock = createClock();

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: createProbe(manifest) },
      now: clock.now,
      wait: clock.wait,
      pollIntervalMs: 10,
      maxJobWallMs: 10,
      cancellationGraceMs: 20
    });

    expect(events).toEqual([
      "start-1",
      "get-1",
      "cancel-1",
      "get-cancelled-1",
      "start-2",
      "get-2"
    ]);
    expect(report.cases[0]).toMatchObject({
      status: "failed",
      failure: { code: "job-timeout" }
    });
    expect(report.cases[1].status).toBe("success");
    expect(report.evaluation).toBeNull();
  });

  it("取消宽限期内未到终态会停止后续 case，避免后台任务重叠", async () => {
    const manifest = createManifest(2);
    const start = vi.fn(() => Promise.resolve(runningSnapshot("job-1")));
    const bridge: AudioAlignmentJobInvoker = {
      start,
      get: () => Promise.resolve(runningSnapshot("job-1")),
      cancel: () => Promise.resolve(runningSnapshot("job-1"))
    };
    const clock = createClock();

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: createProbe(manifest) },
      now: clock.now,
      wait: clock.wait,
      pollIntervalMs: 10,
      maxJobWallMs: 10,
      cancellationGraceMs: 10
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(report.cases[0]).toMatchObject({
      status: "failed",
      failure: { code: "cancellation-timeout" }
    });
    expect(report.cases[1]).toMatchObject({
      status: "cancelled",
      failure: { code: "run-cancelled" }
    });
    expect(report.evaluation).toBeNull();
  });

  it("0 real 明确返回 insufficient-data，不调用生产分析", async () => {
    const manifest = createManifest(1, "placeholder");
    const bridge: AudioAlignmentJobInvoker = {
      start: vi.fn(() => Promise.reject(new Error("不应启动"))),
      get: vi.fn(() => Promise.reject(new Error("不应读取"))),
      cancel: vi.fn(() => Promise.reject(new Error("不应取消")))
    };

    const report = await runRealMediaBenchmarkManifest(manifest, {
      alignmentInvoker: bridge,
      preflightOptions: { probe: vi.fn() }
    });

    expect(report.status).toBe("insufficient-data");
    expect(report.cases).toEqual([]);
    expect(report.evaluation).toBeNull();
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it("可在独立进程只传 blind manifest 与 preflight receipt", async () => {
    const manifest = createManifest(1);
    const blind = projectRealMediaBenchmarkRunManifest(manifest);
    const preflight = {
      ok: true,
      realRelationCount: 1,
      checkedFileCount: 2,
      issues: []
    };
    const bridge: AudioAlignmentJobInvoker = {
      start: () => Promise.resolve(completedSnapshot("job-1", createProposal(manifest, 0))),
      get: () => Promise.reject(new Error("不应读取")),
      cancel: () => Promise.reject(new Error("不应取消"))
    };

    const receipt = await runRealMediaBenchmarkBlindManifest(
      blind,
      createRealMediaBenchmarkBlindPreflightReceipt(blind, preflight),
      { alignmentInvoker: bridge }
    );

    expect(receipt.cases[0].status).toBe("success");
    expect(receipt.runManifestDigest).toBe(createRealMediaBenchmarkRunManifestDigest(blind));
    expect(JSON.stringify(receipt)).not.toContain(manifest.cases[0].gold.matchedAnchors[0].id);
  });
});

function createManifest(
  count: number,
  mediaKind: RealMediaBenchmarkMediaKind = "real"
): RealMediaBenchmarkManifest {
  const cases = Array.from({ length: count }, (_, index) => {
    const gold = createGold();
    const real = mediaKind === "real";
    return {
      id: `${mediaKind}-case-${index + 1}`,
      title: `关系 ${index + 1}`,
      mediaKind,
      split: "development" as const,
      scenarios: ["global-offset" as const],
      source: createMedia(`case-${index + 1}-source`, index % 10, 1, 2, real),
      target: createMedia(`case-${index + 1}-target`, (index + 5) % 10, 4, 3, real),
      boundaryToleranceMs: 100,
      versionNotes: ["固定版本。"],
      licenseNotes: ["仅用于合法本地测试。"],
      independentAnnotations: real
        ? [
            { reviewerId: `reviewer-a-${index}`, gold: structuredClone(gold) },
            { reviewerId: `reviewer-b-${index}`, gold: structuredClone(gold) }
          ]
        : [],
      adjudication: real
        ? {
            status: "not-needed" as const,
            adjudicatorId: null,
            note: "两份标注一致。"
          }
        : null,
      gold
    };
  });
  return {
    schemaVersion: 2,
    id: "runner-manifest-v2",
    name: "Runner 测试清单",
    datasetVersion: "frozen-1",
    description: "验证真实 runner 调度，不代表真实精度。",
    isExample: mediaKind !== "real",
    licenseNotes: ["测试清单。"],
    cases
  };
}

function createGold(): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 0,
    targetEndMs: 10_000,
    matchedAnchors: Array.from({ length: 5 }, (_, index) => ({
      id: `gold-anchor-${index + 1}`,
      sourceMs: index * 2_000,
      targetMs: index * 2_000
    })),
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function createMedia(
  name: string,
  digitSeed: number,
  audioStreamIndex: number,
  videoStreamIndex: number,
  real: boolean
) {
  const digit = digitSeed.toString(16);
  return {
    path: `C:\\private-benchmark\\${name}.mkv`,
    audioStreamIndex,
    videoStreamIndex,
    contentIdentity: real
      ? {
          algorithm: "sha256-full-file-v2" as const,
          sizeBytes: 1_000 + digitSeed,
          digest: digit.repeat(64)
        }
      : null,
    versionNote: "固定媒体版本。",
    licenseNote: "合法本地测试素材。"
  };
}

function createProbe(manifest: RealMediaBenchmarkManifest) {
  const mediaByPath = new Map(
    manifest.cases.flatMap((benchmarkCase) => [
      [benchmarkCase.source.path, benchmarkCase.source] as const,
      [benchmarkCase.target.path, benchmarkCase.target] as const
    ])
  );
  return vi.fn(({ path }: { path: string }) => {
    const media = mediaByPath.get(path);
    if (!media?.contentIdentity) throw new Error("测试媒体不存在");
    return Promise.resolve(
      createProbeResult(
        media.contentIdentity.digest,
        media.contentIdentity.sizeBytes,
        media.audioStreamIndex,
        media.videoStreamIndex ?? 0
      )
    );
  });
}

function createProbeResult(
  digest: string,
  sizeBytes: number,
  audioStreamIndex: number,
  videoStreamIndex: number
): MediaTimelineProbeResult {
  return {
    presentationOriginMs: 0,
    durationMs: 10_000,
    contentIdentity: createContentIdentity(digest, sizeBytes),
    videoStreams: [
      {
        index: videoStreamIndex,
        codec: "h264",
        startMs: 0,
        timelineOffsetMs: 0,
        durationMs: 10_000,
        timeBase: "1/90000",
        language: null,
        title: null,
        default: true,
        commentary: false,
        frameRate: 24
      }
    ],
    audioStreams: [
      {
        index: audioStreamIndex,
        codec: "aac",
        startMs: 0,
        timelineOffsetMs: 0,
        durationMs: 10_000,
        timeBase: "1/48000",
        language: "ja",
        title: null,
        default: true,
        commentary: false,
        sampleRate: 48_000,
        channels: 2
      }
    ],
    preferredAudioStreamIndex: audioStreamIndex
  };
}

function createProposal(
  manifest: RealMediaBenchmarkManifest,
  index: number
): AlignmentProposal {
  const benchmarkCase = manifest.cases[index];
  const sourceIdentity = benchmarkCase.source.contentIdentity;
  const targetIdentity = benchmarkCase.target.contentIdentity;
  if (!sourceIdentity || !targetIdentity) throw new Error("测试 proposal 需要真实身份");
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.9,
    diagnostics: [`不得进入报告：${benchmarkCase.source.path}`],
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
        types: ["audio", "visual"],
        audioAnchorCount: 10,
        visualAnchorCount: 5,
        heldOutAnchorCount: 2,
        top1Top2Margin: 0.5,
        uniqueContentCoverage: 1,
        repeatedContentOnly: false,
        selectedTrackReason: "测试显式音视频流。",
        alternativeTrackScores: [],
        notes: []
      },
      sourceStream: stream("audio", benchmarkCase.source.audioStreamIndex),
      targetStream: stream("audio", benchmarkCase.target.audioStreamIndex),
      sourceVisualStream: stream("video", benchmarkCase.source.videoStreamIndex ?? 0),
      targetVisualStream: stream("video", benchmarkCase.target.videoStreamIndex ?? 0),
      sourceIdentity: createContentIdentity(sourceIdentity.digest, sourceIdentity.sizeBytes),
      targetIdentity: createContentIdentity(targetIdentity.digest, targetIdentity.sizeBytes),
      engineVersion: "alignment-v2.0-rust",
      featureVersion: "pcm-v2-test",
      parametersHash: "fnv1a64:internal-only"
    }
  };
}

function stream(type: "audio" | "video", index: number) {
  return {
    type,
    index,
    codec: type === "audio" ? "aac" : "h264",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: type === "audio" ? "1/48000" : "1/90000",
    sampleRate: type === "audio" ? 48_000 : null,
    channels: type === "audio" ? 2 : null,
    frameRate: type === "video" ? 24 : null,
    language: null,
    title: null
  } as const;
}

function createContentIdentity(digest: string, sizeBytes: number): MediaContentIdentity {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes,
    modifiedUnixMs: 1,
    firstSampleDigest: digest,
    middleSampleDigest: digest,
    lastSampleDigest: digest
  };
}

function runningSnapshot(jobId: string): AudioAlignmentJobSnapshot {
  return {
    jobId,
    status: "running",
    progress: 0.5,
    message: "运行中",
    stageKey: "extracting-complete",
    stageLabel: "提取完整版特征",
    stageIndex: 2,
    stageCount: 9,
    stageProgress: 0.5,
    logs: [],
    proposal: null,
    error: null,
    updatedAtMs: 1
  };
}

function completedSnapshot(
  jobId: string,
  proposal: AlignmentProposal
): AudioAlignmentJobSnapshot {
  return {
    jobId,
    status: "completed",
    progress: 1,
    message: "完成",
    stageKey: "completed",
    stageLabel: "已完成",
    stageIndex: 9,
    stageCount: 9,
    stageProgress: 1,
    logs: [],
    proposal,
    error: null,
    updatedAtMs: 2
  };
}

function cancelledSnapshot(jobId: string): AudioAlignmentJobSnapshot {
  return {
    jobId,
    status: "cancelled",
    progress: 1,
    message: "已取消",
    stageKey: "cancelled",
    stageLabel: "已取消",
    stageIndex: 9,
    stageCount: 9,
    stageProgress: 1,
    logs: [],
    proposal: null,
    error: null,
    updatedAtMs: 2
  };
}

function createClock(onFirstWait?: () => void) {
  let milliseconds = 0;
  let waitCount = 0;
  return {
    now: () => milliseconds,
    wait: (durationMs: number) => {
      milliseconds += durationMs;
      waitCount += 1;
      if (waitCount === 1) onFirstWait?.();
      return Promise.resolve();
    }
  };
}
