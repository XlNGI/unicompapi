import type { Execution, Task } from '../../domain';

export interface VideoGenerationSubmitRequest {
  readonly task: Task;
  readonly execution: Execution;
}

export interface VideoGenerationSubmitResult {
  readonly remoteOperationId: string;
  readonly state: 'queued' | 'processing';
}

export interface VideoGenerationSubmitPort {
  submit(
    request: VideoGenerationSubmitRequest
  ): Promise<VideoGenerationSubmitResult>;
}

export class VideoOperationPortError extends Error {
  constructor(
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    message: string
  ) {
    super(message);
    this.name = 'VideoOperationPortError';
  }
}
