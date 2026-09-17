import { collectExportMetadata } from "../infrastructure/xml/xmlMediaMetadata";
import { getXmlExportDuration } from "../domain/timeline/xmlExportDuration";
import { createExportSummary } from "../domain/danmaku/exportSummary";
import {
  createProjectHealthSummary,
  summarizeProjectHealthBlockers
} from "../domain/project/health";
import type { EditorProject } from "../domain/project/types";
import { requiresProjectionOnlyExport } from "../domain/timeline/sourceProjection";
import { resolveProjectDanmakuEvents } from "../domain/timeline/mapping";
import { serializeBilibiliXml, validateExportedXml } from "../infrastructure/xml/bilibiliXml";
import type { ExportSummary } from "../domain/danmaku/exportSummary";
import type { EditorStatus } from "./commandStatus";

export interface ExportDraft {
  summary: ExportSummary;
  xml: string;
  validation: {
    ok: boolean;
    message: string;
    count: number;
  };
}

export interface PrepareExportResult {
  exportDraft: ExportDraft | null;
  status: EditorStatus;
}

/** Pure prepare-export body used by the export slice. */
export function prepareExportDraft(project: EditorProject): PrepareExportResult {
  if (requiresProjectionOnlyExport(project)) {
    return {
      exportDraft: null,
      status: {
        message: "导出已阻断：当前项目必须在导出页通过已确认时间图按原片分集导出。",
        tone: "warning"
      }
    };
  }
  const health = createProjectHealthSummary(project);
  const blockingFinding = health.findings.find((finding) => finding.severity === "error");
  if (blockingFinding) {
    const blockingDetail = summarizeProjectHealthBlockers(health) ?? blockingFinding.title;
    return {
      exportDraft: null,
      status: {
        message: `导出前检查未通过：${blockingDetail}。请在导出检查中处理后再导出。`,
        tone: "warning"
      }
    };
  }
  const events = resolveProjectDanmakuEvents(project);
  const enabledEvents = events.filter((event) => event.enabled);
  if (enabledEvents.length === 0) {
    return {
      exportDraft: null,
      status: {
        message: "当前没有可导出的弹幕，请先把 XML 放入时间轴。",
        tone: "warning"
      }
    };
  }
  const exportResult = serializeBilibiliXml(
    enabledEvents.map((event) => ({ item: event.item, finalTimeMs: event.finalTimeMs })),
    collectExportMetadata(
      project.assets,
      project.clips.filter((c) => c.enabled).map((c) => c.assetId),
      getXmlExportDuration(project)
    )
  );
  const validation = validateExportedXml(exportResult.xml);
  const summary = createExportSummary(
    events,
    project.cutMarkers,
    project.assets.some((asset) => asset.warnings.length > 0)
  );
  return {
    exportDraft: {
      summary,
      xml: exportResult.xml,
      validation
    },
    status: {
      message: validation.ok ? "导出摘要已生成。" : `导出验证失败：${validation.message}`,
      tone: validation.ok ? "success" : "error"
    }
  };
}
