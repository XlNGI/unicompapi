import type { ConversationNativeSearch } from './conversation-native-search';
import { randomUUID } from 'node:crypto';
import {
  appendAssistantMessageChunk,
  cancelAssistantMessage,
  completeAssistantMessage,
  failAssistantMessage,
  startAssistantMessageStreaming,
  toIsoTimestamp,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toSubmissionIntentId,
  type MessageFailureReason,
  type ParameterSchemaV2,
  type Conversation,
  type ConversationResponseExecutionId,
  type ProviderUsageObservationRepository,
  type ProjectConversationRepository,
  type ProviderConnection,
  type StructuredCredentialRecord
} from '../../domain';
import type { SecureCredentialVault } from './credential-vault';
import {
  DEEPSEEK_CHAT_ADAPTER_ID,
  DEEPSEEK_CHAT_ADAPTER_VERSION,
  DEEPSEEK_CHAT_PROTOCOL_ID,
  DEEPSEEK_CHAT_PROTOCOL_VERSION,
  DEEPSEEK_PROVIDER_PACKAGE_ID,
  DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DeepSeekChatAdapter,
  type DeepSeekConversationLifecyclePort,
  type DeepSeekCredentialResolverPort,
  type DeepSeekChatTerminalObserverPort,
  type DeepSeekSharedRuntime,
} from './deepseek';
import {
  NEWAPI_ADAPTER_VERSION,
  NEWAPI_CHAT_ADAPTER_ID,
  NEWAPI_CHAT_PROTOCOL_ID,
  NEWAPI_PROTOCOL_VERSION,
  NEWAPI_PROVIDER_PACKAGE_ID,
  NEWAPI_PROVIDER_PACKAGE_VERSION,
  NewApiChatAdapter,
  type NewApiConnectionResolverPort,
  type NewApiConversationLifecyclePort,
  type NewApiCredentialResolverPort,
  type NewApiChatTerminalObserverPort,
  type NewApiParameterSchemaResolverPort,
  type NewApiSharedRuntime,
} from './newapi';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID, UNICOMPAPI_PROVIDER_PACKAGE_VERSION } from './newapi/unicompapi-contracts';
import { KIMI_PROVIDER_PACKAGE_ID, KIMI_PROVIDER_PACKAGE_VERSION } from './kimi/kimi-contracts';
import { createTextProviderFeatureContracts } from './project-text-feature';
import type { JsonProviderRegistryStore } from './provider-registry';
import type { ProviderPackageRegistry } from './provider-package-registry';
import {
  ProviderSubmissionDispatchBridge,
  type ProviderSubmissionAdapterPort
} from './provider-submission-dispatch-bridge';
import type {
  ProviderSubmissionOrchestrationIdFactory,
  SubmissionDispatchOutcome
} from './provider-submission-orchestrator';
import type { ConversationResponseExecutionLifecycle } from './conversation-response-streaming';
import type { ConversationExecutionCoordinator } from './conversation-execution-coordinator';
import {
  ConversationStreamDeltaBatcher,
  type ConversationStreamDeltaSegment
} from './conversation-stream-delta-batcher';
import { ConversationRevisionConflictError } from '../repositories/json-conversation-repository';
import type { ControlledProviderToolBridge, ControlledProviderToolDefinition, ProviderExecutionLifecyclePort } from './provider-tool-calling';
import type { ExecutionStopReason, HostExecutionBudget } from '../../application/execution-budget';
import { bindProductionTraceAssistant, emitProductionEvent, getProductionTraceScope,
  withProductionTrace, type ProductionTraceScope } from '../conversation-production-trace';

export interface ConversationTextSubmissionRuntimes {
  readonly nativeSearch?: ConversationNativeSearch;
  readonly deepSeekRuntime: DeepSeekSharedRuntime;
  readonly newApiRuntime: NewApiSharedRuntime;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
  readonly usage: ProviderUsageObservationRepository;
  readonly terminalObserver?: DeepSeekChatTerminalObserverPort & NewApiChatTerminalObserverPort;
  readonly toolCalling?: {
    readonly bridge: ControlledProviderToolBridge;
    readonly tools: readonly ControlledProviderToolDefinition[];
    readonly maxRounds?: number;
  };
  readonly documentToolCalling?: {
    forExecution(input: { readonly responseExecutionId: string; readonly signal?: AbortSignal }): Promise<{
      readonly executionBudget?: HostExecutionBudget;
      readonly cancel?: () => Promise<void>;
      readonly prepareTools: (signal: AbortSignal) => Promise<readonly ControlledProviderToolDefinition[] | undefined>;
      readonly bridge: ControlledProviderToolBridge;
      readonly close: () => Promise<void>;
    } | undefined>;
  };
}

