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
}

interface PendingCancellation {
  readonly onCancellationTimeout?: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns active provider handles; persisted execution state remains in the lifecycle. */
export class ConversationExecutionCoordinator {
  private readonly operations = new Map<ConversationResponseExecutionId, ActiveConversationExecutionOperation>();
  private readonly pendingCancellations = new Map<ConversationResponseExecutionId, PendingCancellation>();

  constructor(private readonly cancellationTimeoutMs = 5_000) {
    if (!Number.isSafeInteger(cancellationTimeoutMs) || cancellationTimeoutMs < 1) {
      throw new TypeError('Conversation cancellation timeout is invalid');
    }
  }

  register(input: ConversationExecutionOperation): void {
    const executionId = input.responseExecutionId;
    if (this.operations.has(executionId)) {
      throw new ConversationExecutionCoordinatorError(
        'Conversation response execution already has an active provider operation'
      );
    }
    const operation: ActiveConversationExecutionOperation = { ...input };
    this.operations.set(executionId, operation);
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
    }).catch(() => undefined);
  }

  has(responseExecutionId: ConversationResponseExecutionId): boolean {
    return this.operations.has(responseExecutionId);
  }

  async cancelAll(): Promise<number> {
    const active = [...this.operations.entries()];
    await Promise.all(active.map(([executionId]) => this.cancel(executionId)));
    await Promise.all(active.map(([, operation]) => Promise.race([
      operation.completion.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, this.cancellationTimeoutMs))
    ])));
    return active.length;
  }

  async cancel(
    responseExecutionId: ConversationResponseExecutionId,
    onCancellationTimeout?: () => Promise<void>
  ): Promise<boolean> {
    const operation = this.operations.get(responseExecutionId);
    if (!operation) {
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
        onCancellationTimeout
      };
      pending.timer = setTimeout(() => {
        const current = this.pendingCancellations.get(responseExecutionId);
        if (current !== pending) return;
        current.timer = undefined;
        void current.onCancellationTimeout?.().catch(() => undefined);
      }, this.cancellationTimeoutMs);
      this.pendingCancellations.set(responseExecutionId, pending);
      return true;
    }
    if (!operation.cancellation) {
      operation.cancellation = operation.cancel();
      void operation.cancellation.then((accepted) => {
        if (!accepted || !operation.onCancellationTimeout) return;
        operation.cancellationTimer = setTimeout(() => {
          operation.cancellationTimer = undefined;
          if (this.operations.get(responseExecutionId) !== operation) return;
          void operation.onCancellationTimeout?.().catch(() => undefined);
        }, this.cancellationTimeoutMs);
      }).catch(() => undefined);
    }
    return operation.cancellation;
  }
}
