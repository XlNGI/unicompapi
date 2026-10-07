import type { ConversationResponseExecutionId } from '../../domain';

export interface ConversationExecutionOperation {
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly providerOperationId: string;
  cancel(): Promise<boolean>;
  readonly completion: Promise<unknown>;
  onCancellationTimeout?(): Promise<void>;
}

export class ConversationExecutionCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationExecutionCoordinatorError';
  }
}

interface ActiveConversationExecutionOperation extends ConversationExecutionOperation {
  cancellation?: Promise<boolean>;
  cancellationTimer?: ReturnType<typeof setTimeout>;
  cancellationDeadlineAt?: number;
  cancellationTimeoutNotified?: boolean;
}

interface PendingCancellation {
  readonly onCancellationTimeout?: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  readonly cancelledAt?: number;
  notified?: boolean;
}

interface StartingOperation {
  readonly controller: AbortController;
  readonly onCancellationTimeout?: () => Promise<void>;
  cancelledAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  notified?: boolean;
}

/** Owns active provider handles; persisted execution state remains in the lifecycle. */
export class ConversationExecutionCoordinator {
  private readonly operations = new Map<ConversationResponseExecutionId, ActiveConversationExecutionOperation>();
  private readonly pendingCancellations = new Map<ConversationResponseExecutionId, PendingCancellation>();
  private readonly starting = new Map<ConversationResponseExecutionId, StartingOperation>();
  private readonly startupSignals = new Map<ConversationResponseExecutionId, { signal: AbortSignal; remove: () => void }>();

  constructor(private readonly cancellationTimeoutMs = 5_000) {
    if (!Number.isSafeInteger(cancellationTimeoutMs) || cancellationTimeoutMs < 1) {
      throw new TypeError('Conversation cancellation timeout is invalid');
    }
  }

  /** Retain the host startup cancellation across artifact creation and dispatch. */
  bindStartupSignal(responseExecutionId: ConversationResponseExecutionId, signal: AbortSignal): void {
    this.releaseStartupSignal(responseExecutionId);
    const cancel = () => { void this.cancel(responseExecutionId).catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    this.startupSignals.set(responseExecutionId, { signal, remove: () => signal.removeEventListener('abort', cancel) });
    if (signal.aborted) cancel();
  }

  releaseStartupSignal(responseExecutionId: ConversationResponseExecutionId): void {
    this.startupSignals.get(responseExecutionId)?.remove();
    this.startupSignals.delete(responseExecutionId);
    if (!this.operations.has(responseExecutionId) && !this.starting.has(responseExecutionId)) {
      clearTimeout(this.pendingCancellations.get(responseExecutionId)?.timer);
      this.pendingCancellations.delete(responseExecutionId);
    }
  }

  /** Admit cancellation before session preparation or the HTTP headers can finish. */
  beginStarting(responseExecutionId: ConversationResponseExecutionId, onCancellationTimeout?: () => Promise<void>): {
    readonly signal: AbortSignal; release(): void;
  } {
    if (this.operations.has(responseExecutionId) || this.starting.has(responseExecutionId)) {
      throw new ConversationExecutionCoordinatorError('Conversation response execution already has a starting operation');
    }
    const operation: StartingOperation = { controller: new AbortController(), onCancellationTimeout };
    this.starting.set(responseExecutionId, operation);
    if (this.startupSignals.get(responseExecutionId)?.signal.aborted && !this.pendingCancellations.has(responseExecutionId)) {
      void this.cancel(responseExecutionId).catch(() => undefined);
    }
    const pending = this.pendingCancellations.get(responseExecutionId);
    if (pending) { operation.cancelledAt = pending.cancelledAt; operation.controller.abort(); }
    return { signal: operation.controller.signal, release: () => {
      if (this.starting.get(responseExecutionId) === operation) this.starting.delete(responseExecutionId);
      if (!operation.controller.signal.aborted || this.operations.has(responseExecutionId)) clearTimeout(operation.timer);
    } };
  }

  register(input: ConversationExecutionOperation): void {
    const executionId = input.responseExecutionId;
    if (this.operations.has(executionId)) {
      throw new ConversationExecutionCoordinatorError(
        'Conversation response execution already has an active provider operation'
      );
    }
    const queued = this.pendingCancellations.get(executionId);
    const lease = this.starting.get(executionId);
    const cancelledAt = lease?.cancelledAt ?? queued?.cancelledAt;
    const operation: ActiveConversationExecutionOperation = { ...input,
      ...(cancelledAt === undefined ? {} : { cancellationDeadlineAt: cancelledAt + this.cancellationTimeoutMs }),
      cancellationTimeoutNotified: Boolean(lease?.notified || queued?.notified) };
    this.operations.set(executionId, operation);
    const starting = this.starting.get(executionId);
    if (starting?.controller.signal.aborted) {
      clearTimeout(starting.timer);
      void this.cancel(executionId).catch(() => undefined);
    }
    const pending = this.pendingCancellations.get(executionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCancellations.delete(executionId);
      void this.cancel(executionId).catch(() => undefined);
    }
    void input.completion.finally(() => {
      if (operation.cancellationTimer) clearTimeout(operation.cancellationTimer);
      if (this.operations.get(executionId) === operation) {
        this.operations.delete(executionId);
      }
      this.releaseStartupSignal(executionId);
    }).catch(() => undefined);
  }

  has(responseExecutionId: ConversationResponseExecutionId): boolean {
    return this.operations.has(responseExecutionId) || this.starting.has(responseExecutionId);
  }

  /** A published response terminal state can precede its dependent local projections. */
  async waitForCompletedOperations(isCompleted: (id: ConversationResponseExecutionId) => Promise<boolean>): Promise<void> {
    await Promise.all([...this.operations.values()].map(async operation => {
      if (!await isCompleted(operation.responseExecutionId)) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([operation.completion.then(() => undefined, () => undefined),
          new Promise<void>(resolve => { timer = setTimeout(resolve, this.cancellationTimeoutMs); })]);
      } finally { clearTimeout(timer); }
      // A timed-out owner remains registered. Its durable completion gate still
      // blocks another command; this read barrier cannot grant execution rights.
    }));
  }

