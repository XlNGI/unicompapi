import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAsset,
  createExecution,
  toAssetId,
  toDraftId,
  toExecutionId,
  toFileReferenceId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  toWorkId,
  type Task,
  type Work
} from '../../src/domain';
import {
  JsonAssetRepository,
  JsonExecutionRepository,
  JsonFileIndexRepository,
  JsonFileReferenceRepository,
  JsonProviderRegistryStore,
  JsonTaskRepository,
  JsonViduLiveValidationStore,
  JsonWorkRepository,
  NodeProjectStorage,
  ViduLiveValidationApplicationService,
  ViduLiveValidationController,
  ViduLiveValidationCoordinator,
  ViduLiveValidationDataError,
  ViduRuntimeAuthorizationClosedError,
  createFrozenViduRegistryRecords,
  denyViduRuntimeAuthorization,
  toProjectRelativePath
} from '../../src/platform';

const roots: string[] = [];
const projectId = toProjectId('project-vidu-live');
const t0 = toIsoTimestamp('2026-07-29T02:00:00.000Z');
const session = (root: string) => ({
  projectId,
  projectName: 'Vidu live project',
  rootDirectory: root
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Vidu live validation record', () => {
  it('persists a strict one-image and one-video attempt timeline', async () => {
    const root = await temporaryRoot();
    const recordPath = path.join(root, 'validation.json');
    const coordinator = new ViduLiveValidationCoordinator(
      new JsonViduLiveValidationStore(recordPath),
      tickingClock()
    );
    await coordinator.start({ readiness: approvedReadiness() });
    await coordinator.recordCreditsValidation({ outcome: 'succeeded' });
    await coordinator.claimBillableAttempt('image', {
      taskId: 'task-image',
      executionId: 'execution-image'
    });
    await expect(
      coordinator.claimBillableAttempt('image', {
        taskId: 'task-image-2',
        executionId: 'execution-image-2'
      })
    ).rejects.toMatchObject({
      code: 'budget_exhausted'
    });
    await coordinator.recordSubmission('image', {
      outcome: 'accepted_or_completed'
    });
    await coordinator.recordLocalResult('image', {
      taskId: 'task-image',
      executionId: 'execution-image',
      workId: 'work-image',
      mediaProbed: true,
      sha256Verified: true,
      atomicallyPublished: true,
      indexed: true,
      workRegistered: true
    });
    await coordinator.confirmVideo({
      sourceImageWorkId: 'work-image',
      outboundScopeConfirmed: true,
      costConfirmed: true
    });
    await coordinator.claimBillableAttempt('video', {
      taskId: 'task-video',
      executionId: 'execution-video'
    });
    await coordinator.recordSubmission('video', {
      outcome: 'accepted_or_completed'
    });
    await coordinator.recordVideoPolling({ providerState: 'processing' });
    await coordinator.recordVideoPolling({ providerState: 'success' });
    const passed = await coordinator.recordLocalResult('video', {
      taskId: 'task-video',
      executionId: 'execution-video',
      workId: 'work-video',
      mediaProbed: true,
      sha256Verified: true,
      atomicallyPublished: true,
      indexed: true,
      workRegistered: true
    });

    expect(passed.status).toBe('passed');
    expect(passed.budget.image.billingFact).toBe('accepted_or_completed');
    expect(passed.budget.video.billingFact).toBe('accepted_or_completed');
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(passed);
  });

  it('rejects damaged or extended validation records', async () => {
    const root = await temporaryRoot();
    const recordPath = path.join(root, 'validation.json');
    const store = new JsonViduLiveValidationStore(recordPath);
    const coordinator = new ViduLiveValidationCoordinator(store, tickingClock());
    const record = await coordinator.start({ readiness: approvedReadiness() });
    await writeFile(
      recordPath,
      JSON.stringify({ ...record, leakedToken: 'must-not-load' }),
      'utf8'
    );
    await expect(store.load()).rejects.toBeInstanceOf(
      ViduLiveValidationDataError
    );
  });
});

