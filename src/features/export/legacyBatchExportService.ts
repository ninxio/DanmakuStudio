import { collectExportMetadata } from "../../infrastructure/xml/xmlMediaMetadata";
import type { buildBatchMergePlan } from "../../domain/danmaku/batchMerge";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import type { EditorProject } from "../../domain/project/types";
import { requiresProjectionOnlyExport } from "../../domain/timeline/sourceProjection";
import {
  downloadLegacyXmlFiles,
  formatExportFileError
} from "../../infrastructure/file-system/exportFiles";
import {
  serializeBilibiliXml,
  validateExportedXml
} from "../../infrastructure/xml/bilibiliXml";
import { setStatus } from "../assets/assetPanelSharedLogic";
import { createBatchExportStatus } from "./exportProjectionService";

export async function exportBatchMergePlan(
  plan: ReturnType<typeof buildBatchMergePlan>,
  project: EditorProject
) {
  if (requiresProjectionOnlyExport(project)) {
    setStatus({
      message: "导出已阻断：当前项目必须通过已确认时间图按原片分集导出。",
      tone: "error"
    });
    return;
  }
  const files = plan.episodes.map((episode) => {
    const result = serializeBilibiliXml(
      episode.entries,
      collectExportMetadata(
        project.assets,
        project.assets
          .filter((a) => episode.sourceFileNames.includes(a.fileName))
          .map((a) => a.id)
      )
    );
    const validation = validateExportedXml(result.xml);
    return {
      fileName: episode.fileName,
      content: result.xml,
      valid: validation.ok,
      message: validation.message
    };
  });
  const invalid = files.find((file) => !file.valid);
  if (invalid) {
    setStatus({ message: `分集 XML 验证失败：${invalid.message}`, tone: "error" });
    return;
  }
  try {
    const exportResult = await downloadLegacyXmlFiles(
      files.map((file) => ({ fileName: file.fileName, content: file.content })),
      {
        type: "application/xml;charset=utf-8",
        archiveFileName: createProjectDownloadFileName(project.name, "-danmaku-exports.zip")
      }
    );
    setStatus(createBatchExportStatus(exportResult));
  } catch (error) {
    setStatus({ message: `分集 XML 导出失败：${formatExportFileError(error)}`, tone: "error" });
  }
}
