import { sha256Hex } from "../shared/sha256";
import {
  REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
  parseRealMediaBenchmarkManifestJson,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkScenario
} from "./realMediaBenchmark";
import {
  REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE,
  parseRealMediaGoldBenchmarkBundleJson,
  serializeRealMediaGoldBenchmarkBundle,
  type RealMediaGoldBenchmarkBundle
} from "./realMediaGoldBenchmarkBundle";
import type { RealMediaGoldDigest } from "./realMediaGoldGovernance";

export const REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_KIND =
  "real-media-governed-development-dataset" as const;
export const REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_MAX_CASES = 1_000;

const DATASET_DIGEST_DOMAIN = "real-media-governed-development-dataset-v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DATASET_KEYS = [
  "schemaVersion",
  "kind",
  "assurance",
  "releaseEligible",
  "manifest",
  "sourceBundles",
  "coverage",
  "datasetDigest"
] as const;
const COVERAGE_KEYS = [
  "schemaVersion",
  "caseCount",
  "developmentCaseCount",
  "frozenTestCaseCount",
  "distinctSourceBindingCount",
  "distinctTargetBindingCount",
  "distinctReviewerCount",
  "sourceOnlyEventCount",
  "targetOnlyEventCount",
  "ambiguousEventCount",
  "scenarioCaseCounts"
] as const;
const SCENARIOS: readonly RealMediaBenchmarkScenario[] = [
  "global-offset",
  "time-stretch",
  "source-only",
  "target-only",
  "ambiguous",
  "multi-edit",
  "multi-audio",
  "long-reference",
  "visual-fallback",
  "repeated-content",
  "pts-offset",
  "codec-variant"
];

export interface RealMediaGoldDevelopmentDatasetMetadata {
  id: string;
  name: string;
  datasetVersion: string;
  description: string;
  licenseNotes: string[];
}

export interface RealMediaGoldDevelopmentDatasetCoverage {
  schemaVersion: 1;
  caseCount: number;
  developmentCaseCount: number;
  frozenTestCaseCount: 0;
  distinctSourceBindingCount: number;
  distinctTargetBindingCount: number;
  distinctReviewerCount: number;
  sourceOnlyEventCount: number;
  targetOnlyEventCount: number;
  ambiguousEventCount: number;
  scenarioCaseCounts: Record<RealMediaBenchmarkScenario, number>;
}

export interface RealMediaGoldDevelopmentDataset {
  schemaVersion: typeof REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_SCHEMA_VERSION;
  kind: typeof REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_KIND;
  assurance: typeof REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE;
  releaseEligible: false;
  manifest: RealMediaBenchmarkManifest;
  sourceBundles: RealMediaGoldBenchmarkBundle[];
  coverage: RealMediaGoldDevelopmentDatasetCoverage;
  datasetDigest: RealMediaGoldDigest;
}

type DatasetCore = Omit<RealMediaGoldDevelopmentDataset, "datasetDigest">;

export function createRealMediaGoldDevelopmentDataset(input: {
  metadata: RealMediaGoldDevelopmentDatasetMetadata;
  bundles: readonly RealMediaGoldBenchmarkBundle[];
}): RealMediaGoldDevelopmentDataset {
  const sourceBundles = normalizeSourceBundles(input.bundles);
  const manifest = parseRealMediaBenchmarkManifestJson(
    canonicalJson({
      schemaVersion: REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
      id: input.metadata.id,
      name: input.metadata.name,
      datasetVersion: input.metadata.datasetVersion,
      description: input.metadata.description,
      isExample: false,
      licenseNotes: input.metadata.licenseNotes,
      cases: sourceBundles.map(singleBundleCase)
    })
  );
  const core: DatasetCore = {
    schemaVersion: REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_SCHEMA_VERSION,
    kind: REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_KIND,
    assurance: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE,
    releaseEligible: false,
    manifest,
    sourceBundles,
    coverage: deriveCoverage(sourceBundles)
  };
  return { ...core, datasetDigest: digestDataset(core) };
}

export function parseRealMediaGoldDevelopmentDatasetJson(
  json: string
): RealMediaGoldDevelopmentDataset {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error(`多 case development 数据集 JSON 无法解析：${formatError(error)}`);
  }
  return parseDataset(value);
}

export function serializeRealMediaGoldDevelopmentDataset(
  dataset: RealMediaGoldDevelopmentDataset
): string {
  return `${canonicalJson(parseDataset(dataset))}\n`;
}

