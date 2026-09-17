import type { DanmakuAsset } from "../danmaku/types";
import {
  formatEpisodeIdentity,
  parseOrderedEpisodeIdentity,
  parseProjectMediaEpisodeIdentity,
  type EpisodeIdentity
} from "./episodeIdentity";
import type { DanmakuSourceBinding, EditorProject, ProjectMediaReference } from "./types";
import {
  matchSourceMaterialNames,
  parseSourceMaterialName,
  sourceMaterialWorksConflict,
  type SourceMaterialName
} from "./sourceMaterialIdentity";

export type MaterialIntakeEvidenceCode =
  | "seasonEpisode"
  | "episode"
  | "range"
  | "part"
  | "targetOriginal"
  | "exactStem"
  | "sourcePart";

export interface MaterialIntakeEvidence {
  code: MaterialIntakeEvidenceCode;
  strength: "strong" | "supporting";
  message: string;
}

export interface MaterialIntakeSuggestion {
  id: string;
  assetId: string;
  assetFileName: string;
  sourceMediaId: string;
  sourceMediaFileName: string;
  targetMediaId: string | null;
  targetMediaFileName: string | null;
  episodeLabel: string;
  episodeIdentity: EpisodeIdentity | null;
  evidence: MaterialIntakeEvidence[];
}

export type MaterialIntakeConflictReason =
  | "duplicateXmlEpisode"
  | "multipleReferenceCandidates"
  | "crossSeason"
  | "relationshipShape"
  | "manyToOne"
  | "sourceAlreadyBound";

export interface MaterialIntakeConflict {
  id: string;
  assetId: string;
  assetFileName: string;
  episodeLabel: string;
  reason: MaterialIntakeConflictReason;
  message: string;
  candidateSourceMediaIds: string[];
  candidateSourceFileNames: string[];
}

export type MaterialIntakeUnresolvedReason =
  "missingXmlEpisode" | "noReferenceMedia" | "missingReferenceEpisode" | "noReferenceMatch";

export interface MaterialIntakeUnresolved {
  id: string;
  assetId: string;
  assetFileName: string;
  episodeLabel: string | null;
  reason: MaterialIntakeUnresolvedReason;
  message: string;
}

export interface MaterialIntakePreservedBinding {
  assetId: string;
  assetFileName: string;
  sourceMediaId: string;
  sourceMediaFileName: string | null;
  episodeLabel: string | null;
  message: string;
}

export interface MaterialIntakePlan {
  projectId: string;
  sourceProjectUpdatedAt: string;
  suggestions: MaterialIntakeSuggestion[];
  conflicts: MaterialIntakeConflict[];
  unresolved: MaterialIntakeUnresolved[];
  preservedBindings: MaterialIntakePreservedBinding[];
}

interface ParsedAsset {
  asset: DanmakuAsset;
  identity: EpisodeIdentity | null;
  name: SourceMaterialName;
}

interface ParsedMedia {
  media: ProjectMediaReference;
  identity: EpisodeIdentity | null;
  name: SourceMaterialName;
}

interface ProvisionalSuggestion {
  asset: ParsedAsset;
  source: ParsedMedia;
  target: ParsedMedia | null;
  nameEvidence: "exactStem" | "sourcePart" | null;
}

