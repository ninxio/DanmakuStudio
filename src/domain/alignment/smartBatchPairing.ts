import type { ProjectMediaReference } from "../project/types";
import {
  resolveMediaEpisodeEvidence,
  type MediaEpisodeEvidence
} from "../project/mediaEpisodeEvidence";

export interface MediaEpisodeHint {
  seasonNumber: number | null;
  episodeStart: number;
  episodeEnd: number;
  source: MediaEpisodeEvidence["source"];
}
export interface SmartBatchPair {
  sourceMediaId: string;
  targetMediaId: string;
  reason: string;
}
export interface SmartBatchPairingPlan {
  mode: "metadataGuided" | "fullCartesian";
  pairs: SmartBatchPair[];
  totalCartesianPairCount: number;
  excludedPairCount: number;
  uncertainPairCount: number;
  summary: string;
  warnings: string[];
}

/** Retain every compatible edge: pieces, parallel versions and collections are normal.
 * Unknown evidence widens that row/column only; known disjoint ranges do not restart
 * the Cartesian product. Pair order stays target-major for native ordinals.
 */
export function createSmartBatchPairingPlan(
  sources: readonly ProjectMediaReference[],
  targets: readonly ProjectMediaReference[],
  evidence: ReadonlyMap<string, MediaEpisodeEvidence> = new Map()
): SmartBatchPairingPlan {
  const totalCartesianPairCount = sources.length * targets.length;
  const hints = new Map(
    [...sources, ...targets].map((media) => [
      media.id,
      evidence.get(media.id) ?? resolveMediaEpisodeEvidence(media)
    ])
  );
  const pairs: SmartBatchPair[] = [];
  const warnings: string[] = [];
  let uncertainPairCount = 0;
  for (const media of [...sources, ...targets]) {
    const hint = hints.get(media.id)!;
    if (!hint.identity) warnings.push(media.name + "：" + hint.reason + "。");
  }
  for (const target of targets) {
    const targetEvidence = hints.get(target.id)!;
    const targetHint = targetEvidence.identity;
    for (const source of sources) {
      const sourceEvidence = hints.get(source.id)!;
      const sourceHint = sourceEvidence.identity;
      if (
        sourceHint &&
        targetHint &&
        ((sourceHint.seasonNumber !== null &&
          targetHint.seasonNumber !== null &&
          sourceHint.seasonNumber !== targetHint.seasonNumber) ||
          sourceHint.episodeStart > targetHint.episodeEnd ||
          targetHint.episodeStart > sourceHint.episodeEnd)
      )
        continue;
      const uncertain = !sourceHint || !targetHint;
      if (uncertain) uncertainPairCount++;
      pairs.push({
        sourceMediaId: source.id,
        targetMediaId: target.id,
        reason: uncertain
          ? !sourceHint
            ? sourceEvidence.reason
            : targetEvidence.reason
          : sourceEvidence.reason
      });
    }
  }
  const usedSources = new Set(pairs.map((pair) => pair.sourceMediaId));
  const usedTargets = new Set(pairs.map((pair) => pair.targetMediaId));
  for (const source of sources)
    if (!usedSources.has(source.id))
      warnings.push(
        "“" + source.name + "”的集号不在所选原片范围内；请核对编号或选择全部组合。"
      );
  for (const target of targets)
    if (!usedTargets.has(target.id))
      warnings.push("“" + target.name + "”没有对应参考；请补充素材或核对编号。");
  const excludedPairCount = totalCartesianPairCount - pairs.length;
  return {
    mode: excludedPairCount > 0 ? "metadataGuided" : "fullCartesian",
    pairs,
    totalCartesianPairCount,
    excludedPairCount,
    uncertainPairCount,
    summary:
      totalCartesianPairCount === 0
        ? "请选择参考素材和原片。"
        : "根据季集范围建议分析 " +
          pairs.length +
          " 组，跳过 " +
          excludedPairCount +
          " 组明显跨分组组合。" +
          (uncertainPairCount ? "其中 " + uncertainPairCount + " 组因编号待确认而保留。" : ""),
    warnings
  };
}
export function parseMediaEpisodeHint(media: ProjectMediaReference): MediaEpisodeHint | null {
  const evidence = resolveMediaEpisodeEvidence(media);
  return evidence.identity
    ? {
        seasonNumber: evidence.identity.seasonNumber,
        episodeStart: evidence.identity.episodeStart,
        episodeEnd: evidence.identity.episodeEnd,
        source: evidence.source
      }
    : null;
}
