import { describe, expect, it } from "vitest";
import crossLanguageVector from "../../../ml/contracts/alignment-multimodal-blind-review-cross-language-vector-v1.json";
import {
  buildMultimodalBlindReviewVoteSet,
  createMultimodalBlindReviewerDigest,
  parseMultimodalBlindReviewPack,
  sha256Json,
  type MultimodalBlindReviewAnswer
} from "./multimodalBlindReview";
import {
  createMultimodalBlindReviewPackFixture as createPack,
  createRealAlignmentBlindReviewPackFixture
} from "../../test/multimodalBlindReviewFixture";

describe("multimodal blind review contract", () => {
  it("accepts a strict identity-bound pack and rejects tampering", () => {
    const pack = createPack();
    expect(parseMultimodalBlindReviewPack(pack)).toEqual(pack);

    const tampered = structuredClone(pack);
    tampered.tasks[0].candidateSlots[0].timestampMs += 1;
    expect(() => parseMultimodalBlindReviewPack(tampered)).toThrow(/身份不一致/);
  });

  it("accepts a real-run v2 pack without pretending its selector is multimodal consensus", () => {
    const pack = createRealAlignmentBlindReviewPackFixture();
    expect(parseMultimodalBlindReviewPack(pack)).toEqual(pack);
    const tampered = structuredClone(pack);
    tampered.provenance.pairOrdinal = 2;
    expect(() => parseMultimodalBlindReviewPack(tampered)).toThrow(/身份不一致/);
  });

  it("matches the Python reviewer digest vector and never writes the raw id", () => {
    expect(createMultimodalBlindReviewerDigest(" reviewer-a ")).toBe(
      "sha256:2f277341c28162f87d35c6be6e33dc751425c1d76cb2bee4fb6d1e2e0fdac7c7"
    );
    const pack = createPack();
    const voteSet = buildMultimodalBlindReviewVoteSet(pack, "reviewer-a", [
      {
        taskId: pack.tasks[0].taskId,
        decision: "matched",
        targetTimestampMs: 12_000,
        boundaryToleranceMs: 500,
        precision: "frameAccurate"
      }
    ]);
    expect(voteSet.votes).toHaveLength(1);
    expect(voteSet.votes[0]).toMatchObject({
      queryKey: pack.tasks[0].queryKey,
      precision: "frameAccurate"
    });
    expect(JSON.stringify(voteSet)).not.toContain("reviewer-a");
    expect(voteSet.voteSetId).toBe(
      sha256Json({
        schemaVersion: voteSet.schemaVersion,
        packId: voteSet.packId,
        reviewerIdDigest: voteSet.reviewerIdDigest,
        votes: voteSet.votes,
        permission: voteSet.permission,
        releaseEligible: false
      })
    );
  });

  it("matches the complete Python pack and vote fixed vector", () => {
    const pack = parseMultimodalBlindReviewPack(crossLanguageVector.pack);
    const voteSet = buildMultimodalBlindReviewVoteSet(
      pack,
      crossLanguageVector.reviewerId,
      crossLanguageVector.answers as MultimodalBlindReviewAnswer[]
    );
    expect(voteSet).toEqual(crossLanguageVector.expectedVoteSet);
  });

  it("keeps missing rows unreviewed and prevents false frame-accurate Gold input", () => {
    const pack = createPack();
    const empty = buildMultimodalBlindReviewVoteSet(pack, "reviewer-a", []);
    expect(empty.votes[0]).toMatchObject({
      decision: "unreviewed",
      targetTimestampMs: null,
      boundaryToleranceMs: null,
      precision: null
    });
    expect(() =>
      buildMultimodalBlindReviewVoteSet(pack, "reviewer-a", [
        {
          taskId: pack.tasks[0].taskId,
          decision: "matched",
          targetTimestampMs: 12_000,
          boundaryToleranceMs: 1_001,
          precision: "frameAccurate"
        }
      ])
    ).toThrow(/不能超过 1 秒/);
  });
});
