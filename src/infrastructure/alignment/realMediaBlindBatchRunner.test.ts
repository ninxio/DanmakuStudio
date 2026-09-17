import { describe, expect, it, vi } from "vitest";
import type { AlignmentProposal, AlignmentTimeMapProposal } from "../../domain/alignment/types";
import type { MediaContentIdentity } from "../../domain/project/types";
import {
  createNativeBatchExecutionIdentityDigest,
  createNativeBatchFineExecutionEvidenceDigest,
  createNativeBatchFineFrontierReceiptDigest,
  createNativeBatchFineInventoryDigest,
  REAL_MEDIA_BLIND_BATCH_RELATION_SCORE_VERSION,
  type NativeBatchExecutionIdentity
} from "../../domain/alignment/realMediaBlindBatchContract";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import {
  createTestFineExecutionEvidence,
  createTestFineFrontierReceipt
} from "../../test/audioAlignmentBatchEvidenceV3";
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
import type {
  C137ProcessAttestationInvoker,
  C137ProcessEvidenceBindingV1
} from "./tauriC137ProcessAttestation";
import {
  createRealMediaBlindBatchExecutionDigest,
  createRealMediaBlindBatchRunReceiptDigest,
  runRealMediaBlindBatchSuite,
  validateRealMediaBlindBatchExecutionSuite,
  validateRealMediaBlindBatchRunReceipt,
  type RealMediaBlindBatchExecutionMedia,
  type RealMediaBlindBatchExecutionSuite,
  type RealMediaBlindBatchRunReceipt
} from "./realMediaBlindBatchRunner";

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

