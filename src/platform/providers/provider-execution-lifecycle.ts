import {
  createProviderOperationRecord,
  isTerminalExecutionState,
  toIsoTimestamp,
  transitionExecution,
  type Execution,
  type ExecutionRepository,
  type ProviderExecutionLifecycle,
  type ProviderMediaKind,
  type ProviderOperationRecord,
  type ProviderOperationRecordId,
  type ProviderOperationRepository,
  type ProviderSubmitOutcome,
  type Task
} from '../../domain';

export interface ProviderExecutionLifecycleDependencies {
  readonly executionRepository: ExecutionRepository;
  readonly operationRepository: ProviderOperationRepository;
  readonly createRecordId: () => ProviderOperationRecordId;
  readonly now?: () => string;
}

export class ProviderExecutionLifecycleService {
  constructor(
    private readonly dependencies: ProviderExecutionLifecycleDependencies
  ) {}

  async applySubmitOutcome(input: {
    readonly task: Task;
    readonly execution: Execution;
    readonly mediaKind: Exclude<ProviderMediaKind, 'unknown'>;
    readonly executionLifecycle: ProviderExecutionLifecycle;
    readonly outcome: ProviderSubmitOutcome;
  }): Promise<Execution> {
    if (input.execution.taskId !== input.task.id) {
      throw new TypeError('provider outcome task does not match execution');
    }
    if (input.execution.state !== 'submitting') {
      throw new TypeError('provider outcome requires a submitting execution');
    }
    const now = this.now();
    const record = createProviderOperationRecord({
      id: this.dependencies.createRecordId(),
      taskId: input.task.id,
      executionId: input.execution.id,
      mediaKind: input.mediaKind,
      executionLifecycle: input.executionLifecycle,
      outcome: input.outcome,
      createdAt: now,
      updatedAt: now
    });
    await this.dependencies.operationRepository.save(record);
    const updated = transitionForOutcome(input.execution, record, now);
    await this.dependencies.executionRepository.save(updated);
    return updated;
  }

  async applyUnrecordedSubmitOutcome(input: {
    readonly executionId: Execution['id'];
    readonly outcome: 'failed_before_submission' | 'submission_outcome_unknown';
    readonly message: string;
  }): Promise<Execution | undefined> {
    const current = await this.dependencies.executionRepository.get(
      input.executionId
    );
    if (!current || current.state !== 'created') return current;
    const now = this.now();
    const submitting = transitionExecution(current, 'submitting', now);
    const updated = input.outcome === 'failed_before_submission'
      ? transitionExecution(submitting, 'failed', now, {
          failure: {
            stage: 'submitting',
            message: input.message,
            retryability: 'not_retryable'
          }
        })
      : transitionExecution(submitting, 'submission_outcome_unknown', now);
    await this.dependencies.executionRepository.save(updated);
    return updated;
  }

  async recoverExecution(
    recordId: ProviderOperationRecordId
  ): Promise<Execution> {
    const record = await this.dependencies.operationRepository.get(recordId);
    if (!record) throw new TypeError('provider operation record not found');
    const execution = await this.dependencies.executionRepository.get(
      record.executionId
    );
    if (!execution) throw new TypeError('provider operation execution not found');
    if (execution.providerOperationRecordId === record.id) return execution;
    if (execution.state !== 'submitting') {
      throw new TypeError('provider operation recovery found an incompatible state');
    }
    const recovered = transitionForOutcome(execution, record, this.now());
    await this.dependencies.executionRepository.save(recovered);
    return recovered;
  }

  async listRecoverable(): Promise<readonly ProviderOperationRecord[]> {
    const records = await this.dependencies.operationRepository.list();
    const recoverable: ProviderOperationRecord[] = [];
    for (const record of records) {
      const execution = await this.dependencies.executionRepository.get(
        record.executionId
      );
      if (
        execution &&
        (!isTerminalExecutionState(execution.state) ||
          execution.state === 'submission_outcome_unknown')
      ) {
        recoverable.push(record);
      }
    }
    return recoverable;
  }

  private now() {
    return toIsoTimestamp(
      this.dependencies.now?.() ?? new Date().toISOString()
    );
  }
}

