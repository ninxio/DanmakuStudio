import { describe, expect, it } from "vitest";
import {
  REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
  type RealMediaBenchmarkGold,
  type RealMediaBenchmarkManifest
} from "./realMediaBenchmark";
import {
  createRealMediaGoldAnnotationEnvelope,
  freezeRealMediaGoldCase,
  type RealMediaGoldAnnotationEnvelope,
  type RealMediaGoldBenchmarkCaseInput,
  type RealMediaGoldFreezeReceipt,
  type RealMediaGoldMediaBinding,
  type RealMediaGoldReviewVerification
} from "./realMediaGoldGovernance";
import {
  REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE,
  REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND,
  assertRealMediaGoldBenchmarkBundle,
  createRealMediaGoldBenchmarkBundle,
  parseRealMediaGoldBenchmarkBundleJson,
  serializeRealMediaGoldBenchmarkBundle,
  type RealMediaGoldBenchmarkBundleInput
} from "./realMediaGoldBenchmarkBundle";

describe("C137 governed real-media benchmark bundle", () => {
  it("consensus bundle 固定 assurance/releaseEligible，并对 annotation 输入顺序确定", () => {
    const fixture = createGovernanceFixture("bundle-case-consensus", "consensus");
    const bundle = createRealMediaGoldBenchmarkBundle(fixture);
    const reversed = createRealMediaGoldBenchmarkBundle({
      ...fixture,
      annotations: [...fixture.annotations].reverse()
    });

    expect(bundle.kind).toBe(REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND);
    expect(bundle.assurance).toBe(REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE);
    expect(bundle.releaseEligible).toBe(false);
    expect(bundle.annotations).toHaveLength(2);
    expect(bundle.adjudicationAnnotation).toBeNull();
    expect(reversed).toEqual(bundle);
    expect(() => assertRealMediaGoldBenchmarkBundle(bundle)).not.toThrow();

    const serialized = serializeRealMediaGoldBenchmarkBundle(bundle);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseRealMediaGoldBenchmarkBundleJson(serialized)).toEqual(bundle);
    expect(
      serializeRealMediaGoldBenchmarkBundle(parseRealMediaGoldBenchmarkBundleJson(serialized))
    ).toBe(serialized);
  });

  it("adjudicated bundle 必须携带 receipt 绑定的第三份 annotation", () => {
    const fixture = createGovernanceFixture("bundle-case-adjudicated", "adjudicated");
    const bundle = createRealMediaGoldBenchmarkBundle(fixture);

    expect(bundle.adjudicationAnnotation?.reviewerId).toBe("reviewer-gamma");
    expect(bundle.receipt.resolution).toMatchObject({
      kind: "adjudicated",
      adjudicationAnnotationDigest: bundle.adjudicationAnnotation?.annotationDigest
    });
    expect(
      parseRealMediaGoldBenchmarkBundleJson(serializeRealMediaGoldBenchmarkBundle(bundle))
    ).toEqual(bundle);

    expect(() =>
      createRealMediaGoldBenchmarkBundle({
        ...fixture,
        adjudicationAnnotation: null
      })
    ).toThrow(/必须提供.*第三人仲裁标注/);
  });

  it("严格拒绝额外字段、bundle 内容篡改和非单 real-case manifest", () => {
    const fixture = createGovernanceFixture("bundle-case-tamper", "consensus");
    const bundle = createRealMediaGoldBenchmarkBundle(fixture);
    const withExtraField = { ...bundle, unexpected: true };
    expect(() => parseRealMediaGoldBenchmarkBundleJson(JSON.stringify(withExtraField))).toThrow(
      /字段必须严格为/
    );

    const changedDigest = structuredClone(bundle);
    changedDigest.bundleDigest = `sha256:${"f".repeat(64)}`;
    expect(() => parseRealMediaGoldBenchmarkBundleJson(JSON.stringify(changedDigest))).toThrow(
      /bundleDigest.*不一致/
    );

    const changedManifest = structuredClone(bundle);
    changedManifest.manifest.cases[0].title = "被篡改的关系标题";
    expect(() =>
      parseRealMediaGoldBenchmarkBundleJson(JSON.stringify(changedManifest))
    ).toThrow(/case input|bundleDigest/);

    const twoCases: RealMediaBenchmarkManifest = {
      ...fixture.manifest,
      cases: [fixture.manifest.cases[0], structuredClone(fixture.manifest.cases[0])]
    };
    twoCases.cases[1].id = "second-case";
    expect(() =>
      createRealMediaGoldBenchmarkBundle({ ...fixture, manifest: twoCases })
    ).toThrow(/恰好包含一个 real case/);
  });

  it("即使 raw receipt 自身可解析，也拒绝与 manifest/annotations 不匹配的 receipt", () => {
    const fixture = createGovernanceFixture("bundle-case-receipt-a", "consensus");
    const other = createGovernanceFixture("bundle-case-receipt-b", "consensus");
    expect(() =>
      createRealMediaGoldBenchmarkBundle({
        ...fixture,
        receipt: other.receipt
      })
    ).toThrow(/receipt.*(?:annotation digest|身份).*不一致/);

    const bundle = createRealMediaGoldBenchmarkBundle(fixture);
    const changedRawReceipt = structuredClone(bundle);
    changedRawReceipt.receipt.finalGoldDigest = `sha256:${"e".repeat(64)}`;
    expect(() =>
      parseRealMediaGoldBenchmarkBundleJson(JSON.stringify(changedRawReceipt))
    ).toThrow(/receiptDigest.*不一致/);
  });
});

