import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addExecutionToTask,
  createEmptyVideoWorkspaceDraft,
  createExecution,
  createProviderExecutionRouteSnapshot,
  createProviderInvocationAttempt,
  createProviderInvocationEvent,
  createProviderProtocolBinding,
  createVideoTask,
  createVideoWorkspaceDraft,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toProviderOperationRecordId,
  toTaskId,
  toUsageSchemaId,
  toWorkId,
  transitionExecution,
  type ProviderProtocolBinding
} from '../../src/domain';
import {
  JsonExecutionRepository,
  JsonProviderExecutionRouteSnapshotRepository,
  JsonProviderInvocationRepository,
  JsonProviderRegistryStore,
  JsonTaskRepository,
  NEWAPI_VIDEO_ADAPTER_ID,
  NodeProjectStorage,
  ProviderPackageRegistry,
  VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID,
  VideoWorkspaceMutationCoordinator,
  createVideoFeatureControllerRuntime
} from '../../src/platform';

const roots: string[] = [];
const t0 = toIsoTimestamp('2026-08-17T01:00:00.000Z');
const t1 = toIsoTimestamp('2026-08-17T01:01:00.000Z');
const t2 = toIsoTimestamp('2026-08-17T01:02:00.000Z');
const t3 = toIsoTimestamp('2026-08-17T01:03:00.000Z');
const t4 = toIsoTimestamp('2026-08-17T01:04:00.000Z');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('video feature result recovery', () => {
  it('restores a Vidu operation context and reuses the failed execution', async () => {
    const fixture = await createFixture(VIDU_REFERENCE_VIDEO_V2_ADAPTER_ID);
    const rememberVideoOperation = vi.fn();

    const runtime = createRuntime(fixture, {
      rememberVideoOperation
    });

    await expect(runtime.recoverResult?.(fixture.task.id)).resolves.toEqual({
      schemaVersion: 1,
      taskId: fixture.task.id,
      executionId: fixture.execution.id,
      workId: toWorkId('work-video-recovery')
    });
    expect(rememberVideoOperation).toHaveBeenCalledWith(
      fixture.execution.remoteOperationId,
      {
        connectionId: fixture.binding.connectionId,
        binding: fixture.binding
      }
    );
    expect(fixture.receive).toHaveBeenCalledWith(fixture.execution.id);
    await expect(fixture.executions.list(fixture.task.id)).resolves.toHaveLength(1);
    expect(runtime.submit).toBeUndefined();
  });

  it('keeps the NewAPI recovery attachment path working', async () => {
    const fixture = await createFixture(NEWAPI_VIDEO_ADAPTER_ID);
    const attachNewApiVideoOperation = vi.fn(async () => undefined);

    const runtime = createRuntime(fixture, {
      attachNewApiVideoOperation
    });

    await expect(runtime.recoverResult?.(fixture.task.id)).resolves.toMatchObject({
      taskId: fixture.task.id,
      executionId: fixture.execution.id
    });
    expect(attachNewApiVideoOperation).toHaveBeenCalledWith({
      routeSnapshot: fixture.route,
      providerOperationId: fixture.execution.remoteOperationId,
      invocationAttemptId: fixture.attempt.id
    });
    expect(fixture.receive).toHaveBeenCalledWith(fixture.execution.id);
    await expect(fixture.executions.list(fixture.task.id)).resolves.toHaveLength(1);
    expect(runtime.submit).toBeUndefined();
  });

  it('rejects an unrestorable route before changing the failed execution', async () => {
    const fixture = await createFixture('unsupported_video_adapter', false);
    const runtime = createRuntime(fixture, {
      rememberVideoOperation: vi.fn(),
      attachNewApiVideoOperation: vi.fn(async () => undefined)
    });

    await expect(runtime.recoverResult?.(fixture.task.id)).rejects.toThrow(
      'The original video route cannot be restored'
    );
    expect(fixture.receive).not.toHaveBeenCalled();
    await expect(fixture.executions.get(fixture.execution.id)).resolves.toMatchObject({
      id: fixture.execution.id,
      state: 'failed'
    });
  });
});

