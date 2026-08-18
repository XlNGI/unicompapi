import { randomUUID } from 'node:crypto';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toIsoTimestamp,
  validateParameterValues,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionState,
  type IsoTimestamp,
  type ParameterSchemaV2,
  type ParameterValue,
  type ProviderConnection,
  type ProviderInvocationAttemptId,
  type ProviderUsageObservationId,
  type ProviderUsageObservationV1,
  type StructuredCredentialRecord,
  type UsageFactV1,
  type UsageSchemaV1
} from '../../../domain';
import type {
  ProviderCatalogEntryV1,
  ProviderManagementAdapterIdentityV1,
  ProviderManagementAdapterPort,
  ProviderConnectionValidationResultV1
} from '../provider-management-framework';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_CHAT_RESULT_SCHEMA_ID,
  NEWAPI_CHAT_USAGE_SCHEMA_ID,
  NEWAPI_TEXT_CONSTRAINT_SET_ID,
  newApiChatUsageSchema
} from './newapi-contracts';
import {
  isOpenAiCompatibleEndpointPolicyId,
  isOpenAiCompatiblePackageId
} from './openai-compatible-identity';
import {
  isUniCompApiPackage
} from './unicompapi-model-capabilities';
import {
  NewApiRuntimeError,
  type NewApiEventStreamSession,
  type NewApiSharedRuntime
} from './newapi-runtime';

export interface NewApiCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface NewApiConnectionResolverPort {
  get(connectionId: string): Promise<ProviderConnection | undefined>;
}

export interface NewApiParameterSchemaResolverPort {
  get(schemaId: string, revision: number): Promise<ParameterSchemaV2 | undefined>;
}

export interface NewApiConversationLifecyclePort {
  start(executionId: ConversationResponseExecutionId): Promise<unknown>;
  appendReasoning(
    executionId: ConversationResponseExecutionId,
    reasoningDelta: string
  ): Promise<unknown>;
  appendContent(
    executionId: ConversationResponseExecutionId,
    contentDelta: string
  ): Promise<unknown>;
  complete(executionId: ConversationResponseExecutionId): Promise<unknown>;
  requestCancel(executionId: ConversationResponseExecutionId): Promise<unknown>;
  confirmCancelled(executionId: ConversationResponseExecutionId): Promise<unknown>;
  fail(
    executionId: ConversationResponseExecutionId,
    safeCode: string
  ): Promise<unknown>;
  interrupt(
    executionId: ConversationResponseExecutionId,
    reason: 'transport_interrupted' | 'application_shutdown'
  ): Promise<unknown>;
}

export interface NewApiUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface NewApiChatAdapterIdFactory {
  nextProviderOperationId(): string;
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface NewApiChatTerminalObserverPort {
  completed?(input: {
    readonly providerOperationId: string;
    readonly responseExecutionId: ConversationResponseExecutionId;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly finishReason: 'stop' | 'length';
  }): Promise<void>;
  failed?(input: {
    readonly providerOperationId: string;
    readonly responseExecutionId: ConversationResponseExecutionId;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly safeCode: string;
  }): Promise<void>;
  cancelled?(input: {
    readonly providerOperationId: string;
    readonly responseExecutionId: ConversationResponseExecutionId;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
  }): Promise<void>;
  interrupted?(input: {
    readonly providerOperationId: string;
    readonly responseExecutionId: ConversationResponseExecutionId;
    readonly invocationAttemptId: ProviderInvocationAttemptId;
    readonly reason: 'transport_interrupted' | 'application_shutdown';
  }): Promise<void>;
}

export interface NewApiChatMessageV1 {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface NewApiChatDispatchRequestV1 {
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly messages: readonly NewApiChatMessageV1[];
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

export type NewApiChatTerminalResult =
  | {
      readonly state: 'completed';
      readonly providerOperationId: string;
      readonly finishReason: 'stop' | 'length';
      readonly usageAvailability: 'reported' | 'not_reported';
    }
  | {
      readonly state: 'failed';
      readonly providerOperationId: string;
      readonly safeCode: string;
    }
  | {
      readonly state: 'cancelled';
      readonly providerOperationId: string;
    }
  | {
      readonly state: 'interrupted';
      readonly providerOperationId: string;
      readonly reason: 'application_shutdown';
    };

export interface NewApiChatOperationHandle {
  readonly providerOperationId: string;
  readonly completion: Promise<NewApiChatTerminalResult>;
}

interface ActiveOperation {
  readonly providerOperationId: string;
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly session: NewApiEventStreamSession;
  readonly removeExternalAbort: () => void;
  cancelReason?: 'user' | 'application_shutdown';
  cancelRequest?: Promise<unknown>;
  completion?: Promise<NewApiChatTerminalResult>;
}

export class NewApiManagementAdapter implements ProviderManagementAdapterPort {
  readonly identity: ProviderManagementAdapterIdentityV1;
  private readonly now: () => IsoTimestamp;

