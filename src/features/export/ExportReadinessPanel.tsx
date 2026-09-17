import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { TextButton } from "../../components/TextButton";
import { createProjectHealthReport } from "../../domain/project/health";
import type { createProjectHealthSummary } from "../../domain/project/health";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import type { ProjectReadinessSummary } from "../../domain/project/readiness";
import { downloadTextFile } from "../../infrastructure/file-system/browserFiles";
import { setStatus } from "../assets/assetPanelSharedLogic";
import {
  ExportReadinessDiagnostics,
  ExportReadinessSummary
} from "./ExportReadinessPresentation";

export function ExportReadinessPanel({
  projectName,
  reportSummary,
  readiness,
  onCleanupEditReferences,
  onCleanupMissingAssetClips
}: {
  projectName: string;
  reportSummary: ReturnType<typeof createProjectHealthSummary>;
  readiness: ProjectReadinessSummary;
  onCleanupEditReferences: () => void;
  onCleanupMissingAssetClips: () => void;
}) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  return (
    <section
      className="rounded border border-panel-line bg-panel-soft p-3"
      data-testid="project-health-panel"
    >
      <ExportReadinessSummary readiness={readiness} />
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <TextButton
          onClick={() => {
            const fileName = downloadTextFile(
              createProjectDownloadFileName(projectName, "-health-report.txt"),
              createProjectHealthReport(projectName, reportSummary),
              "text/plain;charset=utf-8"
            );
            setStatus({ message: `已导出检查报告：${fileName}。`, tone: "success" });
          }}
        >
          <Download size={14} />
          下载检查报告
        </TextButton>
        {readiness.canCleanupEditReferences ? (
          <TextButton onClick={onCleanupEditReferences}>
            <Trash2 size={14} />
            清理失效调整
          </TextButton>
        ) : null}
        {readiness.canCleanupMissingAssetClips ? (
          <TextButton tone="danger" onClick={onCleanupMissingAssetClips}>
            <Trash2 size={14} />
            移除缺失片段
          </TextButton>
        ) : null}
        <TextButton onClick={() => setDiagnosticsOpen((open) => !open)}>
          {diagnosticsOpen ? "收起诊断详情" : "查看诊断详情"}
        </TextButton>
      </div>
      {diagnosticsOpen ? (
        <ExportReadinessDiagnostics diagnostics={readiness.diagnostics} />
      ) : null}
    </section>
  );
}
