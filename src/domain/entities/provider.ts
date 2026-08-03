import type {
  CapabilityEvidenceId,
  ConnectionId,
  ModelId,
  ProtocolBindingId,
  ProviderId,
  RoutingPreferenceId
} from '../ids';
import type { IsoTimestamp } from '../timestamps';
import { requireNonBlank } from '../validation';
import type {
  VideoMaterialKind,
  VideoWorkspaceMode
} from './video-workspace';
import type {
  ProviderConnectionAdapterBinding,
  ProviderTemplateKind
} from './provider-package';

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

export const providerMediaKinds = ['image', 'video', 'unknown'] as const;
export type ProviderMediaKind = (typeof providerMediaKinds)[number];

export const providerExecutionLifecycles = [
  'synchronous_completed',
  'asynchronous_polling',
  'unknown'
] as const;
export type ProviderExecutionLifecycle =
  (typeof providerExecutionLifecycles)[number];

export const providerAuthSchemes = ['token', 'unknown'] as const;
export type ProviderAuthScheme = (typeof providerAuthSchemes)[number];

export const providerOperationPurposes = [
  'image_generation',
  'image_understanding',
  'image_editing',
  'image_to_prompt',
  'reference_to_image',
  'video_generation',
  'reference_to_video'
] as const;
export type ProviderOperationPurpose =
  (typeof providerOperationPurposes)[number];

