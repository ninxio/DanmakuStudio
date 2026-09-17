import { describe, expect, it } from "vitest";
import { createProjectDownloadFileName, createProjectFileBaseName } from "./fileNames";

describe("project file names", () => {
  it("使用修剪后的项目名生成下载文件名", () => {
    expect(createProjectFileBaseName("  对齐 项目  ")).toBe("对齐 项目");
    expect(createProjectDownloadFileName("  对齐 项目  ", "-alignment-proposal.json")).toBe(
      "对齐 项目-alignment-proposal.json"
    );
  });

  it("项目名为空时使用默认基准名", () => {
    expect(createProjectFileBaseName("   ")).toBe("danmaku-project");
    expect(createProjectDownloadFileName("   ", ".danmaku-project.json")).toBe(
      "danmaku-project.danmaku-project.json"
    );
  });
});