describe("C137 real-media blind full-Cartesian batch runner", () => {
  it("一次启动真实 N×M batch、轮询到终态，并输出 path-free pair/排名/原生全局选择收据", async () => {
    const suite = createSuite();
    const running = createRunningSnapshot(suite);
    const completed = createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]);
    const invoker = createInvoker({ start: running, get: [completed] });

    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: invoker,
      pollIntervalMs: 0,
      wait: () => Promise.resolve(),
      now: () => 100
    });

    expect(invoker.start).toHaveBeenCalledTimes(1);
    expect(invoker.get).toHaveBeenCalledTimes(1);
    expect(invoker.cancel).not.toHaveBeenCalled();
    const nativeRequest = vi.mocked(invoker.start).mock.calls[0]?.[0];
    expect(nativeRequest).toMatchObject({
      schemaVersion: 2,
      sources: suite.sources.map((media) => ({
        mediaId: media.mediaId,
        path: media.path,
        audioStreamIndex: media.audioStreamIndex,
        videoStreamIndex: media.videoStreamIndex
      })),
      targets: suite.targets.map((media) => ({
        mediaId: media.mediaId,
        path: media.path,
        audioStreamIndex: media.audioStreamIndex,
        videoStreamIndex: media.videoStreamIndex
      })),
      versionReuseGroups: [],
      localizationMode: true
    });
    expect(nativeRequest).not.toHaveProperty("pairs");

    expect(receipt).toMatchObject({
      schemaVersion: 5,
      receiptKind: "c137-real-media-blind-batch-run",
      suiteId: suite.suiteId,
      datasetVersion: suite.datasetVersion,
      executionDigest: createRealMediaBlindBatchExecutionDigest(suite),
      nativeEvidenceVersion: 5,
      pairingMode: "fullCartesian",
      status: "completed",
      terminationReason: "native-terminal",
      sourceCount: 2,
      targetCount: 2,
      pairCount: 4,
      topK: 2,
      versionReuseGroups: []
    });
    expect(receipt.pairOutcomes).toHaveLength(4);
    expect(receipt.pairOutcomes.map((outcome) => outcome.globalSelected)).toEqual([
      true,
      false,
      false,
      true
    ]);
    expect(receipt.pairOutcomes[0]?.globalSelection.selectedRank).toBe(1);
    expect(receipt.pairOutcomes[0]?.relationRanking).toMatchObject({
      scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
      state: "ranked",
      score: 0.93
    });
    expect(receipt.pairOutcomes[0]?.relationRanking.bestEligibleCandidate?.rank).toBe(1);
    expect(receipt.pairOutcomes[0]?.relationRanking.bestEligibleCandidate?.globalScore).toBe(
      0.93
    );
    expect(receipt.pairOutcomes[0]?.proposalTimeMap?.engineVersion).toContain("alignment-v2");
    expect(receipt.sourceRankings).toEqual([
      expect.objectContaining({
        sourceMediaId: "source-1",
        candidates: [
          expect.objectContaining({
            relationRank: 1,
            targetMediaId: "target-1",
            decisionScore: 0.93
          }),
          expect.objectContaining({
            relationRank: 2,
            targetMediaId: "target-2",
            decisionScore: 0.71
          })
        ]
      }),
      expect.objectContaining({
        sourceMediaId: "source-2",
        candidates: [
          expect.objectContaining({
            relationRank: 1,
            targetMediaId: "target-2",
            decisionScore: 0.88
          }),
          expect.objectContaining({
            relationRank: 2,
            targetMediaId: "target-1",
            decisionScore: 0.62
          })
        ]
      })
    ]);
    expect(receipt.sourceRankings[0]?.topK.map((candidate) => candidate.targetMediaId)).toEqual(
      ["target-1", "target-2"]
    );
    expect(receipt.targetRankings).toEqual([
      expect.objectContaining({
        targetMediaId: "target-1",
        candidates: [
          expect.objectContaining({ relationRank: 1, sourceMediaId: "source-1" }),
          expect.objectContaining({ relationRank: 2, sourceMediaId: "source-2" })
        ]
      }),
      expect.objectContaining({
        targetMediaId: "target-2",
        candidates: [
          expect.objectContaining({ relationRank: 1, sourceMediaId: "source-2" }),
          expect.objectContaining({ relationRank: 2, sourceMediaId: "source-1" })
        ]
      })
    ]);
    const serialized = JSON.stringify(receipt);
    for (const media of [...suite.sources, ...suite.targets]) {
      expect(serialized).not.toContain(media.path);
    }
    expect(serialized).not.toContain(suite.parameters.ffmpegPath);
    expect(serialized).not.toContain(suite.parameters.ffprobePath);
    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateRealMediaBlindBatchRunReceipt(receipt, suite)).toEqual(receipt);
  });

  it("把显式多版本复用策略从 execution suite 传到 native 请求并封入 path-free receipt", async () => {
    const suite = createSuite();
    suite.versionReuseGroups = [
      {
        groupId: "target-versions",
        side: "target",
        mediaIds: ["target-1", "target-2"]
      }
    ];
    const completed = bindSnapshotVersionReuseGroups(
      createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]),
      suite
    );
    const invoker = createInvoker({ start: completed, get: [] });

    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: invoker
    });

    expect(vi.mocked(invoker.start).mock.calls[0]?.[0].versionReuseGroups).toEqual(
      suite.versionReuseGroups
    );
    expect(receipt.versionReuseGroups).toEqual([
      {
        groupOrdinal: 1,
        groupId: "target-versions",
        side: "target",
        mediaIds: ["target-1", "target-2"]
      }
    ]);
    expect(
      receipt.pairOutcomes.every((outcome) =>
        outcome.fineFrontier?.inventoryCandidates
          .filter((candidate) => candidate.id.pairOrdinal === outcome.pairOrdinal)
          .every((candidate) => candidate.sourceAxisReuseGroupOrdinal === 1)
      )
    ).toBe(true);
    expect(validateRealMediaBlindBatchRunReceipt(receipt, suite)).toEqual(receipt);
  });

  it("完整 fine inventory 可封存未达到 intrinsic 门槛的 raw coarse 成员", async () => {
    const suite = createSuite();
    const snapshot = createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]);
    for (const pair of snapshot.pairs) {
      const frontier = pair.fineFrontier;
      if (frontier === null) throw new Error("fixture fine frontier missing");
      frontier.inventoryCandidates[0].members[0].inlierCount = 5;
      frontier.inventoryCandidates[0].members[0].temporalCoverage = 0.19;
      frontier.inventoryDigest = createNativeBatchFineInventoryDigest(
        frontier.inventoryCandidates
      );
      frontier.receiptDigest = createNativeBatchFineFrontierReceiptDigest(frontier);
    }

    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({ start: snapshot, get: [] })
    });

    expect(receipt.pairOutcomes[0].fineFrontier?.inventoryCandidates[0].members[0]).toMatchObject({
      inlierCount: 5,
      temporalCoverage: 0.19
    });
    expect(validateRealMediaBlindBatchRunReceipt(receipt, suite)).toEqual(receipt);
  });

  it("resolved component 只要求最终选中 pair 携带 TimeMap，未选中 alternative 保持 completed+null", async () => {
    const suite = createSuite();
    const snapshot = createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]);
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({ start: snapshot, get: [] })
    });

    expect(receipt.pairOutcomes[0]?.nativeStatus).toBe("completed");
    expect(receipt.pairOutcomes[0]?.fineExecutionEvidence).not.toBeNull();
    expect(receipt.pairOutcomes[0]?.proposalTimeMap).not.toBeNull();
    expect(receipt.pairOutcomes[1]).toMatchObject({
      nativeStatus: "completed",
      fineExecutionEvidence: null,
      proposalTimeMap: null
    });
    expect(validateRealMediaBlindBatchRunReceipt(receipt, suite)).toEqual(receipt);

    const alternativeWithTimeMap = structuredClone(receipt);
    const alternativePair = suite.pairs[1];
    const alternativeSource = suite.sources.find(
      (media) => media.mediaId === alternativePair.sourceMediaId
    )!;
    const alternativeTarget = suite.targets.find(
      (media) => media.mediaId === alternativePair.targetMediaId
    )!;
    alternativeWithTimeMap.pairOutcomes[1].proposalTimeMap =
      createProposal(alternativeSource, alternativeTarget, "review").timeMap ?? null;
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(alternativeWithTimeMap), suite)
    ).toThrow("未被最终选择却夹带 fine execution 或 TimeMap");

    const selectedWithoutTimeMap = structuredClone(receipt);
    selectedWithoutTimeMap.pairOutcomes[0].proposalTimeMap = null;
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(selectedWithoutTimeMap), suite)
    ).toThrow("最终 candidate 与 fine execution 不一致");
  });

  it("启用 live-process 会话时只封存严格验证后的 native receipt digest", async () => {
    const suite = createSuite();
    const snapshot = createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]);
    const sealBlindBatch = vi.fn(
      (
        _sessionId: string,
        nativeRunId: string,
        evidenceDigest: `sha256:${string}`
      ): Promise<C137ProcessEvidenceBindingV1> =>
        Promise.resolve({
          evidenceKind: "blind-batch-receipt",
          nativeRunId,
          evidenceDigest
        })
    );
    const processInvoker: C137ProcessAttestationInvoker = {
      begin: () => Promise.reject(new Error("unused")),
      sealBlindBatch,
      sealPerformance: () => Promise.reject(new Error("unused")),
      finalize: () => Promise.reject(new Error("unused"))
    };

    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({ start: snapshot, get: [] }),
      liveProcessAttestationSessionId: "live-process-runner-test",
      processAttestationInvoker: processInvoker
    });

    expect(sealBlindBatch).toHaveBeenCalledWith(
      "live-process-runner-test",
      receipt.nativeJobId,
      receipt.receiptDigest
    );
  });

  it.each(["unresolved", "noEligibleCandidate"] as const)(
    "%s component 允许 completed pair 保留 frontier 且 TimeMap 全部为空",
    async (finalState) => {
      const suite = createSuite();
      const snapshot = createCompletedSnapshotWithoutFineSelection(
        suite,
        [0.93, 0.71, 0.62, 0.88],
        finalState
      );
      const receipt = await runRealMediaBlindBatchSuite(suite, {
        alignmentInvoker: createInvoker({ start: snapshot, get: [] })
      });

      expect(receipt.status).toBe("completed");
      expect(
        receipt.pairOutcomes.every(
          (outcome) =>
            outcome.nativeStatus === "completed" &&
            outcome.fineFrontier?.finalState === finalState &&
            outcome.fineExecutionEvidence === null &&
            outcome.proposalTimeMap === null
        )
      ).toBe(true);
      expect(validateRealMediaBlindBatchRunReceipt(receipt, suite)).toEqual(receipt);
    }
  );

  it("receipt 即使由调用方重签也拒绝篡改 fine backendDetail", async () => {
    const suite = createSuite();
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({
        start: createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]),
        get: []
      })
    });
    const tampered = structuredClone(receipt);
    const execution = tampered.pairOutcomes[0]?.fineExecutionEvidence;
    if (execution === null || execution === undefined) {
      throw new Error("fixture fine execution missing");
    }
    execution.sourceFineBackend.backendDetail = "caller-forged fine backend detail";
    execution.evidenceDigest = createNativeBatchFineExecutionEvidenceDigest(execution);

    expect(() => validateRealMediaBlindBatchRunReceipt(rehashReceipt(tampered), suite)).toThrow(
      "coarse→fine backend continuity"
    );
  });

  it("注入 receipt 时复算两个 digest，并拒绝 pair/双向排名/TimeMap exact-key 篡改", async () => {
    const suite = createSuite();
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({
        start: createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]),
        get: []
      })
    });

    expect(() =>
      validateRealMediaBlindBatchRunReceipt({ ...receipt, gold: null }, suite)
    ).toThrow("字段不完整或含 gold/额外字段");

    const wrongExecution = rehashReceipt({
      ...receipt,
      executionDigest: `sha256:${"f".repeat(64)}`
    });
    expect(() => validateRealMediaBlindBatchRunReceipt(wrongExecution, suite)).toThrow(
      "executionDigest"
    );

    const wrongPairs = structuredClone(receipt);
    [wrongPairs.pairOutcomes[0], wrongPairs.pairOutcomes[1]] = [
      wrongPairs.pairOutcomes[1],
      wrongPairs.pairOutcomes[0]
    ];
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(wrongPairs), suite)
    ).toThrow("source-major");

    const missingRanking = structuredClone(receipt);
    missingRanking.sourceRankings[0].candidates.pop();
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(missingRanking), suite)
    ).toThrow("sourceRankings");

    const extraTimeMapField = structuredClone(receipt);
    const timeMap = extraTimeMapField.pairOutcomes[0].proposalTimeMap;
    if (!timeMap) throw new Error("fixture TimeMap missing");
    const timeMapWithGold: AlignmentTimeMapProposal & { goldLeak: boolean } = {
      ...timeMap,
      goldLeak: true
    };
    extraTimeMapField.pairOutcomes[0].proposalTimeMap = timeMapWithGold;
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(extraTimeMapField), suite)
    ).toThrow("字段不完整或含 gold/额外字段");

    const wrongRelationScoreVersion = structuredClone(receipt);
    (
      wrongRelationScoreVersion.pairOutcomes[0].relationRanking as {
        scoreVersion: string;
      }
    ).scoreVersion = "tile-local-score-v0";
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(wrongRelationScoreVersion), suite)
    ).toThrow("relationRanking.scoreVersion");

    const wrongRelationStream = structuredClone(receipt);
    const relationCandidate =
      wrongRelationStream.pairOutcomes[0].relationRanking.bestEligibleCandidate;
    if (!relationCandidate) throw new Error("fixture relation candidate missing");
    relationCandidate.sourceStreamIndex += 1;
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(wrongRelationStream), suite)
    ).toThrow("音轨索引与 execution suite 错配");

    const callerResignedIdentityDrift = structuredClone(receipt);
    const driftedRanking = callerResignedIdentityDrift.pairOutcomes[0].relationRanking;
    if (!driftedRanking.executionIdentity) throw new Error("fixture identity missing");
    driftedRanking.executionIdentity.ffmpegBinaryDigest = `sha256:${"e".repeat(64)}`;
    driftedRanking.executionIdentityDigest = createNativeBatchExecutionIdentityDigest(
      driftedRanking.executionIdentity
    );
    expect(() =>
      validateRealMediaBlindBatchRunReceipt(rehashReceipt(callerResignedIdentityDrift), suite)
    ).toThrow("executionIdentityDigest");

    const legacyReceipt = structuredClone(receipt) as unknown as Record<string, unknown>;
    delete legacyReceipt.executionIdentityDigest;
    expect(() => validateRealMediaBlindBatchRunReceipt(legacyReceipt, suite)).toThrow(
      "字段不完整"
    );

    expect(() =>
      validateRealMediaBlindBatchRunReceipt(
        { ...receipt, receiptDigest: `sha256:${"0".repeat(64)}` },
        suite
      )
    ).toThrow("receiptDigest");
  });

  it("rejects a path leaked through an actual backend fallback reason", async () => {
    const suite = createSuite();
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({
        start: createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]),
        get: []
      })
    });
    const leaked = structuredClone(receipt);
    for (const outcome of leaked.pairOutcomes) {
      const identity = outcome.relationRanking.executionIdentity;
      const backend = identity?.sourceSpectralBackends[0];
      if (!identity || !backend) throw new Error("fixture identity missing");
      backend.requestedBackend = "auto";
      backend.fallbackReason = `CUDA fallback while reading ${suite.sources[0].path}`;
      const fineExecution = outcome.fineExecutionEvidence;
      if (fineExecution !== null) {
        fineExecution.sourceCoarseBackend = { ...backend };
        fineExecution.sourceFineBackend = {
          ...fineExecution.sourceFineBackend,
          requestedBackend: backend.requestedBackend,
          fallbackReason: backend.fallbackReason
        };
        fineExecution.evidenceDigest =
          createNativeBatchFineExecutionEvidenceDigest(fineExecution);
      }
      outcome.relationRanking.executionIdentityDigest =
        createNativeBatchExecutionIdentityDigest(identity);
    }
    leaked.executionIdentityDigest =
      leaked.pairOutcomes[0]?.relationRanking.executionIdentityDigest ?? null;

    expect(() => validateRealMediaBlindBatchRunReceipt(rehashReceipt(leaked), suite)).toThrow(
      "意外包含本地路径"
    );
  });

  it("canonical execution digest 对对象字段顺序稳定，并绑定媒体路径与全笛卡尔注册", () => {
    const suite = createSuite();
    const reordered = {
      parameters: { ...suite.parameters },
      pairs: suite.pairs.map((pair) => ({ ...pair })),
      targets: suite.targets.map((media) => ({ ...media })),
      sources: suite.sources.map((media) => ({ ...media })),
      versionReuseGroups: suite.versionReuseGroups.map((group) => structuredClone(group)),
      topK: suite.topK,
      datasetVersion: suite.datasetVersion,
      suiteId: suite.suiteId,
      schemaVersion: suite.schemaVersion
    };
    expect(createRealMediaBlindBatchExecutionDigest(reordered)).toBe(
      createRealMediaBlindBatchExecutionDigest(suite)
    );
    const changedPath = structuredClone(suite);
    changedPath.sources[0].path = "D:\\other\\source-1.mkv";
    expect(createRealMediaBlindBatchExecutionDigest(changedPath)).not.toBe(
      createRealMediaBlindBatchExecutionDigest(suite)
    );
  });

  it.each([
    ["single pair", () => createSuite(1, 1), "single-pair"],
    [
      "root gold field",
      () => ({ ...createSuite(), gold: { sourceMediaId: "source-1" } }),
      "gold/额外字段"
    ],
    [
      "nested gold field",
      () => {
        const suite = createSuite() as RealMediaBlindBatchExecutionSuite & {
          sources: Array<RealMediaBlindBatchExecutionMedia & { gold?: string }>;
        };
        suite.sources[0].gold = "target-1";
        return suite;
      },
      "gold/额外字段"
    ],
    [
      "missing Cartesian pair",
      () => {
        const suite = createSuite();
        suite.pairs.pop();
        return suite;
      },
      "完整注册"
    ],
    [
      "duplicate/reordered Cartesian pair",
      () => {
        const suite = createSuite();
        suite.pairs[1] = { ...suite.pairs[0], pairOrdinal: 2 };
        return suite;
      },
      "source-major"
    ],
    [
      "duplicate media id",
      () => {
        const suite = createSuite();
        suite.targets[0].mediaId = suite.sources[0].mediaId;
        return suite;
      },
      "ID 重复"
    ],
    [
      "duplicate media path",
      () => {
        const suite = createSuite();
        suite.targets[0].path = suite.sources[0].path.toUpperCase();
        return suite;
      },
      "同一本地路径声明了不同内容身份"
    ],
    [
      "duplicate media identity",
      () => {
        const suite = createSuite();
        suite.targets[0].contentIdentity = { ...suite.sources[0].contentIdentity };
        suite.targets[0].audioStreamIndex = suite.sources[0].audioStreamIndex;
        suite.targets[0].videoStreamIndex = suite.sources[0].videoStreamIndex;
        return suite;
      },
      "重复的内容身份与有效流视图"
    ]
  ])(
    "在 native 启动前拒绝不严格的 gold-free execution suite：%s",
    async (_label, create, message) => {
      const invoker = createInvoker({ start: createRunningSnapshot(createSuite()), get: [] });
      await expect(
        runRealMediaBlindBatchSuite(create(), { alignmentInvoker: invoker })
      ).rejects.toThrow(message);
      expect(invoker.start).not.toHaveBeenCalled();
    }
  );

  it("允许同一物理媒体以不同显式流视图进入盲测批次", () => {
    const suite = createSuite();
    suite.targets[0].path = suite.sources[0].path;
    suite.targets[0].contentIdentity = { ...suite.sources[0].contentIdentity };
    suite.targets[0].audioStreamIndex = suite.sources[0].audioStreamIndex + 1;

    expect(validateRealMediaBlindBatchExecutionSuite(suite).targets[0]).toMatchObject({
      path: suite.sources[0].path,
      contentIdentity: suite.sources[0].contentIdentity,
      audioStreamIndex: suite.sources[0].audioStreamIndex + 1
    });
  });

  it("domain contract 接受 1×256 inventory，并在 1×257 时拒绝", () => {
    expect(validateRealMediaBlindBatchExecutionSuite(createSuite(1, 256)).targets).toHaveLength(
      256
    );
    expect(() => validateRealMediaBlindBatchExecutionSuite(createSuite(1, 257))).toThrow(
      /1–256|最多允许 256/
    );
  });

  it("关闭视觉证据时拒绝同物理内容同音轨仅视频流不同的伪独立视图", () => {
    const suite = createSuite();
    suite.sources[0].videoStreamIndex = 0;
    suite.targets[0].path = suite.sources[0].path;
    suite.targets[0].contentIdentity = { ...suite.sources[0].contentIdentity };
    suite.targets[0].audioStreamIndex = suite.sources[0].audioStreamIndex;
    suite.targets[0].videoStreamIndex = 1;

    expect(() => validateRealMediaBlindBatchExecutionSuite(suite)).toThrow(
      "关闭视觉证据时，仅视频流不同不能形成独立候选"
    );
  });

  it("开启视觉证据时允许同物理内容同音轨以不同显式视频流形成独立视图", () => {
    const suite = createSuite();
    suite.parameters.enableVisualEvidence = true;
    suite.sources[0].videoStreamIndex = 0;
    suite.targets[0].path = suite.sources[0].path;
    suite.targets[0].contentIdentity = { ...suite.sources[0].contentIdentity };
    suite.targets[0].audioStreamIndex = suite.sources[0].audioStreamIndex;
    suite.targets[0].videoStreamIndex = 1;

    expect(validateRealMediaBlindBatchExecutionSuite(suite).targets[0]).toMatchObject({
      contentIdentity: suite.sources[0].contentIdentity,
      audioStreamIndex: suite.sources[0].audioStreamIndex,
      videoStreamIndex: 1
    });
  });

  it("视觉 auto 模式要求 native 实际回报视频流，并接受任一实际流索引", async () => {
    const suite = createSuite();
    suite.parameters.enableVisualEvidence = true;
    const completed = createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]);
    for (const pair of completed.pairs) {
      const timeMap = pair.proposal?.timeMap;
      if (!timeMap) continue;
      timeMap.sourceVisualStream = createVideoStream(20 + pair.pairIndex);
      timeMap.targetVisualStream = createVideoStream(40 + pair.pairIndex);
      timeMap.evidence.types = ["audio", "visual"];
      timeMap.evidence.visualAnchorCount = 8;
      refreshPairFineExecution(pair);
    }

    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({ start: completed, get: [] })
    });

    expect(receipt.pairOutcomes[0].proposalTimeMap?.sourceVisualStream?.index).toBe(20);
    expect(receipt.pairOutcomes[0].proposalTimeMap?.targetVisualStream?.index).toBe(40);
  });

  it("视觉开启但 native 未实际消费视频流时整批失败关闭", async () => {
    const suite = createSuite();
    suite.parameters.enableVisualEvidence = true;

    await expect(
      runRealMediaBlindBatchSuite(suite, {
        alignmentInvoker: createInvoker({
          start: createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]),
          get: []
        })
      })
    ).rejects.toThrow("未证明视觉证据实际消费了视频流");
  });

  it("视觉关闭时拒绝 native 意外混入视觉流", async () => {
    const suite = createSuite();
    const completed = createCompletedSnapshot(suite, [0.93, 0.71, 0.62, 0.88]);
    const timeMap = completed.pairs[0].proposal?.timeMap;
    if (!timeMap) throw new Error("fixture TimeMap missing");
    timeMap.sourceVisualStream = createVideoStream(0);
    refreshPairFineExecution(completed.pairs[0]);

    await expect(
      runRealMediaBlindBatchSuite(suite, {
        alignmentInvoker: createInvoker({ start: completed, get: [] })
      })
    ).rejects.toThrow("关闭视觉证据时意外存在");
  });

  it("允许 Top-K 绑定 source 或 target 任一显式关系查询轴", () => {
    const targetQuerySuite = createSuite(5, 2);
    targetQuerySuite.topK = 5;

    expect(validateRealMediaBlindBatchExecutionSuite(targetQuerySuite).topK).toBe(5);
  });

  it.each([
    [
      "explicit pairing mode",
      (snapshot: AudioAlignmentBatchJobSnapshot) => ({
        ...snapshot,
        pairingMode: "explicit" as const
      }),
      "fullCartesian"
    ],
    [
      "wrong source inventory order",
      (snapshot: AudioAlignmentBatchJobSnapshot) => ({
        ...snapshot,
        sourceMediaIds: [...snapshot.sourceMediaIds].reverse()
      }),
      "fullCartesian"
    ],
    [
      "missing pair",
      (snapshot: AudioAlignmentBatchJobSnapshot) => ({
        ...snapshot,
        totalPairCount: snapshot.totalPairCount - 1,
        pairs: snapshot.pairs.slice(0, -1)
      }),
      "pair"
    ],
    [
      "wrong pair index",
      (snapshot: AudioAlignmentBatchJobSnapshot) => ({
        ...snapshot,
        pairs: snapshot.pairs.map((pair, index) =>
          index === 1 ? { ...pair, pairIndex: 2 } : pair
        )
      }),
      "pairIndex"
    ],
    [
      "wrong pair media",
      (snapshot: AudioAlignmentBatchJobSnapshot) => ({
        ...snapshot,
        pairs: snapshot.pairs.map((pair, index) =>
          index === 1 ? { ...pair, targetMediaId: "target-1" } : pair
        )
      }),
      "pair"
    ]
  ])(
    "拒绝 native full-Cartesian 证明缺失、增删或 ordinal/身份错配：%s",
    async (_label, mutate, message) => {
      const suite = createSuite();
      const malformed = mutate(createRunningSnapshot(suite));
      const invoker = createInvoker({ start: malformed, get: [] });
      await expect(
        runRealMediaBlindBatchSuite(suite, { alignmentInvoker: invoker })
      ).rejects.toThrow(message);
      expect(invoker.start).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    [
      "non V2 engine",
      (proposal: AlignmentProposal) => ({
        ...proposal,
        timeMap: { ...proposal.timeMap!, engineVersion: "legacy-v9" }
      }),
      "Alignment V2"
    ],
    [
      "identity mismatch",
      (proposal: AlignmentProposal) => ({
        ...proposal,
        timeMap: { ...proposal.timeMap!, sourceIdentity: createIdentity(9) }
      }),
      "媒体身份错配"
    ],
    [
      "stream mismatch",
      (proposal: AlignmentProposal) => ({
        ...proposal,
        timeMap: {
          ...proposal.timeMap!,
          sourceStream: { ...proposal.timeMap!.sourceStream!, index: 63 }
        }
      }),
      "音轨索引错配"
    ]
  ])(
    "拒绝 completed native pair 的非 V2 proposal 或媒体/索引错配：%s",
    async (_label, mutate, message) => {
      const suite = createSuite();
      const snapshot = createCompletedSnapshot(suite, [0.9, 0.8, 0.7, 0.6]);
      snapshot.pairs[0] = {
        ...snapshot.pairs[0],
        proposal: mutate(snapshot.pairs[0].proposal!)
      };
      refreshPairFineExecution(snapshot.pairs[0]);
      const invoker = createInvoker({ start: snapshot, get: [] });
      await expect(
        runRealMediaBlindBatchSuite(suite, { alignmentInvoker: invoker })
      ).rejects.toThrow(message);
    }
  );

  it("严格要求结构化 globalSelection，且不从 proposal quality/诊断文案推断 selected", async () => {
    const suite = createSuite();
    const snapshot = createCompletedSnapshot(suite, [0.9, 0.8, 0.7, 0.6]);
    const decisionCandidate = snapshot.pairs[0].globalSelection.decisionCandidate;
    if (!decisionCandidate) throw new Error("fixture decision candidate missing");
    snapshot.pairs[0] = {
      ...snapshot.pairs[0],
      globalSelection: {
        ...snapshot.pairs[0].globalSelection,
        state: "blocked",
        selected: false,
        selectedRank: null,
        selectedScore: null,
        topK: snapshot.pairs[0].globalSelection.topK.map((candidate) => ({
          ...candidate,
          globalSelected: false
        })),
        decisionCandidate: {
          ...decisionCandidate,
          globalSelected: false
        }
      }
    };
    const invoker = createInvoker({ start: snapshot, get: [] });
    const receipt = await runRealMediaBlindBatchSuite(suite, { alignmentInvoker: invoker });
    expect(receipt.pairOutcomes[0]?.proposalTimeMap?.quality.level).toBe("review");
    expect(receipt.pairOutcomes[0]?.globalSelected).toBe(false);
  });

  it("coarse globalSelection 失败时仍接受已闭合的 fine frontier，且不误报 coarse selected", async () => {
    const suite = createSuite();
    const snapshot = createCompletedSnapshot(suite, [0.9, 0.8, 0.7, 0.6]);
    const pair = snapshot.pairs[0];
    const failedSelection: AudioAlignmentBatchGlobalSelectionSnapshot = {
      ...pair.globalSelection,
      state: "failed",
      selected: false,
      selectedRank: null,
      selectedScore: null,
      topK: pair.globalSelection.topK.map((candidate) => ({
        ...candidate,
        globalSelected: false
      })),
      decisionCandidate: pair.globalSelection.decisionCandidate
        ? { ...pair.globalSelection.decisionCandidate, globalSelected: false }
        : null
    };
    snapshot.pairs[0] = {
      ...pair,
      globalSelection: failedSelection
    };
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: createInvoker({ start: snapshot, get: [] })
    });
    expect(receipt.status).toBe("completed");
    expect(receipt.pairOutcomes[0]).toMatchObject({
      nativeStatus: "completed",
      failureCode: null,
      globalSelected: false,
      globalSelection: {
        state: "failed",
        candidateCount: 1,
        decisionScore: 0.9
      },
      relationRanking: {
        state: "ranked",
        candidateCount: 1,
        eligibleCandidateCount: 1,
        score: 0.9
      }
    });
    expect(receipt.pairOutcomes[0].relationRanking.bestEligibleCandidate?.globalScore).toBe(
      0.9
    );
    expect(validateRealMediaBlindBatchRunReceipt(receipt, suite)).toEqual(receipt);
  });

  it("AbortSignal 会取消同一个 job、等待终态，并保留完整 cancelled outcomes", async () => {
    const suite = createSuite();
    const controller = new AbortController();
    const running = createRunningSnapshot(suite);
    const cancelled = createCancelledSnapshot(suite);
    const invoker = createInvoker({ start: running, get: [running], cancel: cancelled });
    let now = 0;
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: invoker,
      signal: controller.signal,
      pollIntervalMs: 1,
      now: () => now,
      wait: () => {
        now += 1;
        controller.abort();
        return Promise.resolve();
      }
    });
    expect(invoker.start).toHaveBeenCalledTimes(1);
    expect(invoker.cancel).toHaveBeenCalledTimes(1);
    expect(invoker.cancel).toHaveBeenCalledWith("blind-batch-job");
    expect(receipt.status).toBe("cancelled");
    expect(receipt.terminationReason).toBe("abort-signal");
    expect(receipt.pairOutcomes).toHaveLength(4);
    expect(receipt.pairOutcomes.every((outcome) => outcome.nativeStatus === "cancelled")).toBe(
      true
    );
  });

  it("超过 wall timeout 后请求取消，并把已清理终态记录为 timed-out", async () => {
    const suite = createSuite();
    const running = createRunningSnapshot(suite);
    const invoker = createInvoker({
      start: running,
      get: [running],
      cancel: createCancelledSnapshot(suite)
    });
    let now = 0;
    const receipt = await runRealMediaBlindBatchSuite(suite, {
      alignmentInvoker: invoker,
      maxJobWallMs: 10,
      pollIntervalMs: 10,
      now: () => now,
      wait: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      }
    });
    expect(invoker.cancel).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("timed-out");
    expect(receipt.terminationReason).toBe("job-timeout");
  });

  it("取消后超过 grace 仍非终态会 fail-close", async () => {
    const suite = createSuite();
    const controller = new AbortController();
    const running = createRunningSnapshot(suite);
    const invoker = createInvoker({ start: running, get: [running, running], cancel: running });
    let now = 0;
    await expect(
      runRealMediaBlindBatchSuite(suite, {
        alignmentInvoker: invoker,
        signal: controller.signal,
        pollIntervalMs: 5,
        cancellationGraceMs: 5,
        now: () => now,
        wait: (milliseconds) => {
          now += milliseconds;
          controller.abort();
          return Promise.resolve();
        }
      })
    ).rejects.toThrow("取消宽限期");
    expect(invoker.cancel).toHaveBeenCalledTimes(1);
  });
});

