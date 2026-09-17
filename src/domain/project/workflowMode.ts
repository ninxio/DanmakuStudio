import type { EditorProject } from "./types";

export type ProjectWorkflowMode = "xml-only" | "media-alignment";

/**
 * The workflow is inferred from durable project facts instead of a user-facing
 * switch. Importing alignment media or creating alignment data upgrades the
 * project to media alignment; removing all alignment context returns it to the
 * lightweight XML editor.
 */
export function getProjectWorkflowMode(
  project: EditorProject
): ProjectWorkflowMode {
  const hasAlignmentContext =
    project.mediaLibrary.length > 0 ||
    project.media !== null ||
    project.mediaBinding !== null ||
    project.danmakuSourceBindings.length > 0 ||
    project.danmakuSourceSegments.length > 0 ||
    project.mediaMatchCandidates.length > 0 ||
    project.mediaTimeMaps.length > 0;

  return hasAlignmentContext ? "media-alignment" : "xml-only";
}

export function isXmlOnlyProject(project: EditorProject): boolean {
  return getProjectWorkflowMode(project) === "xml-only";
}