export function createMaterialIntakePlan(project: EditorProject): MaterialIntakePlan {
  const parsedAssets = project.assets.map((asset, sourceOrder) => {
    const parsed = parseOrderedEpisodeIdentity(asset.fileName, sourceOrder);
    return {
      asset,
      identity: parsed.fallback ? null : copyEpisodeIdentity(parsed),
      name: parseSourceMaterialName(asset.fileName)
    } satisfies ParsedAsset;
  });
  const referenceMedia = parseMediaByRole(project.mediaLibrary, "bilibiliReference");
  const targetMedia = parseMediaByRole(project.mediaLibrary, "targetOriginal");
  const existingByAssetId = new Map(
    project.danmakuSourceBindings.map((binding) => [binding.assetId, binding] as const)
  );
  const existingAssetsBySourceId = groupExistingAssetsBySource(project.danmakuSourceBindings);
  const conflicts: MaterialIntakeConflict[] = [];
  const unresolved: MaterialIntakeUnresolved[] = [];
  const preservedBindings: MaterialIntakePreservedBinding[] = [];
  const provisional: ProvisionalSuggestion[] = [];

  for (const parsedAsset of parsedAssets) {
    const existing = existingByAssetId.get(parsedAsset.asset.id);
    if (existing) {
      preservedBindings.push(
        createPreservedBinding(parsedAsset, existing, project.mediaLibrary)
      );
      continue;
    }
    const namedReferences = referenceMedia.filter(
      (candidate) => matchSourceMaterialNames(parsedAsset.name, candidate.name) !== null
    );
    if (!parsedAsset.identity && namedReferences.length === 0) {
      unresolved.push(
        createUnresolved(
          parsedAsset,
          "missingXmlEpisode",
          `“${parsedAsset.asset.fileName}”没有唯一同名参考素材，也未识别到明确季集；导入顺序和单独的 P 序号不会作为跨作品绑定依据。`
        )
      );
      continue;
    }
    if (referenceMedia.length === 0) {
      unresolved.push(
        createUnresolved(
          parsedAsset,
          "noReferenceMedia",
          "尚未导入 B 站参考素材，无法生成 XML 来源关系建议。"
        )
      );
      continue;
    }

    const parsedReferences = referenceMedia.filter(
      (candidate): candidate is ParsedMedia & { identity: EpisodeIdentity } =>
        candidate.identity !== null
    );
    if (parsedReferences.length === 0 && namedReferences.length === 0) {
      unresolved.push(
        createUnresolved(
          parsedAsset,
          "missingReferenceEpisode",
          "现有 B 站参考素材都没有明确季集信息，请逐项选择来源。"
        )
      );
      continue;
    }

    const candidates =
      namedReferences.length > 0
        ? namedReferences
        : parsedReferences.filter(
            (candidate) =>
              isExactRelationship(parsedAsset.identity!, candidate.identity) &&
              !sourceMaterialWorksConflict(parsedAsset.name, candidate.name)
          );
    if (candidates.length > 1) {
      conflicts.push(
        createConflict(
          parsedAsset,
          "multipleReferenceCandidates",
          `有 ${candidates.length} 个 B 站参考素材都与${assetIdentityLabel(parsedAsset)}一致，不能自动选择。`,
          candidates
        )
      );
      continue;
    }
    if (candidates.length === 0) {
      const crossSeasonCandidates = parsedReferences.filter((candidate) =>
        isCrossSeasonMatch(parsedAsset.identity!, candidate.identity)
      );
      if (crossSeasonCandidates.length > 0) {
        conflicts.push(
          createConflict(
            parsedAsset,
            "crossSeason",
            `${assetIdentityLabel(parsedAsset)}只找到其他季的同集参考素材，不能跨季自动绑定。`,
            crossSeasonCandidates
          )
        );
        continue;
      }
      const shapeCandidates = parsedReferences.filter((candidate) =>
        hasRelationshipShapeConflict(parsedAsset.identity!, candidate.identity)
      );
      if (shapeCandidates.length > 0) {
        conflicts.push(
          createConflict(
            parsedAsset,
            "relationshipShape",
            `${assetIdentityLabel(parsedAsset)}与参考素材的范围或 Part 形状不一致，请逐项确认。`,
            shapeCandidates
          )
        );
        continue;
      }
      unresolved.push(
        createUnresolved(
          parsedAsset,
          "noReferenceMatch",
          `${assetIdentityLabel(parsedAsset)}没有找到名称及季集一致的 B 站参考素材。`
        )
      );
      continue;
    }

    const [source] = candidates;
    if (
      parsedAsset.identity &&
      source.identity &&
      !isExactRelationship(parsedAsset.identity, source.identity)
    ) {
      conflicts.push(
        createConflict(
          parsedAsset,
          seasonsAreCompatible(parsedAsset.identity, source.identity)
            ? "relationshipShape"
            : "crossSeason",
          "文件名相同，但明确的季集或 Part 信息不一致，请逐项确认。",
          [source]
        )
      );
      continue;
    }
    const existingAssetIds = existingAssetsBySourceId.get(source.media.id) ?? [];
    if (existingAssetIds.length > 0) {
      conflicts.push(
        createConflict(
          parsedAsset,
          "sourceAlreadyBound",
          `“${source.media.fileName}”已被其他 XML 使用；为避免形成未声明的多对一关系，本项需要手动确认。`,
          [source]
        )
      );
      continue;
    }
    const targetResolution =
      parsedAsset.identity && source.identity
        ? resolveSupportingTarget(
            parsedAsset.identity,
            { ...source, identity: source.identity },
            targetMedia
          )
        : { target: null, conflictingTargets: [] };
    if (targetResolution.conflictingTargets.length > 0) {
      const conflictingTargetNames = targetResolution.conflictingTargets
        .map((candidate) => `“${candidate.media.fileName}”`)
        .join("、");
      conflicts.push(
        createConflict(
          parsedAsset,
          "crossSeason",
          `${assetIdentityLabel(parsedAsset)}的参考素材“${source.media.fileName}”与同集原片 ${conflictingTargetNames} 季号不一致，不能自动应用。`,
          [source]
        )
      );
      continue;
    }
    provisional.push({
      asset: parsedAsset,
      source,
      target: targetResolution.target,
      nameEvidence: matchSourceMaterialNames(parsedAsset.name, source.name)
    });
  }

  const conflictingAssetIds = collectBatchRelationshipConflicts(provisional, conflicts);
  const suggestions = provisional
    .filter((candidate) => !conflictingAssetIds.has(candidate.asset.asset.id))
    .map(createSuggestion);

  const compareRows = createMaterialRowComparator(parsedAssets);
  return {
    projectId: project.id,
    sourceProjectUpdatedAt: project.updatedAt,
    suggestions: suggestions.sort(compareRows),
    conflicts: conflicts.sort(compareRows),
    unresolved: unresolved.sort(compareRows),
    preservedBindings: preservedBindings.sort(compareRows)
  };
}

