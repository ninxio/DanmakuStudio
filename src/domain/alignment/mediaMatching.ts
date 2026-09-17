import type { AlignmentProposal, AlignmentTimeMapProposal, CutCandidate } from "./types";
import {
  isAlignmentTimeMapProposal,
  reconcileAlignmentTimeMapProposalQuality
} from "./timeMapProposal";
import {
  applyTrustedAutomaticMediaTimeMapVerification,
  areMediaTimeMapImmutableLineagesEquivalent,
  assessTrustedAutomaticMediaTimeMapVerificationEligibility,
  confirmCandidateTimeMap,
  createCandidateTimeMapId,
  createConfirmedTimeMapId,
  createLegacyMediaTimeMap,
  reconcileMediaTimeMapQuality,
  supersedeMediaTimeMap
} from "./mediaTimeMap";
import { createDanmakuSourceSegment } from "../project/sourceTimeline";
import type {
  EditorProject,
  MediaMatchCandidate,
  MediaTimeMap,
  ProjectMediaReference,
  SegmentTimingRule
} from "../project/types";
import type { Milliseconds } from "../shared/time";
import { cloneMediaContentIdentity } from "../project/mediaIdentity";
import {
  invalidateTimeMapSpanEvidenceForManualReview,
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  type TimeMapBoundaryEvidence
} from "./timeMap";
import {
  applyCandidateTimeMapManualTakeover,
  applySystemSuggestedTimeMapReviews
} from "./timeMapReviewDecision";

export interface CreateMediaMatchCandidateInput {
  id: string;
  batchId: string;
  sourceMediaId: string;
  targetMediaId: string;
  proposal: AlignmentProposal;
}

export interface MediaMatchRangePatch {
  sourceStartMs?: Milliseconds;
  sourceEndMs?: Milliseconds;
  targetStartMs?: Milliseconds;
  targetEndMs?: Milliseconds;
}

type MediaMatchProjectContext = Pick<
  EditorProject,
  "assets" | "mediaLibrary" | "danmakuSourceBindings"
>;

/**
 * 把带 matchRange 的单素材对齐提案转成可持久化的媒体级候选。
 * 提案和段内规则 ID 会进入候选命名空间，避免批量任务之间发生碰撞。
 */
