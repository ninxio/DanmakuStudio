import { describe, expect, it } from "vitest";
import {
  assertRealMediaGoldFreezeReceiptMatchesCase,
  collectRealMediaGoldDisagreements,
  createRealMediaGoldAnnotationEnvelope,
  createRealMediaGoldDigest,
  freezeRealMediaGoldCase,
  parseRealMediaGoldAnnotationEnvelopeJson,
  parseRealMediaGoldFreezeReceiptJson,
  serializeRealMediaGoldAnnotationEnvelope,
  serializeRealMediaGoldFreezeReceipt,
  type RealMediaGoldAnnotationEnvelope,
  type RealMediaGoldBenchmarkCaseInput,
  type RealMediaGoldMediaBinding,
  type RealMediaGoldReviewVerification
} from "./realMediaGoldGovernance";
import type { RealMediaBenchmarkGold } from "./realMediaBenchmark";

describe("C137 真实媒体 Gold 治理", () => {
  it("创建版本化自摘要标注，canonical round-trip 稳定并拒绝未知字段或篡改", () => {
    const first = createAnnotation("reviewer-alpha");
    const reorderedGold = createGold();
    reorderedGold.matchedAnchors.reverse();
    reorderedGold.sourceOnlySpans.reverse();
    const reordered = createAnnotation("reviewer-alpha", reorderedGold);

    expect(reordered.annotationDigest).toBe(first.annotationDigest);
    const serialized = serializeRealMediaGoldAnnotationEnvelope(first);
    expect(parseRealMediaGoldAnnotationEnvelopeJson(serialized)).toEqual(first);
    expect(
      serializeRealMediaGoldAnnotationEnvelope(
        parseRealMediaGoldAnnotationEnvelopeJson(serialized)
      )
    ).toBe(serialized);
    expect(first.reviewVerification).toMatchObject({
      recordVersion: 2,
      method: "manual-review",
      signatureAlgorithm: "hmac-sha256-v1",
      verifier: "reviewer-alpha"
    });

    const unknownField = { ...first, callerGold: first.gold };
    expect(() =>
      parseRealMediaGoldAnnotationEnvelopeJson(JSON.stringify(unknownField))
    ).toThrow(/字段必须严格/);

    const tampered = structuredClone(first);
    tampered.gold.matchedAnchors[2].targetMs += 500;
    expect(() => parseRealMediaGoldAnnotationEnvelopeJson(JSON.stringify(tampered))).toThrow(
      /annotationDigest.*不一致/
    );

    const unknownVerificationField = structuredClone(
      first
    ) as RealMediaGoldAnnotationEnvelope & {
      reviewVerification: RealMediaGoldReviewVerification & { callerTrusted?: boolean };
    };
    unknownVerificationField.reviewVerification.callerTrusted = true;
    expect(() =>
      parseRealMediaGoldAnnotationEnvelopeJson(JSON.stringify(unknownVerificationField))
    ).toThrow(/reviewVerification.*字段必须严格/);

    const tamperedVerification = structuredClone(first);
    tamperedVerification.reviewVerification.signature = "f".repeat(64);
    expect(() =>
      parseRealMediaGoldAnnotationEnvelopeJson(JSON.stringify(tamperedVerification))
    ).toThrow(/annotationDigest.*不一致/);
  });

  it("确定性比较所有 annotation pair、全部 anchor 与三类 edit span 的四个边界", () => {
    const alpha = createAnnotation("reviewer-alpha");
    const beta = createAnnotation("reviewer-beta");
    const changedGold = createGold();
    changedGold.sourceEndMs += 500;
    changedGold.matchedAnchors[2].targetMs += 500;
    shiftSpan(changedGold.sourceOnlySpans[0], 500);
    shiftSpan(changedGold.targetOnlySpans[0], 500);
    shiftSpan(changedGold.ambiguousSpans[0], 500);
    const gamma = createAnnotation("reviewer-gamma", changedGold);

    const shuffled = collectRealMediaGoldDisagreements([gamma, alpha, beta]);
    const ordered = collectRealMediaGoldDisagreements([alpha, beta, gamma]);

    expect(shuffled).toEqual(ordered);
    expect(new Set(shuffled.flatMap((item) => item.reviewerIds))).toEqual(
      new Set(["reviewer-alpha", "reviewer-beta", "reviewer-gamma"])
    );
    expect(shuffled.filter((item) => item.reviewerIds.includes("reviewer-gamma"))).toHaveLength(
      shuffled.length
    );
    expect(shuffled.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        "gold.sourceEndMs",
        'gold.matchedAnchors["anchor-2"].targetMs',
        "gold.sourceOnlySpans[0].sourceStartMs",
        "gold.sourceOnlySpans[0].sourceEndMs",
        "gold.sourceOnlySpans[0].targetStartMs",
        "gold.sourceOnlySpans[0].targetEndMs",
        "gold.targetOnlySpans[0].sourceStartMs",
        "gold.targetOnlySpans[0].sourceEndMs",
        "gold.targetOnlySpans[0].targetStartMs",
        "gold.targetOnlySpans[0].targetEndMs",
        "gold.ambiguousSpans[0].sourceStartMs",
        "gold.ambiguousSpans[0].sourceEndMs",
        "gold.ambiguousSpans[0].targetStartMs",
        "gold.ambiguousSpans[0].targetEndMs"
      ])
    );
  });

  it("共同 anchor 两轴反向漂移即使各自未超容差也必须按映射 offset 分歧仲裁", () => {
    const alpha = createAnnotation("reviewer-alpha");
    const betaGold = createGold();
    betaGold.matchedAnchors[2].sourceMs += 80;
    betaGold.matchedAnchors[2].targetMs -= 80;
    const beta = createAnnotation("reviewer-beta", betaGold);

    const disagreements = collectRealMediaGoldDisagreements([alpha, beta]);
    expect(disagreements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'gold.matchedAnchors["anchor-2"].mappingOffsetMs',
          deltaMs: 160,
          toleranceMs: 100
        })
      ])
    );
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, beta],
        resolution: {
          kind: "consensus",
          selectedAnnotationDigest: alpha.annotationDigest,
          note: "错误地只分别比较两轴坐标。"
        }
      })
    ).toThrow(/必须第三人仲裁/);
  });

  it("Gold 语义拒绝 edit span 同轴重叠、cross-kind 冲突和落入编辑区的 matched anchor", () => {
    const overlapping = createGold();
    overlapping.ambiguousSpans.push({
      kind: "ambiguous",
      sourceStartMs: 31_000,
      sourceEndMs: 33_000,
      targetStartMs: 30_000,
      targetEndMs: 32_000
    });
    expect(() => createAnnotation("reviewer-alpha", overlapping)).toThrow(
      /重叠、交叉.*cross-kind/
    );

    const anchorInsideEdit = createGold();
    anchorInsideEdit.matchedAnchors[1] = {
      id: "anchor-1",
      sourceMs: 31_000,
      targetMs: 30_000
    };
    expect(() => createAnnotation("reviewer-alpha", anchorInsideEdit)).toThrow(
      /matched anchor anchor-1.*edit span/
    );
  });

  it("容差内必须显式选择一份 annotation，并对输入交换保持冻结结果稳定", () => {
    const alpha = createAnnotation("reviewer-alpha");
    const betaGold = createGold();
    betaGold.matchedAnchors[2].targetMs += 50;
    const beta = createAnnotation("reviewer-beta", betaGold);
    const input = {
      caseInput: createCaseInput(),
      resolution: {
        kind: "consensus" as const,
        selectedAnnotationDigest: alpha.annotationDigest,
        note: "两份独立标注在容差内；明确采用 alpha 版本。"
      }
    };

    const first = freezeRealMediaGoldCase({ ...input, annotations: [alpha, beta] });
    const exchanged = freezeRealMediaGoldCase({ ...input, annotations: [beta, alpha] });

    expect(exchanged).toEqual(first);
    expect(first.manifestCase.gold).toEqual(alpha.gold);
    expect(first.manifestCase.independentAnnotations).toHaveLength(2);
    expect(first.manifestCase.adjudication).toEqual({
      status: "not-needed",
      adjudicatorId: null,
      note: input.resolution.note
    });
    expect(first.receipt.finalGoldDigest).toBe(createRealMediaGoldDigest(alpha.gold));
    expect(first.receipt).toMatchObject({
      releaseEligible: false,
      assurance: "untrusted-self-consistent-gold-governance"
    });
    expect(
      parseRealMediaGoldFreezeReceiptJson(serializeRealMediaGoldFreezeReceipt(first.receipt))
    ).toEqual(first.receipt);
    const missingAssurance = structuredClone(first.receipt) as Partial<
      Record<keyof typeof first.receipt, unknown>
    >;
    delete missingAssurance.assurance;
    expect(() => parseRealMediaGoldFreezeReceiptJson(JSON.stringify(missingAssurance))).toThrow(
      /字段必须严格/
    );
    expect(() =>
      assertRealMediaGoldFreezeReceiptMatchesCase(
        first.receipt,
        [alpha, beta],
        first.manifestCase
      )
    ).not.toThrow();
  });

  it("同一 signed map 改 reviewerId 或复用人工证据仍不能伪装成独立标注", () => {
    const alpha = createAnnotation("reviewer-alpha");
    expect(() =>
      createAnnotation("reviewer-beta", createGold(), alpha.reviewVerification)
    ).toThrow(/reviewerId.*verifier/);

    const relabeledVerification = {
      ...alpha.reviewVerification,
      verifier: "reviewer-beta"
    } satisfies RealMediaGoldReviewVerification;
    const relabeled = createAnnotation("reviewer-beta", createGold(), relabeledVerification);
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, relabeled],
        resolution: {
          kind: "consensus",
          selectedAnnotationDigest: alpha.annotationDigest,
          note: "错误复用 signed map。"
        }
      })
    ).toThrow(/不同 verificationId/);

    const reusedEvidenceVerification = {
      ...createReviewVerification("reviewer-beta"),
      reviewEvidenceDigest: alpha.reviewVerification.reviewEvidenceDigest
    } satisfies RealMediaGoldReviewVerification;
    const reusedEvidence = createAnnotation(
      "reviewer-beta",
      createGold(),
      reusedEvidenceVerification
    );
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, reusedEvidence],
        resolution: {
          kind: "consensus",
          selectedAnnotationDigest: alpha.annotationDigest,
          note: "错误复用人工复核证据。"
        }
      })
    ).toThrow(/不同 reviewEvidenceDigest/);
  });

  it("冻结严格拒绝重复 reviewer、额外第三份标注和结构分歧的 consensus", () => {
    const alpha = createAnnotation("reviewer-alpha");
    const duplicateReviewer = createAnnotation("reviewer-alpha", shiftedAnchorGold(20));
    const beta = createAnnotation("reviewer-beta");
    const gamma = createAnnotation("reviewer-gamma");
    const structuralGold = createGold();
    structuralGold.matchedAnchors.splice(2, 1);
    const structural = createAnnotation("reviewer-beta", structuralGold);
    const resolution = {
      kind: "consensus" as const,
      selectedAnnotationDigest: alpha.annotationDigest,
      note: "选择 alpha。"
    };

    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, duplicateReviewer],
        resolution
      })
    ).toThrow(/不同 reviewer/);
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, beta, gamma],
        resolution
      })
    ).toThrow(/恰好两份/);
    expect(collectRealMediaGoldDisagreements([alpha, structural])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'gold.matchedAnchors["anchor-2"].sourceMs',
          reason: "missing"
        }),
        expect.objectContaining({
          path: 'gold.matchedAnchors["anchor-2"].targetMs',
          reason: "missing"
        })
      ])
    );
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, structural],
        resolution
      })
    ).toThrow(/必须第三人仲裁/);
  });

  it("超容差禁止 consensus，仲裁者必须独立，最终 Gold 只从第三人 annotation 派生", () => {
    const alpha = createAnnotation("reviewer-alpha");
    const beta = createAnnotation("reviewer-beta", shiftedAnchorGold(500));
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, beta],
        resolution: {
          kind: "consensus",
          selectedAnnotationDigest: alpha.annotationDigest,
          note: "错误地尝试共识。"
        }
      })
    ).toThrow(/必须第三人仲裁/);

    const resolvedGold = shiftedAnchorGold(250);
    const sameReviewerAdjudication = createAnnotation("reviewer-alpha", resolvedGold);
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, beta],
        resolution: {
          kind: "adjudicated",
          adjudicationAnnotation: sameReviewerAdjudication,
          note: "仲裁。"
        }
      })
    ).toThrow(/独立于两名原始 reviewer/);

    const reusedSignedMapAdjudication = createAnnotation("reviewer-gamma", resolvedGold, {
      ...alpha.reviewVerification,
      verifier: "reviewer-gamma"
    });
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, beta],
        resolution: {
          kind: "adjudicated",
          adjudicationAnnotation: reusedSignedMapAdjudication,
          note: "错误复用原 reviewer 的 signed map。"
        }
      })
    ).toThrow(/不同 verificationId/);

    const reusedEvidenceAdjudication = createAnnotation("reviewer-gamma", resolvedGold, {
      ...createReviewVerification("reviewer-gamma"),
      reviewEvidenceDigest: alpha.reviewVerification.reviewEvidenceDigest
    });
    expect(() =>
      freezeRealMediaGoldCase({
        caseInput: createCaseInput(),
        annotations: [alpha, beta],
        resolution: {
          kind: "adjudicated",
          adjudicationAnnotation: reusedEvidenceAdjudication,
          note: "错误复用原 reviewer 的复核证据。"
        }
      })
    ).toThrow(/不同 reviewEvidenceDigest/);

    const gamma = createAnnotation("reviewer-gamma", resolvedGold);
    const frozen = freezeRealMediaGoldCase({
      caseInput: createCaseInput(),
      annotations: [alpha, beta],
      resolution: {
        kind: "adjudicated",
        adjudicationAnnotation: gamma,
        note: "第三名复核者逐边界仲裁后提交 resolved Gold。"
      }
    });
    expect(frozen.manifestCase.gold).toEqual(
      createRealMediaGoldAnnotationEnvelope({
        ...createAnnotationInput("normalizer", resolvedGold)
      }).gold
    );
    expect(frozen.manifestCase.adjudication).toEqual({
      status: "resolved",
      adjudicatorId: "reviewer-gamma",
      note: "第三名复核者逐边界仲裁后提交 resolved Gold。"
    });
    expect(frozen.receipt.resolution).toMatchObject({
      kind: "adjudicated",
      adjudicatorId: "reviewer-gamma",
      adjudicationAnnotationDigest: gamma.annotationDigest,
      resolvedGoldDigest: createRealMediaGoldDigest(resolvedGold)
    });
    expect(() =>
      assertRealMediaGoldFreezeReceiptMatchesCase(
        frozen.receipt,
        [alpha, beta],
        frozen.manifestCase,
        gamma
      )
    ).not.toThrow();
    expect(() =>
      assertRealMediaGoldFreezeReceiptMatchesCase(
        frozen.receipt,
        [alpha, beta],
        frozen.manifestCase,
        createAnnotation("reviewer-delta", resolvedGold)
      )
    ).toThrow(/adjudicated Gold/);
  });

  it("annotation、最终 Gold 或 receipt 任一变化都会破坏冻结绑定", () => {
    const alpha = createAnnotation("reviewer-alpha");
    const beta = createAnnotation("reviewer-beta", shiftedAnchorGold(50));
    const frozen = freezeRealMediaGoldCase({
      caseInput: createCaseInput(),
      annotations: [alpha, beta],
      resolution: {
        kind: "consensus",
        selectedAnnotationDigest: alpha.annotationDigest,
        note: "选择 alpha。"
      }
    });

    const replacedBeta = createAnnotation("reviewer-beta", shiftedAnchorGold(40));
    expect(() =>
      assertRealMediaGoldFreezeReceiptMatchesCase(
        frozen.receipt,
        [alpha, replacedBeta],
        frozen.manifestCase
      )
    ).toThrow(/annotation digest/);

    const changedCase = structuredClone(frozen.manifestCase);
    changedCase.gold.matchedAnchors[2].targetMs += 10;
    expect(() =>
      assertRealMediaGoldFreezeReceiptMatchesCase(frozen.receipt, [alpha, beta], changedCase)
    ).toThrow(/最终 Gold/);

    const changedReceipt = structuredClone(frozen.receipt);
    changedReceipt.finalGoldDigest = `sha256:${"f".repeat(64)}`;
    expect(() => parseRealMediaGoldFreezeReceiptJson(JSON.stringify(changedReceipt))).toThrow(
      /receiptDigest.*不一致/
    );
  });
});

