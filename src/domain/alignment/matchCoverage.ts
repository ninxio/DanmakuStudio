import type { EditorProject } from "../project/types";
import { projectDanmakuToTargets } from "../timeline/sourceProjection";
import {
  adoptProjectMatches,
  currentCandidateMap,
  isPlaybackAdopted,
  isPlaybackProvisionalSpan
} from "./playbackAdoption";

export interface CoverageInterval {
  startMs: number;
  endMs: number;
  candidateId: string;
  spanIndex: number;
  provisional: boolean;
}

export function analyzeMatchCoverage(project: EditorProject) {
  const adoption = adoptProjectMatches(project);
  const projection = projectDanmakuToTargets(adoption.project);
  const candidates = project.mediaMatchCandidates.filter(
    (candidate) => candidate.state !== "rejected"
  );
  const episodes = project.mediaLibrary
    .filter((media) => media.role === "targetOriginal")
    .map((media) => {
      const relations = candidates
        .filter((candidate) => candidate.targetMediaId === media.id)
        .map((candidate) => {
          const map =
            currentCandidateMap(adoption.project, candidate) ??
            currentCandidateMap(project, candidate);
          // IDs change when a previously pending relation is adopted for the preview.
          const previewCandidate = adoption.project.mediaMatchCandidates.find(
            (c) => c.id === candidate.id
          )!;
          const previewMap = currentCandidateMap(adoption.project, previewCandidate) ?? map;
          const source = project.mediaLibrary.find((m) => m.id === candidate.sourceMediaId)!;
          return {
            candidate,
            source,
            map: previewMap,
            adopted: Boolean(
              currentCandidateMap(project, candidate) &&
              isPlaybackAdopted(currentCandidateMap(project, candidate)!)
            ),
            issue:
              adoption.issues.find((issue) => issue.candidateId === candidate.id)?.message ??
              null
          };
        });
      const intervals: CoverageInterval[] = relations.flatMap(({ candidate, map, issue }) =>
        issue || !map
          ? []
          : map.spans.flatMap((span, spanIndex) =>
              span.kind === "matched"
                ? [
                    {
                      startMs: span.targetStartMs,
                      endMs: span.targetEndMs,
                      candidateId: candidate.id,
                      spanIndex,
                      provisional:
                        isPlaybackProvisionalSpan(map, span.id ?? "") ||
                        span.quality?.level !== "verified"
                    }
                  ]
                : []
            )
      );
      const durationMs =
        media.durationMs ?? Math.max(0, ...intervals.map((interval) => interval.endMs));
      const merged = mergeIntervals(intervals, durationMs);
      const bands = coverageBands(intervals, durationMs);
      const gaps = [];
      let cursor = 0;
      for (const interval of merged) {
        if (interval.startMs > cursor) gaps.push({ startMs: cursor, endMs: interval.startMs });
        cursor = interval.endMs;
      }
      if (cursor < durationMs) gaps.push({ startMs: cursor, endMs: durationMs });
      const coveredMs = merged.reduce(
        (sum, interval) => sum + interval.endMs - interval.startMs,
        0
      );
      const group = projection.groups.find((group) => group.targetMediaId === media.id);
      return {
        media,
        relations,
        intervals,
        gaps,
        durationMs,
        durationKnown: media.durationMs !== null,
        coveredMs,
        bands,
        overlapMs: bands
          .filter((band) => band.count > 1)
          .reduce((sum, band) => sum + band.endMs - band.startMs, 0),
        projectedCount: group?.entries.length ?? 0
      };
    });
  const represented = new Set(
    episodes.flatMap((episode) =>
      episode.relations
        .filter(
          (relation) =>
            !relation.issue && relation.map?.spans.some((span) => span.kind === "matched")
        )
        .map((relation) => relation.candidate.sourceMediaId)
    )
  );
  const unlocated = project.mediaLibrary
    .filter((media) => media.role === "bilibiliReference" && !represented.has(media.id))
    .map((media) => ({
      media,
      itemCount: project.danmakuSourceBindings
        .filter((binding) => binding.sourceMediaId === media.id)
        .reduce(
          (sum, binding) =>
            sum +
            (project.assets.find((asset) => asset.id === binding.assetId)?.items.length ?? 0),
          0
        )
    }));
  const exportedItems = new Set(
    projection.groups.flatMap((group) => group.entries.map((entry) => entry.item.id))
  );
  const disabled = new Set(project.disabledItemIds);
  const retainedAssets = project.assets
    .map((asset) => ({
      ...asset,
      items: asset.items.filter(
        (item) => item.enabled && !disabled.has(item.id) && !exportedItems.has(item.id)
      )
    }))
    .filter((asset) => asset.items.length > 0);
  return {
    adoption,
    projection,
    episodes,
    unlocated,
    retainedAssets,
    totalItems: project.assets.reduce((sum, asset) => sum + asset.items.length, 0),
    retainedCount: retainedAssets.reduce((sum, asset) => sum + asset.items.length, 0)
  };
}

/** Count distinct references, never adjacent spans of the same reference. */
function coverageBands(intervals: CoverageInterval[], durationMs: number) {
  const events = new Map<number, { candidateId: string; delta: number }[]>();
  for (const interval of intervals) {
    const start = Math.max(0, interval.startMs);
    const end = Math.min(durationMs, interval.endMs);
    if (end <= start) continue;
    for (const [time, delta] of [
      [start, 1],
      [end, -1]
    ])
      events.set(time, [
        ...(events.get(time) ?? []),
        { candidateId: interval.candidateId, delta }
      ]);
  }
  const points = [...new Set([0, durationMs, ...events.keys()])].sort((a, b) => a - b);
  const active = new Map<string, number>();
  const bands: { startMs: number; endMs: number; count: number }[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const startMs = points[index];
    for (const event of events.get(startMs) ?? [])
      active.set(event.candidateId, (active.get(event.candidateId) ?? 0) + event.delta);
    const count = [...active.values()].filter((n) => n > 0).length;
    const endMs = points[index + 1];
    const previous = bands.at(-1);
    if (previous?.count === count && previous.endMs === startMs) previous.endMs = endMs;
    else bands.push({ startMs, endMs, count });
  }
  return bands;
}

function mergeIntervals(intervals: CoverageInterval[], durationMs: number) {
  const result: { startMs: number; endMs: number }[] = [];
  for (const interval of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    const startMs = Math.max(0, interval.startMs);
    const endMs = Math.min(durationMs, interval.endMs);
    if (endMs <= startMs) continue;
    const previous = result.at(-1);
    if (previous && startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, endMs);
    else result.push({ startMs, endMs });
  }
  return result;
}
