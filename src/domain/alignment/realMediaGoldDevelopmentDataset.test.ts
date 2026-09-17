import { describe, expect, it } from "vitest";
import {
  REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
  type RealMediaBenchmarkGold,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkScenario
} from "./realMediaBenchmark";
import {
  createRealMediaGoldAnnotationEnvelope,
  freezeRealMediaGoldCase,
  type RealMediaGoldBenchmarkCaseInput,
  type RealMediaGoldMediaBinding,
  type RealMediaGoldReviewVerification
} from "./realMediaGoldGovernance";
import { createRealMediaGoldBenchmarkBundle } from "./realMediaGoldBenchmarkBundle";
import {
  createRealMediaGoldDevelopmentDataset,
  parseRealMediaGoldDevelopmentDatasetJson,
  serializeRealMediaGoldDevelopmentDataset
} from "./realMediaGoldDevelopmentDataset";

describe("C137 governed multi-case development dataset", () => {
  it("按 case ID 确定合并多个单 case bundle，并重算覆盖摘要", () => {
    const first = createBundle("case-a", 1, ["codec-variant", "source-only"]);
    const second = createBundle("case-b", 2, ["global-offset", "target-only"]);
    const input = {
      metadata: createMetadata(),
      bundles: [second, first]
    };
    const dataset = createRealMediaGoldDevelopmentDataset(input);
    const reversed = createRealMediaGoldDevelopmentDataset({
      ...input,
      bundles: [first, second]
    });

    expect(dataset).toEqual(reversed);
    expect(dataset.releaseEligible).toBe(false);
    expect(dataset.manifest.cases.map((benchmarkCase) => benchmarkCase.id)).toEqual([
      "case-a",
      "case-b"
    ]);
    expect(dataset.coverage).toMatchObject({
      caseCount: 2,
      developmentCaseCount: 2,
      frozenTestCaseCount: 0,
      distinctSourceBindingCount: 2,
      distinctTargetBindingCount: 2,
      distinctReviewerCount: 2,
      sourceOnlyEventCount: 2,
      targetOnlyEventCount: 2,
      ambiguousEventCount: 2
    });
    expect(dataset.coverage.scenarioCaseCounts).toMatchObject({
      "codec-variant": 1,
      "source-only": 1,
      "global-offset": 1,
      "target-only": 1,
      ambiguous: 0
    });

    const serialized = serializeRealMediaGoldDevelopmentDataset(dataset);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseRealMediaGoldDevelopmentDatasetJson(serialized)).toEqual(dataset);
  });

  it("拒绝重复 case ID 和用不同 ID 包装的重复双端媒体关系", () => {
    expect(() =>
      createRealMediaGoldDevelopmentDataset({
        metadata: createMetadata(),
        bundles: [createBundle("same-case", 1), createBundle("same-case", 2)]
      })
    ).toThrow(/(?:重复 case ID|id 与其他关系重复)/);

    expect(() =>
      createRealMediaGoldDevelopmentDataset({
        metadata: createMetadata(),
        bundles: [createBundle("case-a", 1), createBundle("case-b", 1)]
      })
    ).toThrow(/重复绑定同一双端媒体身份和流/);
  });

  it("拒绝单 bundle、摘要篡改、manifest 漂移和额外字段", () => {
    const first = createBundle("case-a", 1);
    const second = createBundle("case-b", 2);
    expect(() =>
      createRealMediaGoldDevelopmentDataset({
        metadata: createMetadata(),
        bundles: [first]
      })
    ).toThrow(/必须包含 2–1000/);

    const dataset = createRealMediaGoldDevelopmentDataset({
      metadata: createMetadata(),
      bundles: [first, second]
    });
    const changedCoverage = structuredClone(dataset);
    changedCoverage.coverage.caseCount = 3;
    expect(() =>
      parseRealMediaGoldDevelopmentDatasetJson(JSON.stringify(changedCoverage))
    ).toThrow(/覆盖摘要.*不一致/);

    const changedManifest = structuredClone(dataset);
    changedManifest.manifest.cases[0].title = "未由 source bundle 证明的标题";
    expect(() =>
      parseRealMediaGoldDevelopmentDatasetJson(JSON.stringify(changedManifest))
    ).toThrow(/manifest.*sourceBundles 不一致/);

    expect(() =>
      parseRealMediaGoldDevelopmentDatasetJson(JSON.stringify({ ...dataset, unexpected: true }))
    ).toThrow(/字段必须严格为/);
  });
});

