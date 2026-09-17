import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryState } from "../../domain/history/history";
import { createEmptyProject } from "../../domain/project/factory";
import type { MediaAdapter } from "../../infrastructure/media/mediaAdapter";
import {
  authenticateEmby,
  createEmbyAuthorizedStreamUrl,
  fetchEmbyItem
} from "../../infrastructure/metadata/embyClient";
import {
  DEFAULT_APP_SETTINGS,
  saveAppSettings
} from "../../infrastructure/settings/appSettings";
import { loadVolatileEmbyPassword } from "../../infrastructure/settings/volatileEmbyCredentials";
import { useEditorStore } from "../../stores/editorStore";
import { PreviewPanel } from "./PreviewPanel";

vi.mock("../../infrastructure/metadata/embyClient", () => ({
  authenticateEmby: vi.fn(),
  createEmbyAuthorizedStreamUrl: vi.fn(),
  fetchEmbyItem: vi.fn()
}));

vi.mock("../../infrastructure/settings/volatileEmbyCredentials", () => ({
  loadVolatileEmbyPassword: vi.fn()
}));

describe("预览面板", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(loadVolatileEmbyPassword).mockReturnValue("secret-pass");
    vi.mocked(authenticateEmby).mockResolvedValue({
      userId: "user-1",
      accessToken: "secret-token",
      userName: "tester"
    });
    vi.mocked(fetchEmbyItem).mockResolvedValue({
      id: "episode-1",
      name: "Episode 1",
      type: "Episode",
      seriesName: "Demo",
      seasonNumber: 1,
      episodeNumber: 1,
      durationMs: 3_000_000,
      mediaSources: [
        {
          id: "source-1",
          name: "1080p",
          container: "mkv",
          videoCodec: "h264",
          audioCodec: "aac",
          width: 1920,
          height: 1080,
          bitrate: 8_000_000,
          sizeBytes: 1_000_000_000,
          runtimeMs: 3_000_000
        }
      ]
    });
    vi.mocked(createEmbyAuthorizedStreamUrl).mockReturnValue(
      "https://emby.example.test/Videos/episode-1/stream?api_key=secret-token&MediaSourceId=source-1"
    );
    useEditorStore.setState({
      project: createEmptyProject(),
      selection: { kind: "none", ids: [] },
      history: createHistoryState(),
      isPlaying: false,
      status: { message: "准备就绪", tone: "neutral" },
      importProgress: null,
      exportDraft: null,
      alignmentProposal: null,
      timelineTool: "select"
    });
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("无视频时显示占位提示", () => {
    render(<PreviewPanel />);
    expect(screen.getByText("尚未导入参考视频")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    const session = screen.getByLabelText("播放器会话状态");
    expect(within(session).getByText("播放源")).toBeInTheDocument();
    expect(within(session).getByText("尚未连接")).toBeInTheDocument();
    expect(within(session).getByText("导入参考视频或绑定目标原片。")).toBeInTheDocument();
    const reliability = screen.getByLabelText("播放可靠性状态");
    expect(within(reliability).getByText("同步目标 240ms 内")).toBeInTheDocument();
    expect(within(reliability).getByText("等待媒体后可缓存")).toBeInTheDocument();
  });

  it("本地目标原片缺少当前会话视频时提示重新连接", () => {
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        mediaBinding: {
          id: "binding-local",
          kind: "localFile",
          displayName: "本地完整版",
          fileName: "full.mp4",
          mediaId: "media-local",
          localPath: null,
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z"
        }
      }
    }));

    render(<PreviewPanel />);

    expect(screen.getByText("需要重新连接视频")).toBeInTheDocument();
    expect(
      screen.getByText(
        "项目保存了目标原片引用，但没有保存视频内容。请重新导入同一份参考视频，或在目标原片中选择本地路径。"
      )
    ).toBeInTheDocument();
  });

  it("Emby 目标原片会进入播放器会话状态", () => {
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        mediaBinding: {
          id: "binding-emby",
          kind: "embyItem",
          displayName: "Demo / S01E01",
          itemId: "episode-1",
          itemName: "Episode 1",
          itemType: "Episode",
          seriesName: "Demo",
          seasonNumber: 1,
          episodeNumber: 1,
          runtimeMs: 3_000_000,
          linkedAt: "2026-07-10T00:00:00.000Z",
          server: {
            serverUrl: "https://emby.example.test",
            pathPrefix: "/emby",
            username: "tester"
          },
          mediaSources: [
            {
              id: "source-1",
              name: "1080p",
              container: "mkv",
              videoCodec: "h264",
              audioCodec: "aac",
              width: 1920,
              height: 1080,
              bitrate: 8_000_000,
              sizeBytes: 1_000_000_000,
              runtimeMs: 3_000_000
            }
          ]
        }
      }
    }));

    render(<PreviewPanel />);

    const session = screen.getByLabelText("播放器会话状态");
    expect(within(session).getByText("Emby 目标原片")).toBeInTheDocument();
    expect(within(session).getByText("Emby 元数据：aac")).toBeInTheDocument();
    expect(within(session).getByText(/音频对齐可使用 Emby 授权输入/)).toBeInTheDocument();
  });

  it("显示双源对比的参考时间和目标时间补偿", () => {
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        media: {
          id: "media-local",
          name: "cut",
          fileName: "cut.mp4",
          objectUrl: "blob:cut",
          durationMs: 120_000
        },
        mediaBinding: {
          id: "binding-local",
          kind: "localFile",
          displayName: "完整版",
          fileName: "full.mkv",
          mediaId: null,
          localPath: "D:\\media\\full.mkv",
          runtimeMs: 180_000,
          linkedAt: "2026-07-10T00:00:00.000Z"
        },
        cutMarkers: [
          {
            id: "cut-1",
            name: "片头缺失",
            sourceAtMs: 2_000,
            targetGapMs: 45_000,
            note: "目标完整版在此处额外存在内容"
          }
        ],
        timeline: {
          ...state.project.timeline,
          playheadMs: 2_500
        }
      }
    }));

    render(<PreviewPanel />);

    const comparison = screen.getByLabelText("双源对比状态");
    expect(within(comparison).getByText("双源对比可复核")).toBeInTheDocument();
    expect(within(comparison).getByText("B 站参考视频")).toBeInTheDocument();
    expect(within(comparison).getByText("本地目标原片")).toBeInTheDocument();
    expect(within(comparison).getByText("00:00:02.500")).toBeInTheDocument();
    expect(within(comparison).getByText("00:00:47.500")).toBeInTheDocument();
    expect(within(comparison).getByText("+00:00:45.000")).toBeInTheDocument();
  });

  it("历史 HTML 偏好遇到本地 MKV 时自动使用应用内 libmpv", async () => {
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      player: {
        mpvPath: "C:\\tools\\mpv.exe",
        preferredBackend: "htmlVideo"
      }
    });
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        mediaBinding: {
          id: "binding-local-mkv",
          kind: "localFile",
          displayName: "本地完整版",
          fileName: "full.mkv",
          mediaId: null,
          localPath: "D:\\media\\full.mkv",
          runtimeMs: 180_000,
          linkedAt: "2026-07-23T00:00:00.000Z"
        }
      }
    }));
    const load = vi.fn<MediaAdapter["load"]>(() => Promise.resolve());
    const adapterFactory = vi.fn(() => createFakeMediaAdapter(load));

    render(<PreviewPanel adapterFactory={adapterFactory} />);

    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(
        {
          kind: "file",
          name: "full.mkv",
          url: "D:\\media\\full.mkv"
        },
        0
      )
    );
    expect(adapterFactory).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "nativeMpv" })
    );
    expect(screen.getByText("应用内 libmpv 播放器")).toBeInTheDocument();
    act(() => useEditorStore.getState().setPlaying(true));
    act(() => {
      saveAppSettings({
        ...DEFAULT_APP_SETTINGS,
        player: { preferredBackend: "nativeMpv", mpvPath: "C:\\new-runtime" }
      });
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(useEditorStore.getState().isPlaying).toBe(false);
    expect(adapterFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({ mpvPath: "C:\\new-runtime" })
    );
  });

  it.each(["", "C:\\tools\\mpv.exe"])(
    "可以用 Emby 授权流启动 mpv 预览且界面不显示 token（路径：%s）",
    async (mpvPath) => {
      const user = userEvent.setup();
      saveAppSettings({
        ...DEFAULT_APP_SETTINGS,
        player: {
          mpvPath,
          preferredBackend: "auto"
        }
      });
      useEditorStore.setState((state) => ({
        project: {
          ...state.project,
          mediaBinding: {
            id: "binding-emby",
            kind: "embyItem",
            displayName: "Demo / S01E01",
            itemId: "episode-1",
            itemName: "Episode 1",
            itemType: "Episode",
            seriesName: "Demo",
            seasonNumber: 1,
            episodeNumber: 1,
            runtimeMs: 3_000_000,
            linkedAt: "2026-07-10T00:00:00.000Z",
            server: {
              serverUrl: "https://emby.example.test",
              pathPrefix: "/emby",
              username: "tester"
            },
            mediaSources: []
          }
        }
      }));
      const load = vi.fn<MediaAdapter["load"]>(() => Promise.resolve());
      const adapterFactory = vi.fn(() => createFakeMediaAdapter(load));

      render(<PreviewPanel adapterFactory={adapterFactory} />);

      await user.click(screen.getByRole("button", { name: "使用 Emby 授权流预览" }));

      await waitFor(() =>
        expect(load).toHaveBeenCalledWith(
          {
            kind: "url",
            name: "Episode 1 / 媒体源 source-1",
            url: "https://emby.example.test/Videos/episode-1/stream?api_key=secret-token&MediaSourceId=source-1"
          },
          0
        )
      );
      expect(
        screen.getByText(/已使用 Emby 授权流：Episode 1 \/ 媒体源 source-1/)
      ).toBeInTheDocument();
      const reliability = screen.getByLabelText("播放可靠性状态");
      await waitFor(() =>
        expect(within(reliability).getByText("可靠性正常")).toBeInTheDocument()
      );
      expect(within(reliability).getByText("临时流不落盘")).toBeInTheDocument();
      expect(screen.queryByText(/secret-token/)).not.toBeInTheDocument();
    }
  );

  it("暂停时也接收迟到的时长，重复状态不保存且卸载后不污染项目", async () => {
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        media: {
          id: "paused-media",
          name: "preview",
          fileName: "preview.mp4",
          objectUrl: "blob:preview",
          durationMs: null
        },
        timeline: { ...state.project.timeline, playheadMs: 1500 }
      }
    }));
    const load = vi.fn<MediaAdapter["load"]>().mockResolvedValue(undefined);
    const adapter = createFakeMediaAdapter(load);
    let duration = 0;
    adapter.getDurationMs = () => duration;
    let notify: (() => void) | undefined;
    const unsubscribe = vi.fn();
    adapter.subscribeStatus = (listener) => {
      notify = () =>
        listener({
          loadRevision: 1,
          loadState: "ready",
          running: true,
          playbackStatus: "paused",
          durationMs: duration,
          tracks: [],
          error: null
        });
      return unsubscribe;
    };
    const { unmount } = render(<PreviewPanel adapterFactory={() => adapter} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledWith(
      { kind: "url", name: "preview", url: "blob:preview" },
      1500
    );
    expect(useEditorStore.getState().project.media?.durationMs).toBeNull();
    act(() => {
      duration = 8000;
      notify?.();
    });
    expect(useEditorStore.getState().project.media?.durationMs).toBe(8000);
    expect(useEditorStore.getState().isPlaying).toBe(false);
    const revision = useEditorStore.getState().projectContentRevision;
    act(() => notify?.());
    expect(useEditorStore.getState().projectContentRevision).toBe(revision);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    act(() => {
      duration = 9000;
      notify?.();
    });
    expect(useEditorStore.getState().project.media?.durationMs).toBe(8000);
  });

  it("可以切换弹幕显示状态", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel />);
    await user.click(screen.getByRole("button", { name: "隐藏弹幕" }));
    await waitFor(() =>
      expect(useEditorStore.getState().project.preview.danmakuVisible).toBe(false)
    );
    expect(screen.getByRole("button", { name: "显示弹幕" })).toBeInTheDocument();
  });

  it("可以调整弹幕透明度", () => {
    render(<PreviewPanel />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0.5" } });
    expect(useEditorStore.getState().project.preview.opacity).toBe(0.5);
  });

  it("可以在当前播放点标记版本差异", async () => {
    const user = userEvent.setup();
    useEditorStore.setState((state) => ({
      project: {
        ...state.project,
        timeline: {
          ...state.project.timeline,
          playheadMs: 2500
        }
      }
    }));
    render(<PreviewPanel />);

    await user.click(screen.getByRole("button", { name: "添加播放点差异" }));

    expect(useEditorStore.getState().project.cutMarkers).toHaveLength(1);
    expect(useEditorStore.getState().project.cutMarkers[0]).toMatchObject({
      sourceAtMs: 2500,
      targetGapMs: 45_000
    });
    expect(useEditorStore.getState().selection.kind).toBe("cut");
  });

  it("先打开空预览再导入视频时会加载预览并写入时长", async () => {
    render(<PreviewPanel />);
    expect(screen.getByText("尚未导入参考视频")).toBeInTheDocument();

    act(() => {
      useEditorStore.setState((state) => ({
        project: {
          ...state.project,
          media: {
            id: "media-local",
            name: "demo",
            fileName: "demo.mp4",
            objectUrl: "blob:demo-video",
            durationMs: null
          }
        }
      }));
    });

    const video = screen.getByTestId("preview-video");
    Object.defineProperty(video, "duration", { configurable: true, value: 12.345 });
    await screen.findByText("正在加载预览...");
    fireEvent.loadedMetadata(video);

    await waitFor(() =>
      expect(useEditorStore.getState().project.media?.durationMs).toBe(12_345)
    );
    expect(screen.getAllByText("demo.mp4").length).toBeGreaterThan(0);
    expect(screen.getByText("HTML Video 已就绪 / 00:00:12.345")).toBeInTheDocument();
  });

  it("视频格式不支持时说明 HTML Video 限制和 mpv 后续方向", async () => {
    render(<PreviewPanel />);
    act(() => {
      useEditorStore.setState((state) => ({
        project: {
          ...state.project,
          media: {
            id: "media-local",
            name: "demo",
            fileName: "demo.mkv",
            objectUrl: "blob:demo-video",
            durationMs: null
          }
        }
      }));
    });

    const video = screen.getByTestId("preview-video");
    await screen.findByText("正在加载预览...");
    fireEvent.error(video);

    await screen.findAllByText("格式不支持");
    expect(
      screen.getAllByText(
        "HTML Video 无法播放此视频。请改用 MP4/WebM；MKV 或复杂编码需要后续启用 mpv 播放器。"
      ).length
    ).toBeGreaterThan(0);
    const reliability = screen.getByLabelText("播放可靠性状态");
    expect(within(reliability).getByText("需要恢复")).toBeInTheDocument();
    expect(within(reliability).getByText("已阻断静默失败")).toBeInTheDocument();
  });
});

function createFakeMediaAdapter(load: MediaAdapter["load"]): MediaAdapter {
  return {
    load,
    play: vi.fn<MediaAdapter["play"]>(() => Promise.resolve()),
    pause: vi.fn<MediaAdapter["pause"]>(),
    seek: vi.fn<MediaAdapter["seek"]>(),
    getCurrentTimeMs: vi.fn<MediaAdapter["getCurrentTimeMs"]>(() => 0),
    getDurationMs: vi.fn<MediaAdapter["getDurationMs"]>(() => 3_000_000),
    getTracks: vi.fn<MediaAdapter["getTracks"]>(() => []),
    setPlaybackRate: vi.fn<MediaAdapter["setPlaybackRate"]>(),
    dispose: vi.fn<MediaAdapter["dispose"]>()
  };
}
