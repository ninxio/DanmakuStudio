import { selectWorkspaceMenu } from "./workspace-ui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const runArtifactDir = resolve(
  process.cwd(),
  "test-results",
  "acceptance-artifacts",
  String(process.pid)
);
const screenshotDir = resolve(runArtifactDir, "screenshots");
const downloadDir = resolve(runArtifactDir, "downloads");

interface SavedProjectFile {
  schemaVersion?: number;
  clips?: Array<{ assetId?: string; sourceOutMs?: number; [key: string]: unknown }>;
  disabledItemIds?: string[];
  itemTimeAdjustments?: Record<string, number>;
  [key: string]: unknown;
}

test.beforeAll(() => {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-10T01:02:03.000Z"));
  await page.addInitScript(() => {
    let seed = 13_579;
    Math.random = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
  });
});

test("核心编辑流程可导入、编辑、导出并重新导入 XML", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");

  await expect(page.getByTestId("status-bar")).toContainText("准备就绪");
  await page.screenshot({ path: screenshotPath("empty-project.png"), fullPage: true });

  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "新手引导", exact: true }).click();
  const workflowOverview = page.getByTestId("workflow-overview-dialog");
  await expect(workflowOverview).toContainText("开始 / 下一步");
  await expect(workflowOverview).toContainText("建议下一步");
  await expect(workflowOverview).toContainText("导入要编辑的弹幕 XML");
  await expect(workflowOverview).toContainText("常用操作");
  await page.screenshot({ path: screenshotPath("workflow-overview.png"), fullPage: true });
  await page.getByLabel("关闭新手引导").click();

  await page.getByLabel("设置").click();
  await page.getByRole("button", { name: "播放器与工具" }).click();
  await expect(page.getByRole("radio", { name: /自动推荐/ })).toBeChecked();
  await page.getByRole("radio", { name: /强制 GPU/ }).check();
  await expect(page.getByText(/不会回退 CPU/)).toBeVisible();
  await page.getByRole("button", { name: "隐私与本地数据" }).click();
  await expect(page.getByRole("dialog")).toContainText("隐私与本地数据");
  await page.screenshot({ path: screenshotPath("settings-privacy.png"), fullPage: true });
  const settingsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出设置" }).click();
  const settingsDownload = await settingsDownloadPromise;
  const settingsBackupPath = resolve(downloadDir, settingsDownload.suggestedFilename());
  await settingsDownload.saveAs(settingsBackupPath);
  const settingsBackupText = readFileSync(settingsBackupPath, "utf8");
  expect(settingsBackupText).toContain("alignment");
  expect(settingsBackupText).toContain('"spectralBackend":"cuda"');
  expect(settingsBackupText).not.toContain("password");
  expect(settingsBackupText).not.toContain("token");
  const settingsImportPath = resolve(downloadDir, "imported-settings.json");
  writeFileSync(
    settingsImportPath,
    JSON.stringify({
      emby: {
        serverUrl: "https://backup.example.test",
        pathPrefix: "emby",
        username: "tester",
        password: "secret-pass"
      },
      alignment: {
        ffmpegPath: "ffmpeg",
        spectralBackend: "cpu",
        windowMs: 600,
        minGapMs: 1500,
        matchThreshold: 0.3,
        token: "secret-token"
      }
    }),
    "utf8"
  );
  await page.getByTestId("settings-import-input").setInputFiles(settingsImportPath);
  await expect(page.getByTestId("status-bar")).toContainText("设置备份已载入草稿");
  await page.getByRole("button", { name: "播放器与工具" }).click();
  await expect(page.getByRole("radio", { name: /强制 CPU/ })).toBeChecked();
  await page.getByRole("button", { name: "保存设置并关闭" }).click();

  await page
    .getByTestId("xml-input")
    .setInputFiles(resolve("fixtures", "bilibili", "normal.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("已预览导入 1 个 XML");
  await expect(page.getByTestId("asset-card")).toContainText("normal.xml");
  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "新手引导", exact: true }).click();
  await expect(page.getByTestId("workflow-overview-dialog")).toContainText(
    "1 个 XML · 0 个时间线片段 · 无需视频匹配"
  );
  await expect(page.getByTestId("workflow-overview-dialog")).toContainText("按顺序放入时间轴");
  await page.getByLabel("关闭新手引导").click();
  await page.screenshot({ path: screenshotPath("imported-project.png"), fullPage: true });

  await page.getByTestId("workspace-nav-editing").click();
  await page.getByRole("button", { name: "偏移与校准", exact: true }).click();
  await page
    .getByTestId("calibration-overview")
    .getByRole("button", { name: /开始编辑弹幕/ })
    .click();
  await expect(page.getByTestId("status-bar")).toContainText(
    "已加入 1 个 XML，保留原时间零点和已有编辑"
  );
  await page.getByRole("button", { name: "关闭偏移与校准" }).click();
  await page.setViewportSize({ width: 1024, height: 720 });
  await expect(page.getByTestId("timeline-panel")).toBeVisible();
  await expectTimelineToolbarLayout(page);
  await page.screenshot({ path: screenshotPath("compact-editor.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const projectDownloadPromise = page.waitForEvent("download");
  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "导出项目备份", exact: true }).click();
  const projectDownload = await projectDownloadPromise;
  const projectFilePath = resolve(downloadDir, projectDownload.suggestedFilename());
  await projectDownload.saveAs(projectFilePath);
  const savedProjectText = readFileSync(projectFilePath, "utf8");
  expect(savedProjectText).toContain("normal.xml");
  const projectWithOrphans = JSON.parse(savedProjectText) as SavedProjectFile;
  projectWithOrphans.disabledItemIds = [
    ...(projectWithOrphans.disabledItemIds ?? []),
    "missing-disabled-item"
  ];
  projectWithOrphans.itemTimeAdjustments = {
    ...(projectWithOrphans.itemTimeAdjustments ?? {}),
    "missing-adjusted-item": 1200
  };
  const projectWithOrphansPath = resolve(
    downloadDir,
    "project-with-orphaned-edits.danmaku-project.json"
  );
  writeFileSync(projectWithOrphansPath, JSON.stringify(projectWithOrphans, null, 2), "utf8");

  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已创建新项目");
  await page.getByTestId("project-input").setInputFiles(projectWithOrphansPath);
  await expect(page.getByTestId("status-bar")).toContainText("已打开项目");
  await page.getByTestId("workspace-nav-materials").click();
  await expect(page.getByTestId("asset-card")).toContainText("normal.xml");
  await closeEditingTool(page);
  await page.getByTestId("workspace-nav-export").click();
  await page.getByText("项目检查与修复", { exact: true }).click();
  const projectHealthPanel = page.getByTestId("project-health-panel");
  await expect(projectHealthPanel).toContainText("导出前检查");
  await expect(projectHealthPanel).toContainText("需复核");
  await expect(projectHealthPanel).toContainText("有失效的弹幕调整记录");
  await expect(projectHealthPanel).toContainText("失效禁用：missing-disabled-item");
  await expect(projectHealthPanel).toContainText("失效微调：missing-adjusted-item");
  await page.getByRole("button", { name: "清理失效调整" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已清理 2 条失效编辑引用");
  await expect(projectHealthPanel).toContainText("可运行");
  await expect(projectHealthPanel).not.toContainText("有失效的弹幕调整记录");
  await useUndoRedo(page, "撤销");
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await expect(projectHealthPanel).toContainText("有失效的弹幕调整记录");
  await useUndoRedo(page, "重做");
  await expect(page.getByTestId("status-bar")).toContainText("已重做");
  await expect(projectHealthPanel).not.toContainText("有失效的弹幕调整记录");
  await page.getByRole("button", { name: "查看诊断详情" }).click();
  await expect(projectHealthPanel).toContainText("视频重连");
  const healthReportDownloadPromise = page.waitForEvent("download");
  await projectHealthPanel.getByRole("button", { name: "下载检查报告" }).click();
  const healthReportDownload = await healthReportDownloadPromise;
  const healthReportPath = resolve(downloadDir, healthReportDownload.suggestedFilename());
  await healthReportDownload.saveAs(healthReportPath);
  const healthReportText = readFileSync(healthReportPath, "utf8");
  expect(healthReportText).toContain("导出前检查报告");
  expect(healthReportText).toContain("状态：可运行");
  expect(healthReportText).toContain("媒体重连：不需要");
  await page.screenshot({ path: screenshotPath("project-health.png"), fullPage: true });
  await page.getByTestId("workspace-nav-editing").click();
  await selectWorkspaceMenu(page, "更多工具", "来源段与手工规则");
  await page
    .getByTestId("manual-alignment-diagnostics")
    .getByText("手工提案、同步锚点与版本差异")
    .click();

  const blockedAudioAlignmentProposal = {
    anchors: [
      {
        id: "audio-anchor-1",
        sourceMs: 20_000,
        targetMs: 40_000,
        origin: "automatic",
        confidence: 0.9
      }
    ],
    cutCandidates: [
      {
        id: "audio-gap-1",
        name: "音频推断差异 1",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 22_000,
        sourceRangeEndMs: 18_000,
        targetGapMs: 20_000,
        confidence: 0.72,
        note: "音频对齐候选"
      }
    ],
    confidence: 0.82,
    diagnostics: ["音频特征匹配 4 / 4 帧。"]
  };
  await page
    .getByLabel("对齐提案 JSON")
    .fill(JSON.stringify(blockedAudioAlignmentProposal, null, 2));
  await page.getByRole("button", { name: "解析为只读诊断" }).click();
  await expect(page.getByText("诊断警告")).toBeVisible();
  await expect(page.getByText(/不确定区间起止顺序异常/).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "应用候选" })).toHaveCount(0);

  const audioAlignmentProposal = {
    anchors: [
      {
        id: "audio-anchor-1",
        sourceMs: 20_000,
        targetMs: 40_000,
        origin: "automatic",
        confidence: 0.9
      }
    ],
    cutCandidates: [
      {
        id: "audio-gap-1",
        name: "音频推断差异 1",
        sourceAtMs: 20_000,
        sourceRangeStartMs: 18_000,
        sourceRangeEndMs: 22_000,
        targetGapMs: 20_000,
        confidence: 0.72,
        note: "音频对齐候选"
      }
    ],
    confidence: 0.82,
    diagnostics: ["音频特征匹配 4 / 4 帧。"]
  };
  await page.getByLabel("对齐提案 JSON").fill(JSON.stringify(audioAlignmentProposal, null, 2));
  await page.getByRole("button", { name: "解析为只读诊断" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已发送到时间轴预览");
  await expect(page.getByText("诊断警告")).toHaveCount(0);
  const alignmentReportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出诊断报告" }).click();
  const alignmentReportDownload = await alignmentReportDownloadPromise;
  const alignmentReportPath = resolve(downloadDir, alignmentReportDownload.suggestedFilename());
  await alignmentReportDownload.saveAs(alignmentReportPath);
  const alignmentReportText = readFileSync(alignmentReportPath, "utf8");
  expect(alignmentReportText).toContain("对齐提案复核报告");
  expect(alignmentReportText).toContain("audio-gap-1");
  expect(alignmentReportText).toContain("不确定区间：00:00:18.000");
  expect(alignmentReportText).toContain("音频特征匹配 4 / 4 帧。");

  await page.getByPlaceholder(/每行一个对应点/).fill("00:10 -> 00:10\n00:20 -> 00:30");
  await page.getByRole("button", { name: "应用线索与差异" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已应用对齐提案");
  await page.getByRole("button", { name: "关闭来源段与手工规则" }).click();
  await page.getByRole("button", { name: "偏移与校准", exact: true }).click();
  const secondAnchorTargetInput = page.getByLabel("同步锚点 2 完整版时间 ms");
  await expect(secondAnchorTargetInput).toHaveValue("30000");
  await secondAnchorTargetInput.fill("32000");
  await expect(secondAnchorTargetInput).toHaveValue("32000");
  await useUndoRedo(page, "撤销");
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await expect(secondAnchorTargetInput).toHaveValue("30000");
  await useUndoRedo(page, "重做");
  await expect(page.getByTestId("status-bar")).toContainText("已重做");
  await expect(secondAnchorTargetInput).toHaveValue("32000");

  await page.getByRole("button", { name: "关闭偏移与校准" }).click();
  const timeline = page.getByTestId("timeline-canvas");
  await expect(timeline).toBeVisible();
  await timeline.click({ position: { x: 420, y: 18 } });
  await page.screenshot({ path: screenshotPath("timeline-editing.png"), fullPage: true });

  await page.getByRole("button", { name: "标记版本差异" }).click();
  await page.getByRole("button", { name: "片段与单条属性" }).click();
  await expect(page.getByTestId("inspector-cut")).toContainText("版本差异");
  await expect(page.getByTestId("status-bar")).toContainText("添加版本差异");
  await page.screenshot({ path: screenshotPath("cut-marker.png"), fullPage: true });

  await useUndoRedo(page, "撤销");
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await useUndoRedo(page, "重做");
  await expect(page.getByTestId("status-bar")).toContainText("已重做");

  const cutGapInput = page.getByLabel("相差多久");
  await expect(cutGapInput).toHaveValue("45000");
  await cutGapInput.fill("12000");
  await expect(cutGapInput).toHaveValue("12000");
  await useUndoRedo(page, "撤销");
  await expect(page.getByTestId("status-bar")).toContainText("已撤销");
  await expect(cutGapInput).toHaveValue("45000");
  await useUndoRedo(page, "重做");
  await expect(page.getByTestId("status-bar")).toContainText("已重做");
  await expect(cutGapInput).toHaveValue("12000");

  await closeEditingTool(page);
  await page.getByTestId("workspace-nav-export").click();
  await page.getByText("项目检查与修复", { exact: true }).click();
  await expect(page.getByTestId("xml-export-summary")).toHaveAttribute(
    "aria-label",
    "导出 XML 摘要"
  );
  await expect(page.getByTestId("project-health-panel")).toContainText("导出前检查");
  await expect(page.getByTestId("project-health-panel")).toContainText("可运行");
  await page.getByRole("button", { name: "统计与报告" }).click();
  const reportSheet = page.getByRole("dialog", { name: "弹幕统计与报告" });
  await expect(reportSheet).toContainText("验证条数");
  await expect(reportSheet).toContainText("累计调整时长");
  const exportHealthReportDownloadPromise = page.waitForEvent("download");
  await reportSheet.getByRole("button", { name: "下载检查报告" }).click();
  const exportHealthReportDownload = await exportHealthReportDownloadPromise;
  const exportHealthReportPath = resolve(
    downloadDir,
    exportHealthReportDownload.suggestedFilename()
  );
  await exportHealthReportDownload.saveAs(exportHealthReportPath);
  const exportHealthReportText = readFileSync(exportHealthReportPath, "utf8");
  expect(exportHealthReportText).toContain("导出前检查报告");
  expect(exportHealthReportText).toContain("状态：可运行");
  expect(exportHealthReportText).toContain("重复 ID：0 个");
  const compensationReportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载导出报告" }).click();
  const compensationReportDownload = await compensationReportDownloadPromise;
  const compensationReportPath = resolve(
    downloadDir,
    compensationReportDownload.suggestedFilename()
  );
  await compensationReportDownload.saveAs(compensationReportPath);
  expect(readFileSync(compensationReportPath, "utf8")).toContain("版本差异明细");
  await page.screenshot({ path: screenshotPath("export-dialog.png"), fullPage: true });

  await page.getByRole("button", { name: "关闭弹幕统计与报告" }).click();
  const exportedXmlDownloadPromise = page.waitForEvent("download");
  await page
    .getByTestId("xml-export-summary")
    .getByRole("button", { name: "导出 XML" })
    .click();
  const exportedXmlDownload = await exportedXmlDownloadPromise;
  const exportedXmlPath = resolve(downloadDir, exportedXmlDownload.suggestedFilename());
  await exportedXmlDownload.saveAs(exportedXmlPath);
  const exportedXmlText = readFileSync(exportedXmlPath, "utf8");
  expect(exportedXmlText).toContain("<i>");
  expect(exportedXmlText).toContain("<d p=");

  await page.getByLabel("项目菜单").click();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已创建新项目");
  await page.getByTestId("workspace-nav-materials").click();
  await page.getByTestId("xml-input").setInputFiles(exportedXmlPath);
  await expect(page.getByTestId("status-bar")).toContainText("已预览导入 1 个 XML");
  await expect(page.getByTestId("asset-card")).toContainText(
    exportedXmlDownload.suggestedFilename()
  );
  await page.screenshot({ path: screenshotPath("reimported-export.png"), fullPage: true });
});

test("导出前会阻断必须处理的问题", async ({ page }) => {
  await page.goto("/");
  const fixtureText = readFileSync(
    resolve("fixtures", "projects", "three-part-demo.danmaku-project.json"),
    "utf8"
  );
  const blockedProject = JSON.parse(fixtureText) as SavedProjectFile;
  if (!blockedProject.clips || blockedProject.clips.length === 0) {
    throw new Error("测试项目缺少时间轴片段。");
  }
  blockedProject.schemaVersion = 1;
  blockedProject.clips = blockedProject.clips.map((clip) => ({
    ...clip,
    sourceOutMs: typeof clip.sourceOutMs === "number" ? clip.sourceOutMs - 1 : clip.sourceOutMs
  }));
  blockedProject.clips[0] = {
    ...blockedProject.clips[0],
    assetId: "missing-asset"
  };
  const blockedProjectPath = resolve(
    downloadDir,
    "blocked-health-project.danmaku-project.json"
  );
  writeFileSync(blockedProjectPath, JSON.stringify(blockedProject, null, 2), "utf8");

  await page.getByTestId("project-input").setInputFiles(blockedProjectPath);
  await expect(page.getByTestId("status-bar")).toContainText("已打开旧版项目");
  await closeEditingTool(page);
  await page.getByTestId("workspace-nav-export").click();
  await page.getByText("项目检查与修复", { exact: true }).click();
  await expect(page.getByTestId("workspace-export")).toContainText(
    "导出前检查未通过：片段引用了缺失资源"
  );
  await expect(page.getByTestId("xml-export-summary")).toHaveCount(0);
  await expect(page.getByTestId("project-health-panel")).toContainText("已阻断");
  await expect(page.getByTestId("project-health-panel")).toContainText(
    "有时间轴片段找不到原来的 XML"
  );
  await expect(page.getByTestId("project-health-panel")).toContainText("part-1 时间轴片段");
  await expect(page.getByTestId("project-health-panel")).toContainText(
    "缺失资源 ID：missing-asset"
  );
  await page.getByRole("button", { name: "移除缺失片段" }).click();
  await expect(page.getByTestId("status-bar")).toContainText("已清理 1 个缺失资源片段");
  await expect(page.getByTestId("project-health-panel")).not.toContainText(
    "有时间轴片段找不到原来的 XML"
  );
  await expect(page.getByTestId("xml-export-summary")).toHaveAttribute(
    "aria-label",
    "导出 XML 摘要"
  );
});

test("导出前检查和导出摘要会展示负时间风险", async ({ page }) => {
  await page.goto("/");

  await page
    .getByTestId("xml-input")
    .setInputFiles(resolve("fixtures", "bilibili", "normal.xml"));
  await expect(page.getByTestId("status-bar")).toContainText("已预览导入 1 个 XML");
  await page.getByTestId("workspace-nav-editing").click();
  await page.getByRole("button", { name: "偏移与校准", exact: true }).click();
  await page
    .getByTestId("calibration-overview")
    .getByRole("button", { name: /开始编辑弹幕/ })
    .click();
  await page.getByText("常用修复", { exact: false }).click();
  // The XML keeps its 1.5-second origin; force two comments below zero.
  await page.getByLabel("全局偏移").fill("-3500");

  await closeEditingTool(page);
  await page.getByTestId("workspace-nav-export").click();
  await page.getByText("项目检查与修复", { exact: true }).click();
  const projectHealthPanel = page.getByTestId("project-health-panel");
  await expect(projectHealthPanel).toContainText("有弹幕会被挤到 0 秒");
  await expect(projectHealthPanel).toContainText("第一条滚动弹幕");
  await expect(projectHealthPanel).toContainText("顶部弹幕");
  await expect(projectHealthPanel).toContainText("-00:00:02.000");
  await expect(projectHealthPanel).toContainText("-00:00:00.250");

  await page.getByRole("button", { name: "统计与报告" }).click();
  const exportDialog = page.getByRole("dialog", { name: "弹幕统计与报告" });
  await expect(projectHealthPanel).toContainText("导出前检查");
  await expect(projectHealthPanel).toContainText("需复核");
  await expect(projectHealthPanel).toContainText("有弹幕会被挤到 0 秒");
  await expect(projectHealthPanel).toContainText(
    "normal.xml / normal / 第 1 条：-00:00:02.000，第一条滚动弹幕"
  );
  await expect(projectHealthPanel).toContainText(
    "normal.xml / normal / 第 2 条：-00:00:00.250，顶部弹幕"
  );
  await expect(exportDialog).toContainText("负时间限制为 0");
  await expect(exportDialog).toContainText("2 项");
  await expect(exportDialog).toContainText("负时间限制明细");
  await expect(exportDialog).toContainText("第一条滚动弹幕");
  await expect(exportDialog).toContainText("顶部弹幕");
  await expect(exportDialog).toContainText("-00:00:02.000 -> 00:00:00.000");
  await expect(exportDialog).toContainText("-00:00:00.250 -> 00:00:00.000");

  const exportHealthReportDownloadPromise = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "下载检查报告" }).click();
  const exportHealthReportDownload = await exportHealthReportDownloadPromise;
  const exportHealthReportPath = resolve(
    downloadDir,
    exportHealthReportDownload.suggestedFilename()
  );
  await exportHealthReportDownload.saveAs(exportHealthReportPath);
  const exportHealthReportText = readFileSync(exportHealthReportPath, "utf8");
  expect(exportHealthReportText).toContain("导出前检查报告");
  expect(exportHealthReportText).toContain("状态：需复核");
  expect(exportHealthReportText).toContain("负最终时间：2 条");
  expect(exportHealthReportText).toContain("[需复核] 存在负最终时间");
  expect(exportHealthReportText).toContain("第一条滚动弹幕");
  expect(exportHealthReportText).toContain("顶部弹幕");

  const exportReportDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载导出报告" }).click();
  const exportReportDownload = await exportReportDownloadPromise;
  const exportReportPath = resolve(downloadDir, exportReportDownload.suggestedFilename());
  await exportReportDownload.saveAs(exportReportPath);
  const exportReportText = readFileSync(exportReportPath, "utf8");
  expect(exportReportText).toContain("负时间限制明细");
  expect(exportReportText).toContain("第一条滚动弹幕");
  expect(exportReportText).toContain("顶部弹幕");
  expect(exportReportText).toContain("原最终时间：-00:00:02.000 (-2000 ms)");
  expect(exportReportText).toContain("原最终时间：-00:00:00.250 (-250 ms)");
});

function screenshotPath(fileName: string): string {
  return resolve(screenshotDir, fileName);
}

interface ToolbarBox {
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  toolbarLeft: number;
  toolbarRight: number;
  toolbarTop: number;
  toolbarBottom: number;
}

async function expectTimelineToolbarLayout(page: Page): Promise<void> {
  const boxes: ToolbarBox[] = await page.getByTestId("timeline-toolbar").evaluate((toolbar) => {
    const toolbarRect = toolbar.getBoundingClientRect();
    return Array.from(
      toolbar.querySelectorAll<HTMLElement>("button, [data-toolbar-chip='true']")
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        label:
          element.textContent?.trim() || element.getAttribute("aria-label") || "toolbar item",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        toolbarLeft: toolbarRect.left,
        toolbarRight: toolbarRect.right,
        toolbarTop: toolbarRect.top,
        toolbarBottom: toolbarRect.bottom
      };
    });
  });
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left, `${box.label} left edge`).toBeGreaterThanOrEqual(box.toolbarLeft - 1);
    expect(box.right, `${box.label} right edge`).toBeLessThanOrEqual(box.toolbarRight + 1);
    expect(box.top, `${box.label} top edge`).toBeGreaterThanOrEqual(box.toolbarTop - 1);
    expect(box.bottom, `${box.label} bottom edge`).toBeLessThanOrEqual(box.toolbarBottom + 1);
  }
  for (let firstIndex = 0; firstIndex < boxes.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < boxes.length; secondIndex += 1) {
      const first = boxes[firstIndex];
      const second = boxes[secondIndex];
      const horizontalOverlap =
        Math.min(first.right, second.right) - Math.max(first.left, second.left);
      const verticalOverlap =
        Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      expect(
        Math.min(horizontalOverlap, verticalOverlap),
        `${first.label} overlaps ${second.label}`
      ).toBeLessThanOrEqual(1);
    }
  }
}

async function closeEditingTool(page: Page) {
  for (const name of ["偏移与校准", "片段与单条属性"]) {
    const close = page.getByRole("button", { name: `关闭${name}`, exact: true });
    if (await close.count()) await close.click();
  }
}

async function useUndoRedo(page: Page, action: "撤销" | "重做") {
  const tool = (await page.getByRole("dialog", { name: "偏移与校准" }).count())
    ? "偏移与校准"
    : (await page.getByRole("dialog", { name: "片段与单条属性" }).count())
      ? "片段与单条属性"
      : null;
  await closeEditingTool(page);
  await page.getByLabel(action, { exact: true }).click();
  if (tool) await page.getByRole("button", { name: tool, exact: true }).click();
}
