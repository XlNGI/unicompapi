import { useCallback, useSyncExternalStore } from 'react';
import type {
  StorageApi,
  StorageReadModelIssueDto,
  StorageTaskSummaryDto
} from '../shared/storage-ipc';
import { PROJECT_SESSION_CHANGED_EVENT } from './project-session-events';

export interface TaskReadSnapshot {
  readonly tasks: readonly StorageTaskSummaryDto[];
  readonly currentProjectId?: string;
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
let projectScopeRevision = 0;
let refreshRequested = false;

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
    updateSnapshot({ ...snapshot, currentProjectId: undefined, loading: false, error: true });
    return Promise.resolve(snapshot);
  }
  if (inFlight) {
    refreshRequested = true;
    return inFlight;
  }
  refreshRequested = false;
  const requestedProjectScopeRevision = projectScopeRevision;
  updateSnapshot({
    ...snapshot,
    loading: snapshot.loading || snapshot.tasks.length === 0,
    error: false
  });
  const pending = Promise.all([
    storage.listTasks(),
    storage.getProjectSession()
  ])
    .then(([taskResult, sessionResult]) => {
      if (requestedProjectScopeRevision !== projectScopeRevision) return snapshot;
      if (!taskResult.ok || !sessionResult.ok) {
        throw new TypeError('Task read model unavailable');
      }
      updateSnapshot({
        tasks: taskResult.value.items,
        currentProjectId: sessionResult.value?.projectId,
        issues: taskResult.value.issues,
        loading: false,
        error: false,
        revision: snapshot.revision + 1
      });
      return snapshot;
    })
    .catch(() => {
      if (requestedProjectScopeRevision === projectScopeRevision) {
        updateSnapshot({
          ...snapshot,
          currentProjectId: undefined,
          loading: false,
          error: true
        });
      }
      return snapshot;
    })
    .finally(() => {
      if (inFlight !== pending) return;
      inFlight = undefined;
      if (
        listeners.size > 0 &&
        (refreshRequested || requestedProjectScopeRevision !== projectScopeRevision)
      ) {
        refreshRequested = false;
        scheduleRefresh(0);
      }
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
  const handleProjectChange = () => {
    projectScopeRevision += 1;
    updateSnapshot({
      ...snapshot,
      currentProjectId: undefined,
      loading: true,
      error: false,
      revision: snapshot.revision + 1
    });
    scheduleRefresh(0);
  };
  const unsubscribe = storage.onLocalStorageChanged(schedule);
  window.addEventListener('focus', focus);
  window.addEventListener(PROJECT_SESSION_CHANGED_EVENT, handleProjectChange);
  const healthTimer = window.setInterval(() => scheduleRefresh(0), 60_000);
  stopListening = () => {
    unsubscribe();
    window.removeEventListener('focus', focus);
    window.removeEventListener(PROJECT_SESSION_CHANGED_EVENT, handleProjectChange);
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

export function tasksForProject(
  tasks: readonly StorageTaskSummaryDto[],
  projectId?: string
): readonly StorageTaskSummaryDto[] {
  return projectId ? tasks.filter((task) => task.projectId === projectId) : [];
}
