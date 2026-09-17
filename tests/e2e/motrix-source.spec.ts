import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { selectWorkspaceMenu } from "./workspace-ui";

for (const duplicate of [false, true]) {
  test(`source plugin ${duplicate ? "repairs duplicate records" : "submits once"}, restores completed files and imports the original`, async ({
    page
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/");
    await page.evaluate((duplicate) => {
      const host = window as unknown as {
        isTauri: boolean;
        __MOTRIX_ADDS__: number;
        __MOTRIX_REPAIRS__: number;
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
          invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
          transformCallback: () => number;
          unregisterCallback: () => void;
          convertFileSrc: (path: string) => string;
        };
      };
      host.isTauri = true;
      host.__MOTRIX_ADDS__ = 0;
      host.__MOTRIX_REPAIRS__ = 0;
      host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      const previous = host.__TAURI_INTERNALS__?.invoke;
      let row: Record<string, unknown> | null = null;
      host.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        unregisterCallback: () => {},
        convertFileSrc: (path) => path,
        invoke: (name, args = {}) => {
          if (name === "get_motrix_workspace")
            return Promise.resolve({
              connected: true,
              message: "Motrix 已连接",
              defaultDirectory: "I:/Studio-Media",
              downloads: row ? [row] : []
            });
          if (name === "fetch_original_source_page")
            return Promise.resolve(
              `<table class="torrent-list"><tbody><tr><td></td><td><a href="/view/1">Example S01E01 WEB</a></td><td><a href="magnet:?xt=urn:btih:${"a".repeat(40)}">magnet</a></td><td>1 GB</td><td></td><td>8</td></tr></tbody></table>`
            );
          if (name === "add_motrix_download") {
            host.__MOTRIX_ADDS__++;
            row = {
              key: "k",
              projectId: args.projectId,
              title: args.title,
              uri: args.uri,
              saveDir: args.directory,
              taskId: duplicate ? null : "native-task",
              status: duplicate ? "duplicate_conflict" : "completed",
              progress: duplicate ? 0 : 1,
              message: duplicate ? "同一资源的旧失败任务仍占用下载；修复时保留文件。" : "",
              files: duplicate ? [] : ["I:/Studio-Media/Example.S01E01.mkv"]
            };
            return Promise.resolve(row);
          }
          if (name === "repair_motrix_download") {
            host.__MOTRIX_REPAIRS__++;
            row = {
              ...row,
              taskId: "native-task",
              status: "completed",
              progress: 1,
              message: "",
              files: ["I:/Studio-Media/Example.S01E01.mkv"]
            };
            return Promise.resolve(row);
          }
          if (name === "get_motrix_completed_files")
            return Promise.resolve(["I:/Studio-Media/Example.S01E01.mkv"]);
          if (name === "refresh_motrix_downloads") return Promise.resolve(row ? [row] : []);
          if (name === "plugin:event|listen" || name === "plugin:event|unlisten")
            return Promise.resolve(1);
          if (name.startsWith("probe_") || name.includes("media_inventory"))
            return Promise.reject(new Error("Fixture has no native decoder"));
          return previous ? previous(name, args) : Promise.resolve(null);
        }
      };
    }, duplicate);
    await selectWorkspaceMenu(page, "添加素材", "搜索原片与 Motrix 下载");
    const dialog = page.getByRole("dialog", { name: "搜索原片与 Motrix 下载" });
    await expect(dialog.getByText("Motrix 已连接")).toBeVisible();
    await dialog.getByLabel("搜索网站").selectOption("nyaa");
    await dialog.getByLabel("片名或 IMDb 编号").fill("Example");
    await dialog.getByRole("button", { name: "搜索原片", exact: true }).click();
    await dialog.getByRole("button", { name: "选择并获取磁力" }).click();
    await expect(dialog.getByLabel("磁力链接或 Info Hash")).toHaveValue(/magnet:/);
    await dialog.getByRole("button", { name: "发送到 Motrix" }).click();
    if (duplicate) {
      await expect(dialog.getByText("同一资源的任务冲突 · 0%")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "换目录重新下载" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("motrix-duplicate.png") });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await selectWorkspaceMenu(page, "添加素材", "搜索原片与 Motrix 下载");
      await dialog.getByRole("button", { name: "修复重复任务并重试" }).click();
    }
    await expect(dialog.getByText("已完成 · 100%")).toBeVisible();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await selectWorkspaceMenu(page, "添加素材", "搜索原片与 Motrix 下载");
    await dialog.getByRole("button", { name: "导入完成的原片" }).click();
    await expect(dialog.getByText(/已导入 1 个原片/)).toBeVisible();
    await dialog.getByRole("button", { name: "导入完成的原片" }).click();
    await expect(dialog.getByText(/没有新增原片/)).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(720);
    await page.screenshot({ path: testInfo.outputPath("motrix-source.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("tab", { name: "原片 1", exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(
      page.getByRole("region", {
        name: "原片素材需要处理：Example.S01E01.mkv",
        exact: true
      })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __MOTRIX_ADDS__: number }).__MOTRIX_ADDS__
      )
    ).toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as { __MOTRIX_REPAIRS__: number }).__MOTRIX_REPAIRS__
      )
    ).toBe(duplicate ? 1 : 0);
    expect(pageErrors).toEqual([]);
  });
}

test("source browser bridge extracts revealed hashes and does not manufacture one from an EXT id", async ({
  page
}) => {
  // Fixture-owned page and instrumented navigation; native nonce validation has its own Rust test.
  await page.route("https://ext.to/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><h1>Public domain example</h1><button data-id="123" id="show-hash-btn">View Hash</button><div id="torrent-hash-display">Loading...</div></body></html>'
    })
  );
  const script = readFileSync("src-tauri/src/source_browser_bridge.js", "utf8").replace(
    "location.href = url.href;",
    "window.__HANDOFF__ = url.href;"
  );
  await page.addInitScript({ content: script });
  await page.goto("https://ext.to/fixture/");
  await page.getByRole("button", { name: "把已显示的磁力送回 Studio" }).click();
  await expect(page.getByText(/尚未显示磁力/)).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __HANDOFF__?: string }).__HANDOFF__)
  ).toBeUndefined();
  await page.evaluate(
    () => (document.querySelector("#torrent-hash-display")!.textContent = "a".repeat(40))
  );
  await page.getByRole("button", { name: "把已显示的磁力送回 Studio" }).click();
  expect(
    await page.evaluate(() => (window as unknown as { __HANDOFF__: string }).__HANDOFF__)
  ).toContain("studio-source://handoff");
  // Direct magnet clicks share the same handoff transport and must not start a browser download.
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = `magnet:?xt=urn:btih:${"a".repeat(40)}`;
    a.textContent = "Fixture magnet";
    document.body.append(a);
    a.click();
  });
  const sent = await page.evaluate(
    () => (window as unknown as { __HANDOFF__: string }).__HANDOFF__
  );
  const url = new URL(sent);
  expect(url.protocol).toBe("studio-source:");
  expect(url.searchParams.get("magnet")).toContain("a".repeat(40));
});
