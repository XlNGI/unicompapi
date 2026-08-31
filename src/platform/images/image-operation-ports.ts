import type {
  Execution,
  ImageOperationPurpose,
  ProviderSubmitOutcome,
  Task
} from '../../domain';

export interface ImageOperationSubmitRequest {
  readonly task: Task;
  readonly execution: Execution;
}

export interface LegacyImageOperationSubmitResult {
  readonly remoteOperationId: string;
  readonly state: 'queued' | 'processing';
}

export type ImageOperationSubmitResult =
  | ProviderSubmitOutcome
  | LegacyImageOperationSubmitResult;

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
    message: string,
    readonly submissionStatus:
      | 'failed_before_submission'
      | 'submission_outcome_unknown' = 'failed_before_submission'
  ) {
    super(message);
    this.name = 'ImageOperationPortError';
  }
}