  constructor(
    private readonly runtime: NewApiSharedRuntime,
    options: {
      readonly packageId?: string;
      readonly now?: () => IsoTimestamp;
    } = {}
  ) {
    this.identity = {
      packageId: options.packageId ?? NEWAPI_PROVIDER_PACKAGE_ID,
      adapterId: NEWAPI_CHAT_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      protocolVersion: NEWAPI_PROTOCOL_VERSION
    };
    this.now = options.now ?? (() => toIsoTimestamp(new Date().toISOString()));
  }

  async validateConnection(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<ProviderConnectionValidationResultV1> {
    try {
      parseModelCatalog(await this.runtime.requestModelCatalog(input));
      return {
        state: 'available',
        identityState: 'verified',
        credentialState: 'valid',
        observedAt: this.now()
      };
    } catch (error) {
      const code = safeCodeForError(error);
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState:
          error instanceof NewApiRuntimeError &&
          error.code === 'authentication_failed'
            ? 'invalid'
            : 'verification_unavailable',
        observedAt: this.now(),
        safeCode: code
      };
    }
  }

  async discoverModels(input: {
    readonly connection: ProviderConnection;
    readonly endpoint?: string;
    readonly credentials: StructuredCredentialRecord;
  }): Promise<{
    readonly entries: readonly ProviderCatalogEntryV1[];
    readonly observedAt: IsoTimestamp;
  }> {
    return {
      entries: parseModelCatalog(await this.runtime.requestModelCatalog(input)),
      observedAt: this.now()
    };
  }
}

export class NewApiChatAdapter {
  private readonly active = new Map<string, ActiveOperation>();
  private disposed = false;

