import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import {
  createInitialProjectLibrarySessionState,
  createProjectLibrarySessionController,
  type ProjectLibrarySessionController
} from "../../application/projectLibrarySessionController";
import { useEditorStore } from "../../stores/editorStore";

let sharedDesktopController: ProjectLibrarySessionController | null = null;
let sharedControllerStarted = false;
let lifecycleMountCount = 0;

export function ProjectLibraryLifecycle() {
  const contentRevision = useEditorStore((state) => state.projectContentRevision);
  const intentRequest = useEditorStore((state) => state.projectLibraryIntent);
  const controllerRef = useRef<ProjectLibrarySessionController | null>(null);
  const desktop = isTauri();

  if (desktop && controllerRef.current === null) {
    if (sharedDesktopController === null) {
      sharedDesktopController = createProjectLibrarySessionController({
        publish: (projectLibrary) => {
          useEditorStore.getState().applyProjectLibraryState(projectLibrary);
        },
        applyProject: (result, context) => {
          useEditorStore.getState().openProjectFromLibrary(result, context);
        }
      });
    }
    controllerRef.current = sharedDesktopController;
  }

  useEffect(() => {
    if (!desktop) {
      useEditorStore.getState().applyProjectLibraryState({
        ...createInitialProjectLibrarySessionState(),
        availability: "browser",
        message: "浏览器模式使用项目备份文件；自动保存与最近项目仅在桌面版可用。"
      });
      return;
    }
    const controller = controllerRef.current;
    lifecycleMountCount += 1;
    if (controller && !sharedControllerStarted) {
      sharedControllerStarted = true;
      void controller.start();
    }
    return () => {
      queueMicrotask(() => {
        lifecycleMountCount = Math.max(0, lifecycleMountCount - 1);
        if (lifecycleMountCount === 0 && sharedDesktopController === controller) {
          sharedDesktopController = null;
          sharedControllerStarted = false;
        }
      });
    };
  }, [desktop]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || contentRevision <= 0) return;
    controller.observeProject(useEditorStore.getState().project, contentRevision);
  }, [contentRevision]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !intentRequest) return;
    useEditorStore.getState().acknowledgeProjectLibraryIntent(intentRequest.sequence);
    void controller.dispatch(intentRequest.intent);
  }, [intentRequest]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!desktop || !controller) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (await controller.close()) {
          await invoke("exit_app");
        }
      })
      .then((disposeListener) => {
        if (disposed) {
          disposeListener();
        } else {
          unlisten = disposeListener;
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  return null;
}
