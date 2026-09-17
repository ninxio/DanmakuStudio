import { isTauri } from "@tauri-apps/api/core";
import { useMemo, useRef, useState } from "react";
import { createId } from "../../domain/project/factory";
import {
  findDanmakuSourceBinding,
  findProjectMedia,
  formatMediaConnectionState,
  formatMediaRole
} from "../../domain/project/mediaLibrary";
import { formatMediaContentKind, isAudioOnlyMedia } from "../../domain/project/mediaFormat";
import { createLocalPathMediaBinding } from "../../domain/project/mediaBinding";
import { createProjectMatchAssessment } from "../../domain/project/matchAssessment";
import { createMaterialIntakePlan } from "../../domain/project/materialIntakePlan";
import type { ProjectMediaReference, ProjectMediaRole } from "../../domain/project/types";
import type { AudioTrackPreparation } from "../../domain/project/audioTrackPreparation";
import { getProjectWorkflowMode } from "../../domain/project/workflowMode";
import { getAssetTimeRange } from "../../domain/timeline/mapping";
import { inspectXmlTimeline } from "../../domain/timeline/xmlTimeline";
import { formatTimecode } from "../../domain/shared/time";
import {
  MEDIA_FILE_EXTENSIONS,
  pickAlignmentMediaPath,
  pickMediaPaths,
  pickXmlPaths
} from "../../infrastructure/file-system/nativeDialogs";
import { authenticateEmby, fetchEmbyItem } from "../../infrastructure/metadata/embyClient";
import { useEditorStore } from "../../stores/editorStore";
import type { MediaInventorySessionRow } from "../../stores/editorStoreTypes";
import {
  createMediaInventorySignature,
  getMediaAudioTrackPreparation
} from "../../stores/slices/mediaInventorySlice";
import {
  createEmbyBindingFromItem,
  loadEmbyConnectionState,
  setStatus,
  validateEmbyConnectionState
} from "./assetPanelSharedLogic";
import { EmbyAudioImportDialog } from "./EmbyAudioImportDialog";
import { BilibiliImportDialog } from "./BilibiliImportDialog";
import {
  openBilibiliAcquisition,
  useBilibiliWorkspaceSession
} from "../../stores/bilibiliAcquisitionStore";
import { MaterialsWorkspacePresentation } from "./MaterialsWorkspacePresentation";
import { MediaFamilyWorkbench } from "./MediaFamilyWorkbench";
import { MotrixSourceDialog } from "./MotrixSourceDialog";
import { WebDavAudioDialog } from "./WebDavAudioDialog";
import { DiscoveryWorkbench } from "./DiscoveryWorkbench";
import type { MotrixPrefill } from "../../application/discoveryPrefill";
import type {
  MediaAudioPreparationViewModel,
  MediaLibraryItemViewModel
} from "./materialsPanelModels";