function createSuite(sourceCount = 2, targetCount = 2): RealMediaBlindBatchExecutionSuite {
  const sources = Array.from({ length: sourceCount }, (_, index) =>
    createMedia("source", index + 1, index + 1)
  );
  const targets = Array.from({ length: targetCount }, (_, index) =>
    createMedia("target", index + 1, sourceCount + index + 1)
  );
  return {
    schemaVersion: 2,
    suiteId: "blind-suite-1",
    datasetVersion: "frozen-v1",
    topK: Math.min(2, targetCount),
    sources,
    targets,
    pairs: sources.flatMap((source) =>
      targets.map((target, targetIndex) => ({
        pairOrdinal:
          sources.findIndex((candidate) => candidate.mediaId === source.mediaId) *
            targets.length +
          targetIndex +
          1,
        sourceMediaId: source.mediaId,
        targetMediaId: target.mediaId
      }))
    ),
    versionReuseGroups: [],
    parameters: {
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      ffprobePath: "C:\\tools\\ffprobe.exe",
      sampleRate: 16_000,
      windowMs: 50,
      matchThreshold: 0.72,
      minGapMs: 500,
      maxCells: 2_000_000,
      enableVisualEvidence: false,
      visualSampleIntervalMs: null
    }
  };
}

function createMedia(
  side: "source" | "target",
  ordinal: number,
  identitySeed: number
): RealMediaBlindBatchExecutionMedia {
  return {
    mediaId: `${side}-${ordinal}`,
    path: `D:\\media\\${side}-${ordinal}.mkv`,
    contentIdentity: createIdentity(identitySeed),
    audioStreamIndex: side === "source" ? ordinal : ordinal + 10,
    videoStreamIndex: null
  };
}

