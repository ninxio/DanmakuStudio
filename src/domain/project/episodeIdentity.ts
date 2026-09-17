import type { ProjectMediaReference } from "./types";

export type EpisodeIdentityPattern =
  | "seasonEpisodeRange"
  | "episodeRange"
  | "seasonEpisode"
  | "episode"
  | "episodePart"
  | "importOrderFallback";

export type EpisodeIdentityEvidenceStrength = "strong" | "moderate" | "fallback";

export interface EpisodeIdentity {
  seasonNumber: number | null;
  episodeStart: number;
  episodeEnd: number;
  partNumber: number | null;
  pattern: EpisodeIdentityPattern;
  evidenceStrength: EpisodeIdentityEvidenceStrength;
}

export interface OrderedEpisodeIdentity extends EpisodeIdentity {
  sortNumber: number;
  fallback: boolean;
}

export interface ProjectMediaEpisodeIdentity extends EpisodeIdentity {
  source: "projectMetadata" | "fileName";
}

const RANGE_SEPARATOR_PATTERN = "[-~_—至到]";
const CHINESE_OR_ARABIC_NUMBER_PATTERN = "[零〇一二三四五六七八九十百两\\d]{1,6}";

export function parseEpisodeIdentity(text: string): EpisodeIdentity | null {
  // Collection totals describe the series, not this file's episode coverage.
  const normalized = normalizeEpisodeText(text).replace(
    new RegExp(`(?:全|共)\\s*${CHINESE_OR_ARABIC_NUMBER_PATTERN}\\s*[集话話]`, "g"),
    " "
  );
  return parseNormalizedEpisodeIdentity(normalized, false);
}

export function parseOrderedEpisodeIdentity(
  fileName: string,
  sourceOrder: number
): OrderedEpisodeIdentity {
  const stem = stripExtension(fileName.normalize("NFKC"));
  const directDecimalPart = parseDecimalEpisodePart(
    normalizeEpisodeText(stem).replace(/\s+/g, "")
  );
  if (directDecimalPart) {
    return createOrderedResult(directDecimalPart, sourceOrder + 1);
  }
  const prefixed = stripLeadingSortPrefix(stem, sourceOrder);
  const parsed = parseNormalizedEpisodeIdentity(normalizeEpisodeText(prefixed.title), true);
  if (parsed) {
    return createOrderedResult(parsed, prefixed.sortNumber);
  }
  return createOrderedFallback(sourceOrder, prefixed.sortNumber);
}

