export const promptEnhanceIpcChannels = {
  listCandidates: 'prompt-enhance:list-candidates',
  prepare: 'prompt-enhance:prepare',
  submit: 'prompt-enhance:submit'
} as const;

export type PromptEnhanceIpcErrorCode =
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
  | 'empty_prompt'
  | 'empty_result'
  | 'storage_error';

export type PromptEnhanceIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: PromptEnhanceIpcErrorCode;
        readonly message: string;
      };
    };

export interface PromptEnhanceCandidateDto {
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
    readonly fields: readonly {
      readonly fieldId: string;
      readonly labelId: string;
      readonly groupId?: string;
      readonly order: number;
      readonly valueType: string;
      readonly exposure: string;
      readonly defaultPolicy: string;
      readonly required: boolean;
      readonly options?: readonly (string | number | boolean)[];
      readonly minimum?: number;
      readonly maximum?: number;
      readonly step?: number;
      readonly unitId?: string;
    }[];
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

export interface PromptEnhancePreparationDto {
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

export interface PromptEnhanceSubmissionDto {
  readonly schemaVersion: 1;
  readonly status: 'completed' | 'failed';
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly enhancedText?: string;
  readonly safeCode?: string;
}

export interface PromptEnhanceApi {
  listCandidates(): Promise<
    PromptEnhanceIpcResult<readonly PromptEnhanceCandidateDto[]>
  >;
  prepare(
    subjectId: string,
    subjectRevision: string,
    candidateId: string,
    parameterValues: Readonly<Record<string, string | number | boolean | readonly string[]>>
  ): Promise<PromptEnhanceIpcResult<PromptEnhancePreparationDto>>;
  submit(
    subjectId: string,
    subjectRevision: string,
    routeSelectionToken: string,
    confirmationId: string,
    confirmed: boolean
  ): Promise<PromptEnhanceIpcResult<PromptEnhanceSubmissionDto>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

export const promptEnhanceRequestParsers = {
  listCandidates(value: unknown): {
    readonly productFeature: 'text_reasoning';
  } {
    if (!isRecord(value)) throw new TypeError('Invalid enhance list request');
    return { productFeature: 'text_reasoning' };
  },
  prepare(value: unknown): {
    readonly subjectId: string;
    readonly subjectRevision: string;
    readonly productFeature: 'text_reasoning';
    readonly candidateId: string;
    readonly parameterValues: Readonly<
      Record<string, string | number | boolean | readonly string[]>
    >;
  } {
    if (!isRecord(value)) throw new TypeError('Invalid enhance prepare request');
    const parameterValues = isRecord(value.parameterValues)
      ? (value.parameterValues as Readonly<
          Record<string, string | number | boolean | readonly string[]>
        >)
      : {};
    return {
      subjectId: requireString(value.subjectId, 'subjectId'),
      subjectRevision: requireString(value.subjectRevision, 'subjectRevision'),
      productFeature: 'text_reasoning',
      candidateId: requireString(value.candidateId, 'candidateId'),
      parameterValues
    };
  },
  submit(value: unknown): {
    readonly subjectId: string;
    readonly subjectRevision: string;
    readonly routeSelectionToken: string;
    readonly confirmationId: string;
    readonly confirmed: boolean;
  } {
    if (!isRecord(value)) throw new TypeError('Invalid enhance submit request');
    return {
      subjectId: requireString(value.subjectId, 'subjectId'),
      subjectRevision: requireString(value.subjectRevision, 'subjectRevision'),
      routeSelectionToken: requireString(value.routeSelectionToken, 'routeSelectionToken'),
      confirmationId: requireString(value.confirmationId, 'confirmationId'),
      confirmed: value.confirmed === true
    };
  }
};
