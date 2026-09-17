import { describe, expect, it, vi } from "vitest";

import type {
  RealMediaBenchmarkCase,
  RealMediaBenchmarkGold,
  RealMediaBenchmarkManifest,
  RealMediaBenchmarkMediaInput
} from "../../domain/alignment/realMediaBenchmark";
import {
  createC137BlindBatchExecutionProjection,
  deriveC137BlindBatchRawPredictionFromNativeReceipt,
  orderC137BlindBatchMediaInputs
} from "../../domain/alignment/c137BlindBatchEvidence";
import {
  computeC137FormalBlindManifestDigest,
  createC137FormalBlindMatrixPlan,
  validateC137FormalBlindProvenance
} from "../../domain/alignment/c137FormalBlindProvenance";
import type { AlignmentProposal, AlignmentTimeMapProposal } from "../../domain/alignment/types";
import {
  createNativeBatchExecutionIdentityDigest,
  createRealMediaBlindBatchRunReceiptDigest,
  REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
  type NativeBatchExecutionIdentity
} from "../../domain/alignment/realMediaBlindBatchContract";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import {
  createTestFineExecutionEvidence,
  createTestFineFrontierReceipt
} from "../../test/audioAlignmentBatchEvidenceV3";
import type {
  MediaTimelineProbeInvoker,
  MediaTimelineProbeResult
} from "../media/tauriMediaProbe";
import type {
  AudioAlignmentBatchGlobalCandidateSnapshot,
  AudioAlignmentBatchGlobalSelectionSnapshot,
  AudioAlignmentBatchJobInvoker,
  AudioAlignmentBatchJobSnapshot,
  AudioAlignmentBatchPairSnapshot,
  AudioAlignmentBatchRelationRankingSnapshot,
  NormalizedTauriAudioAlignmentBatchRequest
} from "./tauriAudioAlignment";
import { AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION } from "./tauriAudioAlignment";
import {
  runRealMediaBlindBatchSuite,
  validateRealMediaBlindBatchRunReceipt,
  type RealMediaBlindBatchAlignmentParameters,
  type RealMediaBlindBatchExecutionMedia,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchRunReceipt
} from "./realMediaBlindBatchRunner";
import {
  runC137BlindBatchBenchmark,
  runC137FormalBlindMatrixBenchmark,
  type C137BlindBatchSuiteRunner
} from "./c137BlindBatchBenchmark";

const PARAMETERS: RealMediaBlindBatchAlignmentParameters = {
  ffmpegPath: "C:\\private-tools\\ffmpeg.exe",
  ffprobePath: "C:\\private-tools\\ffprobe.exe",
  sampleRate: 16_000,
  windowMs: 50,
  matchThreshold: 0.72,
  minGapMs: 500,
  maxCells: 2_000_000,
  enableVisualEvidence: false,
  visualSampleIntervalMs: null
};
const VISUAL_PARAMETERS: RealMediaBlindBatchAlignmentParameters = {
  ...PARAMETERS,
  enableVisualEvidence: true,
  visualSampleIntervalMs: 500
};
const TEST_EXECUTION_IDENTITY: NativeBatchExecutionIdentity = {
  schemaVersion: 1,
  engineVersion: "alignment-v2.2-rust",
  featureVersion: "test-feature-v1",
  relationScoreVersion: REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
  nativeExecutableDigest: `sha256:${"a".repeat(64)}`,
  ffmpegBinaryDigest: `sha256:${"b".repeat(64)}`,
  ffprobeBinaryDigest: `sha256:${"c".repeat(64)}`,
  sourceSpectralBackends: [
    {
      backendId: "cuda-cufft-r2c-512-v1",
      requestedBackend: "cuda",
      backendDetail: "test RTX 4090",
      fallbackReason: null
    }
  ],
  targetSpectralBackends: [
    {
      backendId: "cuda-cufft-r2c-512-v1",
      requestedBackend: "cuda",
      backendDetail: "test RTX 4090",
      fallbackReason: null
    }
  ]
};
const TEST_EXECUTION_IDENTITY_DIGEST =
  createNativeBatchExecutionIdentityDigest(TEST_EXECUTION_IDENTITY);

