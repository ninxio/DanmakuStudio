import { describe, expect, it } from "vitest";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  APP_SETTINGS_STORAGE_KEY,
  DEFAULT_APP_SETTINGS,
  clearAppSettings,
  loadAppSettings,
  parseAppSettingsText,
  parseAppSettingsTextStrict,
  saveAppSettings,
  serializeAppSettings,
  type AppSettingsStorage
} from "./appSettings";

describe("应用设置持久化", () => {
  it("旧版云端复核设置在迁移后不再保存", () => {
    const migrated = parseAppSettingsText(
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        cloudReview: { geminiEnabled: true, apiKey: "synthetic-retired-key" }
      })
    );
    expect(serializeAppSettings(migrated)).not.toMatch(/cloudReview|apiKey|synthetic-retired/);
  });

  it("没有设置时返回默认值", () => {
    const storage = createMemoryStorage();

    expect(loadAppSettings(storage)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("只保存非敏感设置并规范化路径前缀", () => {
    const storage = createMemoryStorage();
    const saved = saveAppSettings(
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
          spectralBackend: "cuda",
          windowMs: 500,
          minGapMs: 0,
          matchThreshold: 0.2
        }
      },
      storage
    );

    expect(saved.export.defaultDirectory).toBe("D:\\exports");
    expect(saved.emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    const raw = storage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION });
    expect(raw).toContain("D:\\\\exports");
    expect(raw).toContain("ffmpeg.exe");
    expect(raw).toContain("mpv.exe");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("token");
    expect(loadAppSettings(storage).player).toEqual({
      mpvPath: "C:\\tools\\mpv.exe",
      preferredBackend: "nativeMpv"
    });
    expect(loadAppSettings(storage).alignment.windowMs).toBe(500);
    expect(loadAppSettings(storage).alignment.spectralBackend).toBe("cuda");
    expect(loadAppSettings(storage)).not.toHaveProperty("cloudReview");
  });

  it("读取旧数据时忽略敏感字段和无效数字", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        export: {
          defaultDirectory: "D:\\exports",
          temporaryDirectory: "D:\\tmp"
        },
        player: {
          mpvPath: "mpv",
          preferredBackend: "bad-backend",
          token: "token-2"
        },
        emby: {
          serverUrl: "https://emby.example.test",
          pathPrefix: "/emby",
          username: "tester",
          password: "secret"
        },
        alignment: {
          ffmpegPath: "ffmpeg",
          spectralBackend: "unsupported",
          windowMs: -1,
          minGapMs: -10,
          matchThreshold: 0,
          accessToken: "token-1"
        }
      })
    );

    const loaded = loadAppSettings(storage);

    expect(loaded.export.defaultDirectory).toBe("D:\\exports");
    expect(loaded.emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    expect(loaded.alignment.windowMs).toBe(DEFAULT_APP_SETTINGS.alignment.windowMs);
    expect(loaded.alignment.minGapMs).toBe(DEFAULT_APP_SETTINGS.alignment.minGapMs);
    expect(loaded.alignment.matchThreshold).toBe(DEFAULT_APP_SETTINGS.alignment.matchThreshold);
    expect(loaded.alignment.spectralBackend).toBe("auto");
    expect(loaded.player).toEqual({
      mpvPath: "mpv",
      preferredBackend: DEFAULT_APP_SETTINGS.player.preferredBackend
    });
    expect(JSON.stringify(loaded)).not.toContain("secret");
    expect(JSON.stringify(loaded)).not.toContain("token-1");
    expect(JSON.stringify(loaded)).not.toContain("token-2");
  });

  it("可以清除本地设置", () => {
    const storage = createMemoryStorage();
    saveAppSettings(DEFAULT_APP_SETTINGS, storage);

    clearAppSettings(storage);

    expect(storage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("序列化应用设置时会丢弃未知和敏感字段", () => {
    const text = serializeAppSettings(
      parseAppSettingsText(
        JSON.stringify({
          export: {
            defaultDirectory: "D:\\exports",
            token: "secret-token"
          },
          player: {
            mpvPath: "mpv",
            preferredBackend: "nativeMpv",
            token: "secret-token"
          },
          emby: {
            serverUrl: " https://emby.example.test ",
            pathPrefix: "emby",
            username: "tester",
            password: "secret"
          },
          alignment: {
            ffmpegPath: "ffmpeg",
            spectralBackend: "cpu",
            windowMs: "500",
            minGapMs: "1200",
            matchThreshold: "0.25",
            token: "secret-token"
          }
        })
      )
    );

    expect(JSON.parse(text)).toMatchObject({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION });
    expect(text).toContain("D:\\\\exports");
    expect(text).toContain("https://emby.example.test");
    expect(text).toContain("nativeMpv");
    expect(text).toContain('"spectralBackend":"cpu"');
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
  });

  it("严格解析设置备份时兼容无版本的旧备份", () => {
    const migrated = parseAppSettingsTextStrict(
      JSON.stringify({
        export: {
          defaultDirectory: "D:\\legacy-exports"
        },
        emby: {
          serverUrl: "https://legacy.example.test",
          pathPrefix: "emby",
          username: "legacy"
        },
        alignment: {
          ffmpegPath: "ffmpeg",
          windowMs: 500,
          minGapMs: 1200,
          matchThreshold: 0.25
        }
      })
    );

    expect(migrated).toMatchObject({
      export: {
        defaultDirectory: "D:\\legacy-exports"
      },
      emby: {
        serverUrl: "https://legacy.example.test",
        pathPrefix: "/emby",
        username: "legacy"
      }
    });
    expect(migrated.alignment.spectralBackend).toBe("auto");
  });

  it("严格解析设置备份时拒绝显式未知的声谱计算策略", () => {
    expect(() =>
      parseAppSettingsTextStrict(
        JSON.stringify({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
          alignment: {
            spectralBackend: "metal"
          }
        })
      )
    ).toThrow("声谱计算策略 spectralBackend 仅支持 auto、cuda 或 cpu");
  });

  it("严格解析设置备份时保留 JSON 语法错误", () => {
    expect(() => parseAppSettingsTextStrict("not json")).toThrow();
    expect(() => parseAppSettingsTextStrict("[]")).toThrow("设置备份必须是 JSON 对象。");
    expect(() => parseAppSettingsTextStrict(JSON.stringify({ schemaVersion: "1" }))).toThrow(
      "设置备份 schemaVersion 必须是数字。"
    );
    expect(() =>
      parseAppSettingsTextStrict(
        JSON.stringify({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION + 1 })
      )
    ).toThrow(`设置备份版本 ${APP_SETTINGS_SCHEMA_VERSION + 1} 暂不支持`);
  });
});

function createMemoryStorage(): AppSettingsStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    }
  };
}
