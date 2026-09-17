import type { SpectralBackendPreference } from "../domain/alignment/spectralBackendPreference";
import type { AlignmentExperimentQueue } from "../domain/alignment/alignmentExperimentQueue";
export interface MatchingDefaults {
  spectralBackend: SpectralBackendPreference;
  windowMs: number;
  minGapMs: number;
  matchThreshold: number;
}
/** A resumed attempt retains its frozen parameters; presets only configure a new attempt. */
export function resolveMatchingDefaults(
  settings: MatchingDefaults,
  panelChoice: SpectralBackendPreference,
  queue: AlignmentExperimentQueue | null
): MatchingDefaults {
  const source =
    queue?.state === "interrupted"
      ? queue.config
      : { ...settings, spectralBackend: panelChoice };
  return {
    spectralBackend: source.spectralBackend,
    windowMs: source.windowMs,
    minGapMs: source.minGapMs,
    matchThreshold: source.matchThreshold
  };
}
