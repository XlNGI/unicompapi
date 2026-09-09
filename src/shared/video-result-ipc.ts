/** Shared result-landing types for video feature path (not a submission API surface). */

export type VideoResultErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'execution_not_found'
  | 'task_not_found'
  | 'invalid_execution_state'
  | 'adapter_unavailable'
  | 'result_discovery_failed'
  | 'download_failed'
  | 'result_verification_failed'
  | 'result_registration_failed'
  | 'submission_storage_error';

export type VideoResultIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: VideoResultErrorCode;
        readonly message: string;
      };
    };

export interface VideoWorkRegisteredDto {
  readonly executionId: string;
  readonly works: readonly {
    readonly workId: string;
    readonly name: string;
  }[];
}

/** @deprecated Alias kept while LocalVideoResultReceiver migrates naming. */
export type VideoSubmissionErrorCode = VideoResultErrorCode;
/** @deprecated Alias kept while LocalVideoResultReceiver migrates naming. */
export type VideoSubmissionResult<T> = VideoResultIpcResult<T>;
