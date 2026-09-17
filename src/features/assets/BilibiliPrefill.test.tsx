import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BilibiliImportDialog } from "./BilibiliImportDialog";
import {
  biliAcquisition,
  openBilibiliAcquisition,
  useBilibiliWorkspaceSession
} from "../../stores/bilibiliAcquisitionStore";
import { useEditorStore } from "../../stores/editorStore";
import { parseDiscoveryLink } from "../../domain/project/discovery";
import {
  downloadBilibiliPackage,
  listenBilibiliProgress,
  inspectBilibiliVideo,
  type BilibiliVideo
} from "../../infrastructure/bilibili/bilibiliClient";
import {
  applyWorkflowDefaults,
  currentWorkflowDefaults
} from "../../application/workflowPresets";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("./BilibiliAccountPanel", () => ({ BilibiliAccountPanel: () => null }));
vi.mock("../../infrastructure/settings/storageClient", () => ({
  getStorageStatus: () => Promise.resolve({ active: null })
}));
vi.mock("../../infrastructure/bilibili/bilibiliClient", () => ({
  inspectBilibiliVideo: vi.fn(),
  downloadBilibiliPackage: vi.fn(),
  cancelBilibiliDownload: vi.fn(),
  listenBilibiliProgress: vi.fn()
}));
const context = () => ({
  projectId: useEditorStore.getState().project.id,
  projectEpoch: useEditorStore.getState().projectEpoch
});
beforeEach(() => {
  vi.restoreAllMocks();
  useEditorStore.setState({
    projectLibrary: { ...useEditorStore.getState().projectLibrary, switchingProject: false }
  });
  useBilibiliWorkspaceSession.setState({
    open: false,
    input: "",
    generation: 0,
    video: null,
    selectedCids: [],
    outputFolder: "D:/cache"
  });
});
it("short links can be collected but cannot open an unsupported acquisition", () => {
  const { link } = parseDiscoveryLink("https://b23.tv/abc123");
  expect(link).toBe("https://b23.tv/abc123");
  expect(() => openBilibiliAcquisition({ ...context(), input: link })).toThrow(/完整.*BV/);
  expect(useBilibiliWorkspaceSession.getState()).toMatchObject({ open: false, input: "" });
});
it("pending import retains its original form without opening a second dialog", () => {
  const original = biliAcquisition.getSnapshot();
  vi.spyOn(biliAcquisition, "getSnapshot").mockReturnValue({
    ...original,
    phase: "pendingImport"
  });
  useBilibiliWorkspaceSession.setState({ input: "original", selectedCids: [1] });
  expect(() => openBilibiliAcquisition({ ...context(), input: "new" })).toThrow(/待导入/);
  expect(useBilibiliWorkspaceSession.getState()).toMatchObject({
    input: "original",
    selectedCids: [1],
    open: false,
    generation: 0
  });
});
it("late inspection cannot overwrite a new prefill generation", async () => {
  let complete: (v: BilibiliVideo) => void = () => {};
  vi.mocked(inspectBilibiliVideo).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  openBilibiliAcquisition({ ...context(), input: "https://www.bilibili.com/video/A" });
  render(<BilibiliImportDialog />);
  fireEvent.click(screen.getByRole("button", { name: "解析视频" }));
  await waitFor(() => expect(inspectBilibiliVideo).toHaveBeenCalled());
  act(() =>
    openBilibiliAcquisition({ ...context(), input: "https://www.bilibili.com/video/B" })
  );
  await act(() =>
    Promise.resolve(
      complete({
        bvid: "A",
        aid: 1,
        title: "旧视频",
        ownerName: "",
        pageCount: 1,
        pages: [
          {
            cid: 1,
            page: 1,
            part: "旧P",
            durationMs: 1,
            durationSource: "test",
            exactDuration: false,
            audioAvailable: true,
            audioCodec: null,
            audioBandwidth: null
          }
        ],
        warnings: []
      })
    )
  );
  expect(useBilibiliWorkspaceSession.getState()).toMatchObject({
    input: "https://www.bilibili.com/video/B",
    video: null,
    selectedCids: []
  });
  expect(screen.getByRole("button", { name: "解析视频" })).toBeEnabled();
});
it("a failed original A retries with its own audio options after a new B prefill", async () => {
  vi.mocked(listenBilibiliProgress).mockResolvedValue(() => {});
  vi.mocked(downloadBilibiliPackage).mockRejectedValueOnce(new Error("interrupted"));
  await biliAcquisition.start(
    {
      input: "original-A",
      selectedCids: [1],
      outputFolder: "D:/original",
      downloadAudio: true
    },
    ""
  );
  expect(biliAcquisition.getSnapshot().phase).toBe("failed");
  await applyWorkflowDefaults({ ...currentWorkflowDefaults(), downloadAudio: false });
  openBilibiliAcquisition({ ...context(), input: "new-B" });
  expect(useBilibiliWorkspaceSession.getState()).toMatchObject({
    input: "new-B",
    downloadAudio: false
  });
  vi.mocked(downloadBilibiliPackage).mockResolvedValueOnce({
    requestId: "retry",
    status: "cancelled",
    results: [],
    error: null
  });
  render(<BilibiliImportDialog />);
  fireEvent.click(screen.getByRole("button", { name: "继续获取未完成分 P" }));
  await waitFor(() =>
    expect(downloadBilibiliPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: "original-A",
        downloadAudio: true,
        outputFolder: "D:/original",
        selectedCids: [1]
      })
    )
  );
  expect(useBilibiliWorkspaceSession.getState()).toMatchObject({
    input: "original-A",
    downloadAudio: true,
    video: null
  });
});
