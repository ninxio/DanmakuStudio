import { normalizeMagnet } from "../../domain/shared/magnet";
export { normalizeMagnet } from "../../domain/shared/magnet";
/** Website adapters only extract data. Remote markup is never mounted or executed. */
export type SourceProviderId = "ext" | "nyaa";
export interface SourceCandidate {
  id: string;
  title: string;
  detailsUrl: string;
  size: string;
  seeds: string;
  magnet: string | null;
}
export const sourceProviders = [
  { id: "ext", name: "EXT · 影视", origin: "https://ext.to" },
  { id: "nyaa", name: "Nyaa · 动画", origin: "https://nyaa.si" }
] as const;

export function sourceSearchUrl(provider: SourceProviderId, query: string, page = 1): string {
  if (!query.trim() || query.length > 200)
    throw new Error("请输入不超过 200 字的片名或 IMDb 编号。");
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error("页数无效。");
  const url = new URL(provider === "ext" ? "https://ext.to/browse/" : "https://nyaa.si/");
  url.searchParams.set("q", query.trim());
  url.searchParams.set(provider === "ext" ? "page" : "p", String(page));
  if (provider === "nyaa") {
    url.searchParams.set("s", "seeders");
    url.searchParams.set("o", "desc");
  }
  return url.href;
}
export function validateSourceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["ext.to", "nyaa.si"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("仅支持 EXT 和 Nyaa 的 HTTPS 页面；其它网站请粘贴磁力链接。");
  return url.href;
}
function readMagnet(root: ParentNode): string | null {
  for (const anchor of root.querySelectorAll('a[href^="magnet:"]')) {
    try {
      return normalizeMagnet(anchor.getAttribute("href") ?? "");
    } catch {
      /* Try next actual link. */
    }
  }
  const hash = root.querySelector("#torrent-hash-display")?.textContent?.trim();
  if (hash) {
    try {
      return normalizeMagnet(hash);
    } catch {
      /* Not a revealed hash. */
    }
  }
  return null;
}
export function parseSourceSearch(
  provider: SourceProviderId,
  html: string
): { results: SourceCandidate[]; hasNext: boolean } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const origin = provider === "ext" ? "https://ext.to" : "https://nyaa.si";
  const table = doc.querySelector(
    provider === "ext" ? "table.search-table" : "table.torrent-list"
  );
  if (!table) {
    if (/just a moment|checking your browser|verify you are human/i.test(doc.title))
      throw new Error("网站需要浏览器验证，请打开搜索页后复制磁力。");
    if (/no torrents found|no results found|nothing found/i.test(doc.body.textContent ?? ""))
      return { results: [], hasNext: false };
    throw new Error(
      "网站未返回可识别的搜索列表；可能需要验证或页面结构已改变。可打开搜索页继续。"
    );
  }
  const results: SourceCandidate[] = [];
  for (const row of table.querySelectorAll("tbody > tr")) {
    const a = row.querySelector(
      provider === "ext" ? "a.torrent-title-link" : "td:nth-child(2) a:last-of-type"
    );
    if (!a?.textContent?.trim()) continue;
    let detailsUrl: string;
    try {
      detailsUrl = validateSourceUrl(new URL(a.getAttribute("href") ?? "", origin).href);
    } catch {
      continue;
    }
    const text = (selector: string) =>
      row.querySelector(selector)?.textContent?.trim() ?? "未知";
    results.push({
      id: detailsUrl,
      title: a.textContent.trim(),
      detailsUrl,
      size: text(
        provider === "ext"
          ? "td:nth-child(2) .add-block-wrapper > span:last-child"
          : "td:nth-child(4)"
      ),
      seeds: text(
        provider === "ext"
          ? "td:nth-child(5) .add-block-wrapper > span:last-child"
          : "td:nth-child(6)"
      ),
      magnet: readMagnet(row)
    });
  }
  if (!results.length && table.querySelector("a.torrent-title-link, a[href*='/view/']"))
    throw new Error("搜索页格式已变化，请打开网页选择磁力。");
  const next = doc.querySelector(
    provider === "ext"
      ? "ul.pages li.active + li a[href]"
      : "ul.pagination li.active + li:not(.disabled) a[href]"
  );
  return { results: results.slice(0, 100), hasNext: Boolean(next) };
}
export function parseSourceMagnet(html: string): string | null {
  return readMagnet(new DOMParser().parseFromString(html, "text/html"));
}
