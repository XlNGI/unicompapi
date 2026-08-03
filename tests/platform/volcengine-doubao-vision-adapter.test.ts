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
  type ProviderConnection,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageSchemaV1
} from '../../src/domain';
import {
  DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID,
  DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID,
  DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID,
  DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID,
  DOUBAO_VISION_ADAPTER_ID,
  DOUBAO_VISION_ADAPTER_VERSION,
  DOUBAO_VISION_CONSTRAINT_SET_ID,
  DOUBAO_VISION_PROTOCOL_ID,
  DOUBAO_VISION_PROTOCOL_VERSION,
  DOUBAO_VISION_USAGE_SCHEMA_ID,
  DoubaoVisionAdapter,
  ProviderPackageRegistry,
  VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  VOLCENGINE_ENDPOINT_POLICY_ID,
  VOLCENGINE_OFFICIAL_BASE_URL,
  VOLCENGINE_OFFICIAL_TEMPLATE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_ID,
  VOLCENGINE_PROVIDER_PACKAGE_VERSION,
  VolcengineSharedRuntime,
  VolcengineTransportFailure,
  buildDoubaoImageToPromptDraft,
  createDoubaoVisionModelDefinition,
  doubaoImageToPromptParameterSchema,
  doubaoImageUnderstandingParameterSchema,
  doubaoVisionRecoveryDecision,
  doubaoVisionUsageSchema,
  mapVolcengineChatUsage,
  volcengineProviderPackageDescriptor,
  type ControlledVisionImagePort,
  type DoubaoVisionAdapterIdFactory,
  type DoubaoVisionConnectionResolverPort,
  type DoubaoVisionCredentialResolverPort,
  type DoubaoVisionUsageObservationSinkPort,
  type VolcengineHttpTransport,
  type VolcengineHttpTransportRequest,
  type VolcengineHttpTransportResponse,
  type VolcengineSafeLogEvent
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-08-03T15:30:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'unit-test-ark-key' }
};
const exactEndpointId = 'ep-20260803-synthetic-vision';

describe('Volcengine official package contracts', () => {
  it('publishes a no-fee-safe manual Endpoint/Model binding without model-name guesses', () => {
    const registry = new ProviderPackageRegistry([
      volcengineProviderPackageDescriptor
    ]);
    expect(registry.listSafeTemplates()).toEqual([{
      packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
      packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
      providerName: 'Volcengine Ark',
      templateId: VOLCENGINE_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      displayName: 'Volcengine Ark Official',
      iconAssetId: undefined,
      baseUrlMode: 'fixed',
      credentialFields: [{
        key: 'api_key',
        label: 'Ark API key',
        secret: true,
        required: true,
        kind: 'token'
      }],
      freeConnectionValidation: false,
      modelDiscoveryKind: 'manual_exact'
    }]);
    expect(JSON.stringify(registry.listSafeTemplates())).not.toMatch(
      /ark\.cn-beijing|chat-completions|endpoint\.volcengine/
    );
    expect(registry.resolveAdapter(
      VOLCENGINE_PROVIDER_PACKAGE_ID,
      DOUBAO_VISION_ADAPTER_ID,
      DOUBAO_VISION_ADAPTER_VERSION,
      DOUBAO_VISION_PROTOCOL_ID,
      DOUBAO_VISION_PROTOCOL_VERSION
    ).operations).toEqual(['submit', 'cancel']);

    const definition = createDoubaoVisionModelDefinition(exactEndpointId);
    expect(definition.providerModelKey).toBe(exactEndpointId);
    expect(definition.definitionId).not.toContain(exactEndpointId);
    expect(definition.profileTemplates[0]).toMatchObject({
      adapterKey: DOUBAO_VISION_ADAPTER_ID,
      protocolDefinitionId: DOUBAO_VISION_PROTOCOL_ID,
      features: [
        {
          productFeature: 'image_understanding',
          internalPurpose: 'image_understanding'
        },
        {
          productFeature: 'image_to_prompt',
          internalPurpose: 'image_to_prompt'
        }
      ]
    });
    expect(createDoubaoVisionModelDefinition(exactEndpointId).definitionId)
      .toBe(definition.definitionId);
    expect(() => createDoubaoVisionModelDefinition('doubao vision guessed'))
      .toThrow('Endpoint/Model ID');

    expect(doubaoImageUnderstandingParameterSchema.fields.map(
      (field) => field.fieldId
    )).toEqual(['detail', 'max_tokens', 'stream', 'thinking', 'response_format']);
    expect(doubaoImageToPromptParameterSchema.fields.map(
      (field) => field.fieldId
    )).toEqual(['detail', 'max_tokens', 'stream', 'thinking', 'response_format']);
    expect(doubaoVisionUsageSchema.metrics.map((metric) => metric.metricId))
      .toEqual([
        'completion_tokens',
        'prompt_tokens',
        'total_tokens',
        'cached_tokens',
        'reasoning_tokens'
      ]);
  });
});

