import {
  cancelTauriMediaInventoryJob,
  getTauriMediaInventoryJob,
  isMediaInventoryCommandError,
  startTauriMediaInventoryJob,
  type MediaInventoryAudioDispositions as NativeAudioDispositions,
  type MediaInventoryAudioTrack as NativeAudioTrack,
  type MediaInventoryCachePolicy,
  type MediaInventoryItemSnapshot,
  type MediaInventoryJobSnapshot,
  type MediaInventoryRequest
} from "../infrastructure/media/tauriMediaInventory";

export interface MediaInventoryGenerationKey {
  projectId: string;
  projectEpoch: number;
  inventoryGeneration: number;
  mediaSignature: string;
}

export interface MediaInventoryDesiredItem {
  mediaId: string;
  localPath: string;
}

export interface MediaInventoryDesiredCohort {
  generationKey: MediaInventoryGenerationKey;
  items: readonly MediaInventoryDesiredItem[];
  ffprobePath?: string | null;
  ffmpegPath?: string | null;
  preferredLanguages?: readonly string[];
  cachePolicy?: MediaInventoryCachePolicy;
}

export type MediaInventoryAudioDispositions = NativeAudioDispositions;

export interface MediaInventoryAudioTrack
  extends Omit<NativeAudioTrack, "dispositions" | "reasonCodes"> {
  dispositions: MediaInventoryAudioDispositions;
  reasonCodes: readonly string[];
}

export interface MediaInventoryRecommendation {
  state: "recommended" | "needsChoice" | "unavailable";
  streamIndex: number | null;
  reasonCodes: readonly string[];
}

export type MediaInventorySemanticRow =
  | { mediaId: string; status: "queued" | "probing" | "cancelled" }
  | {
      mediaId: string;
      status: "failed";
      error: { code: string; message: string };
    }
  | {
      mediaId: string;
      status: "ready";
      inventoryRevision: string;
      durationMs: number | null;
      audioTracks: readonly MediaInventoryAudioTrack[];
      recommendation: MediaInventoryRecommendation;
      probeCompleteness: "complete" | "partial" | "fallbackRequired";
      cacheState: "fresh" | "stale" | "miss";
    };

export interface MediaInventorySemanticCounts {
  total: number;
  queued: number;
  probing: number;
  ready: number;
  failed: number;
  cancelled: number;
}

export interface MediaInventoryPublication {
  generationKey: MediaInventoryGenerationKey;
  phase: "queued" | "running" | "completed" | "cancelled" | "failed";
  counts: MediaInventorySemanticCounts;
  changedRows: readonly MediaInventorySemanticRow[];
  terminalMessage: string | null;
  restartRequired: boolean;
}

export interface MediaInventoryPort {
  start: (request: MediaInventoryRequest) => Promise<MediaInventoryJobSnapshot>;
  get: (jobId: string) => Promise<MediaInventoryJobSnapshot>;
  cancel: (jobId: string) => Promise<MediaInventoryJobSnapshot>;
}

export interface MediaInventorySupervisor {
  reconcile(desired: MediaInventoryDesiredCohort | null): Promise<void>;
  dispose(): Promise<void>;
}

export interface MediaInventorySupervisorOptions {
  publish(publication: MediaInventoryPublication): void;
  port?: MediaInventoryPort;
  waitForPoll?: () => Promise<void>;
}

interface ActiveJob {
  desired: MediaInventoryDesiredCohort;
  desiredVersion: number;
  jobId: string;
  lastSequence: number;
  lastSnapshotFingerprint: string | null;
  latestRows: Map<string, MediaInventorySemanticRow>;
  publishedRowFingerprints: Map<string, string>;
}

class SupervisorProtocolError extends Error {}

const DEFAULT_PORT: MediaInventoryPort = {
  start: startTauriMediaInventoryJob,
  get: getTauriMediaInventoryJob,
  cancel: cancelTauriMediaInventoryJob
};

const TERMINAL_JOB_STATUSES = new Set(["completed", "cancelled", "failed"]);
const RESTART_REQUIRED_MESSAGE = "媒体清单进程清理状态不确定，需重启应用。";

