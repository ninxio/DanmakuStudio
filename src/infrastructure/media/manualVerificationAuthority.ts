import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  applyAuthorityIssuedManualMediaTimeMapVerification,
  applyAuthorityRevokedManualMediaTimeMapVerification,
  createManualMediaTimeMapVerificationRequest,
  createManualMediaTimeMapVerificationRevocationRequest,
  reconcileMediaTimeMapQuality,
  registerManualMediaTimeMapVerificationAuthorityResult,
  type ManualMediaTimeMapVerificationAuthorityResult,
  type ManualMediaTimeMapVerificationInput,
  type ManualMediaTimeMapVerificationRevocationInput,
  type ManualMediaTimeMapVerificationRevocationRequest,
  type ManualMediaTimeMapVerificationRevocationSeal,
  type ManualMediaTimeMapVerificationSeal
} from "../../domain/alignment/mediaTimeMap";
import type { EditorProject, MediaTimeMap } from "../../domain/project/types";

export interface ManualVerificationAuthorityBridge {
  isAvailable: () => boolean;
  issue: (request: {
    requestPayload: string;
    requestDigest: string;
  }) => Promise<ManualMediaTimeMapVerificationSeal>;
  verify: (request: {
    verificationId: string;
    issuerKeyId: string;
    signature: string;
    requestPayload: string;
    requestDigest: string;
  }) => Promise<ManualMediaTimeMapVerificationAuthorityResult>;
  revoke: (
    request: ManualMediaTimeMapVerificationRevocationRequest
  ) => Promise<ManualMediaTimeMapVerificationRevocationSeal>;
}

const defaultBridge: ManualVerificationAuthorityBridge = {
  isAvailable: () => isTauri(),
  issue: (request) =>
    invoke<ManualMediaTimeMapVerificationSeal>("issue_manual_time_map_verification", {
      request
    }),
  verify: (request) =>
    invoke<ManualMediaTimeMapVerificationAuthorityResult>(
      "verify_manual_time_map_verification",
      { request }
    ),
  revoke: (request) =>
    invoke<ManualMediaTimeMapVerificationRevocationSeal>(
      "revoke_manual_time_map_verification",
      { request }
    )
};

export function isManualVerificationAuthorityAvailable(
  bridge: ManualVerificationAuthorityBridge = defaultBridge
): boolean {
  return bridge.isAvailable();
}

/** 只能由明确人工确认动作调用；分析完成、接受候选或项目打开均不得自动签发。 */
export async function issuePersistedManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationInput,
  bridge: ManualVerificationAuthorityBridge = defaultBridge
): Promise<MediaTimeMap> {
  assertBridgeAvailable(bridge);
  const request = createManualMediaTimeMapVerificationRequest(map, input);
  const seal = await bridge.issue({
    requestPayload: request.payload,
    requestDigest: request.requestDigest
  });
  return applyAuthorityIssuedManualMediaTimeMapVerification(map, input, seal);
}

/**
 * 保存重开后查询安装级签发/撤销注册表。验证前始终保持 review；换机、丢 key、篡改或
 * native 故障均不会恢复 verified。
 */
export async function rehydratePersistedManualMediaTimeMapVerification(
  map: MediaTimeMap,
  bridge: ManualVerificationAuthorityBridge = defaultBridge
): Promise<MediaTimeMap> {
  const record = map.verification;
  if (!record || record.recordVersion !== 2) {
    return reconcileMediaTimeMapQuality(map);
  }
  if (!bridge.isAvailable()) {
    return reconcileWithPersistedClaim(map);
  }
  try {
    const request = createManualMediaTimeMapVerificationRequest(map, {
      calibrationArtifactId: record.calibrationArtifactId,
      calibrationArtifactVersion: record.calibrationArtifactVersion,
      verifier: record.verifier,
      verifiedAt: record.verifiedAt
    });
    if (request.requestDigest !== record.requestDigest) {
      return reconcileWithPersistedClaim(map);
    }
    const result = await bridge.verify({
      verificationId: record.verificationId,
      issuerKeyId: record.issuerKeyId,
      signature: record.signature,
      requestPayload: request.payload,
      requestDigest: request.requestDigest
    });
    if (
      result.verificationId !== record.verificationId ||
      result.issuerKeyId !== record.issuerKeyId ||
      result.signature !== record.signature ||
      result.requestDigest !== record.requestDigest
    ) {
      return reconcileWithPersistedClaim(map);
    }
    registerManualMediaTimeMapVerificationAuthorityResult(result);
    return reconcileWithPersistedClaim(map);
  } catch {
    return reconcileWithPersistedClaim(map);
  }
}

export async function rehydrateProjectManualMediaTimeMapVerifications(
  project: EditorProject,
  bridge: ManualVerificationAuthorityBridge = defaultBridge
): Promise<EditorProject> {
  if (!project.mediaTimeMaps.some((map) => map.verification?.recordVersion === 2)) {
    return project;
  }
  const mediaTimeMaps = await Promise.all(
    project.mediaTimeMaps.map((map) =>
      rehydratePersistedManualMediaTimeMapVerification(map, bridge)
    )
  );
  return { ...project, mediaTimeMaps };
}

/** native 必须先原子写入撤销事件；只有成功回执才会写入项目审计记录。 */
export async function revokePersistedManualMediaTimeMapVerification(
  map: MediaTimeMap,
  input: ManualMediaTimeMapVerificationRevocationInput,
  bridge: ManualVerificationAuthorityBridge = defaultBridge
): Promise<MediaTimeMap> {
  assertBridgeAvailable(bridge);
  const request = createManualMediaTimeMapVerificationRevocationRequest(map, input);
  const seal = await bridge.revoke(request);
  return applyAuthorityRevokedManualMediaTimeMapVerification(map, input, seal);
}

function reconcileWithPersistedClaim(map: MediaTimeMap): MediaTimeMap {
  return reconcileMediaTimeMapQuality({
    ...map,
    quality: { ...map.quality, level: "verified" }
  });
}

function assertBridgeAvailable(bridge: ManualVerificationAuthorityBridge): void {
  if (!bridge.isAvailable()) {
    throw new Error("持久化人工验证签发与撤销仅可在 Tauri 桌面端执行。");
  }
}
