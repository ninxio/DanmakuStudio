import { getKnownBilibiliDuration } from "../domain/danmaku/bilibiliAcquisition";
import type {
  DanmakuAsset,
  DanmakuClip,
  DanmakuItem,
  ResolvedDanmakuEvent
} from "../domain/danmaku/types";
import { createId, cloneProject, touchProject } from "../domain/project/factory";
import { pushHistory } from "../domain/history/history";
import type {
  EditorProject,
  EditorSelection,
  MediaBinding,
  MediaReference,
  ProjectMediaReference
} from "../domain/project/types";
import type { ProjectSchemaMigration } from "../domain/project/schema";
import type { Milliseconds } from "../domain/shared/time";
import { clampMilliseconds } from "../domain/shared/time";
import {
  getAssetTimeRange,
  getClipDurationMs,
  resolveProjectDanmakuEvents
} from "../domain/timeline/mapping";
import { revokeObjectUrl } from "../infrastructure/file-system/browserFiles";
import type { AlignmentProposal } from "../domain/alignment/types";
import { serializeAlignmentProposal } from "../domain/alignment/manualProvider";
import { computeMediaTimeMapCoreDigest } from "../domain/alignment/mediaTimeMap";
import type { EditorStatus, EditorStore } from "./editorStoreTypes";

export const emptySelection: EditorSelection = { kind: "none", ids: [] };
export function commitProject(
  set: (partial: Partial<EditorStore> | ((state: EditorStore) => Partial<EditorStore>)) => void,
  get: () => EditorStore,
  label: string,
  updater: (project: EditorProject) => EditorProject,
  selection?: EditorSelection
): void {
  if (get().projectLibrary.switchingProject) return;
  const before = cloneProject(get().project);
  const after = touchProject(updater(cloneProject(before)));
  set((state) => ({
    project: after,
    history: pushHistory(state.history, label, before, after),
    alignmentProposal: after.alignmentProposal,
    projectContentRevision: state.projectContentRevision + 1,
    selection: selection ?? state.selection,
    exportDraft: null
  }));
}

export function mergeRehydratedManualVerificationMaps(
  currentProject: EditorProject,
  openedSnapshot: EditorProject,
  rehydratedSnapshot: EditorProject
): { project: EditorProject; restoredCount: number } {
  const openedById = new Map(openedSnapshot.mediaTimeMaps.map((map) => [map.id, map]));
  const rehydratedById = new Map(rehydratedSnapshot.mediaTimeMaps.map((map) => [map.id, map]));
  let restoredCount = 0;
  const mediaTimeMaps = currentProject.mediaTimeMaps.map((currentMap) => {
    const openedMap = openedById.get(currentMap.id);
    const rehydratedMap = rehydratedById.get(currentMap.id);
    if (
      !openedMap ||
      !rehydratedMap ||
      !hasSameManualVerificationHydrationInput(currentMap, openedMap)
    ) {
      return currentMap;
    }
    if (rehydratedMap.quality.level === "verified") {
      restoredCount += 1;
    }
    return rehydratedMap;
  });
  return { project: { ...currentProject, mediaTimeMaps }, restoredCount };
}

export function hasSameManualVerificationHydrationInput(
  currentMap: EditorProject["mediaTimeMaps"][number],
  openedMap: EditorProject["mediaTimeMaps"][number]
): boolean {
  return (
    currentMap.revision === openedMap.revision &&
    currentMap.state === openedMap.state &&
    currentMap.updatedAt === openedMap.updatedAt &&
    computeMediaTimeMapCoreDigest(currentMap) === computeMediaTimeMapCoreDigest(openedMap) &&
    JSON.stringify(currentMap.verification) === JSON.stringify(openedMap.verification)
  );
}

export function revokeProjectObjectUrls(project: EditorProject): void {
  const urls = new Set<string>();
  if (project.media?.objectUrl) {
    urls.add(project.media.objectUrl);
  }
  project.mediaLibrary.forEach((media) => {
    if (media.objectUrl) {
      urls.add(media.objectUrl);
    }
  });
  urls.forEach((url) => revokeObjectUrl(url));
}