export function createMediaInventorySupervisor(
  options: MediaInventorySupervisorOptions
): MediaInventorySupervisor {
  const port = options.port ?? DEFAULT_PORT;
  const waitForPoll = options.waitForPoll ?? defaultWaitForPoll;
  let desired: MediaInventoryDesiredCohort | null = null;
  let desiredVersion = 0;
  let settledDesired: MediaInventoryDesiredCohort | null = null;
  let active: ActiveJob | null = null;
  let runner: Promise<void> | null = null;
  let disposed = false;
  let cleanupUncertain = false;

  const ensureRunner = (): Promise<void> => {
    if (runner === null) {
      const ownedRunner = runLoop().finally(() => {
        runner = null;
        if (hasPendingWork()) {
          return ensureRunner();
        }
      });
      runner = ownedRunner;
    }
    return runner;
  };

  const hasPendingWork = (): boolean =>
    active !== null ||
    (!disposed &&
      !cleanupUncertain &&
      desired !== null &&
      !areDesiredCohortsEqual(desired, settledDesired));

  const reconcile = (nextDesired: MediaInventoryDesiredCohort | null): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error("媒体清单 supervisor 已释放。"));
    }
    const normalized = nextDesired === null ? null : normalizeDesired(nextDesired);
    if (areDesiredCohortsEqual(desired, normalized)) {
      return runner ?? Promise.resolve();
    }
    desired = normalized;
    desiredVersion += 1;
    if (cleanupUncertain) {
      if (normalized !== null) {
        publishCleanupUncertain(normalized);
        settledDesired = normalized;
      }
      return runner ?? Promise.resolve();
    }
    return ensureRunner();
  };

  const dispose = (): Promise<void> => {
    if (!disposed) {
      disposed = true;
      desired = null;
      desiredVersion += 1;
    }
    return active !== null || runner !== null ? ensureRunner() : Promise.resolve();
  };

  async function runLoop(): Promise<void> {
    while (true) {
      if (active !== null) {
        await retireActive(active);
        active = null;
        if (cleanupUncertain) return;
        continue;
      }
      if (disposed || cleanupUncertain || desired === null) return;
      if (areDesiredCohortsEqual(desired, settledDesired)) return;

      const target = desired;
      const targetVersion = desiredVersion;
      await startAndObserve(target, targetVersion);
      if (cleanupUncertain) return;
    }
  }

  async function startAndObserve(
    target: MediaInventoryDesiredCohort,
    targetVersion: number
  ): Promise<void> {
    let startSnapshot: MediaInventoryJobSnapshot;
    try {
      startSnapshot = await port.start(toNativeRequest(target));
    } catch (error: unknown) {
      if (isProcessCleanupCommandFailure(error)) {
        failForProcessCleanupCommand(target, error);
        return;
      }
      if (isCurrent(target, targetVersion)) {
        publishOperationFailure(target, formatFailure(error));
        settledDesired = target;
      }
      return;
    }

    const nextActive: ActiveJob = {
      desired: target,
      desiredVersion: targetVersion,
      jobId: startSnapshot.jobId,
      lastSequence: -1,
      lastSnapshotFingerprint: null,
      latestRows: new Map(),
      publishedRowFingerprints: new Map()
    };
    active = nextActive;

    if (!isCurrent(target, targetVersion)) {
      await retireActive(nextActive, startSnapshot);
      active = null;
      return;
    }

    try {
      publishSnapshot(nextActive, startSnapshot);
    } catch (error: unknown) {
      await failProtocol(nextActive, error, startSnapshot);
      active = null;
      settledDesired = target;
      return;
    }
    if (isTerminal(startSnapshot)) {
      active = null;
      settledDesired = target;
      return;
    }

    while (active === nextActive) {
      await waitForPoll();
      if (!isCurrent(target, targetVersion)) {
        await retireActive(nextActive);
        active = null;
        return;
      }

      let snapshot: MediaInventoryJobSnapshot;
      try {
        snapshot = await port.get(nextActive.jobId);
      } catch (error: unknown) {
        if (isProcessCleanupCommandFailure(error)) {
          failForProcessCleanupCommand(target, error, nextActive);
          active = null;
          return;
        }
        if (isCurrent(target, targetVersion)) {
          publishOperationFailure(target, formatFailure(error), nextActive);
        }
        await retireActive(nextActive);
        active = null;
        settledDesired = target;
        return;
      }

      if (!isCurrent(target, targetVersion)) {
        await retireActive(nextActive, snapshot);
        active = null;
        return;
      }
      try {
        const accepted = publishSnapshot(nextActive, snapshot);
        if (accepted && isTerminal(snapshot)) {
          active = null;
          settledDesired = target;
          return;
        }
      } catch (error: unknown) {
        await failProtocol(nextActive, error, snapshot);
        active = null;
        settledDesired = target;
        return;
      }
    }
  }

  function failForProcessCleanupCommand(
    fallbackTarget: MediaInventoryDesiredCohort,
    error: unknown,
    interruptedJob?: ActiveJob
  ): void {
    cleanupUncertain = true;
    if (disposed) return;
    const failureTarget = desired ?? fallbackTarget;
    publishCleanupUncertain(
      failureTarget,
      interruptedJob && areDesiredCohortsEqual(failureTarget, interruptedJob.desired)
        ? interruptedJob
        : undefined,
      formatFailure(error)
    );
    settledDesired = failureTarget;
  }

  function publishSnapshot(job: ActiveJob, snapshot: MediaInventoryJobSnapshot): boolean {
    assertSnapshotIdentity(job, snapshot);
    if (snapshot.sequence <= job.lastSequence) return false;
    const rows = snapshot.items.map((item) => toSemanticRow(item));
    job.lastSequence = snapshot.sequence;
    job.lastSnapshotFingerprint = fingerprintSnapshot(snapshot);
    job.latestRows = new Map(rows.map((row) => [row.mediaId, row] as const));
    publishSemanticSnapshot(job, snapshot, rows);
    return true;
  }

  function publishSemanticSnapshot(
    job: ActiveJob,
    snapshot: MediaInventoryJobSnapshot,
    rows: readonly MediaInventorySemanticRow[]
  ): void {
    const restartRequired = snapshot.terminalError?.code === "processCleanupFault";
    const publicationRows = preparePublishedRows(job, rows);
    options.publish({
      generationKey: job.desired.generationKey,
      phase: snapshot.status,
      counts: { ...snapshot.counts },
      changedRows: publicationRows.changedRows,
      terminalMessage: restartRequired
        ? formatRestartRequiredMessage(snapshot.terminalError?.message)
        : snapshot.terminalError?.message ?? null,
      restartRequired
    });
    job.publishedRowFingerprints = publicationRows.nextFingerprints;
    if (restartRequired) cleanupUncertain = true;
  }

  async function failProtocol(
    job: ActiveJob,
    error: unknown,
    latestSnapshot?: MediaInventoryJobSnapshot
  ): Promise<void> {
    await retireActive(job, latestSnapshot);
    if (!cleanupUncertain && isCurrent(job.desired, job.desiredVersion)) {
      publishProtocolFailure(job.desired, formatFailure(error), job);
    }
  }

  async function retireActive(
    job: ActiveJob,
    latestSnapshot?: MediaInventoryJobSnapshot
  ): Promise<void> {
    try {
      if (latestSnapshot !== undefined) {
        acceptCleanupSnapshot(job, latestSnapshot);
        if (publishCleanupFaultIfPresent(job, latestSnapshot)) return;
        if (isTerminal(latestSnapshot)) {
          publishCleanupTerminalIfPaused(job, latestSnapshot);
          return;
        }
      }
      let snapshot = await port.cancel(job.jobId);
      acceptCleanupSnapshot(job, snapshot);
      if (publishCleanupFaultIfPresent(job, snapshot)) return;
      while (!isTerminal(snapshot)) {
        await waitForPoll();
        snapshot = await port.get(job.jobId);
        acceptCleanupSnapshot(job, snapshot);
        if (publishCleanupFaultIfPresent(job, snapshot)) return;
      }
      publishCleanupTerminalIfPaused(job, snapshot);
    } catch (error: unknown) {
      cleanupUncertain = true;
      if (!disposed) {
        const failureTarget = desired ?? job.desired;
        publishCleanupUncertain(
          failureTarget,
          areDesiredCohortsEqual(failureTarget, job.desired) ? job : undefined,
          isProcessCleanupCommandFailure(error) ? formatFailure(error) : undefined
        );
        settledDesired = failureTarget;
      }
    }
  }

  function publishCleanupFaultIfPresent(
    job: ActiveJob,
    snapshot: MediaInventoryJobSnapshot
  ): boolean {
    if (snapshot.terminalError?.code !== "processCleanupFault") return false;
    cleanupUncertain = true;
    if (!disposed) {
      const failureTarget = desired ?? job.desired;
      if (areDesiredCohortsEqual(failureTarget, job.desired)) {
        publishSemanticSnapshot(job, snapshot, [...job.latestRows.values()]);
      } else {
        publishCleanupUncertain(failureTarget, undefined, snapshot.terminalError.message);
      }
      settledDesired = failureTarget;
    }
    return true;
  }

  function publishCleanupTerminalIfPaused(
    job: ActiveJob,
    snapshot: MediaInventoryJobSnapshot
  ): void {
    if (!disposed && desired === null) {
      publishSemanticSnapshot(job, snapshot, [...job.latestRows.values()]);
    }
  }

  function publishCleanupUncertain(
    target: MediaInventoryDesiredCohort,
    interruptedJob?: ActiveJob,
    detail?: string
  ): void {
    if (interruptedJob) {
      publishInterruptedCleanupFailure(target, interruptedJob, detail);
      return;
    }
    publishFailure(
      target,
      "processCleanupUncertain",
      formatRestartRequiredMessage(detail),
      true
    );
  }

  function publishInterruptedCleanupFailure(
    target: MediaInventoryDesiredCohort,
    job: ActiveJob,
    detail?: string
  ): void {
    const message = formatRestartRequiredMessage(detail);
    const finalRows: MediaInventorySemanticRow[] = [];
    const counts: MediaInventorySemanticCounts = {
      total: target.items.length,
      queued: 0,
      probing: 0,
      ready: 0,
      failed: 0,
      cancelled: 0
    };
    for (const item of target.items) {
      const row = job.latestRows.get(item.mediaId);
      if (row?.status === "ready") {
        counts.ready += 1;
        finalRows.push(row);
      } else if (row?.status === "failed") {
        counts.failed += 1;
        finalRows.push(row);
      } else if (row?.status === "cancelled") {
        counts.cancelled += 1;
        finalRows.push(row);
      } else {
        counts.failed += 1;
        finalRows.push({
          mediaId: item.mediaId,
          status: "failed",
          error: { code: "processCleanupUncertain", message }
        });
      }
    }
    const publicationRows = preparePublishedRows(job, finalRows);
    options.publish({
      generationKey: target.generationKey,
      phase: "failed",
      counts,
      changedRows: publicationRows.changedRows,
      terminalMessage: message,
      restartRequired: true
    });
    job.publishedRowFingerprints = publicationRows.nextFingerprints;
  }

  function publishProtocolFailure(
    target: MediaInventoryDesiredCohort,
    detail: string,
    job?: ActiveJob
  ): void {
    publishFailure(target, "protocolInvariant", `媒体清单响应不一致：${detail}`, false, job);
  }

  function publishOperationFailure(
    target: MediaInventoryDesiredCohort,
    detail: string,
    job?: ActiveJob
  ): void {
    publishFailure(target, "inventoryUnavailable", `媒体清单任务失败：${detail}`, false, job);
  }

  function publishFailure(
    target: MediaInventoryDesiredCohort,
    code: string,
    message: string,
    restartRequired = false,
    job?: ActiveJob
  ): void {
    const rows = target.items.map((item) => ({
      mediaId: item.mediaId,
      status: "failed" as const,
      error: { code, message }
    }));
    const publicationRows = job ? preparePublishedRows(job, rows) : null;
    options.publish({
      generationKey: target.generationKey,
      phase: "failed",
      counts: {
        total: target.items.length,
        queued: 0,
        probing: 0,
        ready: 0,
        failed: target.items.length,
        cancelled: 0
      },
      changedRows: publicationRows?.changedRows ?? rows,
      terminalMessage: message,
      restartRequired
    });
    if (job && publicationRows) {
      job.publishedRowFingerprints = publicationRows.nextFingerprints;
    }
  }

  function isCurrent(target: MediaInventoryDesiredCohort, version: number): boolean {
    return !disposed && version === desiredVersion && areDesiredCohortsEqual(target, desired);
  }

  return { reconcile, dispose };
}

