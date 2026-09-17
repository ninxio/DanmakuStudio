import { invoke, isTauri } from "@tauri-apps/api/core";
import { resolveExportDirectory } from "../settings/storageClient";
import { loadAppSettings } from "../settings/appSettings";
import type { DanmakuXmlSourceReceipt } from "../../domain/danmaku/types";
import type { MediaContentIdentity } from "../../domain/project/types";
import { sha256Hex } from "../../domain/shared/sha256";
import {
  createStoredZip,
  createStoredZipEntries,
  downloadTextFile,
  downloadTextFiles,
  sanitizeDownloadFileName,
  type DownloadTextFilesResult
} from "./browserFiles";

export interface ExportTextFile {
  fileName: string;
  content: string;
}

export interface DesktopTextReportFileRequest {
  directoryPath: string;
  fileName: string;
  content: string;
}

export interface VerifiedMediaDependency {
  mediaId: string;
  path: string;
  expectedIdentity: MediaContentIdentity;
  mapIds: string[];
}

export interface VerifiedExportManualVerification {
  verificationId: string;
  issuerKeyId: string;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
  requestPayload: string;
  requestDigest: string;
}

export interface VerifiedExportAutomaticVerification {
  calibrationArtifactId: string;
  calibrationArtifactVersion: string;
  verifier: string;
  verifiedAt: string;
}

export interface VerifiedExportMapProof {
  mapId: string;
  revision: number;
  state: "confirmed";
  declaredQuality: "verified";
  spanKinds: Array<"matched" | "sourceOnly" | "targetOnly" | "ambiguous">;
  coreDigest: string;
  coreCanonicalJson: string;
  sourceMediaId: string;
  targetMediaId: string;
  sourceIdentity: MediaContentIdentity;
  targetIdentity: MediaContentIdentity;
  manualVerification?: VerifiedExportManualVerification;
  automaticVerification?: VerifiedExportAutomaticVerification;
}

export interface ProjectionDerivationMediaV1 {
  mediaId: string;
  role: "targetOriginal" | "bilibiliReference";
  name: string;
  mediaFileName: string;
  durationMs: number | null;
  episodeLabel: string | null;
  contentIdentity: MediaContentIdentity | null;
}

export interface ProjectionDerivationDanmakuItemV1 {
  itemId: string;
  assetId: string;
  originalIndex: number;
  sourceTimeMs: number;
  mode: number | null;
  fontSize: number | null;
  color: number | null;
  timestamp: number | null;
  pool: number | null;
  userHash: string | null;
  rowId: string | null;
  text: string;
  rawPFields: string[];
  enabled: boolean;
}

export interface ProjectionDerivationXmlAssetV2 {
  assetId: string;
  sourceFileName: string;
  sourceReceipt: DanmakuXmlSourceReceipt | null;
  items: ProjectionDerivationDanmakuItemV1[];
}

export interface ProjectionDerivationSourceBindingV1 {
  bindingId: string;
  assetId: string;
  sourceMediaId: string;
}

export interface ProjectionDerivationTimingRuleV1 {
  ruleId: string;
  sourceAtMs: number;
  gapMs: number;
}

export interface ProjectionDerivationRouteV1 {
  routeId: string;
  kind: "content" | "ignored";
  assetId: string | null;
  sourceMediaId: string | null;
  sourceStartMs: number;
  sourceEndMs: number;
  targetMediaId: string | null;
  targetStartMs: number | null;
  timeMapId: string | null;
  timingRules: ProjectionDerivationTimingRuleV1[];
}

export interface ProjectionDerivationItemAdjustmentV1 {
  itemId: string;
  adjustmentMs: number;
}

export interface ProjectionDerivationTargetOutputFileV1 {
  /** Inert description; included in the snapshot digest, never proof of alignment. */
  metadataXml?: string;
  targetMediaId: string;
  fileName: string;
}

export interface ProjectionDerivationV2 {
  domain: "projection-derivation-v2";
  projectionPolicyVersion: "source-projection-v1";
  serializerVersion: "bilibili-xml-export-v1";
  projectId: string;
  projectUpdatedAt: string;
  media: ProjectionDerivationMediaV1[];
  xmlAssets: ProjectionDerivationXmlAssetV2[];
  sourceBindings: ProjectionDerivationSourceBindingV1[];
  routes: ProjectionDerivationRouteV1[];
  disabledItemIds: string[];
  itemTimeAdjustments: ProjectionDerivationItemAdjustmentV1[];
  targetOutputFiles: ProjectionDerivationTargetOutputFileV1[];
}

