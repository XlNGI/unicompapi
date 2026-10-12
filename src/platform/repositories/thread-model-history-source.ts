import {
  parseMessage, parseConversation, toThreadId,
  type Conversation, type ConversationId, type ItemV1, type Message, type ProjectId
} from '../../domain';
import type { ModelHistorySource } from '../../application/model-history-reader';
import type { ThreadFileRepository } from './thread-file-repository';

/** Complete model transcript, independent of Renderer pages and Legacy projection debt. */
export class ThreadModelHistorySource implements ModelHistorySource {
  constructor(
    private readonly threads: Pick<ThreadFileRepository, 'getThread' | 'readItems'> & Partial<Pick<ThreadFileRepository, 'readTranscript'>>,
    private readonly projectId: ProjectId,
    private readonly legacyFallback?: ModelHistorySource
  ) {}

  async getConversation(conversationId: ConversationId): Promise<Conversation | undefined> {
    const transcript = this.threads.readTranscript ? await this.threads.readTranscript(toThreadId(conversationId)) : undefined;
    const thread = this.threads.readTranscript ? transcript?.thread : await this.threads.getThread(toThreadId(conversationId));
    // Only a missing, unmigrated Thread may use an explicitly supplied fallback.
    // Corrupt or out-of-scope authoritative data must never silently use Legacy.
    if (!thread) return this.legacyFallback?.getConversation(conversationId);
    if (thread.projectId !== this.projectId) throw new Error('thread_project_scope_mismatch');
    const items = transcript?.items ?? await this.threads.readItems(thread.threadId);
    const messages = items.filter(item => ['user_message', 'assistant_message'].includes(item.type))
      .map(threadMessage);
    return parseConversation({ schemaVersion: 1, id: conversationId, projectId: thread.projectId,
      revision: thread.generation, title: thread.title, status: thread.status,
      createdAt: thread.createdAt, updatedAt: thread.updatedAt, messages,
      ...(thread.status === 'archived' ? { archivedAt: thread.updatedAt }
        : thread.status === 'deleted' ? { deletedAt: thread.updatedAt } : {}) });
  }
}

function threadMessage(item: ItemV1): Message {
  const source = item.messageSource;
  if (!source || item.itemId.namespace !== 'message' || item.itemId.value !== source.messageId) {
    throw new Error('thread_message_source_invalid');
  }
  const role = item.type === 'user_message' ? 'user' : 'assistant';
  const saved = item.legacyMessageSnapshot;
  if (saved && saved.schemaVersion !== 1 && Object.keys(saved).some(key =>
    !['attachments', 'displayContent', 'workflowReply'].includes(key))) throw new Error('thread_message_snapshot_conflict');
  const snapshot = saved ? parseMessage(saved.schemaVersion === 1 ? saved : {
    schemaVersion: 1, id: source.messageId, conversationId: item.threadId, role,
    revision: source.messageRevision, state: 'completed', content: item.content ?? '',
    attachments: saved.attachments ?? [], createdAt: item.createdAt, updatedAt: item.updatedAt,
    completedAt: item.updatedAt, streamSequence: 0,
    ...(saved.attachments !== undefined ? { attachmentSelection: 'replace' } : {}),
    ...(saved.displayContent !== undefined ? { displayContent: saved.displayContent } : {}),
    ...(saved.workflowReply !== undefined ? { workflowReply: saved.workflowReply } : {})
  }) : undefined;
  if (snapshot && (snapshot.id !== source.messageId || String(snapshot.conversationId) !== String(item.threadId) ||
      snapshot.role !== role || snapshot.revision !== source.messageRevision)) throw new Error('thread_message_snapshot_conflict');
  // Item state/text are the authority. Snapshots retain attachments, reasoning
  // and delivery receipts; they cannot reopen an interrupted/unknown response.
  const state = item.status === 'interrupted' || item.status === 'unknown' ? 'failed' : item.status;
  const metadata = Object.fromEntries(Object.entries(snapshot ?? {}).filter(([key]) =>
    !['startedAt', 'completedAt', 'failedAt', 'failureReason', 'cancelledAt', 'streamSequence'].includes(key)));
  return parseMessage({ ...metadata, schemaVersion: 1, id: source.messageId, conversationId: item.threadId,
    role, revision: source.messageRevision, state, content: item.content ?? '',
    attachments: snapshot?.attachments ?? [], createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(state === 'pending' ? {} : { streamSequence: snapshot && 'streamSequence' in snapshot ? snapshot.streamSequence : 0 }),
    ...(state === 'streaming' ? { startedAt: snapshot && 'startedAt' in snapshot ? snapshot.startedAt : item.createdAt }
      : state === 'completed' ? { completedAt: item.updatedAt }
        : state === 'cancelled' ? { cancelledAt: item.updatedAt }
          : state === 'failed' ? { failedAt: item.updatedAt,
              failureReason: item.status === 'interrupted' ? 'interrupted' : item.status === 'unknown' ? 'unknown'
                : snapshot && 'failureReason' in snapshot ? snapshot.failureReason : 'unknown' } : {}) });
}
