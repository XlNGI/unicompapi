export const providerTemplateKinds = [
  'official',
  'compatible_custom'
] as const;
export type ProviderTemplateKind = (typeof providerTemplateKinds)[number];

export const credentialFieldKinds = [
  'token',
  'access_key',
  'secret_key',
  'string'
] as const;
export type CredentialFieldKind = (typeof credentialFieldKinds)[number];

export interface CredentialFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly kind: CredentialFieldKind;
}

export interface CredentialSchema {
  readonly schemaId: string;
  readonly version: number;
  readonly fields: readonly CredentialFieldSchema[];
}

export type ProviderBaseUrlMode = 'fixed' | 'optional' | 'required';
export type EndpointRedirectPolicy = 'deny' | 'same_origin';
export type EndpointProxyPolicy = 'deny' | 'system';

export interface EndpointPolicy {
  readonly policyId: string;
  readonly revision: number;
  readonly allowedSchemes: readonly ('https' | 'http')[];
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
  readonly allowedPathPrefixes: readonly string[];
  readonly redirectPolicy: EndpointRedirectPolicy;
  readonly proxyPolicy: EndpointProxyPolicy;
  readonly allowLoopback: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly allowLoopbackHttp: boolean;
  readonly dnsRebindingProtection: 'required';
  readonly fixedBaseUrl?: string;
}

export const providerAdapterOperations = [
  'validate_connection',
  'discover_models',
  'submit',
  'query',
  'cancel',
  'receive_result'
] as const;
export type ProviderAdapterOperation =
  (typeof providerAdapterOperations)[number];

export interface ProviderAdapterDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly operations: readonly ProviderAdapterOperation[];
}

export interface ProviderTemplateAdapterBinding {
  readonly adapterId: string;
  readonly adapterVersion: string;
}

export interface ProviderTemplateDescriptor {
  readonly templateId: string;
  readonly kind: ProviderTemplateKind;
  readonly displayName: string;
  readonly iconAssetId?: string;
  readonly baseUrlMode: ProviderBaseUrlMode;
  readonly credentialSchemaId: string;
  readonly credentialSchemaVersion: number;
  readonly connectionPolicyId: string;
  readonly connectionPolicyRevision: number;
  readonly discoveryPolicyId: string;
  readonly discoveryPolicyRevision: number;
  readonly endpointPolicyId: string;
  readonly endpointPolicyRevision: number;
  readonly adapterBindings: readonly ProviderTemplateAdapterBinding[];
  readonly freeConnectionValidation: boolean;
  readonly modelDiscoveryKind: 'none' | 'catalog' | 'manual_exact';
}

export interface ProviderPackageDescriptor {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly displayName: string;
  readonly templates: readonly ProviderTemplateDescriptor[];
  readonly credentialSchemas: readonly CredentialSchema[];
  readonly endpointPolicies: readonly EndpointPolicy[];
  readonly adapters: readonly ProviderAdapterDescriptor[];
}

export interface ProviderConnectionAdapterBinding {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
}

export interface StructuredCredentialRecord {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface SafeProviderTemplateDto {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly providerName: string;
  readonly templateId: string;
  readonly kind: ProviderTemplateKind;
  readonly displayName: string;
  readonly iconAssetId?: string;
  readonly baseUrlMode: ProviderBaseUrlMode;
  readonly credentialFields: readonly CredentialFieldSchema[];
  readonly freeConnectionValidation: boolean;
  readonly modelDiscoveryKind: ProviderTemplateDescriptor['modelDiscoveryKind'];
}
