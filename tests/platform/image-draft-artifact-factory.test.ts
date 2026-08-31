import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  createImageWorkspaceDraft,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  toProviderInvocationAttemptId,
  toTaskId,
  toUsageSchemaId
} from '../../src/domain';
import {
  ImageDraftArtifactFactory,
  JsonExecutionRepository,
  JsonImageWorkspaceRepository,
  JsonTaskRepository,
  NodeProjectStorage,
  type JsonProviderRegistryStore,
  type ResolvedFeatureCandidateV1
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-image-artifacts');
const t0 = toIsoTimestamp('2026-08-06T01:00:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ImageDraftArtifactFactory', () => {
  it('creates task/execution and includes identities in dispatch request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-image-artifacts-'));
    roots.push(root);
    const storage = new NodeProjectStorage(root);
    const drafts = new JsonImageWorkspaceRepository(storage, projectId);
    const tasks = new JsonTaskRepository(storage, projectId);
    const executions = new JsonExecutionRepository(storage);
    const registry = {
      async load() {
        return {
          providers: [{
            id: toProviderId('provider-vidu'),
            accessCategory: 'online'
          }],
          models: [{
            id: toModelId('model-vidu'),
            capabilityEvidenceId: toCapabilityEvidenceId('evidence-vidu-image-generation')
          }],
          capabilities: [
            {
              id: toCapabilityEvidenceId('evidence-vidu-image-generation'),
              modelId: toModelId('model-vidu'),
              capability: 'image_generation'
            },
            {
              id: toCapabilityEvidenceId('evidence-vidu-reference-to-image'),
              modelId: toModelId('model-vidu'),
              capability: 'reference_to_image'
            }
          ]
        };
      }
    } as unknown as JsonProviderRegistryStore;

    const draft = createImageWorkspaceDraft({
      ...createEmptyImageWorkspaceDraft({
        id: toDraftId('draft-quick'),
        projectId,
        mode: 'quick_image',
        createdAt: t0
      }),
      state: 'saved',
      prompt: {
        originalInput: '雪山露营海报',
        systemSupplements: [],
        finalPrompt: '雪山露营海报'
      },
      updatedAt: t0
    });
    await drafts.save(draft);

    const factory = new ImageDraftArtifactFactory({
      drafts,
      tasks,
      executions,
      providerRegistry: registry,
      nextTaskId: () => toTaskId('task-image-1'),
      nextExecutionId: () => toExecutionId('execution-image-1')
    });

    const built = await factory.create({
      subject: {
        projectId,
        subject: {
          kind: 'draft',
          draftId: draft.id,
          draftRevision: Date.parse(draft.updatedAt)
        },
        productFeature: 'text_to_image',
        surface: 'quick',
        imageCount: 0,
        videoCount: 0,
        contextCount: 0,
        parameterValues: {},
        outboundTextSnapshot: '雪山露营海报',
        materialReferences: [],
        contextContentHashes: []
      },
      candidate: candidate(),
      routeSnapshotId: 'route-1' as never,
      invocationAttemptId: toProviderInvocationAttemptId('attempt-1'),
      authorizationClaimId: 'claim-1',
      createdAt: t0
    });

    expect(built.subjectArtifacts).toMatchObject({
      kind: 'media',
      task: {
        id: 'task-image-1',
        sourceDraftId: draft.id,
        submission: {
          image: {
            purpose: 'image_generation',
            capabilityEvidenceId: 'evidence-vidu-image-generation'
          }
        }
      },
      execution: { id: 'execution-image-1', taskId: 'task-image-1' }
    });
    expect(built.dispatchRequest).toMatchObject({
      invocationAttemptId: 'attempt-1',
      projectId,
      prompt: '雪山露营海报',
      taskId: 'task-image-1',
      executionId: 'execution-image-1'
    });
    await expect(tasks.get(toTaskId('task-image-1'))).resolves.toBeTruthy();
    await expect(executions.get(toExecutionId('execution-image-1'))).resolves.toBeTruthy();
  });
});

function candidate(): ResolvedFeatureCandidateV1 {
  return {
    candidateId: 'candidate-image',
    providerName: 'Vidu',
    connectionName: '官方',
    modelName: 'Vidu Image',
    recipientName: 'Vidu / 官方',
    outboundScope: 'external_service',
    contentCategories: ['image_prompt'],
    parameterSchema: {
      schemaVersion: 2,
      schemaId: 'parameter-schema.vidu.text-to-image',
      revision: 1,
      productFeature: 'text_to_image',
      fields: []
    },
    usageSchema: { schemaId: toUsageSchemaId('usage.vidu.not-reported'), revision: 1 },
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
      packageId: 'provider-package-vidu-v1',
      packageVersion: '1.0.0',
      adapterKey: 'vidu_image_v1',
      adapterVersion: '2026-08-03',
      providerId: toProviderId('provider-vidu'),
      connectionId: toConnectionId('connection-vidu'),
      connectionRevision: 1,
      connectionConfigVersionId: 'config-1',
      endpointPolicyId: 'endpoint.vidu.official',
      endpointPolicyRevision: 1,
      credentialVersionId: 'credential-1',
      modelId: toModelId('model-vidu'),
      providerModelKey: 'viduimage-2',
      modelRevision: 1,
      profileId: 'profile-vidu',
      profileRevision: 1,
      protocolBindingId: toProtocolBindingId('binding-vidu'),
      protocolBindingRevision: 1,
      productFeature: 'text_to_image',
      internalPurpose: 'image_generation',
      featureMappingVersion: 1,
      parameterSchemaId: 'parameter-schema.vidu.text-to-image',
      parameterSchemaRevision: 1,
      resultSchemaId: 'results.vidu.image-v1',
      resultSchemaRevision: 1,
      usageSchemaId: toUsageSchemaId('usage.vidu.not-reported'),
      usageSchemaRevision: 1,
      constraintSetId: 'constraints.vidu.text-only-single-output',
      constraintSetRevision: 1,
      runtimePolicyId: 'policy.connection.connection-vidu',
      runtimePolicyRevision: 1
    }
  };
}
