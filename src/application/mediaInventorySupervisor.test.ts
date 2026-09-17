import { describe, expect, it, vi } from "vitest";
import {
  MediaInventoryCommandError,
  type MediaInventoryAudioTrack,
  type MediaInventoryItemErrorCode,
  type MediaInventoryItemSnapshot,
  type MediaInventoryJobSnapshot,
  type MediaInventoryJobStatus
} from "../infrastructure/media/tauriMediaInventory";
import {
  createMediaInventorySupervisor,
  type MediaInventoryDesiredCohort,
  type MediaInventoryPort,
  type MediaInventoryPublication
} from "./mediaInventorySupervisor";

interface ReplacementScenario {
  name?: string;
  startSequence?: number;
  cancel: MediaInventoryPort["cancel"];
  get?: MediaInventoryPort["get"];
}

const replacementCleanupFaultScenarios: Array<ReplacementScenario & { name: string }> = [
  {
    name: "cancel 抛错",
    cancel: () => Promise.reject(new Error("process cleanup unavailable"))
  },
  {
    name: "cancel 返回错误 cohort",
    cancel: (jobId) =>
      Promise.resolve(snapshot(jobId, "cancelled", 2, [cancelledItem(0, "other")], true))
  },
  {
    name: "cancel sequence 回退",
    startSequence: 2,
    cancel: (jobId) =>
      Promise.resolve(snapshot(jobId, "cancelled", 1, [cancelledItem(0, "media-a")], true))
  },
  {
    name: "get 抛错",
    cancel: (jobId) =>
      Promise.resolve(snapshot(jobId, "running", 1, [probingItem(0, "media-a")], true)),
    get: () => Promise.reject(new Error("cleanup get failed"))
  },
  {
    name: "get 返回错误 itemId",
    cancel: (jobId) =>
      Promise.resolve(snapshot(jobId, "running", 1, [probingItem(0, "media-a")], true)),
    get: (jobId) =>
      Promise.resolve(snapshot(jobId, "cancelled", 2, [cancelledItem(0, "other")], true))
  },
  {
    name: "同 sequence payload 漂移",
    startSequence: 1,
    cancel: (jobId) =>
      Promise.resolve(snapshot(jobId, "running", 1, [queuedItem(0, "media-a")]))
  }
];