export function createConversationTextSubmissionIdFactory(): ProviderSubmissionOrchestrationIdFactory {
  return {
    nextSubmissionIntentId: () => toSubmissionIntentId(`intent-${randomUUID()}`),
    nextRouteSnapshotId: () =>
      toProviderExecutionRouteSnapshotId(`route-${randomUUID()}`),
    nextProviderInvocationAttemptId: () =>
      toProviderInvocationAttemptId(`attempt-${randomUUID()}`),
    nextProviderInvocationEventId: () =>
      toProviderInvocationEventId(`invocation-event-${randomUUID()}`),
    nextAuthorizationClaimId: () => `claim-${randomUUID()}`,
    nextJournalEventId: () => `journal-event-${randomUUID()}`
  };
}

export function createConversationTextDispatchBridge(
  options: ConversationTextSubmissionRuntimes & {
    readonly lifecycle: ConversationResponseExecutionLifecycle;
    readonly conversations: ProjectConversationRepository;
    readonly coordinator: ConversationExecutionCoordinator;
    readonly settleExecution?: (id: ConversationResponseExecutionId, unknownResult: boolean,
      counters?: { readonly toolCallsUsed: number; readonly costUnitsUsed: number }, reason?: ExecutionStopReason) => Promise<void>;
    readonly executionLifecycle?: (id: ConversationResponseExecutionId) => Promise<ProviderExecutionLifecyclePort | undefined>;
    readonly executionSignal?: (id: ConversationResponseExecutionId) => Promise<AbortSignal | undefined>;
    now?: () => string;
  }
): ProviderSubmissionDispatchBridge {
  const now = options.now ?? (() => new Date().toISOString());
  const credentials = createRegistryCredentialResolver(
    options.providerRegistry,
    options.credentialVault
  );
  const connections = createRegistryConnectionResolver(options.providerRegistry);
  const parameterSchemas = createTextParameterSchemaResolver();
  const linkedLifecycle = createConversationLinkedLifecycle(
    options.lifecycle,
    options.conversations,
    now
  );
  const deepSeekAdapter = new DeepSeekChatAdapter(
    options.deepSeekRuntime,
    credentials,
    linkedLifecycle,
    options.usage,
    undefined,
    options.terminalObserver
  );
  const newApiAdapter = new NewApiChatAdapter(
    options.newApiRuntime,
    credentials,
    connections,
    parameterSchemas,
    linkedLifecycle,
    options.usage,
    undefined,
    options.terminalObserver
  );
  return new ProviderSubmissionDispatchBridge(options.providerPackages, [
    wrapChatAdapter({
      packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
      packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
      adapterKey: DEEPSEEK_CHAT_ADAPTER_ID,
      adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
      protocolId: DEEPSEEK_CHAT_PROTOCOL_ID,
      protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION,
      submit: (input) => deepSeekAdapter.submit(input),
      toolCalling: options.toolCalling,
      documentToolCalling: options.documentToolCalling,
      settleExecution: options.settleExecution,
      executionLifecycle: options.executionLifecycle,
      executionSignal: options.executionSignal,
      cancel: (providerOperationId) => deepSeekAdapter.cancel(providerOperationId),
      coordinator: options.coordinator,
      onCancellationTimeout: async (responseExecutionId) => {
        await linkedLifecycle.interrupt(responseExecutionId, 'transport_interrupted');
      }
    }),
    wrapChatAdapter({
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
      acceptedPackages: [{
        packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
        packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION
      }, {
        packageId: KIMI_PROVIDER_PACKAGE_ID,
        packageVersion: KIMI_PROVIDER_PACKAGE_VERSION
      }],
      adapterKey: NEWAPI_CHAT_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      protocolVersion: NEWAPI_PROTOCOL_VERSION,
      submit: (input) => newApiAdapter.submit({ ...input,
        nativeSearchGuard: options.nativeSearch?.validate.bind(options.nativeSearch),
        observeSearch: options.nativeSearch?.observe.bind(options.nativeSearch),
        searchRequestStarted: options.nativeSearch?.requestStarted.bind(options.nativeSearch)
      }),
      toolCalling: options.toolCalling,
      documentToolCalling: options.documentToolCalling,
      settleExecution: options.settleExecution,
      executionLifecycle: options.executionLifecycle,
      executionSignal: options.executionSignal,
      cancel: (providerOperationId) => newApiAdapter.cancel(providerOperationId),
      coordinator: options.coordinator,
      onCancellationTimeout: async (responseExecutionId) => {
        await linkedLifecycle.interrupt(responseExecutionId, 'transport_interrupted');
      }
    })
  ]);
}

