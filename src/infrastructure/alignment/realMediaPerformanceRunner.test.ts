import { describe, expect, it, vi } from "vitest";
import { computeC137CanonicalDigest } from "../../domain/alignment/c137Acceptance";
import {
  serializeC137PerformanceEvidence,
  validateC137PerformanceEvidence
} from "../../domain/alignment/c137PerformanceEvidence";
import type { AlignmentProposal } from "../../domain/alignment/types";
import type {
  RealMediaBenchmarkGold,
  RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import type { MediaContentIdentity } from "../../domain/project/types";
import type { MediaTimelineProbeResult } from "../media/tauriMediaProbe";
import {
  collectRealMediaPerformanceEvidence,
  createC137PerformanceRawEvidenceFromJournal,
  createEngineeringRealMediaPerformancePlan,
  sealC137PerformanceEvidenceForProcess,
  type RealMediaPerformanceExecutionPlan,
  type RealMediaPerformanceRunnerOptions
} from "./realMediaPerformanceRunner";
import type {
  AlignmentBenchmarkCacheCounts,
  AlignmentBenchmarkCacheResetReceipt,
  AlignmentBenchmarkInvoker,
  AlignmentBenchmarkJobSnapshot,
  AlignmentBenchmarkSessionRequest,
  AlignmentBenchmarkSessionSnapshot,
  AlignmentBenchmarkWorkloadStorageReceipt
} from "./tauriAlignmentBenchmark";
import type { NormalizedTauriAudioAlignmentRequest } from "./tauriAudioAlignment";
import type {
  C137ProcessAttestationInvoker,
  C137ProcessEvidenceBindingV1
} from "./tauriC137ProcessAttestation";

describe("C137 原生性能 evidence 调度器", () => {
  it("严格执行 reset → cold → warmup → hot → reset → cancellation 并只保留去敏证据", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0001"
    );
    const events: string[] = [];
    const invoker = createSuccessfulInvoker(manifest, events);

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      wait: () => Promise.resolve(),
      now: createClock()
    });

    expect(journal.status).toBe("completed");
    expect(journal.terminalSessionStatus).toBe("released");
    expect(journal.cacheResets).toHaveLength(2);
    expect(journal.trials).toHaveLength(4);
    expect(events).toEqual([
      "begin",
      "reset:1",
      "start:1",
      "get:1",
      "start:2",
      "get:2",
      "start:3",
      "get:3",
      "reset:2",
      "start:4",
      "cancel:4",
      "get:4",
      "finish"
    ]);
    const measured = journal.trials.flatMap((trial) =>
      trial.kind === "run" ? [trial.run] : []
    );
    expect(measured.map((run) => run.kind)).toEqual(["cold", "warmup", "hot"]);
    expect(new Set(measured.map((run) => run.outputDigest)).size).toBe(1);
    expect(measured[0].cache.before).toEqual(createCacheCounts(0));
    expect(measured[1].cache.resetReceiptDigest).toBeNull();
    expect(measured[2].cache.warmupTrialId).toBe("performance-plan-0001-warmup-1");
    expect(measured.every((run) => run.memory.coverageComplete)).toBe(true);
    const cancellation = journal.trials[3];
    expect(cancellation).toMatchObject({
      kind: "cancellation",
      cancellation: {
        triggerStageKey: "extracting-source",
        terminalStatus: "cancelled",
        processTreeEmpty: true,
        residualProcessCount: 0
      }
    });

    const rawEvidence = createC137PerformanceRawEvidenceFromJournal(journal);
    expect(rawEvidence.schemaVersion).toBe(2);
    expect(validateC137PerformanceEvidence(rawEvidence)).toEqual({
      valid: true,
      complete: true,
      issues: [],
      completenessIssues: []
    });
    const sealPerformance = vi.fn(
      (
        _sessionId: string,
        nativeRunId: string,
        evidenceDigest: `sha256:${string}`
      ): Promise<C137ProcessEvidenceBindingV1> =>
        Promise.resolve({
          evidenceKind: "performance-raw-evidence",
          nativeRunId,
          evidenceDigest
        })
    );
    const processInvoker: C137ProcessAttestationInvoker = {
      begin: () => Promise.reject(new Error("unused")),
      sealBlindBatch: () => Promise.reject(new Error("unused")),
      sealPerformance,
      finalize: () => Promise.reject(new Error("unused"))
    };
    await sealC137PerformanceEvidenceForProcess(
      rawEvidence,
      "live-process-performance-test",
      processInvoker
    );
    expect(sealPerformance).toHaveBeenCalledWith(
      "live-process-performance-test",
      rawEvidence.collector.sessionId,
      rawEvidence.evidenceDigest
    );
    const serialized = serializeC137PerformanceEvidence(rawEvidence);
    expect(serialized).not.toContain(manifest.cases[0].source.path);
    expect(serialized).not.toContain(manifest.cases[0].target.path);
    expect(serialized).not.toContain(manifest.cases[0].source.contentIdentity?.digest);
    expect(serialized).not.toContain(manifest.id);
    expect(serialized).not.toContain(manifest.datasetVersion);
    const beginRequest = vi.mocked(invoker.begin).mock.calls[0][0];
    expect(beginRequest.schemaVersion).toBe(2);
    expect(beginRequest.runManifestDigest).toBe(beginRequest.workloadDigest);
    expect(JSON.parse(beginRequest.runManifestCanonicalJson)).toMatchObject({
      schemaVersion: 1,
      cases: [{ caseId: "private-case-1" }]
    });
    expect(JSON.stringify(journal)).not.toContain("runManifestCanonicalJson");
  });

  it("运行计划 workload 被篡改时在取得原生 lease 前拒绝", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0002"
    );
    const tampered: RealMediaPerformanceExecutionPlan = {
      ...plan,
      workloadDigest: `sha256:${"f".repeat(64)}`
    };
    const invoker = createSuccessfulInvoker(manifest, []);

    await expect(
      collectRealMediaPerformanceEvidence(manifest, tampered, {
        benchmarkInvoker: invoker
      })
    ).rejects.toThrow("workloadDigest");
  });

  it("CUDA/CPU 策略分别绑定计划摘要、请求摘要并传到每个原生 job", async () => {
    const manifest = createManifest(false);
    const collectPolicy = async (spectralBackend: "cuda" | "cpu") => {
      const plan = createEngineeringRealMediaPerformancePlan(
        manifest,
        "performance-plan-policy",
        spectralBackend
      );
      const invoker = createSuccessfulInvoker(manifest, []);
      const received: NormalizedTauriAudioAlignmentRequest[] = [];
      const startJob = invoker.startJob;
      invoker.startJob = vi.fn(
        (sessionId: string, request: NormalizedTauriAudioAlignmentRequest) => {
          received.push(request);
          return startJob(sessionId, request);
        }
      );
      const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
        spectralBackend,
        benchmarkInvoker: invoker,
        preflightOptions: { probe: createProbe(manifest) },
        wait: () => Promise.resolve(),
        now: createClock()
      });
      const measuredCase = journal.trials.find((trial) => trial.kind === "run")?.run.cases[0];
      return { journal, received, measuredCase };
    };

    const cuda = await collectPolicy("cuda");
    const cpu = await collectPolicy("cpu");

    expect(cuda.journal.plan.parameters.spectralBackend).toBe("cuda");
    expect(cpu.journal.plan.parameters.spectralBackend).toBe("cpu");
    expect(cuda.journal.planDigest).not.toBe(cpu.journal.planDigest);
    expect(cuda.measuredCase?.requestParametersDigest).not.toBe(
      cpu.measuredCase?.requestParametersDigest
    );
    expect(cuda.received).toHaveLength(4);
    expect(cpu.received).toHaveLength(4);
    expect(cuda.received.every((request) => request.spectralBackend === "cuda")).toBe(true);
    expect(cpu.received.every((request) => request.spectralBackend === "cpu")).toBe(true);
    expect(
      createC137PerformanceRawEvidenceFromJournal(cuda.journal).plan.parameters.spectralBackend
    ).toBe("cuda");
    expect(
      createC137PerformanceRawEvidenceFromJournal(cpu.journal).plan.parameters.spectralBackend
    ).toBe("cpu");
  });

  it("显式未知性能声谱策略会在取得原生 lease 前拒绝", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-policy-invalid"
    );
    const invoker = createSuccessfulInvoker(manifest, []);
    const invalidBackend = "metal" as unknown as "auto";

    await expect(
      collectRealMediaPerformanceEvidence(manifest, plan, {
        spectralBackend: invalidBackend,
        benchmarkInvoker: invoker
      })
    ).rejects.toThrow("声谱计算策略仅支持 auto、cuda 或 cpu");
    expect(invoker.begin).not.toHaveBeenCalled();
    expect(() =>
      createEngineeringRealMediaPerformancePlan(
        manifest,
        "performance-plan-policy-invalid-create",
        invalidBackend
      )
    ).toThrow("声谱计算策略仅支持 auto、cuda 或 cpu");
  });

  it.each([
    ["blocked:cuda-fft-unavailable", "CUDA/cuFFT 能力不可用", "检测 4090 / CUDA"],
    ["blocked:cuda-fft-runtime", "CUDA/cuFFT 执行失败", "强制 CPU"]
  ] as const)(
    "性能任务启动失败时只披露已知安全码 %s 的固定建议",
    async (nativeCode, expectedReason, expectedRemediation) => {
      const manifest = createManifest(false);
      const plan = createEngineeringRealMediaPerformancePlan(
        manifest,
        "performance-plan-safe-failure",
        "cuda"
      );
      const invoker = createSuccessfulInvoker(manifest, []);
      const privateDetail = "C:\\private-performance\\driver.log stdout=SECRET";
      invoker.startJob = vi.fn(() =>
        Promise.reject(new Error(`${nativeCode}：${privateDetail}`))
      );

      const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
        spectralBackend: "cuda",
        benchmarkInvoker: invoker,
        preflightOptions: { probe: createProbe(manifest) },
        wait: () => Promise.resolve(),
        now: createClock()
      });

      expect(journal.status).toBe("failed");
      expect(journal.failure).toMatchObject({ code: nativeCode });
      expect(journal.failure?.message).toContain(expectedReason);
      expect(journal.failure?.message).toContain(expectedRemediation);
      expect(journal.issueCodes).toContain(nativeCode);
      const raw = createC137PerformanceRawEvidenceFromJournal(journal);
      const serialized = serializeC137PerformanceEvidence(raw);
      expect(serialized).toContain(nativeCode);
      expect(serialized).not.toContain(privateDetail);
      expect(serialized).not.toContain("SECRET");
    }
  );

  it("性能任务对未知伪 CUDA 码保持通用脱敏，不复述原始输出", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-unknown-failure",
      "cuda"
    );
    const invoker = createSuccessfulInvoker(manifest, []);
    invoker.startJob = vi.fn(() =>
      Promise.reject(
        new Error("blocked:cuda-fft-private-extension：C:\\private\\driver.log SECRET")
      )
    );

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      spectralBackend: "cuda",
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      wait: () => Promise.resolve(),
      now: createClock()
    });

    expect(journal.status).toBe("failed");
    expect(journal.failure).toBeNull();
    expect(journal.issueCodes).toContain("trial-failed");
    expect(JSON.stringify(journal)).not.toContain("SECRET");
  });

  it("原生 workload receipt 与冻结 manifest 不匹配时 fail closed、跳过 preflight 并仍 finish", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-receipt-mismatch"
    );
    const events: string[] = [];
    const invoker = createSuccessfulInvoker(manifest, events);
    invoker.begin = vi.fn((request: AlignmentBenchmarkSessionRequest) => {
      events.push("begin");
      const parsed = JSON.parse(request.runManifestCanonicalJson) as { cases: unknown[] };
      return Promise.resolve(
        createSession(`sha256:${"f".repeat(64)}`, parsed.cases.length)
      );
    });
    const probe = vi.fn(() => Promise.reject(new Error("preflight must not run")));

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe }
    });

    expect(journal.status).toBe("failed");
    expect(journal.issueCodes).toContain("workload-storage-receipt-mismatch");
    expect(probe).not.toHaveBeenCalled();
    expect(invoker.finish).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["begin", "finish"]);
  });

  it("begin 失败时不运行 preflight 或 job", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-begin-failed"
    );
    const invoker = createSuccessfulInvoker(manifest, []);
    invoker.begin = vi.fn(() => Promise.reject(new Error("native begin failed")));
    const probe = vi.fn(() => Promise.reject(new Error("preflight must not run")));

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe }
    });

    expect(journal.status).toBe("failed");
    expect(journal.issueCodes).toContain("collector-exception");
    expect(probe).not.toHaveBeenCalled();
    expect(invoker.startJob).not.toHaveBeenCalled();
    expect(invoker.finish).not.toHaveBeenCalled();
  });

  it("真实 case 超过 raw evidence 上限时在取得原生 lease 前拒绝", async () => {
    const smallManifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      smallManifest,
      "performance-plan-case-limit"
    );
    const oversizedManifest = createManifest(false);
    const template = oversizedManifest.cases[0];
    oversizedManifest.cases = Array.from({ length: 1_001 }, (_, index) => ({
      ...structuredClone(template),
      id: `private-case-${index + 1}`
    }));
    expect(() =>
      createEngineeringRealMediaPerformancePlan(
        oversizedManifest,
        "performance-plan-case-limit-oversized"
      )
    ).toThrow("不得超过 1000");
    const invoker = createSuccessfulInvoker(oversizedManifest, []);
    const probe = vi.fn(() => Promise.reject(new Error("preflight must not run")));

    await expect(
      collectRealMediaPerformanceEvidence(oversizedManifest, plan, {
        benchmarkInvoker: invoker,
        preflightOptions: { probe }
      })
    ).rejects.toThrow("不得超过 1000");
    expect(invoker.begin).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("performance 上限只计算 real case，不限制同清单中的 development 占位关系", () => {
    const manifest = createManifest(false);
    const template = manifest.cases[0];
    manifest.cases.push(
      ...Array.from({ length: 1_001 }, (_, index) => ({
        ...structuredClone(template),
        id: `development-placeholder-${index + 1}`,
        mediaKind: "placeholder" as const,
        split: "development" as const,
        source: { ...structuredClone(template.source), contentIdentity: null },
        target: { ...structuredClone(template.target), contentIdentity: null },
        independentAnnotations: [],
        adjudication: null
      }))
    );

    expect(() =>
      createEngineeringRealMediaPerformancePlan(manifest, "performance-plan-non-real-limit")
    ).not.toThrow();
  });

  it("adapter 拒绝采集后被改写的预注册计划", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0007"
    );
    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: createSuccessfulInvoker(manifest, []),
      preflightOptions: { probe: createProbe(manifest) },
      wait: () => Promise.resolve(),
      now: createClock()
    });
    const tamperedJournal = structuredClone(journal);
    tamperedJournal.plan.trialOrder[0].repetition += 1;

    expect(() => createC137PerformanceRawEvidenceFromJournal(tamperedJournal)).toThrow(
      "预注册 plan digest"
    );
  });

  it("在任何 await 前冻结唯一计划快照，调用方异步突变不能改变实际请求", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-toctou"
    );
    const invoker = createSuccessfulInvoker(manifest, []);
    const baseStart = invoker.startJob;
    const observedSampleRates: Array<number | undefined> = [];
    const observedSourcePaths: string[] = [];
    invoker.startJob = vi.fn(
      async (sessionId: string, request: NormalizedTauriAudioAlignmentRequest) => {
        observedSampleRates.push(request.sampleRate);
        observedSourcePaths.push(request.sourcePath);
        return baseStart(sessionId, request);
      }
    );

    const collecting = collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      wait: () => Promise.resolve(),
      now: createClock()
    });
    plan.parameters.sampleRate = 12_345;
    plan.trialOrder[0].trialId = "mutated-trial-after-await";
    manifest.cases[0].source.path = "C:\\mutated-after-await\\source.mkv";

    const journal = await collecting;
    expect(journal.status).toBe("completed");
    expect(journal.plan.parameters.sampleRate).toBeNull();
    expect(journal.plan.trialOrder[0].trialId).toBe("performance-plan-toctou-cold-1");
    expect(Object.isFrozen(journal.plan)).toBe(true);
    expect(Object.isFrozen(journal.plan.parameters)).toBe(true);
    expect(observedSampleRates).toEqual([undefined, undefined, undefined, undefined]);
    expect(observedSourcePaths).toEqual(
      Array.from({ length: 4 }, () => "C:\\private-performance\\source.mkv")
    );
    const raw = createC137PerformanceRawEvidenceFromJournal(journal);
    expect(raw.schemaVersion).toBe(2);
    expect(validateC137PerformanceEvidence(raw).complete).toBe(true);
    const firstCase = raw.trials.find((trial) => trial.trialType === "run")?.cases[0];
    expect(firstCase?.timeMapParametersHash).toBe("fnv1a64:0123456789abcdef");
    expect(firstCase?.requestParametersDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("在任何 await 前捕获 execution options，调用方突变路径与 invoker 不影响后续调用", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-options-toctou"
    );
    const invoker = createSuccessfulInvoker(manifest, []);
    const replacementInvoker = createSuccessfulInvoker(manifest, []);
    const observedSessionPaths: Array<string | null> = [];
    const observedRequestPaths: Array<string | null> = [];
    const observedPreflightPaths: Array<string | null | undefined> = [];
    const baseBegin = invoker.begin;
    invoker.begin = vi.fn((request: AlignmentBenchmarkSessionRequest) => {
      observedSessionPaths.push(request.ffmpegPath);
      return baseBegin(request);
    });
    const baseStart = invoker.startJob;
    invoker.startJob = vi.fn(
      (sessionId: string, request: NormalizedTauriAudioAlignmentRequest) => {
        observedRequestPaths.push(request.ffmpegPath);
        return baseStart(sessionId, request);
      }
    );
    const baseProbe = createProbe(manifest);
    const probe = vi.fn((request: { path: string; ffmpegPath?: string | null }) => {
      observedPreflightPaths.push(request.ffmpegPath);
      return baseProbe(request);
    });
    const options: RealMediaPerformanceRunnerOptions = {
      ffmpegPath: "C:\\trusted-tools\\ffmpeg.exe",
      benchmarkInvoker: invoker,
      preflightOptions: { probe },
      wait: () => Promise.resolve(),
      now: createClock()
    };

    const collecting = collectRealMediaPerformanceEvidence(manifest, plan, options);
    options.ffmpegPath = "C:\\mutated-tools\\ffmpeg.exe";
    options.benchmarkInvoker = replacementInvoker;
    options.preflightOptions = {
      probe: vi.fn(() => Promise.reject(new Error("mutated probe must not run")))
    };

    const journal = await collecting;
    expect(journal.status).toBe("completed");
    expect(observedSessionPaths).toEqual(["C:\\trusted-tools\\ffmpeg.exe"]);
    expect(observedPreflightPaths).toEqual([
      "C:\\trusted-tools\\ffmpeg.exe",
      "C:\\trusted-tools\\ffmpeg.exe"
    ]);
    expect(observedRequestPaths).toEqual([
      "C:\\trusted-tools\\ffmpeg.exe",
      "C:\\trusted-tools\\ffmpeg.exe",
      "C:\\trusted-tools\\ffmpeg.exe",
      "C:\\trusted-tools\\ffmpeg.exe"
    ]);
    expect(replacementInvoker.begin).not.toHaveBeenCalled();
    expect(replacementInvoker.startJob).not.toHaveBeenCalled();
  });

  it("example manifest 不启动原生 session，也不生成性能结论", async () => {
    const manifest = createManifest(true);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0003"
    );
    const invoker = createSuccessfulInvoker(manifest, []);

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker
    });

    expect(journal.status).toBe("preflight-failed");
    expect(journal.issueCodes).toContain("example-manifest");
    expect(invoker.begin).not.toHaveBeenCalled();
  });

  it("原生终态未知时停止后续 trial，并由 cleanup-blocked 保持 fail-closed", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0004"
    );
    const events: string[] = [];
    const base = createSuccessfulInvoker(manifest, events);
    const invoker: AlignmentBenchmarkInvoker = {
      ...base,
      getJob: vi.fn(() => Promise.reject(new Error("native state unavailable"))),
      finish: vi.fn((): Promise<AlignmentBenchmarkSessionSnapshot> => {
        events.push("finish-blocked");
      return Promise.resolve({
          ...createSession(),
          status: "cleanup-blocked" as const,
          activeJobId: "benchmark-job-1",
          cleanupIssue: "active job"
        });
      })
    };

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      wait: () => Promise.resolve(),
      now: createClock()
    });

    expect(journal.status).toBe("cleanup-blocked");
    expect(journal.trials).toHaveLength(1);
    expect(invoker.startJob).toHaveBeenCalledTimes(1);
    expect(invoker.cancelJob).toHaveBeenCalledTimes(1);
    expect(journal.issueCodes).toContain("cleanup-blocked");
  });

  it("start 响应无效时 bridge 恢复 active job，runner finally 仍释放 session", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-invalid-start-response"
    );
    const events: string[] = [];
    const base = createSuccessfulInvoker(manifest, events);
    const baseStart = base.startJob;
    const invoker: AlignmentBenchmarkInvoker = {
      ...base,
      startJob: vi.fn(async (
        sessionId: string,
        request: NormalizedTauriAudioAlignmentRequest
      ) => {
        const snapshot = await baseStart(sessionId, request);
        return {
          ...snapshot,
          schemaVersion: 1
        } as unknown as AlignmentBenchmarkJobSnapshot;
      }),
      getActive: vi.fn(() =>
        Promise.resolve({
          ...createSession(),
          activeJobId: "benchmark-job-1"
        })
      )
    };

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      wait: () => Promise.resolve(),
      now: createClock()
    });

    expect(journal.status).toBe("failed");
    expect(journal.terminalSessionStatus).toBe("released");
    expect(journal.issueCodes).toContain("trial-failed");
    expect(invoker.getActive).toHaveBeenCalledOnce();
    expect(invoker.cancelJob).toHaveBeenCalledWith("benchmark-session-1", "benchmark-job-1");
    expect(invoker.getJob).toHaveBeenCalledWith("benchmark-session-1", "benchmark-job-1");
    expect(invoker.finish).toHaveBeenCalledWith("benchmark-session-1");
    expect(events).toEqual([
      "begin",
      "reset:1",
      "start:1",
      "cancel:1",
      "get:1",
      "finish"
    ]);
  });

  it("用户在 trial 前取消只生成 cancelled journal，不把用户取消冒充正式取消探针", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0005"
    );
    const controller = new AbortController();
    controller.abort();
    const invoker = createSuccessfulInvoker(manifest, []);

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      signal: controller.signal
    });

    expect(journal.status).toBe("cancelled");
    expect(journal.trials).toEqual([]);
    expect(invoker.cancelJob).not.toHaveBeenCalled();
  });

  it("预检收到取消信号后停止调度文件且不启动原生 job", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-preflight-abort"
    );
    const controller = new AbortController();
    const invoker = createSuccessfulInvoker(manifest, []);
    const baseProbe = createProbe(manifest);
    const probe = vi.fn(async (request: { path: string }) => {
      const result = await baseProbe(request);
      controller.abort();
      return result;
    });

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe, concurrency: 1 },
      signal: controller.signal
    });

    expect(journal.status).toBe("cancelled");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(invoker.startJob).not.toHaveBeenCalled();
    expect(journal.terminalSessionStatus).toBe("released");
  });

  it("measured case 终态后收到取消时不得再启动下一个 job", async () => {
    const manifest = createManifest(false);
    manifest.cases.push({
      ...structuredClone(manifest.cases[0]),
      id: "private-case-2",
      title: "私有关系 2"
    });
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-case-abort"
    );
    const controller = new AbortController();
    const invoker = createSuccessfulInvoker(manifest, []);
    const baseGet = invoker.getJob;
    invoker.getJob = vi.fn(async (sessionId: string, jobId: string) => {
      const snapshot = await baseGet(sessionId, jobId);
      controller.abort();
      return snapshot;
    });

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      signal: controller.signal,
      wait: () => Promise.resolve(),
      now: createClock()
    });

    expect(journal.status).toBe("cancelled");
    expect(invoker.startJob).toHaveBeenCalledTimes(1);
    expect(journal.trials).toHaveLength(1);
    expect(journal.trials[0]).toMatchObject({ kind: "run", run: { status: "cancelled" } });
  });

  it("用户在协议化取消探针执行中取消时丢弃该探针并拒绝 completed", async () => {
    const manifest = createManifest(false);
    const plan = createEngineeringRealMediaPerformancePlan(
      manifest,
      "performance-plan-0006"
    );
    const controller = new AbortController();
    const base = createSuccessfulInvoker(manifest, []);
    const baseCancel = base.cancelJob;
    const invoker: AlignmentBenchmarkInvoker = {
      ...base,
      cancelJob: vi.fn(async (sessionId: string, jobId: string) => {
        const snapshot = await baseCancel(sessionId, jobId);
        controller.abort();
        return snapshot;
      })
    };

    const journal = await collectRealMediaPerformanceEvidence(manifest, plan, {
      benchmarkInvoker: invoker,
      preflightOptions: { probe: createProbe(manifest) },
      signal: controller.signal,
      wait: () => Promise.resolve(),
      now: createClock()
    });

    expect(journal.status).toBe("cancelled");
    expect(journal.issueCodes).toContain("user-cancelled");
    expect(journal.trials.filter((trial) => trial.kind === "cancellation")).toEqual([]);
    expect(journal.terminalSessionStatus).toBe("released");
  });
});

