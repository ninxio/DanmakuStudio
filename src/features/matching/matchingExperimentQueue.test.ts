import { describe, expect, it } from "vitest";
import { createAlignmentExperimentQueue } from "../../domain/alignment/alignmentExperimentQueue";
import type { AudioAlignmentBatchJobSnapshot } from "../../infrastructure/alignment/tauriAudioAlignment";
import {
  alignmentExperimentQueueToBatchTasks,
  buildMatchingExperimentQueueConfig,
  createAlignmentExperimentFinishResults,
  queueMatchesConfig
} from "./matchingExperimentQueue";

describe("matching experiment queue adapter", () => {
  it("builds a path-free config and ignores stream selections outside the inventory", () => {
    const config = createConfig();
    expect(config.audioStreamSelections).toEqual({ source: 1, target: null });
    expect(JSON.stringify(config)).not.toContain("outside");
  });

  it("restores user-facing task state from a persisted queue", () => {
    const queue = createAlignmentExperimentQueue({
      queueId: "queue-1",
      projectId: "project-1",
      config: createConfig(),
      nowMs: 1_000
    });
    expect(alignmentExperimentQueueToBatchTasks(queue)).toEqual([
      expect.objectContaining({
        id: "source\u0000target",
        state: "waiting",
        progress: 0,
        message: "等待继续分析"
      })
    ]);
  });

  it("binds a failed native pair to a compact terminal receipt", () => {
    const results = createAlignmentExperimentFinishResults(failedSnapshot());
    expect(results).toEqual([
      expect.objectContaining({
        sourceMediaId: "source",
        targetMediaId: "target",
        jobId: "job-1",
        pairIndex: 0,
        outcome: "failed",
        executionIdentityDigest: sha("a"),
        fineFrontierReceiptDigest: null,
        fineExecutionEvidenceDigest: null,
        proposalTimeMapDigest: null
      })
    ]);
  });

  it("requires the complete configuration digest before resuming", () => {
    const config = createConfig();
    const queue = createAlignmentExperimentQueue({
      queueId: "queue-1",
      projectId: "project-1",
      config,
      nowMs: 1_000
    });
    expect(queueMatchesConfig(queue, config)).toBe(true);
    expect(queueMatchesConfig(queue, { ...config, windowMs: 200 })).toBe(false);
  });
});

function createConfig() {
  return buildMatchingExperimentQueueConfig({
    sourceMediaIds: ["source"],
    targetMediaIds: ["target"],
    pairs: [{ sourceMediaId: "source", targetMediaId: "target" }],
    versionReuseGroups: [],
    selectedAudioStreamIndexes: { outside: 9, source: 1, target: null },
    spectralBackend: "auto",
    windowMs: 100,
    minGapMs: 5_000,
    matchThreshold: 0.62,
    enableVisualEvidence: true
  });
}

function failedSnapshot(): AudioAlignmentBatchJobSnapshot {
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "job-1",
    pairingMode: "explicit",
    sourceMediaIds: ["source"],
    targetMediaIds: ["target"],
    versionReuseGroups: [],
    status: "failed",
    progress: 1,
    message: "batch failed",
    totalPairCount: 1,
    processedPairCount: 1,
    failedPairCount: 1,
    currentPairOrdinal: null,
    diagnosticEvents: [],
    pairs: [
      {
        pairIndex: 0,
        pairOrdinal: 1,
        sourceMediaId: "source",
        targetMediaId: "target",
        status: "failed",
        progress: 1,
        message: "decoder failed",
        relationRanking: {
          scoreVersion: "alignment-v2-pair-intrinsic-global-weight-v1",
          executionIdentityDigest: sha("a"),
          executionIdentity: null,
          state: "failed",
          candidateCount: 0,
          eligibleCandidateCount: 0,
          score: null,
          bestEligibleCandidate: null
        },
        globalSelection: {
          state: "failed",
          selected: false,
          selectedRank: null,
          selectedScore: null,
          decisionRank: null,
          decisionScore: null,
          margin: null,
          candidateCount: 0,
          eligibleCandidateCount: 0,
          topK: [],
          decisionCandidate: null
        },
        fineFrontier: null,
        fineExecutionEvidence: null,
        proposal: null,
        error: "decoder failed"
      }
    ],
    error: "decoder failed",
    updatedAtMs: 2_000
  };
}

function sha(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
