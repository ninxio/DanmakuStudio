import {
  isSpectralBackendPreference,
  type SpectralBackendPreference
} from "../../domain/alignment/spectralBackendPreference";
import type { PlayerBackendPreference } from "../../domain/player/playerEngine";
import type { StorageSettings } from "./storageClient";
import { readWorkflowPresets, type WorkflowPreset } from "../../domain/project/workflowPreset";

export interface AppSettings {
  acquisition?: { downloadAudio: boolean; provider: "ext" | "nyaa" };
  workflowPresets?: WorkflowPreset[];
  storage: StorageSettings;
  export: {
    defaultDirectory: string;
  };
  player: {
    mpvPath: string;
    preferredBackend: PreviewBackendPreference;
  };
  emby: {
    serverUrl: string;
    pathPrefix: string;
    username: string;
  };
  alignment: {
    ffmpegPath: string;
    spectralBackend: SpectralBackendPreference;
    windowMs: number;
    minGapMs: number;
    matchThreshold: number;
  };
}

export type AppSettingsInput = Omit<AppSettings, "storage"> & {
  storage?: StorageSettings;
};

export type PreviewBackendPreference = PlayerBackendPreference;

export interface AppSettingsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const APP_SETTINGS_SCHEMA_VERSION = 1;
export const APP_SETTINGS_STORAGE_KEY = "danmaku.timelineStudio.appSettings.v1";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  storage: { rootDirectory: "", cacheDirectory: "" },
  export: {
    defaultDirectory: ""
  },
  player: {
    mpvPath: "",
    preferredBackend: "auto"
  },
  emby: {
    serverUrl: "",
    pathPrefix: "/emby",
    username: ""
  },
  alignment: {
    ffmpegPath: "",
    spectralBackend: "auto",
    windowMs: 1000,
    minGapMs: 3000,
    matchThreshold: 0.35
  }
};

// Only used after the authoritative desktop file was saved successfully.
let desktopSessionFallback: AppSettings | null = null;

export function cacheDesktopAppSettings(settings: AppSettings): void {
  if (!getDefaultStorage()) {
    desktopSessionFallback = cloneAppSettings(settings);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(APP_SETTINGS_CHANGED));
    return;
  }
  try {
    saveAppSettings(settings);
  } catch {
    desktopSessionFallback = cloneAppSettings(settings);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(APP_SETTINGS_CHANGED));
  }
}

export function loadAppSettings(storage = getDefaultStorage()): AppSettings {
  if (desktopSessionFallback && storage === getDefaultStorage())
    return cloneAppSettings(desktopSessionFallback);
  if (!storage) {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
  const raw = storage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
  return parseAppSettingsText(raw);
}

export function saveAppSettings(
  settings: AppSettingsInput,
  storage = getDefaultStorage()
): AppSettings {
  const normalized = normalizeAppSettings(settings);
  if (storage) {
    storage.setItem(APP_SETTINGS_STORAGE_KEY, serializeAppSettings(normalized));
  }
  if (storage === getDefaultStorage()) desktopSessionFallback = null;
  if (typeof window !== "undefined" && storage === getDefaultStorage())
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED));
  return normalized;
}

export function clearAppSettings(storage = getDefaultStorage()): void {
  if (storage === getDefaultStorage()) desktopSessionFallback = null;
  storage?.removeItem(APP_SETTINGS_STORAGE_KEY);
  if (typeof window !== "undefined" && storage === getDefaultStorage())
    window.dispatchEvent(new Event(APP_SETTINGS_CHANGED));
}

export const APP_SETTINGS_CHANGED = "danmaku:settings-changed";

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    ...(settings.acquisition ? { acquisition: { ...settings.acquisition } } : {}),
    ...(settings.workflowPresets
      ? { workflowPresets: readWorkflowPresets(settings.workflowPresets) }
      : {}),
    storage: { ...(settings.storage ?? DEFAULT_APP_SETTINGS.storage) },
    export: { ...settings.export },
    player: { ...settings.player },
    emby: { ...settings.emby },
    alignment: { ...settings.alignment }
  };
}

export function parseAppSettingsText(text: string): AppSettings {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return cloneAppSettings(DEFAULT_APP_SETTINGS);
    }
    validateAppSettingsVersion(parsed);
    return normalizeAppSettings(parsed);
  } catch {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
}

