import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import type { C137AcceptanceBundle, C137Digest } from "./c137Acceptance";

describe("C137 authority external CLI", () => {
  it("拒绝把 authority 私钥写入项目仓库", () => {
    const result = runCli([
      "init",
      "--private-key",
      resolve("authority-private-do-not-create.pem"),
      "--policy",
      join(tmpdir(), "c137-policy-do-not-create.json"),
      "--ledger",
      join(tmpdir(), "c137-ledger-do-not-create.json"),
      "--authority-id",
      "c137-test-authority",
      "--ledger-id",
      "c137-test-ledger"
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须保存在项目仓库之外");
  });

  it("用仓库外私钥签发 challenge、原子消费 ledger、生成并验证 proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "c137-authority-"));
    try {
      const paths = {
        privateKey: join(root, "authority-private.pem"),
        policy: join(root, "authority-policy.json"),
        ledger: join(root, "authority-ledger.json"),
        bundle: join(root, "bundle.json"),
        challenge: join(root, "challenge.json"),
        liveProcessAttestation: join(root, "live-process-attestation.json"),
        proof: join(root, "proof.json"),
        replayProof: join(root, "replay-proof.json")
      };
      const nodeExecutableDigest: C137Digest = `sha256:${createHash("sha256")
        .update(await readFile(process.execPath))
        .digest("hex")}`;
      const inspected = runCli([
        "inspect-native",
        "--native-executable",
        process.execPath
      ]);
      if (inspected.status !== 0) throw new Error(inspected.stderr);
      const nativeArtifactAttestation = JSON.parse(inspected.stdout) as {
        signerCertificateDigest: C137Digest;
        nativeExecutableDigest: C137Digest;
        [key: string]: unknown;
      };
      const signerCertificateDigest =
        nativeArtifactAttestation.signerCertificateDigest;
      const bundle = createMinimalBundle(nodeExecutableDigest);
      await writeFile(
        paths.bundle,
        `${JSON.stringify(bundle, null, 2)}\n`,
        "utf8"
      );

      expect(
        runCli([
          "init",
          "--private-key",
          paths.privateKey,
          "--policy",
          paths.policy,
          "--ledger",
          paths.ledger,
          "--authority-id",
          "c137-test-authority",
          "--ledger-id",
          "c137-test-ledger",
          "--native-signer-cert-sha256",
          signerCertificateDigest
        ]).status
      ).toBe(0);
      expect(
        runCli([
          "issue",
          "--private-key",
          paths.privateKey,
          "--policy",
          paths.policy,
          "--ledger",
          paths.ledger,
          "--bundle",
          paths.bundle,
          "--out",
          paths.challenge,
          "--ttl-minutes",
          "60"
        ]).status
      ).toBe(0);
      const challenge = JSON.parse(await readFile(paths.challenge, "utf8")) as {
        payload: { nonce: string };
      };
      await writeFile(
        paths.liveProcessAttestation,
        `${JSON.stringify(
          createLiveProcessAttestation(
            bundle,
            challenge,
            nativeArtifactAttestation,
            queryCurrentProcessStartFileTime()
          ),
          null,
          2
        )}\n`,
        "utf8"
      );
      expect(
        runCli([
          "attest",
          "--private-key",
          paths.privateKey,
          "--policy",
          paths.policy,
          "--ledger",
          paths.ledger,
          "--challenge",
          paths.challenge,
          "--bundle",
          paths.bundle,
          "--native-executable",
          process.execPath,
          "--live-process-attestation",
          paths.liveProcessAttestation,
          "--out",
          paths.proof,
          "--valid-days",
          "30"
        ]).status
      ).toBe(0);
      const verified = runCli([
        "verify",
        "--policy",
        paths.policy,
        "--proof",
        paths.proof,
        "--bundle",
        paths.bundle,
        "--native-executable",
        process.execPath,
        "--minimum-sequence",
        "2"
      ]);
      expect(verified.status).toBe(0);
      expect(verified.stdout).toContain('"status":"verified"');

      const ledger = JSON.parse(await readFile(paths.ledger, "utf8")) as {
        actions: Array<{ action: string }>;
      };
      expect(ledger.actions.map((item) => item.action)).toEqual(["issued", "consumed"]);

      const replay = runCli([
        "attest",
        "--private-key",
        paths.privateKey,
        "--policy",
        paths.policy,
        "--ledger",
        paths.ledger,
        "--challenge",
        paths.challenge,
        "--bundle",
        paths.bundle,
        "--native-executable",
        process.execPath,
        "--live-process-attestation",
        paths.liveProcessAttestation,
        "--out",
        paths.replayProof,
        "--valid-days",
        "30"
      ]);
      expect(replay.status).not.toBe(0);
      expect(replay.stderr).toContain("唯一 issued 状态");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("未签名或签名损坏的 EXE 不能生成 native artifact attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "c137-unsigned-native-"));
    try {
      const unsignedPath = join(root, "unsigned.exe");
      await writeFile(unsignedPath, "not-an-authenticode-executable", "utf8");

      const result = runCli([
        "inspect-native",
        "--native-executable",
        unsignedPath
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Authenticode 状态不是 Valid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [resolve("scripts/c137-authority.mjs"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function createMinimalBundle(nativeExecutableDigest: C137Digest): C137AcceptanceBundle {
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
              nativeJobId: "audio-align-batch-cli",
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
          collector: { sessionId: "alignment-benchmark-session-cli" }
        }
      }
    }
  } as unknown as C137AcceptanceBundle;
}

function digest(character: string): C137Digest {
  return `sha256:${character.repeat(64)}`;
}

function createLiveProcessAttestation(
  bundle: C137AcceptanceBundle,
  challenge: { payload: { nonce: string } },
  artifact: Record<string, unknown>,
  processStartFileTimeUtc: string
): unknown {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const publicKeyRaw = publicDer.subarray(publicDer.length - 32).toString("base64url");
  const challengeDigest = canonicalDigest(challenge.payload);
  const openedAtMs = Date.now();
  const openingPayload = {
    schemaVersion: 1,
    kind: "c137-live-process-opening",
    sessionId: "live-process-cli-fixture",
    challengeDigest,
    authorityNonce: challenge.payload.nonce,
    processId: process.pid,
    processStartFileTimeUtc,
    nativeExecutableDigest: artifact.nativeExecutableDigest,
    ephemeralPublicKey: publicKeyRaw,
    ephemeralKeyId: canonicalDigest({
      domain: "c137-live-process-ephemeral-key-v1",
      publicKey: publicKeyRaw
    }),
    openedAtMs
  };
  const sealedEvidence = [
    {
      evidenceKind: "blind-batch-receipt",
      nativeRunId:
        bundle.formalEvidence.blindRelationship!.batches[0].nativeReceipt.nativeJobId,
      evidenceDigest:
        bundle.formalEvidence.blindRelationship!.batches[0].nativeReceipt.receiptDigest
    },
    {
      evidenceKind: "performance-raw-evidence",
      nativeRunId: bundle.reports.performance!.rawEvidence.collector.sessionId,
      evidenceDigest: bundle.reports.performance!.rawEvidence.evidenceDigest
    }
  ];
  const { inspectedAt: _inspectedAt, ...artifactIdentity } = artifact;
  void _inspectedAt;
  const dynamicBinding = {
    protocolDigest: canonicalDigest(bundle.protocol),
    manifestDigest: bundle.manifestDigest,
    datasetVersion: bundle.datasetVersion,
    certificationClass: bundle.certificationClass,
    blindPlanDigest: bundle.protocol.blindRankingPlanDigest,
    performancePlanDigest: bundle.protocol.performancePlanDigest,
    environmentDigest: bundle.environment.digest,
    runnerBuildDigest: bundle.runner.buildDigest,
    runnerParametersDigest: bundle.runner.parametersDigest,
    bundleDigest: canonicalDigest(bundle),
    blindProvenanceDigest:
      bundle.formalEvidence.blindRelationship!.provenanceDigest,
    performanceEvidenceDigest:
      bundle.reports.performance!.rawEvidence.evidenceDigest,
    nativeExecutableDigest: artifact.nativeExecutableDigest,
    nativeArtifactIdentityDigest: canonicalDigest(artifactIdentity)
  };
  const finalizationPayload = {
    schemaVersion: 1,
    kind: "c137-live-process-finalization",
    sessionId: openingPayload.sessionId,
    challengeDigest,
    openingDigest: canonicalDigest(openingPayload),
    processId: openingPayload.processId,
    processStartFileTimeUtc,
    nativeExecutableDigest: artifact.nativeExecutableDigest,
    sealedEvidence,
    sealedEvidenceDigest: canonicalDigest(sealedEvidence),
    dynamicEvidenceBindingDigest: canonicalDigest(dynamicBinding),
    finalizedAtMs: openedAtMs + 1
  };
  return {
    schemaVersion: 1,
    kind: "c137-live-process-attestation",
    opening: signProcessEnvelope(openingPayload, privateKey),
    finalization: signProcessEnvelope(finalizationPayload, privateKey)
  };
}

function signProcessEnvelope(
  payload: unknown,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]
): unknown {
  return {
    payload,
    signatureAlgorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonicalDigest(payload)), privateKey).toString(
      "base64url"
    )
  };
}

function queryCurrentProcessStartFileTime(): string {
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`
    ],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function canonicalDigest(value: unknown): C137Digest {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported canonical value");
}
