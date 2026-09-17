import {
  isSpectralBackendPreference,
  type SpectralBackendPreference
} from "../alignment/spectralBackendPreference";
export interface WorkflowDefaults {
  downloadAudio: boolean;
  provider: "ext" | "nyaa";
  spectralBackend: SpectralBackendPreference;
  windowMs: number;
  minGapMs: number;
  matchThreshold: number;
}
export interface WorkflowPreset {
  id: string;
  name: string;
  defaults: WorkflowDefaults;
}
export function isWorkflowDefaults(v: unknown): v is WorkflowDefaults {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  return (
    Object.keys(x).every((k) =>
      [
        "downloadAudio",
        "provider",
        "spectralBackend",
        "windowMs",
        "minGapMs",
        "matchThreshold"
      ].includes(k)
    ) &&
    typeof x.downloadAudio === "boolean" &&
    (x.provider === "ext" || x.provider === "nyaa") &&
    isSpectralBackendPreference(x.spectralBackend) &&
    Number.isSafeInteger(x.windowMs) &&
    Number(x.windowMs) > 0 &&
    Number.isSafeInteger(x.minGapMs) &&
    Number(x.minGapMs) >= 0 &&
    typeof x.matchThreshold === "number" &&
    Number.isFinite(x.matchThreshold) &&
    x.matchThreshold > 0
  );
}
export function readWorkflowPresets(v: unknown): WorkflowPreset[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((value: unknown): value is WorkflowPreset => {
      if (!value || typeof value !== "object") return false;
      const x = value as Record<string, unknown>;
      return (
        Object.keys(x).every((k) => ["id", "name", "defaults"].includes(k)) &&
        typeof x.id === "string" &&
        x.id.length <= 128 &&
        typeof x.name === "string" &&
        x.name.trim().length > 0 &&
        x.name.length <= 100 &&
        isWorkflowDefaults(x.defaults)
      );
    })
    .slice(0, 50)
    .map((x) => structuredClone(x));
}
