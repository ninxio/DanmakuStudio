import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { availableMonitors, currentMonitor } from "@tauri-apps/api/window";
import type { Window } from "@tauri-apps/api/window";
import { observeWindowWorkspace } from "./windowWorkspace";
import { nearestWorkArea, type WindowWorkArea } from "./windowWorkspaceGeometry";

export function observeDesktopWindowWorkspace(
  appWindow: Window,
  onMaximizedChange: (maximized: boolean) => void,
  onError: (error: unknown) => void
): () => void {
  return observeWindowWorkspace(
    {
      readPresentation: async () => {
        const [maximized, minimized, fullscreen, focused] = await Promise.all([
          appWindow.isMaximized(),
          appWindow.isMinimized(),
          appWindow.isFullscreen(),
          appWindow.isFocused()
        ]);
        return { maximized, minimized, fullscreen, focused };
      },
      readGeometry: async () => {
        const [position, outerSize, innerSize, monitor, scaleFactor] = await Promise.all([
          appWindow.outerPosition(),
          appWindow.outerSize(),
          appWindow.innerSize(),
          currentMonitor(),
          appWindow.scaleFactor()
        ]);
        let workArea: WindowWorkArea | null = monitor
          ? { ...monitor.workArea.position, ...monitor.workArea.size }
          : null;
        if (!workArea) {
          const monitors = await availableMonitors();
          workArea = nearestWorkArea(
            position,
            outerSize,
            monitors.map((candidate) => ({
              ...candidate.workArea.position,
              ...candidate.workArea.size
            }))
          );
        }
        return workArea ? { position, outerSize, innerSize, workArea, scaleFactor } : null;
      },
      setMinimumSize: (size) => appWindow.setMinSize(new PhysicalSize(size.width, size.height)),
      setSize: (size) => appWindow.setSize(new PhysicalSize(size.width, size.height)),
      setPosition: (position) =>
        appWindow.setPosition(new PhysicalPosition(position.x, position.y)),
      subscribe: (changed) => [
        appWindow.onMoved(changed),
        appWindow.onResized(changed),
        appWindow.onScaleChanged(changed),
        appWindow.onFocusChanged(changed)
      ]
    },
    { onMaximizedChange, onError }
  );
}
