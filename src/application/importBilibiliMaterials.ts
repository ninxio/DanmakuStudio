import { isBilibiliAcquisition } from "../domain/danmaku/bilibiliAcquisition";
import { reconcileMediaMatchCandidates } from "../domain/alignment/mediaMatching";
import { pickAssetColor } from "../domain/shared/assetColors";
import { createId } from "../domain/project/factory";
import {
  createDanmakuSourceBinding,
  createLocalPathMediaReference
} from "../domain/project/mediaLibrary";
import type { EditorProject } from "../domain/project/types";
import type { BilibiliDownloadedPage } from "../infrastructure/bilibili/bilibiliClient";
import {
  importNativeXmlPaths,
  normalizeNativeXmlPaths,
  type NativeXmlImportedFile
} from "../infrastructure/xml/nativeXmlReceipt";
import { mergeNativeXmlIntoAssets } from "./importProjectMedia";

export interface PreparedBilibiliPage {
  download: BilibiliDownloadedPage;
  xml: NativeXmlImportedFile;
}
export interface BilibiliImportSummary {
  added: number;
  reused: number;
  preserved: number;
  audioAdded: number;
  bound: number;
  retainedAudioReferences?: number;
}
export async function prepareBilibiliMaterials(
  results: readonly BilibiliDownloadedPage[]
): Promise<PreparedBilibiliPage[]> {
  validateDownloads(results);
  if (results.length === 0) return [];
  const prepared: PreparedBilibiliPage[] = [];
  // Two maximum-size files fit the native 500,000-item / 256 MiB batch limits.
  // Read sequentially, then let the caller commit the complete import once.
  for (let offset = 0; offset < results.length; offset += 2) {
    const batch = results.slice(offset, offset + 2);
    const files = await importNativeXmlPaths(batch.map((result) => result.xmlPath));
    prepared.push(...batch.map((download, index) => ({ download, xml: files[index] })));
  }
  return prepared;
}
function validateDownloads(results: readonly BilibiliDownloadedPage[]) {
  if (normalizeNativeXmlPaths(results.map((page) => page.xmlPath)).length !== results.length) {
    throw new Error("下载结果包含重复或无效 XML 路径，未导入任何素材。");
  }
  const identities = new Set<string>();
  for (const page of results) {
    const identity = `${page.aid}:${page.cid}`;
    if (
      !isBilibiliAcquisition(toAcquisition(page)) ||
      identities.has(identity) ||
      !page.xmlPath.toLowerCase().endsWith(".xml") ||
      (page.audioPath !== null &&
        (!page.audioPath.toLowerCase().endsWith(".m4a") || page.audioPath.includes("\0")))
    ) {
      throw new Error("下载结果的来源身份或文件路径无效，未导入任何素材。");
    }
    identities.add(identity);
  }
}
function toAcquisition(page: BilibiliDownloadedPage) {
  return {
    kind: "bilibili" as const,
    bvid: page.bvid,
    aid: page.aid,
    cid: page.cid,
    page: page.page,
    durationMs: page.durationMs,
    exactDuration: page.exactDuration,
    xmlPath: page.xmlPath
  };
}

/** One project transaction. A retry never replaces edited inventory or a manual source binding. */
export function applyBilibiliMaterials(
  project: EditorProject,
  prepared: readonly PreparedBilibiliPage[]
) {
  validateDownloads(prepared.map((item) => item.download));
  let assets = [...project.assets];
  const mediaLibrary = [...project.mediaLibrary];
  const bindings = [...project.danmakuSourceBindings];
  const summary: BilibiliImportSummary = {
    added: 0,
    reused: 0,
    preserved: 0,
    audioAdded: 0,
    bound: 0
  };
  let changed = false;
  for (const { download, xml } of prepared) {
    const provenance = toAcquisition(download);
    let asset = assets.find(
      (item) => item.acquisition?.aid === download.aid && item.acquisition.cid === download.cid
    );
    const preservesInventory = Boolean(
      asset && asset.sourceReceipt?.inventoryDigest !== xml.receipt.inventoryDigest
    );
    if (preservesInventory) {
      summary.preserved++;
    }
    if (!asset) {
      const candidates = assets.filter(
        (item) =>
          !item.acquisition && item.sourceReceipt?.contentDigest === xml.receipt.contentDigest
      );
      const batchMatches = prepared.filter(
        (item) => item.xml.receipt.contentDigest === xml.receipt.contentDigest
      );
      if (candidates.length === 1 && batchMatches.length === 1) {
        asset = { ...candidates[0], acquisition: provenance };
        const claimed = asset;
        assets = assets.map((item) => (item.id === claimed.id ? claimed : item));
        summary.reused++;
      } else {
        // Materialize only this verified file; do not inventory-match unrelated preview assets.
        asset = { ...mergeNativeXmlIntoAssets([xml], []).assets[0], acquisition: provenance };
        asset.color = pickAssetColor(assets.length);
        assets.push(asset);
        summary.added++;
      }
      changed = true;
    } else if (!preservesInventory) {
      summary.reused++;
      if (download.exactDuration && !asset.acquisition?.exactDuration) {
        const refreshed = {
          ...asset,
          acquisition: {
            ...provenance,
            xmlPath: asset.acquisition?.xmlPath ?? provenance.xmlPath
          }
        };
        assets = assets.map((item) => (item.id === refreshed.id ? refreshed : item));
        asset = refreshed;
        changed = true;
      }
    }
    if (!download.audioPath) continue;
    const mediaId = `bilibili-reference-${download.aid}-${download.cid}`;
    let media = mediaLibrary.find(
      (item) =>
        item.role === "bilibiliReference" &&
        (item.id === mediaId ||
          normalizePath(item.localPath) === normalizePath(download.audioPath))
    );
    const binding = bindings.find((item) => item.assetId === asset.id);
    if (media) {
      if (
        media.id === mediaId &&
        media.referenceKind === "localPath" &&
        media.connectionState === "needsReconnect"
      ) {
        const reconnected = {
          ...media,
          localPath: download.audioPath,
          connectionState: "connected" as const,
          objectUrl: null,
          contentIdentity: null,
          updatedAt: new Date().toISOString()
        };
        mediaLibrary[mediaLibrary.indexOf(media)] = reconnected;
        media = reconnected;
        changed = true;
      } else if (normalizePath(media.localPath) !== normalizePath(download.audioPath)) {
        summary.retainedAudioReferences = (summary.retainedAudioReferences ?? 0) + 1;
      }
    }
    if (!media && binding) continue;
    if (!media) {
      media = {
        ...createLocalPathMediaReference(
          mediaId,
          "bilibiliReference",
          download.audioPath,
          download.exactDuration ? download.durationMs : null
        ),
        name: `P${download.page} ${download.part}`,
        sourceSummary: `B 站参考音轨 · ${download.bvid} · P${download.page} · cid ${download.cid}`
      };
      mediaLibrary.push(media);
      summary.audioAdded++;
      changed = true;
    }
    if (!binding) {
      bindings.push(createDanmakuSourceBinding(createId("binding"), asset.id, media.id));
      summary.bound++;
      changed = true;
    }
  }
  return {
    project: changed
      ? reconcileMediaMatchCandidates({
          ...project,
          assets,
          mediaLibrary,
          danmakuSourceBindings: bindings
        })
      : project,
    summary
  };
}
function normalizePath(path: string | null) {
  return path?.trim().replace(/\\/g, "/").toLocaleLowerCase("en-US") ?? "";
}
