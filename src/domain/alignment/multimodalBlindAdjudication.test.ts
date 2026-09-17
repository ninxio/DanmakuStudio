import { describe, expect, it } from "vitest";
import {
  buildMultimodalBlindReviewVoteSet,
  type MultimodalBlindReviewAnswer,
  type MultimodalBlindReviewPack
} from "./multimodalBlindReview";
import {
  buildMultimodalBlindAdjudication,
  buildMultimodalBlindLabelMerge,
  parseMultimodalBlindAdjudication,
  parseMultimodalBlindLabelMergeReceipt,
  parseMultimodalBlindReviewVoteSet
} from "./multimodalBlindAdjudication";
import {
  createMultimodalBlindReviewPackFixture,
  createMultimodalBlindReviewPackFixtureWithTasks
} from "../../test/multimodalBlindReviewFixture";

describe("multimodal blind adjudication", () => {
  it("combines two independent frame-accurate votes into path-free Gold", () => {
    const pack = createMultimodalBlindReviewPackFixture();
    const first = createVote(pack, "reviewer-a", 11_500, 500);
    const second = createVote(pack, "reviewer-b", 12_000, 400);
    const adjudication = buildMultimodalBlindAdjudication(pack, [first, second]);

    expect(adjudication.summary).toEqual({
      tasks: 1,
      gold: 1,
      conflicts: 0,
      pending: 0,
      weakOnly: 0
    });
    expect(adjudication.labels[0]).toMatchObject({
      expectedTargetTimestampMs: 11_750,
      boundaryToleranceMs: 500,
      precision: "adjudicatedGold",
      independentReviewerCount: 2
    });
    expect(JSON.stringify(adjudication)).not.toContain(pack.source.path);
    expect(parseMultimodalBlindAdjudication(adjudication)).toEqual(adjudication);
  });

  it("matches the Python adjudication fixed vector", () => {
    const pack = createMultimodalBlindReviewPackFixture();
    const adjudication = buildMultimodalBlindAdjudication(pack, [
      createVote(pack, "reviewer-a", 11_500, 500),
      createVote(pack, "reviewer-b", 12_000, 400)
    ]);

    expect(adjudication.labels[0].adjudicationReceiptId).toBe(
      "sha256:71d8a49b7571ad7778e356979914ffb4e00083a1a5d0e842a6471847335b5510"
    );
    expect(adjudication.adjudicationId).toBe(
      "sha256:5621a5d0ab4b71a8dd53d227da36a0dd4bf1315db393ad97bab94082dcfbafd5"
    );
  });

  it("rejects tampering, repeated reviewers and conflicting precise positions", () => {
    const pack = createMultimodalBlindReviewPackFixture();
    const first = createVote(pack, "reviewer-a", 11_500, 500);
    const tampered = structuredClone(first);
    tampered.votes[0].targetTimestampMs = 11_501;
    expect(() => parseMultimodalBlindReviewVoteSet(tampered, pack)).toThrow(/身份不一致/);
    expect(() => buildMultimodalBlindAdjudication(pack, [first, first])).toThrow(/重复复核者/);

    const conflict = buildMultimodalBlindAdjudication(pack, [
      first,
      createVote(pack, "reviewer-b", 13_000, 500)
    ]);
    expect(conflict.summary).toMatchObject({ conflicts: 1, gold: 0 });
  });

  it("keeps rough observations weak and one precise vote pending", () => {
    const pack = createMultimodalBlindReviewPackFixture();
    const roughAnswers = pack.tasks.map((task) => ({
      taskId: task.taskId,
      decision: "matched" as const,
      targetTimestampMs: 11_500,
      boundaryToleranceMs: 2_000,
      precision: "playbackChecked" as const
    }));
    const rough = buildMultimodalBlindReviewVoteSet(pack, "reviewer-a", roughAnswers);
    const anotherRough = buildMultimodalBlindReviewVoteSet(pack, "reviewer-b", roughAnswers);
    expect(buildMultimodalBlindAdjudication(pack, [rough, anotherRough]).summary.weakOnly).toBe(1);

    const precise = createVote(pack, "reviewer-c", 11_500, 500);
    expect(buildMultimodalBlindAdjudication(pack, [rough, precise]).summary.pending).toBe(1);
  });

  it("merges exactly validated three-family 60-query Gold and rejects leakage", () => {
    const adjudications = [0, 1, 2].map((familyIndex) => {
      const pack = createMultimodalBlindReviewPackFixtureWithTasks(familyIndex);
      return buildMultimodalBlindAdjudication(pack, [
        createCompleteVote(pack, `reviewer-a-${familyIndex}`, 0),
        createCompleteVote(pack, `reviewer-b-${familyIndex}`, 200)
      ]);
    });
    const merged = buildMultimodalBlindLabelMerge(adjudications);
    expect(merged.receipt).toMatchObject({ familyCount: 3, queryCount: 60 });
    expect(merged.privateLabels.labels).toHaveLength(60);
    expect(parseMultimodalBlindLabelMergeReceipt(merged.receipt)).toEqual(merged.receipt);

    expect(() => buildMultimodalBlindLabelMerge([adjudications[0], adjudications[0], adjudications[2]])).toThrow(
      /重复使用了同一个媒体家族/
    );
  });
});

function createVote(
  pack: MultimodalBlindReviewPack,
  reviewer: string,
  targetTimestampMs: number,
  boundaryToleranceMs: number
) {
  return buildMultimodalBlindReviewVoteSet(pack, reviewer, [
    {
      taskId: pack.tasks[0].taskId,
      decision: "matched",
      targetTimestampMs,
      boundaryToleranceMs,
      precision: "frameAccurate"
    }
  ]);
}

function createCompleteVote(
  pack: MultimodalBlindReviewPack,
  reviewer: string,
  offsetMs: number
) {
  const answers: MultimodalBlindReviewAnswer[] = pack.tasks.map((task) => ({
    taskId: task.taskId,
    decision: "matched",
    targetTimestampMs: task.candidateSlots[0].timestampMs + offsetMs,
    boundaryToleranceMs: 500,
    precision: "frameAccurate"
  }));
  return buildMultimodalBlindReviewVoteSet(pack, reviewer, answers);
}
