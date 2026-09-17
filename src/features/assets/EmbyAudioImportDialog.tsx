import { Download, FileAudio, Search, Server, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { TextInput } from "../../components/TextInput";
import { createId } from "../../domain/project/factory";
import type { EmbyAudioCacheMediaDraft } from "../../domain/project/mediaLibrary";
import type { ProjectMediaEmbyReference } from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import {
  cancelEmbyAudioDownload,
  downloadEmbyAudio,
  listenToEmbyAudioDownloadProgress
} from "../../infrastructure/metadata/embyAudioDownload";
import {
  authenticateEmby,
  createEmbyAudioStreamUrl,
  createEmbyDirectVideoStreamUrl,
  estimateEmbySourceBytes,
  fetchEmbyPlaybackInfo,
  searchEmbyItems,
  type EmbyAudioAcquisitionMode,
  type EmbyAudioDownloadProfile,
  type EmbyAudioMediaSource,
  type EmbyAudioStreamMetadata,
  type EmbyAuthSession,
  type EmbyItemMetadata
} from "../../infrastructure/metadata/embyClient";
import { probeTauriMediaTimeline } from "../../infrastructure/media/tauriMediaProbe";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { loadEmbyConnectionState, type EmbyConnectionState } from "./assetPanelSharedLogic";

interface SelectedTrack {
  source: EmbyAudioMediaSource;
  track: EmbyAudioStreamMetadata;
}

export function EmbyAudioImportDialog({
  onClose,
  onImport,
  returnFocusRef
}: {
  onClose: () => void;
  onImport: (draft: EmbyAudioCacheMediaDraft) => void;
  returnFocusRef?: RefObject<HTMLElement>;
}) {
  const [connection] = useState<EmbyConnectionState>(() => loadEmbyConnectionState());
  const [session, setSession] = useState<EmbyAuthSession | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<EmbyItemMetadata[]>([]);
  const [selectedItem, setSelectedItem] = useState<EmbyItemMetadata | null>(null);
  const [sources, setSources] = useState<EmbyAudioMediaSource[]>([]);
  const [selection, setSelection] = useState("");
  const [profile, setProfile] = useState<EmbyAudioDownloadProfile>("losslessFlac");
  const [acquisitionMode, setAcquisitionMode] =
    useState<EmbyAudioAcquisitionMode>("serverAudio");
  const [directStreamConfirmed, setDirectStreamConfirmed] = useState(false);
  const [busy, setBusy] = useState<"login" | "search" | "tracks" | "download" | null>("login");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequestedRef = useRef(false);
  const [progress, setProgress] = useState<{ received: number; total: number | null } | null>(
    null
  );
  const [message, setMessage] = useState("正在连接已保存的 Emby 账户…");
  const [tone, setTone] = useState<"neutral" | "success" | "warning" | "error">("neutral");

  const tracks = useMemo(
    () =>
      sources.flatMap((source) =>
        source.audioStreams.map((track) => ({
          key: `${source.id}:${track.index}`,
          source,
          track
        }))
      ),
    [sources]
  );
  const selectedTrack = tracks.find((candidate) => candidate.key === selection) ?? null;
  const estimatedSourceBytes = selectedTrack
    ? estimateEmbySourceBytes(selectedTrack.source)
    : null;

  useEffect(() => {
    let active = true;
    const login = async () => {
      if (!connection.config.serverUrl || !connection.username || !connection.password) {
        setBusy(null);
        setTone("warning");
        setMessage("请先在“设置 → Emby 连接”填写服务器、用户名和本次会话密码并保存。");
        return;
      }
      try {
        const authenticated = await authenticateEmby(connection.config, {
          username: connection.username,
          password: connection.password
        });
        if (active) {
          setSession(authenticated);
          setBusy(null);
          setTone("success");
          setMessage(
            `已连接 ${authenticated.userName || connection.username}。搜索电影或剧集即可选择音轨。`
          );
        }
      } catch (error) {
        if (active) {
          setBusy(null);
          setTone("error");
          setMessage(formatFailure(error));
        }
      }
    };
    void login();
    return () => {
      active = false;
    };
  }, [connection]);

  const runSearch = async () => {
    if (!session || !query.trim()) {
      return;
    }
    setBusy("search");
    setTone("neutral");
    setMessage("正在搜索 Emby 媒体库…");
    try {
      const results = await searchEmbyItems(connection.config, session, {
        searchTerm: query,
        includeItemTypes: ["Movie", "Episode"],
        limit: 30
      });
      setItems(results);
      setMessage(
        results.length > 0
          ? `找到 ${results.length} 个可用条目。`
          : "没有找到电影或剧集，请换一个关键词。"
      );
      setTone(results.length > 0 ? "success" : "warning");
    } catch (error) {
      setTone("error");
      setMessage(formatFailure(error));
    } finally {
      setBusy(null);
    }
  };

  const chooseItem = async (item: EmbyItemMetadata) => {
    if (!session) {
      return;
    }
    setSelectedItem(item);
    setSources([]);
    setSelection("");
    setBusy("tracks");
    setTone("neutral");
    setMessage(`正在读取 ${item.name} 的音轨…`);
    try {
      const playback = await fetchEmbyPlaybackInfo(connection.config, session, item.id);
      setSources(playback.mediaSources);
      const preferred = choosePreferredTrack(playback.mediaSources);
      setSelection(preferred ? `${preferred.source.id}:${preferred.track.index}` : "");
      const preferredMode = preferred?.source.supportsTranscoding
        ? "serverAudio"
        : "directVideoLocalExtract";
      setAcquisitionMode(preferredMode);
      setProfile(preferredMode === "serverAudio" ? "losslessFlac" : "originalCopy");
      setDirectStreamConfirmed(false);
      setMessage(
        preferred
          ? preferred.source.supportsTranscoding
            ? `已自动选择 ${formatTrackLabel(preferred.track)}；如有多语言或评论音轨，可手动更改。`
            : `已自动选择 ${formatTrackLabel(preferred.track)}。服务器不允许音频转码，将改用原始媒体直连并在本机提取音轨。`
          : "没有找到可用音轨。"
      );
      setTone(preferred?.source.supportsTranscoding ? "success" : "warning");
      setPlaybackSessionId(playback.playSessionId);
    } catch (error) {
      setTone("error");
      setMessage(formatFailure(error));
    } finally {
      setBusy(null);
    }
  };

  const [playbackSessionId, setPlaybackSessionId] = useState("");

  const startDownload = async () => {
    if (!session || !selectedItem || !selectedTrack || !playbackSessionId) {
      return;
    }
    if (acquisitionMode === "directVideoLocalExtract" && !directStreamConfirmed) {
      setTone("warning");
      setMessage("请先确认本次会从服务器读取原始媒体流及其预计网络用量。");
      return;
    }
    const nextRequestId = createId("emby_audio");
    cancelRequestedRef.current = false;
    setCancelling(false);
    setRequestId(nextRequestId);
    setBusy("download");
    setProgress({ received: 0, total: null });
    setTone("neutral");
    setMessage(
      acquisitionMode === "serverAudio"
        ? "正在由 Emby 服务器提取音轨；首次需要等待，之后会直接复用缓存。"
        : "正在读取原始媒体流并由本机 FFmpeg 提取音轨；磁盘只保存音频。"
    );
    const unlisten = await listenToEmbyAudioDownloadProgress((next) => {
      if (next.requestId === nextRequestId) {
        setProgress({ received: next.receivedBytes, total: next.totalBytes });
      }
    });
    try {
      const settings = loadAppSettings();
      const url =
        acquisitionMode === "serverAudio"
          ? createEmbyAudioStreamUrl(connection.config, session, {
              itemId: selectedItem.id,
              mediaSourceId: selectedTrack.source.id,
              audioStreamIndex: selectedTrack.track.index,
              playSessionId: playbackSessionId,
              profile: profile === "originalCopy" ? "losslessFlac" : profile
            })
          : createEmbyDirectVideoStreamUrl(connection.config, session, {
              itemId: selectedItem.id,
              mediaSourceId: selectedTrack.source.id,
              playSessionId: playbackSessionId
            });
      const result = await downloadEmbyAudio({
        requestId: nextRequestId,
        url,
        accessToken: session.accessToken,
        cacheIdentity: [
          "emby-audio-cache-v2",
          connection.config.serverUrl.trim().toLocaleLowerCase(),
          connection.config.pathPrefix.trim(),
          selectedItem.id,
          selectedTrack.source.id,
          selectedTrack.track.index,
          acquisitionMode,
          profile
        ].join("\n"),
        displayName: createDownloadDisplayName(selectedItem),
        profile,
        strategy: acquisitionMode,
        audioStreamIndex: selectedTrack.track.index,
        ffmpegPath: settings.alignment.ffmpegPath || null
      });
      setMessage(
        result.cacheHit ? "发现相同音轨缓存，正在验证后直接导入…" : "音轨已下载，正在验证文件…"
      );
      const probe = await probeTauriMediaTimeline({
        path: result.localPath,
        ffmpegPath: settings.alignment.ffmpegPath || null
      });
      if (probe.audioStreams.length === 0) {
        throw new Error("缓存文件没有可识别音轨，未导入项目。");
      }
      const emby: ProjectMediaEmbyReference = {
        itemId: selectedItem.id,
        itemName: selectedItem.name,
        itemType: selectedItem.type,
        seriesName: selectedItem.seriesName,
        seasonNumber: selectedItem.seasonNumber,
        episodeNumber: selectedItem.episodeNumber,
        server: {
          serverUrl: connection.config.serverUrl,
          pathPrefix: connection.config.pathPrefix,
          username: connection.username
        },
        mediaSources: selectedItem.mediaSources
      };
      onImport({
        localPath: result.localPath,
        durationMs: probe.durationMs ?? selectedItem.durationMs,
        emby,
        profileLabel:
          profile === "originalCopy"
            ? "原始音轨封装"
            : profile === "losslessFlac"
              ? "无损 FLAC"
              : "AAC 256 kbps",
        audioTrackLabel: formatTrackLabel(selectedTrack.track)
      });
      setTone("success");
      setMessage(`${result.cacheHit ? "已复用" : "已保存"}音频缓存并导入原片素材。`);
    } catch (error) {
      if (cancelRequestedRef.current) {
        setTone("success");
        setMessage("已取消获取并清理临时文件。");
      } else {
        setTone("error");
        setMessage(formatFailure(error));
      }
    } finally {
      unlisten();
      setBusy(null);
      setRequestId(null);
      setCancelling(false);
      cancelRequestedRef.current = false;
    }
  };

  const cancelDownload = async () => {
    if (!requestId || cancelling) {
      return;
    }
    cancelRequestedRef.current = true;
    setCancelling(true);
    setTone("warning");
    setMessage("已收到取消请求，正在停止网络读取、关闭 FFmpeg 并清理临时文件…");
    try {
      const accepted = await cancelEmbyAudioDownload(requestId);
      if (!accepted) {
        cancelRequestedRef.current = false;
        setCancelling(false);
        setTone("warning");
        setMessage("任务已经结束或正在收尾，请稍候。");
      }
    } catch (error) {
      cancelRequestedRef.current = false;
      setCancelling(false);
      setTone("error");
      setMessage(`取消失败：${formatFailure(error)}`);
    }
  };

  return (
    <Dialog
      ariaLabelledBy="emby-audio-title"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      closeOnEscape={busy !== "download"}
      overlayClassName="z-[80] bg-surface-canvas/70"
      className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border-panel-line bg-surface-base"
    >
      <header className="flex items-center gap-3 border-b border-panel-line px-4 py-3">
        <Server size={18} className="text-accent-cyan" />
        <div className="min-w-0 flex-1">
          <h2 id="emby-audio-title" className="font-semibold text-content-primary">
            从 Emby 获取原片音频
          </h2>
          <p className="mt-0.5 text-xs text-content-muted">
            本地只保留所选音轨；服务器不能提取时，会读取原始媒体流并在本机转换。
          </p>
        </div>
        <IconButton
          label="关闭 Emby 音频导入"
          icon={<X size={17} />}
          onClick={onClose}
          disabled={busy === "download"}
        />
      </header>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto p-4">
        <div className={`rounded border p-3 text-xs leading-5 ${messageToneClass(tone)}`}>
          {message}
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：Dark S03E01"
            className="flex-1 px-3 py-2 focus:border-accent-cyan"
            disabled={!session || busy !== null}
            aria-label="搜索 Emby 电影或剧集"
          />
          <TextButton
            tone="primary"
            type="submit"
            disabled={!session || !query.trim() || busy !== null}
          >
            <Search size={15} />
            搜索
          </TextButton>
        </form>

        {items.length > 0 ? (
          <div className="mt-4 grid max-h-56 gap-2 overflow-auto rounded border border-panel-line p-2">
            {items.map((item) => (
              <Button
                key={item.id}
                tone="unstyled"
                onClick={() => void chooseItem(item)}
                disabled={busy !== null}
                className={`rounded border p-2 text-left transition ${
                  selectedItem?.id === item.id
                    ? "border-accent-cyan bg-accent-cyan/10"
                    : "border-panel-line bg-surface-canvas/20 hover:border-boundary-strong"
                }`}
              >
                <span className="block text-sm text-content-primary">
                  {createDownloadDisplayName(item)}
                </span>
                <span className="mt-1 block text-xs text-content-muted">
                  {item.durationMs === null ? "时长未知" : formatTimecode(item.durationMs)}
                </span>
              </Button>
            ))}
          </div>
        ) : null}

        {tracks.length > 0 ? (
          <section className="mt-4 rounded border border-panel-line bg-surface-canvas/15 p-3">
            <h3 className="flex items-center gap-2 text-sm font-medium text-content-primary">
              <FileAudio size={16} className="text-feedback-running" />
              选择音轨
            </h3>
            <div className="mt-3 grid gap-2">
              {tracks.map((candidate) => (
                <label
                  key={candidate.key}
                  className={`flex cursor-pointer items-start gap-3 rounded border p-2 ${
                    selection === candidate.key
                      ? "border-accent-cyan bg-accent-cyan/10"
                      : "border-panel-line bg-surface-canvas/20"
                  }`}
                >
                  <input
                    type="radio"
                    name="emby-audio-track"
                    value={candidate.key}
                    checked={selection === candidate.key}
                    onChange={() => {
                      setSelection(candidate.key);
                      const nextMode = candidate.source.supportsTranscoding
                        ? acquisitionMode
                        : "directVideoLocalExtract";
                      setAcquisitionMode(nextMode);
                      setProfile(
                        nextMode === "directVideoLocalExtract"
                          ? "originalCopy"
                          : profile === "originalCopy"
                            ? "losslessFlac"
                            : profile
                      );
                      setDirectStreamConfirmed(false);
                      if (candidate.source.supportsTranscoding) {
                        setTone("success");
                        setMessage(`已选择 ${formatTrackLabel(candidate.track)}。`);
                      } else {
                        setTone("warning");
                        setMessage(
                          `已选择 ${formatTrackLabel(candidate.track)}。服务器不允许音频转码，将读取原始媒体流并在本机提取。`
                        );
                      }
                    }}
                    disabled={busy !== null}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-content-primary">
                      {formatTrackLabel(candidate.track)}
                    </span>
                    <span className="mt-0.5 block text-xs text-content-muted">
                      {candidate.source.name || candidate.source.container || "媒体源"}
                      {!candidate.source.supportsTranscoding ? " · 需本机提取" : ""}
                      {candidate.source.supportsDirectPlay
                        ? " · Direct Play 可用"
                        : candidate.source.supportsDirectStream
                          ? " · 仅声明 Direct Stream"
                          : " · 未声明直连能力"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {selectedTrack && !selectedTrack.source.supportsTranscoding ? (
              <p
                id="emby-transcoding-advisory"
                className="mt-3 text-xs leading-5 text-accent-yellow"
              >
                该媒体源拒绝服务器转码。应用将像第三方播放器一样读取原始媒体流，再把所选音轨交给本机
                FFmpeg； 不会保存完整视频文件，但网络用量接近播放整部原片。
              </p>
            ) : null}
            <fieldset className="mt-4 grid gap-2">
              <legend className="text-xs text-content-muted">获取方式</legend>
              <label
                className={`flex items-start gap-3 rounded border p-3 ${
                  acquisitionMode === "serverAudio"
                    ? "border-accent-cyan bg-accent-cyan/10"
                    : "border-panel-line bg-surface-canvas/20"
                } ${selectedTrack?.source.supportsTranscoding ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
              >
                <input
                  type="radio"
                  name="emby-audio-mode"
                  checked={acquisitionMode === "serverAudio"}
                  disabled={busy !== null || !selectedTrack?.source.supportsTranscoding}
                  onChange={() => {
                    setAcquisitionMode("serverAudio");
                    setProfile(profile === "originalCopy" ? "losslessFlac" : profile);
                    setDirectStreamConfirmed(false);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm text-content-primary">服务器只发送音频</span>
                  <span className="mt-0.5 block text-xs text-content-muted">
                    最省流量；仅在服务器允许音频转码时可用。
                  </span>
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${
                  acquisitionMode === "directVideoLocalExtract"
                    ? "border-accent-cyan bg-accent-cyan/10"
                    : "border-panel-line bg-surface-canvas/20"
                }`}
              >
                <input
                  type="radio"
                  name="emby-audio-mode"
                  checked={acquisitionMode === "directVideoLocalExtract"}
                  disabled={busy !== null}
                  onChange={() => {
                    setAcquisitionMode("directVideoLocalExtract");
                    setProfile("originalCopy");
                    setDirectStreamConfirmed(false);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm text-content-primary">
                    本机从原始媒体流提取（兼容模式）
                  </span>
                  <span className="mt-0.5 block text-xs text-content-muted">
                    兼容禁止转码的服务器；不保存视频，但会读取约{" "}
                    {formatBytesOrUnknown(estimatedSourceBytes)} 网络数据。
                  </span>
                  {selectedTrack && !selectedTrack.source.supportsDirectPlay ? (
                    <span className="mt-1 block text-xs text-accent-yellow">
                      服务器播放信息未声明 Direct
                      Play；仍可发起真实直连测试，若被拒绝会安全停止。
                    </span>
                  ) : null}
                </span>
              </label>
            </fieldset>
            <label className="mt-4 block text-xs text-content-muted">
              缓存质量
              <select
                value={profile}
                onChange={(event) => setProfile(event.target.value as EmbyAudioDownloadProfile)}
                disabled={busy !== null}
                className="mt-1 w-full rounded border border-panel-line bg-surface-inset px-3 py-2 text-sm text-content-primary"
              >
                {acquisitionMode === "directVideoLocalExtract" ? (
                  <option value="originalCopy">原始音轨复制（最快，不重新编码）</option>
                ) : null}
                <option value="losslessFlac">FLAC（不增加有损压缩，推荐匹配）</option>
                <option value="compactAac">AAC 256 kbps（更省空间）</option>
              </select>
            </label>
            {acquisitionMode === "directVideoLocalExtract" ? (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded border border-accent-yellow/40 bg-accent-yellow/5 p-3 text-xs leading-5 text-content-secondary">
                <input
                  type="checkbox"
                  checked={directStreamConfirmed}
                  onChange={(event) => setDirectStreamConfirmed(event.target.checked)}
                  disabled={busy !== null}
                  className="mt-1"
                />
                <span>
                  我了解：本地只留下音频，但本次预计会从 Emby 读取
                  <strong className="mx-1 text-accent-yellow">
                    {formatBytesOrUnknown(estimatedSourceBytes)}
                  </strong>
                  原始媒体数据。服务器若拒绝 Direct Play，应用会停止且不会留下视频文件。
                </span>
              </label>
            ) : null}
          </section>
        ) : null}

        {busy === "download" && progress ? (
          <div className="mt-4 rounded border border-panel-line bg-surface-canvas/20 p-3 text-xs text-content-muted">
            <div className="flex justify-between gap-3" aria-live="polite">
              <span>{cancelling ? "正在停止并清理临时文件…" : "正在获取音频"}</span>
              <span>{formatProgress(progress.received, progress.total)}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded bg-surface-inset">
              <div
                className={`h-full transition-[width] ${cancelling ? "animate-pulse bg-accent-red" : "bg-accent-cyan"}`}
                style={{
                  width: `${progress.total ? Math.min(100, (progress.received / progress.total) * 100) : 15}%`
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      <footer className="flex flex-wrap justify-end gap-2 border-t border-panel-line px-4 py-3">
        {busy === "download" ? (
          <TextButton tone="danger" onClick={() => void cancelDownload()} disabled={cancelling}>
            {cancelling ? "正在取消并清理…" : "取消并清理"}
          </TextButton>
        ) : (
          <>
            <TextButton onClick={onClose}>关闭</TextButton>
            <TextButton
              tone="primary"
              onClick={() => void startDownload()}
              disabled={
                !selectedTrack ||
                !playbackSessionId ||
                busy !== null ||
                (acquisitionMode === "directVideoLocalExtract" && !directStreamConfirmed)
              }
              aria-describedby={
                selectedTrack && !selectedTrack.source.supportsTranscoding
                  ? "emby-transcoding-advisory"
                  : undefined
              }
            >
              <Download size={15} />
              获取并导入原片音频
            </TextButton>
          </>
        )}
      </footer>
    </Dialog>
  );
}

function choosePreferredTrack(sources: EmbyAudioMediaSource[]): SelectedTrack | null {
  for (const source of sources) {
    const defaultTrack = source.audioStreams.find(
      (track) => track.index === source.defaultAudioStreamIndex && !track.commentary
    );
    if (defaultTrack) {
      return { source, track: defaultTrack };
    }
    const preferred =
      source.audioStreams.find((track) => track.default && !track.commentary) ??
      source.audioStreams.find((track) => !track.commentary);
    if (preferred) {
      return { source, track: preferred };
    }
  }
  return null;
}

function formatTrackLabel(track: EmbyAudioStreamMetadata): string {
  return [
    track.displayTitle || track.title || track.language || `音轨 ${track.index}`,
    track.codec?.toUpperCase(),
    track.channels ? `${track.channels} 声道` : null,
    track.default ? "默认" : null,
    track.commentary ? "评论音轨" : null
  ]
    .filter(Boolean)
    .join(" · ");
}

function createDownloadDisplayName(item: EmbyItemMetadata): string {
  const episode =
    item.seasonNumber === null && item.episodeNumber === null
      ? ""
      : ` S${String(item.seasonNumber ?? 0).padStart(2, "0")}E${String(item.episodeNumber ?? 0).padStart(2, "0")}`;
  return `${item.seriesName || item.name}${episode}${item.seriesName ? ` · ${item.name}` : ""}`;
}

function formatProgress(received: number, total: number | null): string {
  const receivedText = formatBytes(received);
  return total && total > 0
    ? `${receivedText} / ${formatBytes(total)} · ${Math.round((received / total) * 100)}%`
    : receivedText;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(0, bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatBytesOrUnknown(bytes: number | null): string {
  return bytes === null ? "未知体积" : formatBytes(bytes);
}

function messageToneClass(tone: "neutral" | "success" | "warning" | "error"): string {
  if (tone === "success") return "border-accent-green/30 bg-accent-green/10 text-accent-green";
  if (tone === "warning")
    return "border-accent-yellow/30 bg-accent-yellow/10 text-accent-yellow";
  if (tone === "error")
    return "border-feedback-danger/40 bg-feedback-danger/10 text-feedback-danger";
  return "border-panel-line bg-surface-inset text-content-muted";
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