export function MaterialsWorkspace() {
  const bilibiliOpen = useBilibiliWorkspaceSession((state) => state.open);
  const [targetValidationLoading, setTargetValidationLoading] = useState(false);
  const [reconnectMediaId, setReconnectMediaId] = useState<string | null>(null);
  const [embyAudioImportOpen, setEmbyAudioImportOpen] = useState(false);
  const [motrixOpen, setMotrixOpen] = useState(false);
  const [motrixPrefill, setMotrixPrefill] = useState<MotrixPrefill>();
  const [webdavOpen, setWebdavOpen] = useState(false);
  const targetMediaInputRef = useRef<HTMLInputElement | null>(null);
  const sourceMediaInputRef = useRef<HTMLInputElement | null>(null);
  const reconnectMediaInputRef = useRef<HTMLInputElement | null>(null);
  const xmlInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceContentRef = useRef<HTMLDivElement | null>(null);
  const embyFocusReturnRef = useRef<HTMLElement | null>(null);
  const project = useEditorStore((state) => state.project);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const importProgress = useEditorStore((state) => state.importProgress);
  const importMediaFiles = useEditorStore((state) => state.importMediaFiles);
  const importMediaPaths = useEditorStore((state) => state.importMediaPaths);
  const importEmbyAudioCache = useEditorStore((state) => state.importEmbyAudioCache);
  const importXmlFiles = useEditorStore((state) => state.importXmlFiles);
  const importXmlPaths = useEditorStore((state) => state.importXmlPaths);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const enterXmlEditing = useEditorStore((state) => state.startXmlEditing);
  const removeAsset = useEditorStore((state) => state.removeAsset);
  const removeMediaReference = useEditorStore((state) => state.removeMediaReference);
  const reconnectMediaReference = useEditorStore((state) => state.reconnectMediaReference);
  const setMediaBinding = useEditorStore((state) => state.setMediaBinding);
  const clearMediaBinding = useEditorStore((state) => state.clearMediaBinding);
  const bindXmlToSourceMedia = useEditorStore((state) => state.bindXmlToSourceMedia);
  const clearXmlSourceBinding = useEditorStore((state) => state.clearXmlSourceBinding);
  const applyMaterialIntakeSuggestions = useEditorStore(
    (state) => state.applyMaterialIntakeSuggestions
  );
  const mediaInventoryGenerationKey = useEditorStore(
    (state) => state.mediaInventoryGenerationKey
  );
  const mediaInventoryPhase = useEditorStore((state) => state.mediaInventoryPhase);
  const mediaInventoryRows = useEditorStore((state) => state.mediaInventoryRows);
  const mediaInventoryPaused = useEditorStore((state) => state.mediaInventoryPaused);
  const mediaInventoryCancelling = useEditorStore((state) => state.mediaInventoryCancelling);
  const mediaInventoryRestartRequired = useEditorStore(
    (state) => state.mediaInventoryRestartRequired
  );
  const mediaInventoryTerminalMessage = useEditorStore(
    (state) => state.mediaInventoryTerminalMessage
  );
  const workspaceIntentRequest = useEditorStore((state) => state.workspaceIntentRequest);
  const setMediaAudioTrackIntent = useEditorStore((state) => state.setMediaAudioTrackIntent);
  const refreshMediaInventory = useEditorStore((state) => state.refreshMediaInventory);
  const cancelMediaInventory = useEditorStore((state) => state.cancelMediaInventory);
  const acknowledgeWorkspaceIntent = useEditorStore(
    (state) => state.acknowledgeWorkspaceIntent
  );
  const previewAlignmentProposalData = useEditorStore(
    (state) => state.previewAlignmentProposalData
  );
  const projectMatchAssessment = useMemo(
    () => createProjectMatchAssessment(project),
    [project]
  );
  const materialIntakePlan = useMemo(() => createMaterialIntakePlan(project), [project]);
  const targetOriginalMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "targetOriginal"),
    [project.mediaLibrary]
  );
  const bilibiliReferenceMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "bilibiliReference"),
    [project.mediaLibrary]
  );
  const currentInventoryRows = useMemo(() => {
    const signature = createMediaInventorySignature(project.mediaLibrary);
    return mediaInventoryGenerationKey?.projectId === project.id &&
      mediaInventoryGenerationKey.projectEpoch === projectEpoch &&
      mediaInventoryGenerationKey.mediaSignature === signature
      ? mediaInventoryRows
      : {};
  }, [
    mediaInventoryGenerationKey,
    mediaInventoryRows,
    project.id,
    project.mediaLibrary,
    projectEpoch
  ]);
  const mediaPreparationRows = useMemo(
    () =>
      project.mediaLibrary.map((media) => ({
        media,
        preparation: getMediaAudioTrackPreparation(media, currentInventoryRows[media.id]),
        view: createMediaLibraryItemView(
          media,
          currentInventoryRows[media.id],
          mediaInventoryRestartRequired
        )
      })),
    [currentInventoryRows, mediaInventoryRestartRequired, project.mediaLibrary]
  );
  const audioIssueMediaIds = useMemo(
    () =>
      mediaPreparationRows
        .filter((row) => row.preparation.state !== "ready")
        .map((row) => row.media.id),
    [mediaPreparationRows]
  );
  const xmlMaterialRows = useMemo(
    () =>
      project.assets.map((asset) => {
        const range = getAssetTimeRange(asset);
        const sourceBinding = findDanmakuSourceBinding(project.danmakuSourceBindings, asset.id);
        return {
          assetId: asset.id,
          color: asset.color,
          fileName: asset.fileName,
          itemCount: asset.items.length,
          hasSourceReceipt: Boolean(asset.sourceReceipt),
          sourceMediaId: sourceBinding?.sourceMediaId ?? null,
          sourceMediaFileName: sourceBinding
            ? (findProjectMedia(project, sourceBinding.sourceMediaId)?.fileName ??
              sourceBinding.sourceMediaId)
            : null,
          earliestMs: range.earliestMs,
          latestMs: range.latestMs,
          warningCount: asset.warnings.length
        };
      }),
    [project]
  );
  const alignmentEnabled = getProjectWorkflowMode(project) === "media-alignment";
  const startXmlEditing = () => {
    if (project.assets.length === 0) {
      void openXmlImport();
      return;
    }
    enterXmlEditing();
  };

  const openMediaImport = async (role: ProjectMediaRole) => {
    if (!isTauri()) {
      (role === "targetOriginal" ? targetMediaInputRef : sourceMediaInputRef).current?.click();
      return;
    }
    try {
      const paths = await pickMediaPaths(role);
      if (paths.length > 0) {
        importMediaPaths(paths, role);
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "媒体批量导入失败。",
        tone: "error"
      });
    }
  };
  const openXmlImport = async () => {
    if (!isTauri()) {
      xmlInputRef.current?.click();
      return;
    }
    try {
      const paths = await pickXmlPaths();
      if (paths.length > 0) {
        await importXmlPaths(paths);
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "XML 批量导入失败。",
        tone: "error"
      });
    }
  };
  const bindLocalPathAsTarget = async () => {
    const currentPath =
      project.mediaBinding?.kind === "localFile" ? (project.mediaBinding.localPath ?? "") : "";
    try {
      const path = await pickAlignmentMediaPath(currentPath);
      if (!path) {
        return;
      }
      const binding = createLocalPathMediaBinding(createId("media_binding"), path);
      setMediaBinding(binding);
      setStatus({ message: `已绑定本地目标原片路径：${binding.fileName}`, tone: "success" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "选择本地目标原片失败。",
        tone: "warning"
      });
    }
  };
  const validateEmbyTargetBinding = async () => {
    const binding = project.mediaBinding;
    if (!binding || binding.kind !== "embyItem") {
      setStatus({ message: "当前目标原片不是 Emby 条目。", tone: "warning" });
      return;
    }
    const connection = loadEmbyConnectionState();
    if (!validateEmbyConnectionState(connection)) {
      return;
    }
    setTargetValidationLoading(true);
    try {
      const session = await authenticateEmby(connection.config, {
        username: connection.username,
        password: connection.password
      });
      const item = await fetchEmbyItem(connection.config, session, binding.itemId);
      const updatedBinding = createEmbyBindingFromItem(item, connection);
      setMediaBinding(updatedBinding);
      setStatus({
        message: `已重新确认目标原片：${updatedBinding.displayName}`,
        tone: "success"
      });
    } catch (error) {
      setStatus({
        message: `目标原片需要重新连接：${error instanceof Error ? error.message : "Emby 请求失败。"}`,
        tone: "error"
      });
    } finally {
      setTargetValidationLoading(false);
    }
  };
  const previewProjectMatchProposal = () => {
    if (!projectMatchAssessment.proposal) {
      setStatus({
        message: "先绑定目标原片并导入 XML 后，才能生成匹配评分提案。",
        tone: "warning"
      });
      return;
    }
    previewAlignmentProposalData(projectMatchAssessment.proposal);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DiscoveryWorkbench
        key={`${project.id}:${projectEpoch}`}
        onMotrix={(request) => {
          setMotrixPrefill(request);
          setMotrixOpen(true);
        }}
      />
      <div ref={workspaceContentRef} className="min-h-0 flex-1 overflow-hidden">
        <MaterialsWorkspacePresentation
          familyWorkbench={<MediaFamilyWorkbench />}
          viewModel={{
            summary: {
              originalCount: targetOriginalMedia.length,
              referenceCount: bilibiliReferenceMedia.length,
              xmlCount: xmlMaterialRows.length,
              unplacedXmlCount: inspectXmlTimeline(project).unplacedAssets.length,
              hasTimeline: project.clips.length > 0,
              unboundXmlCount: xmlMaterialRows.filter((asset) => asset.sourceMediaId === null)
                .length,
              reconnectCount: project.mediaLibrary.filter(
                (media) => media.connectionState === "needsReconnect"
              ).length,
              audioIssueCount: alignmentEnabled ? audioIssueMediaIds.length : 0,
              firstAudioIssueMediaId: alignmentEnabled ? (audioIssueMediaIds[0] ?? null) : null,
              audioBusy:
                alignmentEnabled &&
                (mediaInventoryPhase === "queued" || mediaInventoryPhase === "running"),
              audioPaused: mediaInventoryPaused,
              audioCancelling: mediaInventoryCancelling,
              audioRestartRequired: mediaInventoryRestartRequired,
              audioTerminalMessage: mediaInventoryTerminalMessage,
              workspaceIntentRequest
            },
            workflow: {
              alignmentEnabled
            },
            mediaGroups: {
              targetOriginal: mediaPreparationRows
                .filter((row) => row.media.role === "targetOriginal")
                .map((row) => row.view),
              bilibiliReference: mediaPreparationRows
                .filter((row) => row.media.role === "bilibiliReference")
                .map((row) => row.view)
            },
            xmlMaterials: {
              importProgress,
              sourceOptions: bilibiliReferenceMedia.map((media) => ({
                id: media.id,
                name: media.name
              })),
              assetRows: xmlMaterialRows
            },
            intakePlan: {
              visible: project.assets.length > 0,
              suggestions: materialIntakePlan.suggestions.map((suggestion) => ({
                id: suggestion.id,
                assetId: suggestion.assetId,
                assetFileName: suggestion.assetFileName,
                sourceMediaFileName: suggestion.sourceMediaFileName,
                targetMediaFileName: suggestion.targetMediaFileName,
                episodeLabel: suggestion.episodeLabel,
                reason: suggestion.evidence.map((evidence) => evidence.message).join(" ")
              })),
              exceptions: {
                conflicts: materialIntakePlan.conflicts.map((conflict) => ({
                  id: conflict.id,
                  assetId: conflict.assetId,
                  assetFileName: conflict.assetFileName,
                  episodeLabel: conflict.episodeLabel,
                  message: conflict.message,
                  candidateFileNames: conflict.candidateSourceFileNames
                })),
                unresolved: materialIntakePlan.unresolved.map((unresolved) => ({
                  id: unresolved.id,
                  assetId: unresolved.assetId,
                  assetFileName: unresolved.assetFileName,
                  episodeLabel: unresolved.episodeLabel,
                  message: unresolved.message,
                  candidateFileNames: []
                }))
              },
              preservedCount: materialIntakePlan.preservedBindings.length
            },
            legacyCompatibility: {
              binding: project.mediaBinding,
              media: project.media,
              mediaLibrary: project.mediaLibrary,
              assessment: projectMatchAssessment,
              validatingTarget: targetValidationLoading
            }
          }}
          onIntent={(intent) => {
            switch (intent.area) {
              case "audio":
                if (intent.action === "setIntent") {
                  setMediaAudioTrackIntent(intent.mediaId, intent.intent);
                } else if (intent.action === "cancel") {
                  cancelMediaInventory();
                } else if (intent.action === "focusHandled") {
                  acknowledgeWorkspaceIntent(intent.sequence);
                } else {
                  refreshMediaInventory();
                }
                return;
              case "intakePlan":
                applyMaterialIntakeSuggestions(materialIntakePlan, intent.suggestionIds);
                return;
              case "navigation":
                if (intent.action === "continueToMatching") {
                  setWorkspacePage("matching");
                } else {
                  startXmlEditing();
                }
                return;
              case "media":
                switch (intent.action) {
                  case "requestImport":
                    void openMediaImport(intent.role);
                    return;
                  case "importFiles":
                    importMediaFiles(intent.files, intent.role);
                    return;
                  case "requestEmbyAudio": {
                    const activeElement =
                      workspaceContentRef.current?.ownerDocument.activeElement;
                    embyFocusReturnRef.current =
                      activeElement instanceof HTMLElement ? activeElement : null;
                    setEmbyAudioImportOpen(true);
                    return;
                  }
                  case "requestBilibili":
                    openBilibiliAcquisition();
                    return;
                  case "requestMotrix":
                    setMotrixOpen(true);
                    return;
                  case "requestWebDav":
                    setWebdavOpen(true);
                    return;
                  case "requestReconnect":
                    setReconnectMediaId(intent.mediaId);
                    reconnectMediaInputRef.current?.click();
                    return;
                  case "remove":
                    removeMediaReference(intent.mediaId);
                }
                return;
              case "xml":
                switch (intent.action) {
                  case "requestImport":
                    void openXmlImport();
                    return;
                  case "importFiles":
                    void importXmlFiles(intent.files);
                    return;
                  case "changeSource":
                    if (intent.sourceMediaId) {
                      bindXmlToSourceMedia(intent.assetId, intent.sourceMediaId);
                    } else {
                      clearXmlSourceBinding(intent.assetId);
                    }
                    return;
                  case "remove":
                    removeAsset(intent.assetId);
                }
                return;
              case "compatibility":
                switch (intent.action) {
                  case "bindLocalTarget":
                    void bindLocalPathAsTarget();
                    return;
                  case "validateEmbyTarget":
                    void validateEmbyTargetBinding();
                    return;
                  case "clearTargetBinding":
                    clearMediaBinding();
                    return;
                  case "previewMatch":
                    previewProjectMatchProposal();
                }
            }
          }}
        />
        {bilibiliOpen ? <BilibiliImportDialog /> : null}
        <WebDavAudioDialog
          open={webdavOpen}
          onClose={() => setWebdavOpen(false)}
          onImport={(draft) => {
            const current = useEditorStore.getState();
            if (
              current.project.id !== project.id ||
              current.projectEpoch !== projectEpoch ||
              current.projectLibrary.switchingProject
            ) {
              throw new Error("项目已切换，请在当前项目重新选择导入。");
            }
            current.importWebDavAudioCache(draft);
          }}
        />
        <MotrixSourceDialog
          key={`${project.id}:${projectEpoch}`}
          open={motrixOpen}
          projectId={project.id}
          projectEpoch={projectEpoch}
          prefill={motrixPrefill}
          onClose={() => setMotrixOpen(false)}
          onImport={(paths) => {
            const current = useEditorStore.getState();
            if (
              current.project.id !== project.id ||
              current.projectEpoch !== projectEpoch ||
              current.projectLibrary.switchingProject
            ) {
              throw new Error("项目已切换，请在当前项目重新选择导入。");
            }
            const before = current.project.mediaLibrary.length;
            importMediaPaths(paths, "targetOriginal");
            return Math.max(0, useEditorStore.getState().project.mediaLibrary.length - before);
          }}
        />
        {embyAudioImportOpen ? (
          <EmbyAudioImportDialog
            onClose={() => setEmbyAudioImportOpen(false)}
            returnFocusRef={embyFocusReturnRef}
            onImport={(draft) => {
              importEmbyAudioCache(draft);
              setEmbyAudioImportOpen(false);
            }}
          />
        ) : null}
        <input
          ref={xmlInputRef}
          className="hidden"
          type="file"
          accept=".xml,text/xml,application/xml"
          multiple
          data-testid="xml-input"
          aria-label="导入弹幕 XML 文件"
          onChange={(event) => {
            if (event.target.files) {
              void importXmlFiles(event.target.files);
            }
            event.target.value = "";
          }}
        />
        <input
          ref={targetMediaInputRef}
          className="hidden"
          type="file"
          accept={MEDIA_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
          multiple
          aria-label="导入原片素材文件"
          onChange={(event) => {
            if (event.target.files) {
              importMediaFiles(event.target.files, "targetOriginal");
            }
            event.target.value = "";
          }}
        />
        <input
          ref={sourceMediaInputRef}
          className="hidden"
          type="file"
          accept={MEDIA_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
          multiple
          aria-label="导入 B 站参考素材文件"
          onChange={(event) => {
            if (event.target.files) {
              importMediaFiles(event.target.files, "bilibiliReference");
            }
            event.target.value = "";
          }}
        />
        <input
          ref={reconnectMediaInputRef}
          className="hidden"
          type="file"
          accept={MEDIA_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
          aria-label="重新连接媒体素材文件"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file && reconnectMediaId) {
              reconnectMediaReference(reconnectMediaId, file);
            }
            setReconnectMediaId(null);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

function createMediaLibraryItemView(
  media: ProjectMediaReference,
  inventoryRow: MediaInventorySessionRow | undefined,
  restartRequired: boolean
): MediaLibraryItemViewModel {
  const durationText =
    media.durationMs === null ? "时长将在分析时读取" : formatTimecode(media.durationMs);
  return {
    id: media.id,
    name: media.name,
    fileName: media.fileName,
    audioOnly: isAudioOnlyMedia(media.fileName),
    connectionText: formatMediaConnectionState(media),
    durationText,
    reconnectWarning:
      media.connectionState === "needsReconnect"
        ? "此素材使用的是临时浏览器引用，重新打开项目后需要重新选择原文件。项目中的绑定和时间段信息仍然保留。自动匹配需要桌面端持久本地路径；请删除此临时引用后，使用本区的批量导入按钮重新加入。"
        : null,
    canReconnect:
      media.connectionState === "needsReconnect" || media.referenceKind === "browserFile",
    details: {
      role: formatMediaRole(media.role),
      content: formatMediaContentKind(media.fileName),
      duration: media.durationMs === null ? "时长未知" : formatTimecode(media.durationMs),
      source: media.sourceSummary,
      reference: formatProjectMediaReferenceKind(media)
    },
    audioPreparation: createAudioPreparationView(
      inventoryRow,
      getMediaAudioTrackPreparation(media, inventoryRow),
      restartRequired
    )
  };
}

function createAudioPreparationView(
  inventoryRow: MediaInventorySessionRow | undefined,
  preparation: AudioTrackPreparation,
  restartRequired: boolean
): MediaAudioPreparationViewModel {
  if (restartRequired) {
    return {
      statusText: "需重启应用",
      detailText: "进程清理状态不确定，重启后继续",
      tone: "error",
      selectionValue: "",
      selectionPlaceholder: "重启应用后重新读取音轨",
      selectionOptions: [],
      canSelect: false
    };
  }
  const readyRow = inventoryRow?.status === "ready" ? inventoryRow : null;
  const status = formatAudioPreparationStatus(preparation, readyRow?.probeCompleteness);
  const selectionOptions: Array<{ value: string; label: string }> = [];
  if (readyRow?.recommendation.state === "recommended") {
    selectionOptions.push({ value: "auto", label: "使用自动推荐" });
  }
  readyRow?.audioTracks.forEach((track) => {
    selectionOptions.push({
      value: `explicit:${track.index}`,
      label: formatAudioTrackOption(track)
    });
  });
  return {
    ...status,
    selectionValue:
      preparation.state === "ready"
        ? preparation.source === "auto"
          ? "auto"
          : `explicit:${preparation.finalStreamIndex}`
        : "",
    selectionPlaceholder: preparation.state === "needsReview" ? "请重新确认音轨" : "请选择音轨",
    selectionOptions,
    canSelect: Boolean(readyRow && readyRow.audioTracks.length > 0)
  };
}

function formatProjectMediaReferenceKind(media: ProjectMediaReference): string {
  if (media.referenceKind === "localPath") {
    return media.localPath ? `本地路径：${media.localPath}` : "本地路径待补齐";
  }
  if (media.referenceKind === "embyItem") {
    return media.emby ? `Emby：${media.emby.itemName}` : "Emby 摘要";
  }
  return media.objectUrl ? "临时浏览器引用，保存后需重连" : "临时浏览器引用，当前需要重连";
}

function formatAudioPreparationStatus(
  preparation: AudioTrackPreparation,
  completeness: "complete" | "partial" | "fallbackRequired" | undefined
): Pick<MediaAudioPreparationViewModel, "statusText" | "detailText" | "tone"> {
  switch (preparation.state) {
    case "ready":
      return {
        statusText:
          preparation.source === "auto"
            ? `自动推荐音轨 #${preparation.finalStreamIndex}`
            : `已选择音轨 #${preparation.finalStreamIndex}`,
        detailText:
          completeness === "fallbackRequired"
            ? "标准元数据回退已完成，可直接匹配"
            : "音轨清单已就绪，可直接匹配",
        tone: "success"
      };
    case "preparing":
      return {
        statusText:
          preparation.phase === "probing"
            ? "正在读取音轨"
            : preparation.phase === "queued"
              ? "音轨准备排队中"
              : "等待准备音轨",
        detailText: "后台会渐进更新，不必逐个检查",
        tone: "neutral"
      };
    case "needsChoice":
      return {
        statusText: "需要选择音轨",
        detailText:
          preparation.reason === "metadataPartial"
            ? "元数据不完整，请从真实音轨中明确选择"
            : "没有唯一强推荐，请选择实际用于匹配的音轨",
        tone: "warning"
      };
    case "needsReview":
      return {
        statusText: "需要复核音轨",
        detailText:
          preparation.reason === "inventoryRevisionChanged"
            ? "媒体清单已变化，旧选择不会静默回退"
            : "原选择的音轨已不存在，请重新确认",
        tone: "warning"
      };
    case "notEligible":
      return {
        statusText: "重新连接后才能准备音轨",
        detailText:
          preparation.reason === "needsReconnect"
            ? "项目只保存了临时引用"
            : "浏览器素材没有可供桌面任务读取的本地路径",
        tone: "warning"
      };
    case "unavailable":
      return {
        statusText: "没有可用音轨",
        detailText: "清单未发现音频流，不能用于音频匹配",
        tone: "error"
      };
    case "failed":
      return {
        statusText: "音轨准备失败",
        detailText: preparation.message,
        tone: "error"
      };
    case "cancelled":
      return {
        statusText: "音轨准备已取消",
        detailText: "可从素材摘要重新准备",
        tone: "warning"
      };
  }
}

function formatAudioTrackOption(
  track: Extract<MediaInventorySessionRow, { status: "ready" }>["audioTracks"][number]
): string {
  const basics = [
    `#${track.index}`,
    track.language || "语言未知",
    track.codec?.toUpperCase() || "编码未知",
    track.channels === null ? "声道未知" : `${track.channels} 声道`,
    track.title
  ].filter((value): value is string => Boolean(value));
  const special: string[] = [];
  if (track.dispositions.commentary) special.push("评论音轨");
  if (track.dispositions.descriptions) special.push("解说音轨");
  if (track.dispositions.visualImpaired) special.push("视障辅助");
  if (track.dispositions.hearingImpaired) special.push("听障辅助");
  if (track.dispositions.cleanEffects) special.push("纯效果声");
  if (track.dispositions.karaoke) special.push("卡拉 OK");
  if (track.reasonCodes.includes("auxiliaryDisposition")) special.push("辅助音轨");
  return `${basics.join(" · ")}${special.length > 0 ? `（${special.join("、")}）` : ""}`;
}
