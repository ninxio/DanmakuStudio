import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIGNATURE_ALGORITHM = "ecdsa-p256-sha256-ieee-p1363";
const AUTHORITY_SCHEMA_VERSION = 3;
const NATIVE_ARTIFACT_SCHEMA_VERSION = 1;
const NATIVE_PROCESS_OBSERVATION_SCHEMA_VERSION = 1;
const NATIVE_ARTIFACT_VERIFICATION_PROVIDER =
  "windows-powershell-get-authenticode-signature-v1";
const NATIVE_PROCESS_VERIFICATION_PROVIDER = "windows-powershell-get-process-v1";
const MAX_LEDGER_ACTIONS = 100_000;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  const options = parseOptions(tokens);
  if (command === "init") return initAuthority(options);
  if (command === "issue") return issueChallenge(options);
  if (command === "attest") return attestBundle(options);
  if (command === "verify") return verifyProofCommand(options);
  if (command === "inspect-native") {
    const attestation = await inspectNativeArtifact(requirePath(options, "native-executable"));
    process.stdout.write(`${JSON.stringify(attestation)}\n`);
    return;
  }
  throw new Error(
    "用法：node scripts/c137-authority.mjs <init|issue|attest|verify> --参数 值；init 需要 --native-signer-cert-sha256，attest 还需要 --live-process-attestation，attest/verify 需要 --native-executable"
  );
}

async function initAuthority(options) {
  const privateKeyPath = requirePath(options, "private-key");
  assertPrivateKeyOutsideProject(privateKeyPath);
  const policyPath = requirePath(options, "policy");
  const ledgerPath = requirePath(options, "ledger");
  const authorityId = requireIdentifier(options, "authority-id");
  const ledgerId = requireIdentifier(options, "ledger-id");
  const acceptedSignerCertificateDigests = requireDigestList(
    options,
    "native-signer-cert-sha256"
  );
  await assertAbsent(privateKeyPath);
  await assertAbsent(policyPath);
  await assertAbsent(ledgerPath);

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicJwk = publicKey.export({ format: "jwk" });
  if (
    publicJwk.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    typeof publicJwk.x !== "string" ||
    typeof publicJwk.y !== "string"
  ) {
    throw new Error("无法导出 P-256 authority public JWK。");
  }
  const publicKeyValue = {
    kty: "EC",
    crv: "P-256",
    x: publicJwk.x,
    y: publicJwk.y
  };
  const authorityKeyId = digest({
    domain: "c137-authority-public-key-v1",
    key: publicKeyValue
  });
  const policy = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-trust-policy",
    authorityId,
    ledgerId,
    authorityKeyId,
    publicKey: publicKeyValue,
    minimumLedgerSequence: 0,
    requiredCheckpointDigest: null,
    nativeArtifactPolicy: {
      schemaVersion: NATIVE_ARTIFACT_SCHEMA_VERSION,
      kind: "c137-native-artifact-trust-policy",
      platform: "windows",
      verificationProvider: NATIVE_ARTIFACT_VERIFICATION_PROVIDER,
      acceptedSignerCertificateDigests,
      requireTimestampCertificate: true
    }
  };
  const ledger = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-ledger",
    authorityId,
    ledgerId,
    authorityKeyId,
    previousCheckpointDigest: null,
    actions: []
  };
  await writeExclusive(privateKeyPath, privatePem);
  await chmod(privateKeyPath, 0o600);
  await writeJsonExclusive(policyPath, policy);
  await writeJsonExclusive(ledgerPath, ledger);
  process.stdout.write(
    `${JSON.stringify({ status: "initialized", authorityKeyId, policyPath, ledgerPath })}\n`
  );
}

async function issueChallenge(options) {
  const privateKeyPath = requirePath(options, "private-key");
  assertPrivateKeyOutsideProject(privateKeyPath);
  const policyPath = requirePath(options, "policy");
  const ledgerPath = requirePath(options, "ledger");
  const bundlePath = requirePath(options, "bundle");
  const outputPath = requirePath(options, "out");
  const ttlMinutes = requireInteger(options, "ttl-minutes", 1, 24 * 60);
  await assertAbsent(outputPath);
  const policy = await readJson(policyPath);
  const ledger = await readJson(ledgerPath);
  const bundle = await readJson(bundlePath);
  validateAuthorityFiles(policy, ledger);
  const privateKey = await readPrivateKey(privateKeyPath, policy);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60_000);
  const sequence = ledger.actions.length + 1;
  if (sequence > MAX_LEDGER_ACTIONS) throw new Error("authority ledger 已达到动作上限。");
  const challengePayload = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-challenge",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId: policy.authorityKeyId,
    challengeId: `challenge-${randomBytes(16).toString("hex")}`,
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuedLedgerSequence: sequence,
    binding: createPreRunBinding(bundle)
  };
  const challenge = signEnvelope(challengePayload, privateKey);
  const challengeDigest = digest(challengePayload);
  ledger.actions.push({
    sequence,
    action: "issued",
    challengeId: challengePayload.challengeId,
    challengeDigest,
    attestationDigest: null,
    bundleDigest: null,
    recordedAt: challengePayload.issuedAt
  });
  await writeJsonAtomic(ledgerPath, ledger);
  await writeJsonExclusive(outputPath, challenge);
  process.stdout.write(
    `${JSON.stringify({ status: "issued", challengeId: challengePayload.challengeId, challengeDigest, expiresAt: challengePayload.expiresAt })}\n`
  );
}

