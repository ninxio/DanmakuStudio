import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { MediaFamilyWorkbench } from "./MediaFamilyWorkbench";
import { analyzeMediaFamily } from "../../domain/project/mediaFamily";
import { createFamilyArrangement } from "../../domain/project/familyArrangement";

afterEach(cleanup);
describe("family arrangement workflow", () => {
  it("previews alternative numbering without touching saved edits and allows restoring before regrouping", () => {
    const project = createEmptyProject("编号测试");
    project.assets = ["1.1", "1.2", "2.1", "2.2"].map((part, index) =>
      parseBilibiliXml("<i/>", {
        fileName: `P00${index + 1} - ${part}.xml`,
        assetId: `a${index}`
      })
    );
    project.familyArrangement = createFamilyArrangement(
      analyzeMediaFamily(project),
      "episodes"
    );
    project.familyArrangement.rows[0].sourceInMs = 1234;
    act(() => {
      useEditorStore.getState().newProject();
      useEditorStore.setState({ project });
    });
    render(<MediaFamilyWorkbench />);
    fireEvent.click(screen.getByText("查看依据、切换数字含义与预览"));
    fireEvent.change(screen.getByLabelText("数字含义"), { target: { value: "seasonEpisode" } });
    expect(
      screen.getByRole("button", { name: "应用识别建议（4 个输出）" })
    ).toBeInTheDocument();
    expect(useEditorStore.getState().project.familyArrangement?.rows[0].sourceInMs).toBe(1234);
    fireEvent.change(screen.getByLabelText("数字含义"), { target: { value: "episodePart" } });
    fireEvent.click(screen.getByRole("button", { name: "应用识别建议（2 个输出）" }));
    expect(screen.getByLabelText("片段 1 来源开始")).toHaveValue(0);
    fireEvent.click(screen.getByRole("button", { name: "恢复上次安排" }));
    expect(screen.getByLabelText("片段 1 来源开始")).toHaveValue(1.234);
  });
  it("groups movie parts, explains an unknown join, saves windows and restores on reopen", () => {
    const project = createEmptyProject("合成电影");
    project.assets = [1, 2].map((part) =>
      parseBilibiliXml('<i><d p="1,1,25,16777215,0,0,u,1">弹幕</d></i>', {
        fileName: `Example P0${part}.xml`,
        assetId: `a${part}`
      })
    );
    act(() => {
      useEditorStore.getState().newProject();
      useEditorStore.setState({ project });
    });
    const view = render(<MediaFamilyWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: /分 P 合成正片/ }));
    expect(screen.getByText(/前一片段没有准确结束时间/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("片段 1 来源结束"), { target: { value: "2" } });
    act(() => {
      useEditorStore.getState().removeAsset("a2");
    });
    expect(screen.queryByText("文件已移除")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存安排" }));
    expect(useEditorStore.getState().project.familyArrangement?.rows).toHaveLength(1);
    expect(useEditorStore.getState().project.familyArrangement?.rows[0].sourceOutMs).toBe(2000);
    view.unmount();
    render(<MediaFamilyWorkbench />);
    expect(screen.getByLabelText("片段 1 来源结束")).toHaveValue(2);
    fireEvent.click(screen.getByRole("button", { name: /保存并去导出/ }));
    expect(useEditorStore.getState().workspacePage).toBe("export");
  });
});
