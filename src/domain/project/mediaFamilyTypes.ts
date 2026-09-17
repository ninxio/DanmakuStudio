import type { DanmakuItem } from "../danmaku/types";
import type { EpisodeIdentity } from "./episodeIdentity";
import type { EditorProject } from "./types";

export type MediaFamilyProject = Pick<
  EditorProject,
  "assets" | "mediaLibrary" | "danmakuSourceBindings"
>;
export interface MediaFamilyContext {
  assetPaths?: Readonly<Record<string, string | undefined>>;
  /** Explicit, measured or user-confirmed playback durations; never last-comment estimates. */
  assetDurationsMs?: Readonly<Record<string, number | undefined>>;
  importTitle?: string;
  /** User-selected interpretation, scoped to a source; never rewrites explicit identities. */
  numberingBySource?: Readonly<Record<string, FamilyNumberingMode | undefined>>;
}
export type FamilyNumberingMode =
  "auto" | "episodePart" | "seasonEpisode" | "episodeRange" | "episode";
export interface FamilyNumberingSuggestion {
  sourceGroupKey: string;
  sourceLabel: string;
  fileCount: number;
  selectedMode: FamilyNumberingMode;
  recommendedMode: FamilyNumberingMode;
  reasons: string[];
  modes: FamilyNumberingMode[];
}
export type FamilyWorkflowIntent =
  "movieParts" | "episodes" | "episodeParts" | "longCollection" | "unknown";
export type FamilyEvidenceStrength = "strong" | "plausible" | "weak";
export interface MediaFamilyTitleCandidate {
  title: string;
  source: "importContext" | "emby" | "fileStem" | "directory" | "xmlMetadata";
  strength: FamilyEvidenceStrength;
  reasons: string[];
}
export interface MediaFamilyFile {
  assetId: string;
  fileName: string;
  sourceGroupKey: string;
  sourceLabel: string;
  sequenceNumber: number | null;
  partNumber: number | null;
  episodeIdentity: EpisodeIdentity | null;
  durationMs: number | null;
  durationSource: "explicit" | "bilibili" | "boundMedia" | "unknown";
  /** Lower bound only. Null for an empty XML. No text-content analysis. */
  lastCommentMs: number | null;
  itemCount: number;
}
export interface MediaFamilyGroup {
  key: string;
  sourceGroupKey: string;
  sourceLabel: string;
  episodeKey: string | null;
  episodeLabel: string;
  assetIds: string[];
}
export interface MediaFamilyHypothesis {
  kind: FamilyWorkflowIntent;
  strength: FamilyEvidenceStrength;
  reasons: string[];
  groupKeys: string[];
}
export interface MediaFamilyIssue {
  code: string;
  message: string;
  assetIds: string[];
}
export interface MediaFamilyAnalysis {
  suggestedTitle: string | null;
  titleCandidates: MediaFamilyTitleCandidate[];
  files: MediaFamilyFile[];
  groups: MediaFamilyGroup[];
  hypotheses: MediaFamilyHypothesis[];
  issues: MediaFamilyIssue[];
  numberingSuggestions: FamilyNumberingSuggestion[];
}

/** User-editable organization, not media identity, verification or export permission. */
export interface FamilyArrangement {
  version: 1;
  title: string;
  workflow: FamilyWorkflowIntent;
  rows: FamilyArrangementRow[];
}
export interface FamilyArrangementRow {
  id: string;
  assetId: string;
  episodeKey: string | null;
  episodeLabel: string;
  sourceInMs: number;
  /** Null means the remaining source; it does not invent an end time. */
  sourceOutMs: number | null;
  /** Null appends only when the preceding enabled row has a known end. */
  targetStartMs: number | null;
  enabled: boolean;
}
export interface FamilyArrangementIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  rowId: string | null;
  episodeKey: string | null;
}
export interface FamilyArrangementEntry {
  item: DanmakuItem;
  finalTimeMs: number;
  rowId: string;
}
export interface FamilyArrangementExportGroup {
  episodeKey: string;
  episodeLabel: string;
  rowIds: string[];
  entries: FamilyArrangementEntry[];
  /** Structural readiness only; callers retain the existing export safety gates. */
  exportable: boolean;
  endMs: number | null;
}
export interface FamilyArrangementExport {
  issues: FamilyArrangementIssue[];
  groups: FamilyArrangementExportGroup[];
}
