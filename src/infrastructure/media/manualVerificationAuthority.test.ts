import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assessMediaTimeMapVerification,
  clearRegisteredManualMediaTimeMapVerificationTrust,
  computeMediaTimeMapCoreDigest,
  reconcileMediaTimeMapQuality,
  type ManualMediaTimeMapVerificationAuthorityResult,
  type ManualMediaTimeMapVerificationSeal
} from "../../domain/alignment/mediaTimeMap";
import type { MediaContentIdentity, MediaTimeMap } from "../../domain/project/types";
import { createTimeMapSpanPlaybackReviewToken } from "../../domain/alignment/timeMapPlaybackReviewEvidence";
import { createTestCompleteTimeMapSpanPlaybackEvidence } from "../../test/manualVerification";
import { createTestCompleteTimeMapSpan } from "../../test/timeMapEvidence";
import {
  issuePersistedManualMediaTimeMapVerification,
  rehydratePersistedManualMediaTimeMapVerification,
  revokePersistedManualMediaTimeMapVerification,
  type ManualVerificationAuthorityBridge
} from "./manualVerificationAuthority";

const TIMESTAMP = "2026-07-12T00:00:00.000Z";
type IssueRequest = Parameters<ManualVerificationAuthorityBridge["issue"]>[0];
type VerifyRequest = Parameters<ManualVerificationAuthorityBridge["verify"]>[0];
type RevokeRequest = Parameters<ManualVerificationAuthorityBridge["revoke"]>[0];

describe("安装级人工验证 bridge", () => {
  beforeEach(() => clearRegisteredManualMediaTimeMapVerificationTrust());

  it("明确人工动作签发后 structuredClone 保持信任，清空运行缓存后必须 native 复核", async () => {
    const bridge = createBridge();
    const issued = await issuePersistedManualMediaTimeMapVerification(
      createVerificationEligibleMap(),
      verificationInput(),
      bridge
    );
    expect(issued.quality.level).toBe("verified");
    expect(issued.verification?.recordVersion).toBe(2);
    expect(assessMediaTimeMapVerification(structuredClone(issued)).trusted).toBe(true);

    clearRegisteredManualMediaTimeMapVerificationTrust();
    const reopened = reconcileMediaTimeMapQuality(structuredClone(issued));
    expect(reopened.quality.level).toBe("review");
    const rehydrated = await rehydratePersistedManualMediaTimeMapVerification(reopened, bridge);
    expect(rehydrated.quality.level).toBe("verified");
    expect(bridge.verify).toHaveBeenCalledTimes(1);
  });

  it("换机、丢 key 或伪造响应 fail-closed", async () => {
    const bridge = createBridge();
    const issued = await issuePersistedManualMediaTimeMapVerification(
      createVerificationEligibleMap(),
      verificationInput(),
      bridge
    );
    clearRegisteredManualMediaTimeMapVerificationTrust();
    bridge.verify = vi.fn(
      (request: VerifyRequest): Promise<ManualMediaTimeMapVerificationAuthorityResult> =>
        Promise.resolve({
          ...request,
          status: "unknown",
          reason: "另一安装"
        })
    );
    const unknown = await rehydratePersistedManualMediaTimeMapVerification(issued, bridge);
    expect(unknown.quality.level).toBe("review");

    clearRegisteredManualMediaTimeMapVerificationTrust();
    bridge.verify = vi.fn(
      (request: VerifyRequest): Promise<ManualMediaTimeMapVerificationAuthorityResult> =>
        Promise.resolve({
          ...request,
          signature: "f".repeat(64),
          status: "active",
          reason: "伪造回显"
        })
    );
    const forged = await rehydratePersistedManualMediaTimeMapVerification(issued, bridge);
    expect(forged.quality.level).toBe("review");
  });

  it("撤销先写 native 注册表，再写项目审计；删除项目 revocation 仍不能恢复", async () => {
    const bridge = createBridge();
    const issued = await issuePersistedManualMediaTimeMapVerification(
      createVerificationEligibleMap(),
      verificationInput(),
      bridge
    );
    const revoked = await revokePersistedManualMediaTimeMapVerification(
      issued,
      { reason: "边界复核失败", revokedBy: "reviewer-1", revokedAt: TIMESTAMP },
      bridge
    );
    expect(revoked.quality.level).toBe("review");
    expect(revoked.verification).toMatchObject({
      recordVersion: 2,
      revocation: { reason: "边界复核失败", revokedBy: "reviewer-1" }
    });
    expect(bridge.revoke).toHaveBeenCalledTimes(1);

    const tampered = structuredClone(revoked);
    if (tampered.verification?.recordVersion === 2) tampered.verification.revocation = null;
    clearRegisteredManualMediaTimeMapVerificationTrust();
    bridge.verify = vi.fn(
      (request: VerifyRequest): Promise<ManualMediaTimeMapVerificationAuthorityResult> =>
        Promise.resolve({
          ...request,
          status: "revoked",
          reason: "native registry revoked"
        })
    );
    const reopened = await rehydratePersistedManualMediaTimeMapVerification(tampered, bridge);
    expect(reopened.quality.level).toBe("review");
    expect(assessMediaTimeMapVerification(reopened).reason).toContain("撤销注册表");
  });

  it("非桌面端不允许签发或撤销", async () => {
    const bridge = createBridge();
    bridge.isAvailable = () => false;
    await expect(
      issuePersistedManualMediaTimeMapVerification(
        createVerificationEligibleMap(),
        verificationInput(),
        bridge
      )
    ).rejects.toThrow("Tauri 桌面端");
  });

  it("已明确接管的版本替换段可在导出动作中取得安装级凭据", async () => {
    const bridge = createBridge();
    const takeoverMap = createVerificationEligibleMap();
    takeoverMap.spans = [
      createTestCompleteTimeMapSpan({
        kind: "ambiguous",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetStartMs: 0,
        targetEndMs: 60_000
      })
    ];
    takeoverMap.quality = {
      ...takeoverMap.quality,
      probability: 0.6,
      uniqueContentCoverage: 0.2,
      alternativeMargin: 0.1
    };
    takeoverMap.evidence = {
      ...takeoverMap.evidence,
      uniqueContentCoverage: 0.2,
      notes: [
        "manual-span-review:v1:0:replacement:2026-07-12T00:00:00.000Z",
        "manual-takeover:v1:2026-07-12T00:00:00.000Z"
      ]
    };

    const issued = await issuePersistedManualMediaTimeMapVerification(
      takeoverMap,
      {
        ...verificationInput(),
        calibrationArtifactId: "manual-takeover-direct-export"
      },
      bridge
    );

    expect(bridge.issue).toHaveBeenCalledTimes(1);
    expect(issued.quality.level).toBe("verified");
    expect(issued.spans[0]?.kind).toBe("ambiguous");
    expect(assessMediaTimeMapVerification(issued).trusted).toBe(true);
  });
});