function createSuccessfulInvoker(
  manifest: RealMediaBenchmarkManifest,
  events: string[]
): AlignmentBenchmarkInvoker {
  let generation = 0;
  let jobSequence = 0;
  let session = createSession();
  const cancelledJobs = new Set<string>();
  const terminalJobs = new Map<string, AlignmentBenchmarkJobSnapshot>();
  const invoker: AlignmentBenchmarkInvoker = {
    begin: vi.fn((request: AlignmentBenchmarkSessionRequest) => {
      events.push("begin");
      const parsed = JSON.parse(request.runManifestCanonicalJson) as { cases: unknown[] };
      session = createSession(request.workloadDigest, parsed.cases.length);
      return Promise.resolve(session);
    }),
    getActive: vi.fn(() => Promise.resolve(session)),
    resetCaches: vi.fn(
      (sessionId: string): Promise<AlignmentBenchmarkCacheResetReceipt> => {
      generation += 1;
      events.push(`reset:${generation}`);
      return Promise.resolve({
        schemaVersion: 2 as const,
        sessionId,
        resetTickNs: String(generation * 1_000),
        previousGeneration: generation - 1,
        cacheGeneration: generation,
        before: createCacheCounts(generation === 1 ? 0 : 1),
        after: createCacheCounts(0),
        allCachesEmpty: true
      });
      }
    ),
    startJob: vi.fn(
      (sessionId: string, _request: NormalizedTauriAudioAlignmentRequest) => {
      void _request;
      jobSequence += 1;
      events.push(`start:${jobSequence}`);
      return Promise.resolve(
        createJobSnapshot(
          sessionId,
          jobSequence,
          jobSequence === 4 ? "extracting-source" : "validating",
          "running",
          generation,
          null
        )
      );
      }
    ),
    getJob: vi.fn((sessionId: string, jobId: string) => {
      const sequence = Number(jobId.split("-").at(-1));
      events.push(`get:${sequence}`);
      if (cancelledJobs.has(jobId)) {
        const snapshot = createJobSnapshot(
            sessionId,
            sequence,
            "cancelled",
            "cancelled",
            generation,
            null,
            true
          );
        terminalJobs.set(jobId, snapshot);
        return Promise.resolve(snapshot);
      }
      const snapshot = createJobSnapshot(
          sessionId,
          sequence,
          "completed",
          "completed",
          generation,
          createProposal(manifest)
        );
      terminalJobs.set(jobId, snapshot);
      return Promise.resolve(snapshot);
    }),
    cancelJob: vi.fn((sessionId: string, jobId: string) => {
      const sequence = Number(jobId.split("-").at(-1));
      events.push(`cancel:${sequence}`);
      cancelledJobs.add(jobId);
      return Promise.resolve(
        createJobSnapshot(
          sessionId,
          sequence,
          "extracting-source",
          "running",
          generation,
          null,
          true
        )
      );
    }),
    finish: vi.fn((sessionId: string): Promise<AlignmentBenchmarkSessionSnapshot> => {
      events.push("finish");
      return Promise.resolve({
        ...session,
        sessionId,
        status: "released" as const,
        cacheGeneration: generation,
        jobMemoryReceipt: createJobMemoryReceipt(
          session.environment.workloadStorage,
          sessionId,
          [...terminalJobs.values()]
        ),
        terminalCleanupReceipt: createTerminalCleanupReceipt(
          session.environment.workloadStorage,
          sessionId,
          generation,
          [...terminalJobs.values()]
        )
      });
    })
  };
  return invoker;
}

