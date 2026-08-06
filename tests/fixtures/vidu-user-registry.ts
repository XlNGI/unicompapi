import {
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProviderId,
  type ModelCapabilityEvidence,
  type Provider,
  type ProviderConnection,
  type ModelFeatureProfile,
  type ParameterSchemaV2,
  type ProviderModelDefinition,
  type ProviderModel,
  type ProviderOperationPurpose,
  type ProviderProtocolBinding
} from '../../src/domain';
import {
  VIDU_CREDENTIAL_SCHEMA_ID,
  VIDU_ENDPOINT_POLICY_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
  VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
  VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
  VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
  VIDU_IMAGE_V1_ADAPTER_ID,
  VIDU_IMAGE_V1_ADAPTER_VERSION,
  VIDU_IMAGE_V1_PROTOCOL_ID,
  VIDU_IMAGE_V1_PROTOCOL_VERSION,
  VIDU_OFFICIAL_TEMPLATE_ID,
  VIDU_PROVIDER_PACKAGE_ID,
  VIDU_PROVIDER_PACKAGE_VERSION,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
  VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
  VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
  VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
  createViduModelContract,
  frozenViduModelKeys
} from '../../src/platform';

export const VIDU_USER_PROVIDER_ID = toProviderId('provider-vidu');
export const VIDU_USER_CONNECTION_ID = toConnectionId('connection-vidu-default');

export const VIDU_USER_PROTOCOL_BINDING_IDS = {
  referenceVideoV2: toProtocolBindingId(
    'protocol-binding-vidu-reference-video-v2'
  ),
  imageV1: toProtocolBindingId('protocol-binding-vidu-image-v1'),
  geminiImageV2: toProtocolBindingId(
    'protocol-binding-vidu-gemini-image-v2'
  ),
  referenceImageV2: toProtocolBindingId(
    'protocol-binding-vidu-reference-image-v2'
  )
} as const;

export interface ViduUserRegistryRecords {
  readonly providers: readonly Provider[];
  readonly connections: readonly ProviderConnection[];
  readonly protocolBindings: readonly ProviderProtocolBinding[];
  readonly models: readonly ProviderModel[];
  readonly capabilities: readonly ModelCapabilityEvidence[];
  readonly modelDefinitions: readonly ProviderModelDefinition[];
  readonly modelProfiles: readonly ModelFeatureProfile[];
  readonly parameterSchemas: readonly ParameterSchemaV2[];
}

const catalogTimestamp = toIsoTimestamp('2026-07-28T00:00:00.000Z');

