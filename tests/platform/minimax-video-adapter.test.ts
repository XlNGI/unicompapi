import { describe, expect, it } from 'vitest';
import {
  createProviderConnection,
  createProviderExecutionRouteSnapshot,
  toConnectionId,
  toIsoTimestamp,
  toModelId,
  toProjectId,
  toProtocolBindingId,
  toProviderExecutionRouteSnapshotId,
  toProviderId,
  toProviderInvocationAttemptId,
  toProviderUsageObservationId,
  toUsageSchemaId,
  type ParameterSchemaV2,
  type ProviderConnection,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageSchemaV1
} from '../../src/domain';
import {
  MINIMAX_H3_CN_BASE_URL,
  MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
  MINIMAX_H3_CN_TEMPLATE_ID,
  MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
  MINIMAX_H3_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_ID,
  MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
  MINIMAX_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  MINIMAX_H3_VIDEO_ADAPTER_ID,
  MINIMAX_H3_VIDEO_ADAPTER_VERSION,
  MINIMAX_H3_VIDEO_PROTOCOL_ID,
  MINIMAX_H3_VIDEO_PROTOCOL_VERSION,
  MINIMAX_H3_VIDEO_RESULT_SCHEMA_ID,
  MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID,
  MiniMaxSharedRuntime,
  MiniMaxVideoAdapter,
  ProviderPackageRegistry,
  createMiniMaxVideoModelContract,
  frozenMiniMaxH3ModelKeys,
  minimaxH3ProviderPackageDescriptor,
  minimaxH3VideoUsageSchema,
  type ControlledMiniMaxImagePort,
  type MiniMaxHttpTransport,
  type MiniMaxHttpTransportRequest,
  type MiniMaxHttpTransportResponse,
  type MiniMaxSafeLogEvent,
  type MiniMaxVideoConnectionResolverPort,
  type MiniMaxVideoCredentialResolverPort,
  type MiniMaxVideoParameterSchemaResolverPort,
  type MiniMaxVideoUsageObservationSinkPort
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-09-20T18:00:00.000Z');
const exactModelKey = 'MiniMax-H3';
const credential: StructuredCredentialRecord = {
  schemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'unit-test-minimax-key' }
};
const modelContract = createMiniMaxVideoModelContract(exactModelKey);

describe('MiniMax official contracts', () => {
  it('publishes one H3 video adapter and frozen model keys', () => {
    const registry = new ProviderPackageRegistry([minimaxH3ProviderPackageDescriptor]);
    expect(registry.resolveAdapter(
      MINIMAX_H3_PROVIDER_PACKAGE_ID,
      MINIMAX_H3_VIDEO_ADAPTER_ID,
      MINIMAX_H3_VIDEO_ADAPTER_VERSION,
      MINIMAX_H3_VIDEO_PROTOCOL_ID,
      MINIMAX_H3_VIDEO_PROTOCOL_VERSION
    ).operations).toEqual([
      'validate_connection',
      'submit',
      'query',
      'cancel',
      'receive_result'
    ]);
    expect(frozenMiniMaxH3ModelKeys).toEqual(['MiniMax-H3', 'MiniMax-H3-Max']);
    expect(schemaFor('text_to_video').fields.map((field) => field.fieldId))
      .toEqual(['resolution', 'duration', 'aspect_ratio']);
    expect(schemaFor('image_to_video').fields.map((field) => field.fieldId))
      .toEqual(['resolution', 'duration']);
    expect(minimaxH3VideoUsageSchema.metrics[0]).toMatchObject({
      metricId: 'output_seconds',
      requiredForComplete: true
    });
    expect(() => createMiniMaxVideoModelContract('guessed/model'))
      .toThrow('endpoint key');
  });
});

