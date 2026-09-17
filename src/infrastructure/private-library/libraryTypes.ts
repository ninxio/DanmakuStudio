import type {
  CanonicalMetadata,
  PublicationMetadata,
  PublicationBaseline,
  PublicationResult
} from "./privateLibrary";
export interface LibraryWork {
  workKey: string;
  title: string;
  titleEn?: string | null;
  tmdbId?: number | null;
  catalogVersion?: number | null;
  kind: "tv" | "movie";
  year: number | null;
  episodeCount: number;
  seasonCount: number;
  pendingCount?: number;
  visibleCount?: number;
}
export interface LibraryEpisode {
  episodeId: number;
  revision: string;
  metadataVersion: number;
  reviewStatus?: "pending" | "approved";
  isVisible?: boolean;
  canonicalMetadata: CanonicalMetadata;
  manifest: PublicationMetadata & { xmlHash: string; commentCount: number };
}
export type UpdateMode = "replace" | "append";
export interface UpdateRow {
  index: number;
  episode: number;
  action: "create" | "replace" | "unchanged" | "skip";
  oldCount: number | null;
  expectedRevision: string | null;
  existingEpisodeId?: number;
  reviewed?: boolean;
  metadata: PublicationMetadata;
  baseline?: PublicationBaseline;
  receipt?: PublicationResult;
  message?: string;
}
export interface UpdateDraft {
  schemaVersion: 1;
  workflow: "library-update-v2";
  work: LibraryWork;
  season: number;
  mode: UpdateMode;
  rows: UpdateRow[];
}
