import {
  isXmlMediaMetadata,
  type XmlMediaMetadata,
  type XmlVideoSource
} from "../../domain/danmaku/xmlMediaMetadata";
import type { DanmakuAsset } from "../../domain/danmaku/types";

const DBX = "urn:danmakubox:xml:metadata:1";
const DTS = "urn:danmaku-studio:xml:metadata:1";
const MAX_METADATA_BYTES = 1024 * 1024;

/** Both native (bounded metadata-only fragment) and browser imports use this parser. */
export function readXmlMediaMetadata(doc: Document): XmlMediaMetadata | undefined {
  const root = doc.documentElement;
  const children = Array.from(root.children);
  const containers = children.filter(
    (e) => e.namespaceURI === DTS && e.localName === "metadata"
  );
  const direct = children.filter((e) => e.namespaceURI === DBX && e.localName === "meta");
  if (!containers.length && !direct.length) return undefined;
  if (containers.length > 1 || (containers.length && direct.length) || direct.length > 1)
    throw new Error("XML 媒体元数据存在重复或冲突。");
  if (
    [...containers, ...direct].reduce(
      (n, e) => n + new TextEncoder().encode(e.outerHTML).length,
      0
    ) > MAX_METADATA_BYTES
  )
    throw new Error("XML 媒体元数据超限。");
  const container = containers[0];
  if (container && container.getAttribute("schema-version") !== "1")
    throw new Error("不支持的 XML 媒体元数据版本。");
  const elements = container
    ? Array.from(container.children).filter(
        (e) => e.namespaceURI === DBX && e.localName === "meta"
      )
    : direct;
  if (elements.length > 1024) throw new Error("XML 来源元数据数量超限。");
  const sources = elements.map((e): XmlVideoSource => {
    if (e.getAttribute("schema-version") !== "1" || e.getAttribute("source") !== "bilibili")
      throw new Error("不支持的 B 站元数据版本或来源。");
    const attr = (key: string) => e.getAttribute(key) ?? "";
    const number = (key: string) => parseInteger(attr(key));
    if (!["true", "false"].includes(attr("exact-duration")))
      throw new Error("时长精度标记无效。");
    const audioNodes = Array.from(e.children).filter(
      (child) => child.namespaceURI === DBX && child.localName === "audio"
    );
    if (audioNodes.length > 1) throw new Error("音轨元数据重复。");
    const audio = audioNodes[0];
    if (audio && !["true", "false"].includes(audio.getAttribute("included") ?? ""))
      throw new Error("音轨标记无效。");
    return {
      bvid: attr("bvid"),
      aid: number("aid"),
      cid: number("cid"),
      page: number("page-index"),
      pageCount: e.hasAttribute("page-count") ? number("page-count") : null,
      title: attr("title"),
      part: attr("part"),
      durationMs: number("duration-ms"),
      durationSource: attr("duration-source"),
      durationSourceUnit: attr("duration-source-unit"),
      exactDuration: attr("exact-duration") === "true",
      ...(audio
        ? {
            audio: {
              included: audio.getAttribute("included") === "true",
              file: audio.getAttribute("file"),
              container: audio.getAttribute("container"),
              codec: audio.getAttribute("codec"),
              bandwidth: audio.hasAttribute("bandwidth")
                ? parseInteger(audio.getAttribute("bandwidth")!)
                : null
            }
          }
        : {})
    };
  });
  const duration = container?.getAttribute("duration-ms");
  const metadata: XmlMediaMetadata = {
    version: 1,
    timelineDurationMs: container
      ? duration === null
        ? null
        : parseInteger(duration ?? "")
      : sources[0]?.exactDuration
        ? sources[0].durationMs
        : null,
    sources
  };
  if (!isXmlMediaMetadata(metadata)) throw new Error("XML 媒体元数据字段无效。");
  return metadata;
}

export function parseNativeXmlMetadata(fragment: string): XmlMediaMetadata | undefined {
  if (
    new TextEncoder().encode(fragment).length > MAX_METADATA_BYTES ||
    /<!DOCTYPE/i.test(fragment)
  )
    throw new Error("XML 媒体元数据超限或包含不支持的声明。");
  const doc = new DOMParser().parseFromString(fragment, "application/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error("XML 媒体元数据结构无效。");
  return readXmlMediaMetadata(doc);
}

export function collectExportMetadata(
  assets: readonly DanmakuAsset[],
  assetIds: Iterable<string>,
  timelineDurationMs: number | null = null
): XmlMediaMetadata {
  const ids = new Set(assetIds);
  const sources = new Map<string, XmlVideoSource>();
  for (const asset of assets) {
    if (!ids.has(asset.id)) continue;
    let assetSources = asset.xmlMetadata?.sources;
    if (!assetSources && asset.acquisition) {
      const a = asset.acquisition;
      // Older projects retained IDs and duration only; never invent the missing title or count.
      assetSources = [
        {
          bvid: a.bvid,
          aid: a.aid,
          cid: a.cid,
          page: a.page,
          pageCount: null,
          title: "",
          part: "",
          durationMs: a.durationMs,
          exactDuration: a.exactDuration,
          durationSource: "unknown",
          durationSourceUnit: "unknown"
        }
      ];
    }
    for (const source of assetSources ?? []) sources.set(JSON.stringify(source), source);
  }
  return { version: 1, timelineDurationMs, sources: [...sources.values()] };
}

export function serializeXmlMediaMetadata(metadata?: XmlMediaMetadata): string[] {
  if (!metadata) return [];
  if (!isXmlMediaMetadata(metadata)) throw new Error("无法导出无效的 XML 媒体元数据。");
  const duration =
    metadata.timelineDurationMs === null ? "" : ` duration-ms="${metadata.timelineDurationMs}"`;
  const lines = [`  <dts:metadata xmlns:dts="${DTS}" schema-version="1"${duration}>`];
  for (const s of metadata.sources) {
    const attributes = {
      "xmlns:dbx": DBX,
      "schema-version": "1",
      source: "bilibili",
      bvid: s.bvid,
      aid: s.aid,
      cid: s.cid,
      "page-index": s.page,
      "page-count": s.pageCount,
      title: s.title,
      part: s.part,
      "duration-ms": s.durationMs,
      "duration-source": s.durationSource,
      "duration-source-unit": s.durationSourceUnit,
      "exact-duration": s.exactDuration
    };
    const opening = `    <dbx:meta ${Object.entries(attributes)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}="${escape(String(v))}"`)
      .join(" ")}`;
    if (s.audio) {
      const audio = Object.entries(s.audio)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}="${escape(String(v))}"`)
        .join(" ");
      lines.push(`${opening}>`, `      <dbx:audio ${audio} />`, "    </dbx:meta>");
    } else lines.push(`${opening} />`);
  }
  lines.push("  </dts:metadata>");
  if (new TextEncoder().encode(lines.join("\n")).length > MAX_METADATA_BYTES - 1024)
    throw new Error("导出媒体元数据超出大小限制。");
  return lines;
}

function parseInteger(value: string): number {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : Number.NaN;
}
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}
