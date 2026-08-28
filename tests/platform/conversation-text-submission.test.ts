import { describe, expect, it } from 'vitest';
import {
  addUserMessage,
  beginAssistantMessage,
  createConversation,
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

  it('projects an unconfirmed provider timeout as an unknown remote outcome', async () => {
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
        conversation = updated;
      }
    } as unknown as ProjectConversationRepository;
    const linked = createConversationLinkedLifecycle(
      lifecycle,
      conversations,
      () => '2026-08-28T04:10:47.000Z'
    );

    await linked.fail(executionId, 'newapi.timeout');

    expect(
      conversation.messages.find((message) => message.id === assistantMessageId)
    ).toMatchObject({ state: 'failed', failureReason: 'unknown' });
  });
});
