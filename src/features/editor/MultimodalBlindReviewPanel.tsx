import { subscribeNativeVideoLayout } from "../../infrastructure/media/nativeVideoLayout";
import { Button } from "../../components/Button";
import { isTauri } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, FileUp, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS,
  buildMultimodalBlindReviewVoteSet,
  createUnreviewedBlindAnswer,
  parseMultimodalBlindReviewPackJson,
  serializeMultimodalBlindReviewVoteSet,
  type MultimodalBlindReviewAnswer,
  type MultimodalBlindReviewPack,
  type MultimodalBlindReviewPrecision,
  type MultimodalBlindReviewTask,
  type MultimodalBlindReviewVoteSet
} from "../../domain/alignment/multimodalBlindReview";
import {
  buildMultimodalBlindAdjudication,
  buildMultimodalBlindLabelMerge,
  parseMultimodalBlindAdjudicationJson,
  parseMultimodalBlindReviewVoteSetJson,
  serializeMultimodalBlindAdjudication,
  serializeMultimodalBlindLabelMergeReceipt,
  serializeMultimodalBlindPrivateLabels,
  type MultimodalBlindAdjudication
} from "../../domain/alignment/multimodalBlindAdjudication";
import { formatTimecode } from "../../domain/shared/time";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import {
  TauriLibMpvMediaAdapter,
  type EmbeddedMpvMediaAdapter,
  type MediaAdapter
} from "../../infrastructure/media/mediaAdapter";
import { measureNativeVideoBounds } from "../../infrastructure/media/tauriLibMpvPlayer";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import {
  clearDesktopMultimodalBlindReviewDraft,
  hydrateDesktopMultimodalBlindReviewDraft,
  persistDesktopMultimodalBlindReviewDraft,
  type MultimodalBlindReviewDraftStorage
} from "../../infrastructure/alignment/multimodalBlindReviewDraftStore";

type BlindReviewSide = "source" | "target";

export type MultimodalBlindReviewAdapterFactory = (options: {
  nativeHost: HTMLDivElement;
  sessionId: string;
  mpvPath: string;
}) => MediaAdapter;

interface MultimodalBlindReviewPanelProps {
  adapterFactory?: MultimodalBlindReviewAdapterFactory;
  desktopAvailableOverride?: boolean;
  draftStorage?: MultimodalBlindReviewDraftStorage | null;
  downloadText?: typeof downloadTextFile;
  initialPackJson?: string | null;
}

const defaultAdapterFactory: MultimodalBlindReviewAdapterFactory = ({
  nativeHost,
  sessionId,
  mpvPath
}) =>
  new TauriLibMpvMediaAdapter({
    sessionId,
    mpvPath,
    getBounds: () => measureNativeVideoBounds(nativeHost)
  });

