import { describe, expect, it } from "vitest";

import {
  compileC137BlindBatchBenchmarkEvidence,
  computeC137BlindBatchBenchmarkEvidenceDigest,
  computeC137BlindBatchProjectionDigest,
  createC137BlindBatchExecutionProjection,
  createC137BlindBatchMediaBindingCommitment,
  deriveC137BlindBatchRelationshipDecisions,
  sealC137BlindBatchRawPrediction,
  validateC137BlindBatchBenchmarkEvidence,
  type C137BlindBatchBenchmarkEvidence,
  type C137BlindBatchExecutionProjection,
  type C137BlindBatchProjectionOptions,
  type C137BlindBatchRawPrediction,
  type C137BlindBatchRawPredictionDraft
} from "./c137BlindBatchEvidence";
import type {
  RealMediaBenchmarkCase,
  RealMediaBenchmarkGold,
  RealMediaBenchmarkManifest,
  RealMediaBenchmarkMediaInput
} from "./realMediaBenchmark";

const OPTIONS = {
  relationshipAxis: "target",
  visualEvidenceEnabled: false,
  topK: 2
} as const;
const EXECUTION_DIGEST = `sha256:${"e".repeat(64)}` as const;
const NATIVE_RECEIPT_DIGEST = `sha256:${"f".repeat(64)}` as const;

