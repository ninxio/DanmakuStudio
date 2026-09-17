import {
  C137_AUTHORITY_SIGNATURE_ALGORITHM,
  C137_AUTHORITY_SCHEMA_VERSION,
  C137_NATIVE_ARTIFACT_ATTESTATION_SCHEMA_VERSION,
  C137_NATIVE_ARTIFACT_VERIFICATION_PROVIDER,
  C137_NATIVE_PROCESS_OBSERVATION_SCHEMA_VERSION,
  C137_NATIVE_PROCESS_VERIFICATION_PROVIDER,
  createC137AuthorityDynamicEvidenceBinding,
  createC137ExpectedProcessEvidenceBindings,
  createC137AuthorityPostRunBinding,
  createC137AuthorityPreRunBinding,
  createC137AuthorityPublicKeyId,
  type C137AuthorityAttestationPayloadV2,
  type C137AuthorityChallengePayloadV2,
  type C137AuthorityLedgerActionV1,
  type C137AuthorityLedgerCheckpointPayloadV2,
  type C137AuthorityProofV2,
  type C137AuthorityPublicJwk,
  type C137AuthoritySignedEnvelopeV1,
  type C137AuthorityTrustPolicyV2,
  type C137NativeArtifactAttestationV1,
  type C137NativeProcessObservationV1
} from "../domain/alignment/c137Authority";
import {
  computeC137CanonicalDigest,
  type C137AcceptanceBundle
} from "../domain/alignment/c137Acceptance";
import type {
  C137ProcessAttestationReceiptV1,
  C137ProcessSignedEnvelopeV1
} from "../infrastructure/alignment/tauriC137ProcessAttestation";

export interface C137AuthorityProofFixture {
  proof: C137AuthorityProofV2;
  policy: C137AuthorityTrustPolicyV2;
  privateKey: CryptoKey;
}

export async function createC137AuthorityProofFixture(
  bundle: C137AcceptanceBundle
): Promise<C137AuthorityProofFixture> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  if (
    exported.kty !== "EC" ||
    exported.crv !== "P-256" ||
    typeof exported.x !== "string" ||
    typeof exported.y !== "string"
  ) {
    throw new Error("unexpected P-256 public JWK");
  }
  const publicKey: C137AuthorityPublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: exported.x,
    y: exported.y
  };
  const authorityKeyId = createC137AuthorityPublicKeyId(publicKey);
  const nativeArtifactAttestation = createNativeArtifactAttestation(bundle);
  const policy: C137AuthorityTrustPolicyV2 = {
    schemaVersion: C137_AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-trust-policy",
    authorityId: "c137-release-authority",
    ledgerId: "c137-ledger-main",
    authorityKeyId,
    publicKey,
    minimumLedgerSequence: 2,
    requiredCheckpointDigest: null,
    nativeArtifactPolicy: {
      schemaVersion: C137_NATIVE_ARTIFACT_ATTESTATION_SCHEMA_VERSION,
      kind: "c137-native-artifact-trust-policy",
      platform: "windows",
      verificationProvider: C137_NATIVE_ARTIFACT_VERIFICATION_PROVIDER,
      acceptedSignerCertificateDigests: [nativeArtifactAttestation.signerCertificateDigest],
      requireTimestampCertificate: true
    }
  };
  const challengePayload: C137AuthorityChallengePayloadV2 = {
    schemaVersion: C137_AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-challenge",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId,
    challengeId: "challenge-0001",
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    issuedAt: "2026-07-17T01:00:00.000Z",
    expiresAt: "2026-07-17T02:00:00.000Z",
    issuedLedgerSequence: 1,
    binding: createC137AuthorityPreRunBinding(bundle)
  };
  const challenge = await signC137AuthorityEnvelope(challengePayload, keyPair.privateKey);
  const challengeDigest = computeC137CanonicalDigest(challengePayload);
  const {
    receipt: liveProcessAttestation,
    observation: nativeProcessObservation
  } = await createLiveProcessFixture(
    bundle,
    challengeDigest,
    challengePayload.nonce,
    nativeArtifactAttestation
  );
  const attestationPayload: C137AuthorityAttestationPayloadV2 = {
    schemaVersion: C137_AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-attestation",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId,
    challengeId: challengePayload.challengeId,
    challengeDigest,
    issuedAt: "2026-07-17T01:10:00.000Z",
    validUntil: "2026-08-17T01:10:00.000Z",
    consumedLedgerSequence: 2,
    nativeArtifactAttestation,
    nativeProcessObservation,
    liveProcessAttestation,
    binding: createC137AuthorityPostRunBinding(
      bundle,
      nativeArtifactAttestation,
      nativeProcessObservation,
      liveProcessAttestation
    )
  };
  const attestation = await signC137AuthorityEnvelope(attestationPayload, keyPair.privateKey);
  const attestationDigest = computeC137CanonicalDigest(attestationPayload);
  const actions: C137AuthorityLedgerActionV1[] = [
    {
      sequence: 1,
      action: "issued",
      challengeId: challengePayload.challengeId,
      challengeDigest,
      attestationDigest: null,
      bundleDigest: null,
      recordedAt: challengePayload.issuedAt
    },
    {
      sequence: 2,
      action: "consumed",
      challengeId: challengePayload.challengeId,
      challengeDigest,
      attestationDigest,
      bundleDigest: attestationPayload.binding.bundleDigest,
      recordedAt: attestationPayload.issuedAt
    }
  ];
  const checkpointPayload: C137AuthorityLedgerCheckpointPayloadV2 = {
    schemaVersion: C137_AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-ledger-checkpoint",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId,
    sequence: 2,
    previousCheckpointDigest: null,
    issuedAt: "2026-07-17T01:10:01.000Z",
    actionsDigest: computeC137CanonicalDigest(actions),
    actions
  };
  return {
    proof: {
      schemaVersion: C137_AUTHORITY_SCHEMA_VERSION,
      kind: "c137-authority-proof",
      challenge,
      attestation,
      ledgerCheckpoint: await signC137AuthorityEnvelope(checkpointPayload, keyPair.privateKey)
    },
    policy,
    privateKey: keyPair.privateKey
  };
}

