import { randomUUID, createHash } from 'node:crypto';
import {
  chatContextRequestParsers,
  type ChatContextIpcResult,
  type ConversationDto,
  type ConversationTurnDto,
  type GetThreadItemsPageRequest,
  type MessageDto,
  type ThreadDto,
  type ThreadItemDto,
  type ThreadItemsPageDto,
  type ThreadSummaryDto,
  type ThreadSummaryPageDto
} from '../../shared/chat-context-ipc';
import { failure } from './chat-context-errors';

interface ThreadConversationReadPort {
  get(request: unknown): Promise<ChatContextIpcResult<ConversationDto>>;
  list(request: unknown): Promise<ChatContextIpcResult<readonly ConversationDto[]>>;
}

interface SummarySnapshot {
  readonly snapshotId: string;
  readonly scopeKey: string;
  readonly readAtSequence: number;
  readonly createdAt: number;
  readonly items: readonly ThreadSummaryDto[];
}

interface SummaryCursorV1 {
  readonly version: 1;
  readonly snapshotId: string;
  readonly scopeKey: string;
  readonly offset: number;
}

interface ItemCursorV1 {
  readonly version: 1;
  readonly scopeKey: string;
  readonly threadId: string;
  readonly direction: 'older' | 'newer';
  readonly readAtSequence: number;
  readonly anchorSequence: number;
}

const maximumSummarySnapshots = 8;
const summarySnapshotLifetimeMs = 120_000;
/** Read adapter over complete legacy Conversation DTOs. It does not own writes or execution state. */
export class ConversationThreadReadController {
  private readonly summarySnapshots = new Map<string, SummarySnapshot>();
  private summarySequence = 0;

  constructor(
    private readonly source: ThreadConversationReadPort,
    private readonly currentScope: () => string
  ) {}

