import { describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  type ParameterSchemaV2,
  type ProviderModelDefinition,
  type ProviderPackageDescriptor
} from '../../src/domain';
import {
  createImageProviderFeatureContracts,
  createVideoProviderFeatureContracts,
  createMiniMaxVideoModelContract,
  createViduModelContract,
  type JsonProviderRegistryStore,
  type ProviderRegistrySnapshot,
  minimaxH3ProviderPackageDescriptor,
  MINIMAX_H3_CN_BASE_URL,
  MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
  MINIMAX_H3_CN_TEMPLATE_ID,
  MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
  ProviderFeatureContractRegistry,
  ProviderPackageRegistry,
  RegistryFeatureCandidateSource,
  unicompapiProviderPackageDescriptor,
  UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_OFFICIAL_BASE_URL,
  UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  viduProviderPackageDescriptor,
  viduUsageSchema,
  VIDU_CREDENTIAL_SCHEMA_ID,
  VIDU_ENDPOINT_POLICY_ID,
  VIDU_MULTI_IMAGE_CONSTRAINT_SET_ID,
  VIDU_OFFICIAL_BASE_URL,
  VIDU_OFFICIAL_TEMPLATE_ID,
  type ResolvedFeatureSubjectV1
} from '../../src/platform';

const now = toIsoTimestamp('2026-09-29T00:00:00.000Z');
const projectId = toProjectId('project-multi-reference-gate');

class MemoryRegistry {
  constructor(private snapshot: ProviderRegistrySnapshot) {}

  async load(): Promise<ProviderRegistrySnapshot> {
    return this.snapshot;
  }

  async mutate<T>(
    mutator: (
      snapshot: ProviderRegistrySnapshot
    ) => { readonly snapshot: ProviderRegistrySnapshot; readonly result: T } | Promise<{ readonly snapshot: ProviderRegistrySnapshot; readonly result: T }>
  ): Promise<T> {
    const mutation = await mutator(this.snapshot);
    this.snapshot = mutation.snapshot;
    return mutation.result;
  }
}

describe('multi-reference candidate contracts', () => {
  const source = new RegistryFeatureCandidateSource(
    new MemoryRegistry(gateSnapshot()) as unknown as JsonProviderRegistryStore,
    new ProviderPackageRegistry([
      unicompapiProviderPackageDescriptor,
      viduProviderPackageDescriptor,
      minimaxH3ProviderPackageDescriptor
    ]),
    new ProviderFeatureContractRegistry([
      ...createImageProviderFeatureContracts(),
      ...createVideoProviderFeatureContracts(),
      customMultiReferenceContract()
    ]),
    { async checkAccess() { return { allowed: true, operation: 'submit' as const, reason: 'allowed' as const, policyId: 'policy-gate', policyRevision: 1 }; } }
  );

  it('keeps one image available without opening an unverified multi-image contract', async () => {
    const image = await supported('reference_to_image', 1);
    expect(image.get('viduq1')).toBe(true);
    expect(image.get('viduq2')).toBe(true);
    expect(image.get('q2-fast')).toBe(true);
    expect(image.get('custom-multi-reference')).toBe(true);

    const video = await supported('image_to_video', 1);
    expect(video.get('doubao-seedance-2-0-260128')).toBe(true);
    expect(video.get('doubao-seedance-2-0-fast-260128')).toBe(true);
    expect(video.get('viduq3-turbo')).toBe(true);
    expect(video.get('viduq3')).toBe(true);
    expect(video.get('MiniMax-H3')).toBe(true);
  });

  it('allows multiple images only for verified contracts and their declared limits', async () => {
    const image = await supported('reference_to_image', 2);
    expect(image.get('viduq1')).toBe(true);
    expect(image.get('viduq2')).toBe(true);
    expect(image.get('custom-multi-reference')).toBe(true);
    expect(image.get('q2-fast')).toBe(false);
    const seven = await supported('reference_to_image', 7);
    expect(seven.get('viduq1')).toBe(true);
    expect(seven.get('custom-multi-reference')).toBe(true);
    const eight = await supported('reference_to_image', 8);
    expect(eight.get('viduq1')).toBe(false);
    expect(eight.get('viduq2')).toBe(false);
    expect(eight.get('custom-multi-reference')).toBe(false);

    const video = await supported('image_to_video', 2);
    expect(video.get('doubao-seedance-2-0-260128')).toBe(true);
    expect(video.get('doubao-seedance-2-0-fast-260128')).toBe(false);
    expect(video.get('viduq3-turbo')).toBe(false);
    expect(video.get('viduq3')).toBe(true);
    expect(video.get('MiniMax-H3')).toBe(true);
    const nine = await supported('image_to_video', 9);
    expect(nine.get('doubao-seedance-2-0-260128')).toBe(true);
    expect(nine.get('MiniMax-H3')).toBe(true);
    expect(nine.get('viduq3')).toBe(false);
    const ten = await supported('image_to_video', 10);
    expect(ten.get('doubao-seedance-2-0-260128')).toBe(false);
    expect(ten.get('MiniMax-H3')).toBe(false);
  });

  async function supported(
    productFeature: 'reference_to_image' | 'image_to_video',
    imageCount: number
  ): Promise<Map<string, boolean>> {
    const candidates = await source.list(subject(productFeature, imageCount));
    return new Map(candidates.map((candidate) => [
      candidate.modelName,
      candidate.eligibility.featureSupported
    ]));
  }
});