function normalizeDesired(desired: MediaInventoryDesiredCohort): MediaInventoryDesiredCohort {
  assertGenerationKey(desired.generationKey);
  if (desired.items.length < 1 || desired.items.length > 256) {
    throw new Error("媒体清单 desired cohort 必须包含 1 到 256 个素材。 ");
  }
  const mediaIds = new Set<string>();
  const items = desired.items.map((item) => {
    const mediaId = item.mediaId.trim();
    const localPath = item.localPath.trim();
    if (mediaId.length === 0 || localPath.length === 0 || mediaIds.has(mediaId)) {
      throw new Error("媒体清单 desired item 的 mediaId/path 必须非空且 mediaId 唯一。 ");
    }
    mediaIds.add(mediaId);
    return { mediaId, localPath };
  });
  return {
    generationKey: { ...desired.generationKey },
    items,
    ffprobePath: desired.ffprobePath,
    ffmpegPath: desired.ffmpegPath,
    preferredLanguages: desired.preferredLanguages
      ? [...desired.preferredLanguages]
      : undefined,
    cachePolicy: desired.cachePolicy
  };
}

function assertGenerationKey(key: MediaInventoryGenerationKey): void {
  if (
    key.projectId.trim().length === 0 ||
    key.mediaSignature.trim().length === 0 ||
    !Number.isSafeInteger(key.projectEpoch) ||
    key.projectEpoch < 0 ||
    !Number.isSafeInteger(key.inventoryGeneration) ||
    key.inventoryGeneration < 0
  ) {
    throw new Error("媒体清单 generation key 无效。 ");
  }
}

