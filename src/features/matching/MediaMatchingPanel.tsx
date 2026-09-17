import { VisualAapMatchingPanel } from "./VisualAapMatchingPanel";
import { ToolSheet } from "../../components/ToolSheet";
import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { ArrowRight, CircleAlert, RefreshCw, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import type { MediaInventoryGenerationKey } from "../../application/mediaInventorySupervisor";
import {
  matchingLiveRunChannel,
  toMatchingLiveRunSnapshot,
  type MatchingLiveRun,
  type MatchingLiveRunSnapshot
} from "../../application/backgroundTasks/matchingTaskChannel";
import { augmentAlignmentProposalWithDanmakuEvidence } from "../../domain/alignment/danmakuEvidence";
import { createMediaMatchCandidate } from "../../domain/alignment/mediaMatching";
import { createSmartBatchPairingPlan } from "../../domain/alignment/smartBatchPairing";
import { resolveProjectEpisodeEvidence } from "../../domain/project/mediaEpisodeEvidence";
import { MatchingEpisodeSuggestions } from "./MatchingEpisodeSuggestions";
import {
  beginAlignmentExperimentAttempt,
  createAlignmentExperimentQueue,
  finishAlignmentExperimentAttempt,
  interruptAlignmentExperimentQueue,
  MAX_ALIGNMENT_EXPERIMENT_PAIRS,
  type AlignmentExperimentQueue
} from "../../domain/alignment/alignmentExperimentQueue";
import { validateTimeMap } from "../../domain/alignment/timeMap";
import { isTimeMapManualTakeoverExportApproved } from "../../domain/alignment/timeMapReviewDecision";
import type { SpectralBackendPreference } from "../../domain/alignment/spectralBackendPreference";
import type { SuspectedCutCandidate } from "../../domain/danmaku/cutHints";
import { statusLabel } from "../../domain/shared/statusVocabulary";
import type { AudioTrackPreparation } from "../../domain/project/audioTrackPreparation";
import { createId } from "../../domain/project/factory";
import { findProjectMedia } from "../../domain/project/mediaLibrary";
import type {
  EditorProject,
  MediaMatchCandidate,
  MediaTimeMap,
  MediaTimeMapState,
  MediaTimeMapStreamIdentity,
  ProjectMediaReference
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  clearDesktopAlignmentExperimentQueue,
  hydrateDesktopAlignmentExperimentQueue,
  loadAlignmentExperimentQueue,
  persistDesktopAlignmentExperimentQueue
} from "../../infrastructure/alignment/alignmentExperimentQueueStore";
import {
  cancelTauriAudioAlignmentBatchJob,
  getTauriAudioAlignmentBatchJob,
  isAudioAlignmentJobFinished,
  openAudioAlignmentDiagnosticLogDirectory,
  openAudioAlignmentSensitiveManifestDirectory,
  startTauriAudioAlignmentBatchJob,
  type AudioAlignmentBatchJobSnapshot
} from "../../infrastructure/alignment/tauriAudioAlignment";
import {
  APP_SETTINGS_CHANGED,
  loadAppSettings
} from "../../infrastructure/settings/appSettings";
import { persistDesktopAppSettings } from "../../infrastructure/settings/desktopAppSettings";
import { resolveMatchingDefaults } from "../../application/matchingDefaults";
import { useEditorStore } from "../../stores/editorStore";
import { MediaChoiceList } from "./MatchingTaskPanels";
import {
  createMediaInventorySignature,
  getMediaAudioTrackPreparation
} from "../../stores/slices/mediaInventorySlice";
import {
  batchTaskPatchFromPairSnapshot,
  describeNativeFineDisposition
} from "./matchingBatchResult";
import {
  alignmentExperimentQueueToBatchTasks,
  buildMatchingExperimentQueueConfig,
  createAlignmentExperimentFinishResults,
  queueMatchesConfig
} from "./matchingExperimentQueue";
import {
  buildMatchingRunConsoleModel,
  canAnalyzeMedia,
  type BatchTask,
  type MatchingAudioPreparationView,
  type MatchingRunPrimaryAction,
  type MatchingRunResult
} from "./matchingTaskModels";
import { MatchingRunConsolePresentation } from "./MatchingRunConsolePresentation";

type PairingScope = "smart" | "all";

function createLiveMatchingRunKey(projectId: string, projectEpoch: number): string {
  return `${projectId}\u0000${projectEpoch}`;
}

function publishLiveMatchingRun(key: string, run: MatchingLiveRun): void {
  matchingLiveRunChannel.publish(key, { ...run, updatedAtMs: Date.now() });
}

function updateLiveMatchingRunTasks(
  key: string,
  updater: (tasks: BatchTask[]) => BatchTask[]
): boolean {
  return matchingLiveRunChannel.update(key, (run) => ({
    ...run,
    tasks: updater(run.tasks),
    updatedAtMs: Date.now()
  }));
}

function finishLiveMatchingRun(key: string): boolean {
  const run = matchingLiveRunChannel.read(key);
  if (!run) return false;
  return matchingLiveRunChannel.finish(key, {
    ...run,
    running: false,
    updatedAtMs: Date.now()
  });
}

function subscribeToLiveMatchingRun(
  key: string,
  listener: (snapshot: MatchingLiveRunSnapshot) => void
): () => void {
  return matchingLiveRunChannel.subscribe(key, (run) =>
    listener(toMatchingLiveRunSnapshot(run))
  );
}

export function MediaMatchingPanel(props: {
  project: EditorProject;
  suspectedCutCandidates: SuspectedCutCandidate[];
}) {
  const [algorithm, setAlgorithm] = useState<"audio" | "visual-aap">("audio");
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid gap-4">
      <label className="flex items-center gap-3 text-sm">
        匹配方式
        <select
          aria-label="匹配方式"
          value={algorithm}
          disabled={busy}
          onChange={(event) =>
            setAlgorithm(event.target.value === "visual-aap" ? "visual-aap" : "audio")
          }
          className="rounded border border-panel-line bg-surface-inset p-2"
        >
          <option value="audio">音频匹配</option>
          <option value="visual-aap">画面匹配 AAP（无需音轨）</option>
        </select>
      </label>
      {algorithm === "visual-aap" ? (
        <VisualAapMatchingPanel project={props.project} onBusyChange={setBusy} />
      ) : (
        <AudioMatchingPanel {...props} onBusyChange={setBusy} />
      )}
    </div>
  );
}

