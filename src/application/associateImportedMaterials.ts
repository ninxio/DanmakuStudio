import { createMaterialIntakePlan } from "../domain/project/materialIntakePlan";
import type { EditorProject } from "../domain/project/types";
import { applyMaterialIntakePlan } from "./applyMaterialIntakePlan";

/** Run inside the import transaction, never in a project-change subscription. */
export function associateImportedMaterials(
  project: EditorProject,
  imported: { assetIds?: readonly string[]; referenceMediaIds?: readonly string[] }
): { project: EditorProject; boundCount: number } {
  const assetIds = new Set(imported.assetIds);
  const referenceIds = new Set(imported.referenceMediaIds);
  if (assetIds.size === 0 && referenceIds.size === 0) return { project, boundCount: 0 };
  const plan = createMaterialIntakePlan(project);
  const result = applyMaterialIntakePlan(project, plan, {
    selectedSuggestionIds: plan.suggestions
      .filter(
        (suggestion) =>
          assetIds.has(suggestion.assetId) || referenceIds.has(suggestion.sourceMediaId)
      )
      .map((suggestion) => suggestion.id)
  });
  return { project: result.project, boundCount: result.appliedSuggestionIds.length };
}

export function describeImportedAssociations(boundCount: number): string {
  return boundCount > 0 ? ` 已自动关联 ${boundCount} 组 XML 来源；可一次撤销本次导入。` : "";
}
