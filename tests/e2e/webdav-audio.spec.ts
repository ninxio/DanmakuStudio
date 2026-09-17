import { expect, test } from "@playwright/test";
import { selectWorkspaceMenu } from "./workspace-ui";

test("WebDAV directory, audio selection, persistent task and explicit original import", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.evaluate(() => {
    const host = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: () => number;
        unregisterCallback: () => void;
        convertFileSrc: (path: string) => string;
      };
    };
    const previous = host.__TAURI_INTERNALS__?.invoke;
    host.isTauri = true;
    let completed = false;
    const job = {
      id: "j",
      connectionId: "c",
      href: "/dav/Tom%20&%20Jerry.S01E02.mkv",
      name: "Tom & Jerry.S01E02.mkv",
      streamIndex: 1,
      status: "completed",
      message: "音轨已缓存，发布前请核对观看版本。",
      createdAtMs: 0,
      directory: "I:/cache/j"
    };
    host.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (path) => path,
      invoke: (name, args) => {
        if (name === "get_webdav_workspace")
          return Promise.resolve({
            connections: [
              { id: "c", name: "Fixture WebDAV", root: "https://fixture.invalid/dav/" }
            ],
            jobs: completed ? [job] : []
          });
        if (name === "list_webdav_entries")
          return Promise.resolve([
            { href: job.href, name: job.name, directory: false, size: 2048 }
          ]);
        if (name === "inspect_webdav_entry")
          return Promise.resolve({
            probeId: "p",
            name: job.name,
            sourcePresentationOriginMs: 0,
            sourceReportedDurationMs: 2500,
            streams: [
              { index: 1, codec: "aac", language: "eng", title: "English", channels: 2 }
            ]
          });
        if (name === "start_webdav_audio_job") {
          completed = true;
          return Promise.resolve(job);
        }
        if (name === "import_webdav_audio_job")
          return Promise.resolve({
            localPath: "I:/cache/j/audio.flac",
            fileName: "Tom & Jerry.S01E02.audio-1-j.flac",
            durationMs: 2000,
            name: job.name,
            audioTrackLabel: "音轨 1"
          });
        if (name.startsWith("probe_") || name.includes("media_inventory"))
          return Promise.reject(new Error("Fixture has no native decoder"));
        return previous ? previous(name, args) : Promise.resolve(null);
      }
    };
  });
  await selectWorkspaceMenu(page, "添加素材", "从 WebDAV 获取原片音轨");
  const dialog = page.getByRole("dialog", { name: "WebDAV 原片音轨" });
  await expect(dialog.getByRole("option", { name: "Fixture WebDAV" })).toBeAttached();
  await dialog.getByLabel("WebDAV 连接").selectOption("c");
  await dialog.getByRole("button", { name: "打开根目录" }).click();
  await dialog.getByRole("button", { name: /文件：Tom/ }).click();
  await expect(dialog.getByLabel("WebDAV 音轨")).toHaveValue("1");
  await dialog.getByRole("button", { name: "缓存所选音轨" }).click();
  await expect(dialog.getByRole("button", { name: "验证并导入当前项目" })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await selectWorkspaceMenu(page, "添加素材", "从 WebDAV 获取原片音轨");
  await dialog.getByRole("button", { name: "验证并导入当前项目" }).click();
  await expect(dialog.getByRole("status")).toHaveText("音轨已导入当前项目。");
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  await page.screenshot({ path: testInfo.outputPath("webdav-audio.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("tab", { name: "原片 1", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  expect(errors).toEqual([]);
});