function transitionForOutcome(
  execution: Execution,
  record: ProviderOperationRecord,
  now: ReturnType<typeof toIsoTimestamp>
): Execution {
  const common = {
    providerOperationRecordId: record.id,
    submissionOutcome: record.outcome.kind
  } as const;
  if (record.outcome.kind === 'accepted_async') {
    return transitionExecution(execution, record.outcome.state, now, {
      ...common,
      remoteOperationId: record.outcome.providerOperationId
    });
  }
  if (record.outcome.kind === 'completed_sync') {
    return transitionExecution(execution, 'remote_completed', now, common);
  }
  if (record.outcome.kind === 'submission_outcome_unknown') {
    return transitionExecution(
      execution,
      'submission_outcome_unknown',
      now,
      common
    );
  }
  return transitionExecution(execution, 'failed', now, {
    ...common,
    failure: {
      stage: 'submitting',
      message: record.outcome.message,
      retryability: record.outcome.retryability
    }
  });
}

export type ProviderAsyncOperationStatus =
  | { readonly state: 'queued' | 'processing' }
  | { readonly state: 'completed' }
  | {
      readonly state: 'failed';
      readonly message: string;
      readonly retryability: 'retryable' | 'not_retryable' | 'unknown';
    }
  | { readonly state: 'cancelled' | 'expired' };

export type ProviderCancelOutcome =
  | { readonly state: 'cancelled' }
  | { readonly state: 'processing' }
  | { readonly state: 'unknown' };

export interface ProviderAsyncOperationPort {
  query(providerOperationId: string): Promise<ProviderAsyncOperationStatus>;
  cancel(providerOperationId: string): Promise<ProviderCancelOutcome>;
}

export class ProviderAsyncOperationCoordinator {
  constructor(
    private readonly executionRepository: ExecutionRepository,
    private readonly operationRepository: ProviderOperationRepository,
    private readonly port: ProviderAsyncOperationPort,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async refresh(recordId: ProviderOperationRecordId): Promise<Execution> {
    const context = await this.loadAsyncContext(recordId);
    const status = await this.port.query(context.providerOperationId);
    let execution = context.execution;
    const updatedAt = toIsoTimestamp(this.now());
    if (status.state === execution.state) return execution;
    if (status.state === 'queued' && execution.state === 'processing') {
      return execution;
    }
    if (status.state === 'queued' || status.state === 'processing') {
      execution = transitionExecution(execution, status.state, updatedAt);
    } else if (status.state === 'completed') {
      execution = transitionExecution(execution, 'remote_completed', updatedAt);
    } else if (status.state === 'failed') {
      execution = transitionExecution(execution, 'failed', updatedAt, {
        failure: {
          stage: execution.state,
          message: status.message,
          retryability: status.retryability
        }
      });
    } else {
      execution = transitionExecution(execution, status.state, updatedAt);
    }
    await this.executionRepository.save(execution);
    return execution;
  }

  async cancel(recordId: ProviderOperationRecordId): Promise<Execution> {
    const context = await this.loadAsyncContext(recordId);
    let execution = context.execution;
    const requestedAt = toIsoTimestamp(this.now());
    if (execution.state === 'queued' || execution.state === 'processing') {
      execution = transitionExecution(execution, 'cancel_requested', requestedAt);
      await this.executionRepository.save(execution);
    }
    const outcome = await this.port.cancel(context.providerOperationId);
    const resolvedAt = toIsoTimestamp(this.now());
    if (outcome.state === 'cancelled') {
      execution = transitionExecution(execution, 'cancelled', resolvedAt);
    } else if (outcome.state === 'processing') {
      execution = transitionExecution(execution, 'processing', resolvedAt);
    } else {
      execution = transitionExecution(
        execution,
        'cancellation_unknown',
        resolvedAt
      );
    }
    await this.executionRepository.save(execution);
    return execution;
  }

  private async loadAsyncContext(recordId: ProviderOperationRecordId) {
    const record = await this.operationRepository.get(recordId);
    if (
      !record ||
      record.executionLifecycle !== 'asynchronous_polling' ||
      (record.outcome.kind !== 'accepted_async' &&
        record.outcome.kind !== 'submission_outcome_unknown')
    ) {
      throw new TypeError('provider operation is not asynchronously queryable');
    }
    const providerOperationId = record.outcome.providerOperationId;
    if (!providerOperationId) {
      throw new TypeError('provider operation ID is unavailable');
    }
    const execution = await this.executionRepository.get(record.executionId);
    if (!execution) throw new TypeError('provider operation execution not found');
    return { execution, providerOperationId };
  }
}
