import { describe, expect, it } from "vitest";
import {
  beginAlignmentExperimentAttempt,
  createAlignmentExperimentPairReceipt,
  createAlignmentExperimentQueue,
  finishAlignmentExperimentAttempt,
  interruptAlignmentExperimentQueue,
  parseAlignmentExperimentQueueJson,
  recoverAlignmentExperimentQueue,
  retryAlignmentExperimentPairs,
  serializeAlignmentExperimentQueue,
  type AlignmentExperimentQueueConfig
} from "./alignmentExperimentQueue";

const config: AlignmentExperimentQueueConfig = {
  sourceMediaIds: ["source-a"],
  targetMediaIds: ["target-a", "target-b"],
  pairs: [
    { sourceMediaId: "source-a", targetMediaId: "target-a" },
    { sourceMediaId: "source-a", targetMediaId: "target-b" }
  ],
  versionReuseGroups: [],
  audioStreamSelections: { "source-a": 1, "target-a": null },
  spectralBackend: "auto",
  windowMs: 100,
  minGapMs: 5_000,
  matchThreshold: 0.62,
  enableVisualEvidence: true
};

describe("alignment experiment queue", () => {
  it("creates a path-free deterministic queue and round-trips canonical JSON", () => {
    const queue = createQueue();
    expect(queue.pairs.map((pair) => pair.state)).toEqual(["pending", "pending"]);
    expect(queue.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(serializeAlignmentExperimentQueue(queue)).not.toContain("C:\\");
    expect(parseAlignmentExperimentQueueJson(serializeAlignmentExperimentQueue(queue))).toEqual(
      queue
    );
  });

  it("recovers a process interruption without pretending the running case completed", () => {
    const queue = beginAlignmentExperimentAttempt(createQueue(), {
      jobId: "native-job-1",
      pairs: [config.pairs[0]],
      nowMs: 2_000
    });
    const recovered = recoverAlignmentExperimentQueue(queue, 3_000);
    expect(recovered.state).toBe("interrupted");
    expect(recovered.activeJobId).toBeNull();
    expect(recovered.pairs[0]).toMatchObject({
      state: "pending",
      attemptCount: 1,
      interruptionCount: 1,
      receipts: []
    });
  });

  it("keeps one digest-bound receipt per case and isolates failed cases", () => {
    const running = beginAlignmentExperimentAttempt(createQueue(), {
      jobId: "native-job-2",
      pairs: config.pairs,
      nowMs: 2_000
    });
    const finished = finishAlignmentExperimentAttempt(running, {
      jobId: "native-job-2",
      nowMs: 3_000,
      error: "one case needs retry",
      results: [
        result("target-a", "confirmable", 0),
        result("target-b", "failed", 1)
      ]
    });
    expect(finished.state).toBe("completedWithIssues");
    expect(finished.pairs[0].state).toBe("confirmable");
    expect(finished.pairs[1].state).toBe("failed");
    expect(finished.pairs[0].receipts[0].receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("retains receipt history when only failed cases are retried", () => {
    const first = finishAlignmentExperimentAttempt(
      beginAlignmentExperimentAttempt(createQueue(), {
        jobId: "native-job-3",
        pairs: config.pairs,
        nowMs: 2_000
      }),
      {
        jobId: "native-job-3",
        nowMs: 3_000,
        results: [
          result("target-a", "confirmable", 0, "native-job-3"),
          result("target-b", "failed", 1, "native-job-3")
        ]
      }
    );
    const retryReady = retryAlignmentExperimentPairs(first, [first.pairs[1].pairId], 4_000);
    const retryRunning = beginAlignmentExperimentAttempt(retryReady, {
      jobId: "native-job-4",
      pairs: [config.pairs[1]],
      nowMs: 5_000
    });
    const completed = finishAlignmentExperimentAttempt(retryRunning, {
      jobId: "native-job-4",
      nowMs: 6_000,
      results: [result("target-b", "reviewCandidate", 0, "native-job-4")]
    });
    expect(completed.state).toBe("completed");
    expect(completed.pairs[0].attemptCount).toBe(1);
    expect(completed.pairs[1]).toMatchObject({ state: "reviewCandidate", attemptCount: 2 });
    expect(completed.pairs[1].receipts).toHaveLength(2);
  });

  it("rejects tampered config and receipt digests", () => {
    const queue = createQueue();
    const configTampered = JSON.parse(serializeAlignmentExperimentQueue(queue)) as Record<
      string,
      unknown
    >;
    (configTampered.config as Record<string, unknown>).windowMs = 101;
    expect(() => parseAlignmentExperimentQueueJson(JSON.stringify(configTampered))).toThrow(
      "配置摘要"
    );

    const receipt = createAlignmentExperimentPairReceipt(result("target-a", "confirmable", 0));
    const running = beginAlignmentExperimentAttempt(createQueue(), {
      jobId: "native-job-2",
      pairs: [config.pairs[0]],
      nowMs: 2_000
    });
    const finished = finishAlignmentExperimentAttempt(running, {
      jobId: "native-job-2",
      nowMs: 3_000,
      results: [{ ...result("target-a", "confirmable", 0), message: receipt.message }]
    });
    const receiptTampered = JSON.parse(serializeAlignmentExperimentQueue(finished)) as {
      pairs: Array<{ receipts: Array<Record<string, unknown>> }>;
    };
    receiptTampered.pairs[0].receipts[0].outcome = "failed";
    expect(() => parseAlignmentExperimentQueueJson(JSON.stringify(receiptTampered))).toThrow(
      "回执摘要"
    );
  });

  it("rejects missing terminal receipts and wrong native jobs", () => {
    const running = beginAlignmentExperimentAttempt(createQueue(), {
      jobId: "native-job-5",
      pairs: config.pairs,
      nowMs: 2_000
    });
    expect(() =>
      finishAlignmentExperimentAttempt(running, {
        jobId: "native-job-5",
        nowMs: 3_000,
        results: [result("target-a", "confirmable", 0, "native-job-5")]
      })
    ).toThrow("缺少终态回执");
    expect(() =>
      finishAlignmentExperimentAttempt(running, {
        jobId: "other-job",
        nowMs: 3_000,
        results: []
      })
    ).toThrow("不属于当前原生任务");
  });

  it("records explicit interruption reasons while preserving prior receipts", () => {
    const interrupted = interruptAlignmentExperimentQueue(createQueue(), "project changed", 2_000);
    expect(interrupted).toMatchObject({ state: "interrupted", lastError: "project changed" });
  });
});

function createQueue() {
  return createAlignmentExperimentQueue({
    queueId: "queue-1",
    projectId: "project-1",
    config,
    nowMs: 1_000
  });
}

function result(
  targetMediaId: string,
  outcome: "confirmable" | "reviewCandidate" | "failed",
  pairIndex: number,
  jobId = "native-job-2"
) {
  return {
    sourceMediaId: "source-a",
    targetMediaId,
    jobId,
    pairIndex,
    outcome,
    message: `result ${outcome}`,
    completedAtMs: 3_000 + pairIndex,
    executionIdentityDigest: digest("1"),
    fineFrontierReceiptDigest: digest("2"),
    fineExecutionEvidenceDigest: digest("3"),
    proposalTimeMapDigest: outcome === "failed" ? null : digest("4")
  } as const;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}
