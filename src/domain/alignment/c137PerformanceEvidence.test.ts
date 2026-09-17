import { describe, expect, it } from "vitest";
import {
  appendC137PerformanceCacheResetReceipt,
  appendC137PerformanceTrial,
  computeC137PerformanceCacheResetReceiptDigest,
  computeC137PerformanceCaseOutputDigest,
  computeC137PerformanceCanonicalDigest,
  computeC137PerformanceEnvironmentDigest,
  computeC137PerformanceEvidenceDigest,
  computeC137PerformanceEnvironmentDigestV2,
  computeC137PerformanceEvidenceDigestV2,
  computeC137PerformanceJobMemoryInventoryDigest,
  computeC137PerformanceJobMemoryReceiptDigest,
  computeC137PerformanceTerminalCleanupJobInventoryDigest,
  computeC137PerformanceTerminalCleanupReceiptDigest,
  computeC137PerformanceWorkloadStorageReceiptDigest,
  createC137PerformanceEvidenceDraft,
  createC137PerformancePlanDigest,
  finalizeC137PerformanceEvidence,
  parseC137PerformanceEvidence,
  projectC137PerformanceJobMemoryInventory,
  projectC137PerformanceTerminalCleanupJobInventory,
  serializeC137PerformanceEvidence,
  validateC137PerformanceEvidence,
  type C137PerformanceCacheCountsV1,
  type C137PerformanceCacheResetReceiptV1,
  type C137PerformanceCacheTelemetryV1,
  type C137PerformanceCancellationTrialV1,
  type C137PerformanceEnvironmentV1,
  type C137PerformanceMemoryTelemetryV1,
  type C137PerformanceNativeTelemetryV1,
  type C137PerformancePlanV1,
  type C137PerformanceRawEvidenceV1,
  type C137PerformanceRawEvidenceV2,
  type C137PerformanceJobMemoryReceiptV1,
  type C137PerformanceTerminalCleanupReceiptV1,
  type C137PerformanceRunKindV1,
  type C137PerformanceRunV1,
  type C137PerformanceStageTimingV1,
  type C137PerformanceTrialV1
} from "./c137PerformanceEvidence";
import { createCompleteC137PerformanceEvidenceV2Fixture } from "../../test/c137PerformanceEvidence";

const MEBIBYTE = 1_024 * 1_024;
const ONE_GIBIBYTE = 1_024 * MEBIBYTE;
const SESSION_ID = "session-00000001";
const PLAN_ID = "plan-00000001";
const COLD_ID = "trial-cold-0001";
const WARMUP_ID = "trial-warmup-01";
const HOT_ID = "trial-hot-00001";
const CANCELLATION_ID = "trial-cancel-001";
const WORKLOAD_DIGEST = digest("1");
const REQUEST_PARAMETERS_DIGEST = digest("2");
const TIME_MAP_DIGEST = digest("3");
const TIME_MAP_PARAMETERS_HASH = "fnv1a64:0123456789abcdef";
const OUTPUT_DIGEST = computeC137PerformanceCaseOutputDigest({
  caseOrdinal: 0,
  requestParametersDigest: REQUEST_PARAMETERS_DIGEST,
  timeMapParametersHash: TIME_MAP_PARAMETERS_HASH,
  timeMapDigest: TIME_MAP_DIGEST
});
const EMPTY_COUNTS: C137PerformanceCacheCountsV1 = {
  audioFeatureEntries: 0,
  landmarkEntries: 0,
  visualFeatureEntries: 0
};

