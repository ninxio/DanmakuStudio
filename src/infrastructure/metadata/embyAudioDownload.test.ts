import { describe, expect, it, vi } from "vitest";
import { downloadEmbyAudio } from "./embyAudioDownload";

describe("Emby 音频下载边界", () => {
  it("把下载请求交给桌面命令且不改写 token", async () => {
    const invoker = vi.fn().mockResolvedValue({
      localPath: "C:\\cache\\episode.flac",
      sizeBytes: 1234,
      cacheHit: false
    });
    const request = {
      requestId: "request-1",
      url: "https://emby.example/Audio/1/stream.flac",
      accessToken: "session-secret",
      cacheIdentity: "server\nitem\nsource\ntrack\nprofile",
      displayName: "Episode 1",
      profile: "losslessFlac" as const,
      strategy: "serverAudio" as const,
      audioStreamIndex: 2,
      ffmpegPath: null
    };

    await expect(downloadEmbyAudio(request, invoker)).resolves.toMatchObject({
      localPath: "C:\\cache\\episode.flac",
      cacheHit: false
    });
    expect(invoker).toHaveBeenCalledWith(request);
  });

  it("拒绝没有稳定缓存身份的请求", async () => {
    await expect(downloadEmbyAudio({
      requestId: "request-1",
      url: "https://emby.example/Audio/1/stream.flac",
      accessToken: "token",
      cacheIdentity: "",
      displayName: "Episode",
      profile: "compactAac",
      strategy: "serverAudio",
      audioStreamIndex: 2,
      ffmpegPath: null
    }, vi.fn())).rejects.toThrow("缺少稳定身份");
  });

  it("把原生命令错误翻译成用户可读错误", async () => {
    await expect(downloadEmbyAudio({
      requestId: "request-1",
      url: "https://emby.example/Audio/1/stream.flac",
      accessToken: "token",
      cacheIdentity: "stable",
      displayName: "Episode",
      profile: "compactAac",
      strategy: "serverAudio",
      audioStreamIndex: 2,
      ffmpegPath: null
    }, () => Promise.reject(new Error("HTTP 403")))).rejects.toThrow(
      "Emby 音频获取失败：HTTP 403"
    );
  });
});
