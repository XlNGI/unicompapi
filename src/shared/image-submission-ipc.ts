export const imageSubmissionIpcChannels = {
  preflight: 'image-submission:preflight',
  createTask: 'image-submission:create-task',
  createExecution: 'image-submission:create-execution',
  invokeExecution: 'image-submission:invoke-execution',
  receiveResult: 'image-submission:receive-result'
} as const;

export type ImageSubmissionErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'draft_not_found'
  | 'draft_not_submittable'
  | 'input_required'
  | 'no_route_candidate'
  | 'capability_unverified'
  | 'parameter_schema_missing'
  | 'parameters_invalid'
  | 'confirmation_required'
  | 'task_not_found'
  | 'execution_not_found'
  | 'invalid_execution_state'
  | 'adapter_unavailable'
  | 'download_failed'
  | 'result_verification_failed'
  | 'submission_storage_error';

export type ImageSubmissionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ImageSubmissionErrorCode;
        readonly message: string;
      };
    };

export interface ImageParameterFieldDto {
  readonly key: string;
  readonly label: string;
  readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  readonly required: boolean;
  readonly options?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ImagePreflightCandidateDto {
  readonly modelId: string;
  readonly modelName: string;
  readonly capabilityEvidenceId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly recipientName: string;
  readonly accessCategory: 'online' | 'local' | 'lan' | 'custom_remote';
  readonly outboundScope:
    | 'local_device'
    | 'local_network'
    | 'external_service'
    | 'unknown';
  readonly costState: 'unknown';
  readonly privacyState: 'unknown';
  readonly regionState: 'unknown';
  readonly parameterSchema: {
    readonly schemaVersion: 1;
    readonly fields: readonly ImageParameterFieldDto[];
  };
}

export interface ImagePreflightDto {
  readonly draftId: string;
  readonly draftUpdatedAt: string;
  readonly purpose:
    | 'image_generation'
    | 'image_understanding'
    | 'image_editing'
    | 'image_to_prompt';
  readonly candidates: readonly ImagePreflightCandidateDto[];
  readonly blockers: readonly ImageSubmissionErrorCode[];
  readonly requiresSubmissionConfirmation: true;
}

export interface ImageSubmissionConfirmationDto {
  readonly recipient: boolean;
  readonly outboundScope: boolean;
  readonly cost: boolean;
  readonly finalPrompt: boolean;
  readonly model: boolean;
}

export interface ImageTaskCreatedDto {
  readonly taskId: string;
  readonly draftId: string;
  readonly modelId: string;
  readonly confirmedAt: string;
}

export interface ImageExecutionDto {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly state: string;
  readonly retryability?: 'retryable' | 'not_retryable' | 'unknown';
}

export interface ImageWorkRegisteredDto {
  readonly workId: string;
  readonly executionId: string;
  readonly name: string;
}

export interface ImageSubmissionApi {
  preflight(draftId: string): Promise<ImageSubmissionResult<ImagePreflightDto>>;
  createTask(
    draftId: string,
    draftUpdatedAt: string,
    modelId: string,
    confirmations: ImageSubmissionConfirmationDto
  ): Promise<ImageSubmissionResult<ImageTaskCreatedDto>>;
  createExecution(
    taskId: string
  ): Promise<ImageSubmissionResult<ImageExecutionDto>>;
  invokeExecution(
    executionId: string
  ): Promise<ImageSubmissionResult<ImageExecutionDto>>;
  receiveResult(
    executionId: string
  ): Promise<ImageSubmissionResult<ImageWorkRegisteredDto>>;
}
