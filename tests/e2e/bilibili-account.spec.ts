import { expect, test } from "@playwright/test";

test("settings provide QR confirmation, account recovery and local logout", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await expect(page.getByTestId("xml-input")).toBeAttached();
  await page.evaluate(() => {
    const host = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
        metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
      };
    };
    const previous = host.__TAURI_INTERNALS__?.invoke;
    host.isTauri = true;
    let loggedIn = false;
    let polls = 0;
    host.__TAURI_INTERNALS__ = {
      ...host.__TAURI_INTERNALS__,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: (name, args) => {
        if (name === "bilibili_auth_status")
          return Promise.resolve({
            state: loggedIn ? "unverified" : "anonymous",
            account: loggedIn ? { mid: "123", username: "测试账号" } : null,
            persisted: loggedIn,
            message: loggedIn ? "已恢复本机账号" : "尚未登录"
          });
        if (name === "bilibili_auth_start_qr")
          return Promise.resolve({
            attemptId: "test-attempt",
            qrImage:
              "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMjQwIj48cmVjdCB3aWR0aD0iMjQwIiBoZWlnaHQ9IjI0MCIgZmlsbD0id2hpdGUiLz48L3N2Zz4=",
            expiresAt: Date.now() + 180000
          });
        if (name === "bilibili_auth_poll_qr") {
          polls++;
          if (polls === 1)
            return Promise.resolve({
              phase: "waiting_confirm",
              persisted: false,
              account: null,
              message: "已扫码，请在手机上确认登录"
            });
          loggedIn = true;
          return Promise.resolve({
            phase: "completed",
            persisted: true,
            account: { mid: "123", username: "测试账号" },
            message: "登录已加密保存在本机"
          });
        }
        if (name === "bilibili_auth_logout") {
          loggedIn = false;
          return Promise.resolve(null);
        }
        if (name === "bilibili_auth_cancel_qr") return Promise.resolve(true);
        return previous ? previous(name, args) : Promise.resolve(null);
      }
    };
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置中心" });
  await settings.getByRole("button", { name: "B 站账号", exact: true }).click();
  await settings.getByRole("button", { name: "扫码登录", exact: true }).click();
  await expect(settings.getByRole("img", { name: /B 站登录二维码/ })).toBeVisible();
  await expect(settings.getByText("已扫码，请在手机上确认登录")).toBeVisible();
  await expect(settings.getByText("测试账号", { exact: false })).toBeVisible();
  await expect(settings.getByRole("img", { name: /B 站登录二维码/ })).toHaveCount(0);
  await settings.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: "B 站账号", exact: true }).click();
  await expect(settings.getByText("已恢复本机账号")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("bilibili-account.png") });
  await settings.getByRole("button", { name: "退出并清除本机登录" }).click();
  await expect(settings.getByRole("button", { name: "扫码登录", exact: true })).toBeEnabled();
  await expect(settings.getByText(/已退出并清除本机保存的登录/)).toBeVisible();
});