function createIdentity(seed: number): MediaContentIdentity {
  const hex = seed.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: seed * 1_000_000,
    modifiedUnixMs: seed * 1_000,
    firstSampleDigest: hex,
    middleSampleDigest: hex,
    lastSampleDigest: hex
  };
}

function createRunningSnapshot(
  suite: RealMediaBlindBatchExecutionSuite
): AudioAlignmentBatchJobSnapshot {
  const pairs = suite.pairs.map((pair, pairIndex): AudioAlignmentBatchPairSnapshot => ({
    pairIndex,
    pairOrdinal: pair.pairOrdinal,
    sourceMediaId: pair.sourceMediaId,
    targetMediaId: pair.targetMediaId,
    status: pairIndex === 0 ? "running" : "queued",
    progress: 0,
    message: pairIndex === 0 ? "running" : "queued",
    globalSelection: createPendingSelection(),
    relationRanking: createPendingRelationRanking(),
    fineFrontier: null,
    fineExecutionEvidence: null,
    proposal: null,
    error: null
  }));
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "blind-batch-job",
    pairingMode: "fullCartesian",
    sourceMediaIds: suite.sources.map((media) => media.mediaId),
    targetMediaIds: suite.targets.map((media) => media.mediaId),
    versionReuseGroups: suite.versionReuseGroups.map((group, index) => ({
      ...structuredClone(group),
      groupOrdinal: index + 1
    })),
    status: "running",
    progress: 0,
    message: "running",
    totalPairCount: pairs.length,
    processedPairCount: 0,
    failedPairCount: 0,
    currentPairOrdinal: 1,
    diagnosticEvents: [],
    pairs,
    error: null,
    updatedAtMs: 1
  };
}

