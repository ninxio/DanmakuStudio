import { ToolSheet } from "../../components/ToolSheet";
import { recordPublicationDelivery } from "../../application/publicationDelivery";
import { prepareExportDraft } from "../../application/exportProjectCommands";
import { Download, FolderOpen, X } from "lucide-react";
import { useMemo, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { Dialog } from "../../components/Dialog";
import { Badge } from "../../components/Badge";
import {
  createCompensationReport,
  formatSignedCompensationDuration,
  type ExportCompensationDetail,
  type ExportNegativeClampDetail
} from "../../domain/danmaku/exportSummary";
import {
  createProjectHealthReport,
  createProjectHealthSummary
} from "../../domain/project/health";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import {
  createProjectReadinessSummary,
  type ProjectReadinessItem,
  type ProjectReadinessStatus,
  type ProjectReadinessSummary
} from "../../domain/project/readiness";
import { formatTimecode } from "../../domain/shared/time";
import { getStatusVocabulary, statusLabel } from "../../domain/shared/statusVocabulary";
import { requiresProjectionOnlyExport } from "../../domain/timeline/sourceProjection";
import {
  downloadLegacyXmlFile,
  formatExportFileError,
  saveTextReportFile,
  type SaveTextExportResult
} from "../../infrastructure/file-system/exportFiles";
import { pickExportDirectoryPath } from "../../infrastructure/file-system/nativeDialogs";
import { useExportDirectory } from "./useExportDirectory";
import { useEditorStore, type EditorStatus } from "../../stores/editorStore";

const HEALTH_PREFLIGHT_EVIDENCE_LIMIT = 2;

/** One delivery controller for page export and compatibility dialogs. */
export function ExportSummary({ inline = false }: { inline?: boolean }) {
  const project = useEditorStore((state) => state.project);
  const storedDraft = useEditorStore((state) => state.exportDraft);
  const prepared = useMemo(
    () => (inline ? prepareExportDraft(project) : null),
    [inline, project]
  );
  const exportDraft = inline ? prepared?.exportDraft : storedDraft;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const clearExport = useEditorStore((state) => state.clearExport);
  const { directory: exportDirectory, setDirectory: setExportDirectory } = useExportDirectory();
  if (!exportDraft) {
    return inline ? (
      <p role="status" className="rounded-panel bg-surface-inset p-4 text-content-muted">
        {prepared?.status.message}
      </p>
    ) : null;
  }
  const { summary, validation } = exportDraft;
  const xmlFileName = createProjectDownloadFileName(project.name, ".xml", "danmaku-export");
  const healthReportFileName = createProjectDownloadFileName(
    project.name,
    "-health-report.txt",
    "danmaku-export"
  );
  const exportReportFileName = createProjectDownloadFileName(
    project.name,
    "-export-report.txt",
    "danmaku-export"
  );
  const healthSummary = createProjectHealthSummary(project);
  const readinessSummary = createProjectReadinessSummary(project);
  const previewCompensations = summary.compensationDetails.slice(0, 3);
  const hiddenCompensationCount = Math.max(
    0,
    summary.compensationDetails.length - previewCompensations.length
  );
  const previewNegativeClamps = summary.negativeClampDetails.slice(0, 3);
  const hiddenNegativeClampCount = Math.max(
    0,
    summary.negativeClampDetails.length - previewNegativeClamps.length
  );
  const hasExportReviewReport =
    summary.compensationDetails.length > 0 || summary.negativeClampDetails.length > 0;
  const projectionOnlyExport = requiresProjectionOnlyExport(project);

  const chooseExportDirectory = async () => {
    try {
      const path = await pickExportDirectoryPath(exportDirectory);
      if (!path) {
        return;
      }
      setExportDirectory(path);
      setExportStatus({ message: `本次导出目录已设为：${path}`, tone: "success" });
    } catch (error) {
      setExportStatus({
        message: `选择导出目录失败：${formatExportFileError(error)}`,
        tone: "warning"
      });
    }
  };

  const downloadHealthReport = async () => {
    try {
      const result = await saveTextReportFile(
        {
          fileName: healthReportFileName,
          content: createProjectHealthReport(project.name, healthSummary)
        },
        { directoryPath: exportDirectory, type: "text/plain;charset=utf-8" }
      );
      setExportStatus(createExportSuccessStatus("检查报告", result));
    } catch (error) {
      setExportStatus({
        message: `导出检查报告失败：${formatExportFileError(error)}`,
        tone: "error"
      });
    }
  };

  const downloadExportReviewReport = async () => {
    try {
      const result = await saveTextReportFile(
        {
          fileName: exportReportFileName,
          content: createCompensationReport(project.name, summary)
        },
        { directoryPath: exportDirectory, type: "text/plain;charset=utf-8" }
      );
      setExportStatus(createExportSuccessStatus("复核报告", result));
    } catch (error) {
      setExportStatus({
        message: `导出复核报告失败：${formatExportFileError(error)}`,
        tone: "error"
      });
    }
  };

  const downloadXml = async () => {
    if (exporting) return;
    const currentProject = useEditorStore.getState().project;
    const latest = prepareExportDraft(currentProject);
    if (!latest.exportDraft?.validation.ok) {
      setExportStatus(latest.status);
      setResultMessage(latest.status.message);
      return;
    }
    if (requiresProjectionOnlyExport(currentProject)) {
      setExportStatus({
        message: "导出已阻断：当前项目必须通过已确认时间图按原片分集导出。",
        tone: "error"
      });
      return;
    }
    setExporting(true);
    setResultMessage(null);
    try {
      const result = await downloadLegacyXmlFile(
        {
          fileName: createProjectDownloadFileName(
            currentProject.name,
            ".xml",
            "danmaku-export"
          ),
          content: latest.exportDraft.xml
        },
        { type: "application/xml;charset=utf-8", directoryPath: exportDirectory }
      );
      setExportStatus(createExportSuccessStatus("XML", result));
      recordPublicationDelivery(currentProject, "xml", [
        {
          fileName: result.fileName ?? xmlFileName,
          content: latest.exportDraft.xml
        }
      ]);
      setResultMessage(
        `上次已导出 ${latest.exportDraft.validation.count} 条弹幕：${result.fileName}`
      );
      if (!inline) clearExport();
    } catch (error) {
      const message = `导出 XML 失败：${formatExportFileError(error)}`;
      setExportStatus({ message, tone: "error" });
      setResultMessage(message);
    } finally {
      setExporting(false);
    }
  };

  const saveAction = (
    <TextButton
      tone="primary"
      disabled={exporting || !validation.ok || projectionOnlyExport}
      onClick={() => void downloadXml()}
    >
      <Download size={14} />
      {exporting ? "正在导出…" : "导出 XML"}
    </TextButton>
  );

  const content = (
    <>
      <header className="flex h-12 items-center justify-between border-b border-panel-line px-4">
        <h2 id="export-dialog-title" className="text-sm font-semibold">
          导出 XML 摘要
        </h2>
        {inline && saveAction}
        {!inline && (
          <IconButton label="关闭导出摘要" icon={<X size={16} />} onClick={clearExport} />
        )}
      </header>
      <div
        className={`thin-scrollbar grid gap-3 overflow-auto p-4 text-sm ${inline ? "md:grid-cols-2" : ""}`}
      >
        <SummaryRow
          label="原始弹幕数量"
          value={summary.originalCount.toLocaleString("zh-CN")}
        />
        <SummaryRow label="启用弹幕数量" value={summary.enabledCount.toLocaleString("zh-CN")} />
        <SummaryRow
          label="禁用弹幕数量"
          value={summary.disabledCount.toLocaleString("zh-CN")}
        />
        <SummaryRow label="最早最终时间" value={formatTimecode(summary.earliestFinalTimeMs)} />
        <SummaryRow label="最晚最终时间" value={formatTimecode(summary.latestFinalTimeMs)} />
        <SummaryRow label="版本差异" value={summary.cutMarkerCount.toString()} />
        <SummaryRow
          label="累计调整时长"
          value={formatSignedCompensationDuration(summary.totalCutGapMs)}
        />
        <SummaryRow label="存在导入警告" value={summary.hasImportWarnings ? "是" : "否"} />
        <SummaryRow label="负时间限制为 0" value={`${summary.negativeClampCount} 项`} />
        <SummaryRow label="导出文件名" value={xmlFileName} />
        <SummaryRow
          label="文本报告目录"
          value={exportDirectory.trim().length > 0 ? exportDirectory : "浏览器下载"}
        />
        <SummaryRow label="XML 保存方式" value="保存到下载文件夹" />
        {exportDirectory.trim().length === 0 ? (
          <div className="rounded border border-feedback-warning/40 bg-feedback-warning/10 px-3 py-2 text-xs leading-5 text-feedback-warning">
            未设置默认导出目录，检查报告和复核报告会使用浏览器下载。你也可以先选择本次报告目录。
          </div>
        ) : null}
        {projectionOnlyExport ? (
          <div className="rounded border border-accent-red/40 bg-accent-red/10 px-3 py-2 text-xs leading-5 text-accent-red">
            项目已进入原片时间映射流程；此单文件草稿不消费时间图，已禁止导出。请关闭后使用导出页上方的「按原片分集导出」。
          </div>
        ) : null}
        {!inline && <ProjectReadinessPreflight summary={readinessSummary} />}
        {previewCompensations.length > 0 ? (
          <section className="rounded border border-panel-line bg-surface-inset p-3 text-xs text-content-secondary">
            <h3 className="font-medium text-content-primary">版本差异明细</h3>
            <div className="mt-2 grid gap-2">
              {previewCompensations.map((detail) => (
                <CompensationDetailRow key={detail.id} detail={detail} />
              ))}
              {hiddenCompensationCount > 0 ? (
                <p className="text-content-muted">
                  另有 {hiddenCompensationCount} 个版本差异，可下载报告查看完整明细。
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
        {previewNegativeClamps.length > 0 ? (
          <section className="rounded border border-feedback-warning/40 bg-feedback-warning/10 p-3 text-xs text-feedback-warning">
            <h3 className="font-medium">负时间限制明细</h3>
            <div className="mt-2 grid gap-2">
              {previewNegativeClamps.map((detail) => (
                <NegativeClampDetailRow key={detail.id} detail={detail} />
              ))}
              {hiddenNegativeClampCount > 0 ? (
                <p className="text-feedback-warning/70">
                  另有 {hiddenNegativeClampCount} 条，可下载导出报告查看完整明细。
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
        <div
          className={`rounded border px-3 py-2 text-xs ${
            validation.ok
              ? "border-accent-green/40 bg-accent-green/10 text-accent-green"
              : "border-accent-red/40 bg-accent-red/10 text-accent-red"
          }`}
        >
          {validation.message} 验证条数：{validation.count}
        </div>
      </div>
      {resultMessage ? (
        <p
          role="status"
          className="mx-4 mb-3 rounded-panel bg-primary-container p-3 text-sm text-on-primary-container"
        >
          {resultMessage}
        </p>
      ) : null}
      <footer className="flex flex-wrap justify-end gap-2 border-t border-panel-line p-4">
        <TextButton onClick={() => void chooseExportDirectory()}>
          <FolderOpen size={14} />
          选择目录
        </TextButton>
        {exportDirectory.trim().length > 0 ? (
          <TextButton onClick={() => setExportDirectory("")}>改用下载</TextButton>
        ) : null}
        <TextButton onClick={() => void downloadHealthReport()}>
          <Download size={14} />
          下载检查报告
        </TextButton>
        {hasExportReviewReport ? (
          <TextButton onClick={() => void downloadExportReviewReport()}>
            <Download size={14} />
            下载导出报告
          </TextButton>
        ) : null}
        {!inline && <TextButton onClick={clearExport}>取消</TextButton>}
        {!inline && saveAction}
      </footer>
    </>
  );
  return inline ? (
    <section
      data-testid="xml-export-summary"
      aria-label="导出 XML 摘要"
      className="overflow-hidden rounded-panel border border-boundary bg-surface-base"
    >
      <div className="xml-export-file">
        <div className="min-w-0">
          <h3 className="break-words text-lg font-semibold">{xmlFileName}</h3>
          <p className="mt-2 text-sm text-content-muted">
            {validation.count.toLocaleString("zh-CN")} 条弹幕 ·{" "}
            {formatTimecode(summary.earliestFinalTimeMs)} —{" "}
            {formatTimecode(summary.latestFinalTimeMs)}
          </p>
          <p
            className={
              validation.ok
                ? "mt-2 text-xs text-feedback-success"
                : "mt-2 text-xs text-feedback-danger"
            }
          >
            {validation.message}
          </p>
        </div>
        <div className="page-actions">
          <TextButton onClick={() => setDetailsOpen(true)}>统计与报告</TextButton>
          {saveAction}
        </div>
      </div>
      {resultMessage ? (
        <p role="status" className="px-5 pb-4 text-sm text-feedback-success">
          {resultMessage}
        </p>
      ) : null}
      <ToolSheet
        title="弹幕统计与报告"
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        wide
      >
        {content}
      </ToolSheet>
    </section>
  ) : (
    <Dialog
      ariaLabelledBy="export-dialog-title"
      onClose={clearExport}
      className="flex max-h-[86vh] w-[600px] flex-col"
      data-testid="export-dialog"
    >
      {content}
    </Dialog>
  );
}

function NegativeClampDetailRow({ detail }: { detail: ExportNegativeClampDetail }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-feedback-warning/20 pt-2 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="truncate font-medium" title={detail.text}>
          {detail.text.trim().length > 0 ? detail.text : "空文本"}
        </div>
        <div
          className="mt-1 truncate text-ui-caption text-feedback-warning/70"
          title={`${detail.assetFileName} / ${detail.clipName}`}
        >
          {detail.assetFileName} / {detail.clipName}
        </div>
      </div>
      <span className="font-mono text-ui-caption text-feedback-warning/80">
        {`${formatSignedCompensationDuration(detail.finalTimeMs)} -> 00:00:00.000`}
      </span>
    </div>
  );
}

function ProjectReadinessPreflight({ summary }: { summary: ProjectReadinessSummary }) {
  const previewItems = summary.items.slice(0, 3);
  const hiddenItemCount = Math.max(0, summary.items.length - previewItems.length);
  return (
    <section
      className={`rounded border p-3 text-xs ${projectHealthPanelClass(summary.status)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">导出前检查</h3>
          <p className="mt-1 leading-5 opacity-80">{summary.headline}</p>
          <p className="mt-1 leading-5 opacity-70">{summary.detail}</p>
        </div>
        <Badge
          tone={getStatusVocabulary(summary.statusId).tone}
          title={getStatusVocabulary(summary.statusId).description}
          className="shrink-0"
        >
          {summary.statusLabel}
        </Badge>
      </div>
      {previewItems.length > 0 ? (
        <ul className="mt-2 grid gap-2">
          {previewItems.map((item) => (
            <ProjectReadinessItemPreview key={item.id} item={item} />
          ))}
          {hiddenItemCount > 0 ? (
            <li className="opacity-70">另有 {hiddenItemCount} 项，可下载检查报告查看。</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

function ProjectReadinessItemPreview({ item }: { item: ProjectReadinessItem }) {
  const evidencePreview = item.evidence.slice(0, HEALTH_PREFLIGHT_EVIDENCE_LIMIT);
  const hiddenEvidenceCount = Math.max(0, item.evidence.length - evidencePreview.length);
  return (
    <li className="border-t border-current/15 pt-2 first:border-t-0 first:pt-0">
      <div>
        <span className="font-medium">{projectHealthFindingSeverityLabel(item.severity)}</span>
        <span className="mx-1">/</span>
        <span>{item.title}</span>
      </div>
      <p className="mt-1 opacity-80">{item.detail}</p>
      {evidencePreview.length > 0 ? (
        <ul className="mt-1 grid gap-1 opacity-80">
          {evidencePreview.map((item) => (
            <li key={item} className="break-words" title={item}>
              {item}
            </li>
          ))}
        </ul>
      ) : null}
      {hiddenEvidenceCount > 0 ? (
        <p className="mt-1 opacity-70">
          另有 {hiddenEvidenceCount.toLocaleString("zh-CN")} 条证据，可下载检查报告查看。
        </p>
      ) : null}
    </li>
  );
}

function CompensationDetailRow({ detail }: { detail: ExportCompensationDetail }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-panel-line pt-2 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="truncate text-content-primary" title={detail.name}>
          {detail.name}
        </div>
        <div className="mt-1 truncate font-mono text-ui-caption text-content-muted">
          {formatTimecode(detail.sourceAtMs)} /{" "}
          {formatSignedCompensationDuration(detail.targetGapMs)}
        </div>
      </div>
      <span className="text-content-muted">后续整体平移</span>
    </div>
  );
}

function projectHealthPanelClass(status: ProjectReadinessStatus): string {
  if (status === "blocked") {
    return "border-accent-red/40 bg-accent-red/10 text-feedback-danger";
  }
  if (status === "attention") {
    return "border-feedback-warning/40 bg-feedback-warning/10 text-feedback-warning";
  }
  return "border-accent-green/40 bg-accent-green/10 text-accent-green";
}

function projectHealthFindingSeverityLabel(severity: ProjectReadinessItem["severity"]): string {
  if (severity === "error") {
    return statusLabel("blocked");
  }
  if (severity === "warning") {
    return statusLabel("reviewRequired");
  }
  return "信息";
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-3">
      <dt className="text-xs text-content-muted">{label}</dt>
      <dd className="truncate rounded border border-panel-line bg-surface-inset px-2 py-1.5 text-xs text-content-primary">
        {value}
      </dd>
    </div>
  );
}

function createExportSuccessStatus(
  targetLabel: string,
  result: SaveTextExportResult
): EditorStatus {
  const readableTargetLabel = targetLabel === "XML" ? " XML" : targetLabel;
  if (result.mode === "directory") {
    return {
      message: `已导出${readableTargetLabel}到 ${result.filePath}${result.wasRenamed ? "（已有同名文件，已自动改名）。" : "。"}`,
      tone: "success",
      action: {
        type: "openDirectory",
        label: "打开目录",
        directoryPath: result.directoryPath
      }
    };
  }
  return {
    message: `已导出${readableTargetLabel}：${result.downloadedFileName ?? result.fileName ?? "浏览器下载"}。`,
    tone: "success"
  };
}

function setExportStatus(status: EditorStatus) {
  useEditorStore.setState({ status });
}