export function createMediaMatchCandidate(
  project: MediaMatchProjectContext,
  input: CreateMediaMatchCandidateInput,
  timestamp = new Date().toISOString()
): MediaMatchCandidate {
  const id = requireIdentifier(input.id, "匹配候选 ID");
  const batchId = requireIdentifier(input.batchId, "匹配批次 ID");
  const sourceMediaId = requireIdentifier(input.sourceMediaId, "参考素材 ID");
  const targetMediaId = requireIdentifier(input.targetMediaId, "目标原片 ID");
  if (sourceMediaId === targetMediaId) {
    throw new Error("参考素材和目标原片不能是同一个媒体记录。");
  }
  const { source, target } = requireMediaPair(
    project.mediaLibrary,
    sourceMediaId,
    targetMediaId
  );
  const range = input.proposal.matchRange;
  if (!range) {
    throw new Error("对齐提案缺少 matchRange，无法创建媒体匹配候选。");
  }
  validateMediaMatchRange(range, source, target);
  validateProposalItemsInRange(input.proposal, range);
  validateProposalTimeMapInRange(input.proposal, range);

  const proposal = namespaceProposal(input.proposal, id);
  const timingRules = createTimingRules(
    proposal.cutCandidates,
    id,
    range.sourceStartMs,
    range.sourceEndMs
  );
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  return {
    id,
    batchId,
    sourceMediaId,
    targetMediaId,
    sourceStartMs: range.sourceStartMs,
    sourceEndMs: range.sourceEndMs,
    targetStartMs: range.targetStartMs,
    targetEndMs: range.targetEndMs,
    timingRules,
    confidence: proposal.confidence,
    proposal,
    timeMapId: createCandidateTimeMapId(id),
    confirmedTimeMapId: null,
    state: hasBoundAsset && !isProposalBlocked(proposal) ? "pending" : "blocked",
    appliedSegmentIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/** 更新待复核候选的区间；接受或拒绝后的候选不可静默改写。 */
export function updateMediaMatchCandidateRange(
  project: EditorProject,
  candidateId: string,
  patch: MediaMatchRangePatch,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state === "accepted" || candidate.state === "rejected") {
    throw new Error(
      candidate.state === "accepted"
        ? "已接受的匹配候选不能修改区间。"
        : "已拒绝的匹配候选不能修改区间。"
    );
  }
  const nextSourceStartMs = patch.sourceStartMs ?? candidate.sourceStartMs;
  const nextSourceEndMs = patch.sourceEndMs ?? candidate.sourceEndMs;
  const nextTargetStartMs = patch.targetStartMs ?? candidate.targetStartMs;
  const nextTargetEndMs = patch.targetEndMs ?? candidate.targetEndMs;
  if (
    nextSourceStartMs === candidate.sourceStartMs &&
    nextSourceEndMs === candidate.sourceEndMs &&
    nextTargetStartMs === candidate.targetStartMs &&
    nextTargetEndMs === candidate.targetEndMs
  ) {
    return project;
  }
  const { source, target } = requireMediaPair(
    project.mediaLibrary,
    candidate.sourceMediaId,
    candidate.targetMediaId
  );
  const range = {
    sourceStartMs: nextSourceStartMs,
    sourceEndMs: nextSourceEndMs,
    targetStartMs: nextTargetStartMs,
    targetEndMs: nextTargetEndMs,
    coverage: candidate.proposal.matchRange?.coverage ?? candidate.confidence
  };
  const sourceTranslationMs = getWholeRangeTranslation(
    candidate.sourceStartMs,
    candidate.sourceEndMs,
    patch.sourceStartMs,
    patch.sourceEndMs
  );
  const targetTranslationMs = getWholeRangeTranslation(
    candidate.targetStartMs,
    candidate.targetEndMs,
    patch.targetStartMs,
    patch.targetEndMs
  );
  const translatedProposal = translateProposalCoordinates(
    candidate.proposal,
    sourceTranslationMs,
    targetTranslationMs
  );
  const adjustedProposal = clipProposalToRange(translatedProposal, range);
  const adjustedTimingRules = candidate.timingRules
    .map((rule) => ({
      ...rule,
      sourceAtMs: rule.sourceAtMs + sourceTranslationMs
    }))
    .filter(
      (rule) => rule.sourceAtMs >= range.sourceStartMs && rule.sourceAtMs < range.sourceEndMs
    );
  validateMediaMatchRange(range, source, target);
  validateTimingRulesInRange(adjustedTimingRules, range.sourceStartMs, range.sourceEndMs);
  validateProposalItemsInRange(adjustedProposal, range);
  validateProposalTimeMapInRange(adjustedProposal, range);
  const hasBoundAsset = project.danmakuSourceBindings.some(
    (binding) =>
      binding.sourceMediaId === candidate.sourceMediaId &&
      project.assets.some((asset) => asset.id === binding.assetId)
  );
  const updated: MediaMatchCandidate = {
    ...candidate,
    sourceStartMs: range.sourceStartMs,
    sourceEndMs: range.sourceEndMs,
    targetStartMs: range.targetStartMs,
    targetEndMs: range.targetEndMs,
    timingRules: adjustedTimingRules,
    proposal: {
      ...adjustedProposal,
      matchRange: range
    },
    state: hasBoundAsset && !isProposalBlocked(adjustedProposal) ? "pending" : "blocked",
    updatedAt: timestamp
  };
  return replaceCandidateAndCandidateMap(project, updated, timestamp);
}

/**
 * 把候选与其 state=candidate 时间图作为一个原子项目变更写入。
 * 旧引擎只能生成 legacy-unverified/blocked 图，不能借候选分数升级质量等级。
 */
export function upsertMediaMatchCandidate(
  project: EditorProject,
  candidate: MediaMatchCandidate,
  timestamp = candidate.updatedAt
): EditorProject {
  const projectWithCurrentIdentities = synchronizeMediaIdentitySnapshots(project, candidate);
  const existing = projectWithCurrentIdentities.mediaMatchCandidates.some(
    (item) => item.id === candidate.id
  );
  const withCandidate: EditorProject = {
    ...projectWithCurrentIdentities,
    mediaMatchCandidates: existing
      ? projectWithCurrentIdentities.mediaMatchCandidates.map((item) =>
          item.id === candidate.id ? candidate : item
        )
      : [...projectWithCurrentIdentities.mediaMatchCandidates, candidate]
  };
  return replaceCandidateAndCandidateMap(withCandidate, candidate, timestamp);
}

/**
 * 清理匹配候选与已应用来源段之间的派生引用。
 * 已应用段全部失效时，候选回到可复核状态；媒体已删除时，候选本身也随之移除。
 */
export function reconcileMediaMatchCandidates(
  project: EditorProject,
  timestamp = new Date().toISOString()
): EditorProject {
  const mediaIds = new Set(project.mediaLibrary.map((media) => media.id));
  const assetsById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const bindingsByAssetId = new Map(
    project.danmakuSourceBindings.map((binding) => [binding.assetId, binding])
  );
  const segmentsById = new Map(
    project.danmakuSourceSegments.map((segment) => [segment.id, segment])
  );
  const supersededMapIds = new Set<string>();
  let changed = false;
  const mediaMatchCandidates = project.mediaMatchCandidates.flatMap((candidate) => {
    if (!mediaIds.has(candidate.sourceMediaId) || !mediaIds.has(candidate.targetMediaId)) {
      changed = true;
      return [];
    }
    const appliedSegmentIds = candidate.appliedSegmentIds.filter((segmentId) => {
      const segment = segmentsById.get(segmentId);
      if (!segment || segment.kind !== "content" || !segment.assetId) {
        return false;
      }
      const binding = bindingsByAssetId.get(segment.assetId);
      return (
        assetsById.has(segment.assetId) &&
        binding?.sourceMediaId === candidate.sourceMediaId &&
        segmentId === createAppliedSegmentId(candidate.id, segment.assetId) &&
        segment.sourceMediaId === candidate.sourceMediaId &&
        segment.targetMediaId === candidate.targetMediaId &&
        candidate.confirmedTimeMapId !== null &&
        segment.timeMapId === candidate.confirmedTimeMapId
      );
    });
    const hasBoundAsset = project.danmakuSourceBindings.some(
      (binding) =>
        binding.sourceMediaId === candidate.sourceMediaId && assetsById.has(binding.assetId)
    );
    const state: MediaMatchCandidate["state"] =
      candidate.state === "rejected"
        ? "rejected"
        : appliedSegmentIds.length > 0
          ? "accepted"
          : hasBoundAsset && !isProposalBlocked(candidate.proposal)
            ? "pending"
            : "blocked";
    const normalizedAppliedSegmentIds = state === "accepted" ? appliedSegmentIds : [];
    const confirmedTimeMapId = state === "accepted" ? candidate.confirmedTimeMapId : null;
    if (candidate.confirmedTimeMapId && confirmedTimeMapId === null) {
      supersededMapIds.add(candidate.confirmedTimeMapId);
    }
    if (
      state === candidate.state &&
      confirmedTimeMapId === candidate.confirmedTimeMapId &&
      normalizedAppliedSegmentIds.length === candidate.appliedSegmentIds.length &&
      normalizedAppliedSegmentIds.every(
        (id, index) => id === candidate.appliedSegmentIds[index]
      )
    ) {
      return [candidate];
    }
    changed = true;
    return [
      {
        ...candidate,
        state,
        confirmedTimeMapId,
        appliedSegmentIds: normalizedAppliedSegmentIds,
        updatedAt: timestamp
      }
    ];
  });
  const referencedTimeMapIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.timeMapId ? [segment.timeMapId] : []
    )
  );
  let mediaTimeMaps = project.mediaTimeMaps
    .filter((map) => mediaIds.has(map.sourceMediaId) && mediaIds.has(map.targetMediaId))
    .map((map) =>
      supersededMapIds.has(map.id) &&
      !referencedTimeMapIds.has(map.id) &&
      map.state === "confirmed"
        ? supersedeMediaTimeMap(map, timestamp)
        : map
    );
  if (mediaTimeMaps.length !== project.mediaTimeMaps.length || supersededMapIds.size > 0) {
    changed = true;
  }
  for (const candidate of mediaMatchCandidates) {
    if (mediaTimeMaps.some((map) => map.id === candidate.timeMapId)) {
      continue;
    }
    mediaTimeMaps = [...mediaTimeMaps, createCandidateTimeMap(candidate, timestamp)];
    changed = true;
  }
  return changed ? { ...project, mediaMatchCandidates, mediaTimeMaps } : project;
}

/** 拒绝待复核候选；不会修改任何已确认来源段。 */
export function rejectMediaMatchCandidate(
  project: EditorProject,
  candidateId: string,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state === "accepted") {
    throw new Error("已接受的匹配候选不能直接拒绝，请先删除对应来源段。");
  }
  if (candidate.state === "rejected") {
    return project;
  }
  return replaceCandidateAndCandidateMap(project, {
    ...candidate,
    state: "rejected",
    confirmedTimeMapId: null,
    appliedSegmentIds: [],
    updatedAt: timestamp
  }, timestamp, false);
}

