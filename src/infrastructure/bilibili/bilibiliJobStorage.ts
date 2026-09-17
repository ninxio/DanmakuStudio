import { isBilibiliAcquisition } from "../../domain/danmaku/bilibiliAcquisition";
import type { BilibiliSavedJob } from "./bilibiliClient";

const KEY = "danmaku-bilibili-acquisition-v1";
const MAX_BYTES = 2 * 1024 * 1024;
export function saveBilibiliJob(job: BilibiliSavedJob | null): void {
  if (!job) {
    localStorage.removeItem(KEY);
    return;
  }
  // Explicit allowlist: do not accidentally persist a Cookie added to a request.
  const { input, outputFolder, selectedCids, downloadAudio } = job.draft;
  const text = JSON.stringify({
    version: 1,
    draft: { input, outputFolder, selectedCids, downloadAudio },
    context: job.context,
    results: job.results,
    phase: job.phase
  });
  if (text.length > MAX_BYTES) throw new Error("获取任务记录过大");
  localStorage.setItem(KEY, text);
}
export function loadBilibiliJob(): BilibiliSavedJob | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  if (raw.length > MAX_BYTES) throw new Error("获取任务记录过大");
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.draft) ||
    !isRecord(value.context) ||
    !Array.isArray(value.results)
  )
    throw new Error("获取任务记录无效");
  const draft = value.draft;
  if (
    typeof draft.input !== "string" ||
    typeof draft.outputFolder !== "string" ||
    typeof draft.downloadAudio !== "boolean" ||
    !Array.isArray(draft.selectedCids) ||
    draft.selectedCids.length === 0 ||
    draft.selectedCids.length > 10_000 ||
    !draft.selectedCids.every((id) => Number.isSafeInteger(id) && id > 0) ||
    typeof value.context.projectId !== "string" ||
    typeof value.context.projectName !== "string" ||
    !Number.isSafeInteger(value.context.projectEpoch) ||
    typeof value.phase !== "string" ||
    ![
      "idle",
      "running",
      "cancelling",
      "importing",
      "completed",
      "cancelled",
      "failed",
      "pendingImport",
      "interrupted"
    ].includes(value.phase) ||
    !value.results.every(
      (row) =>
        isRecord(row) &&
        isBilibiliAcquisition({
          kind: "bilibili",
          bvid: row.bvid,
          aid: row.aid,
          cid: row.cid,
          page: row.page,
          durationMs: row.durationMs,
          exactDuration: row.exactDuration,
          xmlPath: row.xmlPath
        }) &&
        typeof row.part === "string" &&
        Number.isSafeInteger(row.danmakuCount) &&
        (row.danmakuCount as number) >= 0 &&
        (row.audioPath === null || typeof row.audioPath === "string")
    )
  ) {
    throw new Error("获取任务记录不完整");
  }
  return value as unknown as BilibiliSavedJob;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
