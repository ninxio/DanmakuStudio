import { expectInViewport, expectNoPageOverflow, selectWorkspaceMenu } from "./workspace-ui";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createMediaMatchCandidate,
  upsertMediaMatchCandidate
} from "../../src/domain/alignment/mediaMatching";
import type { AlignmentProposal } from "../../src/domain/alignment/types";
import { createEmptyProject } from "../../src/domain/project/factory";
import { createLocalPathMediaReference } from "../../src/domain/project/mediaLibrary";
import { serializeProject } from "../../src/domain/project/schema";
import { createTestCompleteTimeMapSpan } from "../../src/test/timeMapEvidence";

interface UsabilityPerformanceBaseline {
  measuredAt: string;
  startupMs: number;
  largeXmlImportMs: number;
  pageSwitchMs: Record<string, number>;
  importedDanmakuCount: number;
  domNodeCountAfterImport: number;
  viewport: {
    width: number;
    height: number;
  };
}

test("易用化阶段 0 记录启动、四页切换和一万条 XML 导入基线", async ({ page }, testInfo) => {
  const startupStartedAt = performance.now();
  await page.goto("/");
  await expect(page.getByTestId("app-root")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("准备就绪");
  const startupMs = performance.now() - startupStartedAt;

  const pageSwitchMs: Record<string, number> = {};
  for (const pageId of ["matching", "editing", "export", "materials"] as const) {
    const switchStartedAt = performance.now();
    await page.getByTestId(`workspace-nav-${pageId}`).click();
    await expect(page.getByTestId(`workspace-${pageId}`)).toBeVisible();
    pageSwitchMs[pageId] = performance.now() - switchStartedAt;
  }

  const importStartedAt = performance.now();
  await page
    .getByTestId("xml-input")
    .setInputFiles(resolve("fixtures", "bilibili", "large-10000.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("10000 条弹幕");
  await expect(page.getByTestId("asset-card")).toContainText("large-10000.xml");
  const largeXmlImportMs = performance.now() - importStartedAt;

  const runtime = await page.evaluate(() => ({
    domNodeCountAfterImport: document.getElementsByTagName("*").length,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  }));
  const baseline: UsabilityPerformanceBaseline = {
    measuredAt: new Date().toISOString(),
    startupMs: roundMilliseconds(startupMs),
    largeXmlImportMs: roundMilliseconds(largeXmlImportMs),
    pageSwitchMs: Object.fromEntries(
      Object.entries(pageSwitchMs).map(([pageId, elapsedMs]) => [
        pageId,
        roundMilliseconds(elapsedMs)
      ])
    ),
    importedDanmakuCount: 10_000,
    domNodeCountAfterImport: runtime.domNodeCountAfterImport,
    viewport: runtime.viewport
  };

  await testInfo.attach("usability-performance-baseline.json", {
    body: Buffer.from(JSON.stringify(baseline, null, 2), "utf8"),
    contentType: "application/json"
  });
  console.info(`USABILITY_PERFORMANCE_BASELINE ${JSON.stringify(baseline)}`);

  expect(baseline.startupMs).toBeGreaterThanOrEqual(0);
  expect(baseline.largeXmlImportMs).toBeLessThanOrEqual(217.8);
  expect(Math.max(...Object.values(baseline.pageSwitchMs))).toBeLessThanOrEqual(150);
  expect(Object.keys(baseline.pageSwitchMs)).toEqual([
    "matching",
    "editing",
    "export",
    "materials"
  ]);
});

test("易用化阶段 1 的四步壳层在最小视口可用并记住面板布局", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  await expect(page.getByTestId("workflow-stepper")).toBeVisible();
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("context-rail")).toHaveCount(0);
  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "项目与分集", exact: true }).click();
  const projectSheet = page.getByRole("dialog", { name: "项目与分集", exact: true });
  await expect(projectSheet).toBeVisible();
  await expect(projectSheet.getByTestId("project-sidebar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projectSheet).toHaveCount(0);
  await expect(page.getByLabel("项目菜单")).toBeFocused();
  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "当前项目状态", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "当前项目状态" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const pageId of ["materials", "matching", "editing", "export"] as const) {
    await expect(page.getByTestId(`workspace-nav-${pageId}`)).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("project-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("context-rail")).toHaveCount(0);
  await page.getByTestId("workspace-nav-matching").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-matching")).toBeVisible();
  await expect(page.getByTestId("workspace-nav-matching")).toHaveAttribute(
    "aria-current",
    "page"
  );

  const commandTrigger = page.getByRole("button", { name: "打开命令与快捷键" });
  await expect(commandTrigger).toBeVisible();
  await page.keyboard.press("Control+K");
  const commandDialog = page.getByRole("dialog", { name: "命令与快捷键" });
  const commandSearch = commandDialog.getByRole("combobox", { name: "搜索命令" });
  await expect(commandSearch).toBeFocused();
  await expect(commandDialog.getByText("Ctrl+K", { exact: true })).toBeVisible();
  await expect(commandDialog.getByText("Ctrl+Shift+K", { exact: true })).toBeVisible();
  await expect(commandDialog.getByText("当前已在匹配页", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(commandDialog).toHaveCount(0);
  await expect(commandTrigger).toBeFocused();

  // 用户操作数：打开命令入口、选择目标、执行，共 3 个主要动作。
  await commandTrigger.click();
  await page.getByRole("combobox", { name: "搜索命令" }).fill("导出");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-export")).toBeVisible();
  await expect(page.getByTestId("workspace-route-loading")).toHaveCount(0);

  const commandTriggerLefts: number[] = [];
  for (const pageId of ["materials", "matching", "editing", "export"] as const) {
    await page.getByTestId(`workspace-nav-${pageId}`).click();
    await expect(page.getByTestId(`workspace-${pageId}`)).toBeVisible();
    await expect(page.getByTestId("workspace-route-loading")).toHaveCount(0);
    const layout = await page.evaluate(() => {
      const trigger = document.querySelector<HTMLElement>('[aria-label="打开命令与快捷键"]');
      const primaryRow = document.querySelector<HTMLElement>(
        '[data-testid="toolbar-primary-row"]'
      );
      const stepper = document.querySelector<HTMLElement>('[data-testid="workflow-stepper"]');
      const main = document.querySelector<HTMLElement>("main");
      if (!trigger || !primaryRow || !stepper || !main) {
        throw new Error("UX-R5 稳定壳层未完整挂载");
      }
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentScrollHeight: document.documentElement.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        triggerLeft: trigger.getBoundingClientRect().left,
        primaryRowHeight: primaryRow.getBoundingClientRect().height,
        stepperBeforeWorkspace: Boolean(
          stepper.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING
        )
      };
    });
    expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.documentScrollHeight).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.bodyScrollHeight).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.primaryRowHeight).toBeGreaterThanOrEqual(44);
    expect(layout.primaryRowHeight).toBeLessThanOrEqual(80);
    expect(layout.stepperBeforeWorkspace).toBe(true);
    commandTriggerLefts.push(layout.triggerLeft);
    await testInfo.attach(`ux-r5-${pageId}-1280x720.png`, {
      body: await page.screenshot(),
      contentType: "image/png"
    });
  }
  expect(
    Math.max(...commandTriggerLefts) - Math.min(...commandTriggerLefts)
  ).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "查看全部后台任务" }).click();
  await expect(page.getByRole("region", { name: "全部后台任务" })).toBeVisible();
  const taskCenterLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight
  }));
  expect(taskCenterLayout.documentScrollWidth).toBeLessThanOrEqual(
    taskCenterLayout.viewportWidth
  );
  expect(taskCenterLayout.documentScrollHeight).toBeLessThanOrEqual(
    taskCenterLayout.viewportHeight
  );
  expect(taskCenterLayout.bodyScrollWidth).toBeLessThanOrEqual(taskCenterLayout.viewportWidth);
  expect(taskCenterLayout.bodyScrollHeight).toBeLessThanOrEqual(
    taskCenterLayout.viewportHeight
  );
  await testInfo.attach("ux-r9-task-center-1280x720.png", {
    body: await page.screenshot(),
    contentType: "image/png"
  });
  await page.getByRole("button", { name: "收起全部后台任务" }).click();
});

