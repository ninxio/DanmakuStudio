import { areMediaContentIdentitiesEqual, isMediaContentIdentity } from "../../domain/project/mediaIdentity";
import type { EditorProject, MediaContentIdentity, MediaTimeMap } from "../../domain/project/types";
import {
  probeTauriMediaIdentity,
  type MediaIdentityProbeInvoker,
  type TauriMediaIdentityProbeRequest
} from "./tauriMediaProbe";

export interface MediaIdentityPreflightIssue {
  mediaId: string;
  timeMapId: string | null;
  message: string;
}

export interface MediaIdentityPreflightResult {
  ok: boolean;
  issues: MediaIdentityPreflightIssue[];
  currentIdentities: Record<string, MediaContentIdentity>;
}

export interface MediaIdentityPreflightOptions {
  ffmpegPath?: string | null;
  ffprobePath?: string | null;
  probe?: MediaIdentityProbeInvoker;
  concurrency?: number;
}

/**
 * Re-reads every local file used by an exportable confirmed map immediately before export.
 * A path alone is never considered sufficient: both the media-library snapshot and the
 * independently confirmed map snapshot must equal the freshly measured identity.
 */
export async function preflightProjectMediaIdentities(
  project: EditorProject,
  options: MediaIdentityPreflightOptions = {}
): Promise<MediaIdentityPreflightResult> {
  const referencedMapIds = new Set(
    project.danmakuSourceSegments.flatMap((segment) =>
      segment.kind === "content" && segment.timeMapId ? [segment.timeMapId] : []
    )
  );
  const maps = project.mediaTimeMaps.filter(
    (timeMap) => timeMap.state === "confirmed" && referencedMapIds.has(timeMap.id)
  );
  const mediaById = new Map(project.mediaLibrary.map((media) => [media.id, media]));
  const mapBindingsByMediaId = collectMapBindings(maps);
  const issues: MediaIdentityPreflightIssue[] = [];
  const currentIdentities: Record<string, MediaContentIdentity> = {};

  const entries = [...mapBindingsByMediaId.entries()];
  const concurrency = Math.min(4, Math.max(2, options.concurrency ?? 3));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (nextIndex < entries.length) {
        const entryIndex = nextIndex;
        nextIndex += 1;
        const entry = entries[entryIndex];
        if (!entry) {
          continue;
        }
        const [mediaId, bindings] = entry;
        const media = mediaById.get(mediaId);
        if (!media?.localPath?.trim() || media.connectionState !== "connected") {
          issues.push({
            mediaId,
            timeMapId: bindings[0]?.timeMap.id ?? null,
            message: `${media?.name ?? mediaId} 没有已连接的本地路径，无法在导出前核验文件身份。`
          });
          continue;
        }
        let identity: MediaContentIdentity;
        try {
          const request: TauriMediaIdentityProbeRequest = { path: media.localPath };
          const measuredIdentity = await probeTauriMediaIdentity(request, options.probe);
          if (!isMediaContentIdentity(measuredIdentity)) {
            throw new Error("媒体探测未返回完整的内容身份");
          }
          identity = measuredIdentity;
          currentIdentities[mediaId] = { ...identity };
        } catch (error: unknown) {
          issues.push({
            mediaId,
            timeMapId: bindings[0]?.timeMap.id ?? null,
            message: `${media.name} 的导出前身份核验失败：${formatFailure(error)}`
          });
          continue;
        }

        if (!areMediaContentIdentitiesEqual(media.contentIdentity, identity)) {
          issues.push({
            mediaId,
            timeMapId: bindings[0]?.timeMap.id ?? null,
            message: `${media.name} 已在分析后被替换或修改，媒体库身份快照已失效。`
          });
        }
        for (const binding of bindings) {
          const mapIdentity = binding.side === "source"
            ? binding.timeMap.sourceIdentity
            : binding.timeMap.targetIdentity;
          if (!areMediaContentIdentitiesEqual(mapIdentity, identity)) {
            issues.push({
              mediaId,
              timeMapId: binding.timeMap.id,
              message: `${media.name} 与确认时间图 ${binding.timeMap.id} 的文件身份不一致，必须重新分析。`
            });
          }
        }
      }
    })
  );

  return { ok: issues.length === 0, issues, currentIdentities };
}

interface MapBinding {
  timeMap: MediaTimeMap;
  side: "source" | "target";
}

function collectMapBindings(maps: readonly MediaTimeMap[]): Map<string, MapBinding[]> {
  const result = new Map<string, MapBinding[]>();
  for (const timeMap of maps) {
    appendBinding(result, timeMap.sourceMediaId, { timeMap, side: "source" });
    appendBinding(result, timeMap.targetMediaId, { timeMap, side: "target" });
  }
  return result;
}

function appendBinding(
  result: Map<string, MapBinding[]>,
  mediaId: string,
  binding: MapBinding
): void {
  result.set(mediaId, [...(result.get(mediaId) ?? []), binding]);
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
