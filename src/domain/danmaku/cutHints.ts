import type { CutMarker, DanmakuAsset, DanmakuItem } from "./types";
import type { Milliseconds } from "../shared/time";
import { clampMilliseconds } from "../shared/time";

export type SuspectedCutConfidence = "high" | "medium" | "low";

export interface CutHintRule {
  label: string;
  pattern: RegExp;
  weight: number;
}

export interface CutHintMatch {
  item: DanmakuItem;
  sourceTimeMs: Milliseconds;
  keywords: string[];
  score: number;
}

export interface SuspectedCutCandidate {
  id: string;
  assetId: string;
  assetFileName: string;
  sourceAtMs: Milliseconds;
  startMs: Milliseconds;
  endMs: Milliseconds;
  hitCount: number;
  score: number;
  confidence: SuspectedCutConfidence;
  keywords: string[];
  sampleTexts: string[];
  itemIds: string[];
}

export interface FindSuspectedCutCandidatesOptions {
  windowMs?: Milliseconds;
  minHitCount?: number;
  maxSamples?: number;
  rules?: CutHintRule[];
}

export interface CutHintSearchSettings {
  keywordsText: string;
  windowSeconds: string;
  minHitCount: string;
}

export interface CutHintSearchPlan {
  options: FindSuspectedCutCandidatesOptions;
  warnings: string[];
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MIN_HIT_COUNT = 2;
const DEFAULT_MAX_SAMPLES = 3;
const DEFAULT_APPLIED_TOLERANCE_MS = 5000;
const KEYWORD_SPLIT_PATTERN = /[\s,，、;；|]+/u;

export const DEFAULT_CUT_HINT_SEARCH_SETTINGS: CutHintSearchSettings = {
  keywordsText: "",
  windowSeconds: "60",
  minHitCount: "2"
};

export const DEFAULT_CUT_HINT_RULES: CutHintRule[] = [
  { label: "删了", pattern: /删了|删掉|删减|被删|删过|删了一段|删没了|删掉了/u, weight: 3 },
  { label: "剪了", pattern: /剪了|剪掉|剪辑|剪过|剪没了|被剪|剪掉了/u, weight: 3 },
  { label: "跳了", pattern: /跳了|跳过|怎么跳|突然跳|跳剧情|跳了一段/u, weight: 2 },
  { label: "和谐", pattern: /和谐|河蟹|阉割|被砍|砍了/u, weight: 3 },
  { label: "没了", pattern: /没了|少了|缺了|不见了|中间没|少一段/u, weight: 2 }
];

export function createCutHintRulesFromKeywords(text: string, weight = 2): CutHintRule[] {
  return unique(
    text
      .split(KEYWORD_SPLIT_PATTERN)
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0)
  ).map((keyword) => ({
    label: keyword,
    pattern: new RegExp(escapeRegExp(keyword), "iu"),
    weight
  }));
}

export function createCutHintSearchPlan(settings: CutHintSearchSettings): CutHintSearchPlan {
  const options: FindSuspectedCutCandidatesOptions = {};
  const warnings: string[] = [];
  const trimmedWindow = settings.windowSeconds.trim();
  const parsedWindowSeconds = Number(trimmedWindow);
  if (trimmedWindow.length === 0 || !Number.isFinite(parsedWindowSeconds) || parsedWindowSeconds <= 0) {
    warnings.push("疑似删减聚类窗口必须是大于 0 的数字。");
  } else {
    options.windowMs = Math.round(parsedWindowSeconds * 1000);
  }

  const trimmedMinHitCount = settings.minHitCount.trim();
  const parsedMinHitCount = Number(trimmedMinHitCount);
  if (trimmedMinHitCount.length === 0 || !Number.isInteger(parsedMinHitCount) || parsedMinHitCount <= 0) {
    warnings.push("疑似删减最小命中必须是大于 0 的整数。");
  } else {
    options.minHitCount = parsedMinHitCount;
  }

  if (settings.keywordsText.trim().length > 0) {
    const rules = createCutHintRulesFromKeywords(settings.keywordsText);
    if (rules.length === 0) {
      warnings.push("疑似删减关键词为空。");
    } else {
      options.rules = rules;
    }
  }

  return { options, warnings };
}

