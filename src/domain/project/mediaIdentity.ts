import type { MediaContentIdentity } from "./types";

export const MEDIA_CONTENT_IDENTITY_ALGORITHM = "sha256-full-file-v2";
export const LEGACY_MEDIA_CONTENT_IDENTITY_ALGORITHM = "fnv1a64-first-middle-last-64k-v1";

export function isMediaContentIdentity(value: unknown): value is MediaContentIdentity {
  if (!isRecord(value)) {
    return false;
  }
  const structurallyValid = (
    typeof value.algorithm === "string" &&
    value.algorithm.trim().length > 0 &&
    isNonNegativeSafeInteger(value.sizeBytes) &&
    isNonNegativeSafeInteger(value.modifiedUnixMs) &&
    isDigest(value.firstSampleDigest) &&
    isDigest(value.middleSampleDigest) &&
    isDigest(value.lastSampleDigest)
  );
  if (!structurallyValid) {
    return false;
  }
  if (value.algorithm !== MEDIA_CONTENT_IDENTITY_ALGORITHM) {
    return true;
  }
  return (
    isSha256Digest(value.firstSampleDigest) &&
    value.firstSampleDigest === value.middleSampleDigest &&
    value.middleSampleDigest === value.lastSampleDigest
  );
}

export function areMediaContentIdentitiesEqual(
  left: MediaContentIdentity | null | undefined,
  right: MediaContentIdentity | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  if (
    left.algorithm === MEDIA_CONTENT_IDENTITY_ALGORITHM &&
    right.algorithm === MEDIA_CONTENT_IDENTITY_ALGORITHM
  ) {
    return (
      left.sizeBytes === right.sizeBytes &&
      left.firstSampleDigest === right.firstSampleDigest &&
      left.middleSampleDigest === right.middleSampleDigest &&
      left.lastSampleDigest === right.lastSampleDigest
    );
  }
  return (
    left.algorithm === right.algorithm &&
    left.sizeBytes === right.sizeBytes &&
    left.modifiedUnixMs === right.modifiedUnixMs &&
    left.firstSampleDigest === right.firstSampleDigest &&
    left.middleSampleDigest === right.middleSampleDigest &&
    left.lastSampleDigest === right.lastSampleDigest
  );
}

export function cloneMediaContentIdentity(
  identity: MediaContentIdentity | null | undefined
): MediaContentIdentity | null {
  return identity ? { ...identity } : null;
}

function isDigest(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{16,128}$/.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
