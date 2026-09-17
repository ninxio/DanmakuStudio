import type { AlignmentProposal } from "../alignment/types";
import type { DanmakuAsset, SyncAnchor } from "../danmaku/types";
import { clamp, formatTimecode, MINUTE_MS } from "../shared/time";
import { formatMediaBindingEpisode, formatMediaBindingTitle } from "./mediaBinding";
import type { EditorProject, MediaBinding } from "./types";

export type ProjectMatchConclusion = "likely" | "review" | "unlikely";
export type ProjectMatchCriterionState = "positive" | "neutral" | "warning" | "negative";
export type ProjectMatchCriterionId =
  | "target"
  | "titleEpisode"
  | "duration"
  | "density"
  | "anchors"
  | "audioVisual";

export interface ProjectMatchCriterion {
  id: ProjectMatchCriterionId;
  label: string;
  state: ProjectMatchCriterionState;
  score: number;
  weight: number;
  summary: string;
  detail: string;
  evidence: string[];
}

export interface ProjectMatchSourceSummary {
  assetCount: number;
  itemCount: number;
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  densityWindowCount: number;
}

export interface ProjectMatchAssessment {
  score: number;
  conclusion: ProjectMatchConclusion;
  conclusionLabel: string;
  headline: string;
  detail: string;
  source: ProjectMatchSourceSummary;
  targetTitle: string;
  criteria: ProjectMatchCriterion[];
  proposal: AlignmentProposal | null;
}

interface CriterionInput {
  source: ProjectMatchSourceSummary;
  sourceText: string;
  binding: MediaBinding | null;
  project: EditorProject;
}

export function createProjectMatchAssessment(project: EditorProject): ProjectMatchAssessment {
  const source = summarizeDanmakuSource(project.assets);
  const sourceText = createSourceText(project);
  const input: CriterionInput = {
    source,
    sourceText,
    binding: project.mediaBinding,
    project
  };
  const criteria = [
    createTargetCriterion(input),
    createTitleEpisodeCriterion(input),
    createDurationCriterion(input),
    createDensityCriterion(input),
    createAnchorCriterion(input),
    createAudioVisualCriterion(input)
  ];
  const score = calculateWeightedScore(criteria);
  const conclusion = createConclusion(criteria, score);
  const assessmentWithoutProposal = createAssessment({
    score,
    conclusion,
    source,
    binding: project.mediaBinding,
    criteria,
    proposal: null
  });
  return {
    ...assessmentWithoutProposal,
    proposal: createMatchAssessmentProposal(project, assessmentWithoutProposal)
  };
}

export function formatProjectMatchScore(score: number): string {
  return `${Math.round(clamp(score, 0, 1) * 100)}%`;
}

function createAssessment({
  score,
  conclusion,
  source,
  binding,
  criteria,
  proposal
}: {
  score: number;
  conclusion: ProjectMatchConclusion;
  source: ProjectMatchSourceSummary;
  binding: MediaBinding | null;
  criteria: ProjectMatchCriterion[];
  proposal: AlignmentProposal | null;
}): ProjectMatchAssessment {
  return {
    score,
    conclusion,
    conclusionLabel: conclusionLabel(conclusion),
    headline: conclusionHeadline(conclusion),
    detail: conclusionDetail(conclusion),
    source,
    targetTitle: binding ? formatMediaBindingTitle(binding) : "未绑定目标原片",
    criteria,
    proposal
  };
}

function summarizeDanmakuSource(assets: DanmakuAsset[]): ProjectMatchSourceSummary {
  const times = assets.flatMap((asset) => asset.items.map((item) => item.sourceTimeMs));
  if (times.length === 0) {
    return {
      assetCount: assets.length,
      itemCount: 0,
      sourceStartMs: null,
      sourceEndMs: null,
      densityWindowCount: 0
    };
  }
  const densityWindows = new Set(times.map((timeMs) => Math.floor(timeMs / MINUTE_MS)));
  return {
    assetCount: assets.length,
    itemCount: times.length,
    sourceStartMs: Math.min(...times),
    sourceEndMs: Math.max(...times),
    densityWindowCount: densityWindows.size
  };
}

