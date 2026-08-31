import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createExecution,
  createProviderConnection,
  createProviderProtocolBinding,
  toAssetId,
  toDraftId,
  toExecutionId,
  toIsoTimestamp,
  toProjectId,
  toTaskId,
  transitionExecution,
  type DynamicParameterValue,
  type ModelCapabilityEvidence,
  type ProviderModel,
  type ProviderProtocolBinding,
  type Task
} from '../../src/domain';
import {
  SecureCredentialVault,
  ViduGeminiImageV2Adapter,
  ViduImageV1Adapter,
  ViduSharedRuntime,
  ViduTransportFailure,
  type ControlledImageMaterial,
  type ControlledImageMaterialPort,
  type CredentialProtector,
  type ViduHttpTransport,
  type ViduHttpTransportRequest,
  type ViduHttpTransportResponse
} from '../../src/platform';
import { createUserViduRegistryRecords, VIDU_USER_PROTOCOL_BINDING_IDS } from '../fixtures/vidu-user-registry';

const roots: string[] = [];
const timestamp = toIsoTimestamp('2026-07-29T00:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('Vidu synchronous image adapters', () => {
  it('submits Image V1 generations with one output and parses a URL receipt', async () => {
    const fixture = await createFixture('imageV1');
    fixture.transport.responses.push(jsonResponse({
      data: [{ url: 'https://cdn.synthetic.invalid/result.png', b64_json: '' }],
      output_format: 'png',
      task_id: 'remote-fact-not-used-as-local-id'
    }));
    const adapter = imageV1Adapter(fixture);
    const request = submitRequest(fixture, 'image_generation', [], {
      response_format: 'url'
    });

    await expect(adapter.submit(request)).resolves.toEqual({
      kind: 'completed_sync',
      providerOperationId: 'local-image-operation',
      results: [{
        kind: 'remote_url',
        value: 'https://cdn.synthetic.invalid/result.png'
      }]
    });
    expect(fixture.materials.calls).toBe(0);
    expect(fixture.transport.requests).toHaveLength(1);
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      prompt: 'Create a synthetic image',
      response_format: 'url',
      n: 1
    });
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.vidu.cn/ent/v1/images/generations'
    });
  });

  it('revalidates one controlled input for Image V1 edits and never enables batches', async () => {
    const fixture = await createFixture('imageV1');
    fixture.transport.responses.push(jsonResponse({
      data: [{ b64_json: Buffer.from('synthetic-result').toString('base64') }],
      output_format: 'png'
    }));
    const adapter = imageV1Adapter(fixture);
    const request = submitRequest(
      fixture,
      'image_editing',
      [toAssetId('asset-controlled-input')],
      { n: 1, input_fidelity: 'high' }
    );

    await expect(adapter.submit(request)).resolves.toMatchObject({
      kind: 'completed_sync',
      results: [{ kind: 'base64', mimeType: 'image/png' }]
    });
    expect(fixture.materials.calls).toBe(1);
    expect(bodyOf(fixture.transport.requests[0])).toMatchObject({
      images: [{ image_url: 'data:image/png;base64,c3ludGhldGljLWlucHV0' }],
      n: 1,
      input_fidelity: 'high'
    });

    const batched = submitRequest(
      fixture,
      'image_editing',
      [toAssetId('asset-one'), toAssetId('asset-two')],
      {}
    );
    await expect(adapter.submit(batched)).resolves.toMatchObject({
      kind: 'failed_before_submission',
      retryability: 'not_retryable'
    });
    expect(fixture.transport.requests).toHaveLength(1);
  });

  it('rejects Image V1 when the protocol binding is not bearer', async () => {
    const fixture = await createFixture('imageV1', { verifiedImageV1Auth: false });
    const adapter = new ViduImageV1Adapter(fixture.dependencies);

    await expect(
      adapter.submit(submitRequest(fixture, 'image_generation', [], {}))
    ).resolves.toEqual({
      kind: 'failed_before_submission',
      message: 'The Image V1 authorization scheme must be bearer',
      retryability: 'not_retryable'
    });
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it('sends Image V1 requests with Bearer authorization', async () => {
    const fixture = await createFixture('imageV1');
    fixture.transport.responses.push(jsonResponse({
      data: [{ url: 'https://cdn.synthetic.invalid/result.png' }],
      output_format: 'png'
    }));
    const adapter = imageV1Adapter(fixture);
    await adapter.submit(submitRequest(fixture, 'image_generation', [], {}));
    expect(fixture.transport.requests[0]?.headers.authorization).toBe(
      'Bearer synthetic-token'
    );
  });

  it('submits Gemini V2 reference images without enabling image search', async () => {
    const fixture = await createFixture('gemini');
    fixture.transport.responses.push(jsonResponse({
      candidates: [{
        content: {
          parts: [{
            fileData: {
              mimeType: 'image/png',
              fileUri: 'https://files.synthetic.invalid/output.png'
            }
          }]
        },
        finishReason: 'STOP',
        index: 0
      }]
    }));
    const adapter = new ViduGeminiImageV2Adapter(fixture.dependencies);
    const request = submitRequest(
      fixture,
      'reference_to_image',
      [toAssetId('asset-controlled-input')],
      { aspectRatio: '1:1', imageSize: '1K' }
    );

    await expect(adapter.submit(request)).resolves.toEqual({
      kind: 'completed_sync',
      providerOperationId: 'local-image-operation',
      results: [{
        kind: 'file_uri',
        value: 'https://files.synthetic.invalid/output.png'
      }]
    });
    const body = bodyOf(fixture.transport.requests[0]);
    expect(body).toMatchObject({
      content: [{
        role: 'user',
        part: [
          { text: 'Create a synthetic image' },
          { inlineData: { mimeType: 'image/png', data: 'c3ludGhldGljLWlucHV0' } }
        ]
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '1:1', imageSize: '1K' }
      }
    });
    expect(body).not.toHaveProperty('tools');
    expect(fixture.transport.requests[0].url).toBe(
      `https://api.vidu.cn/ent/v2/image/reference2image/${fixture.model.providerModelKey}`
    );
  });

  it('blocks oversized serialized requests and malformed multi-result responses', async () => {
    const fixture = await createFixture('gemini');
    fixture.materials.material = {
      ...fixture.materials.material,
      base64: 'A'.repeat(20 * 1024 * 1024)
    };
    const adapter = new ViduGeminiImageV2Adapter(fixture.dependencies);
    const request = submitRequest(
      fixture,
      'reference_to_image',
      [toAssetId('asset-controlled-input')],
      {}
    );
    await expect(adapter.submit(request)).resolves.toMatchObject({
      kind: 'failed_before_submission',
      retryability: 'not_retryable'
    });
    expect(fixture.transport.requests).toHaveLength(0);

    fixture.materials.material = controlledMaterial();
    fixture.transport.responses.push(jsonResponse({
      candidates: [
        { content: { parts: [{ fileData: { fileUri: 'https://a.invalid/a.png' } }] } },
        { content: { parts: [{ fileData: { fileUri: 'https://b.invalid/b.png' } }] } }
      ]
    }));
    await expect(adapter.submit(request)).resolves.toMatchObject({
      kind: 'submission_outcome_unknown',
      providerOperationId: 'local-image-operation'
    });
  });

  it('never auto-retries a synchronous request whose transport outcome is unknown', async () => {
    const fixture = await createFixture('gemini');
    fixture.transport.failures.push(new ViduTransportFailure('timeout'));
    const adapter = new ViduGeminiImageV2Adapter(fixture.dependencies);
    const request = submitRequest(
      fixture,
      'reference_to_image',
      [toAssetId('asset-controlled-input')],
      {}
    );

    await expect(adapter.submit(request)).resolves.toEqual({
      kind: 'submission_outcome_unknown',
      providerOperationId: 'local-image-operation',
      message: 'The Vidu request timed out'
    });
    expect(fixture.transport.requests).toHaveLength(1);
  });
});