/** 撤销已确认候选，只删除该候选生成的来源段，并把候选恢复为待复核或阻塞状态。 */
export function revokeMediaMatchCandidateAcceptance(
  project: EditorProject,
  candidateId: string,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state !== "accepted") {
    throw new Error("只有已确认的匹配候选可以撤销确认。");
  }
  const confirmedTimeMapId = candidate.confirmedTimeMapId;
  const confirmedMap = confirmedTimeMapId
    ? project.mediaTimeMaps.find((map) => map.id === confirmedTimeMapId)
    : undefined;
  if (
    !confirmedTimeMapId ||
    confirmedMap?.state !== "confirmed" ||
    !doesTimeMapMatchCandidate(confirmedMap, candidate)
  ) {
    throw new Error("候选的确认时间图引用未知或不一致，已安全阻断撤销。");
  }
  if (
    project.mediaMatchCandidates.some(
      (other) =>
        other.id !== candidate.id &&
        other.state === "accepted" &&
        other.confirmedTimeMapId === confirmedTimeMapId
    )
  ) {
    throw new Error("确认时间图被多个候选共同引用，已安全阻断撤销。");
  }

  const segmentsById = new Map(
    project.danmakuSourceSegments.map((segment) => [segment.id, segment])
  );
  const hasUnknownAppliedReference = candidate.appliedSegmentIds.some((segmentId) => {
    const segment = segmentsById.get(segmentId);
    return segment?.kind !== "content" || segment.timeMapId !== confirmedTimeMapId;
  });
  if (hasUnknownAppliedReference) {
    throw new Error("候选的已应用片段引用未知或不属于其确认时间图，已安全阻断撤销。");
  }

  // appliedSegmentIds 可能来自旧项目或异常中断而不完整；确认图才是归属的最终依据。
  // 清理该图下的全部段，避免遗漏仍可进入导出链路的孤儿段。
  return reconcileMediaMatchCandidates(
    {
      ...project,
      danmakuSourceSegments: project.danmakuSourceSegments.filter(
        (segment) => segment.timeMapId !== confirmedTimeMapId
      )
    },
    timestamp
  );
}

/**
 * 接受媒体级候选，并仅为用户选中的、确实绑定到该参考素材的 XML 创建来源段。
 * 确定性 segment ID 让重复接受保持幂等；本函数不会写入全局 anchors/cutMarkers。
 */
export function acceptMediaMatchCandidate(
  project: EditorProject,
  candidateId: string,
  assetIds: readonly string[],
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state === "rejected") {
    throw new Error("已拒绝的匹配候选不能直接接受。");
  }
  const { target } = requireMediaPair(
    project.mediaLibrary,
    candidate.sourceMediaId,
    candidate.targetMediaId
  );
  validateCandidateRange(candidate, project.mediaLibrary);
  const selectedAssetIds = [
    ...new Set(assetIds.map((assetId) => assetId.trim()).filter(Boolean))
  ];
  if (selectedAssetIds.length === 0) {
    throw new Error("请至少选择一个绑定到该参考素材的 XML。");
  }
  const selectedAssets = selectedAssetIds.map((assetId) => {
    const asset = project.assets.find((candidateAsset) => candidateAsset.id === assetId);
    if (!asset) {
      throw new Error(`XML 资源不存在：${assetId}`);
    }
    const binding = project.danmakuSourceBindings.find((item) => item.assetId === assetId);
    if (!binding) {
      throw new Error(`${asset.fileName} 尚未绑定 B 站参考素材。`);
    }
    if (binding.sourceMediaId !== candidate.sourceMediaId) {
      throw new Error(`${asset.fileName} 绑定的参考素材与当前匹配候选不一致。`);
    }
    return asset;
  });

  const candidateMap = requireOrCreateCandidateTimeMap(project, candidate, timestamp);
  if (candidateMap.quality.level === "blocked") {
    throw new Error(`候选时间图已阻断：${candidateMap.quality.reasons.join("；")}`);
  }
  const existingConfirmedMap = candidate.confirmedTimeMapId
    ? project.mediaTimeMaps.find((map) => map.id === candidate.confirmedTimeMapId)
    : undefined;
  if (candidate.state === "accepted" && existingConfirmedMap?.state !== "confirmed") {
    throw new Error("已接受候选引用的确认时间图不存在或状态无效。");
  }
  const confirmedRevision = nextConfirmedRevision(project, candidate.id);
  const confirmedMap =
    existingConfirmedMap?.state === "confirmed"
      ? existingConfirmedMap
      : confirmCandidateTimeMap(
          candidateMap,
          createConfirmedTimeMapId(candidate.id, confirmedRevision),
          confirmedRevision,
          timestamp
        );
  if (!areMediaTimeMapImmutableLineagesEquivalent(candidateMap, confirmedMap)) {
    throw new Error("确认时间图与候选时间图的映射语义不一致，已阻断关系写入。");
  }
  let mediaTimeMaps = upsertTimeMap(project.mediaTimeMaps, candidateMap);
  mediaTimeMaps = upsertTimeMap(mediaTimeMaps, confirmedMap);

  const segments = [...project.danmakuSourceSegments];
  const appliedSegmentIds = new Set(candidate.appliedSegmentIds);
  for (const asset of selectedAssets) {
    const segmentId = createAppliedSegmentId(candidate.id, asset.id);
    const existing = segments.find((segment) => segment.id === segmentId);
    if (existing) {
      if (!isSegmentForCandidate(existing, candidate, asset.id, confirmedMap.id)) {
        throw new Error(`来源段 ID 冲突：${segmentId}`);
      }
      appliedSegmentIds.add(segmentId);
      continue;
    }
    const overlappingSegment = segments.find(
      (segment) =>
        segment.assetId === asset.id &&
        segment.sourceMediaId === candidate.sourceMediaId &&
        segment.sourceStartMs < candidate.sourceEndMs &&
        candidate.sourceStartMs < segment.sourceEndMs &&
        (segment.kind === "ignored" || segment.targetMediaId === candidate.targetMediaId)
    );
    if (overlappingSegment) {
      throw new Error(
        `${asset.fileName} 已有与当前候选范围冲突的来源段“${overlappingSegment.label}”，不能重复确认。`
      );
    }
    segments.push(
      createDanmakuSourceSegment(
        segmentId,
        {
          label: createAppliedSegmentLabel(target, asset.fileName),
          kind: "content",
          assetId: asset.id,
          sourceMediaId: candidate.sourceMediaId,
          sourceStartMs: candidate.sourceStartMs,
          sourceEndMs: candidate.sourceEndMs,
          targetMediaId: candidate.targetMediaId,
          targetStartMs: candidate.targetStartMs,
          timingRules: candidate.timingRules,
          timeMapId: confirmedMap.id,
          episodeKey: target.episodeKey,
          episodeLabel: target.episodeLabel,
          note: `由媒体匹配候选 ${candidate.id} 确认`
        },
        timestamp
      )
    );
    appliedSegmentIds.add(segmentId);
  }

  const updatedCandidate: MediaMatchCandidate = {
    ...candidate,
    state: "accepted",
    confirmedTimeMapId: confirmedMap.id,
    appliedSegmentIds: [...appliedSegmentIds],
    updatedAt:
      candidate.state === "accepted" &&
      selectedAssets.every((asset) =>
        candidate.appliedSegmentIds.includes(createAppliedSegmentId(candidate.id, asset.id))
      )
        ? candidate.updatedAt
        : timestamp
  };
  const nextProject = replaceCandidate(project, updatedCandidate);
  if (
    segments.length === project.danmakuSourceSegments.length &&
    nextProject === project &&
    mediaTimeMaps === project.mediaTimeMaps
  ) {
    return project;
  }
  return {
    ...nextProject,
    danmakuSourceSegments: segments,
    mediaTimeMaps
  };
}