function createSourceText(project: EditorProject): string {
  return normalizeText(
    [
      project.name,
      ...project.assets.map((asset) => `${asset.name} ${asset.fileName}`),
      ...project.mediaLibrary.map((media) => `${media.name} ${media.fileName}`),
      project.media?.name,
      project.media?.fileName
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ")
  );
}

function createTargetCriterion({ binding }: CriterionInput): ProjectMatchCriterion {
  if (!binding) {
    return createCriterion({
      id: "target",
      label: "目标原片",
      state: "negative",
      score: 0,
      weight: 20,
      summary: "还没有绑定目标原片",
      detail: "先绑定本地视频或 Emby 条目后，才能判断这份弹幕要对齐到哪里。",
      evidence: []
    });
  }
  return createCriterion({
    id: "target",
    label: "目标原片",
    state: "positive",
    score: 1,
    weight: 20,
    summary: `已绑定 ${binding.kind === "embyItem" ? "Emby 条目" : "本地文件"}`,
    detail: "评分会以这份目标原片作为最终观看版本。",
    evidence: [formatMediaBindingTitle(binding)]
  });
}

function createTitleEpisodeCriterion({ binding, sourceText }: CriterionInput): ProjectMatchCriterion {
  if (!binding) {
    return createCriterion({
      id: "titleEpisode",
      label: "片名与季集",
      state: "neutral",
      score: 0.45,
      weight: 20,
      summary: "缺少目标信息",
      detail: "绑定目标原片后才能比较片名、剧名和季集号。",
      evidence: []
    });
  }

  const targetTokens = createTargetTokens(binding);
  const matchedTokens = targetTokens.filter((token) => sourceText.includes(token));
  const episodeMatched = binding.kind === "embyItem" && matchesEpisodeNumber(sourceText, binding.episodeNumber);
  const score = calculateTitleScore(targetTokens, matchedTokens, episodeMatched);
  return createCriterion({
    id: "titleEpisode",
    label: "片名与季集",
    state: stateFromScore(score),
    score,
    weight: 20,
    summary:
      matchedTokens.length > 0 || episodeMatched
        ? "文件名里找到可对上的标题或集数"
        : "没有找到明确标题或集数对应",
    detail:
      matchedTokens.length > 0 || episodeMatched
        ? "这只能说明命名线索看起来一致，仍需要结合时长和对齐线索判断。"
        : "如果 XML 文件名较简略，可以继续用时长、密度和人工线索确认。",
    evidence: [
      ...matchedTokens.slice(0, 4),
      ...(episodeMatched && binding.kind === "embyItem" ? [`E${formatTwoDigits(binding.episodeNumber ?? 0)}`] : [])
    ]
  });
}

function createDurationCriterion({ binding, source }: CriterionInput): ProjectMatchCriterion {
  const targetRuntimeMs = binding?.runtimeMs ?? null;
  if (targetRuntimeMs === null || source.sourceEndMs === null) {
    return createCriterion({
      id: "duration",
      label: "时长差",
      state: "neutral",
      score: 0.5,
      weight: 20,
      summary: "缺少可比较时长",
      detail: "目标原片运行时长或 XML 时间范围不足，暂时不能用时长判断匹配度。",
      evidence: []
    });
  }
  const differenceMs = targetRuntimeMs - source.sourceEndMs;
  const ratio = Math.abs(differenceMs) / Math.max(targetRuntimeMs, MINUTE_MS);
  const score = calculateDurationScore(Math.abs(differenceMs), ratio);
  return createCriterion({
    id: "duration",
    label: "时长差",
    state: stateFromScore(score),
    score,
    weight: 20,
    summary: formatDurationSummary(differenceMs),
    detail:
      Math.abs(differenceMs) <= MINUTE_MS
        ? "总时长非常接近，说明这份弹幕与目标原片的整体长度一致。"
        : "总时长差只能提示风险，不能自动定位删减点，需要音频、视觉或人工锚点继续确认。",
    evidence: [`XML 最晚弹幕 ${formatTimecode(source.sourceEndMs)}`, `目标时长 ${formatTimecode(targetRuntimeMs)}`]
  });
}

function createDensityCriterion({ source }: CriterionInput): ProjectMatchCriterion {
  if (source.itemCount === 0) {
    return createCriterion({
      id: "density",
      label: "弹幕密度",
      state: "negative",
      score: 0,
      weight: 15,
      summary: "没有可评分弹幕",
      detail: "没有弹幕时间分布时，无法判断 XML 是否覆盖了这一集。",
      evidence: []
    });
  }
  const score = calculateDensityScore(source.itemCount, source.densityWindowCount);
  return createCriterion({
    id: "density",
    label: "弹幕密度",
    state: stateFromScore(score),
    score,
    weight: 15,
    summary: `${source.itemCount.toLocaleString("zh-CN")} 条弹幕，覆盖 ${source.densityWindowCount} 个分钟窗`,
    detail:
      score >= 0.75
        ? "弹幕数量和覆盖范围足够用于辅助判断。"
        : "弹幕样本偏少，评分会更依赖标题、时长和人工线索。",
    evidence: source.sourceEndMs === null ? [] : [`时间范围到 ${formatTimecode(source.sourceEndMs)}`]
  });
}

function createAnchorCriterion({ project }: CriterionInput): ProjectMatchCriterion {
  const proposal = project.alignmentProposal;
  const candidateCount = (proposal?.anchors.length ?? 0) + (proposal?.cutCandidates.length ?? 0);
  if (candidateCount > 0) {
    const score = clamp(proposal?.confidence ?? 0.65, 0, 1);
    return createCriterion({
      id: "anchors",
      label: "候选锚点",
      state: stateFromScore(score),
      score,
      weight: 15,
      summary: `已有 ${candidateCount} 个待复核对齐项`,
      detail: "评分会优先参考当前对齐提案里的同步线索和候选版本差异。",
      evidence: [`同步线索 ${proposal?.anchors.length ?? 0} 个`, `候选版本差异 ${proposal?.cutCandidates.length ?? 0} 个`]
    });
  }
  if (project.syncAnchors.length > 0) {
    return createCriterion({
      id: "anchors",
      label: "候选锚点",
      state: "positive",
      score: 0.75,
      weight: 15,
      summary: `项目已有 ${project.syncAnchors.length} 个同步锚点`,
      detail: "已应用的同步锚点可作为人工确认过的匹配证据。",
      evidence: project.syncAnchors.slice(0, 3).map((anchor) => `${formatTimecode(anchor.sourceMs)} -> ${formatTimecode(anchor.targetMs)}`)
    });
  }
  return createCriterion({
    id: "anchors",
    label: "候选锚点",
    state: "neutral",
    score: 0.5,
    weight: 15,
    summary: "还没有同步线索",
    detail: "可以继续使用锚点校准、本地音频对齐或人工复核生成线索。",
    evidence: []
  });
}

function createAudioVisualCriterion({ project }: CriterionInput): ProjectMatchCriterion {
  const proposal = project.alignmentProposal;
  const diagnostics = proposal?.diagnostics ?? [];
  const hasAudio = diagnostics.some((diagnostic) => /音频|audio|ffmpeg|特征|pcm/i.test(diagnostic));
  const hasVisual = diagnostics.some((diagnostic) => /视觉|画面|帧|hash|orb|image|frame/i.test(diagnostic));
  if (!proposal || (!hasAudio && !hasVisual)) {
    return createCriterion({
      id: "audioVisual",
      label: "音频/视觉线索",
      state: "neutral",
      score: 0.5,
      weight: 10,
      summary: "尚未运行音频或视觉线索",
      detail: "当前评分不会伪造媒体识别结果；运行本地音频对齐后，这里会读取提案诊断。",
      evidence: []
    });
  }
  const score = clamp(proposal.confidence, 0, 1);
  return createCriterion({
    id: "audioVisual",
    label: "音频/视觉线索",
    state: stateFromScore(score),
    score,
    weight: 10,
    summary: `${hasAudio ? "音频" : ""}${hasAudio && hasVisual ? " / " : ""}${hasVisual ? "视觉" : ""}线索已进入提案`,
    detail: "媒体线索来自当前对齐提案诊断，仍需要在应用前复核候选边界。",
    evidence: diagnostics.slice(0, 3)
  });
}

function createMatchAssessmentProposal(
  project: EditorProject,
  assessment: ProjectMatchAssessment
): AlignmentProposal | null {
  if (!project.mediaBinding || assessment.source.itemCount === 0) {
    return null;
  }
  const anchors = [...(project.alignmentProposal?.anchors ?? [])];
  const targetRuntimeMs = project.mediaBinding.runtimeMs;
  if (targetRuntimeMs !== null && assessment.source.sourceEndMs !== null) {
    anchors.push({
      id: createStableProposalId(project, targetRuntimeMs, assessment.source.sourceEndMs),
      sourceMs: assessment.source.sourceEndMs,
      targetMs: targetRuntimeMs,
      confidence: clamp(assessment.score, 0.35, 0.85),
      origin: "automatic"
    });
  }
  const proposal: AlignmentProposal = {
    anchors: uniqueAnchors(anchors),
    cutCandidates: project.alignmentProposal?.cutCandidates ?? [],
    confidence: clamp(assessment.score, 0, 1),
    diagnostics: [
      `匹配评分：${formatProjectMatchScore(assessment.score)}，结论：${assessment.conclusionLabel}。`,
      ...assessment.criteria.map((criterion) => `${criterion.label}：${criterion.summary}`),
      "总时长差不会自动生成版本差异；需要音频、视觉或人工复核定位后再应用会影响导出的规则。"
    ]
  };
  return proposal;
}

function createCriterion({
  id,
  label,
  state,
  score,
  weight,
  summary,
  detail,
  evidence
}: ProjectMatchCriterion): ProjectMatchCriterion {
  return {
    id,
    label,
    state,
    score: clamp(score, 0, 1),
    weight,
    summary,
    detail,
    evidence
  };
}

function calculateWeightedScore(criteria: ProjectMatchCriterion[]): number {
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }
  const weighted = criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0);
  return clamp(weighted / totalWeight, 0, 1);
}

