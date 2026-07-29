import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExecution,
  createProviderConnection,
  toAssetId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  transitionExecution,
  type ModelCapabilityEvidence,
  type ProviderModel,
  type ProviderProtocolBinding,
  type Task,
  type VideoDynamicParameterValue
} from '../../src/domain';
import {
  createFrozenViduRegistryRecords,
  SecureCredentialVault,
  ViduBoundedPoller,
  ViduReferenceVideoV2Adapter,
  ViduRuntimeError,
  ViduSharedRuntime,
  ViduTransportFailure,
  VideoResultPortError,
  type ControlledImageMaterial,
  type ControlledImageMaterialPort,
  type CredentialProtector,
  type ProviderAsyncOperationPort,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse
} from '../../src/platform';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-29T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Vidu Q3 reference video adapter', () => {
  it('submits one controlled image with explicit audio and an approved model duration', async () => {
    const fixture = await createFixture();
    fixture.transport.responses.push(jsonResponse(200, { task_id: 'task-q3-remote' }));

    await expect(
      fixture.adapter.submit(submitRequest(fixture, {
        audio: true,
        duration: 2,
        resolution: '1080p',
        aspect_ratio: '16:9'
      }))
    ).resolves.toEqual({
      kind: 'accepted_async',
      providerOperationId: 'task-q3-remote',
      state: 'queued'
    });

    expect(fixture.materials.calls).toBe(1);
    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.vidu.cn/ent/v2/reference2video'
    });
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      model: 'viduq3-drama',
      images: ['data:image/png;base64,c3ludGhldGljLWlucHV0'],
      prompt: 'Create a synthetic reference video',
      audio: true,
      duration: 2,
      resolution: '1080p',
      aspect_ratio: '16:9'
    });
  });

  it('rejects unsupported models, parameters, durations and oversized bodies before HTTP', async () => {
    const fixture = await createFixture();

    const unsupportedModel = submitRequest(fixture, { duration: 3 });
    const model = {
      ...unsupportedModel.model,
      providerModelKey: 'unapproved-q3-model'
    } as ProviderModel;
    await expect(
      fixture.adapter.submit({ ...unsupportedModel, model })
    ).resolves.toMatchObject({
      kind: 'failed_before_submission',
      retryability: 'not_retryable'
    });

    await expect(
      fixture.adapter.submit(submitRequest(fixture, { movement_amplitude: 'auto' }))
    ).resolves.toMatchObject({ kind: 'failed_before_submission' });
    await expect(
      fixture.adapter.submit(submitRequest(fixture, { duration: 16 }))
    ).resolves.toMatchObject({ kind: 'failed_before_submission' });

    fixture.materials.material = {
      ...fixture.materials.material,
      base64: 'A'.repeat(20 * 1024 * 1024)
    };
    await expect(
      fixture.adapter.submit(submitRequest(fixture, {}))
    ).resolves.toMatchObject({ kind: 'failed_before_submission' });
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it('treats lost transport and malformed post-submit responses as unknown outcomes', async () => {
    const fixture = await createFixture();
    fixture.transport.failures.push(new ViduTransportFailure('timeout'));
    await expect(
      fixture.adapter.submit(submitRequest(fixture, {}))
    ).resolves.toEqual({
      kind: 'submission_outcome_unknown',
      message: 'The Vidu video submission outcome is unknown'
    });

    fixture.transport.responses.push(jsonResponse(200, { unexpected: true }));
    await expect(
      fixture.adapter.submit(submitRequest(fixture, {}))
    ).resolves.toEqual({
      kind: 'submission_outcome_unknown',
      message: 'The Vidu video submission outcome is unknown'
    });
    expect(fixture.transport.requests).toHaveLength(2);
  });

  it('maps every official task state and accepts only an empty cancellation response', async () => {
    const fixture = await createFixture();
    for (const [state, expected] of [
      ['created', 'queued'],
      ['queueing', 'queued'],
      ['processing', 'processing']
    ] as const) {
      fixture.transport.responses.push(jsonResponse(200, { state }));
      await expect(fixture.adapter.query('task-q3-remote')).resolves.toEqual({
        state: expected
      });
    }
    fixture.transport.responses.push(jsonResponse(200, { state: 'failed' }));
    await expect(fixture.adapter.query('task-q3-remote')).resolves.toMatchObject({
      state: 'failed',
      retryability: 'not_retryable'
    });
    fixture.transport.responses.push(jsonResponse(200, {}));
    await expect(fixture.adapter.cancel('task-q3-remote')).resolves.toEqual({
      state: 'cancelled'
    });
    fixture.transport.responses.push(jsonResponse(200, { state: 'processing' }));
    await expect(fixture.adapter.cancel('task-q3-remote')).resolves.toEqual({
      state: 'processing'
    });
  });

  it('uses bounded exponential backoff for retryable polling failures', async () => {
    const statuses: Array<'retry' | 'queued' | 'processing' | 'completed'> = [
      'retry',
      'queued',
      'processing',
      'completed'
    ];
    const delays: number[] = [];
    const operations: ProviderAsyncOperationPort = {
      query: async () => {
        const status = statuses.shift();
        if (status === 'retry') {
          throw new ViduRuntimeError('rate_limited', 'retryable', 1_000);
        }
        return { state: status ?? 'completed' };
      },
      cancel: async () => ({ state: 'cancelled' })
    };
    const poller = new ViduBoundedPoller(operations, {
      maximumAttempts: 5,
      initialDelayMs: 100,
      maximumDelayMs: 250,
      jitterRatio: 0,
      wait: async (delay) => { delays.push(delay); }
    });

    await expect(poller.poll('task-q3-remote')).resolves.toEqual({
      state: 'completed'
    });
    expect(delays).toEqual([100, 200, 250]);
  });

  it('rediscovers results after restart and downloads only controlled HTTPS video bytes', async () => {
    const first = await createFixture();
    first.transport.responses.push(
      successResponse(),
      successResponse(),
      videoResponse('synthetic-video')
    );
    const descriptors = await first.adapter.listResults('task-q3-remote');
    expect(descriptors).toEqual([{
      remoteResultId: 'creation-q3-one',
      name: 'vidu-video-creation-q3-one'
    }]);
    await expect(readAll(
      await first.adapter.openDownload('task-q3-remote', 'creation-q3-one')
    )).resolves.toEqual(Buffer.from('synthetic-video'));

    const restarted = new ViduReferenceVideoV2Adapter(first.dependencies);
    first.transport.responses.push(successResponse());
    await expect(restarted.listResults('task-q3-remote')).resolves.toHaveLength(1);
    expect(first.transport.requests.filter((request) =>
      request.url.endsWith('/ent/v2/tasks/task-q3-remote/creations')
    )).toHaveLength(3);
  });

  it('rejects expired, insecure and falsely typed result downloads', async () => {
    let now = 1_000;
    const fixture = await createFixture({ now: () => now });
    fixture.transport.responses.push(successResponse(), successResponse());
    await fixture.adapter.listResults('task-q3-remote');
    now += 24 * 60 * 60 * 1_000;
    await expect(
      fixture.adapter.openDownload('task-q3-remote', 'creation-q3-one')
    ).rejects.toMatchObject({
      name: 'VideoResultPortError',
      retryability: 'not_retryable'
    });

    const insecure = await createFixture();
    insecure.transport.responses.push(jsonResponse(200, {
      state: 'success',
      creations: [{ id: 'creation-q3-one', url: 'http://cdn.invalid/video.mp4' }]
    }));
    await expect(insecure.adapter.query('task-q3-remote')).rejects.toBeInstanceOf(
      ViduRuntimeError
    );

    const falseMime = await createFixture();
    falseMime.transport.responses.push(successResponse(), successResponse(), {
      ...videoResponse('not-video'),
      headers: { 'content-type': 'text/html' }
    });
    await falseMime.adapter.listResults('task-q3-remote');
    await expect(
      falseMime.adapter.openDownload('task-q3-remote', 'creation-q3-one')
    ).rejects.toBeInstanceOf(VideoResultPortError);
  });
});

