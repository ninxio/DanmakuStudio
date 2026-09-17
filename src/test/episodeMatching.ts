import { createEmptyProject } from "../domain/project/factory";
import { createLocalPathMediaReference } from "../domain/project/mediaLibrary";

/** Synthetic metadata family; no real media or credentials. Works in Node and browsers. */
export function createEpisodeMatchingProject(
  counts = [5, 5, 5, 5, 5, 5, 5, 5],
  season = 1,
  firstEpisode = 1
) {
  const project = createEmptyProject("分集匹配回归");
  let page = 0;
  counts.forEach((count, index) => {
    const episode = index + firstEpisode;
    project.mediaLibrary.push(
      createLocalPathMediaReference(
        "target-" + episode,
        "targetOriginal",
        "D:/fixture/Show S" + season + "E" + episode + ".mkv",
        60000
      )
    );
    for (let part = 1; part <= count; part++) {
      page++;
      const stem = "P" + String(page).padStart(3, "0") + " - " + episode + "." + part;
      const assetId = "asset-" + page;
      const sourceId = "source-" + page;
      project.mediaLibrary.push(
        createLocalPathMediaReference(
          sourceId,
          "bilibiliReference",
          "D:/fixture/" + stem + ".m4a",
          60000
        )
      );
      project.assets.push({
        id: assetId,
        name: stem,
        fileName: stem + ".xml",
        color: "#4488aa",
        importedAt: project.createdAt,
        warnings: [],
        sourceReceipt: null,
        items: [
          {
            id: "item-" + page,
            assetId,
            originalIndex: 0,
            sourceTimeMs: 1000,
            mode: 1,
            fontSize: 25,
            color: 16777215,
            timestamp: 0,
            pool: 0,
            userHash: "u",
            rowId: String(page),
            text: "test",
            rawPFields: ["1", "1", "25", "16777215", "0", "0", "u", String(page)],
            enabled: true
          }
        ],
        xmlMetadata: {
          version: 1,
          timelineDurationMs: 60000,
          sources: [
            {
              bvid: "BV1xx411c7mD",
              aid: 1,
              cid: page,
              page,
              pageCount: counts.reduce((a, b) => a + b, 0),
              title: "Example 第" + season + "季",
              part: episode + "." + part,
              durationMs: 60000,
              durationSource: "playurl.dash.duration",
              durationSourceUnit: "second",
              exactDuration: true
            }
          ]
        }
      });
      project.danmakuSourceBindings.push({
        id: "binding-" + page,
        assetId,
        sourceMediaId: sourceId,
        linkedAt: project.createdAt,
        updatedAt: project.createdAt
      });
    }
  });
  return project;
}
