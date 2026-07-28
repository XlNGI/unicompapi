import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExecution,
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  toCapabilityEvidenceId,
  toConnectionId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderId,
  toTaskId,
  type Task
} from '../../src/domain';
import {
  ImageOperationRouter,
  JsonProviderRegistryStore,
  VideoOperationRouter
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-28T02:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('strongly typed provider operation routers', () => {
  it('rejects image tasks routed to video models before calling an adapter', async () => {
    const fixture = await createFixture();
    let adapterCalls = 0;
    const router = new ImageOperationRouter(fixture.registry, {
      video_adapter: {
        submit: async () => {
          adapterCalls += 1;
          return {
            kind: 'asynchronous',
            providerOperationId: 'should-not-exist',
            state: 'queued'
          };
        }
      }
    });
    const task = imageTask(fixture.videoModelId, fixture.videoEvidenceId);

    await expect(
      router.submit({ task, execution: executionFor(task) })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_model_mismatch' }
    });
    expect(adapterCalls).toBe(0);
  });

  it('rejects video tasks routed to image models before calling an adapter', async () => {
    const fixture = await createFixture();
    let adapterCalls = 0;
    const router = new VideoOperationRouter(fixture.registry, {
      image_adapter: {
        submit: async () => {
          adapterCalls += 1;
          return {
            kind: 'synchronous_completed',
            providerOperationId: 'should-not-exist'
          };
        }
      }
    });
    const task = videoTask(fixture.imageModelId, fixture.oldImageEvidenceId);

    await expect(
      router.submit({ task, execution: executionFor(task) })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_model_mismatch' }
    });
    expect(adapterCalls).toBe(0);
  });

  it('keeps an old task evidence ID routable after a newer immutable revision exists', async () => {
    const fixture = await createFixture();
    let adapterCalls = 0;
    const router = new ImageOperationRouter(fixture.registry, {
      image_adapter: {
        submit: async ({ evidence, model, binding }) => {
          adapterCalls += 1;
          expect(evidence.id).toBe(fixture.oldImageEvidenceId);
          expect(model.capabilityEvidenceId).toBe(fixture.newImageEvidenceId);
          expect(binding.executionLifecycle).toBe('synchronous_completed');
          return {
            kind: 'synchronous_completed',
            providerOperationId: 'local-provider-operation-1'
          };
        }
      }
    });
    const task = imageTask(fixture.imageModelId, fixture.oldImageEvidenceId);

    await expect(
      router.submit({ task, execution: executionFor(task) })
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: 'synchronous_completed',
        providerOperationId: 'local-provider-operation-1'
      }
    });
    expect(adapterCalls).toBe(1);
  });

  it('rejects a tampered provider snapshot before calling an adapter', async () => {
    const fixture = await createFixture();
    let adapterCalls = 0;
    const router = new ImageOperationRouter(fixture.registry, {
      image_adapter: {
        submit: async () => {
          adapterCalls += 1;
          return {
            kind: 'synchronous_completed',
            providerOperationId: 'should-not-exist'
          };
        }
      }
    });
    const original = imageTask(
      fixture.imageModelId,
      fixture.oldImageEvidenceId
    );
    const task = {
      ...original,
      submission: {
        ...original.submission,
        image: original.submission.image
          ? {
              ...original.submission.image,
              providerId: toProviderId('provider-tampered')
            }
          : undefined
      }
    } as Task;

    await expect(
      router.submit({ task, execution: executionFor(task) })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_model_mismatch' }
    });
    expect(adapterCalls).toBe(0);
  });

  it('rejects a task kind that does not match its image purpose', async () => {
    const fixture = await createFixture();
    let adapterCalls = 0;
    const router = new ImageOperationRouter(fixture.registry, {
      image_adapter: {
        submit: async () => {
          adapterCalls += 1;
          return {
            kind: 'synchronous_completed',
            providerOperationId: 'should-not-exist'
          };
        }
      }
    });
    const original = imageTask(
      fixture.imageModelId,
      fixture.oldImageEvidenceId
    );
    const task = {
      ...original,
      submission: {
        ...original.submission,
        kind: 'image_editing'
      }
    } as Task;

    await expect(
      router.submit({ task, execution: executionFor(task) })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_model_mismatch' }
    });
    expect(adapterCalls).toBe(0);
  });

  it('rejects an adapter outcome that contradicts the protocol lifecycle', async () => {
    const fixture = await createFixture();
    let adapterCalls = 0;
    const router = new ImageOperationRouter(fixture.registry, {
      image_adapter: {
        submit: async () => {
          adapterCalls += 1;
          return {
            kind: 'asynchronous',
            providerOperationId: 'provider-operation-invalid-lifecycle',
            state: 'queued'
          };
        }
      }
    });
    const task = imageTask(
      fixture.imageModelId,
      fixture.oldImageEvidenceId
    );

    await expect(
      router.submit({ task, execution: executionFor(task) })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'adapter_contract_violation' }
    });
    expect(adapterCalls).toBe(1);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-provider-router-'));
  roots.push(root);
  const registry = new JsonProviderRegistryStore(path.join(root, 'registry.json'));
  const provider = createProvider({
    id: toProviderId('provider-router'),
    name: 'Router fixture',
    accessCategory: 'online',
    identityState: 'verified',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const connection = createProviderConnection({
    id: toConnectionId('connection-router'),
    providerId: provider.id,
    name: 'Router fixture',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const imageBinding = createProviderProtocolBinding({
    id: toProtocolBindingId('protocol-router-image'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.image.v1',
    protocolVersion: '1',
    mediaKind: 'image',
    adapterKind: 'image_adapter',
    authScheme: 'unknown',
    executionLifecycle: 'synchronous_completed',
    supportedPurposes: ['image_generation'],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const videoBinding = createProviderProtocolBinding({
    id: toProtocolBindingId('protocol-router-video'),
    providerId: provider.id,
    connectionId: connection.id,
    protocolId: 'fixture.video.v1',
    protocolVersion: '1',
    mediaKind: 'video',
    adapterKind: 'video_adapter',
    authScheme: 'unknown',
    executionLifecycle: 'asynchronous_polling',
    supportedPurposes: ['video_generation'],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const imageModelId = toModelId('model-image-router');
  const videoModelId = toModelId('model-video-router');
  const oldImageEvidenceId = toCapabilityEvidenceId('evidence-image-router-v1');
  const newImageEvidenceId = toCapabilityEvidenceId('evidence-image-router-v2');
  const videoEvidenceId = toCapabilityEvidenceId('evidence-video-router-v1');
  const oldImageEvidence = createModelCapabilityEvidence({
    id: oldImageEvidenceId,
    modelId: imageModelId,
    revision: 1,
    capability: 'image_generation',
    state: 'verified_supported',
    source: 'connection_verified',
    recordedAt: timestamp
  });
  const newImageEvidence = createModelCapabilityEvidence({
    id: newImageEvidenceId,
    modelId: imageModelId,
    revision: 2,
    capability: 'image_generation',
    state: 'verified_supported',
    source: 'connection_verified',
    supersedesEvidenceId: oldImageEvidenceId,
    recordedAt: toIsoTimestamp('2026-07-28T02:01:00.000Z')
  });
  const videoEvidence = createModelCapabilityEvidence({
    id: videoEvidenceId,
    modelId: videoModelId,
    revision: 1,
    capability: 'video_generation',
    state: 'verified_supported',
    source: 'connection_verified',
    videoGenerationSchema: {
      schemaVersion: 1,
      modes: [{ mode: 'quick_video' }]
    },
    recordedAt: timestamp
  });
  const imageModel = createProviderModel({
    id: imageModelId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: imageBinding.id,
    providerModelKey: 'image-router-model',
    mediaKind: 'image',
    revision: 2,
    displayName: 'Image router model',
    capabilityEvidenceId: newImageEvidenceId,
    enabled: true,
    createdAt: timestamp,
    updatedAt: newImageEvidence.recordedAt
  });
  const videoModel = createProviderModel({
    id: videoModelId,
    providerId: provider.id,
    connectionId: connection.id,
    protocolBindingId: videoBinding.id,
    providerModelKey: 'video-router-model',
    mediaKind: 'video',
    revision: 1,
    displayName: 'Video router model',
    capabilityEvidenceId: videoEvidenceId,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await registry.save({
    schemaVersion: 2,
    providers: [provider],
    connections: [connection],
    protocolBindings: [imageBinding, videoBinding],
    models: [imageModel, videoModel],
    capabilities: [oldImageEvidence, newImageEvidence, videoEvidence],
    routingPreferences: []
  });
  return {
    registry,
    imageModelId,
    videoModelId,
    oldImageEvidenceId,
    newImageEvidenceId,
    videoEvidenceId
  };
}

function imageTask(
  modelId: ReturnType<typeof toModelId>,
  evidenceId: ReturnType<typeof toCapabilityEvidenceId>
): Task {
  return {
    schemaVersion: 1,
    id: toTaskId('task-router-image'),
    projectId: toProjectId('project-router'),
    sourceDraftId: toDraftId('draft-router-image'),
    submission: {
      kind: 'image_generation',
      prompt: {
        originalInput: 'image',
        systemSupplements: [],
        finalPrompt: 'image'
      },
      assetIds: [],
      confirmedAt: timestamp,
      image: {
        mode: 'quick_image',
        purpose: 'image_generation',
        modelId,
        capabilityEvidenceId: evidenceId,
        providerId: toProviderId('provider-router'),
        connectionId: toConnectionId('connection-router'),
        recipientName: 'Router fixture',
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
    executionIds: [],
    createdAt: timestamp
  };
}

function videoTask(
  modelId: ReturnType<typeof toModelId>,
  evidenceId: ReturnType<typeof toCapabilityEvidenceId>
): Task {
  return {
    schemaVersion: 1,
    id: toTaskId('task-router-video'),
    projectId: toProjectId('project-router'),
    sourceDraftId: toDraftId('draft-router-video'),
    submission: {
      kind: 'video_generation',
      prompt: {
        originalInput: 'video',
        systemSupplements: [],
        finalPrompt: 'video'
      },
      assetIds: [],
      confirmedAt: timestamp,
      video: {
        mode: 'quick_video',
        purpose: 'video_generation',
        modelId,
        capabilityEvidenceId: evidenceId,
        providerId: toProviderId('provider-router'),
        connectionId: toConnectionId('connection-router'),
        recipientName: 'Router fixture',
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
      }
    },
    executionIds: [],
    createdAt: timestamp
  };
}

function executionFor(task: Task) {
  return createExecution({
    id: toExecutionId(`execution-${task.id}`),
    taskId: task.id,
    createdAt: timestamp
  });
}