export interface VerifiedExportVerificationSeed {
  schemaVersion: 3;
  projectId: string;
  projectUpdatedAt: string;
  projectionDerivation: ProjectionDerivationV2;
  mapProofs: VerifiedExportMapProof[];
  dependencies: VerifiedMediaDependency[];
}

export interface VerifiedExportOutput {
  fileName: string;
  contentDigest: string;
}

export interface VerifiedExportVerification extends VerifiedExportVerificationSeed {
  manifestJson: string;
  manifestDigest: string;
  projectSnapshotDigest: string;
  archiveFileName: string;
  archiveContentDigest: string;
  outputs: VerifiedExportOutput[];
}

export interface DesktopVerifiedProjectedXmlExportRequest {
  directoryPath: string;
  fileName: string;
  contentBytes: number[];
  verification: VerifiedExportVerification;
}

export interface DesktopExportFileResult {
  fileName: string;
  filePath: string;
  directoryPath: string;
  wasRenamed: boolean;
}

export interface ExportFilesBridge {
  isAvailable: () => boolean;
  saveTextReport: (request: DesktopTextReportFileRequest) => Promise<DesktopExportFileResult>;
  saveVerifiedProjectedXml?: (
    request: DesktopVerifiedProjectedXmlExportRequest
  ) => Promise<DesktopExportFileResult>;
  openDirectory: (directoryPath: string) => Promise<void>;
}

export interface SaveTextReportOptions {
  directoryPath?: string;
  type?: string;
}

export interface DownloadLegacyXmlOptions {
  directoryPath?: string;
  type?: string;
  archiveFileName?: string;
}

/**
 * The complete authority required to write XML derived from a confirmed time map.
 * This deliberately does not extend the ordinary text-export options: projected XML
 * must never become an unverified export merely because one optional field was omitted.
 */
export interface SaveProjectedXmlExportsOptions {
  directoryPath: string;
  archiveFileName?: string;
  verification: VerifiedExportVerificationSeed;
  /** Re-evaluated immediately before the native verified-save request is sent. */
  isSnapshotCurrent: () => boolean;
}

export type SaveTextExportResult =
  | {
      mode: "directory";
      fileCount: number;
      fileName: string;
      filePath: string;
      directoryPath: string;
      wasRenamed: boolean;
    }
  | {
      mode: "download";
      fileCount: number;
      fileName: string | null;
      archiveFileName: string | null;
      downloadedFileName: string | null;
    };

export type SaveProjectedXmlExportsResult = Extract<
  SaveTextExportResult,
  { mode: "directory" }
>;

const DEFAULT_TEXT_EXPORT_TYPE = "text/plain;charset=utf-8";
const MAX_VERIFIED_PROJECTION_ITEMS = 500_000;
const MAX_VERIFIED_RAW_P_FIELDS = 64;
const MAX_VERIFIED_RAW_P_CODE_UNITS = 16 * 1024;
const MAX_VERIFIED_DANMAKU_TEXT_CODE_UNITS = 1024 * 1024;

const defaultExportFilesBridge: ExportFilesBridge = {
  isAvailable: () => isTauri(),
  saveTextReport: (request) =>
    invoke<DesktopExportFileResult>("save_text_report_file", { request }),
  saveVerifiedProjectedXml: (request) =>
    invoke<DesktopExportFileResult>("save_verified_projected_xml_export", { request }),
  openDirectory: (directoryPath) => invoke<void>("open_export_directory", { directoryPath })
};

export function getVerifiedExportUnavailableReason(
  directoryPath: string | undefined,
  bridge: ExportFilesBridge = defaultExportFilesBridge
): string | null {
  if (!normalizeDirectoryPath(directoryPath)) {
    return "高精度分集导出必须先在设置中选择桌面导出文件夹。";
  }
  if (!bridge.isAvailable() || !bridge.saveVerifiedProjectedXml) {
    return "高精度分集导出仅可在支持写盘前媒体身份复核的桌面端使用。";
  }
  return null;
}

