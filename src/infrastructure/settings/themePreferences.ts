export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  revision: number;
  persisted: boolean;
}

export const THEME_STORAGE_KEY = "danmaku.studio.theme.v1";

/** UI-only preference. Never serializes a project or invokes the native bridge. */
export function createThemeController(view: Window | null, root: HTMLElement | null) {
  const listeners = new Set<() => void>();
  const media = view?.matchMedia?.("(prefers-color-scheme: dark)");
  const readPreference = (): ThemePreference => {
    try {
      return normalizeThemePreference(view?.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      return "system";
    }
  };
  const resolve = (preference: ThemePreference): ResolvedTheme =>
    preference === "system" ? (media?.matches ? "dark" : "light") : preference;
  const preference = readPreference();
  let snapshot: ThemeSnapshot = {
    preference,
    resolved: resolve(preference),
    revision: 0,
    persisted: true
  };
  let started = false;

  function apply() {
    if (!root) return;
    root.dataset.theme = snapshot.resolved;
    root.dataset.themePreference = snapshot.preference;
    root.dataset.themeRevision = String(snapshot.revision);
    root.style.colorScheme = snapshot.resolved;
  }

  function update(nextPreference: ThemePreference, persisted = snapshot.persisted) {
    const resolved = resolve(nextPreference);
    if (
      snapshot.preference === nextPreference &&
      snapshot.resolved === resolved &&
      snapshot.persisted === persisted
    )
      return;
    snapshot = {
      preference: nextPreference,
      resolved,
      persisted,
      revision: snapshot.revision + 1
    };
    apply();
    listeners.forEach((listener) => listener());
  }

  const onSystemChange = () => update(snapshot.preference);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      update(readPreference(), true);
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference(nextPreference: ThemePreference) {
      const normalized = normalizeThemePreference(nextPreference);
      let persisted = true;
      try {
        view?.localStorage.setItem(THEME_STORAGE_KEY, normalized);
      } catch {
        persisted = false;
      }
      update(normalized, persisted);
    },
    start() {
      if (!started) {
        started = true;
        apply();
        media?.addEventListener("change", onSystemChange);
        view?.addEventListener("storage", onStorage);
      }
      return () => {
        started = false;
        media?.removeEventListener("change", onSystemChange);
        view?.removeEventListener("storage", onStorage);
      };
    }
  };
}

function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export const themeController = createThemeController(
  typeof window === "undefined" ? null : window,
  typeof document === "undefined" ? null : document.documentElement
);