describe("media inventory supervisor", () => {
  it("把完成快照映射为不含原生 job/path/sequence 的语义 changed rows", async () => {
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: () =>
        Promise.resolve(snapshot("job-a", "completed", 3, [readyItem(0, "media-a", 2)]))
    });
    const supervisor = createMediaInventorySupervisor({ port, publish });

    await supervisor.reconcile(desired("a"));

    expect(publish).toHaveBeenCalledOnce();
    const publication = publish.mock.calls[0][0];
    expect(publication).toMatchObject({
      generationKey: desired("a").generationKey,
      phase: "completed",
      restartRequired: false,
      changedRows: [
        {
          mediaId: "media-a",
          status: "ready",
          inventoryRevision: "inventory-v1:aaaaaaaaaaaaaaaa",
          recommendation: { state: "recommended", streamIndex: 2 }
        }
      ]
    });
    expect(JSON.stringify(publication)).not.toContain("job-a");
    expect(JSON.stringify(publication)).not.toContain("C:\\media");
    expect(publication).not.toHaveProperty("sequence");
  });

  it("普通 start 失败发布 failed，但不会误标为需要重启", async () => {
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const supervisor = createMediaInventorySupervisor({
      port: createPort({ start: () => Promise.reject(new Error("ffprobe unavailable")) }),
      publish
    });

    await supervisor.reconcile(desired("a"));

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({
      phase: "failed",
      restartRequired: false,
      changedRows: [{ error: { code: "inventoryUnavailable" } }]
    });
  });

  it("failed snapshot 只在 terminal processCleanupFault 时晋升 session 重启门", async () => {
    const cleanupFault = snapshot("job-cleanup", "failed", 1, [
      failedItem(0, "media-a", "processCleanupFault")
    ]);
    cleanupFault.terminalError = {
      code: "processCleanupFault",
      message: "媒体探测进程未能确认退出。"
    };
    const ordinaryFailure = snapshot("job-ordinary", "failed", 1, [
      failedItem(0, "media-b", "probeFailed")
    ]);
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: (request) =>
        Promise.resolve(
          request.items[0].itemId === "media-a" ? cleanupFault : ordinaryFailure
        )
    });
    const supervisor = createMediaInventorySupervisor({ port, publish });

    await supervisor.reconcile(desired("a"));
    await supervisor.reconcile(desired("b"));

    expect(port.start).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(2);
    const cleanupPublication = publish.mock.calls[0][0];
    expect(cleanupPublication).toMatchObject({ restartRequired: true });
    expect(cleanupPublication.terminalMessage).toContain("需重启应用");
    expect(publish.mock.calls[1][0]).toMatchObject({
      generationKey: desired("b").generationKey,
      restartRequired: true
    });

    const ordinaryPublish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const ordinarySupervisor = createMediaInventorySupervisor({
      port: createPort({ start: () => Promise.resolve(ordinaryFailure) }),
      publish: ordinaryPublish
    });
    await ordinarySupervisor.reconcile(desired("b"));
    expect(ordinaryPublish.mock.calls[0][0]).toMatchObject({ restartRequired: false });
  });

  it("start 返回 typed processCleanupFault 后保持 session sticky 且不启动新 generation", async () => {
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: () =>
        Promise.reject(
          new MediaInventoryCommandError(
            "媒体清单启动失败：媒体探测进程未能确认退出。（processCleanupFault）",
            "processCleanupFault",
            false
          )
        )
    });
    const supervisor = createMediaInventorySupervisor({ port, publish });

    await supervisor.reconcile(desired("a"));
    await supervisor.reconcile(desired("b"));

    expect(port.start).toHaveBeenCalledOnce();
    expect(publish.mock.calls.map(([publication]) => publication.restartRequired)).toEqual([
      true,
      true
    ]);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      generationKey: desired("b").generationKey,
      changedRows: [{ error: { code: "processCleanupUncertain" } }]
    });
  });

  it("普通 get 返回 typed processCleanupFault 时不以成功 cancel 解除 session sticky", async () => {
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: (request) =>
        Promise.resolve(
          snapshot(`job-${request.items[0].itemId}`, "running", 0, [
            probingItem(0, request.items[0].itemId)
          ])
        ),
      get: () =>
        Promise.reject(
          new MediaInventoryCommandError(
            "媒体清单读取失败：媒体探测进程未能确认退出。（processCleanupFault）",
            "processCleanupFault",
            false
          )
        ),
      cancel: (jobId) =>
        Promise.resolve(
          snapshot(jobId, "cancelled", 1, [cancelledItem(0, "media-a")], true)
        )
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish,
      waitForPoll: () => Promise.resolve()
    });

    await supervisor.reconcile(desired("a"));
    await supervisor.reconcile(desired("b"));

    expect(port.start).toHaveBeenCalledOnce();
    expect(port.cancel).not.toHaveBeenCalled();
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      generationKey: desired("b").generationKey,
      restartRequired: true
    });
  });

  it("每个 snapshot 只做一次语义行转换，不在 publication 阶段重复读取音轨", async () => {
    const item = readyItem(0, "media-a", 2);
    const result = item.result!;
    const audioTracks = result.audioTracks;
    let audioTrackReads = 0;
    Object.defineProperty(result, "audioTracks", {
      configurable: true,
      get: () => {
        audioTrackReads += 1;
        return audioTracks;
      }
    });
    const supervisor = createMediaInventorySupervisor({
      port: createPort({
        start: () => Promise.resolve(snapshot("job-a", "completed", 1, [item]))
      }),
      publish: vi.fn()
    });

    await supervisor.reconcile(desired("a"));

    expect(audioTrackReads).toBe(2);
  });

  it("start 尚未返回时被替换会先取消收尾旧 job，且旧代 0 次发布", async () => {
    const delayedStart = deferred<MediaInventoryJobSnapshot>();
    const calls: string[] = [];
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: (request) => {
        const itemId = request.items[0].itemId;
        calls.push(`start:${itemId}`);
        if (itemId === "media-a") return delayedStart.promise;
        return Promise.resolve(
          snapshot("job-b", "completed", 1, [readyItem(0, itemId, 1)])
        );
      },
      cancel: (jobId) => {
        calls.push(`cancel:${jobId}`);
        return Promise.resolve(
          snapshot(jobId, "cancelled", 1, [cancelledItem(0, "media-a")], true)
        );
      }
    });
    const supervisor = createMediaInventorySupervisor({ port, publish });

    const firstRun = supervisor.reconcile(desired("a"));
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    const latestRun = supervisor.reconcile(desired("b"));
    delayedStart.resolve(snapshot("job-a", "running", 0, [queuedItem(0, "media-a")]));
    await Promise.all([firstRun, latestRun]);

    expect(calls).toEqual(["start:media-a", "cancel:job-a", "start:media-b"]);
    expect(publish.mock.calls.map(([value]) => value.generationKey.mediaSignature)).toEqual([
      "signature-b"
    ]);
  });

  it("替换 active job 时会在 cancel accepted 后继续 get 到终态才启动下一代", async () => {
    const firstPoll = deferred<void>();
    let pollCount = 0;
    const calls: string[] = [];
    const port = createPort({
      start: (request) => {
        const itemId = request.items[0].itemId;
        calls.push(`start:${itemId}`);
        return Promise.resolve(
          itemId === "media-a"
            ? snapshot("job-a", "running", 0, [probingItem(0, itemId)])
            : snapshot("job-b", "completed", 0, [readyItem(0, itemId, 1)])
        );
      },
      cancel: (jobId) => {
        calls.push(`cancel:${jobId}`);
        return Promise.resolve(
          snapshot(jobId, "running", 1, [probingItem(0, "media-a")], true)
        );
      },
      get: (jobId) => {
        calls.push(`get:${jobId}`);
        return Promise.resolve(
          snapshot(jobId, "cancelled", 2, [cancelledItem(0, "media-a")], true)
        );
      }
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish: vi.fn(),
      waitForPoll: () => {
        pollCount += 1;
        return pollCount === 1 ? firstPoll.promise : Promise.resolve();
      }
    });

    const firstRun = supervisor.reconcile(desired("a"));
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    const latestRun = supervisor.reconcile(desired("b"));
    firstPoll.resolve();
    await Promise.all([firstRun, latestRun]);

    expect(calls).toEqual([
      "start:media-a",
      "cancel:job-a",
      "get:job-a",
      "start:media-b"
    ]);
  });

  it.each(replacementCleanupFaultScenarios)(
    "replacement 收尾遇到 $name 时不启动下一代并明确要求重启",
    async (scenario) => {
      const result = await runReplacementScenario(scenario);

      expect(result.starts).toEqual(["media-a"]);
      expect(result.publish.mock.calls.at(-1)?.[0]).toMatchObject({
        generationKey: desired("b").generationKey,
        phase: "failed",
        restartRequired: true,
        changedRows: [
          {
            mediaId: "media-b",
            status: "failed",
            error: {
              code: "processCleanupUncertain",
              message: "媒体清单进程清理状态不确定，需重启应用。"
            }
          }
        ]
      });
    }
  );

  it("清理状态不确定后，新的 generation 仍收到需重启失败且不会启动任务", async () => {
    const result = await runReplacementScenario({
      cancel: () => Promise.reject(new Error("cleanup state unknown"))
    });
    result.publish.mockClear();

    await result.supervisor.reconcile(desired("c"));

    expect(result.port.start).toHaveBeenCalledOnce();
    expect(result.publish).toHaveBeenCalledOnce();
    expect(result.publish.mock.calls[0][0]).toMatchObject({
      generationKey: desired("c").generationKey,
      phase: "failed",
      restartRequired: true,
      changedRows: [{ mediaId: "media-c", error: { code: "processCleanupUncertain" } }]
    });
  });

  it("用户暂停后清理失败会保留已完成行，只把未决行发布为需重启失败", async () => {
    const firstPoll = deferred<void>();
    let pollCount = 0;
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const target: MediaInventoryDesiredCohort = {
      ...desired("a"),
      items: [
        { mediaId: "media-a", localPath: "C:\\media\\a.mkv" },
        { mediaId: "media-a-pending", localPath: "C:\\media\\a-pending.mkv" }
      ]
    };
    const port = createPort({
      start: () =>
        Promise.resolve(
          snapshot("job-a", "running", 0, [
            readyItem(0, "media-a", 2),
            probingItem(1, "media-a-pending")
          ])
        ),
      cancel: () =>
        Promise.resolve(
          snapshot(
            "job-a",
            "running",
            1,
            [readyItem(0, "media-a", 2), probingItem(1, "media-a-pending")],
            true
          )
        ),
      get: () => Promise.reject(new Error("cleanup poll failed"))
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish,
      waitForPoll: () => {
        pollCount += 1;
        return pollCount === 1 ? firstPoll.promise : Promise.resolve();
      }
    });

    const run = supervisor.reconcile(target);
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    const pause = supervisor.reconcile(null);
    firstPoll.resolve();
    await Promise.all([run, pause]);

    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      generationKey: target.generationKey,
      phase: "failed",
      restartRequired: true,
      counts: { total: 2, ready: 1, failed: 1 },
      changedRows: [
        {
          mediaId: "media-a-pending",
          status: "failed",
          error: { code: "processCleanupUncertain" }
        }
      ]
    });
  });

  it("用户暂停收尾中新 settled 行会覆盖已发布 probing，并与未决行一起形成一致终态", async () => {
    const firstPoll = deferred<void>();
    let pollCount = 0;
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const target: MediaInventoryDesiredCohort = {
      ...desired("a"),
      items: [
        { mediaId: "media-ready", localPath: "C:\\media\\ready.mkv" },
        { mediaId: "media-failed", localPath: "C:\\media\\failed.mkv" },
        { mediaId: "media-cancelled", localPath: "C:\\media\\cancelled.mkv" },
        { mediaId: "media-pending", localPath: "C:\\media\\pending.mkv" }
      ]
    };
    const port = createPort({
      start: () =>
        Promise.resolve(
          snapshot(
            "job-a",
            "running",
            0,
            target.items.map((item, ordinal) => probingItem(ordinal, item.mediaId))
          )
        ),
      cancel: () =>
        Promise.resolve(
          snapshot(
            "job-a",
            "running",
            1,
            [
              readyItem(0, "media-ready", 2),
              failedItem(1, "media-failed", "probeFailed"),
              cancelledItem(2, "media-cancelled"),
              probingItem(3, "media-pending")
            ],
            true
          )
        ),
      get: () => Promise.reject(new Error("cleanup poll failed"))
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish,
      waitForPoll: () => {
        pollCount += 1;
        return pollCount === 1 ? firstPoll.promise : Promise.resolve();
      }
    });

    const run = supervisor.reconcile(target);
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    const pause = supervisor.reconcile(null);
    firstPoll.resolve();
    await Promise.all([run, pause]);

    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      generationKey: target.generationKey,
      phase: "failed",
      restartRequired: true,
      counts: { total: 4, ready: 1, failed: 2, cancelled: 1 },
      changedRows: [
        { mediaId: "media-ready", status: "ready" },
        { mediaId: "media-failed", status: "failed", error: { code: "probeFailed" } },
        { mediaId: "media-cancelled", status: "cancelled" },
        {
          mediaId: "media-pending",
          status: "failed",
          error: { code: "processCleanupUncertain" }
        }
      ]
    });
  });

  it("轮询临时失败后，cleanup 不确定会把最新权威 settled 行重新发布到 store", async () => {
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const target: MediaInventoryDesiredCohort = {
      ...desired("a"),
      items: [
        { mediaId: "media-failed", localPath: "C:\\media\\failed.mkv" },
        { mediaId: "media-pending", localPath: "C:\\media\\pending.mkv" }
      ]
    };
    const port = createPort({
      start: () =>
        Promise.resolve(
          snapshot("job-a", "running", 0, [
            failedItem(0, "media-failed", "probeFailed"),
            probingItem(1, "media-pending")
          ])
        ),
      get: () => Promise.reject(new Error("inventory channel unavailable")),
      cancel: () =>
        Promise.resolve(
          snapshot(
            "job-a",
            "running",
            1,
            [
              failedItem(0, "media-failed", "probeFailed"),
              probingItem(1, "media-pending")
            ],
            true
          )
        )
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish,
      waitForPoll: () => Promise.resolve()
    });

    await supervisor.reconcile(target);

    expect(publish.mock.calls.at(-2)?.[0]).toMatchObject({
      restartRequired: false,
      changedRows: [
        { mediaId: "media-failed", error: { code: "inventoryUnavailable" } },
        { mediaId: "media-pending", error: { code: "inventoryUnavailable" } }
      ]
    });
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      phase: "failed",
      restartRequired: true,
      counts: { total: 2, ready: 0, failed: 2, cancelled: 0 },
      changedRows: [
        { mediaId: "media-failed", status: "failed", error: { code: "probeFailed" } },
        {
          mediaId: "media-pending",
          status: "failed",
          error: { code: "processCleanupUncertain" }
        }
      ]
    });
  });

  it("用户暂停后只在 native terminal 到达时发布权威 cancelled", async () => {
    const firstPoll = deferred<void>();
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: () =>
        Promise.resolve(snapshot("job-a", "running", 0, [probingItem(0, "media-a")])),
      cancel: () =>
        Promise.resolve(
          snapshot("job-a", "cancelled", 1, [cancelledItem(0, "media-a")], true)
        )
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish,
      waitForPoll: () => firstPoll.promise
    });

    const run = supervisor.reconcile(desired("a"));
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    const pause = supervisor.reconcile(null);
    expect(publish.mock.calls.at(-1)?.[0].phase).toBe("running");
    firstPoll.resolve();
    await Promise.all([run, pause]);

    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      generationKey: desired("a").generationKey,
      phase: "cancelled",
      restartRequired: false,
      changedRows: [{ mediaId: "media-a", status: "cancelled" }]
    });
  });

  it("replacement 收尾允许完全相同的同 sequence 快照幂等，再正常 drain", async () => {
    const result = await runReplacementScenario({
      startSequence: 1,
      cancel: (jobId) =>
        Promise.resolve(snapshot(jobId, "running", 1, [probingItem(0, "media-a")])),
      get: (jobId) =>
        Promise.resolve(
          snapshot(jobId, "cancelled", 2, [cancelledItem(0, "media-a")], true)
        )
    });

    expect(result.starts).toEqual(["media-a", "media-b"]);
  });

  it("快速三次 reconcile 只保留首个待收尾 job 与最终 cohort", async () => {
    const delayedStart = deferred<MediaInventoryJobSnapshot>();
    const starts: string[] = [];
    const port = createPort({
      start: (request) => {
        const itemId = request.items[0].itemId;
        starts.push(itemId);
        return itemId === "media-a"
          ? delayedStart.promise
          : Promise.resolve(
              snapshot(`job-${itemId}`, "completed", 0, [readyItem(0, itemId, 1)])
            );
      },
      cancel: (jobId) =>
        Promise.resolve(
          snapshot(jobId, "cancelled", 1, [cancelledItem(0, "media-a")], true)
        )
    });
    const supervisor = createMediaInventorySupervisor({ port, publish: vi.fn() });

    const run = supervisor.reconcile(desired("a"));
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    void supervisor.reconcile(desired("b"));
    void supervisor.reconcile(desired("c"));
    delayedStart.resolve(snapshot("job-a", "running", 0, [queuedItem(0, "media-a")]));
    await run;

    expect(starts).toEqual(["media-a", "media-c"]);
  });

  it("runner 即将收尾时收到新 cohort 仍会等待并启动最新任务", async () => {
    const starts: string[] = [];
    const lateReconcile = deferred<void>();
    let reconcileLatest: () => Promise<void> = () =>
      Promise.reject(new Error("latest reconcile 未初始化"));
    const port = createPort({
      start: (request) => {
        const itemId = request.items[0].itemId;
        starts.push(itemId);
        return Promise.resolve(
          snapshot(`job-${itemId}`, "completed", 0, [readyItem(0, itemId, 1)])
        );
      }
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish: () => {
        if (starts.length !== 1) return;
        queueMicrotask(() => {
          queueMicrotask(() => {
            lateReconcile.resolve(reconcileLatest());
          });
        });
      }
    });
    reconcileLatest = () => supervisor.reconcile(desired("b"));

    await supervisor.reconcile(desired("a"));
    await lateReconcile.promise;

    expect(starts).toEqual(["media-a", "media-b"]);
  });

  it("A 发布协议错误的收尾等待期间切到 B，不会在 await 后向旧 generation 迟到发布", async () => {
    const cleanup = deferred<MediaInventoryJobSnapshot>();
    const starts: string[] = [];
    const publications: MediaInventoryPublication[] = [];
    let rejectFirstPublication = true;
    const port = createPort({
      start: (request) => {
        const itemId = request.items[0].itemId;
        starts.push(itemId);
        return Promise.resolve(
          snapshot(
            `job-${itemId}`,
            itemId === "media-a" ? "running" : "completed",
            0,
            [
              itemId === "media-a"
                ? probingItem(0, itemId)
                : readyItem(0, itemId, 1)
            ]
          )
        );
      },
      cancel: () => cleanup.promise
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish: (publication) => {
        if (rejectFirstPublication) {
          rejectFirstPublication = false;
          throw new Error("publication protocol rejected");
        }
        publications.push(publication);
      }
    });

    const firstRun = supervisor.reconcile(desired("a"));
    await waitUntil(() => expect(port.cancel).toHaveBeenCalledOnce());
    const replacementRun = supervisor.reconcile(desired("b"));
    cleanup.resolve(
      snapshot("job-media-a", "cancelled", 1, [cancelledItem(0, "media-a")], true)
    );
    await Promise.all([firstRun, replacementRun]);

    expect(starts).toEqual(["media-a", "media-b"]);
    expect(publications.map((publication) => publication.generationKey.mediaSignature)).toEqual([
      "signature-b"
    ]);
    expect(publications[0]).toMatchObject({ restartRequired: false, phase: "completed" });
  });

  it("忽略较低与相同 sequence，只发布更高 sequence 的 changed rows", async () => {
    const snapshots = [
      snapshot("job-a", "running", 1, [probingItem(0, "media-a")]),
      snapshot("job-a", "running", 2, [probingItem(0, "media-a")]),
      snapshot("job-a", "completed", 3, [readyItem(0, "media-a", 4)])
    ];
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: () =>
        Promise.resolve(snapshot("job-a", "running", 2, [queuedItem(0, "media-a")])),
      get: () => Promise.resolve(snapshots.shift()!)
    });
    const supervisor = createMediaInventorySupervisor({
      port,
      publish,
      waitForPoll: () => Promise.resolve()
    });

    await supervisor.reconcile(desired("a"));

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map(([value]) => value.changedRows[0]?.status)).toEqual([
      "queued",
      "ready"
    ]);
  });

  it("itemId/ordinal cohort 不符时 fail-closed，并且不发布伪造 ready", async () => {
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: () =>
        Promise.resolve(snapshot("job-a", "completed", 1, [readyItem(0, "other", 2)])),
      cancel: () =>
        Promise.resolve(
          snapshot("job-a", "cancelled", 2, [cancelledItem(0, "other")], true)
        )
    });
    const supervisor = createMediaInventorySupervisor({ port, publish });

    await supervisor.reconcile(desired("a"));

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({
      phase: "failed",
      restartRequired: true,
      changedRows: [
        {
          mediaId: "media-a",
          status: "failed",
          error: { code: "processCleanupUncertain" }
        }
      ]
    });
  });

  it("dispose 会收尾迟到的 start，且不会发布晚到状态", async () => {
    const delayedStart = deferred<MediaInventoryJobSnapshot>();
    const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
    const port = createPort({
      start: () => delayedStart.promise,
      cancel: (jobId) =>
        Promise.resolve(
          snapshot(jobId, "cancelled", 1, [cancelledItem(0, "media-a")], true)
        )
    });
    const supervisor = createMediaInventorySupervisor({ port, publish });

    const run = supervisor.reconcile(desired("a"));
    await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
    const disposal = supervisor.dispose();
    delayedStart.resolve(snapshot("job-a", "running", 0, [queuedItem(0, "media-a")]));
    await Promise.all([run, disposal]);

    expect(port.cancel).toHaveBeenCalledWith("job-a");
    expect(publish).not.toHaveBeenCalled();
  });
});

