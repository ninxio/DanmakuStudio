import { Button } from "../../components/Button";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { TextButton } from "../../components/TextButton";
import { assessAlignmentAdjudication } from "../../domain/alignment/alignmentAdjudication";
import {
  rankAlignmentRecordsForActiveReview,
  type AlignmentActiveReviewPriority
} from "../../domain/alignment/alignmentActiveReview";
import {
  parseAlignmentConfidenceLinearModel,
  rankAlignmentRecordsByShadowRisk,
  type AlignmentConfidenceLinearModel
} from "../../domain/alignment/alignmentConfidenceModel";
import {
  createAlignmentShadowRiskAssociationManifest,
  resolveAlignmentShadowRiskOverlay,
  serializeAlignmentShadowRiskAssociationManifest
} from "../../domain/alignment/alignmentShadowRiskOverlay";
import {
  buildAlignmentShadowRiskLocalPlan,
  serializeAlignmentShadowRiskLocalPlan
} from "../../domain/alignment/alignmentShadowRiskLocalPlan";
import {
  buildAlignmentMultimodalRuleSnapshot,
  serializeAlignmentMultimodalRuleSnapshot
} from "../../domain/alignment/alignmentMultimodalRuleSnapshot";
import {
  buildAlignmentShadowRiskEvaluationReceipt,
  serializeAlignmentShadowRiskEvaluationReceipt
} from "../../domain/alignment/alignmentShadowRiskEvaluation";
import {
  buildAlignmentReviewEfficiencyReceipt,
  serializeAlignmentReviewEfficiencyReceipt
} from "../../domain/alignment/alignmentReviewEfficiency";
import type {
  AlignmentReviewDecision,
  AlignmentReviewRecord,
  EditorProject
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import {
  archiveContainsEquivalentMultimodalRuleSnapshot,
  multimodalRuleSnapshotRuleSetKey,
  type MultimodalRuleSnapshotArchive
} from "../../infrastructure/alignment/multimodalRuleSnapshotArchive";
import {
  clearDesktopMultimodalRuleSnapshotArchive,
  ensureDesktopMultimodalRuleSnapshot,
  hydrateDesktopMultimodalRuleSnapshotArchive,
  loadMultimodalRuleSnapshotArchive,
  persistDesktopMultimodalRuleSnapshot
} from "../../infrastructure/alignment/multimodalRuleSnapshotArchiveStore";
import {
  buildAudioAlignmentSensitiveBlindReviewPack,
  listAudioAlignmentSensitiveManifestSummaries,
  openAudioAlignmentSensitiveManifestDirectory,
  type AlignmentSensitiveManifestSummary
} from "../../infrastructure/alignment/tauriAudioAlignment";
import { useEditorStore } from "../../stores/editorStore";

const MultimodalBlindReviewPanel = lazy(() =>
  import("./MultimodalBlindReviewPanel").then((module) => ({
    default: module.MultimodalBlindReviewPanel
  }))
);

const DECISIONS: Array<{ value: AlignmentReviewDecision; label: string }> = [
  { value: "source-extra", label: "参考独有" },
  { value: "target-extra", label: "原片独有" },
  { value: "replacement", label: "版本替换" },
  { value: "unresolved", label: "仍不能确定" }
];

function AlignmentEvidenceInventoryPanel({
  onPackGenerated
}: {
  onPackGenerated: (packJson: string) => void;
}) {
  const desktop = isTauri();
  const [summaries, setSummaries] = useState<AlignmentSensitiveManifestSummary[] | null>(
    desktop ? null : []
  );
  const [error, setError] = useState<string | null>(null);
  const [mediaFamilyLabel, setMediaFamilyLabel] = useState("");
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [generatedPackJson, setGeneratedPackJson] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = async () => {
    try {
      setError(null);
      setSummaries(await listAudioAlignmentSensitiveManifestSummaries());
    } catch (loadError: unknown) {
      setSummaries([]);
      setError(
        loadError instanceof Error ? loadError.message : "本机真实训练证据索引无法读取。"
      );
    }
  };
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void listAudioAlignmentSensitiveManifestSummaries()
      .then((loaded) => {
        if (!active) return;
        setSummaries(loaded);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setSummaries([]);
        setError(
          loadError instanceof Error ? loadError.message : "本机真实训练证据索引无法读取。"
        );
      });
    return () => {
      active = false;
    };
  }, [desktop]);
  if (!desktop) return null;
  const ready = summaries?.filter((summary) => summary.readyForTrainingIntake) ?? [];
  const collecting = summaries?.filter((summary) => summary.intakeState === "collecting") ?? [];
  const evidenceGroups = new Set(
    ready
      .map((summary) => summary.evidenceGroupKey)
      .filter((key): key is `sha256:${string}` => key !== null)
  ).size;
  const completedPairs = ready.reduce(
    (total, summary) => total + summary.completedPairCount,
    0
  );
  const uncertainSpans = ready.reduce(
    (total, summary) => total + summary.uncertainSpanCount,
    0
  );
  const reviewPairs = ready.flatMap((summary) =>
    summary.reviewCandidatePairs.map((pair) => ({ summary, pair }))
  );
  const generatePack = async (runId: string, pairOrdinal: number): Promise<void> => {
    const key = `${runId}:${pairOrdinal}`;
    setGeneratingKey(key);
    setError(null);
    setMessage(null);
    try {
      const json = await buildAudioAlignmentSensitiveBlindReviewPack(
        runId,
        pairOrdinal,
        mediaFamilyLabel
      );
      setGeneratedPackJson(json);
      onPackGenerated(json);
      setMessage("任务已在下方盲复核工作台打开；候选来源和系统推荐保持隐藏。");
    } catch (generateError: unknown) {
      setError(
        generateError instanceof Error ? generateError.message : "真实证据盲复核任务无法生成。"
      );
    } finally {
      setGeneratingKey(null);
    }
  };
  return (
    <details className="mt-3 rounded border border-panel-line bg-surface-inset p-2.5 text-ui-caption text-content-muted">
      <summary className="cursor-pointer rounded font-medium text-content-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-cyan">
        真实验证数据 · {summaries === null ? "正在读取" : `${ready.length} 次运行可整理`}
      </summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="mr-auto leading-5">
          {summaries === null
            ? "正在读取跨重启保存的本机运行证据。"
            : summaries.length === 0
              ? "尚无可整理运行。用桌面版完成一次智能匹配后，完整证据会自动出现在这里。"
              : `已保存 ${summaries.length} 次运行；可整理 ${ready.length} 次、${completedPairs} 个完成关系、${uncertainSpans} 个疑点段，另有 ${collecting.length} 次仍在采集。`}
        </span>
        <TextButton onClick={() => void load()}>刷新</TextButton>
        <TextButton
          onClick={() => {
            void openAudioAlignmentSensitiveManifestDirectory().catch((openError: unknown) => {
              setError(
                openError instanceof Error ? openError.message : "本机训练证据目录无法打开。"
              );
            });
          }}
        >
          打开证据目录
        </TextButton>
      </div>
      {ready.length > 0 ? (
        <p className="mt-1 leading-5 text-content-muted">
          当前覆盖 {evidenceGroups}{" "}
          个不同运行组。运行组只是内容身份去重结果，不等于已经满足“三个独立媒体家族”；
          后续任务包仍会隐藏系统建议，并要求两名真实独立复核者逐帧一致。
        </p>
      ) : null}
      {reviewPairs.length > 0 ? (
        <div className="mt-2 rounded border border-panel-line/70 bg-surface-inset p-2">
          <label className="grid gap-1 text-content-muted">
            这批素材属于哪个媒体家族？
            <input
              value={mediaFamilyLabel}
              onChange={(event) => setMediaFamilyLabel(event.target.value)}
              placeholder="例如 Dark 第三季；同一季度的不同版本请填写相同名称"
              className="rounded border border-panel-line bg-panel px-2 py-1.5 text-content-secondary outline-none focus:border-accent-cyan"
            />
          </label>
          <p className="mt-1 leading-5 text-content-muted">
            名称只在内存中转成摘要，不写入任务包。它用于防止同一作品的多个版本被误算成多个独立家族。
          </p>
          <div className="mt-2 grid gap-1.5">
            {reviewPairs.map(({ summary, pair }) => {
              const key = `${summary.runId}:${pair.pairOrdinal}`;
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-2 rounded border border-panel-line/60 px-2 py-1.5"
                >
                  <span className="mr-auto text-content-muted">
                    运行 {summary.runId.slice(-8)} · 关系 {pair.pairOrdinal} · 自动挑选{" "}
                    {pair.tasks.length}
                    个窗口（{pair.riskyTaskCount} 个疑点＋
                    {pair.tasks.length - pair.riskyTaskCount} 个对照）
                  </span>
                  <TextButton
                    disabled={generatingKey !== null || mediaFamilyLabel.trim().length < 3}
                    onClick={() => void generatePack(summary.runId, pair.pairOrdinal)}
                  >
                    {generatingKey === key ? "正在核验媒体…" : "打开盲复核"}
                  </TextButton>
                </div>
              );
            })}
          </div>
          {generatedPackJson ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="mr-auto text-content-muted">
                任务包含本机媒体路径，只能交给能访问相同文件的人。
              </span>
              <TextButton
                onClick={() =>
                  downloadTextFile(
                    `danmaku-real-evidence-blind-review-${Date.now()}.json`,
                    generatedPackJson,
                    "application/json;charset=utf-8"
                  )
                }
              >
                保存任务包
              </TextButton>
            </div>
          ) : null}
        </div>
      ) : ready.some((summary) => summary.manifestCanonicalPayloadDigest === null) ? (
        <p className="mt-2 leading-5 text-feedback-warning/80">
          这些运行由旧版本保存，缺少完整内容防篡改绑定。请用当前版本重新完成匹配后再生成盲复核任务。
        </p>
      ) : null}
      {message ? <p className="mt-1 leading-5 text-feedback-success/80">{message}</p> : null}
      {error ? (
        <p role="alert" className="mt-1 leading-5 text-accent-red">
          {error}
        </p>
      ) : null}
    </details>
  );
}

