import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  cancelTauriMediaInventoryJob,
  getTauriMediaInventoryJob,
  MediaInventoryCommandError,
  startTauriMediaInventoryJob,
  type MediaInventoryJobSnapshot,
  type MediaInventoryRequest
} from "./tauriMediaInventory";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri
}));

const readySnapshot = {
  schemaVersion: 1,
  jobId: "media-inventory-1",
  status: "completed",
  sequence: 4,
  cancelRequested: false,
  counts: {
    total: 1,
    queued: 0,
    probing: 0,
    ready: 1,
    failed: 0,
    cancelled: 0
  },
  items: [
    {
      ordinal: 0,
      itemId: "target-1",
      status: "ready",
      result: {
        inventoryRevision: "inventory-v1:0000000000000007",
        durationMs: 12_500,
        audioTracks: [
          {
            index: 7,
            codec: "aac",
            language: "eng",
            title: "Main",
            sampleRate: 48_000,
            channels: 2,
            channelLayout: "stereo",
            durationMs: 12_345,
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
            reasonCodes: [
              "onlyNonSpecialTrack",
              "originalDisposition",
              "defaultDispositionHint"
            ]
          }
        ],
        recommendation: {
          state: "recommended",
          streamIndex: 7,
          reasonCodes: ["onlyNonSpecialTrack", "originalDisposition"]
        },
        probeCompleteness: "complete",
        cacheState: "miss"
      },
      error: null
    }
  ],
  terminalError: null
} satisfies MediaInventoryJobSnapshot;

