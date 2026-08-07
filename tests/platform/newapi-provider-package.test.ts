import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
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
  type ConversationResponseExecutionId,
  type ParameterSchemaV2,
  type ProviderConnection,
  type ProviderExecutionRouteSnapshotV1,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageSchemaV1
} from '../../src/domain';
import {
  NewApiChatAdapter,
  NewApiImageAdapter,
  NewApiManagementAdapter,
  NewApiSharedRuntime,
  NewApiTransportFailure,
  NewApiVideoAdapter,
  ProviderPackageRegistry,
  createNewApiModelContract,
  createOpenAiCompatibleDefaultImageDefinition,
  createOpenAiCompatibleDefaultTextDefinition,
  createOpenAiCompatibleDefaultVideoDefinition,
  mapNewApiImageUsage,
  mapNewApiUsage,
  newApiDefaultTextChatParameterSchema,
  newApiDefaultTextReasoningParameterSchema,
  newApiDefaultTextToImageParameterSchema,
  newApiDefaultTextToVideoParameterSchema,
  newApiProviderPackageDescriptor,
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_RESULT_SCHEMA_ID,
  NEWAPI_CHAT_USAGE_SCHEMA_ID,
  NEWAPI_COMPATIBLE_TEMPLATE_ID,
  NEWAPI_CREDENTIAL_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
  NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
  NEWAPI_ENDPOINT_POLICY_ID,
  NEWAPI_IMAGE_ADAPTER_ID,
  NEWAPI_IMAGE_CONSTRAINT_SET_ID,
  NEWAPI_IMAGE_RESULT_SCHEMA_ID,
  NEWAPI_IMAGE_USAGE_SCHEMA_ID,
  NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_TEXT_CONSTRAINT_SET_ID,
  NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID,
  NEWAPI_VIDEO_ADAPTER_ID,
  NEWAPI_VIDEO_RESULT_SCHEMA_ID,
  NEWAPI_VIDEO_USAGE_SCHEMA_ID,
  UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
  UNICOMPAPI_ENDPOINT_POLICY_ID,
  UNICOMPAPI_OFFICIAL_BASE_URL,
  UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_ID,
  UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
  unicompapiProviderPackageDescriptor,
  type ControlledNewApiImageV1,
  type NewApiHttpTransport,
  type NewApiHttpTransportRequest,
  type NewApiHttpTransportResponse
} from '../../src/platform';

const modelKey = 'tenant-deployment-42';
const modelContract = createNewApiModelContract(modelKey, {
  textChat: {
    maxTokens: { minimum: 1, maximum: 8192 },
    temperature: { minimum: 0, maximum: 2 }
  },
  textReasoning: {
    maxTokens: { minimum: 1, maximum: 16384 },
    reasoningEfforts: ['low', 'medium', 'high']
  },
  textToImage: {
    sizes: ['1024x1024'],
    outputFormats: ['png']
  },
  textToVideo: {
    durations: [5, 10],
    widths: [1280],
    heights: [720]
  },
  imageToVideo: {
    durations: [5],
    frameRates: [24],
    supportsSeed: true
  }
});