describe('Doubao vision adapter', () => {
  it('sends one controlled Base64 image with strict JSON Schema and parses safe observations', async () => {
    const fixture = visionFixture();
    fixture.transport.responses.push(jsonResponse(visionResponse({
      visibleFacts: ['A red cup is on a wooden table.'],
      modelInferences: ['The lighting appears to come from a nearby window.'],
      uncertainties: ['The cup material cannot be confirmed.'],
      unrecognized: []
    })));
    let requestStarted = 0;
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', {
        detail: 'high',
        max_tokens: 512
      }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });
    await expect(handle.completion).resolves.toEqual({
      state: 'completed',
      providerOperationId: 'doubao-operation-1',
      result: {
        schemaVersion: 1,
        productFeature: 'image_understanding',
        observations: {
          visibleFacts: [{
            id: 'visible-fact-1',
            content: 'A red cup is on a wooden table.'
          }],
          modelInferences: [{
            id: 'model-inference-1',
            content: 'The lighting appears to come from a nearby window.'
          }],
          uncertainties: [{
            id: 'uncertainty-1',
            content: 'The cup material cannot be confirmed.'
          }],
          unrecognized: []
        }
      },
      usageAvailability: 'reported'
    });

    expect(requestStarted).toBe(1);
    expect(fixture.transport.requests).toHaveLength(1);
    const request = fixture.transport.requests[0];
    expect(request).toMatchObject({
      method: 'POST',
      url: `${VOLCENGINE_OFFICIAL_BASE_URL}/chat/completions`,
      redirect: 'manual'
    });
    expect(request.headers.authorization).toBe('Bearer unit-test-ark-key');
    const body = bodyOf(request);
    expect(body).toMatchObject({
      model: exactEndpointId,
      stream: false,
      thinking: { type: 'disabled' },
      max_tokens: 512,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'unicomp_image_observations',
          strict: true,
          schema: {
            type: 'object',
            required: [
              'visibleFacts',
              'modelInferences',
              'uncertainties',
              'unrecognized'
            ],
            additionalProperties: false
          }
        }
      }
    });
    const content = (body.messages as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'image_url',
      image_url: {
        url: 'data:image/png;base64,AQIDBA==',
        detail: 'high'
      }
    });
    expect(content[1].type).toBe('text');
    expect(JSON.stringify(body)).not.toMatch(
      /frequency_penalty|presence_penalty|image_pixel_limit|tools|"n"/
    );
    expect(fixture.usage.observations).toHaveLength(1);
    expect(fixture.usage.observations[0]).toMatchObject({
      status: 'reported',
      facts: [
        { metricId: 'completion_tokens', quantity: '8' },
        { metricId: 'prompt_tokens', quantity: '12' },
        { metricId: 'total_tokens', quantity: '20' },
        { metricId: 'cached_tokens', quantity: '4' },
        { metricId: 'reasoning_tokens', quantity: '2' }
      ]
    });
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /unit-test-ark-key|ep-20260803|synthetic purpose|AQIDBA/
    );
    expect(JSON.stringify(await handle.completion)).not.toMatch(
      /remote-response-id|ep-20260803/
    );
    expect(fixture.adapter.activeOperationCount).toBe(0);
    expect(fixture.runtime.activeRequestCount).toBe(0);
  });

  it('derives image-to-prompt locally and keeps uncertainty out of the final prompt facts', async () => {
    const fixture = visionFixture();
    fixture.transport.responses.push(jsonResponse(visionResponse({
      visibleFacts: ['One cyclist is centered in the frame.'],
      modelInferences: ['The scene suggests an editorial sports photograph.'],
      uncertainties: ['The exact location is unknown.'],
      unrecognized: ['Small jersey text is unreadable.']
    })));
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_to_prompt'),
      request: dispatchRequest('image_to_prompt', {})
    });
    const result = await handle.completion;
    expect(result).toMatchObject({
      state: 'completed',
      result: {
        productFeature: 'image_to_prompt',
        promptDraft: {
          finalPrompt: expect.stringContaining('目标用途：synthetic purpose'),
          systemSupplements: [
            { source: 'model_format', content: '需人工确认：The exact location is unknown.' },
            { source: 'model_format', content: '模型无法确认：Small jersey text is unreadable.' }
          ]
        }
      }
    });
    if (result.state !== 'completed') throw new Error('expected completion');
    expect(result.result.promptDraft?.finalPrompt).toContain(
      'One cyclist is centered in the frame.'
    );
    expect(result.result.promptDraft?.finalPrompt).toContain(
      'keep the single subject'
    );
    expect(result.result.promptDraft?.finalPrompt).not.toContain(
      'exact location is unknown'
    );
  });

  it('fails closed on stale routes, unsupported image facts and unknown parameters before HTTP', async () => {
    const fixture = visionFixture();
    await expect(fixture.adapter.submit({
      routeSnapshot: createProviderExecutionRouteSnapshot({
        ...routeInput('image_understanding'),
        providerModelKey: undefined
      }),
      request: dispatchRequest('image_understanding', {})
    })).rejects.toMatchObject({ safeCode: 'volcengine.route_mismatch' });
    await expect(fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', { temperature: 0.2 })
    })).rejects.toMatchObject({ safeCode: 'volcengine.invalid_request' });

    fixture.images.image = {
      ...fixture.images.image,
      sizeBytes: 10 * 1024 * 1024,
      bytes: new Uint8Array(10 * 1024 * 1024)
    };
    await expect(fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', {})
    })).rejects.toMatchObject({ safeCode: 'volcengine.invalid_image' });
    expect(fixture.transport.requests).toHaveLength(0);
  });

  it('treats moderation, non-stop finishes and server fallback as explicit failures without switching', async () => {
    const fixture = visionFixture();
    fixture.transport.responses.push(
      jsonResponse(visionResponse({}, { moderationHitType: 'policy' })),
      jsonResponse(visionResponse({}, { finishReason: 'length' })),
      jsonResponse(visionResponse({}, { fallbackTriggered: true }))
    );
    const expected = [
      'volcengine.content_filtered',
      'volcengine.finish.length',
      'volcengine.model_fallback'
    ];
    for (const safeCode of expected) {
      const handle = await fixture.adapter.submit({
        routeSnapshot: routeSnapshot('image_understanding'),
        request: dispatchRequest('image_understanding', {})
      });
      await expect(handle.completion).resolves.toEqual({
        state: 'failed',
        providerOperationId: expect.stringMatching(/^doubao-operation-/),
        safeCode
      });
    }
    expect(fixture.transport.requests).toHaveLength(3);
    expect(fixture.usage.observations.every(
      (observation) => observation.status === 'reported'
    )).toBe(true);
  });

  it('rejects malformed structured output and unknown usage fields without exposing response content', async () => {
    const fixture = visionFixture();
    fixture.transport.responses.push(jsonResponse(visionResponse({
      visibleFacts: ['safe'],
      modelInferences: [],
      uncertainties: [],
      unrecognized: [],
      unexpected: ['remote private content']
    })));
    const malformed = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', {})
    });
    await expect(malformed.completion).resolves.toEqual({
      state: 'failed',
      providerOperationId: 'doubao-operation-1',
      safeCode: 'volcengine.invalid_response'
    });
    expect(fixture.usage.observations[0]?.status).toBe('invalid_response');

    fixture.transport.responses.push(jsonResponse(visionResponse({}, {
      usage: {
        completion_tokens: 8,
        prompt_tokens: 12,
        total_tokens: 20,
        billed_dollars: 'forbidden'
      }
    })));
    const usageFailure = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', {})
    });
    await expect(usageFailure.completion).resolves.toMatchObject({
      state: 'failed',
      safeCode: 'volcengine.invalid_response'
    });
    expect(JSON.stringify(await usageFailure.completion)).not.toContain(
      'remote private content'
    );
    expect(fixture.transport.requests).toHaveLength(2);
  });

  it('cancels one active request and records not-reported usage', async () => {
    const fixture = visionFixture();
    fixture.transport.hang = true;
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', {})
    });
    await expect(fixture.adapter.cancel(handle.providerOperationId)).resolves.toBe(true);
    await expect(handle.completion).resolves.toEqual({
      state: 'cancelled',
      providerOperationId: 'doubao-operation-1'
    });
    expect(fixture.usage.observations[0]?.status).toBe('not_reported');
    expect(fixture.adapter.activeOperationCount).toBe(0);
  });

  it('interrupts active requests on shutdown and requires a new user attempt', async () => {
    const fixture = visionFixture();
    fixture.transport.hang = true;
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('image_understanding'),
      request: dispatchRequest('image_understanding', {})
    });
    await fixture.adapter.dispose();
    await expect(handle.completion).resolves.toEqual({
      state: 'interrupted',
      providerOperationId: 'doubao-operation-1',
      reason: 'application_shutdown'
    });
    expect(fixture.usage.observations[0]?.status).toBe('unknown_outcome');
    expect(doubaoVisionRecoveryDecision('interrupted')).toEqual({
      sameOperationResumable: false,
      action: 'user_retry_required'
    });
  });
});

