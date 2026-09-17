import type { AlignmentProposal, CutCandidate } from "./types";
import type { SyncAnchor } from "../danmaku/types";
import type { EditorProject } from "../project/types";
import type { Milliseconds } from "../shared/time";

export type AlignmentPreviewState = "candidate" | "applied";

export interface AlignmentPreviewAnchor {
  id: string;
  sourceMs: Milliseconds;
  targetMs: Milliseconds;
  confidence: number | null;
  origin: SyncAnchor["origin"];
  state: AlignmentPreviewState;
}

export interface AlignmentPreviewCutCandidate {
  id: string;
  name: string;
  sourceAtMs: Milliseconds;
  sourceRangeStartMs?: Milliseconds;
  sourceRangeEndMs?: Milliseconds;
  targetGapMs: Milliseconds;
  confidence: number;
  note: string;
  state: AlignmentPreviewState;
}

export interface AlignmentPreviewSummary {
  proposalAnchorCount: number;
  proposalCutCount: number;
  candidateAnchorCount: number;
  candidateCutCount: number;
  appliedAnchorCount: number;
  appliedCutCount: number;
}

export interface AlignmentPreviewModel {
  projectAnchors: SyncAnchor[];
  proposalAnchors: AlignmentPreviewAnchor[];
  proposalCuts: AlignmentPreviewCutCandidate[];
  summary: AlignmentPreviewSummary;
}

export function buildAlignmentPreview(
  project: EditorProject,
  proposal: AlignmentProposal | null
): AlignmentPreviewModel {
  const projectAnchors = [...project.syncAnchors].sort(compareAnchors);
  const proposalAnchors =
    proposal?.anchors
      .map(
        (anchor): AlignmentPreviewAnchor => ({
          id: anchor.id,
          sourceMs: anchor.sourceMs,
          targetMs: anchor.targetMs,
          confidence: anchor.confidence ?? null,
          origin: anchor.origin,
          state: isAlignmentAnchorApplied(project.syncAnchors, anchor) ? "applied" : "candidate"
        })
      )
      .sort(comparePreviewAnchors) ?? [];
  const proposalCuts =
    proposal?.cutCandidates
      .map(
        (candidate): AlignmentPreviewCutCandidate => ({
          id: candidate.id,
          name: candidate.name,
          sourceAtMs: candidate.sourceAtMs,
          sourceRangeStartMs: candidate.sourceRangeStartMs,
          sourceRangeEndMs: candidate.sourceRangeEndMs,
          targetGapMs: candidate.targetGapMs,
          confidence: candidate.confidence,
          note: candidate.note,
          state: isAlignmentCutCandidateApplied(project.cutMarkers, candidate) ? "applied" : "candidate"
        })
      )
      .sort(comparePreviewCuts) ?? [];

  return {
    projectAnchors,
    proposalAnchors,
    proposalCuts,
    summary: {
      proposalAnchorCount: proposalAnchors.length,
      proposalCutCount: proposalCuts.length,
      candidateAnchorCount: proposalAnchors.filter((anchor) => anchor.state === "candidate").length,
      candidateCutCount: proposalCuts.filter((candidate) => candidate.state === "candidate").length,
      appliedAnchorCount: proposalAnchors.filter((anchor) => anchor.state === "applied").length,
      appliedCutCount: proposalCuts.filter((candidate) => candidate.state === "applied").length
    }
  };
}

export function isAlignmentAnchorApplied(anchors: SyncAnchor[], proposalAnchor: SyncAnchor): boolean {
  return anchors.some(
    (anchor) =>
      (anchor.sourceMs === proposalAnchor.sourceMs && anchor.targetMs === proposalAnchor.targetMs)
  );
}

export function isAlignmentCutCandidateApplied(
  markers: EditorProject["cutMarkers"],
  candidate: CutCandidate
): boolean {
  const candidateSourceAtMs = Math.max(0, Math.round(candidate.sourceAtMs));
  const candidateTargetGapMs = Math.round(candidate.targetGapMs);
  return markers.some(
    (marker) =>
      marker.sourceAtMs === candidateSourceAtMs && marker.targetGapMs === candidateTargetGapMs
  );
}

function compareAnchors(left: SyncAnchor, right: SyncAnchor): number {
  return left.sourceMs - right.sourceMs || left.targetMs - right.targetMs || left.id.localeCompare(right.id);
}

function comparePreviewAnchors(left: AlignmentPreviewAnchor, right: AlignmentPreviewAnchor): number {
  return left.sourceMs - right.sourceMs || left.targetMs - right.targetMs || left.id.localeCompare(right.id);
}

function comparePreviewCuts(left: AlignmentPreviewCutCandidate, right: AlignmentPreviewCutCandidate): number {
  return left.sourceAtMs - right.sourceAtMs || left.targetGapMs - right.targetGapMs || left.id.localeCompare(right.id);
}