describe('MiniMax video adapter', () => {
  it('submits text-to-video with content text and a required ratio', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({ task_id: 'minimax-task-text' }));
    let requestStarted = 0;
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', {
        resolution: '768P',
        aspect_ratio: '16:9',
        duration: 5
      }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });

    expect(outcome).toEqual({
      kind: 'accepted_async',
      providerOperationId: 'minimax-task-text',
      state: 'queued'
    });
    expect(requestStarted).toBe(1);
    expect(fixture.images.calls).toEqual([]);
    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'POST',
      url: `${MINIMAX_H3_CN_BASE_URL}/v2/video_generation`,
      redirect: 'manual'
    });
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: 'A controlled synthetic prompt' }],
      duration: 5,
      resolution: '768P',
      ratio: '16:9'
    });
    expect(JSON.stringify(bodyOf(fixture.transport.requests[0]))).not.toMatch(
      /callback_url|first_frame|last_frame|mm_file|adaptive/
    );
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /unit-test-minimax-key|controlled synthetic prompt/
    );
  });

  it('uploads one controlled first frame then creates image-to-video without ratio', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({
      file: { file_id: '12345' },
      extra_field: 'allowed'
    }));
    fixture.transport.responses.push(jsonResponse({
      task_id: 'minimax-task-image',
      extra_field: 'allowed'
    }));
    let requestStarted = 0;
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_to_video'),
      request: dispatchRequest('image_to_video', {
        resolution: '2K',
        duration: 6
      }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });

    expect(outcome).toMatchObject({
      kind: 'accepted_async',
      providerOperationId: 'minimax-task-image'
    });
    expect(requestStarted).toBe(1);
    expect(fixture.images.calls).toEqual([{
      projectId: 'project-minimax',
      assetId: 'asset-minimax-first-frame'
    }]);
    expect(fixture.transport.requests).toHaveLength(2);
    expect(fixture.transport.requests[0].url)
      .toBe(`${MINIMAX_H3_CN_BASE_URL}/v1/files/upload`);
    expect(fixture.transport.requests[0].headers['content-type'])
      .toMatch(/^multipart\/form-data; boundary=MiniMaxBoundary/u);
    const uploadText = new TextDecoder().decode(fixture.transport.requests[0].body);
    expect(uploadText).toMatch(/name="purpose"/);
    expect(uploadText).toContain('video_generation_input');
    expect(uploadText).toMatch(/filename="first-frame.png"/);
    expect(bodyOf(fixture.transport.requests[1])).toEqual({
      model: 'MiniMax-H3',
      content: [
        { type: 'text', text: 'A controlled synthetic prompt' },
        {
          type: 'image_url',
          image_url: { url: 'mm_file://12345' },
          role: 'first_frame'
        }
      ],
      duration: 6,
      resolution: '2K'
    });
    expect(bodyOf(fixture.transport.requests[1])).not.toHaveProperty('ratio');
    expect(JSON.stringify(bodyOf(fixture.transport.requests[1]))).not.toMatch(
      /last_frame|callback_url/
    );
  });

  it('treats upload failure as failed_before_submission', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({
      base_resp: { status_code: 1004, status_msg: 'invalid api key' }
    }));
    let requestStarted = 0;
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_to_video'),
      request: dispatchRequest('image_to_video', {
        resolution: '768P',
        duration: 5
      }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });
    expect(outcome.kind).toBe('failed_before_submission');
    expect(requestStarted).toBe(0);
    expect(fixture.transport.requests).toHaveLength(1);
  });

  it('rejects extra request fields and last-frame material', async () => {
    const fixture = videoFixture();
    const extra = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: {
        ...dispatchRequest('text_to_video', {
          resolution: '768P',
          aspect_ratio: '16:9',
          duration: 5
        }),
        callback_url: 'https://example.test'
      }
    });
    expect(extra.kind).toBe('failed_before_submission');
    expect(fixture.transport.requests).toHaveLength(0);

    const lastFrame = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', {
        resolution: '768P',
        aspect_ratio: '16:9',
        duration: 5,
        last_frame: true
      } as never)
    });
    expect(lastFrame.kind).toBe('failed_before_submission');
  });

  it('cancels as a no-op while the remote task keeps processing', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({ task_id: 'minimax-task-cancel' }));
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', {
        resolution: '768P',
        aspect_ratio: '1:1',
        duration: 4
      })
    });
    if (outcome.kind !== 'accepted_async') throw new Error('expected async accept');
    await expect(fixture.adapter.cancel(outcome.providerOperationId))
      .resolves.toEqual({ state: 'processing' });
    expect(fixture.adapter.knowsOperation(outcome.providerOperationId)).toBe(true);
  });
});

function videoFixture() {
  const transport = new SyntheticTransport();
  const logs: MiniMaxSafeLogEvent[] = [];
  const runtime = new MiniMaxSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 100
  });
  const connections = new RecordingConnectionResolver();
  const credentials = new RecordingCredentialResolver();
  const parameterSchemas = new RecordingParameterSchemaResolver();
  const images = new RecordingImageResolver();
  const usage = new RecordingUsageSink();
  const clock = { now: 1_000 };
  let usageSequence = 0;
  return {
    transport,
    logs,
    runtime,
    connections,
    credentials,
    parameterSchemas,
    images,
    usage,
    clock,
    adapter: new MiniMaxVideoAdapter(
      runtime,
      connections,
      credentials,
      parameterSchemas,
      images,
      usage,
      {
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId(`minimax-usage-${++usageSequence}`)
      },
      () => timestamp,
      () => clock.now
    )
  };
}

class RecordingConnectionResolver implements MiniMaxVideoConnectionResolverPort {
  readonly connection = officialConnection();
  async get(connectionId: string): Promise<ProviderConnection | undefined> {
    return connectionId === this.connection.id ? this.connection : undefined;
  }
}

