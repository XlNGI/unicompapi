import { randomUUID } from 'node:crypto';
import {
  appendAssistantMessageChunk,
  completeAssistantMessage,
  failAssistantMessage,
  toIsoTimestamp,
  toProviderExecutionRouteSnapshotId,
  toProviderInvocationAttemptId,
  toProviderInvocationEventId,
  toSubmissionIntentId,
  type MessageFailureReason,
  type ParameterSchemaV2,
  type Conversation,
  type ConversationResponseExecutionId,
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
  type DeepSeekSharedRuntime,
  type DeepSeekUsageObservationSinkPort
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
  type NewApiParameterSchemaResolverPort,
  type NewApiSharedRuntime,
  type NewApiUsageObservationSinkPort
} from './newapi';
import { UNICOMPAPI_PROVIDER_PACKAGE_ID, UNICOMPAPI_PROVIDER_PACKAGE_VERSION } from './newapi/unicompapi-contracts';
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
import { ConversationRevisionConflictError } from '../repositories/json-conversation-repository';

const noopUsage: DeepSeekUsageObservationSinkPort & NewApiUsageObservationSinkPort = {
  async append() {
    return;
  }
};

export interface ConversationTextSubmissionRuntimes {
  readonly deepSeekRuntime: DeepSeekSharedRuntime;
  readonly newApiRuntime: NewApiSharedRuntime;
  readonly credentialVault: SecureCredentialVault;
  readonly providerRegistry: JsonProviderRegistryStore;
  readonly providerPackages: ProviderPackageRegistry;
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
    noopUsage
  );
  const newApiAdapter = new NewApiChatAdapter(
    options.newApiRuntime,
    credentials,
    connections,
    parameterSchemas,
    linkedLifecycle,
    noopUsage
  );
  return new ProviderSubmissionDispatchBridge(options.providerPackages, [
    wrapChatAdapter({
      packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
      packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION,
      adapterKey: DEEPSEEK_CHAT_ADAPTER_ID,
      adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
      protocolId: DEEPSEEK_CHAT_PROTOCOL_ID,
      protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION,
      submit: (input) => deepSeekAdapter.submit(input)
    }),
    wrapChatAdapter({
      packageId: NEWAPI_PROVIDER_PACKAGE_ID,
      packageVersion: NEWAPI_PROVIDER_PACKAGE_VERSION,
      acceptedPackages: [{
        packageId: UNICOMPAPI_PROVIDER_PACKAGE_ID,
        packageVersion: UNICOMPAPI_PROVIDER_PACKAGE_VERSION
      }],
      adapterKey: NEWAPI_CHAT_ADAPTER_ID,
      adapterVersion: NEWAPI_ADAPTER_VERSION,
      protocolId: NEWAPI_CHAT_PROTOCOL_ID,
      protocolVersion: NEWAPI_PROTOCOL_VERSION,
      submit: (input) => newApiAdapter.submit(input)
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
  submit(input: {
    readonly routeSnapshot: unknown;
    readonly request: unknown;
    readonly beforeRequestStarted: () => Promise<void>;
  }): Promise<{ readonly providerOperationId: string }>;
}): ProviderSubmissionAdapterPort {
  return {
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    ...(input.acceptedPackages ? { acceptedPackages: input.acceptedPackages } : {}),
    adapterKey: input.adapterKey,
    adapterVersion: input.adapterVersion,
    protocolId: input.protocolId,
    protocolVersion: input.protocolVersion,
    async submit(request): Promise<SubmissionDispatchOutcome> {
      try {
        const handle = await input.submit({
          routeSnapshot: request.routeSnapshot,
          request: request.request,
          beforeRequestStarted: request.beforeRequestStarted
        });
        return {
          kind: 'accepted_async',
          providerOperationId: handle.providerOperationId
        };
      } catch (error) {
        return {
          kind: 'failed_before_submission',
          safeCode: dispatchFailureSafeCode(input.adapterKey, error)
        };
      }
    }
  };
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

function createRegistryCredentialResolver(
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

function createRegistryConnectionResolver(
  registry: JsonProviderRegistryStore
): NewApiConnectionResolverPort {
  return {
    async get(connectionId: string): Promise<ProviderConnection | undefined> {
      const snapshot = await registry.load();
      return snapshot.connections.find((item) => item.id === connectionId);
    }
  };
}

function createTextParameterSchemaResolver(): NewApiParameterSchemaResolverPort {
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

function createConversationLinkedLifecycle(
  lifecycle: ConversationResponseExecutionLifecycle,
  conversations: ProjectConversationRepository,
  now: () => string
): DeepSeekConversationLifecyclePort & NewApiConversationLifecyclePort {
  const projectionFlushDelayMs = 120;
  const queues = new Map<string, Promise<void>>();
  const projections = new Map<string, {
    pendingContent: string;
    timer?: ReturnType<typeof setTimeout>;
    tail: Promise<void>;
  }>();

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
    operation: (conversation: Conversation, assistantMessageId: Conversation['messages'][number]['id']) => Conversation
  ): Promise<void> {
    const state = projectionState(executionId);
    const next = state.tail.catch(() => undefined).then(async () => {
      const model = await lifecycle.readModel(executionId);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const conversation = await conversations.get(model.conversationId);
        if (!conversation) return;
        const updated = operation(conversation, model.assistantMessageId);
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

  function releaseProjection(executionId: ConversationResponseExecutionId): void {
    const state = projections.get(executionId);
    if (state?.timer) clearTimeout(state.timer);
    projections.delete(executionId);
  }

  return {
    start: (executionId) => enqueue(executionId, () => lifecycle.start(executionId)),
    appendContent: (executionId, contentDelta) => enqueue(executionId, async () => {
      await lifecycle.appendContent(executionId, contentDelta);
      projectionState(executionId).pendingContent += contentDelta;
      scheduleFlush(executionId);
    }),
    complete: (executionId) => enqueue(executionId, async () => {
      await flushPending(executionId);
      await lifecycle.complete(executionId);
      await queueProjection(executionId, (conversation, assistantMessageId) => completeAssistantMessage(
        conversation,
        assistantMessageId,
        toIsoTimestamp(now())
      ));
      releaseProjection(executionId);
    }),
    requestCancel: (executionId) => enqueue(executionId, async () => {
      await flushPending(executionId);
      await lifecycle.requestCancel(executionId);
    }),
    confirmCancelled: (executionId) => enqueue(executionId, async () => {
      await flushPending(executionId);
      await lifecycle.confirmCancelled(executionId);
      releaseProjection(executionId);
    }),
    fail: (executionId, safeCode) => enqueue(executionId, async () => {
      await flushPending(executionId);
      await lifecycle.fail(executionId, safeCode);
      await queueProjection(executionId, (conversation, assistantMessageId) => failAssistantMessage(
        conversation,
        assistantMessageId,
        failureReasonFromSafeCode(safeCode),
        toIsoTimestamp(now())
      ));
      releaseProjection(executionId);
    }),
    interrupt: (executionId, reason) => enqueue(executionId, async () => {
      await flushPending(executionId);
      await lifecycle.interrupt(executionId, reason);
      releaseProjection(executionId);
    })
  };
}

function failureReasonFromSafeCode(safeCode: string): MessageFailureReason {
  if (safeCode.includes('finish.length')) {
    return 'truncated';
  }
  if (safeCode.includes('invalid_response') || safeCode.includes('invalid_request')) {
    return 'invalid_response';
  }
  if (safeCode.includes('interrupted') || safeCode.includes('application_shutdown')) {
    return 'interrupted';
  }
  return 'unavailable';
}
