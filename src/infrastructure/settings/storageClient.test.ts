import { beforeEach, expect, it, vi } from "vitest";
import { clearDesktopAppSettings, persistDesktopAppSettings } from "./desktopAppSettings";
import { loadAppSettings, saveAppSettings, DEFAULT_APP_SETTINGS } from "./appSettings";
import { resolveExportDirectory } from "./storageClient";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, isTauri: mock.desktop }));
beforeEach(() => {
  window.localStorage.clear();
  mock.invoke.mockReset();
  mock.desktop.mockReturnValue(true);
});
it("清空原生设置后重新读取保留目录，再次保存不会回默认库", async () => {
  const storage = { rootDirectory: "D:/projects", cacheDirectory: "E:/cache" };
  saveAppSettings({
    ...DEFAULT_APP_SETTINGS,
    storage,
    player: { ...DEFAULT_APP_SETTINGS.player, mpvPath: "old" }
  });
  mock.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "load_app_settings_file"
        ? JSON.stringify({ schemaVersion: 1, storage })
        : undefined
    )
  );
  await clearDesktopAppSettings();
  expect(loadAppSettings().storage).toEqual(storage);
  expect(loadAppSettings().player.mpvPath).toBe("");
  await persistDesktopAppSettings(loadAppSettings());
  const saved = mock.invoke.mock.calls.find(
    ([command]) => command === "save_app_settings_file"
  )?.[1] as { content: string };
  expect(JSON.parse(saved.content) as unknown).toEqual(expect.objectContaining({ storage }));
});
it("无显式导出目录时使用有效目录，保留显式覆盖并传播失效错误", async () => {
  mock.invoke.mockResolvedValue({
    active: { exports: "D:/active/exports" },
    requested: { exports: "E:/pending/exports" }
  });
  expect(await resolveExportDirectory("")).toBe("D:/active/exports");
  mock.invoke.mockClear();
  expect(await resolveExportDirectory(" X:/override ")).toBe("X:/override");
  expect(mock.invoke).not.toHaveBeenCalled();
  mock.invoke.mockResolvedValue({ active: null, error: "项目库迁移失效" });
  await expect(resolveExportDirectory("")).rejects.toThrow("项目库迁移失效");
});

it("清空后的权威重读失败也不抹掉浏览器中的项目库目录", async () => {
  const storage = { rootDirectory: "D:/projects", cacheDirectory: "E:/cache" };
  saveAppSettings({ ...DEFAULT_APP_SETTINGS, storage });
  nativeReadFailure();
  await expect(clearDesktopAppSettings()).rejects.toThrow("read failed");
  expect(loadAppSettings().storage).toEqual(storage);
});
function nativeReadFailure() {
  mock.invoke.mockImplementation((command: string) =>
    command === "load_app_settings_file"
      ? Promise.reject(new Error("read failed"))
      : Promise.resolve()
  );
}
