import { describe, expect, it } from 'vitest';
import {
  appendTurnExecutionLink,
  createItemV1,
  createThreadV1,
  createTurnV1,
  itemIdKey,
  parseItemV1,
  parseThreadV1,
  toMessageItemId,
  toProjectionItemId,
  toProjectId,
  toThreadId,
  toTurnId,
  toConversationAgentRunId,
  toConversationResponseExecutionId,
  toIsoTimestamp
  ,sha256Hex
} from '../../src/domain';

const createdAt = toIsoTimestamp('2026-10-08T00:00:00.000Z');
const later = toIsoTimestamp('2026-10-08T00:00:01.000Z');

describe('Thread / Turn / Item V1 contracts', () => {
  it('uses a renderer-safe SHA-256 identity digest', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('keeps ThreadId compatible by value while tagging Item identities', () => {
    const threadId = toThreadId('conversation-1');
    const messageId = toMessageItemId('message-1');
    const projectionId = toProjectionItemId(`item-projection-v1:${'a'.repeat(64)}`);
    expect(threadId).toBe('conversation-1');
    expect(messageId).toMatchObject({ namespace: 'message', value: 'message-1' });
    expect(projectionId.namespace).toBe('projection');
    expect(itemIdKey(messageId)).not.toBe(itemIdKey(projectionId));
    expect(() => toTurnId('turn-invalid')).not.toThrow();
    expect(() => toProjectionItemId('projection-1')).toThrow();
  });

  it('enforces monotonic Thread and Item lifecycle state', () => {
    const thread = createThreadV1({ threadId: toThreadId('thread-1'), projectId: toProjectId('project-1'), title: 'Thread', createdAt });
    const updated = { ...thread, itemCount: 1, lastItemSequence: 1, updatedAt: later };
    expect(parseThreadV1(updated)).toMatchObject({ itemCount: 1, lastItemSequence: 1 });
    const item = createItemV1({ itemId: toMessageItemId('message-1'), threadId: thread.threadId, sequence: 1, type: 'assistant_message', status: 'streaming', createdAt, updatedAt: createdAt, messageSource: { messageId: 'message-1' as never, messageRevision: 0 }, content: 'partial' });
    expect(() => parseItemV1(item)).not.toThrow();
    expect(() => parseItemV1({ ...item, status: 'completed', updatedAt: later })).not.toThrow();
    expect(() => parseItemV1({ ...item, sequence: 0 })).toThrow();
  });

  it('appends multiple execution links without replacing AgentRun identity', () => {
    const turn = createTurnV1({ turnId: toTurnId('turn-1'), threadId: toThreadId('thread-1'), turnSequence: 1, createdAt, provenance: 'native' });
    const first = appendTurnExecutionLink(turn, { schemaVersion: 1, turnId: turn.turnId, threadId: turn.threadId, agentRunId: toConversationAgentRunId('run-1'), responseExecutionId: toConversationResponseExecutionId('response-1'), linkSequence: 1, createdAt });
    const second = appendTurnExecutionLink(first, { schemaVersion: 1, turnId: turn.turnId, threadId: turn.threadId, agentRunId: toConversationAgentRunId('run-2'), responseExecutionId: toConversationResponseExecutionId('response-2'), linkSequence: 2, createdAt: later });
    expect(second.executionLinkRevision).toBe(2);
    expect(() => appendTurnExecutionLink(second, { schemaVersion: 1, turnId: turn.turnId, threadId: turn.threadId, agentRunId: toConversationAgentRunId('run-3'), linkSequence: 2, createdAt: later })).toThrow();
  });
});
