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
  UNICOMPAPI_STUDIO_H3_BASE_URL,
  UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
  UNICOMPAPI_STUDIO_H3_MODEL_KEY,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
  UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
  UNICOMPAPI_STUDIO_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION,
  UNICOMPAPI_STUDIO_H3_VIDEO_RESULT_SCHEMA_ID,
  UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID,
  UnicompapiStudioH3SharedRuntime,
  UnicompapiStudioH3VideoAdapter,
  ProviderPackageRegistry,
  createUnicompapiStudioH3VideoModelContract,
  frozenUnicompapiStudioH3ModelKeys,
  unicompapiStudioH3ProviderPackageDescriptor,
  unicompapiStudioH3VideoUsageSchema,
  type UnicompapiStudioH3HttpTransport,
  type UnicompapiStudioH3HttpTransportRequest,
  type UnicompapiStudioH3HttpTransportResponse,
  type UnicompapiStudioH3SafeLogEvent,
  type UnicompapiStudioH3VideoConnectionResolverPort,
  type UnicompapiStudioH3VideoCredentialResolverPort,
  type UnicompapiStudioH3VideoParameterSchemaResolverPort,
  type UnicompapiStudioH3VideoUsageObservationSinkPort
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-09-20T18:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'unit-test-studio-h3-key' }
};
const modelContract = createUnicompapiStudioH3VideoModelContract(UNICOMPAPI_STUDIO_H3_MODEL_KEY);

describe('UniCompAPI Studio H3 test contracts', () => {
  it('publishes one temporary T2V adapter and one frozen model key', () => {
    const registry = new ProviderPackageRegistry([unicompapiStudioH3ProviderPackageDescriptor]);
    expect(registry.resolveAdapter(
      UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
      UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
      UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
      UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
      UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
    ).operations).toEqual([
      'validate_connection',
      'submit',
      'query',
      'cancel',
      'receive_result'
    ]);
    expect(frozenUnicompapiStudioH3ModelKeys).toEqual(['minimax-h3']);
    expect(schemaFor('text_to_video').fields.map((field) => field.fieldId))
      .toEqual(['generation_mode', 'duration', 'aspect_ratio']);
    expect(modelContract.parameterSchemas.some((schema) => schema.productFeature === 'image_to_video'))
      .toBe(false);
    expect(unicompapiStudioH3VideoUsageSchema.metrics[0]).toMatchObject({
      metricId: 'output_seconds',
      requiredForComplete: true
    });
    expect(() => createUnicompapiStudioH3VideoModelContract('guessed/model'))
      .toThrow('exact model endpoint key is invalid');
  });
});