async function attestBundle(options) {
  const privateKeyPath = requirePath(options, "private-key");
  assertPrivateKeyOutsideProject(privateKeyPath);
  const policyPath = requirePath(options, "policy");
  const ledgerPath = requirePath(options, "ledger");
  const challengePath = requirePath(options, "challenge");
  const bundlePath = requirePath(options, "bundle");
  const nativeExecutablePath = requirePath(options, "native-executable");
  const liveProcessAttestationPath = requirePath(options, "live-process-attestation");
  const outputPath = requirePath(options, "out");
  const validityDays = requireInteger(options, "valid-days", 1, 365);
  await assertAbsent(outputPath);
  const policy = await readJson(policyPath);
  const ledger = await readJson(ledgerPath);
  const challenge = await readJson(challengePath);
  const bundle = await readJson(bundlePath);
  const liveProcessAttestation = await readJson(liveProcessAttestationPath);
  validateAuthorityFiles(policy, ledger);
  const nativeArtifactAttestation = await inspectNativeArtifact(nativeExecutablePath);
  validateNativeArtifactAgainstPolicy(nativeArtifactAttestation, policy.nativeArtifactPolicy);
  validateEnvelope(challenge, "c137-authority-challenge", policy);
  const publicKey = createPublicKey({ key: { ...policy.publicKey }, format: "jwk" });
  if (!verifyEnvelope(challenge, publicKey)) throw new Error("challenge authority 签名无效。");
  if (canonical(challenge.payload.binding) !== canonical(createPreRunBinding(bundle))) {
    throw new Error("challenge 预运行 binding 与完整 bundle 不一致。");
  }
  const verificationNow = new Date();
  if (
    verificationNow.getTime() < Date.parse(challenge.payload.issuedAt) ||
    verificationNow.getTime() > Date.parse(challenge.payload.expiresAt)
  ) {
    throw new Error("challenge 尚未生效或已经过期。");
  }
  const dynamicEvidenceBinding = createDynamicEvidenceBinding(
    bundle,
    nativeArtifactAttestation
  );
  validateLiveProcessAttestation(liveProcessAttestation, {
    challengeDigest: digest(challenge.payload),
    authorityNonce: challenge.payload.nonce,
    challengeIssuedAt: challenge.payload.issuedAt,
    challengeExpiresAt: challenge.payload.expiresAt,
    nativeExecutableDigest: nativeArtifactAttestation.nativeExecutableDigest,
    dynamicEvidenceBindingDigest: digest(dynamicEvidenceBinding),
    sealedEvidence: createExpectedProcessEvidenceBindings(bundle)
  });
  const nativeProcessObservation = await inspectLiveProcess(
    liveProcessAttestation,
    nativeExecutablePath
  );
  const now = new Date();
  const matchingActions = ledger.actions.filter(
    (action) => action.challengeId === challenge.payload.challengeId
  );
  if (
    matchingActions.length !== 1 ||
    matchingActions[0].action !== "issued" ||
    matchingActions[0].challengeDigest !== digest(challenge.payload)
  ) {
    throw new Error("challenge 未在当前 authority ledger 中处于唯一 issued 状态。");
  }
  const privateKey = await readPrivateKey(privateKeyPath, policy);
  const sequence = ledger.actions.length + 1;
  if (sequence > MAX_LEDGER_ACTIONS) throw new Error("authority ledger 已达到动作上限。");
  const postRunBinding = createPostRunBinding(
    bundle,
    nativeArtifactAttestation,
    nativeProcessObservation,
    liveProcessAttestation
  );
  const attestationPayload = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-attestation",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId: policy.authorityKeyId,
    challengeId: challenge.payload.challengeId,
    challengeDigest: digest(challenge.payload),
    issuedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + validityDays * 86_400_000).toISOString(),
    consumedLedgerSequence: sequence,
    nativeArtifactAttestation,
    nativeProcessObservation,
    liveProcessAttestation,
    binding: postRunBinding
  };
  const attestation = signEnvelope(attestationPayload, privateKey);
  ledger.actions.push({
    sequence,
    action: "consumed",
    challengeId: challenge.payload.challengeId,
    challengeDigest: attestationPayload.challengeDigest,
    attestationDigest: digest(attestationPayload),
    bundleDigest: attestationPayload.binding.bundleDigest,
    recordedAt: attestationPayload.issuedAt
  });
  const checkpointPayload = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-ledger-checkpoint",
    authorityId: policy.authorityId,
    ledgerId: policy.ledgerId,
    authorityKeyId: policy.authorityKeyId,
    sequence,
    previousCheckpointDigest: ledger.previousCheckpointDigest,
    issuedAt: new Date().toISOString(),
    actionsDigest: digest(ledger.actions),
    actions: ledger.actions
  };
  const ledgerCheckpoint = signEnvelope(checkpointPayload, privateKey);
  const proof = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    kind: "c137-authority-proof",
    challenge,
    attestation,
    ledgerCheckpoint
  };
  ledger.previousCheckpointDigest = digest(checkpointPayload);
  const temporaryProofPath = `${outputPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeJsonExclusive(temporaryProofPath, proof);
  try {
    await writeJsonAtomic(ledgerPath, ledger);
    await rename(temporaryProofPath, outputPath);
  } catch (error) {
    throw new Error(`authority ledger/proof 原子提交失败：${safeError(error)}`);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "attested", challengeId: challenge.payload.challengeId, attestationDigest: digest(attestationPayload), checkpointDigest: digest(checkpointPayload) })}\n`
  );
}

