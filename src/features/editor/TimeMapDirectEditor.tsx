import { ToolSheet } from "../../components/ToolSheet";
import { TextButton } from "../../components/TextButton";
import { Button } from "../../components/Button";
import { TimeRuler } from "../../components/TimeRuler";
import { equalizeTimeRanges } from "../../domain/timeline/timeScale";
import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AlignmentEvidenceProfile } from "../../domain/alignment/types";
import type { TimeMapSpan, TimeMapSpanKind } from "../../domain/alignment/timeMap";
import type {
  ManualTimeMapSplitPoint,
  ResolveOriginalOnlyGapInput,
  ResolveReferenceOnlyGapInput,
  TimeMapSpanReviewDecision
} from "../../domain/alignment/timeMapReviewDecision";
import type { AlignmentReviewPrecision, MediaTimeMap } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  TimeMapEditorToolbar,
  type TimeMapEditTool,
  type TimeMapViewMode
} from "./timeMapDirectEditor/TimeMapEditorToolbar";
import { TimeMapEvidenceCanvas } from "./TimeMapEvidenceCanvas";
import { BoundaryNumberInput } from "./timeMapDirectEditor/BoundaryNumberInput";
import {
  createGapSuggestion,
  isResolvableGapShape,
  resolveGapDraft,
  updateGapDraft,
  type GapDraft
} from "./timeMapDirectEditor/boundaryDraftModel";
import {
  effectiveOffsetMs,
  evidenceDifferenceRisk
} from "./timeMapDirectEditor/evidenceCanvasModel";

export interface TimeMapReviewCursor {
  side: "source" | "target";
  positionMs: number;
}

interface TimeMapPlaybackPositions {
  source: number;
  target: number;
}

export interface TimeMapDirectEditorProps {
  timeMap: MediaTimeMap;
  evidenceProfile?: AlignmentEvidenceProfile;
  selectedSpanIndex: number;
  relationState: "candidate" | "accepted";
  playbackCursor?: TimeMapReviewCursor | null;
  playbackPositions?: TimeMapPlaybackPositions | null;
  onSeekPlayback?: (cursor: TimeMapReviewCursor) => void;
  requestedGapMode?: { side: "source" | "target"; token: number } | null;
  reviewPrecision?: AlignmentReviewPrecision;
  actionHint?: string | null;
  onSelectSpan: (spanIndex: number) => void;
  onMarkCommon?: () => void;
  onReviewDecision?: (decision: TimeMapSpanReviewDecision) => void;
  onReviewPrecisionChange?: (precision: AlignmentReviewPrecision) => void;
  onSplitSelected?: (point: ManualTimeMapSplitPoint) => void;
  onMergeSelected?: () => void;
  onResolveOriginalOnlyGap: (input: ResolveOriginalOnlyGapInput) => void;
  onResolveReferenceOnlyGap: (input: ResolveReferenceOnlyGapInput) => void;
}

const SPAN_LABELS: Record<TimeMapSpanKind, string> = {
  matched: "共同内容",
  sourceOnly: "参考独有",
  targetOnly: "原片独有",
  ambiguous: "需要确认"
};

