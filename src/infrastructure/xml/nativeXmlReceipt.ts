import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  isDanmakuXmlSourceReceipt,
  type DanmakuXmlSourceReceipt,
  type ImportWarningSeverity
} from "../../domain/danmaku/types";
import type { Milliseconds } from "../../domain/shared/time";

import { parseNativeXmlMetadata } from "./xmlMediaMetadata";
import type { XmlMediaMetadata } from "../../domain/danmaku/xmlMediaMetadata";

export interface NativeXmlParsedItem {
  originalIndex: number;
  sourceTimeMs: Milliseconds;
  mode: number | null;
  fontSize: number | null;
  color: number | null;
  timestamp: number | null;
  pool: number | null;
  userHash: string | null;
  rowId: string | null;
  text: string;
  rawPFields: string[];
}

export interface NativeXmlImportWarning {
  originalIndex: number | null;
  severity: Extract<ImportWarningSeverity, "warning">;
  message: string;
  rawSnippet: string;
}

export interface NativeXmlImportedFile {
  xmlMetadata?: XmlMediaMetadata;
  sourcePath?: string;
  fileName: string;
  receipt: DanmakuXmlSourceReceipt;
  items: NativeXmlParsedItem[];
  warnings: NativeXmlImportWarning[];
}

export interface NativeXmlImportRequest {
  paths: string[];
}

export interface NativeXmlImportResponse {
  files: NativeXmlImportedFile[];
}

export type NativeXmlImportInvoker = (
  request: NativeXmlImportRequest
) => Promise<NativeXmlImportResponse>;

/**
 * Read and parse all selected XML files inside the native process.
 *
 * The default bridge is deliberately unavailable in a browser. Callers may
 * inject an invoker in tests, but production renderer code cannot turn a File
 * or a path string into a trusted receipt by itself.
 */
export async function importNativeXmlPaths(
  paths: readonly string[],
  invoker: NativeXmlImportInvoker = defaultNativeXmlImportInvoker
): Promise<NativeXmlImportedFile[]> {
  const normalizedPaths = normalizeNativeXmlPaths(paths);
  if (paths.length === 0) {
    throw new Error("请至少选择一个 XML 文件。");
  }
  if (normalizedPaths.length !== paths.length) {
    throw new Error("XML 选择中包含空路径、重复路径或非 XML 文件，已拒绝整批导入。");
  }
  if (invoker === defaultNativeXmlImportInvoker && !isTauri()) {
    throw new Error("受验证的 XML 导入需要在 Tauri 桌面端运行。");
  }

  let response: NativeXmlImportResponse;
  try {
    response = await invoker({ paths: normalizedPaths });
  } catch (error) {
    throw new Error(`原生 XML 导入失败：${getErrorMessage(error)}`);
  }
  return validateNativeXmlImportResponse(response, normalizedPaths);
}