describe("C137 blind cross-media relationship evidence", () => {
  it("slices only the query axis while retaining a predeclared candidate universe", () => {
    const manifest = createManifestWithCaseCount(5);
    const decisionCaseIds = [manifest.cases[0].id];
    const candidateCaseIds = manifest.cases.map((benchmarkCase) => benchmarkCase.id);

    const sourceAxis = createC137BlindBatchExecutionProjection(manifest, {
      relationshipAxis: "source",
      visualEvidenceEnabled: false,
      topK: 2,
      caseIds: decisionCaseIds,
      candidateCaseIds
    });
    expect(sourceAxis.sources).toHaveLength(1);
    expect(sourceAxis.targets).toHaveLength(5);
    expect(sourceAxis.pairs).toHaveLength(5);

    const targetAxis = createC137BlindBatchExecutionProjection(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      caseIds: decisionCaseIds,
      candidateCaseIds
    });
    expect(targetAxis.sources).toHaveLength(5);
    expect(targetAxis.targets).toHaveLength(1);
    expect(targetAxis.pairs).toHaveLength(5);
    expect(targetAxis.suiteId).not.toBe(sourceAxis.suiteId);

    const legacySubset = createC137BlindBatchExecutionProjection(manifest, {
      ...OPTIONS,
      caseIds: candidateCaseIds.slice(0, 3)
    });
    expect(legacySubset.sources).toHaveLength(3);
    expect(legacySubset.targets).toHaveLength(3);

    const partialCandidateShardOptions = {
      ...OPTIONS,
      caseIds: decisionCaseIds,
      candidateCaseIds: candidateCaseIds.slice(1)
    } as const;
    const partialCandidateShard = createC137BlindBatchExecutionProjection(
      manifest,
      partialCandidateShardOptions
    );
    expect(partialCandidateShard.sources).toHaveLength(4);
    expect(partialCandidateShard.targets).toHaveLength(1);
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        partialCandidateShardOptions,
        partialCandidateShard,
        createGoldFreeRawPrediction(partialCandidateShard)
      )
    ).toThrow(/partial shard 不得单独揭示或编译准确率/);
    expect(() =>
      createC137BlindBatchExecutionProjection(manifest, {
        ...OPTIONS,
        caseIds: decisionCaseIds,
        candidateCaseIds: [...candidateCaseIds].reverse()
      })
    ).toThrow(/必须保持冻结 manifest 顺序/);
  });

  it("projects a 3×3 path-free batch and labels self-consistent component evidence honestly", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);

    expect(projection).toMatchObject({
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2
    });
    expect(projection.sources).toHaveLength(3);
    expect(projection.targets).toHaveLength(3);
    expect(projection.pairs).toHaveLength(9);
    expect(
      [...projection.sources, ...projection.targets].every((media) =>
        /^sha256:[a-f0-9]{64}$/.test(media.bindingCommitment)
      )
    ).toBe(true);

    const projectionJson = JSON.stringify(projection);
    const rawJson = JSON.stringify(raw);
    for (const forbidden of [
      "C:\\\\frozen-suite",
      "blind-case-1",
      "blind-case-2",
      "blind-case-3",
      "frozen-test",
      "matchedAnchors",
      "reviewer-alpha"
    ]) {
      expect(projectionJson).not.toContain(forbidden);
      expect(rawJson).not.toContain(forbidden);
    }
    for (const media of allMedia(manifest)) {
      expect(projectionJson).not.toContain(media.contentIdentity?.digest);
      expect(rawJson).not.toContain(media.contentIdentity?.digest);
    }

    const evidence = compileC137BlindBatchBenchmarkEvidence(manifest, OPTIONS, projection, raw);

    expect(evidence).toMatchObject({
      scope: "cross-media-relationship-and-known-pair-anchor-component",
      releaseEligible: false,
      trustStatus: "untrusted-self-consistent-evidence",
      executionDigest: EXECUTION_DIGEST,
      nativeReceiptDigest: NATIVE_RECEIPT_DIGEST,
      decisionCount: 3,
      top1HitCount: 3,
      topKHitCount: 3,
      top1Accuracy: 1,
      topKAccuracy: 1,
      shortlistedGoldPairCount: 3,
      top1WrongRelationshipCount: 0,
      knownPairMappedAnchorCount: 15,
      knownPairUnmappedAnchorCount: 0,
      knownPairAnchorCoverage: 1,
      knownPairMappedAnchorError: {
        sampleCount: 15,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0
      }
    });
    const evidenceJson = JSON.stringify(evidence);
    for (const benchmarkCase of manifest.cases) {
      expect(evidenceJson).not.toContain(benchmarkCase.id);
    }
    for (const pair of projection.pairs) {
      expect(evidenceJson).not.toContain(pair.pairId);
    }
    for (const media of [...projection.sources, ...projection.targets]) {
      expect(evidenceJson).not.toContain(media.mediaId);
      expect(evidenceJson).not.toContain(media.bindingCommitment);
    }
    expect(
      validateC137BlindBatchBenchmarkEvidence(manifest, OPTIONS, projection, raw, evidence)
    ).toEqual({ valid: true, issues: [] });
  });

  it("derives private per-case gold and declared-axis Top-K without caller hit fields", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);

    const decisions = deriveC137BlindBatchRelationshipDecisions(
      manifest,
      OPTIONS,
      projection,
      raw
    );

    expect(decisions).toHaveLength(manifest.cases.length);
    expect(new Set(decisions.map((decision) => decision.provenanceRef)).size).toBe(
      manifest.cases.length
    );
    decisions.forEach((decision, index) => {
      const benchmarkCase = manifest.cases[index];
      const goldPair = goldPairForCase(manifest, projection, benchmarkCase);
      const ranking = raw.targetRankings.find(
        (item) => item.targetMediaId === goldPair.targetMediaId
      );
      const { provenanceRef, ...decisionWithoutProvenanceRef } = decision;
      expect(provenanceRef).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(decisionWithoutProvenanceRef).toEqual({
        suiteId: projection.suiteId,
        caseId: benchmarkCase.id,
        goldPairId: goldPair.pairId,
        rankedPairIds: ranking?.rankedPairIds.slice(0, OPTIONS.topK)
      });
    });
    expect(
      deriveC137BlindBatchRelationshipDecisions(manifest, OPTIONS, projection, raw)
    ).toEqual(decisions);
    expect(() =>
      deriveC137BlindBatchRelationshipDecisions(
        manifest,
        { ...OPTIONS, relationshipAxis: "source" },
        projection,
        raw
      )
    ).toThrow(/唯一 gold-free 投影不一致/);
  });

  it("does not encode manifest order or gold pair diagonal in media IDs", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);

    const reversedCases = structuredClone(manifest);
    reversedCases.cases.reverse();
    const reversedProjection = createC137BlindBatchExecutionProjection(reversedCases, OPTIONS);
    expect(reversedProjection.sources).toEqual(projection.sources);
    expect(reversedProjection.targets).toEqual(projection.targets);
    expect(reversedProjection.pairs).toEqual(projection.pairs);

    const changedGoldPairing = structuredClone(manifest);
    [changedGoldPairing.cases[0].target, changedGoldPairing.cases[1].target] = [
      changedGoldPairing.cases[1].target,
      changedGoldPairing.cases[0].target
    ];
    expect(createC137BlindBatchExecutionProjection(changedGoldPairing, OPTIONS)).toEqual(
      projection
    );
  });

  it("treats video-only media views as distinct only when visual evidence is enabled", () => {
    const manifest = createVisualViewManifest();
    const hiddenVideoOptions = { ...OPTIONS, visualEvidenceEnabled: false } as const;
    const visibleVideoOptions = { ...OPTIONS, visualEvidenceEnabled: true } as const;

    const hiddenProjection = createC137BlindBatchExecutionProjection(
      manifest,
      hiddenVideoOptions
    );
    expect(hiddenProjection.sources).toHaveLength(2);
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        hiddenVideoOptions,
        hiddenProjection,
        createPerfectRawPrediction(manifest, hiddenProjection)
      )
    ).toThrow(/partial candidate shard 只能交给 exhaustive matrix aggregator/);

    const projection = createC137BlindBatchExecutionProjection(manifest, visibleVideoOptions);
    const firstView = manifest.cases[1].source;
    const secondView = manifest.cases[2].source;
    const hiddenFirstCommitment = createC137BlindBatchMediaBindingCommitment(
      manifest.id,
      manifest.datasetVersion,
      "source",
      false,
      firstView
    );
    const hiddenSecondCommitment = createC137BlindBatchMediaBindingCommitment(
      manifest.id,
      manifest.datasetVersion,
      "source",
      false,
      secondView
    );
    const visibleCommitments = [firstView, secondView].map((media) =>
      createC137BlindBatchMediaBindingCommitment(
        manifest.id,
        manifest.datasetVersion,
        "source",
        true,
        media
      )
    );

    expect(hiddenFirstCommitment).toBe(hiddenSecondCommitment);
    expect([...new Set(visibleCommitments)]).toHaveLength(2);
    expect(projection).toMatchObject({
      visualEvidenceEnabled: true,
      topK: 2
    });
    expect(projection.sources).toHaveLength(3);
    expect(
      projection.sources
        .filter((media) => visibleCommitments.includes(media.bindingCommitment))
        .map((media) => media.videoStreamIndex)
        .sort()
    ).toEqual([0, 1]);
    const unchangedManifest = createManifest();
    const audioOnlyProjection = createC137BlindBatchExecutionProjection(
      unchangedManifest,
      hiddenVideoOptions
    );
    const visualProjection = createC137BlindBatchExecutionProjection(
      unchangedManifest,
      visibleVideoOptions
    );
    expect(visualProjection.suiteId).not.toBe(audioOnlyProjection.suiteId);
    expect(visualProjection.projectionDigest).not.toBe(audioOnlyProjection.projectionDigest);
  });

  it("recomputes Top-1 wrong relationship separately from Top-K and native shortlist", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);
    const wrong = structuredClone(raw);
    const benchmarkCase = manifest.cases[1];
    const goldPair = goldPairForCase(manifest, projection, benchmarkCase);
    const ranking = wrong.targetRankings.find(
      (item) => item.targetMediaId === goldPair.targetMediaId
    );
    if (!ranking) throw new Error("fixture target ranking missing");
    const wrongPairId = ranking.rankedPairIds.find((pairId) => pairId !== goldPair.pairId);
    if (!wrongPairId) throw new Error("fixture wrong pair missing");
    ranking.rankedPairIds = [
      wrongPairId,
      goldPair.pairId,
      ...ranking.rankedPairIds.filter(
        (pairId) => pairId !== wrongPairId && pairId !== goldPair.pairId
      )
    ];
    replaceShortlistedPair(wrong, projection, goldPair.pairId, wrongPairId);
    requireOutcome(wrong, goldPair.pairId).status = "blocked";
    requireOutcome(wrong, wrongPairId).status = "candidate";

    const evidence = compileC137BlindBatchBenchmarkEvidence(
      manifest,
      OPTIONS,
      projection,
      resealRawPrediction(wrong)
    );

    expect(evidence).toMatchObject({
      top1HitCount: 2,
      topKHitCount: 3,
      top1Accuracy: 2 / 3,
      topKAccuracy: 1,
      shortlistedGoldPairCount: 2,
      top1WrongRelationshipCount: 1
    });
  });

  it("keeps native shortlist membership separate from relationship truth", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);
    const expanded = structuredClone(raw);
    const extraPairId = projection.pairs.find(
      (pair) => !expanded.nativeShortlist.shortlistedPairIds.includes(pair.pairId)
    )?.pairId;
    if (!extraPairId) throw new Error("fixture extra pair missing");
    setShortlist(expanded, projection, [
      ...expanded.nativeShortlist.shortlistedPairIds,
      extraPairId
    ]);

    const evidence = compileC137BlindBatchBenchmarkEvidence(
      manifest,
      OPTIONS,
      projection,
      resealRawPrediction(expanded)
    );
    expect(evidence).toMatchObject({
      top1HitCount: 3,
      shortlistedGoldPairCount: 3,
      top1WrongRelationshipCount: 0
    });
  });

  it("derives mapped-anchor p50/p95/p99 and coverage instead of accepting errors", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);
    const delayed = structuredClone(raw);
    const benchmarkCase = manifest.cases[1];
    const goldPair = goldPairForCase(manifest, projection, benchmarkCase);
    requireOutcome(delayed, goldPair.pairId).proposalTimeMapSpans = [matched(250)];

    const evidence = compileC137BlindBatchBenchmarkEvidence(
      manifest,
      OPTIONS,
      projection,
      resealRawPrediction(delayed)
    );
    expect(evidence.knownPairMappedAnchorError).toEqual({
      sampleCount: 15,
      p50Ms: 0,
      p95Ms: 250,
      p99Ms: 250,
      maxMs: 250
    });
  });

  it("treats every anchor as unmapped for a blocked gold pair even when spans remain", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);
    const blocked = structuredClone(raw);
    const benchmarkCase = manifest.cases[1];
    const goldPair = goldPairForCase(manifest, projection, benchmarkCase);
    const outcome = requireOutcome(blocked, goldPair.pairId);
    outcome.status = "blocked";
    outcome.proposalTimeMapSpans = [matched(250)];
    setShortlist(
      blocked,
      projection,
      blocked.nativeShortlist.shortlistedPairIds.filter((pairId) => pairId !== goldPair.pairId)
    );

    const evidence = compileC137BlindBatchBenchmarkEvidence(
      manifest,
      OPTIONS,
      projection,
      resealRawPrediction(blocked)
    );
    expect(evidence).toMatchObject({
      shortlistedGoldPairCount: 2,
      knownPairMappedAnchorCount: 10,
      knownPairUnmappedAnchorCount: 5,
      knownPairAnchorCoverage: 2 / 3
    });
  });

  it("rejects projection replay, order/digest tampering and malformed candidates", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);

    const leakedProjection = structuredClone(projection) as unknown as Record<string, unknown>;
    leakedProjection.gold = { expectedPairId: projection.pairs[0].pairId };
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(manifest, OPTIONS, leakedProjection, raw)
    ).toThrow(/未知或缺失字段/);

    const replayed = structuredClone(raw);
    replayed.projectionDigest = `sha256:${"a".repeat(64)}`;
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        OPTIONS,
        projection,
        resealRawPrediction(replayed)
      )
    ).toThrow(/suite\/projection\/topK/);

    const reorderedProjection = structuredClone(projection);
    [reorderedProjection.pairs[0], reorderedProjection.pairs[1]] = [
      reorderedProjection.pairs[1],
      reorderedProjection.pairs[0]
    ];
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        OPTIONS,
        resealProjection(reorderedProjection),
        raw
      )
    ).toThrow(/唯一 gold-free 投影不一致/);

    const staleDigest = structuredClone(raw);
    staleDigest.targetRankings[0].rankedPairIds.reverse();
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(manifest, OPTIONS, projection, staleDigest)
    ).toThrow(/receiptDigest/);

    const reorderedShortlist = structuredClone(raw);
    reorderedShortlist.nativeShortlist.shortlistedPairIds.reverse();
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        OPTIONS,
        projection,
        resealRawPrediction(reorderedShortlist)
      )
    ).toThrow(/分别保持 execution projection 顺序/);

    const missingPair = structuredClone(raw);
    missingPair.pairOutcomes.pop();
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        OPTIONS,
        projection,
        resealRawPrediction(missingPair)
      )
    ).toThrow(/数量不完整/);

    const duplicateCandidate = structuredClone(raw);
    duplicateCandidate.targetRankings[0].rankedPairIds[1] =
      duplicateCandidate.targetRankings[0].rankedPairIds[0];
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        OPTIONS,
        projection,
        resealRawPrediction(duplicateCandidate)
      )
    ).toThrow(/全部候选 pair，且不得重复/);

    const candidateOutsideShortlist = structuredClone(raw);
    const blockedOutcome = candidateOutsideShortlist.pairOutcomes.find(
      (outcome) => outcome.status === "blocked"
    );
    if (!blockedOutcome) throw new Error("fixture blocked outcome missing");
    blockedOutcome.status = "candidate";
    expect(() => resealRawPrediction(candidateOutsideShortlist)).toThrow(/native shortlist/);

    const candidateWithoutMatched = structuredClone(raw);
    const candidateOutcome = candidateWithoutMatched.pairOutcomes.find(
      (outcome) => outcome.status === "candidate"
    );
    if (!candidateOutcome) throw new Error("fixture candidate outcome missing");
    candidateOutcome.proposalTimeMapSpans = [{ ...matched(0), kind: "ambiguous" }];
    expect(() => resealRawPrediction(candidateWithoutMatched)).toThrow(/matched span/);
  });

  it("rejects hand-filled errors even if evidence is re-signed", () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, OPTIONS);
    const raw = createPerfectRawPrediction(manifest, projection);
    const dirtyRaw = structuredClone(raw) as unknown as {
      pairOutcomes: Array<Record<string, unknown>>;
    };
    dirtyRaw.pairOutcomes[0].anchorErrorsMs = [0];
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(manifest, OPTIONS, projection, dirtyRaw)
    ).toThrow(/手填 errors/);

    const evidence = compileC137BlindBatchBenchmarkEvidence(manifest, OPTIONS, projection, raw);
    const tampered = structuredClone(evidence);
    tampered.knownPairMappedAnchorError.p95Ms = 9_999;
    const validation = validateC137BlindBatchBenchmarkEvidence(
      manifest,
      OPTIONS,
      projection,
      raw,
      resealEvidence(tampered)
    );
    expect(validation.valid).toBe(false);
    expect(validation.issues.join(" ")).toMatch(/确定性重算/);
  });

  it("rejects inferred axes, duplicate query media, and non-discriminating Top-K", () => {
    const manifest = createManifest();
    expect(() =>
      createC137BlindBatchExecutionProjection(manifest, {
        topK: 2
      } as unknown as C137BlindBatchProjectionOptions)
    ).toThrow(/禁止从 gold 推断/);

    const duplicateQuery = structuredClone(manifest);
    duplicateQuery.cases[2].target = structuredClone(duplicateQuery.cases[1].target);
    expect(() => createC137BlindBatchExecutionProjection(duplicateQuery, OPTIONS)).toThrow(
      /query media 唯一/
    );

    const nonDiscriminatingOptions = {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 3
    } as const;
    const nonDiscriminatingProjection = createC137BlindBatchExecutionProjection(
      manifest,
      nonDiscriminatingOptions
    );
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        manifest,
        nonDiscriminatingOptions,
        nonDiscriminatingProjection,
        createPerfectRawPrediction(manifest, nonDiscriminatingProjection)
      )
    ).toThrow(/严格大于 topK/);

    const singleCandidate = structuredClone(manifest);
    for (const benchmarkCase of singleCandidate.cases.slice(1)) {
      benchmarkCase.source = structuredClone(singleCandidate.cases[0].source);
    }
    const singleCandidateProjection = createC137BlindBatchExecutionProjection(
      singleCandidate,
      OPTIONS
    );
    expect(() =>
      compileC137BlindBatchBenchmarkEvidence(
        singleCandidate,
        OPTIONS,
        singleCandidateProjection,
        createPerfectRawPrediction(singleCandidate, singleCandidateProjection)
      )
    ).toThrow(/严格大于 topK/);

    const singlePair = structuredClone(manifest);
    singlePair.cases = singlePair.cases.slice(0, 1);
    expect(() => createC137BlindBatchExecutionProjection(singlePair, OPTIONS)).toThrow(
      /单 pair 不能冒充 batch/
    );
  });

  it("rejects a 17×17 Cartesian suite at the compiler boundary", () => {
    const oversizedCartesian = createManifestWithCaseCount(17);
    expect(() => createC137BlindBatchExecutionProjection(oversizedCartesian, OPTIONS)).toThrow(
      /超过 256 pair/
    );
  });

  it("requires explicit video streams for every formal visual benchmark input", () => {
    const manifest = createManifest();
    const missingVisualStream = structuredClone(manifest);
    missingVisualStream.cases[0].source.videoStreamIndex = null;
    expect(() =>
      createC137BlindBatchExecutionProjection(missingVisualStream, {
        ...OPTIONS,
        visualEvidenceEnabled: true
      })
    ).toThrow(/禁止 null\/auto/);
  });
});

