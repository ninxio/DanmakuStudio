import { describe, expect, it } from "vitest";
import { computeC137CanonicalDigest, type C137Digest } from "../../domain/alignment/c137Acceptance";
import {
  beginC137ProcessAttestation,
  finalizeC137ProcessAttestation,
  parseC137ProcessAttestationReceipt,
  sealC137BlindBatchReceipt,
  sealC137PerformanceRawEvidence,
  verifyC137ProcessAttestationReceipt,
  type C137ProcessAttestationInvoker,
  type C137ProcessAttestationReceiptV1,
  type C137ProcessEvidenceBindingV1,
  type C137ProcessOpeningPayloadV1,
  type C137ProcessSignedEnvelopeV1
} from "./tauriC137ProcessAttestation";

describe("C137 live process attestation bridge", () => {
  it("严格调用 begin/seal/finalize 并保持两类 evidence kind", async () => {
    const fixture = await createReceipt();
    const invoker: C137ProcessAttestationInvoker = {
      begin: () => Promise.resolve(fixture.receipt.opening),
      sealBlindBatch: (_sessionId, nativeRunId, evidenceDigest) =>
        Promise.resolve({
          evidenceKind: "blind-batch-receipt",
          nativeRunId,
          evidenceDigest
        }),
      sealPerformance: (_sessionId, nativeRunId, evidenceDigest) =>
        Promise.resolve({
          evidenceKind: "performance-raw-evidence",
          nativeRunId,
          evidenceDigest
        }),
      finalize: () => Promise.resolve(fixture.receipt)
    };
    const opening = await beginC137ProcessAttestation(
      fixture.challengeDigest,
      fixture.receipt.opening.payload.authorityNonce,
      invoker
    );
    await expect(
      sealC137BlindBatchReceipt(
        opening.payload.sessionId,
        "audio-align-batch-1",
        digest("c"),
        invoker
      )
    ).resolves.toMatchObject({ evidenceKind: "blind-batch-receipt" });
    await expect(
      sealC137PerformanceRawEvidence(
        opening.payload.sessionId,
        "alignment-benchmark-session-1",
        digest("d"),
        invoker
      )
    ).resolves.toMatchObject({ evidenceKind: "performance-raw-evidence" });
    await expect(
      finalizeC137ProcessAttestation(
        opening.payload.sessionId,
        fixture.dynamicDigest,
        invoker
      )
    ).resolves.toEqual(fixture.receipt);
  });

  it("验证同一进程 opening/finalization、Ed25519、动态根与完整运行库存", async () => {
    const fixture = await createReceipt();
    await expect(
      verifyC137ProcessAttestationReceipt(fixture.receipt, {
        challengeDigest: fixture.challengeDigest,
        authorityNonce: fixture.receipt.opening.payload.authorityNonce,
        nativeExecutableDigest: fixture.nativeExecutableDigest,
        dynamicEvidenceBindingDigest: fixture.dynamicDigest,
        sealedEvidence: fixture.bindings
      })
    ).resolves.toMatchObject({
      valid: true,
      issues: [],
      receiptDigest: computeC137CanonicalDigest(fixture.receipt)
    });
  });

  it("拒绝跨进程、改写 evidence digest、签名重放和未知字段", async () => {
    const fixture = await createReceipt();
    const processDrift = structuredClone(fixture.receipt);
    processDrift.finalization.payload.processId += 1;
    await expect(
      verifyC137ProcessAttestationReceipt(processDrift, {
        challengeDigest: fixture.challengeDigest,
        authorityNonce: fixture.receipt.opening.payload.authorityNonce,
        nativeExecutableDigest: fixture.nativeExecutableDigest,
        dynamicEvidenceBindingDigest: fixture.dynamicDigest,
        sealedEvidence: fixture.bindings
      })
    ).resolves.toMatchObject({ valid: false });

    const evidenceDrift = structuredClone(fixture.receipt);
    evidenceDrift.finalization.payload.sealedEvidence[0].evidenceDigest = digest("9");
    evidenceDrift.finalization.payload.sealedEvidenceDigest = computeC137CanonicalDigest(
      evidenceDrift.finalization.payload.sealedEvidence
    );
    await expect(
      verifyC137ProcessAttestationReceipt(evidenceDrift, {
        challengeDigest: fixture.challengeDigest,
        authorityNonce: fixture.receipt.opening.payload.authorityNonce,
        nativeExecutableDigest: fixture.nativeExecutableDigest,
        dynamicEvidenceBindingDigest: fixture.dynamicDigest,
        sealedEvidence: fixture.bindings
      })
    ).resolves.toMatchObject({ valid: false });

    expect(() =>
      parseC137ProcessAttestationReceipt({
        ...fixture.receipt,
        callerTrust: true
      })
    ).toThrow("字段集合");
  });
});

async function createReceipt(): Promise<{
  receipt: C137ProcessAttestationReceiptV1;
  challengeDigest: C137Digest;
  nativeExecutableDigest: C137Digest;
  dynamicDigest: C137Digest;
  bindings: C137ProcessEvidenceBindingV1[];
}> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify"
  ]);
  const publicKey = encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  );
  const challengeDigest = digest("a");
  const nativeExecutableDigest = digest("b");
  const dynamicDigest = digest("e");
  const openingPayload: C137ProcessOpeningPayloadV1 = {
    schemaVersion: 1,
    kind: "c137-live-process-opening",
    sessionId: "live-process-test-1",
    challengeDigest,
    authorityNonce: "A".repeat(43),
    processId: 4321,
    processStartFileTimeUtc: "133801632000000000",
    nativeExecutableDigest,
    ephemeralPublicKey: publicKey,
    ephemeralKeyId: computeC137CanonicalDigest({
      domain: "c137-live-process-ephemeral-key-v1",
      publicKey
    }),
    openedAtMs: 10
  };
  const opening = await signEnvelope(openingPayload, keyPair.privateKey);
  const bindings: C137ProcessEvidenceBindingV1[] = [
    {
      evidenceKind: "blind-batch-receipt",
      nativeRunId: "audio-align-batch-1",
      evidenceDigest: digest("c")
    },
    {
      evidenceKind: "performance-raw-evidence",
      nativeRunId: "alignment-benchmark-session-1",
      evidenceDigest: digest("d")
    }
  ];
  const finalization = await signEnvelope(
    {
      schemaVersion: 1 as const,
      kind: "c137-live-process-finalization" as const,
      sessionId: openingPayload.sessionId,
      challengeDigest,
      openingDigest: computeC137CanonicalDigest(openingPayload),
      processId: openingPayload.processId,
      processStartFileTimeUtc: openingPayload.processStartFileTimeUtc,
      nativeExecutableDigest,
      sealedEvidence: bindings,
      sealedEvidenceDigest: computeC137CanonicalDigest(bindings),
      dynamicEvidenceBindingDigest: dynamicDigest,
      finalizedAtMs: 20
    },
    keyPair.privateKey
  );
  return {
    receipt: {
      schemaVersion: 1,
      kind: "c137-live-process-attestation",
      opening,
      finalization
    },
    challengeDigest,
    nativeExecutableDigest,
    dynamicDigest,
    bindings
  };
}

async function signEnvelope<T>(
  payload: T,
  privateKey: CryptoKey
): Promise<C137ProcessSignedEnvelopeV1<T>> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(computeC137CanonicalDigest(payload))
  );
  return {
    payload,
    signatureAlgorithm: "Ed25519",
    signature: encodeBase64Url(new Uint8Array(signature))
  };
}

function digest(fill: string): C137Digest {
  return `sha256:${fill.repeat(64)}`;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
