import { randomUUID } from 'node:crypto';
import type { ThreadFileRepository } from '../repositories/thread-file-repository';
import type { ChatContextIpcResult, ConversationTurnDto, ThreadDto, ThreadItemDto, ThreadItemsPageDto, ThreadSummaryDto, ThreadSummaryPageDto } from '../../shared/chat-context-ipc';
import type { ThreadId, ItemV1, ThreadV1 } from '../../domain';
import { failure } from './chat-context-errors';

interface ItemCursorV1 {
  readonly version: 1;
  readonly threadId: string;
  readonly direction: 'older' | 'newer';
  readonly readAtSequence: number;
  readonly anchorSequence: number;
}

interface SummarySnapshot {
  readonly id: string;
  readonly items: readonly ThreadSummaryDto[];
  readonly createdAt: number;
}

export interface ThreadFileReadAdapterOptions {
  readonly getRepository: () => ThreadFileRepository | undefined;
  readonly projectId: () => string | undefined;
}

export interface ThreadReadApi {
  listThreadSummaries(request: unknown): Promise<ChatContextIpcResult<ThreadSummaryPageDto>>;
  getThread(request: unknown): Promise<ChatContextIpcResult<ThreadDto>>;
  getThreadItemsPage(request: unknown): Promise<ChatContextIpcResult<ThreadItemsPageDto>>;
  getTurn(request: unknown): Promise<ChatContextIpcResult<ConversationTurnDto>>;
}

/** Read-only adapter over committed ThreadFileRepository state. */
export class ThreadFileReadAdapter implements ThreadReadApi {
  private readonly snapshots = new Map<string, SummarySnapshot>();

  constructor(private readonly options: ThreadFileReadAdapterOptions) {}

  async listThreadSummaries(request: unknown): Promise<ChatContextIpcResult<ThreadSummaryPageDto>> {
    try {
      const input = parseSummaryRequest(request);
      const repository = this.requireRepository();
      const cursor = input.cursor ? decode< { readonly snapshotId: string; readonly offset: number }>(input.cursor) : undefined;
      let snapshot = cursor ? this.snapshots.get(cursor.snapshotId) : undefined;
      if (cursor && !snapshot) return failure('thread_cursor_expired', '会话列表快照已过期，请重新加载。');
      if (!snapshot) {
        const summaries = await repository.listThreadSummaries();
        const items = summaries
          .filter(summary => summary.projectId === null || summary.projectId === this.options.projectId())
          .map(toSummaryDto)
          .filter(summary => input.includeArchived || summary.status === 'active')
          .filter(summary => input.includeDeleted || summary.status !== 'deleted');
        snapshot = { id: randomUUID(), items, createdAt: Date.now() };
        this.snapshots.set(snapshot.id, snapshot);
      }
      const offset = cursor?.offset ?? 0;
      const items = snapshot.items.slice(offset, offset + input.limit);
      const nextOffset = offset + items.length;
      return { ok: true, value: { items, readAtSequence: snapshot.items.length, hasMore: nextOffset < snapshot.items.length, ...(nextOffset < snapshot.items.length ? { nextCursor: encode({ snapshotId: snapshot.id, offset: nextOffset }) } : {}) } };
    } catch (error) {
      return failure('storage_error', error instanceof Error ? error.message : 'Thread summary read failed');
    }
  }

  async getThread(request: unknown): Promise<ChatContextIpcResult<ThreadDto>> {
    try {
      const threadId = parseId(request);
      const thread = await this.requireRepository().getThread(threadId as ThreadId);
      if (!thread) return failure('thread_not_found', '会话不存在或不可读取。');
      return { ok: true, value: toThreadDto(thread) };
    } catch (error) { return failure('storage_error', error instanceof Error ? error.message : 'Thread read failed'); }
  }