/**
 * 仅在候选能完整通过内置 V2.5 独立留出策略时，原子地完成“接受关系 + 自动验证”。
 * 任一门禁失败都返回原项目，避免留下已接受但仍需人工签发的半成品状态。
 */
export function automaticallyAcceptMediaMatchCandidate(
  project: EditorProject,
  candidateId: string,
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state !== "pending") {
    return project;
  }
  const assetIds = project.danmakuSourceBindings
    .filter((binding) => binding.sourceMediaId === candidate.sourceMediaId)
    .map((binding) => binding.assetId)
    .filter((assetId) => project.assets.some((asset) => asset.id === assetId));
  if (assetIds.length === 0) {
    return project;
  }

  let accepted: EditorProject;
  try {
    accepted = acceptMediaMatchCandidate(project, candidateId, assetIds, timestamp);
  } catch {
    return project;
  }
  const acceptedCandidate = requireCandidate(accepted, candidateId);
  const confirmedMap = acceptedCandidate.confirmedTimeMapId
    ? accepted.mediaTimeMaps.find((map) => map.id === acceptedCandidate.confirmedTimeMapId)
    : null;
  if (!confirmedMap) {
    return project;
  }
  const eligibility = assessTrustedAutomaticMediaTimeMapVerificationEligibility(confirmedMap);
  if (!eligibility.eligible) {
    return project;
  }
  try {
    const verifiedMap = applyTrustedAutomaticMediaTimeMapVerification(confirmedMap, timestamp);
    return {
      ...accepted,
      mediaTimeMaps: upsertTimeMap(accepted.mediaTimeMaps, verifiedMap)
    };
  } catch {
    return project;
  }
}

export function acceptMediaMatchCandidateWithManualTakeover(
  project: EditorProject,
  candidateId: string,
  assetIds: readonly string[],
  timestamp = new Date().toISOString()
): EditorProject {
  const candidate = requireCandidate(project, candidateId);
  if (candidate.state !== "blocked" && candidate.state !== "pending") {
    throw new Error("只有待复核或已阻断的候选可以建立人工接管方案。");
  }
  const candidateMap = requireOrCreateCandidateTimeMap(project, candidate, timestamp);
  const suggestedMap = applySystemSuggestedTimeMapReviews(candidateMap, timestamp);
  const takeoverMap = applyCandidateTimeMapManualTakeover(suggestedMap, timestamp);
  const proposalTimeMap = candidate.proposal.timeMap
    ? {
        ...candidate.proposal.timeMap,
        spans: structuredClone(takeoverMap.spans),
        quality: structuredClone(takeoverMap.quality),
        evidence: {
          ...candidate.proposal.timeMap.evidence,
          types: [...takeoverMap.evidence.types],
          audioAnchorCount: takeoverMap.evidence.audioAnchorCount,
          visualAnchorCount: takeoverMap.evidence.visualAnchorCount,
          heldOutAnchorCount: takeoverMap.evidence.heldOutAnchorCount,
          notes: [...takeoverMap.evidence.notes]
        }
      }
    : undefined;
  const preparedProject: EditorProject = {
    ...project,
    mediaTimeMaps: project.mediaTimeMaps.map((map) =>
      map.id === takeoverMap.id ? takeoverMap : map
    ),
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            state: "pending",
            proposal: proposalTimeMap
              ? { ...item.proposal, timeMap: proposalTimeMap }
              : item.proposal,
            updatedAt: timestamp
          }
        : item
    )
  };
  return acceptMediaMatchCandidate(preparedProject, candidateId, assetIds, timestamp);
}

export function createAppliedSegmentId(candidateId: string, assetId: string): string {
  return `${candidateId}:segment:${assetId}`;
}

function getWholeRangeTranslation(
  previousStartMs: Milliseconds,
  previousEndMs: Milliseconds,
  nextStartMs: Milliseconds | undefined,
  nextEndMs: Milliseconds | undefined
): Milliseconds {
  if (nextStartMs === undefined || nextEndMs === undefined) {
    return 0;
  }
  const startDeltaMs = nextStartMs - previousStartMs;
  return nextEndMs - previousEndMs === startDeltaMs ? startDeltaMs : 0;
}

function translateProposalCoordinates(
  proposal: AlignmentProposal,
  sourceDeltaMs: Milliseconds,
  targetDeltaMs: Milliseconds
): AlignmentProposal {
  if (sourceDeltaMs === 0 && targetDeltaMs === 0) {
    return proposal;
  }
  return {
    ...proposal,
    anchors: proposal.anchors.map((anchor) => ({
      ...anchor,
      sourceMs: anchor.sourceMs + sourceDeltaMs,
      targetMs: anchor.targetMs + targetDeltaMs
    })),
    cutCandidates: proposal.cutCandidates.map((cut) => ({
      ...cut,
      sourceAtMs: cut.sourceAtMs + sourceDeltaMs,
      sourceRangeStartMs:
        cut.sourceRangeStartMs === undefined
          ? undefined
          : cut.sourceRangeStartMs + sourceDeltaMs,
      sourceRangeEndMs:
        cut.sourceRangeEndMs === undefined ? undefined : cut.sourceRangeEndMs + sourceDeltaMs
    })),
    evidenceProfile: proposal.evidenceProfile
      ? {
          ...proposal.evidenceProfile,
          samples: proposal.evidenceProfile.samples.map((sample) => ({
            ...sample,
            startMs:
              sample.startMs + (sample.axis === "source" ? sourceDeltaMs : targetDeltaMs),
            endMs:
              sample.endMs + (sample.axis === "source" ? sourceDeltaMs : targetDeltaMs),
            counterpartMs:
              sample.counterpartMs === null
                ? null
                : sample.counterpartMs +
                  (sample.axis === "source" ? targetDeltaMs : sourceDeltaMs),
            offsetMs:
              sample.offsetMs === null
                ? null
                : sample.offsetMs + targetDeltaMs - sourceDeltaMs
          }))
        }
      : undefined,
    timeMap: proposal.timeMap
      ? translateTimeMapProposal(proposal.timeMap, sourceDeltaMs, targetDeltaMs)
      : undefined
  };
}