describe("C137 raw performance evidence v1", () => {
  it("strictly round-trips a complete cold/warmup/hot/cancellation report", () => {
    const evidence = createCompleteEvidence();
    const validation = validateC137PerformanceEvidence(evidence);

    expect(validation).toEqual({
      valid: true,
      complete: true,
      issues: [],
      completenessIssues: []
    });
    expect(evidence.reportKind).toBe("c137-performance-raw-evidence");
    expect(evidence.releaseEligible).toBe(false);

    const serialized = serializeC137PerformanceEvidence(evidence);
    const parsed = parseC137PerformanceEvidence(serialized);
    expect(parsed).toEqual(evidence);
    expect(serializeC137PerformanceEvidence(parsed)).toBe(serialized);
  });

  it("recursively rejects unknown fields", () => {
    const evidence = createCompleteEvidence();
    const injected: unknown = {
      ...evidence,
      environment: {
        ...evidence.environment,
        localMediaPath: "C:\\private\\episode.mkv"
      }
    };

    const validation = validateC137PerformanceEvidence(injected);
    expect(validation.valid).toBe(false);
    expect(validation.complete).toBe(false);
    expect(validation.issues.some((issue) => issue.includes("localMediaPath"))).toBe(true);
    expect(() => parseC137PerformanceEvidence(JSON.stringify(injected))).toThrow();
  });

  it("rejects an expectedCaseCount above the bounded per-run case limit", () => {
    const evidence = cloneEvidence();
    evidence.plan.expectedCaseCount = 1_001;
    resignEvidence(evidence);

    const validation = validateC137PerformanceEvidence(evidence);
    expect(validation.valid).toBe(false);
    expect(validation.complete).toBe(false);
    expect(validation.issues.some((issue) => issue.includes("expectedCaseCount"))).toBe(true);
  });

  it("rejects internally inconsistent sampling and trial-plan fields", () => {
    const gapEvidence = cloneEvidence();
    gapEvidence.plan.maximumMemorySampleGapMs = 10;
    gapEvidence.plan.memorySampleIntervalMs = 20;
    gapEvidence.planDigest = createC137PerformancePlanDigest(gapEvidence.plan);
    resignEvidence(gapEvidence);
    expect(validateC137PerformanceEvidence(gapEvidence).valid).toBe(false);

    const trialEvidence = cloneEvidence();
    trialEvidence.plan.trialOrder[0].warmupTrialId = WARMUP_ID;
    trialEvidence.planDigest = createC137PerformancePlanDigest(trialEvidence.plan);
    resignEvidence(trialEvidence);
    expect(validateC137PerformanceEvidence(trialEvidence).valid).toBe(false);
  });

  it("rejects stale plan, evidence, environment, and cache-reset digests", () => {
    const planTamper = cloneEvidence();
    planTamper.plan.maximumMemorySampleGapMs += 1;
    resignEvidence(planTamper);
    expect(validateC137PerformanceEvidence(planTamper).valid).toBe(false);

    const evidenceTamper = cloneEvidence();
    requireRun(evidenceTamper.trials[0]).elapsedMs += 1;
    expect(validateC137PerformanceEvidence(evidenceTamper).valid).toBe(false);

    const environmentTamper = cloneEvidence();
    environmentTamper.environment.physicalCoreCount += 1;
    resignEvidence(environmentTamper);
    expect(validateC137PerformanceEvidence(environmentTamper).valid).toBe(false);

    const resetTamper = cloneEvidence();
    resetTamper.cacheResets[0].before.audioFeatureEntries += 1;
    resignEvidence(resetTamper);
    expect(validateC137PerformanceEvidence(resetTamper).valid).toBe(false);
  });

  it("fails closed when trials are selectively deleted, reordered, or duplicated", () => {
    const deleted = cloneEvidence();
    deleted.trials.splice(1, 1);
    resignEvidence(deleted);
    expect(validateC137PerformanceEvidence(deleted)).toMatchObject({
      valid: true,
      complete: false
    });

    const reordered = cloneEvidence();
    [reordered.trials[0], reordered.trials[1]] = [
      reordered.trials[1],
      reordered.trials[0]
    ];
    resignEvidence(reordered);
    expect(validateC137PerformanceEvidence(reordered)).toMatchObject({
      valid: true,
      complete: false
    });

    const duplicated = cloneEvidence();
    duplicated.trials[1] = structuredClone(duplicated.trials[0]);
    resignEvidence(duplicated);
    expect(validateC137PerformanceEvidence(duplicated)).toMatchObject({
      valid: false,
      complete: false
    });
  });

  it("rejects a cold run whose observed starting cache is not empty", () => {
    const evidence = cloneEvidence();
    const cold = requireRun(evidence.trials[0]);
    cold.cases[0].telemetry.cache.before.audioFeatureEntries = 1;
    resignEvidence(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toMatchObject({
      valid: true,
      complete: false
    });
  });

  it.each([
    ["cache miss", (hot: C137PerformanceRunV1) => {
      hot.cases[0].telemetry.cache.audioFeatures.misses = 1;
    }],
    ["cache eviction", (hot: C137PerformanceRunV1) => {
      hot.cases[0].telemetry.cache.audioFeatures.evictions = 1;
    }],
    ["different process session", (hot: C137PerformanceRunV1) => {
      hot.sessionId = "session-00000002";
    }]
  ])("rejects a hot run with %s", (_label, mutate) => {
    const evidence = cloneEvidence();
    mutate(requireRun(evidence.trials[2]));
    resignEvidence(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toMatchObject({
      valid: true,
      complete: false
    });
  });

  it("rejects inconsistent output digests", () => {
    const evidence = cloneEvidence();
    const hot = requireRun(evidence.trials[2]);
    hot.outputDigest = digest("3");
    hot.cases[0].outputDigest = digest("3");
    resignEvidence(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toMatchObject({
      valid: true,
      complete: false
    });
  });

  it.each([
    ["request parameters digest", (run: C137PerformanceRunV1) => {
      run.cases[0].requestParametersDigest = digest("8");
    }],
    ["native parameters hash", (run: C137PerformanceRunV1) => {
      run.cases[0].timeMapParametersHash = "fnv1a64:fedcba9876543210";
    }],
    ["TimeMap digest", (run: C137PerformanceRunV1) => {
      run.cases[0].timeMapDigest = digest("7");
    }]
  ])("recomputes each case output after tampering %s", (_label, mutate) => {
    const evidence = cloneEvidence();
    mutate(requireRun(evidence.trials[0]));
    resignEvidence(evidence);

    const validation = validateC137PerformanceEvidence(evidence);
    expect(validation.valid).toBe(true);
    expect(validation.complete).toBe(false);
    expect(
      validation.completenessIssues.some((issue) => issue.includes("输出未绑定"))
    ).toBe(true);
  });

  it("rejects a non-canonical native parameters hash structurally", () => {
    const evidence = cloneEvidence();
    requireRun(evidence.trials[0]).cases[0].timeMapParametersHash = "present-but-not-a-hash";
    resignEvidence(evidence);

    expect(validateC137PerformanceEvidence(evidence).valid).toBe(false);
  });

  it("recomputes elapsed time from native monotonic ticks", () => {
    const evidence = cloneEvidence();
    const cold = requireRun(evidence.trials[0]);
    cold.elapsedMs += 1;
    resignEvidence(evidence);

    const validation = validateC137PerformanceEvidence(evidence);
    expect(validation.valid).toBe(true);
    expect(validation.complete).toBe(false);
    expect(validation.completenessIssues.some((issue) => issue.includes("elapsedMs"))).toBe(true);
  });

  it("binds run total timing and output digest to the ordered case observations", () => {
    const timing = cloneEvidence();
    const cold = requireRun(timing.trials[0]);
    cold.startTickNs = String(BigInt(cold.startTickNs) + 1_000_000n);
    cold.elapsedMs -= 1;
    resignEvidence(timing);
    expect(validateC137PerformanceEvidence(timing).complete).toBe(false);

    const output = cloneEvidence();
    for (const trial of output.trials) {
      if (trial.trialType === "run") trial.outputDigest = digest("9");
    }
    resignEvidence(output);
    expect(validateC137PerformanceEvidence(output).complete).toBe(false);
  });

  it("binds cancellation outer fields and trigger stage to native telemetry", () => {
    const outer = cloneEvidence();
    const cancellation = requireCancellation(outer.trials[3]);
    cancellation.requestTickNs = String(BigInt(cancellation.terminalTickNs) - 50_000_000n);
    cancellation.latencyMs = 50;
    resignEvidence(outer);
    expect(validateC137PerformanceEvidence(outer).complete).toBe(false);

    const trigger = cloneEvidence();
    trigger.plan.trialOrder[3].cancellationStageKey = "validating";
    requireCancellation(trigger.trials[3]).triggerStageKey = "validating";
    trigger.planDigest = createC137PerformancePlanDigest(trigger.plan);
    resignEvidence(trigger);
    expect(validateC137PerformanceEvidence(trigger).complete).toBe(false);
  });

  it("requires every preregistered stage", () => {
    const evidence = cloneEvidence();
    const cold = requireRun(evidence.trials[0]);
    cold.cases[0].telemetry.stages = cold.cases[0].telemetry.stages.filter(
      (stage) => stage.stageKey !== "matching"
    );
    resignEvidence(evidence);

    const validation = validateC137PerformanceEvidence(evidence);
    expect(validation.valid).toBe(true);
    expect(validation.complete).toBe(false);
    expect(validation.completenessIssues.some((issue) => issue.includes("matching"))).toBe(true);
  });

  it.each([
    ["failed samples", (memory: C137PerformanceMemoryTelemetryV1) => {
      memory.failedSampleCount = 1;
    }],
    ["sampling gap", (memory: C137PerformanceMemoryTelemetryV1) => {
      memory.maximumSampleGapMs = 101;
    }],
    ["no samples", (memory: C137PerformanceMemoryTelemetryV1) => {
      memory.sampleCount = 0;
    }]
  ])("rejects incomplete process-tree RSS evidence: %s", (_label, mutate) => {
    const evidence = cloneEvidence();
    mutate(requireRun(evidence.trials[0]).cases[0].telemetry.memory);
    resignEvidence(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toMatchObject({
      valid: true,
      complete: false
    });
  });

  it("accepts exactly 1 GiB peak RSS and rejects one byte over", () => {
    const boundary = createCompleteEvidence();
    expect(requireRun(boundary.trials[0]).cases[0].telemetry.memory.peakProcessTreeRssBytes)
      .toBe(ONE_GIBIBYTE);
    expect(validateC137PerformanceEvidence(boundary).complete).toBe(true);

    const over = structuredClone(boundary);
    requireRun(over.trials[0]).cases[0].telemetry.memory.peakProcessTreeRssBytes =
      ONE_GIBIBYTE + 1;
    resignEvidence(over);
    expect(validateC137PerformanceEvidence(over)).toMatchObject({
      valid: true,
      complete: false
    });
  });

  it.each([
    ["non-cancelled terminal", (trial: C137PerformanceCancellationTrialV1) => {
      trial.terminalStatus = "completed";
    }],
    ["residual process", (trial: C137PerformanceCancellationTrialV1) => {
      trial.processTreeEmpty = false;
      trial.residualProcessCount = 1;
    }]
  ])("rejects unsafe cancellation: %s", (_label, mutate) => {
    const evidence = cloneEvidence();
    mutate(requireCancellation(evidence.trials[3]));
    resignEvidence(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toMatchObject({
      valid: true,
      complete: false
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps a structurally valid %s raw report non-complete",
    (status) => {
      const evidence = cloneEvidence();
      evidence.status = status;
      requireRun(evidence.trials[0]).status = status;
      requireRun(evidence.trials[0]).cases[0].status = status;
      resignEvidence(evidence);

      const validation = validateC137PerformanceEvidence(evidence);
      expect(validation.valid).toBe(true);
      expect(validation.complete).toBe(false);
      expect(parseC137PerformanceEvidence(serializeC137PerformanceEvidence(evidence))).toEqual(
        evidence
      );
    }
  );

  it("contains no shareable path, case, manifest, or dataset name fields", () => {
    const serialized = serializeC137PerformanceEvidence(createCompleteEvidence());
    expect(serialized).not.toMatch(/[A-Z]:\\/);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("caseName");
    expect(serialized).not.toContain("manifestName");
    expect(serialized).not.toContain("datasetName");
    expect(serialized).not.toContain("mediaPath");
    expect(serialized).toContain(WORKLOAD_DIGEST);
  });
});

describe("C137 raw performance evidence v2", () => {
  it("strictly round-trips complete path-free workload storage evidence", () => {
    const evidence = createCompleteC137PerformanceEvidenceV2Fixture();

    expect(validateC137PerformanceEvidence(evidence)).toEqual({
      valid: true,
      complete: true,
      issues: [],
      completenessIssues: []
    });
    expect(evidence.collector.sampler).toBe("windows-toolhelp-working-set-v1");
    expect(evidence.releaseEligible).toBe(false);
    expect(evidence.trustStatus).toBe("untrusted-raw-evidence");
    const serialized = serializeC137PerformanceEvidence(evidence);
    expect(parseC137PerformanceEvidence(serialized)).toEqual(evidence);
    expect(serializeC137PerformanceEvidence(parseC137PerformanceEvidence(serialized))).toBe(
      serialized
    );
  });

  it("keeps schema v1 readable without upgrading it", () => {
    const evidence = createCompleteEvidence();
    const parsed = parseC137PerformanceEvidence(serializeC137PerformanceEvidence(evidence));

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed).toEqual(evidence);
  });

  it("rejects unknown top-level and mixed nested schema versions", () => {
    const unknown = { ...createCompleteEvidence(), schemaVersion: 99 };
    expect(validateC137PerformanceEvidence(unknown).valid).toBe(false);

    const mixed = cloneV2Evidence();
    const first = mixed.trials[0];
    if (!first || first.trialType !== "run") throw new Error("expected v2 run");
    (first.cases[0].telemetry as { schemaVersion: number }).schemaVersion = 1;
    mixed.evidenceDigest = computeC137PerformanceEvidenceDigestV2(mixed);
    expect(validateC137PerformanceEvidence(mixed).valid).toBe(false);
  });

  it.each([
    ["binding ordinal", (value: C137PerformanceRawEvidenceV2) => {
      value.environment.workloadStorage.bindings[0].bindingOrdinal = 1;
    }],
    ["binding side", (value: C137PerformanceRawEvidenceV2) => {
      value.environment.workloadStorage.bindings[1].side = "source";
    }],
    ["volume reverse count", (value: C137PerformanceRawEvidenceV2) => {
      value.environment.workloadStorage.volumes[0].bindingCount = 1;
    }]
  ] as const)("rejects tampered %s even after all enclosing digests are recomputed", (_label, mutate) => {
    const evidence = cloneV2Evidence();
    mutate(evidence);
    resignV2Evidence(evidence);
    expect(validateC137PerformanceEvidence(evidence).valid).toBe(false);
  });

  it("rejects stale receipt and cross-envelope digest bindings", () => {
    const staleReceipt = cloneV2Evidence();
    staleReceipt.environment.workloadStorage.receiptDigest = digest("f");
    staleReceipt.environment.digest = computeC137PerformanceEnvironmentDigestV2(
      omitV2EnvironmentDigest(staleReceipt.environment)
    );
    staleReceipt.evidenceDigest = computeC137PerformanceEvidenceDigestV2(staleReceipt);
    expect(validateC137PerformanceEvidence(staleReceipt).valid).toBe(false);

    const staleCollector = cloneV2Evidence();
    staleCollector.collector.runManifestDigest = digest("e");
    staleCollector.evidenceDigest = computeC137PerformanceEvidenceDigestV2(staleCollector);
    expect(validateC137PerformanceEvidence(staleCollector).valid).toBe(false);
  });

  it.each([
    "jobMemoryReceipt",
    "terminalCleanupReceipt",
    "attestation"
  ] as const)("rejects a forged %s assurance object after the envelope is re-signed", (field) => {
    const forged = cloneV2Evidence();
    (forged.assurance as unknown as Record<string, unknown>)[field] = {};
    forged.evidenceDigest = computeC137PerformanceEvidenceDigestV2(forged);
    expect(validateC137PerformanceEvidence(forged).valid).toBe(false);
  });

  it("rejects a forged formal eligibility flag", () => {
    const formalFlag = cloneV2Evidence();
    (formalFlag.assurance as unknown as Record<string, unknown>).formalEligible = true;
    formalFlag.evidenceDigest = computeC137PerformanceEvidenceDigestV2(formalFlag);
    expect(validateC137PerformanceEvidence(formalFlag).valid).toBe(false);
  });

  it("accepts a path-free Job Object memory receipt bound to every native job sample", () => {
    const evidence = cloneV2Evidence();
    attachJobMemoryReceipt(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toEqual({
      valid: true,
      complete: true,
      issues: [],
      completenessIssues: []
    });
    expect(evidence.assurance.jobMemoryReceipt).toMatchObject({
      jobCount: 4,
      totalFailedSampleCount: 0,
      peakJobHierarchyRssBytes: 1_073_741_824,
      allJobsCoverageComplete: true,
      allSamplesJobBound: true,
      allTerminalProcessTreesEmpty: true
    });
  });

  it.each([
    ["session binding", (receipt: C137PerformanceJobMemoryReceiptV1) => {
      receipt.sessionId = "session-forged-0002";
    }],
    ["job count", (receipt: C137PerformanceJobMemoryReceiptV1) => {
      receipt.jobCount += 1;
    }],
    ["inventory", (receipt: C137PerformanceJobMemoryReceiptV1) => {
      receipt.jobMemoryInventoryDigest = digest("7");
    }],
    ["peak RSS", (receipt: C137PerformanceJobMemoryReceiptV1) => {
      receipt.peakJobHierarchyRssBytes += 1;
    }]
  ] as const)("rejects a re-signed Job memory receipt with tampered %s", (_label, mutate) => {
    const evidence = cloneV2Evidence();
    attachJobMemoryReceipt(evidence);
    const receipt = evidence.assurance.jobMemoryReceipt;
    if (receipt === null) throw new Error("expected Job memory receipt");
    mutate(receipt);
    receipt.receiptDigest = computeC137PerformanceJobMemoryReceiptDigest(receipt);
    evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);

    expect(validateC137PerformanceEvidence(evidence).valid).toBe(false);
  });

  it("rejects a stale Job memory receipt digest and a ToolHelp sampler impersonation", () => {
    const stale = cloneV2Evidence();
    attachJobMemoryReceipt(stale);
    const staleReceipt = stale.assurance.jobMemoryReceipt;
    if (staleReceipt === null) throw new Error("expected Job memory receipt");
    staleReceipt.receiptDigest = digest("6");
    stale.evidenceDigest = computeC137PerformanceEvidenceDigestV2(stale);
    expect(validateC137PerformanceEvidence(stale).valid).toBe(false);

    const toolHelp = cloneV2Evidence();
    attachJobMemoryReceipt(toolHelp);
    toolHelp.collector.sampler = "windows-toolhelp-working-set-v1";
    for (const trial of toolHelp.trials) {
      if (trial.trialType === "run") {
        for (const benchmarkCase of trial.cases) {
          benchmarkCase.telemetry.memory.sampler = "windows-toolhelp-working-set-v1";
        }
      } else {
        trial.telemetry.memory.sampler = "windows-toolhelp-working-set-v1";
      }
    }
    toolHelp.evidenceDigest = computeC137PerformanceEvidenceDigestV2(toolHelp);
    expect(validateC137PerformanceEvidence(toolHelp).valid).toBe(false);
  });

  it("accepts a path-free terminal cleanup receipt that is bound to every terminal native job", () => {
    const evidence = cloneV2Evidence();
    attachTerminalCleanupReceipt(evidence);

    expect(validateC137PerformanceEvidence(evidence)).toEqual({
      valid: true,
      complete: true,
      issues: [],
      completenessIssues: []
    });
    expect(evidence.assurance.terminalCleanupReceipt).toMatchObject({
      jobCount: 4,
      completedJobCount: 3,
      cancelledJobCount: 1,
      processTreeEmpty: true,
      supervisionCleanupStatus: "clean",
      featureCachesEmpty: true
    });
  });

  it.each([
    ["session binding", (receipt: C137PerformanceTerminalCleanupReceiptV1) => {
      receipt.sessionId = "session-forged-0001";
    }],
    ["job count", (receipt: C137PerformanceTerminalCleanupReceiptV1) => {
      receipt.jobCount += 1;
    }],
    ["job inventory", (receipt: C137PerformanceTerminalCleanupReceiptV1) => {
      receipt.jobInventoryDigest = digest("9");
    }],
    ["terminal tick", (receipt: C137PerformanceTerminalCleanupReceiptV1) => {
      receipt.terminalTickNs = "0";
    }]
  ] as const)("rejects a re-signed terminal cleanup receipt with tampered %s", (_label, mutate) => {
    const evidence = cloneV2Evidence();
    attachTerminalCleanupReceipt(evidence);
    const receipt = evidence.assurance.terminalCleanupReceipt;
    if (receipt === null) throw new Error("expected terminal cleanup receipt");
    mutate(receipt);
    receipt.receiptDigest = computeC137PerformanceTerminalCleanupReceiptDigest(receipt);
    evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);

    expect(validateC137PerformanceEvidence(evidence).valid).toBe(false);
  });

  it("rejects a stale terminal cleanup receipt digest after the outer envelope is re-signed", () => {
    const evidence = cloneV2Evidence();
    attachTerminalCleanupReceipt(evidence);
    const receipt = evidence.assurance.terminalCleanupReceipt;
    if (receipt === null) throw new Error("expected terminal cleanup receipt");
    receipt.receiptDigest = digest("8");
    evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);

    expect(validateC137PerformanceEvidence(evidence).valid).toBe(false);
  });
});

function createCompleteEvidence(): C137PerformanceRawEvidenceV1 {
  const plan = createPlan();
  let draft = createC137PerformanceEvidenceDraft({
    plan,
    environment: createEnvironment(),
    collector: {
      schemaVersion: 1,
      collectorVersion: "c137-native-collector-v1",
      nativeSchemaVersion: 1,
      clock: "rust-std-instant-session-relative-v1",
      memoryScope: "application-process-tree",
      sampler: "windows-toolhelp-working-set-v1",
      sessionId: SESSION_ID,
      sessionOriginTickNs: "0",
      memorySampleIntervalMs: 100,
      terminalSessionStatus: "released"
    },
    preflight: {
      ok: true,
      realRelationCount: 1,
      checkedFileCount: 2,
      issueCodes: []
    }
  });

  const coldReset = createResetReceipt(COLD_ID, 0, 1, 100);
  const cancellationReset = createResetReceipt(CANCELLATION_ID, 1, 2, 4_000_000_000);
  draft = appendC137PerformanceCacheResetReceipt(draft, coldReset);
  draft = appendC137PerformanceCacheResetReceipt(draft, cancellationReset);
  draft = appendC137PerformanceTrial(
    draft,
    createRun("cold", COLD_ID, 1, 1, 1_000_000_000, 600_000, coldReset.receiptDigest, null)
  );
  draft = appendC137PerformanceTrial(
    draft,
    createRun("warmup", WARMUP_ID, 1, 2, 2_000_000_000, 60_000, null, null)
  );
  draft = appendC137PerformanceTrial(
    draft,
    createRun("hot", HOT_ID, 1, 2, 3_000_000_000, 120_000, null, WARMUP_ID)
  );
  draft = appendC137PerformanceTrial(draft, createCancellation(cancellationReset));
  return finalizeC137PerformanceEvidence(draft, "complete");
}

function createPlan(): C137PerformancePlanV1 {
  return {
    schemaVersion: 1,
    planId: PLAN_ID,
    workloadDigest: WORKLOAD_DIGEST,
    expectedCaseCount: 1,
    trialOrder: [
      {
        trialId: COLD_ID,
        kind: "cold",
        repetition: 1,
        warmupTrialId: null,
        cancellationStageKey: null,
        cancellationCaseOrdinal: null
      },
      {
        trialId: WARMUP_ID,
        kind: "warmup",
        repetition: 1,
        warmupTrialId: null,
        cancellationStageKey: null,
        cancellationCaseOrdinal: null
      },
      {
        trialId: HOT_ID,
        kind: "hot",
        repetition: 1,
        warmupTrialId: WARMUP_ID,
        cancellationStageKey: null,
        cancellationCaseOrdinal: null
      },
      {
        trialId: CANCELLATION_ID,
        kind: "cancellation",
        repetition: 1,
        warmupTrialId: null,
        cancellationStageKey: "matching",
        cancellationCaseOrdinal: 0
      }
    ],
    requiredStageKeys: ["validating", "matching", "completed"],
    memorySampleIntervalMs: 100,
    maximumMemorySampleGapMs: 100,
    outputCanonicalization: "c137-time-map-output-digest-v1",
    parameters: {
      spectralBackend: "auto",
      sampleRate: 8_000,
      windowMs: 250,
      matchThreshold: 0.7,
      minGapMs: 200,
      maxCells: 1_000_000,
      enableVisualEvidence: true,
      visualSampleIntervalMs: 1_000
    }
  };
}

function createEnvironment(): C137PerformanceEnvironmentV1 {
  const unsigned: Omit<C137PerformanceEnvironmentV1, "digest"> = {
    schemaVersion: 1,
    measurementStatus: "complete",
    issues: [],
    operatingSystem: "Windows",
    operatingSystemVersion: "11-24H2",
    architecture: "x86_64",
    cpuModel: "opaque-cpu-fingerprint",
    physicalCoreCount: 4,
    logicalCoreCount: 8,
    totalMemoryBytes: 16 * ONE_GIBIBYTE,
    storageScope: "system-volume",
    storageKind: "ssd",
    powerProfile: "high-performance",
    ffmpeg: { version: "7.1", binaryDigest: digest("a") },
    ffprobe: { version: "7.1", binaryDigest: digest("b") }
  };
  return {
    ...unsigned,
    digest: computeC137PerformanceEnvironmentDigest(unsigned)
  };
}

function createResetReceipt(
  trialId: string,
  previousGeneration: number,
  cacheGeneration: number,
  resetTickNs: number
): C137PerformanceCacheResetReceiptV1 {
  const unsigned: Omit<C137PerformanceCacheResetReceiptV1, "receiptDigest"> = {
    schemaVersion: 1,
    trialId,
    sessionId: SESSION_ID,
    resetTickNs: String(resetTickNs),
    previousGeneration,
    cacheGeneration,
    before: {
      audioFeatureEntries: 3,
      landmarkEntries: 3,
      visualFeatureEntries: 3
    },
    after: { ...EMPTY_COUNTS },
    allCachesEmpty: true
  };
  return {
    ...unsigned,
    receiptDigest: computeC137PerformanceCacheResetReceiptDigest(unsigned)
  };
}

function createRun(
  runKind: C137PerformanceRunKindV1,
  trialId: string,
  repetition: number,
  generation: number,
  startTickNs: number,
  elapsedMs: number,
  cacheResetReceiptDigest: C137PerformanceRawEvidenceV1["cacheResets"][number]["receiptDigest"] | null,
  warmupTrialId: string | null
): C137PerformanceRunV1 {
  const endTickNs = startTickNs + elapsedMs * 1_000_000;
  const outputDigest = computeC137PerformanceCanonicalDigest({
    domain: "c137-time-map-output-suite-v1",
    cases: [{ caseOrdinal: 0, digest: OUTPUT_DIGEST }]
  });
  return {
    trialType: "run",
    trialId,
    runKind,
    repetition,
    sessionId: SESSION_ID,
    workloadDigest: WORKLOAD_DIGEST,
    status: "completed",
    startTickNs: String(startTickNs),
    endTickNs: String(endTickNs),
    elapsedMs,
    cacheResetReceiptDigest,
    warmupTrialId,
    outputDigest,
    cases: [
      {
        caseOrdinal: 0,
        jobId: `job-${trialId}`,
        status: "completed",
        requestParametersDigest: REQUEST_PARAMETERS_DIGEST,
        timeMapParametersHash: TIME_MAP_PARAMETERS_HASH,
        timeMapDigest: TIME_MAP_DIGEST,
        outputDigest: OUTPUT_DIGEST,
        telemetry: createTelemetry(runKind, generation, startTickNs, elapsedMs)
      }
    ]
  };
}

function createTelemetry(
  runKind: C137PerformanceRunKindV1,
  generation: number,
  startTickNs: number,
  elapsedMs: number
): C137PerformanceNativeTelemetryV1 {
  const endTickNs = startTickNs + elapsedMs * 1_000_000;
  const stages = createStages(startTickNs, elapsedMs);
  return {
    schemaVersion: 1,
    clock: "rust-std-instant-session-relative-v1",
    startTickNs: String(startTickNs),
    endTickNs: String(endTickNs),
    elapsedMs,
    stages,
    cache: createCache(runKind, generation),
    memory: createMemory(ONE_GIBIBYTE),
    cancellation: null
  };
}

function createStages(startTickNs: number, elapsedMs: number): C137PerformanceStageTimingV1[] {
  const firstMs = Math.floor(elapsedMs / 3);
  const secondMs = Math.floor(elapsedMs / 3);
  const thirdMs = elapsedMs - firstMs - secondMs;
  const secondStart = startTickNs + firstMs * 1_000_000;
  const thirdStart = secondStart + secondMs * 1_000_000;
  return [
    createStage("validating", startTickNs, firstMs),
    createStage("matching", secondStart, secondMs),
    createStage("completed", thirdStart, thirdMs)
  ];
}

function createStage(
  stageKey: C137PerformanceStageTimingV1["stageKey"],
  startTickNs: number,
  elapsedMs: number
): C137PerformanceStageTimingV1 {
  return {
    stageKey,
    occurrence: 1,
    startTickNs: String(startTickNs),
    endTickNs: String(startTickNs + elapsedMs * 1_000_000),
    elapsedMs,
    status: "completed"
  };
}

function createCache(
  runKind: C137PerformanceRunKindV1,
  generation: number
): C137PerformanceCacheTelemetryV1 {
  const hot = runKind === "hot";
  const counter = hot
    ? { hits: 1, misses: 0, writes: 0, evictions: 0 }
    : { hits: 0, misses: 1, writes: 1, evictions: 0 };
  return {
    generation,
    before: hot
      ? { audioFeatureEntries: 1, landmarkEntries: 1, visualFeatureEntries: 1 }
      : { ...EMPTY_COUNTS },
    after: { audioFeatureEntries: 1, landmarkEntries: 1, visualFeatureEntries: 1 },
    audioFeatures: { ...counter },
    landmarks: { ...counter },
    visualFeatures: { ...counter }
  };
}

function createMemory(peakProcessTreeRssBytes: number): C137PerformanceMemoryTelemetryV1 {
  return {
    scope: "application-process-tree",
    sampler: "windows-toolhelp-working-set-v1",
    sampleIntervalMs: 100,
    sampleCount: 10,
    failedSampleCount: 0,
    maximumSampleGapMs: 100,
    peakProcessTreeRssBytes,
    coverageComplete: true,
    processTreeEmptyAtTerminal: true,
    residualProcessCount: 0
  };
}

function createCancellation(
  reset: C137PerformanceCacheResetReceiptV1
): C137PerformanceCancellationTrialV1 {
  const startTickNs = 4_100_000_000;
  const requestTickNs = 4_200_000_000;
  const terminalTickNs = 4_300_000_000;
  const elapsedMs = 200;
  return {
    trialType: "cancellation",
    trialId: CANCELLATION_ID,
    repetition: 1,
    sessionId: SESSION_ID,
    workloadDigest: WORKLOAD_DIGEST,
    caseOrdinal: 0,
    jobId: "job-cancellation-0001",
    triggerStageKey: "matching",
    requestTickNs: String(requestTickNs),
    terminalTickNs: String(terminalTickNs),
    latencyMs: 100,
    commandAccepted: true,
    terminalStatus: "cancelled",
    processTreeEmpty: true,
    residualProcessCount: 0,
    cacheResetReceiptDigest: reset.receiptDigest,
    telemetry: {
      schemaVersion: 1,
      clock: "rust-std-instant-session-relative-v1",
      startTickNs: String(startTickNs),
      endTickNs: String(terminalTickNs),
      elapsedMs,
      stages: [
        createStage("validating", startTickNs, 50),
        {
          ...createStage("matching", startTickNs + 50_000_000, 150),
          status: "cancelled"
        }
      ],
      cache: createCache("cold", reset.cacheGeneration),
      memory: createMemory(512 * MEBIBYTE),
      cancellation: {
        requestTickNs: String(requestTickNs),
        terminalTickNs: String(terminalTickNs),
        latencyMs: 100,
        commandAccepted: true
      }
    }
  };
}

function cloneEvidence(): C137PerformanceRawEvidenceV1 {
  return structuredClone(createCompleteEvidence());
}

function resignEvidence(evidence: C137PerformanceRawEvidenceV1): void {
  evidence.evidenceDigest = computeC137PerformanceEvidenceDigest(evidence);
}

function requireRun(trial: C137PerformanceTrialV1 | undefined): C137PerformanceRunV1 {
  if (!trial || trial.trialType !== "run") throw new Error("expected performance run");
  return trial;
}

function requireCancellation(
  trial: C137PerformanceTrialV1 | undefined
): C137PerformanceCancellationTrialV1 {
  if (!trial || trial.trialType !== "cancellation") {
    throw new Error("expected cancellation trial");
  }
  return trial;
}

function cloneV2Evidence(): C137PerformanceRawEvidenceV2 {
  return structuredClone(createCompleteC137PerformanceEvidenceV2Fixture());
}

function attachJobMemoryReceipt(evidence: C137PerformanceRawEvidenceV2): void {
  evidence.collector.sampler = "windows-job-object-working-set-v1";
  for (const trial of evidence.trials) {
    if (trial.trialType === "run") {
      for (const benchmarkCase of trial.cases) {
        benchmarkCase.telemetry.memory.sampler = "windows-job-object-working-set-v1";
      }
    } else {
      trial.telemetry.memory.sampler = "windows-job-object-working-set-v1";
    }
  }
  const jobs = projectC137PerformanceJobMemoryInventory(evidence.trials);
  const unsigned: Omit<C137PerformanceJobMemoryReceiptV1, "receiptDigest"> = {
    schemaVersion: 1,
    sessionId: evidence.collector.sessionId,
    runManifestDigest: evidence.runManifestDigest,
    workloadDigest: evidence.plan.workloadDigest,
    workloadStorageReceiptDigest: evidence.environment.workloadStorage.receiptDigest,
    sampler: "windows-job-object-working-set-v1",
    memoryScope: "application-process-tree",
    jobCount: jobs.length,
    totalSampleCount: jobs.reduce((total, job) => total + job.sampleCount, 0),
    totalFailedSampleCount: 0,
    maximumSampleGapMicros: jobs.reduce(
      (maximum, job) =>
        BigInt(job.maximumSampleGapMicros) > BigInt(maximum)
          ? job.maximumSampleGapMicros
          : maximum,
      "0"
    ),
    peakJobHierarchyRssBytes: jobs.reduce(
      (maximum, job) => Math.max(maximum, job.peakJobHierarchyRssBytes),
      0
    ),
    jobMemoryInventoryDigest: computeC137PerformanceJobMemoryInventoryDigest(jobs),
    allJobsCoverageComplete: true,
    allSamplesJobBound: true,
    allTerminalProcessTreesEmpty: true
  };
  evidence.assurance.jobMemoryReceipt = {
    ...unsigned,
    receiptDigest: computeC137PerformanceJobMemoryReceiptDigest(unsigned)
  };
  evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);
}

function attachTerminalCleanupReceipt(evidence: C137PerformanceRawEvidenceV2): void {
  const jobs = projectC137PerformanceTerminalCleanupJobInventory(evidence.trials);
  const latestTick = jobs.reduce(
    (maximum, job) => (BigInt(job.endTickNs) > maximum ? BigInt(job.endTickNs) : maximum),
    0n
  );
  const unsigned: Omit<C137PerformanceTerminalCleanupReceiptV1, "receiptDigest"> = {
    schemaVersion: 1,
    sessionId: evidence.collector.sessionId,
    runManifestDigest: evidence.runManifestDigest,
    workloadDigest: evidence.plan.workloadDigest,
    workloadStorageReceiptDigest: evidence.environment.workloadStorage.receiptDigest,
    terminalTickNs: String(latestTick + 1n),
    finalCacheGeneration: 3,
    jobCount: jobs.length,
    completedJobCount: jobs.filter((job) => job.status === "completed").length,
    failedJobCount: jobs.filter((job) => job.status === "failed").length,
    cancelledJobCount: jobs.filter((job) => job.status === "cancelled").length,
    jobInventoryDigest: computeC137PerformanceTerminalCleanupJobInventoryDigest(jobs),
    allJobsTerminal: true,
    processTreeEmpty: true,
    residualProcessCount: 0,
    supervisionCleanupStatus: "clean",
    toolchainReverified: true,
    workloadReverified: true,
    featureCachesEmpty: true
  };
  evidence.assurance.terminalCleanupReceipt = {
    ...unsigned,
    receiptDigest: computeC137PerformanceTerminalCleanupReceiptDigest(unsigned)
  };
  evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);
}

function resignV2Evidence(evidence: C137PerformanceRawEvidenceV2): void {
  evidence.environment.workloadStorage.receiptDigest =
    computeC137PerformanceWorkloadStorageReceiptDigest(
      evidence.environment.workloadStorage
    );
  evidence.environment.digest = computeC137PerformanceEnvironmentDigestV2(
    omitV2EnvironmentDigest(evidence.environment)
  );
  evidence.collector.workloadStorageReceiptDigest =
    evidence.environment.workloadStorage.receiptDigest;
  evidence.assurance.workloadStorageReceiptDigest =
    evidence.environment.workloadStorage.receiptDigest;
  evidence.evidenceDigest = computeC137PerformanceEvidenceDigestV2(evidence);
}

function omitV2EnvironmentDigest(
  environment: C137PerformanceRawEvidenceV2["environment"]
): Omit<C137PerformanceRawEvidenceV2["environment"], "digest"> {
  const { digest: ignoredDigest, ...unsigned } = environment;
  void ignoredDigest;
  return unsigned;
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
