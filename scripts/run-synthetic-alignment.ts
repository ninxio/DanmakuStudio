import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseRealMediaBenchmarkManifestJson } from "../src/domain/alignment/realMediaBenchmark";
import {
  runSyntheticAlignmentManifest,
  serializeSyntheticAlignmentRunReport
} from "../src/infrastructure/alignment/syntheticAlignmentRunner";
import type {
  AudioAlignmentJobInvoker,
  AudioAlignmentJobSnapshot,
  NormalizedTauriAudioAlignmentRequest
} from "../src/infrastructure/alignment/tauriAudioAlignment";
import type { AlignmentProposal } from "../src/domain/alignment/types";
import type { SpectralBackendPreference } from "../src/domain/alignment/spectralBackendPreference";

interface CliOptions {
  manifestPath: string;
  outputPath: string;
  binaryPath: string;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  spectralBackend: SpectralBackendPreference;
  windowMs: number;
  minGapMs: number;
  matchThreshold: number;
}

const HELP = `Usage:
  corepack pnpm synthetic:run -- --manifest <synthetic-manifest.json> --output <report.json> [options]

Options:
  --binary <path>             alignment_headless executable
  --ffmpeg <path>             FFmpeg executable (default: PATH)
  --ffprobe <path>            FFprobe executable (default: inferred from FFmpeg)
  --spectral-backend <mode>   auto | cpu | cuda (default: auto)
  --window-ms <integer>       production feature window (default: 1000)
  --min-gap-ms <integer>      production minimum edit gap (default: 3000)
  --match-threshold <number>  production match threshold (default: 0.35)

The output is development-only synthetic evidence. It never creates Gold or release permission.
`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await assertReadableFile(options.manifestPath, "synthetic manifest");
  await assertReadableFile(options.binaryPath, "alignment_headless binary");
  await assertOutputDoesNotExist(options.outputPath);
  const manifest = parseRealMediaBenchmarkManifestJson(
    await readFile(options.manifestPath, "utf8")
  );
  const abortController = new AbortController();
  const handleSignal = () => abortController.abort();
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    const report = await runSyntheticAlignmentManifest(manifest, {
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      spectralBackend: options.spectralBackend,
      windowMs: options.windowMs,
      minGapMs: options.minGapMs,
      matchThreshold: options.matchThreshold,
      signal: abortController.signal,
      invoker: createHeadlessInvoker(options.binaryPath, abortController.signal),
      onProgress: (completed, total, caseId) => {
        process.stderr.write(`[synthetic] ${completed}/${total} ${caseId}\n`);
      }
    });
    await writeImmutableText(options.outputPath, serializeSyntheticAlignmentRunReport(report));
    process.stdout.write(
      `${JSON.stringify({
        ok: report.status === "completed",
        status: report.status,
        caseCount: report.caseReceipts.length,
        completedCount: report.caseReceipts.filter((item) => item.state === "completed").length,
        failedCount: report.caseReceipts.filter((item) => item.state === "failed").length,
        outputPath: options.outputPath
      })}\n`
    );
    if (report.status !== "completed") process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

function createHeadlessInvoker(
  binaryPath: string,
  signal: AbortSignal
): AudioAlignmentJobInvoker {
  const jobs = new Map<string, AudioAlignmentJobSnapshot>();
  let sequence = 0;
  return {
    async start(request) {
      sequence += 1;
      const jobId = `headless-${sequence}`;
      const startedAtMs = Date.now();
      try {
        const proposal = await runHeadlessProcess(binaryPath, request, signal);
        const snapshot = terminalSnapshot(jobId, "completed", proposal, null, startedAtMs);
        jobs.set(jobId, snapshot);
        return snapshot;
      } catch (cause: unknown) {
        const error = formatError(cause);
        const status = signal.aborted ? "cancelled" : "failed";
        process.stderr.write(`[headless] ${jobId} ${error}\n`);
        const snapshot = terminalSnapshot(jobId, status, null, error, startedAtMs);
        jobs.set(jobId, snapshot);
        return snapshot;
      }
    },
    get(jobId) {
      return Promise.resolve(requireJob(jobs, jobId));
    },
    cancel(jobId) {
      return Promise.resolve(requireJob(jobs, jobId));
    }
  };
}