  constructor(
    private readonly runtime: NewApiSharedRuntime,
    private readonly credentials: NewApiCredentialResolverPort,
    private readonly connections: NewApiConnectionResolverPort,
    private readonly parameterSchemas: NewApiParameterSchemaResolverPort,
    private readonly lifecycle: NewApiConversationLifecyclePort,
    private readonly usage: NewApiUsageObservationSinkPort,
    private readonly ids: NewApiChatAdapterIdFactory = {
      nextProviderOperationId: () => `newapi-chat-${randomUUID()}`,
      nextProviderUsageObservationId: () =>
        `newapi-usage-${randomUUID()}` as ProviderUsageObservationId
    },
    private readonly terminalObserver: NewApiChatTerminalObserverPort = {},
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<NewApiChatOperationHandle> {
    if (this.disposed) {
      throw new NewApiRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    const route = validateRoute(input.routeSnapshot);
    const request = parseDispatchRequest(input.request);
    const [connection, parameterSchema] = await Promise.all([
      this.connections.get(route.connectionId),
      this.parameterSchemas.get(route.parameterSchemaId, route.parameterSchemaRevision)
    ]);
    if (!connection || connection.id !== route.connectionId) {
      throw new NewApiChatAdapterError(
        'newapi.connection_unavailable',
        'The NewAPI connection captured by the route is unavailable'
      );
    }
    if (
      !parameterSchema ||
      parameterSchema.schemaId !== route.parameterSchemaId ||
      parameterSchema.revision !== route.parameterSchemaRevision ||
      parameterSchema.productFeature !== route.productFeature
    ) {
      throw new NewApiChatAdapterError(
        'newapi.parameter_schema_unavailable',
        'The NewAPI parameter schema captured by the route is unavailable'
      );
    }
    const body = serializeRequest(route, request, parameterSchema);
    const providerOperationId = requireOpaqueId(
      this.ids.nextProviderOperationId(),
      'provider operation ID'
    );
    if (this.active.has(providerOperationId)) {
      throw new NewApiChatAdapterError(
        'newapi.operation_id_conflict',
        'NewApi operation IDs must be unique'
      );
    }
    const externalController = new AbortController();
    const removeExternalAbort = linkAbort(input.signal, externalController);
    let session: NewApiEventStreamSession | undefined;
    try {
      session = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.openChatStream({
          connection,
          credentials: credential,
          body,
          signal: externalController.signal,
          beforeRequestStarted: input.beforeRequestStarted
        })
      );
      await this.lifecycle.start(request.responseExecutionId);
    } catch (error) {
      removeExternalAbort();
      session?.close();
      await this.lifecycle
        .fail(request.responseExecutionId, safeCodeForError(error))
        .catch(() => undefined);
      throw error;
    }
    if (!session) {
      removeExternalAbort();
      throw new NewApiChatAdapterError(
        'newapi.operation_failed',
        'NewApi did not create a stream session'
      );
    }
    const operation: ActiveOperation = {
      providerOperationId,
      responseExecutionId: request.responseExecutionId,
      invocationAttemptId: request.invocationAttemptId,
      productFeature: route.productFeature === 'text_reasoning'
        ? 'text_reasoning'
        : 'text_chat',
      session,
      removeExternalAbort
    };
    this.active.set(providerOperationId, operation);
    const completion = this.consume(operation, route.providerModelKey!);
    operation.completion = completion;
    return { providerOperationId, completion };
  }

  async cancel(providerOperationId: string): Promise<boolean> {
    const operation = this.active.get(
      requireOpaqueId(providerOperationId, 'provider operation ID')
    );
    if (!operation) return false;
    if (!operation.cancelReason) {
      operation.cancelReason = 'user';
      operation.cancelRequest = this.lifecycle.requestCancel(operation.responseExecutionId);
      void operation.cancelRequest.catch(() => undefined);
      operation.session.cancel();
    }
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const operations = [...this.active.values()];
    for (const operation of operations) {
      operation.cancelReason = 'application_shutdown';
      operation.session.cancel();
    }
    await Promise.all(operations.map((operation) => operation.completion));
    this.runtime.dispose();
  }

  get activeOperationCount(): number {
    return this.active.size;
  }

  private async consume(
    operation: ActiveOperation,
    expectedModel: string
  ): Promise<NewApiChatTerminalResult> {
    let usagePersisted = false;
    try {
      const stream = await consumeNewApiStream(
        operation.session.stream,
        expectedModel,
        async (contentDelta) => {
          await this.lifecycle.appendContent(
            operation.responseExecutionId,
            contentDelta
          );
        },
        async (reasoningDelta) => {
          if (operation.productFeature === 'text_reasoning') {
            await this.lifecycle.appendReasoning(
              operation.responseExecutionId,
              reasoningDelta
            );
          }
        }
      );
      const observation = createUsageObservation({
        observationId: this.ids.nextProviderUsageObservationId(),
        invocationAttemptId: operation.invocationAttemptId,
        providerOperationId: operation.providerOperationId,
        status: stream.usage ? 'reported' : 'not_reported',
        facts: stream.usage ?? [],
        observedAt: this.now()
      });
      await this.usage.append(observation, newApiChatUsageSchema);
      usagePersisted = true;
      // Official length means the returned content may be cut off. If deltas were
      // already accepted, complete the local answer instead of failing after accept.
      if (
        stream.finishReason === 'length' &&
        stream.contentLength > 0
      ) {
        await this.lifecycle.complete(operation.responseExecutionId);
        await this.terminalObserver.completed?.({
          providerOperationId: operation.providerOperationId,
          responseExecutionId: operation.responseExecutionId,
          invocationAttemptId: operation.invocationAttemptId,
          finishReason: 'length'
        });
        return {
          state: 'completed',
          providerOperationId: operation.providerOperationId,
          finishReason: 'length',
          usageAvailability: stream.usage ? 'reported' : 'not_reported'
        };
      }
      if (stream.finishReason !== 'stop') {
        const safeCode = finishReasonSafeCode(stream.finishReason);
        await this.lifecycle.fail(operation.responseExecutionId, safeCode);
        await this.terminalObserver.failed?.({
          providerOperationId: operation.providerOperationId,
          responseExecutionId: operation.responseExecutionId,
          invocationAttemptId: operation.invocationAttemptId,
          safeCode
        });
        return {
          state: 'failed',
          providerOperationId: operation.providerOperationId,
          safeCode
        };
      }
      await this.lifecycle.complete(operation.responseExecutionId);
      await this.terminalObserver.completed?.({
        providerOperationId: operation.providerOperationId,
        responseExecutionId: operation.responseExecutionId,
        invocationAttemptId: operation.invocationAttemptId,
        finishReason: 'stop'
      });
      return {
        state: 'completed',
        providerOperationId: operation.providerOperationId,
        finishReason: 'stop',
        usageAvailability: stream.usage ? 'reported' : 'not_reported'
      };
    } catch (error) {
      if (operation.cancelReason === 'user') {
        await operation.cancelRequest?.catch(() => undefined);
        if (!usagePersisted) {
          await this.persistUsageStatus(operation, 'not_reported').catch(() => undefined);
        }
        await this.lifecycle.confirmCancelled(operation.responseExecutionId);
        await this.terminalObserver.cancelled?.({
          providerOperationId: operation.providerOperationId,
          responseExecutionId: operation.responseExecutionId,
          invocationAttemptId: operation.invocationAttemptId
        });
        return {
          state: 'cancelled',
          providerOperationId: operation.providerOperationId
        };
      }
      if (operation.cancelReason === 'application_shutdown') {
        if (!usagePersisted) {
          await this.persistUsageStatus(operation, 'unknown_outcome').catch(() => undefined);
        }
        await this.lifecycle.interrupt(
          operation.responseExecutionId,
          'application_shutdown'
        );
        await this.terminalObserver.interrupted?.({
          providerOperationId: operation.providerOperationId,
          responseExecutionId: operation.responseExecutionId,
          invocationAttemptId: operation.invocationAttemptId,
          reason: 'application_shutdown'
        });
        return {
          state: 'interrupted',
          providerOperationId: operation.providerOperationId,
          reason: 'application_shutdown'
        };
      }
      if (!usagePersisted) {
        await this.persistFailureUsage(operation, error).catch(() => undefined);
      }
      const safeCode = safeCodeForError(error);
      await this.lifecycle.fail(operation.responseExecutionId, safeCode);
      await this.terminalObserver.failed?.({
        providerOperationId: operation.providerOperationId,
        responseExecutionId: operation.responseExecutionId,
        invocationAttemptId: operation.invocationAttemptId,
        safeCode
      });
      return {
        state: 'failed',
        providerOperationId: operation.providerOperationId,
        safeCode
      };
    } finally {
      operation.session.close();
      operation.removeExternalAbort();
      this.active.delete(operation.providerOperationId);
    }
  }

  private async persistFailureUsage(
    operation: ActiveOperation,
    error: unknown
  ): Promise<void> {
    const invalid = error instanceof NewApiChatAdapterError;
    const status = invalid ? 'invalid_response' : 'unknown_outcome';
    await this.persistUsageStatus(operation, status);
  }

  private async persistUsageStatus(
    operation: ActiveOperation,
    status: 'not_reported' | 'invalid_response' | 'unknown_outcome'
  ): Promise<void> {
    await this.usage.append(createUsageObservation({
      observationId: this.ids.nextProviderUsageObservationId(),
      invocationAttemptId: operation.invocationAttemptId,
      providerOperationId: operation.providerOperationId,
      status,
      facts: [],
      observedAt: this.now()
    }), newApiChatUsageSchema);
  }
}

export function mapNewApiUsage(value: unknown): readonly UsageFactV1[] {
  if (!isRecord(value)) {
    throw invalidStream('NewAPI usage must be an object');
  }
  // Compatible gateways may add token-detail metrics over time. Validate the
  // accounting fields we consume and ignore unknown forward-compatible keys.
  for (const key of ['completion_tokens', 'prompt_tokens', 'total_tokens'] as const) {
    if (!(key in value)) {
      throw invalidStream('NewAPI usage is missing required fields');
    }
  }
  const completionTokens = nonNegativeInteger(
    value.completion_tokens,
    'completion_tokens'
  );
  const promptTokens = nonNegativeInteger(value.prompt_tokens, 'prompt_tokens');
  const totalTokens = nonNegativeInteger(value.total_tokens, 'total_tokens');
  if (totalTokens !== promptTokens + completionTokens) {
    throw invalidStream('NewAPI total token usage is inconsistent');
  }
  const facts: UsageFactV1[] = [
    tokenFact('completion_tokens', completionTokens),
    tokenFact('prompt_tokens', promptTokens),
    tokenFact('total_tokens', totalTokens)
  ];
  if (value.prompt_tokens_details !== undefined) {
    if (!isRecord(value.prompt_tokens_details)) {
      throw invalidStream('NewAPI prompt token details must be an object');
    }
    const cachedTokens = optionalNonNegativeInteger(
      value.prompt_tokens_details.cached_tokens,
      'cached_tokens'
    );
    if (cachedTokens !== undefined) {
      if (cachedTokens > promptTokens) {
        throw invalidStream('NewAPI cached token usage is inconsistent');
      }
      facts.push(tokenFact('cached_tokens', cachedTokens));
    }
  }
  if (value.completion_tokens_details !== undefined) {
    if (!isRecord(value.completion_tokens_details)) {
      throw invalidStream('NewAPI completion token details must be an object');
    }
    const reasoningTokens = optionalNonNegativeInteger(
      value.completion_tokens_details.reasoning_tokens,
      'reasoning_tokens'
    );
    if (reasoningTokens !== undefined) {
      if (reasoningTokens > completionTokens) {
        throw invalidStream('NewAPI reasoning token usage is inconsistent');
      }
      facts.push(tokenFact('reasoning_tokens', reasoningTokens));
    }
  }
  return facts;
}

export function newApiChatRecoveryDecision(
  state: ConversationResponseExecutionState
): {
  readonly sameOperationResumable: false;
  readonly localReplayAvailable: boolean;
  readonly action: 'none' | 'user_retry_required';
} {
  return {
    sameOperationResumable: false,
    localReplayAvailable: state !== 'pending',
    action: state === 'interrupted' ? 'user_retry_required' : 'none'
  };
}

async function consumeNewApiStream(
  stream: AsyncIterable<Uint8Array>,
  expectedModel: string,
  onContent: (delta: string) => Promise<void>,
  onReasoning: (delta: string) => Promise<void>
): Promise<{
  readonly finishReason: NewApiFinishReason;
  readonly contentLength: number;
  readonly usage?: readonly UsageFactV1[];
}> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let done = false;
  let terminalReason: NewApiFinishReason | undefined;
  let usage: readonly UsageFactV1[] | undefined;
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let contentLength = 0;

