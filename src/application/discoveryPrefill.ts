import type { DiscoveryItem } from "../domain/project/discovery";
export interface MotrixPrefill {
  requestId: string;
  projectId: string;
  projectEpoch: number;
  kind: "search" | "detail" | "magnet";
  value: string;
  title: string;
  provider: "ext" | "nyaa";
}
export function discoveryMotrixPrefill(
  item: DiscoveryItem,
  context: { projectId: string; projectEpoch: number },
  requestId: string,
  provider: "ext" | "nyaa"
): MotrixPrefill {
  const title = item.profile?.title || item.title;
  if (item.kind === "bilibili") throw new Error("B站链接请带入 B站获取。");
  if (item.kind === "douban" && !title.trim())
    throw new Error("先填写作品名称，再带入原片搜索。");
  if (item.kind === "ext" || item.kind === "nyaa") {
    const url = new URL(item.link);
    if (
      (item.kind === "ext" && /^\/(?:browse|search)\/?$/.test(url.pathname)) ||
      (item.kind === "nyaa" && url.pathname === "/")
    ) {
      const query = url.searchParams.get("q")?.trim() || title.trim();
      if (!query) throw new Error("搜索页没有关键词，请先补充作品名称。");
      return {
        ...context,
        requestId,
        title,
        kind: "search",
        value: query,
        provider: item.kind
      };
    }
  }
  return {
    ...context,
    requestId,
    title,
    kind: item.kind === "magnet" ? "magnet" : item.kind === "douban" ? "search" : "detail",
    value: item.kind === "douban" ? title : item.link,
    provider: item.kind === "nyaa" ? "nyaa" : item.kind === "ext" ? "ext" : provider
  };
}