function parseMediaByRole(
  mediaLibrary: readonly ProjectMediaReference[],
  role: ProjectMediaReference["role"]
): ParsedMedia[] {
  return mediaLibrary
    .filter((media) => media.role === role)
    .map((media) => ({
      media,
      identity: parseProjectMediaEpisodeIdentity(media),
      name: parseSourceMaterialName(media.fileName)
    }))
    .sort((left, right) => compareMedia(left.media, right.media));
}

function groupExistingAssetsBySource(
  bindings: readonly DanmakuSourceBinding[]
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const binding of bindings) {
    grouped.set(binding.sourceMediaId, [
      ...(grouped.get(binding.sourceMediaId) ?? []),
      binding.assetId
    ]);
  }
  return grouped;
}

function collectBatchRelationshipConflicts(
  provisional: readonly ProvisionalSuggestion[],
  conflicts: MaterialIntakeConflict[]
): Set<string> {
  const conflictingAssetIds = new Set<string>();
  const byIdentity = groupBy(provisional, (candidate) =>
    candidate.nameEvidence
      ? `name:${candidate.asset.name.partKey ?? candidate.asset.name.stem}`
      : createEpisodeIdentityKey(candidate.asset.identity!)
  );
  for (const group of byIdentity.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const candidate of group) {
      conflictingAssetIds.add(candidate.asset.asset.id);
      conflicts.push(
        createConflict(
          candidate.asset,
          "duplicateXmlEpisode",
          `同批有 ${group.length} 个 XML 都标记为 ${assetIdentityLabel(candidate.asset)}；不能判断是重复文件还是多段关系。`,
          uniqueMedia(group.map((item) => item.source))
        )
      );
    }
  }

  const remaining = provisional.filter(
    (candidate) => !conflictingAssetIds.has(candidate.asset.asset.id)
  );
  const bySource = groupBy(remaining, (candidate) => candidate.source.media.id);
  for (const group of bySource.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const candidate of group) {
      conflictingAssetIds.add(candidate.asset.asset.id);
      conflicts.push(
        createConflict(
          candidate.asset,
          "manyToOne",
          `同一个参考素材“${candidate.source.media.fileName}”会被 ${group.length} 个 XML 使用；请先确认这是否为多对一关系。`,
          [candidate.source]
        )
      );
    }
  }
  return conflictingAssetIds;
}