  const processEvent = async (eventText: string) => {
    // Ignore blank events and SSE comment/keep-alive lines. These are transport
    // framing, not model response fields.
    const dataLines = eventText
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith(':'));
    if (dataLines.length === 0) return;
    if (done) throw invalidStream('NewApi streamed data after the terminal marker');
    const data = parseDataOnlyEvent(dataLines.join('\n'));
    if (data === '[DONE]') {
      if (!terminalReason) {
        throw invalidStream('NewApi stream ended before a finish reason');
      }
      done = true;
      return;
    }
    const chunk = parseStreamChunk(data);
    responseId ??= chunk.id;
    responseModel ??= chunk.model;
    if (
      chunk.id !== responseId ||
      !sameProviderModelKey(chunk.model, responseModel) ||
      !sameProviderModelKey(chunk.model, expectedModel)
    ) {
      throw invalidStream('NewApi stream identity changed');
    }
    if (chunk.usage) {
      if (usage) throw invalidStream('NewApi stream reported usage more than once');
      usage = chunk.usage;
    }
    if (chunk.reasoningDelta) {
      await onReasoning(chunk.reasoningDelta);
    }
    if (chunk.contentDelta) {
      contentLength += chunk.contentDelta.length;
      if (contentLength > 1_000_000) {
        throw invalidStream('NewApi stream content exceeded the local limit');
      }
      await onContent(chunk.contentDelta);
    }
    if (chunk.finishReason) {
      if (terminalReason) throw invalidStream('NewApi stream reported multiple finish reasons');
      terminalReason = chunk.finishReason;
    }
  };