describe('Volcengine runtime and usage safety', () => {
  it('maps official HTTP status classes and never retries automatically', async () => {
    const transport = new SyntheticTransport();
    const statuses = [400, 401, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504] as const;
    transport.responses.push(...statuses.map((status) =>
      jsonResponse({}, status, status === 429 ? { 'retry-after': '3' } : {})
    ));
    const runtime = new VolcengineSharedRuntime({ transport });
    const expected = [
      'invalid_request',
      'authentication_failed',
      'permission_denied',
      'model_not_found',
      'timeout',
      'request_too_large',
      'invalid_parameters',
      'rate_limited',
      'provider_unavailable',
      'provider_unavailable',
      'provider_unavailable',
      'timeout'
    ];
    for (const code of expected) {
      await expect(runtime.requestVisionChat({
        connection: officialConnection(),
        credentials: credential,
        body: new TextEncoder().encode('{}')
      })).rejects.toMatchObject({ code });
    }
    expect(transport.requests).toHaveLength(statuses.length);
  });

  it('accepts only the versioned token usage whitelist and a deterministic local prompt contract', () => {
    expect(mapVolcengineChatUsage({
      completion_tokens: 10,
      prompt_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 3 }
    })).toHaveLength(5);
    expect(() => mapVolcengineChatUsage({
      completion_tokens: 10,
      prompt_tokens: 20,
      total_tokens: 31
    })).toThrow('inconsistent');
    expect(() => mapVolcengineChatUsage({
      completion_tokens: 10,
      prompt_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { image_tokens: 20 }
    })).toThrow('unsupported fields');

    expect(buildDoubaoImageToPromptDraft({
      purpose: 'Generate an editorial image',
      requirements: ['Keep the subject centered'],
      observations: {
        visibleFacts: [{ id: 'fact-1', content: 'One cyclist' }],
        modelInferences: [],
        uncertainties: [],
        unrecognized: []
      }
    })).toEqual({
      finalPrompt:
        '目标用途：Generate an editorial image\n' +
        '画面中可直接确认的内容：One cyclist\n' +
        '补充要求：Keep the subject centered',
      systemSupplements: []
    });
  });
});