function createManifest(): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id: "blind-batch-unit-suite",
    name: "盲测批量证据单元测试",
    datasetVersion: "frozen-unit-v1",
    description: "程序构造的冻结 manifest，只验证证据边界。",
    isExample: false,
    licenseNotes: ["不包含真实媒体内容。"],
    cases: [createCase(1), createCase(2), createCase(3)]
  };
}

function createManifestWithCaseCount(caseCount: number): RealMediaBenchmarkManifest {
  const manifest = createManifest();
  manifest.cases = Array.from({ length: caseCount }, (_, index) => createCase(index + 1));
  return manifest;
}

function createVisualViewManifest(): RealMediaBenchmarkManifest {
  const manifest = createManifest();
  const visualView = structuredClone(manifest.cases[1].source);
  visualView.path = "C:\\frozen-suite\\source-2-visual-view.mkv";
  visualView.videoStreamIndex = 1;
  visualView.versionNote = "source-2 第二视频流视图";
  manifest.cases[2].source = visualView;
  return manifest;
}

function createCase(index: number): RealMediaBenchmarkCase {
  const gold = createGold(index);
  return {
    id: `blind-case-${index}`,
    title: `冻结关系 ${index}`,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: ["global-offset"],
    source: createMedia("source", index),
    target: createMedia("target", index),
    boundaryToleranceMs: 100,
    versionNotes: [`关系 ${index} 的程序构造版本。`],
    licenseNotes: ["不包含真实媒体内容。"],
    independentAnnotations: [
      { reviewerId: `reviewer-alpha-${index}`, gold: structuredClone(gold) },
      { reviewerId: `reviewer-beta-${index}`, gold: structuredClone(gold) }
    ],
    adjudication: {
      status: "not-needed",
      adjudicatorId: null,
      note: "两份独立标注在边界容差内完全一致。"
    },
    gold
  };
}

