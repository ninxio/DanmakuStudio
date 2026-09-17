import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createPlaybackCoverageProject } from "../../src/test/playbackCoverage";
import { parseProjectJson, serializeProject } from "../../src/domain/project/schema";
import { projectDanmakuToTargets } from "../../src/domain/timeline/sourceProjection";
import { expectInViewport, expectNoPageOverflow } from "./workspace-ui";

test("coverage first: adopt batch, keep unknown comments, recover and locate a correction", async ({
  page
}, testInfo) => {
  const original = createPlaybackCoverageProject(Array.from({ length: 8 }, () => 5));
  original.mediaMatchCandidates = original.mediaMatchCandidates.filter(
    (_, index) => ![19, 24, 34].includes(index)
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByTestId("project-input").setInputFiles({
    name: "coverage.json",
    mimeType: "application/json",
    buffer: Buffer.from(serializeProject(original))
  });
  await page.getByTestId("workspace-nav-editing").click();
  const coverage = page.getByRole("region", { name: "匹配覆盖分析" });
  await expect(coverage).toContainText("74 条可导出");
  await expect(coverage).toContainText("46 条未覆盖");
  await expect(coverage).toContainText("3 个参考未定位");
  await expect(coverage.getByRole("checkbox")).toHaveCount(0);
  await expect(coverage.getByRole("img", { name: "整集覆盖汇总" })).toBeVisible();
  await expect(coverage.getByText(/每行是一个参考/)).toBeVisible();
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 720, height: 480 }
  ]) {
    await page.setViewportSize(viewport);
    await expectInViewport(coverage.getByRole("button", { name: "采用全部并导出" }));
    await expectNoPageOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`coverage-${viewport.width}.png`),
      animations: "disabled"
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await coverage.getByRole("button", { name: "采用全部并导出" }).click();
  // Browser cannot verify these local fixture files. A failed export must not lose adoption.
  await expect(coverage.getByRole("button", { name: "采用全部并导出" })).toBeEnabled();
  await expect(coverage).toContainText(/导出.*(失败|阻断|完成)/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await coverage.getByRole("button", { name: "保存匹配备份" }).click();
  const backup = testInfo.outputPath("coverage-adopted.json");
  await (await download).saveAs(backup);
  const saved = parseProjectJson(readFileSync(backup, "utf8"));
  expect(saved.mediaMatchCandidates.every((candidate) => candidate.state === "accepted")).toBe(
    true
  );
  expect(saved.alignmentReviewRecords).toEqual([]);
  expect(saved.assets).toEqual(original.assets);
  expect(projectDanmakuToTargets(saved).projectedItemCount).toBe(74);
  await page.reload();
  await page.getByTestId("project-input").setInputFiles(backup);
  await page.getByTestId("workspace-nav-editing").click();
  await expect(coverage).toContainText("74 条可导出");
  const lane = coverage.getByRole("button", { name: /定位 .* 的时间区间/ }).first();
  const bounds = await lane.boundingBox();
  await lane.click({ position: { x: bounds!.width * 0.4, y: bounds!.height / 2 } });
  await expect(page.getByText("第 2 / 2 段", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "修改这一段" })).toBeVisible();
  const sourceRuler = page.getByRole("img", { name: "参考时间刻度" });
  const targetRuler = page.getByRole("img", { name: "原片时间刻度" });
  await expect(sourceRuler).toBeVisible();
  await expect(targetRuler).toBeVisible();
  expect(await sourceRuler.getAttribute("data-duration-ms")).toBe(
    await targetRuler.getAttribute("data-duration-ms")
  );
  expect(
    Math.abs(
      (await sourceRuler.boundingBox())!.width - (await targetRuler.boundingBox())!.width
    )
  ).toBeLessThan(1);
  await page.screenshot({
    path: testInfo.outputPath("coverage-correction.png"),
    animations: "disabled"
  });
  await page.getByRole("button", { name: "返回覆盖分析" }).click();
  await expect(coverage).toBeVisible();
  expect(errors).toEqual([]);
});