describe('Vidu live validation application service', () => {
  it('installs only the approved models and promotes immutable evidence after Works', async () => {
    const fixture = await createApplicationFixture();
    const started = await fixture.service.start(approvedInput());
    expect(started.status).toBe('active');
    expect(fixture.validationCalls).toBe(1);

    let registry = await fixture.registry.load();
    const imageModel = model(registry, 'q3-lite');
    const videoModel = model(registry, 'viduq3-turbo');
    expect(imageModel.enabled).toBe(true);
    expect(videoModel.enabled).toBe(true);
    expect(
      registry.models.filter((candidate) =>
        candidate.providerId === imageModel.providerId && candidate.enabled
      )
    ).toHaveLength(2);
    expect(
      registry.capabilities.find(
        (evidence) => evidence.id === videoModel.capabilityEvidenceId
      )
    ).toMatchObject({
      state: 'user_confirmed',
      capability: 'reference_to_video',
      parameterSchema: {
        fields: [
          { key: 'audio', required: true },
          { key: 'duration', minimum: 3, maximum: 15 },
          { key: 'resolution', options: ['540p'] }
        ]
      }
    });

    const imageExecution = createExecution({
      id: toExecutionId('execution-live-image'),
      taskId: toTaskId('task-live-image'),
      createdAt: t0
    });
    const imageTask = imageTaskFor(imageModel, imageExecution.id);
    await fixture.service.beforeSubmission(
      'image',
      imageTask,
      imageExecution,
      () => session(fixture.root)
    );
    await expect(
      fixture.service.beforeSubmission(
        'image',
        imageTask,
        imageExecution,
        () => session(fixture.root)
      )
    ).rejects.toMatchObject({
      code: 'billable_attempt_exhausted'
    });
    await fixture.service.afterSubmission('image', {
      kind: 'completed_sync',
      providerOperationId: 'local-image-operation',
      results: [{
        kind: 'file_uri',
        value: 'https://example.invalid/not-exposed'
      }]
    });
    const imageWork = workFor(
      'work-live-image',
      'file-live-image',
      'image',
      imageTask,
      imageExecution.id
    );
    await saveFacts(fixture.root, imageTask, imageExecution, imageWork);
    await fixture.service.recordLocalResult(
      'image',
      imageExecution.id,
      imageWork.id,
      () => session(fixture.root)
    );

    registry = await fixture.registry.load();
    const promotedImage = model(registry, 'q3-lite');
    expect(
      registry.capabilities.find(
        (evidence) => evidence.id === promotedImage.capabilityEvidenceId
      )
    ).toMatchObject({
      state: 'verified_supported',
      source: 'system_observed'
    });
    expect(
      registry.capabilities.some(
        (evidence) =>
          evidence.id === imageModel.capabilityEvidenceId &&
          evidence.state === 'user_confirmed'
      )
    ).toBe(true);

    const storage = new NodeProjectStorage(fixture.root);
    const sourceAsset = createAsset({
      id: toAssetId('asset-live-image'),
      projectId,
      fileId: imageWork.fileId,
      name: 'Live image',
      mediaKind: 'image',
      origin: 'generated',
      role: 'reference',
      createdAt: t0
    });
    await new JsonAssetRepository(storage, projectId).save(sourceAsset);
    const currentVideoModel = model(registry, 'viduq3-turbo');
    const videoExecution = createExecution({
      id: toExecutionId('execution-live-video'),
      taskId: toTaskId('task-live-video'),
      createdAt: t0
    });
    const videoTask = videoTaskFor(
      currentVideoModel,
      videoExecution.id,
      sourceAsset.id
    );
    await fixture.service.beforeSubmission(
      'video',
      videoTask,
      videoExecution,
      () => session(fixture.root)
    );
    await fixture.service.afterSubmission('video', {
      kind: 'accepted_async',
      providerOperationId: 'remote-video-operation',
      state: 'queued'
    });
    await fixture.service.recordPolling({ state: 'processing' });
    await fixture.service.recordPolling({ state: 'completed' });
    const videoWork = workFor(
      'work-live-video',
      'file-live-video',
      'video',
      videoTask,
      videoExecution.id
    );
    await saveFacts(fixture.root, videoTask, videoExecution, videoWork);
    await fixture.service.recordLocalResult(
      'video',
      videoExecution.id,
      videoWork.id,
      () => session(fixture.root)
    );

    expect((await fixture.service.load())?.status).toBe('passed');
    registry = await fixture.registry.load();
    const promotedVideo = model(registry, 'viduq3-turbo');
    expect(
      registry.capabilities.find(
        (evidence) => evidence.id === promotedVideo.capabilityEvidenceId
      )
    ).toMatchObject({
      state: 'verified_supported',
      source: 'system_observed'
    });

    const blockedExecution = createExecution({
      id: toExecutionId('execution-live-video-after-pass'),
      taskId: toTaskId('task-live-video'),
      createdAt: t0
    });
    await expect(
      fixture.service.beforeSubmission(
        'video',
        videoTaskFor(promotedVideo, blockedExecution.id, sourceAsset.id),
        blockedExecution,
        () => session(fixture.root)
      )
    ).rejects.toMatchObject({ code: 'validation_not_active' });
  });

  it('does not initialize or claim a paid attempt when credits validation fails', async () => {
    const fixture = await createApplicationFixture(false);
    await expect(fixture.service.start(approvedInput())).rejects.toMatchObject({
      code: 'connection_not_ready'
    });
    expect(await fixture.service.load()).toBeUndefined();
    expect((await fixture.registry.load()).connections[0]).toMatchObject({
      state: 'unavailable',
      credentialState: 'invalid'
    });
  });

  it('stops with a safe local-state fact when submission observation fails', async () => {
    const fixture = await createApplicationFixture();
    await fixture.service.start(approvedInput());
    const registry = await fixture.registry.load();
    const imageModel = model(registry, 'q3-lite');
    const execution = createExecution({
      id: toExecutionId('execution-live-observation-failure'),
      taskId: toTaskId('task-live-image'),
      createdAt: t0
    });
    await fixture.service.beforeSubmission(
      'image',
      imageTaskFor(imageModel, execution.id),
      execution,
      () => session(fixture.root)
    );
    vi.spyOn(fixture.coordinator, 'recordSubmission').mockRejectedValueOnce(
      new Error('fixture observation failure')
    );

    await expect(
      fixture.service.afterSubmission('image', {
        kind: 'completed_sync',
        providerOperationId: 'local-image-operation',
        results: [{
          kind: 'file_uri',
          value: 'https://example.invalid/not-exposed'
        }]
      })
    ).rejects.toThrow('fixture observation failure');
    expect(await fixture.service.load()).toMatchObject({
      status: 'failed',
      stopCode: 'local_state_failed',
      events: expect.arrayContaining([
        expect.objectContaining({
          stage: 'image_submission',
          state: 'failed',
          errorCode: 'local_state_failed'
        })
      ])
    });
  });

  it('closes the validation IPC before credits validation and keeps status DTOs sensitive-free', async () => {
    const fixture = await createApplicationFixture();
    const controller = new ViduLiveValidationController(fixture.service);
    expect(
      await controller.start({
        ...approvedInput(),
        confirmVideoBillableAttempt: false
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'runtime_authorization_closed' }
    });
    expect(await controller.start(approvedInput())).toMatchObject({
      ok: false,
      error: { code: 'runtime_authorization_closed' }
    });
    expect(fixture.validationCalls).toBe(0);

    await fixture.service.start(approvedInput());
    const registry = await fixture.registry.load();
    const imageModel = model(registry, 'q3-lite');
    const wrongModel = model(registry, 'viduq3-turbo');
    const execution = createExecution({
      id: toExecutionId('execution-live-mismatch'),
      taskId: toTaskId('task-live-image'),
      createdAt: t0
    });
    const task = imageTaskFor(imageModel, execution.id);
    const tampered = {
      ...task,
      submission: {
        ...task.submission,
        image: {
          ...task.submission.image!,
          modelId: wrongModel.id,
          capabilityEvidenceId: wrongModel.capabilityEvidenceId!
        }
      }
    } as Task;
    await expect(
      fixture.service.beforeSubmission(
        'image',
        tampered,
        execution,
        () => session(fixture.root)
      )
    ).rejects.toMatchObject({
      code: 'validation_scope_mismatch'
    });
    const status = await controller.getStatus();
    expect(status).toMatchObject({ ok: true, value: { status: 'active' } });
    expect(JSON.stringify(status)).not.toMatch(
      /token|credential|providerOperation|task_id|download|https?:|absolute|sha256|hash/i
    );
  });

  it('throws the dedicated closure error before a transport can run', async () => {
    let httpCalls = 0;
    const submit = async () => {
      denyViduRuntimeAuthorization();
      httpCalls += 1;
    };

    await expect(submit()).rejects.toBeInstanceOf(
      ViduRuntimeAuthorizationClosedError
    );
    expect(httpCalls).toBe(0);
  });
});