function createMedia(side: "source" | "target", index: number): RealMediaBenchmarkMediaInput {
  const digestByte = side === "source" ? index : index + 64;
  return {
    path: `C:\\frozen-suite\\${side}-${index}.mkv`,
    audioStreamIndex: side === "source" ? index - 1 : index + 2,
    videoStreamIndex: 0,
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: side === "source" ? 1_000 + index : 2_000 + index,
      digest: digestByte.toString(16).padStart(2, "0").repeat(32)
    },
    versionNote: `${side} ${index} 的冻结版本。`,
    licenseNote: "程序构造路径，不对应本地文件。"
  };
}

function createGold(index: number): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    matchedAnchors: [1_000, 13_000, 25_000, 37_000, 49_000].map((timeMs, anchorIndex) => ({
      id: `case-${index}-anchor-${anchorIndex}`,
      sourceMs: timeMs,
      targetMs: timeMs
    })),
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function createPerfectRawPrediction(
  manifest: RealMediaBenchmarkManifest,
  projection: C137BlindBatchExecutionProjection
): C137BlindBatchRawPrediction {
  const goldPairIds = manifest.cases.map(
    (benchmarkCase) => goldPairForCase(manifest, projection, benchmarkCase).pairId
  );
  const goldSet = new Set(goldPairIds);
  const goldBySource = new Map(
    manifest.cases.map((benchmarkCase) => {
      const pair = goldPairForCase(manifest, projection, benchmarkCase);
      return [pair.sourceMediaId, pair.pairId];
    })
  );
  const goldByTarget = new Map(
    manifest.cases.map((benchmarkCase) => {
      const pair = goldPairForCase(manifest, projection, benchmarkCase);
      return [pair.targetMediaId, pair.pairId];
    })
  );
  return sealC137BlindBatchRawPrediction({
    schemaVersion: 1,
    kind: "c137-blind-batch-raw-prediction",
    suiteId: projection.suiteId,
    projectionDigest: projection.projectionDigest,
    executionDigest: EXECUTION_DIGEST,
    nativeReceiptDigest: NATIVE_RECEIPT_DIGEST,
    topK: projection.topK,
    pairOutcomes: projection.pairs.map((pair) => ({
      ...pair,
      status: goldSet.has(pair.pairId) ? "candidate" : "blocked",
      proposalTimeMapSpans: [matched(0)]
    })),
    sourceRankings: projection.sources.map((source) => ({
      sourceMediaId: source.mediaId,
      rankedPairIds: rankGoldFirst(
        projection.pairs
          .filter((pair) => pair.sourceMediaId === source.mediaId)
          .map((pair) => pair.pairId),
        goldBySource.get(source.mediaId)
      )
    })),
    targetRankings: projection.targets.map((target) => ({
      targetMediaId: target.mediaId,
      rankedPairIds: rankGoldFirst(
        projection.pairs
          .filter((pair) => pair.targetMediaId === target.mediaId)
          .map((pair) => pair.pairId),
        goldByTarget.get(target.mediaId)
      )
    })),
    nativeShortlist: {
      shortlistedPairIds: projection.pairs
        .map((pair) => pair.pairId)
        .filter((pairId) => goldSet.has(pairId)),
      nonShortlistedPairIds: projection.pairs
        .map((pair) => pair.pairId)
        .filter((pairId) => !goldSet.has(pairId))
    }
  });
}

