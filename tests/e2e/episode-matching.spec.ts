import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createEpisodeMatchingProject } from "../../src/test/episodeMatching";
import { parseProjectJson, serializeProject } from "../../src/domain/project/schema";
import { selectWorkspaceMenu, expectNoPageOverflow } from "./workspace-ui";

test("segmented XML bindings route forty references to eight episodes and corrections survive project backup", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const original = createEpisodeMatchingProject();
  await page
    .getByTestId("project-input")
    .setInputFiles({
      name: "episode-project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProject(original))
    });
  await page.getByTestId("workspace-nav-matching").click();
  await selectWorkspaceMenu(page, "匹配工具", "匹配范围与计算设置");
  const dialog = page.getByRole("dialog", { name: "匹配范围与计算设置" });
  await expect(dialog.getByTestId("smart-pairing-summary")).toContainText(
    "建议分析 40 组，跳过 280 组"
  );
  await dialog.getByText("查看分集对应与修正编号", { exact: true }).click();
  await expect(dialog.getByText("Show S1E1 ← 5 个参考", { exact: true })).toBeVisible();
  await dialog.getByLabel("参考集号", { exact: true }).fill("invalid");
  await dialog.getByRole("button", { name: "应用参考集号", exact: true }).click();
  await expect(dialog.getByText(/未应用。请输入/)).toBeVisible();
  await dialog.getByLabel("参考集号", { exact: true }).fill("S01E02");
  await page.getByRole("button", { name: "关闭匹配范围与计算设置" }).click();
  await selectWorkspaceMenu(page, "匹配工具", "匹配范围与计算设置");
  await expect(dialog.getByLabel("参考集号", { exact: true })).toHaveValue("S01E02");
  await dialog.getByText("查看分集对应与修正编号", { exact: true }).click();
  await dialog.getByRole("button", { name: "应用参考集号", exact: true }).click();
  await expect(dialog.getByText("Show S1E1 ← 4 个参考", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Show S1E2 ← 6 个参考", { exact: true })).toBeVisible();
  await dialog.getByLabel("匹配组合范围").selectOption("all");
  await expect(dialog.getByTestId("smart-pairing-summary")).toContainText("将分析全部 320 组");
  await dialog.getByLabel("匹配组合范围").selectOption("smart");
  await dialog.getByText("查看分集对应与修正编号", { exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("episode-routing.png"),
    animations: "disabled"
  });
  await expectNoPageOverflow(page);
  await page.getByRole("button", { name: "关闭匹配范围与计算设置" }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "导出项目备份", exact: true }).click();
  const backup = testInfo.outputPath("episode-project.json");
  await (await downloaded).saveAs(backup);
  const saved = parseProjectJson(readFileSync(backup, "utf8"));
  expect(saved.mediaLibrary.find((m) => m.id === "source-1")?.episodeKey).toBe("S1E2");
  expect(saved.assets).toEqual(original.assets);
  expect(saved.mediaTimeMaps).toEqual([]);
  // Recover in a fresh page so a preserved input draft cannot stand in for saved data.
  await page.reload();
  await page.getByTestId("project-input").setInputFiles(backup);
  await page.getByTestId("workspace-nav-matching").click();
  await selectWorkspaceMenu(page, "匹配工具", "匹配范围与计算设置");
  await dialog.getByText("查看分集对应与修正编号", { exact: true }).click();
  await expect(dialog.getByLabel("参考集号", { exact: true })).toHaveValue("S1E2");
  await expect(dialog.getByText("Show S1E2 ← 6 个参考", { exact: true })).toBeVisible();
  await dialog.getByLabel("参考集号", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "应用参考集号", exact: true }).click();
  await expect(dialog.getByText("Show S1E1 ← 5 个参考", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 720, height: 480 });
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});