export interface ProviderProtocolBinding {
  readonly schemaVersion: 1;
  readonly id: ProtocolBindingId;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly mediaKind: ProviderMediaKind;
  readonly adapterKind: string;
  readonly endpointTemplate?: string;
  readonly authScheme: ProviderAuthScheme;
  readonly executionLifecycle: ProviderExecutionLifecycle;
  readonly supportedPurposes: readonly ProviderOperationPurpose[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type ProviderImmediateResultReference =
  | {
      readonly kind: 'remote_url';
      readonly value: string;
    }
  | {
      readonly kind: 'base64';
      readonly value: string;
      readonly mimeType: string;
    }
  | {
      readonly kind: 'file_uri';
      readonly value: string;
    };

export type ProviderSubmitOutcome =
  | {
      readonly kind: 'accepted_async';
      readonly providerOperationId: string;
      readonly state: 'queued' | 'processing';
    }
  | {
      readonly kind: 'completed_sync';
      readonly providerOperationId: string;
      readonly results: readonly ProviderImmediateResultReference[];
    }
  | {
      readonly kind: 'submission_outcome_unknown';
      readonly providerOperationId?: string;
      readonly message: string;
    }
  | {
      readonly kind: 'failed_before_submission';
      readonly message: string;
      readonly retryability: 'retryable' | 'not_retryable' | 'unknown';
    };

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
  readonly packageId?: string;
  readonly packageVersion?: string;
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
  readonly packageId?: string;
  readonly packageVersion?: string;
  readonly templateId?: string;
  readonly templateKind?: ProviderTemplateKind;
  readonly credentialSchemaId?: string;
  readonly credentialSchemaVersion?: number;
  readonly credentialVersionId?: string;
  readonly connectionPolicyId?: string;
  readonly connectionPolicyRevision?: number;
  readonly discoveryPolicyId?: string;
  readonly discoveryPolicyRevision?: number;
  readonly endpointPolicyId?: string;
  readonly endpointPolicyRevision?: number;
  readonly connectionConfigVersionId?: string;
  readonly connectionRevision?: number;
  readonly adapterBindings?: readonly ProviderConnectionAdapterBinding[];
  readonly state: ConnectionState;
  readonly identityState: ProviderIdentityState;
  readonly credentialState: CredentialState;
  readonly credentialReference?: string;
  readonly lastConnectionValidationAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ProviderModel {
  readonly schemaVersion: 2;
  readonly id: ModelId;
  readonly providerId: ProviderId;
  readonly connectionId: ConnectionId;
  readonly protocolBindingId: ProtocolBindingId;
  readonly providerModelKey: string;
  readonly mediaKind: ProviderMediaKind;
  readonly revision: number;
  readonly displayName: string;
  readonly capabilityEvidenceId?: CapabilityEvidenceId;
  readonly enabled: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ModelCapabilityEvidence {
  readonly schemaVersion: 2;
  readonly id: CapabilityEvidenceId;
  readonly modelId: ModelId;
  readonly revision: number;
  readonly capability: string;
  readonly state: CapabilityState;
  readonly source: CapabilityEvidenceSource;
  readonly supersedesEvidenceId?: CapabilityEvidenceId;
  readonly constraint?: string;
  readonly parameterSchema?: DynamicParameterSchema;
  readonly videoGenerationSchema?: VideoGenerationCapabilitySchema;
  readonly observedAt?: IsoTimestamp;
  readonly recordedAt: IsoTimestamp;
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
  const packageId = optionalStableContractId(input.packageId, 'provider.packageId');
  const packageVersion = optionalContractVersion(
    input.packageVersion,
    'provider.packageVersion'
  );
  if ((packageId === undefined) !== (packageVersion === undefined)) {
    throw new TypeError('provider package ownership must be complete');
  }
  return {
    ...input,
    schemaVersion: 1,
    name: requireNonBlank(input.name, 'provider.name'),
    packageId,
    packageVersion
  };
}

export function createProviderConnection(
  input: Omit<ProviderConnection, 'schemaVersion'>
): ProviderConnection {
  validateConnectionPackageBinding(input);
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
      : undefined,
    adapterBindings: input.adapterBindings
      ? input.adapterBindings.map((binding) => ({ ...binding }))
      : undefined
  };
}

function validateConnectionPackageBinding(
  input: Omit<ProviderConnection, 'schemaVersion'>
): void {
  const fields = [
    input.packageId,
    input.packageVersion,
    input.templateId,
    input.templateKind,
    input.credentialSchemaId,
    input.credentialSchemaVersion,
    input.credentialVersionId,
    input.connectionPolicyId,
    input.connectionPolicyRevision,
    input.discoveryPolicyId,
    input.discoveryPolicyRevision,
    input.endpointPolicyId,
    input.endpointPolicyRevision,
    input.connectionConfigVersionId,
    input.connectionRevision,
    input.adapterBindings
  ];
  const present = fields.filter((value) => value !== undefined).length;
  if (present === 0) return;
  if (present !== fields.length || !input.adapterBindings?.length) {
    throw new TypeError('connection package binding must be complete');
  }
  for (const [value, field] of [
    [input.packageId, 'connection.packageId'],
    [input.templateId, 'connection.templateId'],
    [input.credentialSchemaId, 'connection.credentialSchemaId'],
    [input.credentialVersionId, 'connection.credentialVersionId'],
    [input.connectionPolicyId, 'connection.connectionPolicyId'],
    [input.discoveryPolicyId, 'connection.discoveryPolicyId'],
    [input.endpointPolicyId, 'connection.endpointPolicyId'],
    [input.connectionConfigVersionId, 'connection.connectionConfigVersionId']
  ] as const) {
    optionalStableContractId(value, field);
  }
  optionalContractVersion(input.packageVersion, 'connection.packageVersion');
  for (const [value, field] of [
    [input.credentialSchemaVersion, 'connection.credentialSchemaVersion'],
    [input.connectionPolicyRevision, 'connection.connectionPolicyRevision'],
    [input.discoveryPolicyRevision, 'connection.discoveryPolicyRevision'],
    [input.endpointPolicyRevision, 'connection.endpointPolicyRevision'],
    [input.connectionRevision, 'connection.connectionRevision']
  ] as const) {
    if (!Number.isSafeInteger(value) || Number(value) < 1) {
      throw new TypeError(`${field} must be a positive integer`);
    }
  }
  const adapterKeys = input.adapterBindings.map((binding) => {
    optionalStableContractId(binding.adapterId, 'connection.adapterId');
    optionalContractVersion(binding.adapterVersion, 'connection.adapterVersion');
    optionalStableContractId(binding.protocolId, 'connection.protocolId');
    optionalContractVersion(binding.protocolVersion, 'connection.protocolVersion');
    return `${binding.adapterId}@${binding.adapterVersion}`;
  });
  if (new Set(adapterKeys).size !== adapterKeys.length) {
    throw new TypeError('connection adapter bindings must be unique');
  }
}

function optionalStableContractId(
  value: string | undefined,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requireNonBlank(value, field);
  if (
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function optionalContractVersion(
  value: string | undefined,
  field: string
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = requireNonBlank(value, field);
  if (normalized.length > 200) throw new TypeError(`${field} is invalid`);
  return normalized;
}

export function createProviderModel(
  input: Omit<ProviderModel, 'schemaVersion'>
): ProviderModel {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new TypeError('model.revision must be a positive integer');
  }
  return {
    ...input,
    schemaVersion: 2,
    providerModelKey: requireNonBlank(
      input.providerModelKey,
      'model.providerModelKey'
    ),
    displayName: requireNonBlank(input.displayName, 'model.displayName')
  };
}

export function createModelCapabilityEvidence(
  input: Omit<ModelCapabilityEvidence, 'schemaVersion'>
): ModelCapabilityEvidence {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new TypeError('capability.revision must be a positive integer');
  }
  return {
    ...input,
    schemaVersion: 2,
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

export function createProviderProtocolBinding(
  input: Omit<ProviderProtocolBinding, 'schemaVersion'>
): ProviderProtocolBinding {
  const supportedPurposes = [...input.supportedPurposes];
  if (
    new Set(supportedPurposes).size !== supportedPurposes.length ||
    supportedPurposes.some(
      (purpose) => !providerOperationPurposes.includes(purpose)
    )
  ) {
    throw new TypeError('protocol binding purposes are invalid');
  }
  return {
    ...input,
    schemaVersion: 1,
    protocolId: requireNonBlank(input.protocolId, 'protocol.protocolId'),
    protocolVersion: requireNonBlank(
      input.protocolVersion,
      'protocol.protocolVersion'
    ),
    adapterKind: requireNonBlank(input.adapterKind, 'protocol.adapterKind'),
    endpointTemplate: input.endpointTemplate
      ? requireNonBlank(input.endpointTemplate, 'protocol.endpointTemplate')
      : undefined,
    supportedPurposes
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
