import { useCallback, useSyncExternalStore } from 'react';
import type {
  StorageApi,
  StorageReadModelIssueDto,
  StorageTaskSummaryDto
} from '../shared/storage-ipc';
import { PROJECT_SESSION_CHANGED_EVENT } from './project-session-events';

export interface TaskReadSnapshot {
  readonly tasks: readonly StorageTaskSummaryDto[];
  readonly issues: readonly StorageReadModelIssueDto[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly revision: number;
}

const listeners = new Set<() => void>();
let snapshot: TaskReadSnapshot = {
  tasks: [], issues: [], loading: true, error: false, revision: 0
};
let activeStorage: StorageApi | undefined;
let inFlight: Promise<TaskReadSnapshot> | undefined;
let stopListening: (() => void) | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export function useTaskReadStore(): TaskReadSnapshot {
  const storage = window.unicomp?.storage;
  const subscribe = useCallback((listener: () => void) =>
    subscribeTaskReadStore(storage, listener), [storage]);
  return useSyncExternalStore(subscribe, getTaskReadSnapshot, getTaskReadSnapshot);
}

export function getTaskReadSnapshot(): TaskReadSnapshot {
  return snapshot;
}

export function refreshTaskReadStore(): Promise<TaskReadSnapshot> {
  const storage = activeStorage ?? window.unicomp?.storage;
  if (!storage) {
    updateSnapshot({ ...snapshot, loading: false, error: true });
    return Promise.resolve(snapshot);
  }
  if (inFlight) return inFlight;
  updateSnapshot({ ...snapshot, loading: snapshot.tasks.length === 0, error: false });
  const pending = storage.listTasks()
    .then((result) => {
      if (!result.ok) throw new TypeError('Task read model unavailable');
      updateSnapshot({
        tasks: result.value.items,
        issues: result.value.issues,
        loading: false,
        error: false,
        revision: snapshot.revision + 1
      });
      return snapshot;
    })
    .catch(() => {
      updateSnapshot({ ...snapshot, loading: false, error: true });
      return snapshot;
    })
    .finally(() => {
      if (inFlight === pending) inFlight = undefined;
    });
  inFlight = pending;
  return pending;
}

function subscribeTaskReadStore(
  storage: StorageApi | undefined,
  listener: () => void
): () => void {
  listeners.add(listener);
  if (activeStorage !== storage || !stopListening) start(storage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

function start(storage: StorageApi | undefined): void {
  stop();
  activeStorage = storage;
  if (!storage) {
    updateSnapshot({ ...snapshot, loading: false, error: true });
    stopListening = () => undefined;
    return;
  }
  const schedule = () => scheduleRefresh(100);
  const focus = () => scheduleRefresh(0);
  const unsubscribe = storage.onLocalStorageChanged(schedule);
  window.addEventListener('focus', focus);
  window.addEventListener(PROJECT_SESSION_CHANGED_EVENT, schedule);
  const healthTimer = window.setInterval(() => scheduleRefresh(0), 60_000);
  stopListening = () => {
    unsubscribe();
    window.removeEventListener('focus', focus);
    window.removeEventListener(PROJECT_SESSION_CHANGED_EVENT, schedule);
    window.clearInterval(healthTimer);
  };
  void refreshTaskReadStore();
}

function stop(): void {
  stopListening?.();
  stopListening = undefined;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

function scheduleRefresh(delayMs: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshTaskReadStore();
  }, delayMs);
}

function updateSnapshot(next: TaskReadSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