async function verifyProofCommand(options) {
  const policy = await readJson(requirePath(options, "policy"));
  const proof = await readJson(requirePath(options, "proof"));
  const bundle = await readJson(requirePath(options, "bundle"));
  const nativeExecutablePath = requirePath(options, "native-executable");
  const nativeArtifactAttestation = await inspectNativeArtifact(nativeExecutablePath);
  const minimumSequence =
    options.get("minimum-sequence") === undefined
      ? policy.minimumLedgerSequence
      : requireInteger(options, "minimum-sequence", 0, MAX_LEDGER_ACTIONS);
  const verificationPolicy = {
    ...policy,
    minimumLedgerSequence: minimumSequence
  };
  validateNativeArtifactAgainstPolicy(
    nativeArtifactAttestation,
    verificationPolicy.nativeArtifactPolicy
  );
  const issues = verifyProof(bundle, proof, verificationPolicy, nativeArtifactAttestation);
  if (issues.length > 0) throw new Error(`authority proof 验证失败：${issues.join("；")}`);
  process.stdout.write(
    `${JSON.stringify({ status: "verified", authorityKeyId: policy.authorityKeyId, checkpointDigest: digest(proof.ledgerCheckpoint.payload) })}\n`
  );
}

function verifyProof(bundle, proof, policy, inspectedNativeArtifact) {
  const issues = [];
  try {
    if (
      proof.schemaVersion !== AUTHORITY_SCHEMA_VERSION ||
      proof.kind !== "c137-authority-proof"
    ) {
      issues.push("proof schema/kind 无效");
      return issues;
    }
    const publicKey = createPublicKey({ key: { ...policy.publicKey }, format: "jwk" });
    for (const envelope of [proof.challenge, proof.attestation, proof.ledgerCheckpoint]) {
      validateEnvelope(envelope, envelope.payload.kind, policy);
      if (!verifyEnvelope(envelope, publicKey))
        issues.push(`${envelope.payload.kind} 签名无效`);
    }
    const challenge = proof.challenge.payload;
    const attestation = proof.attestation.payload;
    const checkpoint = proof.ledgerCheckpoint.payload;
    if (attestation.challengeDigest !== digest(challenge)) issues.push("challenge digest 漂移");
    if (canonical(challenge.binding) !== canonical(createPreRunBinding(bundle)))
      issues.push("pre-run binding 漂移");
    if (
      canonical(attestation.binding) !==
      canonical(
        createPostRunBinding(
          bundle,
          attestation.nativeArtifactAttestation,
          attestation.nativeProcessObservation,
          attestation.liveProcessAttestation
        )
      )
    )
      issues.push("post-run binding 漂移");
    validateNativeProcessObservation(
      attestation.nativeProcessObservation,
      attestation.liveProcessAttestation,
      attestation.nativeArtifactAttestation
    );
    const dynamicEvidenceBinding = createDynamicEvidenceBinding(
      bundle,
      attestation.nativeArtifactAttestation
    );
    validateLiveProcessAttestation(attestation.liveProcessAttestation, {
      challengeDigest: digest(challenge),
      authorityNonce: challenge.nonce,
      challengeIssuedAt: challenge.issuedAt,
      challengeExpiresAt: challenge.expiresAt,
      nativeExecutableDigest: attestation.nativeArtifactAttestation.nativeExecutableDigest,
      dynamicEvidenceBindingDigest: digest(dynamicEvidenceBinding),
      sealedEvidence: createExpectedProcessEvidenceBindings(bundle)
    });
    if (
      canonical(stableNativeArtifactIdentity(attestation.nativeArtifactAttestation)) !==
      canonical(stableNativeArtifactIdentity(inspectedNativeArtifact))
    )
      issues.push("proof 中的 native artifact attestation 与当前 EXE 独立复核不一致");
    if (Date.parse(attestation.issuedAt) > Date.parse(challenge.expiresAt))
      issues.push("challenge 过期后签发");
    if (
      Date.parse(attestation.nativeProcessObservation.inspectedAt) >
      Date.parse(attestation.issuedAt)
    )
      issues.push("进程观察晚于 authority attestation 签发");
    if (Date.now() > Date.parse(attestation.validUntil)) issues.push("attestation 已过期");
    if (
      checkpoint.sequence !== checkpoint.actions.length ||
      checkpoint.sequence < policy.minimumLedgerSequence
    )
      issues.push("ledger sequence 无效或回滚");
    if (digest(checkpoint.actions) !== checkpoint.actionsDigest)
      issues.push("ledger actions digest 无效");
    if (
      policy.requiredCheckpointDigest !== null &&
      digest(checkpoint) !== policy.requiredCheckpointDigest
    )
      issues.push("checkpoint 未命中固定摘要");
    const actions = checkpoint.actions.filter(
      (item) => item.challengeId === challenge.challengeId
    );
    const issued = actions.filter((item) => item.action === "issued");
    const consumed = actions.filter((item) => item.action === "consumed");
    if (issued.length !== 1 || consumed.length !== 1)
      issues.push("challenge 不是唯一 issued/consumed");
    if (
      consumed[0]?.attestationDigest !== digest(attestation) ||
      consumed[0]?.bundleDigest !== attestation.binding.bundleDigest
    )
      issues.push("consumed 动作未绑定 attestation/bundle");
  } catch (error) {
    issues.push(safeError(error));
  }
  return issues;
}

