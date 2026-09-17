import { formatTimecode } from "../shared/time";
import type { SyncAnchor } from "../danmaku/types";
import type { EditorProject } from "../project/types";
import {
  isAlignmentAnchorApplied,
  isAlignmentCutCandidateApplied
} from "./preview";
import type { AlignmentProposal, CutCandidate } from "./types";

export interface AlignmentApplyBlockerContext {
  existingAnchors?: SyncAnchor[];
  existingAnchorIds?: string[];
  existingCutMarkers?: EditorProject["cutMarkers"];
  existingCutMarkerIds?: string[];
}

export type AlignmentReviewItemKind = "anchor" | "cutCandidate";
export type AlignmentReviewItemState = "pending" | "applied" | "blocked";

export interface AlignmentReviewItemStatus {
  kind: AlignmentReviewItemKind;
  id: string;
  name: string;
  sourceAtMs: number;
  state: AlignmentReviewItemState;
  statusText: string;
  blockReasons: string[];
}

export interface AlignmentReviewStatusSummary {
  totalCount: number;
  pendingCount: number;
  appliedCount: number;
  blockedCount: number;
}

export type AlignmentReviewQueueSeverity = "blocked" | "attention" | "pending";

const NOISY_PROPOSAL_PENDING_LIMIT = 80;
const NOISY_PROPOSAL_CUT_LIMIT = 30;

export interface AlignmentReviewQueueItem {
  kind: AlignmentReviewItemKind;
  id: string;
  name: string;
  sourceAtMs: number;
  severity: AlignmentReviewQueueSeverity;
  severityText: string;
  statusText: string;
  reasons: string[];
}

export function createAlignmentReviewReport(
  proposal: AlignmentProposal,
  generatedAt: Date = new Date(),
  context: AlignmentApplyBlockerContext = {}
): string {
  const applyBlockers = createAlignmentApplyBlockers(proposal, context);
  const statusContext = createReviewStatusContext(proposal, context);
  const lines = [
    "# 对齐提案复核报告",
    "",
    `生成时间：${generatedAt.toISOString()}`,
    `整体置信度：${formatConfidence(proposal.confidence)}`,
    `同步锚点：${proposal.anchors.length} 个`,
    `候选版本差异：${proposal.cutCandidates.length} 个`,
    "",
    "## 应用阻断",
    ...createApplyBlockerLines(applyBlockers),
    "",
    "## 复核重点",
    ...createAlignmentReviewFocus(proposal).map((item) => `- ${item}`),
    "",
    "## 复核队列",
    ...createReviewQueueLines(createAlignmentReviewQueue(proposal, context)),
    "",
    "## 同步锚点",
    ...createAnchorLines(proposal, statusContext),
    "",
    "## 候选版本差异",
    ...createCutCandidateLines(proposal.cutCandidates, statusContext),
    "",
    "## 对齐证据",
    ...createEvidenceLines(proposal),
    "",
    "## 诊断信息",
    ...createDiagnosticLines(proposal.diagnostics)
  ];
  return `${lines.join("\n")}\n`;
}

export function createAlignmentReviewItemStatuses(
  proposal: AlignmentProposal,
  context: AlignmentApplyBlockerContext = {}
): AlignmentReviewItemStatus[] {
  const statusContext = createReviewStatusContext(proposal, context);
  return [
    ...proposal.anchors.map((anchor): AlignmentReviewItemStatus => {
      const status = createAnchorStatusResult(anchor, statusContext);
      return {
        kind: "anchor",
        id: anchor.id,
        name: anchor.id.trim().length > 0 ? anchor.id : "未命名锚点",
        sourceAtMs: anchor.sourceMs,
        state: status.state,
        statusText: status.text,
        blockReasons: status.blockReasons
      };
    }),
    ...proposal.cutCandidates.map((candidate): AlignmentReviewItemStatus => {
      const status = createCutCandidateStatusResult(candidate, statusContext);
      return {
        kind: "cutCandidate",
        id: candidate.id,
        name: candidate.name,
        sourceAtMs: candidate.sourceAtMs,
        state: status.state,
        statusText: status.text,
        blockReasons: status.blockReasons
      };
    })
  ];
}

