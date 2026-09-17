import { selectWorkspaceMenu } from "./workspace-ui";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("XML metadata survives import, timeline export and independent reimport", async ({
  page
}, testInfo) => {
  await page.goto("/");
  const source = readFileSync("fixtures/bilibili/media-metadata.xml", "utf8");
  await page
    .getByTestId("xml-input")
    .setInputFiles({
      name: "renamed.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(source)
    });
  await page.getByTestId("workspace-nav-matching").click();
  await page.getByRole("button", { name: "直接进入弹幕编辑" }).click();
  await page.getByTestId("workspace-nav-export").click();
  const pending = page.waitForEvent("download");
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  const output = testInfo.outputPath("metadata-roundtrip.xml");
  await (await pending).saveAs(output);
  const xml = readFileSync(output, "utf8");
  expect(xml).toContain('duration-ms="280123"');
  expect(xml).toContain('bvid="BV1xx411c7mD"');
  expect(xml).toContain('page-count="8"');
  expect(xml).toContain("reference.m4a");
  // Clear only this isolated browser test session and exercise the ordinary XML input again.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page
    .getByTestId("xml-input")
    .setInputFiles({
      name: "returned.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(xml)
    });
  await page.getByTestId("workspace-nav-matching").click();
  await page.getByRole("button", { name: "直接进入弹幕编辑" }).click();
  await page.getByTestId("workspace-nav-export").click();
  const second = page.waitForEvent("download");
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  const secondPath = testInfo.outputPath("metadata-second-export.xml");
  await (await second).saveAs(secondPath);
  expect(readFileSync(secondPath, "utf8")).toBe(xml);
});

for (const entry of ["matching", "editing"] as const) {
  test(`XML ${entry} entry preserves time through incremental editing and export`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    const xml = (name: string, seconds: number) => ({
      name: `${name}.xml`,
      mimeType: "text/xml",
      buffer: Buffer.from(`<i><d p="${seconds},1,25,16777215,0,0,u,r">${name}</d></i>`)
    });
    await page.getByTestId("xml-input").setInputFiles(xml("first", 17.25));
    await page.getByTestId(`workspace-nav-${entry}`).click();
    if (entry === "editing")
      await page.getByRole("button", { name: "偏移与校准", exact: true }).click();
    await page
      .getByRole("button", {
        name: entry === "matching" ? "直接进入弹幕编辑" : "开始编辑弹幕"
      })
      .click();
    if (entry === "editing") await page.getByRole("button", { name: "关闭偏移与校准" }).click();
    await expect(page.getByTestId("xml-only-editor-shell")).toBeVisible();
    await page.getByTestId("workspace-nav-materials").click();
    await page.getByTestId("xml-input").setInputFiles(xml("second", 2));
    await page.getByTestId("workspace-nav-export").click();
    const panel = page.getByTestId("xml-only-export-panel");
    await expect(panel).toContainText("已加入时间线 1 / 2 个 XML");
    await expect(panel).toContainText("本次导出不会包含它们");
    await page.screenshot({
      path: testInfo.outputPath("xml-export-scope.png"),
      fullPage: true
    });

    await page.getByRole("button", { name: "加入剩余 XML 并编辑" }).click();
    await expect(page.getByTestId("xml-only-editor-shell")).toBeVisible();
    await page.getByLabel("撤销", { exact: true }).click();
    await expect(page.getByTestId("xml-only-editor-shell")).toContainText(
      "还有 1 个 XML 未加入"
    );
    await page.getByLabel("重做", { exact: true }).click();
    await expect(page.getByTestId("xml-only-editor-shell")).not.toContainText(
      "还有 1 个 XML 未加入"
    );
    await page.getByTestId("workspace-nav-export").click();
    await expect(panel).toContainText("已加入时间线 2 / 2 个 XML");
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByTestId("xml-export-summary")
      .getByRole("button", { name: "导出 XML", exact: true })
      .click();
    const download = await downloadPromise;
    const outputPath = testInfo.outputPath("renewal.xml");
    await download.saveAs(outputPath);
    const exported = readFileSync(outputPath, "utf8");
    const parsed = await page.evaluate((content) => {
      const document = new DOMParser().parseFromString(content, "text/xml");
      return {
        invalid: document.querySelector("parsererror") !== null,
        comments: Array.from(document.querySelectorAll("d"), (comment) => ({
          timeMs: Math.round(Number(comment.getAttribute("p")?.split(",")[0]) * 1000),
          text: comment.textContent
        }))
      };
    }, exported);
    expect(parsed).toEqual({
      invalid: false,
      comments: [
        { timeMs: 17_250, text: "first" },
        { timeMs: 19_251, text: "second" }
      ]
    });
    await expect(page.getByTestId("xml-export-summary")).toContainText("已导出 2 条弹幕");
    await selectWorkspaceMenu(page, "导出工具", "单文件导出与高级检查");
    await expect(page.getByRole("button", { name: /按文件名分 P 合并导出/ })).toBeVisible();
    const scrolling = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > innerWidth,
      y: document.documentElement.scrollHeight > innerHeight
    }));
    expect(scrolling).toEqual({ x: false, y: false });
    await page.screenshot({
      path: testInfo.outputPath("xml-export-complete.png"),
      fullPage: true
    });
  });
}
