import { describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProjectId,
  toProviderId,
  toRoutingPreferenceId,
  type DynamicParameterValue
} from '../../src/domain';
import {
  buildImagePreflight,
  type ProviderRegistrySnapshot
} from '../../src/platform';

const now = toIsoTimestamp('2026-07-23T04:00:00.000Z');
const evidenceId = toCapabilityEvidenceId('evidence-image-generation');
const modelId = toModelId('model-image-generation');

function createDraft(
  values: Record<string, DynamicParameterValue> = { quality: 'high' }
) {
  const base = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-preflight'),
    projectId: toProjectId('project-preflight'),
    mode: 'quick_image',
    createdAt: now
  });
  return createImageWorkspaceDraft({
    ...base,
    prompt: {
      originalInput: 'Create an image',
      systemSupplements: [],
      finalPrompt: 'Create an image'
    },
    generation: {
      parameters: {
        capabilityEvidenceId: evidenceId,
        values
      }
    }
  });
}

function createRegistry(
  options: { readonly schema?: boolean; readonly verified?: boolean } = {}
): ProviderRegistrySnapshot {
  const provider = createProvider({
    id: toProviderId('provider-preflight'),
    name: 'Configured provider',
    accessCategory: 'custom_remote',
    identityState: 'verified',
    createdAt: now,
    updatedAt: now
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-preflight'),
    providerId: provider.id,
    name: 'Configured connection',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    createdAt: now,
    updatedAt: now
  });
  const model = createProviderModel({
    id: modelId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: toProtocolBindingId('protocol-image-preflight'),
    providerModelKey: 'configured-model',
    mediaKind: 'image',
    revision: 1,
    displayName: 'Configured model',
    enabled: true,
    createdAt: now,
    updatedAt: now
  });
  const evidence = createModelCapabilityEvidence({
    id: evidenceId,
    modelId: model.id,
    revision: 1,
    capability: 'image_generation',
    state: options.verified === false ? 'unknown' : 'verified_supported',
    source: 'connection_verified',
    parameterSchema: options.schema === false
      ? undefined
      : {
          schemaVersion: 1,
          fields: [
            {
              key: 'quality',
              label: 'Quality',
              kind: 'enum',
              required: true,
              options: ['standard', 'high']
            }
          ]
        },
    observedAt: now,
    recordedAt: now
  });
  const binding = createProviderProtocolBinding({
    id: model.protocolBindingId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.image',
    protocolVersion: '1',
    mediaKind: 'image',
    adapterKind: 'fixture_image',
    authScheme: 'unknown',
    executionLifecycle: 'synchronous_completed',
    supportedPurposes: ['image_generation'],
    createdAt: now,
    updatedAt: now
  });
  const route = createRoutingPreference({
    id: toRoutingPreferenceId('route-preflight'),
    purpose: 'image_generation',
    modelId: model.id,
    priority: 0,
    enabled: true,
    updatedAt: now
  });
  return {
    schemaVersion: 3,
    currentConnectionId: connection.id,
    providers: [provider],
    connections: [connection],
    protocolBindings: [binding],
    models: [model],
    capabilities: [evidence],
    routingPreferences: [route]
  };
}

describe('image submission preflight', () => {
  it('returns only verified routable candidates with schema-derived parameters', () => {
    const result = buildImagePreflight(createDraft(), createRegistry());

    expect(result.blockers).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        modelId,
        capabilityEvidenceId: evidenceId,
        recipientName: 'Configured provider / Configured connection',
        outboundScope: 'external_service',
        costState: 'unknown',
        parameterSchema: {
          schemaVersion: 1,
          fields: [expect.objectContaining({ key: 'quality' })]
        }
      })
    ]);
    expect(result.requiresSubmissionConfirmation).toBe(true);
  });

  it('blocks unknown capability, missing schema and invalid dynamic values', () => {
    expect(
      buildImagePreflight(createDraft(), createRegistry({ verified: false }))
        .blockers
    ).toContain('capability_unverified');
    expect(
      buildImagePreflight(createDraft(), createRegistry({ schema: false }))
        .blockers
    ).toContain('parameter_schema_missing');
    expect(
      buildImagePreflight(
        createDraft({ quality: 'invented' }),
        createRegistry()
      ).blockers
    ).toContain('parameters_invalid');
  });

  it('does not infer a candidate from enabled models without a route', () => {
    const registry = createRegistry();
    const result = buildImagePreflight(createDraft(), {
      ...registry,
      routingPreferences: []
    });

    expect(result.candidates).toEqual([]);
    expect(result.blockers).toContain('no_route_candidate');
  });
});
