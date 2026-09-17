import type { DanmakuAsset, DanmakuItem, ImportWarning } from "../domain/danmaku/types";
import { createId } from "../domain/project/factory";
import {
  createBrowserFileMediaReference,
  createLocalPathMediaReference
} from "../domain/project/mediaLibrary";
import type { ProjectMediaReference, ProjectMediaRole } from "../domain/project/types";
import { pickAssetColor } from "../domain/shared/assetColors";
import { createObjectUrl, readFilesAsText } from "../infrastructure/file-system/browserFiles";
import { parseBilibiliXml } from "../infrastructure/xml/bilibiliXml";
import {
  importNativeXmlPaths,
  type NativeXmlImportedFile,
  type NativeXmlParsedItem
} from "../infrastructure/xml/nativeXmlReceipt";
import { isSupportedMediaPath } from "../domain/project/mediaFormat";

export async function parseXmlFilesAsAssets(
  files: FileList | File[],
  existingAssetCount: number,
  onProgress: (ratio: number) => void
): Promise<DanmakuAsset[]> {
  const fileArray = Array.from(files).filter((file) =>
    file.name.toLowerCase().endsWith(".xml")
  );
  if (fileArray.length === 0) {
    throw new Error("EMPTY_XML_SELECTION");
  }
  const texts = await readFilesAsText(fileArray);
  const assets: DanmakuAsset[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const { file, text } = texts[index];
    assets.push(
      parseBilibiliXml(text, {
        fileName: file.name,
        assetName: file.name.replace(/\.[^.]+$/, ""),
        color: pickAssetColor(existingAssetCount + index)
      })
    );
    if (file.webkitRelativePath) assets[assets.length - 1].sourcePath = file.webkitRelativePath;
    onProgress((index + 1) / texts.length);
    await Promise.resolve();
  }
  return assets;
}

export function filterXmlFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => file.name.toLowerCase().endsWith(".xml"));
}

export async function importNativeXmlFiles(paths: string[]): Promise<NativeXmlImportedFile[]> {
  return importNativeXmlPaths(paths);
}

export function mergeNativeXmlIntoAssets(
  importedFiles: readonly NativeXmlImportedFile[],
  existingAssets: readonly DanmakuAsset[]
): {
  assets: DanmakuAsset[];
  replacements: number;
  additions: number;
  itemCount: number;
} {
  const materialized = materializeNativeXmlBatch(importedFiles, existingAssets);
  return {
    assets: existingAssets
      .map((asset) => materialized.replacements.get(asset.id) ?? asset)
      .concat(materialized.additions),
    replacements: materialized.replacements.size,
    additions: materialized.additions.length,
    itemCount: importedFiles.reduce((sum, file) => sum + file.items.length, 0)
  };
}

export function createImportedBrowserMedia(
  files: FileList | File[],
  role: ProjectMediaRole
): ProjectMediaReference[] {
  return Array.from(files)
    .filter(isSupportedMediaFile)
    .map((file) =>
      createBrowserFileMediaReference(createId("media"), role, {
        name: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        objectUrl: createObjectUrl(file),
        durationMs: null
      })
    );
}

export function createImportedPathMedia(
  paths: string[],
  role: ProjectMediaRole,
  mediaLibrary: readonly ProjectMediaReference[]
): {
  importedMedia: ProjectMediaReference[];
  skippedCount: number;
  uniquePathCount: number;
} {
  const uniquePaths = uniqueSupportedMediaPaths(paths);
  const existingKeys = new Set(
    mediaLibrary
      .filter((media) => media.role === role && media.localPath)
      .map((media) => normalizeMediaPathKey(media.localPath ?? ""))
  );
  const importedPaths = uniquePaths.filter(
    (path) => !existingKeys.has(normalizeMediaPathKey(path))
  );
  return {
    importedMedia: importedPaths.map((path) =>
      createLocalPathMediaReference(createId("media"), role, path)
    ),
    skippedCount: uniquePaths.length - importedPaths.length,
    uniquePathCount: uniquePaths.length
  };
}

// Re-export types used by callers that previously relied on local helpers.
export type { DanmakuAsset, DanmakuItem, ImportWarning, NativeXmlImportedFile };

