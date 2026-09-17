import { afterEach, describe, expect, it, vi } from "vitest";
import { TauriLibMpvMediaAdapter, TauriMpvMediaAdapter } from "./mediaAdapter";
import type { LibMpvSessionStatus, TauriLibMpvBridge } from "./tauriLibMpvPlayer";
import type { TauriMpvBridge } from "./tauriMpvPlayer";

describe("媒体适配器", () => {
  it("空运行库配置通过原生发现取得 DLL 并用于创建会话", async () => {
    const bridge = createLibMpvBridge();
    const adapter = new TauriLibMpvMediaAdapter({
      sessionId: "auto_runtime",
      mpvPath: "",
      getBounds: () => NATIVE_TEST_BOUNDS,
      bridge
    });
    nativeTestAdapters.add(adapter);
    await adapter.load({ kind: "file", name: "test", url: "C:\\media\\test.mkv" });
    expect(bridge.detectRuntime).toHaveBeenCalledWith({ mpvPath: "" });
    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ mpvPath: "C:\\tools\\libmpv-2.dll" })
    );
  });

  it("原生弹幕合并排队更新、忽略旧版本并随播放器销毁清理", async () => {
    const bridge = createLibMpvBridge();
    bridge.setDanmakuTrack = vi.fn<NonNullable<TauriLibMpvBridge["setDanmakuTrack"]>>(
      (request) =>
        Promise.resolve({
          revision: request.revision,
          state: request.assContent === null ? "cleared" : "applied"
        })
    );
    const adapter = createNativeTestAdapter(bridge);
    await adapter.setDanmakuTrack({ revision: 1, assContent: "first", visible: true });
    expect(bridge.setDanmakuTrack).not.toHaveBeenCalled();
    await adapter.load({ kind: "file", name: "test", url: "C:\\media\\test.mkv" });
    expect(bridge.setDanmakuTrack).toHaveBeenCalledTimes(1);
    const second = adapter.setDanmakuTrack({
      revision: 2,
      assContent: "second",
      visible: true
    });
    const third = adapter.setDanmakuTrack({
      revision: 3,
      assContent: "latest",
      visible: false
    });
    await Promise.all([second, third]);
    expect(bridge.setDanmakuTrack).toHaveBeenCalledTimes(2);
    expect(bridge.setDanmakuTrack).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 3, assContent: "latest", visible: false })
    );
    await adapter.setDanmakuTrack({ revision: 2, assContent: null, visible: false });
    expect(bridge.setDanmakuTrack).toHaveBeenCalledTimes(2);
    await expect(
      adapter.setDanmakuTrack({ revision: 3.5, assContent: null, visible: false })
    ).rejects.toThrow("安全整数");
    adapter.dispose();
    await flushNativeWork();
    expect(bridge.destroySession).toHaveBeenCalledTimes(1);
    await expect(
      adapter.setDanmakuTrack({ revision: 4, assContent: null, visible: false })
    ).rejects.toThrow("已关闭");
  });

  afterEach(async () => {
    nativeTestAdapters.forEach((adapter) => adapter.dispose());
    nativeTestAdapters.clear();
    await flushNativeWork();
    if (vi.isFakeTimers()) vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("mpv 适配器通过 Tauri sidecar 加载和控制本地文件", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const adapter = new TauriMpvMediaAdapter("C:\\tools\\mpv.exe", bridge);

    await adapter.load({ kind: "file", name: "full.mkv", url: "D:\\media\\full.mkv" }, 8_765);
    expect(bridge.start).toHaveBeenCalledWith({
      mpvPath: "C:\\tools\\mpv.exe",
      mediaPath: "D:\\media\\full.mkv",
      startPositionMs: 8_765,
      startPaused: true
    });
    expect(adapter.getDurationMs()).toBe(3_000_000);
    expect(adapter.getTracks()).toEqual([
      {
        id: 1,
        trackType: "audio",
        title: "日语",
        language: "jpn",
        codec: "aac",
        selected: true,
        external: false
      }
    ]);

    await adapter.play();
    adapter.seek(12_345);
    adapter.pause();
    adapter.setPlaybackRate(1.25);
    expect(bridge.control).toHaveBeenCalledWith({ action: "play" });
    expect(bridge.control).toHaveBeenCalledWith({ action: "seek", positionMs: 12_345 });
    expect(bridge.control).toHaveBeenCalledWith({ action: "pause" });
    expect(bridge.control).toHaveBeenCalledWith({
      action: "setPlaybackRate",
      playbackRate: 1.25
    });

    adapter.dispose();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });

  it("mpv 适配器拒绝 blob URL 和空 mpv 路径", async () => {
    const bridge = createBridge();
    await expect(
      new TauriMpvMediaAdapter("", bridge).load({
        kind: "file",
        name: "demo",
        url: "D:\\demo.mkv"
      })
    ).rejects.toThrow("尚未配置 mpv 路径");
    await expect(
      new TauriMpvMediaAdapter("mpv", bridge).load({
        kind: "file",
        name: "demo",
        url: "blob:demo"
      })
    ).rejects.toThrow("真实本地文件路径");
  });

  it("mpv 适配器可以加载本次会话的 Emby 授权播放地址", async () => {
    const bridge = createBridge();
    const adapter = new TauriMpvMediaAdapter("C:\\tools\\mpv.exe", bridge);
    const url =
      "https://emby.example.test/Videos/item/stream?api_key=secret-token&MediaSourceId=source-1";

    await adapter.load({ kind: "url", name: "Episode 1", url });

    expect(bridge.start).toHaveBeenCalledWith({
      mpvPath: "C:\\tools\\mpv.exe",
      mediaPath: url,
      startPositionMs: 0,
      startPaused: true
    });
  });

  it("libmpv 适配器使用独立会话并直接更新应用内画面边界", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const bounds = { x: 20, y: 40, width: 800, height: 450, visible: true };
    const adapter = new TauriLibMpvMediaAdapter({
      sessionId: "review_1",
      mpvPath: "C:\\tools\\mpv.exe",
      getBounds: () => bounds,
      bridge
    });

    await adapter.prepare();
    expect(bridge.detectRuntime).toHaveBeenCalledWith({ mpvPath: "C:\\tools\\mpv.exe" });
    await adapter.load({ kind: "file", name: "full.mkv", url: "D:\\media\\full.mkv" }, 8_765);
    expect(bridge.detectRuntime).toHaveBeenCalledTimes(1);
    expect(bridge.createSession).toHaveBeenCalledWith({
      sessionId: "review_1",
      mpvPath: "C:\\tools\\mpv.exe",
      mediaPath: "D:\\media\\full.mkv",
      startPositionMs: 8_765,
      startPaused: true,
      bounds
    });

    await adapter.load({ kind: "file", name: "cut.mkv", url: "D:\\media\\cut.mkv" }, 12_000);
    expect(bridge.controlSession).toHaveBeenCalledWith({
      sessionId: "review_1",
      action: "load",
      mediaPath: "D:\\media\\cut.mkv",
      positionMs: 12_000,
      startPaused: true
    });
    expect(bridge.destroySession).not.toHaveBeenCalled();

    adapter.setHostBounds({ ...bounds, width: 640 });
    expect(bridge.setSessionBounds).toHaveBeenCalledWith({
      sessionId: "review_1",
      bounds: { ...bounds, width: 640 }
    });

    await adapter.play();
    expect(bridge.controlSession).toHaveBeenCalledWith({
      sessionId: "review_1",
      action: "play"
    });
    adapter.setMuted(true);
    await flushNativeWork();
    expect(bridge.controlSession).toHaveBeenCalledWith({
      sessionId: "review_1",
      action: "setMuted",
      muted: true
    });
    adapter.dispose();
    await flushNativeWork();
    expect(bridge.destroySession).toHaveBeenCalledWith({ sessionId: "review_1" });
  });

  it("libmpv 适配器在媒体尚未载入时不会静默吞掉播放操作", async () => {
    const adapter = new TauriLibMpvMediaAdapter({
      sessionId: "review_not_loaded",
      mpvPath: "C:\\tools\\mpv.exe",
      getBounds: () => ({ x: 0, y: 0, width: 640, height: 360, visible: true }),
      bridge: createLibMpvBridge()
    });

    await expect(adapter.play()).rejects.toThrow("播放器尚未载入媒体");
  });

  it("libmpv 并发探测共用请求，探测失败后可重试", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const detection = deferred<Awaited<ReturnType<TauriLibMpvBridge["detectRuntime"]>>>();
    vi.mocked(bridge.detectRuntime).mockReturnValueOnce(detection.promise);

    const first = adapter.prepare().catch((error: unknown) => error);
    const second = adapter.prepare().catch((error: unknown) => error);
    expect(bridge.detectRuntime).toHaveBeenCalledTimes(1);
    detection.reject(new Error("暂时不可用"));
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);

    await adapter.prepare();
    expect(bridge.detectRuntime).toHaveBeenCalledTimes(2);
  });

  it("libmpv 探测期间关闭后，晚回执不会创建会话", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const detection = deferred<Awaited<ReturnType<TauriLibMpvBridge["detectRuntime"]>>>();
    vi.mocked(bridge.detectRuntime).mockReturnValueOnce(detection.promise);
    const loading = adapter.load(NATIVE_TEST_SOURCE).catch((error: unknown) => error);
    await flushNativeWork();

    adapter.dispose();
    detection.resolve({
      available: true,
      libraryPath: "C:\\tools\\libmpv-2.dll",
      clientApiVersion: "2.5",
      message: "可用"
    });
    expect(await loading).toEqual(expect.objectContaining({ message: "播放器会话已关闭。" }));
    await flushNativeWork();
    expect(bridge.createSession).not.toHaveBeenCalled();
    expect(bridge.destroySession).not.toHaveBeenCalled();
  });

  it("libmpv 同名重开等待旧创建及销毁落定，旧回执不复活播放器", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const created = deferred<LibMpvSessionStatus>();
    const destroyed = deferred<LibMpvSessionStatus>();
    vi.mocked(bridge.createSession).mockReturnValueOnce(created.promise);
    vi.mocked(bridge.destroySession).mockReturnValueOnce(destroyed.promise);
    const oldAdapter = createNativeTestAdapter(bridge, "late-create");
    const oldLoad = oldAdapter.load(NATIVE_TEST_SOURCE).catch((error: unknown) => error);
    await flushNativeWork();
    expect(bridge.createSession).toHaveBeenCalledTimes(1);

    oldAdapter.dispose();
    const nextAdapter = createNativeTestAdapter(bridge, "late-create");
    const nextLoad = nextAdapter.load(NATIVE_TEST_SOURCE);
    await flushNativeWork();
    expect(bridge.createSession).toHaveBeenCalledTimes(1);
    expect(bridge.destroySession).not.toHaveBeenCalled();

    created.resolve(nativeStatus(3_000));
    expect(await oldLoad).toBeInstanceOf(Error);
    await flushNativeWork();
    expect(bridge.destroySession).toHaveBeenCalledTimes(1);
    expect(bridge.createSession).toHaveBeenCalledTimes(1);
    expect(oldAdapter.getCurrentTimeMs()).toBe(0);

    destroyed.resolve(nativeStatus(0, false));
    await nextLoad;
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
  });

  it("libmpv 不接管仍在使用的同名会话，关闭旧实例后可重试", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const oldAdapter = createNativeTestAdapter(bridge, "active-owner");
    const nextAdapter = createNativeTestAdapter(bridge, "active-owner");
    await oldAdapter.load(NATIVE_TEST_SOURCE);

    await expect(nextAdapter.load(NATIVE_TEST_SOURCE)).rejects.toThrow(
      "同名 libmpv 会话正在使用"
    );
    expect(bridge.createSession).toHaveBeenCalledTimes(1);
    oldAdapter.dispose();
    await nextAdapter.load(NATIVE_TEST_SOURCE);
    expect(bridge.destroySession).toHaveBeenCalledTimes(1);
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
  });

  it("libmpv 销毁失败保留会话所有权，同名 load 可重试清理", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const oldAdapter = createNativeTestAdapter(bridge, "cleanup-retry");
    await oldAdapter.load(NATIVE_TEST_SOURCE);
    vi.mocked(bridge.destroySession).mockRejectedValue(new Error("暂时无法关闭"));
    oldAdapter.dispose();
    await flushNativeWork();

    const nextAdapter = createNativeTestAdapter(bridge, "cleanup-retry");
    await expect(nextAdapter.load(NATIVE_TEST_SOURCE)).rejects.toThrow("旧播放器尚未完成关闭");
    expect(bridge.createSession).toHaveBeenCalledTimes(1);
    expect(bridge.destroySession).toHaveBeenCalledTimes(2);

    vi.mocked(bridge.destroySession).mockResolvedValue(nativeStatus(0, false));
    await nextAdapter.load(NATIVE_TEST_SOURCE);
    expect(bridge.destroySession).toHaveBeenCalledTimes(3);
    expect(bridge.createSession).toHaveBeenCalledTimes(2);
  });

  it("libmpv 创建或控制失败不会阻塞后续操作与清理", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    vi.mocked(bridge.createSession).mockRejectedValueOnce(new Error("初始化失败"));
    await expect(adapter.load(NATIVE_TEST_SOURCE)).rejects.toThrow("初始化失败");
    await adapter.load(NATIVE_TEST_SOURCE);
    expect(bridge.createSession).toHaveBeenCalledTimes(2);

    vi.mocked(bridge.controlSession).mockRejectedValueOnce(new Error("临时控制失败"));
    await expect(adapter.play()).rejects.toThrow("临时控制失败");
    await adapter.play();
    adapter.dispose();
    await flushNativeWork();
    expect(bridge.destroySession).toHaveBeenCalledTimes(1);
  });

  it("libmpv 慢轮询保持单飞，旧回执不会覆盖新 seek", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const polled = deferred<LibMpvSessionStatus>();
    vi.mocked(bridge.getSessionStatus).mockReturnValueOnce(polled.promise);
    await adapter.load(NATIVE_TEST_SOURCE);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(1);

    vi.mocked(bridge.controlSession).mockResolvedValueOnce(nativeStatus(5_000));
    adapter.seek(5_000);
    await flushNativeWork();
    polled.resolve(nativeStatus(100));
    await flushNativeWork();
    expect(adapter.getCurrentTimeMs()).toBe(5_000);
  });

  it("libmpv 连续 seek 按顺序提交，旧命令与在途期间轮询不回退播放头", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const sought = deferred<LibMpvSessionStatus>();
    await adapter.load(NATIVE_TEST_SOURCE);
    vi.mocked(bridge.controlSession)
      .mockReturnValueOnce(sought.promise)
      .mockResolvedValueOnce(nativeStatus(6_000));

    adapter.seek(5_000);
    adapter.seek(6_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bridge.controlSession).toHaveBeenCalledTimes(1);
    expect(bridge.getSessionStatus).not.toHaveBeenCalled();
    expect(adapter.getCurrentTimeMs()).toBe(6_000);

    sought.resolve(nativeStatus(5_000));
    await flushNativeWork();
    expect(bridge.controlSession).toHaveBeenCalledTimes(2);
    expect(adapter.getCurrentTimeMs()).toBe(6_000);
  });

  it("libmpv 关闭等待在途状态与几何请求，晚回执不再更新或发新请求", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const polled = deferred<LibMpvSessionStatus>();
    const positioned = deferred<LibMpvSessionStatus>();
    await adapter.load(NATIVE_TEST_SOURCE);
    const positionBeforeClose = adapter.getCurrentTimeMs();
    vi.mocked(bridge.getSessionStatus).mockReturnValueOnce(polled.promise);
    vi.mocked(bridge.setSessionBounds).mockReturnValueOnce(positioned.promise);
    await vi.advanceTimersByTimeAsync(250);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 100 });
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 200 });
    adapter.dispose();
    adapter.seek(9_000);
    await flushNativeWork();
    expect(bridge.destroySession).not.toHaveBeenCalled();

    polled.resolve(nativeStatus(500));
    await flushNativeWork();
    expect(bridge.destroySession).not.toHaveBeenCalled();
    positioned.resolve(nativeStatus(800));
    await flushNativeWork();
    expect(bridge.destroySession).toHaveBeenCalledTimes(1);
    expect(adapter.getCurrentTimeMs()).toBe(positionBeforeClose);
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(1);
    await expect(adapter.play()).rejects.toThrow("播放器会话已关闭");
  });

  it("libmpv 几何去重并只保留最新目标，显隐变化保留且回执不改变播放头", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const positioned = deferred<LibMpvSessionStatus>();
    await adapter.load(NATIVE_TEST_SOURCE);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS });
    expect(bridge.setSessionBounds).not.toHaveBeenCalled();
    vi.mocked(bridge.setSessionBounds).mockReturnValueOnce(positioned.promise);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 20 });
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 30 });
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 40 });
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(1);

    vi.mocked(bridge.controlSession).mockResolvedValueOnce(nativeStatus(7_000));
    adapter.seek(7_000);
    await flushNativeWork();
    positioned.resolve(nativeStatus(25));
    await flushNativeWork();
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(2);
    expect(bridge.setSessionBounds).toHaveBeenLastCalledWith({
      sessionId: vi.mocked(bridge.createSession).mock.calls[0]?.[0].sessionId,
      bounds: { ...NATIVE_TEST_BOUNDS, x: 40 }
    });
    expect(adapter.getCurrentTimeMs()).toBe(7_000);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 40, visible: false });
    await flushNativeWork();
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(3);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 40, visible: false });
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(3);
  });

  it("libmpv 几何失败不循环重试，相同目标再次提交可恢复", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    await adapter.load(NATIVE_TEST_SOURCE);
    vi.mocked(bridge.setSessionBounds).mockRejectedValueOnce(new Error("定位失败"));
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, width: 500 });
    await flushNativeWork();
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(1);

    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, width: 500 });
    await flushNativeWork();
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(2);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, width: 500 });
    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(2);
  });

  it("libmpv 几何失败后仍提交更新目标，即使目标等于上一次已确认位置", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    const positioned = deferred<LibMpvSessionStatus>();
    await adapter.load(NATIVE_TEST_SOURCE);
    vi.mocked(bridge.setSessionBounds).mockReturnValueOnce(positioned.promise);
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS, x: 50 });
    adapter.setHostBounds({ ...NATIVE_TEST_BOUNDS });
    positioned.reject(new Error("回执失败，原生位置未知"));
    await flushNativeWork();

    expect(bridge.setSessionBounds).toHaveBeenCalledTimes(2);
    expect(bridge.setSessionBounds).toHaveBeenLastCalledWith({
      sessionId: vi.mocked(bridge.createSession).mock.calls[0]?.[0].sessionId,
      bounds: NATIVE_TEST_BOUNDS
    });
  });

  it("libmpv 状态读取失败后降低频率重试，成功后恢复正常节奏", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    await adapter.load(NATIVE_TEST_SOURCE);
    vi.mocked(bridge.getSessionStatus).mockRejectedValueOnce(new Error("暂时读取失败"));

    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(3);
  });

  it("加载等待复用单飞轮询，暂停时元数据仍通知且位置变化不重复通知", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    vi.mocked(bridge.createSession).mockResolvedValue(loadingStatus());
    vi.mocked(bridge.getSessionStatus).mockResolvedValue({
      ...nativeStatus(),
      durationMs: 8000
    });
    const adapter = createNativeTestAdapter(bridge);
    const listener = vi.fn();
    const unsubscribe = adapter.subscribeStatus(listener);
    let loaded = false;
    const result = adapter.load(NATIVE_TEST_SOURCE, 2000).then(() => {
      loaded = true;
    });
    await flushNativeWork();
    expect(loaded).toBe(false);
    expect(adapter.getDurationMs()).toBe(0);
    expect(bridge.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ startPositionMs: 2000 })
    );
    await vi.advanceTimersByTimeAsync(250);
    await result;
    expect(adapter.getDurationMs()).toBe(8000);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ loadState: "ready", durationMs: 8000 })
    );
    const notifications = listener.mock.calls.length;
    vi.mocked(bridge.getSessionStatus).mockResolvedValue({
      ...nativeStatus(500),
      durationMs: 8000
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledTimes(notifications);
    expect(bridge.getSessionStatus).toHaveBeenCalledTimes(3);
    unsubscribe();
    vi.mocked(bridge.getSessionStatus).mockResolvedValue(nativeStatus());
    await vi.advanceTimersByTimeAsync(250);
    expect(listener).toHaveBeenCalledTimes(notifications);
  });

  it("FILE_LOADED 的零时长直播也能就绪", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    vi.mocked(bridge.createSession).mockResolvedValue(loadingStatus());
    vi.mocked(bridge.getSessionStatus).mockResolvedValue({ ...nativeStatus(), durationMs: 0 });
    const adapter = createNativeTestAdapter(bridge);
    const loaded = adapter.load({
      kind: "url",
      name: "live",
      url: "https://media.example.test/live"
    });
    await flushNativeWork();
    await vi.advanceTimersByTimeAsync(250);
    await loaded;
    expect(adapter.getStatus()).toMatchObject({ loadState: "ready", durationMs: 0 });
  });

  it("同名重载忽略旧文件晚轮询，不以文件名或旧时长完成新加载", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    const adapter = createNativeTestAdapter(bridge);
    await adapter.load(NATIVE_TEST_SOURCE);
    const oldPoll = deferred<LibMpvSessionStatus>();
    vi.mocked(bridge.getSessionStatus).mockReturnValueOnce(oldPoll.promise);
    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(bridge.controlSession).mockResolvedValue(loadingStatus(2));
    let loaded = false;
    const next = adapter.load(NATIVE_TEST_SOURCE).then(() => {
      loaded = true;
    });
    await flushNativeWork();
    oldPoll.resolve({ ...nativeStatus(), durationMs: 9000 });
    await flushNativeWork();
    expect(loaded).toBe(false);
    expect(adapter.getDurationMs()).toBe(0);
    vi.mocked(bridge.getSessionStatus).mockResolvedValue({
      ...nativeStatus(),
      loadRevision: 1
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(loaded).toBe(false);
    vi.mocked(bridge.getSessionStatus).mockResolvedValue({
      ...nativeStatus(),
      loadRevision: 2,
      durationMs: 3000
    });
    await vi.advanceTimersByTimeAsync(250);
    await next;
    expect(adapter.getDurationMs()).toBe(3000);
  });

  it("加载中只保留最新 seek，定位回执返回前继续合并而不提前完成 load", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    vi.mocked(bridge.createSession).mockResolvedValue(loadingStatus());
    vi.mocked(bridge.getSessionStatus).mockResolvedValue(nativeStatus());
    const sought = deferred<LibMpvSessionStatus>();
    vi.mocked(bridge.controlSession)
      .mockReturnValueOnce(sought.promise)
      .mockResolvedValue(nativeStatus(9000));
    const adapter = createNativeTestAdapter(bridge);
    let loaded = false;
    const result = adapter.load(NATIVE_TEST_SOURCE).then(() => {
      loaded = true;
    });
    adapter.seek(5000);
    adapter.seek(7000);
    await flushNativeWork();
    expect(bridge.controlSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(bridge.controlSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "seek", positionMs: 7000 })
    );
    expect(loaded).toBe(false);
    adapter.seek(9000);
    sought.resolve(nativeStatus(7000));
    await result;
    expect(bridge.controlSession).toHaveBeenCalledTimes(2);
    expect(bridge.controlSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "seek", positionMs: 9000 })
    );
    expect(adapter.getCurrentTimeMs()).toBe(9000);
  });

  it("加载失败、超时、新加载和 dispose 都结束等待，失败不毒化后续加载", async () => {
    vi.useFakeTimers();
    const bridge = createLibMpvBridge();
    vi.mocked(bridge.createSession).mockResolvedValue(loadingStatus());
    vi.mocked(bridge.controlSession).mockResolvedValue(loadingStatus());
    vi.mocked(bridge.getSessionStatus).mockResolvedValue({
      ...loadingStatus(),
      loadState: "failed",
      error: "无法解码"
    });
    const adapter = createNativeTestAdapter(bridge);
    const failed = adapter.load(NATIVE_TEST_SOURCE).catch((error: unknown) => error);
    await flushNativeWork();
    await vi.advanceTimersByTimeAsync(250);
    expect(await failed).toMatchObject({ message: "无法解码" });
    vi.mocked(bridge.getSessionStatus).mockResolvedValue(loadingStatus());
    const timedOut = adapter.load(NATIVE_TEST_SOURCE).catch((error: unknown) => error);
    await flushNativeWork();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(String(await timedOut)).toContain("超时");
    const replaced = adapter.load(NATIVE_TEST_SOURCE).catch((error: unknown) => error);
    await flushNativeWork();
    const disposed = adapter.load(NATIVE_TEST_SOURCE).catch((error: unknown) => error);
    expect(String(await replaced)).toContain("替代");
    adapter.dispose();
    expect(String(await disposed)).toContain("关闭");
    await flushNativeWork();
    expect(bridge.destroySession).toHaveBeenCalledTimes(1);
  });
});

