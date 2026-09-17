import type { StateCreator } from "zustand";
import {
  applyAudioTrackIntentCommand,
  evaluateAudioTrackPreparation,
  type AudioTrackInventoryObservation,
  type AudioTrackPreparation
} from "../../domain/project/audioTrackPreparation";
import type { ProjectMediaReference } from "../../domain/project/types";
import { touchProject } from "../../domain/project/factory";
import type {
  MediaInventoryGenerationKey,
  MediaInventoryPublication
} from "../../application/mediaInventorySupervisor";
import { commitProject } from "../editorStoreHelpers";
import type { EditorStore, MediaInventorySessionRow } from "../editorStoreTypes";

export type MediaInventorySlice = Pick<
  EditorStore,
  | "mediaInventoryGeneration"
  | "mediaInventoryGenerationKey"
  | "mediaInventoryPhase"
  | "mediaInventoryCounts"
  | "mediaInventoryRows"
  | "mediaInventoryPaused"
  | "mediaInventoryCancelling"
  | "mediaInventoryRestartRequired"
  | "mediaInventoryTerminalMessage"
  | "synchronizeMediaInventory"
  | "refreshMediaInventory"
  | "cancelMediaInventory"
  | "applyMediaInventoryPublication"
  | "setMediaAudioTrackIntent"
  | "getMediaAudioTrackPreparation"
>;

export const createMediaInventorySlice: StateCreator<
  EditorStore,
  [],
  [],
  MediaInventorySlice
