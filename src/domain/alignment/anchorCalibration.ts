import type { SyncAnchor } from "../danmaku/types";
import type { Milliseconds } from "../shared/time";
import { clampMilliseconds } from "../shared/time";
import type { AlignmentProposal, CutCandidate } from "./types";

export interface ParsedAnchorCalibration {
  anchors: SyncAnchor[];
  warnings: string[];
}

export interface AnchorCalibrationOptions {
  minGapMs?: Milliseconds;
}

const DEFAULT_MIN_GAP_MS = 1000;

export function parseAnchorCalibrationText(text: string): ParsedAnchorCalibration {
  const anchors: SyncAnchor[] = [];
  const warnings: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  lines.forEach((line, index) => {
    const parts = line.split(/\s*(?:->|=>|→|,|，|\t)\s*/).filter((part) => part.length > 0);
    if (parts.length !== 2) {
      warnings.push(`第 ${index + 1} 行需要写成“当前视频时间 -> 完整版时间”：${line}`);
      return;
    }
    const sourceMs = parseAnchorTimecode(parts[0]);
    const targetMs = parseAnchorTimecode(parts[1]);
    if (sourceMs === null || targetMs === null) {
      warnings.push(`第 ${index + 1} 行时间格式无法识别：${line}`);
      return;
    }
    anchors.push({
      id: `manual-anchor-${index + 1}`,
      sourceMs,
      targetMs,
      confidence: 1,
      origin: "manual"
    });
  });

  return { anchors: anchors.sort(compareAnchors), warnings };
}

export function createAnchorCalibrationProposal(
  text: string,
  options: AnchorCalibrationOptions = {}
): AlignmentProposal {
  const parsed = parseAnchorCalibrationText(text);
  const minGapMs = clampMilliseconds(options.minGapMs ?? DEFAULT_MIN_GAP_MS);
  const cutCandidates = inferCutCandidatesFromAnchors(parsed.anchors, minGapMs);
  const diagnostics = [...parsed.warnings];
  if (parsed.anchors.length < 2) {
    diagnostics.push("至少需要两个锚点才能推断中间缺失时长。");
  } else if (cutCandidates.length === 0) {
    diagnostics.push(`相邻锚点之间没有超过 ${minGapMs} ms 的新增缺失时长。`);
  } else {
    diagnostics.push(`已根据 ${parsed.anchors.length} 个锚点推断 ${cutCandidates.length} 个候选版本差异。`);
  }
  return {
    anchors: parsed.anchors,
    cutCandidates,
    confidence: cutCandidates.length > 0 ? 0.72 : 0.35,
    diagnostics
  };
}

export function inferCutCandidatesFromAnchors(anchors: SyncAnchor[], minGapMs = DEFAULT_MIN_GAP_MS): CutCandidate[] {
  const sortedAnchors = [...anchors].sort(compareAnchors);
  const candidates: CutCandidate[] = [];
  for (let index = 1; index < sortedAnchors.length; index += 1) {
    const previous = sortedAnchors[index - 1];
    const current = sortedAnchors[index];
    const previousGap = previous.targetMs - previous.sourceMs;
    const currentGap = current.targetMs - current.sourceMs;
    const missingDurationMs = Math.round(currentGap - previousGap);
    if (missingDurationMs < minGapMs) {
      continue;
    }
    candidates.push({
      id: `anchor-gap-${index}`,
      name: `锚点推断差异 ${index}`,
      sourceAtMs: clampMilliseconds(current.sourceMs),
      targetGapMs: missingDurationMs,
      confidence: 0.72,
      note: `由锚点 ${formatDuration(previous.sourceMs)} -> ${formatDuration(previous.targetMs)} 与 ${formatDuration(current.sourceMs)} -> ${formatDuration(current.targetMs)} 推断。`
    });
  }
  return candidates;
}

function parseAnchorTimecode(value: string): Milliseconds | null {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const parsedParts = parts.map((part) => Number(part));
  if (parsedParts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  const [hours, minutes, seconds] =
    parsedParts.length === 3 ? parsedParts : [0, parsedParts[0], parsedParts[1]];
  if ((parsedParts.length === 3 && minutes >= 60) || seconds >= 60) {
    return null;
  }
  return clampMilliseconds((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function compareAnchors(left: SyncAnchor, right: SyncAnchor): number {
  return left.sourceMs - right.sourceMs || left.targetMs - right.targetMs || left.id.localeCompare(right.id);
}

function formatDuration(milliseconds: Milliseconds): string {
  const safe = clampMilliseconds(milliseconds);
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
