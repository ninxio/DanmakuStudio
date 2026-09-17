import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlignmentProposal, AlignmentTimeMapProposal } from "../../domain/alignment/types";
import {
  parseMultimodalBlindReviewPackJson,
  sha256Json
} from "../../domain/alignment/multimodalBlindReview";
import { createRealAlignmentBlindReviewPackFixture } from "../../test/multimodalBlindReviewFixture";
import {
  createTestFineExecutionEvidence,
  createTestFineFrontierReceipt
} from "../../test/audioAlignmentBatchEvidenceV3";
import {
  cancelTauriAudioAlignmentBatchJob,
  cancelTauriAudioAlignmentJob,
  buildAudioAlignmentSensitiveBlindReviewPack,
  createAudioAlignmentBatchFineExecutionEvidenceDigest,
  createAudioAlignmentBatchFineFrontierReceiptDigest,
  createAudioAlignmentBatchFineInventoryDigest,
  createAudioAlignmentBatchProposalTimeMapDigest,
  getTauriAudioAlignmentBatchJob,
  getTauriAudioAlignmentJob,
  isAudioAlignmentJobFinished,
  listAudioAlignmentSensitiveManifestSummaries,
  openAudioAlignmentDiagnosticLogDirectory,
  openAudioAlignmentSensitiveManifestDirectory,
  runTauriAudioAlignment,
  startTauriAudioAlignmentBatchJob,
  startTauriAudioAlignmentJob,
  type AudioAlignmentBatchJobInvoker,
  type AudioAlignmentBatchJobSnapshot,
  type AudioAlignmentInvoker,
  type AudioAlignmentJobInvoker,
  type AudioAlignmentJobSnapshot,
  type AlignmentSensitiveManifestSummary,
  type BuildAlignmentSensitiveBlindReviewPackRequest,
  type NormalizedTauriAudioAlignmentRequest,
  type TauriAudioAlignmentRequest
} from "./tauriAudioAlignment";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

const emptyProposal: AlignmentProposal = {
  anchors: [],
  cutCandidates: [],
  confidence: 0,
  diagnostics: []
};
const queuedJobContract = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "src",
      "infrastructure",
      "alignment",
      "audioAlignmentJobSnapshot.contract.json"
    ),
    "utf8"
  )
) as AudioAlignmentJobSnapshot;

function jobInvokerReturning(value: unknown): AudioAlignmentJobInvoker {
  const snapshot = value as AudioAlignmentJobSnapshot;
  return {
    start: () => Promise.resolve(snapshot),
    get: () => Promise.resolve(snapshot),
    cancel: () => Promise.resolve(snapshot)
  };
}

const testExecutionIdentity = {
  schemaVersion: 1 as const,
  engineVersion: "alignment-v2.2-rust",
  featureVersion: "test-feature-v1",
  relationScoreVersion: "alignment-v2-pair-intrinsic-global-weight-v1" as const,
  nativeExecutableDigest: `sha256:${"a".repeat(64)}` as const,
  ffmpegBinaryDigest: `sha256:${"b".repeat(64)}` as const,
  ffprobeBinaryDigest: `sha256:${"c".repeat(64)}` as const,
  sourceSpectralBackends: [
    {
      backendId: "cpu-radix2-f64-r2c-512-v1",
      requestedBackend: "cpu",
      backendDetail: "test CPU",
      fallbackReason: null
    }
  ],
  targetSpectralBackends: [
    {
      backendId: "cpu-radix2-f64-r2c-512-v1",
      requestedBackend: "cpu",
      backendDetail: "test CPU",
      fallbackReason: null
    }
  ]
};