function createSession(
  workloadDigest: `sha256:${string}` = `sha256:${"d".repeat(64)}`,
  caseCount = 1
): AlignmentBenchmarkSessionSnapshot {
  return {
    schemaVersion: 2,
    sessionId: "benchmark-session-1",
    status: "active",
    sessionOriginTickNs: "0",
    cacheGeneration: 0,
    memoryScope: "application-process-tree",
    memorySampleIntervalMs: 20,
    environment: {
      schemaVersion: 2,
      collectorVersion: "windows-toolhelp-working-set-v1",
      measurementStatus: "complete",
      issues: [],
      operatingSystem: "windows",
      operatingSystemVersion: "11",
      architecture: "x86_64",
      cpuModel: "4-core test CPU",
      physicalCoreCount: 4,
      logicalCoreCount: 8,
      totalMemoryBytes: 16_000_000_000,
      storageScope: "workload-media-volumes",
      storageKind: "fixed-local",
      workloadStorage: createWorkloadStorageReceipt(workloadDigest, caseCount),
      powerProfile: "balanced",
      ffmpeg: { version: "ffmpeg 7", binaryDigest: `sha256:${"a".repeat(64)}` },
      ffprobe: { version: "ffprobe 7", binaryDigest: `sha256:${"b".repeat(64)}` }
    },
    activeJobId: null,
    cleanupIssue: null,
    jobMemoryReceipt: null,
    terminalCleanupReceipt: null
  };
}