function clipProposalToRange(
  proposal: AlignmentProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): AlignmentProposal {
  const anchors = proposal.anchors.filter(
    (anchor) =>
      anchor.sourceMs >= range.sourceStartMs &&
      anchor.sourceMs < range.sourceEndMs &&
      anchor.targetMs >= range.targetStartMs &&
      anchor.targetMs < range.targetEndMs
  );
  const cutCandidates = proposal.cutCandidates
    .filter(
      (cut) => cut.sourceAtMs >= range.sourceStartMs && cut.sourceAtMs < range.sourceEndMs
    )
    .map((cut) => ({
      ...cut,
      sourceRangeStartMs:
        cut.sourceRangeStartMs === undefined
          ? undefined
          : Math.min(cut.sourceAtMs, Math.max(range.sourceStartMs, cut.sourceRangeStartMs)),
      sourceRangeEndMs:
        cut.sourceRangeEndMs === undefined
          ? undefined
          : Math.max(cut.sourceAtMs, Math.min(range.sourceEndMs, cut.sourceRangeEndMs))
    }));
  const removedCount =
    proposal.anchors.length -
    anchors.length +
    proposal.cutCandidates.length -
    cutCandidates.length;
  const timeMap = proposal.timeMap
    ? doesProposalTimeMapMatchRange(proposal.timeMap, range)
      ? proposal.timeMap
      : blockTimeMapAfterManualRangeChange(proposal.timeMap, range)
    : undefined;
  const evidenceProfile = proposal.evidenceProfile
    ? {
        ...proposal.evidenceProfile,
        samples: proposal.evidenceProfile.samples
          .filter((sample) => {
            const startMs =
              sample.axis === "source" ? range.sourceStartMs : range.targetStartMs;
            const endMs =
              sample.axis === "source" ? range.sourceEndMs : range.targetEndMs;
            return sample.endMs > startMs && sample.startMs < endMs;
          })
          .map((sample) => {
            const startMs =
              sample.axis === "source" ? range.sourceStartMs : range.targetStartMs;
            const endMs =
              sample.axis === "source" ? range.sourceEndMs : range.targetEndMs;
            return {
              ...sample,
              startMs: Math.max(startMs, sample.startMs),
              endMs: Math.min(endMs, sample.endMs)
            };
          })
      }
    : undefined;
  return {
    ...proposal,
    anchors,
    cutCandidates,
    evidenceProfile,
    timeMap,
    diagnostics:
      removedCount > 0
        ? [...proposal.diagnostics, `人工调整范围后排除了 ${removedCount} 条范围外匹配证据。`]
        : proposal.diagnostics
  };
}

function translateTimeMapProposal(
  timeMap: AlignmentTimeMapProposal,
  sourceDeltaMs: Milliseconds,
  targetDeltaMs: Milliseconds
): AlignmentTimeMapProposal {
  return {
    ...timeMap,
    sourceStartMs: timeMap.sourceStartMs + sourceDeltaMs,
    sourceEndMs: timeMap.sourceEndMs + sourceDeltaMs,
    targetStartMs: timeMap.targetStartMs + targetDeltaMs,
    targetEndMs: timeMap.targetEndMs + targetDeltaMs,
    spans: timeMap.spans.map((span) => ({
      ...span,
      sourceStartMs: span.sourceStartMs + sourceDeltaMs,
      sourceEndMs: span.sourceEndMs + sourceDeltaMs,
      targetStartMs: span.targetStartMs + targetDeltaMs,
      targetEndMs: span.targetEndMs + targetDeltaMs,
      boundaries: span.boundaries
        ? {
            start: translateTimeMapBoundary(
              span.boundaries.start,
              sourceDeltaMs,
              targetDeltaMs
            ),
            end: translateTimeMapBoundary(span.boundaries.end, sourceDeltaMs, targetDeltaMs)
          }
        : undefined,
      alternatives: span.alternatives?.map((alternative) => ({
        ...alternative,
        sourceStartMs: alternative.sourceStartMs + sourceDeltaMs,
        sourceEndMs: alternative.sourceEndMs + sourceDeltaMs,
        targetStartMs: alternative.targetStartMs + targetDeltaMs,
        targetEndMs: alternative.targetEndMs + targetDeltaMs
      }))
    })),
    parametersHash: `${timeMap.parametersHash}:translated:${sourceDeltaMs}:${targetDeltaMs}`
  };
}

function translateTimeMapBoundary(
  boundary: TimeMapBoundaryEvidence,
  sourceDeltaMs: Milliseconds,
  targetDeltaMs: Milliseconds
): TimeMapBoundaryEvidence {
  const coordinateDeltaMs =
    boundary.axis === "source"
      ? sourceDeltaMs
      : boundary.axis === "target"
        ? targetDeltaMs
        : boundary.axis === "both" && sourceDeltaMs === targetDeltaMs
          ? sourceDeltaMs
          : null;
  const hasCoordinate =
    boundary.coarseMs !== null ||
    boundary.refinedMs !== null ||
    boundary.uncertaintyStartMs !== null ||
    boundary.uncertaintyEndMs !== null;
  if (coordinateDeltaMs === null && hasCoordinate) {
    return {
      ...boundary,
      status: "unsupported",
      coarseMs: null,
      refinedMs: null,
      uncertaintyStartMs: null,
      uncertaintyEndMs: null,
      correlation: null,
      alternativeMargin: null,
      reason: `${boundary.reason} 独立平移两条时间轴后，both 轴单坐标证据已失效。`
    };
  }
  if (coordinateDeltaMs === null) {
    return boundary;
  }
  return {
    ...boundary,
    coarseMs: translateOptionalTime(boundary.coarseMs, coordinateDeltaMs),
    refinedMs: translateOptionalTime(boundary.refinedMs, coordinateDeltaMs),
    uncertaintyStartMs: translateOptionalTime(boundary.uncertaintyStartMs, coordinateDeltaMs),
    uncertaintyEndMs: translateOptionalTime(boundary.uncertaintyEndMs, coordinateDeltaMs)
  };
}