function createCompletedSnapshot(
  suite: RealMediaBlindBatchExecutionSuite,
  scores: readonly number[]
): AudioAlignmentBatchJobSnapshot {
  const selectedPairIndexes = new Set([0, suite.pairs.length - 1]);
  const selectedCandidateIds = suite.pairs
    .filter((_, pairIndex) => selectedPairIndexes.has(pairIndex))
    .map((pair) => ({ pairOrdinal: pair.pairOrdinal, candidateOrdinal: 1 }));
  const fineFrontier = createTestFineFrontierReceipt(
    suite.pairs.map((pair) => pair.pairOrdinal),
    selectedCandidateIds
  );
  const pairs = suite.pairs.map((pair, pairIndex): AudioAlignmentBatchPairSnapshot => {
    const source = suite.sources.find((media) => media.mediaId === pair.sourceMediaId)!;
    const target = suite.targets.find((media) => media.mediaId === pair.targetMediaId)!;
    const selected = selectedPairIndexes.has(pairIndex);
    const score = scores[pairIndex] ?? 0.5;
    const proposal = createProposal(source, target, selected ? "review" : "blocked");
    return {
      pairIndex,
      pairOrdinal: pair.pairOrdinal,
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId,
      status: "completed",
      progress: 1,
      message: "completed",
      globalSelection: createSelection(source, target, score, selected),
      relationRanking: createRelationRanking(source, target, score),
      fineFrontier: structuredClone(fineFrontier),
      fineExecutionEvidence:
        selected && proposal.timeMap
          ? createTestFineExecutionEvidence(proposal.timeMap, {
              pairOrdinal: pair.pairOrdinal,
              sourceStreamIndex: source.audioStreamIndex,
              targetStreamIndex: target.audioStreamIndex,
              engineVersion: TEST_EXECUTION_IDENTITY.engineVersion,
              featureVersion: TEST_EXECUTION_IDENTITY.featureVersion,
              coarseBackend: TEST_EXECUTION_IDENTITY.sourceSpectralBackends[0],
              fineBackend: TEST_EXECUTION_IDENTITY.sourceSpectralBackends[0]
            })
          : null,
      proposal,
      error: null
    };
  });
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "blind-batch-job",
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
    failedPairCount: 0,
    currentPairOrdinal: null,
    diagnosticEvents: [],
    pairs,
    error: null,
    updatedAtMs: 2
  };
}

