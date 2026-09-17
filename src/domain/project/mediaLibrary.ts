import type { Milliseconds } from "../shared/time";
import type {
  DanmakuSourceBinding,
  EditorProject,
  EmbyItemMediaBinding,
  LocalFileMediaBinding,
  MediaBinding,
  MediaReference,
  ProjectMediaEmbyReference,
  ProjectMediaReference,
  ProjectMediaRole
} from "./types";

export interface BrowserMediaDraft {
  name: string;
  fileName: string;
  objectUrl: string;
  durationMs?: Milliseconds | null;
}

export interface EmbyAudioCacheMediaDraft {
  localPath: string;
  durationMs: Milliseconds | null;
  emby: ProjectMediaEmbyReference;
  profileLabel: string;
  audioTrackLabel: string;
}

export interface WebDavAudioCacheMediaDraft {
  localPath: string;
  fileName: string;
  durationMs: Milliseconds;
  name: string;
  audioTrackLabel: string;
}

export function createWebDavAudioCacheMediaReference(id: string, draft: WebDavAudioCacheMediaDraft): ProjectMediaReference {
  return {
    ...createLocalPathMediaReference(id, "targetOriginal", draft.localPath, draft.durationMs),
    name: draft.name,
    fileName: draft.fileName,
    sourceSummary: `WebDAV 音轨缓存 · ${draft.audioTrackLabel} · 保留解码音轨尾部；完整原片版本与尾部覆盖未证明`
  };
}

export interface MediaReferenceUsage {
  kind:
    | "xmlBinding"
    | "sourceSegmentSource"
    | "sourceSegmentTarget"
    | "matchCandidateSource"
    | "matchCandidateTarget"
    | "mediaBinding"
    | "seasonEpisodeBinding";
  label: string;
}

export interface RemoveMediaReferenceResult {
  ok: boolean;
  project: EditorProject;
  usages: MediaReferenceUsage[];
}

export interface SourceSegmentReferenceIssue {
  severity: "warning" | "error";
  message: string;
}

