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
  setModelEnabled: 'providers:set-model-enabled'
} as const;

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
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
}

export interface ProviderCapabilitySummaryDto {
  readonly evidenceId: string;
  readonly modelId: string;
  readonly capability: string;
  readonly state: string;
  readonly source: string;
  readonly constraint?: string;
  readonly observedAt?: string;
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
}
