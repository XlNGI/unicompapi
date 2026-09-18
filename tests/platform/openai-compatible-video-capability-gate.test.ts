import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  type FeatureCandidateSubjectV1,
  type ProductFeature
} from '../../src/domain';
import {
  JsonProviderRegistryStore,
  JsonRuntimeAuthorizationLedgerStore,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID,
  NEWAPI_COMPATIBLE_TEMPLATE_ID,
  NEWAPI_CREDENTIAL_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
  NEWAPI_ENDPOINT_POLICY_ID,
  NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_VIDEO_ADAPTER_ID,
  NEWAPI_VIDEO_PROTOCOL_ID,
  NEWAPI_VIDEO_RESULT_SCHEMA_ID,
  OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION,
  ProviderFeatureCandidateService,
  ProviderFeatureContractRegistry,
  ProviderPackageRegistry,
  RegistryFeatureCandidateSource,
  RouteSelectionTokenVault,
  RuntimeAuthorizationLedger,
  createOpenAiCompatibleDefaultVideoDefinition,
  describeInvalidatedOpenAiCompatibleVideoProfiles,
  newApiDefaultTextToVideoParameterSchema,
  newApiProviderPackageDescriptor,
  newApiVideoUsageSchema,
  type FeatureSubjectResolverPort,
  type ResolvedFeatureSubjectV1
} from '../../src/platform';

/**
 * P1 regression: a video profile that the removed soft router fabricated must
 * never reach a creation candidate, even though it is still persisted in the
 * user registry and still looks internally consistent.
 */

const roots: string[] = [];
const now = toIsoTimestamp('2026-09-18T02:00:00.000Z');
const providerId = toProviderId('provider-relay');
const connectionId = toConnectionId('connection-relay');
const modelId = toModelId('model-relay-image');
const chatBindingId = toProtocolBindingId('protocol-binding-relay-chat');
const videoBindingId = toProtocolBindingId('protocol-binding-relay-video');
const draftSubject: FeatureCandidateSubjectV1 = {
  kind: 'draft',
  draftId: toDraftId('draft-video-gate'),
  draftRevision: 1
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe('video candidate capability gate', () => {
  it('excludes a persisted forged video profile from video candidates', async () => {
    const fixture = await relayFixture({
      productFeature: 'text_to_video',
      trustedEvidence: false
    });
    const candidates = await fixture.service.listFeatureCandidates(draftSubject);
    expect(candidates).toEqual([]);
  });

  it('reports why the persisted profile was invalidated, with the gate version', async () => {
    const fixture = await relayFixture({
      productFeature: 'text_to_video',
      trustedEvidence: false
    });
    const snapshot = await fixture.registry.load();
    expect(describeInvalidatedOpenAiCompatibleVideoProfiles(
      snapshot,
      (productFeature) => productFeature === 'text_to_video'
    )).toEqual([
      expect.objectContaining({
        profileId: 'profile-relay-forged-video',
        providerModelKey: 'gpt-image-2.5',
        reason: 'router_synthesized_evidence',
        gateVersion: OPENAI_COMPATIBLE_VIDEO_PROFILE_GATE_VERSION
      })
    ]);
  });

  it('lists the video candidate once trustworthy per-model evidence exists', async () => {
    const fixture = await relayFixture({
      productFeature: 'text_to_video',
      trustedEvidence: true
    });
    const candidates = await fixture.service.listFeatureCandidates(draftSubject);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      providerName: 'Relay',
      connectionName: 'Relay connection',
      modelName: 'gpt-image-2.5',
      available: true
    });
  });
});

