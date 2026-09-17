import { recognizeFamilyEvidence, familyTitle } from "./mediaFamilyEvidence";
import { resolveFamilyDurations } from "./familyPlayback";
import {
  formatEpisodeIdentity,
  parseProjectMediaEpisodeIdentity,
  type EpisodeIdentity
} from "./episodeIdentity";
import type {
  FamilyEvidenceStrength,
  MediaFamilyAnalysis,
  MediaFamilyContext,
  MediaFamilyFile,
  MediaFamilyGroup,
  MediaFamilyHypothesis,
  MediaFamilyIssue,
  MediaFamilyProject,
  MediaFamilyTitleCandidate
} from "./mediaFamilyTypes";

const naturalOrder = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const genericDirectory =
  /^(?:output|outputs|download|downloads|xml|danmaku|bilibili|video|videos|audio|temp|tmp|弹幕|视频|音频|素材|导出|下载|原片|参考|b站)$/i;
const rank: Record<FamilyEvidenceStrength, number> = { strong: 3, plausible: 2, weak: 1 };

/** Name/metadata analysis only: suggestions preserve provenance and never create time boundaries. */
export function analyzeMediaFamily(
  project: MediaFamilyProject,
  context: MediaFamilyContext = {}
): MediaFamilyAnalysis {
  const issues: MediaFamilyIssue[] = [];
  const titleCandidates: MediaFamilyTitleCandidate[] = [];
  const addTitle = (
    title: string,
    source: MediaFamilyTitleCandidate["source"],
    strength: FamilyEvidenceStrength,
    reason: string
  ) => {
    const cleaned = title.trim().replace(/[._]+/g, " ").replace(/\s+/g, " ");
    if (!cleaned || !/[\p{L}]/u.test(cleaned) || genericDirectory.test(cleaned)) return;
    const existing = titleCandidates.find(
      (candidate) => candidate.title.toLocaleLowerCase() === cleaned.toLocaleLowerCase()
    );
    if (existing) {
      if (rank[strength] > rank[existing.strength]) {
        existing.strength = strength;
        existing.source = source;
      }
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else titleCandidates.push({ title: cleaned, source, strength, reasons: [reason] });
  };
  if (context.importTitle)
    addTitle(context.importTitle, "importContext", "strong", "导入上下文提供的标题。");
  for (const media of project.mediaLibrary) {
    if (media.emby?.seriesName)
      addTitle(media.emby.seriesName, "emby", "strong", "Emby 剧名元数据。");
    else if (media.emby?.itemType === "Movie")
      addTitle(media.emby.itemName, "emby", "strong", "Emby 电影条目元数据。");
  }
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const sourcesByAsset = new Map<string, string[]>();
  for (const binding of project.danmakuSourceBindings) {
    const ids = sourcesByAsset.get(binding.assetId) ?? [];
    if (!ids.includes(binding.sourceMediaId)) ids.push(binding.sourceMediaId);
    sourcesByAsset.set(binding.assetId, ids);
  }
  const evidence = recognizeFamilyEvidence(project, context);
  const durations = resolveFamilyDurations(project, context);
  issues.push(...evidence.issues);
  const files = project.assets
    .map((asset): MediaFamilyFile => {
      const xmlSource =
        asset.xmlMetadata?.sources.length === 1 ? asset.xmlMetadata.sources[0] : undefined;
      if (xmlSource?.title)
        addTitle(xmlSource.title, "xmlMetadata", "strong", "XML 内嵌的来源视频标题。");
      const observation = evidence.observations.get(asset.id)!;
      const { directory, sequenceNumber, sourceGroupKey, sourceLabel } = observation;
      let identity = observation.identity;
      const sourceIds = sourcesByAsset.get(asset.id) ?? [];
      const boundMedia = sourceIds.length === 1 ? mediaById.get(sourceIds[0]) : undefined;
      const metadataIdentity = boundMedia ? parseProjectMediaEpisodeIdentity(boundMedia) : null;
      if (metadataIdentity?.source === "projectMetadata") {
        if (identity && identityKey(identity) !== identityKey(metadataIdentity)) {
          issues.push({
            code: "conflictingIdentity",
            assetIds: [asset.id],
            message: "文件名与已绑定媒体的季集信息冲突，未自动选定集号。"
          });
          identity = null;
        } else identity = metadataIdentity;
      }
      const partNumber = identity?.partNumber ?? observation.partNumber;
      addTitle(observation.title, "fileStem", "plausible", `文件名：${asset.fileName}`);
      if (directory) {
        for (const label of directory.split("/").slice(-3).reverse()) {
          const candidate = familyTitle(label);
          if (
            candidate &&
            !genericDirectory.test(candidate) &&
            !/^P\d+-\d+$|^BV[a-z0-9]+$/i.test(candidate)
          ) {
            addTitle(
              candidate,
              "directory",
              "weak",
              "来源目录名仅是候选，可能为别名，请确认。"
            );
            break;
          }
        }
      }
      const { durationMs, durationSource } = durations.get(asset.id)!;
      let lastCommentMs: number | null = null;
      for (const item of asset.items)
        if (Number.isSafeInteger(item.sourceTimeMs) && item.sourceTimeMs >= 0)
          lastCommentMs = Math.max(lastCommentMs ?? 0, item.sourceTimeMs);
      if (durationMs === null)
        issues.push({
          code: "unknownDuration",
          assetIds: [asset.id],
          message: "没有明确播放时长；末条弹幕只是覆盖下界，不能据此拼接或切集。"
        });
      return {
        assetId: asset.id,
        fileName: asset.fileName,
        sourceGroupKey,
        sourceLabel,
        sequenceNumber,
        partNumber,
        episodeIdentity: identity,
        durationMs,
        durationSource,
        lastCommentMs,
        itemCount: asset.items.length
      };
    })
    .sort(compareFiles);

  const groupsByKey = new Map<string, MediaFamilyGroup>();
  for (const file of files) {
    const identity = file.episodeIdentity;
    const episodeKey = identity ? identityKey(identity) : null;
    const key = `${file.sourceGroupKey}::${episodeKey ?? "unassigned"}`;
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        key,
        sourceGroupKey: file.sourceGroupKey,
        sourceLabel: file.sourceLabel,
        episodeKey,
        episodeLabel: identity
          ? formatEpisodeIdentity({ ...identity, partNumber: null })
          : "未确定集号",
        assetIds: []
      };
      groupsByKey.set(key, group);
    }
    group.assetIds.push(file.assetId);
  }
  const groups = [...groupsByKey.values()];
  const filesById = new Map(files.map((file) => [file.assetId, file]));
  const hypotheses: MediaFamilyHypothesis[] = [];
  const addHypothesis = (
    kind: MediaFamilyHypothesis["kind"],
    strength: FamilyEvidenceStrength,
    reason: string,
    group: MediaFamilyGroup
  ) => {
    const existing = hypotheses.find((hypothesis) => hypothesis.kind === kind);
    if (existing) {
      if (rank[strength] > rank[existing.strength]) existing.strength = strength;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.groupKeys.push(group.key);
    } else hypotheses.push({ kind, strength, reasons: [reason], groupKeys: [group.key] });
  };
  for (const group of groups) {
    const members = group.assetIds.map((id) => filesById.get(id)!);
    const identity = members[0].episodeIdentity;
    const parts = members
      .map((file) => file.partNumber)
      .filter((part): part is number => part !== null);
    if (identity && members.length > 1 && parts.length !== members.length)
      issues.push({
        code: "parallelVersions",
        assetIds: group.assetIds,
        message: "同集的多个文件没有完整分段编号，先分别保留；确认同源分段后可手动归为一集。"
      });
    if (new Set(parts).size !== parts.length)
      issues.push({
        code: "duplicatePart",
        assetIds: group.assetIds,
        message: "同一来源和集号出现重复分段编号，可能是不同版本或重复导入；勿自动混拼。"
      });
    if (identity && identity.episodeStart !== identity.episodeEnd) {
      addHypothesis(
        "longCollection",
        "strong",
        "文件名明确覆盖多集，但没有分集时间边界。",
        group
      );
    } else if (identity && members.length > 1) {
      addHypothesis(
        "episodeParts",
        parts.length === members.length && new Set(parts).size === parts.length
          ? "strong"
          : "plausible",
        "同一集对应多个文件；按明确分段编号排列，时长需另行确认。",
        group
      );
      addHypothesis("unknown", "weak", "同集文件也可能是重复下载或不同版本。", group);
    } else if (identity)
      addHypothesis("episodes", "strong", "存在明确的季集标识，按集分别整理。", group);
    else if (
      members.some(
        (file) =>
          /(?:整季|全季|季全|全集|合集|(?:全|共)\s*[\d零〇一二两三四五六七八九十百]+\s*[集话話])/.test(
            `${file.fileName} ${file.sourceLabel}`
          ) || (file.durationMs ?? file.lastCommentMs ?? 0) > 4 * 60 * 60 * 1000
      )
    ) {
      addHypothesis(
        "longCollection",
        "plausible",
        "名称或已知时间覆盖提示长合集，可能需要拆成多个观看单元；切点仍需确认。",
        group
      );
      addHypothesis(
        "unknown",
        "weak",
        "长文件也可能含较长片头或多次重复，无法仅由时长区分。",
        group
      );
    } else if (
      members.length > 1 &&
      (parts.length === members.length || members.every((file) => file.sequenceNumber !== null))
    ) {
      addHypothesis(
        "movieParts",
        "plausible",
        "存在分段或下载顺序，可能是分 P 的电影；页序号不能证明内容连续。",
        group
      );
      addHypothesis(
        "episodeParts",
        "weak",
        "也可能是一集或合集的分段，需要用户确认作品结构。",
        group
      );
    } else addHypothesis("unknown", "weak", "现有名称不足以区分电影、分集或合集。", group);
  }
  titleCandidates.sort(
    (left, right) =>
      rank[right.strength] - rank[left.strength] ||
      naturalOrder.compare(left.title, right.title)
  );
  const best = titleCandidates[0];
  const competing = titleCandidates.filter(
    (candidate) => candidate.strength === best?.strength
  );
  const suggestedTitle =
    best && best.strength !== "weak" && competing.length === 1 ? best.title : null;
  if (!suggestedTitle && files.length > 0)
    issues.push({
      code: "uncertainTitle",
      assetIds: files.map((file) => file.assetId),
      message: "标题来源不足或互相冲突，请从候选中确认或自行命名。"
    });
  return {
    suggestedTitle,
    titleCandidates,
    files,
    groups,
    hypotheses: hypotheses.sort((left, right) => rank[right.strength] - rank[left.strength]),
    issues,
    numberingSuggestions: evidence.suggestions
  };
}

