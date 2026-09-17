import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeC137CanonicalDigest } from "../../domain/alignment/c137Acceptance";
import { sha256Hex } from "../../domain/shared/sha256";
import {
  beginAlignmentBenchmarkSession,
  cancelAlignmentBenchmarkJob,
  createAlignmentBenchmarkRunManifestCanonicalJson,
  finishAlignmentBenchmarkSession,
  getActiveAlignmentBenchmarkSession,
  getAlignmentBenchmarkJob,
  isAlignmentBenchmarkJobFinished,
  resetAlignmentBenchmarkCaches,
  startAlignmentBenchmarkJob,
  type AlignmentBenchmarkCacheResetReceipt,
  type AlignmentBenchmarkInvoker,
  type AlignmentBenchmarkJobSnapshot,
  type AlignmentBenchmarkSessionRequest,
  type AlignmentBenchmarkSessionSnapshot,
  type AlignmentBenchmarkWorkloadStorageReceipt
} from "./tauriAlignmentBenchmark";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

describe("C137 原生性能采集 bridge", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("调用独立 session/cache/job 命令并规范化显式流", async () => {
    const session = createSession();
    const job = createJob();
    tauriMocks.invoke.mockImplementation((command: string) => {
      if (command === "begin_alignment_benchmark_session") return Promise.resolve(session);
      if (command === "get_active_alignment_benchmark_session") return Promise.resolve(session);
      if (command === "reset_alignment_benchmark_caches") {
        return Promise.resolve({
          schemaVersion: 2,
          sessionId: session.sessionId,
          resetTickNs: "10",
          previousGeneration: 0,
          cacheGeneration: 1,
          before: createCacheCounts(2),
          after: createCacheCounts(0),
          allCachesEmpty: true
        });
      }
      if (
        command === "start_alignment_benchmark_job" ||
        command === "get_alignment_benchmark_job" ||
        command === "cancel_alignment_benchmark_job"
      ) {
        return Promise.resolve(job);
      }
      if (command === "finish_alignment_benchmark_session") {
        return Promise.resolve(createReleasedSession(session));
      }
      throw new Error(`unexpected ${command}`);
    });

    const beginRequest = createSessionRequest({
      ffmpegPath: " C:\\tools\\ffmpeg.exe ",
      ffprobePath: " "
    });
    await beginAlignmentBenchmarkSession(beginRequest);
    await getActiveAlignmentBenchmarkSession();
    await resetAlignmentBenchmarkCaches(session.sessionId);
    await startAlignmentBenchmarkJob(session.sessionId, {
      completePath: "D:\\private\\target.mkv",
      sourcePath: "D:\\private\\source.mkv",
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      completeAudioStreamIndex: 2,
      sourceAudioStreamIndex: 3,
      localizationMode: true
    });
    await getAlignmentBenchmarkJob(session.sessionId, job.jobId);
    await cancelAlignmentBenchmarkJob(session.sessionId, job.jobId);
    await finishAlignmentBenchmarkSession(session.sessionId);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("begin_alignment_benchmark_session", {
      request: {
        schemaVersion: 2,
        ffmpegPath: "C:\\tools\\ffmpeg.exe",
        ffprobePath: null,
        memorySampleIntervalMs: 20,
        runManifestCanonicalJson: beginRequest.runManifestCanonicalJson,
        runManifestDigest: beginRequest.runManifestDigest,
        workloadDigest: beginRequest.workloadDigest
      }
    });
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_alignment_benchmark_job", {
      sessionId: session.sessionId,
      request: {
        completePath: "D:\\private\\target.mkv",
        sourcePath: "D:\\private\\source.mkv",
        ffmpegPath: "C:\\tools\\ffmpeg.exe",
        localizationMode: true,
        completeAudioStreamIndex: 2,
        sourceAudioStreamIndex: 3,
        completeVideoStreamIndex: null,
        sourceVideoStreamIndex: null,
        ffprobePath: null,
        spectralBackend: "auto"
      }
    });
  });

  it("浏览器不能调用默认原生采集器，但注入 invoker 仍可单测", async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    await expect(beginAlignmentBenchmarkSession(createSessionRequest())).rejects.toThrow(
      "只能在 Tauri 桌面端"
    );

    const injected = createInvoker();
    await expect(
      beginAlignmentBenchmarkSession(createSessionRequest(), injected)
    ).resolves.toMatchObject({ status: "active" });
  });

  it.each([0, 9, 1_001, 20.5, Number.NaN])("拒绝非法采样间隔 %s", async (interval) => {
    await expect(
      beginAlignmentBenchmarkSession(
        createSessionRequest({ memorySampleIntervalMs: interval }),
        createInvoker()
      )
    ).rejects.toThrow("采样间隔");
  });

  it("begin 严格拒绝非 canonical manifest、摘要篡改与额外路径投影", async () => {
    const base = createSessionRequest();
    const begin = vi.fn((request: AlignmentBenchmarkSessionRequest) =>
      Promise.resolve(createSession(request.workloadDigest))
    );
    const invoker = createInvoker({ begin });
    const parsed = JSON.parse(base.runManifestCanonicalJson) as {
      cases: Array<{ source: Record<string, unknown> }>;
    };
    parsed.cases[0].source.volumeGuid = "\\\\?\\Volume{private-guid}\\";
    const manifestWithForbiddenField = JSON.stringify(parsed);
    const forbiddenDigest = `sha256:${sha256Hex(manifestWithForbiddenField)}` as const;
    const attacks: AlignmentBenchmarkSessionRequest[] = [
      { ...base, runManifestCanonicalJson: `${base.runManifestCanonicalJson}\n` },
      { ...base, runManifestDigest: `sha256:${"f".repeat(64)}` },
      { ...base, workloadDigest: `sha256:${"e".repeat(64)}` },
      unsafeSessionRequest({ ...base, completePath: "D:\\private\\extra.mkv" }),
      {
        ...base,
        runManifestCanonicalJson: manifestWithForbiddenField,
        runManifestDigest: forbiddenDigest,
        workloadDigest: forbiddenDigest
      }
    ];

    for (const attack of attacks) {
      await expect(beginAlignmentBenchmarkSession(attack, invoker)).rejects.toThrow();
    }
    expect(begin).not.toHaveBeenCalled();
  });

  it("workloadStorage 递归拒绝缺失/重复 binding、路径/GUID 字段与错误 receiptDigest", async () => {
    const session = createSession();
    const receipt = session.environment.workloadStorage;
    const attacks: unknown[] = [
      {
        ...session,
        environment: {
          ...session.environment,
          workloadStorage: resignWorkloadStorageReceipt({
            ...receipt,
            bindings: receipt.bindings.slice(0, 1)
          })
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          workloadStorage: resignWorkloadStorageReceipt({
            ...receipt,
            bindings: [receipt.bindings[0], receipt.bindings[0]]
          })
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          workloadStorage: {
            ...receipt,
            bindings: [
              { ...receipt.bindings[0], path: "D:\\private\\leak.mkv" },
              receipt.bindings[1]
            ]
          }
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          workloadStorage: {
            ...receipt,
            volumes: [{ ...receipt.volumes[0], volumeGuid: "private-guid" }]
          }
        }
      },
      {
        ...session,
        environment: { ...session.environment, path: "D:\\private\\leak.mkv" }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          workloadStorage: {
            ...receipt,
            receiptDigest: `sha256:${"0".repeat(64)}`
          }
        }
      }
    ];

    for (const response of attacks) {
      await expect(
        getActiveAlignmentBenchmarkSession(
          createInvoker({
            getActive: () =>
              Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>(response))
          })
        )
      ).rejects.toThrow("详细系统信息未进入可分享错误");
    }
  });

  it("workloadStorage 回执只含 path-free ordinal，不回显媒体路径、GUID 或单媒体 SHA", async () => {
    const session = await getActiveAlignmentBenchmarkSession(createInvoker());
    const serialized = JSON.stringify(session?.environment.workloadStorage);
    expect(serialized).not.toContain("D:\\\\private");
    expect(serialized).not.toContain("Volume{");
    expect(serialized).not.toContain("1".repeat(64));
    expect(serialized).not.toContain("2".repeat(64));
    expect(serialized).toContain('"bindingOrdinal":0');
  });

  it("原生错误不会把媒体路径或工具输出带进可分享错误", async () => {
    const invoker = createInvoker({
      startJob: () =>
        Promise.reject(
          new Error("D:\\private\\episode.mkv: ffmpeg stderr contains user secret")
        )
    });

    const error = await startAlignmentBenchmarkJob(
      "benchmark-session-1",
      {
        completePath: "D:\\private\\target.mkv",
        sourcePath: "D:\\private\\episode.mkv",
        ffmpegPath: null
      },
      invoker
    ).catch((reason: unknown) => String(reason));

    expect(error).toContain("媒体路径和工具输出未进入错误");
    expect(error).not.toContain("episode.mkv");
    expect(error).not.toContain("user secret");
  });

  it("begin 已建立 lease 但响应校验失败时从 active 会话恢复并释放", async () => {
    const session = createSession();
    const secret = "D:\\private\\invalid-begin-response.mkv";
    const getActive = vi.fn(() =>
      Promise.resolve(
        unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
          sessionId: session.sessionId,
          ignoredSecret: secret
        })
      )
    );
    const finish = vi.fn(() =>
      Promise.resolve(
        unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
          sessionId: session.sessionId,
          status: "released"
        })
      )
    );
    const invoker = createInvoker({
      begin: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            ...session,
            schemaVersion: 1,
            leakedDetail: secret
          })
        ),
      getActive,
      finish
    });

    const error = await beginAlignmentBenchmarkSession(createSessionRequest(), invoker).catch(
      (reason: unknown) => String(reason)
    );

    expect(getActive).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(session.sessionId);
    expect(error).toContain("详细系统信息未进入可分享错误");
    expect(error).not.toContain(secret);
  });

  it("start 已建立 job 但响应校验失败时从 active job 取消并有界轮询终态", async () => {
    const session = createSession();
    const job = createJob();
    const secret = "D:\\private\\invalid-start-response.mkv";
    const getActive = vi.fn(() =>
      Promise.resolve(
        unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
          sessionId: session.sessionId,
          activeJobId: job.jobId,
          ignoredSecret: secret
        })
      )
    );
    const cancelJob = vi.fn(() =>
      Promise.resolve(
        unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
          sessionId: session.sessionId,
          jobId: job.jobId,
          status: "running"
        })
      )
    );
    const getJob = vi.fn(() =>
      Promise.resolve(
        unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
          sessionId: session.sessionId,
          jobId: job.jobId,
          status: "cancelled"
        })
      )
    );
    const invoker = createInvoker({
      startJob: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
            ...job,
            schemaVersion: 1,
            leakedDetail: secret
          })
        ),
      getActive,
      cancelJob,
      getJob
    });

    const error = await startAlignmentBenchmarkJob(
      session.sessionId,
      createAlignmentRequest(),
      invoker
    ).catch((reason: unknown) => String(reason));

    expect(getActive).toHaveBeenCalledOnce();
    expect(cancelJob).toHaveBeenCalledWith(session.sessionId, job.jobId);
    expect(getJob).toHaveBeenCalledWith(session.sessionId, job.jobId);
    expect(error).toContain("媒体路径和工具输出未进入错误");
    expect(error).not.toContain(secret);
  });

  it("begin 无效响应与 active 会话 ID 不同时绝不结束其他会话，并要求重启", async () => {
    const session = createSession();
    const finish = vi.fn(createInvoker().finish);
    const invoker = createInvoker({
      begin: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            ...session,
            schemaVersion: 1
          })
        ),
      getActive: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            sessionId: "benchmark-session-other"
          })
        ),
      finish
    });

    await expect(
      beginAlignmentBenchmarkSession(createSessionRequest(), invoker)
    ).rejects.toThrow("请重启应用后再运行");
    expect(finish).not.toHaveBeenCalled();
  });

  it("begin 回收 finish 传输失败后复查 active；原会话仍在时明确要求重启", async () => {
    const session = createSession();
    const getActive = vi.fn(() =>
      Promise.resolve(
        unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
          sessionId: session.sessionId
        })
      )
    );
    const finish = vi.fn(() => Promise.reject(new Error("private native transport detail")));
    const invoker = createInvoker({
      begin: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            ...session,
            schemaVersion: 1
          })
        ),
      getActive,
      finish
    });

    const error = await beginAlignmentBenchmarkSession(createSessionRequest(), invoker).catch(
      (reason: unknown) => String(reason)
    );

    expect(getActive).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledWith(session.sessionId);
    expect(error).toContain("请重启应用后再运行");
    expect(error).not.toContain("private native transport detail");
  });

  it("begin 回收 finish 传输失败但复查已无 active 时视为已释放", async () => {
    const session = createSession();
    const getActive = vi
      .fn()
      .mockResolvedValueOnce(
        unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
          sessionId: session.sessionId
        })
      )
      .mockResolvedValueOnce(null);
    const invoker = createInvoker({
      begin: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            ...session,
            schemaVersion: 1
          })
        ),
      getActive,
      finish: () => Promise.reject(new Error("transport failed after release"))
    });

    const error = await beginAlignmentBenchmarkSession(createSessionRequest(), invoker).catch(
      (reason: unknown) => String(reason)
    );

    expect(getActive).toHaveBeenCalledTimes(2);
    expect(error).not.toContain("请重启应用后再运行");
    expect(error).not.toContain("transport failed after release");
  });

  it.each([
    {
      name: "坏响应 session ID 不同",
      responseSessionId: "benchmark-session-other",
      activeJobId: "benchmark-job-1"
    },
    {
      name: "active job ID 不同",
      responseSessionId: "benchmark-session-1",
      activeJobId: "benchmark-job-other"
    }
  ])(
    "start 无效响应遇到$name时不误取消并要求重启",
    async ({ responseSessionId, activeJobId }) => {
      const session = createSession();
      const job = createJob();
      const cancelJob = vi.fn(createInvoker().cancelJob);
      const getActive = vi.fn(() =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            sessionId: session.sessionId,
            activeJobId
          })
        )
      );
      const invoker = createInvoker({
        startJob: () =>
          Promise.resolve(
            unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
              ...job,
              schemaVersion: 1,
              sessionId: responseSessionId
            })
          ),
        getActive,
        cancelJob
      });

      await expect(
        startAlignmentBenchmarkJob(session.sessionId, createAlignmentRequest(), invoker)
      ).rejects.toThrow("请重启应用后再运行");
      expect(cancelJob).not.toHaveBeenCalled();
      if (responseSessionId !== session.sessionId) expect(getActive).not.toHaveBeenCalled();
    }
  );

  it("start 回收只把 session/job ID 同时匹配的终态算作成功", async () => {
    const session = createSession();
    const job = createJob();
    const invoker = createInvoker({
      startJob: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
            ...job,
            schemaVersion: 1
          })
        ),
      getActive: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
            sessionId: session.sessionId,
            activeJobId: job.jobId
          })
        ),
      cancelJob: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
            sessionId: session.sessionId,
            jobId: job.jobId,
            status: "running"
          })
        ),
      getJob: () =>
        Promise.resolve(
          unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
            sessionId: session.sessionId,
            jobId: "benchmark-job-other",
            status: "cancelled"
          })
        )
    });

    await expect(
      startAlignmentBenchmarkJob(session.sessionId, createAlignmentRequest(), invoker)
    ).rejects.toThrow("请重启应用后再运行");
  });

  it("start 回收轮询耗尽不会被当作成功", async () => {
    vi.useFakeTimers();
    try {
      const session = createSession();
      const job = createJob();
      const pending = unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
        sessionId: session.sessionId,
        jobId: job.jobId,
        status: "running"
      });
      const getJob = vi.fn(() => Promise.resolve(pending));
      const invoker = createInvoker({
        startJob: () =>
          Promise.resolve(
            unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>({
              ...job,
              schemaVersion: 1
            })
          ),
        getActive: () =>
          Promise.resolve(
            unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>({
              sessionId: session.sessionId,
              activeJobId: job.jobId
            })
          ),
        cancelJob: () => Promise.resolve(pending),
        getJob
      });

      const result = startAlignmentBenchmarkJob(
        session.sessionId,
        createAlignmentRequest(),
        invoker
      ).catch((reason: unknown) => String(reason));
      await vi.runAllTimersAsync();

      await expect(result).resolves.toContain("请重启应用后再运行");
      expect(getJob).toHaveBeenCalledTimes(600);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finish 只接受 released 或 cleanup-blocked，作业终态判断独立", async () => {
    const invoker = createInvoker({
      finish: () => Promise.resolve(createSession())
    });
    await expect(
      finishAlignmentBenchmarkSession("benchmark-session-1", invoker)
    ).rejects.toThrow("未得到可信终态");
    expect(isAlignmentBenchmarkJobFinished("running")).toBe(false);
    expect(isAlignmentBenchmarkJobFinished("completed")).toBe(true);
    expect(isAlignmentBenchmarkJobFinished("cancelled")).toBe(true);
  });

  it.each([
    ["missing Job memory receipt", (released: AlignmentBenchmarkSessionSnapshot) => ({
      ...released,
      jobMemoryReceipt: null
    })],
    ["stale Job memory digest", (released: AlignmentBenchmarkSessionSnapshot) => ({
      ...released,
      jobMemoryReceipt: released.jobMemoryReceipt === null
        ? null
        : { ...released.jobMemoryReceipt, receiptDigest: `sha256:${"8".repeat(64)}` }
    })],
    ["wrong Job memory session binding", (released: AlignmentBenchmarkSessionSnapshot) => ({
      ...released,
      jobMemoryReceipt: released.jobMemoryReceipt === null
        ? null
        : { ...released.jobMemoryReceipt, sessionId: "benchmark-session-forged" }
    })],
    ["missing receipt", (released: AlignmentBenchmarkSessionSnapshot) => ({
      ...released,
      terminalCleanupReceipt: null
    })],
    ["stale receipt digest", (released: AlignmentBenchmarkSessionSnapshot) => ({
      ...released,
      terminalCleanupReceipt: released.terminalCleanupReceipt === null
        ? null
        : { ...released.terminalCleanupReceipt, receiptDigest: `sha256:${"9".repeat(64)}` }
    })],
    ["wrong session binding", (released: AlignmentBenchmarkSessionSnapshot) => ({
      ...released,
      terminalCleanupReceipt: released.terminalCleanupReceipt === null
        ? null
        : { ...released.terminalCleanupReceipt, sessionId: "benchmark-session-forged" }
    })]
  ] as const)("released session fail-closed rejects %s", async (_label, mutate) => {
    const session = createSession();
    const response = mutate(createReleasedSession(session));
    const invoker = createInvoker({
      finish: () => Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>(response))
    });

    await expect(finishAlignmentBenchmarkSession(session.sessionId, invoker)).rejects.toThrow(
      "未得到可信终态"
    );
  });

  it("深层拒绝伪造环境、非规范 ID/tick、越界数组和不可信摘要，且错误保持去敏", async () => {
    const session = createSession();
    const secret = "D:\\private\\secret-ffmpeg.exe";
    const maliciousResponses: unknown[] = [
      { ...session, sessionId: " bad-session-id " },
      { ...session, sessionOriginTickNs: "00" },
      {
        ...session,
        environment: { ...session.environment, storageScope: "system-disk" }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          physicalCoreCount: Number.MAX_SAFE_INTEGER + 1
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          issues: Array.from({ length: 129 }, (_, index) => `issue-${index}`),
          measurementStatus: "incomplete"
        }
      },
      {
        ...session,
        environment: {
          ...session.environment,
          ffmpeg: { ...session.environment.ffmpeg, binaryDigest: secret }
        }
      }
    ];

    for (const response of maliciousResponses) {
      const error = await getActiveAlignmentBenchmarkSession(
        createInvoker({
          getActive: () =>
            Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkSessionSnapshot>(response))
        })
      ).catch((reason: unknown) => String(reason));
      expect(error).toContain("详细系统信息未进入可分享错误");
      expect(error).not.toContain(secret);
    }
  });

  it("深层拒绝伪造缓存重置回执", async () => {
    const receipt = createCacheResetReceipt();
    const maliciousResponses: unknown[] = [
      { ...receipt, resetTickNs: "01" },
      { ...receipt, cacheGeneration: receipt.previousGeneration },
      { ...receipt, allCachesEmpty: false },
      {
        ...receipt,
        after: { ...receipt.after, audioFeatureEntries: 1 }
      },
      {
        ...receipt,
        before: { ...receipt.before, landmarkEntries: Number.POSITIVE_INFINITY }
      }
    ];

    for (const response of maliciousResponses) {
      await expect(
        resetAlignmentBenchmarkCaches(
          receipt.sessionId,
          createInvoker({
            resetCaches: () =>
              Promise.resolve(
                unsafeNativeResponse<AlignmentBenchmarkCacheResetReceipt>(response)
              )
          })
        )
      ).rejects.toThrow("缓存重置失败");
    }
  });

  it("深层拒绝伪造 stage/cache/memory/proposal，并限制数组规模", async () => {
    const job = createJob();
    const stage = createStageTiming();
    const maliciousResponses: unknown[] = [
      { ...job, stageKey: "extracting-secret" },
      { ...job, proposal: [] },
      { ...job, errorCode: "D:\\private\\secret-error" },
      {
        ...job,
        telemetry: { ...job.telemetry, clock: "date-now" }
      },
      {
        ...job,
        telemetry: { ...job.telemetry, elapsedMs: Number.NaN }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          stages: Array.from({ length: 513 }, () => stage)
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          stages: [{ ...stage, occurrence: 0 }]
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          cache: {
            ...job.telemetry.cache,
            landmarks: { ...job.telemetry.cache.landmarks, hits: -1 }
          }
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          memory: { ...job.telemetry.memory, sampler: "browser-performance-memory" }
        }
      },
      {
        ...job,
        telemetry: {
          ...job.telemetry,
          memory: {
            ...job.telemetry.memory,
            maximumSampleGapMs: Number.POSITIVE_INFINITY
          }
        }
      }
    ];

    for (const response of maliciousResponses) {
      await expect(
        getAlignmentBenchmarkJob(
          job.sessionId,
          job.jobId,
          createInvoker({
            getJob: () =>
              Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>(response))
          })
        )
      ).rejects.toThrow("详细系统信息未进入可分享错误");
    }
  });

  it("取消中只接受受限空 tick sentinel，终态要求 canonical tick 与耗时自洽", async () => {
    const running = createJob();
    const pendingCancellation: AlignmentBenchmarkJobSnapshot = {
      ...running,
      telemetry: {
        ...running.telemetry,
        memory: {
          ...running.telemetry.memory,
          sampler: "windows-job-object-working-set-v1"
        },
        cancellation: {
          requestTickNs: "101",
          terminalTickNs: "",
          latencyMs: 0,
          commandAccepted: true
        }
      }
    };
    await expect(
      cancelAlignmentBenchmarkJob(
        running.sessionId,
        running.jobId,
        createInvoker({ cancelJob: () => Promise.resolve(pendingCancellation) })
      )
    ).resolves.toMatchObject({ status: "running" });

    const cancelled = createCancelledJob();
    await expect(
      cancelAlignmentBenchmarkJob(
        cancelled.sessionId,
        cancelled.jobId,
        createInvoker({ cancelJob: () => Promise.resolve(cancelled) })
      )
    ).resolves.toMatchObject({ status: "cancelled" });

    const invalidTerminalSentinel = {
      ...cancelled,
      telemetry: {
        ...cancelled.telemetry,
        cancellation: {
          ...createCancellationTelemetry(),
          terminalTickNs: "",
          latencyMs: 0
        }
      }
    };
    const invalidElapsed = {
      ...cancelled,
      telemetry: {
        ...cancelled.telemetry,
        cancellation: {
          ...createCancellationTelemetry(),
          requestTickNs: "0500000000"
        }
      }
    };
    for (const response of [invalidTerminalSentinel, invalidElapsed]) {
      await expect(
        cancelAlignmentBenchmarkJob(
          cancelled.sessionId,
          cancelled.jobId,
          createInvoker({
            cancelJob: () =>
              Promise.resolve(unsafeNativeResponse<AlignmentBenchmarkJobSnapshot>(response))
          })
        )
      ).rejects.toThrow("任务取消失败");
    }
  });

  it("所有带请求 ID 的 wrapper 都拒绝响应 ID 错配", async () => {
    const session = createSession();
    const job = createJob();
    const wrongSessionId = "benchmark-session-2";
    const wrongJobId = "benchmark-job-2";

    await expect(
      resetAlignmentBenchmarkCaches(
        session.sessionId,
        createInvoker({
          resetCaches: () =>
            Promise.resolve({ ...createCacheResetReceipt(), sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("缓存重置失败");
    await expect(
      startAlignmentBenchmarkJob(
        session.sessionId,
        createAlignmentRequest(),
        createInvoker({
          startJob: () => Promise.resolve({ ...job, sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("任务启动失败");
    await expect(
      getAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          getJob: () => Promise.resolve({ ...job, jobId: wrongJobId })
        })
      )
    ).rejects.toThrow("任务状态读取失败");
    await expect(
      getAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          getJob: () => Promise.resolve({ ...job, sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("任务状态读取失败");
    await expect(
      cancelAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          cancelJob: () => Promise.resolve({ ...job, sessionId: wrongSessionId })
        })
      )
    ).rejects.toThrow("任务取消失败");
    await expect(
      cancelAlignmentBenchmarkJob(
        session.sessionId,
        job.jobId,
        createInvoker({
          cancelJob: () => Promise.resolve({ ...job, jobId: wrongJobId })
        })
      )
    ).rejects.toThrow("任务取消失败");
    await expect(
      finishAlignmentBenchmarkSession(
        session.sessionId,
        createInvoker({
          finish: () =>
            Promise.resolve({ ...session, sessionId: wrongSessionId, status: "released" })
        })
      )
    ).rejects.toThrow("未得到可信终态");
  });

  it.each(["blocked:cuda-fft-unavailable", "blocked:cuda-fft-runtime"] as const)(
    "start 只保留白名单 CUDA 阻断码 %s，不带出原始详情",
    async (nativeCode) => {
      const error = await startAlignmentBenchmarkJob(
        createSession().sessionId,
        createAlignmentRequest(),
        createInvoker({
          startJob: () =>
            Promise.reject(
              new Error(`${nativeCode}：C:\\private\\driver.log stdout=SECRET`)
            )
        })
      ).catch((reason: unknown) => String(reason));

      expect(error).toContain(nativeCode);
      expect(error).not.toContain("driver.log");
      expect(error).not.toContain("SECRET");
    }
  );

  it("start 不披露未知伪 CUDA 阻断码与原始详情", async () => {
    const error = await startAlignmentBenchmarkJob(
      createSession().sessionId,
      createAlignmentRequest(),
      createInvoker({
        startJob: () =>
          Promise.reject(
            new Error("blocked:cuda-fft-private-extension：C:\\private\\driver.log SECRET")
          )
      })
    ).catch((reason: unknown) => String(reason));

    expect(error).toContain("原生性能任务启动失败");
    expect(error).not.toContain("blocked:cuda-fft-private-extension");
    expect(error).not.toContain("driver.log");
    expect(error).not.toContain("SECRET");
  });
});

function createInvoker(
  overrides: Partial<AlignmentBenchmarkInvoker> = {}
): AlignmentBenchmarkInvoker {
  const session = createSession();
  const job = createJob();
  return {
    begin: (request) => Promise.resolve(createSession(request.runManifestDigest)),
    getActive: () => Promise.resolve(session),
    resetCaches: () =>
      Promise.resolve({
        schemaVersion: 2,
        sessionId: session.sessionId,
        resetTickNs: "10",
        previousGeneration: 0,
        cacheGeneration: 1,
        before: createCacheCounts(1),
        after: createCacheCounts(0),
        allCachesEmpty: true
      }),
    startJob: () => Promise.resolve(job),
    getJob: () => Promise.resolve(job),
    cancelJob: () => Promise.resolve(job),
    finish: () => Promise.resolve(createReleasedSession(session)),
    ...overrides
  };
}

function createCacheResetReceipt(): AlignmentBenchmarkCacheResetReceipt {
  return {
    schemaVersion: 2,
    sessionId: "benchmark-session-1",
    resetTickNs: "10",
    previousGeneration: 0,
    cacheGeneration: 1,
    before: createCacheCounts(1),
    after: createCacheCounts(0),
    allCachesEmpty: true
  };
}

function createAlignmentRequest() {
  return {
    completePath: "D:\\private\\target.mkv",
    sourcePath: "D:\\private\\source.mkv",
    ffmpegPath: null
  };
}

function createSessionRequest(
  overrides: Partial<AlignmentBenchmarkSessionRequest> = {}
): AlignmentBenchmarkSessionRequest {
  const runManifestCanonicalJson = createAlignmentBenchmarkRunManifestCanonicalJson({
    schemaVersion: 1,
    manifestId: "private-benchmark-manifest",
    datasetVersion: "private-dataset-v1",
    cases: [
      {
        caseId: "private-case-1",
        source: createBlindMedia("source", "1"),
        target: createBlindMedia("target", "2")
      }
    ]
  });
  const digest = `sha256:${sha256Hex(runManifestCanonicalJson)}` as const;
  return {
    schemaVersion: 2,
    ffmpegPath: null,
    ffprobePath: null,
    memorySampleIntervalMs: 20,
    runManifestCanonicalJson,
    runManifestDigest: digest,
    workloadDigest: digest,
    ...overrides
  };
}

function createBlindMedia(name: string, digestDigit: string) {
  return {
    path: `D:\\private\\${name}.mkv`,
    audioStreamIndex: 0,
    videoStreamIndex: 1,
    contentIdentity: {
      algorithm: "sha256-full-file-v2" as const,
      sizeBytes: 1_000,
      digest: digestDigit.repeat(64)
    },
    versionNote: "固定测试媒体。",
    licenseNote: "测试许可。"
  };
}

function createSession(
  workloadDigest = createSessionRequest().workloadDigest
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
      collectorVersion: "windows-process-tree-rss-v1",
      measurementStatus: "complete",
      issues: [],
      operatingSystem: "windows",
      operatingSystemVersion: "11",
      architecture: "x86_64",
      cpuModel: "Test CPU",
      physicalCoreCount: 4,
      logicalCoreCount: 8,
      totalMemoryBytes: 16_000_000_000,
      storageScope: "workload-media-volumes",
      storageKind: "fixed-local",
      workloadStorage: createWorkloadStorageReceipt(workloadDigest),
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

function createReleasedSession(
  session: AlignmentBenchmarkSessionSnapshot
): AlignmentBenchmarkSessionSnapshot {
  const storage = session.environment.workloadStorage;
  const jobs: never[] = [];
  const withoutReceiptDigest = {
    schemaVersion: 1 as const,
    sessionId: session.sessionId,
    runManifestDigest: storage.runManifestDigest,
    workloadDigest: storage.workloadDigest,
    workloadStorageReceiptDigest: storage.receiptDigest,
    terminalTickNs: "1",
    finalCacheGeneration: session.cacheGeneration,
    jobCount: 0,
    completedJobCount: 0,
    failedJobCount: 0,
    cancelledJobCount: 0,
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
    ...session,
    status: "released",
    jobMemoryReceipt: createEmptyJobMemoryReceipt(session),
    terminalCleanupReceipt: {
      ...withoutReceiptDigest,
      receiptDigest: computeC137CanonicalDigest({
        domain: "c137-performance-terminal-cleanup-receipt-v1",
        receipt: withoutReceiptDigest
      })
    }
  };
}

function createEmptyJobMemoryReceipt(
  session: AlignmentBenchmarkSessionSnapshot
): NonNullable<AlignmentBenchmarkSessionSnapshot["jobMemoryReceipt"]> {
  const storage = session.environment.workloadStorage;
  const jobs: never[] = [];
  const withoutReceiptDigest = {
    schemaVersion: 1 as const,
    sessionId: session.sessionId,
    runManifestDigest: storage.runManifestDigest,
    workloadDigest: storage.workloadDigest,
    workloadStorageReceiptDigest: storage.receiptDigest,
    sampler: "windows-job-object-working-set-v1" as const,
    memoryScope: "application-process-tree" as const,
    jobCount: 0,
    totalSampleCount: 0,
    totalFailedSampleCount: 0 as const,
    maximumSampleGapMicros: "0",
    peakJobHierarchyRssBytes: 0,
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

function createWorkloadStorageReceipt(workloadDigest: `sha256:${string}`) {
  const withoutReceiptDigest = {
    schemaVersion: 2 as const,
    runManifestDigest: workloadDigest,
    workloadDigest,
    bindingCount: 2,
    uniqueMediaCount: 2,
    volumeCount: 1,
    mediaSetDigest: `sha256:${"c".repeat(64)}` as const,
    bindings: [
      { bindingOrdinal: 0, caseOrdinal: 0, side: "source" as const, volumeOrdinal: 0 },
      { bindingOrdinal: 1, caseOrdinal: 0, side: "target" as const, volumeOrdinal: 0 }
    ],
    volumes: [
      {
        volumeOrdinal: 0,
        bindingCount: 2,
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

function resignWorkloadStorageReceipt(
  receipt: AlignmentBenchmarkWorkloadStorageReceipt
): AlignmentBenchmarkWorkloadStorageReceipt {
  const { receiptDigest, ...withoutReceiptDigest } = receipt;
  void receiptDigest;
  return {
    ...withoutReceiptDigest,
    receiptDigest: computeC137CanonicalDigest(withoutReceiptDigest)
  };
}

function createJob(): AlignmentBenchmarkJobSnapshot {
  return {
    schemaVersion: 2,
    sessionId: "benchmark-session-1",
    jobId: "benchmark-job-1",
    status: "running",
    stageKey: "extracting-source",
    stageLabel: "提取参考特征",
    proposal: null,
    errorCode: null,
    telemetry: {
      schemaVersion: 2,
      clock: "rust-std-instant-session-relative-v1",
      startTickNs: "100",
      endTickNs: null,
      elapsedMs: 1,
      stages: [],
      cache: {
        generation: 1,
        before: createCacheCounts(0),
        after: createCacheCounts(0),
        audioFeatures: createCacheCounter(),
        landmarks: createCacheCounter(),
        visualFeatures: createCacheCounter()
      },
      memory: {
        scope: "application-process-tree",
        sampler: "windows-toolhelp-working-set-v1",
        sampleIntervalMs: 20,
        sampleCount: 2,
        failedSampleCount: 0,
        maximumSampleGapMs: 20,
        peakProcessTreeRssBytes: 123_456,
        coverageComplete: true,
        processTreeEmptyAtTerminal: false,
        residualProcessCount: 1
      },
      cancellation: null
    }
  };
}

function createCancelledJob(): AlignmentBenchmarkJobSnapshot {
  const running = createJob();
  return {
    ...running,
    status: "cancelled",
    stageKey: "cancelled",
    stageLabel: "已取消",
    telemetry: {
      ...running.telemetry,
      startTickNs: "100000000",
      endTickNs: "600000000",
      elapsedMs: 500,
      stages: [{ ...createStageTiming(), status: "cancelled" }],
      memory: {
        ...running.telemetry.memory,
        sampler: "windows-job-object-working-set-v1",
        processTreeEmptyAtTerminal: true,
        residualProcessCount: 0
      },
      cancellation: createCancellationTelemetry()
    }
  };
}

function createStageTiming() {
  return {
    stageKey: "extracting-source" as const,
    occurrence: 1,
    startTickNs: "100000000",
    endTickNs: "600000000",
    elapsedMs: 500,
    status: "completed" as const
  };
}

function createCancellationTelemetry() {
  return {
    requestTickNs: "500000000",
    terminalTickNs: "600000000",
    latencyMs: 100,
    commandAccepted: true
  };
}

function createCacheCounts(value: number) {
  return {
    audioFeatureEntries: value,
    landmarkEntries: value,
    visualFeatureEntries: value
  };
}

function createCacheCounter() {
  return { hits: 0, misses: 0, writes: 0, evictions: 0 };
}

function unsafeNativeResponse<T>(value: unknown): T {
  return value as T;
}

function unsafeSessionRequest(value: unknown): AlignmentBenchmarkSessionRequest {
  return value as AlignmentBenchmarkSessionRequest;
}