async function createLiveProcessFixture(
  bundle: C137AcceptanceBundle,
  challengeDigest: `sha256:${string}`,
  authorityNonce: string,
  artifact: C137NativeArtifactAttestationV1
): Promise<{
  receipt: C137ProcessAttestationReceiptV1;
  observation: C137NativeProcessObservationV1;
}> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify"
  ]);
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  );
  const openingPayload = {
    schemaVersion: 1 as const,
    kind: "c137-live-process-opening" as const,
    sessionId: "live-process-authority-fixture",
    challengeDigest,
    authorityNonce,
    processId: 4242,
    processStartFileTimeUtc: "133801632000000000",
    nativeExecutableDigest: artifact.nativeExecutableDigest,
    ephemeralPublicKey: publicKey,
    ephemeralKeyId: computeC137CanonicalDigest({
      domain: "c137-live-process-ephemeral-key-v1",
      publicKey
    }),
    openedAtMs: Date.parse("2026-07-17T01:01:00.000Z")
  };
  const opening = await signProcessEnvelope(openingPayload, keyPair.privateKey);
  const sealedEvidence = createC137ExpectedProcessEvidenceBindings(bundle);
  const dynamicBinding = createC137AuthorityDynamicEvidenceBinding(bundle, artifact);
  const finalization = await signProcessEnvelope(
    {
      schemaVersion: 1 as const,
      kind: "c137-live-process-finalization" as const,
      sessionId: openingPayload.sessionId,
      challengeDigest,
      openingDigest: computeC137CanonicalDigest(openingPayload),
      processId: openingPayload.processId,
      processStartFileTimeUtc: openingPayload.processStartFileTimeUtc,
      nativeExecutableDigest: artifact.nativeExecutableDigest,
      sealedEvidence,
      sealedEvidenceDigest: computeC137CanonicalDigest(sealedEvidence),
      dynamicEvidenceBindingDigest: computeC137CanonicalDigest(dynamicBinding),
      finalizedAtMs: Date.parse("2026-07-17T01:08:00.000Z")
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
    observation: {
      schemaVersion: C137_NATIVE_PROCESS_OBSERVATION_SCHEMA_VERSION,
      kind: "c137-native-process-observation",
      platform: "windows",
      verificationProvider: C137_NATIVE_PROCESS_VERIFICATION_PROVIDER,
      processId: openingPayload.processId,
      processStartFileTimeUtc: openingPayload.processStartFileTimeUtc,
      nativeExecutableDigest: artifact.nativeExecutableDigest,
      inspectedAt: "2026-07-17T01:09:00.000Z"
    }
  };
}

async function signProcessEnvelope<T>(
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
    signature: toBase64Url(new Uint8Array(signature))
  };
}

function createNativeArtifactAttestation(
  bundle: C137AcceptanceBundle
): C137NativeArtifactAttestationV1 {
  const provenance = bundle.formalEvidence.blindRelationship;
  const identity =
    provenance?.batches[0]?.nativeReceipt.pairOutcomes[0]?.relationRanking.executionIdentity;
  if (identity === null || identity === undefined) {
    throw new Error("test bundle lacks native executable identity");
  }
  return {
    schemaVersion: C137_NATIVE_ARTIFACT_ATTESTATION_SCHEMA_VERSION,
    kind: "c137-native-artifact-attestation",
    platform: "windows",
    verificationProvider: C137_NATIVE_ARTIFACT_VERIFICATION_PROVIDER,
    nativeExecutableDigest: identity.nativeExecutableDigest,
    nativeExecutableSizeBytes: 16_000_000,
    signatureStatus: "valid",
    signerCertificateDigest: `sha256:${"c".repeat(64)}`,
    timestampCertificateDigest: `sha256:${"d".repeat(64)}`,
    inspectedAt: "2026-07-17T01:09:00.000Z"
  };
}

export async function signC137AuthorityEnvelope<T>(
  payload: T,
  privateKey: CryptoKey
): Promise<C137AuthoritySignedEnvelopeV1<T>> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(computeC137CanonicalDigest(payload))
  );
  return {
    payload,
    signatureAlgorithm: C137_AUTHORITY_SIGNATURE_ALGORITHM,
    signature: toBase64Url(new Uint8Array(signature))
  };
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
