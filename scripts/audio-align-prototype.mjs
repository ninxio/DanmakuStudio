import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_SAMPLE_RATE = 8000;
const DEFAULT_WINDOW_MS = 1000;
const DEFAULT_MATCH_THRESHOLD = 0.18;
const DEFAULT_MIN_GAP_MS = 1000;
const DEFAULT_MAX_CELLS = 16_000_000;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const completeFrames = loadFeatureFrames(args, "complete");
  const sourceFrames = loadFeatureFrames(args, "source");
  const proposal = createAudioAlignmentProposal(completeFrames, sourceFrames, {
    matchThreshold: numberArg(args["match-threshold"], DEFAULT_MATCH_THRESHOLD),
    minGapMs: numberArg(args["min-gap-ms"], DEFAULT_MIN_GAP_MS),
    maxCells: numberArg(args["max-cells"], DEFAULT_MAX_CELLS)
  });
  const output = `${JSON.stringify(proposal, null, 2)}\n`;
  if (typeof args.out === "string") {
    writeFileSync(args.out, output, "utf8");
    console.log(`已输出音频对齐提案：${args.out}`);
  } else {
    process.stdout.write(output);
  }
}

function loadFeatureFrames(args, side) {
  const featurePath = args[`${side}-features`];
  if (typeof featurePath === "string") {
    return readFeatureFrames(featurePath);
  }
  const videoPath = args[side];
  if (typeof videoPath !== "string") {
    throw new Error(`缺少 --${side} 视频路径或 --${side}-features 特征文件。`);
  }
  return extractAudioFeatures(videoPath, {
    ffmpegPath: typeof args.ffmpeg === "string" ? args.ffmpeg : "ffmpeg",
    sampleRate: numberArg(args["sample-rate"], DEFAULT_SAMPLE_RATE),
    windowMs: numberArg(args["window-ms"], DEFAULT_WINDOW_MS)
  });
}

function readFeatureFrames(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  const frames = Array.isArray(parsed) ? parsed : parsed.frames;
  if (!Array.isArray(frames)) {
    throw new Error(`${filePath} 不是有效的音频特征 JSON。`);
  }
  return frames.map((frame, index) => {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof frame.timeMs !== "number" ||
      !Array.isArray(frame.values) ||
      !frame.values.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error(`${filePath} 第 ${index + 1} 帧格式不正确。`);
    }
    return {
      timeMs: Math.max(0, Math.round(frame.timeMs)),
      values: frame.values
    };
  });
}

function extractAudioFeatures(videoPath, options) {
  const result = spawnSync(
    options.ffmpegPath,
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(options.sampleRate),
      "-f",
      "f32le",
      "pipe:1"
    ],
    {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`FFmpeg 提取音频失败：${result.stderr.toString("utf8")}`);
  }
  return pcmToFeatureFrames(result.stdout, {
    sampleRate: options.sampleRate,
    windowMs: options.windowMs,
    label: basename(videoPath)
  });
}

function pcmToFeatureFrames(buffer, options) {
  const frameSamples = Math.max(1, Math.round((options.sampleRate * options.windowMs) / 1000));
  const sampleCount = Math.floor(buffer.length / 4);
  const frames = [];
  for (let offset = 0; offset + frameSamples <= sampleCount; offset += frameSamples) {
    let squareSum = 0;
    let crossingCount = 0;
    let previous = 0;
    for (let index = 0; index < frameSamples; index += 1) {
      const sample = buffer.readFloatLE((offset + index) * 4);
      squareSum += sample * sample;
      if (index > 0 && (sample >= 0) !== (previous >= 0)) {
        crossingCount += 1;
      }
      previous = sample;
    }
    const rms = Math.sqrt(squareSum / frameSamples);
    const zeroCrossingRate = crossingCount / frameSamples;
    frames.push({
      timeMs: Math.round((offset / options.sampleRate) * 1000),
      values: [Math.min(1, rms * 8), Math.min(1, zeroCrossingRate * 12)]
    });
  }
  if (frames.length === 0) {
    throw new Error(`${options.label} 未能提取到可用音频特征。`);
  }
  return frames;
}

function createAudioAlignmentProposal(completeFrames, sourceFrames, options) {
  if (completeFrames.length === 0 || sourceFrames.length === 0) {
    return {
      anchors: [],
      cutCandidates: [],
      confidence: 0,
      diagnostics: ["音频特征为空，无法对齐。"]
    };
  }
  const matches = alignFeatureSequences(completeFrames, sourceFrames, options);
  const cutCandidates = inferCutCandidates(matches, options);
  const coverage = matches.length / Math.max(1, sourceFrames.length);
  return {
    anchors: createAnchors(matches, options.matchThreshold),
    cutCandidates,
    confidence: clampNumber(coverage, 0, 1),
    diagnostics: [
      `音频特征匹配 ${matches.length} / ${sourceFrames.length} 帧，覆盖率 ${Math.round(coverage * 100)}%。`,
      cutCandidates.length > 0
        ? `已推断 ${cutCandidates.length} 个候选缺失段。`
        : "未发现超过阈值的候选缺失段。"
    ]
  };
}

