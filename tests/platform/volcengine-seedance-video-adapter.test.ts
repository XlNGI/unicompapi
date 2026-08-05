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
  type ProviderInvocationAttemptId,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageSchemaV1
} from '../../src/domain';
import {
  ProviderPackageRegistry,
  SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
  SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  SEEDANCE_VIDEO_ADAPTER_ID,
  SEEDANCE_VIDEO_ADAPTER_VERSION,
  SEEDANCE_VIDEO_PROTOCOL_ID,
  SEEDANCE_VIDEO_PROTOCOL_VERSION,
  SEEDANCE_VIDEO_RESULT_SCHEMA_ID,
  SEEDANCE_VIDEO_USAGE_SCHEMA_ID,
  SeedanceVideoAdapter,
  VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  VOLCENGINE_ENDPOINT_POLICY_ID,
  VOLCENGINE_OFFICIAL_BASE_URL,
  VOLCENGINE_OFFICIAL_TEMPLATE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_VERSION,
  VolcengineSharedRuntime,
  VolcengineTransportFailure,
  createSeedanceVideoModelContract,
  mapSeedanceVideoUsage,
  seedanceVideoRecoveryDecision,
  seedanceVideoUsageSchema,
  volcengineProviderPackageDescriptor,
  type ControlledSeedanceImagePort,
  type SeedanceVideoConnectionResolverPort,
  type SeedanceVideoCredentialResolverPort,
  type SeedanceVideoParameterSchemaResolverPort,
  type SeedanceVideoUsageObservationSinkPort,
  type VolcengineHttpTransport,
  type VolcengineHttpTransportRequest,
  type VolcengineHttpTransportResponse,
  type VolcengineSafeLogEvent
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-08-03T16:30:00.000Z');
const exactModelId = 'seedance-endpoint-synthetic-20260803';
const credential: StructuredCredentialRecord = {
  schemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'unit-test-seedance-key' }
};
const modelContract = createSeedanceVideoModelContract(exactModelId, {
  textToVideo: {
    resolutions: ['1080p', '720p'],
    ratios: ['16:9', '9:16'],
    durations: [5, 10],
    frames: [121, 241],
    seedRange: { minimum: 0, maximum: 2_147_483_647 },
    supportsCameraFixed: true,
    supportsWatermark: true,
    supportsGenerateAudio: true,
    supportsReturnLastFrame: true
  },
  imageToVideo: {
    resolutions: ['720p'],
    ratios: ['adaptive', '16:9'],
    durations: [5, 10],
    supportsWatermark: true,
    supportsGenerateAudio: true
  }
});

