import { describe, expect, it } from "vitest";
import {
  createC137FormalBlindProvenanceFixture,
  resealC137FormalBlindNativeReceiptFixture,
  resealC137FormalBlindProvenanceFixture
} from "../../test/c137FormalBlindProvenance";
import {
  C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT,
  computeC137FormalBlindMatrixPlanDigest,
  createC137FormalBlindMatrixPlan,
  createC137FormalBlindMatrixTileLayout,
  evaluateC137FormalBlindProvenance,
  rankC137FormalBlindGlobalScores,
  sealC137FormalBlindProvenanceV3,
  validateC137FormalBlindProvenance,
  type C137FormalBlindProvenanceV3
} from "./c137FormalBlindProvenance";
import {
  createNativeBatchExecutionIdentityDigest,
  createRealMediaBlindBatchExecutionDigest
} from "./realMediaBlindBatchContract";

// These 17x17 cryptographic receipt fixtures do synchronous work. Vitest 4
// includes synchronous execution in the timeout; ordinary tests keep the default budget.
describe("C137 formal blind exhaustive matrix provenance v3", { timeout: 120_000 }, () => {
  it("validates an exhaustive matrix and derives one global decision per query", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const validation = validateC137FormalBlindProvenance(fixture.provenance);
    const evaluation = evaluateC137FormalBlindProvenance(
      fixture.provenance,
      fixture.expectations
    );

    expect(validation).toMatchObject({ valid: true, issues: [], coverageValid: true });
    expect(evaluation).toEqual(fixture.evaluation);
    expect(evaluation.decisions).toHaveLength(fixture.manifest.cases.length);
    expect(new Set(evaluation.decisions.map((decision) => decision.caseId))).toEqual(
      new Set(fixture.manifest.cases.map((benchmarkCase) => benchmarkCase.id))
    );
    expect(new Set(evaluation.decisions.map((decision) => decision.provenanceRef)).size).toBe(
      fixture.manifest.cases.length
    );
    expect(
      evaluation.decisions.every(
        (decision) =>
          Number.isFinite(decision.top1Score) &&
          Number.isFinite(decision.top2Score) &&
          decision.top1Score >= decision.top2Score &&
          decision.scoreMargin >= 0 &&
          decision.scoreMargin <= 1
      )
    ).toBe(true);
    expect(fixture.provenance.releaseEligible).toBe(false);
  });

  it("deterministically tiles 1×256, 1×257, 1×300 and 17×17 without exceeding 256 pairs", () => {
    expect(createC137FormalBlindMatrixTileLayout(1, 256, 5)).toEqual([
      { queryStart: 0, queryEnd: 1, candidateStart: 0, candidateEnd: 256 }
    ]);
    expect(createC137FormalBlindMatrixTileLayout(1, 257, 5)).toHaveLength(2);
    expect(createC137FormalBlindMatrixTileLayout(1, 300, 5)).toHaveLength(2);
    expect(createC137FormalBlindMatrixTileLayout(17, 17, 5)).toHaveLength(2);

    for (const [queries, candidates] of [
      [1, 257],
      [1, 300],
      [17, 17]
    ] as const) {
      const layout = createC137FormalBlindMatrixTileLayout(queries, candidates, 5);
      const cells = new Set<string>();
      for (const tile of layout) {
        expect(
          (tile.queryEnd - tile.queryStart) * (tile.candidateEnd - tile.candidateStart)
        ).toBeLessThanOrEqual(256);
        for (let query = tile.queryStart; query < tile.queryEnd; query += 1) {
          for (
            let candidate = tile.candidateStart;
            candidate < tile.candidateEnd;
            candidate += 1
          ) {
            const key = `${query}/${candidate}`;
            expect(cells.has(key)).toBe(false);
            cells.add(key);
          }
        }
      }
      expect(cells.size).toBe(queries * candidates);
    }
  });

  it("globally reranks all shard scores so a second-shard candidate can win", () => {
    const ranked = rankC137FormalBlindGlobalScores(
      [
        { candidateOrdinal: 0, pairId: digest("a"), score: 0.72 },
        { candidateOrdinal: 1, pairId: digest("b"), score: 0.71 },
        { candidateOrdinal: 2, pairId: digest("c"), score: 0.99 },
        { candidateOrdinal: 3, pairId: digest("d"), score: 0.73 }
      ],
      2,
      "query-second-shard"
    );

    expect(ranked).toEqual([digest("c"), digest("d")]);
    expect(ranked).not.toEqual([digest("a"), digest("b")]);
  });

  it("uses manifest candidate ordinal as the stable cross-shard tie break", () => {
    const observations = [
      { candidateOrdinal: 3, pairId: digest("d"), score: 0.8 },
      { candidateOrdinal: 1, pairId: digest("b"), score: 0.8 },
      { candidateOrdinal: 2, pairId: digest("c"), score: 0.8 },
      { candidateOrdinal: 0, pairId: digest("a"), score: 0.8 }
    ] as const;
    const forward = rankC137FormalBlindGlobalScores(observations, 3, "tie");
    const reversed = rankC137FormalBlindGlobalScores([...observations].reverse(), 3, "tie");

    expect(forward).toEqual([digest("a"), digest("b"), digest("c")]);
    expect(reversed).toEqual(forward);
  });

  it("fails closed instead of padding Top-K with noEligibleCandidate observations", () => {
    expect(() =>
      rankC137FormalBlindGlobalScores(
        [
          { candidateOrdinal: 0, pairId: digest("a"), score: 0.8 },
          { candidateOrdinal: 1, pairId: digest("b"), score: null },
          { candidateOrdinal: 2, pairId: digest("c"), score: null }
        ],
        2,
        "insufficient"
      )
    ).toThrow(/只有 1 个 intrinsic eligible candidate.*globalTopK=2/);
  });

  it("uses the first physical candidate representative and rejects stream-divergent aliases", () => {
    const alias = createC137FormalBlindProvenanceFixture({
      mutateManifest(manifest) {
        const first = manifest.cases[0];
        const second = manifest.cases[1];
        if (!first || !second) throw new Error("fixture case missing");
        second.target.contentIdentity = structuredClone(first.target.contentIdentity);
      }
    });
    expect(alias.evaluation.valid).toBe(true);
    expect(alias.plan.batches[0]?.candidateCaseIds).toContain("formal-case-1");
    expect(alias.plan.batches[0]?.candidateCaseIds).not.toContain("formal-case-2");

    expect(() =>
      createC137FormalBlindProvenanceFixture({
        mutateManifest(manifest) {
          const first = manifest.cases[0];
          const second = manifest.cases[1];
          if (!first || !second) throw new Error("fixture case missing");
          second.target.contentIdentity = structuredClone(first.target.contentIdentity);
          second.target.audioStreamIndex = first.target.audioStreamIndex + 1;
        }
      })
    ).toThrow(/同一候选物理文件.*不同有效流|声明了不同有效流/);
  });

  it("rejects a missing matrix batch even after caller recomputes public digests", () => {
    const provenance = createFormalProvenance({ caseCount: 17 });
    provenance.plan.batches.pop();
    provenance.batches.pop();
    resealPlanDigest(provenance);

    expect(validateC137FormalBlindProvenance(provenance)).toMatchObject({
      valid: false,
      coverageValid: false,
      decisions: []
    });
    expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
      /唯一 exhaustive query×candidate tile 计划/
    );
  });

  it("rejects a duplicate/renamed matrix cell rather than counting a query twice", () => {
    const provenance = createFormalProvenance({ caseCount: 17 });
    const planReplay = structuredClone(provenance.plan.batches[0]);
    const envelopeReplay = structuredClone(provenance.batches[0]);
    if (!planReplay || !envelopeReplay) throw new Error("fixture batch missing");
    planReplay.batchId = "matrix-batch-replay";
    envelopeReplay.batchId = planReplay.batchId;
    provenance.plan.batches.push(planReplay);
    provenance.batches.push(envelopeReplay);
    resealPlanDigest(provenance);

    expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
      /唯一 exhaustive query×candidate tile 计划|replay|重复/
    );
  });

  it("rejects cross-tile execution parameter drift", () => {
    const provenance = createFormalProvenance({ caseCount: 17 });
    const second = provenance.batches[1];
    if (!second) throw new Error("fixture second batch missing");
    second.executionSuite.parameters.windowMs = 64;
    second.nativeReceipt.executionDigest = createRealMediaBlindBatchExecutionDigest(
      second.executionSuite
    );
    resealC137FormalBlindNativeReceiptFixture(second);
    resealC137FormalBlindProvenanceFixture(provenance);

    expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
      /parameters 必须 exact equal/
    );
  });

  it.each(["ffmpeg", "backend", "fallback"] as const)(
    "rejects resealed cross-tile actual execution identity drift: %s",
    (drift) => {
      const provenance = createFormalProvenance({ caseCount: 17 });
      const second = provenance.batches[1];
      if (!second) throw new Error("fixture second batch missing");
      for (const outcome of second.nativeReceipt.pairOutcomes) {
        const identity = outcome.relationRanking.executionIdentity;
        if (!identity) throw new Error("fixture execution identity missing");
        if (drift === "ffmpeg") {
          identity.ffmpegBinaryDigest = `sha256:${"e".repeat(64)}`;
        } else if (drift === "backend") {
          const sourceBackend = identity.sourceSpectralBackends[0];
          if (!sourceBackend) throw new Error("fixture source backend missing");
          sourceBackend.backendId = "cpu-radix2-f64-r2c-512-v1";
          sourceBackend.requestedBackend = "cpu";
          sourceBackend.backendDetail = "test CPU";
        } else {
          const sourceBackend = identity.sourceSpectralBackends[0];
          if (!sourceBackend) throw new Error("fixture source backend missing");
          sourceBackend.requestedBackend = "auto";
          sourceBackend.fallbackReason = "CUDA runtime failure; explicit CPU fallback";
        }
        outcome.relationRanking.executionIdentityDigest =
          createNativeBatchExecutionIdentityDigest(identity);
      }
      second.nativeReceipt.executionIdentityDigest =
        second.nativeReceipt.pairOutcomes[0]?.relationRanking.executionIdentityDigest ?? null;
      resealC137FormalBlindNativeReceiptFixture(second);
      resealC137FormalBlindProvenanceFixture(provenance);

      expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
        /execution identity|executionIdentityDigest/
      );
    }
  );

  it.each(["relationshipAxis", "visualEvidenceEnabled", "globalTopK"] as const)(
    "rejects resealed plan-root %s drift from its projections",
    (field) => {
      const provenance = createFormalProvenance();
      if (field === "relationshipAxis") provenance.plan.relationshipAxis = "target";
      if (field === "visualEvidenceEnabled") provenance.plan.visualEvidenceEnabled = true;
      if (field === "globalTopK") provenance.plan.globalTopK = 3;
      resealPlanDigest(provenance);

      expect(validateC137FormalBlindProvenance(provenance).valid).toBe(false);
    }
  );

  it("rejects relation score version drift and native receipt tampering", () => {
    const scoreDrift = createFormalProvenance();
    const firstOutcome = scoreDrift.batches[0]?.nativeReceipt.pairOutcomes[0];
    if (!firstOutcome) throw new Error("fixture outcome missing");
    (firstOutcome.relationRanking as { scoreVersion: string }).scoreVersion =
      "alignment-v2-wrong-score";
    resealC137FormalBlindProvenanceFixture(scoreDrift);
    expect(validateC137FormalBlindProvenance(scoreDrift).issues.join("\n")).toMatch(
      /scoreVersion/
    );

    const receiptTamper = createFormalProvenance();
    const firstBatch = receiptTamper.batches[0];
    if (!firstBatch) throw new Error("fixture batch missing");
    firstBatch.nativeReceipt.receiptDigest = digest("0");
    resealC137FormalBlindProvenanceFixture(receiptTamper);
    expect(validateC137FormalBlindProvenance(receiptTamper).issues.join("\n")).toMatch(
      /receiptDigest/
    );
  });

  it("rejects nativeJobId replay across otherwise distinct tiles", () => {
    const provenance = createFormalProvenance({ caseCount: 17 });
    const first = provenance.batches[0];
    const second = provenance.batches[1];
    if (!first || !second) throw new Error("fixture batch missing");
    second.nativeReceipt.nativeJobId = first.nativeReceipt.nativeJobId;
    resealC137FormalBlindNativeReceiptFixture(second);
    resealC137FormalBlindProvenanceFixture(provenance);

    expect(validateC137FormalBlindProvenance(provenance).issues.join("\n")).toMatch(
      /nativeJobId replay/
    );
  });

  it("seal is atomic and refuses a non-unique plan", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const sealed = sealC137FormalBlindProvenanceV3({
      manifest: fixture.manifest,
      plan: fixture.plan,
      batches: fixture.provenance.batches
    });
    expect(sealed).toEqual(fixture.provenance);

    const badPlan = structuredClone(fixture.plan);
    badPlan.scoreContract = C137_FORMAL_BLIND_MATRIX_SCORE_CONTRACT;
    badPlan.batches.pop();
    badPlan.planDigest = computeC137FormalBlindMatrixPlanDigest(badPlan);
    expect(() =>
      sealC137FormalBlindProvenanceV3({
        manifest: fixture.manifest,
        plan: badPlan,
        batches: fixture.provenance.batches.slice(0, -1)
      })
    ).toThrow(/非唯一、非 exhaustive/);
  });

  it("plan generation is deterministic", () => {
    const fixture = createC137FormalBlindProvenanceFixture({ caseCount: 17 });
    const regenerated = createC137FormalBlindMatrixPlan(
      fixture.manifest,
      fixture.provenance.manifestDigest,
      {
        relationshipAxis: fixture.plan.relationshipAxis,
        visualEvidenceEnabled: fixture.plan.visualEvidenceEnabled,
        globalTopK: fixture.plan.globalTopK,
        scoreContract: fixture.plan.scoreContract
      }
    );
    expect(regenerated).toEqual(fixture.plan);
  });
});

function createFormalProvenance(
  options: Parameters<typeof createC137FormalBlindProvenanceFixture>[0] = {}
): C137FormalBlindProvenanceV3 {
  return createC137FormalBlindProvenanceFixture(options).provenance;
}

function resealPlanDigest(provenance: C137FormalBlindProvenanceV3): void {
  provenance.plan.planDigest = computeC137FormalBlindMatrixPlanDigest(provenance.plan);
  resealC137FormalBlindProvenanceFixture(provenance);
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64).slice(0, 64)}`;
}