function loadingStatus(loadRevision = 1): LibMpvSessionStatus {
  return { ...nativeStatus(), loadRevision, loadState: "loading", durationMs: 0, tracks: [] };
}

const NATIVE_TEST_SOURCE = { kind: "file" as const, name: "test.mkv", url: "D:\\test.mkv" };
const NATIVE_TEST_BOUNDS = { x: 10, y: 20, width: 800, height: 450, visible: true };
const nativeTestAdapters = new Set<TauriLibMpvMediaAdapter>();
let nativeTestSequence = 0;

function createNativeTestAdapter(bridge: TauriLibMpvBridge, sessionId?: string) {
  const adapter = new TauriLibMpvMediaAdapter({
    sessionId: sessionId ?? `native_test_${++nativeTestSequence}`,
    mpvPath: "C:\\tools\\mpv.exe",
    getBounds: () => NATIVE_TEST_BOUNDS,
    bridge
  });
  nativeTestAdapters.add(adapter);
  return adapter;
}

function nativeStatus(positionMs = 0, running = true): LibMpvSessionStatus {
  return {
    sessionId: "test",
    running,
    loadRevision: 1,
    loadState: running ? "ready" : "idle",
    playbackStatus: running ? "paused" : "stopped",
    mediaName: "test.mkv",
    positionMs,
    durationMs: 10_000,
    tracks: [],
    message: "测试状态",
    error: null
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushNativeWork(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function createLibMpvBridge(): TauriLibMpvBridge {
  const status = (overrides: Partial<LibMpvSessionStatus> = {}): LibMpvSessionStatus => ({
    sessionId: "review_1",
    running: true,
    loadRevision: 1,
    loadState: "ready",
    playbackStatus: "paused",
    mediaName: "full.mkv",
    positionMs: 8_765,
    durationMs: 3_000_000,
    tracks: [],
    message: "libmpv 会话可用。",
    error: null,
    ...overrides
  });
  return {
    detectRuntime: vi.fn<TauriLibMpvBridge["detectRuntime"]>(() =>
      Promise.resolve({
        available: true,
        libraryPath: "C:\\tools\\libmpv-2.dll",
        clientApiVersion: "2.5",
        message: "libmpv 2.5 可用。"
      })
    ),
    createSession: vi.fn<TauriLibMpvBridge["createSession"]>(() => Promise.resolve(status())),
    controlSession: vi.fn<TauriLibMpvBridge["controlSession"]>((request) =>
      Promise.resolve(
        status({ playbackStatus: request.action === "play" ? "playing" : "paused" })
      )
    ),
    getSessionStatus: vi.fn<TauriLibMpvBridge["getSessionStatus"]>(() =>
      Promise.resolve(status())
    ),
    setSessionBounds: vi.fn<TauriLibMpvBridge["setSessionBounds"]>(() =>
      Promise.resolve(status())
    ),
    destroySession: vi.fn<TauriLibMpvBridge["destroySession"]>(() =>
      Promise.resolve(status({ running: false, playbackStatus: "stopped" }))
    )
  };
}

function createBridge(): TauriMpvBridge {
  return {
    detectTool: vi.fn<TauriMpvBridge["detectTool"]>(),
    start: vi.fn<TauriMpvBridge["start"]>((request) =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: request.startPaused ? "paused" : "playing",
        mediaPath: request.mediaPath,
        positionMs: request.startPositionMs ?? 0,
        durationMs: 3_000_000,
        tracks: [
          {
            id: 1,
            trackType: "audio",
            title: "日语",
            language: "jpn",
            codec: "aac",
            selected: true,
            external: false
          }
        ],
        message: "mpv 已启动。",
        error: null,
        updatedAtMs: 1
      })
    ),
    stop: vi.fn<TauriMpvBridge["stop"]>(() =>
      Promise.resolve({
        running: false,
        backend: "native-mpv",
        playbackStatus: "stopped",
        mediaPath: null,
        positionMs: 0,
        durationMs: 0,
        tracks: [],
        message: "mpv 已停止。",
        error: null,
        updatedAtMs: 2
      })
    ),
    status: vi.fn<TauriMpvBridge["status"]>(() =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: "playing",
        mediaPath: "D:\\media\\full.mkv",
        positionMs: 12_345,
        durationMs: 3_000_000,
        tracks: [],
        message: "mpv 正在播放。",
        error: null,
        updatedAtMs: 3
      })
    ),
    control: vi.fn<TauriMpvBridge["control"]>((request) =>
      Promise.resolve({
        running: true,
        backend: "native-mpv",
        playbackStatus: request.action === "play" ? "playing" : "paused",
        mediaPath: "D:\\media\\full.mkv",
        positionMs: request.positionMs ?? 12_345,
        durationMs: 3_000_000,
        tracks: [],
        message: "mpv 控制命令已发送。",
        error: null,
        updatedAtMs: 4
      })
    )
  };
}
