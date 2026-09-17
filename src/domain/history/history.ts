export interface HistoryEntry<T> {
  label: string;
  before: T;
  after: T;
}

export interface HistoryState<T> {
  past: HistoryEntry<T>[];
  future: HistoryEntry<T>[];
  limit: number;
}

export function createHistoryState<T>(limit = 120): HistoryState<T> {
  return {
    past: [],
    future: [],
    limit
  };
}

export function pushHistory<T>(
  history: HistoryState<T>,
  label: string,
  before: T,
  after: T
): HistoryState<T> {
  const nextPast = [...history.past, { label, before, after }];
  return {
    past: nextPast.slice(Math.max(0, nextPast.length - history.limit)),
    future: [],
    limit: history.limit
  };
}

export function undoHistory<T>(history: HistoryState<T>): { history: HistoryState<T>; value: T | null } {
  const entry = history.past.at(-1);
  if (!entry) {
    return { history, value: null };
  }
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future],
      limit: history.limit
    },
    value: entry.before
  };
}

export function redoHistory<T>(history: HistoryState<T>): { history: HistoryState<T>; value: T | null } {
  const entry = history.future[0];
  if (!entry) {
    return { history, value: null };
  }
  return {
    history: {
      past: [...history.past, entry].slice(Math.max(0, history.past.length + 1 - history.limit)),
      future: history.future.slice(1),
      limit: history.limit
    },
    value: entry.after
  };
}
