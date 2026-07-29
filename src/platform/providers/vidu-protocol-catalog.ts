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
  type ProviderModel,
  type ProviderOperationPurpose,
  type ProviderProtocolBinding
} from '../../domain';

export const VIDU_PROVIDER_ID = toProviderId('provider-vidu');
export const VIDU_CONNECTION_ID = toConnectionId('connection-vidu-default');

export const VIDU_PROTOCOL_BINDING_IDS = {
  referenceVideoV2: toProtocolBindingId(
    'protocol-binding-vidu-reference-video-v2'
  ),
  imageV1: toProtocolBindingId('protocol-binding-vidu-image-v1'),
  geminiImageV2: toProtocolBindingId(
    'protocol-binding-vidu-gemini-image-v2'
  )
} as const;

export const frozenViduModelKeys = [
  'viduq3-drama',
  'viduq3-ad',
  'viduq3-mix',
  'viduq3-turbo',
  'viduq3',
  'viduimage-2',
  'q2-fast',
  'q2-pro',
  'q3-fast',
  'q3-lite'
] as const;

export interface FrozenViduRegistryRecords {
  readonly providers: readonly Provider[];
  readonly connections: readonly ProviderConnection[];
  readonly protocolBindings: readonly ProviderProtocolBinding[];
  readonly models: readonly ProviderModel[];
  readonly capabilities: readonly ModelCapabilityEvidence[];
}

const catalogTimestamp = toIsoTimestamp('2026-07-28T00:00:00.000Z');

export function createFrozenViduRegistryRecords(): FrozenViduRegistryRecords {
  const provider = createProvider({
    id: VIDU_PROVIDER_ID,
    name: 'Vidu',
    accessCategory: 'online',
    identityState: 'unverified',
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp
  });
  const connection = createProviderConnection({
    id: VIDU_CONNECTION_ID,
    providerId: provider.id,
    name: 'Vidu official connection',
    state: 'unconfigured',
    identityState: 'unverified',
    credentialState: 'not_configured',
    createdAt: catalogTimestamp,
    updatedAt: catalogTimestamp
  });
  const protocolBindings = [
    createProviderProtocolBinding({
      id: VIDU_PROTOCOL_BINDING_IDS.referenceVideoV2,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: 'vidu.ent.v2.reference2video',
      protocolVersion: '2',
      mediaKind: 'video',
      adapterKind: 'vidu_reference_video_v2',
      endpointTemplate: 'https://api.vidu.cn/ent/v2/reference2video',
      authScheme: 'token',
      executionLifecycle: 'asynchronous_polling',
      supportedPurposes: ['reference_to_video'],
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    }),
    createProviderProtocolBinding({
      id: VIDU_PROTOCOL_BINDING_IDS.imageV1,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: 'vidu.ent.v1.images',
      protocolVersion: '1',
      mediaKind: 'image',
      adapterKind: 'vidu_image_v1',
      endpointTemplate: 'https://api.vidu.cn/ent/v1/images/{operation}',
      authScheme: 'unknown',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['image_generation', 'image_editing'],
      createdAt: catalogTimestamp,
      updatedAt: catalogTimestamp
    }),
    createProviderProtocolBinding({
      id: VIDU_PROTOCOL_BINDING_IDS.geminiImageV2,
      providerId: provider.id,
      connectionId: connection.id,
      protocolId: 'vidu.ent.v2.image.reference2image',
      protocolVersion: '2',
      mediaKind: 'image',
      adapterKind: 'vidu_gemini_image_v2',
      endpointTemplate:
        'https://api.vidu.cn/ent/v2/image/reference2image/{providerModelKey}',
      authScheme: 'token',
      executionLifecycle: 'synchronous_completed',
      supportedPurposes: ['reference_to_image'],
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
      binding: protocolBindings[2],
      purposes: ['reference_to_image'] as const
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

  return {
    providers: [provider],
    connections: [connection],
    protocolBindings,
    models,
    capabilities
  };
}