// Full 17x17 signed-receipt matrices are intentionally more expensive than unit cases.
describe("C137 blind batch benchmark coordinator", { timeout: 120_000 }, () => {
  it("strictly derives raw prediction from the bound full-Cartesian native receipt", async () => {
    const manifest = createManifest();
    const projection = createC137BlindBatchExecutionProjection(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2
    });
    let capturedSuite: RealMediaBlindBatchExecutionSuite | undefined;
    let capturedReceipt: RealMediaBlindBatchRunReceipt | undefined;
    const runner = vi.fn<C137BlindBatchSuiteRunner>(async (suite) => {
      const receipt = await runRealMediaBlindBatchSuite(suite, {
        alignmentInvoker: createInvoker(createCompletedSnapshot(suite)),
        now: () => 100
      });
      capturedSuite = structuredClone(suite);
      capturedReceipt = structuredClone(receipt);
      return receipt;
    });

    const report = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe: createProbeInvoker(manifest) },
      runner
    });
    expect(report.status).toBe("completed");
    if (capturedSuite === undefined || capturedReceipt === undefined) {
      throw new Error("fixture failed to capture native envelope");
    }

    const raw = deriveC137BlindBatchRawPredictionFromNativeReceipt(
      projection,
      capturedSuite,
      capturedReceipt
    );
    expect(raw).toMatchObject({
      suiteId: projection.suiteId,
      projectionDigest: projection.projectionDigest,
      executionDigest: capturedReceipt.executionDigest,
      nativeReceiptDigest: capturedReceipt.receiptDigest,
      topK: 2
    });
    expect(raw.pairOutcomes).toHaveLength(projection.pairs.length);

    const rankingTamper = structuredClone(capturedReceipt);
    const rankingCandidates = rankingTamper.sourceRankings[0]?.candidates;
    if (rankingCandidates === undefined || rankingCandidates.length < 2) {
      throw new Error("fixture source ranking too small");
    }
    [rankingCandidates[0], rankingCandidates[1]] = [rankingCandidates[1], rankingCandidates[0]];
    expect(() =>
      deriveC137BlindBatchRawPredictionFromNativeReceipt(
        projection,
        capturedSuite,
        rankingTamper
      )
    ).toThrow(/sourceRankings/);

    const topKMismatch = structuredClone(capturedSuite);
    topKMismatch.topK = 1;
    expect(() =>
      deriveC137BlindBatchRawPredictionFromNativeReceipt(
        projection,
        topKMismatch,
        capturedReceipt
      )
    ).toThrow(/suiteId\/topK/);

    const streamMismatch = structuredClone(capturedSuite);
    const firstSource = streamMismatch.sources[0];
    if (firstSource === undefined) throw new Error("fixture source missing");
    firstSource.audioStreamIndex += 100;
    expect(() =>
      deriveC137BlindBatchRawPredictionFromNativeReceipt(
        projection,
        streamMismatch,
        capturedReceipt
      )
    ).toThrow(/mediaId\/stream/);

    const pairMismatch = structuredClone(capturedSuite);
    [pairMismatch.pairs[0], pairMismatch.pairs[1]] = [
      pairMismatch.pairs[1],
      pairMismatch.pairs[0]
    ];
    expect(() =>
      deriveC137BlindBatchRawPredictionFromNativeReceipt(
        projection,
        pairMismatch,
        capturedReceipt
      )
    ).toThrow(/source-major/);

    const partialReceipt = await runRealMediaBlindBatchSuite(capturedSuite, {
      alignmentInvoker: createInvoker(createPartialSnapshot(capturedSuite)),
      now: () => 100
    });
    expect(() =>
      deriveC137BlindBatchRawPredictionFromNativeReceipt(
        projection,
        capturedSuite,
        partialReceipt
      )
    ).toThrow(/只允许从整批 completed/);
  });

  it("runs a sliced query axis against the complete declared candidate universe", async () => {
    const manifest = createManifest();
    const runner = createCompletedRunner();
    const decisionCaseIds = [manifest.cases[0].id];
    const candidateCaseIds = manifest.cases.map((benchmarkCase) => benchmarkCase.id);

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      caseIds: decisionCaseIds,
      candidateCaseIds,
      parameters: PARAMETERS,
      preflightOptions: { probe: createProbeInvoker(manifest) },
      runner
    });

    expect(result.status).toBe("completed");
    expect(result.evidence).toMatchObject({
      decisionCount: 1,
      top1HitCount: 1,
      topKHitCount: 1
    });
    const executionSuite = runner.mock.calls[0]?.[0];
    expect(executionSuite?.sources).toHaveLength(3);
    expect(executionSuite?.targets).toHaveLength(1);
    expect(executionSuite?.pairs).toHaveLength(3);
  });

  it("rejects a partial candidate shard at the public single-batch boundary", async () => {
    const manifest = createManifest();
    manifest.cases.push(createCase(4));
    const probe = createProbeInvoker(manifest);
    const runner = createCompletedRunner();

    await expect(
      runC137BlindBatchBenchmark(manifest, {
        relationshipAxis: "target",
        visualEvidenceEnabled: false,
        topK: 2,
        caseIds: [manifest.cases[0].id],
        candidateCaseIds: manifest.cases.slice(1).map((benchmarkCase) => benchmarkCase.id),
        parameters: PARAMETERS,
        preflightOptions: { probe },
        runner
      })
    ).rejects.toThrow(/partial shard 不得单独揭示或编译准确率/);
    expect(probe).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("preflights once, executes every 17×17 tile sequentially and seals one global provenance", async () => {
    const manifest = createMatrixManifest(17);
    const plan = createC137FormalBlindMatrixPlan(
      manifest,
      computeC137FormalBlindManifestDigest(manifest),
      {
        relationshipAxis: "target",
        visualEvidenceEnabled: false,
        globalTopK: 2
      }
    );
    const probe = createProbeInvoker(manifest);
    const runner = createUniqueJobCompletedRunner();

    const result = await runC137FormalBlindMatrixBenchmark(manifest, {
      plan,
      parameters: PARAMETERS,
      preflightOptions: { probe, concurrency: 4 },
      runner
    });

    expect(plan.batches).toHaveLength(2);
    expect(result).toMatchObject({
      status: "completed",
      completedBatchCount: 2,
      totalBatchCount: 2,
      reasons: []
    });
    expect(probe).toHaveBeenCalledTimes(34);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls.map(([suite]) => suite.pairs.length)).toEqual([255, 34]);
    expect(result.provenance).not.toBeNull();
    expect(validateC137FormalBlindProvenance(result.provenance)).toMatchObject({
      valid: true,
      coverageValid: true
    });
  });

  it("discards completed tile envelopes when a later matrix tile fails", async () => {
    const manifest = createMatrixManifest(17);
    const plan = createC137FormalBlindMatrixPlan(
      manifest,
      computeC137FormalBlindManifestDigest(manifest),
      {
        relationshipAxis: "target",
        visualEvidenceEnabled: false,
        globalTopK: 2
      }
    );
    const probe = createProbeInvoker(manifest);
    const completed = createUniqueJobCompletedRunner();
    let callCount = 0;
    const runner = vi.fn<C137BlindBatchSuiteRunner>(async (suite, options) => {
      callCount += 1;
      if (callCount === 2) throw new Error("fixture second tile failure");
      return completed(suite, options);
    });

    const result = await runC137FormalBlindMatrixBenchmark(manifest, {
      plan,
      parameters: PARAMETERS,
      preflightOptions: { probe },
      runner
    });

    expect(result).toMatchObject({
      status: "runner-failed",
      completedBatchCount: 1,
      totalBatchCount: 2,
      provenance: null
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(manifest.cases[0].id);
    expect(serialized).not.toContain(manifest.cases[0].source.path);
    expect(serialized).not.toContain("matchedAnchors");
  });

  it("discards every tile when a later receipt is validly resealed under a drifted backend", async () => {
    const manifest = createMatrixManifest(17);
    const plan = createC137FormalBlindMatrixPlan(
      manifest,
      computeC137FormalBlindManifestDigest(manifest),
      {
        relationshipAxis: "target",
        visualEvidenceEnabled: false,
        globalTopK: 2
      }
    );
    const completed = createUniqueJobCompletedRunner();
    let callCount = 0;
    const runner = vi.fn<C137BlindBatchSuiteRunner>(async (suite, options) => {
      callCount += 1;
      const receipt = validateRealMediaBlindBatchRunReceipt(
        await completed(suite, options),
        suite
      );
      if (callCount === 1) return receipt;
      const drifted = structuredClone(receipt);
      for (const outcome of drifted.pairOutcomes) {
        const identity = outcome.relationRanking.executionIdentity;
        const backend = identity?.sourceSpectralBackends[0];
        if (!identity || !backend) throw new Error("fixture execution identity missing");
        backend.backendId = "cpu-radix2-f64-r2c-512-v1";
        backend.requestedBackend = "cpu";
        backend.backendDetail = "test CPU fallback";
        backend.fallbackReason = "fixture CUDA runtime fallback";
        outcome.relationRanking.executionIdentityDigest =
          createNativeBatchExecutionIdentityDigest(identity);
      }
      drifted.executionIdentityDigest =
        drifted.pairOutcomes[0]?.relationRanking.executionIdentityDigest ?? null;
      const { receiptDigest, ...withoutDigest } = drifted;
      void receiptDigest;
      return {
        ...withoutDigest,
        receiptDigest: createRealMediaBlindBatchRunReceiptDigest(withoutDigest)
      };
    });

    const result = await runC137FormalBlindMatrixBenchmark(manifest, {
      plan,
      parameters: PARAMETERS,
      preflightOptions: { probe: createProbeInvoker(manifest) },
      runner
    });

    expect(result).toMatchObject({
      status: "receipt-invalid",
      completedBatchCount: 1,
      totalBatchCount: 2,
      provenance: null
    });
    expect(JSON.stringify(result)).not.toContain("sourceSpectralBackends");
  });

  it("rejects a non-canonical matrix plan before preflight or native I/O", async () => {
    const manifest = createManifest();
    const plan = createC137FormalBlindMatrixPlan(
      manifest,
      computeC137FormalBlindManifestDigest(manifest),
      {
        relationshipAxis: "target",
        visualEvidenceEnabled: false,
        globalTopK: 2
      }
    );
    plan.batches[0]?.candidateCaseIds.reverse();
    const probe = createProbeInvoker(manifest);
    const runner = createUniqueJobCompletedRunner();

    await expect(
      runC137FormalBlindMatrixBenchmark(manifest, {
        plan,
        parameters: PARAMETERS,
        preflightOptions: { probe },
        runner
      })
    ).rejects.toThrow(/媒体 I\/O 前精确等于/);
    expect(probe).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("preflights each path once, runs one pathful batch and returns only shareable evidence", async () => {
    const manifest = createManifest();
    const privateProjection = createC137BlindBatchExecutionProjection(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2
    });
    const probe = createProbeInvoker(manifest);
    const runner = createCompletedRunner();

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe, concurrency: 4 },
      runner
    });

    expect(result.status).toBe("completed");
    expect(result.preflight).toEqual({
      ok: true,
      realRelationCount: 3,
      checkedFileCount: 6,
      issues: []
    });
    expect(probe).toHaveBeenCalledTimes(6);
    expect(new Set(probe.mock.calls.map(([request]) => request.path))).toEqual(
      new Set(allMedia(manifest).map((media) => media.path))
    );
    expect(runner).toHaveBeenCalledTimes(1);

    const executionSuite = runner.mock.calls[0]?.[0];
    expect(executionSuite).toBeDefined();
    expect(executionSuite?.suiteId).toBe(privateProjection.suiteId);
    expect(executionSuite.sources.map((media) => media.mediaId)).toEqual(
      privateProjection.sources.map((media) => media.mediaId)
    );
    expect(executionSuite.targets.map((media) => media.mediaId)).toEqual(
      privateProjection.targets.map((media) => media.mediaId)
    );
    expect(executionSuite.pairs).toEqual(
      privateProjection.pairs.map((pair, index) => ({
        pairOrdinal: index + 1,
        sourceMediaId: pair.sourceMediaId,
        targetMediaId: pair.targetMediaId
      }))
    );
    expect(executionSuite.sources.map((media) => media.path)).toEqual(
      orderC137BlindBatchMediaInputs(
        manifest.id,
        manifest.datasetVersion,
        "source",
        false,
        manifest.cases.map((benchmarkCase) => benchmarkCase.source)
      ).map((media) => media.path)
    );

    expect(result).not.toHaveProperty("projection");
    expect(result).not.toHaveProperty("rawPrediction");
    expect(result).not.toHaveProperty("manifestId");
    expect(result).not.toHaveProperty("datasetVersion");
    expect(result).not.toHaveProperty("suiteId");
    expect(result).not.toHaveProperty("projectionDigest");
    expect(result).not.toHaveProperty("executionDigest");
    expect(result).not.toHaveProperty("nativeReceiptDigest");
    expect(result.evidence).toMatchObject({
      scope: "cross-media-relationship-and-known-pair-anchor-component",
      releaseEligible: false,
      trustStatus: "untrusted-self-consistent-evidence",
      decisionCount: 3,
      top1HitCount: 3,
      topKHitCount: 3,
      shortlistedGoldPairCount: 3,
      top1WrongRelationshipCount: 0,
      knownPairMappedAnchorCount: 15,
      knownPairUnmappedAnchorCount: 0,
      knownPairAnchorCoverage: 1
    });

    const shareableStrings = collectStrings(result);
    for (const media of allMedia(manifest)) {
      expect(shareableStrings).not.toContain(media.path);
      expect(shareableStrings).not.toContain(media.contentIdentity?.digest);
    }
    expect(shareableStrings).not.toContain(PARAMETERS.ffmpegPath);
    expect(shareableStrings).not.toContain(PARAMETERS.ffprobePath);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("matchedAnchors");
    expect(serialized).not.toContain("independentAnnotations");
    expect(serialized).not.toContain(privateProjection.suiteId);
    expect(serialized).not.toContain(privateProjection.projectionDigest);
    expect(result.evidence).not.toHaveProperty("rawPredictionDigest");
    expect(result.evidence).not.toHaveProperty("evidenceDigest");
    expect(serialized).not.toContain("reviewer-alpha");
    for (const benchmarkCase of manifest.cases) {
      expect(serialized).not.toContain(benchmarkCase.id);
    }
    for (const pair of privateProjection.pairs) {
      expect(serialized).not.toContain(pair.pairId);
    }
    for (const media of [...privateProjection.sources, ...privateProjection.targets]) {
      expect(serialized).not.toContain(media.mediaId);
      expect(serialized).not.toContain(media.bindingCommitment);
    }
    for (const media of allMedia(manifest)) {
      expect(serialized.toLowerCase()).not.toContain(media.path.toLowerCase());
      expect(serialized).not.toContain(media.contentIdentity?.digest);
    }
  });

  it("normalizes unconsumed video streams to null throughout an audio-only run", async () => {
    const manifest = createManifest();
    for (const media of allMedia(manifest)) {
      media.videoStreamIndex = 99;
    }
    const underlyingProbe = createProbeInvoker(manifest);
    const probe = vi.fn<MediaTimelineProbeInvoker>(async (request) => ({
      ...(await underlyingProbe(request)),
      videoStreams: []
    }));
    const runner = createCompletedRunner();

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe },
      runner
    });

    expect(result.status).toBe("completed");
    const executionSuite = runner.mock.calls[0]?.[0];
    expect(
      executionSuite !== undefined &&
        [...executionSuite.sources, ...executionSuite.targets].every(
          (media) => media.videoStreamIndex === null
        )
    ).toBe(true);
  });

  it("rejects a visual mode mismatch before projection, preflight, or native execution", async () => {
    const manifest = createManifest();
    const probe = createProbeInvoker(manifest);
    const runner = vi.fn<C137BlindBatchSuiteRunner>();

    await expect(
      runC137BlindBatchBenchmark(manifest, {
        relationshipAxis: "target",
        visualEvidenceEnabled: true,
        topK: 2,
        parameters: PARAMETERS,
        preflightOptions: { probe },
        runner
      })
    ).rejects.toThrow(/必须与 native parameters\.enableVisualEvidence 一致/);
    expect(probe).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects null/auto video streams before preflight in a formal visual benchmark", async () => {
    const manifest = createManifest();
    manifest.cases[0].source.videoStreamIndex = null;
    const probe = createProbeInvoker(manifest);
    const runner = vi.fn<C137BlindBatchSuiteRunner>();

    await expect(
      runC137BlindBatchBenchmark(manifest, {
        relationshipAxis: "target",
        visualEvidenceEnabled: true,
        topK: 2,
        parameters: VISUAL_PARAMETERS,
        preflightOptions: { probe },
        runner
      })
    ).rejects.toThrow(/禁止 null\/auto/);
    expect(probe).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects more than 256×1 media before preflight or native execution", async () => {
    const manifest = createOverMediaLimitManifest();
    const probe = createProbeInvoker(manifest);
    const runner = vi.fn<C137BlindBatchSuiteRunner>();

    await expect(
      runC137BlindBatchBenchmark(manifest, {
        relationshipAxis: "source",
        visualEvidenceEnabled: false,
        topK: 2,
        parameters: PARAMETERS,
        preflightOptions: { probe },
        runner
      })
    ).rejects.toThrow(/每侧最多允许 256/);
    expect(probe).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("deduplicates video-only views when visual evidence is disabled", async () => {
    const manifest = createVisualViewManifest();
    const probe = createProbeInvoker(manifest);
    const runner = vi.fn<C137BlindBatchSuiteRunner>();

    await expect(
      runC137BlindBatchBenchmark(manifest, {
        relationshipAxis: "target",
        visualEvidenceEnabled: false,
        topK: 2,
        parameters: PARAMETERS,
        preflightOptions: { probe },
        runner
      })
    ).rejects.toThrow(/严格大于 topK/);
    expect(probe).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves distinct video-stream views when visual evidence is enabled", async () => {
    const manifest = createVisualViewManifest();
    const probe = createProbeInvoker(manifest);
    const runner = createCompletedRunner();

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: true,
      topK: 2,
      parameters: VISUAL_PARAMETERS,
      preflightOptions: { probe },
      runner
    });

    expect(result.status).toBe("completed");
    const executionSuite = runner.mock.calls[0]?.[0];
    expect(executionSuite?.sources).toHaveLength(3);
    const sharedIdentityViews = executionSuite?.sources.filter(
      (media) =>
        media.contentIdentity.firstSampleDigest ===
        manifest.cases[1].source.contentIdentity?.digest
    );
    expect(sharedIdentityViews?.map((media) => media.videoStreamIndex).sort()).toEqual([0, 1]);
  });

  it("fails before the runner when the captured full-file identity mismatches", async () => {
    const manifest = createManifest();
    const mismatchedPath = manifest.cases[0].source.path;
    const probe = createProbeInvoker(manifest, mismatchedPath);
    const runner = vi.fn<C137BlindBatchSuiteRunner>();

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe },
      runner
    });

    expect(result.status).toBe("preflight-failed");
    expect(result.preflight.issues.map((issue) => issue.code)).toContain("identity-mismatch");
    expect(result.preflight.issues.every((issue) => issue.caseId === null)).toBe(true);
    expect(result.evidence).toBeNull();
    expect(runner).not.toHaveBeenCalled();
    expect(collectStrings(result)).not.toContain(mismatchedPath);
    for (const benchmarkCase of manifest.cases) {
      expect(JSON.stringify(result)).not.toContain(benchmarkCase.id);
    }
  });

  it("strips caller-controlled manifest metadata containing private path or case identifiers", async () => {
    const manifest = createManifest();
    const privatePath = manifest.cases[0].source.path;
    const privateCaseId = manifest.cases[0].id;
    manifest.id = `privacy-fixture-${privatePath.toUpperCase()}-suffix`;
    manifest.datasetVersion = `dataset-${privateCaseId}-suffix`;
    const probe = createProbeInvoker(manifest, privatePath);
    const runner = vi.fn<C137BlindBatchSuiteRunner>();

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe },
      runner
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(result.status).toBe("preflight-failed");
    expect(serialized).not.toContain(privatePath.toLowerCase());
    expect(serialized).not.toContain(privateCaseId.toLowerCase());
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a tampered native receipt before normalization or gold compilation", async () => {
    const manifest = createManifest();
    const probe = createProbeInvoker(manifest);
    const runner = createCompletedRunner(true);

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe },
      runner
    });

    expect(result.status).toBe("receipt-invalid");
    expect(result).not.toHaveProperty("nativeReceiptDigest");
    expect(result.evidence).toBeNull();
  });

  it("keeps accuracy evidence null for a strictly valid partial native run", async () => {
    const manifest = createManifest();
    const probe = createProbeInvoker(manifest);
    const runner = createPartialRunner();

    const result = await runC137BlindBatchBenchmark(manifest, {
      relationshipAxis: "target",
      visualEvidenceEnabled: false,
      topK: 2,
      parameters: PARAMETERS,
      preflightOptions: { probe },
      runner
    });

    expect(result).toMatchObject({
      status: "incomplete-run",
      nativeRunStatus: "completed-with-errors",
      evidence: null
    });
    expect(result).not.toHaveProperty("executionDigest");
    expect(result).not.toHaveProperty("nativeReceiptDigest");
  });
});

