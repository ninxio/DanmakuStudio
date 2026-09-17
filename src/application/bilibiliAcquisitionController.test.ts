import { describe, expect, it, vi } from "vitest";
import {
  createBilibiliAcquisitionController,
  type BilibiliAcquisitionDependencies,
  type BilibiliSavedJob
} from "./bilibiliAcquisitionController";
import type {
  BilibiliDownloadOutcome,
  BilibiliProgress
} from "../infrastructure/bilibili/bilibiliClient";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const context = { projectId: "p", projectEpoch: 1, projectName: "原项目" };
const draft = {
  input: "BV1xx411c7mD",
  selectedCids: [1, 3],
  outputFolder: "C:/media",
  downloadAudio: false
};
const row = {
  bvid: draft.input,
  aid: 1,
  cid: 1,
  page: 1,
  part: "第一部分",
  durationMs: 60_000,
  exactDuration: true,
  danmakuCount: 0,
  xmlPath: "C:/media/a.xml",
  audioPath: null
};
const summary = { added: 1, reused: 0, preserved: 0, audioAdded: 0, bound: 0 };
function setup(saved: BilibiliSavedJob | null = null) {
  const pending = deferred<BilibiliDownloadOutcome>();
  let progress!: (value: BilibiliProgress) => void;
  let current = context;
  const unlisten = vi.fn();
  const deps: BilibiliAcquisitionDependencies = {
    download: vi.fn(() => pending.promise),
    cancel: vi.fn(() => Promise.resolve(true)),
    listen: vi.fn((callback: (progress: BilibiliProgress) => void) => {
      progress = callback;
      return Promise.resolve(unlisten);
    }),
    importResults: vi.fn(() => Promise.resolve(summary)),
    currentContext: () => current,
    save: vi.fn(),
    load: () => saved,
    createRequestId: () => "job"
  };
  const controller = createBilibiliAcquisitionController(deps);
  return {
    controller,
    deps,
    pending,
    unlisten,
    progress: (p: BilibiliProgress) => progress(p),
    switchProject: () => {
      current = { ...context, projectEpoch: 2 };
    }
  };
}
describe("Bilibili acquisition lifecycle", () => {
  it("retries the original P selection using the current folder and audio option", async () => {
    const env = setup();
    env.pending.resolve({
      requestId: "job",
      status: "failed",
      results: [],
      error: "无可用音轨"
    });
    await env.controller.start({ ...draft, downloadAudio: true });
    env.switchProject();
    await env.controller.retry("new-cookie", {
      outputFolder: "D:/fixed",
      downloadAudio: false
    });
    expect(env.deps.download).toHaveBeenLastCalledWith({
      ...draft,
      outputFolder: "D:/fixed",
      downloadAudio: false,
      requestId: "job",
      cookie: "new-cookie"
    });
    expect(env.controller.getSnapshot().context).toEqual(context);
  });
  it("continues without a UI subscriber and imports partial success after an error", async () => {
    const env = setup();
    const unsubscribe = env.controller.subscribe(vi.fn());
    const running = env.controller.start(draft, "SESSDATA=secret");
    unsubscribe();
    await Promise.resolve();
    env.progress({
      requestId: "old-job",
      stage: "audio",
      current: 1,
      total: 2,
      page: 1,
      percent: 40,
      message: "old"
    });
    expect(env.controller.getSnapshot().progress).toBeNull();
    env.pending.resolve({
      requestId: "job",
      status: "failed",
      results: [row],
      error: "code -412 请稍后重试"
    });
    await running;
    expect(env.deps.importResults).toHaveBeenCalledWith([row], context);
    expect(env.controller.getSnapshot()).toMatchObject({
      phase: "failed",
      importSummary: summary
    });
    expect(env.controller.getSnapshot().message).toContain("-412");
    expect(JSON.stringify(vi.mocked(env.deps.save).mock.calls)).not.toContain("secret");
    expect(env.unlisten).toHaveBeenCalledOnce();
  });
  it("does not write into a new session, even when it has the same project ID", async () => {
    const env = setup();
    const running = env.controller.start(draft);
    env.switchProject();
    env.pending.resolve({ requestId: "job", status: "completed", results: [row], error: null });
    await running;
    expect(env.deps.importResults).not.toHaveBeenCalled();
    expect(env.controller.getSnapshot().phase).toBe("pendingImport");
    await env.controller.importIntoCurrentProject();
    expect(env.deps.importResults).toHaveBeenCalledWith([row], { ...context, projectEpoch: 2 });
  });
  it("retains files for retry when import fails or project changes during parsing", async () => {
    const env = setup();
    vi.mocked(env.deps.importResults).mockResolvedValue(null);
    const running = env.controller.start(draft);
    env.pending.resolve({ requestId: "job", status: "completed", results: [row], error: null });
    await running;
    expect(env.controller.getSnapshot()).toMatchObject({
      phase: "pendingImport",
      outcome: { results: [row] }
    });
    vi.mocked(env.deps.importResults).mockRejectedValueOnce(new Error("文件暂时不可读"));
    await env.controller.importIntoCurrentProject();
    expect(env.controller.getSnapshot().message).toContain("文件暂时不可读");
    vi.mocked(env.deps.importResults).mockResolvedValue(summary);
    await env.controller.importIntoCurrentProject();
    expect(env.controller.getSnapshot().phase).toBe("completed");
  });
  it("cancels before event subscription is ready without starting a native download", async () => {
    const env = setup();
    const listening = deferred<() => void>();
    vi.mocked(env.deps.listen).mockReturnValue(listening.promise);
    const running = env.controller.start(draft);
    await env.controller.cancel();
    listening.resolve(env.unlisten);
    await running;
    expect(env.deps.download).not.toHaveBeenCalled();
    expect(env.controller.getSnapshot().phase).toBe("cancelled");
  });
  it("rejects a second active job and keeps the first cancellation identity", async () => {
    const env = setup();
    const running = env.controller.start(draft);
    await Promise.resolve();
    await expect(env.controller.start(draft)).rejects.toThrow("正在运行");
    await env.controller.cancel();
    expect(env.deps.cancel).toHaveBeenCalledWith("job");
    env.pending.resolve({ requestId: "job", status: "cancelled", results: [row], error: null });
    await running;
    expect(env.deps.importResults).toHaveBeenCalledOnce();
    expect(env.controller.getSnapshot().phase).toBe("cancelled");
  });
  it("restores an interrupted job without automatically requesting the network", () => {
    const env = setup({ version: 1, draft, context, results: [row], phase: "running" });
    expect(env.controller.getSnapshot().phase).toBe("pendingImport");
    expect(env.deps.download).not.toHaveBeenCalled();
    expect(env.deps.importResults).not.toHaveBeenCalled();
  });
  it("ignores a cancellation response belonging to the previous job", async () => {
    const env = setup();
    let sequence = 0;
    env.deps.createRequestId = () => `job-${++sequence}`;
    const oldCancel = deferred<boolean>();
    vi.mocked(env.deps.cancel).mockReturnValueOnce(oldCancel.promise).mockResolvedValue(true);
    const first = env.controller.start(draft);
    await Promise.resolve();
    const cancelling = env.controller.cancel();
    env.pending.resolve({ requestId: "job-1", status: "completed", results: [], error: null });
    await first;
    const secondDownload = deferred<BilibiliDownloadOutcome>();
    vi.mocked(env.deps.download).mockReturnValueOnce(secondDownload.promise);
    const second = env.controller.start(draft);
    await Promise.resolve();
    oldCancel.resolve(true);
    await cancelling;
    await env.controller.cancel();
    expect(env.deps.cancel).toHaveBeenLastCalledWith("job-2");
    secondDownload.resolve({
      requestId: "job-2",
      status: "cancelled",
      results: [],
      error: null
    });
    await second;
  });
  it("storage failure does not discard a completed result", async () => {
    const env = setup();
    vi.mocked(env.deps.save).mockImplementation(() => {
      throw new Error("quota");
    });
    const running = env.controller.start(draft);
    env.pending.resolve({ requestId: "job", status: "completed", results: [row], error: null });
    await running;
    expect(env.controller.getSnapshot().phase).toBe("completed");
    expect(env.controller.getSnapshot().storageWarning).toContain("未保存");
  });
});