function createConclusion(criteria: ProjectMatchCriterion[], score: number): ProjectMatchConclusion {
  const negativeCount = criteria.filter((criterion) => criterion.state === "negative").length;
  const hasTarget = criteria.find((criterion) => criterion.id === "target")?.state === "positive";
  const titleState = criteria.find((criterion) => criterion.id === "titleEpisode")?.state ?? "neutral";
  const durationState = criteria.find((criterion) => criterion.id === "duration")?.state ?? "neutral";
  if (!hasTarget) {
    return "review";
  }
  if (
    negativeCount >= 2 ||
    score < 0.45 ||
    (durationState === "negative" && (titleState === "warning" || titleState === "negative"))
  ) {
    return "unlikely";
  }
  if (score >= 0.75 && negativeCount === 0) {
    return "likely";
  }
  return "review";
}

function conclusionLabel(conclusion: ProjectMatchConclusion): string {
  if (conclusion === "likely") {
    return "很可能匹配";
  }
  if (conclusion === "unlikely") {
    return "看起来不是同一集";
  }
  return "需要确认";
}

function conclusionHeadline(conclusion: ProjectMatchConclusion): string {
  if (conclusion === "likely") {
    return "这份 XML 和目标原片看起来能对上。";
  }
  if (conclusion === "unlikely") {
    return "证据冲突较多，建议先换目标或换 XML。";
  }
  return "已有线索，但还需要人工确认。";
}