async function createApplicationFixture(validationSucceeds = true) {
  const root = await temporaryRoot();
  const registry = new JsonProviderRegistryStore(path.join(root, 'providers.json'));
  const frozen = createFrozenViduRegistryRecords();
  await registry.save({
    schemaVersion: 3,
    currentConnectionId: null,
    ...frozen,
    connections: frozen.connections.map((connection) => ({
      ...connection,
      state: 'saved' as const,
      credentialState: 'saved' as const,
      credentialReference: 'credential-live-test'
    })),
    routingPreferences: []
  });
  let validationCalls = 0;
  const coordinator = new ViduLiveValidationCoordinator(
    new JsonViduLiveValidationStore(path.join(root, 'validation.json')),
    tickingClock()
  );
  const service = new ViduLiveValidationApplicationService({
    registry,
    coordinator,
    connectionValidation: {
      validate: async () => {
        validationCalls += 1;
        return validationSucceeds
          ? {
              state: 'available' as const,
              identityState: 'verified' as const,
              credentialState: 'valid' as const,
              observedAt: '2026-07-29T02:00:10.000Z'
            }
          : {
              state: 'unavailable' as const,
              identityState: 'verification_failed' as const,
              credentialState: 'invalid' as const,
              observedAt: '2026-07-29T02:00:10.000Z'
            };
      }
    },
    now: tickingClock()
  });
  return {
    root,
    registry,
    coordinator,
    service,
    get validationCalls() { return validationCalls; }
  };
}

