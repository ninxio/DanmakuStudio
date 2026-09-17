import {
  assessMediaTimeMapVerification,
  computeMediaTimeMapCoreDigest,
  type ManualMediaTimeMapVerificationInput,
  type ManualMediaTimeMapVerificationRevocationInput
} from "../domain/alignment/mediaTimeMap";
import { revokeMediaMatchCandidateAcceptance as revokeProjectMediaMatchCandidateAcceptance } from "../domain/alignment/mediaMatching";
import type { EditorProject } from "../domain/project/types";
import {
  issuePersistedManualMediaTimeMapVerification,
  revokePersistedManualMediaTimeMapVerification
} from "../infrastructure/media/manualVerificationAuthority";

export interface VerificationStoreSnapshot {
  project: EditorProject;
  projectEpoch: number;
}

export type VerificationCommit = (
  label: string,
  updater: (project: EditorProject) => EditorProject
) => void;

export type VerificationSetStatus = (message: string, tone: "success" | "warning" | "error") => void;

/** Issue a persisted manual time-map verification with stale-project race protection. */
export async function issueManualVerificationCommand(
  snapshot: VerificationStoreSnapshot,
  timeMapId: string,
  input: ManualMediaTimeMapVerificationInput,
  getCurrent: () => VerificationStoreSnapshot,
  commit: VerificationCommit,
  setStatus: VerificationSetStatus
): Promise<void> {
  const timeMap = snapshot.project.mediaTimeMaps.find((item) => item.id === timeMapId);
  if (!timeMap) {
    setStatus("待签发的时间图不存在。", "error");
    return;
  }
  const projectEpoch = snapshot.projectEpoch;
  const coreDigest = computeMediaTimeMapCoreDigest(timeMap);
  try {
    const issued = await issuePersistedManualMediaTimeMapVerification(timeMap, input);
    const current = getCurrent();
    const currentMap = current.project.mediaTimeMaps.find((item) => item.id === timeMapId);
    if (
      current.projectEpoch !== projectEpoch ||
      !currentMap ||
      computeMediaTimeMapCoreDigest(currentMap) !== coreDigest
    ) {
      try {
        await revokePersistedManualMediaTimeMapVerification(issued, {
          reason: "签发期间项目或时间图发生变化，未应用的凭据已由竞态保护撤销。",
          revokedBy: "system:stale-project-guard",
          revokedAt: new Date().toISOString()
        });
      } catch {
        // Native issue registry remains the authority. A later project open still rechecks it;
        // never attach this stale seal to a different project even if compensating revoke fails.
      }
      if (getCurrent().projectEpoch === projectEpoch) {
        setStatus("签发期间时间图发生变化，未把旧验证写回项目；请重新完成复核。", "warning");
      }
      return;
    }
    commit("签发人工时间图验证", (project) => ({
      ...project,
      mediaTimeMaps: project.mediaTimeMaps.map((item) =>
        item.id === timeMapId ? issued : item
      )
    }));
    setStatus("人工复核凭据已由本机签发并写入项目。", "success");
  } catch (error) {
    if (getCurrent().projectEpoch === projectEpoch) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? `人工验证签发失败：${error.message}`
          : "人工验证签发失败。";
      setStatus(message, "error");
    }
  }
}

/** Revoke a persisted manual time-map verification with stale-project race protection. */
export async function revokeManualVerificationCommand(
  snapshot: VerificationStoreSnapshot,
  timeMapId: string,
  input: ManualMediaTimeMapVerificationRevocationInput,
  getCurrent: () => VerificationStoreSnapshot,
  commit: VerificationCommit,
  setStatus: VerificationSetStatus
): Promise<void> {
  const timeMap = snapshot.project.mediaTimeMaps.find((item) => item.id === timeMapId);
  if (!timeMap) {
    setStatus("待撤销验证的时间图不存在。", "error");
    return;
  }
  const projectEpoch = snapshot.projectEpoch;
  const coreDigest = computeMediaTimeMapCoreDigest(timeMap);
  try {
    const revoked = await revokePersistedManualMediaTimeMapVerification(timeMap, input);
    const current = getCurrent();
    const currentMap = current.project.mediaTimeMaps.find((item) => item.id === timeMapId);
    if (
      current.projectEpoch !== projectEpoch ||
      !currentMap ||
      computeMediaTimeMapCoreDigest(currentMap) !== coreDigest
    ) {
      return;
    }
    commit("撤销人工时间图验证", (project) => ({
      ...project,
      mediaTimeMaps: project.mediaTimeMaps.map((item) =>
        item.id === timeMapId ? revoked : item
      )
    }));
    setStatus("人工验证已写入本机撤销注册表。", "success");
  } catch (error) {
    if (getCurrent().projectEpoch === projectEpoch) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? `人工验证撤销失败：${error.message}`
          : "人工验证撤销失败。";
      setStatus(message, "error");
    }
  }
}

export interface RevokeMatchAcceptanceResult {
  project: EditorProject;
  hasUntrustedForeignVerification: boolean;
}

/** Orchestrate match-acceptance revocation, including trusted verification cleanup. */
export async function revokeMediaMatchAcceptanceCommand(
  snapshot: VerificationStoreSnapshot,
  candidateId: string,
  getCurrent: () => VerificationStoreSnapshot
): Promise<RevokeMatchAcceptanceResult> {
  const candidate = snapshot.project.mediaMatchCandidates.find((item) => item.id === candidateId);
  const confirmedMap = candidate?.confirmedTimeMapId
    ? snapshot.project.mediaTimeMaps.find((map) => map.id === candidate.confirmedTimeMapId)
    : null;
  const hasUntrustedForeignVerification =
    confirmedMap?.verification?.recordVersion === 2 &&
    confirmedMap.verification.revocation === null &&
    !assessMediaTimeMapVerification(confirmedMap).trusted;
  let revokedVerifiedMap = confirmedMap ?? null;
  if (
    confirmedMap?.verification?.recordVersion === 2 &&
    confirmedMap.verification.revocation === null &&
    assessMediaTimeMapVerification(confirmedMap).trusted
  ) {
    revokedVerifiedMap = await revokePersistedManualMediaTimeMapVerification(confirmedMap, {
      reason: "用户撤销了对应媒体匹配关系。",
      revokedBy: "user:match-revocation",
      revokedAt: new Date().toISOString()
    });
    if (
      getCurrent().projectEpoch !== snapshot.projectEpoch ||
      getCurrent().project.mediaMatchCandidates.find((item) => item.id === candidateId)
        ?.confirmedTimeMapId !== candidate?.confirmedTimeMapId
    ) {
      throw new Error("STALE_MATCH_REVOCATION");
    }
  }
  const withRevocation = revokedVerifiedMap
    ? {
        ...snapshot.project,
        mediaTimeMaps: snapshot.project.mediaTimeMaps.map((map) =>
          map.id === revokedVerifiedMap?.id ? revokedVerifiedMap : map
        )
      }
    : snapshot.project;
  return {
    project: revokeProjectMediaMatchCandidateAcceptance(withRevocation, candidateId),
    hasUntrustedForeignVerification
  };
}
