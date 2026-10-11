import { describe, expect, it } from 'vitest';
import {
  AgentContextAssembler,
  ConversationContextBuilder,
  ModelHistoryReader
} from '../../src/application';
import { addCompletedAssistantMessage, addUserMessage, createProjectConversation, toConversationId, toIsoTimestamp, toMessageId, toProjectId, toThreadId } from '../../src/domain';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-08T00:00:01.000Z');

describe('ModelHistoryReader compatibility adapter', () => {
  it('reads complete history independently from a UI page and preserves Builder output', async () => {
    let conversation = createProjectConversation({ id: toConversationId('history-reader'), projectId: toProjectId('project-history'), title: 'History', createdAt: t0 });
    conversation = addUserMessage(conversation, { id: toMessageId('history-old-user'), content: 'old user fact', createdAt: t0 });
    conversation = addCompletedAssistantMessage(conversation, { id: toMessageId('history-old-assistant'), content: 'old assistant fact', createdAt: t0 });
    conversation = addUserMessage(conversation, { id: toMessageId('history-current'), content: 'current request', createdAt: t1 });
    const reader = new ModelHistoryReader({ getConversation: async () => conversation });
    const query = { threadId: toThreadId(conversation.id), currentMessageId: toMessageId('history-current') };
    const history = await reader.readModelHistory(query);
    expect(history).toHaveLength(3);
    const direct = new ConversationContextBuilder().build({ conversation, currentUserMessageId: query.currentMessageId });
    const adapted = await reader.buildContext(query);
    expect(adapted).toEqual(direct);
    expect(adapted.messages.at(-1)).toEqual({ role: 'user', content: 'current request' });
  });

  it('keeps AgentContextAssembler system rules and references unchanged', async () => {
    let conversation = createProjectConversation({ id: toConversationId('history-agent-reader'), projectId: toProjectId('project-history'), title: 'History', createdAt: t0 });
    conversation = addUserMessage(conversation, { id: toMessageId('history-agent-current'), content: 'continue', createdAt: t0 });
    const reader = new ModelHistoryReader({ getConversation: async () => conversation });
    const query = { threadId: toThreadId(conversation.id), currentMessageId: toMessageId('history-agent-current'), references: [{ sourceId: 'ref-1', sourceType: 'project' as const, contentHash: 'hash-1', excerpt: 'untrusted data' }] };
    const expected = new AgentContextAssembler().assemble({ conversation, currentUserMessageId: query.currentMessageId, references: query.references });
    await expect(reader.assembleAgentContext(query)).resolves.toEqual(expected);
  });
});