async function createFixture(adapterKey: string, includeBinding = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-video-recovery-'));
  roots.push(root);
  const projectId = toProjectId(`project-video-recovery-${adapterKey}`);
  const storage = new NodeProjectStorage(root);
  const draftBase = createEmptyVideoWorkspaceDraft({
    id: toDraftId(`draft-video-recovery-${adapterKey}`),
    projectId,
    mode: 'quick_video',
    createdAt: t0
  });
  const draft = createVideoWorkspaceDraft({
    ...draftBase,
    state: 'saved',
    prompt: {
      originalInput: 'Recover the existing video result',
      systemSupplements: [],
      finalPrompt: 'Recover the existing video result'
    }
  });
  const task = createVideoTask({
    id: toTaskId(`task-video-recovery-${adapterKey}`),
    draft,
    confirmation: {
      mode: 'quick_video',
      purpose: 'video_generation',
      modelId: toModelId(`model-video-recovery-${adapterKey}`),
      capabilityEvidenceId: toCapabilityEvidenceId(
        `evidence-video-recovery-${adapterKey}`
      ),
      providerId: toProviderId(`provider-video-recovery-${adapterKey}`),
      connectionId: toConnectionId(`connection-video-recovery-${adapterKey}`),
      recipientName: 'Video recovery provider',
      accessCategory: 'online',
      outboundScope: 'external_service',
      costState: 'unknown',
      privacyState: 'unknown',
      regionState: 'unknown',
      parameters: {},
      materials: [],
      contextReferences: [],
      input: { mode: 'quick_video' },
      confirmations: {
        recipient: true,
        outboundScope: true,
        materials: true,
        costPrivacyRegion: true,
        finalPrompt: true,
        model: true
      }
    },
    confirmedAt: t0
  });
  const created = createExecution({
    id: toExecutionId(`execution-video-recovery-${adapterKey}`),
    taskId: task.id,
    createdAt: t0
  });
  const submitting = transitionExecution(created, 'submitting', t1);
  const processing = transitionExecution(submitting, 'processing', t2, {
    remoteOperationId: `remote-video-recovery-${adapterKey}`,
    providerOperationRecordId: toProviderOperationRecordId(
      `provider-operation-video-recovery-${adapterKey}`
    ),
    submissionOutcome: 'accepted_async'
  });
  const remoteCompleted = transitionExecution(processing, 'remote_completed', t3);
  const downloading = transitionExecution(remoteCompleted, 'downloading', t3);
  const execution = transitionExecution(downloading, 'failed', t4, {
    failure: {
      stage: 'downloading',
      message: 'Temporary result download failure',
      retryability: 'retryable'
    }
  });
  const tasks = new JsonTaskRepository(storage, projectId);
  const executions = new JsonExecutionRepository(storage);
  await tasks.save(addExecutionToTask(task, execution));
  await executions.save(execution);

  const binding = createBinding(projectId, adapterKey);
  const route = createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-video-recovery-${adapterKey}`),
    projectId,
    packageId: 'package.video-recovery',
    packageVersion: '1.0.0',
    adapterKey,
    adapterVersion: '1.0.0',
    providerId: binding.providerId,
    connectionId: binding.connectionId,
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config:video-recovery',
    endpointPolicyId: 'endpoint.video-recovery',
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential:video-recovery',
    modelId: toModelId(`route-model-video-recovery-${adapterKey}`),
    modelRevision: 1,
    profileId: 'profile.video-recovery',
    profileRevision: 1,
    protocolBindingId: binding.id,
    protocolBindingRevision: 1,
    productFeature: 'image_to_video',
    featureMappingVersion: 1,
    parameterSchemaId: 'parameters.video-recovery',
    parameterSchemaRevision: 1,
    resultSchemaId: 'results.video-recovery',
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId('usage-schema-video-recovery'),
    usageSchemaRevision: 1,
    constraintSetId: 'constraints.video-recovery',
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.video-recovery',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim:video-recovery',
    createdAt: t0
  });
  await new JsonProviderExecutionRouteSnapshotRepository(storage, projectId)
    .save(route);
  const attempt = createProviderInvocationAttempt({
    id: toProviderInvocationAttemptId(`attempt-video-recovery-${adapterKey}`),
    projectId,
    subject: {
      kind: 'media',
      taskId: task.id,
      executionId: execution.id
    },
    routeSnapshotId: route.id,
    createdAt: t1
  });
  const event = createProviderInvocationEvent({
    id: toProviderInvocationEventId(`event-video-recovery-${adapterKey}`),
    invocationAttemptId: attempt.id,
    sequence: 1,
    type: 'submission_started',
    occurredAt: t1
  });
  await new JsonProviderInvocationRepository(storage, projectId)
    .create(attempt, event);

  const providerRegistry = new JsonProviderRegistryStore(
    path.join(root, 'provider-registry.json')
  );
  vi.spyOn(providerRegistry, 'load').mockResolvedValue({
    schemaVersion: 2,
    providers: [],
    connections: [],
    protocolBindings: includeBinding ? [binding] : [],
    models: [],
    capabilities: [],
    routingPreferences: []
  });
  const receive = vi.fn(async (executionId: string) => ({
    ok: true as const,
    value: {
      executionId,
      works: [{
        workId: toWorkId('work-video-recovery'),
        name: 'Recovered video'
      }]
    }
  }));

  return {
    root,
    projectId,
    task,
    execution,
    route,
    attempt,
    binding,
    providerRegistry,
    executions,
    receive
  };
}

function createBinding(
  projectId: ReturnType<typeof toProjectId>,
  adapterKey: string
): ProviderProtocolBinding {
  return createProviderProtocolBinding({
    id: toProtocolBindingId(`binding-${projectId}-${adapterKey}`),
    providerId: toProviderId(`binding-provider-${adapterKey}`),
    connectionId: toConnectionId(`binding-connection-${adapterKey}`),
    protocolId: `protocol.${adapterKey}`,
    protocolVersion: '1',
    mediaKind: 'video',
    adapterKind: adapterKey,
    authScheme: 'bearer',
    executionLifecycle: 'asynchronous_polling',
    supportedPurposes: ['video_generation'],
    createdAt: t0,
    updatedAt: t0
  });
}

function createRuntime(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  attachments: {
    readonly rememberVideoOperation?: (
      providerOperationId: string,
      context: {
        readonly connectionId: string;
        readonly binding: ProviderProtocolBinding;
      }
    ) => void;
    readonly attachNewApiVideoOperation?: (input: {
      readonly routeSnapshot: unknown;
      readonly providerOperationId: string;
      readonly invocationAttemptId: string;
    }) => Promise<void>;
  }
) {
  return createVideoFeatureControllerRuntime({
    session: {
      projectId: fixture.projectId,
      projectName: 'Video recovery project',
      rootDirectory: fixture.root
    },
    providerRegistry: fixture.providerRegistry,
    providerPackages: new ProviderPackageRegistry([]),
    runtimeAuthorization: {
      async checkAccess() {
        return {
          allowed: false,
          operation: 'submit' as const,
          reason: 'no_matching_policy' as const
        };
      }
    },
    ...attachments,
    resultReceiver: { receive: fixture.receive },
    mutations: new VideoWorkspaceMutationCoordinator(),
    now: () => '2026-08-17T01:05:00.000Z'
  });
}
