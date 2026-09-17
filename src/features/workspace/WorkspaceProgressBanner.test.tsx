import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { createHistoryState } from "../../domain/history/history";
import { useEditorStore } from "../../stores/editorStore";
import { WorkspaceProgressBanner } from "./WorkspaceProgressBanner";

describe("WorkspaceProgressBanner", () => {
  beforeEach(() => {
    useEditorStore.setState({
      project: createEmptyProject(),
      history: createHistoryState(),
      workspacePage: "materials"
    });
  });

  it("空项目显示素材页引导并推荐下一步", () => {
    render(<WorkspaceProgressBanner pageId="materials" />);
    expect(screen.getByTestId("workspace-progress-banner")).toBeInTheDocument();
    expect(screen.getByText("导入要编辑的弹幕 XML")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("只提供当前缺失步骤的动作，不重复四步导航", async () => {
    const user = userEvent.setup();
    render(<WorkspaceProgressBanner pageId="export" />);
    await user.click(screen.getByRole("button", { name: /素材/ }));
    expect(useEditorStore.getState().workspacePage).toBe("materials");
  });
});