function createCompletedRunner(tamperReceipt = false) {
  return vi.fn<C137BlindBatchSuiteRunner>(async (suite) => {
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker(createCompletedSnapshot(suite)),
      now: () => 100
    });
    return tamperReceipt ? { ...receipt, receiptDigest: `sha256:${"0".repeat(64)}` } : receipt;
  });
}

function createUniqueJobCompletedRunner() {
  let jobOrdinal = 0;
  return vi.fn<C137BlindBatchSuiteRunner>(async (suite) => {
    jobOrdinal += 1;
    const snapshot = createCompletedSnapshot(suite);
    snapshot.jobId = `coordinator-matrix-job-${jobOrdinal}`;
    return runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker(snapshot),
      now: () => 100 + jobOrdinal
    });
  });
}

function createPartialRunner() {
  return vi.fn<C137BlindBatchSuiteRunner>((suite) =>
    runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker(createPartialSnapshot(suite)),
      now: () => 100
    })
  );
}

function createManifest(): RealMediaBenchmarkManifest {
  return {
    schemaVersion: 2,
    id: "blind-batch-coordinator-unit",
    name: "盲测协调器单元测试",
    datasetVersion: "frozen-coordinator-v1",
    description: "程序构造的协调器测试，不代表实际精度。",
    isExample: false,
    licenseNotes: ["不包含真实媒体。"],
    cases: [createCase(1), createCase(2), createCase(3)]
  };
}

