export const providerIpcChannels = {
  getRegistry: 'providers:get-registry',
  saveCredential: 'providers:save-credential',
  deleteLocalCredential: 'providers:delete-local-credential',
  getCredentialStatus: 'providers:get-credential-status',
  checkCredentialStorage: 'providers:check-credential-storage',
  validateConnection: 'providers:validate-connection',
  syncModelCatalog: 'providers:sync-model-catalog',
  registerManualModel: 'providers:register-manual-model',
  validateCapability: 'providers:validate-capability',
  recordUserCapability: 'providers:record-user-capability',
  saveRoutingPreference: 'providers:save-routing-preference',
  planRoute: 'providers:plan-route',
  createProvider: 'providers:create-provider',
  createConnection: 'providers:create-connection',
  updateConnection: 'providers:update-connection',
  setConnectionEnabled: 'providers:set-connection-enabled',
  deleteConnection: 'providers:delete-connection',
  setModelEnabled: 'providers:set-model-enabled',
  getViduLiveValidation: 'providers:get-vidu-live-validation',
  startViduLiveValidation: 'providers:start-vidu-live-validation'
} as const;

export type ViduLiveValidationIpcErrorCode =
  | 'invalid_request'
  | 'already_started'
  | 'connection_not_ready'
  | 'validation_operation_failed';

export interface ViduLiveValidationApprovalDto {
  readonly confirmLiveNetwork: boolean;
  readonly confirmCredentialUse: boolean;
  readonly confirmImageBillableAttempt: boolean;
  readonly confirmVideoBillableAttempt: boolean;
}

export interface ViduLiveValidationStatusDto {
  readonly status: 'not_started' | 'active' | 'passed' | 'failed' | 'blocked';
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly stopCode?: string;
  readonly budget: {
    readonly image: {
      readonly claimState: 'available' | 'claimed' | 'not_available';
      readonly billingFact:
        | 'not_attempted'
        | 'attempt_claimed'
        | 'accepted_or_completed'
        | 'failed_before_submission'
        | 'submission_outcome_unknown';
    };
    readonly video: {
      readonly claimState: 'available' | 'claimed' | 'not_available';
      readonly billingFact:
        | 'not_attempted'
        | 'attempt_claimed'
        | 'accepted_or_completed'
        | 'failed_before_submission'
        | 'submission_outcome_unknown';
    };
  };
  readonly events: readonly {
    readonly sequence: number;
    readonly stage:
      | 'readiness'
      | 'credits_validation'
      | 'image_submission'
      | 'image_local_result'
      | 'video_confirmation'
      | 'video_submission'
      | 'video_polling'
      | 'video_local_result'
      | 'flow';
    readonly state: 'claimed' | 'progress' | 'succeeded' | 'failed' | 'blocked';
    readonly recordedAt: string;
    readonly errorCode?: string;
    readonly providerState?: string;
  }[];
}

export type ViduLiveValidationIpcResult =
  | { readonly ok: true; readonly value: ViduLiveValidationStatusDto }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ViduLiveValidationIpcErrorCode;
        readonly message: string;
      };
    };

export type ProviderManagementErrorCode =
  | 'adapter_unavailable'
  | 'provider_not_found'
  | 'connection_not_found'
  | 'model_not_found'
  | 'model_already_exists'
  | 'invalid_request'
  | 'provider_operation_failed';

export type ProviderManagementResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly state: string;
        readonly modelId?: string;
        readonly providerId?: string;
        readonly connectionId?: string;
        readonly evidenceId?: string;
        readonly preferenceId?: string;
        readonly observedAt?: string;
        readonly count?: number;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ProviderManagementErrorCode;
        readonly message: string;
      };
    };

export type RoutePlanResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly purpose: string;
        readonly candidates: readonly {
          readonly modelId: string;
          readonly priority: number;
          readonly costState: 'unknown';
          readonly privacyState: 'unknown';
          readonly regionState: 'unknown';
        }[];
        readonly requiresSubmissionConfirmation: true;
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ProviderManagementErrorCode;
        readonly message: string;
      };
    };

export type CredentialErrorCode =
  | 'connection_not_found'
  | 'encryption_unavailable'
  | 'invalid_request'
  | 'credential_operation_failed';

export type CredentialActionResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly state: string;
        readonly remoteRevocation?: 'not_attempted';
        readonly remoteValidation?: 'not_attempted';
      };
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: CredentialErrorCode;
        readonly message: string;
      };
    };

export type CredentialStatusResult =
  | { readonly ok: true; readonly value: { readonly state: string } }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: CredentialErrorCode;
        readonly message: string;
      };
    };

export type ProviderIpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'provider_registry_failed';
        readonly message: string;
      };
    };

export interface ProviderSummaryDto {
  readonly providerId: string;
  readonly name: string;
  readonly accessCategory: string;
  readonly identityState: string;
}

export interface ProviderConnectionSummaryDto {
  readonly connectionId: string;
  readonly providerId: string;
  readonly name: string;
  readonly state: string;
  readonly identityState: string;
  readonly credentialState: string;
  readonly endpointConfigured: boolean;
  readonly lastConnectionValidationAt?: string;
}

