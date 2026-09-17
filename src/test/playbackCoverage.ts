import { createEpisodeMatchingProject } from "./episodeMatching";
import { createTestCompleteTimeMapSpan } from "./timeMapEvidence";
import {
  createMediaMatchCandidate,
  upsertMediaMatchCandidate
} from "../domain/alignment/mediaMatching";

export function createPlaybackCoverageProject(counts = [2, 2]) {
  let project = createEpisodeMatchingProject(counts);
  project.name = "覆盖分析测试";
  project.mediaLibrary = project.mediaLibrary.map((media) => ({
    ...media,
    durationMs: 120000,
    contentIdentity: {
      algorithm: "fnv1a64-first-middle-last-64k-v1",
      sizeBytes: 1000,
      modifiedUnixMs: 1700000000000,
      firstSampleDigest: "a".repeat(16),
      middleSampleDigest: "b".repeat(16),
      lastSampleDigest: "c".repeat(16)
    }
  }));
  project.assets = project.assets.map((asset) => ({
    ...asset,
    items: [10000, 40000, 80000].map((time, index) => ({
      ...asset.items[0],
      id: `${asset.id}-item-${index}`,
      originalIndex: index,
      sourceTimeMs: time,
      text: `comment ${index}`
    }))
  }));
  let sourceOrdinal = 0;
  counts.forEach((count, episodeIndex) => {
    for (let part = 0; part < count; part++) {
      sourceOrdinal++;
      const candidate = createMediaMatchCandidate(project, {
        id: `candidate-${sourceOrdinal}`,
        batchId: "coverage-test",
        sourceMediaId: `source-${sourceOrdinal}`,
        targetMediaId: `target-${episodeIndex + 1}`,
        proposal: {
          confidence: 0.5,
          anchors: [],
          cutCandidates: [],
          diagnostics: ["单一音频，尚未审查"],
          matchRange: {
            sourceStartMs: 0,
            sourceEndMs: 60000,
            targetStartMs: 10000,
            targetEndMs: 70000,
            coverage: 0.5
          }
        }
      });
      project = upsertMediaMatchCandidate(project, candidate);
      project.mediaTimeMaps = project.mediaTimeMaps.map((map) =>
        map.id === candidate.timeMapId
          ? {
              ...map,
              sourceIdentity: project.mediaLibrary.find(
                (media) => media.id === candidate.sourceMediaId
              )!.contentIdentity,
              targetIdentity: project.mediaLibrary.find(
                (media) => media.id === candidate.targetMediaId
              )!.contentIdentity,
              quality: { ...map.quality, level: "blocked", reasons: ["视觉证据不可用"] },
              spans: [
                createTestCompleteTimeMapSpan(
                  {
                    kind: "matched",
                    sourceStartMs: 0,
                    sourceEndMs: 30000,
                    targetStartMs: 10000,
                    targetEndMs: 40000
                  },
                  map.id + ":1"
                ),
                createTestCompleteTimeMapSpan(
                  {
                    kind: "ambiguous",
                    sourceStartMs: 30000,
                    sourceEndMs: 60000,
                    targetStartMs: 40000,
                    targetEndMs: 70000
                  },
                  map.id + ":2"
                )
              ]
            }
          : map
      );
    }
  });
  return project;
}
