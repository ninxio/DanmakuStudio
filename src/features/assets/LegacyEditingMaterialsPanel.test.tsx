import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { LegacyEditingMaterialsPanel } from "./LegacyEditingMaterialsPanel";

describe("LegacyEditingMaterialsPanel", () => {
  beforeEach(() => {
    const asset = parseBilibiliXml(
      `<?xml version="1.0" encoding="UTF-8"?><i><d p="1,1,25,16777215,0,0,u,r">测试</d></i>`,
      { fileName: "01 - 1.1.xml" }
    );
    useEditorStore.setState({
      project: {
        ...createEmptyProject(),
        assets: [asset]
      },
      history: createHistoryState(),
      selection: { kind: "none", ids: [] },
      workspacePage: "editing"
    });
  });

  it("无素材时保留导入引导并导航到素材页", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      project: createEmptyProject(),
      selection: { kind: "none", ids: [] },
      workspacePage: "editing"
    });

    render(<LegacyEditingMaterialsPanel />);

    expect(screen.getByText("还没有弹幕 XML。请先到素材页导入。")).toBeInTheDocument();
    expect(screen.getByText("尚未导入 XML")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "去素材页导入" }));
    expect(useEditorStore.getState().workspacePage).toBe("materials");
  });

  it("已有素材时保留按顺序自动排列动作", async () => {
    const user = userEvent.setup();
    const asset = useEditorStore.getState().project.assets[0];

    render(<LegacyEditingMaterialsPanel />);

    expect(
      screen.getByText("把弹幕素材放到时间轴。多分 P 文件可以直接按顺序排列。")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "按顺序放入时间轴" }));

    await waitFor(() => expect(useEditorStore.getState().project.clips).toHaveLength(1));
    expect(useEditorStore.getState().project.clips[0].assetId).toBe(asset.id);
  });

  it("从公开面板保留素材加入、选择和移出语义", async () => {
    const user = userEvent.setup();
    const asset = useEditorStore.getState().project.assets[0];

    render(<LegacyEditingMaterialsPanel />);

    await user.click(screen.getByRole("button", { name: "放入时间轴" }));
    await waitFor(() => expect(useEditorStore.getState().project.clips).toHaveLength(1));
    const clip = useEditorStore.getState().project.clips[0];

    act(() => {
      useEditorStore.setState({ selection: { kind: "none", ids: [] } });
    });
    await user.click(screen.getByRole("button", { name: "选择片段" }));
    expect(useEditorStore.getState().selection).toEqual({
      kind: "clip",
      ids: [clip.id]
    });

    await user.click(screen.getByRole("button", { name: "移出" }));
    await waitFor(() => expect(useEditorStore.getState().project.clips).toHaveLength(0));
    expect(useEditorStore.getState().project.assets).toHaveLength(1);
    expect(useEditorStore.getState().project.assets[0].id).toBe(asset.id);
  });
});