  async getThreadItemsPage(request: unknown): Promise<ChatContextIpcResult<ThreadItemsPageDto>> {
    try {
      const input = parseItemsRequest(request);
      const repository = this.requireRepository();
      const all = [...await repository.readItems(input.threadId as ThreadId)].sort((left, right) => left.sequence - right.sequence);
      const cursor = input.cursor ? decode<ItemCursorV1>(input.cursor) : undefined;
      if (cursor && (cursor.threadId !== input.threadId || cursor.direction !== input.direction)) return failure('thread_cursor_scope_mismatch', '消息游标不属于当前会话。');
      const readAtSequence = cursor?.readAtSequence ?? all.at(-1)?.sequence ?? 0;
      const visible = all.filter(item => item.sequence <= readAtSequence);
      let selected: readonly ItemV1[];
      let hasMore: boolean;
      let nextCursor: string | undefined;
      if (!cursor) {
        selected = input.direction === 'older' ? visible.slice(-input.limit) : visible.slice(0, input.limit);
        hasMore = input.direction === 'older' ? (selected[0]?.sequence ?? 1) > 1 : (selected.at(-1)?.sequence ?? 0) < readAtSequence;
      } else if (cursor.direction === 'older') {
        selected = visible.filter(item => item.sequence < cursor.anchorSequence).slice(-input.limit);
        hasMore = (selected[0]?.sequence ?? 1) > 1;
      } else {
        selected = visible.filter(item => item.sequence > cursor.anchorSequence).slice(0, input.limit);
        hasMore = (selected.at(-1)?.sequence ?? cursor.anchorSequence) < readAtSequence;
      }
      if (hasMore) {
        const anchorSequence = input.direction === 'older' ? selected[0]!.sequence : selected.at(-1)!.sequence;
        nextCursor = encode({ version: 1, threadId: input.threadId, direction: input.direction, readAtSequence, anchorSequence });
      }
      const thread = await repository.getThread(input.threadId as ThreadId);
      if (!thread) return failure('thread_not_found', '会话不存在或不可读取。');
      return { ok: true, value: { threadId: input.threadId, revision: thread.generation, updatedAt: thread.updatedAt, items: selected.map(toItemDto), readAtSequence, hasMore, ...(nextCursor ? { nextCursor } : {}) } };
    } catch (error) { return failure('storage_error', error instanceof Error ? error.message : 'Thread page read failed'); }
  }

  async getTurn(request: unknown): Promise<ChatContextIpcResult<ConversationTurnDto>> {
    try {
      const turnId = parseId(request);
      const repository = this.requireRepository();
      for (const summary of await repository.listThreadSummaries()) {
        const turns = await repository.readTurns(summary.threadId as ThreadId);
        const turn = turns.find(candidate => candidate.turnId === turnId);
        if (turn) {
          const links = (await repository.readExecutionLinks(turn.threadId)).filter(link => link.turnId === turn.turnId);
          return { ok: true, value: { turnId: turn.turnId, threadId: turn.threadId, turnSequence: turn.turnSequence, status: turn.status, createdAt: turn.createdAt, ...(turn.completedAt ? { completedAt: turn.completedAt } : {}), userItemId: toItemIdentity(turn.userItemId), assistantItemIds: turn.assistantItemIds.map(toItemIdentity), agentRunIds: links.map(link => link.agentRunId), responseExecutionIds: links.flatMap(link => link.responseExecutionId ? [link.responseExecutionId] : []), provenance: turn.provenance } };
        }
      }
      return failure('thread_not_found', '交互轮次不存在或不可读取。');
    } catch (error) { return failure('storage_error', error instanceof Error ? error.message : 'Turn read failed'); }
  }

  private requireRepository(): ThreadFileRepository { const repository = this.options.getRepository(); if (!repository) throw new Error('thread_file_read_disabled'); return repository; }
}