function AudioMatchingPanel({
  project,
  suspectedCutCandidates,
  onBusyChange
}: {
  project: EditorProject;
  suspectedCutCandidates: SuspectedCutCandidate[];
  onBusyChange: (busy: boolean) => void;
}) {
  const sourceMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "bilibiliReference"),
    [project.mediaLibrary]
  );
  const targetMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "targetOriginal"),
    [project.mediaLibrary]
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([]);
  const [spectralBackendPreference, setSpectralBackendPreference] =
    useState<SpectralBackendPreference>(() => loadAppSettings().alignment.spectralBackend);
  const [treatSelectedSourcesAsVersions, setTreatSelectedSourcesAsVersions] = useState(false);
  const [treatSelectedTargetsAsVersions, setTreatSelectedTargetsAsVersions] = useState(false);
  const [pairingScope, setPairingScope] = useState<PairingScope>("smart");
  const [episodeHintDraft, setEpisodeHintDraft] = useState({ mediaId: "", text: "" });
  const setReferenceEpisodeHint = useEditorStore((state) => state.setReferenceEpisodeHint);
  const [tasks, setTasks] = useState<BatchTask[]>([]);
  const [experimentQueue, setExperimentQueue] = useState<AlignmentExperimentQueue | null>(null);
  const [queuePersistenceWarning, setQueuePersistenceWarning] = useState<string | null>(null);
  const [batchStartError, setBatchStartError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    onBusyChange(running);
  }, [running, onBusyChange]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const activeJobRef = useRef<{ runToken: number; jobId: string } | null>(null);
  const experimentQueueRef = useRef<AlignmentExperimentQueue | null>(null);
  useEffect(() => {
    const sync = () => {
      if (!running && experimentQueueRef.current?.state !== "interrupted")
        setSpectralBackendPreference(loadAppSettings().alignment.spectralBackend);
    };
    window.addEventListener(APP_SETTINGS_CHANGED, sync);
    return () => window.removeEventListener(APP_SETTINGS_CHANGED, sync);
  }, [running]);
  const cancelRequestedRef = useRef(false);
  const initializedProjectIdRef = useRef<string | null>(null);
  const sourceSelectionTouchedRef = useRef(false);
  const targetSelectionTouchedRef = useRef(false);
  const addCandidate = useEditorStore((state) => state.addMediaMatchCandidate);
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  const requestWorkspaceIntent = useEditorStore((state) => state.requestWorkspaceIntent);
  const projectEpoch = useEditorStore((state) => state.projectEpoch);
  const mediaInventoryGenerationKey = useEditorStore(
    (state) => state.mediaInventoryGenerationKey
  );
  const mediaInventoryRows = useEditorStore((state) => state.mediaInventoryRows);
  const mediaInventoryRestartRequired = useEditorStore(
    (state) => state.mediaInventoryRestartRequired
  );
  const mediaInventoryTerminalMessage = useEditorStore(
    (state) => state.mediaInventoryTerminalMessage
  );
  const liveRunKey = createLiveMatchingRunKey(project.id, projectEpoch);
  const projectEpochRef = useRef(projectEpoch);
  const batchTokenRef = useRef(0);

  const updateVisibleTasks = useCallback(
    (updater: (current: BatchTask[]) => BatchTask[]) => {
      const liveRun = matchingLiveRunChannel.read(liveRunKey);
      if (liveRun) {
        const nextTasks = updater(liveRun.tasks);
        publishLiveMatchingRun(liveRunKey, { ...liveRun, tasks: nextTasks });
        setTasks(nextTasks);
      } else {
        setTasks(updater);
      }
    },
    [liveRunKey]
  );
  const finishVisibleRun = useCallback(() => {
    finishLiveMatchingRun(liveRunKey);
  }, [liveRunKey]);

  const persistExperimentQueue = (queue: AlignmentExperimentQueue | null) => {
    experimentQueueRef.current = queue;
    setExperimentQueue(queue);
    if (queue) {
      void persistDesktopAlignmentExperimentQueue(queue)
        .then(() => setQueuePersistenceWarning(null))
        .catch((error: unknown) =>
          setQueuePersistenceWarning(`桌面任务记录写入失败：${formatUnknownError(error)}`)
        );
    }
  };

  const applyRecoveredExperimentQueue = useCallback(
    (queue: AlignmentExperimentQueue | null) => {
      experimentQueueRef.current = queue;
      setExperimentQueue(queue);
      if (!queue) {
        setTasks([]);
        return;
      }
      setSelectedSourceIds(
        queue.config.sourceMediaIds.filter((id) =>
          sourceMedia.some((media) => media.id === id && canAnalyzeMedia(media))
        )
      );
      setSelectedTargetIds(
        queue.config.targetMediaIds.filter((id) =>
          targetMedia.some((media) => media.id === id && canAnalyzeMedia(media))
        )
      );
      setSpectralBackendPreference(queue.config.spectralBackend);
      setTasks(alignmentExperimentQueueToBatchTasks(queue));
    },
    [sourceMedia, targetMedia]
  );

  const hydrateExperimentQueueFromDesktop = useCallback(
    (projectId: string) => {
      void hydrateDesktopAlignmentExperimentQueue(projectId)
        .then((durableQueue) => {
          if (useEditorStore.getState().project.id !== projectId) return;
          const current = experimentQueueRef.current;
          if (current && (!durableQueue || current.updatedAtMs > durableQueue.updatedAtMs))
            return;
          const activeRun = matchingLiveRunChannel.read(
            createLiveMatchingRunKey(projectId, useEditorStore.getState().projectEpoch)
          );
          if (activeRun) {
            experimentQueueRef.current = durableQueue;
            setExperimentQueue(durableQueue);
            setQueuePersistenceWarning(null);
            return;
          }
          applyRecoveredExperimentQueue(durableQueue);
          setQueuePersistenceWarning(null);
        })
        .catch((error: unknown) =>
          setQueuePersistenceWarning(`桌面任务记录读取失败：${formatUnknownError(error)}`)
        );
    },
    [applyRecoveredExperimentQueue]
  );

  useEffect(() => {
    if (initializedProjectIdRef.current === project.id) {
      setSelectedSourceIds((current) => {
        if (!sourceSelectionTouchedRef.current) {
          return sourceMedia.filter(canAnalyzeMedia).map((media) => media.id);
        }
        return current.filter((id) => sourceMedia.some((media) => media.id === id));
      });
      setSelectedTargetIds((current) => {
        if (!targetSelectionTouchedRef.current) {
          return targetMedia.filter(canAnalyzeMedia).map((media) => media.id);
        }
        return current.filter((id) => targetMedia.some((media) => media.id === id));
      });
      return;
    }
    initializedProjectIdRef.current = project.id;
    setBatchStartError(null);
    sourceSelectionTouchedRef.current = false;
    targetSelectionTouchedRef.current = false;
    setSelectedSourceIds(sourceMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setSelectedTargetIds(targetMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setTreatSelectedSourcesAsVersions(false);
    setTreatSelectedTargetsAsVersions(false);
    setPairingScope("smart");
    setEpisodeHintDraft({ mediaId: "", text: "" });
    const recoveredQueue = loadAlignmentExperimentQueue(project.id);
    applyRecoveredExperimentQueue(recoveredQueue);
    hydrateExperimentQueueFromDesktop(project.id);
  }, [
    applyRecoveredExperimentQueue,
    hydrateExperimentQueueFromDesktop,
    project.id,
    sourceMedia,
    targetMedia
  ]);

  useEffect(
    () =>
      subscribeToLiveMatchingRun(liveRunKey, (snapshot) => {
        setTasks(snapshot.tasks);
        setRunning(snapshot.running);
        setSelectedSourceIds(snapshot.selectedSourceIds);
        setSelectedTargetIds(snapshot.selectedTargetIds);
      }),
    [liveRunKey]
  );

  useEffect(() => {
    if (selectedSourceIds.length < 2) setTreatSelectedSourcesAsVersions(false);
  }, [selectedSourceIds.length]);

  useEffect(() => {
    if (selectedTargetIds.length < 2) setTreatSelectedTargetsAsVersions(false);
  }, [selectedTargetIds.length]);

  useEffect(() => {
    if (projectEpochRef.current === projectEpoch) {
      return;
    }
    const previousProjectEpoch = projectEpochRef.current;
    projectEpochRef.current = projectEpoch;
    finishLiveMatchingRun(createLiveMatchingRunKey(project.id, previousProjectEpoch));
    batchTokenRef.current += 1;
    cancelRequestedRef.current = true;
    const activeJob = activeJobRef.current;
    if (activeJob) {
      void cancelTauriAudioAlignmentBatchJob(activeJob.jobId)
        .then((snapshot) => {
          if (
            isAudioAlignmentJobFinished(snapshot.status) &&
            activeJobRef.current?.jobId === activeJob.jobId
          ) {
            activeJobRef.current = null;
          }
        })
        .catch(() => undefined);
    }
    sourceSelectionTouchedRef.current = false;
    targetSelectionTouchedRef.current = false;
    setSelectedSourceIds(sourceMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setSelectedTargetIds(targetMedia.filter(canAnalyzeMedia).map((media) => media.id));
    setTreatSelectedSourcesAsVersions(false);
    setTreatSelectedTargetsAsVersions(false);
    setPairingScope("smart");
    setRunning(false);
    const recoveredQueue = loadAlignmentExperimentQueue(project.id);
    applyRecoveredExperimentQueue(recoveredQueue);
    hydrateExperimentQueueFromDesktop(project.id);
  }, [
    applyRecoveredExperimentQueue,
    hydrateExperimentQueueFromDesktop,
    project.id,
    projectEpoch,
    sourceMedia,
    targetMedia
  ]);

  const selectedSourcesForPlanning = useMemo(
    () =>
      selectedSourceIds
        .map((id) => sourceMedia.find((media) => media.id === id))
        .filter((media): media is ProjectMediaReference => Boolean(media)),
    [selectedSourceIds, sourceMedia]
  );
  const selectedTargetsForPlanning = useMemo(
    () =>
      selectedTargetIds
        .map((id) => targetMedia.find((media) => media.id === id))
        .filter((media): media is ProjectMediaReference => Boolean(media)),
    [selectedTargetIds, targetMedia]
  );
  const currentInventoryRows = useMemo(() => {
    const mediaSignature = createMediaInventorySignature(project.mediaLibrary);
    return mediaInventoryGenerationKey?.projectId === project.id &&
      mediaInventoryGenerationKey.projectEpoch === projectEpoch &&
      mediaInventoryGenerationKey.mediaSignature === mediaSignature
      ? mediaInventoryRows
      : {};
  }, [
    mediaInventoryGenerationKey,
    mediaInventoryRows,
    project.id,
    project.mediaLibrary,
    projectEpoch
  ]);
  const audioPreparations = useMemo<Record<string, MatchingAudioPreparationView>>(
    () =>
      Object.fromEntries(
        project.mediaLibrary.map((media) => [
          media.id,
          describeAudioTrackPreparation(
            getMediaAudioTrackPreparation(media, currentInventoryRows[media.id])
          )
        ])
      ),
    [currentInventoryRows, project.mediaLibrary]
  );
  const selectedAudioBlockers = useMemo(
    () =>
      [...selectedSourcesForPlanning, ...selectedTargetsForPlanning].filter(
        (media) => !audioPreparations[media.id]?.ready
      ),
    [audioPreparations, selectedSourcesForPlanning, selectedTargetsForPlanning]
  );
  const runConsoleSources = sourceSelectionTouchedRef.current
    ? selectedSourcesForPlanning
    : sourceMedia;
  const runConsoleTargets = targetSelectionTouchedRef.current
    ? selectedTargetsForPlanning
    : targetMedia;
  const runConsoleAudioBlockers = [...runConsoleSources, ...runConsoleTargets].filter(
    (media) => !audioPreparations[media.id]?.ready
  );
  const episodeEvidence = useMemo(
    () =>
      resolveProjectEpisodeEvidence({
        assets: project.assets,
        mediaLibrary: project.mediaLibrary,
        danmakuSourceBindings: project.danmakuSourceBindings
      }),
    [project.assets, project.mediaLibrary, project.danmakuSourceBindings]
  );
  const smartPairingPlan = useMemo(
    () =>
      createSmartBatchPairingPlan(
        selectedSourcesForPlanning,
        selectedTargetsForPlanning,
        episodeEvidence
      ),
    [selectedSourcesForPlanning, selectedTargetsForPlanning, episodeEvidence]
  );
  const pairCount =
    pairingScope === "smart"
      ? smartPairingPlan.pairs.length
      : selectedSourceIds.length * selectedTargetIds.length;
  const matchingRunResults = useMemo<MatchingRunResult[]>(() => {
    const confirmedMapsById = new Map(
      project.mediaTimeMaps
        .filter((timeMap) => timeMap.state === "confirmed")
        .map((timeMap) => [timeMap.id, timeMap])
    );
    return project.mediaMatchCandidates
      .filter((candidate) => candidate.state !== "rejected")
      .map((candidate) => {
        const pointedConfirmedMap = candidate.confirmedTimeMapId
          ? (confirmedMapsById.get(candidate.confirmedTimeMapId) ?? null)
          : null;
        const confirmedMap =
          pointedConfirmedMap?.sourceMediaId === candidate.sourceMediaId &&
          pointedConfirmedMap.targetMediaId === candidate.targetMediaId
            ? pointedConfirmedMap
            : null;
        const adoptedForExport =
          confirmedMap && isTimeMapManualTakeoverExportApproved(confirmedMap);
        const classification: MatchingRunResult["classification"] = adoptedForExport
          ? "completed"
          : candidate.state === "blocked"
            ? "blocked"
            : candidate.state !== "accepted"
              ? "review"
              : !confirmedMap || confirmedMap.quality.level === "blocked"
                ? "blocked"
                : confirmedMap.quality.level === "verified"
                  ? "completed"
                  : "review";
        const message = adoptedForExport
          ? "已采用当前映射用于播放；尚未逐段审查，可随时返回修正。"
          : candidate.state === "blocked"
            ? "这组素材未形成可用关系，请查看原因后调整素材或计算设置。"
            : candidate.state !== "accepted"
              ? "系统已找到对应关系，可查看覆盖并一键采用；也可按需精确修正。"
              : !confirmedMap
                ? "匹配关系已保存，但缺少可用的确认时间图，不能进入后续流程。"
                : confirmedMap.quality.level === "blocked"
                  ? "匹配关系已保存，但确认时间图仍被质量门阻断。"
                  : confirmedMap.quality.level === "verified"
                    ? "匹配关系已经保存并验证，可进入编辑工作台继续校准。"
                    : "匹配关系已保存，但确认时间图仍需人工复核。";
        return {
          candidateId: candidate.id,
          sourceMediaId: candidate.sourceMediaId,
          targetMediaId: candidate.targetMediaId,
          classification,
          message
        };
      });
  }, [project.mediaMatchCandidates, project.mediaTimeMaps]);
  const completedTargetIds = new Set(
    matchingRunResults.flatMap((result) =>
      result.classification === "completed" ? [result.targetMediaId] : []
    )
  );
  const acceptedCount = project.mediaMatchCandidates.filter(
    (candidate) => candidate.state === "accepted"
  ).length;
  const waitingTargetCount = Math.max(0, targetMedia.length - completedTargetIds.size);
  const matchingComplete =
    targetMedia.length > 0 && completedTargetIds.size === targetMedia.length;
  const issueCandidateCount = matchingRunResults.filter(
    (result) => result.classification === "blocked" || result.classification === "review"
  ).length;
  const hasCancelledTasks = tasks.some((task) => task.state === "cancelled");
  const primaryAction = useMemo<MatchingRunPrimaryAction>(() => {
    if (running) {
      return { kind: "cancel", label: "取消剩余任务", disabled: false };
    }
    if (issueCandidateCount > 0) {
      return {
        kind: "continue",
        label: `查看覆盖并导出（${issueCandidateCount} 个结果）`,
        disabled: false
      };
    }
    if (matchingComplete) {
      return { kind: "continue", label: "查看覆盖并导出", disabled: false };
    }
    if (mediaInventoryRestartRequired) {
      return { kind: "restart", label: "重启应用后继续", disabled: true };
    }
    if (runConsoleAudioBlockers.length > 0) {
      return {
        kind: "resolveAudio",
        label: `处理 ${runConsoleAudioBlockers.length} 个音轨`,
        disabled: false
      };
    }
    return {
      kind: "start",
      label: hasCancelledTasks ? "继续剩余任务" : "开始批量匹配",
      disabled: pairCount === 0
    };
  }, [
    hasCancelledTasks,
    issueCandidateCount,
    matchingComplete,
    mediaInventoryRestartRequired,
    pairCount,
    running,
    runConsoleAudioBlockers.length
  ]);
  const matchingRunConsoleModel = useMemo(
    () =>
      buildMatchingRunConsoleModel({
        selectedSourceCount: runConsoleSources.length,
        selectedTargetCount: runConsoleTargets.length,
        selectedPairCount: pairCount,
        selectedMediaCount: runConsoleSources.length + runConsoleTargets.length,
        audioReadyCount:
          runConsoleSources.length + runConsoleTargets.length - runConsoleAudioBlockers.length,
        audioBlockerCount: runConsoleAudioBlockers.length,
        running,
        restartRequired: mediaInventoryRestartRequired,
        tasks,
        results: matchingRunResults,
        mediaNames: Object.fromEntries(
          project.mediaLibrary.map((media) => [media.id, media.name])
        ),
        primaryAction
      }),
    [
      matchingRunResults,
      mediaInventoryRestartRequired,
      pairCount,
      primaryAction,
      project.mediaLibrary,
      running,
      runConsoleAudioBlockers.length,
      runConsoleSources.length,
      runConsoleTargets.length,
      tasks
    ]
  );

  const openDiagnosticLogDirectory = async () => {
    try {
      await openAudioAlignmentDiagnosticLogDirectory();
      setEditorStatus("已打开脱敏诊断日志目录。日志文件名就是本次运行编号。", "success");
    } catch (error: unknown) {
      setEditorStatus(
        error instanceof Error ? error.message : "打开对齐诊断日志目录失败。",
        "error"
      );
    }
  };

  const openSensitiveManifestDirectory = async () => {
    try {
      await openAudioAlignmentSensitiveManifestDirectory();
      setEditorStatus(
        "已打开本机训练证据目录。文件包含完整媒体路径和内容身份，只能留在本机。",
        "success"
      );
    } catch (error: unknown) {
      setEditorStatus(
        error instanceof Error ? error.message : "打开本机训练证据目录失败。",
        "error"
      );
    }
  };

  const runBatch = async () => {
    setBatchStartError(null);
    const existingLiveRun = matchingLiveRunChannel.read(liveRunKey);
    if (existingLiveRun?.running) {
      setEditorStatus("当前匹配批次仍在运行，已恢复现有任务，不会重复启动。", "neutral");
      return;
    }
    const runEntryState = useEditorStore.getState();
    const runProjectEpoch = runEntryState.projectEpoch;
    const runInventoryGenerationKey = runEntryState.mediaInventoryGenerationKey;
    if (runEntryState.mediaInventoryRestartRequired) {
      setEditorStatus(
        runEntryState.mediaInventoryTerminalMessage ??
          "媒体清单进程清理状态不确定，需重启应用。",
        "error"
      );
      return;
    }
    const unfinishedPriorJob = activeJobRef.current;
    if (unfinishedPriorJob) {
      try {
        const stopped = await cancelTauriAudioAlignmentBatchJob(unfinishedPriorJob.jobId);
        if (!isAudioAlignmentJobFinished(stopped.status)) {
          throw new Error("原生批次尚未进入终态");
        }
        if (activeJobRef.current?.jobId === unfinishedPriorJob.jobId) {
          activeJobRef.current = null;
        }
      } catch {
        setEditorStatus(
          "上一次原生批次的清理状态仍不确定，已拒绝启动新任务。请再次尝试；若持续失败，请重启应用以回收媒体进程。",
          "error"
        );
        return;
      }
    }
    const resumedState = useEditorStore.getState();
    if (resumedState.mediaInventoryRestartRequired) {
      setEditorStatus(
        resumedState.mediaInventoryTerminalMessage ??
          "媒体清单进程清理状态不确定，需重启应用。",
        "error"
      );
      return;
    }
    if (
      resumedState.projectEpoch !== runProjectEpoch ||
      !areMediaInventoryGenerationKeysEqual(
        resumedState.mediaInventoryGenerationKey,
        runInventoryGenerationKey
      )
    ) {
      setEditorStatus("项目或音轨清单已变化，请重新确认后开始匹配。", "warning");
      return;
    }
    const selectedSources = selectedSourceIds
      .map((id) => sourceMedia.find((media) => media.id === id))
      .filter((media): media is ProjectMediaReference => Boolean(media));
    const selectedTargets = selectedTargetIds
      .map((id) => targetMedia.find((media) => media.id === id))
      .filter((media): media is ProjectMediaReference => Boolean(media));
    if (selectedSources.length === 0 || selectedTargets.length === 0) {
      setEditorStatus("请至少选择一个可分析的 B 站参考素材和一个原片素材。", "warning");
      return;
    }
    const selectedPreparations = [...selectedSources, ...selectedTargets].map((media) => ({
      media,
      preparation: useEditorStore.getState().getMediaAudioTrackPreparation(media.id)
    }));
    const firstAudioBlocker = selectedPreparations.find(
      (entry) => entry.preparation?.state !== "ready"
    );
    if (firstAudioBlocker) {
      setEditorStatus("所选素材仍有音轨尚未准备好，请先回素材页处理。", "warning");
      requestWorkspaceIntent({
        page: "materials",
        target: { kind: "audioIssue", mediaId: firstAudioBlocker.media.id }
      });
      return;
    }
    const selectedAudioStreamIndexes = Object.fromEntries(
      selectedPreparations.map(({ media, preparation }) => [
        media.id,
        requireReadyAudioStreamIndex(preparation, media.id)
      ])
    );
    const smartPairKeys =
      pairingScope === "smart"
        ? new Set(
            smartPairingPlan.pairs.map((pair) =>
              createMediaPairKey(pair.sourceMediaId, pair.targetMediaId)
            )
          )
        : null;
    const pairs = selectedSources.flatMap((source) =>
      selectedTargets.flatMap((target) => {
        const id = createMediaPairKey(source.id, target.id);
        return smartPairKeys && !smartPairKeys.has(id) ? [] : [{ source, target, id }];
      })
    );
    const existingPairKeys = new Set([
      ...useEditorStore
        .getState()
        .project.mediaMatchCandidates.filter((candidate) => candidate.state !== "rejected")
        .map((candidate) =>
          createMediaPairKey(candidate.sourceMediaId, candidate.targetMediaId)
        ),
      ...useEditorStore
        .getState()
        .project.danmakuSourceSegments.filter(
          (segment) =>
            segment.kind === "content" && segment.sourceMediaId && segment.targetMediaId
        )
        .map((segment) =>
          createMediaPairKey(segment.sourceMediaId ?? "", segment.targetMediaId ?? "")
        )
    ]);
    const pendingPairs = pairs.filter(
      (pair) => !existingPairKeys.has(createMediaPairKey(pair.source.id, pair.target.id))
    );
    if (pendingPairs.length > MAX_ALIGNMENT_EXPERIMENT_PAIRS) {
      const message = `本次还有 ${pendingPairs.length} 组待分析，单批最多 ${MAX_ALIGNMENT_EXPERIMENT_PAIRS} 组。请在“调整范围”减少所选素材，或选择智能匹配后重试；已有结果保留。`;
      setBatchStartError(message);
      setEditorStatus(message, "warning");
      return;
    }
    const initialTasks: BatchTask[] = pairs.map(({ source, target, id }) => ({
      id,
      sourceMediaId: source.id,
      targetMediaId: target.id,
      state: existingPairKeys.has(createMediaPairKey(source.id, target.id))
        ? "found"
        : "waiting",
      progress: existingPairKeys.has(createMediaPairKey(source.id, target.id)) ? 1 : 0,
      message: existingPairKeys.has(createMediaPairKey(source.id, target.id))
        ? "已有候选或已保存关系，未重复分析"
        : "等待分析",
      jobId: null,
      logs: []
    }));
    if (pendingPairs.length === 0) {
      setTasks(initialTasks);
      setEditorStatus(
        `所选 ${pairs.length} 组素材已有候选或已保存关系，无需重复分析。`,
        "neutral"
      );
      return;
    }
    const settings = loadAppSettings().alignment;
    const matchingDefaults = resolveMatchingDefaults(
      settings,
      spectralBackendPreference,
      experimentQueueRef.current
    );
    const pendingSourceIds = new Set(pendingPairs.map((pair) => pair.source.id));
    const pendingTargetIds = new Set(pendingPairs.map((pair) => pair.target.id));
    const versionReuseGroups = [
      ...(treatSelectedSourcesAsVersions && pendingSourceIds.size >= 2
        ? [
            {
              groupId: "selected-source-versions",
              side: "source" as const,
              mediaIds: selectedSources
                .filter((media) => pendingSourceIds.has(media.id))
                .map((media) => media.id)
            }
          ]
        : []),
      ...(treatSelectedTargetsAsVersions && pendingTargetIds.size >= 2
        ? [
            {
              groupId: "selected-target-versions",
              side: "target" as const,
              mediaIds: selectedTargets
                .filter((media) => pendingTargetIds.has(media.id))
                .map((media) => media.id)
            }
          ]
        : [])
    ];
    let activeQueue: AlignmentExperimentQueue;
    try {
      const queueConfig = buildMatchingExperimentQueueConfig({
        sourceMediaIds: selectedSources
          .filter((media) => pendingSourceIds.has(media.id))
          .map((media) => media.id),
        targetMediaIds: selectedTargets
          .filter((media) => pendingTargetIds.has(media.id))
          .map((media) => media.id),
        pairs: pendingPairs.map((pair) => ({
          sourceMediaId: pair.source.id,
          targetMediaId: pair.target.id
        })),
        versionReuseGroups,
        selectedAudioStreamIndexes,
        ...matchingDefaults,
        enableVisualEvidence: true
      });
      const storedQueue = experimentQueueRef.current;
      if (
        storedQueue &&
        storedQueue.projectId === project.id &&
        queueMatchesConfig(storedQueue, queueConfig)
      ) {
        activeQueue = storedQueue;
      } else {
        activeQueue = createAlignmentExperimentQueue({
          queueId: createId("media_match_batch"),
          projectId: project.id,
          config: queueConfig,
          nowMs: Date.now()
        });
      }
    } catch (error) {
      const message = `无法准备本次匹配：${formatUnknownError(error)}。当前任务尚未启动，请调整范围或设置后重试。`;
      setBatchStartError(message);
      setEditorStatus(message, "error");
      return;
    }
    setTasks(initialTasks);
    const batchId = activeQueue.queueId;
    persistExperimentQueue(activeQueue);
    const interruptActiveQueue = (reason: string) => {
      activeQueue = interruptAlignmentExperimentQueue(activeQueue, reason, Date.now());
      persistExperimentQueue(activeQueue);
    };
    const runToken = batchTokenRef.current + 1;
    batchTokenRef.current = runToken;
    const isRunCurrent = () =>
      batchTokenRef.current === runToken &&
      useEditorStore.getState().projectEpoch === runProjectEpoch;
    cancelRequestedRef.current = false;
    publishLiveMatchingRun(liveRunKey, {
      tasks: initialTasks,
      running: true,
      selectedSourceIds: selectedSources.map((media) => media.id),
      selectedTargetIds: selectedTargets.map((media) => media.id),
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      requestCancel: () => {
        cancelRequestedRef.current = true;
        updateLiveMatchingRunTasks(liveRunKey, (current) =>
          current.map((task) =>
            task.state === "waiting" || task.state === "running"
              ? { ...task, message: "正在停止；已经找到的结果会保留" }
              : task
          )
        );
      }
    });
    setRunning(true);
    let contextInvalidated = false;
    const isBatchContextCurrent = () => {
      if (!isRunCurrent()) {
        return false;
      }
      const currentProject = useEditorStore.getState().project;
      return pendingPairs.every((pair) => {
        const currentSource = findProjectMedia(currentProject, pair.source.id);
        const currentTarget = findProjectMedia(currentProject, pair.target.id);
        return (
          normalizeLocalPath(currentSource?.localPath) ===
            normalizeLocalPath(pair.source.localPath) &&
          normalizeLocalPath(currentTarget?.localPath) ===
            normalizeLocalPath(pair.target.localPath)
        );
      });
    };
    let snapshot: AudioAlignmentBatchJobSnapshot | null = null;
    let batchJobId: string | null = null;
    let batchFailure: string | null = null;
    let cancelSent = false;
    let cleanupUnconfirmed = false;

    try {
      snapshot = await startTauriAudioAlignmentBatchJob({
        sources: selectedSources
          .filter((media) => pendingSourceIds.has(media.id))
          .map((media) => ({
            mediaId: media.id,
            path: requireLocalPath(media),
            audioStreamIndex: selectedAudioStreamIndexes[media.id]
          })),
        targets: selectedTargets
          .filter((media) => pendingTargetIds.has(media.id))
          .map((media) => ({
            mediaId: media.id,
            path: requireLocalPath(media),
            audioStreamIndex: selectedAudioStreamIndexes[media.id]
          })),
        pairs: pendingPairs.map((pair) => ({
          sourceMediaId: pair.source.id,
          targetMediaId: pair.target.id
        })),
        versionReuseGroups,
        ffmpegPath: settings.ffmpegPath.trim() || null,
        ...matchingDefaults,
        enableVisualEvidence: true,
        localizationMode: true
      });
      batchJobId = snapshot.jobId;
      if (!isRunCurrent()) {
        if (!isAudioAlignmentJobFinished(snapshot.status)) {
          void cancelTauriAudioAlignmentBatchJob(snapshot.jobId).catch(() => undefined);
        }
        finishVisibleRun();
        return;
      }
      activeJobRef.current = { runToken, jobId: snapshot.jobId };
      activeQueue = beginAlignmentExperimentAttempt(activeQueue, {
        jobId: snapshot.jobId,
        pairs: pendingPairs.map((pair) => ({
          sourceMediaId: pair.source.id,
          targetMediaId: pair.target.id
        })),
        nowMs: Date.now()
      });
      if (!isBatchContextCurrent()) {
        contextInvalidated = true;
        if (!isAudioAlignmentJobFinished(snapshot.status)) {
          void cancelTauriAudioAlignmentBatchJob(snapshot.jobId).catch(() => undefined);
        }
      } else {
        updateTasksFromBatchSnapshot(snapshot);
      }
      persistExperimentQueue(activeQueue);

      while (
        !contextInvalidated &&
        isRunCurrent() &&
        !isAudioAlignmentJobFinished(snapshot.status)
      ) {
        if (cancelRequestedRef.current && !cancelSent) {
          cancelSent = true;
          try {
            snapshot = await cancelTauriAudioAlignmentBatchJob(snapshot.jobId);
            if (isBatchContextCurrent()) {
              updateTasksFromBatchSnapshot(snapshot);
            }
          } catch (error) {
            batchFailure = error instanceof Error ? error.message : "停止批次时发生错误";
          }
          continue;
        }
        await waitForPoll();
        if (!isRunCurrent()) {
          break;
        }
        if (!isBatchContextCurrent()) {
          contextInvalidated = true;
          const activeJob = activeJobRef.current;
          if (
            activeJob?.runToken === runToken &&
            activeJob.jobId === snapshot.jobId &&
            !isAudioAlignmentJobFinished(snapshot.status)
          ) {
            void cancelTauriAudioAlignmentBatchJob(snapshot.jobId).catch(() => undefined);
          }
          break;
        }
        if (cancelRequestedRef.current && !cancelSent) {
          continue;
        }
        snapshot = await getTauriAudioAlignmentBatchJob(snapshot.jobId);
        if (isBatchContextCurrent()) {
          updateTasksFromBatchSnapshot(snapshot);
        }
      }
    } catch (error) {
      batchFailure = error instanceof Error ? error.message : "批量匹配未能完成";
    } finally {
      const ownsActiveJob =
        activeJobRef.current?.runToken === runToken &&
        activeJobRef.current.jobId === batchJobId;
      if (ownsActiveJob && snapshot && !isAudioAlignmentJobFinished(snapshot.status)) {
        try {
          snapshot = await cancelTauriAudioAlignmentBatchJob(snapshot.jobId);
          if (isBatchContextCurrent()) {
            updateTasksFromBatchSnapshot(snapshot);
          }
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : "无法确认原生任务已停止";
          let reconcileMessage: string | null = null;
          try {
            const reconciled = await getTauriAudioAlignmentBatchJob(snapshot.jobId);
            if (isAudioAlignmentJobFinished(reconciled.status)) {
              snapshot = reconciled;
              batchFailure = null;
              if (isBatchContextCurrent()) {
                updateTasksFromBatchSnapshot(snapshot);
              }
            } else {
              reconcileMessage = "重新读取后原生批次仍未进入终态";
            }
          } catch (reconcileError) {
            reconcileMessage =
              reconcileError instanceof Error
                ? reconcileError.message
                : "无法重新读取原生任务终态";
          }
          if (reconcileMessage !== null) {
            cleanupUnconfirmed = true;
            const cleanupFailure =
              "原生批次清理状态不确定；已保留任务引用并阻止新任务，必要时请重启应用。";
            const recoveryDetails = `${cleanupMessage}；终态重读失败：${reconcileMessage}`;
            batchFailure = batchFailure
              ? `${batchFailure}；${cleanupFailure}（${recoveryDetails}）`
              : `${cleanupFailure}（${recoveryDetails}）`;
          }
        }
      }
      if (
        ownsActiveJob &&
        !cleanupUnconfirmed &&
        snapshot &&
        isAudioAlignmentJobFinished(snapshot.status)
      ) {
        activeJobRef.current = null;
      }
    }

    if (!isRunCurrent()) {
      finishVisibleRun();
      return;
    }
    if (contextInvalidated) {
      interruptActiveQueue("项目素材在分析期间发生变化；本次原生结果未应用。");
      setEditorStatus(
        "项目素材在分析期间发生变化，本批次结果未应用，请重新开始匹配。",
        "warning"
      );
      finishVisibleRun();
      return;
    }
    if (cleanupUnconfirmed) {
      interruptActiveQueue(batchFailure ?? "原生任务清理状态不确定；case 已保留为待重试。");
      updateVisibleTasks((current) =>
        current.map((task) =>
          task.state === "waiting" || task.state === "running"
            ? {
                ...task,
                state: "failed",
                progress: 1,
                message: "原生任务清理状态不确定；未应用任何迟到结果"
              }
            : task
        )
      );
      setEditorStatus(batchFailure ?? "原生批次清理状态不确定。", "error");
      finishVisibleRun();
      return;
    }
    if (!snapshot) {
      const cancelledBeforeStart = cancelRequestedRef.current;
      interruptActiveQueue(
        cancelledBeforeStart
          ? "任务在原生批次启动前取消。"
          : (batchFailure ?? "未收到原生批任务状态。")
      );
      updateVisibleTasks((current) =>
        current.map((task) =>
          pendingPairs.some((pair) => pair.id === task.id)
            ? {
                ...task,
                state: cancelledBeforeStart ? "cancelled" : "failed",
                progress: 1,
                message: cancelledBeforeStart
                  ? "未开始，已取消"
                  : (batchFailure ?? "批量匹配未能开始")
              }
            : task
        )
      );
      setEditorStatus(
        cancelledBeforeStart
          ? "批量匹配已取消：任务尚未开始。"
          : `批量匹配未能开始：${batchFailure ?? "未收到原生批任务状态。"}`,
        cancelledBeforeStart ? "warning" : "error"
      );
      finishVisibleRun();
      return;
    }
    if (snapshot.status === "failed") {
      batchFailure = snapshot.error ?? batchFailure ?? snapshot.message;
    }
    try {
      activeQueue = finishAlignmentExperimentAttempt(activeQueue, {
        jobId: snapshot.jobId,
        results: createAlignmentExperimentFinishResults(snapshot),
        nowMs: Date.now(),
        error: batchFailure
      });
      persistExperimentQueue(activeQueue);
    } catch (queueError: unknown) {
      const message =
        queueError instanceof Error ? queueError.message : "实验队列回执保存失败。";
      interruptActiveQueue(`原生任务已结束，但逐 case 回执未能安全保存：${message}`);
      batchFailure = batchFailure ? `${batchFailure}；${message}` : message;
    }
    const pairSnapshots = new Map(
      snapshot.pairs.map((pairSnapshot) => [
        createMediaPairKey(pairSnapshot.sourceMediaId, pairSnapshot.targetMediaId),
        pairSnapshot
      ])
    );
    let confirmableCount = 0;
    let automaticallyAcceptedCount = 0;
    let blockedCount = 0;
    let noEligibleCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    for (const pair of pendingPairs) {
      const pairSnapshot = pairSnapshots.get(
        createMediaPairKey(pair.source.id, pair.target.id)
      );
      if (!pairSnapshot) {
        if (cancelRequestedRef.current) {
          cancelledCount += 1;
          updateTask(pair.id, { state: "cancelled", progress: 1, message: "未完成，已停止" });
        } else {
          failedCount += 1;
          updateTask(pair.id, {
            state: "failed",
            progress: 1,
            message: batchFailure ?? "这组素材未能完成分析"
          });
        }
        continue;
      }
      const disposition = describeNativeFineDisposition(pairSnapshot, snapshot.status);
      if (disposition.kind === "confirmable") {
        confirmableCount += 1;
      } else if (disposition.kind === "noEligibleCandidate") {
        noEligibleCount += 1;
      } else if (disposition.kind === "cancelled") {
        cancelledCount += 1;
      } else if (
        disposition.kind === "resourceBlocked" ||
        disposition.kind === "infrastructureFailed"
      ) {
        failedCount += 1;
      } else {
        blockedCount += 1;
      }
      const matchRange = pairSnapshot.proposal?.matchRange ?? null;
      const taskMessage =
        disposition.kind === "confirmable" && matchRange
          ? `${pair.target.name} ← ${pair.source.name} ${formatTimecode(matchRange.sourceStartMs)}–${formatTimecode(matchRange.sourceEndMs)}；已唯一确定，等待逐项确认`
          : disposition.kind === "reviewCandidate" && matchRange
            ? `${pair.target.name} ← ${pair.source.name} ${formatTimecode(matchRange.sourceStartMs)}–${formatTimecode(matchRange.sourceEndMs)}；找到候选，但差异边界需要人工复核`
            : disposition.message;
      updateTask(pair.id, {
        state: disposition.taskState,
        progress: 1,
        message: taskMessage,
        jobId: snapshot.jobId
      });
      if (
        (disposition.kind !== "confirmable" && disposition.kind !== "reviewCandidate") ||
        !pairSnapshot.proposal?.matchRange
      ) {
        continue;
      }
      const currentProject = useEditorStore.getState().project;
      const proposal = augmentAlignmentProposalWithDanmakuEvidence(
        pairSnapshot.proposal,
        danmakuEvidenceForSource(currentProject, pair.source.id, suspectedCutCandidates)
      );
      const candidate = createMediaMatchCandidate(currentProject, {
        id: createId("media_match_candidate"),
        batchId,
        sourceMediaId: pair.source.id,
        targetMediaId: pair.target.id,
        proposal
      });
      const publishedCandidate = appendCandidateDiagnostic(
        candidate,
        disposition.kind === "confirmable"
          ? "原生精匹配：组件最终分配已解析，当前候选由后端选定。"
          : "原生精匹配：已保留高覆盖 blocked TimeMap 供逐段人工复核；它没有通过自动确认门控，不能直接确认或导出。"
      );
      addCandidate(publishedCandidate);
      const acceptedAutomatically =
        useEditorStore
          .getState()
          .project.mediaMatchCandidates.find((item) => item.id === publishedCandidate.id)
          ?.state === "accepted";
      if (acceptedAutomatically) {
        automaticallyAcceptedCount += 1;
        confirmableCount = Math.max(0, confirmableCount - 1);
        updateTask(pair.id, {
          state: "found",
          progress: 1,
          message: `${pair.target.name} ← ${pair.source.name}；独立留出硬门通过，已自动确认并可直接导出`,
          jobId: snapshot.jobId
        });
      }
    }
    const batchSummary = [
      automaticallyAcceptedCount > 0 ? `${automaticallyAcceptedCount} 组已自动确认` : null,
      `${confirmableCount} 组可逐项确认`,
      blockedCount > 0 ? `${blockedCount} 组暂不可确认` : null,
      noEligibleCount > 0 ? `${noEligibleCount} 组没有可用候选` : null,
      failedCount > 0 ? `${failedCount} 组未完成分析` : null,
      cancelledCount > 0 ? `${cancelledCount} 组已取消` : null
    ]
      .filter((part): part is string => part !== null)
      .join("，");
    const cancelled =
      snapshot.status === "cancelled" ||
      (cancelRequestedRef.current && !isAudioAlignmentJobFinished(snapshot.status));
    if (cancelled) {
      setEditorStatus(
        `批量匹配已取消：${batchSummary}。已取消结果不会发布为可确认关系。`,
        "warning"
      );
    } else {
      const skippedCount = pairs.length - pendingPairs.length;
      const summaryPrefix = snapshot.status === "failed" ? "批量匹配提前结束" : "批量匹配完成";
      setEditorStatus(
        `${summaryPrefix}：${batchSummary}${
          skippedCount > 0 ? `，跳过 ${skippedCount} 组已有结果` : ""
        }${batchFailure ? `；${batchFailure}` : ""}。`,
        snapshot.status === "failed" || failedCount > 0 || blockedCount > 0
          ? "warning"
          : "success"
      );
    }
    finishVisibleRun();
  };

  const cancelBatch = () => {
    const liveRun = matchingLiveRunChannel.read(liveRunKey);
    if (liveRun?.running) {
      liveRun.requestCancel();
      return;
    }
    cancelRequestedRef.current = true;
    setTasks((current) =>
      current.map((task) =>
        task.state === "waiting" || task.state === "running"
          ? { ...task, message: "正在停止；已经找到的结果会保留" }
          : task
      )
    );
  };

  const updateTask = (taskId: string, patch: Partial<BatchTask>) => {
    updateVisibleTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, ...patch } : task))
    );
  };

  const updateTasksFromBatchSnapshot = (snapshot: AudioAlignmentBatchJobSnapshot) => {
    const pairSnapshots = new Map(
      snapshot.pairs.map((pairSnapshot) => [
        createMediaPairKey(pairSnapshot.sourceMediaId, pairSnapshot.targetMediaId),
        pairSnapshot
      ])
    );
    updateVisibleTasks((current) =>
      current.map((task) => {
        const pairSnapshot = pairSnapshots.get(
          createMediaPairKey(task.sourceMediaId, task.targetMediaId)
        );
        return pairSnapshot
          ? { ...task, ...batchTaskPatchFromPairSnapshot(pairSnapshot, snapshot) }
          : task;
      })
    );
  };

  return (
    <section
      className="workspace-page text-sm text-content-secondary"
      data-testid="media-matching-panel"
    >
      <span className="sr-only">
        {`${completedTargetIds.size} / ${targetMedia.length} 个原片已有可用关系；已保存 ${acceptedCount} 个；待匹配原片 ${waitingTargetCount} 个；将分析 ${selectedSourceIds.length} 个参考 × ${selectedTargetIds.length} 个原片，共 ${pairCount} 组`}
      </span>
      <MatchingRunConsolePresentation
        model={matchingRunConsoleModel}
        onIntent={(intent) => {
          if (intent.type === "openCandidate") {
            requestWorkspaceIntent({
              page: "editing",
              target: { kind: "candidate", candidateId: intent.candidateId }
            });
            return;
          }
          if (intent.type === "configure") {
            setAdvancedOpen(true);
            setConfigurationOpen(true);
            return;
          }
          if (intent.type === "openDiagnosticLog") {
            void openDiagnosticLogDirectory();
            return;
          }
          if (intent.type === "openSensitiveManifest") {
            void openSensitiveManifestDirectory();
            return;
          }
          if (intent.action === "start") {
            void runBatch();
          } else if (intent.action === "cancel") {
            cancelBatch();
          } else if (intent.action === "resolveAudio") {
            const mediaId = runConsoleAudioBlockers[0]?.id;
            if (mediaId) {
              requestWorkspaceIntent({
                page: "materials",
                target: { kind: "audioIssue", mediaId }
              });
            }
          } else if (intent.action === "continue") {
            setWorkspacePage("editing");
          }
        }}
      />
      <div className="matching-tools-bar">
        {batchStartError && (
          <span role="alert" className="text-feedback-warning">
            {batchStartError}
          </span>
        )}
        <WorkspaceMenu
          label="匹配工具"
          items={[
            {
              id: "config",
              label: "匹配范围与计算设置",
              onSelect: () => {
                setAdvancedOpen(true);
                setConfigurationOpen(true);
              }
            },
            {
              id: "history",
              label: "全部结果与已保存关系",
              onSelect: () => {
                setAdvancedOpen(true);
                setConfigurationOpen(false);
              }
            }
          ]}
        />
        {queuePersistenceWarning && (
          <span role="alert" className="text-feedback-warning">
            {queuePersistenceWarning}
          </span>
        )}
      </div>
      <ToolSheet
        title={configurationOpen ? "匹配范围与计算设置" : "全部结果与已保存关系"}
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        wide
      >
        <div className="pb-1">
          <details
            className="mt-3 rounded-lg border border-panel-line bg-surface-inset p-3"
            open={configurationOpen}
            onToggle={(event) => setConfigurationOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer font-medium text-content-secondary">
              匹配范围与计算设置
              <span className="ml-2 text-ui-caption font-normal text-content-muted">
                {selectedSourceIds.length} 个参考 × {selectedTargetIds.length} 个原片
              </span>
            </summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <MediaChoiceList
                title="B 站参考素材"
                items={sourceMedia}
                selectedIds={selectedSourceIds}
                audioPreparations={audioPreparations}
                onToggle={(id) => {
                  sourceSelectionTouchedRef.current = true;
                  setSelectedSourceIds((current) => toggleId(current, id));
                }}
              />
              <MediaChoiceList
                title="原片素材"
                items={targetMedia}
                selectedIds={selectedTargetIds}
                audioPreparations={audioPreparations}
                onToggle={(id) => {
                  targetSelectionTouchedRef.current = true;
                  setSelectedTargetIds((current) => toggleId(current, id));
                }}
              />
            </div>

            <div className="mt-3 rounded border border-panel-line bg-surface-inset p-2">
              <div
                className="mb-2 rounded border border-feedback-running/20 bg-feedback-running/10 p-2 text-xs text-content-secondary"
                data-testid="smart-pairing-summary"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <WandSparkles size={14} className="text-feedback-running" />
                  <span className="font-medium text-content-primary">智能匹配范围</span>
                  <select
                    aria-label="匹配组合范围"
                    className="ml-auto rounded border border-panel-line bg-panel px-2 py-1 text-xs text-content-primary outline-none focus:border-accent-cyan"
                    value={pairingScope}
                    disabled={running}
                    onChange={(event) => setPairingScope(event.target.value as PairingScope)}
                  >
                    <option value="smart">按季集信息缩小范围</option>
                    <option value="all">分析全部组合</option>
                  </select>
                </div>
                <p className="mt-1 leading-5 text-content-muted">
                  {pairingScope === "smart"
                    ? smartPairingPlan.summary
                    : `将分析全部 ${smartPairingPlan.totalCartesianPairCount} 组组合。`}
                </p>
                <p className="text-ui-caption leading-5 text-content-muted">
                  绑定
                  XML、同源编号和项目分集仅用于建议范围；多个参考可以对应同一集，实际时间关系仍由音视频证据验证。
                </p>
                {pairingScope === "smart" && (
                  <MatchingEpisodeSuggestions
                    key={`${project.id}:${projectEpoch}`}
                    plan={smartPairingPlan}
                    sources={selectedSourcesForPlanning}
                    targets={selectedTargetsForPlanning}
                    disabled={running}
                    draft={episodeHintDraft}
                    onDraftChange={setEpisodeHintDraft}
                    onSave={setReferenceEpisodeHint}
                  />
                )}
              </div>
              <label className="flex flex-wrap items-center gap-2 text-content-secondary">
                <span className="font-medium">本次匹配计算</span>
                <select
                  aria-label="本次匹配计算设备"
                  className="rounded border border-panel-line bg-panel px-2 py-1 text-xs text-content-primary outline-none focus:border-accent-cyan"
                  value={spectralBackendPreference}
                  disabled={running || experimentQueue?.state === "interrupted"}
                  onChange={(event) => {
                    const spectralBackend = event.target.value as SpectralBackendPreference;
                    setSpectralBackendPreference(spectralBackend);
                    const settings = loadAppSettings();
                    void persistDesktopAppSettings({
                      ...settings,
                      alignment: { ...settings.alignment, spectralBackend }
                    }).catch((error) =>
                      setQueuePersistenceWarning(`默认设备未保存：${String(error)}`)
                    );
                  }}
                >
                  <option value="cuda">GPU（NVIDIA CUDA，失败即停止）</option>
                  <option value="cpu">CPU（禁用 CUDA）</option>
                  <option value="auto">自动（优先 GPU，可回退 CPU）</option>
                </select>
              </label>
              {experimentQueue?.state === "interrupted" && (
                <p className="text-xs text-content-muted">
                  本项目有中断队列，将沿用原参数。要用新预设开始新批次，请先使用“清除可恢复任务记录”；已保存候选不受影响。
                </p>
              )}
              <details className="mt-2 border-t border-panel-line pt-2 text-ui-caption text-content-muted">
                <summary className="cursor-pointer text-content-secondary">
                  高级：同一内容的多个版本
                </summary>
                <p className="mt-2 leading-5 text-content-muted">
                  默认每段内容只能分配给一个素材。只有确认所选文件是同一内容的不同发行版、画质版或音轨版时，才开启对应选项；系统仍会为每个版本分别生成候选并要求逐项复核。
                </p>
                <label className="mt-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-cyan-500"
                    checked={treatSelectedSourcesAsVersions}
                    disabled={running || selectedSourceIds.length < 2}
                    onChange={(event) =>
                      setTreatSelectedSourcesAsVersions(event.target.checked)
                    }
                  />
                  <span>
                    所选 B 站参考素材是同一内容的不同版本
                    <span className="block text-content-muted">
                      允许同一原片时间段分别匹配这些参考版本。
                    </span>
                  </span>
                </label>
                <label className="mt-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-cyan-500"
                    checked={treatSelectedTargetsAsVersions}
                    disabled={running || selectedTargetIds.length < 2}
                    onChange={(event) =>
                      setTreatSelectedTargetsAsVersions(event.target.checked)
                    }
                  />
                  <span>
                    所选原片素材是同一内容的不同版本
                    <span className="block text-content-muted">
                      允许同一参考时间段分别匹配这些原片版本。
                    </span>
                  </span>
                </label>
              </details>
              <div
                role="alert"
                data-testid="legacy-alignment-warning"
                className="mt-3 rounded-lg border border-feedback-warning/25 bg-feedback-warning/10 p-3 leading-5 text-feedback-warning"
              >
                <div className="flex items-center gap-2 font-medium">
                  <CircleAlert size={14} />
                  需要复核的结果会保留供试听
                </div>
                <details className="mt-2 text-ui-caption text-feedback-warning/80">
                  <summary className="cursor-pointer">为什么需要复核？</summary>
                  <p className="mt-2">
                    找到整体关系但局部仍有删减、空白或歧义时，应用会保留结果供你试听，不会直接用于导出。无法确认关系、运行失败或取消时只显示原因。
                  </p>
                  <p className="mt-2">
                    全局占用冲突会作为未决结果保留；完成必要的 A/B
                    复核与本机验证前，不会改变正式导出。
                  </p>
                  <p className="mt-2">
                    候选发布只服从原生 Evidence v5
                    的组件最终分配、显式多版本复用策略与精执行证据绑定；旧的 coarse
                    globalSelection 仅保留为诊断信息，前端不会再次求解。
                  </p>
                </details>
              </div>
            </div>
          </details>

          {mediaInventoryRestartRequired ? (
            <div
              role="alert"
              className="mt-3 flex items-center gap-2 rounded border border-accent-red/40 bg-accent-red/10 p-2 text-accent-red"
            >
              <CircleAlert size={14} />
              {mediaInventoryTerminalMessage ?? "媒体清单进程清理状态不确定，需重启应用。"}
            </div>
          ) : selectedAudioBlockers.length > 0 ? (
            <div
              role="alert"
              className="mt-3 flex flex-wrap items-center gap-2 rounded border border-accent-yellow/40 bg-accent-yellow/10 p-2 text-accent-yellow"
            >
              <CircleAlert size={14} />
              <span className="mr-auto">
                所选素材中有 {selectedAudioBlockers.length} 个音轨尚未准备好，匹配不会开始。
              </span>
              <TextButton
                onClick={() =>
                  requestWorkspaceIntent({
                    page: "materials",
                    target: { kind: "audioIssue", mediaId: selectedAudioBlockers[0].id }
                  })
                }
              >
                回素材页处理 {selectedAudioBlockers.length} 个音轨
              </TextButton>
            </div>
          ) : null}

          <span className="sr-only" data-testid="spectral-backend-policy">
            {describeSpectralBackendPolicy(spectralBackendPreference)}
          </span>

          {experimentQueue ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 rounded border border-feedback-running/20 bg-feedback-running/10 p-2 text-ui-caption text-content-muted"
              data-testid="alignment-experiment-queue-status"
            >
              <RefreshCw size={13} className="text-feedback-running" />
              <div className="mr-auto leading-5">
                匹配进度已保存在本机。关闭或更新应用后，未完成的组合会安全回到待处理；已保存候选不会重复分析。
                <details className="mt-1 text-content-muted">
                  <summary className="cursor-pointer">运行记录详情</summary>共{" "}
                  {experimentQueue.pairs.length} 个组合，已保存{" "}
                  {experimentQueue.pairs.reduce(
                    (count, pair) => count + pair.receipts.length,
                    0
                  )}{" "}
                  份终态回执。
                </details>
              </div>
              <TextButton
                disabled={running}
                onClick={() => {
                  void clearDesktopAlignmentExperimentQueue(project.id).catch(
                    (error: unknown) =>
                      setQueuePersistenceWarning(
                        `桌面任务记录清除失败：${formatUnknownError(error)}`
                      )
                  );
                  experimentQueueRef.current = null;
                  setExperimentQueue(null);
                  setTasks([]);
                  setEditorStatus(
                    "已清除本项目的可恢复任务记录；媒体特征缓存和已保存候选不受影响。",
                    "neutral"
                  );
                }}
              >
                清除任务记录
              </TextButton>
            </div>
          ) : null}

          {queuePersistenceWarning ? (
            <div
              className="mt-2 rounded border border-feedback-warning/30 bg-feedback-warning/10 p-2 text-ui-caption text-feedback-warning"
              role="alert"
            >
              {queuePersistenceWarning} 当前项目结果和特征缓存未受影响；请先不要关闭应用。
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-content-primary">分析结果</h4>
          </div>
          {project.mediaMatchCandidates.length === 0 ? (
            <div className="mt-2 rounded border border-dashed border-panel-line p-3 leading-5 text-content-muted">
              尚无候选。选择项目内素材并开始匹配后，每一组结果会在这里显示摘要；播放、修改和保存统一在编辑页完成。
            </div>
          ) : (
            <div className="mt-2 grid gap-2">
              {[...project.mediaMatchCandidates]
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                .map((candidate) => (
                  <MediaMatchCandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    project={project}
                  />
                ))}
            </div>
          )}

          <ConfirmedRelations project={project} />
        </div>
      </ToolSheet>
    </section>
  );
}

function describeSpectralBackendPolicy(value: SpectralBackendPreference): string {
  if (value === "cuda") {
    return "计算策略：强制 GPU；CUDA/cuFFT 不可用或执行失败时停止本次匹配，不回退 CPU。";
  }
  if (value === "cpu") {
    return "计算策略：强制 CPU；本次匹配完全禁用 CUDA。";
  }
  return "计算策略：自动推荐；CUDA 可用时加速声谱 FFT，失败时改用 CPU。";
}

function appendCandidateDiagnostic(
  candidate: MediaMatchCandidate,
  diagnostic: string
): MediaMatchCandidate {
  return {
    ...candidate,
    proposal: {
      ...candidate.proposal,
      diagnostics: appendUniqueText(candidate.proposal.diagnostics, diagnostic)
    }
  };
}

function appendUniqueText(lines: readonly string[], line: string): string[] {
  return lines.includes(line) ? [...lines] : [...lines, line];
}

function MediaMatchCandidateCard({
  candidate,
  project
}: {
  candidate: MediaMatchCandidate;
  project: EditorProject;
}) {
  const source = findProjectMedia(project, candidate.sourceMediaId);
  const target = findProjectMedia(project, candidate.targetMediaId);
  const candidateTimeMap = project.mediaTimeMaps.find(
    (item) => item.id === candidate.timeMapId
  );
  const confirmedTimeMap = candidate.confirmedTimeMapId
    ? project.mediaTimeMaps.find((item) => item.id === candidate.confirmedTimeMapId)
    : undefined;
  const displayedTimeMap = candidate.state === "accepted" ? confirmedTimeMap : candidateTimeMap;
  const displayedTimeMapState = candidate.state === "accepted" ? "confirmed" : "candidate";
  const displayedTimeMapGate = describeTimeMapGate(displayedTimeMap, displayedTimeMapState);
  const requestWorkspaceIntent = useEditorStore((state) => state.requestWorkspaceIntent);

  return (
    <article
      className="performance-list-item rounded border border-panel-line bg-surface-inset p-3"
      data-testid="media-match-candidate"
      id={`media-match-candidate-${candidate.id}`}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-content-primary">
            {target?.name ?? candidate.targetMediaId} ←{" "}
            {source?.name ?? candidate.sourceMediaId} {formatTimecode(candidate.sourceStartMs)}–
            {formatTimecode(candidate.sourceEndMs)}
          </div>
          <div className="mt-1 text-ui-caption text-content-muted">
            原片对应范围 {formatTimecode(candidate.targetStartMs)}–
            {formatTimecode(candidate.targetEndMs)}
          </div>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-ui-caption ${candidateStateClass(candidate.state, displayedTimeMapGate.exportReady)}`}
        >
          {candidateStateText(candidate, displayedTimeMapGate)}
        </span>
      </div>

      <TimeMapQualitySummary
        timeMap={displayedTimeMap}
        expectedState={displayedTimeMapState}
        testId="candidate-time-map-quality"
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded border border-panel-line/70 bg-surface-inset p-2.5">
        <p className="min-w-0 flex-1 text-ui-caption leading-5 text-content-muted">
          智能匹配已经完成计算。A/B 播放、色块热力图、边界拖动、逐段确认和关系保存统一在第 3
          步完成。
        </p>
        <TextButton
          tone="primary"
          onClick={() =>
            requestWorkspaceIntent({
              page: "editing",
              target: { kind: "candidate", candidateId: candidate.id }
            })
          }
        >
          进入编辑工作台 <ArrowRight size={14} />
        </TextButton>
      </div>

      <details className="mt-3 rounded border border-panel-line/70 bg-surface-inset p-2 text-ui-caption text-content-muted">
        <summary className="cursor-pointer">匹配证据与诊断</summary>
        <div className="mt-2 grid gap-1">
          <div>
            {candidate.proposal.timeMap
              ? `定位线索分数 ${Math.round(candidate.confidence * 100)}% · 不是校准概率`
              : `旧引擎分数 ${Math.round(candidate.confidence * 100)}% · 未校准`}
          </div>
          <div>覆盖率：{Math.round((candidate.proposal.matchRange?.coverage ?? 0) * 100)}%</div>
          <div>
            同步线索：{candidate.proposal.anchors.length} 个；删减修正：
            {candidate.timingRules.length} 处
          </div>
          {candidate.proposal.diagnostics.map((line, index) => (
            <div key={`${candidate.id}-diag-${index}`}>{line}</div>
          ))}
        </div>
      </details>
    </article>
  );
}

type TimeMapGateKind =
  | "verified"
  | "manual-takeover"
  | "review"
  | "blocked"
  | "legacy-unverified"
  | "missing"
  | "state-error";

interface TimeMapGateDescription {
  kind: TimeMapGateKind;
  label: string;
  message: string;
  canSaveRelationship: boolean;
  exportReady: boolean;
  manualTakeoverAvailable: boolean;
}

function TimeMapQualitySummary({
  timeMap,
  expectedState,
  testId
}: {
  timeMap: MediaTimeMap | undefined;
  expectedState: Extract<MediaTimeMapState, "candidate" | "confirmed">;
  testId: string;
}) {
  const gate = describeTimeMapGate(timeMap, expectedState);
  const needsManualCompletion = gate.canSaveRelationship || gate.manualTakeoverAvailable;
  const panelClass = gate.exportReady
    ? "border-feedback-success/35 bg-feedback-success/10 text-feedback-success"
    : needsManualCompletion
      ? "border-feedback-warning/35 bg-feedback-warning/10 text-feedback-warning"
      : "border-feedback-danger/35 bg-feedback-danger/10 text-feedback-danger";
  const badgeClass = gate.exportReady
    ? "border-feedback-success/50 bg-feedback-success/10 text-feedback-success"
    : needsManualCompletion
      ? "border-feedback-warning/50 bg-feedback-warning/10 text-feedback-warning"
      : "border-feedback-danger/50 bg-feedback-danger/10 text-feedback-danger";
  const spanCounts = { matched: 0, sourceOnly: 0, targetOnly: 0, ambiguous: 0 };
  timeMap?.spans.forEach((span) => {
    spanCounts[span.kind] += 1;
  });

  return (
    <section
      className={`mt-3 rounded border p-2.5 ${panelClass}`}
      data-testid={testId}
      role={gate.kind === "missing" || gate.kind === "state-error" ? "alert" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-2 py-0.5 text-ui-caption font-medium ${badgeClass}`}
          data-testid="time-map-quality-label"
        >
          {gate.label}
        </span>
        <span className="text-ui-caption font-medium">
          导出状态：
          {gate.exportReady
            ? "可以导出"
            : gate.manualTakeoverAvailable
              ? "可建立人工方案"
              : gate.canSaveRelationship
                ? "待复核与签发"
                : "不可导出"}
        </span>
      </div>
      <p className="mt-1 leading-5">{gate.message}</p>

      {timeMap ? (
        <details className="mt-2 rounded border border-current/20 bg-surface-inset p-2 text-ui-caption">
          <summary className="cursor-pointer rounded font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan">
            时间图证据详情
          </summary>
          <div className="mt-2 grid gap-1.5 text-content-secondary">
            <div>
              引擎 / 特征：{timeMap.engineVersion || "未记录"} /{" "}
              {timeMap.featureVersion || "未记录"}
            </div>
            <div>
              校准概率：
              {timeMap.quality.probability === null
                ? "尚未完成真实基准校准"
                : formatQualityRatio(timeMap.quality.probability)}
            </div>
            <div>
              覆盖率：{formatQualityRatio(timeMap.quality.coverage)} · P95 残差：
              {formatQualityMilliseconds(timeMap.quality.p95ResidualMs)} · P99 残差：
              {formatQualityMilliseconds(timeMap.quality.p99ResidualMs ?? null)} · 最大残差：
              {formatQualityMilliseconds(timeMap.quality.maxResidualMs)} · 边界不确定度：
              {formatQualityMilliseconds(timeMap.quality.boundaryUncertaintyMs)} · Top1/Top2
              差距：{formatQualityRatio(timeMap.quality.alternativeMargin)}
            </div>
            <div>
              独特内容覆盖：{formatQualityRatio(timeMap.quality.uniqueContentCoverage ?? null)}{" "}
              · 锚点：
              {timeMap.quality.anchorCount}（真实留出 {timeMap.quality.heldOutAnchorCount}） ·
              全片支持区域：{timeMap.quality.anchorRegionCount ?? 0}/3
            </div>
            <div>
              时间图片段：matched {spanCounts.matched} · sourceOnly {spanCounts.sourceOnly} ·
              targetOnly {spanCounts.targetOnly} · ambiguous {spanCounts.ambiguous}
            </div>
            <div>
              选中音轨：{formatSelectedStream(timeMap.sourceStream, "参考")}；
              {formatSelectedStream(timeMap.targetStream, "原片")}
            </div>
            <div className="pt-1 font-medium text-content-secondary">主要质量原因</div>
            {timeMap.quality.reasons.length > 0 ? (
              <ul className="list-disc space-y-1 pl-4">
                {timeMap.quality.reasons.slice(0, 4).map((reason, index) => (
                  <li key={`${timeMap.id}-quality-reason-${index}`}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>没有补充原因；请结合实测指标和试听结果判断。</p>
            )}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function UnlinkedLegacyTimeMapWarning() {
  return (
    <section
      className="mt-3 rounded border border-accent-red/35 bg-accent-red/10 p-2.5 text-accent-red"
      data-testid="confirmed-time-map-quality"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-accent-red/50 bg-accent-red/10 px-2 py-0.5 text-ui-caption font-medium">
          已保存关系的时间图缺失
        </span>
        <span className="text-ui-caption font-medium">导出闸门：{statusLabel("blocked")}</span>
      </div>
      <p className="mt-1 leading-5">
        这是只保留供查看的旧关系；正式导出已停用旧规则兼容投影。请用 V2
        重新分析并确认一张可验证时间图。
      </p>
    </section>
  );
}

function describeTimeMapGate(
  timeMap: MediaTimeMap | undefined,
  expectedState: Extract<MediaTimeMapState, "candidate" | "confirmed">
): TimeMapGateDescription {
  const isConfirmedRelation = expectedState === "confirmed";
  if (!timeMap) {
    return {
      kind: "missing",
      label: "时间图缺失",
      message: isConfirmedRelation
        ? "已保存关系的时间图缺失，这条关系数据异常，不能导出；请重新分析或人工建立可验证映射。"
        : "候选时间图缺失，这个候选数据异常，不能确认或导出；请重新运行匹配。",
      canSaveRelationship: false,
      exportReady: false,
      manualTakeoverAvailable: false
    };
  }
  if (timeMap.state !== expectedState) {
    return {
      kind: "state-error",
      label: "时间图异常",
      message: `${isConfirmedRelation ? "已保存关系" : "候选"}引用的时间图状态为 ${timeMap.state}，预期为 ${expectedState}，不能继续保存或导出。`,
      canSaveRelationship: false,
      exportReady: false,
      manualTakeoverAvailable: false
    };
  }

  const manualTakeoverAvailable =
    !isConfirmedRelation &&
    Boolean(timeMap.sourceIdentity && timeMap.targetIdentity) &&
    timeMap.spans.length > 0 &&
    validateTimeMap(timeMap.spans).valid;

  if (isConfirmedRelation && isTimeMapManualTakeoverExportApproved(timeMap)) {
    return {
      kind: "manual-takeover",
      label: "人工接管",
      message:
        "你已明确采用系统最高可能性建议并接受潜在错位风险；当前方案可以导出，自动门控诊断仍完整保留。",
      canSaveRelationship: true,
      exportReady: true,
      manualTakeoverAvailable: false
    };
  }

  if (timeMap.quality.level === "verified") {
    return {
      kind: "verified",
      label: "已验证",
      message: isConfirmedRelation
        ? "已验证时间图达到导出质量门槛，可用于导出。"
        : "质量指标已达到导出门槛；确认关系后可用于导出。",
      canSaveRelationship: true,
      exportReady: true,
      manualTakeoverAvailable: false
    };
  }
  if (timeMap.quality.level === "review") {
    return {
      kind: "review",
      label: statusLabel("reviewRequired"),
      message: isConfirmedRelation
        ? "关系已保存供试听复核，但仍不能导出；当前引擎尚未完成真实基准校准，本版本不会把试听结果伪装成已验证。"
        : "可采用系统建议直接建立人工导出方案，也可只保存关系继续试听；自动质量结论仍保留为“需复核”。",
      canSaveRelationship: true,
      exportReady: false,
      manualTakeoverAvailable
    };
  }
  if (timeMap.quality.level === "legacy-unverified") {
    return {
      kind: "legacy-unverified",
      label: "旧版未验证",
      message: isConfirmedRelation
        ? "旧版关系仅保留供试听复核，仍不能导出；需要用完成真实媒体校准的 V2 重新分析。"
        : manualTakeoverAvailable
          ? "旧版候选可由你明确接管并导出，但建议优先重新分析；原始风险诊断会保留。"
          : "可以保存旧版关系供试听复核，但缺少人工接管所需的媒体身份或合法分段。",
      canSaveRelationship: true,
      exportReady: false,
      manualTakeoverAvailable
    };
  }
  return {
    kind: "blocked",
    label: isConfirmedRelation ? "需重新处理" : "可人工接管",
    message: isConfirmedRelation
      ? "自动质量门槛未通过；如已检查风险，可签发人工方案后导出。"
      : "自动确认未通过；可重新分析，也可接受潜在错位并采用系统建议建立人工方案。",
    canSaveRelationship: false,
    exportReady: false,
    manualTakeoverAvailable
  };
}

function formatQualityRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "未提供";
  }
  const percentage = value * 100;
  return `${percentage.toFixed(Number.isInteger(percentage) ? 0 : 1)}%`;
}

function formatQualityMilliseconds(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "未提供" : `${Math.round(value)} 毫秒`;
}

function formatSelectedStream(
  stream: MediaTimeMapStreamIdentity | null,
  role: "参考" | "原片"
): string {
  if (!stream) {
    return `${role}音轨未记录`;
  }
  const details = [
    stream.codec?.toUpperCase() ?? null,
    stream.sampleRate === null ? null : `${stream.sampleRate} Hz`,
    stream.channels === null ? null : `${stream.channels} 声道`,
    stream.language,
    stream.title
  ].filter((value): value is string => Boolean(value));
  return `${role}${stream.type === "audio" ? "音轨" : "视频流"} #${stream.index}${
    details.length > 0 ? ` · ${details.join(" · ")}` : ""
  }`;
}

function ConfirmedRelations({ project }: { project: EditorProject }) {
  const confirmed = project.danmakuSourceSegments.filter(
    (segment) => segment.kind === "content"
  );
  const sourceIds = [
    ...new Set(
      confirmed
        .map((segment) => segment.sourceMediaId)
        .filter((id): id is string => Boolean(id))
    )
  ];
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium text-content-primary">已保存关系</h4>
      {sourceIds.length === 0 ? (
        <p className="mt-2 rounded border border-dashed border-panel-line p-3 leading-5 text-content-muted">
          尚无已保存关系。保存候选后，会按参考素材分别显示多条映射；完成复核和验证前，这些关系不能用于正式导出。
        </p>
      ) : (
        <div className="mt-2 grid gap-2" data-testid="confirmed-media-relations">
          {sourceIds.map((sourceId) => {
            const source = findProjectMedia(project, sourceId);
            const segments = confirmed
              .filter((segment) => segment.sourceMediaId === sourceId)
              .sort((left, right) => left.sourceStartMs - right.sourceStartMs);
            return (
              <article
                key={sourceId}
                className="rounded border border-panel-line bg-surface-inset p-2"
              >
                <div className="font-medium text-content-secondary">
                  {source?.name ?? sourceId}
                </div>
                <div className="mt-2 grid gap-1">
                  {segments.map((segment) => {
                    const target = findProjectMedia(project, segment.targetMediaId);
                    const asset = project.assets.find(
                      (candidate) => candidate.id === segment.assetId
                    );
                    const confirmedTimeMap = segment.timeMapId
                      ? project.mediaTimeMaps.find(
                          (timeMap) => timeMap.id === segment.timeMapId
                        )
                      : undefined;
                    return (
                      <div
                        key={segment.id}
                        className="rounded bg-surface-inset px-2 py-1.5 text-content-muted"
                      >
                        <div className="font-medium text-content-secondary">
                          {segment.label}
                        </div>
                        <div className="mt-0.5 text-ui-caption text-content-muted">
                          作用 XML：{asset?.fileName ?? "XML 已移除"}
                        </div>
                        <div className="mt-0.5">
                          {formatTimecode(segment.sourceStartMs)}–
                          {formatTimecode(segment.sourceEndMs)} → {target?.name ?? "未选择原片"}{" "}
                          {formatTimecode(segment.targetStartMs ?? 0)} 起 ·{" "}
                          {segment.timingRules.length} 处删减修正
                        </div>
                        {segment.timeMapId === null ? (
                          <UnlinkedLegacyTimeMapWarning />
                        ) : (
                          <TimeMapQualitySummary
                            timeMap={confirmedTimeMap}
                            expectedState="confirmed"
                            testId="confirmed-time-map-quality"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function danmakuEvidenceForSource(
  project: EditorProject,
  sourceMediaId: string,
  suspectedCutCandidates: SuspectedCutCandidate[]
) {
  const boundAssetIds = new Set(
    project.danmakuSourceBindings
      .filter(
        (binding) =>
          binding.sourceMediaId === sourceMediaId &&
          project.assets.some((asset) => asset.id === binding.assetId)
      )
      .map((binding) => binding.assetId)
  );
  return {
    assets: project.assets.filter((asset) => boundAssetIds.has(asset.id)),
    suspectedCutCandidates: suspectedCutCandidates.filter((candidate) =>
      boundAssetIds.has(candidate.assetId)
    )
  };
}

function requireLocalPath(media: ProjectMediaReference): string {
  const path = media.localPath?.trim();
  if (!path) {
    throw new Error(`${media.name} 没有可供 FFmpeg 使用的本地路径，请回素材页重新连接。`);
  }
  return path;
}

function normalizeLocalPath(path: string | null | undefined): string {
  return (
    path?.trim().replace(/\//g, "\\").replace(/\\+/g, "\\").toLocaleLowerCase("en-US") ?? ""
  );
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}

function createMediaPairKey(sourceMediaId: string, targetMediaId: string): string {
  return `${sourceMediaId}\u0000${targetMediaId}`;
}

function candidateStateText(
  candidate: MediaMatchCandidate,
  gate: TimeMapGateDescription
): string {
  if (candidate.state === "pending") return "待复核";
  if (candidate.state === "accepted") {
    if (gate.kind === "manual-takeover") return "人工接管 · 可导出";
    return gate.exportReady ? "已验证 · 可导出" : "关系已保存 / 待完成复核";
  }
  if (candidate.state === "rejected") return "已忽略";
  if (candidate.proposal.timeMap?.quality.level === "blocked") return "可人工接管";
  return "缺少 XML 绑定";
}

function candidateStateClass(
  state: MediaMatchCandidate["state"],
  exportReady: boolean
): string {
  if (state === "accepted")
    return exportReady
      ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
      : "border-accent-yellow/40 bg-accent-yellow/10 text-accent-yellow";
  if (state === "rejected") return "border-panel-line bg-surface-inset text-content-muted";
  if (state === "blocked")
    return "border-accent-yellow/40 bg-accent-yellow/10 text-accent-yellow";
  return "border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan";
}

function describeAudioTrackPreparation(
  preparation: AudioTrackPreparation
): MatchingAudioPreparationView {
  if (preparation.state === "ready") {
    return {
      ready: true,
      label:
        preparation.source === "explicit"
          ? `音轨已准备 · 已选择 #${preparation.finalStreamIndex}`
          : `音轨已准备 · 自动 #${preparation.finalStreamIndex}`
    };
  }
  if (preparation.state === "preparing") {
    return { ready: false, label: "音轨准备中" };
  }
  if (preparation.state === "needsChoice") {
    return { ready: false, label: "需要选择音轨" };
  }
  if (preparation.state === "needsReview") {
    return { ready: false, label: "需要复核音轨" };
  }
  if (preparation.state === "unavailable") {
    return { ready: false, label: "没有可用音轨" };
  }
  if (preparation.state === "failed") {
    return { ready: false, label: "音轨准备失败" };
  }
  if (preparation.state === "cancelled") {
    return { ready: false, label: "音轨准备已取消" };
  }
  return {
    ready: false,
    label:
      preparation.reason === "needsReconnect"
        ? "重新连接后才能准备音轨"
        : "缺少本地路径，无法准备音轨"
  };
}

function requireReadyAudioStreamIndex(
  preparation: AudioTrackPreparation | null,
  mediaId: string
): number {
  if (!preparation || preparation.state !== "ready") {
    throw new Error(`媒体 ${mediaId} 的音轨尚未准备好。`);
  }
  return preparation.finalStreamIndex;
}

function areMediaInventoryGenerationKeysEqual(
  left: MediaInventoryGenerationKey | null,
  right: MediaInventoryGenerationKey | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.projectId === right.projectId &&
    left.projectEpoch === right.projectEpoch &&
    left.inventoryGeneration === right.inventoryGeneration &&
    left.mediaSignature === right.mediaSignature
  );
}

function setEditorStatus(message: string, tone: "neutral" | "success" | "warning" | "error") {
  useEditorStore.setState({ status: { message, tone } });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 350));
}