describe('NewAPI package and dynamic model contracts', () => {
  it('registers one compatible package with three exact protocol adapters', () => {
    const registry = new ProviderPackageRegistry([newApiProviderPackageDescriptor]);
    const template = registry.resolveTemplate(
      NEWAPI_PROVIDER_PACKAGE_ID,
      NEWAPI_COMPATIBLE_TEMPLATE_ID
    );
    expect(template.template.kind).toBe('compatible_custom');
    expect(template.adapters.map((adapter) => adapter.adapterId)).toEqual([
      NEWAPI_CHAT_ADAPTER_ID,
      NEWAPI_IMAGE_ADAPTER_ID,
      NEWAPI_VIDEO_ADAPTER_ID
    ]);
    expect(registry.resolveEndpoint(
      template,
      'https://gateway.example.test/v1',
      false
    )).toBe('https://gateway.example.test/v1');
    expect(registry.resolveEndpoint(
      template,
      'http://127.0.0.1:3000/v1',
      true
    )).toBe('http://127.0.0.1:3000/v1');
    for (const endpoint of [
      'http://gateway.example.test/v1',
      'https://10.1.2.3/v1',
      'https://gateway.example.test/api',
      'https://user:secret@gateway.example.test/v1'
    ]) {
      expect(() => registry.resolveEndpoint(template, endpoint, false)).toThrow();
    }
  });

  it('publishes only explicitly declared features and never guesses from model names', () => {
    const features = modelContract.definition.profileTemplates
      .flatMap((profile) => profile.features.map((feature) => feature.productFeature));
    expect(features).toEqual([
      'text_chat',
      'text_reasoning',
      'text_to_image',
      'text_to_video',
      'image_to_video'
    ]);
    expect(features).not.toContain('image_edit');
    expect(modelContract.parameterSchemas).toHaveLength(5);
    expect(() => createNewApiModelContract('looks-like-image-model', {})).toThrow(
      'at least one feature'
    );
    expect(() => createNewApiModelContract(modelKey, {
      textToImage: { sizes: ['1024x1024'], unknown: true } as never
    })).toThrow('unknown field');
  });

  it('publishes optional-field default text schemas for UniCompAPI chat soft routing', () => {
    const definition = createOpenAiCompatibleDefaultTextDefinition({
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
      providerModelKey: 'qwen-plus'
    });
    expect(definition.profileTemplates[0]).toMatchObject({
      adapterKey: NEWAPI_CHAT_ADAPTER_ID,
      features: [
        {
          productFeature: 'text_chat',
          parameterSchemaId: NEWAPI_DEFAULT_TEXT_CHAT_PARAMETER_SCHEMA_ID
        },
        {
          productFeature: 'text_reasoning',
          parameterSchemaId: NEWAPI_DEFAULT_TEXT_REASONING_PARAMETER_SCHEMA_ID
        }
      ]
    });
    expect(newApiDefaultTextChatParameterSchema.revision).toBe(3);
    expect(newApiDefaultTextChatParameterSchema.fields.map((field) => field.fieldId)).toEqual([
      'max_tokens',
      'temperature',
      'top_p',
      'stop'
    ]);
    expect(
      newApiDefaultTextChatParameterSchema.fields.find((field) => field.fieldId === 'max_tokens')
    ).toMatchObject({ minimum: 1, maximum: 128000 });
    expect(newApiDefaultTextReasoningParameterSchema.fields.map((field) => field.fieldId)).toEqual([
      'max_completion_tokens',
      'reasoning_effort',
      'stop'
    ]);
    expect(
      newApiDefaultTextChatParameterSchema.fields.every((field) =>
        field.exposure === 'user_optional' &&
        field.defaultPolicy === 'omit_use_provider_default' &&
        field.required === false
      )
    ).toBe(true);
  });

  it('publishes an empty default image definition for explicit OpenAI-compatible attach', () => {
    const definition = createOpenAiCompatibleDefaultImageDefinition({
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
      providerModelKey: 'flux-manual'
    });
    expect(definition.profileTemplates).toHaveLength(1);
    expect(definition.profileTemplates[0]).toMatchObject({
      adapterKey: NEWAPI_IMAGE_ADAPTER_ID,
      features: [{
        productFeature: 'text_to_image',
        parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_IMAGE_PARAMETER_SCHEMA_ID,
        resultSchemaId: NEWAPI_IMAGE_RESULT_SCHEMA_ID,
        usageSchemaId: NEWAPI_IMAGE_USAGE_SCHEMA_ID,
        constraintSetId: NEWAPI_IMAGE_CONSTRAINT_SET_ID
      }]
    });
    expect(newApiDefaultTextToImageParameterSchema.fields.some((field) =>
      field.fieldId === 'size' && field.required
    )).toBe(true);
    expect(newApiDefaultTextToImageParameterSchema.fields.map((field) => field.fieldId)).toEqual([
      'size',
      'n',
      'quality',
      'response_format',
      'style',
      'output_format',
      'watermark'
    ]);
    expect(JSON.stringify(definition)).not.toMatch(/dall-e|sdxl/i);
  });

  it('publishes an optional-field default video definition for explicit OpenAI-compatible attach', () => {
    const definition = createOpenAiCompatibleDefaultVideoDefinition({
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
      packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
      providerModelKey: 'sora-manual'
    });
    expect(definition.profileTemplates).toHaveLength(1);
    expect(definition.profileTemplates[0]).toMatchObject({
      adapterKey: NEWAPI_VIDEO_ADAPTER_ID,
      features: [
        {
          productFeature: 'text_to_video',
          parameterSchemaId: NEWAPI_DEFAULT_TEXT_TO_VIDEO_PARAMETER_SCHEMA_ID,
          resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
          usageSchemaId: NEWAPI_VIDEO_USAGE_SCHEMA_ID,
          constraintSetId: NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
        },
        {
          productFeature: 'image_to_video',
          parameterSchemaId: NEWAPI_DEFAULT_IMAGE_TO_VIDEO_PARAMETER_SCHEMA_ID,
          resultSchemaId: NEWAPI_VIDEO_RESULT_SCHEMA_ID,
          usageSchemaId: NEWAPI_VIDEO_USAGE_SCHEMA_ID,
          constraintSetId: NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID
        }
      ]
    });
    expect(newApiDefaultTextToVideoParameterSchema.fields.every((field) =>
      field.exposure === 'user_optional' &&
      field.defaultPolicy === 'omit_use_provider_default' &&
      field.required === false
    )).toBe(true);
    expect(newApiDefaultTextToVideoParameterSchema.fields.map((field) => field.fieldId)).toEqual([
      'duration',
      'resolution',
      'aspect_ratio',
      'audio',
      'mode',
      'seed'
    ]);
  });

  it('keeps dynamic contracts deterministic and rejects undeclared fixed values', () => {
    const again = createNewApiModelContract(modelKey, {
      textChat: {
        temperature: { maximum: 2, minimum: 0 },
        maxTokens: { maximum: 8192, minimum: 1 }
      },
      textReasoning: {
        reasoningEfforts: ['high', 'low', 'medium'],
        maxTokens: { maximum: 16384, minimum: 1 }
      },
      textToImage: {
        outputFormats: ['png'],
        sizes: ['1024x1024']
      },
      textToVideo: {
        heights: [720], widths: [1280], durations: [10, 5]
      },
      imageToVideo: {
        supportsSeed: true, frameRates: [24], durations: [5]
      }
    });
    expect(again.contractHash).toBe(modelContract.contractHash);
    const video = schemaFor('text_to_video');
    expect(video.fields.find((field) => field.fieldId === 'duration')?.options)
      .toEqual([5, 10]);
    expect(video.fields.some((field) => field.fieldId === 'n')).toBe(false);
  });
});

