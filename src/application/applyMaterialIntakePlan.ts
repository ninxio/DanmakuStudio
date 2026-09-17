import { reconcileMediaMatchCandidates } from "../domain/alignment/mediaMatching";
import { createId } from "../domain/project/factory";
import type { MaterialIntakePlan } from "../domain/project/materialIntakePlan";
import { createMaterialIntakePlan } from "../domain/project/materialIntakePlan";
import {
  createDanmakuSourceBinding,
  findDanmakuSourceBinding,
  upsertDanmakuSourceBinding
} from "../domain/project/mediaLibrary";
import type { EditorProject } from "../domain/project/types";

export type MaterialIntakeApplySkipReason =
  "projectChanged" | "unknownSuggestion" | "alreadyBound" | "noLongerSuggested";

export interface MaterialIntakeApplySkip {
  suggestionId: string;
  reason: MaterialIntakeApplySkipReason;
  message: string;
}

export interface ApplyMaterialIntakePlanOptions {
  selectedSuggestionIds: readonly string[];
  timestamp?: string;
  createBindingId?: () => string;
}

export interface ApplyMaterialIntakePlanResult {
  project: EditorProject;
  appliedSuggestionIds: string[];
  skipped: MaterialIntakeApplySkip[];
}

export function applyMaterialIntakePlan(
  project: EditorProject,
  plan: MaterialIntakePlan,
  options: ApplyMaterialIntakePlanOptions
): ApplyMaterialIntakePlanResult {
  const selectedIds = uniqueStrings(options.selectedSuggestionIds);
  if (selectedIds.length === 0) {
    return { project, appliedSuggestionIds: [], skipped: [] };
  }
  const planSuggestionsById = new Map(
    plan.suggestions.map((suggestion) => [suggestion.id, suggestion] as const)
  );
  const orderedSelectedIds = [
    ...plan.suggestions
      .map((suggestion) => suggestion.id)
      .filter((suggestionId) => selectedIds.includes(suggestionId)),
    ...selectedIds.filter((suggestionId) => !planSuggestionsById.has(suggestionId))
  ];
  if (plan.projectId !== project.id) {
    return {
      project,
      appliedSuggestionIds: [],
      skipped: orderedSelectedIds.map((suggestionId) => ({
        suggestionId,
        reason: "projectChanged",
        message: "批量关系建议属于另一个项目，未应用任何绑定。"
      }))
    };
  }

  const currentPlan = createMaterialIntakePlan(project);
  const currentSuggestionsById = new Map(
    currentPlan.suggestions.map((suggestion) => [suggestion.id, suggestion] as const)
  );
  const timestamp = options.timestamp ?? new Date().toISOString();
  const createBindingId = options.createBindingId ?? (() => createId("danmaku_source_binding"));
  let bindings = [...project.danmakuSourceBindings];
  const appliedSuggestionIds: string[] = [];
  const skipped: MaterialIntakeApplySkip[] = [];

  for (const suggestionId of orderedSelectedIds) {
    const plannedSuggestion = planSuggestionsById.get(suggestionId);
    if (!plannedSuggestion) {
      skipped.push({
        suggestionId,
        reason: "unknownSuggestion",
        message: "所选关系不在当前预览中，已跳过。"
      });
      continue;
    }
    if (findDanmakuSourceBinding(bindings, plannedSuggestion.assetId)) {
      skipped.push({
        suggestionId,
        reason: "alreadyBound",
        message: `“${plannedSuggestion.assetFileName}”已在预览后建立绑定，现有关系已保留。`
      });
      continue;
    }
    const currentSuggestion = currentSuggestionsById.get(suggestionId);
    if (
      !currentSuggestion ||
      currentSuggestion.assetId !== plannedSuggestion.assetId ||
      currentSuggestion.sourceMediaId !== plannedSuggestion.sourceMediaId
    ) {
      skipped.push({
        suggestionId,
        reason: "noLongerSuggested",
        message: `“${plannedSuggestion.assetFileName}”的素材状态已变化，请重新预览后再应用。`
      });
      continue;
    }
    bindings = upsertDanmakuSourceBinding(
      bindings,
      createDanmakuSourceBinding(
        createBindingId(),
        currentSuggestion.assetId,
        currentSuggestion.sourceMediaId,
        timestamp
      )
    );
    appliedSuggestionIds.push(suggestionId);
  }

  if (appliedSuggestionIds.length === 0) {
    return { project, appliedSuggestionIds, skipped };
  }
  return {
    project: reconcileMediaMatchCandidates({
      ...project,
      danmakuSourceBindings: bindings
    }),
    appliedSuggestionIds,
    skipped
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
