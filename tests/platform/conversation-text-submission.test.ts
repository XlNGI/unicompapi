import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProductionTraceStore, withProductionTrace } from '../../src/platform/conversation-production-trace';

const traceRoots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(traceRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
import {
  addUserMessage,
  beginAssistantMessage,
  createConversation,
  parseConversation,
  toConversationId,
  toConversationResponseExecutionId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  type Conversation,
  type ProjectConversationRepository
} from '../../src/domain';
import { createProviderExecutionRouteSnapshot, toProviderExecutionRouteSnapshotId, toProviderId, toConnectionId,
  toModelId, toProtocolBindingId, toUsageSchemaId } from '../../src/domain';
import { HostExecutionBudget } from '../../src/application/execution-budget';
import { ConversationExecutionCoordinator } from '../../src/platform/providers/conversation-execution-coordinator';
import { createConversationTextDispatchBridge, type ConversationTextSubmissionRuntimes } from '../../src/platform/providers/conversation-text-submission';
import { DeepSeekChatAdapter, DEEPSEEK_PROVIDER_PACKAGE_ID, DEEPSEEK_PROVIDER_PACKAGE_VERSION,
  DEEPSEEK_CHAT_ADAPTER_ID, DEEPSEEK_CHAT_ADAPTER_VERSION, DEEPSEEK_CHAT_PROTOCOL_ID,
  DEEPSEEK_CHAT_PROTOCOL_VERSION } from '../../src/platform/providers/deepseek';
import {
  createConversationLinkedLifecycle,
  type ConversationResponseExecutionLifecycle
} from '../../src/platform';

function startingDispatchFixture(forExecution: NonNullable<ConversationTextSubmissionRuntimes['documentToolCalling']>['forExecution'],
  settleExecution?: Parameters<typeof createConversationTextDispatchBridge>[0]['settleExecution']) {
  const coordinator = new ConversationExecutionCoordinator(25);
  const bridge = createConversationTextDispatchBridge({ coordinator, documentToolCalling: { forExecution },
    providerPackages: { resolveAdapter: () => undefined }, providerRegistry: {}, credentialVault: {},
    deepSeekRuntime: {}, newApiRuntime: {}, usage: {}, lifecycle: {}, conversations: {}, settleExecution
  } as unknown as Parameters<typeof createConversationTextDispatchBridge>[0]);
  const routeSnapshot = createProviderExecutionRouteSnapshot({ id: toProviderExecutionRouteSnapshotId('starting-route'),
    projectId: toProjectId('starting-project'), packageId: DEEPSEEK_PROVIDER_PACKAGE_ID,
    packageVersion: DEEPSEEK_PROVIDER_PACKAGE_VERSION, adapterKey: DEEPSEEK_CHAT_ADAPTER_ID, adapterVersion: DEEPSEEK_CHAT_ADAPTER_VERSION,
    providerId: toProviderId('starting-provider'), connectionId: toConnectionId('starting-connection'), connectionRevision: 1,
    connectionConfigVersionId: 'starting-config', endpointPolicyId: 'starting-endpoint', endpointPolicyRevision: 1,
    credentialVersionId: 'starting-credential-version', modelId: toModelId('starting-model'), providerModelKey: 'starting-model-key',
    modelRevision: 1, profileId: 'starting-profile', profileRevision: 1, protocolBindingId: toProtocolBindingId('starting-binding'),
    protocolBindingRevision: 1, productFeature: 'text_chat', internalPurpose: 'text_execution', featureMappingVersion: 1,
    parameterSchemaId: 'starting-parameters', parameterSchemaRevision: 1, resultSchemaId: 'starting-results', resultSchemaRevision: 1,
    usageSchemaId: toUsageSchemaId('starting-usage'), usageSchemaRevision: 1, constraintSetId: 'starting-constraints', constraintSetRevision: 1,
    runtimePolicyId: 'starting-policy', runtimePolicyRevision: 1, runtimeAuthorizationClaimId: 'starting-claim',
    createdAt: toIsoTimestamp('2026-10-03T00:00:00.000Z') });
  const responseExecutionId = toConversationResponseExecutionId('starting-execution');
  return { coordinator, responseExecutionId, run: () => bridge.submit({ routeSnapshot,
    request: { responseExecutionId, protocolId: DEEPSEEK_CHAT_PROTOCOL_ID, protocolVersion: DEEPSEEK_CHAT_PROTOCOL_VERSION },
    beforeRequestStarted: async () => undefined }) };
}

describe('conversation dispatch starting cancellation', () => {
  it.each(['timeout', 'cancelled'] as const)('retains the real %s reason across normal handle close and durable settlement', async reason => {
    const startedAt = Date.now();
    const budget = new HostExecutionBudget({ startedAt, deadlineAt: startedAt + 90_000, maxToolCalls: 8, budgetUnits: 8 });
    const settle = vi.fn(async () => undefined);
    const data = startingDispatchFixture(async () => ({ executionBudget: budget,
      close: async () => budget.dispose(), bridge: { execute: async () => ({ status: 'success' }) },
      prepareTools: async () => undefined }), settle);
    let finish!: () => void;
    vi.spyOn(DeepSeekChatAdapter.prototype, 'submit').mockResolvedValue({ providerOperationId: 'owned-stop-handle',
      completion: new Promise<void>(resolve => { finish = resolve; }) } as unknown as Awaited<ReturnType<DeepSeekChatAdapter['submit']>>);
    expect(await data.run()).toMatchObject({ kind: 'accepted_async' });
    budget.cancel(reason);
    finish();
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(data.responseExecutionId, false,
      { toolCallsUsed: 0, costUnitsUsed: 0 }, reason));
    expect(budget.signal.aborted).toBe(true);
  });
  it('returns promptly for Stop during a hanging session factory and revokes its late session', async () => {
    let finish!: (value: Awaited<ReturnType<NonNullable<ConversationTextSubmissionRuntimes['documentToolCalling']>['forExecution']>>) => void;
    const factory = vi.fn((_input: Parameters<NonNullable<ConversationTextSubmissionRuntimes['documentToolCalling']>['forExecution']>[0]) =>
      new Promise<Awaited<ReturnType<NonNullable<ConversationTextSubmissionRuntimes['documentToolCalling']>['forExecution']>>>(resolve => { finish = resolve; }));
    const submit = vi.spyOn(DeepSeekChatAdapter.prototype, 'submit');
    const data = startingDispatchFixture(factory);
    const pending = data.run();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    const factorySignal = factory.mock.calls[0][0]?.signal;
    await data.coordinator.cancel(data.responseExecutionId);
    expect(factorySignal?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ kind: 'failed_before_submission', safeCode: expect.stringContaining('cancelled') });
    const close = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    finish({ bridge: { execute: async () => ({ status: 'success' }) }, prepareTools: async () => undefined, close, cancel });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('forwards one parent owner and stops before HTTP headers resolve, then cancels a late handle', async () => {
    const startedAt = Date.now();
    const budget = new HostExecutionBudget({ startedAt, deadlineAt: startedAt + 90_000, maxToolCalls: 8, budgetUnits: 8 });
    const close = vi.fn(async () => budget.dispose());
    const cancelSession = vi.fn(async () => undefined);
    const data = startingDispatchFixture(async () => ({ executionBudget: budget, close, cancel: cancelSession,
      bridge: { execute: async () => ({ status: 'success' }) }, prepareTools: async () => undefined }));
    let finish!: () => void;
    let adapterSignal: AbortSignal | undefined;
    const cancel = vi.spyOn(DeepSeekChatAdapter.prototype, 'cancel').mockResolvedValue(true);
    const submit = vi.spyOn(DeepSeekChatAdapter.prototype, 'submit').mockImplementation(input => {
      expect(input.executionBudget).toBe(budget);
      adapterSignal = input.signal;
      return new Promise(resolve => {
        const handle = { providerOperationId: 'late-starting-handle', completion: Promise.resolve() } as unknown as Awaited<ReturnType<DeepSeekChatAdapter['submit']>>;
        finish = () => resolve(handle);
      });
    });
    const pending = data.run();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await data.coordinator.cancel(data.responseExecutionId);
    expect(adapterSignal?.aborted).toBe(true);
    expect(budget.stopReason).toBe('cancelled');
    await expect(pending).resolves.toMatchObject({ kind: 'failed_before_submission', safeCode: expect.stringContaining('cancelled') });
    expect(close).toHaveBeenCalledOnce();
    expect(cancelSession).toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('late-starting-handle'));
  });
});