> = (set, get) => ({
  mediaInventoryGeneration: 0,
  mediaInventoryGenerationKey: null,
  mediaInventoryPhase: "idle",
  mediaInventoryCounts: null,
  mediaInventoryRows: {},
  mediaInventoryPaused: false,
  mediaInventoryCancelling: false,
  mediaInventoryRestartRequired: false,
  mediaInventoryTerminalMessage: null,

  synchronizeMediaInventory: () => {
    const state = get();
    const mediaSignature = createMediaInventorySignature(state.project.mediaLibrary);
    const current = state.mediaInventoryGenerationKey;
    if (
      current !== null &&
      current.projectId === state.project.id &&
      current.projectEpoch === state.projectEpoch &&
      current.mediaSignature === mediaSignature
    ) {
      return current;
    }
    return advanceGeneration(set, state, mediaSignature);
  },

  refreshMediaInventory: () => {
    const state = get();
    const mediaSignature = createMediaInventorySignature(state.project.mediaLibrary);
    advanceGeneration(set, state, mediaSignature);
    set({ status: { message: "正在重新准备音轨…", tone: "neutral" } });
  },

  cancelMediaInventory: () => {
    set(() => ({
      mediaInventoryPaused: true,
      mediaInventoryCancelling: true,
      status: { message: "正在取消音轨准备…", tone: "neutral" }
    }));
  },

  applyMediaInventoryPublication: (publication) => {
    set((state) => {
      if (!isCurrentPublication(state, publication)) return {};
      const terminal =
        publication.phase === "completed" ||
        publication.phase === "cancelled" ||
        publication.phase === "failed";
      if (state.mediaInventoryPaused && !terminal) return {};
      const restartRequired =
        state.mediaInventoryRestartRequired || publication.restartRequired;
      const mediaIds = new Set(state.project.mediaLibrary.map((media) => media.id));
      let rows = state.mediaInventoryRows;
      let changed = false;
      for (const row of publication.changedRows) {
        if (!mediaIds.has(row.mediaId)) continue;
        if (!changed) {
          rows = { ...rows };
          changed = true;
        }
        rows[row.mediaId] = row;
      }
      // Inventory already probes lightweight metadata. Reuse its duration instead of
      // scaling an unopened original only to the last matched position.
      let durationChanged = false;
      const mediaLibrary = state.project.mediaLibrary.map((media) => {
        const row = rows[media.id];
        if (
          media.durationMs === null &&
          row?.status === "ready" &&
          row.durationMs !== null &&
          Number.isFinite(row.durationMs) &&
          row.durationMs > 0
        ) {
          durationChanged = true;
          return { ...media, durationMs: Math.round(row.durationMs) };
        }
        return media;
      });
      return {
        ...(durationChanged
          ? { project: touchProject({ ...state.project, mediaLibrary }) }
          : {}),
        mediaInventoryPhase: publication.phase,
        mediaInventoryCounts: { ...publication.counts },
        mediaInventoryRows: rows,
        mediaInventoryCancelling: terminal ? false : state.mediaInventoryCancelling,
        mediaInventoryRestartRequired: restartRequired,
        mediaInventoryTerminalMessage: state.mediaInventoryRestartRequired
          ? state.mediaInventoryTerminalMessage
          : publication.terminalMessage
      };
    });
  },

  setMediaAudioTrackIntent: (mediaId, command) => {
    const state = get();
    const media = state.project.mediaLibrary.find((candidate) => candidate.id === mediaId);
    if (!media) {
      set({ status: { message: "这项媒体已经不存在。", tone: "warning" } });
      return false;
    }
    let intent: ProjectMediaReference["audioTrackIntent"];
    try {
      intent = applyAudioTrackIntentCommand(getInventoryObservation(state, media), command);
    } catch (error: unknown) {
      set({
        status: {
          message: error instanceof Error ? error.message : String(error),
          tone: "warning"
        }
      });
      return false;
    }
    if (areAudioTrackIntentsEqual(media.audioTrackIntent, intent)) return true;

    const updatedAt = new Date().toISOString();
    commitProject(
      set,
      get,
      command.mode === "auto" ? "使用自动推荐音轨" : "选择媒体音轨",
      (project) => ({
        ...project,
        mediaLibrary: project.mediaLibrary.map((candidate) =>
          candidate.id === mediaId
            ? { ...candidate, audioTrackIntent: intent, updatedAt }
            : candidate
        )
      })
    );
    set({
      status: {
        message: command.mode === "auto" ? "已使用自动推荐音轨。" : "已保存音轨选择。",
        tone: "success"
      }
    });
    return true;
  },

  getMediaAudioTrackPreparation: (mediaId) => {
    const state = get();
    const media = state.project.mediaLibrary.find((candidate) => candidate.id === mediaId);
    if (!media) return null;
    return evaluateAudioTrackPreparation(
      media.audioTrackIntent,
      getInventoryObservation(state, media)
    );
  }
});

export function createMediaInventorySignature(
  mediaLibrary: readonly ProjectMediaReference[]
): string {
  const identity = [...mediaLibrary]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((media) => `${media.id.length}:${media.id}:${normalizeLocalPath(media.localPath)}`)
    .join("|");
  return `media-v1:${mediaLibrary.length}:${identity.length}:${hashText(identity, 0x811c9dc5)}${hashText(
    identity,
    0x9e3779b9
  )}`;
}

export function getMediaAudioTrackPreparation(
  media: ProjectMediaReference,
  row: MediaInventorySessionRow | undefined
): AudioTrackPreparation {
  return evaluateAudioTrackPreparation(
    media.audioTrackIntent,
    toInventoryObservation(media, row)
  );
}

function advanceGeneration(
  set: Parameters<StateCreator<EditorStore>>[0],
  state: EditorStore,
  mediaSignature: string
): MediaInventoryGenerationKey {
  const generationKey: MediaInventoryGenerationKey = {
    projectId: state.project.id,
    projectEpoch: state.projectEpoch,
    inventoryGeneration: state.mediaInventoryGeneration + 1,
    mediaSignature
  };
  set({
    mediaInventoryGeneration: generationKey.inventoryGeneration,
    mediaInventoryGenerationKey: generationKey,
    mediaInventoryPhase: "idle",
    mediaInventoryCounts: null,
    mediaInventoryRows: createInitialRows(state.project.mediaLibrary),
    mediaInventoryPaused: false,
    mediaInventoryCancelling: false,
    mediaInventoryRestartRequired: state.mediaInventoryRestartRequired,
    mediaInventoryTerminalMessage: state.mediaInventoryRestartRequired
      ? state.mediaInventoryTerminalMessage
      : null
  });
  return generationKey;
}

