import { recordPublicationDelivery } from "../../application/publicationDelivery";
import {
  serializeXmlMediaMetadata,
  collectExportMetadata
} from "../../infrastructure/xml/xmlMediaMetadata";
import {
  assessMediaTimeMapVerification,
  computeMediaTimeMapCoreDigest,
  createMediaTimeMapCoreCanonicalJson,
  createManualMediaTimeMapVerificationRequest
} from "../../domain/alignment/mediaTimeMap";
import {
  isTimeMapManualTakeoverExportApproved,
  readTimeMapManualTakeover
} from "../../domain/alignment/timeMapReviewDecision";
import { createProjectDownloadFileName } from "../../domain/project/fileNames";
import type { EditorProject, MediaContentIdentity } from "../../domain/project/types";
import type { SourceProjectionResult } from "../../domain/timeline/sourceProjection";
import { preflightProjectMediaIdentities } from "../../infrastructure/media/mediaIdentityPreflight";
import { issuePersistedManualMediaTimeMapVerification } from "../../infrastructure/media/manualVerificationAuthority";
import { createStoredZipEntries } from "../../infrastructure/file-system/browserFiles";
import {
  formatExportFileError,
  saveProjectedXmlExports,
  type SaveTextExportResult,
  type ProjectionDerivationV2,
  type VerifiedExportMapProof,
  type VerifiedExportVerificationSeed,
  type VerifiedMediaDependency
} from "../../infrastructure/file-system/exportFiles";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { resolveExportDirectory } from "../../infrastructure/settings/storageClient";
import {
  serializeBilibiliXml,
  validateExportedXml
} from "../../infrastructure/xml/bilibiliXml";
import type { EditorStatus } from "../../stores/editorStore";
import { useEditorStore } from "../../stores/editorStore";
import { setStatus } from "../assets/assetPanelSharedLogic";

export async function exportProjectionGroups(
  projection: SourceProjectionResult,
  project: EditorProject
): Promise<SaveTextExportResult | null> {
  const projectSnapshot = project;
  const exportableGroups = projection.groups.filter((group) => group.entries.length > 0);
  if (exportableGroups.length === 0) {
    setStatus({ message: "没有可导出的分集弹幕，请先在匹配页完成来源段。", tone: "warning" });
    return null;
  }
  setStatus({ message: "正在重新核验参考视频与原片的文件身份……", tone: "neutral" });
  const settings = loadAppSettings();
  const identityPreflight = await preflightProjectMediaIdentities(project, {
    ffmpegPath: settings.alignment.ffmpegPath.trim() || null
  });
  if (!identityPreflight.ok) {
    setStatus({
      message: `导出已阻断：${identityPreflight.issues.map((issue) => issue.message).join("；")}`,
      tone: "error"
    });
    return null;
  }
  if (!isProjectExportSnapshotCurrent(projectSnapshot)) {
    setStatus({
      message: "导出已取消：项目在媒体身份核验期间发生变化，请检查最新结果后重新导出。",
      tone: "warning"
    });
    return null;
  }
  const files = exportableGroups.map((group) => {
    const result = serializeBilibiliXml(
      group.entries.map((entry) => ({ item: entry.item, finalTimeMs: entry.finalTimeMs })),
      collectExportMetadata(
        project.assets,
        group.entries.map((entry) => entry.item.assetId),
        project.mediaLibrary.find((m) => m.id === group.targetMediaId)?.durationMs ?? null
      )
    );
    const validation = validateExportedXml(result.xml);
    return {
      fileName: group.exportFileName,
      content: result.xml,
      valid: validation.ok,
      message: validation.message
    };
  });
  const invalid = files.find((file) => !file.valid);
  if (invalid) {
    setStatus({ message: `分集 XML 验证失败：${invalid.message}`, tone: "error" });
    return null;
  }
  try {
    const verification = await createVerifiedExportVerificationSeed(
      projectSnapshot,
      projection,
      identityPreflight.currentIdentities
    );
    const exportResult = await saveProjectedXmlExports(
      files.map((file) => ({ fileName: file.fileName, content: file.content })),
      {
        directoryPath: await resolveExportDirectory(settings.export.defaultDirectory),
        archiveFileName: createProjectDownloadFileName(project.name, "-target-danmaku.zip"),
        verification,
        isSnapshotCurrent: () => isProjectExportSnapshotCurrent(projectSnapshot)
      }
    );
    recordPublicationDelivery(
      projectSnapshot,
      "projection",
      files.map((file, index) => {
        const target = projectSnapshot.mediaLibrary.find(
          (m) => m.id === exportableGroups[index].targetMediaId
        );
        return {
          fileName: file.fileName,
          content: file.content,
          ...(!target || isAudioOnlyMedia(target.fileName)
            ? {}
            : {
                targetFileName: target.fileName,
                durationMs: target.durationMs
              })
        };
      })
    );
    setStatus(createBatchExportStatus(exportResult));
    return exportResult;
  } catch (error) {
    setStatus({ message: `分集 XML 导出失败：${formatExportFileError(error)}`, tone: "error" });
    return null;
  }
}