  async listThreadSummaries(request: unknown): Promise<ChatContextIpcResult<ThreadSummaryPageDto>> {
    try {
      const input = chatContextRequestParsers.listThreadSummaries(request);
      const queryScope = `${this.currentScope()}|archived=${input.includeArchived}|deleted=${input.includeDeleted}`;
      const cursor = input.cursor ? parseSummaryCursor(input.cursor) : undefined;
      let snapshot: SummarySnapshot;
      let offset: number;
      if (cursor) {
        this.expireSummarySnapshots();
        snapshot = this.summarySnapshots.get(cursor.snapshotId)!;
        if (!snapshot) return failure('thread_cursor_expired', '会话列表快照已过期，请重新加载。');
        if (cursor.scopeKey !== queryScope || snapshot.scopeKey !== queryScope) {
          return failure('thread_cursor_scope_mismatch', '会话列表属于另一个项目，请重新加载。');
        }
        if (cursor.offset < 0 || cursor.offset > snapshot.items.length) {
          return failure('thread_cursor_invalid', '会话列表游标无效，请重新加载。');
        }
        offset = cursor.offset;
      } else {
        const listed = await this.source.list({
          includeArchived: input.includeArchived,
          includeDeleted: input.includeDeleted
        });
        if (!listed.ok) return listed;
        const items = listed.value.map(toThreadSummary).sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.threadId.localeCompare(right.threadId)
        );
        snapshot = {
          snapshotId: randomUUID(),
          scopeKey: queryScope,
          readAtSequence: ++this.summarySequence,
          createdAt: Date.now(),
          items
        };
        this.expireSummarySnapshots();
        this.summarySnapshots.set(snapshot.snapshotId, snapshot);
        while (this.summarySnapshots.size > maximumSummarySnapshots) {
          this.summarySnapshots.delete(this.summarySnapshots.keys().next().value!);
        }
        offset = 0;
      }

      const items = snapshot.items.slice(offset, offset + input.limit);
      const nextOffset = offset + items.length;
      return {
        ok: true,
        value: {
          items,
          readAtSequence: snapshot.readAtSequence,
          hasMore: nextOffset < snapshot.items.length,
          ...(nextOffset < snapshot.items.length
            ? { nextCursor: encodeCursor({
                version: 1,
                snapshotId: snapshot.snapshotId,
                scopeKey: snapshot.scopeKey,
                offset: nextOffset
              }) }
            : {})
        }
      };
    } catch {
      if (hasInvalidLimit(request)) return failure('thread_page_limit_out_of_range', '每次读取数量必须在 1 到 200 之间。');
      return failure('thread_cursor_invalid', '会话列表请求或游标无效。');
    }
  }

  async getThread(request: unknown): Promise<ChatContextIpcResult<ThreadDto>> {
    try {
      const input = chatContextRequestParsers.getThread(request);
      const result = await this.source.get({ conversationId: input.threadId });
      if (!result.ok) {
        return result.error.code === 'conversation_not_found'
          ? failure('thread_not_found', '会话不存在或不可读取。')
          : result;
      }
      return { ok: true, value: {
        ...toThreadSummary(result.value),
        ...(result.value.parentRuns ? { parentRuns: result.value.parentRuns } : {}),
        ...(result.value.agentSessions ? { agentSessions: result.value.agentSessions } : {})
      } };
    } catch {
      return failure('invalid_request', 'Thread ID 无效。');
    }
  }

  async getThreadItemsPage(request: unknown): Promise<ChatContextIpcResult<ThreadItemsPageDto>> {
    let input: GetThreadItemsPageRequest;
    let cursor: ItemCursorV1 | undefined;
    try {
      input = chatContextRequestParsers.getThreadItemsPage(request);
      cursor = input.cursor ? parseItemCursor(input.cursor) : undefined;
      if (cursor && (cursor.threadId !== input.threadId || cursor.direction !== input.direction || cursor.scopeKey !== this.currentScope())) {
        return failure('thread_cursor_scope_mismatch', '消息游标不属于当前会话。');
      }
    } catch {
      if (hasInvalidLimit(request)) return failure('thread_page_limit_out_of_range', '每次读取数量必须在 1 到 200 之间。');
      return failure('thread_cursor_invalid', '消息分页请求或游标无效。');
    }

    const result = await this.source.get({ conversationId: input.threadId });
    if (!result.ok) {
      return result.error.code === 'conversation_not_found'
        ? failure('thread_not_found', '会话不存在或不可读取。')
        : result;
    }

    const conversation = result.value;
    const readAtSequence = cursor?.readAtSequence ?? conversation.messages.length;
    if (readAtSequence > conversation.messages.length) {
      return failure('thread_cursor_invalid', '消息分页快照无效，请重新加载。');
    }
    const all = conversation.messages.map((message, index) => ({
      sequence: index + 1,
      item: toThreadItem(conversation.conversationId, message, index + 1,
        legacyTurnId(conversation.conversationId, precedingUserMessageId(conversation.messages, index)))
    })).filter(entry => entry.sequence <= readAtSequence);

    let selected: typeof all;
    let hasMore: boolean;
    let nextCursor: string | undefined;
    if (!cursor) {
      if (input.direction === 'older') {
        selected = all.slice(-input.limit);
        hasMore = (selected[0]?.sequence ?? 1) > 1;
        if (hasMore) nextCursor = encodeCursor({
          version: 1, scopeKey: this.currentScope(), threadId: input.threadId, direction: 'older',
          readAtSequence, anchorSequence: selected[0]!.sequence
        });
      } else {
        selected = all.slice(0, input.limit);
        hasMore = (selected.at(-1)?.sequence ?? 0) < readAtSequence;
        if (hasMore) nextCursor = encodeCursor({
          version: 1, scopeKey: this.currentScope(), threadId: input.threadId, direction: 'newer',
          readAtSequence, anchorSequence: selected.at(-1)!.sequence
        });
      }
    } else if (cursor.direction === 'older') {
      selected = all.filter(entry => entry.sequence < cursor.anchorSequence).slice(-input.limit);
      hasMore = (selected[0]?.sequence ?? 1) > 1;
      if (hasMore) nextCursor = encodeCursor({ ...cursor, anchorSequence: selected[0]!.sequence });
    } else {
      selected = all.filter(entry => entry.sequence > cursor.anchorSequence).slice(0, input.limit);
      hasMore = (selected.at(-1)?.sequence ?? cursor.anchorSequence) < readAtSequence;
      if (hasMore) nextCursor = encodeCursor({ ...cursor, anchorSequence: selected.at(-1)!.sequence });
    }

    return {
      ok: true,
      value: {
        threadId: conversation.conversationId,
        revision: conversation.revision,
        updatedAt: conversation.updatedAt,
        items: selected.map(entry => entry.item),
        readAtSequence,
        hasMore,
        ...(nextCursor ? { nextCursor } : {})
      }
    };
  }

  async getTurn(request: unknown): Promise<ChatContextIpcResult<ConversationTurnDto>> {
    try {
      const { turnId } = chatContextRequestParsers.getTurn(request);
      const listed = await this.source.list({ includeArchived: true, includeDeleted: false });
      if (!listed.ok) return listed;
      for (const listedThread of listed.value) {
        const userIndex = listedThread.messages.findIndex(message =>
          message.role === 'user' && legacyTurnId(listedThread.conversationId, message.messageId) === turnId);
        if (userIndex < 0) continue;
        const complete = await this.source.get({ conversationId: listedThread.conversationId });
        if (!complete.ok) return complete;
        return { ok: true, value: toLegacyTurn(complete.value, userIndex) };
      }
      return failure('thread_not_found', 'Turn 不存在或不可读取。');
    } catch {
      return failure('invalid_request', 'Turn ID 无效。');
    }
  }

  private expireSummarySnapshots(): void {
    const expiredBefore = Date.now() - summarySnapshotLifetimeMs;
    for (const [id, snapshot] of this.summarySnapshots) {
      if (snapshot.createdAt < expiredBefore) this.summarySnapshots.delete(id);
    }
  }
}