export async function saveTextReportFile(
  file: ExportTextFile,
  options: SaveTextReportOptions = {},
  bridge: ExportFilesBridge = defaultExportFilesBridge
): Promise<SaveTextExportResult> {
  const directoryPath =
    bridge === defaultExportFilesBridge
      ? await resolveExportDirectory(
          options.directoryPath || loadAppSettings().export.defaultDirectory
        )
      : normalizeDirectoryPath(options.directoryPath);
  const safeFileName = sanitizeDownloadFileName(file.fileName, "report.txt");
  if (!hasCaseInsensitiveExtension(safeFileName, ".txt")) {
    throw new Error("普通文本报告只能保存为 .txt 文件。");
  }
  if (directoryPath && bridge.isAvailable()) {
    const request: DesktopTextReportFileRequest = {
      directoryPath,
      fileName: safeFileName,
      content: file.content
    };
    const result = await bridge.saveTextReport(request);
    return {
      mode: "directory",
      fileCount: 1,
      fileName: result.fileName,
      filePath: result.filePath,
      directoryPath: result.directoryPath,
      wasRenamed: result.wasRenamed
    };
  }
  const downloadedFileName = downloadTextFile(
    safeFileName,
    file.content,
    options.type ?? DEFAULT_TEXT_EXPORT_TYPE
  );
  return {
    mode: "download",
    fileCount: 1,
    fileName: downloadedFileName,
    archiveFileName: null,
    downloadedFileName
  };
}

export async function downloadLegacyXmlFile(
  file: ExportTextFile,
  options: Pick<DownloadLegacyXmlOptions, "type" | "directoryPath"> = {}
): Promise<SaveTextExportResult> {
  const safeFileName = sanitizeDownloadFileName(file.fileName, "export.xml");
  if (isTauri())
    return saveEditedXmlBytes(
      safeFileName,
      new TextEncoder().encode(file.content),
      1,
      options.directoryPath
    );
  const downloadedFileName = downloadTextFile(
    safeFileName,
    file.content,
    options.type ?? "application/xml;charset=utf-8"
  );
  return Promise.resolve({
    mode: "download",
    fileCount: 1,
    fileName: downloadedFileName,
    archiveFileName: null,
    downloadedFileName
  });
}

export async function downloadLegacyXmlFiles(
  files: ExportTextFile[],
  options: DownloadLegacyXmlOptions = {}
): Promise<SaveTextExportResult> {
  if (files.length === 0) {
    return Promise.resolve({
      mode: "download",
      fileCount: 0,
      fileName: null,
      archiveFileName: null,
      downloadedFileName: null
    });
  }
  if (isTauri()) {
    if (files.length === 1) return downloadLegacyXmlFile(files[0], options);
    const entries = createStoredZipEntries(files);
    const bytes = await blobToBytes(createStoredZip(entries));
    return saveEditedXmlBytes(
      sanitizeDownloadFileName(
        options.archiveFileName ?? "danmaku-exports.zip",
        "danmaku-exports.zip"
      ),
      bytes,
      files.length,
      options.directoryPath
    );
  }
  return Promise.resolve(
    downloadResultToSaveResult(
      downloadTextFiles(
        files,
        options.type ?? "application/xml;charset=utf-8",
        options.archiveFileName ?? "danmaku-exports.zip"
      )
    )
  );
}

async function saveEditedXmlBytes(
  fileName: string,
  bytes: Uint8Array,
  fileCount: number,
  explicit?: string
): Promise<SaveTextExportResult> {
  if (bytes.byteLength > 256 * 1024 * 1024)
    throw new Error("本次导出超过 256 MiB，请分批导出。");
  const directoryPath = await resolveExportDirectory(
    explicit || loadAppSettings().export.defaultDirectory
  );
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 32768)));
  const contentBase64 = btoa(chunks.join(""));
  const result = await invoke<DesktopExportFileResult>("save_edited_xml_export", {
    request: { directoryPath, fileName, contentBase64 }
  });
  return { mode: "directory", fileCount, ...result };
}