describe('NewAPI management and runtime safety', () => {
  it('discovers safe catalog IDs without creating profiles', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      object: 'list',
      data: [
        { id: 'unknown-model', object: 'model', created: 1, owned_by: 'tenant' }
      ]
    }));
    const management = new NewApiManagementAdapter(fixture.runtime);
    const result = await management.discoverModels({
      connection: connection('saved', 'saved'),
      credentials: credential()
    });
    expect(result.entries).toEqual([
      { providerModelKey: 'unknown-model', displayName: 'unknown-model' }
    ]);
    expect(JSON.stringify(result.entries)).not.toContain('text_to_image');
    expect(fixture.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://gateway.example.test/v1/models',
      headers: { authorization: 'Bearer synthetic-secret' }
    });
  });

  it('accepts New API style catalog extensions without failing validation', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      success: true,
      object: 'list',
      data: [
        {
          id: 'gpt-4o',
          object: 'model',
          created: 1,
          owned_by: 'openai',
          supported_endpoint_types: ['openai']
        },
        {
          id: 'claude-sonnet',
          object: 'model',
          created: 2,
          owned_by: 'anthropic',
          supported_endpoint_types: ['anthropic', 'openai']
        }
      ]
    }));
    const management = new NewApiManagementAdapter(fixture.runtime, {
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID
    });
    const result = await management.validateConnection({
      connection: unicompapiConnection('saved', 'saved'),
      credentials: unicompapiCredential()
    });
    expect(result).toMatchObject({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid'
    });
    expect(result.safeCode).toBeUndefined();
  });

  it('accepts UniCompAPI official identity for the shared OpenAI-compatible runtime', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      object: 'list',
      data: [{ id: 'unicompapi-chat', object: 'model', created: 1, owned_by: 'unicompapi' }]
    }));
    const management = new NewApiManagementAdapter(fixture.runtime, {
      packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID
    });
    const result = await management.validateConnection({
      connection: unicompapiConnection('saved', 'saved'),
      credentials: unicompapiCredential()
    });
    expect(result).toMatchObject({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid'
    });
    expect(fixture.requests[0]).toMatchObject({
      method: 'GET',
      url: `${UNICOMPAPI_OFFICIAL_BASE_URL}/models`,
      headers: { authorization: 'Bearer unicompapi-secret' }
    });
  });

  it('rejects changed endpoints and redirects without leaking credentials to logs', async () => {
    const logs: unknown[] = [];
    const fixture = runtimeFixture(
      async () => emptyResponse(302, { location: 'https://evil.example/v1/models' }),
      logs
    );
    await expect(fixture.runtime.requestModelCatalog({
      connection: connection('saved', 'saved'),
      credentials: credential()
    })).rejects.toMatchObject({ code: 'redirect_not_allowed' });
    expect(JSON.stringify(logs)).not.toContain('synthetic-secret');
    expect(JSON.stringify(logs)).not.toContain('gateway.example.test');

    const noHttp = runtimeFixture(async () => jsonResponse({}));
    await expect(noHttp.runtime.requestModelCatalog({
      connection: {
        ...connection('saved', 'saved'),
        endpoint: 'https://192.168.1.9/v1'
      },
      credentials: credential()
    })).rejects.toMatchObject({ code: 'endpoint_not_allowed' });
    expect(noHttp.requests).toHaveLength(0);
  });

  it('maps transport failures and enforces response content types', async () => {
    const failed = runtimeFixture(async () => {
      throw new NewApiTransportFailure('network');
    });
    await expect(failed.runtime.requestModelCatalog({
      connection: connection('saved', 'saved'),
      credentials: credential()
    })).rejects.toMatchObject({ code: 'network_error' });

    const invalid = runtimeFixture(async () => binaryResponse(
      new TextEncoder().encode('{}'),
      'text/plain'
    ));
    await expect(invalid.runtime.requestModelCatalog({
      connection: connection('saved', 'saved'),
      credentials: credential()
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('NewAPI chat adapter', () => {
  it('streams controlled text, persists final token usage, and sends only whitelisted JSON', async () => {
    const sse = [
      event({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1,
        model: modelKey,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null, logprobs: null }]
      }),
      event({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1,
        model: modelKey,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop', logprobs: null }]
      }),
      event({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1,
        model: modelKey, choices: [],
        usage: {
          prompt_tokens: 4, completion_tokens: 2, total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 1 }
        }
      }),
      'data: [DONE]\n\n'
    ].join('');
    const fixture = runtimeFixture(async () => streamResponse(sse));
    const lifecycle = lifecycleFixture();
    const usage = usageSink();
    const adapter = new NewApiChatAdapter(
      fixture.runtime,
      credentialResolver(),
      connectionResolver(),
      schemaResolver(),
      lifecycle.port,
      usage.port,
      {
        nextProviderOperationId: () => 'newapi-chat-operation-1',
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId('newapi-chat-usage-1')
      }
    );
    const route = routeFor('text_chat');
    const handle = await adapter.submit({
      routeSnapshot: route,
      request: {
        responseExecutionId: 'response-execution-1',
        invocationAttemptId: 'attempt-chat-1',
        messages: [{ role: 'user', content: 'Hi' }],
        parameterValues: { max_tokens: 100 }
      }
    });
    await expect(handle.completion).resolves.toMatchObject({
      state: 'completed', usageAvailability: 'reported'
    });
    expect(lifecycle.content).toBe('Hello');
    expect(usage.observations[0].facts).toEqual([
      tokenFact('completion_tokens', 2),
      tokenFact('prompt_tokens', 4),
      tokenFact('total_tokens', 6),
      tokenFact('cached_tokens', 1),
      tokenFact('reasoning_tokens', 1)
    ]);
    const body = requestJson(fixture.requests[0]);
    expect(body).toEqual({
      model: modelKey,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('audio');
    expect(body).not.toHaveProperty('user');
    expect(body).not.toHaveProperty('thinking');
  });

  it('serializes default UniCompAPI chat fields without forcing stream/user', async () => {
    const sse = [
      'data: {"id":"chat-default-1","object":"chat.completion.chunk","created":1,"model":"' +
        modelKey +
        '","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"id":"chat-default-1","object":"chat.completion.chunk","created":1,"model":"' +
        modelKey +
        '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ].join('');
    const fixture = runtimeFixture(async () => streamResponse(sse));
    const lifecycle = lifecycleFixture();
    const adapter = new NewApiChatAdapter(
      fixture.runtime,
      credentialResolver(),
      connectionResolver(),
      {
        get: async (schemaId, revision) =>
          schemaId === newApiDefaultTextChatParameterSchema.schemaId &&
          revision === newApiDefaultTextChatParameterSchema.revision
            ? newApiDefaultTextChatParameterSchema
            : undefined
      },
      lifecycle.port,
      usageSink().port,
      {
        nextProviderOperationId: () => 'newapi-chat-default-op',
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId('newapi-chat-default-usage')
      }
    );
    const route = {
      ...routeFor('text_chat'),
      parameterSchemaId: newApiDefaultTextChatParameterSchema.schemaId,
      parameterSchemaRevision: newApiDefaultTextChatParameterSchema.revision
    };
    const handle = await adapter.submit({
      routeSnapshot: route,
      request: {
        responseExecutionId: 'response-execution-default',
        invocationAttemptId: 'attempt-chat-default',
        messages: [{ role: 'user', content: '你好' }],
        parameterValues: {
          max_tokens: 256,
          temperature: 0.7,
          top_p: 0.9,
          stop: 'END'
        }
      }
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'completed' });
    expect(requestJson(fixture.requests[0])).toEqual({
      model: modelKey,
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
      temperature: 0.7,
      top_p: 0.9,
      stop: 'END'
    });
  });

  it('accepts UniCompAPI stream chunks that omit finish_reason and add gateway fields', async () => {
    const sse = [
      event({
        id: 'chatcmpl-gateway-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelKey,
        service_tier: 'default',
        first_token_return_time: 1786100681.6219459,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' } }]
      }),
      event({
        id: 'chatcmpl-gateway-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelKey,
        service_tier: 'default',
        choices: [{
          index: 0,
          delta: { reasoning_content: '思考', content: '' }
        }]
      }),
      event({
        id: 'chatcmpl-gateway-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelKey,
        service_tier: 'default',
        choices: [{ index: 0, delta: { content: '汕头在粤东。' } }]
      }),
      event({
        id: 'chatcmpl-gateway-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelKey,
        service_tier: 'default',
        first_token_return_time: 1786100681.6219459,
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }]
      }),
      event({
        id: 'chatcmpl-gateway-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelKey,
        service_tier: 'default',
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 85,
          total_tokens: 93,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 65 }
        }
      }),
      'data: [DONE]\n\n'
    ].join('');
    const fixture = runtimeFixture(async () => streamResponse(sse));
    const lifecycle = lifecycleFixture();
    const adapter = new NewApiChatAdapter(
      fixture.runtime,
      credentialResolver(),
      connectionResolver(),
      schemaResolver(),
      lifecycle.port,
      usageSink().port,
      {
        nextProviderOperationId: () => 'newapi-chat-gateway-op',
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId('newapi-chat-gateway-usage')
      }
    );
    const handle = await adapter.submit({
      routeSnapshot: routeFor('text_chat'),
      request: {
        responseExecutionId: 'response-execution-gateway',
        invocationAttemptId: 'attempt-chat-gateway',
        messages: [{ role: 'user', content: '几句话' }],
        parameterValues: { max_tokens: 64 }
      }
    });
    await expect(handle.completion).resolves.toMatchObject({
      state: 'completed',
      finishReason: 'stop'
    });
    expect(lifecycle.content).toBe('汕头在粤东。');
  });

  it('rejects unknown JSON and mismatched schemas before HTTP', async () => {
    const fixture = runtimeFixture(async () => streamResponse('data: [DONE]\n\n'));
    const adapter = new NewApiChatAdapter(
      fixture.runtime,
      credentialResolver(),
      connectionResolver(),
      schemaResolver(),
      lifecycleFixture().port,
      usageSink().port
    );
    await expect(adapter.submit({
      routeSnapshot: routeFor('text_chat'),
      request: {
        responseExecutionId: 'response-execution-2',
        invocationAttemptId: 'attempt-chat-2',
        messages: [{ role: 'user', content: 'Hi' }],
        parameterValues: { tools: [] }
      }
    })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  it('cancels the active stream locally and does not retry', async () => {
    let release!: () => void;
    const fixture = runtimeFixture(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      stream: (async function* () {
        await new Promise<void>((resolve) => { release = resolve; });
        throw new NewApiTransportFailure('cancelled');
      })()
    }));
    const lifecycle = lifecycleFixture();
    const adapter = new NewApiChatAdapter(
      fixture.runtime,
      credentialResolver(),
      connectionResolver(),
      schemaResolver(),
      lifecycle.port,
      usageSink().port,
      {
        nextProviderOperationId: () => 'newapi-chat-operation-cancel',
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId(`usage-${Math.random()}`)
      }
    );
    const handle = await adapter.submit({
      routeSnapshot: routeFor('text_chat'),
      request: {
        responseExecutionId: 'response-execution-cancel',
        invocationAttemptId: 'attempt-chat-cancel',
        messages: [{ role: 'user', content: 'Hi' }],
        parameterValues: {}
      }
    });
    const cancelled = adapter.cancel(handle.providerOperationId);
    release();
    await expect(cancelled).resolves.toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(fixture.requests).toHaveLength(1);
  });

  it('maps OpenAI-compatible usage strictly', () => {
    expect(mapNewApiUsage({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5
    })).toEqual([
      tokenFact('completion_tokens', 2),
      tokenFact('prompt_tokens', 3),
      tokenFact('total_tokens', 5)
    ]);
    expect(() => mapNewApiUsage({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 7
    })).toThrow('inconsistent');
  });
});

describe('NewAPI image adapter', () => {
  it('submits text-only image JSON, parses inline bytes, and persists usage', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fixture = runtimeFixture(async () => jsonResponse({
      created: 1,
      data: [{ b64_json: Buffer.from(png).toString('base64') }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
    }));
    const usage = usageSink();
    const downloads = { download: vi.fn() };
    const adapter = new NewApiImageAdapter(
      fixture.runtime,
      connectionResolver(),
      credentialResolver(),
      schemaResolver(),
      usage.port,
      downloads,
      {
        nextProviderOperationId: () => 'newapi-image-operation-1',
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId('newapi-image-usage-1')
      }
    );
    const outcome = await adapter.submit({
      routeSnapshot: routeFor('text_to_image'),
      request: {
        invocationAttemptId: 'attempt-image-1',
        projectId: 'project-newapi',
        prompt: 'A synthetic image',
        parameterValues: { size: '1024x1024', output_format: 'png' }
      }
    });
    expect(outcome).toMatchObject({
      kind: 'completed_sync',
      providerOperationId: 'newapi-image-operation-1',
      results: [{ kind: 'base64', mimeType: 'image/png' }]
    });
    expect(requestJson(fixture.requests[0])).toEqual({
      model: modelKey,
      prompt: 'A synthetic image',
      size: '1024x1024',
      output_format: 'png'
    });
    expect(requestJson(fixture.requests[0])).not.toHaveProperty('image');
    expect(requestJson(fixture.requests[0])).not.toHaveProperty('images');
    expect(usage.observations[0].facts).toEqual([
      tokenFact('input_tokens', 3),
      tokenFact('output_tokens', 2),
      tokenFact('total_tokens', 5)
    ]);
    if (outcome.kind !== 'completed_sync') throw new Error('unexpected outcome');
    const stream = await adapter.openResult(outcome.results[0] as never);
    expect(await readAll(stream)).toEqual(png);
    expect(downloads.download).not.toHaveBeenCalled();
  });

  it('uses an injected controlled downloader for URL results', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const fixture = runtimeFixture(async () => jsonResponse({
      created: 1,
      data: [{ url: 'https://media.example.test/result.jpg?signature=private' }]
    }));
    const download = vi.fn(async () => ({
      body: jpeg,
      contentType: 'image/jpeg'
    }));
    const adapter = new NewApiImageAdapter(
      fixture.runtime,
      connectionResolver(),
      credentialResolver(),
      schemaResolver(),
      usageSink().port,
      { download }
    );
    const outcome = await adapter.submit({
      routeSnapshot: routeFor('text_to_image'),
      request: {
        invocationAttemptId: 'attempt-image-url',
        projectId: 'project-newapi',
        prompt: 'A URL image',
        parameterValues: {}
      }
    });
    expect(outcome.kind).toBe('completed_sync');
    if (outcome.kind !== 'completed_sync') return;
    expect(await readAll(await adapter.openResult(outcome.results[0] as never)))
      .toEqual(jpeg);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({
      maximumResponseBytes: 128 * 1024 * 1024
    }));
  });

  it('rejects image references and ambiguous results', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      created: 1,
      data: [{ url: 'https://media.example.test/a.png', b64_json: 'AAAA' }]
    }));
    const adapter = new NewApiImageAdapter(
      fixture.runtime,
      connectionResolver(),
      credentialResolver(),
      schemaResolver(),
      usageSink().port,
      { download: vi.fn() }
    );
    const preflight = await adapter.submit({
      routeSnapshot: routeFor('text_to_image'),
      request: {
        invocationAttemptId: 'attempt-image-invalid',
        projectId: 'project-newapi',
        prompt: 'No references',
        assetId: 'forbidden',
        parameterValues: {}
      }
    });
    expect(preflight.kind).toBe('failed_before_submission');
    expect(fixture.requests).toHaveLength(0);

    const ambiguous = await adapter.submit({
      routeSnapshot: routeFor('text_to_image'),
      request: {
        invocationAttemptId: 'attempt-image-ambiguous',
        projectId: 'project-newapi',
        prompt: 'Ambiguous result',
        parameterValues: {}
      }
    });
    expect(ambiguous.kind).toBe('failed_before_submission');
  });

  it('accepts OpenAI-compatible extras such as revised_prompt and model', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fixture = runtimeFixture(async () => jsonResponse({
      created: 1,
      model: 'qwen-image',
      data: [{
        url: 'https://media.example.test/puppy.png',
        revised_prompt: '一只可爱的小狗'
      }],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        provider_extra: true
      }
    }));
    const download = vi.fn(async () => ({
      body: png,
      contentType: 'image/png'
    }));
    const adapter = new NewApiImageAdapter(
      fixture.runtime,
      connectionResolver(),
      credentialResolver(),
      schemaResolver(),
      usageSink().port,
      { download }
    );
    const outcome = await adapter.submit({
      routeSnapshot: routeFor('text_to_image'),
      request: {
        invocationAttemptId: 'attempt-image-compatible-extras',
        projectId: 'project-newapi',
        prompt: '生成一只小狗',
        parameterValues: {}
      }
    });
    expect(outcome).toMatchObject({
      kind: 'completed_sync',
      results: [{ kind: 'remote_url', value: 'https://media.example.test/puppy.png' }]
    });
  });

  it('maps optional image usage details without inventing values', () => {
    expect(mapNewApiImageUsage({
      input_tokens: 4, output_tokens: 2, total_tokens: 6,
      input_tokens_details: { text_tokens: 4, image_tokens: 0 }
    })).toHaveLength(5);
  });
});

