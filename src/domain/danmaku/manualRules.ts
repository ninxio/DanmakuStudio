import type { EpisodeDurationMetadata } from "./batchMerge";
import type { Milliseconds } from "../shared/time";
import { toMilliseconds } from "../shared/time";

export interface ParsedEpisodeDurations {
  episodes: EpisodeDurationMetadata[];
  warnings: string[];
}

export interface ParsedCutPoints {
  cutPointsMs: Milliseconds[];
  warnings: string[];
}

export function parseEpisodeDurationsText(text: string): ParsedEpisodeDurations {
  const episodes: EpisodeDurationMetadata[] = [];
  const warnings: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  lines.forEach((line, index) => {
    const parsed = parseDurationLine(line, index + 1);
    if (!parsed) {
      warnings.push(`第 ${index + 1} 行无法识别时长：${line}`);
      return;
    }
    episodes.push(parsed);
  });

  return { episodes, warnings };
}

export function parseCutPointsText(text: string): ParsedCutPoints {
  const warnings: string[] = [];
  const cutPointsMs = text
    .split(/[\n,，;；]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .flatMap((token) => {
      const parsed = parseTimecodeToken(token);
      if (parsed === null) {
        warnings.push(`无法识别切点：${token}`);
        return [];
      }
      return [parsed];
    })
    .sort((left, right) => left - right);

  return {
    cutPointsMs,
    warnings
  };
}

export function parseMinutesInput(value: string): Milliseconds | null {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  const minutes = Number(normalized);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return null;
  }
  return toMilliseconds(minutes * 60);
}

function parseDurationLine(line: string, fallbackEpisodeNumber: number): EpisodeDurationMetadata | null {
  const durationMatch = line.match(
    /([0-9]+(?::[0-9]{1,2}){1,2}(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?\s*(?:分钟|分|min|m)?)\s*$/i
  );
  if (!durationMatch || durationMatch.index === undefined) {
    return null;
  }
  const durationMs = parseTimecodeToken(durationMatch[1]);
  if (durationMs === null || durationMs <= 0) {
    return null;
  }
  const label = line.slice(0, durationMatch.index).replace(/[=:：,-]+$/, "").trim();
  const identity = parseEpisodeIdentity(label, fallbackEpisodeNumber);
  return {
    seasonNumber: identity.seasonNumber,
    episodeNumber: identity.episodeNumber,
    durationMs
  };
}

function parseEpisodeIdentity(
  label: string,
  fallbackEpisodeNumber: number
): { seasonNumber: number | null; episodeNumber: number | null } {
  if (label.length === 0) {
    return { seasonNumber: null, episodeNumber: fallbackEpisodeNumber };
  }
  const se = label.match(/S(\d{1,2})E(\d{1,3})/i);
  if (se) {
    return { seasonNumber: Number(se[1]), episodeNumber: Number(se[2]) };
  }
  const chinese = label.match(/第?(\d{1,2})季第?(\d{1,3})(?:集|话|話)?/);
  if (chinese) {
    return { seasonNumber: Number(chinese[1]), episodeNumber: Number(chinese[2]) };
  }
  const episodeOnly = label.match(/(?:E|第)?(\d{1,3})(?:集|话|話)?$/i);
  if (episodeOnly) {
    return { seasonNumber: null, episodeNumber: Number(episodeOnly[1]) };
  }
  return { seasonNumber: null, episodeNumber: fallbackEpisodeNumber };
}

function parseTimecodeToken(token: string): Milliseconds | null {
  const normalized = token.trim().replace(/\s+/g, "");
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.includes(":")) {
    const parts = normalized.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length < 2 || parts.length > 3) {
      return null;
    }
    const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    if ((parts.length === 3 && minutes >= 60) || seconds >= 60) {
      return null;
    }
    return toMilliseconds(hours * 3600 + minutes * 60 + seconds);
  }
  const minutesMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)(?:分钟|分|min|m)?$/i);
  if (!minutesMatch) {
    return null;
  }
  const minutes = Number(minutesMatch[1]);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return null;
  }
  return toMilliseconds(minutes * 60);
}
