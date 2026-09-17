import { readFileSync } from "node:fs";
import type structureShape from "../../fixtures/alignment/many-to-one-filled-parts-structure-v1.json";
const structure = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/alignment/many-to-one-filled-parts-structure-v1.json",
      import.meta.url
    ),
    "utf8"
  )
) as typeof structureShape;
import { createEmptyProject } from "../../src/domain/project/factory";
import { createLocalPathMediaReference } from "../../src/domain/project/mediaLibrary";
import { serializeProject, parseProjectJson } from "../../src/domain/project/schema";
import {
  createMediaMatchCandidate,
  upsertMediaMatchCandidate
} from "../../src/domain/alignment/mediaMatching";
import {
  normalizeLegacyUnverifiedTimeMapSpanEvidence,
  type TimeMapSpan
} from "../../src/domain/alignment/timeMap";
import type { AlignmentProposal } from "../../src/domain/alignment/types";

/** Structural UI replay only: no analysis results, accepted maps, or native receipts. */
export function createDenseReviewProjectJson(): string {
  const timestamp = "2026-09-08T00:00:00.000Z";
  const reason = "仅用于界面回放的结构夹具，未运行媒体分析，不具备验证凭据。";
  let project = createEmptyProject("14P 密集结构回放 · 4200 条演示弹幕");
  project.id = "ui-structure-replay-14p";
  project.createdAt = project.updatedAt = timestamp;
  const targetDuration =
    Math.max(
      ...structure.parts.flatMap((part) =>
        part.candidates.flatMap((candidate) => candidate.spans.map((span) => span.targetEndMs))
      )
    ) + 60_000;
  project.mediaLibrary.push(
    createLocalPathMediaReference(
      "target",
      "targetOriginal",
      "C:/UI-fixture/目标原片.mkv",
      targetDuration,
      timestamp
    )
  );
  for (const part of structure.parts) {
    const ordinal = part.partOrdinal;
    const sourceId = `source-${ordinal}`;
    const assetId = `asset-${ordinal}`;
    const label = `P${String(ordinal).padStart(2, "0")}`;
    const raw = part.candidates[0];
    project.mediaLibrary.push(
      createLocalPathMediaReference(
        sourceId,
        "bilibiliReference",
        `C:/UI-fixture/${label}-参考视频.mp4`,
        raw.sourceEndMs,
        timestamp
      )
    );
    project.assets.push({
      id: assetId,
      name: `${label} 弹幕`,
      fileName: `${label}-结构回放.xml`,
      color: "#0891b2",
      warnings: [],
      importedAt: timestamp,
      sourceReceipt: null,
      items: Array.from({ length: 300 }, (_, index) => {
        const sourceTimeMs = Math.floor((raw.sourceEndMs * (index + 0.5)) / 300);
        const postedAt = 1700000000 + ordinal * 300 + index;
        const userHash = `ui-replay-${ordinal}`;
        const rowId = String(ordinal * 100000 + index);
        return {
          id: `${assetId}-item-${index}`,
          assetId,
          originalIndex: index,
          sourceTimeMs,
          mode: 1,
          fontSize: 25,
          color: 16777215,
          timestamp: postedAt,
          pool: 0,
          userHash,
          rowId,
          text: `${label} 结构回放弹幕 ${index + 1} · 仅用于列表和时间线密度`,
          rawPFields: [
            (sourceTimeMs / 1000).toFixed(3),
            "1",
            "25",
            "16777215",
            String(postedAt),
            "0",
            userHash,
            rowId
          ],
          enabled: true
        };
      })
    });
    project.danmakuSourceBindings.push({
      id: `binding-${ordinal}`,
      assetId,
      sourceMediaId: sourceId,
      linkedAt: timestamp,
      updatedAt: timestamp
    });
    const spans = raw.spans.map((span, index) =>
      normalizeLegacyUnverifiedTimeMapSpanEvidence(
        {
          kind: span.kind as TimeMapSpan["kind"],
          sourceStartMs: span.sourceStartMs,
          sourceEndMs: span.sourceEndMs,
          targetStartMs: span.targetStartMs,
          targetEndMs: span.targetEndMs
        },
        { id: `span-${ordinal}-${index}`, blocked: true, reason }
      )
    );
    const first = spans[0];
    const last = spans[spans.length - 1];
    const range = {
      sourceStartMs: first.sourceStartMs,
      sourceEndMs: last.sourceEndMs,
      targetStartMs: first.targetStartMs,
      targetEndMs: last.targetEndMs
    };
    const proposal: AlignmentProposal = {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: [reason],
      matchRange: { ...range, coverage: 0 },
      timeMap: {
        ...range,
        spans,
        quality: {
          level: "blocked",
          probability: null,
          metricSource: "missing",
          coverage: null,
          uniqueContentCoverage: null,
          p50ResidualMs: null,
          p95ResidualMs: null,
          p99ResidualMs: null,
          maxResidualMs: null,
          boundaryUncertaintyMs: null,
          alternativeMargin: null,
          anchorCount: 0,
          anchorRegionCount: 0,
          heldOutAnchorCount: 0,
          reasons: [reason]
        },
        evidence: {
          types: ["legacy"],
          audioAnchorCount: 0,
          visualAnchorCount: 0,
          heldOutAnchorCount: 0,
          top1Top2Margin: null,
          uniqueContentCoverage: null,
          repeatedContentOnly: false,
          selectedTrackReason: "未选择媒体流",
          alternativeTrackScores: [],
          notes: [reason]
        },
        sourceStream: null,
        targetStream: null,
        sourceIdentity: null,
        targetIdentity: null,
        engineVersion: "ui-structure-fixture",
        featureVersion: "none",
        parametersHash: "not-measured"
      }
    };
    project = upsertMediaMatchCandidate(
      project,
      createMediaMatchCandidate(
        project,
        {
          id: `candidate-${ordinal}`,
          batchId: "ui-fixture",
          sourceMediaId: sourceId,
          targetMediaId: "target",
          proposal
        },
        timestamp
      ),
      timestamp
    );
  }
  const json = serializeProject(project);
  const reopened = parseProjectJson(json);
  if (
    reopened.assets.length !== 14 ||
    reopened.assets.some(
      (asset) => asset.items.length !== 300 || asset.sourceReceipt !== null
    ) ||
    reopened.mediaMatchCandidates.length !== 14 ||
    reopened.mediaMatchCandidates.some(
      (candidate) => candidate.state !== "blocked" || candidate.confirmedTimeMapId !== null
    ) ||
    reopened.mediaTimeMaps.some(
      (map) =>
        map.state !== "candidate" ||
        map.quality.level !== "blocked" ||
        map.verification !== null
    )
  ) {
    throw new Error("界面结构夹具库存或未验证边界不正确");
  }
  return json;
}