export async function saveProjectedXmlExports(
  files: readonly ExportTextFile[],
  options: SaveProjectedXmlExportsOptions,
  bridge: ExportFilesBridge = defaultExportFilesBridge
): Promise<SaveProjectedXmlExportsResult> {
  const directoryPath =
    bridge === defaultExportFilesBridge
      ? await resolveExportDirectory(
          options?.directoryPath || loadAppSettings().export.defaultDirectory
        )
      : normalizeDirectoryPath(options?.directoryPath);
  const verificationSeed = options?.verification;
  const isSnapshotCurrent = options?.isSnapshotCurrent;
  if (!verificationSeed) {
    throw new Error("高精度分集导出缺少必需的映射复核凭据，已阻断写盘。");
  }
  if (typeof isSnapshotCurrent !== "function") {
    throw new Error("高精度分集导出缺少项目快照时效检查，已阻断写盘。");
  }
  const unavailableReason = getVerifiedExportUnavailableReason(directoryPath, bridge);
  if (unavailableReason) {
    throw new Error(`${unavailableReason}不能降级为普通写盘或浏览器下载。`);
  }
  if (files.length === 0) {
    throw new Error("高精度分集导出没有可写入的 XML，已阻断写盘。");
  }

  let request: Omit<DesktopVerifiedProjectedXmlExportRequest, "verification">;
  let logicalFiles: ExportTextFile[];
  if (files.length === 1) {
    const file = files[0];
    const fileName = sanitizeDownloadFileName(file.fileName, "export.xml");
    logicalFiles = [{ fileName, content: file.content }];
    request = {
      directoryPath,
      fileName,
      contentBytes: Array.from(new TextEncoder().encode(file.content))
    };
  } else {
    const archiveFileName = sanitizeDownloadFileName(
      options.archiveFileName ?? "danmaku-exports.zip",
      "danmaku-exports.zip"
    );
    logicalFiles = createStoredZipEntries([...files]);
    const zipBytes = await blobToBytes(createStoredZip(logicalFiles));
    request = {
      directoryPath,
      fileName: archiveFileName,
      contentBytes: Array.from(zipBytes)
    };
  }

  if (!isSnapshotCurrent()) {
    throw new Error("项目或导出内容在身份核验期间发生变化，已取消写盘；请重新导出。");
  }
  const saveVerifiedProjectedXml = bridge.saveVerifiedProjectedXml;
  if (!saveVerifiedProjectedXml) {
    throw new Error("桌面端身份复核写盘能力不可用，高精度分集导出已阻断。");
  }
  const verification = createVerifiedExportVerification(
    verificationSeed,
    request.fileName,
    new Uint8Array(request.contentBytes),
    logicalFiles
  );
  const result = await saveVerifiedProjectedXml({ ...request, verification });
  return {
    mode: "directory",
    fileCount: files.length,
    fileName: result.fileName,
    filePath: result.filePath,
    directoryPath: result.directoryPath,
    wasRenamed: result.wasRenamed
  };
}

export async function openExportDirectoryPath(
  directoryPath: string,
  bridge: ExportFilesBridge = defaultExportFilesBridge
): Promise<void> {
  if (!bridge.isAvailable()) {
    throw new Error("打开目录需要在 Tauri 桌面端运行。");
  }
  await bridge.openDirectory(directoryPath);
}

export function formatExportFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDirectoryPath(path: string | undefined): string {
  return path?.trim() ?? "";
}

function hasCaseInsensitiveExtension(fileName: string, extension: string): boolean {
  return fileName.toLocaleLowerCase("en-US").endsWith(extension.toLocaleLowerCase("en-US"));
}

