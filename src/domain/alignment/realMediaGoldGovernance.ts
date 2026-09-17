import { sha256Hex } from "../shared/sha256";
import {
  REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
  validateRealMediaBenchmarkManifest,
  type RealMediaBenchmarkAmbiguousSpan,
  type RealMediaBenchmarkAnchor,
  type RealMediaBenchmarkCase,
  type RealMediaBenchmarkContentIdentity,
  type RealMediaBenchmarkGold,
  type RealMediaBenchmarkManifest,
  type RealMediaBenchmarkMediaInput,
  type RealMediaBenchmarkSourceOnlySpan,
  type RealMediaBenchmarkTargetOnlySpan
} from "./realMediaBenchmark";
import { validateTimeMap, type TimeMapSpan } from "./timeMap";

export const REAL_MEDIA_GOLD_ANNOTATION_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_GOLD_FREEZE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const REAL_MEDIA_GOLD_FREEZE_ASSURANCE =
  "untrusted-self-consistent-gold-governance" as const;

const ANNOTATION_DIGEST_DOMAIN = "real-media-gold-annotation-v1";
const GOLD_DIGEST_DOMAIN = "real-media-gold-v1";
const CASE_INPUT_DIGEST_DOMAIN = "real-media-gold-case-input-v1";
const FREEZE_RECEIPT_DIGEST_DOMAIN = "real-media-gold-freeze-receipt-v1";
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SPAN_BOUNDARY_FIELDS = [
  "sourceStartMs",
  "sourceEndMs",
  "targetStartMs",
  "targetEndMs"
] as const;
const TOTAL_RANGE_FIELDS = [
  "sourceStartMs",
  "sourceEndMs",
  "targetStartMs",
  "targetEndMs"
] as const;

export type RealMediaGoldDigest = `sha256:${string}`;

export interface RealMediaGoldMediaBinding {
  contentIdentity: RealMediaBenchmarkContentIdentity;
  audioStreamIndex: number;
  videoStreamIndex: number | null;
}

export interface RealMediaGoldReviewVerification {
  recordVersion: 2;
  method: "manual-review";
  verificationId: string;
  issuerKeyId: string;
  issuerSequence: number;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
  requestDigest: RealMediaGoldDigest;
  reviewEvidenceDigest: RealMediaGoldDigest;
  verifier: string;
}

export interface RealMediaGoldAnnotationInput {
  caseId: string;
  source: RealMediaGoldMediaBinding;
  target: RealMediaGoldMediaBinding;
  boundaryToleranceMs: number;
  reviewerId: string;
  reviewVerification: RealMediaGoldReviewVerification;
  gold: RealMediaBenchmarkGold;
}

export interface RealMediaGoldAnnotationEnvelope {
  schemaVersion: typeof REAL_MEDIA_GOLD_ANNOTATION_SCHEMA_VERSION;
  kind: "real-media-gold-annotation";
  caseId: string;
  source: RealMediaGoldMediaBinding;
  target: RealMediaGoldMediaBinding;
  boundaryToleranceMs: number;
  reviewerId: string;
  reviewVerification: RealMediaGoldReviewVerification;
  gold: RealMediaBenchmarkGold;
  annotationDigest: RealMediaGoldDigest;
}

export type RealMediaGoldDisagreementReason = "missing" | "outside-tolerance";

export interface RealMediaGoldDisagreement {
  annotationDigests: readonly [RealMediaGoldDigest, RealMediaGoldDigest];
  reviewerIds: readonly [string, string];
  path: string;
  reason: RealMediaGoldDisagreementReason;
  firstMs: number | null;
  secondMs: number | null;
  deltaMs: number | null;
  toleranceMs: number;
}

export type RealMediaGoldBenchmarkCaseInput = Omit<
  RealMediaBenchmarkCase,
  "mediaKind" | "independentAnnotations" | "adjudication" | "gold"
>;

export interface RealMediaGoldConsensusResolution {
  kind: "consensus";
  selectedAnnotationDigest: RealMediaGoldDigest;
  note: string;
}

export interface RealMediaGoldAdjudicatedResolution {
  kind: "adjudicated";
  adjudicationAnnotation: RealMediaGoldAnnotationEnvelope;
  note: string;
}

export type RealMediaGoldFreezeResolution =
  RealMediaGoldConsensusResolution | RealMediaGoldAdjudicatedResolution;

export interface RealMediaGoldConsensusReceiptResolution {
  kind: "consensus";
  selectedAnnotationDigest: RealMediaGoldDigest;
  note: string;
}

export interface RealMediaGoldAdjudicatedReceiptResolution {
  kind: "adjudicated";
  adjudicatorId: string;
  adjudicationAnnotationDigest: RealMediaGoldDigest;
  resolvedGoldDigest: RealMediaGoldDigest;
  note: string;
}

export type RealMediaGoldFreezeReceiptResolution =
  RealMediaGoldConsensusReceiptResolution | RealMediaGoldAdjudicatedReceiptResolution;

export interface RealMediaGoldFreezeReceipt {
  schemaVersion: typeof REAL_MEDIA_GOLD_FREEZE_RECEIPT_SCHEMA_VERSION;
  kind: "real-media-gold-freeze-receipt";
  caseId: string;
  caseInputDigest: RealMediaGoldDigest;
  annotationDigests: readonly [RealMediaGoldDigest, RealMediaGoldDigest];
  resolution: RealMediaGoldFreezeReceiptResolution;
  finalGoldDigest: RealMediaGoldDigest;
  releaseEligible: false;
  assurance: typeof REAL_MEDIA_GOLD_FREEZE_ASSURANCE;
  receiptDigest: RealMediaGoldDigest;
}

export interface RealMediaGoldFreezeInput {
  caseInput: RealMediaGoldBenchmarkCaseInput;
  annotations: readonly RealMediaGoldAnnotationEnvelope[];
  resolution: RealMediaGoldFreezeResolution;
}

export interface RealMediaGoldFreezeResult {
  /** A fully derived case that can be inserted directly into a benchmark manifest. */
  manifestCase: RealMediaBenchmarkCase;
  receipt: RealMediaGoldFreezeReceipt;
}

type GoldSpan =
  | RealMediaBenchmarkSourceOnlySpan
  | RealMediaBenchmarkTargetOnlySpan
  | RealMediaBenchmarkAmbiguousSpan;

type GoldSpanKind = GoldSpan["kind"];

