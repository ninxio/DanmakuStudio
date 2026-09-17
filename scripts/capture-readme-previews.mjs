// Actual production UI, isolated browser profile, authored synthetic comments only.
// Run `pnpm build` first. No screenshots or state from the developer's desktop are used.
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { preview } from "vite";
import { chromium } from "@playwright/test";

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const server = await preview({
  configFile: false,
  preview: { host: "127.0.0.1", port, strictPort: true },
  build: { outDir: "dist" }
});
const browser = await chromium.launch();
try {
  await mkdir("docs/images", { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark"
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByTestId("xml-input").waitFor({ state: "attached" });
  const messages = [
    "一起出发吧",
    "这段音乐真好听",
    "注意右边的小细节",
    "原来这里已经埋下伏笔了",
    "好漂亮的光影",
    "前方高能",
    "终于等到这一幕",
    "这个转场很自然",
    "再看一遍还是会笑",
    "旅程还在继续"
  ];
  const xml = `<i>${messages.map((text, i) => `<d p="${8 + i * 7.5},${i % 4 === 0 ? 5 : 1},25,${i % 3 === 0 ? 16763904 : 16777215},0,0,demo,${i + 1}">${text}</d>`).join("")}</i>`;
  await page
    .getByTestId("xml-input")
    .setInputFiles({
      name: "示例旅程.S01E01.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(xml)
    });
  await page.getByTestId("workspace-nav-matching").click();
  await page.getByRole("button", { name: "直接进入弹幕编辑" }).click();
  await page.getByTestId("xml-only-editor-shell").waitFor();
  await page.screenshot({ path: "docs/images/editor.png", animations: "disabled" });
  await page.getByTestId("workspace-nav-materials").click();
  await page.screenshot({ path: "docs/images/workspace.png", animations: "disabled" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置中心" });
  await dialog.getByRole("button", { name: "私人弹幕库", exact: true }).click();
  await page.getByLabel("LogVar 接口地址").waitFor();
  await page.screenshot({ path: "docs/images/logvar.png", animations: "disabled" });
  const rendered = await page.locator("body").innerText();
  if (errors.length) throw new Error(`Preview console errors: ${errors.join("; ")}`);
  if (/C:\\Users\\|UID\s*\d|workers\.dev/.test(rendered))
    throw new Error("Unexpected account or machine-specific content in preview");
  console.log(
    "Three production UI previews captured with synthetic data and no saved accounts."
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