export function createVerifiedExportVerification(
  seed: VerifiedExportVerificationSeed,
  archiveFileName: string,
  archiveBytes: Uint8Array,
  logicalFiles: readonly ExportTextFile[]
): VerifiedExportVerification {
  if (seed.schemaVersion !== 3) {
    throw new Error("高精度导出 verification seed 版本不受支持。");
  }
  const projectionDerivation = normalizeProjectionDerivation(seed.projectionDerivation);
  if (
    projectionDerivation.projectId !== seed.projectId ||
    projectionDerivation.projectUpdatedAt !== seed.projectUpdatedAt
  ) {
    throw new Error("投影重建 inventory 与 verification seed 的项目快照不一致。");
  }
  const outputs = logicalFiles
    .map((file) => ({
      fileName: file.fileName,
      contentDigest: `sha256:${sha256Hex(file.content)}`
    }))
    .sort((left, right) => compareCanonicalString(left.fileName, right.fileName));
  validateLogicalProjectionOutputs(projectionDerivation, outputs);
  const mapProofs = [...seed.mapProofs]
    .map((proof) => {
      const hasManual = proof.manualVerification !== undefined;
      const hasAutomatic = proof.automaticVerification !== undefined;
      if (hasManual === hasAutomatic) {
        throw new Error("时间图 proof 必须且只能携带人工或内置自动验证中的一种。");
      }
      return {
        ...proof,
        spanKinds: [...proof.spanKinds],
        sourceIdentity: { ...proof.sourceIdentity },
        targetIdentity: { ...proof.targetIdentity },
        ...(proof.manualVerification
          ? { manualVerification: { ...proof.manualVerification } }
          : {}),
        ...(proof.automaticVerification
          ? { automaticVerification: { ...proof.automaticVerification } }
          : {})
      };
    })
    .sort((left, right) => compareCanonicalString(left.mapId, right.mapId));
  validateProjectionMapBindings(projectionDerivation, mapProofs);
  const dependencies = [...seed.dependencies]
    .map((dependency) => ({
      ...dependency,
      expectedIdentity: { ...dependency.expectedIdentity },
      mapIds: [...dependency.mapIds].sort(compareCanonicalString)
    }))
    .sort((left, right) => compareCanonicalString(left.mediaId, right.mediaId));
  const archiveContentDigest = `sha256:${sha256Hex(archiveBytes)}`;
  const projectSnapshotDigest = `sha256:${sha256Hex(
    JSON.stringify(canonicalProjectionDerivation(projectionDerivation))
  )}`;
  const manifestJson = JSON.stringify([
    "verified-export-manifest-v3",
    seed.schemaVersion,
    seed.projectId,
    seed.projectUpdatedAt,
    projectSnapshotDigest,
    archiveFileName,
    archiveContentDigest,
    outputs.map((output) => [output.fileName, output.contentDigest]),
    mapProofs.map((proof) => [
      proof.mapId,
      proof.revision,
      proof.state,
      proof.declaredQuality,
      proof.spanKinds,
      proof.coreDigest,
      proof.coreCanonicalJson,
      proof.sourceMediaId,
      proof.targetMediaId,
      canonicalMediaIdentity(proof.sourceIdentity),
      canonicalMediaIdentity(proof.targetIdentity),
      proof.manualVerification
        ? [
            proof.manualVerification.verificationId,
            proof.manualVerification.issuerKeyId,
            proof.manualVerification.signatureAlgorithm,
            proof.manualVerification.signature,
            proof.manualVerification.requestPayload,
            proof.manualVerification.requestDigest
          ]
        : [
            "automatic-calibration",
            proof.automaticVerification!.calibrationArtifactId,
            proof.automaticVerification!.calibrationArtifactVersion,
            proof.automaticVerification!.verifier,
            proof.automaticVerification!.verifiedAt
          ]
    ]),
    dependencies.map((dependency) => [
      dependency.mediaId,
      canonicalMediaIdentity(dependency.expectedIdentity),
      dependency.mapIds
    ])
  ]);
  return {
    ...seed,
    projectionDerivation,
    mapProofs,
    dependencies,
    manifestJson,
    manifestDigest: `sha256:${sha256Hex(manifestJson)}`,
    projectSnapshotDigest,
    archiveFileName,
    archiveContentDigest,
    outputs
  };
}

export function createProjectionDerivationCanonicalJson(
  derivation: ProjectionDerivationV2
): string {
  return JSON.stringify(
    canonicalProjectionDerivation(normalizeProjectionDerivation(derivation))
  );
}

