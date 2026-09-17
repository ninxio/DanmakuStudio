import type { StateCreator } from "zustand";
import {
  TIMELINE_MAX_PIXELS_PER_SECOND,
  TIMELINE_MIN_PIXELS_PER_SECOND
} from "../../domain/timeline/view";
import {
  getProjectDurationMs,
  resolveProjectDanmakuEvents
} from "../../domain/timeline/mapping";
import { clamp, clampMilliseconds } from "../../domain/shared/time";
import { DEFAULT_CUT_HINT_SEARCH_SETTINGS } from "../../domain/danmaku/cutHints";
import type { EditorStore } from "../editorStoreTypes";
import { emptySelection, toggleSelectionId, unique } from "../editorStoreHelpers";

export type SessionSlice = Pick<
  EditorStore,
  | "selection"
  | "isPlaying"
  | "status"
  | "importProgress"
  | "cutHintSettings"
  | "timelineTool"
  | "workspacePage"
  | "workspaceIntentSequence"
  | "workspaceIntentRequest"
  | "alignmentEditorCandidateId"
  | "projectEpoch"
  | "setWorkspacePage"
  | "requestWorkspaceIntent"
  | "acknowledgeWorkspaceIntent"
  | "selectAlignmentEditorCandidate"
  | "select"
  | "clearSelection"
  | "selectAllClips"
  | "toggleDanmakuSelection"
  | "toggleClipSelection"
  | "toggleCutSelection"
  | "selectDanmakuRange"
  | "setPlayhead"
  | "setPlaying"
  | "togglePlayback"
  | "setTimelineScroll"
  | "setTimelineZoom"
  | "fitTimelineToContent"
  | "setTimelineTool"
  | "setCutHintSettings"
>;

export const createSessionSlice: StateCreator<EditorStore, [], [], SessionSlice> = (
  set,
  get
) => ({
  selection: emptySelection,
  isPlaying: false,
  status: { message: "准备就绪", tone: "neutral" },
  importProgress: null,
  cutHintSettings: { ...DEFAULT_CUT_HINT_SEARCH_SETTINGS },
  timelineTool: "select",
  workspacePage: "materials",
  workspaceIntentSequence: 0,
  workspaceIntentRequest: null,
  alignmentEditorCandidateId: null,
  projectEpoch: 0,

  setWorkspacePage: (page) => set({ workspacePage: page }),

  requestWorkspaceIntent: (intent) => {
    set((state) => {
      const sequence = state.workspaceIntentSequence + 1;
      return {
        workspacePage: intent.page,
        workspaceIntentSequence: sequence,
        workspaceIntentRequest: { sequence, intent }
      };
    });
  },

  acknowledgeWorkspaceIntent: (sequence) => {
    set((state) =>
      state.workspaceIntentRequest?.sequence === sequence
        ? { workspaceIntentRequest: null }
        : {}
    );
  },

  selectAlignmentEditorCandidate: (candidateId) => {
    const candidate = get().project.mediaMatchCandidates.find(
      (item) => item.id === candidateId && item.state !== "rejected"
    );
    if (!candidate) {
      set({ status: { message: "这条匹配关系已经不存在。", tone: "warning" } });
      return;
    }
    set({ alignmentEditorCandidateId: candidateId });
  },

  select: (selection) => set({ selection }),

  clearSelection: () => set({ selection: emptySelection }),

  selectAllClips: () => {
    const ids = get().project.clips.map((clip) => clip.id);
    set({
      selection: ids.length > 0 ? { kind: "clip", ids } : emptySelection,
      status:
        ids.length > 0
          ? { message: `已选择 ${ids.length} 个时间轴片段。`, tone: "success" }
          : { message: "当前没有可选择的时间轴片段。", tone: "warning" }
    });
  },

  toggleDanmakuSelection: (itemId, additive) => {
    set((state) => {
      if (!additive || state.selection.kind !== "danmaku") {
        return { selection: { kind: "danmaku", ids: [itemId] } };
      }
      const exists = state.selection.ids.includes(itemId);
      const ids = exists
        ? state.selection.ids.filter((candidate) => candidate !== itemId)
        : [...state.selection.ids, itemId];
      return { selection: ids.length > 0 ? { kind: "danmaku", ids } : emptySelection };
    });
  },

  toggleClipSelection: (clipId, additive) => {
    set((state) => toggleSelectionId(state.selection, "clip", clipId, additive));
  },

  toggleCutSelection: (cutId, additive) => {
    set((state) => toggleSelectionId(state.selection, "cut", cutId, additive));
  },

  selectDanmakuRange: (startMs, endMs, additive) => {
    const events = resolveProjectDanmakuEvents(get().project);
    const min = Math.min(startMs, endMs);
    const max = Math.max(startMs, endMs);
    const ids = events
      .filter((event) => event.enabled && event.finalTimeMs >= min && event.finalTimeMs <= max)
      .map((event) => event.item.id);
    set((state) => ({
      selection: {
        kind: "danmaku",
        ids:
          additive && state.selection.kind === "danmaku"
            ? unique([...state.selection.ids, ...ids])
            : unique(ids)
      }
    }));
  },

  setPlayhead: (timeMs) => {
    const rounded = clampMilliseconds(timeMs);
    if (rounded === get().project.timeline.playheadMs) return;
    set((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          playheadMs: clampMilliseconds(clamp(timeMs, 0, getProjectDurationMs(state.project)))
        }
      }
    }));
  },

  setPlaying: (playing) => set({ isPlaying: playing }),

  togglePlayback: () => set((state) => ({ isPlaying: !state.isPlaying })),

  setTimelineScroll: (scrollMs) => {
    set((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          scrollMs: clampMilliseconds(scrollMs)
        }
      }
    }));
  },

  setTimelineZoom: (pixelsPerSecond, anchorTimeMs, anchorRatio) => {
    set((state) => {
      const nextPps = clamp(
        pixelsPerSecond,
        TIMELINE_MIN_PIXELS_PER_SECOND,
        TIMELINE_MAX_PIXELS_PER_SECOND
      );
      const timeline = state.project.timeline;
      const nextScroll =
        anchorTimeMs !== undefined && anchorRatio !== undefined
          ? clampMilliseconds(anchorTimeMs - (anchorRatio * 1000) / nextPps)
          : timeline.scrollMs;
      return {
        project: {
          ...state.project,
          timeline: {
            ...timeline,
            pixelsPerSecond: nextPps,
            scrollMs: nextScroll
          }
        }
      };
    });
  },

  fitTimelineToContent: (viewportWidthPx) => {
    const project = get().project;
    const duration = getProjectDurationMs(project);
    const visibleWidthPx = Math.max(240, viewportWidthPx ?? 1200);
    set((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          scrollMs: 0,
          pixelsPerSecond: clamp(
            (visibleWidthPx * 0.96) / (duration / 1000),
            TIMELINE_MIN_PIXELS_PER_SECOND,
            TIMELINE_MAX_PIXELS_PER_SECOND
          )
        }
      },
      status: { message: "已缩放到全部内容。", tone: "success" }
    }));
  },

  setTimelineTool: (tool) => {
    set({
      timelineTool: tool,
      status: {
        message: tool === "select" ? "已切换到选择工具。" : "已切换到剪刀工具。",
        tone: "neutral"
      }
    });
  },

  setCutHintSettings: (settings) => {
    set((state) => ({
      cutHintSettings: {
        ...state.cutHintSettings,
        ...settings
      }
    }));
  }
});
