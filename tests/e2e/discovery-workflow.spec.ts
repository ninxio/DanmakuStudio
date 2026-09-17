import { installLibraryBridge } from "./private-library-bridge";
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseProjectJson } from "../../src/domain/project/schema";
test("discovery persists portable profile, explicitly prefills acquisition and freezes export details", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "发现与整理", exact: true }).click();
  const tool = page.getByRole("dialog", { name: "发现与整理", exact: true });
  await tool.getByLabel("收藏链接").fill("https://ext.to/browse/?q=Example");
  await tool.getByLabel("待办作品名称").fill("测试作品");
  await tool.getByRole("button", { name: "保存链接待办" }).click();
  await tool.getByRole("button", { name: "编辑此待办作品资料" }).click();
  await tool.getByLabel("资料作品类型").selectOption("tv");
  await tool.getByLabel("资料季号（未知留空）").fill("1");
  await tool.getByRole("button", { name: "保存资料并用于本项目" }).click();
  await tool.getByLabel("预设名称").fill("常用采集");
  await tool.getByRole("button", { name: "保存当前默认选项为预设" }).click();
  await tool.getByRole("button", { name: "应用到后续任务" }).click();
  await expect(tool.getByText(/已应用到后续新任务/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("discovery-profile.png"),
    animations: "disabled"
  });
  await tool.getByRole("button", { name: "带入 Motrix" }).click();
  const motrix = page.getByRole("dialog", { name: "搜索原片与 Motrix 下载" });
  await expect(motrix).toBeVisible();
  await expect(motrix.getByLabel("片名或 IMDb 编号")).toHaveValue("Example");
  await motrix.getByRole("button", { name: "关闭", exact: true }).click();
  const backup = page.waitForEvent("download");
  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "导出项目备份", exact: true }).click();
  const path = testInfo.outputPath("profile-project.json");
  await (await backup).saveAs(path);
  const saved = parseProjectJson(readFileSync(path, "utf8"));
  expect(saved.libraryProfile?.title).toBe("测试作品");
  expect(saved.discoveryItems).toHaveLength(1);
  expect(JSON.stringify(saved.libraryProfile)).not.toMatch(/token|Revision|metadataVersion/);
  await page.getByTestId("project-input").setInputFiles(path);
  await page.getByRole("button", { name: "发现与整理", exact: true }).click();
  await expect(tool.getByLabel("资料作品名称")).toHaveValue("测试作品");
  await page.getByLabel("关闭发现与整理", { exact: true }).click();
  await page.getByTestId("xml-input").setInputFiles({
    name: "S01E01.xml",
    mimeType: "application/xml",
    buffer: Buffer.from('<i><d p="1,1,25,16777215,0,0,u,1">成品</d></i>')
  });
  await page.getByTestId("workspace-nav-export").click();
  await page.getByRole("button", { name: "建立时间线并开始编辑" }).click();
  await page.getByTestId("workspace-nav-export").click();
  const xml = page.waitForEvent("download");
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML", exact: true })
    .click();
  await xml;
  await installLibraryBridge(page);
  await page.getByRole("button", { name: "发布到私人弹幕库", exact: true }).click();
  const publish = page.getByRole("dialog", { name: "更新私人弹幕库" });
  await publish.getByRole("button", { name: "库里没有，新增影视" }).click();
  await expect(publish.getByLabel("正式片名")).toHaveValue("测试作品");
  await expect(publish.getByLabel("观看版本")).toHaveCount(0);
  await expect(publish.getByRole("button", { name: "预览更新" })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("discovery-export-profile.png"),
    animations: "disabled"
  });
  expect(errors).toEqual([]);
});
