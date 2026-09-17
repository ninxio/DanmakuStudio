import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BilibiliAccountPanel } from "./BilibiliAccountPanel";
import * as account from "../../infrastructure/bilibili/bilibiliAccount";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("../../infrastructure/bilibili/bilibiliAccount", () => ({
  getBilibiliAccount: vi.fn(),
  startBilibiliQr: vi.fn(),
  pollBilibiliQr: vi.fn(),
  cancelBilibiliQr: vi.fn(() => Promise.resolve(true)),
  logoutBilibili: vi.fn(() => Promise.resolve())
}));
const anonymous: account.BilibiliAccountStatus = {
  state: "anonymous",
  account: null,
  persisted: false,
  lastVerifiedAt: null,
  message: "尚未登录"
};
const identity = { mid: "123", username: "测试账号" };
const qr = () => ({
  attemptId: "attempt-one",
  qrImage: "data:image/svg+xml;base64,PHN2Zy8+",
  expiresAt: Date.now() + 180_000
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(account.getBilibiliAccount).mockResolvedValue(anonymous);
  vi.mocked(account.startBilibiliQr).mockResolvedValue(qr());
});
afterEach(() => vi.useRealTimers());
async function openQr() {
  await act(async () => {
    await Promise.resolve();
    render(<BilibiliAccountPanel />);
  });
  await act(async () => {
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "扫码登录" }));
  });
}
describe("Bilibili account flow", () => {
  it("recovers an account committed just before cancelling the outstanding poll", async () => {
    vi.mocked(account.pollBilibiliQr).mockReturnValue(new Promise(() => {}));
    await openQr();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    vi.mocked(account.getBilibiliAccount).mockResolvedValue({
      ...anonymous,
      state: "unverified",
      persisted: true,
      account: identity,
      message: "已恢复账号"
    });
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: "取消扫码" }));
    });
    expect(screen.getByText("测试账号")).toBeVisible();
    expect(screen.getByRole("button", { name: "退出并清除本机登录" })).toBeEnabled();
  });
  it("waits for durable confirmation, then restores the saved account after remount", async () => {
    vi.mocked(account.pollBilibiliQr)
      .mockResolvedValueOnce({
        phase: "waiting_confirm",
        account: null,
        persisted: false,
        message: "请在手机确认"
      })
      .mockResolvedValueOnce({
        phase: "completed",
        account: identity,
        persisted: false,
        message: "保存未完成"
      })
      .mockResolvedValueOnce({
        phase: "completed",
        account: identity,
        persisted: true,
        message: "登录已加密保存"
      });
    await openQr();
    expect(screen.getByRole("img", { name: /B 站登录二维码/ })).toBeVisible();
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("请在手机确认")).toBeVisible();
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByText("测试账号")).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("测试账号")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: "退出并清除本机登录" }));
    });
    expect(account.logoutBilibili).toHaveBeenCalledOnce();
    expect(screen.queryByText("测试账号")).not.toBeInTheDocument();
  });
  it("cancels a QR generated after the panel was closed", async () => {
    let resolveQr!: (value: account.BilibiliQr) => void;
    vi.mocked(account.startBilibiliQr).mockReturnValue(
      new Promise((resolve) => {
        resolveQr = resolve;
      })
    );
    const view = render(<BilibiliAccountPanel />);
    await act(async () => {
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: "扫码登录" }));
    });
    view.unmount();
    await act(async () => {
      await Promise.resolve();
      resolveQr(qr());
    });
    expect(account.cancelBilibiliQr).toHaveBeenCalledWith("attempt-one");
    expect(account.pollBilibiliQr).not.toHaveBeenCalled();
  });
  it("shows a persisted account after reopening without exposing credentials", async () => {
    vi.mocked(account.getBilibiliAccount).mockResolvedValue({
      state: "unverified",
      account: identity,
      persisted: true,
      lastVerifiedAt: 1,
      message: "已恢复账号"
    });
    await act(async () => {
      await Promise.resolve();
      render(<BilibiliAccountPanel />);
    });
    expect(screen.getByText("测试账号")).toBeVisible();
    expect(screen.getByRole("button", { name: "检查登录" })).toBeEnabled();
    expect(screen.queryByLabelText("B 站 Cookie")).not.toBeInTheDocument();
  });
});
