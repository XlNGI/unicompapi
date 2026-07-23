import type { Execution, ImageOperationPurpose, Task } from '../../domain';

export interface ImageOperationSubmitRequest {
  readonly task: Task;
  readonly execution: Execution;
}

export interface ImageOperationSubmitResult {
  readonly remoteOperationId: string;
  readonly state: 'queued' | 'processing';
}

export interface ImageOperationSubmitPort {
  submit(
    request: ImageOperationSubmitRequest
  ): Promise<ImageOperationSubmitResult>;
}

export type ImageOperationPorts = Partial<
  Record<ImageOperationPurpose, ImageOperationSubmitPort>
>;

export class ImageOperationPortError extends Error {
  constructor(
    readonly retryability: 'retryable' | 'not_retryable' | 'unknown',
    message: string
  ) {
    super(message);
    this.name = 'ImageOperationPortError';
  }
}