export function createRealMediaGoldAnnotationEnvelope(
  input: RealMediaGoldAnnotationInput
): RealMediaGoldAnnotationEnvelope {
  const core = parseAnnotationCore({
    schemaVersion: REAL_MEDIA_GOLD_ANNOTATION_SCHEMA_VERSION,
    kind: "real-media-gold-annotation",
    caseId: input.caseId.trim(),
    source: normalizeMediaBinding(input.source),
    target: normalizeMediaBinding(input.target),
    boundaryToleranceMs: input.boundaryToleranceMs,
    reviewerId: input.reviewerId.trim(),
    reviewVerification: input.reviewVerification,
    gold: normalizeGold(input.gold)
  });
  return {
    ...core,
    annotationDigest: digest(ANNOTATION_DIGEST_DOMAIN, core)
  };
}

export function parseRealMediaGoldAnnotationEnvelopeJson(
  json: string
): RealMediaGoldAnnotationEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error(`真实媒体 Gold 标注 JSON 无法解析：${formatError(error)}`);
  }
  return parseAnnotationEnvelope(value);
}

export function serializeRealMediaGoldAnnotationEnvelope(
  envelope: RealMediaGoldAnnotationEnvelope
): string {
  return `${canonicalJson(parseAnnotationEnvelope(envelope))}\n`;
}

export function createRealMediaGoldDigest(gold: RealMediaBenchmarkGold): RealMediaGoldDigest {
  return digest(GOLD_DIGEST_DOMAIN, parseGold(gold, "gold"));
}

/**
 * Compares every unordered annotation pair. Input order does not affect the returned list, and
 * annotations beyond index 1 are never ignored.
 */
export function collectRealMediaGoldDisagreements(
  values: readonly RealMediaGoldAnnotationEnvelope[]
): RealMediaGoldDisagreement[] {
  const annotations = values.map(parseAnnotationEnvelope).sort(compareAnnotation);
  assertComparableAnnotations(annotations);
  const disagreements: RealMediaGoldDisagreement[] = [];
  for (let firstIndex = 0; firstIndex < annotations.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < annotations.length; secondIndex += 1) {
      const first = annotations[firstIndex];
      const second = annotations[secondIndex];
      if (first === undefined || second === undefined) continue;
      compareGoldPair(first, second, disagreements);
    }
  }
  return disagreements.sort(compareDisagreement);
}

/**
 * Freezes exactly two independent annotations into a benchmark case. The caller never supplies
 * the final Gold: consensus selects one immutable annotation, while adjudication supplies the
 * third reviewer's resolved Gold.
 */
export function freezeRealMediaGoldCase(
  input: RealMediaGoldFreezeInput
): RealMediaGoldFreezeResult {
  if (input.annotations.length !== 2) {
    throw new Error("Gold 冻结要求恰好两份独立标注；额外或缺失标注必须先在治理流程中处理。");
  }
  const annotations = input.annotations.map(parseAnnotationEnvelope).sort(compareAnnotation);
  const first = annotations[0];
  const second = annotations[1];
  if (first === undefined || second === undefined) {
    throw new Error("Gold 冻结缺少两份独立标注。");
  }
  if (first.reviewerId === second.reviewerId) {
    throw new Error("Gold 冻结的两份标注必须来自不同 reviewer。");
  }
  assertDistinctAnnotationReviewSources(annotations);
  assertComparableAnnotations(annotations);
  const caseInput = normalizeCaseInput(input.caseInput);
  assertAnnotationsMatchCaseInput(annotations, caseInput);
  const disagreements = collectRealMediaGoldDisagreements(annotations);
  const note = requireNonemptyTrimmedString(input.resolution.note, "Gold 冻结 resolution.note");

  let finalGold: RealMediaBenchmarkGold;
  let receiptResolution: RealMediaGoldFreezeReceiptResolution;
  let adjudicationAnnotation: RealMediaGoldAnnotationEnvelope | null = null;
  if (input.resolution.kind === "consensus") {
    if (disagreements.length > 0) {
      throw new Error(
        "两份标注存在超出容差或结构分歧，不能以 consensus 冻结；必须第三人仲裁。"
      );
    }
    const selectedAnnotationDigest = input.resolution.selectedAnnotationDigest;
    const selected = annotations.find(
      (annotation) => annotation.annotationDigest === selectedAnnotationDigest
    );
    if (selected === undefined) {
      throw new Error("consensus 必须显式选择两份独立标注之一作为最终 Gold。");
    }
    finalGold = cloneGold(selected.gold);
    receiptResolution = {
      kind: "consensus",
      selectedAnnotationDigest: selected.annotationDigest,
      note
    };
  } else if (input.resolution.kind === "adjudicated") {
    if (disagreements.length === 0) {
      throw new Error("两份标注均在容差内，必须显式选择 consensus Gold，不能改走仲裁。");
    }
    adjudicationAnnotation = parseAnnotationEnvelope(input.resolution.adjudicationAnnotation);
    assertComparableAnnotations([...annotations, adjudicationAnnotation]);
    const adjudicatorId = adjudicationAnnotation.reviewerId;
    if (annotations.some((annotation) => annotation.reviewerId === adjudicatorId)) {
      throw new Error("Gold 仲裁者必须独立于两名原始 reviewer。");
    }
    assertDistinctAnnotationReviewSources([...annotations, adjudicationAnnotation]);
    finalGold = cloneGold(adjudicationAnnotation.gold);
    receiptResolution = {
      kind: "adjudicated",
      adjudicatorId,
      adjudicationAnnotationDigest: adjudicationAnnotation.annotationDigest,
      resolvedGoldDigest: createRealMediaGoldDigest(finalGold),
      note
    };
  } else {
    throw new Error("Gold 冻结 resolution.kind 无效。");
  }

  const manifestCase = createDerivedManifestCase(
    caseInput,
    annotations,
    receiptResolution,
    finalGold
  );
  assertDerivedManifestCaseValid(manifestCase);
  const receiptCore = {
    schemaVersion: REAL_MEDIA_GOLD_FREEZE_RECEIPT_SCHEMA_VERSION,
    kind: "real-media-gold-freeze-receipt" as const,
    caseId: manifestCase.id,
    caseInputDigest: createCaseInputDigest(caseInput),
    annotationDigests: [first.annotationDigest, second.annotationDigest] as const,
    resolution: receiptResolution,
    finalGoldDigest: createRealMediaGoldDigest(finalGold),
    releaseEligible: false as const,
    assurance: REAL_MEDIA_GOLD_FREEZE_ASSURANCE
  };
  const receipt: RealMediaGoldFreezeReceipt = {
    ...receiptCore,
    receiptDigest: digest(FREEZE_RECEIPT_DIGEST_DOMAIN, receiptCore)
  };
  assertRealMediaGoldFreezeReceiptMatchesCase(
    receipt,
    annotations,
    manifestCase,
    adjudicationAnnotation
  );
  return { manifestCase, receipt };
}

export function parseRealMediaGoldFreezeReceiptJson(json: string): RealMediaGoldFreezeReceipt {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error(`真实媒体 Gold 冻结 receipt JSON 无法解析：${formatError(error)}`);
  }
  return parseFreezeReceipt(value);
}