async function createFixture(options: { readonly now?: () => number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-video-'));
  roots.push(root);
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  await vault.save('credential-vidu-video', 'synthetic-token');
  const frozen = createFrozenViduRegistryRecords();
  const binding = frozen.protocolBindings[0];
  const model = frozen.models.find((candidate) =>
    candidate.providerModelKey === 'viduq3-drama'
  )!;
  const evidence = frozen.capabilities.find((candidate) =>
    candidate.id === model.capabilityEvidenceId
  )!;
  const connection = createProviderConnection({
    ...frozen.connections[0],
    endpoint: 'https://api.vidu.cn',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-vidu-video',
    updatedAt: timestamp
  });
  const transport = new FixtureTransport();
  const materials = new FixtureMaterialPort();
  const dependencies = {
    runtime: new ViduSharedRuntime({ credentialVault: vault, transport }),
    connections: { get: async () => connection },
    materials,
    binding,
    connectionId: connection.id,
    now: options.now
  };
  return {
    adapter: new ViduReferenceVideoV2Adapter(dependencies),
    binding,
    dependencies,
    evidence,
    materials,
    model,
    transport
  };
}

function submitRequest(
  fixture: {
    readonly binding: ProviderProtocolBinding;
    readonly evidence: ModelCapabilityEvidence;
    readonly model: ProviderModel;
  },
  parameters: Readonly<Record<string, VideoDynamicParameterValue>>
) {
  const task = videoTask(fixture, parameters);
  const execution = transitionExecution(
    createExecution({
      id: toExecutionId('execution-vidu-video'),
      taskId: task.id,
      createdAt: timestamp
    }),
    'submitting',
    timestamp
  );
  return {
    task,
    execution,
    model: fixture.model,
    binding: fixture.binding,
    evidence: fixture.evidence
  };
}

function videoTask(
  fixture: {
    readonly evidence: ModelCapabilityEvidence;
    readonly model: ProviderModel;
  },
  parameters: Readonly<Record<string, VideoDynamicParameterValue>>
): Task {
  const assetId = toAssetId('asset-controlled-input');
  return {
    schemaVersion: 1,
    id: toTaskId('task-vidu-video'),
    projectId: toProjectId('project-vidu-video'),
    sourceDraftId: toDraftId('draft-vidu-video'),
    submission: {
      kind: 'video_generation',
      prompt: {
        originalInput: 'Create a synthetic reference video',
        systemSupplements: [],
        finalPrompt: 'Create a synthetic reference video'
      },
      assetIds: [assetId],
      confirmedAt: timestamp,
      video: {
        mode: 'image_to_video',
        purpose: 'video_generation',
        modelId: fixture.model.id,
        capabilityEvidenceId: fixture.evidence.id,
        providerId: fixture.model.providerId,
        connectionId: fixture.model.connectionId,
        recipientName: 'Vidu synthetic fixture',
        accessCategory: 'online',
        outboundScope: 'external_service',
        costState: 'unknown',
        privacyState: 'unknown',
        regionState: 'unknown',
        parameters,
        materials: [{
          assetId,
          mediaKind: 'image',
          role: 'reference',
          target: { kind: 'quick_reference' }
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
    executionIds: [],
    createdAt: timestamp
  };
}

class FixtureMaterialPort implements ControlledImageMaterialPort {
  calls = 0;
  material = controlledMaterial();

  async resolve(): Promise<ControlledImageMaterial> {
    this.calls += 1;
    return this.material;
  }
}

function controlledMaterial(): ControlledImageMaterial {
  return {
    assetId: toAssetId('asset-controlled-input'),
    mimeType: 'image/png',
    width: 1,
    height: 1,
    sizeBytes: 15,
    base64: Buffer.from('synthetic-input').toString('base64')
  };
}

class FixtureTransport implements ViduHttpTransport {
  readonly requests: ViduHttpTransportRequest[] = [];
  readonly responses: ViduHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse> {
    this.requests.push(request);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return this.responses.shift() ?? jsonResponse(200, {});
  }
}

function jsonResponse(status: number, value: unknown): ViduHttpTransportResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.byteLength)
    },
    body
  };
}

function successResponse(): ViduHttpTransportResponse {
  return jsonResponse(200, {
    state: 'success',
    creations: [{
      id: 'creation-q3-one',
      url: 'https://cdn.synthetic.invalid/video.mp4'
    }]
  });
}

function videoResponse(value: string): ViduHttpTransportResponse {
  const body = Buffer.from(value);
  return {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(body.byteLength)
    },
    body
  };
}

function bodyOf(request: ViduHttpTransportRequest): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function reversibleProtector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from(value, 'utf8'),
    unprotect: (value) => Buffer.from(value).toString('utf8')
  };
}
