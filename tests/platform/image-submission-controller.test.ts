import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProtocolBindingId,
  toProjectId,
  toProviderId,
  toRoutingPreferenceId,
  toTaskId
} from '../../src/domain';
import {
  ImageOperationPortError,
  ImageSubmissionController,
  ImageWorkspaceMutationCoordinator,
  JsonExecutionRepository,
  JsonImageWorkspaceRepository,
  JsonProviderOperationRepository,
  JsonProviderRegistryStore,
  JsonTaskRepository,
  NodeProjectStorage
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-23T05:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture(options: {
  readonly failingPort?: boolean;
  readonly submissionMode?: 'async' | 'sync' | 'unknown';
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-submission-'));
  roots.push(root);
  const projectId = toProjectId('project-submission');
  const storage = new NodeProjectStorage(root);
  const workspaceRepository = new JsonImageWorkspaceRepository(storage, projectId);
  const evidenceId = toCapabilityEvidenceId('evidence-submission');
  const modelId = toModelId('model-submission');
  const base = createEmptyImageWorkspaceDraft({
    id: toDraftId('draft-submission'),
    projectId,
    mode: 'quick_image',
    createdAt: t0
  });
  const draft = createImageWorkspaceDraft({
    ...base,
    state: 'saved',
    prompt: {
      originalInput: 'Create a verified image',
      systemSupplements: [],
      finalPrompt: 'Create a verified image'
    },
    generation: {
      parameters: {
        capabilityEvidenceId: evidenceId,
        values: { quality: 'high' }
      }
    }
  });
  await workspaceRepository.save(draft);

  const registry = new JsonProviderRegistryStore(path.join(root, 'providers.json'));
  const provider = createProvider({
    id: toProviderId('provider-submission'),
    name: 'Submission provider',
    accessCategory: 'online',
    identityState: 'verified',
    createdAt: t0,
    updatedAt: t0
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-submission'),
    providerId: provider.id,
    name: 'Submission connection',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    createdAt: t0,
    updatedAt: t0
  });
  const model = createProviderModel({
    id: modelId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: toProtocolBindingId('protocol-image-submission'),
    providerModelKey: 'submission-model',
    mediaKind: 'image',
    revision: 1,
    displayName: 'Submission model',
    enabled: true,
    createdAt: t0,
    updatedAt: t0
  });
  const evidence = createModelCapabilityEvidence({
    id: evidenceId,
    modelId,
    revision: 1,
    capability: 'image_generation',
    state: 'verified_supported',
    source: 'connection_verified',
    parameterSchema: {
      schemaVersion: 1,
      fields: [
        {
          key: 'quality',
          label: 'Quality',
          kind: 'enum',
          required: true,
          options: ['high']
        }
      ]
    },
    observedAt: t0,
    recordedAt: t0
  });
  const binding = createProviderProtocolBinding({
    id: model.protocolBindingId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.image.submit',
    protocolVersion: '1',
    mediaKind: 'image',
    adapterKind: 'fixture_image_submit',
    authScheme: 'unknown',
    executionLifecycle:
      options.submissionMode === 'sync'
        ? 'synchronous_completed'
        : 'asynchronous_polling',
    supportedPurposes: ['image_generation'],
    createdAt: t0,
    updatedAt: t0
  });
  await registry.save({
    schemaVersion: 2,
    providers: [provider],
    connections: [connection],
    protocolBindings: [binding],
    models: [model],
    capabilities: [evidence],
    routingPreferences: [
      createRoutingPreference({
        id: toRoutingPreferenceId('route-submission'),
        purpose: 'image_generation',
        modelId,
        priority: 0,
        enabled: true,
        updatedAt: t0
      })
    ]
  });
  const executionIds = ['execution-submission-1', 'execution-submission-2'];
  const times = [
    '2026-07-23T05:01:00.000Z',
    '2026-07-23T05:02:00.000Z',
    '2026-07-23T05:03:00.000Z',
    '2026-07-23T05:04:00.000Z',
    '2026-07-23T05:05:00.000Z'
  ];
  const controller = new ImageSubmissionController({
    getSession: () => ({
      projectId,
      projectName: 'Submission project',
      rootDirectory: root
    }),
    providerRegistry: registry,
    mutations: new ImageWorkspaceMutationCoordinator(),
    operationPorts: {
      image_generation: {
        submit: async () => {
          if (options.failingPort) {
            throw new ImageOperationPortError('retryable', 'temporary failure');
          }
          if (options.submissionMode === 'unknown') {
            throw new ImageOperationPortError(
              'not_retryable',
              'response lost after write',
              'submission_outcome_unknown'
            );
          }
          if (options.submissionMode === 'sync') {
            return {
              kind: 'completed_sync',
              providerOperationId: 'provider-sync-operation',
              results: [
                {
                  kind: 'remote_url',
                  value: 'https://synthetic.invalid/image.png'
                }
              ]
            };
          }
          return {
            remoteOperationId: 'remote-operation-internal',
            state: 'queued'
          };
        }
      }
    },
    createTaskId: () => 'task-submission',
    createExecutionId: () => executionIds.shift() ?? 'execution-fallback',
    createProviderOperationRecordId: () => 'provider-operation-record-image',
    now: () => times.shift() ?? '2026-07-23T05:59:00.000Z'
  });
  return { controller, draft, modelId, projectId, registry, root, storage };
}

const confirmations = {
  recipient: true,
  outboundScope: true,
  cost: true,
  finalPrompt: true,
  model: true
};

describe('ImageSubmissionController', () => {
  it('keeps preflight, task creation and execution creation separate', async () => {
    const fixture = await createFixture();
    const preflight = await fixture.controller.preflight({
      draftId: fixture.draft.id
    });
    expect(preflight).toMatchObject({
      ok: true,
      value: { blockers: [], candidates: [{ modelId: fixture.modelId }] }
    });

    await expect(
      fixture.controller.createTask({
        draftId: fixture.draft.id,
        draftUpdatedAt: fixture.draft.updatedAt,
        modelId: fixture.modelId,
        confirmations: { ...confirmations, cost: false }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' }
    });

    const createdTask = await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    expect(createdTask).toMatchObject({
      ok: true,
      value: { taskId: 'task-submission', modelId: fixture.modelId }
    });
    const taskRepository = new JsonTaskRepository(
      fixture.storage,
      fixture.projectId
    );
    const task = await taskRepository.get(toTaskId('task-submission'));
    expect(task?.executionIds).toEqual([]);
    expect(task?.submission.image).toMatchObject({
      recipientName: 'Submission provider / Submission connection',
      costState: 'unknown',
      confirmations
    });

    const execution = await fixture.controller.createExecution({
      taskId: 'task-submission'
    });
    expect(execution).toMatchObject({
      ok: true,
      value: { executionId: 'execution-submission-1', state: 'created' }
    });
  });

  it('does not expose internal remote IDs after adapter submission', async () => {
    const fixture = await createFixture();
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-submission' });
    const invoked = await fixture.controller.invokeExecution({
      executionId: 'execution-submission-1'
    });

    expect(invoked).toMatchObject({
      ok: true,
      value: { state: 'queued' }
    });
    expect(JSON.stringify(invoked)).not.toContain('remote-operation-internal');
    const stored = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-submission-1')
    );
    expect(stored?.remoteOperationId).toBe('remote-operation-internal');
  });

  it('records failed attempts and creates a new execution for retry', async () => {
    const fixture = await createFixture({ failingPort: true });
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-submission' });
    const failed = await fixture.controller.invokeExecution({
      executionId: 'execution-submission-1'
    });
    expect(failed).toMatchObject({
      ok: true,
      value: { state: 'failed', retryability: 'retryable' }
    });

    const retry = await fixture.controller.createExecution({
      taskId: 'task-submission'
    });
    expect(retry).toMatchObject({
      ok: true,
      value: { executionId: 'execution-submission-2', attempt: 2 }
    });
  });

  it('returns adapter unavailable without mutating a created execution', async () => {
    const fixture = await createFixture();
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-submission' });
    const controller = new ImageSubmissionController({
      getSession: () => ({
        projectId: fixture.projectId,
        projectName: 'Submission project',
        rootDirectory: fixture.root
      }),
      providerRegistry: fixture.registry,
      mutations: new ImageWorkspaceMutationCoordinator(),
      createTaskId: () => 'task-submission',
      createExecutionId: () => 'execution-submission-1',
      now: () => '2026-07-23T05:10:00.000Z'
    });
    await expect(
      controller.preflight({ draftId: fixture.draft.id })
    ).resolves.toMatchObject({
      ok: true,
      value: { blockers: ['adapter_unavailable'] }
    });
    await expect(
      controller.invokeExecution({ executionId: 'execution-submission-1' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' }
    });
    const stored = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-submission-1')
    );
    expect(stored?.state).toBe('created');
  });

  it('persists synchronous receipts and leaves result handling separate', async () => {
    const fixture = await createFixture({ submissionMode: 'sync' });
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-submission' });
    await expect(
      fixture.controller.invokeExecution({
        executionId: 'execution-submission-1'
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: 'remote_completed' }
    });
    const receipt = await new JsonProviderOperationRepository(
      fixture.storage
    ).getByExecution(toExecutionId('execution-submission-1'));
    expect(receipt).toMatchObject({
      outcome: {
        kind: 'completed_sync',
        providerOperationId: 'provider-sync-operation'
      }
    });
  });

  it('does not allow ordinary retry after an unknown paid submission outcome', async () => {
    const fixture = await createFixture({ submissionMode: 'unknown' });
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-submission' });
    await expect(
      fixture.controller.invokeExecution({
        executionId: 'execution-submission-1'
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: 'submission_outcome_unknown' }
    });
    await expect(
      fixture.controller.createExecution({ taskId: 'task-submission' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'submission_outcome_unknown' }
    });
  });
});
