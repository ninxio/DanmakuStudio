import {
  computeC137CanonicalDigest,
  type C137Digest
} from "../alignment/c137Acceptance";

export const C137_PROCESS_ATTESTATION_SCHEMA_VERSION = 1 as const;
export const C137_PROCESS_SIGNATURE_ALGORITHM = "Ed25519" as const;

export type C137ProcessEvidenceKind =
  | "blind-batch-receipt"
  | "performance-raw-evidence";

export interface C137ProcessOpeningPayloadV1 {
  schemaVersion: 1;
  kind: "c137-live-process-opening";
  sessionId: string;
  challengeDigest: C137Digest;
  authorityNonce: string;
  processId: number;
  processStartFileTimeUtc: string;
  nativeExecutableDigest: C137Digest;
  ephemeralPublicKey: string;
  ephemeralKeyId: C137Digest;
  openedAtMs: number;
}

export interface C137ProcessEvidenceBindingV1 {
  evidenceKind: C137ProcessEvidenceKind;
  nativeRunId: string;
  evidenceDigest: C137Digest;
}

export interface C137ProcessFinalizationPayloadV1 {
  schemaVersion: 1;
  kind: "c137-live-process-finalization";
  sessionId: string;
  challengeDigest: C137Digest;
  openingDigest: C137Digest;
  processId: number;
  processStartFileTimeUtc: string;
  nativeExecutableDigest: C137Digest;
  sealedEvidence: C137ProcessEvidenceBindingV1[];
  sealedEvidenceDigest: C137Digest;
  dynamicEvidenceBindingDigest: C137Digest;
  finalizedAtMs: number;
}

