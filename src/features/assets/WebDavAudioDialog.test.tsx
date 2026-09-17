import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebDavAudioDialog } from "./WebDavAudioDialog";
import type * as WebDavModule from "../../infrastructure/acquisition/webdavClient";
import {
  webdavClient,
  type WebDavWorkspace,
  type WebDavJob
} from "../../infrastructure/acquisition/webdavClient";
vi.mock("../../infrastructure/acquisition/webdavClient", async (load) => ({
  ...(await load<typeof WebDavModule>()),
  webdavClient: {
    workspace: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
    inspect: vi.fn(),
    prepareSource: vi.fn(),
    inspectSource: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    forget: vi.fn(),
    import: vi.fn()
  }
}));
const connection = { id: "c", name: "我的网盘", root: "https://dav.example/dav/" };
const inspection = {
  probeId: "p",
  name: "Show.S01E02.mkv",
  sourcePresentationOriginMs: 0,
  sourceReportedDurationMs: 10000,
  streams: [{ index: 2, codec: "aac", language: "eng", title: "English", channels: 2 }]
};
const job: WebDavJob = {
  id: "j",
  connectionId: "c",
  href: "/dav/Show.S01E02.mkv",
  name: inspection.name,
  streamIndex: 2,
  status: "completed",
  message: "已缓存，等待导入",
  createdAtMs: 0,
  directory: "I:/cache/j"
};
const draft = {
  localPath: "I:/cache/j/audio.flac",
  fileName: "Show.S01E02.audio-2-j.flac",
  durationMs: 2000,
  name: inspection.name,
  audioTrackLabel: "音轨 2"
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WebDAV 音轨获取", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(webdavClient.workspace).mockResolvedValue({
      connections: [connection],
      jobs: []
    });
  });
  it("真实入口合同串联目录、选音轨、后台任务及明确导入", async () => {
    vi.mocked(webdavClient.list).mockResolvedValue([
      { href: job.href, name: job.name, directory: false, size: 2048 }
    ]);
    vi.mocked(webdavClient.inspect).mockResolvedValue(inspection);
    vi.mocked(webdavClient.start).mockImplementation(() => {
      vi.mocked(webdavClient.workspace).mockResolvedValue({
        connections: [connection],
        jobs: [job]
      });
      return Promise.resolve(job);
    });
    vi.mocked(webdavClient.import).mockResolvedValue(draft);
    const onImport = vi.fn();
    render(<WebDavAudioDialog open onClose={() => {}} onImport={onImport} />);
    await screen.findByRole("option", { name: connection.name });
    fireEvent.change(screen.getByLabelText("WebDAV 连接"), { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: "打开根目录" }));
    fireEvent.click(await screen.findByRole("button", { name: /文件：Show/ }));
    fireEvent.click(await screen.findByRole("button", { name: "缓存所选音轨" }));
    await waitFor(() => expect(webdavClient.start).toHaveBeenCalledWith("p", 2));
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "验证并导入当前项目" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(draft));
  });
  it("失败探测提供明确临时原片任务，重启后的等待音轨任务可继续", async () => {
    vi.mocked(webdavClient.workspace).mockResolvedValue({
      connections: [connection],
      jobs: [{ ...job, status: "awaitingTrack", message: "下载完毕" }]
    });
    vi.mocked(webdavClient.inspectSource).mockResolvedValue(inspection);
    render(<WebDavAudioDialog open onClose={() => {}} onImport={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "探测临时原片并选音轨" }));
    await screen.findByRole("button", { name: "缓存所选音轨" });
    expect(webdavClient.inspectSource).toHaveBeenCalledWith("j", null);
  });
  it("关闭不会取消后台任务，重开显示任务而不接受迟到导入", async () => {
    vi.mocked(webdavClient.workspace).mockResolvedValue({
      connections: [connection],
      jobs: [job]
    });
    const pending = deferred<typeof draft>();
    vi.mocked(webdavClient.import).mockReturnValue(pending.promise);
    const onImport = vi.fn();
    const props = { onClose: () => {}, onImport };
    const view = render(<WebDavAudioDialog open {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "验证并导入当前项目" }));
    view.rerender(<WebDavAudioDialog open={false} {...props} />);
    await act(async () => {
      pending.resolve(draft);
      await pending.promise;
    });
    expect(onImport).not.toHaveBeenCalled();
    expect(webdavClient.cancel).not.toHaveBeenCalled();
    view.rerender(<WebDavAudioDialog open {...props} />);
    await screen.findByRole("button", { name: "验证并导入当前项目" });
  });
  it("导入绑定点击时的项目闭包，切换后由旧闭包拒绝，不能导入新项目", async () => {
    vi.mocked(webdavClient.workspace).mockResolvedValue({
      connections: [connection],
      jobs: [job]
    });
    const pending = deferred<typeof draft>();
    vi.mocked(webdavClient.import).mockReturnValue(pending.promise);
    const old = vi.fn(() => {
      throw new Error("项目已切换");
    });
    const next = vi.fn();
    const view = render(<WebDavAudioDialog open onClose={() => {}} onImport={old} />);
    fireEvent.click(await screen.findByRole("button", { name: "验证并导入当前项目" }));
    view.rerender(<WebDavAudioDialog open onClose={() => {}} onImport={next} />);
    await act(async () => {
      pending.resolve(draft);
      await pending.promise;
    });
    expect(old).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    await screen.findByText("Error: 项目已切换");
  });
  it("保存后的迟到刷新不能跨关闭重开覆盖新状态", async () => {
    const pending = deferred<WebDavWorkspace>();
    vi.mocked(webdavClient.save).mockResolvedValue(connection);
    vi.mocked(webdavClient.workspace)
      .mockResolvedValueOnce({ connections: [], jobs: [] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ connections: [], jobs: [] });
    const props = { onClose: () => {}, onImport: () => {} };
    const view = render(<WebDavAudioDialog open {...props} />);
    fireEvent.change(screen.getByLabelText("连接名称"), { target: { value: "旧输入" } });
    fireEvent.change(screen.getByLabelText("WebDAV 根目录 URL"), {
      target: { value: connection.root }
    });
    fireEvent.click(screen.getByRole("button", { name: "加密保存连接" }));
    await waitFor(() => expect(webdavClient.workspace).toHaveBeenCalledTimes(2));
    view.rerender(<WebDavAudioDialog open={false} {...props} />);
    view.rerender(<WebDavAudioDialog open {...props} />);
    await act(async () => {
      pending.resolve({ connections: [connection], jobs: [] });
      await pending.promise;
    });
    expect(screen.getByLabelText("WebDAV 连接")).toHaveValue("");
    expect(screen.queryByText("连接已加密保存，请点击打开根目录。")).not.toBeInTheDocument();
  });
});
