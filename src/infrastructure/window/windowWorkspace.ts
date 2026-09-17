import { fitWindowToWorkArea } from "./windowWorkspaceGeometry";
import type { WindowGeometry, WindowPosition, WindowSize } from "./windowWorkspaceGeometry";

export interface WindowPresentation {
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

export interface WindowWorkspaceDriver {
  readPresentation: () => Promise<WindowPresentation>;
  readGeometry: () => Promise<WindowGeometry | null>;
  setMinimumSize: (size: WindowSize) => Promise<void>;
  setSize: (size: WindowSize) => Promise<void>;
  setPosition: (position: WindowPosition) => Promise<void>;
  subscribe: (changed: () => void) => Promise<() => void>[];
}

interface WindowWorkspaceOptions {
  onMaximizedChange: (maximized: boolean) => void;
  onError: (error: unknown) => void;
}

/** One check after a quiet native move/resize burst; never polls or drives the native drag loop. */
export function observeWindowWorkspace(
  driver: WindowWorkspaceDriver,
  options: WindowWorkspaceOptions
): () => void {
  let disposed = false;
  let generation = 0;
  let running = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let minimumSize: WindowSize | undefined;
  let lastError: string | undefined;
  const listeners: (() => void)[] = [];

  const reportError = (error: unknown) => {
    if (disposed) return;
    const message = String(error);
    if (message !== lastError) options.onError(error);
    lastError = message;
  };

  const check = async () => {
    timer = undefined;
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    const version = generation;
    const stale = () => disposed || version !== generation;
    try {
      const presentation = await driver.readPresentation();
      if (stale()) return;
      options.onMaximizedChange(presentation.maximized);
      // Inactive windows can still be in a system move/activation transition. Wait for focus.
      if (
        presentation.maximized ||
        presentation.minimized ||
        presentation.fullscreen ||
        !presentation.focused
      )
        return;
      const geometry = await driver.readGeometry();
      if (stale() || !geometry) return;
      const fit = fitWindowToWorkArea(geometry);
      if (!fit) return;
      if (
        minimumSize?.width !== fit.minimumSize.width ||
        minimumSize.height !== fit.minimumSize.height
      ) {
        await driver.setMinimumSize(fit.minimumSize);
        minimumSize = fit.minimumSize;
      }
      if (stale()) return;
      if (fit.size) await driver.setSize(fit.size);
      if (stale()) return;
      if (fit.position) await driver.setPosition(fit.position);
      lastError = undefined;
    } catch (error) {
      reportError(error);
    } finally {
      running = false;
      if (pending && !disposed) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (disposed) return;
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void check();
    }, 200);
  };

  // Listener registration is asynchronous; a late registration must still be removed after unmount.
  for (const registration of driver.subscribe(schedule)) {
    void registration
      .then((unlisten) => {
        if (disposed) unlisten();
        else listeners.push(unlisten);
      })
      .catch(reportError);
  }
  void check();

  return () => {
    disposed = true;
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    for (const unlisten of listeners) unlisten();
  };
}