function toThreadSummary(conversation: ConversationDto): ThreadSummaryDto {
  const lastMessage = conversation.messages.at(-1);
  const turns = conversation.messages.filter(message => message.role === 'user').length;
  return {
    threadId: conversation.conversationId,
    conversationId: conversation.conversationId,
    revision: conversation.revision,
    projectId: conversation.projectId,
    title: conversation.title,
    status: conversation.status,
    storageScope: conversation.storageScope,
    readOnly: conversation.readOnly,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.archivedAt ? { archivedAt: conversation.archivedAt } : {}),
    ...(conversation.deletedAt ? { deletedAt: conversation.deletedAt } : {}),
    messageCount: conversation.messages.length,
    turnCount: turns,
    hasActiveDocumentGeneration: conversation.messages.some(message =>
      ['generating_content', 'validating_outline', 'generating_file'].includes(message.documentGenerationStatus?.state ?? '')),
    ...(lastMessage ? { lastItemId: { namespace: 'message', value: lastMessage.messageId } } : {})
  };
}

function toThreadItem(threadId: string, message: MessageDto, sequence: number, turnId?: string): ThreadItemDto {
  return {
    itemId: { namespace: 'message', value: message.messageId },
    threadId,
    ...(turnId ? { turnId } : {}),
    sequence,
    itemType: message.role === 'user' ? 'user_message' : 'assistant_message',
    status: message.state,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    messageId: message.messageId,
    message
  };
}

function toLegacyTurn(conversation: ConversationDto, userIndex: number): ConversationTurnDto {
  const user = conversation.messages[userIndex]!;
  const laterUsers = conversation.messages.slice(userIndex + 1).findIndex(message => message.role === 'user');
  const end = laterUsers < 0 ? conversation.messages.length : userIndex + 1 + laterUsers;
  const assistantMessages = conversation.messages.slice(userIndex + 1, end)
    .filter(message => message.role === 'assistant');
  const terminal = assistantMessages.at(-1);
  const status = terminal?.state === 'failed'
    ? terminal.failureReason === 'interrupted' ? 'interrupted' : 'failed'
    : terminal?.state === 'cancelled' ? 'cancelled'
      : terminal?.state === 'completed' ? 'completed' : 'open';
  const runIds = [...new Set((conversation.agentSessions ?? [])
    .filter(session => session.sourceMessageId === user.messageId)
    .map(session => session.sessionId))];
  const responseExecutionIds = [...new Set((conversation.parentRuns ?? [])
    .filter(run => run.sourceMessageId === user.messageId)
    .map(run => run.responseExecutionId))];
  return {
    turnId: legacyTurnId(conversation.conversationId, user.messageId)!,
    threadId: conversation.conversationId,
    turnSequence: conversation.messages.slice(0, userIndex + 1).filter(message => message.role === 'user').length,
    status,
    createdAt: user.createdAt,
    ...(terminal?.completedAt || terminal?.failedAt || terminal?.cancelledAt
      ? { completedAt: terminal.completedAt ?? terminal.failedAt ?? terminal.cancelledAt } : {}),
    userItemId: { namespace: 'message', value: user.messageId },
    assistantItemIds: assistantMessages.map(message => ({ namespace: 'message' as const, value: message.messageId })),
    agentRunIds: runIds,
    responseExecutionIds,
    provenance: 'legacy_inferred'
  };
}

function precedingUserMessageId(messages: readonly MessageDto[], index: number): string | undefined {
  for (let current = index; current >= 0; current -= 1) {
    if (messages[current]!.role === 'user') return messages[current]!.messageId;
  }
  return undefined;
}

function legacyTurnId(threadId: string, messageId: string | undefined): string | undefined {
  if (!messageId) return undefined;
  const digest = createHash('sha256').update(JSON.stringify([threadId, messageId])).digest('hex');
  return `turn-legacy-v1-${digest}`;
}

function encodeCursor(value: SummaryCursorV1 | ItemCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseSummaryCursor(value: string): SummaryCursorV1 {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!isRecord(parsed) || Object.keys(parsed).some(key => !['version', 'snapshotId', 'scopeKey', 'offset'].includes(key)) ||
      parsed.version !== 1 || typeof parsed.snapshotId !== 'string' || typeof parsed.scopeKey !== 'string' ||
      !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new TypeError('summary cursor invalid');
  return parsed as unknown as SummaryCursorV1;
}

function parseItemCursor(value: string): ItemCursorV1 {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!isRecord(parsed) || Object.keys(parsed).some(key => !['version', 'scopeKey', 'threadId', 'direction', 'readAtSequence', 'anchorSequence'].includes(key)) ||
      parsed.version !== 1 || typeof parsed.scopeKey !== 'string' || typeof parsed.threadId !== 'string' || !['older', 'newer'].includes(String(parsed.direction)) ||
      !Number.isSafeInteger(parsed.readAtSequence) || Number(parsed.readAtSequence) < 0 ||
      !Number.isSafeInteger(parsed.anchorSequence) || Number(parsed.anchorSequence) < 0) throw new TypeError('item cursor invalid');
  return parsed as unknown as ItemCursorV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasInvalidLimit(value: unknown): boolean {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'limit')) return false;
  return !Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 200;
}