export function TimeMapDirectEditor({
  timeMap,
  evidenceProfile,
  selectedSpanIndex,
  relationState,
  playbackCursor,
  playbackPositions,
  onSeekPlayback,
  requestedGapMode,
  reviewPrecision = "rough",
  actionHint,
  onSelectSpan,
  onMarkCommon = () => undefined,
  onReviewDecision = () => undefined,
  onReviewPrecisionChange = () => undefined,
  onSplitSelected = () => undefined,
  onMergeSelected = () => undefined,
  onResolveOriginalOnlyGap,
  onResolveReferenceOnlyGap
}: TimeMapDirectEditorProps) {
  const selectedSpan = timeMap.spans[selectedSpanIndex];
  const suggestion = useMemo(
    () => (selectedSpan ? createGapSuggestion(selectedSpan, evidenceProfile) : null),
    [evidenceProfile, selectedSpan]
  );
  const [draft, setDraft] = useState<GapDraft | null>(suggestion);
  const [activeTool, setActiveTool] = useState<TimeMapEditTool>(
    suggestion?.side === "source"
      ? "sourceGap"
      : suggestion?.side === "target"
        ? "targetGap"
        : "inspect"
  );
  const [viewMode, setViewMode] = useState<TimeMapViewMode>("focus");
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapMessage, setSnapMessage] = useState<string | null>(null);
  const [frameRate, setFrameRate] = useState(25);
  const [precisionOpen, setPrecisionOpen] = useState(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const riskSpanIndices = useMemo(
    () => findRiskSpanIndices(timeMap.spans, evidenceProfile),
    [evidenceProfile, timeMap.spans]
  );
  const riskInsight = useMemo(() => createRiskInsight(evidenceProfile), [evidenceProfile]);
  const visualAnchorInsight = useMemo(
    () => createVisualAnchorInsight(evidenceProfile),
    [evidenceProfile]
  );

  useEffect(() => {
    setDraft(suggestion);
    setActiveTool(
      suggestion?.side === "source"
        ? "sourceGap"
        : suggestion?.side === "target"
          ? "targetGap"
          : "inspect"
    );
  }, [suggestion, timeMap.id, timeMap.revision, selectedSpanIndex]);

  useEffect(() => {
    setViewMode("focus");
  }, [timeMap.id, selectedSpanIndex]);

  useEffect(() => {
    if (!requestedGapMode || relationState !== "candidate") return;
    setActiveTool(requestedGapMode.side === "source" ? "sourceGap" : "targetGap");
    setDraft(null);
  }, [requestedGapMode, relationState]);

  if (!selectedSpan) return null;
  const canEdit = relationState === "candidate";
  const sourceRange = createTrackViewRange(
    timeMap.sourceStartMs,
    timeMap.sourceEndMs,
    selectedSpan.sourceStartMs,
    selectedSpan.sourceEndMs,
    viewMode
  );
  const targetRange = createTrackViewRange(
    timeMap.targetStartMs,
    timeMap.targetEndMs,
    selectedSpan.targetStartMs,
    selectedSpan.targetEndMs,
    viewMode
  );
  const { source: sourceViewRange, target: targetViewRange } = equalizeTimeRanges(
    sourceRange,
    targetRange
  );
  const durationMs = draft ? Math.max(0, draft.endMs - draft.startMs) : 0;
  const draftShapeValid = draft ? isResolvableGapShape(selectedSpan, draft) : false;
  const confirmDisabled = !canEdit || !draft || durationMs <= 0 || !draftShapeValid;

  const updateDraft = (
    side: "source" | "target",
    firstMs: number,
    secondMs: number,
    shouldSnap = snapEnabled
  ) => {
    const result = updateGapDraft({
      span: selectedSpan,
      side,
      firstMs,
      secondMs,
      snapEnabled,
      playbackCursor,
      evidenceProfile,
      shouldSnap
    });
    setDraft(result.draft);
    setSnapMessage(result.snapMessage);
  };

  const applyPlaybackPosition = (boundary: "start" | "end") => {
    if (!draft || !playbackCursor || playbackCursor.side !== draft.side) return;
    updateDraft(
      draft.side,
      boundary === "start" ? playbackCursor.positionMs : draft.startMs,
      boundary === "end" ? playbackCursor.positionMs : draft.endMs
    );
  };

  const applyPlaybackSeam = () => {
    if (!draft || !playbackCursor || playbackCursor.side === draft.side) return;
    setDraft({ ...draft, seamMs: playbackCursor.positionMs });
  };

  const confirm = () => {
    const resolution = draft ? resolveGapDraft(selectedSpan, draft) : null;
    if (!resolution || confirmDisabled) return;
    if (resolution.kind === "targetGap") {
      onResolveOriginalOnlyGap(resolution.input);
    } else {
      onResolveReferenceOnlyGap(resolution.input);
    }
    setPrecisionOpen(false);
  };
  const selectAdjacentRisk = (direction: -1 | 1) => {
    if (riskSpanIndices.length === 0) return;
    const current = riskSpanIndices.indexOf(selectedSpanIndex);
    const next =
      current < 0
        ? direction > 0
          ? 0
          : riskSpanIndices.length - 1
        : (current + direction + riskSpanIndices.length) % riskSpanIndices.length;
    onSelectSpan(riskSpanIndices[next] ?? riskSpanIndices[0] ?? 0);
  };
  const splitSelected = () => {
    const sourceDurationMs = selectedSpan.sourceEndMs - selectedSpan.sourceStartMs;
    const targetDurationMs = selectedSpan.targetEndMs - selectedSpan.targetStartMs;
    if (sourceDurationMs <= 1 || targetDurationMs <= 1) return;
    const cursorOnSelectedAxis =
      playbackCursor?.side === "source"
        ? playbackCursor.positionMs >= selectedSpan.sourceStartMs &&
          playbackCursor.positionMs <= selectedSpan.sourceEndMs
        : playbackCursor
          ? playbackCursor.positionMs >= selectedSpan.targetStartMs &&
            playbackCursor.positionMs <= selectedSpan.targetEndMs
          : false;
    const sourceRatio =
      cursorOnSelectedAxis && playbackCursor?.side === "source"
        ? (playbackCursor.positionMs - selectedSpan.sourceStartMs) / sourceDurationMs
        : cursorOnSelectedAxis && playbackCursor?.side === "target"
          ? (playbackCursor.positionMs - selectedSpan.targetStartMs) / targetDurationMs
          : 0.5;
    const ratio = Math.max(0.001, Math.min(0.999, sourceRatio));
    onSplitSelected({
      sourceMs: Math.round(selectedSpan.sourceStartMs + sourceDurationMs * ratio),
      targetMs: Math.round(selectedSpan.targetStartMs + targetDurationMs * ratio)
    });
  };

  return (
    <section
      role="region"
      className="time-map-workspace"
      data-testid="time-map-direct-editor"
      aria-label="双轨差异编辑器"
    >
      <TimeMapEditorToolbar
        activeTool={activeTool}
        viewMode={viewMode}
        selectedKind={selectedSpan.kind}
        canEdit={canEdit}
        canMarkCommon={
          selectedSpan.sourceEndMs > selectedSpan.sourceStartMs &&
          selectedSpan.targetEndMs > selectedSpan.targetStartMs
        }
        canSplit={
          selectedSpan.sourceEndMs - selectedSpan.sourceStartMs > 1 &&
          selectedSpan.targetEndMs - selectedSpan.targetStartMs > 1
        }
        canMerge={
          Boolean(timeMap.spans[selectedSpanIndex + 1]) &&
          timeMap.spans[selectedSpanIndex + 1]?.kind === selectedSpan.kind
        }
        reviewPrecision={reviewPrecision}
        actionHint={actionHint}
        onToolChange={(tool) => {
          if (tool === "sourceGap" && selectedSpan.kind === "sourceOnly") {
            onReviewDecision("source-extra");
            setActiveTool("inspect");
            setDraft(null);
            return;
          }
          if (tool === "targetGap" && selectedSpan.kind === "targetOnly") {
            onReviewDecision("target-extra");
            setActiveTool("inspect");
            setDraft(null);
            return;
          }
          setActiveTool(tool);
          if (tool === "inspect") setDraft(null);
          if (tool === "sourceGap" && draft?.side !== "source") setDraft(null);
          if (tool === "targetGap" && draft?.side !== "target") setDraft(null);
        }}
        onViewModeChange={setViewMode}
        onMarkCommon={() => {
          onMarkCommon();
          setActiveTool("inspect");
          setDraft(null);
          setViewMode("overview");
        }}
        onMarkReplacement={() => {
          onReviewDecision("replacement");
          setActiveTool("inspect");
          setDraft(null);
          setViewMode("overview");
        }}
        onMarkUnresolved={() => {
          onReviewDecision("unresolved");
          setActiveTool("inspect");
          setDraft(null);
          setViewMode("overview");
        }}
        onSplit={splitSelected}
        onMerge={onMergeSelected}
        onReviewPrecisionChange={onReviewPrecisionChange}
      />

      <div className="time-map-context-line">
        <span className="truncate" title={actionHint ?? undefined}>
          {actionHint ??
            (!canEdit
              ? "关系已保存；需要调整时点击“修改这一段”。"
              : activeTool === "inspect"
                ? "点击色块选择，方向键定位播放头。"
                : activeTool === "sourceGap"
                  ? "在参考轨道上拖出多出的范围。"
                  : "在原片轨道上拖出多出的范围。")}
        </span>
        <div className="editor-toolbar-actions" aria-label="疑点导航">
          <TextButton
            disabled={riskSpanIndices.length === 0}
            onClick={() => selectAdjacentRisk(-1)}
          >
            上一疑点
          </TextButton>
          <TextButton
            disabled={riskSpanIndices.length === 0}
            onClick={() => selectAdjacentRisk(1)}
          >
            下一疑点
          </TextButton>
          <TextButton onClick={() => setEvidenceOpen(true)}>图例与分析</TextButton>
        </div>
      </div>
      <p className="time-map-scale-note">
        两轨等比例：相同横向长度表示相同时长，起点分别见刻度；空白为当前关系未覆盖。
      </p>
      <div className="time-map-tracks">
        <DirectTrack
          label="参考轨道"
          axis="source"
          rangeStartMs={sourceViewRange.startMs}
          rangeEndMs={sourceViewRange.endMs}
          spans={timeMap.spans}
          evidenceProfile={evidenceProfile}
          selectedSpanIndex={selectedSpanIndex}
          draft={draft?.side === "source" ? draft : null}
          editable={canEdit && activeTool === "sourceGap"}
          playbackPositionMs={
            playbackPositions?.source ??
            (playbackCursor?.side === "source" ? playbackCursor.positionMs : null)
          }
          onSelectSpan={onSelectSpan}
          onSeek={(positionMs) =>
            onSeekPlayback?.({
              side: "source",
              positionMs: Math.max(
                timeMap.sourceStartMs,
                Math.min(timeMap.sourceEndMs, positionMs)
              )
            })
          }
          onDraftRange={(startMs, endMs) => updateDraft("source", startMs, endMs)}
        />
        <DirectTrack
          label="原片轨道"
          axis="target"
          rangeStartMs={targetViewRange.startMs}
          rangeEndMs={targetViewRange.endMs}
          spans={timeMap.spans}
          evidenceProfile={evidenceProfile}
          selectedSpanIndex={selectedSpanIndex}
          draft={draft?.side === "target" ? draft : null}
          editable={canEdit && activeTool === "targetGap"}
          playbackPositionMs={
            playbackPositions?.target ??
            (playbackCursor?.side === "target" ? playbackCursor.positionMs : null)
          }
          onSelectSpan={onSelectSpan}
          onSeek={(positionMs) =>
            onSeekPlayback?.({
              side: "target",
              positionMs: Math.max(
                timeMap.targetStartMs,
                Math.min(timeMap.targetEndMs, positionMs)
              )
            })
          }
          onDraftRange={(startMs, endMs) => updateDraft("target", startMs, endMs)}
        />
      </div>

      <ToolSheet title="图例与分析" open={evidenceOpen} onClose={() => setEvidenceOpen(false)}>
        <p className="mb-4">
          {visualAnchorInsight ?? riskInsight ?? "灰色表示证据不足，仍可手动调整。"}
        </p>
        <p className="mb-4">
          {evidenceProfile
            ? "局部证据 · " + formatDuration(evidenceProfile.windowMs) + "/窗"
            : "旧结果无局部证据"}
        </p>
        <div
          className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-content-muted"
          aria-label="证据图例"
        >
          <Legend color="bg-feedback-success/10" label="稳定共同内容" />
          <Legend color="bg-feedback-warning/10" label="参考可能多出" />
          <Legend color="bg-feedback-running/10" label="原片可能多出" />
          <Legend color="bg-fuchsia-400" label="冲突或替换" />
          <Legend color="bg-surface-soft" label="证据不足" />
          <Legend color="bg-feedback-running/10" label="画面找到唯一位置" />
          <span>白色阶梯表示两条轨道累计错开了多少；它不是播放头，也不能拖动。</span>
        </div>

        {createOffsetStepExplanation(evidenceProfile) ? (
          <div className="mt-2 rounded border border-boundary-strong/80 bg-surface-inset/50 px-2.5 py-2 text-ui-caption leading-5 text-content-secondary">
            {createOffsetStepExplanation(evidenceProfile)}
          </div>
        ) : null}
      </ToolSheet>
      {canEdit && draft ? (
        <div className="time-map-draft-bar">
          <div className="font-medium">
            {draft.side === "target" ? "原片可能多出一段" : "参考可能多出一段"}
          </div>
          <span className="tabular-nums text-content-muted">
            {formatTimecode(draft.startMs)}–{formatTimecode(draft.endMs)}
          </span>
          <TextButton onClick={() => setPrecisionOpen(true)}>精确边界</TextButton>
          <TextButton tone="primary" disabled={confirmDisabled} onClick={confirm}>
            确认{draft.side === "target" ? "原片" : "参考"}独有 {formatDuration(durationMs)}
          </TextButton>
          <ToolSheet
            title="精确边界"
            open={precisionOpen}
            onClose={() => setPrecisionOpen(false)}
          >
            <p className="mt-1 leading-5">
              {formatTimecode(draft.startMs)}–{formatTimecode(draft.endMs)}，共{" "}
              {formatDuration(durationMs)}。
              {draft.seamMs === null
                ? " 当前还不能可靠确定另一条轨道的接缝，请用 A/B 播放定位。"
                : !draftShapeValid
                  ? " 当前接缝无法组成连续时间图，请继续调整边界或用另一侧 A/B 位置重新设置。"
                  : " 另一条轨道将在 " + formatTimecode(draft.seamMs) + " 保持不动。"}
            </p>
            <div
              className="mt-2 rounded border border-feedback-running/20 bg-surface-inset/45 p-2"
              aria-label="精确边界输入"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-ui-caption text-feedback-running/70">
                  毫秒、时间码和帧号保持同步
                </span>
                <label className="inline-flex items-center gap-1.5 text-ui-caption text-feedback-running/80">
                  边界精调帧率
                  <select
                    className="h-7 rounded border border-panel-line bg-surface-inset px-1.5 text-ui-caption text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
                    aria-label="边界精调帧率"
                    value={frameRate}
                    onChange={(event) => setFrameRate(Number(event.currentTarget.value))}
                  >
                    {[24, 25, 30, 50, 60].map((rate) => (
                      <option key={rate} value={rate}>
                        {rate} fps
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <BoundaryNumberInput
                  label={`${draft.side === "target" ? "原片" : "参考"}独有开始`}
                  value={draft.startMs}
                  frameRate={frameRate}
                  onChange={(value) => updateDraft(draft.side, value, draft.endMs)}
                  onStep={(deltaMs) =>
                    updateDraft(draft.side, draft.startMs + deltaMs, draft.endMs, false)
                  }
                  stepLabel="开始"
                />
                <BoundaryNumberInput
                  label={`${draft.side === "target" ? "原片" : "参考"}独有结束`}
                  value={draft.endMs}
                  frameRate={frameRate}
                  onChange={(value) => updateDraft(draft.side, draft.startMs, value)}
                  onStep={(deltaMs) =>
                    updateDraft(draft.side, draft.startMs, draft.endMs + deltaMs, false)
                  }
                  stepLabel="结束"
                />
                <label className="grid content-start gap-1 text-ui-caption text-feedback-running/80">
                  另一侧对应位置（毫秒）
                  <input
                    className="h-8 min-w-0 rounded border border-panel-line bg-surface-inset px-2 text-ui-caption tabular-nums text-content-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-cyan"
                    type="number"
                    step={1}
                    value={draft.seamMs ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      setDraft((current) =>
                        current && Number.isFinite(value)
                          ? { ...current, seamMs: Math.round(value) }
                          : current
                      );
                    }}
                  />
                </label>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-caption leading-4 text-feedback-running/75">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  aria-label="边界吸附"
                  checked={snapEnabled}
                  onChange={(event) => {
                    setSnapEnabled(event.currentTarget.checked);
                    setSnapMessage(null);
                  }}
                />
                吸附播放头与 250 毫秒内的证据边界
              </label>
              <span>
                拖动、输入与步进使用同一边界草稿；手柄方向键每次 100 毫秒，Shift 为 1 秒。
              </span>
              {snapMessage ? (
                <span className="font-medium text-feedback-running">{snapMessage}</span>
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                tone="unstyled"
                type="button"
                className="rounded border border-feedback-running/50 bg-feedback-running/10 px-3 py-1.5 font-medium hover:bg-feedback-running/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan disabled:cursor-not-allowed disabled:opacity-40"
                disabled={confirmDisabled}
                onClick={confirm}
              >
                确认{draft.side === "target" ? "原片" : "参考"}独有 {formatDuration(durationMs)}
              </Button>
              <Button
                tone="unstyled"
                type="button"
                className="rounded border border-panel-line px-2.5 py-1.5 text-content-secondary hover:bg-surface-soft disabled:opacity-40"
                disabled={!playbackCursor || playbackCursor.side !== draft.side}
                onClick={() => applyPlaybackPosition("start")}
              >
                将当前播放位置设为开始
              </Button>
              <Button
                tone="unstyled"
                type="button"
                className="rounded border border-panel-line px-2.5 py-1.5 text-content-secondary hover:bg-surface-soft disabled:opacity-40"
                disabled={!playbackCursor || playbackCursor.side !== draft.side}
                onClick={() => applyPlaybackPosition("end")}
              >
                将当前播放位置设为结束
              </Button>
              <Button
                tone="unstyled"
                type="button"
                className="rounded border border-panel-line px-2.5 py-1.5 text-content-secondary hover:bg-surface-soft disabled:opacity-40"
                disabled={!playbackCursor || playbackCursor.side === draft.side}
                onClick={applyPlaybackSeam}
              >
                将另一侧当前位置设为接缝
              </Button>
            </div>
          </ToolSheet>
        </div>
      ) : null}
    </section>
  );
}

function DirectTrack({
  label,
  axis,
  rangeStartMs,
  rangeEndMs,
  spans,
  evidenceProfile,
  selectedSpanIndex,
  draft,
  editable,
  playbackPositionMs,
  onSelectSpan,
  onSeek,
  onDraftRange
}: {
  label: string;
  axis: "source" | "target";
  rangeStartMs: number;
  rangeEndMs: number;
  spans: readonly TimeMapSpan[];
  evidenceProfile?: AlignmentEvidenceProfile;
  selectedSpanIndex: number;
  draft: GapDraft | null;
  editable: boolean;
  playbackPositionMs: number | null;
  onSelectSpan: (spanIndex: number) => void;
  onSeek: (positionMs: number) => void;
  onDraftRange: (startMs: number, endMs: number) => void;
}) {
  const [drag, setDrag] = useState<{
    mode: "range" | "start" | "end";
    anchorMs: number;
  } | null>(null);
  const samples = evidenceProfile?.samples.filter((sample) => sample.axis === axis) ?? [];
  const pointerTime = (clientX: number, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return rangeStartMs;
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    return Math.round(rangeStartMs + ratio * (rangeEndMs - rangeStartMs));
  };
  const updateDrag = (clientX: number, element: HTMLElement, active = drag) => {
    if (!active) return;
    const currentMs = pointerTime(clientX, element);
    if (active.mode === "range") onDraftRange(active.anchorMs, currentMs);
    else if (draft) {
      onDraftRange(
        active.mode === "start" ? currentMs : draft.startMs,
        active.mode === "end" ? currentMs : draft.endMs
      );
    }
  };
  const startRangeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!editable) {
      onSeek(pointerTime(event.clientX, event.currentTarget));
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = {
      mode: "range" as const,
      anchorMs: pointerTime(event.clientX, event.currentTarget)
    };
    setDrag(next);
    updateDrag(event.clientX, event.currentTarget, next);
  };
  const moveRangeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateDrag(event.clientX, event.currentTarget);
  };
  const finishRangeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    updateDrag(event.clientX, event.currentTarget);
    setDrag(null);
  };
  const playbackVisible =
    playbackPositionMs !== null &&
    playbackPositionMs >= rangeStartMs &&
    playbackPositionMs <= rangeEndMs;
  const seekByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const current = playbackVisible ? playbackPositionMs : rangeStartMs;
    const stepMs = event.shiftKey ? 100 : 1_000;
    const requested =
      event.key === "Home"
        ? rangeStartMs
        : event.key === "End"
          ? rangeEndMs
          : current + (event.key === "ArrowLeft" ? -stepMs : stepMs);
    onSeek(Math.max(rangeStartMs, Math.min(rangeEndMs, requested)));
  };
  const playbackHead = playbackVisible ? (
    <div
      className="pointer-events-none absolute inset-y-0 z-30 w-px bg-feedback-danger/10 shadow-selection-guide"
      style={{ left: `${positionPercent(playbackPositionMs, rangeStartMs, rangeEndMs)}%` }}
      aria-hidden="true"
    >
      <span className="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent border-t-rose-300" />
    </div>
  ) : null;

  return (
    <div className="time-map-track">
      <div>
        <div className="font-medium text-content-secondary">{label}</div>
        <div
          className="track-time-range text-ui-caption text-content-muted"
          title={formatTimecode(rangeStartMs) + "–" + formatTimecode(rangeEndMs)}
        >
          {formatTimecode(rangeStartMs)}–{formatTimecode(rangeEndMs)}
        </div>
      </div>
      <div className="time-map-track-content">
        <TimeRuler
          startMs={rangeStartMs}
          endMs={rangeEndMs}
          label={axis === "source" ? "参考时间刻度" : "原片时间刻度"}
        />
        <div
          className={
            "time-map-segment-track relative overflow-hidden bg-surface-inset " +
            (editable ? "cursor-crosshair ring-1 ring-cyan-300/35" : "")
          }
          aria-label={label + "色块轨" + (editable ? "，可直接拖动选择独有内容" : "")}
          role="slider"
          tabIndex={0}
          aria-valuemin={rangeStartMs}
          aria-valuemax={rangeEndMs}
          aria-valuenow={playbackVisible ? playbackPositionMs : rangeStartMs}
          aria-valuetext={formatTimecode(playbackVisible ? playbackPositionMs : rangeStartMs)}
          onPointerDown={startRangeDrag}
          onPointerMove={moveRangeDrag}
          onPointerUp={finishRangeDrag}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={seekByKeyboard}
        >
          <TimeRuler startMs={rangeStartMs} endMs={rangeEndMs} label="" grid />
          {spans.map((span, spanIndex) => {
            const startMs = axis === "source" ? span.sourceStartMs : span.targetStartMs;
            const endMs = axis === "source" ? span.sourceEndMs : span.targetEndMs;
            return (
              <Button
                tone="unstyled"
                key={axis + "-" + (span.id ?? spanIndex)}
                type="button"
                className={
                  "absolute inset-y-1 rounded-sm border transition-[filter,outline] " +
                  spanClass(span.kind) +
                  (selectedSpanIndex === spanIndex
                    ? " z-10 outline outline-2 outline-white/80"
                    : " hover:brightness-125")
                }
                style={createTrackStyle(startMs, endMs, rangeStartMs, rangeEndMs)}
                title={"第 " + (spanIndex + 1) + " 段 · " + SPAN_LABELS[span.kind]}
                aria-label={
                  label +
                  "第 " +
                  (spanIndex + 1) +
                  " 段，" +
                  SPAN_LABELS[span.kind] +
                  "，" +
                  formatTimecode(startMs) +
                  "到" +
                  formatTimecode(endMs)
                }
                aria-pressed={selectedSpanIndex === spanIndex}
                onClick={() => onSelectSpan(spanIndex)}
              />
            );
          })}
          {draft ? (
            <div
              className="pointer-events-none absolute inset-y-0 z-20 border-x-2 border-feedback-running bg-feedback-running/10"
              style={createTrackStyle(draft.startMs, draft.endMs, rangeStartMs, rangeEndMs)}
              aria-hidden="true"
            />
          ) : null}
          {playbackHead}
        </div>
        <div
          className={
            "time-map-risk-track relative overflow-hidden bg-surface-inset " +
            (editable ? "cursor-crosshair ring-1 ring-cyan-300/35" : "")
          }
          aria-label={label + "局部证据轨" + (editable ? "，可拖动选择独有内容" : "")}
          onPointerDown={startRangeDrag}
          onPointerMove={moveRangeDrag}
          onPointerUp={finishRangeDrag}
          onPointerCancel={() => setDrag(null)}
        >
          <TimeMapEvidenceCanvas
            samples={samples}
            rangeStartMs={rangeStartMs}
            rangeEndMs={rangeEndMs}
            label={label + "差异风险热力图和时间偏移阶梯"}
          />
          {draft ? (
            <div
              className="pointer-events-none absolute inset-y-0 border-x-2 border-feedback-running bg-feedback-running/10"
              style={createTrackStyle(draft.startMs, draft.endMs, rangeStartMs, rangeEndMs)}
              aria-hidden="true"
            >
              {(["start", "end"] as const).map((side) => (
                <Button
                  tone="unstyled"
                  key={side}
                  type="button"
                  className={
                    "pointer-events-auto absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize rounded border border-feedback-running bg-feedback-running/10 " +
                    (side === "start" ? "left-0" : "left-full")
                  }
                  aria-label={
                    label +
                    "独有内容" +
                    (side === "start" ? "开始 " : "结束 ") +
                    formatTimecode(side === "start" ? draft.startMs : draft.endMs)
                  }
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrag({
                      mode: side,
                      anchorMs: side === "start" ? draft.endMs : draft.startMs
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const deltaMs =
                      (event.shiftKey ? 1_000 : 100) * (event.key === "ArrowLeft" ? -1 : 1);
                    onDraftRange(
                      side === "start" ? draft.startMs + deltaMs : draft.startMs,
                      side === "end" ? draft.endMs + deltaMs : draft.endMs
                    );
                  }}
                />
              ))}
            </div>
          ) : null}
          {playbackHead}
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={"h-2.5 w-2.5 rounded-sm " + color} aria-hidden="true" />
      {label}
    </span>
  );
}

