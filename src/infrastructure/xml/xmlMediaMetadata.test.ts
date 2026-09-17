import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBilibiliXml, serializeBilibiliXml } from "./bilibiliXml";
import { collectExportMetadata, parseNativeXmlMetadata } from "./xmlMediaMetadata";
import { createEmptyProject } from "../../domain/project/factory";
import { parseProjectJson, serializeProject } from "../../domain/project/schema";
import { getKnownBilibiliDuration } from "../../domain/danmaku/bilibiliAcquisition";
import { appendUnplacedXmlAssets } from "../../domain/timeline/xmlTimeline";
import { prepareExportDraft } from "../../application/exportProjectCommands";
import { analyzeMediaFamily } from "../../domain/project/mediaFamily";

const xml = readFileSync("fixtures/bilibili/media-metadata.xml", "utf8");
const parse = (content = xml) => parseBilibiliXml(content, { fileName: "renamed.xml" });

describe("XML metadata round trip", () => {
  it("bounds UTF-8 bytes before export so a multibyte result remains reimportable", () => {
    const source = parse().xmlMetadata!.sources[0];
    const metadata = {
      version: 1 as const,
      timelineDurationMs: null,
      sources: Array.from({ length: 100 }, (_, index) => ({
        ...source,
        cid: index + 1,
        title: "中".repeat(4000)
      }))
    };
    expect(() => serializeBilibiliXml([], metadata)).toThrow("大小限制");
  });

  it("retains the known subset from older downloaded projects without inventing metadata", () => {
    const asset = parse('<i><d p="1,1,25,1,0,0,u,1">old</d></i>');
    asset.acquisition = {
      kind: "bilibili",
      bvid: "BV1xx411c7mD",
      aid: 170001,
      cid: 123,
      page: 3,
      durationMs: 2000,
      exactDuration: true,
      xmlPath: "C:/old/source.xml"
    };
    const project = appendUnplacedXmlAssets({ ...createEmptyProject(), assets: [asset] });
    const output = parse(prepareExportDraft(project).exportDraft!.xml);
    expect(getKnownBilibiliDuration(output)).toBe(2000);
    expect(output.xmlMetadata?.sources[0]).toMatchObject({
      page: 3,
      pageCount: null,
      durationSource: "unknown",
      title: "",
      part: ""
    });
    expect(JSON.stringify(output.xmlMetadata)).not.toContain("C:/old");
  });

  it("escapes metadata attributes and round trips line breaks without changing them", () => {
    const asset = parse();
    asset.xmlMetadata!.sources[0].title = 'quotes " & < >\nnext\tline';
    const metadata = collectExportMetadata([asset], [asset.id], 280123);
    expect(parse(serializeBilibiliXml([], metadata).xml).xmlMetadata).toEqual(metadata);
  });
  it("restores original metadata, exact duration and name after moving or renaming XML", () => {
    const asset = parse();
    expect(getKnownBilibiliDuration(asset)).toBe(280123);
    expect(asset.xmlMetadata?.sources[0]).toMatchObject({
      title: "示例 & 剧集",
      page: 1,
      pageCount: 8,
      audio: { file: "reference.m4a", bandwidth: 192000 }
    });
    const project = { ...createEmptyProject(), assets: [asset] };
    const restored = parseProjectJson(serializeProject(project));
    expect(restored.assets[0].xmlMetadata).toEqual(asset.xmlMetadata);
    const family = analyzeMediaFamily(restored);
    expect(family.files[0].durationMs).toBe(280123);
    expect(family.titleCandidates.some((c) => c.title === "示例 & 剧集")).toBe(true);
    expect(parseNativeXmlMetadata(xml)).toEqual(asset.xmlMetadata);
  });

  it("keeps source duration separate from trimmed output and survives a second export", () => {
    const asset = parse();
    let project = appendUnplacedXmlAssets({ ...createEmptyProject(), assets: [asset] });
    project = { ...project, clips: project.clips.map((c) => ({ ...c, sourceOutMs: 2000 })) };
    const draft = prepareExportDraft(project).exportDraft;
    expect(draft?.validation.ok).toBe(true);
    const output = parse(draft!.xml);
    expect(output.items[0].sourceTimeMs).toBe(1250);
    expect(getKnownBilibiliDuration(output)).toBe(2000);
    expect(output.xmlMetadata?.sources[0].durationMs).toBe(280123);
    const again = prepareExportDraft(
      appendUnplacedXmlAssets({ ...createEmptyProject(), assets: [output] })
    );
    expect(parse(again.exportDraft!.xml).xmlMetadata).toEqual(output.xmlMetadata);
  });

  it("preserves multiple sources without assigning the first source duration to merged XML", () => {
    const a = parse();
    const b = parse(xml.replace('cid="123"', 'cid="124"'));
    const metadata = collectExportMetadata([a, b], [a.id, b.id]);
    const result = parse(serializeBilibiliXml([], metadata).xml);
    expect(result.xmlMetadata?.sources).toHaveLength(2);
    expect(getKnownBilibiliDuration(result)).toBeNull();
    expect(collectExportMetadata([a], []).sources).toEqual([]);
  });

  it("does not promote approximate durations or last-comment positions", () => {
    const approximate = parse(
      xml
        .replace('exact-duration="true"', 'exact-duration="false"')
        .replace("playurl.timelength", "view.pages.duration")
        .replace("millisecond", "second")
    );
    expect(getKnownBilibiliDuration(approximate)).toBeNull();
    expect(approximate.xmlMetadata?.sources[0].durationMs).toBe(280123);
    const plain = parse('<i><d p="9,1,25,1,0,0,u,1">普通</d></i>');
    expect(plain.xmlMetadata).toBeUndefined();
    const result = prepareExportDraft(
      appendUnplacedXmlAssets({ ...createEmptyProject(), assets: [plain] })
    );
    expect(getKnownBilibiliDuration(parse(result.exportDraft!.xml))).toBeNull();
  });

  it.each([
    xml.replace('duration-ms="280123"', 'duration-ms="9007199254740992"'),
    xml.replace('exact-duration="true"', 'exact-duration="maybe"'),
    xml.replace('page-index="1"', 'page-index="9"'),
    xml.replace("</i>", xml.slice(xml.indexOf("  <dbx:meta"), xml.indexOf("  <d p=")) + "</i>")
  ])("keeps comments but warns about invalid or conflicting metadata", (content) => {
    const asset = parse(content);
    expect(asset.items).toHaveLength(1);
    expect(asset.xmlMetadata).toBeUndefined();
    expect(asset.warnings.some((w) => w.message.includes("元数据"))).toBe(true);
  });

  it("resolves namespace aliases and does not accept a forged namespace", () => {
    expect(parse(xml.replace(/dbx/g, "media")).xmlMetadata).toEqual(parse().xmlMetadata);
    expect(
      parse(xml.replace("urn:danmakubox:xml:metadata:1", "urn:fake")).xmlMetadata
    ).toBeUndefined();
  });
});