function toNativeRequest(desired: MediaInventoryDesiredCohort): MediaInventoryRequest {
  return {
    schemaVersion: 1,
    items: desired.items.map((item) => ({ itemId: item.mediaId, path: item.localPath })),
    ffprobePath: desired.ffprobePath,
    ffmpegPath: desired.ffmpegPath,
    preferredLanguages: desired.preferredLanguages
      ? [...desired.preferredLanguages]
      : undefined,
    cachePolicy: desired.cachePolicy
  };
}

function assertSnapshotIdentity(job: ActiveJob, snapshot: MediaInventoryJobSnapshot): void {
  if (snapshot.jobId !== job.jobId || snapshot.items.length !== job.desired.items.length) {
    throw new SupervisorProtocolError("job 或 cohort 数量不匹配");
  }
  snapshot.items.forEach((item, ordinal) => {
    if (
      item.ordinal !== ordinal ||
      item.itemId !== job.desired.items[ordinal]?.mediaId
    ) {
      throw new SupervisorProtocolError(`cohort 第 ${ordinal + 1} 项不匹配`);
    }
  });
}

function assertCleanupJobIdentity(job: ActiveJob, snapshot: MediaInventoryJobSnapshot): void {
  assertSnapshotIdentity(job, snapshot);
}

function acceptCleanupSnapshot(job: ActiveJob, snapshot: MediaInventoryJobSnapshot): boolean {
  assertCleanupJobIdentity(job, snapshot);
  const fingerprint = fingerprintSnapshot(snapshot);
  if (snapshot.sequence < job.lastSequence) {
    throw new SupervisorProtocolError("取消收尾 sequence 回退");
  }
  if (snapshot.sequence === job.lastSequence) {
    if (fingerprint !== job.lastSnapshotFingerprint) {
      throw new SupervisorProtocolError("取消收尾相同 sequence 的快照发生漂移");
    }
    return false;
  }
  job.lastSequence = snapshot.sequence;
  job.lastSnapshotFingerprint = fingerprint;
  job.latestRows = new Map(
    snapshot.items.map((item) => [item.itemId, toSemanticRow(item)] as const)
  );
  return true;
}

