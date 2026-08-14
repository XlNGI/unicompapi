import { describe, expect, it, vi } from 'vitest';
import {
  createProviderConnection,
  createProviderExecutionRouteSnapshot,
  toConnectionId,
  toConversationResponseExecutionId,
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
  type ProviderConnection,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageSchemaV1
} from '../../src/domain';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION,
  DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID,
  DEEPSEEK_CHAT_PROTOCOL_ID,
  DEEPSEEK_CHAT_PROTOCOL_VERSION,
  DEEPSEEK_CONSTRAINT_SET_ID,
  DEEPSEEK_CREDENTIAL_SCHEMA_ID,
  DEEPSEEK_ENDPOINT_POLICY_ID,
  DEEPSEEK_MODEL_KEYS,
  DEEPSEEK_OFFICIAL_TEMPLATE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
  DEEPSEEK_RESULT_SCHEMA_ID,
  DEEPSEEK_USAGE_SCHEMA_ID,
  DeepSeekChatAdapter,
  DeepSeekManagementAdapter,
  DeepSeekSharedRuntime,
  DeepSeekTransportFailure,
  ProviderPackageRegistry,
  deepSeekChatParameterSchema,
  deepSeekChatRecoveryDecision,
  deepSeekModelDefinitions,
  deepSeekProviderPackageDescriptor,
  deepSeekReasoningParameterSchema,
  deepSeekUsageSchema,
  mapDeepSeekUsage,
  type DeepSeekChatAdapterIdFactory,
  type DeepSeekConversationLifecyclePort,
  type DeepSeekCredentialResolverPort,
  type DeepSeekHttpTransport,
  type DeepSeekHttpTransportRequest,
  type DeepSeekHttpTransportResponse,
  type DeepSeekSafeLogEvent,
  type DeepSeekUsageObservationSinkPort
} from '../../src/platform';

const timestamp = toIsoTimestamp('2026-08-03T12:00:00.000Z');
const credential: StructuredCredentialRecord = {
  schemaId: DEEPSEEK_CREDENTIAL_SCHEMA_ID,
  schemaVersion: 1,
  values: { api_key: 'unit-test-key' }
};

describe('DeepSeek official package contracts', () => {
  it('publishes one safe official template and versioned exact text definitions', () => {
    const registry = new ProviderPackageRegistry([
      deepSeekProviderPackageDescriptor
    ]);
    expect(registry.listSafeTemplates()).toEqual([{
      packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
      packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
      providerName: 'DeepSeek',
      templateId: DEEPSEEK_OFFICIAL_TEMPLATE_ID,
      kind: 'official',
      displayName: 'DeepSeek Official',
      iconAssetId: undefined,
      baseUrlMode: 'fixed',
      credentialFields: [{
        key: 'api_key',
        label: 'API key',
        secret: true,
        required: true,
        kind: 'token'
      }],
      freeConnectionValidation: true,
      modelDiscoveryKind: 'catalog'
    }]);
    const publicTemplate = JSON.stringify(registry.listSafeTemplates());
    expect(publicTemplate).not.toMatch(/api\.deepseek|chat-completions|endpoint\./);
    expect(registry.resolveAdapter(
      DEEPSEEK_PROVIDER_PACKAGE_ID,
      DEEPSEEK_CHAT_ADAPTER_ID,
      DEEPSEEK_CHAT_ADAPTER_VERSION,
      DEEPSEEK_CHAT_PROTOCOL_ID,
      DEEPSEEK_CHAT_PROTOCOL_VERSION
    ).operations).toEqual([
      'validate_connection',
      'discover_models',
      'submit',
      'cancel'
    ]);

    expect(deepSeekModelDefinitions.map((item) => item.providerModelKey))
      .toEqual(DEEPSEEK_MODEL_KEYS);
    for (const definition of deepSeekModelDefinitions) {
      expect(definition.profileTemplates[0]).toMatchObject({
        adapterKey: DEEPSEEK_CHAT_ADAPTER_ID,
        protocolDefinitionId: DEEPSEEK_CHAT_PROTOCOL_ID,
        features: [
          { productFeature: 'text_chat', internalPurpose: 'text_execution' },
          { productFeature: 'text_reasoning', internalPurpose: 'text_execution' }
        ]
      });
    }
    expect(deepSeekChatParameterSchema.fields.map((field) => field.fieldId))
      .toEqual(['max_tokens', 'temperature', 'top_p', 'stream', 'include_usage', 'thinking']);
    expect(deepSeekReasoningParameterSchema.fields.map((field) => field.fieldId))
      .toEqual(['max_tokens', 'reasoning_effort', 'stream', 'include_usage', 'thinking']);
    expect(deepSeekUsageSchema.metrics.map((metric) => metric.metricId)).toEqual([
      'completion_tokens',
      'prompt_tokens',
      'total_tokens',
      'prompt_cache_hit_tokens',
      'prompt_cache_miss_tokens',
      'reasoning_tokens'
    ]);
  });
});

