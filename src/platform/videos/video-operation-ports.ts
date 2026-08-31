import type { Execution, ProviderSubmitOutcome, Task } from '../../domain';

export interface VideoGenerationSubmitRequest {
  readonly task: Task;
  readonly execution: Execution;
}

export interface LegacyVideoGenerationSubmitResult {
  readonly remoteOperationId: string;
  readonly state: 'queued' | 'processing';
}

export type VideoGenerationSubmitResult =
  | ProviderSubmitOutcome
  | LegacyVideoGenerationSubmitResult;

export interface VideoGenerationSubmitPort {
  submit(
    request: VideoGenerationSubmitRequest
  ): Promise<VideoGenerationSubmitResult>;
}

export class VideoOperationPortError extends Error {
  constructor(
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    message: string,
    readonly submissionStatus:
      | 'failed_before_submission'
      | 'submission_outcome_unknown' = 'failed_before_submission'
  ) {
    super(message);
    this.name = 'VideoOperationPortError';
  }
}