export function isProjectExportSnapshotCurrent(projectSnapshot: EditorProject): boolean {
  const current = useEditorStore.getState().project;
  return (
    current === projectSnapshot &&
    current.id === projectSnapshot.id &&
    current.updatedAt === projectSnapshot.updatedAt
  );
}

export async function createVerifiedExportVerificationSeed(
  project: EditorProject,
  projection: SourceProjectionResult,
  currentIdentities: Readonly<Record<string, MediaContentIdentity>>
): Promise<VerifiedExportVerificationSeed> {
  const referencedAssetIds = new Set(
    projection.groups.flatMap((group) =>
      group.segments.flatMap((segment) => (segment.assetId ? [segment.assetId] : []))
    )
  );
  const assetsMissingReceipt = project.assets.filter(
    (asset) => referencedAssetIds.has(asset.id) && asset.sourceReceipt === null
  );
  if (assetsMissingReceipt.length > 0) {
    throw new Error(
      `正式受验证导出所引用的 XML 缺少原文件内容收据：${assetsMissingReceipt
        .map((asset) => asset.fileName)
        .join("、")}。请回到素材页点击“导入 XML”，重新选择原 XML 文件。`
    );
  }
  const referencedMapIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.kind === "content" && segment.timeMapId ? [segment.timeMapId] : []
    )
  );
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const dependencyByMediaId = new Map<string, VerifiedMediaDependency>();
  const appendDependency = (mediaId: string, mapId: string) => {
    const existing = dependencyByMediaId.get(mediaId);
    if (existing) {
      if (!existing.mapIds.includes(mapId)) {
        existing.mapIds.push(mapId);
      }
      return;
    }
    const media = mediaById.get(mediaId);
    const identity = currentIdentities[mediaId];
    if (!media?.localPath?.trim() || !identity) {
      throw new Error(`媒体 ${media?.name ?? mediaId} 缺少可原子复核的本地路径或内容身份。`);
    }
    dependencyByMediaId.set(mediaId, {
      mediaId,
      path: media.localPath.trim(),
      expectedIdentity: { ...identity },
      mapIds: [mapId]
    });
  };

  for (const timeMap of project.mediaTimeMaps) {
    if (timeMap.state !== "confirmed" || !referencedMapIds.has(timeMap.id)) {
      continue;
    }
    appendDependency(timeMap.sourceMediaId, timeMap.id);
    appendDependency(timeMap.targetMediaId, timeMap.id);
  }
  const dependencies = [...dependencyByMediaId.values()];
  if (dependencies.length === 0) {
    throw new Error("导出结果没有可复核的已确认时间图媒体依赖。");
  }
  const mapProofs = await Promise.all(
    project.mediaTimeMaps
      .filter((timeMap) => timeMap.state === "confirmed" && referencedMapIds.has(timeMap.id))
      .map(async (sourceTimeMap): Promise<VerifiedExportMapProof> => {
        const takeoverAt = readTimeMapManualTakeover(sourceTimeMap);
        const manualTakeoverApproved = isTimeMapManualTakeoverExportApproved(sourceTimeMap);
        const sourceAssessment = assessMediaTimeMapVerification(sourceTimeMap);
        const timeMap =
          manualTakeoverApproved && !sourceAssessment.trusted
            ? await issuePersistedManualMediaTimeMapVerification(sourceTimeMap, {
                calibrationArtifactId: "manual-takeover-direct-export",
                calibrationArtifactVersion: "1",
                verifier: "本机用户",
                verifiedAt: takeoverAt ?? new Date().toISOString()
              })
            : sourceTimeMap;
        const exportTakeoverApproved = isTimeMapManualTakeoverExportApproved(timeMap);
        if (
          timeMap.quality.level !== "verified" ||
          (timeMap.spans.some((span) => span.kind === "ambiguous") && !exportTakeoverApproved)
        ) {
          throw new Error(
            `时间图 ${timeMap.id} 尚未达到 verified，或含有未经人工接管明确判为版本替换的 ambiguous span。`
          );
        }
        const record = timeMap.verification;
        if (!record) {
          throw new Error(`时间图 ${timeMap.id} 缺少有效验证记录。`);
        }
        if (!assessMediaTimeMapVerification(timeMap).trusted) {
          throw new Error(`时间图 ${timeMap.id} 的验证记录尚未通过信任复核。`);
        }
        if (!timeMap.sourceIdentity || !timeMap.targetIdentity) {
          throw new Error(`时间图 ${timeMap.id} 缺少两端媒体身份。`);
        }
        const coreDigest = computeMediaTimeMapCoreDigest(timeMap);
        const coreCanonicalJson = createMediaTimeMapCoreCanonicalJson(timeMap);
        if (record.mapCoreDigest !== coreDigest || record.mapRevision !== timeMap.revision) {
          throw new Error(`时间图 ${timeMap.id} 的人工验证没有绑定当前核心或 revision。`);
        }
        const commonProof = {
          mapId: timeMap.id,
          revision: timeMap.revision,
          state: "confirmed" as const,
          declaredQuality: "verified" as const,
          spanKinds: timeMap.spans.map((span) => span.kind),
          coreDigest,
          coreCanonicalJson,
          sourceMediaId: timeMap.sourceMediaId,
          targetMediaId: timeMap.targetMediaId,
          sourceIdentity: { ...timeMap.sourceIdentity },
          targetIdentity: { ...timeMap.targetIdentity }
        };
        if (record.method === "automatic-calibration") {
          return {
            ...commonProof,
            automaticVerification: {
              calibrationArtifactId: record.calibrationArtifactId,
              calibrationArtifactVersion: record.calibrationArtifactVersion,
              verifier: record.verifier,
              verifiedAt: record.verifiedAt
            }
          };
        }
        if (
          record.recordVersion !== 2 ||
          record.revocation !== null ||
          record.signatureAlgorithm !== "hmac-sha256-v1"
        ) {
          throw new Error(`时间图 ${timeMap.id} 缺少有效的签名人工验证记录。`);
        }
        const manualRequest = createManualMediaTimeMapVerificationRequest(timeMap, {
          calibrationArtifactId: record.calibrationArtifactId,
          calibrationArtifactVersion: record.calibrationArtifactVersion,
          verifier: record.verifier,
          verifiedAt: record.verifiedAt
        });
        if (manualRequest.requestDigest !== record.requestDigest) {
          throw new Error(`时间图 ${timeMap.id} 的人工验证请求摘要不一致。`);
        }
        return {
          ...commonProof,
          manualVerification: {
            verificationId: record.verificationId,
            issuerKeyId: record.issuerKeyId,
            signatureAlgorithm: record.signatureAlgorithm,
            signature: record.signature,
            requestPayload: manualRequest.payload,
            requestDigest: manualRequest.requestDigest
          }
        };
      })
  );
  if (mapProofs.length !== referencedMapIds.size) {
    throw new Error("被引用时间图与 verified export proofs 未形成一一对应关系。");
  }
  return {
    schemaVersion: 3,
    projectId: project.id,
    projectUpdatedAt: project.updatedAt,
    projectionDerivation: createProjectionDerivation(project, projection),
    mapProofs,
    dependencies
  };
}