function alignFeatureSequences(completeFrames, sourceFrames, options) {
  const width = sourceFrames.length + 1;
  const cellCount = (completeFrames.length + 1) * width;
  if (cellCount > options.maxCells) {
    throw new Error(`音频特征数量过多：${cellCount} 个 DP 单元，请增大 --window-ms 或 --max-cells。`);
  }
  let previous = new Float64Array(width);
  let current = new Float64Array(width);
  const directions = new Uint8Array(cellCount);
  for (let completeIndex = 1; completeIndex <= completeFrames.length; completeIndex += 1) {
    current = new Float64Array(width);
    for (let sourceIndex = 1; sourceIndex <= sourceFrames.length; sourceIndex += 1) {
      const distance = getFeatureDistance(completeFrames[completeIndex - 1], sourceFrames[sourceIndex - 1]);
      const matchScore =
        distance <= options.matchThreshold ? 1 - distance / options.matchThreshold : Number.NEGATIVE_INFINITY;
      const skipCompleteScore = previous[sourceIndex];
      const skipSourceScore = current[sourceIndex - 1];
      const matchedScore = previous[sourceIndex - 1] + matchScore;
      const cellOffset = completeIndex * width + sourceIndex;
      if (matchedScore >= skipCompleteScore && matchedScore >= skipSourceScore) {
        current[sourceIndex] = matchedScore;
        directions[cellOffset] = 3;
      } else if (skipCompleteScore >= skipSourceScore) {
        current[sourceIndex] = skipCompleteScore;
        directions[cellOffset] = 1;
      } else {
        current[sourceIndex] = skipSourceScore;
        directions[cellOffset] = 2;
      }
    }
    previous = current;
  }
  return backtrackMatches(completeFrames, sourceFrames, directions);
}

function backtrackMatches(completeFrames, sourceFrames, directions) {
  const width = sourceFrames.length + 1;
  const matches = [];
  let completeIndex = completeFrames.length;
  let sourceIndex = sourceFrames.length;
  while (completeIndex > 0 && sourceIndex > 0) {
    const direction = directions[completeIndex * width + sourceIndex];
    if (direction === 3) {
      const completeFrame = completeFrames[completeIndex - 1];
      const sourceFrame = sourceFrames[sourceIndex - 1];
      matches.push({
        completeTimeMs: completeFrame.timeMs,
        sourceTimeMs: sourceFrame.timeMs,
        distance: getFeatureDistance(completeFrame, sourceFrame)
      });
      completeIndex -= 1;
      sourceIndex -= 1;
    } else if (direction === 1) {
      completeIndex -= 1;
    } else {
      sourceIndex -= 1;
    }
  }
  return matches.reverse();
}

function inferCutCandidates(matches, options) {
  const candidates = [];
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    const missingDurationMs =
      current.completeTimeMs - previous.completeTimeMs - (current.sourceTimeMs - previous.sourceTimeMs);
    if (missingDurationMs < options.minGapMs) {
      continue;
    }
    candidates.push({
      id: `audio-gap-${candidates.length + 1}`,
      name: `音频推断补偿 ${candidates.length + 1}`,
      sourceAtMs: Math.max(0, Math.round(current.sourceTimeMs)),
      targetGapMs: Math.round(missingDurationMs),
      confidence: clampNumber(
        1 - (previous.distance + current.distance) / (2 * options.matchThreshold),
        0.1,
        0.95
      ),
      note: `音频对齐显示完整片源比删减版多出约 ${formatDuration(missingDurationMs)}。`
    });
  }
  return candidates;
}

function createAnchors(matches, matchThreshold) {
  return matches
    .filter((_, index) => index % 8 === 0 || index === matches.length - 1)
    .map((match, index) => ({
      id: `audio-anchor-${index + 1}`,
      sourceMs: Math.max(0, Math.round(match.sourceTimeMs)),
      targetMs: Math.max(0, Math.round(match.completeTimeMs)),
      confidence: clampNumber(1 - match.distance / matchThreshold, 0, 1),
      origin: "automatic"
    }));
}

function getFeatureDistance(left, right) {
  const width = Math.max(left.values.length, right.values.length);
  if (width === 0) {
    return 1;
  }
  let total = 0;
  for (let index = 0; index < width; index += 1) {
    const delta = (left.values[index] ?? 0) - (right.values[index] ?? 0);
    total += delta * delta;
  }
  return Math.sqrt(total / width);
}

function parseArgs(rawArgs) {
  const args = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function numberArg(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`数字参数无效：${value}`);
  }
  return parsed;
}

function formatDuration(milliseconds) {
  const safe = Math.max(0, Math.round(milliseconds));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function printUsage() {
  console.log(`用法：
  corepack pnpm align:audio -- --complete full.mp4 --source cut.mp4 --out outputs/alignment-proposal.json
  corepack pnpm align:audio -- --complete-features fixtures/alignment/audio-complete-features.json --source-features fixtures/alignment/audio-source-features.json

参数：
  --complete              完整片源本地视频路径
  --source                被删减版本地视频路径
  --complete-features     完整片源音频特征 JSON
  --source-features       被删减版音频特征 JSON
  --out                   输出 AlignmentProposal JSON 文件
  --ffmpeg                FFmpeg 可执行文件路径，默认 ffmpeg
  --window-ms             音频特征窗口，默认 1000
  --match-threshold       特征匹配阈值，默认 0.18
  --min-gap-ms            最小候选缺失时长，默认 1000
`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
