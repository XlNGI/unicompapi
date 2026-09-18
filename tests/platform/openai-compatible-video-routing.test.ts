import { describe, expect, it } from 'vitest';
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
  toProviderId
} from '../../src/domain';
import {
  NEWAPI_VIDEO_ADAPTER_ID,
  NEWAPI_COMPATIBLE_TEMPLATE_ID,
  NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION,
  ProviderPackageRegistry,
  describeInvalidatedOpenAiCompatibleVideoProfiles,
  newApiProviderPackageDescriptor,
  routeOpenAiCompatibleVideoProfile,
  unicompapiProviderPackageDescriptor,
  UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_OFFICIAL_BASE_URL,
  UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
  UNICOMPAPI_SEEDANCE_2_FAST_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_SEEDANCE_2_FAST_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_VIDUQ3_PRO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_VIDUQ3_TURBO_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
  UNICOMPAPI_VIDUQ3_TURBO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
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

  it('does not infer video capabilities for unknown UniCompAPI model keys', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const snapshot = baseSnapshot();
    const model = {
      ...snapshot.models[0]!,
      providerModelKey: 'future-video-model',
      displayName: 'Future Video Model'
    };
    const routed = routeOpenAiCompatibleVideoProfile(
      { ...snapshot, models: [model] },
      packages,
      model,
      now
    );
    expect(routed.state).toBe('skipped');
    expect(routed.profileId).toBeUndefined();
    expect(routed.snapshot.modelProfiles).toEqual([]);
    expect(routed.snapshot.capabilities.some((candidate) =>
      candidate.modelId === model.id && candidate.capability === 'video_generation'
    )).toBe(false);
  });

  it('migrates exact UniCompAPI Seedance profiles from generic schemas', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const seeded = baseSnapshot('doubao-seedance-2-0-fast-260128');
    const attached = routeOpenAiCompatibleVideoProfile(
      seeded,
      packages,
      seeded.models[0]!,
      now
    );
    const staleSnapshot: ProviderRegistrySnapshot = {
      ...attached.snapshot,
      modelProfiles: attached.snapshot.modelProfiles?.map((profile) => ({
        ...profile,
        features: profile.features.map((feature) => ({
          ...feature,
          parameterSchemaId: feature.productFeature === 'text_to_video'
            ? NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
            : NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID
        }))
      }))
    };
    const migrated = routeOpenAiCompatibleVideoProfile(
      staleSnapshot,
      packages,
      attached.model,
      now
    );
    expect(migrated.state).toBe('already_attached');
    expect(migrated.snapshot.modelProfiles?.[0]?.features).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productFeature: 'text_to_video',
        parameterSchemaId: UNICOMPAPI_SEEDANCE_2_FAST_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
      }),
      expect.objectContaining({
        productFeature: 'image_to_video',
        parameterSchemaId: UNICOMPAPI_SEEDANCE_2_FAST_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID
      })
    ]));
  });

  it('migrates exact UniCompAPI Vidu profiles from generic schemas', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const seeded = baseSnapshot('viduq3-turbo');
    const attached = routeOpenAiCompatibleVideoProfile(
      seeded,
      packages,
      seeded.models[0]!,
      now
    );
    const staleSnapshot: ProviderRegistrySnapshot = {
      ...attached.snapshot,
      modelProfiles: attached.snapshot.modelProfiles?.map((profile) => ({
        ...profile,
        features: profile.features.map((feature) => ({
          ...feature,
          parameterSchemaId: feature.productFeature === 'text_to_video'
            ? NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
            : NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID
        }))
      }))
    };
    const migrated = routeOpenAiCompatibleVideoProfile(
      staleSnapshot,
      packages,
      attached.model,
      now
    );
    expect(migrated.state).toBe('already_attached');
    expect(migrated.snapshot.modelProfiles?.[0]?.features).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productFeature: 'text_to_video',
        parameterSchemaId: UNICOMPAPI_VIDUQ3_TURBO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
      }),
      expect.objectContaining({
        productFeature: 'image_to_video',
        parameterSchemaId: UNICOMPAPI_VIDUQ3_TURBO_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID
      })
    ]));
  });

  it('routes viduq3-pro to its exact text-only mapping and skips unsupported Vidu keys', () => {
    const packages = new ProviderPackageRegistry([unicompapiProviderPackageDescriptor]);
    const pro = baseSnapshot('viduq3-pro');
    const routed = routeOpenAiCompatibleVideoProfile(pro, packages, pro.models[0]!, now);
    expect(routed.state).toBe('attached');
    expect(routed.snapshot.modelProfiles?.[0]?.features).toEqual([
      expect.objectContaining({
        productFeature: 'text_to_video',
        parameterSchemaId: UNICOMPAPI_VIDUQ3_PRO_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
      })
    ]);

    for (const providerModelKey of ['viduq3', 'viduq3-mix']) {
      const unsupported = baseSnapshot(providerModelKey);
      const skipped = routeOpenAiCompatibleVideoProfile(
        unsupported,
        packages,
        unsupported.models[0]!,
        now
      );
      expect(skipped.state).toBe('skipped');
      expect(skipped.snapshot.modelProfiles).toEqual([]);
    }
  });

  it('never infers per-model video capability from a generic OpenAI-compatible adapter', () => {
    const packages = new ProviderPackageRegistry([newApiProviderPackageDescriptor]);
    const snapshot = baseSnapshot('viduq3-turbo');
    const connection = {
      ...snapshot.connections[0]!,
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
      templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID
    };
    const routed = routeOpenAiCompatibleVideoProfile(
      { ...snapshot, connections: [connection] },
      packages,
      snapshot.models[0]!,
      now
    );
    // The connection publishes newapi.video, but that only proves a call
    // channel exists. The concrete model published no capability evidence.
    expect(routed.state).toBe('skipped');
    expect(routed.reason).toBe('missing_capability_evidence');
    expect(routed.profileId).toBeUndefined();
    expect(routed.snapshot.modelProfiles).toEqual([]);
    expect(routed.snapshot.capabilities.some((candidate) =>
      candidate.capability === 'video_generation'
    )).toBe(false);
  });

  it('skips image-only and unknown-capability models behind a generic package', () => {
    const packages = new ProviderPackageRegistry([newApiProviderPackageDescriptor]);
    for (const providerModelKey of ['gpt-image-2.5', 'gpt-image-2-auto', 'ergouzi/e-image']) {
      const snapshot = baseSnapshot(providerModelKey);
      const connection = {
        ...snapshot.connections[0]!,
        packageId: NEWAPI_PROVIDER_PACKAGE_ID,
        packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
        templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID
      };
      const routed = routeOpenAiCompatibleVideoProfile(
        { ...snapshot, connections: [connection] },
        packages,
        snapshot.models[0]!,
        now
      );
      expect(routed.state).toBe('skipped');
      expect(routed.reason).toBe('missing_capability_evidence');
      expect(routed.snapshot.modelProfiles).toEqual([]);
    }
  });

  it('attaches a generic package profile once the user explicitly confirms the model', () => {
    const packages = new ProviderPackageRegistry([newApiProviderPackageDescriptor]);
    const snapshot = baseSnapshot('relay-video-model');
    const connection = {
      ...snapshot.connections[0]!,
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
      templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID
    };
    const confirmation = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId(
        `capability-${snapshot.models[0]!.id}-video_generation-user-confirmed-v1`
      ),
      modelId: snapshot.models[0]!.id,
      revision: 1,
      capability: 'video_generation',
      state: 'user_confirmed',
      source: 'user_confirmed',
      recordedAt: now
    });
    const routed = routeOpenAiCompatibleVideoProfile(
      {
        ...snapshot,
        connections: [connection],
        capabilities: [...snapshot.capabilities, confirmation]
      },
      packages,
      snapshot.models[0]!,
      now
    );
    expect(routed.state).toBe('attached');
    expect(routed.snapshot.modelProfiles?.[0]?.features).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productFeature: 'text_to_video',
        parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID
      }),
      expect.objectContaining({
        productFeature: 'image_to_video',
        parameterSchemaId: NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID
      })
    ]));
    // The user's own fact is reused; the platform does not restate it.
    expect(routed.snapshot.capabilities.filter((candidate) =>
      candidate.capability === 'video_generation'
    )).toHaveLength(1);
  });

  it('ignores evidence the removed soft router synthesised for itself', () => {
    const packages = new ProviderPackageRegistry([newApiProviderPackageDescriptor]);
    const snapshot = baseSnapshot('gpt-image-2.5');
    const connection = {
      ...snapshot.connections[0]!,
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
      templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID
    };
    const forged = createModelCapabilityEvidence({
      id: toCapabilityEvidenceId(
        `capability-${snapshot.models[0]!.id}-video_generation-declared-v1`
      ),
      modelId: snapshot.models[0]!.id,
      revision: 1,
      capability: 'video_generation',
      state: 'declared_supported',
      source: 'provider_declared',
      recordedAt: now
    });
    const legacyProfile = {
      schemaVersion: 1 as const,
      profileId: 'profile-legacy-forged-video',
      revision: 1,
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      sourceTemplateId: 'profile-template.openai-compatible.video.legacy',
      adapterKey: NEWAPI_VIDEO_ADAPTER_ID,
      modelId: snapshot.models[0]!.id,
      modelRevision: 1,
      protocolBindingId: 'protocol-binding-chat',
      status: 'verified' as const,
      features: [
        {
          productFeature: 'text_to_video' as const,
          internalPurpose: 'video_generation',
          parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
          resultSchemaId: 'results.newapi.video',
          usageSchemaId: 'usage.newapi.video-not-reported',
          constraintSetId: 'constraints.newapi.text-to-video'
        }
      ],
      evidenceIds: [forged.id],
      recordedAt: now
    };
    const routed = routeOpenAiCompatibleVideoProfile(
      {
        ...snapshot,
        connections: [connection],
        capabilities: [...snapshot.capabilities, forged],
        modelProfiles: [legacyProfile]
      },
      packages,
      snapshot.models[0]!,
      now
    );
    expect(routed.state).toBe('skipped');
    expect(routed.reason).toBe('missing_capability_evidence');
    // The persisted mistake is left untouched so nothing is lost or rewritten.
    expect(routed.snapshot.modelProfiles).toEqual([legacyProfile]);

    const invalidations = describeInvalidatedOpenAiCompatibleVideoProfiles(
      routed.snapshot,
      (productFeature) => productFeature === 'text_to_video' || productFeature === 'image_to_video'
    );
    expect(invalidations).toEqual([
      expect.objectContaining({
        profileId: 'profile-legacy-forged-video',
        reason: 'router_synthesized_evidence',
        gateVersion: OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION
      })
    ]);
  });
});

function baseSnapshot(providerModelKey = 'viduq3-turbo'): ProviderRegistrySnapshot {
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
    providerModelKey,
    displayName: providerModelKey,
    protocolBindingId: toProtocolBindingId('protocol-binding-chat'),
    mediaKind: 'unknown',
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
    schemaVersion: 2,
    providers: [createProvider({
      id: providerId,
      name: 'UniCompAPI',
      accessCategory: 'online',
      identityState: 'verified',
      createdAt: now,
      updatedAt: now
    })],
    connections: [connection],
    models: [model],
    capabilities: [capability],
    protocolBindings: [chatBinding],
    routingPreferences: [],
    modelProfiles: [],
    modelDefinitions: []
  };
}
