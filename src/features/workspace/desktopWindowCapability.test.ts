import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface DesktopCapabilityManifest {
  permissions?: string[];
}

interface TauriConfiguration {
  app?: {
    windows?: Array<{ decorations?: boolean }>;
  };
}

describe("桌面窗口 capability", () => {
  it("自绘标题栏关闭原生装饰并只申请所需窗口动作", () => {
    const capability = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src-tauri", "capabilities", "default.json"),
        "utf8"
      )
    ) as DesktopCapabilityManifest;
    const configuration = JSON.parse(
      readFileSync(resolve(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8")
    ) as TauriConfiguration;

    expect(configuration.app?.windows?.[0]?.decorations).toBe(false);
    expect(capability.permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-close",
        "core:window:allow-minimize",
        "core:window:allow-toggle-maximize",
        "core:window:allow-start-dragging"
      ])
    );
    expect(capability.permissions).not.toContain("core:window:allow-destroy");
  });
});