// Compatibility profile: extraction must not broaden batchMerge's established file grammar.
export function parseBatchMergeEpisodeIdentity(
  fileName: string,
  sourceOrder: number
): OrderedEpisodeIdentity {
  const stem = stripExtension(fileName);
  const prefixed = stripLeadingSortPrefix(stem, sourceOrder);
  const normalized = prefixed.title.replace(/\s+/g, "");

  const chineseSeasonRange = normalized.match(
    new RegExp(
      `第([一二三四五六七八九十百零〇两\\d]+)季第?(\\d{1,3})${RANGE_SEPARATOR_PATTERN}(\\d{1,3})(?:集|话|話)?`
    )
  );
  if (chineseSeasonRange) {
    const seasonNumber = parseChineseOrArabicNumber(chineseSeasonRange[1]);
    if (seasonNumber !== null) {
      const identity = createLegacyRangeIdentity(
        seasonNumber,
        Number(chineseSeasonRange[2]),
        Number(chineseSeasonRange[3]),
        "seasonEpisodeRange",
        "strong"
      );
      if (identity) {
        return createOrderedResult(identity, prefixed.sortNumber);
      }
    }
  }

  const seasonRange = normalized.match(
    new RegExp(
      `S(\\d{1,2})E?(\\d{1,3})${RANGE_SEPARATOR_PATTERN}E?(\\d{1,3})`,
      "i"
    )
  );
  if (seasonRange) {
    const identity = createLegacyRangeIdentity(
      Number(seasonRange[1]),
      Number(seasonRange[2]),
      Number(seasonRange[3]),
      "seasonEpisodeRange",
      "strong"
    );
    if (identity) {
      return createOrderedResult(identity, prefixed.sortNumber);
    }
  }

  const plainRange =
    normalized.match(
      new RegExp(
        `^第?(\\d{1,3})${RANGE_SEPARATOR_PATTERN}(\\d{1,3})(?:集|话|話)$`
      )
    ) ??
    normalized.match(
      new RegExp(`^(\\d{1,3})${RANGE_SEPARATOR_PATTERN}(\\d{1,3})$`)
    );
  if (plainRange) {
    const identity = createLegacyRangeIdentity(
      null,
      Number(plainRange[1]),
      Number(plainRange[2]),
      "episodeRange",
      "moderate"
    );
    if (identity) {
      return createOrderedResult(identity, prefixed.sortNumber);
    }
  }

  const decimalPart = parseDecimalEpisodePart(normalized);
  if (decimalPart) {
    return createOrderedResult(decimalPart, prefixed.sortNumber);
  }

  const chineseSeasonSingle = normalized.match(
    /第([一二三四五六七八九十百零〇两\d]+)季第?(\d{1,3})(?:集|话|話)?/
  );
  if (chineseSeasonSingle) {
    const seasonNumber = parseChineseOrArabicNumber(chineseSeasonSingle[1]);
    if (seasonNumber !== null) {
      const identity = createIdentity({
        seasonNumber,
        first: Number(chineseSeasonSingle[2]),
        last: Number(chineseSeasonSingle[2]),
        partNumber: null,
        pattern: "seasonEpisode",
        evidenceStrength: "strong",
        boundedRange: false
      });
      if (identity) {
        return createOrderedResult(identity, prefixed.sortNumber);
      }
    }
  }

  const seasonSingle = normalized.match(/S(\d{1,2})E(\d{1,3})/i);
  if (seasonSingle) {
    const identity = createIdentity({
      seasonNumber: Number(seasonSingle[1]),
      first: Number(seasonSingle[2]),
      last: Number(seasonSingle[2]),
      partNumber: null,
      pattern: "seasonEpisode",
      evidenceStrength: "strong",
      boundedRange: false
    });
    if (identity) {
      return createOrderedResult(identity, prefixed.sortNumber);
    }
  }

  const plainSingle = normalized.match(/^第?(\d{1,4})(?:集|话|話)?$/);
  if (plainSingle) {
    const identity = createIdentity({
      seasonNumber: null,
      first: Number(plainSingle[1]),
      last: Number(plainSingle[1]),
      partNumber: null,
      pattern: "episode",
      evidenceStrength: "moderate",
      boundedRange: false
    });
    if (identity) {
      return createOrderedResult(identity, prefixed.sortNumber);
    }
  }

  return createOrderedFallback(sourceOrder, prefixed.sortNumber);
}

export function parseProjectMediaEpisodeIdentity(
  media: ProjectMediaReference
): ProjectMediaEpisodeIdentity | null {
  const metadataIdentity = parseProjectEpisodeMetadata(media);
  if (metadataIdentity) {
    return metadataIdentity;
  }
  const texts = [media.episodeLabel, media.name, stripExtension(media.fileName)].filter(
    (value): value is string => Boolean(value?.trim())
  );
  for (const text of texts) {
    const parsed = parseEpisodeIdentity(text);
    if (parsed) {
      return { ...parsed, source: "fileName" };
    }
  }
  return null;
}

export function formatEpisodeIdentity(identity: EpisodeIdentity): string {
  const season = identity.seasonNumber === null ? "" : `第 ${identity.seasonNumber} 季`;
  const episode =
    identity.episodeStart === identity.episodeEnd
      ? `第 ${identity.episodeStart} 集`
      : `第 ${identity.episodeStart}–${identity.episodeEnd} 集`;
  const part = identity.partNumber === null ? "" : ` · Part ${identity.partNumber}`;
  return `${season}${episode}${part}`;
}

function parseProjectEpisodeMetadata(
  media: ProjectMediaReference
): ProjectMediaEpisodeIdentity | null {
  const seasonNumber = media.emby?.seasonNumber ?? null;
  const episodeNumber = media.emby?.episodeNumber ?? null;
  if (episodeNumber !== null && isValidEpisodeNumber(episodeNumber)) {
    return {
      seasonNumber: isValidSeasonNumber(seasonNumber) ? seasonNumber : null,
      episodeStart: episodeNumber,
      episodeEnd: episodeNumber,
      partNumber: null,
      pattern: seasonNumber === null ? "episode" : "seasonEpisode",
      evidenceStrength: "strong",
      source: "projectMetadata"
    };
  }
  if (media.episodeKey) {
    const parsed = parseEpisodeIdentity(media.episodeKey);
    if (parsed) {
      return { ...parsed, evidenceStrength: "strong", source: "projectMetadata" };
    }
  }
  return null;
}

