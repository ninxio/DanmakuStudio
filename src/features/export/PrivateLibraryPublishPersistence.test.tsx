import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { PublicationDelivery } from "../../application/publicationDelivery";
import { LegacyPublicationDialog as PrivateLibraryPublishDialog } from "./LegacyPublicationDialog";
import * as outbox from "../../infrastructure/private-library/publicationOutbox";
import * as library from "../../infrastructure/private-library/privateLibrary";
import { createLibraryProfile } from "../../domain/project/discovery";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("./PrivateLibraryConnectionPanel", () => ({
  PrivateLibraryConnectionPanel: () => <div>连接已保存</div>
}));
vi.mock("../../infrastructure/private-library/publicationOutbox", () => ({
  persistDelivery: vi.fn(),
  loadDelivery: vi.fn(),
  savePublicationDraft: vi.fn()
}));
vi.mock("../../infrastructure/private-library/privateLibrary", () => ({
  publishPrivateLibraryXml: vi.fn(),
  preparePrivateLibraryPublication: vi.fn(),
  getPrivateLibraryMetadata: vi.fn(),
  privateLibraryError: String
}));
const delivery: PublicationDelivery = {
  projectId: "durable-p",
  projectName: "持久化测试",
  projectUpdatedAt: "2026-09-13",
  kind: "family",
  createdAt: "2026-09-13",
  files: [1, 2].map((n) => ({ fileName: `S01E0${n}.xml`, content: `<i><!--${n}--></i>` }))
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(outbox.persistDelivery).mockResolvedValue({
    key: "record",
    projectId: delivery.projectId,
    projectName: delivery.projectName,
    createdAt: delivery.createdAt,
    fileCount: 2,
    byteCount: 60
  });
  vi.mocked(outbox.loadDelivery).mockResolvedValue({ key: "record", delivery, draft: null });
  vi.mocked(library.getPrivateLibraryMetadata).mockResolvedValue(null);
  vi.mocked(library.preparePrivateLibraryPublication).mockImplementation((metadata) =>
    Promise.resolve({
      expectedRevision: null,
      connectionScope: "https://private.test",
      identity: `episode-${metadata.episode}`
    })
  );
});
it("restores the draft and partial receipts after a failed batch and a remount", async () => {
  let stored: unknown = null;
  vi.mocked(outbox.savePublicationDraft).mockImplementation(async (_key, draft) => {
    await Promise.resolve();
    stored = structuredClone(draft);
  });
  const receipt = {
    episodeId: 100,
    animeId: 10,
    revision: "a".repeat(64),
    commentCount: 1,
    metadataVersion: 1
  };
  vi.mocked(library.publishPrivateLibraryXml)
    .mockResolvedValueOnce(receipt)
    .mockRejectedValueOnce(new Error("连接中断"));
  const first = render(<PrivateLibraryPublishDialog delivery={delivery} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("观看版本")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("观看版本"), { target: { value: "WEB 修整版" } });
  fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
  await screen.findByText(/本次已完成 1 集，其余未完成/);
  expect(library.publishPrivateLibraryXml).toHaveBeenNthCalledWith(
    2,
    delivery.files[1].content,
    expect.objectContaining({ expectedMetadataVersion: 1, episode: 2 }),
    expect.objectContaining({ expectedRevision: null, identity: "episode-2" })
  );
  expect(stored).toMatchObject({
    schemaVersion: 1,
    details: { edition: "WEB 修整版", metadataVersion: 1 },
    rows: [{ receipt }, { message: expect.stringContaining("连接中断") as unknown }]
  });
  first.unmount();
  vi.mocked(outbox.loadDelivery).mockResolvedValue({ key: "record", delivery, draft: stored });
  vi.mocked(library.publishPrivateLibraryXml).mockResolvedValue(receipt);
  render(<PrivateLibraryPublishDialog delivery={delivery} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("观看版本")).toHaveValue("WEB 修整版"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "发布选中的成品" })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
  await screen.findByText(/本次 2 集已上传并完成云端回读/);
  expect(library.publishPrivateLibraryXml).toHaveBeenCalledTimes(4);
  expect(library.preparePrivateLibraryPublication).toHaveBeenCalledTimes(2);
  expect(vi.mocked(library.publishPrivateLibraryXml).mock.calls[2][2]?.expectedRevision).toBe(
    receipt.revision
  );
  expect(
    vi.mocked(library.publishPrivateLibraryXml).mock.calls[3][2]?.expectedRevision
  ).toBeNull();
});
it("keeps an existing draft editable when cloud metadata is unavailable", async () => {
  localStorage.setItem(
    `danmaku.privateLibrary.details.v1.${delivery.projectId}`,
    JSON.stringify({
      workKey: "w",
      editionKey: "e",
      title: "离线项目",
      edition: "旧版",
      aliases: "",
      year: "",
      kind: "tv",
      season: "1"
    })
  );
  vi.mocked(library.getPrivateLibraryMetadata).mockRejectedValue(new Error("网络断开"));
  render(<PrivateLibraryPublishDialog delivery={delivery} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("观看版本")).toBeEnabled());
  await screen.findByText(/网络断开/);
  fireEvent.change(screen.getByLabelText("观看版本"), { target: { value: "离线修改" } });
  expect(screen.getByLabelText("观看版本")).toHaveValue("离线修改");
  expect(screen.getByRole("button", { name: "载入云端最新作品信息" })).toBeEnabled();
});
it("new snapshots retain renamed profile fields while acquiring the actual cloud metadata CAS", async () => {
  const profile = {
    ...createLibraryProfile("stable", "新作品"),
    aliases: ["新别名"],
    sourceLabel: "新来源名",
    kind: "tv" as const,
    season: 1,
    edition: "WEB"
  };
  const next = { ...delivery, libraryProfile: profile };
  localStorage.setItem(
    `danmaku.privateLibrary.details.v1.${delivery.projectId}`,
    JSON.stringify({
      ...profile,
      title: "本机旧名字",
      aliases: "本机旧别名",
      season: "1",
      year: "",
      metadataVersion: 99
    })
  );
  vi.mocked(library.getPrivateLibraryMetadata).mockResolvedValue({
    metadataVersion: 7,
    canonicalMetadata: {
      ...profile,
      title: "云端旧名字",
      aliases: ["云端旧别名"],
      sourceLabel: "云端旧来源名"
    }
  });
  vi.mocked(library.publishPrivateLibraryXml).mockResolvedValue({
    episodeId: 1,
    animeId: 1,
    revision: "a".repeat(64),
    commentCount: 1,
    metadataVersion: 8
  });
  render(<PrivateLibraryPublishDialog delivery={next} onClose={() => {}} />);
  await waitFor(() => expect(library.getPrivateLibraryMetadata).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByLabelText("观看版本")).toBeEnabled());
  expect(screen.getByLabelText("作品名称")).toHaveValue("新作品");
  expect(screen.getByLabelText("别名（用逗号分隔）")).toHaveValue("新别名");
  fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
  await waitFor(() => expect(library.publishPrivateLibraryXml).toHaveBeenCalled());
  expect(vi.mocked(library.publishPrivateLibraryXml).mock.calls[0][1]).toMatchObject({
    title: "新作品",
    aliases: ["新别名"],
    sourceLabel: "新来源名",
    expectedMetadataVersion: 7
  });
});
it("restores an old mixed-season draft and CAS untouched but blocks publication visibly", async () => {
  const mixed = {
    ...delivery,
    files: [delivery.files[0], { ...delivery.files[1], fileName: "S02E01.xml" }]
  };
  const baseline = {
    expectedRevision: "a".repeat(64),
    connectionScope: "test",
    identity: "old"
  };
  const draft = {
    schemaVersion: 1,
    details: {
      workKey: "w",
      editionKey: "e",
      title: "旧草稿",
      aliases: "旧别名",
      year: "",
      kind: "tv",
      season: "1",
      edition: "WEB",
      metadataVersion: 3
    },
    rows: [1, 2].map((n) => ({
      selected: true,
      episode: String(n),
      fileName: "",
      auto: false,
      message: "已有回执",
      baseline,
      receipt: { revision: "old" }
    }))
  };
  vi.mocked(outbox.loadDelivery).mockResolvedValue({ key: "record", delivery: mixed, draft });
  render(<PrivateLibraryPublishDialog delivery={mixed} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("作品名称")).toHaveValue("旧草稿"));
  fireEvent.click(screen.getByRole("button", { name: "发布选中的成品" }));
  await screen.findAllByText(/多个明确季号/);
  expect(library.publishPrivateLibraryXml).not.toHaveBeenCalled();
  expect(library.preparePrivateLibraryPublication).not.toHaveBeenCalled();
  expect(library.getPrivateLibraryMetadata).not.toHaveBeenCalled();
  expect(screen.getByLabelText("文件 2 的集数")).toHaveValue(2);
  expect(draft.rows[0].baseline).toEqual(baseline);
});