function createMatrixManifest(caseCount: number): RealMediaBenchmarkManifest {
  const manifest = createManifest();
  manifest.cases = Array.from({ length: caseCount }, (_, index) => createCase(index + 1));
  return manifest;
}

function createOverMediaLimitManifest(): RealMediaBenchmarkManifest {
  const manifest = createManifest();
  manifest.cases = Array.from({ length: 257 }, (_, index) => createCase(index + 1));
  const sharedTarget = structuredClone(manifest.cases[0].target);
  for (const benchmarkCase of manifest.cases) {
    benchmarkCase.target = structuredClone(sharedTarget);
  }
  return manifest;
}

function createVisualViewManifest(): RealMediaBenchmarkManifest {
  const manifest = createManifest();
  const visualView = structuredClone(manifest.cases[1].source);
  visualView.path = "C:\\private-c137\\source-2-visual-view.mkv";
  visualView.videoStreamIndex = 1;
  visualView.versionNote = "source-2 第二视频流视图";
  manifest.cases[2].source = visualView;
  return manifest;
}

function createCase(index: number): RealMediaBenchmarkCase {
  const gold = createGold(index);
  return {
    id: `coordinator-case-${index}`,
    title: `冻结关系 ${index}`,
    mediaKind: "real",
    split: "frozen-test",
    scenarios: ["global-offset"],
    source: createMedia("source", index),
    target: createMedia("target", index),
    boundaryToleranceMs: 100,
    versionNotes: ["程序构造固定版本。"],
    licenseNotes: ["不包含真实媒体。"],
    independentAnnotations: [
      { reviewerId: `reviewer-alpha-${index}`, gold: structuredClone(gold) },
      { reviewerId: `reviewer-beta-${index}`, gold: structuredClone(gold) }
    ],
    adjudication: {
      status: "not-needed",
      adjudicatorId: null,
      note: "两份独立标注完全一致。"
    },
    gold
  };
}

