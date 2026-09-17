import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptMediaMatchCandidateWithManualTakeover,
  createMediaMatchCandidate,
  upsertMediaMatchCandidate
} from "../../domain/alignment/mediaMatching";
import {
  applyAuthorityIssuedManualMediaTimeMapVerification,
  clearRegisteredManualMediaTimeMapVerificationTrust,
  createManualMediaTimeMapVerificationRequest
} from "../../domain/alignment/mediaTimeMap";
import { isAlignmentTimeMapProposal } from "../../domain/alignment/timeMapProposal";
import type { AlignmentProposal } from "../../domain/alignment/types";
import { createEmptyProject } from "../../domain/project/factory";
import type {
  EditorProject,
  MediaContentIdentity,
  ProjectMediaReference
} from "../../domain/project/types";
import { sha256Hex } from "../../domain/shared/sha256";
import { projectDanmakuToTargets } from "../../domain/timeline/sourceProjection";
import {
  parseBilibiliXml,
  serializeBilibiliXml,
  validateExportedXml
} from "../xml/bilibiliXml";

interface RealMediaReceiptPair {
  sourceMediaId: string;
  targetMediaId: string;
  status: string;
  proposal: AlignmentProposal | null;
}

interface RealMediaReceipt {
  elapsedMs: number;
  requestedBackend: string;
  snapshot: {
    status: string;
    failedPairCount: number;
    pairs: RealMediaReceiptPair[];
  };
}

type RequiredTimeMapProposal = AlignmentProposal & {
  timeMap: NonNullable<AlignmentProposal["timeMap"]>;
};

const receiptPath = process.env.C137_NORTH_STAR_RECEIPT?.trim() ?? "";
const xmlPath = process.env.C137_NORTH_STAR_XML?.trim() ?? "";
const targetPaths = (process.env.C137_NORTH_STAR_TARGETS ?? "")
  .split("|")
  .map((path) => path.trim())
  .filter(Boolean);
const outputDirectory = process.env.C137_NORTH_STAR_OUTPUT_DIR?.trim() ?? "";
const realMediaEnabled =
  receiptPath.length > 0 &&
  xmlPath.length > 0 &&
  targetPaths.length > 0 &&
  outputDirectory.length > 0;