export function createAlignmentReviewStatusSummary(
  statuses: AlignmentReviewItemStatus[]
): AlignmentReviewStatusSummary {
  return {
    totalCount: statuses.length,
    pendingCount: statuses.filter((item) => item.state === "pending").length,
    appliedCount: statuses.filter((item) => item.state === "applied").length,
    blockedCount: statuses.filter((item) => item.state === "blocked").length
  };
}

export function createAlignmentReviewQueue(
  proposal: AlignmentProposal,
  context: AlignmentApplyBlockerContext = {}
): AlignmentReviewQueueItem[] {
  const statuses = createAlignmentReviewItemStatuses(proposal, context);
  const anchorItems = proposal.anchors
    .map((anchor, index) => createAnchorReviewQueueItem(anchor, statuses[index]))
    .filter((item): item is AlignmentReviewQueueItem => item !== null);
  const cutItems = proposal.cutCandidates
    .map((candidate, index) =>
      createCutCandidateReviewQueueItem(candidate, statuses[proposal.anchors.length + index])
    )
    .filter((item): item is AlignmentReviewQueueItem => item !== null);
  return [...anchorItems, ...cutItems].sort(compareReviewQueueItems);
}

export function createAlignmentReviewFocus(proposal: AlignmentProposal): string[] {
  const focus: string[] = [];
  const lowConfidenceCuts = proposal.cutCandidates.filter((candidate) => candidate.confidence < 0.75);
  const rangedCuts = proposal.cutCandidates.filter(hasCompleteSourceRange);
  const invalidRangeCuts = rangedCuts.filter(
    (candidate) => candidate.sourceRangeStartMs > candidate.sourceRangeEndMs
  );
  const noiseWarning = createAlignmentNoiseWarning(proposal.anchors.length, proposal.cutCandidates.length);

  if (proposal.cutCandidates.length === 0 && proposal.anchors.length === 0) {
    focus.push("提案没有同步锚点或候选版本差异，需要重新生成或检查输入。");
  }
  if (noiseWarning) {
    focus.push(noiseWarning);
  }
  if (lowConfidenceCuts.length > 0) {
    focus.push(`${lowConfidenceCuts.length} 个候选版本差异置信度低于 75%，建议人工确认边界和相差时长。`);
  }
  if (rangedCuts.length > 0) {
    focus.push(`${rangedCuts.length} 个候选版本差异包含不确定区间，优先核对区间内的真实差异边界。`);
  }
  if (invalidRangeCuts.length > 0) {
    focus.push(`${invalidRangeCuts.length} 个候选版本差异的不确定区间起止顺序异常，需要修正后再应用。`);
  }
  if (proposal.diagnostics.length === 0) {
    focus.push("没有诊断信息，复核时需要更多上下文判断提案来源。");
  }
  if (focus.length === 0) {
    focus.push("未发现明显风险项，仍建议抽查首个锚点和每个候选版本差异的边界。");
  }
  return focus;
}