type ProtocolKind = 'imageV1' | 'gemini';

async function createFixture(
  protocol: ProtocolKind,
  options: { readonly verifiedImageV1Auth?: boolean } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-vidu-image-'));
  roots.push(root);
  const vault = new SecureCredentialVault(
    path.join(root, 'credentials.json'),
    reversibleProtector()
  );
  await vault.save('credential-vidu-image', 'synthetic-token');
  const frozen = createUserViduRegistryRecords();
  const connection = createProviderConnection({
    ...frozen.connections[0],
    endpoint: 'https://api.vidu.cn',
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-vidu-image',
    updatedAt: timestamp
  });
  const originalBinding = frozen.protocolBindings.find((binding) =>
    binding.id === (
      protocol === 'imageV1'
        ? VIDU_USER_PROTOCOL_BINDING_IDS.imageV1
        : VIDU_USER_PROTOCOL_BINDING_IDS.geminiImageV2
    )
  )!;
  const binding = protocol === 'imageV1' && options.verifiedImageV1Auth === false
    ? createProviderProtocolBinding({ ...originalBinding, authScheme: 'unknown' })
    : protocol === 'imageV1'
      ? createProviderProtocolBinding({ ...originalBinding, authScheme: 'bearer' })
      : originalBinding;
  const model = frozen.models.find(
    (candidate) => candidate.protocolBindingId === binding.id
  )!;
  const evidence = frozen.capabilities.find(
    (candidate) => candidate.id === model.capabilityEvidenceId
  )!;
  const evidences = frozen.capabilities.filter(
    (candidate) => candidate.modelId === model.id
  );
  const transport = new FixtureTransport();
  const runtime = new ViduSharedRuntime({ credentialVault: vault, transport });
  const materials = new FixtureMaterialPort();
  const dependencies = {
    runtime,
    connections: { get: async () => connection },
    materials,
    createProviderOperationId: () => 'local-image-operation'
  };
  return {
    transport,
    connection,
    binding,
    model,
    evidence,
    evidences,
    materials,
    dependencies
  };
}

