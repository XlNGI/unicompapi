import type {
  ExecutionId,
  FileReferenceId,
  ProviderOperationRecordId,
  TaskId,
  VideoExportPlanId,
  WorkId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import type { ExecutionState } from '../states/execution-state';

export type Retryability = 'retryable' | 'not_retryable' | 'unknown';

export interface ExecutionFailure {
  readonly stage: ExecutionState;
  readonly message: string;
  readonly retryability: Retryability;
}

export interface ExecutionUserAction {
  readonly code: 'source_unavailable' | 'destination_unavailable';
  readonly message: string;
}

export interface Execution {
  readonly schemaVersion: 1;
  readonly id: ExecutionId;
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly state: ExecutionState;
  readonly failure?: ExecutionFailure;
  readonly userAction?: ExecutionUserAction;
  readonly remoteOperationId?: string;
  readonly providerOperationRecordId?: ProviderOperationRecordId;
  readonly submissionOutcome?:
    | 'accepted_async'
    | 'completed_sync'
    | 'submission_outcome_unknown'
    | 'failed_before_submission';
  readonly exportPlanId?: VideoExportPlanId;
  readonly progress?: {
    readonly processedUs?: number;
    readonly totalUs?: number;
    readonly percent?: number;
  };
  readonly outputFileId?: FileReferenceId;
  readonly workId?: WorkId;
  readonly cancelRequestedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