function createWorkloadStorageReceipt(
  workloadDigest: `sha256:${string}`,
  caseCount: number
) {
  const bindings = Array.from({ length: caseCount * 2 }, (_, bindingOrdinal) => ({
    bindingOrdinal,
    caseOrdinal: Math.floor(bindingOrdinal / 2),
    side: bindingOrdinal % 2 === 0 ? ("source" as const) : ("target" as const),
    volumeOrdinal: 0
  }));
  const withoutReceiptDigest = {
    schemaVersion: 2 as const,
    runManifestDigest: workloadDigest,
    workloadDigest,
    bindingCount: bindings.length,
    uniqueMediaCount: bindings.length,
    volumeCount: 1,
    mediaSetDigest: `sha256:${"c".repeat(64)}` as const,
    bindings,
    volumes: [
      {
        volumeOrdinal: 0,
        bindingCount: bindings.length,
        driveType: "fixed" as const,
        seekPenalty: "none" as const,
        measurementStatus: "complete" as const
      }
    ]
  };
  return {
    ...withoutReceiptDigest,
    receiptDigest: computeC137CanonicalDigest(withoutReceiptDigest)
  };
}

function createTerminalCleanupReceipt(
  storage: AlignmentBenchmarkWorkloadStorageReceipt,
  sessionId: string,
  finalCacheGeneration: number,
  snapshots: AlignmentBenchmarkJobSnapshot[]
): NonNullable<AlignmentBenchmarkSessionSnapshot["terminalCleanupReceipt"]> {
  const jobs = snapshots
    .map((snapshot) => {
      if (
        (snapshot.status !== "completed" &&
          snapshot.status !== "failed" &&
          snapshot.status !== "cancelled") ||
        snapshot.telemetry.endTickNs === null
      ) {
        throw new Error("terminal cleanup 测试夹具含非终态 job");
      }
      return {
        jobId: snapshot.jobId,
        status: snapshot.status,
        endTickNs: snapshot.telemetry.endTickNs,
        processTreeEmptyAtTerminal: true as const,
        residualProcessCount: 0 as const
      };
    })
    .sort((left, right) => left.jobId.localeCompare(right.jobId));
  const terminalTick = jobs.reduce(
    (maximum, job) => (BigInt(job.endTickNs) > maximum ? BigInt(job.endTickNs) : maximum),
    0n
  );
  const withoutReceiptDigest = {
    schemaVersion: 1 as const,
    sessionId,
    runManifestDigest: storage.runManifestDigest,
    workloadDigest: storage.workloadDigest,
    workloadStorageReceiptDigest: storage.receiptDigest,
    terminalTickNs: (terminalTick + 1n).toString(),
    finalCacheGeneration,
    jobCount: jobs.length,
    completedJobCount: jobs.filter((job) => job.status === "completed").length,
    failedJobCount: jobs.filter((job) => job.status === "failed").length,
    cancelledJobCount: jobs.filter((job) => job.status === "cancelled").length,
    jobInventoryDigest: computeC137CanonicalDigest({
      domain: "c137-performance-terminal-job-inventory-v1",
      jobs
    }),
    allJobsTerminal: true as const,
    processTreeEmpty: true as const,
    residualProcessCount: 0 as const,
    supervisionCleanupStatus: "clean" as const,
    toolchainReverified: true as const,
    workloadReverified: true as const,
    featureCachesEmpty: true as const
  };
  return {
    ...withoutReceiptDigest,
    receiptDigest: computeC137CanonicalDigest({
      domain: "c137-performance-terminal-cleanup-receipt-v1",
      receipt: withoutReceiptDigest
    })
  };
}