export function serializeRealMediaGoldFreezeReceipt(
  receipt: RealMediaGoldFreezeReceipt
): string {
  return `${canonicalJson(parseFreezeReceipt(receipt))}\n`;
}

export function assertRealMediaGoldFreezeReceiptMatchesCase(
  receiptValue: RealMediaGoldFreezeReceipt,
  annotationValues: readonly RealMediaGoldAnnotationEnvelope[],
  manifestCase: RealMediaBenchmarkCase,
  adjudicationValue: RealMediaGoldAnnotationEnvelope | null = null
): void {
  const receipt = parseFreezeReceipt(receiptValue);
  if (annotationValues.length !== 2) {
    throw new Error("冻结 receipt 核验要求恰好两份标注。");
  }
  const annotations = annotationValues.map(parseAnnotationEnvelope).sort(compareAnnotation);
  const first = annotations[0];
  const second = annotations[1];
  if (first === undefined || second === undefined) {
    throw new Error("冻结 receipt 核验缺少标注。");
  }
  assertDistinctAnnotationReviewSources(annotations);
  if (
    receipt.annotationDigests[0] !== first.annotationDigest ||
    receipt.annotationDigests[1] !== second.annotationDigest
  ) {
    throw new Error("冻结 receipt 绑定的 annotation digest 与当前标注不一致。");
  }
  if (manifestCase.mediaKind !== "real" || receipt.caseId !== manifestCase.id) {
    throw new Error("冻结 receipt 与 benchmark case 身份不一致。");
  }
  const caseInput = normalizeCaseInput(extractCaseInput(manifestCase));
  assertAnnotationsMatchCaseInput(annotations, caseInput);
  if (receipt.caseInputDigest !== createCaseInputDigest(caseInput)) {
    throw new Error("冻结 receipt 与 benchmark case input 不一致。");
  }
  if (receipt.finalGoldDigest !== createRealMediaGoldDigest(manifestCase.gold)) {
    throw new Error("冻结 receipt 与 benchmark case 最终 Gold 不一致。");
  }
  const expectedAnnotations = annotations.map((annotation) => ({
    reviewerId: annotation.reviewerId,
    gold: annotation.gold
  }));
  if (!canonicalEqual(expectedAnnotations, manifestCase.independentAnnotations)) {
    throw new Error("benchmark case 的独立标注未由冻结 envelope 派生。");
  }
  if (receipt.resolution.kind === "consensus") {
    if (adjudicationValue !== null) {
      throw new Error("consensus 冻结不能附带第三人仲裁标注。");
    }
    const selectedAnnotationDigest = receipt.resolution.selectedAnnotationDigest;
    const selected = annotations.find(
      (annotation) => annotation.annotationDigest === selectedAnnotationDigest
    );
    if (
      selected === undefined ||
      createRealMediaGoldDigest(selected.gold) !== receipt.finalGoldDigest ||
      manifestCase.adjudication?.status !== "not-needed" ||
      manifestCase.adjudication.adjudicatorId !== null ||
      manifestCase.adjudication.note !== receipt.resolution.note
    ) {
      throw new Error("benchmark case 的 consensus Gold 或治理记录与 receipt 不一致。");
    }
  } else {
    if (adjudicationValue === null) {
      throw new Error("adjudicated 冻结必须提供 receipt 所绑定的第三人仲裁标注。");
    }
    const adjudication = parseAnnotationEnvelope(adjudicationValue);
    assertComparableAnnotations([...annotations, adjudication]);
    assertDistinctAnnotationReviewSources([...annotations, adjudication]);
    if (
      receipt.resolution.adjudicationAnnotationDigest !== adjudication.annotationDigest ||
      receipt.resolution.adjudicatorId !== adjudication.reviewerId ||
      receipt.resolution.resolvedGoldDigest !== createRealMediaGoldDigest(adjudication.gold) ||
      receipt.resolution.resolvedGoldDigest !== receipt.finalGoldDigest ||
      manifestCase.adjudication?.status !== "resolved" ||
      manifestCase.adjudication.adjudicatorId !== receipt.resolution.adjudicatorId ||
      manifestCase.adjudication.note !== receipt.resolution.note
    ) {
      throw new Error("benchmark case 的 adjudicated Gold 或治理记录与 receipt 不一致。");
    }
  }
  assertDerivedManifestCaseValid(manifestCase);
}

function parseAnnotationEnvelope(value: unknown): RealMediaGoldAnnotationEnvelope {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "caseId",
      "source",
      "target",
      "boundaryToleranceMs",
      "reviewerId",
      "reviewVerification",
      "gold",
      "annotationDigest"
    ],
    "Gold annotation envelope"
  );
  const core = parseAnnotationCore({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    caseId: record.caseId,
    source: record.source,
    target: record.target,
    boundaryToleranceMs: record.boundaryToleranceMs,
    reviewerId: record.reviewerId,
    reviewVerification: record.reviewVerification,
    gold: record.gold
  });
  const annotationDigest = requireDigest(record.annotationDigest, "Gold annotationDigest");
  const expectedDigest = digest(ANNOTATION_DIGEST_DOMAIN, core);
  if (annotationDigest !== expectedDigest) {
    throw new Error("Gold annotationDigest 与标注内容不一致，标注可能已被篡改。");
  }
  return { ...core, annotationDigest };
}

function parseAnnotationCore(
  value: unknown
): Omit<RealMediaGoldAnnotationEnvelope, "annotationDigest"> {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "caseId",
      "source",
      "target",
      "boundaryToleranceMs",
      "reviewerId",
      "reviewVerification",
      "gold"
    ],
    "Gold annotation content"
  );
  if (
    record.schemaVersion !== REAL_MEDIA_GOLD_ANNOTATION_SCHEMA_VERSION ||
    record.kind !== "real-media-gold-annotation"
  ) {
    throw new Error("Gold annotation schemaVersion 或 kind 无效。");
  }
  const boundaryToleranceMs = requireSafeInteger(
    record.boundaryToleranceMs,
    "Gold boundaryToleranceMs"
  );
  if (boundaryToleranceMs < 40 || boundaryToleranceMs > 100) {
    throw new Error("Gold boundaryToleranceMs 必须位于 40–100ms。");
  }
  const reviewerId = requireNonemptyTrimmedString(record.reviewerId, "Gold reviewerId");
  const reviewVerification = parseReviewVerification(
    record.reviewVerification,
    "Gold reviewVerification"
  );
  if (reviewVerification.verifier !== reviewerId) {
    throw new Error("Gold reviewerId 必须与签名人工复核凭据中的 verifier 一致。");
  }
  return {
    schemaVersion: REAL_MEDIA_GOLD_ANNOTATION_SCHEMA_VERSION,
    kind: "real-media-gold-annotation",
    caseId: requireNonemptyTrimmedString(record.caseId, "Gold caseId"),
    source: parseMediaBinding(record.source, "Gold source"),
    target: parseMediaBinding(record.target, "Gold target"),
    boundaryToleranceMs,
    reviewerId,
    reviewVerification,
    gold: parseGold(record.gold, "Gold annotation.gold")
  };
}

