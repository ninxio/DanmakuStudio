import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageSettingsPanel } from "./StorageSettingsPanel";
import { SettingsDialog } from "./SettingsDialog";
import {
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import * as desktop from "../../infrastructure/settings/desktopAppSettings";
import type { StorageStatus } from "../../infrastructure/settings/storageClient";
import type * as NativeDialogs from "../../infrastructure/file-system/nativeDialogs";

const mock = vi.hoisted(() => ({ status: vi.fn(), pick: vi.fn() }));
vi.mock("../../infrastructure/settings/storageClient", () => ({
  getStorageStatus: mock.status,
  getHostEnvironment: vi.fn(() => Promise.resolve(null))
}));
vi.mock("../../infrastructure/file-system/nativeDialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeDialogs>()),
  pickSingleNativeDirectoryPath: mock.pick
}));

const active = {
  root: "C:/current",
  projects: "C:/current/project-library/v1",
  database: "C:/current/project-library/v1/library.sqlite3",
  bilibili: "C:/current/inputs/bilibili",
  originals: "C:/current/originals",
  embyAudio: "C:/current/cache/emby-audio-v1",
  features: "C:/current/cache/features",
  exports: "C:/current/exports"
};
const status: StorageStatus = {
  active,
  requested: {
    ...active,
    root: "D:/next",
    database: "D:/next/project-library/v1/library.sqlite3"
  },
  restartRequired: true,
  error: null,
  fixedLocalData: "C:/appdata",
  fixedOutbox: "C:/appdata/private-library/outbox",
  retainedLegacyDirectories: ["C:/old/audio"]
};

describe("存储目录闭环", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    mock.status.mockResolvedValue(status);
    mock.pick.mockReset();
  });
  it("区分生效与待启动目录、保留音轨、固定发布记录和旧版占用", async () => {
    const change = vi.fn();
    render(
      <StorageSettingsPanel
        value={{ rootDirectory: "D:/next", cacheDirectory: "" }}
        onChange={change}
      />
    );
    expect(await screen.findByText(active.database)).toBeVisible();
    expect(screen.getByText(/下次项目库/)).toHaveTextContent(
      "D:/next/project-library/v1/library.sqlite3"
    );
    expect(screen.getByText(status.fixedOutbox!)).toBeVisible();
    expect(screen.getByText("C:/old/audio")).toBeVisible();
    expect(screen.getByText(/不会回收旧目录/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Studio 数据目录"), {
      target: { value: "E:/draft" }
    });
    expect(change).toHaveBeenCalledWith({ rootDirectory: "E:/draft", cacheDirectory: "" });
    expect(screen.getByText(active.database)).toBeVisible();
  });
  it("迁移错误显示原始原因，并允许修改草稿恢复原目录", async () => {
    mock.status.mockResolvedValue({ ...status, active: null, error: "原库在备份后又有修改" });
    const change = vi.fn();
    render(
      <StorageSettingsPanel
        value={{ rootDirectory: "D:/next", cacheDirectory: "" }}
        onChange={change}
      />
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("原库在备份后又有修改");
    mock.pick.mockResolvedValue("C:/current");
    fireEvent.click(screen.getByRole("button", { name: "选择数据目录" }));
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({ rootDirectory: "C:/current", cacheDirectory: "" })
    );
  });
  it("保存失败保留路径草稿，恢复默认保留存储配置", async () => {
    const storage = { rootDirectory: "D:/library", cacheDirectory: "E:/cache" };
    saveAppSettings({ ...DEFAULT_APP_SETTINGS, storage });
    vi.spyOn(desktop, "readDesktopAppSettings").mockResolvedValue(null);
    const save = vi
      .spyOn(desktop, "persistDesktopAppSettings")
      .mockRejectedValue(new Error("目标磁盘不可写"));
    const close = vi.fn();
    render(<SettingsDialog onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "存储目录" }));
    fireEvent.change(screen.getByLabelText("Studio 数据目录"), {
      target: { value: "F:/draft" }
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置并关闭" }));
    await waitFor(() =>
      expect(screen.getByText(/保存未完成/)).toHaveTextContent("目标磁盘不可写")
    );
    expect(screen.getByLabelText("Studio 数据目录")).toHaveValue("F:/draft");
    expect(close).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        storage: { rootDirectory: "F:/draft", cacheDirectory: "E:/cache" }
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(screen.getByLabelText("Studio 数据目录")).toHaveValue("F:/draft");
    expect(loadAppSettings().storage).toEqual(storage);
  });
});
