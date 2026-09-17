import type { StateCreator } from "zustand";
import { nameImportedProject } from "../../domain/project/mediaFamily";
import { isFamilyArrangement } from "../../domain/project/familyArrangement";
import { updateReferenceEpisodeHint } from "../../domain/project/mediaEpisodeEvidence";
import { isDiscoveryItems, isLibraryProfile } from "../../domain/project/discovery";
import {
  applyBilibiliMaterials,
  prepareBilibiliMaterials
} from "../../application/importBilibiliMaterials";
import {
  createImportedBrowserMedia,
  createImportedPathMedia,
  filterXmlFiles,
  importNativeXmlFiles,
  isSupportedMediaFile,
  mergeNativeXmlIntoAssets,
  parseXmlFilesAsAssets
} from "../../application/importProjectMedia";
import { applyMaterialIntakePlan } from "../../application/applyMaterialIntakePlan";
import {
  associateImportedMaterials,
  describeImportedAssociations
} from "../../application/associateImportedMaterials";
import type { ProjectLibraryAppliedProjectContext } from "../../application/projectLibrarySessionController";
import { createEmptyProject, createId, touchProject } from "../../domain/project/factory";
import { createHistoryState } from "../../domain/history/history";
import {
  createBrowserFileMediaReference,
  createDanmakuSourceBinding,
  createEmbyAudioCacheMediaReference,
  createWebDavAudioCacheMediaReference,
  createMediaReferenceFromBinding,
  findDanmakuSourceBinding,
  findProjectMedia,
  removeDanmakuSourceBinding,
  removeMediaReference,
  reconnectMediaReference as reconnectProjectMediaReference,
  updateMediaDuration as updateProjectMediaDuration,
  upsertDanmakuSourceBinding,
  validateDanmakuSourceBinding,
  validateSourceSegmentReferences
} from "../../domain/project/mediaLibrary";
import { createLocalFileMediaBinding } from "../../domain/project/mediaBinding";
import {
  createDanmakuSourceSegment,
  updateDanmakuSourceSegment
} from "../../domain/project/sourceTimeline";
import {
  parseProjectJsonWithMetadata,
  type ProjectParseResult
} from "../../domain/project/schema";
import type { EditorProject } from "../../domain/project/types";
import { clampMilliseconds } from "../../domain/shared/time";
import { createObjectUrl } from "../../infrastructure/file-system/browserFiles";
import {
  clearRegisteredManualMediaTimeMapVerificationTrust,
  reconcileMediaTimeMapQuality
} from "../../domain/alignment/mediaTimeMap";
import { reconcileMediaMatchCandidates } from "../../domain/alignment/mediaMatching";
import { rehydrateProjectManualMediaTimeMapVerifications } from "../../infrastructure/media/manualVerificationAuthority";
import type { EditorStore } from "../editorStoreTypes";
import {
  commitProject,
  createBindingMediaId,
  createErrorStatus,
  createOpenProjectStatus,
  createSourceFileErrorStatus,
  emptySelection,
  mergeRehydratedManualVerificationMaps,
  revokeObjectUrlIfUnused,
  revokeProjectObjectUrls,
  toLegacyMediaReference,
  upsertMediaById
} from "../editorStoreHelpers";
export type MaterialsSlice = Pick<
  EditorStore,
  | "project"
  | "newProject"
  | "renameProject"
  | "saveFamilyArrangement"
  | "setReferenceEpisodeHint"
  | "saveDiscovery"
  | "importXmlFiles"
  | "importXmlPaths"
  | "importBilibiliMaterials"
  | "importMediaFiles"
  | "importMediaPaths"
  | "importEmbyAudioCache"
  | "importWebDavAudioCache"
  | "importVideoFile"
  | "removeMedia"
  | "removeMediaReference"
  | "reconnectMediaReference"
  | "bindCurrentMediaAsTarget"
  | "setMediaBinding"
  | "clearMediaBinding"
  | "bindXmlToSourceMedia"
  | "clearXmlSourceBinding"
  | "applyMaterialIntakeSuggestions"
  | "bindCurrentTargetToSeasonEpisode"
  | "clearSeasonEpisodeBinding"
  | "addDanmakuSourceSegment"
  | "updateDanmakuSourceSegment"
  | "deleteDanmakuSourceSegment"
  | "updateMediaDuration"
  | "openProjectFromText"
  | "openProjectFromLibrary"
  | "removeAsset"
>;