describe("Tauri 音频对齐调用", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("把请求交给注入的 invoker 并返回 proposal", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "cut.mp4",
      ffmpegPath: null,
      localizationMode: true
    };
    const proposal = await runTauriAudioAlignment(request, (received) =>
      Promise.resolve({
        anchors: [
          { id: "a", sourceMs: 1000, targetMs: 2000, origin: "automatic", confidence: 0.9 }
        ],
        cutCandidates: [],
        confidence: received.completePath === "full.mp4" ? 1 : 0,
        diagnostics: [],
        matchRange: received.localizationMode
          ? {
              sourceStartMs: 500_000,
              sourceEndMs: 620_000,
              targetStartMs: 0,
              targetEndMs: 120_000,
              coverage: 1
            }
          : undefined
      })
    );

    expect(proposal.anchors).toHaveLength(1);
    expect(proposal.confidence).toBe(1);
    expect(proposal.matchRange).toEqual({
      sourceStartMs: 500_000,
      sourceEndMs: 620_000,
      targetStartMs: 0,
      targetEndMs: 120_000,
      coverage: 1
    });
  });

  it("以 camelCase 把 FFprobe 与显式音视频流索引传给 Rust", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "D:\\media\\full.mkv",
      sourcePath: "D:\\media\\reference.mkv",
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      ffprobePath: "C:\\tools\\ffprobe.exe",
      completeAudioStreamIndex: 2,
      sourceAudioStreamIndex: 4,
      completeVideoStreamIndex: 6,
      sourceVideoStreamIndex: 8,
      spectralBackend: "cuda",
      localizationMode: true
    };
    tauriMocks.invoke.mockResolvedValue(emptyProposal);

    await expect(runTauriAudioAlignment(request)).resolves.toBe(emptyProposal);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("align_audio_files", {
      request: {
        completePath: "D:\\media\\full.mkv",
        sourcePath: "D:\\media\\reference.mkv",
        ffmpegPath: "C:\\tools\\ffmpeg.exe",
        ffprobePath: "C:\\tools\\ffprobe.exe",
        completeAudioStreamIndex: 2,
        sourceAudioStreamIndex: 4,
        completeVideoStreamIndex: 6,
        sourceVideoStreamIndex: 8,
        spectralBackend: "cuda",
        localizationMode: true
      }
    });
  });

  it("省略音轨设置时规范为 null 并保持自动选轨", async () => {
    const received: NormalizedTauriAudioAlignmentRequest[] = [];
    const invoker: AudioAlignmentInvoker = (request) => {
      received.push(request);
      return Promise.resolve(emptyProposal);
    };

    await runTauriAudioAlignment(
      {
        completePath: "full.mp4",
        sourcePath: "reference.mp4",
        ffmpegPath: null
      },
      invoker
    );

    expect(received).toMatchObject([
      {
        ffprobePath: null,
        completeAudioStreamIndex: null,
        sourceAudioStreamIndex: null,
        completeVideoStreamIndex: null,
        sourceVideoStreamIndex: null,
        spectralBackend: "auto"
      }
    ]);
  });

  it("后台任务默认调用同样发送 camelCase 的自动选轨 null", async () => {
    tauriMocks.invoke.mockResolvedValue({
      jobId: "job-auto-track",
      status: "queued",
      progress: 0,
      message: "已排队",
      stageKey: "queued",
      stageLabel: "排队",
      stageIndex: 0,
      stageCount: 9,
      stageProgress: 0,
      logs: [],
      proposal: null,
      error: null,
      updatedAtMs: 1
    });

    await startTauriAudioAlignmentJob({
      completePath: "full.mp4",
      sourcePath: "reference.mp4",
      ffmpegPath: null
    });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_audio_alignment_job", {
      request: {
        completePath: "full.mp4",
        sourcePath: "reference.mp4",
        ffmpegPath: null,
        ffprobePath: null,
        completeAudioStreamIndex: null,
        sourceAudioStreamIndex: null,
        completeVideoStreamIndex: null,
        sourceVideoStreamIndex: null,
        spectralBackend: "auto"
      }
    });
  });

  it("拒绝单次和批量请求中的未知声谱计算策略", async () => {
    const invalidPreference =
      "metal" as unknown as TauriAudioAlignmentRequest["spectralBackend"];

    await expect(
      runTauriAudioAlignment({
        completePath: "full.mp4",
        sourcePath: "reference.mp4",
        ffmpegPath: null,
        spectralBackend: invalidPreference
      })
    ).rejects.toThrow("声谱计算策略仅支持 auto、cuda 或 cpu");
    await expect(
      startTauriAudioAlignmentBatchJob({
        sources: [{ mediaId: "source", path: "source.mp4" }],
        targets: [{ mediaId: "target", path: "target.mp4" }],
        ffmpegPath: null,
        spectralBackend: invalidPreference,
        localizationMode: true
      })
    ).rejects.toThrow("声谱计算策略仅支持 auto、cuda 或 cpu");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "拒绝非法音轨索引 %s，且不会调用 Rust",
    async (invalidIndex) => {
      const invoker = vi.fn<AudioAlignmentInvoker>(() => Promise.resolve(emptyProposal));

      await expect(
        runTauriAudioAlignment(
          {
            completePath: "full.mp4",
            sourcePath: "reference.mp4",
            ffmpegPath: null,
            completeAudioStreamIndex: invalidIndex
          },
          invoker
        )
      ).rejects.toThrow("原片音轨索引必须是非负安全整数或 null。");
      expect(invoker).not.toHaveBeenCalled();
    }
  );

  it("分别校验参考视频音轨索引", async () => {
    const invoker = vi.fn<AudioAlignmentInvoker>(() => Promise.resolve(emptyProposal));

    await expect(
      runTauriAudioAlignment(
        {
          completePath: "full.mp4",
          sourcePath: "reference.mp4",
          ffmpegPath: null,
          sourceAudioStreamIndex: -1
        },
        invoker
      )
    ).rejects.toThrow("参考视频音轨索引必须是非负安全整数或 null。");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("分别校验原片与参考视频流索引", async () => {
    const invoker = vi.fn<AudioAlignmentInvoker>(() => Promise.resolve(emptyProposal));

    await expect(
      runTauriAudioAlignment(
        {
          completePath: "full.mp4",
          sourcePath: "reference.mp4",
          ffmpegPath: null,
          completeVideoStreamIndex: -1
        },
        invoker
      )
    ).rejects.toThrow("原片视频流索引必须是非负安全整数或 null。");
    await expect(
      runTauriAudioAlignment(
        {
          completePath: "full.mp4",
          sourcePath: "reference.mp4",
          ffmpegPath: null,
          sourceVideoStreamIndex: 1.5
        },
        invoker
      )
    ).rejects.toThrow("参考视频流索引必须是非负安全整数或 null。");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("为同步分析和后台任务失败补充调用上下文", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "reference.mp4",
      ffmpegPath: null
    };
    const alignmentInvoker: AudioAlignmentInvoker = () =>
      Promise.reject(new Error("FFmpeg 无法解码"));
    const jobInvoker: AudioAlignmentJobInvoker = {
      start: () => Promise.reject(new Error("FFprobe 不可用")),
      get: () => Promise.reject(new Error("不应调用")),
      cancel: () => Promise.reject(new Error("不应调用"))
    };

    await expect(runTauriAudioAlignment(request, alignmentInvoker)).rejects.toThrow(
      "本地音频对齐失败：FFmpeg 无法解码"
    );
    await expect(startTauriAudioAlignmentJob(request, jobInvoker)).rejects.toThrow(
      "音频对齐任务启动失败：FFprobe 不可用"
    );
  });

  it("支持启动、查询和取消后台任务", async () => {
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "cut.mp4",
      ffmpegPath: null
    };
    const invoker: AudioAlignmentJobInvoker = {
      start: (received) =>
        Promise.resolve({
          jobId: received.completePath === "full.mp4" ? "job-1" : "job-x",
          status: "running",
          progress: 0.25,
          message: "正在提取完整版音频特征。",
          stageKey: "extracting-complete",
          stageLabel: "提取完整版特征",
          stageIndex: 2,
          stageCount: 9,
          stageProgress: 0.5,
          logs: ["音频对齐任务已加入队列。", "正在提取完整版音频特征。"],
          proposal: null,
          error: null,
          updatedAtMs: 1
        }),
      get: (jobId) =>
        Promise.resolve({
          jobId,
          status: "completed",
          progress: 1,
          message: "本地音频对齐完成。",
          stageKey: "completed",
          stageLabel: "已完成",
          stageIndex: 9,
          stageCount: 9,
          stageProgress: 1,
          logs: ["本地音频对齐完成。"],
          proposal: {
            anchors: [],
            cutCandidates: [],
            confidence: 1,
            diagnostics: []
          },
          error: null,
          updatedAtMs: 2
        }),
      cancel: (jobId) =>
        Promise.resolve({
          jobId,
          status: "cancelled",
          progress: 1,
          message: "已请求取消音频对齐任务。",
          stageKey: "cancelled",
          stageLabel: "已取消",
          stageIndex: 9,
          stageCount: 9,
          stageProgress: 1,
          logs: ["已请求取消音频对齐任务。"],
          proposal: null,
          error: null,
          updatedAtMs: 3
        })
    };

    await expect(startTauriAudioAlignmentJob(request, invoker)).resolves.toMatchObject({
      jobId: "job-1",
      status: "running",
      logs: ["音频对齐任务已加入队列。", "正在提取完整版音频特征。"]
    });
    await expect(getTauriAudioAlignmentJob("job-1", invoker)).resolves.toMatchObject({
      status: "completed",
      progress: 1
    });
    await expect(cancelTauriAudioAlignmentJob("job-1", invoker)).resolves.toMatchObject({
      status: "cancelled"
    });
    expect(isAudioAlignmentJobFinished("completed")).toBe(true);
    expect(isAudioAlignmentJobFinished("running")).toBe(false);
  });

  it("用固定 JSON 样本锁定单任务跨层合同并拒绝未知字段", async () => {
    const invoker = jobInvokerReturning(queuedJobContract);
    const request: TauriAudioAlignmentRequest = {
      completePath: "full.mp4",
      sourcePath: "cut.mp4",
      ffmpegPath: null
    };

    await expect(startTauriAudioAlignmentJob(request, invoker)).resolves.toEqual(
      queuedJobContract
    );
    await expect(
      getTauriAudioAlignmentJob(queuedJobContract.jobId, invoker)
    ).resolves.toEqual(queuedJobContract);
    await expect(
      cancelTauriAudioAlignmentJob(queuedJobContract.jobId, invoker)
    ).resolves.toEqual(queuedJobContract);

    const driftedInvoker = jobInvokerReturning({
      ...queuedJobContract,
      internalDebug: true
    });
    await expect(
      getTauriAudioAlignmentJob(queuedJobContract.jobId, driftedInvoker)
    ).rejects.toThrow("原生单任务响应 缺少必需字段或包含未知字段");
  });

  it("拒绝缺少任一必填 stage 字段的原生单任务响应", async () => {
    const missingStageProgress = Object.fromEntries(
      Object.entries(queuedJobContract).filter(([key]) => key !== "stageProgress")
    );

    await expect(
      getTauriAudioAlignmentJob(
        queuedJobContract.jobId,
        jobInvokerReturning(missingStageProgress)
      )
    ).rejects.toThrow("原生单任务响应 缺少必需字段或包含未知字段");
  });

  it("用单一阶段映射拒绝 running 的 key、index 或 label 漂移", async () => {
    const running = {
      ...queuedJobContract,
      status: "running",
      progress: 0.05,
      stageKey: "validating",
      stageLabel: "校验输入",
      stageIndex: 1,
      stageProgress: 0.5,
      message: "正在校验输入。"
    };
    const malformedStages = [
      { ...running, stageKey: "completed" },
      { ...running, stageIndex: 2 },
      { ...running, stageLabel: "准备校验" }
    ];

    for (const malformed of malformedStages) {
      await expect(
        getTauriAudioAlignmentJob(
          queuedJobContract.jobId,
          jobInvokerReturning(malformed)
        )
      ).rejects.toThrow("状态与阶段 key/index/label 不一致");
    }
  });

  it("拒绝 completed 状态携带空对象 proposal", async () => {
    const malformed = {
      ...queuedJobContract,
      status: "completed",
      progress: 1,
      message: "本地音频对齐完成。",
      stageKey: "completed",
      stageLabel: "已完成",
      stageIndex: 9,
      stageProgress: 1,
      proposal: {}
    };

    await expect(
      getTauriAudioAlignmentJob(
        queuedJobContract.jobId,
        jobInvokerReturning(malformed)
      )
    ).rejects.toThrow("已完成单任务必须包含 proposal 且不能包含 error");
  });

  it("在 completed 原生边界拒绝非法 anchor/cut 时间与置信度", async () => {
    const anchor = {
      id: "anchor-1",
      sourceMs: 1_000,
      targetMs: 2_000,
      origin: "automatic",
      confidence: 0.9
    };
    const cut = {
      id: "cut-1",
      name: "版本差异",
      sourceAtMs: 3_000,
      sourceRangeStartMs: 2_500,
      sourceRangeEndMs: 3_500,
      targetGapMs: -500,
      confidence: 0.8,
      note: "目标时间轴较短"
    };
    const proposal = {
      anchors: [anchor],
      cutCandidates: [cut],
      confidence: 0.8,
      diagnostics: []
    };
    const completed = {
      ...queuedJobContract,
      status: "completed",
      progress: 1,
      message: "本地音频对齐完成。",
      stageKey: "completed",
      stageLabel: "已完成",
      stageIndex: 9,
      stageProgress: 1
    };
    const malformedProposals = [
      { ...proposal, anchors: [{ ...anchor, sourceMs: -1 }] },
      { ...proposal, anchors: [{ ...anchor, targetMs: 1.5 }] },
      { ...proposal, anchors: [{ ...anchor, confidence: 1.01 }] },
      { ...proposal, cutCandidates: [{ ...cut, sourceAtMs: -1 }] },
      { ...proposal, cutCandidates: [{ ...cut, targetGapMs: 0.5 }] },
      { ...proposal, cutCandidates: [{ ...cut, confidence: -0.01 }] }
    ];

    for (const malformedProposal of malformedProposals) {
      await expect(
        getTauriAudioAlignmentJob(
          queuedJobContract.jobId,
          jobInvokerReturning({ ...completed, proposal: malformedProposal })
        )
      ).rejects.toThrow("已完成单任务必须包含 proposal 且不能包含 error");
    }
  });

  it("通过桌面桥打开脱敏诊断日志目录", async () => {
    tauriMocks.invoke.mockResolvedValue(undefined);

    await expect(openAudioAlignmentDiagnosticLogDirectory()).resolves.toBeUndefined();
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "open_alignment_diagnostic_log_directory"
    );
  });

  it("通过桌面桥打开本机敏感训练证据目录", async () => {
    tauriMocks.invoke.mockResolvedValue(undefined);

    await expect(openAudioAlignmentSensitiveManifestDirectory()).resolves.toBeUndefined();
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "open_alignment_sensitive_manifest_directory"
    );
  });

  it("严格读取按更新时间倒序排列的本机训练证据索引", async () => {
    const ready = sensitiveManifestSummary({
      runId: "audio-align-batch-ready",
      updatedAtMs: 300,
      intakeState: "ready",
      readyForTrainingIntake: true,
      lifecycleStage: "terminal",
      status: "completed",
      completedPairCount: 1,
      processedPairCount: 1,
      preparedMediaCount: 2,
      identifiedMediaCount: 2,
      evidenceGroupKey: `sha256:${"b".repeat(64)}`
    });
    const collecting = sensitiveManifestSummary({
      runId: "audio-align-batch-collecting",
      updatedAtMs: 200
    });
    tauriMocks.invoke.mockResolvedValue([ready, collecting]);

    await expect(listAudioAlignmentSensitiveManifestSummaries()).resolves.toEqual([
      ready,
      collecting
    ]);
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "list_alignment_sensitive_manifest_summaries"
    );
  });

  it("拒绝伪造可整理状态、未知字段和乱序的本机训练证据索引", async () => {
    const forged = sensitiveManifestSummary({
      intakeState: "ready",
      readyForTrainingIntake: true
    });
    await expect(
      listAudioAlignmentSensitiveManifestSummaries(() => Promise.resolve([forged]))
    ).rejects.toThrow("尚未满足真实训练证据整理条件");

    const unknown = { ...sensitiveManifestSummary(), privatePath: "F:\\private.mkv" };
    await expect(
      listAudioAlignmentSensitiveManifestSummaries(() => Promise.resolve([unknown]))
    ).rejects.toThrow("包含未知字段");

    const older = sensitiveManifestSummary({ runId: "older", updatedAtMs: 100 });
    const newer = sensitiveManifestSummary({ runId: "newer", updatedAtMs: 200 });
    await expect(
      listAudioAlignmentSensitiveManifestSummaries(() => Promise.resolve([older, newer]))
    ).rejects.toThrow("未按更新时间倒序排列");
  });

  it("生成并复核与运行关系和用户声明媒体家族绑定的盲复核任务包", async () => {
    const invoker = vi.fn((request: BuildAlignmentSensitiveBlindReviewPackRequest) => {
      const fixture = createRealAlignmentBlindReviewPackFixture();
      const { packId, ...body } = { ...fixture, mediaFamilyId: request.mediaFamilyId };
      expect(packId).toMatch(/^sha256:/);
      return Promise.resolve(JSON.stringify({ ...body, packId: sha256Json(body) }));
    });

    const json = await buildAudioAlignmentSensitiveBlindReviewPack(
      "audio-align-batch-ready",
      1,
      "Dark 第三季",
      invoker
    );

    const pack = parseMultimodalBlindReviewPackJson(json);
    expect(pack.schemaVersion).toBe("alignment-blind-review-pack-v2");
    if (pack.schemaVersion !== "alignment-blind-review-pack-v2") {
      throw new Error("测试夹具没有生成真实运行盲复核包。");
    }
    expect(pack.provenance.pairOrdinal).toBe(1);
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "audio-align-batch-ready", pairOrdinal: 1 })
    );
    await expect(
      buildAudioAlignmentSensitiveBlindReviewPack("audio-align-batch-ready", 1, "x", invoker)
    ).rejects.toThrow("3 至 80");
  });

  it("批任务一次发送全部媒体并规范化流索引", async () => {
    tauriMocks.invoke.mockResolvedValue({
      schemaVersion: 2,
      evidenceVersion: 5,
      jobId: "batch-1",
      pairingMode: "fullCartesian",
      sourceMediaIds: ["source"],
      targetMediaIds: ["target-1", "target-2"],
      versionReuseGroups: [],
      status: "queued",
      progress: 0,
      message: "已排队",
      totalPairCount: 2,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      diagnosticEvents: [],
      pairs: [
        batchPairSnapshot(1, "source", "target-1", "queued"),
        batchPairSnapshot(2, "source", "target-2", "queued")
      ],
      error: null,
      updatedAtMs: 1
    });

    await startTauriAudioAlignmentBatchJob({
      sources: [{ mediaId: "source", path: "D:\\media\\source.mkv" }],
      targets: [
        { mediaId: "target-1", path: "D:\\media\\ep1.mkv", audioStreamIndex: 2 },
        { mediaId: "target-2", path: "D:\\media\\ep2.mkv", videoStreamIndex: 4 }
      ],
      ffmpegPath: null,
      spectralBackend: "cpu",
      localizationMode: true
    });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_audio_alignment_batch_job", {
      request: {
        schemaVersion: 2,
        sources: [
          {
            mediaId: "source",
            path: "D:\\media\\source.mkv",
            audioStreamIndex: null,
            videoStreamIndex: null
          }
        ],
        targets: [
          {
            mediaId: "target-1",
            path: "D:\\media\\ep1.mkv",
            audioStreamIndex: 2,
            videoStreamIndex: null
          },
          {
            mediaId: "target-2",
            path: "D:\\media\\ep2.mkv",
            audioStreamIndex: null,
            videoStreamIndex: 4
          }
        ],
        versionReuseGroups: [],
        ffmpegPath: null,
        ffprobePath: null,
        spectralBackend: "cpu",
        localizationMode: true
      }
    });
  });

  it("批任务限制空集合、重复媒体和 256 个组合上限", async () => {
    const invoker = vi.fn<AudioAlignmentBatchJobInvoker["start"]>();
    const jobInvoker: AudioAlignmentBatchJobInvoker = {
      start: invoker,
      get: vi.fn(),
      cancel: vi.fn()
    };

    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("B 站参考素材不能为空");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [
            { mediaId: "source", path: "a.mkv" },
            { mediaId: " source ", path: "b.mkv" }
          ],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("包含重复媒体 ID");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "shared", path: "source.mkv" }],
          targets: [{ mediaId: "shared", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("媒体 ID 必须全局唯一");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: Array.from({ length: 17 }, (_, index) => ({
            mediaId: `source-${index}`,
            path: `${index}.mkv`
          })),
          targets: Array.from({ length: 16 }, (_, index) => ({
            mediaId: `target-${index}`,
            path: `${index}.mkv`
          })),
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("最多分析 256 个素材组合");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "集".repeat(257), path: "source.mkv" }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("最多 512 UTF-8 bytes");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv", audioStreamIndex: 0x1_0000_0000 }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        jobInvoker
      )
    ).rejects.toThrow("u32");
    expect(invoker).not.toHaveBeenCalled();
  });

  it("批任务允许 1×256 inventory，并在 1×257 时于 bridge 前阻断", async () => {
    const start = vi.fn<AudioAlignmentBatchJobInvoker["start"]>(() =>
      Promise.reject(new Error("native-invoked"))
    );
    const invoker: AudioAlignmentBatchJobInvoker = {
      start,
      get: vi.fn(),
      cancel: vi.fn()
    };
    const createTargets = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        mediaId: `target-${index}`,
        path: `target-${index}.mkv`
      }));
    const base = {
      sources: [{ mediaId: "source", path: "source.mkv" }],
      ffmpegPath: null,
      localizationMode: true as const
    };

    await expect(
      startTauriAudioAlignmentBatchJob({ ...base, targets: createTargets(256) }, invoker)
    ).rejects.toThrow("native-invoked");
    expect(start).toHaveBeenCalledTimes(1);

    await expect(
      startTauriAudioAlignmentBatchJob({ ...base, targets: createTargets(257) }, invoker)
    ).rejects.toThrow(/最多选择 256|最多分析 256/);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("批任务可显式指定未完成 pair，并拒绝重复或越界引用", async () => {
    const snapshot = {
      schemaVersion: 2 as const,
      evidenceVersion: 5 as const,
      jobId: "batch-explicit",
      pairingMode: "explicit" as const,
      sourceMediaIds: ["source"],
      targetMediaIds: ["target"],
      versionReuseGroups: [],
      status: "queued" as const,
      progress: 0,
      message: "已排队",
      totalPairCount: 1,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      diagnosticEvents: [],
      pairs: [batchPairSnapshot(1, "source", "target", "queued")],
      error: null,
      updatedAtMs: 1
    };
    const start = vi.fn<AudioAlignmentBatchJobInvoker["start"]>(() =>
      Promise.resolve(snapshot)
    );
    const invoker: AudioAlignmentBatchJobInvoker = {
      start,
      get: vi.fn(),
      cancel: vi.fn()
    };
    const base = {
      sources: [{ mediaId: "source", path: "source.mkv" }],
      targets: [{ mediaId: "target", path: "target.mkv" }],
      ffmpegPath: null,
      localizationMode: true as const
    };

    await startTauriAudioAlignmentBatchJob(
      {
        ...base,
        pairs: [{ sourceMediaId: "source", targetMediaId: "target" }]
      },
      invoker
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        pairs: [{ sourceMediaId: "source", targetMediaId: "target" }]
      })
    );

    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          ...base,
          pairs: [{ sourceMediaId: "missing", targetMediaId: "target" }]
        },
        invoker
      )
    ).rejects.toThrow("引用了未纳入批次的媒体");
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          ...base,
          pairs: [
            { sourceMediaId: "source", targetMediaId: "target" },
            { sourceMediaId: "source", targetMediaId: "target" }
          ]
        },
        invoker
      )
    ).rejects.toThrow("包含重复素材组合");
  });

  it("多版本复用组按媒体 inventory 规范化，并要求原生启动回包精确绑定", async () => {
    const snapshot: AudioAlignmentBatchJobSnapshot = {
      schemaVersion: 2,
      evidenceVersion: 5,
      jobId: "batch-version-reuse",
      pairingMode: "fullCartesian",
      sourceMediaIds: ["source"],
      targetMediaIds: ["target-1", "target-2"],
      versionReuseGroups: [
        {
          groupOrdinal: 1,
          groupId: "target-versions",
          side: "target",
          mediaIds: ["target-1", "target-2"]
        }
      ],
      status: "queued",
      progress: 0,
      message: "已排队",
      totalPairCount: 2,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      diagnosticEvents: [],
      pairs: [
        batchPairSnapshot(1, "source", "target-1", "queued"),
        batchPairSnapshot(2, "source", "target-2", "queued")
      ],
      error: null,
      updatedAtMs: 1
    };
    const start = vi.fn<AudioAlignmentBatchJobInvoker["start"]>().mockResolvedValue(snapshot);

    await startTauriAudioAlignmentBatchJob(
      {
        sources: [{ mediaId: "source", path: "source.mkv" }],
        targets: [
          { mediaId: "target-1", path: "target-1.mkv" },
          { mediaId: "target-2", path: "target-2.mkv" }
        ],
        versionReuseGroups: [
          {
            groupId: "target-versions",
            side: "target",
            mediaIds: ["target-2", "target-1"]
          }
        ],
        ffmpegPath: null,
        localizationMode: true
      },
      { start, get: vi.fn(), cancel: vi.fn() }
    );

    expect(start.mock.calls[0]?.[0].versionReuseGroups).toEqual([
      {
        groupId: "target-versions",
        side: "target",
        mediaIds: ["target-1", "target-2"]
      }
    ]);

    const mismatched = structuredClone(snapshot);
    mismatched.versionReuseGroups[0].mediaIds.reverse();
    const mismatchedStart = vi
      .fn<AudioAlignmentBatchJobInvoker["start"]>()
      .mockResolvedValue(mismatched);
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv" }],
          targets: [
            { mediaId: "target-1", path: "target-1.mkv" },
            { mediaId: "target-2", path: "target-2.mkv" }
          ],
          versionReuseGroups: [
            {
              groupId: "target-versions",
              side: "target",
              mediaIds: ["target-1", "target-2"]
            }
          ],
          ffmpegPath: null,
          localizationMode: true
        },
        { start: mismatchedStart, get: vi.fn(), cancel: vi.fn() }
      )
    ).rejects.toThrow("canonical 排序");
  });

  it("支持读取和取消原生批任务", async () => {
    const snapshot = {
      schemaVersion: 2 as const,
      evidenceVersion: 5 as const,
      jobId: "batch-2",
      pairingMode: "fullCartesian" as const,
      sourceMediaIds: ["source"],
      targetMediaIds: ["target-1", "target-2"],
      versionReuseGroups: [],
      status: "cancelled" as const,
      progress: 1,
      message: "已取消",
      totalPairCount: 2,
      processedPairCount: 1,
      failedPairCount: 0,
      currentPairOrdinal: null,
      diagnosticEvents: [],
      pairs: [
        batchPairSnapshot(1, "source", "target-1", "completed"),
        batchPairSnapshot(2, "source", "target-2", "cancelled")
      ],
      error: null,
      updatedAtMs: 2
    };
    const invoker: AudioAlignmentBatchJobInvoker = {
      start: () => Promise.resolve(snapshot),
      get: () => Promise.resolve(snapshot),
      cancel: () => Promise.resolve(snapshot)
    };

    await expect(getTauriAudioAlignmentBatchJob("batch-2", invoker)).resolves.toBe(snapshot);
    await expect(cancelTauriAudioAlignmentBatchJob("batch-2", invoker)).resolves.toBe(snapshot);
  });

  it("拒绝计数矛盾或 jobId 不匹配的原生批任务响应", async () => {
    const invalidSnapshot = {
      schemaVersion: 2 as const,
      evidenceVersion: 5 as const,
      jobId: "wrong-job",
      pairingMode: "fullCartesian" as const,
      sourceMediaIds: ["source"],
      targetMediaIds: ["target"],
      versionReuseGroups: [],
      status: "running" as const,
      progress: 0.5,
      message: "运行中",
      totalPairCount: 1,
      processedPairCount: 1,
      failedPairCount: 0,
      currentPairOrdinal: 1,
      diagnosticEvents: [],
      pairs: [batchPairSnapshot(1, "source", "target", "running")],
      error: null,
      updatedAtMs: 3
    };
    const invoker: AudioAlignmentBatchJobInvoker = {
      start: () => Promise.resolve(invalidSnapshot),
      get: () => Promise.resolve(invalidSnapshot),
      cancel: () => Promise.resolve(invalidSnapshot)
    };

    await expect(getTauriAudioAlignmentBatchJob("expected-job", invoker)).rejects.toThrow(
      "jobId 与请求不一致"
    );
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv" }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        invoker
      )
    ).rejects.toThrow("processed/failed 计数与 pair 状态不一致");
  });

  it("启动响应必须绑定请求 inventory，completed 终态不得夹带 cancelled pair", async () => {
    const wrongInventory = {
      schemaVersion: 2 as const,
      evidenceVersion: 5 as const,
      jobId: "batch-boundary",
      pairingMode: "fullCartesian" as const,
      sourceMediaIds: ["other-source"],
      targetMediaIds: ["target"],
      versionReuseGroups: [],
      status: "queued" as const,
      progress: 0,
      message: "queued",
      totalPairCount: 1,
      processedPairCount: 0,
      failedPairCount: 0,
      currentPairOrdinal: null,
      diagnosticEvents: [],
      pairs: [batchPairSnapshot(1, "other-source", "target", "queued")],
      error: null,
      updatedAtMs: 1
    };
    const inventoryInvoker: AudioAlignmentBatchJobInvoker = {
      start: () => Promise.resolve(wrongInventory),
      get: vi.fn(),
      cancel: vi.fn()
    };
    await expect(
      startTauriAudioAlignmentBatchJob(
        {
          sources: [{ mediaId: "source", path: "source.mkv" }],
          targets: [{ mediaId: "target", path: "target.mkv" }],
          ffmpegPath: null,
          localizationMode: true
        },
        inventoryInvoker
      )
    ).rejects.toThrow("未绑定本次请求");

    const inconsistentCompleted = {
      ...wrongInventory,
      jobId: "batch-completed",
      sourceMediaIds: ["source"],
      status: "completed" as const,
      progress: 1,
      pairs: [batchPairSnapshot(1, "source", "target", "cancelled")]
    };
    const terminalInvoker: AudioAlignmentBatchJobInvoker = {
      start: vi.fn(),
      get: () => Promise.resolve(inconsistentCompleted),
      cancel: vi.fn()
    };
    await expect(
      getTauriAudioAlignmentBatchJob("batch-completed", terminalInvoker)
    ).rejects.toThrow("标记 completed");
  });

  it("接受 fine 失败后保留的 coarse 证据，并严格校验失败状态与完整 Top-K", async () => {
    const failedSnapshot: AudioAlignmentBatchJobSnapshot = {
      schemaVersion: 2,
      evidenceVersion: 5,
      jobId: "batch-fine-failed",
      pairingMode: "fullCartesian",
      sourceMediaIds: ["source"],
      targetMediaIds: ["target"],
      versionReuseGroups: [],
      status: "failed",
      progress: 1,
      message: "fine failed",
      totalPairCount: 1,
      processedPairCount: 1,
      failedPairCount: 1,
      currentPairOrdinal: null,
      diagnosticEvents: [],
      pairs: [
        {
          ...batchPairSnapshot(1, "source", "target", "failed"),
          relationRanking: batchRelationRanking("completed"),
          globalSelection: failedBatchGlobalSelectionWithCoarseEvidence()
        }
      ],
      error: "batch failed",
      updatedAtMs: 4
    };
    const read = (snapshot: AudioAlignmentBatchJobSnapshot) =>
      getTauriAudioAlignmentBatchJob("batch-fine-failed", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot),
        cancel: vi.fn()
      });

    const preservedFineFailure = await read(failedSnapshot);
    expect(preservedFineFailure.pairs[0].relationRanking).toMatchObject({
      state: "ranked",
      score: 0.8
    });

    const completedWithErrors = structuredClone(failedSnapshot);
    completedWithErrors.status = "completed";
    completedWithErrors.message = "batch completed with one failed pair";
    completedWithErrors.error = null;
    await expect(read(completedWithErrors)).resolves.toEqual(completedWithErrors);

    const wrongState = structuredClone(failedSnapshot);
    wrongState.pairs[0].globalSelection.state = "blocked";
    await expect(read(wrongState)).rejects.toThrow("失败 pair 必须发布 failed");

    const coarseFailedRelation = structuredClone(failedSnapshot);
    coarseFailedRelation.pairs[0].relationRanking = batchRelationRanking("failed");
    await expect(read(coarseFailedRelation)).resolves.toEqual(coarseFailedRelation);

    const truncatedTopK = structuredClone(failedSnapshot);
    truncatedTopK.pairs[0].globalSelection.topK = [];
    await expect(read(truncatedTopK)).rejects.toThrow("topK 数量无效");

    const mismatchedDecision = structuredClone(failedSnapshot);
    const decisionCandidate = mismatchedDecision.pairs[0].globalSelection.decisionCandidate;
    if (decisionCandidate === null) throw new Error("fixture decision candidate missing");
    decisionCandidate.offsetMs = 1;
    await expect(read(mismatchedDecision)).rejects.toThrow("与 Top-K 同 rank 候选不一致");
  });

  it("v5 canonical digest 固定向量保持跨语言一致，并拒绝不安全整数", () => {
    expect(
      createAudioAlignmentBatchProposalTimeMapDigest({
        values: [1, -0, 1e-6, 1e-7, 23.976, 0.1, Number.MAX_SAFE_INTEGER]
      })
    ).toBe("sha256:b1bad579a5498e8c09150d4cb41a6b540e18ba2f8783c8b9367dbe35b902de28");
    expect(() => createAudioAlignmentBatchProposalTimeMapDigest({ value: 1e16 })).toThrow(
      "安全范围"
    );
  });

  it("v5 fine inventory 完整枚举并拒绝重签 receipt 后的成员改窗与序号断层", async () => {
    const read = (snapshot: AudioAlignmentBatchJobSnapshot) =>
      getTauriAudioAlignmentBatchJob("batch-v3", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot),
        cancel: vi.fn()
      });
    const tamperedWindow = completedBatchJobSnapshot();
    const windowFrontier = tamperedWindow.pairs[0]?.fineFrontier;
    if (!windowFrontier) throw new Error("fixture fine frontier missing");
    windowFrontier.inventoryCandidates[0].members[0].sourceEndMs += 1;
    windowFrontier.receiptDigest =
      createAudioAlignmentBatchFineFrontierReceiptDigest(windowFrontier);
    await expect(read(tamperedWindow)).rejects.toThrow("inventoryDigest");

    const ordinalGap = completedBatchJobSnapshot();
    const gapFrontier = ordinalGap.pairs[0]?.fineFrontier;
    if (!gapFrontier) throw new Error("fixture fine frontier missing");
    gapFrontier.inventoryCandidates[0].id.candidateOrdinal = 2;
    gapFrontier.inventoryDigest = createAudioAlignmentBatchFineInventoryDigest(
      gapFrontier.inventoryCandidates
    );
    gapFrontier.receiptDigest = createAudioAlignmentBatchFineFrontierReceiptDigest(gapFrontier);
    await expect(read(ordinalGap)).rejects.toThrow("连续完整枚举");
  });

  it("v5 fine inventory 允许保留未达到 intrinsic 门槛的 raw coarse 成员", async () => {
    const snapshot = completedBatchJobSnapshot();
    const frontier = snapshot.pairs[0]?.fineFrontier;
    if (!frontier) throw new Error("fixture fine frontier missing");
    frontier.inventoryCandidates[0].members[0].inlierCount = 5;
    frontier.inventoryCandidates[0].members[0].temporalCoverage = 0.19;
    frontier.inventoryCandidates[0].members[0].globalScore = 0;
    frontier.inventoryDigest = createAudioAlignmentBatchFineInventoryDigest(
      frontier.inventoryCandidates
    );
    frontier.receiptDigest = createAudioAlignmentBatchFineFrontierReceiptDigest(frontier);

    await expect(
      getTauriAudioAlignmentBatchJob("batch-v3", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot),
        cancel: vi.fn()
      })
    ).resolves.toEqual(snapshot);
  });

  it("explicit many-to-one 终态接受自动 target-axis reuse ordinal 并拒绝漂移", async () => {
    const sharedFrontier = createTestFineFrontierReceipt(
      [1, 2],
      [
        { pairOrdinal: 1, candidateOrdinal: 1 },
        { pairOrdinal: 2, candidateOrdinal: 1 }
      ]
    );
    for (const candidate of sharedFrontier.inventoryCandidates) {
      candidate.targetAxisReuseGroupOrdinal = 1;
    }
    sharedFrontier.inventoryDigest = createAudioAlignmentBatchFineInventoryDigest(
      sharedFrontier.inventoryCandidates
    );
    sharedFrontier.receiptDigest = createAudioAlignmentBatchFineFrontierReceiptDigest(sharedFrontier);
    const firstPair = batchPairSnapshot(1, "source-a", "target", "completed");
    const secondPair = batchPairSnapshot(2, "source-b", "target", "completed");
    firstPair.fineFrontier = structuredClone(sharedFrontier);
    secondPair.fineFrontier = structuredClone(sharedFrontier);
    const snapshot: AudioAlignmentBatchJobSnapshot = {
      ...completedBatchJobSnapshot(),
      jobId: "batch-explicit-many-to-one",
      pairingMode: "explicit",
      sourceMediaIds: ["source-a", "source-b"],
      targetMediaIds: ["target"],
      totalPairCount: 2,
      processedPairCount: 2,
      pairs: [firstPair, secondPair]
    };
    const read = (value: AudioAlignmentBatchJobSnapshot) =>
      getTauriAudioAlignmentBatchJob("batch-explicit-many-to-one", {
        start: vi.fn(),
        get: () => Promise.resolve(value),
        cancel: vi.fn()
      });

    await expect(read(snapshot)).resolves.toEqual(snapshot);

    const drifted = structuredClone(snapshot);
    const driftedFrontier = drifted.pairs[0].fineFrontier;
    if (!driftedFrontier) throw new Error("fixture fine frontier missing");
    for (const candidate of driftedFrontier.inventoryCandidates) {
      candidate.targetAxisReuseGroupOrdinal = 2;
    }
    driftedFrontier.inventoryDigest = createAudioAlignmentBatchFineInventoryDigest(
      driftedFrontier.inventoryCandidates
    );
    driftedFrontier.receiptDigest = createAudioAlignmentBatchFineFrontierReceiptDigest(
      driftedFrontier
    );
    await expect(read(drifted)).rejects.toThrow("多版本复用组 ordinal 未绑定批次策略");
  });

  it("严格拒绝 legacy v2 外层和 v3 外层夹带的旧 fine contract", async () => {
    const valid = completedBatchJobSnapshot();
    const readUnknown = (snapshot: unknown) =>
      getTauriAudioAlignmentBatchJob("batch-v3", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot as AudioAlignmentBatchJobSnapshot),
        cancel: vi.fn()
      });

    const legacyOuter = structuredClone(valid) as unknown as Record<string, unknown>;
    legacyOuter.evidenceVersion = 2;
    await expect(readUnknown(legacyOuter)).rejects.toThrow("evidenceVersion");

    const mixedFine = structuredClone(valid);
    const frontier = mixedFine.pairs[0]?.fineFrontier as unknown as Record<string, unknown>;
    frontier.contractVersion = "alignment-v2-adaptive-fine-frontier-v0";
    await expect(readUnknown(mixedFine)).rejects.toThrow("contractVersion");
  });

  it("v3 fine evidence 校验自摘要与 requested/effective 50ms 解码边界", async () => {
    const read = (snapshot: AudioAlignmentBatchJobSnapshot) =>
      getTauriAudioAlignmentBatchJob("batch-v3", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot),
        cancel: vi.fn()
      });

    const exactTolerance = completedBatchJobSnapshot();
    const exactExecution = exactTolerance.pairs[0]?.fineExecutionEvidence;
    if (exactExecution === null || exactExecution === undefined) {
      throw new Error("fixture fine execution missing");
    }
    exactExecution.sourceEffectiveWindow.endMs += 50;
    exactExecution.sourceEffectiveWindow.expectedSampleCount += 800;
    exactExecution.sourceEffectiveWindow.actualDecodedSampleCount =
      exactExecution.sourceEffectiveWindow.expectedSampleCount;
    exactExecution.evidenceDigest =
      createAudioAlignmentBatchFineExecutionEvidenceDigest(exactExecution);
    await expect(read(exactTolerance)).resolves.toEqual(exactTolerance);

    const beyondTolerance = structuredClone(exactTolerance);
    const beyondExecution = beyondTolerance.pairs[0]?.fineExecutionEvidence;
    if (beyondExecution === null || beyondExecution === undefined) {
      throw new Error("fixture fine execution missing");
    }
    beyondExecution.sourceEffectiveWindow.endMs += 1;
    beyondExecution.sourceEffectiveWindow.expectedSampleCount += 16;
    beyondExecution.sourceEffectiveWindow.actualDecodedSampleCount =
      beyondExecution.sourceEffectiveWindow.expectedSampleCount;
    beyondExecution.evidenceDigest =
      createAudioAlignmentBatchFineExecutionEvidenceDigest(beyondExecution);
    await expect(read(beyondTolerance)).rejects.toThrow("最多放宽 50ms");

    const tamperedDigest = completedBatchJobSnapshot();
    const tamperedExecution = tamperedDigest.pairs[0]?.fineExecutionEvidence;
    if (tamperedExecution === null || tamperedExecution === undefined) {
      throw new Error("fixture fine execution missing");
    }
    tamperedExecution.scoreMicros -= 1;
    await expect(read(tamperedDigest)).rejects.toThrow("evidenceDigest");
  });

  it("v3 fine evidence 即使重签摘要也拒绝篡改 locked backendDetail", async () => {
    const snapshot = completedBatchJobSnapshot();
    const execution = snapshot.pairs[0]?.fineExecutionEvidence;
    if (execution === null || execution === undefined) {
      throw new Error("fixture fine execution missing");
    }
    execution.sourceFineBackend.backendDetail = "caller-forged fine backend detail";
    execution.evidenceDigest = createAudioAlignmentBatchFineExecutionEvidenceDigest(execution);

    await expect(
      getTauriAudioAlignmentBatchJob("batch-v3", {
        start: vi.fn(),
        get: () => Promise.resolve(snapshot),
        cancel: vi.fn()
      })
    ).rejects.toThrow("coarse→fine backend continuity");
  });
});

