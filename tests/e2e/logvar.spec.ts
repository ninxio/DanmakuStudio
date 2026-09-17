import { expect, test } from "@playwright/test";

test("LogVar receives only a reviewed export and reports verified readback", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByTestId("xml-input").setInputFiles({
    name: "Example.S01E01.xml",
    mimeType: "application/xml",
    buffer: Buffer.from('<i><d p="1.001,1,25,16711680,0,0,u,1">合成测试</d></i>')
  });
  await page.getByTestId("workspace-nav-matching").click();
  await page.getByRole("button", { name: "直接进入弹幕编辑" }).click();
  await page.getByTestId("workspace-nav-export").click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  await downloaded;
  // UI contract fixture only; native integration tests exercise real upstream LogVar.
  await page.evaluate(() => {
    const host = window as unknown as {
      isTauri: boolean;
      __LOGVAR_UPLOADS__: number;
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
    host.isTauri = true;
    host.__LOGVAR_UPLOADS__ = 0;
    host.__TAURI_INTERNALS__ = {
      invoke: async (name, args) => {
        await Promise.resolve();
        if (name === "logvar_status")
          return { configured: true, serviceUrl: "https://example.test", hasAdminToken: true };
        if (name === "get_private_library_status") return { configured: false };
        if (name === "list_logvar_library") return [];
        if (name === "preview_logvar_upload")
          return {
            connectionKey: "scope",
            sourceHash: "hash",
            resourceKey: "key",
            expectedVersion: null,
            count: 1,
            uploadBytes: 80,
            trimmedTextCount: 0
          };
        if (name === "upload_logvar_xml") {
          const request = args?.request as {
            xml: string;
            metadata: { title: string; episode: number };
            preview: { sourceHash: string };
          };
          if (
            !request.xml.includes("合成测试") ||
            request.metadata.title !== "示例旅程" ||
            request.metadata.episode !== 1 ||
            request.preview.sourceHash !== "hash"
          )
            throw new Error("Unreviewed payload");
          host.__LOGVAR_UPLOADS__++;
          return { verifiedCount: 1, resource: {} };
        }
        throw new Error(`Unexpected fixture command: ${name}`);
      }
    };
  });
  await page.getByRole("button", { name: "发布到私人弹幕库", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "LogVar 私人弹幕库" });
  await dialog.getByLabel("正式片名").fill("示例旅程");
  await dialog.getByLabel("年份", { exact: true }).fill("2025");
  await dialog.getByLabel("第 1 份 XML 对应集数").fill("1");
  await dialog.getByRole("button", { name: "预览上传清单" }).click();
  const upload = dialog.getByRole("button", { name: "上传并回读核验" });
  await expect(upload).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /我已检查/ }).check();
  await upload.click();
  await expect(dialog.getByText(/回读一致 · 1 条/)).toBeVisible();
  await expect(upload).toBeDisabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { __LOGVAR_UPLOADS__: number }).__LOGVAR_UPLOADS__
    )
  ).toBe(1);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width + bounds!.x).toBeLessThanOrEqual(1280);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