function findLargestOffsetStep(samples: AlignmentEvidenceProfile["samples"]) {
  let best: { atMs: number; deltaMs: number } | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const previousOffsetMs = effectiveOffsetMs(previous);
    const currentOffsetMs = effectiveOffsetMs(current);
    if (previousOffsetMs === null || currentOffsetMs === null) continue;
    const deltaMs = currentOffsetMs - previousOffsetMs;
    if (!best || Math.abs(deltaMs) > Math.abs(best.deltaMs)) {
      best = { atMs: (previous.endMs + current.startMs) / 2, deltaMs };
    }
  }
  return best;
}

function createVisualAnchorInsight(profile: AlignmentEvidenceProfile | undefined) {
  const recovered = profile?.samples.filter(
    (sample) => sample.axis === "source" && sample.visualRecoveryState === "recovered"
  );
  if (!recovered?.length) return null;
  const relocated = recovered.filter(
    (sample) =>
      sample.visualOffsetMs !== undefined &&
      sample.offsetMs !== null &&
      Math.abs(sample.visualOffsetMs - sample.offsetMs) >= 1_000
  );
  return relocated.length > 0
    ? "画面已重新定位 " + relocated.length + " 个音频疑点"
    : "画面已确认 " + recovered.length + " 个风险窗口的位置";
}