function createCompletedSnapshotWithoutFineSelection(
  suite: RealMediaBlindBatchExecutionSuite,
  scores: readonly number[],
  finalState: "unresolved" | "noEligibleCandidate"
): AudioAlignmentBatchJobSnapshot {
  const snapshot = createCompletedSnapshot(suite, scores);
  const componentPairOrdinals = suite.pairs.map((pair) => pair.pairOrdinal);
  const candidateIds = componentPairOrdinals.map((pairOrdinal) => ({
    pairOrdinal,
    candidateOrdinal: 1
  }));
  const frontier = createTestFineFrontierReceipt(componentPairOrdinals, [], {
    finalState,
    inventoryCandidateCount: candidateIds.length
  });
  if (finalState === "unresolved") {
    frontier.inventoryStateCounts.unresolved = 0;
    frontier.inventoryStateCounts.evidenceBlocked = candidateIds.length;
    frontier.optimisticOmitted = {
      candidateIds: structuredClone(candidateIds),
      totalUpperBoundMicros: candidateIds.length * 900_000,
      openCandidateIds: structuredClone(candidateIds),
      unresolvedCandidateIds: [],
      blockedCandidateIds: structuredClone(candidateIds)
    };
    frontier.proof.beatsRunnerUpWithMargin = true;
    frontier.receiptDigest = createNativeBatchFineFrontierReceiptDigest(frontier);
  }
  for (const pair of snapshot.pairs) {
    const source = suite.sources.find((media) => media.mediaId === pair.sourceMediaId)!;
    const target = suite.targets.find((media) => media.mediaId === pair.targetMediaId)!;
    pair.fineFrontier = structuredClone(frontier);
    pair.fineExecutionEvidence = null;
    pair.proposal = createProposal(source, target, "blocked");
  }
  return snapshot;
}

