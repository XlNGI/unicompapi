export const webResearchIpcChannels = {
  preview: 'conversation.web.preview',
  authorize: 'conversation.web.authorize',
  cancel: 'conversation.web.cancel',
  getStatus: 'conversation.web.getStatus'
} as const;

export type WebResearchIpcErrorCode =
  | 'invalid_request'
  | 'project_not_open'
  | 'workflow_not_found'
  | 'workflow_revision_conflict'
  | 'conversation_not_found'
  | 'revision_conflict'
  | 'workflow_not_ready'
  | 'web_authorization_required'
  | 'web_authorization_expired'
  | 'web_authorization_mismatch'
  | 'web_domain_not_allowed'
  | 'web_query_not_allowed'
  | 'web_provider_unconfigured'
  | 'web_credential_unavailable'
  | 'web_authentication_failed'
  | 'web_rate_limited'
  | 'web_timeout'
  | 'web_cancelled'
  | 'web_network_error'
  | 'web_response_invalid'
  | 'web_response_too_large'
  | 'web_no_results'
  | 'source_required_unavailable'
  | 'storage_error';

export type WebResearchIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: WebResearchIpcErrorCode;
        readonly message: string;
        readonly currentRevision?: number;
      };
    };

export interface WebResearchReferenceDto {
  readonly kind: 'local' | 'web';
  readonly citationId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly contentHash: string;
  readonly sourceKind?: string;
  readonly indexVersion?: string;
  readonly url?: string;
  readonly domain?: string;
  readonly publishedAt?: string;
  readonly retrievedAt?: string;
}

export interface WebResearchAuthorizationPreviewDto {
  readonly querySummary: string;
  readonly outboundSummary: string;
  readonly allowedDomains: readonly string[];
  readonly providerName: string;
  readonly expiresAt: string;
  readonly cost: {
    readonly state: 'known' | 'unknown' | 'not_applicable';
    readonly summary?: string;
  };
}

export interface WebResearchSessionDto {
  readonly workflowId: string;
  readonly workflowRevision: number;
  readonly conversationRevision: number;
  readonly planHash: string;
  readonly status:
    | 'local_ready'
    | 'authorization_required'
    | 'searching'
    | 'completed'
    | 'unavailable'
    | 'failed'
    | 'cancelled';
  readonly references: readonly WebResearchReferenceDto[];
  readonly authorization?: WebResearchAuthorizationPreviewDto;
  readonly failureCode?: WebResearchIpcErrorCode;
  readonly updatedAt: string;
}

export interface WebResearchPreviewRequest {
  readonly workflowId: string;
  readonly expectedWorkflowRevision: number;
  readonly expectedConversationRevision: number;
}

export interface WebResearchAuthorizeRequest extends WebResearchPreviewRequest {
  readonly planHash: string;
  readonly confirmed: true;
}

export interface WebResearchCancelRequest {
  readonly workflowId: string;
  readonly expectedWorkflowRevision: number;
}

export interface WebResearchStatusRequest {
  readonly workflowId: string;
}

export const webResearchRequestParsers = {
  preview(value: unknown): WebResearchPreviewRequest {
    const record = exactRecord(value, [
      'workflowId',
      'expectedWorkflowRevision',
      'expectedConversationRevision'
    ]);
    return {
      workflowId: controlledId(record.workflowId, 'workflowId'),
      expectedWorkflowRevision: revision(
        record.expectedWorkflowRevision,
        'expectedWorkflowRevision'
      ),
      expectedConversationRevision: revision(
        record.expectedConversationRevision,
        'expectedConversationRevision'
      )
    };
  },
  authorize(value: unknown): WebResearchAuthorizeRequest {
    const record = exactRecord(value, [
      'workflowId',
      'expectedWorkflowRevision',
      'expectedConversationRevision',
      'planHash',
      'confirmed'
    ]);
    if (record.confirmed !== true) {
      throw new TypeError('confirmed must be true');
    }
    if (typeof record.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.planHash)) {
      throw new TypeError('planHash is invalid');
    }
    return {
      workflowId: controlledId(record.workflowId, 'workflowId'),
      expectedWorkflowRevision: revision(
        record.expectedWorkflowRevision,
        'expectedWorkflowRevision'
      ),
      expectedConversationRevision: revision(
        record.expectedConversationRevision,
        'expectedConversationRevision'
      ),
      planHash: record.planHash,
      confirmed: true
    };
  },
  cancel(value: unknown): WebResearchCancelRequest {
    const record = exactRecord(value, ['workflowId', 'expectedWorkflowRevision']);
    return {
      workflowId: controlledId(record.workflowId, 'workflowId'),
      expectedWorkflowRevision: revision(
        record.expectedWorkflowRevision,
        'expectedWorkflowRevision'
      )
    };
  },
  status(value: unknown): WebResearchStatusRequest {
    const record = exactRecord(value, ['workflowId']);
    return { workflowId: controlledId(record.workflowId, 'workflowId') };
  }
} as const;

export interface WebResearchApi {
  preview(
    request: WebResearchPreviewRequest
  ): Promise<WebResearchIpcResult<WebResearchSessionDto>>;
  authorize(
    request: WebResearchAuthorizeRequest
  ): Promise<WebResearchIpcResult<WebResearchSessionDto>>;
  cancel(
    request: WebResearchCancelRequest
  ): Promise<WebResearchIpcResult<WebResearchSessionDto>>;
  getStatus(
    request: WebResearchStatusRequest
  ): Promise<WebResearchIpcResult<WebResearchSessionDto | null>>;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Request must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const actual = Object.keys(record);
  if (actual.length !== allowed.size || actual.some((key) => !allowed.has(key))) {
    throw new TypeError('Request contains unexpected or missing fields');
  }
  return record;
}

function controlledId(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} is invalid`);
  }
  return Number(value);
}