async function runReplacementScenario(scenario: ReplacementScenario) {
  const firstPoll = deferred<void>();
  let pollCount = 0;
  const starts: string[] = [];
  const publish = vi.fn<(publication: MediaInventoryPublication) => void>();
  const portOverrides: Partial<MediaInventoryPort> = {
    start: (request) => {
      const itemId = request.items[0].itemId;
      starts.push(itemId);
      return Promise.resolve(
        itemId === "media-a"
          ? snapshot(
              "job-media-a",
              "running",
              scenario.startSequence ?? 0,
              [probingItem(0, itemId)]
            )
          : snapshot("job-media-b", "completed", 0, [readyItem(0, itemId, 1)])
      );
    },
    cancel: scenario.cancel
  };
  if (scenario.get) portOverrides.get = scenario.get;
  const port = createPort(portOverrides);
  const supervisor = createMediaInventorySupervisor({
    port,
    publish,
    waitForPoll: () => {
      pollCount += 1;
      return pollCount === 1 ? firstPoll.promise : Promise.resolve();
    }
  });

  const firstRun = supervisor.reconcile(desired("a"));
  await waitUntil(() => expect(port.start).toHaveBeenCalledOnce());
  const replacementRun = supervisor.reconcile(desired("b"));
  firstPoll.resolve();
  await Promise.all([firstRun, replacementRun]);

  return { port, publish, starts, supervisor };
}

