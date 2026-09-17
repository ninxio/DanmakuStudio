import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyPublicationDialog as PrivateLibraryPublishDialog } from "./LegacyPublicationDialog";
import { publishPrivateLibraryXml } from "../../infrastructure/private-library/privateLibrary";
import {
  recordPublicationDelivery,
  readPublicationDelivery
} from "../../application/publicationDelivery";

vi.mock("../../infrastructure/private-library/privateLibrary", () => ({
  publishPrivateLibraryXml: vi.fn(),
  privateLibraryStatus: vi.fn(() =>
    Promise.resolve({
      configured: true,
      baseUrl: "https://private.test",
      hasReadToken: true
    })
  ),
  privateLibraryError: (e: unknown) => (e instanceof Error ? e.message : String(e))
}));
function delivery(names = ["finished.xml"]) {
  const files = names.map((fileName) => ({
    fileName,
    content: `<i><d p="1.001,1,25,16711680,0,0,u,1">${fileName}</d></i>`
  }));
  recordPublicationDelivery(
    { id: "publication-test", updatedAt: "v1", name: "测试剧集" },
    "xml",
    files
  );
  const snapshot = readPublicationDelivery()!;
  files[0].content = "changed after export";
  return snapshot;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
describe("private library publication", () => {
  it("requires episode confirmation and publishes the frozen export, never later edits", async () => {
    vi.mocked(publishPrivateLibraryXml).mockResolvedValue({
      episodeId: 1,
      animeId: 1,
      revision: "a",
      commentCount: 1
    });
    const snapshot = delivery();
    render(<PrivateLibraryPublishDialog delivery={snapshot} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("观看版本"), { target: { value: "WEB 版" } });
    fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
    expect(publishPrivateLibraryXml).not.toHaveBeenCalled();
    expect(screen.getByText(/请确认每个文件的集数/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "按列表顺序填入集数" }));
    fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
    await waitFor(() => expect(screen.getByText(/本次 1 集已上传/)).toBeVisible());
    expect(publishPrivateLibraryXml).toHaveBeenCalledWith(
      snapshot.files[0].content,
      expect.objectContaining({
        title: "测试剧集",
        season: 1,
        episode: 1,
        allowAutoMatch: false
      })
    );
    expect(snapshot.files[0].content).not.toContain("changed after export");
  });
  it("keeps partial success distinct and allows an idempotent retry", async () => {
    vi.mocked(publishPrivateLibraryXml)
      .mockResolvedValueOnce({ episodeId: 1, animeId: 1, revision: "a", commentCount: 1 })
      .mockRejectedValueOnce(new Error("连接中断"));
    render(
      <PrivateLibraryPublishDialog
        delivery={delivery(["S01E01.xml", "S01E02.xml"])}
        onClose={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText("观看版本"), { target: { value: "蓝光" } });
    fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
    await waitFor(() => expect(screen.getByText(/本次已完成 1 集，其余未完成/)).toBeVisible());
    expect(screen.getByText(/已上传并核验/)).toBeVisible();
    expect(screen.getByText(/未完成：连接中断/)).toBeVisible();
    const firstKey = vi.mocked(publishPrivateLibraryXml).mock.calls[0][1].workKey;
    vi.mocked(publishPrivateLibraryXml).mockResolvedValue({
      episodeId: 2,
      animeId: 1,
      revision: "b",
      commentCount: 1
    });
    fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
    await waitFor(() => expect(screen.getByText(/本次 2 集已上传/)).toBeVisible());
    expect(vi.mocked(publishPrivateLibraryXml).mock.calls[2][1].workKey).toBe(firstKey);
  });
  it("prevents a second publish and closing while a file is in flight", async () => {
    let finish!: (value: {
      episodeId: number;
      animeId: number;
      revision: string;
      commentCount: number;
    }) => void;
    vi.mocked(publishPrivateLibraryXml).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const close = vi.fn();
    render(<PrivateLibraryPublishDialog delivery={delivery(["S01E01.xml"])} onClose={close} />);
    fireEvent.change(screen.getByLabelText("观看版本"), { target: { value: "WEB" } });
    fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
    expect(screen.getByRole("button", { name: "正在发布…" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    await waitFor(() => expect(publishPrivateLibraryXml).toHaveBeenCalledTimes(1));
    await act(() =>
      Promise.resolve(finish({ episodeId: 1, animeId: 1, revision: "r", commentCount: 1 }))
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" })).toBeEnabled());
  });
});
