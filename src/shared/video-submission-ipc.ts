export const videoSubmissionIpcChannels = {
  preflight: 'video-submission:preflight',
  createTask: 'video-submission:create-task',
  createExecution: 'video-submission:create-execution',
  invokeExecution: 'video-submission:invoke-execution',
  refreshExecution: 'video-submission:refresh-execution',
  cancelExecution: 'video-submission:cancel-execution',
  recoverExecutions: 'video-submission:recover-executions',
  receiveResult: 'video-submission:receive-result'
} as const;

export type VideoSubmissionErrorCode =
  | 'project_not_open'
  | 'invalid_request'
  | 'draft_not_found'
  | 'draft_not_submittable'
  | 'prompt_required'
  | 'no_route_candidate'
  | 'capability_unverified'
  | 'capability_snapshot_stale'
  | 'parameter_schema_missing'
  | 'mode_schema_missing'
  | 'mode_schema_invalid'
  | 'mode_unsupported'
  | 'parameters_invalid'
  | 'material_slots_stale'
  | 'material_required'
  | 'material_invalid'
  | 'shot_plan_invalid'
  | 'confirmation_required'
  | 'task_not_found'
  | 'execution_not_found'
  | 'invalid_execution_state'
  | 'submission_outcome_unknown'
  | 'adapter_unavailable'
  | 'result_discovery_failed'
  | 'download_failed'
  | 'result_verification_failed'
  | 'result_registration_failed'
  | 'submission_storage_error';

export type VideoSubmissionResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: VideoSubmissionErrorCode;
        readonly message: string;
      };
    };

export interface VideoParameterFieldDto {
  readonly key: string;
  readonly label: string;
  readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
  readonly required: boolean;
  readonly options?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface VideoMaterialSlotCapabilityDto {
  readonly id: string;
  readonly role: string;
  readonly required: boolean;
  readonly acceptedMediaKinds: readonly ('image' | 'video')[];
}

export type VideoModeCapabilityDto =
  | {
      readonly mode: 'quick_video';
      readonly reference?: {
        readonly acceptedMediaKinds: readonly ('image' | 'video')[];
      };
    }
  | {
      readonly mode: 'text_to_video';
      readonly materialSlots: readonly VideoMaterialSlotCapabilityDto[];
      readonly shotPlan: {
        readonly supported: boolean;
        readonly required: boolean;
        readonly minimumShots?: number;
        readonly maximumShots?: number;
      };
    }
  | {
      readonly mode: 'image_to_video';
      readonly materialSlots: readonly VideoMaterialSlotCapabilityDto[];
    };

export interface VideoPreflightCandidateDto {
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
    readonly fields: readonly VideoParameterFieldDto[];
  };
  readonly modeSchema: VideoModeCapabilityDto;
  readonly blockers: readonly VideoSubmissionErrorCode[];
}

export interface VideoPreflightDto {
  readonly draftId: string;
  readonly draftUpdatedAt: string;
  readonly purpose: 'video_generation';
  readonly candidates: readonly VideoPreflightCandidateDto[];
  readonly blockers: readonly VideoSubmissionErrorCode[];
  readonly requiresSubmissionConfirmation: true;
}

export interface VideoSubmissionConfirmationDto {
  readonly recipient: boolean;
  readonly outboundScope: boolean;
  readonly materials: boolean;
  readonly costPrivacyRegion: boolean;
  readonly finalPrompt: boolean;
  readonly model: boolean;
}

export interface VideoTaskCreatedDto {
  readonly taskId: string;
  readonly draftId: string;
  readonly modelId: string;
  readonly confirmedAt: string;
}

export interface VideoExecutionDto {
  readonly executionId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly state: string;
  readonly retryability?: 'retryable' | 'not_retryable' | 'unknown';
}

export interface VideoWorkRegisteredDto {
  readonly executionId: string;
  readonly works: readonly {
    readonly workId: string;
    readonly name: string;
  }[];
}

export interface VideoSubmissionApi {
  preflight(
    draftId: string
  ): Promise<VideoSubmissionResult<VideoPreflightDto>>;
  createTask(
    draftId: string,
    draftUpdatedAt: string,
    modelId: string,
    confirmations: VideoSubmissionConfirmationDto
  ): Promise<VideoSubmissionResult<VideoTaskCreatedDto>>;
  createExecution(
    taskId: string
  ): Promise<VideoSubmissionResult<VideoExecutionDto>>;
  invokeExecution(
    executionId: string
  ): Promise<VideoSubmissionResult<VideoExecutionDto>>;
  refreshExecution(
    executionId: string
  ): Promise<VideoSubmissionResult<VideoExecutionDto>>;
  cancelExecution(
    executionId: string
  ): Promise<VideoSubmissionResult<VideoExecutionDto>>;
  recoverExecutions(draftId: string): Promise<
    VideoSubmissionResult<readonly VideoExecutionDto[]>
  >;
  receiveResult(
    executionId: string
  ): Promise<VideoSubmissionResult<VideoWorkRegisteredDto>>;
}
