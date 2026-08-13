import { randomUUID } from 'node:crypto';
import {
  createProviderUsageObservation,
  parseProviderExecutionRouteSnapshot,
  toIsoTimestamp,
  validateParameterValues,
  type ConversationResponseExecutionId,
  type ConversationResponseExecutionState,
  type IsoTimestamp,
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
  ProviderManagementAdapterPort,
  ProviderConnectionValidationResultV1
} from '../provider-management-framework';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION,
  DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID,
  DEEPSEEK_CHAT_PROTOCOL_ID,
  DEEPSEEK_CHAT_PROTOCOL_VERSION,
  DEEPSEEK_CONSTRAINT_SET_ID,
  DEEPSEEK_ENDPOINT_POLICY_ID,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID,
  DEEPSEEK_RESULT_SCHEMA_ID,
  DEEPSEEK_USAGE_SCHEMA_ID,
  deepSeekChatParameterSchema,
  deepSeekReasoningParameterSchema,
  deepSeekUsageSchema,
  isDeepSeekModelKey
} from './deepseek-contracts';
import {
  DeepSeekRuntimeError,
  type DeepSeekEventStreamSession,
  type DeepSeekSharedRuntime
} from './deepseek-runtime';

export interface DeepSeekCredentialResolverPort {
  useCredential<T>(
    input: {
      readonly connectionId: string;
      readonly credentialVersionId: string;
    },
    operation: (credential: StructuredCredentialRecord) => Promise<T>
  ): Promise<T>;
}

export interface DeepSeekConversationLifecyclePort {
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
    reason: 'application_shutdown'
  ): Promise<unknown>;
}

export interface DeepSeekUsageObservationSinkPort {
  append(
    observation: ProviderUsageObservationV1,
    schema: UsageSchemaV1
  ): Promise<void>;
}

export interface DeepSeekChatAdapterIdFactory {
  nextProviderOperationId(): string;
  nextProviderUsageObservationId(): ProviderUsageObservationId;
}

export interface DeepSeekChatTerminalObserverPort {
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
    readonly reason: 'application_shutdown';
  }): Promise<void>;
}

export interface DeepSeekChatMessageV1 {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface DeepSeekChatDispatchRequestV1 {
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly messages: readonly DeepSeekChatMessageV1[];
  readonly parameterValues: Readonly<Record<string, ParameterValue>>;
}

export type DeepSeekChatTerminalResult =
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

export interface DeepSeekChatOperationHandle {
  readonly providerOperationId: string;
  readonly completion: Promise<DeepSeekChatTerminalResult>;
}

interface ActiveOperation {
  readonly providerOperationId: string;
  readonly responseExecutionId: ConversationResponseExecutionId;
  readonly invocationAttemptId: ProviderInvocationAttemptId;
  readonly productFeature: 'text_chat' | 'text_reasoning';
  readonly session: DeepSeekEventStreamSession;
  readonly removeExternalAbort: () => void;
  cancelReason?: 'user' | 'application_shutdown';
  completion?: Promise<DeepSeekChatTerminalResult>;
}

export class DeepSeekManagementAdapter implements ProviderManagementAdapterPort {
  readonly identity = {
    packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    adapterId: DEEPSEEK_CHAT_ADAPTER_ID,
    adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
    protocolId: DEEPSEEK_CHAT_PROTOCOL_ID,
    protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION
  } as const;