describe('DeepSeek management adapter', () => {
  it('uses GET /models for free validation and exact catalog discovery without leaking secrets', async () => {
    const transport = new SyntheticTransport();
    const logs: DeepSeekSafeLogEvent[] = [];
    transport.responses.push(
      jsonResponse(modelCatalog([
        'deepseek-v4-flash',
        'deepseek-v4-pro',
        'deepseek-future-exact'
      ])),
      jsonResponse(modelCatalog(['deepseek-v4-flash']))
    );
    const runtime = new DeepSeekSharedRuntime({
      transport,
      logger: (event) => logs.push(event),
      now: () => 100
    });
    const adapter = new DeepSeekManagementAdapter(runtime, () => timestamp);
    const connection = officialConnection();

    await expect(adapter.validateConnection({
      connection,
      endpoint: connection.endpoint,
      credentials: credential
    })).resolves.toMatchObject({
      state: 'available',
      identityState: 'verified',
      credentialState: 'valid'
    });
    await expect(adapter.discoverModels({
      connection,
      endpoint: connection.endpoint,
      credentials: credential
    })).resolves.toEqual({
      entries: [
        { providerModelKey: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' }
      ],
      observedAt: timestamp
    });

    expect(transport.requests).toHaveLength(2);
    for (const request of transport.requests) {
      expect(request).toMatchObject({
        method: 'GET',
        url: 'https://api.deepseek.com/models',
        redirect: 'manual'
      });
      expect(request.headers.authorization).toBe('Bearer unit-test-key');
    }
    expect(JSON.stringify(logs)).not.toMatch(/unit-test-key|\/models|api\.deepseek/);
  });

  it('fails closed on malformed catalog data and maps authentication without returning response bodies', async () => {
    const transport = new SyntheticTransport();
    transport.responses.push(
      jsonResponse({ object: 'list', data: [{
        id: 'deepseek-v4-pro',
        object: 'model',
        owned_by: 'deepseek',
        unexpected: true
      }] }),
      jsonResponse({}, 401)
    );
    const adapter = new DeepSeekManagementAdapter(
      new DeepSeekSharedRuntime({ transport }),
      () => timestamp
    );
    const connection = officialConnection();
    await expect(adapter.validateConnection({
      connection,
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'verification_unavailable',
      safeCode: 'deepseek.operation_failed'
    });
    await expect(adapter.validateConnection({
      connection,
      credentials: credential
    })).resolves.toMatchObject({
      state: 'unavailable',
      credentialState: 'invalid',
      safeCode: 'deepseek.authentication_failed'
    });
    expect(transport.requests).toHaveLength(2);
  });
});

describe('DeepSeek chat adapter', () => {
  it('maps text_chat to strict SSE, persists final usage and emits only answer content', async () => {
    const fixture = chatFixture();
    fixture.transport.responses.push(streamResponse([
      chunk({ delta: { role: 'assistant', content: '' }, usage: null }),
      chunk({ delta: { reasoning_content: 'private synthetic reasoning' } }),
      chunk({ delta: { content: 'Hello ' } }),
      chunk({ delta: { content: 'world' } }),
      chunk({ delta: { content: '' }, finishReason: 'stop' }),
      usageChunk({
        completion_tokens: 8,
        prompt_tokens: 12,
        prompt_cache_hit_tokens: 7,
        prompt_cache_miss_tokens: 5,
        total_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 3 }
      }),
      '[DONE]'
    ]));
    let requestStarted = 0;
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_chat'),
      request: dispatchRequest({ temperature: 0.2 }),
      beforeRequestStarted: async () => { requestStarted += 1; }
    });
    await expect(handle.completion).resolves.toEqual({
      state: 'completed',
      providerOperationId: 'deepseek-operation-1',
      finishReason: 'stop',
      usageAvailability: 'reported'
    });

    expect(requestStarted).toBe(1);
    expect(fixture.lifecycle.events).toEqual([
      'start:response-execution-deepseek',
      'content:Hello ',
      'content:world',
      'complete:response-execution-deepseek'
    ]);
    expect(fixture.lifecycle.events.join('\n')).not.toContain('private synthetic reasoning');
    expect(fixture.usage.observations).toHaveLength(1);
    expect(fixture.usage.observations[0]).toMatchObject({
      status: 'reported',
      facts: [
        { metricId: 'completion_tokens', quantity: '8' },
        { metricId: 'prompt_tokens', quantity: '12' },
        { metricId: 'total_tokens', quantity: '20' },
        { metricId: 'prompt_cache_hit_tokens', quantity: '7' },
        { metricId: 'prompt_cache_miss_tokens', quantity: '5' },
        { metricId: 'reasoning_tokens', quantity: '3' }
      ]
    });
    expect(bodyOf(fixture.transport.requests[0])).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Synthetic user message' }],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      temperature: 0.2
    });
    expect(JSON.stringify(handle)).not.toMatch(/remote-stream-id|private synthetic reasoning/);
    expect(JSON.stringify(fixture.logs)).not.toMatch(
      /unit-test-key|Synthetic user message|deepseek-v4-flash/
    );
    expect(fixture.adapter.activeOperationCount).toBe(0);
    expect(fixture.runtime.activeRequestCount).toBe(0);
  });

  it('maps text_reasoning without unsupported sampling fields and accepts length finishes with content', async () => {
    const fixture = chatFixture();
    fixture.transport.responses.push(streamResponse([
      chunk({ delta: { role: 'assistant', reasoning_content: 'Verified reasoning' } }),
      chunk({ delta: { content: 'Partial answer' } }),
      chunk({ delta: {}, finishReason: 'length' }),
      usageChunk({ completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 }),
      '[DONE]'
    ]));
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_reasoning'),
      request: dispatchRequest({ max_tokens: 128, reasoning_effort: 'max' })
    });
    await expect(handle.completion).resolves.toEqual({
      state: 'completed',
      providerOperationId: 'deepseek-operation-1',
      finishReason: 'length',
      usageAvailability: 'reported'
    });
    const body = bodyOf(fixture.transport.requests[0]);
    expect(body).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      max_tokens: 128
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(fixture.lifecycle.events).toContain('reasoning:Verified reasoning');
    expect(fixture.lifecycle.events.at(-1)).toBe(
      'complete:response-execution-deepseek'
    );
    expect(fixture.usage.observations[0]?.status).toBe('reported');
  });

  it('rejects stale routes and ambiguous sampling before transport, then fails malformed streams without retry', async () => {
    const fixture = chatFixture();
    await expect(fixture.adapter.submit({
      routeSnapshot: createProviderExecutionRouteSnapshot({
        ...routeInput('text_chat'),
        providerModelKey: undefined
      }),
      request: dispatchRequest({})
    })).rejects.toMatchObject({ safeCode: 'deepseek.route_mismatch' });
    await expect(fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_chat'),
      request: dispatchRequest({ temperature: 0.2, top_p: 0.8 })
    })).rejects.toMatchObject({ safeCode: 'deepseek.invalid_request' });
    expect(fixture.transport.requests).toHaveLength(0);

    fixture.transport.responses.push(streamResponse([
      JSON.stringify({
        ...JSON.parse(chunk({ delta: { role: 'assistant', content: 'Unsafe' } })),
        unexpected: true
      }),
      '[DONE]'
    ]));
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_chat'),
      request: dispatchRequest({})
    });
    await expect(handle.completion).resolves.toEqual({
      state: 'failed',
      providerOperationId: 'deepseek-operation-1',
      safeCode: 'deepseek.invalid_response'
    });
    expect(fixture.transport.requests).toHaveLength(1);
    expect(fixture.usage.observations.at(-1)?.status).toBe('invalid_response');
  });

  it('cancels one active stream locally and records not_reported usage', async () => {
    const fixture = chatFixture();
    fixture.transport.responses.push(cancellableStreamResponse());
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_chat'),
      request: dispatchRequest({})
    });
    await expect(fixture.adapter.cancel(handle.providerOperationId)).resolves.toBe(true);
    await expect(handle.completion).resolves.toEqual({
      state: 'cancelled',
      providerOperationId: 'deepseek-operation-1'
    });
    expect(fixture.lifecycle.events).toEqual([
      'start:response-execution-deepseek',
      'cancel-requested:response-execution-deepseek',
      'cancelled:response-execution-deepseek'
    ]);
    expect(fixture.usage.observations[0]?.status).toBe('not_reported');
    expect(fixture.adapter.activeOperationCount).toBe(0);
  });

  it('interrupts active streams on shutdown and requires a new explicit user attempt', async () => {
    const fixture = chatFixture();
    fixture.transport.responses.push(cancellableStreamResponse());
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_chat'),
      request: dispatchRequest({})
    });
    await fixture.adapter.dispose();
    await expect(handle.completion).resolves.toEqual({
      state: 'interrupted',
      providerOperationId: 'deepseek-operation-1',
      reason: 'application_shutdown'
    });
    expect(fixture.lifecycle.events).toEqual([
      'start:response-execution-deepseek',
      'interrupted:application_shutdown'
    ]);
    expect(fixture.usage.observations[0]?.status).toBe('unknown_outcome');
    expect(deepSeekChatRecoveryDecision('interrupted')).toEqual({
      sameOperationResumable: false,
      localReplayAvailable: true,
      action: 'user_retry_required'
    });
  });
});