export function createAlignmentApplyBlockers(
  proposal: AlignmentProposal,
  context: AlignmentApplyBlockerContext = {}
): string[] {
  const blockers: string[] = [];
  const pendingAnchors = createPendingAnchorsForBlockers(proposal, context);
  const pendingCutCandidates = createPendingCutCandidatesForBlockers(proposal, context);
  const emptyAnchorIdCount = pendingAnchors.filter((anchor) => anchor.id.trim().length === 0).length;
  const emptyCutIdCount = pendingCutCandidates.filter((candidate) => candidate.id.trim().length === 0).length;
  const duplicateAnchorIds = findDuplicateIds(pendingAnchors.map((anchor) => anchor.id));
  const duplicateCutIds = findDuplicateIds(pendingCutCandidates.map((candidate) => candidate.id));
  const existingAnchorIdConflicts = findExistingIdConflicts(
    pendingAnchors.map((anchor) => anchor.id),
    readExistingAnchorIds(context)
  );
  const existingCutIdConflicts = findExistingIdConflicts(
    pendingCutCandidates.map((candidate) => candidate.id),
    readExistingCutMarkerIds(context)
  );
  const invalidRangeCount = pendingCutCandidates.filter(hasInvalidSourceRange).length;
  const sourceOutsideRangeCount = pendingCutCandidates.filter(isSourceOutsideRange).length;

  if (emptyAnchorIdCount > 0) {
    blockers.push(`${emptyAnchorIdCount} 个同步锚点缺少 ID，无法安全写入项目。`);
  }
  if (emptyCutIdCount > 0) {
    blockers.push(`${emptyCutIdCount} 个候选版本差异缺少 ID，无法安全写入项目。`);
  }
  if (duplicateAnchorIds.length > 0) {
    blockers.push(
      `${duplicateAnchorIds.length} 个同步锚点 ID 在提案内重复${formatIdEvidence(duplicateAnchorIds)}，应用会丢失锚点。`
    );
  }
  if (duplicateCutIds.length > 0) {
    blockers.push(
      `${duplicateCutIds.length} 个候选版本差异 ID 在提案内重复${formatIdEvidence(
        duplicateCutIds
      )}，应用会丢失版本差异。`
    );
  }
  if (existingAnchorIdConflicts.length > 0) {
    blockers.push(
      `${existingAnchorIdConflicts.length} 个同步锚点 ID 已存在于当前项目${formatIdEvidence(
        existingAnchorIdConflicts
      )}，应用会丢失新锚点。`
    );
  }
  if (existingCutIdConflicts.length > 0) {
    blockers.push(
      `${existingCutIdConflicts.length} 个候选版本差异 ID 已存在于当前项目${formatIdEvidence(
        existingCutIdConflicts
      )}，应用会丢失新的版本差异。`
    );
  }
  if (invalidRangeCount > 0) {
    blockers.push(`${invalidRangeCount} 个候选版本差异的不确定区间起止顺序异常，请修正后再应用。`);
  }
  if (sourceOutsideRangeCount > 0) {
    blockers.push(`${sourceOutsideRangeCount} 个候选版本差异的发生时间不在不确定区间内，请修正后再应用。`);
  }
  const noiseWarning = createAlignmentNoiseWarning(pendingAnchors.length, pendingCutCandidates.length);
  if (noiseWarning) {
    blockers.push(`${noiseWarning} 请先逐条接受可信候选，或提高窗口/匹配阈值后重新运行。`);
  }
  return blockers;
}

function createAlignmentNoiseWarning(anchorCount: number, cutCandidateCount: number): string | null {
  const totalCount = anchorCount + cutCandidateCount;
  if (cutCandidateCount > NOISY_PROPOSAL_CUT_LIMIT) {
    return `本次提案包含 ${cutCandidateCount} 个候选版本差异，疑似音频噪声过多。`;
  }
  if (totalCount > NOISY_PROPOSAL_PENDING_LIMIT) {
    return `本次提案包含 ${totalCount} 个待复核项，疑似音频噪声过多。`;
  }
  return null;
}

function createAnchorLines(proposal: AlignmentProposal, statusContext: AlignmentReviewStatusContext): string[] {
  if (proposal.anchors.length === 0) {
    return ["- 暂无同步锚点。"];
  }
  return proposal.anchors.map((anchor, index) => {
    const offsetMs = anchor.targetMs - anchor.sourceMs;
    const confidence = anchor.confidence === undefined ? "未提供" : formatConfidence(anchor.confidence);
    return [
      `- ${index + 1}. [${anchor.id}] ${anchor.origin === "automatic" ? "自动" : "手动"}`,
      `  落点状态：${createAnchorStatusResult(anchor, statusContext).text}`,
      `  当前视频时间：${formatTime(anchor.sourceMs)}`,
      `  完整版时间：${formatTime(anchor.targetMs)}`,
      `  偏移：${formatSignedDuration(offsetMs)} (${offsetMs} ms)`,
      `  置信度：${confidence}`
    ].join("\n");
  });
}

