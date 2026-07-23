import type {
  CapabilityEvidenceId,
  ConnectionId,
  ModelId,
  ProviderId,
  RoutingPreferenceId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';
import type {
  VideoMaterialKind,
  VideoWorkspaceMode
} from './video-workspace';

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

export interface VideoMaterialSlotCapabilitySchema {
  readonly id: string;
  readonly role: string;
  readonly required: boolean;
  readonly acceptedMediaKinds: readonly VideoMaterialKind[];
}

export interface QuickVideoCapabilitySchema {
  readonly mode: 'quick_video';
  readonly reference?: {
    readonly acceptedMediaKinds: readonly VideoMaterialKind[];
  };
}

export interface TextToVideoCapabilitySchema {
  readonly mode: 'text_to_video';
  readonly materialSlots: readonly VideoMaterialSlotCapabilitySchema[];
  readonly shotPlan: {
    readonly supported: boolean;
    readonly required: boolean;
    readonly minimumShots?: number;
    readonly maximumShots?: number;
  };
}

export interface ImageToVideoCapabilitySchema {
  readonly mode: 'image_to_video';
  readonly materialSlots: readonly VideoMaterialSlotCapabilitySchema[];
}

export type VideoGenerationModeCapabilitySchema =
  | QuickVideoCapabilitySchema
  | TextToVideoCapabilitySchema
  | ImageToVideoCapabilitySchema;

export interface VideoGenerationCapabilitySchema {
  readonly schemaVersion: 1;
  readonly modes: readonly VideoGenerationModeCapabilitySchema[];
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
  readonly videoGenerationSchema?: VideoGenerationCapabilitySchema;
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
      : undefined,
    videoGenerationSchema: input.videoGenerationSchema
      ? cloneVideoGenerationCapabilitySchema(input.videoGenerationSchema)
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

export function cloneVideoGenerationCapabilitySchema(
  schema: VideoGenerationCapabilitySchema
): VideoGenerationCapabilitySchema {
  if (schema.schemaVersion !== 1 || !Array.isArray(schema.modes)) {
    throw new TypeError('video generation capability schema is invalid');
  }
  const modes = schema.modes.map(cloneVideoModeCapability);
  if (new Set(modes.map((mode) => mode.mode)).size !== modes.length) {
    throw new TypeError('video generation modes must be unique');
  }
  return { schemaVersion: 1, modes };
}

function cloneVideoModeCapability(
  value: VideoGenerationModeCapabilitySchema
): VideoGenerationModeCapabilitySchema {
  if (value.mode === 'quick_video') {
    return {
      mode: value.mode,
      reference: value.reference
        ? {
            acceptedMediaKinds: cloneMediaKinds(
              value.reference.acceptedMediaKinds
            )
          }
        : undefined
    };
  }
  if (value.mode === 'text_to_video') {
    const shotPlan = value.shotPlan;
    if (!shotPlan || typeof shotPlan.supported !== 'boolean' ||
      typeof shotPlan.required !== 'boolean') {
      throw new TypeError('text-to-video shot plan schema is invalid');
    }
    const minimumShots = optionalNonNegativeInteger(
      shotPlan.minimumShots,
      'video shot minimum'
    );
    const maximumShots = optionalNonNegativeInteger(
      shotPlan.maximumShots,
      'video shot maximum'
    );
    if (
      (!shotPlan.supported &&
        (shotPlan.required || minimumShots !== undefined || maximumShots !== undefined)) ||
      (minimumShots !== undefined &&
        maximumShots !== undefined &&
        maximumShots < minimumShots)
    ) {
      throw new TypeError('text-to-video shot plan limits are invalid');
    }
    return {
      mode: value.mode,
      materialSlots: cloneMaterialSlots(value.materialSlots),
      shotPlan: {
        supported: shotPlan.supported,
        required: shotPlan.required,
        minimumShots,
        maximumShots
      }
    };
  }
  if (value.mode === 'image_to_video') {
    return {
      mode: value.mode,
      materialSlots: cloneMaterialSlots(value.materialSlots)
    };
  }
  throw new TypeError(
    `unsupported video generation mode: ${String((value as { mode?: VideoWorkspaceMode }).mode)}`
  );
}

function cloneMaterialSlots(
  slots: readonly VideoMaterialSlotCapabilitySchema[]
): readonly VideoMaterialSlotCapabilitySchema[] {
  if (!Array.isArray(slots)) {
    throw new TypeError('video material slots must be an array');
  }
  const cloned = slots.map((slot) => ({
    id: requireNonBlank(slot.id, 'video material slot id'),
    role: requireNonBlank(slot.role, 'video material slot role'),
    required: requireBoolean(slot.required, 'video material slot required'),
    acceptedMediaKinds: cloneMediaKinds(slot.acceptedMediaKinds)
  }));
  if (new Set(cloned.map((slot) => slot.id)).size !== cloned.length) {
    throw new TypeError('video material slot IDs must be unique');
  }
  return cloned;
}

function cloneMediaKinds(
  kinds: readonly VideoMaterialKind[]
): readonly VideoMaterialKind[] {
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    kinds.some((kind) => kind !== 'image' && kind !== 'video') ||
    new Set(kinds).size !== kinds.length
  ) {
    throw new TypeError('video material media kinds are invalid');
  }
  return [...kinds];
}

function optionalNonNegativeInteger(
  value: number | undefined,
  label: string
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireBoolean(value: boolean, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
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
