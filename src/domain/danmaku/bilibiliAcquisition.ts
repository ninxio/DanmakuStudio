import type { XmlMediaMetadata } from "./xmlMediaMetadata";
/** Durable provenance; credentials and expiring playback URLs never belong here. */
export interface BilibiliAcquisition {
  kind: "bilibili";
  bvid: string;
  aid: number;
  cid: number;
  page: number;
  durationMs: number;
  exactDuration: boolean;
  xmlPath: string;
}

export function isBilibiliAcquisition(value: unknown): value is BilibiliAcquisition {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const keys = ["kind", "bvid", "aid", "cid", "page", "durationMs", "exactDuration", "xmlPath"];
  return (
    Object.keys(row).length === keys.length &&
    keys.every((key) => key in row) &&
    row.kind === "bilibili" &&
    typeof row.bvid === "string" &&
    /^BV[0-9A-Za-z]{10}$/.test(row.bvid) &&
    [row.aid, row.cid, row.page].every((n) => Number.isSafeInteger(n) && (n as number) > 0) &&
    Number.isSafeInteger(row.durationMs) &&
    (row.durationMs as number) >= 0 &&
    typeof row.exactDuration === "boolean" &&
    (!row.exactDuration || (row.durationMs as number) > 0) &&
    typeof row.xmlPath === "string" &&
    row.xmlPath.trim().length > 0 &&
    !row.xmlPath.includes("\0")
  );
}

export function getKnownBilibiliDuration(asset: {
  acquisition?: BilibiliAcquisition;
  xmlMetadata?: XmlMediaMetadata;
}): number | null {
  if (asset.xmlMetadata) return asset.xmlMetadata.timelineDurationMs;
  const source = asset.acquisition;
  return source?.exactDuration && source.durationMs > 0 ? source.durationMs : null;
}
