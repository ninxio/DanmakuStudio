import type { StateCreator } from "zustand";
import {
  createInitialProjectLibrarySessionState,
  replacesCurrentProject
} from "../../application/projectLibrarySessionController";
import type { EditorStore } from "../editorStoreTypes";

export type ProjectLibrarySlice = Pick<
  EditorStore,
  | "projectContentRevision"
  | "projectLibrary"
  | "projectLibraryIntentSequence"
  | "projectLibraryIntent"
  | "applyProjectLibraryState"
  | "requestProjectLibrary"
  | "acknowledgeProjectLibraryIntent"
>;

export const createProjectLibrarySlice: StateCreator<
  EditorStore,
  [],
  [],
  ProjectLibrarySlice
> = (set) => ({
  projectContentRevision: 0,
  projectLibrary: createInitialProjectLibrarySessionState(),
  projectLibraryIntentSequence: 0,
  projectLibraryIntent: null,

  applyProjectLibraryState: (projectLibrary) => set({ projectLibrary }),

  requestProjectLibrary: (intent) => {
    set((state) => ({
      projectLibrary:
        state.projectLibrary.availability === "ready" && replacesCurrentProject(intent)
          ? { ...state.projectLibrary, switchingProject: true }
          : state.projectLibrary,
      projectLibraryIntentSequence: state.projectLibraryIntentSequence + 1,
      projectLibraryIntent: {
        sequence: state.projectLibraryIntentSequence + 1,
        intent
      }
    }));
  },

  acknowledgeProjectLibraryIntent: (sequence) => {
    set((state) =>
      state.projectLibraryIntent?.sequence === sequence ? { projectLibraryIntent: null } : {}
    );
  }
});