function completedBatchJobSnapshot(): AudioAlignmentBatchJobSnapshot {
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "batch-v3",
    pairingMode: "fullCartesian",
    sourceMediaIds: ["source"],
    targetMediaIds: ["target"],
    versionReuseGroups: [],
    status: "completed",
    progress: 1,
    message: "completed",
    totalPairCount: 1,
    processedPairCount: 1,
    failedPairCount: 0,
    currentPairOrdinal: null,
    diagnosticEvents: [],
    pairs: [batchPairSnapshot(1, "source", "target", "completed")],
    error: null,
    updatedAtMs: 1
  };
}

function batchPairSnapshot(
  pairOrdinal: number,
  sourceMediaId: string,
  targetMediaId: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
) {
  const proposal = status === "completed" ? batchProposal() : null;
  const fineFrontier =
    status === "completed"
      ? createTestFineFrontierReceipt([pairOrdinal], [{ pairOrdinal, candidateOrdinal: 1 }], {
          componentOrdinal: pairOrdinal
        })
      : status === "failed"
        ? createTestFineFrontierReceipt([pairOrdinal], [], {
            componentOrdinal: pairOrdinal,
            finalState: "failed"
          })
        : null;
  return {
    pairIndex: pairOrdinal - 1,
    pairOrdinal,
    sourceMediaId,
    targetMediaId,
    status,
    progress: status === "queued" ? 0 : status === "running" ? 0.5 : 1,
    message: status,
    relationRanking: batchRelationRanking(status),
    globalSelection: batchGlobalSelection(status),
    fineFrontier,
    fineExecutionEvidence:
      proposal?.timeMap && fineFrontier?.resolved
        ? createTestFineExecutionEvidence(proposal.timeMap, {
            pairOrdinal,
            engineVersion: testExecutionIdentity.engineVersion,
            featureVersion: testExecutionIdentity.featureVersion,
            coarseBackend: testExecutionIdentity.sourceSpectralBackends[0]
          })
        : null,
    proposal,
    error: status === "failed" ? "pair failed" : null
  };
}

