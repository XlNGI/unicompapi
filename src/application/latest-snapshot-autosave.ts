export type AutosavePhase =
  | 'saved'
  | 'pending'
  | 'saving'
  | 'retrying'
  | 'failed'
  | 'conflict';

export interface AutosaveError {
  readonly code: string;
  readonly message: string;
}

export type AutosaveResult<TSnapshot, TError extends AutosaveError> =
  | { readonly ok: true; readonly value: TSnapshot }
  | { readonly ok: false; readonly error: TError };

export interface AutosaveState {
  readonly phase: AutosavePhase;
  readonly hasInFlight: boolean;
  readonly hasPending: boolean;
  readonly retryAttempt: number;
}

interface SnapshotSlot<TSnapshot> {
  readonly sequence: number;
  readonly snapshot: TSnapshot;
}

interface LatestSnapshotAutosaveOptions<
  TSnapshot,
  TError extends AutosaveError
> {
  readonly debounceMs: number;
  readonly retryDelaysMs: readonly number[];
  readonly save: (
    snapshot: TSnapshot
  ) => Promise<AutosaveResult<TSnapshot, TError>>;
  readonly rebase: (
    pending: TSnapshot,
    persisted: TSnapshot
  ) => TSnapshot;
  readonly classifyError: (
    error: TError
  ) => 'retryable' | 'conflict' | 'terminal';
  readonly onPersisted: (
    persisted: TSnapshot,
    rebasedPending?: TSnapshot
  ) => void;
  readonly onError: (error: TError | Error, phase: 'retrying' | 'failed' | 'conflict') => void;
  readonly onStateChange: (state: AutosaveState) => void;
}

interface FlushWaiter {
  readonly resolve: (saved: boolean) => void;
}

/**
 * A trailing-edge, latest-only autosave coordinator. It keeps at most one
 * in-flight snapshot and one pending snapshot, regardless of edit frequency.
 */
export class LatestSnapshotAutosave<
  TSnapshot,
  TError extends AutosaveError
> {
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private inFlight?: SnapshotSlot<TSnapshot>;
  private pending?: SnapshotSlot<TSnapshot>;
  private phase: AutosavePhase = 'saved';
  private retryAttempt = 0;
  private sequence = 0;
  private readonly flushWaiters: FlushWaiter[] = [];

  constructor(
    private readonly options: LatestSnapshotAutosaveOptions<TSnapshot, TError>
  ) {}

  getState(): AutosaveState {
    return {
      phase: this.phase,
      hasInFlight: this.inFlight !== undefined,
      hasPending: this.pending !== undefined,
      retryAttempt: this.retryAttempt
    };
  }

  hasUnsavedChanges(): boolean {
    return this.inFlight !== undefined || this.pending !== undefined;
  }

  queue(snapshot: TSnapshot): void {
    this.pending = { sequence: ++this.sequence, snapshot };

    if (this.phase === 'conflict') {
      this.emitState();
      return;
    }

    this.clearRetryTimer();
    this.retryAttempt = 0;
    if (this.inFlight) {
      this.setPhase('saving');
      return;
    }

    this.scheduleDebounce();
  }

  async flush(): Promise<boolean> {
    this.clearDebounceTimer();
    this.clearRetryTimer();

    if (this.phase === 'conflict') return false;
    if (!this.inFlight && !this.pending) {
      return this.phase === 'saved';
    }

    const result = new Promise<boolean>((resolve) => {
      this.flushWaiters.push({ resolve });
    });
    if (!this.inFlight) void this.drain();
    return result;
  }

  retry(): Promise<boolean> {
    if (this.phase === 'conflict') return Promise.resolve(false);
    this.retryAttempt = 0;
    return this.flush();
  }

  reset(): void {
    this.clearDebounceTimer();
    this.clearRetryTimer();
    this.pending = undefined;
    this.retryAttempt = 0;
    if (!this.inFlight) {
      this.setPhase('saved');
      this.resolveFlushWaiters(true);
    }
  }

  private scheduleDebounce(): void {
    this.clearDebounceTimer();
    this.setPhase('pending');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.drain();
    }, this.options.debounceMs);
  }

  private async drain(): Promise<void> {
    if (this.inFlight || !this.pending || this.phase === 'conflict') return;

    this.clearDebounceTimer();
    const slot = this.pending;
    this.pending = undefined;
    this.inFlight = slot;
    this.setPhase('saving');

    try {
      const result = await this.options.save(slot.snapshot);
      if (!result.ok) {
        this.handleFailure(slot, result.error);
        return;
      }

      this.inFlight = undefined;
      this.retryAttempt = 0;
      const pending = this.readPending();
      if (pending) {
        const rebasedPending = {
          ...pending,
          snapshot: this.options.rebase(pending.snapshot, result.value)
        };
        this.pending = rebasedPending;
        this.options.onPersisted(result.value, rebasedPending.snapshot);
        this.setPhase('pending');
        void this.drain();
        return;
      }

      this.options.onPersisted(result.value);
      this.setPhase('saved');
      this.resolveFlushWaiters(true);
    } catch (error) {
      this.handleUnexpectedFailure(slot, error);
    }
  }

  private handleFailure(slot: SnapshotSlot<TSnapshot>, error: TError): void {
    this.inFlight = undefined;
    this.keepLatest(slot);
    const classification = this.options.classifyError(error);
    if (classification === 'conflict') {
      this.setPhase('conflict');
      this.options.onError(error, 'conflict');
      this.resolveFlushWaiters(false);
      return;
    }
    if (classification === 'terminal') {
      this.setPhase('failed');
      this.options.onError(error, 'failed');
      this.resolveFlushWaiters(false);
      return;
    }
    this.scheduleRetry(error);
  }

  private handleUnexpectedFailure(
    slot: SnapshotSlot<TSnapshot>,
    error: unknown
  ): void {
    this.inFlight = undefined;
    this.keepLatest(slot);
    const normalized = error instanceof Error
      ? error
      : new Error('Autosave failed unexpectedly');
    this.scheduleRetry(normalized);
  }

  private keepLatest(failed: SnapshotSlot<TSnapshot>): void {
    if (!this.pending || failed.sequence > this.pending.sequence) {
      this.pending = failed;
    }
  }

  private readPending(): SnapshotSlot<TSnapshot> | undefined {
    return this.pending;
  }

  private scheduleRetry(error: TError | Error): void {
    const delay = this.options.retryDelaysMs[this.retryAttempt];
    if (delay === undefined) {
      this.setPhase('failed');
      this.options.onError(error, 'failed');
      this.resolveFlushWaiters(false);
      return;
    }

    this.retryAttempt += 1;
    this.setPhase('retrying');
    this.options.onError(error, 'retrying');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.drain();
    }, delay);
  }

  private setPhase(phase: AutosavePhase): void {
    this.phase = phase;
    this.emitState();
  }

  private emitState(): void {
    this.options.onStateChange(this.getState());
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer === undefined) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private resolveFlushWaiters(saved: boolean): void {
    for (const waiter of this.flushWaiters.splice(0)) waiter.resolve(saved);
  }
}
