import { sha256Hex } from "../shared/sha256";
import {
  parseRealMediaBenchmarkManifestJson,
  type RealMediaBenchmarkManifest
} from "./realMediaBenchmark";
import {
  REAL_MEDIA_GOLD_FREEZE_ASSURANCE,
  assertRealMediaGoldFreezeReceiptMatchesCase,
  parseRealMediaGoldAnnotationEnvelopeJson,
  parseRealMediaGoldFreezeReceiptJson,
  serializeRealMediaGoldAnnotationEnvelope,
  serializeRealMediaGoldFreezeReceipt,
  type RealMediaGoldAnnotationEnvelope,
  type RealMediaGoldDigest,
  type RealMediaGoldFreezeReceipt
} from "./realMediaGoldGovernance";

export const REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND =
  "real-media-governed-benchmark-bundle" as const;
export const REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE = REAL_MEDIA_GOLD_FREEZE_ASSURANCE;

const BUNDLE_DIGEST_DOMAIN = "real-media-governed-benchmark-bundle-v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const BUNDLE_KEYS = [
  "schemaVersion",
  "kind",
  "assurance",
  "releaseEligible",
  "manifest",
  "annotations",
  "adjudicationAnnotation",
  "receipt",
  "bundleDigest"
] as const;

export interface RealMediaGoldBenchmarkBundleInput {
  manifest: RealMediaBenchmarkManifest;
  annotations: readonly RealMediaGoldAnnotationEnvelope[];
  adjudicationAnnotation: RealMediaGoldAnnotationEnvelope | null;
  receipt: RealMediaGoldFreezeReceipt;
}

export interface RealMediaGoldBenchmarkBundle {
  schemaVersion: typeof REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_SCHEMA_VERSION;
  kind: typeof REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND;
  assurance: typeof REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE;
  releaseEligible: false;
  manifest: RealMediaBenchmarkManifest;
  annotations: readonly [RealMediaGoldAnnotationEnvelope, RealMediaGoldAnnotationEnvelope];
  adjudicationAnnotation: RealMediaGoldAnnotationEnvelope | null;
  receipt: RealMediaGoldFreezeReceipt;
  bundleDigest: RealMediaGoldDigest;
}

type RealMediaGoldBenchmarkBundleCore = Omit<RealMediaGoldBenchmarkBundle, "bundleDigest">;

export function createRealMediaGoldBenchmarkBundle(
  input: RealMediaGoldBenchmarkBundleInput
): RealMediaGoldBenchmarkBundle {
  const core = normalizeBundleCore({
    schemaVersion: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_SCHEMA_VERSION,
    kind: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND,
    assurance: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE,
    releaseEligible: false,
    manifest: input.manifest,
    annotations: input.annotations,
    adjudicationAnnotation: input.adjudicationAnnotation,
    receipt: input.receipt
  });
  return {
    ...core,
    bundleDigest: digestBundle(core)
  };
}

export function parseRealMediaGoldBenchmarkBundleJson(
  json: string
): RealMediaGoldBenchmarkBundle {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error(`受治理真实媒体 benchmark bundle JSON 无法解析：${formatError(error)}`);
  }
  return parseBundle(value);
}

export function serializeRealMediaGoldBenchmarkBundle(
  bundle: RealMediaGoldBenchmarkBundle
): string {
  return `${canonicalJson(parseBundle(bundle))}\n`;
}

export function assertRealMediaGoldBenchmarkBundle(
  value: unknown
): asserts value is RealMediaGoldBenchmarkBundle {
  parseBundle(value);
}

function parseBundle(value: unknown): RealMediaGoldBenchmarkBundle {
  const record = requireExactRecord(value, BUNDLE_KEYS, "真实媒体 Gold benchmark bundle");
  const core = normalizeBundleCore({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    assurance: record.assurance,
    releaseEligible: record.releaseEligible,
    manifest: record.manifest,
    annotations: record.annotations,
    adjudicationAnnotation: record.adjudicationAnnotation,
    receipt: record.receipt
  });
  const bundleDigest = requireDigest(record.bundleDigest, "Gold benchmark bundleDigest");
  if (bundleDigest !== digestBundle(core)) {
    throw new Error(
      "Gold benchmark bundleDigest 与规范化 bundle 内容不一致，bundle 可能已被篡改。"
    );
  }
  return { ...core, bundleDigest };
}

function normalizeBundleCore(value: {
  schemaVersion: unknown;
  kind: unknown;
  assurance: unknown;
  releaseEligible: unknown;
  manifest: unknown;
  annotations: unknown;
  adjudicationAnnotation: unknown;
  receipt: unknown;
}): RealMediaGoldBenchmarkBundleCore {
  if (
    value.schemaVersion !== REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_SCHEMA_VERSION ||
    value.kind !== REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND
  ) {
    throw new Error("真实媒体 Gold benchmark bundle schemaVersion 或 kind 无效。");
  }
  if (value.assurance !== REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE) {
    throw new Error(
      `真实媒体 Gold benchmark bundle assurance 必须为 ${REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE}。`
    );
  }
  if (value.releaseEligible !== false) {
    throw new Error("真实媒体 Gold benchmark bundle 必须固定 releaseEligible=false。");
  }

  const manifest = parseRealMediaBenchmarkManifestJson(canonicalJson(value.manifest));
  if (manifest.cases.length !== 1 || manifest.cases[0]?.mediaKind !== "real") {
    throw new Error("受治理 benchmark bundle 的 manifest 必须恰好包含一个 real case。");
  }

  const rawAnnotations = requireArray(value.annotations, "Gold benchmark bundle annotations");
  if (rawAnnotations.length !== 2) {
    throw new Error("受治理 benchmark bundle 必须恰好包含两份独立 annotation。");
  }
  const parsedAnnotations = rawAnnotations
    .map((annotation) =>
      parseRealMediaGoldAnnotationEnvelopeJson(
        serializeRealMediaGoldAnnotationEnvelope(annotation as RealMediaGoldAnnotationEnvelope)
      )
    )
    .sort((left, right) => compareAscii(left.annotationDigest, right.annotationDigest));
  const first = parsedAnnotations[0];
  const second = parsedAnnotations[1];
  if (first === undefined || second === undefined) {
    throw new Error("受治理 benchmark bundle 缺少两份独立 annotation。");
  }
  const annotations = [first, second] as const;

  const adjudicationAnnotation =
    value.adjudicationAnnotation === null
      ? null
      : parseRealMediaGoldAnnotationEnvelopeJson(
          serializeRealMediaGoldAnnotationEnvelope(
            value.adjudicationAnnotation as RealMediaGoldAnnotationEnvelope
          )
        );
  const receipt = parseRealMediaGoldFreezeReceiptJson(
    serializeRealMediaGoldFreezeReceipt(value.receipt as RealMediaGoldFreezeReceipt)
  );

  assertRealMediaGoldFreezeReceiptMatchesCase(
    receipt,
    annotations,
    manifest.cases[0],
    adjudicationAnnotation
  );

  return {
    schemaVersion: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_SCHEMA_VERSION,
    kind: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_KIND,
    assurance: REAL_MEDIA_GOLD_BENCHMARK_BUNDLE_ASSURANCE,
    releaseEligible: false,
    manifest,
    annotations,
    adjudicationAnnotation,
    receipt
  };
}

function digestBundle(core: RealMediaGoldBenchmarkBundleCore): RealMediaGoldDigest {
  return `sha256:${sha256Hex(`${BUNDLE_DIGEST_DOMAIN}\n${canonicalJson(core)}`)}`;
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
