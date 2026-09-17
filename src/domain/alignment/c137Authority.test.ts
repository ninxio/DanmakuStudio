import {
  verifyC137AuthorityProof,
  type C137AuthorityProofV2,
  type C137AuthorityTrustPolicyV2
} from "./c137Authority";
import {
  computeC137CanonicalDigest,
  type C137AcceptanceBundle,
  type C137Digest
} from "./c137Acceptance";
import {
  createC137AuthorityProofFixture,
  signC137AuthorityEnvelope
} from "../../test/c137Authority";

describe("C137 external authority proof", () => {
  it("验证外部 P-256 签名、一次性 challenge、有效期和连续 replay ledger", async () => {
    const fixture = await createAuthorityFixture();

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result).toMatchObject({ valid: true, issues: [] });
    expect(result.authorityKeyId).toBe(fixture.policy.authorityKeyId);
  });

  it("bundle 在签发后变化时即使内部自摘要一起重写也不能复用 authority proof", async () => {
    const fixture = await createAuthorityFixture();
    const tampered = structuredClone(fixture.bundle);
    tampered.runner.parametersDigest = digest("9");

    const result = await verifyC137AuthorityProof(
      tampered,
      fixture.proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("预运行 binding");
    expect(result.issues.join("\n")).toContain("运行后 binding");
  });

  it("调用方自建另一把有效密钥不能命中外部固定 trust policy", async () => {
    const fixture = await createAuthorityFixture();
    const attacker = await createAuthorityFixture();

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      attacker.proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/trust policy|签名无效/);
  });

  it("拒绝过期 attestation、重复 consumed 和跨 bundle ledger 重放", async () => {
    const fixture = await createAuthorityFixture();
    const expired = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      fixture.policy,
      new Date("2026-08-18T01:00:00.000Z")
    );
    expect(expired.valid).toBe(false);
    expect(expired.issues).toContain("authority attestation 已过期。");

    const replayProof = structuredClone(fixture.proof);
    const consumed = replayProof.ledgerCheckpoint.payload.actions[1];
    if (consumed === undefined) throw new Error("missing consumed action");
    replayProof.ledgerCheckpoint.payload.actions.push({
      ...consumed,
      sequence: 3,
      bundleDigest: digest("8")
    });
    replayProof.ledgerCheckpoint.payload.sequence = 3;
    replayProof.ledgerCheckpoint.payload.actionsDigest = computeC137CanonicalDigest(
      replayProof.ledgerCheckpoint.payload.actions
    );
    replayProof.ledgerCheckpoint = await signC137AuthorityEnvelope(
      replayProof.ledgerCheckpoint.payload,
      fixture.privateKey
    );

    const replay = await verifyC137AuthorityProof(
      fixture.bundle,
      replayProof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );
    expect(replay.valid).toBe(false);
    expect(replay.issues.join("\n")).toContain("一次 consumed");
  });

  it("拒绝回滚到低于外部最低序列或未命中固定 checkpoint 的旧账本", async () => {
    const fixture = await createAuthorityFixture();
    const strictPolicy: C137AuthorityTrustPolicyV2 = {
      ...fixture.policy,
      minimumLedgerSequence: 3,
      requiredCheckpointDigest: digest("f")
    };

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      strictPolicy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("最低序列");
    expect(result.issues.join("\n")).toContain("外部固定摘要");
  });

  it("即使 authority 签名有效，native signer 未命中外部证书白名单也拒绝", async () => {
    const fixture = await createAuthorityFixture();
    const wrongSignerPolicy: C137AuthorityTrustPolicyV2 = {
      ...fixture.policy,
      nativeArtifactPolicy: {
        ...fixture.policy.nativeArtifactPolicy,
        acceptedSignerCertificateDigests: [digest("e")]
      }
    };

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      fixture.proof,
      wrongSignerPolicy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("signer 未命中外部固定证书白名单");
  });

  it("旧 authority v2 proof 不能降级混入 live-process v3 语义", async () => {
    const fixture = await createAuthorityFixture();
    const legacyProof = structuredClone(fixture.proof) as unknown as {
      schemaVersion: number;
    };
    legacyProof.schemaVersion = 2;

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      legacyProof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toContain("schema v3");
  });

  it("即使重签外层 authority，跨进程改写仍不能伪造进程内 Ed25519 响应", async () => {
    const fixture = await createAuthorityFixture();
    const proof = structuredClone(fixture.proof);
    const attestation = proof.attestation.payload;
    attestation.liveProcessAttestation.finalization.payload.processId += 1;
    attestation.binding.liveProcessAttestationDigest = computeC137CanonicalDigest(
      attestation.liveProcessAttestation
    );
    proof.attestation = await signC137AuthorityEnvelope(
      attestation,
      fixture.privateKey
    );
    const consumed = proof.ledgerCheckpoint.payload.actions[1];
    if (consumed === undefined) throw new Error("missing consumed action");
    consumed.attestationDigest = computeC137CanonicalDigest(attestation);
    proof.ledgerCheckpoint.payload.actionsDigest = computeC137CanonicalDigest(
      proof.ledgerCheckpoint.payload.actions
    );
    proof.ledgerCheckpoint = await signC137AuthorityEnvelope(
      proof.ledgerCheckpoint.payload,
      fixture.privateKey
    );

    const result = await verifyC137AuthorityProof(
      fixture.bundle,
      proof,
      fixture.policy,
      new Date("2026-07-17T01:15:00.000Z")
    );

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/进程身份|Ed25519/);
  });
});

async function createAuthorityFixture(): Promise<{
  bundle: C137AcceptanceBundle;
  proof: C137AuthorityProofV2;
  policy: C137AuthorityTrustPolicyV2;
  privateKey: CryptoKey;
}> {
  const bundle = createMinimalBundle();
  return { bundle, ...(await createC137AuthorityProofFixture(bundle)) };
}

function createMinimalBundle(): C137AcceptanceBundle {
  const nativeExecutableDigest = digest("a");
  return {
    schemaVersion: 4,
    kind: "c137-acceptance-bundle",
    manifestDigest: digest("1"),
    datasetVersion: "frozen-v1",
    certificationClass: "real-frozen",
    protocol: {
      blindRankingPlanDigest: digest("2"),
      performancePlanDigest: digest("3")
    },
    environment: { digest: digest("4") },
    runner: { buildDigest: digest("5"), parametersDigest: digest("6") },
    receipts: {},
    formalEvidence: {
      blindRelationship: {
        provenanceDigest: digest("7"),
        batches: [
          {
            nativeReceipt: {
              nativeJobId: "audio-align-batch-minimal",
              receiptDigest: digest("9"),
              pairOutcomes: [
                {
                  relationRanking: {
                    executionIdentity: { nativeExecutableDigest }
                  }
                }
              ]
            }
          }
        ]
      }
    },
    reports: {
      performance: {
        rawEvidence: {
          evidenceDigest: digest("8"),
          collector: { sessionId: "alignment-benchmark-session-minimal" }
        }
      }
    }
  } as unknown as C137AcceptanceBundle;
}

function digest(character: string): C137Digest {
  return `sha256:${character.repeat(64)}`;
}