function createPreRunBinding(bundle) {
  requireDigestValue(bundle.manifestDigest, "bundle.manifestDigest");
  return {
    protocolDigest: digest(bundle.protocol),
    manifestDigest: bundle.manifestDigest,
    datasetVersion: requireStringValue(bundle.datasetVersion, "bundle.datasetVersion"),
    certificationClass: requireStringValue(
      bundle.certificationClass,
      "bundle.certificationClass"
    ),
    blindPlanDigest: requireDigestValue(
      bundle.protocol?.blindRankingPlanDigest,
      "blindRankingPlanDigest"
    ),
    performancePlanDigest: requireDigestValue(
      bundle.protocol?.performancePlanDigest,
      "performancePlanDigest"
    ),
    environmentDigest: requireDigestValue(bundle.environment?.digest, "environment.digest"),
    runnerBuildDigest: requireDigestValue(bundle.runner?.buildDigest, "runner.buildDigest"),
    runnerParametersDigest: requireDigestValue(
      bundle.runner?.parametersDigest,
      "runner.parametersDigest"
    )
  };
}

function createDynamicEvidenceBinding(bundle, nativeArtifactAttestation) {
  const provenance = bundle.formalEvidence?.blindRelationship;
  const performance = bundle.reports?.performance;
  if (!provenance || !performance)
    throw new Error("bundle 缺少 formal blind 或 performance evidence。");
  const nativeDigests = new Set();
  for (const batch of provenance.batches ?? []) {
    for (const outcome of batch.nativeReceipt?.pairOutcomes ?? []) {
      const value = outcome.relationRanking?.executionIdentity?.nativeExecutableDigest;
      if (value) nativeDigests.add(requireDigestValue(value, "nativeExecutableDigest"));
    }
  }
  if (nativeDigests.size !== 1)
    throw new Error("bundle 必须只有一个 native executable digest。");
  const nativeExecutableDigest = [...nativeDigests][0];
  if (nativeArtifactAttestation.nativeExecutableDigest !== nativeExecutableDigest)
    throw new Error("native EXE 全文件摘要与 formal blind execution identity 不一致。");
  return {
    ...createPreRunBinding(bundle),
    bundleDigest: digest(bundle),
    blindProvenanceDigest: requireDigestValue(provenance.provenanceDigest, "provenanceDigest"),
    performanceEvidenceDigest: requireDigestValue(
      performance.rawEvidence?.evidenceDigest,
      "performance evidenceDigest"
    ),
    nativeExecutableDigest,
    nativeArtifactIdentityDigest: digest(stableNativeArtifactIdentity(nativeArtifactAttestation))
  };
}

function createPostRunBinding(
  bundle,
  nativeArtifactAttestation,
  nativeProcessObservation,
  liveProcessAttestation
) {
  const dynamicBinding = createDynamicEvidenceBinding(bundle, nativeArtifactAttestation);
  return {
    ...dynamicBinding,
    nativeArtifactAttestationDigest: digest(nativeArtifactAttestation),
    nativeProcessObservationDigest: digest(nativeProcessObservation),
    dynamicEvidenceBindingDigest: digest(dynamicBinding),
    liveProcessAttestationDigest: digest(liveProcessAttestation)
  };
}

function createExpectedProcessEvidenceBindings(bundle) {
  const provenance = bundle.formalEvidence?.blindRelationship;
  const performance = bundle.reports?.performance?.rawEvidence;
  if (!provenance || !performance)
    throw new Error("bundle 缺少 live-process 所需 formal/performance evidence。");
  const bindings = (provenance.batches ?? []).map((batch) => ({
    evidenceKind: "blind-batch-receipt",
    nativeRunId: requireStringValue(
      batch.nativeReceipt?.nativeJobId,
      "formal nativeJobId"
    ),
    evidenceDigest: requireDigestValue(
      batch.nativeReceipt?.receiptDigest,
      "formal native receiptDigest"
    )
  }));
  bindings.push({
    evidenceKind: "performance-raw-evidence",
    nativeRunId: requireStringValue(
      performance.collector?.sessionId,
      "performance collector.sessionId"
    ),
    evidenceDigest: requireDigestValue(
      performance.evidenceDigest,
      "performance evidenceDigest"
    )
  });
  return bindings.sort(compareEvidenceBindings);
}