function batchProposal(): AlignmentProposal {
  const timeMap: AlignmentTimeMapProposal = {
    sourceStartMs: 0,
    sourceEndMs: 1_000,
    targetStartMs: 0,
    targetEndMs: 1_000,
    spans: [],
    quality: {
      level: "review",
      probability: 0.9,
      metricSource: "measured",
      coverage: 1,
      uniqueContentCoverage: 1,
      p50ResidualMs: 0,
      p95ResidualMs: 0,
      p99ResidualMs: 0,
      maxResidualMs: 0,
      boundaryUncertaintyMs: 0,
      alternativeMargin: 1,
      anchorCount: 8,
      anchorRegionCount: 3,
      heldOutAnchorCount: 2,
      reasons: []
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 8,
      visualAnchorCount: 0,
      heldOutAnchorCount: 2,
      top1Top2Margin: 1,
      uniqueContentCoverage: 1,
      repeatedContentOnly: false,
      selectedTrackReason: "v3 fixture",
      alternativeTrackScores: [],
      notes: []
    },
    sourceStream: testAudioStream(),
    targetStream: testAudioStream(),
    sourceVisualStream: null,
    targetVisualStream: null,
    sourceIdentity: null,
    targetIdentity: null,
    engineVersion: testExecutionIdentity.engineVersion,
    featureVersion: testExecutionIdentity.featureVersion,
    parametersHash: "legacy-parameters-v2"
  };
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.9,
    diagnostics: [],
    timeMap
  };
}

