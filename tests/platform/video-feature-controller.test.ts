import { describe, expect, it } from 'vitest';
import {
  createEmptyVideoWorkspaceDraft,
  createUsageSchema,
  createVideoWorkspaceDraft,
  toConnectionId,
  toDraftId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  toUsageSchemaId,
  type ParameterSchemaV2,
  type VideoWorkspaceDraft,
  type VideoWorkspaceRepository
} from '../../src/domain';
import {
  ProviderFeatureCandidateService,
  RouteSelectionTokenVault,
  VideoFeatureController,
  VideoWorkspaceMutationCoordinator,
  type ResolvedFeatureCandidateV1
} from '../../src/platform';

const projectId = toProjectId('project-video-feature-controller');
const createdAt = toIsoTimestamp('2026-08-03T12:00:00.000Z');

describe('VideoFeatureController', () => {
  it('binds candidates and preparation to the exact saved draft revision', async () => {
    const fixture = createFixture();
    await expect(fixture.controller.listCandidates(request(fixture.draft))).resolves.toMatchObject({
      ok: true,
      value: [{ available: true, modelName: 'Fixture video model' }]
    });
    await expect(fixture.controller.listCandidates({
      draftId: fixture.draft.id,
      draftUpdatedAt: '2026-08-03T11:59:00.000Z'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'draft_revision_changed' }
    });
    await expect(fixture.controller.prepareSubmission({
      ...request(fixture.draft),
      candidateId: 'candidate-video-controller'
    })).resolves.toMatchObject({
      ok: true,
      value: {
        routeSelectionToken: expect.stringMatching(/^rst1_/),
        confirmation: { productFeature: 'text_to_video' }
      }
    });
  });

  it('requires confirmation and leaves an unapproved runtime at zero submissions', async () => {
    const fixture = createFixture();
    const prepared = await fixture.controller.prepareSubmission({
      ...request(fixture.draft),
      candidateId: 'candidate-video-controller'
    });
    if (!prepared.ok) throw new Error(prepared.error.message);

    await expect(fixture.controller.submitDraft({
      ...request(fixture.draft),
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: false
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' }
    });
    await expect(fixture.controller.submitDraft({
      ...request(fixture.draft),
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_not_allowed' }
    });
    expect(fixture.submissionCount()).toBe(0);
  });

  it('rejects a prepared token after the persisted revision changes', async () => {
    const fixture = createFixture();
    const prepared = await fixture.controller.prepareSubmission({
      ...request(fixture.draft),
      candidateId: 'candidate-video-controller'
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    fixture.setDraft(createVideoWorkspaceDraft({
      ...fixture.draft,
      updatedAt: toIsoTimestamp('2026-08-03T12:01:00.000Z')
    }));
    await expect(fixture.controller.submitDraft({
      ...request(fixture.draft),
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_route_selection' }
    });
  });
});

function createFixture() {
  let draft: VideoWorkspaceDraft = createVideoWorkspaceDraft({
    ...createEmptyVideoWorkspaceDraft({
      id: toDraftId('draft-video-feature-controller'),
      projectId,
      mode: 'quick_video',
      createdAt
    }),
    state: 'saved',
    prompt: {
      originalInput: 'A safe text-only video prompt',
      systemSupplements: [],
      finalPrompt: 'A safe text-only video prompt'
    }
  });
  let submissions = 0;
  const drafts: VideoWorkspaceRepository = {
    async get(id) { return id === draft.id ? structuredClone(draft) : undefined; },
    async list() { return [structuredClone(draft)]; },
    async save(value) { draft = structuredClone(value); }
  };
  const candidates = new ProviderFeatureCandidateService(
    {
      async resolve(subject) {
        return {
          projectId,
          subject,
          productFeature: 'text_to_video',
          surface: 'quick',
          imageCount: 0,
          videoCount: 0,
          contextCount: 0,
          parameterValues: {},
          outboundTextSnapshot: draft.prompt.finalPrompt,
          materialReferences: [],
          contextContentHashes: []
        };
      }
    },
    { async list() { return [candidate()]; } },
    new RouteSelectionTokenVault(),
    () => '2026-08-03T12:00:10.000Z'
  );
  const controller = new VideoFeatureController({
    getSession: () => ({
      projectId,
      projectName: 'Video feature fixture',
      rootDirectory: 'C:\\fixture\\video-feature'
    }),
    getRuntime: () => ({
      drafts,
      candidates,
      ...(submissions > 0
        ? { async submit() {
            submissions += 1;
            throw new Error('not expected');
          } }
        : {})
    }),
    mutations: new VideoWorkspaceMutationCoordinator()
  });
  return {
    controller,
    get draft() { return draft; },
    setDraft(value: VideoWorkspaceDraft) { draft = value; },
    submissionCount: () => submissions
  };
}

function request(draft: VideoWorkspaceDraft) {
  return { draftId: draft.id, draftUpdatedAt: draft.updatedAt };
}

const parameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: 'parameters.fixture.text-to-video',
  revision: 1,
  productFeature: 'text_to_video',
  fields: []
};

const usageSchema = createUsageSchema({
  id: toUsageSchemaId('usage.fixture.video'),
  revision: 1,
  completenessRule: 'provider_status_only',
  conflictPolicy: 'mark_invalid_response',
  metrics: []
});

function candidate(): ResolvedFeatureCandidateV1 {
  return {
    candidateId: 'candidate-video-controller',
    providerName: 'Fixture provider',
    connectionName: 'Fixture connection',
    modelName: 'Fixture video model',
    recipientName: 'Fixture provider / Fixture connection',
    outboundScope: 'external_service',
    contentCategories: ['prompt_text'],
    parameterSchema,
    usageSchema: { schemaId: usageSchema.id, revision: usageSchema.revision },
    cost: { state: 'unknown' },
    eligibility: {
      modelEnabled: true,
      catalogState: 'present',
      connectionState: 'available',
      profileStatus: 'verified',
      featureSupported: true,
      bindingAvailable: true,
      runtimeAllowed: true,
      schemasInterpretable: true
    },
    routeTemplate: {
      packageId: 'package.fixture.video',
      packageVersion: '1.0.0',
      adapterKey: 'adapter.fixture.video',
      adapterVersion: '1.0.0',
      providerId: toProviderId('provider-fixture-video'),
      connectionId: toConnectionId('connection-fixture-video'),
      connectionRevision: 1,
      connectionConfigVersionId: 'connection-config-fixture-video',
      endpointPolicyId: 'endpoint-policy-fixture-video',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-version-fixture-video',
      modelId: toModelId('model-fixture-video'),
      providerModelKey: 'fixture-video-model',
      modelRevision: 1,
      profileId: 'profile-fixture-video',
      profileRevision: 1,
      protocolBindingId: toProtocolBindingId('protocol-binding-fixture-video'),
      protocolBindingRevision: 1,
      productFeature: 'text_to_video',
      featureMappingVersion: 1,
      parameterSchemaId: parameterSchema.schemaId,
      parameterSchemaRevision: parameterSchema.revision,
      resultSchemaId: 'result.fixture.video',
      resultSchemaRevision: 1,
      usageSchemaId: usageSchema.id,
      usageSchemaRevision: usageSchema.revision,
      constraintSetId: 'constraints.fixture.video',
      constraintSetRevision: 1,
      runtimePolicyId: 'runtime-policy-fixture-video',
      runtimePolicyRevision: 1
    }
  };
}
