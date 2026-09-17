import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import {
  createRelationDanmakuTracks,
  serializePreviewAss,
  visiblePreviewComments
} from "./danmakuTrack";

describe("preview comment tracks", () => {
  it("maps half-open common content but never invents a target time for uncertain comments", () => {
    const project = createEmptyProject();
    const asset = parseBilibiliXml(
      '<i><d p="1,1,25,16711680,0,0,u,1">共同内容</d><d p="2,5,25,255,0,0,u,2">未确定</d><d p="3,4,25,255,0,0,u,3">片外</d></i>',
      { fileName: "test.xml", assetId: "a" }
    );
    project.assets = [asset];
    project.danmakuSourceBindings = [
      { id: "b", assetId: "a", sourceMediaId: "reference", linkedAt: "", updatedAt: "" }
    ];
    const tracks = createRelationDanmakuTracks(
      project,
      {
        spans: [
          {
            kind: "matched",
            sourceStartMs: 0,
            sourceEndMs: 2000,
            targetStartMs: 4000,
            targetEndMs: 6000
          },
          {
            kind: "ambiguous",
            sourceStartMs: 2000,
            sourceEndMs: 3000,
            targetStartMs: 6000,
            targetEndMs: 7000
          }
        ]
      },
      "reference"
    );
    expect(tracks.source).toHaveLength(3);
    expect(tracks.target.map((event) => event.finalTimeMs)).toEqual([5000]);
    expect(tracks.uncertain).toBe(2);
    expect(visiblePreviewComments(tracks.target, 4999)).toEqual([]);
    expect(visiblePreviewComments(tracks.target, 5000)).toHaveLength(1);
    expect(serializePreviewAss(tracks.target)).toContain("0:00:05.00,0:00:13.00");
    expect(serializePreviewAss(tracks.target)).toContain("\\c&H0000ff&");
    expect(createRelationDanmakuTracks(project, { spans: [] }, "another").source).toEqual([]);
  });
  it("escapes ASS commands from XML text and obeys preview visibility", () => {
    const item = parseBilibiliXml('<i><d p="1,1,25,1,0,0,u,1">{\\pos(0,0)}text</d></i>', {
      fileName: "test.xml",
      assetId: "a"
    }).items[0];
    const event = { id: item.id, item, finalTimeMs: 1000, originalIndex: 0, enabled: true };
    const ass = serializePreviewAss([event], 0.5);
    expect(ass).toContain("｛＼pos(0,0)｝text");
    expect(ass).toContain("\\alpha&H80&");
    expect(serializePreviewAss([{ ...event, enabled: false }])).not.toContain("Dialogue:");
  });
});
