import { ArrowLeft, ArrowRight, CircleAlert, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceTabs } from "../../components/WorkspaceTabs";
import { ToolSheet } from "../../components/ToolSheet";
import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { TextButton } from "../../components/TextButton";
import { readTimeMapSpanPlaybackReview } from "../../domain/alignment/timeMapPlaybackReviewEvidence";
import { validateTimeMap, type TimeMapSpanKind } from "../../domain/alignment/timeMap";
import type { TimeMapSpanReviewDecision } from "../../domain/alignment/timeMapReviewDecision";
import { describeTimeMapSpanReviewAvailability } from "../../domain/alignment/timeMapReviewDecision";
import { findProjectMedia } from "../../domain/project/mediaLibrary";
import type {
  AlignmentReviewPrecision,
  MediaMatchCandidate,
  MediaTimeMap
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import { useEditorStore } from "../../stores/editorStore";
import { TimeMapDirectEditor, type TimeMapReviewCursor } from "./TimeMapDirectEditor";
import {
  TimeMapPlaybackReview,
  type TimeMapPlaybackAdapterFactory,
  type TimeMapPlaybackPositions,
  type TimeMapPlaybackSeekRequest
} from "./TimeMapPlaybackReview";
import { ManualTimeMapVerificationControls } from "./ManualTimeMapVerificationControls";
import { createAlignmentReviewWorkbenchModel } from "./alignmentReviewWorkbenchModel";

const SPAN_LABELS: Record<TimeMapSpanKind, string> = {
  matched: "共同内容",
  sourceOnly: "参考独有",
  targetOnly: "原片独有",
  ambiguous: "需要确认"
};

export function AlignmentRelationEditor({
  playbackAdapterFactory
}: {
  playbackAdapterFactory?: TimeMapPlaybackAdapterFactory;
} = {}) {
  const project = useEditorStore((state) => state.project);
  const selectedCandidateId = useEditorStore((state) => state.alignmentEditorCandidateId);
  const selectCandidate = useEditorStore((state) => state.selectAlignmentEditorCandidate);
  const workspaceIntentRequest = useEditorStore((state) => state.workspaceIntentRequest);
  const acknowledgeWorkspaceIntent = useEditorStore(
    (state) => state.acknowledgeWorkspaceIntent
  );
  const reviewSpan = useEditorStore((state) => state.reviewCandidateTimeMapSpan);
  const editSpan = useEditorStore((state) => state.editCandidateTimeMapSpan);
  const splitSpan = useEditorStore((state) => state.splitCandidateTimeMapSpan);
  const mergeSpan = useEditorStore((state) => state.mergeCandidateTimeMapSpanWithNext);
  const resolveOriginalOnlyGap = useEditorStore((state) => state.resolveOriginalOnlyGap);
  const resolveReferenceOnlyGap = useEditorStore((state) => state.resolveReferenceOnlyGap);
  const acceptCandidate = useEditorStore((state) => state.acceptMediaMatchCandidate);
  const adoptForPlayback = useEditorStore((state) => state.adoptMatchesForPlayback);
  const revokeAcceptance = useEditorStore((state) => state.revokeMediaMatchCandidateAcceptance);
  const rejectCandidate = useEditorStore((state) => state.rejectMediaMatchCandidate);
  const [compactViewport, setCompactViewport] = useState(false);
  const [focusedSurface, setFocusedSurface] = useState<"preview" | "timeline">("timeline");
  useEffect(() => {
    const query = window.matchMedia?.("(max-height:600px)");
    if (!query) return;
    const update = () => setCompactViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const previewVisible = !compactViewport || focusedSurface === "preview";
  const [selectedSpanIndex, setSelectedSpanIndex] = useState(0);
  // The video monitor is part of the editor, not an optional diagnostic drawer.
  // Opening a relation should immediately prepare its first frame so users can
  // move between the color track and A/B media without another discovery step.
  const [playbackOpen, setPlaybackOpen] = useState(true);
  const [playbackCursor, setPlaybackCursor] = useState<TimeMapReviewCursor | null>(null);
  const [playbackPositions, setPlaybackPositions] = useState<TimeMapPlaybackPositions | null>(
    null
  );
  const [playbackSeekRequest, setPlaybackSeekRequest] =
    useState<TimeMapPlaybackSeekRequest | null>(null);
  const [reviewPrecision, setReviewPrecision] = useState<AlignmentReviewPrecision>("rough");
  const [unlocking, setUnlocking] = useState(false);
  const [actionHint, setActionHint] = useState<string | null>(null);
  const [completionNotice, setCompletionNotice] = useState<string | null>(null);
  const [relationDetailsOpen, setRelationDetailsOpen] = useState(false);
  const nextPriorityCandidateRef = useRef<string | null>(null);

  const candidates = useMemo(
    () => project.mediaMatchCandidates.filter((candidate) => candidate.state !== "rejected"),
    [project.mediaMatchCandidates]
  );
  const candidate =
    candidates.find((item) => item.id === selectedCandidateId) ?? candidates[0] ?? null;
  const candidateIntentTarget =
    workspaceIntentRequest?.intent.page === "editing" &&
    workspaceIntentRequest.intent.target.kind === "candidate"
      ? workspaceIntentRequest.intent.target
      : null;
  const reviewRequestCandidateId = candidateIntentTarget?.candidateId;
  const requestedSpanIndex = candidateIntentTarget?.spanIndex;
  const reviewRequestId = candidateIntentTarget ? workspaceIntentRequest?.sequence : undefined;

  useEffect(() => {
    if (!candidateIntentTarget || reviewRequestId === undefined) return;
    const requestedCandidateId = candidateIntentTarget.candidateId;
    const exists = project.mediaMatchCandidates.some(
      (item) => item.id === requestedCandidateId && item.state !== "rejected"
    );
    if (!exists) {
      selectCandidate(requestedCandidateId);
      acknowledgeWorkspaceIntent(reviewRequestId);
      return;
    }
    if (selectedCandidateId !== requestedCandidateId) {
      selectCandidate(requestedCandidateId);
    }
  }, [
    acknowledgeWorkspaceIntent,
    candidateIntentTarget,
    project.mediaMatchCandidates,
    reviewRequestId,
    selectCandidate,
    selectedCandidateId
  ]);

  useEffect(() => {
    if (candidate && candidate.id !== selectedCandidateId) {
      selectCandidate(candidate.id);
    }
  }, [candidate, selectCandidate, selectedCandidateId]);

  useEffect(() => {
    const latestProject = useEditorStore.getState().project;
    const latestCandidate = latestProject.mediaMatchCandidates.find(
      (item) => item.id === candidate?.id
    );
    const selectedMapId =
      latestCandidate?.state === "accepted"
        ? (latestCandidate.confirmedTimeMapId ?? latestCandidate.timeMapId)
        : latestCandidate?.timeMapId;
    const selectedMap = latestProject.mediaTimeMaps.find((map) => map.id === selectedMapId);
    const locateNextPriority = nextPriorityCandidateRef.current === latestCandidate?.id;
    setSelectedSpanIndex(locateNextPriority ? findInitialReviewSpanIndex(selectedMap) : 0);
    nextPriorityCandidateRef.current = null;
    setPlaybackOpen(true);
    setPlaybackCursor(null);
    setPlaybackPositions(null);
    setPlaybackSeekRequest(null);
    setActionHint(null);
    setRelationDetailsOpen(false);
  }, [candidate?.id, project.id]);

  useEffect(() => {
    if (reviewRequestId === undefined || reviewRequestCandidateId !== candidate?.id) {
      return;
    }
    const latestProject = useEditorStore.getState().project;
    const latestCandidate = latestProject.mediaMatchCandidates.find(
      (item) => item.id === reviewRequestCandidateId
    );
    const selectedMapId =
      latestCandidate?.state === "accepted"
        ? (latestCandidate.confirmedTimeMapId ?? latestCandidate.timeMapId)
        : latestCandidate?.timeMapId;
    const selectedMap = latestProject.mediaTimeMaps.find((map) => map.id === selectedMapId);
    setCompletionNotice(null);
    setSelectedSpanIndex(
      requestedSpanIndex !== undefined && selectedMap
        ? Math.max(0, Math.min(selectedMap.spans.length - 1, requestedSpanIndex))
        : findInitialReviewSpanIndex(selectedMap)
    );
    setPlaybackOpen(true);
    setPlaybackCursor(null);
    setPlaybackPositions(null);
    setPlaybackSeekRequest(null);
    setActionHint(null);
    setRelationDetailsOpen(false);
    acknowledgeWorkspaceIntent(reviewRequestId);
  }, [
    acknowledgeWorkspaceIntent,
    candidate?.id,
    reviewRequestCandidateId,
    reviewRequestId,
    requestedSpanIndex
  ]);

  if (!candidate) {
    return <AlignmentEditorEmptyState />;
  }

  const candidateMap = project.mediaTimeMaps.find((map) => map.id === candidate.timeMapId);
  const confirmedMap = candidate.confirmedTimeMapId
    ? project.mediaTimeMaps.find((map) => map.id === candidate.confirmedTimeMapId)
    : null;
  const relationState = candidate.state === "accepted" ? "accepted" : "candidate";
  const timeMap = relationState === "accepted" ? (confirmedMap ?? candidateMap) : candidateMap;
  const sourceMedia = findProjectMedia(project, candidate.sourceMediaId);
  const targetMedia = findProjectMedia(project, candidate.targetMediaId);

  if (!timeMap || timeMap.spans.length === 0) {
    return (
      <div
        className="m-4 rounded border border-feedback-danger/35 bg-feedback-danger/10 p-4 text-sm text-feedback-danger"
        role="alert"
      >
        这条关系缺少可编辑的时间图。请返回“匹配”重新分析该组素材。
      </div>
    );
  }

  const validationMessage = validateEditorTimeMap(timeMap);
  if (validationMessage) {
    return (
      <div
        className="m-4 rounded border border-feedback-danger/35 bg-feedback-danger/10 p-4 text-sm text-feedback-danger"
        data-testid="time-map-review"
        role="alert"
      >
        <p className="font-medium">时间图结构无效，已停止绘制和定位。</p>
        <p className="mt-1 text-xs leading-5 text-feedback-danger/80">{validationMessage}</p>
        <p className="mt-2 text-xs text-feedback-danger/70">
          请返回“匹配”重新分析，或从项目历史恢复这条关系；应用不会按损坏的范围播放或保存。
        </p>
      </div>
    );
  }

  const safeSpanIndex = Math.min(selectedSpanIndex, timeMap.spans.length - 1);
  const selectedSpan = timeMap.spans[safeSpanIndex];
  const spanCounts = countSpans(timeMap.spans.map((span) => span.kind));
  const existingAssetIds = new Set(project.assets.map((asset) => asset.id));
  const boundAssetIds = project.danmakuSourceBindings
    .filter((binding) => binding.sourceMediaId === candidate.sourceMediaId)
    .map((binding) => binding.assetId)
    .filter((assetId) => existingAssetIds.has(assetId));
  const ambiguousCount = spanCounts.ambiguous;

  const moveSpan = (delta: number) => {
    const next = Math.max(0, Math.min(timeMap.spans.length - 1, safeSpanIndex + delta));
    setSelectedSpanIndex(next);
  };
  const beginEditing = async () => {
    if (relationState === "candidate" || unlocking) return;
    setUnlocking(true);
    try {
      await revokeAcceptance(candidate.id);
    } finally {
      setUnlocking(false);
    }
  };
  const markSelectedSpanAsCommon = () => {
    editSpan(timeMap.id, safeSpanIndex, {
      kind: "matched",
      sourceStartMs: selectedSpan.sourceStartMs,
      sourceEndMs: selectedSpan.sourceEndMs,
      targetStartMs: selectedSpan.targetStartMs,
      targetEndMs: selectedSpan.targetEndMs
    });
  };
  const handleReviewAction = (decision: TimeMapSpanReviewDecision) => {
    const availability = describeTimeMapSpanReviewAvailability(selectedSpan, decision);
    if (availability.allowed) {
      setActionHint(null);
      reviewSpan(timeMap.id, safeSpanIndex, decision, reviewPrecision);
      return;
    }
    setActionHint(`${availability.reason} 请先用时间轨拖选或边界工具调整实际范围。`);
  };
  const selectNextPriorityCandidate = (
    requireAccepted = true
  ): "notAccepted" | "complete" | "advanced" => {
    const latestProject = useEditorStore.getState().project;
    const latestCandidate = latestProject.mediaMatchCandidates.find(
      (item) => item.id === candidate.id
    );
    if (requireAccepted && latestCandidate?.state !== "accepted") return "notAccepted";
    const model = createAlignmentReviewWorkbenchModel({
      media: latestProject.mediaLibrary,
      candidates: latestProject.mediaMatchCandidates,
      timeMaps: latestProject.mediaTimeMaps,
      bindings: latestProject.danmakuSourceBindings,
      tasks: []
    });
    const nextCandidateId = model.priorityGroups
      .flatMap((group) => group.items)
      .flatMap((item) =>
        item.nextAction.kind === "openCandidate" && item.nextAction.candidateId !== candidate.id
          ? [item.nextAction.candidateId]
          : []
      )[0];
    if (nextCandidateId) {
      nextPriorityCandidateRef.current = nextCandidateId;
      selectCandidate(nextCandidateId);
      return "advanced";
    }
    return "complete";
  };
  const saveAndContinue = () => {
    acceptCandidate(candidate.id, boundAssetIds);
    const outcome = selectNextPriorityCandidate();
    if (outcome === "notAccepted") setActionHint(useEditorStore.getState().status.message);
    setCompletionNotice(
      outcome === "notAccepted"
        ? null
        : `上一项已保存${outcome === "advanced" ? "，已进入下一异常。" : "。"}`
    );
  };
  const adoptCurrent = () => {
    const ok = adoptForPlayback([candidate.id]);
    setActionHint(ok ? null : useEditorStore.getState().status.message);
    setCompletionNotice(ok ? "已保存并采用此修正，可直接重新导出。" : null);
  };

  return (
    <section
      className="relation-editor"
      data-testid="alignment-editor-workspace"
      aria-label="时间线编辑工作台"
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      onKeyDown={(event) => {
        if (
          !event.altKey ||
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement
        )
          return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          moveSpan(-1);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          moveSpan(1);
        }
      }}
    >
      <header className="relation-context">
        <div className="relation-context-name">
          <h2 title={targetMedia?.name ?? candidate.targetMediaId}>
            {targetMedia?.name ?? candidate.targetMediaId}
          </h2>
          <span className={relationBadgeClass(candidate)}>{relationBadgeText(candidate)}</span>
        </div>
        <div className="editor-toolbar-actions">
          <TextButton
            onClick={() => moveSpan(-1)}
            disabled={safeSpanIndex === 0}
            aria-label="上一段"
          >
            <ArrowLeft size={14} />
          </TextButton>
          <span className="text-xs tabular-nums whitespace-nowrap">
            第 {safeSpanIndex + 1} / {timeMap.spans.length} 段
          </span>
          <TextButton
            onClick={() => moveSpan(1)}
            disabled={safeSpanIndex >= timeMap.spans.length - 1}
            aria-label="下一段"
          >
            <ArrowRight size={14} />
          </TextButton>
          {relationState === "accepted" ? (
            <TextButton tone="primary" disabled={unlocking} onClick={() => void beginEditing()}>
              <RotateCcw size={14} />
              {unlocking ? "正在进入编辑…" : "修改这一段"}
            </TextButton>
          ) : (
            <>
              <TextButton
                tone="primary"
                onClick={adoptCurrent}
                aria-label="采用当前结果并允许导出"
                title={
                  boundAssetIds.length === 0
                    ? "需要先将 XML 关联到此参考素材"
                    : "检查并采用当前映射，用于弹幕导出"
                }
              >
                <Save size={14} />
                保存并采用此修正
              </TextButton>
            </>
          )}
          <WorkspaceMenu
            label="关系工具"
            items={[
              {
                id: "details",
                label: "关系详情与导出检查",
                onSelect: () => setRelationDetailsOpen(true)
              },
              ...(relationState === "candidate"
                ? [
                    {
                      id: "accept-verified",
                      label: "保存为待复核关系",
                      disabled: boundAssetIds.length === 0,
                      onSelect: saveAndContinue
                    },
                    {
                      id: "ignore",
                      label: "忽略候选",
                      danger: true,
                      onSelect: () => rejectCandidate(candidate.id)
                    }
                  ]
                : [
                    {
                      id: "revoke",
                      label: "撤销关系确认并继续编辑",
                      onSelect: () => void revokeAcceptance(candidate.id)
                    }
                  ])
            ]}
          />
        </div>
      </header>
      {completionNotice ? (
        <p className="editor-notice text-feedback-success" role="status">
          {completionNotice}
        </p>
      ) : null}
      {boundAssetIds.length === 0 ? (
        <p className="editor-notice text-feedback-warning">
          参考素材还没有绑定 XML；保存关系前请回到素材页完成绑定。
        </p>
      ) : null}
      {compactViewport ? (
        <div className="compact-editor-switch">
          <WorkspaceTabs
            label="编辑工作面"
            value={focusedSurface}
            onChange={setFocusedSurface}
            items={[
              { id: "timeline", label: "时间线" },
              { id: "preview", label: "双画面预览" }
            ]}
          />
        </div>
      ) : null}
      <div
        className="relation-editing-surface"
        data-focus={compactViewport ? focusedSurface : "overview"}
      >
        <section className="relation-monitor-region" aria-label="A/B 视频监视器与播放">
          <TimeMapPlaybackReview
            timeMap={timeMap}
            span={selectedSpan}
            spanIndex={safeSpanIndex}
            timeMapId={timeMap.id}
            relationState={relationState}
            persistedReview={Boolean(readTimeMapSpanPlaybackReview(timeMap, safeSpanIndex))}
            sourceMapRange={{ startMs: timeMap.sourceStartMs, endMs: timeMap.sourceEndMs }}
            targetMapRange={{ startMs: timeMap.targetStartMs, endMs: timeMap.targetEndMs }}
            sourceMedia={sourceMedia}
            targetMedia={targetMedia}
            visible={previewVisible}
            open={playbackOpen}
            onOpenChange={setPlaybackOpen}
            onCursorChange={setPlaybackCursor}
            onPositionsChange={setPlaybackPositions}
            seekRequest={playbackSeekRequest}
            adapterFactory={playbackAdapterFactory}
          />
        </section>
        <section className="relation-timeline-region" aria-label="正式 TimeMap 与风险区">
          <TimeMapDirectEditor
            timeMap={timeMap}
            evidenceProfile={candidate.proposal.evidenceProfile}
            selectedSpanIndex={safeSpanIndex}
            relationState={relationState}
            playbackCursor={playbackCursor}
            playbackPositions={playbackPositions}
            onSeekPlayback={(cursor) =>
              setPlaybackSeekRequest((current) => ({
                ...cursor,
                token: (current?.token ?? 0) + 1
              }))
            }
            reviewPrecision={reviewPrecision}
            actionHint={actionHint}
            onSelectSpan={setSelectedSpanIndex}
            onMarkCommon={markSelectedSpanAsCommon}
            onReviewDecision={handleReviewAction}
            onReviewPrecisionChange={setReviewPrecision}
            onSplitSelected={(point) => {
              try {
                splitSpan(timeMap.id, safeSpanIndex, point);
                setActionHint("已拆成两段；新边界需要重新播放复核。");
              } catch (error) {
                setActionHint(error instanceof Error ? error.message : String(error));
              }
            }}
            onMergeSelected={() => {
              try {
                mergeSpan(timeMap.id, safeSpanIndex);
                setActionHint("已与下一段合并；合并后的范围需要重新播放复核。");
              } catch (error) {
                setActionHint(error instanceof Error ? error.message : String(error));
              }
            }}
            onResolveOriginalOnlyGap={(input) =>
              resolveOriginalOnlyGap(timeMap.id, safeSpanIndex, input, reviewPrecision)
            }
            onResolveReferenceOnlyGap={(input) =>
              resolveReferenceOnlyGap(timeMap.id, safeSpanIndex, input, reviewPrecision)
            }
          />
        </section>
      </div>
      <ToolSheet
        title="关系详情与导出检查"
        open={relationDetailsOpen}
        onClose={() => setRelationDetailsOpen(false)}
      >
        <div className="grid gap-4" aria-label="当前问题与保存">
          <div>
            <h3 className="font-semibold">
              {sourceMedia?.name ?? candidate.sourceMediaId} →{" "}
              {targetMedia?.name ?? candidate.targetMediaId}
            </h3>
            <p className="mt-2 text-content-muted">
              共同 {spanCounts.matched} · 参考独有 {spanCounts.sourceOnly} · 原片独有{" "}
              {spanCounts.targetOnly} · 待确认 {ambiguousCount}
            </p>
          </div>
          <div>
            <h3 className="font-medium">
              第 {safeSpanIndex + 1} 段 · {SPAN_LABELS[selectedSpan.kind]}
            </h3>
            <p className="mt-2 tabular-nums">
              参考 {formatTimecode(selectedSpan.sourceStartMs)}–
              {formatTimecode(selectedSpan.sourceEndMs)}
              <br />
              原片 {formatTimecode(selectedSpan.targetStartMs)}–
              {formatTimecode(selectedSpan.targetEndMs)}
            </p>
          </div>
          <p className="text-content-muted">
            编辑修改会保留在项目中。“保存并采用此修正”将这条映射用于导出，可随时返回覆盖分析。
          </p>
          {relationState === "accepted" ? (
            <ManualTimeMapVerificationControls timeMap={timeMap} />
          ) : (
            <p>修改已保留，当前关系尚未采用。完成检查后可直接在顶部采用。</p>
          )}
        </div>
      </ToolSheet>
    </section>
  );
}

function AlignmentEditorEmptyState() {
  const setWorkspacePage = useEditorStore((state) => state.setWorkspacePage);
  return (
    <div
      className="flex h-full items-center justify-center p-6"
      data-testid="alignment-editor-empty"
    >
      <div className="max-w-md rounded border border-dashed border-panel-line p-5 text-center">
        <CircleAlert className="mx-auto text-content-muted" size={26} />
        <h2 className="mt-3 text-sm font-semibold text-content-primary">
          还没有可编辑的时间关系
        </h2>
        <p className="mt-2 text-xs leading-5 text-content-muted">
          第 3 步只负责播放、检查和修改时间线。先在第 2 步运行智能匹配，生成候选后再回来编辑。
        </p>
        <TextButton
          className="mt-4"
          tone="primary"
          onClick={() => setWorkspacePage("matching")}
        >
          返回智能匹配
        </TextButton>
      </div>
    </div>
  );
}

function countSpans(kinds: TimeMapSpanKind[]) {
  return kinds.reduce((counts, kind) => ({ ...counts, [kind]: counts[kind] + 1 }), {
    matched: 0,
    sourceOnly: 0,
    targetOnly: 0,
    ambiguous: 0
  });
}

function findInitialReviewSpanIndex(timeMap?: MediaTimeMap): number {
  if (!timeMap || timeMap.spans.length === 0) return 0;
  const ambiguousIndex = timeMap.spans.findIndex((span) => span.kind === "ambiguous");
  if (ambiguousIndex >= 0) return ambiguousIndex;
  const structuralRiskIndex = timeMap.spans.findIndex(
    (span) => span.kind === "sourceOnly" || span.kind === "targetOnly"
  );
  if (structuralRiskIndex >= 0) return structuralRiskIndex;
  const qualityRiskIndex = timeMap.spans.findIndex(
    (span) => span.quality?.level === "review" || span.quality?.level === "blocked"
  );
  return qualityRiskIndex >= 0 ? qualityRiskIndex : 0;
}

function validateEditorTimeMap(timeMap: {
  sourceStartMs: number;
  sourceEndMs: number;
  targetStartMs: number;
  targetEndMs: number;
  spans: Parameters<typeof validateTimeMap>[0];
}): string | null {
  const totalRangesAreValid =
    Number.isSafeInteger(timeMap.sourceStartMs) &&
    timeMap.sourceStartMs >= 0 &&
    Number.isSafeInteger(timeMap.sourceEndMs) &&
    timeMap.sourceEndMs > timeMap.sourceStartMs &&
    Number.isSafeInteger(timeMap.targetStartMs) &&
    timeMap.targetStartMs >= 0 &&
    Number.isSafeInteger(timeMap.targetEndMs) &&
    timeMap.targetEndMs > timeMap.targetStartMs;
  if (!totalRangesAreValid) {
    return "时间图总范围不是有效的非负整数毫秒区间。";
  }
  const validation = validateTimeMap(timeMap.spans);
  if (!validation.valid) {
    return validation.issues[0]?.message ?? "时间图分段无效。";
  }
  const first = timeMap.spans[0];
  const last = timeMap.spans[timeMap.spans.length - 1];
  const spansStayInsideRange = timeMap.spans.every(
    (span) =>
      span.sourceStartMs >= timeMap.sourceStartMs &&
      span.sourceEndMs <= timeMap.sourceEndMs &&
      span.targetStartMs >= timeMap.targetStartMs &&
      span.targetEndMs <= timeMap.targetEndMs
  );
  if (
    !first ||
    !last ||
    !spansStayInsideRange ||
    first.sourceStartMs !== timeMap.sourceStartMs ||
    first.targetStartMs !== timeMap.targetStartMs ||
    last.sourceEndMs !== timeMap.sourceEndMs ||
    last.targetEndMs !== timeMap.targetEndMs
  ) {
    return "分段没有完整覆盖时间图声明的双方范围。";
  }
  return null;
}

function relationBadgeText(candidate: MediaMatchCandidate) {
  if (candidate.state === "accepted") return "关系已保存";
  if (candidate.state === "blocked") return "需要人工处理";
  return "等待确认";
}

function relationBadgeClass(candidate: MediaMatchCandidate) {
  const color =
    candidate.state === "accepted"
      ? "border-feedback-success/40 bg-feedback-success/10 text-feedback-success"
      : candidate.state === "blocked"
        ? "border-feedback-warning/40 bg-feedback-warning/10 text-feedback-warning"
        : "border-feedback-running/40 bg-feedback-running/10 text-feedback-running";
  return `rounded border px-2 py-0.5 text-ui-caption font-medium ${color}`;
}