function createGold(index: number): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    matchedAnchors: [1_000, 13_000, 25_000, 37_000, 49_000].map((timeMs, anchorIndex) => ({
      id: `private-anchor-${index}-${anchorIndex}`,
      sourceMs: timeMs,
      targetMs: timeMs
    })),
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}

function createMedia(side: "source" | "target", index: number): RealMediaBenchmarkMediaInput {
  const digestByte = (side === "source" ? index : index + 128) & 0xff;
  return {
    path: `C:\\private-c137\\${side}-${index}.mkv`,
    audioStreamIndex: side === "source" ? index - 1 : index + 1,
    videoStreamIndex: 0,
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: (side === "source" ? 1_000 : 2_000) + index,
      digest: digestByte.toString(16).padStart(2, "0").repeat(32)
    },
    versionNote: `${side}-${index} 固定版本`,
    licenseNote: "程序构造路径。"
  };
}

function allMedia(manifest: RealMediaBenchmarkManifest): RealMediaBenchmarkMediaInput[] {
  return manifest.cases.flatMap((benchmarkCase) => [
    benchmarkCase.source,
    benchmarkCase.target
  ]);
}

function createProbeInvoker(manifest: RealMediaBenchmarkManifest, mismatchedPath?: string) {
  const byPath = new Map(allMedia(manifest).map((media) => [media.path, media]));
  return vi.fn<MediaTimelineProbeInvoker>(({ path }) => {
    const media = byPath.get(path);
    if (!media?.contentIdentity) return Promise.reject(new Error("unexpected fixture path"));
    const digest = path === mismatchedPath ? "f".repeat(64) : media.contentIdentity.digest;
    return Promise.resolve(createProbe(media, digest));
  });
}