function parseNormalizedEpisodeIdentity(
  normalized: string,
  allowOrderedAssetSyntax: boolean
): EpisodeIdentity | null {
  const partNumber = parsePartNumber(normalized);
  const seasonEpisode = normalized.match(
    /\bS(\d{1,3})\s*E(\d{1,4})(?:\s*-\s*(?:S\d{1,3}\s*)?E?(\d{1,4}))?\b/i
  );
  if (seasonEpisode) {
    return createIdentity({
      seasonNumber: Number(seasonEpisode[1]),
      first: Number(seasonEpisode[2]),
      last: Number(seasonEpisode[3] ?? seasonEpisode[2]),
      partNumber,
      pattern:
        seasonEpisode[3] !== undefined
          ? "seasonEpisodeRange"
          : partNumber === null
            ? "seasonEpisode"
            : "episodePart",
      evidenceStrength: "strong",
      boundedRange: allowOrderedAssetSyntax
    });
  }

  const chineseSeason = normalized.match(
    new RegExp(
      `第?(${CHINESE_OR_ARABIC_NUMBER_PATTERN})\\s*季\\s*第?\\s*(${CHINESE_OR_ARABIC_NUMBER_PATTERN})(?:\\s*${RANGE_SEPARATOR_PATTERN}\\s*第?\\s*(${CHINESE_OR_ARABIC_NUMBER_PATTERN}))?\\s*(?:集|话|話)?`,
      "i"
    )
  );
  if (chineseSeason) {
    const season = parseChineseOrArabicNumber(chineseSeason[1]);
    const first = parseChineseOrArabicNumber(chineseSeason[2]);
    const last = parseChineseOrArabicNumber(chineseSeason[3] ?? chineseSeason[2]);
    if (season !== null && first !== null && last !== null) {
      return createIdentity({
        seasonNumber: season,
        first,
        last,
        partNumber,
        pattern:
          chineseSeason[3] !== undefined
            ? "seasonEpisodeRange"
            : partNumber === null
              ? "seasonEpisode"
              : "episodePart",
        evidenceStrength: "strong",
        boundedRange: allowOrderedAssetSyntax
      });
    }
  }

  const explicitEpisode = normalized.match(/\bE(?:P)?\s*(\d{1,4})(?:\s*-\s*E?(\d{1,4}))?\b/i);
  if (explicitEpisode) {
    return createIdentity({
      seasonNumber: null,
      first: Number(explicitEpisode[1]),
      last: Number(explicitEpisode[2] ?? explicitEpisode[1]),
      partNumber,
      pattern:
        explicitEpisode[2] !== undefined
          ? "episodeRange"
          : partNumber === null
            ? "episode"
            : "episodePart",
      evidenceStrength: partNumber === null ? "moderate" : "strong",
      boundedRange: allowOrderedAssetSyntax
    });
  }

  const chineseEpisode = normalized.match(
    new RegExp(
      `第?\\s*(${CHINESE_OR_ARABIC_NUMBER_PATTERN})(?:\\s*${RANGE_SEPARATOR_PATTERN}\\s*第?\\s*(${CHINESE_OR_ARABIC_NUMBER_PATTERN}))?\\s*(?:集|话|話)`,
      "i"
    )
  );
  if (chineseEpisode) {
    const first = parseChineseOrArabicNumber(chineseEpisode[1]);
    const last = parseChineseOrArabicNumber(chineseEpisode[2] ?? chineseEpisode[1]);
    if (first !== null && last !== null) {
      return createIdentity({
        seasonNumber: null,
        first,
        last,
        partNumber,
        pattern:
          chineseEpisode[2] !== undefined
            ? "episodeRange"
            : partNumber === null
              ? "episode"
              : "episodePart",
        evidenceStrength: partNumber === null ? "moderate" : "strong",
        boundedRange: allowOrderedAssetSyntax
      });
    }
  }

  if (!allowOrderedAssetSyntax) {
    return null;
  }

  const compact = normalized.replace(/\s+/g, "");
  const plainRange = compact.match(
    new RegExp(`^第?(\\d{1,3})${RANGE_SEPARATOR_PATTERN}(\\d{1,3})(?:集|话|話)?$`)
  );
  if (plainRange) {
    return createIdentity({
      seasonNumber: null,
      first: Number(plainRange[1]),
      last: Number(plainRange[2]),
      partNumber: null,
      pattern: "episodeRange",
      evidenceStrength: "moderate",
      boundedRange: true
    });
  }

  const decimalPart = parseDecimalEpisodePart(compact);
  if (decimalPart) {
    return decimalPart;
  }

  const plainSingle = compact.match(/^第?(\d{1,4})(?:集|话|話)?$/);
  if (plainSingle) {
    return createIdentity({
      seasonNumber: null,
      first: Number(plainSingle[1]),
      last: Number(plainSingle[1]),
      partNumber: null,
      pattern: "episode",
      evidenceStrength: "moderate",
      boundedRange: true
    });
  }
  return null;
}

