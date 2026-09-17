import type { StateCreator } from "zustand";
import { adoptProjectMatches } from "../../domain/alignment/playbackAdoption";
import { createId } from "../../domain/project/factory";
import { cutCandidateToMarker } from "../../domain/alignment/types";
import {
  acceptMediaMatchCandidate as acceptProjectMediaMatchCandidate,
  acceptMediaMatchCandidateWithManualTakeover as acceptProjectMediaMatchCandidateWithManualTakeover,
  automaticallyAcceptMediaMatchCandidate as automaticallyAcceptProjectMediaMatchCandidate,
  rejectMediaMatchCandidate as rejectProjectMediaMatchCandidate,
  revokeMediaMatchCandidateAcceptance as revokeProjectMediaMatchCandidateAcceptance,
  upsertMediaMatchCandidate as upsertProjectMediaMatchCandidate,
  updateMediaMatchCandidateRange as updateProjectMediaMatchCandidateRange
} from "../../domain/alignment/mediaMatching";
import {
  issueManualVerificationCommand,
  revokeManualVerificationCommand
} from "../../application/verificationCommands";
import { assessMediaTimeMapVerification } from "../../domain/alignment/mediaTimeMap";
import { revokePersistedManualMediaTimeMapVerification } from "../../infrastructure/media/manualVerificationAuthority";
import { parseAlignmentShadowRiskOverlayForProject } from "../../domain/alignment/alignmentShadowRiskOverlay";
import { createAlignmentApplyBlockers } from "../../domain/alignment/alignmentReport";
import {
  isAlignmentAnchorApplied,
  isAlignmentCutCandidateApplied
} from "../../domain/alignment/preview";
import { parseAlignmentProposal } from "../../domain/alignment/manualProvider";
import type { EditorStore } from "../editorStoreTypes";
import {
  commitProject,
  createAlignmentProposalPreviewStatus,
  createErrorStatus,
  createSourceFileErrorStatus,
  isSameAlignmentProposal,
  uniqueById
} from "../editorStoreHelpers";

export type MatchingSlice = Pick<
  EditorStore,
  | "alignmentProposal"
  | "adoptMatchesForPlayback"
  | "addMediaMatchCandidate"
  | "updateMediaMatchCandidateRange"
  | "importAlignmentShadowRiskOverlayJson"
  | "clearAlignmentShadowRiskOverlay"
  | "acceptMediaMatchCandidate"
  | "acceptMediaMatchCandidateWithManualTakeover"
  | "issueManualMediaTimeMapVerification"
  | "revokeManualMediaTimeMapVerification"
  | "revokeMediaMatchCandidateAcceptance"
  | "rejectMediaMatchCandidate"
  | "importAlignmentProposalText"
  | "previewAlignmentProposalData"
  | "exportAlignmentProposal"
  | "clearAlignmentProposal"
  | "applyAlignmentProposalData"
  | "applyAlignmentProposal"
>;