function createJobMemoryReceipt(
  storage: AlignmentBenchmarkWorkloadStorageReceipt,
  sessionId: string,
  snapshots: AlignmentBenchmarkJobSnapshot[]
): NonNullable<AlignmentBenchmarkSessionSnapshot["jobMemoryReceipt"]> {
  const jobs = snapshots
    .map((snapshot) => {
      const memory = snapshot.telemetry.memory;
      if (
        memory.sampler !== "windows-job-object-working-set-v1" ||
        memory.sampleCount <= 0 ||
        memory.failedSampleCount !== 0 ||
        memory.peakProcessTreeRssBytes === null ||
        !memory.coverageComplete ||
        !memory.processTreeEmptyAtTerminal ||
        memory.residualProcessCount !== 0
      ) {
        throw new Error("Job memory receipt 测试夹具含不完整 telemetry");
      }
      return {
        jobId: snapshot.jobId,
        sampleIntervalMs: memory.sampleIntervalMs,
        sampleCount: memory.sampleCount,
        failedSampleCount: 0 as const,
        maximumSampleGapMicros: String(Math.round(memory.maximumSampleGapMs * 1_000)),
        peakJobHierarchyRssBytes: memory.peakProcessTreeRssBytes,
        coverageComplete: true as const,
        processTreeEmptyAtTerminal: true as const,
        residualProcessCount: 0 as const
      };
    })
    .sort((left, right) => (left.jobId < right.jobId ? -1 : left.jobId > right.jobId ? 1 : 0));
  const withoutReceiptDigest = {
    schemaVersion: 1 as const,
    sessionId,
    runManifestDigest: storage.runManifestDigest,
    workloadDigest: storage.workloadDigest,
    workloadStorageReceiptDigest: storage.receiptDigest,
    sampler: "windows-job-object-working-set-v1" as const,
    memoryScope: "application-process-tree" as const,
    jobCount: jobs.length,
    totalSampleCount: jobs.reduce((total, job) => total + job.sampleCount, 0),
    totalFailedSampleCount: 0 as const,
    maximumSampleGapMicros: jobs.reduce(
      (maximum, job) =>
        BigInt(job.maximumSampleGapMicros) > BigInt(maximum)
          ? job.maximumSampleGapMicros
          : maximum,
      "0"
    ),
    peakJobHierarchyRssBytes: jobs.reduce(
      (maximum, job) => Math.max(maximum, job.peakJobHierarchyRssBytes),
      0
    ),
    jobMemoryInventoryDigest: computeC137CanonicalDigest({
      domain: "c137-performance-job-memory-inventory-v1",
      jobs
    }),
    allJobsCoverageComplete: true as const,
    allSamplesJobBound: true as const,
    allTerminalProcessTreesEmpty: true as const
  };
  return {
    ...withoutReceiptDigest,
    receiptDigest: computeC137CanonicalDigest({
      domain: "c137-performance-job-memory-receipt-v1",
      receipt: withoutReceiptDigest
    })
  };
}