function testAudioStream() {
  return {
    type: "audio" as const,
    index: 0,
    codec: "flac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/16000",
    sampleRate: 16_000,
    channels: 1,
    frameRate: null,
    language: null,
    title: null
  };
}

function batchRelationRanking(
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
) {
  if (status === "completed") {
    const candidate = {
      rank: 1,
      sourceStreamIndex: 0,
      targetStreamIndex: 0,
      score: 0.9,
      globalScore: 0.8,
      scale: 1,
      offsetMs: 0,
      sourceStartMs: 0,
      sourceEndMs: 1_000,
      targetStartMs: 0,
      targetEndMs: 1_000,
      inlierCount: 20,
      temporalCoverage: 0.8,
      uniqueSourceCoverage: 0.7
    };
    return {
      scoreVersion: "alignment-v2-pair-intrinsic-global-weight-v1" as const,
      executionIdentityDigest: `sha256:${"d".repeat(64)}` as const,
      executionIdentity: structuredClone(testExecutionIdentity),
      state: "ranked" as const,
      candidateCount: 1,
      eligibleCandidateCount: 1,
      score: candidate.globalScore,
      bestEligibleCandidate: candidate
    };
  }
  return {
    scoreVersion: "alignment-v2-pair-intrinsic-global-weight-v1" as const,
    executionIdentityDigest: null,
    executionIdentity: null,
    state:
      status === "failed"
        ? ("failed" as const)
        : status === "cancelled"
          ? ("cancelled" as const)
          : ("pending" as const),
    candidateCount: 0,
    eligibleCandidateCount: 0,
    score: null,
    bestEligibleCandidate: null
  };
}

