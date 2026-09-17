import * as exportFiles from "../../infrastructure/file-system/exportFiles";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as batchMerge from "../../domain/danmaku/batchMerge";
import { createEmptyProject } from "../../domain/project/factory";
import { createHistoryState } from "../../domain/history/history";
import { appendUnplacedXmlAssets } from "../../domain/timeline/xmlTimeline";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import { ExportWorkspace } from "./ExportWorkspace";

const asset = (id: string) =>
  parseBilibiliXml(`<i><d p="1.5,1,25,16777215,0,0,u,r">${id}</d></i>`, {
    assetId: id,
    fileName: `${id}.xml`
  });

describe("ExportWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const project = appendUnplacedXmlAssets({
      ...createEmptyProject(),
      assets: [asset("first")]
    });
    useEditorStore.setState({
      project,
      projectEpoch: 0,
      history: createHistoryState(),
      workspacePage: "export",
      exportDraft: null
    });
  });

  it("does not calculate compatibility rules until explicitly opened, and clears them for another project", async () => {
    const buildPlan = vi.spyOn(batchMerge, "buildBatchMergePlan");
    render(<ExportWorkspace />);
    expect(buildPlan).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "导出工具" }));
    await user.click(screen.getByRole("menuitem", { name: "单文件导出与高级检查" }));
    await waitFor(() => expect(buildPlan).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ })).toBeVisible();
    buildPlan.mockClear();
    act(() => useEditorStore.setState({ project: createEmptyProject(), projectEpoch: 1 }));
    expect(
      screen.queryByRole("button", { name: /按文件名分 P 合并导出/ })
    ).not.toBeInTheDocument();
    expect(buildPlan).not.toHaveBeenCalled();
  });

  it("关闭再打开高级导出保留未保存的分 P 与切点规则", async () => {
    const user = userEvent.setup();
    render(<ExportWorkspace />);
    const open = async () => {
      await user.click(screen.getByRole("button", { name: "导出工具" }));
      await user.click(screen.getByRole("menuitem", { name: "单文件导出与高级检查" }));
      await screen.findByRole("dialog", { name: "单文件导出与高级检查" });
    };
    await open();
    await user.click(await screen.findByRole("button", { name: /按文件名分 P 合并导出/ }));
    await user.selectOptions(screen.getByLabelText("每个分 P"), "prefix");
    await user.clear(screen.getByLabelText("N 分钟"));
    await user.type(screen.getByLabelText("N 分钟"), "12.5");
    await user.selectOptions(screen.getByLabelText("长合集切分"), "cuts");
    const cuts = screen.getByPlaceholderText(/切点用逗号或换行分隔/);
    await user.type(cuts, "00:12:30");
    await user.click(screen.getByRole("button", { name: "关闭单文件导出与高级检查" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await open();
    expect(screen.getByLabelText("每个分 P")).toHaveValue("prefix");
    expect(screen.getByLabelText("N 分钟")).toHaveValue("12.5");
    expect(screen.getByLabelText("长合集切分")).toHaveValue("cuts");
    expect(screen.getByPlaceholderText(/切点用逗号或换行分隔/)).toHaveValue("00:12:30");
  });

  it("explains omitted XML, supports intentional partial export and adds the remainder without rewriting edits", async () => {
    const previous = useEditorStore.getState().project;
    const firstClip = { ...previous.clips[0], localOffsetMs: 250 };
    useEditorStore.setState({
      project: {
        ...previous,
        assets: [...previous.assets, asset("second")],
        clips: [firstClip]
      }
    });
    render(<ExportWorkspace />);
    const panel = screen.getByTestId("xml-only-export-panel");
    expect(panel).toHaveTextContent("已加入时间线 1 / 2 个 XML");
    expect(panel).toHaveTextContent("本次导出不会包含它们");
    const user = userEvent.setup();
    const write = vi.spyOn(exportFiles, "downloadLegacyXmlFile").mockImplementation((file) =>
      Promise.resolve({
        mode: "download",
        fileName: file.fileName,
        fileCount: 1,
        archiveFileName: null,
        downloadedFileName: file.fileName
      })
    );
    await user.click(screen.getByRole("button", { name: "导出 XML" }));
    expect(write).toHaveBeenCalledOnce();
    const exported = parseBilibiliXml(write.mock.calls[0][0].content, {
      assetId: "output",
      fileName: "output.xml"
    });
    expect(exported.items.map((item) => [item.text, item.sourceTimeMs])).toEqual([
      ["first", 1750]
    ]);
    await user.click(screen.getByRole("button", { name: "加入剩余 XML 并编辑" }));
    expect(useEditorStore.getState().project.clips[0]).toEqual(firstClip);
    expect(useEditorStore.getState().project.clips).toHaveLength(2);
    expect(useEditorStore.getState().workspacePage).toBe("editing");
    expect(useEditorStore.getState().exportDraft).toBeNull();
    expect(useEditorStore.getState().history.past).toHaveLength(1);
  });
});