function createJobSnapshot(
  sessionId: string,
  sequence: number,
  stageKey: AlignmentBenchmarkJobSnapshot["stageKey"],
  status: AlignmentBenchmarkJobSnapshot["status"],
  generation: number,
  proposal: AlignmentProposal | null,
  cancellationRequested = false
): AlignmentBenchmarkJobSnapshot {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const startTick = sequence * 1_000_000_000;
  const endTick = startTick + 500_000_000;
  return {
    schemaVersion: 2,
    sessionId,
    jobId: `benchmark-job-${sequence}`,
    status,
    stageKey,
    stageLabel: stageKey,
    proposal,
    errorCode: status === "failed" ? "test-failed" : null,
    telemetry: {
      schemaVersion: 2,
      clock: "rust-std-instant-session-relative-v1",
      startTickNs: String(startTick),
      endTickNs: terminal ? String(endTick) : null,
      elapsedMs: terminal ? 500 : 10,
      stages: terminal ? createStageTimings(startTick, status) : [],
      cache: {
        generation,
        before: createCacheCounts(sequence === 1 || sequence === 4 ? 0 : 1),
        after: createCacheCounts(1),
        audioFeatures: createCacheCounter(sequence === 1 ? 0 : 2, sequence === 1 ? 2 : 0),
        landmarks: createCacheCounter(sequence === 1 ? 0 : 2, sequence === 1 ? 2 : 0),
        visualFeatures: createCacheCounter(sequence === 1 ? 0 : 2, sequence === 1 ? 2 : 0)
      },
      memory: {
        scope: "application-process-tree",
        sampler: "windows-job-object-working-set-v1",
        sampleIntervalMs: 20,
        sampleCount: terminal ? 25 : 1,
        failedSampleCount: 0,
        maximumSampleGapMs: 21,
        peakProcessTreeRssBytes: 512_000_000,
        coverageComplete: terminal,
        processTreeEmptyAtTerminal: terminal,
        residualProcessCount: terminal ? 0 : 1
      },
      cancellation: cancellationRequested
        ? {
            requestTickNs: String(startTick + 25_000_000),
            terminalTickNs: terminal ? String(endTick) : "",
            latencyMs: terminal ? 475 : 0,
            commandAccepted: true
          }
        : null
    }
  };
}