async function relayFixture(input: {
  readonly productFeature: ProductFeature;
  readonly trustedEvidence: boolean;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-gate-'));
  roots.push(root);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const authorization = new RuntimeAuthorizationLedger(
    new JsonRuntimeAuthorizationLedgerStore(path.join(root, 'authorization.json')),
    () => now
  );
  await authorization.upsertPolicy({
    policyId: 'policy-relay-video',
    providerPackageId: NEWAPI_PROVIDER_PACKAGE_ID,
    connectionId,
    adapterKey: NEWAPI_VIDEO_ADAPTER_ID,
    state: 'interactive_allowed',
    revision: 1,
    allowedOperations: ['submit', 'query', 'cancel', 'receive_result']
  });

  // The legacy definition + profile pair that the soft router used to mint for
  // every enabled model behind a connection publishing newapi.video.
  const forgedDefinition = createOpenAiCompatibleDefaultVideoDefinition({
    packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
    providerModelKey: 'gpt-image-2.5'
  });
  const forgedTemplate = forgedDefinition.profileTemplates[0]!;
  const forgedEvidence = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(`capability-${modelId}-video_generation-declared-v1`),
    modelId,
    revision: 1,
    capability: 'video_generation',
    state: 'declared_supported',
    source: 'provider_declared',
    recordedAt: now
  });
  const trustedEvidence = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(`capability-${modelId}-video_generation-user-confirmed-v1`),
    modelId,
    revision: 1,
    capability: 'video_generation',
    state: 'user_confirmed',
    source: 'user_confirmed',
    recordedAt: now
  });

  await registry.mutate((snapshot) => ({
    snapshot: {
      ...snapshot,
      providers: [
        ...snapshot.providers,
        createProvider({
          id: providerId,
          name: 'Relay',
          accessCategory: 'online',
          identityState: 'verified',
          packageId: NEWAPI_PROVIDER_PACKAGE_ID,
          packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
          createdAt: now,
          updatedAt: now
        })
      ],
      connections: [
        ...snapshot.connections,
        createProviderConnection({
          id: connectionId,
          providerId,
          name: 'Relay connection',
          endpoint: 'https://relay.invalid',
          packageId: NEWAPI_PROVIDER_PACKAGE_ID,
          packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
          templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
          templateKind: 'compatible_custom',
          credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
          credentialSchemaVersion: 1,
          credentialVersionId: 'credential-version-relay',
          connectionPolicyId: 'connection.relay.compatible',
          connectionPolicyRevision: 1,
          discoveryPolicyId: 'discovery.relay.models',
          discoveryPolicyRevision: 1,
          endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID,
          endpointPolicyRevision: 1,
          connectionConfigVersionId: 'connection-config-relay',
          connectionRevision: 1,
          adapterBindings: newApiProviderPackageDescriptor.adapters.map((adapter) => ({
            adapterId: adapter.adapterId,
            adapterVersion: adapter.adapterVersion,
            protocolId: adapter.protocolId,
            protocolVersion: adapter.protocolVersion
          })),
          state: 'available',
          identityState: 'verified',
          credentialState: 'valid',
          credentialReference: 'credential-reference-relay',
          createdAt: now,
          updatedAt: now
        })
      ],
      protocolBindings: [
        ...snapshot.protocolBindings,
        createProviderProtocolBinding({
          id: chatBindingId,
          providerId,
          connectionId,
          protocolId: NEWAPI_CHAT_PROTOCOL_ID,
          protocolVersion: NEWAPI_PROTOCOL_VERSION,
          mediaKind: 'unknown',
          adapterKind: NEWAPI_CHAT_ADAPTER_ID,
          authScheme: 'unknown',
          executionLifecycle: 'unknown',
          supportedPurposes: [],
          createdAt: now,
          updatedAt: now
        }),
        createProviderProtocolBinding({
          id: videoBindingId,
          providerId,
          connectionId,
          protocolId: NEWAPI_VIDEO_PROTOCOL_ID,
          protocolVersion: NEWAPI_PROTOCOL_VERSION,
          mediaKind: 'unknown',
          adapterKind: NEWAPI_VIDEO_ADAPTER_ID,
          authScheme: 'bearer',
          executionLifecycle: 'asynchronous_polling',
          supportedPurposes: ['video_generation'],
          createdAt: now,
          updatedAt: now
        })
      ],
      models: [
        ...snapshot.models,
        createProviderModel({
          id: modelId,
          providerId,
          connectionId,
          providerModelKey: 'gpt-image-2.5',
          displayName: 'gpt-image-2.5',
          protocolBindingId: videoBindingId,
          mediaKind: 'unknown',
          enabled: true,
          catalogState: 'present',
          revision: 1,
          createdAt: now,
          updatedAt: now
        })
      ],
      capabilities: [
        ...snapshot.capabilities,
        forgedEvidence,
        ...(input.trustedEvidence ? [trustedEvidence] : [])
      ],
      modelDefinitions: [
        ...(snapshot.modelDefinitions ?? []),
        forgedDefinition
      ],
      modelProfiles: [
        ...(snapshot.modelProfiles ?? []),
        {
          schemaVersion: 1,
          profileId: 'profile-relay-forged-video',
          revision: 1,
          packageId: NEWAPI_PROVIDER_PACKAGE_ID,
          sourceTemplateId: forgedTemplate.templateId,
          adapterKey: NEWAPI_VIDEO_ADAPTER_ID,
          modelId,
          modelRevision: 1,
          protocolBindingId: videoBindingId,
          status: 'verified',
          features: [
            {
              productFeature: 'text_to_video',
              internalPurpose: 'video_generation',
              parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
              resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
              usageSchemaId: newApiVideoUsageSchema.id,
              constraintSetId: NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
            }
          ],
          evidenceIds: [forgedEvidence.id],
          recordedAt: now
        }
      ]
    },
    result: undefined
  }));

  const contracts = new ProviderFeatureContractRegistry([
    {
      parameterSchema: newApiDefaultTextToVideoParameterSchema,
      resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiVideoUsageSchema,
      constraintSetId: NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    },
    {
      parameterSchema: newApiDefaultTextToVideoParameterSchema,
      resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
      resultSchemaRevision: 1,
      usageSchema: newApiVideoUsageSchema,
      constraintSetId: NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
      constraintSetRevision: 1,
      featureMappingVersion: 1
    }
  ]);
  const source = new RegistryFeatureCandidateSource(
    registry,
    new ProviderPackageRegistry([newApiProviderPackageDescriptor]),
    contracts,
    authorization
  );
  return {
    registry,
    service: new ProviderFeatureCandidateService(
      resolver(input.productFeature),
      source,
      new RouteSelectionTokenVault(),
      () => now
    )
  };
}

function resolver(productFeature: ProductFeature): FeatureSubjectResolverPort {
  return {
    async resolve(subject): Promise<ResolvedFeatureSubjectV1> {
      return {
        projectId: toProjectId('project-video-gate'),
        subject,
        productFeature,
        surface: productFeature === 'text_to_video' ? 'quick' : 'quick',
        imageCount: 0,
        videoCount: 0,
        contextCount: 0,
        parameterValues: {},
        outboundTextSnapshot: 'synthetic prompt',
        materialReferences: [],
        contextContentHashes: []
      };
    }
  };
}
