export const videoFeatureIpcChannels = {
  listCandidates: 'video-feature:list-candidates',
  prepareSubmission: 'video-feature:prepare-submission',
  submitDraft: 'video-feature:submit-draft'
} as const;

export type VideoFeatureIpcErrorCode =
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

export type VideoFeatureIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: VideoFeatureIpcErrorCode;
        readonly message: string;
      };
    };

export interface VideoFeatureParameterFieldDto {
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

export interface VideoFeatureCandidateDto {
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
    readonly fields: readonly VideoFeatureParameterFieldDto[];
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

export interface VideoFeaturePreparationDto {
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

export interface VideoFeatureSubmissionDto {
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
  readonly workId?: string;
  readonly resultVideoUrls?: readonly string[];
  /** Safe reason when provider completed but local video registration failed. */
  readonly localResultError?: string;
  /** User-facing outcome copy when the request reached or left the local submission path. */
  readonly feedback?: string;
  readonly safeCode?: string;
}

export interface VideoFeatureApi {
  listCandidates(
    draftId: string,
    draftUpdatedAt: string
  ): Promise<VideoFeatureIpcResult<readonly VideoFeatureCandidateDto[]>>;
  prepareSubmission(
    draftId: string,
    draftUpdatedAt: string,
    candidateId: string
  ): Promise<VideoFeatureIpcResult<VideoFeaturePreparationDto>>;
  submitDraft(
    draftId: string,
    draftUpdatedAt: string,
    routeSelectionToken: string,
    confirmationId: string,
    confirmed: boolean
  ): Promise<VideoFeatureIpcResult<VideoFeatureSubmissionDto>>;
}