describe('Volcengine Seedance official contracts', () => {
  it('publishes an exact async adapter and builds capabilities only from the declared Profile', () => {
    const registry = new ProviderPackageRegistry([
      volcengineProviderPackageDescriptor
    ]);
    expect(registry.resolveAdapter(
      VOLCENGINE_PROVIDER_PACKAGE_ID,
      SEEDANCE_VIDEO_ADAPTER_ID,
      SEEDANCE_VIDEO_ADAPTER_VERSION,
      SEEDANCE_VIDEO_PROTOCOL_ID,
      SEEDANCE_VIDEO_PROTOCOL_VERSION
    ).operations).toEqual([
      'validate_connection',
      'submit',
      'query',
      'cancel',
      'receive_result'
    ]);

    expect(modelContract.definition.providerModelKey).toBe(exactModelId);
    expect(modelContract.definition.definitionId).not.toContain(exactModelId);
    expect(modelContract.definition.profileTemplates[0]).toMatchObject({
      adapterKey: SEEDANCE_VIDEO_ADAPTER_ID,
      protocolDefinitionId: SEEDANCE_VIDEO_PROTOCOL_ID,
      features: [
        {
          productFeature: 'text_to_video',
          internalPurpose: 'video_generation',
          resultSchemaId: SEEDANCE_VIDEO_RESULT_SCHEMA_ID,
          usageSchemaId: SEEDANCE_VIDEO_USAGE_SCHEMA_ID,
          constraintSetId: SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
        },
        {
          productFeature: 'image_to_video',
          internalPurpose: 'reference_to_video',
          constraintSetId: SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
        }
      ]
    });
    expect(modelContract.parameterSchemas).toHaveLength(2);
    expect(schemaFor('text_to_video').fields.map((field) => field.fieldId))
      .toEqual([
        'resolution',
        'ratio',
        'duration',
        'frames',
        'seed',
        'camera_fixed',
        'watermark',
        'generate_audio',
        'return_last_frame'
      ]);
    expect(schemaFor('image_to_video').fields.map((field) => field.fieldId))
      .toEqual(['resolution', 'ratio', 'duration', 'watermark', 'generate_audio']);
    expect(seedanceVideoUsageSchema.metrics.map((metric) => metric.metricId))
      .toEqual(['completion_tokens', 'total_tokens', 'web_search_calls']);

    const narrower = createSeedanceVideoModelContract(exactModelId, {
      textToVideo: { durations: [5] }
    });
    expect(narrower.definition.definitionId)
      .not.toBe(modelContract.definition.definitionId);
    expect(narrower.parameterSchemas[0].fields.map((field) => field.fieldId))
      .toEqual(['duration']);
    expect(() => createSeedanceVideoModelContract(exactModelId, {}))
      .toThrow('at least one');
    expect(() => createSeedanceVideoModelContract(exactModelId, {
      textToVideo: { seedRange: { minimum: -1, maximum: 10 } }
    })).toThrow('seed range');
    expect(() => createSeedanceVideoModelContract(exactModelId, {
      textToVideo: { durations: [5], guessedCapability: true }
    } as never)).toThrow('unknown fields');
  });
});