describe('NewAPI video adapter', () => {
  it('accepts gateway create payloads without status and numeric ids', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      code: 0,
      data: {
        task_id: 987654321,
        object: 'task'
      },
      message: 'ok'
    }));
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    await expect(adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-loose-create',
        projectId: 'project-newapi',
        prompt: 'Loose create payload',
        parameterValues: {}
      }
    })).resolves.toEqual({
      kind: 'accepted_async',
      providerOperationId: '987654321',
      state: 'queued'
    });
  });

  it('maps balance error envelopes to failed_before_submission', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      error: {
        message: 'token重算：tokens=108900, modelRatio=3.60',
        type: 'invalid_request_error'
      }
    }, 400));
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    await expect(adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-balance',
        projectId: 'project-newapi',
        prompt: 'Balance failure',
        parameterValues: {}
      }
    })).resolves.toMatchObject({
      kind: 'failed_before_submission',
      message: 'The NewAPI account balance is insufficient'
    });
  });

  it('accepts NewAPI gateway statuses and extra response fields', async () => {
    const responses = [
      jsonResponse({
        id: 'video-compat-1',
        object: 'video',
        model: modelKey,
        created_at: 1,
        status: 'processing',
        progress: 0,
        quality: 'standard'
      }),
      jsonResponse({
        id: 'video-compat-1',
        object: 'video',
        model: 'echoed-display-name',
        created_at: 1,
        status: 'succeeded',
        progress: 100,
        quality: 'standard',
        url: 'https://media.example.test/video.mp4',
        error: null
      }),
      binaryResponse(Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112]), 'video/mp4')
    ];
    const fixture = runtimeFixture(async () => responses.shift()!);
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    await expect(adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-compat',
        projectId: 'project-newapi',
        prompt: 'Compat status mapping',
        parameterValues: {}
      }
    })).resolves.toEqual({
      kind: 'accepted_async',
      providerOperationId: 'video-compat-1',
      state: 'queued'
    });
    await expect(adapter.query('video-compat-1')).resolves.toEqual({ state: 'completed' });
  });

  it('treats UniCompAPI transient unknown query status as processing', async () => {
    const responses = [
      jsonResponse(videoObject('video-unknown', 'queued')),
      jsonResponse({
        id: 'video-unknown',
        object: 'video',
        model: '',
        status: 'unknown',
        progress: 0,
        created_at: 1786099055,
        completed_at: 1786099055
      }),
      jsonResponse({
        id: 'video-unknown',
        object: 'video',
        model: modelKey,
        status: 'completed',
        progress: 100,
        created_at: 1786099055,
        completed_at: 1786099100
      })
    ];
    const fixture = runtimeFixture(async () => responses.shift()!);
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    await expect(adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-unknown',
        projectId: 'project-newapi',
        prompt: 'Unknown status polling',
        parameterValues: {}
      }
    })).resolves.toMatchObject({
      kind: 'accepted_async',
      providerOperationId: 'video-unknown'
    });
    await expect(adapter.query('video-unknown')).resolves.toEqual({ state: 'processing' });
    await expect(adapter.query('video-unknown')).resolves.toEqual({ state: 'completed' });
  });

  it('submits text-to-video JSON matching UniCompAPI create shape', async () => {
    const responses = [
      jsonResponse(videoObject('video-1', 'queued')),
      jsonResponse(videoObject('video-1', 'in_progress')),
      jsonResponse(videoObject('video-1', 'completed')),
      binaryResponse(Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112]), 'video/mp4')
    ];
    const fixture = runtimeFixture(async () => responses.shift()!);
    const usage = usageSink();
    const imageResolve = vi.fn();
    const adapter = videoAdapter(fixture.runtime, usage, imageResolve);
    const outcome = await adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-1',
        projectId: 'project-newapi',
        prompt: 'A synthetic video',
        parameterValues: { duration: 5 }
      }
    });
    expect(outcome).toEqual({
      kind: 'accepted_async', providerOperationId: 'video-1', state: 'queued'
    });
    const jsonBody = JSON.parse(Buffer.from(fixture.requests[0].body!).toString('utf8')) as Record<string, unknown>;
    expect(jsonBody).toEqual({
      model: modelKey,
      prompt: 'A synthetic video',
      duration: 5
    });
    expect(fixture.requests[0].headers['content-type']).toBe('application/json');
    expect(imageResolve).not.toHaveBeenCalled();
    await expect(adapter.query('video-1')).resolves.toEqual({ state: 'processing' });
    await expect(adapter.query('video-1')).resolves.toEqual({ state: 'completed' });
    expect(usage.observations.at(-1)?.status).toBe('not_reported');
    expect(await readAll(await adapter.openDownload('video-1', 'video')))
      .toEqual(Uint8Array.from([0, 0, 0, 20, 102, 116, 121, 112]));
    expect(fixture.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: 'https://gateway.example.test/v1/videos/video-1/content',
      headers: { authorization: 'Bearer synthetic-secret' }
    });
  });

  it('projects default UniCompAPI video fields into resolution and metadata', async () => {
    const fixture = runtimeFixture(async () => jsonResponse({
      id: 'task_script_ok',
      task_id: 'task_script_ok',
      object: 'video',
      model: modelKey,
      status: 'queued',
      progress: 0,
      created_at: 1786096513
    }));
    const adapter = new NewApiVideoAdapter(
      fixture.runtime,
      connectionResolver(),
      credentialResolver(),
      {
        get: async (schemaId, revision) =>
          schemaId === newApiDefaultTextToVideoParameterSchema.schemaId &&
          revision === newApiDefaultTextToVideoParameterSchema.revision
            ? newApiDefaultTextToVideoParameterSchema
            : undefined
      },
      { resolve: vi.fn() },
      usageSink().port,
      {
        nextProviderUsageObservationId: () =>
          toProviderUsageObservationId('newapi-video-usage-default')
      }
    );
    const route = {
      ...routeFor('text_to_video'),
      parameterSchemaId: newApiDefaultTextToVideoParameterSchema.schemaId,
      parameterSchemaRevision: newApiDefaultTextToVideoParameterSchema.revision
    };
    const outcome = await adapter.submit({
      routeSnapshot: route,
      request: {
        invocationAttemptId: 'attempt-video-default',
        projectId: 'project-newapi',
        prompt: '@hero runs across the scene with consistent appearance',
        parameterValues: {
          duration: 5,
          resolution: '720p',
          aspect_ratio: '16:9',
          audio: true
        }
      }
    });
    expect(outcome).toEqual({
      kind: 'accepted_async',
      providerOperationId: 'task_script_ok',
      state: 'queued'
    });
    expect(JSON.parse(Buffer.from(fixture.requests[0].body!).toString('utf8'))).toEqual({
      model: modelKey,
      prompt: '@hero runs across the scene with consistent appearance',
      duration: 5,
      resolution: '720p',
      metadata: {
        aspect_ratio: '16:9',
        audio: true
      }
    });
  });

  it('accepts exactly one controlled JPG/PNG only for image-to-video', async () => {
    const fixture = runtimeFixture(async () => jsonResponse(videoObject('video-2', 'queued')));
    const resolve = vi.fn(async (): Promise<ControlledNewApiImageV1> => ({
      assetId: 'asset-first-frame',
      mimeType: 'image/png',
      width: 640,
      height: 480,
      sizeBytes: 8,
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }));
    const adapter = videoAdapter(fixture.runtime, usageSink(), resolve);
    const outcome = await adapter.submit({
      routeSnapshot: routeFor('image_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-2',
        projectId: 'project-newapi',
        prompt: 'Animate the first frame',
        assetId: 'asset-first-frame',
        parameterValues: { duration: 5, fps: 24, seed: 7 }
      }
    });
    expect(outcome.kind).toBe('accepted_async');
    const jsonBody = JSON.parse(Buffer.from(fixture.requests[0].body!).toString('utf8')) as Record<string, unknown>;
    expect(typeof jsonBody.image).toBe('string');
    expect(String(jsonBody.image)).toMatch(/^data:image\/png;base64,/u);
    expect(jsonBody.metadata).toEqual({ fps: 24, seed: 7 });
    expect(jsonBody).not.toHaveProperty('images');
    expect(jsonBody).not.toHaveProperty('input_reference');
    expect(resolve).toHaveBeenCalledWith({
      projectId: 'project-newapi',
      assetId: 'asset-first-frame'
    });

    const wrongFeature = await adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-wrong',
        projectId: 'project-newapi',
        prompt: 'Must be text only',
        assetId: 'asset-first-frame',
        parameterValues: {}
      }
    });
    expect(wrongFeature.kind).toBe('failed_before_submission');
    expect(fixture.requests).toHaveLength(1);
  });

  it('does not issue a guessed cancellation request', async () => {
    const fixture = runtimeFixture(async () => jsonResponse(videoObject('video-cancel', 'queued')));
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    await adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-cancel',
        projectId: 'project-newapi',
        prompt: 'Do not guess cancellation',
        parameterValues: {}
      }
    });
    const before = fixture.requests.length;
    await expect(adapter.cancel('video-cancel')).resolves.toEqual({ state: 'processing' });
    expect(fixture.requests).toHaveLength(before);
  });

  it('attaches an existing operation to its immutable route after restart', async () => {
    const fixture = runtimeFixture(async () => jsonResponse(videoObject('video-restart', 'completed')));
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    await adapter.attachOperation({
      routeSnapshot: routeFor('text_to_video'),
      providerOperationId: 'video-restart',
      invocationAttemptId: toProviderInvocationAttemptId('attempt-video-restart')
    });
    await expect(adapter.query('video-restart')).resolves.toEqual({ state: 'completed' });
  });

  it('marks network failures after request start as unknown without auto retry', async () => {
    const fixture = runtimeFixture(async () => {
      throw new NewApiTransportFailure('network');
    });
    const adapter = videoAdapter(fixture.runtime, usageSink(), vi.fn());
    const outcome = await adapter.submit({
      routeSnapshot: routeFor('text_to_video'),
      request: {
        invocationAttemptId: 'attempt-video-unknown',
        projectId: 'project-newapi',
        prompt: 'Unknown outcome',
        parameterValues: {}
      }
    });
    expect(outcome.kind).toBe('submission_outcome_unknown');
    expect(fixture.requests).toHaveLength(1);
  });
});

