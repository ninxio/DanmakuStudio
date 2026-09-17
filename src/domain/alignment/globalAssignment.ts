export interface GlobalMatchHypothesis {
  id: string;
  /** Top-K hypotheses produced for one logical media pair are mutually exclusive. */
  alternativeGroupId?: string | null;
  sourceMediaId: string;
  targetMediaId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  score: number;
  uniqueCoverage: number;
  alternativeMargin: number;
  repeatedContentOnly?: boolean;
  blocked?: boolean;
  sourceOrderHint?: number | null;
  targetOrderHint?: number | null;
}

export interface GlobalAssignmentOptions {
  overlapToleranceMs?: number;
  orderInversionPenalty?: number;
  repeatedContentPenalty?: number;
  exactSearchLimit?: number;
  ambiguityMargin?: number;
}

export type GlobalAssignmentRejectionReason =
  | "blocked"
  | "samePairAlternative"
  | "sourceOverlap"
  | "targetOverlap"
  | "notInBestCombination";

export interface GlobalAssignmentRejection {
  id: string;
  reason: GlobalAssignmentRejectionReason;
  conflictsWith: string[];
}

export interface GlobalAssignmentResult {
  selectedIds: string[];
  runnerUpIds: string[] | null;
  rejected: GlobalAssignmentRejection[];
  score: number;
  runnerUpScore: number | null;
  normalizedMargin: number | null;
  ambiguous: boolean;
  exact: boolean;
}

interface NormalizedOptions {
  overlapToleranceMs: number;
  orderInversionPenalty: number;
  repeatedContentPenalty: number;
  exactSearchLimit: number;
  ambiguityMargin: number;
}

interface AssignmentSolution {
  ids: string[];
  score: number;
}

interface BeamState {
  selected: GlobalMatchHypothesis[];
  score: number;
}

const APPROXIMATE_BEAM_WIDTH = 256;

/**
 * 在 1×N、N×1、N×M 的 pairwise 候选上做项目级组合选择。
 * 同一来源或目标轴上的实质重叠是硬冲突；集序只作为软惩罚，不用文件名强行配对。
 */
export function assignGlobalMediaMatches(
  hypotheses: readonly GlobalMatchHypothesis[],
  options: GlobalAssignmentOptions = {}
): GlobalAssignmentResult {
  const normalizedOptions = normalizeOptions(options);
  const valid = hypotheses.map(validateAndNormalizeHypothesis);
  const normalizedIds = new Set(valid.map((hypothesis) => hypothesis.id));
  if (normalizedIds.size !== valid.length) {
    throw new Error("全局匹配候选 ID 在规范化后必须唯一。");
  }
  const selectable = valid.filter((hypothesis) => !hypothesis.blocked);
  const exact = selectable.length <= normalizedOptions.exactSearchLimit;
  const primarySolutions = exact
    ? searchExactAssignments(selectable, normalizedOptions)
    : searchGreedyAssignments(selectable, normalizedOptions);
  let best = primarySolutions[0] ?? { ids: [], score: 0 };
  let alternativeSolutions = exact
    ? searchExactAssignments(selectable, normalizedOptions, new Set(best.ids))
    : searchGreedyAssignments(selectable, normalizedOptions, new Set(best.ids));
  let runnerUp = alternativeSolutions[0] ?? null;
  // 近似搜索的“强制保留替代关系”分支偶尔会发现普通 beam 漏掉的更优解。
  // 此时把它提升为最佳解，再相对新最佳解重求一次真正的关系替代项。
  if (!exact && runnerUp && runnerUp.score > best.score) {
    best = runnerUp;
    alternativeSolutions = searchGreedyAssignments(
      selectable,
      normalizedOptions,
      new Set(best.ids)
    );
    runnerUp = alternativeSolutions[0] ?? null;
  }
  const selected = new Set(best.ids);
  const hasUnresolvedSelectableAlternative = selectable.some(
    (hypothesis) =>
      !selected.has(hypothesis.id) && hypothesisWeight(hypothesis, normalizedOptions) > 0
  );
  const normalizedMargin = runnerUp
    ? normalizeScoreMargin(best.score, runnerUp.score)
    : best.ids.length > 0 && exact
      ? 1
      : null;
  const rejected = valid
    .filter((hypothesis) => !selected.has(hypothesis.id))
    .map((hypothesis) => createRejection(hypothesis, valid, selected, normalizedOptions));

  return {
    selectedIds: [...best.ids].sort(),
    runnerUpIds: runnerUp ? [...runnerUp.ids].sort() : null,
    rejected,
    score: best.score,
    runnerUpScore: runnerUp?.score ?? null,
    normalizedMargin,
    ambiguous:
      (!exact && hasUnresolvedSelectableAlternative && runnerUp === null) ||
      (runnerUp !== null &&
        normalizedMargin !== null &&
        normalizedMargin < normalizedOptions.ambiguityMargin),
    exact
  };
}

