import { describe, expect, it } from "vitest";
import { createWebDavAudioCacheMediaReference } from "./mediaLibrary";
import { parseProjectMediaEpisodeIdentity } from "./episodeIdentity";
import { useEditorStore } from "../../stores/editorStore";

describe("WebDAV 音轨原片引用", () => {
  const draft = {
    localPath: "I:/cache/unique/audio.flac",
    fileName: "Tom & Jerry.S02E03.audio-1-unique.flac",
    name: "Tom & Jerry.S02E03.mkv",
    durationMs: 2000,
    audioTrackLabel: "音轨 1"
  };
  it("物理缓存稳定且展示/导出名保留显式季集，仍声明为音频", () => {
    const media = createWebDavAudioCacheMediaReference("id", draft);
    expect(media.localPath).toBe(draft.localPath);
    expect(media.fileName).toBe(draft.fileName);
    expect(media.role).toBe("targetOriginal");
    expect(media.contentIdentity).toBeNull();
    expect(media.sourceSummary).toContain("未证明");
    expect(parseProjectMediaEpisodeIdentity(media)?.episodeStart).toBe(3);
  });
  it("导入走项目编辑历史、重复路径去重，不保存远端账户", () => {
    useEditorStore.getState().newProject();
    useEditorStore.getState().importWebDavAudioCache(draft);
    useEditorStore.getState().importWebDavAudioCache(draft);
    const project = useEditorStore.getState().project;
    expect(project.mediaLibrary).toHaveLength(1);
    expect(JSON.stringify(project)).not.toContain("password");
    expect(project.mediaLibrary[0].fileName).toBe(draft.fileName);
  });
});
