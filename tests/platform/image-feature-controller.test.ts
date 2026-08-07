import { describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  createUsageSchema,
  toDraftId,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  toUsageSchemaId,
  type FeatureCandidateSubjectV1,
  type ImageWorkspaceDraft,
  type ImageWorkspaceRepository,
  type ParameterSchemaV2,
  type SubmissionUserConfirmationV1
} from '../../src/domain';
import {
  ImageFeatureController,
  ImageWorkspaceMutationCoordinator,
  ProviderFeatureCandidateService,
  RouteSelectionTokenVault,
  type ResolvedFeatureCandidateV1
} from '../../src/platform';
import type { ImageFeatureSubmissionDto } from '../../src/shared/image-feature-ipc';

const projectId = toProjectId('project-image-feature-controller');
const createdAt = toIsoTimestamp('2026-08-03T12:00:00.000Z');

describe('ImageFeatureController', () => {
  it('lists candidates and prepares only the exact saved draft revision', async () => {
    const fixture = createFixture();
    const listed = await fixture.controller.listCandidates({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt
    });
    expect(listed).toMatchObject({
      ok: true,
      value: [{
        providerName: 'Fixture provider',
        connectionName: 'Fixture connection',
        modelName: 'Fixture model',
        available: true
      }]
    });

    await expect(fixture.controller.listCandidates({
      draftId: fixture.draft.id,
      draftUpdatedAt: '2026-08-03T11:59:00.000Z'
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'draft_revision_changed' }
    });

    await expect(fixture.controller.prepareSubmission({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      candidateId: 'candidate-image-controller'
    })).resolves.toMatchObject({
      ok: true,
      value: {
        routeSelectionToken: expect.stringMatching(/^rst1_/),
        confirmation: {
          productFeature: 'text_to_image',
          providerName: 'Fixture provider'
        }
      }
    });
  });

  it('rejects missing confirmation, tampered tokens and disabled runtime without submitting', async () => {
    const fixture = createFixture();
    const prepared = await fixture.controller.prepareSubmission({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      candidateId: 'candidate-image-controller'
    });
    if (!prepared.ok) throw new Error(prepared.error.message);

    await expect(fixture.controller.submitDraft({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: false
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' }
    });

    await expect(fixture.controller.submitDraft({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      routeSelectionToken: `${prepared.value.routeSelectionToken}tampered`,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'route_selection_invalid' }
    });

    await expect(fixture.controller.submitDraft({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_not_allowed' }
    });
  });

  it('invalidates a prepared selection after the draft revision changes', async () => {
    const fixture = createFixture();
    const prepared = await fixture.controller.prepareSubmission({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      candidateId: 'candidate-image-controller'
    });
    if (!prepared.ok) throw new Error(prepared.error.message);

    fixture.setDraft(createImageWorkspaceDraft({
      ...fixture.draft,
      updatedAt: toIsoTimestamp('2026-08-03T12:01:00.000Z')
    }));
    await expect(fixture.controller.submitDraft({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_route_selection' }
    });
  });

  it('prepare → confirm → submit returns completed when runtime submit is wired', async () => {
    const fixture = createFixture({
      async submit() {
        return {
          schemaVersion: 1 as const,
          submissionIntentId: 'intent-fixture-image',
          status: 'completed' as const,
          retryAllowed: false as const,
          resultImageUrls: ['https://example.test/generated.png'],
          workId: 'work-fixture-image'
        };
      }
    });
    const prepared = await fixture.controller.prepareSubmission({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      candidateId: 'candidate-image-controller'
    });
    if (!prepared.ok) throw new Error(prepared.error.message);

    // Simulate autosave bumping updatedAt after prepare (UI race that previously cleared prep).
    const bumped = createImageWorkspaceDraft({
      ...fixture.draft,
      updatedAt: toIsoTimestamp('2026-08-03T12:00:30.000Z')
    });
    fixture.setDraft(bumped);

    await expect(fixture.controller.submitDraft({
      draftId: bumped.id,
      draftUpdatedAt: bumped.updatedAt,
      routeSelectionToken: prepared.value.routeSelectionToken,
      confirmationId: prepared.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_route_selection' }
    });

    const preparedAgain = await fixture.controller.prepareSubmission({
      draftId: bumped.id,
      draftUpdatedAt: bumped.updatedAt,
      candidateId: 'candidate-image-controller'
    });
    if (!preparedAgain.ok) throw new Error(preparedAgain.error.message);

    await expect(fixture.controller.submitDraft({
      draftId: bumped.id,
      draftUpdatedAt: bumped.updatedAt,
      routeSelectionToken: preparedAgain.value.routeSelectionToken,
      confirmationId: preparedAgain.value.confirmation.confirmationId,
      confirmed: true
    })).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'completed',
        resultImageUrls: ['https://example.test/generated.png'],
        workId: 'work-fixture-image'
      }
    });
  });
});

function createFixture(options?: {
  submit?: (input: {
    readonly subject: FeatureCandidateSubjectV1;
    readonly routeSelectionToken: string;
    readonly confirmation: SubmissionUserConfirmationV1;
  }) => Promise<ImageFeatureSubmissionDto>;
}) {
  let draft: ImageWorkspaceDraft = createImageWorkspaceDraft({
    ...createEmptyImageWorkspaceDraft({
      id: toDraftId('draft-image-feature-controller'),
      projectId,
      mode: 'quick_image',
      createdAt
    }),
    state: 'saved',
    prompt: {
      originalInput: 'A safe text-only image prompt',
      systemSupplements: [],
      finalPrompt: 'A safe text-only image prompt'
    }
  });
  const drafts: ImageWorkspaceRepository = {
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
          productFeature: 'text_to_image',
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
  const controller = new ImageFeatureController({
    getSession: () => ({
      projectId,
      projectName: 'Image feature fixture',
      rootDirectory: 'C:\\fixture\\image-feature'
    }),
    getRuntime: () => ({
      drafts,
      candidates,
      ...(options?.submit ? { submit: options.submit } : {})
    }),
    mutations: new ImageWorkspaceMutationCoordinator()
  });
  return {
    controller,
    get draft() { return draft; },
    setDraft(value: ImageWorkspaceDraft) { draft = value; }
  };
}

const parameterSchema: ParameterSchemaV2 = {
  schemaVersion: 2,
  schemaId: 'parameters.fixture.text-to-image',
  revision: 1,
  productFeature: 'text_to_image',
  fields: []
};

const usageSchema = createUsageSchema({
  id: toUsageSchemaId('usage.fixture.image'),
  revision: 1,
  completenessRule: 'provider_status_only',
  conflictPolicy: 'mark_invalid_response',
  metrics: []
});

function candidate(): ResolvedFeatureCandidateV1 {
  return {
    candidateId: 'candidate-image-controller',
    providerName: 'Fixture provider',
    connectionName: 'Fixture connection',
    modelName: 'Fixture model',
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
      packageId: 'package.fixture.image',
      packageVersion: '1.0.0',
      adapterKey: 'adapter.fixture.image',
      adapterVersion: '1.0.0',
      providerId: toProviderId('provider-fixture-image'),
      connectionId: toConnectionId('connection-fixture-image'),
      connectionRevision: 1,
      connectionConfigVersionId: 'connection-config-fixture-image',
      endpointPolicyId: 'endpoint-policy-fixture-image',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-version-fixture-image',
      modelId: toModelId('model-fixture-image'),
      providerModelKey: 'fixture-image-model',
      modelRevision: 1,
      profileId: 'profile-fixture-image',
      profileRevision: 1,
      protocolBindingId: toProtocolBindingId('protocol-binding-fixture-image'),
      protocolBindingRevision: 1,
      productFeature: 'text_to_image',
      featureMappingVersion: 1,
      parameterSchemaId: parameterSchema.schemaId,
      parameterSchemaRevision: parameterSchema.revision,
      resultSchemaId: 'result.fixture.image',
      resultSchemaRevision: 1,
      usageSchemaId: usageSchema.id,
      usageSchemaRevision: usageSchema.revision,
      constraintSetId: 'constraints.fixture.image',
      constraintSetRevision: 1,
      runtimePolicyId: 'runtime-policy-fixture-image',
      runtimePolicyRevision: 1
    }
  };
}
