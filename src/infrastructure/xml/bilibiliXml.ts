import type { DanmakuAsset, DanmakuItem, ImportWarning } from "../../domain/danmaku/types";
import { createId } from "../../domain/project/factory";
import { pickAssetColorByName } from "../../domain/shared/assetColors";
import type { Milliseconds } from "../../domain/shared/time";
import {
  clampMilliseconds,
  formatXmlSeconds,
  parseXmlSecondsToMilliseconds
} from "../../domain/shared/time";

import { readXmlMediaMetadata, serializeXmlMediaMetadata } from "./xmlMediaMetadata";
import type { XmlMediaMetadata } from "../../domain/danmaku/xmlMediaMetadata";

export interface ParseXmlOptions {
  assetId?: string;
  assetName?: string;
  fileName: string;
  color?: string;
  importedAt?: string;
}

export interface XmlExportEntry {
  item: DanmakuItem;
  finalTimeMs: Milliseconds;
}

export interface XmlExportResult {
  xml: string;
  negativeClampCount: number;
}

export function parseBilibiliXml(xml: string, options: ParseXmlOptions): DanmakuAsset {
  const assetId = options.assetId ?? createId("asset");
  const warnings: ImportWarning[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  const parserErrors = Array.from(doc.getElementsByTagName("parsererror"));
  if (parserErrors.length > 0) {
    warnings.push({
      id: createId("warning"),
      assetId,
      originalIndex: null,
      severity: "error",
      message: "XML 存在解析错误，已尝试读取可识别的弹幕节点。",
      rawSnippet: parserErrors[0].textContent?.slice(0, 240) ?? ""
    });
  }

  let xmlMetadata: XmlMediaMetadata | undefined;
  try {
    xmlMetadata = readXmlMediaMetadata(doc);
  } catch (error) {
    warnings.push({
      id: createId("warning"),
      assetId,
      originalIndex: null,
      severity: "warning",
      message: `已忽略无效媒体元数据：${String(error)}`,
      rawSnippet: ""
    });
  }
  const nodes = Array.from(doc.getElementsByTagName("d"));
  const items: DanmakuItem[] = [];
  nodes.forEach((node, originalIndex) => {
    const p = node.getAttribute("p");
    const rawSnippet = node.outerHTML.slice(0, 240);
    if (p === null) {
      warnings.push(
        createNodeWarning(
          assetId,
          originalIndex,
          "缺少 p 字段，已使用 0ms 和空元数据。",
          rawSnippet
        )
      );
    }
    const rawPFields = p ? p.split(",") : [];
    if (rawPFields.length < 8) {
      warnings.push(
        createNodeWarning(
          assetId,
          originalIndex,
          `p 字段数量不足：期望至少 8 项，实际 ${rawPFields.length} 项。`,
          rawSnippet
        )
      );
    }
    const timeMs = parseTimeField(rawPFields[0]);
    if (timeMs === null) {
      warnings.push(
        createNodeWarning(assetId, originalIndex, "时间字段非法，已使用 0ms。", rawSnippet)
      );
    }
    const text = node.textContent ?? "";
    if (text.length === 0) {
      warnings.push(createNodeWarning(assetId, originalIndex, "弹幕文本为空。", rawSnippet));
    }
    items.push({
      id: `${assetId}_item_${originalIndex}`,
      assetId,
      originalIndex,
      sourceTimeMs: timeMs ?? 0,
      mode: parseNullableInteger(rawPFields[1]),
      fontSize: parseNullableInteger(rawPFields[2]),
      color: parseNullableInteger(rawPFields[3]),
      timestamp: parseNullableInteger(rawPFields[4]),
      pool: parseNullableInteger(rawPFields[5]),
      userHash: rawPFields[6] ?? null,
      rowId: rawPFields[7] ?? null,
      text,
      rawPFields,
      enabled: true
    });
  });

  return {
    id: assetId,
    name: options.assetName ?? stripExtension(options.fileName),
    fileName: options.fileName,
    color: options.color ?? pickAssetColorByName(options.fileName),
    items,
    warnings,
    importedAt: options.importedAt ?? new Date().toISOString(),
    // DOMParser/File imports are useful for browser preview, but do not have a
    // native receipt bound to the original bytes. Never synthesize one here.
    ...(xmlMetadata ? { xmlMetadata } : {}),
    sourceReceipt: null
  };
}

export function serializeBilibiliXml(
  entries: XmlExportEntry[],
  metadata?: XmlMediaMetadata
): XmlExportResult {
  let negativeClampCount = 0;
  const sorted = [...entries].sort(
    (a, b) => a.finalTimeMs - b.finalTimeMs || a.item.originalIndex - b.item.originalIndex
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<i>",
    "  <generator>Danmaku Timeline Studio</generator>",
    ...serializeXmlMediaMetadata(metadata)
  ];
  for (const entry of sorted) {
    const clampedTime = clampMilliseconds(entry.finalTimeMs);
    if (entry.finalTimeMs < 0) {
      negativeClampCount += 1;
    }
    const fields = buildExportPFields(entry.item, clampedTime);
    lines.push(
      `  <d p="${escapeXmlAttribute(fields.join(","))}">${escapeXmlText(entry.item.text)}</d>`
    );
  }
  lines.push("</i>", "");
  return {
    xml: lines.join("\n"),
    negativeClampCount
  };
}

export function validateExportedXml(xml: string): {
  ok: boolean;
  message: string;
  count: number;
} {
  try {
    const asset = parseBilibiliXml(xml, { fileName: "export.xml", assetName: "导出验证" });
    const hardErrors = asset.warnings.filter((warning) => warning.severity === "error");
    if (hardErrors.length > 0) {
      return { ok: false, message: hardErrors[0].message, count: asset.items.length };
    }
    return { ok: true, message: "导出 XML 可重新导入。", count: asset.items.length };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "未知导出验证错误。",
      count: 0
    };
  }
}

function buildExportPFields(item: DanmakuItem, timeMs: Milliseconds): string[] {
  const fallback = [
    formatXmlSeconds(timeMs),
    String(item.mode ?? 1),
    String(item.fontSize ?? 25),
    String(item.color ?? 16_777_215),
    String(item.timestamp ?? 0),
    String(item.pool ?? 0),
    item.userHash ?? "",
    item.rowId ?? ""
  ];
  const fields = item.rawPFields.length > 0 ? [...item.rawPFields] : fallback;
  fields[0] = formatXmlSeconds(timeMs);
  while (fields.length < fallback.length) {
    fields.push(fallback[fields.length]);
  }
  return fields;
}

function parseTimeField(value: string | undefined): Milliseconds | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return parseXmlSecondsToMilliseconds(value);
}

function parseNullableInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function createNodeWarning(
  assetId: string,
  originalIndex: number,
  message: string,
  rawSnippet: string
): ImportWarning {
  return {
    id: createId("warning"),
    assetId,
    originalIndex,
    severity: "warning",
    message,
    rawSnippet
  };
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