function createGoldFreeRawPrediction(
  projection: C137BlindBatchExecutionProjection
): C137BlindBatchRawPrediction {
  return sealC137BlindBatchRawPrediction({
    schemaVersion: 1,
    kind: "c137-blind-batch-raw-prediction",
    suiteId: projection.suiteId,
    projectionDigest: projection.projectionDigest,
    executionDigest: EXECUTION_DIGEST,
    nativeReceiptDigest: NATIVE_RECEIPT_DIGEST,
    topK: projection.topK,
    pairOutcomes: projection.pairs.map((pair) => ({
      ...pair,
      status: "blocked",
      proposalTimeMapSpans: []
    })),
    sourceRankings: projection.sources.map((source) => ({
      sourceMediaId: source.mediaId,
      rankedPairIds: projection.pairs
        .filter((pair) => pair.sourceMediaId === source.mediaId)
        .map((pair) => pair.pairId)
    })),
    targetRankings: projection.targets.map((target) => ({
      targetMediaId: target.mediaId,
      rankedPairIds: projection.pairs
        .filter((pair) => pair.targetMediaId === target.mediaId)
        .map((pair) => pair.pairId)
    })),
    nativeShortlist: {
      shortlistedPairIds: [],
      nonShortlistedPairIds: projection.pairs.map((pair) => pair.pairId)
    }
  });
}