describe('createConversationLinkedLifecycle', () => {
  it.each([false, true])('publishes completion only after the conversation is saved (save failure: %s)', async (failSave) => {
    const createdAt = toIsoTimestamp('2026-09-10T00:00:00.000Z');
    const assistantMessageId = toMessageId('assistant-completion');
    const executionId = toConversationResponseExecutionId('execution-completion');
    let conversation: Conversation = beginAssistantMessage(addUserMessage(createConversation({
      id: toConversationId('conversation-completion'), title: '分析图片',
      projectId: toProjectId('project-completion'), createdAt
    }), { id: toMessageId('user-completion'), content: '分析图片', createdAt }), {
      id: assistantMessageId, createdAt
    });
    let rendererSnapshot: Conversation | undefined;
    const lifecycle = {
      start: async () => undefined,
      appendDeltas: async () => [],
      complete: async () => { rendererSnapshot = conversation; },
      readModel: async () => ({ conversationId: conversation.id, assistantMessageId, reasoningContent: '' })
    } as unknown as ConversationResponseExecutionLifecycle;
    const repository = {
      get: async () => conversation,
      save: async (updated: Conversation, expectedRevision: number) => {
        expect(expectedRevision).toBe(conversation.revision);
        if (failSave && updated.messages.at(-1)?.state === 'completed') throw new Error('disk unavailable');
        await Promise.resolve();
        conversation = updated;
      }
    } as unknown as ProjectConversationRepository;
    const linked = createConversationLinkedLifecycle(lifecycle, repository, () => createdAt);
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'unicomp-linked-trace-'));
    traceRoots.push(rootDirectory);
    const scope = { rootDirectory, projectId: 'project-completion', conversationId: conversation.id,
      sourceMessageId: 'user-completion', traceId: 'user-completion' };
    await withProductionTrace(scope, () => linked.start(executionId));
    // Later callbacks may run outside the request's ALS context (cancel IPC, queued flushes).
    await linked.appendContent(executionId, '这是一张大熊猫图片。');
    if (failSave) {
      await expect(linked.complete(executionId)).rejects.toThrow('disk unavailable');
      expect(rendererSnapshot).toBeUndefined();
    } else {
      await linked.complete(executionId);
      expect(rendererSnapshot?.messages.at(-1)?.state).toBe('completed');
      // The next user turn uses exactly the revision observed by the renderer.
      const next = addUserMessage(rendererSnapshot!, {
        id: toMessageId('user-followup'), content: '生成提示词', createdAt
      });
      await repository.save(next, rendererSnapshot!.revision);
      expect(conversation.messages.at(-1)?.content).toBe('生成提示词');
    }
    const events = await getProductionTraceStore(scope).list({ conversationId: conversation.id });
    expect(events.filter((event) => event.code === 'model_response').map((event) => event.status))
      .toEqual(failSave ? ['started', 'progress'] : ['started', 'progress', 'completed']);
    expect(events.every((event) => event.assistantMessageId === assistantMessageId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('这是一张大熊猫图片');
  });

  it('projects a confirmed cancellation onto the linked assistant message', async () => {
    const conversationId = toConversationId('conversation-linked-cancel');
    const assistantMessageId = toMessageId('assistant-linked-cancel');
    const executionId = toConversationResponseExecutionId('execution-linked-cancel');
    const createdAt = toIsoTimestamp('2026-08-27T10:00:00.000Z');
    const order: string[] = [];
    let conversation: Conversation = beginAssistantMessage(
      addUserMessage(
        createConversation({
          id: conversationId,
          title: 'Linked cancellation',
          projectId: toProjectId('project-linked-cancel'),
          createdAt
        }),
        {
          id: toMessageId('user-linked-cancel'),
          content: 'create a presentation',
          createdAt
        }
      ),
      { id: assistantMessageId, createdAt }
    );
    const lifecycle = {
      start: async () => undefined,
      confirmCancelledDeferredPublish: async () => {
        order.push('execution_cancelled');
        return { responseExecutionId: executionId };
      },
      publish: async () => {
        order.push('event_published');
      },
      readModel: async () => ({
        conversationId,
        assistantMessageId,
        reasoningContent: ''
      })
    } as unknown as ConversationResponseExecutionLifecycle;
    const conversations = {
      projectId: conversation.projectId,
      get: async () => conversation,
      save: async (updated: Conversation, expectedRevision: number) => {
        expect(expectedRevision).toBe(conversation.revision);
        conversation = updated;
        if (
          conversation.messages.find((message) => message.id === assistantMessageId)
            ?.state === 'cancelled'
        ) {
          order.push('message_cancelled');
        }
      }
    } as unknown as ProjectConversationRepository;
    let tick = 0;
    const linked = createConversationLinkedLifecycle(
      lifecycle,
      conversations,
      () => `2026-08-27T10:00:0${tick++}.000Z`
    );

    await linked.start(executionId);
    await linked.confirmCancelled(executionId);

    expect(
      conversation.messages.find((message) => message.id === assistantMessageId)
    ).toMatchObject({ state: 'cancelled' });
    expect(order).toEqual([
      'execution_cancelled',
      'message_cancelled',
      'event_published'
    ]);
  });

  it.each([
    ['newapi.timeout', 'unknown'],
    ['newapi.invalid_request', 'request_rejected'],
    ['newapi.invalid_parameters', 'request_rejected'],
    ['newapi.upstream_rejected', 'upstream_rejected'],
    ['newapi.model_not_found', 'model_unavailable'],
    ['newapi.local_response_write_failed', 'local_write_failed'],
    ['newapi.permission_denied', 'access_denied'],
    ['newapi.authentication_failed', 'access_denied'],
    ['newapi.invalid_response', 'invalid_response']
  ] as const)('preserves the failure category for %s across conversation reload', async (safeCode, failureReason) => {
    const conversationId = toConversationId('conversation-linked-timeout');
    const assistantMessageId = toMessageId('assistant-linked-timeout');
    const executionId = toConversationResponseExecutionId('execution-linked-timeout');
    const createdAt = toIsoTimestamp('2026-08-28T04:09:44.000Z');
    let conversation: Conversation = beginAssistantMessage(
      addUserMessage(
        createConversation({
          id: conversationId,
          title: 'Linked timeout',
          projectId: toProjectId('project-linked-timeout'),
          createdAt
        }),
        {
          id: toMessageId('user-linked-timeout'),
          content: 'revise the spreadsheet',
          createdAt
        }
      ),
      { id: assistantMessageId, createdAt }
    );
    const lifecycle = {
      failDeferredPublish: async () => ({ responseExecutionId: executionId }),
      publish: async () => undefined,
      readModel: async () => ({
        conversationId,
        assistantMessageId,
        reasoningContent: ''
      })
    } as unknown as ConversationResponseExecutionLifecycle;
    const conversations = {
      projectId: conversation.projectId,
      get: async () => conversation,
      save: async (updated: Conversation) => {
        conversation = parseConversation(JSON.parse(JSON.stringify(updated)));
      }
    } as unknown as ProjectConversationRepository;
    const linked = createConversationLinkedLifecycle(
      lifecycle,
      conversations,
      () => '2026-08-28T04:10:47.000Z'
    );

    await linked.fail(executionId, safeCode);

    expect(
      conversation.messages.find((message) => message.id === assistantMessageId)
    ).toMatchObject({ state: 'failed', failureReason, content: '' });
  });
});
