import {
  addCompletedAssistantMessage,
  addUserMessage,
  createConversation,
  parseMessage,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toThreadId,
  type ProjectConversationRepository,
  type ThreadProjectionOutboxEventV1,
  type ThreadProjectionReceiptV1
} from '../domain';
import type { ThreadFileRepository } from '../platform/repositories/thread-file-repository';

/**
 * Replays only committed Thread transcript facts into the Legacy compatibility
 * view. It never starts a Provider, Tool or Document operation.
 */
export class ThreadLegacyProjectionWorker {
  constructor(
    private readonly threads: ThreadFileRepository,
    private readonly conversations: ProjectConversationRepository,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async drain(threadId: string): Promise<{ readonly projected: number; readonly pending: number }> {
    const typedThreadId = toThreadId(threadId);
    const events = await this.threads.readProjectionOutbox(typedThreadId);
    const receipts = new Set((await this.threads.readProjectionReceipts(typedThreadId)).map(item => item.eventId));
    let projected = 0;
    for (const event of events) {
      if (receipts.has(event.eventId)) continue;
      try {
        await this.project(event);
      } catch {
        // Thread is authoritative. Keep the unacknowledged Outbox event as
        // durable projection debt without blocking a new User Turn.
        continue;
      }
      const receipt: ThreadProjectionReceiptV1 = {
        schemaVersion: 1,
        eventId: event.eventId,
        threadId: event.threadId,
        idempotencyKey: event.idempotencyKey,
        projectedAt: toIsoTimestamp(this.now())
      };
      await this.threads.acknowledgeProjection(receipt);
      projected += 1;
      receipts.add(event.eventId);
    }
    return { projected, pending: events.filter(event => !receipts.has(event.eventId)).length };
  }

  private async project(event: ThreadProjectionOutboxEventV1): Promise<void> {
    const item = event.item;
    if (!item.messageSource || !['user_message', 'assistant_message'].includes(item.type)) return;
    let conversation = await this.conversations.get(toConversationId(String(event.threadId)));
    if (!conversation) {
      const thread = await this.threads.getThread(event.threadId);
      if (!thread) throw new Error('thread_not_found_for_legacy_projection');
      conversation = createConversation({
        id: toConversationId(String(event.threadId)),
        projectId: thread.projectId,
        title: thread.title,
        createdAt: toIsoTimestamp(thread.createdAt)
      });
      await this.conversations.create(conversation);
    }
    const messageId = toMessageId(String(item.messageSource.messageId));
    const existing = conversation.messages.find(message => message.id === messageId);
    const snapshot = item.legacyMessageSnapshot;
    if (!existing && snapshot?.schemaVersion === 1) {
      const projected = parseMessage(snapshot);
      if (projected.id !== messageId || projected.conversationId !== conversation.id ||
          projected.role !== (item.type === 'user_message' ? 'user' : 'assistant') ||
          projected.revision !== item.messageSource.messageRevision) {
        throw new Error('legacy_projection_message_conflict');
      }
      // The first replay may already be streaming/failed/cancelled or carry a
      // formal document receipt. Restoring it as completed text loses facts.
      await this.conversations.save({ ...conversation, revision: conversation.revision + 1,
        updatedAt: projected.updatedAt > conversation.updatedAt ? projected.updatedAt : conversation.updatedAt,
        messages: [...conversation.messages, projected] }, conversation.revision);
      return;
    }
    if (existing) {
      // Stream replay can encounter events older than a direct Legacy
      // compatibility write. They are already represented by a newer
      // revision and can be acknowledged safely.
      if (existing.revision > item.messageSource.messageRevision) return;
      if (existing.revision === item.messageSource.messageRevision &&
          (!snapshot || JSON.stringify(existing) === JSON.stringify(parseMessage(snapshot)))) return;
      if (snapshot) {
        const projected = parseMessage(snapshot);
        if (projected.id !== messageId || projected.conversationId !== conversation.id ||
            projected.role !== (item.type === 'user_message' ? 'user' : 'assistant') ||
            projected.revision !== item.messageSource.messageRevision || projected.updatedAt < existing.updatedAt) {
          throw new Error('legacy_projection_message_conflict');
        }
        await this.conversations.save({
          ...conversation,
          revision: conversation.revision + 1,
          updatedAt: projected.updatedAt > conversation.updatedAt ? projected.updatedAt : conversation.updatedAt,
          messages: conversation.messages.map(message => message.id === messageId ? projected : message)
        }, conversation.revision);
        return;
      }
      throw new Error('legacy_projection_message_conflict');
    }
    const updated = item.type === 'user_message'
      ? addUserMessage(conversation, {
          id: messageId,
          content: item.content ?? '',
          createdAt: toIsoTimestamp(item.createdAt),
          ...(Array.isArray(item.legacyMessageSnapshot?.attachments) ? { attachments: item.legacyMessageSnapshot.attachments as never } : {}),
          ...(typeof item.legacyMessageSnapshot?.displayContent === 'string' ? { displayContent: item.legacyMessageSnapshot.displayContent } : {})
        })
      : addCompletedAssistantMessage(conversation, {
          id: messageId,
          content: item.content ?? '',
          createdAt: toIsoTimestamp(item.createdAt),
          ...(workflowReply(item.legacyMessageSnapshot) ? { workflowReply: workflowReply(item.legacyMessageSnapshot)! } : {})
        });
    await this.conversations.save(updated, conversation.revision);
  }
}

function workflowReply(snapshot: Readonly<Record<string, unknown>> | undefined): { readonly workflowId: string; readonly revision: number } | undefined {
  const value = snapshot?.workflowReply;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.workflowId === 'string' && Number.isSafeInteger(record.revision)
    ? { workflowId: record.workflowId, revision: Number(record.revision) }
    : undefined;
}