function parseReviewVerification(
  value: unknown,
  label: string
): RealMediaGoldReviewVerification {
  const record = requireExactRecord(
    value,
    [
      "recordVersion",
      "method",
      "verificationId",
      "issuerKeyId",
      "issuerSequence",
      "signatureAlgorithm",
      "signature",
      "requestDigest",
      "reviewEvidenceDigest",
      "verifier"
    ],
    label
  );
  if (record.recordVersion !== 2 || record.method !== "manual-review") {
    throw new Error(`${label} 必须绑定 recordVersion=2 的 manual-review 凭据。`);
  }
  if (record.signatureAlgorithm !== "hmac-sha256-v1") {
    throw new Error(`${label}.signatureAlgorithm 必须为 hmac-sha256-v1。`);
  }
  const issuerSequence = requireSafeInteger(record.issuerSequence, `${label}.issuerSequence`);
  if (issuerSequence < 1) {
    throw new Error(`${label}.issuerSequence 必须是正安全整数。`);
  }
  return {
    recordVersion: 2,
    method: "manual-review",
    verificationId: requireNonemptyTrimmedString(
      record.verificationId,
      `${label}.verificationId`
    ),
    issuerKeyId: requireNonemptyTrimmedString(record.issuerKeyId, `${label}.issuerKeyId`),
    issuerSequence,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: requireSha256Hex(record.signature, `${label}.signature`),
    requestDigest: requireDigest(record.requestDigest, `${label}.requestDigest`),
    reviewEvidenceDigest: requireDigest(
      record.reviewEvidenceDigest,
      `${label}.reviewEvidenceDigest`
    ),
    verifier: requireNonemptyTrimmedString(record.verifier, `${label}.verifier`)
  };
}

function normalizeMediaBinding(value: RealMediaGoldMediaBinding): RealMediaGoldMediaBinding {
  return {
    contentIdentity: {
      algorithm: value.contentIdentity.algorithm,
      sizeBytes: value.contentIdentity.sizeBytes,
      digest: value.contentIdentity.digest.toLowerCase()
    },
    audioStreamIndex: value.audioStreamIndex,
    videoStreamIndex: value.videoStreamIndex
  };
}

function parseMediaBinding(value: unknown, label: string): RealMediaGoldMediaBinding {
  const record = requireExactRecord(
    value,
    ["contentIdentity", "audioStreamIndex", "videoStreamIndex"],
    label
  );
  return {
    contentIdentity: parseContentIdentity(record.contentIdentity, `${label}.contentIdentity`),
    audioStreamIndex: requireNonnegativeSafeInteger(
      record.audioStreamIndex,
      `${label}.audioStreamIndex`
    ),
    videoStreamIndex:
      record.videoStreamIndex === null
        ? null
        : requireNonnegativeSafeInteger(record.videoStreamIndex, `${label}.videoStreamIndex`)
  };
}

function parseContentIdentity(
  value: unknown,
  label: string
): RealMediaBenchmarkContentIdentity {
  const record = requireExactRecord(value, ["algorithm", "sizeBytes", "digest"], label);
  if (record.algorithm !== "sha256-full-file-v2") {
    throw new Error(`${label}.algorithm 必须为 sha256-full-file-v2。`);
  }
  const sizeBytes = requireSafeInteger(record.sizeBytes, `${label}.sizeBytes`);
  if (sizeBytes <= 0) throw new Error(`${label}.sizeBytes 必须为正安全整数。`);
  if (typeof record.digest !== "string" || !SHA256.test(record.digest)) {
    throw new Error(`${label}.digest 必须为规范的小写全文件 SHA-256。`);
  }
  return { algorithm: "sha256-full-file-v2", sizeBytes, digest: record.digest };
}

function parseGold(value: unknown, label: string): RealMediaBenchmarkGold {
  const record = requireExactRecord(
    value,
    [
      "sourceStartMs",
      "sourceEndMs",
      "targetStartMs",
      "targetEndMs",
      "matchedAnchors",
      "sourceOnlySpans",
      "targetOnlySpans",
      "ambiguousSpans"
    ],
    label
  );
  const sourceStartMs = requireNonnegativeSafeInteger(
    record.sourceStartMs,
    `${label}.sourceStartMs`
  );
  const sourceEndMs = requireNonnegativeSafeInteger(record.sourceEndMs, `${label}.sourceEndMs`);
  const targetStartMs = requireNonnegativeSafeInteger(
    record.targetStartMs,
    `${label}.targetStartMs`
  );
  const targetEndMs = requireNonnegativeSafeInteger(record.targetEndMs, `${label}.targetEndMs`);
  if (sourceEndMs <= sourceStartMs || targetEndMs <= targetStartMs) {
    throw new Error(`${label} 的来源和目标总范围必须为正长度。`);
  }
  const matchedAnchors = requireArray(record.matchedAnchors, `${label}.matchedAnchors`).map(
    (anchor, index) => parseAnchor(anchor, `${label}.matchedAnchors[${index}]`)
  );
  if (matchedAnchors.length === 0) {
    throw new Error(`${label}.matchedAnchors 至少需要一个 anchor。`);
  }
  const sourceOnlySpans = requireArray(record.sourceOnlySpans, `${label}.sourceOnlySpans`).map(
    (span, index) => parseSourceOnlySpan(span, `${label}.sourceOnlySpans[${index}]`)
  );
  const targetOnlySpans = requireArray(record.targetOnlySpans, `${label}.targetOnlySpans`).map(
    (span, index) => parseTargetOnlySpan(span, `${label}.targetOnlySpans[${index}]`)
  );
  const ambiguousSpans = requireArray(record.ambiguousSpans, `${label}.ambiguousSpans`).map(
    (span, index) => parseAmbiguousSpan(span, `${label}.ambiguousSpans[${index}]`)
  );
  const gold = normalizeGold({
    sourceStartMs,
    sourceEndMs,
    targetStartMs,
    targetEndMs,
    matchedAnchors,
    sourceOnlySpans,
    targetOnlySpans,
    ambiguousSpans
  });
  validateGoldSemantics(gold, label);
  return gold;
}