  try {
    for await (const bytes of stream) {
      buffer = normalizeNewlines(buffer + decoder.decode(bytes, { stream: true }));
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const eventText = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await processEvent(eventText);
      }
    }
    buffer = normalizeNewlines(buffer + decoder.decode());
  } catch (error) {
    if (error instanceof NewApiRuntimeError) throw error;
    if (error instanceof NewApiChatAdapterError) throw error;
    throw invalidStream('NewApi stream encoding is invalid');
  }
  if (buffer.trim().length > 0) await processEvent(buffer);
  if (!done || !terminalReason) {
    throw invalidStream('NewApi stream ended without a terminal marker');
  }
  if (terminalReason === 'stop' && contentLength === 0) {
    throw invalidStream('NewApi completed with empty content');
  }
  return {
    finishReason: terminalReason,
    contentLength,
    ...(usage ? { usage } : {})
  };
}

function sameProviderModelKey(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

type NewApiFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'insufficient_system_resource';

function parseStreamChunk(data: string): {
  readonly id: string;
  readonly model: string;
  readonly reasoningDelta?: string;
  readonly contentDelta?: string;
  readonly finishReason?: NewApiFinishReason;
  readonly usage?: readonly UsageFactV1[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw invalidStream('NewApi SSE data is not valid JSON');
  }
  // UniCompAPI / NewAPI gateways may add extension fields (e.g. service_tier,
  // first_token_return_time). Require the OpenAI chunk core, ignore unknowns.
  const item = requireRecord(
    parsed,
    ['id', 'choices', 'created', 'model', 'object'],
    'NewApi stream chunk'
  );
  const id = safeString(item.id, 'NewApi response ID', 512);
  const model = safeString(item.model, 'NewApi response model', 256);
  if (
    item.object !== 'chat.completion.chunk' ||
    !Number.isSafeInteger(item.created) ||
    Number(item.created) < 0 ||
    !Array.isArray(item.choices)
  ) {
    throw invalidStream('NewApi stream chunk metadata is invalid');
  }
  const usage = item.usage === undefined || item.usage === null
    ? undefined
    : mapNewApiUsage(item.usage);
  if (item.choices.length === 0) {
    if (!usage) throw invalidStream('NewApi empty choices require final usage');
    return { id, model, usage };
  }
  if (item.choices.length !== 1) {
    throw invalidStream('NewApi stream choices are ambiguous');
  }
  // Intermediate gateway chunks often omit finish_reason entirely (not null).
  const choice = requireRecord(
    item.choices[0],
    ['delta', 'index'],
    'NewApi stream choice'
  );
  if (
    choice.index !== 0 ||
    (choice.logprobs !== undefined && choice.logprobs !== null)
  ) {
    throw invalidStream('NewApi stream choice is unsupported');
  }
  const delta = requireRecord(choice.delta, [], 'NewApi stream delta');
  if (delta.role !== undefined && delta.role !== 'assistant') {
    throw invalidStream('NewApi stream role is invalid');
  }
  const contentDelta = optionalDeltaText(delta.content, 'NewApi content delta');
  const reasoningDelta = optionalDeltaText(
    delta.reasoning_content,
    'NewApi reasoning delta'
  );
  const finishReason = choice.finish_reason === undefined || choice.finish_reason === null
    ? undefined
    : parseFinishReason(choice.finish_reason);
  return {
    id,
    model,
    ...(reasoningDelta ? { reasoningDelta } : {}),
    ...(contentDelta ? { contentDelta } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {})
  };
}

function parseModelCatalog(body: Uint8Array): readonly ProviderCatalogEntryV1[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw invalidStream('NewApi model catalog is invalid');
  }
  // OpenAI-compatible gateways (including New API / UniCompAPI) may add
  // extension fields such as `success` or `supported_endpoint_types`.
  // Require the OpenAI list shape, but ignore unknown keys.
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data) || value.data.length > 1000) {
    throw invalidStream('NewApi model catalog metadata is invalid');
  }
  const entries = value.data.map((entry) => {
    if (!isRecord(entry)) {
      throw invalidStream('NewAPI model catalog entry must be an object');
    }
    const id = safeString(entry.id, 'NewApi model ID', 256);
    if (entry.object !== undefined && entry.object !== 'model') {
      throw invalidStream('NewAPI model catalog entry type is invalid');
    }
    if (
      entry.created !== undefined &&
      (!Number.isSafeInteger(entry.created) || Number(entry.created) < 0)
    ) {
      throw invalidStream('NewAPI model catalog entry metadata is invalid');
    }
    if (entry.owned_by !== undefined) {
      safeString(entry.owned_by, 'NewApi model owner', 160);
    }
    return { providerModelKey: id, displayName: id };
  });
  if (new Set(entries.map((entry) => entry.providerModelKey)).size !== entries.length) {
    throw invalidStream('NewApi model catalog contains duplicate IDs');
  }
  return entries;
}

