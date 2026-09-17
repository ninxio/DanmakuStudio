import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { CURRENT_SCHEMA_VERSION, type EditorProject } from "../../domain/project/types";
import { exportProjectBackup, loadProjectFromBackupText } from "./projectPersistence";

describe("项目持久化", () => {
  it("保存项目时返回实际下载文件名", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:project-download");
    const revokeObjectUrl = vi.fn<(url: string) => void>();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });

    try {
      const fileName = exportProjectBackup(createEmptyProject("项目/保存:测试"));

      expect(fileName).toBe("项目_保存_测试.danmaku-project.json");
      const clickedAnchor = clickSpy.mock.contexts[0];
      if (!(clickedAnchor instanceof HTMLAnchorElement)) {
        throw new Error("项目保存未通过锚点触发。");
      }
      expect(clickedAnchor.download).toBe("项目_保存_测试.danmaku-project.json");
      const [blob] = createObjectUrl.mock.calls[0];
      if (!(blob instanceof Blob)) {
        throw new Error("项目保存对象不是 Blob。");
      }
      await expect(readBlobText(blob)).resolves.toContain(`"schemaVersion": ${CURRENT_SCHEMA_VERSION}`);
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:project-download");
    } finally {
      clickSpy.mockRestore();
      if (createDescriptor) {
        Object.defineProperty(URL, "createObjectURL", createDescriptor);
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (revokeDescriptor) {
        Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("加载旧项目文本时迁移到当前 schema", () => {
    const legacyProject: EditorProject = {
      ...createEmptyProject("旧项目"),
      schemaVersion: 1
    };

    const project = loadProjectFromBackupText(JSON.stringify(legacyProject));

    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project.name).toBe("旧项目");
  });
});

function readBlobText(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Blob 读取结果不是文本。"));
    };
    reader.onerror = () => reject(new Error("Blob 读取失败。"));
    reader.readAsText(blob);
  });
}
