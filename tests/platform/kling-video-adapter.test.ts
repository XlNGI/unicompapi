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
  KLING_CREDENTIAL_SCHEMA_ID,
  KLING_ENDPOINT_POLICY_ID,
  KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
  KLING_OFFICIAL_BASE_URL,
  KLING_OFFICIAL_TEMPLATE_ID,
  KLING_PROVIDER_PACKAGE_ID,
  KLING_PROVIDER_PACKAGE_VERSION,
  KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID,
  KLING_VIDEO_ADAPTER_ID,
  KLING_VIDEO_ADAPTER_VERSION,
  KLING_VIDEO_PROTOCOL_ID,
  KLING_VIDEO_PROTOCOL_VERSION,
  KLING_VIDEO_RESULT_SCHEMA_ID,
  KLING_VIDEO_USAGE_SCHEMA_ID,
  KlingSharedRuntime,
  KlingTransportFailure,
  KlingVideoAdapter,
  ProviderPackageRegistry,
  createKlingVideoModelContract,
  klingProviderPackageDescriptor,
  klingVideoRecoveryDecision,
  klingVideoUsageSchema,
  mapKlingVideoBilling,
  type ControlledKlingImagePort,
  type KlingHttpTransport,
  type KlingHttpTransportRequest,
  type KlingHttpTransportResponse,
  type KlingSafeLogEvent,
  type KlingVideoConnectionResolverPort,
  type KlingVideoCredentialResolverPort,
  type KlingVideoParameterSchemaResolverPort,
  type KlingVideoUsageObservationSinkPort
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-08-03T18:00:00.000Z');
const exactModelKey = 'kling-3.0-turbo-synthetic';
const credential: StructuredCredentialRecord = {
  schemaId: KLING_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'unit-test-kling-key' }
};
const modelContract = createKlingVideoModelContract(exactModelKey, {
  textToVideo: {
    resolutions: ['720p', '1080p'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    durations: [3, 5, 10, 15],
    supportsWatermark: true
  },
  imageToVideo: {
    resolutions: ['720p', '1080p'],
    durations: [3, 5, 10, 15],
    supportsWatermark: true
  }
});

describe('Kling official contracts', () => {
  it('publishes one exact API 2.0 adapter and derives capability only from a declared Profile', () => {
    const registry = new ProviderPackageRegistry([klingProviderPackageDescriptor]);
    expect(registry.resolveAdapter(
      KLING_PROVIDER_PACKAGE_ID,
      KLING_VIDEO_ADAPTER_ID,
      KLING_VIDEO_ADAPTER_VERSION,
      KLING_VIDEO_PROTOCOL_ID,
      KLING_VIDEO_PROTOCOL_VERSION
    ).operations).toEqual(['submit', 'query', 'cancel', 'receive_result']);
    expect(registry.resolveTemplate(
      KLING_PROVIDER_PACKAGE_ID,
      KLING_OFFICIAL_TEMPLATE_ID
    ).endpointPolicy.fixedBaseUrl).toBe(KLING_OFFICIAL_BASE_URL);

    expect(modelContract.definition.providerModelKey).toBe(exactModelKey);
    expect(modelContract.definition.definitionId).not.toContain(exactModelKey);
    expect(modelContract.definition.profileTemplates[0]).toMatchObject({
      adapterKey: KLING_VIDEO_ADAPTER_ID,
      protocolDefinitionId: KLING_VIDEO_PROTOCOL_ID,
      features: [
        {
          productFeature: 'text_to_video',
          internalPurpose: 'video_generation',
          resultSchemaId: KLING_VIDEO_RESULT_SCHEMA_ID,
          usageSchemaId: KLING_VIDEO_USAGE_SCHEMA_ID,
          constraintSetId: KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
        },
        {
          productFeature: 'image_to_video',
          internalPurpose: 'reference_to_video',
          constraintSetId: KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID
        }
      ]
    });
    expect(schemaFor('text_to_video').fields.map((field) => field.fieldId))
      .toEqual(['resolution', 'aspect_ratio', 'duration', 'watermark']);
    expect(schemaFor('image_to_video').fields.map((field) => field.fieldId))
      .toEqual(['resolution', 'duration', 'watermark']);
    expect(klingVideoUsageSchema.metrics.map((metric) => metric.metricId))
      .toEqual([
        'billing_entry_count',
        'cash_amount',
        'cash_list_price',
        'package_unit_amount'
      ]);

    const narrower = createKlingVideoModelContract(exactModelKey, {
      textToVideo: { durations: [5] }
    });
    expect(narrower.definition.definitionId)
      .not.toBe(modelContract.definition.definitionId);
    expect(narrower.parameterSchemas[0].fields.map((field) => field.fieldId))
      .toEqual(['duration']);
    expect(() => createKlingVideoModelContract(exactModelKey, {}))
      .toThrow('at least one');
    expect(() => createKlingVideoModelContract(exactModelKey, {
      imageToVideo: { aspectRatios: ['16:9'] }
    } as never)).toThrow('unknown fields');
    expect(() => createKlingVideoModelContract('guessed/model', {
      textToVideo: { durations: [5] }
    })).toThrow('endpoint key');
  });
});

describe('Kling video adapter', () => {
  it('submits pure text-to-video to the exact model endpoint without material or hidden options', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse(createResponse('kling-task-text')));
    let requestStarted = 0;
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', {
        resolution: '1080p',
        aspect_ratio: '16:9',
        duration: 10,
        watermark: false
      }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });

    expect(outcome).toEqual({
      kind: 'accepted_async',
      providerOperationId: 'kling-task-text',
      state: 'queued'
    });
    expect(requestStarted).toBe(1);
    expect(fixture.images.calls).toEqual([]);
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'POST',
      url: `${KLING_OFFICIAL_BASE_URL}/text-to-video/${exactModelKey}`,
      redirect: 'manual'
    });
    const body = bodyOf(fixture.transport.requests[0]);
    expect(body).toEqual({
      prompt: 'A controlled synthetic prompt',
      settings: {
        resolution: '1080p',
        aspect_ratio: '16:9',
        duration: 10
      },
      options: { watermark_info: { enabled: false } }
    });
    expect(JSON.stringify(body)).not.toMatch(
      /contents|callback_url|external_task_id|model|tools|image/
    );
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /unit-test-kling-key|kling-3\.0|controlled synthetic prompt/
    );
  });

  it('submits one controlled project JPG or PNG only as the first frame', async () => {
    const fixture = videoFixture();
    fixture.transport.responses.push(jsonResponse(createResponse('kling-task-image')));
    const outcome = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_to_video'),
      request: dispatchRequest('image_to_video', {
        resolution: '720p',
        duration: 5,
        watermark: true
      })
    });

    expect(outcome.kind).toBe('accepted_async');
    expect(fixture.images.calls).toEqual([{
      projectId: 'project-kling',
      assetId: 'asset-kling-first-frame'
    }]);
    expect(fixture.transport.requests[0].url).toBe(
      `${KLING_OFFICIAL_BASE_URL}/image-to-video/${exactModelKey}`
    );
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      contents: [
        { type: 'prompt', text: 'A controlled synthetic prompt' },
        {
          type: 'first_frame',
          url: 'data:image/png;base64,AQIDBA=='
        }
      ],
      settings: { resolution: '720p', duration: 5 },
      options: { watermark_info: { enabled: true } }
    });
  });

  it('closes references on text, missing first frames, unknown JSON, and unsupported image formats before HTTP', async () => {
    const cases: Array<{
      feature: 'text_to_video' | 'image_to_video';
      request: Record<string, unknown>;
      mutate?: (fixture: VideoFixture) => void;
    }> = [
      {
        feature: 'text_to_video',
        request: {
          ...dispatchRequest('text_to_video', {}),
          assetId: 'asset-forbidden'
        }
      },
      {
        feature: 'image_to_video',
        request: {
          ...dispatchRequest('image_to_video', {}),
          assetId: undefined
        }
      },
      {
        feature: 'text_to_video',
        request: dispatchRequest('text_to_video', {
          callback_url: 'https://callback.example.test'
        })
      },
      {
        feature: 'image_to_video',
        request: dispatchRequest('image_to_video', {}),
        mutate: (fixture) => { fixture.images.image.mimeType = 'image/webp'; }
      }
    ];
    for (const item of cases) {
      const fixture = videoFixture();
      item.mutate?.(fixture);
      await expect(fixture.adapter.submit({
        routeSnapshot: routeSnapshot(item.feature),
        request: item.request
      })).resolves.toMatchObject({
        kind: 'failed_before_submission',
        retryability: 'not_retryable'
      });
      expect(fixture.transport.requests).toHaveLength(0);
      expect(fixture.credentials.calls).toHaveLength(0);
    }
  });

  it('records an unknown submission outcome after request-start ambiguity and never retries', async () => {
    const fixture = videoFixture();
    fixture.transport.failures.push(new KlingTransportFailure('network'));
    await expect(fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', { duration: 5 })
    })).resolves.toEqual({
      kind: 'submission_outcome_unknown',
      message: 'The Kling video submission outcome is unknown'
    });
    expect(fixture.transport.requests).toHaveLength(1);
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
    expect(rejected.usage.observations[0]).toMatchObject({
      status: 'not_reported',
      facts: []
    });
  });

  it.each([
    ['submitted', { state: 'queued' }],
    ['processing', { state: 'processing' }],
    ['succeeded', { state: 'completed' }],
    ['failed', {
      state: 'failed',
      message: 'Kling reported that the video task failed',
      retryability: 'not_retryable'
    }]
  ] as const)('maps the official %s status without exposing provider details', async (
    status,
    expected
  ) => {
    const fixture = videoFixture();
    await attach(fixture, `kling-task-${status}`);
    fixture.transport.responses.push(jsonResponse(taskResponse(
      `kling-task-${status}`,
      status
    )));
    await expect(fixture.adapter.query(`kling-task-${status}`))
      .resolves.toEqual(expected);
    const terminal = status === 'succeeded' || status === 'failed';
    expect(fixture.usage.observations).toHaveLength(terminal ? 1 : 0);
    expect(JSON.stringify(expected)).not.toContain('provider-detail');
  });

  it('persists complete, missing, and malformed billing exactly once', async () => {
    expect(mapKlingVideoBilling([
      {
        charge_type: 'cash',
        cash_type: 'balance',
        amount: '1.20',
        list_price: '1.50'
      },
      {
        charge_type: 'cash',
        cash_type: 'test_balance',
        amount: '0.30',
        list_price: '0.50'
      },
      {
        charge_type: 'unit',
        amount: '18.0',
        package_type: 'video'
      }
    ])).toEqual([
      usageFact('billing_entry_count', '3', 'entry'),
      usageFact('cash_amount', '1.5', 'currency_amount'),
      usageFact('cash_list_price', '2', 'currency_amount'),
      usageFact('package_unit_amount', '18', 'provider_unit')
    ]);
    expect(() => mapKlingVideoBilling([{
      charge_type: 'unit',
      amount: '1',
      package_type: 'image'
    }])).toThrow('package billing');
    expect(() => mapKlingVideoBilling([{
      charge_type: 'cash',
      amount: 'NaN',
      list_price: '1'
    }])).toThrow('decimal');

    const missing = videoFixture();
    await attach(missing, 'kling-task-no-billing');
    missing.transport.responses.push(jsonResponse(taskResponse(
      'kling-task-no-billing',
      'succeeded',
      { billing: undefined }
    )));
    await expect(missing.adapter.query('kling-task-no-billing'))
      .resolves.toEqual({ state: 'completed' });
    expect(missing.usage.observations[0]).toMatchObject({
      status: 'not_reported',
      facts: []
    });

    const invalid = videoFixture();
    await attach(invalid, 'kling-task-bad-billing');
    invalid.transport.responses.push(jsonResponse(taskResponse(
      'kling-task-bad-billing',
      'succeeded',
      { billing: [{ charge_type: 'cash', amount: '-1', list_price: '1' }] }
    )));
    await expect(invalid.adapter.query('kling-task-bad-billing'))
      .rejects.toThrow('decimal');
    expect(invalid.usage.observations[0]).toMatchObject({
      status: 'invalid_response',
      facts: []
    });
  });

  it('does not invent a remote cancel endpoint and keeps the operation processing', async () => {
    const fixture = videoFixture();
    await attach(fixture, 'kling-task-no-cancel-api');
    await expect(fixture.adapter.cancel('kling-task-no-cancel-api'))
      .resolves.toEqual({ state: 'processing' });
    expect(fixture.transport.requests).toHaveLength(0);
    expect(fixture.credentials.calls).toHaveLength(0);
    expect(fixture.usage.observations).toHaveLength(0);
  });

  it('keeps protected URLs out of descriptors and logs and enforces the official 30-day window', async () => {
    const fixture = videoFixture();
    await attach(fixture, 'kling-task-result');
    fixture.transport.responses.push(jsonResponse(taskResponse(
      'kling-task-result',
      'succeeded'
    )));
    const descriptors = await fixture.adapter.listResults('kling-task-result');
    expect(descriptors).toEqual([{
      remoteResultId: 'video',
      name: 'kling-video',
      declaredMimeType: 'video/mp4',
      declaredContainer: 'mp4'
    }]);
    expect(JSON.stringify(descriptors)).not.toContain('protected-results');

    fixture.transport.responses.push(jsonResponse(taskResponse(
      'kling-task-result',
      'succeeded'
    )));
    fixture.transport.responses.push(binaryResponse(
      Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]),
      'video/mp4'
    ));
    const stream = await fixture.adapter.openDownload('kling-task-result', 'video');
    expect(await readAll(stream)).toEqual(
      Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112])
    );
    expect(fixture.transport.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: 'https://media.example.test/protected-results/kling-task-result.mp4?signature=private'
    });
    expect(fixture.transport.requests.at(-1)?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /protected-results|signature=private|unit-test-kling-key|kling-3\.0/
    );

    const expired = videoFixture();
    await attach(expired, 'kling-task-expired');
    expired.clock.now = 1_000 + 30 * 24 * 60 * 60 * 1_000;
    expired.transport.responses.push(jsonResponse(taskResponse(
      'kling-task-expired',
      'succeeded'
    )));
    await expect(expired.adapter.openDownload('kling-task-expired', 'video'))
      .rejects.toThrow('expired');
    expect(expired.transport.requests).toHaveLength(1);
  });

  it('reattaches the same operation after restart with the immutable RouteSnapshot', async () => {
    const first = videoFixture();
    first.transport.responses.push(jsonResponse(createResponse('kling-task-restart')));
    const outcome = await first.adapter.submit({
      routeSnapshot: routeSnapshot('text_to_video'),
      request: dispatchRequest('text_to_video', { duration: 5 })
    });
    expect(outcome.kind).toBe('accepted_async');
    first.adapter.dispose();

    const restarted = videoFixture();
    await restarted.adapter.attachOperation({
      routeSnapshot: routeSnapshot('text_to_video'),
      providerOperationId: 'kling-task-restart',
      invocationAttemptId: toProviderInvocationAttemptId(
        'invocation-attempt-kling-text_to_video'
      )
    });
    restarted.transport.responses.push(jsonResponse(taskResponse(
      'kling-task-restart',
      'processing'
    )));
    await expect(restarted.adapter.query('kling-task-restart'))
      .resolves.toEqual({ state: 'processing' });
    expect(restarted.transport.requests[0]).toMatchObject({
      method: 'GET',
      url: `${KLING_OFFICIAL_BASE_URL}/tasks?task_ids=kling-task-restart`
    });
    expect(klingVideoRecoveryDecision('processing')).toEqual({
      sameOperationResumable: true,
      action: 'attach_and_query'
    });
    expect(klingVideoRecoveryDecision('unknown_outcome')).toEqual({
      sameOperationResumable: false,
      action: 'user_retry_required'
    });
  });
});

