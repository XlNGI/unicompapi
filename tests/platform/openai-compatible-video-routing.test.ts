import { describe, expect, it } from 'vitest';
import {
  createModelCapabilityEvidence,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toCapabilityEvidenceId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProviderId
} from '../../src/domain';
import {
  NEWAPI_VIDEO_ADAPTER_ID,
  ProviderPackageRegistry,
  routeOpenAiCompatibleVideoProfile,
  unicompapiProviderPackageDescriptor,
  UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_OFFICIAL_BASE_URL,
  UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION
} from '../../src/platform';
import type { ProviderRegistrySnapshot } from '../../src/platform';

const now = toIsoTimestamp('2026-08-07T08:00:00.000Z');

describe('openai-compatible video soft routing', () => {
  it('attaches newapi.video text_to_video and image_to_video when package publishes video', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const snapshot = baseSnapshot();
    const model = snapshot.models[0]!;
    const routed = routeOpenAiCompatibleVideoProfile(snapshot, packages, model, now);
    expect(routed.state).toBe('attached');
    expect(routed.profileId).toBeTruthy();
    const profile = routed.snapshot.modelProfiles?.find(
      (candidate) => candidate.profileId === routed.profileId
    );
    expect(profile).toMatchObject({
      adapterKey: NEWAPI_VIDEO_ADAPTER_ID,
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      status: 'verified'
    });
    expect(profile?.features.map((feature) => feature.productFeature).sort()).toEqual([
      'image_to_video',
      'text_to_video'
    ]);
    expect(routed.snapshot.capabilities.some((candidate) =>
      candidate.modelId === model.id && candidate.capability === 'video_generation'
    )).toBe(true);
  });

  it('is idempotent for an already attached video profile', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const first = routeOpenAiCompatibleVideoProfile(
      baseSnapshot(),
      packages,
      baseSnapshot().models[0]!,
      now
    );
    const second = routeOpenAiCompatibleVideoProfile(
      first.snapshot,
      packages,
      first.model,
      now
    );
    expect(second.state).toBe('already_attached');
    expect(second.profileId).toBe(first.profileId);
    expect(
      (second.snapshot.modelProfiles ?? []).filter(
        (candidate) =>
          candidate.modelId === first.model.id &&
          candidate.adapterKey === NEWAPI_VIDEO_ADAPTER_ID
      )
    ).toHaveLength(1);
  });
});

function baseSnapshot(): ProviderRegistrySnapshot {
  const providerId = toProviderId('provider-unicompapi');
  const connectionId = toConnectionId('connection-unicompapi');
  const modelId = toModelId('model-unicompapi');
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
    credentialVersionId: 'credential-version-1',
    connectionPolicyId: 'connection.unicompapi.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.unicompapi.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-1',
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
    credentialReference: 'credential-reference-1',
    createdAt: now,
    updatedAt: now
  });
  const model = createProviderModel({
    id: modelId,
    providerId,
    connectionId,
    providerModelKey: 'video-capable-model',
    displayName: 'Video Capable',
    enabled: true,
    catalogState: 'present',
    revision: 1,
    createdAt: now,
    updatedAt: now
  });
  const chatBinding = createProviderProtocolBinding({
    id: toProtocolBindingId('protocol-binding-chat'),
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
  });
  const capability = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(`capability-${modelId}-text_generation-declared-v1`),
    modelId,
    revision: 1,
    capability: 'text_generation',
    state: 'declared_supported',
    source: 'provider_declared',
    recordedAt: now
  });
  return {
    providers: [{
      id: providerId,
      name: 'UniCompAPI',
      kind: 'third_party',
      createdAt: now,
      updatedAt: now
    }],
    connections: [connection],
    models: [model],
    capabilities: [capability],
    protocolBindings: [chatBinding],
    routingPreferences: [],
    modelProfiles: [],
    modelDefinitions: []
  };
}