type GovernanceMode = "consensus" | "adjudicated";

function createGovernanceFixture(
  caseId: string,
  mode: GovernanceMode
): RealMediaGoldBenchmarkBundleInput {
  const baseGold = createGold();
  const betaGold = structuredClone(baseGold);
  betaGold.matchedAnchors[2].targetMs += mode === "consensus" ? 40 : 500;
  const alpha = createAnnotation(caseId, "reviewer-alpha", baseGold, 1);
  const beta = createAnnotation(caseId, "reviewer-beta", betaGold, 2);
  const annotations = [alpha, beta] as const;
  const caseInput = createCaseInput(caseId);

  let adjudicationAnnotation: RealMediaGoldAnnotationEnvelope | null = null;
  let frozen: {
    manifestCase: RealMediaBenchmarkManifest["cases"][number];
    receipt: RealMediaGoldFreezeReceipt;
  };
  if (mode === "consensus") {
    frozen = freezeRealMediaGoldCase({
      caseInput,
      annotations,
      resolution: {
        kind: "consensus",
        selectedAnnotationDigest: alpha.annotationDigest,
        note: "两份独立标注位于容差内，明确采用 alpha。"
      }
    });
  } else {
    const resolvedGold = structuredClone(baseGold);
    resolvedGold.matchedAnchors[2].targetMs += 250;
    adjudicationAnnotation = createAnnotation(caseId, "reviewer-gamma", resolvedGold, 3);
    frozen = freezeRealMediaGoldCase({
      caseInput,
      annotations,
      resolution: {
        kind: "adjudicated",
        adjudicationAnnotation,
        note: "第三名 reviewer 完成逐边界仲裁。"
      }
    });
  }

  const manifest: RealMediaBenchmarkManifest = {
    schemaVersion: REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
    id: `governed-${caseId}`,
    name: `${caseId} governed benchmark`,
    datasetVersion: `gold-v1-${caseId}`,
    description: "受治理真实媒体 Gold bundle 测试。",
    isExample: false,
    licenseNotes: ["仅用于获授权本地测试。"],
    cases: [frozen.manifestCase]
  };
  return {
    manifest,
    annotations,
    adjudicationAnnotation,
    receipt: frozen.receipt
  };
}

function createAnnotation(
  caseId: string,
  reviewerId: string,
  gold: RealMediaBenchmarkGold,
  verificationIndex: number
): RealMediaGoldAnnotationEnvelope {
  const caseInput = createCaseInput(caseId);
  return createRealMediaGoldAnnotationEnvelope({
    caseId,
    source: bindingFromCaseInput(caseInput.source),
    target: bindingFromCaseInput(caseInput.target),
    boundaryToleranceMs: caseInput.boundaryToleranceMs,
    reviewerId,
    reviewVerification: createReviewVerification(reviewerId, verificationIndex),
    gold
  });
}

function createReviewVerification(
  reviewerId: string,
  index: number
): RealMediaGoldReviewVerification {
  const digest = (offset: number) => (index * 10 + offset).toString(16).padStart(64, "0");
  return {
    recordVersion: 2,
    method: "manual-review",
    verificationId: `verification-${reviewerId}-${index}`,
    issuerKeyId: "bundle-test-authority",
    issuerSequence: index,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: digest(1),
    requestDigest: `sha256:${digest(2)}`,
    reviewEvidenceDigest: `sha256:${digest(3)}`,
    verifier: reviewerId
  };
}

function createCaseInput(caseId: string): RealMediaGoldBenchmarkCaseInput {
  return {
    id: caseId,
    title: `${caseId} 真实媒体关系`,
    split: "frozen-test",
    scenarios: ["codec-variant"],
    source: {
      path: `C:\\private-gold\\${caseId}-reference.mkv`,
      ...createBinding("a".repeat(64), 1, 0),
      versionNote: "固定参考版本。",
      licenseNote: "获授权本地测试。"
    },
    target: {
      path: `C:\\private-gold\\${caseId}-original.mkv`,
      ...createBinding("b".repeat(64), 2, 1),
      versionNote: "固定原片版本。",
      licenseNote: "获授权本地测试。"
    },
    boundaryToleranceMs: 80,
    versionNotes: ["双端版本已锁定。"],
    licenseNotes: ["仅用于获授权本地测试。"]
  };
}

function bindingFromCaseInput(
  media: RealMediaGoldBenchmarkCaseInput["source"]
): RealMediaGoldMediaBinding {
  if (media.contentIdentity === null) throw new Error("测试媒体缺少 content identity");
  return {
    contentIdentity: { ...media.contentIdentity },
    audioStreamIndex: media.audioStreamIndex,
    videoStreamIndex: media.videoStreamIndex
  };
}

function createBinding(
  digest: string,
  audioStreamIndex: number,
  videoStreamIndex: number
): RealMediaGoldMediaBinding {
  return {
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: audioStreamIndex * 1_024,
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
    targetEndMs: 100_000,
    matchedAnchors: [
      { id: "anchor-0", sourceMs: 5_000, targetMs: 5_000 },
      { id: "anchor-1", sourceMs: 25_000, targetMs: 25_000 },
      { id: "anchor-2", sourceMs: 45_000, targetMs: 45_000 },
      { id: "anchor-3", sourceMs: 65_000, targetMs: 65_000 },
      { id: "anchor-4", sourceMs: 85_000, targetMs: 85_000 }
    ],
    sourceOnlySpans: [],
    targetOnlySpans: [],
    ambiguousSpans: []
  };
}
