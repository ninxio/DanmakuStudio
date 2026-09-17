import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbyAudioCacheMediaDraft } from "../../domain/project/mediaLibrary";
import { EmbyAudioImportDialog } from "./EmbyAudioImportDialog";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  search: vi.fn(),
  playbackInfo: vi.fn(),
  createStreamUrl: vi.fn(),
  createDirectStreamUrl: vi.fn(),
  estimateSourceBytes: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  listenProgress: vi.fn(),
  probe: vi.fn()
}));

vi.mock("./assetPanelSharedLogic", () => ({
  loadEmbyConnectionState: () => ({
    config: {
      serverUrl: "https://emby.example.test",
      pathPrefix: "/emby"
    },
    username: "tester",
    password: "session-password",
    sessionKey: "test-session"
  })
}));

vi.mock("../../infrastructure/metadata/embyClient", () => ({
  authenticateEmby: mocks.authenticate,
  searchEmbyItems: mocks.search,
  fetchEmbyPlaybackInfo: mocks.playbackInfo,
  createEmbyAudioStreamUrl: mocks.createStreamUrl,
  createEmbyDirectVideoStreamUrl: mocks.createDirectStreamUrl,
  estimateEmbySourceBytes: mocks.estimateSourceBytes
}));

vi.mock("../../infrastructure/metadata/embyAudioDownload", () => ({
  cancelEmbyAudioDownload: mocks.cancel,
  downloadEmbyAudio: mocks.download,
  listenToEmbyAudioDownloadProgress: mocks.listenProgress
}));

vi.mock("../../infrastructure/media/tauriMediaProbe", () => ({
  probeTauriMediaTimeline: mocks.probe
}));

describe("Emby 原片音频导入", () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue({
      userId: "user-1",
      userName: "tester",
      accessToken: "access-token"
    });
    mocks.search.mockReset().mockResolvedValue([
      {
        id: "movie-1",
        name: "Midsommar",
        type: "Movie",
        seriesName: null,
        seasonNumber: null,
        episodeNumber: null,
        durationMs: 8_880_000,
        mediaSources: []
      }
    ]);
    mocks.playbackInfo.mockReset().mockResolvedValue({
      playSessionId: "play-session-1",
      mediaSources: [
        {
          id: "source-1",
          name: "4K / 22 Mbps, HEVC - DV",
          container: "mkv",
          runtimeMs: 8_880_000,
          sizeBytes: 24_420_000_000,
          bitrate: 22_000_000,
          supportsDirectPlay: true,
          supportsDirectStream: true,
          supportsTranscoding: false,
          defaultAudioStreamIndex: 2,
          audioStreams: [
            {
              index: 2,
              codec: "dts",
              language: "eng",
              title: null,
              displayTitle: "English DTS 5.1",
              channels: 6,
              sampleRate: 48_000,
              bitrate: null,
              default: true,
              commentary: false
            }
          ]
        }
      ]
    });
    mocks.createStreamUrl.mockReset().mockReturnValue(
      "https://emby.example.test/emby/Audio/movie-1/stream.flac"
    );
    mocks.createDirectStreamUrl.mockReset().mockReturnValue(
      "https://emby.example.test/emby/Videos/movie-1/stream?Static=true"
    );
    mocks.estimateSourceBytes.mockReset().mockReturnValue(24_420_000_000);
    mocks.listenProgress.mockReset().mockResolvedValue(() => undefined);
    mocks.cancel.mockReset().mockResolvedValue(true);
    mocks.download.mockReset().mockResolvedValue({
      localPath: "C:\\cache\\Midsommar.mka",
      sizeBytes: 12_345,
      cacheHit: false
    });
    mocks.probe.mockReset().mockResolvedValue({
      presentationOriginMs: 0,
      durationMs: 8_880_000,
      contentIdentity: null,
      videoStreams: [],
      audioStreams: [
        {
          index: 0,
          codec: "flac",
          startMs: 0,
          timelineOffsetMs: 0,
          durationMs: 8_880_000,
          timeBase: "1/48000",
          language: "eng",
          title: null,
          default: true,
          commentary: false,
          sampleRate: 48_000,
          channels: 6
        }
      ],
      preferredAudioStreamIndex: 0
    });
  });

  it("服务器禁止转码时要求确认网络用量并在本机提取", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn<(draft: EmbyAudioCacheMediaDraft) => void>();
    render(<EmbyAudioImportDialog onClose={vi.fn()} onImport={onImport} />);

    await screen.findByText(/已连接 tester/);
    await user.type(screen.getByLabelText("搜索 Emby 电影或剧集"), "Midsommar");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await user.click(await screen.findByRole("button", { name: /Midsommar/ }));

    const importButton = await screen.findByRole("button", { name: "获取并导入原片音频" });
    expect(importButton).toBeDisabled();
    expect(screen.getByText(/需本机提取/)).toBeInTheDocument();
    expect(screen.getAllByText(/22.7 GiB/)).toHaveLength(2);
    expect(screen.getByText(/服务器不允许音频转码/)).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox"));
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const imported = onImport.mock.calls[0][0];
    expect(mocks.createDirectStreamUrl).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({
      strategy: "directVideoLocalExtract",
      profile: "originalCopy",
      audioStreamIndex: 2
    }));
    expect(imported.localPath).toBe("C:\\cache\\Midsommar.mka");
    expect(imported.profileLabel).toBe("原始音轨封装");
    expect(imported.audioTrackLabel).toContain("DTS");
  });

  it("取消后立即显示停止状态且不等待原生命令返回", async () => {
    const user = userEvent.setup();
    mocks.download.mockReset().mockReturnValue(new Promise(() => undefined));
    mocks.cancel.mockReset().mockReturnValue(new Promise(() => undefined));
    render(<EmbyAudioImportDialog onClose={vi.fn()} onImport={vi.fn()} />);

    await screen.findByText(/已连接 tester/);
    await user.type(screen.getByLabelText("搜索 Emby 电影或剧集"), "Midsommar");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await user.click(await screen.findByRole("button", { name: /Midsommar/ }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "获取并导入原片音频" }));

    const cancelButton = await screen.findByRole("button", { name: "取消并清理" });
    await user.click(cancelButton);

    expect(await screen.findByText("正在停止并清理临时文件…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在取消并清理…" })).toBeDisabled();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });
});