function goldPairForCase(
  manifest: RealMediaBenchmarkManifest,
  projection: C137BlindBatchExecutionProjection,
  benchmarkCase: RealMediaBenchmarkCase
) {
  const sourceCommitment = createC137BlindBatchMediaBindingCommitment(
    manifest.id,
    manifest.datasetVersion,
    "source",
    projection.visualEvidenceEnabled,
    benchmarkCase.source
  );
  const targetCommitment = createC137BlindBatchMediaBindingCommitment(
    manifest.id,
    manifest.datasetVersion,
    "target",
    projection.visualEvidenceEnabled,
    benchmarkCase.target
  );
  const source = projection.sources.find(
    (media) => media.bindingCommitment === sourceCommitment
  );
  const target = projection.targets.find(
    (media) => media.bindingCommitment === targetCommitment
  );
  const pair = projection.pairs.find(
    (candidate) =>
      candidate.sourceMediaId === source?.mediaId && candidate.targetMediaId === target?.mediaId
  );
  if (!pair) throw new Error("fixture gold pair missing");
  return pair;
}

function rankGoldFirst(pairIds: string[], goldPairId: string | undefined): string[] {
  if (goldPairId === undefined) return pairIds;
  return [goldPairId, ...pairIds.filter((pairId) => pairId !== goldPairId)];
}