function wrapChatAdapter(input: {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly acceptedPackages?: ProviderSubmissionAdapterPort['acceptedPackages'];
  readonly adapterKey: string;
  readonly adapterVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: string;
  readonly toolCalling?: ConversationTextSubmissionRuntimes['toolCalling'];
  readonly documentToolCalling?: ConversationTextSubmissionRuntimes['documentToolCalling'];
  submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted: () => Promise<void>;
    readonly toolBridge?: ControlledProviderToolBridge;
    readonly prepareTools?: (signal: AbortSignal) => Promise<readonly ControlledProviderToolDefinition[] | undefined>;
    readonly maxToolRounds?: number;
    readonly signal?: AbortSignal;
    readonly executionBudget?: HostExecutionBudget;
    readonly executionLifecycle?: ProviderExecutionLifecyclePort;
  }): Promise<{ readonly providerOperationId: string; readonly completion: Promise<unknown> }>;
  cancel(providerOperationId: string): Promise<boolean>;
  readonly coordinator: ConversationExecutionCoordinator;
  readonly settleExecution?: (id: ConversationResponseExecutionId, unknownResult: boolean,
    counters?: { readonly toolCallsUsed: number; readonly costUnitsUsed: number }, reason?: ExecutionStopReason) => Promise<void>;
  readonly executionLifecycle?: (id: ConversationResponseExecutionId) => Promise<ProviderExecutionLifecyclePort | undefined>;
  readonly executionSignal?: (id: ConversationResponseExecutionId) => Promise<AbortSignal | undefined>;
  onCancellationTimeout(
    responseExecutionId: ConversationResponseExecutionId
  ): Promise<void>;
}): ProviderSubmissionAdapterPort {
  return {
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    ...(input.acceptedPackages ? { acceptedPackages: input.acceptedPackages } : {}),
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    protocolId: input.protocolId,
    protocolVersion: input.protocolVersion,
    async submit(dispatchRequest): Promise<SubmissionDispatchOutcome> {
      let prepared: Awaited<ReturnType<NonNullable<ConversationTextSubmissionRuntimes['documentToolCalling']>['forExecution']>> | undefined;
      let closeStarted = false;
      let closing: Promise<boolean> | undefined;
      let starting: ReturnType<ConversationExecutionCoordinator['beginStarting']> | undefined;
      let removeStartingAbort: (() => void) | undefined;
      const closePrepared = (): Promise<boolean> => {
        if (closing) return closing;
        if (!prepared) return Promise.resolve(true);
        closeStarted = true;
        // Revoke synchronously, observe the real settlement, and bound its acknowledgement.
        // A timed-out close stays unknown; no tool or Provider is replayed.
        let pending: Promise<boolean>;
        try { pending = prepared.close().then(() => true, () => false); } catch { pending = Promise.resolve(false); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        closing = input.settleExecution ? Promise.race([pending, new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 5_000);
        })]).finally(() => clearTimeout(timer)) : pending;
        return closing;
      };
      try {
        const responseExecutionId = responseExecutionIdFromDispatchRequest(dispatchRequest.request);
        starting = input.coordinator.beginStarting(responseExecutionId, () => input.onCancellationTimeout(responseExecutionId));
        const leaseSignal = await awaitStarting(input.executionSignal?.(responseExecutionId) ?? Promise.resolve(undefined), starting.signal);
        const requestSignal = leaseSignal ? AbortSignal.any([starting.signal, leaseSignal]) : starting.signal;
        const abortPrepared = () => {
          prepared?.executionBudget?.cancel('cancelled');
          void prepared?.cancel?.().catch(() => undefined);
        };
        requestSignal.addEventListener('abort', abortPrepared, { once: true });
        removeStartingAbort = () => requestSignal.removeEventListener('abort', abortPrepared);
        const acceptsDocumentTools = isRecord(dispatchRequest.request) && !dispatchRequest.request.nativeSearch;
        if (acceptsDocumentTools && input.documentToolCalling) {
          const pending = input.documentToolCalling.forExecution({ responseExecutionId, signal: requestSignal });
          void pending.then(session => {
            if (requestSignal.aborted && session) {
              session.executionBudget?.cancel('cancelled');
              void session.cancel?.().catch(() => undefined);
              void session.close().catch(() => undefined);
            }
          }, () => undefined);
          prepared = await awaitStarting(pending, requestSignal);
        }
        const staticToolCalling = acceptsDocumentTools && !input.documentToolCalling ? input.toolCalling : undefined;
        const lifecycle = await awaitStarting(input.executionLifecycle?.(responseExecutionId) ?? Promise.resolve(undefined), requestSignal);
        // A configured factory owns this response's capabilities, including an empty result.
        const adapterRequest = acceptsDocumentTools && (input.documentToolCalling || staticToolCalling)
          ? { ...(dispatchRequest.request as Record<string, unknown>), tools: staticToolCalling?.tools }
          : dispatchRequest.request;
        prepared?.executionBudget?.assertCanProceed('model');
        const pendingHandle = input.submit({
          routeSnapshot: dispatchRequest.routeSnapshot,
          request: adapterRequest,
          beforeRequestStarted: async () => {
            if (requestSignal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' });
            prepared?.executionBudget?.assertCanProceed('model');
            await dispatchRequest.beforeRequestStarted();
            await emitProductionEvent({ code: 'model_request', status: 'started',
              operationId: responseExecutionIdFromDispatchRequest(adapterRequest), facts: { purpose: 'content' } });
          },
          signal: requestSignal,
          ...(lifecycle ? { executionLifecycle: lifecycle } : {}),
          ...(prepared?.executionBudget ? { executionBudget: prepared.executionBudget } : {}),
          ...(prepared ? { toolBridge: prepared.bridge, prepareTools: prepared.prepareTools }
            : staticToolCalling ? { toolBridge: staticToolCalling.bridge, maxToolRounds: staticToolCalling.maxRounds } : {})
        });
        void pendingHandle.then(handle => {
          if (requestSignal.aborted || prepared?.executionBudget?.signal.aborted) void input.cancel(handle.providerOperationId).catch(() => undefined);
        }, () => undefined);
        const handle = await awaitStarting(pendingHandle, requestSignal);
        const completion = input.settleExecution ? handle.completion.finally(async () => {
          const stopReason = prepared?.executionBudget?.stopReason;
          const counters = prepared?.executionBudget?.snapshot(stopReason ?? 'cancelled');
          const known = await closePrepared();
          await input.settleExecution!(responseExecutionId, !known, counters ?
            { toolCallsUsed: counters.toolCallsUsed, costUnitsUsed: counters.costUnitsUsed } : undefined, stopReason);
        }) : prepared ? handle.completion.finally(() => { void closePrepared(); }) : handle.completion;
        void completion.catch(() => undefined);
        try {
          input.coordinator.register({
            responseExecutionId,
            providerOperationId: handle.providerOperationId,
            cancel: () => {
              prepared?.executionBudget?.cancel('cancelled');
              void prepared?.cancel?.().catch(() => undefined);
              return input.cancel(handle.providerOperationId);
            },
            completion,
            onCancellationTimeout: () => input.onCancellationTimeout(responseExecutionId)
          });
        } catch (error) {
          await input.cancel(handle.providerOperationId).catch(() => undefined);
          throw error;
        }
        return {
          kind: 'accepted_async',
          providerOperationId: handle.providerOperationId
        };
      } catch (error) {
        if (input.settleExecution) await closePrepared();
        else void closePrepared();
        await emitProductionEvent({ code: 'model_request', status: starting?.signal.aborted ? 'cancelled' : 'failed', facts: { purpose: 'content' } });
        return {
          kind: 'failed_before_submission',
          safeCode: dispatchFailureSafeCode(input.adapterKey, error)
        };
      } finally {
        removeStartingAbort?.(); starting?.release();
        if (closeStarted) input.coordinator.releaseStartupSignal(responseExecutionIdFromDispatchRequest(dispatchRequest.request));
      }
    }
  };
}

