import { describe, expect, it } from 'vitest';
import {
  createEmptyVideoWorkspaceDraft,
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  createVideoWorkspaceDraft,
  toAssetId,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProjectId,
  toProviderId,
  toRoutingPreferenceId,
  type VideoWorkspaceDraft
} from '../../src/domain';
import {
  buildVideoPreflight,
  type ProviderRegistrySnapshot,
  type VideoMaterialFact
} from '../../src/platform';

const now = toIsoTimestamp('2026-07-23T10:00:00.000Z');
const evidenceId = toCapabilityEvidenceId('evidence-video-generation');
const modelId = toModelId('model-video-generation');

function createRegistry(options: {
  readonly verified?: boolean;
  readonly parameterSchema?: boolean;
  readonly modeSchema?: boolean;
} = {}): ProviderRegistrySnapshot {
  const provider = createProvider({
    id: toProviderId('provider-video-preflight'),
    name: 'Configured video provider',
    accessCategory: 'custom_remote',
    identityState: 'verified',
    createdAt: now,
    updatedAt: now
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-video-preflight'),
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
    protocolBindingId: toProtocolBindingId('protocol-video-preflight'),
    providerModelKey: 'configured-video-model',
    mediaKind: 'video',
    revision: 1,
    displayName: 'Configured video model',
    enabled: true,
    createdAt: now,
    updatedAt: now
  });
  const evidence = createModelCapabilityEvidence({
    id: evidenceId,
    modelId,
    revision: 1,
    capability: 'video_generation',
    state: options.verified === false ? 'unknown' : 'verified_supported',
    source: 'connection_verified',
    parameterSchema: options.parameterSchema === false
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
    videoGenerationSchema: options.modeSchema === false
      ? undefined
      : {
          schemaVersion: 1,
          modes: [
            {
              mode: 'quick_video',
              reference: { acceptedMediaKinds: ['image', 'video'] }
            },
            {
              mode: 'text_to_video',
              materialSlots: [
                {
                  id: 'style-slot',
                  role: 'style_reference',
                  required: true,
                  acceptedMediaKinds: ['image']
                }
              ],
              shotPlan: {
                supported: true,
                required: true,
                minimumShots: 1,
                maximumShots: 3
              }
            },
            {
              mode: 'image_to_video',
              materialSlots: [
                {
                  id: 'source-slot',
                  role: 'source',
                  required: true,
                  acceptedMediaKinds: ['image']
                }
              ]
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
    protocolId: 'fixture.video',
    protocolVersion: '1',
    mediaKind: 'video',
    adapterKind: 'fixture_video',
    authScheme: 'unknown',
    executionLifecycle: 'asynchronous_polling',
    supportedPurposes: ['video_generation'],
    createdAt: now,
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
    routingPreferences: [
      createRoutingPreference({
        id: toRoutingPreferenceId('route-video-preflight'),
        purpose: 'video_generation',
        modelId,
        priority: 0,
        enabled: true,
        updatedAt: now
      })
    ]
  };
}

function quickDraft(values: Record<string, string> = { quality: 'high' }) {
  const base = createEmptyVideoWorkspaceDraft({
    id: toDraftId('draft-video-preflight'),
    projectId: toProjectId('project-video-preflight'),
    mode: 'quick_video',
    createdAt: now
  });
  return createVideoWorkspaceDraft({
    ...base,
    prompt: {
      originalInput: 'Create a video',
      systemSupplements: [],
      finalPrompt: 'Create a video'
    },
    generation: {
      ...base.generation,
      model: { modelId, capabilityEvidenceId: evidenceId },
      parameters: { capabilityEvidenceId: evidenceId, values }
    }
  });
}

function textDraft(): VideoWorkspaceDraft {
  const base = createEmptyVideoWorkspaceDraft({
    id: toDraftId('draft-text-video-preflight'),
    projectId: toProjectId('project-video-preflight'),
    mode: 'text_to_video',
    createdAt: now
  });
  if (base.mode !== 'text_to_video') throw new Error('unexpected mode');
  return createVideoWorkspaceDraft({
    ...base,
    prompt: {
      originalInput: 'Create a sequence',
      systemSupplements: [],
      finalPrompt: 'Create a sequence'
    },
    generation: {
      ...base.generation,
      model: { modelId, capabilityEvidenceId: evidenceId },
      parameters: {
        capabilityEvidenceId: evidenceId,
        values: { quality: 'high' }
      }
    },
    textToVideo: {
      ...base.textToVideo,
      materials: {
        capabilityEvidenceId: evidenceId,
        slots: [
          {
            id: 'style-slot',
            role: 'style_reference',
            required: true,
            acceptedMediaKinds: ['image'],
            selection: {
              assetId: toAssetId('asset-style'),
              mediaKind: 'image',
              role: 'style_reference',
              selectedAt: now
            }
          }
        ]
      },
      shots: [{ id: 'shot-1', order: 1, description: 'Opening shot' }]
    }
  });
}

const materialFacts: readonly VideoMaterialFact[] = [
  {
    assetId: toAssetId('asset-style'),
    mediaKind: 'image',
    role: 'style_reference',
    fileState: 'available',
    metadataAvailable: true
  }
];

describe('video submission preflight', () => {
  it('returns verified candidates with dynamic parameters and mode schema', () => {
    const result = buildVideoPreflight(quickDraft(), createRegistry(), []);
    expect(result.blockers).toEqual([]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        modelId,
        capabilityEvidenceId: evidenceId,
        outboundScope: 'external_service',
        modeSchema: expect.objectContaining({ mode: 'quick_video' }),
        blockers: []
      })
    ]);
  });

  it('blocks unknown capability, missing schemas and invalid parameters', () => {
    expect(
      buildVideoPreflight(quickDraft(), createRegistry({ verified: false }), [])
        .blockers
    ).toContain('capability_unverified');
    expect(
      buildVideoPreflight(
        quickDraft(),
        createRegistry({ parameterSchema: false }),
        []
      ).blockers
    ).toContain('parameter_schema_missing');
    expect(
      buildVideoPreflight(
        quickDraft(),
        createRegistry({ modeSchema: false }),
        []
      ).blockers
    ).toContain('mode_schema_missing');
    expect(
      buildVideoPreflight(
        quickDraft({ quality: 'invented' }),
        createRegistry(),
        []
      ).candidates[0]?.blockers
    ).toContain('parameters_invalid');
  });

  it('validates dynamic slots, real local material facts and shot limits', () => {
    expect(
      buildVideoPreflight(textDraft(), createRegistry(), materialFacts)
        .candidates[0]?.blockers
    ).toEqual([]);
    expect(
      buildVideoPreflight(textDraft(), createRegistry(), [])
        .candidates[0]?.blockers
    ).toContain('material_invalid');

    const draft = textDraft();
    if (draft.mode !== 'text_to_video') throw new Error('unexpected mode');
    const noShots = createVideoWorkspaceDraft({
      ...draft,
      textToVideo: { ...draft.textToVideo, shots: [] }
    });
    expect(
      buildVideoPreflight(noShots, createRegistry(), materialFacts)
        .candidates[0]?.blockers
    ).toContain('shot_plan_invalid');
  });

  it('does not infer a candidate from enabled models without a route', () => {
    const registry = createRegistry();
    const result = buildVideoPreflight(quickDraft(), {
      ...registry,
      routingPreferences: []
    }, []);
    expect(result.candidates).toEqual([]);
    expect(result.blockers).toContain('no_route_candidate');
  });
});