function translateOptionalTime(
  value: Milliseconds | null,
  deltaMs: Milliseconds
): Milliseconds | null {
  return value === null ? null : value + deltaMs;
}

function doesProposalTimeMapMatchRange(
  timeMap: AlignmentTimeMapProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): boolean {
  return (
    timeMap.sourceStartMs === range.sourceStartMs &&
    timeMap.sourceEndMs === range.sourceEndMs &&
    timeMap.targetStartMs === range.targetStartMs &&
    timeMap.targetEndMs === range.targetEndMs
  );
}

function blockTimeMapAfterManualRangeChange(
  timeMap: AlignmentTimeMapProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): AlignmentTimeMapProposal {
  const reason = "人工只调整了候选边界，原有分段时间图已失效；请重新分析或重新标注映射。";
  return {
    ...timeMap,
    sourceStartMs: range.sourceStartMs,
    sourceEndMs: range.sourceEndMs,
    targetStartMs: range.targetStartMs,
    targetEndMs: range.targetEndMs,
    spans: [
      invalidateTimeMapSpanEvidenceForManualReview(
        normalizeLegacyUnverifiedTimeMapSpanEvidence({
          kind: "ambiguous",
          sourceStartMs: range.sourceStartMs,
          sourceEndMs: range.sourceEndMs,
          targetStartMs: range.targetStartMs,
          targetEndMs: range.targetEndMs
        }, {
          id: `manual-range-blocked-${range.sourceStartMs}-${range.targetStartMs}`,
          blocked: true,
          reason
        }),
        true,
        reason
      )
    ],
    quality: {
      ...timeMap.quality,
      level: "blocked",
      reasons: [...timeMap.quality.reasons, reason]
    },
    evidence: {
      ...timeMap.evidence,
      notes: [...timeMap.evidence.notes, reason]
    },
    parametersHash: `${timeMap.parametersHash}:manual-range-blocked`
  };
}

function namespaceProposal(
  proposal: AlignmentProposal,
  candidateId: string
): AlignmentProposal {
  const cloned = structuredClone(proposal);
  return {
    ...cloned,
    timeMap: cloned.timeMap
      ? reconcileAlignmentTimeMapProposalQuality(cloned.timeMap)
      : undefined,
    anchors: cloned.anchors.map((anchor, index) => ({
      ...anchor,
      id: createNamespacedId(candidateId, "anchor", anchor.id, index)
    })),
    cutCandidates: cloned.cutCandidates.map((cut, index) => ({
      ...cut,
      id: createNamespacedId(candidateId, "cut", cut.id, index)
    }))
  };
}

function createTimingRules(
  cuts: readonly CutCandidate[],
  candidateId: string,
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds
): SegmentTimingRule[] {
  const rules = cuts.map((cut, index) => ({
    id: createNamespacedId(candidateId, "rule", cut.id, index),
    sourceAtMs: cut.sourceAtMs,
    gapMs: cut.targetGapMs,
    note: cut.note
  }));
  validateTimingRulesInRange(rules, sourceStartMs, sourceEndMs);
  return rules.sort(
    (left, right) => left.sourceAtMs - right.sourceAtMs || left.id.localeCompare(right.id)
  );
}

function createNamespacedId(
  candidateId: string,
  kind: string,
  originalId: string,
  index: number
): string {
  return `${candidateId}:${kind}:${index}:${originalId}`;
}

function validateCandidateRange(
  candidate: MediaMatchCandidate,
  mediaLibrary: readonly ProjectMediaReference[]
): void {
  const { source, target } = requireMediaPair(
    mediaLibrary,
    candidate.sourceMediaId,
    candidate.targetMediaId
  );
  validateMediaMatchRange(candidate, source, target);
  validateTimingRulesInRange(
    candidate.timingRules,
    candidate.sourceStartMs,
    candidate.sourceEndMs
  );
}

function validateProposalTimeMapInRange(
  proposal: AlignmentProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): void {
  if (proposal.timeMap === undefined) {
    return;
  }
  if (!isAlignmentTimeMapProposal(proposal.timeMap)) {
    throw new Error("Alignment V2 时间图结构无效。");
  }
  if (!doesProposalTimeMapMatchRange(proposal.timeMap, range)) {
    throw new Error("Alignment V2 时间图范围与 matchRange 不一致。");
  }
}

function validateMediaMatchRange(
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
    coverage?: number;
  },
  source: ProjectMediaReference,
  target: ProjectMediaReference
): void {
  validateHalfOpenRange(range.sourceStartMs, range.sourceEndMs, "参考素材匹配区间");
  validateHalfOpenRange(range.targetStartMs, range.targetEndMs, "目标原片匹配区间");
  if (
    range.coverage !== undefined &&
    (!Number.isFinite(range.coverage) || range.coverage < 0 || range.coverage > 1)
  ) {
    throw new Error("匹配覆盖率必须位于 0 到 1 之间。");
  }
  if (source.durationMs !== null && range.sourceEndMs > source.durationMs) {
    throw new Error("参考素材匹配区间超出素材已知时长。");
  }
  if (target.durationMs !== null && range.targetEndMs > target.durationMs) {
    throw new Error("目标原片匹配区间超出素材已知时长。");
  }
}

function validateHalfOpenRange(
  startMs: Milliseconds,
  endMs: Milliseconds,
  label: string
): void {
  if (
    !Number.isSafeInteger(startMs) ||
    startMs < 0 ||
    !Number.isSafeInteger(endMs) ||
    endMs <= startMs
  ) {
    throw new Error(`${label}无效，必须是开始早于结束的非负整数毫秒半开区间。`);
  }
}

function validateTimingRulesInRange(
  rules: readonly SegmentTimingRule[],
  sourceStartMs: Milliseconds,
  sourceEndMs: Milliseconds
): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.id.trim().length === 0 || ids.has(rule.id)) {
      throw new Error("段内删减修正规则 ID 为空或重复。");
    }
    ids.add(rule.id);
    if (
      !Number.isSafeInteger(rule.sourceAtMs) ||
      rule.sourceAtMs < sourceStartMs ||
      rule.sourceAtMs >= sourceEndMs
    ) {
      throw new Error("段内删减修正点必须位于参考素材匹配区间内。");
    }
    if (!Number.isSafeInteger(rule.gapMs)) {
      throw new Error("段内删减修正时长必须是整数毫秒。");
    }
  }
}

