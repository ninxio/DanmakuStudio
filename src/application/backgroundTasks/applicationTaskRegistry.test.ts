import { describe, expect, it, vi } from "vitest";
import {
  createApplicationLiveTaskChannel,
  createApplicationTaskRegistry,
  type ApplicationTaskRegistration
} from "./applicationTaskRegistry";

function task(
  id: string,
  source: ApplicationTaskRegistration["task"]["source"],
  title: string,
  progress: number | null,
  action?: () => void
): ApplicationTaskRegistration {
  return {
    task: {
      id,
      source,
      title,
      phase: progress === 1 ? "已完成" : "正在处理",
      statusId: progress === 1 ? "confirmed" : "running",
      progress,
      startedAtMs: 1_000,
      updatedAtMs: 2_000,
      error: null,
      actions: action ? [{ id: "cancel", kind: "cancel", label: "取消" }] : []
    },
    handlers: action ? { cancel: action } : {}
  };
}

describe("ApplicationTaskRegistry", () => {
  it("原子聚合五类来源、只通知变化来源，并通过稳定任务 ID 执行语义动作", () => {
    const registry = createApplicationTaskRegistry();
    const cancel = vi.fn();
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.replaceSource("shell", [
      task("import", "xmlImport", "XML 导入", 0.25),
      task("inventory", "mediaInventory", "音轨准备", 0.5, cancel),
      task("save", "projectSave", "自动保存", 1)
    ]);
    registry.replaceSource("matching", [task("matching", "matching", "智能匹配", 0.4)]);
    registry.replaceSource("export", [task("export", "export", "批量导出", 0.75)]);

    expect(registry.getSnapshot().tasks.map((item) => item.title)).toEqual([
      "音轨准备",
      "批量导出",
      "智能匹配",
      "XML 导入",
      "自动保存"
    ]);
    expect(registry.getSnapshot()).toMatchObject({ totalCount: 5, primaryTaskId: "inventory" });
    expect(listener).toHaveBeenCalledTimes(3);

    registry.replaceSource("export", [task("export", "export", "批量导出", 0.75)]);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(registry.runAction("inventory", "cancel")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("由 registry 固定首次开始时间，并在视图未变时静默替换动作 handler", () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const listener = vi.fn();
    const registry = createApplicationTaskRegistry({ now: () => 8_000 });
    registry.subscribe(listener);
    const first = task("save", "projectSave", "自动保存", 0.5, firstHandler);
    first.task.startedAtMs = 0;
    first.task.updatedAtMs = 0;
    registry.replaceSource("shell", [first]);

    expect(registry.getSnapshot().tasks[0]).toMatchObject({
      startedAtMs: 8_000,
      updatedAtMs: 8_000
    });

    const replacement = task("save", "projectSave", "自动保存", 0.5, secondHandler);
    replacement.task.startedAtMs = 0;
    replacement.task.updatedAtMs = 0;
    registry.replaceSource("shell", [replacement]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.runAction("save", "cancel")).toBe(true);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("typed live channel 保留页面恢复状态、限制记忆项并在 finish 后留下终态任务", () => {
    const registry = createApplicationTaskRegistry();
    const channel = createApplicationLiveTaskChannel(
      registry,
      "matching",
      (key, value: { running: boolean; progress: number }) => [
        task(`matching:${key}`, "matching", "智能匹配", value.progress)
      ],
      { maxEntries: 2 }
    );
    const listener = vi.fn();
    channel.subscribe("project-b", listener);

    channel.publish("project-a", { running: true, progress: 0.1 });
    channel.publish("project-b", { running: true, progress: 0.4 });
    expect(channel.read("project-b")).toEqual({ running: true, progress: 0.4 });
    expect(listener).toHaveBeenLastCalledWith({ running: true, progress: 0.4 });

    channel.publish("project-c", { running: true, progress: 0.8 });
    expect(channel.read("project-a")).toBeUndefined();
    channel.finish("project-b", { running: false, progress: 1 });
    expect(channel.read("project-b")).toBeUndefined();
    expect(listener).toHaveBeenLastCalledWith({ running: false, progress: 1 });
    expect(registry.getSnapshot().tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "matching:project-b", progress: 1 })
      ])
    );
  });

  it("拒绝跨来源重复 ID 时保持旧 snapshot 与动作原子不变", () => {
    const registry = createApplicationTaskRegistry();
    const original = vi.fn();
    registry.replaceSource("shell", [task("shared", "xmlImport", "XML 导入", 0.2, original)]);

    expect(() =>
      registry.replaceSource("matching", [task("shared", "matching", "智能匹配", 0.7)])
    ).toThrow("后台任务 ID 重复：shared");
    expect(registry.getSnapshot().tasks).toHaveLength(1);
    expect(registry.getSnapshot().tasks[0].title).toBe("XML 导入");
    expect(registry.runAction("shared", "cancel")).toBe(true);
    expect(original).toHaveBeenCalledOnce();
    registry.clearSource("shell");
    expect(registry.getSnapshot().tasks).toHaveLength(0);
  });
});
