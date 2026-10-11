import { describe, expect, it } from 'vitest';
import {
  conversationToThreadProjection,
  projectArtifactItem,
  projectDisplayItems,
  projectToolCallItem,
  ConversationThreadShadowProjector
} from '../../src/application';
import {
  addCompletedAssistantMessage,
  addUserMessage,
  createProjectConversation,
  toConversationAgentRunId,
  toConversationResponseExecutionId,
  toConversationId,
  toIsoTimestamp,
  toMessageId,
  toProjectId,
  toThreadId,
  toTurnId,
  toWorkId
} from '../../src/domain';

const t0 = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const t1 = toIsoTimestamp('2026-10-08T00:00:01.000Z');

function conversation() {
  let value = createProjectConversation({ id: toConversationId('conversation-adapter'), projectId: toProjectId('project-adapter'), title: 'Adapter', createdAt: t0 });
  value = addUserMessage(value, { id: toMessageId('user-1'), content: 'make a document', createdAt: t0 });
  value = addCompletedAssistantMessage(value, { id: toMessageId('assistant-1'), content: 'done', createdAt: t1 });
  value = addUserMessage(value, { id: toMessageId('user-2'), content: 'continue', createdAt: t1 });
  return value;
}

describe('Conversation to Thread shadow adapter', () => {
  it('preserves Message IDs, infers stable Turns and links multiple runs', () => {
    const value = conversation();
    const projection = conversationToThreadProjection(value, {
      executionLinks: [
        { agentRunId: toConversationAgentRunId('run-1'), responseExecutionId: toConversationResponseExecutionId('response-1'), sourceMessageId: toMessageId('user-1'), createdAt: t0 },
        { agentRunId: toConversationAgentRunId('run-2'), responseExecutionId: toConversationResponseExecutionId('response-2'), sourceMessageId: toMessageId('user-1'), createdAt: t1 }
      ]
    });
    expect(projection.thread.threadId).toBe(value.id);
    expect(projection.items.map(item => item.itemId)).toEqual([
      { namespace: 'message', value: 'user-1' },
      { namespace: 'message', value: 'assistant-1' },
      { namespace: 'message', value: 'user-2' }
    ]);
    expect(projection.turns).toHaveLength(2);
    expect(projection.turns[0]!.provenance).toBe('legacy_inferred');
    expect(projection.turns[0]!.executionLinkRevision).toBe(2);
    expect(projection.executionLinks).toHaveLength(2);
    expect(projection.executionLinks[0]!.agentRunId).toBe(toConversationAgentRunId('run-1'));
  });

  it('deduplicates Tool Call/Result projections by stable source identity', () => {
    const input = { kind: 'tool_call_projection' as const, threadId: toThreadId('conversation-adapter'), turnId: toTurnId('turn-1'), sequence: 4, status: 'streaming' as const, createdAt: t0, updatedAt: t0, eventSystem: 'agent_runtime' as const, sourceIdentity: 'run-1:tool-1:call', toolCallId: 'call-1' };
    const replayInput = { ...input, status: 'completed' as const, content: 'replayed', updatedAt: t1 };
    const toolCall = projectToolCallItem({ ...input, status: 'streaming', updatedAt: t0 });
    const result = projectDisplayItems([input, replayInput]);
    expect(result).toHaveLength(1);
    expect(result[0]!.itemId).toEqual(toolCall.itemId);
    expect(result[0]!.status).toBe('completed');
  });

  it('keeps WorkId as artifact identity and leaves disabled shadow projection inactive', () => {
    const artifact = projectArtifactItem({ threadId: toThreadId('conversation-adapter'), sequence: 5, status: 'completed', createdAt: t1, updatedAt: t1, sourceIdentity: 'work-commit-1', workId: toWorkId('work-1') });
    expect(artifact.projectionSource?.workId).toBe(toWorkId('work-1'));
    expect(new ConversationThreadShadowProjector(false).project(conversation())).toBeUndefined();
    expect(new ConversationThreadShadowProjector(true).project(conversation())?.items).toHaveLength(3);
  });
});