function searchExactAssignments(
  hypotheses: readonly GlobalMatchHypothesis[],
  options: NormalizedOptions,
  alternativeTo?: ReadonlySet<string>
): AssignmentSolution[] {
  const sorted = [...hypotheses].sort(
    (left, right) => hypothesisWeight(right, options) - hypothesisWeight(left, options)
  );
  const positiveSuffix = new Array<number>(sorted.length + 1).fill(0);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    positiveSuffix[index] =
      positiveSuffix[index + 1] + Math.max(0, hypothesisWeight(sorted[index], options));
  }
  const solutions: AssignmentSolution[] = [];

  const visit = (index: number, selected: GlobalMatchHypothesis[], score: number) => {
    const secondBestScore = solutions[1]?.score ?? Number.NEGATIVE_INFINITY;
    if (score + positiveSuffix[index] < secondBestScore) {
      return;
    }
    if (index >= sorted.length) {
      if (!alternativeTo || selected.some((item) => !alternativeTo.has(item.id))) {
        recordSolution(solutions, selected, score);
      }
      return;
    }
    const hypothesis = sorted[index];
    const conflict = selected.some((item) => hardConflict(item, hypothesis, options));
    if (!conflict) {
      const pairPenalty = selected.reduce(
        (total, item) => total + orderPenalty(item, hypothesis, options),
        0
      );
      const incrementalScore = hypothesisWeight(hypothesis, options) - pairPenalty;
      if (incrementalScore > 0) {
        visit(index + 1, [...selected, hypothesis], score + incrementalScore);
      }
    }
    visit(index + 1, selected, score);
  };

  visit(0, [], 0);
  return solutions;
}

function searchGreedyAssignments(
  hypotheses: readonly GlobalMatchHypothesis[],
  options: NormalizedOptions,
  alternativeTo?: ReadonlySet<string>
): AssignmentSolution[] {
  const ordered = [...hypotheses].sort(
    (left, right) =>
      hypothesisWeight(right, options) - hypothesisWeight(left, options) ||
      right.uniqueCoverage - left.uniqueCoverage ||
      left.id.localeCompare(right.id)
  );
  let beam: BeamState[] = [{ selected: [], score: 0 }];

  for (const hypothesis of ordered) {
    const nextBySignature = new Map<string, BeamState>();
    for (const state of beam) {
      recordBeamState(nextBySignature, state);
      if (state.selected.some((item) => hardConflict(item, hypothesis, options))) {
        continue;
      }
      const penalty = state.selected.reduce(
        (total, item) => total + orderPenalty(item, hypothesis, options),
        0
      );
      const incrementalScore = hypothesisWeight(hypothesis, options) - penalty;
      if (incrementalScore <= 0) {
        continue;
      }
      recordBeamState(nextBySignature, {
        selected: [...state.selected, hypothesis],
        score: state.score + incrementalScore
      });
    }
    const ranked = [...nextBySignature.values()].sort(compareBeamStates);
    if (alternativeTo) {
      const perClassLimit = Math.max(1, Math.floor(APPROXIMATE_BEAM_WIDTH / 2));
      const baseline = ranked
        .filter((state) => !containsAlternativeRelation(state, alternativeTo))
        .slice(0, perClassLimit);
      const alternatives = ranked
        .filter((state) => containsAlternativeRelation(state, alternativeTo))
        .slice(0, perClassLimit);
      beam = [...baseline, ...alternatives].sort(compareBeamStates);
    } else {
      beam = ranked.slice(0, APPROXIMATE_BEAM_WIDTH);
    }
  }

  const solutions: AssignmentSolution[] = [];
  for (const state of beam) {
    if (alternativeTo && !containsAlternativeRelation(state, alternativeTo)) {
      continue;
    }
    recordSolution(solutions, state.selected, state.score);
  }
  return solutions;
}

function containsAlternativeRelation(
  state: BeamState,
  baselineIds: ReadonlySet<string>
): boolean {
  return state.selected.some((item) => !baselineIds.has(item.id));
}