function runtimeFixture(
  handler: (request: NewApiHttpTransportRequest) => Promise<NewApiHttpTransportResponse>,
  logs: unknown[] = []
) {
  const requests: NewApiHttpTransportRequest[] = [];
  const transport: NewApiHttpTransport = {
    async send(request) {
      requests.push(request);
      return handler(request);
    }
  };
  return {
    requests,
    runtime: new NewApiSharedRuntime({
      transport,
      logger: (event) => logs.push(event),
      defaultTimeoutMs: 10_000
    })
  };
}

function connection(
  state: ProviderConnection['state'] = 'available',
  credentialState: ProviderConnection['credentialState'] = 'valid'
): ProviderConnection {
  const timestamp = toIsoTimestamp('2026-08-03T00:00:00.000Z');
  return createProviderConnection({
    id: toConnectionId('connection-newapi'),
    providerId: toProviderId('provider-newapi'),
    name: 'NewAPI synthetic',
    endpoint: 'https://gateway.example.test/v1',
    packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
    templateId: NEWAPI_COMPATIBLE_TEMPLATE_ID,
    templateKind: 'compatible_custom',
    credentialSchemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-newapi-1',
    connectionPolicyId: 'connection.newapi.compatible',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.newapi.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-newapi-1',
    connectionRevision: 1,
    adapterBindings: newApiProviderPackageDescriptor.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocolId: adapter.protocolId,
      protocolVersion: adapter.protocolVersion
    })),
    state,
    identityState: state === 'available' ? 'verified' : 'unverified',
    credentialState,
    credentialReference: 'credential-reference-newapi',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function unicompapiConnection(
  state: ProviderConnection['state'] = 'available',
  credentialState: ProviderConnection['credentialState'] = 'valid'
): ProviderConnection {
  const timestamp = toIsoTimestamp('2026-08-03T00:00:00.000Z');
  return createProviderConnection({
    id: toConnectionId('connection-unicompapi'),
    providerId: toProviderId('provider-unicompapi'),
    name: 'UniCompAPI official',
    endpoint: UNICOMPAPI_OFFICIAL_BASE_URL,
    packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
    packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION,
    templateId: UNICOMPAPI_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-unicompapi-1',
    connectionPolicyId: 'connection.unicompapi.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.unicompapi.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: UNICOMPAPI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-unicompapi-1',
    connectionRevision: 1,
    adapterBindings: unicompapiProviderPackageDescriptor.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      protocolId: adapter.protocolId,
      protocolVersion: adapter.protocolVersion
    })),
    state,
    identityState: state === 'available' ? 'verified' : 'unverified',
    credentialState,
    credentialReference: 'credential-reference-unicompapi',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function credential(): StructuredCredentialRecord {
  return {
    schemaId: NEWAPI_CREDENTIAL_SCHEMA_ID,
    schemaVersion: 1,
    values: { api_key: 'synthetic-secret' }
  };
}

