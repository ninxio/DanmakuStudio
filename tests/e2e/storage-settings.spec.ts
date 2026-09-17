import { expect, test } from "@playwright/test";

test("storage drafts preserve the effective root and ordinary XML uses native delivery", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page
    .getByTestId("xml-input")
    .setInputFiles({
      name: "P3.xml",
      mimeType: "application/xml",
      buffer: Buffer.from('<i><d p="1,1,25,16777215,0,0,u,1">存储闭环</d></i>')
    });
  await page.getByTestId("workspace-nav-export").click();
  await page.getByRole("button", { name: "建立时间线并开始编辑" }).click();
  await page.evaluate(() => {
    type Request = { directoryPath: string; fileName: string; contentBase64: string };
    const host = window as unknown as {
      isTauri: boolean;
      __p3Writes: Request[];
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
        metadata: unknown;
      };
    };
    const previous = host.__TAURI_INTERNALS__?.invoke;
    host.isTauri = true;
    host.__p3Writes = [];
    let stored = "{}";
    let rejectOnce = true;
    const active = {
      root: "C:/P3/current",
      projects: "C:/P3/current/project-library/v1",
      database: "C:/P3/current/project-library/v1/library.sqlite3",
      bilibili: "C:/P3/current/inputs/bilibili",
      originals: "C:/P3/current/originals",
      embyAudio: "C:/P3/current/cache/emby-audio-v1",
      features: "C:/P3/current/cache/features",
      exports: "C:/P3/current/exports"
    };
    host.__TAURI_INTERNALS__ = {
      ...host.__TAURI_INTERNALS__,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      invoke: (name, args) => {
        if (name === "load_app_settings_file") return Promise.resolve(stored);
        if (name === "save_app_settings_file") {
          if (rejectOnce) {
            rejectOnce = false;
            return Promise.reject(new Error("测试磁盘不可写"));
          }
          stored = String(args?.content);
          return Promise.resolve();
        }
        if (name === "get_storage_status")
          return Promise.resolve({
            active,
            requested: { ...active, database: "D:/P3/next/project-library/v1/library.sqlite3" },
            restartRequired: stored !== "{}",
            error: null,
            fixedLocalData: "C:/P3/fixed",
            fixedOutbox: "C:/P3/fixed/private-library/outbox",
            retainedLegacyDirectories: ["C:/P3/old/emby-audio-cache-v1"]
          });
        if (name === "save_edited_xml_export") {
          const request = args?.request as Request;
          host.__p3Writes.push(request);
          return Promise.resolve({
            fileName: request.fileName,
            directoryPath: request.directoryPath,
            filePath: `${request.directoryPath}/${request.fileName}`,
            wasRenamed: false
          });
        }
        return previous ? previous(name, args) : Promise.resolve(null);
      }
    };
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置中心" });
  await dialog.getByRole("button", { name: "存储目录", exact: true }).click();
  await expect(
    dialog.getByText("C:/P3/current/project-library/v1/library.sqlite3", { exact: true })
  ).toBeVisible();
  await dialog.getByLabel("Studio 数据目录").fill("D:/P3/next");
  await dialog.getByRole("button", { name: "保存设置并关闭" }).click();
  await expect(dialog.getByRole("alert")).toContainText("测试磁盘不可写");
  await expect(dialog.getByLabel("Studio 数据目录")).toHaveValue("D:/P3/next");
  await dialog.getByRole("button", { name: "保存设置并关闭" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await dialog.getByRole("button", { name: "存储目录", exact: true }).click();
  await expect(dialog.getByText("已保存目录变更，等待重新启动。")).toBeVisible();
  await expect(dialog.getByLabel("Studio 数据目录")).toHaveValue("D:/P3/next");
  await page.screenshot({ path: testInfo.outputPath("storage-paths.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByTestId("workspace-nav-export").click();
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __p3Writes: unknown[] }).__p3Writes.length)
    )
    .toBe(1);
  const written = await page.evaluate(
    () =>
      (
        window as unknown as {
          __p3Writes: Array<{ directoryPath: string; contentBase64: string }>;
        }
      ).__p3Writes[0]
  );
  expect(written.directoryPath).toBe("C:/P3/current/exports");
  expect(Buffer.from(written.contentBase64, "base64").toString("utf8")).toContain("存储闭环");
});
