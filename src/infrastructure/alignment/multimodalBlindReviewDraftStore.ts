import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  normalizeMultimodalBlindReviewAnswer,
  type MultimodalBlindReviewAnswer,
  type MultimodalBlindReviewPack
} from "../../domain/alignment/multimodalBlindReview";

export const MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY =
  "danmaku-studio:multimodal-blind-review-drafts:v1";

const DRAFT_ARCHIVE_SCHEMA = "alignment-multimodal-blind-review-draft-archive-v1";
const MAX_DRAFTS = 8;
const MAX_ARCHIVE_BYTES = 512 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface MultimodalBlindReviewDraft {
  packId: string;
  currentTaskId: string;
  answers: MultimodalBlindReviewAnswer[];
  updatedAt: string;
}

export interface MultimodalBlindReviewDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

interface DraftArchive {
  schemaVersion: typeof DRAFT_ARCHIVE_SCHEMA;
  entries: MultimodalBlindReviewDraft[];
}

export interface DesktopMultimodalBlindReviewDraftBridge {
  load: () => Promise<string | null>;
  save: (content: string) => Promise<void>;
  clear: () => Promise<void>;
}

const defaultDesktopBridge: DesktopMultimodalBlindReviewDraftBridge = {
  load: () => invoke<string | null>("load_multimodal_blind_review_draft_archive_file"),
  save: (content) =>
    invoke<void>("save_multimodal_blind_review_draft_archive_file", { content }),
  clear: () => invoke<void>("clear_multimodal_blind_review_draft_archive_file")
};

let pendingDesktopWrite: Promise<void> | null = null;

export function loadMultimodalBlindReviewDraft(
  pack: MultimodalBlindReviewPack,
  storage: MultimodalBlindReviewDraftStorage | null = getDefaultStorage()
): MultimodalBlindReviewDraft | null {
  const archive = loadArchive(storage);
  const entry = archive.entries.find((candidate) => candidate.packId === pack.packId);
  if (!entry) return null;
  return validateDraftForPack(entry, pack);
}

export function saveMultimodalBlindReviewDraft(
  pack: MultimodalBlindReviewPack,
  currentTaskId: string,
  answers: MultimodalBlindReviewAnswer[],
  storage: MultimodalBlindReviewDraftStorage | null = getDefaultStorage(),
  updatedAt = new Date().toISOString()
): boolean {
  if (!storage) return false;
  const draft = validateDraftForPack(
    { packId: pack.packId, currentTaskId, answers, updatedAt },
    pack
  );
  const archive = loadArchive(storage);
  const entries = [draft, ...archive.entries.filter((entry) => entry.packId !== pack.packId)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_DRAFTS);
  const content = JSON.stringify({ schemaVersion: DRAFT_ARCHIVE_SCHEMA, entries });
  if (new TextEncoder().encode(content).byteLength > MAX_ARCHIVE_BYTES) {
    return false;
  }
  try {
    storage.setItem(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY, content);
    return true;
  } catch {
    return false;
  }
}

export function clearMultimodalBlindReviewDraft(
  packId: string,
  storage: MultimodalBlindReviewDraftStorage | null = getDefaultStorage()
): void {
  if (!storage) return;
  const archive = loadArchive(storage);
  const entries = archive.entries.filter((entry) => entry.packId !== packId);
  try {
    if (entries.length === 0) {
      storage.removeItem(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY);
    } else {
      storage.setItem(
        MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY,
        JSON.stringify({ schemaVersion: DRAFT_ARCHIVE_SCHEMA, entries })
      );
    }
  } catch {
    // Draft persistence is a convenience layer and must not block reviewing or export.
  }
}