function findRiskSpanIndices(
  spans: readonly TimeMapSpan[],
  profile: AlignmentEvidenceProfile | undefined
) {
  const sourceSamples = profile?.samples.filter((sample) => sample.axis === "source") ?? [];
  return spans.flatMap((span, index) => {
    const peakRisk = sourceSamples
      .filter(
        (sample) => sample.endMs > span.sourceStartMs && sample.startMs < span.sourceEndMs
      )
      .reduce(
        (peak, sample) =>
          Math.max(
            peak,
            sample.differenceRisk ?? evidenceDifferenceRisk(sample.state, sample.strength)
          ),
        0
      );
    return span.kind !== "matched" || peakRisk >= 0.45 ? [index] : [];
  });
}

function createRiskInsight(profile: AlignmentEvidenceProfile | undefined) {
  const samples = profile?.samples
    .filter((sample) => sample.axis === "source" && sample.offsetMs !== null)
    .sort((left, right) => left.startMs - right.startMs);
  if (!samples || samples.length < 2) return null;
  const largestStep = findLargestOffsetStep(samples);
  if (!largestStep || Math.abs(largestStep.deltaMs) < 1_000) return null;
  return largestStep.deltaMs > 0
    ? "原片可能多出约 " + formatDuration(Math.abs(largestStep.deltaMs))
    : "参考可能多出约 " + formatDuration(Math.abs(largestStep.deltaMs));
}

