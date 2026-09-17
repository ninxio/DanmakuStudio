import { describe, expect, it } from "vitest";
import type { MediaContentIdentity } from "./types";
import {
  areMediaContentIdentitiesEqual,
  isMediaContentIdentity,
  LEGACY_MEDIA_CONTENT_IDENTITY_ALGORITHM,
  MEDIA_CONTENT_IDENTITY_ALGORITHM
} from "./mediaIdentity";

describe("media content identity", () => {
  it("treats v2 mtime as diagnostic metadata rather than content equality", () => {
    const measured = createV2Identity("a", 100);
    const copied = { ...measured, modifiedUnixMs: measured.modifiedUnixMs + 60_000 };

    expect(isMediaContentIdentity(measured)).toBe(true);
    expect(areMediaContentIdentitiesEqual(measured, copied)).toBe(true);
  });

  it("compares v2 algorithm, size and the complete digest", () => {
    const measured = createV2Identity("a", 100);

    expect(areMediaContentIdentitiesEqual(measured, createV2Identity("b", 100))).toBe(false);
    expect(areMediaContentIdentitiesEqual(measured, createV2Identity("a", 101))).toBe(false);
    expect(isMediaContentIdentity({ ...measured, lastSampleDigest: "a".repeat(16) })).toBe(false);
    expect(isMediaContentIdentity({ ...measured, lastSampleDigest: "b".repeat(64) })).toBe(false);
  });

  it("keeps legacy v1 equality conservative, including mtime and all samples", () => {
    const legacy: MediaContentIdentity = {
      algorithm: LEGACY_MEDIA_CONTENT_IDENTITY_ALGORITHM,
      sizeBytes: 100,
      modifiedUnixMs: 1_700_000_000_000,
      firstSampleDigest: "1".repeat(16),
      middleSampleDigest: "2".repeat(16),
      lastSampleDigest: "3".repeat(16)
    };

    expect(areMediaContentIdentitiesEqual(legacy, { ...legacy })).toBe(true);
    expect(
      areMediaContentIdentitiesEqual(legacy, {
        ...legacy,
        modifiedUnixMs: legacy.modifiedUnixMs + 1
      })
    ).toBe(false);
  });
});

function createV2Identity(seed: string, sizeBytes: number): MediaContentIdentity {
  const digest = seed.repeat(64);
  return {
    algorithm: MEDIA_CONTENT_IDENTITY_ALGORITHM,
    sizeBytes,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: digest,
    middleSampleDigest: digest,
    lastSampleDigest: digest
  };
}
