import { Download, Search, Trash2 } from "lucide-react";
import { useRef } from "react";
import { TextButton } from "../../components/TextButton";
import {
  createAlignmentApplyBlockers,
  createAlignmentReviewItemStatuses,
  createAlignmentReviewReport,
  createAlignmentReviewStatusSummary
} from "../../domain/alignment/alignmentReport";
import type { createAnchorCalibrationProposal } from "../../domain/alignment/anchorCalibration";
import type { buildAlignmentPreview } from "../../domain/alignment/preview";
import type { AlignmentProposal } from "../../domain/alignment/types";
import {
  isSuspectedCutCandidateApplied,
  type SuspectedCutCandidate
} from "../../domain/danmaku/cutHints";
import type { CutMarker } from "../../domain/danmaku/types";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import type { EditorProject } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import { formatSignedDuration, setStatus } from "../assets/assetPanelSharedLogic";

export function SuspectedCutPanel({
  candidates,
  cutMarkers,
  keywordsText,
  windowSeconds,
  minHitCount,
  warnings,
  onKeywordsTextChange,
  onWindowSecondsChange,
  onMinHitCountChange,
  onApply
}: {
  candidates: SuspectedCutCandidate[];
  cutMarkers: CutMarker[];
  keywordsText: string;
  windowSeconds: string;
  minHitCount: string;
  warnings: string[];
  onKeywordsTextChange: (value: string) => void;
  onWindowSecondsChange: (value: string) => void;
  onMinHitCountChange: (value: string) => void;
  onApply: (candidate: SuspectedCutCandidate) => void;
}) {
  const previewCandidates = candidates.slice(0, 5);
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <Search size={15} className="text-accent-yellow" />
        <span>疑似版本差异</span>
        <span className="ml-auto text-ui-caption text-content-muted">
          {candidates.length} 个候选
        </span>
      </div>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1">
          <span className="text-content-muted">关键词</span>
          <textarea
            aria-label="疑似版本差异关键词"
            className="min-h-16 resize-y rounded border border-panel-line bg-surface-inset p-2 text-xs leading-5 text-content-primary"
            value={keywordsText}
            placeholder="删了, 剪了, 跳了, 和谐"
            onChange={(event) => onKeywordsTextChange(event.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            <span className="text-content-muted">窗口秒</span>
            <input
              aria-label="疑似版本差异聚类窗口秒"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              inputMode="decimal"
              value={windowSeconds}
              onChange={(event) => onWindowSecondsChange(event.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-content-muted">最小命中</span>
            <input
              aria-label="疑似版本差异最小命中数"
              className="h-8 rounded border border-panel-line bg-surface-inset px-2 text-xs text-content-primary"
              inputMode="numeric"
              value={minHitCount}
              onChange={(event) => onMinHitCountChange(event.target.value)}
            />
          </label>
        </div>
        {warnings.map((warning) => (
          <div key={warning} className="text-ui-caption text-accent-yellow">
            {warning}
          </div>
        ))}
        {previewCandidates.length === 0 ? (
          <div className="border-t border-panel-line pt-2 text-content-muted">暂无候选</div>
        ) : null}
        {previewCandidates.map((candidate) => {
          const applied = isSuspectedCutCandidateApplied(candidate, cutMarkers);
          return (
            <div
              key={candidate.id}
              className="grid gap-2 border-t border-panel-line pt-2 first:border-t-0 first:pt-0"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                <div className="min-w-0">
                  <div
                    className="truncate text-content-primary"
                    title={candidate.assetFileName}
                  >
                    {formatTimecode(candidate.sourceAtMs)} / {candidate.assetFileName}
                  </div>
                  <div
                    className="mt-1 truncate text-content-muted"
                    title={candidate.sampleTexts.join(" / ")}
                  >
                    {candidate.hitCount} 条 / {candidate.keywords.join("、")} /{" "}
                    {confidenceText(candidate.confidence)}
                  </div>
                </div>
                <TextButton
                  tone={applied ? "neutral" : "primary"}
                  disabled={applied}
                  onClick={() => onApply(candidate)}
                >
                  {applied ? "已存在" : "转为版本差异"}
                </TextButton>
              </div>
              <div
                className="truncate text-ui-caption text-content-muted"
                title={candidate.sampleTexts.join(" / ")}
              >
                {candidate.sampleTexts[0]}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function AnchorCalibrationPanel({
  text,
  proposal,
  onTextChange,
  onPreview,
  onApply
}: {
  text: string;
  proposal: ReturnType<typeof createAnchorCalibrationProposal>;
  onTextChange: (value: string) => void;
  onPreview: () => void;
  onApply: () => void;
}) {
  const hasInput = text.trim().length > 0;
  return (
    <section className="rounded border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary">
      <h3 className="text-sm font-medium text-content-primary">锚点校准</h3>
      <div className="mt-3 grid gap-2">
        <textarea
          className="min-h-20 resize-y rounded border border-panel-line bg-surface-inset p-2 text-xs leading-5 text-content-primary"
          value={text}
          placeholder={"每行一个对应点，例如：\n00:10 -> 00:10\n23:12.400 -> 24:34.400"}
          onChange={(event) => onTextChange(event.target.value)}
        />
        {hasInput ? (
          <div className="grid gap-1 text-content-muted">
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-content-muted">锚点</span>
              <span>{proposal.anchors.length} 个</span>
            </div>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-content-muted">推断差异</span>
              <span>{proposal.cutCandidates.length} 个</span>
            </div>
            {proposal.cutCandidates.slice(0, 3).map((candidate) => (
              <div key={candidate.id} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                <span className="text-content-muted">
                  {formatTimecode(candidate.sourceAtMs)}
                </span>
                <span>
                  +{formatTimecode(candidate.targetGapMs)}
                  {formatCandidateSourceRange(candidate)}
                </span>
              </div>
            ))}
            {proposal.diagnostics.length > 0 ? (
              <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-accent-yellow">
                {proposal.diagnostics[0]}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <TextButton disabled={proposal.anchors.length === 0} onClick={onPreview}>
                预览到时间轴
              </TextButton>
              <TextButton
                tone="primary"
                disabled={proposal.anchors.length === 0}
                onClick={onApply}
              >
                应用线索与差异
              </TextButton>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function AlignmentProposalDiagnosticsPanel({
  project,
  text,
  proposal,
  preview,
  onTextChange,
  onImportText,
  onClear
}: {
  project: EditorProject;
  text: string;
  proposal: AlignmentProposal | null;
  preview: ReturnType<typeof buildAlignmentPreview>;
  onTextChange: (value: string) => void;
  onImportText: (value: string, sourceFileName?: string) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const downloadContent = getAlignmentProposalDownloadText(text, proposal);
  const canClearProposal = Boolean(proposal) || text.trim().length > 0;
  const applyBlockerContext = {
    existingAnchors: project.syncAnchors,
    existingCutMarkers: project.cutMarkers
  };
  const applyBlockers = proposal
    ? createAlignmentApplyBlockers(proposal, applyBlockerContext)
    : [];
  const reviewItemStatuses = proposal
    ? createAlignmentReviewItemStatuses(proposal, applyBlockerContext)
    : [];
  const reviewStatusSummary = createAlignmentReviewStatusSummary(reviewItemStatuses);
  const previewCuts = preview.proposalCuts.slice(0, 3);

  const exportProposal = () => {
    if (!downloadContent) {
      setStatus({ message: "暂无可导出的对齐提案。", tone: "warning" });
      return;
    }
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, "-alignment-proposal.json"),
      downloadContent,
      "application/json;charset=utf-8"
    );
    setStatus({ message: `已导出对齐提案 JSON：${fileName}。`, tone: "success" });
  };

  const exportReviewReport = () => {
    if (!proposal) {
      setStatus({ message: "暂无可导出的对齐诊断报告。", tone: "warning" });
      return;
    }
    const fileName = downloadTextFile(
      createProjectDownloadFileName(project.name, "-alignment-review-report.txt"),
      createAlignmentReviewReport(proposal, new Date(), applyBlockerContext),
      "text/plain;charset=utf-8"
    );
    setStatus({ message: `已导出对齐诊断报告：${fileName}。`, tone: "success" });
  };

  return (
    <section
      aria-label="手工 JSON 对齐诊断"
      className="rounded border border-panel-line bg-surface-inset p-3 text-xs text-content-secondary"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-content-primary">
        <Search size={15} className="text-accent-cyan" />
        <span>手工 JSON 与只读结果</span>
        {proposal ? (
          <span className="ml-auto text-ui-caption text-content-muted">
            待检查 {reviewStatusSummary.pendingCount} / 已存在{" "}
            {reviewStatusSummary.appliedCount}
            {reviewStatusSummary.blockedCount > 0
              ? ` / 冲突 ${reviewStatusSummary.blockedCount}`
              : ""}
          </span>
        ) : null}
      </div>
      <p className="mt-2 leading-5 text-content-muted">
        可粘贴或导入 AlignmentProposal JSON，结果只用于证据检查和时间轴候选预览。
        本区不读取视频、不启动 FFmpeg，也不提供旧单对单自动对齐。
      </p>
      <div className="mt-3 grid gap-2">
        <textarea
          aria-label="对齐提案 JSON"
          className="min-h-24 resize-y rounded border border-panel-line bg-surface-inset p-2 font-mono text-xs leading-5 text-content-primary"
          value={text}
          placeholder="粘贴 AlignmentProposal JSON"
          onChange={(event) => onTextChange(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <TextButton onClick={() => inputRef.current?.click()}>选择 JSON 文件</TextButton>
          <TextButton onClick={() => onImportText(text)} disabled={text.trim().length === 0}>
            解析为只读诊断
          </TextButton>
          <TextButton onClick={exportProposal} disabled={!downloadContent}>
            导出 JSON
          </TextButton>
          <TextButton onClick={exportReviewReport} disabled={!proposal}>
            <Download size={14} />
            导出诊断报告
          </TextButton>
          <TextButton onClick={onClear} disabled={!canClearProposal}>
            <Trash2 size={14} />
            清空诊断
          </TextButton>
        </div>
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void readTextFile(file)
                .then((content) => {
                  onTextChange(content);
                  onImportText(content, file.name);
                })
                .catch((error: unknown) => {
                  setStatus({
                    message:
                      error instanceof Error && error.message.trim().length > 0
                        ? `对齐提案文件读取失败：${error.message}`
                        : "对齐提案文件读取失败。",
                    tone: "error"
                  });
                });
            }
            event.target.value = "";
          }}
        />
        {proposal ? (
          <div className="grid gap-2 text-content-muted">
            <AlignmentEvidencePanel proposal={proposal} />
            {applyBlockers.length > 0 ? (
              <div className="rounded border border-accent-yellow/30 bg-accent-yellow/10 p-2 text-ui-caption text-accent-yellow">
                <div className="mb-1 font-medium">诊断警告</div>
                <ul className="grid list-disc gap-1 pl-4">
                  {applyBlockers.slice(0, 3).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
              <span className="text-content-muted">同步锚点</span>
              <span>
                {proposal.anchors.length} 个，候选 {preview.summary.candidateAnchorCount}
              </span>
              <span className="text-content-muted">版本差异</span>
              <span>
                {proposal.cutCandidates.length} 个，候选 {preview.summary.candidateCutCount}
              </span>
            </div>
            {previewCuts.map((candidate) => (
              <div
                key={candidate.id}
                className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 rounded border border-panel-line/70 bg-surface-inset p-2"
              >
                <span className="text-content-muted">
                  {formatTimecode(candidate.sourceAtMs)}
                </span>
                <span>
                  {formatSignedDuration(candidate.targetGapMs)} /{" "}
                  {candidate.state === "applied" ? "项目中已存在" : "只读候选"}
                  {formatCandidateSourceRange(candidate)}
                </span>
              </div>
            ))}
            {proposal.diagnostics.slice(0, 4).map((diagnostic, index) => (
              <div
                key={`${diagnostic}-${index}`}
                className="rounded border border-panel-line bg-surface-inset p-2 leading-5 text-content-muted"
              >
                {diagnostic}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded border border-panel-line bg-surface-inset p-2 leading-5 text-content-muted">
            暂无已解析的对齐提案。普通匹配无需使用本区；仅在收到外部 JSON 或排查旧项目时导入。
          </div>
        )}
      </div>
    </section>
  );
}

export function AlignmentEvidencePanel({ proposal }: { proposal: AlignmentProposal }) {
  if (!proposal.evidence) {
    return null;
  }
  const evidence = proposal.evidence;
  const offsetSummary = createAlignmentOffsetSummary(proposal);
  const timelineMaxMs = createAlignmentEvidenceTimelineMaxMs(proposal);
  const anchorTicks = proposal.anchors.slice(0, 18).map((anchor) => ({
    id: anchor.id,
    x:
      timelineMaxMs > 0 ? Math.min(96, Math.max(4, (anchor.sourceMs / timelineMaxMs) * 100)) : 4
  }));
  const cutBands = proposal.cutCandidates.slice(0, 12).map((candidate) => ({
    id: candidate.id,
    x:
      timelineMaxMs > 0
        ? Math.min(96, Math.max(4, (candidate.sourceAtMs / timelineMaxMs) * 100))
        : 4,
    width:
      timelineMaxMs > 0
        ? Math.min(18, Math.max(3, (Math.abs(candidate.targetGapMs) / timelineMaxMs) * 100))
        : 3
  }));
  return (
    <div className="grid gap-2 rounded border border-panel-line bg-surface-inset p-2 text-ui-caption text-content-secondary">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-content-secondary">对齐证据</span>
        <span className={getAlignmentEvidenceQualityClassName(evidence.quality)}>
          {formatAlignmentEvidenceQuality(evidence.quality)}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-2">
        <EvidenceMetric
          label="算法"
          value={formatAlignmentEvidenceAlgorithm(evidence.algorithm)}
        />
        <EvidenceMetric
          label="稀疏锚点"
          value={`${evidence.monotonicMatchCount} / ${evidence.fingerprintMatchCount}`}
        />
        <EvidenceMetric
          label="强/弱锚点"
          value={`${evidence.strongAnchorCount} / ${evidence.weakAnchorCount}`}
        />
        <EvidenceMetric label="offset 簇" value={`${evidence.offsetClusterCount}`} />
        <EvidenceMetric label="低置信区" value={`${evidence.lowConfidenceRegionCount}`} />
        <EvidenceMetric label="精修候选" value={`${evidence.refinedCandidateCount}`} />
        {evidence.timeMappingSegmentCount !== undefined ? (
          <EvidenceMetric label="时间段" value={`${evidence.timeMappingSegmentCount}`} />
        ) : null}
        {evidence.confirmedChangeCount !== undefined ? (
          <EvidenceMetric label="持续变点" value={`${evidence.confirmedChangeCount}`} />
        ) : null}
      </div>
      <svg
        className="h-12 w-full overflow-visible"
        viewBox="0 0 100 32"
        role="img"
        aria-label="对齐证据图"
        preserveAspectRatio="none"
      >
        <line
          x1="4"
          y1="10"
          x2="96"
          y2="10"
          stroke={"rgb(var(--color-timeline-guide) / 1)"}
          strokeWidth="1"
        />
        <line
          x1="4"
          y1="22"
          x2="96"
          y2="22"
          stroke={"rgb(var(--color-timeline-guide) / 1)"}
          strokeWidth="1"
        />
        {cutBands.map((band) => (
          <rect
            key={band.id}
            x={Math.max(4, band.x - band.width / 2)}
            y="5"
            width={band.width}
            height="22"
            rx="1.5"
            fill={"rgb(var(--color-evidence-cut) / 0.26)"}
          />
        ))}
        {anchorTicks.map((tick) => (
          <circle
            key={tick.id}
            cx={tick.x}
            cy="10"
            r="1.6"
            fill={"rgb(var(--color-evidence-target-only) / 1)"}
          />
        ))}
        {anchorTicks.map((tick) => (
          <circle
            key={`${tick.id}-target`}
            cx={tick.x}
            cy="22"
            r="1.6"
            fill={"rgb(var(--color-evidence-supported) / 1)"}
          />
        ))}
      </svg>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 text-content-muted">
        <span className="text-content-muted">指纹数量</span>
        <span>
          完整版 {evidence.completeFingerprintCount} / B 站删减版{" "}
          {evidence.sourceFingerprintCount}
        </span>
        <span className="text-content-muted">offset 范围</span>
        <span>
          {offsetSummary
            ? `${formatSignedDuration(offsetSummary.minOffsetMs)} 到 ${formatSignedDuration(offsetSummary.maxOffsetMs)}`
            : "锚点不足"}
        </span>
      </div>
      {evidence.signals && evidence.signals.length > 0 ? (
        <div className="grid gap-1 border-t border-panel-line pt-2">
          <div className="text-content-muted">证据信号</div>
          {evidence.signals.map((signal) => (
            <div
              key={signal.kind}
              className="grid gap-0.5 rounded border border-panel-line/70 bg-surface-inset p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-content-secondary">{signal.label}</span>
                <span className={`shrink-0 ${getEvidenceSignalStatusClassName(signal.status)}`}>
                  {formatEvidenceSignalStatus(signal.status)}
                </span>
              </div>
              <div className="text-content-muted">
                观测 {signal.observations} / 权重 {Math.round(signal.weight * 100)}%
              </div>
              <div className="leading-5 text-content-muted">{signal.note}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EvidenceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-0.5 rounded border border-panel-line/70 bg-surface-inset px-2 py-1">
      <span className="truncate text-content-muted">{label}</span>
      <span className="truncate text-content-primary" title={value}>
        {value}
      </span>
    </div>
  );
}

function getAlignmentProposalDownloadText(
  text: string,
  proposal: AlignmentProposal | null
): string {
  const trimmed = text.trim();
  if (trimmed.length > 0) {
    return `${trimmed}\n`;
  }
  if (proposal) {
    return `${JSON.stringify(proposal, null, 2)}\n`;
  }
  return "";
}

function formatAlignmentEvidenceAlgorithm(
  algorithm: NonNullable<AlignmentProposal["evidence"]>["algorithm"]
): string {
  if (algorithm === "alignment-v2-edit-map") {
    return "分段时间映射";
  }
  if (algorithm === "time-map-audio") {
    return "音频时间映射";
  }
  if (algorithm === "offset-path") {
    return "offset 路径";
  }
  if (algorithm === "sparse-fingerprint") {
    return "稀疏指纹";
  }
  if (algorithm === "sparse-fingerprint-fallback") {
    return "稀疏+DP";
  }
  return "密集 DP";
}

function formatAlignmentEvidenceQuality(
  quality: NonNullable<AlignmentProposal["evidence"]>["quality"]
): string {
  if (quality === "high") {
    return "高可信";
  }
  if (quality === "medium") {
    return "中等可信";
  }
  if (quality === "low") {
    return "低可信";
  }
  return "需重跑";
}

function getAlignmentEvidenceQualityClassName(
  quality: NonNullable<AlignmentProposal["evidence"]>["quality"]
): string {
  if (quality === "high") {
    return "text-feedback-success";
  }
  if (quality === "medium") {
    return "text-accent-cyan";
  }
  if (quality === "low") {
    return "text-feedback-warning";
  }
  return "text-feedback-danger";
}

function formatEvidenceSignalStatus(
  status: NonNullable<NonNullable<AlignmentProposal["evidence"]>["signals"]>[number]["status"]
): string {
  if (status === "used") {
    return "已参与";
  }
  if (status === "blocked") {
    return "不可用";
  }
  return "未启用";
}

function getEvidenceSignalStatusClassName(
  status: NonNullable<NonNullable<AlignmentProposal["evidence"]>["signals"]>[number]["status"]
): string {
  if (status === "used") {
    return "text-feedback-success";
  }
  if (status === "blocked") {
    return "text-feedback-danger";
  }
  return "text-content-muted";
}

function createAlignmentOffsetSummary(
  proposal: AlignmentProposal
): { minOffsetMs: number; maxOffsetMs: number } | null {
  if (proposal.anchors.length === 0) {
    return null;
  }
  const offsets = proposal.anchors.map((anchor) => anchor.targetMs - anchor.sourceMs);
  return {
    minOffsetMs: Math.min(...offsets),
    maxOffsetMs: Math.max(...offsets)
  };
}

function createAlignmentEvidenceTimelineMaxMs(proposal: AlignmentProposal): number {
  const anchorMax = proposal.anchors.reduce(
    (current, anchor) => Math.max(current, anchor.sourceMs, anchor.targetMs),
    0
  );
  const cutMax = proposal.cutCandidates.reduce(
    (current, candidate) =>
      Math.max(
        current,
        candidate.sourceAtMs,
        candidate.sourceRangeEndMs ?? candidate.sourceAtMs,
        candidate.sourceAtMs + Math.abs(candidate.targetGapMs)
      ),
    0
  );
  return Math.max(anchorMax, cutMax, 1);
}

function confidenceText(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") {
    return "高置信";
  }
  if (confidence === "medium") {
    return "中置信";
  }
  return "低置信";
}

function formatCandidateSourceRange(candidate: {
  sourceRangeStartMs?: number;
  sourceRangeEndMs?: number;
}): string {
  if (
    candidate.sourceRangeStartMs === undefined ||
    candidate.sourceRangeEndMs === undefined ||
    candidate.sourceRangeEndMs <= candidate.sourceRangeStartMs
  ) {
    return "";
  }
  return ` / 区间 ${formatTimecode(candidate.sourceRangeStartMs)}-${formatTimecode(candidate.sourceRangeEndMs)}`;
}