function createCutCandidateLines(
  candidates: CutCandidate[],
  statusContext: AlignmentReviewStatusContext
): string[] {
  if (candidates.length === 0) {
    return ["- 暂无候选版本差异。"];
  }
  return candidates.map((candidate, index) => {
    const sourceRangeLine = createSourceRangeLine(candidate);
    return [
      `- ${index + 1}. [${candidate.id}] ${candidate.name}`,
      `  落点状态：${createCutCandidateStatusResult(candidate, statusContext).text}`,
      `  发生位置：${formatTime(candidate.sourceAtMs)}`,
      `  ${sourceRangeLine}`,
      `  相差时长：${formatSignedDuration(candidate.targetGapMs)} (${Math.round(candidate.targetGapMs)} ms)`,
      `  置信度：${formatConfidence(candidate.confidence)}`,
      `  说明：${candidate.note || "未提供"}`
    ].join("\n");
  });
}

function createSourceRangeLine(candidate: CutCandidate): string {
  if (!hasCompleteSourceRange(candidate)) {
    return "不确定区间：未提供";
  }
  const label =
    candidate.sourceRangeStartMs <= candidate.sourceRangeEndMs
      ? "不确定区间"
      : "不确定区间（起止需复核）";
  return `${label}：${formatTime(candidate.sourceRangeStartMs)} - ${formatTime(candidate.sourceRangeEndMs)}`;
}

function createDiagnosticLines(diagnostics: string[]): string[] {
  if (diagnostics.length === 0) {
    return ["- 暂无诊断信息。"];
  }
  return diagnostics.map((diagnostic, index) => `- ${index + 1}. ${diagnostic}`);
}

function createEvidenceLines(proposal: AlignmentProposal): string[] {
  if (!proposal.evidence) {
    return ["- 暂无对齐证据。"];
  }
  const evidence = proposal.evidence;
  const lines = [
    `- 算法：${formatEvidenceAlgorithm(evidence.algorithm)}`,
    `- 质量：${formatEvidenceQuality(evidence.quality)}`,
    `- 指纹数量：完整版 ${evidence.completeFingerprintCount}，B 站删减版 ${evidence.sourceFingerprintCount}`,
    `- 稀疏匹配：${evidence.monotonicMatchCount} / ${evidence.fingerprintMatchCount}`,
    `- 强/弱锚点：${evidence.strongAnchorCount} / ${evidence.weakAnchorCount}`,
    `- offset 簇：${evidence.offsetClusterCount}`,
    `- 低置信区：${evidence.lowConfidenceRegionCount}`,
    `- 精修候选：${evidence.refinedCandidateCount}`
  ];
  if (evidence.timeMappingSegmentCount !== undefined) {
    lines.push(`- 时间映射段：${evidence.timeMappingSegmentCount}`);
  }
  if (evidence.confirmedChangeCount !== undefined) {
    lines.push(`- 持续变点：${evidence.confirmedChangeCount}`);
  }
  if (evidence.signals && evidence.signals.length > 0) {
    lines.push("- 证据信号：");
    lines.push(
      ...evidence.signals.map(
        (signal) =>
          `  - ${signal.label}：${formatEvidenceSignalStatus(signal.status)}，观测 ${signal.observations}，权重 ${Math.round(
            signal.weight * 100
          )}%`
      )
    );
  }
  return lines;
}

function formatEvidenceAlgorithm(algorithm: NonNullable<AlignmentProposal["evidence"]>["algorithm"]): string {
  if (algorithm === "time-map-audio") {
    return "音频时间映射";
  }
  if (algorithm === "offset-path") {
    return "offset 路径";
  }
  if (algorithm === "sparse-fingerprint") {
    return "稀疏指纹";
  }
  if (algorithm === "sparse-fingerprint-fallback") {
    return "稀疏指纹 + 密集 DP 回退";
  }
  return "密集 DP";
}

function formatEvidenceQuality(quality: NonNullable<AlignmentProposal["evidence"]>["quality"]): string {
  if (quality === "high") {
    return "高可信";
  }
  if (quality === "medium") {
    return "中等可信";
  }
  if (quality === "low") {
    return "低可信";
  }
  return "需重跑";
}

