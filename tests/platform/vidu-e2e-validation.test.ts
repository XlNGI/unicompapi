import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEmptyImageWorkspaceDraft,
  createExecution,
  createImageWorkspaceDraft,
  createModelCapabilityEvidence,
  createProvider,
  createProviderConnection,
  createProviderModel,
  createProviderProtocolBinding,
  createRoutingPreference,
  toAssetId,
  toCapabilityEvidenceId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toProjectId,
  toRoutingPreferenceId,
  toTaskId,
  transitionExecution,
  type ModelCapabilityEvidence,
  type ProviderModel,
  type ProviderProtocolBinding,
  type Task
} from '../../src/domain';
import {
  ImageOperationPortError,
  ImageOperationRouter,
  ImageSubmissionController,
  ImageWorkspaceMutationCoordinator,
  JsonImageWorkspaceRepository,
  JsonProviderOperationRepository,
  JsonProviderRegistryStore,
  JsonWorkRepository,
  LocalImageResultReceiver,
  LocalVideoResultReceiver,
  NodeProjectStorage,
  ProjectImageMaterialResolver,
  SecureCredentialVault,
  ViduBoundedPoller,
  ViduImmediateImageResultPort,
  ViduProviderPackage,
  ViduTransportFailure,
  VideoOperationPortError,
  VideoOperationRouter,
  VideoSubmissionController,
  VideoWorkspaceController,
  VideoWorkspaceMutationCoordinator,
  type ControlledImageMaterial,
  type ControlledImageMaterialPort,
  type CredentialProtector,
  type ProviderProtocolSubmitRequest,
  type ViduSafeLogEvent,
  type ViduVideoOperationContext,
  type ViduVideoOperationContextPort
} from '../../src/platform';
import { createUserViduRegistryRecords } from '../fixtures/vidu-user-registry';
import {
  SyntheticViduService,
  binaryResponse,
  isoBmffVideo,
  jsonResponse,
  pngBytes
} from '../fixtures/vidu-synthetic-service';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-29T04:00:00.000Z');
const projectId = toProjectId('project-vidu-e2e');
const imageAssetId = toAssetId('asset-vidu-e2e-input');
const validToken = 'synthetic-valid-token';

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Vidu local synthetic service validation', () => {
  it('authenticates locally, routes all three protocols and rejects cross-media before transport', async () => {
    const fixture = await createProtocolFixture();

    await expect(
      fixture.providerPackage.connectionValidation.validate(fixture.connection)
    ).resolves.toMatchObject({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid'
    });

    const generation = imageTask(
      fixture.imageV1Model,
      fixture.imageGenerationEvidence,
      'image_generation'
    );
    const editing = imageTask(
      fixture.imageV1Model,
      fixture.imageEditingEvidence,
      'image_editing'
    );
    const reference = imageTask(
      fixture.geminiModel,
      fixture.referenceImageEvidence,
      'reference_to_image'
    );
    const video = videoTask(fixture.videoModel, fixture.referenceVideoEvidence);

    await expect(
      fixture.imageRouter.submit({
        task: generation,
        execution: submittingExecution(generation)
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'completed_sync', results: [{ kind: 'remote_url' }] }
    });
    await expect(
      fixture.imageRouter.submit({
        task: editing,
        execution: submittingExecution(editing)
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'completed_sync', results: [{ kind: 'base64' }] }
    });
    await expect(
      fixture.imageRouter.submit({
        task: reference,
        execution: submittingExecution(reference)
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'completed_sync', results: [{ kind: 'file_uri' }] }
    });
    await expect(
      fixture.videoRouter.submit({
        task: video,
        execution: submittingExecution(video)
      })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'accepted_async',
        providerOperationId: 'synthetic-video-task',
        state: 'queued'
      }
    });

    const requestsBeforeMismatch = fixture.service.requests.length;
    await expect(
      fixture.imageRouter.submit({
        task: video,
        execution: submittingExecution(video)
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_model_mismatch' }
    });
    await expect(
      fixture.videoRouter.submit({
        task: generation,
        execution: submittingExecution(generation)
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_model_mismatch' }
    });
    expect(fixture.service.requests).toHaveLength(requestsBeforeMismatch);
    expect(fixture.service.count('POST', '/ent/v1/images/generations')).toBe(1);
    expect(fixture.service.count('POST', '/ent/v1/images/edits')).toBe(1);
    expect(
      fixture.service.count(
        'POST',
        '/ent/v2/image/reference2image/q3-fast'
      )
    ).toBe(1);
    expect(fixture.service.count('POST', '/ent/v2/reference2video')).toBe(1);
    expect(fixture.service.requests.every((request) => request.authorized)).toBe(
      true
    );

    const wrongVault = new SecureCredentialVault(
      path.join(fixture.root, 'wrong-credentials.json'),
      reversibleProtector()
    );
    await wrongVault.save('credential-vidu-synthetic', 'wrong-token');
    const wrongPackage = new ViduProviderPackage({
      credentialVault: wrongVault,
      transport: fixture.service
    });
    await expect(
      wrongPackage.connectionValidation.validate(fixture.connection)
    ).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'invalid'
    });
    wrongPackage.dispose();
  });

  it('does not retry unknown paid submissions and handles Q3 backoff, cancel, restart and expiry', async () => {
    const clock = { value: Date.parse(timestamp) };
    const fixture = await createProtocolFixture(clock);
    const generation = imageTask(
      fixture.imageV1Model,
      fixture.imageGenerationEvidence,
      'image_generation'
    );
    fixture.service.enqueue(
      'POST',
      '/ent/v1/images/generations',
      new ViduTransportFailure('network')
    );

    await expect(
      fixture.imageRouter.submit({
        task: generation,
        execution: submittingExecution(generation)
      })
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'submission_outcome_unknown' }
    });
    expect(fixture.service.count('POST', '/ent/v1/images/generations')).toBe(1);

    const video = videoTask(fixture.videoModel, fixture.referenceVideoEvidence);
    const submitted = await fixture.videoRouter.submit({
      task: video,
      execution: submittingExecution(video)
    });
    expect(submitted).toMatchObject({
      ok: true,
      value: { kind: 'accepted_async' }
    });
    fixture.service.enqueue(
      'GET',
      '/ent/v2/tasks/synthetic-video-task/creations',
      jsonResponse(429, { private: 'not exposed' }, { 'retry-after': '1' }),
      jsonResponse(503, { private: 'not exposed' })
    );
    const waits: number[] = [];
    const poller = new ViduBoundedPoller(fixture.videoAdapter, {
      maximumAttempts: 4,
      initialDelayMs: 100,
      maximumDelayMs: 1_000,
      jitterRatio: 0,
      wait: async (delay) => {
        waits.push(delay);
      }
    });
    await expect(poller.poll('synthetic-video-task')).resolves.toEqual({
      state: 'completed'
    });
    expect(waits).toEqual([100, 200]);
    await expect(fixture.videoAdapter.cancel('synthetic-video-task')).resolves
      .toEqual({ state: 'cancelled' });

    const restarted = fixture.providerPackage.createVideoAdapter({
      connections: { get: async () => fixture.connection },
      materials: fixture.materials,
      operationContext: staticVideoContext(
        fixture.connection.id,
        fixture.videoBinding
      ),
      now: () => clock.value
    });
    await expect(restarted.listResults('synthetic-video-task')).resolves.toEqual([
      {
        remoteResultId: 'synthetic-video-result',
        name: 'vidu-video-synthetic-video-result'
      }
    ]);
    const videoBytes = isoBmffVideo();
    fixture.service.registerDownload(
      'https://results.synthetic.invalid/generated.mp4?signature=private',
      videoBytes,
      'video/mp4'
    );
    await expect(
      readAll(
        await restarted.openDownload(
          'synthetic-video-task',
          'synthetic-video-result'
        )
      )
    ).resolves.toEqual(videoBytes);

    clock.value += 24 * 60 * 60 * 1_000;
    await expect(
      restarted.openDownload(
        'synthetic-video-task',
        'synthetic-video-result'
      )
    ).rejects.toMatchObject({ retryability: 'not_retryable' });
  });

  it('rejects redirects, oversized and truncated responses without leaking response bodies', async () => {
    const fixture = await createProtocolFixture();
    const runtime = fixture.providerPackage.runtime;
    const resultUrl = 'https://results.synthetic.invalid/security.png';

    fixture.service.enqueue('GET', '/security.png', {
      status: 302,
      headers: {
        location: 'https://attacker.invalid/result?token=private'
      },
      body: new Uint8Array()
    });
    await expect(runtime.downloadResult({ url: resultUrl })).rejects.toMatchObject({
      code: 'redirect_not_allowed'
    });

    fixture.service.enqueue(
      'GET',
      '/security.png',
      binaryResponse(200, new Uint8Array([1]), 'image/png', {
        'content-length': '999'
      })
    );
    await expect(
      runtime.downloadResult({ url: resultUrl, maxResponseBytes: 8 })
    ).rejects.toMatchObject({ code: 'response_too_large' });

    fixture.service.enqueue(
      'GET',
      '/security.png',
      binaryResponse(200, pngBytes(2, 2), 'image/png', {
        'content-length': '64'
      })
    );
    await expect(runtime.downloadResult({ url: resultUrl })).rejects.toMatchObject({
      code: 'invalid_response'
    });

    expect(JSON.stringify(fixture.safeLogs)).not.toContain('token=private');
    expect(JSON.stringify(fixture.safeLogs)).not.toContain('not exposed');
    expect(JSON.stringify(fixture.safeLogs)).not.toContain(validToken);
  });

  it('completes image Work to explicit video draft to verified video Work without exposing provider facts', async () => {
    const fixture = await createProtocolFixture(undefined, true);
    const storage = new NodeProjectStorage(fixture.root);
    const workflowNow = sequentialClock();
    const session = () => ({
      projectId,
      projectName: 'Synthetic Vidu project',
      rootDirectory: fixture.root
    });
    const imageMutations = new ImageWorkspaceMutationCoordinator();
    const videoMutations = new VideoWorkspaceMutationCoordinator();
    const imageOperations = new JsonProviderOperationRepository(storage);
    let imageResultError: unknown;
    const imageReceiver = new LocalImageResultReceiver({
      getSession: session,
      mutations: imageMutations,
      port: new ViduImmediateImageResultPort({
        operations: imageOperations,
        runtime: fixture.providerPackage.runtime
      }),
      createFileId: () => 'file-vidu-e2e-image',
      createWorkId: () => 'work-vidu-e2e-image',
      now: workflowNow,
      onError: (error) => {
        imageResultError = error;
      }
    });
    const imageController = new ImageSubmissionController({
      getSession: session,
      providerRegistry: fixture.registry,
      mutations: imageMutations,
      operationPorts: {
        image_generation: routerImagePort(fixture.imageRouter),
        reference_to_image: routerImagePort(fixture.imageRouter),
        image_editing: routerImagePort(fixture.imageRouter)
      },
      resultReceiver: imageReceiver,
      createTaskId: () => 'task-vidu-e2e-image',
      createExecutionId: () => 'execution-vidu-e2e-image',
      createProviderOperationRecordId: () => 'operation-record-vidu-e2e-image',
      now: workflowNow
    });
    const imageDraft = createImageWorkspaceDraft({
      ...createEmptyImageWorkspaceDraft({
        id: toDraftId('draft-vidu-e2e-image'),
        projectId,
        mode: 'quick_image',
        createdAt: timestamp
      }),
      state: 'saved',
      prompt: {
        originalInput: 'Create a synthetic image',
        systemSupplements: [],
        finalPrompt: 'Create a synthetic image'
      }
    });
    await new JsonImageWorkspaceRepository(storage, projectId).save(imageDraft);
    const imageUrl =
      'https://results.synthetic.invalid/generated.png?signature=private';
    fixture.service.registerDownload(imageUrl, pngBytes(640, 360), 'image/png');

    const imageTaskResult = await imageController.createTask({
      draftId: imageDraft.id,
      draftUpdatedAt: imageDraft.updatedAt,
      modelId: fixture.imageV1Model.id,
      confirmations: imageConfirmations
    });
    expect(imageTaskResult).toMatchObject({ ok: true });
    await expect(
      imageController.createExecution({ taskId: 'task-vidu-e2e-image' })
    ).resolves.toMatchObject({ ok: true, value: { state: 'created' } });
    await expect(
      imageController.invokeExecution({ executionId: 'execution-vidu-e2e-image' })
    ).resolves.toMatchObject({ ok: true, value: { state: 'remote_completed' } });
    const imageWork = await imageController.receiveResult({
      executionId: 'execution-vidu-e2e-image'
    });
    if (!imageWork.ok) {
      throw new Error(
        `Synthetic image result failed: ${JSON.stringify(imageWork.error)} / ${String(imageResultError)}`
      );
    }
    expect(imageWork).toMatchObject({
      ok: true,
      value: { workId: 'work-vidu-e2e-image' }
    });

    const videoWorkspace = new VideoWorkspaceController({
      getSession: session,
      mutations: videoMutations,
      createDraftId: () => 'draft-vidu-e2e-video',
      now: workflowNow
    });
    const createdVideoDraft = await videoWorkspace.createFromImageWork({
      workId: 'work-vidu-e2e-image'
    });
    if (!createdVideoDraft.ok || createdVideoDraft.value.mode !== 'image_to_video') {
      throw new Error('Synthetic image Work did not create a video draft');
    }
    const source = createdVideoDraft.value.imageToVideo.source;
    if (!source) throw new Error('Synthetic video draft source is missing');
    const updatedVideoDraft = await videoWorkspace.update({
      draft: {
        ...createdVideoDraft.value,
        state: 'saved',
        prompt: {
          originalInput: 'Animate the verified image',
          systemSupplements: [],
          finalPrompt: 'Animate the verified image'
        },
        generation: {
          ...createdVideoDraft.value.generation,
          model: {
            modelId: fixture.videoModel.id,
            capabilityEvidenceId: fixture.referenceVideoEvidence.id
          },
          parameters: {
            capabilityEvidenceId: fixture.referenceVideoEvidence.id,
            values: { audio: false, duration: 2 }
          }
        },
        imageToVideo: {
          ...createdVideoDraft.value.imageToVideo,
          materials: {
            capabilityEvidenceId: fixture.referenceVideoEvidence.id,
            slots: [{
              id: 'reference',
              role: 'reference',
              required: true,
              acceptedMediaKinds: ['image'],
              selection: source
            }]
          }
        }
      }
    });
    if (!updatedVideoDraft.ok) {
      throw new Error(`Synthetic video draft update failed: ${updatedVideoDraft.error.code}`);
    }

    const videoReceiver = new LocalVideoResultReceiver({
      getSession: session,
      mutations: videoMutations,
      port: fixture.videoAdapter,
      createFileId: () => 'file-vidu-e2e-video',
      createWorkId: () => 'work-vidu-e2e-video',
      now: workflowNow
    });
    const videoController = new VideoSubmissionController({
      getSession: session,
      providerRegistry: fixture.registry,
      mutations: videoMutations,
      operationPort: routerVideoPort(fixture.videoRouter),
      asyncOperationPort: fixture.videoAdapter,
      resultReceiver: videoReceiver,
      createTaskId: () => 'task-vidu-e2e-video',
      createExecutionId: () => 'execution-vidu-e2e-video',
      createProviderOperationRecordId: () => 'operation-record-vidu-e2e-video',
      now: workflowNow
    });
    await expect(
      videoController.preflight({ draftId: updatedVideoDraft.value.draftId })
    ).resolves.toMatchObject({
      ok: true,
      value: {
        blockers: [],
        candidates: [{
          modelId: fixture.videoModel.id,
          capabilityEvidenceId: fixture.referenceVideoEvidence.id,
          blockers: []
        }]
      }
    });
    await expect(
      videoController.createTask({
        draftId: updatedVideoDraft.value.draftId,
        draftUpdatedAt: updatedVideoDraft.value.updatedAt,
        modelId: fixture.videoModel.id,
        confirmations: videoConfirmations
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      videoController.createExecution({ taskId: 'task-vidu-e2e-video' })
    ).resolves.toMatchObject({ ok: true, value: { state: 'created' } });
    await expect(
      videoController.invokeExecution({ executionId: 'execution-vidu-e2e-video' })
    ).resolves.toMatchObject({ ok: true, value: { state: 'queued' } });
    await expect(
      videoController.refreshExecution({ executionId: 'execution-vidu-e2e-video' })
    ).resolves.toMatchObject({
      ok: true,
      value: { state: 'remote_completed' }
    });
    fixture.service.registerDownload(
      'https://results.synthetic.invalid/generated.mp4?signature=private',
      isoBmffVideo(),
      'video/mp4'
    );
    const videoWork = await videoController.receiveResult({
      executionId: 'execution-vidu-e2e-video'
    });
    expect(videoWork).toMatchObject({
      ok: true,
      value: {
        works: [{ workId: 'work-vidu-e2e-video' }]
      }
    });

    const works = await new JsonWorkRepository(storage, projectId).list(projectId);
    expect(works.map((work) => work.mediaKind).sort()).toEqual(['image', 'video']);
    const rendererFacts = JSON.stringify({
      imageTaskResult,
      imageWork,
      createdVideoDraft,
      updatedVideoDraft,
      videoWork
    });
    expect(rendererFacts).not.toContain(validToken);
    expect(rendererFacts).not.toContain('synthetic-video-task');
    expect(rendererFacts).not.toContain('signature=private');
    expect(rendererFacts).not.toContain(fixture.root);
    expect(rendererFacts).not.toMatch(/[a-f0-9]{64}/);

    const operationFile = await readFile(
      path.join(fixture.root, 'entities', 'provider-operations.json'),
      'utf8'
    );
    expect(operationFile).not.toContain(validToken);
  });
});

