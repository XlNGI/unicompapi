import { describe, expect, it } from 'vitest';
import type {
  ChatContextIpcResult,
  ConversationDto,
} from '../../src/shared/chat-context-ipc';
import { ConversationThreadReadController } from '../../src/platform/ipc/conversation-thread-read-controller';

const at = '2026-10-08T12:00:00.000Z';

function conversation(id: string, messageCount: number): ConversationDto {
  const conversationId = `conversation-${id}`;
  return {
    conversationId,
    revision: messageCount,
    projectId: 'project-thread-read',
    title: `Thread ${id}`,
    status: 'active',
    storageScope: 'current_project',
    readOnly: false,
    createdAt: at,
    updatedAt: at,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      messageId: `message-${id}-${index + 1}`,
      conversationId,
      revision: 0,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      state: 'completed' as const,
      content: `private body ${id}/${index + 1}`,
      attachments: [],
      streamSequence: 0,
      createdAt: new Date(Date.parse(at) + index * 1000).toISOString(),
      updatedAt: new Date(Date.parse(at) + index * 1000).toISOString(),
      completedAt: new Date(Date.parse(at) + index * 1000).toISOString()
    }))
  };
}

function fixture(initial: readonly ConversationDto[]) {
  let rows = [...initial];
  let scope = 'project-thread-read';
  const source = {
    async list(): Promise<ChatContextIpcResult<readonly ConversationDto[]>> {
      return { ok: true, value: rows };
    },
    async get(request: unknown): Promise<ChatContextIpcResult<ConversationDto>> {
      const id = (request as { conversationId: string }).conversationId;
      const found = rows.find(item => item.conversationId === id);
      return found
        ? { ok: true, value: found }
        : { ok: false, error: { code: 'conversation_not_found', message: 'missing' } };
    }
  };
  const controller = new ConversationThreadReadController(source, () => scope);
  return {
    controller,
    replace(next: readonly ConversationDto[]) { rows = [...next]; },
    setScope(next: string) { scope = next; }
  };
}