describe('UniCompAPI Studio H3 video adapter', () => {
  it('submits text-to-video with fl2va and the observed Studio body', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({ id: 'vid_studio_h3_1' }, 202));
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot(),
      request: dispatchRequest({
        generation_mode: 'base-balanced',
        duration: 6,
        aspect_ratio: '16:9'
      })
    });
    expect(outcome).toMatchObject({
      kind: 'accepted_async',
      providerOperationId: 'vid_studio_h3_1',
      state: 'queued'
    });
    expect(fixture.transport.requests).toHaveLength(1);
    const request = fixture.transport.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${UNICOMPAPI_STUDIO_H3_BASE_URL}/videos`);
    expect(bodyOf(request)).toEqual({
      model: 'minimax-h3',
      variant: 'fl2va',
      prompt: 'A controlled synthetic prompt',
      duration_seconds: 6,
      aspect_ratio: '16:9',
      generation_mode: 'base-balanced'
    });
    expect(new TextDecoder().decode(request.body)).not.toMatch(/first_frame|last_frame|ref2va|fasth3|acc8/);
    expect(JSON.stringify(fixture.logs)).not.toMatch(/unit-test-studio-h3-key/);
  });

  it('accepts workbench identity fields and still rejects unknown extras', async () => {
    const accepted = videoFixture();
    accepted.transport.responses.push(jsonResponse({ id: 'vid_studio_h3_identity' }, 202));
    await expect(accepted.adapter.submit({
      routeSnapshot: routeSnapshot(),
      request: dispatchRequest({
        generation_mode: 'base-fast',
        duration: 4,
        aspect_ratio: '9:16'
      })
    })).resolves.toMatchObject({
      kind: 'accepted_async',
      providerOperationId: 'vid_studio_h3_identity'
    });
    expect(accepted.transport.requests).toHaveLength(1);

    const rejected = videoFixture();
    const extra = await rejected.adapter.submit({
      routeSnapshot: routeSnapshot(),
      request: {
        ...dispatchRequest({
          generation_mode: 'base-fast',
          duration: 4,
          aspect_ratio: '9:16'
        }),
        callback_url: 'https://example.test'
      }
    });
    expect(extra.kind).toBe('failed_before_submission');
    expect(rejected.transport.requests).toHaveLength(0);
  });

  it('maps running query status to processing and succeeded result_url to completed', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({ id: 'vid_studio_h3_2' }, 202));
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot(),
      request: dispatchRequest({
        generation_mode: 'base-fast',
        duration: 5,
        aspect_ratio: '9:16'
      })
    });
    if (outcome.kind !== 'accepted_async') throw new Error('expected async accept');
    fixture.transport.responses.push(jsonResponse({
      id: 'vid_studio_h3_2',
      status: 'running'
    }));
    await expect(fixture.adapter.query(outcome.providerOperationId))
      .resolves.toEqual({ state: 'processing' });
    fixture.transport.responses.push(jsonResponse({
      id: 'vid_studio_h3_2',
      status: 'succeeded',
      result_url: 'https://unicompapi.com/files/studio-h3-result.mp4',
      duration_seconds: 5
    }));
    await expect(fixture.adapter.query(outcome.providerOperationId)).resolves.toMatchObject({
      state: 'completed',
      usageFacts: [{
        metricId: 'output_seconds',
        quantity: '5',
        unit: 'second'
      }]
    });
  });

  it('cancels a queued task and keeps a 409 cancel as processing', async () => {
    const queued = videoFixture();
    queued.transport.responses.push(jsonResponse({ id: 'vid_studio_h3_3' }, 202));
    const accepted = await queued.adapter.submit({
      routeSnapshot: routeSnapshot(),
      request: dispatchRequest({
        generation_mode: 'base-lossless',
        duration: 4,
        aspect_ratio: '1:1'
      })
    });
    if (accepted.kind !== 'accepted_async') throw new Error('expected async accept');
    queued.transport.responses.push(jsonResponse({
      id: 'vid_studio_h3_3',
      status: 'cancelled'
    }));
    await expect(queued.adapter.cancel(accepted.providerOperationId))
      .resolves.toEqual({ state: 'cancelled' });

    const running = videoFixture();
    running.transport.responses.push(jsonResponse({ id: 'vid_studio_h3_4' }, 202));
    const created = await running.adapter.submit({
      routeSnapshot: routeSnapshot(),
      request: dispatchRequest({
        generation_mode: 'base-balanced',
        duration: 8,
        aspect_ratio: '21:9'
      })
    });
    if (created.kind !== 'accepted_async') throw new Error('expected async accept');
    running.transport.responses.push(jsonResponse({}, 409));
    await expect(running.adapter.cancel(created.providerOperationId))
      .resolves.toEqual({ state: 'processing' });
    expect(running.adapter.knowsOperation(created.providerOperationId)).toBe(true);
  });
});

function videoFixture() {
  const transport = new SyntheticTransport();
  const logs: UnicompapiStudioH3SafeLogEvent[] = [];
  const runtime = new UnicompapiStudioH3SharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 100
  });
  const connections = new RecordingConnectionResolver();
  const credentials = new RecordingCredentialResolver();
  const parameterSchemas = new RecordingParameterSchemaResolver();
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
    usage,
    clock,
    adapter: new UnicompapiStudioH3VideoAdapter(
      runtime,
      connections,
      credentials,
      parameterSchemas,
      usage,
      {
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId(`studio-h3-usage-${++usageSequence}`)
      },
      () => timestamp,
      () => clock.now
    )
  };
}

class RecordingConnectionResolver implements UnicompapiStudioH3VideoConnectionResolverPort {
  readonly connection = officialConnection();
  async get(connectionId: string): Promise<ProviderConnection | undefined> {
    return connectionId === this.connection.id ? this.connection : undefined;
  }
}

class RecordingCredentialResolver implements UnicompapiStudioH3VideoCredentialResolverPort {
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
  implements UnicompapiStudioH3VideoParameterSchemaResolverPort {
  async get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined> {
    return modelContract.parameterSchemas.find(
      (schema) => schema.schemaId === schemaId && schema.revision === revision
    );
  }
}

class RecordingUsageSink implements UnicompapiStudioH3VideoUsageObservationSinkPort {
  readonly observations: ProviderUsageObservationV1[] = [];
  readonly schemas: UsageSchemaV1[] = [];
  async append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1) {
    this.observations.push(observation);
    this.schemas.push(schema);
  }
}

class SyntheticTransport implements UnicompapiStudioH3HttpTransport {
  readonly requests: UnicompapiStudioH3HttpTransportRequest[] = [];
  readonly responses: UnicompapiStudioH3HttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(
    request: UnicompapiStudioH3HttpTransportRequest
  ): Promise<UnicompapiStudioH3HttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic UniCompAPI Studio H3 response is missing');
    return response;
  }
}

function officialConnection(): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-studio-h3-video'),
    providerId: toProviderId('provider-studio-h3-test'),
    name: 'UniCompAPI Studio H3 Test',
    endpoint: `${UNICOMPAPI_STUDIO_H3_BASE_URL}/`,
    packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
    packageVersion: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
    templateId: UNICOMPAPI_STUDIO_H3_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: UNICOMPAPI_STUDIO_H3_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-studio-h3-1',
    connectionPolicyId: 'connection.unicompapi-studio-h3.test',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.unicompapi-studio-h3.packaged-catalog',
    discoveryPolicyRevision: 1,
    endpointPolicyId: UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-studio-h3-1',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
      adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
      protocolId: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_ID,
      protocolVersion: UNICOMPAPI_STUDIO_H3_VIDEO_PROTOCOL_VERSION
    }],
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-studio-h3-video',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function routeSnapshot() {
  const schema = schemaFor('text_to_video');
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId('route-studio-h3-text_to_video'),
    projectId: toProjectId('project-studio-h3'),
    packageId: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_ID,
    packageVersion: UNICOMPAPI_STUDIO_H3_PROVIDER_PACKAGE_VERSION,
    adapterKey: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_ID,
    adapterVersion: UNICOMPAPI_STUDIO_H3_VIDEO_ADAPTER_VERSION,
    providerId: toProviderId('provider-studio-h3-test'),
    connectionId: toConnectionId('connection-studio-h3-video'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-studio-h3-1',
    endpointPolicyId: UNICOMPAPI_STUDIO_H3_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-studio-h3-1',
    modelId: toModelId('model-studio-h3-text_to_video'),
    providerModelKey: UNICOMPAPI_STUDIO_H3_MODEL_KEY,
    modelRevision: 1,
    profileId: 'profile-studio-h3-text_to_video',
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-studio-h3-video'),
    protocolBindingRevision: 1,
    productFeature: 'text_to_video',
    internalPurpose: 'video_generation',
    featureMappingVersion: 1,
    parameterSchemaId: schema.schemaId,
    parameterSchemaRevision: schema.revision,
    resultSchemaId: UNICOMPAPI_STUDIO_H3_VIDEO_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(UNICOMPAPI_STUDIO_H3_VIDEO_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: UNICOMPAPI_STUDIO_H3_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.unicompapi-studio-h3.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-studio-h3-synthetic',
    createdAt: timestamp
  });
}

function schemaFor(feature: 'text_to_video'): ParameterSchemaV2 {
  return modelContract.parameterSchemas.find(
    (schema) => schema.productFeature === feature
  )!;
}

function dispatchRequest(parameterValues: Record<string, unknown>) {
  return {
    invocationAttemptId: toProviderInvocationAttemptId(
      'invocation-attempt-studio-h3-text_to_video'
    ),
    projectId: 'project-studio-h3',
    prompt: 'A controlled synthetic prompt',
    taskId: 'task-video-studio-h3',
    executionId: 'execution-video-studio-h3',
    parameterValues
  };
}

function jsonResponse(
  value: unknown,
  status = 200
): UnicompapiStudioH3HttpTransportResponse {
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

function bodyOf(request: UnicompapiStudioH3HttpTransportRequest): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}
