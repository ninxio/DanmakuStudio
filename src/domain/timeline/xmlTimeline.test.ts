import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import { parseBilibiliXml, serializeBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { resolveProjectDanmakuEvents } from "./mapping";
import { appendUnplacedXmlAssets, inspectXmlTimeline } from "./xmlTimeline";

const asset = (id: string, seconds = 17.25) =>
  parseBilibiliXml(`<i><d p="${seconds},1,25,16777215,0,0,u,r">${id}</d></i>`, {
    assetId: id,
    fileName: `${id}.xml`
  });

describe("XML timeline intake", () => {
  it("round-trips delayed comments at their original timestamps", () => {
    const original = { ...createEmptyProject(), assets: [asset("first")] };
    const project = appendUnplacedXmlAssets(original, () => "clip");
    const events = resolveProjectDanmakuEvents(project);
    const output = serializeBilibiliXml(
      events.map(({ item, finalTimeMs }) => ({ item, finalTimeMs }))
    );
    expect(
      parseBilibiliXml(output.xml, { assetId: "output", fileName: "out.xml" }).items[0]
        .sourceTimeMs
    ).toBe(17_250);
    expect(original.clips).toEqual([]);
    expect(project.assets).toBe(original.assets);
    expect(appendUnplacedXmlAssets(project)).toBe(project);
  });

  it("preserves split, disabled and shifted clips and appends each new resource once", () => {
    const first = asset("first");
    const base = {
      id: "a",
      name: "first",
      assetId: first.id,
      sourceInMs: 0,
      sourceOutMs: 10_000,
      timelineStartMs: 4000,
      localOffsetMs: 500,
      enabled: false
    };
    const split = {
      ...base,
      id: "b",
      sourceInMs: 10_000,
      sourceOutMs: 20_000,
      timelineStartMs: 14_000
    };
    const original = {
      ...createEmptyProject(),
      assets: [first, asset("second"), asset("third", 1)],
      clips: [base, split],
      globalOffsetMs: 300,
      disabledItemIds: [first.items[0].id]
    };
    const project = appendUnplacedXmlAssets(original);
    expect(project.clips.slice(0, 2)).toEqual([base, split]);
    expect(project.clips.slice(2).map((clip) => clip.timelineStartMs)).toEqual([
      24_500, 41_751
    ]);
    expect(project.disabledItemIds).toBe(original.disabledItemIds);
    expect(project.globalOffsetMs).toBe(300);
    expect(inspectXmlTimeline(project)).toMatchObject({
      assetCount: 3,
      placedAssetCount: 3,
      disabledAssetCount: 1,
      unplacedAssets: []
    });
  });

  it("rejects unsafe time ranges and refuses the media-alignment path", () => {
    const original = { ...createEmptyProject(), assets: [asset("first")] };
    expect(() =>
      appendUnplacedXmlAssets({
        ...original,
        media: {
          id: "media",
          name: "media",
          fileName: "media.mp4",
          objectUrl: null,
          durationMs: null
        }
      })
    ).toThrow("视频对齐项目");
    expect(() =>
      appendUnplacedXmlAssets({
        ...original,
        clips: [
          {
            id: "old",
            assetId: "old",
            name: "old",
            sourceInMs: 0,
            sourceOutMs: 10,
            timelineStartMs: Number.MAX_SAFE_INTEGER,
            localOffsetMs: 0,
            enabled: false
          }
        ]
      })
    ).toThrow("安全毫秒范围");
  });
});
