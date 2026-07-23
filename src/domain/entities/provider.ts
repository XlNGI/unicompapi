import type {
  CapabilityEvidenceId,
  ConnectionId,
  ModelId,
  ProviderId,
  RoutingPreferenceId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';

export const providerAccessCategories = [
  'online',
  'local',
  'lan',
  'custom_remote'
] as const;
export type ProviderAccessCategory = (typeof providerAccessCategories)[number];

export const providerIdentityStates = [
  'unverified',
  'verified',
  'verification_failed'
] as const;
export type ProviderIdentityState = (typeof providerIdentityStates)[number];

export const connectionStates = [
  'unconfigured',
  'saved',
  'validating',
  'available',
  'unavailable',
  'disabled',
  'deleted'
] as const;
export type ConnectionState = (typeof connectionStates)[number];

export const credentialStates = [
  'not_configured',
  'saved',
  'validating',
  'valid',
  'invalid',
  'deleted',
  'verification_unavailable'
] as const;
export type CredentialState = (typeof credentialStates)[number];

export const capabilityStates = [
  'verified_supported',
  'declared_supported',
  'user_confirmed',
  'unknown',
  'unsupported',
  'verification_failed',
  'restricted'
] as const;
export type CapabilityState = (typeof capabilityStates)[number];

export const capabilityEvidenceSources = [
  'provider_declared',
  'connection_verified',
  'user_confirmed',
  'system_observed'
] as const;
export type CapabilityEvidenceSource =
  (typeof capabilityEvidenceSources)[number];

export const dynamicParameterKinds = [
  'string',
  'number',
  'integer',
  'boolean',
  'enum'
] as const;

export type DynamicParameterKind = (typeof dynamicParameterKinds)[number];
export type DynamicParameterScalar = string | number | boolean;

export interface DynamicParameterFieldSchema {
  readonly key: string;
  readonly label: string;
  readonly kind: DynamicParameterKind;
  readonly required: boolean;
  readonly options?: readonly DynamicParameterScalar[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface DynamicParameterSchema {
  readonly schemaVersion: 1;
  readonly fields: readonly DynamicParameterFieldSchema[];
}

export interface Provider {
  readonly schemaVersion: 1;
  readonly id: ProviderId;
  readonly name: string;
  readonly accessCategory: ProviderAccessCategory;
  readonly identityState: ProviderIdentityState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ProviderConnection {
  readonly schemaVersion: 1;
  readonly id: ConnectionId;
  readonly providerId: ProviderId;
  readonly name: string;
  readonly endpoint?: string;
  readonly state: ConnectionState;
  readonly identityState: ProviderIdentityState;
  readonly credentialState: CredentialState;
  readonly credentialReference?: string;
  readonly lastConnectionValidationAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ProviderModel {
  readonly schemaVersion: 1;
  readonly id: ModelId;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly name: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ModelCapabilityEvidence {
  readonly schemaVersion: 1;
  readonly id: CapabilityEvidenceId;
  readonly modelId: ModelId;
  readonly capability: string;
  readonly state: CapabilityState;
  readonly source: CapabilityEvidenceSource;
  readonly constraint?: string;
  readonly parameterSchema?: DynamicParameterSchema;
  readonly observedAt?: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RoutingPreference {
  readonly schemaVersion: 1;
  readonly id: RoutingPreferenceId;
  readonly purpose: string;
  readonly modelId: ModelId;
  readonly priority: number;
  readonly enabled: boolean;
  readonly updatedAt: IsoTimestamp;
}

export function createProvider(input: Omit<Provider, 'schemaVersion'>): Provider {
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'provider.name')
  };
}

export function createProviderConnection(
  input: Omit<ProviderConnection, 'schemaVersion'>
): ProviderConnection {
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'connection.name'),
    endpoint: input.endpoint
      ? requireNonBlank(input.endpoint, 'connection.endpoint')
      : undefined,
    credentialReference: input.credentialReference
      ? requireNonBlank(
          input.credentialReference,
          'connection.credentialReference'
        )
      : undefined
  };
}

export function createProviderModel(
  input: Omit<ProviderModel, 'schemaVersion'>
): ProviderModel {
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'model.name'),
    displayName: requireNonBlank(input.displayName, 'model.displayName')
  };
}

export function createModelCapabilityEvidence(
  input: Omit<ModelCapabilityEvidence, 'schemaVersion'>
): ModelCapabilityEvidence {
  return {
    ...input,
    schemaVersion: 1,
    capability: requireNonBlank(input.capability, 'capability.name'),
    constraint: input.constraint
      ? requireNonBlank(input.constraint, 'capability.constraint')
      : undefined,
    parameterSchema: input.parameterSchema
      ? cloneDynamicParameterSchema(input.parameterSchema)
      : undefined
  };
}

export function cloneDynamicParameterSchema(
  schema: DynamicParameterSchema
): DynamicParameterSchema {
  return {
    schemaVersion: 1,
    fields: schema.fields.map((field) => ({
      ...field,
      options: field.options ? [...field.options] : undefined
    }))
  };
}

export function createRoutingPreference(
  input: Omit<RoutingPreference, 'schemaVersion'>
): RoutingPreference {
  if (!Number.isSafeInteger(input.priority) || input.priority < 0) {
    throw new TypeError('routing.priority must be a non-negative integer');
  }
  return {
    ...input,
    schemaVersion: 1,
    purpose: requireNonBlank(input.purpose, 'routing.purpose')
  };
}
