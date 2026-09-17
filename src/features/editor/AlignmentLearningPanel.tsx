import { useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { TextButton } from "../../components/TextButton";
import {
  buildAlignmentTrainingDatasetExport,
  serializeAlignmentTrainingDataset
} from "../../domain/alignment/alignmentReviewRecords";
import {
  buildPersonalGoldExport,
  buildPersonalGoldPortfolio,
  serializePersonalGoldExport
} from "../../domain/alignment/personalGoldCase";
import { downloadTextFiles } from "../../infrastructure/file-system/browserFiles";
import { useEditorStore } from "../../stores/editorStore";
import { AlignmentAdjudicationPanel } from "./AlignmentAdjudicationPanel";

type PersonalGoldPortfolioModel = ReturnType<typeof buildPersonalGoldPortfolio>;
type PersonalGoldEligibleCaseView = PersonalGoldPortfolioModel["eligibleCases"][number];
type PersonalGoldFrozenCaseView =
  PersonalGoldPortfolioModel["frozenFamilies"][number]["cases"][number];

export function AlignmentLearningPanel() {
  const project = useEditorStore((state) => state.project);
  const freezePersonalGoldCase = useEditorStore((state) => state.freezePersonalGoldCase);
  const portfolio = useMemo(() => buildPersonalGoldPortfolio(project), [project]);
  const [expandedFamilyIds, setExpandedFamilyIds] = useState<Set<string>>(() => new Set());
  const [pendingFocusCaseId, setPendingFocusCaseId] = useState<string | null>(null);
  const caseElements = useRef(new Map<string, HTMLDivElement>());
  const adjudicationRegionRef = useRef<HTMLDivElement>(null);
  const activeRecords = project.alignmentReviewRecords.filter(
    (record) => record.recordState === "active"
  );
  const checkedCount = activeRecords.filter((record) => record.precision !== "rough").length;

  const exportDataset = () => {
    const dataset = buildAlignmentTrainingDatasetExport(project);
    const serialized = serializeAlignmentTrainingDataset(dataset);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = downloadTextFiles(
      [
        { fileName: "manifest.json", content: serialized.manifestJson },
        { fileName: "confidence-samples.jsonl", content: serialized.samplesJsonl }
      ],
      "application/json;charset=utf-8",
      `danmaku-studio-training-data-${stamp}.zip`
    );
    setEditorStatus(
      result.fileCount > 0
        ? `已导出 ${activeRecords.length} 条人工复核记录；单人记录仍是弱标签，不会直接作为训练真值。`
        : "当前没有可导出的人工复核记录。",
      result.fileCount > 0 ? "success" : "warning"
    );
  };

  const exportPersonalGold = () => {
    try {
      const dataset = buildPersonalGoldExport(project);
      const serialized = serializePersonalGoldExport(dataset);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const result = downloadTextFiles(
        [
          {
            fileName: "personal-gold-manifest.json",
            content: serialized.manifestJson
          },
          {
            fileName: "personal-gold-cases.jsonl",
            content: serialized.casesJsonl
          },
          {
            fileName: "personal-gold-confidence-samples.jsonl",
            content: serialized.samplesJsonl
          }
        ],
        "application/json;charset=utf-8",
        `danmaku-studio-personal-gold-${stamp}.zip`
      );
      setEditorStatus(
        result.fileCount > 0
          ? `已导出 ${portfolio.frozenCaseCount} 个冻结 Personal Gold case。`
          : "当前没有可导出的 Personal Gold case。",
        result.fileCount > 0 ? "success" : "warning"
      );
    } catch (error) {
      setEditorStatus(
        error instanceof Error ? error.message : "Personal Gold 导出失败。",
        "error"
      );
    }
  };

  const freezeCase = (item: PersonalGoldEligibleCaseView) => {
    setExpandedFamilyIds((current) => new Set(current).add(item.familyId));
    setPendingFocusCaseId(item.prospectiveCaseId);
    if (!freezePersonalGoldCase(item.reviewRecordId)) setPendingFocusCaseId(null);
  };

  useEffect(() => {
    if (!pendingFocusCaseId) return;
    const element = caseElements.current.get(pendingFocusCaseId);
    if (!element) return;
    element.focus();
    setPendingFocusCaseId(null);
  }, [pendingFocusCaseId, portfolio.frozenCaseCount]);

  const focusAdjudication = () => {
    const element = adjudicationRegionRef.current;
    if (!element) return;
    element.focus();
    element.scrollIntoView?.({ block: "start" });
  };

  return (
    <div
      className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden p-3"
      data-testid="alignment-learning-panel"
      aria-label="算法改进数据工作台"
    >
      <section
        className="rounded border border-panel-line bg-surface-inset p-3"
        data-testid="alignment-learning-summary"
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-content-primary">算法改进数据</h2>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              这里集中处理独立复核、影子风险、盲测任务和训练样本。它们只帮助发现错误与评估算法，
              不会自动修改时间关系，也不会绕过导出验证。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TextButton onClick={exportDataset} disabled={activeRecords.length === 0}>
              <Download size={13} />
              导出训练数据包
            </TextButton>
            <TextButton
              tone="primary"
              onClick={exportPersonalGold}
              disabled={portfolio.frozenCaseCount === 0}
              title={
                portfolio.frozenCaseCount === 0
                  ? "先冻结至少一个 Personal Gold case。"
                  : undefined
              }
            >
              <Download size={13} />
              导出 Personal Gold 数据包
            </TextButton>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <LearningMetric label="当前人工记录" value={activeRecords.length} />
          <LearningMetric label="大致判断" value={activeRecords.length - checkedCount} />
          <LearningMetric label="A/B 核对或更高" value={checkedCount} />
          <LearningMetric label="独立复核票" value={project.alignmentReviewVotes.length} />
        </div>
        <p className="mt-3 text-ui-caption leading-5 text-content-muted">
          数据包不含文件名、路径、音频或画面。重新修改同一片段时旧记录保留为历史，
          但不会重复计入当前样本；只有经过独立裁决的 Gold 才允许进入监督训练。
        </p>
      </section>

      <div className="grid min-h-0 grid-cols-[minmax(19rem,0.85fr)_minmax(0,1.4fr)] gap-3 overflow-hidden">
        <section
          className="min-h-0 overflow-y-auto rounded border border-panel-line bg-surface-inset p-3"
          aria-labelledby="personal-gold-heading"
          data-testid="personal-gold-workbench"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3
                id="personal-gold-heading"
                className="text-xs font-semibold text-content-primary"
              >
                Personal Gold
              </h3>
              <p className="mt-1 text-ui-caption leading-5 text-content-muted">
                把已经独立裁决的算法证据保存为不可变个人回归样本。冻结不会修改 TimeMap
                或签发状态，也不会绕过导出验证。
              </p>
            </div>
            <div className="shrink-0 text-right text-ui-caption text-content-muted">
              <div>可冻结 {portfolio.eligibleCases.length}</div>
              <div>已冻结 {portfolio.frozenCaseCount}</div>
            </div>
          </div>

          {portfolio.eligibleCases.length > 0 ? (
            <div className="mt-3 grid gap-2" aria-label="可冻结 Personal Gold">
              {portfolio.eligibleCases.map((item) => (
                <div
                  key={item.prospectiveCaseId}
                  className="rounded border border-accent-cyan/40 bg-accent-cyan/5 p-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2 text-ui-caption">
                    <span className="rounded bg-panel-soft px-1.5 py-0.5 text-content-secondary">
                      {familyScopeLabel(item.familyScope)}
                    </span>
                    <span className="font-mono text-content-muted">
                      {shortIdentity(item.familyId)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs font-medium text-content-primary">
                    {resolutionLabel(item.resolution)}
                  </div>
                  <p className="mt-1 text-ui-caption leading-5 text-content-muted">
                    人工结论：{decisionLabel(item.decision)} · {item.voteCount} 份独立结论 ·
                    边界容差 {formatTolerance(item.boundaryToleranceMs)}
                  </p>
                  <p className="text-ui-caption leading-4 text-content-muted">
                    区段：参考 {formatRange(item.sourceStartMs, item.sourceEndMs)} → 原片{" "}
                    {formatRange(item.targetStartMs, item.targetEndMs)}
                  </p>
                  <p className="mt-1 text-ui-caption leading-4 text-content-muted">
                    {verificationContextLabel(item.verificationContext)}
                  </p>
                  <div className="mt-2 flex justify-end">
                    <TextButton tone="primary" onClick={() => freezeCase(item)}>
                      冻结为 Personal Gold
                    </TextButton>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {portfolio.pendingIndependentCount + portfolio.conflictCount > 0 ? (
            <div className="mt-3 rounded border border-panel-line/70 bg-surface-inset p-3 text-ui-caption leading-5 text-content-muted">
              待独立复核 {portfolio.pendingIndependentCount} 条，冲突待仲裁{" "}
              {portfolio.conflictCount} 条。
              <div className="mt-2">
                <TextButton onClick={focusAdjudication}>继续独立复核</TextButton>
              </div>
            </div>
          ) : null}

          {portfolio.eligibleCases.length === 0 &&
          portfolio.frozenCaseCount === 0 &&
          portfolio.pendingIndependentCount + portfolio.conflictCount === 0 ? (
            <div className="mt-3 rounded border border-panel-line/70 bg-surface-inset p-3 text-ui-caption leading-5 text-content-muted">
              完成一段人工判断后，它会先进入独立复核；只有两人一致或冲突后完成第三人仲裁，才能冻结。
            </div>
          ) : null}

          {portfolio.frozenFamilies.length > 0 ? (
            <div className="mt-3 grid gap-2" aria-label="已冻结 Personal Gold">
              {portfolio.frozenFamilies.map((family) => {
                const expanded = expandedFamilyIds.has(family.familyId);
                return (
                  <section
                    key={family.familyId}
                    className="rounded border border-panel-line/70 bg-surface-inset p-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-ui-caption text-content-muted">
                          {familyScopeLabel(family.scope)} · {shortIdentity(family.familyId)}
                        </div>
                        <div className="mt-0.5 text-xs text-content-secondary">
                          已冻结 {family.cases.length} 个 case
                        </div>
                      </div>
                      <TextButton
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedFamilyIds((current) => toggleSet(current, family.familyId))
                        }
                      >
                        {expanded ? "收起 case" : "查看 case"}
                      </TextButton>
                    </div>
                    {expanded ? (
                      <div className="mt-2 grid gap-2">
                        {family.cases.map((item) => (
                          <FrozenCaseCard
                            key={item.id}
                            item={item}
                            setElement={(element) => {
                              if (element) caseElements.current.set(item.id, element);
                              else caseElements.current.delete(item.id);
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          ) : null}
        </section>

        <div
          ref={adjudicationRegionRef}
          tabIndex={-1}
          aria-label="独立复核区"
          className="min-h-0 overflow-y-auto rounded outline-none focus:ring-2 focus:ring-accent-cyan/70"
        >
          <AlignmentAdjudicationPanel project={project} />
        </div>
      </div>
    </div>
  );
}

function FrozenCaseCard({
  item,
  setElement
}: {
  item: PersonalGoldFrozenCaseView;
  setElement: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={setElement}
      role="group"
      tabIndex={-1}
      aria-label={`已冻结 Personal Gold case ${shortIdentity(item.id)}`}
      className="rounded border border-accent-green/30 bg-accent-green/5 p-2 outline-none focus:ring-2 focus:ring-accent-cyan/70"
    >
      <div className="flex flex-wrap items-center gap-2 text-ui-caption">
        <span className="text-accent-green">已冻结</span>
        <span className="font-mono text-content-muted">{shortIdentity(item.id)}</span>
        {item.sourceState !== "active" ? (
          <span className="text-accent-amber">来源记录已有更新，冻结版本仍保留</span>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-content-secondary">
        {decisionLabel(item.decision)} · {resolutionLabel(item.resolution)}
      </div>
      <p className="mt-1 text-ui-caption leading-4 text-content-muted">
        参考 {formatRange(item.sourceStartMs, item.sourceEndMs)} → 原片{" "}
        {formatRange(item.targetStartMs, item.targetEndMs)} · {item.voteCount} 份结论
      </p>
      <p className="text-ui-caption leading-4 text-content-muted">
        {verificationContextLabel(item.verificationContext)}
      </p>
    </div>
  );
}

function LearningMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-panel-line/70 bg-surface-inset px-3 py-2">
      <div className="text-ui-caption text-content-muted">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-content-secondary">
        {value}
      </div>
    </div>
  );
}

function setEditorStatus(message: string, tone: "neutral" | "success" | "warning" | "error") {
  useEditorStore.setState({ status: { message, tone } });
}

function familyScopeLabel(scope: "content-identified" | "project-local"): string {
  return scope === "content-identified" ? "内容身份媒体家族" : "项目内媒体家族";
}

function resolutionLabel(resolution: "independentAgreement" | "adjudicator"): string {
  return resolution === "independentAgreement"
    ? "两名独立复核者结论一致"
    : "冲突后由第三人仲裁";
}

function decisionLabel(
  decision: "source-extra" | "target-extra" | "replacement" | "unresolved"
): string {
  if (decision === "source-extra") return "参考素材独有";
  if (decision === "target-extra") return "原片独有";
  if (decision === "replacement") return "版本替换";
  return "仍无法判断";
}

function verificationContextLabel(context: "present" | "absent" | "source-changed"): string {
  if (context === "present") return "当前 TimeMap 有验证记录；它与 Personal Gold 相互独立。";
  if (context === "absent") return "当前 TimeMap 尚无验证记录；冻结不会自动签发。";
  return "来源 TimeMap 版本已变化；冻结 case 仍有效且不会恢复签发。";
}

function formatTolerance(value: number | null): string {
  return value === null ? "未声明" : `${value} ms`;
}

function formatRange(startMs: number, endMs: number): string {
  return `${formatSeconds(startMs)}–${formatSeconds(endMs)}`;
}

function formatSeconds(value: number): string {
  return `${(value / 1_000).toFixed(3)}s`;
}

function shortIdentity(value: string): string {
  return value.slice(-8);
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
