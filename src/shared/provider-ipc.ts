export const providerIpcChannels = {
  getRegistry: 'providers:get-registry',
  saveCredential: 'providers:save-credential',
  deleteLocalCredential: 'providers:delete-local-credential',
  getCredentialStatus: 'providers:get-credential-status',
  checkCredentialStorage: 'providers:check-credential-storage'
} as const;

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
}