function identityKey(identity: EpisodeIdentity): string {
  return `S${identity.seasonNumber ?? "?"}E${identity.episodeStart}${identity.episodeEnd !== identity.episodeStart ? `-E${identity.episodeEnd}` : ""}`;
}
function compareFiles(left: MediaFamilyFile, right: MediaFamilyFile): number {
  return (
    naturalOrder.compare(left.sourceGroupKey, right.sourceGroupKey) ||
    (left.episodeIdentity?.seasonNumber ?? -1) - (right.episodeIdentity?.seasonNumber ?? -1) ||
    (left.episodeIdentity?.episodeStart ?? -1) - (right.episodeIdentity?.episodeStart ?? -1) ||
    (left.partNumber ?? left.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.partNumber ?? right.sequenceNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.sequenceNumber ?? Number.MAX_SAFE_INTEGER) ||
    naturalOrder.compare(left.fileName, right.fileName) ||
    left.assetId.localeCompare(right.assetId)
  );
}

/** Import-time default only; a user-supplied title is never replaced. */
export function nameImportedProject<T extends MediaFamilyProject & { name: string }>(
  project: T
): T {
  if (project.name.trim() && project.name !== "未命名项目") return project;
  const analysis = analyzeMediaFamily(project);
  const mediaTitle =
    project.mediaLibrary.find((media) => media.role === "targetOriginal")?.name ??
    project.mediaLibrary[0]?.name;
  const title = analysis.suggestedTitle ?? mediaTitle ?? analysis.titleCandidates[0]?.title;
  return title ? { ...project, name: title.slice(0, 180) } : project;
}
