import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { downloadLegacyXmlFiles } from "../../infrastructure/file-system/exportFiles";
import { useEditorStore } from "../../stores/editorStore";
import { FamilyExportPanel } from "./FamilyExportPanel";
import { readPublicationDelivery } from "../../application/publicationDelivery";

vi.mock("../../infrastructure/file-system/exportFiles", () => ({
  downloadLegacyXmlFiles: vi.fn(() => Promise.resolve({ kind: "archive" }))
}));
describe("family export", () => {
  it("exports the ready episode while another episode needs an exact join", async () => {
    const project = createEmptyProject("分集测试");
    project.assets = [0, 1, 2].map((i) =>
      parseBilibiliXml(`<i><d p="1,1,25,16777215,0,0,u,${i}">片段${i}</d></i>`, {
        fileName: `${i}.xml`,
        assetId: `a${i}`
      })
    );
    project.familyArrangement = {
      version: 1,
      title: project.name,
      workflow: "episodeParts",
      rows: project.assets.map((asset, index) => ({
        id: `r${index}`,
        assetId: asset.id,
        episodeKey: index === 0 ? "ready" : "pending",
        episodeLabel: index === 0 ? "第1集" : "第2集",
        sourceInMs: 0,
        sourceOutMs: null,
        targetStartMs: null,
        enabled: true
      }))
    };
    act(() => useEditorStore.setState({ project }));
    render(<FamilyExportPanel />);
    const button = screen.getByRole("button", { name: "导出选中分集 XML（1）" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(downloadLegacyXmlFiles).toHaveBeenCalledTimes(1));
    const files = vi.mocked(downloadLegacyXmlFiles).mock.calls[0][0];
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("片段0");
    expect(files[0].content).not.toContain("片段1");
    await waitFor(() => expect(readPublicationDelivery()?.projectId).toBe(project.id));
    expect(readPublicationDelivery()?.files.map(f=>f.content)).toEqual(files.map(f=>f.content));
    expect(readPublicationDelivery()?.kind).toBe("family");
  });
});