function recordBeamState(states: Map<string, BeamState>, candidate: BeamState): void {
  const signature = candidate.selected
    .map((item) => item.id)
    .sort()
    .join("\u0000");
  const existing = states.get(signature);
  if (!existing || candidate.score > existing.score) {
    states.set(signature, candidate);
  }
}

function compareBeamStates(left: BeamState, right: BeamState): number {
  return (
    right.score - left.score ||
    left.selected
      .map((item) => item.id)
      .sort()
      .join("\u0000")
      .localeCompare(
        right.selected
          .map((item) => item.id)
          .sort()
          .join("\u0000")
      )
  );
}

function recordSolution(
  solutions: AssignmentSolution[],
  selected: readonly GlobalMatchHypothesis[],
  score: number
): void {
  const ids = selected.map((item) => item.id).sort();
  const signature = ids.join("\u0000");
  if (solutions.some((solution) => solution.ids.join("\u0000") === signature)) {
    return;
  }
  solutions.push({ ids, score });
  solutions.sort(
    (left, right) => right.score - left.score || left.ids.join("\u0000").localeCompare(right.ids.join("\u0000"))
  );
  solutions.splice(2);
}

function hypothesisWeight(
  hypothesis: GlobalMatchHypothesis,
  options: NormalizedOptions
): number {
  const uniquenessFactor = 0.35 + hypothesis.uniqueCoverage * 0.65;
  const alternativeBonus = hypothesis.alternativeMargin * 0.2;
  const repeatedPenalty = hypothesis.repeatedContentOnly ? options.repeatedContentPenalty : 0;
  return hypothesis.score * uniquenessFactor + alternativeBonus - repeatedPenalty;
}

function hardConflict(
  left: GlobalMatchHypothesis,
  right: GlobalMatchHypothesis,
  options: NormalizedOptions
): boolean {
  if (left.id === right.id) {
    return true;
  }
  if (
    left.alternativeGroupId !== null &&
    left.alternativeGroupId !== undefined &&
    left.alternativeGroupId === right.alternativeGroupId
  ) {
    return true;
  }
  const sourceConflict =
    left.sourceMediaId === right.sourceMediaId &&
    overlapDuration(
      left.sourceStartMs,
      left.sourceEndMs,
      right.sourceStartMs,
      right.sourceEndMs
    ) > options.overlapToleranceMs;
  const targetConflict =
    left.targetMediaId === right.targetMediaId &&
    overlapDuration(
      left.targetStartMs,
      left.targetEndMs,
      right.targetStartMs,
      right.targetEndMs
    ) > options.overlapToleranceMs;
  return sourceConflict || targetConflict;
}

function orderPenalty(
  left: GlobalMatchHypothesis,
  right: GlobalMatchHypothesis,
  options: NormalizedOptions
): number {
  if (
    left.sourceMediaId === right.sourceMediaId &&
    left.targetOrderHint !== null &&
    left.targetOrderHint !== undefined &&
    right.targetOrderHint !== null &&
    right.targetOrderHint !== undefined
  ) {
    const sourceOrder = Math.sign(left.sourceStartMs - right.sourceStartMs);
    const targetOrder = Math.sign(left.targetOrderHint - right.targetOrderHint);
    if (sourceOrder !== 0 && targetOrder !== 0 && sourceOrder !== targetOrder) {
      return options.orderInversionPenalty;
    }
  }
  if (
    left.targetMediaId === right.targetMediaId &&
    left.sourceOrderHint !== null &&
    left.sourceOrderHint !== undefined &&
    right.sourceOrderHint !== null &&
    right.sourceOrderHint !== undefined
  ) {
    const targetOrder = Math.sign(left.targetStartMs - right.targetStartMs);
    const sourceOrder = Math.sign(left.sourceOrderHint - right.sourceOrderHint);
    if (targetOrder !== 0 && sourceOrder !== 0 && targetOrder !== sourceOrder) {
      return options.orderInversionPenalty;
    }
  }
  return 0;
}

