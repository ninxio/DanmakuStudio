import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("downloaded metadata with mixed numbering becomes eight exports without selecting individual pieces", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const counts = [14, 12, 14, 12, 15, 12, 13, 14];
  let ordinal = 0;
  await page.getByTestId("xml-input").setInputFiles(
    counts.flatMap((count, episode) =>
      Array.from({ length: count }, (_, part) => {
        const pageNumber = ++ordinal;
        const title =
          episode < 6
            ? `${episode + 1}.${part + 1}`
            : `${String(episode + 1).padStart(2, "0")}_${String(part + 1).padStart(4, "0")}`;
        return {
          name: `P${String(pageNumber).padStart(3, "0")} - ${title}.xml`,
          mimeType: "text/xml",
          buffer: Buffer.from(
            `<i><dbx:meta xmlns:dbx="urn:danmakubox:xml:metadata:1" schema-version="1" source="bilibili" bvid="BV1xx411c7mD" aid="1" cid="${100 + pageNumber}" page-index="${pageNumber}" page-count="106" title="回归示例 第二季 全八集" part="${title}" duration-ms="261000" duration-source="playurl.dash.duration" duration-source-unit="second" exact-duration="true"/><d p="1,1,25,16777215,0,0,u,r">${pageNumber}</d></i>`
          )
        };
      })
    )
  );
  await page.getByRole("tab", { name: /智能分集/ }).click();
  await expect(page.getByRole("button", { name: "应用识别建议（8 个输出）" })).toBeVisible();
  await page.getByRole("button", { name: "应用识别建议（8 个输出）" }).click();
  await expect(page.getByRole("group", { name: "输出分集" }).getByRole("button")).toHaveCount(
    8
  );
  await expect(page.getByLabel("片段 1 来源结束", { exact: true })).toHaveValue("261");
  await page.getByRole("radio", { name: "深色", exact: true }).check();
  await page.screenshot({
    path: testInfo.outputPath("recognition-106-dark.png"),
    animations: "disabled"
  });
  await page.getByRole("radio", { name: "浅色", exact: true }).check();
  await page.setViewportSize({ width: 720, height: 480 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
    false
  );
  await page.screenshot({
    path: testInfo.outputPath("recognition-106-light-compact.png"),
    animations: "disabled"
  });
  await page.getByRole("button", { name: /保存并去导出/ }).click();
  const ready = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出选中分集 XML（8）" }).click();
  const download = await ready;
  const path = testInfo.outputPath("recognized-episodes.zip");
  await download.saveAs(path);
  const buffer = readFileSync(path);
  const documents: string[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const size = buffer.readUInt32LE(offset + 18);
    const start =
      offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    documents.push(buffer.subarray(start, start + size).toString("utf8"));
    offset = start + size;
  }
  const outputs = await page.evaluate(
    (documents) =>
      documents.map((xml) => {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid output XML");
        const times = Array.from(doc.querySelectorAll("d")).map((item) =>
          Number(item.getAttribute("p")!.split(",")[0])
        );
        return {
          count: times.length,
          first: times[0],
          last: times[times.length - 1],
          duration: Number(
            doc
              .getElementsByTagNameNS("urn:danmaku-studio:xml:metadata:1", "metadata")[0]
              .getAttribute("duration-ms")
          )
        };
      }),
    documents
  );
  expect(outputs).toEqual(
    counts.map((count) => ({
      count,
      first: 1,
      last: (count - 1) * 261 + 1,
      duration: count * 261000
    }))
  );
});

test("batch episode pieces become editable windows and verified per-episode XML files", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const names = ["02 - 01 1", "03 - 01 2", "12 - 02 1", "13 - 02 2"];
  await page.getByTestId("xml-input").setInputFiles(
    names.map((name) => ({
      name: `${name}.xml`,
      mimeType: "text/xml",
      buffer: Buffer.from(`<i><d p="1,1,25,16777215,0,0,u,r">${name}</d></i>`)
    }))
  );
  await page.getByRole("tab", { name: /智能分集/ }).click();
  await page.getByRole("button", { name: /按识别结果分集/ }).click();
  await expect(page.getByRole("button", { name: /第\s*1\s*集/ })).toBeVisible();
  await page.getByLabel("片段 1 来源结束", { exact: true }).fill("2");
  await page.getByRole("button", { name: /第\s*2\s*集/ }).click();
  await page.getByLabel("片段 1 来源结束", { exact: true }).fill("3");
  await page.getByRole("radio", { name: "深色", exact: true }).check();
  await page.screenshot({
    path: testInfo.outputPath("family-dark.png"),
    animations: "disabled"
  });
  await page.getByRole("radio", { name: "浅色", exact: true }).check();
  await page.screenshot({
    path: testInfo.outputPath("family-light.png"),
    animations: "disabled"
  });
  await page.getByRole("button", { name: /保存并去导出/ }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出选中分集 XML（2）" }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath("episodes.zip");
  await download.saveAs(path);
  const buffer = readFileSync(path);
  const files: string[] = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const size = buffer.readUInt32LE(offset + 18);
    const start =
      offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    files.push(buffer.subarray(start, start + size).toString("utf8"));
    offset = start + size;
  }
  const times = await page.evaluate(
    (files) =>
      files.map((xml) => {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid XML");
        return [...doc.querySelectorAll("d")].map((d) =>
          Number(d.getAttribute("p")?.split(",")[0])
        );
      }),
    files
  );
  expect(times).toEqual([
    [1, 3],
    [1, 4]
  ]);
  await page.getByTestId("workspace-nav-materials").click();
  await page.getByRole("tab", { name: /智能分集/ }).click();
  await page.setViewportSize({ width: 720, height: 480 });
  await expect(page.getByRole("button", { name: "保存安排", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
    false
  );
  await page.screenshot({ path: testInfo.outputPath("family-compact.png") });
});