function batchGlobalSelection(
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
) {
  if (status === "completed") {
    const candidate = {
      rank: 1,
      sourceStreamIndex: 0,
      targetStreamIndex: 0,
      score: 0.9,
      globalScore: 0.8,
      scale: 1,
      offsetMs: 0,
      sourceStartMs: 0,
      sourceEndMs: 1_000,
      targetStartMs: 0,
      targetEndMs: 1_000,
      inlierCount: 20,
      temporalCoverage: 0.8,
      uniqueSourceCoverage: 0.7,
      eligible: true,
      globalSelected: true
    };
    return {
      state: "selected" as const,
      selected: true,
      selectedRank: 1,
      selectedScore: 0.8,
      decisionRank: 1,
      decisionScore: 0.8,
      margin: 1,
      candidateCount: 1,
      eligibleCandidateCount: 1,
      topK: [candidate],
      decisionCandidate: candidate
    };
  }
  return {
    state:
      status === "failed"
        ? ("failed" as const)
        : status === "cancelled"
          ? ("cancelled" as const)
          : ("pending" as const),
    selected: false,
    selectedRank: null,
    selectedScore: null,
    decisionRank: null,
    decisionScore: null,
    margin: null,
    candidateCount: 0,
    eligibleCandidateCount: 0,
    topK: [],
    decisionCandidate: null
  };
}

