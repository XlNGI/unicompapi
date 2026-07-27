import {
  InvariantViolationError,
  InvalidStateTransitionError,
  RetryNotAllowedError
} from '../errors';
import type {
  Execution,
  ExecutionFailure,
  ExecutionUserAction
} from '../entities/execution';
import type { ExecutionId, TaskId } from '../ids';
import type { ExecutionState } from '../states/execution-state';
import { assertTimestampNotBefore, type IsoTimestamp } from '../timestamps';
import { requirePositiveInteger } from '../validation';

const allowedTransitions: Record<ExecutionState, readonly ExecutionState[]> = {
  created: ['submitting', 'queued', 'cancelled'],
  submitting: [
    'queued',
    'processing',
    'failed',
    'cancellation_unknown'
  ],
  queued: ['processing', 'validating_sources', 'cancel_requested', 'failed', 'expired', 'interrupted'],
  validating_sources: ['preparing_media', 'needs_user_action', 'cancel_requested', 'failed', 'interrupted'],
  preparing_media: ['encoding', 'needs_user_action', 'cancel_requested', 'failed', 'interrupted'],
  encoding: ['writing_file', 'cancel_requested', 'failed', 'interrupted'],
  writing_file: ['verifying_file', 'cancel_requested', 'failed', 'interrupted', 'recovery_required'],
  verifying_file: ['registering_work', 'failed', 'interrupted', 'recovery_required'],
  registering_work: ['completed', 'failed', 'interrupted', 'recovery_required'],
  processing: [
    'remote_completed',
    'cancel_requested',
    'failed',
    'expired'
  ],
  remote_completed: ['downloading', 'failed', 'expired'],
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
  needs_user_action: ['queued', 'cancelled', 'failed'],
  interrupted: ['recovery_required', 'failed'],
  recovery_required: ['queued', 'failed', 'cancelled'],
  failed: [],
  expired: []
};

export interface CreateExecutionInput {
  readonly id: ExecutionId;
  readonly taskId: TaskId;
  readonly attempt?: number;
  readonly createdAt: IsoTimestamp;
  readonly exportPlanId?: Execution['exportPlanId'];
}

export interface ExecutionTransitionContext {
  readonly failure?: ExecutionFailure;
  readonly userAction?: ExecutionUserAction;
  readonly remoteOperationId?: string;
  readonly progress?: Execution['progress'];
  readonly outputFileId?: Execution['outputFileId'];
  readonly workId?: Execution['workId'];
}

export function createExecution(input: CreateExecutionInput): Execution {
  return {
    schemaVersion: 1,
    id: input.id,
    taskId: input.taskId,
    attempt: requirePositiveInteger(input.attempt ?? 1, 'execution.attempt'),
    state: 'created',
    exportPlanId: input.exportPlanId,
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

  if (nextState === 'needs_user_action' && !context.userAction) {
    throw new InvariantViolationError(
      'needs_user_action execution transition requires user action evidence'
    );
  }

  if (context.userAction && nextState !== 'needs_user_action') {
    throw new InvariantViolationError(
      'user action evidence can only be attached to needs_user_action state'
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
    userAction: context.userAction,
    remoteOperationId:
      context.remoteOperationId ?? execution.remoteOperationId,
    progress: context.progress ?? execution.progress,
    outputFileId: context.outputFileId ?? execution.outputFileId,
    workId: context.workId ?? execution.workId,
    cancelRequestedAt: nextState === 'cancel_requested'
      ? updatedAt
      : execution.cancelRequestedAt,
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
    previous.state === 'interrupted' ||
    previous.state === 'recovery_required' ||
    previous.state === 'needs_user_action' ||
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
    createdAt,
    exportPlanId: previous.exportPlanId
  });
}
