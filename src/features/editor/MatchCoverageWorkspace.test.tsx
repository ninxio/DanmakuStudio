import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaybackCoverageProject } from "../../test/playbackCoverage";
import { useEditorStore } from "../../stores/editorStore";
import { MatchCoverageWorkspace } from "./MatchCoverageWorkspace";
import { projectDanmakuToTargets } from "../../domain/timeline/sourceProjection";
import { serializeBilibiliXml, parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";

describe("coverage first workflow", () => {
  beforeEach(() =>
    useEditorStore.setState({
      project: createPlaybackCoverageProject(),
      history: { ...useEditorStore.getState().history, past: [], future: [] },
      workspaceIntentRequest: null,
      alignmentEditorCandidateId: null,
      projectLibrary: { ...useEditorStore.getState().projectLibrary, switchingProject: false }
    })
  );
  it("returns to the episode being corrected and uses compact episode labels", () => {
    useEditorStore.setState({ alignmentEditorCandidateId: "candidate-3" });
    render(<MatchCoverageWorkspace />);
    expect(screen.getByRole("heading", { name: "Show S1E2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第 1 季第 2 集/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
  it("explains parallel reference lanes with a shared ruler and a whole-episode union", () => {
    render(<MatchCoverageWorkspace />);
    expect(screen.getByText(/每行是一个参考，横向位置均为原片时间/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "整集覆盖汇总" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "原片时间刻度" }).querySelectorAll("[data-time-ms]")
        .length
    ).toBeGreaterThan(2);
    expect(screen.getByText(/多个参考重叠/)).toBeInTheDocument();
  });
  it("adopts and exports all available results in one action without review checkboxes", async () => {
    const exportGroups = vi.fn<
      NonNullable<Parameters<typeof MatchCoverageWorkspace>[0]["exportGroups"]>
    >((projection, project) => {
      expect(projection.projectedItemCount).toBe(8);
      expect(
        project.mediaMatchCandidates.every(
          (candidate: { state: string }) => candidate.state === "accepted"
        )
      ).toBe(true);
      for (const group of projection.groups) {
        const xml = serializeBilibiliXml(group.entries).xml;
        expect(
          parseBilibiliXml(xml, { assetId: "roundtrip", fileName: "result.xml", color: "#fff" })
            .items
        ).toHaveLength(4);
      }
      return Promise.resolve({
        mode: "directory" as const,
        directoryPath: "D:/exports",
        fileCount: 2,
        fileName: "result.xml",
        filePath: "D:/exports/result.xml",
        wasRenamed: false
      });
    });
    render(<MatchCoverageWorkspace exportGroups={exportGroups} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采用全部并导出" }));
    await waitFor(() => expect(exportGroups).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/已导出。匹配逻辑/)).toBeInTheDocument();
    act(() => useEditorStore.getState().undo());
    expect(projectDanmakuToTargets(useEditorStore.getState().project).projectedItemCount).toBe(
      0
    );
  });
  it("locates a reference from its coverage and preserves adopted data after export failure", async () => {
    render(
      <MatchCoverageWorkspace exportGroups={vi.fn().mockRejectedValue(new Error("磁盘不足"))} />
    );
    fireEvent.click(screen.getAllByRole("button", { name: /定位 .* 的时间区间/ })[0]);
    expect(useEditorStore.getState().workspaceIntentRequest?.intent.target).toMatchObject({
      kind: "candidate",
      candidateId: "candidate-1",
      spanIndex: 0
    });
    fireEvent.click(screen.getByRole("button", { name: "采用全部并导出" }));
    expect(await screen.findByText(/磁盘不足/)).toBeInTheDocument();
    expect(projectDanmakuToTargets(useEditorStore.getState().project).projectedItemCount).toBe(
      8
    );
    expect(screen.getByRole("button", { name: "采用全部并导出" })).toBeEnabled();
  });
  it("keeps one unusable reference local and exports the remaining mappings", async () => {
    const project = createPlaybackCoverageProject();
    project.mediaTimeMaps[0].sourceIdentity = null;
    useEditorStore.setState({ project });
    const exportGroups = vi
      .fn<NonNullable<Parameters<typeof MatchCoverageWorkspace>[0]["exportGroups"]>>()
      .mockResolvedValue(null);
    render(<MatchCoverageWorkspace exportGroups={exportGroups} />);
    fireEvent.click(screen.getByRole("button", { name: "采用全部并导出" }));
    await waitFor(() => expect(exportGroups).toHaveBeenCalledTimes(1));
    expect(exportGroups.mock.calls[0][0].projectedItemCount).toBe(6);
    expect(useEditorStore.getState().project.assets).toEqual(project.assets);
    expect(useEditorStore.getState().project.mediaMatchCandidates[0].state).not.toBe(
      "accepted"
    );
  });
  it("does not start a duplicate export after leaving and returning to coverage", async () => {
    let finish!: () => void;
    const exportGroups = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return null;
    });
    const first = render(<MatchCoverageWorkspace exportGroups={exportGroups} />);
    fireEvent.click(screen.getByRole("button", { name: "采用全部并导出" }));
    first.unmount();
    render(<MatchCoverageWorkspace exportGroups={exportGroups} />);
    expect(screen.getByRole("button", { name: "正在导出…" })).toBeDisabled();
    expect(exportGroups).toHaveBeenCalledTimes(1);
    act(() => finish());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "采用全部并导出" })).toBeEnabled()
    );
  });
});