function parseDataset(value: unknown): RealMediaGoldDevelopmentDataset {
  const record = requireExactRecord(value, DATASET_KEYS, "多 case development 数据集");
  if (
    record.schemaVersion !== REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_SCHEMA_VERSION ||
    record.kind !== REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_KIND
  ) {
    throw new Error("多 case development 数据集 schemaVersion 或 kind 无效。");
  }
  if (record.assurance !== REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE) {
    throw new Error("多 case development 数据集 assurance 无效。");
  }
  if (record.releaseEligible !== false) {
    throw new Error("多 case development 数据集必须固定 releaseEligible=false。");
  }
  const manifest = parseRealMediaBenchmarkManifestJson(canonicalJson(record.manifest));
  if (manifest.isExample || manifest.cases.some((item) => item.split !== "development")) {
    throw new Error("多 case 治理数据集只允许非示例 development case。");
  }
  const sourceBundles = normalizeSourceBundles(
    requireArray(record.sourceBundles, "多 case development sourceBundles").map((item) =>
      parseRealMediaGoldBenchmarkBundleJson(canonicalJson(item))
    )
  );
  const expectedManifest: RealMediaBenchmarkManifest = {
    ...manifest,
    cases: sourceBundles.map(singleBundleCase)
  };
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    throw new Error("合并 manifest 的 case 内容或顺序与 sourceBundles 不一致。");
  }
  const coverage = parseCoverage(record.coverage);
  const expectedCoverage = deriveCoverage(sourceBundles);
  if (canonicalJson(coverage) !== canonicalJson(expectedCoverage)) {
    throw new Error("多 case development 覆盖摘要与 sourceBundles 重算结果不一致。");
  }
  const core: DatasetCore = {
    schemaVersion: REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_SCHEMA_VERSION,
    kind: REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_KIND,
    assurance: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE,
    releaseEligible: false,
    manifest,
    sourceBundles,
    coverage
  };
  const datasetDigest = requireDigest(record.datasetDigest, "development datasetDigest");
  if (datasetDigest !== digestDataset(core)) {
    throw new Error("development datasetDigest 与规范化内容不一致，数据集可能已被篡改。");
  }
  return { ...core, datasetDigest };
}

function normalizeSourceBundles(
  input: readonly RealMediaGoldBenchmarkBundle[]
): RealMediaGoldBenchmarkBundle[] {
  if (input.length < 2 || input.length > REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_MAX_CASES) {
    throw new Error(
      `多 case development 数据集必须包含 2–${REAL_MEDIA_GOLD_DEVELOPMENT_DATASET_MAX_CASES} 个单 case 治理 bundle。`
    );
  }
  const bundles = input
    .map((bundle) =>
      parseRealMediaGoldBenchmarkBundleJson(serializeRealMediaGoldBenchmarkBundle(bundle))
    )
    .sort((left, right) => {
      const caseOrder = compareAscii(singleBundleCase(left).id, singleBundleCase(right).id);
      return caseOrder !== 0 ? caseOrder : compareAscii(left.bundleDigest, right.bundleDigest);
    });
  const caseIds = new Set<string>();
  const bundleDigests = new Set<string>();
  const relationBindings = new Set<string>();
  for (const bundle of bundles) {
    const benchmarkCase = singleBundleCase(bundle);
    if (caseIds.has(benchmarkCase.id)) {
      throw new Error(`多 case development 数据集存在重复 case ID：${benchmarkCase.id}。`);
    }
    caseIds.add(benchmarkCase.id);
    if (bundleDigests.has(bundle.bundleDigest)) {
      throw new Error(`多 case development 数据集重复使用 bundle：${bundle.bundleDigest}。`);
    }
    bundleDigests.add(bundle.bundleDigest);
    if (benchmarkCase.split !== "development" || benchmarkCase.mediaKind !== "real") {
      throw new Error(`case ${benchmarkCase.id} 必须是 real development。`);
    }
    const relationKey = createRelationBindingKey(benchmarkCase);
    if (relationBindings.has(relationKey)) {
      throw new Error(`case ${benchmarkCase.id} 重复绑定同一双端媒体身份和流。`);
    }
    relationBindings.add(relationKey);
  }
  return bundles;
}

function singleBundleCase(bundle: RealMediaGoldBenchmarkBundle): RealMediaBenchmarkCase {
  const benchmarkCase = bundle.manifest.cases[0];
  if (!benchmarkCase) throw new Error("单 case 治理 bundle 缺少 manifest case。");
  return structuredClone(benchmarkCase);
}

function createRelationBindingKey(benchmarkCase: RealMediaBenchmarkCase): string {
  return `${createMediaBindingKey(benchmarkCase.source)}->${createMediaBindingKey(benchmarkCase.target)}`;
}

function createMediaBindingKey(media: RealMediaBenchmarkCase["source"]): string {
  const identity = media.contentIdentity;
  if (!identity) throw new Error("受治理 real case 缺少全文件媒体身份。");
  return `${identity.algorithm}:${identity.sizeBytes}:${identity.digest}:a${media.audioStreamIndex}:v${media.videoStreamIndex ?? "none"}`;
}