function conclusionDetail(conclusion: ProjectMatchConclusion): string {
  if (conclusion === "likely") {
    return "仍建议预览候选线索，确认关键位置后再导出。";
  }
  if (conclusion === "unlikely") {
    return "低置信结果不会自动改项目，只会作为复核诊断保留。";
  }
  return "系统会解释每项证据，并把低置信提案送入复核流程。";
}

function createTargetTokens(binding: MediaBinding): string[] {
  const rawTokens =
    binding.kind === "embyItem"
      ? [
          binding.itemName,
          binding.seriesName,
          formatMediaBindingEpisode(binding),
          binding.seasonNumber === null ? null : `s${formatTwoDigits(binding.seasonNumber)}`,
          binding.episodeNumber === null ? null : `e${formatTwoDigits(binding.episodeNumber)}`
        ]
      : [binding.displayName, binding.fileName];
  return Array.from(
    new Set(
      rawTokens
        .filter((token): token is string => typeof token === "string")
        .map(normalizeText)
        .filter((token) => token.length >= 2)
    )
  );
}

function calculateTitleScore(tokens: string[], matchedTokens: string[], episodeMatched: boolean): number {
  if (matchedTokens.length === 0 && !episodeMatched) {
    return tokens.length === 0 ? 0.5 : 0.35;
  }
  const ratio = tokens.length === 0 ? 0 : matchedTokens.length / tokens.length;
  return clamp(0.55 + ratio * 0.35 + (episodeMatched ? 0.15 : 0), 0, 1);
}

