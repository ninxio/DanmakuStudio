import { getKnownBilibiliDuration } from "../danmaku/bilibiliAcquisition";
import type {
  MediaFamilyContext,
  MediaFamilyFile,
  MediaFamilyProject
} from "./mediaFamilyTypes";

/** Duration precedence shared by recognition and export; never scans comments or infers a tail. */
export function resolveFamilyDurations(
  project: MediaFamilyProject,
  context: MediaFamilyContext = {}
) {
  const media = new Map(project.mediaLibrary.map((item) => [item.id, item]));
  const bindings = new Map<string, Set<string>>();
  for (const binding of project.danmakuSourceBindings) {
    const sources = bindings.get(binding.assetId) ?? new Set<string>();
    sources.add(binding.sourceMediaId);
    bindings.set(binding.assetId, sources);
  }
  const result = new Map<string, Pick<MediaFamilyFile, "durationMs" | "durationSource">>();
  for (const asset of project.assets) {
    const sources = [...(bindings.get(asset.id) ?? [])];
    const explicit = context.assetDurationsMs?.[asset.id];
    const acquired = getKnownBilibiliDuration(asset);
    const bound =
      !asset.acquisition && sources.length === 1 ? media.get(sources[0])?.durationMs : null;
    result.set(
      asset.id,
      positive(explicit)
        ? { durationMs: explicit, durationSource: "explicit" }
        : positive(acquired)
          ? { durationMs: acquired, durationSource: "bilibili" }
          : positive(bound)
            ? { durationMs: bound, durationSource: "boundMedia" }
            : { durationMs: null, durationSource: "unknown" }
    );
  }
  return result;
}
function positive(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}
