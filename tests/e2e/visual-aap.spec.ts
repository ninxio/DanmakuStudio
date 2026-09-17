import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseProjectJson, serializeProject } from "../../src/domain/project/schema";
import { createLocalPathMediaReference } from "../../src/domain/project/mediaLibrary";

test("AAP is selectable without audio preparation and explains native-backend errors", async ({ page }, testInfo) => {
  const project = parseProjectJson(readFileSync("fixtures/projects/three-part-demo.danmaku-project.json", "utf8"));
  project.mediaLibrary = [
    createLocalPathMediaReference("source", "bilibiliReference", "C:/synthetic/reference.mp4", 26000),
    createLocalPathMediaReference("target", "targetOriginal", "C:/synthetic/original.mkv", 24000)
  ];
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByTestId("project-input").setInputFiles({ name: "aap.danmaku-project.json", mimeType: "application/json", buffer: Buffer.from(serializeProject(project)) });
  await page.getByTestId("workspace-nav-matching").click();
  await page.getByLabel("匹配方式").selectOption("visual-aap");
  const panel = page.getByRole("region", { name: "AAP 画面匹配" });
  await expect(panel).toContainText("需要两侧的视频文件");
  await expect(panel).toContainText("目前尚未经过实际使用验证，请逐段检查结果");
  for (const checkbox of await panel.getByRole("checkbox").all()) await checkbox.check();
  await expect(panel.getByRole("button", { name: "开始画面匹配" })).toBeEnabled();
  await panel.getByRole("button", { name: "开始画面匹配" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByRole("button", { name: "开始画面匹配" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("visual-aap.png"), fullPage: true });
});