function signEnvelope(payload, privateKey) {
  return {
    payload,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signature: sign("sha256", Buffer.from(digest(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363"
    }).toString("base64url")
  };
}

function verifyEnvelope(envelope, publicKey) {
  return verify(
    "sha256",
    Buffer.from(digest(envelope.payload)),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(envelope.signature, "base64url")
  );
}

function validateEnvelope(envelope, kind, policy) {
  if (
    !envelope ||
    envelope.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
    typeof envelope.signature !== "string" ||
    envelope.payload?.kind !== kind ||
    envelope.payload?.schemaVersion !== AUTHORITY_SCHEMA_VERSION
  )
    throw new Error(`${kind} envelope 无效。`);
  if (
    envelope.payload.authorityId !== policy.authorityId ||
    envelope.payload.ledgerId !== policy.ledgerId ||
    envelope.payload.authorityKeyId !== policy.authorityKeyId
  )
    throw new Error(`${kind} 未绑定 trust policy。`);
}

function validateAuthorityFiles(policy, ledger) {
  if (
    policy.schemaVersion !== AUTHORITY_SCHEMA_VERSION ||
    policy.kind !== "c137-authority-trust-policy"
  )
    throw new Error("authority policy 无效。");
  validateNativeArtifactPolicy(policy.nativeArtifactPolicy);
  if (
    ledger.schemaVersion !== AUTHORITY_SCHEMA_VERSION ||
    ledger.kind !== "c137-authority-ledger" ||
    ledger.authorityId !== policy.authorityId ||
    ledger.ledgerId !== policy.ledgerId ||
    ledger.authorityKeyId !== policy.authorityKeyId ||
    !Array.isArray(ledger.actions) ||
    ledger.actions.length > MAX_LEDGER_ACTIONS
  )
    throw new Error("authority ledger 与 policy 不一致。");
}

function validateNativeArtifactPolicy(policy) {
  if (
    !policy ||
    policy.schemaVersion !== NATIVE_ARTIFACT_SCHEMA_VERSION ||
    policy.kind !== "c137-native-artifact-trust-policy" ||
    policy.platform !== "windows" ||
    policy.verificationProvider !== NATIVE_ARTIFACT_VERIFICATION_PROVIDER ||
    policy.requireTimestampCertificate !== true ||
    !Array.isArray(policy.acceptedSignerCertificateDigests) ||
    policy.acceptedSignerCertificateDigests.length === 0 ||
    policy.acceptedSignerCertificateDigests.length > 32
  ) {
    throw new Error("native Authenticode trust policy 无效。");
  }
  const canonicalDigests = [
    ...new Set(
      policy.acceptedSignerCertificateDigests.map((value, index) =>
        requireDigestValue(value, `native signer digest[${index}]`)
      )
    )
  ].sort();
  if (canonical(canonicalDigests) !== canonical(policy.acceptedSignerCertificateDigests)) {
    throw new Error("native signer 证书白名单必须去重并按摘要排序。");
  }
}

function validateNativeArtifactAgainstPolicy(attestation, policy) {
  validateNativeArtifactPolicy(policy);
  if (
    !attestation ||
    attestation.schemaVersion !== NATIVE_ARTIFACT_SCHEMA_VERSION ||
    attestation.kind !== "c137-native-artifact-attestation" ||
    attestation.platform !== "windows" ||
    attestation.verificationProvider !== NATIVE_ARTIFACT_VERIFICATION_PROVIDER ||
    attestation.signatureStatus !== "valid" ||
    !Number.isSafeInteger(attestation.nativeExecutableSizeBytes) ||
    attestation.nativeExecutableSizeBytes <= 0
  ) {
    throw new Error("native artifact attestation 结构无效。");
  }
  requireDigestValue(attestation.nativeExecutableDigest, "native executable digest");
  requireDigestValue(attestation.signerCertificateDigest, "native signer certificate digest");
  if (
    !policy.acceptedSignerCertificateDigests.includes(attestation.signerCertificateDigest)
  ) {
    throw new Error("native executable signer 未命中 authority policy 固定证书白名单。");
  }
  if (
    policy.requireTimestampCertificate &&
    (attestation.timestampCertificateDigest === null ||
      requireDigestValue(
        attestation.timestampCertificateDigest,
        "native timestamp certificate digest"
      ) === null)
  ) {
    throw new Error("native executable 缺少 authority policy 要求的 Authenticode 时间戳。");
  }
  if (
    typeof attestation.inspectedAt !== "string" ||
    new Date(attestation.inspectedAt).toISOString() !== attestation.inspectedAt
  ) {
    throw new Error("native artifact inspectedAt 不是 canonical UTC 时间。");
  }
}

function stableNativeArtifactIdentity(attestation) {
  return {
    schemaVersion: attestation.schemaVersion,
    kind: attestation.kind,
    platform: attestation.platform,
    verificationProvider: attestation.verificationProvider,
    nativeExecutableDigest: attestation.nativeExecutableDigest,
    nativeExecutableSizeBytes: attestation.nativeExecutableSizeBytes,
    signatureStatus: attestation.signatureStatus,
    signerCertificateDigest: attestation.signerCertificateDigest,
    timestampCertificateDigest: attestation.timestampCertificateDigest
  };
}

function validateLiveProcessAttestation(receipt, expected) {
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "c137-live-process-attestation"
  ) {
    throw new Error("live process attestation schema/kind 无效。");
  }
  const openingEnvelope = receipt.opening;
  const finalEnvelope = receipt.finalization;
  const opening = openingEnvelope?.payload;
  const finalization = finalEnvelope?.payload;
  if (
    openingEnvelope?.signatureAlgorithm !== "Ed25519" ||
    finalEnvelope?.signatureAlgorithm !== "Ed25519" ||
    opening?.schemaVersion !== 1 ||
    opening?.kind !== "c137-live-process-opening" ||
    finalization?.schemaVersion !== 1 ||
    finalization?.kind !== "c137-live-process-finalization"
  ) {
    throw new Error("live process challenge-response envelope 无效。");
  }
  if (
    opening.challengeDigest !== expected.challengeDigest ||
    opening.authorityNonce !== expected.authorityNonce
  ) {
    throw new Error("live process opening 未绑定当前 authority challenge/nonce。");
  }
  requireDigestValue(opening.nativeExecutableDigest, "live process executable digest");
  if (opening.nativeExecutableDigest !== expected.nativeExecutableDigest) {
    throw new Error("live process opening 未绑定当前 native executable。");
  }
  if (
    !Number.isSafeInteger(opening.processId) ||
    opening.processId <= 0 ||
    typeof opening.processStartFileTimeUtc !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(opening.processStartFileTimeUtc) ||
    !Number.isSafeInteger(opening.openedAtMs) ||
    opening.openedAtMs < 0
  ) {
    throw new Error("live process opening 的 PID/启动时间/时钟无效。");
  }
  const publicKeyBytes = Buffer.from(opening.ephemeralPublicKey ?? "", "base64url");
  if (
    publicKeyBytes.length !== 32 ||
    digest({
      domain: "c137-live-process-ephemeral-key-v1",
      publicKey: opening.ephemeralPublicKey
    }) !== opening.ephemeralKeyId
  ) {
    throw new Error("live process ephemeral public key/keyId 无效。");
  }
  if (
    finalization.sessionId !== opening.sessionId ||
    finalization.challengeDigest !== opening.challengeDigest ||
    finalization.openingDigest !== digest(opening) ||
    finalization.processId !== opening.processId ||
    finalization.processStartFileTimeUtc !== opening.processStartFileTimeUtc ||
    finalization.nativeExecutableDigest !== opening.nativeExecutableDigest ||
    finalization.dynamicEvidenceBindingDigest !==
      expected.dynamicEvidenceBindingDigest ||
    !Number.isSafeInteger(finalization.finalizedAtMs) ||
    finalization.finalizedAtMs < opening.openedAtMs
  ) {
    throw new Error("live process finalization 的进程/挑战/动态证据绑定无效。");
  }
  if (
    opening.openedAtMs < Date.parse(expected.challengeIssuedAt) ||
    finalization.finalizedAtMs > Date.parse(expected.challengeExpiresAt)
  ) {
    throw new Error("live process opening/finalization 不在 challenge 有效期内。");
  }
  if (
    !Array.isArray(finalization.sealedEvidence) ||
    canonical(finalization.sealedEvidence) !== canonical([...finalization.sealedEvidence].sort(compareEvidenceBindings)) ||
    digest(finalization.sealedEvidence) !== finalization.sealedEvidenceDigest ||
    canonical(finalization.sealedEvidence) !== canonical(expected.sealedEvidence)
  ) {
    throw new Error("live process sealed evidence 库存与 formal/performance 不一致。");
  }
  const uniqueRuns = new Set(
    finalization.sealedEvidence.map(
      (binding) => `${binding.evidenceKind}:${binding.nativeRunId}`
    )
  );
  if (uniqueRuns.size !== finalization.sealedEvidence.length) {
    throw new Error("live process sealed evidence 含重复原生运行。");
  }
  for (const binding of finalization.sealedEvidence) {
    if (
      (binding.evidenceKind !== "blind-batch-receipt" &&
        binding.evidenceKind !== "performance-raw-evidence") ||
      typeof binding.nativeRunId !== "string" ||
      binding.nativeRunId.length === 0
    ) {
      throw new Error("live process evidence binding 标识无效。");
    }
    requireDigestValue(binding.evidenceDigest, "live process evidence digest");
  }
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    publicKeyBytes
  ]);
  const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
  for (const envelope of [openingEnvelope, finalEnvelope]) {
    const signature = Buffer.from(envelope.signature ?? "", "base64url");
    if (
      signature.length !== 64 ||
      !verify(null, Buffer.from(digest(envelope.payload)), publicKey, signature)
    ) {
      throw new Error("live process Ed25519 challenge-response 签名无效。");
    }
  }
}

