import { createDenseReviewProjectJson } from "./dense-project-fixture";
import { expectInViewport, expectNoPageOverflow } from "./workspace-ui";
import { expect, test } from "@playwright/test";

test("两种主题覆盖四页、最小宽度与安全拖动区，偏好和键盘焦点可恢复", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 720 });
  await page.goto("/");
  await page.getByTestId("xml-input").setInputFiles({
    name: "新工作流.xml",
    mimeType: "text/xml",
    buffer: Buffer.from('<i><d p="1.5,1,25,16777215,0,0,u,r">新版弹幕</d></i>')
  });
  await page.getByRole("button", { name: "开始编辑弹幕", exact: true }).click();
  for (const theme of ["light", "dark"] as const) {
    await page
      .getByRole("radio", { name: theme === "light" ? "浅色" : "深色", exact: true })
      .check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const route of ["materials", "matching", "editing", "export"] as const) {
      await page.getByTestId(`workspace-nav-${route}`).click();
      await expect(page.getByTestId(`workspace-${route}`)).toBeVisible();
      await expect(page.getByTestId("workspace-route-loading")).toHaveCount(0);
      if (route === "materials") {
        await expect(page.getByRole("heading", { name: "批量关系建议" })).toHaveCount(0);
        await expect(page.getByRole("table", { name: "弹幕素材与来源关系" })).toBeVisible();
      }
      if (route === "export") {
        const saveButton = page.getByRole("button", { name: "导出 XML", exact: true });
        await expect(saveButton).toBeEnabled();
        const bounds = await saveButton.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y).toBeGreaterThan(100);
        expect(bounds!.y + bounds!.height).toBeLessThan(720);
      }
      expect(
        await page.evaluate(() => ({
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight
        }))
      ).toEqual({ width: 1080, height: 720 });
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${theme}-${route}.png`)
      });
    }
  }
  const drag = page.locator(".window-drag-region");
  expect((await drag.boundingBox())?.width).toBeGreaterThan(320);
  expect((await drag.boundingBox())?.height).toBe(40);
  await expect(drag.locator("button, input, select")).toHaveCount(0);
  await expect(page.getByTestId("toolbar-primary-row")).not.toHaveAttribute(
    "data-tauri-drag-region"
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("项目菜单").click();
  await page.getByLabel("界面密度", { exact: true }).selectOption("compact");
  await page.getByLabel("减少动态效果", { exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("app-root")).toHaveAttribute("data-density", "compact");
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await page.reload();
  await expect(page.getByTestId("app-root")).toHaveAttribute("data-density", "compact");
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await page.getByRole("radio", { name: "跟随系统", exact: true }).check();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置中心" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
});

test("主 bundle 尚未加载时，已保存深色仍在首帧应用", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("danmaku.studio.theme.v1", "dark"));
  let releaseBundle!: () => void;
  let markIntercepted!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseBundle = resolve;
  });
  const intercepted = new Promise<void>((resolve) => {
    markIntercepted = resolve;
  });
  await page.route(/\/(?:assets\/index-[^/]+\.js|src\/main\.tsx)(?:\?.*)?$/, async (route) => {
    markIntercepted();
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    await intercepted;
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#root")).toBeEmpty();
  } finally {
    releaseBundle();
  }
  await expect(page.getByTestId("workflow-stepper")).toBeVisible();
});

test("14 P 密集项目保持双画面双轨首屏，短屏切换不重建绘图与播放器", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1080, height: 720 });
  await page.goto("/");
  await page.getByTestId("project-input").setInputFiles({
    name: "14p-ui-structure-replay.danmaku-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(createDenseReviewProjectJson(), "utf8")
  });
  await expect(page.getByTestId("status-bar")).toContainText("已打开项目");
  await page.getByTestId("workspace-nav-editing").click();
  await expect(page.getByRole("region", { name: "匹配覆盖分析" })).toBeVisible();
  await page.getByRole("tab", { name: "精确修正" }).click();
  await expect(page.getByLabel("精修参考").locator("option")).toHaveCount(14);
  for (const viewport of [
    { width: 1400, height: 900 },
    { width: 1080, height: 720 },
    { width: 1024, height: 640 }
  ]) {
    await page.setViewportSize(viewport);
    await expectInViewport(page.getByRole("region", { name: "A/B 视频监视器与播放" }));
    await expectInViewport(page.getByRole("region", { name: "正式 TimeMap 与风险区" }));
    await expectInViewport(page.locator(".time-map-tracks"));
    const tracks = await page.locator(".time-map-track").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const label = element.firstElementChild!.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          labelTop: label.top,
          labelBottom: label.bottom,
          contentHeight: element.scrollHeight,
          height: element.clientHeight
        };
      })
    );
    expect(tracks).toHaveLength(2);
    expect(tracks[0].labelBottom).toBeLessThanOrEqual(tracks[1].labelTop);
    for (const track of tracks) {
      expect(track.labelTop).toBeGreaterThanOrEqual(track.top);
      expect(track.labelBottom).toBeLessThanOrEqual(track.bottom + 1);
      expect(track.contentHeight).toBeLessThanOrEqual(track.height + 1);
    }
    await expectNoPageOverflow(page);
    for (const theme of ["浅色", "深色"]) {
      await page.getByRole("radio", { name: theme, exact: true }).check();
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`dense-${theme}-${viewport.width}x${viewport.height}.png`)
      });
    }
  }
  const canvasNodes = await page.locator(".time-map-risk-track canvas").elementHandles();
  expect(canvasNodes).toHaveLength(2);
  const viewers = await page.getByTestId("dual-video-viewers").elementHandle();
  await page.setViewportSize({ width: 1024, height: 600 });
  const surfaces = page.getByRole("tablist", { name: "编辑工作面", exact: true });
  await expect(surfaces).toBeVisible();
  await surfaces.getByRole("tab", { name: "双画面预览" }).click();
  await expectInViewport(page.getByTestId("dual-video-viewers"));
  await surfaces.getByRole("tab", { name: "时间线", exact: true }).click();
  await expectInViewport(page.locator(".time-map-tracks"));
  await page.setViewportSize({ width: 720, height: 480 });
  await expectInViewport(page.getByTestId("workflow-stepper"));
  await expectInViewport(page.locator(".time-map-tracks"));
  const trackSizes = await page
    .locator(".time-map-track")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ visible: node.clientHeight, content: node.scrollHeight }))
    );
  for (const size of trackSizes) expect(size.content).toBeLessThanOrEqual(size.visible + 1);
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dense-720x480-timeline.png")
  });
  await surfaces.getByRole("tab", { name: "双画面预览" }).click();
  await expectInViewport(page.getByTestId("dual-video-viewers"));
  await page.screenshot({
    animations: "disabled",
    path: testInfo.outputPath("dense-720x480-preview.png")
  });
  for (const canvas of canvasNodes)
    expect(await canvas.evaluate((node) => node.isConnected)).toBe(true);
  expect(await viewers!.evaluate((node) => node.isConnected)).toBe(true);
  await expectNoPageOverflow(page);
});

test("批量导入 14 组同名 XML 与参考素材自动关联，并以一次撤销恢复本次导入", async ({
  page
}) => {
  await page.goto("/");
  const ordinals = Array.from({ length: 14 }, (_, index) => String(index + 1).padStart(2, "0"));
  await page.getByTestId("xml-input").setInputFiles(
    ordinals.map((part) => ({
      name: `P${part}.xml`,
      mimeType: "text/xml",
      buffer: Buffer.from(`<i><d p="1,1,25,16777215,0,0,u,${part}">P${part} 弹幕</d></i>`)
    }))
  );
  await expect(page.getByTestId("asset-card")).toHaveCount(14);
  await page.getByLabel("导入 B 站参考素材文件", { exact: true }).setInputFiles(
    ordinals.map((part) => ({
      name: `P${part}.mp4`,
      mimeType: "video/mp4",
      buffer: Buffer.alloc(0)
    }))
  );
  await page.getByRole("tab", { name: /^弹幕 XML / }).click();
  for (const part of ordinals) {
    await expect(page.getByLabel(`P${part}.xml 弹幕来源素材`, { exact: true })).not.toHaveValue(
      ""
    );
  }
  await page.getByLabel("撤销", { exact: true }).click();
  await expect(page.getByTestId("asset-card")).toHaveCount(14);
  for (const part of ordinals)
    await expect(page.getByLabel(`P${part}.xml 弹幕来源素材`, { exact: true })).toHaveValue("");
  await expect(page.getByRole("tab", { name: /^参考 0$/ })).toBeVisible();
  await page.getByLabel("重做", { exact: true }).click();
  for (const part of ordinals)
    await expect(page.getByLabel(`P${part}.xml 弹幕来源素材`, { exact: true })).not.toHaveValue(
      ""
    );
});
