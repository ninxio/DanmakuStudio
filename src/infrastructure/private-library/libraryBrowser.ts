import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LibraryEpisode, LibraryWork } from "./libraryTypes";
import type { PublicationDelivery, PublicationFile } from "../../domain/publication/types";
export async function searchLibraryWorks(q: string): Promise<LibraryWork[]> {
  desktop();
  const r = await invoke<{ works: LibraryWork[] }>("browse_private_library", {
    q,
    workKey: null
  });
  return r.works;
}
export async function getLibraryEpisodes(workKey: string): Promise<LibraryEpisode[]> {
  desktop();
  const r = await invoke<{ episodes: LibraryEpisode[] }>("browse_private_library", {
    workKey,
    q: null
  });
  return r.episodes;
}
export async function reviewLibraryEpisode(
  episodeId: number,
  revision: string,
  approved: boolean
): Promise<void> {
  desktop();
  await invoke("review_private_library_episode", { episodeId, revision, approved });
}
export async function selectLibraryFiles(
  directory: boolean
): Promise<PublicationDelivery | null> {
  desktop();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory,
    multiple: !directory,
    title: directory ? "选择要检查、更新的弹幕文件夹" : "选择弹幕 XML",
    ...(!directory ? { filters: [{ name: "弹幕 XML", extensions: ["xml"] }] } : {})
  });
  if (!picked) return null;
  const paths: string[] = typeof picked === "string" ? [picked] : picked;
  const r = await invoke<{ files: PublicationFile[] }>("read_private_library_files", { paths });
  const now = new Date().toISOString();
  return {
    projectId: `library-import-${crypto.randomUUID()}`,
    projectName: paths[0].split(/[\\/]/).at(-1) ?? "本地成品",
    projectUpdatedAt: now,
    createdAt: now,
    kind: "xml",
    files: r.files
  };
}
function desktop(): void {
  if (!isTauri()) throw new Error("私人库连接和发布需要在 Windows 桌面版 Studio 中使用。");
}
