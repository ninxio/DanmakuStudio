import { describe, expect, it } from "vitest";
import {
  createC137FormalBlindProvenanceFixture,
  resealC137FormalBlindNativeReceiptFixture,
  resealC137FormalBlindProvenanceFixture
} from "../../test/c137FormalBlindProvenance";
import {
  c137RelationshipModalitiesEqualPairLocalEvidence,
  c137TimeMapCasesEqualPairLocalEvidence,
  deriveC137PairLocalVersionReuseEvidence,
  deriveC137PairLocalFineEvidence,
  deriveC137TimeMapCasesFromPairLocalFineEvidence
} from "./c137PairLocalFineEvidence";

describe("C137 pair-local fine evidence", () => {
  it("从同一 formal provenance 唯一定位 frozen gold pair 并绑定实际 fine window/TimeMap", () => {
    const fixture = createC137FormalBlindProvenanceFixture();

    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);

    expect(evidence.cases).toHaveLength(fixture.manifest.cases.length);
    expect(evidence.cases.every((item) => item.status === "measured")).toBe(true);
    expect(evidence.cases.every((item) => item.frontierResolutionProven)).toBe(true);
    expect(evidence.cases.every((item) => item.selectedSourceWindow !== null)).toBe(true);
    expect(evidence.cases.every((item) => item.selectedTargetWindow !== null)).toBe(true);
    expect(evidence.cases.every((item) => item.modality?.modality === "same-audio")).toBe(true);
    expect(
      c137RelationshipModalitiesEqualPairLocalEvidence(
        evidence.cases.map((item) => ({ caseId: item.caseId, modality: "same-audio" })),
        evidence
      )
    ).toBe(true);
    expect(
      evidence.cases.every((item) =>
        item.timeMap?.matchedProjectionErrorsMs.every((errorMs) => errorMs === 0)
      )
    ).toBe(true);
  });

  it("relationship modality 必须逐 case 等于 native TimeMap 锚点与实际流身份", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);
    const claimed: Array<{
      caseId: string;
      modality: "same-audio" | "visual-only" | "mixed" | "no-common-content";
    }> = evidence.cases.map((item) => ({
      caseId: item.caseId,
      modality: "same-audio"
    }));

    expect(c137RelationshipModalitiesEqualPairLocalEvidence(claimed, evidence)).toBe(true);
    claimed[0].modality = "visual-only";
    expect(c137RelationshipModalitiesEqualPairLocalEvidence(claimed, evidence)).toBe(false);
    claimed[0].modality = "same-audio";
    claimed[1].caseId = claimed[0].caseId;
    expect(c137RelationshipModalitiesEqualPairLocalEvidence(claimed, evidence)).toBe(false);
  });

  it("从 receipt 的完整候选清单逐 pair 精确统计，不再以 component 总数推测", () => {
    const fixture = createC137FormalBlindProvenanceFixture();

    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);

    expect(evidence.cases.every((item) => item.completePairCandidateInventoryEnumerated)).toBe(
      true
    );
    expect(evidence.cases.every((item) => item.pairCandidateCount === 1)).toBe(true);
    expect(evidence.cases.every((item) => !item.samePairAlternativeObserved)).toBe(true);
  });

  it("一个 pair 内多个轨道/粗候选成员不能冒充跨 pair 的同片段多对多复用", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    for (const batch of fixture.provenance.batches) {
      for (const outcome of batch.nativeReceipt.pairOutcomes) {
        if (outcome.fineExecutionEvidence !== null) {
          outcome.fineExecutionEvidence.groupMemberRanks = [1, 2];
        }
      }
      resealC137FormalBlindNativeReceiptFixture(batch);
    }
    resealC137FormalBlindProvenanceFixture(fixture.provenance);

    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);

    expect(evidence.cases.every((item) => item.selectedGroupMemberCount === 2)).toBe(true);
    expect(evidence.cases.every((item) => !item.sameSegmentManyToManyObserved)).toBe(true);
    expect(evidence.cases.every((item) => item.versionReuseEvidence === null)).toBe(true);
  });

  it("只在显式多版本组的两个已选 pair 复用同一物理时间段时发布多对多证据", () => {
    const fixture = createC137FormalBlindProvenanceFixture();
    const selected = fixture.provenance.batches[0]?.nativeReceipt.pairOutcomes.filter(
      (outcome) =>
        outcome.fineFrontier !== null &&
        outcome.fineExecutionEvidence !== null &&
        outcome.proposalTimeMap !== null
    );
    const current = structuredClone(selected?.[0]);
    const peer = structuredClone(selected?.[1]);
    if (
      current === undefined ||
      peer === undefined ||
      current.fineFrontier === null ||
      current.fineExecutionEvidence === null ||
      peer.fineFrontier === null ||
      peer.fineExecutionEvidence === null
    ) {
      throw new Error("fixture selected outcomes missing");
    }
    peer.sourceMediaId = current.sourceMediaId;
    const selectedIds = [
      structuredClone(current.fineExecutionEvidence.candidateId),
      structuredClone(peer.fineExecutionEvidence.candidateId)
    ];
    for (const outcome of [current, peer]) {
      const frontier = outcome.fineFrontier;
      const execution = outcome.fineExecutionEvidence;
      if (frontier === null || execution === null)
        throw new Error("fixture fine evidence missing");
      frontier.componentOrdinal = 1;
      frontier.componentPairOrdinals = [current.pairOrdinal, peer.pairOrdinal].sort(
        (left, right) => left - right
      );
      frontier.selectedCandidateIds = structuredClone(selectedIds);
      const inventory = frontier.inventoryCandidates.find(
        (candidate) =>
          candidate.id.pairOrdinal === execution.candidateId.pairOrdinal &&
          candidate.id.candidateOrdinal === execution.candidateId.candidateOrdinal
      );
      if (inventory === undefined) throw new Error("fixture inventory candidate missing");
      inventory.sourceAxisReuseGroupOrdinal = 1;
    }

    const evidence = deriveC137PairLocalVersionReuseEvidence(
      {
        versionReuseGroups: [
          {
            groupOrdinal: 1,
            groupId: "alternate-target-versions",
            side: "target",
            mediaIds: [current.targetMediaId, peer.targetMediaId]
          }
        ],
        pairOutcomes: [current, peer]
      },
      current
    );

    expect(evidence).toMatchObject({
      groupId: "alternate-target-versions",
      groupSide: "target",
      reusedPhysicalAxis: "source",
      sharedMediaId: current.sourceMediaId,
      peerPairOrdinals: [peer.pairOrdinal]
    });
    expect(evidence?.maximumOverlapMs).toBeGreaterThan(
      evidence?.overlapToleranceMs ?? Infinity
    );
  });

  it("锚点误差由 frozen Gold 与 native proposal 重算，报告数字被修改后不再相等", () => {
    const fixture = createC137FormalBlindProvenanceFixture({
      mutateManifest: (manifest) => {
        const benchmarkCase = manifest.cases[0];
        if (benchmarkCase === undefined) throw new Error("fixture case missing");
        benchmarkCase.gold.matchedAnchors[0].targetMs += 50;
        for (const annotation of benchmarkCase.independentAnnotations) {
          annotation.gold.matchedAnchors[0].targetMs += 50;
        }
      }
    });
    const evidence = deriveC137PairLocalFineEvidence(fixture.provenance);
    const cases = deriveC137TimeMapCasesFromPairLocalFineEvidence(evidence);

    expect(cases[0]?.matchedProjectionErrorsMs[0]).toBe(50);
    expect(c137TimeMapCasesEqualPairLocalEvidence(cases, evidence)).toBe(true);
    cases[0].matchedProjectionErrorsMs[0] = 0;
    expect(c137TimeMapCasesEqualPairLocalEvidence(cases, evidence)).toBe(false);
  });
});