describe("Tauri Media Inventory v1", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.isTauri.mockReset();
    tauriMocks.isTauri.mockReturnValue(true);
  });

  it("以 exact camelCase 请求启动任务并严格验证响应", async () => {
    const request: MediaInventoryRequest = {
      schemaVersion: 1,
      items: [{ itemId: "target-1", path: "D:\\media\\episode.mkv" }],
      ffprobePath: "C:\\tools\\ffprobe.exe",
      ffmpegPath: null,
      preferredLanguages: ["jpn", "eng"],
      cachePolicy: "reuseFresh"
    };
    tauriMocks.invoke.mockResolvedValue(readySnapshot);

    const result = await startTauriMediaInventoryJob(request);

    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_media_inventory_job", { request });
    expect(result).toEqual(readySnapshot);
    expectTypeOf(result).toEqualTypeOf<MediaInventoryJobSnapshot>();
  });

  it("get/cancel 只传递 jobId 并复用同一严格 validator", async () => {
    tauriMocks.invoke.mockResolvedValue(readySnapshot);

    await expect(getTauriMediaInventoryJob("media-inventory-1")).resolves.toEqual(readySnapshot);
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("get_media_inventory_job", {
      jobId: "media-inventory-1"
    });

    await expect(cancelTauriMediaInventoryJob("media-inventory-1")).resolves.toEqual(
      readySnapshot
    );
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("cancel_media_inventory_job", {
      jobId: "media-inventory-1"
    });
  });

  it("接受 queued/running/cancelled/failed 与逐项 failed 的合法互斥形状", async () => {
    const queuedItem = { ordinal: 0, itemId: "target-1", status: "queued", result: null, error: null };
    const probingItem = { ...queuedItem, status: "probing" };
    const cancelledItem = { ...queuedItem, status: "cancelled" };
    const failedItem = {
      ...queuedItem,
      status: "failed",
      error: { code: "probeFailed", message: "探测失败。" }
    };
    const variants: unknown[] = [
      {
        ...readySnapshot,
        status: "queued",
        sequence: 1,
        counts: { total: 1, queued: 1, probing: 0, ready: 0, failed: 0, cancelled: 0 },
        items: [queuedItem]
      },
      {
        ...readySnapshot,
        status: "running",
        counts: { total: 1, queued: 0, probing: 1, ready: 0, failed: 0, cancelled: 0 },
        items: [probingItem]
      },
      {
        ...readySnapshot,
        status: "cancelled",
        cancelRequested: true,
        counts: { total: 1, queued: 0, probing: 0, ready: 0, failed: 0, cancelled: 1 },
        items: [cancelledItem]
      },
      {
        ...readySnapshot,
        status: "failed",
        counts: { total: 1, queued: 0, probing: 0, ready: 0, failed: 0, cancelled: 1 },
        items: [cancelledItem],
        terminalError: { code: "internalInvariant", message: "后台任务异常。" }
      },
      {
        ...readySnapshot,
        counts: { total: 1, queued: 0, probing: 0, ready: 0, failed: 1, cancelled: 0 },
        items: [failedItem]
      }
    ];

    for (const variant of variants) {
      await expect(
        getTauriMediaInventoryJob("job", () => Promise.resolve(variant))
      ).resolves.toEqual(variant);
    }
  });

  it.each([
    ["未知 job status", { ...readySnapshot, status: "finished" }],
    [
      "未知 reason code",
      {
        ...readySnapshot,
        items: [
          {
            ...readySnapshot.items[0],
            result: {
              ...readySnapshot.items[0].result,
              recommendation: {
                ...readySnapshot.items[0].result.recommendation,
                reasonCodes: ["magicConfidence"]
              }
            }
          }
        ]
      }
    ],
    ["unsafe sequence", { ...readySnapshot, sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["根级额外字段", { ...readySnapshot, path: "D:\\secret.mkv" }],
    [
      "audioTracks 未按 stream index 严格升序",
      {
        ...readySnapshot,
        items: [
          {
            ...readySnapshot.items[0],
            result: {
              ...readySnapshot.items[0].result,
              audioTracks: [
                readySnapshot.items[0].result.audioTracks[0],
                {
                  ...readySnapshot.items[0].result.audioTracks[0],
                  index: 2,
                  recommendationRank: 2
                }
              ]
            }
          }
        ]
      }
    ],
    [
      "partial metadata 自动推荐",
      {
        ...readySnapshot,
        items: [
          {
            ...readySnapshot.items[0],
            result: { ...readySnapshot.items[0].result, probeCompleteness: "partial" }
          }
        ]
      }
    ],
    [
      "partial metadata 缺少 metadataIncomplete reason",
      {
        ...readySnapshot,
        items: [
          {
            ...readySnapshot.items[0],
            result: {
              ...readySnapshot.items[0].result,
              probeCompleteness: "partial",
              recommendation: {
                state: "needsChoice",
                streamIndex: null,
                reasonCodes: []
              }
            }
          }
        ]
      }
    ],
    [
      "ready item 同时带 error",
      {
        ...readySnapshot,
        items: [
          {
            ...readySnapshot.items[0],
            error: { code: "probeFailed", message: "unexpected" }
          }
        ]
      }
    ]
  ])("拒绝 %s", async (_label, invalid) => {
    tauriMocks.invoke.mockResolvedValue(invalid);

    await expect(getTauriMediaInventoryJob("media-inventory-1")).rejects.toThrow(
      "媒体清单响应无效"
    );
  });

  it("结构化 Rust 错误不会退化为 object Object", async () => {
    tauriMocks.invoke.mockRejectedValue({
      code: "inventoryBusy",
      message: "已有媒体清单任务正在运行。"
    });

    await expect(startTauriMediaInventoryJob({ schemaVersion: 1, items: [] })).rejects.toThrow(
      "已有媒体清单任务正在运行。（inventoryBusy）"
    );
  });

  it("结构化 process cleanup command error 保留 code、retryable 与中文上下文", async () => {
    tauriMocks.invoke.mockRejectedValue({
      code: "processCleanupFault",
      message: "媒体探测进程未能确认退出。",
      retryable: false
    });

    const failure = await startTauriMediaInventoryJob({ schemaVersion: 1, items: [] }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(MediaInventoryCommandError);
    if (!(failure instanceof MediaInventoryCommandError)) {
      throw new Error("预期收到结构化媒体清单命令错误。");
    }
    expect(failure).toMatchObject({
      name: "MediaInventoryCommandError",
      code: "processCleanupFault",
      retryable: false
    });
    expect(failure.message).toContain(
      "媒体清单启动失败：媒体探测进程未能确认退出。（processCleanupFault）"
    );
  });

  it("默认 invoker 只允许 Tauri，注入 invoker 仍可独立测试", async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    await expect(getTauriMediaInventoryJob("job")).rejects.toThrow(
      "媒体清单需要在 Tauri 桌面端运行。"
    );
    expect(tauriMocks.invoke).not.toHaveBeenCalled();

    await expect(
      getTauriMediaInventoryJob("job", () => Promise.resolve(readySnapshot))
    ).resolves.toEqual(readySnapshot);
  });
});
