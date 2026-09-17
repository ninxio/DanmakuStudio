import type { BatchMergeEpisode } from "../danmaku/batchMerge";
import type { SeasonEpisodeBinding } from "./types";

export function createSeasonEpisodeKey(episode: BatchMergeEpisode): string {
  const episodePart = `E${episode.episodeNumber.toString().padStart(2, "0")}`;
  if (episode.seasonNumber !== null) {
    return `S${episode.seasonNumber.toString().padStart(2, "0")}${episodePart}`;
  }
  return `${episodePart}:${normalizeEpisodeFileName(episode.fileName)}`;
}

export function findSeasonEpisodeBinding(
  bindings: readonly SeasonEpisodeBinding[],
  episodeKey: string
): SeasonEpisodeBinding | null {
  return bindings.find((binding) => binding.episodeKey === episodeKey) ?? null;
}

function normalizeEpisodeFileName(fileName: string): string {
  const normalized = fileName.trim().toLowerCase().split("\\").join("/");
  return normalized.length > 0 ? normalized : "episode";
}