function videoFixture() {
  const transport = new SyntheticTransport();
  const logs: KlingSafeLogEvent[] = [];
  const runtime = new KlingSharedRuntime({
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
    adapter: new KlingVideoAdapter(
      runtime,
      connections,
      credentials,
      parameterSchemas,
      images,
      usage,
      {
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId(`kling-usage-${++usageSequence}`)
      },
      () => timestamp,
      () => clock.now
    )
  };
}

type VideoFixture = ReturnType<typeof videoFixture>;

class RecordingConnectionResolver implements KlingVideoConnectionResolverPort {
  readonly connection = officialConnection();
  async get(connectionId: string): Promise<ProviderConnection | undefined> {
    return connectionId === this.connection.id ? this.connection : undefined;
  }
}

class RecordingCredentialResolver implements KlingVideoCredentialResolverPort {
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
  implements KlingVideoParameterSchemaResolverPort {
  async get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined> {
    return modelContract.parameterSchemas.find(
      (schema) => schema.schemaId === schemaId && schema.revision === revision
    );
  }
}

class RecordingImageResolver implements ControlledKlingImagePort {
  readonly calls: { projectId: string; assetId: string }[] = [];
  image = {
    assetId: 'asset-kling-first-frame',
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

class RecordingUsageSink implements KlingVideoUsageObservationSinkPort {
  readonly observations: ProviderUsageObservationV1[] = [];
  readonly schemas: UsageSchemaV1[] = [];
  async append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1) {
    this.observations.push(observation);
    this.schemas.push(schema);
  }
}

class SyntheticTransport implements KlingHttpTransport {
  readonly requests: KlingHttpTransportRequest[] = [];
  readonly responses: KlingHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: KlingHttpTransportRequest): Promise<KlingHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic Kling response is missing');
    return response;
  }
}

function officialConnection(): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-kling-video'),
    providerId: toProviderId('provider-kling-official'),
    name: 'Kling AI Official',
    endpoint: `${KLING_OFFICIAL_BASE_URL}/`,
    packageId: KLING_PROVIDER_PACKAGE_ID,
    packageVersion: KLING_PROVIDER_PACKAGE_VERSION,
    templateId: KLING_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: KLING_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-kling-1',
    connectionPolicyId: 'connection.kling.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.kling.manual-exact',
    discoveryPolicyRevision: 1,
    endpointPolicyId: KLING_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-kling-1',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: KLING_VIDEO_ADAPTER_ID,
      adapterVersion: KLING_VIDEO_ADAPTER_VERSION,
      protocolId: KLING_VIDEO_PROTOCOL_ID,
      protocolVersion: KLING_VIDEO_PROTOCOL_VERSION
    }],
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-kling-video',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function routeSnapshot(feature: 'text_to_video' | 'image_to_video') {
  const schema = schemaFor(feature);
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-kling-${feature}`),
    projectId: toProjectId('project-kling'),
    packageId: KLING_PROVIDER_PACKAGE_ID,
    packageVersion: KLING_PROVIDER_PACKAGE_VERSION,
    adapterKey: KLING_VIDEO_ADAPTER_ID,
    adapterVersion: KLING_VIDEO_ADAPTER_VERSION,
    providerId: toProviderId('provider-kling-official'),
    connectionId: toConnectionId('connection-kling-video'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-kling-1',
    endpointPolicyId: KLING_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-kling-1',
    modelId: toModelId(`model-kling-${feature}`),
    providerModelKey: exactModelKey,
    modelRevision: 1,
    profileId: `profile-kling-${feature}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-kling-video'),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: feature === 'text_to_video'
      ? 'video_generation'
      : 'reference_to_video',
    featureMappingVersion: 1,
    parameterSchemaId: schema.schemaId,
    parameterSchemaRevision: schema.revision,
    resultSchemaId: KLING_VIDEO_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(KLING_VIDEO_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: feature === 'text_to_video'
      ? KLING_TEXT_TO_VIDEO_CONSTRAINT_SET_ID
      : KLING_IMAGE_TO_VIDEO_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.kling.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-kling-synthetic',
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
      `invocation-attempt-kling-${feature}`
    ),
    projectId: 'project-kling',
    prompt: 'A controlled synthetic prompt',
    ...(feature === 'image_to_video'
      ? { assetId: 'asset-kling-first-frame' }
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
      `invocation-attempt-kling-${feature}`
    ) as ProviderInvocationAttemptId
  });
}