async function createProtocolFixture(
  clock: { value: number } = { value: Date.parse(timestamp) },
  useProjectMaterials = false
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-e2e-'));
  roots.push(root);
  const service = new SyntheticViduService(validToken);
  const safeLogs: ViduSafeLogEvent[] = [];
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  await vault.save('credential-vidu-synthetic', validToken);
  const frozen = createUserViduRegistryRecords();
  const provider = createProvider({
    ...frozen.providers[0],
    identityState: 'verified',
    updatedAt: timestamp
  });
  const connection = createProviderConnection({
    ...frozen.connections[0],
    endpoint: 'https://api.vidu.cn',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-vidu-synthetic',
    updatedAt: timestamp
  });
  const bindings = frozen.protocolBindings.map((binding) =>
    createProviderProtocolBinding({
      ...binding,
      authScheme: 'token',
      updatedAt: timestamp
    })
  );
  const imageV1Binding = bindingByProtocol(bindings, 'vidu.ent.v1.images');
  const geminiBinding = bindingByProtocol(
    bindings,
    'vidu.ent.v2.image.reference2image'
  );
  const videoBinding = bindingByProtocol(
    bindings,
    'vidu.ent.v2.reference2video'
  );
  const frozenImageV1 = modelByKey(frozen.models, 'viduimage-2');
  const frozenGemini = modelByKey(frozen.models, 'q3-fast');
  const frozenVideo = modelByKey(frozen.models, 'viduq3-drama');
  const imageGenerationEvidence = imageEvidence(
    frozenImageV1,
    'image_generation',
    'evidence-vidu-e2e-image-generation'
  );
  const imageEditingEvidence = imageEvidence(
    frozenImageV1,
    'image_editing',
    'evidence-vidu-e2e-image-editing'
  );
  const referenceImageEvidence = imageEvidence(
    frozenGemini,
    'reference_to_image',
    'evidence-vidu-e2e-reference-image'
  );
  const referenceVideoEvidence = createModelCapabilityEvidence({
    id: toCapabilityEvidenceId('evidence-vidu-e2e-reference-video'),
    modelId: frozenVideo.id,
    revision: 1,
    capability: 'reference_to_video',
    state: 'verified_supported',
    source: 'connection_verified',
    parameterSchema: {
      schemaVersion: 1,
      fields: [
        { key: 'audio', label: 'Audio', kind: 'boolean', required: true },
        {
          key: 'duration',
          label: 'Duration',
          kind: 'integer',
          required: true,
          minimum: 2,
          maximum: 15
        }
      ]
    },
    videoGenerationSchema: {
      schemaVersion: 1,
      modes: [{
        mode: 'image_to_video',
        materialSlots: [{
          id: 'reference',
          role: 'reference',
          required: true,
          acceptedMediaKinds: ['image']
        }]
      }]
    },
    observedAt: timestamp,
    recordedAt: timestamp
  });
  const imageV1Model = enabledModel(
    frozenImageV1,
    imageV1Binding,
    imageGenerationEvidence
  );
  const geminiModel = enabledModel(
    frozenGemini,
    geminiBinding,
    referenceImageEvidence
  );
  const videoModel = enabledModel(
    frozenVideo,
    videoBinding,
    referenceVideoEvidence
  );
  const registry = new JsonProviderRegistryStore(path.join(root, 'providers.json'));
  await registry.save({
    schemaVersion: 2,
    providers: [provider],
    connections: [connection],
    protocolBindings: bindings,
    models: [imageV1Model, geminiModel, videoModel],
    capabilities: [
      imageGenerationEvidence,
      imageEditingEvidence,
      referenceImageEvidence,
      referenceVideoEvidence
    ],
    routingPreferences: [
      route('route-vidu-e2e-image-generation', 'image_generation', imageV1Model),
      route('route-vidu-e2e-image-editing', 'image_editing', imageV1Model),
      route('route-vidu-e2e-reference-image', 'reference_to_image', geminiModel),
      route('route-vidu-e2e-video', 'video_generation', videoModel)
    ]
  });
  const materials: ControlledImageMaterialPort = useProjectMaterials
    ? new ProjectImageMaterialResolver({
        getSession: () => ({
          projectId,
          projectName: 'Synthetic Vidu project',
          rootDirectory: root
        })
      })
    : new StaticMaterialPort();
  const providerPackage = new ViduProviderPackage({
    credentialVault: vault,
    transport: service,
    logger: (event) => safeLogs.push(event),
    now: () => clock.value
  });
  const connections = { get: async () => connection };
  const imageAdapters = providerPackage.createImageAdapters({
    connections,
    materials,
    imageV1: {
      imageInputShape: 'string_array',
      base64Encoding: 'data_url'
    },
    createProviderOperationId: sequentialId('synthetic-image-operation')
  });
  const videoAdapter = providerPackage.createVideoAdapter({
    connections,
    materials,
    operationContext: staticVideoContext(connection.id, videoBinding),
    now: () => clock.value
  });
  const imageRouter = new ImageOperationRouter(registry, {
    vidu_image_v1: imageAdapters.imageV1,
    vidu_gemini_image_v2: imageAdapters.geminiImageV2
  });
  const videoRouter = new VideoOperationRouter(registry, {
    vidu_reference_video_v2: videoAdapter
  });
  return {
    root,
    service,
    safeLogs,
    providerPackage,
    connection,
    registry,
    materials,
    imageV1Binding,
    geminiBinding,
    videoBinding,
    imageV1Model,
    geminiModel,
    videoModel,
    imageGenerationEvidence,
    imageEditingEvidence,
    referenceImageEvidence,
    referenceVideoEvidence,
    imageRouter,
    videoRouter,
    videoAdapter
  };
}

