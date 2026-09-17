import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  APP_SETTINGS_STORAGE_KEY,
  loadAppSettings,
  saveAppSettings,
  clearAppSettings
} from "./appSettings";
import {
  clearDesktopAppSettings,
  hydrateDesktopAppSettings,
  persistDesktopAppSettings,
  type DesktopAppSettingsBridge
} from "./desktopAppSettings";

describe("桌面应用设置桥", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("从桌面配置读取后会同步到浏览器 fallback 镜像", async () => {
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn().mockResolvedValue(
        JSON.stringify({
          export: {
            defaultDirectory: "D:\\exports"
          },
          player: {
            mpvPath: "mpv",
            preferredBackend: "nativeMpv"
          },
          emby: {
            serverUrl: "https://emby.example.test",
            pathPrefix: "emby",
            username: "tester",
            password: "secret"
          },
          alignment: {
            ffmpegPath: "ffmpeg",
            spectralBackend: "cuda",
            windowMs: 500,
            minGapMs: 1200,
            matchThreshold: 0.25
          }
        })
      ),
      save: vi.fn(),
      clear: vi.fn()
    };

    const settings = await hydrateDesktopAppSettings(bridge);

    expect(settings?.emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    expect(settings?.export.defaultDirectory).toBe("D:\\exports");
    expect(settings?.player).toEqual({
      mpvPath: "mpv",
      preferredBackend: "nativeMpv"
    });
    expect(loadAppSettings().alignment.windowMs).toBe(500);
    expect(loadAppSettings().alignment.spectralBackend).toBe("cuda");
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("secret");
  });

  it("保存时写入规范化后的桌面配置文件内容", async () => {
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn()
    };

    await expect(
      persistDesktopAppSettings(
        {
          export: {
            defaultDirectory: " D:\\exports "
          },
          player: {
            mpvPath: " C:\\tools\\mpv.exe ",
            preferredBackend: "nativeMpv"
          },
          emby: {
            serverUrl: " https://emby.example.test ",
            pathPrefix: "emby",
            username: " tester "
          },
          alignment: {
            ffmpegPath: " C:\\tools\\ffmpeg.exe ",
            spectralBackend: "cpu",
            windowMs: 500,
            minGapMs: 1200,
            matchThreshold: 0.25
          }
        },
        bridge
      )
    ).resolves.toBe(true);

    expect(bridge.save).toHaveBeenCalledTimes(1);
    const [content] = vi.mocked(bridge.save).mock.calls[0];
    expect(JSON.parse(content)).toMatchObject({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION });
    expect(content).toContain("https://emby.example.test");
    expect(content).toContain("D:\\\\exports");
    expect(content).toContain("mpv.exe");
    expect(content).toContain("/emby");
    expect(content).toContain('"spectralBackend":"cpu"');
    expect(content).not.toContain("password");
    expect(loadAppSettings().emby.username).toBe("tester");
  });

  it("桌面配置显式包含未知声谱策略时 fail-safe，不覆盖浏览器 fallback", async () => {
    saveAppSettings({
      export: { defaultDirectory: "D:\\existing" },
      player: { mpvPath: "mpv", preferredBackend: "auto" },
      emby: { serverUrl: "", pathPrefix: "/emby", username: "" },
      alignment: {
        ffmpegPath: "ffmpeg",
        spectralBackend: "cpu",
        windowMs: 500,
        minGapMs: 1200,
        matchThreshold: 0.25
      }
    });
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn().mockResolvedValue(
        JSON.stringify({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          alignment: { spectralBackend: "unknown-gpu" }
        })
      ),
      save: vi.fn(),
      clear: vi.fn()
    };

    await expect(hydrateDesktopAppSettings(bridge)).rejects.toThrow(
      "声谱计算策略 spectralBackend 仅支持 auto、cuda 或 cpu"
    );
    expect(loadAppSettings().alignment.spectralBackend).toBe("cpu");
    expect(loadAppSettings().export.defaultDirectory).toBe("D:\\existing");
    expect(bridge.save).not.toHaveBeenCalled();
  });

  it("磁盘写入失败不会让草稿进入运行配置，本地缓存受限不阻断桌面保存", async () => {
    const original = saveAppSettings({
      ...loadAppSettings(),
      export: { defaultDirectory: "D:/before" }
    });
    const next = { ...original, export: { defaultDirectory: "D:/after" } };
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn(),
      clear: vi.fn(),
      save: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk full"))
        .mockResolvedValueOnce(undefined)
    };
    await expect(persistDesktopAppSettings(next, bridge)).rejects.toThrow("disk full");
    expect(loadAppSettings().export.defaultDirectory).toBe("D:/before");
    const storageWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    try {
      await expect(persistDesktopAppSettings(next, bridge)).resolves.toBe(true);
      expect(loadAppSettings().export.defaultDirectory).toBe("D:/after");
    } finally {
      storageWrite.mockRestore();
      clearAppSettings();
    }
  });

  it("清除时同时移除桌面配置和浏览器 fallback 镜像", async () => {
    const bridge: DesktopAppSettingsBridge = {
      load: vi.fn(),
      save: vi.fn(),
      clear: vi.fn().mockResolvedValue(undefined)
    };
    saveAppSettings({
      export: {
        defaultDirectory: "D:\\exports"
      },
      player: {
        mpvPath: "mpv",
        preferredBackend: "nativeMpv"
      },
      emby: {
        serverUrl: "https://emby.example.test",
        pathPrefix: "/emby",
        username: "tester"
      },
      alignment: {
        ffmpegPath: "ffmpeg",
        spectralBackend: "auto",
        windowMs: 500,
        minGapMs: 1200,
        matchThreshold: 0.25
      }
    });

    await expect(clearDesktopAppSettings(bridge)).resolves.toBe(true);

    expect(bridge.clear).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});