function refreshPairFineExecution(pair: AudioAlignmentBatchPairSnapshot): void {
  const timeMap = pair.proposal?.timeMap;
  const current = pair.fineExecutionEvidence;
  if (current === null) return;
  if (timeMap === undefined) throw new Error("fixture selected pair TimeMap missing");
  pair.fineExecutionEvidence = createTestFineExecutionEvidence(timeMap, {
    pairOrdinal: current.candidateId.pairOrdinal,
    candidateOrdinal: current.candidateId.candidateOrdinal,
    sourceStreamIndex: current.sourceStreamIndex,
    targetStreamIndex: current.targetStreamIndex,
    scoreMicros: current.scoreMicros,
    engineVersion: TEST_EXECUTION_IDENTITY.engineVersion,
    featureVersion: TEST_EXECUTION_IDENTITY.featureVersion,
    sourceCoarseBackend: current.sourceCoarseBackend,
    targetCoarseBackend: current.targetCoarseBackend,
    sourceFineBackend: current.sourceFineBackend,
    targetFineBackend: current.targetFineBackend
  });
}

function bindSnapshotVersionReuseGroups(
  snapshot: AudioAlignmentBatchJobSnapshot,
  suite: RealMediaBlindBatchExecutionSuite
): AudioAlignmentBatchJobSnapshot {
  snapshot.versionReuseGroups = suite.versionReuseGroups.map((group, index) => ({
    ...structuredClone(group),
    groupOrdinal: index + 1
  }));
  for (const pair of snapshot.pairs) {
    const frontier = pair.fineFrontier;
    if (frontier === null) continue;
    for (const candidate of frontier.inventoryCandidates) {
      const candidatePair = suite.pairs.find(
        (registration) => registration.pairOrdinal === candidate.id.pairOrdinal
      );
      if (candidatePair === undefined) throw new Error("fixture pair registration missing");
      candidate.sourceAxisReuseGroupOrdinal =
        snapshot.versionReuseGroups.find(
          (group) =>
            group.side === "target" && group.mediaIds.includes(candidatePair.targetMediaId)
        )?.groupOrdinal ?? null;
      candidate.targetAxisReuseGroupOrdinal =
        snapshot.versionReuseGroups.find(
          (group) =>
            group.side === "source" && group.mediaIds.includes(candidatePair.sourceMediaId)
        )?.groupOrdinal ?? null;
    }
    frontier.inventoryDigest = createNativeBatchFineInventoryDigest(
      frontier.inventoryCandidates
    );
    frontier.receiptDigest = createNativeBatchFineFrontierReceiptDigest(frontier);
  }
  return snapshot;
}