export function createProjectionDerivation(
  project: EditorProject,
  projection: SourceProjectionResult
): ProjectionDerivationV2 {
  const groupsInFileAllocationOrder = [
    ...projection.groups.filter((group) => group.entries.length > 0),
    ...projection.groups.filter((group) => group.entries.length === 0)
  ];
  const logicalTargetFiles = createStoredZipEntries(
    groupsInFileAllocationOrder.map((group) => ({
      fileName: group.exportFileName,
      content: ""
    }))
  );
  const logicalFileNameByTarget = new Map(
    groupsInFileAllocationOrder.map((group, groupIndex) => [
      group.targetMediaId,
      logicalTargetFiles[groupIndex].fileName
    ])
  );
  return {
    domain: "projection-derivation-v2",
    projectionPolicyVersion: "source-projection-v1",
    serializerVersion: "bilibili-xml-export-v1",
    projectId: project.id,
    projectUpdatedAt: project.updatedAt,
    media: project.mediaLibrary.map((media) => ({
      mediaId: media.id,
      role: media.role,
      name: media.name,
      mediaFileName: media.fileName,
      durationMs: media.durationMs,
      episodeLabel: media.episodeLabel,
      contentIdentity: media.contentIdentity ? { ...media.contentIdentity } : null
    })),
    xmlAssets: project.assets.map((asset) => ({
      assetId: asset.id,
      sourceFileName: asset.fileName,
      sourceReceipt: asset.sourceReceipt ? { ...asset.sourceReceipt } : null,
      items: asset.items.map((item) => ({
        itemId: item.id,
        assetId: item.assetId,
        originalIndex: item.originalIndex,
        sourceTimeMs: item.sourceTimeMs,
        mode: item.mode,
        fontSize: item.fontSize,
        color: item.color,
        timestamp: item.timestamp,
        pool: item.pool,
        userHash: item.userHash,
        rowId: item.rowId,
        text: item.text,
        rawPFields: [...item.rawPFields],
        enabled: item.enabled
      }))
    })),
    sourceBindings: project.danmakuSourceBindings.map((binding) => ({
      bindingId: binding.id,
      assetId: binding.assetId,
      sourceMediaId: binding.sourceMediaId
    })),
    routes: project.danmakuSourceSegments.map((segment) => ({
      routeId: segment.id,
      kind: segment.kind,
      assetId: segment.assetId,
      sourceMediaId: segment.sourceMediaId,
      sourceStartMs: segment.sourceStartMs,
      sourceEndMs: segment.sourceEndMs,
      targetMediaId: segment.targetMediaId,
      targetStartMs: segment.targetStartMs,
      timeMapId: segment.timeMapId,
      timingRules: segment.timingRules.map((rule) => ({
        ruleId: rule.id,
        sourceAtMs: rule.sourceAtMs,
        gapMs: rule.gapMs
      }))
    })),
    disabledItemIds: [...new Set(project.disabledItemIds)].sort(compareUtf8Strings),
    itemTimeAdjustments: Object.entries(project.itemTimeAdjustments)
      .map(([itemId, adjustmentMs]) => ({ itemId, adjustmentMs }))
      .sort((left, right) => compareUtf8Strings(left.itemId, right.itemId)),
    targetOutputFiles: projection.groups.map((group) => ({
      targetMediaId: group.targetMediaId,
      metadataXml: serializeXmlMediaMetadata(
        collectExportMetadata(
          project.assets,
          group.entries.map((entry) => entry.item.assetId),
          project.mediaLibrary.find((m) => m.id === group.targetMediaId)?.durationMs ?? null
        )
      ).join("\n"),
      fileName: logicalFileNameByTarget.get(group.targetMediaId) ?? group.exportFileName
    }))
  };
}

export function compareUtf8Strings(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

export function createBatchExportStatus(result: SaveTextExportResult): EditorStatus {
  const fileCount = result.fileCount.toLocaleString("zh-CN");
  if (result.mode === "directory") {
    return {
      message: `已导出 ${fileCount} 个分集 XML 到 ${result.filePath}${result.wasRenamed ? "（已有同名文件，已自动改名）。" : "。"}`,
      tone: "success",
      action: {
        type: "openDirectory",
        label: "打开目录",
        directoryPath: result.directoryPath
      }
    };
  }
  if (result.archiveFileName) {
    return {
      message: `已触发下载 ${fileCount} 个分集 XML，已打包为 ${result.archiveFileName}。`,
      tone: "success"
    };
  }
  if (result.downloadedFileName) {
    return {
      message: `已触发下载 ${fileCount} 个分集 XML：${result.downloadedFileName}。`,
      tone: "success"
    };
  }
  return { message: `已触发下载 ${fileCount} 个分集 XML。`, tone: "success" };
}
import { isAudioOnlyMedia } from "../../domain/project/mediaFormat";