export function createBrowserFileMediaReference(
  id: string,
  role: ProjectMediaRole,
  draft: BrowserMediaDraft,
  timestamp = new Date().toISOString()
): ProjectMediaReference {
  return {
    id,
    role,
    name: normalizeDisplayName(draft.name, draft.fileName),
    fileName: normalizeFileName(draft.fileName),
    objectUrl: draft.objectUrl,
    durationMs: normalizeDuration(draft.durationMs ?? null),
    contentIdentity: null,
    referenceKind: "browserFile",
    connectionState: "connected",
    sourceSummary: "本地浏览器文件引用",
    localPath: null,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createLocalPathMediaReference(
  id: string,
  role: ProjectMediaRole,
  localPath: string,
  runtimeMs: Milliseconds | null = null,
  timestamp = new Date().toISOString()
): ProjectMediaReference {
  const normalizedPath = localPath.trim();
  const fileName = extractFileName(normalizedPath);
  return {
    id,
    role,
    name: stripExtension(fileName),
    fileName,
    objectUrl: null,
    durationMs: normalizeDuration(runtimeMs),
    contentIdentity: null,
    referenceKind: "localPath",
    connectionState: normalizedPath.length > 0 ? "connected" : "needsReconnect",
    sourceSummary: "本地文件路径",
    localPath: normalizedPath || null,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createEmbyAudioCacheMediaReference(
  id: string,
  draft: EmbyAudioCacheMediaDraft,
  timestamp = new Date().toISOString()
): ProjectMediaReference {
  const local = createLocalPathMediaReference(
    id,
    "targetOriginal",
    draft.localPath,
    draft.durationMs,
    timestamp
  );
  const episodeLabel = formatEpisodeLabel(
    draft.emby.seasonNumber,
    draft.emby.episodeNumber
  );
  return {
    ...local,
    name: draft.emby.itemName,
    sourceSummary: `Emby 音频缓存 · ${draft.audioTrackLabel} · ${draft.profileLabel}`,
    emby: draft.emby,
    episodeKey: `emby:${draft.emby.server.serverUrl}:${draft.emby.itemId}`,
    episodeLabel
  };
}

export function createMediaReferenceFromBinding(
  id: string,
  binding: MediaBinding,
  timestamp = binding.linkedAt
): ProjectMediaReference {
  if (binding.kind === "localFile") {
    return createLocalFileBindingMediaReference(id, binding, timestamp);
  }
  return createEmbyBindingMediaReference(id, binding, timestamp);
}

export function createMediaReferenceFromLegacyMedia(
  media: MediaReference,
  timestamp: string
): ProjectMediaReference {
  return {
    id: media.id,
    role: "bilibiliReference",
    name: normalizeDisplayName(media.name, media.fileName),
    fileName: normalizeFileName(media.fileName),
    objectUrl: media.objectUrl,
    durationMs: normalizeDuration(media.durationMs),
    contentIdentity: null,
    referenceKind: "browserFile",
    connectionState: media.objectUrl ? "connected" : "needsReconnect",
    sourceSummary: "旧项目参考视频",
    localPath: null,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createDanmakuSourceBinding(
  id: string,
  assetId: string,
  sourceMediaId: string,
  timestamp = new Date().toISOString()
): DanmakuSourceBinding {
  return {
    id,
    assetId,
    sourceMediaId,
    linkedAt: timestamp,
    updatedAt: timestamp
  };
}

export function upsertDanmakuSourceBinding(
  bindings: readonly DanmakuSourceBinding[],
  nextBinding: DanmakuSourceBinding
): DanmakuSourceBinding[] {
  return [
    ...bindings.filter((binding) => binding.assetId !== nextBinding.assetId),
    nextBinding
  ];
}

export function removeDanmakuSourceBinding(
  bindings: readonly DanmakuSourceBinding[],
  assetId: string
): DanmakuSourceBinding[] {
  return bindings.filter((binding) => binding.assetId !== assetId);
}

export function findDanmakuSourceBinding(
  bindings: readonly DanmakuSourceBinding[],
  assetId: string
): DanmakuSourceBinding | null {
  return bindings.find((binding) => binding.assetId === assetId) ?? null;
}

export function getProjectMediaByRole(
  project: Pick<EditorProject, "mediaLibrary">,
  role: ProjectMediaRole
): ProjectMediaReference[] {
  return project.mediaLibrary.filter((media) => media.role === role);
}

export function findProjectMedia(
  project: Pick<EditorProject, "mediaLibrary">,
  mediaId: string | null
): ProjectMediaReference | null {
  if (!mediaId) {
    return null;
  }
  return project.mediaLibrary.find((media) => media.id === mediaId) ?? null;
}

export function validateDanmakuSourceBinding(
  project: Pick<EditorProject, "assets" | "mediaLibrary">,
  assetId: string,
  sourceMediaId: string | null
): string | null {
  if (!project.assets.some((asset) => asset.id === assetId)) {
    return "XML 资源不存在。";
  }
  const sourceMedia = findProjectMedia(project, sourceMediaId);
  if (!sourceMedia) {
    return "请选择一个 B 站参考素材。";
  }
  if (sourceMedia.role !== "bilibiliReference") {
    return "XML 只能绑定 B 站参考素材。";
  }
  return null;
}

export function validateSourceSegmentReferences(
  project: Pick<EditorProject, "assets" | "mediaLibrary" | "danmakuSourceBindings">,
  segment: {
    kind: "content" | "ignored";
    assetId: string | null;
    sourceMediaId: string | null;
    targetMediaId: string | null;
    sourceStartMs: Milliseconds;
    sourceEndMs: Milliseconds;
  }
): SourceSegmentReferenceIssue[] {
  const issues: SourceSegmentReferenceIssue[] = [];
  const asset = project.assets.find((candidate) => candidate.id === segment.assetId);
  if (!asset) {
    issues.push({ severity: "error", message: "来源段必须选择所属 XML。" });
  } else {
    const binding = findDanmakuSourceBinding(project.danmakuSourceBindings, asset.id);
    if (!binding) {
      issues.push({ severity: "error", message: "请先在素材页把所属 XML 绑定到 B 站参考素材。" });
    } else if (binding.sourceMediaId !== segment.sourceMediaId) {
      issues.push({ severity: "error", message: "来源段的参考素材必须与所属 XML 在素材页的绑定一致。" });
    }
  }
  const sourceMedia = findProjectMedia(project, segment.sourceMediaId);
  if (!sourceMedia) {
    issues.push({ severity: "error", message: "来源段必须选择 B 站参考素材。" });
  } else if (sourceMedia.role !== "bilibiliReference") {
    issues.push({ severity: "error", message: "来源段的来源素材只能是 B 站参考素材。" });
  } else if (
    sourceMedia.durationMs !== null &&
    (segment.sourceStartMs > sourceMedia.durationMs || segment.sourceEndMs > sourceMedia.durationMs)
  ) {
    issues.push({
      severity: "warning",
      message: "来源段时间超出了参考素材已知时长，请确认是否为长视频或元数据不完整。"
    });
  }
  const targetMedia = findProjectMedia(project, segment.targetMediaId);
  if (targetMedia && targetMedia.role !== "targetOriginal") {
    issues.push({ severity: "error", message: "来源段的目标素材只能是原片素材。" });
  }
  if (segment.kind === "content" && !targetMedia) {
    issues.push({ severity: "warning", message: "正片内容段尚未选择目标原片。" });
  }
  return issues;
}

export function collectMediaReferenceUsages(
  project: EditorProject,
  mediaId: string
): MediaReferenceUsage[] {
  const usages: MediaReferenceUsage[] = [];
  project.danmakuSourceBindings
    .filter((binding) => binding.sourceMediaId === mediaId)
    .forEach((binding) => {
      const asset = project.assets.find((candidate) => candidate.id === binding.assetId);
      usages.push({
        kind: "xmlBinding",
        label: `XML 绑定：${asset?.fileName ?? binding.assetId}`
      });
    });
  project.danmakuSourceSegments
    .filter((segment) => segment.sourceMediaId === mediaId)
    .forEach((segment) =>
      usages.push({
        kind: "sourceSegmentSource",
        label: `来源段来源：${segment.label}`
      })
    );
  project.danmakuSourceSegments
    .filter((segment) => segment.targetMediaId === mediaId)
    .forEach((segment) =>
      usages.push({
        kind: "sourceSegmentTarget",
        label: `来源段目标：${segment.label}`
      })
    );
  project.mediaMatchCandidates
    .filter((candidate) => candidate.state !== "rejected" && candidate.sourceMediaId === mediaId)
    .forEach((candidate) =>
      usages.push({
        kind: "matchCandidateSource",
        label: `匹配候选来源：${candidate.id}`
      })
    );
  project.mediaMatchCandidates
    .filter((candidate) => candidate.state !== "rejected" && candidate.targetMediaId === mediaId)
    .forEach((candidate) =>
      usages.push({
        kind: "matchCandidateTarget",
        label: `匹配候选目标：${candidate.id}`
      })
    );
  if (project.mediaBinding?.kind === "localFile" && project.mediaBinding.mediaId === mediaId) {
    usages.push({
      kind: "mediaBinding",
      label: `项目目标原片：${project.mediaBinding.displayName}`
    });
  }
  project.seasonEpisodeBindings
    .filter(
      (binding) =>
        binding.targetBinding.kind === "localFile" &&
        binding.targetBinding.mediaId === mediaId
    )
    .forEach((binding) =>
      usages.push({
        kind: "seasonEpisodeBinding",
        label: `逐集目标绑定：${binding.episodeLabel}`
      })
    );
  return usages;
}

export function removeMediaReference(
  project: EditorProject,
  mediaId: string
): RemoveMediaReferenceResult {
  const media = findProjectMedia(project, mediaId);
  if (!media) {
    return { ok: false, project, usages: [] };
  }
  const usages = collectMediaReferenceUsages(project, mediaId);
  const blockingUsages = usages.filter(
    (usage) => usage.kind !== "matchCandidateSource" && usage.kind !== "matchCandidateTarget"
  );
  if (blockingUsages.length > 0) {
    return { ok: false, project, usages };
  }
  const nextMedia = project.media?.id === mediaId ? null : project.media;
  return {
    ok: true,
    usages: [],
    project: {
      ...project,
      media: nextMedia,
      mediaLibrary: project.mediaLibrary.filter((candidate) => candidate.id !== mediaId),
      mediaMatchCandidates: project.mediaMatchCandidates.filter(
        (candidate) => candidate.sourceMediaId !== mediaId && candidate.targetMediaId !== mediaId
      )
    }
  };
}

export function reconnectMediaReference(
  media: ProjectMediaReference,
  draft: BrowserMediaDraft,
  timestamp = new Date().toISOString()
): ProjectMediaReference {
  return {
    ...media,
    name: normalizeDisplayName(draft.name, draft.fileName),
    fileName: normalizeFileName(draft.fileName),
    objectUrl: draft.objectUrl,
    durationMs: normalizeDuration(draft.durationMs ?? media.durationMs),
    contentIdentity: null,
    referenceKind: "browserFile",
    connectionState: "connected",
    sourceSummary: "本地浏览器文件引用",
    localPath: null,
    updatedAt: timestamp
  };
}

export function updateMediaDuration(
  media: ProjectMediaReference,
  durationMs: Milliseconds,
  timestamp = new Date().toISOString()
): ProjectMediaReference {
  return {
    ...media,
    durationMs: normalizeDuration(durationMs),
    updatedAt: timestamp
  };
}

export function sanitizeMediaReferencesForSave(
  mediaLibrary: readonly ProjectMediaReference[]
): ProjectMediaReference[] {
  return mediaLibrary.map((media) => {
    if (media.referenceKind !== "browserFile") {
      return {
        ...media,
        objectUrl: null
      };
    }
    return {
      ...media,
      objectUrl: null,
      connectionState: "needsReconnect"
    };
  });
}

export function createLegacyPreviewMedia(
  mediaLibrary: readonly ProjectMediaReference[]
): MediaReference | null {
  const reference = mediaLibrary.find(
    (media) => media.role === "bilibiliReference" && media.objectUrl
  );
  if (!reference) {
    return null;
  }
  return {
    id: reference.id,
    name: reference.name,
    fileName: reference.fileName,
    objectUrl: reference.objectUrl,
    durationMs: reference.durationMs
  };
}

export function formatMediaRole(role: ProjectMediaRole): string {
  return role === "targetOriginal" ? "原片素材" : "B 站参考素材";
}

export function formatMediaConnectionState(media: ProjectMediaReference): string {
  if (media.connectionState === "connected") {
    return "已连接";
  }
  if (media.connectionState === "metadataOnly") {
    return "已保存摘要";
  }
  return "需要重新连接";
}

function createLocalFileBindingMediaReference(
  id: string,
  binding: LocalFileMediaBinding,
  timestamp: string
): ProjectMediaReference {
  const hasLocalPath = Boolean(binding.localPath?.trim());
  return {
    id,
    role: "targetOriginal",
    name: normalizeDisplayName(binding.displayName, binding.fileName),
    fileName: normalizeFileName(binding.fileName),
    objectUrl: null,
    durationMs: normalizeDuration(binding.runtimeMs),
    contentIdentity: null,
    referenceKind: hasLocalPath ? "localPath" : "browserFile",
    connectionState: hasLocalPath ? "connected" : "needsReconnect",
    sourceSummary: hasLocalPath ? "本地文件路径" : "旧项目本地目标引用",
    localPath: binding.localPath?.trim() || null,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createEmbyBindingMediaReference(
  id: string,
  binding: EmbyItemMediaBinding,
  timestamp: string
): ProjectMediaReference {
  return {
    id,
    role: "targetOriginal",
    name: normalizeDisplayName(binding.displayName, binding.itemName),
    fileName: binding.itemName,
    objectUrl: null,
    durationMs: normalizeDuration(binding.runtimeMs),
    contentIdentity: null,
    referenceKind: "embyItem",
    connectionState: "metadataOnly",
    sourceSummary: "Emby 条目摘要",
    localPath: null,
    emby: createEmbyReference(binding),
    episodeKey: null,
    episodeLabel: formatEmbyEpisodeLabel(binding),
    audioTrackIntent: { mode: "auto" },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createEmbyReference(binding: EmbyItemMediaBinding): ProjectMediaEmbyReference {
  return {
    itemId: binding.itemId,
    itemName: binding.itemName,
    itemType: binding.itemType,
    seriesName: binding.seriesName,
    seasonNumber: binding.seasonNumber,
    episodeNumber: binding.episodeNumber,
    server: {
      serverUrl: binding.server.serverUrl,
      pathPrefix: binding.server.pathPrefix,
      username: binding.server.username
    },
    mediaSources: binding.mediaSources
  };
}

function formatEmbyEpisodeLabel(binding: EmbyItemMediaBinding): string | null {
  return formatEpisodeLabel(binding.seasonNumber, binding.episodeNumber);
}

function formatEpisodeLabel(
  seasonNumber: number | null,
  episodeNumber: number | null
): string | null {
  if (seasonNumber === null && episodeNumber === null) {
    return null;
  }
  const season = seasonNumber === null ? "" : `S${seasonNumber.toString().padStart(2, "0")}`;
  const episode = episodeNumber === null ? "" : `E${episodeNumber.toString().padStart(2, "0")}`;
  return `${season}${episode}` || null;
}

function normalizeDisplayName(name: string, fileName: string): string {
  const trimmed = name.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return stripExtension(normalizeFileName(fileName));
}

function normalizeFileName(fileName: string): string {
  const trimmed = fileName.trim();
  return trimmed.length > 0 ? trimmed : "未命名媒体";
}

function normalizeDuration(durationMs: Milliseconds | null): Milliseconds | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  const rounded = Math.round(durationMs);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : null;
}

function extractFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
