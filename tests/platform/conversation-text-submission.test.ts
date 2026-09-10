import { describe, expect, it } from 'vitest';
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
import {
  createConversationLinkedLifecycle,
  type ConversationResponseExecutionLifecycle
} from '../../src/platform';

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
    await linked.start(executionId);
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