function normalizeGold(gold: RealMediaBenchmarkGold): RealMediaBenchmarkGold {
  return {
    sourceStartMs: gold.sourceStartMs,
    sourceEndMs: gold.sourceEndMs,
    targetStartMs: gold.targetStartMs,
    targetEndMs: gold.targetEndMs,
    matchedAnchors: gold.matchedAnchors.map((anchor) => ({ ...anchor })).sort(compareAnchor),
    sourceOnlySpans: gold.sourceOnlySpans.map((span) => ({ ...span })).sort(compareSpan),
    targetOnlySpans: gold.targetOnlySpans.map((span) => ({ ...span })).sort(compareSpan),
    ambiguousSpans: gold.ambiguousSpans.map((span) => ({ ...span })).sort(compareSpan)
  };
}

function parseAnchor(value: unknown, label: string): RealMediaBenchmarkAnchor {
  const record = requireExactRecord(value, ["id", "sourceMs", "targetMs"], label);
  return {
    id: requireNonemptyTrimmedString(record.id, `${label}.id`),
    sourceMs: requireNonnegativeSafeInteger(record.sourceMs, `${label}.sourceMs`),
    targetMs: requireNonnegativeSafeInteger(record.targetMs, `${label}.targetMs`)
  };
}

function parseSourceOnlySpan(value: unknown, label: string): RealMediaBenchmarkSourceOnlySpan {
  const span = parseSpanCoordinates(value, "sourceOnly", label);
  return { kind: "sourceOnly", ...span };
}

function parseTargetOnlySpan(value: unknown, label: string): RealMediaBenchmarkTargetOnlySpan {
  const span = parseSpanCoordinates(value, "targetOnly", label);
  return { kind: "targetOnly", ...span };
}

function parseAmbiguousSpan(value: unknown, label: string): RealMediaBenchmarkAmbiguousSpan {
  const span = parseSpanCoordinates(value, "ambiguous", label);
  return { kind: "ambiguous", ...span };
}

function parseSpanCoordinates(
  value: unknown,
  expectedKind: GoldSpanKind,
  label: string
): Omit<GoldSpan, "kind"> {
  const record = requireExactRecord(
    value,
    ["kind", "sourceStartMs", "sourceEndMs", "targetStartMs", "targetEndMs"],
    label
  );
  if (record.kind !== expectedKind) throw new Error(`${label}.kind 必须为 ${expectedKind}。`);
  const coordinates = {
    sourceStartMs: requireNonnegativeSafeInteger(
      record.sourceStartMs,
      `${label}.sourceStartMs`
    ),
    sourceEndMs: requireNonnegativeSafeInteger(record.sourceEndMs, `${label}.sourceEndMs`),
    targetStartMs: requireNonnegativeSafeInteger(
      record.targetStartMs,
      `${label}.targetStartMs`
    ),
    targetEndMs: requireNonnegativeSafeInteger(record.targetEndMs, `${label}.targetEndMs`)
  };
  const sourceDuration = coordinates.sourceEndMs - coordinates.sourceStartMs;
  const targetDuration = coordinates.targetEndMs - coordinates.targetStartMs;
  const validShape =
    (expectedKind === "sourceOnly" && sourceDuration > 0 && targetDuration === 0) ||
    (expectedKind === "targetOnly" && sourceDuration === 0 && targetDuration > 0) ||
    (expectedKind === "ambiguous" &&
      sourceDuration >= 0 &&
      targetDuration >= 0 &&
      sourceDuration + targetDuration > 0);
  if (!validShape) throw new Error(`${label} 的 ${expectedKind} 边界形状无效。`);
  return coordinates;
}

function validateGoldSemantics(gold: RealMediaBenchmarkGold, label: string): void {
  const ids = new Set<string>();
  for (const anchor of gold.matchedAnchors) {
    if (ids.has(anchor.id)) throw new Error(`${label} 的 anchor id ${anchor.id} 重复。`);
    ids.add(anchor.id);
    if (
      anchor.sourceMs < gold.sourceStartMs ||
      anchor.sourceMs >= gold.sourceEndMs ||
      anchor.targetMs < gold.targetStartMs ||
      anchor.targetMs >= gold.targetEndMs
    ) {
      throw new Error(`${label} 的 anchor ${anchor.id} 超出总范围。`);
    }
  }
  const timelineAnchors = [...gold.matchedAnchors].sort(
    (left, right) => left.sourceMs - right.sourceMs || left.targetMs - right.targetMs
  );
  for (let index = 1; index < timelineAnchors.length; index += 1) {
    const previous = timelineAnchors[index - 1];
    const current = timelineAnchors[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (current.sourceMs <= previous.sourceMs || current.targetMs <= previous.targetMs)
    ) {
      throw new Error(`${label} 的 matched anchors 必须在两条时间轴上严格单调。`);
    }
  }
  const spans: GoldSpan[] = [
    ...gold.sourceOnlySpans,
    ...gold.targetOnlySpans,
    ...gold.ambiguousSpans
  ];
  const spanKeys = new Set<string>();
  for (const span of spans) {
    if (
      span.sourceStartMs < gold.sourceStartMs ||
      span.sourceEndMs > gold.sourceEndMs ||
      span.targetStartMs < gold.targetStartMs ||
      span.targetEndMs > gold.targetEndMs
    ) {
      throw new Error(`${label} 的 ${span.kind} span 超出总范围。`);
    }
    const key = canonicalJson(span);
    if (spanKeys.has(key)) throw new Error(`${label} 包含重复的 ${span.kind} span。`);
    spanKeys.add(key);
  }
  const partition = createGoldTimeMapPartition(gold, spans, label);
  for (const anchor of gold.matchedAnchors) {
    const supportedByMatchedRegion = partition.some(
      (span) =>
        span.kind === "matched" &&
        anchor.sourceMs >= span.sourceStartMs &&
        anchor.sourceMs < span.sourceEndMs &&
        anchor.targetMs >= span.targetStartMs &&
        anchor.targetMs < span.targetEndMs
    );
    if (!supportedByMatchedRegion) {
      throw new Error(
        `${label} 的 matched anchor ${anchor.id} 与 edit span 或其跨轴映射分区冲突。`
      );
    }
  }
}