function createOffsetStepExplanation(profile: AlignmentEvidenceProfile | undefined) {
  const samples =
    profile?.samples
      .filter((sample) => sample.axis === "source" && effectiveOffsetMs(sample) !== null)
      .sort((left, right) => left.startMs - right.startMs) ?? [];
  const largestStep = findLargestOffsetStep(samples);
  if (!largestStep || Math.abs(largestStep.deltaMs) < 500) return null;
  return largestStep.deltaMs > 0
    ? `最大的一次同步差变化约为 ${formatDuration(
        Math.abs(largestStep.deltaMs)
      )}：算法认为原片在这一带累计比参考多出内容。请把它当作“去这里检查”的提示，不是可拖动标记。`
    : `最大的一次同步差变化约为 ${formatDuration(
        Math.abs(largestStep.deltaMs)
      )}：算法认为参考在这一带累计比原片多出内容。请把它当作“去这里检查”的提示，不是可拖动标记。`;
}

function createTrackStyle(
  startMs: number,
  endMs: number,
  rangeStartMs: number,
  rangeEndMs: number
): { left: string; width: string; transform?: string } {
  const durationMs = Math.max(1, rangeEndMs - rangeStartMs);
  const left = ((startMs - rangeStartMs) / durationMs) * 100;
  const width = ((endMs - startMs) / durationMs) * 100;
  if (startMs === endMs) {
    return {
      left: left + "%",
      width: "3px",
      transform: left >= 100 ? "translateX(-100%)" : "translateX(-1px)"
    };
  }
  return { left: left + "%", width: width + "%" };
}

