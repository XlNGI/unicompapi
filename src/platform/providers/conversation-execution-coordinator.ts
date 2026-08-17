import type { ConversationResponseExecutionId } from '../../domain';

export interface ConversationExecutionOperation {
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly providerOperationId: string;
  cancel(): Promise<boolean>;
  readonly completion: Promise<unknown>;
}

export class ConversationExecutionCoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationExecutionCoordinatorError';
  }
}

interface ActiveConversationExecutionOperation extends ConversationExecutionOperation {
  cancellation?: Promise<boolean>;
}

/** Owns active provider handles; persisted execution state remains in the lifecycle. */
export class ConversationExecutionCoordinator {
  private readonly operations = new Map<ConversationResponseExecutionId, ActiveConversationExecutionOperation>();

  register(input: ConversationExecutionOperation): void {
    const executionId = input.responseExecutionId;
    if (this.operations.has(executionId)) {
      throw new ConversationExecutionCoordinatorError(
        'Conversation response execution already has an active provider operation'
      );
    }
    const operation: ActiveConversationExecutionOperation = { ...input };
    this.operations.set(executionId, operation);
    void input.completion.finally(() => {
      if (this.operations.get(executionId) === operation) {
        this.operations.delete(executionId);
      }
    }).catch(() => undefined);
  }

  has(responseExecutionId: ConversationResponseExecutionId): boolean {
    return this.operations.has(responseExecutionId);
  }

  async cancelAll(): Promise<number> {
    const active = [...this.operations.keys()];
    await Promise.all(active.map((executionId) => this.cancel(executionId)));
    return active.length;
  }

  async cancel(responseExecutionId: ConversationResponseExecutionId): Promise<boolean> {
    const operation = this.operations.get(responseExecutionId);
    if (!operation) return false;
    if (!operation.cancellation) {
      operation.cancellation = (async () => {
        const accepted = await operation.cancel();
        await operation.completion;
        return accepted;
      })();
      void operation.cancellation.finally(() => {
        operation.cancellation = undefined;
      }).catch(() => undefined);
    }
    return operation.cancellation;
  }
}