async function awaitStarting<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, stopped]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

function responseExecutionIdFromDispatchRequest(value: unknown): ConversationResponseExecutionId {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Conversation dispatch request is invalid');
  }
  const responseExecutionId = (value as { responseExecutionId?: unknown }).responseExecutionId;
  if (typeof responseExecutionId !== 'string' || responseExecutionId.trim().length === 0) {
    throw new Error('Conversation dispatch request is missing its response execution ID');
  }
  return responseExecutionId as ConversationResponseExecutionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dispatchFailureSafeCode(adapterKey: string, error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'safeCode' in error &&
    typeof (error as { safeCode: unknown }).safeCode === 'string'
  ) {
    return (error as { safeCode: string }).safeCode;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return `${adapterKey}.${(error as { code: string }).code}`;
  }
  return `${adapterKey}.failed_before_submission`;
}

export function createRegistryCredentialResolver(
  registry: JsonProviderRegistryStore,
  vault: SecureCredentialVault
): DeepSeekCredentialResolverPort & NewApiCredentialResolverPort {
  return {
    async useCredential<T>(
      input: {
        readonly connectionId: string;
        readonly credentialVersionId: string;
      },
      operation: (credential: StructuredCredentialRecord) => Promise<T>
    ): Promise<T> {
      const snapshot = await registry.load();
      const connection = snapshot.connections.find(
        (item) => item.id === input.connectionId
      );
      if (
        !connection?.credentialReference ||
        connection.credentialVersionId !== input.credentialVersionId
      ) {
        throw new Error('Provider credential is unavailable for the selected route');
      }
      return vault.useRecord(connection.credentialReference, operation);
    }
  };
}

