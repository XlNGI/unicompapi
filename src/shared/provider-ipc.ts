export const providerIpcChannels = {
  getRegistry: 'providers:get-registry',
  listTemplates: 'providers:list-templates',
  createConnection: 'providers:create-managed-connection',
  rotateCredential: 'providers:rotate-managed-credential',
  validateConnection: 'providers:validate-managed-connection',
  activateConnection: 'providers:activate-managed-connection',
  syncModelCatalog: 'providers:sync-managed-model-catalog',
  registerExactModel: 'providers:register-exact-model',
  setConnectionEnabled: 'providers:set-managed-connection-enabled',
  setModelEnabled: 'providers:set-managed-model-enabled',
  deleteConnection: 'providers:delete-managed-connection'
} as const;

export type ProviderManagementErrorCode =
  | 'adapter_unavailable'
  | 'provider_registry_conflict'
  | 'provider_not_found'
  | 'connection_not_found'
  | 'model_not_found'
  | 'model_already_exists'
  | 'invalid_request'
  | 'provider_operation_failed';

export type ProviderFrameworkErrorCode =
  | 'invalid_request'
  | 'package_not_found'
  | 'template_not_found'
  | 'connection_not_found'
  | 'model_not_found'
  | 'connection_contract_stale'
  | 'credential_unavailable'
  | 'credential_invalid'
  | 'free_validation_unavailable'
  | 'operation_unavailable'
  | 'adapter_unavailable'
  | 'adapter_binding_ambiguous'
  | 'connection_not_available'
  | 'catalog_sync_unavailable'
  | 'manual_registration_unavailable'
  | 'model_already_exists'
  | 'model_not_routable'
  | 'active_operations_present'
  | 'provider_registry_conflict'
  | 'audit_store_unavailable'
  | 'provider_management_failed';

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

export type ProviderFrameworkResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ProviderFrameworkErrorCode;
        readonly message: string;
      };
    };

export interface ProviderTemplateSummaryDto {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerName: string;
  readonly templateId: string;
  readonly kind: 'official' | 'compatible_custom';
  readonly displayName: string;
  readonly baseUrlMode: 'fixed' | 'optional' | 'required';
  readonly credentialFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly secret: boolean;
    readonly required: boolean;
    readonly kind: 'token' | 'access_key' | 'secret_key' | 'string';
  }[];
  readonly freeConnectionValidation: boolean;
  readonly modelDiscoveryKind: 'none' | 'catalog' | 'manual_exact';
  readonly validationAction: 'available' | 'requires_live_api_approval' | 'unsupported';
  readonly modelDiscoveryAction:
    | 'catalog_available'
    | 'requires_live_api_approval'
    | 'manual_exact'
    | 'unsupported';
}

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
  readonly packageId?: string;
  readonly packageVersion?: string;
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
  readonly packageId?: string;
  readonly packageVersion?: string;
  readonly templateId?: string;
  readonly templateKind?: 'official' | 'compatible_custom';
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
  readonly activeProfileId?: string;
  readonly catalogState: 'present' | 'missing' | 'retired';
  readonly catalogRevision?: number;
  readonly lastSeenAt?: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly profileStatus?: 'declared' | 'verified' | 'restricted' | 'disabled';
  readonly productFeatures?: readonly string[];
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
  readonly registryRevision?: number;
  readonly currentConnectionId: string | null;
  readonly providers: readonly ProviderSummaryDto[];
  readonly connections: readonly ProviderConnectionSummaryDto[];
  readonly protocolBindings: readonly ProviderProtocolBindingSummaryDto[];
  readonly models: readonly ProviderModelSummaryDto[];
  readonly capabilities: readonly ProviderCapabilitySummaryDto[];
  readonly routingPreferences: readonly ProviderRoutingSummaryDto[];
}

export interface ProviderApi {
  getRegistry(): Promise<ProviderIpcResult<ProviderRegistryDto>>;
  listTemplates(): Promise<ProviderFrameworkResult<readonly ProviderTemplateSummaryDto[]>>;
  createConnection(input: {
    readonly packageId: string;
    readonly templateId: string;
    readonly name: string;
    readonly endpoint?: string;
    readonly credentials: Readonly<Record<string, string>>;
    readonly explicitLoopbackHttpConsent?: boolean;
  }): Promise<ProviderFrameworkResult<{
    readonly providerId: string;
    readonly connectionId: string;
    readonly state: 'saved';
  }>>;
  rotateCredential(
    connectionId: string,
    credentials: Readonly<Record<string, string>>
  ): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly credentialVersionId: string;
    readonly previousCredential: 'removed' | 'retained_for_active_operations' | 'absent';
  }>>;
  validateConnection(connectionId: string): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly state: 'available' | 'unavailable';
    readonly observedAt: string;
  }>>;
  activateConnection(
    connectionId: string,
    expectedRegistryRevision: number
  ): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly state: 'active';
    readonly observedAt: string;
    readonly registryRevision: number;
  }>>;
  syncModelCatalog(connectionId: string): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly count: number;
    readonly catalogRevision: number;
    readonly observedAt: string;
  }>>;
  registerExactModel(
    connectionId: string,
    providerModelKey: string,
    displayName: string
  ): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly modelId: string;
    readonly state: 'registered_without_profile';
  }>>;
  setConnectionEnabled(
    connectionId: string,
    enabled: boolean
  ): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly state: 'enabled' | 'disabled';
  }>>;
  setModelEnabled(
    modelId: string,
    enabled: boolean
  ): Promise<ProviderFrameworkResult<{
    readonly modelId: string;
    readonly state: 'enabled' | 'disabled';
  }>>;
  deleteConnection(
    connectionId: string,
    abandonActiveOperations?: boolean
  ): Promise<ProviderFrameworkResult<{
    readonly connectionId: string;
    readonly state: 'deleted';
    readonly retainedCredentialVersions: readonly string[];
  }>>;
}