function visionFixture() {
  const transport = new SyntheticTransport();
  const logs: VolcengineSafeLogEvent[] = [];
  const runtime = new VolcengineSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    now: () => 100
  });
  const usage = new RecordingUsageSink();
  const credentials = new RecordingCredentialResolver();
  const connections = new RecordingConnectionResolver();
  const images = new RecordingImageResolver();
  let operationSequence = 0;
  let usageSequence = 0;
  const ids: DoubaoVisionAdapterIdFactory = {
    nextProviderOperationId: () =>
      `doubao-operation-${++operationSequence}`,
    nextProviderUsageObservationId: () =>
      toProviderUsageObservationId(`doubao-usage-${++usageSequence}`)
  };
  return {
    transport,
    logs,
    runtime,
    usage,
    credentials,
    connections,
    images,
    adapter: new DoubaoVisionAdapter(
      runtime,
      connections,
      credentials,
      images,
      usage,
      ids,
      {},
      () => timestamp
    )
  };
}

class RecordingUsageSink implements DoubaoVisionUsageObservationSinkPort {
  readonly observations: ProviderUsageObservationV1[] = [];
  readonly schemas: UsageSchemaV1[] = [];
  async append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1) {
    this.observations.push(observation);
    this.schemas.push(schema);
  }
}