function fingerprintSnapshot(snapshot: MediaInventoryJobSnapshot): string {
  return JSON.stringify(snapshot);
}

function preparePublishedRows(
  job: ActiveJob,
  rows: readonly MediaInventorySemanticRow[]
): {
  changedRows: MediaInventorySemanticRow[];
  nextFingerprints: Map<string, string>;
} {
  const changedRows: MediaInventorySemanticRow[] = [];
  const nextFingerprints = new Map(job.publishedRowFingerprints);
  for (const row of rows) {
    const fingerprint = JSON.stringify(row);
    if (job.publishedRowFingerprints.get(row.mediaId) !== fingerprint) {
      changedRows.push(row);
    }
    nextFingerprints.set(row.mediaId, fingerprint);
  }
  return { changedRows, nextFingerprints };
}

function isProcessCleanupCommandFailure(error: unknown): boolean {
  return isMediaInventoryCommandError(error) && error.code === "processCleanupFault";
}

function formatRestartRequiredMessage(detail?: string | null): string {
  const normalized = detail?.trim();
  if (!normalized) return RESTART_REQUIRED_MESSAGE;
  if (normalized.includes(RESTART_REQUIRED_MESSAGE)) return normalized;
  return `${normalized}；${RESTART_REQUIRED_MESSAGE}`;
}