export function parseAppSettingsTextStrict(text: string): AppSettings {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("设置备份必须是 JSON 对象。");
  }
  validateAppSettingsVersion(parsed);
  validateExplicitSpectralBackendPreference(parsed);
  return normalizeAppSettings(parsed);
}

export function serializeAppSettings(settings: AppSettings): string {
  return JSON.stringify({
    schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
    ...normalizeAppSettings(settings)
  });
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!isRecord(value)) {
    return cloneAppSettings(DEFAULT_APP_SETTINGS);
  }
  const exportSettings = isRecord(value.export) ? value.export : {};
  const player = isRecord(value.player) ? value.player : {};
  const emby = isRecord(value.emby) ? value.emby : {};
  const alignment = isRecord(value.alignment) ? value.alignment : {};
  const storage = isRecord(value.storage) ? value.storage : {};
  const acquisition = isRecord(value.acquisition) ? value.acquisition : null;
  return {
    ...(acquisition
      ? {
          acquisition: {
            downloadAudio:
              typeof acquisition.downloadAudio === "boolean" ? acquisition.downloadAudio : true,
            provider: acquisition.provider === "nyaa" ? ("nyaa" as const) : ("ext" as const)
          }
        }
      : {}),
    ...(value.workflowPresets !== undefined
      ? { workflowPresets: readWorkflowPresets(value.workflowPresets) }
      : {}),
    storage: {
      rootDirectory: readString(storage.rootDirectory, ""),
      cacheDirectory: readString(storage.cacheDirectory, "")
    },
    export: {
      defaultDirectory: readString(
        exportSettings.defaultDirectory,
        DEFAULT_APP_SETTINGS.export.defaultDirectory
      )
    },
    player: {
      mpvPath: readString(player.mpvPath, DEFAULT_APP_SETTINGS.player.mpvPath),
      preferredBackend: readPreviewBackendPreference(player.preferredBackend)
    },
    emby: {
      serverUrl: readString(emby.serverUrl, DEFAULT_APP_SETTINGS.emby.serverUrl),
      pathPrefix: normalizePathPrefix(
        readString(emby.pathPrefix, DEFAULT_APP_SETTINGS.emby.pathPrefix)
      ),
      username: readString(emby.username, DEFAULT_APP_SETTINGS.emby.username)
    },
    alignment: {
      ffmpegPath: readString(alignment.ffmpegPath, DEFAULT_APP_SETTINGS.alignment.ffmpegPath),
      spectralBackend: readSpectralBackendPreference(alignment.spectralBackend),
      windowMs: readPositiveInteger(
        alignment.windowMs,
        DEFAULT_APP_SETTINGS.alignment.windowMs
      ),
      minGapMs: readNonNegativeInteger(
        alignment.minGapMs,
        DEFAULT_APP_SETTINGS.alignment.minGapMs
      ),
      matchThreshold: readPositiveNumber(
        alignment.matchThreshold,
        DEFAULT_APP_SETTINGS.alignment.matchThreshold
      )
    }
  };
}

function getDefaultStorage(): AppSettingsStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAppSettingsVersion(value: Record<string, unknown>): void {
  if (value.schemaVersion === undefined) {
    return;
  }
  if (typeof value.schemaVersion !== "number") {
    throw new Error("设置备份 schemaVersion 必须是数字。");
  }
  if (value.schemaVersion !== APP_SETTINGS_SCHEMA_VERSION) {
    throw new Error(
      `设置备份版本 ${value.schemaVersion} 暂不支持，当前支持版本为 ${APP_SETTINGS_SCHEMA_VERSION}。`
    );
  }
}

function validateExplicitSpectralBackendPreference(value: Record<string, unknown>): void {
  if (!isRecord(value.alignment) || !("spectralBackend" in value.alignment)) {
    return;
  }
  if (!isSpectralBackendPreference(value.alignment.spectralBackend)) {
    throw new Error("声谱计算策略 spectralBackend 仅支持 auto、cuda 或 cpu。");
  }
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function readPreviewBackendPreference(value: unknown): PreviewBackendPreference {
  return value === "auto" || value === "htmlVideo" || value === "nativeMpv"
    ? value
    : DEFAULT_APP_SETTINGS.player.preferredBackend;
}

function readSpectralBackendPreference(value: unknown): SpectralBackendPreference {
  return isSpectralBackendPreference(value)
    ? value
    : DEFAULT_APP_SETTINGS.alignment.spectralBackend;
}

function normalizePathPrefix(value: string): string {
  if (value.trim().length === 0) {
    return "";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
