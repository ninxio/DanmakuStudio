import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import { appendUnplacedXmlAssets } from "../../domain/timeline/xmlTimeline";
import * as embyClient from "../../infrastructure/metadata/embyClient";
import { parseBilibiliXml } from "../../infrastructure/xml/bilibiliXml";
import { useEditorStore } from "../../stores/editorStore";
import * as connectionState from "../assets/assetPanelSharedLogic";
import { ExportWorkspace } from "./ExportWorkspace";
import { useEmbyMetadataController } from "./useEmbyMetadataController";

const session: embyClient.EmbyAuthSession = {
  userId: "user",
  accessToken: "token",
  userName: "user"
};
const episode: embyClient.EmbyItemMetadata = {
  id: "episode",
  name: "Test episode",
  type: "Episode",
  seriesName: "Test series",
  seasonNumber: 1,
  episodeNumber: 1,
  durationMs: 750_000,
  mediaSources: []
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function changeProjectEpoch() {
  const state = useEditorStore.getState();
  const project = {
    ...createEmptyProject(),
    id: state.project.id,
    assets: state.project.assets
  };
  useEditorStore.setState({
    project,
    projectEpoch: state.projectEpoch + 1,
    status: { message: "新项目状态", tone: "neutral" }
  });
  return project;
}

async function openExportTools(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "导出工具" }));
  await user.click(screen.getByRole("menuitem", { name: "单文件导出与高级检查" }));
  await screen.findByRole("dialog", { name: "单文件导出与高级检查" });
}

describe("Emby export sheet lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const asset = parseBilibiliXml('<i><d p="1,1,25,16777215,0,0,u,r">hello</d></i>', {
      assetId: "xml",
      fileName: "S01E01.xml"
    });
    const project = appendUnplacedXmlAssets({ ...createEmptyProject(), assets: [asset] });
    useEditorStore.setState({
      project,
      projectEpoch: 0,
      history: createHistoryState(),
      exportDraft: null
    });
    vi.spyOn(connectionState, "loadEmbyConnectionState").mockReturnValue({
      config: { serverUrl: "https://emby.example", pathPrefix: "" },
      username: "user",
      password: "password",
      sessionKey: "connection"
    });
    vi.spyOn(embyClient, "authenticateEmby").mockResolvedValue(session);
    vi.spyOn(embyClient, "searchEmbyItems").mockResolvedValue([episode]);
    vi.spyOn(embyClient, "fetchEmbyItem").mockResolvedValue(episode);
    vi.spyOn(embyClient, "fetchEmbyEpisodeChildren").mockResolvedValue([episode]);
  });

  it("keeps search, selection and asynchronously loaded duration rules across real drawer closure", async () => {
    const pending = deferred<embyClient.EmbyItemMetadata[]>();
    vi.mocked(embyClient.fetchEmbyEpisodeChildren).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<ExportWorkspace />);
    await openExportTools(user);
    await user.click(screen.getByRole("button", { name: /按文件名分 P 合并导出/ }));
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "Test series");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await user.click(await screen.findByRole("button", { name: /Test episode/ }));
    await user.click(screen.getByRole("button", { name: "读取下级剧集" }));
    await waitFor(() => expect(embyClient.fetchEmbyEpisodeChildren).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "关闭单文件导出与高级检查" }));
    expect(screen.queryByText("Emby 时长")).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve([episode]);
      await pending.promise;
    });
    await openExportTools(user);
    expect(screen.getByRole("textbox", { name: "搜索" })).toHaveValue("Test series");
    expect(screen.getByDisplayValue("S01E01 12:30")).toBeVisible();
    expect(screen.getByRole("button", { name: "读取条目" })).toBeEnabled();
    expect(embyClient.authenticateEmby).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "导入时长规则" }));
    expect(screen.getByLabelText("长合集切分")).toHaveValue("durations");
    expect(screen.getAllByDisplayValue("S01E01 12:30")).toHaveLength(2);
  });

  it("does not continue late authentication into a reloaded project and resets the new drawer", async () => {
    const pending = deferred<embyClient.EmbyAuthSession>();
    vi.mocked(embyClient.authenticateEmby).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    render(<ExportWorkspace />);
    await openExportTools(user);
    await user.click(screen.getByRole("button", { name: /按文件名分 P 合并导出/ }));
    await user.type(screen.getByRole("textbox", { name: "搜索" }), "old search{Enter}{Enter}");
    expect(embyClient.authenticateEmby).toHaveBeenCalledOnce();
    let project = useEditorStore.getState().project;
    act(() => {
      project = changeProjectEpoch();
    });
    await act(async () => {
      pending.resolve(session);
      await pending.promise;
    });
    expect(embyClient.searchEmbyItems).not.toHaveBeenCalled();
    expect(useEditorStore.getState().project).toBe(project);
    expect(useEditorStore.getState().status.message).toBe("新项目状态");
    await openExportTools(user);
    await user.click(screen.getByRole("button", { name: /按文件名分 P 合并导出/ }));
    expect(screen.getByRole("textbox", { name: "搜索" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "绑定为目标原片" })).not.toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)(
    "ignores a late item %s and stale binding/import callbacks after an epoch change",
    async (outcome) => {
      const pending = deferred<embyClient.EmbyItemMetadata>();
      vi.mocked(embyClient.fetchEmbyItem).mockReturnValueOnce(pending.promise);
      const importLines = vi.fn();
      const { result } = renderHook(() => useEmbyMetadataController(importLines));
      act(() => result.current.selectSearchResult(episode));
      const oldController = result.current;
      let request: Promise<void>;
      act(() => {
        request = result.current.readItem();
      });
      await waitFor(() => expect(embyClient.fetchEmbyItem).toHaveBeenCalledOnce());
      const oldLoadedItem = result.current.loadedItem;
      let project = useEditorStore.getState().project;
      act(() => {
        project = changeProjectEpoch();
      });
      await act(async () => {
        if (outcome === "success") pending.resolve({ ...episode, name: "late item" });
        else pending.reject(new Error("old request failed"));
        await request;
        oldController.bindLoadedItemAsTarget();
        oldController.importLoadedItemDuration();
        oldController.importDurationLines();
      });
      expect(useEditorStore.getState().project).toBe(project);
      expect(useEditorStore.getState().status.message).toBe("新项目状态");
      expect(result.current.loadedItem).toBe(oldLoadedItem);
      expect(importLines).not.toHaveBeenCalled();
    }
  );

  it("allows retry after failure while keeping searches single flight", async () => {
    const pending = deferred<embyClient.EmbyItemMetadata[]>();
    vi.mocked(embyClient.searchEmbyItems).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useEmbyMetadataController(vi.fn()));
    act(() => result.current.setSearchTerm("Test series"));
    let request: Promise<void>;
    act(() => {
      request = result.current.searchItems();
      void result.current.searchItems();
    });
    await waitFor(() => expect(embyClient.searchEmbyItems).toHaveBeenCalledOnce());
    await act(async () => {
      pending.reject(new Error("try again"));
      await request;
    });
    expect(result.current.loading).toBeNull();
    await act(async () => {
      await result.current.searchItems();
    });
    expect(result.current.searchResults).toEqual([episode]);
    expect(embyClient.searchEmbyItems).toHaveBeenCalledTimes(2);
    expect(embyClient.authenticateEmby).toHaveBeenCalledOnce();
  });
});