function createStageTimings(
  startTick: number,
  terminalStatus: AlignmentBenchmarkJobSnapshot["status"]
) {
  const keys = [
    "validating",
    "extracting-complete",
    "extracting-source",
    "matching",
    "fitting",
    "refining",
    "reporting"
  ] as const;
  const activeKeys = terminalStatus === "cancelled" ? keys.slice(0, 3) : keys;
  const terminalTick = startTick + 500_000_000;
  return activeKeys.map((stageKey, index) => ({
    stageKey,
    occurrence: 1,
    startTickNs: String(startTick + index * 10_000_000),
    endTickNs: String(
      index === activeKeys.length - 1
        ? terminalTick
        : startTick + (index + 1) * 10_000_000
    ),
    elapsedMs:
      index === activeKeys.length - 1
        ? (terminalTick - (startTick + index * 10_000_000)) / 1_000_000
        : 10,
    status:
      terminalStatus === "cancelled" && stageKey === "extracting-source"
        ? ("cancelled" as const)
        : ("completed" as const)
  }));
}

function createCacheCounter(hits: number, misses: number) {
  return { hits, misses, writes: misses, evictions: 0 };
}

function createCacheCounts(value: number): AlignmentBenchmarkCacheCounts {
  return {
    audioFeatureEntries: value,
    landmarkEntries: value,
    visualFeatureEntries: value
  };
}