function compareEvidenceBindings(left, right) {
  return left.evidenceKind === right.evidenceKind
    ? String(left.nativeRunId).localeCompare(String(right.nativeRunId))
    : String(left.evidenceKind).localeCompare(String(right.evidenceKind));
}

function validateNativeProcessObservation(observation, receipt, artifact) {
  const opening = receipt?.opening?.payload;
  if (
    !observation ||
    observation.schemaVersion !== NATIVE_PROCESS_OBSERVATION_SCHEMA_VERSION ||
    observation.kind !== "c137-native-process-observation" ||
    observation.platform !== "windows" ||
    observation.verificationProvider !== NATIVE_PROCESS_VERIFICATION_PROVIDER ||
    observation.processId !== opening?.processId ||
    observation.processStartFileTimeUtc !== opening?.processStartFileTimeUtc ||
    observation.nativeExecutableDigest !== opening?.nativeExecutableDigest ||
    observation.nativeExecutableDigest !== artifact.nativeExecutableDigest ||
    typeof observation.inspectedAt !== "string" ||
    new Date(observation.inspectedAt).toISOString() !== observation.inspectedAt
  ) {
    throw new Error("native Windows process observation 与 live opening/artifact 不一致。");
  }
  if (
    Date.parse(observation.inspectedAt) <
    receipt.finalization.payload.finalizedAtMs
  ) {
    throw new Error("native Windows process observation 早于进程 finalization。");
  }
}