function subject(
  productFeature: 'reference_to_image' | 'image_to_video',
  imageCount: number
): ResolvedFeatureSubjectV1 {
  return {
    projectId,
    subject: {
      kind: 'draft',
      draftId: toDraftId('draft-multi-reference-gate'),
      draftRevision: 1
    },
    productFeature,
    surface: 'professional',
    imageCount,
    videoCount: 0,
    contextCount: 0,
    parameterValues: {},
    outboundTextSnapshot: 'image 1 and image 2',
    materialReferences: [],
    contextContentHashes: []
  };
}

function gateSnapshot(): ProviderRegistrySnapshot {
  const vidu = packageModels({
    descriptor: viduProviderPackageDescriptor,
    providerName: 'Vidu',
    endpoint: VIDU_OFFICIAL_BASE_URL,
    templateId: VIDU_OFFICIAL_TEMPLATE_ID,
    credentialSchemaId: VIDU_CREDENTIAL_SCHEMA_ID,
    endpointPolicyId: VIDU_ENDPOINT_POLICY_ID,
    models: [
      modelFromContract('viduq1', createViduModelContract('viduq1')),
      modelFromContract('viduq2', createViduModelContract('viduq2')),
      modelFromContract('q2-fast', createViduModelContract('q2-fast')),
      modelFromContract('viduq3', createViduModelContract('viduq3')),
      customMultiReferenceModel()
    ]
  });
  const unicomp = packageModels({
    descriptor: unicompapiProviderPackageDescriptor,
    providerName: 'UniCompAPI',
    endpoint: UNICOMPAPI_OFFICIAL_BASE_URL,
    templateId: UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
    credentialSchemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
    endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID,
    models: [
      bareModel('doubao-seedance-2-0-260128'),
      bareModel('doubao-seedance-2-0-fast-260128'),
      bareModel('viduq3-turbo')
    ]
  });
  const minimax = packageModels({
    descriptor: minimaxH3ProviderPackageDescriptor,
    providerName: 'MiniMax',
    endpoint: MINIMAX_H3_CN_BASE_URL,
    templateId: MINIMAX_H3_CN_TEMPLATE_ID,
    credentialSchemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
    endpointPolicyId: MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
    models: [modelFromContract('MiniMax-H3', createMiniMaxVideoModelContract('MiniMax-H3'))]
  });
  return {
    schemaVersion: 2,
    providers: [vidu.provider, unicomp.provider, minimax.provider],
    connections: [vidu.connection, unicomp.connection, minimax.connection],
    protocolBindings: [
      ...vidu.protocolBindings,
      ...unicomp.protocolBindings,
      ...minimax.protocolBindings
    ],
    models: [...vidu.models, ...unicomp.models, ...minimax.models],
    capabilities: [],
    routingPreferences: [],
    modelProfiles: [
      ...vidu.modelProfiles,
      ...unicomp.modelProfiles,
      ...minimax.modelProfiles
    ],
    modelDefinitions: []
  };
}

function modelFromContract(
  providerModelKey: string,
  contract: {
    readonly definition: {
      readonly profileTemplates: readonly {
        readonly adapterKey: string;
        readonly features: ProviderModelDefinition['profileTemplates'][number]['features'];
      }[];
    };
    readonly defaultProfileStatus?: 'verified' | 'restricted' | 'disabled';
  }
) {
  const template = contract.definition.profileTemplates[0];
  if (!template) throw new Error(`Missing profile template for ${providerModelKey}`);
  return {
    providerModelKey,
    adapterKey: template.adapterKey,
    status: contract.defaultProfileStatus ?? 'verified' as const,
    features: template.features
  };
}

function bareModel(providerModelKey: string) {
  return {
    providerModelKey,
    adapterKey: unicompapiProviderPackageDescriptor.adapters.find(
      (adapter) => adapter.adapterId === 'newapi.chat'
    )!.adapterId,
    status: 'verified' as const,
    features: []
  };
}

function customMultiReferenceModel() {
  const feature = customMultiReferenceContract();
  return {
    providerModelKey: 'custom-multi-reference',
    adapterKey: viduProviderPackageDescriptor.adapters.find(
      (adapter) => adapter.adapterId === 'vidu_reference_image_v2'
    )!.adapterId,
    status: 'verified' as const,
    features: [{
      productFeature: 'reference_to_image' as const,
      internalPurpose: 'reference_to_image',
      parameterSchemaId: feature.parameterSchema.schemaId,
      resultSchemaId: feature.resultSchemaId,
      usageSchemaId: feature.usageSchema.id,
      constraintSetId: feature.constraintSetId
    }]
  };
}