function validateProposalItemsInRange(
  proposal: AlignmentProposal,
  range: {
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
    targetStartMs: Milliseconds;
    targetEndMs: Milliseconds;
  }
): void {
  for (const anchor of proposal.anchors) {
    if (
      !Number.isSafeInteger(anchor.sourceMs) ||
      anchor.sourceMs < range.sourceStartMs ||
      anchor.sourceMs >= range.sourceEndMs ||
      !Number.isSafeInteger(anchor.targetMs) ||
      anchor.targetMs < range.targetStartMs ||
      anchor.targetMs >= range.targetEndMs
    ) {
      throw new Error("对齐提案中的同步锚点超出 matchRange。");
    }
  }
  for (const cut of proposal.cutCandidates) {
    if (
      !Number.isSafeInteger(cut.sourceAtMs) ||
      cut.sourceAtMs < range.sourceStartMs ||
      cut.sourceAtMs >= range.sourceEndMs
    ) {
      throw new Error("对齐提案中的版本差异候选超出 matchRange。");
    }
    if (
      cut.sourceRangeStartMs !== undefined &&
      (!Number.isSafeInteger(cut.sourceRangeStartMs) ||
        cut.sourceRangeStartMs < range.sourceStartMs)
    ) {
      throw new Error("版本差异候选的不确定区间超出 matchRange。");
    }
    if (
      cut.sourceRangeEndMs !== undefined &&
      (!Number.isSafeInteger(cut.sourceRangeEndMs) || cut.sourceRangeEndMs > range.sourceEndMs)
    ) {
      throw new Error("版本差异候选的不确定区间超出 matchRange。");
    }
    if (
      cut.sourceRangeStartMs !== undefined &&
      cut.sourceRangeEndMs !== undefined &&
      cut.sourceRangeEndMs <= cut.sourceRangeStartMs
    ) {
      throw new Error("版本差异候选的不确定区间无效。");
    }
  }
}

function requireMediaPair(
  mediaLibrary: readonly ProjectMediaReference[],
  sourceMediaId: string,
  targetMediaId: string
): { source: ProjectMediaReference; target: ProjectMediaReference } {
  const source = mediaLibrary.find((media) => media.id === sourceMediaId);
  if (!source) {
    throw new Error("匹配候选引用的 B 站参考素材不存在。");
  }
  if (source.role !== "bilibiliReference") {
    throw new Error("匹配候选的来源必须是 B 站参考素材。");
  }
  const target = mediaLibrary.find((media) => media.id === targetMediaId);
  if (!target) {
    throw new Error("匹配候选引用的目标原片不存在。");
  }
  if (target.role !== "targetOriginal") {
    throw new Error("匹配候选的目标必须是原片素材。");
  }
  return { source, target };
}

function requireCandidate(project: EditorProject, candidateId: string): MediaMatchCandidate {
  const candidate = project.mediaMatchCandidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("媒体匹配候选不存在。");
  }
  return candidate;
}

function createCandidateTimeMap(
  candidate: MediaMatchCandidate,
  timestamp: string
): MediaTimeMap {
  const proposal = candidate.proposal.timeMap;
  if (proposal !== undefined) {
    if (!isAlignmentTimeMapProposal(proposal)) {
      throw new Error("候选携带的 Alignment V2 时间图结构无效。");
    }
    if (
      proposal.sourceStartMs !== candidate.sourceStartMs ||
      proposal.sourceEndMs !== candidate.sourceEndMs ||
      proposal.targetStartMs !== candidate.targetStartMs ||
      proposal.targetEndMs !== candidate.targetEndMs
    ) {
      throw new Error("候选时间图范围与 matchRange 不一致。");
    }
    const reconciledProposal = reconcileAlignmentTimeMapProposalQuality(proposal);
    return reconcileMediaTimeMapQuality({
      id: candidate.timeMapId,
      revision: 1,
      sourceMediaId: candidate.sourceMediaId,
      targetMediaId: candidate.targetMediaId,
      sourceStream: structuredClone(reconciledProposal.sourceStream),
      targetStream: structuredClone(reconciledProposal.targetStream),
      sourceIdentity: cloneMediaContentIdentity(reconciledProposal.sourceIdentity),
      targetIdentity: cloneMediaContentIdentity(reconciledProposal.targetIdentity),
      sourceStartMs: reconciledProposal.sourceStartMs,
      sourceEndMs: reconciledProposal.sourceEndMs,
      targetStartMs: reconciledProposal.targetStartMs,
      targetEndMs: reconciledProposal.targetEndMs,
      spans: structuredClone(reconciledProposal.spans),
      quality: structuredClone(reconciledProposal.quality),
      evidence: {
        types: [...reconciledProposal.evidence.types],
        audioAnchorCount: reconciledProposal.evidence.audioAnchorCount,
        visualAnchorCount: reconciledProposal.evidence.visualAnchorCount,
        heldOutAnchorCount: reconciledProposal.evidence.heldOutAnchorCount,
        top1Top2Margin: reconciledProposal.evidence.top1Top2Margin,
        uniqueContentCoverage: reconciledProposal.evidence.uniqueContentCoverage ?? null,
        repeatedContentOnly: reconciledProposal.evidence.repeatedContentOnly ?? false,
        selectedTrackReason: reconciledProposal.evidence.selectedTrackReason ?? "",
        alternativeTrackScores: structuredClone(
          reconciledProposal.evidence.alternativeTrackScores ?? []
        ),
        notes: [
          ...reconciledProposal.evidence.notes,
          ...(reconciledProposal.evidence.selectedTrackReason
            ? [reconciledProposal.evidence.selectedTrackReason]
            : [])
        ]
      },
      verification: null,
      engineVersion: reconciledProposal.engineVersion,
      featureVersion: reconciledProposal.featureVersion,
      parametersHash: reconciledProposal.parametersHash,
      state: "candidate",
      createdAt: timestamp,
      updatedAt: timestamp,
      confirmedAt: null
    });
  }
  return createLegacyMediaTimeMap({
    id: candidate.timeMapId,
    sourceMediaId: candidate.sourceMediaId,
    targetMediaId: candidate.targetMediaId,
    sourceStartMs: candidate.sourceStartMs,
    sourceEndMs: candidate.sourceEndMs,
    targetStartMs: candidate.targetStartMs,
    expectedTargetEndMs: candidate.targetEndMs,
    timingRules: candidate.timingRules,
    state: "candidate",
    timestamp,
    coverage: candidate.proposal.matchRange?.coverage ?? null,
    anchorCount: candidate.proposal.anchors.length
  });
}

