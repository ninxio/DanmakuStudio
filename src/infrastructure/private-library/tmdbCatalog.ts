import { invoke, isTauri } from "@tauri-apps/api/core";
export interface CatalogSelection {
  provider: "tmdb";
  kind: "tv" | "movie";
  id: number;
}
export interface DateCorrection {
  season: number;
  airDate: string;
  sourceUrl: string;
  note: string;
}
export interface CatalogSnapshot extends CatalogSelection {
  titleZh: string;
  titleEn: string;
  originalTitle: string;
  workDate: string | null;
  workYear: number | null;
  season: {
    number: number;
    airDate: string | null;
    year: number | null;
    tmdbAirDate: string | null;
    dateEvidence?: DateCorrection;
  } | null;
}
export interface TmdbCandidate extends CatalogSelection {
  titleZh: string;
  titleEn: string;
  originalTitle: string;
  workYear: number | null;
  overview: string;
}
export interface TmdbWork extends TmdbCandidate {
  workKey: string;
  seasons: {
    number: number;
    airDate: string | null;
    year: number | null;
    episodeCount: number;
  }[];
}
export interface CatalogProfile {
  workKey: string;
  version: number;
  work: CatalogSnapshot;
  seasons: {
    snapshot: CatalogSnapshot;
    episodes: { number: number; titleZh: string; titleEn: string }[];
  }[];
}
export interface CatalogChange {
  workKey: string;
  selection: CatalogSelection;
  season: number;
  expectedVersion: number | null;
  correction?: DateCorrection;
  expectedPlan?: string;
}
export interface CatalogPlan {
  planId: string;
  snapshot: CatalogSnapshot;
  previous: CatalogSnapshot | null;
  affectedEpisodes: number;
  episodes: { number: number; titleZh: string; titleEn: string }[];
}
async function request<T>(request: object): Promise<T> {
  if (!isTauri()) throw new Error("影视资料需要在桌面版 Studio 中使用。");
  return invoke<T>("private_library_catalog", { request });
}
export const searchTmdb = (kind: "tv" | "movie", query: string) =>
  request<{ results: TmdbCandidate[]; hasMore: boolean }>({ action: "search", kind, query });
export const getTmdbWork = (kind: "tv" | "movie", id: number) =>
  request<{ work: TmdbWork }>({ action: "work", kind, id });
export const getCatalogProfile = (workKey: string) =>
  request<{ profile: CatalogProfile | null }>({ action: "profile", workKey });
export const planCatalog = (data: CatalogChange) =>
  request<CatalogPlan>({ action: "plan", data });
export const saveCatalog = (data: CatalogChange) =>
  request<{ workKey: string; version: number; snapshot: CatalogSnapshot }>({
    action: "save",
    data
  });