function validateRoute(value: unknown) {
  const route = parseProviderExecutionRouteSnapshot(value);
  if (
    !isOpenAiCompatiblePackageId(route.packageId) ||
    route.packageVersion !== NEWAPI_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== NEWAPI_CHAT_ADAPTER_ID ||
    route.adapterVersion !== NEWAPI_ADAPTER_VERSION ||
    !isOpenAiCompatibleEndpointPolicyId(route.endpointPolicyId) ||
    route.endpointPolicyRevision !== 1 ||
    (route.productFeature !== 'text_chat' && route.productFeature !== 'text_reasoning') ||
    route.internalPurpose !== 'text_execution' ||
    !Number.isSafeInteger(route.parameterSchemaRevision) ||
    route.parameterSchemaRevision < 1 ||
    route.resultSchemaId !== NEWAPI_CHAT_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== NEWAPI_CHAT_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== NEWAPI_TEXT_CONSTRAINT_SET_ID ||
    route.constraintSetRevision !== 1 ||
    !validProviderModelKey(route.providerModelKey)
  ) {
    throw new NewApiChatAdapterError(
      'newapi.route_mismatch',
      'The NewApi route snapshot is not supported by this adapter'
    );
  }
  return route;
}

function parseDispatchRequest(value: unknown): NewApiChatDispatchRequestV1 {
  const item = exactRecord(
    value,
    ['responseExecutionId', 'invocationAttemptId', 'messages', 'parameterValues'],
    [],
    'NewApi chat dispatch request'
  );
  if (!Array.isArray(item.messages) || item.messages.length < 1 || item.messages.length > 200) {
    throw invalidRequest('NewApi messages are invalid');
  }
  const messages = item.messages.map((value) => {
    const message = exactRecord(value, ['role', 'content'], [], 'NewApi message');
    if (!['system', 'user', 'assistant'].includes(String(message.role))) {
      throw invalidRequest('NewApi message role is invalid');
    }
    return {
      role: message.role as NewApiChatMessageV1['role'],
      content: boundedText(message.content, 'NewApi message content', 1_000_000)
    };
  });
  if (messages.at(-1)?.role !== 'user') {
    throw invalidRequest('NewApi messages must end with the current user message');
  }
  return {
    responseExecutionId: safeString(
      item.responseExecutionId,
      'response execution ID',
      256
    ) as ConversationResponseExecutionId,
    invocationAttemptId: safeString(
      item.invocationAttemptId,
      'invocation attempt ID',
      256
    ) as ProviderInvocationAttemptId,
    messages,
    parameterValues: plainRecord(item.parameterValues, 'NewApi parameter values') as Readonly<
      Record<string, ParameterValue>
    >
  };
}