function createClock(): () => number {
  let current = 0;
  return () => {
    current += 10;
    return current;
  };
}

function createManifest(example: boolean): RealMediaBenchmarkManifest {
  const gold = createGold();
  const source = createMedia("source", "1", 1, 2, !example);
  const target = createMedia("target", "2", 4, 3, !example);
  return {
    schemaVersion: 2,
    id: "performance-private-manifest",
    name: "性能测试清单",
    datasetVersion: "private-dataset-v1",
    description: "测试性能调度。",
    isExample: example,
    licenseNotes: ["测试。"],
    cases: [
      {
        id: "private-case-1",
        title: "私有关系",
        mediaKind: example ? "placeholder" : "real",
        split: "frozen-test",
        scenarios: ["global-offset"],
        source,
        target,
        boundaryToleranceMs: 100,
        versionNotes: ["固定。"],
        licenseNotes: ["合法测试。"],
        independentAnnotations: example
          ? []
          : [
              { reviewerId: "reviewer-a", gold: structuredClone(gold) },
              { reviewerId: "reviewer-b", gold: structuredClone(gold) }
            ],
        adjudication: example
          ? null
          : { status: "not-needed", adjudicatorId: null, note: "一致。" },
        gold
      }
    ]
  };
}

function createGold(): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 0,
    targetEndMs: 10_000,
    matchedAnchors: Array.from({ length: 5 }, (_, index) => ({
      id: `anchor-${index}`,
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
  digit: string,
  audioStreamIndex: number,
  videoStreamIndex: number,
  real: boolean
) {
  return {
    path: `C:\\private-performance\\${name}.mkv`,
    audioStreamIndex,
    videoStreamIndex,
    contentIdentity: real
      ? {
          algorithm: "sha256-full-file-v2" as const,
          sizeBytes: 1_000 + Number(digit),
          digest: digit.repeat(64)
        }
      : null,
    versionNote: "固定媒体。",
    licenseNote: "合法测试。"
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
    if (!media?.contentIdentity) throw new Error("missing test media");
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

function createProposal(manifest: RealMediaBenchmarkManifest): AlignmentProposal {
  const benchmarkCase = manifest.cases[0];
  const sourceIdentity = benchmarkCase.source.contentIdentity;
  const targetIdentity = benchmarkCase.target.contentIdentity;
  if (!sourceIdentity || !targetIdentity) throw new Error("real identity required");
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.9,
    diagnostics: [`private path: ${benchmarkCase.source.path}`],
    timeMap: {
      sourceStartMs: 0,
      sourceEndMs: 10_000,
      targetStartMs: 0,
      targetEndMs: 10_000,
      spans: [
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 10_000,
          targetStartMs: 0,
          targetEndMs: 10_000
        }
      ],
      quality: {
        level: "review",
        probability: null,
        metricSource: "measured",
        coverage: 1,
        p50ResidualMs: 10,
        p95ResidualMs: 20,
        maxResidualMs: 30,
        boundaryUncertaintyMs: 50,
        alternativeMargin: 0.5,
        anchorCount: 10,
        heldOutAnchorCount: 2,
        reasons: []
      },
      evidence: {
        types: ["audio", "visual"],
        audioAnchorCount: 10,
        visualAnchorCount: 5,
        heldOutAnchorCount: 2,
        top1Top2Margin: 0.5,
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
      parametersHash: "fnv1a64:0123456789abcdef"
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