export function isSupportedMediaFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    isSupportedMediaPath(name) ||
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/")
  );
}

function uniqueSupportedMediaPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  paths.forEach((path) => {
    const trimmed = path.trim();
    const key = normalizeMediaPathKey(trimmed);
    if (trimmed.length === 0 || !isSupportedMediaPath(trimmed) || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function normalizeMediaPathKey(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+/g, "\\").toLocaleLowerCase("en-US");
}

interface MaterializedNativeXmlBatch {
  replacements: Map<string, DanmakuAsset>;
  additions: DanmakuAsset[];
}

function materializeNativeXmlBatch(
  importedFiles: readonly NativeXmlImportedFile[],
  existingAssets: readonly DanmakuAsset[]
): MaterializedNativeXmlBatch {
  const replacements = new Map<string, DanmakuAsset>();
  const additions: DanmakuAsset[] = [];
  const claimedAssetIds = new Set<string>();
  const batchImportedAt = new Date().toISOString();

  importedFiles.forEach((file) => {
    const matchingLegacyAssets = existingAssets.filter(
      (asset) =>
        asset.sourceReceipt === null &&
        !claimedAssetIds.has(asset.id) &&
        hasSameNativeXmlInventory(asset, file.items)
    );
    if (matchingLegacyAssets.length === 1) {
      const legacyAsset = matchingLegacyAssets[0];
      claimedAssetIds.add(legacyAsset.id);
      replacements.set(
        legacyAsset.id,
        createAssetFromNativeXml(file, {
          assetId: legacyAsset.id,
          name: legacyAsset.name,
          color: legacyAsset.color,
          importedAt: legacyAsset.importedAt
        })
      );
      return;
    }

    const assetId = createId("asset");
    additions.push(
      createAssetFromNativeXml(file, {
        assetId,
        name: file.fileName.replace(/\.[^.]+$/, ""),
        color: pickAssetColor(existingAssets.length + additions.length),
        importedAt: batchImportedAt
      })
    );
  });

  return { replacements, additions };
}

function createAssetFromNativeXml(
  file: NativeXmlImportedFile,
  metadata: Pick<DanmakuAsset, "name" | "color" | "importedAt"> & { assetId: string }
): DanmakuAsset {
  const items: DanmakuItem[] = file.items.map((item) => ({
    ...item,
    id: `${metadata.assetId}_item_${item.originalIndex}`,
    assetId: metadata.assetId,
    rawPFields: [...item.rawPFields],
    enabled: true
  }));
  const warnings: ImportWarning[] = file.warnings.map((warning) => ({
    ...warning,
    id: createId("warning"),
    assetId: metadata.assetId
  }));
  return {
    id: metadata.assetId,
    name: metadata.name,
    fileName: file.fileName,
    ...(file.sourcePath ? { sourcePath: file.sourcePath } : {}),
    ...(file.xmlMetadata ? { xmlMetadata: file.xmlMetadata } : {}),
    color: metadata.color,
    items,
    warnings,
    importedAt: metadata.importedAt,
    sourceReceipt: { ...file.receipt }
  };
}

function hasSameNativeXmlInventory(
  asset: DanmakuAsset,
  nativeItems: readonly NativeXmlParsedItem[]
): boolean {
  return (
    asset.items.length === nativeItems.length &&
    asset.items.every((item, index) => isSameNativeXmlInventoryItem(item, nativeItems[index]))
  );
}

function isSameNativeXmlInventoryItem(
  item: DanmakuItem,
  nativeItem: NativeXmlParsedItem
): boolean {
  return (
    item.originalIndex === nativeItem.originalIndex &&
    item.sourceTimeMs === nativeItem.sourceTimeMs &&
    item.mode === nativeItem.mode &&
    item.fontSize === nativeItem.fontSize &&
    item.color === nativeItem.color &&
    item.timestamp === nativeItem.timestamp &&
    item.pool === nativeItem.pool &&
    item.userHash === nativeItem.userHash &&
    item.rowId === nativeItem.rowId &&
    item.text === nativeItem.text &&
    item.rawPFields.length === nativeItem.rawPFields.length &&
    item.rawPFields.every((field, index) => field === nativeItem.rawPFields[index])
  );
}