function customMultiReferenceContract() {
  const official = createViduModelContract('viduq1').parameterSchemas[0]!;
  const parameterSchema: ParameterSchemaV2 = {
    ...official,
    schemaId: 'parameters.test.custom-multi-reference',
    fields: official.fields.map((field) => ({
      ...field,
      ...(field.options ? { options: [...field.options] } : {})
    }))
  };
  const feature = createViduModelContract('viduq1').definition.profileTemplates[0]!.features[0]!;
  return {
    parameterSchema,
    resultSchemaId: feature.resultSchemaId,
    resultSchemaRevision: 1,
    usageSchema: viduUsageSchema,
    constraintSetId: VIDU_MULTI_IMAGE_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    featureMappingVersion: 1
  };
}

function packageModels(input: {
  readonly descriptor: ProviderPackageDescriptor;
  readonly providerName: string;
  readonly endpoint: string;
  readonly templateId: string;
  readonly credentialSchemaId: string;
  readonly endpointPolicyId: string;
  readonly models: readonly {
    readonly providerModelKey: string;
    readonly adapterKey: string;
    readonly status: 'verified' | 'restricted' | 'disabled';
    readonly features: ProviderModelDefinition['profileTemplates'][number]['features'];
  }[];
}) {
  const slug = input.descriptor.packageId;
  const providerId = toProviderId(`provider-${slug}`);
  const connectionId = toConnectionId(`connection-${slug}`);
  const bindings = input.descriptor.adapters.map((adapter) => createProviderProtocolBinding({
    id: toProtocolBindingId(`binding-${slug}-${adapter.adapterId}`),
    providerId,
    connectionId,
    protocolId: adapter.protocolId,
    protocolVersion: adapter.protocolVersion,
    mediaKind: 'unknown',
    adapterKind: adapter.adapterId,
    authScheme: 'token',
    executionLifecycle: 'unknown',
    supportedPurposes: [],
    createdAt: now,
    updatedAt: now
  }));
  const provider = createProvider({
    id: providerId,
    name: input.providerName,
    packageId: input.descriptor.packageId,
    packageVersion: input.descriptor.packageVersion,
    accessCategory: 'online',
    identityState: 'verified',
    createdAt: now,
    updatedAt: now
  });
  const connection = createProviderConnection({
    id: connectionId,
    providerId,
    name: input.providerName,
    endpoint: input.endpoint,
    packageId: input.descriptor.packageId,
    packageVersion: input.descriptor.packageVersion,
    templateId: input.templateId,
    templateKind: 'official',
    credentialSchemaId: input.credentialSchemaId,
    credentialSchemaVersion: 1,
    credentialVersionId: `credential-${slug}`,
    connectionPolicyId: `connection-policy.${slug}`,
    connectionPolicyRevision: 1,
    discoveryPolicyId: `discovery-policy.${slug}`,
    discoveryPolicyRevision: 1,
    endpointPolicyId: input.endpointPolicyId,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: `connection-config-${slug}`,
    connectionRevision: 1,
    adapterBindings: input.descriptor.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocolId: adapter.protocolId,
      protocolVersion: adapter.protocolVersion
    })),
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: `credential-reference-${slug}`,
    createdAt: now,
    updatedAt: now
  });
  const models = input.models.map((item) => {
    const binding = bindings.find((candidate) => candidate.adapterKind === item.adapterKey);
    if (!binding) throw new Error(`Missing binding for ${item.providerModelKey}`);
    return createProviderModel({
      id: toModelId(`model-${slug}-${item.providerModelKey}`),
      providerId,
      connectionId,
      protocolBindingId: binding.id,
      providerModelKey: item.providerModelKey,
      displayName: item.providerModelKey,
      mediaKind: 'unknown',
      enabled: true,
      catalogState: 'present',
      revision: 1,
      activeProfileId: `profile-${slug}-${item.providerModelKey}`,
      createdAt: now,
      updatedAt: now
    });
  });
  const modelProfiles = input.models.flatMap((item) => {
    if (item.features.length === 0) return [];
    const binding = bindings.find((candidate) => candidate.adapterKind === item.adapterKey);
    return [{
      schemaVersion: 1 as const,
      profileId: `profile-${slug}-${item.providerModelKey}`,
      revision: 1,
      packageId: input.descriptor.packageId,
      sourceTemplateId: `profile-template-${item.providerModelKey}`,
      adapterKey: item.adapterKey,
      modelId: `model-${slug}-${item.providerModelKey}`,
      modelRevision: 1,
      protocolBindingId: binding!.id,
      status: item.status,
      features: item.features,
      evidenceIds: [],
      recordedAt: now
    }];
  });
  return { provider, connection, protocolBindings: bindings, models, modelProfiles };
}
