import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWindowControls } from "./DesktopWindowControls";

const windowMocks = vi.hoisted(() => ({
  minimize: vi.fn<() => Promise<void>>(),
  toggleMaximize: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>()
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMocks
}));

vi.mock("../../infrastructure/window/tauriWindowWorkspace", () => ({
  observeDesktopWindowWorkspace: () => () => {}
}));

describe("桌面窗口控制", () => {
  beforeEach(() => {
    windowMocks.minimize.mockReset().mockResolvedValue(undefined);
    windowMocks.toggleMaximize.mockReset().mockResolvedValue(undefined);
    windowMocks.close.mockReset().mockResolvedValue(undefined);
  });

  it("提供可读的最小化、最大化与安全关闭入口", async () => {
    render(<DesktopWindowControls />);

    expect(screen.getByRole("group", { name: "窗口控制" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));

    await waitFor(() => {
      expect(windowMocks.minimize).toHaveBeenCalledOnce();
      expect(windowMocks.toggleMaximize).toHaveBeenCalledOnce();
      expect(windowMocks.close).toHaveBeenCalledOnce();
    });
  });
});
