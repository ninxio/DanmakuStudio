import {
  formatEpisodeIdentity,
  parseEpisodeIdentity,
  parseProjectMediaEpisodeIdentity,
  type EpisodeIdentity
} from "./episodeIdentity";
import { recognizeFamilyEvidence } from "./mediaFamilyEvidence";
import type { MediaFamilyProject } from "./mediaFamilyTypes";
import type { EditorProject, ProjectMediaReference } from "./types";

export interface MediaEpisodeEvidence {
  identity: EpisodeIdentity | null;
  source: "projectMetadata" | "fileName" | "family";
  reason: string;
  conflicted?: boolean;
}
function sameCoverage(a: EpisodeIdentity, b: EpisodeIdentity): boolean {
  return (
    (a.seasonNumber === null || b.seasonNumber === null || a.seasonNumber === b.seasonNumber) &&
    a.episodeStart === b.episodeStart &&
    a.episodeEnd === b.episodeEnd
  );
}
function unknown(reason: string, conflicted = false): MediaEpisodeEvidence {
  return { identity: null, source: "fileName", reason, conflicted };
}
/** A cross-season collection cannot be represented by a single season/episode interval. */
function crossesSeasons(text: string): boolean {
  const seasons = [...text.normalize("NFKC").matchAll(/S(\d+)\s*E\d+/gi)].map((match) =>
    Number(match[1])
  );
  return new Set(seasons).size > 1;
}
export function resolveMediaEpisodeEvidence(
  media: ProjectMediaReference
): MediaEpisodeEvidence {
  const parsed = parseProjectMediaEpisodeIdentity(media);
  if (parsed?.source === "projectMetadata" && !crossesSeasons(media.episodeKey ?? "")) {
    return {
      identity: parsed,
      source: "projectMetadata",
      reason: "项目分集：" + formatEpisodeIdentity(parsed)
    };
  }
  const texts = [media.episodeLabel, media.name, media.fileName.replace(/\.[^.]+$/, "")].filter(
    (text): text is string => Boolean(text)
  );
  if (crossesSeasons(media.episodeKey ?? "") || texts.some(crossesSeasons))
    return unknown("跨季合集，保留全部所选原片供内容判断", true);
  const identities = texts
    .map(parseEpisodeIdentity)
    .filter((value): value is EpisodeIdentity => value !== null);
  if (!identities.length) return unknown("未识别季集，保留全部所选原片供内容判断");
  const identity = identities.find((value) => value.seasonNumber !== null) ?? identities[0];
  if (identities.some((value) => !sameCoverage(value, identity)))
    return unknown("素材名称中的季集信息冲突，保留候选", true);
  return {
    identity,
    source: "fileName",
    reason: "素材名称：" + formatEpisodeIdentity(identity)
  };
}

/** Metadata-only pass over the whole family, independent of current selection.
 * Never scans comments, infers duration, changes an arrangement, or confirms a time map.
 */
export function resolveProjectEpisodeEvidence(
  project: MediaFamilyProject
): ReadonlyMap<string, MediaEpisodeEvidence> {
  const result = new Map(
    project.mediaLibrary.map((media) => [media.id, resolveMediaEpisodeEvidence(media)])
  );
  const family = recognizeFamilyEvidence(project, {});
  const multiSourceAssets = new Set(
    project.assets
      .filter((asset) => (asset.xmlMetadata?.sources.length ?? 0) > 1)
      .map((asset) => asset.id)
  );
  const sourceIdsByAsset = new Map<string, Set<string>>();
  const assetsBySource = new Map<string, Set<string>>();
  for (const binding of project.danmakuSourceBindings) {
    const sourceIds = sourceIdsByAsset.get(binding.assetId) ?? new Set<string>();
    sourceIds.add(binding.sourceMediaId);
    sourceIdsByAsset.set(binding.assetId, sourceIds);
    const assets = assetsBySource.get(binding.sourceMediaId) ?? new Set<string>();
    assets.add(binding.assetId);
    assetsBySource.set(binding.sourceMediaId, assets);
  }
  for (const media of project.mediaLibrary) {
    if (media.role !== "bilibiliReference") continue;
    const direct = result.get(media.id)!;
    // Explicit project assignment is the user's correction; automatic evidence cannot rewrite it.
    if (direct.source === "projectMetadata" || direct.conflicted) continue;
    const assetIds = [...(assetsBySource.get(media.id) ?? [])];
    if (!assetIds.length) continue;
    const observations = assetIds.map((id) => family.observations.get(id));
    if (
      assetIds.some(
        (id) => sourceIdsByAsset.get(id)?.size !== 1 || multiSourceAssets.has(id)
      ) ||
      observations.some((value) => !value || value.blocked)
    ) {
      result.set(media.id, unknown("绑定的 XML 季集冲突或关联不唯一，保留候选"));
      continue;
    }
    const identities = observations.map((value) => value!.identity);
    // Unknown XML attached to the same reference may add coverage; do not silently drop it.
    if (identities.some((value) => value === null)) {
      if (observations.length > 1 || !direct.identity)
        result.set(media.id, unknown("绑定的 XML 尚有未确定集号，保留候选"));
      continue;
    }
    const known = identities as EpisodeIdentity[];
    const identity =
      known.find((value) => value.seasonNumber !== null) ?? direct.identity ?? known[0];
    if (
      known.some((value) => !sameCoverage(value, identity)) ||
      (direct.identity && known.some((value) => !sameCoverage(value, direct.identity!)))
    ) {
      result.set(media.id, unknown("参考与绑定 XML 的季集信息不一致，保留候选"));
      continue;
    }
    result.set(media.id, {
      identity,
      source: "family",
      reason: "绑定 XML 与同源编号：" + formatEpisodeIdentity(identity)
    });
  }
  return result;
}

/** Explicit naming hint uses existing project fields, undo and serialization. */
export function updateReferenceEpisodeHint(
  project: EditorProject,
  mediaId: string,
  text: string
): EditorProject {
  const media = project.mediaLibrary.find(
    (value) => value.id === mediaId && value.role === "bilibiliReference"
  );
  if (!media) throw new Error("参考素材已移除，请重新选择。");
  const value = text.trim();
  const identity = value ? parseEpisodeIdentity(value) : null;
  if (value && (!identity || crossesSeasons(value)))
    throw new Error("请输入 S01E01、S01E01-E03 或第 1 集；跨季合集请保留自动判断。");
  const episodeKey = identity
    ? (identity.seasonNumber === null ? "" : "S" + identity.seasonNumber) +
      "E" +
      identity.episodeStart +
      (identity.episodeEnd === identity.episodeStart ? "" : "-E" + identity.episodeEnd)
    : null;
  return {
    ...project,
    mediaLibrary: project.mediaLibrary.map((item) =>
      item.id === mediaId
        ? {
            ...item,
            episodeKey,
            episodeLabel: identity ? formatEpisodeIdentity(identity) : null
          }
        : item
    )
  };
}
