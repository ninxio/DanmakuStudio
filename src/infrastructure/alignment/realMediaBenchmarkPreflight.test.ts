import { describe, expect, it, vi } from "vitest";
import type {
  RealMediaBenchmarkGold,
  RealMediaBenchmarkManifest
} from "../../domain/alignment/realMediaBenchmark";
import type { MediaTimelineProbeResult } from "../media/tauriMediaProbe";
import { preflightRealMediaBenchmark } from "./realMediaBenchmarkPreflight";

describe("C137 真实媒体基准运行前核验", () => {
  it("重新核验全文件身份和清单指定的音视频流", async () => {
    const manifest = createManifest();
    const probe = vi.fn(({ path }: { path: string }) =>
      Promise.resolve(createProbe(path.includes("source") ? "a" : "b"))
    );

    const result = await preflightRealMediaBenchmark(manifest, { probe });

    expect(result).toEqual({
      ok: true,
      realRelationCount: 1,
      checkedFileCount: 2,
      issues: []
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("文件被替换或显式流不存在时阻断且不泄漏本地路径", async () => {
    const manifest = createManifest();
    const probe = vi.fn(() =>
      Promise.resolve({
        ...createProbe("c"),
        audioStreams: [],
        videoStreams: []
      })
    );

    const result = await preflightRealMediaBenchmark(manifest, { probe });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "audio-stream-missing",
      "identity-mismatch",
      "video-stream-missing",
      "audio-stream-missing",
      "identity-mismatch",
      "video-stream-missing"
    ]);
    expect(JSON.stringify(result)).not.toContain("C:\\private-benchmark");
  });

  it("manifest 本身无效时不读取任何本地媒体", async () => {
    const manifest = createManifest();
    manifest.cases[0].independentAnnotations = [];
    const probe = vi.fn(() => Promise.resolve(createProbe("a")));

    const result = await preflightRealMediaBenchmark(manifest, { probe });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("invalid-manifest");
    expect(result.checkedFileCount).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("探测器错误也会移除清单路径和 SHA-256", async () => {
    const manifest = createManifest();
    const source = manifest.cases[0].source;
    const probe = vi.fn(() =>
      Promise.reject(new Error(`无法读取 ${source.path}，identity=${source.contentIdentity?.digest}`))
    );

    const result = await preflightRealMediaBenchmark(manifest, { probe });
    const serialized = JSON.stringify(result);

    expect(result.ok).toBe(false);
    expect(result.issues.every((issue) => issue.code === "probe-failed")).toBe(true);
    expect(serialized).not.toContain(source.path);
    expect(serialized).not.toContain(source.contentIdentity?.digest);
    expect(serialized).toContain("原始工具错误已从可分享结果移除");
  });
});

function createManifest(): RealMediaBenchmarkManifest {
  const gold: RealMediaBenchmarkGold = {
    sourceStartMs: 0,
    sourceEndMs: 10_000,
    targetStartMs: 0,
    targetEndMs: 12_000,
    matchedAnchors: [
      { id: "a0", sourceMs: 0, targetMs: 0 },
      { id: "a1", sourceMs: 2_100, targetMs: 2_100 },
      { id: "a2", sourceMs: 4_100, targetMs: 4_100 },
      { id: "a3", sourceMs: 6_100, targetMs: 8_100 },
      { id: "a4", sourceMs: 8_100, targetMs: 10_100 }
    ],
    sourceOnlySpans: [],
    targetOnlySpans: [
      {
        kind: "targetOnly",
        sourceStartMs: 5_000,
        sourceEndMs: 5_000,
        targetStartMs: 5_000,
        targetEndMs: 7_000
      }
    ],
    ambiguousSpans: []
  };
  return {
    schemaVersion: 2,
    id: "preflight-test",
    name: "运行前核验测试",
    datasetVersion: "frozen-test-1",
    description: "只验证本地文件和流身份，不代表真实精度。",
    isExample: false,
    licenseNotes: ["程序构造测试。"],
    cases: [
      {
        id: "real-relation-1",
        title: "真实关系占位测试",
        mediaKind: "real",
        split: "frozen-test",
        scenarios: ["target-only"],
        source: createMedia("source", "a", 1_024),
        target: createMedia("target", "b", 1_024),
        boundaryToleranceMs: 100,
        versionNotes: ["固定测试版本。"],
        licenseNotes: ["本测试不包含实际媒体。"],
        independentAnnotations: [
          { reviewerId: "reviewer-alpha", gold: structuredClone(gold) },
          { reviewerId: "reviewer-beta", gold: structuredClone(gold) }
        ],
        adjudication: {
          status: "not-needed",
          adjudicatorId: null,
          note: "两份标注在 100ms 内一致。"
        },
        gold
      }
    ]
  };
}

function createMedia(side: "source" | "target", digest: string, sizeBytes: number) {
  return {
    path: `C:\\private-benchmark\\${side}.mkv`,
    audioStreamIndex: 1,
    videoStreamIndex: 0,
    contentIdentity: {
      algorithm: "sha256-full-file-v2" as const,
      sizeBytes,
      digest: digest.repeat(64)
    },
    versionNote: `${side} 固定版本`,
    licenseNote: "程序构造测试路径。"
  };
}

function createProbe(digest: string): MediaTimelineProbeResult {
  return {
    presentationOriginMs: 0,
    durationMs: 12_000,
    contentIdentity: {
      algorithm: "sha256-full-file-v2",
      sizeBytes: 1_024,
      modifiedUnixMs: 1,
      firstSampleDigest: digest.repeat(64),
      middleSampleDigest: digest.repeat(64),
      lastSampleDigest: digest.repeat(64)
    },
    videoStreams: [
      {
        index: 0,
        codec: "h264",
        startMs: 0,
        timelineOffsetMs: 0,
        durationMs: 12_000,
        timeBase: "1/90000",
        language: null,
        title: null,
        default: true,
        commentary: false,
        frameRate: 24
      }
    ],
    audioStreams: [
      {
        index: 1,
        codec: "aac",
        startMs: 0,
        timelineOffsetMs: 0,
        durationMs: 12_000,
        timeBase: "1/48000",
        language: "ja",
        title: null,
        default: true,
        commentary: false,
        sampleRate: 48_000,
        channels: 2
      }
    ],
    preferredAudioStreamIndex: 1
  };
}
