export const SPECTRAL_BACKEND_PREFERENCES = ["auto", "cuda", "cpu"] as const;

export type SpectralBackendPreference = (typeof SPECTRAL_BACKEND_PREFERENCES)[number];

export function isSpectralBackendPreference(
  value: unknown
): value is SpectralBackendPreference {
  return value === "auto" || value === "cuda" || value === "cpu";
}