function createProbe(
  media: RealMediaBenchmarkMediaInput,
  measuredDigest: string
): MediaTimelineProbeResult {
  if (media.contentIdentity === null) throw new Error("fixture identity missing");
  return {
    presentationOriginMs: 0,
    durationMs: 60_000,
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: media.contentIdentity.sizeBytes,
      modifiedUnixMs: media.path.includes("source-1") ? 101 : 202,
      firstSampleDigest: measuredDigest,
      middleSampleDigest: measuredDigest,
      lastSampleDigest: measuredDigest
    },
    videoStreams: [createVideoStream(media.videoStreamIndex ?? 0)],
    audioStreams: [createProbeAudioStream(media.audioStreamIndex)],
    preferredAudioStreamIndex: media.audioStreamIndex
  };
}

function createProbeAudioStream(index: number) {
  return {
    index,
    codec: "flac",
    startMs: 0,
    timelineOffsetMs: 0,
    durationMs: 60_000,
    timeBase: "1/48000",
    language: "zh",
    title: "main",
    default: true,
    commentary: false,
    sampleRate: 48_000,
    channels: 2
  };
}

function createVideoStream(index: number) {
  return {
    index,
    codec: "h264",
    startMs: 0,
    timelineOffsetMs: 0,
    durationMs: 60_000,
    timeBase: "1/90000",
    language: null,
    title: null,
    default: true,
    commentary: false,
    frameRate: 24
  };
}