export async function hydrateDesktopMultimodalBlindReviewDraft(
  pack: MultimodalBlindReviewPack,
  storage: MultimodalBlindReviewDraftStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalBlindReviewDraftBridge = defaultDesktopBridge
): Promise<MultimodalBlindReviewDraft | null> {
  const local = loadMultimodalBlindReviewDraft(pack, storage);
  if (bridge === defaultDesktopBridge && !isTauri()) return local;

  await pendingDesktopWrite?.catch(() => undefined);
  const content = await bridge.load();
  if (!content) {
    const localArchive = loadArchive(storage);
    if (localArchive.entries.length > 0) {
      await bridge.save(serializeArchive(localArchive));
    }
    return local;
  }

  try {
    const archive = parseArchiveJson(content);
    saveArchive(storage, archive);
    const entry = archive.entries.find((candidate) => candidate.packId === pack.packId);
    return entry ? validateDraftForPack(entry, pack) : null;
  } catch {
    clearArchive(storage);
    await bridge.clear();
    return null;
  }
}

export function persistDesktopMultimodalBlindReviewDraft(
  pack: MultimodalBlindReviewPack,
  currentTaskId: string,
  answers: MultimodalBlindReviewAnswer[],
  storage: MultimodalBlindReviewDraftStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalBlindReviewDraftBridge = defaultDesktopBridge,
  updatedAt = new Date().toISOString()
): Promise<boolean> {
  const archive = withUpdatedDraft(
    loadArchive(storage),
    validateDraftForPack({ packId: pack.packId, currentTaskId, answers, updatedAt }, pack)
  );
  const content = serializeArchive(archive);
  const compatibilityStored = saveArchive(storage, archive);
  if (bridge === defaultDesktopBridge && !isTauri()) {
    return Promise.resolve(compatibilityStored);
  }
  return enqueueDesktopWrite(() => bridge.save(content)).then(() => {
    return true;
  });
}

export async function clearDesktopMultimodalBlindReviewDraft(
  packId: string,
  storage: MultimodalBlindReviewDraftStorage | null = getDefaultStorage(),
  bridge: DesktopMultimodalBlindReviewDraftBridge = defaultDesktopBridge
): Promise<boolean> {
  if (!SHA256_PATTERN.test(packId)) throw new Error("盲复核任务包身份无效。");
  await pendingDesktopWrite?.catch(() => undefined);

  let archive = loadArchive(storage);
  if (bridge !== defaultDesktopBridge || isTauri()) {
    const content = await bridge.load();
    if (content) archive = parseArchiveJson(content);
  }
  const entries = archive.entries.filter((entry) => entry.packId !== packId);

  if (bridge !== defaultDesktopBridge || isTauri()) {
    await enqueueDesktopWrite(() =>
      entries.length > 0
        ? bridge.save(serializeArchive({ schemaVersion: DRAFT_ARCHIVE_SCHEMA, entries }))
        : bridge.clear()
    );
  }
  clearMultimodalBlindReviewDraft(packId, storage);
  return bridge !== defaultDesktopBridge || isTauri() || storage !== null;
}

function loadArchive(storage: MultimodalBlindReviewDraftStorage | null): DraftArchive {
  if (!storage) return emptyArchive();
  try {
    const content = storage.getItem(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY);
    if (!content) return emptyArchive();
    if (new TextEncoder().encode(content).byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error("盲复核草稿档案超过容量上限。");
    }
    return parseArchiveJson(content);
  } catch {
    clearArchive(storage);
    return emptyArchive();
  }
}

function parseArchiveJson(content: string): DraftArchive {
  if (new TextEncoder().encode(content).byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("盲复核草稿档案超过容量上限。");
  }
  const value: unknown = JSON.parse(content);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "entries"]) ||
    value.schemaVersion !== DRAFT_ARCHIVE_SCHEMA ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("盲复核草稿档案版本无效。");
  }
  const entries = value.entries.map(parseDraftShape);
  if (
    entries.length > MAX_DRAFTS ||
    new Set(entries.map((entry) => entry.packId)).size !== entries.length
  ) {
    throw new Error("盲复核草稿档案数量或身份无效。");
  }
  if (entries.some((entry, index) => index > 0 && entries[index - 1].updatedAt < entry.updatedAt)) {
    throw new Error("盲复核草稿档案没有按更新时间稳定排序。");
  }
  return { schemaVersion: DRAFT_ARCHIVE_SCHEMA, entries };
}