function formatEvidenceSignalStatus(
  status: NonNullable<NonNullable<AlignmentProposal["evidence"]>["signals"]>[number]["status"]
): string {
  if (status === "used") {
    return "已参与";
  }
  if (status === "blocked") {
    return "不可用";
  }
  return "未启用";
}

function createApplyBlockerLines(blockers: string[]): string[] {
  if (blockers.length === 0) {
    return ["- 暂无应用阻断。"];
  }
  return blockers.map((blocker, index) => `- ${index + 1}. ${blocker}`);
}

function createReviewQueueLines(queue: AlignmentReviewQueueItem[]): string[] {
  if (queue.length === 0) {
    return ["- 暂无待复核项。"];
  }
  return queue.map((item, index) =>
    [
      `- ${index + 1}. ${item.severityText} / ${formatQueueKind(item.kind)} / [${formatQueueId(item.id)}] ${item.name}`,
      `  时间：${formatTime(item.sourceAtMs)}`,
      `  状态：${item.statusText}`,
      `  建议：${item.reasons.join("；")}`
    ].join("\n")
  );
}

interface AlignmentReviewStatusContext {
  applyContext: AlignmentApplyBlockerContext;
  duplicateAnchorIds: Set<string>;
  duplicateCutIds: Set<string>;
}

interface AlignmentItemStatusResult {
  state: AlignmentReviewItemState;
  text: string;
  blockReasons: string[];
}

function createReviewStatusContext(
  proposal: AlignmentProposal,
  context: AlignmentApplyBlockerContext
): AlignmentReviewStatusContext {
  return {
    applyContext: context,
    duplicateAnchorIds: new Set(findDuplicateIds(proposal.anchors.map((anchor) => anchor.id))),
    duplicateCutIds: new Set(findDuplicateIds(proposal.cutCandidates.map((candidate) => candidate.id)))
  };
}

function createAnchorReviewQueueItem(
  anchor: SyncAnchor,
  status: AlignmentReviewItemStatus | undefined
): AlignmentReviewQueueItem | null {
  if (!status || status.state === "applied") {
    return null;
  }
  if (status.state === "blocked") {
    return {
      kind: "anchor",
      id: anchor.id,
      name: status.name,
      sourceAtMs: anchor.sourceMs,
      severity: "blocked",
      severityText: "先修阻断",
      statusText: status.statusText,
      reasons: status.blockReasons
    };
  }
  const attentionReasons = createAnchorAttentionReasons(anchor);
  return {
    kind: "anchor",
    id: anchor.id,
    name: status.name,
    sourceAtMs: anchor.sourceMs,
    severity: attentionReasons.length > 0 ? "attention" : "pending",
    severityText: attentionReasons.length > 0 ? "优先复核" : "待确认",
    statusText: status.statusText,
    reasons:
      attentionReasons.length > 0
        ? attentionReasons
        : ["应用前抽查当前视频时间、完整版时间和偏移方向。"]
  };
}

function createCutCandidateReviewQueueItem(
  candidate: CutCandidate,
  status: AlignmentReviewItemStatus | undefined
): AlignmentReviewQueueItem | null {
  if (!status || status.state === "applied") {
    return null;
  }
  if (status.state === "blocked") {
    return {
      kind: "cutCandidate",
      id: candidate.id,
      name: status.name,
      sourceAtMs: candidate.sourceAtMs,
      severity: "blocked",
      severityText: "先修阻断",
      statusText: status.statusText,
      reasons: status.blockReasons
    };
  }
  const attentionReasons = createCutCandidateAttentionReasons(candidate);
  return {
    kind: "cutCandidate",
    id: candidate.id,
    name: status.name,
    sourceAtMs: candidate.sourceAtMs,
    severity: attentionReasons.length > 0 ? "attention" : "pending",
    severityText: attentionReasons.length > 0 ? "优先复核" : "待确认",
    statusText: status.statusText,
    reasons:
      attentionReasons.length > 0
        ? attentionReasons
        : ["应用前抽查差异边界、相差时长和下游整体平移影响。"]
  };
}