describe('ConversationThreadReadController legacy read adapter', () => {
  it('returns body-free summaries and keeps a summary cursor on its captured snapshot', async () => {
    const f = fixture([conversation('a', 2), conversation('b', 1), conversation('c', 3)]);
    const first = await f.controller.listThreadSummaries({
      includeArchived: false, includeDeleted: false, limit: 2, cursor: null
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.items).toHaveLength(2);
    expect(JSON.stringify(first.value)).not.toContain('private body');
    expect(first.value.items[0]).toMatchObject({ threadId: 'conversation-a', messageCount: 2 });
    expect(first.value.readAtSequence).toBeGreaterThan(0);
    expect(first.value.nextCursor).toBeTruthy();

    f.replace([...([conversation('a', 2), conversation('b', 1), conversation('c', 3)]), conversation('new', 1)]);
    const second = await f.controller.listThreadSummaries({
      includeArchived: false, includeDeleted: false, limit: 2, cursor: first.value.nextCursor!
    });
    expect(second).toMatchObject({ ok: true, value: { hasMore: false, items: [{ threadId: 'conversation-c' }] } });
    if (second.ok) expect(second.value.items.some(item => item.threadId === 'conversation-new')).toBe(false);
  });

  it('returns Thread metadata and execution session projection without message bodies', async () => {
    const source = {
      ...conversation('metadata', 2),
      parentRuns: [{ responseExecutionId: 'execution-metadata', sourceMessageId: 'message-metadata-1',
        state: 'running' as const, runRevision: 1, registeredWorkCount: 0, acknowledged: false }],
      agentSessions: [{ sessionId: 'session-metadata', revision: 2, sourceMessageId: 'message-metadata-1',
        state: 'waiting_user' as const, deadlineAt: at, registeredWorkCount: 0 }]
    };
    const f = fixture([source]);
    const result = await f.controller.getThread({ threadId: source.conversationId });
    expect(result).toMatchObject({ ok: true, value: {
      threadId: source.conversationId,
      messageCount: 2,
      parentRuns: [{ responseExecutionId: 'execution-metadata' }],
      agentSessions: [{ sessionId: 'session-metadata' }]
    } });
    expect(JSON.stringify(result)).not.toContain('private body');
  });

  it('pages by legacy message sequence with a fixed readAtSequence as new messages arrive', async () => {
    const f = fixture([conversation('page', 5)]);
    const first = await f.controller.getThreadItemsPage({
      threadId: 'conversation-page', limit: 3, direction: 'older', cursor: null
    });
    expect(first).toMatchObject({ ok: true, value: { readAtSequence: 5, hasMore: true } });
    if (!first.ok || !first.value.nextCursor) return;
    expect(first.value.items.map(item => item.sequence)).toEqual([3, 4, 5]);
    expect(first.value.items.map(item => item.itemId)).toEqual([
      { namespace: 'message', value: 'message-page-3' },
      { namespace: 'message', value: 'message-page-4' },
      { namespace: 'message', value: 'message-page-5' }
    ]);

    f.replace([conversation('page', 7)]);
    const older = await f.controller.getThreadItemsPage({
      threadId: 'conversation-page', limit: 3, direction: 'older', cursor: first.value.nextCursor
    });
    expect(older).toMatchObject({ ok: true, value: { readAtSequence: 5, hasMore: false } });
    if (older.ok) expect(older.value.items.map(item => item.sequence)).toEqual([1, 2]);
  });

  it('binds item cursors to the project scope', async () => {
    const f = fixture([conversation('cursor-scope', 4)]);
    const first = await f.controller.getThreadItemsPage({
      threadId: 'conversation-cursor-scope', limit: 2, direction: 'older', cursor: null
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('fixture item cursor missing');
    f.setScope('another-project');
    await expect(f.controller.getThreadItemsPage({
      threadId: 'conversation-cursor-scope', limit: 2, direction: 'older', cursor: first.value.nextCursor
    })).resolves.toMatchObject({ ok: false, error: { code: 'thread_cursor_scope_mismatch' } });
  });

  it('derives stable legacy Turns without fabricating execution records', async () => {
    const source = conversation('turns', 4);
    const withParent = {
      ...source,
      parentRuns: [{ responseExecutionId: 'execution-known', sourceMessageId: 'message-turns-1',
        state: 'completed' as const, runRevision: 2, registeredWorkCount: 0, acknowledged: false }]
    };
    const f = fixture([withParent]);
    const page = await f.controller.getThreadItemsPage({
      threadId: source.conversationId, limit: 4, direction: 'older', cursor: null
    });
    expect(page).toMatchObject({ ok: true });
    if (!page.ok) return;
    const turnId = page.value.items[0]!.turnId!;
    expect(turnId).toMatch(/^turn-legacy-v1-[a-f0-9]{64}$/u);
    const turn = await f.controller.getTurn({ turnId });
    expect(turn).toMatchObject({
      ok: true,
      value: {
        threadId: source.conversationId,
        provenance: 'legacy_inferred',
        userItemId: { namespace: 'message', value: 'message-turns-1' },
        assistantItemIds: [{ namespace: 'message', value: 'message-turns-2' }],
        responseExecutionIds: ['execution-known']
      }
    });
    const repeated = await f.controller.getTurn({ turnId });
    expect(repeated).toEqual(turn);
  });

  it('rejects cursors outside the originating project scope and invalid limits', async () => {
    const f = fixture([conversation('scope', 1), conversation('scope-second', 1)]);
    const first = await f.controller.listThreadSummaries({
      includeArchived: false, includeDeleted: false, limit: 1, cursor: null
    });
    if (!first.ok || !first.value.nextCursor) throw new Error('fixture cursor missing');
    f.setScope('another-project');
    await expect(f.controller.listThreadSummaries({
      includeArchived: false, includeDeleted: false, limit: 1, cursor: first.value.nextCursor
    })).resolves.toMatchObject({ ok: false, error: { code: 'thread_cursor_scope_mismatch' } });
    await expect(f.controller.getThreadItemsPage({
      threadId: 'conversation-scope', limit: 201, direction: 'older', cursor: null
    })).resolves.toMatchObject({ ok: false, error: { code: 'thread_page_limit_out_of_range' } });
  });
});