describe('Seedance video adapter', () => {
  it('submits pure text-to-video with the exact RouteSnapshot schema and no material', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({ id: 'seedance-task-text' }, 201));
    let requestStarted = 0;
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', {
        resolution: '1080p',
        ratio: '16:9',
        duration: 10,
        seed: 42,
        camera_fixed: true,
        watermark: false,
        generate_audio: true,
        return_last_frame: false
      }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });

    expect(outcome).toEqual({
      kind: 'accepted_async',
      providerOperationId: 'seedance-task-text',
      state: 'queued'
    });
    expect(requestStarted).toBe(1);
    expect(fixture.images.calls).toEqual([]);
    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'POST',
      url: `${VOLCENGINE_OFFICIAL_BASE_URL}/contents/generations/tasks`,
      redirect: 'manual'
    });
    const body = bodyOf(fixture.transport.requests[0]);
    expect(body).toEqual({
      model: exactModelId,
      content: [{ type: 'text', text: 'A controlled synthetic prompt' }],
      resolution: '1080p',
      ratio: '16:9',
      duration: 10,
      seed: 42,
      camera_fixed: true,
      watermark: false,
      generate_audio: true,
      return_last_frame: false
    });
    expect(JSON.stringify(body)).not.toMatch(
      /image_url|tools|safety_identifier|priority|service_tier|draft/
    );
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /unit-test-seedance-key|seedance-endpoint|controlled synthetic prompt/
    );
  });

  it('submits one controlled project image only as first_frame for image-to-video', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse({ id: 'seedance-task-image' }, 201));
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_to_video'),
      request: dispatchRequest('image_to_video', {
        resolution: '720p',
        ratio: 'adaptive',
        duration: 5,
        watermark: false,
        generate_audio: false
      })
    });

    expect(outcome.kind).toBe('accepted_async');
    expect(fixture.images.calls).toEqual([{
      projectId: 'project-seedance',
      assetId: 'asset-seedance-first-frame'
    }]);
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      model: exactModelId,
      content: [
        { type: 'text', text: 'A controlled synthetic prompt' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AQIDBA==' },
          role: 'first_frame'
        }
      ],
      resolution: '720p',
      ratio: 'adaptive',
      duration: 5,
      watermark: false,
      generate_audio: false
    });
  });

  it('closes unsupported materials, unknown JSON, and duration/frames conflicts before HTTP', async () => {
    const cases = [
      {
        route: routeSnapshot('text_to_video'),
        request: { ...dispatchRequest('text_to_video', {}), assetId: 'asset-forbidden' }
      },
      {
        route: routeSnapshot('text_to_video'),
        request: dispatchRequest('text_to_video', { tools: [{ type: 'web_search' }] })
      },
      {
        route: routeSnapshot('text_to_video'),
        request: dispatchRequest('text_to_video', { duration: 5, frames: 121 })
      },
      {
        route: routeSnapshot('image_to_video'),
        request: { ...dispatchRequest('image_to_video', {}), assetId: undefined }
      }
    ];
    for (const item of cases) {
      const fixture = videoFixture();
      await expect(fixture.adapter.submit({
        routeSnapshot: item.route,
        request: item.request
      })).resolves.toMatchObject({
        kind: 'failed_before_submission',
        retryability: 'not_retryable'
      });
      expect(fixture.transport.requests).toHaveLength(0);
      expect(fixture.credentials.calls).toHaveLength(0);
    }
  });

  it('records an unknown submission outcome after a transport failure and never retries', async () => {
    const fixture = videoFixture();
    fixture.transport.failures.push(new VolcengineTransportFailure('network'));
    await expect(fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', { duration: 5 })
    })).resolves.toEqual({
      kind: 'submission_outcome_unknown',
      message: 'The Seedance video submission outcome is unknown'
    });
    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.usage.observations).toHaveLength(1);
    expect(fixture.usage.observations[0]).toMatchObject({
      status: 'unknown_outcome',
      facts: []
    });

    const rejected = videoFixture();
    rejected.transport.responses.push(emptyResponse(401));
    await expect(rejected.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', { duration: 5 })
    })).resolves.toMatchObject({
      kind: 'failed_before_submission',
      retryability: 'not_retryable'
    });
    expect(rejected.transport.requests).toHaveLength(1);
    expect(rejected.usage.observations[0]).toMatchObject({
      status: 'not_reported',
      facts: []
    });
  });

  it.each([
    ['queued', { state: 'queued' }],
    ['running', { state: 'processing' }],
    ['cancelled', { state: 'cancelled' }],
    ['succeeded', { state: 'completed' }],
    ['failed', {
      state: 'failed',
      message: 'Volcengine reported that the Seedance video task failed',
      retryability: 'not_retryable'
    }],
    ['expired', { state: 'expired' }]
  ] as const)('maps the official %s task status without exposing provider details', async (
    status,
    expected
  ) => {
    const fixture = videoFixture();
    await attach(fixture, `seedance-task-${status}`);
    fixture.transport.responses.push(jsonResponse(taskResponse(
      `seedance-task-${status}`,
      status
    )));
    await expect(fixture.adapter.query(`seedance-task-${status}`))
      .resolves.toEqual(expected);
    const terminal = !['queued', 'running'].includes(status);
    expect(fixture.usage.observations).toHaveLength(terminal ? 1 : 0);
    expect(JSON.stringify(expected)).not.toMatch(
      /provider-detail|signed-results|seedance-endpoint/
    );
  });

  it('persists complete, missing, and invalid terminal usage exactly once', async () => {
    expect(mapSeedanceVideoUsage({
      completion_tokens: 240,
      total_tokens: 240,
      tool_usage: { web_search: 0 }
    })).toEqual([
      {
        metricId: 'completion_tokens',
        quantity: '240',
        unit: 'token',
        source: 'provider_body'
      },
      {
        metricId: 'total_tokens',
        quantity: '240',
        unit: 'token',
        source: 'provider_body'
      },
      {
        metricId: 'web_search_calls',
        quantity: '0',
        unit: 'request',
        source: 'provider_body'
      }
    ]);
    expect(() => mapSeedanceVideoUsage({
      completion_tokens: 240,
      total_tokens: 241
    })).toThrow('inconsistent');
    expect(() => mapSeedanceVideoUsage({
      completion_tokens: 240,
      total_tokens: 240,
      unknown_usage: 1
    })).toThrow('unsupported fields');

    const missing = videoFixture();
    await attach(missing, 'seedance-task-no-usage');
    missing.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-no-usage',
      'succeeded',
      { usage: undefined }
    )));
    await expect(missing.adapter.query('seedance-task-no-usage'))
      .resolves.toEqual({ state: 'completed' });
    expect(missing.usage.observations[0]).toMatchObject({
      status: 'not_reported',
      facts: []
    });

    const invalid = videoFixture();
    await attach(invalid, 'seedance-task-bad-usage');
    invalid.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-bad-usage',
      'succeeded',
      { usage: { completion_tokens: 1, total_tokens: 2 } }
    )));
    await expect(invalid.adapter.query('seedance-task-bad-usage'))
      .rejects.toThrow('inconsistent');
    expect(invalid.usage.observations).toHaveLength(1);
    expect(invalid.usage.observations[0]).toMatchObject({
      status: 'invalid_response',
      facts: []
    });
  });

  it('maps DELETE success, a running-task rejection, and network ambiguity without a retry', async () => {
    const cancelled = videoFixture();
    await attach(cancelled, 'seedance-task-cancelled');
    cancelled.transport.responses.push(emptyResponse(204));
    await expect(cancelled.adapter.cancel('seedance-task-cancelled'))
      .resolves.toEqual({ state: 'cancelled' });
    expect(cancelled.transport.requests[0]).toMatchObject({
      method: 'DELETE',
      url: `${VOLCENGINE_OFFICIAL_BASE_URL}/contents/generations/tasks/seedance-task-cancelled`
    });
    expect(cancelled.transport.requests[0].body).toHaveLength(0);
    expect(cancelled.usage.observations[0]).toMatchObject({
      status: 'not_reported',
      facts: []
    });

    const running = videoFixture();
    await attach(running, 'seedance-task-running');
    running.transport.responses.push(emptyResponse(409));
    await expect(running.adapter.cancel('seedance-task-running'))
      .resolves.toEqual({ state: 'processing' });

    const unknown = videoFixture();
    await attach(unknown, 'seedance-task-unknown');
    unknown.transport.failures.push(new VolcengineTransportFailure('network'));
    await expect(unknown.adapter.cancel('seedance-task-unknown'))
      .resolves.toEqual({ state: 'unknown' });
    expect(unknown.transport.requests).toHaveLength(1);
  });

  it('keeps signed URLs out of descriptors and logs, downloads through the controlled port, and enforces 24 hours', async () => {
    const fixture = videoFixture();
    await attach(fixture, 'seedance-task-result');
    fixture.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-result',
      'succeeded'
    )));
    const descriptors = await fixture.adapter.listResults('seedance-task-result');
    expect(descriptors).toEqual([{
        remoteResultId: 'video',
        name: 'volcengine-seedance-video',
        declaredMimeType: 'video/mp4',
        declaredContainer: 'mp4'
      }]);
    expect(JSON.stringify(descriptors)).not.toContain('signed-results');

    fixture.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-result',
      'succeeded'
    )));
    fixture.transport.responses.push(binaryResponse(
      Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]),
      'video/mp4'
    ));
    const stream = await fixture.adapter.openDownload(
      'seedance-task-result',
      'video'
    );
    expect(await readAll(stream)).toEqual(
      Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112])
    );
    expect(fixture.transport.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: 'https://media.example.test/signed-results/seedance-task-result.mp4?signature=private'
    });
    expect(fixture.transport.requests.at(-1)?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /signed-results|signature=private|unit-test-seedance-key|seedance-endpoint/
    );

    const expired = videoFixture();
    await attach(expired, 'seedance-task-expired-url');
    expired.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-expired-url',
      'succeeded'
    )));
    await expired.adapter.listResults('seedance-task-expired-url');
    expired.clock.now += 24 * 60 * 60 * 1_000;
    expired.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-expired-url',
      'succeeded'
    )));
    await expect(expired.adapter.openDownload(
      'seedance-task-expired-url',
      'video'
    )).rejects.toThrow('expired');
    expect(expired.transport.requests).toHaveLength(2);
  });

  it('reattaches the same remote operation after restart using its immutable RouteSnapshot', async () => {
    const first = videoFixture();
    first.transport.responses.push(jsonResponse({ id: 'seedance-task-restart' }, 201));
    const outcome = await first.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', { duration: 5 })
    });
    expect(outcome.kind).toBe('accepted_async');
    first.adapter.dispose();

    const restarted = videoFixture();
    await restarted.adapter.attachOperation({
      routeSnapshot: routeSnapshot('text_to_video'),
      providerOperationId: 'seedance-task-restart',
      invocationAttemptId: toProviderInvocationAttemptId(
        'invocation-attempt-seedance-text_to_video'
      )
    });
    restarted.transport.responses.push(jsonResponse(taskResponse(
      'seedance-task-restart',
      'running'
    )));
    await expect(restarted.adapter.query('seedance-task-restart'))
      .resolves.toEqual({ state: 'processing' });
    expect(restarted.transport.requests[0]).toMatchObject({
      method: 'GET',
      url: `${VOLCENGINE_OFFICIAL_BASE_URL}/contents/generations/tasks/seedance-task-restart`
    });
    expect(seedanceVideoRecoveryDecision('processing')).toEqual({
      sameOperationResumable: true,
      action: 'attach_and_query'
    });
    expect(seedanceVideoRecoveryDecision('unknown_outcome')).toEqual({
      sameOperationResumable: false,
      action: 'user_retry_required'
    });
  });
});

