import { describe, expect, it, vi } from "vitest";
import { createEmptyProject } from "../../domain/project/factory";
import type {
  DanmakuSourceSegment,
  MediaContentIdentity,
  MediaTimeMap,
  ProjectMediaReference
} from "../../domain/project/types";
import type { MediaIdentityProbeInvoker } from "./tauriMediaProbe";
import { preflightProjectMediaIdentities } from "./mediaIdentityPreflight";

describe("export media identity preflight", () => {
  it("re-probes every referenced local file and accepts identical independent snapshots", async () => {
    const identity = createIdentity("a");
    const project = createPreflightProject(identity, identity);
    const probe = vi.fn<MediaIdentityProbeInvoker>(() => Promise.resolve(identity));

    const result = await preflightProjectMediaIdentities(project, { probe });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(Object.keys(result.currentIdentities).sort()).toEqual(["source", "target"]);
  });

  it("blocks when bytes behind an unchanged path have a different sampled digest", async () => {
    const analyzed = createIdentity("a");
    const replaced = createIdentity("b");
    const project = createPreflightProject(analyzed, analyzed);
    const probe = vi.fn<MediaIdentityProbeInvoker>((request) =>
      Promise.resolve(request.path.includes("source") ? replaced : analyzed)
    );

    const result = await preflightProjectMediaIdentities(project, { probe });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.mediaId === "source" && issue.message.includes("替换或修改")
      )
    ).toBe(true);
    expect(
      result.issues.some((issue) => issue.mediaId === "source" && issue.timeMapId === "map")
    ).toBe(true);
  });

  it("fails closed when the desktop probe cannot return a complete identity", async () => {
    const identity = createIdentity("a");
    const project = createPreflightProject(identity, identity);
    const probe = vi.fn<MediaIdentityProbeInvoker>(() =>
      Promise.resolve({ ...identity, firstSampleDigest: "not-a-digest" })
    );

    const result = await preflightProjectMediaIdentities(project, { probe });

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]?.message).toContain("未返回完整的内容身份");
  });

  it("accepts a v2 whole-file identity when only the diagnostic mtime changed", async () => {
    const analyzed = createIdentity("a");
    const copied = { ...analyzed, modifiedUnixMs: analyzed.modifiedUnixMs + 10_000 };
    const project = createPreflightProject(analyzed, analyzed);
    const probe = vi.fn<MediaIdentityProbeInvoker>(() => Promise.resolve(copied));

    const result = await preflightProjectMediaIdentities(project, { probe });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("caps identity-only preflight at four concurrent file reads", async () => {
    const identity = createIdentity("a");
    const projects = Array.from({ length: 3 }, (_, index) =>
      createPreflightProject(identity, identity, `-${index}`)
    );
    const project = {
      ...createEmptyProject("concurrency"),
      mediaLibrary: projects.flatMap((item) => item.mediaLibrary),
      mediaTimeMaps: projects.flatMap((item) => item.mediaTimeMaps),
      danmakuSourceSegments: projects.flatMap((item) => item.danmakuSourceSegments)
    };
    let active = 0;
    let maxActive = 0;
    const probe = vi.fn<MediaIdentityProbeInvoker>(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return identity;
    });

    const result = await preflightProjectMediaIdentities(project, { probe, concurrency: 99 });

    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);
  });
});

function createIdentity(seed: string): MediaContentIdentity {
  return {
    algorithm: "sha256-full-file-v2",
    sizeBytes: 100,
    modifiedUnixMs: 1_700_000_000_000,
    firstSampleDigest: seed.repeat(64),
    middleSampleDigest: seed.repeat(64),
    lastSampleDigest: seed.repeat(64)
  };
}

function createPreflightProject(
  sourceIdentity: MediaContentIdentity,
  targetIdentity: MediaContentIdentity,
  suffix = ""
) {
  const project = createEmptyProject("identity");
  const sourceId = `source${suffix}`;
  const targetId = `target${suffix}`;
  const mapId = `map${suffix}`;
  const source = createMedia(
    sourceId,
    "bilibiliReference",
    `C:\\media\\${sourceId}.mkv`,
    sourceIdentity
  );
  const target = createMedia(
    targetId,
    "targetOriginal",
    `C:\\media\\${targetId}.mkv`,
    targetIdentity
  );
  const timeMap: MediaTimeMap = {
    id: mapId,
    revision: 1,
    sourceMediaId: source.id,
    targetMediaId: target.id,
    sourceStream: null,
    targetStream: null,
    sourceIdentity: { ...sourceIdentity },
    targetIdentity: { ...targetIdentity },
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 0,
    targetEndMs: 10_000,
    spans: [
      {
        kind: "matched",
        sourceStartMs: 0,
        sourceEndMs: 10_000,
        targetStartMs: 0,
        targetEndMs: 10_000
      }
    ],
    quality: {
      level: "review",
      probability: null,
      metricSource: "measured",
      coverage: 1,
      p50ResidualMs: 0,
      p95ResidualMs: 0,
      maxResidualMs: 0,
      boundaryUncertaintyMs: 0,
      alternativeMargin: 1,
      anchorCount: 1,
      heldOutAnchorCount: 0,
      reasons: ["test"]
    },
    evidence: {
      types: ["audio"],
      audioAnchorCount: 1,
      visualAnchorCount: 0,
      heldOutAnchorCount: 0,
      notes: []
    },
    verification: null,
    engineVersion: "test",
    featureVersion: "test",
    parametersHash: "test",
    state: "confirmed",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    confirmedAt: project.updatedAt
  };
  const segment: DanmakuSourceSegment = {
    id: `segment${suffix}`,
    label: "segment",
    kind: "content",
    assetId: null,
    sourceMediaId: source.id,
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetMediaId: target.id,
    targetStartMs: 0,
    timingRules: [],
    timeMapId: timeMap.id,
    episodeKey: null,
    episodeLabel: null,
    note: "",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
  return {
    ...project,
    mediaLibrary: [source, target],
    mediaTimeMaps: [timeMap],
    danmakuSourceSegments: [segment]
  };
}

function createMedia(
  id: string,
  role: ProjectMediaReference["role"],
  localPath: string,
  contentIdentity: MediaContentIdentity
): ProjectMediaReference {
  return {
    id,
    role,
    name: id,
    fileName: `${id}.mkv`,
    objectUrl: null,
    durationMs: 10_000,
    contentIdentity: { ...contentIdentity },
    referenceKind: "localPath",
    connectionState: "connected",
    sourceSummary: "test",
    localPath,
    emby: null,
    episodeKey: null,
    episodeLabel: null,
    audioTrackIntent: { mode: "auto" },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z"
  };
}
