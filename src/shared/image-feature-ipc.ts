export const imageFeatureIpcChannels = {
  listCandidates: 'image-feature:list-candidates',
  prepareSubmission: 'image-feature:prepare-submission',
  submitDraft: 'image-feature:submit-draft',
  generateQuickImage: 'image-feature:generate-quick-image'
} as const;

export type ImageFeatureIpcErrorCode =
  | 'invalid_request'
  | 'project_not_open'
  | 'draft_not_found'
  | 'draft_revision_changed'
  | 'subject_invalid'
  | 'candidate_not_found'
  | 'candidate_unavailable'
  | 'route_selection_invalid'
  | 'route_selection_expired'
  | 'route_selection_consumed'
  | 'stale_route_selection'
  | 'confirmation_required'
  | 'runtime_not_allowed'
  | 'authorization_not_claimed'
  | 'submission_failed_before_request'
  | 'submission_outcome_unknown'
  | 'adapter_contract_invalid'
  | 'storage_error';

export type ImageFeatureIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ImageFeatureIpcErrorCode;
        readonly message: string;
      };
    };

export interface ImageFeatureParameterFieldDto {
  readonly fieldId: string;
  readonly labelId: string;
  readonly groupId?: string;
  readonly order: number;
  readonly valueType:
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'enum'
    | 'string_array'
    | 'number_array'
    | 'object'
    | 'media_slot';
  readonly exposure: string;
  readonly defaultPolicy: string;
  readonly required: boolean;
  readonly options?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
  readonly unitId?: string;
}

export interface ImageFeatureCandidateDto {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly providerName: string;
  readonly connectionName: string;
  readonly modelName: string;
  readonly parameterSchema: {
    readonly schemaVersion: 2;
    readonly schemaId: string;
    readonly revision: number;
    readonly productFeature: string;
    readonly fields: readonly ImageFeatureParameterFieldDto[];
  };
  readonly usageSchema: {
    readonly schemaVersion: 1;
    readonly schemaId: string;
    readonly revision: number;
  };
  readonly cost: {
    readonly state: 'known' | 'unknown' | 'not_applicable';
    readonly summary?: string;
  };
  readonly available: boolean;
  readonly unavailableReasons: readonly string[];
}

export interface ImageFeaturePreparationDto {
  readonly schemaVersion: 1;
  readonly routeSelectionToken: string;
  readonly expiresAt: string;
  readonly confirmation: {
    readonly schemaVersion: 1;
    readonly confirmationId: string;
    readonly productFeature: string;
    readonly providerName: string;
    readonly connectionName: string;
    readonly modelName: string;
    readonly recipientName: string;
    readonly outboundScope: 'external_service' | 'local_network' | 'local_device' | 'unknown';
    readonly contentCategories: readonly string[];
    readonly parameterFieldCount: number;
    readonly materialCount: number;
    readonly contextCount: number;
    readonly cost: {
      readonly state: 'known' | 'unknown' | 'not_applicable';
      readonly summary?: string;
    };
  };
}

export interface ImageFeatureSubmissionDto {
  readonly schemaVersion: 1;
  readonly submissionIntentId: string;
  readonly status:
    | 'authorization_pending'
    | 'authorization_not_claimed'
    | 'authorization_claimed'
    | 'request_started'
    | 'provider_accepted'
    | 'completed'
    | 'failed'
    | 'failed_before_submission'
    | 'cancelled'
    | 'unknown_outcome';
  readonly retryAllowed: false;
  readonly invocationAttemptId?: string;
  readonly taskId?: string;
  readonly executionId?: string;
  readonly workId?: string;
  readonly resultImageUrls?: readonly string[];
  /** Safe reason when provider completed but local image registration failed. */
  readonly localResultError?: string;
  /** Safe user-facing feedback for the submission outcome (success or failure). */
  readonly feedback?: string;
  /** Safe machine code associated with the feedback, when available. */
  readonly safeCode?: string;
}

export interface ImageFeatureGenerateQuickDto {
  readonly schemaVersion: 1;
  readonly draftId: string;
  readonly draftUpdatedAt: string;
  readonly submission: ImageFeatureSubmissionDto;
}

export interface ImageFeatureApi {
  listCandidates(
    draftId: string,
    draftUpdatedAt: string
  ): Promise<ImageFeatureIpcResult<readonly ImageFeatureCandidateDto[]>>;
  prepareSubmission(
    draftId: string,
    draftUpdatedAt: string,
    candidateId: string
  ): Promise<ImageFeatureIpcResult<ImageFeaturePreparationDto>>;
  submitDraft(
    draftId: string,
    draftUpdatedAt: string,
    routeSelectionToken: string,
    confirmationId: string,
    confirmed: boolean
  ): Promise<ImageFeatureIpcResult<ImageFeatureSubmissionDto>>;
  generateQuickImage(
    prompt: string,
    candidateId: string,
    parameterValues: Readonly<Record<string, string | number | boolean | readonly string[]>>
  ): Promise<ImageFeatureIpcResult<ImageFeatureGenerateQuickDto>>;
}