function createAnnotation(
  reviewerId: string,
  gold: RealMediaBenchmarkGold = createGold(),
  reviewVerification: RealMediaGoldReviewVerification = createReviewVerification(reviewerId)
): RealMediaGoldAnnotationEnvelope {
  return createRealMediaGoldAnnotationEnvelope(
    createAnnotationInput(reviewerId, gold, reviewVerification)
  );
}

function createAnnotationInput(
  reviewerId: string,
  gold: RealMediaBenchmarkGold,
  reviewVerification: RealMediaGoldReviewVerification = createReviewVerification(reviewerId)
) {
  const caseInput = createCaseInput();
  return {
    caseId: caseInput.id,
    source: createBinding(caseInput.source.contentIdentity?.digest ?? ""),
    target: createBinding(caseInput.target.contentIdentity?.digest ?? "", 4, 3),
    boundaryToleranceMs: caseInput.boundaryToleranceMs,
    reviewerId,
    reviewVerification,
    gold
  };
}

function createReviewVerification(reviewerId: string): RealMediaGoldReviewVerification {
  const seed = [...reviewerId].reduce(
    (value, character) => (value * 33 + (character.codePointAt(0) ?? 0)) >>> 0,
    5381
  );
  const digest = (offset: number) => ((seed + offset) >>> 0).toString(16).padStart(64, "0");
  return {
    recordVersion: 2,
    method: "manual-review",
    verificationId: `verification-${reviewerId}`,
    issuerKeyId: "test-installation-authority",
    issuerSequence: Math.max(1, seed),
    signatureAlgorithm: "hmac-sha256-v1",
    signature: digest(1),
    requestDigest: `sha256:${digest(2)}`,
    reviewEvidenceDigest: `sha256:${digest(3)}`,
    verifier: reviewerId
  };
}