function toSemanticRow(item: MediaInventoryItemSnapshot): MediaInventorySemanticRow {
  if (item.status === "queued" || item.status === "probing" || item.status === "cancelled") {
    return { mediaId: item.itemId, status: item.status };
  }
  if (item.status === "failed") {
    return {
      mediaId: item.itemId,
      status: "failed",
      error: { ...item.error! }
    };
  }
  const result = item.result!;
  return {
    mediaId: item.itemId,
    status: "ready",
    inventoryRevision: result.inventoryRevision,
    durationMs: result.durationMs,
    audioTracks: result.audioTracks.map(cloneAudioTrack),
    recommendation: {
      state: result.recommendation.state,
      streamIndex: result.recommendation.streamIndex,
      reasonCodes: [...result.recommendation.reasonCodes]
    },
    probeCompleteness: result.probeCompleteness,
    cacheState: result.cacheState
  };
}

function cloneAudioTrack(track: NativeAudioTrack): MediaInventoryAudioTrack {
  return {
    ...track,
    dispositions: { ...track.dispositions },
    reasonCodes: [...track.reasonCodes]
  };
}

function areDesiredCohortsEqual(
  left: MediaInventoryDesiredCohort | null,
  right: MediaInventoryDesiredCohort | null
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.generationKey.projectId === right.generationKey.projectId &&
    left.generationKey.projectEpoch === right.generationKey.projectEpoch &&
    left.generationKey.inventoryGeneration === right.generationKey.inventoryGeneration &&
    left.generationKey.mediaSignature === right.generationKey.mediaSignature &&
    left.items.length === right.items.length &&
    left.items.every(
      (item, index) =>
        item.mediaId === right.items[index]?.mediaId &&
        item.localPath === right.items[index]?.localPath
    ) &&
    left.ffprobePath === right.ffprobePath &&
    left.ffmpegPath === right.ffmpegPath &&
    left.cachePolicy === right.cachePolicy &&
    areStringArraysEqual(left.preferredLanguages, right.preferredLanguages)
  );
}

function areStringArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isTerminal(snapshot: MediaInventoryJobSnapshot): boolean {
  return TERMINAL_JOB_STATUSES.has(snapshot.status);
}

function formatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWaitForPoll(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 100);
  });
}