function createMetadata() {
  return {
    id: "local-development-gold",
    name: "本机复核 development Gold",
    datasetVersion: "development-v1",
    description: "由多个单 case 治理 bundle 确定合并。",
    licenseNotes: ["仅限获授权本机开发验收。"]
  };
}

function createBundle(
  caseId: string,
  relationIndex: number,
  scenarios: RealMediaBenchmarkScenario[] = ["codec-variant"]
) {
  const caseInput = createCaseInput(caseId, relationIndex, scenarios);
  const gold = createGold();
  const source = bindingFromCaseInput(caseInput.source);
  const target = bindingFromCaseInput(caseInput.target);
  const annotations = [
    createRealMediaGoldAnnotationEnvelope({
      caseId,
      source,
      target,
      boundaryToleranceMs: caseInput.boundaryToleranceMs,
      reviewerId: "reviewer-alpha",
      reviewVerification: createVerification("1", "reviewer-alpha"),
      gold
    }),
    createRealMediaGoldAnnotationEnvelope({
      caseId,
      source,
      target,
      boundaryToleranceMs: caseInput.boundaryToleranceMs,
      reviewerId: "reviewer-beta",
      reviewVerification: createVerification("2", "reviewer-beta"),
      gold: structuredClone(gold)
    })
  ] as const;
  const frozen = freezeRealMediaGoldCase({
    caseInput,
    annotations,
    resolution: {
      kind: "consensus",
      selectedAnnotationDigest: annotations[0].annotationDigest,
      note: "两份独立复核完全一致，选择 alpha 标注。"
    }
  });
  const manifest: RealMediaBenchmarkManifest = {
    schemaVersion: REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
    id: `governed-${caseId}`,
    name: `${caseId} 单 case 治理包`,
    datasetVersion: `gold-v1-${caseId}`,
    description: "development 单 case 复核结果。",
    isExample: false,
    licenseNotes: ["仅限获授权本机开发验收。"],
    cases: [frozen.manifestCase]
  };
  return createRealMediaGoldBenchmarkBundle({
    manifest,
    annotations,
    adjudicationAnnotation: null,
    receipt: frozen.receipt
  });
}

function createCaseInput(
  caseId: string,
  relationIndex: number,
  scenarios: RealMediaBenchmarkScenario[]
): RealMediaGoldBenchmarkCaseInput {
  const sourceDigit = relationIndex.toString(16);
  const targetDigit = (relationIndex + 8).toString(16);
  return {
    id: caseId,
    title: `${caseId} 真实媒体关系`,
    split: "development",
    scenarios,
    source: {
      path: `C:\\private-gold\\${caseId}-reference.mkv`,
      ...createBinding(sourceDigit.repeat(64), relationIndex * 1_024, 0, 0),
      versionNote: "固定参考版本。",
      licenseNote: "获授权本地测试。"
    },
    target: {
      path: `C:\\private-gold\\${caseId}-original.mkv`,
      ...createBinding(targetDigit.repeat(64), relationIndex * 2_048, 1, 0),
      versionNote: "固定原片版本。",
      licenseNote: "获授权本地测试。"
    },
    boundaryToleranceMs: 80,
    versionNotes: ["双端版本已锁定。"],
    licenseNotes: ["仅限获授权本地开发。"]
  };
}

function createBinding(
  digest: string,
  sizeBytes: number,
  audioStreamIndex: number,
  videoStreamIndex: number
): RealMediaGoldMediaBinding {
  return {
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes,
      digest
    },
    audioStreamIndex,
    videoStreamIndex
  };
}

function bindingFromCaseInput(
  media: RealMediaGoldBenchmarkCaseInput["source"]
): RealMediaGoldMediaBinding {
  if (!media.contentIdentity) throw new Error("测试媒体缺少 content identity");
  return {
    contentIdentity: { ...media.contentIdentity },
    audioStreamIndex: media.audioStreamIndex,
    videoStreamIndex: media.videoStreamIndex
  };
}

function createVerification(
  digit: "1" | "2",
  reviewerId: string
): RealMediaGoldReviewVerification {
  return {
    recordVersion: 2,
    method: "manual-review",
    verificationId: `verification-${reviewerId}`,
    issuerKeyId: "dataset-test-authority",
    issuerSequence: digit === "1" ? 1 : 2,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: digit.repeat(64),
    requestDigest: `sha256:${digit.repeat(64)}`,
    reviewEvidenceDigest: `sha256:${digit === "1" ? "a".repeat(64) : "b".repeat(64)}`,
    verifier: reviewerId
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
