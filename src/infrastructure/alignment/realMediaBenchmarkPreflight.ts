import type {
  RealMediaBenchmarkCase,
  RealMediaBenchmarkContentIdentity,
  RealMediaBenchmarkManifest,
  RealMediaBenchmarkMediaInput
} from "../../domain/alignment/realMediaBenchmark";
import { validateRealMediaBenchmarkManifest } from "../../domain/alignment/realMediaBenchmark";
import type { MediaContentIdentity } from "../../domain/project/types";
import {
  probeTauriMediaTimeline,
  type MediaTimelineProbeInvoker,
  type MediaTimelineProbeResult
} from "../media/tauriMediaProbe";

export type BenchmarkMediaSide = "source" | "target";
export type RealMediaBenchmarkPreflightIssueCode =
  | "invalid-manifest"
  | "probe-failed"
  | "identity-mismatch"
  | "audio-stream-missing"
  | "video-stream-missing";

export interface RealMediaBenchmarkPreflightIssue {
  caseId: string | null;
  side: BenchmarkMediaSide | null;
  code: RealMediaBenchmarkPreflightIssueCode;
  message: string;
}

export interface RealMediaBenchmarkPreflightResult {
  ok: boolean;
  realRelationCount: number;
  checkedFileCount: number;
  issues: RealMediaBenchmarkPreflightIssue[];
}

export interface RealMediaBenchmarkPreflightOptions {
  ffprobePath?: string | null;
  ffmpegPath?: string | null;
  probe?: MediaTimelineProbeInvoker;
  concurrency?: number;
  signal?: AbortSignal;
}

interface BenchmarkMediaBinding {
  benchmarkCase: RealMediaBenchmarkCase;
  side: BenchmarkMediaSide;
  media: RealMediaBenchmarkMediaInput;
}

/**
 * Re-probes every unique local file before a benchmark run. Results deliberately omit paths and
 * measured hashes so a shareable report cannot leak the operator's local benchmark library.
 */
export async function preflightRealMediaBenchmark(
  manifest: RealMediaBenchmarkManifest,
  options: RealMediaBenchmarkPreflightOptions = {}
): Promise<RealMediaBenchmarkPreflightResult> {
  throwIfPreflightAborted(options.signal);
  const validation = validateRealMediaBenchmarkManifest(manifest);
  if (!validation.valid) {
    return {
      ok: false,
      realRelationCount: 0,
      checkedFileCount: 0,
      issues: validation.issues.map((message) => ({
        caseId: null,
        side: null,
        code: "invalid-manifest" as const,
        message
      }))
    };
  }

  const realCases = manifest.cases.filter((benchmarkCase) => benchmarkCase.mediaKind === "real");
  const bindings: BenchmarkMediaBinding[] = realCases.flatMap((benchmarkCase) => [
    { benchmarkCase, side: "source", media: benchmarkCase.source },
    { benchmarkCase, side: "target", media: benchmarkCase.target }
  ]);
  const bindingsByPath = new Map<string, BenchmarkMediaBinding[]>();
  for (const binding of bindings) {
    bindingsByPath.set(binding.media.path, [
      ...(bindingsByPath.get(binding.media.path) ?? []),
      binding
    ]);
  }

  const entries = [...bindingsByPath.entries()];
  const issues: RealMediaBenchmarkPreflightIssue[] = [];
  const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 2));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      while (cursor < entries.length) {
        throwIfPreflightAborted(options.signal);
        const index = cursor;
        cursor += 1;
        const entry = entries[index];
        if (!entry) {
          continue;
        }
        const [path, pathBindings] = entry;
        let probe: MediaTimelineProbeResult;
        try {
          probe = await probeTauriMediaTimeline(
            { path, ffprobePath: options.ffprobePath, ffmpegPath: options.ffmpegPath },
            options.probe
          );
          throwIfPreflightAborted(options.signal);
        } catch {
          throwIfPreflightAborted(options.signal);
          for (const binding of pathBindings) {
            issues.push(
              createIssue(
                binding,
                "probe-failed",
                "媒体探测失败，无法核验冻结清单；原始工具错误已从可分享结果移除。"
              )
            );
          }
          continue;
        }
        for (const binding of pathBindings) {
          validateBindingAgainstProbe(binding, probe, issues);
        }
      }
    })
  );

  issues.sort(
    (left, right) =>
      (left.caseId ?? "").localeCompare(right.caseId ?? "") ||
      (left.side ?? "").localeCompare(right.side ?? "") ||
      left.code.localeCompare(right.code)
  );
  return {
    ok: issues.length === 0,
    realRelationCount: realCases.length,
    checkedFileCount: entries.length,
    issues
  };
}

function throwIfPreflightAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("真实媒体基准预检已取消。");
  }
}

function validateBindingAgainstProbe(
  binding: BenchmarkMediaBinding,
  probe: MediaTimelineProbeResult,
  issues: RealMediaBenchmarkPreflightIssue[]
): void {
  const expectedIdentity = binding.media.contentIdentity;
  if (
    expectedIdentity === null ||
    probe.contentIdentity === null ||
    !matchesBenchmarkIdentity(expectedIdentity, probe.contentIdentity)
  ) {
    issues.push(
      createIssue(
        binding,
        "identity-mismatch",
        "当前文件与冻结清单记录的全文件 SHA-256 不一致，禁止计入评测。"
      )
    );
  }
  if (!probe.audioStreams.some((stream) => stream.index === binding.media.audioStreamIndex)) {
    issues.push(
      createIssue(
        binding,
        "audio-stream-missing",
        `冻结清单指定的音轨 ${binding.media.audioStreamIndex} 不存在。`
      )
    );
  }
  if (
    binding.media.videoStreamIndex !== null &&
    !probe.videoStreams.some((stream) => stream.index === binding.media.videoStreamIndex)
  ) {
    issues.push(
      createIssue(
        binding,
        "video-stream-missing",
        `冻结清单指定的视频流 ${binding.media.videoStreamIndex} 不存在。`
      )
    );
  }
}

function matchesBenchmarkIdentity(
  expected: RealMediaBenchmarkContentIdentity,
  actual: MediaContentIdentity
): boolean {
  if (actual.algorithm !== expected.algorithm || actual.sizeBytes !== expected.sizeBytes) {
    return false;
  }
  const normalized = expected.digest.toLowerCase();
  return (
    actual.firstSampleDigest.toLowerCase() === normalized &&
    actual.middleSampleDigest.toLowerCase() === normalized &&
    actual.lastSampleDigest.toLowerCase() === normalized
  );
}

function createIssue(
  binding: BenchmarkMediaBinding,
  code: RealMediaBenchmarkPreflightIssueCode,
  message: string
): RealMediaBenchmarkPreflightIssue {
  return {
    caseId: binding.benchmarkCase.id,
    side: binding.side,
    code,
    message
  };
}
