import type {
  RealMediaBenchmarkContentIdentity,
  RealMediaBenchmarkGold,
  RealMediaBenchmarkScenario
} from "./realMediaBenchmark";

const LONG_REFERENCE_MIN_MS = 45 * 60 * 1_000;

/**
 * 只派生能由 Gold 坐标、时长和双端全文件身份直接证明的场景。
 * multi-audio / visual-fallback / repeated-content / pts-offset 等必须等 probe evidence
 * 进入签名 annotation 后才能声明，不能由冻结操作员自由勾选。
 */
export function deriveRealMediaBenchmarkScenarios(
  gold: RealMediaBenchmarkGold,
  sourceIdentity: RealMediaBenchmarkContentIdentity,
  targetIdentity: RealMediaBenchmarkContentIdentity
): RealMediaBenchmarkScenario[] {
  const scenarios = new Set<RealMediaBenchmarkScenario>();
  const editCount =
    gold.sourceOnlySpans.length + gold.targetOnlySpans.length + gold.ambiguousSpans.length;
  if (gold.sourceOnlySpans.length > 0) scenarios.add("source-only");
  if (gold.targetOnlySpans.length > 0) scenarios.add("target-only");
  if (gold.ambiguousSpans.length > 0) scenarios.add("ambiguous");
  if (editCount > 1) scenarios.add("multi-edit");

  const first = gold.matchedAnchors[0];
  const last = gold.matchedAnchors.at(-1);
  if (
    gold.sourceStartMs !== gold.targetStartMs ||
    (first !== undefined && first.sourceMs !== first.targetMs)
  ) {
    scenarios.add("global-offset");
  }
  if (
    editCount === 0 &&
    first !== undefined &&
    last !== undefined &&
    last.sourceMs > first.sourceMs &&
    last.targetMs - first.targetMs !== last.sourceMs - first.sourceMs
  ) {
    scenarios.add("time-stretch");
  }
  if (gold.sourceEndMs - gold.sourceStartMs >= LONG_REFERENCE_MIN_MS) {
    scenarios.add("long-reference");
  }

  if (scenarios.size === 0 && !sameIdentity(sourceIdentity, targetIdentity)) {
    scenarios.add("codec-variant");
  }
  if (scenarios.size === 0) {
    throw new Error(
      "当前关系没有可由 Gold、时长或双端身份证明的 benchmark 场景，禁止手工补造标签。"
    );
  }
  return [...scenarios].sort();
}

function sameIdentity(
  left: RealMediaBenchmarkContentIdentity,
  right: RealMediaBenchmarkContentIdentity
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.sizeBytes === right.sizeBytes &&
    left.digest === right.digest
  );
}
