import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAudioAlignmentProposal, type AudioFeatureFrame } from "./audioAlignment";

interface BenchmarkCut {
  completeStartFrame: number;
  lengthFrames: number;
}

interface BenchmarkTransientMismatch {
  sourceStartFrame: number;
  lengthFrames: number;
  completeOffsetFrames: number;
}

interface BenchmarkCase {
  id: string;
  title: string;
  frameCount: number;
  cuts: BenchmarkCut[];
  transientMismatches: BenchmarkTransientMismatch[];
  expectedGapsMs: number[];
}

interface BenchmarkFixture {
  version: 1;
  frameStepMs: number;
  cases: BenchmarkCase[];
}

const fixture = readBenchmarkFixture();

describe("对齐基准用例", () => {
  for (const benchmarkCase of fixture.cases) {
    it(`${benchmarkCase.id}：${benchmarkCase.title}`, () => {
      const complete = createPatternFrames(benchmarkCase.frameCount, fixture.frameStepMs);
      const source = createSourceFrames(complete, benchmarkCase, fixture.frameStepMs);

      const proposal = createAudioAlignmentProposal(complete, source, {
        matchThreshold: 0.35,
        minGapMs: 3000,
        anchorStride: 12
      });

      expect(proposal.cutCandidates.map((candidate) => candidate.targetGapMs)).toEqual(benchmarkCase.expectedGapsMs);
      expect(proposal.cutCandidates).toHaveLength(benchmarkCase.expectedGapsMs.length);
      expect(proposal.evidence?.algorithm).toBe(source.length >= 32 ? "time-map-audio" : "sparse-fingerprint");
    });
  }
});

function readBenchmarkFixture(): BenchmarkFixture {
  const content = readFileSync(join(process.cwd(), "fixtures", "alignment", "benchmark-cases.json"), "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (!isBenchmarkFixture(parsed)) {
    throw new Error("alignment benchmark fixture 格式不正确。");
  }
  return parsed;
}

function createSourceFrames(
  complete: AudioFeatureFrame[],
  benchmarkCase: BenchmarkCase,
  frameStepMs: number
): AudioFeatureFrame[] {
  const cutRanges = benchmarkCase.cuts.map((cut) => ({
    start: cut.completeStartFrame,
    end: cut.completeStartFrame + cut.lengthFrames
  }));
  const source = complete
    .filter((_, index) => !cutRanges.some((range) => index >= range.start && index < range.end))
    .map((frame, index) => ({
      timeMs: index * frameStepMs,
      values: frame.values
    }));
  for (const mismatch of benchmarkCase.transientMismatches) {
    for (let offset = 0; offset < mismatch.lengthFrames; offset += 1) {
      const sourceIndex = mismatch.sourceStartFrame + offset;
      const completeIndex = sourceIndex + mismatch.completeOffsetFrames;
      if (source[sourceIndex] && complete[completeIndex]) {
        source[sourceIndex] = {
          ...source[sourceIndex],
          values: complete[completeIndex].values
        };
      }
    }
  }
  return source;
}

function createPatternFrames(count: number, frameStepMs: number): AudioFeatureFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    timeMs: index * frameStepMs,
    values: [
      0.5 + Math.sin(index * 0.37) * 0.25,
      0.5 + Math.cos(index * 0.19) * 0.2,
      0.5 + Math.sin(index * 0.11 + 0.4) * 0.18,
      0.5 + Math.cos(index * 0.071 + 0.2) * 0.14
    ]
  }));
}

function isBenchmarkFixture(value: unknown): value is BenchmarkFixture {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    isPositiveInteger(value.frameStepMs) &&
    Array.isArray(value.cases) &&
    value.cases.every(isBenchmarkCase)
  );
}

function isBenchmarkCase(value: unknown): value is BenchmarkCase {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isPositiveInteger(value.frameCount) &&
    Array.isArray(value.cuts) &&
    value.cuts.every(isBenchmarkCut) &&
    Array.isArray(value.transientMismatches) &&
    value.transientMismatches.every(isBenchmarkTransientMismatch) &&
    Array.isArray(value.expectedGapsMs) &&
    value.expectedGapsMs.every(isNonNegativeInteger)
  );
}

function isBenchmarkCut(value: unknown): value is BenchmarkCut {
  return isRecord(value) && isNonNegativeInteger(value.completeStartFrame) && isPositiveInteger(value.lengthFrames);
}

function isBenchmarkTransientMismatch(value: unknown): value is BenchmarkTransientMismatch {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.sourceStartFrame) &&
    isPositiveInteger(value.lengthFrames) &&
    Number.isSafeInteger(value.completeOffsetFrames)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