function videoFixture() {
  const transport = new SyntheticTransport();
  const logs: VolcengineSafeLogEvent[] = [];
  const runtime = new VolcengineSharedRuntime({
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
    adapter: new SeedanceVideoAdapter(
      runtime,
      connections,
      credentials,
      parameterSchemas,
      images,
      usage,
      {
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId(`seedance-usage-${++usageSequence}`)
      },
      () => timestamp,
      () => clock.now
    )
  };
}

type VideoFixture = ReturnType<typeof videoFixture>;

class RecordingConnectionResolver implements SeedanceVideoConnectionResolverPort {
  readonly connection = officialConnection();
  async get(connectionId: string): Promise<ProviderConnection | undefined> {
    return connectionId === this.connection.id ? this.connection : undefined;
  }
}

class RecordingCredentialResolver implements SeedanceVideoCredentialResolverPort {
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
  implements SeedanceVideoParameterSchemaResolverPort {
  async get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined> {
    return modelContract.parameterSchemas.find(
      (schema) => schema.schemaId === schemaId && schema.revision === revision
    );
  }
}

class RecordingImageResolver implements ControlledSeedanceImagePort {
  readonly calls: { projectId: string; assetId: string }[] = [];
  image = {
    assetId: 'asset-seedance-first-frame',
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

class RecordingUsageSink implements SeedanceVideoUsageObservationSinkPort {
  readonly observations: ProviderUsageObservationV1[] = [];
  readonly schemas: UsageSchemaV1[] = [];
  async append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1) {
    this.observations.push(observation);
    this.schemas.push(schema);
  }
}

class SyntheticTransport implements VolcengineHttpTransport {
  readonly requests: VolcengineHttpTransportRequest[] = [];
  readonly responses: VolcengineHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: VolcengineHttpTransportRequest): Promise<VolcengineHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic Seedance response is missing');
    return response;
  }
}

function officialConnection(): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-volcengine-seedance'),
    providerId: toProviderId('provider-volcengine-official'),
    name: 'Volcengine Ark Official',
    endpoint: `${VOLCENGINE_OFFICIAL_BASE_URL}/`,
    packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
    packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
    templateId: VOLCENGINE_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-volcengine-seedance-1',
    connectionPolicyId: 'connection.volcengine.ark.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.volcengine.ark.manual-endpoint',
    discoveryPolicyRevision: 1,
    endpointPolicyId: VOLCENGINE_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-volcengine-seedance-1',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: SEEDANCE_VIDEO_ADAPTER_ID,
      adapterVersion: SEEDANCE_VIDEO_ADAPTER_VERSION,
      protocolId: SEEDANCE_VIDEO_PROTOCOL_ID,
      protocolVersion: SEEDANCE_VIDEO_PROTOCOL_VERSION
    }],
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-volcengine-seedance',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function routeSnapshot(feature: 'text_to_video' | 'image_to_video') {
  const schema = schemaFor(feature);
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-seedance-${feature}`),
    projectId: toProjectId('project-seedance'),
    packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
    packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
    adapterKey: SEEDANCE_VIDEO_ADAPTER_ID,
    adapterVersion: SEEDANCE_VIDEO_ADAPTER_VERSION,
    providerId: toProviderId('provider-volcengine-official'),
    connectionId: toConnectionId('connection-volcengine-seedance'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-volcengine-seedance-1',
    endpointPolicyId: VOLCENGINE_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-volcengine-seedance-1',
    modelId: toModelId(`model-seedance-${feature}`),
    providerModelKey: exactModelId,
    modelRevision: 1,
    profileId: `profile-seedance-${feature}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-seedance-video'),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: feature === 'text_to_video'
      ? 'video_generation'
      : 'reference_to_video',
    featureMappingVersion: 1,
    parameterSchemaId: schema.schemaId,
    parameterSchemaRevision: schema.revision,
    resultSchemaId: SEEDANCE_VIDEO_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(SEEDANCE_VIDEO_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: feature === 'text_to_video'
      ? SEEDANCE_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
      : SEEDANCE_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.volcengine.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-volcengine-synthetic',
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
      `invocation-attempt-seedance-${feature}`
    ),
    projectId: 'project-seedance',
    prompt: 'A controlled synthetic prompt',
    ...(feature === 'image_to_video'
      ? { assetId: 'asset-seedance-first-frame' }
      : {}),
    parameterValues
  };
}