function createCompletedSnapshot(
  suite: RealMediaBlindBatchExecutionSuite
): AudioAlignmentBatchJobSnapshot {
  const selectedCandidateIds = suite.pairs
    .filter((pair) => {
      const source = requireExecutionMedia(suite.sources, pair.sourceMediaId);
      const target = requireExecutionMedia(suite.targets, pair.targetMediaId);
      return mediaEpisode(source.path) === mediaEpisode(target.path);
    })
    .map((pair) => ({ pairOrdinal: pair.pairOrdinal, candidateOrdinal: 1 }));
  const fineFrontier = createTestFineFrontierReceipt(
    suite.pairs.map((pair) => pair.pairOrdinal),
    selectedCandidateIds
  );
  const coarseBackend = TEST_EXECUTION_IDENTITY.sourceSpectralBackends[0];
  const pairs = suite.pairs.map((pair, pairIndex): AudioAlignmentBatchPairSnapshot => {
    const source = requireExecutionMedia(suite.sources, pair.sourceMediaId);
    const target = requireExecutionMedia(suite.targets, pair.targetMediaId);
    const selected = mediaEpisode(source.path) === mediaEpisode(target.path);
    const score = selected ? 0.95 : 0.5 - (pairIndex % 20) / 100;
    const proposal = createProposal(source, target, selected ? "review" : "blocked");
    return {
      pairIndex,
      pairOrdinal: pair.pairOrdinal,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId,
      status: "completed",
      progress: 1,
      message: "completed",
      relationRanking: createRelationRanking(source, target, score),
      globalSelection: createSelection(source, target, score, selected),
      fineFrontier: structuredClone(fineFrontier),
      fineExecutionEvidence:
        selected && proposal.timeMap
          ? createTestFineExecutionEvidence(proposal.timeMap, {
              pairOrdinal: pair.pairOrdinal,
              sourceStreamIndex: source.audioStreamIndex,
              targetStreamIndex: target.audioStreamIndex,
              engineVersion: TEST_EXECUTION_IDENTITY.engineVersion,
              featureVersion: TEST_EXECUTION_IDENTITY.featureVersion,
              coarseBackend,
              fineBackend: coarseBackend
            })
          : null,
      proposal,
      error: null
    };
  });
  return createTerminalSnapshot(suite, pairs, 0);
}

function mediaEpisode(path: string): number {
  const match = /-(\d+)(?:-[^.]+)?\.mkv$/i.exec(path);
  if (!match) throw new Error("fixture media path lacks episode ordinal");
  return Number(match[1]);
}

function createPartialSnapshot(
  suite: RealMediaBlindBatchExecutionSuite
): AudioAlignmentBatchJobSnapshot {
  const completed = createCompletedSnapshot(suite);
  const failedPairIndex = completed.pairs.findIndex(
    (pair) => pair.fineExecutionEvidence === null
  );
  const failedPair = completed.pairs[failedPairIndex];
  if (!failedPair) throw new Error("fixture pair missing");
  const failedSelection: AudioAlignmentBatchGlobalSelectionSnapshot = {
    ...failedPair.globalSelection,
    state: "failed",
    selected: false,
    selectedRank: null,
    selectedScore: null,
    topK: failedPair.globalSelection.topK.map((candidate) => ({
      ...candidate,
      globalSelected: false
    })),
    decisionCandidate:
      failedPair.globalSelection.decisionCandidate === null
        ? null
        : {
            ...failedPair.globalSelection.decisionCandidate,
            globalSelected: false
          }
  };
  completed.pairs[failedPairIndex] = {
    ...failedPair,
    status: "failed",
    progress: 1,
    message: "failed",
    relationRanking: createFailedRelationRanking(),
    globalSelection: failedSelection,
    proposal: null,
    error: "fixture failure"
  };
  completed.failedPairCount = 1;
  return completed;
}

function createTerminalSnapshot(
  suite: RealMediaBlindBatchExecutionSuite,
  pairs: AudioAlignmentBatchPairSnapshot[],
  failedPairCount: number
): AudioAlignmentBatchJobSnapshot {
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "coordinator-batch-job",
    pairingMode: "fullCartesian",
    sourceMediaIds: suite.sources.map((media) => media.mediaId),
    targetMediaIds: suite.targets.map((media) => media.mediaId),
    versionReuseGroups: suite.versionReuseGroups.map((group, index) => ({
      ...structuredClone(group),
      groupOrdinal: index + 1
    })),
    status: "completed",
    progress: 1,
    message: "completed",
    totalPairCount: pairs.length,
    processedPairCount: pairs.length,
    failedPairCount,
    currentPairOrdinal: null,
    diagnosticEvents: [],
    pairs,
    error: null,
    updatedAtMs: 2
  };
}

function createFailedRelationRanking(): AudioAlignmentBatchRelationRankingSnapshot {
  return {
    scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
    executionIdentityDigest: null,
    executionIdentity: null,
    state: "failed",
    candidateCount: 0,
    eligibleCandidateCount: 0,
    score: null,
    bestEligibleCandidate: null
  };
}

function createRelationRanking(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number
): AudioAlignmentBatchRelationRankingSnapshot {
  const candidate = createGlobalCandidate(source, target, score, false);
  return {
    scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
    executionIdentityDigest: TEST_EXECUTION_IDENTITY_DIGEST,
    executionIdentity: structuredClone(TEST_EXECUTION_IDENTITY),
    state: "ranked",
    candidateCount: 1,
    eligibleCandidateCount: 1,
    score,
    bestEligibleCandidate: {
      rank: candidate.rank,
      sourceStreamIndex: candidate.sourceStreamIndex,
      targetStreamIndex: candidate.targetStreamIndex,
      score: candidate.score,
      globalScore: candidate.globalScore,
      scale: candidate.scale,
      offsetMs: candidate.offsetMs,
      sourceStartMs: candidate.sourceStartMs,
      sourceEndMs: candidate.sourceEndMs,
      targetStartMs: candidate.targetStartMs,
      targetEndMs: candidate.targetEndMs,
      inlierCount: candidate.inlierCount,
      temporalCoverage: candidate.temporalCoverage,
      uniqueSourceCoverage: candidate.uniqueSourceCoverage
    }
  };
}