describe.runIf(realMediaEnabled)("真实 1×N 人工接管与 XML 投影验收", () => {
  it("从原生候选建立已签发关系，导出并重新解析每个原片 XML", () => {
    clearRegisteredManualMediaTimeMapVerificationTrust();
    const receipt = parseReceipt(readFileSync(receiptPath, "utf8"));
    expect(receipt.snapshot.status).toBe("completed");
    expect(receipt.snapshot.failedPairCount).toBe(0);
    expect(receipt.snapshot.pairs).toHaveLength(targetPaths.length);

    const asset = parseBilibiliXml(readFileSync(xmlPath, "utf8"), {
      assetId: "north-star-xml",
      assetName: "北极星参考弹幕",
      fileName: basename(xmlPath),
      importedAt: "2026-07-19T00:00:00.000Z"
    });
    expect(asset.items.length).toBeGreaterThan(0);

    let project = createEmptyProject("C137 真实 1×N XML 验收");
    project.assets = [asset];
    project.mediaLibrary = createMediaLibrary(receipt, targetPaths);
    project.danmakuSourceBindings = [
      {
        id: "north-star-binding",
        assetId: asset.id,
        sourceMediaId: receipt.snapshot.pairs[0]?.sourceMediaId ?? "",
        linkedAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z"
      }
    ];

    receipt.snapshot.pairs.forEach((pair, pairIndex) => {
      const proposal = requireProposal(pair, pairIndex);
      const candidate = createMediaMatchCandidate(project, {
        id: `north-star-candidate-${String(pairIndex + 1).padStart(2, "0")}`,
        batchId: "north-star-real-media-v1",
        sourceMediaId: pair.sourceMediaId,
        targetMediaId: pair.targetMediaId,
        proposal
      });
      const acceptedAt = new Date(Date.UTC(2026, 6, 19, 0, pairIndex, 0)).toISOString();
      project = upsertMediaMatchCandidate(project, candidate, acceptedAt);
      project = acceptMediaMatchCandidateWithManualTakeover(
        project,
        candidate.id,
        [asset.id],
        acceptedAt
      );
      project = signConfirmedMap(project, candidate.id, pairIndex);
    });

    const projection = projectDanmakuToTargets(project);
    expect(projection.status, projection.issues.map((issue) => issue.message).join("\n")).toMatch(
      /^ready/
    );
    expect(projection.groups).toHaveLength(targetPaths.length);
    expect(projection.unexpectedUnmappedItemCount).toBeLessThanOrEqual(
      Math.max(5, asset.items.length * 0.01)
    );
    expect(asset.items.every((item) => item.enabled)).toBe(true);
    expect(
      projection.projectedItemCount +
        projection.sourceOnlyItemCount +
        projection.unexpectedUnmappedItemCount +
        projection.ignoredItemCount
    ).toBe(asset.items.length);

    const originalIndexOwners = new Map<number, string>();
    const duplicateIndexes: number[] = [];
    const files = projection.groups.map((group) => {
      expect(group.entries.length).toBeGreaterThan(0);
      group.entries.forEach((entry) => {
        const previous = originalIndexOwners.get(entry.item.originalIndex);
        if (previous && previous !== group.targetMediaId) {
          duplicateIndexes.push(entry.item.originalIndex);
        }
        originalIndexOwners.set(entry.item.originalIndex, group.targetMediaId);
      });

      const exported = serializeBilibiliXml(group.entries);
      const validation = validateExportedXml(exported.xml);
      expect(validation).toMatchObject({ ok: true, count: group.entries.length });
      const reparsed = parseBilibiliXml(exported.xml, {
        fileName: group.exportFileName,
        assetId: `reparsed-${group.targetMediaId}`
      });
      expect(reparsed.items).toHaveLength(group.entries.length);
      reparsed.items.forEach((item, itemIndex) => {
        const original = group.entries[itemIndex]?.item;
        expect(original).toBeDefined();
        expect(item.text).toBe(original?.text);
        expect(item.rawPFields.slice(1)).toEqual(original?.rawPFields.slice(1));
      });
      const target = project.mediaLibrary.find((media) => media.id === group.targetMediaId);
      expect(target?.durationMs).not.toBeNull();
      expect(
        group.entries.every(
          (entry) =>
            entry.finalTimeMs >= 0 &&
            target?.durationMs !== null &&
            target?.durationMs !== undefined &&
            entry.finalTimeMs < target.durationMs
        )
      ).toBe(true);

      mkdirSync(outputDirectory, { recursive: true });
      const outputPath = join(outputDirectory, group.exportFileName);
      writeFileSync(outputPath, exported.xml, "utf8");
      return {
        targetMediaId: group.targetMediaId,
        targetFileName: group.targetFileName,
        outputFileName: group.exportFileName,
        itemCount: group.entries.length,
        firstTimeMs: group.entries[0]?.finalTimeMs ?? null,
        lastTimeMs: group.entries.at(-1)?.finalTimeMs ?? null,
        xmlDigest: `sha256:${sha256Hex(exported.xml)}`
      };
    });

    expect(duplicateIndexes).toEqual([]);
    const report = {
      schemaVersion: 1,
      evidenceKind: "c137-development-real-media-north-star-export",
      releaseEligible: false,
      sourceReceipt: {
        requestedBackend: receipt.requestedBackend,
        elapsedMs: receipt.elapsedMs,
        digest: `sha256:${sha256Hex(readFileSync(receiptPath, "utf8"))}`
      },
      sourceXml: {
        itemCount: asset.items.length,
        digest: `sha256:${sha256Hex(readFileSync(xmlPath, "utf8"))}`
      },
      result: {
        status: projection.status,
        fileCount: files.length,
        projectedItemCount: projection.projectedItemCount,
        sourceOnlyItemCount: projection.sourceOnlyItemCount,
        unexpectedUnmappedItemCount: projection.unexpectedUnmappedItemCount,
        crossTargetDuplicateItemCount: duplicateIndexes.length,
        issues: projection.issues.map((issue) => ({
          severity: issue.severity,
          message: issue.message
        })),
        files
      },
      limitation:
        "该回执证明真实候选经领域人工接管、签发、投影和重解析可生成 5 份 XML；安装级原生收据与桌面交互仍需单独走查。"
    };
    writeFileSync(
      join(outputDirectory, "c137-north-star-export-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
  });
});

function parseReceipt(text: string): RealMediaReceipt {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || !isRecord(value.snapshot) || !Array.isArray(value.snapshot.pairs)) {
    throw new Error("真实媒体回执结构无效。");
  }
  if (
    !Number.isSafeInteger(value.elapsedMs) ||
    typeof value.requestedBackend !== "string" ||
    typeof value.snapshot.status !== "string" ||
    !Number.isSafeInteger(value.snapshot.failedPairCount)
  ) {
    throw new Error("真实媒体回执缺少批次终态字段。");
  }
  const pairs = value.snapshot.pairs.map((pair, pairIndex) => {
    if (
      !isRecord(pair) ||
      typeof pair.sourceMediaId !== "string" ||
      typeof pair.targetMediaId !== "string" ||
      typeof pair.status !== "string" ||
      (pair.proposal !== null && !isRecord(pair.proposal))
    ) {
      throw new Error(`真实媒体回执第 ${pairIndex + 1} 个 pair 无效。`);
    }
    return {
      sourceMediaId: pair.sourceMediaId,
      targetMediaId: pair.targetMediaId,
      status: pair.status,
      proposal: pair.proposal as AlignmentProposal | null
    };
  });
  return {
    elapsedMs: value.elapsedMs as number,
    requestedBackend: value.requestedBackend,
    snapshot: {
      status: value.snapshot.status,
      failedPairCount: value.snapshot.failedPairCount as number,
      pairs
    }
  };
}

function requireProposal(
  pair: RealMediaReceiptPair,
  pairIndex: number
): RequiredTimeMapProposal {
  if (
    pair.status !== "completed" ||
    !pair.proposal?.timeMap ||
    !isAlignmentTimeMapProposal(pair.proposal.timeMap)
  ) {
    throw new Error(`第 ${pairIndex + 1} 个真实 pair 没有可复核 TimeMap。`);
  }
  return {
    ...structuredClone(pair.proposal),
    timeMap: structuredClone(pair.proposal.timeMap)
  };
}

function createMediaLibrary(
  receipt: RealMediaReceipt,
  paths: readonly string[]
): ProjectMediaReference[] {
  const firstProposal = requireProposal(receipt.snapshot.pairs[0], 0).timeMap;
  const source = createMediaReference({
    id: receipt.snapshot.pairs[0].sourceMediaId,
    role: "bilibiliReference",
    localPath: "redacted://north-star-reference",
    durationMs: Math.max(
      ...receipt.snapshot.pairs.map(
        (pair, pairIndex) => requireProposal(pair, pairIndex).timeMap.sourceEndMs
      )
    ),
    contentIdentity: requireIdentity(firstProposal.sourceIdentity, "参考")
  });
  const targets = receipt.snapshot.pairs.map((pair, pairIndex) => {
    const timeMap = requireProposal(pair, pairIndex).timeMap;
    return createMediaReference({
      id: pair.targetMediaId,
      role: "targetOriginal",
      localPath: paths[pairIndex] ?? `redacted://target-${pairIndex + 1}`,
      durationMs: timeMap.targetEndMs,
      contentIdentity: requireIdentity(timeMap.targetIdentity, `原片 ${pairIndex + 1}`),
      episodeLabel: `E${String(pairIndex + 1).padStart(2, "0")}`
    });
  });
  return [source, ...targets];
}

function createMediaReference(input: {
  id: string;
  role: ProjectMediaReference["role"];
  localPath: string;
  durationMs: number;
  contentIdentity: MediaContentIdentity;
  episodeLabel?: string;
}): ProjectMediaReference {
  return {
    id: input.id,
    role: input.role,
    name: input.episodeLabel ?? input.id,
    fileName: basename(input.localPath),
    objectUrl: null,
    durationMs: input.durationMs,
    contentIdentity: structuredClone(input.contentIdentity),
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "本地真实媒体验收",
    localPath: input.localPath,
    emby: null,
    episodeKey: input.episodeLabel ?? null,
    episodeLabel: input.episodeLabel ?? null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z"
  };
}

function requireIdentity(
  identity: MediaContentIdentity | null | undefined,
  label: string
): MediaContentIdentity {
  if (!identity) {
    throw new Error(`${label}缺少内容身份。`);
  }
  return identity;
}

function signConfirmedMap(
  project: EditorProject,
  candidateId: string,
  pairIndex: number
): EditorProject {
  const candidate = project.mediaMatchCandidates.find((item) => item.id === candidateId);
  const map = project.mediaTimeMaps.find((item) => item.id === candidate?.confirmedTimeMapId);
  if (!map) {
    throw new Error(`第 ${pairIndex + 1} 个候选没有确认时间图。`);
  }
  const input = {
    calibrationArtifactId: "c137-real-north-star-manual-takeover",
    calibrationArtifactVersion: "1",
    verifier: "C137 本地验收",
    verifiedAt: new Date(Date.UTC(2026, 6, 19, 1, pairIndex, 0)).toISOString()
  };
  const request = createManualMediaTimeMapVerificationRequest(map, input);
  const issued = applyAuthorityIssuedManualMediaTimeMapVerification(map, input, {
    verificationId: `north-star-verification-${pairIndex + 1}`,
    issuerKeyId: "c137-local-acceptance-key",
    issuerSequence: pairIndex + 1,
    signatureAlgorithm: "hmac-sha256-v1",
    signature: String(pairIndex + 1).repeat(64),
    requestDigest: request.requestDigest
  });
  return {
    ...project,
    mediaTimeMaps: project.mediaTimeMaps.map((item) => (item.id === map.id ? issued : item))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