async function inspectLiveProcess(receipt, nativeExecutablePath) {
  if (process.platform !== "win32") {
    throw new Error("C137 live process observation 当前只支持 Windows。");
  }
  const opening = receipt.opening.payload;
  const windowsPowerShellPath = resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const powershell = await findPowerShellExecutable(windowsPowerShellPath);
  const script = [
    "$ErrorActionPreference='Stop'",
    "$pidValue=[int]$env:C137_NATIVE_PROCESS_ID",
    "$process=Get-Process -Id $pidValue -ErrorAction Stop",
    "[ordered]@{processId=$process.Id;processStartFileTimeUtc=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();path=$process.Path} | ConvertTo-Json -Compress"
  ].join(";");
  const result = spawnSync(
    powershell.path,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        C137_NATIVE_PROCESS_ID: String(opening.processId)
      }
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Windows live process 检查失败：${
        result.error?.code ?? safeProcessError(result.stderr)
      }`
    );
  }
  let observed;
  try {
    observed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows live process 检查未返回有效 JSON。");
  }
  if (
    observed.processId !== opening.processId ||
    observed.processStartFileTimeUtc !== opening.processStartFileTimeUtc ||
    typeof observed.path !== "string" ||
    resolve(observed.path).toLowerCase() !== resolve(nativeExecutablePath).toLowerCase()
  ) {
    throw new Error("Windows live process PID/启动时间/映像路径与 opening 不一致。");
  }
  const processImageDigest = await hashFileSha256(observed.path);
  if (processImageDigest !== opening.nativeExecutableDigest) {
    throw new Error("Windows live process 映像摘要与 opening 不一致。");
  }
  return {
    schemaVersion: NATIVE_PROCESS_OBSERVATION_SCHEMA_VERSION,
    kind: "c137-native-process-observation",
    platform: "windows",
    verificationProvider: NATIVE_PROCESS_VERIFICATION_PROVIDER,
    processId: observed.processId,
    processStartFileTimeUtc: observed.processStartFileTimeUtc,
    nativeExecutableDigest: processImageDigest,
    inspectedAt: new Date().toISOString()
  };
}

async function inspectNativeArtifact(path) {
  if (process.platform !== "win32") {
    throw new Error("C137 Authenticode artifact attestation 当前只支持 Windows。");
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0 || !Number.isSafeInteger(metadata.size)) {
    throw new Error("native executable 必须是非空普通文件。");
  }
  const initialFileDigest = await hashFileSha256(path);
  const windowsPowerShellPath = resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const windowsPowerShellModulePath = resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules"
  );
  const powershell = await findPowerShellExecutable(windowsPowerShellPath);
  const script = [
    "$ErrorActionPreference='Stop'",
    ...(powershell.isWindowsPowerShell
      ? ["Import-Module Microsoft.PowerShell.Security"]
      : []),
    "$path=$env:C137_NATIVE_EXECUTABLE",
    "$signature=Get-AuthenticodeSignature -LiteralPath $path",
    "$signer=$signature.SignerCertificate",
    "$timestamp=$signature.TimeStamperCertificate",
    "[ordered]@{status=$signature.Status.ToString();signerCertificate=if($signer){[Convert]::ToBase64String($signer.RawData)}else{$null};timestampCertificate=if($timestamp){[Convert]::ToBase64String($timestamp.RawData)}else{$null}} | ConvertTo-Json -Compress"
  ].join(";");
  const result = spawnSync(
    powershell.path,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        ...(powershell.isWindowsPowerShell
          ? { PSModulePath: windowsPowerShellModulePath }
          : {}),
        C137_NATIVE_EXECUTABLE: path
      }
    }
  );
  if (result.error) {
    throw new Error(`Windows Authenticode 检查进程启动失败：${result.error.code ?? "unknown"}`);
  }
  if (result.status !== 0) {
    throw new Error(`Windows Authenticode 检查失败：${safeProcessError(result.stderr)}`);
  }
  let signature;
  try {
    signature = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Windows Authenticode 检查未返回有效 JSON。");
  }
  if (signature.status !== "Valid" || typeof signature.signerCertificate !== "string") {
    throw new Error(`native executable Authenticode 状态不是 Valid：${signature.status ?? "unknown"}`);
  }
  const signerCertificateDigest = digestCertificate(
    signature.signerCertificate,
    "signer certificate"
  );
  const timestampCertificateDigest =
    typeof signature.timestampCertificate === "string"
      ? digestCertificate(signature.timestampCertificate, "timestamp certificate")
      : null;
  const finalMetadata = await stat(path);
  const finalFileDigest = await hashFileSha256(path);
  if (
    !finalMetadata.isFile() ||
    finalMetadata.size !== metadata.size ||
    finalFileDigest !== initialFileDigest
  ) {
    throw new Error("native executable 在摘要与 Authenticode 检查期间发生变化。");
  }
  return {
    schemaVersion: NATIVE_ARTIFACT_SCHEMA_VERSION,
    kind: "c137-native-artifact-attestation",
    platform: "windows",
    verificationProvider: NATIVE_ARTIFACT_VERIFICATION_PROVIDER,
    nativeExecutableDigest: initialFileDigest,
    nativeExecutableSizeBytes: metadata.size,
    signatureStatus: "valid",
    signerCertificateDigest,
    timestampCertificateDigest,
    inspectedAt: new Date().toISOString()
  };
}

async function hashFileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function findPowerShellExecutable(windowsPowerShellPath) {
  const pathEntries = (process.env.Path ?? process.env.PATH ?? "")
    .split(";")
    .filter((entry) => entry.length > 0);
  const pwshCandidates = pathEntries.map((entry) => resolve(entry, "pwsh.exe"));
  for (const candidate of pwshCandidates) {
    try {
      await access(candidate, fsConstants.F_OK);
      return { path: candidate, isWindowsPowerShell: false };
    } catch {
      // Continue to the next PATH entry.
    }
  }
  await access(windowsPowerShellPath, fsConstants.F_OK);
  return { path: windowsPowerShellPath, isWindowsPowerShell: true };
}

function digestCertificate(base64, label) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== base64) {
    throw new Error(`Windows Authenticode ${label} DER 无效。`);
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeProcessError(value) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  return text.slice(0, 512) || "unknown";
}

async function readPrivateKey(path, policy) {
  const key = createPrivateKey(await readFile(path, "utf8"));
  const publicJwk = createPublicKey(key).export({ format: "jwk" });
  const keyId = digest({
    domain: "c137-authority-public-key-v1",
    key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }
  });
  if (keyId !== policy.authorityKeyId)
    throw new Error("private key 不属于当前 authority policy。");
  return key;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON 不接受非有限数。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  throw new Error("canonical JSON 不接受该值。");
}

function parseOptions(tokens) {
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new Error("参数必须使用 --名称 值。\n");
    const name = key.slice(2);
    if (values.has(name)) throw new Error(`参数 --${name} 重复。`);
    values.set(name, value);
  }
  return values;
}

function requirePath(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`缺少 --${name}。`);
  return resolve(value);
}

function assertPrivateKeyOutsideProject(path) {
  const relativePath = relative(PROJECT_ROOT, path);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("authority private key 必须保存在项目仓库之外。");
  }
}

function requireIdentifier(options, name) {
  const value = options.get(name);
  if (!value || !IDENTIFIER.test(value)) throw new Error(`--${name} 必须是规范标识符。`);
  return value;
}

function requireInteger(options, name, minimum, maximum) {
  const value = Number(options.get(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`--${name} 必须是 ${minimum}..${maximum} 的整数。`);
  return value;
}

function requireDigestList(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`缺少 --${name}。`);
  const digests = [...new Set(value.split(",").map((item) => requireDigestValue(item, name)))].sort();
  if (digests.length === 0 || digests.length > 32) {
    throw new Error(`--${name} 必须包含 1..32 个逗号分隔的 SHA-256。`);
  }
  return digests;
}

function requireDigestValue(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new Error(`${label} 必须是规范 SHA-256。`);
  return value;
}

function requireStringValue(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096)
    throw new Error(`${label} 必须是有界非空字符串。`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonExclusive(path, value) {
  await writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporaryPath, path);
}

async function assertAbsent(path) {
  try {
    await access(path, fsConstants.F_OK);
  } catch {
    return;
  }
  throw new Error(`拒绝覆盖现有文件：${path}`);
}

function safeError(error) {
  return error instanceof Error ? error.message : "unknown authority failure";
}