function replaceShortlistedPair(
  raw: C137BlindBatchRawPrediction,
  projection: C137BlindBatchExecutionProjection,
  removePairId: string,
  addPairId: string
): void {
  setShortlist(
    raw,
    projection,
    raw.nativeShortlist.shortlistedPairIds
      .filter((pairId) => pairId !== removePairId)
      .concat(addPairId)
  );
}

function setShortlist(
  raw: C137BlindBatchRawPrediction,
  projection: C137BlindBatchExecutionProjection,
  shortlistedPairIds: readonly string[]
): void {
  const selected = new Set(shortlistedPairIds);
  raw.nativeShortlist.shortlistedPairIds = projection.pairs
    .map((pair) => pair.pairId)
    .filter((pairId) => selected.has(pairId));
  raw.nativeShortlist.nonShortlistedPairIds = projection.pairs
    .map((pair) => pair.pairId)
    .filter((pairId) => !selected.has(pairId));
}

function requireOutcome(raw: C137BlindBatchRawPrediction, pairId: string) {
  const outcome = raw.pairOutcomes.find((item) => item.pairId === pairId);
  if (!outcome) throw new Error("fixture outcome missing");
  return outcome;
}

function allMedia(manifest: RealMediaBenchmarkManifest): RealMediaBenchmarkMediaInput[] {
  return manifest.cases.flatMap((benchmarkCase) => [
    benchmarkCase.source,
    benchmarkCase.target
  ]);
}

function matched(offsetMs: number) {
  return {
    kind: "matched" as const,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: offsetMs,
    targetEndMs: 60_000 + offsetMs
  };
}

function resealRawPrediction(
  prediction: C137BlindBatchRawPrediction
): C137BlindBatchRawPrediction {
  const { receiptDigest, ...draft } = prediction;
  void receiptDigest;
  return sealC137BlindBatchRawPrediction(draft satisfies C137BlindBatchRawPredictionDraft);
}

function resealProjection(
  projection: C137BlindBatchExecutionProjection
): C137BlindBatchExecutionProjection {
  const { projectionDigest, ...draft } = projection;
  void projectionDigest;
  return {
    ...draft,
    projectionDigest: computeC137BlindBatchProjectionDigest(draft)
  };
}

function resealEvidence(
  evidence: C137BlindBatchBenchmarkEvidence
): C137BlindBatchBenchmarkEvidence {
  const { evidenceDigest, ...draft } = evidence;
  void evidenceDigest;
  return {
    ...draft,
    evidenceDigest: computeC137BlindBatchBenchmarkEvidenceDigest(draft)
  };
}