function failedBatchGlobalSelectionWithCoarseEvidence() {
  const completed = batchGlobalSelection("completed");
  if (completed.decisionCandidate === null) {
    throw new Error("测试 fixture 缺少 coarse decision candidate。");
  }
  return {
    ...completed,
    state: "failed" as const,
    selected: false,
    selectedRank: null,
    selectedScore: null,
    topK: completed.topK.map((candidate) => ({ ...candidate, globalSelected: false })),
    decisionCandidate: { ...completed.decisionCandidate, globalSelected: false }
  };
}

function sensitiveManifestSummary(
  patch: Partial<AlignmentSensitiveManifestSummary> = {}
): AlignmentSensitiveManifestSummary {
  return {
    runId: "audio-align-batch-collecting",
    manifestPayloadDigest: `sha256:${"a".repeat(64)}`,
    manifestCanonicalPayloadDigest: `sha256:${"b".repeat(64)}`,
    lifecycleStage: "queued",
    createdAtMs: 100,
    updatedAtMs: 100,
    appVersion: "0.1.0",
    engineVersion: "alignment-v2-test",
    featureVersion: "feature-test",
    status: "queued",
    sourceMediaCount: 1,
    targetMediaCount: 1,
    pairCount: 1,
    processedPairCount: 0,
    completedPairCount: 0,
    failedPairCount: 0,
    cancelledPairCount: 0,
    preparedMediaCount: 0,
    identifiedMediaCount: 0,
    audioCandidateCount: 0,
    landmarkArtifactCount: 0,
    landmarkCacheHitCount: 0,
    evidenceSpanCount: 0,
    uncertainSpanCount: 0,
    visualEvidencePairCount: 0,
    visualEvidenceRequested: true,
    evidenceGroupKey: null,
    intakeState: "collecting",
    readyForTrainingIntake: false,
    reviewCandidatePairs: [],
    notes: ["运行仍在采集。"],
    ...patch
  };
}