function createBridge(): ManualVerificationAuthorityBridge {
  const issued = new Map<string, ManualMediaTimeMapVerificationSeal>();
  return {
    isAvailable: () => true,
    issue: vi.fn((request: IssueRequest): Promise<ManualMediaTimeMapVerificationSeal> => {
      const seal: ManualMediaTimeMapVerificationSeal = {
        verificationId: "verification-1",
        issuerKeyId: "install-key-1",
        issuerSequence: 1,
        signatureAlgorithm: "hmac-sha256-v1",
        signature: "1".repeat(64),
        requestDigest: request.requestDigest
      };
      issued.set(seal.verificationId, seal);
      return Promise.resolve(seal);
    }),
    verify: vi.fn(
      (request: VerifyRequest): Promise<ManualMediaTimeMapVerificationAuthorityResult> =>
        Promise.resolve({
          verificationId: request.verificationId,
          issuerKeyId: request.issuerKeyId,
          signature: request.signature,
          requestDigest: request.requestDigest,
          status: issued.has(request.verificationId) ? "active" : "unknown",
          reason: "test authority"
        })
    ),
    revoke: vi.fn((request: RevokeRequest) =>
      Promise.resolve({
        verificationId: request.verificationId,
        issuerKeyId: request.issuerKeyId,
        issuerSequence: 2,
        signatureAlgorithm: "hmac-sha256-v1" as const,
        signature: "2".repeat(64)
      })
    )
  };
}

function verificationInput() {
  return {
    calibrationArtifactId: "manual-a-b-review",
    calibrationArtifactVersion: "1",
    verifier: "reviewer-1",
    verifiedAt: TIMESTAMP
  };
}

function createVerificationEligibleMap(): MediaTimeMap {
  const sourceIdentity = createIdentity("1");
  const targetIdentity = createIdentity("2");
  const map: MediaTimeMap = {
    id: "verified-map-1",
    revision: 1,
    sourceMediaId: "source-1",
    targetMediaId: "target-1",
    sourceStream: null,
    targetStream: null,
    sourceIdentity,
    targetIdentity,
    sourceStartMs: 0,
    sourceEndMs: 60_000,
    targetStartMs: 0,
    targetEndMs: 60_000,
    spans: [
      createTestCompleteTimeMapSpan({
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 60_000,
        targetStartMs: 0,
        targetEndMs: 60_000
      })
    ],
    quality: {
      level: "review",
      probability: 0.999,
      metricSource: "measured",
      coverage: 1,
      uniqueContentCoverage: 1,
      p50ResidualMs: 10,
      p95ResidualMs: 50,
      p99ResidualMs: 70,
      maxResidualMs: 80,
      boundaryUncertaintyMs: 100,
      alternativeMargin: 0.5,
      anchorCount: 30,
      anchorRegionCount: 3,
      heldOutAnchorCount: 5,
      reasons: ["等待明确人工复核。"]
    },
    evidence: {
      types: ["manual"],
      audioAnchorCount: 0,
      visualAnchorCount: 0,
      heldOutAnchorCount: 5,
      top1Top2Margin: 0.5,
      uniqueContentCoverage: 1,
      repeatedContentOnly: false,
      selectedTrackReason: "测试人工轨道。",
      alternativeTrackScores: [],
      notes: ["A/B 人工复核产物已持久化。"]
    },
    verification: null,
    engineVersion: "alignment-v2-test",
    featureVersion: "features-v2-test",
    parametersHash: "parameters-test",
    state: "confirmed",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    confirmedAt: TIMESTAMP
  };
  map.evidence.notes.push(
    createTimeMapSpanPlaybackReviewToken(
      map,
      0,
      createTestCompleteTimeMapSpanPlaybackEvidence(map, 0),
      TIMESTAMP
    )
  );
  expect(computeMediaTimeMapCoreDigest(map)).toMatch(/^sha256:[0-9a-f]{64}$/);
  return map;
}

function createIdentity(digit: string): MediaContentIdentity {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: Number(digit) * 1_000,
    modifiedUnixMs: Number(digit) * 100,
    firstSampleDigest: digit.repeat(64),
    middleSampleDigest: ((Number(digit) + 1) % 10).toString().repeat(64),
    lastSampleDigest: ((Number(digit) + 2) % 10).toString().repeat(64)
  };
}
