import { useEffect, useMemo, useRef, useState } from "react";
import { createAnchorCalibrationProposal } from "../../domain/alignment/anchorCalibration";
import { serializeAlignmentProposal } from "../../domain/alignment/manualProvider";
import { buildAlignmentPreview } from "../../domain/alignment/preview";
import { buildBatchMergePlan } from "../../domain/danmaku/batchMerge";
import {
  createCutHintSearchPlan,
  findSuspectedCutCandidates
} from "../../domain/danmaku/cutHints";
import { createSourceTimelineSummary } from "../../domain/project/sourceTimeline";
import { formatTimecode } from "../../domain/shared/time";
import { useEditorStore } from "../../stores/editorStore";
import { SourceTimelineSegmentsPanel } from "../assets/SourceTimelineSegmentsPanel";
import { setStatus } from "../assets/assetPanelSharedLogic";
import {
  AlignmentProposalDiagnosticsPanel,
  AnchorCalibrationPanel,
  SuspectedCutPanel
} from "./matchingDiagnosticsPanels";

export function ManualAlignmentWorkspace() {
  const [alignmentProposalText, setAlignmentProposalText] = useState("");
  const [anchorCalibrationText, setAnchorCalibrationText] = useState("");
  const [manualDiagnosticsOpen, setManualDiagnosticsOpen] = useState(false);
  const lastSyncedAlignmentProposalTextRef = useRef("");
  const lastAlignmentProjectIdRef = useRef<string | null>(null);
  const project = useEditorStore((state) => state.project);
  const alignmentProposal = useEditorStore((state) => state.alignmentProposal);
  const cutHintSettings = useEditorStore((state) => state.cutHintSettings);
  const addDanmakuSourceSegment = useEditorStore((state) => state.addDanmakuSourceSegment);
  const updateDanmakuSourceSegment = useEditorStore(
    (state) => state.updateDanmakuSourceSegment
  );
  const deleteDanmakuSourceSegment = useEditorStore(
    (state) => state.deleteDanmakuSourceSegment
  );
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const addCutMarker = useEditorStore((state) => state.addCutMarker);
  const importAlignmentProposalText = useEditorStore(
    (state) => state.importAlignmentProposalText
  );
  const clearAlignmentProposal = useEditorStore((state) => state.clearAlignmentProposal);
  const previewAlignmentProposalData = useEditorStore(
    (state) => state.previewAlignmentProposalData
  );
  const applyAlignmentProposalData = useEditorStore(
    (state) => state.applyAlignmentProposalData
  );
  const setCutHintSettings = useEditorStore((state) => state.setCutHintSettings);
  const cutHintSearch = useMemo(
    () => createCutHintSearchPlan(cutHintSettings),
    [cutHintSettings]
  );
  const suspectedCutCandidates = useMemo(
    () => findSuspectedCutCandidates(project.assets, cutHintSearch.options),
    [cutHintSearch, project.assets]
  );
  const anchorCalibrationProposal = useMemo(
    () => createAnchorCalibrationProposal(anchorCalibrationText),
    [anchorCalibrationText]
  );
  const alignmentPreview = useMemo(
    () => buildAlignmentPreview(project, alignmentProposal),
    [project, alignmentProposal]
  );
  const serializedAlignmentProposalText = useMemo(
    () => (alignmentProposal ? serializeAlignmentProposal(alignmentProposal) : ""),
    [alignmentProposal]
  );
  const batchMergePlan = useMemo(
    () => buildBatchMergePlan(project.assets, { cutMarkers: project.cutMarkers }),
    [project.assets, project.cutMarkers]
  );
  const sourceTimelineSummary = useMemo(
    () => createSourceTimelineSummary(project, batchMergePlan),
    [batchMergePlan, project]
  );
  const targetOriginalMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "targetOriginal"),
    [project.mediaLibrary]
  );
  const bilibiliReferenceMedia = useMemo(
    () => project.mediaLibrary.filter((media) => media.role === "bilibiliReference"),
    [project.mediaLibrary]
  );

  useEffect(() => {
    const projectChanged = lastAlignmentProjectIdRef.current !== project.id;
    lastAlignmentProjectIdRef.current = project.id;
    setAlignmentProposalText((currentText) => {
      const lastSyncedText = lastSyncedAlignmentProposalTextRef.current;
      const hasUserDraft = currentText.trim().length > 0 && currentText !== lastSyncedText;
      if (!projectChanged && hasUserDraft) {
        return currentText;
      }
      lastSyncedAlignmentProposalTextRef.current = serializedAlignmentProposalText;
      return serializedAlignmentProposalText;
    });
  }, [project.id, serializedAlignmentProposalText]);

  return (
    <div
      className="thin-scrollbar grid h-full content-start gap-4 overflow-auto p-4"
      aria-label="来源段与手工规则"
    >
      <details className="thin-scrollbar max-h-[65vh] overflow-y-auto rounded border border-panel-line bg-panel-soft p-2 text-xs text-content-secondary">
        <summary className="cursor-pointer text-sm font-medium text-content-primary">
          手动补充或精修来源段
        </summary>
        <p className="mt-2 leading-5 text-content-muted">
          自动候选不足时再使用。所属 XML
          决定参考素材；未绑定时间图的手工段可调整范围。已确认时间图生成的来源段只允许改输出标签和备注，结构修改必须先撤销确认。
        </p>
        <div className="mt-3">
          <SourceTimelineSegmentsPanel
            segments={project.danmakuSourceSegments}
            assets={project.assets}
            sourceBindings={project.danmakuSourceBindings}
            sourceMediaOptions={bilibiliReferenceMedia}
            targetMediaOptions={targetOriginalMedia}
            plan={batchMergePlan}
            summary={sourceTimelineSummary}
            onAdd={addDanmakuSourceSegment}
            onUpdate={updateDanmakuSourceSegment}
            onDelete={deleteDanmakuSourceSegment}
            onFocus={(timeMs) => {
              setPlayhead(timeMs);
              setStatus({
                message: `已定位弹幕来源时间：${formatTimecode(timeMs)}。`,
                tone: "success"
              });
            }}
          />
        </div>
      </details>
      <details
        className="thin-scrollbar max-h-[65vh] overflow-y-auto rounded border border-panel-line bg-panel-soft p-2 text-xs text-content-secondary"
        data-testid="manual-alignment-diagnostics"
        onToggle={(event) => setManualDiagnosticsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm font-medium text-content-primary">
          手工提案、同步锚点与版本差异
        </summary>
        {manualDiagnosticsOpen ? (
          <>
            <p className="mt-2 leading-5 text-content-muted">
              先查看提案，再明确应用同步锚点或版本差异；修改支持撤销。这里不会选择视频、不会运行自动匹配。
            </p>
            <div className="mt-3 grid gap-3">
              <AlignmentProposalDiagnosticsPanel
                project={project}
                text={alignmentProposalText}
                proposal={alignmentProposal}
                preview={alignmentPreview}
                onTextChange={setAlignmentProposalText}
                onImportText={importAlignmentProposalText}
                onClear={() => {
                  if (alignmentProposal) {
                    clearAlignmentProposal();
                  } else {
                    setStatus({
                      message: "已清空对齐提案草稿。",
                      tone: "neutral"
                    });
                  }
                  setAlignmentProposalText("");
                }}
              />
              <SuspectedCutPanel
                candidates={suspectedCutCandidates}
                cutMarkers={project.cutMarkers}
                keywordsText={cutHintSettings.keywordsText}
                windowSeconds={cutHintSettings.windowSeconds}
                minHitCount={cutHintSettings.minHitCount}
                warnings={cutHintSearch.warnings}
                onKeywordsTextChange={(keywordsText) => setCutHintSettings({ keywordsText })}
                onWindowSecondsChange={(windowSeconds) => setCutHintSettings({ windowSeconds })}
                onMinHitCountChange={(minHitCount) => setCutHintSettings({ minHitCount })}
                onApply={(candidate) => {
                  addCutMarker(candidate.sourceAtMs, 45_000, {
                    name: `待确认版本差异 ${formatTimecode(candidate.sourceAtMs)}`,
                    note: `由弹幕文本扫描生成，需人工复核。来源：${candidate.assetFileName}；关键词：${candidate.keywords.join("、")}`
                  });
                }}
              />
              <AnchorCalibrationPanel
                text={anchorCalibrationText}
                proposal={anchorCalibrationProposal}
                onTextChange={setAnchorCalibrationText}
                onPreview={() => previewAlignmentProposalData(anchorCalibrationProposal)}
                onApply={() => applyAlignmentProposalData(anchorCalibrationProposal)}
              />
            </div>
          </>
        ) : null}
      </details>
    </div>
  );
}
