import type { WorkspaceStatusId } from "../../domain/shared/statusVocabulary";
import type { WorkspaceIntentTarget } from "../workspaceIntent";

export type ApplicationTaskSource =
  | "acquisition"
  | "xmlImport"
  | "mediaInventory"
  | "matching"
  | "projectSave"
  | "export"
  | "status";

export type ApplicationTaskActionKind =
  | "cancel"
  | "retry"
  | "locate"
  | "open"
  | "dismiss";

export interface ApplicationTaskAction {
  id: string;
  kind: ApplicationTaskActionKind;
  label: string;
}

export interface ApplicationTask {
  id: string;
  source: ApplicationTaskSource;
  title: string;
  phase: string;
  statusId: WorkspaceStatusId;
  progress: number | null;
  startedAtMs: number;
  updatedAtMs: number;
  error: string | null;
  target?: WorkspaceIntentTarget;
  actions: readonly ApplicationTaskAction[];
}

export interface ApplicationTaskRegistration {
  task: ApplicationTask;
  handlers?: Readonly<Record<string, () => void>>;
}

export interface ApplicationTaskSnapshot {
  tasks: readonly ApplicationTask[];
  totalCount: number;
  primaryTaskId: string | null;
}

export interface ApplicationTaskRegistry {
  replaceSource(sourceId: string, registrations: readonly ApplicationTaskRegistration[]): void;
  clearSource(sourceId: string): void;
  getSnapshot(): ApplicationTaskSnapshot;
  subscribe(listener: () => void): () => void;
  runAction(taskId: string, actionId: string): boolean;
}

export interface ApplicationLiveTaskChannel<T> {
  read(key: string): T | undefined;
  publish(key: string, value: T): void;
  update(key: string, updater: (value: T) => T): boolean;
  finish(key: string, finalValue: T): boolean;
  subscribe(key: string, listener: (value: T) => void): () => void;
}

interface RegistrySourceState {
  registrations: readonly ApplicationTaskRegistration[];
}

const EMPTY_SNAPSHOT: ApplicationTaskSnapshot = {
  tasks: [],
  totalCount: 0,
  primaryTaskId: null
};

const STATUS_PRIORITY: Record<WorkspaceStatusId, number> = {
  blocked: 0,
  actionRequired: 1,
  reviewRequired: 2,
  running: 3,
  runnable: 4,
  preparing: 5,
  confirmed: 6,
  exported: 7
};

const SOURCE_PRIORITY: Record<ApplicationTaskSource, number> = {
  acquisition: 3,
  mediaInventory: 0,
  export: 1,
  matching: 2,
  xmlImport: 3,
  projectSave: 4,
  status: 5
};

export function createApplicationTaskRegistry(
  options: { now?: () => number } = {}
): ApplicationTaskRegistry {
  const sources = new Map<string, RegistrySourceState>();
  const listeners = new Set<() => void>();
  const now = options.now ?? Date.now;
  let snapshot = EMPTY_SNAPSHOT;

  const rebuildSnapshot = () => {
    const registrations = [...sources.values()].flatMap((source) => source.registrations);
    const taskIds = new Set<string>();
    for (const registration of registrations) {
      if (taskIds.has(registration.task.id)) {
        throw new Error(`后台任务 ID 重复：${registration.task.id}`);
      }
      taskIds.add(registration.task.id);
    }
    const tasks = registrations
      .map((registration) => registration.task)
      .sort(compareApplicationTasks);
    snapshot = {
      tasks,
      totalCount: tasks.length,
      primaryTaskId: tasks[0]?.id ?? null
    };
    listeners.forEach((listener) => listener());
  };

  return {
    replaceSource(sourceId, registrations) {
      const previous = sources.get(sourceId)?.registrations ?? [];
      const previousById = new Map(
        previous.map((registration) => [registration.task.id, registration])
      );
      const normalized = registrations.map((registration) => {
        const previousRegistration = previousById.get(registration.task.id);
        const observedAtMs = now();
        return {
          ...registration,
          task: {
            ...registration.task,
            startedAtMs:
              registration.task.startedAtMs > 0
                ? registration.task.startedAtMs
                : previousRegistration?.task.startedAtMs ?? observedAtMs,
            updatedAtMs:
              registration.task.updatedAtMs > 0
                ? registration.task.updatedAtMs
                : observedAtMs,
            actions: [...registration.task.actions]
          }
        };
      });
      const prospectiveTaskIds = new Set<string>();
      for (const [existingSourceId, source] of sources) {
        if (existingSourceId === sourceId) continue;
        for (const registration of source.registrations) {
          prospectiveTaskIds.add(registration.task.id);
        }
      }
      for (const registration of normalized) {
        if (prospectiveTaskIds.has(registration.task.id)) {
          throw new Error(`后台任务 ID 重复：${registration.task.id}`);
        }
        prospectiveTaskIds.add(registration.task.id);
      }
      const viewChanged = !sameRegistrations(previous, normalized);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, { registrations: normalized });
      if (!viewChanged) return;
      rebuildSnapshot();
    },
    clearSource(sourceId) {
      if (!sources.delete(sourceId)) return;
      rebuildSnapshot();
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    runAction(taskId, actionId) {
      for (const source of sources.values()) {
        const registration = source.registrations.find(
          (candidate) => candidate.task.id === taskId
        );
        const handler = registration?.handlers?.[actionId];
        if (handler) {
          handler();
          return true;
        }
      }
      return false;
    }
  };
}