function createCaseInput(): RealMediaGoldBenchmarkCaseInput {
  return {
    id: "gold-case-001",
    title: "真实媒体 Gold 治理样例",
    split: "frozen-test",
    scenarios: ["global-offset", "source-only", "target-only", "ambiguous", "multi-edit"],
    source: {
      path: "C:\\private-gold\\reference.mkv",
      ...createBinding("a".repeat(64)),
      versionNote: "固定参考版本。",
      licenseNote: "获授权本地测试。"
    },
    target: {
      path: "C:\\private-gold\\original.mkv",
      ...createBinding("b".repeat(64), 4, 3),
      versionNote: "固定原片版本。",
      licenseNote: "获授权本地测试。"
    },
    boundaryToleranceMs: 100,
    versionNotes: ["双端版本已锁定。"],
    licenseNotes: ["仅用于合法本地基准。"]
  };
}

function createBinding(
  digest: string,
  audioStreamIndex = 1,
  videoStreamIndex = 2
): RealMediaGoldMediaBinding {
  return {
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: audioStreamIndex === 1 ? 1_024 : 2_048,
      digest
    },
    audioStreamIndex,
    videoStreamIndex
  };
}

function createGold(): RealMediaBenchmarkGold {
  return {
    sourceStartMs: 0,
    sourceEndMs: 100_000,
    targetStartMs: 0,
    targetEndMs: 110_000,
    matchedAnchors: [
      { id: "anchor-0", sourceMs: 5_000, targetMs: 5_000 },
      { id: "anchor-1", sourceMs: 25_000, targetMs: 25_000 },
      { id: "anchor-2", sourceMs: 45_000, targetMs: 47_000 },
      { id: "anchor-3", sourceMs: 65_000, targetMs: 70_000 },
      { id: "anchor-4", sourceMs: 85_000, targetMs: 95_000 }
    ],
    sourceOnlySpans: [
      {
        kind: "sourceOnly",
        sourceStartMs: 30_000,
        sourceEndMs: 32_000,
        targetStartMs: 30_000,
        targetEndMs: 30_000
      }
    ],
    targetOnlySpans: [
      {
        kind: "targetOnly",
        sourceStartMs: 50_000,
        sourceEndMs: 50_000,
        targetStartMs: 52_000,
        targetEndMs: 55_000
      }
    ],
    ambiguousSpans: [
      {
        kind: "ambiguous",
        sourceStartMs: 70_000,
        sourceEndMs: 72_000,
        targetStartMs: 75_000,
        targetEndMs: 77_000
      }
    ]
  };
}

function shiftedAnchorGold(deltaMs: number): RealMediaBenchmarkGold {
  const gold = createGold();
  gold.matchedAnchors[2].targetMs += deltaMs;
  return gold;
}

function shiftSpan(
  span: {
    sourceStartMs: number;
    sourceEndMs: number;
    targetStartMs: number;
    targetEndMs: number;
  },
  deltaMs: number
): void {
  span.sourceStartMs += deltaMs;
  span.sourceEndMs += deltaMs;
  span.targetStartMs += deltaMs;
  span.targetEndMs += deltaMs;
}
