import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyVideoWorkspaceDraft,
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  createVideoWorkspaceDraft,
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
  JsonExecutionRepository,
  JsonProviderRegistryStore,
  JsonTaskRepository,
  JsonVideoWorkspaceRepository,
  NodeProjectStorage,
  VideoOperationPortError,
  VideoSubmissionController,
  VideoWorkspaceMutationCoordinator
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-07-23T11:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createFixture(options: {
  readonly failingPort?: boolean;
  readonly unknownOutcome?: boolean;
  readonly queryResult?: {
    readonly state: 'queued' | 'processing' | 'completed' | 'cancelled' | 'expired';
  };
  readonly cancelResult?: {
    readonly state: 'cancelled' | 'processing' | 'unknown';
  };
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-submit-'));
  roots.push(root);
  const projectId = toProjectId('project-video-submission');
  const storage = new NodeProjectStorage(root);
  const workspaceRepository = new JsonVideoWorkspaceRepository(
    storage,
    projectId
  );
  const evidenceId = toCapabilityEvidenceId('evidence-video-submission');
  const modelId = toModelId('model-video-submission');
  const base = createEmptyVideoWorkspaceDraft({
    id: toDraftId('draft-video-submission'),
    projectId,
    mode: 'quick_video',
    createdAt: t0
  });
  const draft = createVideoWorkspaceDraft({
    ...base,
    state: 'saved',
    prompt: {
      originalInput: 'Create a verified video',
      systemSupplements: [],
      finalPrompt: 'Create a verified video'
    },
    generation: {
      ...base.generation,
      model: { modelId, capabilityEvidenceId: evidenceId },
      parameters: {
        capabilityEvidenceId: evidenceId,
        values: { quality: 'high' }
      }
    }
  });
  await workspaceRepository.save(draft);

  const registry = new JsonProviderRegistryStore(path.join(root, 'providers.json'));
  const provider = createProvider({
    id: toProviderId('provider-video-submission'),
    name: 'Video submission provider',
    accessCategory: 'online',
    identityState: 'verified',
    createdAt: t0,
    updatedAt: t0
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-video-submission'),
    providerId: provider.id,
    name: 'Video submission connection',
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
    protocolBindingId: toProtocolBindingId('protocol-video-submission'),
    providerModelKey: 'video-submission-model',
    mediaKind: 'video',
    revision: 1,
    displayName: 'Video submission model',
    enabled: true,
    createdAt: t0,
    updatedAt: t0
  });
  const evidence = createModelCapabilityEvidence({
    id: evidenceId,
    modelId,
    revision: 1,
    capability: 'video_generation',
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
    videoGenerationSchema: {
      schemaVersion: 1,
      modes: [{ mode: 'quick_video' }]
    },
    observedAt: t0,
    recordedAt: t0
  });
  const binding = createProviderProtocolBinding({
    id: model.protocolBindingId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.video.submit',
    protocolVersion: '1',
    mediaKind: 'video',
    adapterKind: 'fixture_video_submit',
    authScheme: 'unknown',
    executionLifecycle: 'asynchronous_polling',
    supportedPurposes: ['video_generation'],
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
        id: toRoutingPreferenceId('route-video-submission'),
        purpose: 'video_generation',
        modelId,
        priority: 0,
        enabled: true,
        updatedAt: t0
      })
    ]
  });

  const executionIds = [
    'execution-video-submission-1',
    'execution-video-submission-2'
  ];
  const times = [
    '2026-07-23T11:01:00.000Z',
    '2026-07-23T11:02:00.000Z',
    '2026-07-23T11:03:00.000Z',
    '2026-07-23T11:04:00.000Z',
    '2026-07-23T11:05:00.000Z'
  ];
  const queriedOperationIds: string[] = [];
  const cancelledOperationIds: string[] = [];
  const controller = new VideoSubmissionController({
    getSession: () => ({
      projectId,
      projectName: 'Video submission project',
      rootDirectory: root
    }),
    providerRegistry: registry,
    mutations: new VideoWorkspaceMutationCoordinator(),
    operationPort: {
      submit: async ({ task }) => {
        expect(task.submission.video?.input).toEqual({ mode: 'quick_video' });
        if (options.failingPort) {
          throw new VideoOperationPortError('retryable', 'temporary failure');
        }
        if (options.unknownOutcome) {
          throw new VideoOperationPortError(
            'not_retryable',
            'response lost after write',
            'submission_outcome_unknown'
          );
        }
        return {
          remoteOperationId: 'remote-video-operation-internal',
          state: 'queued'
        };
      }
    },
    asyncOperationPort: {
      query: async (providerOperationId) => {
        queriedOperationIds.push(providerOperationId);
        return options.queryResult ?? { state: 'processing' };
      },
      cancel: async (providerOperationId) => {
        cancelledOperationIds.push(providerOperationId);
        return options.cancelResult ?? { state: 'cancelled' };
      }
    },
    createTaskId: () => 'task-video-submission',
    createExecutionId: () =>
      executionIds.shift() ?? 'execution-video-fallback',
    createProviderOperationRecordId: () => 'provider-operation-record-video',
    now: () => times.shift() ?? '2026-07-23T11:59:00.000Z'
  });
  return {
    controller,
    draft,
    modelId,
    projectId,
    registry,
    root,
    storage,
    queriedOperationIds,
    cancelledOperationIds
  };
}

