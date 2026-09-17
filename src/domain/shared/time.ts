export type Milliseconds = number;

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;

export function toMilliseconds(seconds: number): Milliseconds {
  return Math.round(seconds * SECOND_MS);
}

export function parseXmlSecondsToMilliseconds(value: string): Milliseconds | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const [wholeSecondsText, fractionText = ""] = trimmed.split(".");
  const wholeSeconds = Number(wholeSecondsText);
  if (!Number.isSafeInteger(wholeSeconds)) {
    return null;
  }
  const millisecondsText = fractionText.slice(0, 3).padEnd(3, "0");
  const nextDigit = fractionText.length > 3 ? Number(fractionText[3]) : 0;
  const roundedFractionMs = Number(millisecondsText) + (nextDigit >= 5 ? 1 : 0);
  const totalMs = wholeSeconds * SECOND_MS + roundedFractionMs;
  if (!Number.isSafeInteger(totalMs)) {
    return null;
  }
  return totalMs;
}

export function secondsFromMilliseconds(milliseconds: Milliseconds): number {
  return milliseconds / SECOND_MS;
}

export function clampMilliseconds(milliseconds: Milliseconds): Milliseconds {
  return Math.max(0, Math.round(milliseconds));
}

export function formatTimecode(milliseconds: Milliseconds): string {
  const safe = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(safe / HOUR_MS);
  const minutes = Math.floor((safe % HOUR_MS) / MINUTE_MS);
  const seconds = Math.floor((safe % MINUTE_MS) / SECOND_MS);
  const ms = safe % SECOND_MS;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${ms
    .toString()
    .padStart(3, "0")}`;
}

export function parseIntegerMilliseconds(value: string): Milliseconds | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed);
}

export function formatXmlSeconds(milliseconds: Milliseconds): string {
  return (Math.max(0, Math.round(milliseconds)) / SECOND_MS).toFixed(3);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
