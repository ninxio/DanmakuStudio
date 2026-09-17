import { readFileSync } from "node:fs";
import { mergeNativeXmlIntoAssets } from "../../application/importProjectMedia";
import { describe, expect, it, vi } from "vitest";
import type { DanmakuXmlSourceReceipt } from "../../domain/danmaku/types";
import {
  importNativeXmlPaths,
  normalizeNativeXmlPaths,
  type NativeXmlImportResponse
} from "./nativeXmlReceipt";

const receipt: DanmakuXmlSourceReceipt = {
  domain: "danmaku-xml-content-receipt-v1",
  version: 1,
  receiptId: `xmlr-sha256:${"1".repeat(64)}`,
  contentDigest: `sha256:${"2".repeat(64)}`,
  sizeBytes: 128,
  parserVersion: "bilibili-xml-native-v1",
  inventoryDigest: `sha256:${"3".repeat(64)}`,
  issuerKeyId: `install-sha256:${"4".repeat(32)}`,
  signatureAlgorithm: "hmac-sha256-v1",
  signature: "5".repeat(64)
};

describe("原生 XML 内容收据桥", () => {
  it("materializes bounded native metadata into the project without inventing provenance paths", async () => {
    const response = createResponse(["one.xml"]);
    const files = response.files.map((file) => ({
      ...file,
      metadataXml: readFileSync("fixtures/bilibili/media-metadata.xml", "utf8")
    }));
    const imported = await importNativeXmlPaths(["D:/moved/one.xml"], () => Promise.resolve({ files }));
    const asset = mergeNativeXmlIntoAssets(imported, []).assets[0];
    expect(asset.xmlMetadata?.timelineDurationMs).toBe(280123);
    expect(asset.sourcePath).toBe("D:/moved/one.xml");
    expect(asset.sourceReceipt).toEqual(receipt);
    expect(asset.acquisition).toBeUndefined();
  });

  it("浏览器环境对默认原生调用失败关闭", async () => {
    await expect(importNativeXmlPaths(["D:\\danmaku\\episode.xml"])).rejects.toThrow(
      "Tauri 桌面端"
    );
  });

  it("一次提交规范化后的多路径并返回权威解析库存", async () => {
    const invoker = vi.fn(() =>
      Promise.resolve(createResponse(["episode-1.xml", "episode-2.xml"]))
    );

    const result = await importNativeXmlPaths(
      [" D:\\danmaku\\episode-1.xml ", "D:\\danmaku\\episode-2.xml"],
      invoker
    );

    expect(invoker).toHaveBeenCalledTimes(1);
    expect(invoker).toHaveBeenCalledWith({
      paths: ["D:\\danmaku\\episode-1.xml", "D:\\danmaku\\episode-2.xml"]
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      fileName: "episode-1.xml",
      receipt,
      items: [{ originalIndex: 0, sourceTimeMs: 1000, text: "测试" }]
    });
  });

  it("响应数量或文件顺序不匹配时整批拒绝", async () => {
    await expect(
      importNativeXmlPaths(["D:\\danmaku\\one.xml", "D:\\danmaku\\two.xml"], () =>
        Promise.resolve(createResponse(["one.xml"]))
      )
    ).rejects.toThrow("结果数量不一致");

    await expect(
      importNativeXmlPaths(["D:\\danmaku\\one.xml"], () =>
        Promise.resolve(createResponse(["different.xml"]))
      )
    ).rejects.toThrow("与所选文件不一致");
  });

  it("伪造收据或不连续库存会失败关闭", async () => {
    const malformedReceipt = createResponse(["one.xml"]);
    malformedReceipt.files[0].receipt = {
      ...receipt,
      signature: "not-a-signature"
    };
    await expect(
      importNativeXmlPaths(["D:\\danmaku\\one.xml"], () => Promise.resolve(malformedReceipt))
    ).rejects.toThrow("收据无效");

    const discontinuous = createResponse(["one.xml"]);
    discontinuous.files[0].items[0].originalIndex = 2;
    await expect(
      importNativeXmlPaths(["D:\\danmaku\\one.xml"], () => Promise.resolve(discontinuous))
    ).rejects.toThrow("序号不连续");
  });

  it("只保留唯一、非空的 XML 路径", () => {
    expect(
      normalizeNativeXmlPaths([
        " D:\\danmaku\\one.xml ",
        "d:/DANMAKU/one.XML",
        "D:\\danmaku\\video.mkv",
        ""
      ])
    ).toEqual(["D:\\danmaku\\one.xml"]);
  });

  it("正式调用遇到重复路径或非 XML 文件时拒绝整批", async () => {
    const invoker = vi.fn(() => Promise.resolve(createResponse(["one.xml"])));

    await expect(
      importNativeXmlPaths(["D:\\danmaku\\one.xml", "D:\\danmaku\\video.mkv"], invoker)
    ).rejects.toThrow("拒绝整批导入");
    expect(invoker).not.toHaveBeenCalled();
  });
});

function createResponse(fileNames: string[]): NativeXmlImportResponse {
  return {
    files: fileNames.map((fileName) => ({
      fileName,
      receipt: { ...receipt },
      items: [
        {
          originalIndex: 0,
          sourceTimeMs: 1000,
          mode: 1,
          fontSize: 25,
          color: 16_777_215,
          timestamp: 0,
          pool: 0,
          userHash: "user",
          rowId: "row",
          text: "测试",
          rawPFields: ["1", "1", "25", "16777215", "0", "0", "user", "row"]
        }
      ],
      warnings: []
    }))
  };
}