export function normalizeNativeXmlPaths(paths: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  paths.forEach((path) => {
    const trimmed = path.trim();
    const key = trimmed.replace(/\//g, "\\").replace(/\\+/g, "\\").toLocaleLowerCase("en-US");
    if (
      trimmed.length === 0 ||
      !trimmed.toLocaleLowerCase("en-US").endsWith(".xml") ||
      seen.has(key)
    ) {
      return;
    }
    seen.add(key);
    normalized.push(trimmed);
  });
  return normalized;
}

function defaultNativeXmlImportInvoker(
  request: NativeXmlImportRequest
): Promise<NativeXmlImportResponse> {
  return invoke<NativeXmlImportResponse>("import_bilibili_xml_files", { request });
}

function validateNativeXmlImportResponse(
  value: unknown,
  requestedPaths: readonly string[]
): NativeXmlImportedFile[] {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("原生 XML 导入返回了无效响应。");
  }
  if (value.files.length !== requestedPaths.length) {
    throw new Error(
      `原生 XML 导入结果数量不一致：选择 ${requestedPaths.length} 个，返回 ${value.files.length} 个。`
    );
  }

  return value.files.map((file, fileIndex) => {
    const expectedFileName = getPathFileName(requestedPaths[fileIndex]);
    if (
      !isRecord(file) ||
      typeof file.fileName !== "string" ||
      file.fileName.trim().length === 0
    ) {
      throw new Error(`第 ${fileIndex + 1} 个原生 XML 结果缺少文件名。`);
    }
    const fileName = file.fileName;
    if (fileName.toLocaleLowerCase("en-US") !== expectedFileName.toLocaleLowerCase("en-US")) {
      throw new Error(
        `第 ${fileIndex + 1} 个原生 XML 结果与所选文件不一致：期望 ${expectedFileName}，实际 ${fileName}。`
      );
    }
    if (!isDanmakuXmlSourceReceipt(file.receipt)) {
      throw new Error(`${fileName} 的原生 XML 收据无效。`);
    }
    const items = file.items;
    if (!Array.isArray(items) || !items.every(isNativeXmlParsedItem)) {
      throw new Error(`${fileName} 的原生弹幕库存无效。`);
    }
    items.forEach((item, itemIndex) => {
      if (item.originalIndex !== itemIndex) {
        throw new Error(`${fileName} 的弹幕序号不连续，无法安全导入。`);
      }
    });
    const warnings = file.warnings;
    if (!Array.isArray(warnings) || !warnings.every(isNativeXmlImportWarning)) {
      throw new Error(`${fileName} 的原生解析警告无效。`);
    }
    if (
      warnings.some(
        (warning) => warning.originalIndex !== null && warning.originalIndex >= items.length
      )
    ) {
      throw new Error(`${fileName} 的原生解析警告引用了不存在的弹幕。`);
    }
    let xmlMetadata: XmlMediaMetadata | undefined;
    try {
      if (file.metadataXml != null) {
        if (typeof file.metadataXml !== "string") throw new Error("元数据类型无效");
        xmlMetadata = parseNativeXmlMetadata(file.metadataXml);
      }
    } catch (error) {
      warnings.push({
        originalIndex: null,
        severity: "warning",
        message: `已忽略无效媒体元数据：${String(error)}`,
        rawSnippet: ""
      });
    }
    return {
      ...(xmlMetadata ? { xmlMetadata } : {}),
      fileName,
      sourcePath: requestedPaths[fileIndex],
      receipt: { ...file.receipt },
      items: items.map((item) => ({ ...item, rawPFields: [...item.rawPFields] })),
      warnings: warnings.map((warning) => ({ ...warning }))
    };
  });
}

function isNativeXmlParsedItem(value: unknown): value is NativeXmlParsedItem {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.originalIndex) &&
    (value.originalIndex as number) >= 0 &&
    Number.isSafeInteger(value.sourceTimeMs) &&
    (value.sourceTimeMs as number) >= 0 &&
    isSafeIntegerOrNull(value.mode) &&
    isSafeIntegerOrNull(value.fontSize) &&
    isSafeIntegerOrNull(value.color) &&
    isSafeIntegerOrNull(value.timestamp) &&
    isSafeIntegerOrNull(value.pool) &&
    isStringOrNull(value.userHash) &&
    isStringOrNull(value.rowId) &&
    typeof value.text === "string" &&
    Array.isArray(value.rawPFields) &&
    value.rawPFields.every((field) => typeof field === "string")
  );
}

function isNativeXmlImportWarning(value: unknown): value is NativeXmlImportWarning {
  return (
    isRecord(value) &&
    (value.originalIndex === null ||
      (Number.isSafeInteger(value.originalIndex) && (value.originalIndex as number) >= 0)) &&
    value.severity === "warning" &&
    typeof value.message === "string" &&
    typeof value.rawSnippet === "string"
  );
}

function isSafeIntegerOrNull(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPathFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "未知错误";
}
