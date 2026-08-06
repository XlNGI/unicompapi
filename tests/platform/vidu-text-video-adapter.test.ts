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
  SecureCredentialVault,
  ViduTextVideoV2Adapter,
  ViduSharedRuntime,
  type CredentialProtector,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse,
  type ViduVideoOperationContext
} from '../../src/platform';
import { createUserViduRegistryRecords } from '../fixtures/vidu-user-registry';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-08-06T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Vidu official text2video adapter', () => {
  it('submits prompt-only text2video for viduq3-pro with official defaults', async () => {
    const fixture = await createFixture();
    fixture.transport.responses.push(jsonResponse(200, { task_id: 'task-t2v-remote' }));

    await expect(
      fixture.adapter.submit(submitRequest(fixture, {
        audio: true,
        duration: 5,
        resolution: '720p',
        aspect_ratio: '16:9'
      }))
    ).resolves.toEqual({
      kind: 'accepted_async',
      providerOperationId: 'task-t2v-remote',
      state: 'queued'
    });

    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.vidu.cn/ent/v2/text2video'
    });
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      model: 'viduq3-pro',
      prompt: 'Create a synthetic text video',
      audio: true,
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9'
    });
  });

  it('rejects materials, unsupported models and out-of-range durations before HTTP', async () => {
    const fixture = await createFixture();
    const withMaterial = submitRequest(fixture, {});
    const video = withMaterial.task.submission.video!;
    const assetId = toAssetId('asset-unexpected');
    await expect(
      fixture.adapter.submit({
        ...withMaterial,
        task: {
          ...withMaterial.task,
          submission: {
            ...withMaterial.task.submission,
            assetIds: [assetId],
            video: {
              ...video,
              materials: [{
                assetId,
                mediaKind: 'image',
                role: 'reference',
                target: { kind: 'quick_reference' }
              }]
            }
          }
        }
      })
    ).resolves.toMatchObject({ kind: 'failed_before_submission' });

    const unsupported = submitRequest(fixture, { duration: 5 });
    await expect(
      fixture.adapter.submit({
        ...unsupported,
        model: {
          ...unsupported.model,
          providerModelKey: 'viduq3-drama'
        } as ProviderModel
      })
    ).resolves.toMatchObject({ kind: 'failed_before_submission' });

    await expect(
      fixture.adapter.submit(submitRequest(fixture, { duration: 20 }))
    ).resolves.toMatchObject({ kind: 'failed_before_submission' });
    expect(fixture.transport.requests).toHaveLength(0);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-text-video-'));
  roots.push(root);
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  await vault.save('credential-vidu-text-video', 'synthetic-token');
  const frozen = createUserViduRegistryRecords();
  const binding = frozen.protocolBindings.find(
    (item) => item.adapterKind === 'vidu_text_video_v2'
  )!;
  const model = frozen.models.find((candidate) =>
    candidate.providerModelKey === 'viduq3-pro'
  )!;
  const evidence = frozen.capabilities.find((candidate) =>
    candidate.modelId === model.id && candidate.capability === 'video_generation'
  )!;
  const connection = createProviderConnection({
    ...frozen.connections[0],
    endpoint: 'https://api.vidu.cn',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-vidu-text-video',
    updatedAt: timestamp
  });
  const transport = new FixtureTransport();
  const operationContexts = new Map<string, ViduVideoOperationContext>();
  const dependencies = {
    runtime: new ViduSharedRuntime({ credentialVault: vault, transport }),
    connections: { get: async () => connection },
    operationContext: {
      remember: (taskId: string, context: ViduVideoOperationContext) => {
        operationContexts.set(taskId, context);
      },
      resolve: async (taskId: string) =>
        operationContexts.get(taskId) ?? { connectionId: connection.id, binding }
    }
  };
  return {
    adapter: new ViduTextVideoV2Adapter(dependencies),
    binding,
    evidence,
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
      id: toExecutionId('execution-vidu-text-video'),
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
  return {
    schemaVersion: 1,
    id: toTaskId('task-vidu-text-video'),
    projectId: toProjectId('project-vidu-text-video'),
    sourceDraftId: toDraftId('draft-vidu-text-video'),
    submission: {
      kind: 'video_generation',
      prompt: {
        originalInput: 'Create a synthetic text video',
        systemSupplements: [],
        finalPrompt: 'Create a synthetic text video'
      },
      assetIds: [],
      confirmedAt: timestamp,
      video: {
        mode: 'text_to_video',
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
        materials: [],
        contextReferences: [],
        input: {
          mode: 'text_to_video',
          sourceKind: 'short_idea',
          shots: []
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

class FixtureTransport implements ViduHttpTransport {
  readonly requests: ViduHttpTransportRequest[] = [];
  readonly responses: ViduHttpTransportResponse[] = [];

  async send(request: ViduHttpTransportRequest): Promise<ViduHttpTransportResponse> {
    this.requests.push(request);
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

function bodyOf(request: ViduHttpTransportRequest): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}

function reversibleProtector(): CredentialProtector {
  return {
    isAvailable: () => true,
    protect: (value) => Buffer.from(value, 'utf8'),
    unprotect: (value) => Buffer.from(value).toString('utf8')
  };
}