function terminalSnapshot(
  jobId: string,
  status: "completed" | "failed" | "cancelled",
  proposal: AlignmentProposal | null,
  error: string | null,
  updatedAtMs: number
): AudioAlignmentJobSnapshot {
  return {
    jobId,
    status,
    progress: 1,
    message:
      status === "completed"
        ? "无界面 production 对齐完成。"
        : status === "cancelled"
          ? "无界面 production 对齐已取消。"
          : "无界面 production 对齐失败。",
    stageKey: status,
    stageLabel: status,
    stageIndex: 1,
    stageCount: 1,
    stageProgress: 1,
    logs: [],
    proposal,
    error,
    updatedAtMs
  };
}

function requireJob(
  jobs: Map<string, AudioAlignmentJobSnapshot>,
  jobId: string
): AudioAlignmentJobSnapshot {
  const snapshot = jobs.get(jobId);
  if (!snapshot) throw new Error(`未找到无界面对齐任务：${jobId}`);
  return snapshot;
}

function runHeadlessProcess(
  binaryPath: string,
  request: NormalizedTauriAudioAlignmentRequest,
  signal: AbortSignal
): Promise<AlignmentProposal> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binaryPath, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (code) => {
      finish(() => {
        const errorText = Buffer.concat(stderr).toString("utf8").trim();
        if (signal.aborted) {
          rejectPromise(new Error("用户取消了无界面 production 对齐。"));
          return;
        }
        if (code !== 0) {
          rejectPromise(
            new Error(
              `alignment_headless 退出码 ${code ?? "unknown"}${errorText ? `：${errorText}` : ""}`
            )
          );
          return;
        }
        try {
          resolvePromise(
            JSON.parse(Buffer.concat(stdout).toString("utf8")) as AlignmentProposal
          );
        } catch (error) {
          rejectPromise(
            new Error(`alignment_headless 输出不是合法 JSON：${formatError(error)}`)
          );
        }
      });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function parseOptions(args: string[]): CliOptions {
  args = args.filter((value) => value !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`参数格式无效：${key ?? "<missing>"}`);
    }
    if (values.has(key)) throw new Error(`参数重复：${key}`);
    values.set(key, value);
  }
  const supported = new Set([
    "--manifest",
    "--output",
    "--binary",
    "--ffmpeg",
    "--ffprobe",
    "--spectral-backend",
    "--window-ms",
    "--min-gap-ms",
    "--match-threshold"
  ]);
  for (const key of values.keys()) {
    if (!supported.has(key)) throw new Error(`未知参数：${key}`);
  }
  const manifestPath = requiredPath(values, "--manifest");
  const outputPath = requiredPath(values, "--output");
  const binaryPath = resolve(
    values.get("--binary") ??
      (process.platform === "win32"
        ? "src-tauri/target/release/alignment_headless.exe"
        : "src-tauri/target/release/alignment_headless")
  );
  const spectralBackend = values.get("--spectral-backend") ?? "auto";
  if (spectralBackend !== "auto" && spectralBackend !== "cpu" && spectralBackend !== "cuda") {
    throw new Error("--spectral-backend 必须是 auto、cpu 或 cuda。");
  }
  return {
    manifestPath,
    outputPath,
    binaryPath,
    ffmpegPath: optionalPath(values.get("--ffmpeg")),
    ffprobePath: optionalPath(values.get("--ffprobe")),
    spectralBackend,
    windowMs: positiveInteger(values.get("--window-ms") ?? "1000", "--window-ms"),
    minGapMs: nonNegativeInteger(values.get("--min-gap-ms") ?? "3000", "--min-gap-ms"),
    matchThreshold: unitNumber(values.get("--match-threshold") ?? "0.35", "--match-threshold")
  };
}

function requiredPath(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value?.trim()) throw new Error(`缺少必需参数 ${key}`);
  return resolve(value);
}

function optionalPath(value: string | undefined): string | null {
  return value?.trim() ? resolve(value) : null;
}

function positiveInteger(value: string, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} 必须大于 0。`);
  return result;
}

function nonNegativeInteger(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} 必须是非负安全整数。`);
  }
  return result;
}

function unitNumber(value: string, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    throw new Error(`${label} 必须位于 0–1。`);
  }
  return result;
}

async function assertReadableFile(path: string, label: string): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`${label} 不存在或不是文件：${path}`);
  await access(path, fsConstants.R_OK);
}

async function assertOutputDoesNotExist(path: string): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (metadata) throw new Error(`输出已存在，拒绝覆盖：${path}`);
}

async function writeImmutableText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