function createInitialRows(
  mediaLibrary: readonly ProjectMediaReference[]
): Record<string, MediaInventorySessionRow> {
  return Object.fromEntries(mediaLibrary.map((media) => [media.id, createInitialRow(media)]));
}

function createInitialRow(media: ProjectMediaReference): MediaInventorySessionRow {
  if (media.connectionState === "needsReconnect") {
    return { mediaId: media.id, status: "notEligible", reason: "needsReconnect" };
  }
  if (!media.localPath?.trim()) {
    return { mediaId: media.id, status: "notEligible", reason: "missingLocalPath" };
  }
  return { mediaId: media.id, status: "unobserved" };
}

function isCurrentPublication(
  state: EditorStore,
  publication: MediaInventoryPublication
): boolean {
  const current = state.mediaInventoryGenerationKey;
  return (
    current !== null &&
    current.projectId === publication.generationKey.projectId &&
    current.projectEpoch === publication.generationKey.projectEpoch &&
    current.inventoryGeneration === publication.generationKey.inventoryGeneration &&
    current.mediaSignature === publication.generationKey.mediaSignature &&
    state.project.id === current.projectId &&
    state.projectEpoch === current.projectEpoch &&
    createMediaInventorySignature(state.project.mediaLibrary) === current.mediaSignature
  );
}

function getInventoryObservation(
  state: EditorStore,
  media: ProjectMediaReference
): AudioTrackInventoryObservation {
  const current = state.mediaInventoryGenerationKey;
  const row =
    current !== null &&
    current.projectId === state.project.id &&
    current.projectEpoch === state.projectEpoch &&
    current.mediaSignature === createMediaInventorySignature(state.project.mediaLibrary)
      ? state.mediaInventoryRows[media.id]
      : undefined;
  return toInventoryObservation(media, row);
}

function toInventoryObservation(
  media: ProjectMediaReference,
  row: MediaInventorySessionRow | undefined
): AudioTrackInventoryObservation {
  if (media.connectionState === "needsReconnect") {
    return { state: "notEligible", reason: "needsReconnect" };
  }
  if (!media.localPath?.trim()) {
    return { state: "notEligible", reason: "missingLocalPath" };
  }
  if (!row || row.status === "unobserved") return { state: "unobserved" };
  if (row.status !== "ready") {
    if (row.status === "notEligible") {
      return { state: "notEligible", reason: row.reason };
    }
    if (row.status === "failed") {
      return { state: "failed", message: row.error.message };
    }
    return { state: row.status };
  }
  return {
    state: "ready",
    inventoryRevision: row.inventoryRevision,
    streamIndexes: row.audioTracks.map((track) => track.index),
    probeCompleteness: row.probeCompleteness,
    recommendation:
      row.recommendation.state === "recommended"
        ? {
            state: "recommended",
            streamIndex: row.recommendation.streamIndex
          }
        : {
            state: row.recommendation.state,
            streamIndex: null
          }
  };
}

function normalizeLocalPath(localPath: string | null): string {
  return localPath?.trim().replace(/\\/g, "/") ?? "<none>";
}

function hashText(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function areAudioTrackIntentsEqual(
  left: ProjectMediaReference["audioTrackIntent"],
  right: ProjectMediaReference["audioTrackIntent"]
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "auto" ||
      (right.mode === "explicit" &&
        left.streamIndex === right.streamIndex &&
        left.inventoryRevision === right.inventoryRevision))
  );
}
