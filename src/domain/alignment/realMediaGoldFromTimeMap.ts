import type { MediaContentIdentity, MediaTimeMap } from "../project/types";
import { areMediaContentIdentitiesEqual } from "../project/mediaIdentity";
import { computeMediaTimeMapCoreDigest } from "./mediaTimeMap";
import { mapSourceTime, validateTimeMap, type TimeMapSpan } from "./timeMap";
import type {
  RealMediaBenchmarkContentIdentity,
  RealMediaBenchmarkGold
} from "./realMediaBenchmark";

const ANCHORS_PER_MATCHED_SPAN = 5;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * 将一张已经确认的分段时间图转换为 reviewer annotation 的坐标事实。
 * 这里只派生坐标，不会把算法 quality、confidence 或 verification 声明写入 gold。
 */
export function createRealMediaBenchmarkGoldFromConfirmedTimeMap(
  timeMap: MediaTimeMap
): RealMediaBenchmarkGold {
  if (timeMap.state !== "confirmed") {
    throw new Error("只有已确认的时间图才能生成独立真实媒体标注。");
  }
  assertSignedManualReviewBinding(timeMap);
  const validation = validateTimeMap(timeMap.spans);
  if (!validation.valid) {
    throw new Error(
      `时间图结构无效，不能生成真实媒体标注：${validation.issues
        .map((issue) => issue.message)
        .join("；")}`
    );
  }
  if (timeMap.spans.length === 0) {
    throw new Error("时间图没有可标注的片段。");
  }

  const matchedAnchors = createMatchedAnchors(timeMap.spans);
  if (matchedAnchors.length < ANCHORS_PER_MATCHED_SPAN) {
    throw new Error("时间图至少需要一个可映射片段和 5 个不同的 matched 标注点。");
  }

  return {
    sourceStartMs: timeMap.sourceStartMs,
    sourceEndMs: timeMap.sourceEndMs,
    targetStartMs: timeMap.targetStartMs,
    targetEndMs: timeMap.targetEndMs,
    matchedAnchors,
    sourceOnlySpans: timeMap.spans
      .filter((span) => span.kind === "sourceOnly")
      .map((span) => stripSpanEvidence(span, "sourceOnly")),
    targetOnlySpans: timeMap.spans
      .filter((span) => span.kind === "targetOnly")
      .map((span) => stripSpanEvidence(span, "targetOnly")),
    ambiguousSpans: timeMap.spans
      .filter((span) => span.kind === "ambiguous")
      .map((span) => stripSpanEvidence(span, "ambiguous"))
  };
}

/**
 * 这里先验证可持久化的签名绑定；调用它的桌面 UI 还必须通过
 * assessMediaTimeMapVerification() 核对本机签发/撤销注册表，才可导出标注。
 */
function assertSignedManualReviewBinding(timeMap: MediaTimeMap): void {
  const record = timeMap.verification;
  if (
    timeMap.quality.level !== "verified" ||
    !record ||
    record.recordVersion !== 2 ||
    record.method !== "manual-review" ||
    record.revocation
  ) {
    throw new Error("真实媒体标注必须绑定未撤销的 v2 人工复核签名和 verified 时间图。");
  }
  if (
    record.mapRevision !== timeMap.revision ||
    record.mapCoreDigest !== computeMediaTimeMapCoreDigest(timeMap) ||
    !timeMap.sourceIdentity ||
    !timeMap.targetIdentity ||
    !areMediaContentIdentitiesEqual(record.sourceIdentity, timeMap.sourceIdentity) ||
    !areMediaContentIdentitiesEqual(record.targetIdentity, timeMap.targetIdentity)
  ) {
    throw new Error("人工复核签名与当前时间图 revision、核心摘要或媒体身份不一致。");
  }
}

/** Convert the native full-file identity shape used by projects into the path-free benchmark shape. */
export function createRealMediaBenchmarkContentIdentity(
  identity: MediaContentIdentity | null
): RealMediaBenchmarkContentIdentity {
  if (!identity) {
    throw new Error("媒体尚未绑定全文件身份，请重新运行桌面对齐后再生成标注。");
  }
  const digests = [
    identity.firstSampleDigest,
    identity.middleSampleDigest,
    identity.lastSampleDigest
  ];
  if (
    identity.algorithm !== "sha256-full-file-v2" ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes <= 0 ||
    !digests.every((digest) => SHA256_HEX.test(digest)) ||
    !digests.every((digest) => digest.toLowerCase() === digests[0].toLowerCase())
  ) {
    throw new Error("媒体身份不是稳定的 sha256-full-file-v2 全文件摘要。");
  }
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: identity.sizeBytes,
    digest: digests[0].toLowerCase()
  };
}

function createMatchedAnchors(spans: readonly TimeMapSpan[]) {
  const coordinates: Array<{ sourceMs: number; targetMs: number }> = [];
  for (const span of spans) {
    if (span.kind !== "matched") continue;
    const sourceDurationMs = span.sourceEndMs - span.sourceStartMs;
    if (sourceDurationMs <= 0) continue;
    for (let sampleIndex = 0; sampleIndex < ANCHORS_PER_MATCHED_SPAN; sampleIndex += 1) {
      const sourceOffsetMs =
        sampleIndex === ANCHORS_PER_MATCHED_SPAN - 1
          ? sourceDurationMs - 1
          : Math.floor((sourceDurationMs * sampleIndex) / (ANCHORS_PER_MATCHED_SPAN - 1));
      const sourceMs = span.sourceStartMs + Math.max(0, sourceOffsetMs);
      const mapping = mapSourceTime(spans, sourceMs);
      if (mapping.status === "mapped") {
        coordinates.push({ sourceMs, targetMs: mapping.targetTimeMs });
      }
    }
  }

  const unique = new Map<string, { sourceMs: number; targetMs: number }>();
  coordinates.forEach((coordinate) => {
    unique.set(`${coordinate.sourceMs}:${coordinate.targetMs}`, coordinate);
  });
  return [...unique.values()]
    .sort((left, right) => left.sourceMs - right.sourceMs || left.targetMs - right.targetMs)
    .map((coordinate, index) => ({
      id: `anchor-${String(index + 1).padStart(4, "0")}`,
      ...coordinate
    }));
}

function stripSpanEvidence<Kind extends Exclude<TimeMapSpan["kind"], "matched">>(
  span: TimeMapSpan,
  kind: Kind
) {
  if (span.kind !== kind) {
    throw new Error("标注片段分类在派生期间发生不一致。");
  }
  return {
    kind,
    sourceStartMs: span.sourceStartMs,
    sourceEndMs: span.sourceEndMs,
    targetStartMs: span.targetStartMs,
    targetEndMs: span.targetEndMs
  };
}
