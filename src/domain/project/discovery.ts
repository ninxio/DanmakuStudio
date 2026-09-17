import { portableMagnet } from "../shared/magnet";
/** Portable user-authored catalogue information. It never grants projection or matching authority. */
export interface LibraryProfile {
  schemaVersion: 1;
  workKey: string;
  editionKey: string;
  sourceKey: string;
  title: string;
  aliases: string[];
  kind: "movie" | "tv" | null;
  year: number | null;
  edition: string;
  sourceLabel: string;
  season: number | null;
}
export type DiscoveryKind = "bilibili" | "douban" | "ext" | "nyaa" | "magnet";
export interface DiscoveryItem {
  id: string;
  kind: DiscoveryKind;
  link: string;
  title: string;
  note: string;
  status: "todo" | "done";
  profile?: LibraryProfile;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const nullableInt = (v: unknown, min: number, max: number) =>
  v === null || (Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max);
export function isLibraryProfile(v: unknown): v is LibraryProfile {
  if (!record(v)) return false;
  const keys = [
    "schemaVersion",
    "workKey",
    "editionKey",
    "sourceKey",
    "title",
    "aliases",
    "kind",
    "year",
    "edition",
    "sourceLabel",
    "season"
  ];
  return (
    Object.keys(v).every((k) => keys.includes(k)) &&
    v.schemaVersion === 1 &&
    [v.workKey, v.editionKey, v.sourceKey].every(
      (k) => typeof k === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(k)
    ) &&
    text(v.title, 200) &&
    text(v.edition, 200) &&
    text(v.sourceLabel, 200) &&
    Array.isArray(v.aliases) &&
    v.aliases.length <= 50 &&
    v.aliases.every((a) => text(a, 200)) &&
    (v.kind === null || v.kind === "tv" || v.kind === "movie") &&
    nullableInt(v.year, 1880, 2200) &&
    nullableInt(v.season, 0, 999)
  );
}
export function createLibraryProfile(id: string, title = ""): LibraryProfile {
  return {
    schemaVersion: 1,
    workKey: `work-${id}`,
    editionKey: `edition-${id}`,
    sourceKey: `source-${id}`,
    title,
    aliases: [],
    kind: null,
    year: null,
    edition: "",
    sourceLabel: "个人整理",
    season: null
  };
}
/** Keep only public locator fields; session, account and tracking queries are not portable. */
export function parseDiscoveryLink(input: string): { kind: DiscoveryKind; link: string } {
  if (input.length > 16384) throw new Error("链接过长。");
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("请输入完整的 B站、豆瓣、EXT、Nyaa 或 magnet 链接。");
  }
  if (url.username || url.password) throw new Error("链接不能包含账户凭据。");
  if (url.protocol === "magnet:") {
    return { kind: "magnet", link: portableMagnet(input) };
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443"))
    throw new Error("网页链接须使用 HTTPS。");
  const host = url.hostname.toLowerCase();
  const kind: DiscoveryKind | undefined = [
    "www.bilibili.com",
    "bilibili.com",
    "b23.tv"
  ].includes(host)
    ? "bilibili"
    : ["movie.douban.com", "www.douban.com", "douban.com"].includes(host)
      ? "douban"
      : host === "ext.to"
        ? "ext"
        : host === "nyaa.si"
          ? "nyaa"
          : undefined;
  if (!kind) throw new Error("目前支持 B站、豆瓣、EXT 和 Nyaa；其它来源可填写笔记。");
  const clean = new URL(url.origin + url.pathname);
  const allowed =
    kind === "bilibili"
      ? ["p"]
      : kind === "ext"
        ? ["q", "page"]
        : kind === "nyaa"
          ? ["q", "p", "c", "f", "s", "o"]
          : [];
  for (const key of allowed) {
    const value = url.searchParams.get(key);
    if (value) clean.searchParams.set(key, value);
  }
  return { kind, link: clean.href };
}
export function isDiscoveryItems(v: unknown): v is DiscoveryItem[] {
  return (
    Array.isArray(v) &&
    v.length <= 1000 &&
    new Set(v.map((x) => (record(x) ? x.id : null))).size === v.length &&
    v.every((x) => {
      if (
        !record(x) ||
        !Object.keys(x).every((k) =>
          ["id", "kind", "link", "title", "note", "status", "profile"].includes(k)
        ) ||
        !text(x.id, 128) ||
        !x.id ||
        !text(x.title, 200) ||
        !text(x.note, 2000) ||
        !text(x.link, 16384) ||
        (x.status !== "todo" && x.status !== "done") ||
        (x.profile !== undefined && !isLibraryProfile(x.profile))
      )
        return false;
      try {
        const parsed = parseDiscoveryLink(x.link);
        return parsed.kind === x.kind && parsed.link === x.link;
      } catch {
        return false;
      }
    })
  );
}