export const createMaterialsSlice: StateCreator<EditorStore, [], [], MaterialsSlice> = (
  set,
  get
) => ({
  project: createEmptyProject(),
  setReferenceEpisodeHint: (mediaId, text) => {
    if (get().projectLibrary.switchingProject) return false;
    try {
      const updated = updateReferenceEpisodeHint(get().project, mediaId, text);
      commitProject(set, get, "修正参考分集编号", () => updated);
      set({ status: { message: "参考集号已更新，可撤销；已有时间关系保持不变。", tone: "success" } });
      return true;
    } catch (error) {
      set({ status: { message: String(error), tone: "error" } });
      return false;
    }
  },
  saveDiscovery: (items, profile) => {
    if (get().projectLibrary.switchingProject) return false;
    if (!isDiscoveryItems(items) || (profile !== undefined && !isLibraryProfile(profile))) {
      set({ status: { message: "请检查链接和作品资料，未保存无效内容。", tone: "error" } });
      return false;
    }
    commitProject(set, get, "保存发现与整理", (project) => ({
      ...project,
      discoveryItems: structuredClone(items),
      libraryProfile: profile ? structuredClone(profile) : undefined
    }));
    return true;
  },

  renameProject: (name) => {
    const clean = name.trim().slice(0, 180);
    if (!clean || clean === get().project.name) return;
    commitProject(set, get, "重命名项目", (project) => ({ ...project, name: clean }));
  },
  saveFamilyArrangement: (arrangement) => {
    if (
      !isFamilyArrangement(arrangement) ||
      arrangement.rows.some(
        (row) => !get().project.assets.some((asset) => asset.id === row.assetId)
      )
    ) {
      set({ status: { message: "安排包含无效时间或已移除文件，请检查。", tone: "error" } });
      return false;
    }
    commitProject(set, get, "保存分集安排", (project) => ({
      ...project,
      familyArrangement: structuredClone(arrangement)
    }));
    set({ status: { message: "分集安排已保存，可继续修改或按分集导出。", tone: "success" } });
    return true;
  },

  newProject: () => {
    if (get().projectLibrary.availability === "ready") {
      get().requestProjectLibrary({ kind: "createProject" });
      return;
    }
    revokeProjectObjectUrls(get().project);
    set({
      project: createEmptyProject(),
      selection: emptySelection,
      history: createHistoryState<EditorProject>(),
      isPlaying: false,
      status: { message: "已创建新项目", tone: "success" },
      exportDraft: null,
      alignmentProposal: null,
      timelineTool: "select",
      workspaceIntentRequest: null,
      alignmentEditorCandidateId: null,
      importProgress: null,
      projectEpoch: get().projectEpoch + 1
    });
  },

  importXmlFiles: async (files) => {
    if (get().projectLibrary.switchingProject) return;
    const fileArray = filterXmlFiles(files);
    if (fileArray.length === 0) {
      set({ status: { message: "请选择 XML 文件。", tone: "warning" } });
      return;
    }
    const projectEpoch = get().projectEpoch;
    const projectId = get().project.id;
    const isCurrentProject = () =>
      get().projectEpoch === projectEpoch && get().project.id === projectId;
    set({ importProgress: 0, status: { message: "正在读取 XML...", tone: "neutral" } });
    try {
      const assets = await parseXmlFilesAsAssets(
        fileArray,
        get().project.assets.length,
        (ratio) => {
          if (isCurrentProject()) set({ importProgress: ratio });
        }
      );
      if (!isCurrentProject()) return;
      let boundCount = 0;
      commitProject(set, get, "导入 XML", (project) => {
        const result = associateImportedMaterials(
          {
            ...project,
            assets: [...project.assets, ...assets]
          },
          { assetIds: assets.map((asset) => asset.id) }
        );
        boundCount = result.boundCount;
        return nameImportedProject(result.project);
      });
      set({
        importProgress: null,
        status: {
          message: `已预览导入 ${assets.length} 个 XML，共 ${assets.reduce((sum, asset) => sum + asset.items.length, 0)} 条弹幕。${describeImportedAssociations(boundCount)}此方式没有原生内容收据；正式受验证导出前，请在素材页用“导入 XML”重新选择原文件。`,
          tone: "warning"
        }
      });
    } catch (error) {
      if (!isCurrentProject()) return;
      set({
        importProgress: null,
        status: createErrorStatus("XML 导入失败", error)
      });
    }
  },

  importXmlPaths: async (paths) => {
    if (get().projectLibrary.switchingProject) return;
    if (paths.length === 0) {
      set({ status: { message: "请选择 XML 文件。", tone: "warning" } });
      return;
    }
    const projectEpoch = get().projectEpoch;
    const projectId = get().project.id;
    const isCurrentProject = () =>
      get().projectEpoch === projectEpoch && get().project.id === projectId;
    set({
      importProgress: 0,
      status: { message: "正在由桌面端验证并读取 XML...", tone: "neutral" }
    });
    try {
      const importedFiles = await importNativeXmlFiles(paths);
      if (!isCurrentProject()) return;
      let boundCount = 0;
      let additions = 0;
      let replacements = 0;
      let itemCount = 0;
      commitProject(set, get, "原生导入 XML", (project) => {
        const existingIds = new Set(project.assets.map((asset) => asset.id));
        const merged = mergeNativeXmlIntoAssets(importedFiles, project.assets);
        ({ additions, replacements, itemCount } = merged);
        const result = associateImportedMaterials(
          { ...project, assets: merged.assets },
          {
            assetIds: merged.assets
              .filter((asset) => !existingIds.has(asset.id))
              .map((asset) => asset.id)
          }
        );
        boundCount = result.boundCount;
        return nameImportedProject(result.project);
      });
      set({
        importProgress: null,
        status: {
          message: `已受验证导入 ${importedFiles.length} 个 XML，共 ${itemCount} 条弹幕；认领旧资源 ${replacements} 个，新增 ${additions} 个。${describeImportedAssociations(boundCount)}`,
          tone: "success"
        }
      });
    } catch (error) {
      if (!isCurrentProject()) return;
      set({
        importProgress: null,
        status: createErrorStatus("XML 导入失败", error)
      });
    }
  },

  importBilibiliMaterials: async (results, context) => {
    if (get().projectLibrary.switchingProject) return null;
    const sameSession = () =>
      get().project.id === context.projectId && get().projectEpoch === context.projectEpoch;
    if (!sameSession()) return null;
    const prepared = await prepareBilibiliMaterials(results);
    if (!sameSession()) return null;
    const current = get().project;
    const result = applyBilibiliMaterials(current, prepared);
    if (result.project !== current) {
      commitProject(set, get, "导入 B 站弹幕与参考音轨", () =>
        nameImportedProject(result.project)
      );
    }
    set({
      status: {
        message: `B 站素材已加入：新增 ${result.summary.added} 个 XML、${result.summary.audioAdded} 个参考音轨，自动绑定 ${result.summary.bound} 组${result.summary.preserved > 0 ? `；${result.summary.preserved} 个已有弹幕版本已保留` : ""}。`,
        tone: result.summary.preserved > 0 ? "warning" : "success"
      }
    });
    return result.summary;
  },

  importMediaFiles: (files, role) => {
    if (get().projectLibrary.switchingProject) return;
    const importedMedia = createImportedBrowserMedia(files, role);
    if (importedMedia.length === 0) {
      set({ status: { message: "请选择受支持的视频或音频文件。", tone: "warning" } });
      return;
    }
    let boundCount = 0;
    commitProject(
      set,
      get,
      role === "targetOriginal" ? "导入原片素材" : "导入 B 站参考素材",
      (project) => {
        const result = associateImportedMaterials(
          {
            ...project,
            mediaLibrary: [...project.mediaLibrary, ...importedMedia]
          },
          {
            referenceMediaIds:
              role === "bilibiliReference" ? importedMedia.map((media) => media.id) : []
          }
        );
        boundCount = result.boundCount;
        return nameImportedProject(result.project);
      }
    );
    set({
      status: {
        message:
          role === "targetOriginal"
            ? `已导入 ${importedMedia.length} 个原片素材。`
            : `已导入 ${importedMedia.length} 个 B 站参考素材。${describeImportedAssociations(boundCount)}`,
        tone: "success"
      }
    });
  },

  importMediaPaths: (paths, role) => {
    if (get().projectLibrary.switchingProject) return;
    const { importedMedia, skippedCount, uniquePathCount } = createImportedPathMedia(
      paths,
      role,
      get().project.mediaLibrary
    );
    if (uniquePathCount === 0) {
      set({ status: { message: "请选择受支持的视频或音频文件。", tone: "warning" } });
      return;
    }
    if (importedMedia.length === 0) {
      set({
        status: {
          message: `所选 ${uniquePathCount} 个媒体文件已在${role === "targetOriginal" ? "原片" : "B 站参考"}素材中，未重复导入。`,
          tone: "neutral"
        }
      });
      return;
    }
    let boundCount = 0;
    commitProject(
      set,
      get,
      role === "targetOriginal" ? "批量导入原片素材" : "批量导入 B 站参考素材",
      (current) => {
        const result = associateImportedMaterials(
          {
            ...current,
            mediaLibrary: [...current.mediaLibrary, ...importedMedia]
          },
          {
            referenceMediaIds:
              role === "bilibiliReference" ? importedMedia.map((media) => media.id) : []
          }
        );
        boundCount = result.boundCount;
        return nameImportedProject(result.project);
      }
    );
    set({
      status: {
        message: `已导入 ${importedMedia.length} 个${role === "targetOriginal" ? "原片" : "B 站参考"}素材${
          skippedCount > 0 ? `，跳过 ${skippedCount} 个重复路径` : ""
        }。${describeImportedAssociations(boundCount)}`,
        tone: "success"
      }
    });
  },

  importWebDavAudioCache: (draft) => {
    if (
      get().project.mediaLibrary.some(
        (m) =>
          m.localPath?.trim().toLocaleLowerCase() === draft.localPath.trim().toLocaleLowerCase()
      )
    ) {
      set({ status: { message: "该 WebDAV 音轨已经在当前项目中。", tone: "neutral" } });
      return;
    }
    const media = createWebDavAudioCacheMediaReference(createId("media"), draft);
    commitProject(set, get, "导入 WebDAV 原片音轨", (project) => ({
      ...project,
      mediaLibrary: [...project.mediaLibrary, media]
    }));
    set({
      status: {
        message: `已导入 WebDAV 原片音轨：${media.name}。音轨尾部覆盖未证明。`,
        tone: "success"
      }
    });
  },

  importEmbyAudioCache: (draft) => {
    const normalizedPath = draft.localPath.trim().toLocaleLowerCase();
    const existing = get().project.mediaLibrary.find(
      (media) => media.localPath?.trim().toLocaleLowerCase() === normalizedPath
    );
    if (existing) {
      set({
        status: {
          message: `该 Emby 音频已在原片素材中：${existing.name}`,
          tone: "neutral"
        }
      });
      return;
    }
    const media = createEmbyAudioCacheMediaReference(createId("media"), draft);
    commitProject(set, get, "导入 Emby 原片音频", (project) => ({
      ...project,
      mediaLibrary: [...project.mediaLibrary, media]
    }));
    set({
      status: {
        message: `已将 Emby 音轨作为原片素材导入：${media.name}`,
        tone: "success"
      }
    });
  },

  importVideoFile: (file) => {
    get().importMediaFiles([file], "bilibiliReference");
  },

  removeMedia: () => {
    const media = get().project.media;
    if (!media) {
      set({ status: { message: "当前没有可删除的视频。", tone: "warning" } });
      return;
    }
    get().removeMediaReference(media.id);
  },

  removeMediaReference: (mediaId) => {
    const media = findProjectMedia(get().project, mediaId);
    if (!media) {
      set({ status: { message: "媒体素材不存在。", tone: "warning" } });
      return;
    }
    const result = removeMediaReference(get().project, mediaId);
    if (!result.ok) {
      const detail =
        result.usages.length > 0
          ? result.usages
              .slice(0, 3)
              .map((usage) => usage.label)
              .join("；")
          : "未找到可删除的媒体素材。";
      set({ status: { message: `不能删除该素材：${detail}`, tone: "warning" } });
      return;
    }
    revokeObjectUrlIfUnused(get().project, media.objectUrl, media.id);
    commitProject(set, get, "删除媒体素材", () =>
      reconcileMediaMatchCandidates(result.project)
    );
    set({ status: { message: `已删除媒体素材：${media.fileName}`, tone: "success" } });
  },

  reconnectMediaReference: (mediaId, file) => {
    const media = findProjectMedia(get().project, mediaId);
    if (!media) {
      set({ status: { message: "媒体素材不存在。", tone: "warning" } });
      return;
    }
    if (!isSupportedMediaFile(file)) {
      set({ status: { message: "请选择受支持的视频或音频文件重新连接。", tone: "warning" } });
      return;
    }
    const objectUrl = createObjectUrl(file);
    const reconnected = reconnectProjectMediaReference(media, {
      name: file.name.replace(/\.[^.]+$/, ""),
      fileName: file.name,
      objectUrl,
      durationMs: media.durationMs
    });
    revokeObjectUrlIfUnused(get().project, media.objectUrl, media.id);
    commitProject(set, get, "重新连接媒体素材", (project) => ({
      ...project,
      mediaLibrary: project.mediaLibrary.map((candidate) =>
        candidate.id === mediaId ? reconnected : candidate
      ),
      media:
        project.media?.id === mediaId || (media.role === "bilibiliReference" && !project.media)
          ? toLegacyMediaReference(reconnected)
          : project.media,
      mediaBinding:
        project.mediaBinding?.kind === "localFile" && project.mediaBinding.mediaId === mediaId
          ? {
              ...project.mediaBinding,
              displayName: reconnected.name,
              fileName: reconnected.fileName,
              runtimeMs: reconnected.durationMs
            }
          : project.mediaBinding
    }));
    set({ status: { message: `已重新连接媒体素材：${file.name}`, tone: "success" } });
  },

  bindCurrentMediaAsTarget: () => {
    const media = get().project.media;
    if (!media) {
      set({ status: { message: "请先导入参考视频，再绑定为目标原片。", tone: "warning" } });
      return;
    }
    if (!media.objectUrl) {
      set({
        status: { message: "该视频需要重新连接后才能作为本次会话的目标原片。", tone: "warning" }
      });
      return;
    }
    const targetMedia = createBrowserFileMediaReference(createId("media"), "targetOriginal", {
      name: media.name,
      fileName: media.fileName,
      objectUrl: media.objectUrl,
      durationMs: media.durationMs
    });
    const binding = createLocalFileMediaBinding(
      createId("media_binding"),
      toLegacyMediaReference(targetMedia)
    );
    commitProject(set, get, "绑定本地目标原片", (project) => ({
      ...project,
      mediaLibrary: [...project.mediaLibrary, targetMedia],
      mediaBinding: { ...binding, mediaId: targetMedia.id }
    }));
    set({ status: { message: `已绑定目标原片：${binding.displayName}`, tone: "success" } });
  },

  setMediaBinding: (binding) => {
    const mediaId = createBindingMediaId(binding);
    const normalizedBinding =
      binding.kind === "localFile" && binding.mediaId !== mediaId
        ? { ...binding, mediaId }
        : binding;
    const targetMedia = createMediaReferenceFromBinding(mediaId, normalizedBinding);
    commitProject(set, get, "绑定目标原片", (project) => ({
      ...project,
      mediaLibrary: upsertMediaById(project.mediaLibrary, targetMedia),
      mediaBinding: normalizedBinding
    }));
    set({
      status: { message: `已绑定目标原片：${normalizedBinding.displayName}`, tone: "success" }
    });
  },

  clearMediaBinding: () => {
    const binding = get().project.mediaBinding;
    if (!binding) {
      set({ status: { message: "当前没有绑定目标原片。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "解除目标原片绑定", (project) => ({
      ...project,
      mediaBinding: null
    }));
    set({ status: { message: `已解除目标原片绑定：${binding.displayName}`, tone: "success" } });
  },

  bindXmlToSourceMedia: (assetId, sourceMediaId) => {
    const conflictingSegment = get().project.danmakuSourceSegments.find(
      (segment) => segment.assetId === assetId && segment.sourceMediaId !== sourceMediaId
    );
    if (conflictingSegment) {
      set({
        status: {
          message: `不能更换 XML 来源：已有来源段“${conflictingSegment.label}”使用当前参考素材，请先删除或调整该来源段。`,
          tone: "warning"
        }
      });
      return;
    }
    const validationMessage = validateDanmakuSourceBinding(
      get().project,
      assetId,
      sourceMediaId
    );
    if (validationMessage) {
      set({ status: { message: validationMessage, tone: "warning" } });
      return;
    }
    const existing = findDanmakuSourceBinding(get().project.danmakuSourceBindings, assetId);
    const binding = createDanmakuSourceBinding(
      existing?.id ?? createId("danmaku_source_binding"),
      assetId,
      sourceMediaId
    );
    const asset = get().project.assets.find((candidate) => candidate.id === assetId);
    const sourceMedia = findProjectMedia(get().project, sourceMediaId);
    commitProject(set, get, "绑定 XML 来源视频", (project) =>
      reconcileMediaMatchCandidates({
        ...project,
        danmakuSourceBindings: upsertDanmakuSourceBinding(
          project.danmakuSourceBindings,
          binding
        )
      })
    );
    set({
      status: {
        message: `已绑定 XML 来源：${asset?.fileName ?? assetId} -> ${sourceMedia?.fileName ?? sourceMediaId}`,
        tone: "success"
      }
    });
  },

  clearXmlSourceBinding: (assetId) => {
    const binding = findDanmakuSourceBinding(get().project.danmakuSourceBindings, assetId);
    if (!binding) {
      set({ status: { message: "该 XML 尚未绑定 B 站参考素材。", tone: "warning" } });
      return;
    }
    const referencedSegment = get().project.danmakuSourceSegments.find(
      (segment) => segment.assetId === assetId
    );
    if (referencedSegment) {
      set({
        status: {
          message: `不能解除 XML 来源绑定：来源段“${referencedSegment.label}”仍在使用，请先删除该来源段。`,
          tone: "warning"
        }
      });
      return;
    }
    const asset = get().project.assets.find((candidate) => candidate.id === assetId);
    commitProject(set, get, "解除 XML 来源视频绑定", (project) =>
      reconcileMediaMatchCandidates({
        ...project,
        danmakuSourceBindings: removeDanmakuSourceBinding(
          project.danmakuSourceBindings,
          assetId
        )
      })
    );
    set({
      status: { message: `已解除 XML 来源绑定：${asset?.fileName ?? assetId}`, tone: "success" }
    });
  },

  applyMaterialIntakeSuggestions: (plan, suggestionIds) => {
    const result = applyMaterialIntakePlan(get().project, plan, {
      selectedSuggestionIds: suggestionIds
    });
    if (result.appliedSuggestionIds.length === 0) {
      set({
        status: {
          message:
            result.skipped.length > 0
              ? "素材状态已变化，未应用过期建议；请查看最新异常后重试。"
              : "当前没有选中可应用的素材关系建议。",
          tone: "warning"
        }
      });
      return;
    }
    commitProject(set, get, "批量应用素材关系建议", () => nameImportedProject(result.project));
    set({
      status: {
        message: `已一次应用 ${result.appliedSuggestionIds.length} 条 XML 来源关系${
          result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 条已变化建议` : ""
        }；可一次撤销整批操作。`,
        tone: result.skipped.length > 0 ? "warning" : "success"
      }
    });
  },

  bindCurrentTargetToSeasonEpisode: (episodeKey, episodeLabel) => {
    const binding = get().project.mediaBinding;
    if (!binding) {
      set({ status: { message: "请先绑定目标原片，再分配给这一集。", tone: "warning" } });
      return;
    }
    const seasonBinding = {
      id: createId("season_episode_binding"),
      episodeKey,
      episodeLabel,
      targetBinding: structuredClone(binding),
      linkedAt: new Date().toISOString()
    };
    commitProject(set, get, "绑定分集目标原片", (project) => ({
      ...project,
      seasonEpisodeBindings: [
        ...project.seasonEpisodeBindings.filter(
          (candidate) => candidate.episodeKey !== episodeKey
        ),
        seasonBinding
      ]
    }));
    set({ status: { message: `已把当前目标原片绑定到：${episodeLabel}`, tone: "success" } });
  },

  clearSeasonEpisodeBinding: (episodeKey) => {
    const binding = get().project.seasonEpisodeBindings.find(
      (candidate) => candidate.episodeKey === episodeKey
    );
    if (!binding) {
      set({ status: { message: "这一集还没有单独绑定目标原片。", tone: "warning" } });
      return;
    }
    commitProject(set, get, "清除分集目标原片", (project) => ({
      ...project,
      seasonEpisodeBindings: project.seasonEpisodeBindings.filter(
        (candidate) => candidate.episodeKey !== episodeKey
      )
    }));
    set({
      status: { message: `已清除分集目标原片：${binding.episodeLabel}`, tone: "success" }
    });
  },

  addDanmakuSourceSegment: (draft) => {
    try {
      const segment = createDanmakuSourceSegment(createId("danmaku_source_segment"), draft);
      const issues = validateSourceSegmentReferences(get().project, segment);
      const error = issues.find((issue) => issue.severity === "error");
      if (error) {
        throw new Error(error.message);
      }
      commitProject(set, get, "新增弹幕来源内容段", (project) => ({
        ...project,
        danmakuSourceSegments: [...project.danmakuSourceSegments, segment]
      }));
      const warning = issues.find((issue) => issue.severity === "warning");
      set({
        status: {
          message: warning
            ? `已新增弹幕来源内容段：${segment.label}。${warning.message}`
            : `已新增弹幕来源内容段：${segment.label}`,
          tone: warning ? "warning" : "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("弹幕来源内容段无效", error) });
    }
  },

  updateDanmakuSourceSegment: (id, patch) => {
    const segment = get().project.danmakuSourceSegments.find(
      (candidate) => candidate.id === id
    );
    if (!segment) {
      set({ status: { message: "弹幕来源内容段不存在。", tone: "warning" } });
      return;
    }
    try {
      const updatedSegment = updateDanmakuSourceSegment(segment, patch);
      const issues = validateSourceSegmentReferences(get().project, updatedSegment);
      const error = issues.find((issue) => issue.severity === "error");
      if (error) {
        throw new Error(error.message);
      }
      commitProject(set, get, "更新弹幕来源内容段", (project) => ({
        ...project,
        danmakuSourceSegments: project.danmakuSourceSegments.map((candidate) =>
          candidate.id === id ? updatedSegment : candidate
        )
      }));
      const warning = issues.find((issue) => issue.severity === "warning");
      set({
        status: {
          message: warning
            ? `已更新弹幕来源内容段：${updatedSegment.label}。${warning.message}`
            : `已更新弹幕来源内容段：${updatedSegment.label}`,
          tone: warning ? "warning" : "success"
        }
      });
    } catch (error) {
      set({ status: createErrorStatus("弹幕来源内容段更新失败", error) });
    }
  },

  deleteDanmakuSourceSegment: (id) => {
    const segment = get().project.danmakuSourceSegments.find(
      (candidate) => candidate.id === id
    );
    if (!segment) {
      set({ status: { message: "弹幕来源内容段不存在。", tone: "warning" } });
      return;
    }
    if (segment.timeMapId) {
      set({
        status: {
          message: "该来源段属于已确认时间图，不能单独删除；请在匹配页撤销对应关系。",
          tone: "warning"
        }
      });
      return;
    }
    commitProject(set, get, "删除弹幕来源内容段", (project) =>
      reconcileMediaMatchCandidates({
        ...project,
        danmakuSourceSegments: project.danmakuSourceSegments.filter(
          (candidate) => candidate.id !== id
        )
      })
    );
    set({ status: { message: `已删除弹幕来源内容段：${segment.label}`, tone: "success" } });
  },

  updateMediaDuration: (durationMs, mediaId = null) => {
    const normalizedDuration = clampMilliseconds(durationMs);
    set((state) => {
      const localBinding =
        state.project.mediaBinding?.kind === "localFile" ? state.project.mediaBinding : null;
      const fallbackMediaId = state.project.media?.id ?? localBinding?.mediaId ?? null;
      const activeMediaId = mediaId ?? fallbackMediaId;
      if (!activeMediaId) {
        return { project: state.project };
      }
      const legacyMedia = state.project.media;
      const updatesLegacyMedia = legacyMedia?.id === activeMediaId;
      const updatesMediaLibrary = state.project.mediaLibrary.some(
        (media) => media.id === activeMediaId
      );
      const updatesLocalBinding = localBinding?.mediaId === activeMediaId;
      if (!updatesLegacyMedia && !updatesMediaLibrary && !updatesLocalBinding) {
        return { project: state.project };
      }
      return {
        project: touchProject({
          ...state.project,
          media:
            updatesLegacyMedia && legacyMedia
              ? { ...legacyMedia, durationMs: normalizedDuration }
              : legacyMedia,
          mediaLibrary: state.project.mediaLibrary.map((media) =>
            media.id === activeMediaId
              ? updateProjectMediaDuration(media, normalizedDuration)
              : media
          ),
          mediaBinding:
            updatesLocalBinding && localBinding
              ? { ...localBinding, runtimeMs: normalizedDuration }
              : state.project.mediaBinding
        }),
        projectContentRevision: state.projectContentRevision + 1
      };
    });
  },

  openProjectFromText: (text, sourceFileName) => {
    try {
      const result = parseProjectJsonWithMetadata(text);
      applyParsedProject(
        set,
        get,
        result,
        createOpenProjectStatus(result.project.name, result.migration)
      );
    } catch (error) {
      set({
        status: createSourceFileErrorStatus(
          "项目文件打开失败",
          "项目文件打开失败。",
          error,
          sourceFileName
        )
      });
    }
  },

  openProjectFromLibrary: (result, context) => {
    applyParsedProject(set, get, result, createLibraryProjectStatus(result, context));
  },

  removeAsset: (assetId) => {
    const project = get().project;
    const asset = project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      set({ status: { message: "弹幕资源不存在。", tone: "warning" } });
      return;
    }
    const itemIds = new Set(asset.items.map((item) => item.id));
    commitProject(
      set,
      get,
      "删除弹幕资源",
      (currentProject) => {
        const itemTimeAdjustments = Object.fromEntries(
          Object.entries(currentProject.itemTimeAdjustments).filter(
            ([itemId]) => !itemIds.has(itemId)
          )
        );
        return reconcileMediaMatchCandidates({
          ...currentProject,
          assets: currentProject.assets.filter((candidate) => candidate.id !== assetId),
          ...(currentProject.familyArrangement
            ? {
                familyArrangement: {
                  ...currentProject.familyArrangement,
                  rows: currentProject.familyArrangement.rows.filter(
                    (row) => row.assetId !== assetId
                  )
                }
              }
            : {}),
          clips: currentProject.clips.filter((clip) => clip.assetId !== assetId),
          danmakuSourceBindings: currentProject.danmakuSourceBindings.filter(
            (binding) => binding.assetId !== assetId
          ),
          // XML 是来源段的内容所有者；删除 XML 时必须连同这些派生段一起移除。
          // 仅把 assetId 置空会留下仍引用 confirmed TimeMap 的孤儿段，使项目可保存却无法重开。
          danmakuSourceSegments: currentProject.danmakuSourceSegments.filter(
            (segment) => segment.assetId !== assetId
          ),
          disabledItemIds: currentProject.disabledItemIds.filter(
            (itemId) => !itemIds.has(itemId)
          ),
          itemTimeAdjustments
        });
      },
      emptySelection
    );
    set({ status: { message: `已删除弹幕资源：${asset.fileName}`, tone: "success" } });
  }
});

type EditorStoreSet = (
  partial: Partial<EditorStore> | ((state: EditorStore) => Partial<EditorStore>)
) => void;

function applyParsedProject(
  set: EditorStoreSet,
  get: () => EditorStore,
  result: ProjectParseResult,
  status: EditorStore["status"]
): void {
  clearRegisteredManualMediaTimeMapVerificationTrust();
  const parsedProject: EditorProject = {
    ...result.project,
    mediaTimeMaps: result.project.mediaTimeMaps.map((map) =>
      reconcileMediaTimeMapQuality(
        map.verification?.recordVersion === 2
          ? { ...map, quality: { ...map.quality, level: "verified" } }
          : map
      )
    )
  };
  const project = reconcileMediaMatchCandidates(parsedProject, parsedProject.updatedAt);
  const projectEpoch = get().projectEpoch + 1;
  revokeProjectObjectUrls(get().project);
  set({
    project,
    selection: emptySelection,
    history: createHistoryState<EditorProject>(),
    isPlaying: false,
    exportDraft: null,
    alignmentProposal: project.alignmentProposal,
    timelineTool: "select",
    workspaceIntentRequest: null,
    alignmentEditorCandidateId: null,
    importProgress: null,
    projectEpoch,
    status
  });
  void rehydrateProjectManualMediaTimeMapVerifications(project).then((rehydrated) => {
    set((state) => {
      if (state.projectEpoch !== projectEpoch) return {};
      const merged = mergeRehydratedManualVerificationMaps(state.project, project, rehydrated);
      return {
        project: merged.project,
        status:
          merged.restoredCount > 0
            ? {
                message: `已打开项目“${merged.project.name}”，并通过本机签发/撤销注册表恢复 ${merged.restoredCount} 张人工验证时间图。`,
                tone: "success"
              }
            : state.status
      };
    });
  });
}

function createLibraryProjectStatus(
  result: ProjectParseResult,
  context: ProjectLibraryAppliedProjectContext
): EditorStore["status"] {
  const prefix =
    context.reason === "create"
      ? "已创建并保存本机项目"
      : context.reason === "importBackup"
        ? "已从备份导入本机项目"
        : context.reason === "recover"
          ? "已恢复自动保存项目"
          : context.reason === "discardRecovery"
            ? "已放弃恢复内容并打开稳定版本"
            : context.reason === "rollback"
              ? "已追加版本回退"
              : "已从本机项目库打开";
  const migration = result.migration
    ? `；已从 v${result.migration.fromVersion} 升级到 v${result.migration.toVersion}`
    : "";
  return {
    message: `${prefix}：${result.project.name} · 修订 ${context.revision}${migration}`,
    tone: "success"
  };
}