function imageTaskFor(
  modelValue: ReturnType<typeof model>,
  executionId: ReturnType<typeof toExecutionId>
): Task {
  return {
    schemaVersion: 1,
    id: toTaskId('task-live-image'),
    projectId,
    sourceDraftId: toDraftId('draft-live-image'),
    submission: {
      kind: 'image_generation',
      prompt: prompt('Create one image from this reference'),
      assetIds: [toAssetId('asset-input-image')],
      confirmedAt: t0,
      image: {
        mode: 'professional_image',
        purpose: 'reference_to_image',
        modelId: modelValue.id,
        capabilityEvidenceId: modelValue.capabilityEvidenceId!,
        providerId: modelValue.providerId,
        connectionId: modelValue.connectionId,
        recipientName: 'Vidu / official connection',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: {},
        confirmations: {
          recipient: true,
          outboundScope: true,
          cost: true,
          finalPrompt: true,
          model: true
        }
      }
    },
    executionIds: [executionId],
    createdAt: t0
  };
}

function videoTaskFor(
  modelValue: ReturnType<typeof model>,
  executionId: ReturnType<typeof toExecutionId>,
  assetId: ReturnType<typeof toAssetId>
): Task {
  return {
    schemaVersion: 1,
    id: toTaskId('task-live-video'),
    projectId,
    sourceDraftId: toDraftId('draft-live-video'),
    submission: {
      kind: 'video_generation',
      prompt: prompt('Animate the verified image'),
      assetIds: [assetId],
      confirmedAt: t0,
      video: {
        mode: 'image_to_video',
        purpose: 'video_generation',
        modelId: modelValue.id,
        capabilityEvidenceId: modelValue.capabilityEvidenceId!,
        providerId: modelValue.providerId,
        connectionId: modelValue.connectionId,
        recipientName: 'Vidu / official connection',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: { audio: false, duration: 3, resolution: '540p' },
        materials: [{
          assetId,
          mediaKind: 'image',
          role: 'reference',
          target: { kind: 'slot', slotId: 'reference' }
        }],
        contextReferences: [],
        input: {
          mode: 'image_to_video',
          mustKeep: [],
          allowedChanges: [],
          prohibited: [],
          subjectAction: '',
          cameraMovement: '',
          pace: '',
          depthOfField: ''
        },
        confirmations: {
          recipient: true,
          outboundScope: true,
          materials: true,
          costPrivacyRegion: true,
          finalPrompt: true,
          model: true
        }
      }
    },
    executionIds: [executionId],
    createdAt: t0
  };
}

