export type AppDensity = "comfortable" | "compact";

export interface AppLayoutSettings {
  projectSidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
  density: AppDensity;
  reduceMotion: boolean;
}

export interface AppLayoutSettingsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const APP_LAYOUT_SETTINGS_STORAGE_KEY = "danmaku.studio.layoutSettings.v1";

export const DEFAULT_APP_LAYOUT_SETTINGS: AppLayoutSettings = {
  projectSidebarCollapsed: true,
  contextPanelCollapsed: true,
  density: "comfortable",
  reduceMotion: false
};

export function loadAppLayoutSettings(storage = getDefaultStorage()): AppLayoutSettings {
  if (!storage) {
    return { ...DEFAULT_APP_LAYOUT_SETTINGS };
  }
  const raw = storage.getItem(APP_LAYOUT_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_APP_LAYOUT_SETTINGS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeAppLayoutSettings(parsed);
  } catch {
    return { ...DEFAULT_APP_LAYOUT_SETTINGS };
  }
}

export function saveAppLayoutSettings(
  settings: AppLayoutSettings,
  storage = getDefaultStorage()
): AppLayoutSettings {
  const normalized = normalizeAppLayoutSettings(settings);
  storage?.setItem(
    APP_LAYOUT_SETTINGS_STORAGE_KEY,
    JSON.stringify({ schemaVersion: 1, ...normalized })
  );
  return normalized;
}

export function normalizeAppLayoutSettings(value: unknown): AppLayoutSettings {
  if (!isRecord(value)) {
    return { ...DEFAULT_APP_LAYOUT_SETTINGS };
  }
  return {
    projectSidebarCollapsed: readBoolean(
      value.projectSidebarCollapsed,
      DEFAULT_APP_LAYOUT_SETTINGS.projectSidebarCollapsed
    ),
    contextPanelCollapsed: readBoolean(
      value.contextPanelCollapsed,
      DEFAULT_APP_LAYOUT_SETTINGS.contextPanelCollapsed
    ),
    density:
      value.density === "compact" || value.density === "comfortable"
        ? value.density
        : DEFAULT_APP_LAYOUT_SETTINGS.density,
    reduceMotion: readBoolean(value.reduceMotion, DEFAULT_APP_LAYOUT_SETTINGS.reduceMotion)
  };
}

function getDefaultStorage(): AppLayoutSettingsStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
