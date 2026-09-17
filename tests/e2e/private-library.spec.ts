import { installLibraryBridge } from "./private-library-bridge";
import { expect, test } from "@playwright/test";

test("private publication follows a validated XML export and keeps a usable small-window form", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByTestId("xml-input").setInputFiles({
    name: "S01E01.xml",
    mimeType: "application/xml",
    buffer: Buffer.from('<i><d p="1.001,1,25,16711680,0,0,u,1">发布测试</d></i>')
  });
  await page.getByTestId("workspace-nav-export").click();
  await expect(
    page.getByRole("button", { name: "发布到私人弹幕库", exact: true })
  ).toBeDisabled();
  await page.getByRole("button", { name: "建立时间线并开始编辑" }).click();
  await page.getByTestId("workspace-nav-export").click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  await downloaded;
  await installLibraryBridge(page);
  await page.getByRole("button", { name: "发布到私人弹幕库", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "更新私人弹幕库" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("搜索已有影视").fill("测试作品");
  await dialog.getByRole("button", { name: "搜索", exact: true }).click();
  await dialog.getByRole("button", { name: "更新这部剧集" }).click();
  await dialog.getByRole("button", { name: "影视资料与季年份" }).click();
  const catalog = page.getByRole("dialog", { name: "影视资料与季年份" });
  await catalog.getByLabel("中文或英文片名").fill("Example");
  await catalog.getByRole("button", { name: "搜索 TMDB" }).click();
  await catalog.getByRole("button", { name: /测试作品.*Example Show/ }).click();
  await expect(catalog.getByLabel("本次更新的季")).toHaveValue("1");
  await expect(catalog.getByRole("option", { name: /第 2 季 · 2023/ })).toBeAttached();
  await catalog.getByRole("button", { name: "预览资料变化" }).click();
  await expect(catalog.getByText(/弹幕内容、原有集号、成品确认与播放器地址保留/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tmdb-catalog-plan.png") });
  await catalog.getByRole("button", { name: "保存资料并使用这一季" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("文件 1 的集数")).toHaveValue("");
  await dialog.getByRole("button", { name: "确认按当前列表从第 1 集编号" }).click();
  await expect(dialog.getByLabel("文件 1 的集数")).toHaveValue("1");
  await expect(dialog.getByRole("radio").first()).toBeChecked();
  await dialog.getByRole("button", { name: "预览更新" }).click();
  await expect(dialog.getByText(/替换已有弹幕/)).toBeVisible();
  const submit = dialog.getByRole("button", { name: "确认更新并上架" });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await submit.click();
  await expect(dialog.getByText(/更新完成/)).toBeVisible();
  const calls = await page.evaluate(
    () => (window as unknown as { __LIBRARY_CALLS__: string[] }).__LIBRARY_CALLS__
  );
  expect(calls.filter((n) => n === "publish_private_library_xml")).toHaveLength(1);
  expect(calls.filter((n) => n === "review_private_library_episode")).toHaveLength(1);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
  await expect(dialog.getByRole("button", { name: "确认更新并上架" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("private-publication.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