class RecordingCredentialResolver implements MiniMaxVideoCredentialResolverPort {
  readonly calls: { connectionId: string; credentialVersionId: string }[] = [];
  async useCredential<T>(
    input: { connectionId: string; credentialVersionId: string },
    operation: (value: StructuredCredentialRecord) => Promise<T>
  ): Promise<T> {
    this.calls.push(input);
    return operation(credential);
  }
}

class RecordingParameterSchemaResolver
  implements MiniMaxVideoParameterSchemaResolverPort {
  async get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined> {
    return modelContract.parameterSchemas.find(
      (schema) => schema.schemaId === schemaId && schema.revision === revision
    );
  }
}

class RecordingImageResolver implements ControlledMiniMaxImagePort {
  readonly calls: { projectId: string; assetId: string }[] = [];
  image = {
    assetId: 'asset-minimax-first-frame',
    mimeType: 'image/png',
    width: 512,
    height: 512,
    sizeBytes: 4,
    bytes: Uint8Array.from([1, 2, 3, 4])
  };
  async resolve(input: { projectId: string; assetId: string }) {
    this.calls.push(input);
    return this.image;
  }
}

class RecordingUsageSink implements MiniMaxVideoUsageObservationSinkPort {
  readonly observations: ProviderUsageObservationV1[] = [];
  readonly schemas: UsageSchemaV1[] = [];
  async append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1) {
    this.observations.push(observation);
    this.schemas.push(schema);
  }
}

class SyntheticTransport implements MiniMaxHttpTransport {
  readonly requests: MiniMaxHttpTransportRequest[] = [];
  readonly responses: MiniMaxHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: MiniMaxHttpTransportRequest): Promise<MiniMaxHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic MiniMax response is missing');
    return response;
  }
}

function officialConnection(): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-minimax-video'),
    providerId: toProviderId('provider-minimax-official'),
    name: 'MiniMax Official',
    endpoint: `${MINIMAX_H3_CN_BASE_URL}/`,
    packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
    packageVersion: MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
    templateId: MINIMAX_H3_CN_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: MINIMAX_H3_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-minimax-1',
    connectionPolicyId: 'connection.minimax-h3.official-cn',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.minimax-h3.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId: MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-minimax-1',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: MINIMAX_H3_VIDEO_ADAPTER_ID,
      adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION,
      protocolId: MINIMAX_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: MINIMAX_H3_VIDEO_PROTOCOL_VERSION
    }],
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-minimax-video',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function routeSnapshot(feature: 'text_to_video' | 'image_to_video') {
  const schema = schemaFor(feature);
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-minimax-${feature}`),
    projectId: toProjectId('project-minimax'),
    packageId: MINIMAX_H3_PROVIDER_PACKAGE_ID,
    packageVersion: MINIMAX_H3_PROVIDER_PACKAGE_VERSION,
    adapterKey: MINIMAX_H3_VIDEO_ADAPTER_ID,
    adapterVersion: MINIMAX_H3_VIDEO_ADAPTER_VERSION,
    providerId: toProviderId('provider-minimax-official'),
    connectionId: toConnectionId('connection-minimax-video'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-minimax-1',
    endpointPolicyId: MINIMAX_H3_CN_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-minimax-1',
    modelId: toModelId(`model-minimax-${feature}`),
    providerModelKey: exactModelKey,
    modelRevision: 1,
    profileId: `profile-minimax-${feature}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-minimax-video'),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: feature === 'text_to_video'
      ? 'video_generation'
      : 'reference_to_video',
    featureMappingVersion: 1,
    parameterSchemaId: schema.schemaId,
    parameterSchemaRevision: schema.revision,
    resultSchemaId: MINIMAX_H3_VIDEO_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(MINIMAX_H3_VIDEO_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: feature === 'text_to_video'
      ? MINIMAX_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
      : MINIMAX_H3_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.minimax.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-minimax-synthetic',
    createdAt: timestamp
  });
}

function schemaFor(feature: 'text_to_video' | 'image_to_video'): ParameterSchemaV2 {
  return modelContract.parameterSchemas.find(
    (schema) => schema.productFeature === feature
  )!;
}

function dispatchRequest(
  feature: 'text_to_video' | 'image_to_video',
  parameterValues: Record<string, unknown>
) {
  return {
    invocationAttemptId: toProviderInvocationAttemptId(
      `invocation-attempt-minimax-${feature}`
    ),
    projectId: 'project-minimax',
    prompt: 'A controlled synthetic prompt',
    taskId: `task-video-minimax-${feature}`,
    executionId: `execution-video-minimax-${feature}`,
    ...(feature === 'image_to_video'
      ? { assetId: 'asset-minimax-first-frame' }
      : {}),
    parameterValues
  };
}

function jsonResponse(
  value: unknown,
  status = 200
): MiniMaxHttpTransportResponse {
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

function bodyOf(request: MiniMaxHttpTransportRequest): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}