describe('DeepSeek runtime and usage safety', () => {
  it('maps official HTTP failures exactly and never retries automatically', async () => {
    const transport = new SyntheticTransport();
    const statuses = [400, 401, 402, 422, 429, 500, 503] as const;
    transport.responses.push(...statuses.map((status) =>
      jsonResponse({}, status, status === 429 ? { 'retry-after': '2' } : {})
    ));
    const runtime = new DeepSeekSharedRuntime({ transport });
    const expected = [
      'invalid_request',
      'authentication_failed',
      'insufficient_balance',
      'invalid_parameters',
      'rate_limited',
      'provider_unavailable',
      'provider_unavailable'
    ];
    for (const code of expected) {
      await expect(runtime.requestModelCatalog({
        connection: officialConnection(),
        credentials: credential
      })).rejects.toMatchObject({ code });
    }
    expect(transport.requests).toHaveLength(statuses.length);
  });

  it('maps versioned usage metrics, rejects inconsistent totals, and ignores unknown usage keys', () => {
    expect(mapDeepSeekUsage({
      completion_tokens: 10,
      prompt_tokens: 20,
      prompt_cache_hit_tokens: 12,
      prompt_cache_miss_tokens: 8,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 4, audio_tokens: 1 },
      prompt_tokens_details: { cached_tokens: 12 }
    })).toEqual([
      { metricId: 'completion_tokens', quantity: '10', unit: 'token', source: 'provider_body' },
      { metricId: 'prompt_tokens', quantity: '20', unit: 'token', source: 'provider_body' },
      { metricId: 'total_tokens', quantity: '30', unit: 'token', source: 'provider_body' },
      { metricId: 'prompt_cache_hit_tokens', quantity: '12', unit: 'token', source: 'provider_body' },
      { metricId: 'prompt_cache_miss_tokens', quantity: '8', unit: 'token', source: 'provider_body' },
      { metricId: 'reasoning_tokens', quantity: '4', unit: 'token', source: 'provider_body' }
    ]);
    expect(() => mapDeepSeekUsage({
      completion_tokens: 10,
      prompt_tokens: 20,
      total_tokens: 31
    })).toThrow('inconsistent');
    expect(() => mapDeepSeekUsage({
      completion_tokens: 10,
      prompt_tokens: 20
    })).toThrow('unsupported fields');
  });

  it('completes when trailing SSE chunks use nullable content or keep-alive comments', async () => {
    const fixture = chatFixture();
    fixture.transport.responses.push(streamResponse([
      chunk({ delta: { role: 'assistant', content: '你好！我是 DeepSeek' } }),
      ': keep-alive',
      chunk({ delta: { content: null, reasoning_content: null }, finishReason: 'stop' }),
      usageChunk({
        completion_tokens: 8,
        prompt_tokens: 12,
        total_tokens: 20,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 12
      }),
      '[DONE]'
    ]));
    const handle = await fixture.adapter.submit({
      routeSnapshot: routeSnapshot('text_chat'),
      request: dispatchRequest({})
    });
    await expect(handle.completion).resolves.toMatchObject({
      state: 'completed',
      finishReason: 'stop'
    });
    expect(fixture.lifecycle.events).toEqual([
      'start:response-execution-deepseek',
      'content:你好！我是 DeepSeek',
      'complete:response-execution-deepseek'
    ]);
  });

  it('keeps an active stream open beyond the legacy timeout while chunks continue arriving', async () => {
    vi.useFakeTimers();
    try {
      const transport = new SyntheticTransport();
      transport.responses.push(delayedByteStreamResponse([
        { afterMs: 80, value: 'first' },
        { afterMs: 80, value: 'second' },
        { afterMs: 80, value: 'third' }
      ]));
      const runtime = new DeepSeekSharedRuntime({
        transport,
        defaultTimeoutMs: 100,
        defaultStreamTotalTimeoutMs: 1_000
      });
      const session = await runtime.openChatStream({
        credentials: credential,
        body: new TextEncoder().encode('{}')
      });
      const received: string[] = [];
      const completion = (async () => {
        for await (const bytes of session.stream) {
          received.push(new TextDecoder().decode(bytes));
        }
      })();

      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersByTimeAsync(80);
      await completion;

      expect(received).toEqual(['first', 'second', 'third']);
      expect(runtime.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count local chunk processing time as upstream stream idle time', async () => {
    vi.useFakeTimers();
    try {
      const transport = new SyntheticTransport();
      transport.responses.push(delayedByteStreamResponse([
        { afterMs: 0, value: 'first' },
        { afterMs: 0, value: 'second' }
      ]));
      const runtime = new DeepSeekSharedRuntime({
        transport,
        defaultStreamIdleTimeoutMs: 100,
        defaultStreamTotalTimeoutMs: 1_000
      });
      const session = await runtime.openChatStream({
        credentials: credential,
        body: new TextEncoder().encode('{}')
      });
      const received: string[] = [];
      const completion = (async () => {
        for await (const bytes of session.stream) {
          received.push(new TextDecoder().decode(bytes));
          if (received.length === 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
      })();

      await vi.advanceTimersByTimeAsync(150);
      await vi.advanceTimersByTimeAsync(1);
      await completion;

      expect(received).toEqual(['first', 'second']);
      expect(runtime.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out when the upstream connection never returns response headers', async () => {
    vi.useFakeTimers();
    try {
      const transport: DeepSeekHttpTransport = {
        send: (request) => new Promise((_resolve, reject) => {
          const fail = () => reject(new DeepSeekTransportFailure('cancelled'));
          if (request.signal.aborted) fail();
          else request.signal.addEventListener('abort', fail, { once: true });
        })
      };
      const runtime = new DeepSeekSharedRuntime({
        transport,
        defaultConnectionTimeoutMs: 100,
        defaultStreamIdleTimeoutMs: 500,
        defaultStreamTotalTimeoutMs: 1_000
      });
      const opening = runtime.openChatStream({
        credentials: credential,
        body: new TextEncoder().encode('{}')
      });
      const openingExpectation = expect(opening).rejects.toMatchObject({
        code: 'timeout'
      });

      await vi.advanceTimersByTimeAsync(100);
      await openingExpectation;
      expect(runtime.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out only after the upstream stream becomes idle and preserves accepted content', async () => {
    vi.useFakeTimers();
    try {
      const fixture = chatFixture({
        defaultStreamIdleTimeoutMs: 100,
        defaultStreamTotalTimeoutMs: 1_000
      });
      fixture.transport.responses.push(stalledStreamResponse(
        chunk({ delta: { content: 'Preserved partial answer' } })
      ));
      const handle = await fixture.adapter.submit({
        routeSnapshot: routeSnapshot('text_chat'),
        request: dispatchRequest({})
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.lifecycle.events).toContain(
        'content:Preserved partial answer'
      );
      await vi.advanceTimersByTimeAsync(101);

      await expect(handle.completion).resolves.toEqual({
        state: 'failed',
        providerOperationId: 'deepseek-operation-1',
        safeCode: 'deepseek.timeout'
      });
      expect(fixture.lifecycle.events).toEqual([
        'start:response-execution-deepseek',
        'content:Preserved partial answer',
        'fail:deepseek.timeout'
      ]);
      expect(fixture.runtime.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a bounded total stream duration as the final safety cap', async () => {
    vi.useFakeTimers();
    try {
      const transport = new SyntheticTransport();
      transport.responses.push(delayedByteStreamResponse([
        { afterMs: 80, value: 'first' },
        { afterMs: 80, value: 'second' },
        { afterMs: 80, value: 'third' }
      ]));
      const runtime = new DeepSeekSharedRuntime({
        transport,
        defaultStreamIdleTimeoutMs: 100,
        defaultStreamTotalTimeoutMs: 210
      });
      const session = await runtime.openChatStream({
        credentials: credential,
        body: new TextEncoder().encode('{}')
      });
      let receivedChunks = 0;
      const completion = (async () => {
        for await (const bytes of session.stream) {
          if (bytes.byteLength > 0) receivedChunks += 1;
        }
      })();
      const completionExpectation = expect(completion).rejects.toMatchObject({
        code: 'timeout'
      });

      await vi.advanceTimersByTimeAsync(210);
      await completionExpectation;
      expect(receivedChunks).toBe(2);
      expect(runtime.activeRequestCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function chatFixture(timeoutOptions: {
  readonly defaultTimeoutMs?: number;
  readonly defaultConnectionTimeoutMs?: number;
  readonly defaultStreamIdleTimeoutMs?: number;
  readonly defaultStreamTotalTimeoutMs?: number;
} = {}) {
  const transport = new SyntheticTransport();
  const logs: DeepSeekSafeLogEvent[] = [];
  const runtime = new DeepSeekSharedRuntime({
    transport,
    logger: (event) => logs.push(event),
    defaultTimeoutMs: 10_000,
    ...timeoutOptions
  });
  const lifecycle = new RecordingLifecycle();
  const usage = new RecordingUsageSink();
  const credentials = new RecordingCredentialResolver();
  let operationSequence = 0;
  let usageSequence = 0;
  const ids: DeepSeekChatAdapterIdFactory = {
    nextProviderOperationId: () =>
      `deepseek-operation-${++operationSequence}`,
    nextProviderUsageObservationId: () =>
      toProviderUsageObservationId(`deepseek-usage-${++usageSequence}`)
  };
  return {
    transport,
    logs,
    runtime,
    lifecycle,
    usage,
    credentials,
    adapter: new DeepSeekChatAdapter(
      runtime,
      credentials,
      lifecycle,
      usage,
      ids,
      {},
      () => timestamp
    )
  };
}

class RecordingLifecycle implements DeepSeekConversationLifecyclePort {
  readonly events: string[] = [];
  async start(executionId: ConversationResponseExecutionId) {
    this.events.push(`start:${executionId}`);
  }
  async appendReasoning(_executionId: ConversationResponseExecutionId, delta: string) {
    this.events.push(`reasoning:${delta}`);
  }
  async appendContent(_executionId: ConversationResponseExecutionId, delta: string) {
    this.events.push(`content:${delta}`);
  }
  async complete(executionId: ConversationResponseExecutionId) {
    this.events.push(`complete:${executionId}`);
  }
  async requestCancel(executionId: ConversationResponseExecutionId) {
    this.events.push(`cancel-requested:${executionId}`);
  }
  async confirmCancelled(executionId: ConversationResponseExecutionId) {
    this.events.push(`cancelled:${executionId}`);
  }
  async fail(_executionId: ConversationResponseExecutionId, safeCode: string) {
    this.events.push(`fail:${safeCode}`);
  }
  async interrupt(_executionId: ConversationResponseExecutionId, reason: 'application_shutdown') {
    this.events.push(`interrupted:${reason}`);
  }
}

class RecordingUsageSink implements DeepSeekUsageObservationSinkPort {
  readonly observations: ProviderUsageObservationV1[] = [];
  readonly schemas: UsageSchemaV1[] = [];
  async append(observation: ProviderUsageObservationV1, schema: UsageSchemaV1) {
    this.observations.push(observation);
    this.schemas.push(schema);
  }
}

class RecordingCredentialResolver implements DeepSeekCredentialResolverPort {
  readonly calls: { connectionId: string; credentialVersionId: string }[] = [];
  async useCredential<T>(
    input: { connectionId: string; credentialVersionId: string },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T> {
    this.calls.push(input);
    return operation(credential);
  }
}

class SyntheticTransport implements DeepSeekHttpTransport {
  readonly requests: DeepSeekHttpTransportRequest[] = [];
  readonly responses: DeepSeekHttpTransportResponse[] = [];
  readonly failures: unknown[] = [];

  async send(request: DeepSeekHttpTransportRequest): Promise<DeepSeekHttpTransportResponse> {
    latestRequestForCancellableStream = request;
    this.requests.push({
      ...request,
      headers: { ...request.headers },
      ...(request.body ? { body: Uint8Array.from(request.body) } : {})
    });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const response = this.responses.shift();
    if (!response) throw new Error('Synthetic DeepSeek response is missing');
    return response;
  }
}

function officialConnection(): ProviderConnection {
  return createProviderConnection({
    id: toConnectionId('connection-deepseek-official'),
    providerId: toProviderId('provider-deepseek-official'),
    name: 'DeepSeek Official',
    endpoint: 'https://api.deepseek.com/',
    packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
    templateId: DEEPSEEK_OFFICIAL_TEMPLATE_ID,
    templateKind: 'official',
    credentialSchemaId: DEEPSEEK_CREDENTIAL_SCHEMA_ID,
    credentialSchemaVersion: 1,
    credentialVersionId: 'credential-version-deepseek-1',
    connectionPolicyId: 'connection.deepseek.official',
    connectionPolicyRevision: 1,
    discoveryPolicyId: 'discovery.deepseek.models',
    discoveryPolicyRevision: 1,
    endpointPolicyId: DEEPSEEK_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    connectionConfigVersionId: 'connection-config-deepseek-1',
    connectionRevision: 1,
    adapterBindings: [{
      adapterId: DEEPSEEK_CHAT_ADAPTER_ID,
      adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
      protocolId: DEEPSEEK_CHAT_PROTOCOL_ID,
      protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION
    }],
    state: 'saved',
    identityState: 'unverified',
    credentialState: 'saved',
    credentialReference: 'credential-deepseek-official',
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

function routeSnapshot(feature: 'text_chat' | 'text_reasoning') {
  return createProviderExecutionRouteSnapshot(routeInput(feature));
}

function routeInput(feature: 'text_chat' | 'text_reasoning') {
  return {
    id: toProviderExecutionRouteSnapshotId(`route-deepseek-${feature}`),
    projectId: toProjectId('project-deepseek'),
    packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
    adapterKey: DEEPSEEK_CHAT_ADAPTER_ID,
    adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
    providerId: toProviderId('provider-deepseek-official'),
    connectionId: toConnectionId('connection-deepseek-official'),
    connectionRevision: 1,
    connectionConfigVersionId: 'connection-config-deepseek-1',
    endpointPolicyId: DEEPSEEK_ENDPOINT_POLICY_ID,
    endpointPolicyRevision: 1,
    credentialVersionId: 'credential-version-deepseek-1',
    modelId: toModelId(`model-deepseek-${feature}`),
    providerModelKey: 'deepseek-v4-flash',
    modelRevision: 1,
    profileId: `profile-deepseek-${feature}`,
    profileRevision: 1,
    protocolBindingId: toProtocolBindingId('protocol-binding-deepseek-chat'),
    protocolBindingRevision: 1,
    productFeature: feature,
    internalPurpose: 'text_execution',
    featureMappingVersion: 1,
    parameterSchemaId: feature === 'text_chat'
      ? DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID
      : DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
    parameterSchemaRevision: 1,
    resultSchemaId: DEEPSEEK_RESULT_SCHEMA_ID,
    resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId(DEEPSEEK_USAGE_SCHEMA_ID),
    usageSchemaRevision: 1,
    constraintSetId: DEEPSEEK_CONSTRAINT_SET_ID,
    constraintSetRevision: 1,
    runtimePolicyId: 'runtime.deepseek.synthetic',
    runtimePolicyRevision: 1,
    runtimeAuthorizationClaimId: 'claim-deepseek-synthetic',
    createdAt: timestamp
  } as const;
}

function dispatchRequest(parameterValues: Record<string, unknown>) {
  return {
    responseExecutionId: toConversationResponseExecutionId(
      'response-execution-deepseek'
    ),
    invocationAttemptId: toProviderInvocationAttemptId(
      'invocation-attempt-deepseek'
    ),
    messages: [{ role: 'user', content: 'Synthetic user message' }],
    parameterValues
  };
}

function modelCatalog(ids: readonly string[]) {
  return {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', owned_by: 'deepseek' }))
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): DeepSeekHttpTransportResponse {
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

function streamResponse(dataEvents: readonly string[]): DeepSeekHttpTransportResponse {
  const payload = new TextEncoder().encode(
    dataEvents.map((data) =>
      data.startsWith(':') || data.startsWith('data:')
        ? `${data}\r\n\r\n`
        : `data: ${data}\r\n\r\n`
    ).join('')
  );
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    stream: splitBytes(payload, [3, 17, 41, 83])
  };
}

function cancellableStreamResponse(): DeepSeekHttpTransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    stream: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(
          `data: ${chunk({ delta: { role: 'assistant', content: '' } })}\n\n`
        );
        await new Promise<never>((_resolve, reject) => {
          const request = currentSyntheticRequest();
          const fail = () => reject(new DeepSeekTransportFailure('cancelled'));
          if (request.signal.aborted) fail();
          else request.signal.addEventListener('abort', fail, { once: true });
        });
      }
    }
  };
}

function delayedByteStreamResponse(
  chunks: readonly { readonly afterMs: number; readonly value: string }[]
): DeepSeekHttpTransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    stream: {
      async *[Symbol.asyncIterator]() {
        for (const item of chunks) {
          await waitForSyntheticStream(item.afterMs);
          yield new TextEncoder().encode(item.value);
        }
      }
    }
  };
}

function stalledStreamResponse(initialEvent: string): DeepSeekHttpTransportResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    stream: {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(`data: ${initialEvent}\n\n`);
        await waitForSyntheticStream(60 * 60_000);
      }
    }
  };
}

let latestRequestForCancellableStream: DeepSeekHttpTransportRequest | undefined;

function currentSyntheticRequest(): DeepSeekHttpTransportRequest {
  if (!latestRequestForCancellableStream) {
    throw new Error('Synthetic cancellable request is unavailable');
  }
  return latestRequestForCancellableStream;
}

function waitForSyntheticStream(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = currentSyntheticRequest();
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = () => finish(() => reject(
      new DeepSeekTransportFailure('cancelled')
    ));
    const timeout = setTimeout(() => finish(resolve), milliseconds);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
  });
}

async function* splitBytes(
  bytes: Uint8Array,
  cuts: readonly number[]
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  for (const size of cuts) {
    if (offset >= bytes.byteLength) break;
    yield bytes.slice(offset, Math.min(bytes.byteLength, offset + size));
    offset += size;
  }
  if (offset < bytes.byteLength) yield bytes.slice(offset);
}

function chunk(input: {
  readonly delta: Record<string, unknown>;
  readonly finishReason?: string;
  readonly usage?: unknown;
}): string {
  return JSON.stringify({
    id: 'remote-stream-id-not-public',
    choices: [{
      delta: input.delta,
      finish_reason: input.finishReason ?? null,
      index: 0,
      logprobs: null
    }],
    created: 1,
    model: 'deepseek-v4-flash',
    object: 'chat.completion.chunk',
    ...(input.usage !== undefined ? { usage: input.usage } : {})
  });
}

function usageChunk(usage: unknown): string {
  return JSON.stringify({
    id: 'remote-stream-id-not-public',
    choices: [],
    created: 1,
    model: 'deepseek-v4-flash',
    object: 'chat.completion.chunk',
    usage
  });
}

function bodyOf(request: DeepSeekHttpTransportRequest): Record<string, unknown> {
  if (!request.body) throw new Error('Synthetic request body is missing');
  return JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
}