  constructor(
    private readonly runtime: DeepSeekSharedRuntime,
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

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
      const code = runtimeSafeCode(error);
      return {
        state: 'unavailable',
        identityState: 'verification_failed',
        credentialState:
          error instanceof DeepSeekRuntimeError &&
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

export class DeepSeekChatAdapter {
  private readonly active = new Map<string, ActiveOperation>();
  private disposed = false;

  constructor(
    private readonly runtime: DeepSeekSharedRuntime,
    private readonly credentials: DeepSeekCredentialResolverPort,
    private readonly lifecycle: DeepSeekConversationLifecyclePort,
    private readonly usage: DeepSeekUsageObservationSinkPort,
    private readonly ids: DeepSeekChatAdapterIdFactory = {
      nextProviderOperationId: () => `deepseek-chat-${randomUUID()}`,
      nextProviderUsageObservationId: () =>
        `deepseek-usage-${randomUUID()}` as ProviderUsageObservationId
    },
    private readonly terminalObserver: DeepSeekChatTerminalObserverPort = {},
    private readonly now: () => IsoTimestamp = () =>
      toIsoTimestamp(new Date().toISOString())
  ) {}

  async submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted?: () => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<DeepSeekChatOperationHandle> {
    if (this.disposed) {
      throw new DeepSeekRuntimeError('runtime_shutting_down', 'not_retryable');
    }
    const route = validateRoute(input.routeSnapshot);
    const request = parseDispatchRequest(input.request);
    const body = serializeRequest(route, request);
    const providerOperationId = requireOpaqueId(
      this.ids.nextProviderOperationId(),
      'provider operation ID'
    );
    if (this.active.has(providerOperationId)) {
      throw new DeepSeekChatAdapterError(
        'deepseek.operation_id_conflict',
        'DeepSeek operation IDs must be unique'
      );
    }
    const externalController = new AbortController();
    const removeExternalAbort = linkAbort(input.signal, externalController);
    let session: DeepSeekEventStreamSession | undefined;
    try {
      session = await this.credentials.useCredential(
        {
          connectionId: route.connectionId,
          credentialVersionId: route.credentialVersionId
        },
        (credential) => this.runtime.openChatStream({
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
      throw new DeepSeekChatAdapterError(
        'deepseek.operation_failed',
        'DeepSeek did not create a stream session'
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
      try {
        await this.lifecycle.requestCancel(operation.responseExecutionId);
      } finally {
        operation.session.cancel();
      }
    }
    await operation.completion;
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
  ): Promise<DeepSeekChatTerminalResult> {
    let usagePersisted = false;
    try {
      const stream = await consumeDeepSeekStream(
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
      await this.usage.append(observation, deepSeekUsageSchema);
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
    const invalid = error instanceof DeepSeekChatAdapterError;
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
    }), deepSeekUsageSchema);
  }
}

export function mapDeepSeekUsage(value: unknown): readonly UsageFactV1[] {
  if (!isRecord(value)) {
    throw invalidStream('DeepSeek usage must be an object');
  }
  // Validate known metrics; ignore forward-compatible unknown usage keys so a
  // successful answer is not failed solely by an extended usage envelope.
  for (const key of ['completion_tokens', 'prompt_tokens', 'total_tokens'] as const) {
    if (!(key in value)) {
      throw invalidStream('DeepSeek usage contains unsupported fields');
    }
  }
  const completionTokens = nonNegativeInteger(
    value.completion_tokens,
    'completion_tokens'
  );
  const promptTokens = nonNegativeInteger(value.prompt_tokens, 'prompt_tokens');
  const totalTokens = nonNegativeInteger(value.total_tokens, 'total_tokens');
  if (totalTokens !== promptTokens + completionTokens) {
    throw invalidStream('DeepSeek total token usage is inconsistent');
  }
  const facts: UsageFactV1[] = [
    tokenFact('completion_tokens', completionTokens),
    tokenFact('prompt_tokens', promptTokens),
    tokenFact('total_tokens', totalTokens)
  ];
  const cacheHit = optionalNonNegativeInteger(
    value.prompt_cache_hit_tokens,
    'prompt_cache_hit_tokens'
  );
  const cacheMiss = optionalNonNegativeInteger(
    value.prompt_cache_miss_tokens,
    'prompt_cache_miss_tokens'
  );
  if (cacheHit !== undefined) facts.push(tokenFact('prompt_cache_hit_tokens', cacheHit));
  if (cacheMiss !== undefined) facts.push(tokenFact('prompt_cache_miss_tokens', cacheMiss));
  if (
    cacheHit !== undefined &&
    cacheMiss !== undefined &&
    promptTokens !== cacheHit + cacheMiss
  ) {
    throw invalidStream('DeepSeek prompt cache token usage is inconsistent');
  }
  if (value.completion_tokens_details !== undefined) {
    if (!isRecord(value.completion_tokens_details)) {
      throw invalidStream('DeepSeek completion token details must be an object');
    }
    const reasoningTokens = optionalNonNegativeInteger(
      value.completion_tokens_details.reasoning_tokens,
      'reasoning_tokens'
    );
    if (reasoningTokens !== undefined) {
      if (reasoningTokens > completionTokens) {
        throw invalidStream('DeepSeek reasoning token usage is inconsistent');
      }
      facts.push(tokenFact('reasoning_tokens', reasoningTokens));
    }
  }
  return facts;
}

export function deepSeekChatRecoveryDecision(
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

async function consumeDeepSeekStream(
  stream: AsyncIterable<Uint8Array>,
  expectedModel: string,
  onContent: (delta: string) => Promise<void>,
  onReasoning: (delta: string) => Promise<void>
): Promise<{
  readonly finishReason: DeepSeekFinishReason;
  readonly contentLength: number;
  readonly usage?: readonly UsageFactV1[];
}> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let done = false;
  let terminalReason: DeepSeekFinishReason | undefined;
  let usage: readonly UsageFactV1[] | undefined;
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let contentLength = 0;

  const processEvent = async (eventText: string) => {
    // Ignore blank events and SSE comment/keep-alive lines (": ...").
    const dataLines = eventText
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith(':'));
    if (dataLines.length === 0) return;
    if (done) throw invalidStream('DeepSeek streamed data after the terminal marker');
    const data = parseDataOnlyEvent(dataLines.join('\n'));
    if (data === '[DONE]') {
      if (!terminalReason) {
        throw invalidStream('DeepSeek stream ended before a finish reason');
      }
      done = true;
      return;
    }
    const chunk = parseStreamChunk(data);
    responseId ??= chunk.id;
    responseModel ??= chunk.model;
    if (chunk.id !== responseId || chunk.model !== responseModel || chunk.model !== expectedModel) {
      throw invalidStream('DeepSeek stream identity changed');
    }
    if (chunk.usage) {
      if (usage) throw invalidStream('DeepSeek stream reported usage more than once');
      usage = chunk.usage;
    }
    if (chunk.reasoningDelta) {
      await onReasoning(chunk.reasoningDelta);
    }
    if (chunk.contentDelta) {
      contentLength += chunk.contentDelta.length;
      if (contentLength > 1_000_000) {
        throw invalidStream('DeepSeek stream content exceeded the local limit');
      }
      await onContent(chunk.contentDelta);
    }
    if (chunk.finishReason) {
      if (terminalReason) throw invalidStream('DeepSeek stream reported multiple finish reasons');
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
    if (error instanceof DeepSeekRuntimeError) throw error;
    if (error instanceof DeepSeekChatAdapterError) throw error;
    throw invalidStream('DeepSeek stream encoding is invalid');
  }
  if (buffer.trim().length > 0) await processEvent(buffer);
  if (!done || !terminalReason) {
    throw invalidStream('DeepSeek stream ended without a terminal marker');
  }
  if (terminalReason === 'stop' && contentLength === 0) {
    throw invalidStream('DeepSeek completed with empty content');
  }
  return {
    finishReason: terminalReason,
    contentLength,
    ...(usage ? { usage } : {})
  };
}

type DeepSeekFinishReason =
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
  readonly finishReason?: DeepSeekFinishReason;
  readonly usage?: readonly UsageFactV1[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw invalidStream('DeepSeek SSE data is not valid JSON');
  }
  const item = exactRecord(
    parsed,
    ['id', 'choices', 'created', 'model', 'object'],
    ['system_fingerprint', 'usage'],
    'DeepSeek stream chunk'
  );
  const id = safeString(item.id, 'DeepSeek response ID', 512);
  const model = safeString(item.model, 'DeepSeek response model', 256);
  if (
    item.object !== 'chat.completion.chunk' ||
    !Number.isSafeInteger(item.created) ||
    Number(item.created) < 0 ||
    !Array.isArray(item.choices)
  ) {
    throw invalidStream('DeepSeek stream chunk metadata is invalid');
  }
  const usage = item.usage === undefined || item.usage === null
    ? undefined
    : mapDeepSeekUsage(item.usage);
  if (item.choices.length === 0) {
    if (!usage) throw invalidStream('DeepSeek empty choices require final usage');
    return { id, model, usage };
  }
  if (item.choices.length !== 1) {
    throw invalidStream('DeepSeek stream choices are ambiguous');
  }
  const choice = exactRecord(
    item.choices[0],
    ['delta', 'finish_reason', 'index'],
    ['logprobs'],
    'DeepSeek stream choice'
  );
  if (
    choice.index !== 0 ||
    (choice.logprobs !== undefined && choice.logprobs !== null)
  ) {
    throw invalidStream('DeepSeek stream choice is unsupported');
  }
  const delta = exactRecord(
    choice.delta,
    [],
    ['role', 'content', 'reasoning_content'],
    'DeepSeek stream delta'
  );
  if (delta.role !== undefined && delta.role !== 'assistant') {
    throw invalidStream('DeepSeek stream role is invalid');
  }
  // Official message/delta content fields are nullable; treat null as absent.
  const contentDelta = optionalDeltaText(delta.content, 'DeepSeek content delta');
  const reasoningDelta = optionalDeltaText(
    delta.reasoning_content,
    'DeepSeek reasoning delta'
  );
  const finishReason = choice.finish_reason === null
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
    throw invalidStream('DeepSeek model catalog is invalid');
  }
  const item = exactRecord(value, ['object', 'data'], [], 'DeepSeek model catalog');
  if (item.object !== 'list' || !Array.isArray(item.data) || item.data.length > 1000) {
    throw invalidStream('DeepSeek model catalog metadata is invalid');
  }
  const entries = item.data.map((value) => {
    const model = exactRecord(
      value,
      ['id', 'object', 'owned_by'],
      [],
      'DeepSeek model catalog entry'
    );
    const id = safeString(model.id, 'DeepSeek model ID', 256);
    if (model.object !== 'model') {
      throw invalidStream('DeepSeek model catalog entry type is invalid');
    }
    safeString(model.owned_by, 'DeepSeek model owner', 160);
    return { providerModelKey: id, displayName: id };
  });
  if (new Set(entries.map((entry) => entry.providerModelKey)).size !== entries.length) {
    throw invalidStream('DeepSeek model catalog contains duplicate IDs');
  }
  return entries;
}

function validateRoute(value: unknown) {
  const route = parseProviderExecutionRouteSnapshot(value);
  const parameterSchemaId = route.productFeature === 'text_chat'
    ? DEEPSEEK_CHAT_PARAMETER_SCHEMA_ID
    : DEEPSEEK_REASONING_PARAMETER_SCHEMA_ID;
  if (
    route.packageId !== DEEPSEEK_PROVIDER_PACKAGE_ID ||
    route.packageVersion !== DEEPSEEK_PROVIDER_PACKAGE_VERSION ||
    route.adapterKey !== DEEPSEEK_CHAT_ADAPTER_ID ||
    route.adapterVersion !== DEEPSEEK_CHAT_ADAPTER_VERSION ||
    route.endpointPolicyId !== DEEPSEEK_ENDPOINT_POLICY_ID ||
    route.endpointPolicyRevision !== 1 ||
    (route.productFeature !== 'text_chat' && route.productFeature !== 'text_reasoning') ||
    route.internalPurpose !== 'text_execution' ||
    route.parameterSchemaId !== parameterSchemaId ||
    route.parameterSchemaRevision !== 1 ||
    route.resultSchemaId !== DEEPSEEK_RESULT_SCHEMA_ID ||
    route.resultSchemaRevision !== 1 ||
    route.usageSchemaId !== DEEPSEEK_USAGE_SCHEMA_ID ||
    route.usageSchemaRevision !== 1 ||
    route.constraintSetId !== DEEPSEEK_CONSTRAINT_SET_ID ||
    route.constraintSetRevision !== 1 ||
    !isDeepSeekModelKey(route.providerModelKey)
  ) {
    throw new DeepSeekChatAdapterError(
      'deepseek.route_mismatch',
      'The DeepSeek route snapshot is not supported by this adapter'
    );
  }
  return route;
}

function parseDispatchRequest(value: unknown): DeepSeekChatDispatchRequestV1 {
  const item = exactRecord(
    value,
    ['responseExecutionId', 'invocationAttemptId', 'messages', 'parameterValues'],
    [],
    'DeepSeek chat dispatch request'
  );
  if (!Array.isArray(item.messages) || item.messages.length < 1 || item.messages.length > 200) {
    throw invalidRequest('DeepSeek messages are invalid');
  }
  const messages = item.messages.map((value) => {
    const message = exactRecord(value, ['role', 'content'], [], 'DeepSeek message');
    if (!['system', 'user', 'assistant'].includes(String(message.role))) {
      throw invalidRequest('DeepSeek message role is invalid');
    }
    return {
      role: message.role as DeepSeekChatMessageV1['role'],
      content: boundedText(message.content, 'DeepSeek message content', 1_000_000)
    };
  });
  if (messages.at(-1)?.role !== 'user') {
    throw invalidRequest('DeepSeek messages must end with the current user message');
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
    parameterValues: plainRecord(item.parameterValues, 'DeepSeek parameter values') as Readonly<
      Record<string, ParameterValue>
    >
  };
}

function serializeRequest(
  route: ReturnType<typeof validateRoute>,
  request: DeepSeekChatDispatchRequestV1
): Uint8Array {
  const schema = route.productFeature === 'text_chat'
    ? deepSeekChatParameterSchema
    : deepSeekReasoningParameterSchema;
  const parameters = validateParameterValues(schema, 'full', request.parameterValues);
  if ('temperature' in parameters && 'top_p' in parameters) {
    throw invalidRequest('DeepSeek temperature and top_p cannot both be set');
  }
  const body: Record<string, unknown> = {
    model: route.providerModelKey,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: {
      type: route.productFeature === 'text_reasoning' ? 'enabled' : 'disabled'
    },
    ...parameters
  };
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  if (encoded.byteLength > 2 * 1024 * 1024) {
    throw invalidRequest('DeepSeek request exceeded the local size limit');
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
    usageSchemaId: deepSeekUsageSchema.id,
    usageSchemaRevision: deepSeekUsageSchema.revision,
    sourceEventKey: `deepseek_usage_${input.providerOperationId}`,
    sequence: 1,
    status: input.status,
    sourceStage: 'result',
    facts: input.facts,
    observedAt: input.observedAt
  }, deepSeekUsageSchema);
}

function parseDataOnlyEvent(eventText: string): string {
  const lines = eventText.split('\n');
  if (lines.some((line) => !line.startsWith('data:'))) {
    throw invalidStream('DeepSeek SSE contains unsupported fields');
  }
  const data = lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  if (data.length < 1 || data.length > 1_000_000) {
    throw invalidStream('DeepSeek SSE data field is invalid');
  }
  return data;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseFinishReason(value: unknown): DeepSeekFinishReason {
  if (
    !['stop', 'length', 'content_filter', 'tool_calls', 'insufficient_system_resource']
      .includes(String(value))
  ) {
    throw invalidStream('DeepSeek finish reason is invalid');
  }
  return value as DeepSeekFinishReason;
}

function finishReasonSafeCode(reason: Exclude<DeepSeekFinishReason, 'stop'>): string {
  return `deepseek.finish.${reason}`;
}

function safeCodeForError(error: unknown): string {
  if (error instanceof DeepSeekChatAdapterError) return error.safeCode;
  return runtimeSafeCode(error);
}

function runtimeSafeCode(error: unknown): string {
  return error instanceof DeepSeekRuntimeError
    ? `deepseek.${error.code}`
    : 'deepseek.operation_failed';
}

class DeepSeekChatAdapterError extends Error {
  constructor(readonly safeCode: string, message: string) {
    super(message);
    this.name = 'DeepSeekChatAdapterError';
  }
}

function invalidStream(message: string): DeepSeekChatAdapterError {
  return new DeepSeekChatAdapterError('deepseek.invalid_response', message);
}

function invalidRequest(message: string): DeepSeekChatAdapterError {
  return new DeepSeekChatAdapterError('deepseek.invalid_request', message);
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
    throw invalidStream(`DeepSeek ${label} is invalid`);
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