export function findSuspectedCutCandidates(
  assets: DanmakuAsset[],
  options: FindSuspectedCutCandidatesOptions = {}
): SuspectedCutCandidate[] {
  const windowMs = Math.max(1, clampMilliseconds(options.windowMs ?? DEFAULT_WINDOW_MS));
  const minHitCount = Math.max(1, Math.round(options.minHitCount ?? DEFAULT_MIN_HIT_COUNT));
  const maxSamples = Math.max(1, Math.round(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const rules = options.rules ?? DEFAULT_CUT_HINT_RULES;

  return assets
    .flatMap((asset) => createAssetCandidates(asset, { windowMs, minHitCount, maxSamples, rules }))
    .sort((left, right) => right.score - left.score || left.sourceAtMs - right.sourceAtMs)
    .slice(0, 12);
}

export function isSuspectedCutCandidateApplied(
  candidate: SuspectedCutCandidate,
  cutMarkers: CutMarker[],
  toleranceMs: Milliseconds = DEFAULT_APPLIED_TOLERANCE_MS
): boolean {
  const tolerance = clampMilliseconds(toleranceMs);
  return cutMarkers.some((marker) => Math.abs(marker.sourceAtMs - candidate.sourceAtMs) <= tolerance);
}

function createAssetCandidates(
  asset: DanmakuAsset,
  options: Required<FindSuspectedCutCandidatesOptions>
): SuspectedCutCandidate[] {
  const matches = asset.items
    .map((item) => createMatch(item, options.rules))
    .filter((match): match is CutHintMatch => match !== null)
    .sort((left, right) => left.sourceTimeMs - right.sourceTimeMs || left.item.originalIndex - right.item.originalIndex);

  const buckets = new Map<number, CutHintMatch[]>();
  for (const match of matches) {
    const bucketIndex = Math.floor(match.sourceTimeMs / options.windowMs);
    buckets.set(bucketIndex, [...(buckets.get(bucketIndex) ?? []), match]);
  }

  return Array.from(buckets.entries()).flatMap(([bucketIndex, bucketMatches]) => {
    if (bucketMatches.length < options.minHitCount) {
      return [];
    }
    return [createCandidate(asset, bucketIndex, bucketMatches, options.maxSamples)];
  });
}

function createMatch(item: DanmakuItem, rules: CutHintRule[]): CutHintMatch | null {
  const keywords = rules.filter((rule) => rule.pattern.test(item.text)).map((rule) => rule.label);
  if (keywords.length === 0) {
    return null;
  }
  return {
    item,
    sourceTimeMs: item.sourceTimeMs,
    keywords,
    score: rules
      .filter((rule) => keywords.includes(rule.label))
      .reduce((total, rule) => total + rule.weight, 0)
  };
}

function createCandidate(
  asset: DanmakuAsset,
  bucketIndex: number,
  matches: CutHintMatch[],
  maxSamples: number
): SuspectedCutCandidate {
  const sorted = [...matches].sort((left, right) => left.sourceTimeMs - right.sourceTimeMs);
  const sourceAtMs = sorted[Math.floor(sorted.length / 2)].sourceTimeMs;
  const score = sorted.reduce((total, match) => total + match.score, 0);
  const keywords = unique(sorted.flatMap((match) => match.keywords));
  return {
    id: `${asset.id}:${bucketIndex}`,
    assetId: asset.id,
    assetFileName: asset.fileName,
    sourceAtMs,
    startMs: sorted[0].sourceTimeMs,
    endMs: sorted[sorted.length - 1].sourceTimeMs,
    hitCount: sorted.length,
    score,
    confidence: resolveConfidence(sorted.length, score),
    keywords,
    sampleTexts: sorted.slice(0, maxSamples).map((match) => match.item.text),
    itemIds: sorted.map((match) => match.item.id)
  };
}

function resolveConfidence(hitCount: number, score: number): SuspectedCutConfidence {
  if (hitCount >= 5 || score >= 12) {
    return "high";
  }
  if (hitCount >= 3 || score >= 7) {
    return "medium";
  }
  return "low";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
