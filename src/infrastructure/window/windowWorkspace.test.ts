import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeWindowWorkspace } from "./windowWorkspace";
import type { WindowPresentation, WindowWorkspaceDriver } from "./windowWorkspace";
import type { WindowGeometry } from "./windowWorkspaceGeometry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let changed = () => {};
  const presentation: WindowPresentation = {
    maximized: false,
    minimized: false,
    fullscreen: false,
    focused: true
  };
  const geometry: WindowGeometry = {
    position: { x: 100, y: 100 },
    outerSize: { width: 1000, height: 700 },
    innerSize: { width: 1000, height: 700 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1
  };
  const unlisten = vi.fn();
  const driver = {
    readPresentation: vi.fn(() => Promise.resolve(presentation)),
    readGeometry: vi.fn((): Promise<WindowGeometry | null> => Promise.resolve(geometry)),
    setMinimumSize: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    subscribe: vi.fn((listener: () => void): Promise<() => void>[] => {
      changed = listener;
      return [Promise.resolve(unlisten)];
    })
  } satisfies WindowWorkspaceDriver;
  const options = { onMaximizedChange: vi.fn(), onError: vi.fn() };
  return { driver, options, presentation, geometry, unlisten, emit: () => changed() };
}

describe("native window workspace coordination", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks startup once and preserves a normal fitting window", async () => {
    const f = fixture();
    const dispose = observeWindowWorkspace(f.driver, f.options);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.driver.readGeometry).toHaveBeenCalledTimes(1);
    expect(f.driver.setMinimumSize).toHaveBeenCalledWith({ width: 720, height: 480 });
    expect(f.driver.setSize).not.toHaveBeenCalled();
    expect(f.driver.setPosition).not.toHaveBeenCalled();
    dispose();
    expect(f.unlisten).toHaveBeenCalledTimes(1);
  });

  it("coalesces a native drag burst and does not rewrite unchanged minimums", async () => {
    const f = fixture();
    const dispose = observeWindowWorkspace(f.driver, f.options);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i += 1) {
      f.emit();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(f.driver.readPresentation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.driver.readPresentation).toHaveBeenCalledTimes(2);
    expect(f.driver.setMinimumSize).toHaveBeenCalledTimes(1);
    dispose();
  });

  it.each(["maximized", "minimized", "fullscreen"] as const)(
    "never adjusts a %s window, and fits it on restore",
    async (state) => {
      const f = fixture();
      f.presentation[state] = true;
      f.geometry.innerSize.width = f.geometry.outerSize.width = 2400;
      const dispose = observeWindowWorkspace(f.driver, f.options);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.driver.readGeometry).not.toHaveBeenCalled();
      expect(f.options.onMaximizedChange).toHaveBeenLastCalledWith(state === "maximized");
      f.presentation[state] = false;
      f.emit();
      await vi.advanceTimersByTimeAsync(200);
      expect(f.driver.setSize).toHaveBeenCalledWith({ width: 1728, height: 700 });
      expect(f.driver.setPosition).not.toHaveBeenCalled();
      dispose();
    }
  );

  it("waits for focus before changing an inactive window", async () => {
    const f = fixture();
    f.presentation.focused = false;
    const dispose = observeWindowWorkspace(f.driver, f.options);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.driver.readGeometry).not.toHaveBeenCalled();
    f.presentation.focused = true;
    f.emit();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.driver.readGeometry).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("discards a geometry result superseded by a native move or state change", async () => {
    const f = fixture();
    const reading = deferred<WindowGeometry | null>();
    f.driver.readGeometry.mockReturnValueOnce(reading.promise);
    const dispose = observeWindowWorkspace(f.driver, f.options);
    await vi.advanceTimersByTimeAsync(0);
    f.presentation.maximized = true;
    f.emit();
    reading.resolve(f.geometry);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.driver.setMinimumSize).not.toHaveBeenCalled();
    expect(f.driver.setSize).not.toHaveBeenCalled();
    expect(f.options.onMaximizedChange).toHaveBeenLastCalledWith(true);
    dispose();
  });

  it("removes listeners registered after unmount and never writes late read results", async () => {
    const f = fixture();
    const subscription = deferred<() => void>();
    const reading = deferred<WindowGeometry | null>();
    f.driver.subscribe.mockReturnValue([subscription.promise]);
    f.driver.readGeometry.mockReturnValue(reading.promise);
    const dispose = observeWindowWorkspace(f.driver, f.options);
    await vi.advanceTimersByTimeAsync(0);
    dispose();
    reading.resolve(f.geometry);
    subscription.resolve(f.unlisten);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.unlisten).toHaveBeenCalledTimes(1);
    expect(f.driver.setMinimumSize).not.toHaveBeenCalled();
    expect(f.driver.setSize).not.toHaveBeenCalled();
  });

  it("reports repeated native failures once and can recover on the next event", async () => {
    const f = fixture();
    f.driver.readGeometry
      .mockRejectedValueOnce(new Error("monitor unavailable"))
      .mockRejectedValueOnce(new Error("monitor unavailable"));
    const dispose = observeWindowWorkspace(f.driver, f.options);
    await vi.advanceTimersByTimeAsync(0);
    f.emit();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.options.onError).toHaveBeenCalledTimes(1);
    f.emit();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.driver.setMinimumSize).toHaveBeenCalledTimes(1);
    dispose();
  });
});