function createCancelledSnapshot(
  suite: RealMediaBlindBatchExecutionSuite
): AudioAlignmentBatchJobSnapshot {
  const pairs = suite.pairs.map((pair, pairIndex): AudioAlignmentBatchPairSnapshot => ({
    pairIndex,
    pairOrdinal: pair.pairOrdinal,
    sourceMediaId: pair.sourceMediaId,
    targetMediaId: pair.targetMediaId,
    status: "cancelled",
    progress: 0,
    message: "cancelled",
    globalSelection: { ...createPendingSelection(), state: "cancelled" },
    relationRanking: { ...createPendingRelationRanking(), state: "cancelled" },
    fineFrontier: null,
    fineExecutionEvidence: null,
    proposal: null,
    error: null
  }));
  return {
    schemaVersion: 2,
    evidenceVersion: 5,
    jobId: "blind-batch-job",
    pairingMode: "fullCartesian",
    sourceMediaIds: suite.sources.map((media) => media.mediaId),
    targetMediaIds: suite.targets.map((media) => media.mediaId),
    versionReuseGroups: suite.versionReuseGroups.map((group, index) => ({
      ...structuredClone(group),
      groupOrdinal: index + 1
    })),
    status: "cancelled",
    progress: 1,
    message: "cancelled",
    totalPairCount: pairs.length,
    processedPairCount: 0,
    failedPairCount: 0,
    currentPairOrdinal: null,
    diagnosticEvents: [],
    pairs,
    error: null,
    updatedAtMs: 3
  };
}

function createPendingSelection(): AudioAlignmentBatchGlobalSelectionSnapshot {
  return {
    state: "pending",
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
  };
}

function createPendingRelationRanking(): AudioAlignmentBatchRelationRankingSnapshot {
  return {
    scoreVersion: AUDIO_ALIGNMENT_BATCH_RELATION_SCORE_VERSION,
    executionIdentityDigest: null,
    executionIdentity: null,
    state: "pending",
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
  if (level === "blocked") {
    return {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: ["fixture blocked without a final TimeMap"]
    };
  }
  const timeMap: AlignmentTimeMapProposal = {
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      createTestCompleteTimeMapSpan(
        {
          kind: "matched",
          sourceStartMs: 0,
          sourceEndMs: 60_000,
          targetStartMs: 0,
          targetEndMs: 60_000
        },
        `${source.mediaId}-${target.mediaId}-span`
      )
    ],
    quality: {
      level: "review",
      probability: 0.91,
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
      reasons: ["需要复核。"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 40,
      visualAnchorCount: 0,
      heldOutAnchorCount: 8,
      top1Top2Margin: 0.25,
      uniqueContentCoverage: 0.9,
      repeatedContentOnly: false,
      selectedTrackReason: "blind test",
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
    sourceStream: createAudioStream(source.audioStreamIndex),
    targetStream: createAudioStream(target.audioStreamIndex),
    sourceVisualStream: null,
    targetVisualStream: null,
    sourceIdentity: { ...source.contentIdentity },
    targetIdentity: { ...target.contentIdentity },
    engineVersion: "alignment-v2.0-rust",
    featureVersion: "c137-test-features-v1",
    parametersHash: "sha256:test-parameters"
  };
  return {
    anchors: [],
    cutCandidates: [],
    confidence: 0.91,
    diagnostics: ["fixture"],
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 60_000,
      coverage: 0.95
    },
    timeMap
  };
}

function createAudioStream(index: number) {
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

function createVideoStream(index: number) {
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

function createInvoker(options: {
  start: AudioAlignmentBatchJobSnapshot;
  get: AudioAlignmentBatchJobSnapshot[];
  cancel?: AudioAlignmentBatchJobSnapshot;
}): AudioAlignmentBatchJobInvoker {
  const reads = [...options.get];
  const start = vi.fn<
    (
      request: NormalizedTauriAudioAlignmentBatchRequest
    ) => Promise<AudioAlignmentBatchJobSnapshot>
  >(() => Promise.resolve(structuredClone(options.start)));
  const get = vi.fn<(jobId: string) => Promise<AudioAlignmentBatchJobSnapshot>>(() => {
    const snapshot = reads.shift();
    if (!snapshot) return Promise.reject(new Error("unexpected get"));
    return Promise.resolve(structuredClone(snapshot));
  });
  const cancel = vi.fn<(jobId: string) => Promise<AudioAlignmentBatchJobSnapshot>>(() =>
    Promise.resolve(structuredClone(options.cancel ?? options.start))
  );
  return { start, get, cancel };
}

function rehashReceipt(receipt: RealMediaBlindBatchRunReceipt): RealMediaBlindBatchRunReceipt {
  const { receiptDigest: _previousDigest, ...withoutDigest } = receipt;
  void _previousDigest;
  return {
    ...withoutDigest,
    receiptDigest: createRealMediaBlindBatchRunReceiptDigest(withoutDigest)
  };
}