function createSuggestion(candidate: ProvisionalSuggestion): MaterialIntakeSuggestion {
  const identity = candidate.asset.identity;
  const evidence: MaterialIntakeEvidence[] = candidate.nameEvidence
    ? [
        {
          code: candidate.nameEvidence,
          strength: "strong",
          message:
            candidate.nameEvidence === "exactStem"
              ? "XML 与参考素材文件名一致（忽略扩展名、全角字符与大小写），且双方均无重复候选。"
              : "XML 与参考素材的作品名称和明确 Part 一致，且双方均无重复候选。"
        }
      ]
    : [
        {
          code: identity!.seasonNumber === null ? "episode" : "seasonEpisode",
          strength: "strong",
          message: `XML 与参考素材都明确标记为 ${formatEpisodeIdentity(identity!)}，且只有一个参考素材候选。`
        }
      ];
  if (identity && identity.episodeStart !== identity.episodeEnd) {
    evidence.push({
      code: "range",
      strength: "strong",
      message: `双方覆盖相同的第 ${identity.episodeStart}–${identity.episodeEnd} 集范围。`
    });
  }
  if (identity && identity.partNumber !== null) {
    evidence.push({
      code: "part",
      strength: "strong",
      message: `双方都标记 Part ${identity.partNumber}。`
    });
  }
  if (candidate.target) {
    evidence.push({
      code: "targetOriginal",
      strength: "supporting",
      message: `同集原片为“${candidate.target.media.fileName}”。`
    });
  }
  return {
    id: `material-intake:${candidate.asset.asset.id}:${candidate.source.media.id}`,
    assetId: candidate.asset.asset.id,
    assetFileName: candidate.asset.asset.fileName,
    sourceMediaId: candidate.source.media.id,
    sourceMediaFileName: candidate.source.media.fileName,
    targetMediaId: candidate.target?.media.id ?? null,
    targetMediaFileName: candidate.target?.media.fileName ?? null,
    episodeLabel: assetIdentityLabel(candidate.asset),
    episodeIdentity: identity ? copyEpisodeIdentity(identity) : null,
    evidence
  };
}

function createConflict(
  asset: ParsedAsset,
  reason: MaterialIntakeConflictReason,
  message: string,
  candidates: readonly ParsedMedia[]
): MaterialIntakeConflict {
  const uniqueCandidates = uniqueMedia(candidates);
  return {
    id: `material-intake-conflict:${asset.asset.id}:${reason}`,
    assetId: asset.asset.id,
    assetFileName: asset.asset.fileName,
    episodeLabel: assetIdentityLabel(asset),
    reason,
    message,
    candidateSourceMediaIds: uniqueCandidates.map((candidate) => candidate.media.id),
    candidateSourceFileNames: uniqueCandidates.map((candidate) => candidate.media.fileName)
  };
}

function assetIdentityLabel(asset: ParsedAsset): string {
  return asset.identity ? formatEpisodeIdentity(asset.identity) : asset.asset.fileName;
}

function createUnresolved(
  asset: ParsedAsset,
  reason: MaterialIntakeUnresolvedReason,
  message: string
): MaterialIntakeUnresolved {
  return {
    id: `material-intake-unresolved:${asset.asset.id}:${reason}`,
    assetId: asset.asset.id,
    assetFileName: asset.asset.fileName,
    episodeLabel: asset.identity ? formatEpisodeIdentity(asset.identity) : null,
    reason,
    message
  };
}

function createPreservedBinding(
  parsedAsset: ParsedAsset,
  binding: DanmakuSourceBinding,
  mediaLibrary: readonly ProjectMediaReference[]
): MaterialIntakePreservedBinding {
  const source = mediaLibrary.find((media) => media.id === binding.sourceMediaId) ?? null;
  return {
    assetId: parsedAsset.asset.id,
    assetFileName: parsedAsset.asset.fileName,
    sourceMediaId: binding.sourceMediaId,
    sourceMediaFileName: source?.fileName ?? null,
    episodeLabel: parsedAsset.identity ? formatEpisodeIdentity(parsedAsset.identity) : null,
    message: `已有绑定已保留：${parsedAsset.asset.fileName} → ${source?.fileName ?? binding.sourceMediaId}。`
  };
}

function isExactRelationship(left: EpisodeIdentity, right: EpisodeIdentity): boolean {
  return hasSameEpisodeShape(left, right) && seasonsAreCompatible(left, right);
}

function isCrossSeasonMatch(left: EpisodeIdentity, right: EpisodeIdentity): boolean {
  return (
    hasSameEpisodeShape(left, right) &&
    left.seasonNumber !== null &&
    right.seasonNumber !== null &&
    left.seasonNumber !== right.seasonNumber
  );
}

