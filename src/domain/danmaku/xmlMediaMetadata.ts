/** Descriptive source information, never an identity proof or a file-open instruction. */
export interface XmlVideoSource {
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  pageCount: number | null;
  title: string;
  part: string;
  durationMs: number;
  durationSource: string;
  durationSourceUnit: string;
  exactDuration: boolean;
  audio?: {
    included: boolean;
    file: string | null;
    container: string | null;
    codec: string | null;
    bandwidth: number | null;
  };
}

export interface XmlMediaMetadata {
  version: 1;
  /** Current XML timeline, distinct from the original videos listed below. */
  timelineDurationMs: number | null;
  sources: XmlVideoSource[];
}

const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const text = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length <= 4096 &&
  [...s].every((c) => c.charCodeAt(0) >= 32 || "\t\n\r".includes(c));

export function isXmlMediaMetadata(value: unknown): value is XmlMediaMetadata {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.version === 1 &&
    (row.timelineDurationMs === null || integer(row.timelineDurationMs)) &&
    Array.isArray(row.sources) &&
    row.sources.length <= 1024 &&
    row.sources.every((source: unknown) => {
      if (!source || typeof source !== "object") return false;
      const s = source as Record<string, unknown>;
      return (
        text(s.bvid) &&
        /^BV[0-9A-Za-z]{10}$/.test(s.bvid) &&
        [s.aid, s.cid, s.page].every((n) => integer(n) && n > 0) &&
        (s.pageCount === null || (integer(s.pageCount) && (s.page as number) <= s.pageCount)) &&
        text(s.title) &&
        text(s.part) &&
        integer(s.durationMs) &&
        [
          "playurl.dash.duration",
          "playurl.timelength",
          "view.pages.duration",
          "unknown"
        ].includes(String(s.durationSource)) &&
        s.durationSourceUnit ===
          (s.durationSource === "unknown"
            ? "unknown"
            : s.durationSource === "playurl.timelength"
              ? "millisecond"
              : "second") &&
        typeof s.exactDuration === "boolean" &&
        (!s.exactDuration ||
          (s.durationMs > 0 && s.durationSource !== "view.pages.duration")) &&
        (s.audio === undefined || validAudio(s.audio))
      );
    })
  );
}

function validAudio(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const audio = value as Record<string, unknown>;
  return (
    typeof audio.included === "boolean" &&
    [audio.file, audio.container, audio.codec].every((s) => s === null || text(s)) &&
    (audio.bandwidth === null || integer(audio.bandwidth))
  );
}
