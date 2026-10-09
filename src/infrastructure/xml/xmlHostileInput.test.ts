/**
 * Hostile-input regression tests for the renderer-side XML import/export path.
 *
 * Scope and limits (see docs/THREAT_MODEL.md):
 * - Desktop XML import is parsed natively in Rust (src-tauri/src/xml_import_receipt.rs),
 *   which rejects DTD/DOCTYPE and enforces size/depth limits. Those limits have their own
 *   Rust tests. This file covers the renderer-side DOMParser path (`parseBilibiliXml`,
 *   used for browser-mode imports and for `validateExportedXml`), the native metadata
 *   fragment parser, the native-response validator and the XML/ASS serializers.
 * - These tests run under jsdom (saxes-based XML parser). They pin the application's
 *   handling of hostile input; they do not prove how WebView2/Chromium's XML parser
 *   behaves on the same bytes.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DanmakuItem, DanmakuXmlSourceReceipt } from "../../domain/danmaku/types";
import { serializePreviewAss, type PreviewComment } from "../../domain/preview/danmakuTrack";
import { parseBilibiliXml, serializeBilibiliXml, validateExportedXml } from "./bilibiliXml";
import { importNativeXmlPaths, type NativeXmlImportResponse } from "./nativeXmlReceipt";
import { parseNativeXmlMetadata } from "./xmlMediaMetadata";

const P = "1.5,1,25,16777215,1700000000,0,abcd1234,42";

function item(text: string, overrides: Partial<DanmakuItem> = {}): DanmakuItem {
  return {
    id: "asset_item_0",
    assetId: "asset",
    originalIndex: 0,
    sourceTimeMs: 1500,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 1_700_000_000,
    pool: 0,
    userHash: "abcd1234",
    rowId: "42",
    text,
    rawPFields: P.split(","),
    enabled: true,
    ...overrides
  };
}

function roundTrip(texts: readonly string[]) {
  const exported = serializeBilibiliXml(
    texts.map((text, index) => ({
      item: item(text, { id: `asset_item_${index}`, originalIndex: index }),
      finalTimeMs: 1000 + index
    }))
  );
  return { xml: exported.xml, asset: parseBilibiliXml(exported.xml, { fileName: "rt.xml" }) };
}

const parseErrors = (asset: ReturnType<typeof parseBilibiliXml>) =>
  asset.warnings.filter((warning) => warning.severity === "error");

describe("hostile XML import: DTD, entities and external references", () => {
  let server: Server;
  let origin = "";
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/xml-dtd" });
      response.end('<!ENTITY leaked "LEAKED_FROM_NETWORK">');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not exponentially expand nested internal entities (billion laughs)", () => {
    const levels = ['<!ENTITY l0 "lol">'];
    for (let level = 1; level <= 9; level += 1) {
      levels.push(`<!ENTITY l${level} "${`&l${level - 1};`.repeat(10)}">`);
    }
    const xml = `<?xml version="1.0"?><!DOCTYPE i [${levels.join("")}]><i><d p="${P}">&l9;</d></i>`;

    const started = performance.now();
    const asset = parseBilibiliXml(xml, { fileName: "lol.xml" });
    const elapsed = performance.now() - started;

    // A full expansion would be 3 * 10^9 characters. The current parser substitutes the
    // replacement text once without recursing, so the result stays tiny and fast.
    const totalText = asset.items.reduce((sum, entry) => sum + entry.text.length, 0);
    expect(totalText).toBeLessThan(1_000);
    expect(asset.items.every((entry) => !entry.text.includes("lol".repeat(10)))).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("never resolves an external general entity (XXE) to file or network content", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
    const targets = ["file:///C:/Windows/win.ini", "file:///etc/passwd", `${origin}/xxe`];

    for (const target of targets) {
      const xml = `<?xml version="1.0"?><!DOCTYPE i [<!ENTITY x SYSTEM "${target}">]><i><d p="${P}">&x;</d></i>`;
      const asset = parseBilibiliXml(xml, { fileName: "xxe.xml" });
      // Current behavior: the reference is treated as undefined and the document fails to
      // parse; no danmaku is produced and an error-severity warning is reported.
      expect(asset.items).toHaveLength(0);
      expect(parseErrors(asset)).toHaveLength(1);
      expect(JSON.stringify(asset)).not.toMatch(/\[fonts\]|root:|LEAKED_FROM_NETWORK/);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
  });

  it("does not fetch an external DTD or parameter entity referenced by DOCTYPE SYSTEM", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const external = `<?xml version="1.0"?><!DOCTYPE i SYSTEM "${origin}/evil.dtd"><i><d p="${P}">plain</d></i>`;
    const parameter = `<?xml version="1.0"?><!DOCTYPE i [<!ENTITY % ext SYSTEM "${origin}/param.dtd"> %ext;]><i><d p="${P}">&leaked;</d></i>`;

    const externalAsset = parseBilibiliXml(external, { fileName: "dtd.xml" });
    // The DOCTYPE is ignored and the comment text is read verbatim.
    expect(externalAsset.items.map((entry) => entry.text)).toEqual(["plain"]);

    const parameterAsset = parseBilibiliXml(parameter, { fileName: "param.xml" });
    expect(JSON.stringify(parameterAsset)).not.toContain("LEAKED_FROM_NETWORK");
    expect(parseErrors(parameterAsset).length).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hits).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects every DOCTYPE variant in a native metadata fragment before it reaches DOMParser", () => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    for (const doctype of ["<!DOCTYPE i>", "<!doctype i>", "<!DoCtYpE i SYSTEM 'x.dtd'>"]) {
      expect(() => parseNativeXmlMetadata(`${doctype}<i/>`)).toThrow(/不支持的声明/);
    }
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects an oversized native metadata fragment before parsing", () => {
    const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
    const fragment = `<i>${"x".repeat(1024 * 1024 + 1)}</i>`;
    expect(() => parseNativeXmlMetadata(fragment)).toThrow(/超限/);
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("hostile XML import: malformed, oversized and unusual input", () => {
  it.each([
    ["empty document", ""],
    ["non-XML text", "not xml at all"],
    ["unclosed element", `<i><d p="${P}">a</i>`],
    ["duplicate attribute", `<i><d p="${P}" p="${P}">a</d></i>`],
    ["truncated file", `<?xml version="1.0"?><i><d p="${P}">trunc`],
    ["undeclared entity", `<i><d p="${P}">&nbsp;</d></i>`]
  ])("reports %s as an error warning without throwing", (_label, xml) => {
    const asset = parseBilibiliXml(xml, { fileName: "bad.xml" });
    expect(parseErrors(asset)).toHaveLength(1);
    expect(parseErrors(asset)[0].rawSnippet.length).toBeLessThanOrEqual(240);
  });

  it("rejects XML 1.0 control characters, raw or as character references", () => {
    for (const body of ["a\u0001b", "a&#1;b", "a&#x1B;b", "a\u000Bb", "a&#0;b"]) {
      const asset = parseBilibiliXml(`<i><d p="${P}">${body}</d></i>`, { fileName: "c.xml" });
      expect(parseErrors(asset)).toHaveLength(1);
      expect(asset.items).toHaveLength(0);
    }
  });

  it("keeps allowed whitespace controls and non-BMP text intact", () => {
    const asset = parseBilibiliXml(`<i><d p="${P}">tab\there&#x1F600;\u{20000}</d></i>`, {
      fileName: "ok.xml"
    });
    expect(parseErrors(asset)).toHaveLength(0);
    expect(asset.items[0].text).toBe("tab\there\u{1F600}\u{20000}");
  });

  it("survives deeply nested markup inside a comment node", () => {
    const depth = 1_500;
    const xml = `<i><d p="${P}">${"<x>".repeat(depth)}deep${"</x>".repeat(depth)}</d></i>`;
    const asset = parseBilibiliXml(xml, { fileName: "deep.xml" });
    expect(parseErrors(asset)).toHaveLength(0);
    expect(asset.items).toHaveLength(1);
    expect(asset.items[0].text).toBe("deep");
  });

  it("handles a very long comment and a large comment count", () => {
    const huge = "弹".repeat(256 * 1024);
    const many = Array.from(
      { length: 5_000 },
      (_, i) => `<d p="${i},1,25,1,0,0,0,${i}">c${i}</d>`
    );
    const asset = parseBilibiliXml(`<i><d p="${P}">${huge}</d>${many.join("")}</i>`, {
      fileName: "big.xml"
    });
    expect(parseErrors(asset)).toHaveLength(0);
    expect(asset.items).toHaveLength(5_001);
    expect(asset.items[0].text.length).toBe(huge.length);
  });

  it("caps warning snippets for oversized malformed nodes", () => {
    const longP = "x".repeat(100_000);
    const asset = parseBilibiliXml(`<i><d p="${longP}">t</d></i>`, { fileName: "p.xml" });
    expect(asset.items).toHaveLength(1);
    expect(asset.warnings.length).toBeGreaterThan(0);
    expect(asset.warnings.every((warning) => warning.rawSnippet.length <= 240)).toBe(true);
  });
});

describe("hostile XML import: native response validation", () => {
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

  function response(overrides: Record<string, unknown> = {}): NativeXmlImportResponse {
    return {
      files: [
        {
          fileName: "a.xml",
          receipt,
          items: [
            {
              originalIndex: 0,
              sourceTimeMs: 0,
              mode: 1,
              fontSize: 25,
              color: 1,
              timestamp: 0,
              pool: 0,
              userHash: null,
              rowId: null,
              text: "t",
              rawPFields: ["0"]
            }
          ],
          warnings: [],
          ...overrides
        }
      ]
    };
  }

  it("refuses non-XML, empty or duplicate paths before invoking the native command", async () => {
    const invoker = vi.fn(() => Promise.resolve(response()));
    for (const paths of [["C:\\a.xml.exe"], ["  "], ["C:\\a.xml", "c:/A.XML"]]) {
      await expect(importNativeXmlPaths(paths, invoker)).rejects.toThrow();
    }
    expect(invoker).not.toHaveBeenCalled();
  });

  it("rejects a response whose file name does not match the selected path", async () => {
    const invoker = vi.fn(() => Promise.resolve(response({ fileName: "..\\..\\other.xml" })));
    await expect(importNativeXmlPaths(["C:\\x\\a.xml"], invoker)).rejects.toThrow(/不一致/);
  });

  it("downgrades a DOCTYPE-bearing metadata fragment to a warning", async () => {
    const metadataXml = '<!DOCTYPE i [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]><i/>';
    const invoker = vi.fn(() => Promise.resolve(response({ metadataXml })));
    const [file] = await importNativeXmlPaths(["C:\\x\\a.xml"], invoker);
    expect(file.xmlMetadata).toBeUndefined();
    expect(file.warnings.map((warning) => warning.message).join()).toMatch(
      /已忽略无效媒体元数据/
    );
  });
});

describe("export escaping of injection-looking comment text", () => {
  const payloads = [
    `</d><d p="0,1,25,16777215,0,0,0,0">injected</d>`,
    `]]><![CDATA[x`,
    `<!-- comment --><?pi target?>`,
    `<!DOCTYPE i [<!ENTITY x "y">]>&x;`,
    `&amp; &lt; &#60; &#x3C; literal entities`,
    `"double" 'single' > < &`,
    `<script>alert(1)</script><img src=x onerror=alert(1)>`,
    `</i><i>second root`
  ];

  it("round-trips every payload as exactly one literal comment", () => {
    const { xml, asset } = roundTrip(payloads);
    expect(parseErrors(asset)).toHaveLength(0);
    expect(asset.items.map((entry) => entry.text)).toEqual(payloads);
    expect(xml.match(/<d /g)).toHaveLength(payloads.length);
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<!DOCTYPE");
    expect(validateExportedXml(xml)).toMatchObject({ ok: true, count: payloads.length });
  });

  it("escapes attribute delimiters carried in raw p fields", () => {
    const hostile = item("t", {
      rawPFields: ['1"', "1><d p='0'", "25", "1", "0", "0", "&x;", "1"]
    });
    const exported = serializeBilibiliXml([{ item: hostile, finalTimeMs: 0 }]);
    const asset = parseBilibiliXml(exported.xml, { fileName: "p.xml" });
    expect(parseErrors(asset)).toHaveLength(0);
    expect(asset.items).toHaveLength(1);
    // Field 0 is always rewritten from the resolved time; the rest round-trip literally.
    expect(asset.items[0].rawPFields.slice(1)).toEqual(hostile.rawPFields.slice(1));
  });

  it("fails closed when text contains characters XML 1.0 cannot represent", () => {
    // Native import rejects these characters, but edited or acquired text could still carry
    // them. Current behavior: the serializer emits them verbatim and export validation
    // refuses the result, so no malformed file is reported as valid.
    for (const text of ["bell\u0007", "nul\u0000", "nonchar\uFFFF", "lone\uD800surrogate"]) {
      const exported = serializeBilibiliXml([{ item: item(text), finalTimeMs: 0 }]);
      expect(validateExportedXml(exported.xml).ok).toBe(false);
    }
  });

  it("normalizes a carriage return to a line feed on re-import (documented fidelity limit)", () => {
    const { asset } = roundTrip(["a\r\nb\rc"]);
    expect(asset.items[0].text).toBe("a\nb\nc");
  });

  it("neutralizes ASS override blocks, line breaks and section headers in preview subtitles", () => {
    const texts = [
      "{\\pos(0,0)\\c&H0000FF&\\fs200}takeover",
      "line\\Nbreak\\h\\n",
      "row\nDialogue: 0,0:00:00.00,9:59:59.99,Danmaku,,0,0,0,,{\\fs999}spam",
      "x\r\n[Script Info]\r\nPlayResX: 1\n[V4+ Styles]",
      "}{"
    ];
    const events: PreviewComment[] = texts.map((text, index) => ({
      item: item(text, { id: `i${index}`, originalIndex: index }),
      finalTimeMs: 1000 * index,
      enabled: true
    })) as unknown as PreviewComment[];

    const ass = serializePreviewAss(events);
    const dialogueLines = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
    expect(dialogueLines).toHaveLength(texts.length);
    expect(ass.match(/^\[Script Info\]$/gm)).toHaveLength(1);
    expect(ass.match(/^\[Events\]$/gm)).toHaveLength(1);
    for (const line of dialogueLines) {
      // Exactly one generated override block per line; user text cannot open another.
      expect(line.match(/\{/g)).toHaveLength(1);
      expect(line.match(/\}/g)).toHaveLength(1);
      const userText = line.slice(line.indexOf("}") + 1);
      expect(userText).not.toMatch(/[\\{}\r\n]/);
    }
    expect(dialogueLines[0]).toContain("｛＼pos(0,0)＼c&H0000FF&＼fs200｝takeover");
  });
});
