import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThemeController, THEME_STORAGE_KEY } from "./themePreferences";

describe("theme preference lifecycle", () => {
  let dark = false;
  let media: MediaQueryList;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    localStorage.clear();
    dark = false;
    media = Object.assign(new EventTarget(), {
      media: "(prefers-color-scheme: dark)",
      onchange: null
    }) as MediaQueryList;
    Object.defineProperty(media, "matches", { get: () => dark });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media)
    );
  });
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function setup() {
    const root = document.createElement("div");
    const theme = createThemeController(window, root);
    stops.push(theme.start());
    return { theme, root };
  }

  it("restores a persisted preference before rendering and keeps system changes out of an explicit theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { theme, root } = setup();
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    const snapshot = theme.getSnapshot();
    media.dispatchEvent(new Event("change"));
    expect(theme.getSnapshot()).toBe(snapshot);
    theme.setPreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(root.dataset.theme).toBe("light");
  });

  it("system updates DOM before notifying subscribers and stops listening on disposal", () => {
    const { theme, root } = setup();
    const received: string[] = [];
    theme.subscribe(() => received.push(root.dataset.theme ?? "missing"));
    dark = true;
    media.dispatchEvent(new Event("change"));
    expect(received).toEqual(["dark"]);
    expect(theme.getSnapshot().revision).toBe(1);
    stops.splice(0).forEach((stop) => stop());
    dark = false;
    media.dispatchEvent(new Event("change"));
    expect(received).toEqual(["dark"]);
  });

  it("handles corrupt or denied storage without blocking the current theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "not-a-theme");
    const { theme, root } = setup();
    expect(theme.getSnapshot().preference).toBe("system");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => theme.setPreference("dark")).not.toThrow();
    expect(root.dataset.theme).toBe("dark");
    expect(theme.getSnapshot().persisted).toBe(false);
  });

  it("receives another window's selection without writing it back", () => {
    const { theme, root } = setup();
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const save = vi.spyOn(Storage.prototype, "setItem");
    window.dispatchEvent(
      new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" })
    );
    expect(root.dataset.theme).toBe("dark");
    expect(theme.getSnapshot().preference).toBe("dark");
    expect(save).not.toHaveBeenCalled();
  });
});