function normalizeProjectionDerivation(
  derivation: ProjectionDerivationV2
): ProjectionDerivationV2 {
  if (
    !derivation ||
    derivation.domain !== "projection-derivation-v2" ||
    derivation.projectionPolicyVersion !== "source-projection-v1" ||
    derivation.serializerVersion !== "bilibili-xml-export-v1"
  ) {
    throw new Error("高精度导出缺少受支持的 projection-derivation-v2 inventory。");
  }
  const projectionItemCount = derivation.xmlAssets.reduce(
    (count, asset) => count + asset.items.length,
    0
  );
  if (projectionItemCount > MAX_VERIFIED_PROJECTION_ITEMS) {
    throw new Error(
      `高精度导出最多处理 ${MAX_VERIFIED_PROJECTION_ITEMS.toLocaleString("en-US")} 条项目弹幕。`
    );
  }
  for (const asset of derivation.xmlAssets) {
    for (const item of asset.items) {
      const rawPCodeUnits = item.rawPFields.reduce((count, field) => count + field.length, 0);
      if (
        item.rawPFields.length > MAX_VERIFIED_RAW_P_FIELDS ||
        rawPCodeUnits > MAX_VERIFIED_RAW_P_CODE_UNITS ||
        item.text.length > MAX_VERIFIED_DANMAKU_TEXT_CODE_UNITS
      ) {
        throw new Error(`XML 资产 ${asset.sourceFileName} 含超过安全大小上限的弹幕字段。`);
      }
    }
  }
  const itemTimeAdjustments = derivation.itemTimeAdjustments
    .map((adjustment) => ({ ...adjustment }))
    .sort((left, right) => compareCanonicalString(left.itemId, right.itemId));
  assertUniqueValues(
    itemTimeAdjustments.map((adjustment) => adjustment.itemId),
    "投影重建 inventory 含重复的单条时间调整 itemId。"
  );
  return {
    ...derivation,
    media: derivation.media.map((media) => ({
      ...media,
      contentIdentity: media.contentIdentity ? { ...media.contentIdentity } : null
    })),
    xmlAssets: derivation.xmlAssets.map((asset) => ({
      ...asset,
      sourceReceipt: asset.sourceReceipt ? { ...asset.sourceReceipt } : null,
      items: asset.items.map((item) => ({ ...item, rawPFields: [...item.rawPFields] }))
    })),
    sourceBindings: derivation.sourceBindings.map((binding) => ({ ...binding })),
    routes: derivation.routes.map((route) => ({
      ...route,
      timingRules: route.timingRules.map((rule) => ({ ...rule }))
    })),
    disabledItemIds: [...new Set(derivation.disabledItemIds)].sort(compareCanonicalString),
    itemTimeAdjustments,
    targetOutputFiles: derivation.targetOutputFiles.map((output) => ({ ...output }))
  };
}

function validateProjectionMapBindings(
  derivation: ProjectionDerivationV2,
  mapProofs: readonly VerifiedExportMapProof[]
): void {
  const proofByMapId = new Map<string, VerifiedExportMapProof>();
  for (const proof of mapProofs) {
    if (proofByMapId.has(proof.mapId)) {
      throw new Error(`高精度导出含重复时间图 proof：${proof.mapId}。`);
    }
    if (`sha256:${sha256Hex(proof.coreCanonicalJson)}` !== proof.coreDigest) {
      throw new Error(`时间图 ${proof.mapId} 的 coreCanonicalJson 与 coreDigest 不一致。`);
    }
    const parsedCore = parseTimeMapCoreIdentity(proof.coreCanonicalJson);
    if (parsedCore.mapId !== proof.mapId || parsedCore.revision !== proof.revision) {
      throw new Error(`时间图 ${proof.mapId} 的 proof 与 coreCanonicalJson 身份不一致。`);
    }
    proofByMapId.set(proof.mapId, proof);
  }
  for (const route of derivation.routes) {
    if (route.kind === "content" && route.timeMapId && !proofByMapId.has(route.timeMapId)) {
      throw new Error(`投影 route ${route.routeId} 引用的时间图没有 verified proof。`);
    }
  }
}

function validateLogicalProjectionOutputs(
  derivation: ProjectionDerivationV2,
  outputs: readonly VerifiedExportOutput[]
): void {
  const targetIds = derivation.targetOutputFiles.map((target) => target.targetMediaId);
  const targetFileNames = derivation.targetOutputFiles.map((target) => target.fileName);
  assertUniqueValues(targetIds, "投影重建 inventory 含重复的 targetMediaId。");
  assertUniqueValues(targetFileNames, "投影重建 inventory 含重复的目标 XML 文件名。");
  const declaredFileNames = new Set(targetFileNames);
  for (const output of outputs) {
    if (!declaredFileNames.has(output.fileName)) {
      throw new Error(`逻辑 XML ${output.fileName} 没有绑定对应的投影目标。`);
    }
  }
}