async function saveFacts(
  root: string,
  task: Task,
  execution: ReturnType<typeof createExecution>,
  work: Work
) {
  const storage = new NodeProjectStorage(root);
  const relativePath = toProjectRelativePath(
    `files/results/${work.fileId}.fixture`
  );
  const content = Buffer.from(`verified-${work.mediaKind}-result`);
  const checksumSha256 = createHash('sha256').update(content).digest('hex');
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  const file = {
    schemaVersion: 1 as const,
    id: work.fileId,
    projectId,
    sourceExecutionId: execution.id,
    locator: { kind: 'project' as const, relativePath },
    state: 'available' as const,
    sizeBytes: content.byteLength,
    checksumSha256,
    lastVerification: {
      sizeBytes: content.byteLength,
      checksumSha256,
      matchesExpected: true,
      verifiedAt: t0
    },
    createdAt: t0,
    updatedAt: t0
  };
  await new JsonTaskRepository(storage, projectId).save(task);
  await new JsonExecutionRepository(storage).save(execution);
  await new JsonFileReferenceRepository(storage, projectId).save(file);
  await new JsonFileIndexRepository(storage, projectId).upsert({
    fileId: file.id,
    relativePath,
    state: file.state,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    updatedAt: file.updatedAt
  });
  await new JsonWorkRepository(storage, projectId).save(work);
}

function workFor(
  workId: string,
  fileId: string,
  mediaKind: 'image' | 'video',
  task: Task,
  executionId: ReturnType<typeof toExecutionId>
): Work {
  return {
    schemaVersion: 1,
    id: toWorkId(workId),
    projectId,
    sourceTaskId: task.id,
    sourceExecutionId: executionId,
    fileId: toFileReferenceId(fileId),
    mediaKind,
    name: `${mediaKind} result`,
    createdAt: t0
  };
}

function model(
  registry: Awaited<ReturnType<JsonProviderRegistryStore['load']>>,
  key: string
) {
  const result = registry.models.find(
    (candidate) => candidate.providerModelKey === key
  );
  if (!result) throw new Error(`Missing model ${key}`);
  return result;
}

function prompt(value: string) {
  return {
    originalInput: value,
    systemSupplements: [],
    finalPrompt: value
  };
}

function approvedReadiness() {
  return {
    officialFacts: {
      creditsContractVerified: true,
      imageContractVerified: true,
      videoContractVerified: true
    },
    approval: {
      liveNetworkApproved: true,
      credentialUseApproved: true,
      imageBillableAttemptApproved: true,
      videoBillableAttemptApproved: true
    }
  };
}

function approvedInput() {
  return {
    confirmLiveNetwork: true,
    confirmCredentialUse: true,
    confirmImageBillableAttempt: true,
    confirmVideoBillableAttempt: true
  } as const;
}

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.parse(t0) + tick++ * 1_000).toISOString();
}

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-live-'));
  roots.push(root);
  return root;
}
