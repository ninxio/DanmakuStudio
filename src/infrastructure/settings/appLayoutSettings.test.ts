import { describe, expect, it } from "vitest";
import {
  APP_LAYOUT_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_LAYOUT_SETTINGS,
  loadAppLayoutSettings,
  saveAppLayoutSettings,
  type AppLayoutSettingsStorage
} from "./appLayoutSettings";

describe("应用布局设置", () => {
  it("没有记录时使用舒适布局", () => {
    const storage = createMemoryStorage();
    expect(loadAppLayoutSettings(storage)).toEqual(DEFAULT_APP_LAYOUT_SETTINGS);
  });

  it("保存侧栏、密度和减少动效偏好", () => {
    const storage = createMemoryStorage();
    const saved = saveAppLayoutSettings(
      {
        projectSidebarCollapsed: true,
        contextPanelCollapsed: false,
        density: "compact",
        reduceMotion: true
      },
      storage
    );

    expect(saved).toEqual({
      projectSidebarCollapsed: true,
      contextPanelCollapsed: false,
      density: "compact",
      reduceMotion: true
    });
    expect(loadAppLayoutSettings(storage)).toEqual(saved);
    expect(storage.getItem(APP_LAYOUT_SETTINGS_STORAGE_KEY)).not.toContain("password");
  });

  it("损坏或未知字段回退到安全默认值", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      APP_LAYOUT_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        projectSidebarCollapsed: "yes",
        contextPanelCollapsed: true,
        density: "dense",
        reduceMotion: 1,
        token: "ignored"
      })
    );

    expect(loadAppLayoutSettings(storage)).toEqual({
      projectSidebarCollapsed: true,
      contextPanelCollapsed: true,
      density: "comfortable",
      reduceMotion: false
    });
  });
});

function createMemoryStorage(): AppLayoutSettingsStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}