export function AlignmentAdjudicationPanel({ project }: { project: EditorProject }) {
  const submitVote = useEditorStore((state) => state.submitAlignmentReviewVote);
  const importAudioRisk = useEditorStore((state) => state.importAlignmentShadowRiskOverlayJson);
  const clearAudioRisk = useEditorStore((state) => state.clearAlignmentShadowRiskOverlay);
  const [reviewerId, setReviewerId] = useState("");
  const [sessionId] = useState(createReviewSessionId);
  const [shadowModel, setShadowModel] = useState<AlignmentConfidenceLinearModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [audioRiskError, setAudioRiskError] = useState<string | null>(null);
  const [multimodalArchive, setMultimodalArchive] =
    useState<MultimodalRuleSnapshotArchive | null>(() => loadMultimodalRuleSnapshotArchive());
  const [multimodalArchiveReady, setMultimodalArchiveReady] = useState(() => !isTauri());
  const [multimodalArchiveMessage, setMultimodalArchiveMessage] = useState<string | null>(null);
  const [generatedBlindReviewPackJson, setGeneratedBlindReviewPackJson] = useState<
    string | null
  >(null);
  const lastAutomaticRuleSetKey = useRef<string | null>(null);
  const automaticRuleSetWriteInFlight = useRef<string | null>(null);
  const mediaTimeMaps = project.mediaTimeMaps;
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void hydrateDesktopMultimodalRuleSnapshotArchive()
      .then((archive) => {
        if (!active) return;
        setMultimodalArchive(archive);
        setMultimodalArchiveReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMultimodalArchiveMessage(
          error instanceof Error ? error.message : "视觉对照规则本机档案无法读取。"
        );
        setMultimodalArchiveReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const automaticMultimodalSnapshotResult = useMemo(
    () => buildAlignmentMultimodalRuleSnapshot({ mediaTimeMaps }),
    [mediaTimeMaps]
  );
  const automaticMultimodalSnapshot = automaticMultimodalSnapshotResult.snapshot;
  const automaticRuleSetKey = useMemo(
    () =>
      automaticMultimodalSnapshot
        ? multimodalRuleSnapshotRuleSetKey(automaticMultimodalSnapshot)
        : null,
    [automaticMultimodalSnapshot]
  );
  useEffect(() => {
    if (!multimodalArchiveReady || !automaticMultimodalSnapshot || !automaticRuleSetKey) return;
    if (
      archiveContainsEquivalentMultimodalRuleSnapshot(
        multimodalArchive,
        automaticMultimodalSnapshot
      )
    ) {
      lastAutomaticRuleSetKey.current = automaticRuleSetKey;
      return;
    }
    if (
      lastAutomaticRuleSetKey.current === automaticRuleSetKey ||
      automaticRuleSetWriteInFlight.current === automaticRuleSetKey
    ) {
      return;
    }
    automaticRuleSetWriteInFlight.current = automaticRuleSetKey;
    let active = true;
    void ensureDesktopMultimodalRuleSnapshot(automaticMultimodalSnapshot)
      .then(({ archive, desktopPersisted, added }) => {
        lastAutomaticRuleSetKey.current = automaticRuleSetKey;
        automaticRuleSetWriteInFlight.current = null;
        if (!active) return;
        setMultimodalArchive(archive);
        if (added) {
          setMultimodalArchiveMessage(
            desktopPersisted
              ? `已自动保存 ${automaticMultimodalSnapshotResult.eligibleTimeMapCount} 份合格生产规则；本机实验档案现有 ${archive.entries.length} 份快照。`
              : `已自动保存 ${automaticMultimodalSnapshotResult.eligibleTimeMapCount} 份合格生产规则到浏览器兼容档案。`
          );
        }
      })
      .catch((error: unknown) => {
        automaticRuleSetWriteInFlight.current = null;
        if (!active) return;
        setMultimodalArchiveMessage(
          error instanceof Error ? error.message : "生产规则无法自动保存到本机实验档案。"
        );
      });
    return () => {
      active = false;
    };
  }, [
    automaticMultimodalSnapshot,
    automaticMultimodalSnapshotResult.eligibleTimeMapCount,
    automaticRuleSetKey,
    multimodalArchive,
    multimodalArchiveReady
  ]);
  const activeRecords = useMemo(
    () => project.alignmentReviewRecords.filter((record) => record.recordState === "active"),
    [project.alignmentReviewRecords]
  );
  const modelShadowScores = useMemo(
    () =>
      shadowModel
        ? new Map(
            rankAlignmentRecordsByShadowRisk(activeRecords, shadowModel).map((score) => [
              score.recordId,
              score
            ])
          )
        : null,
    [activeRecords, shadowModel]
  );
  const audioShadowOverlay = useMemo(
    () => resolveAlignmentShadowRiskOverlay(project),
    [project]
  );
  const audioRiskAssociation = useMemo(
    () => createAlignmentShadowRiskAssociationManifest(project),
    [project]
  );
  const audioRiskEvaluation = useMemo(() => {
    if (!project.alignmentShadowRiskOverlay) return null;
    try {
      return buildAlignmentShadowRiskEvaluationReceipt(
        project,
        project.alignmentShadowRiskOverlay.generatedAt
      );
    } catch {
      return null;
    }
  }, [project]);
  const reviewEfficiency = useMemo(() => {
    if (project.alignmentReviewVotes.length === 0) return null;
    try {
      return buildAlignmentReviewEfficiencyReceipt(project, project.updatedAt);
    } catch {
      return null;
    }
  }, [project]);
  const combinedShadowRisks = useMemo(() => {
    const combined = new Map<string, number>();
    for (const [recordId, risk] of audioShadowOverlay?.risks ?? []) {
      combined.set(recordId, risk);
    }
    for (const [recordId, score] of modelShadowScores ?? []) {
      combined.set(recordId, Math.max(combined.get(recordId) ?? 0, score.risk));
    }
    return combined.size > 0 ? combined : null;
  }, [audioShadowOverlay, modelShadowScores]);
  const activeReviewPriorities = useMemo(
    () =>
      new Map(
        rankAlignmentRecordsForActiveReview(project, combinedShadowRisks).map((priority) => [
          priority.recordId,
          priority
        ])
      ),
    [combinedShadowRisks, project]
  );
  const records = useMemo(
    () =>
      activeRecords
        .map((record) => ({ record, status: assessAlignmentAdjudication(project, record.id) }))
        .sort(
          (left, right) =>
            (activeReviewPriorities.get(right.record.id)?.score ?? 0) -
              (activeReviewPriorities.get(left.record.id)?.score ?? 0) ||
            stateOrder(left.status.state) - stateOrder(right.status.state)
        ),
    [activeRecords, activeReviewPriorities, project]
  );
  if (records.length === 0) {
    return (
      <>
        <AlignmentEvidenceInventoryPanel onPackGenerated={setGeneratedBlindReviewPackJson} />
        {generatedBlindReviewPackJson ? (
          <Suspense
            fallback={
              <p className="mt-2 text-ui-caption text-content-muted">正在加载盲复核工具…</p>
            }
          >
            <MultimodalBlindReviewPanel initialPackJson={generatedBlindReviewPackJson} />
          </Suspense>
        ) : null}
      </>
    );
  }
  const goldCount = records.filter((item) => item.status.state === "gold").length;
  const conflictCount = records.filter((item) => item.status.state === "conflict").length;
  const exportLocalAudioRiskBundle = () => {
    const result = buildAlignmentShadowRiskLocalPlan(project);
    if (!result.plan) {
      setAudioRiskError(
        `当前没有可算分的记录（已跳过 ${result.skippedRecordCount} 条）。请确认两侧都是已连接的本地文件、已完成全文件身份校验，并明确选择音轨。`
      );
      return;
    }
    const confirmed = window.confirm(
      `将导出 ${result.eligibleRecordCount} 条记录的本机计算包${result.skippedRecordCount > 0 ? `，另有 ${result.skippedRecordCount} 条因缺少路径、全文件身份、明确音轨或有效区间被安全跳过` : ""}。它包含完整媒体路径，只能留在本机，不能分享或上传；同时会另存一份不含路径的关联清单。是否继续？`
    );
    if (!confirmed) return;
    downloadTextFile(
      `danmaku-shadow-risk-association-${audioRiskAssociation.manifestId.slice(7, 23)}.json`,
      serializeAlignmentShadowRiskAssociationManifest(project),
      "application/json;charset=utf-8"
    );
    downloadTextFile(
      `danmaku-shadow-risk-local-plan-${result.plan.planId.slice(7, 23)}.json`,
      serializeAlignmentShadowRiskLocalPlan(result.plan),
      "application/json;charset=utf-8"
    );
    setAudioRiskError(null);
  };
  const exportAudioRiskEvaluation = () => {
    try {
      const receipt = buildAlignmentShadowRiskEvaluationReceipt(project);
      downloadTextFile(
        `danmaku-shadow-risk-evaluation-${receipt.receiptId.slice(7, 23)}.json`,
        serializeAlignmentShadowRiskEvaluationReceipt(receipt),
        "application/json;charset=utf-8"
      );
      setAudioRiskError(null);
    } catch (error: unknown) {
      setAudioRiskError(
        error instanceof Error ? error.message : "当前复核效果无法生成可审计收据。"
      );
    }
  };
  const exportMultimodalRuleSnapshot = async () => {
    const result = buildAlignmentMultimodalRuleSnapshot(project);
    if (!result.snapshot) {
      setAudioRiskError(
        "当前没有可导出的生产规则时间图。请先完成自动匹配，并确保时间图绑定完整媒体摘要且未被人工接管。"
      );
      return;
    }
    const confirmed = window.confirm(
      `将下载 ${result.eligibleTimeMapCount} 份生产规则时间图，并同步更新本机实验档案${result.skippedTimeMapCount > 0 ? `；另有 ${result.skippedTimeMapCount} 份因人工接管、旧格式、无效结构或缺少完整媒体摘要被安全跳过` : ""}。文件不含路径和片名，但包含完整媒体 SHA-256 与分段结构，只能留在本机用于 DINOv2 影子评估。是否继续？`
    );
    if (!confirmed) return;
    const fileName = `danmaku-multimodal-rule-snapshot-${result.snapshot.snapshotId.slice(7, 23)}.json`;
    const content = serializeAlignmentMultimodalRuleSnapshot(result.snapshot);
    try {
      const { archive, desktopPersisted } = await persistDesktopMultimodalRuleSnapshot(
        result.snapshot
      );
      setMultimodalArchive(archive);
      setMultimodalArchiveMessage(
        desktopPersisted
          ? `已保存并下载；本机实验档案现有 ${archive.entries.length} 份快照。`
          : `已下载并保存兼容档案；桌面版会把 ${archive.entries.length} 份快照写入 app-data。`
      );
      setAudioRiskError(null);
    } catch (error: unknown) {
      setMultimodalArchiveMessage(
        `${error instanceof Error ? error.message : "本机实验档案保存失败。"} 已继续下载本次快照，请妥善保留。`
      );
    }
    downloadTextFile(fileName, content, "application/json;charset=utf-8");
  };
  const downloadLatestMultimodalRuleSnapshot = () => {
    const latest = multimodalArchive?.entries[0];
    if (!latest) return;
    downloadTextFile(
      `danmaku-multimodal-rule-snapshot-${latest.snapshotId.slice(7, 23)}.json`,
      serializeAlignmentMultimodalRuleSnapshot(latest.snapshot),
      "application/json;charset=utf-8"
    );
    setMultimodalArchiveMessage("已重新下载最近保存的视觉对照规则。");
  };
  const clearMultimodalRuleSnapshots = async () => {
    if (!window.confirm("清空本机保存的视觉对照规则档案？已下载的文件不会被删除。")) return;
    try {
      lastAutomaticRuleSetKey.current = automaticRuleSetKey;
      await clearDesktopMultimodalRuleSnapshotArchive();
      setMultimodalArchive(null);
      setMultimodalArchiveMessage(
        "本机视觉对照规则档案已清空。当前规则不会立即重建；项目产生新规则后会再次自动保存。"
      );
    } catch (error: unknown) {
      setMultimodalArchiveMessage(
        error instanceof Error ? error.message : "本机视觉对照规则档案清理失败。"
      );
    }
  };
  const exportReviewEfficiency = () => {
    try {
      const receipt = buildAlignmentReviewEfficiencyReceipt(project);
      downloadTextFile(
        `danmaku-review-efficiency-${receipt.receiptId.slice(7, 23)}.json`,
        serializeAlignmentReviewEfficiencyReceipt(receipt),
        "application/json;charset=utf-8"
      );
      setAudioRiskError(null);
    } catch (error: unknown) {
      setAudioRiskError(
        error instanceof Error ? error.message : "当前复核耗时无法生成可审计收据。"
      );
    }
  };

  return (
    <>
      <AlignmentEvidenceInventoryPanel onPackGenerated={setGeneratedBlindReviewPackJson} />
      <div className="mt-3 rounded border border-panel-line bg-surface-inset p-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-content-secondary">独立复核队列</div>
            <p className="mt-1 leading-5 text-content-muted">
              日常粗略校正继续保留为弱标签。只有两个不同复核者独立得出相同结论，或冲突后由第三人仲裁，才会成为
              Gold。
            </p>
            <p className="mt-1 leading-5 text-content-muted">
              队列会优先显示人工判断曾改变、边界漂移、证据冲突或风险较高的片段；不会展示旧结论内容，也不会因此自动升级标签。
            </p>
          </div>
          <label className="grid min-w-56 gap-1 text-ui-caption text-content-muted">
            本次复核者代号（项目只保存摘要）
            <input
              value={reviewerId}
              onChange={(event) => setReviewerId(event.target.value)}
              placeholder="例如 reviewer-demo"
              className="h-8 rounded border border-panel-line bg-panel-base px-2 text-xs text-content-secondary outline-none focus:border-accent-cyan"
            />
          </label>
        </div>
        <div className="mt-2 text-ui-caption text-content-muted">
          待独立复核 {records.length - goldCount - conflictCount} · 冲突待仲裁 {conflictCount} ·
          Gold {goldCount}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-panel-line/60 bg-surface-inset px-2 py-1.5 text-ui-caption text-content-muted">
          <span className="mr-auto">
            {shadowModel
              ? "影子模型已加载：只按风险排序，不会自动采用或修改 TimeMap。"
              : "尚无通过训练的模型；不会伪造风险分数。可加载训练脚本输出的 linear-model.json 做本地影子测试。"}
          </span>
          <label className="cursor-pointer rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary">
            加载影子模型
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file
                  .text()
                  .then((text) => {
                    setShadowModel(
                      parseAlignmentConfidenceLinearModel(JSON.parse(text) as unknown)
                    );
                    setModelError(null);
                  })
                  .catch((error: unknown) => {
                    setShadowModel(null);
                    setModelError(
                      error instanceof Error ? error.message : "模型文件无法读取。"
                    );
                  });
                event.target.value = "";
              }}
            />
          </label>
          {shadowModel ? (
            <Button
              tone="unstyled"
              type="button"
              className="text-content-muted hover:text-content-secondary"
              onClick={() => setShadowModel(null)}
            >
              移除
            </Button>
          ) : null}
        </div>
        {modelError ? (
          <p className="mt-1 text-ui-caption text-accent-red">{modelError}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-panel-line/60 bg-surface-inset px-2 py-1.5 text-ui-caption text-content-muted">
          <span className="mr-auto">
            {audioShadowOverlay
              ? `离线音频风险已关联 ${audioShadowOverlay.appliedCount} 条记录${audioShadowOverlay.staleCount > 0 ? `，${audioShadowOverlay.staleCount} 条因记录变化已失效` : ""}；只影响队列排序。`
              : "可导出无路径关联清单；本机算分包会额外包含完整媒体路径，必须留在本机。"}
          </span>
          <Button
            tone="unstyled"
            type="button"
            className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary"
            onClick={() =>
              downloadTextFile(
                `danmaku-shadow-risk-association-${audioRiskAssociation.manifestId.slice(7, 23)}.json`,
                serializeAlignmentShadowRiskAssociationManifest(project),
                "application/json;charset=utf-8"
              )
            }
          >
            导出关联清单
          </Button>
          <Button
            tone="unstyled"
            type="button"
            className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary"
            onClick={exportLocalAudioRiskBundle}
          >
            导出本机算分包
          </Button>
          <Button
            tone="unstyled"
            type="button"
            className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary"
            onClick={() => void exportMultimodalRuleSnapshot()}
            disabled={!multimodalArchiveReady}
          >
            下载当前视觉对照规则
          </Button>
          <label className="cursor-pointer rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary">
            加载音频风险
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void readTextFile(file)
                  .then((text) => {
                    const imported = importAudioRisk(text);
                    setAudioRiskError(
                      imported ? null : "风险文件未通过项目绑定或完整性检查，请查看底部状态。"
                    );
                  })
                  .catch((error: unknown) => {
                    setAudioRiskError(
                      error instanceof Error ? error.message : "风险文件无法读取。"
                    );
                  });
                event.target.value = "";
              }}
            />
          </label>
          {project.alignmentShadowRiskOverlay ? (
            <>
              <Button
                tone="unstyled"
                type="button"
                className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary"
                onClick={exportAudioRiskEvaluation}
              >
                导出复核效果收据
              </Button>
              <Button
                tone="unstyled"
                type="button"
                className="text-content-muted hover:text-content-secondary"
                onClick={clearAudioRisk}
              >
                移除音频风险
              </Button>
            </>
          ) : null}
          {project.alignmentReviewVotes.length > 0 ? (
            <Button
              tone="unstyled"
              type="button"
              className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary"
              onClick={exportReviewEfficiency}
            >
              导出复核耗时收据
            </Button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-accent-cyan/20 bg-accent-cyan/5 px-2 py-1.5 text-ui-caption text-content-muted">
          <span className="mr-auto">
            {!multimodalArchiveReady
              ? "正在读取视觉匹配实验档案…"
              : multimodalArchive?.entries.length
                ? `视觉匹配实验：本机已自动保留 ${multimodalArchive.entries.length} 份生产规则快照，关闭应用或重新打包后仍可下载。`
                : "视觉匹配实验：尚无合格生产规则；自动匹配产生新规则后会保存在本机，下载仍需手动。"}
          </span>
          {multimodalArchive?.entries.length ? (
            <>
              <Button
                tone="unstyled"
                type="button"
                className="rounded border border-panel-line bg-panel-soft px-2 py-1 text-content-secondary hover:border-boundary"
                onClick={downloadLatestMultimodalRuleSnapshot}
              >
                下载最近快照
              </Button>
              <Button
                tone="unstyled"
                type="button"
                className="text-content-muted hover:text-content-secondary"
                onClick={() => void clearMultimodalRuleSnapshots()}
              >
                清空快照档案
              </Button>
            </>
          ) : null}
        </div>
        {multimodalArchiveMessage ? (
          <p className="mt-1 text-ui-caption leading-4 text-content-muted">
            {multimodalArchiveMessage}
          </p>
        ) : null}
        <Suspense
          fallback={
            <p className="mt-2 text-ui-caption text-content-muted">正在加载多模态盲复核工具…</p>
          }
        >
          <MultimodalBlindReviewPanel initialPackJson={generatedBlindReviewPackJson} />
        </Suspense>
        {audioRiskEvaluation ? (
          <p className="mt-1 text-ui-caption leading-4 text-content-muted">
            {audioRiskEvaluation.summary.evaluatedGoldCount > 0
              ? `当前有 ${audioRiskEvaluation.summary.evaluatedGoldCount} 条非冻结 Gold 可衡量风险排序，其中 ${audioRiskEvaluation.summary.goldErrorCount} 条为算法错误；${audioRiskEvaluation.summary.accuracyClaimReady ? "样本覆盖已达到最低效果声明门槛。" : "样本或覆盖仍不足，不能宣称准确率。"}`
              : `当前只有 ${audioRiskEvaluation.summary.weakReviewedCount} 条弱复核、${audioRiskEvaluation.summary.conflictCount} 条冲突；它们只用于选样，不能计算准确率。`}
            {audioRiskEvaluation.summary.withheldFrozenGoldCount > 0
              ? ` 已隐藏 ${audioRiskEvaluation.summary.withheldFrozenGoldCount} 条 frozen Gold 结果。`
              : ""}
          </p>
        ) : null}
        {reviewEfficiency ? (
          <p className="mt-1 text-ui-caption leading-4 text-content-muted">
            已自动记录 {reviewEfficiency.summary.measuredVoteCount}/
            {reviewEfficiency.summary.submittedVoteCount} 次表单复核耗时
            {reviewEfficiency.summary.medianDurationMs !== null
              ? `，中位约 ${(reviewEfficiency.summary.medianDurationMs / 1_000).toFixed(1)} 秒`
              : ""}
            ；这是从首次操作到提交的近似值，不代表逐帧工时。
            {reviewEfficiency.summary.currentOverlayEntryCount > 0
              ? ` 当前音频风险失效 ${reviewEfficiency.summary.currentOverlayStaleCount}/${reviewEfficiency.summary.currentOverlayEntryCount} 条。`
              : ""}
          </p>
        ) : null}
        {audioRiskError ? (
          <p role="alert" className="mt-1 text-ui-caption text-accent-red">
            {audioRiskError}
          </p>
        ) : null}
        <div className="mt-2 grid max-h-96 gap-2 overflow-y-auto pr-1">
          {records.map(({ record }) => (
            <AdjudicationRow
              key={record.id}
              record={record}
              project={project}
              reviewerId={reviewerId}
              sessionId={sessionId}
              onSubmit={submitVote}
              shadowRisk={modelShadowScores?.get(record.id)?.risk ?? null}
              audioShadowRisk={audioShadowOverlay?.risks.get(record.id) ?? null}
              audioShadowReasons={audioShadowOverlay?.reasons.get(record.id) ?? []}
              priority={activeReviewPriorities.get(record.id) ?? null}
            />
          ))}
        </div>
        <p className="mt-2 leading-5 text-content-muted">
          请不要由同一个人更换代号来凑票；那仍是单人判断，应继续视为弱标签。工作台不显示此前人工结论，减少相互暗示。
        </p>
      </div>
    </>
  );
}

function AdjudicationRow({
  record,
  project,
  reviewerId,
  sessionId,
  onSubmit,
  shadowRisk,
  audioShadowRisk,
  audioShadowReasons,
  priority
}: {
  record: AlignmentReviewRecord;
  project: EditorProject;
  reviewerId: string;
  sessionId: string;
  onSubmit: ReturnType<typeof useEditorStore.getState>["submitAlignmentReviewVote"];
  shadowRisk: number | null;
  audioShadowRisk: number | null;
  audioShadowReasons: string[];
  priority: AlignmentActiveReviewPriority | null;
}) {
  const status = assessAlignmentAdjudication(project, record.id);
  const [decision, setDecision] = useState<AlignmentReviewDecision>("unresolved");
  const [toleranceSeconds, setToleranceSeconds] = useState("2");
  const [reviewStartedAt, setReviewStartedAt] = useState<string | null>(null);
  const role = status.state === "conflict" ? "adjudicator" : "independent";
  const markReviewStarted = () => {
    setReviewStartedAt((current) => current ?? new Date().toISOString());
  };
  const submit = () => {
    const seconds = Number(toleranceSeconds);
    const saved = onSubmit({
      reviewRecordId: record.id,
      reviewerId,
      reviewSessionId: sessionId,
      role,
      decision,
      boundaryToleranceMs:
        Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : null,
      reviewStartedAt
    });
    if (saved) setReviewStartedAt(null);
  };
  return (
    <div className="rounded border border-panel-line/80 bg-panel-base/70 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content-secondary">片段 {record.spanIndex + 1}</span>
        <span className="text-content-muted">
          参考 {formatTimecode(record.sourceStartMs)}–{formatTimecode(record.sourceEndMs)} ·
          原片 {formatTimecode(record.targetStartMs)}–{formatTimecode(record.targetEndMs)}
        </span>
        <span className={`ml-auto ${statusTone(status.state)}`}>
          {statusLabel(status.state, status.distinctIndependentReviewerCount)}
        </span>
        {shadowRisk !== null ? (
          <span className="rounded bg-accent-yellow/10 px-1.5 py-0.5 text-ui-caption text-accent-yellow">
            影子风险 {(shadowRisk * 100).toFixed(1)}%
          </span>
        ) : null}
        {audioShadowRisk !== null ? (
          <span
            className="rounded bg-accent-cyan/10 px-1.5 py-0.5 text-ui-caption text-accent-cyan"
            title={audioShadowReasons.map(audioRiskReasonLabel).join("；")}
          >
            音频风险 {(audioShadowRisk * 100).toFixed(1)}%
          </span>
        ) : null}
        {priority && priority.level !== "gold" ? (
          <span
            className={`rounded px-1.5 py-0.5 text-ui-caption ${priorityTone(priority.level)}`}
          >
            {priorityLabel(priority.level)} · {priority.score.toFixed(1)}
          </span>
        ) : null}
      </div>
      {priority && priority.level !== "gold" && priority.reasons.length > 0 ? (
        <p className="mt-1.5 text-ui-caption leading-4 text-content-muted">
          建议优先核对：{priority.reasons.join("；")}。
        </p>
      ) : null}
      {status.state !== "gold" ? (
        <div
          className="mt-2 flex flex-wrap items-end gap-2"
          onFocusCapture={markReviewStarted}
          onPointerDownCapture={markReviewStarted}
        >
          <label className="grid gap-1 text-ui-caption text-content-muted">
            本次独立判断
            <select
              value={decision}
              onChange={(event) => setDecision(event.target.value as AlignmentReviewDecision)}
              className="h-8 rounded border border-panel-line bg-panel-soft px-2 text-xs text-content-secondary"
            >
              {DECISIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-ui-caption text-content-muted">
            估计边界误差（秒）
            <input
              type="number"
              min="0"
              step="0.1"
              value={toleranceSeconds}
              onChange={(event) => setToleranceSeconds(event.target.value)}
              className="h-8 w-28 rounded border border-panel-line bg-panel-soft px-2 text-xs text-content-secondary"
            />
          </label>
          <TextButton
            tone={status.state === "conflict" ? "primary" : "neutral"}
            disabled={reviewerId.trim().length < 3}
            onClick={submit}
          >
            {status.state === "conflict" ? "提交第三人仲裁" : "提交独立复核"}
          </TextButton>
        </div>
      ) : (
        <p className="mt-2 text-ui-caption text-accent-green">
          已按{status.resolution === "adjudicator" ? "第三人仲裁" : "两人一致"}形成
          Gold；这不会直接修改当前 TimeMap。
        </p>
      )}
    </div>
  );
}

function createReviewSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `review-session:${crypto.randomUUID()}`;
  }
  return `review-session:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function stateOrder(state: ReturnType<typeof assessAlignmentAdjudication>["state"]): number {
  if (state === "conflict") return 0;
  if (state === "awaiting-independent") return 1;
  return 2;
}

function statusLabel(
  state: ReturnType<typeof assessAlignmentAdjudication>["state"],
  reviewers: number
): string {
  if (state === "gold") return "Gold";
  if (state === "conflict") return "结论冲突";
  return `已有 ${reviewers}/2 名独立复核者`;
}

function statusTone(state: ReturnType<typeof assessAlignmentAdjudication>["state"]): string {
  if (state === "gold") return "text-accent-green";
  if (state === "conflict") return "text-accent-red";
  return "text-accent-yellow";
}

function priorityLabel(level: AlignmentActiveReviewPriority["level"]): string {
  if (level === "critical") return "最高优先";
  if (level === "high") return "优先核对";
  return "普通";
}

function priorityTone(level: AlignmentActiveReviewPriority["level"]): string {
  if (level === "critical") return "bg-accent-red/10 text-accent-red";
  if (level === "high") return "bg-accent-yellow/10 text-accent-yellow";
  return "bg-surface-soft/50 text-content-muted";
}

function audioRiskReasonLabel(reason: string): string {
  if (reason === "weak-local-audio-support") return "规则位置附近的音频支持较弱";
  if (reason === "global-audio-disagreement") return "音频最相似位置与规则位置相距较远";
  if (reason === "missing-local-audio-support") return "规则位置附近没有找到音频候选";
  return "离线音频风险较高";
}