export const applicationTaskRegistry = createApplicationTaskRegistry();

export function createApplicationLiveTaskChannel<T>(
  registry: ApplicationTaskRegistry,
  sourceId: string,
  project: (key: string, value: T) => readonly ApplicationTaskRegistration[],
  options: { maxEntries?: number } = {}
): ApplicationLiveTaskChannel<T> {
  const entries = new Map<string, T>();
  const terminalEntries = new Map<string, T>();
  const listeners = new Map<string, Set<(value: T) => void>>();
  const entryOrder: string[] = [];
  const maxEntries = Math.max(1, options.maxEntries ?? Number.MAX_SAFE_INTEGER);

  const publishTasks = () => {
    const registrations = [
      ...terminalEntries.entries(),
      ...entries.entries()
    ].flatMap(([key, value]) => project(key, value));
    registry.replaceSource(sourceId, registrations);
  };

  const emit = (key: string, value: T) => {
    listeners.get(key)?.forEach((listener) => listener(value));
  };

  return {
    read(key) {
      return entries.get(key);
    },
    publish(key, value) {
      if (!entries.has(key) && !terminalEntries.has(key)) {
        while (entryOrder.length >= maxEntries) {
          const oldestKey = entryOrder.shift();
          if (oldestKey === undefined) break;
          entries.delete(oldestKey);
          terminalEntries.delete(oldestKey);
        }
        entryOrder.push(key);
      }
      terminalEntries.delete(key);
      entries.set(key, value);
      publishTasks();
      emit(key, value);
    },
    update(key, updater) {
      const current = entries.get(key);
      if (current === undefined) return false;
      const next = updater(current);
      entries.set(key, next);
      publishTasks();
      emit(key, next);
      return true;
    },
    finish(key, finalValue) {
      if (!entries.delete(key)) return false;
      terminalEntries.set(key, finalValue);
      publishTasks();
      emit(key, finalValue);
      return true;
    },
    subscribe(key, listener) {
      const keyListeners = listeners.get(key) ?? new Set();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      const current = entries.get(key);
      if (current !== undefined) listener(current);
      return () => {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      };
    }
  };
}

function compareApplicationTasks(left: ApplicationTask, right: ApplicationTask): number {
  return (
    STATUS_PRIORITY[left.statusId] - STATUS_PRIORITY[right.statusId] ||
    SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
    left.startedAtMs - right.startedAtMs ||
    left.id.localeCompare(right.id)
  );
}

function sameRegistrations(
  left: readonly ApplicationTaskRegistration[],
  right: readonly ApplicationTaskRegistration[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((registration, index) => sameTask(registration.task, right[index]?.task));
}

function sameTask(left: ApplicationTask, right: ApplicationTask | undefined): boolean {
  if (!right) return false;
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.title === right.title &&
    left.phase === right.phase &&
    left.statusId === right.statusId &&
    left.progress === right.progress &&
    left.startedAtMs === right.startedAtMs &&
    left.updatedAtMs === right.updatedAtMs &&
    left.error === right.error &&
    sameTarget(left.target, right.target) &&
    left.actions.length === right.actions.length &&
    left.actions.every((action, index) => {
      const other = right.actions[index];
      return (
        other !== undefined &&
        action.id === other.id &&
        action.kind === other.kind &&
        action.label === other.label
      );
    })
  );
}

function sameTarget(
  left: WorkspaceIntentTarget | undefined,
  right: WorkspaceIntentTarget | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "media" && right.kind === "media") return left.mediaId === right.mediaId;
  if (left.kind === "xml" && right.kind === "xml") return left.assetId === right.assetId;
  if (left.kind === "candidate" && right.kind === "candidate") {
    return left.candidateId === right.candidateId;
  }
  if (left.kind === "exportEntry" && right.kind === "exportEntry") {
    return left.targetMediaId === right.targetMediaId;
  }
  if (left.kind === "audioIssue" && right.kind === "audioIssue") {
    return left.mediaId === right.mediaId;
  }
  return false;
}