function createIdentity(input: {
  seasonNumber: number | null;
  first: number;
  last: number;
  partNumber: number | null;
  pattern: EpisodeIdentityPattern;
  evidenceStrength: EpisodeIdentityEvidenceStrength;
  boundedRange: boolean;
}): EpisodeIdentity | null {
  const first = input.boundedRange ? Math.min(input.first, input.last) : input.first;
  const last = input.boundedRange ? Math.max(input.first, input.last) : input.last;
  if (
    !isValidSeasonNumber(input.seasonNumber) ||
    !isValidEpisodeNumber(first) ||
    !isValidEpisodeNumber(last) ||
    last < first ||
    !isValidPartNumber(input.partNumber)
  ) {
    return null;
  }
  if (input.boundedRange && first !== last && (first <= 0 || last - first + 1 > 80)) {
    return null;
  }
  return {
    seasonNumber: input.seasonNumber,
    episodeStart: first,
    episodeEnd: last,
    partNumber: input.partNumber,
    pattern: input.pattern,
    evidenceStrength: input.evidenceStrength
  };
}

function parseDecimalEpisodePart(normalized: string): EpisodeIdentity | null {
  const match = normalized.match(/^第?(\d{1,3})[._](\d{1,3})(?:\D|$)/);
  if (!match) {
    return null;
  }
  return createIdentity({
    seasonNumber: null,
    first: Number(match[1]),
    last: Number(match[1]),
    partNumber: Number(match[2]),
    pattern: "episodePart",
    evidenceStrength: "strong",
    boundedRange: false
  });
}

function createLegacyRangeIdentity(
  seasonNumber: number | null,
  first: number,
  last: number,
  pattern: "seasonEpisodeRange" | "episodeRange",
  evidenceStrength: "strong" | "moderate"
): EpisodeIdentity | null {
  const count = Math.abs(last - first) + 1;
  if (count < 2 || count > 80 || first <= 0 || last <= 0) {
    return null;
  }
  return createIdentity({
    seasonNumber,
    first,
    last,
    partNumber: null,
    pattern,
    evidenceStrength,
    boundedRange: true
  });
}

function createOrderedResult(
  identity: EpisodeIdentity,
  sortNumber: number
): OrderedEpisodeIdentity {
  return {
    ...identity,
    sortNumber,
    fallback: false
  };
}

function createOrderedFallback(
  sourceOrder: number,
  sortNumber: number
): OrderedEpisodeIdentity {
  return {
    seasonNumber: null,
    episodeStart: sourceOrder + 1,
    episodeEnd: sourceOrder + 1,
    partNumber: null,
    pattern: "importOrderFallback",
    evidenceStrength: "fallback",
    sortNumber,
    fallback: true
  };
}

function normalizeEpisodeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‐‑‒–—﹣－~～至到]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePartNumber(normalized: string): number | null {
  const match = normalized.match(/(?:PART|PT|P)\s*(\d{1,3})(?:\b|$)/i);
  return match ? Number(match[1]) : null;
}

function stripLeadingSortPrefix(
  stem: string,
  sourceOrder: number
): { sortNumber: number; title: string } {
  const match = stem.match(/^\s*(\d{1,4})\s*[-_.)、]\s*(.+)$/);
  if (!match) {
    return { sortNumber: sourceOrder + 1, title: stem };
  }
  return { sortNumber: Number(match[1]), title: match[2] };
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function parseChineseOrArabicNumber(value: string): number | null {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const digitValues: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (digitValues[character] !== undefined) {
      current = digitValues[character];
    } else {
      return null;
    }
  }
  return total + current;
}

function isValidSeasonNumber(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 999);
}

function isValidEpisodeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 9_999;
}

function isValidPartNumber(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 999);
}