export const createMatchingSlice: StateCreator<EditorStore, [], [], MatchingSlice> = (
  set,
  get
) => ({
  alignmentProposal: null,
  adoptMatchesForPlayback: (candidateIds) => {
    if (get().projectLibrary.switchingProject) return false;
    const result = adoptProjectMatches(get().project, candidateIds);
    if (result.project !== get().project)
      commitProject(set, get, "采用匹配结果用于播放", () => result.project);
    set({
      status: {
        message: result.issues.length
          ? `已采用 ${result.adoptedCount} 条关系；${result.issues.length} 条无法采用：${result.issues[0].message}`
          : "已采用现有映射，可直接导出；未覆盖弹幕仍保留，之后可返回修正。",
        tone: result.issues.length ? "warning" : "success"
      }
    });
    return result.issues.length === 0;
  },

  addMediaMatchCandidate: (candidate) => {
    const existing = get().project.mediaMatchCandidates.some(
      (item) => item.id === candidate.id
    );
    let automaticallyAccepted = false;
    commitProject(set, get, existing ? "更新媒体匹配候选" : "新增媒体匹配候选", (project) => {
      const upserted = upsertProjectMediaMatchCandidate(project, candidate);
      const automated = automaticallyAcceptProjectMediaMatchCandidate(upserted, candidate.id);
      automaticallyAccepted =
        automated.mediaMatchCandidates.find((item) => item.id === candidate.id)?.state ===
        "accepted";
      return automated;
    });
    set({
      status: {
        message: automaticallyAccepted
          ? "匹配已通过独立留出硬门，关系与全部已绑定 XML 已自动确认；现在可直接导出。"
          : candidate.state === "blocked"
            ? candidate.proposal.timeMap?.quality.level === "blocked"
              ? "已识别出可复核时间图，但自动质量标准未通过；可接受风险后采用系统最高可能方案，并在本机签发后导出。"
              : "匹配候选已保存，但需要先为参考素材绑定 XML。"
            : "匹配候选已加入复核队列。",
        tone: automaticallyAccepted || candidate.state !== "blocked" ? "success" : "warning"
      }
    });
  },

  updateMediaMatchCandidateRange: (candidateId, patch) => {
    try {
      commitProject(set, get, "调整媒体匹配候选", (project) =>
        updateProjectMediaMatchCandidateRange(project, candidateId, patch)
      );
      set({ status: { message: "已更新候选匹配范围。", tone: "success" } });
    } catch (error) {
      set({ status: createErrorStatus("匹配候选范围无效", error) });
    }
  },

  importAlignmentShadowRiskOverlayJson: (json) => {
    try {
      const overlay = parseAlignmentShadowRiskOverlayForProject(
        JSON.parse(json) as unknown,
        get().project
      );
      commitProject(set, get, "加载离线音频风险", (project) => ({
        ...project,
        alignmentShadowRiskOverlay: overlay
      }));
      set({
        status: {
          message: `已加载 ${overlay.entries.length} 条离线音频风险；只影响独立复核排序。`,
          tone: "success"
        }
      });
      return true;
    } catch (error) {
      set({ status: createErrorStatus("无法加载离线音频风险", error) });
      return false;
    }
  },

  clearAlignmentShadowRiskOverlay: () => {
    if (!get().project.alignmentShadowRiskOverlay) {
      set({ status: { message: "当前项目没有离线音频风险。", tone: "neutral" } });
      return;
    }
    commitProject(set, get, "移除离线音频风险", (project) => ({
      ...project,
      alignmentShadowRiskOverlay: null
    }));
    set({ status: { message: "已移除离线音频风险；项目映射没有变化。", tone: "success" } });
  },

  acceptMediaMatchCandidate: (candidateId, assetIds) => {
    try {
      const beforeCount = get().project.danmakuSourceSegments.length;
      commitProject(set, get, "接受媒体匹配候选", (project) =>
        acceptProjectMediaMatchCandidate(project, candidateId, assetIds)
      );
      const addedCount = get().project.danmakuSourceSegments.length - beforeCount;
      set({
        status: {
          message: `关系已保存，新增 ${Math.max(0, addedCount)} 个来源段；完成复核和验证前不能正式导出。`,
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法接受匹配候选", error) });
    }
  },

  acceptMediaMatchCandidateWithManualTakeover: (candidateId, assetIds) => {
    try {
      const beforeCount = get().project.danmakuSourceSegments.length;
      commitProject(set, get, "采用系统建议并建立人工接管方案", (project) =>
        acceptProjectMediaMatchCandidateWithManualTakeover(project, candidateId, assetIds)
      );
      const addedCount = get().project.danmakuSourceSegments.length - beforeCount;
      set({
        status: {
          message: `已人工采用当前结果，新增 ${Math.max(0, addedCount)} 个来源段，可进入导出检查；该结果未标记为自动验证通过。`,
          tone: "warning"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法建立人工接管方案", error) });
    }
  },

  issueManualMediaTimeMapVerification: async (timeMapId, input) => {
    await issueManualVerificationCommand(
      { project: get().project, projectEpoch: get().projectEpoch },
      timeMapId,
      input,
      () => ({ project: get().project, projectEpoch: get().projectEpoch }),
      (label, updater) => commitProject(set, get, label, updater),
      (message, tone) => set({ status: { message, tone } })
    );
  },

  revokeManualMediaTimeMapVerification: async (timeMapId, input) => {
    await revokeManualVerificationCommand(
      { project: get().project, projectEpoch: get().projectEpoch },
      timeMapId,
      input,
      () => ({ project: get().project, projectEpoch: get().projectEpoch }),
      (label, updater) => commitProject(set, get, label, updater),
      (message, tone) => set({ status: { message, tone } })
    );
  },

  revokeMediaMatchCandidateAcceptance: async (candidateId) => {
    const snapshot = get();
    const candidate = snapshot.project.mediaMatchCandidates.find(
      (item) => item.id === candidateId
    );
    const confirmedMap = candidate?.confirmedTimeMapId
      ? snapshot.project.mediaTimeMaps.find((map) => map.id === candidate.confirmedTimeMapId)
      : null;
    const hasUntrustedForeignVerification =
      confirmedMap?.verification?.recordVersion === 2 &&
      confirmedMap.verification.revocation === null &&
      !assessMediaTimeMapVerification(confirmedMap).trusted;
    let revokedVerifiedMap = confirmedMap ?? null;
    try {
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
          get().projectEpoch !== snapshot.projectEpoch ||
          get().project.mediaMatchCandidates.find((item) => item.id === candidateId)
            ?.confirmedTimeMapId !== candidate?.confirmedTimeMapId
        ) {
          return;
        }
      }
      commitProject(set, get, "撤销媒体匹配确认", (project) => {
        const withRevocation = revokedVerifiedMap
          ? {
              ...project,
              mediaTimeMaps: project.mediaTimeMaps.map((map) =>
                map.id === revokedVerifiedMap?.id ? revokedVerifiedMap : map
              )
            }
          : project;
        return revokeProjectMediaMatchCandidateAcceptance(withRevocation, candidateId);
      });
      set({
        status: {
          message: hasUntrustedForeignVerification
            ? "已撤销匹配确认；旧签名不受本机信任，无法修改原安装撤销注册表，已仅作为 superseded 审计保留。"
            : "已撤销匹配确认，候选已恢复到复核队列。",
          tone: "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("无法撤销匹配确认", error) });
    }
  },

  rejectMediaMatchCandidate: (candidateId) => {
    try {
      commitProject(set, get, "忽略媒体匹配候选", (project) =>
        rejectProjectMediaMatchCandidate(project, candidateId)
      );
      set({ status: { message: "已忽略该匹配候选。", tone: "neutral" } });
    } catch (error) {
      set({ status: createErrorStatus("无法忽略匹配候选", error) });
    }
  },

  importAlignmentProposalText: (text, sourceFileName) => {
    try {
      const proposal = parseAlignmentProposal(text);
      get().previewAlignmentProposalData(proposal);
    } catch (error) {
      set({
        status: createSourceFileErrorStatus(
          "对齐提案导入失败",
          "对齐提案导入失败。",
          error,
          sourceFileName
        )
      });
    }
  },

  previewAlignmentProposalData: (proposal) => {
    const existingProposal = get().project.alignmentProposal;
    if (isSameAlignmentProposal(existingProposal, proposal)) {
      set({
        alignmentProposal: existingProposal,
        status: createAlignmentProposalPreviewStatus(proposal)
      });
      return;
    }
    commitProject(set, get, "预览对齐提案", (currentProject) => ({
      ...currentProject,
      alignmentProposal: proposal
    }));
    set({ status: createAlignmentProposalPreviewStatus(proposal) });
  },

  exportAlignmentProposal: () => {
    const proposal = get().alignmentProposal ?? {
      anchors: get().project.syncAnchors,
      cutCandidates: [],
      confidence: 1,
      diagnostics: ["手动导出的当前锚点。"]
    };
    return `${JSON.stringify(proposal, null, 2)}\n`;
  },

  clearAlignmentProposal: () => {
    if (!get().alignmentProposal && !get().project.alignmentProposal) {
      set({ status: { message: "当前没有可清空的对齐提案。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "清空对齐提案", (currentProject) => ({
      ...currentProject,
      alignmentProposal: null
    }));
    set({ status: { message: "已清空当前对齐提案。", tone: "success" } });
  },

  applyAlignmentProposalData: (proposal) => {
    const project = get().project;
    const blockers = createAlignmentApplyBlockers(proposal, {
      existingAnchors: project.syncAnchors,
      existingCutMarkers: project.cutMarkers
    });
    if (blockers.length > 0) {
      set({
        status: {
          message: `对齐提案存在应用阻断：${blockers[0]}`,
          tone: "warning"
        }
      });
      return;
    }
    const pendingAnchors = proposal.anchors.filter(
      (anchor) => !isAlignmentAnchorApplied(project.syncAnchors, anchor)
    );
    const pendingCutCandidates = proposal.cutCandidates.filter(
      (candidate) => !isAlignmentCutCandidateApplied(project.cutMarkers, candidate)
    );
    if (pendingAnchors.length === 0 && pendingCutCandidates.length === 0) {
      set({ status: { message: "对齐提案没有新的可应用项。", tone: "neutral" } });
      return;
    }
    commitProject(set, get, "应用对齐提案", (currentProject) => ({
      ...currentProject,
      syncAnchors: uniqueById([...currentProject.syncAnchors, ...pendingAnchors]),
      cutMarkers: uniqueById([
        ...currentProject.cutMarkers,
        ...pendingCutCandidates.map((candidate, index) => ({
          ...cutCandidateToMarker(candidate),
          id: candidate.id.length > 0 ? candidate.id : createId("cut"),
          name: candidate.name.length > 0 ? candidate.name : `候选版本差异 ${index + 1}`
        }))
      ])
    }));
    set({
      status: {
        message: `已应用对齐提案：新增 ${pendingAnchors.length} 个同步线索，${pendingCutCandidates.length} 个版本差异。`,
        tone: "success"
      }
    });
  },

  applyAlignmentProposal: () => {
    const proposal = get().alignmentProposal;
    if (!proposal) {
      set({ status: { message: "当前没有可应用的对齐提案。", tone: "warning" } });
      return;
    }
    get().applyAlignmentProposalData(proposal);
  }
});