function desired(id: string): MediaInventoryDesiredCohort {
  return {
    generationKey: {
      projectId: "project-1",
      projectEpoch: 1,
      inventoryGeneration: id.charCodeAt(0),
      mediaSignature: `signature-${id}`
    },
    items: [{ mediaId: `media-${id}`, localPath: `C:\\media\\${id}.mkv` }]
  };
}

function createPort(
  overrides: Partial<MediaInventoryPort>
): {
  start: ReturnType<typeof vi.fn<MediaInventoryPort["start"]>>;
  get: ReturnType<typeof vi.fn<MediaInventoryPort["get"]>>;
  cancel: ReturnType<typeof vi.fn<MediaInventoryPort["cancel"]>>;
} {
  return {
    start: vi.fn<MediaInventoryPort["start"]>(
      overrides.start ?? (() => Promise.reject(new Error("unexpected media inventory start")))
    ),
    get: vi.fn<MediaInventoryPort["get"]>(
      overrides.get ?? (() => Promise.reject(new Error("unexpected media inventory get")))
    ),
    cancel: vi.fn<MediaInventoryPort["cancel"]>(
      overrides.cancel ??
        (() => Promise.reject(new Error("unexpected media inventory cancel")))
    )
  };
}

function snapshot(
  jobId: string,
  status: MediaInventoryJobStatus,
  sequence: number,
  items: MediaInventoryItemSnapshot[],
  cancelRequested = false
): MediaInventoryJobSnapshot {
  const counts = {
    total: items.length,
    queued: items.filter((item) => item.status === "queued").length,
    probing: items.filter((item) => item.status === "probing").length,
    ready: items.filter((item) => item.status === "ready").length,
    failed: items.filter((item) => item.status === "failed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length
  };
  return {
    schemaVersion: 1,
    jobId,
    status,
    sequence,
    cancelRequested,
    counts,
    items,
    terminalError:
      status === "failed" ? { code: "internalInvariant", message: "job failed" } : null
  };
}

function queuedItem(ordinal: number, itemId: string): MediaInventoryItemSnapshot {
  return { ordinal, itemId, status: "queued", result: null, error: null };
}

function probingItem(ordinal: number, itemId: string): MediaInventoryItemSnapshot {
  return { ordinal, itemId, status: "probing", result: null, error: null };
}

function cancelledItem(ordinal: number, itemId: string): MediaInventoryItemSnapshot {
  return { ordinal, itemId, status: "cancelled", result: null, error: null };
}

function failedItem(
  ordinal: number,
  itemId: string,
  code: MediaInventoryItemErrorCode
): MediaInventoryItemSnapshot {
  return {
    ordinal,
    itemId,
    status: "failed",
    result: null,
    error: { code, message: "媒体探测失败" }
  };
}

function readyItem(
  ordinal: number,
  itemId: string,
  streamIndex: number
): MediaInventoryItemSnapshot {
  return {
    ordinal,
    itemId,
    status: "ready",
    result: {
      inventoryRevision: "inventory-v1:aaaaaaaaaaaaaaaa",
      durationMs: 120_000,
      audioTracks: [track(streamIndex)],
      recommendation: {
        state: "recommended",
        streamIndex,
        reasonCodes: ["onlyNonSpecialTrack"]
      },
      probeCompleteness: "complete",
      cacheState: "miss"
    },
    error: null
  };
}

function track(index: number): MediaInventoryAudioTrack {
  return {
    index,
    codec: "aac",
    language: "jpn",
    title: "Main",
    sampleRate: 48_000,
    channels: 2,
    channelLayout: "stereo",
    durationMs: 120_000,
    dispositions: {
      default: true,
      original: true,
      dub: false,
      commentary: false,
      descriptions: false,
      visualImpaired: false,
      hearingImpaired: false,
      cleanEffects: false,
      karaoke: false
    },
    recommendationRank: 1,
    reasonCodes: ["onlyNonSpecialTrack"]
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(assertion: () => void): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      lastError = error;
      await Promise.resolve();
    }
  }
  throw lastError;
}
