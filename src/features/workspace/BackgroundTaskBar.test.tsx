import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applicationTaskRegistry,
  type ApplicationTaskRegistration
} from "../../application/backgroundTasks/applicationTaskRegistry";
import { BackgroundTaskBar } from "./BackgroundTaskBar";

const SOURCES = ["shell", "matching", "export"];

afterEach(() => {
  cleanup();
  SOURCES.forEach((source) => applicationTaskRegistry.clearSource(source));
});

function registration(
  id: string,
  source: ApplicationTaskRegistration["task"]["source"],
  title: string,
  statusId: ApplicationTaskRegistration["task"]["statusId"],
  progress: number | null,
  error: string | null = null,
  action?: { label: string; handler: () => void }
): ApplicationTaskRegistration {
  return {
    task: {
      id,
      source,
      title,
      phase: progress === 1 ? "已完成" : "正在处理素材",
      statusId,
      progress,
      startedAtMs: Date.now() - 65_000,
      updatedAtMs: Date.now(),
      error,
      actions: action ? [{ id: "primary", kind: "cancel", label: action.label }] : []
    },
    handlers: action ? { primary: action.handler } : undefined
  };
}

describe("BackgroundTaskBar", () => {
  it("折叠态显示最重要任务与总数，展开态完整展示五类任务、进度与耗时", () => {
    applicationTaskRegistry.replaceSource("shell", [
      registration("xml", "xmlImport", "XML 导入", "running", 0.25),
      registration("inventory", "mediaInventory", "音轨准备", "blocked", 0.5),
      registration("save", "projectSave", "自动保存", "confirmed", 1)
    ]);
    applicationTaskRegistry.replaceSource("matching", [
      registration("matching", "matching", "智能匹配", "running", 0.4)
    ]);
    applicationTaskRegistry.replaceSource("export", [
      registration("export", "export", "分集导出", "running", 0.75)
    ]);

    render(<BackgroundTaskBar />);
    expect(screen.getByTestId("background-task-primary")).toHaveTextContent("音轨准备");
    expect(screen.getByText("共 5 项")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看全部后台任务" }));
    const center = screen.getByRole("region", { name: "全部后台任务" });
    for (const title of ["XML 导入", "音轨准备", "自动保存", "智能匹配", "分集导出"]) {
      expect(center).toHaveTextContent(title);
    }
    expect(center).toHaveTextContent("25%");
    expect(center).toHaveTextContent("耗时 1分05秒");
  });

  it("完整显示长错误，并从 registry 执行真实 cancel/retry/定位动作", () => {
    const cancel = vi.fn();
    const retry = vi.fn();
    const locate = vi.fn();
    const error =
      "导出任务失败：目标目录无法写入，请检查目录权限或选择其他交付目录后重试；原始任务状态已保留，不能截断。";
    const failed = registration("export", "export", "分集导出", "blocked", null, error);
    failed.task.actions = [
      { id: "cancel", kind: "cancel", label: "取消" },
      { id: "retry", kind: "retry", label: "重试" },
      { id: "locate", kind: "locate", label: "定位" }
    ];
    failed.handlers = { cancel, retry, locate };
    applicationTaskRegistry.replaceSource("export", [failed]);

    render(<BackgroundTaskBar />);
    fireEvent.click(screen.getByRole("button", { name: "查看全部后台任务" }));
    const center = screen.getByRole("region", { name: "全部后台任务" });
    expect(center).toHaveTextContent(error);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(screen.getByRole("button", { name: "定位" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(locate).toHaveBeenCalledOnce();
  });
});