export function createUserViduRegistryRecords(): ViduUserRegistryRecords {
  const provider = createProvider({
    id: VIDU_USER_PROVIDER_ID,
    name: 'Vidu',
    packageId: VIDU_PROVIDER_PACKAGE_ID,
    packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
    accessCategory: 'online',
    identityState: 'unverified',
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp
  });
  const connection = createProviderConnection({
    id: VIDU_USER_CONNECTION_ID,
    providerId: provider.id,
    name: 'Vidu official connection',
    endpoint: 'https://api.vidu.cn',
    packageId: VIDU_PROVIDER_PACKAGE_ID,
    packageVersion: VIDU_PROVIDER_PACKAGE_VERSION,
    templateId: VIDU_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: VIDU_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-vidu-unconfigured-v1',
    connectionPolicyId: 'connection.vidu.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.vidu.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId: VIDU_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-vidu-default-v1',
    connectionRevision: 1,
    adapterBindings: [
      {
        adapterId: VIDU_IMAGE_V1_ADAPTER_ID,
        adapterVersion: VIDU_IMAGE_V1_ADAPTER_VERSION,
        protocolId: VIDU_IMAGE_V1_PROTOCOL_ID,
        protocolVersion: VIDU_IMAGE_V1_PROTOCOL_VERSION
      },
      {
        adapterId: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
        adapterVersion: VIDU_GEMINI_IMAGE_V2_ADAPTER_VERSION,
        protocolId: VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
        protocolVersion: VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION
      },
      {
        adapterId: VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
        adapterVersion: VIDU_REFERENCE_IMAGE_V2_ADAPTER_VERSION,
        protocolId: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
        protocolVersion: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION
      },
      {
        adapterId: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
        adapterVersion: VIDU_REFERENCE_VIDEO_V2_ADAPTER_VERSION,
        protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
        protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION
      }
    ],
    state: 'unconfigured',
    identityState: 'unverified',
    credentialState: 'not_configured',
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp
  });
  const protocolBindings = [
    createProviderProtocolBinding({
      id: VIDU_USER_PROTOCOL_BINDING_IDS.referenceVideoV2,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_VIDEO_V2_PROTOCOL_VERSION,
      mediaKind: 'video',
      adapterKind: VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
      endpointTemplate: 'https://api.vidu.cn/ent/v2/reference2video',
      authScheme: 'token',
      executionLifecycle: 'asynchronous_polling',
      supportedPurposes: ['reference_to_video'],
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    }),
    createProviderProtocolBinding({
      id: VIDU_USER_PROTOCOL_BINDING_IDS.imageV1,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: VIDU_IMAGE_V1_PROTOCOL_ID,
      protocolVersion: VIDU_IMAGE_V1_PROTOCOL_VERSION,
      mediaKind: 'image',
      adapterKind: VIDU_IMAGE_V1_ADAPTER_ID,
      endpointTemplate: 'https://api.vidu.cn/ent/v1/images/{operation}',
      authScheme: 'bearer',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['image_generation', 'image_editing'],
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    }),
    createProviderProtocolBinding({
      id: VIDU_USER_PROTOCOL_BINDING_IDS.geminiImageV2,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: VIDU_GEMINI_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_GEMINI_IMAGE_V2_PROTOCOL_VERSION,
      mediaKind: 'image',
      adapterKind: VIDU_GEMINI_IMAGE_V2_ADAPTER_ID,
      endpointTemplate:
        'https://api.vidu.cn/ent/v2/image/reference2image/{providerModelKey}',
      authScheme: 'token',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['reference_to_image'],
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    }),
    createProviderProtocolBinding({
      id: VIDU_USER_PROTOCOL_BINDING_IDS.referenceImageV2,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_ID,
      protocolVersion: VIDU_REFERENCE_IMAGE_V2_PROTOCOL_VERSION,
      mediaKind: 'image',
      adapterKind: VIDU_REFERENCE_IMAGE_V2_ADAPTER_ID,
      endpointTemplate: 'https://api.vidu.cn/ent/v2/reference2image',
      authScheme: 'token',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: [
        'reference_to_image',
        'image_generation',
        'image_editing'
      ],
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    })
  ] as const;

  const definitions: readonly {
    readonly providerModelKey: (typeof frozenViduModelKeys)[number];
    readonly modelId: string;
    readonly binding: ProviderProtocolBinding;
    readonly purposes: readonly ProviderOperationPurpose[];
  }[] = [
    ...frozenViduModelKeys.slice(0, 5).map((providerModelKey) => ({
      providerModelKey,
      modelId: `model-video-vidu-${providerModelKey}`,
      binding: protocolBindings[0],
      purposes: ['reference_to_video'] as const
    })),
    {
      providerModelKey: 'viduimage-2',
      modelId: 'model-image-vidu-viduimage-2',
      binding: protocolBindings[1],
      purposes: ['image_generation', 'image_editing']
    },
    ...frozenViduModelKeys.slice(6).map((providerModelKey) => ({
      providerModelKey,
      modelId: `model-image-vidu-gemini-${providerModelKey}`,
      binding:
        providerModelKey === 'viduq2' || providerModelKey === 'viduq1'
          ? protocolBindings[3]
          : protocolBindings[2],
      purposes: providerModelKey === 'viduq2'
        ? (['image_generation', 'reference_to_image', 'image_editing'] as const)
        : (['reference_to_image'] as const)
    }))
  ];

  const capabilities: ModelCapabilityEvidence[] = [];
  const models = definitions.map((definition) => {
    const modelId = toModelId(definition.modelId);
    const evidence = definition.purposes.map((purpose) =>
      createModelCapabilityEvidence({
        id: toCapabilityEvidenceId(
          `capability-${definition.modelId}-${purpose}-declared-v1`
        ),
        modelId,
        revision: 1,
        capability: purpose,
        state: 'declared_supported',
        source: 'provider_declared',
        recordedAt: catalogTimestamp
      })
    );
    capabilities.push(...evidence);
    return createProviderModel({
      id: modelId,
      providerId: provider.id,
      connectionId: connection.id,
      protocolBindingId: definition.binding.id,
      providerModelKey: definition.providerModelKey,
      mediaKind: definition.binding.mediaKind,
      revision: 1,
      displayName: definition.providerModelKey,
      capabilityEvidenceId: evidence[0]?.id,
      enabled: false,
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    });
  });

  const modelDefinitions: ProviderModelDefinition[] = [];
  const modelProfiles: ModelFeatureProfile[] = [];
  const parameterSchemas: ParameterSchemaV2[] = [];
  for (const model of models) {
    const contract = createViduModelContract(model.providerModelKey);
    const template = contract.definition.profileTemplates[0];
    modelDefinitions.push(contract.definition);
    parameterSchemas.push(...contract.parameterSchemas);
    modelProfiles.push({
      schemaVersion: 1,
      profileId: `profile-vidu-${model.providerModelKey}-migration-v1`,
      revision: 1,
      packageId: VIDU_PROVIDER_PACKAGE_ID,
      sourceTemplateId: template.templateId,
      adapterKey: template.adapterKey,
      modelId: model.id,
      modelRevision: model.revision,
      protocolBindingId: model.protocolBindingId,
      status: contract.defaultProfileStatus,
      features: template.features,
      evidenceIds: capabilities
        .filter((evidence) => evidence.modelId === model.id)
        .map((evidence) => evidence.id),
      recordedAt: catalogTimestamp
    });
  }

  return {
    providers: [provider],
    connections: [connection],
    protocolBindings,
    models,
    capabilities,
    modelDefinitions,
    modelProfiles,
    parameterSchemas
  };
}