function createAnchorAttentionReasons(anchor: SyncAnchor): string[] {
  if (anchor.confidence !== undefined && anchor.confidence < 0.75) {
    return [`锚点置信度 ${formatConfidence(anchor.confidence)}，建议核对当前视频时间和完整版时间。`];
  }
  return [];
}

function createCutCandidateAttentionReasons(candidate: CutCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.confidence < 0.75) {
    reasons.push(`候选版本差异置信度 ${formatConfidence(candidate.confidence)}，建议核对边界和相差时长。`);
  }
  if (hasCompleteSourceRange(candidate)) {
    reasons.push(`${formatQueueSourceRange(candidate)} 内存在不确定边界，优先核对真实差异位置。`);
  }
  return reasons;
}

function createAnchorStatusResult(
  anchor: SyncAnchor,
  statusContext: AlignmentReviewStatusContext
): AlignmentItemStatusResult {
  const context = statusContext.applyContext;
  if (context.existingAnchors && isAlignmentAnchorApplied(context.existingAnchors, anchor)) {
    return {
      state: "applied",
      text: "已落点（当前项目已有等价锚点）",
      blockReasons: []
    };
  }
  const reasons: string[] = [];
  if (anchor.id.trim().length === 0) {
    reasons.push("缺少 ID");
  } else {
    if (hasExistingId(anchor.id, readExistingAnchorIds(context))) {
      reasons.push("当前项目已有同 ID 锚点");
    }
    if (hasDuplicateId(anchor.id, statusContext.duplicateAnchorIds)) {
      reasons.push("提案内 ID 重复");
    }
  }
  return createPendingStatusResult(reasons);
}

function createCutCandidateStatusResult(
  candidate: CutCandidate,
  statusContext: AlignmentReviewStatusContext
): AlignmentItemStatusResult {
  const context = statusContext.applyContext;
  if (context.existingCutMarkers && isAlignmentCutCandidateApplied(context.existingCutMarkers, candidate)) {
    return {
      state: "applied",
      text: "已落点（当前项目已有等价版本差异）",
      blockReasons: []
    };
  }
  const reasons: string[] = [];
  if (candidate.id.trim().length === 0) {
    reasons.push("缺少 ID");
  } else {
    if (hasExistingId(candidate.id, readExistingCutMarkerIds(context))) {
      reasons.push("当前项目已有同 ID 版本差异");
    }
    if (hasDuplicateId(candidate.id, statusContext.duplicateCutIds)) {
      reasons.push("提案内 ID 重复");
    }
  }
  if (hasInvalidSourceRange(candidate)) {
    reasons.push("不确定区间起止异常");
  }
  if (isSourceOutsideRange(candidate)) {
    reasons.push("发生时间不在不确定区间内");
  }
  return createPendingStatusResult(reasons);
}

function createPendingStatusResult(blockReasons: string[]): AlignmentItemStatusResult {
  if (blockReasons.length === 0) {
    return {
      state: "pending",
      text: "待应用",
      blockReasons: []
    };
  }
  return {
    state: "blocked",
    text: `阻断（${blockReasons.join("；")}）`,
    blockReasons
  };
}

function createPendingAnchorsForBlockers(
  proposal: AlignmentProposal,
  context: AlignmentApplyBlockerContext
): SyncAnchor[] {
  const existingAnchors = context.existingAnchors;
  if (!existingAnchors) {
    return proposal.anchors;
  }
  return proposal.anchors.filter((anchor) => !isAlignmentAnchorApplied(existingAnchors, anchor));
}

function createPendingCutCandidatesForBlockers(
  proposal: AlignmentProposal,
  context: AlignmentApplyBlockerContext
): CutCandidate[] {
  const existingCutMarkers = context.existingCutMarkers;
  if (!existingCutMarkers) {
    return proposal.cutCandidates;
  }
  return proposal.cutCandidates.filter(
    (candidate) => !isAlignmentCutCandidateApplied(existingCutMarkers, candidate)
  );
}