test("UX-R12 在三档视口使用有效密度并保持四步工作区零页面滚动", async ({ page }, testInfo) => {
  const viewports = [
    { name: "1280x720", width: 1280, height: 720, gutterPx: 16, fontSizePx: 15 },
    { name: "1440x900", width: 1440, height: 900, gutterPx: 24, fontSizePx: 16 },
    { name: "1920x1080", width: 1920, height: 1080, gutterPx: 24, fontSizePx: 16 }
  ] as const;
  const pages = ["materials", "matching", "editing", "export"] as const;

  await page.addInitScript(() => {
    window.localStorage.removeItem("danmaku.studio.layoutSettings.v1");
  });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    for (const pageId of pages) {
      await page.getByTestId(`workspace-nav-${pageId}`).click();
      const workspace = page.getByTestId(`workspace-${pageId}`);
      await expect(workspace).toBeVisible();
      await expect(page.getByTestId("workspace-route-loading")).toHaveCount(0);

      const primaryAction =
        pageId === "materials"
          ? workspace.getByRole("button", { name: "添加素材" })
          : pageId === "matching"
            ? workspace.getByRole("button", { name: "去导入弹幕 XML" })
            : pageId === "editing"
              ? workspace.getByRole("button", { name: "播放高级弹幕时间线" })
              : workspace.getByRole("button", { name: "去导入弹幕 XML" });
      await expect(primaryAction).toBeVisible();
      const primaryActionBox = await primaryAction.boundingBox();
      expect(primaryActionBox).not.toBeNull();
      if (!primaryActionBox) {
        throw new Error(`UX-R12 ${pageId} 首屏动作没有可测量边界。`);
      }
      expect(primaryActionBox.y).toBeGreaterThanOrEqual(0);
      expect(primaryActionBox.y + primaryActionBox.height).toBeLessThanOrEqual(viewport.height);

      const layout = await workspace.evaluate((element) => {
        const app = document.querySelector<HTMLElement>("[data-testid='app-root']");
        const gutter = element.querySelector<HTMLElement>(".app-workspace-gutter");
        if (!app || !gutter) {
          throw new Error("UX-R12 工作区密度容器未挂载");
        }
        const gutterStyle = window.getComputedStyle(gutter);
        const appStyle = window.getComputedStyle(app);
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentScrollWidth: document.documentElement.scrollWidth,
          documentScrollHeight: document.documentElement.scrollHeight,
          bodyScrollWidth: document.body.scrollWidth,
          bodyScrollHeight: document.body.scrollHeight,
          gutterTopPx: Number.parseFloat(gutterStyle.paddingTop),
          gutterLeftPx: Number.parseFloat(gutterStyle.paddingLeft),
          fontSizePx: Number.parseFloat(appStyle.fontSize)
        };
      });

      expect(layout.gutterTopPx).toBeGreaterThanOrEqual(0);
      expect(layout.gutterLeftPx).toBeGreaterThanOrEqual(0);
      expect(layout.fontSizePx).toBeGreaterThanOrEqual(14);
      expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.documentScrollHeight).toBeLessThanOrEqual(layout.viewportHeight);
      expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.bodyScrollHeight).toBeLessThanOrEqual(layout.viewportHeight);

      await testInfo.attach(`ux-r12-${pageId}-${viewport.name}.png`, {
        body: await page.screenshot(),
        contentType: "image/png"
      });
    }
  }
});

