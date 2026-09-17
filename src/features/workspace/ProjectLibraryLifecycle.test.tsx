import { act, StrictMode } from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { createInitialProjectLibrarySessionState } from "../../application/projectLibrarySessionController";
import type * as ProjectLibraryControllerModule from "../../application/projectLibrarySessionController";
import { useEditorStore } from "../../stores/editorStore";
import { ProjectLibraryLifecycle } from "./ProjectLibraryLifecycle";

type CloseRequestHandler = (event: { preventDefault: () => void }) => Promise<void> | void;

const lifecycleMocks = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  dispatch: vi.fn<() => Promise<void>>(),
  observeProject: vi.fn(),
  close: vi.fn<() => Promise<boolean>>(),
  createController: vi.fn(),
  closeHandler: null as CloseRequestHandler | null,
  invoke: vi.fn<(command: string) => Promise<void>>(),
  unlisten: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: lifecycleMocks.invoke
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn((handler: CloseRequestHandler) => {
      lifecycleMocks.closeHandler = handler;
      return Promise.resolve(lifecycleMocks.unlisten);
    })
  })
}));
vi.mock("../../application/projectLibrarySessionController", async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectLibraryControllerModule>();
  return {
    ...actual,
    createProjectLibrarySessionController: lifecycleMocks.createController
  };
});

describe("ProjectLibraryLifecycle", () => {
  beforeEach(() => {
    lifecycleMocks.start.mockReset().mockResolvedValue(undefined);
    lifecycleMocks.dispatch.mockReset().mockResolvedValue(undefined);
    lifecycleMocks.observeProject.mockReset();
    lifecycleMocks.close.mockReset().mockResolvedValue(true);
    lifecycleMocks.createController.mockReset().mockReturnValue({
      start: lifecycleMocks.start,
      dispatch: lifecycleMocks.dispatch,
      observeProject: lifecycleMocks.observeProject,
      close: lifecycleMocks.close
    });
    lifecycleMocks.invoke.mockReset().mockResolvedValue(undefined);
    lifecycleMocks.unlisten.mockReset();
    lifecycleMocks.closeHandler = null;
    useEditorStore.setState({
      project: createEmptyProject("生命周期项目"),
      projectContentRevision: 0,
      projectLibrary: createInitialProjectLibrarySessionState(),
      projectLibraryIntentSequence: 0,
      projectLibraryIntent: null
    });
  });

  it("StrictMode 下只启动一个 controller，并只观察领域内容修订", async () => {
    render(
      <StrictMode>
        <ProjectLibraryLifecycle />
      </StrictMode>
    );

    await waitFor(() => expect(lifecycleMocks.start).toHaveBeenCalledOnce());
    expect(lifecycleMocks.createController).toHaveBeenCalledOnce();
    expect(lifecycleMocks.observeProject).not.toHaveBeenCalled();

    act(() => {
      useEditorStore.setState((state) => ({
        project: { ...state.project, name: "领域修改" },
        projectContentRevision: 1
      }));
    });
    expect(lifecycleMocks.observeProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "领域修改" }),
      1
    );

    act(() => {
      useEditorStore.getState().requestProjectLibrary({ kind: "createProject" });
    });
    await waitFor(() =>
      expect(lifecycleMocks.dispatch).toHaveBeenCalledWith({ kind: "createProject" })
    );
    expect(useEditorStore.getState().projectLibraryIntent).toBeNull();
  });

  it("窗口退出先阻止默认关闭，controller clean close 成功后才退出应用", async () => {
    render(<ProjectLibraryLifecycle />);
    await waitFor(() => expect(lifecycleMocks.closeHandler).not.toBeNull());
    const preventDefault = vi.fn();

    await lifecycleMocks.closeHandler?.({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(lifecycleMocks.close).toHaveBeenCalledOnce();
    expect(lifecycleMocks.invoke).toHaveBeenCalledOnce();
    expect(lifecycleMocks.invoke).toHaveBeenCalledWith("exit_app");

    lifecycleMocks.close.mockResolvedValueOnce(false);
    await lifecycleMocks.closeHandler?.({ preventDefault });
    expect(lifecycleMocks.invoke).toHaveBeenCalledOnce();
  });
});