function createRejection(
  hypothesis: GlobalMatchHypothesis,
  all: readonly GlobalMatchHypothesis[],
  selected: ReadonlySet<string>,
  options: NormalizedOptions
): GlobalAssignmentRejection {
  if (hypothesis.blocked) {
    return { id: hypothesis.id, reason: "blocked", conflictsWith: [] };
  }
  const selectedHypotheses = all.filter((item) => selected.has(item.id));
  const samePairAlternatives = selectedHypotheses.filter(
    (item) =>
      hypothesis.alternativeGroupId !== null &&
      hypothesis.alternativeGroupId !== undefined &&
      item.alternativeGroupId === hypothesis.alternativeGroupId
  );
  if (samePairAlternatives.length > 0) {
    return {
      id: hypothesis.id,
      reason: "samePairAlternative",
      conflictsWith: samePairAlternatives.map((item) => item.id).sort()
    };
  }
  const sourceConflicts = selectedHypotheses.filter(
    (item) =>
      item.sourceMediaId === hypothesis.sourceMediaId &&
      overlapDuration(
        item.sourceStartMs,
        item.sourceEndMs,
        hypothesis.sourceStartMs,
        hypothesis.sourceEndMs
      ) > options.overlapToleranceMs
  );
  if (sourceConflicts.length > 0) {
    return {
      id: hypothesis.id,
      reason: "sourceOverlap",
      conflictsWith: sourceConflicts.map((item) => item.id).sort()
    };
  }
  const targetConflicts = selectedHypotheses.filter(
    (item) =>
      item.targetMediaId === hypothesis.targetMediaId &&
      overlapDuration(
        item.targetStartMs,
        item.targetEndMs,
        hypothesis.targetStartMs,
        hypothesis.targetEndMs
      ) > options.overlapToleranceMs
  );
  if (targetConflicts.length > 0) {
    return {
      id: hypothesis.id,
      reason: "targetOverlap",
      conflictsWith: targetConflicts.map((item) => item.id).sort()
    };
  }
  return { id: hypothesis.id, reason: "notInBestCombination", conflictsWith: [] };
}

function validateAndNormalizeHypothesis(
  hypothesis: GlobalMatchHypothesis
): GlobalMatchHypothesis {
  if (hypothesis.id.trim().length === 0) {
    throw new Error("全局匹配候选 ID 不能为空。");
  }
  validateRange(hypothesis.sourceStartMs, hypothesis.sourceEndMs, "来源区间");
  validateRange(hypothesis.targetStartMs, hypothesis.targetEndMs, "目标区间");
  validateUnitNumber(hypothesis.score, "候选分数");
  validateUnitNumber(hypothesis.uniqueCoverage, "独特内容覆盖率");
  validateUnitNumber(hypothesis.alternativeMargin, "备选差距");
  return {
    ...hypothesis,
    id: hypothesis.id.trim(),
    alternativeGroupId:
      hypothesis.alternativeGroupId === null || hypothesis.alternativeGroupId === undefined
        ? null
        : requireText(hypothesis.alternativeGroupId, "候选互斥组 ID"),
    sourceMediaId: requireText(hypothesis.sourceMediaId, "来源媒体 ID"),
    targetMediaId: requireText(hypothesis.targetMediaId, "目标媒体 ID")
  };
}

function normalizeOptions(options: GlobalAssignmentOptions): NormalizedOptions {
  const result = {
    overlapToleranceMs: options.overlapToleranceMs ?? 250,
    orderInversionPenalty: options.orderInversionPenalty ?? 0.08,
    repeatedContentPenalty: options.repeatedContentPenalty ?? 0.3,
    exactSearchLimit: options.exactSearchLimit ?? 18,
    ambiguityMargin: options.ambiguityMargin ?? 0.08
  };
  if (!Number.isSafeInteger(result.overlapToleranceMs) || result.overlapToleranceMs < 0) {
    throw new RangeError("全局分配重叠容差必须是非负整数毫秒。");
  }
  if (!Number.isSafeInteger(result.exactSearchLimit) || result.exactSearchLimit < 1) {
    throw new RangeError("全局分配精确搜索上限必须是正整数。");
  }
  [result.orderInversionPenalty, result.repeatedContentPenalty, result.ambiguityMargin].forEach(
    (value) => validateUnitNumber(value, "全局分配参数")
  );
  return result;
}

function overlapDuration(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number
): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function normalizeScoreMargin(best: number, runnerUp: number): number {
  return Math.max(0, best - runnerUp) / Math.max(Math.abs(best), 1e-9);
}

function validateRange(startMs: number, endMs: number, label: string): void {
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs
  ) {
    throw new RangeError(`${label}必须是有效的非负半开毫秒区间。`);
  }
}

function validateUnitNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label}必须位于 0 到 1。`);
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label}不能为空。`);
  }
  return normalized;
}