const confirmations = {
  recipient: true,
  outboundScope: true,
  materials: true,
  costPrivacyRegion: true,
  finalPrompt: true,
  model: true
};

describe('VideoSubmissionController', () => {
  it('keeps preflight, task creation and execution creation separate', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.controller.preflight({ draftId: fixture.draft.id })
    ).resolves.toMatchObject({
      ok: true,
      value: { blockers: [], candidates: [{ modelId: fixture.modelId }] }
    });
    await expect(
      fixture.controller.createTask({
        draftId: fixture.draft.id,
        draftUpdatedAt: fixture.draft.updatedAt,
        modelId: fixture.modelId,
        confirmations: { ...confirmations, materials: false }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' }
    });

    const created = await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    expect(created).toMatchObject({
      ok: true,
      value: { taskId: 'task-video-submission', modelId: fixture.modelId }
    });
    const taskRepository = new JsonTaskRepository(
      fixture.storage,
      fixture.projectId
    );
    const task = await taskRepository.get(toTaskId('task-video-submission'));
    expect(task?.executionIds).toEqual([]);
    expect(task?.submission.video).toMatchObject({
      recipientName: 'Video submission provider / Video submission connection',
      costState: 'unknown',
      materials: [],
      confirmations
    });

    await expect(
      fixture.controller.createExecution({ taskId: 'task-video-submission' })
    ).resolves.toMatchObject({
      ok: true,
      value: { executionId: 'execution-video-submission-1', state: 'created' }
    });
  });

  it('stores remote operation IDs only in the main-process execution entity', async () => {
    const fixture = await createFixture();
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-video-submission' });
    const invoked = await fixture.controller.invokeExecution({
      executionId: 'execution-video-submission-1'
    });
    expect(invoked).toMatchObject({ ok: true, value: { state: 'queued' } });
    expect(JSON.stringify(invoked)).not.toContain('remote-video-operation-internal');
    const stored = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-submission-1')
    );
    expect(stored?.remoteOperationId).toBe('remote-video-operation-internal');
  });

  it('records retryable adapter failures and creates a new execution attempt', async () => {
    const fixture = await createFixture({ failingPort: true });
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-video-submission' });
    await expect(
      fixture.controller.invokeExecution({
        executionId: 'execution-video-submission-1'
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: 'failed', retryability: 'retryable' }
    });
    await expect(
      fixture.controller.createExecution({ taskId: 'task-video-submission' })
    ).resolves.toMatchObject({
      ok: true,
      value: { executionId: 'execution-video-submission-2', attempt: 2 }
    });
  });

  it('does not allow ordinary retry after an unknown paid submission outcome', async () => {
    const fixture = await createFixture({ unknownOutcome: true });
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({
      taskId: 'task-video-submission'
    });
    await expect(
      fixture.controller.invokeExecution({
        executionId: 'execution-video-submission-1'
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: 'submission_outcome_unknown' }
    });
    await expect(
      fixture.controller.createExecution({ taskId: 'task-video-submission' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'submission_outcome_unknown' }
    });
    const stored = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-submission-1')
    );
    expect(stored).toMatchObject({
      state: 'submission_outcome_unknown',
      submissionOutcome: 'submission_outcome_unknown'
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
    await fixture.controller.createExecution({ taskId: 'task-video-submission' });
    const controller = new VideoSubmissionController({
      getSession: () => ({
        projectId: fixture.projectId,
        projectName: 'Video submission project',
        rootDirectory: fixture.root
      }),
      providerRegistry: fixture.registry,
      mutations: new VideoWorkspaceMutationCoordinator()
    });
    await expect(
      controller.preflight({ draftId: fixture.draft.id })
    ).resolves.toMatchObject({
      ok: true,
      value: { blockers: ['adapter_unavailable'] }
    });
    await expect(
      controller.invokeExecution({ executionId: 'execution-video-submission-1' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' }
    });
    const stored = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-submission-1')
    );
    expect(stored?.state).toBe('created');
  });

  it('returns adapter unavailable for result receipt without inventing works', async () => {
    const fixture = await createFixture();
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-video-submission' });
    await fixture.controller.invokeExecution({
      executionId: 'execution-video-submission-1'
    });

    await expect(
      fixture.controller.receiveResult({
        executionId: 'execution-video-submission-1'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter_unavailable' }
    });
    const stored = await new JsonExecutionRepository(fixture.storage).get(
      toExecutionId('execution-video-submission-1')
    );
    expect(stored?.state).toBe('queued');
  });

  it('refreshes and cancels only through the stored provider operation', async () => {
    const fixture = await createFixture();
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-video-submission' });
    await fixture.controller.invokeExecution({
      executionId: 'execution-video-submission-1'
    });

    const refreshed = await fixture.controller.refreshExecution({
      executionId: 'execution-video-submission-1'
    });
    expect(refreshed).toMatchObject({ ok: true, value: { state: 'processing' } });
    expect(JSON.stringify(refreshed)).not.toContain('remote-video-operation-internal');

    const cancelled = await fixture.controller.cancelExecution({
      executionId: 'execution-video-submission-1'
    });
    expect(cancelled).toMatchObject({ ok: true, value: { state: 'cancelled' } });
    expect(fixture.queriedOperationIds).toEqual([
      'remote-video-operation-internal'
    ]);
    expect(fixture.cancelledOperationIds).toEqual([
      'remote-video-operation-internal'
    ]);
  });

  it('recovers only executions belonging to the requested draft and rejects extra fields', async () => {
    const fixture = await createFixture();
    await fixture.controller.createTask({
      draftId: fixture.draft.id,
      draftUpdatedAt: fixture.draft.updatedAt,
      modelId: fixture.modelId,
      confirmations
    });
    await fixture.controller.createExecution({ taskId: 'task-video-submission' });
    await fixture.controller.invokeExecution({
      executionId: 'execution-video-submission-1'
    });

    await expect(
      fixture.controller.recoverExecutions({ draftId: 'draft-other' })
    ).resolves.toEqual({ ok: true, value: [] });
    await expect(
      fixture.controller.recoverExecutions({ draftId: fixture.draft.id })
    ).resolves.toMatchObject({
      ok: true,
      value: [{ executionId: 'execution-video-submission-1', state: 'processing' }]
    });
    await expect(
      fixture.controller.refreshExecution({
        executionId: 'execution-video-submission-1',
        endpoint: 'https://attacker.invalid'
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});
