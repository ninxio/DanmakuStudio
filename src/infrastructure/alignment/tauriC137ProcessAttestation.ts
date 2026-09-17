import { invoke } from "@tauri-apps/api/core";
import type { C137Digest } from "../../domain/alignment/c137Acceptance";
import {
  parseC137ProcessAttestationReceipt,
  parseEvidenceBinding,
  parseOpeningEnvelope,
  type C137ProcessAttestationInvoker,
  type C137ProcessAttestationReceiptV1,
  type C137ProcessEvidenceBindingV1,
  type C137ProcessOpeningPayloadV1,
  type C137ProcessSignedEnvelopeV1
} from "../../domain/governance/c137ProcessAttestation";

export {
  C137_PROCESS_ATTESTATION_SCHEMA_VERSION,
  C137_PROCESS_SIGNATURE_ALGORITHM,
  parseC137ProcessAttestationReceipt,
  parseEvidenceBinding,
  parseOpeningEnvelope,
  verifyC137ProcessAttestationReceipt,
  type C137ProcessAttestationInvoker,
  type C137ProcessAttestationReceiptV1,
  type C137ProcessAttestationVerification,
  type C137ProcessEvidenceBindingV1,
  type C137ProcessEvidenceKind,
  type C137ProcessFinalizationPayloadV1,
  type C137ProcessOpeningPayloadV1,
  type C137ProcessSignedEnvelopeV1
} from "../../domain/governance/c137ProcessAttestation";

export async function beginC137ProcessAttestation(
  challengeDigest: C137Digest,
  authorityNonce: string,
  invoker: C137ProcessAttestationInvoker = defaultInvoker
): Promise<C137ProcessSignedEnvelopeV1<C137ProcessOpeningPayloadV1>> {
  return parseOpeningEnvelope(await invoker.begin(challengeDigest, authorityNonce));
}

export async function sealC137BlindBatchReceipt(
  sessionId: string,
  nativeRunId: string,
  evidenceDigest: C137Digest,
  invoker: C137ProcessAttestationInvoker = defaultInvoker
): Promise<C137ProcessEvidenceBindingV1> {
  return parseEvidenceBinding(
    await invoker.sealBlindBatch(sessionId, nativeRunId, evidenceDigest),
    "blind-batch-receipt"
  );
}

export async function sealC137PerformanceRawEvidence(
  sessionId: string,
  nativeRunId: string,
  evidenceDigest: C137Digest,
  invoker: C137ProcessAttestationInvoker = defaultInvoker
): Promise<C137ProcessEvidenceBindingV1> {
  return parseEvidenceBinding(
    await invoker.sealPerformance(sessionId, nativeRunId, evidenceDigest),
    "performance-raw-evidence"
  );
}

export async function finalizeC137ProcessAttestation(
  sessionId: string,
  dynamicEvidenceBindingDigest: C137Digest,
  invoker: C137ProcessAttestationInvoker = defaultInvoker
): Promise<C137ProcessAttestationReceiptV1> {
  return parseC137ProcessAttestationReceipt(
    await invoker.finalize(sessionId, dynamicEvidenceBindingDigest)
  );
}

const defaultInvoker: C137ProcessAttestationInvoker = {
  begin: (challengeDigest, authorityNonce) =>
    invoke("begin_c137_process_attestation", {
      request: { challengeDigest, authorityNonce }
    }),
  sealBlindBatch: (sessionId, nativeRunId, evidenceDigest) =>
    invoke("seal_c137_blind_batch_receipt", {
      request: { sessionId, nativeRunId, evidenceDigest }
    }),
  sealPerformance: (sessionId, nativeRunId, evidenceDigest) =>
    invoke("seal_c137_performance_raw_evidence", {
      request: { sessionId, nativeRunId, evidenceDigest }
    }),
  finalize: (sessionId, dynamicEvidenceBindingDigest) =>
    invoke("finalize_c137_process_attestation", {
      request: { sessionId, dynamicEvidenceBindingDigest }
    })
};