class RecordingCredentialResolver implements DoubaoVisionCredentialResolverPort {
  readonly calls: { connectionId: string; credentialVersionId: string }[] = [];
  async useCredential<T>(
    input: { connectionId: string; credentialVersionId: string },
    operation: (value: StructuredCredentialRecord) => Promise<T>
  ): Promise<T> {
    this.calls.push(input);
    return operation(credential);
  }
}

class RecordingConnectionResolver implements DoubaoVisionConnectionResolverPort {
  readonly connection = officialConnection();
  async get(connectionId: string): Promise<ProviderConnection | undefined> {
    return connectionId === this.connection.id ? this.connection : undefined;
  }
}

class RecordingImageResolver implements ControlledVisionImagePort {
  image = {
    assetId: 'asset-doubao-controlled',
    mimeType: 'image/png',
    width: 32,
    height: 32,
    sizeBytes: 4,
    bytes: Uint8Array.from([1, 2, 3, 4])
  };
  async resolve() {
    return this.image;
  }
}

class SyntheticTransport implements VolcengineHttpTransport {
  readonly requests: VolcengineHttpTransportRequest[] = [];
  readonly responses: VolcengineHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];
  hang = false;

  async send(request: VolcengineHttpTransportRequest): Promise<VolcengineHttpTransportResponse> {
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      body: Uint8Array.from(request.body)
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    if (this.hang) {
      await new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new VolcengineTransportFailure('cancelled'));
        if (request.signal.aborted) fail();
        else request.signal.addEventListener('abort', fail, { once: true });
      });
    }
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic Volcengine response is missing');
    return response;
  }
}

function officialConnection(): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-volcengine-official'),
    providerId: toProviderId('provider-volcengine-official'),
    name: 'Volcengine Ark Official',
    endpoint: `${VOLCENGINE_OFFICIAL_BASE_URL}/`,
    packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
    packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
    templateId: VOLCENGINE_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: VOLCENGINE_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-volcengine-1',
    connectionPolicyId: 'connection.volcengine.ark.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.volcengine.ark.manual-endpoint',
    discoveryPolicyRevision: 1,
    endpointPolicyId: VOLCENGINE_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-volcengine-1',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: DOUBAO_VISION_ADAPTER_ID,
      adapterVersion: DOUBAO_VISION_ADAPTER_VERSION,
      protocolId: DOUBAO_VISION_PROTOCOL_ID,
      protocolVersion: DOUBAO_VISION_PROTOCOL_VERSION
    }],
    state: 'available',
    identityState: 'verified',
    credentialState: 'valid',
    credentialReference: 'credential-volcengine-official',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function routeSnapshot(feature: 'image_understanding' | 'image_to_prompt') {
  return createProviderExecutionRouteSnapshot(routeInput(feature));
}

