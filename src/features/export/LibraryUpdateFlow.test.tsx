import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PrivateLibraryPublishDialog } from "./PrivateLibraryPublishDialog";
import { getCatalogProfile } from "../../infrastructure/private-library/tmdbCatalog";
vi.mock("../../infrastructure/private-library/tmdbCatalog", () => ({
  getCatalogProfile: vi.fn()
}));
import type { PublicationDelivery } from "../../domain/publication/types";
import type { LibraryEpisode, LibraryWork } from "../../application/libraryUpdate";
import {
  getLibraryEpisodes,
  reviewLibraryEpisode,
  searchLibraryWorks
} from "../../infrastructure/private-library/libraryBrowser";
import {
  preparePrivateLibraryPublication,
  publishPrivateLibraryXml
} from "../../infrastructure/private-library/privateLibrary";
import {
  loadDelivery,
  savePublicationDraft
} from "../../infrastructure/private-library/publicationOutbox";
vi.mock("../../infrastructure/private-library/libraryBrowser", () => ({
  getLibraryEpisodes: vi.fn(),
  searchLibraryWorks: vi.fn(),
  reviewLibraryEpisode: vi.fn()
}));
vi.mock("../../infrastructure/private-library/privateLibrary", () => ({
  preparePrivateLibraryPublication: vi.fn(),
  publishPrivateLibraryXml: vi.fn(),
  privateLibraryError: (e: unknown) => String(e)
}));
vi.mock("../../infrastructure/private-library/publicationOutbox", () => ({
  persistDelivery: () => Promise.resolve({ key: "batch" }),
  loadDelivery: vi.fn(),
  savePublicationDraft: vi.fn()
}));
const delivery: PublicationDelivery = {
  projectId: "p",
  projectName: "files",
  projectUpdatedAt: "now",
  createdAt: "now",
  kind: "xml",
  files: [{ fileName: "第2季第1集.xml", content: "<i/>" }]
};
const work: LibraryWork = {
  workKey: "show",
  title: "正式片名",
  kind: "tv",
  year: null,
  episodeCount: 2,
  seasonCount: 1
};
const old = "a".repeat(64),
  next = "b".repeat(64);