function imageV1Adapter(
  fixture: Awaited<ReturnType<typeof createFixture>>
) {
  return new ViduImageV1Adapter(fixture.dependencies, {
    imageInputShape: 'image_url_object_array',
    base64Encoding: 'data_url'
  });
}

function submitRequest(
  fixture: {
    readonly model: ProviderModel;
    readonly binding: ProviderProtocolBinding;
    readonly evidence: ModelCapabilityEvidence;
    readonly evidences?: readonly ModelCapabilityEvidence[];
  },
  purpose: 'image_generation' | 'image_editing' | 'reference_to_image',
  assetIds: readonly ReturnType<typeof toAssetId>[],
  parameters: Readonly<Record<string, DynamicParameterValue>>
) {
  const evidence = fixture.evidences?.find((candidate) =>
    candidate.capability === purpose
  ) ?? fixture.evidence;
  const task = imageTask(
    { model: fixture.model, evidence },
    purpose,
    assetIds,
    parameters
  );
  const execution = transitionExecution(
    createExecution({
      id: toExecutionId('execution-vidu-image'),
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
    evidence
  };
}

function imageTask(
  fixture: {
    readonly model: ProviderModel;
    readonly evidence: ModelCapabilityEvidence;
  },
  purpose: 'image_generation' | 'image_editing' | 'reference_to_image',
  assetIds: readonly ReturnType<typeof toAssetId>[],
  parameters: Readonly<Record<string, DynamicParameterValue>>
): Task {
  return {
    schemaVersion: 1,
    id: toTaskId('task-vidu-image'),
    projectId: toProjectId('project-vidu-image'),
    sourceDraftId: toDraftId('draft-vidu-image'),
    submission: {
      kind: purpose === 'image_editing' ? 'image_editing' : 'image_generation',
      prompt: {
        originalInput: 'Create a synthetic image',
        systemSupplements: [],
        finalPrompt: 'Create a synthetic image'
      },
      assetIds,
      confirmedAt: timestamp,
      image: {
        mode: purpose === 'image_editing' ? 'image_editing' : 'professional_image',
        purpose,
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
    return this.responses.shift() ?? jsonResponse({});
  }
}

function jsonResponse(value: unknown): ViduHttpTransportResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status: 200,
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
