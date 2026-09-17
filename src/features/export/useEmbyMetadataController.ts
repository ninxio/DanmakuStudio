import { useEffect, useRef, useState } from "react";
import {
  authenticateEmby,
  fetchEmbyEpisodeChildren,
  fetchEmbyItem,
  formatEmbyEpisodeDurationLines,
  formatEmbySingleDurationLine,
  searchEmbyItems,
  type EmbyAuthSession,
  type EmbyItemMetadata
} from "../../infrastructure/metadata/embyClient";
import { useEditorStore } from "../../stores/editorStore";
import {
  createEmbyBindingFromItem,
  loadEmbyConnectionState,
  setStatus,
  validateEmbyConnectionState
} from "../assets/assetPanelSharedLogic";

type LoadingKind = "auth" | "search" | "item" | "episodes";

/** Owns a project's Emby work independently of the optional export sheet. */
export function useEmbyMetadataController(onImportDurationLines: (lines: string) => void) {
  const [owner] = useState(() => {
    const state = useEditorStore.getState();
    return {
      projectId: state.project.id,
      projectEpoch: state.projectEpoch,
      active: false,
      generation: 0,
      busy: false
    };
  });
  const [itemId, setItemId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const sessionRef = useRef<{ key: string; session: EmbyAuthSession } | null>(null);
  const [loadedItem, setLoadedItem] = useState<EmbyItemMetadata | null>(null);
  const [episodeItems, setEpisodeItems] = useState<EmbyItemMetadata[]>([]);
  const [searchResults, setSearchResults] = useState<EmbyItemMetadata[]>([]);
  const [durationLines, setDurationLines] = useState("");
  const [loading, setLoading] = useState<LoadingKind | null>(null);

  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      owner.generation += 1;
      owner.busy = false;
      sessionRef.current = null;
    };
  }, [owner]);

  const isCurrentOwner = () => {
    const state = useEditorStore.getState();
    return (
      owner.active &&
      state.project.id === owner.projectId &&
      state.projectEpoch === owner.projectEpoch
    );
  };

  async function runAction(
    kind: LoadingKind,
    action: (current: () => boolean) => Promise<void>
  ) {
    if (!isCurrentOwner() || owner.busy) return;
    owner.busy = true;
    const generation = ++owner.generation;
    const current = () => isCurrentOwner() && generation === owner.generation;
    setLoading(kind);
    try {
      await action(current);
    } catch (error) {
      if (current()) {
        setStatus({
          message: error instanceof Error ? error.message : "Emby 请求失败。",
          tone: "error"
        });
      }
    } finally {
      if (current()) {
        owner.busy = false;
        setLoading(null);
      }
    }
  }

  const ensureSession = async (current: () => boolean, kind: LoadingKind) => {
    const connection = loadEmbyConnectionState();
    if (!current() || !validateEmbyConnectionState(connection)) return null;
    if (sessionRef.current?.key === connection.sessionKey) {
      return { connection, session: sessionRef.current.session };
    }
    setLoading("auth");
    const session = await authenticateEmby(connection.config, {
      username: connection.username,
      password: connection.password
    });
    if (!current()) return null;
    sessionRef.current = { key: connection.sessionKey, session };
    setSearchResults([]);
    setLoading(kind);
    setStatus({
      message: `Emby 已登录：${session.userName || session.userId}`,
      tone: "success"
    });
    return { connection, session };
  };

  const searchItems = () =>
    runAction("search", async (current) => {
      if (!searchTerm.trim()) {
        setStatus({ message: "请填写要搜索的片名、剧名或季集信息。", tone: "warning" });
        return;
      }
      const ready = await ensureSession(current, "search");
      if (!ready || !current()) return;
      const items = await searchEmbyItems(ready.connection.config, ready.session, {
        searchTerm,
        limit: 12
      });
      if (!current()) return;
      setSearchResults(items);
      setStatus({
        message:
          items.length > 0
            ? `已找到 ${items.length} 个 Emby 候选条目。`
            : "没有找到匹配的 Emby 条目。",
        tone: items.length > 0 ? "success" : "warning"
      });
    });

  const selectSearchResult = (item: EmbyItemMetadata) => {
    if (!isCurrentOwner() || owner.busy) return;
    setItemId(item.id);
    setLoadedItem(item);
    setEpisodeItems([]);
    setDurationLines("");
    setStatus({ message: `已选择 Emby 条目：${item.name}`, tone: "success" });
  };

  const importDurationLines = () => {
    if (isCurrentOwner()) onImportDurationLines(durationLines);
  };

  const importLoadedItemDuration = () => {
    if (!isCurrentOwner()) return;
    if (!loadedItem || loadedItem.durationMs === null) {
      setStatus({ message: "当前条目没有可导入的时长。", tone: "warning" });
      return;
    }
    const line = formatEmbySingleDurationLine(loadedItem);
    setDurationLines(line);
    onImportDurationLines(line);
    setStatus({ message: "已把单条 Emby 时长导入人工整理规则。", tone: "success" });
  };

  const bindLoadedItemAsTarget = () => {
    if (!isCurrentOwner()) return;
    if (!loadedItem) {
      setStatus({ message: "请先选择或读取一个 Emby 条目。", tone: "warning" });
      return;
    }
    const connection = loadEmbyConnectionState();
    if (!validateEmbyConnectionState(connection)) return;
    useEditorStore
      .getState()
      .setMediaBinding(createEmbyBindingFromItem(loadedItem, connection));
  };

  const readItem = () =>
    runAction("item", async (current) => {
      const selectedItemId = itemId.trim();
      if (!selectedItemId) {
        setStatus({ message: "请先从搜索结果中选择一个 Emby 条目。", tone: "warning" });
        return;
      }
      const ready = await ensureSession(current, "item");
      if (!ready || !current()) return;
      const item = await fetchEmbyItem(ready.connection.config, ready.session, selectedItemId);
      if (!current()) return;
      setLoadedItem(item);
      setStatus({ message: `已读取 Emby 条目：${item.name}`, tone: "success" });
    });

  const readEpisodes = () =>
    runAction("episodes", async (current) => {
      const selectedItemId = itemId.trim();
      if (!selectedItemId) {
        setStatus({ message: "请先从搜索结果中选择剧集、季或合集。", tone: "warning" });
        return;
      }
      const ready = await ensureSession(current, "episodes");
      if (!ready || !current()) return;
      const items = await fetchEmbyEpisodeChildren(
        ready.connection.config,
        ready.session,
        selectedItemId
      );
      if (!current()) return;
      const lines = formatEmbyEpisodeDurationLines(items);
      setEpisodeItems(items);
      setDurationLines(lines);
      setStatus({
        message:
          lines.length > 0
            ? `已读取 ${items.length} 个 Emby 剧集条目。`
            : "未读到带时长的 Emby 剧集。",
        tone: lines.length > 0 ? "success" : "warning"
      });
    });

  return {
    itemId,
    searchTerm,
    loadedItem,
    episodeItems,
    searchResults,
    durationLines,
    loading,
    hasSelectedItem: itemId.trim().length > 0,
    setSearchTerm,
    searchItems,
    selectSearchResult,
    importLoadedItemDuration,
    bindLoadedItemAsTarget,
    readItem,
    readEpisodes,
    importDurationLines
  };
}

export type EmbyMetadataController = ReturnType<typeof useEmbyMetadataController>;