function serializeRequest(
  route: ReturnType<typeof validateRoute>,
  request: NewApiChatDispatchRequestV1,
  schema: ParameterSchemaV2
): Uint8Array {
  const parameters = validateParameterValues(schema, 'full', request.parameterValues);
  // UniCompAPI / OpenAI-compatible gateways accept temperature and top_p together.
  const body: Record<string, unknown> = {
    model: route.providerModelKey,
    messages: request.messages,
    // Product chat path always streams; do not expose stream as a user field.
    stream: true,
    stream_options: { include_usage: true }
  };
  if (typeof parameters.max_tokens === 'number') {
    body.max_tokens = parameters.max_tokens;
  }
  if (typeof parameters.max_completion_tokens === 'number') {
    body.max_completion_tokens = parameters.max_completion_tokens;
  }
  if (typeof parameters.temperature === 'number') {
    body.temperature = parameters.temperature;
  }
  if (typeof parameters.top_p === 'number') {
    body.top_p = parameters.top_p;
  }
  const modelKey = route.providerModelKey ?? '';
  const isUniCompApiDeepSeekV4 = isUniCompApiPackage(route.packageId) &&
    (modelKey === 'deepseek-v4-flash' || modelKey === 'deepseek-v4-pro');
  const allowReasoningEffort = !modelKey.startsWith('deepseek-') ||
    modelKey === 'deepseek-v4-flash' || modelKey === 'deepseek-v4-pro';
  const reasoningEffort = typeof parameters.reasoning_effort === 'string'
    ? parameters.reasoning_effort.trim()
    : '';
  if (
    allowReasoningEffort &&
    reasoningEffort
  ) {
    body.reasoning_effort = reasoningEffort;
  } else if (
    route.productFeature === 'text_reasoning' &&
    isUniCompApiDeepSeekV4
  ) {
    body.reasoning_effort = 'medium';
  }
  for (const key of [
    'n',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'top_k'
  ] as const) {
    if (typeof parameters[key] === 'number') body[key] = parameters[key];
  }
  for (const key of [
    'response_format',
    'thinking',
    'chat_template_kwargs',
    'metadata'
  ] as const) {
    if (
      key === 'thinking' &&
      !modelKey.startsWith('glm-') &&
      !modelKey.startsWith('qwen3-')
    ) continue;
    if (key === 'chat_template_kwargs' && !modelKey.startsWith('qwen3-')) continue;
    if (parameters[key] && typeof parameters[key] === 'object') {
      body[key] = parameters[key];
    }
  }
  if (modelKey.startsWith('qwen3-') && typeof parameters.enable_thinking === 'boolean') {
    body.enable_thinking = parameters.enable_thinking;
  }
  if (typeof parameters.tool_choice === 'string' && parameters.tool_choice.trim()) {
    body.tool_choice = parameters.tool_choice.trim();
  }
  if (typeof parameters.parallel_tool_calls === 'boolean') {
    body.parallel_tool_calls = parameters.parallel_tool_calls;
  }
  if (typeof parameters.stop === 'string' && parameters.stop.trim()) {
    body.stop = parameters.stop.trim();
  } else if (Array.isArray(parameters.stop)) {
    const stops = parameters.stop
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (stops.length === 1) body.stop = stops[0];
    else if (stops.length > 1) body.stop = stops;
  }
  if (typeof parameters.user === 'string' && parameters.user.trim()) {
    body.user = parameters.user.trim();
  }
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  if (encoded.byteLength > 2 * 1024 * 1024) {
    throw invalidRequest('NewApi request exceeded the local size limit');
  }
  return encoded;
}

