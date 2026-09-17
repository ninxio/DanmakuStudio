import { create } from "zustand";
import type { EditorStore } from "./editorStoreTypes";
import { createSessionSlice } from "./slices/sessionSlice";
import { createMaterialsSlice } from "./slices/materialsSlice";
import { createMatchingSlice } from "./slices/matchingSlice";
import { createEditingSlice } from "./slices/editingSlice";
import { createHistorySlice } from "./slices/historySlice";
import { createExportSlice } from "./slices/exportSlice";
import { createMediaInventorySlice } from "./slices/mediaInventorySlice";
import { createProjectLibrarySlice } from "./slices/projectLibrarySlice";

export type {
  TimelineTool,
  ExportDraft,
  EditorStatus,
  CutMarkerDraft,
  WorkspacePage,
  EditorStore
} from "./editorStoreTypes";

export { findDanmakuItem, findResolvedEvent } from "./editorStoreHelpers";

export const useEditorStore = create<EditorStore>()((...args) => ({
  ...createSessionSlice(...args),
  ...createProjectLibrarySlice(...args),
  ...createMaterialsSlice(...args),
  ...createMediaInventorySlice(...args),
  ...createHistorySlice(...args),
  ...createMatchingSlice(...args),
  ...createEditingSlice(...args),
  ...createExportSlice(...args)
}));
