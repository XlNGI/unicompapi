import { describe, expect, it, vi } from 'vitest';
import { ThreadModelHistorySource } from '../../src/platform/repositories/thread-model-history-source';
import { ModelHistoryReader } from '../../src/application/model-history-reader';
import { conversationToThreadProjection } from '../../src/application/conversation-thread-adapter';
import {
  addUserMessage, beginAssistantMessage, startAssistantMessageStreaming, appendAssistantMessageChunk,
  createProjectConversation, toConversationId, toIsoTimestamp, toMessageId, toProjectId, toThreadId
} from '../../src/domain';

const projectId = toProjectId('history-project');
const t0 = toIsoTimestamp('2026-10-12T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-12T00:00:01.000Z');

function fixture() {
  let conversation = createProjectConversation({ id: toConversationId('history-thread'), projectId, title: 'History', createdAt: t0 });
  conversation = addUserMessage(conversation, { id: toMessageId('user-1'), content: '真实历史事实', displayContent: '用户可见事实', createdAt: t0,
    attachments: [{ kind: 'file_reference', projectId, fileReferenceId: 'file-1' as never }] });
  conversation = beginAssistantMessage(conversation, { id: toMessageId('assistant-1'), createdAt: t0 });
  conversation = startAssistantMessageStreaming(conversation, toMessageId('assistant-1'), t0);
  conversation = appendAssistantMessageChunk(conversation, toMessageId('assistant-1'), '已保存回复', t1);
  conversation = { ...conversation, messages: conversation.messages.map(message => message.role === 'assistant' ? { ...message, reasoningContent: '已保存推理' } : message) };
  const projection = conversationToThreadProjection(conversation);
  return { conversation, projection };
}

describe('Thread model history authority', () => {
  it('retains pinned attachment and display metadata from native User Items before Legacy projection', async () => {
    const { conversation, projection } = fixture();
    const user = conversation.messages[0];
    const items = projection.items.map(item => item.type === 'user_message' ? { ...item,
      legacyMessageSnapshot: { attachments: user.attachments, displayContent: user.displayContent } } : item);
    const source = new ThreadModelHistorySource({ getThread: async () => projection.thread, readItems: async () => items }, projectId);
    expect((await source.getConversation(conversation.id))?.messages[0]).toEqual(user);
  });
  it('uses one committed transcript boundary for both revision and input content', async () => {
    const { projection } = fixture();
    const threads = { getThread: vi.fn(async () => { throw new Error('split identity read'); }),
      readItems: vi.fn(async () => { throw new Error('split item read'); }),
      readTranscript: vi.fn(async () => ({ thread: projection.thread, items: projection.items })) };
    const result = await new ThreadModelHistorySource(threads, projectId).getConversation(toConversationId(projection.thread.threadId));
    expect(result).toMatchObject({ revision: projection.thread.generation, messages: [{ content: '真实历史事实' }, { content: '已保存回复' }] });
    expect(threads.readTranscript).toHaveBeenCalledTimes(1);
    expect(threads.getThread).not.toHaveBeenCalled();
    expect(threads.readItems).not.toHaveBeenCalled();
  });
  it('reads complete committed messages and metadata without consulting a stale Legacy projection or UI page', async () => {
    const { conversation, projection } = fixture();
    const fallback = { getConversation: vi.fn(async () => conversation) };
    const source = new ThreadModelHistorySource({ getThread: async () => projection.thread, readItems: async () => projection.items }, projectId, fallback);
    const reader = new ModelHistoryReader(source);
    const result = await reader.readConversation({ threadId: toThreadId(conversation.id) });
    expect(result.messages).toEqual(conversation.messages);
    expect(fallback.getConversation).not.toHaveBeenCalled();
    expect((await reader.buildContext({ threadId: projection.thread.threadId, currentMessageId: toMessageId('user-1') })).messages.at(-1)?.content).toBe('真实历史事实');
  });

  it.each(['completed', 'interrupted', 'unknown'] as const)('uses Item state and content over an older streaming snapshot: %s', async status => {
    const { projection } = fixture();
    const items = projection.items.map(item => item.type === 'assistant_message' ? { ...item, status, content: '最新回复' } : item);
    const source = new ThreadModelHistorySource({ getThread: async () => projection.thread, readItems: async () => items }, projectId);
    const result = await source.getConversation(toConversationId(projection.thread.threadId));
    expect(result?.messages.at(-1)).toMatchObject({ content: '最新回复', state: status === 'completed' ? 'completed' : 'failed', reasoningContent: '已保存推理' });
    if (status !== 'completed') expect(result?.messages.at(-1)).toMatchObject({ failureReason: status === 'interrupted' ? 'interrupted' : 'unknown' });
  });

  it('falls back only for an absent Thread and propagates corruption and scope mismatches', async () => {
    const { conversation, projection } = fixture();
    const fallback = { getConversation: vi.fn(async () => conversation) };
    const absent = new ThreadModelHistorySource({ getThread: async () => undefined, readItems: vi.fn() }, projectId, fallback);
    await expect(absent.getConversation(conversation.id)).resolves.toEqual(conversation);
    const other = new ThreadModelHistorySource({ getThread: async () => ({ ...projection.thread, projectId: toProjectId('other-project') }), readItems: vi.fn() }, projectId, fallback);
    await expect(other.getConversation(conversation.id)).rejects.toThrow('thread_project_scope_mismatch');
    const corrupt = new ThreadModelHistorySource({ getThread: async () => projection.thread,
      readItems: async () => [{ ...projection.items[0], legacyMessageSnapshot: { ...projection.items[0].legacyMessageSnapshot, id: 'other-message' } }] }, projectId, fallback);
    await expect(corrupt.getConversation(conversation.id)).rejects.toThrow('thread_message_snapshot_conflict');
    expect(fallback.getConversation).toHaveBeenCalledTimes(1);
  });
});
