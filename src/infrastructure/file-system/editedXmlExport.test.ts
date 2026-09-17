import { beforeEach, expect, it, vi } from "vitest";
import {
  downloadLegacyXmlFile,
  downloadLegacyXmlFiles,
  saveTextReportFile
} from "./exportFiles";
import { DEFAULT_APP_SETTINGS, saveAppSettings } from "../settings/appSettings";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));
beforeEach(() => {
  window.localStorage.clear();
  native.invoke.mockReset();
  native.invoke.mockImplementation(
    (command: string, args?: { request: { directoryPath: string; fileName: string } }) =>
      Promise.resolve(
        command === "get_storage_status"
          ? {
              active: { exports: "D:/effective/exports" },
              requested: { exports: "E:/pending/exports" }
            }
          : {
              fileName: args?.request.fileName,
              filePath: `${args?.request.directoryPath}/${args?.request.fileName}`,
              directoryPath: args?.request.directoryPath,
              wasRenamed: false
            }
      )
  );
});
it("普通XML实际走原生有效目录并保留所选覆盖", async () => {
  const xml = '<i><d p="1,1,25,16777215,0,0,u,1">测试</d></i>';
  const result = await downloadLegacyXmlFile({ fileName: "one.xml", content: xml });
  expect(result).toMatchObject({ mode: "directory", directoryPath: "D:/effective/exports" });
  const writeArgs: unknown = native.invoke.mock.calls.find(
    ([command]) => command === "save_edited_xml_export"
  )?.[1];
  expect(writeArgs).toMatchObject({
    request: { directoryPath: "D:/effective/exports", fileName: "one.xml" }
  });
  saveAppSettings({ ...DEFAULT_APP_SETTINGS, export: { defaultDirectory: "F:/settings" } });
  expect(await downloadLegacyXmlFile({ fileName: "one.xml", content: xml })).toMatchObject({
    directoryPath: "F:/settings"
  });
  expect(
    await downloadLegacyXmlFile(
      { fileName: "one.xml", content: xml },
      { directoryPath: "G:/selected" }
    )
  ).toMatchObject({ directoryPath: "G:/selected" });
});
it("批量ZIP和报告使用同一有效根，原生失败不伪装下载成功", async () => {
  const files = [1, 2].map((i) => ({
    fileName: `${i}.xml`,
    content: `<i><d p="1,1,25,16777215,0,0,u,${i}">测试</d></i>`
  }));
  expect(await downloadLegacyXmlFiles(files, { archiveFileName: "batch.zip" })).toMatchObject({
    mode: "directory",
    fileCount: 2,
    directoryPath: "D:/effective/exports",
    fileName: "batch.zip"
  });
  expect(await saveTextReportFile({ fileName: "report.txt", content: "report" })).toMatchObject(
    { directoryPath: "D:/effective/exports" }
  );
  native.invoke.mockRejectedValue(new Error("磁盘已满"));
  await expect(downloadLegacyXmlFiles(files)).rejects.toThrow("磁盘已满");
});