  async cancelAll(): Promise<number> {
    const starting = [...this.starting.keys()];
    await Promise.all(starting.map(executionId => this.cancel(executionId)));
    const active = [...this.operations.entries()];
    await Promise.all(active.map(([executionId]) => this.cancel(executionId)));
    await Promise.all(active.map(([, operation]) => Promise.race([
      operation.completion.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, this.cancellationTimeoutMs))
    ])));
    return new Set([...starting, ...active.map(([id]) => id)]).size;
  }

  async cancel(
    responseExecutionId: ConversationResponseExecutionId,
    onCancellationTimeout?: () => Promise<void>
  ): Promise<boolean> {
    const operation = this.operations.get(responseExecutionId);
    if (!operation) {
      const starting = this.starting.get(responseExecutionId);
      if (starting) {
        if (!starting.controller.signal.aborted) {
          starting.cancelledAt = performance.now();
          starting.controller.abort();
          starting.timer = setTimeout(() => {
            starting.timer = undefined;
            starting.notified = true;
            void (starting.onCancellationTimeout ?? onCancellationTimeout)?.().catch(() => undefined);
          }, this.cancellationTimeoutMs);
        }
        return true;
      }
      const existing = this.pendingCancellations.get(responseExecutionId);
      if (existing) return true;
      if (this.pendingCancellations.size >= 256) {
        const oldest = this.pendingCancellations.keys().next().value as
          | ConversationResponseExecutionId
          | undefined;
        if (oldest) {
          const evicted = this.pendingCancellations.get(oldest);
          if (evicted?.timer) clearTimeout(evicted.timer);
          this.pendingCancellations.delete(oldest);
        }
      }
      const pending: PendingCancellation = {
        onCancellationTimeout, cancelledAt: performance.now()
      };
      pending.timer = setTimeout(() => {
        const current = this.pendingCancellations.get(responseExecutionId);
        if (current !== pending) return;
        current.timer = undefined;
        current.notified = true;
        void current.onCancellationTimeout?.().catch(() => undefined);
      }, this.cancellationTimeoutMs);
      this.pendingCancellations.set(responseExecutionId, pending);
      return true;
    }
    if (!operation.cancellation) {
      operation.cancellationDeadlineAt ??= performance.now() + this.cancellationTimeoutMs;
      operation.cancellation = operation.cancel();
      void operation.cancellation.then((accepted) => {
        if (!accepted || !operation.onCancellationTimeout || operation.cancellationTimeoutNotified) return;
        operation.cancellationTimer = setTimeout(() => {
          operation.cancellationTimer = undefined;
          if (this.operations.get(responseExecutionId) !== operation) return;
          operation.cancellationTimeoutNotified = true;
          void operation.onCancellationTimeout?.().catch(() => undefined);
        }, Math.ceil(Math.max(0, operation.cancellationDeadlineAt! - performance.now())));
      }).catch(() => undefined);
    }
    return operation.cancellation;
  }
}
