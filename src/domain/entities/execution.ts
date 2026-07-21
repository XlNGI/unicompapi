import type { ExecutionId, TaskId } from '../ids';
import type { IsoTimestamp } from '../timestamps';
import type { ExecutionState } from '../states/execution-state';

export type Retryability = 'retryable' | 'not_retryable' | 'unknown';

export interface ExecutionFailure {
  readonly stage: ExecutionState;
  readonly message: string;
  readonly retryability: Retryability;
}

export interface Execution {
  readonly schemaVersion: 1;
  readonly id: ExecutionId;
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly state: ExecutionState;
  readonly failure?: ExecutionFailure;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