export function revokeObjectUrlIfUnused(
  project: EditorProject,
  objectUrl: string | null,
  removedMediaId: string
): void {
  if (!objectUrl) {
    return;
  }
  const stillUsed = project.mediaLibrary.some(
    (media) => media.id !== removedMediaId && media.objectUrl === objectUrl
  );
  if (!stillUsed) {
    revokeObjectUrl(objectUrl);
  }
}

export function toLegacyMediaReference(media: ProjectMediaReference): MediaReference {
  return {
    id: media.id,
    name: media.name,
    fileName: media.fileName,
    objectUrl: media.objectUrl,
    durationMs: media.durationMs
  };
}

export function upsertMediaById(
  mediaLibrary: readonly ProjectMediaReference[],
  media: ProjectMediaReference
): ProjectMediaReference[] {
  const exists = mediaLibrary.some((candidate) => candidate.id === media.id);
  if (!exists) {
    return [...mediaLibrary, media];
  }
  return mediaLibrary.map((candidate) => (candidate.id === media.id ? media : candidate));
}

export function createBindingMediaId(binding: MediaBinding): string {
  if (binding.kind === "localFile" && binding.mediaId) {
    return binding.mediaId;
  }
  return `media_${binding.id}`;
}

export function createAlignmentProposalPreviewStatus(
  proposal: AlignmentProposal
): EditorStatus {
  return {
    message: `已发送到时间轴预览：${proposal.anchors.length} 个同步线索，${proposal.cutCandidates.length} 个候选版本差异。`,
    tone: "success"
  };
}

export function isSameAlignmentProposal(
  current: AlignmentProposal | null,
  next: AlignmentProposal
): boolean {
  return current
    ? serializeAlignmentProposal(current) === serializeAlignmentProposal(next)
    : false;
}

export function createOpenProjectStatus(
  projectName: string,
  migration: ProjectSchemaMigration | null
): EditorStatus {
  if (!migration) {
    return { message: `已打开项目：${projectName}`, tone: "success" };
  }
  const adjustedClipRangeSuffix =
    migration.adjustedClipRangeCount > 0
      ? `，并兼容调整 ${migration.adjustedClipRangeCount} 个片段边界`
      : "";
  return {
    message: `已打开旧版项目：${projectName}。已从 v${migration.fromVersion} 升级到 v${migration.toVersion}${adjustedClipRangeSuffix}。`,
    tone: migration.adjustedClipRangeCount > 0 ? "warning" : "success"
  };
}

export function createErrorStatus(prefix: string, error: unknown): EditorStatus {
  if (error instanceof Error && error.message.trim().length > 0) {
    return { message: `${prefix}：${error.message}`, tone: "error" };
  }
  return { message: `${prefix}。`, tone: "error" };
}