export interface C137ProcessSignedEnvelopeV1<T> {
  payload: T;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface C137ProcessAttestationReceiptV1 {
  schemaVersion: 1;
  kind: "c137-live-process-attestation";
  opening: C137ProcessSignedEnvelopeV1<C137ProcessOpeningPayloadV1>;
  finalization: C137ProcessSignedEnvelopeV1<C137ProcessFinalizationPayloadV1>;
}

export interface C137ProcessAttestationInvoker {
  begin(
    challengeDigest: C137Digest,
    authorityNonce: string
  ): Promise<C137ProcessSignedEnvelopeV1<C137ProcessOpeningPayloadV1>>;
  sealBlindBatch(
    sessionId: string,
    nativeRunId: string,
    evidenceDigest: C137Digest
  ): Promise<C137ProcessEvidenceBindingV1>;
  sealPerformance(
    sessionId: string,
    nativeRunId: string,
    evidenceDigest: C137Digest
  ): Promise<C137ProcessEvidenceBindingV1>;
  finalize(
    sessionId: string,
    dynamicEvidenceBindingDigest: C137Digest
  ): Promise<C137ProcessAttestationReceiptV1>;
}

export interface C137ProcessAttestationVerification {
  valid: boolean;
  issues: string[];
  receiptDigest: C137Digest | null;
}

export function parseC137ProcessAttestationReceipt(
  value: unknown
): C137ProcessAttestationReceiptV1 {
  const record = strictRecord(value, "live process attestation", [
    "schemaVersion",
    "kind",
    "opening",
    "finalization"
  ]);
  if (
    record.schemaVersion !== C137_PROCESS_ATTESTATION_SCHEMA_VERSION ||
    record.kind !== "c137-live-process-attestation"
  ) {
    throw new Error("live process attestation schema/kind 无效。");
  }
  return {
    schemaVersion: C137_PROCESS_ATTESTATION_SCHEMA_VERSION,
    kind: "c137-live-process-attestation",
    opening: parseOpeningEnvelope(record.opening),
    finalization: parseFinalizationEnvelope(record.finalization)
  };
}

export async function verifyC137ProcessAttestationReceipt(
  value: unknown,
  expected: {
    challengeDigest: C137Digest;
    authorityNonce: string;
    nativeExecutableDigest: C137Digest;
    dynamicEvidenceBindingDigest: C137Digest;
    sealedEvidence: readonly C137ProcessEvidenceBindingV1[];
  }
): Promise<C137ProcessAttestationVerification> {
  const issues: string[] = [];
  let receipt: C137ProcessAttestationReceiptV1;
  try {
    receipt = parseC137ProcessAttestationReceipt(value);
  } catch (error) {
    return {
      valid: false,
      issues: [error instanceof Error ? error.message : "live process attestation 无法解析。"],
      receiptDigest: null
    };
  }
  const opening = receipt.opening.payload;
  const finalization = receipt.finalization.payload;
  const expectedKeyId = computeC137CanonicalDigest({
    domain: "c137-live-process-ephemeral-key-v1",
    publicKey: opening.ephemeralPublicKey
  });
  if (opening.ephemeralKeyId !== expectedKeyId) {
    issues.push("live process ephemeralKeyId 与原始公钥不一致。");
  }
  if (opening.challengeDigest !== expected.challengeDigest) {
    issues.push("live process opening 未绑定当前 authority challenge。");
  }
  if (opening.authorityNonce !== expected.authorityNonce) {
    issues.push("live process opening 未绑定当前 authority nonce。");
  }
  if (opening.nativeExecutableDigest !== expected.nativeExecutableDigest) {
    issues.push("live process opening 未绑定当前 native executable。");
  }
  if (
    finalization.sessionId !== opening.sessionId ||
    finalization.challengeDigest !== opening.challengeDigest ||
    finalization.processId !== opening.processId ||
    finalization.processStartFileTimeUtc !== opening.processStartFileTimeUtc ||
    finalization.nativeExecutableDigest !== opening.nativeExecutableDigest
  ) {
    issues.push("live process opening/finalization 进程身份不一致。");
  }
  if (finalization.openingDigest !== computeC137CanonicalDigest(opening)) {
    issues.push("live process finalization 未绑定完整 opening。");
  }
  if (finalization.finalizedAtMs < opening.openedAtMs) {
    issues.push("live process finalization 时间早于 opening。");
  }
  if (
    finalization.sealedEvidenceDigest !==
    computeC137CanonicalDigest(finalization.sealedEvidence)
  ) {
    issues.push("live process sealedEvidenceDigest 与证据库存不一致。");
  }
  if (
    finalization.dynamicEvidenceBindingDigest !==
    expected.dynamicEvidenceBindingDigest
  ) {
    issues.push("live process finalization 未绑定当前动态证据根。");
  }
  if (
    canonicalBindings(finalization.sealedEvidence) !==
    canonicalBindings(expected.sealedEvidence)
  ) {
    issues.push("live process 封存的原生运行与当前 formal/performance 证据不一致。");
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      toBufferSource(decodeBase64Url(opening.ephemeralPublicKey)),
      "Ed25519",
      false,
      ["verify"]
    );
    const signatures = await Promise.all(
      [receipt.opening, receipt.finalization].map((envelope) =>
        crypto.subtle.verify(
          "Ed25519",
          key,
          toBufferSource(decodeBase64Url(envelope.signature)),
          new TextEncoder().encode(computeC137CanonicalDigest(envelope.payload))
        )
      )
    );
    if (!signatures.every(Boolean)) {
      issues.push("live process Ed25519 challenge-response 签名无效。");
    }
  } catch (error) {
    issues.push(
      `live process Ed25519 verifier 不可用：${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
  return {
    valid: issues.length === 0,
    issues,
    receiptDigest: computeC137CanonicalDigest(receipt)
  };
}

export function parseOpeningEnvelope(
  value: unknown
): C137ProcessSignedEnvelopeV1<C137ProcessOpeningPayloadV1> {
  return parseEnvelope(value, "live process opening", parseOpeningPayload);
}

export function parseEvidenceBinding(
  value: unknown,
  expectedKind?: C137ProcessEvidenceKind
): C137ProcessEvidenceBindingV1 {
  const record = strictRecord(value, "live process evidence binding", [
    "evidenceKind",
    "nativeRunId",
    "evidenceDigest"
  ]);
  if (
    record.evidenceKind !== "blind-batch-receipt" &&
    record.evidenceKind !== "performance-raw-evidence"
  ) {
    throw new Error("live process evidenceKind 无效。");
  }
  if (expectedKind !== undefined && record.evidenceKind !== expectedKind) {
    throw new Error(`live process evidenceKind 必须为 ${expectedKind}。`);
  }
  return {
    evidenceKind: record.evidenceKind,
    nativeRunId: requireIdentifier(record.nativeRunId, "evidence.nativeRunId"),
    evidenceDigest: requireDigest(record.evidenceDigest, "evidence.evidenceDigest")
  };
}

function parseFinalizationEnvelope(
  value: unknown
): C137ProcessSignedEnvelopeV1<C137ProcessFinalizationPayloadV1> {
  return parseEnvelope(value, "live process finalization", parseFinalizationPayload);
}

function parseEnvelope<T>(
  value: unknown,
  label: string,
  parsePayload: (value: unknown) => T
): C137ProcessSignedEnvelopeV1<T> {
  const record = strictRecord(value, label, [
    "payload",
    "signatureAlgorithm",
    "signature"
  ]);
  if (record.signatureAlgorithm !== C137_PROCESS_SIGNATURE_ALGORITHM) {
    throw new Error(`${label}.signatureAlgorithm 无效。`);
  }
  const signature = requireBase64Url(record.signature, `${label}.signature`, 86);
  if (decodeBase64Url(signature).byteLength !== 64) {
    throw new Error(`${label}.signature 必须是 64-byte Ed25519 签名。`);
  }
  return {
    payload: parsePayload(record.payload),
    signatureAlgorithm: C137_PROCESS_SIGNATURE_ALGORITHM,
    signature
  };
}

function parseOpeningPayload(value: unknown): C137ProcessOpeningPayloadV1 {
  const record = strictRecord(value, "live process opening payload", [
    "schemaVersion",
    "kind",
    "sessionId",
    "challengeDigest",
    "authorityNonce",
    "processId",
    "processStartFileTimeUtc",
    "nativeExecutableDigest",
    "ephemeralPublicKey",
    "ephemeralKeyId",
    "openedAtMs"
  ]);
  if (
    record.schemaVersion !== C137_PROCESS_ATTESTATION_SCHEMA_VERSION ||
    record.kind !== "c137-live-process-opening"
  ) {
    throw new Error("live process opening payload schema/kind 无效。");
  }
  return {
    schemaVersion: C137_PROCESS_ATTESTATION_SCHEMA_VERSION,
    kind: "c137-live-process-opening",
    sessionId: requireIdentifier(record.sessionId, "opening.sessionId"),
    challengeDigest: requireDigest(record.challengeDigest, "opening.challengeDigest"),
    authorityNonce: requireBase64Url(record.authorityNonce, "opening.authorityNonce", 43),
    processId: requireInteger(record.processId, "opening.processId", 1),
    processStartFileTimeUtc: requireDecimalString(
      record.processStartFileTimeUtc,
      "opening.processStartFileTimeUtc"
    ),
    nativeExecutableDigest: requireDigest(
      record.nativeExecutableDigest,
      "opening.nativeExecutableDigest"
    ),
    ephemeralPublicKey: requireBase64Url(
      record.ephemeralPublicKey,
      "opening.ephemeralPublicKey",
      43
    ),
    ephemeralKeyId: requireDigest(record.ephemeralKeyId, "opening.ephemeralKeyId"),
    openedAtMs: requireInteger(record.openedAtMs, "opening.openedAtMs", 0)
  };
}

function parseFinalizationPayload(value: unknown): C137ProcessFinalizationPayloadV1 {
  const record = strictRecord(value, "live process finalization payload", [
    "schemaVersion",
    "kind",
    "sessionId",
    "challengeDigest",
    "openingDigest",
    "processId",
    "processStartFileTimeUtc",
    "nativeExecutableDigest",
    "sealedEvidence",
    "sealedEvidenceDigest",
    "dynamicEvidenceBindingDigest",
    "finalizedAtMs"
  ]);
  if (
    record.schemaVersion !== C137_PROCESS_ATTESTATION_SCHEMA_VERSION ||
    record.kind !== "c137-live-process-finalization" ||
    !Array.isArray(record.sealedEvidence) ||
    record.sealedEvidence.length === 0 ||
    record.sealedEvidence.length > 256
  ) {
    throw new Error("live process finalization payload schema/kind/evidence 无效。");
  }
  const sealedEvidence = record.sealedEvidence.map((item) => parseEvidenceBinding(item));
  if (canonicalBindings(sealedEvidence) !== JSON.stringify(sealedEvidence)) {
    throw new Error("live process sealedEvidence 必须 canonical 排序且不得重复。");
  }
  return {
    schemaVersion: C137_PROCESS_ATTESTATION_SCHEMA_VERSION,
    kind: "c137-live-process-finalization",
    sessionId: requireIdentifier(record.sessionId, "finalization.sessionId"),
    challengeDigest: requireDigest(
      record.challengeDigest,
      "finalization.challengeDigest"
    ),
    openingDigest: requireDigest(record.openingDigest, "finalization.openingDigest"),
    processId: requireInteger(record.processId, "finalization.processId", 1),
    processStartFileTimeUtc: requireDecimalString(
      record.processStartFileTimeUtc,
      "finalization.processStartFileTimeUtc"
    ),
    nativeExecutableDigest: requireDigest(
      record.nativeExecutableDigest,
      "finalization.nativeExecutableDigest"
    ),
    sealedEvidence,
    sealedEvidenceDigest: requireDigest(
      record.sealedEvidenceDigest,
      "finalization.sealedEvidenceDigest"
    ),
    dynamicEvidenceBindingDigest: requireDigest(
      record.dynamicEvidenceBindingDigest,
      "finalization.dynamicEvidenceBindingDigest"
    ),
    finalizedAtMs: requireInteger(record.finalizedAtMs, "finalization.finalizedAtMs", 0)
  };
}

function canonicalBindings(bindings: readonly C137ProcessEvidenceBindingV1[]): string {
  const sorted = [...bindings].sort((left, right) =>
    left.evidenceKind === right.evidenceKind
      ? left.nativeRunId.localeCompare(right.nativeRunId)
      : left.evidenceKind.localeCompare(right.evidenceKind)
  );
  const keys = new Set(sorted.map((binding) => `${binding.evidenceKind}:${binding.nativeRunId}`));
  if (keys.size !== sorted.length) {
    throw new Error("live process evidence binding 重复。");
  }
  return JSON.stringify(sorted);
}

function strictRecord(
  value: unknown,
  label: string,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} 字段集合无效。`);
  }
  return record;
}

function requireDigest(value: unknown, label: string): C137Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} 必须是 canonical SHA-256。`);
  }
  return value as C137Digest;
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value)
  ) {
    throw new Error(`${label} 不是 canonical 标识。`);
  }
  return value;
}

function requireBase64Url(value: unknown, label: string, length: number): string {
  if (
    typeof value !== "string" ||
    value.length !== length ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`${label} 不是 canonical base64url。`);
  }
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error(`${label} 必须是正十进制整数文本。`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`${label} 必须是安全整数。`);
  }
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function toBufferSource(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