const episode: LibraryEpisode = {
  episodeId: 12,
  revision: old,
  metadataVersion: 1,
  canonicalMetadata: {
    workKey: "show",
    title: "正式片名",
    kind: "tv",
    year: null,
    editionKey: "edition",
    sourceKey: "source",
    sourceLabel: "收藏",
    edition: "内部旧版本",
    aliases: []
  },
  manifest: {
    workKey: "show",
    title: "正式片名",
    kind: "tv",
    year: null,
    aliases: [],
    editionKey: "edition",
    edition: "内部旧版本",
    season: 2,
    episode: 1,
    label: "第一集",
    durationMs: null,
    fileNames: [],
    allowAutoMatch: false,
    xmlHash: "c".repeat(64),
    commentCount: 100
  }
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadDelivery).mockResolvedValue({ key: "batch", delivery, draft: null });
  vi.mocked(getLibraryEpisodes).mockResolvedValue([episode]);
  vi.mocked(searchLibraryWorks).mockResolvedValue([work]);
  vi.mocked(preparePrivateLibraryPublication).mockResolvedValue({
    expectedRevision: old,
    connectionScope: "https://example.com",
    identity: "same"
  });
  vi.mocked(publishPrivateLibraryXml).mockResolvedValue({
    episodeId: 12,
    animeId: 100,
    revision: next,
    commentCount: 8,
    metadataVersion: 1
  });
  vi.mocked(reviewLibraryEpisode).mockResolvedValue();
  vi.mocked(savePublicationDraft).mockResolvedValue();
});
async function preview() {
  await waitFor(() => expect(screen.getByRole("button", { name: "预览更新" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
  await screen.findByText(/替换已有弹幕/);
}
it("asks for the selected season before preparing a TMDB-bound upload", async () => {
  vi.mocked(getCatalogProfile).mockResolvedValue({ profile: null });
  render(
    <PrivateLibraryPublishDialog
      delivery={delivery}
      initialWork={{ ...work, tmdbId: 42 }}
      onClose={() => {}}
    />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "预览更新" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
  await screen.findByText(/选择并保存这一季，再预览上传/);
  expect(preparePrivateLibraryPublication).not.toHaveBeenCalled();
  expect(publishPrivateLibraryXml).not.toHaveBeenCalled();
});
it("previews replacement and requires an explicit content check before storing and listing the same episode", async () => {
  render(
    <PrivateLibraryPublishDialog delivery={delivery} initialWork={work} onClose={() => {}} />
  );
  await preview();
  expect(publishPrivateLibraryXml).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("观看版本")).not.toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "确认更新并上架" });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(confirm);
  await screen.findByText(/更新完成/);
  expect(publishPrivateLibraryXml).toHaveBeenCalledWith(
    "<i/>",
    expect.objectContaining({
      workKey: "show",
      sourceKey: "source",
      editionKey: "edition",
      season: 2,
      episode: 1
    }),
    expect.objectContaining({ expectedRevision: old })
  );
  expect(reviewLibraryEpisode).toHaveBeenCalledWith(12, next, true);
  expect(savePublicationDraft).toHaveBeenCalledWith(
    "batch",
    expect.objectContaining({ workflow: "library-update-v2" })
  );
});
it("keeps a successful upload receipt when approval fails and resumes approval without uploading again", async () => {
  vi.mocked(reviewLibraryEpisode)
    .mockRejectedValueOnce(new Error("暂时离线"))
    .mockResolvedValue();
  render(
    <PrivateLibraryPublishDialog delivery={delivery} initialWork={work} onClose={() => {}} />
  );
  await preview();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认更新并上架" }));
  await screen.findAllByText(/暂时离线/);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "确认更新并上架" })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: "确认更新并上架" }));
  await screen.findByText(/更新完成/);
  expect(publishPrivateLibraryXml).toHaveBeenCalledTimes(1);
  expect(reviewLibraryEpisode).toHaveBeenCalledTimes(2);
});
it("only-add mode does not overwrite or approve an existing unchecked episode", async () => {
  render(
    <PrivateLibraryPublishDialog delivery={delivery} initialWork={work} onClose={() => {}} />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "预览更新" })).toBeEnabled());
  fireEvent.click(screen.getByRole("radio", { name: /只补充缺集/ }));
  fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
  await screen.findByText(/已有弹幕，跳过/);
  expect(screen.getByRole("button", { name: "确认更新并上架" })).toBeDisabled();
  expect(publishPrivateLibraryXml).not.toHaveBeenCalled();
  expect(reviewLibraryEpisode).not.toHaveBeenCalled();
});
it("redirects duplicate formal titles to choosing the existing work, and refuses stale preview baselines", async () => {
  render(<PrivateLibraryPublishDialog delivery={delivery} onClose={() => {}} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "库里没有，新增影视" })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: "库里没有，新增影视" }));
  fireEvent.change(screen.getByLabelText("正式片名"), { target: { value: work.title } });
  fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
  await screen.findByText(/库里已有这部影视/);
  fireEvent.click(screen.getByRole("button", { name: "更新这部剧集" }));
  vi.mocked(preparePrivateLibraryPublication).mockResolvedValue({
    expectedRevision: next,
    connectionScope: "x",
    identity: "same"
  });
  fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
  await screen.findByText(/读取过程中云端有更新/);
  expect(publishPrivateLibraryXml).not.toHaveBeenCalled();
});

it("starts an existing movie folder update as its single movie episode", async () => {
  const movie = { ...work, kind: "movie" as const };
  vi.mocked(getLibraryEpisodes).mockResolvedValue([
    {
      ...episode,
      canonicalMetadata: { ...episode.canonicalMetadata, kind: "movie" },
      manifest: { ...episode.manifest, kind: "movie", season: 0 }
    }
  ]);
  render(
    <PrivateLibraryPublishDialog
      delivery={{ ...delivery, files: [{ fileName: "电影成品.xml", content: "<i/>" }] }}
      initialWork={movie}
      onClose={() => {}}
    />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "预览更新" })).toBeEnabled());
  expect(screen.getByLabelText("文件 1 的集数")).toHaveValue(1);
  expect(screen.queryByLabelText("更新第几季")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览更新" }));
  await screen.findByText(/替换已有弹幕/);
  expect(preparePrivateLibraryPublication).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "movie", season: 0, episode: 1 })
  );
});