function imageEvidence(
  model: ProviderModel,
  capability: 'image_generation' | 'image_editing' | 'reference_to_image',
  id: string
): ModelCapabilityEvidence {
  return createModelCapabilityEvidence({
    id: toCapabilityEvidenceId(id),
    modelId: model.id,
    revision: 1,
    capability,
    state: 'verified_supported',
    source: 'connection_verified',
    parameterSchema: { schemaVersion: 1, fields: [] },
    observedAt: timestamp,
    recordedAt: timestamp
  });
}

function enabledModel(
  model: ProviderModel,
  binding: ProviderProtocolBinding,
  evidence: ModelCapabilityEvidence
): ProviderModel {
  return createProviderModel({
    ...model,
    protocolBindingId: binding.id,
    capabilityEvidenceId: evidence.id,
    enabled: true,
    updatedAt: timestamp
  });
}

function route(id: string, purpose: string, model: ProviderModel) {
  return createRoutingPreference({
    id: toRoutingPreferenceId(id),
    purpose,
    modelId: model.id,
    priority: 0,
    enabled: true,
    updatedAt: timestamp
  });
}

function imageTask(
  model: ProviderModel,
  evidence: ModelCapabilityEvidence,
  purpose: 'image_generation' | 'image_editing' | 'reference_to_image'
): Task {
  const hasInput = purpose !== 'image_generation';
  const kind = purpose === 'image_editing' ? 'image_editing' : 'image_generation';
  return {
    schemaVersion: 1,
    id: toTaskId(`task-vidu-e2e-${purpose}`),
    projectId,
    sourceDraftId: toDraftId(`draft-vidu-e2e-${purpose}`),
    submission: {
      kind,
      prompt: {
        originalInput: 'Synthetic image request',
        systemSupplements: [],
        finalPrompt: 'Synthetic image request'
      },
      assetIds: hasInput ? [imageAssetId] : [],
      confirmedAt: timestamp,
      image: {
        mode: purpose === 'image_editing' ? 'image_editing' : 'quick_image',
        purpose,
        modelId: model.id,
        capabilityEvidenceId: evidence.id,
        providerId: model.providerId,
        connectionId: model.connectionId,
        recipientName: 'Vidu synthetic service',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: {},
        confirmations: imageConfirmations
      }
    },
    executionIds: [],
    createdAt: timestamp
  };
}

