import { describe, expect, it } from 'vitest';
import {
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProviderId
} from '../../src/domain';
import {
  NEWAPI_IMAGE_ADAPTER_ID,
  ProviderPackageRegistry,
  routeOpenAiCompatibleImageEditProfile,
  routeOpenAiCompatibleReferenceImageProfile,
  unicompapiProviderPackageDescriptor,
  UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_OFFICIAL_BASE_URL,
  UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
  type ProviderRegistrySnapshot
} from '../../src/platform';

const now = toIsoTimestamp('2026-08-11T06:00:00.000Z');

describe('UniCompAPI reference image soft routing', () => {
  it('routes qwen-image-edit-2509 as reference_to_image through newapi.image', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const snapshot = baseSnapshot();
    const routed = routeOpenAiCompatibleReferenceImageProfile(
      snapshot,
      packages,
      snapshot.models[0]!,
      now
    );

    expect(routed.state).toBe('attached');
    const profile = routed.snapshot.modelProfiles?.find(
      (candidate) => candidate.profileId === routed.profileId
    );
    expect(profile).toMatchObject({
      adapterKey: NEWAPI_IMAGE_ADAPTER_ID,
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      status: 'verified',
      features: [
        {
          productFeature: 'reference_to_image',
          internalPurpose: 'reference_to_image'
        }
      ]
    });
    expect(routed.snapshot.modelDefinitions?.find((definition) =>
      definition.providerModelKey === 'qwen-image-edit-2509'
    )).toBeTruthy();
    expect(routed.snapshot.capabilities.some((candidate) =>
      candidate.modelId === snapshot.models[0]!.id &&
      candidate.capability === 'reference_to_image'
    )).toBe(true);
  });

  it('does not attach the retired image_edit contract for qwen-image-edit-2509', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const snapshot = baseSnapshot();
    const routed = routeOpenAiCompatibleImageEditProfile(
      snapshot,
      packages,
      snapshot.models[0]!,
      now
    );

    expect(routed.state).toBe('skipped');
    expect(routed.snapshot.modelProfiles).toEqual([]);
  });
});

function baseSnapshot(): ProviderRegistrySnapshot {
  const providerId = toProviderId('provider-unicompapi-qwen-image');
  const connectionId = toConnectionId('connection-unicompapi-qwen-image');
  const bindingId = toProtocolBindingId('binding-unicompapi-qwen-image-chat');
  const modelId = toModelId('model-unicompapi-qwen-image-edit-2509');
  const connection = createProviderConnection({
    id: connectionId,
    providerId,
    name: 'UniCompAPI',
    endpoint: UNICOMPAPI_OFFICIAL_BASE_URL,
    packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
    packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
    templateId: UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-qwen-image-1',
    connectionPolicyId: 'connection.unicompapi.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.unicompapi.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-qwen-image-1',
    connectionRevision: 1,
    adapterBindings: unicompapiProviderPackageDescriptor.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocolId: adapter.protocolId,
      protocolVersion: adapter.protocolVersion
    })),
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-reference-qwen-image-1',
    createdAt: now,
    updatedAt: now
  });
  return {
    schemaVersion: 2,
    providers: [createProvider({
      id: providerId,
      name: 'UniCompAPI',
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
      accessCategory: 'online',
      identityState: 'verified',
      createdAt: now,
      updatedAt: now
    })],
    connections: [connection],
    models: [createProviderModel({
      id: modelId,
      providerId,
      connectionId,
      protocolBindingId: bindingId,
      providerModelKey: 'qwen-image-edit-2509',
      displayName: 'qwen-image-edit-2509',
      mediaKind: 'unknown',
      enabled: true,
      catalogState: 'present',
      revision: 1,
      createdAt: now,
      updatedAt: now
    })],
    capabilities: [],
    protocolBindings: [createProviderProtocolBinding({
      id: bindingId,
      providerId,
      connectionId,
      protocolId: 'newapi.openai.chat-completions',
      protocolVersion: '2026-08-03',
      mediaKind: 'unknown',
      adapterKind: 'newapi.chat',
      authScheme: 'unknown',
      executionLifecycle: 'unknown',
      supportedPurposes: [],
      createdAt: now,
      updatedAt: now
    })],
    routingPreferences: [],
    modelProfiles: [],
    modelDefinitions: []
  };
}