function createGoldTimeMapPartition(
  gold: RealMediaBenchmarkGold,
  spans: readonly GoldSpan[],
  label: string
): TimeMapSpan[] {
  const edits = [...spans].sort(compareSpan);
  const partition: TimeMapSpan[] = [];
  let sourceCursorMs = gold.sourceStartMs;
  let targetCursorMs = gold.targetStartMs;

  const appendMatchedGap = (sourceEndMs: number, targetEndMs: number): void => {
    const sourceDurationMs = sourceEndMs - sourceCursorMs;
    const targetDurationMs = targetEndMs - targetCursorMs;
    if (sourceDurationMs === 0 && targetDurationMs === 0) return;
    if (sourceDurationMs <= 0 || targetDurationMs <= 0) {
      throw new Error(
        `${label} 的 edit spans 无法形成连续 TimeMap；两轴间存在未标注的单轴空档。`
      );
    }
    partition.push({
      kind: "matched",
      sourceStartMs: sourceCursorMs,
      sourceEndMs,
      targetStartMs: targetCursorMs,
      targetEndMs
    });
  };

  for (const edit of edits) {
    if (edit.sourceStartMs < sourceCursorMs || edit.targetStartMs < targetCursorMs) {
      throw new Error(
        `${label} 的 edit spans 在来源轴或目标轴重叠、交叉，或存在 cross-kind 冲突。`
      );
    }
    appendMatchedGap(edit.sourceStartMs, edit.targetStartMs);
    partition.push({ ...edit });
    sourceCursorMs = edit.sourceEndMs;
    targetCursorMs = edit.targetEndMs;
  }
  appendMatchedGap(gold.sourceEndMs, gold.targetEndMs);

  const validation = validateTimeMap(partition);
  if (!validation.valid) {
    throw new Error(
      `${label} 的 edit spans 无法形成连续单调 TimeMap：${validation.issues
        .map((issue) => issue.message)
        .join("；")}`
    );
  }
  return partition;
}

function assertComparableAnnotations(
  annotations: readonly RealMediaGoldAnnotationEnvelope[]
): void {
  const first = annotations[0];
  if (first === undefined) return;
  for (const annotation of annotations.slice(1)) {
    if (
      annotation.caseId !== first.caseId ||
      annotation.boundaryToleranceMs !== first.boundaryToleranceMs ||
      !canonicalEqual(annotation.source, first.source) ||
      !canonicalEqual(annotation.target, first.target)
    ) {
      throw new Error("独立标注必须绑定同一 case、双端全文件身份、显式流和边界容差。");
    }
  }
}

function assertDistinctAnnotationReviewSources(
  annotations: readonly RealMediaGoldAnnotationEnvelope[]
): void {
  const reviewerIds = new Set(annotations.map((annotation) => annotation.reviewerId));
  if (reviewerIds.size !== annotations.length) {
    throw new Error("Gold 冻结的每份标注必须来自不同 reviewer。");
  }
  const verificationIds = new Set(
    annotations.map((annotation) => annotation.reviewVerification.verificationId)
  );
  if (verificationIds.size !== annotations.length) {
    throw new Error(
      "Gold 冻结的每份标注必须绑定不同 verificationId，不能复用同一 signed map。"
    );
  }
  const reviewEvidenceDigests = new Set(
    annotations.map((annotation) => annotation.reviewVerification.reviewEvidenceDigest)
  );
  if (reviewEvidenceDigests.size !== annotations.length) {
    throw new Error(
      "Gold 冻结的每份标注必须绑定不同 reviewEvidenceDigest，不能复用同一人工复核证据。"
    );
  }
}

function compareGoldPair(
  first: RealMediaGoldAnnotationEnvelope,
  second: RealMediaGoldAnnotationEnvelope,
  output: RealMediaGoldDisagreement[]
): void {
  for (const field of TOTAL_RANGE_FIELDS) {
    appendBoundaryDisagreement(
      first,
      second,
      `gold.${field}`,
      first.gold[field],
      second.gold[field],
      output
    );
  }
  appendBoundaryDisagreement(
    first,
    second,
    "gold.startMappingOffsetMs",
    first.gold.targetStartMs - first.gold.sourceStartMs,
    second.gold.targetStartMs - second.gold.sourceStartMs,
    output
  );
  appendBoundaryDisagreement(
    first,
    second,
    "gold.endMappingOffsetMs",
    first.gold.targetEndMs - first.gold.sourceEndMs,
    second.gold.targetEndMs - second.gold.sourceEndMs,
    output
  );
  const firstAnchors = new Map(first.gold.matchedAnchors.map((anchor) => [anchor.id, anchor]));
  const secondAnchors = new Map(
    second.gold.matchedAnchors.map((anchor) => [anchor.id, anchor])
  );
  const anchorIds = [...new Set([...firstAnchors.keys(), ...secondAnchors.keys()])].sort(
    compareAscii
  );
  for (const anchorId of anchorIds) {
    const firstAnchor = firstAnchors.get(anchorId);
    const secondAnchor = secondAnchors.get(anchorId);
    appendBoundaryDisagreement(
      first,
      second,
      `gold.matchedAnchors[${JSON.stringify(anchorId)}].sourceMs`,
      firstAnchor?.sourceMs ?? null,
      secondAnchor?.sourceMs ?? null,
      output
    );
    appendBoundaryDisagreement(
      first,
      second,
      `gold.matchedAnchors[${JSON.stringify(anchorId)}].targetMs`,
      firstAnchor?.targetMs ?? null,
      secondAnchor?.targetMs ?? null,
      output
    );
    appendBoundaryDisagreement(
      first,
      second,
      `gold.matchedAnchors[${JSON.stringify(anchorId)}].mappingOffsetMs`,
      firstAnchor === undefined ? null : firstAnchor.targetMs - firstAnchor.sourceMs,
      secondAnchor === undefined ? null : secondAnchor.targetMs - secondAnchor.sourceMs,
      output
    );
  }
  compareSpanArrays(
    first,
    second,
    "sourceOnly",
    first.gold.sourceOnlySpans,
    second.gold.sourceOnlySpans,
    output
  );
  compareSpanArrays(
    first,
    second,
    "targetOnly",
    first.gold.targetOnlySpans,
    second.gold.targetOnlySpans,
    output
  );
  compareSpanArrays(
    first,
    second,
    "ambiguous",
    first.gold.ambiguousSpans,
    second.gold.ambiguousSpans,
    output
  );
}

function compareSpanArrays(
  first: RealMediaGoldAnnotationEnvelope,
  second: RealMediaGoldAnnotationEnvelope,
  kind: GoldSpanKind,
  firstSpans: readonly GoldSpan[],
  secondSpans: readonly GoldSpan[],
  output: RealMediaGoldDisagreement[]
): void {
  const count = Math.max(firstSpans.length, secondSpans.length);
  for (let index = 0; index < count; index += 1) {
    const firstSpan = firstSpans[index];
    const secondSpan = secondSpans[index];
    for (const field of SPAN_BOUNDARY_FIELDS) {
      appendBoundaryDisagreement(
        first,
        second,
        `gold.${kind}Spans[${index}].${field}`,
        firstSpan?.[field] ?? null,
        secondSpan?.[field] ?? null,
        output
      );
    }
  }
}

