import type { EditorProject, MediaMatchCandidate, MediaTimeMap } from "../project/types";
import { acceptMediaMatchCandidateWithManualTakeover } from "./mediaMatching";
import { isTimeMapManualTakeoverExportApproved } from "./timeMapReviewDecision";
import {
  invalidateTimeMapSpanEvidenceForManualReview,
  isCompleteTimeMapSpanEvidence,
  validateTimeMap
} from "./timeMap";

const ADOPTION = "playback-adoption:v1:";
const PROVISIONAL = "playback-provisional-span:v1:";

export function isPlaybackAdopted(map: MediaTimeMap): boolean {
  return map.evidence.notes.some((note) => note.startsWith(ADOPTION));
}

export function isPlaybackProvisionalSpan(map: MediaTimeMap, spanId: string): boolean {
  return map.evidence.notes.includes(PROVISIONAL + spanId);
}

export function currentCandidateMap(project: EditorProject, candidate: MediaMatchCandidate) {
  const id =
    candidate.state === "accepted" ? candidate.confirmedTimeMapId : candidate.timeMapId;
  return project.mediaTimeMaps.find((map) => map.id === id) ?? null;
}

export interface PlaybackAdoptionResult {
  project: EditorProject;
  adoptedCount: number;
  issues: { candidateId: string; message: string }[];
}

/** Explicit use for playback is not a claim that the user watched or validated every span.
 * Preserve the original map, current edits, and diagnostic evidence. Only positively sized
 * two-sided uncertain spans can become provisional affine mappings; never invent a location.
 */
export function adoptProjectMatches(
  project: EditorProject,
  candidateIds = project.mediaMatchCandidates
    .filter((c) => c.state !== "rejected")
    .map((c) => c.id),
  timestamp = new Date().toISOString()
): PlaybackAdoptionResult {
  let result = project;
  let adoptedCount = 0;
  const issues: PlaybackAdoptionResult["issues"] = [];
  for (const id of new Set(candidateIds)) {
    const candidate = result.mediaMatchCandidates.find((item) => item.id === id);
    if (!candidate || candidate.state === "rejected") continue;
    const original = currentCandidateMap(result, candidate);
    if (
      original &&
      isPlaybackAdopted(original) &&
      isTimeMapManualTakeoverExportApproved(original)
    )
      continue;
    // Keep independently verified automatic results without replacing their provenance.
    if (
      candidate.state === "accepted" &&
      original?.quality.level === "verified" &&
      original.verification?.method === "automatic-calibration"
    )
      continue;
    try {
      if (!original || !original.sourceIdentity || !original.targetIdentity)
        throw new Error("没有可用时间图或媒体身份，请重新匹配或手动定位。");
      if (
        !validateTimeMap(original.spans).valid ||
        !original.spans.every(isCompleteTimeMapSpanEvidence)
      )
        throw new Error("时间图结构不完整，需先修正范围。");
      const notes = [...original.evidence.notes];
      const spans = original.spans.map((span) => {
        // A real manual decision is retained. Legacy blanket takeover suggestions are not
        // evidence that a user actually inspected and chose to discard this interval.
        const reviewed = project.alignmentReviewRecords.some(
          (record) =>
            (record.timeMapId === candidate.timeMapId || record.timeMapId === original.id) &&
            record.recordState === "active" &&
            record.decision === "replacement" &&
            record.spanId === span.id &&
            record.sourceStartMs === span.sourceStartMs &&
            record.sourceEndMs === span.sourceEndMs &&
            record.targetStartMs === span.targetStartMs &&
            record.targetEndMs === span.targetEndMs
        );
        if (
          span.kind !== "ambiguous" ||
          reviewed ||
          span.sourceEndMs <= span.sourceStartMs ||
          span.targetEndMs <= span.targetStartMs
        )
          return span;
        notes.push(PROVISIONAL + span.id);
        return invalidateTimeMapSpanEvidenceForManualReview(
          { ...span, kind: "matched" },
          false,
          "暂按现有两端边界映射，尚未审查；发现错位可返回此区间修正。"
        );
      });
      const preparedMap: MediaTimeMap = {
        ...original,
        id: candidate.timeMapId,
        state: "candidate",
        confirmedAt: null,
        revision: original.revision + 1,
        spans,
        verification: null,
        evidence: {
          ...original.evidence,
          notes: [...notes.filter((note) => !note.startsWith(ADOPTION)), ADOPTION + timestamp]
        },
        updatedAt: timestamp
      };
      const archiveId = `${candidate.timeMapId}:before-playback`;
      const maps = result.mediaTimeMaps.filter((map) => map.id !== candidate.timeMapId);
      if (!maps.some((map) => map.id === archiveId))
        maps.push({
          ...original,
          id: archiveId,
          state: "candidate",
          confirmedAt: null,
          verification: null
        });
      maps.push(preparedMap);
      const prepared: EditorProject = {
        ...result,
        mediaTimeMaps: maps,
        danmakuSourceSegments: result.danmakuSourceSegments.filter(
          (segment) => !candidate.appliedSegmentIds.includes(segment.id)
        ),
        mediaMatchCandidates: result.mediaMatchCandidates.map((item) =>
          item.id === id
            ? {
                ...item,
                state: "pending",
                confirmedTimeMapId: null,
                appliedSegmentIds: [],
                proposal: item.proposal.timeMap
                  ? {
                      ...item.proposal,
                      timeMap: {
                        ...item.proposal.timeMap,
                        spans,
                        evidence: {
                          ...item.proposal.timeMap.evidence,
                          notes: preparedMap.evidence.notes
                        }
                      }
                    }
                  : item.proposal
              }
            : item
        )
      };
      const assets = result.danmakuSourceBindings
        .filter((binding) => binding.sourceMediaId === candidate.sourceMediaId)
        .map((binding) => binding.assetId);
      result = acceptMediaMatchCandidateWithManualTakeover(prepared, id, assets, timestamp);
      adoptedCount++;
    } catch (error) {
      issues.push({
        candidateId: id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { project: result, adoptedCount, issues };
}
