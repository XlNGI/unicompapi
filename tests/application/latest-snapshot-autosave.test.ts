import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LatestSnapshotAutosave,
  type AutosaveResult,
  type AutosaveState
} from '../../src/application/latest-snapshot-autosave';

interface Snapshot {
  readonly content: string;
  readonly revision: number;
}

interface SaveError {
  readonly code: 'temporary' | 'conflict' | 'terminal';
  readonly message: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function success(value: Snapshot): AutosaveResult<Snapshot, SaveError> {
  return { ok: true, value };
}

describe('LatestSnapshotAutosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces 100 edits into one trailing-edge save', async () => {
    const saves: Snapshot[] = [];
    const coordinator = createCoordinator(async (snapshot) => {
      saves.push(snapshot);
      return success({ ...snapshot, revision: snapshot.revision + 1 });
    });

    for (let index = 1; index <= 100; index += 1) {
      coordinator.queue({ content: `edit-${index}`, revision: 10 });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(saves).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toEqual([{ content: 'edit-100', revision: 10 }]);
    expect(coordinator.getState().phase).toBe('saved');
  });

  it('keeps one in-flight and one latest pending snapshot', async () => {
    const first = deferred<AutosaveResult<Snapshot, SaveError>>();
    const saves: Snapshot[] = [];
    const persisted: Array<{ saved: Snapshot; pending?: Snapshot }> = [];
    const coordinator = createCoordinator(
      async (snapshot) => {
        saves.push(snapshot);
        if (saves.length === 1) return first.promise;
        return success({ ...snapshot, revision: snapshot.revision + 1 });
      },
      (saved, pending) => persisted.push({ saved, pending })
    );

    coordinator.queue({ content: 'A', revision: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    for (let index = 1; index <= 100; index += 1) {
      coordinator.queue({ content: `B-${index}`, revision: 10 });
    }
    expect(saves).toEqual([{ content: 'A', revision: 10 }]);
    expect(coordinator.getState()).toMatchObject({
      hasInFlight: true,
      hasPending: true
    });

    first.resolve(success({ content: 'A', revision: 11 }));
    await vi.runAllTimersAsync();

    expect(saves).toEqual([
      { content: 'A', revision: 10 },
      { content: 'B-100', revision: 11 }
    ]);
    expect(persisted[0]?.pending).toEqual({ content: 'B-100', revision: 11 });
    expect(coordinator.getState().phase).toBe('saved');
  });

  it('retries only the latest snapshot after a temporary failure', async () => {
    const first = deferred<AutosaveResult<Snapshot, SaveError>>();
    const saves: Snapshot[] = [];
    const coordinator = createCoordinator(async (snapshot) => {
      saves.push(snapshot);
      if (saves.length === 1) return first.promise;
      return success({ ...snapshot, revision: snapshot.revision + 1 });
    });

    coordinator.queue({ content: 'old', revision: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    coordinator.queue({ content: 'latest', revision: 10 });
    first.resolve({
      ok: false,
      error: { code: 'temporary', message: 'locked' }
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.getState().phase).toBe('retrying');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toEqual([
      { content: 'old', revision: 10 },
      { content: 'latest', revision: 10 }
    ]);
  });

  it('flush bypasses debounce and conflict never retries automatically', async () => {
    const saves: Snapshot[] = [];
    const states: AutosaveState[] = [];
    const coordinator = createCoordinator(async (snapshot) => {
      saves.push(snapshot);
      return {
        ok: false,
        error: { code: 'conflict', message: 'changed externally' }
      };
    }, undefined, states);

    coordinator.queue({ content: 'pending', revision: 10 });
    const flushed = await coordinator.flush();

    expect(flushed).toBe(false);
    expect(saves).toHaveLength(1);
    expect(coordinator.getState().phase).toBe('conflict');
    await vi.runAllTimersAsync();
    expect(saves).toHaveLength(1);
    expect(states.some((state) => state.phase === 'saving')).toBe(true);
  });
});

function createCoordinator(
  save: (snapshot: Snapshot) => Promise<AutosaveResult<Snapshot, SaveError>>,
  onPersisted: (saved: Snapshot, pending?: Snapshot) => void = () => undefined,
  states: AutosaveState[] = []
) {
  return new LatestSnapshotAutosave<Snapshot, SaveError>({
    debounceMs: 1_000,
    retryDelaysMs: [1_000, 2_000, 4_000, 8_000, 8_000],
    save,
    rebase: (pending, persisted) => ({
      ...pending,
      revision: persisted.revision
    }),
    classifyError: (error) =>
      error.code === 'conflict'
        ? 'conflict'
        : error.code === 'temporary'
          ? 'retryable'
          : 'terminal',
    onPersisted,
    onError: () => undefined,
    onStateChange: (state) => states.push(state)
  });
}