function createUsageObservation(input: {
  readonly observationId: ProviderUsageObservationId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly providerOperationId: string;
  readonly status: 'reported' | 'not_reported' | 'invalid_response' | 'unknown_outcome';
  readonly facts: readonly UsageFactV1[];
  readonly observedAt: IsoTimestamp;
}): ProviderUsageObservationV1 {
  return createProviderUsageObservation({
    id: input.observationId,
    invocationAttemptId: input.invocationAttemptId,
    usageSchemaId: newApiChatUsageSchema.id,
    usageSchemaRevision: newApiChatUsageSchema.revision,
    sourceEventKey: `newapi_usage_${input.providerOperationId}`,
    sequence: 1,
    status: input.status,
    sourceStage: 'result',
    facts: input.facts,
    observedAt: input.observedAt
  }, newApiChatUsageSchema);
}

function parseDataOnlyEvent(eventText: string): string {
  // A stream may end with a single line break after the final `data:` field
  // rather than an empty SSE event (`\n\n`). Ignore those framing-only lines.
  const lines = eventText
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.some((line) => !line.startsWith('data:'))) {
    throw invalidStream('NewApi SSE contains unsupported fields');
  }
  const data = lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  if (data.length < 1 || data.length > 1_000_000) {
    throw invalidStream('NewApi SSE data field is invalid');
  }
  return data;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseFinishReason(value: unknown): NewApiFinishReason {
  if (
    !['stop', 'length', 'content_filter', 'tool_calls', 'insufficient_system_resource']
      .includes(String(value))
  ) {
    throw invalidStream('NewApi finish reason is invalid');
  }
  return value as NewApiFinishReason;
}

function finishReasonSafeCode(reason: Exclude<NewApiFinishReason, 'stop'>): string {
  return `newapi.finish.${reason}`;
}

function safeCodeForError(error: unknown): string {
  if (error instanceof NewApiChatAdapterError) return error.safeCode;
  return runtimeSafeCode(error);
}

function runtimeSafeCode(error: unknown): string {
  return error instanceof NewApiRuntimeError
    ? `newapi.${error.code}`
    : 'newapi.operation_failed';
}

class NewApiChatAdapterError extends Error {
  constructor(readonly safeCode: string, message: string) {
    super(message);
    this.name = 'NewApiChatAdapterError';
  }
}

function invalidStream(message: string): NewApiChatAdapterError {
  return new NewApiChatAdapterError('newapi.invalid_response', message);
}

function invalidRequest(message: string): NewApiChatAdapterError {
  return new NewApiChatAdapterError('newapi.invalid_request', message);
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidStream(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidStream(`${label} contains unsupported fields`);
  }
  return value;
}

/** Require listed keys; tolerate gateway extension fields. */
function requireRecord(
  value: unknown,
  required: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidStream(`${label} must be an object`);
  if (required.some((key) => !(key in value))) {
    throw invalidStream(`${label} is missing required fields`);
  }
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidRequest(`${label} must be a plain object`);
  }
  return value;
}

function safeString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidStream(`${label} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 1 ||
    value.length > maximum ||
    /\u0000/.test(value)
  ) {
    throw invalidRequest(`${label} is invalid`);
  }
  return value;
}

function safeDelta(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 65_536 || /\u0000/.test(value)) {
    throw invalidStream(`${label} is invalid`);
  }
  return value;
}

function optionalDeltaText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return safeDelta(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidStream(`NewApi ${label} is invalid`);
  }
  return Number(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value, label);
}

function tokenFact(metricId: string, quantity: number): UsageFactV1 {
  return {
    metricId,
    quantity: String(quantity),
    unit: 'token',
    source: 'provider_body'
  };
}

function requireOpaqueId(value: unknown, label: string): string {
  const id = safeString(value, label, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw invalidRequest(`${label} is invalid`);
  }
  return id;
}

function validProviderModelKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function linkAbort(
  signal: AbortSignal | undefined,
  controller: AbortController
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