function parseTimeMapCoreIdentity(coreCanonicalJson: string): {
  mapId: string;
  revision: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(coreCanonicalJson);
  } catch {
    throw new Error("时间图 coreCanonicalJson 不是有效 JSON。");
  }
  if (
    !Array.isArray(parsed) ||
    parsed[0] !== "media-time-map-core-v2" ||
    typeof parsed[1] !== "string" ||
    !Number.isSafeInteger(parsed[2]) ||
    (parsed[2] as number) < 1
  ) {
    throw new Error("时间图 coreCanonicalJson 不符合 media-time-map-core-v2 身份结构。");
  }
  return { mapId: parsed[1], revision: parsed[2] as number };
}

function canonicalProjectionDerivation(derivation: ProjectionDerivationV2): readonly unknown[] {
  return [
    derivation.domain,
    derivation.projectionPolicyVersion,
    derivation.serializerVersion,
    derivation.projectId,
    derivation.projectUpdatedAt,
    derivation.media.map((media) => [
      media.mediaId,
      media.role,
      media.name,
      media.mediaFileName,
      media.durationMs,
      media.episodeLabel,
      canonicalNullableMediaIdentity(media.contentIdentity)
    ]),
    derivation.xmlAssets.map((asset) => [
      asset.assetId,
      asset.sourceFileName,
      canonicalNullableXmlSourceReceipt(asset.sourceReceipt),
      asset.items.map((item) => [
        item.itemId,
        item.assetId,
        item.originalIndex,
        item.sourceTimeMs,
        item.mode,
        item.fontSize,
        item.color,
        item.timestamp,
        item.pool,
        item.userHash,
        item.rowId,
        item.text,
        item.rawPFields,
        item.enabled
      ])
    ]),
    derivation.sourceBindings.map((binding) => [
      binding.bindingId,
      binding.assetId,
      binding.sourceMediaId
    ]),
    derivation.routes.map((route) => [
      route.routeId,
      route.kind,
      route.assetId,
      route.sourceMediaId,
      route.sourceStartMs,
      route.sourceEndMs,
      route.targetMediaId,
      route.targetStartMs,
      route.timeMapId,
      route.timingRules.map((rule) => [rule.ruleId, rule.sourceAtMs, rule.gapMs])
    ]),
    derivation.disabledItemIds,
    derivation.itemTimeAdjustments.map((adjustment) => [
      adjustment.itemId,
      adjustment.adjustmentMs
    ]),
    derivation.targetOutputFiles.map((output) =>
      output.metadataXml === undefined
        ? [output.targetMediaId, output.fileName]
        : [output.targetMediaId, output.fileName, output.metadataXml]
    )
  ];
}

function canonicalNullableXmlSourceReceipt(
  receipt: DanmakuXmlSourceReceipt | null
): readonly unknown[] | null {
  return receipt
    ? [
        receipt.domain,
        receipt.version,
        receipt.receiptId,
        receipt.contentDigest,
        receipt.sizeBytes,
        receipt.parserVersion,
        receipt.inventoryDigest,
        receipt.issuerKeyId,
        receipt.signatureAlgorithm,
        receipt.signature
      ]
    : null;
}

function assertUniqueValues(values: readonly string[], message: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(message);
  }
}

function canonicalMediaIdentity(identity: MediaContentIdentity): readonly unknown[] {
  return [
    identity.algorithm,
    identity.sizeBytes,
    identity.modifiedUnixMs,
    identity.firstSampleDigest,
    identity.middleSampleDigest,
    identity.lastSampleDigest
  ];
}

function canonicalNullableMediaIdentity(
  identity: MediaContentIdentity | null
): readonly unknown[] | null {
  return identity ? canonicalMediaIdentity(identity) : null;
}

function compareCanonicalString(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function downloadResultToSaveResult(result: DownloadTextFilesResult): SaveTextExportResult {
  return {
    mode: "download",
    fileCount: result.fileCount,
    fileName: result.downloadedFileName,
    archiveFileName: result.archiveFileName,
    downloadedFileName: result.downloadedFileName
  };
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const modernBlob = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modernBlob.arrayBuffer === "function") {
    return new Uint8Array(await modernBlob.arrayBuffer());
  }
  return readBlobWithReader(blob);
}

function readBlobWithReader(blob: Blob): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
        return;
      }
      reject(new Error("导出 ZIP 数据读取失败。"));
    };
    reader.onerror = () => reject(new Error("导出 ZIP 数据读取失败。"));
    reader.readAsArrayBuffer(blob);
  });
}