function appendBoundaryDisagreement(
  first: RealMediaGoldAnnotationEnvelope,
  second: RealMediaGoldAnnotationEnvelope,
  path: string,
  firstMs: number | null,
  secondMs: number | null,
  output: RealMediaGoldDisagreement[]
): void {
  const missing = firstMs === null || secondMs === null;
  const deltaMs = missing ? null : Math.abs(firstMs - secondMs);
  if (!missing && deltaMs !== null && deltaMs <= first.boundaryToleranceMs) return;
  output.push({
    annotationDigests: [first.annotationDigest, second.annotationDigest],
    reviewerIds: [first.reviewerId, second.reviewerId],
    path,
    reason: missing ? "missing" : "outside-tolerance",
    firstMs,
    secondMs,
    deltaMs,
    toleranceMs: first.boundaryToleranceMs
  });
}

function normalizeCaseInput(
  input: RealMediaGoldBenchmarkCaseInput
): RealMediaGoldBenchmarkCaseInput {
  const source = normalizeCaseMediaInput(input.source, "Gold caseInput.source");
  const target = normalizeCaseMediaInput(input.target, "Gold caseInput.target");
  const normalized: RealMediaGoldBenchmarkCaseInput = {
    id: requireNonemptyTrimmedString(input.id, "Gold caseInput.id"),
    title: requireNonemptyTrimmedString(input.title, "Gold caseInput.title"),
    split: input.split,
    scenarios: [...input.scenarios],
    source,
    target,
    boundaryToleranceMs: input.boundaryToleranceMs,
    versionNotes: [...input.versionNotes],
    licenseNotes: [...input.licenseNotes]
  };
  if (normalized.split !== "development" && normalized.split !== "frozen-test") {
    throw new Error("Gold caseInput.split 必须为 development 或 frozen-test。");
  }
  if (
    !Number.isSafeInteger(normalized.boundaryToleranceMs) ||
    normalized.boundaryToleranceMs < 40 ||
    normalized.boundaryToleranceMs > 100
  ) {
    throw new Error("Gold caseInput.boundaryToleranceMs 必须位于 40–100ms。");
  }
  return normalized;
}

function normalizeCaseMediaInput(
  value: RealMediaBenchmarkMediaInput,
  label: string
): RealMediaBenchmarkMediaInput {
  if (value.contentIdentity === null) throw new Error(`${label} 必须绑定全文件 SHA-256。`);
  const binding = parseMediaBinding(
    normalizeMediaBinding({
      contentIdentity: value.contentIdentity,
      audioStreamIndex: value.audioStreamIndex,
      videoStreamIndex: value.videoStreamIndex
    }),
    label
  );
  return {
    path: requireNonemptyTrimmedString(value.path, `${label}.path`),
    ...binding,
    versionNote: requireNonemptyTrimmedString(value.versionNote, `${label}.versionNote`),
    licenseNote: requireNonemptyTrimmedString(value.licenseNote, `${label}.licenseNote`)
  };
}

function assertAnnotationsMatchCaseInput(
  annotations: readonly RealMediaGoldAnnotationEnvelope[],
  caseInput: RealMediaGoldBenchmarkCaseInput
): void {
  const source = bindingFromMediaInput(caseInput.source);
  const target = bindingFromMediaInput(caseInput.target);
  for (const annotation of annotations) {
    if (
      annotation.caseId !== caseInput.id ||
      annotation.boundaryToleranceMs !== caseInput.boundaryToleranceMs ||
      !canonicalEqual(annotation.source, source) ||
      !canonicalEqual(annotation.target, target)
    ) {
      throw new Error("独立标注未精确绑定 benchmark case 的 ID、双端身份、显式流或容差。");
    }
  }
}

function bindingFromMediaInput(value: RealMediaBenchmarkMediaInput): RealMediaGoldMediaBinding {
  if (value.contentIdentity === null) throw new Error("真实媒体 case 缺少全文件身份。");
  return {
    contentIdentity: { ...value.contentIdentity },
    audioStreamIndex: value.audioStreamIndex,
    videoStreamIndex: value.videoStreamIndex
  };
}

function createDerivedManifestCase(
  input: RealMediaGoldBenchmarkCaseInput,
  annotations: readonly RealMediaGoldAnnotationEnvelope[],
  resolution: RealMediaGoldFreezeReceiptResolution,
  finalGold: RealMediaBenchmarkGold
): RealMediaBenchmarkCase {
  return {
    ...input,
    scenarios: [...input.scenarios],
    source: cloneMediaInput(input.source),
    target: cloneMediaInput(input.target),
    versionNotes: [...input.versionNotes],
    licenseNotes: [...input.licenseNotes],
    mediaKind: "real",
    independentAnnotations: annotations.map((annotation) => ({
      reviewerId: annotation.reviewerId,
      gold: cloneGold(annotation.gold)
    })),
    adjudication:
      resolution.kind === "consensus"
        ? { status: "not-needed", adjudicatorId: null, note: resolution.note }
        : {
            status: "resolved",
            adjudicatorId: resolution.adjudicatorId,
            note: resolution.note
          },
    gold: cloneGold(finalGold)
  };
}

function assertDerivedManifestCaseValid(manifestCase: RealMediaBenchmarkCase): void {
  const manifest: RealMediaBenchmarkManifest = {
    schemaVersion: REAL_MEDIA_BENCHMARK_SCHEMA_VERSION,
    id: `gold-governance-${manifestCase.id}`,
    name: "Gold governance validation",
    datasetVersion: "gold-governance-v1",
    description: "Derived validation envelope for a governed real-media case.",
    isExample: false,
    licenseNotes: [...manifestCase.licenseNotes],
    cases: [manifestCase]
  };
  const validation = validateRealMediaBenchmarkManifest(manifest);
  if (!validation.valid) {
    throw new Error(`由 Gold 证据派生的 benchmark case 无效：${validation.issues.join("；")}`);
  }
}

function createCaseInputDigest(input: RealMediaGoldBenchmarkCaseInput): RealMediaGoldDigest {
  return digest(CASE_INPUT_DIGEST_DOMAIN, input);
}

function extractCaseInput(
  manifestCase: RealMediaBenchmarkCase
): RealMediaGoldBenchmarkCaseInput {
  return {
    id: manifestCase.id,
    title: manifestCase.title,
    split: manifestCase.split,
    scenarios: [...manifestCase.scenarios],
    source: cloneMediaInput(manifestCase.source),
    target: cloneMediaInput(manifestCase.target),
    boundaryToleranceMs: manifestCase.boundaryToleranceMs,
    versionNotes: [...manifestCase.versionNotes],
    licenseNotes: [...manifestCase.licenseNotes]
  };
}