async function attach(
  fixture: VideoFixture,
  providerOperationId: string,
  feature: 'text_to_video' | 'image_to_video' = 'text_to_video'
): Promise<void> {
  await fixture.adapter.attachOperation({
    routeSnapshot: routeSnapshot(feature),
    providerOperationId,
    invocationAttemptId: toProviderInvocationAttemptId(
      `invocation-attempt-seedance-${feature}`
    ) as ProviderInvocationAttemptId
  });
}

function taskResponse(
  id: string,
  status: 'queued' | 'running' | 'cancelled' | 'succeeded' | 'failed' | 'expired',
  options: { readonly usage?: Record<string, unknown> } = {}
) {
  const hasExplicitUsage = Object.prototype.hasOwnProperty.call(options, 'usage');
  return {
    id,
    model: 'provider-model-name-not-public',
    status,
    error: status === 'failed'
      ? { code: 'provider-detail-code', message: 'provider-detail-message' }
      : null,
    created_at: 1,
    updated_at: 2,
    content: status === 'succeeded'
      ? {
          video_url:
            `https://media.example.test/signed-results/${id}.mp4?signature=private`
        }
      : {},
    duration: 5,
    resolution: '720p',
    ratio: '16:9',
    framespersecond: 24,
    ...((status === 'succeeded' || status === 'failed') &&
      (!hasExplicitUsage || options.usage !== undefined)
      ? {
          usage: hasExplicitUsage
            ? options.usage
            : { completion_tokens: 240, total_tokens: 240 }
        }
      : {})
  };
}

function jsonResponse(
  value: unknown,
  status = 200
): VolcengineHttpTransportResponse {
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

function emptyResponse(status: number): VolcengineHttpTransportResponse {
  return {
    status,
    headers: { 'content-length': '0' },
    body: new Uint8Array()
  };
}

function binaryResponse(
  body: Uint8Array,
  contentType: string
): VolcengineHttpTransportResponse {
  return {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength)
    },
    body
  };
}

function bodyOf(request: VolcengineHttpTransportRequest): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(request.body)
  ) as Record<string, unknown>;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Uint8Array.from(Buffer.concat(chunks));
}
