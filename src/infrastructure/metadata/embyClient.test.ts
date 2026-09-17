import { describe, expect, it } from "vitest";
import {
  authenticateEmby,
  createEmbyAudioStreamUrl,
  createEmbyAuthorizedStreamUrl,
  createEmbyDirectVideoStreamUrl,
  createTauriEmbyFetch,
  estimateEmbySourceBytes,
  fetchEmbyEpisodeChildren,
  fetchEmbyItem,
  fetchEmbyPlaybackInfo,
  formatEmbyEpisodeDurationLines,
  formatEmbySingleDurationLine,
  searchEmbyItems,
  type EmbyProxyRequest,
  type EmbyFetch
} from "./embyClient";

describe("Emby 客户端", () => {
  it("通过用户名密码登录并读取 token", async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    const fetcher: EmbyFetch = (input, init) => {
      calls.push({
        url: inputToString(input),
        body: typeof init?.body === "string" ? init.body : null
      });
      return Promise.resolve(createResponse({
        User: { Id: "user-1", Name: "tester" },
        AccessToken: "token-1"
      }));
    };

    const session = await authenticateEmby(
      { serverUrl: "https://example.test:443", pathPrefix: "/emby" },
      { username: "tester", password: "secret" },
      fetcher
    );

    expect(session).toEqual({ userId: "user-1", userName: "tester", accessToken: "token-1" });
    expect(calls[0].url).toBe("https://example.test/emby/Users/AuthenticateByName");
    expect(calls[0].body).toContain("\"Username\":\"tester\"");
  });

  it("读取条目并把 RunTimeTicks 转成毫秒", async () => {
    const fetcher: EmbyFetch = () =>
      Promise.resolve(createResponse({
        Id: "item-1",
        Name: "Episode 1",
        Type: "Episode",
        SeriesName: "Demo Series",
        ParentIndexNumber: 1,
        IndexNumber: 1,
        RunTimeTicks: 3_080_123_0000,
        MediaSources: [
          {
            Id: "source-1",
            Name: "1080p",
            Container: "mkv",
            Bitrate: 8_000_000,
            Size: 1_234_567_890,
            RunTimeTicks: 3_080_123_0000,
            MediaStreams: [
              { Type: "Video", Codec: "h264", Width: 1920, Height: 1080, BitRate: 7_000_000 },
              { Type: "Audio", Codec: "aac", BitRate: 192_000 }
            ]
          }
        ]
      }));

    const item = await fetchEmbyItem(
      { serverUrl: "https://example.test/emby", pathPrefix: "" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      "item-1",
      fetcher
    );

    expect(item.durationMs).toBe(3_080_123);
    expect(item.seriesName).toBe("Demo Series");
    expect(item.seasonNumber).toBe(1);
    expect(item.episodeNumber).toBe(1);
    expect(item.mediaSources[0]).toMatchObject({
      id: "source-1",
      name: "1080p",
      container: "mkv",
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
      bitrate: 8_000_000,
      sizeBytes: 1_234_567_890,
      runtimeMs: 3_080_123
    });
    expect(JSON.stringify(item)).not.toContain("token");
  });

  it("为本次会话生成授权播放地址但不改变条目元数据", () => {
    const url = new URL(
      createEmbyAuthorizedStreamUrl(
        { serverUrl: "https://example.test", pathPrefix: "/emby" },
        { userId: "user-1", userName: "tester", accessToken: "token-1" },
        "item 1",
        "source 1"
      )
    );

    expect(url.origin).toBe("https://example.test");
    expect(url.pathname).toBe("/emby/Videos/item%201/stream");
    expect(url.searchParams.get("Static")).toBe("true");
    expect(url.searchParams.get("api_key")).toBe("token-1");
    expect(url.searchParams.get("MediaSourceId")).toBe("source 1");
  });

  it("读取播放信息中的多音轨并识别默认与评论音轨", async () => {
    const playback = await fetchEmbyPlaybackInfo(
      { serverUrl: "https://example.test", pathPrefix: "/emby" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      "item-1",
      () => Promise.resolve(createResponse({
        PlaySessionId: "play-1",
        MediaSources: [{
          Id: "source-1",
          Name: "Original",
          Container: "mkv",
          Size: 1_500_000_000,
          Bitrate: 4_000_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: true,
          DefaultAudioStreamIndex: 2,
          RunTimeTicks: 3_000_000_0000,
          MediaStreams: [
            { Index: 0, Type: "Video", Codec: "h264" },
            {
              Index: 2,
              Type: "Audio",
              Codec: "aac",
              Language: "deu",
              DisplayTitle: "German",
              Channels: 2,
              SampleRate: 48_000,
              IsDefault: true
            },
            {
              Index: 3,
              Type: "Audio",
              Codec: "aac",
              Title: "Director Commentary",
              IsCommentary: true
            }
          ]
        }]
      }))
    );

    expect(playback.playSessionId).toBe("play-1");
    expect(playback.mediaSources[0].defaultAudioStreamIndex).toBe(2);
    expect(playback.mediaSources[0]).toMatchObject({
      sizeBytes: 1_500_000_000,
      bitrate: 4_000_000,
      supportsDirectPlay: true,
      supportsDirectStream: true,
      supportsTranscoding: true
    });
    expect(estimateEmbySourceBytes(playback.mediaSources[0])).toBe(1_500_000_000);
    expect(playback.mediaSources[0].audioStreams).toEqual([
      expect.objectContaining({ index: 2, language: "deu", default: true, commentary: false }),
      expect.objectContaining({ index: 3, commentary: true })
    ]);
  });

  it("生成不含 token 的指定音轨转码地址", () => {
    const url = new URL(createEmbyAudioStreamUrl(
      { serverUrl: "https://example.test", pathPrefix: "/emby" },
      { userId: "user-1", userName: "tester", accessToken: "secret-token" },
      {
        itemId: "item 1",
        mediaSourceId: "source-1",
        audioStreamIndex: 3,
        playSessionId: "play-1",
        profile: "losslessFlac"
      }
    ));

    expect(url.pathname).toBe("/emby/Audio/item%201/stream.flac");
    expect(url.searchParams.get("AudioStreamIndex")).toBe("3");
    expect(url.searchParams.get("AudioCodec")).toBe("flac");
    expect(url.searchParams.get("EnableAutoStreamCopy")).toBe("false");
    expect(url.toString()).not.toContain("secret-token");
  });

  it("生成不含 token 的 Direct Play 原始媒体地址", () => {
    const url = new URL(createEmbyDirectVideoStreamUrl(
      { serverUrl: "https://example.test", pathPrefix: "/emby" },
      { userId: "user-1", userName: "tester", accessToken: "secret-token" },
      {
        itemId: "item 1",
        mediaSourceId: "source-1",
        playSessionId: "play-1"
      }
    ));

    expect(url.pathname).toBe("/emby/Videos/item%201/stream");
    expect(url.searchParams.get("Static")).toBe("true");
    expect(url.searchParams.get("MediaSourceId")).toBe("source-1");
    expect(url.searchParams.get("PlaySessionId")).toBe("play-1");
    expect(url.toString()).not.toContain("secret-token");
  });

  it("读取下级剧集并生成真实集时长表", async () => {
    const fetcher: EmbyFetch = () =>
      Promise.resolve(createResponse({
        Items: [
          {
            Id: "episode-2",
            Name: "Episode 2",
            Type: "Episode",
            ParentIndexNumber: 1,
            IndexNumber: 2,
            MediaSources: [{ RunTimeTicks: 3_045_000_0000 }]
          },
          {
            Id: "episode-1",
            Name: "Episode 1",
            Type: "Episode",
            ParentIndexNumber: 1,
            IndexNumber: 1,
            RunTimeTicks: 3_080_000_0000
          }
        ]
      }));

    const items = await fetchEmbyEpisodeChildren(
      { serverUrl: "https://example.test", pathPrefix: "emby" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      "series-1",
      fetcher
    );

    expect(formatEmbyEpisodeDurationLines(items)).toBe("S01E01 51:20\nS01E02 50:45");
  });

  it("可通过名称和季集号模糊搜索候选并优先排序匹配项", async () => {
    const calls: string[] = [];
    const fetcher: EmbyFetch = (input) => {
      calls.push(inputToString(input));
      return Promise.resolve(createResponse({
        Items: [
          {
            Id: "movie-1",
            Name: "Movie One",
            Type: "Movie",
            RunTimeTicks: 6_000_000_0000
          },
          {
            Id: "episode-1",
            Name: "Movie Episode",
            Type: "Episode",
            ParentIndexNumber: 2,
            IndexNumber: 3,
            RunTimeTicks: 1_500_000_0000
          }
        ]
      }));
    };

    const items = await searchEmbyItems(
      { serverUrl: "https://example.test", pathPrefix: "emby" },
      { userId: "user-1", userName: "tester", accessToken: "token-1" },
      { searchTerm: "Movie S02E03", limit: 12 },
      fetcher
    );

    expect(calls[0]).toContain("/emby/Users/user-1/Items?");
    expect(calls[0]).toContain("SearchTerm=Movie");
    expect(calls[0]).toContain("IncludeItemTypes=Movie%2CSeries%2CSeason%2CEpisode");
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("episode-1");
    expect(formatEmbySingleDurationLine(items[0])).toBe("S02E03 25:00");
  });

  it("把浏览器网络层失败转换为中文诊断", async () => {
    const fetcher: EmbyFetch = () => Promise.reject(new TypeError("Failed to fetch"));

    await expect(
      authenticateEmby(
        { serverUrl: "https://example.test", pathPrefix: "emby" },
        { username: "tester", password: "secret" },
        fetcher
      )
    ).rejects.toThrow("桌面模式会自动使用 Tauri 代理");
  });

  it("在桌面代理中序列化 Emby 请求并返回类 fetch 响应", async () => {
    const calls: EmbyProxyRequest[] = [];
    const fetcher = createTauriEmbyFetch((request) => {
      calls.push(request);
      return Promise.resolve({
        status: 200,
        body: {
          User: { Id: "user-1", Name: "tester" },
          AccessToken: "token-1"
        }
      });
    });

    const session = await authenticateEmby(
      { serverUrl: "https://example.test", pathPrefix: "/emby" },
      { username: "tester", password: "secret" },
      fetcher
    );

    expect(session.accessToken).toBe("token-1");
    expect(calls[0]).toMatchObject({
      url: "https://example.test/emby/Users/AuthenticateByName",
      method: "POST",
      body: "{\"Username\":\"tester\",\"Pw\":\"secret\"}"
    });
    expect(calls[0].headers).toContainEqual({ name: "content-type", value: "application/json" });
  });
});

function createResponse(payload: unknown): Awaited<ReturnType<EmbyFetch>> {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload)
  };
}

function inputToString(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === "string") {
    return input;
  }
  return input.url;
}