function createResponse(id: string) {
  return {
    code: 0,
    message: '',
    request_id: `request-${id}`,
    data: {
      id,
      status: 'submitted',
      create_time: 1_000,
      update_time: 1_001,
      external_id: ''
    }
  };
}

function taskResponse(
  id: string,
  status: 'submitted' | 'processing' | 'succeeded' | 'failed',
  options: { readonly billing?: unknown } = {}
) {
  const hasExplicitBilling = Object.prototype.hasOwnProperty.call(options, 'billing');
  return {
    code: 0,
    message: '',
    request_id: `request-${id}`,
    data: [{
      id,
      status,
      message: status === 'failed' ? 'provider-detail-message' : '',
      create_time: 1_000,
      update_time: 1_100,
      external_id: '',
      ...(status === 'succeeded'
        ? {
            outputs: [{
              type: 'video',
              id: `output-${id}`,
              url:
                `https://media.example.test/protected-results/${id}.mp4?signature=private`,
              duration: '5'
            }]
          }
        : { outputs: [] }),
      ...((status === 'succeeded' || status === 'failed') &&
        (!hasExplicitBilling || options.billing !== undefined)
        ? {
            billing: hasExplicitBilling
              ? options.billing
              : [{
                  charge_type: 'cash',
                  cash_type: 'balance',
                  amount: '1.20',
                  list_price: '1.50'
                }]
          }
        : {})
    }]
  };
}

function jsonResponse(
  value: unknown,
  status = 200
): KlingHttpTransportResponse {
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

function emptyResponse(status: number): KlingHttpTransportResponse {
  return {
    status,
    headers: { 'content-length': '0' },
    body: new Uint8Array()
  };
}

function binaryResponse(
  body: Uint8Array,
  contentType: string
): KlingHttpTransportResponse {
  return {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength)
    },
    body
  };
}

function bodyOf(request: KlingHttpTransportRequest): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(request.body)
  ) as Record<string, unknown>;
}

function usageFact(metricId: string, quantity: string, unit: string) {
  return { metricId, quantity, unit, source: 'provider_body' };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Uint8Array.from(Buffer.concat(chunks));
}