function withUpdatedDraft(archive: DraftArchive, draft: MultimodalBlindReviewDraft): DraftArchive {
  return {
    schemaVersion: DRAFT_ARCHIVE_SCHEMA,
    entries: [draft, ...archive.entries.filter((entry) => entry.packId !== draft.packId)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_DRAFTS)
  };
}

function serializeArchive(archive: DraftArchive): string {
  const content = JSON.stringify(archive);
  if (new TextEncoder().encode(content).byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("盲复核草稿档案超过容量上限。");
  }
  return content;
}

function saveArchive(
  storage: MultimodalBlindReviewDraftStorage | null,
  archive: DraftArchive
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY, serializeArchive(archive));
    return true;
  } catch {
    return false;
  }
}

function clearArchive(storage: MultimodalBlindReviewDraftStorage | null): void {
  try {
    storage?.removeItem(MULTIMODAL_BLIND_REVIEW_DRAFT_STORAGE_KEY);
  } catch {
    // app-data is authoritative; compatibility-mirror failures must not block recovery.
  }
}

function enqueueDesktopWrite(operation: () => Promise<void>): Promise<void> {
  const previous = pendingDesktopWrite ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  pendingDesktopWrite = next;
  const clear = () => {
    if (pendingDesktopWrite === next) pendingDesktopWrite = null;
  };
  void next.then(clear, clear);
  return next;
}

function parseDraftShape(value: unknown): MultimodalBlindReviewDraft {
  if (!isRecord(value) || !hasExactKeys(value, ["packId", "currentTaskId", "answers", "updatedAt"])) {
    throw new Error("盲复核草稿字段无效。");
  }
  if (
    typeof value.packId !== "string" ||
    !SHA256_PATTERN.test(value.packId) ||
    typeof value.currentTaskId !== "string" ||
    !SHA256_PATTERN.test(value.currentTaskId) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Array.isArray(value.answers)
  ) {
    throw new Error("盲复核草稿身份或时间无效。");
  }
  return {
    packId: value.packId,
    currentTaskId: value.currentTaskId,
    answers: value.answers.map(parseAnswerShape),
    updatedAt: value.updatedAt
  };
}

function parseAnswerShape(value: unknown): MultimodalBlindReviewAnswer {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "taskId",
      "decision",
      "targetTimestampMs",
      "boundaryToleranceMs",
      "precision"
    ]) ||
    typeof value.taskId !== "string" ||
    !SHA256_PATTERN.test(value.taskId) ||
    !["unreviewed", "matched", "no-match", "unsure"].includes(String(value.decision)) ||
    ![null, "rough", "playbackChecked", "frameAccurate"].includes(
      value.precision as null | string
    ) ||
    !isNullableNonnegativeInteger(value.targetTimestampMs) ||
    !isNullableNonnegativeInteger(value.boundaryToleranceMs)
  ) {
    throw new Error("盲复核草稿答案无效。");
  }
  return value as unknown as MultimodalBlindReviewAnswer;
}

function validateDraftForPack(
  draftValue: MultimodalBlindReviewDraft,
  pack: MultimodalBlindReviewPack
): MultimodalBlindReviewDraft {
  const draft = parseDraftShape(draftValue);
  const taskById = new Map(pack.tasks.map((task) => [task.taskId, task]));
  if (draft.packId !== pack.packId || !taskById.has(draft.currentTaskId)) {
    throw new Error("盲复核草稿不属于当前任务包。");
  }
  const answerIds = new Set<string>();
  const answers = draft.answers.map((answer) => {
    const task = taskById.get(answer.taskId);
    if (!task || answerIds.has(answer.taskId)) {
      throw new Error("盲复核草稿包含未知或重复任务。");
    }
    answerIds.add(answer.taskId);
    return normalizeMultimodalBlindReviewAnswer(answer, task);
  });
  return { ...draft, answers };
}

function emptyArchive(): DraftArchive {
  return { schemaVersion: DRAFT_ARCHIVE_SCHEMA, entries: [] };
}

function getDefaultStorage(): MultimodalBlindReviewDraftStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNullableNonnegativeInteger(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}