export function formatDurationForStatus(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1_000).toFixed(3)} 秒`;
}

export function createSourceFileErrorStatus(
  prefix: string,
  fallbackMessage: string,
  error: unknown,
  sourceFileName?: string
): EditorStatus {
  const detail =
    error instanceof Error && error.message.trim().length > 0 ? error.message : fallbackMessage;
  if (!sourceFileName) {
    return { message: detail, tone: "error" };
  }
  if (detail.includes(sourceFileName)) {
    return { message: `${prefix}：${detail}`, tone: "error" };
  }
  return { message: `${prefix}：${sourceFileName}：${detail}`, tone: "error" };
}

export function createClipFromAsset(
  asset: DanmakuAsset,
  timelineStartMs: Milliseconds
): DanmakuClip {
  const range = getAssetTimeRange(asset);
  const knownDuration = getKnownBilibiliDuration(asset);
  return {
    id: createId("clip"),
    assetId: asset.id,
    name: asset.name,
    timelineStartMs: clampMilliseconds(timelineStartMs),
    sourceInMs: knownDuration !== null ? 0 : range.earliestMs,
    sourceOutMs: Math.max(knownDuration ?? 0, range.latestMs + 1, range.earliestMs + 1),
    localOffsetMs: 0,
    enabled: true
  };
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (!seen.has(value.id)) {
      seen.add(value.id);
      result.push(value);
    }
  }
  return result;
}

export function createSelection(kind: EditorSelection["kind"], ids: string[]): EditorSelection {
  return ids.length > 0 ? { kind, ids } : emptySelection;
}

export function toggleSelectionId(
  selection: EditorSelection,
  kind: EditorSelection["kind"],
  id: string,
  additive: boolean
): { selection: EditorSelection } {
  if (!additive || selection.kind !== kind) {
    return { selection: { kind, ids: [id] } };
  }
  const exists = selection.ids.includes(id);
  const ids = exists
    ? selection.ids.filter((candidate) => candidate !== id)
    : [...selection.ids, id];
  return { selection: ids.length > 0 ? { kind, ids } : emptySelection };
}

export function getClipVisualStartMs(clip: DanmakuClip): Milliseconds {
  return clip.timelineStartMs + clip.localOffsetMs;
}

export function getClipVisualEndMs(clip: DanmakuClip): Milliseconds {
  return getClipVisualStartMs(clip) + getClipDurationMs(clip);
}

export function isTimeInsideClipBody(timeMs: Milliseconds, clip: DanmakuClip): boolean {
  return timeMs > getClipVisualStartMs(clip) && timeMs < getClipVisualEndMs(clip);
}

export function splitClip(
  clip: DanmakuClip,
  splitAtMs: Milliseconds
): { left: DanmakuClip; right: DanmakuClip } | null {
  if (!isTimeInsideClipBody(splitAtMs, clip)) {
    return null;
  }
  const sourceSplitMs = clip.sourceInMs + Math.round(splitAtMs - getClipVisualStartMs(clip));
  if (sourceSplitMs <= clip.sourceInMs || sourceSplitMs >= clip.sourceOutMs) {
    return null;
  }
  const left: DanmakuClip = {
    ...clip,
    name: `${clip.name} A`,
    sourceOutMs: sourceSplitMs
  };
  const right: DanmakuClip = {
    ...clip,
    id: createId("clip"),
    name: `${clip.name} B`,
    timelineStartMs: clampMilliseconds(splitAtMs - clip.localOffsetMs),
    sourceInMs: sourceSplitMs
  };
  return { left, right };
}

export function mergeAdjacentClips(clips: DanmakuClip[]): DanmakuClip | null {
  if (clips.length < 2) {
    return null;
  }
  const [first, ...rest] = clips;
  let sourceOutMs = first.sourceOutMs;
  let enabled = first.enabled;
  let previous = first;
  for (const current of rest) {
    const timelineContinuous =
      Math.abs(getClipVisualEndMs(previous) - getClipVisualStartMs(current)) <= 1;
    const sourceContinuous = Math.abs(previous.sourceOutMs - current.sourceInMs) <= 1;
    if (current.assetId !== first.assetId || !timelineContinuous || !sourceContinuous) {
      return null;
    }
    sourceOutMs = current.sourceOutMs;
    enabled = enabled && current.enabled;
    previous = current;
  }
  return {
    ...first,
    name: first.name.replace(/\s+[AB]$/, ""),
    sourceOutMs,
    enabled
  };
}

export function findDanmakuItem(project: EditorProject, itemId: string): DanmakuItem | null {
  for (const asset of project.assets) {
    const item = asset.items.find((candidate) => candidate.id === itemId);
    if (item) {
      return item;
    }
  }
  return null;
}

export function findResolvedEvent(
  project: EditorProject,
  itemId: string
): ResolvedDanmakuEvent | null {
  return resolveProjectDanmakuEvents(project).find((event) => event.item.id === itemId) ?? null;
}
