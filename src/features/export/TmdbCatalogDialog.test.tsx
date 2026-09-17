import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TmdbCatalogDialog } from "./TmdbCatalogDialog";
import * as api from "../../infrastructure/private-library/tmdbCatalog";
import { searchLibraryWorks } from "../../infrastructure/private-library/libraryBrowser";
vi.mock("../../infrastructure/private-library/tmdbCatalog", () => ({
  searchTmdb: vi.fn(),
  getTmdbWork: vi.fn(),
  getCatalogProfile: vi.fn(),
  planCatalog: vi.fn(),
  saveCatalog: vi.fn()
}));
vi.mock("../../infrastructure/private-library/libraryBrowser", () => ({
  searchLibraryWorks: vi.fn()
}));
const candidate = {
  provider: "tmdb" as const,
  kind: "tv" as const,
  id: 42,
  titleZh: "样例剧",
  titleEn: "Example Show",
  originalTitle: "Example Show",
  workYear: 2022,
  overview: ""
};
const snapshot = {
  ...candidate,
  workDate: "2022-09-01",
  season: { number: 2, airDate: "2023-10-15", year: 2023, tmdbAirDate: "2025-02-21" }
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.searchTmdb).mockResolvedValue({ results: [candidate], hasMore: false });
  vi.mocked(api.getTmdbWork).mockResolvedValue({
    work: {
      ...candidate,
      workKey: "tmdb-tv-42",
      seasons: [
        { number: 1, airDate: "2022-09-01", year: 2022, episodeCount: 8 },
        { number: 2, airDate: "2025-02-21", year: 2025, episodeCount: 8 }
      ]
    }
  });
  vi.mocked(api.getCatalogProfile).mockResolvedValue({ profile: null });
  vi.mocked(api.planCatalog).mockResolvedValue({
    planId: "a".repeat(64),
    snapshot,
    previous: null,
    affectedEpisodes: 8,
    episodes: [{ number: 1, titleZh: "开场", titleEn: "Opening" }]
  });
  vi.mocked(api.saveCatalog).mockResolvedValue({ workKey: "existing", version: 1, snapshot });
  vi.mocked(searchLibraryWorks).mockResolvedValue([]);
});
async function select() {
  fireEvent.change(screen.getByLabelText("中文或英文片名"), { target: { value: "Example" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索 TMDB" }));
  fireEvent.click(await screen.findByRole("button", { name: /样例剧.*Example Show/ }));
  await screen.findByLabelText("本次更新的季");
}
it("previews an existing season association, keeps work year separate and saves the reviewed plan", async () => {
  const onChoose = vi.fn();
  render(
    <TmdbCatalogDialog
      existingWork={{
        workKey: "existing",
        title: "旧片名",
        kind: "tv",
        year: 2022,
        episodeCount: 16,
        seasonCount: 2
      }}
      initialSeason={2}
      onChoose={onChoose}
      onClose={() => {}}
    />
  );
  await select();
  expect(screen.getByLabelText("本次更新的季")).toHaveValue("2");
  fireEvent.click(screen.getByLabelText("以有出处的发行日期修正本季"));
  fireEvent.change(screen.getByLabelText("本季发行日期"), { target: { value: "2023-10-15" } });
  fireEvent.change(screen.getByLabelText("官方发行资料链接"), {
    target: { value: "https://www.example.org/official" }
  });
  fireEvent.change(screen.getByLabelText("修正说明"), {
    target: { value: "发行平台公布的本季首发日期" }
  });
  fireEvent.click(screen.getByRole("button", { name: "预览资料变化" }));
  await screen.findByText(/第 2 季：未关联 → 2023-10-15/);
  expect(api.saveCatalog).not.toHaveBeenCalled();
  expect(api.planCatalog).toHaveBeenCalledWith(
    expect.objectContaining({
      workKey: "existing",
      season: 2,
      expectedVersion: null,
      correction: { airDate: "2023-10-15", season: 2, sourceUrl: "https://www.example.org/official", note: "发行平台公布的本季首发日期" }
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "保存资料并使用这一季" }));
  await waitFor(() =>
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ workKey: "existing", year: 2022, tmdbId: 42 }),
      2
    )
  );
  expect(api.saveCatalog).toHaveBeenCalledWith(
    expect.objectContaining({ expectedPlan: "a".repeat(64) })
  );
});
it("keeps a TMDB failure actionable and does not save anything on return", async () => {
  const close = vi.fn();
  vi.mocked(api.searchTmdb).mockRejectedValueOnce(new Error("TMDB 正在限流，约 10 秒后可重试"));
  render(<TmdbCatalogDialog onChoose={() => {}} onClose={close} />);
  fireEvent.change(screen.getByLabelText("中文或英文片名"), { target: { value: "Example" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索 TMDB" }));
  await screen.findByText(/约 10 秒/);
  expect(screen.getByRole("button", { name: "搜索 TMDB" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /^返回$/ }));
  expect(close).toHaveBeenCalledOnce();
  expect(api.saveCatalog).not.toHaveBeenCalled();
});