function parseFreezeReceipt(value: unknown): RealMediaGoldFreezeReceipt {
  const record = requireExactRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "caseId",
      "caseInputDigest",
      "annotationDigests",
      "resolution",
      "finalGoldDigest",
      "releaseEligible",
      "assurance",
      "receiptDigest"
    ],
    "Gold freeze receipt"
  );
  if (
    record.schemaVersion !== REAL_MEDIA_GOLD_FREEZE_RECEIPT_SCHEMA_VERSION ||
    record.kind !== "real-media-gold-freeze-receipt"
  ) {
    throw new Error("Gold freeze receipt schemaVersion 或 kind 无效。");
  }
  const rawAnnotationDigests = requireArray(record.annotationDigests, "Gold annotationDigests");
  if (rawAnnotationDigests.length !== 2) {
    throw new Error("Gold freeze receipt 必须绑定恰好两个 annotation digest。");
  }
  const firstDigest = requireDigest(rawAnnotationDigests[0], "Gold annotationDigests[0]");
  const secondDigest = requireDigest(rawAnnotationDigests[1], "Gold annotationDigests[1]");
  if (firstDigest >= secondDigest) {
    throw new Error("Gold annotationDigests 必须唯一并按 ASCII 升序保存。");
  }
  if (record.releaseEligible !== false) {
    throw new Error("Gold freeze receipt.releaseEligible 必须显式为 false。");
  }
  if (record.assurance !== REAL_MEDIA_GOLD_FREEZE_ASSURANCE) {
    throw new Error(
      `Gold freeze receipt.assurance 必须为 ${REAL_MEDIA_GOLD_FREEZE_ASSURANCE}。`
    );
  }
  const core = {
    schemaVersion: REAL_MEDIA_GOLD_FREEZE_RECEIPT_SCHEMA_VERSION,
    kind: "real-media-gold-freeze-receipt" as const,
    caseId: requireNonemptyTrimmedString(record.caseId, "Gold receipt.caseId"),
    caseInputDigest: requireDigest(record.caseInputDigest, "Gold receipt.caseInputDigest"),
    annotationDigests: [firstDigest, secondDigest] as const,
    resolution: parseReceiptResolution(record.resolution),
    finalGoldDigest: requireDigest(record.finalGoldDigest, "Gold receipt.finalGoldDigest"),
    releaseEligible: false as const,
    assurance: REAL_MEDIA_GOLD_FREEZE_ASSURANCE
  };
  if (
    core.resolution.kind === "consensus" &&
    !core.annotationDigests.includes(core.resolution.selectedAnnotationDigest)
  ) {
    throw new Error("Gold consensus receipt 必须选择其绑定的两份 annotation 之一。");
  }
  if (
    core.resolution.kind === "adjudicated" &&
    core.resolution.resolvedGoldDigest !== core.finalGoldDigest
  ) {
    throw new Error(
      "Gold adjudicated receipt 的 resolvedGoldDigest 必须等于 finalGoldDigest。"
    );
  }
  const receiptDigest = requireDigest(record.receiptDigest, "Gold receipt.receiptDigest");
  if (receiptDigest !== digest(FREEZE_RECEIPT_DIGEST_DOMAIN, core)) {
    throw new Error("Gold receiptDigest 与冻结内容不一致，receipt 可能已被篡改。");
  }
  return { ...core, receiptDigest };
}

function parseReceiptResolution(value: unknown): RealMediaGoldFreezeReceiptResolution {
  if (!isRecord(value)) throw new Error("Gold receipt.resolution 必须是对象。");
  if (value.kind === "consensus") {
    const record = requireExactRecord(
      value,
      ["kind", "selectedAnnotationDigest", "note"],
      "Gold consensus resolution"
    );
    return {
      kind: "consensus",
      selectedAnnotationDigest: requireDigest(
        record.selectedAnnotationDigest,
        "Gold consensus selectedAnnotationDigest"
      ),
      note: requireNonemptyTrimmedString(record.note, "Gold consensus note")
    };
  }
  if (value.kind === "adjudicated") {
    const record = requireExactRecord(
      value,
      ["kind", "adjudicatorId", "adjudicationAnnotationDigest", "resolvedGoldDigest", "note"],
      "Gold adjudicated resolution"
    );
    return {
      kind: "adjudicated",
      adjudicatorId: requireNonemptyTrimmedString(
        record.adjudicatorId,
        "Gold adjudicated adjudicatorId"
      ),
      adjudicationAnnotationDigest: requireDigest(
        record.adjudicationAnnotationDigest,
        "Gold adjudicated adjudicationAnnotationDigest"
      ),
      resolvedGoldDigest: requireDigest(
        record.resolvedGoldDigest,
        "Gold adjudicated resolvedGoldDigest"
      ),
      note: requireNonemptyTrimmedString(record.note, "Gold adjudicated note")
    };
  }
  throw new Error("Gold receipt.resolution.kind 无效。");
}

function compareAnnotation(
  left: RealMediaGoldAnnotationEnvelope,
  right: RealMediaGoldAnnotationEnvelope
): number {
  return compareAscii(left.annotationDigest, right.annotationDigest);
}

function compareAnchor(
  left: RealMediaBenchmarkAnchor,
  right: RealMediaBenchmarkAnchor
): number {
  return (
    compareAscii(left.id, right.id) ||
    left.sourceMs - right.sourceMs ||
    left.targetMs - right.targetMs
  );
}

function compareSpan(left: GoldSpan, right: GoldSpan): number {
  return (
    left.sourceStartMs - right.sourceStartMs ||
    left.targetStartMs - right.targetStartMs ||
    left.sourceEndMs - right.sourceEndMs ||
    left.targetEndMs - right.targetEndMs
  );
}

function compareDisagreement(
  left: RealMediaGoldDisagreement,
  right: RealMediaGoldDisagreement
): number {
  return (
    compareAscii(left.annotationDigests[0], right.annotationDigests[0]) ||
    compareAscii(left.annotationDigests[1], right.annotationDigests[1]) ||
    compareAscii(left.path, right.path)
  );
}

function cloneGold(gold: RealMediaBenchmarkGold): RealMediaBenchmarkGold {
  return normalizeGold(gold);
}

function cloneMediaInput(input: RealMediaBenchmarkMediaInput): RealMediaBenchmarkMediaInput {
  return {
    ...input,
    contentIdentity: input.contentIdentity === null ? null : { ...input.contentIdentity }
  };
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

function requireNonemptyTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} 必须是无首尾空白的非空字符串。`);
  }
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} 必须是安全整数。`);
  }
  return value;
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  const integer = requireSafeInteger(value, label);
  if (integer < 0) throw new Error(`${label} 必须是非负安全整数。`);
  return integer;
}

function requireDigest(value: unknown, label: string): RealMediaGoldDigest {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`${label} 必须为规范的小写 sha256 digest。`);
  }
  return value as RealMediaGoldDigest;
}

function requireSha256Hex(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} 必须为 64 位规范小写十六进制。`);
  }
  return value;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

function digest(domain: string, value: unknown): RealMediaGoldDigest {
  return `sha256:${sha256Hex(`${domain}\n${canonicalJson(value)}`)}`;
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
