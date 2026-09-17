import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeXml from "../infrastructure/xml/nativeXmlReceipt";
import { createMediaMatchCandidate } from "../domain/alignment/mediaMatching";
import { createEmptyProject } from "../domain/project/factory";
import {
  createDanmakuSourceBinding,
  createLocalPathMediaReference
} from "../domain/project/mediaLibrary";
import {
  parseProjectJsonWithMetadata,
  serializeProject,
  validateProjectSchema
} from "../domain/project/schema";
import { appendUnplacedXmlAssets } from "../domain/timeline/xmlTimeline";
import { resolveProjectDanmakuEvents } from "../domain/timeline/mapping";
import { buildBatchMergePlan } from "../domain/danmaku/batchMerge";
import {
  applyBilibiliMaterials,
  prepareBilibiliMaterials,
  type PreparedBilibiliPage
} from "./importBilibiliMaterials";
function prepared(cid: number, audio = true, digest = String(cid)): PreparedBilibiliPage {
  return {
    download: {
      bvid: "BV1xx411c7mD",
      aid: 170001,
      cid,
      page: cid,
      part: `第 ${cid} 部分`,
      durationMs: 60_000,
      exactDuration: true,
      danmakuCount: 1,
      xmlPath: `C:/downloads/P${cid}.xml`,
      audioPath: audio ? `C:/downloads/P${cid}.m4a` : null
    },
    xml: {
      fileName: `S01E01 P${cid}.xml`,
      receipt: {
        domain: "danmaku-xml-content-receipt-v1",
        version: 1,
        receiptId: `xmlr-sha256:${digest.repeat(64)}`,
        contentDigest: `sha256:${digest.repeat(64)}`,
        sizeBytes: 100,
        parserVersion: "bilibili-xml-native-v1",
        inventoryDigest: `sha256:${digest.repeat(64)}`,
        issuerKeyId: `install-sha256:${"a".repeat(32)}`,
        signatureAlgorithm: "hmac-sha256-v1",
        signature: "b".repeat(64)
      },
      items: [
        {
          originalIndex: 0,
          sourceTimeMs: cid === 1 ? 10_000 : 5_000,
          mode: 1,
          fontSize: 25,
          color: 16777215,
          timestamp: 0,
          pool: 0,
          userHash: "u",
          rowId: String(cid),
          text: `弹幕${cid}`,
          rawPFields: [
            cid === 1 ? "10" : "5",
            "1",
            "25",
            "16777215",
            "0",
            "0",
            "u",
            String(cid)
          ]
        }
      ],
      warnings: []
    }
  };
}
describe("Bilibili material transaction", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reads more than 256 P in bounded native batches and keeps their order", async () => {
    const pages = Array.from({ length: 257 }, (_, index) => prepared(index + 1));
    const byPath = new Map(pages.map((page) => [page.download.xmlPath, page.xml]));
    const read = vi.spyOn(nativeXml, "importNativeXmlPaths").mockImplementation((paths) => {
      expect(paths.length).toBeLessThanOrEqual(2);
      return Promise.resolve(paths.map((path) => byPath.get(path)!));
    });
    expect(await prepareBilibiliMaterials(pages.map((page) => page.download))).toEqual(pages);
    expect(read).toHaveBeenCalledTimes(129);
  });
  it("rejects a failed later batch without returning a partial project import", async () => {
    const pages = [prepared(1), prepared(2), prepared(3)];
    vi.spyOn(nativeXml, "importNativeXmlPaths")
      .mockResolvedValueOnce(pages.slice(0, 2).map((page) => page.xml))
      .mockRejectedValueOnce(new Error("文件无法读取"));
    await expect(prepareBilibiliMaterials(pages.map((page) => page.download))).rejects.toThrow(
      "文件无法读取"
    );
  });
  it("binds non-contiguous P to their own references and retains native receipts", () => {
    const original = createEmptyProject();
    const { project, summary } = applyBilibiliMaterials(original, [prepared(1), prepared(3)]);
    expect(summary).toMatchObject({ added: 2, audioAdded: 2, bound: 2 });
    expect(original.assets).toHaveLength(0);
    expect(
      project.danmakuSourceBindings.map((binding) => ({
        cid: project.assets.find((a) => a.id === binding.assetId)?.acquisition?.cid,
        path: project.mediaLibrary.find((m) => m.id === binding.sourceMediaId)?.localPath
      }))
    ).toEqual([
      { cid: 1, path: "C:/downloads/P1.m4a" },
      { cid: 3, path: "C:/downloads/P3.m4a" }
    ]);
    expect(project.assets.every((asset) => asset.sourceReceipt !== null)).toBe(true);
    const restored = parseProjectJsonWithMetadata(serializeProject(project)).project;
    expect(restored.assets.map((asset) => asset.acquisition)).toEqual(
      project.assets.map((asset) => asset.acquisition)
    );
    expect(restored.danmakuSourceBindings).toEqual(project.danmakuSourceBindings);
  });
  it("does not duplicate a cid after moving folders or replace manual edits/bindings", () => {
    const first = applyBilibiliMaterials(createEmptyProject(), [prepared(1)]).project;
    const manual = createLocalPathMediaReference(
      "manual",
      "bilibiliReference",
      "C:/manual.m4a"
    );
    first.mediaLibrary.push(manual);
    first.assets[0].name = "我的名字";
    first.danmakuSourceBindings = [
      createDanmakuSourceBinding("locked", first.assets[0].id, manual.id)
    ];
    const retry = prepared(1);
    retry.download.xmlPath = "D:/elsewhere/P1.xml";
    retry.download.audioPath = "D:/elsewhere/P1.m4a";
    const result = applyBilibiliMaterials(first, [retry]);
    expect(result.project).toBe(first);
    expect(result.summary.reused).toBe(1);
    const changedInventory = applyBilibiliMaterials(first, [prepared(1, true, "c")]);
    expect(changedInventory.project).toBe(first);
    expect(changedInventory.summary.preserved).toBe(1);
    expect(first.assets[0].name).toBe("我的名字");
    expect(first.danmakuSourceBindings[0].sourceMediaId).toBe("manual");
  });
  it("keeps full P duration in XML-only editing and legacy concatenation", () => {
    const imported = applyBilibiliMaterials(createEmptyProject(), [
      prepared(1, false),
      prepared(2, false)
    ]).project;
    const timeline = appendUnplacedXmlAssets(imported);
    expect(timeline.clips.map((clip) => clip.timelineStartMs)).toEqual([0, 60_000]);
    expect(resolveProjectDanmakuEvents(timeline).map((item) => item.finalTimeMs)).toEqual([
      10_000, 65_000
    ]);
    const plan = buildBatchMergePlan(imported.assets);
    expect(plan.episodes).toHaveLength(1);
    expect(plan.episodes[0].entries.map((item) => item.finalTimeMs)).toEqual([10_000, 65_000]);
  });
  it("adds audio after XML-only acquisition without replacing its receipt or clips", () => {
    const first = appendUnplacedXmlAssets(
      applyBilibiliMaterials(createEmptyProject(), [prepared(1, false)]).project
    );
    const upgraded = prepared(1);
    upgraded.xml.receipt.contentDigest = `sha256:${"c".repeat(64)}`;
    upgraded.xml.receipt.inventoryDigest = `sha256:${"d".repeat(64)}`;
    const result = applyBilibiliMaterials(first, [upgraded]);
    expect(result.summary).toMatchObject({ added: 0, preserved: 1, audioAdded: 1, bound: 1 });
    expect(result.project.assets[0]).toBe(first.assets[0]);
    expect(result.project.clips).toBe(first.clips);
  });
  it("handles an empty P without collapsing its known duration", () => {
    const empty = prepared(1, false);
    empty.xml.items = [];
    empty.download.danmakuCount = 0;
    const project = appendUnplacedXmlAssets(
      applyBilibiliMaterials(createEmptyProject(), [empty, prepared(2, false)]).project
    );
    expect(project.clips[0].sourceOutMs).toBe(60_000);
    expect(resolveProjectDanmakuEvents(project)[0].finalTimeMs).toBe(65_000);
  });
  it("rejects duplicate identities and malformed provenance without modifying the project", () => {
    const project = createEmptyProject();
    expect(() => applyBilibiliMaterials(project, [prepared(1), prepared(1)])).toThrow(
      "未导入任何素材"
    );
    const duplicatePath = prepared(2);
    duplicatePath.download.xmlPath = prepared(1).download.xmlPath;
    expect(() => applyBilibiliMaterials(project, [prepared(1), duplicatePath])).toThrow("重复");
    expect(project.assets).toEqual([]);
    const valid = applyBilibiliMaterials(project, [prepared(1)]).project;
    const invalid = structuredClone(valid);
    if (invalid.assets[0].acquisition) invalid.assets[0].acquisition.cid = 1.5;
    expect(validateProjectSchema(invalid).ok).toBe(false);
    expect(validateProjectSchema(createEmptyProject()).ok).toBe(true);
  });
  it("unblocks an existing match when its source XML arrives", () => {
    const source = createLocalPathMediaReference(
      "source",
      "bilibiliReference",
      "C:/downloads/P1.m4a",
      60_000
    );
    const target = createLocalPathMediaReference(
      "target",
      "targetOriginal",
      "C:/original.m4a",
      60_000
    );
    const project = { ...createEmptyProject(), mediaLibrary: [source, target] };
    project.mediaMatchCandidates = [
      createMediaMatchCandidate(project, {
        id: "candidate",
        batchId: "batch",
        sourceMediaId: source.id,
        targetMediaId: target.id,
        proposal: {
          anchors: [],
          cutCandidates: [],
          confidence: 0.9,
          diagnostics: [],
          matchRange: {
            sourceStartMs: 0,
            sourceEndMs: 60_000,
            targetStartMs: 0,
            targetEndMs: 60_000,
            coverage: 1
          }
        }
      })
    ];
    expect(project.mediaMatchCandidates[0].state).toBe("blocked");
    expect(
      applyBilibiliMaterials(project, [prepared(1)]).project.mediaMatchCandidates[0].state
    ).toBe("pending");
  });
  it.each(["D:/new/P1.m4a", "C:/downloads/P1.m4a"])(
    "reconnects an owned reference at %s and upgrades unknown duration",
    (audioPath) => {
      const initial = prepared(1);
      initial.download.exactDuration = false;
      const project = applyBilibiliMaterials(createEmptyProject(), [initial]).project;
      project.mediaLibrary[0].connectionState = "needsReconnect";
      const retry = prepared(1);
      retry.download.audioPath = audioPath;
      const result = applyBilibiliMaterials(project, [retry]);
      expect(result.project.mediaLibrary[0]).toMatchObject({
        id: project.mediaLibrary[0].id,
        localPath: audioPath,
        connectionState: "connected",
        contentIdentity: null
      });
      expect(result.project.assets[0].acquisition?.exactDuration).toBe(true);
      expect(result.project.danmakuSourceBindings).toEqual(project.danmakuSourceBindings);
    }
  );
});
