import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { createProjectHealthSummary } from "../../domain/project/health";
import type { ProjectReadinessSummary } from "../../domain/project/readiness";
import { downloadTextFile } from "../../infrastructure/file-system/browserFiles";
import { useEditorStore } from "../../stores/editorStore";
import { ExportReadinessPanel } from "./ExportReadinessPanel";

vi.mock("../../infrastructure/file-system/browserFiles", () => ({
  downloadTextFile: vi.fn(() => "示例项目-health-report.txt")
}));

const reportSummary = createProjectHealthSummary(createEmptyProject());

function createReadiness(
  overrides: Partial<ProjectReadinessSummary> = {}
): ProjectReadinessSummary {
  return {
    status: "blocked",
    statusId: "blocked",
    statusLabel: "已阻断",
    headline: "还有 1 项必须处理",
    detail: "修复后再导出 XML。",
    items: [
      {
        id: "missing-media",
        severity: "error",
        title: "目标原片已断开",
        detail: "请重新连接原片。",
        evidence: ["第 01 集"]
      }
    ],
    diagnostics: [{ label: "缺失素材", value: "1" }],
    canCleanupEditReferences: true,
    canCleanupMissingAssetClips: true,
    ...overrides
  };
}

describe("ExportReadinessPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditorStore.setState({ status: { message: "准备就绪", tone: "neutral" } });
  });

  it("展示阻断、清理动作与按需诊断，并转发现有 action", async () => {
    const user = userEvent.setup();
    const onCleanupEditReferences = vi.fn();
    const onCleanupMissingAssetClips = vi.fn();

    render(
      <ExportReadinessPanel
        projectName="示例项目"
        reportSummary={reportSummary}
        readiness={createReadiness()}
        onCleanupEditReferences={onCleanupEditReferences}
        onCleanupMissingAssetClips={onCleanupMissingAssetClips}
      />
    );

    expect(screen.getByText("还有 1 项必须处理")).toBeInTheDocument();
    expect(screen.getByText("目标原片已断开")).toBeInTheDocument();
    expect(screen.queryByText("缺失素材")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清理失效调整" }));
    await user.click(screen.getByRole("button", { name: "移除缺失片段" }));
    expect(onCleanupEditReferences).toHaveBeenCalledOnce();
    expect(onCleanupMissingAssetClips).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "查看诊断详情" }));
    expect(screen.getByText("缺失素材")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起诊断详情" })).toBeInTheDocument();
  });

  it("保留无问题状态和检查报告下载反馈", async () => {
    const user = userEvent.setup();
    render(
      <ExportReadinessPanel
        projectName="示例项目"
        reportSummary={reportSummary}
        readiness={createReadiness({
          status: "ready",
          statusLabel: "可运行",
          headline: "导出条件已满足",
          detail: "可以继续。",
          items: [],
          canCleanupEditReferences: false,
          canCleanupMissingAssetClips: false
        })}
        onCleanupEditReferences={vi.fn()}
        onCleanupMissingAssetClips={vi.fn()}
      />
    );

    expect(
      screen.getByText("没有需要你现在处理的问题。可以继续编辑，或直接导出 XML。")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清理失效调整" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除缺失片段" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下载检查报告" }));
    expect(downloadTextFile).toHaveBeenCalledOnce();
    expect(useEditorStore.getState().status).toEqual({
      message: "已导出检查报告：示例项目-health-report.txt。",
      tone: "success"
    });
  });
});