function toSummaryDto(summary: { readonly threadId: ThreadId; readonly projectId: string | null; readonly title: string; readonly status: ThreadV1['status']; readonly createdAt: string; readonly updatedAt: string; readonly revision: number; readonly itemCount: number; readonly turnCount: number; readonly lastItemId?: ThreadV1['lastItemId'] }): ThreadSummaryDto {
  return { threadId: summary.threadId, conversationId: summary.threadId, revision: summary.revision, projectId: summary.projectId, title: summary.title, status: summary.status, storageScope: 'current_project', readOnly: false, createdAt: summary.createdAt, updatedAt: summary.updatedAt, messageCount: summary.itemCount, turnCount: summary.turnCount, hasActiveDocumentGeneration: false, ...(summary.lastItemId ? { lastItemId: toItemIdentity(summary.lastItemId) } : {}) };
}
function toThreadDto(thread: ThreadV1): ThreadDto { return { ...toSummaryDto({ threadId: thread.threadId, projectId: thread.projectId, title: thread.title, status: thread.status, createdAt: thread.createdAt, updatedAt: thread.updatedAt, revision: thread.generation, itemCount: thread.itemCount, turnCount: thread.turnCount, ...(thread.lastItemId ? { lastItemId: thread.lastItemId } : {}) }) }; }
function toItemIdentity(item: ItemV1['itemId'] | undefined): { readonly namespace: 'message' | 'projection'; readonly value: string } { return item ? { namespace: item.namespace, value: item.value } : { namespace: 'message', value: '' }; }
function toItemDto(item: ItemV1): ThreadItemDto { const message = item.messageSource ? ({ ...(item.legacyMessageSnapshot ?? {}), messageId: item.messageSource.messageId, conversationId: item.threadId, revision: item.messageSource.messageRevision, role: item.type === 'user_message' ? 'user' as const : 'assistant' as const, state: messageState(item.status), content: item.content ?? '', attachments: Array.isArray(item.legacyMessageSnapshot?.attachments) ? item.legacyMessageSnapshot.attachments : [], createdAt: item.createdAt, updatedAt: item.updatedAt } as ThreadItemDto['message']) : undefined; return { itemId: toItemIdentity(item.itemId), threadId: item.threadId, ...(item.turnId ? { turnId: item.turnId } : {}), sequence: item.sequence, itemType: item.type, status: dtoStatus(item.status), createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.messageSource ? { messageId: item.messageSource.messageId } : {}), ...(message ? { message } : {}), ...(item.projectionSource ? { projectionSource: { eventSystem: item.projectionSource.eventSystem, sourceIdentity: item.projectionSource.sourceIdentity, ...(item.projectionSource.responseExecutionId ? { responseExecutionId: item.projectionSource.responseExecutionId } : {}), ...(item.projectionSource.agentRunId ? { agentRunId: item.projectionSource.agentRunId } : {}), ...(item.projectionSource.toolCallId ? { toolCallId: item.projectionSource.toolCallId } : {}), ...(item.projectionSource.workId ? { workId: item.projectionSource.workId } : {}) } } : {}) }; }
function messageState(value: ItemV1['status']): 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled' { return value === 'pending' || value === 'streaming' || value === 'completed' || value === 'cancelled' ? value : 'failed'; }
function dtoStatus(value: ItemV1['status']): ThreadItemDto['status'] { return value === 'interrupted' ? 'failed' : value; }
function parseId(value: unknown): string { if (!value || typeof value !== 'object') throw new TypeError('Invalid Thread read request'); const record = value as Record<string, unknown>; const id = record.threadId ?? record.turnId; if (typeof id !== 'string' || !id.trim()) throw new TypeError('Invalid Thread ID'); return id; }
function parseSummaryRequest(value: unknown): { readonly includeArchived: boolean; readonly includeDeleted: boolean; readonly limit: number; readonly cursor?: string } { const record = value as Record<string, unknown>; const limit = Number(record.limit); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid page limit'); return { includeArchived: record.includeArchived === true, includeDeleted: record.includeDeleted === true, limit, ...(typeof record.cursor === 'string' ? { cursor: record.cursor } : {}) }; }
function parseItemsRequest(value: unknown): { readonly threadId: string; readonly direction: 'older' | 'newer'; readonly limit: number; readonly cursor?: string } { const record = value as Record<string, unknown>; const threadId = String(record.threadId ?? ''); const direction = record.direction === 'newer' ? 'newer' : record.direction === 'older' ? 'older' : undefined; const limit = Number(record.limit); if (!threadId || !direction || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid Thread page request'); return { threadId, direction, limit, ...(typeof record.cursor === 'string' ? { cursor: record.cursor } : {}) }; }
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decode<T>(value: string): T { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T; }