function resolveSupportingTarget(
  assetIdentity: EpisodeIdentity,
  source: ParsedMedia & { identity: EpisodeIdentity },
  targetMedia: readonly ParsedMedia[]
): { target: ParsedMedia | null; conflictingTargets: ParsedMedia[] } {
  const shapeCandidates = targetMedia.filter(
    (candidate): candidate is ParsedMedia & { identity: EpisodeIdentity } =>
      candidate.identity !== null && hasSameEpisodeShape(assetIdentity, candidate.identity)
  );
  const knownSeason = assetIdentity.seasonNumber ?? source.identity.seasonNumber;
  if (knownSeason === null) {
    return {
      target: shapeCandidates.length === 1 ? shapeCandidates[0] : null,
      conflictingTargets: []
    };
  }
  const compatibleTargets = shapeCandidates.filter(
    (candidate) =>
      candidate.identity.seasonNumber === null ||
      candidate.identity.seasonNumber === knownSeason
  );
  if (compatibleTargets.length > 0) {
    return {
      target: compatibleTargets.length === 1 ? compatibleTargets[0] : null,
      conflictingTargets: []
    };
  }
  return {
    target: null,
    conflictingTargets: shapeCandidates.filter(
      (candidate) =>
        candidate.identity.seasonNumber !== null &&
        candidate.identity.seasonNumber !== knownSeason
    )
  };
}

function hasSameEpisodeShape(left: EpisodeIdentity, right: EpisodeIdentity): boolean {
  return (
    left.episodeStart === right.episodeStart &&
    left.episodeEnd === right.episodeEnd &&
    left.partNumber === right.partNumber
  );
}

function hasRelationshipShapeConflict(left: EpisodeIdentity, right: EpisodeIdentity): boolean {
  if (!seasonsAreCompatible(left, right)) {
    return false;
  }
  const overlaps =
    left.episodeStart <= right.episodeEnd && right.episodeStart <= left.episodeEnd;
  return (
    overlaps &&
    (left.episodeStart !== right.episodeStart ||
      left.episodeEnd !== right.episodeEnd ||
      left.partNumber !== right.partNumber)
  );
}

function seasonsAreCompatible(left: EpisodeIdentity, right: EpisodeIdentity): boolean {
  return (
    left.seasonNumber === null ||
    right.seasonNumber === null ||
    left.seasonNumber === right.seasonNumber
  );
}

function createEpisodeIdentityKey(identity: EpisodeIdentity): string {
  return `${identity.seasonNumber ?? "unknown"}:${identity.episodeStart}-${identity.episodeEnd}:${identity.partNumber ?? "whole"}`;
}

function copyEpisodeIdentity(identity: EpisodeIdentity): EpisodeIdentity {
  return {
    seasonNumber: identity.seasonNumber,
    episodeStart: identity.episodeStart,
    episodeEnd: identity.episodeEnd,
    partNumber: identity.partNumber,
    pattern: identity.pattern,
    evidenceStrength: identity.evidenceStrength
  };
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return grouped;
}

function uniqueMedia(values: readonly ParsedMedia[]): ParsedMedia[] {
  const byId = new Map(values.map((value) => [value.media.id, value] as const));
  return Array.from(byId.values()).sort((left, right) => compareMedia(left.media, right.media));
}

function compareMedia(left: ProjectMediaReference, right: ProjectMediaReference): number {
  return (
    left.fileName.localeCompare(right.fileName, "zh-CN") ||
    left.id.localeCompare(right.id, "en-US")
  );
}

function createMaterialRowComparator(parsedAssets: readonly ParsedAsset[]) {
  const byAssetId = new Map(parsedAssets.map((entry) => [entry.asset.id, entry] as const));
  return (left: { assetId: string }, right: { assetId: string }): number => {
    const leftAsset = byAssetId.get(left.assetId);
    const rightAsset = byAssetId.get(right.assetId);
    if (!leftAsset || !rightAsset) {
      return left.assetId.localeCompare(right.assetId, "en-US");
    }
    return compareParsedAssets(leftAsset, rightAsset);
  };
}

function compareParsedAssets(left: ParsedAsset, right: ParsedAsset): number {
  if (left.identity && right.identity) {
    return (
      compareNullableNumber(left.identity.seasonNumber, right.identity.seasonNumber) ||
      left.identity.episodeStart - right.identity.episodeStart ||
      left.identity.episodeEnd - right.identity.episodeEnd ||
      compareNullableNumber(left.identity.partNumber, right.identity.partNumber) ||
      compareAssets(left.asset, right.asset)
    );
  }
  if (left.identity) {
    return -1;
  }
  if (right.identity) {
    return 1;
  }
  return compareAssets(left.asset, right.asset);
}

function compareNullableNumber(left: number | null, right: number | null): number {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
}

function compareAssets(left: DanmakuAsset, right: DanmakuAsset): number {
  return (
    left.fileName.localeCompare(right.fileName, "zh-CN") ||
    left.id.localeCompare(right.id, "en-US")
  );
}