function unicompapiCredential(): StructuredCredentialRecord {
  return {
    schemaId: UNICOMPAPI_CREDENTIAL_SCHEMA_ID,
    schemaVersion: 1,
    values: { api_key: 'unicompapi-secret' }
  };
}

function credentialResolver() {
  return {
    useCredential: async <T>(
      _input: unknown,
      operation: (value: StructuredCredentialRecord) => Promise<T>
    ) => operation(credential())
  };
}

function connectionResolver() {
  return { get: async () => connection() };
}

function schemaResolver() {
  return {
    get: async (schemaId: string, revision: number) =>
      modelContract.parameterSchemas.find(
        (schema) => schema.schemaId === schemaId && schema.revision === revision
      )
  };
}

function schemaFor(feature: ParameterSchemaV2['productFeature']): ParameterSchemaV2 {
  const schema = modelContract.parameterSchemas.find(
    (candidate) => candidate.productFeature === feature
  );
  if (!schema) throw new Error(`missing schema for ${feature}`);
  return schema;
}

function routeFor(
  feature: 'text_chat' | 'text_reasoning' | 'text_to_image' |
    'text_to_video' | 'image_to_video'
): ProviderExecutionRouteSnapshotV1 {
  const schema = schemaFor(feature);
  const adapter = feature === 'text_chat' || feature === 'text_reasoning'
    ? NEWAPI_CHAT_ADAPTER_ID
    : feature === 'text_to_image'
      ? NEWAPI_IMAGE_ADAPTER_ID
      : NEWAPI_VIDEO_ADAPTER_ID;
  const resultSchema = adapter === NEWAPI_CHAT_ADAPTER_ID
    ? NEWAPI_CHAT_RESULT_SCHEMA_ID
    : adapter === NEWAPI_IMAGE_ADAPTER_ID
      ? NEWAPI_IMAGE_RESULT_SCHEMA_ID
      : NEWAPI_VIDEO_RESULT_SCHEMA_ID;
  const usageSchema = adapter === NEWAPI_CHAT_ADAPTER_ID
    ? NEWAPI_CHAT_USAGE_SCHEMA_ID
    : adapter === NEWAPI_IMAGE_ADAPTER_ID
      ? NEWAPI_IMAGE_USAGE_SCHEMA_ID
      : NEWAPI_VIDEO_USAGE_SCHEMA_ID;
  const constraint = adapter === NEWAPI_CHAT_ADAPTER_ID
    ? NEWAPI_TEXT_CONSTRAINT_SET_ID
    : adapter === NEWAPI_IMAGE_ADAPTER_ID
      ? NEWAPI_IMAGE_CONSTRAINT_SET_ID
      : feature === 'text_to_video'
        ? NEWAPI_TEXT_VIDEO_CONSTRAINT_SET_ID
        : NEWAPI_IMAGE_VIDEO_CONSTRAINT_SET_ID;
  return createProviderExecutionRouteSnapshot({
    id: toProviderExecutionRouteSnapshotId(`route-newapi-${feature}`),
    projectId: toProjectId('project-newapi'),
    packageId: NEWAPI_PROVIDER_PACKAGE_ID,
    packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
    adapterKey: adapter,
    adapterVersion: NEWAPI_ADAPTER_VERSION,
    providerId: toProviderId('provider-newapi'),
    connectionId: toConnectionId('connection-newapi'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-newapi-1',
    endpointPolicyId: NEWAPI_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-newapi-1',
    modelId: toModelId(`model-newapi-${feature}`),
    providerModelKey: modelKey,
    modelRevision: 1,
    profileId: `profile-newapi-${feature}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId(`binding-newapi-${adapter}`),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: feature === 'text_chat' || feature === 'text_reasoning'
      ? 'text_execution'
      : feature === 'text_to_image'
        ? 'image_generation'
        : feature === 'text_to_video'
          ? 'video_generation'
          : 'reference_to_video',
    featureMappingVersion: 1,
    parameterSchemaId: schema.schemaId,
    parameterSchemaRevision: schema.revision,
    resultSchemaId: resultSchema,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(usageSchema),
    usageSchemaRevision: 1,
    constraintSetId: constraint,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.newapi.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-newapi-synthetic',
    createdAt: toIsoTimestamp('2026-08-03T00:00:00.000Z')
  });
}

function usageSink() {
  const observations: ProviderUsageObservationV1[] = [];
  return {
    observations,
    port: {
      append: async (
        observation: ProviderUsageObservationV1,
        _schema: UsageSchemaV1
      ) => { observations.push(observation); }
    }
  };
}

function lifecycleFixture() {
  let content = '';
  const states: string[] = [];
  return {
    get content() { return content; },
    states,
    port: {
      start: async (_id: ConversationResponseExecutionId) => { states.push('started'); },
      appendContent: async (_id: ConversationResponseExecutionId, delta: string) => {
        content += delta;
      },
      complete: async () => { states.push('completed'); },
      requestCancel: async () => { states.push('cancel_requested'); },
      confirmCancelled: async () => { states.push('cancelled'); },
      fail: async () => { states.push('failed'); },
      interrupt: async () => { states.push('interrupted'); }
    }
  };
}

function videoAdapter(
  runtime: NewApiSharedRuntime,
  usage: ReturnType<typeof usageSink>,
  resolveImage: ReturnType<typeof vi.fn>
) {
  return new NewApiVideoAdapter(
    runtime,
    connectionResolver(),
    credentialResolver(),
    schemaResolver(),
    { resolve: resolveImage },
    usage.port,
    {
      nextProviderUsageObservationId: () =>
        toProviderUsageObservationId(`newapi-video-usage-${Math.random()}`)
    }
  );
}

function videoObject(
  id: string,
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
) {
  return {
    id,
    object: 'video',
    created_at: 1,
    status,
    model: modelKey,
    ...(status === 'failed'
      ? { error: { code: 'synthetic_failure', message: 'provider detail' } }
      : {})
  };
}

function jsonResponse(value: unknown, status = 200): NewApiHttpTransportResponse {
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

function binaryResponse(
  body: Uint8Array,
  contentType: string
): NewApiHttpTransportResponse {
  return {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength)
    },
    body
  };
}

function emptyResponse(
  status: number,
  headers: Readonly<Record<string, string>> = {}
): NewApiHttpTransportResponse {
  return { status, headers, body: new Uint8Array() };
}

function streamResponse(value: string): NewApiHttpTransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    stream: (async function* () {
      yield new TextEncoder().encode(value);
    })()
  };
}

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function requestJson(request: NewApiHttpTransportRequest): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}

function tokenFact(metricId: string, quantity: number) {
  return {
    metricId,
    quantity: String(quantity),
    unit: 'token',
    source: 'provider_body'
  };
}

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Uint8Array.from(Buffer.concat(chunks));
}
