import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  clearAppSettings,
  cacheDesktopAppSettings,
  normalizeAppSettings,
  parseAppSettingsTextStrict,
  saveAppSettings,
  serializeAppSettings,
  type AppSettings,
  type AppSettingsInput
} from "./appSettings";

export interface DesktopAppSettingsBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

const defaultDesktopAppSettingsBridge: DesktopAppSettingsBridge = {
  load: () => invoke<string | null>("load_app_settings_file"),
  save: (content) => invoke<void>("save_app_settings_file", { content }),
  clear: () => invoke<void>("clear_app_settings_file")
};

let settingsWriteRevision = 0;

export async function readDesktopAppSettings(
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<AppSettings | null> {
  if (bridge === defaultDesktopAppSettingsBridge && !isTauri()) {
    return null;
  }
  const content = await bridge.load();
  if (!content) {
    return null;
  }
  const settings = parseAppSettingsTextStrict(content);
  return settings;
}

/** A late startup read must never overwrite a newer user save. */
export async function hydrateDesktopAppSettings(
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<AppSettings | null> {
  const revision = settingsWriteRevision;
  const settings = await readDesktopAppSettings(bridge);
  if (settings && revision === settingsWriteRevision) cacheDesktopAppSettings(settings);
  return settings;
}

export async function persistDesktopAppSettings(
  settings: AppSettingsInput,
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<boolean> {
  settingsWriteRevision += 1;
  const normalized = normalizeAppSettings(settings);
  if (bridge === defaultDesktopAppSettingsBridge && !isTauri()) {
    saveAppSettings(normalized);
    return false;
  }
  await bridge.save(serializeAppSettings(normalized));
  cacheDesktopAppSettings(normalized);
  return true;
}

export async function clearDesktopAppSettings(
  bridge: DesktopAppSettingsBridge = defaultDesktopAppSettingsBridge
): Promise<boolean> {
  settingsWriteRevision += 1;
  if (bridge === defaultDesktopAppSettingsBridge && !isTauri()) {
    clearAppSettings();
    return false;
  }
  await bridge.clear();
  if (bridge === defaultDesktopAppSettingsBridge) {
    const retained = await readDesktopAppSettings();
    if (!retained) throw new Error("无法确认清空后保留的存储目录，请重新读取设置。");
    cacheDesktopAppSettings(retained);
  } else clearAppSettings();
  return true;
}

export function formatDesktopSettingsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