function routeInput(feature: 'image_understanding' | 'image_to_prompt') {
  return {
    id: toProviderExecutionRouteSnapshotId(`route-doubao-${feature}`),
    projectId: toProjectId('project-doubao'),
    packageId: VOLCENGINE_PROVIDER_PACKAGE_ID,
    packageVersion: VOLCENGINE_PROVIDER_PACKAGE_VERSION,
    adapterKey: DOUBAO_VISION_ADAPTER_ID,
    adapterVersion: DOUBAO_VISION_ADAPTER_VERSION,
    providerId: toProviderId('provider-volcengine-official'),
    connectionId: toConnectionId('connection-volcengine-official'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-volcengine-1',
    endpointPolicyId: VOLCENGINE_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-volcengine-1',
    modelId: toModelId(`model-doubao-${feature}`),
    providerModelKey: exactEndpointId,
    modelRevision: 1,
    profileId: `profile-doubao-${feature}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-doubao-vision'),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: feature,
    featureMappingVersion: 1,
    parameterSchemaId: feature === 'image_understanding'
      ? DOUBAO_IMAGE_UNDERSTANDING_PARAMETER_SCHEMA_ID
      : DOUBAO_IMAGE_TO_PROMPT_PARAMETER_SCHEMA_ID,
    parameterSchemaRevision: 1,
    resultSchemaId: feature === 'image_understanding'
      ? DOUBAO_IMAGE_UNDERSTANDING_RESULT_SCHEMA_ID
      : DOUBAO_IMAGE_TO_PROMPT_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(DOUBAO_VISION_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: DOUBAO_VISION_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.volcengine.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-volcengine-synthetic',
    createdAt: timestamp
  } as const;
}

function dispatchRequest(
  feature: 'image_understanding' | 'image_to_prompt',
  parameterValues: Record<string, unknown>
) {
  return {
    invocationAttemptId: toProviderInvocationAttemptId(
      `invocation-attempt-${feature}`
    ),
    projectId: 'project-doubao',
    assetId: 'asset-doubao-controlled',
    purpose: 'synthetic purpose',
    requirements: feature === 'image_to_prompt'
      ? ['keep the single subject']
      : [],
    region: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
    parameterValues
  };
}

function visionResponse(
  observations: Record<string, unknown>,
  options: {
    readonly finishReason?: string;
    readonly moderationHitType?: string;
    readonly fallbackTriggered?: boolean;
    readonly usage?: Record<string, unknown>;
  } = {}
) {
  const normalized = Object.keys(observations).length > 0
    ? observations
    : {
        visibleFacts: [],
        modelInferences: [],
        uncertainties: [],
        unrecognized: []
      };
  return {
    id: 'remote-response-id-not-public',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify(normalized)
      },
      finish_reason: options.finishReason ?? 'stop',
      logprobs: null,
      ...(options.moderationHitType
        ? { moderation_hit_type: options.moderationHitType }
        : {})
    }],
    created: 1,
    model: 'remote-actual-model-not-public',
    object: 'chat.completion',
    usage: options.usage ?? {
      completion_tokens: 8,
      prompt_tokens: 12,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 }
    },
    ...(options.fallbackTriggered !== undefined
      ? {
          service_status: {
            model_fallback: {
              fallback_triggered: options.fallbackTriggered,
              original_model: exactEndpointId
            }
          }
        }
      : {})
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): VolcengineHttpTransportResponse {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      ...headers
    },
    body
  };
}

function bodyOf(
  request: VolcengineHttpTransportRequest
): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(request.body)
  ) as Record<string, unknown>;
}
