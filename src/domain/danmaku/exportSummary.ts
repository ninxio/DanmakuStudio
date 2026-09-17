import type { ResolvedDanmakuEvent } from "./types";
import type { CutMarker } from "./types";
import type { Milliseconds } from "../shared/time";
import { formatTimecode } from "../shared/time";

export interface ExportCompensationDetail {
  id: string;
  name: string;
  sourceAtMs: Milliseconds;
  targetGapMs: Milliseconds;
  note: string;
}

export interface ExportNegativeClampDetail {
  id: string;
  assetFileName: string;
  clipName: string;
  originalIndex: number;
  finalTimeMs: Milliseconds;
  text: string;
}

export interface ExportSummary {
  originalCount: number;
  enabledCount: number;
  disabledCount: number;
  earliestFinalTimeMs: Milliseconds;
  latestFinalTimeMs: Milliseconds;
  cutMarkerCount: number;
  totalCutGapMs: Milliseconds;
  compensationDetails: ExportCompensationDetail[];
  hasImportWarnings: boolean;
  negativeClampCount: number;
  negativeClampDetails: ExportNegativeClampDetail[];
}

export function createExportSummary(
  allEvents: ResolvedDanmakuEvent[],
  cutMarkers: CutMarker[],
  hasImportWarnings: boolean
): ExportSummary {
  const enabled = allEvents.filter((event) => event.enabled);
  const times = enabled.map((event) => Math.max(0, event.finalTimeMs));
  const negativeClampDetails = enabled
    .filter((event) => event.finalTimeMs < 0)
    .sort((left, right) => left.finalTimeMs - right.finalTimeMs || left.originalIndex - right.originalIndex)
    .map((event) => ({
      id: event.id,
      assetFileName: event.asset.fileName,
      clipName: event.clip.name,
      originalIndex: event.item.originalIndex,
      finalTimeMs: event.finalTimeMs,
      text: event.item.text
    }));
  return {
    originalCount: allEvents.length,
    enabledCount: enabled.length,
    disabledCount: allEvents.length - enabled.length,
    earliestFinalTimeMs: times.length > 0 ? Math.min(...times) : 0,
    latestFinalTimeMs: times.length > 0 ? Math.max(...times) : 0,
    cutMarkerCount: cutMarkers.length,
    totalCutGapMs: cutMarkers.reduce((total, marker) => total + marker.targetGapMs, 0),
    compensationDetails: [...cutMarkers]
      .sort((left, right) => left.sourceAtMs - right.sourceAtMs || left.name.localeCompare(right.name))
      .map((marker) => ({
        id: marker.id,
        name: marker.name,
        sourceAtMs: marker.sourceAtMs,
        targetGapMs: marker.targetGapMs,
        note: marker.note
      })),
    hasImportWarnings,
    negativeClampCount: negativeClampDetails.length,
    negativeClampDetails
  };
}

export function createCompensationReport(projectName: string, summary: ExportSummary, generatedAt = new Date()): string {
  const lines = [
    "导出复核报告",
    `项目：${projectName || "未命名项目"}`,
    `生成时间：${generatedAt.toISOString()}`,
    `原始弹幕：${summary.originalCount.toLocaleString("zh-CN")} 条`,
    `启用弹幕：${summary.enabledCount.toLocaleString("zh-CN")} 条`,
    `禁用弹幕：${summary.disabledCount.toLocaleString("zh-CN")} 条`,
    `最早最终时间：${formatTimecode(summary.earliestFinalTimeMs)}`,
    `最晚最终时间：${formatTimecode(summary.latestFinalTimeMs)}`,
    `版本差异：${summary.cutMarkerCount.toLocaleString("zh-CN")} 个`,
    `累计调整：${formatSignedCompensationDuration(summary.totalCutGapMs)}`,
    `导入警告：${summary.hasImportWarnings ? "有" : "无"}`,
    `负时间限制：${summary.negativeClampCount.toLocaleString("zh-CN")} 项`,
    ""
  ];

  if (summary.compensationDetails.length === 0) {
    lines.push("本次导出未应用版本差异。");
  } else {
    lines.push("版本差异明细：");
    summary.compensationDetails.forEach((detail, index) => {
      lines.push(
        `${index + 1}. ${detail.name}`,
        `   ID：${detail.id}`,
        `   发生位置：${formatTimecode(detail.sourceAtMs)} (${detail.sourceAtMs} ms)`,
        `   相差时长：${formatSignedCompensationDuration(detail.targetGapMs)} (${detail.targetGapMs} ms)`,
        `   影响：此时间点之后的弹幕最终时间会整体平移。`,
        `   备注：${detail.note.trim().length > 0 ? detail.note : "无"}`
      );
    });
  }

  if (summary.negativeClampDetails.length > 0) {
    lines.push("", "负时间限制明细：");
    summary.negativeClampDetails.forEach((detail, index) => {
      lines.push(
        `${index + 1}. ${detail.assetFileName} / ${detail.clipName}`,
        `   事件 ID：${detail.id}`,
        `   XML 序号：${detail.originalIndex + 1}`,
        `   原最终时间：${formatSignedCompensationDuration(detail.finalTimeMs)} (${detail.finalTimeMs} ms)`,
        `   导出时间：00:00:00.000`,
        `   文本：${detail.text.trim().length > 0 ? detail.text : "空文本"}`
      );
    });
  }

  return `${lines.join("\n")}\n`;
}

export function formatSignedCompensationDuration(milliseconds: Milliseconds): string {
  const sign = milliseconds < 0 ? "-" : "+";
  return `${sign}${formatTimecode(Math.abs(milliseconds))}`;
}