test("易用化阶段 2 的浏览器素材不会绕过音轨准备阻断", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  await expect(page.getByTestId("materials-summary")).toContainText(
    "导入 XML 就可以开始，不需要视频"
  );
  await page.getByLabel("导入原片素材文件").setInputFiles({
    name: "S01E01.mkv",
    mimeType: "video/x-matroska",
    buffer: Buffer.from("target-video")
  });
  await page.getByRole("tab", { name: /^原片 / }).click();
  await expect(
    page.getByTestId("targetOriginal-dropzone").getByText("S01E01.mkv", { exact: true })
  ).toBeVisible();

  await page.getByLabel("导入 B 站参考素材文件").setInputFiles({
    name: "bilibili-reference.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("reference-video")
  });
  await expect(page.getByTestId("materials-summary")).toContainText(
    "导入 XML 就可以开始，不需要视频"
  );

  await page.getByLabel("导入弹幕 XML 文件").setInputFiles({
    name: "episode.xml",
    mimeType: "text/xml",
    buffer: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,0,0,u,r">测试</d></i>',
      "utf8"
    )
  });
  await expect(page.getByTestId("materials-summary")).toContainText("确认 1 个弹幕来源");
  await page.getByRole("tab", { name: /^弹幕 XML / }).click();

  await page
    .getByLabel("episode.xml 弹幕来源素材")
    .selectOption({ label: "bilibili-reference" });
  await expect(page.getByRole("button", { name: "处理 2 个音轨" })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入智能匹配" })).toHaveCount(0);
  for (const [category, fileName] of [
    ["原片", "S01E01.mkv"],
    ["参考", "bilibili-reference.mp4"]
  ]) {
    await page.getByRole("tab", { name: new RegExp(`^${category} `) }).click();
    await page.getByRole("button", { name: `${fileName} 文件详情` }).click();
    await expect(
      page
        .getByRole("dialog", { name: "素材详情与音轨" })
        .getByText("重新连接后才能准备音轨", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭素材详情与音轨" }).click();
  }
  await expectInViewport(page.getByTestId("materials-primary-action"));
  await expectNoPageOverflow(page);

  await testInfo.attach("ux-r1-materials-1280x720.png", {
    body: await page.screenshot(),
    contentType: "image/png"
  });

  if (process.env.DANMAKU_CAPTURE_DOCS === "1") {
    await page.screenshot({
      path: resolve("docs", "images", "danmaku-studio-materials.png")
    });
  }

  await page.getByTestId("workspace-nav-matching").click();
  await expect(page.getByTestId("workspace-matching")).toBeVisible();
  await expect(page.getByTestId("matching-summary")).toBeVisible();
  await expect(page.getByRole("button", { name: "处理 2 个音轨" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始批量匹配" })).toHaveCount(0);
  await expect(page.getByTestId("real-media-benchmark-panel")).toHaveCount(0);
  await expect(page.getByText("开发与验收工具", { exact: true })).toHaveCount(0);
  const matchingLayout = await page.evaluate(() => {
    const consoleRoot = document.querySelector<HTMLElement>(
      '[data-testid="matching-run-console"]'
    );
    const primaryAction = document.querySelector<HTMLElement>(
      '[data-testid="matching-primary-action"]'
    );
    const queue = document.querySelector<HTMLElement>('[data-testid="matching-task-queue"]');
    const detail = document.querySelector<HTMLElement>('[data-testid="matching-task-detail"]');
    if (!consoleRoot || !primaryAction || !queue || !detail) {
      throw new Error("匹配 Run Console 横屏布局未完整挂载");
    }
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentScrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      bodyScrollHeight: document.body.scrollHeight,
      consoleBottom: consoleRoot.getBoundingClientRect().bottom,
      primaryActionBottom: primaryAction.getBoundingClientRect().bottom,
      queueOverflowY: getComputedStyle(queue).overflowY,
      detailOverflowY: getComputedStyle(detail).overflowY
    };
  });
  expect(matchingLayout.documentScrollWidth).toBeLessThanOrEqual(matchingLayout.viewportWidth);
  expect(matchingLayout.documentScrollHeight).toBeLessThanOrEqual(
    matchingLayout.viewportHeight
  );
  expect(matchingLayout.bodyScrollWidth).toBeLessThanOrEqual(matchingLayout.viewportWidth);
  expect(matchingLayout.bodyScrollHeight).toBeLessThanOrEqual(matchingLayout.viewportHeight);
  expect(matchingLayout.consoleBottom).toBeLessThanOrEqual(matchingLayout.viewportHeight);
  expect(matchingLayout.primaryActionBottom).toBeLessThanOrEqual(matchingLayout.viewportHeight);
  expect(matchingLayout.queueOverflowY).toBe("auto");
  await expectInViewport(page.getByTestId("matching-task-detail"));

  await testInfo.attach("ux-r2-matching-run-console-1280x720.png", {
    body: await page.screenshot(),
    contentType: "image/png"
  });
  await selectWorkspaceMenu(page, "匹配工具", "匹配范围与计算设置");
  const browserBlockers = page.getByRole("checkbox", {
    name: /临时浏览器引用；自动匹配请回素材页删除后用桌面批量导入/
  });
  await expect(browserBlockers).toHaveCount(2);
  await expect(browserBlockers.nth(0)).toBeDisabled();
  await expect(browserBlockers.nth(1)).toBeDisabled();
  await page.getByRole("button", { name: "关闭匹配范围与计算设置" }).click();
  await page.getByTestId("workspace-nav-materials").click();
  await expect(page.getByTestId("workspace-materials")).toBeVisible();
});

test("易用化阶段 4 在编辑工作区保留常用非破坏性修复", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(process.env.DANMAKU_UX_R3_BASE_URL ?? "/");
  await page.getByLabel("导入弹幕 XML 文件").setInputFiles({
    name: "calibration.xml",
    mimeType: "text/xml",
    buffer: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><i><d p="2,1,25,16777215,0,0,u,r">校准</d></i>',
      "utf8"
    )
  });
  await page.getByTestId("workspace-nav-editing").click();

  await expect(page.getByTestId("preview-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "偏移与校准" }).click();
  const overview = page.getByTestId("calibration-overview");
  await expect(overview).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("timeline-panel")).toBeVisible();

  await overview.getByRole("button", { name: /开始编辑弹幕/ }).click();
  await expect(overview.getByRole("button", { name: /播放检查/ })).toBeVisible();
  await overview.locator("summary").filter({ hasText: "常用修复" }).click();
  await overview.getByRole("button", { name: "整体延后 0.5 秒" }).click();
  await expect(overview).toContainText("整体偏移 延后 0.5 秒");

  await overview.getByRole("button", { name: /从这里重新同步/ }).click();
  await overview.getByLabel("对应原片时间").fill("00:00:03.000");
  await overview.getByRole("button", { name: "保存同步点" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已添加同步点");

  await overview.getByRole("button", { name: /这之后有版本差异/ }).click();
  await overview.getByLabel("版本差异秒数").fill("-1.5");
  await overview.getByRole("button", { name: "保存版本差异" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已标记版本差异");

  if (process.env.DANMAKU_CAPTURE_DOCS === "1") {
    await page.screenshot({
      path: resolve("docs", "images", "danmaku-studio-calibration.png")
    });
  }

  await page.getByRole("button", { name: "关闭偏移与校准" }).click();
  await page.getByTestId("workspace-nav-materials").click();
  await page.getByLabel("导入 B 站参考素材文件").setInputFiles({
    name: "learning-reference.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("learning-reference")
  });
  await page.getByTestId("workspace-nav-editing").click();
  await selectWorkspaceMenu(page, "更多工具", "算法改进数据");
  const learningPanel = page.getByTestId("alignment-learning-panel");
  const learningSummary = page.getByTestId("alignment-learning-summary");
  const personalGold = page.getByTestId("personal-gold-workbench");
  const adjudication = page.getByLabel("独立复核区");
  await expect(learningPanel).toBeVisible();
  await expect(learningSummary).toBeVisible();
  await expect(personalGold).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 Personal Gold 数据包" })).toBeVisible();
  await expect(adjudication).toBeVisible();

  await expectInViewport(page.getByRole("dialog", { name: "算法改进数据" }));
  await expectNoPageOverflow(page);
  await page.getByRole("button", { name: "关闭算法改进数据" }).click();

  await page.getByTestId("project-input").setInputFiles({
    name: "ux-r3-review-workbench.danmaku-project.json",
    mimeType: "application/json",
    buffer: Buffer.from(createUxR3ReviewProjectJson(), "utf8")
  });
  await expect(page.getByTestId("status-bar")).toContainText("已打开项目");
  await page.getByTestId("workspace-nav-editing").click();
  await page.getByRole("tab", { name: "精确修正" }).click();

  const captureBefore = process.env.DANMAKU_CAPTURE_UX_R3_BEFORE === "1";
  const evidenceFileName = captureBefore
    ? "ux-r3-before-1280x720.png"
    : "ux-r3-after-1280x720.png";
  const evidenceDirectory = process.env.DANMAKU_UX_R3_EVIDENCE_DIR;
  if (captureBefore) {
    await captureUxR3Evidence(page, testInfo, evidenceFileName, evidenceDirectory);
    return;
  }

  await page.getByRole("button", { name: "下一段", exact: true }).click();
  await expect(page.getByText("第 2 / 3 段", { exact: true })).toBeVisible();
  await expectInViewport(page.getByRole("region", { name: "A/B 视频监视器与播放" }));
  await expectInViewport(page.getByRole("region", { name: "正式 TimeMap 与风险区" }));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("dual-video-viewers")).toContainText("B · 目标原片");
  await expectNoPageOverflow(page);
  await selectWorkspaceMenu(page, /^标记(?:多出内容|参考多出|原片多出)$/, "标记原片多出");
  await page.getByRole("button", { name: "精确边界", exact: true }).click();
  const precise = page.getByRole("dialog", { name: "精确边界" });
  await expect(precise.getByLabel("精确边界输入")).toBeVisible();
  await precise.getByRole("button", { name: "开始向后 100 毫秒" }).click();
  await precise.getByRole("button", { name: /确认原片独有/ }).click();
  await expect(page.getByTestId("status-bar")).toContainText("原片独有");
  await expect(precise).toHaveCount(0);
  await expect(page.getByLabel("撤销", { exact: true })).toBeEnabled();

  await captureUxR3Evidence(page, testInfo, evidenceFileName, evidenceDirectory);

  await page.getByTestId("workspace-nav-export").click();
  await expect(page.getByTestId("workspace-export")).toBeVisible();
  const captureUxR4Before = process.env.DANMAKU_CAPTURE_UX_R4_BEFORE === "1";
  const uxR4EvidenceFileName = captureUxR4Before
    ? "ux-r4-before-1280x720.png"
    : "ux-r4-after-1280x720.png";
  const uxR4EvidenceDirectory = process.env.DANMAKU_UX_R4_EVIDENCE_DIR;
  if (captureUxR4Before) {
    await captureUxR3Evidence(page, testInfo, uxR4EvidenceFileName, uxR4EvidenceDirectory);
    return;
  }

  const deliveryCenter = page.getByTestId("export-delivery-center");
  const deliveryQueue = page.getByTestId("delivery-episode-list");
  const locateBlocker = page.getByRole("button", { name: "处理首个问题" });
  await expect(deliveryCenter).toBeVisible();
  await expect(deliveryQueue).toBeVisible();
  await expect(locateBlocker).toBeVisible();
  await expect(page.getByRole("button", { name: "导出工具" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 720 });
    await expectInViewport(locateBlocker);
    await expectInViewport(deliveryQueue);
    await expectNoPageOverflow(page);
  }
  await selectWorkspaceMenu(page, "导出工具", "单文件导出与高级检查");
  await expect(page.getByRole("dialog", { name: "单文件导出与高级检查" })).toBeVisible();
  await page.getByRole("button", { name: "关闭单文件导出与高级检查" }).click();
  await captureUxR3Evidence(page, testInfo, uxR4EvidenceFileName, uxR4EvidenceDirectory);

  await page.setViewportSize({ width: 1280, height: 720 });
  await locateBlocker.click();
  await expect(page.getByTestId("workspace-matching")).toBeVisible();
});

async function captureUxR3Evidence(
  page: Page,
  testInfo: TestInfo,
  fileName: string,
  evidenceDirectory?: string
): Promise<void> {
  const screenshot = await page.screenshot();
  await testInfo.attach(fileName, { body: screenshot, contentType: "image/png" });
  if (evidenceDirectory) {
    mkdirSync(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: resolve(evidenceDirectory, fileName) });
  }
}

function createUxR3ReviewProjectJson(): string {
  const timestamp = "2026-08-30T00:00:00.000Z";
  let project = createEmptyProject("UX-R3 编辑复核视觉证据");
  project.mediaLibrary = [
    createLocalPathMediaReference(
      "ux-r3-source",
      "bilibiliReference",
      "C:\\media\\UX-R3-参考素材.mp4",
      60_000,
      timestamp
    ),
    createLocalPathMediaReference(
      "ux-r3-target",
      "targetOriginal",
      "C:\\media\\UX-R3-目标原片.mkv",
      65_000,
      timestamp
    )
  ];
  project.assets = [
    {
      id: "ux-r3-asset",
      name: "UX-R3 弹幕",
      fileName: "UX-R3.xml",
      color: "#4cc9f0",
      items: [],
      warnings: [],
      importedAt: timestamp,
      sourceReceipt: null
    }
  ];
  project.danmakuSourceBindings = [
    {
      id: "ux-r3-binding",
      assetId: "ux-r3-asset",
      sourceMediaId: "ux-r3-source",
      linkedAt: timestamp,
      updatedAt: timestamp
    }
  ];
  const candidate = createMediaMatchCandidate(
    project,
    {
      id: "ux-r3-candidate",
      batchId: "ux-r3-batch",
      sourceMediaId: "ux-r3-source",
      targetMediaId: "ux-r3-target",
      proposal: createUxR3ReviewProposal()
    },
    timestamp
  );
  project = upsertMediaMatchCandidate(project, candidate, timestamp);
  return serializeProject(project);
}

function createUxR3ReviewProposal(): AlignmentProposal {
  return {
    anchors: [],
    cutCandidates: [
      {
        id: "ux-r3-cut",
        name: "边界疑点",
        sourceAtMs: 20_000,
        targetGapMs: 5_000,
        confidence: 0.72,
        note: "这一段存在边界疑点，需要人工复核。"
      }
    ],
    confidence: 0.72,
    diagnostics: [],
    evidence: {
      algorithm: "alignment-v2-edit-map",
      completeFingerprintCount: 8,
      sourceFingerprintCount: 8,
      fingerprintMatchCount: 6,
      monotonicMatchCount: 6,
      strongAnchorCount: 4,
      weakAnchorCount: 2,
      offsetClusterCount: 1,
      refinedCandidateCount: 1,
      lowConfidenceRegionCount: 1,
      quality: "low"
    },
    matchRange: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 65_000,
      coverage: 1
    },
    timeMap: {
      sourceStartMs: 0,
      sourceEndMs: 60_000,
      targetStartMs: 0,
      targetEndMs: 65_000,
      spans: [
        createTestCompleteTimeMapSpan(
          {
            kind: "matched",
            sourceStartMs: 0,
            sourceEndMs: 20_000,
            targetStartMs: 0,
            targetEndMs: 20_000
          },
          "ux-r3-span-1"
        ),
        createTestCompleteTimeMapSpan(
          {
            kind: "ambiguous",
            sourceStartMs: 20_000,
            sourceEndMs: 25_000,
            targetStartMs: 20_000,
            targetEndMs: 30_000
          },
          "ux-r3-span-2"
        ),
        createTestCompleteTimeMapSpan(
          {
            kind: "matched",
            sourceStartMs: 25_000,
            sourceEndMs: 60_000,
            targetStartMs: 30_000,
            targetEndMs: 65_000
          },
          "ux-r3-span-3"
        )
      ],
      quality: {
        level: "review",
        probability: 0.72,
        metricSource: "measured",
        coverage: 0.92,
        uniqueContentCoverage: 0.8,
        p50ResidualMs: 80,
        p95ResidualMs: 220,
        p99ResidualMs: 300,
        maxResidualMs: 360,
        boundaryUncertaintyMs: 240,
        alternativeMargin: 0.18,
        anchorCount: 12,
        anchorRegionCount: 2,
        heldOutAnchorCount: 3,
        reasons: ["边界需要人工复核。"]
      },
      evidence: {
        types: ["audio"],
        audioAnchorCount: 12,
        visualAnchorCount: 0,
        heldOutAnchorCount: 3,
        top1Top2Margin: 0.18,
        uniqueContentCoverage: 0.8,
        repeatedContentOnly: false,
        selectedTrackReason: "测试音轨。",
        alternativeTrackScores: [],
        notes: ["UX-R3 工作台视觉证据"]
      },
      sourceStream: null,
      targetStream: null,
      sourceIdentity: null,
      targetIdentity: null,
      engineVersion: "alignment-v2-test",
      featureVersion: "ux-r3-review",
      parametersHash: "ux-r3-parameters"
    }
  };
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 10) / 10;
}
