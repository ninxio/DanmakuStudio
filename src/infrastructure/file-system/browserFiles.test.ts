import { describe, expect, it, vi } from "vitest";
import {
  createStoredZip,
  createStoredZipEntries,
  downloadTextFile,
  downloadTextFiles,
  readTextFile,
  sanitizeDownloadFileName
} from "./browserFiles";

describe("浏览器文件导出", () => {
  it("把多份 XML 打包成包含全部条目的 ZIP", async () => {
    const zip = createStoredZip([
      { fileName: "S01E01.xml", content: "<i><d p=\"0,1,25,16777215,0,0,u,r\">一</d></i>" },
      { fileName: "S01E02.xml", content: "<i><d p=\"1,1,25,16777215,0,0,u,r\">二</d></i>" }
    ]);

    expect(zip.type).toBe("application/zip");
    await expect(readCentralDirectoryNames(zip)).resolves.toEqual(["S01E01.xml", "S01E02.xml"]);
  });

  it("打包时清理非法路径字符并避免重名覆盖", async () => {
    const zip = createStoredZip([
      { fileName: "S01/E01.xml", content: "<i />" },
      { fileName: "S01/E01.xml", content: "<i />" }
    ]);

    await expect(readCentralDirectoryNames(zip)).resolves.toEqual(["S01_E01.xml", "S01_E01 (2).xml"]);
  });

  it("链式清理碰撞分配全局唯一且二次规范化保持幂等", async () => {
    const files = [
      { fileName: "_CON.xml", content: "一" },
      { fileName: "CON.xml", content: "二" },
      { fileName: "_CON (2).xml", content: "三" }
    ];
    const firstPass = createStoredZipEntries(files);
    const secondPass = createStoredZipEntries(firstPass);

    expect(firstPass.map((file) => file.fileName)).toEqual([
      "_CON.xml",
      "_CON (2).xml",
      "_CON (2) (2).xml"
    ]);
    expect(secondPass).toEqual(firstPass);
    await expect(readCentralDirectoryNames(createStoredZip(firstPass))).resolves.toEqual(
      firstPass.map((file) => file.fileName)
    );
  });

  it("按 Windows 大小写不敏感语义隔离清理后的文件名", async () => {
    const allocated = createStoredZipEntries([
      { fileName: "CON.xml", content: "一" },
      { fileName: "_con.xml", content: "二" }
    ]);

    expect(allocated.map((file) => file.fileName)).toEqual(["_CON.xml", "_con (2).xml"]);
    await expect(readCentralDirectoryNames(createStoredZip(allocated))).resolves.toEqual(
      allocated.map((file) => file.fileName)
    );
  });

  it("打包超长重名条目时保留去重后缀并限制长度", async () => {
    const longName = `${"超长分集名".repeat(50)}.xml`;
    const zip = createStoredZip([
      { fileName: longName, content: "<i />" },
      { fileName: longName, content: "<i />" }
    ]);

    const names = await readCentralDirectoryNames(zip);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((name) => Array.from(name).length <= 180)).toBe(true);
    expect(names[0].endsWith(".xml")).toBe(true);
    expect(names[1].endsWith(" (2).xml")).toBe(true);
  });

  it("下载文件名会清理路径字符和 Windows 保留名", () => {
    expect(sanitizeDownloadFileName(" 健康/报告:项目?.txt ")).toBe("健康_报告_项目_.txt");
    expect(sanitizeDownloadFileName("CON.xml")).toBe("_CON.xml");
    expect(sanitizeDownloadFileName("   ", "export.xml")).toBe("export.xml");
  });

  it("下载文件名会限制长度并保留短扩展名", () => {
    const result = sanitizeDownloadFileName(`${"超长项目名".repeat(50)}.xml`);

    expect(Array.from(result).length).toBeLessThanOrEqual(180);
    expect(result).toMatch(/^超长项目名/);
    expect(result.endsWith(".xml")).toBe(true);
  });

  it("Windows 保留名加前缀后仍会限制长度", () => {
    const result = sanitizeDownloadFileName(`CON.${"x".repeat(260)}`);

    expect(Array.from(result).length).toBeLessThanOrEqual(180);
    expect(result.startsWith("_CON.")).toBe(true);
  });

  it("读取文本文件失败时包含文件名", async () => {
    const file = new File([""], "broken.xml", { type: "application/xml" });
    Object.defineProperty(file, "text", {
      configurable: true,
      value: vi.fn<() => Promise<string>>(() => Promise.reject(new Error("读取被拒绝")))
    });

    await expect(readTextFile(file)).rejects.toThrow("读取文件 broken.xml 失败：读取被拒绝");
  });

  it("单文件下载返回实际使用的文件名", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:text-download");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      const fileName = downloadTextFile("报告/项目?.txt", "内容");

      expect(fileName).toBe("报告_项目_.txt");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("单文件下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("报告_项目_.txt");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:text-download");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("单文件批量下载返回实际使用的文件名", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:text-files-download");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      const result = downloadTextFiles([{ fileName: "单集/导出?.xml", content: "<i />" }], "application/xml;charset=utf-8");

      expect(result).toEqual({ fileCount: 1, archiveFileName: null, downloadedFileName: "单集_导出_.xml" });
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("单文件批量下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("单集_导出_.xml");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:text-files-download");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("多文件下载支持自定义压缩包名并返回实际下载名", () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:danmaku-archive");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      const result = downloadTextFiles(
        [
          { fileName: "S01E01.xml", content: "<i />" },
          { fileName: "S01E02.xml", content: "<i />" }
        ],
        "application/xml;charset=utf-8",
        "合集/导出:项目.zip"
      );

      expect(result).toEqual({
        fileCount: 2,
        archiveFileName: "合集_导出_项目.zip",
        downloadedFileName: "合集_导出_项目.zip"
      });
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("多文件下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("合集_导出_项目.zip");
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:danmaku-archive");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });
});

async function readCentralDirectoryNames(zip: Blob): Promise<string[]> {
  const bytes = new Uint8Array(await readBlobAsArrayBuffer(zip));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const names: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength - 4) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    names.push(decoder.decode(bytes.slice(nameStart, nameEnd)));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  const modernBlob = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof modernBlob.arrayBuffer === "function") {
    return modernBlob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Blob 读取结果不是 ArrayBuffer。"));
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsArrayBuffer(blob);
  });
}
