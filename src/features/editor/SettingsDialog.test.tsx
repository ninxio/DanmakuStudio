import * as desktopSettings from "../../infrastructure/settings/desktopAppSettings";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  APP_SETTINGS_STORAGE_KEY,
  loadAppSettings,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import {
  clearVolatileEmbyCredentials,
  loadVolatileEmbyPassword,
  saveVolatileEmbyPassword
} from "../../infrastructure/settings/volatileEmbyCredentials";
import type { AlignmentFeatureCacheStatus } from "../../infrastructure/alignment/tauriFeatureCache";
import { useEditorStore } from "../../stores/editorStore";
import { SettingsDialog } from "./SettingsDialog";

const cudaMocks = vi.hoisted(() => ({
  probe: vi.fn()
}));

const cacheMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  clear: vi.fn()
}));

vi.mock("../../infrastructure/alignment/cudaFftCapability", () => ({
  probeCudaFftCapability: cudaMocks.probe
}));

vi.mock("../../infrastructure/alignment/tauriFeatureCache", () => ({
  getAlignmentFeatureCacheStatus: cacheMocks.getStatus,
  clearAlignmentFeatureCaches: cacheMocks.clear
}));

describe("设置中心", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    clearVolatileEmbyCredentials();
    useEditorStore.setState({
      project: createEmptyProject(),
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      exportDraft: null
    });
    cudaMocks.probe.mockReset();
    cacheMocks.getStatus.mockReset();
    cacheMocks.clear.mockReset();
    cacheMocks.getStatus.mockResolvedValue(createFeatureCacheStatus());
  });

  it("迟到的桌面设置不覆盖正在编辑的草稿", async () => {
    let resolveRead!: (value: ReturnType<typeof loadAppSettings>) => void;
    vi.spyOn(desktopSettings, "readDesktopAppSettings").mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );
    render(<SettingsDialog onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.change(screen.getByLabelText("默认导出目录"), { target: { value: "D:/draft" } });
    act(() => {
      resolveRead(loadAppSettings());
    });
    await waitFor(() => expect(screen.getByLabelText("默认导出目录")).toHaveValue("D:/draft"));
    expect(screen.getByLabelText("默认导出目录")).toHaveValue("D:/draft");
  });

  it("保存失败保留草稿和错误，重试成功才关闭；取消不写设置", async () => {
    const close = vi.fn();
    const persist = vi
      .spyOn(desktopSettings, "persistDesktopAppSettings")
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(true);
    const view = render(<SettingsDialog onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.change(screen.getByLabelText("默认导出目录"), { target: { value: "D:/draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置并关闭" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk unavailable");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText("默认导出目录")).toHaveValue("D:/draft");
    fireEvent.click(screen.getByRole("button", { name: "保存设置并关闭" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(persist).toHaveBeenCalledTimes(2);
    view.unmount();
    persist.mockClear();
    render(<SettingsDialog onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(persist).not.toHaveBeenCalled();
  });

  it("清除失败恢复操作，迟到读取不会复活清除前的草稿", async () => {
    let resolveRead!: (value: ReturnType<typeof loadAppSettings>) => void;
    vi.spyOn(desktopSettings, "readDesktopAppSettings").mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );
    const oldSettings = { ...loadAppSettings(), export: { defaultDirectory: "D:/stale" } };
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    render(<SettingsDialog onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "隐私与本地数据" }));
    fireEvent.click(screen.getByRole("button", { name: "清除本地设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("storage denied");
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存设置并关闭" })).toBeEnabled();
    remove.mockRestore();
    await act(async () => {
      resolveRead(oldSettings);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(screen.getByLabelText("默认导出目录")).not.toHaveValue("D:/stale");
  });

  it("展示可复用匹配缓存并要求二次确认后清理", async () => {
    const user = userEvent.setup();
    cacheMocks.clear.mockResolvedValue({
      removedFiles: 11,
      removedBytes: 44 * 1024 * 1024,
      before: createFeatureCacheStatus(),
      after: {
        coarse: {
          memoryEntries: 0,
          persistentEntries: 0,
          persistentBytes: 0,
          maxPersistentEntries: 128,
          maxPersistentBytes: 512 * 1024 * 1024,
          directory: "C:\\cache\\coarse"
        },
        finePcm: {
          memoryEntries: 0,
          persistentEntries: 0,
          persistentBytes: 0,
          maxPersistentEntries: 64,
          maxPersistentBytes: 1024 * 1024 * 1024,
          directory: "C:\\cache\\fine"
        },
        visual: {
          memoryEntries: 0,
          persistentEntries: 0,
          persistentBytes: 0,
          maxPersistentEntries: 64,
          maxPersistentBytes: 512 * 1024 * 1024,
          directory: "C:\\cache\\visual"
        }
      }
    });

    render(<SettingsDialog onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "隐私与本地数据" }));
    expect(await screen.findByText("精对齐音频窗口")).toBeInTheDocument();
    expect(screen.getByText("2 项 · 32 MB")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清理匹配缓存" }));
    expect(cacheMocks.clear).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "再次点击确认清理" }));
    await waitFor(() => expect(cacheMocks.clear).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("0 项 · 0 B")).toHaveLength(3);
  });

  it("保存 Emby 非敏感连接设置，不保存密码或 token", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Emby 连接" }));
    fireEvent.change(screen.getByLabelText("服务器地址"), {
      target: { value: " https://emby.example.test " }
    });
    fireEvent.change(screen.getByLabelText("路径前缀"), {
      target: { value: "emby" }
    });
    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: " tester " }
    });
    fireEvent.change(screen.getByLabelText("本次会话密码"), {
      target: { value: "secret-pass" }
    });
    await user.click(screen.getByRole("button", { name: /保存设置/ }));

    expect(loadAppSettings().emby).toEqual({
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby",
      username: "tester"
    });
    expect(loadVolatileEmbyPassword()).toBe("secret-pass");
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("secret-pass");
  });

  it("保存播放器工具和对齐默认参数", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "播放器与工具" }));
    expect(screen.getByRole("button", { name: "检测 CUDA/cuFFT" })).toBeInTheDocument();
    expect(screen.getByText(/此设置影响之后启动的所有单次和批量匹配/)).toBeInTheDocument();
    expect(screen.getByText(/仅检测到显卡驱动不代表可用/)).toBeInTheDocument();
    const automatic = screen.getByRole("radio", { name: /自动推荐/ });
    expect(automatic).toBeChecked();
    automatic.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: /强制 GPU/ })).toBeChecked();
    expect(screen.getByText(/不会回退 CPU/)).toBeInTheDocument();
    expect(screen.getByText(/完全禁用 CUDA/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("FFmpeg 路径"), {
      target: { value: "C:\\tools\\ffmpeg.exe" }
    });
    fireEvent.change(screen.getByLabelText("libmpv 所在目录"), {
      target: { value: "C:\\tools\\mpv.exe" }
    });
    fireEvent.change(screen.getByLabelText("播放后端"), {
      target: { value: "nativeMpv" }
    });
    fireEvent.change(screen.getByLabelText("窗口 ms"), {
      target: { value: "500" }
    });
    fireEvent.change(screen.getByLabelText("最小缺失 ms"), {
      target: { value: "1200" }
    });
    fireEvent.change(screen.getByLabelText("匹配阈值"), {
      target: { value: "0.22" }
    });
    await user.click(screen.getByRole("button", { name: /保存设置/ }));

    expect(loadAppSettings().alignment).toEqual({
      ffmpegPath: "C:\\tools\\ffmpeg.exe",
      spectralBackend: "cuda",
      windowMs: 500,
      minGapMs: 1200,
      matchThreshold: 0.22
    });
    expect(loadAppSettings().player).toEqual({
      mpvPath: "C:\\tools\\mpv.exe",
      preferredBackend: "nativeMpv"
    });
  });

  it("用原生 context 与 cuFFT smoke test 显示 4090 真实可用状态", async () => {
    const user = userEvent.setup();
    cudaMocks.probe.mockResolvedValue({
      backendId: "cuda-cufft-r2c-512-v1",
      bindingsVersion: "CUDA 13.x ABI via cudarc 0.19.8",
      available: true,
      status: "ready",
      reason: "smoke transform succeeded",
      remediation: null,
      driverLibraryLoaded: true,
      driverLibraryName: "nvcuda.dll",
      cufftLibraryLoaded: true,
      cufftLibraryName: "cufft64_12.dll",
      driverRuntimeVersion: 13030,
      cufftRuntimeVersion: 12300,
      deviceCount: 1,
      selectedDeviceOrdinal: 0,
      selectedDeviceName: "NVIDIA GeForce RTX 4090",
      defaultBatchMemory: {
        batchFrames: 4096,
        inputBytes: 8_388_608,
        outputBytes: 8_421_376,
        worstCaseCufftWorkspaceBytes: 134_217_728,
        worstCaseTotalDeviceBytes: 151_027_712
      }
    });
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "播放器与工具" }));
    await user.click(screen.getByRole("button", { name: "检测 CUDA/cuFFT" }));

    expect(await screen.findByTestId("cuda-capability-result")).toHaveTextContent(
      "NVIDIA GeForce RTX 4090"
    );
    expect(screen.getByTestId("cuda-capability-result")).toHaveTextContent(
      "可用于自动推荐或强制 GPU"
    );
    expect(cudaMocks.probe).toHaveBeenCalledTimes(1);
  });

  it("保存默认导出目录", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.change(screen.getByLabelText("默认导出目录"), {
      target: { value: " D:\\danmaku exports " }
    });
    await user.click(screen.getByRole("button", { name: /保存设置/ }));

    expect(loadAppSettings().export.defaultDirectory).toBe("D:\\danmaku exports");
  });

  it("关于页展示产品信息并可直接关闭", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "关于" }));

    expect(screen.getByRole("heading", { name: "Danmaku Studio" })).toBeInTheDocument();
    expect(screen.getByText("开源许可 · GPL-3.0-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /保存设置/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("切到关于页后仍可保存其他页面的设置草稿", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "导出" }));
    fireEvent.change(screen.getByLabelText("默认导出目录"), {
      target: { value: "D:\\exports" }
    });
    await user.click(screen.getByRole("button", { name: "关于" }));
    await user.click(screen.getByRole("button", { name: /保存设置/ }));
    expect(loadAppSettings().export.defaultDirectory).toBe("D:\\exports");
  });

  it("可以清除本地应用设置", async () => {
    const user = userEvent.setup();
    saveAppSettings({
      export: {
        defaultDirectory: "D:\\exports"
      },
      player: {
        mpvPath: "C:\\tools\\mpv.exe",
        preferredBackend: "nativeMpv"
      },
      emby: {
        serverUrl: "https://emby.example.test",
        pathPrefix: "/emby",
        username: "tester"
      },
      alignment: {
        ffmpegPath: "ffmpeg",
        spectralBackend: "cuda",
        windowMs: 500,
        minGapMs: 1200,
        matchThreshold: 0.22
      }
    });
    saveVolatileEmbyPassword("secret-pass");

    render(<SettingsDialog onClose={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "隐私与本地数据" }));
    await user.click(screen.getByRole("button", { name: /清除本地设置/ }));

    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadVolatileEmbyPassword()).toBe("");
  });

  it("可以导出不包含敏感字段的设置备份", async () => {
    const user = userEvent.setup();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(
      () => "blob:settings-backup"
    );
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl
    });
    saveAppSettings({
      export: {
        defaultDirectory: "D:\\exports"
      },
      player: {
        mpvPath: "C:\\tools\\mpv.exe",
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
        matchThreshold: 0.22
      }
    });
    saveVolatileEmbyPassword("secret-pass");

    try {
      render(<SettingsDialog onClose={() => undefined} />);
      await user.click(screen.getByRole("button", { name: "隐私与本地数据" }));
      await user.click(screen.getByRole("button", { name: "导出设置" }));

      expect(createObjectUrl).toHaveBeenCalledTimes(1);
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("导出的设置备份不是 Blob。");
      }
      const text = await readBlobText(blob);
      expect(JSON.parse(text)).toMatchObject({ schemaVersion: APP_SETTINGS_SCHEMA_VERSION });
      expect(text).toContain("https://emby.example.test");
      expect(text).toContain("D:\\\\exports");
      expect(text).toContain("mpv.exe");
      expect(text).toContain('"spectralBackend":"auto"');
      expect(text).not.toContain("secret-pass");
      expect(text).not.toContain("password");
      expect(text).not.toContain("token");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("设置备份下载未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("danmaku-settings.json");
      expect(useEditorStore.getState().status.message).toBe(
        "已导出非敏感应用设置备份：danmaku-settings.json。"
      );
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:settings-backup");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("可以从设置备份导入非敏感配置", async () => {
    const user = userEvent.setup();
    saveAppSettings({
      ...loadAppSettings(),
      emby: {
        serverUrl: "https://original.example.test",
        pathPrefix: "/emby",
        username: "owner"
      }
    });
    saveVolatileEmbyPassword("original-private-password");
    render(<SettingsDialog onClose={() => undefined} />);
    const file = new File(
      [
        JSON.stringify({
          emby: {
            serverUrl: " https://backup.example.test ",
            pathPrefix: "emby",
            username: " imported ",
            password: "secret"
          },
          alignment: {
            ffmpegPath: " C:\\tools\\ffmpeg.exe ",
            spectralBackend: "cpu",
            windowMs: "600",
            minGapMs: "1500",
            matchThreshold: "0.3",
            token: "secret-token"
          },
          export: {
            defaultDirectory: "D:\\imported-exports"
          },
          player: {
            mpvPath: " C:\\tools\\mpv.exe ",
            preferredBackend: "nativeMpv",
            token: "secret-token"
          }
        })
      ],
      "danmaku-settings.json",
      { type: "application/json" }
    );

    await user.upload(screen.getByTestId("settings-import-input"), file);
    await user.click(screen.getByRole("button", { name: "Emby 连接" }));
    expect(screen.getByLabelText("本次会话密码")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "保存设置并关闭" }));

    await waitFor(() =>
      expect(loadAppSettings()).toMatchObject({
        emby: {
          serverUrl: "https://backup.example.test",
          pathPrefix: "/emby",
          username: "imported"
        },
        alignment: {
          ffmpegPath: "C:\\tools\\ffmpeg.exe",
          spectralBackend: "cpu",
          windowMs: 600,
          minGapMs: 1500,
          matchThreshold: 0.3
        },
        player: {
          mpvPath: "C:\\tools\\mpv.exe",
          preferredBackend: "nativeMpv"
        },
        export: {
          defaultDirectory: "D:\\imported-exports"
        }
      })
    );
    const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("token");
  });

  it("导入不支持版本的设置备份会提示错误", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog onClose={() => undefined} />);
    const file = new File(
      [
        JSON.stringify({
          schemaVersion: APP_SETTINGS_SCHEMA_VERSION + 1,
          emby: {},
          alignment: {}
        })
      ],
      "future-settings.json",
      { type: "application/json" }
    );

    await user.upload(screen.getByTestId("settings-import-input"), file);

    await waitFor(() => {
      const message = useEditorStore.getState().status.message;
      expect(message).toContain("future-settings.json");
      expect(message).toContain("暂不支持");
    });
  });

  it("从桌面载入不同账号时不会重绑定旧服务器密码", async () => {
    saveAppSettings({
      ...loadAppSettings(),
      emby: {
        serverUrl: "https://original.example.test",
        pathPrefix: "/emby",
        username: "owner"
      }
    });
    saveVolatileEmbyPassword("original-private-password");
    const imported = {
      ...loadAppSettings(),
      emby: { serverUrl: "https://other.example.test", pathPrefix: "/emby", username: "owner" }
    };
    vi.spyOn(desktopSettings, "readDesktopAppSettings").mockResolvedValue(imported);
    const close = vi.fn();
    render(<SettingsDialog onClose={close} />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Emby 连接" }));
    expect(screen.getByLabelText("服务器地址")).toHaveValue(imported.emby.serverUrl);
    expect(screen.getByLabelText("本次会话密码")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "保存设置并关闭" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(loadVolatileEmbyPassword(imported.emby)).toBe("");
  });
});