export function createRegistryConnectionResolver(
  registry: JsonProviderRegistryStore
): NewApiConnectionResolverPort {
  return {
    async get(connectionId: string): Promise<ProviderConnection | undefined> {
      const snapshot = await registry.load();
      return snapshot.connections.find((item) => item.id === connectionId);
    }
  };
}

export function createTextParameterSchemaResolver(): NewApiParameterSchemaResolverPort {
  const schemas = createTextProviderFeatureContracts().map(
    (contract) => contract.parameterSchema
  );
  return {
    async get(
      schemaId: string,
      revision: number
    ): Promise<ParameterSchemaV2 | undefined> {
      return schemas.find(
        (schema) => schema.schemaId === schemaId && schema.revision === revision
      );
    }
  };
}

export function createConversationLinkedLifecycle(
  lifecycle: ConversationResponseExecutionLifecycle,
  conversations: ProjectConversationRepository,
  now: () => string
): DeepSeekConversationLifecyclePort & NewApiConversationLifecyclePort {
  const projectionFlushDelayMs = 120;
  const queues = new Map<string, Promise<void>>();
  const deltaBatches = new Map<string, ConversationStreamDeltaBatcher>();
  const projections = new Map<string, {
    pendingContent: string;
    timer?: ReturnType<typeof setTimeout>;
    tail: Promise<void>;
  }>();
  const production = new Map<string, { scope?: ProductionTraceScope; characters: number; lastAt: number }>();
  async function traceResponse(executionId: ConversationResponseExecutionId,
    status: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled') {
    const state = production.get(executionId);
    const emit = () => emitProductionEvent({ code: 'model_response', status, operationId: executionId,
      facts: { purpose: 'content', contentCharacters: state?.characters ?? 0 } });
    if (state?.scope) await withProductionTrace(state.scope, emit);
    else await emit();
  }

  function enqueue<T>(executionId: ConversationResponseExecutionId, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(executionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const completion = current.then(() => undefined, () => undefined);
    queues.set(executionId, completion);
    void completion.finally(() => {
      if (queues.get(executionId) === completion) queues.delete(executionId);
    });
    return current;
  }

  function projectionState(executionId: ConversationResponseExecutionId) {
    const existing = projections.get(executionId);
    if (existing) return existing;
    const created: {
      pendingContent: string;
      timer?: ReturnType<typeof setTimeout>;
      tail: Promise<void>;
    } = { pendingContent: '', tail: Promise.resolve() };
    projections.set(executionId, created);
    return created;
  }

  function queueProjection(
    executionId: ConversationResponseExecutionId,
    operation: (
      conversation: Conversation,
      assistantMessageId: Conversation['messages'][number]['id'],
      reasoningContent: string
    ) => Conversation
  ): Promise<void> {
    const state = projectionState(executionId);
    const next = state.tail.catch(() => undefined).then(async () => {
      const model = await lifecycle.readModel(executionId);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const conversation = await conversations.get(model.conversationId);
        if (!conversation) return;
        const updated = operation(
          conversation,
          model.assistantMessageId,
          model.reasoningContent
        );
        try {
          await conversations.save(updated, conversation.revision);
          return;
        } catch (error) {
          if (!(error instanceof ConversationRevisionConflictError) || attempt === 3) {
            throw error;
          }
        }
      }
    });
    state.tail = next;
    return next;
  }

  async function flushPending(executionId: ConversationResponseExecutionId): Promise<void> {
    const state = projectionState(executionId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const content = state.pendingContent;
    state.pendingContent = '';
    if (content.length > 0) {
      try {
        await queueProjection(executionId, (conversation, assistantMessageId) =>
          appendAssistantMessageChunk(
            conversation,
            assistantMessageId,
            content,
            toIsoTimestamp(now())
          )
        );
      } catch (error) {
        state.pendingContent = `${content}${state.pendingContent}`;
        throw error;
      }
    }
    await state.tail;
    // New deltas may have arrived while the previous projection was saving.
    if (state.pendingContent.length > 0) await flushPending(executionId);
  }

  function scheduleFlush(executionId: ConversationResponseExecutionId): void {
    const state = projectionState(executionId);
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flushPending(executionId).catch(() => undefined);
    }, projectionFlushDelayMs);
  }

  function deltaBatch(
    executionId: ConversationResponseExecutionId
  ): ConversationStreamDeltaBatcher {
    const existing = deltaBatches.get(executionId);
    if (existing) return existing;
    const created = new ConversationStreamDeltaBatcher({
      persist: (segments) => enqueue(executionId, () =>
        persistDeltaSegments(executionId, segments)
      )
    });
    deltaBatches.set(executionId, created);
    return created;
  }

  async function persistDeltaSegments(
    executionId: ConversationResponseExecutionId,
    segments: readonly ConversationStreamDeltaSegment[]
  ): Promise<void> {
    await lifecycle.appendDeltas(executionId, segments);
    for (const segment of segments) {
      if (segment.kind === 'content') {
        const state = production.get(executionId);
        if (state) state.characters += segment.delta.length;
        projectionState(executionId).pendingContent += segment.delta;
        scheduleFlush(executionId);
      }
    }
    const state = production.get(executionId);
    if (state && state.characters > 0 && Date.now() - state.lastAt >= 1000) {
      state.lastAt = Date.now();
      await traceResponse(executionId, 'progress');
    }
  }

  async function sealAndDrainDeltas(
    executionId: ConversationResponseExecutionId
  ): Promise<void> {
    await deltaBatches.get(executionId)?.sealAndDrain();
  }

  function releaseProjection(executionId: ConversationResponseExecutionId): void {
    const state = projections.get(executionId);
    if (state?.timer) clearTimeout(state.timer);
    projections.delete(executionId);
    deltaBatches.delete(executionId);
  }

  return {
    start: (executionId) => enqueue(executionId, async () => {
      await lifecycle.start(executionId);
      const execution = await lifecycle.readModel(executionId);
      bindProductionTraceAssistant(execution.assistantMessageId);
      production.set(executionId, { scope: getProductionTraceScope(), characters: 0, lastAt: 0 });
      await emitProductionEvent({ code: 'model_request', status: 'completed', operationId: executionId,
        facts: { purpose: 'content' } });
      await traceResponse(executionId, 'started');
      await queueProjection(executionId, (conversation, assistantMessageId) =>
        startAssistantMessageStreaming(
          conversation,
          assistantMessageId,
          toIsoTimestamp(now())
        )
      );
    }),
    appendReasoning: (executionId, reasoningDelta) =>
      deltaBatch(executionId).append('reasoning', reasoningDelta),
    appendContent: (executionId, contentDelta) =>
      deltaBatch(executionId).append('content', contentDelta),
    complete: async (executionId) => {
      await sealAndDrainDeltas(executionId);
      await enqueue(executionId, async () => {
        await flushPending(executionId);
        await queueProjection(executionId, (conversation, assistantMessageId, reasoningContent) => completeAssistantMessage(
          conversation,
          assistantMessageId,
          toIsoTimestamp(now()),
          reasoningContent || undefined
        ));
        // Completion (including replay) must expose the saved conversation revision.
        await lifecycle.complete(executionId);
        await traceResponse(executionId, 'completed');
        production.delete(executionId);
        releaseProjection(executionId);
      });
    },
    requestCancel: async (executionId) => {
      await sealAndDrainDeltas(executionId);
      await enqueue(executionId, async () => {
        await flushPending(executionId);
        await lifecycle.requestCancel(executionId);
      });
    },
    confirmCancelled: async (executionId) => {
      await sealAndDrainDeltas(executionId);
      await enqueue(executionId, async () => {
        await flushPending(executionId);
        const event = await lifecycle.confirmCancelledDeferredPublish(executionId);
        await traceResponse(executionId, 'cancelled');
        production.delete(executionId);
        try {
          await queueProjection(executionId, (conversation, assistantMessageId, reasoningContent) => cancelAssistantMessage(
            conversation,
            assistantMessageId,
            toIsoTimestamp(now()),
            reasoningContent || undefined
          ));
        } finally {
          releaseProjection(executionId);
          await lifecycle.publish(event);
        }
      });
    },
    fail: async (executionId, safeCode) => {
      await sealAndDrainDeltas(executionId);
      await enqueue(executionId, async () => {
        await flushPending(executionId);
        const event = await lifecycle.failDeferredPublish(executionId, safeCode);
        await traceResponse(executionId, 'failed');
        production.delete(executionId);
        try {
          await queueProjection(executionId, (conversation, assistantMessageId, reasoningContent) => failAssistantMessage(
            conversation,
            assistantMessageId,
            failureReasonFromSafeCode(safeCode),
            toIsoTimestamp(now()),
            reasoningContent || undefined
          ));
        } finally {
          releaseProjection(executionId);
          await lifecycle.publish(event);
        }
      });
    },
    interrupt: async (executionId, reason) => {
      await sealAndDrainDeltas(executionId);
      await enqueue(executionId, async () => {
        await flushPending(executionId);
        await lifecycle.interrupt(executionId, reason);
        await traceResponse(executionId, 'failed');
        production.delete(executionId);
        releaseProjection(executionId);
      });
    }
  };
}

function failureReasonFromSafeCode(safeCode: string): MessageFailureReason {
  if (safeCode.includes('timeout')) {
    return 'unknown';
  }
  if (safeCode.includes('finish.length')) {
    return 'truncated';
  }
  if (safeCode.includes('upstream_rejected')) {
    return 'upstream_rejected';
  }
  if (safeCode.includes('model_not_found')) {
    return 'model_unavailable';
  }
  if (safeCode.includes('local_response_write_failed')) {
    return 'local_write_failed';
  }
  if (safeCode.includes('invalid_request') || safeCode.includes('invalid_parameters')) {
    return 'request_rejected';
  }
  if (safeCode.includes('authentication_failed') || safeCode.includes('permission_denied')) {
    return 'access_denied';
  }
  if (safeCode.includes('invalid_response')) {
    return 'invalid_response';
  }
  if (safeCode.includes('interrupted') || safeCode.includes('application_shutdown')) {
    return 'interrupted';
  }
  return 'unavailable';
}
