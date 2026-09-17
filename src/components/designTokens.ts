export type DesignColorToken =
  | "surface-canvas"
  | "surface-base"
  | "surface-raised"
  | "surface-inset"
  | "surface-soft"
  | "boundary-default"
  | "boundary-strong"
  | "content-primary"
  | "content-secondary"
  | "content-muted"
  | "content-subtle"
  | "feedback-running"
  | "feedback-success"
  | "feedback-warning"
  | "feedback-danger"
  | "timeline-track-alternate"
  | "timeline-label"
  | "timeline-guide"
  | "timeline-axis-text"
  | "timeline-bright"
  | "timeline-video"
  | "timeline-video-text"
  | "timeline-clip-outline"
  | "timeline-clip-text"
  | "timeline-correction"
  | "timeline-correction-text"
  | "timeline-danger-panel"
  | "timeline-danger-outline"
  | "timeline-danger-text"
  | "evidence-supported"
  | "evidence-source-only"
  | "evidence-target-only"
  | "evidence-cut"
  | "evidence-replacement"
  | "evidence-recovered";

const FALLBACK_CHANNELS: Record<DesignColorToken, string> = {
  "surface-canvas": "13 16 21",
  "surface-base": "21 23 27",
  "surface-raised": "28 31 37",
  "surface-inset": "17 19 24",
  "surface-soft": "36 40 50",
  "boundary-default": "48 53 64",
  "boundary-strong": "75 85 99",
  "content-primary": "241 245 249",
  "content-secondary": "226 232 240",
  "content-muted": "148 163 184",
  "content-subtle": "100 116 139",
  "feedback-running": "76 201 240",
  "feedback-success": "123 216 143",
  "feedback-warning": "242 201 76",
  "feedback-danger": "255 107 107",
  "timeline-track-alternate": "23 26 32",
  "timeline-label": "107 114 128",
  "timeline-guide": "71 80 98",
  "timeline-axis-text": "203 213 225",
  "timeline-bright": "248 250 252",
  "timeline-video": "39 55 74",
  "timeline-video-text": "219 234 254",
  "timeline-clip-outline": "17 24 39",
  "timeline-clip-text": "15 23 42",
  "timeline-correction": "255 143 112",
  "timeline-correction-text": "255 190 165",
  "timeline-danger-panel": "127 29 29",
  "timeline-danger-outline": "248 113 113",
  "timeline-danger-text": "254 226 226",
  "evidence-supported": "16 185 129",
  "evidence-source-only": "251 191 36",
  "evidence-target-only": "34 211 238",
  "evidence-cut": "245 158 11",
  "evidence-replacement": "232 121 249",
  "evidence-recovered": "125 211 252"
};

const documentCaches = new WeakMap<
  Document,
  { revision: string; channels: Map<DesignColorToken, string> }
>();

export function designTokenColor(
  token: DesignColorToken,
  alpha = 1,
  ownerDocument: Document | null = typeof document === "undefined" ? null : document
): string {
  const channels = readTokenChannels(token, ownerDocument);
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  return `rgb(${channels} / ${safeAlpha})`;
}

function readTokenChannels(token: DesignColorToken, ownerDocument: Document | null): string {
  if (!ownerDocument) return FALLBACK_CHANNELS[token];
  const root = ownerDocument.documentElement;
  const revision = `${root.dataset.theme ?? "default"}:${root.dataset.themeRevision ?? "0"}`;
  let cache = documentCaches.get(ownerDocument);
  if (!cache || cache.revision !== revision) {
    cache = { revision, channels: new Map() };
    documentCaches.set(ownerDocument, cache);
  }
  const cached = cache.channels.get(token);
  if (cached) {
    return cached;
  }
  const cssValue = ownerDocument
    ? ownerDocument.defaultView
        ?.getComputedStyle(ownerDocument.documentElement)
        .getPropertyValue(`--color-${token}`)
        .trim()
    : "";
  const channels = cssValue || FALLBACK_CHANNELS[token];
  cache.channels.set(token, channels);
  return channels;
}