function createFeatureCacheStatus(): AlignmentFeatureCacheStatus {
  return {
    coarse: {
      memoryEntries: 1,
      persistentEntries: 4,
      persistentBytes: 4 * 1024 * 1024,
      maxPersistentEntries: 128,
      maxPersistentBytes: 512 * 1024 * 1024,
      directory: "C:\\cache\\coarse"
    },
    finePcm: {
      memoryEntries: 0,
      persistentEntries: 2,
      persistentBytes: 32 * 1024 * 1024,
      maxPersistentEntries: 64,
      maxPersistentBytes: 1024 * 1024 * 1024,
      directory: "C:\\cache\\fine"
    },
    visual: {
      memoryEntries: 1,
      persistentEntries: 3,
      persistentBytes: 8 * 1024 * 1024,
      maxPersistentEntries: 64,
      maxPersistentBytes: 512 * 1024 * 1024,
      directory: "C:\\cache\\visual"
    }
  };
}

function readBlobText(blob: Blob): Promise<string> {
  const modernBlob = blob as Blob & { text?: () => Promise<string> };
  if (typeof modernBlob.text === "function") {
    return modernBlob.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      if (reader.result instanceof ArrayBuffer) {
        resolve(new TextDecoder().decode(reader.result));
        return;
      }
      resolve("");
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsText(blob);
  });
}
