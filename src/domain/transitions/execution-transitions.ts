import {
  InvariantViolationError,
  InvalidStateTransitionError,
  RetryNotAllowedError
} from '../errors';
import type {
  Execution,
  ExecutionFailure
} from '../entities/execution';
import type { ExecutionId, TaskId } from '../ids';
import type { ExecutionState } from '../states/execution-state';
import { assertTimestampNotBefore, type IsoTimestamp } from '../timestamps';
import { requirePositiveInteger } from '../validation';

const allowedTransitions: Record<ExecutionState, readonly ExecutionState[]> = {
  created: ['submitting', 'cancelled'],
  submitting: [
    'queued',
    'processing',
    'failed',
    'cancellation_unknown'
  ],
  queued: ['processing', 'cancel_requested', 'failed', 'expired'],
  processing: [
    'remote_completed',
    'cancel_requested',
    'failed',
    'expired'
  ],
  remote_completed: ['downloading', 'expired'],
  downloading: ['writing', 'failed', 'expired'],
  writing: ['verifying', 'failed'],
  verifying: ['completed', 'failed'],
  completed: [],
  cancel_requested: [
    'cancelled',
    'cancellation_unknown',
    'processing',
    'remote_completed',
    'failed'
  ],
  cancelled: [],
  cancellation_unknown: [
    'processing',
    'remote_completed',
    'cancelled',
    'failed',
    'expired'
  ],
  failed: [],
  expired: []
};

export interface CreateExecutionInput {
  readonly id: ExecutionId;
  readonly taskId: TaskId;
  readonly attempt?: number;
  readonly createdAt: IsoTimestamp;
}

export interface ExecutionTransitionContext {
  readonly failure?: ExecutionFailure;
  readonly remoteOperationId?: string;
}

export function createExecution(input: CreateExecutionInput): Execution {
  return {
    schemaVersion: 1,
    id: input.id,
    taskId: input.taskId,
    attempt: requirePositiveInteger(input.attempt ?? 1, 'execution.attempt'),
    state: 'created',
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

export function canTransitionExecution(
  from: ExecutionState,
  to: ExecutionState
): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionExecution(
  execution: Execution,
  nextState: ExecutionState,
  updatedAt: IsoTimestamp,
  context: ExecutionTransitionContext = {}
): Execution {
  if (!canTransitionExecution(execution.state, nextState)) {
    throw new InvalidStateTransitionError(
      'execution',
      execution.state,
      nextState
    );
  }

  assertTimestampNotBefore(
    updatedAt,
    execution.updatedAt,
    'execution.updatedAt'
  );

  if (nextState === 'failed' && !context.failure) {
    throw new InvariantViolationError(
      'failed execution transition requires failure evidence'
    );
  }

  if (context.failure && nextState !== 'failed') {
    throw new InvariantViolationError(
      'failure evidence can only be attached to failed state'
    );
  }

  if (
    context.remoteOperationId !== undefined &&
    nextState !== 'queued' &&
    nextState !== 'processing'
  ) {
    throw new InvariantViolationError(
      'remote operation ID can only be attached after submission'
    );
  }

  return {
    ...execution,
    state: nextState,
    failure: context.failure,
    remoteOperationId:
      context.remoteOperationId ?? execution.remoteOperationId,
    updatedAt
  };
}

export function createRetryExecution(
  previous: Execution,
  id: ExecutionId,
  createdAt: IsoTimestamp
): Execution {
  if (id === previous.id) {
    throw new RetryNotAllowedError('retry must use a new execution id');
  }

  if (previous.state === 'cancellation_unknown') {
    throw new RetryNotAllowedError(
      'cannot retry while remote cancellation status is unknown'
    );
  }

  const retryAllowed =
    previous.state === 'cancelled' ||
    previous.state === 'expired' ||
    (previous.state === 'failed' &&
      previous.failure?.retryability === 'retryable');

  if (!retryAllowed) {
    throw new RetryNotAllowedError(
      `execution in ${previous.state} state is not retryable`
    );
  }

  return createExecution({
    id,
    taskId: previous.taskId,
    attempt: previous.attempt + 1,
    createdAt
  });
}