function videoTask(
  model: ProviderModel,
  evidence: ModelCapabilityEvidence
): Task {
  return {
    schemaVersion: 1,
    id: toTaskId('task-vidu-e2e-reference-video'),
    projectId,
    sourceDraftId: toDraftId('draft-vidu-e2e-reference-video'),
    submission: {
      kind: 'video_generation',
      prompt: {
        originalInput: 'Synthetic video request',
        systemSupplements: [],
        finalPrompt: 'Synthetic video request'
      },
      assetIds: [imageAssetId],
      confirmedAt: timestamp,
      video: {
        mode: 'image_to_video',
        purpose: 'video_generation',
        modelId: model.id,
        capabilityEvidenceId: evidence.id,
        providerId: model.providerId,
        connectionId: model.connectionId,
        recipientName: 'Vidu synthetic service',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters: { audio: false, duration: 2 },
        materials: [{
          assetId: imageAssetId,
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
        confirmations: videoConfirmations
      }
    },
    executionIds: [],
    createdAt: timestamp
  };
}

function submittingExecution(task: Task) {
  return transitionExecution(
    createExecution({
      id: toExecutionId(`execution-${task.id}`),
      taskId: task.id,
      createdAt: timestamp
    }),
    'submitting',
    timestamp
  );
}

function routerImagePort(router: ImageOperationRouter) {
  return {
    submit: async (request: Pick<ProviderProtocolSubmitRequest, 'task' | 'execution'>) => {
      const result = await router.submit(request);
      if (!result.ok) {
        throw new ImageOperationPortError('not_retryable', result.error.message);
      }
      return result.value;
    }
  };
}

function routerVideoPort(router: VideoOperationRouter) {
  return {
    submit: async (request: Pick<ProviderProtocolSubmitRequest, 'task' | 'execution'>) => {
      const result = await router.submit(request);
      if (!result.ok) {
        throw new VideoOperationPortError('not_retryable', result.error.message);
      }
      return result.value;
    }
  };
}

function staticVideoContext(
  connectionId: string,
  binding: ProviderProtocolBinding
): ViduVideoOperationContextPort {
  const remembered = new Map<string, ViduVideoOperationContext>();
  return {
    remember: (taskId: string, context: ViduVideoOperationContext) => {
      remembered.set(taskId, context);
    },
    resolve: async (taskId: string) =>
      remembered.get(taskId) ?? { connectionId, binding }
  };
}

function bindingByProtocol(
  bindings: readonly ProviderProtocolBinding[],
  protocolId: string
): ProviderProtocolBinding {
  const binding = bindings.find((candidate) => candidate.protocolId === protocolId);
  if (!binding) throw new Error(`Missing synthetic binding: ${protocolId}`);
  return binding;
}

function modelByKey(
  models: readonly ProviderModel[],
  providerModelKey: string
): ProviderModel {
  const model = models.find(
    (candidate) => candidate.providerModelKey === providerModelKey
  );
  if (!model) throw new Error(`Missing synthetic model: ${providerModelKey}`);
  return model;
}

class StaticMaterialPort implements ControlledImageMaterialPort {
  async resolve(): Promise<ControlledImageMaterial> {
    const bytes = pngBytes(16, 9);
    return {
      assetId: imageAssetId,
      mimeType: 'image/png',
      width: 16,
      height: 9,
      sizeBytes: bytes.byteLength,
      base64: bytes.toString('base64')
    };
  }
}

const imageConfirmations = {
  recipient: true,
  outboundScope: true,
  cost: true,
  finalPrompt: true,
  model: true
} as const;

const videoConfirmations = {
  recipient: true,
  outboundScope: true,
  materials: true,
  costPrivacyRegion: true,
  finalPrompt: true,
  model: true
} as const;

function reversibleProtector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from(value, 'utf8'),
    unprotect: (value) => Buffer.from(value).toString('utf8')
  };
}

function sequentialId(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function sequentialClock(): () => string {
  let value = Date.parse(timestamp);
  return () => new Date(value += 1_000).toISOString();
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
