export const providerIpcChannels = {
  getRegistry: 'providers:get-registry'
} as const;

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
}
