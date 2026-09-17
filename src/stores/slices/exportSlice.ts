import type { StateCreator } from "zustand";
import { prepareExportDraft } from "../../application/exportProjectCommands";
import type { EditorStore } from "../editorStoreTypes";

export type ExportSlice = Pick<EditorStore, "exportDraft" | "prepareExport" | "clearExport">;

export const createExportSlice: StateCreator<EditorStore, [], [], ExportSlice> = (set, get) => ({
  exportDraft: null,

  prepareExport: () => {
    const result = prepareExportDraft(get().project);
    set({
      exportDraft: result.exportDraft,
      status: result.status
    });
  },

  clearExport: () => set({ exportDraft: null })
});