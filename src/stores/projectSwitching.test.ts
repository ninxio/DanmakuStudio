import { afterEach, expect, it } from "vitest";
import { createInitialProjectLibrarySessionState } from "../application/projectLibrarySessionController";
import { createEmptyProject } from "../domain/project/factory";
import { useEditorStore } from "./editorStore";

afterEach(() =>
  useEditorStore.setState({
    projectLibrary: createInitialProjectLibrarySessionState(),
    projectLibraryIntent: null
  })
);

it("desktop new-project requests a library transition before imports and edits can commit", async () => {
  const project = createEmptyProject("existing project");
  useEditorStore.setState({
    project,
    projectLibrary: { ...createInitialProjectLibrarySessionState(), availability: "ready" }
  });
  useEditorStore.getState().newProject();
  expect(useEditorStore.getState().project).toBe(project);
  expect(useEditorStore.getState().projectLibraryIntent?.intent.kind).toBe("createProject");
  expect(useEditorStore.getState().projectLibrary.switchingProject).toBe(true);
  await useEditorStore
    .getState()
    .importXmlFiles([
      new File(['<i><d p="1,1,25,16777215,0,0,u,1">sample</d></i>'], "S01E01.xml")
    ]);
  useEditorStore.getState().importMediaPaths(["C:/sample.mp4"], "bilibiliReference");
  useEditorStore.getState().renameProject("wrong session");
  expect(useEditorStore.getState().project).toBe(project);
});
