import type { StateCreator } from "zustand";
import { createHistoryState, redoHistory, undoHistory } from "../../domain/history/history";
import type { EditorProject } from "../../domain/project/types";
import type { EditorStore } from "../editorStoreTypes";

export type HistorySlice = Pick<EditorStore, "history" | "undo" | "redo">;

export const createHistorySlice: StateCreator<EditorStore, [], [], HistorySlice> = (set) => ({
  history: createHistoryState<EditorProject>(),

  undo: () => {
    set((state) => {
      const result = undoHistory(state.history);
      if (!result.value) {
        return { status: { message: "没有可撤销的操作。", tone: "warning" } };
      }
      return {
        project: result.value,
        history: result.history,
        alignmentProposal: result.value.alignmentProposal,
        projectContentRevision: state.projectContentRevision + 1,
        status: { message: "已撤销。", tone: "success" }
      };
    });
  },

  redo: () => {
    set((state) => {
      const result = redoHistory(state.history);
      if (!result.value) {
        return { status: { message: "没有可重做的操作。", tone: "warning" } };
      }
      return {
        project: result.value,
        history: result.history,
        alignmentProposal: result.value.alignmentProposal,
        projectContentRevision: state.projectContentRevision + 1,
        status: { message: "已重做。", tone: "success" }
      };
    });
  },
});