function matchesEpisodeNumber(sourceText: string, episodeNumber: number | null): boolean {
  if (episodeNumber === null) {
    return false;
  }
  const escaped = episodeNumber.toString();
  const padded = formatTwoDigits(episodeNumber);
  return new RegExp(`(^|[^0-9])(${escaped}|${padded})([^0-9]|$)`).test(sourceText);
}

function calculateDurationScore(absDifferenceMs: number, ratio: number): number {
  if (absDifferenceMs <= MINUTE_MS || ratio <= 0.02) {
    return 1;
  }
  if (absDifferenceMs <= 5 * MINUTE_MS || ratio <= 0.1) {
    return 0.72;
  }
  if (absDifferenceMs <= 15 * MINUTE_MS || ratio <= 0.25) {
    return 0.42;
  }
  return 0.12;
}

function calculateDensityScore(itemCount: number, windowCount: number): number {
  if (itemCount >= 200 && windowCount >= 20) {
    return 1;
  }
  if (itemCount >= 50 && windowCount >= 8) {
    return 0.72;
  }
  if (itemCount >= 10 && windowCount >= 3) {
    return 0.5;
  }
  return 0.3;
}

function stateFromScore(score: number): ProjectMatchCriterionState {
  if (score >= 0.75) {
    return "positive";
  }
  if (score >= 0.5) {
    return "neutral";
  }
  if (score >= 0.25) {
    return "warning";
  }
  return "negative";
}

function formatDurationSummary(differenceMs: number): string {
  if (Math.abs(differenceMs) <= MINUTE_MS) {
    return "XML 时间范围与目标时长接近";
  }
  const direction = differenceMs > 0 ? "目标原片更长" : "XML 时间范围更长";
  return `${direction} ${formatTimecode(Math.abs(differenceMs))}`;
}

function uniqueAnchors(anchors: SyncAnchor[]): SyncAnchor[] {
  const seen = new Set<string>();
  const result: SyncAnchor[] = [];
  for (const anchor of anchors) {
    const key = `${anchor.sourceMs}:${anchor.targetMs}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(anchor);
  }
  return result;
}

function createStableProposalId(project: EditorProject, targetRuntimeMs: number, sourceEndMs: number): string {
  return `match_anchor_${hashText(`${project.id}:${project.mediaBinding?.id ?? ""}:${sourceEndMs}:${targetRuntimeMs}`)}`;
}

function hashText(text: string): string {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/第\s*(\d+)\s*季/g, "s$1")
    .replace(/第\s*(\d+)\s*[集话]/g, "e$1")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTwoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}