function positionPercent(positionMs: number, rangeStartMs: number, rangeEndMs: number): number {
  const durationMs = Math.max(1, rangeEndMs - rangeStartMs);
  return Math.max(0, Math.min(100, ((positionMs - rangeStartMs) / durationMs) * 100));
}

function createTrackViewRange(
  fullStartMs: number,
  fullEndMs: number,
  selectedStartMs: number,
  selectedEndMs: number,
  mode: TimeMapViewMode
) {
  if (mode === "overview") return { startMs: fullStartMs, endMs: fullEndMs };
  const fullDurationMs = Math.max(1, fullEndMs - fullStartMs);
  const selectedDurationMs = Math.max(0, selectedEndMs - selectedStartMs);
  const paddingMs = Math.max(
    5_000,
    selectedDurationMs > 0 ? selectedDurationMs * 0.2 : fullDurationMs * 0.015
  );
  let startMs = Math.max(fullStartMs, selectedStartMs - paddingMs);
  let endMs = Math.min(fullEndMs, selectedEndMs + paddingMs);
  if (endMs - startMs < 2_000) {
    const centerMs = (selectedStartMs + selectedEndMs) / 2;
    startMs = Math.max(fullStartMs, centerMs - 1_000);
    endMs = Math.min(fullEndMs, centerMs + 1_000);
  }
  return { startMs: Math.round(startMs), endMs: Math.round(endMs) };
}

function spanClass(kind: TimeMapSpanKind): string {
  if (kind === "matched") return "border-feedback-success/60 bg-feedback-success/10";
  if (kind === "sourceOnly") return "border-feedback-warning/60 bg-feedback-warning/10";
  if (kind === "targetOnly") return "border-feedback-running/60 bg-feedback-running/10";
  return "border-boundary/70 bg-surface-soft/55";
}

function formatDuration(durationMs: number): string {
  return (Math.max(0, durationMs) / 1_000).toFixed(3) + " 秒";
}
