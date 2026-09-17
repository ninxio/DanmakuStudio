import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { PublicationLibraryDialog } from "./PublicationLibraryDialog";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("../../infrastructure/private-library/publicationOutbox", () => ({
  listDeliveries: () => Promise.resolve([]),
  loadDelivery: vi.fn()
}));
vi.mock("./PrivateLibraryPublishDialog", () => ({
  PrivateLibraryPublishDialog: () => <div />
}));
it.each([true, false])(
  "shows publication records and respects cloud restore capability %s",
  async (canRestore) => {
    vi.mocked(invoke).mockReset();
    const current = "a".repeat(64),
      older = "b".repeat(64);
    const manifest = { title: "旧名字", kind: "tv", season: 1, episode: 2, commentCount: 12 };
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "browse_private_library" && (args as { workKey?: string })?.workKey)
        return Promise.resolve({
          episodes: [
            {
              episodeId: 2,
              revision: current,
              manifest,
              canonicalMetadata: { title: "新名字", edition: "WEB", sourceLabel: "我的整理" }
            }
          ],
          nextCursor: null
        });
      if (command === "browse_private_library")
        return Promise.resolve({
          works: [
            {
              workKey: "show",
              title: "新名字",
              kind: "tv",
              year: null,
              episodeCount: 1,
              seasonCount: 1
            }
          ]
        });
      if (command === "list_private_library_revisions")
        return Promise.resolve({
          canRestore,
          currentRevision: current,
          revisions: [
            { revision: current, manifest, createdAt: "2026-09-13", isCurrent: true },
            {
              revision: older,
              manifest: { ...manifest, commentCount: 10 },
              createdAt: "2026-09-12",
              isCurrent: false
            }
          ],
          nextCursor: null
        });
      if (command === "rollback_private_library_episode")
        return Promise.reject(new Error("云端版本变化，未覆盖"));
      return Promise.reject(new Error("unexpected command"));
    });
    render(<PublicationLibraryDialog onClose={() => {}} />);
    await screen.findByText(/新名字/);
    fireEvent.click(screen.getByRole("button", { name: "管理与更新" }));
    await screen.findByRole("button", { name: "查看发布记录" });
    expect(screen.queryByText(/旧名字/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看发布记录" }));
    await screen.findByText(/修订 bbbbb/);
    if (!canRestore) {
      expect(screen.getByText(/云端只保存当前播放器数据/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "选择恢复这版" })).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalledWith(
        "rollback_private_library_episode",
        expect.anything()
      );
      return;
    }
    const choices = screen.getAllByRole("button", { name: "选择恢复这版" });
    expect(choices[0]).toBeDisabled();
    fireEvent.click(choices[1]);
    expect(invoke).not.toHaveBeenCalledWith(
      "rollback_private_library_episode",
      expect.objectContaining({ episodeId: 2 })
    );
    fireEvent.click(screen.getByRole("button", { name: "确认恢复选定修订" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("rollback_private_library_episode", {
        episodeId: 2,
        revision: older,
        expectedRevision: current
      })
    );
    await screen.findByText(/云端版本变化，未覆盖/);
    expect(screen.queryByText(/已恢复选定修订/)).not.toBeInTheDocument();
  }
);
it("discards an initial response after search changes and adopts metadata only on explicit selection", async () => {
  vi.mocked(invoke).mockReset();
  let finish!: (value: unknown) => void;
  const canonical = {
    workKey: "show",
    title: "搜索命中",
    kind: "tv",
    year: null,
    aliases: [],
    editionKey: "current",
    edition: "内部",
    sourceKey: "personal",
    sourceLabel: "个人"
  };
  const work = { ...canonical, episodeCount: 1, seasonCount: 1 };
  const row = {
    episodeId: 80,
    revision: "r",
    manifest: { kind: "tv", season: 2, episode: 1, commentCount: 10 },
    canonicalMetadata: canonical
  };
  vi.mocked(invoke).mockImplementation((_command, args) => {
    const params = args as { q?: string; workKey?: string };
    if (params.workKey) return Promise.resolve({ episodes: [row] });
    if (!params.q)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve({ works: [work] });
  });
  const choose = vi.fn();
  render(<PublicationLibraryDialog onClose={() => {}} onChooseProfile={choose} />);
  fireEvent.change(screen.getByLabelText("搜索私人库影视"), { target: { value: "Alias" } });
  await act(() => Promise.resolve(finish({ works: [{ ...work, title: "迟到旧页" }] })));
  expect(screen.queryByText(/迟到旧页/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText(/搜索命中/);
  expect(invoke).toHaveBeenLastCalledWith("browse_private_library", {
    q: "Alias",
    workKey: null
  });
  fireEvent.click(screen.getByRole("button", { name: "管理与更新" }));
  await screen.findByRole("button", { name: "用于本项目资料" });
  expect(choose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "用于本项目资料" }));
  expect(choose).toHaveBeenCalledWith({ ...canonical, schemaVersion: 1, season: 2 });
});

it("can hide an unreviewed legacy episode without approving it and confirms the exact revision", async () => {
  vi.mocked(invoke).mockReset();
  const work = {
    workKey: "movie",
    title: "待检查电影",
    kind: "movie",
    year: null,
    episodeCount: 1,
    seasonCount: 0,
    pendingCount: 1,
    visibleCount: 1
  };
  const row = {
    episodeId: 91,
    revision: "a".repeat(64),
    reviewStatus: "pending",
    isVisible: true,
    canonicalMetadata: work,
    manifest: { kind: "movie", season: 0, episode: 1, commentCount: 12 }
  };
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "review_private_library_episode") {
      row.isVisible = false;
      return Promise.resolve({});
    }
    if (command === "browse_private_library")
      return Promise.resolve(
        (args as { workKey?: string }).workKey ? { episodes: [row] } : { works: [work] }
      );
    return Promise.reject(new Error("unexpected command"));
  });
  render(<PublicationLibraryDialog onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "管理与更新" }));
  fireEvent.click(await screen.findByRole("button", { name: /^暂不上架$/ }));
  expect(invoke).not.toHaveBeenCalledWith("review_private_library_episode", expect.anything());
  expect(screen.queryByText(/第 0 季/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认暂不上架" }));
  await screen.findByText("已退回待检查并下架，内容保留。");
  expect(invoke).toHaveBeenCalledWith("review_private_library_episode", {
    episodeId: 91,
    revision: row.revision,
    approved: false
  });
  expect(screen.getByText(/12 条 · 待检查 · 未上架/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^暂不上架$/ })).not.toBeInTheDocument();
});