export function MultimodalBlindReviewPanel({
  adapterFactory = defaultAdapterFactory,
  desktopAvailableOverride,
  draftStorage,
  downloadText = downloadTextFile,
  initialPackJson = null
}: MultimodalBlindReviewPanelProps) {
  const desktopAvailable = desktopAvailableOverride ?? isTauri();
  const mpvPath = loadAppSettings().player.mpvPath;
  const nativeHostRef = useRef<HTMLDivElement | null>(null);
  const adapterRef = useRef<MediaAdapter | null>(null);
  const loadedSideRef = useRef<BlindReviewSide | null>(null);
  const positionRef = useRef(0);
  const playingRef = useRef(false);
  const operationRef = useRef(0);
  const suppressNextDraftWriteRef = useRef(false);
  const initialPackIdRef = useRef<string | null>(null);
  const [pack, setPack] = useState<MultimodalBlindReviewPack | null>(null);
  const [answers, setAnswers] = useState<MultimodalBlindReviewAnswer[]>([]);
  const [collectedVoteSets, setCollectedVoteSets] = useState<MultimodalBlindReviewVoteSet[]>(
    []
  );
  const [familyAdjudications, setFamilyAdjudications] = useState<MultimodalBlindAdjudication[]>(
    []
  );
  const [currentTaskIndex, setCurrentTaskIndex] = useState(0);
  const [reviewerId, setReviewerId] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [adapterReady, setAdapterReady] = useState(false);
  const [activeSide, setActiveSide] = useState<BlindReviewSide>("source");
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlayingState] = useState(false);
  const [loading, setLoading] = useState(false);
  const [draftStored, setDraftStored] = useState<boolean | null>(null);
  const [status, setStatus] = useState("导入本机盲复核任务包后开始。候选来源始终隐藏。");
  const [error, setError] = useState<string | null>(null);

  const currentTask = pack?.tasks[currentTaskIndex] ?? null;
  const answerByTaskId = useMemo(
    () => new Map(answers.map((answer) => [answer.taskId, answer])),
    [answers]
  );
  const currentAnswer = currentTask
    ? (answerByTaskId.get(currentTask.taskId) ??
      createUnreviewedBlindAnswer(currentTask.taskId))
    : null;
  const reviewedCount = answers.filter((answer) => answer.decision !== "unreviewed").length;
  const frameAccurateCount = answers.filter(
    (answer) => answer.decision === "matched" && answer.precision === "frameAccurate"
  ).length;
  const adjudication = useMemo(() => {
    if (!pack || collectedVoteSets.length < 2) return null;
    try {
      return buildMultimodalBlindAdjudication(pack, collectedVoteSets);
    } catch {
      return null;
    }
  }, [collectedVoteSets, pack]);
  const frozenMerge = useMemo(() => {
    if (familyAdjudications.length < 3) return null;
    try {
      return buildMultimodalBlindLabelMerge(familyAdjudications);
    } catch {
      return null;
    }
  }, [familyAdjudications]);
  const frozenMergeIssue = useMemo(() => {
    if (familyAdjudications.length < 3) {
      return `还缺 ${3 - familyAdjudications.length} 个独立媒体家族。`;
    }
    try {
      buildMultimodalBlindLabelMerge(familyAdjudications);
      return null;
    } catch (mergeError) {
      return mergeError instanceof Error ? mergeError.message : "冻结准备证据仍不完整。";
    }
  }, [familyAdjudications]);
  const activeInterval = useMemo(
    () => (currentTask ? intervalForSide(currentTask, activeSide) : null),
    [activeSide, currentTask]
  );
  const nativeSessionId = useMemo(
    () => `blind_review_${(pack?.packId ?? "empty").slice(-40)}`.slice(0, 64),
    [pack?.packId]
  );

  const setPlaying = useCallback((value: boolean) => {
    playingRef.current = value;
    setPlayingState(value);
  }, []);

  const updatePosition = useCallback((value: number) => {
    const normalized = Math.max(0, Math.round(value));
    positionRef.current = normalized;
    setPositionMs(normalized);
  }, []);

  useEffect(() => {
    if (!pack || !currentTask) return;
    if (suppressNextDraftWriteRef.current) {
      suppressNextDraftWriteRef.current = false;
      return;
    }
    let cancelled = false;
    void persistDesktopMultimodalBlindReviewDraft(
      pack,
      currentTask.taskId,
      answers,
      draftStorage
    )
      .then((stored) => {
        if (!cancelled) setDraftStored(stored);
      })
      .catch(() => {
        if (!cancelled) setDraftStored(false);
      });
    return () => {
      cancelled = true;
    };
  }, [answers, currentTask, draftStorage, pack]);

  useEffect(() => {
    operationRef.current += 1;
    adapterRef.current?.pause();
    loadedSideRef.current = null;
    setPlaying(false);
    setLoading(false);
    setError(null);
    setActiveSide("source");
    updatePosition(currentTask?.sourceTimestampMs ?? 0);
  }, [currentTask, setPlaying, updatePosition]);

  useEffect(() => {
    if (!playerOpen || !desktopAvailable || !pack) {
      setAdapterReady(false);
      return;
    }
    const nativeHost = nativeHostRef.current;
    if (!nativeHost) return;
    const adapter = adapterFactory({ nativeHost, sessionId: nativeSessionId, mpvPath });
    let cancelled = false;
    adapterRef.current = adapter;
    setAdapterReady(false);
    setLoading(true);
    setError(null);
    setStatus("正在检查应用内播放器运行库…");
    const embeddedAdapter = adapter as Partial<EmbeddedMpvMediaAdapter>;
    void (embeddedAdapter.prepare?.() ?? Promise.resolve())
      .then(() => {
        if (cancelled) return;
        setAdapterReady(true);
        setStatus("播放器运行库可用，正在载入当前复核画面…");
      })
      .catch((prepareError) => {
        if (cancelled) return;
        setAdapterReady(false);
        setError(
          `应用内播放器不可用：${prepareError instanceof Error ? prepareError.message : String(prepareError)}`
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      operationRef.current += 1;
      adapter.pause();
      adapter.dispose();
      if (adapterRef.current === adapter) adapterRef.current = null;
      loadedSideRef.current = null;
      playingRef.current = false;
    };
  }, [adapterFactory, desktopAvailable, mpvPath, nativeSessionId, pack, playerOpen]);

  useEffect(() => {
    const host = nativeHostRef.current;
    if (!playerOpen || !adapterReady || !host || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const updateBounds = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const adapter = adapterRef.current as EmbeddedMpvMediaAdapter | null;
        adapter?.setHostBounds?.(measureNativeVideoBounds(host));
      });
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(host);
    const unsubscribeLayout = subscribeNativeVideoLayout(updateBounds);
    window.addEventListener("resize", updateBounds);
    window.addEventListener("scroll", updateBounds, true);
    updateBounds();
    return () => {
      unsubscribeLayout();
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      window.removeEventListener("scroll", updateBounds, true);
      window.cancelAnimationFrame(frame);
    };
  }, [adapterReady, playerOpen]);

  useEffect(() => {
    if (!playerOpen || !adapterReady || !activeInterval) return;
    const timer = window.setInterval(() => {
      const adapter = adapterRef.current;
      if (!adapter || loadedSideRef.current !== activeSide) return;
      const current = adapter.getCurrentTimeMs();
      updatePosition(current);
      if (playingRef.current && current >= activeInterval.endMs) {
        adapter.pause();
        setPlaying(false);
        setStatus(`已到${sideLabel(activeSide)}复核窗口末端并暂停。`);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [activeInterval, activeSide, adapterReady, playerOpen, setPlaying, updatePosition]);

  const loadSide = useCallback(
    async (
      side: BlindReviewSide,
      requestedPositionMs: number,
      autoplay = false
    ): Promise<void> => {
      const adapter = adapterRef.current;
      const task = currentTask;
      const media = side === "source" ? pack?.source : pack?.target;
      if (!adapter || !task || !media) {
        setError("播放器尚未准备完成。请确认桌面版已配置 libmpv。");
        return;
      }
      const interval = intervalForSide(task, side);
      const safePosition = Math.min(
        Math.max(interval.startMs, Math.round(requestedPositionMs)),
        interval.endMs - 1
      );
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      adapter.pause();
      setPlaying(false);
      setLoading(true);
      setError(null);
      try {
        if (loadedSideRef.current !== side) {
          await adapter.load(
            { kind: "file", name: sideLabel(side), url: media.path },
            safePosition
          );
        } else {
          adapter.seek(safePosition);
        }
        if (operationRef.current !== operation) return;
        loadedSideRef.current = side;
        adapter.setPlaybackRate(1);
        setActiveSide(side);
        updatePosition(safePosition);
        if (autoplay) {
          await adapter.play();
          if (operationRef.current !== operation) return;
          setPlaying(true);
        }
        setStatus(
          `${autoplay ? "正在播放" : "已定位到"}${sideLabel(side)} ${formatTimecode(safePosition)}。候选来源仍保持隐藏。`
        );
      } catch (loadError) {
        if (operationRef.current === operation) {
          loadedSideRef.current = null;
          setPlaying(false);
          setError(
            `应用内视频复核失败：${loadError instanceof Error ? loadError.message : String(loadError)}`
          );
        }
      } finally {
        if (operationRef.current === operation) setLoading(false);
      }
    },
    [currentTask, pack, setPlaying, updatePosition]
  );

  useEffect(() => {
    if (!playerOpen || !adapterReady || !currentTask || loadedSideRef.current !== null) return;
    const requestedPosition =
      activeSide === "source"
        ? currentTask.sourceTimestampMs
        : (currentAnswer?.targetTimestampMs ?? currentTask.targetReviewStartMs);
    void loadSide(activeSide, requestedPosition);
  }, [
    activeSide,
    adapterReady,
    currentAnswer?.targetTimestampMs,
    currentTask,
    loadSide,
    playerOpen
  ]);

  const setTaskAnswer = useCallback((answer: MultimodalBlindReviewAnswer): void => {
    setAnswers((current) => [
      ...current.filter((item) => item.taskId !== answer.taskId),
      answer
    ]);
  }, []);

  const chooseCandidate = (slotId: string, timestampMs: number): void => {
    if (!currentTask) return;
    setTaskAnswer({
      taskId: currentTask.taskId,
      decision: "matched",
      targetTimestampMs: timestampMs,
      boundaryToleranceMs: MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS,
      precision: "playbackChecked"
    });
    setActiveSide("target");
    updatePosition(timestampMs);
    setStatus(`已选择候选 ${slotId}，当前只算“播放核对”弱票；逐帧确认需在下方主动选择。`);
    if (playerOpen && adapterReady) void loadSide("target", timestampMs);
  };

  const setDecisionWithoutTarget = (decision: "no-match" | "unsure"): void => {
    if (!currentTask) return;
    setTaskAnswer({
      taskId: currentTask.taskId,
      decision,
      targetTimestampMs: null,
      boundaryToleranceMs: null,
      precision: currentAnswer?.precision ?? "rough"
    });
  };

  const changePrecision = (precision: MultimodalBlindReviewPrecision): void => {
    if (!currentTask || !currentAnswer || currentAnswer.decision === "unreviewed") return;
    setTaskAnswer({
      ...currentAnswer,
      precision,
      boundaryToleranceMs:
        precision === "frameAccurate" && currentAnswer.boundaryToleranceMs !== null
          ? Math.min(
              currentAnswer.boundaryToleranceMs,
              MULTIMODAL_BLIND_REVIEW_MAX_TOLERANCE_MS
            )
          : currentAnswer.boundaryToleranceMs
    });
  };

  const openPack = useCallback(
    async (imported: MultimodalBlindReviewPack): Promise<void> => {
      setPlayerOpen(false);
      setError(null);
      try {
        initialPackIdRef.current = imported.packId;
        const draft = await hydrateDesktopMultimodalBlindReviewDraft(imported, draftStorage);
        const taskIndex = draft
          ? Math.max(
              0,
              imported.tasks.findIndex((task) => task.taskId === draft.currentTaskId)
            )
          : 0;
        setPack(imported);
        setAnswers(draft?.answers ?? []);
        setCollectedVoteSets([]);
        setCurrentTaskIndex(taskIndex);
        setReviewerId("");
        setDraftStored(draft ? true : null);
        setStatus(
          draft
            ? `已恢复这份任务包的 ${draft.answers.filter((answer) => answer.decision !== "unreviewed").length} 条本机草稿；复核者代号不会恢复。`
            : `已导入 ${imported.tasks.length} 个盲复核任务。任务包含媒体路径，只留在本机。`
        );
      } catch (importError) {
        setPack(null);
        setAnswers([]);
        setError(importError instanceof Error ? importError.message : "盲复核任务包无法读取。");
      }
    },
    [draftStorage]
  );

  useEffect(() => {
    if (!initialPackJson) return;
    try {
      const imported = parseMultimodalBlindReviewPackJson(initialPackJson);
      if (initialPackIdRef.current === imported.packId) return;
      initialPackIdRef.current = imported.packId;
      void openPack(imported);
    } catch (initialPackError) {
      setError(
        initialPackError instanceof Error
          ? initialPackError.message
          : "自动生成的盲复核任务包无法读取。"
      );
    }
  }, [initialPackJson, openPack]);

  const importPack = async (file: File): Promise<void> => {
    try {
      await openPack(parseMultimodalBlindReviewPackJson(await readTextFile(file)));
    } catch (importError) {
      setPack(null);
      setAnswers([]);
      setError(importError instanceof Error ? importError.message : "盲复核任务包无法读取。");
    }
  };

  const exportVote = (): void => {
    if (!pack) return;
    try {
      const voteSet = buildMultimodalBlindReviewVoteSet(pack, reviewerId, answers);
      downloadText(
        `danmaku-multimodal-blind-vote-${voteSet.voteSetId.slice(7, 23)}.json`,
        serializeMultimodalBlindReviewVoteSet(voteSet),
        "application/json;charset=utf-8"
      );
      setError(null);
      const existing = collectedVoteSets.find(
        (item) => item.reviewerIdDigest === voteSet.reviewerIdDigest
      );
      if (!existing) addCollectedVoteSets([voteSet]);
      setStatus(
        existing && existing.voteSetId !== voteSet.voteSetId
          ? "修订票已导出；收集区仍保留该复核者的旧票，请先移除旧票再导入修订版。"
          : `已导出 ${reviewedCount}/${pack.tasks.length} 条复核票；未完成项保持 unreviewed，原始复核者代号没有写入文件。`
      );
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "盲复核票据无法生成。");
    }
  };

  const addCollectedVoteSets = (incoming: MultimodalBlindReviewVoteSet[]): number => {
    const next = [...collectedVoteSets];
    for (const voteSet of incoming) {
      if (next.some((item) => item.voteSetId === voteSet.voteSetId)) continue;
      if (next.some((item) => item.reviewerIdDigest === voteSet.reviewerIdDigest)) {
        throw new Error("同一复核者已有另一份匿名票；请先移除旧票，再明确导入替代版本。");
      }
      next.push(voteSet);
    }
    next.sort((left, right) =>
      left.reviewerIdDigest < right.reviewerIdDigest
        ? -1
        : left.reviewerIdDigest > right.reviewerIdDigest
          ? 1
          : 0
    );
    setCollectedVoteSets(next);
    return next.length;
  };

  const importVoteFiles = async (files: File[]): Promise<void> => {
    if (!pack) {
      setError("请先打开对应的盲复核任务包，再导入匿名复核票。");
      return;
    }
    try {
      const imported: MultimodalBlindReviewVoteSet[] = [];
      for (const file of files) {
        imported.push(parseMultimodalBlindReviewVoteSetJson(await readTextFile(file), pack));
      }
      const total = addCollectedVoteSets(imported);
      setError(null);
      setStatus(`已收集 ${total} 名复核者的匿名票；重复文件不会重复计数。`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "匿名复核票无法读取。");
    }
  };

  const addFamilyAdjudications = (incoming: MultimodalBlindAdjudication[]): void => {
    const next = [...familyAdjudications];
    for (const adjudicationValue of incoming) {
      if (next.some((item) => item.adjudicationId === adjudicationValue.adjudicationId))
        continue;
      if (next.some((item) => item.mediaFamilyId === adjudicationValue.mediaFamilyId)) {
        throw new Error("同一个媒体家族已有另一份裁决；请先移除旧裁决，再明确导入替代版本。");
      }
      next.push(adjudicationValue);
    }
    next.sort((left, right) =>
      left.mediaFamilyId < right.mediaFamilyId
        ? -1
        : left.mediaFamilyId > right.mediaFamilyId
          ? 1
          : 0
    );
    setFamilyAdjudications(next);
  };

  const importAdjudicationFiles = async (files: File[]): Promise<void> => {
    try {
      const imported: MultimodalBlindAdjudication[] = [];
      for (const file of files) {
        imported.push(parseMultimodalBlindAdjudicationJson(await readTextFile(file)));
      }
      addFamilyAdjudications(imported);
      setError(null);
      setStatus("家族裁决已加入冻结准备区；只有三家族、每族 20 条且全部 Gold 才会生成承诺。");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "家族裁决无法读取。");
    }
  };

  const clearDraft = async (): Promise<void> => {
    if (!pack || !window.confirm("清除这份任务包的本机复核草稿？已导出的票据不会被删除。"))
      return;
    try {
      await clearDesktopMultimodalBlindReviewDraft(pack.packId, draftStorage);
      suppressNextDraftWriteRef.current = true;
      setAnswers([]);
      setCurrentTaskIndex(0);
      setDraftStored(null);
      setStatus("本机应用数据中的草稿已清除，任务包仍保持打开。");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "本机草稿清理失败。");
    }
  };

  const useCurrentTargetPosition = (): void => {
    if (!currentTask || activeSide !== "target") return;
    const targetTimestampMs = Math.min(
      currentTask.targetReviewEndMs,
      Math.max(currentTask.targetReviewStartMs, Math.round(positionRef.current))
    );
    setTaskAnswer({
      taskId: currentTask.taskId,
      decision: "matched",
      targetTimestampMs,
      boundaryToleranceMs: currentAnswer?.boundaryToleranceMs ?? 1_000,
      precision: currentAnswer?.precision ?? "playbackChecked"
    });
    setStatus(`已把当前原片位置 ${formatTimecode(targetTimestampMs)} 记为答案。`);
  };

  const togglePlayback = async (): Promise<void> => {
    if (!currentTask || !activeInterval) return;
    const adapter = adapterRef.current;
    if (!adapter) {
      setError("播放器尚未准备完成。");
      return;
    }
    if (playingRef.current) {
      adapter.pause();
      setPlaying(false);
      setStatus(`已暂停${sideLabel(activeSide)}。`);
      return;
    }
    const safePosition =
      positionRef.current >= activeInterval.startMs &&
      positionRef.current < activeInterval.endMs
        ? positionRef.current
        : activeInterval.startMs;
    if (loadedSideRef.current !== activeSide) {
      await loadSide(activeSide, safePosition, true);
      return;
    }
    try {
      await adapter.play();
      setPlaying(true);
      setStatus(`正在播放${sideLabel(activeSide)}复核窗口。`);
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : "播放器启动失败。");
    }
  };

  return (
    <details
      className="mt-3 rounded border border-feedback-running/25 bg-feedback-running/10 p-3"
      data-testid="multimodal-blind-review-panel"
    >
      <summary className="cursor-pointer select-none font-medium text-content-secondary">
        盲复核与真实 Gold（实验）
      </summary>
      <p className="mt-2 leading-5 text-content-muted">
        可直接处理真实匹配证据或多模态候选；只显示打乱后的
        A/B/C/D，不暴露系统推荐。这里生成复核票和冻结准备证据，不会修改 TimeMap 或放行导出。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary">
          <FileUp size={12} className="mr-1 inline" aria-hidden="true" />
          导入盲复核任务包
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="导入多模态盲复核任务包"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importPack(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {pack ? (
          <>
            <span className="text-content-muted">
              已复核 {reviewedCount}/{pack.tasks.length} · 逐帧匹配 {frameAccurateCount}
            </span>
            <span className="text-content-muted">
              {draftStored === true
                ? "草稿已保存在本机应用数据"
                : draftStored === false
                  ? "草稿保存失败"
                  : "尚无草稿"}
            </span>
            <Button
              tone="unstyled"
              type="button"
              className="text-content-muted hover:text-content-secondary"
              onClick={() => void clearDraft()}
            >
              清除草稿
            </Button>
          </>
        ) : null}
      </div>

      {pack && currentTask && currentAnswer ? (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded border border-panel-line/70 bg-surface-inset p-2">
            <TextButton
              disabled={currentTaskIndex === 0}
              aria-label="上一个盲复核任务"
              onClick={() => setCurrentTaskIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft size={13} />
              上一个
            </TextButton>
            <span className="font-medium text-content-secondary">
              任务 {currentTaskIndex + 1}/{pack.tasks.length}
            </span>
            <TextButton
              disabled={currentTaskIndex >= pack.tasks.length - 1}
              aria-label="下一个盲复核任务"
              onClick={() =>
                setCurrentTaskIndex((index) => Math.min(pack.tasks.length - 1, index + 1))
              }
            >
              下一个
              <ChevronRight size={13} />
            </TextButton>
            <span className="ml-auto text-content-muted">
              A 参考定位 {formatTimecode(currentTask.sourceTimestampMs)} · B 检查范围{" "}
              {formatTimecode(currentTask.targetReviewStartMs)}–
              {formatTimecode(currentTask.targetReviewEndMs)}
            </span>
          </div>

          <div className="rounded border border-panel-line/70 bg-surface-inset p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-content-secondary">选择候选位置</span>
              <span className="text-content-muted">字母已确定性打乱，不代表任何模型顺序。</span>
            </div>
            <div
              className="mt-2 grid gap-2 sm:grid-cols-4"
              role="group"
              aria-label="盲复核候选位置"
            >
              {currentTask.candidateSlots.map((slot) => (
                <TextButton
                  key={slot.slotId}
                  tone={
                    currentAnswer.targetTimestampMs === slot.timestampMs ? "primary" : "neutral"
                  }
                  aria-pressed={currentAnswer.targetTimestampMs === slot.timestampMs}
                  onClick={() => chooseCandidate(slot.slotId, slot.timestampMs)}
                >
                  {slot.slotId} · {formatTimecode(slot.timestampMs)}
                </TextButton>
              ))}
            </div>
          </div>

          <div className="rounded border border-panel-line/70 bg-surface-inset p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-content-secondary">应用内 A/B 播放</span>
              <TextButton
                className="ml-auto"
                disabled={!desktopAvailable || mpvPath.trim().length === 0}
                aria-expanded={playerOpen}
                onClick={() => setPlayerOpen((open) => !open)}
              >
                {playerOpen ? "关闭播放器" : "打开播放器"}
              </TextButton>
            </div>
            <p
              className={`mt-1 leading-5 ${desktopAvailable && mpvPath.trim() ? "text-content-muted" : "text-feedback-warning"}`}
            >
              {!desktopAvailable
                ? "盲复核任务包含本地路径，请使用桌面版播放。"
                : mpvPath.trim().length === 0
                  ? "请先在设置中心配置 libmpv，避免弹出独立播放器窗口。"
                  : "同一播放器会在参考 A 与原片 B 之间切换，任一时刻只播放一侧。"}
            </p>
            {playerOpen ? (
              <div className="mt-2 grid gap-2">
                <div
                  ref={nativeHostRef}
                  className="aspect-video w-full overflow-hidden rounded border border-panel-line bg-black"
                  aria-label="DINOv2 盲复核应用内视频画面"
                >
                  <div className="flex h-full items-center justify-center px-4 text-center text-xs leading-5 text-white/80">
                    {error
                      ? error
                      : loading
                        ? "正在检测 libmpv 并载入当前画面…"
                        : adapterReady
                          ? "播放器已连接；当前 A/B 画面正在载入。"
                          : "等待应用内播放器准备完成。"}
                  </div>
                </div>
                <div
                  className="grid gap-2 sm:grid-cols-2"
                  role="group"
                  aria-label="选择盲复核播放来源"
                >
                  <TextButton
                    tone={activeSide === "source" ? "primary" : "neutral"}
                    disabled={!adapterReady || loading}
                    onClick={() => void loadSide("source", currentTask.sourceTimestampMs)}
                  >
                    A · 参考视频
                  </TextButton>
                  <TextButton
                    tone={activeSide === "target" ? "primary" : "neutral"}
                    disabled={!adapterReady || loading}
                    onClick={() =>
                      void loadSide(
                        "target",
                        currentAnswer.targetTimestampMs ?? currentTask.targetReviewStartMs
                      )
                    }
                  >
                    B · 目标原片
                  </TextButton>
                </div>
                {activeInterval ? (
                  <label className="grid gap-1 text-content-muted">
                    <span>
                      {sideLabel(activeSide)}播放位置：{formatTimecode(positionMs)}
                    </span>
                    <input
                      type="range"
                      min={activeInterval.startMs}
                      max={activeInterval.endMs - 1}
                      step={1}
                      value={Math.min(
                        activeInterval.endMs - 1,
                        Math.max(activeInterval.startMs, positionMs)
                      )}
                      disabled={!adapterReady || loading}
                      aria-label={`${sideLabel(activeSide)}盲复核播放位置`}
                      onChange={(event) => {
                        const next = Number(event.currentTarget.value);
                        adapterRef.current?.pause();
                        setPlaying(false);
                        updatePosition(next);
                        if (loadedSideRef.current === activeSide)
                          adapterRef.current?.seek(next);
                      }}
                    />
                  </label>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <TextButton
                    tone="primary"
                    disabled={!adapterReady || loading}
                    onClick={() => void togglePlayback()}
                  >
                    {playing ? <Pause size={13} /> : <Play size={13} />}
                    {playing ? "暂停" : "播放"}
                  </TextButton>
                  <TextButton
                    disabled={!adapterReady || loading || !activeInterval}
                    onClick={() =>
                      activeInterval && void loadSide(activeSide, activeInterval.startMs)
                    }
                  >
                    <RotateCcw size={13} />
                    回到窗口开始
                  </TextButton>
                  <TextButton
                    disabled={activeSide !== "target"}
                    onClick={useCurrentTargetPosition}
                  >
                    用当前 B 位置作为答案
                  </TextButton>
                </div>
              </div>
            ) : null}
          </div>

          <fieldset className="rounded border border-panel-line/70 bg-surface-inset p-2">
            <legend className="px-1 font-medium text-content-secondary">我的判断</legend>
            <div className="flex flex-wrap gap-2">
              <TextButton
                tone={currentAnswer.decision === "no-match" ? "primary" : "neutral"}
                aria-pressed={currentAnswer.decision === "no-match"}
                onClick={() => setDecisionWithoutTarget("no-match")}
              >
                确定没有对应画面
              </TextButton>
              <TextButton
                tone={currentAnswer.decision === "unsure" ? "primary" : "neutral"}
                aria-pressed={currentAnswer.decision === "unsure"}
                onClick={() => setDecisionWithoutTarget("unsure")}
              >
                仍不确定
              </TextButton>
              <TextButton
                tone={currentAnswer.decision === "unreviewed" ? "primary" : "neutral"}
                aria-pressed={currentAnswer.decision === "unreviewed"}
                onClick={() => setTaskAnswer(createUnreviewedBlindAnswer(currentTask.taskId))}
              >
                暂不处理
              </TextButton>
            </div>
            {currentAnswer.decision === "matched" ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-content-muted">
                  原片对应位置（毫秒）
                  <input
                    type="number"
                    min={currentTask.targetReviewStartMs}
                    max={currentTask.targetReviewEndMs}
                    step={1}
                    value={currentAnswer.targetTimestampMs ?? ""}
                    className="h-8 rounded border border-panel-line bg-panel-base px-2 text-xs text-content-secondary outline-none focus:border-accent-cyan"
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      if (
                        !Number.isInteger(next) ||
                        next < currentTask.targetReviewStartMs ||
                        next > currentTask.targetReviewEndMs
                      )
                        return;
                      setTaskAnswer({ ...currentAnswer, targetTimestampMs: next });
                    }}
                  />
                </label>
                <label className="grid gap-1 text-content-muted">
                  允许误差（毫秒）
                  <input
                    type="number"
                    min={0}
                    max={currentAnswer.precision === "frameAccurate" ? 1_000 : 60_000}
                    step={1}
                    value={currentAnswer.boundaryToleranceMs ?? ""}
                    className="h-8 rounded border border-panel-line bg-panel-base px-2 text-xs text-content-secondary outline-none focus:border-accent-cyan"
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      const max = currentAnswer.precision === "frameAccurate" ? 1_000 : 60_000;
                      if (!Number.isInteger(next) || next < 0 || next > max) return;
                      setTaskAnswer({ ...currentAnswer, boundaryToleranceMs: next });
                    }}
                  />
                </label>
              </div>
            ) : null}
            {currentAnswer.decision !== "unreviewed" ? (
              <div className="mt-2 grid gap-1" role="group" aria-label="盲复核核对精度">
                {(
                  [
                    ["rough", "大致看过（弱标签）"],
                    ["playbackChecked", "已用 A/B 播放核对（弱标签）"],
                    ["frameAccurate", "逐帧定位（可参与 Gold）"]
                  ] as Array<[MultimodalBlindReviewPrecision, string]>
                ).map(([precision, label]) => (
                  <label key={precision} className="flex items-center gap-2 text-content-muted">
                    <input
                      type="radio"
                      name={`blind-precision-${currentTask.taskId}`}
                      value={precision}
                      checked={currentAnswer.precision === precision}
                      onChange={() => changePrecision(precision)}
                    />
                    {label}
                  </label>
                ))}
                {currentAnswer.precision === "frameAccurate" ? (
                  <p className="mt-1 text-feedback-warning">
                    逐帧票只有与另一名真实独立复核者在 1 秒内一致时才形成
                    Gold；更换代号重复投票不具备科学有效性。
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>

          <div className="flex flex-wrap items-end gap-2 rounded border border-panel-line/70 bg-surface-inset p-2">
            <label className="grid min-w-64 flex-1 gap-1 text-content-muted">
              本次复核者代号（只导出 SHA-256 摘要，不保存原文）
              <input
                value={reviewerId}
                maxLength={80}
                placeholder="例如 reviewer-demo"
                className="h-8 rounded border border-panel-line bg-panel-base px-2 text-xs text-content-secondary outline-none focus:border-accent-cyan"
                onChange={(event) => setReviewerId(event.currentTarget.value)}
              />
            </label>
            <TextButton
              tone="primary"
              disabled={reviewerId.trim().length < 3}
              onClick={exportVote}
            >
              导出匿名复核票
            </TextButton>
          </div>

          <fieldset className="rounded border border-panel-line/70 bg-surface-inset p-2">
            <legend className="px-1 font-medium text-content-secondary">收集独立复核票</legend>
            <p className="leading-5 text-content-muted">
              把不同真人独立导出的匿名票导回这里。应用只比较摘要和逐任务答案，不显示任何人的原始代号，也不会把弱票升级为
              Gold。
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="cursor-pointer rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary">
                <FileUp size={12} className="mr-1 inline" aria-hidden="true" />
                导入匿名复核票
                <input
                  type="file"
                  multiple
                  accept="application/json,.json"
                  className="sr-only"
                  aria-label="导入匿名复核票"
                  onChange={(event) => {
                    const files = [...(event.currentTarget.files ?? [])];
                    if (files.length > 0) void importVoteFiles(files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <span className="text-content-muted">
                已收集 {collectedVoteSets.length}/2 名独立复核者
              </span>
              {collectedVoteSets.length > 0 ? (
                <Button
                  tone="unstyled"
                  type="button"
                  className="text-content-muted hover:text-content-secondary"
                  onClick={() => setCollectedVoteSets([])}
                >
                  清空已导入票
                </Button>
              ) : null}
            </div>
            {collectedVoteSets.length > 0 ? (
              <div className="mt-2 grid gap-1">
                {collectedVoteSets.map((voteSet) => {
                  const reviewed = voteSet.votes.filter(
                    (vote) => vote.decision !== "unreviewed"
                  ).length;
                  const precise = voteSet.votes.filter(
                    (vote) => vote.precision === "frameAccurate"
                  ).length;
                  return (
                    <div
                      key={voteSet.voteSetId}
                      className="flex flex-wrap items-center gap-2 rounded border border-panel-line/50 px-2 py-1"
                    >
                      <span className="mr-auto text-content-muted">
                        复核者 {voteSet.reviewerIdDigest.slice(7, 15)}… · 已判断 {reviewed}/
                        {voteSet.votes.length} · 逐帧 {precise}
                      </span>
                      <Button
                        tone="unstyled"
                        type="button"
                        className="text-content-muted hover:text-content-secondary"
                        aria-label={`移除复核者 ${voteSet.reviewerIdDigest.slice(7, 15)}`}
                        onClick={() =>
                          setCollectedVoteSets((current) =>
                            current.filter((item) => item.voteSetId !== voteSet.voteSetId)
                          )
                        }
                      >
                        移除
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {adjudication ? (
              <div className="mt-2 rounded border border-feedback-running/25 bg-feedback-running/10 p-2">
                <p className="font-medium text-content-secondary">
                  Gold {adjudication.summary.gold}/{adjudication.summary.tasks} · 冲突{" "}
                  {adjudication.summary.conflicts} · 待精确票 {adjudication.summary.pending} ·
                  仅弱票 {adjudication.summary.weakOnly}
                </p>
                <p className="mt-1 leading-5 text-content-muted">
                  冲突和未完成项不会被隐藏或强行采用；裁决文件不含媒体路径，可在应用重启后重新导入。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <TextButton
                    onClick={() =>
                      downloadText(
                        `danmaku-blind-adjudication-${adjudication.adjudicationId.slice(7, 23)}.json`,
                        serializeMultimodalBlindAdjudication(adjudication),
                        "application/json;charset=utf-8"
                      )
                    }
                  >
                    导出家族裁决
                  </TextButton>
                  {adjudication.summary.gold === adjudication.summary.tasks ? (
                    <TextButton
                      tone="primary"
                      onClick={() =>
                        downloadText(
                          `danmaku-blind-family-labels-${adjudication.adjudicationId.slice(7, 23)}.json`,
                          serializeMultimodalBlindPrivateLabels({
                            labels: adjudication.labels
                          }),
                          "application/json;charset=utf-8"
                        )
                      }
                    >
                      导出本家族 Gold 标签
                    </TextButton>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="mt-2 leading-5 text-feedback-warning/80">
                {collectedVoteSets.length < 2
                  ? "至少需要两名不同真人的匿名票。"
                  : "当前票据无法形成有效裁决，请检查重复复核者或文件绑定。"}
              </p>
            )}
          </fieldset>
        </div>
      ) : null}

      <details className="mt-3 rounded border border-panel-line/70 bg-surface-inset p-2">
        <summary className="cursor-pointer font-medium text-content-secondary">
          三家族冻结准备
        </summary>
        <p className="mt-2 leading-5 text-content-muted">
          导入每个媒体家族已经完成的“家族裁决”。至少三个不同家族、每族 20 条且合计 60 条全部为
          Gold，才会生成私有标签和不可变标签承诺；这里不会训练模型或修改 TimeMap。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="cursor-pointer rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary">
            <FileUp size={12} className="mr-1 inline" aria-hidden="true" />
            导入家族裁决
            <input
              type="file"
              multiple
              accept="application/json,.json"
              className="sr-only"
              aria-label="导入家族裁决"
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                if (files.length > 0) void importAdjudicationFiles(files);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <span className="text-content-muted">
            已收集 {familyAdjudications.length}/3 个媒体家族 · Gold{" "}
            {familyAdjudications.reduce((total, value) => total + value.summary.gold, 0)}/60
          </span>
          {familyAdjudications.length > 0 ? (
            <Button
              tone="unstyled"
              type="button"
              className="text-content-muted hover:text-content-secondary"
              onClick={() => setFamilyAdjudications([])}
            >
              清空家族裁决
            </Button>
          ) : null}
        </div>
        {familyAdjudications.length > 0 ? (
          <div className="mt-2 grid gap-1">
            {familyAdjudications.map((value) => (
              <div
                key={value.adjudicationId}
                className="flex flex-wrap items-center gap-2 rounded border border-panel-line/50 px-2 py-1"
              >
                <span className="mr-auto text-content-muted">
                  家族 {value.mediaFamilyId.slice(7, 15)}… · Gold {value.summary.gold}/
                  {value.summary.tasks} · 冲突 {value.summary.conflicts}
                </span>
                <Button
                  tone="unstyled"
                  type="button"
                  className="text-content-muted hover:text-content-secondary"
                  aria-label={`移除媒体家族 ${value.mediaFamilyId.slice(7, 15)}`}
                  onClick={() =>
                    setFamilyAdjudications((current) =>
                      current.filter((item) => item.adjudicationId !== value.adjudicationId)
                    )
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {frozenMerge ? (
          <div className="mt-2 rounded border border-feedback-success/30 bg-feedback-success/10 p-2">
            <p className="font-medium text-feedback-success">
              冻结准备已满足：{frozenMerge.receipt.familyCount} 个家族、
              {frozenMerge.receipt.queryCount} 条 Gold。
            </p>
            <p className="mt-1 leading-5 text-content-muted">
              私有标签包含时间答案，应只留在本机；标签承诺不含媒体路径，但仍不能据此放行产品模型。
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <TextButton
                tone="primary"
                onClick={() =>
                  downloadText(
                    `danmaku-frozen-private-labels-${frozenMerge.receipt.mergeId.slice(7, 23)}.json`,
                    serializeMultimodalBlindPrivateLabels(frozenMerge.privateLabels),
                    "application/json;charset=utf-8"
                  )
                }
              >
                导出私有 Gold 标签
              </TextButton>
              <TextButton
                onClick={() =>
                  downloadText(
                    `danmaku-frozen-label-commitment-${frozenMerge.receipt.mergeId.slice(7, 23)}.json`,
                    serializeMultimodalBlindLabelMergeReceipt(frozenMerge.receipt),
                    "application/json;charset=utf-8"
                  )
                }
              >
                导出冻结标签承诺
              </TextButton>
            </div>
          </div>
        ) : (
          <p className="mt-2 leading-5 text-feedback-warning/80">{frozenMergeIssue}</p>
        )}
      </details>

      <p className="mt-2 leading-5 text-content-muted" aria-live="polite">
        {status}
      </p>
      {error ? (
        <p
          className="mt-2 rounded border border-feedback-danger/35 bg-feedback-danger/10 p-2 leading-5 text-feedback-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </details>
  );
}

function intervalForSide(task: MultimodalBlindReviewTask, side: BlindReviewSide) {
  return side === "source"
    ? { startMs: task.sourcePreviewStartMs, endMs: task.sourcePreviewEndMs }
    : { startMs: task.targetReviewStartMs, endMs: task.targetReviewEndMs };
}

function sideLabel(side: BlindReviewSide): string {
  return side === "source" ? "参考 A" : "原片 B";
}
