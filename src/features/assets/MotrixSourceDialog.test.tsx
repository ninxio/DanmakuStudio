import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { MotrixSourceDialog } from "./MotrixSourceDialog";
import { pickSingleNativeDirectoryPath } from "../../infrastructure/file-system/nativeDialogs";
vi.mock("../../infrastructure/file-system/nativeDialogs", () => ({
  pickSingleNativeDirectoryPath: vi.fn(() => Promise.resolve("I:/New"))
}));
import {
  getMotrixWorkspace,
  fetchSourcePage,
  addMotrixDownload,
  repairMotrixDownload,
  verifiedMotrixFiles
} from "../../infrastructure/acquisition/motrixClient";
vi.mock("../../infrastructure/acquisition/motrixClient", () => ({
  getMotrixWorkspace: vi.fn(),
  fetchSourcePage: vi.fn(),
  addMotrixDownload: vi.fn(),
  repairMotrixDownload: vi.fn(),
  verifiedMotrixFiles: vi.fn(),
  refreshMotrixDownloads: vi.fn(() => Promise.resolve([])),
  openSourcePage: vi.fn(() => Promise.resolve()),
  openSourceBrowser: vi.fn(() => Promise.resolve()),
  listenSourceMagnet: vi.fn(() => Promise.resolve(() => {})),
  acquisitionError: (e: unknown) => (e instanceof Error ? e.message : String(e))
}));
const item = {
  key: "k",
  projectId: "p",
  title: "原片",
  uri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
  saveDir: "I:/Media",
  taskId: "t",
  status: "completed",
  progress: 1,
  message: "",
  files: ["I:/Media/E01.mkv"]
};
describe("原片获取闭环", () => {
  it("重复资源提供一次修复入口，不把换目录当成解除资源占用", async () => {
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: item.saveDir,
      downloads: [
        {
          ...item,
          taskId: null,
          status: "duplicate_conflict",
          files: [],
          message: "同一资源的旧失败任务仍占用下载；修复时保留文件。"
        }
      ]
    });
    vi.mocked(repairMotrixDownload).mockResolvedValue({
      ...item,
      status: "downloading",
      files: []
    });
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={() => 0} />);
    const repair = await screen.findByRole("button", { name: "修复重复任务并重试" });
    expect(screen.queryByRole("button", { name: "换目录重新下载" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试原请求" })).not.toBeInTheDocument();
    expect(repairMotrixDownload).not.toHaveBeenCalled();
    fireEvent.click(repair);
    await waitFor(() => expect(repairMotrixDownload).toHaveBeenCalledTimes(1));
    expect(repairMotrixDownload).toHaveBeenCalledWith("p", "k");
    await screen.findByText("下载中 · 100%");
  });
  it("失败任务可明确修复，做种中的已核验原片可导入", async () => {
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: item.saveDir,
      downloads: [{ ...item, status: "error", files: [] }]
    });
    vi.mocked(repairMotrixDownload).mockResolvedValue({ ...item, status: "seeding" });
    vi.mocked(verifiedMotrixFiles).mockResolvedValue(item.files);
    const onImport = vi.fn(() => 1);
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={onImport} />);
    fireEvent.click(await screen.findByRole("button", { name: "修复路径并重试" }));
    await waitFor(() => expect(repairMotrixDownload).toHaveBeenCalledWith("p", "k"));
    const button = screen.getByRole("button", { name: "导入完成的原片" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(item.files));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: "I:/Media",
      downloads: []
    });
  });
  it("显式发送磁力，双击只提交一次并保留任务记录", async () => {
    vi.mocked(addMotrixDownload).mockResolvedValue({ ...item, status: "queued", files: [] });
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={() => 0} />);
    await screen.findByText("Motrix 已连接");
    fireEvent.change(screen.getByLabelText("磁力链接或 Info Hash"), {
      target: { value: "a".repeat(40) }
    });
    const submit = screen.getByRole("button", { name: "发送到 Motrix" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await screen.findByText(/已交给 Motrix/);
    expect(addMotrixDownload).toHaveBeenCalledTimes(1);
    expect(addMotrixDownload).toHaveBeenCalledWith("p", "原片下载", item.uri, "I:/Media");
  });
  it("恢复下载后重新验证完成文件再导入，不依据旧列表猜路径", async () => {
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: "I:/Media",
      downloads: [item]
    });
    vi.mocked(verifiedMotrixFiles).mockResolvedValue(["I:/Media/E01.final.mkv"]);
    const onImport = vi.fn(() => 1);
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={onImport} />);
    const button = await screen.findByRole("button", { name: "导入完成的原片" });
    fireEvent.click(button);
    await waitFor(() => expect(onImport).toHaveBeenCalledWith(["I:/Media/E01.final.mkv"]));
    expect(verifiedMotrixFiles).toHaveBeenCalledWith("p", "k");
  });
  it("网络失败显示原因且保留网页与粘贴入口", async () => {
    vi.mocked(fetchSourcePage).mockRejectedValue(new Error("网站返回 HTTP 403"));
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={() => 0} />);
    fireEvent.change(screen.getByLabelText("片名或 IMDb 编号"), {
      target: { value: "Example" }
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索原片" }));
    await screen.findByText("网站返回 HTTP 403");
    expect(screen.getByRole("button", { name: "打开搜索网页" })).toBeEnabled();
    expect(screen.getByLabelText("磁力链接或 Info Hash")).toBeEnabled();
  });
  it("已移除任务只能由用户明确重新创建", async () => {
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: "I:/Media",
      downloads: [{ ...item, status: "missing", files: [] }]
    });
    vi.mocked(addMotrixDownload).mockResolvedValue({
      ...item,
      taskId: "new",
      status: "queued",
      files: []
    });
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={() => 0} />);
    const recreate = await screen.findByRole("button", { name: "重新创建下载" });
    expect(addMotrixDownload).not.toHaveBeenCalled();
    fireEvent.click(recreate);
    await waitFor(() =>
      expect(addMotrixDownload).toHaveBeenCalledWith(
        "p",
        item.title,
        item.uri,
        item.saveDir,
        true
      )
    );
  });
  it("导入没有新增素材时不报告成功数量", async () => {
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: "I:/Media",
      downloads: [item]
    });
    vi.mocked(verifiedMotrixFiles).mockResolvedValue(item.files);
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={() => 0} />);
    fireEvent.click(await screen.findByRole("button", { name: "导入完成的原片" }));
    await screen.findByText(/没有新增原片/);
    expect(screen.queryByText(/已导入 1 个原片/)).not.toBeInTheDocument();
  });
  it("目录冲突后可以用原磁力在新目录重建", async () => {
    vi.mocked(getMotrixWorkspace).mockResolvedValue({
      connected: true,
      message: "Motrix 已连接",
      defaultDirectory: "I:/Media",
      downloads: [{ ...item, taskId: null, status: "uncertain", files: [] }]
    });
    vi.mocked(addMotrixDownload).mockResolvedValue({
      ...item,
      key: "new",
      saveDir: "I:/New",
      status: "queued",
      files: []
    });
    render(<MotrixSourceDialog open projectId="p" onClose={() => {}} onImport={() => 0} />);
    fireEvent.click(await screen.findByRole("button", { name: "换目录重新下载" }));
    await waitFor(() =>
      expect(addMotrixDownload).toHaveBeenCalledWith("p", item.title, item.uri, "I:/New", true)
    );
    expect(pickSingleNativeDirectoryPath).toHaveBeenCalledTimes(1);
  });
});