function readExistingAnchorIds(context: AlignmentApplyBlockerContext): string[] {
  return context.existingAnchorIds ?? context.existingAnchors?.map((anchor) => anchor.id) ?? [];
}

function readExistingCutMarkerIds(context: AlignmentApplyBlockerContext): string[] {
  return context.existingCutMarkerIds ?? context.existingCutMarkers?.map((marker) => marker.id) ?? [];
}

function hasCompleteSourceRange(
  candidate: CutCandidate
): candidate is CutCandidate & { sourceRangeStartMs: number; sourceRangeEndMs: number } {
  return candidate.sourceRangeStartMs !== undefined && candidate.sourceRangeEndMs !== undefined;
}

function hasExistingId(id: string, existingIds: string[]): boolean {
  const normalized = id.trim();
  return normalized.length > 0 && existingIds.some((existingId) => existingId.trim() === normalized);
}

function hasDuplicateId(id: string, duplicateIds: Set<string>): boolean {
  const normalized = id.trim();
  return normalized.length > 0 && duplicateIds.has(normalized);
}

function hasInvalidSourceRange(candidate: CutCandidate): boolean {
  return hasCompleteSourceRange(candidate) && candidate.sourceRangeStartMs > candidate.sourceRangeEndMs;
}

function isSourceOutsideRange(candidate: CutCandidate): boolean {
  return (
    hasCompleteSourceRange(candidate) &&
    candidate.sourceRangeStartMs <= candidate.sourceRangeEndMs &&
    (candidate.sourceAtMs < candidate.sourceRangeStartMs || candidate.sourceAtMs > candidate.sourceRangeEndMs)
  );
}

function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const rawId of ids) {
    const id = rawId.trim();
    if (id.length === 0) {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
  }
  return [...duplicates];
}

function findExistingIdConflicts(ids: string[], existingIds: string[]): string[] {
  const existing = new Set(existingIds.map((id) => id.trim()).filter((id) => id.length > 0));
  const conflicts = new Set<string>();
  for (const rawId of ids) {
    const id = rawId.trim();
    if (id.length > 0 && existing.has(id)) {
      conflicts.add(id);
    }
  }
  return [...conflicts];
}

function compareReviewQueueItems(left: AlignmentReviewQueueItem, right: AlignmentReviewQueueItem): number {
  return (
    reviewQueueSeverityRank(left.severity) - reviewQueueSeverityRank(right.severity) ||
    left.sourceAtMs - right.sourceAtMs ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id)
  );
}

function reviewQueueSeverityRank(severity: AlignmentReviewQueueSeverity): number {
  if (severity === "blocked") {
    return 0;
  }
  if (severity === "attention") {
    return 1;
  }
  return 2;
}

function formatQueueKind(kind: AlignmentReviewItemKind): string {
  return kind === "anchor" ? "锚点" : "版本差异";
}

function formatQueueId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : "未命名";
}

function formatQueueSourceRange(
  candidate: CutCandidate & { sourceRangeStartMs: number; sourceRangeEndMs: number }
): string {
  return `区间 ${formatTimecode(Math.round(candidate.sourceRangeStartMs))}-${formatTimecode(
    Math.round(candidate.sourceRangeEndMs)
  )}`;
}

function formatIdEvidence(ids: string[]): string {
  const previewLimit = 5;
  const preview = ids.slice(0, previewLimit).join("、");
  const omittedCount = ids.length - previewLimit;
  const omitted = omittedCount > 0 ? `，另有 ${omittedCount} 个` : "";
  return `（ID：${preview}${omitted}）`;
}

function formatConfidence(confidence: number): string {
  return `${(confidence * 100).toFixed(1)}%`;
}

function formatTime(milliseconds: number): string {
  const rounded = Math.round(milliseconds);
  return `${formatTimecode(rounded)} (${rounded} ms)`;
}

function formatSignedDuration(milliseconds: number): string {
  const rounded = Math.round(milliseconds);
  const sign = rounded >= 0 ? "+" : "-";
  return `${sign}${formatTimecode(Math.abs(rounded))}`;
}
