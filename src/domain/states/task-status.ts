import { InvariantViolationError } from '../errors';
import type { Execution } from '../entities/execution';
import type { Task } from '../entities/task';
import type { ExecutionState } from './execution-state';

export type TaskStatus =
  | 'awaiting_execution'
  | 'submitting'
  | 'submission_outcome_unknown'
  | 'active'
  | 'remote_completed'
  | 'localizing'
  | 'completed'
  | 'cancel_requested'
  | 'cancelled'
  | 'cancellation_unknown'
  | 'failed'
  | 'expired';

const taskStatusByExecutionState: Record<ExecutionState, TaskStatus> = {
  created: 'awaiting_execution',
  submitting: 'submitting',
  submission_outcome_unknown: 'submission_outcome_unknown',
  queued: 'active',
  processing: 'active',
  validating_sources: 'active',
  preparing_media: 'active',
  encoding: 'active',
  writing_file: 'localizing',
  verifying_file: 'localizing',
  registering_work: 'localizing',
  remote_completed: 'remote_completed',
  downloading: 'localizing',
  writing: 'localizing',
  verifying: 'localizing',
  completed: 'completed',
  cancel_requested: 'cancel_requested',
  cancelled: 'cancelled',
  cancellation_unknown: 'cancellation_unknown',
  needs_user_action: 'failed',
  interrupted: 'failed',
  recovery_required: 'failed',
  failed: 'failed',
  expired: 'expired'
};

export function deriveTaskStatus(
  task: Task,
  executions: readonly Execution[]
): TaskStatus {
  if (task.executionIds.length === 0) {
    return 'awaiting_execution';
  }

  const executionById = new Map(
    executions.map((execution) => [execution.id, execution])
  );
  const latestExecutionId = task.executionIds[task.executionIds.length - 1];
  const latestExecution = latestExecutionId
    ? executionById.get(latestExecutionId)
    : undefined;

  if (!latestExecution) {
    throw new InvariantViolationError(
      'latest task execution is missing from status projection'
    );
  }

  if (latestExecution.taskId !== task.id) {
    throw new InvariantViolationError(
      'latest execution belongs to another task'
    );
  }

  return taskStatusByExecutionState[latestExecution.state];
}