function createSelection(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number,
  selected: boolean
): AudioAlignmentBatchGlobalSelectionSnapshot {
  const candidate = createGlobalCandidate(source, target, score, selected);
  return {
    state: selected ? "selected" : "blocked",
    selected,
    selectedRank: selected ? 1 : null,
    selectedScore: selected ? score : null,
    decisionRank: 1,
    decisionScore: score,
    margin: 0.25,
    candidateCount: 1,
    eligibleCandidateCount: 1,
    topK: [{ ...candidate }],
    decisionCandidate: { ...candidate }
  };
}

function createGlobalCandidate(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  score: number,
  selected: boolean
): AudioAlignmentBatchGlobalCandidateSnapshot {
  return {
    rank: 1,
    sourceStreamIndex: source.audioStreamIndex,
    targetStreamIndex: target.audioStreamIndex,
    score: Math.max(0, score - 0.05),
    globalScore: score,
    scale: 1,
    offsetMs: 0,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    inlierCount: 40,
    temporalCoverage: 0.95,
    uniqueSourceCoverage: 0.9,
    eligible: true,
    globalSelected: selected
  };
}

function createProposal(
  source: RealMediaBlindBatchExecutionMedia,
  target: RealMediaBlindBatchExecutionMedia,
  level: "review" | "blocked"
): AlignmentProposal {
  const timeMap: AlignmentTimeMapProposal = {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      createTestCompleteTimeMapSpan(
        {
          kind: level === "blocked" ? "ambiguous" : "matched",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000
        },
        `${source.mediaId}-${target.mediaId}-span`
      )
    ],
    quality: {
      level,
      probability: level === "review" ? 0.91 : null,
      metricSource: "measured",
      coverage: 0.95,
      uniqueContentCoverage: 0.9,
      p50ResidualMs: 30,
      p95ResidualMs: 80,
      p99ResidualMs: 120,
      maxResidualMs: 150,
      boundaryUncertaintyMs: 200,
      alternativeMargin: 0.25,
      anchorCount: 40,
      anchorRegionCount: 3,
      heldOutAnchorCount: 8,
      reasons: [level === "review" ? "需要复核。" : "全局候选被阻断。"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 40,
      visualAnchorCount: 0,
      heldOutAnchorCount: 8,
      top1Top2Margin: 0.25,
      uniqueContentCoverage: 0.9,
      repeatedContentOnly: false,
      selectedTrackReason: "coordinator fixture",
      alternativeTrackScores: [
        {
          sourceStreamIndex: source.audioStreamIndex,
          targetStreamIndex: target.audioStreamIndex,
          score: 0.9,
          scale: 1,
          offsetMs: 0,
          inlierCount: 40
        }
      ],
      notes: []
    },
    sourceStream: createProposalAudioStream(source.audioStreamIndex),
    targetStream: createProposalAudioStream(target.audioStreamIndex),
    sourceVisualStream:
      source.videoStreamIndex === null
        ? null
        : createProposalVideoStream(source.videoStreamIndex),
    targetVisualStream:
      target.videoStreamIndex === null
        ? null
        : createProposalVideoStream(target.videoStreamIndex),
    sourceIdentity: { ...source.contentIdentity },
    targetIdentity: { ...target.contentIdentity },
    engineVersion: "alignment-v2.0-rust",
    featureVersion: "c137-coordinator-fixture-v1",
    parametersHash: "sha256:test-parameters"
  };
  return {
    anchors: [],
    cutCandidates: [],
    confidence: level === "review" ? 0.91 : 0,
    diagnostics: ["fixture"],
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 0.95
    },
    ...(level === "review" ? { timeMap } : {})
  };
}

function createProposalAudioStream(index: number) {
  return {
    type: "audio" as const,
    index,
    codec: "flac",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/48000",
    sampleRate: 48_000,
    channels: 2,
    frameRate: null,
    language: "zh",
    title: "main"
  };
}

function createProposalVideoStream(index: number) {
  return {
    type: "video" as const,
    index,
    codec: "h264",
    startMs: 0,
    timelineOffsetMs: 0,
    timeBase: "1/90000",
    sampleRate: null,
    channels: null,
    frameRate: 24,
    language: null,
    title: null
  };
}

function requireExecutionMedia(
  media: readonly RealMediaBlindBatchExecutionMedia[],
  mediaId: string
): RealMediaBlindBatchExecutionMedia {
  const result = media.find((item) => item.mediaId === mediaId);
  if (!result) throw new Error(`fixture media missing: ${mediaId}`);
  return result;
}

function createInvoker(
  snapshot: AudioAlignmentBatchJobSnapshot
): AudioAlignmentBatchJobInvoker {
  return {
    start: vi.fn<
      (
        request: NormalizedTauriAudioAlignmentBatchRequest
      ) => Promise<AudioAlignmentBatchJobSnapshot>
    >(() => Promise.resolve(structuredClone(snapshot))),
    get: vi.fn(() => Promise.reject(new Error("unexpected get"))),
    cancel: vi.fn(() => Promise.reject(new Error("unexpected cancel")))
  };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item));
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((item) => collectStrings(item));
}