export interface ProviderModelSummaryDto {
  readonly modelId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly protocolBindingId: string;
  readonly name: string;
  readonly providerModelKey: string;
  readonly mediaKind: 'image' | 'video' | 'unknown';
  readonly revision: number;
  readonly capabilityEvidenceId?: string;
  readonly displayName: string;
  readonly enabled: boolean;
}

export interface ProviderProtocolBindingSummaryDto {
  readonly protocolBindingId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly mediaKind: 'image' | 'video' | 'unknown';
  readonly executionLifecycle:
    | 'synchronous_completed'
    | 'asynchronous_polling'
    | 'unknown';
  readonly supportedPurposes: readonly string[];
}

export interface ProviderCapabilitySummaryDto {
  readonly evidenceId: string;
  readonly modelId: string;
  readonly revision: number;
  readonly capability: string;
  readonly state: string;
  readonly source: string;
  readonly supersedesEvidenceId?: string;
  readonly constraint?: string;
  readonly observedAt?: string;
  readonly recordedAt: string;
  readonly parameterSchema?: {
    readonly schemaVersion: 1;
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
      readonly required: boolean;
      readonly options?: readonly (string | number | boolean)[];
      readonly minimum?: number;
      readonly maximum?: number;
    }[];
  };
  readonly videoGenerationSchema?: {
    readonly schemaVersion: 1;
    readonly modes: readonly (
      | {
          readonly mode: 'quick_video';
          readonly reference?: {
            readonly acceptedMediaKinds: readonly ('image' | 'video')[];
          };
        }
      | {
          readonly mode: 'text_to_video';
          readonly materialSlots: readonly {
            readonly id: string;
            readonly role: string;
            readonly required: boolean;
            readonly acceptedMediaKinds: readonly ('image' | 'video')[];
          }[];
          readonly shotPlan: {
            readonly supported: boolean;
            readonly required: boolean;
            readonly minimumShots?: number;
            readonly maximumShots?: number;
          };
        }
      | {
          readonly mode: 'image_to_video';
          readonly materialSlots: readonly {
            readonly id: string;
            readonly role: string;
            readonly required: boolean;
            readonly acceptedMediaKinds: readonly ('image' | 'video')[];
          }[];
        }
    )[];
  };
}

export interface ProviderRoutingSummaryDto {
  readonly preferenceId: string;
  readonly purpose: string;
  readonly modelId: string;
  readonly priority: number;
  readonly enabled: boolean;
}

export interface ProviderRegistryDto {
  readonly providers: readonly ProviderSummaryDto[];
  readonly connections: readonly ProviderConnectionSummaryDto[];
  readonly protocolBindings: readonly ProviderProtocolBindingSummaryDto[];
  readonly models: readonly ProviderModelSummaryDto[];
  readonly capabilities: readonly ProviderCapabilitySummaryDto[];
  readonly routingPreferences: readonly ProviderRoutingSummaryDto[];
}

export interface ProviderApi {
  getRegistry(): Promise<ProviderIpcResult<ProviderRegistryDto>>;
  saveCredential(
    connectionId: string,
    value: string
  ): Promise<CredentialActionResult>;
  deleteLocalCredential(connectionId: string): Promise<CredentialActionResult>;
  getCredentialStatus(connectionId: string): Promise<CredentialStatusResult>;
  checkCredentialStorage(connectionId: string): Promise<CredentialActionResult>;
  validateConnection(connectionId: string): Promise<ProviderManagementResult>;
  syncModelCatalog(connectionId: string): Promise<ProviderManagementResult>;
  registerManualModel(
    connectionId: string,
    name: string,
    displayName: string
  ): Promise<ProviderManagementResult>;
  validateCapability(
    modelId: string,
    capability: string
  ): Promise<ProviderManagementResult>;
  recordUserCapability(
    modelId: string,
    capability: string,
    state: 'user_confirmed' | 'unsupported'
  ): Promise<ProviderManagementResult>;
  saveRoutingPreference(
    purpose: string,
    modelId: string,
    priority: number,
    enabled: boolean
  ): Promise<ProviderManagementResult>;
  planRoute(purpose: string): Promise<RoutePlanResult>;
  createProvider(
    name: string,
    accessCategory: 'online' | 'local' | 'lan' | 'custom_remote'
  ): Promise<ProviderManagementResult>;
  createConnection(
    providerId: string,
    name: string,
    endpoint: string | null
  ): Promise<ProviderManagementResult>;
  updateConnection(
    connectionId: string,
    name: string,
    endpoint: string | null
  ): Promise<ProviderManagementResult>;
  setConnectionEnabled(
    connectionId: string,
    enabled: boolean
  ): Promise<ProviderManagementResult>;
  deleteConnection(connectionId: string): Promise<CredentialActionResult>;
  setModelEnabled(
    modelId: string,
    enabled: boolean
  ): Promise<ProviderManagementResult>;
  getViduLiveValidation(): Promise<ViduLiveValidationIpcResult>;
  startViduLiveValidation(
    approval: ViduLiveValidationApprovalDto
  ): Promise<ViduLiveValidationIpcResult>;
}