function deriveCoverage(
  bundles: readonly RealMediaGoldBenchmarkBundle[]
): RealMediaGoldDevelopmentDatasetCoverage {
  const cases = bundles.map(singleBundleCase);
  const scenarioCaseCounts = Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario,
      cases.filter((benchmarkCase) => benchmarkCase.scenarios.includes(scenario)).length
    ])
  ) as Record<RealMediaBenchmarkScenario, number>;
  const reviewers = new Set(
    bundles.flatMap((bundle) => [
      ...bundle.annotations.map((annotation) => annotation.reviewerId),
      ...(bundle.adjudicationAnnotation ? [bundle.adjudicationAnnotation.reviewerId] : [])
    ])
  );
  return {
    schemaVersion: 1,
    caseCount: cases.length,
    developmentCaseCount: cases.length,
    frozenTestCaseCount: 0,
    distinctSourceBindingCount: new Set(
      cases.map((benchmarkCase) => createMediaBindingKey(benchmarkCase.source))
    ).size,
    distinctTargetBindingCount: new Set(
      cases.map((benchmarkCase) => createMediaBindingKey(benchmarkCase.target))
    ).size,
    distinctReviewerCount: reviewers.size,
    sourceOnlyEventCount: cases.reduce(
      (total, benchmarkCase) => total + benchmarkCase.gold.sourceOnlySpans.length,
      0
    ),
    targetOnlyEventCount: cases.reduce(
      (total, benchmarkCase) => total + benchmarkCase.gold.targetOnlySpans.length,
      0
    ),
    ambiguousEventCount: cases.reduce(
      (total, benchmarkCase) => total + benchmarkCase.gold.ambiguousSpans.length,
      0
    ),
    scenarioCaseCounts
  };
}

function parseCoverage(value: unknown): RealMediaGoldDevelopmentDatasetCoverage {
  const record = requireExactRecord(value, COVERAGE_KEYS, "development coverage");
  const scenarioRecord = requireExactRecord(
    record.scenarioCaseCounts,
    SCENARIOS,
    "development scenarioCaseCounts"
  );
  const schemaVersion = requireSafeInteger(record.schemaVersion, "coverage.schemaVersion");
  const frozenTestCaseCount = requireSafeInteger(
    record.frozenTestCaseCount,
    "coverage.frozenTestCaseCount"
  );
  if (schemaVersion !== 1 || frozenTestCaseCount !== 0) {
    throw new Error("development coverage 版本无效或包含 frozen-test case。");
  }
  const coverage: RealMediaGoldDevelopmentDatasetCoverage = {
    schemaVersion: 1,
    caseCount: requireSafeInteger(record.caseCount, "coverage.caseCount"),
    developmentCaseCount: requireSafeInteger(
      record.developmentCaseCount,
      "coverage.developmentCaseCount"
    ),
    frozenTestCaseCount: 0,
    distinctSourceBindingCount: requireSafeInteger(
      record.distinctSourceBindingCount,
      "coverage.distinctSourceBindingCount"
    ),
    distinctTargetBindingCount: requireSafeInteger(
      record.distinctTargetBindingCount,
      "coverage.distinctTargetBindingCount"
    ),
    distinctReviewerCount: requireSafeInteger(
      record.distinctReviewerCount,
      "coverage.distinctReviewerCount"
    ),
    sourceOnlyEventCount: requireSafeInteger(
      record.sourceOnlyEventCount,
      "coverage.sourceOnlyEventCount"
    ),
    targetOnlyEventCount: requireSafeInteger(
      record.targetOnlyEventCount,
      "coverage.targetOnlyEventCount"
    ),
    ambiguousEventCount: requireSafeInteger(
      record.ambiguousEventCount,
      "coverage.ambiguousEventCount"
    ),
    scenarioCaseCounts: Object.fromEntries(
      SCENARIOS.map((scenario) => [
        scenario,
        requireSafeInteger(scenarioRecord[scenario], `coverage.scenarioCaseCounts.${scenario}`)
      ])
    ) as Record<RealMediaBenchmarkScenario, number>
  };
  return coverage;
}

function digestDataset(core: DatasetCore): RealMediaGoldDigest {
  return `sha256:${sha256Hex(`${DATASET_DIGEST_DOMAIN}\n${canonicalJson(core)}`)}`;
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象。`);
  const actual = Object.keys(value).sort(compareAscii);
  const expected = [...expectedKeys].sort(compareAscii);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} 字段必须严格为 ${expected.join(", ")}。`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  return value;
}

function requireDigest(value: unknown, label: string): RealMediaGoldDigest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} 必须为规范的小写 sha256 digest。`);
  }
  return value as RealMediaGoldDigest;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须为非负安全整数。`);
  }
  return value as number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数值。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareAscii)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON 遇到不受支持的值。");
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