function synchronizeMediaIdentitySnapshots(
  project: EditorProject,
  candidate: MediaMatchCandidate
): EditorProject {
  const proposal = candidate.proposal.timeMap;
  if (!proposal?.sourceIdentity && !proposal?.targetIdentity) {
    return project;
  }
  return {
    ...project,
    mediaLibrary: project.mediaLibrary.map((media) => {
      if (media.id === candidate.sourceMediaId && proposal.sourceIdentity) {
        return {
          ...media,
          contentIdentity: cloneMediaContentIdentity(proposal.sourceIdentity),
          updatedAt: candidate.updatedAt
        };
      }
      if (media.id === candidate.targetMediaId && proposal.targetIdentity) {
        return {
          ...media,
          contentIdentity: cloneMediaContentIdentity(proposal.targetIdentity),
          updatedAt: candidate.updatedAt
        };
      }
      return media;
    })
  };
}

function replaceCandidateAndCandidateMap(
  project: EditorProject,
  candidate: MediaMatchCandidate,
  timestamp: string,
  rebuild = true
): EditorProject {
  const existingMap = project.mediaTimeMaps.find((map) => map.id === candidate.timeMapId);
  let candidateMap: MediaTimeMap;
  if (!rebuild && existingMap) {
    if (existingMap.state !== "candidate" || !doesTimeMapMatchCandidate(existingMap, candidate)) {
      throw new Error("候选时间图与匹配范围不一致。");
    }
    candidateMap = existingMap;
  } else {
    const created = createCandidateTimeMap(candidate, timestamp);
    candidateMap = existingMap
      ? {
          ...created,
          revision: existingMap.revision + 1,
          createdAt: existingMap.createdAt
        }
      : created;
  }
  const nextProject = replaceCandidate(project, candidate);
  return {
    ...nextProject,
    mediaTimeMaps: upsertTimeMap(nextProject.mediaTimeMaps, candidateMap)
  };
}

function requireOrCreateCandidateTimeMap(
  project: EditorProject,
  candidate: MediaMatchCandidate,
  timestamp: string
): MediaTimeMap {
  const existing = project.mediaTimeMaps.find((map) => map.id === candidate.timeMapId);
  if (!existing) {
    return createCandidateTimeMap(candidate, timestamp);
  }
  if (
    existing.state !== "candidate" ||
    !doesTimeMapMatchCandidate(existing, candidate) ||
    !doesCandidateTimeMapMatchProposal(existing, candidate)
  ) {
    throw new Error("候选时间图不存在、状态无效，或与候选提案的映射语义不一致。");
  }
  return existing;
}

/**
 * V2/V3 候选的媒体、范围、spans 和引擎 provenance 必须仍与 proposal.timeMap
 * 属于同一不可变 lineage。质量、逐段证据和人工复核 notes 会在候选生命周期中合法演进，
 * 因而由各自校验器和签名摘要约束，不能继续要求与最初自动提案逐字相等。
 */
export function doesCandidateTimeMapMatchProposal(
  map: MediaTimeMap,
  candidate: MediaMatchCandidate
): boolean {
  if (!candidate.proposal.timeMap) {
    return true;
  }
  try {
    const expected = createCandidateTimeMap(candidate, candidate.createdAt);
    return areMediaTimeMapImmutableLineagesEquivalent(map, expected);
  } catch {
    return false;
  }
}

function doesTimeMapMatchCandidate(map: MediaTimeMap, candidate: MediaMatchCandidate): boolean {
  return (
    map.sourceMediaId === candidate.sourceMediaId &&
    map.targetMediaId === candidate.targetMediaId &&
    map.sourceStartMs === candidate.sourceStartMs &&
    map.sourceEndMs === candidate.sourceEndMs &&
    map.targetStartMs === candidate.targetStartMs &&
    map.targetEndMs === candidate.targetEndMs
  );
}

function nextConfirmedRevision(project: EditorProject, candidateId: string): number {
  const prefix = `${candidateId}:time-map:confirmed:`;
  return (
    project.mediaTimeMaps
      .filter((map) => map.id.startsWith(prefix))
      .reduce((maximum, map) => Math.max(maximum, map.revision), 0) + 1
  );
}

function upsertTimeMap(
  maps: MediaTimeMap[],
  timeMap: MediaTimeMap
): MediaTimeMap[] {
  const existingIndex = maps.findIndex((map) => map.id === timeMap.id);
  if (existingIndex < 0) {
    return [...maps, timeMap];
  }
  if (maps[existingIndex] === timeMap) {
    return maps;
  }
  return maps.map((map, index) => (index === existingIndex ? timeMap : map));
}

function replaceCandidate(
  project: EditorProject,
  candidate: MediaMatchCandidate
): EditorProject {
  const existing = project.mediaMatchCandidates.find((item) => item.id === candidate.id);
  if (existing === candidate) {
    return project;
  }
  return {
    ...project,
    mediaMatchCandidates: project.mediaMatchCandidates.map((item) =>
      item.id === candidate.id ? candidate : item
    )
  };
}

function isSegmentForCandidate(
  segment: EditorProject["danmakuSourceSegments"][number],
  candidate: MediaMatchCandidate,
  assetId: string,
  confirmedTimeMapId: string
): boolean {
  return (
    segment.kind === "content" &&
    segment.assetId === assetId &&
    segment.sourceMediaId === candidate.sourceMediaId &&
    segment.sourceStartMs === candidate.sourceStartMs &&
    segment.sourceEndMs === candidate.sourceEndMs &&
    segment.targetMediaId === candidate.targetMediaId &&
    (segment.targetStartMs ?? 0) === candidate.targetStartMs &&
    segment.timeMapId === confirmedTimeMapId &&
    areTimingRulesEqual(segment.timingRules, candidate.timingRules)
  );
}

function areTimingRulesEqual(
  left: readonly SegmentTimingRule[],
  right: readonly SegmentTimingRule[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (rule, index) =>
        rule.id === right[index]?.id &&
        rule.sourceAtMs === right[index]?.sourceAtMs &&
        rule.gapMs === right[index]?.gapMs &&
        rule.note === right[index]?.note
    )
  );
}

function createAppliedSegmentLabel(
  target: ProjectMediaReference,
  assetFileName: string
): string {
  const targetLabel = target.episodeLabel?.trim() || target.name.trim() || target.fileName;
  return `${targetLabel} · ${assetFileName}`;
}

function isProposalBlocked(proposal: AlignmentProposal): boolean {
  return proposal.timeMap?.quality.level === "blocked";
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  return normalized;
}
